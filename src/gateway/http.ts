/**
 * HTTP 响应助手（OpenAI 兼容形状）。
 *
 * 单独一个文件是为了避免**循环 import**：`server.ts` 需要 `jsonError`，
 * 而 `models.ts` 也需要它 —— 若放在 `server.ts` 里就会形成环。
 */

import { normalizeCorsOrigin } from '../env.js'

/** JSON 响应。 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** JSON 错误响应（OpenAI 兼容形状：`{error:{message,type,code}}`）。 */
export function jsonError(status: number, message: string, code: string): Response {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 数据面跨域允许的请求方法。 */
export const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS'

/**
 * 数据面跨域预检允许的请求头。
 *
 * 覆盖 OpenAI SDK、Anthropic SDK / Claude Code（`x-api-key`、`anthropic-version`、`anthropic-beta`）、
 * MCP Streamable HTTP（`mcp-session-id`、`last-event-id`）以及本网关的指定账号头 `x-flr-account`。
 */
export const CORS_ALLOW_HEADERS =
  'Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, ' +
  'Content-Type, Accept, mcp-session-id, last-event-id, x-flr-account, x-request-id, x-trace-id, ' +
  'x-stainless-lang, x-stainless-package-version, x-stainless-os, x-stainless-arch, ' +
  'x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count, x-stainless-timeout'

/** 数据面跨域暴露给浏览器脚本可读的响应头。 */
export const CORS_EXPOSE_HEADERS = 'mcp-session-id, x-request-id, x-trace-id, retry-after'

/** 预检响应默认缓存秒数（10 分钟，浏览器上限通常为 7200 秒）。 */
export const CORS_DEFAULT_MAX_AGE = 600

/**
 * 判断路径是否属于允许配置 CORS 的**数据面**（`/v1/*` 与 `/mcp`）。
 *
 * ⚠️ 管理面 `/admin/*` 与面板静态页 `/panel/*` 绝不在此处放开跨域。
 */
export function isDataPlaneCorsPath(pathname: string): boolean {
  return (
    pathname === '/v1' ||
    pathname.startsWith('/v1/') ||
    pathname === '/messages' ||
    pathname === '/messages/count_tokens' ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/')
  )
}

/**
 * 计算本次请求应回写的 `Access-Control-Allow-Origin` 值。
 *
 * 安全不变式：
 * 1. 白名单为空（默认关闭）或请求未携带 `Origin` ⇒ 返回 `undefined`；
 * 2. 白名单含 `'*'` ⇒ 恒返回字面量 `'*'`，**绝不反射**请求里的任意 `Origin`（含 `Origin: null`）；
 * 3. 白名单为具体域名列表 ⇒ 先将请求 `Origin` 做严格 URL origin 归一化，
 *    仅在命中白名单时返回白名单中的规范化值（拒绝 `Origin: null` 与任意未授权域）。
 */
export function resolveCorsAllowOrigin(
  requestOrigin: string | null,
  allowedOrigins: readonly string[],
): string | undefined {
  if (allowedOrigins.length === 0) return undefined
  if (requestOrigin === null || requestOrigin.trim() === '') return undefined
  if (allowedOrigins.includes('*')) return '*'
  const normalized = normalizeCorsOrigin(requestOrigin)
  if (normalized === '' || normalized === '*') return undefined
  const hit = allowedOrigins.find((item) => item === normalized)
  return hit
}

/** 向 `Headers` 合并 `Vary` 字段且避免重复追加同一 token。 */
function ensureVaryOrigin(headers: Headers): void {
  const existing = headers.get('vary')
  if (existing === null || existing.trim() === '') {
    headers.set('vary', 'Origin')
    return
  }
  const tokens = existing
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
  if (!tokens.includes('origin') && !tokens.includes('*')) {
    headers.set('vary', `${existing}, Origin`)
  }
}

/**
 * 处理数据面（`/v1/*`、`/mcp`）的 `OPTIONS` 预检请求。
 *
 * - 携带 `Origin` 且命中白名单 ⇒ `204 No Content` + 完整预检响应头；
 * - 携带 `Origin` 但未命中白名单（含未开启 CORS）⇒ `403` 明确报 `origin_not_allowed`
 *  （参考 `workbuddy-manager` `5d01b59`：不静默回 200，让跨域问题直接停在预检阶段）；
 * - 未携带 `Origin` 的非浏览器裸 `OPTIONS` 探测 ⇒ `204` + `Allow: GET, POST, OPTIONS`
 *  （若配置了 `*` 也一并附上通配预检头）。
 */
export function handleCorsPreflight(
  request: Request,
  allowedOrigins: readonly string[],
  maxAgeSeconds = CORS_DEFAULT_MAX_AGE,
): Response {
  const maxAge = String(Math.max(0, Math.min(7200, Math.trunc(maxAgeSeconds))))
  const rawOrigin = request.headers.get('origin')
  if (rawOrigin === null || rawOrigin.trim() === '') {
    const headers = new Headers({
      allow: CORS_ALLOW_METHODS,
      'cache-control': 'no-store',
    })
    if (allowedOrigins.includes('*')) {
      headers.set('access-control-allow-origin', '*')
      headers.set('access-control-allow-methods', CORS_ALLOW_METHODS)
      headers.set('access-control-allow-headers', CORS_ALLOW_HEADERS)
      headers.set('access-control-max-age', maxAge)
    }
    return new Response(null, { status: 204, headers })
  }

  const allowOrigin = resolveCorsAllowOrigin(rawOrigin, allowedOrigins)
  if (allowOrigin === undefined) {
    const denied = jsonError(403, '来源不在网关 CORS 白名单内', 'origin_not_allowed')
    const headers = new Headers(denied.headers)
    ensureVaryOrigin(headers)
    return new Response(denied.body, { status: 403, headers })
  }

  const headers = new Headers({
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': maxAge,
    vary: 'Origin',
  })
  return new Response(null, { status: 204, headers })
}

/**
 * 为数据面实际请求（含流式响应与 4xx/5xx 错误响应）补齐并去重 CORS 响应头。
 *
 * ⚠️ 参考 `workbuddy-manager` `176e496`：
 * - 先剔除可能由下游/上游附带的同名 `access-control-allow-origin` 与 `access-control-allow-credentials`，
 *   防止出现 `Access-Control-Allow-Origin: https://a, https://a` 重复头或凭证反射漏洞；
 * - 数据面仅用请求头密钥，**绝不**返回 `Access-Control-Allow-Credentials`；
 * - 流式 `response.body` 原样透传，零缓冲。
 */
export function applyCorsHeaders(
  response: Response,
  request: Request,
  allowedOrigins: readonly string[],
): Response {
  const allowOrigin = resolveCorsAllowOrigin(request.headers.get('origin'), allowedOrigins)
  if (allowOrigin === undefined) {
    // 即便本次未命中白名单，若响应意外带了下游的 allow-credentials 也一并剥离确保安全
    if (!response.headers.has('access-control-allow-credentials')) return response
    const clean = new Headers(response.headers)
    clean.delete('access-control-allow-credentials')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: clean,
    })
  }

  const headers = new Headers(response.headers)
  headers.delete('access-control-allow-origin')
  headers.delete('access-control-allow-credentials')
  headers.set('access-control-allow-origin', allowOrigin)
  if (!headers.has('access-control-expose-headers')) {
    headers.set('access-control-expose-headers', CORS_EXPOSE_HEADERS)
  }
  ensureVaryOrigin(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * 解析标准 `Retry-After` 头 → 毫秒。
 *
 * ## 为什么放在共享层而不是某个 provider 里
 *
 * 它是 **HTTP 标准头**，与任何供应商无关。原先它只存在于 `opencode.ts`，
 * 而**别处也需要**（网关的模型级冷却要据此对齐上游墙钟）。
 * 放在 provider 里会逼着网关去 import 一个供应商模块 —— 层次颠倒。
 *
 * ## ⚠️ 只放行**纯数字**秒数
 *
 * `Date.parse('900')` 会得到 1970 年的时刻，算出巨大负数，
 * 再被 `Math.max(0, …)` 夹成 0 ⇒ 刚被限流的账号**马上又被选中**，
 * 形成无限空转。故先判纯数字，再退回 `Date` 解析（HTTP-date 形式）。
 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')
  if (raw === undefined || raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}
