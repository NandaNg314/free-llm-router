/**
 * 子密钥鉴权与配额守卫（`/v1/*` 的入口层）。
 *
 * ## 职责边界
 *
 * 本模块**只做**「这请求能不能放行 / 放行后怎么记账」，
 * 不碰上游、不碰账号池。真正的转发仍在 `gateway/server.ts`。
 *
 * ## 为什么记账要分「放行」与「记账」两步
 *
 * 放行时只知道请求数，**不知道 token 数**（要等上游回完才知道）。
 * 故：
 *   - 放行 → `countUse({ rejected: false, 但 input/output 记 0 })` 占住请求数名额；
 *   - 结束后 → `settleUsage(...)` 把真实 token 补上去。
 *
 * ⚠️ 如果只在结束时记一次，那么**流式**响应会到最后一刻才计数 ——
 * 并发请求会全部穿过配额检查（「配额形同虚设」）。先占名额是必要的。
 */

import type { Env } from '../env.js'
import type { AccountPoolDO } from '../pool/AccountPoolDO.js'
import {
  type ApiKeyRecord,
  checkQuota,
  hashApiKey,
  isWindowExpired,
  resetUsageWindow,
} from '../store/apikeys.js'

/**
 * 主密钥（`API_KEY` secret）恒定时间比较。
 *
 * ⚠️ 先各自做 SHA-256 摘要固定为 32 字节再按位异或：
 * 避免直接按最大长度循环泄漏期望密钥的长度侧信道，且空串也走完整摘要保持耗时形状一致。
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i += 1) {
    diff |= (va[i] ?? 0) ^ (vb[i] ?? 0)
  }
  return diff === 0
}

/** 从请求头取 `Authorization: Bearer <key>` 明文。 */
export function bearerOf(request: Request): string {
  const header = (request.headers.get('authorization') ?? '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match === null ? '' : (match[1] ?? '').trim()
}

/** 从请求头取 Anthropic 风格的 `x-api-key` 明文。 */
export function xApiKeyOf(request: Request): string {
  return (request.headers.get('x-api-key') ?? '').trim()
}

/** 从 URL 查询参数提取 `?key=<key>` 明文（仅允许在显式声明的只读端点上启用）。 */
export function queryKeyOf(request: Request): string {
  try {
    return (new URL(request.url).searchParams.get('key') ?? '').trim()
  } catch {
    return ''
  }
}

/** 是否属于数据面鉴权路径（`/v1/*`、`/messages*` 与 `/mcp` 同时接受 Bearer 与 `x-api-key`，且允许子密钥）。 */
export function isDataPlaneAuthPath(pathname: string): boolean {
  return (
    pathname === '/v1' ||
    pathname.startsWith('/v1/') ||
    pathname === '/messages' ||
    pathname === '/messages/count_tokens' ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/')
  )
}

export interface ApiKeyExtractOptions {
  allowXApiKey?: boolean
  /** 仅对显式白名单的只读路径（如 `GET /v1/balance-summary`）开启 `?key=` 支持。 */
  allowQueryKey?: boolean
}

/**
 * 提取请求携带的 API 密钥（同步版，供既有请求头提取与兼容调用）。
 *
 * - 优先 `Authorization: Bearer <key>`；若已显式提供非空 Bearer，绝不回退尝试第二个头
 *  （防止单次请求携带双头试探两把密钥或混淆主/子密钥身份）；
 * - 若未提供 Bearer 且 `allowXApiKey !== false`，兼容读取 `x-api-key: <key>`
 *  （Claude Code / Anthropic SDK 默认只发 `x-api-key`）；
 * - 若 `allowQueryKey === true`，在未提供请求头密钥时读取 `?key=<key>`；
 *   若同时提供了请求头密钥与 `?key=` 且两者不同，同步返回空串视为冲突拒绝。
 */
export function apiKeyOf(request: Request, options?: ApiKeyExtractOptions): string {
  const bearer = bearerOf(request)
  let headerKey = bearer
  if (headerKey === '' && options?.allowXApiKey !== false) {
    headerKey = xApiKeyOf(request)
  }
  if (options?.allowQueryKey === true) {
    const qKey = queryKeyOf(request)
    if (headerKey !== '' && qKey !== '') {
      return headerKey === qKey ? headerKey : ''
    }
    if (headerKey !== '') return headerKey
    return qKey
  }
  return headerKey
}

/**
 * 恒定时间解析请求携带的 API 密钥（支持检测请求头与 `?key=` 不一致冲突）。
 */
export async function resolveRequestApiKey(
  request: Request,
  options?: ApiKeyExtractOptions,
): Promise<{ key: string; conflict: boolean; fromQuery: boolean }> {
  const bearer = bearerOf(request)
  let headerKey = bearer
  if (headerKey === '' && options?.allowXApiKey !== false) {
    headerKey = xApiKeyOf(request)
  }
  if (options?.allowQueryKey === true) {
    const qKey = queryKeyOf(request)
    if (headerKey !== '' && qKey !== '') {
      const same = await constantTimeEqual(headerKey, qKey)
      if (!same) return { key: '', conflict: true, fromQuery: false }
      return { key: headerKey, conflict: false, fromQuery: false }
    }
    if (headerKey !== '') return { key: headerKey, conflict: false, fromQuery: false }
    if (qKey !== '') return { key: qKey, conflict: false, fromQuery: true }
  }
  return { key: headerKey, conflict: false, fromQuery: false }
}

/**
 * 取客户端 IP。
 *
 * ⚠️ 只认 `CF-Connecting-IP`：它是 Cloudflare 边缘**override** 上去的，
 * 客户端伪造不了（其他 `X-Forwarded-*` 可以）。取不到时返回空串，
 * 由 IP 白名单逻辑决定怎么处理（白名单为空 = 不限，空串也能过；
 * 白名单非空 = 空串直接拒），这是 fail-closed 的方向。
 */
export function clientIpOf(request: Request): string {
  return (request.headers.get('cf-connecting-ip') ?? '').trim()
}

/** 鉴权结果。 */
export type AuthResult =
  | { kind: 'admin' }
  | { kind: 'subkey'; record: ApiKeyRecord }
  | { kind: 'none' }
  | { kind: 'subkey-denied'; record: ApiKeyRecord; reason: string; status: number }

/** 子密钥池（全局，存在 `cn` 分片）。 */
function keyPool(env: Env): DurableObjectStub<AccountPoolDO> {
  return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
}

/**
 * 判定 `/v1/*` 请求的身份。
 *
 * 三种结果：
 * 1. `admin` —— 命中 `API_KEY`（全量权限，**不**受任何配额限制）；
 * 2. `subkey` —— 命中一把可用的子密钥（已通过全部配额检查）；
 * 3. `subkey-denied` —— 命中了子密钥但被拒（停用/过期/IP/模型/配额）。
 *
 * ⚠️ 「命中但被拒」必须与「完全没命中」区分开：前者要告诉用户**为什么**，
 * 后者只能说「密钥无效」。把两者混成同一个 401 会让用户拿着一把
 * 明明存在的 Key 却不知道该改什么。
 *
 * @param model - 本次请求要用的模型（`/v1/models` 传空串 = 不做模型检查）。
 */
export async function authenticate(
  request: Request,
  env: Env,
  model: string,
  options?: ApiKeyExtractOptions,
): Promise<AuthResult> {
  const resolved = await resolveRequestApiKey(request, options)
  if (resolved.conflict || resolved.key === '') {
    // 仍跑一次空摘要比较以抹平缺头或冲突早退的时序形状
    if (env.API_KEY !== undefined && env.API_KEY !== '') {
      await constantTimeEqual('', env.API_KEY)
    }
    return { kind: 'none' }
  }
  const provided = resolved.key

  // ① 先比主密钥。⚠️ 顺序有意义：主密钥的处理**不碰 DO**
  //（省一次往返，且主密钥不依赖任何存储状态 —— 即使 DO 挂了管理端仍可用）。
  const expected = env.API_KEY
  if (expected !== undefined && expected !== '' && (await constantTimeEqual(provided, expected))) {
    return { kind: 'admin' }
  }

  // ② 再按哈希找子密钥。
  //
  // ⚠️ `sk-` 前缀不是必要条件（用户可能自定义），但先做一次廉价前缀判断
  // 可以避免把明显的垃圾串拿去算 SHA-256 —— 那是每个请求都要付的成本。
  const pool = keyPool(env)
  let record: ApiKeyRecord | undefined
  try {
    record = await pool.findApiKeyByHash(await hashApiKey(provided))
  } catch {
    // DO 暂时不可用：**fail-closed**（拒绝），不 fail-open。
    // 放行会让「配额」在 DO 抖动时静默失效。
    return { kind: 'none' }
  }
  if (record === undefined) return { kind: 'none' }

  // ③ 配额 / 范围检查。
  const now = Date.now()
  const ip = clientIpOf(request)
  let usage = await pool.getApiKeyUsage(record.id).catch(() => undefined)
  if (usage === undefined) return { kind: 'none' }

  // ⚠️ 窗口过期要**先重置再判**：否则上一窗口用满的计数会让新窗口
  // 一开局就是「已超限」，密钥永久失效。
  if (isWindowExpired(usage, record.limits, now)) usage = resetUsageWindow(usage, now)

  const verdict = checkQuota(record, usage, ip, model, now)
  if (!verdict.ok) {
    const status = verdict.reason === 'requests' || verdict.reason === 'tokens' ? 429 : 403
    return { kind: 'subkey-denied', record, reason: verdict.message, status }
  }
  return { kind: 'subkey', record }
}

/**
 * 放行后立即「占名额」（请求数 +1，token 先记 0）。
 *
 * ⚠️ 必须**不 await** 由调用方 `waitUntil` 或忽略：它不该拖慢首字节时间。
 * 但失败要打日志 —— 静默失败会让配额静默失效（本项目反复强调的形态）。
 */
export function countUse(
  env: Env,
  record: ApiKeyRecord,
  request: Request,
  model: string,
): Promise<void> {
  return keyPool(env)
    .recordApiKeyUse({
      id: record.id,
      ip: clientIpOf(request),
      model,
      input: 0,
      output: 0,
    })
    .catch((error: unknown) => {
      console.error(
        '[apikey] 记账失败（配额可能失真）：',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )
    })
}

/**
 * 请求结束后补齐真实 token 用量。
 *
 * ⚠️ 只加 token，**不再加请求数** —— 请求数已在放行时占过名额。
 * 重复加会让「请求数」直接翻倍。
 */
export function settleUsage(
  env: Env,
  record: ApiKeyRecord,
  input: number,
  output: number,
  model: string,
  ip: string,
): Promise<void> {
  if (input <= 0 && output <= 0) return Promise.resolve()
  return keyPool(env)
    .adjustApiKeyTokens({ id: record.id, ip, model, input, output })
    .catch((error: unknown) => {
      console.error('[apikey] token 记账失败：', error instanceof Error ? error.message : String(error))
    })
}

/**
 * 子密钥的「本次请求归属」——用 `WeakMap` 挂在 `ctx` 上。
 *
 * 🔴 **为什么必须这样传**（2026-10-21 审查补，安全面专项）。
 *
 * ## 缺陷：`token` 配额是一条**从未接线**的死限制
 * `authenticate()` 在鉴权那一刻用 `input=0, output=0` 记一次请求（那时还不知道用量），
 * 而 `settleUsage()` —— 唯一能把真实 token 补上去的函数 —— **零调用者**。
 * 于是 `maxTokens` 永远判不到：实测 `maxTokens=5` 时连发 3 次全部放行，
 * 面板「已用 0 / 100000」永远不动，管理员零告警。
 *
 * ## 为什么不把 `ApiKeyRecord` 一路透传下去
 * `handleChatCompletions()` 是**位置参数**签名，且被三处（两个探针 + 主路径）调用，
 * `handleProviderChat()` 是对象参数 —— 两种签名都要改，还会污染 provider 层。
 * 真正需要它的只有「用量已知的那 4 个点」，而它们都能拿到同一个 `ctx`。
 *
 * ⇒ 鉴权成功后把归属挂到 `ctx`（按对象身份，天然随请求回收），
 * 用量点就地 `settleSubkeyUsage(...)`。主密钥路径**零开销**（WeakMap 里没有条目）。
 */
const subkeyByCtx = new WeakMap<object, { record: ApiKeyRecord; ip: string }>()

/** 鉴权成功且用的是子密钥时调用一次，登记本次请求的归属。 */
export function registerSubkeyUsage(ctx: object | undefined, record: ApiKeyRecord, ip: string): void {
  if (ctx === undefined) return
  subkeyByCtx.set(ctx, { record, ip })
}

/** 读取挂在 `ctx` 上的子密钥记录（主密钥请求返回 `undefined`）。 */
export function subkeyOf(ctx: object | undefined): ApiKeyRecord | undefined {
  if (ctx === undefined) return undefined
  return subkeyByCtx.get(ctx)?.record
}

/**
 * 用量已知时调用：把真实 token 补进子密钥配额。
 *
 * ⚠️ 不 `await`、不抛错：记账失败最多让配额失真，不该影响已经成功的响应。
 */
export function settleSubkeyUsage(
  ctx: object | undefined,
  env: Env,
  input: number,
  output: number,
  model: string,
): void {
  if (ctx === undefined) return
  const entry = subkeyByCtx.get(ctx)
  if (entry === undefined) return
  void settleUsage(env, entry.record, input, output, model, entry.ip)
}

/**
 * 子密钥上下文（传给网关记账用）。
 *
 * ## ⚠️ 为什么把 IP 一起带上，而不是让网关自己从 request 里读
 *
 * `/v1/responses` 的实现是**新造一个 Request** 再转交给
 * `/v1/chat/completions`（见 responses.ts 的「复用」策略）。那个新对象
 * 只带了 `content-type`，`CF-Connecting-IP` **不会**跟过去 ——
 * 若让网关自己读，会一直记到空 IP，面板上「最后来源 IP」永远是空的
 *（而且很难归因：看着像「面板没渲染」，实际是数据源就错了）。
 *
 * ⇒ 在鉴权处读一次（那里拿的是**原始** request），随上下文传下去。
 */
export interface SubkeyContext {
  record: ApiKeyRecord
  /** 客户端的真实来源 IP（已从原始请求读出）。 */
  ip: string
}
