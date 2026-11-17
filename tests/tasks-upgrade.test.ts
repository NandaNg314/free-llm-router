/**
 * 成长任务全量升级单测：
 * 1. 国服默认列表 + `mp` 列表自动合并回读与领奖（`Library_read` 仅在 mp 下发时仍能回读+Web 领奖）；
 * 2. 国际版（`global`）绝不发送任何小程序 `mp` 请求头；
 * 3. `wb_wechat_oa_subscribe_task` 走 `mp` 口径 accept/claim；
 * 4. 国服 `skill_share` 四步全自动判据链（accept → market/skill/list → c2c/channels 二次 JSON `asset_ref` → `skill_share_channel_action`）；
 * 5. 小程序 `Sequential_Tasks_1` / `Sequential_Tasks_2` 自动化与 `locked` 秒跳；
 * 6. 猫猫旅行 `record_id` / `travel/config` / `buddyQuota` `affordable` 与 `buddyBox` 防覆盖旅行记录状态机。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Env } from '../src/env.ts'
import {
  buildSkillShareBody,
  findTaskByCode,
  isCnRealm,
  isMpTask,
  listTasks,
} from '../src/upstream/tasks.ts'
import { buddyQuota, travelClaim, travelDepart, travelStatus } from '../src/upstream/travel.ts'
import { executeAction } from '../src/taskrunner/actions.ts'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function installFetchMock(handler: (call: RecordedCall) => Response): {
  calls: RecordedCall[]
  restore: () => void
} {
  const realFetch = globalThis.fetch
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v
    })
    const body = typeof init.body === 'string' ? init.body : ''
    const call: RecordedCall = {
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body,
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

test('🔴 国服 listTasks / findTaskByCode 自动合并默认口径与 mp 口径（修复 Library_read 仅在 mp 下发被误判缺失）', async () => {
  const m = installFetchMock((call) => {
    const isMp = call.headers['x-client-platform'] === 'miniprogram' || call.headers['x-platform'] === 'wechatmp'
    if (isMp) {
      return json({
        code: 0,
        data: {
          tasks: [
            { task_code: 'Library_read', current: 1, target: 1, accept_status: 'accepted', reward_credit: 50 },
            { task_code: 'wb_wechat_oa_subscribe_task', current: 0, target: 1, accept_status: 'not_accepted' },
          ],
        },
      })
    }
    return json({
      code: 0,
      data: {
        tasks: [{ task_code: 'chat_5', current: 5, target: 5, accept_status: 'accepted', reward_credit: 100 }],
      },
    })
  })
  try {
    const all = await listTasks({ uid: 'u-cn', accessToken: 'tok', realm: 'cn' }, {} as Env)
    assert.deepEqual(
      all.map((t) => t.taskCode),
      ['chat_5', 'Library_read', 'wb_wechat_oa_subscribe_task'],
    )
    const lib = await findTaskByCode({ uid: 'u-cn', accessToken: 'tok', realm: 'cn' }, {} as Env, 'Library_read')
    assert.equal(lib?.claimable, true, '仅在 mp 列表出现的 Library_read 也必须被回读为可领')
    // Library_read 领奖仍走 Web 权威路径（非 mp 任务），而公众号订阅任务走 mp 口径
    assert.equal(isMpTask('Library_read'), false)
    assert.equal(isMpTask('wb_wechat_oa_subscribe_task'), true)
  } finally {
    m.restore()
  }
})

test('🔴 国际版（global / workbuddy）绝不发送任何小程序 mp 请求头，也不泄漏国内 5.11.3 X-Client-* 三头', async () => {
  assert.equal(isCnRealm('cn'), true)
  assert.equal(isCnRealm('buddy'), true)
  assert.equal(isCnRealm('global'), false)
  assert.equal(isCnRealm('workbuddy'), false)

  const m = installFetchMock(() =>
    json({
      code: 0,
      data: {
        tasks: [{ task_code: 'chat_5', current: 0, target: 5, accept_status: 'not_accepted' }],
      },
    }),
  )
  try {
    const tasks = await listTasks({ uid: 'u-gl', accessToken: 'tok', realm: 'global' }, {} as Env)
    assert.equal(tasks.length, 1)
    assert.equal(m.calls.length, 1, '国际版只允许打 1 次默认任务列表，严禁再打 mp 支路')
    assert.equal(m.calls[0]?.headers['origin'], 'https://www.workbuddy.ai', '裸 uid 国际版必须带国际 Origin')
    assert.equal(m.calls[0]?.headers['x-client-version'], undefined, '国际版绝不泄漏国内 X-Client-Version')
    assert.equal(m.calls[0]?.headers['x-client-platform'], undefined, '国际版绝不泄漏国内 X-Client-Platform 或 mp 头')
    assert.equal(m.calls[0]?.headers['x-client-product'], undefined, '国际版绝不泄漏国内 X-Client-Product')
    assert.equal(m.calls[0]?.headers['x-platform'], undefined)

    const { acceptTasks } = await import('../src/upstream/tasks.ts')
    await acceptTasks({ uid: 'u-gl', accessToken: 'tok', realm: 'global' }, {} as Env, ['chat_5'])
    assert.equal(m.calls.length, 2)
    assert.equal(m.calls[1]?.headers['origin'], 'https://www.workbuddy.ai')
    assert.equal(m.calls[1]?.headers['x-client-version'], undefined)
    assert.equal(m.calls[1]?.headers['x-client-platform'], undefined)
    assert.equal(m.calls[1]?.headers['x-client-product'], undefined)

    const explicitMp = await listTasks(
      { uid: 'u-gl', accessToken: 'tok', realm: 'global' },
      {} as Env,
      { mp: true },
    )
    assert.deepEqual(explicitMp, [])
    assert.equal(m.calls.length, 2, '显式传 mp:true 时国际版也必须直接短路返回空，0 次网络请求')
  } finally {
    m.restore()
  }
})

test('acceptPending：wb_wechat_oa_subscribe_task 走 mp 头 accept，桌面任务走桌面头 accept', async () => {
  const m = installFetchMock((call) => {
    if (call.method === 'GET') {
      const isMp = call.headers['x-client-platform'] === 'miniprogram'
      return json({
        code: 0,
        data: {
          tasks: isMp
            ? [
                { task_code: 'wb_wechat_oa_subscribe_task', current: 0, target: 1, accept_status: 'not_accepted' },
                { task_code: 'Sequential_Tasks_2', current: 0, target: 1, accept_status: 'not_accepted', locked: true },
              ]
            : [{ task_code: 'skill_share', current: 0, target: 1, accept_status: 'not_accepted' }],
        },
      })
    }
    return json({ code: 0, data: {} })
  })
  try {
    const r = await executeAction(
      { code: '_probe', action: 'acceptPending', delayMs: 0 },
      { uid: 'u-cn', nickname: 'n', realm: 'cn', accessToken: 'tok', now: Date.now() },
      {} as Env,
    )
    assert.equal(r.ok, true)
    const accepts = m.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/activity/growth/tasks/accept'))
    assert.equal(accepts.length, 2, '桌面与 mp 应分两次独立 accept（locked 任务跳过）')
    const desktopBody = JSON.parse(accepts[0]!.body) as { task_codes: string[] }
    const mpBody = JSON.parse(accepts[1]!.body) as { task_codes: string[] }
    assert.deepEqual(desktopBody.task_codes, ['skill_share'])
    assert.deepEqual(mpBody.task_codes, ['wb_wechat_oa_subscribe_task'])
    assert.equal(accepts[1]!.headers['x-client-platform'], 'miniprogram')
  } finally {
    m.restore()
  }
})

test('🔴 skill_share 四步判据链：accept → 真实市场技能 → 二次 JSON 字符串 asset_ref → wechat/success/channel_id 上报', async () => {
  // 1. 纯函数协议校验：asset_ref 必须是字符串而非嵌套对象
  const rawShareBody = buildSkillShareBody({ skillId: 'sk_real_42', source: 'market' })
  const parsedShare = JSON.parse(rawShareBody) as Record<string, unknown>
  assert.equal(parsedShare.asset_kind, 'skill')
  assert.equal(parsedShare.asset_source, 'market')
  assert.equal(typeof parsedShare.asset_ref, 'string', 'asset_ref 必须是二次 JSON 字符串')
  assert.equal(parsedShare.asset_ref, '{"asset_id":"sk_real_42"}')

  // 2. 完整动作四步调用顺序与报文校验
  const m = installFetchMock((call) => {
    if (call.method === 'GET' && call.url.endsWith('/v2/activity/growth/tasks')) {
      return json({
        code: 0,
        data: {
          tasks: [{ task_code: 'skill_share', current: 0, target: 0, accept_status: 'not_accepted' }],
        },
      })
    }
    if (call.url.endsWith('/v2/activity/growth/tasks/accept')) {
      return json({ code: 0, data: {} })
    }
    if (call.url.endsWith('/portal/operation-platform/market/skill/list')) {
      return json({
        code: 0,
        data: {
          list: [
            {
              skill_id: 'skill_market_888',
              name: 'code-review-pro',
              display_name_zh: '代码审查大师',
              version: '2.1.0',
              source: 'market',
            },
          ],
        },
      })
    }
    if (call.url.endsWith('/api/v2/open-platform/asset-shares/c2c/channels')) {
      return json({ code: 0, data: { channel_id: 'ch_c2c_77777' } })
    }
    if (call.url.endsWith('/v2/report')) {
      return json({ code: 0, data: {} })
    }
    return json({ code: 404, msg: `unexpected ${call.url}` }, 404)
  })
  try {
    const r = await executeAction(
      { code: 'skill_share', action: 'skillShare', delayMs: 0 },
      { uid: 'u-cn', nickname: 'tester', realm: 'cn', accessToken: 'tok', now: 1_700_000_000_000 },
      {} as Env,
    )
    assert.equal(r.ok, true, r.detail)
    const postPaths = m.calls.filter((c) => c.method === 'POST').map((c) => new URL(c.url).pathname)
    assert.deepEqual(postPaths, [
      '/v2/activity/growth/tasks/accept',
      '/portal/operation-platform/market/skill/list',
      '/api/v2/open-platform/asset-shares/c2c/channels',
      '/v2/report',
    ])

    const c2cCall = m.calls.find((c) => c.url.includes('/asset-shares/c2c/channels'))!
    const c2cJson = JSON.parse(c2cCall.body) as Record<string, unknown>
    assert.equal(c2cJson.asset_ref, '{"asset_id":"skill_market_888"}')

    const reportCall = m.calls.find((c) => c.url.endsWith('/v2/report'))!
    const reportBody = JSON.parse(reportCall.body) as Array<Record<string, unknown>>
    const ev = Array.isArray(reportBody)
      ? reportBody[0]!
      : (((reportBody as unknown as { events: Array<Record<string, unknown>> }).events ?? [])[0]!)
    assert.equal(ev.eventCode, 'skill_share_channel_action')
    assert.equal(ev.action, 'wechat')
    assert.equal(ev.panelAction, 'success')
    assert.equal(ev.id, 'ch_c2c_77777')
    assert.equal(ev.skillId, 'skill_market_888')
  } finally {
    m.restore()
  }
})

test('🔴 skill_share：若 c2c/channels 未返回 channel_id，必须立即报错且不得发假 /v2/report', async () => {
  const m = installFetchMock((call) => {
    if (call.method === 'GET') {
      return json({
        code: 0,
        data: { tasks: [{ task_code: 'skill_share', current: 0, target: 1, accept_status: 'accepted' }] },
      })
    }
    if (call.url.endsWith('/portal/operation-platform/market/skill/list')) {
      return json({ code: 0, data: { list: [{ skill_id: 'sk_1', name: 's1' }] } })
    }
    if (call.url.endsWith('/api/v2/open-platform/asset-shares/c2c/channels')) {
      return json({ code: 0, data: {} })
    }
    return json({ code: 0, data: {} })
  })
  try {
    const r = await executeAction(
      { code: 'skill_share', action: 'skillShare', delayMs: 0 },
      { uid: 'u-cn', nickname: 'tester', realm: 'cn', accessToken: 'tok', now: Date.now() },
      {} as Env,
    )
    assert.equal(r.ok, false)
    assert.match(r.detail, /channel_id/)
    assert.equal(m.calls.some((c) => c.url.endsWith('/v2/report')), false, '缺 channel_id 时不得发埋点')
  } finally {
    m.restore()
  }
})

test('小程序 Sequential_Tasks_1 上报 mp 域，Sequential_Tasks_2 未解锁（locked）时干净跳过', async () => {
  const m = installFetchMock((call) => {
    if (call.method === 'GET' && call.url.endsWith('/v2/activity/growth/tasks')) {
      return json({
        code: 0,
        data: {
          tasks: [
            { task_code: 'Sequential_Tasks_1', current: 0, target: 1, accept_status: 'accepted' },
            { task_code: 'Sequential_Tasks_2', current: 0, target: 1, accept_status: 'not_accepted', locked: true },
          ],
        },
      })
    }
    return json({ code: 0, data: {} })
  })
  try {
    const r1 = await executeAction(
      { code: 'Sequential_Tasks_1', action: 'sequentialTask1', delayMs: 0 },
      { uid: 'u-cn', nickname: 'tester', realm: 'cn', accessToken: 'tok', now: Date.now() },
      {} as Env,
    )
    assert.equal(r1.ok, true)
    assert.ok(m.calls.some((c) => c.url === 'https://www.codebuddy.cn/v2/report'), '应向 mp billing 域上报')

    const r2 = await executeAction(
      { code: 'Sequential_Tasks_2', action: 'sequentialTask2', delayMs: 0 },
      { uid: 'u-cn', nickname: 'tester', realm: 'cn', accessToken: 'tok', now: Date.now() },
      {} as Env,
    )
    assert.equal(r2.ok, true)
    assert.match(r2.detail, /解锁/)

    // verifyAndClaim 遇到 locked 顺序任务也必须秒跳，不轮询
    const callsBefore = m.calls.length
    const vc = await executeAction(
      { code: 'Sequential_Tasks_2', action: 'verifyAndClaim', delayMs: 0 },
      { uid: 'u-cn', nickname: 'tester', realm: 'cn', accessToken: 'tok', now: Date.now() },
      {} as Env,
    )
    assert.equal(vc.ok, true)
    assert.equal(m.calls.length - callsBefore, 1, 'locked 任务只查 1 次即跳过，不走 4 轮轮询')
  } finally {
    m.restore()
  }
})

test('猫猫旅行与盲盒（db08e48）：record_id 透传、travel/config 动态目的地、buddyQuota affordable 与 buddyBox 旅行中保护', async () => {
  const m = installFetchMock((call) => {
    const path = new URL(call.url).pathname
    if (path === '/activity/growth/buddy/quota') {
      return json({ code: 0, data: { balance: 30, affordable: 3 } })
    }
    if (path === '/activity/growth/buddy/travel/status') {
      return json({
        code: 0,
        data: { state: 'traveling', daily_limit_reached: false, destination: '海边', record_id: 'rec-42' },
      })
    }
    if (path === '/activity/growth/buddy/travel/config') {
      return json({ code: 0, data: { locations: [{ id: 'loc-park', name: '公园' }] } })
    }
    if (path === '/activity/growth/buddy/travel/depart') {
      const parsed = JSON.parse(call.body) as Record<string, unknown>
      return parsed.location_id === 'loc-park'
        ? json({ code: 0, data: {} })
        : json({ code: 10002, msg: 'invalid request' }, 400)
    }
    if (path === '/activity/growth/buddy/travel/claim') {
      const parsed = JSON.parse(call.body) as Record<string, unknown>
      return parsed.record_id === 'rec-42'
        ? json({ code: 0, data: {} })
        : json({ code: 10002, msg: 'invalid request' }, 400)
    }
    if (path === '/activity/growth/buddy/open') {
      return json({ code: 0, data: {} })
    }
    return json({ code: 0, data: {} })
  })
  try {
    const q = await buddyQuota({ uid: 'u1', accessToken: 't' }, {} as Env)
    assert.equal(q.remaining, 3, '必须识别上游真实字段 affordable')

    const st = await travelStatus({ uid: 'u1', accessToken: 't' }, {} as Env)
    assert.equal(st.recordId, 'rec-42')

    const cl = await travelClaim({ uid: 'u1', accessToken: 't' }, {} as Env, st.recordId)
    assert.equal(cl.claimed, true, 'travelClaim 应携带 record_id 领奖')

    const dep = await travelDepart({ uid: 'u1', accessToken: 't' }, {} as Env)
    assert.equal(dep.departed, true, 'travelDepart 应先读 travel/config 取动态字符串目的地 id')

    // 伙伴正在 traveling 时，buddyBox 必须跳过 buddy/open 以免覆盖旅行记录
    const boxRes = await executeAction(
      { code: 'buddy_box', action: 'buddyBox', delayMs: 0 },
      { uid: 'u1', nickname: 'n', realm: 'cn', accessToken: 't', now: Date.now() },
      {} as Env,
    )
    assert.equal(boxRes.ok, true)
    assert.match(boxRes.detail, /traveling/)
    assert.equal(m.calls.some((c) => c.url.endsWith('/activity/growth/buddy/open')), false)
  } finally {
    m.restore()
  }
})
