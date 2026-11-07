/**
 * MCP（Model Context Protocol）端点 —— Streamable HTTP 的**纯 POST 形态**。
 *
 * ## 这是什么
 *
 * MCP 是 Anthropic 提出的标准协议：客户端（OpenCode / Claude Code / Cursor / Cline）
 * 连上来问「你有哪些工具」，服务端回一份清单，之后 AI 自己决定何时调用 ——
 * 用户不需要为每个工具写集成代码。
 *
 * ## 为什么用「纯 POST、无 SSE、无 session」
 *
 * 完整 MCP 支持 SSE 流与 session 协商。我们只需要**工具调用**这一件事：
 * - 工具都是一问一答（搜索 / 抓网页 / 生图），没有需要服务端主动推送的场景；
 * - 无 session ⇒ 天然无状态 ⇒ 多实例 / 重启都不影响（本服务跑在容器里，重启频繁）。
 *
 * ⇒ 走 Streamable HTTP 的最小子集：客户端 POST 一条 JSON-RPC，我们回一条 JSON-RPC。
 * `GET /mcp` 回 405 + `Allow: POST`，客户端据此退回纯 POST（这是规范允许的降级路径）。
 *
 * ## 鉴权
 *
 * 与 REST 完全相同（`Authorization: Bearer <API_KEY>`）。**不额外引入 OAuth**：
 * 本服务是**自托管、单用户**形态，API_KEY 就是唯一身份。OAuth 在这里只会
 * 增加一个「浏览器跳转授权」的环节，而使用者就是服务器主人本人。
 *
 * ## ⚠️ 能力边界（2026-11-05 实测，别再猜）
 *
 * | 工具 | 底层 | 国内版 | 国际版 |
 * |---|---|---|---|
 * | `web_search` | `/agenttool/v1/search` | 401 | ✅ 200 |
 * | `web_fetch` | `/agenttool/v1/webfetch` | 401 | ✅ 200 |
 * | `generate_image` | `/v2/images/generations` | 401 | ✅ 200 |
 *
 * ⇒ **三个工具都只对国际版（global 分片）可用**。无权限时如实回错，
 * 让模型自己读到「这个部署没有配置国际版账号」，而不是伪造一个空结果。
 */
import type { Env } from '../env.js'
import { generateImage, mediaCapable, webFetch, webSearch, INTl_IMAGE_MODEL } from '../upstream/media.js'
import { pickCredential } from './models.js'
import { WORKBUDDY_INTL } from '../providers/buddy.js'

/** MCP 协议版本（客户端发什么我们回什么，不认识就回最新的）。 */
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0] as string

/** JSON-RPC 错误码（规范值，不要自造）。 */
const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

interface RpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/**
 * 工具清单。
 *
 * ⚠️ `description` 会被**塞进模型的上下文**，所以写的是「什么时候该用它」，
 * 不是「它做了什么」。模型选工具靠的是这句话。
 *
 * ⚠️ `inputSchema` 必须是合法 JSON Schema —— 少了 `type: 'object'` 或
 * `properties` 会让某些客户端的校验器直接拒绝整份清单。
 */
const TOOLS = [
  {
    name: 'web_search',
    description:
      '联网搜索实时信息（新闻、股价、天气、最新文档等）。'
      + '当问题涉及时效性内容、或你不确定答案是否过时时使用。返回标题、链接与摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，用自然语言即可' },
        max_results: {
          type: 'integer',
          description: '返回条数，默认 5，最大 20',
          minimum: 1,
          maximum: 20,
        },
        rerank: {
          type: 'boolean',
          description: '是否按相关性重排（默认 true）。搜型号/专有名词时可压制同名不同物的噪声结果。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      '抓取网页正文并转成 Markdown。用于读取用户给出的链接、或 web_search 返回的某个结果页。'
      + '不要用它抓需要登录才能看的页面。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http(s) 地址' },
      },
      required: ['url'],
    },
  },
  {
    name: 'generate_image',
    description:
      '根据文字描述生成图片，返回可访问的图片 URL（签名直链，约 24 小时有效，需长期保存请自行下载）。'
      + '当用户要求「画一张」「生成一张图」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述，越具体越好' },
        size: { type: 'string', description: '尺寸如 1024x1024（默认）' },
        model: { type: 'string', description: `模型名，默认 ${INTl_IMAGE_MODEL}` },
      },
      required: ['prompt'],
    },
  },
] as const

/** 构造一条 JSON-RPC 成功响应。 */
function ok(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

/** 构造一条 JSON-RPC 错误响应。 */
function fail(id: unknown, code: number, message: string): Response {
  // ⚠️ 协议错误走 HTTP 200 + JSON-RPC error（规范要求），不要改成 4xx/5xx
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

/** 取 realm 可用的国际版凭据；取不到时返回可读的错误文本（给模型看）。 */
async function credentials(env: Env): Promise<{ ok: true; uid: string; token: string } | { ok: false; reason: string }> {
  const realm = 'global'
  if (!mediaCapable(realm)) return { ok: false, reason: `${realm} 分片不支持这些能力` }
  const c = await pickCredential(env, realm, WORKBUDDY_INTL.id)
  if (c === undefined) {
    return {
      ok: false,
      reason: '这个网关没有可用的 WorkBuddy 国际版账号。请先在面板登录一个国际版账号再重试。',
    }
  }
  return { ok: true, uid: c.uid, token: c.credential.accessToken }
}

/**
 * 执行一次工具调用。
 *
 * ⚠️ **执行失败返回 `isError: true` + 上游原话**，而不是 JSON-RPC error。
 * 这是规范里的区分：`isError` 是「工具跑了但失败」，模型能读到原因并自己决定
 * 换方案；JSON-RPC `-32602` 是「请求本身不合法」，模型看了也无从补救。
 * 把「账号没配」报成协议错误，模型只会反复重试同一个调用。
 */
async function callTool(name: string, args: Record<string, unknown>, env: Env): Promise<ToolResult> {
  const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return text('参数必须是 JSON 对象', true)
  }

  if (name === 'web_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (query === '') return text('缺少 query', true)
    const c = await credentials(env)
    if (!c.ok) return text(c.reason, true)
    try {
      const r = await webSearch({ uid: c.uid, accessToken: c.token, realm: 'global' }, env, {
        query,
        ...(typeof args.max_results === 'number' ? { maxResults: args.max_results } : {}),
        ...(typeof args.rerank === 'boolean' ? { rerank: args.rerank } : {}),
      })
      if (r.results.length === 0) return text(`没有找到「${query}」的结果。`)
      const body = r.results
        .map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`)
        .join('\n\n')
      return text(`搜索「${query}」得到 ${r.results.length} 条结果：\n\n${body}`)
    } catch (error) {
      return text(`搜索失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  if (name === 'web_fetch') {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return text('url 必须是 http(s) 地址', true)
    const c = await credentials(env)
    if (!c.ok) return text(c.reason, true)
    try {
      const r = await webFetch({ uid: c.uid, accessToken: c.token, realm: 'global' }, env, { url })
      const head = r.title === '' ? `# ${r.url}` : `# ${r.title}\n\n来源：${r.url}`
      return text(`${head}\n\n${r.content}`)
    } catch (error) {
      return text(`抓取失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  if (name === 'generate_image') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') return text('缺少 prompt', true)
    const c = await credentials(env)
    if (!c.ok) return text(c.reason, true)
    try {
      const r = await generateImage({ uid: c.uid, accessToken: c.token }, env, {
        prompt,
        ...(typeof args.size === 'string' && args.size !== '' ? { size: args.size } : {}),
        ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
      })
      if (r.images.length === 0) return text('上游返回成功但没有图片', true)
      const urls = r.images.map((x, i) => `${i + 1}. ${x.url}${x.size ? `（${x.size}）` : ''}`).join('\n')
      return text(
        `已生成 ${r.images.length} 张图片：\n\n${urls}\n\n`
          + '⚠️ 这些是签名直链（约 24 小时有效），需要长期保存请立即下载。'
          + (r.credit === undefined ? '' : `\n本次消耗 ${r.credit} 积分。`),
      )
    } catch (error) {
      return text(`生成失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  return text(`未知工具：${name}`, true)
}

/**
 * 处理一条 MCP 请求。
 *
 * @returns 响应；`undefined` 表示这是一条**通知**（无 `id`），按规范不回响应。
 */
export async function handleMcp(request: Request, env: Env): Promise<Response | undefined> {
  if (request.method === 'GET') {
    // ⚠️ 规范允许客户端探测 SSE 通道；我们不提供 ⇒ 405 + Allow，客户端会退回纯 POST
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return fail(null, RPC.parseError, '请求体不是合法 JSON')
  }

  // 规范允许批量；我们只处理单条（批量在纯 POST 形态下几乎没人用，且会让错误处理复杂化）
  if (Array.isArray(payload)) {
    if (payload.length === 0) return fail(null, RPC.invalidRequest, '空批量')
    const first = payload[0] as RpcRequest
    return await handleOne(first, env)
  }
  return await handleOne(payload as RpcRequest, env)
}

async function handleOne(msg: RpcRequest, env: Env): Promise<Response | undefined> {
  const id = msg.id
  const method = typeof msg.method === 'string' ? msg.method : ''
  // ⚠️ 没有 `id` 的是**通知**（如 notifications/initialized）—— 按规范不回响应
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    const params = (msg.params ?? {}) as Record<string, unknown>
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    return ok(id, {
      // ⚠️ 客户端要的版本在我们支持列表里就原样回；否则回我们最新的
      //（回一个客户端不认识的版本会让它直接断连）
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'free-llm-router', version: '1.0.0' },
      instructions:
        '本网关提供联网检索、网页抓取与文生图。'
        + '需要实时信息时优先用 web_search，不要凭记忆回答时效性问题。',
    })
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return undefined
  }

  if (method === 'ping') return ok(id, {})

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS })
  }

  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>
    const name = typeof params.name === 'string' ? params.name : ''
    const args = (params.arguments ?? {}) as Record<string, unknown>
    if (name === '') return fail(id, RPC.invalidParams, '缺少工具名')
    try {
      return ok(id, await callTool(name, args, env))
    } catch (error) {
      // 兜底：任何未预期异常都变成工具错误（不是协议错误），避免客户端整体断连
      return ok(id, {
        content: [{ type: 'text', text: `工具执行异常：${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      })
    }
  }

  // 资源 / 提示词：我们没实现 ⇒ 回空清单（不是错误。回错误会让部分客户端告警）
  if (method === 'resources/list') return ok(id, { resources: [] })
  if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] })
  if (method === 'prompts/list') return ok(id, { prompts: [] })

  if (isNotification) return undefined
  return fail(id, RPC.methodNotFound, `不支持的方法：${method}`)
}
