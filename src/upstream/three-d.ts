/**
 * 混元 3D 生成能力（`SubmitHunyuanTo3DProJob` / `QueryHunyuanTo3DProJob`）与临时云凭证自动签发。
 *
 * ## 协议来源与真机验证依据
 *
 * 对齐 `misakano7545/workbuddy2api-panel` 提交 `557b3d5`（`internal/upstream/three_d.go`、
 * `internal/upstream/three_d_credential.go`、`internal/server/three_d.go`，2026-11-14 真机验证）：
 *
 * 1. **临时云凭证签发**（官方客户端 `connect_cloud_service` 同款协议）：
 *    - `POST {chatBase}/v2/api-keys`
 *    - Header: `Authorization: Bearer <账号 OAuth accessToken>`（企业号另带 `X-Enterprise-Id`）
 *    - Body: `{"name":"workbuddy-connect-cloud-service","expire_in_seconds":900,"temporary":true}`
 *    - 响应: `{"code":0,"data":{"key":"ck_t_...","expires_at":...}}`
 *    - 静态 API Key 账号（`ck_` / `pt_` 前缀）无 OAuth 身份，直接短路报 `ThreeDNoCredentialError`，不打上游。
 *
 * 2. **TC3-HMAC-SHA256 代理调用**：
 *    - `POST {chatBase}/agenttool/v1/tcproxy`
 *    - Service: `ai3d` · Version: `2025-05-13` · Region: `ap-guangzhou`
 *    - 派生密钥种子固定为 `"TC3codebuddy"`，`Credential=hy-3d.<ck_t_token>/<date>/ai3d/tc3_request`
 *    - 100% 使用 Web Standard `crypto.subtle` 实现，兼容 Cloudflare Workers 与 Node 22+。
 *
 * 3. **安全红线**：
 *    - 临时云凭证仅驻留进程内存（按 `uid` 缓存 + 到期前 60s 提前失效 + 同号并发 singleflight），绝不落盘；
 *    - 任何日志与异常文本统一经 `redactThreeDSecrets` 脱敏，绝不回显 `ck_t_` 或 `Bearer` 令牌。
 */

import { parseEnabled, resolveUpstream, type Env } from '../env.js'
import { classify, UpstreamError } from './client.js'
import { cliUserAgent, clientIdentityHeaders, INTL_DESKTOP_UA } from './headers.js'
import { INTl_WEB_BASE } from './media.js'

export const THREE_D_PROXY_PATH = '/agenttool/v1/tcproxy'
export const THREE_D_SUBMIT_ACTION = 'SubmitHunyuanTo3DProJob'
export const THREE_D_QUERY_ACTION = 'QueryHunyuanTo3DProJob'

export const THREE_D_KEY_PATH = '/v2/api-keys'
export const THREE_D_KEY_NAME = 'workbuddy-connect-cloud-service'
export const THREE_D_KEY_TTL_SECONDS = 900

export const THREE_D_DEFAULT_MODEL = '3.1'
export const THREE_D_MODEL_ID = 'hy-3d'
export const THREE_D_IMAGE_MAX_BYTES = 6 * 1024 * 1024
export const THREE_D_MAX_BODY_BYTES = 12 * 1024 * 1024

/** 提前 60 秒淘汰即将过期的临时云凭证，避免把快过期的凭证签进耗时长任务。 */
export const AUTO_KEY_MARGIN_MS = 60_000
/** 上游未返回 `expires_at` 或格式不可解析时的保守兜底 TTL（14 分钟）。 */
export const AUTO_KEY_DEFAULT_TTL_MS = 14 * 60_000

const MAX_CREDENTIAL_CACHE_ENTRIES = 512

const VALID_MODELS = new Set(['3.0', '3.1'])
const VALID_GENERATE_TYPES = new Set(['Normal', 'LowPoly', 'Geometry', 'Sketch'])
const VALID_POLYGON_TYPES = new Set(['triangle', 'quadrilateral'])
const VALID_RESULT_FORMATS = new Set(['OBJ', 'GLB', 'USDZ', 'FBX', 'STL'])

/** 混元 3D 账号上下文。 */
export interface ThreeDAccountContext {
  uid: string
  accessToken: string
  realm?: string
  domain?: string
  enterpriseId?: string
  /** 仅供测试覆盖上游基址。 */
  baseUrl?: string
}

/** 混元 3D 提交参数（支持 snake_case OpenAI/REST 风格入参）。 */
export interface ThreeDSubmitInput {
  prompt?: string
  image_url?: string
  image_base64?: string
  multi_view_images?: unknown[]
  model?: string
  enable_pbr?: boolean
  face_count?: number
  generate_type?: string
  polygon_type?: string
  result_format?: string
  [key: string]: unknown
}

/** 混元 3D 产物文件条目。 */
export interface ThreeDResultFile {
  Type?: string
  Url?: string
  PreviewImageUrl?: string
  [key: string]: unknown
}

/** 归一化后的 3D 任务状态（保留原始载荷供客户端读取完整字段）。 */
export interface ThreeDState {
  jobId: string
  status: string
  requestId: string
  errorText: string
  resultUrl: string
  resultFiles: ThreeDResultFile[]
  credit: number | undefined
  rawResult: Record<string, unknown>
}

/** 缺少可用 `ck_t_` 临时云凭证（网关配置或账号形态不支持签发，不应归咎并冷却账号）。 */
export class ThreeDNoCredentialError extends Error {
  readonly code = 'three_d_credential_missing'

  constructor(reason?: string) {
    const base = '3D 生成需要 ck_t_ 临时云凭证：自动签发不可用且未配置手工凭证'
    super(reason ? `${base}（${redactThreeDSecrets(reason)}）` : base)
    this.name = 'ThreeDNoCredentialError'
  }
}

/** 剥离错误消息中的敏感令牌（`ck_t_*`、`Bearer *`、TC3 `Signature=*`），防止进日志或回执。 */
export function redactThreeDSecrets(text: string): string {
  return text
    .replace(/hy-3d\.[A-Za-z0-9._-]+/g, 'hy-3d.[REDACTED]')
    .replace(/\bck_t_[A-Za-z0-9._-]+/g, '[REDACTED_CK_T]')
    .replace(/\b(?:ck|pt)_[A-Za-z0-9._-]+/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Signature=[0-9a-fA-F]+/gi, 'Signature=[REDACTED]')
}

function cleanUidOf(uid: string): string {
  return uid.replace(/^(?:buddy|workbuddy):/, '')
}

/** 静态 API Key 账号（`ck_` / `pt_` 前缀）没有 OAuth 身份，无法调 `/v2/api-keys` 换临时凭证。 */
export function isStaticApiKeyToken(accessToken: string): boolean {
  const t = accessToken.trim()
  return t.startsWith('ck_') || t.startsWith('pt_')
}

/** 解析混元 3D 上游基址（按账号所属 realm / domain 决定，测试可注入 `baseUrl`）。 */
export function resolveThreeDBase(ctx: ThreeDAccountContext, env: Env): string {
  if (ctx.baseUrl !== undefined && ctx.baseUrl.trim() !== '') {
    return ctx.baseUrl.trim().replace(/\/+$/, '')
  }
  if (ctx.realm === 'global') {
    const domain = (ctx.domain ?? '').trim().toLowerCase()
    if (domain.includes('codebuddy.ai')) return 'https://www.codebuddy.ai'
    return INTl_WEB_BASE
  }
  return resolveUpstream(env).chat.replace(/\/+$/, '')
}

// ─────────────────────── 纯 Web Crypto TC3-HMAC-SHA256 ───────────────────────

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0')
  }
  return out
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return toHex(new Uint8Array(digest))
}

export async function hmacSha256(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message) as unknown as BufferSource)
  return new Uint8Array(sig)
}

function formatUtcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

export interface Tc3SignInput {
  host: string
  action: string
  payload: string | Uint8Array
  /** `ck_t_...` 临时凭证（用于 `Credential=hy-3d.<tempToken>/...`）。 */
  tempToken: string
  /** 可选自定义时间戳（毫秒），默认 `Date.now()`。 */
  nowMs?: number
  /**
   * 可选标准腾讯云 STS 覆盖（若用户通过环境变量手工注入标准云 API 三元组）：
   * 未提供时严格走 WorkBuddy 官方 `tcproxy` 协议（`TC3codebuddy` + `hy-3d.<tempToken>`）。
   */
  stsOverride?: {
    secretId: string
    secretKey: string
    sessionToken?: string
  }
}

/**
 * 构造 `agenttool/v1/tcproxy` 所需的 TC3-HMAC-SHA256 请求头（纯 Web Crypto 实现）。
 */
export async function buildTc3Headers(input: Tc3SignInput): Promise<Record<string, string>> {
  const ts = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const date = formatUtcDate(ts)
  const contentType = 'application/json; charset=utf-8'
  const host = input.host.trim().toLowerCase()
  const actionLower = input.action.toLowerCase()
  const payloadBytes = typeof input.payload === 'string' ? encoder.encode(input.payload) : input.payload

  const hashedPayload = await sha256Hex(payloadBytes)
  const canonicalRequest =
    `POST\n/\n\n`
    + `content-type:${contentType}\nhost:${host}\nx-tc-action:${actionLower}\n\n`
    + `content-type;host;x-tc-action\n`
    + hashedPayload

  const scope = `${date}/ai3d/tc3_request`
  const hashedCanonical = await sha256Hex(canonicalRequest)
  const stringToSign = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${hashedCanonical}`

  const seedSecret = input.stsOverride !== undefined
    ? `TC3${input.stsOverride.secretKey}`
    : 'TC3codebuddy'
  const credentialId = input.stsOverride !== undefined
    ? input.stsOverride.secretId
    : `hy-3d.${input.tempToken}`

  const kDate = await hmacSha256(seedSecret, date)
  const kService = await hmacSha256(kDate, 'ai3d')
  const kSigning = await hmacSha256(kService, 'tc3_request')
  const signature = toHex(await hmacSha256(kSigning, stringToSign))

  const headers: Record<string, string> = {
    Authorization:
      `TC3-HMAC-SHA256 Credential=${credentialId}/${scope}, `
      + `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    'Content-Type': contentType,
    'X-TC-Action': input.action,
    'X-TC-Version': '2025-05-13',
    'X-TC-Region': 'ap-guangzhou',
    'X-TC-Timestamp': String(ts),
  }
  if (input.stsOverride?.sessionToken) {
    headers['X-TC-Token'] = input.stsOverride.sessionToken
  }
  return headers
}

// ─────────────────────── 临时云凭证签发、缓存与 Singleflight ───────────────────────

/**
 * 解析 `/v2/api-keys` 返回的 `expires_at`（兼容 RFC3339 字符串、Unix 秒、Unix 毫秒）。
 * 无法识别时返回 `0`（由调用方补 `AUTO_KEY_DEFAULT_TTL_MS`）。
 */
export function parseThreeDKeyExpiresAt(raw: unknown): number {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return 0
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n <= 0) return 0
      return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000)
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000)
  }
  return 0
}

export interface ManualThreeDCredential {
  tempToken: string
  stsOverride?: {
    secretId: string
    secretKey: string
    sessionToken?: string
  }
}

/**
 * 从 `Env` 解析可选的手工临时凭证覆盖（不直接访问 `process.env`，兼容双运行时）：
 * - `THREE_D_TEMP_TOKENS`：JSON 映射 `{"<uid>":"ck_t_...","*":"ck_t_..."}` 或单条 `ck_t_...` 串；
 * - `THREE_D_TEMP_TOKEN`：全局兜底 `ck_t_...` 串；
 * - `THREE_D_STS_SECRET_ID` + `THREE_D_STS_SECRET_KEY`（+ 可选 `THREE_D_STS_TOKEN`）：手工腾讯云 STS 覆盖。
 */
export function resolveManualThreeDCredential(
  env: Env,
  uid: string,
): ManualThreeDCredential | undefined {
  const vars = env as unknown as Record<string, unknown>

  const stsId = typeof vars.THREE_D_STS_SECRET_ID === 'string' ? vars.THREE_D_STS_SECRET_ID.trim() : ''
  const stsKey = typeof vars.THREE_D_STS_SECRET_KEY === 'string' ? vars.THREE_D_STS_SECRET_KEY.trim() : ''
  const stsToken = typeof vars.THREE_D_STS_TOKEN === 'string' ? vars.THREE_D_STS_TOKEN.trim() : ''
  if (stsId !== '' && stsKey !== '') {
    return {
      tempToken: stsToken,
      stsOverride: {
        secretId: stsId,
        secretKey: stsKey,
        ...(stsToken === '' ? {} : { sessionToken: stsToken }),
      },
    }
  }

  const clean = cleanUidOf(uid)
  const rawMap = typeof vars.THREE_D_TEMP_TOKENS === 'string' ? vars.THREE_D_TEMP_TOKENS.trim() : ''
  if (rawMap !== '') {
    if (rawMap.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawMap) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>
          for (const candidateKey of [uid, clean, '*']) {
            const val = rec[candidateKey]
            if (typeof val === 'string' && val.trim() !== '') {
              return { tempToken: val.trim() }
            }
          }
        }
      } catch {
        // JSON 格式有误时忽略，不泄露原文
      }
    } else {
      return { tempToken: rawMap }
    }
  }

  const single = typeof vars.THREE_D_TEMP_TOKEN === 'string' ? vars.THREE_D_TEMP_TOKEN.trim() : ''
  if (single !== '') {
    return { tempToken: single }
  }
  return undefined
}

/**
 * 调用官方 `POST {chatBase}/v2/api-keys` 换取 900s `ck_t_` 临时云凭证。
 */
export async function fetchClientTempKey(
  ctx: ThreeDAccountContext,
  env: Env,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; nowMs?: number } = {},
): Promise<{ key: string; expiresAt: number }> {
  if (!ctx.accessToken || ctx.accessToken.trim() === '' || isStaticApiKeyToken(ctx.accessToken)) {
    throw new ThreeDNoCredentialError('静态 API Key 或空令牌无法自动签发临时云凭证')
  }

  const base = resolveThreeDBase(ctx, env)
  const isGlobal = ctx.realm === 'global'
  const cleanUid = cleanUidOf(ctx.uid)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Product': 'SaaS',
    'User-Agent': isGlobal ? INTL_DESKTOP_UA : cliUserAgent(),
    ...clientIdentityHeaders(isGlobal ? 'global' : 'cn'),
    Authorization: `Bearer ${ctx.accessToken}`,
  }
  if (cleanUid !== '') {
    headers['X-User-Id'] = cleanUid
  }
  if (ctx.enterpriseId !== undefined && ctx.enterpriseId.trim() !== '') {
    headers['X-Enterprise-Id'] = ctx.enterpriseId.trim()
  }

  const doFetch = options.fetchImpl ?? fetch
  const signal = options.signal ?? AbortSignal.timeout(15_000)

  let res: Response
  try {
    res = await doFetch(`${base}${THREE_D_KEY_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: THREE_D_KEY_NAME,
        expire_in_seconds: THREE_D_KEY_TTL_SECONDS,
        temporary: true,
      }),
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    const msg = error instanceof Error ? error.message : String(error)
    throw new ThreeDNoCredentialError(`签发请求网络异常: ${msg}`)
  }

  const rawText = await res.text().catch(() => '')
  if (!res.ok) {
    // 401 说明账号本身的 OAuth accessToken 已过期，交给外层媒体路由器触发 provider.refresh 再试！
    if (res.status === 401) {
      throw new UpstreamError({
        kind: 'auth_error',
        httpStatus: 401,
        message: '签发 3D 临时凭证时账号 OAuth 令牌鉴权失败 (HTTP 401)',
        detail: redactThreeDSecrets(rawText.slice(0, 200)),
      })
    }
    throw new ThreeDNoCredentialError(`签发接口返回 HTTP ${res.status}`)
  }

  let parsed: Record<string, unknown>
  try {
    const jsonVal = JSON.parse(rawText) as unknown
    if (jsonVal === null || typeof jsonVal !== 'object' || Array.isArray(jsonVal)) {
      throw new Error('non-object json')
    }
    parsed = jsonVal as Record<string, unknown>
  } catch {
    throw new ThreeDNoCredentialError('签发接口返回非 JSON 载荷')
  }

  const code = parsed.code
  if (code !== undefined && code !== 0) {
    if (code === 12153) {
      throw new UpstreamError({
        kind: 'session_dead',
        httpStatus: res.status,
        code: 12153,
        message: '签发 3D 临时凭证时会话已过期 (code=12153)',
        detail: 'code=12153',
      })
    }
    const msg = typeof parsed.msg === 'string' ? parsed.msg.slice(0, 120) : ''
    throw new ThreeDNoCredentialError(`签发业务码拒绝 code=${String(code)}${msg ? ` ${msg}` : ''}`)
  }

  const data = parsed.data !== null && typeof parsed.data === 'object'
    ? (parsed.data as Record<string, unknown>)
    : parsed
  const key = typeof data.key === 'string' ? data.key.trim() : ''
  if (!key.startsWith('ck_t_')) {
    throw new ThreeDNoCredentialError('签发响应缺少合法的 ck_t_ 临时凭证')
  }

  const now = options.nowMs ?? Date.now()
  const parsedExp = parseThreeDKeyExpiresAt(data.expires_at ?? data.expiresAt)
  const expiresAt = parsedExp > 0 ? parsedExp : now + AUTO_KEY_DEFAULT_TTL_MS
  return { key, expiresAt }
}

interface CachedTempKey {
  key: string
  expiresAt: number
}

export interface ResolvedTempCredential {
  tempToken: string
  stsOverride?: ManualThreeDCredential['stsOverride']
  fromManual: boolean
  fromCache: boolean
}

export type TempKeyFetcher = (
  ctx: ThreeDAccountContext,
  env: Env,
) => Promise<{ key: string; expiresAt: number }>

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * 按 `uid` 维护临时云凭证的内存缓存与并发 Singleflight 合并。
 *
 * - 手工环境变量覆盖优先；
 * - 缓存命中需满足 `now < expiresAt - AUTO_KEY_MARGIN_MS`（提前 60s 刷新）；
 * - 同一 `uid` 并发取凭证只向 `/v2/api-keys` 发一次请求，且单个等待方取消不中断底层飞行请求；
 * - 上游 `tcproxy` 返回 401/403/`AuthFailure*` 时由调用方触发 `invalidate(uid)` 清缓存重签。
 */
export class ThreeDCredentialManager {
  private readonly cache = new Map<string, CachedTempKey>()
  private readonly flights = new Map<string, Promise<CachedTempKey>>()
  private fetcher: TempKeyFetcher

  constructor(fetcher?: TempKeyFetcher) {
    this.fetcher = fetcher ?? ((ctx, env) => fetchClientTempKey(ctx, env))
  }

  /** 仅供测试替换底层签发函数。 */
  setFetcherForTest(fetcher: TempKeyFetcher): void {
    this.fetcher = fetcher
  }

  /** 清空全部内存缓存（仅供测试隔离）。 */
  clearAll(): void {
    this.cache.clear()
    this.flights.clear()
  }

  /** 使指定账号的缓存凭证立即失效（同时清完整 uid 与裸 uid 键）。 */
  invalidate(uid: string): void {
    if (!uid) return
    this.cache.delete(uid)
    this.cache.delete(cleanUidOf(uid))
  }

  async resolve(
    ctx: ThreeDAccountContext,
    env: Env,
    options: { nowMs?: number; signal?: AbortSignal } = {},
  ): Promise<ResolvedTempCredential> {
    if (!ctx.uid) throw new ThreeDNoCredentialError('缺少账号 uid')

    // 1. 手工环境变量覆盖优先
    const manual = resolveManualThreeDCredential(env, ctx.uid)
    if (manual !== undefined) {
      return {
        tempToken: manual.tempToken,
        ...(manual.stsOverride === undefined ? {} : { stsOverride: manual.stsOverride }),
        fromManual: true,
        fromCache: false,
      }
    }

    // 2. 自动签发开关（默认开启，显式 THREE_D_AUTO_TOKEN=false 时只允许手工凭证）
    const vars = env as unknown as Record<string, unknown>
    const autoRaw = typeof vars.THREE_D_AUTO_TOKEN === 'string' ? vars.THREE_D_AUTO_TOKEN : undefined
    if (!parseEnabled(autoRaw, true)) {
      throw new ThreeDNoCredentialError('THREE_D_AUTO_TOKEN 已关闭且未配置手工凭证')
    }

    const now = options.nowMs ?? Date.now()
    const cacheKey = ctx.uid
    const hit = this.cache.get(cacheKey)
    if (hit !== undefined) {
      if (now < hit.expiresAt - AUTO_KEY_MARGIN_MS) {
        // 刷新 Map 插入序以维持 LRU
        this.cache.delete(cacheKey)
        this.cache.set(cacheKey, hit)
        return { tempToken: hit.key, fromManual: false, fromCache: true }
      }
      this.cache.delete(cacheKey)
    }

    // 3. 同账号并发 Singleflight
    const existingFlight = this.flights.get(cacheKey)
    if (existingFlight !== undefined) {
      const shared = await waitWithSignal(existingFlight, options.signal)
      return { tempToken: shared.key, fromManual: false, fromCache: false }
    }

    const flightPromise = (async (): Promise<CachedTempKey> => {
      try {
        const fetched = await this.fetcher(ctx, env)
        const key = fetched.key.trim()
        if (key === '' || !key.startsWith('ck_t_')) {
          throw new ThreeDNoCredentialError('签发返回了无效的临时凭证格式')
        }
        const expiresAt = fetched.expiresAt > 0
          ? fetched.expiresAt
          : (options.nowMs ?? Date.now()) + AUTO_KEY_DEFAULT_TTL_MS
        const entry: CachedTempKey = { key, expiresAt }
        this.putCache(cacheKey, entry)
        return entry
      } finally {
        this.flights.delete(cacheKey)
      }
    })()

    this.flights.set(cacheKey, flightPromise)
    // 防止在等待方已取消时产生 unhandledRejection
    flightPromise.catch(() => {})

    const fresh = await waitWithSignal(flightPromise, options.signal)
    return { tempToken: fresh.key, fromManual: false, fromCache: false }
  }

  private putCache(key: string, entry: CachedTempKey): void {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, entry)
    while (this.cache.size > MAX_CREDENTIAL_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

/** 默认进程级 3D 临时云凭证管理器。 */
export const defaultThreeDCredentials = new ThreeDCredentialManager()

// ─────────────────────── 请求参数校验与转换 ───────────────────────

/**
 * 校验图片 base64（或 `data:image/...;base64,...`）并返回剥去前缀后的纯 base64 字符串。
 * 使用纯 Web Standard `atob` 解码校验体积（上限 6 MiB），零 `Buffer` 依赖。
 */
export function normalizeAndValidateBase64Image(input: string): string {
  let encoded = input.trim()
  if (encoded.startsWith('data:')) {
    const comma = encoded.indexOf(',')
    if (comma < 0 || !encoded.slice(0, comma).toLowerCase().endsWith(';base64')) {
      throw new Error('图片 data URL 必须使用 base64 编码（形如 data:image/png;base64,...）')
    }
    encoded = encoded.slice(comma + 1).trim()
  }
  if (encoded === '') {
    throw new Error('图片 base64 数据不能为空')
  }
  // 兼容 URL-safe base64 与换行空白
  const normalized = encoded.replace(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('图片不是合法的 base64 数据')
  }
  let binary: string
  try {
    binary = atob(normalized)
  } catch {
    throw new Error('图片不是合法的 base64 数据')
  }
  if (binary.length > THREE_D_IMAGE_MAX_BYTES) {
    throw new Error('单张图片解码后不能超过 6 MiB')
  }
  return normalized
}

/**
 * 将入站 JSON 请求校验并转换为混元 3D `SubmitHunyuanTo3DProJob` 的上游请求体。
 *
 * 本地化拦截所有上游协议约束（`LowPoly` 版本、`Sketch` 图文双必填、`multi_view_images` 互斥、
 * `ViewImageUrl` URL 跳过 base64 解码、`result_format` 支持 `OBJ`/`GLB`/`USDZ`/`FBX`/`STL`），
 * 避免非法参数触发多账号无效重试。
 */
export function buildThreeDUpstreamBody(
  req: Record<string, unknown>,
): { body: Record<string, unknown>; model: string } {
  const rawModel = typeof req.model === 'string' ? req.model.trim() : ''
  const model = rawModel === '' ? THREE_D_DEFAULT_MODEL : rawModel
  if (!VALID_MODELS.has(model)) {
    throw new Error('model 必须是 3.0 或 3.1')
  }

  const body: Record<string, unknown> = { Model: model }

  if (typeof req.prompt === 'string' && req.prompt.trim() !== '') {
    body.Prompt = req.prompt.trim()
  }
  if (typeof req.image_url === 'string' && req.image_url.trim() !== '') {
    const imageUrl = req.image_url.trim()
    if (!/^https?:\/\//i.test(imageUrl)) {
      throw new Error('image_url 必须是 http(s) 公网 URL')
    }
    body.ImageUrl = imageUrl
  }
  if (typeof req.image_base64 === 'string' && req.image_base64.trim() !== '') {
    body.ImageBase64 = normalizeAndValidateBase64Image(req.image_base64)
  }
  if (typeof req.enable_pbr === 'boolean') {
    body.EnablePBR = req.enable_pbr
  }

  // 多视角图片校验与克隆（不原地篡改调用方传入的对象引用）
  if (req.multi_view_images !== undefined && req.multi_view_images !== null) {
    if (!Array.isArray(req.multi_view_images) || req.multi_view_images.length === 0) {
      throw new Error('multi_view_images 必须是非空数组')
    }
    const normalizedViews: unknown[] = []
    for (const item of req.multi_view_images) {
      if (typeof item === 'string') {
        const trimmed = item.trim()
        if (trimmed === '') throw new Error('multi_view_images 不能含空图片')
        if (/^https?:\/\//i.test(trimmed)) {
          normalizedViews.push(trimmed)
        } else {
          normalizedViews.push(normalizeAndValidateBase64Image(trimmed))
        }
        continue
      }
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const src = item as Record<string, unknown>
        const cloned: Record<string, unknown> = {}
        let hasImageField = false
        for (const [k, v] of Object.entries(src)) {
          if (k === 'ViewType' || k === 'view_type') {
            if (typeof v !== 'string' || v.trim() === '') {
              throw new Error('multi_view_images 的 ViewType 必须是非空字符串')
            }
            cloned.ViewType = v.trim()
            continue
          }
          if (typeof v !== 'string' || v.trim() === '') {
            throw new Error('multi_view_images 的图片地址/base64 必须是非空字符串')
          }
          const s = v.trim()
          const targetKey = k === 'view_image_url'
            ? 'ViewImageUrl'
            : k === 'view_image_base64'
              ? 'ViewImageBase64'
              : k
          const isUrlField = targetKey.toLowerCase().includes('url') || /^https?:\/\//i.test(s)
          if (s.startsWith('data:') || !isUrlField) {
            cloned[targetKey] = normalizeAndValidateBase64Image(s)
          } else {
            if (!/^https?:\/\//i.test(s)) {
              throw new Error(`multi_view_images.${targetKey} 必须是合法的 http(s) URL`)
            }
            cloned[targetKey] = s
          }
          hasImageField = true
        }
        if (!hasImageField) {
          throw new Error('multi_view_images 对象元素缺少图片字段（ViewImageUrl 或 ViewImageBase64）')
        }
        normalizedViews.push(cloned)
        continue
      }
      throw new Error('multi_view_images 元素必须是图片字符串或对象')
    }
    body.MultiViewImages = normalizedViews
  }

  if (
    body.Prompt === undefined
    && body.ImageUrl === undefined
    && body.ImageBase64 === undefined
    && body.MultiViewImages === undefined
  ) {
    throw new Error('prompt、image_url、image_base64、multi_view_images 至少提供一种')
  }

  if (req.face_count !== undefined && req.face_count !== null) {
    const n = typeof req.face_count === 'number' ? req.face_count : Number.NaN
    if (!Number.isInteger(n) || n < 10_000 || n > 1_500_000) {
      throw new Error('face_count 必须是 10000～1500000 之间的整数')
    }
    body.FaceCount = n
  }

  const generateType = typeof req.generate_type === 'string' ? req.generate_type.trim() : ''
  if (generateType !== '') {
    if (!VALID_GENERATE_TYPES.has(generateType)) {
      throw new Error('generate_type 只支持 Normal、LowPoly、Geometry、Sketch')
    }
    body.GenerateType = generateType
  }

  if (generateType === 'LowPoly' && model !== '3.0') {
    throw new Error('LowPoly 需要 model=3.0')
  }
  if (
    generateType === 'Sketch'
    && (body.Prompt === undefined || (body.ImageUrl === undefined && body.ImageBase64 === undefined))
  ) {
    throw new Error('Sketch 需要同时提供 prompt 以及 image_url 或 image_base64')
  }
  if (
    body.MultiViewImages !== undefined
    && (body.Prompt !== undefined || (body.ImageUrl === undefined && body.ImageBase64 === undefined))
  ) {
    throw new Error('multi_view_images 需要同时提供主图（image_url 或 image_base64），且不能与 prompt 同时提供')
  }

  const polygonType = typeof req.polygon_type === 'string' ? req.polygon_type.trim() : ''
  if (polygonType !== '') {
    if (!VALID_POLYGON_TYPES.has(polygonType)) {
      throw new Error('polygon_type 只支持 triangle、quadrilateral')
    }
    body.PolygonType = polygonType
  }

  const rawFormat = typeof req.result_format === 'string' ? req.result_format.trim().toUpperCase() : ''
  if (rawFormat !== '') {
    if (!VALID_RESULT_FORMATS.has(rawFormat)) {
      throw new Error('result_format 只支持 OBJ、GLB、USDZ、FBX、STL')
    }
    body.ResultFormat = rawFormat
  }

  return { body, model }
}

// ─────────────────────── 响应解析与上游调用 ───────────────────────

export function isThreeDDone(status: string): boolean {
  return status === 'DONE' || status === 'FAIL'
}

export function isThreeDSucceeded(status: string): boolean {
  return status === 'DONE'
}

/**
 * 解析混元 3D 任务回执（兼容 `SubmitHunyuanTo3DProJob` 与 `QueryHunyuanTo3DProJob` 响应）。
 */
export function parseThreeDState(raw: unknown, fallbackJobId = ''): ThreeDState {
  let obj: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      obj = {}
    }
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  }

  // 若外层仍包着 `Response` 对象，自动解包一层
  if (obj.Response !== null && typeof obj.Response === 'object' && !Array.isArray(obj.Response)) {
    obj = obj.Response as Record<string, unknown>
  }

  const jobId = typeof obj.JobId === 'string' && obj.JobId.trim() !== ''
    ? obj.JobId.trim()
    : fallbackJobId
  let status = typeof obj.Status === 'string' ? obj.Status.trim() : ''
  if (status === '') {
    switch (obj.JobStatusCode) {
      case 1:
        status = 'QUEUED'
        break
      case 2:
        status = 'PROCESSING'
        break
      case 4:
        status = 'FAIL'
        break
      case 5:
        status = 'DONE'
        break
      default:
        break
    }
  }

  const requestId = typeof obj.RequestId === 'string' ? obj.RequestId : ''
  let errorText = typeof obj.ErrorMessage === 'string' ? obj.ErrorMessage : ''
  if (errorText === '' && typeof obj.JobErrorMsg === 'string') {
    errorText = obj.JobErrorMsg
  }

  const rawCredit = obj.ResultCreditConsumed
  const credit = typeof rawCredit === 'number' && Number.isFinite(rawCredit) && rawCredit > 0
    ? rawCredit
    : undefined

  const resultFiles: ThreeDResultFile[] = []
  let resultUrl = ''
  if (Array.isArray(obj.ResultFile3Ds)) {
    for (const item of obj.ResultFile3Ds) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const f = item as ThreeDResultFile
      resultFiles.push(f)
      if (typeof f.Url === 'string' && f.Url !== '' && f.Type === 'GLB') {
        resultUrl = f.Url
      }
    }
    if (resultUrl === '' && resultFiles.length > 0) {
      const firstUrl = resultFiles[0]?.Url
      if (typeof firstUrl === 'string') resultUrl = firstUrl
    }
  }

  for (const key of ['ResultUrl', 'ModelUrl', 'ResultModelUrl'] as const) {
    const candidate = obj[key]
    if (typeof candidate === 'string' && candidate !== '') {
      resultUrl = candidate
      break
    }
  }

  return {
    jobId,
    status,
    requestId,
    errorText,
    resultUrl,
    resultFiles,
    credit,
    rawResult: obj,
  }
}

function classifyTc3Rejection(httpStatus: number, tcCode: string, message: string): UpstreamError {
  const safeMsg = redactThreeDSecrets(message).slice(0, 400)
  const isTcAuth =
    httpStatus === 401
    || httpStatus === 403
    || tcCode.startsWith('AuthFailure')
    || tcCode.startsWith('UnauthorizedOperation')

  if (isTcAuth) {
    return new UpstreamError({
      kind: 'auth_error',
      httpStatus: httpStatus >= 400 ? httpStatus : 401,
      message: `3D 上游鉴权拒绝${tcCode ? ` (${tcCode})` : ''}：${safeMsg}`,
      detail: safeMsg,
    })
  }
  if (httpStatus === 429 || tcCode.startsWith('RequestLimitExceeded') || tcCode.includes('LimitExceeded')) {
    return new UpstreamError({
      kind: 'rate_limited',
      httpStatus: 429,
      message: `3D 上游限流${tcCode ? ` (${tcCode})` : ''}：${safeMsg}`,
      detail: safeMsg,
    })
  }
  if (httpStatus === 402 || tcCode.includes('InsufficientBalance') || tcCode.startsWith('ResourceInsufficient')) {
    return new UpstreamError({
      kind: 'credit_exhausted',
      httpStatus: 402,
      message: `3D 额度不足${tcCode ? ` (${tcCode})` : ''}：${safeMsg}`,
      detail: safeMsg,
    })
  }
  // 任务不存在 / 非本账号任务（查询探测时识别为 404 not_found）
  if (
    httpStatus === 404
    || tcCode.includes('JobNotFound')
    || tcCode.includes('TaskNotFound')
    || tcCode.includes('ResourceNotFound')
    || /job.*not.*found|not.*exist/i.test(safeMsg)
  ) {
    return new UpstreamError({
      kind: 'not_found',
      httpStatus: 404,
      message: `3D 任务不存在${tcCode ? ` (${tcCode})` : ''}：${safeMsg}`,
      detail: safeMsg,
    })
  }
  // 参数错误 / 内容审核拦截属于请求自身问题，归为 bad_request（400），绝不冷却健康账号
  if (
    tcCode.startsWith('InvalidParameter')
    || tcCode.startsWith('MissingParameter')
    || tcCode.includes('Moderation')
    || tcCode.includes('Sensitive')
    || (httpStatus >= 400 && httpStatus < 500)
    || (httpStatus === 200 && tcCode !== '' && !tcCode.startsWith('InternalError'))
  ) {
    return new UpstreamError({
      kind: 'bad_request',
      httpStatus: 400,
      message: `3D 请求被拒绝${tcCode ? ` (${tcCode})` : ''}：${safeMsg}`,
      detail: safeMsg,
    })
  }

  const c = classify(httpStatus >= 400 ? httpStatus : 502, safeMsg)
  return new UpstreamError({
    kind: c.kind === 'unknown' ? 'server' : c.kind,
    httpStatus: httpStatus >= 400 ? httpStatus : 502,
    code: c.code,
    message: `3D 上游异常${tcCode ? ` (${tcCode})` : ''}：${safeMsg}`,
    detail: safeMsg,
  })
}

export interface ThreeDCallOptions {
  credentials?: ThreeDCredentialManager
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  nowMs?: number
  timeoutMs?: number
}

/**
 * 调用混元 3D `agenttool/v1/tcproxy`。
 *
 * - 先取 `ck_t_` 临时云凭证（拿不到时直接抛 `ThreeDNoCredentialError`，不拿 OAuth token 硬顶）；
 * - 若上游返回 401/403 或 `AuthFailure*`：立即清空该 `uid` 的凭证缓存；
 *   若刚才使用的是自动签发凭证，则自动重签一次新 `ck_t_` 并重试请求（最多重签 1 次）。
 */
export async function callThreeDProxy(
  ctx: ThreeDAccountContext,
  env: Env,
  action: string,
  bodyObj: Record<string, unknown>,
  options: ThreeDCallOptions = {},
): Promise<Record<string, unknown>> {
  const manager = options.credentials ?? defaultThreeDCredentials
  const payload = JSON.stringify(bodyObj)
  const base = resolveThreeDBase(ctx, env)
  const endpoint = `${base}${THREE_D_PROXY_PATH}`
  const host = new URL(endpoint).host
  const doFetch = options.fetchImpl ?? fetch

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cred = await manager.resolve(ctx, env, {
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    const tc3Headers = await buildTc3Headers({
      host,
      action,
      payload,
      tempToken: cred.tempToken,
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      ...(cred.stsOverride === undefined ? {} : { stsOverride: cred.stsOverride }),
    })

    const isGlobal = ctx.realm === 'global'
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': isGlobal ? INTL_DESKTOP_UA : cliUserAgent(),
      ...clientIdentityHeaders(isGlobal ? 'global' : 'cn'),
      ...tc3Headers,
    }

    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000)
    let res: Response
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      throw new UpstreamError({
        kind: 'network',
        httpStatus: 0,
        message: `3D tcproxy 网络请求失败：${msg}`,
        detail: msg.slice(0, 300),
      })
    }

    const rawText = await res.text().catch(() => '')
    let parsed: Record<string, unknown> | undefined
    try {
      const v = JSON.parse(rawText) as unknown
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>
      }
    } catch {
      parsed = undefined
    }

    if (parsed === undefined) {
      if (res.status === 401 || res.status === 403) {
        manager.invalidate(ctx.uid)
        if (!cred.fromManual && attempt === 0) continue
      }
      const safeRaw = redactThreeDSecrets(rawText.slice(0, 300))
      const c = classify(res.status, safeRaw)
      throw new UpstreamError({
        kind: c.kind,
        httpStatus: res.status,
        code: c.code,
        message: `3D tcproxy 非 JSON 响应 (HTTP ${res.status})：${safeRaw}`,
        detail: safeRaw,
      })
    }

    const responseEnvelope =
      parsed.Response !== null && typeof parsed.Response === 'object' && !Array.isArray(parsed.Response)
        ? (parsed.Response as Record<string, unknown>)
        : undefined

    if (responseEnvelope !== undefined) {
      const innerErr =
        responseEnvelope.Error !== null
        && typeof responseEnvelope.Error === 'object'
        && !Array.isArray(responseEnvelope.Error)
          ? (responseEnvelope.Error as Record<string, unknown>)
          : undefined

      if (innerErr !== undefined) {
        const tcCode = typeof innerErr.Code === 'string' ? innerErr.Code : ''
        const tcMsg = typeof innerErr.Message === 'string' ? innerErr.Message : ''
        const isTcAuth = res.status === 401 || res.status === 403 || tcCode.startsWith('AuthFailure')
        if (isTcAuth) {
          manager.invalidate(ctx.uid)
          // 若本次使用的是缓存中的旧凭证（或首轮自动签发凭证失效），清缓存后重签重试一次
          if (!cred.fromManual && attempt === 0) continue
        }
        throw classifyTc3Rejection(res.status, tcCode, tcMsg || JSON.stringify(innerErr))
      }

      if (res.status >= 400) {
        if (res.status === 401 || res.status === 403) {
          manager.invalidate(ctx.uid)
          if (!cred.fromManual && attempt === 0) continue
        }
        throw classifyTc3Rejection(res.status, '', JSON.stringify(responseEnvelope))
      }

      return responseEnvelope
    }

    // 顶层错误（如 APISIX 网关或代理层直接返回 `{error, message}` 或 `{code, msg}`）
    if (res.status >= 400 || parsed.error !== undefined || (typeof parsed.code === 'number' && parsed.code !== 0)) {
      if (res.status === 401 || res.status === 403) {
        manager.invalidate(ctx.uid)
        if (!cred.fromManual && attempt === 0) continue
      }
      const msg = typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.msg === 'string'
          ? parsed.msg
          : rawText.slice(0, 300)
      throw classifyTc3Rejection(res.status, '', msg)
    }

    return parsed
  }

  throw new ThreeDNoCredentialError('临时云凭证重签后仍被上游拒绝')
}

/**
 * 提交混元 3D 生成任务（`SubmitHunyuanTo3DProJob`）。
 */
export async function submitThreeDJob(
  ctx: ThreeDAccountContext,
  env: Env,
  req: ThreeDSubmitInput,
  options: ThreeDCallOptions = {},
): Promise<{ state: ThreeDState; model: string }> {
  const { body, model } = buildThreeDUpstreamBody(req)
  const rawResp = await callThreeDProxy(ctx, env, THREE_D_SUBMIT_ACTION, body, options)
  const state = parseThreeDState(rawResp, '')
  if (state.jobId === '' && state.resultUrl === '') {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: '3D 提交成功但上游响应缺少 JobId',
      detail: redactThreeDSecrets(JSON.stringify(rawResp).slice(0, 200)),
    })
  }
  if (state.status === '') {
    state.status = state.resultUrl !== '' ? 'DONE' : 'SUBMITTED'
  }
  return { state, model }
}

/**
 * 查询混元 3D 任务进度与产物直链（`QueryHunyuanTo3DProJob`）。
 */
export async function queryThreeDJob(
  ctx: ThreeDAccountContext,
  env: Env,
  jobId: string,
  options: ThreeDCallOptions = {},
): Promise<ThreeDState> {
  const id = jobId.trim()
  if (id === '') {
    throw new Error('job_id 不能为空')
  }
  const rawResp = await callThreeDProxy(ctx, env, THREE_D_QUERY_ACTION, { JobId: id }, options)
  return parseThreeDState(rawResp, id)
}
