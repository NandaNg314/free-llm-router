/**
 * MCP 端点与媒体/检索能力的单测。
 *
 * ## 为什么这些断言重要
 *
 * 这一层全是**协议形状**的约束：字段名写错、少回一条响应、把工具错误
 * 报成协议错误 —— 客户端要么直接断连，要么让模型陷入无效重试。
 * 而这些失败**不会在日志里留下明显痕迹**，只能靠测试钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleMcp } from '../src/gateway/mcp.ts'
import { mediaCapable } from '../src/upstream/media.ts'

/** 构造一个假 Env：没有账号池 ⇒ 工具执行会走「没有可用账号」分支。 */
const emptyEnv = {
  ACCOUNT_POOL: {
    idFromName: (n: string) => n,
    get: () => ({
      listAccounts: async () => [],
      getCredential: async () => undefined,
    }),
  },
} as never

function rpc(body: unknown) {
  return new Request('https://x/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('MCP：initialize 回协议版本、工具能力与服务器名', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), emptyEnv)
  assert.ok(res)
  const j = await res.json() as { result: Record<string, unknown> }
  assert.equal(j.result.protocolVersion, '2025-06-18', '⚠️ 客户端要的版本必须原样回')
  assert.deepEqual(j.result.capabilities, { tools: {} })
  assert.equal((j.result.serverInfo as Record<string, unknown>).name, 'free-llm-router')
  assert.equal(typeof j.result.instructions, 'string', '⚠️ instructions 会被塞进模型系统提示')
})

test('MCP：不认识的协议版本回我们最新的（不能原样回，否则客户端断连）', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }), emptyEnv)
  const j = await res!.json() as { result: Record<string, unknown> }
  assert.equal(j.result.protocolVersion, '2025-11-25')
})

test('MCP：通知（无 id）不回响应', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), emptyEnv)
  assert.equal(res, undefined, '⚠️ 通知按规范不得回响应（回了会让部分客户端报协议错）')
})

test('MCP：tools/list 回三个工具，且 schema 合法', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), emptyEnv)
  const j = await res!.json() as { result: { tools: Array<Record<string, unknown>> } }
  const names = j.result.tools.map((t) => t.name)
  assert.deepEqual(names.sort(), ['generate_image', 'web_fetch', 'web_search'])
  for (const t of j.result.tools) {
    // ⚠️ 少 type:'object' / properties 会让客户端的校验器拒绝整份清单
    const schema = t.inputSchema as Record<string, unknown>
    assert.equal(schema.type, 'object', `${String(t.name)} 的 schema 必须 type=object`)
    assert.ok(schema.properties !== undefined, `${String(t.name)} 必须声明 properties`)
    // ⚠️ description 是模型选工具的依据，不能为空
    assert.ok(typeof t.description === 'string' && t.description.length > 20,
      `${String(t.name)} 的 description 要写清「什么时候用它」`)
  }
})

test('🔴 MCP：工具执行失败回 isError=true，而不是 JSON-RPC 错误', async () => {
  // 规范区分：isError = 「工具跑了但失败」（模型能读原因换方案）；
  //          -32602 = 「请求本身不合法」（模型无从补救）。
  // 把「没配账号」报成协议错误，模型只会反复重试同一个调用。
  const res = await handleMcp(
    rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'x' } } }),
    emptyEnv,
  )
  const j = await res!.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown }
  assert.equal(j.error, undefined, '⚠️ 不能回 JSON-RPC error')
  assert.equal(j.result?.isError, true)
  assert.match(j.result?.content?.[0]?.text ?? '', /国际版账号/,
    '⚠️ 错误文案要告诉用户「下一步做什么」（去面板登录国际版）')
})

test('MCP：未知方法回 -32601，GET 回 405 + Allow', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 4, method: 'nope/nope' }), emptyEnv)
  const j = await res!.json() as { error: { code: number } }
  assert.equal(j.error.code, -32601)

  const get = await handleMcp(new Request('https://x/mcp', { method: 'GET' }), emptyEnv)
  assert.equal(get!.status, 405)
  assert.equal(get!.headers.get('Allow'), 'POST', '⚠️ 客户端靠 Allow 头退回纯 POST')
})

test('MCP：资源/提示词回空清单而不是错误（否则部分客户端告警）', async () => {
  for (const m of ['resources/list', 'resources/templates/list', 'prompts/list']) {
    const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 5, method: m }), emptyEnv)
    const j = await res!.json() as { result?: unknown; error?: unknown }
    assert.equal(j.error, undefined, `${m} 不应回错误`)
    assert.notEqual(j.result, undefined)
  }
})

test('🔴 媒体能力按 realm 判：只有国际版有（实测国内 401）', () => {
  // 2026-11-05 实测：国内版 www.workbuddy.cn 的 /agenttool/* 与 /v2/images/*
  // 全部 401（APISIX 网关层拒绝），国际版全部 200。
  // ⚠️ 我第一次用**国内账号**探测就断定「上游不支持」—— 结论是错的。
  //    ⇒ 权限类问题必须每个 realm 各测一次。
  assert.equal(mediaCapable('global'), true)
  assert.equal(mediaCapable('cn'), false)

  // 且端点必须**如实拒绝**，不能悄悄回落成对话
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(/unsupported_realm/.test(src), '⚠️ realm 不支持时必须明确报错')
})

test('🔴 媒体端点必须用 web 域（不跟随 chat 域）', () => {
  // 用 copilot.tencent.com 会得到 404 Route Not Found，极易被误读成
  // 「能力不存在」—— 这正是我第一次探测失败的原因之一。
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(!/bases\.chat\}\$\{path\}/.test(src),
    '⚠️ 不能用 chat 域（那会 404）')
})

test('🔴 媒体端点必须用国际版固定域，不能用 resolveUpstream(env).web', () => {
  // `resolveUpstream(env).web` 的默认值是**国内域** `www.workbuddy.cn`
  // （见 `env.ts` 的 DEFAULT_UPSTREAM）—— 在那里这些端点一律 401。
  // 我第一版就是用了它，线上实测 401 才发现。
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/INTl_WEB_BASE = 'https:\/\/www\.workbuddy\.ai'/.test(src),
    '⚠️ 必须写死国际版域名')
  assert.ok(!/resolveUpstream\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    '⚠️ 不得使用 resolveUpstream（它的 web 默认是国内域）')
  assert.ok(/const base = INTl_WEB_BASE/.test(src), '⚠️ 实际请求必须用这个常量')
})

test('🔴 agenttool 返回「裸对象」而非 code 信封，必须都认（否则静默空结果）', () => {
  // 2026-11-05 实测：
  //   媒体类  /v2/images/*      → {"code":0,"msg":"OK","data":{...}}
  //   agenttool /v1/search     → {"query":"…","type":"text2text","results":[…]}
  //   agenttool /v1/webfetch   → {"url":"…","title":"…","content":"…"}
  //
  // ⚠️ 只读 `envelope.data` 时 agenttool 的 data 是 undefined ⇒ 工具回
  //    「没有找到结果」——**看起来像上游没结果，其实是解析路径错**。
  //    这种静默空结果比报错更难查。
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/envelopeData !== undefined/.test(src), '必须先判 envelope.data')
  assert.ok(/JSON\.parse\(res\.raw\)/.test(src),
    '⚠️ 没有信封时必须回落到解析原始响应体（agenttool 是裸对象）')
})

test('🔴 生图必须带 model（不带时上游回 14401 route config not found）', () => {
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/INTl_IMAGE_MODEL/.test(src), '必须有默认图像模型常量')
  assert.ok(/input\.model \?\? ''\)\.trim\(\) \|\| INTl_IMAGE_MODEL/.test(src),
    '⚠️ 调用方没给 model 时必须填默认值')
  assert.ok(/model,/.test(src), '⚠️ 请求体必须带 model 字段')
})

test('🔴 视频查询必须用 POST /v2/videos/tasks，不是 GET 路径', () => {
  // 2026-11-05 实测：`GET /v2/videos/generations/{id}` 返回
  // `404 page not found`。我第一版按 REST 习惯写的 GET，
  // 结果永远查不到状态 —— 看起来像「视频一直卡在排队」。
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/\/v2\/videos\/tasks/.test(src), '⚠️ 查询路径必须是 /v2/videos/tasks')
  assert.ok(/task_id: taskId/.test(src), '⚠️ 查询要传 task_id（body 里）')
  // 不得出现 GET 形式的按 id 路径拼接
  assert.ok(!/videos\/generations\/\$\{/.test(src),
    '⚠️ 不能用 /v2/videos/generations/{id}（404）')
})

test('🔴 视频提交响应里的任务 id 在 `id` 字段，不是 `task_id`', () => {
  // 实测提交响应：{"data":{"id":"1372715883-WandVideo-…","status":"queued"}}
  // 只认 `task_id` 会把成功提交误判成「没拿到 id」。
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/typeof data\.id === 'string' \? data\.id/.test(src), '⚠️ 必须优先读 data.id')
  assert.ok(/data\.task_id/.test(src), '⚠️ 同时兼容 task_id（上游可能改字段）')
})

test('🔴 视频 failed 必须把上游原话交出去（风控原因）', () => {
  // 实测「真实地点 + 人物」会被拦：
  // {"status":"failed","error":{"message":"Failure to pass the risk control system"}}
  // 笼统报「生成失败」会让用户反复重试同一个 prompt。
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/error: err !== undefined && typeof err\.message === 'string' \? err\.message/.test(src),
    '⚠️ 必须解析 error.message')
  const idx = readFileSync('src/index.ts', 'utf8')
  assert.ok(/\.\.\.\(r\.error === undefined \? \{\} : \{ error: \{ message: r\.error \} \}\)/.test(idx),
    '⚠️ 端点必须把 failed 原因透出去')
})
