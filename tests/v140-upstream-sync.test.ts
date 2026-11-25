/**
 * v1.4.0 社区防风控改写、错误分类防轮转风暴与多轮协议修复集成单测（2026-11-20 ～ 2026-11-25）。
 *
 * 覆盖：
 * 1. Claude Code `official CLI` 渠道自述句改写（`7513e88`）、`assistant` 注入中性头剥离（`a8280b1`）
 *    与工具 JSON Schema 双反斜杠 `\\uD800`–`\\uDFFF` 代理区剥离（`abed839`）；
 * 2. 错误码 `11102`/`14401`/`11103`/`11353+[413]` 请求级 `bad_request` 防轮转风暴（`d629a8c`/`b35a8d0`/`787401d`）
 *    及边缘 HTML `401/403` 可恢复判定（`0ec35a0`）；
 * 3. `continuation.ts` 独立 `::browser-complete` 续写救援与合成提示语纯中性（`6dc02b3`/`2e2358c`/`f60c68d`）
 *    及 `responses.ts` `parallel_tool_calls` 布尔显式透传（`a7e9891`）；
 * 4. `models.ts` 企业账号目录身份头 `X-User-Id` + `X-Enterprise-Id` + `X-Tenant-Id`（`94efc8f`）、
 *    `webagent.ts` 国际版活跃对话 `system` 提示词（`22c50c3`）及 `qoder.ts` 陈旧 `claimedAt` 护栏（`2e8d0c3`）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { catalogIdentityHeaders, listModels } from '../src/gateway/models.ts'
import {
  BROWSER_COMPLETE_NUDGE,
  CONTINUE_NUDGE,
  INTERNAL_NUDGE_PREFIX,
  NARRATION_COLON_NUDGE,
  NARRATION_PROMISE_NUDGE,
  isBrowserCompleteDirectiveOnly,
  shouldRescueBrowserComplete,
} from '../src/gateway/continuation.ts'
import {
  OFFICIAL_CLI_REPLACEMENT,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  prepareChatBody,
  stripInjectedAssistantHead,
} from '../src/gateway/payload.ts'
import { toChatBody, toResponsesObject } from '../src/gateway/responses.ts'
import { isQoderClaimedAtStale, isQoderClaimedAtToday } from '../src/providers/qoder.ts'
import { classify, isGatewayAuthRejection, shouldPunish, shouldRotate } from '../src/upstream/client.ts'
import {
  DAILY_CHAT_PROMPT,
  DAILY_CHAT_SYSTEM_PROMPT,
  WEB_CONVERSATIONS_URL,
  buildWebDailyMessages,
  runWebDailyChat,
} from '../src/upstream/webagent.ts'
import type { Env } from '../src/env.ts'

test('models.ts：企业号 listModels 成套发送 X-User-Id + X-Enterprise-Id + X-Tenant-Id，个人号不发企业头（94efc8f）', async () => {
  assert.deepEqual(catalogIdentityHeaders({ uid: '100001', enterpriseId: 'ent-88' }), {
    'X-User-Id': '100001',
    'X-Enterprise-Id': 'ent-88',
    'X-Tenant-Id': 'ent-88',
  })
  assert.deepEqual(catalogIdentityHeaders({ uid: 'workbuddy:100001', extras: { enterprise_id: 'ent-99' } }), {
    'X-User-Id': '100001',
    'X-Enterprise-Id': 'ent-99',
    'X-Tenant-Id': 'ent-99',
  })
  assert.deepEqual(catalogIdentityHeaders({ uid: '', enterpriseId: 'ent-orphan' }), {}, '缺 uid 时绝不单发企业头')
  assert.deepEqual(catalogIdentityHeaders({ uid: '100001' }), { 'X-User-Id': '100001' })

  const realFetch = globalThis.fetch
  const seenHeaders: Array<Record<string, string>> = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      h[k] = v
    })
    seenHeaders.push(h)
    const isEnt = h['x-enterprise-id'] === 'ent-acme' && h['x-user-id'] === '100000000001'
    const models = isEnt
      ? [
          { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000 },
          { id: 'glm-5.4', name: 'GLM-5.4', maxInputTokens: 1_000_000 },
        ]
      : [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000 }]
    return new Response(JSON.stringify({ code: 0, msg: 'OK', data: { models } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const env = {} as Env
    // 1. 企业账号：拿到完整企业模型名册且三头齐全
    const entModels = await listModels(
      { uid: '100000000001', accessToken: 'tok-ent', enterpriseId: 'ent-acme' },
      env,
    )
    assert.deepEqual(
      entModels.map((m) => m.id),
      ['glm-5.3', 'glm-5.4'],
    )
    assert.equal(seenHeaders[0]!['x-user-id'], '100000000001')
    assert.equal(seenHeaders[0]!['x-enterprise-id'], 'ent-acme')
    assert.equal(seenHeaders[0]!['x-tenant-id'], 'ent-acme')
    assert.equal(seenHeaders[0]!['x-no-enterprise-id'], undefined)

    // 2. 个人账号：只带 X-User-Id，不带 X-Enterprise-Id / X-Tenant-Id / X-No-Enterprise-Id
    const personalModels = await listModels({ uid: 'u-personal', accessToken: 'tok-p' }, env)
    assert.deepEqual(
      personalModels.map((m) => m.id),
      ['glm-5.3'],
    )
    assert.equal(seenHeaders[1]!['x-user-id'], 'u-personal')
    assert.equal(seenHeaders[1]!['x-enterprise-id'], undefined)
    assert.equal(seenHeaders[1]!['x-tenant-id'], undefined)
    assert.equal(seenHeaders[1]!['x-no-enterprise-id'], undefined)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('webagent.ts：国际版活跃对话建会话携带首条 system 提示词与 system→user 消息结构（22c50c3）', async () => {
  assert.deepEqual(buildWebDailyMessages(), [
    { role: 'system', content: DAILY_CHAT_SYSTEM_PROMPT },
    { role: 'user', content: DAILY_CHAT_PROMPT },
  ])
  assert.deepEqual(buildWebDailyMessages('hello', '   '), [
    { role: 'system', content: DAILY_CHAT_SYSTEM_PROMPT },
    { role: 'user', content: 'hello' },
  ])

  let createBody: Record<string, unknown> | undefined
  const link = 'https://sandbox.example/acp/sync'
  const res = await runWebDailyChat(
    { uid: 'workbuddy:u-intl', accessToken: 'tok' },
    {
      sleep: async () => {},
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === WEB_CONVERSATIONS_URL && method === 'POST') {
          createBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          return Response.json({ code: 0, data: { id: 'conv-sys' } })
        }
        if (url === `${WEB_CONVERSATIONS_URL}conv-sys/session`) {
          return Response.json({ code: 0, data: { link, token: 'st', sessionId: 'acp-1', cwd: '/workspace' } })
        }
        if (url === `${WEB_CONVERSATIONS_URL}conv-sys`) {
          return Response.json({ code: 0, data: { status: 'completed' } })
        }
        if (url === link && method === 'GET') {
          const enc = new TextEncoder()
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(
                  enc.encode(
                    'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n' +
                      'data: {"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}\n',
                  ),
                )
              },
            }),
            { status: 200, headers: { 'Acp-Connection-Id': 'conn-sys' } },
          )
        }
        if (url === link && method === 'POST') {
          return new Response('', { status: 202 })
        }
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    },
  )

  assert.equal(res.ok, true, res.detail)
  assert.ok(createBody !== undefined)
  assert.equal(createBody!.systemPrompt, DAILY_CHAT_SYSTEM_PROMPT)
  assert.deepEqual(createBody!.messages, [
    { role: 'system', content: DAILY_CHAT_SYSTEM_PROMPT },
    { role: 'user', content: 'Hi' },
  ])
})

test('跨模块联合契约：payload 指纹/Schema + client 错误拆分 + continuation/responses + qoder 时区边界', () => {
  // 1. payload: Claude Code official CLI + assistant 污染头 + 双层代理转义 pattern 同请求联调
  const head = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n`
  const prepared = prepareChatBody({
    model: 'deepseek-v4.1-flash',
    parallel_tool_calls: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'open_file',
          parameters: {
            type: 'object',
            properties: {
              filePath: { type: 'string', pattern: '^[^\\\\uD800-\\\\uDFFF]*$' },
            },
          },
        },
      },
    ],
    messages: [
      {
        role: 'system',
        content: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      },
      { role: 'assistant', content: `${head}${head}已准备好执行。` },
      { role: 'user', content: '检查代码' },
    ],
  })
  const parsed = JSON.parse(prepared.body) as Record<string, unknown>
  assert.equal(parsed.parallel_tool_calls, false)
  const msgs = parsed.messages as Array<Record<string, unknown>>
  assert.equal(msgs[0]!.content, `${OFFICIAL_CLI_REPLACEMENT}.`)
  assert.equal(msgs[1]!.content, '已准备好执行。')
  assert.equal(stripInjectedAssistantHead(`${head}单层`), '单层')
  const toolProp = (
    (((parsed.tools as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>)
      .parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
  ).filePath!
  assert.equal('pattern' in toolProp, false)

  // 2. client: 请求级错误不轮转 vs 11158 换号 vs 边缘 HTML 401
  assert.equal(classify(500, '{"code":11353,"msg":"tei failed with status code: [413]"}').kind, 'bad_request')
  assert.equal(shouldRotate('bad_request'), false)
  assert.equal(shouldPunish('bad_request'), false)
  assert.equal(classify(400, '{"code":11158,"msg":"not allowed for user type"}').kind, 'model_denied')
  assert.equal(shouldRotate('model_denied'), true)
  assert.equal(
    isGatewayAuthRejection(401, '<html><head><title>401 Authorization Required</title></head><body>openresty</body></html>'),
    true,
  )

  // 3. continuation & responses
  assert.equal(isBrowserCompleteDirectiveOnly('::browser-complete{title="ok"}'), true)
  assert.equal(
    shouldRescueBrowserComplete({
      finishReason: 'stop',
      text: '::browser-complete{title="ok"}',
      hasDeclaredTools: true,
    }).nudge,
    BROWSER_COMPLETE_NUDGE,
  )
  for (const s of [INTERNAL_NUDGE_PREFIX, CONTINUE_NUDGE, NARRATION_COLON_NUDGE, NARRATION_PROMISE_NUDGE, BROWSER_COMPLETE_NUDGE]) {
    assert.ok(!s.includes('wb2api') && !s.includes('网关'))
  }
  assert.equal(toChatBody({ input: 'hi', parallel_tool_calls: false }, 'm').parallel_tool_calls, false)
  assert.equal(
    toResponsesObject(
      { input: 'hi', parallel_tool_calls: false },
      'm',
      {
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      },
      'r_sync',
    ).parallel_tool_calls,
    false,
  )

  // 4. qoder: UTC+8 自然日陈旧检测
  const refNow = Date.parse('2026-11-25T10:30:00+08:00')
  assert.equal(isQoderClaimedAtStale('2026-11-24T18:00:00Z', refNow), false, '2026-11-24T18:00Z 即北京时间 11-25 02:00，属同一 UTC+8 自然日')
  assert.equal(isQoderClaimedAtToday('2026-11-24T18:00:00Z', refNow), true)
  assert.equal(isQoderClaimedAtStale('2026-11-24T15:59:59Z', refNow), true, '2026-11-24T15:59:59Z 即北京时间 11-24 23:59:59，属前一日')
})
