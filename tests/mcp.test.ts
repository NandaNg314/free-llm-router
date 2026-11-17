/**
 * MCP 端点与媒体/检索/视频/3D 能力的单测。
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
import type { Env } from '../src/env.ts'
import { createAccountState } from '../src/pool/state.ts'
import { handleMcp } from '../src/gateway/mcp.ts'
import { mediaTaskLedger } from '../src/gateway/media-router.ts'
import { mediaCapable } from '../src/upstream/media.ts'
import { ThreeDCredentialManager } from '../src/upstream/three-d.ts'
import { APP_VERSION } from '../src/version.ts'

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

test('MCP：initialize 回协议版本、工具能力与同步的 APP_VERSION 服务器版本', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), emptyEnv)
  assert.ok(res)
  const j = await res.json() as { result: Record<string, unknown> }
  assert.equal(j.result.protocolVersion, '2025-06-18', '⚠️ 客户端要的版本必须原样回')
  assert.deepEqual(j.result.capabilities, { tools: {} })
  const serverInfo = j.result.serverInfo as Record<string, unknown>
  assert.equal(serverInfo.name, 'free-llm-router')
  assert.equal(serverInfo.version, APP_VERSION, '⚠️ MCP serverInfo.version 必须与 APP_VERSION 同源')
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

test('MCP：tools/list 回全部 7 个工具（含视频与 3D），且 schema 合法', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), emptyEnv)
  const j = await res!.json() as { result: { tools: Array<Record<string, unknown>> } }
  const names = j.result.tools.map((t) => t.name)
  assert.deepEqual(
    names.sort(),
    [
      'generate_3d',
      'generate_image',
      'generate_video',
      'get_3d_task',
      'get_video_task',
      'web_fetch',
      'web_search',
    ],
  )
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

test('MCP：generate_video -> get_video_task 与 generate_3d -> get_3d_task 多号容灾端到端跑通', async () => {
  mediaTaskLedger.clear()
  const now = Date.now()
  const accCooldown = Object.assign(
    createAccountState({ uid: 'u-cooled', nickname: 'cooled', realm: 'global', provider: 'workbuddy' }),
    { until: now + 60_000, coolKind: 'hard' as const, credits: 500 },
  )
  const accBad = Object.assign(
    createAccountState({ uid: 'u-bad', nickname: 'bad', realm: 'global', provider: 'workbuddy' }),
    { credits: 200 },
  )
  const accGood = Object.assign(
    createAccountState({ uid: 'u-good', nickname: 'good', realm: 'global', provider: 'workbuddy' }),
    { credits: 150 },
  )

  const mcpLogs: Array<Record<string, unknown>> = []
  const env = {
    ACCOUNT_POOL: {
      idFromName: (n: string) => n,
      get: (id: unknown) => {
        if (String(id) !== 'global') {
          return { listAccounts: async () => [], getCredential: async () => undefined }
        }
        return {
          listAccounts: async () => [accCooldown, accBad, accGood],
          getCredential: async (uid: string) => ({
            provider: 'workbuddy',
            uid,
            accessToken: `tok_${uid}`,
            refreshToken: '',
            expiresAt: now + 3_600_000,
            nickname: uid,
            extras: { realm: 'global', domain: 'www.workbuddy.ai' },
          }),
          appendLog: async (entry: Record<string, unknown>) => {
            mcpLogs.push(entry)
          },
          recordUsage: async () => {},
          applyFailure: async () => ({ disabled: false }),
          noteSuccess: async () => {},
        }
      },
    },
  } as unknown as Env

  const credMgr = new ThreeDCredentialManager(async (ctx) => ({
    key: `ck_t_${ctx.uid}`,
    expiresAt: now + 900_000,
  }))

  const origFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const h = new Headers(init?.headers)
    const auth = h.get('authorization') ?? ''

    // 第一个健康号 u-bad 故意返回 503，验证 MCP 自动 failover 到 u-good
    if (auth.includes('tok_u-bad') || auth.includes('ck_t_u-bad')) {
      return new Response('Upstream busy', { status: 503 })
    }

    if (url.endsWith('/v2/videos/generations')) {
      assert.equal(h.get('x-client-version'), null, '国际媒体请求绝不能泄漏国内 X-Client-* 三头')
      assert.equal(h.get('origin'), 'https://www.workbuddy.ai', '国际媒体请求 Origin 必须为 www.workbuddy.ai')
      return new Response(JSON.stringify({ code: 0, data: { id: 'mcp-vid-9', status: 'queued' } }), { status: 200 })
    }
    if (url.endsWith('/v2/videos/tasks')) {
      assert.ok(auth.includes('tok_u-good'), 'get_video_task 必须回到原提交账号 u-good 查询')
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            id: 'mcp-vid-9',
            status: 'completed',
            data: [{ url: 'https://v.myqcloud.com/mcp.mp4' }],
            usage: { credit: 42 },
          },
        }),
        { status: 200 },
      )
    }
    if (url.endsWith('/agenttool/v1/tcproxy')) {
      if (h.get('x-tc-action') === 'SubmitHunyuanTo3DProJob') {
        return new Response(
          JSON.stringify({ Response: { JobId: 'mcp-3d-9', Status: 'SUBMITTED' } }),
          { status: 200 },
        )
      }
      assert.ok(auth.includes('ck_t_u-good'), 'get_3d_task 必须回到原提交账号 u-good 查询')
      return new Response(
        JSON.stringify({
          Response: {
            JobId: 'mcp-3d-9',
            Status: 'DONE',
            ResultCreditConsumed: 28,
            ResultFile3Ds: [{ Type: 'GLB', Url: 'https://ai3d.cos.ap-guangzhou.myqcloud.com/mcp.glb' }],
          },
        }),
        { status: 200 },
      )
    }
    return new Response('unexpected', { status: 404 })
  }

  try {
    // 1. generate_video -> get_video_task
    const vSub = await handleMcp(
      rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'generate_video', arguments: { prompt: '星空延时' } } }),
      env,
    )
    const vSubJson = (await vSub!.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.notEqual(vSubJson.result.isError, true)
    assert.match(vSubJson.result.content[0]?.text ?? '', /mcp-vid-9/)

    const vGet = await handleMcp(
      rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_video_task', arguments: { task_id: 'mcp-vid-9' } } }),
      env,
    )
    const vGetJson = (await vGet!.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.notEqual(vGetJson.result.isError, true)
    assert.match(vGetJson.result.content[0]?.text ?? '', /mcp\.mp4/)

    // 2. generate_3d -> get_3d_task
    const dSub = await handleMcp(
      rpc({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'generate_3d', arguments: { prompt: '蒸汽朋克怀表', result_format: 'GLB' } },
      }),
      env,
      undefined,
      { threeDOptions: { credentials: credMgr } },
    )
    const dSubJson = (await dSub!.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.notEqual(dSubJson.result.isError, true)
    assert.match(dSubJson.result.content[0]?.text ?? '', /mcp-3d-9/)

    const dGet = await handleMcp(
      rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_3d_task', arguments: { job_id: 'mcp-3d-9' } } }),
      env,
      undefined,
      { threeDOptions: { credentials: credMgr } },
    )
    const dGetJson = (await dGet!.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    assert.notEqual(dGetJson.result.isError, true)
    assert.match(dGetJson.result.content[0]?.text ?? '', /mcp\.glb/)

    assert.ok(mcpLogs.some((l) => l.type === 'mcp' && l.uid === 'u-good'), 'MCP 调用必须记录命中账号的 type=mcp 日志')
  } finally {
    globalThis.fetch = origFetch
    mediaTaskLedger.clear()
  }
})

test('🔴 媒体能力按 realm 判：只有国际版有（实测国内 401）', () => {
  assert.equal(mediaCapable('global'), true)
  assert.equal(mediaCapable('cn'), false)

  // 媒体路由必须如实拒绝不支持的 realm，不能悄悄回落成对话
  const src = readFileSync('src/gateway/media-router.ts', 'utf8')
  assert.ok(/unsupported_realm/.test(src), '⚠️ realm 不支持时必须明确报错 unsupported_realm')
})

test('🔴 媒体端点必须用 web 域（不跟随 chat 域）', () => {
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(!/bases\.chat\}\$\{path\}/.test(src),
    '⚠️ 不能用 chat 域（那会 404）')
})

test('🔴 媒体端点必须用国际版固定域，不能用 resolveUpstream(env).web', () => {
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/INTl_WEB_BASE = 'https:\/\/www\.workbuddy\.ai'/.test(src),
    '⚠️ 必须写死国际版域名')
  assert.ok(!/resolveUpstream\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    '⚠️ 不得使用 resolveUpstream（它的 web 默认是国内域）')
  assert.ok(/const base = INTl_WEB_BASE/.test(src), '⚠️ 实际请求必须用这个常量')
})

test('🔴 agenttool 返回「裸对象」而非 code 信封，必须都认（否则静默空结果）', () => {
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
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/\/v2\/videos\/tasks/.test(src), '⚠️ 查询路径必须是 /v2/videos/tasks')
  assert.ok(/task_id: taskId/.test(src), '⚠️ 查询要传 task_id（body 里）')
  assert.ok(!/videos\/generations\/\$\{/.test(src),
    '⚠️ 不能用 /v2/videos/generations/{id}（404）')
})

test('🔴 视频提交响应里的任务 id 在 `id` 字段，不是 `task_id`', () => {
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/typeof data\.id === 'string' \? data\.id/.test(src), '⚠️ 必须优先读 data.id')
  assert.ok(/data\.task_id/.test(src), '⚠️ 同时兼容 task_id（上游可能改字段）')
})

test('🔴 视频 failed 必须把上游原话交出去（风控原因）', () => {
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  assert.ok(/error: err !== undefined && typeof err\.message === 'string' \? err\.message/.test(src),
    '⚠️ 必须解析 error.message')
  const routerSrc = readFileSync('src/gateway/media-router.ts', 'utf8')
  assert.ok(/\.\.\.\(r\.error === undefined \? \{\} : \{ error: \{ message: r\.error \} \}\)/.test(routerSrc),
    '⚠️ 媒体路由端点必须把 failed 原因透出去')
})

test('🔴 图生视频必须用 image_url（不是 image），且 extra_parameters 要嵌套', () => {
  const src = readFileSync('src/upstream/media.ts', 'utf8')
  const start = src.indexOf('export async function submitVideo')
  const body = src.slice(start, start + 4000)

  assert.ok(/image_url: input\.image/.test(body), '⚠️ 首帧必须是 image_url')
  assert.ok(/last_image_url: input\.lastImage/.test(body), '⚠️ 尾帧必须是 last_image_url')
  assert.ok(!/\bimage: input\.image/.test(body.replace(/image_url: input\.image/g, '')),
    '⚠️ 不得再用 image（会被上游忽略）')
  assert.ok(/extra_parameters/.test(body), '⚠️ aspect_ratio/resolution 必须嵌在 extra_parameters')

  assert.ok(/if \(!hasImage\) extra\.aspect_ratio/.test(body),
    '⚠️ 图生视频不应传 aspect_ratio')
})
