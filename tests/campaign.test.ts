/**
 * 运营活动模块（`src/upstream/campaign.ts`）单测：
 * - 根路径规则（默认 `module=""` → `/portal/activity`，避免 `/portal/activity/campaign/tasks` 空列表坑）；
 * - 标识符安全校验（阻断 `../` 路径穿越与 SSRF）；
 * - `progress[]` 数组合并与 `ready` / `claimed` 判据（含 `claimed_at` 过滤与 `target=0` 防误判）；
 * - `claimAccountCampaignTasks` 默认 `dryRun = true`（零写请求）与 `dryRun = false`（先 `viewed` 再 `claim`）；
 * - 业务码 `12304`（条件未满足）归入 `skipped` 而非硬错误，任务码路径参数转义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Env } from '../src/env.ts'
import {
  CAMPAIGN_DEFAULT_CODE,
  CAMPAIGN_DEFAULT_MODULE,
  CAMPAIGN_NOT_MET_CODE,
  CampaignError,
  campaignBasePath,
  campaignTaskReady,
  claimAccountCampaignTasks,
  claimCampaignTask,
  fetchCampaignSnapshot,
  isCampaignEligible,
  isCampaignNotMet,
  isValidCampaignIdent,
  parseCampaignTasksPayload,
  resolveCampaignSpec,
} from '../src/upstream/campaign.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function mockFetch(handler: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const realFetch = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v
    })
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('🔴 默认活动路径必须是 /portal/activity 而非 /portal/activity/campaign（1c007bb 实测修正）', () => {
  assert.equal(CAMPAIGN_DEFAULT_MODULE, '')
  assert.equal(CAMPAIGN_DEFAULT_CODE, 'campaign_starbucks_2026')
  assert.equal(campaignBasePath(), '/portal/activity')
  assert.equal(campaignBasePath(''), '/portal/activity')
  assert.equal(campaignBasePath('reporter'), '/portal/activity/reporter')
})

test('🔴 活动参数校验阻断路径穿越与非法字符（防携带 Bearer token 的 SSRF）', () => {
  assert.equal(isValidCampaignIdent(''), true)
  assert.equal(isValidCampaignIdent('campaign_starbucks_2026'), true)
  assert.equal(isValidCampaignIdent('campaign-2026_v2'), true)
  assert.equal(isValidCampaignIdent('../growth'), false)
  assert.equal(isValidCampaignIdent('a/b'), false)
  assert.equal(isValidCampaignIdent('a?x=1'), false)
  assert.equal(isValidCampaignIdent('a'.repeat(65)), false)

  assert.throws(() => resolveCampaignSpec({ module: '../admin' }), CampaignError)
  assert.throws(() => resolveCampaignSpec({ code: 'bad/code' }), CampaignError)
})

test('账号资格判定：仅国内个人版参与，国际版与企业版自动排除', () => {
  assert.equal(isCampaignEligible({ realm: 'cn', provider: 'buddy' }), true)
  assert.equal(isCampaignEligible({ realm: 'global', provider: 'workbuddy' }), false)
  assert.equal(isCampaignEligible({ realm: 'cn', enterpriseId: 'ent-123' }), false)
  assert.equal(isCampaignEligible({ realm: 'cn', provider: 'qodercn' }), false)
  assert.equal(isCampaignEligible({ realm: 'cn', accessToken: '' }), false)
})

test('🔴 parseCampaignTasksPayload：合并独立 progress[] 数组，精准识别 ready 并过滤已领项（93bbef3）', () => {
  const parsed = parseCampaignTasksPayload({
    tasks: [
      { id: 1, task_code: 'ai_chat', task_name: '小程序对话', target: 1, reward_type: 'voucher', reward_desc: '咖啡券' },
      { id: 2, task_code: 'expert', task_name: '专家体验', target: 2, reward_type: 'credit', reward_desc: '100 积分' },
      { id: 3, task_code: 'already_done', task_name: '已领任务', target: 1, reward_type: 'credit' },
      { id: 4, task_code: 'claimed_by_ts', task_name: '仅含领奖时间戳', target: 1, reward_type: 'credit' },
      { id: 5, task_code: 'zero_target', task_name: '零目标占位', target: 0, reward_type: 'credit' },
    ],
    progress: [
      { task_code: 'ai_chat', progress: 1, status: 'completed', completed_at: '2026-11-17T10:00:00Z' },
      { task_code: 'expert', progress: 1, status: 'in_progress' },
      { task_code: 'already_done', progress: 1, status: 'claimed', claimed_at: '2026-11-17T09:00:00Z' },
      { task_code: 'claimed_by_ts', progress: 1, status: '', claimed_at: '2026-11-17T08:00:00Z' },
      { task_code: 'zero_target', progress: 0, status: '' },
    ],
  })

  assert.deepEqual(parsed.ready, ['ai_chat'], '只有达标且未领取的 ai_chat 进入 ready')
  assert.deepEqual(parsed.claimed, ['already_done', 'claimed_by_ts'], 'status=claimed 与 claimed_at 非空都应识别为已领')
  assert.equal(campaignTaskReady(parsed.tasks.find((t) => t.taskCode === 'zero_target')!), false)
})

test('🔴 claimAccountCampaignTasks 默认 dryRun = true（零写请求），显式 dryRun = false 先 viewed 再 claim 且容忍 12304', async () => {
  const tasksPayload = {
    code: 0,
    data: {
      tasks: [
        { id: 1, task_code: 'ai_chat', task_name: '小程序对话', target: 1, reward_type: 'voucher' },
        { id: 2, task_code: 'app/special', task_name: '含斜杠任务码', target: 1, reward_type: 'credit' },
      ],
      progress: [
        { task_code: 'ai_chat', progress: 1, status: 'completed' },
        { task_code: 'app/special', progress: 1, status: 'completed' },
      ],
    },
  }

  // 1. 默认调用（不传 dryRun）必须是 dryRun = true，不发任何 POST
  const mDry = mockFetch((call) => {
    if (call.url.includes('/portal/activity/config')) {
      return json({ code: 0, data: { title: '星巴克联名活动', in_period: true } })
    }
    if (call.url.includes('/portal/activity/tasks?')) {
      return json(tasksPayload)
    }
    if (call.url.includes('/portal/activity/vouchers')) {
      return json({ code: 0, data: { vouchers: [{ task_code: 'old', voucher_code: 'V-001' }] } })
    }
    return json({ code: 500, msg: 'dryRun 不得触发写操作' }, 500)
  })
  try {
    const snap = await fetchCampaignSnapshot({ uid: 'u1', accessToken: 'tok' }, {} as Env)
    assert.equal(snap.title, '星巴克联名活动')
    assert.equal(snap.vouchers.length, 1)
    assert.equal(mDry.calls[0]?.headers['x-client-platform'], 'miniprogram')

    const dry = await claimAccountCampaignTasks({ uid: 'u1', accessToken: 'tok' }, {} as Env)
    assert.equal(dry.dryRun, true)
    assert.deepEqual(dry.wouldClaim, ['ai_chat', 'app/special'])
    assert.deepEqual(dry.claimed, [])
    assert.equal(
      mDry.calls.some((c) => c.method === 'POST'),
      false,
      '默认 dryRun=true 严禁向服务端发任何 POST 请求',
    )
  } finally {
    mDry.restore()
  }

  // 2. 显式传 dryRun: false：先 viewed 再 claim；ai_chat 领奖成功，app/special 回 12304 归入 skipped，且路径已转义
  const mReal = mockFetch((call) => {
    if (call.method === 'GET') {
      if (call.url.includes('/config')) return json({ code: 0, data: { in_period: true } })
      if (call.url.includes('/tasks?')) return json(tasksPayload)
      return json({ code: 0, data: { vouchers: [] } })
    }
    if (call.url.includes('/viewed?')) {
      return json({ code: 0, data: {} })
    }
    if (call.url.includes('/tasks/ai_chat/claim?')) {
      return json({ code: 0, data: { voucher_code: 'SBUX-8888', reward_type: 'voucher', reward_desc: '中杯券' } })
    }
    if (call.url.includes('/tasks/app%2Fspecial/claim?')) {
      return json({ code: CAMPAIGN_NOT_MET_CODE, msg: '任务条件未满足' }, 400)
    }
    return json({ code: 404, msg: `unexpected ${call.url}` }, 404)
  })
  try {
    const real = await claimAccountCampaignTasks(
      { uid: 'u1', accessToken: 'tok' },
      {} as Env,
      { dryRun: false, gapMs: 0 },
    )
    assert.equal(real.dryRun, false)
    assert.deepEqual(real.claimed, ['ai_chat'])
    assert.equal(real.results[0]?.voucherCode, 'SBUX-8888')
    assert.equal(real.skipped.length, 1, '12304 应归入 skipped 而非 errors')
    assert.match(real.skipped[0]!, /条件未满足/)
    assert.deepEqual(real.errors, [])

    const postPaths = mReal.calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).pathname)
    assert.deepEqual(postPaths, [
      '/portal/activity/tasks/ai_chat/viewed',
      '/portal/activity/tasks/ai_chat/claim',
      '/portal/activity/tasks/app%2Fspecial/viewed',
      '/portal/activity/tasks/app%2Fspecial/claim',
    ])
  } finally {
    mReal.restore()
  }
})

test('claimCampaignTask 抛出的 12304 可被 isCampaignNotMet 准确识别', async () => {
  const m = mockFetch(() => json({ code: 12304, msg: 'not completed' }, 400))
  try {
    let caught: unknown
    try {
      await claimCampaignTask({ uid: 'u1', accessToken: 'tok' }, {} as Env, 'ai_chat')
    } catch (error) {
      caught = error
    }
    assert.equal(isCampaignNotMet(caught), true)
  } finally {
    m.restore()
  }
})
