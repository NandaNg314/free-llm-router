/**
 * v1.2.0 总装集成测试：
 * - 数据面（`/v1/*`、`/mcp`）`Authorization: Bearer` + `x-api-key` 双通道主/子密钥鉴权与防绕过；
 * - 数据面可配置 CORS（`CORS_ORIGINS` + `/admin/config/cors`）、预检 `OPTIONS`、去重防反射与 `/admin/*` 隔离；
 * - `/panel/*` 防搜索引擎收录响应头 `X-Robots-Tag: noindex, nofollow`；
 * - 各新接入协议与模块的端到端路由接线（随模块就位扩充）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNodeRuntime } from '../src/server/env.js'
import { applyCorsHeaders } from '../src/gateway/http.js'
import { resetAuthLimiter } from '../src/gateway/inbound-limit.js'
import { isAutoContinuationEnabled } from '../src/gateway/server.js'
import { workbuddyProvider } from '../src/providers/buddy.js'
import { resolveManualThreeDCredential } from '../src/upstream/three-d.js'
import worker, { resetCorsConfigCache } from '../src/index.js'
import { APP_VERSION } from '../src/version.js'

function dbFile(name: string): string {
  fs.mkdirSync(path.join(process.cwd(), '.build'), { recursive: true })
  return path.join(process.cwd(), '.build', `test-v120-${name}-${process.pid}.db`)
}

function wipe(dbPath: string): void {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
}

function makeCtx(): ExecutionContext & { flush: () => Promise<void> } {
  const tasks: Promise<unknown>[] = []
  return {
    waitUntil(p: Promise<unknown>) {
      tasks.push(p)
    },
    passThroughOnException() {},
    props: {},
    async flush() {
      await Promise.allSettled(tasks.splice(0))
    },
  } as unknown as ExecutionContext & { flush: () => Promise<void> }
}

test('x-api-key 鉴权：主密钥与子密钥在 /v1/* 与 /mcp 均生效，管理面 /admin/* 拒绝 x-api-key 与子密钥', async () => {
  const dbPath = dbFile('x-api-key')
  wipe(dbPath)
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'master-secret-key-v120-test'

  try {
    const ctx = makeCtx()

    // 1. 创建一把受限子密钥（限额 2 次请求，仅允许 IP 203.0.113.10）
    const createRes = await worker.fetch(
      new Request('http://localhost/admin/apikeys', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'claude-code-subkey',
          limits: {
            maxRequests: 2,
            maxTokens: 0,
            windowHours: 24,
            models: ['deepseek-v4.1-flash'],
            allowedIps: ['203.0.113.10'],
            expiresAt: 0,
          },
        }),
      }),
      env,
      ctx,
    )
    assert.equal(createRes.status, 200)
    const created = (await createRes.json()) as { key: string; record: { id: string } }
    assert.ok(created.key.startsWith('sk-'))

    // 2. 主密钥仅凭 x-api-key 可调 /mcp（无需 Authorization: Bearer）
    const mcpAdminRes = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'x-api-key': env.API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      env,
      ctx,
    )
    assert.equal(mcpAdminRes.status, 200)
    assert.deepEqual(await mcpAdminRes.json(), { jsonrpc: '2.0', id: 1, result: {} })

    // 3. 管理面 /admin/* 绝不接受 x-api-key（哪怕填的是主密钥明文）
    const adminViaXKey = await worker.fetch(
      new Request('http://localhost/admin/pool', {
        headers: { 'x-api-key': env.API_KEY },
      }),
      env,
      ctx,
    )
    assert.equal(adminViaXKey.status, 401, '/admin/* 只认 Authorization: Bearer 主密钥')

    // 4. 子密钥凭 x-api-key 访问 /mcp：来源 IP 不在白名单 ⇒ 403
    const mcpWrongIp = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'x-api-key': created.key,
          'cf-connecting-ip': '198.51.100.99',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      }),
      env,
      ctx,
    )
    assert.equal(mcpWrongIp.status, 403)

    // 5. 子密钥凭 x-api-key 且 IP 合法 ⇒ /mcp 放行并记 1 次请求（1/2）
    const mcpSubkeyOk = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'x-api-key': created.key,
          'cf-connecting-ip': '203.0.113.10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      }),
      env,
      ctx,
    )
    assert.equal(mcpSubkeyOk.status, 200)
    await ctx.flush()

    // 6. 子密钥凭 x-api-key 调 /v1/chat/completions 但模型不在白名单 ⇒ 403（已占第 2 次名额 2/2）
    const chatDeniedModel = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          'x-api-key': created.key,
          'cf-connecting-ip': '203.0.113.10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'forbidden-model',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(chatDeniedModel.status, 403)
    await ctx.flush()

    // 7. 第 3 次请求触发 maxRequests=2 配额上限 ⇒ 429
    const overQuota = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'x-api-key': created.key,
          'cf-connecting-ip': '203.0.113.10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
      }),
      env,
      ctx,
    )
    assert.equal(overQuota.status, 429)

    // 8. 防绕过：同时带错误 Bearer 与合法 x-api-key 时绝不回退试第二个头 ⇒ 401
    const dualHeaderAttempt = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'x-api-key': env.API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }),
      }),
      env,
      ctx,
    )
    assert.equal(dualHeaderAttempt.status, 401)
  } finally {
    rt.db.close()
    wipe(dbPath)
  }
})

test('CORS：默认关闭、白名单/通配预检、错误响应附带头、去重防凭证反射，且绝不外溢到 /admin/*', async () => {
  const dbPath = dbFile('cors')
  wipe(dbPath)
  resetCorsConfigCache()
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'cors-test-master-key'
  const ctx = makeCtx()

  try {
    // 1. 默认未配 CORS_ORIGINS：预检直接 403 origin_not_allowed
    const preflightDefault = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
        },
      }),
      env,
      ctx,
    )
    assert.equal(preflightDefault.status, 403)
    assert.equal(preflightDefault.headers.get('access-control-allow-origin'), null)

    // 2. 配置域名白名单（含尾斜杠归一化）：命中回 204，未命中或 Origin: null 回 403
    env.CORS_ORIGINS = 'https://App.Example.com/, http://localhost:3000'
    const preflightAllowed = await worker.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-api-key, anthropic-version, anthropic-beta, content-type',
        },
      }),
      env,
      ctx,
    )
    assert.equal(preflightAllowed.status, 204)
    assert.equal(preflightAllowed.headers.get('access-control-allow-origin'), 'https://app.example.com')
    assert.equal(preflightAllowed.headers.get('access-control-allow-credentials'), null)
    const allowHeaders = (preflightAllowed.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const h of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'mcp-session-id']) {
      assert.ok(allowHeaders.includes(h), `预检 Allow-Headers 应包含 ${h}`)
    }

    const preflightNull = await worker.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'OPTIONS',
        headers: { origin: 'null', 'access-control-request-method': 'POST' },
      }),
      env,
      ctx,
    )
    assert.equal(preflightNull.status, 403, '白名单模式下必须拒绝 Origin: null')

    // 3. 401 错误响应在白名单命中时也必须附带 Access-Control-Allow-Origin（让浏览器拿到真实报错）
    const unauthWithOrigin = await worker.fetch(
      new Request('http://localhost/v1/models', {
        headers: { origin: 'http://localhost:3000' },
      }),
      env,
      ctx,
    )
    assert.equal(unauthWithOrigin.status, 401)
    assert.equal(unauthWithOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3000')
    assert.equal(unauthWithOrigin.headers.get('access-control-allow-credentials'), null)

    // 4. 运行时通过 /admin/config/cors 动态切换为 `*`：回字面量 `*`（绝不反射 Origin），且 /admin/* 不带 CORS 头
    const badCorsRes = await worker.fetch(
      new Request('http://localhost/admin/config/cors', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ origins: ['null'] }),
      }),
      env,
      ctx,
    )
    assert.equal(badCorsRes.status, 400, '非法来源 null 应被管理端点明确拒绝')

    const setWildcardRes = await worker.fetch(
      new Request('http://localhost/admin/config/cors', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: true, origins: ['*'], maxAge: 1200 }),
      }),
      env,
      ctx,
    )
    assert.equal(setWildcardRes.status, 200)

    const mcpWildcard = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://any-client.example.org',
          'access-control-request-method': 'POST',
        },
      }),
      env,
      ctx,
    )
    assert.equal(mcpWildcard.status, 204)
    assert.equal(mcpWildcard.headers.get('access-control-allow-origin'), '*', '通配模式必须回字面量 * 而非反射请求 Origin')
    assert.equal(mcpWildcard.headers.get('access-control-max-age'), '1200')

    const adminWithOrigin = await worker.fetch(
      new Request('http://localhost/admin/pool', {
        headers: {
          authorization: `Bearer ${env.API_KEY}`,
          origin: 'https://any-client.example.org',
        },
      }),
      env,
      ctx,
    )
    assert.equal(adminWithOrigin.status, 200)
    assert.equal(adminWithOrigin.headers.get('access-control-allow-origin'), null, '/admin/* 严禁暴露 CORS 头')

    // 5. 重复头与 Allow-Credentials 剥离验证（176e496 同型回归）
    const dirtyUpstream = new Response('ok', {
      status: 200,
      headers: {
        'access-control-allow-origin': 'https://legacy.example.com',
        'access-control-allow-credentials': 'true',
        vary: 'Accept-Encoding, Origin',
      },
    })
    const deduped = applyCorsHeaders(
      dirtyUpstream,
      new Request('http://localhost/v1/models', { headers: { origin: 'https://legacy.example.com' } }),
      ['https://legacy.example.com'],
    )
    assert.equal(deduped.headers.get('access-control-allow-origin'), 'https://legacy.example.com')
    assert.equal(deduped.headers.get('access-control-allow-credentials'), null)
    assert.equal(deduped.headers.get('vary'), 'Accept-Encoding, Origin')
  } finally {
    resetCorsConfigCache()
    rt.db.close()
    wipe(dbPath)
  }
})

test('/panel/* 全部响应携带 X-Robots-Tag: noindex, nofollow 防公网爬虫收录', async () => {
  const dbPath = dbFile('robots')
  wipe(dbPath)
  const rt = createNodeRuntime(dbPath)
  const ctx = makeCtx()
  try {
    for (const p of ['/panel/', '/panel/index.html', '/panel/non-existent.js', '/panel', '/login']) {
      const res = await worker.fetch(new Request(`http://localhost${p}`), rt.env, ctx)
      assert.equal(
        res.headers.get('x-robots-tag'),
        'noindex, nofollow',
        `路径 ${p} 应返回 X-Robots-Tag: noindex, nofollow`,
      )
    }
  } finally {
    rt.db.close()
    wipe(dbPath)
  }
})

test('Anthropic /v1/messages 与 count_tokens：子密钥 x-api-key 白名单拦截、流式/非流式转换与缓存 token 口径', async () => {
  const dbPath = dbFile('messages-e2e')
  wipe(dbPath)
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'msg-e2e-admin'
  env.CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64')
  env.UPSTREAM_CHAT_BASE = 'https://mock-buddy.example.com'
  const ctx = makeCtx()
  const origFetch = globalThis.fetch

  try {
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    await cnPool.createAccount({ uid: 'u_msg_1', nickname: 'MsgAcc', realm: 'cn', provider: 'buddy' }, now)
    await cnPool.putCredential(
      'u_msg_1',
      {
        provider: 'buddy',
        uid: 'u_msg_1',
        accessToken: 'tok_msg_1',
        refreshToken: 'ref_msg_1',
        expiresAt: now + 3_600_000,
        nickname: 'MsgAcc',
        extras: { realm: 'cn', domain: 'copilot.tencent.com', enterpriseId: '' },
      },
      now,
    )

    // 签发仅允许 claude-sonnet-4-6 的子密钥
    const keyRes = await worker.fetch(
      new Request('http://localhost/admin/apikeys', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'cc-subkey',
          limits: { maxRequests: 20, maxTokens: 50_000, windowHours: 24, models: ['claude-sonnet-4-6'], allowedIps: [], expiresAt: 0 },
        }),
      }),
      env,
      ctx,
    )
    const { key: subKey } = (await keyRes.json()) as { key: string }

    // 1. count_tokens（x-api-key，支持 /v1/messages/count_tokens 与 /messages/count_tokens）
    const countOk = await worker.fetch(
      new Request('http://localhost/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'x-api-key': subKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          system: 'You are Claude Code.',
          messages: [{ role: 'user', content: '请计算上下文长度' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(countOk.status, 200)
    const countBody = (await countOk.json()) as { input_tokens: number }
    assert.ok(countBody.input_tokens > 0)

    // 2. 子密钥请求未授权模型 ⇒ 返回 Anthropic 标准 403 permission_error
    const msgForbidden = await worker.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': subKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(msgForbidden.status, 403)
    const errJson = (await msgForbidden.json()) as { type: string; error: { type: string } }
    assert.equal(errJson.type, 'error')
    assert.equal(errJson.error.type, 'permission_error')

    // 3. Mock 上游 SSE（含缓存命中 prompt_tokens=100, cached_tokens=60 ⇒ Anthropic input_tokens 必须为 40）
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://mock-buddy.example.com/v2/chat/completions')) {
        const sse = [
          'data: {"id":"chatcmpl_m1","choices":[{"index":0,"delta":{"reasoning_content":"先思考..."},"finish_reason":null}]}',
          'data: {"id":"chatcmpl_m1","choices":[{"index":0,"delta":{"content":"你好，我是总装网关。"},"finish_reason":"stop"}]}',
          'data: {"id":"chatcmpl_m1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":60}}}',
          'data: [DONE]',
          '',
        ].join('\n\n')
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const msgRes = await worker.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': subKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          stream: false,
          messages: [{ role: 'user', content: '你好' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(msgRes.status, 200)
    const msgJson = (await msgRes.json()) as {
      type: string
      content: Array<{ type: string; text?: string; thinking?: string }>
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
    }
    assert.equal(msgJson.type, 'message')
    assert.equal(msgJson.usage.input_tokens, 40, 'Anthropic input_tokens 必须扣除缓存命中避免虚抬上下文')
    assert.equal(msgJson.usage.cache_read_input_tokens, 60)
    assert.equal(msgJson.usage.output_tokens, 12)
    assert.ok(msgJson.content.some((b) => b.type === 'thinking' && b.thinking === '先思考...'))
    assert.ok(msgJson.content.some((b) => b.type === 'text' && b.text === '你好，我是总装网关。'))
    await ctx.flush()
  } finally {
    globalThis.fetch = origFetch
    rt.db.close()
    wipe(dbPath)
  }
})

test('混元 3D 路由、子密钥白名单、MCP 7 工具发现与 /admin/media/proxy 防 SSRF / 防 302 跳板', async () => {
  const dbPath = dbFile('3d-mcp-proxy')
  wipe(dbPath)
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = '3d-admin-key'
  env.CREDENTIAL_KEY = Buffer.alloc(32, 9).toString('base64')
  env.UPSTREAM_CHAT_BASE = 'https://mock-3d.example.com'
  const ctx = makeCtx()
  const origFetch = globalThis.fetch

  try {
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    await cnPool.createAccount({ uid: 'u_3d_1', nickname: '3DAcc', realm: 'cn', provider: 'buddy' }, now)
    await cnPool.updateBalance('u_3d_1', now, { credits: 500, expiring: 100, earliestExpiry: now + 86_400_000 })
    await cnPool.putCredential(
      'u_3d_1',
      {
        provider: 'buddy',
        uid: 'u_3d_1',
        accessToken: 'oauth_tok_3d_1',
        refreshToken: 'ref_3d_1',
        expiresAt: now + 3_600_000,
        nickname: '3DAcc',
        extras: { realm: 'cn', domain: 'copilot.tencent.com', enterpriseId: '' },
      },
      now,
    )

    // 1. MCP initialize 暴露当前版本号，tools/list 完整暴露 7 个工具
    const mcpInit = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      }),
      env,
      ctx,
    )
    const initJson = (await mcpInit.json()) as { result: { serverInfo: { version: string } } }
    assert.equal(initJson.result.serverInfo.version, APP_VERSION)

    const mcpTools = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
      env,
      ctx,
    )
    const toolsJson = (await mcpTools.json()) as { result: { tools: Array<{ name: string }> } }
    const toolNames = toolsJson.result.tools.map((t) => t.name)
    for (const expected of ['web_search', 'web_fetch', 'generate_image', 'generate_video', 'get_video_task', 'generate_3d', 'get_3d_task']) {
      assert.ok(toolNames.includes(expected), `MCP 应暴露工具 ${expected}`)
    }

    // 2. 受限子密钥（仅放行 chat 模型）调 /v1/3d/generations 必须 403 拦截
    const chatOnlyKeyRes = await worker.fetch(
      new Request('http://localhost/admin/apikeys', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'chat-only',
          limits: { maxRequests: 10, maxTokens: 0, windowHours: 24, models: ['deepseek-v4.1-flash'], allowedIps: [], expiresAt: 0 },
        }),
      }),
      env,
      ctx,
    )
    const { key: chatOnlyKey } = (await chatOnlyKeyRes.json()) as { key: string }
    const denied3d = await worker.fetch(
      new Request('http://localhost/v1/3d/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${chatOnlyKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '一个小机器人' }),
      }),
      env,
      ctx,
    )
    assert.equal(denied3d.status, 403)

    // 3. 混元 3D 端到端：自动换取 ck_t_ 临时云凭证 → Submit → POST /v1/3d/tasks + GET /v1/3d/:jobId 幂等单次扣积分
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'https://mock-3d.example.com/v2/api-keys') {
        return Response.json({
          code: 0,
          msg: 'ok',
          data: { key: 'ck_t_temp_secret_12345', expires_at: Math.floor((Date.now() + 600_000) / 1000) },
        })
      }
      if (url === 'https://mock-3d.example.com/agenttool/v1/tcproxy') {
        const headers = new Headers(init?.headers)
        const action = headers.get('x-tc-action')
        assert.match(headers.get('authorization') ?? '', /^TC3-HMAC-SHA256 Credential=hy-3d\.ck_t_temp_secret_12345\//)
        if (action === 'SubmitHunyuanTo3DProJob') {
          return Response.json({ Response: { JobId: 'job_3d_9001', RequestId: 'req_submit_1' } })
        }
        if (action === 'QueryHunyuanTo3DProJob') {
          return Response.json({
            Response: {
              Status: 'DONE',
              RequestId: 'req_query_1',
              ResultFile3Ds: [
                {
                  Type: 'GLB',
                  Url: 'https://ai3d-125000.cos.ap-guangzhou.myqcloud.com/out/mesh.glb',
                  PreviewImageUrl: 'https://ai3d-125000.cos.ap-guangzhou.myqcloud.com/out/preview.png',
                },
              ],
              ResultCreditConsumed: 15,
            },
          })
        }
      }
      if (url === 'https://ai3d-125000.cos.ap-guangzhou.myqcloud.com/redirect-internal.glb') {
        // 模拟 302 重定向（redirect: 'error' 下原生 fetch 会拒绝，此处模拟 TypeError）
        if (init?.redirect === 'error') {
          throw new TypeError('fetch failed: redirect mode is set to error')
        }
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const submitRes = await worker.fetch(
      new Request('http://localhost/v1/3d/generations?realm=cn', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '一把蒸汽朋克单手剑', model: '3.1', result_format: 'GLB', enable_pbr: true }),
      }),
      env,
      ctx,
    )
    assert.equal(submitRes.status, 200)
    const submitted = (await submitRes.json()) as { job_id: string; status: string }
    assert.equal(submitted.job_id, 'job_3d_9001')

    const poll1 = await worker.fetch(
      new Request('http://localhost/v1/3d/tasks', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: 'job_3d_9001' }),
      }),
      env,
      ctx,
    )
    assert.equal(poll1.status, 200)
    const poll1Json = (await poll1.json()) as { status: string; usage?: { credit?: number }; result_files?: Array<{ Type?: string }> }
    assert.equal(poll1Json.status, 'DONE')
    assert.equal(poll1Json.usage?.credit, 15)
    assert.equal(poll1Json.result_files?.[0]?.Type, 'GLB')
    await ctx.flush()

    const accAfter1 = await cnPool.getAccount('u_3d_1')
    assert.equal(accAfter1?.credits, 485, '首次查询终态扣减 15 积分（500 -> 485）')

    // 重复用 GET /v1/3d/:jobId 查询同一任务：绝不二次扣减积分！
    const poll2 = await worker.fetch(
      new Request('http://localhost/v1/3d/job_3d_9001', {
        headers: { authorization: `Bearer ${env.API_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(poll2.status, 200)
    await ctx.flush()
    const accAfter2 = await cnPool.getAccount('u_3d_1')
    assert.equal(accAfter2?.credits, 485, '幂等锁必须保证重复查询不重复扣积分')

    // 4. /admin/media/proxy 拒绝外域且拦截 302 跳板重定向
    const badHostProxy = await worker.fetch(
      new Request('http://localhost/admin/media/proxy?url=https://evil-myqcloud.com/a.glb', {
        headers: { authorization: `Bearer ${env.API_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(badHostProxy.status, 400)

    const redirectProxy = await worker.fetch(
      new Request(
        `http://localhost/admin/media/proxy?url=${encodeURIComponent('https://ai3d-125000.cos.ap-guangzhou.myqcloud.com/redirect-internal.glb')}`,
        { headers: { authorization: `Bearer ${env.API_KEY}` } },
      ),
      env,
      ctx,
    )
    assert.equal(redirectProxy.status, 502, 'COS 302 重定向必须被 redirect:error 阻断')
  } finally {
    globalThis.fetch = origFetch
    rt.db.close()
    wipe(dbPath)
  }
})

test('运营活动 /admin/campaign 与 /admin/campaign/claim：路径注入拦截、进度合并与默认 dryRun 安全闸门', async () => {
  const dbPath = dbFile('campaign-e2e')
  wipe(dbPath)
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'campaign-admin-key'
  env.CREDENTIAL_KEY = Buffer.alloc(32, 11).toString('base64')
  env.UPSTREAM_CHAT_BASE = 'https://mock-campaign.example.com'
  const ctx = makeCtx()
  const origFetch = globalThis.fetch
  const postCalls: string[] = []

  try {
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    await cnPool.createAccount({ uid: 'u_camp_1', nickname: 'CampAcc', realm: 'cn', provider: 'buddy' }, now)
    await cnPool.putCredential(
      'u_camp_1',
      {
        provider: 'buddy',
        uid: 'u_camp_1',
        accessToken: 'tok_camp_1',
        refreshToken: 'ref_camp_1',
        expiresAt: now + 3_600_000,
        nickname: 'CampAcc',
        extras: { realm: 'cn', domain: 'copilot.tencent.com', enterpriseId: '' },
      },
      now,
    )

    // 1. 非法 code 路径穿越立即 400 拦截
    const badSpec = await worker.fetch(
      new Request('http://localhost/admin/campaign?code=../secret', {
        headers: { authorization: `Bearer ${env.API_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(badSpec.status, 400)

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST') postCalls.push(url)

      if (url.includes('/portal/activity/config?activity_code=campaign_starbucks_2026')) {
        return Response.json({ code: 0, msg: 'ok', data: { title: '星巴克联名活动', in_period: true } })
      }
      if (url.includes('/portal/activity/tasks?activity_code=campaign_starbucks_2026')) {
        return Response.json({
          code: 0,
          msg: 'ok',
          data: {
            tasks: [
              { id: 1, task_code: 'sb_chat_3', task_name: '完成 3 次对话', target: 3, reward_desc: '中杯券' },
              { id: 2, task_code: 'sb_done_claimed', task_name: '首次登录', target: 1, reward_desc: '贴纸' },
            ],
            progress: [
              { task_code: 'sb_chat_3', progress: 3, status: 'completed', claimed_at: '' },
              { task_code: 'sb_done_claimed', progress: 1, status: 'claimed', claimed_at: '2026-11-17T08:00:00Z' },
            ],
          },
        })
      }
      if (url.includes('/portal/activity/vouchers?activity_code=campaign_starbucks_2026')) {
        return Response.json({ code: 0, msg: 'ok', data: { vouchers: [] } })
      }
      if (url.includes('/portal/activity/tasks/sb_chat_3/viewed')) {
        return Response.json({ code: 0, msg: 'ok', data: {} })
      }
      if (url.includes('/portal/activity/tasks/sb_chat_3/claim')) {
        return Response.json({
          code: 0,
          msg: 'ok',
          data: { voucher_code: 'SBUX-8888', reward_type: 'coupon', reward_desc: '中杯券' },
        })
      }
      throw new Error(`unexpected campaign fetch: ${method} ${url}`)
    }

    // 2. GET /admin/campaign 正确合并独立 progress[] 并识别 ready 任务
    const snapRes = await worker.fetch(
      new Request('http://localhost/admin/campaign', {
        headers: { authorization: `Bearer ${env.API_KEY}` },
      }),
      env,
      ctx,
    )
    assert.equal(snapRes.status, 200)
    const snapJson = (await snapRes.json()) as {
      accounts: Array<{ uid: string; snapshot: { ready: string[]; claimed: string[] } }>
    }
    assert.deepEqual(snapJson.accounts[0]?.snapshot.ready, ['sb_chat_3'])
    assert.deepEqual(snapJson.accounts[0]?.snapshot.claimed, ['sb_done_claimed'])

    // 3. POST /admin/campaign/claim 不传 dryRun 时默认 dryRun=true，零写请求！
    const dryClaimRes = await worker.fetch(
      new Request('http://localhost/admin/campaign/claim', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
      ctx,
    )
    assert.equal(dryClaimRes.status, 200)
    const dryClaimJson = (await dryClaimRes.json()) as {
      dryRun: boolean
      accounts: Array<{ wouldClaim: string[]; claimed: string[] }>
    }
    assert.equal(dryClaimJson.dryRun, true)
    assert.deepEqual(dryClaimJson.accounts[0]?.wouldClaim, ['sb_chat_3'])
    assert.deepEqual(dryClaimJson.accounts[0]?.claimed, [])
    assert.equal(postCalls.length, 0, 'dryRun 默认模式下严禁向活动接口发送任何 POST 请求')

    // 4. 显式 dryRun: false 时依次发送 viewed + claim 并返回奖券码
    const realClaimRes = await worker.fetch(
      new Request('http://localhost/admin/campaign/claim', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false, gapMs: 0 }),
      }),
      env,
      ctx,
    )
    assert.equal(realClaimRes.status, 200)
    const realClaimJson = (await realClaimRes.json()) as {
      dryRun: boolean
      accounts: Array<{ claimed: string[]; results: Array<{ voucherCode: string }> }>
    }
    assert.equal(realClaimJson.dryRun, false)
    assert.deepEqual(realClaimJson.accounts[0]?.claimed, ['sb_chat_3'])
    assert.equal(realClaimJson.accounts[0]?.results[0]?.voucherCode, 'SBUX-8888')
    assert.equal(postCalls.length, 2, '真实领奖应先 viewed 再 claim 共 2 次 POST')
  } finally {
    globalThis.fetch = origFetch
    rt.db.close()
    wipe(dbPath)
  }
})

test('会话粘性 callerScope 子密钥隔离 + 流式截断自动续写（autoContinuation）无缝拼流', async () => {
  const dbPath = dbFile('sticky-and-cont')
  wipe(dbPath)
  resetCorsConfigCache()
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'sticky-cont-admin'
  env.CREDENTIAL_KEY = Buffer.alloc(32, 13).toString('base64')
  env.UPSTREAM_CHAT_BASE = 'https://mock-cont.example.com'
  const ctx = makeCtx()
  const origFetch = globalThis.fetch

  try {
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const now = Date.now()
    for (const uid of ['u_acc_a', 'u_acc_b']) {
      await cnPool.createAccount({ uid, nickname: uid, realm: 'cn', provider: 'buddy' }, now)
      await cnPool.putCredential(
        uid,
        {
          provider: 'buddy',
          uid,
          accessToken: `tok_${uid}`,
          refreshToken: `ref_${uid}`,
          expiresAt: now + 3_600_000,
          nickname: uid,
          extras: { realm: 'cn', domain: 'copilot.tencent.com', enterpriseId: '' },
        },
        now,
      )
    }

    // 创建两把子密钥验证相同 conversation_id 在不同子密钥下互不串号
    const mkSub = async (name: string): Promise<string> => {
      const r = await worker.fetch(
        new Request('http://localhost/admin/apikeys', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            limits: { maxRequests: 50, maxTokens: 0, windowHours: 24, models: [], allowedIps: [], expiresAt: 0 },
          }),
        }),
        env,
        ctx,
      )
      return ((await r.json()) as { key: string }).key
    }
    const subA = await mkSub('team-a')
    const subB = await mkSub('team-b')

    let callSeq = 0
    const seenAuthHeaders: string[] = []
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      callSeq += 1
      const h = new Headers(init?.headers)
      seenAuthHeaders.push(h.get('authorization') ?? '')
      const sse = [
        `data: {"id":"cmpl_${callSeq}","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
        'data: {"id":"cmpl_u","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    // 子密钥 A 发起带 conversation_id='shared-conv' 的请求 → 绑定账号 1
    const rA1 = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${subA}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'buddy/deepseek-v4.1-flash',
          conversation_id: 'shared-conv',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(rA1.status, 200)
    await ctx.flush()

    // 子密钥 B 紧接着用相同 conversation_id='shared-conv' 请求：因掺入 subkey 作用域，不受 A 的粘性干扰，轮转到另一账号！
    const rB1 = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${subB}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'buddy/deepseek-v4.1-flash',
          conversation_id: 'shared-conv',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(rB1.status, 200)
    await ctx.flush()
    assert.notEqual(seenAuthHeaders[0], seenAuthHeaders[1], '不同子密钥发送相同 conversation_id 应分槽落不同账号')

    // 开启 autoContinuation 后验证截断流自动无缝续写
    const enableCont = await worker.fetch(
      new Request('http://localhost/admin/config/routing', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ autoContinuation: true }),
      }),
      env,
      ctx,
    )
    assert.equal(enableCont.status, 200)

    let segCalls = 0
    globalThis.fetch = async () => {
      segCalls += 1
      if (segCalls === 1) {
        const seg1 = [
          'data: {"id":"cmpl_cont","choices":[{"index":0,"delta":{"content":"前半截代码；"},"finish_reason":null}]}',
          'data: {"id":"cmpl_cont","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
          'data: {"id":"cmpl_cont","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":32000}}',
          'data: [DONE]',
          '',
        ].join('\n\n')
        return new Response(seg1, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const seg2 = [
        'data: {"id":"cmpl_cont_2","choices":[{"index":0,"delta":{"content":"后半截完整收尾。"},"finish_reason":null}]}',
        'data: {"id":"cmpl_cont_2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: {"id":"cmpl_cont_2","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":18}}',
        'data: [DONE]',
        '',
      ].join('\n\n')
      return new Response(seg2, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }

    const contRes = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'buddy/deepseek-v4.1-flash',
          max_tokens: 32000,
          stream: false,
          messages: [{ role: 'user', content: '请生成完整代码' }],
        }),
      }),
      env,
      ctx,
    )
    assert.equal(contRes.status, 200)
    const contJson = (await contRes.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>
    }
    assert.equal(segCalls, 2, '应自动触发第 2 段续写请求')
    assert.equal(contJson.choices[0]?.message.content, '前半截代码；后半截完整收尾。')
    assert.equal(contJson.choices[0]?.finish_reason, 'stop')
    await ctx.flush()
  } finally {
    globalThis.fetch = origFetch
    resetCorsConfigCache()
    rt.db.close()
    wipe(dbPath)
  }
})

test('受限子密钥安全闭环：/mcp 媒体与 3D 工具（含 JSON-RPC 批处理）及 /v1/3d/generations 伪造模型名均返回 403', async () => {
  const dbPath = dbFile('mcp-subkey-acl')
  wipe(dbPath)
  resetAuthLimiter()
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'mcp-acl-admin-key'
  env.CREDENTIAL_KEY = Buffer.alloc(32, 19).toString('base64')
  const ctx = makeCtx()

  try {
    const keyRes = await worker.fetch(
      new Request('http://localhost/admin/apikeys', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'chat-only-subkey',
          limits: {
            maxRequests: 50,
            maxTokens: 0,
            windowHours: 24,
            models: ['deepseek-v4.1-flash'],
            allowedIps: [],
            expiresAt: 0,
          },
        }),
      }),
      env,
      ctx,
    )
    const { key: chatOnlyKey } = (await keyRes.json()) as { key: string }

    // 1. POST /v1/3d/generations 传入已被子密钥允许的对话模型名，绝不能穿过 checkMediaSubkeyModel 落到 400
    const spoof3d = await worker.fetch(
      new Request('http://localhost/v1/3d/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${chatOnlyKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '一个小方块', model: 'deepseek-v4.1-flash' }),
      }),
      env,
      ctx,
    )
    assert.equal(spoof3d.status, 403)

    // 2. POST /mcp tools/call 调用生图 / 生视频 / 生 3D 均被 403 permission_error 拦截
    for (const toolName of ['generate_image', 'generate_video', 'get_video_task', 'generate_3d', 'get_3d_task']) {
      const mcpDenied = await worker.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'x-api-key': chatOnlyKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: toolName, arguments: { prompt: 'test', model: 'deepseek-v4.1-flash', job_id: 'j1', task_id: 't1' } },
          }),
        }),
        env,
        ctx,
      )
      assert.equal(mcpDenied.status, 403, `chatOnlyKey 调 /mcp ${toolName} 必须返回 403`)
      const errBody = (await mcpDenied.json()) as { error?: { type?: string } }
      assert.equal(errBody.error?.type, 'permission_error')
    }

    // 3. JSON-RPC 数组批处理夹带受限工具同样被 403 拦截
    const batchDenied = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${chatOnlyKey}`, 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_3d', arguments: { prompt: 'x' } } },
        ]),
      }),
      env,
      ctx,
    )
    assert.equal(batchDenied.status, 403)

    // 4. tools/list 对 chatOnlyKey 自动隐藏未授权的生图/视频/3D 工具，保留 web_search / web_fetch
    const listRes = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${chatOnlyKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      }),
      env,
      ctx,
    )
    assert.equal(listRes.status, 200)
    const listBody = (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
    const visibleNames = listBody.result.tools.map((t) => t.name)
    assert.deepEqual(visibleNames, ['web_search', 'web_fetch'])
  } finally {
    rt.db.close()
    wipe(dbPath)
  }
})

test('跨 Isolate 与容器重启持久化：CORS 白名单与 autoContinuation 开关落盘于 AccountPoolDO', async () => {
  const dbPath = dbFile('do-persist-cors-cont')
  wipe(dbPath)
  resetCorsConfigCache()
  const ctx = makeCtx()

  // Isolate A：写入运行时 CORS 与 autoContinuation=true 后关闭内存态
  const rt1 = createNodeRuntime(dbPath)
  rt1.env.API_KEY = 'persist-admin-key'
  try {
    const saveCors = await worker.fetch(
      new Request('http://localhost/admin/config/cors', {
        method: 'POST',
        headers: { authorization: `Bearer ${rt1.env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, origins: ['https://persisted.example.com'], maxAge: 900 }),
      }),
      rt1.env,
      ctx,
    )
    assert.equal(saveCors.status, 200)

    const saveRouting = await worker.fetch(
      new Request('http://localhost/admin/config/routing', {
        method: 'POST',
        headers: { authorization: `Bearer ${rt1.env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ autoContinuation: true }),
      }),
      rt1.env,
      ctx,
    )
    assert.equal(saveRouting.status, 200)
  } finally {
    rt1.db.close()
  }

  // 清空模块级缓存并基于同一 SQLite 重新拉起全新运行时（模拟新 Workers Isolate / 容器重启）
  resetCorsConfigCache()
  const rt2 = createNodeRuntime(dbPath)
  rt2.env.API_KEY = 'persist-admin-key'
  try {
    const preflight = await worker.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://persisted.example.com',
          'access-control-request-method': 'POST',
        },
      }),
      rt2.env,
      ctx,
    )
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://persisted.example.com')
    assert.equal(preflight.headers.get('access-control-max-age'), '900')

    const getRouting = await worker.fetch(
      new Request('http://localhost/admin/config/routing', {
        headers: { authorization: `Bearer ${rt2.env.API_KEY}` },
      }),
      rt2.env,
      ctx,
    )
    const routingJson = (await getRouting.json()) as { config: { autoContinuation: boolean } }
    assert.equal(routingJson.config.autoContinuation, true)
    assert.equal(await isAutoContinuationEnabled(rt2.env), true)

    // 重置回环境变量（resetToEnv: true & autoContinuation: null）同样持久化生效
    await worker.fetch(
      new Request('http://localhost/admin/config/cors', {
        method: 'POST',
        headers: { authorization: `Bearer ${rt2.env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ resetToEnv: true }),
      }),
      rt2.env,
      ctx,
    )
    await worker.fetch(
      new Request('http://localhost/admin/config/routing', {
        method: 'POST',
        headers: { authorization: `Bearer ${rt2.env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ autoContinuation: null }),
      }),
      rt2.env,
      ctx,
    )
    resetCorsConfigCache()
    assert.equal(await isAutoContinuationEnabled(rt2.env), false)
  } finally {
    resetCorsConfigCache()
    rt2.db.close()
    wipe(dbPath)
  }
})

test('整点 Cron 与全量余额刷新静默跳过静态 API Key（Gemini AIzaSy... 与缺 refreshToken 凭据），不刷假 500 日志', async () => {
  const dbPath = dbFile('cron-static-apikey')
  wipe(dbPath)
  const rt = createNodeRuntime(dbPath)
  const { env } = rt
  env.API_KEY = 'cron-admin-key'
  env.CREDENTIAL_KEY = Buffer.alloc(32, 23).toString('base64')
  const ctx = makeCtx()

  try {
    const cnPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
    const oldTs = Date.now() - 48 * 3_600_000
    await cnPool.createAccount({ uid: 'gemini:gkey_1', nickname: 'GeminiKey', realm: 'cn', provider: 'gemini' }, oldTs)
    await cnPool.putCredential(
      'gemini:gkey_1',
      {
        provider: 'gemini',
        uid: 'gkey_1',
        accessToken: 'AIzaSyTestStaticKey00000000000000000000',
        refreshToken: '',
        expiresAt: 0,
        nickname: 'GeminiKey',
        extras: { authMode: 'api_key', realm: 'cn' },
      },
      oldTs,
    )
    await cnPool.createAccount({ uid: 'meoo:mkey_1', nickname: 'MeooStatic', realm: 'cn', provider: 'meoo' }, oldTs)
    await cnPool.putCredential(
      'meoo:mkey_1',
      {
        provider: 'meoo',
        uid: 'mkey_1',
        accessToken: 'meoo_static_tok',
        refreshToken: '',
        expiresAt: 0,
        nickname: 'MeooStatic',
        extras: { authMode: 'api_key', realm: 'cn' },
      },
      oldTs,
    )

    // 1. 跑整点 Cron（scheduled）
    await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx)
    await ctx.flush()
    const logs = await cnPool.readLogs(50)
    assert.equal(
      logs.filter((l) => l.model === 'cron:refresh' || l.model === 'cron:balance').length,
      0,
      '静态 API Key 在整点 Cron 中绝不能产生 cron:refresh / cron:balance 500 错误日志',
    )

    // 2. 全量 POST /admin/accounts/balance（未指定单 uid）同样跳过静态 API Key
    const balAll = await worker.fetch(
      new Request('http://localhost/admin/accounts/balance', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ realm: 'cn' }),
      }),
      env,
      ctx,
    )
    assert.equal(balAll.status, 200)
    const balAllJson = (await balAll.json()) as { results: Array<{ uid: string; ok: boolean }> }
    assert.equal(balAllJson.results.length, 0, '全量扫描应静默跳过 authMode=api_key 账号')
  } finally {
    rt.db.close()
    wipe(dbPath)
  }
})

test('WorkBuddy 国际版裸 UUID 余额查询严格发送 global 头族，零泄漏国内 5.11.3 X-Client-* 三头', async () => {
  const origFetch = globalThis.fetch
  let capturedHeaders: Record<string, string> = {}
  let capturedUrl = ''
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const h = new Headers(init?.headers)
      capturedHeaders = Object.fromEntries(h.entries())
      return Response.json({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                {
                  PackageCode: 'intl_pro',
                  Status: 1,
                  CycleCapacityRemain: 1200,
                  CapacityRemain: 1200,
                  DeductionEndTime: Date.now() + 86_400_000,
                },
              ],
            },
          },
        },
      })
    }

    const b = await workbuddyProvider.balance!(
      {
        provider: 'workbuddy',
        uid: '8f7a6b5c-1111-2222-3333-444455556666', // 不带 workbuddy: 前缀的裸 UUID
        accessToken: 'tok_intl_bare_uuid',
        refreshToken: 'ref_intl',
        expiresAt: Date.now() + 3_600_000,
        extras: { realm: 'global' },
      },
      AbortSignal.timeout(5_000),
    )
    assert.equal(b.total, 1200)
    assert.equal(capturedUrl, 'https://www.workbuddy.ai/v2/billing/meter/get-user-resource')
    assert.equal(capturedHeaders['origin'], 'https://www.workbuddy.ai')
    assert.equal(capturedHeaders['x-domain'], 'www.workbuddy.ai')
    assert.equal(capturedHeaders['x-client-version'], undefined, '国际版绝不能泄漏国内 X-Client-Version')
    assert.equal(capturedHeaders['x-client-platform'], undefined, '国际版绝不能泄漏国内 X-Client-Platform')
    assert.equal(capturedHeaders['x-client-product'], undefined, '国际版绝不能泄漏国内 X-Client-Product')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('Node 运行时 createNodeRuntime 完整透传全部 6 个 THREE_D_* 环境变量', () => {
  const dbPath = dbFile('env-three-d')
  wipe(dbPath)
  const keys = [
    'THREE_D_AUTO_TOKEN',
    'THREE_D_TEMP_TOKEN',
    'THREE_D_TEMP_TOKENS',
    'THREE_D_STS_SECRET_ID',
    'THREE_D_STS_SECRET_KEY',
    'THREE_D_STS_TOKEN',
  ] as const
  const backup: Record<string, string | undefined> = {}
  for (const k of keys) backup[k] = process.env[k]

  process.env.THREE_D_AUTO_TOKEN = 'false'
  process.env.THREE_D_TEMP_TOKEN = 'ck_t_single_fallback'
  process.env.THREE_D_TEMP_TOKENS = '{"u1":"ck_t_mapped"}'
  process.env.THREE_D_STS_SECRET_ID = 'AKID_MANUAL_TEST'
  process.env.THREE_D_STS_SECRET_KEY = 'SK_MANUAL_TEST'
  process.env.THREE_D_STS_TOKEN = 'STS_TOK_MANUAL_TEST'

  const rt = createNodeRuntime(dbPath)
  try {
    assert.equal(rt.env.THREE_D_AUTO_TOKEN, 'false')
    assert.equal(rt.env.THREE_D_TEMP_TOKEN, 'ck_t_single_fallback')
    assert.equal(rt.env.THREE_D_TEMP_TOKENS, '{"u1":"ck_t_mapped"}')
    assert.equal(rt.env.THREE_D_STS_SECRET_ID, 'AKID_MANUAL_TEST')
    assert.equal(rt.env.THREE_D_STS_SECRET_KEY, 'SK_MANUAL_TEST')
    assert.equal(rt.env.THREE_D_STS_TOKEN, 'STS_TOK_MANUAL_TEST')

    const resolved = resolveManualThreeDCredential(rt.env, 'u1')
    assert.equal(resolved?.stsOverride?.secretId, 'AKID_MANUAL_TEST')
    assert.equal(resolved?.stsOverride?.secretKey, 'SK_MANUAL_TEST')
    assert.equal(resolved?.stsOverride?.sessionToken, 'STS_TOK_MANUAL_TEST')
  } finally {
    for (const k of keys) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
    rt.db.close()
    wipe(dbPath)
  }
})
