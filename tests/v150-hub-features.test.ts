/**
 * v1.5.0（对标 `niyouqianma/workbuddy2api-hub` `v2.2.2`～`v2.2.4`）五大核心能力综合单测：
 * 1. 出口感知「统一模型映射引擎」（`src/gateway/unified-models.ts`）：清洗防 XSS、禁覆盖保留名、空表绝不自动回填、
 *    在线出口感知 `/v1/models` 宣告、以及受限子密钥模型白名单防跨渠道越权穿透；
 * 2. 账号池（`AccountPoolDO`）：免费零成本模型豁免 `permanentLocks` / `expiringStrict` / `hard` 余额耗尽锁、
 *    `needsRelogin` 状态独立于手动 `disabled` 且凭据刷新/重登自动清零、`systemUnifiedModels` 与 `cnTaskJitter` 持久化；
 * 3. 国内版福利随机错峰排程器（`src/taskrunner/jitter.ts`）：默认关闭零破坏、开启后 `08:00–10:00` 确定性哈希打散、
 *    `10:00` 窗口兜底补跑与 `21:00` 晚间错峰补领。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { createAccountState } from '../src/pool/state.js'
import {
  buildUnifiedModelEntries,
  defaultUnifiedModelsConfig,
  expandUnifiedModelCandidates,
  findUnifiedModelRule,
  isReservedUnifiedAlias,
  isSubkeyModelAllowedWithUnified,
  resolveUnifiedModel,
  resolveUnifiedPrimaryModel,
  sanitizeUnifiedModelsConfig,
} from '../src/gateway/unified-models.js'
import {
  CN_JITTER_WINDOW_MS,
  CN_RETRY_JITTER_MAX_MS,
  computeCnAccountJitterSlot,
  decideCnTaskDispatch,
  isCnDailyScheduleHour,
  isIntlDailyScheduleHour,
} from '../src/taskrunner/jitter.js'

const TEST_CREDENTIAL_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function freshPoolRuntime(tag: string) {
  const dir = path.join(process.cwd(), '.build')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `test-v150-hub-${tag}-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  const runtime = createNodeRuntime(dbPath)
  runtime.env.CREDENTIAL_KEY = TEST_CREDENTIAL_KEY
  const cleanup = () => {
    runtime.db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p)
        } catch {
          // Windows 文件句柄偶有延迟释放，忽略清理异常
        }
      }
    }
  }
  return { runtime, cleanup }
}

// ─────────────────── ① 统一模型映射引擎（PR #28 / #33） ───────────────────

test('unified-models：默认空表绝不自动回填示例数据，sanitize 防 XSS / 禁保留前缀 / 去重 / 剥冗余供应商前缀', () => {
  const def = defaultUnifiedModelsConfig()
  assert.deepEqual(def, { enabled: false, rules: [] })
  assert.deepEqual(sanitizeUnifiedModelsConfig(null), { enabled: false, rules: [] })
  assert.deepEqual(sanitizeUnifiedModelsConfig({ enabled: true, rules: [] }), {
    enabled: true,
    rules: [],
  })

  // 保留名与已知 providerId 严禁覆盖
  for (const reserved of [
    'wb-search',
    'wb-fetch',
    'wb-search-fetch',
    'wb-custom-tool',
    'auto',
    'aggregate',
    'expiring',
    'expiringonly',
    'hunyuan-tts-2.5',
    'hunyuan-asr',
    'buddy',
    'workbuddy',
    'codearts',
  ]) {
    assert.equal(isReservedUnifiedAlias(reserved), true, `${reserved} 必须属于保留别名`)
  }
  assert.equal(isReservedUnifiedAlias('claude-sonnet'), false)

  const sanitized = sanitizeUnifiedModelsConfig({
    enabled: true,
    rules: [
      // 合法规则 + 大写归一 + 同供应商冗余前缀剥离 + 备注剥除 HTML 尖括号
      {
        alias: '  Claude-Sonnet  ',
        targets: {
          buddy: 'buddy/deepseek-v4.1-flash',
          workbuddy: 'claude-sonnet-4-5',
          unknown_provider: 'foo',
        },
        description: '主力编程别名 <script>alert(1)</script>',
      },
      // 重复 alias 应被去重丢弃（保留第一条）
      {
        alias: 'claude-sonnet',
        targets: { codearts: 'glm-5' },
      },
      // XSS 非法 alias 丢弃
      {
        alias: 'bad<svg/onload=1>',
        targets: { buddy: 'deepseek-v4.1-flash' },
      },
      // 保留名 wb-search 丢弃
      {
        alias: 'wb-search',
        targets: { buddy: 'deepseek-v4.1-flash' },
      },
      // 含斜杠的 alias 丢弃
      {
        alias: 'my/alias',
        targets: { buddy: 'deepseek-v4.1-flash' },
      },
      // 目标含 XSS 字符后无有效目标，整条规则剔除
      {
        alias: 'empty-after-clean',
        targets: { buddy: 'bad"model<1>' },
      },
    ],
  })

  assert.equal(sanitized.enabled, true)
  assert.equal(sanitized.rules.length, 1)
  assert.deepEqual(sanitized.rules[0], {
    alias: 'claude-sonnet',
    targets: {
      buddy: 'deepseek-v4.1-flash',
      workbuddy: 'claude-sonnet-4-5',
    },
    description: '主力编程别名 scriptalert(1)/script',
  })
})

test('unified-models：在线出口感知解析与 /v1/models 宣告（无可用目标绝不虚报，停用目标自动跳过）', () => {
  const cfg = sanitizeUnifiedModelsConfig({
    enabled: true,
    rules: [
      {
        alias: 'coder-pro',
        targets: {
          workbuddy: 'claude-sonnet-4-5',
          buddy: 'deepseek-v4.1-flash',
          codearts: 'glm-5',
        },
        description: '跨出口编程模型',
      },
      {
        alias: 'only-qoder',
        targets: { qoder: 'qwen3-coder-plus' },
      },
    ],
  })

  // 仅 buddy 与 codearts 在线（workbuddy 与 qoder 无可用号）
  const online = ['buddy', 'codearts']
  const candidates = resolveUnifiedModel('coder-pro', cfg, online)
  assert.deepEqual(
    candidates.map((c) => c.routedModel),
    ['buddy/deepseek-v4.1-flash', 'codearts/glm-5'],
  )
  assert.equal(resolveUnifiedPrimaryModel('coder-pro', cfg, online), 'buddy/deepseek-v4.1-flash')

  // 保留 expiring/ 前缀透传；显式指定 provider/model 时不触发别名拦截
  assert.equal(
    resolveUnifiedPrimaryModel('expiring/coder-pro', cfg, online),
    'expiring/buddy/deepseek-v4.1-flash',
  )
  assert.equal(findUnifiedModelRule('buddy/coder-pro', cfg), undefined)

  // 若 buddy 的 deepseek-v4.1-flash 被手动停用，则自动顺延到 codearts/glm-5
  const disabledMap = new Map<string, ReadonlySet<string>>([
    ['buddy', new Set(['deepseek-v4.1-flash'])],
  ])
  assert.equal(
    resolveUnifiedPrimaryModel('coder-pro', cfg, online, { disabledModels: disabledMap }),
    'codearts/glm-5',
  )

  // /v1/models 宣告：coder-pro 有在线出口故暴露（并继承首目标上下文元数据）；only-qoder 无在线出口故隐藏！
  const advertised = buildUnifiedModelEntries(cfg, online, {
    existingModels: [
      {
        id: 'deepseek-v4.1-flash',
        object: 'model',
        created: 1700000000,
        owned_by: 'buddy',
        context_window: 128000,
      },
    ],
  })
  assert.deepEqual(advertised.map((m) => m.id), ['coder-pro'])
  assert.equal(advertised[0]!.owned_by, 'unified')
  assert.equal(advertised[0]!.context_window, 128000)

  // 总开关关闭时：不解析、不宣告
  const offCfg = { ...cfg, enabled: false }
  assert.deepEqual(resolveUnifiedModel('coder-pro', offCfg, online), [])
  assert.deepEqual(buildUnifiedModelEntries(offCfg, online), [])
})

test('🔴 unified-models 子密钥安全红线：白名单配 alias 或单目标均兼容放行，未授权目标绝不越权穿透！', () => {
  const cfg = sanitizeUnifiedModelsConfig({
    enabled: true,
    rules: [
      {
        alias: 'claude-sonnet',
        targets: {
          workbuddy: 'claude-sonnet-4-5',
          buddy: 'deepseek-v4.1-flash',
        },
      },
    ],
  })
  const online = ['workbuddy', 'buddy']

  // 1) 候选展开包含原始请求名 + 全部真实目标
  assert.deepEqual(expandUnifiedModelCandidates('claude-sonnet', cfg), [
    'claude-sonnet',
    'workbuddy/claude-sonnet-4-5',
    'buddy/deepseek-v4.1-flash',
  ])

  // 2) 子密钥 A 仅授权低成本目标 ['buddy/deepseek-v4.1-flash']：
  //    客户端用 alias 'claude-sonnet' 请求时准入通过，但路由候选**只剩 buddy/deepseek-v4.1-flash**，
  //    绝不允许落到排在第一顺位但未授权的 workbuddy/claude-sonnet-4-5！
  const subkeyOnlyBuddy = ['buddy/deepseek-v4.1-flash']
  assert.equal(isSubkeyModelAllowedWithUnified('claude-sonnet', subkeyOnlyBuddy, cfg), true)
  const scopedForBuddySubkey = resolveUnifiedModel('claude-sonnet', cfg, online, {
    allowedModels: subkeyOnlyBuddy,
  })
  assert.deepEqual(
    scopedForBuddySubkey.map((c) => c.canonicalTarget),
    ['buddy/deepseek-v4.1-flash'],
    '未获子密钥授权的 workbuddy/claude-sonnet-4-5 必须被严格剔除，防止越权穿透',
  )

  // 3) 子密钥 B 直接授权了统一别名 ['claude-sonnet']：两个在线目标均可调度
  const subkeyWithAlias = ['claude-sonnet']
  assert.equal(isSubkeyModelAllowedWithUnified('claude-sonnet', subkeyWithAlias, cfg), true)
  assert.deepEqual(
    resolveUnifiedModel('claude-sonnet', cfg, online, { allowedModels: subkeyWithAlias }).map(
      (c) => c.canonicalTarget,
    ),
    ['workbuddy/claude-sonnet-4-5', 'buddy/deepseek-v4.1-flash'],
  )

  // 4) 子密钥 C 仅授权无关模型 ['qoder/qwen3-coder-plus']：准入直接拒绝且候选为空
  const subkeyUnrelated = ['qoder/qwen3-coder-plus']
  assert.equal(isSubkeyModelAllowedWithUnified('claude-sonnet', subkeyUnrelated, cfg), false)
  assert.deepEqual(
    resolveUnifiedModel('claude-sonnet', cfg, online, { allowedModels: subkeyUnrelated }),
    [],
  )
})

// ─────────────────── ② AccountPoolDO 持久化与选号集成（PR #20 / #34 / #36） ───────────────────

test('AccountPoolDO：systemUnifiedModels / cnTaskJitter 持久化、免费模型保留线豁免、needsRelogin 自愈闭环', async () => {
  const { runtime, cleanup } = freshPoolRuntime('pool-v150')
  try {
    const pool = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))
    const now = 1_720_000_000_000

    // 1) UnifiedModelsConfig 与 RoutingConfig.cnTaskJitter 默认值及持久化
    assert.deepEqual(await pool.getUnifiedModelsConfig(), { enabled: false, rules: [] })
    const savedUnified = await pool.setUnifiedModelsConfig({
      enabled: true,
      rules: [{ alias: 'fast-coder', targets: { buddy: 'deepseek-v4.1-flash' } }],
    })
    assert.equal(savedUnified.enabled, true)
    assert.equal(savedUnified.rules[0]?.alias, 'fast-coder')
    // 局部只切开关时保留既有 rules
    const toggledOff = await pool.setUnifiedModelsConfig({ enabled: false })
    assert.equal(toggledOff.enabled, false)
    assert.equal(toggledOff.rules.length, 1)

    const initialRouting = await pool.getRoutingConfig()
    assert.equal(initialRouting.cnTaskJitter, false, 'cnTaskJitter 默认必须为 false')
    const updatedRouting = await pool.setRoutingConfig({ cnTaskJitter: true })
    assert.equal(updatedRouting.cnTaskJitter, true)
    assert.equal((await pool.getRoutingConfig()).cnTaskJitter, true)

    // 2) 免费模型豁免永久积分锁（permanentLocks）与严格临期（expiringStrict）及 402 hard 冷却
    const permAcct = createAccountState({ uid: 'acct-perm', nickname: '纯永久积分号', realm: 'cn', provider: 'buddy' })
    permAcct.credits = 1200
    permAcct.creditsExpiring = 0
    permAcct.until = now + 3_600_000
    permAcct.coolKind = 'hard'
    permAcct.reason = '402 quota exhausted'
    await pool.upsertAccount(permAcct, now)
    await pool.setPermanentLock('buddy', true)

    // 付费模型被拦截
    const paidPick = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'deepseek-v4.1-flash',
      exclude: [],
      now,
    })
    assert.equal(paidPick, undefined)

    // 确认零倍率免费模型（自动识别 hy4flash-free 及显式 isFreeModel:true）成功穿透 hard 冷却与永久积分锁！
    const freeAutoPick = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'hy4flash-free',
      expiringStrict: true,
      exclude: [],
      now,
    })
    assert.equal(freeAutoPick?.uid, 'acct-perm')

    const freeExplicitPick = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'custom-zero-cost',
      isFreeModel: true,
      exclude: [],
      now: now + 5_000,
    })
    assert.equal(freeExplicitPick?.uid, 'acct-perm')

    // 3) needsRelogin 独立状态：标记后不改 disabled，阻止选号；putCredential / revive 后自动清零；手动 disabled 绝不被误清！
    const caAcct = createAccountState({ uid: 'ca-1', nickname: '码道一号', realm: 'cn', provider: 'codearts' })
    await pool.upsertAccount(caAcct, now)

    assert.equal(await pool.markNeedsRelogin('ca-1', 'STS5.1806 refresh_token 已失效', now), true)
    const marked = await pool.getAccount('ca-1')
    assert.equal(marked?.needsRelogin, true)
    assert.equal(marked?.reloginReason, 'STS5.1806 refresh_token 已失效')
    assert.equal(marked?.disabled, false, 'markNeedsRelogin 绝不能置手动 disabled=true')

    const blockedPick = await pool.pick({
      realm: 'cn',
      provider: 'codearts',
      model: 'glm-5',
      isFreeModel: true,
      exclude: [],
      now,
    })
    assert.equal(blockedPick, undefined, 'needsRelogin 账号不可被派单')

    // 重新导入/刷新写入新凭据 ⇒ 自动清零 needsRelogin 并恢复可选
    await pool.putCredential('ca-1', { provider: 'codearts', uid: 'ca-1', accessToken: 'ST-FRESH' }, now + 1000)
    const healed = await pool.getAccount('ca-1')
    assert.equal(healed?.needsRelogin, undefined)
    assert.equal(healed?.reloginReason, undefined)
    assert.equal(healed?.disabled, false)

    const healedPick = await pool.pick({
      realm: 'cn',
      provider: 'codearts',
      model: 'glm-5',
      exclude: [],
      now: now + 10_000,
    })
    assert.equal(healedPick?.uid, 'ca-1')

    // 若账号原本同时处于人工手动停用 disabled=true，putCredential 清掉 needsRelogin 但绝不解除手动 disabled
    await pool.disable('ca-1', '管理员手动停用', now + 20_000)
    await pool.markNeedsRelogin('ca-1', 'token 过期', now + 21_000)
    await pool.putCredential('ca-1', { provider: 'codearts', uid: 'ca-1', accessToken: 'ST-FRESH-2' }, now + 22_000)
    const stillDisabled = await pool.getAccount('ca-1')
    assert.equal(stillDisabled?.needsRelogin, undefined)
    assert.equal(stillDisabled?.disabled, true, '凭据刷新绝不能把管理员手动停用的账号静默开启')
  } finally {
    cleanup()
  }
})

// ─────────────────── ③ 国内版福利随机错峰排程器（PR #32） ───────────────────

test('taskrunner/jitter：默认关闭保持 09:00/21:00 零延迟；开启后 08:00–10:00 均匀错峰且跨日变化', () => {
  const day1Morning8 = Date.parse('2026-11-26T00:00:00Z') // 北京时间 2026-11-26 08:00:00

  // 1) 默认关闭（cnTaskJitter = false）：严格保持 09:00 / 21:00 且 delayMs = 0
  assert.equal(isCnDailyScheduleHour(8, false), false)
  assert.equal(isCnDailyScheduleHour(9, false), true)
  assert.equal(isCnDailyScheduleHour(10, false), false)
  assert.equal(isCnDailyScheduleHour(21, false), true)
  assert.equal(isIntlDailyScheduleHour(8), false)
  assert.equal(isIntlDailyScheduleHour(9), true)

  assert.deepEqual(
    decideCnTaskDispatch({ uid: 'acct-1', now: day1Morning8, hourUtc8: 8, cnTaskJitter: false }),
    { shouldRun: false, delayMs: 0, reason: 'not_this_hour' },
  )
  assert.deepEqual(
    decideCnTaskDispatch({ uid: 'acct-1', now: day1Morning8, hourUtc8: 9, cnTaskJitter: false }),
    { shouldRun: true, delayMs: 0, reason: 'legacy_fixed' },
  )

  // 2) 开启错峰（cnTaskJitter = true）：60 个账号均匀打散到 08:xx 与 09:xx，消除整点齐刷
  assert.equal(isCnDailyScheduleHour(8, true), true)
  assert.equal(isCnDailyScheduleHour(9, true), true)
  assert.equal(isCnDailyScheduleHour(10, true), true)
  assert.equal(isCnDailyScheduleHour(21, true), true)

  let countHour8 = 0
  let countHour9 = 0
  const offsets = new Set<number>()
  for (let i = 1; i <= 60; i += 1) {
    const uid = `cn-user-${i}`
    const slot = computeCnAccountJitterSlot(uid, '2026-11-26')
    const slotRepeat = computeCnAccountJitterSlot(uid, '2026-11-26')
    assert.deepEqual(slot, slotRepeat, '同账号同日槽位必须严格确定性幂等')
    assert.ok(slot.windowOffsetMs >= 0 && slot.windowOffsetMs < CN_JITTER_WINDOW_MS)
    assert.ok(slot.delayMs >= 0 && slot.delayMs < 3_600_000)
    assert.match(slot.slotTimeUtc8, /^0[89]:[0-5]\d:[0-5]\d$/)

    if (slot.slotHour === 8) countHour8 += 1
    else countHour9 += 1
    offsets.add(slot.windowOffsetMs)

    // 每个账号在 8 点与 9 点之间有且仅有 1 个主槽位触发
    const d8 = decideCnTaskDispatch({ uid, now: day1Morning8, hourUtc8: 8, cnTaskJitter: true })
    const d9 = decideCnTaskDispatch({ uid, now: day1Morning8, hourUtc8: 9, cnTaskJitter: true })
    assert.equal(Number(d8.shouldRun) + Number(d9.shouldRun), 1, `${uid} 在 8/9 点应恰好命中一次`)
  }

  assert.ok(countHour8 >= 15 && countHour9 >= 15, `8 点(${countHour8})与 9 点(${countHour9})均应有充足分布`)
  assert.ok(offsets.size >= 50, `60 个账号应分散到不同秒级偏移（实际 ${offsets.size} 个唯一时间点）`)

  // 3) 跨日日期变化后同一账号偏移自动轮换，避免固定秒数画像
  const changedAcrossDays = Array.from({ length: 10 }, (_, idx) => {
    const u = `cn-user-${idx + 1}`
    return computeCnAccountJitterSlot(u, '2026-11-26').windowOffsetMs !==
      computeCnAccountJitterSlot(u, '2026-11-27').windowOffsetMs
  }).filter(Boolean).length
  assert.ok(changedAcrossDays >= 8, '跨日后绝大多数账号触发时刻应发生变化')

  // 4) 10:00 兜底补跑与 21:00 晚间重试也在 15 分钟内错峰打散
  const d10 = decideCnTaskDispatch({ uid: 'cn-user-1', now: day1Morning8, hourUtc8: 10, cnTaskJitter: true })
  assert.equal(d10.shouldRun, true)
  assert.equal(d10.reason, 'window_catchup')
  assert.ok(d10.delayMs >= 0 && d10.delayMs < CN_RETRY_JITTER_MAX_MS)

  const d21 = decideCnTaskDispatch({ uid: 'cn-user-1', now: day1Morning8, hourUtc8: 21, cnTaskJitter: true })
  assert.equal(d21.shouldRun, true)
  assert.equal(d21.reason, 'evening_retry')
  assert.ok(d21.delayMs >= 0 && d21.delayMs < CN_RETRY_JITTER_MAX_MS)
})
