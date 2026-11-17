/**
 * 账号池精细调度与派生会话粘性专项单测：
 * 1. Pro 专属模型事前过滤（`AccountPoolDO.pick` + `isPaid` 三条安全不变式）；
 * 2. `11140` 区域限制波次闸门随池规模动态缩放 + 指数退避 + 30 分钟平静期清零；
 * 3. `conversation.ts` 派生会话粘性键（无 `callerScope` 逐字节向后兼容、多下游 `user`/子密钥分槽、同用户多轮稳定命中）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import {
  RESTRICTION_CALM_RESET_MS,
  RESTRICTION_HOLD_BASE_MS,
  createAccountState,
} from '../src/pool/state.js'
import {
  deriveSessionKey,
  deriveStickySessionKey,
  extractCallerScope,
} from '../src/providers/conversation.js'

function freshPoolRuntime(tag: string) {
  const dir = path.join(process.cwd(), '.build')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `test-pool-exclusive-${tag}-${process.pid}.db`)
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  const runtime = createNodeRuntime(dbPath)
  const cleanup = () => {
    runtime.db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p)
        } catch {
          // Windows 文件句柄释放偶有延迟，忽略临时文件清理异常
        }
      }
    }
  }
  return { runtime, cleanup }
}

async function sha256HexRef(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

test('AccountPoolDO Pro 专属模型选号：满足未观测放行、全免费兜底、既有粘性不硬拦三条不变式', async () => {
  const { runtime, cleanup } = freshPoolRuntime('pro-tier')
  try {
    const pool = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))
    const now = 1_710_000_000_000

    await pool.upsertAccount(
      createAccountState({ uid: 'acct-free', nickname: '免费号', realm: 'cn', provider: 'buddy', isPaid: false }),
      now,
    )
    await pool.upsertAccount(
      createAccountState({ uid: 'acct-unknown', nickname: '未观测号', realm: 'cn', provider: 'buddy' }),
      now,
    )
    await pool.upsertAccount(
      createAccountState({ uid: 'acct-paid', nickname: 'Pro号', realm: 'cn', provider: 'buddy', isPaid: true }),
      now,
    )

    // ① Pro 专属模型（冷启动 primary-model）选号：跳过 isPaid=false，但放行 isPaid=undefined 与 isPaid=true
    const pickedSet = new Set<string>()
    for (let i = 0; i < 6; i += 1) {
      const res = await pool.pick({
        realm: 'cn',
        provider: 'buddy',
        model: 'primary-model',
        exclude: [],
        now: now + i * 5_000,
      })
      assert.ok(res !== undefined)
      pickedSet.add(res.uid)
    }
    assert.equal(pickedSet.has('acct-free'), false, '已知免费号不应被事前派给 Pro 专属模型')
    assert.equal(pickedSet.has('acct-unknown'), true, '不变式 ①：isPaid === undefined 必须一律放行')
    assert.equal(pickedSet.has('acct-paid'), true, '付费号正常参与选号')

    // ③ 既有粘性绑定（preferred = acct-free）绝不硬拦；待 11158 模型冷却写入后自动换到付费/未知号
    const stickyHit = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'primary-model',
      preferred: 'acct-free',
      exclude: [],
      now: now + 40_000,
    })
    assert.equal(stickyHit?.uid, 'acct-free', '不变式 ③：既有会话粘性绑定绝不能硬拦')

    await pool.applyFailure({
      uid: 'acct-free',
      kind: 'model',
      model: 'primary-model',
      modelCause: 'denied',
      now: now + 41_000,
      reason: '11158 model not allowed for user type',
    })
    const rotatedAfter11158 = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'primary-model',
      preferred: 'acct-free',
      exclude: [],
      now: now + 42_000,
    })
    assert.ok(rotatedAfter11158 !== undefined && rotatedAfter11158.uid !== 'acct-free', '11158 模型冷却后自动换离免费号')

    // ② 当所有可用候选均为 isPaid === false 时，必须兜底放行，绝不能返回 undefined 报无号可用
    await pool.setAccountPaid('acct-unknown', false, now + 50_000)
    await pool.setAccountPaid('acct-paid', false, now + 50_000)
    const fallbackPick = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'claude-opus-4-6',
      requiresPaid: true,
      exclude: [],
      now: now + 60_000,
    })
    assert.ok(fallbackPick !== undefined, '不变式 ②：全池均为免费号时必须兜底放行，不得报无可用账号')

    // updateBalance 记录 isPaid 且不触碰惩罚态
    await pool.updateBalance('acct-paid', now + 70_000, {
      credits: 1200,
      expiring: 200,
      earliestExpiry: now + 86_400_000,
      isPaid: true,
    })
    const refreshedPaid = await pool.getAccount('acct-paid')
    assert.equal(refreshedPaid?.isPaid, true)

    // 动态同步 exclusiveModels 列表后，按动态列表过滤
    await pool.setExclusiveModels(['claude-sonnet-4-6'])
    const dynPick = await pool.pick({
      realm: 'cn',
      provider: 'buddy',
      model: 'claude-sonnet-4-6',
      exclude: [],
      now: now + 80_000,
    })
    assert.equal(dynPick?.uid, 'acct-paid', '动态同步 exclusiveModels 后优先命中唯二之一的付费号')
  } finally {
    cleanup()
  }
})

test('AccountPoolDO 11140 区域闸门：60 号大池不因 2 个号整池封停，平静期 30 分钟后连败退避清零', async () => {
  const { runtime, cleanup } = freshPoolRuntime('restriction-scale')
  try {
    const poolCn = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))
    const t0 = 1_720_000_000_000

    for (let i = 0; i < 60; i += 1) {
      await poolCn.upsertAccount(
        createAccountState({ uid: `big-${i}`, nickname: `号${i}`, realm: 'cn', provider: 'buddy' }),
        t0,
      )
    }

    // 60 号池阈值 = floor(60 / 10) = 6；前 5 个不同账号撞 11140 不得封停整池
    for (let i = 0; i < 5; i += 1) {
      const paused = await poolCn.noteRestriction(`big-${i}`, t0 + i * 100)
      assert.equal(paused, false, `60 号池第 ${i + 1} 个受限号不应触发整池暂停`)
    }
    const statusBefore = await poolCn.restrictionGateStatus(t0 + 600)
    assert.equal(statusBefore.threshold, 6)
    assert.equal(statusBefore.active, false)
    assert.equal(statusBefore.recentUids, 5)

    // 第 6 个不同账号命中 ⇒ 触发第 1 波暂停（30s）
    const wave1 = await poolCn.noteRestriction('big-5', t0 + 700)
    assert.equal(wave1, true)
    const statusWave1 = await poolCn.restrictionGateStatus(t0 + 700)
    assert.equal(statusWave1.active, true)
    assert.equal(statusWave1.streak, 1)
    assert.equal(statusWave1.until, t0 + 700 + RESTRICTION_HOLD_BASE_MS)

    // 小池（global 分片 4 号，阈值 = 2）：验证连续第 2 波退避翻倍 + 30 分钟平静期后清零
    const poolGlobal = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('global'))
    for (let i = 0; i < 4; i += 1) {
      await poolGlobal.upsertAccount(
        createAccountState({ uid: `gl-${i}`, nickname: `国际${i}`, realm: 'global', provider: 'workbuddy' }),
        t0,
      )
    }
    assert.equal(await poolGlobal.noteRestriction('gl-0', t0), false)
    assert.equal(await poolGlobal.noteRestriction('gl-1', t0 + 100), true) // streak=1, hold=30s

    const tWave2 = t0 + 100 + RESTRICTION_HOLD_BASE_MS + 1_000
    assert.equal(await poolGlobal.noteRestriction('gl-2', tWave2), false)
    assert.equal(await poolGlobal.noteRestriction('gl-3', tWave2 + 100), true) // streak=2, hold=60s
    const st2 = await poolGlobal.restrictionGateStatus(tWave2 + 100)
    assert.equal(st2.streak, 2)
    assert.equal(st2.until, tWave2 + 100 + RESTRICTION_HOLD_BASE_MS * 2)

    // 静默满 30 分钟后：streak 必须真正归零，再次触发回到首档 30s
    const tAfterCalm = tWave2 + 100 + RESTRICTION_CALM_RESET_MS
    const stCalmed = await poolGlobal.restrictionGateStatus(tAfterCalm)
    assert.equal(stCalmed.active, false)
    assert.equal(stCalmed.streak, 0)
    assert.equal(stCalmed.recentUids, 0)

    assert.equal(await poolGlobal.noteRestriction('gl-0', tAfterCalm + 500), false)
    assert.equal(await poolGlobal.noteRestriction('gl-1', tAfterCalm + 600), true)
    const stRestart = await poolGlobal.restrictionGateStatus(tAfterCalm + 600)
    assert.equal(stRestart.streak, 1)
    assert.equal(stRestart.until, tAfterCalm + 600 + RESTRICTION_HOLD_BASE_MS)
  } finally {
    cleanup()
  }
})

test('会话粘性键派生：无 callerScope 时逐字节一致，掺入 user/metadata.user_id/子密钥时防撞车且多轮稳定', async () => {
  // ① 向后兼容：未提供 callerScope 时，与历史哈希逐字节一致
  const expectedUserKey = `u:${(await sha256HexRef('alice-dev')).slice(0, 32)}`
  assert.equal(await deriveSessionKey({ user: 'alice-dev' }), expectedUserKey)

  const expectedConvKey = `c:${(await sha256HexRef('conv-xyz-001')).slice(0, 32)}`
  assert.equal(await deriveSessionKey({ conversation_id: 'conv-xyz-001' }), expectedConvKey)
  assert.equal(await deriveStickySessionKey({ conversation_id: 'conv-xyz-001' }), expectedConvKey)

  assert.equal(await deriveSessionKey({ messages: [{ role: 'user', content: 'hi' }] }), '')
  assert.equal(await deriveSessionKey({ user: 'chatbox', messages: [{ role: 'user', content: 'hi' }] }), '')

  const expectedLegacyContentKey = `d:${(await sha256HexRef('You are helpful\u0000hi')).slice(0, 32)}`
  assert.equal(
    await deriveStickySessionKey({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hi' },
      ],
    }),
    expectedLegacyContentKey,
  )

  // ② 不同下游客户端（user / metadata.user_id / subkeyId）发相同开场白 "hi" + 相同 Agent 系统提示词 ⇒ 严格分槽
  const sharedAgentPrompt = 'You are Claude Code, Anthropic official CLI.'
  const turn1Body = {
    system: sharedAgentPrompt,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const slotSubkeyA = await deriveStickySessionKey(turn1Body, { callerScope: 'subkey:sk_team_a' })
  const slotSubkeyB = await deriveStickySessionKey(turn1Body, { callerScope: 'subkey:sk_team_b' })
  const slotMetaUser = await deriveStickySessionKey({
    ...turn1Body,
    metadata: { user_id: 'user_claude_99' },
  })
  assert.notEqual(slotSubkeyA, slotSubkeyB, '不同子密钥发相同 "hi" 必须分槽')
  assert.notEqual(slotSubkeyA, slotMetaUser, '子密钥与 metadata.user_id 必须分槽')
  assert.notEqual(slotSubkeyA, expectedLegacyContentKey, '掺入 callerScope 后必须与无作用域哈希区分')

  // ③ 同一用户的多轮对话（追加 assistant 与后续 user 轮次）⇒ 稳定命中同一粘性键
  const turn2Body = {
    system: sharedAgentPrompt,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
      { role: 'user', content: '帮我重构路由模块' },
    ],
  }
  const slotSubkeyATurn2 = await deriveStickySessionKey(turn2Body, { callerScope: 'subkey:sk_team_a' })
  assert.equal(slotSubkeyATurn2, slotSubkeyA, '同一调用方的多轮追加对话必须稳定命中同一粘性键')

  // extractCallerScope 优先级校验
  assert.equal(extractCallerScope({ user: 'chatbox' }, 'subkey:k1'), 'subkey:k1')
  assert.equal(extractCallerScope({ metadata: { user_id: 'cc_u1' } }, 'subkey:k1'), 'cc_u1')
  assert.equal(extractCallerScope({ user: 'real_alice', metadata: { user_id: 'cc_u1' } }, 'subkey:k1'), 'real_alice')
})

test('AccountPoolDO 持久化 autoContinuation 与 systemCorsConfig（防多 Isolate 失忆与重启丢失）', async () => {
  const { runtime, cleanup } = freshPoolRuntime('do-cors-autocont')
  try {
    const pool = runtime.env.ACCOUNT_POOL.get(runtime.env.ACCOUNT_POOL.idFromName('cn'))

    // 默认未覆盖 ⇒ undefined（跟随环境变量）
    const initRouting = await pool.getRoutingConfig()
    assert.equal(initRouting.autoContinuation, undefined)
    assert.equal(await pool.getCorsConfig(), undefined)

    // 写入 autoContinuation=true 后保留，其他字段更新时不丢失，传 null 恢复 undefined
    const afterSetTrue = await pool.setRoutingConfig({ autoContinuation: true })
    assert.equal(afterSetTrue.autoContinuation, true)
    const afterStrategy = await pool.setRoutingConfig({ strategy: 'roundrobin' })
    assert.equal(afterStrategy.autoContinuation, true)
    assert.equal(afterStrategy.strategy, 'roundrobin')
    const afterResetAuto = await pool.setRoutingConfig({ autoContinuation: null })
    assert.equal(afterResetAuto.autoContinuation, undefined)
    assert.equal('autoContinuation' in afterResetAuto, false)

    // 写入 CORS 白名单配置并支持 null 重置回环境变量
    const savedCors = await pool.setCorsConfig({
      enabled: true,
      origins: ['https://app.example.com'],
      maxAge: 1200,
    })
    assert.deepEqual(savedCors, {
      enabled: true,
      origins: ['https://app.example.com'],
      maxAge: 1200,
    })
    assert.deepEqual(await pool.getCorsConfig(), savedCors)

    const clearedCors = await pool.setCorsConfig(null)
    assert.equal(clearedCors, undefined)
    assert.equal(await pool.getCorsConfig(), undefined)
  } finally {
    cleanup()
  }
})
