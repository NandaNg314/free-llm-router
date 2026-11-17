/**
 * 媒体账号池智能路由、401 自动续期、多账号容灾、异步任务归属绑定/探测收养与幂等记账单测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Env } from '../src/env.ts'
import { createAccountState, type AccountState } from '../src/pool/state.ts'
import type { ProviderCredential } from '../src/providers/types.ts'
import { UpstreamError } from '../src/upstream/client.ts'
import { ThreeDCredentialManager } from '../src/upstream/three-d.ts'
import { pickCredential } from '../src/gateway/models.ts'
import {
  checkMediaSubkeyModel,
  executeMediaWithFailover,
  handleFetch,
  handleImageEdits,
  handleImageGenerations,
  handleSearch,
  handleThreeDGenerations,
  handleThreeDJobGet,
  handleThreeDTasks,
  handleVideoGenerations,
  handleVideoTasks,
  isAllowedMediaProxyUrl,
  MediaTaskLedger,
  mediaTaskLedger,
  runMediaThreeDQuery,
  runMediaThreeDSubmit,
  selectMediaCandidates,
} from '../src/gateway/media-router.ts'

interface FakePoolBucket {
  accounts: AccountState[]
  credentials: Map<string, ProviderCredential>
  logs: Array<Record<string, unknown>>
  usages: Array<Record<string, unknown>>
  failures: Array<Record<string, unknown>>
  successes: Array<{ uid: string; model?: string; costCredits?: number }>
  putCalls: Array<{ uid: string; credential: ProviderCredential }>
}

function createFakeEnv(buckets: Record<string, FakePoolBucket>): Env {
  return {
    ACCOUNT_POOL: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const realm = String(id)
        const b = buckets[realm] ?? {
          accounts: [],
          credentials: new Map(),
          logs: [],
          usages: [],
          failures: [],
          successes: [],
          putCalls: [],
        }
        buckets[realm] = b
        return {
          listAccounts: async () => b.accounts,
          getCredential: async (uid: string) => b.credentials.get(uid),
          putCredential: async (uid: string, cred: ProviderCredential) => {
            b.credentials.set(uid, cred)
            b.putCalls.push({ uid, credential: cred })
          },
          appendLog: async (entry: Record<string, unknown>) => {
            b.logs.push(entry)
          },
          recordUsage: async (rec: Record<string, unknown>) => {
            b.usages.push(rec)
          },
          applyFailure: async (input: Record<string, unknown>) => {
            b.failures.push(input)
            return { disabled: false }
          },
          noteSuccess: async (uid: string, _now: number, _usage?: unknown, model?: string, costCredits?: number) => {
            b.successes.push({ uid, model, costCredits })
            const acc = b.accounts.find((a) => a.uid === uid)
            if (acc !== undefined && typeof costCredits === 'number' && costCredits > 0) {
              acc.credits = Math.max(0, acc.credits - costCredits)
            }
          },
          getPermanentLocks: async () => ({}),
        }
      },
    },
  } as unknown as Env
}

function makeAccount(
  uid: string,
  overrides: Partial<AccountState> & { hardUntil?: number } = {},
): AccountState {
  const base = createAccountState({
    uid,
    nickname: uid,
    realm: overrides.realm ?? 'global',
    provider: overrides.provider ?? 'workbuddy',
  })
  return Object.assign(base, overrides)
}

function makeCred(uid: string, token: string, refreshToken = `rt_${uid}`): ProviderCredential {
  return {
    provider: 'workbuddy',
    uid,
    accessToken: token,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
    nickname: uid,
    extras: { realm: 'global', domain: 'www.workbuddy.ai' },
  }
}

test('🔴 候选筛选与 pickCredential：跳过 disabled/冷却/熔断/受限号，优先选有积分号，全 0 时兜底', async () => {
  const now = Date.now()
  const bucket: FakePoolBucket = {
    accounts: [
      makeAccount('u0-disabled', { disabled: true, credits: 999 }),
      makeAccount('u1-hard', { until: now + 60_000, coolKind: 'hard', credits: 500 }),
      makeAccount('u2-restricted', { restrictedUntil: now + 120_000, credits: 400 }),
      makeAccount('u3-breaker', { breakerUntil: now + 30_000, credits: 300 }),
      makeAccount('u4-zero', { credits: 0, samples: [{ at: now - 1000, credits: 0 }] }),
      makeAccount('u5-rich', { credits: 120, creditsExpiring: 40 }),
    ],
    credentials: new Map([
      ['u0-disabled', makeCred('u0-disabled', 'tok0')],
      ['u1-hard', makeCred('u1-hard', 'tok1')],
      ['u2-restricted', makeCred('u2-restricted', 'tok2')],
      ['u3-breaker', makeCred('u3-breaker', 'tok3')],
      ['u4-zero', makeCred('u4-zero', 'tok4')],
      ['u5-rich', makeCred('u5-rich', 'tok5')],
    ]),
    logs: [],
    usages: [],
    failures: [],
    successes: [],
    putCalls: [],
  }
  const env = createFakeEnv({ global: bucket })
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))

  const candidates = await selectMediaCandidates(pool, 'global', 'workbuddy', { now, requireCredits: true })
  assert.deepEqual(
    candidates.map((a) => a.uid),
    ['u5-rich', 'u4-zero'],
    '应剔除全部不健康号，并把有积分的 u5-rich 排在零分兜底号 u4-zero 前面',
  )

  const picked = await pickCredential(env, 'global', 'workbuddy')
  assert.equal(picked?.uid, 'u5-rich')

  // 当 u5-rich 也无凭据或仅剩零分号时，允许零分号兜底尝试
  bucket.credentials.delete('u5-rich')
  const fallbackPicked = await pickCredential(env, 'global', 'workbuddy')
  assert.equal(fallbackPicked?.uid, 'u4-zero')
})

test('🔴 executeMediaWithFailover：401 先走 refresh 回写重试，401/429/5xx 自动切换下一健康账号，400 立即停手', async () => {
  const bucket: FakePoolBucket = {
    accounts: [
      makeAccount('u1', { credits: 100 }),
      makeAccount('u2', { credits: 90 }),
      makeAccount('u3', { credits: 80 }),
    ],
    credentials: new Map([
      ['u1', makeCred('u1', 'old_tok_1')],
      ['u2', makeCred('u2', 'tok_2')],
      ['u3', makeCred('u3', 'tok_3')],
    ]),
    logs: [],
    usages: [],
    failures: [],
    successes: [],
    putCalls: [],
  }
  const env = createFakeEnv({ global: bucket })

  // 场景 A：u1 返回 401 -> refresh 刷新成功 -> 回写池凭据并在 u1 重试成功，不切 u2
  let u1Calls = 0
  const healed = await executeMediaWithFailover(
    env,
    [{ realm: 'global', providerId: 'workbuddy' }],
    async (acc) => {
      assert.equal(acc.uid, 'u1')
      u1Calls += 1
      if (acc.credential.accessToken === 'old_tok_1') {
        throw new UpstreamError({ kind: 'auth_error', httpStatus: 401, message: 'token expired', detail: '401' })
      }
      return `ok:${acc.credential.accessToken}`
    },
    {
      requireCredits: true,
      refreshImpl: async (_pid, cred) => ({ ...cred, accessToken: 'fresh_tok_1' }),
    },
  )
  assert.equal(healed.value, 'ok:fresh_tok_1')
  assert.equal(u1Calls, 2)
  assert.equal(bucket.putCalls.length, 1)
  assert.equal(bucket.putCalls[0]?.credential.accessToken, 'fresh_tok_1')

  // 场景 B：u1 续期后仍 403，u2 遇 429 限流 -> 自动 failover 到 u3 成功！
  const sequence: string[] = []
  const failedOver = await executeMediaWithFailover(
    env,
    [{ realm: 'global', providerId: 'workbuddy' }],
    async (acc) => {
      sequence.push(acc.uid)
      if (acc.uid === 'u1') {
        throw new UpstreamError({ kind: 'auth_error', httpStatus: 401, message: 'dead', detail: '401' })
      }
      if (acc.uid === 'u2') {
        throw new UpstreamError({ kind: 'rate_limited', httpStatus: 429, message: 'rate limit', detail: '429' })
      }
      return `win:${acc.uid}`
    },
    {
      requireCredits: true,
      refreshImpl: async (_pid, cred) => ({ ...cred, accessToken: 'still_bad_tok' }),
    },
  )
  assert.equal(failedOver.value, 'win:u3')
  assert.deepEqual(sequence, ['u1', 'u1', 'u2', 'u3'])
  assert.ok(bucket.failures.some((f) => f.uid === 'u2' && f.kind === 'soft'), 'u2 429 应记录软冷却')

  // 场景 C：400 参数错误立即 fail-fast，不遍历后续账号、不罚号
  const badSeq: string[] = []
  const prevFailureCount = bucket.failures.length
  await assert.rejects(
    () =>
      executeMediaWithFailover(
        env,
        [{ realm: 'global', providerId: 'workbuddy' }],
        async (acc) => {
          badSeq.push(acc.uid)
          throw new UpstreamError({ kind: 'bad_request', httpStatus: 400, message: 'invalid size', detail: '400' })
        },
      ),
    /invalid size/,
  )
  assert.deepEqual(badSeq, ['u1'], 'bad_request 必须在第 1 个账号处立即停手')
  assert.equal(bucket.failures.length, prevFailureCount, 'bad_request 绝不罚号')
})

test('MediaTaskLedger：O(1) LRU 超容量淘汰最久未访问条目', () => {
  const ledger = new MediaTaskLedger({ maxSize: 3, ttlMs: 60_000 })
  ledger.register({ kind: '3d', taskId: 'j1', uid: 'u1', realm: 'global', providerId: 'workbuddy', model: '3.1', now: 1000 })
  ledger.register({ kind: '3d', taskId: 'j2', uid: 'u2', realm: 'global', providerId: 'workbuddy', model: '3.1', now: 1001 })
  ledger.register({ kind: '3d', taskId: 'j3', uid: 'u3', realm: 'global', providerId: 'workbuddy', model: '3.1', now: 1002 })

  // 访问 j1 使其成为最近使用，j2 成为最久未访问
  assert.equal(ledger.get('3d', 'j1', 1005)?.uid, 'u1')

  // 插入第 4 条 j4，触发淘汰 j2
  ledger.register({ kind: '3d', taskId: 'j4', uid: 'u4', realm: 'global', providerId: 'workbuddy', model: '3.1', now: 1006 })
  assert.equal(ledger.size, 3)
  assert.equal(ledger.get('3d', 'j2', 1007), undefined, '最久未访问的 j2 应被 LRU 淘汰')
  assert.equal(ledger.get('3d', 'j1', 1007)?.uid, 'u1', '刚访问过的 j1 必须保留')
  assert.equal(ledger.get('3d', 'j4', 1007)?.uid, 'u4')
})

test('🔴 3D 任务全链路：绑定原提交 uid 查询 + 进程重启探测收养 + usage.credit 幂等只记一次账', async () => {
  const bucket: FakePoolBucket = {
    accounts: [
      makeAccount('u1-fail-submit', { credits: 200 }),
      makeAccount('u2-owner', { credits: 100 }),
    ],
    credentials: new Map([
      ['u1-fail-submit', makeCred('u1-fail-submit', 'tok_u1')],
      ['u2-owner', makeCred('u2-owner', 'tok_u2')],
    ]),
    logs: [],
    usages: [],
    failures: [],
    successes: [],
    putCalls: [],
  }
  const env = createFakeEnv({ global: bucket })
  const ledger = new MediaTaskLedger()
  const credMgr = new ThreeDCredentialManager(async (ctx) => ({
    key: `ck_t_${ctx.uid}`,
    expiresAt: Date.now() + 900_000,
  }))

  let pollCounter = 0
  const queriedByTokens: string[] = []
  const fakeThreeDFetch: typeof fetch = async (_url, init) => {
    const h = new Headers(init?.headers)
    const auth = h.get('authorization') ?? ''
    const action = h.get('x-tc-action') ?? ''

    if (action === 'SubmitHunyuanTo3DProJob') {
      if (auth.includes('hy-3d.ck_t_u1-fail-submit/')) {
        return new Response('Service Unavailable', { status: 503 })
      }
      return new Response(
        JSON.stringify({ Response: { JobId: 'job-3d-777', Status: 'SUBMITTED', RequestId: 'r-sub' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    // QueryHunyuanTo3DProJob：任务只对原提交者 u2-owner 可见，u1 查会回 404 JobNotFound
    queriedByTokens.push(auth)
    if (!auth.includes('hy-3d.ck_t_u2-owner/')) {
      return new Response(
        JSON.stringify({ Response: { Error: { Code: 'ResourceNotFound.JobNotFound', Message: 'job not found' } } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
    }
    pollCounter += 1
    // 模拟上游仅首次查到 DONE 时返回 ResultCreditConsumed=30，后续重复查询省略该字段
    const body = pollCounter === 1
      ? {
          Response: {
            JobId: 'job-3d-777',
            Status: 'DONE',
            ResultCreditConsumed: 30,
            ResultFile3Ds: [{ Type: 'GLB', Url: 'https://ai3d.cos.ap-guangzhou.myqcloud.com/m.glb' }],
          },
        }
      : {
          Response: {
            JobId: 'job-3d-777',
            Status: 'DONE',
            ResultFile3Ds: [{ Type: 'GLB', Url: 'https://ai3d.cos.ap-guangzhou.myqcloud.com/m.glb' }],
          },
        }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  // 1. 提交任务：u1 503 自动 failover 到 u2-owner 成功，登记归属台账
  const sub = await runMediaThreeDSubmit(
    env,
    { prompt: '青花瓷瓶', result_format: 'GLB' },
    { ledger, threeDOptions: { credentials: credMgr, fetchImpl: fakeThreeDFetch } },
  )
  assert.equal(sub.uid, 'u2-owner')
  assert.equal(sub.state.jobId, 'job-3d-777')

  // 2. 即使池首 u1-fail-submit 积分更高，查询也必须直接打给原提交号 u2-owner
  const q1 = await runMediaThreeDQuery(env, 'job-3d-777', {
    ledger,
    threeDOptions: { credentials: credMgr, fetchImpl: fakeThreeDFetch },
  })
  assert.equal(q1.uid, 'u2-owner')
  assert.equal(q1.newlyBilled, true)
  assert.equal(q1.state.credit, 30)
  assert.equal(queriedByTokens.length, 1, '命中台账时直接查 u2-owner，不应打 u1')

  // 3. 连续重复查询第 2、3 次：不再重复记账，但 cachedCredit 仍能补齐积分回执
  const q2 = await runMediaThreeDQuery(env, 'job-3d-777', {
    ledger,
    threeDOptions: { credentials: credMgr, fetchImpl: fakeThreeDFetch },
  })
  assert.equal(q2.newlyBilled, false)
  assert.equal(q2.cachedCredit, 30)

  const billedSuccesses = bucket.successes.filter((s) => s.costCredits !== undefined && s.costCredits > 0)
  assert.equal(billedSuccesses.length, 1, '多次查询 DONE 任务，积分扣减必须幂等只执行 1 次')
  assert.equal(billedSuccesses[0]?.costCredits, 30)
  assert.equal(bucket.accounts.find((a) => a.uid === 'u2-owner')?.credits, 70)

  // 4. 模拟进程重启（清空内存台账）：探测 u1 (404 不罚号) -> 命中 u2 自动收养！
  ledger.clear()
  const failuresBeforeProbe = bucket.failures.length
  const qAdopted = await runMediaThreeDQuery(env, 'job-3d-777', {
    ledger,
    threeDOptions: { credentials: credMgr, fetchImpl: fakeThreeDFetch },
  })
  assert.equal(qAdopted.uid, 'u2-owner')
  assert.equal(ledger.get('3d', 'job-3d-777')?.uid, 'u2-owner', '探测命中后必须自动收养进台账')
  assert.equal(bucket.failures.length, failuresBeforeProbe, '盲探 404 绝不触发 applyFailure 罚号')
})

test('🔴 HTTP Handlers：直调图像/视频/3D/搜索/抓取全链路记录 appendLog 且视频任务幂等记账', async () => {
  mediaTaskLedger.clear()
  const bucket: FakePoolBucket = {
    accounts: [makeAccount('u-main', { credits: 200 })],
    credentials: new Map([['u-main', makeCred('u-main', 'tok_main')]]),
    logs: [],
    usages: [],
    failures: [],
    successes: [],
    putCalls: [],
  }
  const env = createFakeEnv({
    global: bucket,
    THREE_D_TEMP_TOKEN: 'ck_t_static_for_http_test',
  } as unknown as Record<string, FakePoolBucket>)
  ;(env as unknown as Record<string, unknown>).THREE_D_TEMP_TOKEN = 'ck_t_static_for_http_test'

  const origFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/v2/images/generations') || url.endsWith('/v2/images/edits')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { created: 1700000000, data: [{ url: 'https://a.myqcloud.com/1.png' }], usage: { credit: 5 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/v2/videos/generations')) {
      return new Response(
        JSON.stringify({ code: 0, data: { id: 'vid-task-1', status: 'queued' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/v2/videos/tasks')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            id: 'vid-task-1',
            status: 'completed',
            data: [{ url: 'https://v.myqcloud.com/out.mp4' }],
            usage: { output_video_duration: 5, credit: 50 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/agenttool/v1/tcproxy')) {
      const h = new Headers(init?.headers)
      if (h.get('x-tc-action') === 'SubmitHunyuanTo3DProJob') {
        return new Response(
          JSON.stringify({ Response: { JobId: 'job-http-1', Status: 'SUBMITTED' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          Response: {
            JobId: 'job-http-1',
            Status: 'DONE',
            ResultCreditConsumed: 20,
            ResultFile3Ds: [{ Type: 'GLB', Url: 'https://ai3d.cos.ap-guangzhou.myqcloud.com/1.glb' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/agenttool/v1/search')) {
      return new Response(
        JSON.stringify({
          query: '测试词',
          results: [{ title: '结果1', url: 'https://example.com/1', snippet: '摘要1' }],
          total_results: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/agenttool/v1/webfetch')) {
      return new Response(
        JSON.stringify({ url: 'https://example.com/1', title: '标题', content: '# 正文内容' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('not mocked', { status: 404 })
  }

  try {
    // 1. 生图与改图
    const imgRes = await handleImageGenerations(
      new Request('https://gw/v1/images/generations', {
        method: 'POST',
        body: JSON.stringify({ prompt: '一只宇航员猫咪' }),
      }),
      env,
    )
    assert.equal(imgRes.status, 200)
    const imgJson = (await imgRes.json()) as { data: Array<{ url: string }>; usage: { credit: number } }
    assert.equal(imgJson.data[0]?.url, 'https://a.myqcloud.com/1.png')
    assert.equal(imgJson.usage.credit, 5)

    const editRes = await handleImageEdits(
      new Request('https://gw/v1/images/edits', {
        method: 'POST',
        body: JSON.stringify({ prompt: '加一顶帽子', image: 'https://a.myqcloud.com/1.png' }),
      }),
      env,
    )
    assert.equal(editRes.status, 200)

    // 2. 视频提交 + 两次重复轮询（验证幂等只扣一次 50 积分）
    const vidSub = await handleVideoGenerations(
      new Request('https://gw/v1/videos/generations', {
        method: 'POST',
        body: JSON.stringify({ prompt: '海浪拍岸' }),
      }),
      env,
    )
    assert.equal(vidSub.status, 200)

    const vidPoll1 = await handleVideoTasks(
      new Request('https://gw/v1/videos/tasks', {
        method: 'POST',
        body: JSON.stringify({ task_id: 'vid-task-1' }),
      }),
      env,
    )
    const vidPoll2 = await handleVideoTasks(
      new Request('https://gw/v1/videos/tasks', {
        method: 'POST',
        body: JSON.stringify({ task_id: 'vid-task-1' }),
      }),
      env,
    )
    assert.equal(vidPoll1.status, 200)
    assert.equal(vidPoll2.status, 200)
    const vidBilled = bucket.successes.filter((s) => s.costCredits === 50)
    assert.equal(vidBilled.length, 1, '视频任务重复轮询必须只记一次 50 积分')

    // 3. 3D 提交 + POST /v1/3d/tasks + GET /v1/3d/:job_id（验证幂等只扣一次 20 积分）
    const d3Sub = await handleThreeDGenerations(
      new Request('https://gw/v1/3d/generations', {
        method: 'POST',
        body: JSON.stringify({ prompt: '木质宝箱', result_format: 'GLB' }),
      }),
      env,
    )
    assert.equal(d3Sub.status, 200)

    const d3PostPoll = await handleThreeDTasks(
      new Request('https://gw/v1/3d/tasks', {
        method: 'POST',
        body: JSON.stringify({ job_id: 'job-http-1' }),
      }),
      env,
    )
    const d3GetPoll = await handleThreeDJobGet(new Request('https://gw/v1/3d/job-http-1', { method: 'GET' }), env)
    assert.equal(d3PostPoll.status, 200)
    assert.equal(d3GetPoll.status, 200)
    const d3GetBody = (await d3GetPoll.json()) as { result_url: string; usage: { credit: number } }
    assert.equal(d3GetBody.result_url, 'https://ai3d.cos.ap-guangzhou.myqcloud.com/1.glb')
    assert.equal(d3GetBody.usage.credit, 20)
    const d3Billed = bucket.successes.filter((s) => s.costCredits === 20)
    assert.equal(d3Billed.length, 1, '3D POST/GET 重复查询必须只记一次 20 积分')

    // 4. 搜索与抓取
    const sRes = await handleSearch(
      new Request('https://gw/v1/search', { method: 'POST', body: JSON.stringify({ query: '测试词' }) }),
      env,
    )
    assert.equal(sRes.status, 200)
    const sJson = (await sRes.json()) as { total_results: number }
    assert.equal(sJson.total_results, 1)

    const fRes = await handleFetch(
      new Request('https://gw/v1/fetch', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/1' }) }),
      env,
    )
    assert.equal(fRes.status, 200)

    assert.ok(bucket.logs.length >= 9, '所有媒体/视频/3D/搜索/抓取 HTTP 入口都必须写入面板日志 appendLog')
  } finally {
    globalThis.fetch = origFetch
    mediaTaskLedger.clear()
  }
})

test('安全边界：COS 媒体代理后缀白名单防 SSRF 与子密钥模型白名单校验', () => {
  assert.equal(isAllowedMediaProxyUrl('https://ai3d-1258344703.cos.ap-guangzhou.myqcloud.com/mesh.glb'), true)
  assert.equal(isAllowedMediaProxyUrl('https://bucket.cos.ap-shanghai.tencentcos.cn/video.mp4'), true)
  assert.equal(isAllowedMediaProxyUrl('http://bucket.myqcloud.com/insecure.glb'), false, '必须强制 https')
  assert.equal(isAllowedMediaProxyUrl('https://evil-myqcloud.com/ssrf'), false, '伪造后缀域名必须拒绝')
  assert.equal(isAllowedMediaProxyUrl('https://169.254.169.254/latest/meta-data/'), false)

  const restrictedSubkey = {
    id: 'k1',
    name: 'only-chat',
    prefix: 'sk-1',
    hash: 'h',
    createdAt: 1,
    enabled: true,
    limits: {
      maxRequests: 0,
      maxTokens: 0,
      windowSeconds: 0,
      expiresAt: 0,
      allowedIps: [],
      models: ['deepseek-v4'],
    },
  }
  const denied = checkMediaSubkeyModel(restrictedSubkey, ['hy-3d', '3.1'])
  assert.equal(denied?.status, 403)

  const allowedSubkey = {
    ...restrictedSubkey,
    limits: { ...restrictedSubkey.limits, models: ['hy-3d'] },
  }
  assert.equal(checkMediaSubkeyModel(allowedSubkey, ['hy-3d', '3.1']), undefined)
})
