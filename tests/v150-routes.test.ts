/**
 * v1.5.0 网关集成、只读余额汇总、启动温和预热、统一模型路由与错峰排程回归测试：
 * 1. `GET /v1/balance-summary`：三通道鉴权（`Bearer` / `x-api-key` / 仅此只读路径开放的 `?key=`）、
 *    请求头与 `?key=` 不一致冲突 401、其他端点拒绝 `?key=`、纯缓存 `<5ms` 零上游请求、
 *    剔除 `disabled` / `needsRelogin`、拆分 `unknownBalanceAccounts`、子密钥权限域与零敏感字段泄漏；
 * 2. Node 启动后 `warm_sweep`（`runWarmBalanceSweep` & `startServer`）：串行 `gapMs` 节奏、
 *    仅刷新启用且 `>15m` 陈旧非静态 Key 账号、`WARM_START_BALANCE=0` 禁用、`AbortSignal` 与 `server.close()` 即时中断；
 * 3. `GET/POST /admin/config/unified-models` 与全协议主链路接线（`/v1/models`、`/v1/chat/completions`、
 *    `/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`），含受限子密钥防跨渠道越权；
 * 4. `server.ts` 选号 `isFreeModel` 免费模型豁免永久积分锁保留线；
 * 5. `scheduled()` 国内福利 `08:00–10:00` 确定性错峰排程（`cnTaskJitter`）与 CodeArts `needsRelogin` 闭环自愈。
 */

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { runWarmBalanceSweep, startServer } from '../src/server/index.js'
import { resetAuthLimiter } from '../src/gateway/inbound-limit.js'
import { resetMaxRotateCache, resetUnifiedModelsConfigCache } from '../src/gateway/server.js'
import { createAccountState } from '../src/pool/state.js'
import { resetCodeArtsRefreshState } from '../src/providers/codearts.js'
import { computeCnAccountJitterSlot } from '../src/taskrunner/jitter.js'
import { APP_VERSION } from '../src/version.js'
import worker, { resetCorsConfigCache } from '../src/index.js'

const TEST_CRED_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const MASTER_KEY = 'sk-master-v150-routes-secret'

function tmpDbPath(label: string): string {
  return path.join(os.tmpdir(), `flr-v150-routes-${label}-${process.pid}-${Date.now()}.db`)
}

function cleanupDb(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(file, { force: true })
  }
}

function makeCtx(): ExecutionContext & { flush: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
    props: {},
    async flush() {
      await Promise.allSettled(pending.splice(0))
    },
  } as unknown as ExecutionContext & { flush: () => Promise<void> }
}

function makeSseChatResponse(content: string, model = 'deepseek-v4.1-flash'): Response {
  const frames = [
    `data: ${JSON.stringify({
      id: 'chatcmpl-v150',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-v150',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  return new Response(frames, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

test('版本同步：APP_VERSION 与 /version 端点返回 1.5.0', async () => {
  assert.equal(APP_VERSION, '1.5.0')
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string
  }
  assert.equal(pkg.version, '1.5.0')

  const dbPath = tmpDbPath('version')
  const rt = createNodeRuntime(dbPath)
  try {
    const res = await worker.fetch(new Request('http://localhost/version'), rt.env, makeCtx())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { name: string; version: string }
    assert.equal(body.version, '1.5.0')
  } finally {
    rt.db.close()
    cleanupDb(dbPath)
  }
})

test('GET /v1/balance-summary：三通道鉴权、双头/Query 冲突拦截、其他路径禁 ?key=、只读聚合与子密钥隔离', async () => {
  const dbPath = tmpDbPath('balance-summary')
  cleanupDb(dbPath)
  resetAuthLimiter()
  resetCorsConfigCache()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = MASTER_KEY
  env.CREDENTIAL_KEY = TEST_CRED_KEY

  const originalFetch = globalThis.fetch
  let upstreamFetchCalls = 0
  globalThis.fetch = (async () => {
    upstreamFetchCalls += 1
    throw new Error('balance-summary 绝不允许发起任何上游网络请求')
  }) as typeof fetch

  try {
    const ctx = makeCtx()
    const now = Date.now()
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const globalPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))

    // 1. 构造多维度账号池状态：
    // - buddy 正常已采样号（1200 总积分，300 临期，1h 后过期）
    const buddyOk = createAccountState({ uid: 'b-ok', nickname: '机密昵称A', realm: 'cn', provider: 'buddy' })
    buddyOk.credits = 1200
    buddyOk.creditsExpiring = 300
    buddyOk.creditsEarliestExpiry = now + 3_600_000
    buddyOk.samples = [{ at: now - 60_000, credits: 1200 }]
    await cnPool.upsertAccount(buddyOk, now)

    // - buddy 已采样真实 0 积分号（samples 非空，不计入 unknownBalanceAccounts）
    const buddyZero = createAccountState({ uid: 'b-zero', nickname: '机密昵称B', realm: 'cn', provider: 'buddy' })
    buddyZero.credits = 0
    buddyZero.samples = [{ at: now - 30_000, credits: 0 }]
    await cnPool.upsertAccount(buddyZero, now)

    // - buddy 从未刷新余额的新导入号（samples 为空且全 0 => 单列 unknownBalanceAccounts）
    const buddyUnknown = createAccountState({ uid: 'b-unknown', nickname: '新导入未刷号', realm: 'cn', provider: 'buddy' })
    await cnPool.upsertAccount(buddyUnknown, now)

    // - buddy 手动停用号与待重登号（必须完全剔除，不计入 totalCredits / totalAccounts）
    const buddyDisabled = createAccountState({ uid: 'b-off', nickname: '已停用', realm: 'cn', provider: 'buddy' })
    buddyDisabled.disabled = true
    buddyDisabled.credits = 9999
    buddyDisabled.samples = [{ at: now, credits: 9999 }]
    await cnPool.upsertAccount(buddyDisabled, now)

    const codeartsRelogin = createAccountState({
      uid: 'codearts:ca-relogin',
      nickname: '待重登码道',
      realm: 'cn',
      provider: 'codearts',
    })
    codeartsRelogin.needsRelogin = true
    codeartsRelogin.reloginReason = 'refresh_token 已失效'
    codeartsRelogin.credits = 8888
    codeartsRelogin.samples = [{ at: now, credits: 8888 }]
    await cnPool.upsertAccount(codeartsRelogin, now)

    // - qodercn 正常号（500 总积分，100 临期，30m 后过期）
    const qoderOk = createAccountState({ uid: 'qodercn:q1', nickname: 'Qoder号', realm: 'cn', provider: 'qodercn' })
    qoderOk.credits = 500
    qoderOk.creditsExpiring = 100
    qoderOk.creditsEarliestExpiry = now + 1_800_000
    qoderOk.samples = [{ at: now - 10_000, credits: 500 }]
    await cnPool.upsertAccount(qoderOk, now)

    // - global 池 workbuddy 冷却号（非 disabled/needsRelogin，计入 totalAccounts 但不计入 healthyAccounts）
    const wbCooling = createAccountState({
      uid: 'workbuddy:wb1',
      nickname: '国际号',
      realm: 'global',
      provider: 'workbuddy',
    })
    wbCooling.credits = 400
    wbCooling.creditsExpiring = 50
    wbCooling.creditsEarliestExpiry = now + 7_200_000
    wbCooling.until = now + 120_000
    wbCooling.coolKind = 'soft'
    wbCooling.samples = [{ at: now - 5_000, credits: 400 }]
    await globalPool.upsertAccount(wbCooling, now)

    // 2. 主密钥三通道鉴权（Bearer / x-api-key / ?key=）均返回 200，耗时 < 25ms（纯内存+SQLite < 5ms 级），零上游调用
    const t0 = performance.now()
    const resBearer = await worker.fetch(
      new Request('http://localhost/v1/balance-summary', {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    const elapsedMs = performance.now() - t0
    assert.equal(resBearer.status, 200)
    assert.ok(elapsedMs < 50, `只读汇总应极速返回（实测 ${elapsedMs.toFixed(2)}ms）`)
    assert.equal(upstreamFetchCalls, 0)

    const summary = (await resBearer.json()) as {
      object: string
      realm: string
      totalCredits: number
      expiringCredits: number
      earliestExpiry: number
      healthyAccounts: number
      totalAccounts: number
      unknownBalanceAccounts: number
      byProvider: Record<string, {
        totalCredits: number
        expiringCredits: number
        earliestExpiry: number
        healthyAccounts: number
        totalAccounts: number
        unknownBalanceAccounts: number
      }>
    }
    assert.equal(summary.object, 'balance.summary')
    assert.equal(summary.realm, 'all')
    assert.equal(summary.totalCredits, 1200 + 0 + 500 + 400)
    assert.equal(summary.expiringCredits, 300 + 100 + 50)
    assert.equal(summary.earliestExpiry, now + 1_800_000)
    assert.equal(summary.totalAccounts, 5) // b-ok, b-zero, b-unknown, q1, wb1
    assert.equal(summary.healthyAccounts, 4) // wb1 在 soft 冷却中
    assert.equal(summary.unknownBalanceAccounts, 1) // b-unknown
    assert.equal(summary.byProvider.codearts, undefined, 'needsRelogin 账号必须被剔除')
    assert.equal(summary.byProvider.buddy?.unknownBalanceAccounts, 1)

    // 隐私红线：响应 JSON 字符串中绝不含 uid 或 nickname
    const rawJson = JSON.stringify(summary)
    assert.ok(!rawJson.includes('机密昵称') && !rawJson.includes('b-ok') && !rawJson.includes('wb1'))

    // x-api-key 与 ?key= 均支持
    const resXApi = await worker.fetch(
      new Request('http://localhost/v1/balance-summary', {
        headers: { 'x-api-key': MASTER_KEY },
      }),
      env,
      ctx,
    )
    assert.equal(resXApi.status, 200)

    const resQuery = await worker.fetch(
      new Request(`http://localhost/v1/balance-summary?key=${encodeURIComponent(MASTER_KEY)}`),
      env,
      ctx,
    )
    assert.equal(resQuery.status, 200)

    // 请求头与 ?key= 同时提供且完全一致 => 200
    const resSameBoth = await worker.fetch(
      new Request(`http://localhost/v1/balance-summary?key=${encodeURIComponent(MASTER_KEY)}`, {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(resSameBoth.status, 200)

    // 3. 安全红线：请求头与 ?key= 同时给出且不一致 => 直接 401 拒绝（双向测试）
    resetAuthLimiter()
    const resConflict1 = await worker.fetch(
      new Request('http://localhost/v1/balance-summary?key=wrong-key', {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(resConflict1.status, 401)

    const resConflict2 = await worker.fetch(
      new Request(`http://localhost/v1/balance-summary?key=${encodeURIComponent(MASTER_KEY)}`, {
        headers: { 'x-api-key': 'wrong-header-key' },
      }),
      env,
      ctx,
    )
    assert.equal(resConflict2.status, 401)

    // 4. 安全红线：其他端点（/v1/models、/v1/chat/completions、/admin/accounts、POST /v1/balance-summary）绝不接受 ?key=
    resetAuthLimiter()
    for (const req of [
      new Request(`http://localhost/v1/models?key=${encodeURIComponent(MASTER_KEY)}`),
      new Request(`http://localhost/v1/chat/completions?key=${encodeURIComponent(MASTER_KEY)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      new Request(`http://localhost/admin/accounts?key=${encodeURIComponent(MASTER_KEY)}`),
      new Request(`http://localhost/v1/balance-summary?key=${encodeURIComponent(MASTER_KEY)}`, {
        method: 'POST',
      }),
    ]) {
      const denied = await worker.fetch(req, env, ctx)
      assert.equal(denied.status, 401, `${req.method} ${req.url} 不得接受 ?key= 鉴权`)
    }

    // 5. 子密钥范围收敛 + IP/过期校验 + 状态栏只读轮询不消耗请求配额
    resetAuthLimiter()
    const createSubRes = await worker.fetch(
      new Request('http://localhost/admin/apikeys', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'qoder-widget-subkey',
          limits: {
            maxRequests: 1,
            maxTokens: 0,
            windowHours: 24,
            models: ['qodercn/dfmodel'],
            allowedIps: ['198.51.100.7'],
            expiresAt: 0,
          },
        }),
      }),
      env,
      ctx,
    )
    const createdSub = (await createSubRes.json()) as { key: string; record: { id: string } }

    // 非白名单 IP 经 ?key= 访问 => 403
    const subIpDenied = await worker.fetch(
      new Request(`http://localhost/v1/balance-summary?key=${encodeURIComponent(createdSub.key)}`, {
        headers: { 'cf-connecting-ip': '198.51.100.99' },
      }),
      env,
      ctx,
    )
    assert.equal(subIpDenied.status, 403)

    // 白名单 IP 连续轮询 3 次（尽管 maxRequests=1，只读汇总不消耗对话配额，且仅暴露 qodercn 额度！）
    for (let i = 0; i < 3; i += 1) {
      const subOk = await worker.fetch(
        new Request(`http://localhost/v1/balance-summary?key=${encodeURIComponent(createdSub.key)}`, {
          headers: { 'cf-connecting-ip': '198.51.100.7' },
        }),
        env,
        ctx,
      )
      assert.equal(subOk.status, 200)
      const subBody = (await subOk.json()) as typeof summary
      assert.equal(subBody.totalCredits, 500)
      assert.equal(subBody.totalAccounts, 1)
      assert.deepEqual(Object.keys(subBody.byProvider), ['qodercn'])
    }
    await ctx.flush()
    const subUsage = await cnPool.getApiKeyUsage(createdSub.record.id)
    assert.equal(subUsage.requests, 0, '只读额度轮询不应扣减子密钥对话请求配额')
  } finally {
    globalThis.fetch = originalFetch
    rt.db.close()
    cleanupDb(dbPath)
  }
})

test('warm_sweep：温和串行预热陈旧账号、跳过静态 Key/停用/待重登/新鲜快照、支持 WARM_START_BALANCE=0 与停机中断', async () => {
  const dbPath = tmpDbPath('warm-sweep')
  cleanupDb(dbPath)
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = MASTER_KEY
  env.CREDENTIAL_KEY = TEST_CRED_KEY

  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}

  const callTimes: Array<{ uidHint: string; at: number }> = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const hdrs = new Headers(init?.headers)
    const uidHint = hdrs.get('x-user-id') ?? 'unknown'
    callTimes.push({ uidHint, at: performance.now() })
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                {
                  CycleCapacityRemain: 750,
                  CapacityRemain: 1000,
                  Status: 0,
                  DeductionEndTime: '2099-12-31T23:59:59Z',
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const now = Date.now()
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))

    const addBuddyAccount = async (
      uid: string,
      opts: { disabled?: boolean; needsRelogin?: boolean; sampleAgeMs?: number; staticApiKey?: boolean } = {},
    ) => {
      const st = createAccountState({ uid, nickname: uid, realm: 'cn', provider: 'buddy' })
      if (opts.disabled) st.disabled = true
      if (opts.needsRelogin) st.needsRelogin = true
      if (opts.sampleAgeMs !== undefined) {
        st.credits = 100
        st.samples = [{ at: now - opts.sampleAgeMs, credits: 100 }]
      }
      await cnPool.upsertAccount(st, now)
      await cnPool.putCredential(
        uid,
        {
          provider: 'buddy',
          uid,
          accessToken: `tok-${uid}`,
          refreshToken: opts.staticApiKey ? '' : `ref-${uid}`,
          expiresAt: now + 3_600_000,
          nickname: uid,
          extras: {
            realm: 'cn',
            ...(opts.staticApiKey ? { authMode: 'api_key' } : {}),
          },
        },
        now,
      )
      // putCredential 会自动清 needsRelogin，若测试需要预置 needsRelogin 则在其后显式打标
      if (opts.needsRelogin) {
        await cnPool.markNeedsRelogin(uid, '预置待重登', now)
      }
    }

    await addBuddyAccount('stale-1', { sampleAgeMs: 20 * 60_000 }) // >15m => 应刷新
    await addBuddyAccount('never-sampled-2') // 从未采样 => 应刷新
    await addBuddyAccount('fresh-3', { sampleAgeMs: 5 * 60_000 }) // 5m 内 => 跳过
    await addBuddyAccount('disabled-4', { disabled: true }) // 停用 => 跳过
    await addBuddyAccount('relogin-5', { needsRelogin: true }) // 待重登 => 跳过
    await addBuddyAccount('apikey-6', { staticApiKey: true }) // 静态 Key => 跳过

    // 1. WARM_START_BALANCE=0 时完全跳过
    env.WARM_START_BALANCE = '0'
    const offRes = await runWarmBalanceSweep(env, { gapMs: 10, now: () => now })
    assert.equal(offRes.refreshed, 0)
    assert.equal(callTimes.length, 0)

    // 2. 开启时仅串行刷新 stale-1 与 never-sampled-2，且间隔 >= gapMs
    delete env.WARM_START_BALANCE
    const sweepRes = await runWarmBalanceSweep(env, { gapMs: 25, now: () => now })
    assert.equal(sweepRes.aborted, false)
    assert.equal(sweepRes.refreshed, 2)
    assert.equal(sweepRes.failed, 0)
    assert.equal(sweepRes.skipped, 4)
    assert.deepEqual(
      callTimes.map((c) => c.uidHint),
      ['stale-1', 'never-sampled-2'],
    )
    assert.ok(
      callTimes[1]!.at - callTimes[0]!.at >= 18,
      `两个账号之间必须按 gapMs 串行间隔（实测 ${(callTimes[1]!.at - callTimes[0]!.at).toFixed(1)}ms）`,
    )

    const updated1 = await cnPool.getAccount('stale-1')
    assert.equal(updated1?.credits, 750)

    // 3. 停机 AbortSignal 在串行等待期间立即中断，绝不继续打第二个账号
    callTimes.length = 0
    const laterNow = now + 30 * 60_000 // 使两个号再次超过 15m
    const abortCtrl = new AbortController()
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = new Headers(init?.headers)
      callTimes.push({ uidHint: hdrs.get('x-user-id') ?? 'unknown', at: performance.now() })
      // 首个账号完成后在 2s 间隔睡眠中立即触发停机信号
      setTimeout(() => abortCtrl.abort(), 5)
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            Response: {
              Data: {
                Accounts: [{ CycleCapacityRemain: 500, CapacityRemain: 500, Status: 0 }],
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const abortStart = performance.now()
    const abortedRes = await runWarmBalanceSweep(env, {
      gapMs: 5_000,
      now: () => laterNow,
      signal: abortCtrl.signal,
    })
    const abortElapsed = performance.now() - abortStart
    assert.equal(abortedRes.aborted, true)
    assert.equal(callTimes.length, 1, '停机信号触发后不得再刷新后续账号')
    assert.ok(abortElapsed < 500, `interruptibleSleep 必须被 abort 立即唤醒（实测 ${abortElapsed.toFixed(1)}ms）`)

    // 4. startServer 关闭时干净清理预热定时器
    const serverDb = tmpDbPath('warm-server')
    const started = startServer({
      port: 0,
      host: '127.0.0.1',
      databasePath: serverDb,
      autoCron: true,
      warmStartBalance: true,
      warmStartDelayMs: 60_000,
      localMode: true,
    })
    await new Promise<void>((resolve) => {
      if (started.server.listening) resolve()
      else started.server.once('listening', () => resolve())
    })
    await new Promise<void>((resolve) => started.server.close(() => resolve()))
    started.runtime.db.close()
    cleanupDb(serverDb)
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    globalThis.fetch = originalFetch
    rt.db.close()
    cleanupDb(dbPath)
  }
})

test('统一模型映射：配置持久化/双池镜像、/v1/models 按在线出口发布、三协议路由容灾与子密钥防越权', async () => {
  const dbPath = tmpDbPath('unified-models')
  cleanupDb(dbPath)
  resetAuthLimiter()
  resetCorsConfigCache()
  resetUnifiedModelsConfigCache()
  resetMaxRotateCache()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = MASTER_KEY
  env.CREDENTIAL_KEY = TEST_CRED_KEY

  const originalFetch = globalThis.fetch
  const upstreamHits: Array<{ url: string; model: string }> = []
  let buddyShouldFail = false

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/v3/config') || url.includes('/models')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const rawBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {}
    const model = rawBody.model ?? ''
    upstreamHits.push({ url, model })
    if (url.includes('copilot.tencent.com') && buddyShouldFail) {
      return new Response(JSON.stringify({ code: 14003, msg: 'Model busy. Please switch models' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }
    const tag = url.includes('workbuddy.ai') ? `WB:${model}` : `BUDDY:${model}`
    return makeSseChatResponse(tag, model)
  }) as typeof fetch

  try {
    const ctx = makeCtx()
    const now = Date.now()
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const globalPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))

    // 1. 默认 GET /admin/config/unified-models 为 { enabled: false, rules: [] }，不含任何假示例
    const getInit = await worker.fetch(
      new Request('http://localhost/admin/config/unified-models', {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(getInit.status, 200)
    const initJson = (await getInit.json()) as { ok: boolean; config: { enabled: boolean; rules: unknown[] } }
    assert.deepEqual(initJson.config, { enabled: false, rules: [] })

    // 2. POST 保存规则并验证双分片镜像
    const saveRes = await worker.fetch(
      new Request('http://localhost/admin/config/unified-models', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          rules: [
            {
              alias: 'coder-pro',
              description: '主力编程统一模型',
              targets: {
                codearts: 'GLM-5',
                workbuddy: 'claude-sonnet-4-5',
                buddy: 'deepseek-v4.1-flash',
              },
            },
            {
              alias: 'offline-only',
              targets: { trae: 'glm-5' },
            },
          ],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(saveRes.status, 200)
    const mirroredGlobal = await globalPool.getUnifiedModelsConfig()
    assert.equal(mirroredGlobal.enabled, true)
    assert.equal(mirroredGlobal.rules.length, 2)

    // 3. 放入在线 buddy 与 workbuddy 账号（无 codearts、无 trae 账号）
    const buddyAcct = createAccountState({ uid: 'u-buddy', nickname: '国内号', realm: 'cn', provider: 'buddy' })
    buddyAcct.credits = 600
    await cnPool.upsertAccount(buddyAcct, now)
    await cnPool.putCredential(
      'u-buddy',
      {
        provider: 'buddy',
        uid: 'u-buddy',
        accessToken: 'tok-buddy',
        refreshToken: 'ref-buddy',
        expiresAt: now + 3_600_000,
        nickname: '国内号',
        extras: { realm: 'cn' },
      },
      now,
    )

    const wbAcct = createAccountState({
      uid: 'workbuddy:u-wb',
      nickname: '国际号',
      realm: 'global',
      provider: 'workbuddy',
    })
    wbAcct.credits = 600
    await globalPool.upsertAccount(wbAcct, now)
    await globalPool.putCredential(
      'workbuddy:u-wb',
      {
        provider: 'workbuddy',
        uid: 'u-wb',
        accessToken: 'tok-wb',
        refreshToken: 'ref-wb',
        expiresAt: now + 3_600_000,
        nickname: '国际号',
        extras: { realm: 'global', domain: 'www.workbuddy.ai' },
      },
      now,
    )

    // 4. GET /v1/models：仅暴露有在线目标账号的 coder-pro，不暴露无账号的 offline-only
    const modelsRes = await worker.fetch(
      new Request('http://localhost/v1/models', {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(modelsRes.status, 200)
    const modelsBody = (await modelsRes.json()) as { data: Array<{ id: string }> }
    const modelIds = modelsBody.data.map((m) => m.id)
    assert.ok(modelIds.includes('coder-pro'), '/v1/models 应包含有在线出口的统一别名 coder-pro')
    assert.ok(!modelIds.includes('offline-only'), '/v1/models 不得包含无在线账号的 offline-only')

    // 5. 三套协议全部打通统一别名 coder-pro（跳过无号的 codearts，优先命中在线第 1 顺位 workbuddy）
    upstreamHits.length = 0
    const chatRes = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'coder-pro',
          stream: false,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(chatRes.status, 200)
    const chatJson = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> }
    assert.equal(chatJson.choices[0]?.message.content, 'WB:claude-sonnet-4-5')

    const responsesRes = await worker.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'coder-pro',
          stream: false,
          input: 'ping responses',
        }),
      }),
      env,
      ctx,
    )
    assert.equal(responsesRes.status, 200)
    const responsesText = await responsesRes.text()
    assert.ok(responsesText.includes('WB:claude-sonnet-4-5'))

    const messagesRes = await worker.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': MASTER_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'coder-pro',
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: 'ping anthropic' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(messagesRes.status, 200)
    const messagesText = await messagesRes.text()
    assert.ok(messagesText.includes('WB:claude-sonnet-4-5'))

    // 6. 🔴 子密钥防跨渠道越权测试：
    // 子密钥仅授权 `buddy/deepseek-v4.1-flash`，未授权 `workbuddy/claude-sonnet-4-5`。
    // 请求 `coder-pro` 时必须跳过排在前面的 `workbuddy`，仅路由到已授权的 `buddy/deepseek-v4.1-flash`！
    const subCreate = await worker.fetch(
      new Request('http://localhost/admin/apikeys', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'buddy-only-subkey',
          limits: {
            maxRequests: 0,
            maxTokens: 0,
            windowHours: 24,
            models: ['buddy/deepseek-v4.1-flash'],
            allowedIps: [],
            expiresAt: 0,
          },
        }),
      }),
      env,
      ctx,
    )
    const buddyOnlySub = (await subCreate.json()) as { key: string }

    upstreamHits.length = 0
    const subChatRes = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${buddyOnlySub.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'coder-pro',
          stream: false,
          messages: [{ role: 'user', content: 'subkey check' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(subChatRes.status, 200)
    const subChatJson = (await subChatRes.json()) as { choices: Array<{ message: { content: string } }> }
    assert.equal(
      subChatJson.choices[0]?.message.content,
      'BUDDY:deepseek-v4.1-flash',
      '受限子密钥绝不允许借统一别名穿透到未授权的 workbuddy 渠道',
    )
    assert.ok(
      upstreamHits.every((h) => !h.url.includes('workbuddy.ai')),
      '上游调用中不得出现未授权的 workbuddy 请求',
    )

    // `/v1/messages/count_tokens` 同样允许该子密钥查询 coder-pro，但拒绝完全无关的 offline-only
    const countOk = await worker.fetch(
      new Request('http://localhost/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'x-api-key': buddyOnlySub.key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'coder-pro', messages: [{ role: 'user', content: 'hello' }] }),
      }),
      env,
      ctx,
    )
    assert.equal(countOk.status, 200)

    const countDenied = await worker.fetch(
      new Request('http://localhost/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'x-api-key': buddyOnlySub.key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'offline-only', messages: [{ role: 'user', content: 'hello' }] }),
      }),
      env,
      ctx,
    )
    assert.equal(countDenied.status, 403)

    // 若唯一已授权的 buddy 账号停用（仅剩未授权的 workbuddy 在线），该子密钥请求 coder-pro 必须返回 403！
    await cnPool.setAccountDisabled('u-buddy', true, Date.now())
    const subBlockedWhenBuddyDown = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${buddyOnlySub.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'coder-pro',
          stream: false,
          messages: [{ role: 'user', content: 'must block' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(subBlockedWhenBuddyDown.status, 403)
  } finally {
    globalThis.fetch = originalFetch
    rt.db.close()
    cleanupDb(dbPath)
  }
})

test('免费模型豁免永久积分锁：已确认 0 倍率模型（hy4flash-free）放行，付费模型仍受永久积分锁保护', async () => {
  const dbPath = tmpDbPath('free-model-lock')
  cleanupDb(dbPath)
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = MASTER_KEY
  env.CREDENTIAL_KEY = TEST_CRED_KEY

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : {}
    return makeSseChatResponse(`FREE_OK:${body.model ?? ''}`, body.model ?? 'hy4flash-free')
  }) as typeof fetch

  try {
    const ctx = makeCtx()
    const now = Date.now()
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))

    // 账号仅剩永久积分（credits=800, creditsExpiring=0），并开启 buddy 永久积分锁
    const permOnlyAcct = createAccountState({
      uid: 'perm-only',
      nickname: '仅永久积分号',
      realm: 'cn',
      provider: 'buddy',
    })
    permOnlyAcct.credits = 800
    permOnlyAcct.creditsExpiring = 0
    permOnlyAcct.samples = [{ at: now, credits: 800 }]
    await cnPool.upsertAccount(permOnlyAcct, now)
    await cnPool.putCredential(
      'perm-only',
      {
        provider: 'buddy',
        uid: 'perm-only',
        accessToken: 'tok-perm',
        refreshToken: 'ref-perm',
        expiresAt: now + 3_600_000,
        nickname: '仅永久积分号',
        extras: { realm: 'cn' },
      },
      now,
    )
    await cnPool.setPermanentLock('buddy', true)

    // 1. 常规扣费模型 glm-5.3 被永久积分锁拦截（不得打穿永久积分）
    const paidBlocked = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'buddy/glm-5.3',
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      env,
      ctx,
    )
    assert.ok(paidBlocked.status >= 400, '付费模型在永久积分锁下必须被拦截')
    const paidErrText = await paidBlocked.text()
    assert.ok(paidErrText.includes('永久积分锁'), `错误文案应指明永久积分锁：${paidErrText}`)

    // 2. 已确认 0 倍率免费模型 buddy/hy4flash-free 自动豁免永久积分锁，成功返回 200！
    const freeAllowed = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'buddy/hy4flash-free',
          stream: false,
          messages: [{ role: 'user', content: 'hi free' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(freeAllowed.status, 200)
    const freeJson = (await freeAllowed.json()) as { choices: Array<{ message: { content: string } }> }
    assert.equal(freeJson.choices[0]?.message.content, 'FREE_OK:hy4flash-free')
  } finally {
    globalThis.fetch = originalFetch
    rt.db.close()
    cleanupDb(dbPath)
  }
})

test('scheduled() 错峰排程与 CodeArts needsRelogin 自愈闭环：08:00-10:00 分槽延迟 + 重登导入自动清零', async () => {
  const dbPath = tmpDbPath('jitter-relogin')
  cleanupDb(dbPath)
  resetCodeArtsRefreshState()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = MASTER_KEY
  env.CREDENTIAL_KEY = TEST_CRED_KEY

  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}

  try {
    const ctx = makeCtx()
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))

    // 1. CodeArts 账号因缺少续期材料且余额接口返回 401 => 标记 needsRelogin=true（不置手动 disabled=true）
    const caUid = 'codearts:ak:TESTAK123'
    const caState = createAccountState({
      uid: caUid,
      nickname: '华为码道测试号',
      realm: 'cn',
      provider: 'codearts',
    })
    await cnPool.upsertAccount(caState, Date.now())
    await cnPool.putCredential(
      caUid,
      {
        provider: 'codearts',
        uid: 'ak:TESTAK123',
        accessToken: 'expired-sec-token',
        refreshToken: '', // 缺少续期材料
        expiresAt: Date.now() + 60_000,
        nickname: '华为码道测试号',
        extras: { ak: 'TESTAK123', sk: 'TESTSK456', realm: 'cn' },
      },
      Date.now(),
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error_code: 'APIG.0301',
          error_msg: 'Incorrect IAM authentication information: decrypt token fail',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    const balRefreshRes = await worker.fetch(
      new Request('http://localhost/admin/accounts/balance', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ realm: 'cn', uid: caUid }),
      }),
      env,
      ctx,
    )
    assert.equal(balRefreshRes.status, 200)

    // GET /admin/accounts 必须回传 needsRelogin: true 且 disabled: false
    const listAfterFail = await worker.fetch(
      new Request('http://localhost/admin/accounts?realm=cn', {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    const listJson1 = (await listAfterFail.json()) as {
      accounts: Array<{ uid: string; disabled: boolean; needsRelogin?: boolean; reloginReason?: string }>
    }
    const caRow1 = listJson1.accounts.find((a) => a.uid === caUid)
    assert.ok(caRow1 !== undefined)
    assert.equal(caRow1.disabled, false, '待重登不得混淆为手动停用 disabled=true')
    assert.equal(caRow1.needsRelogin, true)
    assert.ok((caRow1.reloginReason ?? '').length > 0)

    // 通过 POST /admin/import 重新导入新凭据 => 自动清除 needsRelogin 与 reloginReason！
    const reimportRes = await worker.fetch(
      new Request('http://localhost/admin/import', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'codearts',
          uid: 'ak:TESTAK123',
          nickname: '华为码道测试号',
          access_key_id: 'TESTAK123',
          secret_access_key: 'TESTSK456',
          security_token: 'fresh-sec-token-v2',
        }),
      }),
      env,
      ctx,
    )
    assert.equal(reimportRes.status, 200)

    const listAfterImport = await worker.fetch(
      new Request('http://localhost/admin/accounts?realm=cn', {
        headers: { authorization: `Bearer ${MASTER_KEY}` },
      }),
      env,
      ctx,
    )
    const listJson2 = (await listAfterImport.json()) as typeof listJson1
    const caRow2 = listJson2.accounts.find((a) => a.uid === caUid)
    assert.ok(caRow2 !== undefined)
    assert.equal(caRow2.needsRelogin, undefined, '重新导入凭据后应自动清除 needsRelogin')
    assert.equal(caRow2.reloginReason, undefined)

    // 2. 开启 cnTaskJitter: true 后验证 scheduled() 在 UTC+8 08:00 与 09:00 按账号确定性错峰排程
    await worker.fetch(
      new Request('http://localhost/admin/config/routing', {
        method: 'POST',
        headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          autoTaskCron: true,
          autoRefreshCredential: false,
          cnTaskJitter: true,
        }),
      }),
      env,
      ctx,
    )

    // 挑两个分别落入 08 点槽与 09 点槽的国内账号 uid
    const eightAmUtc8 = Date.UTC(2026, 10, 26, 0, 0, 0) // 2026-11-26 08:00:00 UTC+8
    const nineAmUtc8 = Date.UTC(2026, 10, 26, 1, 0, 0) // 2026-11-26 09:00:00 UTC+8
    let uidSlot8 = ''
    let uidSlot9 = ''
    for (let i = 0; i < 100 && (uidSlot8 === '' || uidSlot9 === ''); i += 1) {
      const candidateUid = `jitter-uid-${i}`
      const slot = computeCnAccountJitterSlot(candidateUid, eightAmUtc8)
      if (slot.slotHour === 8 && uidSlot8 === '') uidSlot8 = candidateUid
      if (slot.slotHour === 9 && uidSlot9 === '') uidSlot9 = candidateUid
    }
    assert.ok(uidSlot8 !== '' && uidSlot9 !== '')

    for (const u of [uidSlot8, uidSlot9]) {
      const s = createAccountState({ uid: u, nickname: u, realm: 'cn', provider: 'buddy' })
      await cnPool.upsertAccount(s, eightAmUtc8)
    }

    // 触发 08:00 UTC+8 Cron：只有 slotHour===8 的账号入队，且 startedAt 等于 08:00 + slot.delayMs
    mock.timers.enable({ apis: ['Date'], now: eightAmUtc8 })
    try {
      await worker.scheduled({ cron: '0 * * * *', scheduledTime: eightAmUtc8 } as never, env, ctx)
    } finally {
      mock.timers.reset()
    }

    const status8At8 = await env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(uidSlot8)).status(uidSlot8)
    const status9At8 = await env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(uidSlot9)).status(uidSlot9)
    const expectedSlot8 = computeCnAccountJitterSlot(uidSlot8, eightAmUtc8)
    assert.ok(status8At8 !== undefined, '08 点槽账号应在 08:00 被排入延迟队列')
    assert.equal(status8At8.startedAt, eightAmUtc8 + expectedSlot8.delayMs)
    assert.equal(status9At8, undefined, '09 点槽账号在 08:00 不应提前入队')

    // 触发 09:00 UTC+8 Cron：slotHour===9 的账号按其确定性偏移入队
    mock.timers.enable({ apis: ['Date'], now: nineAmUtc8 })
    try {
      await worker.scheduled({ cron: '0 * * * *', scheduledTime: nineAmUtc8 } as never, env, ctx)
    } finally {
      mock.timers.reset()
    }

    const status9At9 = await env.TASK_RUNNER.get(env.TASK_RUNNER.idFromName(uidSlot9)).status(uidSlot9)
    const expectedSlot9 = computeCnAccountJitterSlot(uidSlot9, nineAmUtc8)
    assert.ok(status9At9 !== undefined, '09 点槽账号应在 09:00 被排入延迟队列')
    assert.equal(status9At9.startedAt, nineAmUtc8 + expectedSlot9.delayMs)
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    globalThis.fetch = originalFetch
    rt.db.close()
    cleanupDb(dbPath)
  }
})
