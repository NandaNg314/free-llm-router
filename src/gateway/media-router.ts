/**
 * 媒体 / 联网检索 / 视频 / 混元 3D 的统一智能路由、多账号容灾、任务归属绑定与幂等记账中心。
 *
 * ## 解决的四类核心缺陷
 *
 * 1. **告别第 0 号单点死取**：筛选候选时严格剔除 `disabled` 及处于冷却/熔断/受限/降权窗口
 *    （`until` / `hardUntil` / `restrictedUntil` / `breakerUntil` / `degradeUntil`）的账号；
 *    扣积分能力优先挑选「明确有积分 > 未知积分 > 未采样 0」，仅在全池 0 分时兜底尝试零分号。
 * 2. **401 自动续期 + 多号 Failover**：遇到 401 / `auth_error` / `12153` 先调 `provider.refresh`
 *    回写池凭据并在当前账号重试一次；若仍失败或遇 402 / 403 / 429 / 5xx / 网络错误，自动切换下一个候选号；
 *    遇到 400 参数/合规错误立即 fail-fast 停止换号，避免脏请求打穿整池。
 * 3. **异步任务归属绑定与重启自愈收养**：维护 `taskId -> { uid, realm, createdAt, billed }` LRU 台账，
 *    确保视频与 3D 轮询始终回到原提交账号；进程重启或跨 isolate 未命中时有界探测池内账号并自动收养。
 * 4. **全链路面板日志与幂等记账**：所有 REST 媒体/检索/3D 请求统一写入 `pool.appendLog`（`recordLog`）
 *    与 `pool.recordUsage`；异步任务终态 `usage.credit` 通过 `claimBilling` 保证幂等**只记账一次**。
 */

import type { Env } from '../env.js'
import type { AccountPoolDO } from '../pool/AccountPoolDO.js'
import { isActive, type AccountState } from '../pool/state.js'
import { bindBuddy, WORKBUDDY_INTL, workbuddyProvider } from '../providers/buddy.js'
import { DEFAULT_PROVIDER, findProvider } from '../providers/index.js'
import type { Provider, ProviderCredential } from '../providers/types.js'
import { modelAllowed, type ApiKeyRecord } from '../store/apikeys.js'
import { classify, UpstreamError } from '../upstream/client.js'
import {
  editImage,
  generateImage,
  getVideoTask,
  INTl_IMAGE_MODEL,
  INTl_VIDEO_MODEL,
  mediaCapable,
  submitVideo,
  webFetch,
  webSearch,
  type FetchResult,
  type ImageGenResult,
  type SearchResult,
  type VideoSubmitResult,
  type VideoTaskResult,
} from '../upstream/media.js'
import {
  buildThreeDUpstreamBody,
  isThreeDDone,
  isThreeDSucceeded,
  queryThreeDJob,
  redactThreeDSecrets,
  submitThreeDJob,
  THREE_D_DEFAULT_MODEL,
  THREE_D_MAX_BODY_BYTES,
  THREE_D_MODEL_ID,
  ThreeDNoCredentialError,
  type ThreeDCallOptions,
  type ThreeDState,
} from '../upstream/three-d.js'
import { settleSubkeyUsage } from './authz.js'
import { BodyTooLargeError, MAX_REQUEST_BYTES, readJsonCapped } from './body.js'
import { json, jsonError } from './http.js'
import { recordLog } from './server.js'

export const DEFAULT_TASK_LEDGER_MAX = 2048
export const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_MEDIA_ATTEMPTS_PER_REALM = 4
export const MAX_PROBE_ACCOUNTS = 8
export const DEFAULT_TASK_POLL_INTERVAL_MS = 3_000
export const MAX_WAIT_TIMEOUT_SECONDS = 600

/** 腾讯云 COS 媒体产物直链允许代理的域名后缀白名单（严格后缀匹配防 SSRF）。 */
export const ALLOWED_MEDIA_PROXY_SUFFIXES = ['.myqcloud.com', '.tencentcos.cn'] as const

/** 校验媒体代理下载的目标 URL 是否属于受信任的腾讯云 COS 产物域名（仅允许 https）。 */
export function isAllowedMediaProxyUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    if (host === '') return false
    return ALLOWED_MEDIA_PROXY_SUFFIXES.some((suffix) => host.endsWith(suffix))
  } catch {
    return false
  }
}

/**
 * 子密钥模型白名单检查（供 `/v1/images/*`、`/v1/videos/*`、`/v1/3d/*` 等媒体路由使用）。
 *
 * - 当子密钥未限制模型（`models` 为空）时直接放行；
 * - 对 3D 接口同时接受 `'hy-3d'`、`'workbuddy/hy-3d'`、`'buddy/hy-3d'` 与具体版本号（`'3.1'` / `'3.0'`）。
 */
export function checkMediaSubkeyModel(
  record: ApiKeyRecord | undefined,
  effectiveModels: readonly string[],
): Response | undefined {
  if (record === undefined) return undefined
  const rules = record.limits.models
  if (rules.length === 0) return undefined
  for (const candidate of effectiveModels) {
    if (candidate !== '' && modelAllowed(candidate, rules)) {
      return undefined
    }
  }
  const primary = effectiveModels[0] ?? 'media'
  return json(
    {
      error: {
        message: `该 API Key 不被允许使用模型「${primary}」`,
        type: 'permission_error',
      },
    },
    403,
  )
}

// ─────────────────────── 异步任务归属台账（LRU + 幂等记账 + Singleflight） ───────────────────────

export interface TaskOwnership {
  kind: 'video' | '3d'
  taskId: string
  uid: string
  realm: 'cn' | 'global'
  providerId: string
  model: string
  createdAt: number
  lastAccessedAt: number
  /** 任务终态积分是否已结算记账（幂等锁，确保同一任务最多记账一次）。 */
  billed: boolean
  /** 终态积分快照（供重复查询在上游省略 usage 时补齐回执）。 */
  credit?: number
}

export class TaskOwnerGoneError extends Error {
  constructor(taskId: string) {
    super(`提交任务 ${taskId} 的原账号已不在账号池中`)
    this.name = 'TaskOwnerGoneError'
  }
}

export class TaskNotFoundError extends Error {
  constructor(kindLabel: string, taskId: string) {
    super(`查不到此${kindLabel}任务（${taskId}）：任务只对原提交账号可见，或已过期`)
    this.name = 'TaskNotFoundError'
  }
}

function waitPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/**
 * 异步媒体任务（视频 / 混元 3D）归属台账。
 *
 * - 利用 `Map` 插入序维护 O(1) LRU，超出 `maxSize` 时优先清理过期项，仍超限则淘汰最久未访问项；
 * - `claimBilling` 提供原子幂等锁，保证多次轮询或并发查询只记一次积分；
 * - `pollShared` 将同一 `taskId` 的并发查询合并为单次上游请求。
 */
export class MediaTaskLedger {
  private readonly entries = new Map<string, TaskOwnership>()
  private readonly flights = new Map<string, Promise<unknown>>()
  private readonly maxSize: number
  private readonly ttlMs: number

  constructor(options: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_TASK_LEDGER_MAX
    this.ttlMs = options.ttlMs ?? DEFAULT_TASK_TTL_MS
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.flights.clear()
  }

  private keyOf(kind: 'video' | '3d', taskId: string): string {
    return `${kind}:${taskId}`
  }

  get(kind: 'video' | '3d', taskId: string, now = Date.now()): TaskOwnership | undefined {
    const key = this.keyOf(kind, taskId)
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    if (now - hit.createdAt > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    hit.lastAccessedAt = now
    // 刷新到 Map 尾部以维持 LRU 顺序
    this.entries.delete(key)
    this.entries.set(key, hit)
    return { ...hit }
  }

  register(input: {
    kind: 'video' | '3d'
    taskId: string
    uid: string
    realm: 'cn' | 'global'
    providerId: string
    model: string
    now?: number
    billed?: boolean
    credit?: number
  }): TaskOwnership {
    const now = input.now ?? Date.now()
    const key = this.keyOf(input.kind, input.taskId)
    const existing = this.entries.get(key)
    const record: TaskOwnership = {
      kind: input.kind,
      taskId: input.taskId,
      uid: input.uid,
      realm: input.realm,
      providerId: input.providerId,
      model: input.model || existing?.model || '',
      createdAt: existing?.createdAt ?? now,
      lastAccessedAt: now,
      billed: existing?.billed === true || input.billed === true,
      ...(input.credit !== undefined && input.credit > 0
        ? { credit: input.credit }
        : existing?.credit !== undefined
          ? { credit: existing.credit }
          : {}),
    }
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, record)
    this.evictIfNeeded(now)
    return { ...record }
  }

  /**
   * 进程重启或跨 isolate 未命中时，探测命中后将任务收养进台账。
   * 已存在条目时绝不覆盖（保持已有 `billed` 状态）。
   */
  adopt(input: {
    kind: 'video' | '3d'
    taskId: string
    uid: string
    realm: 'cn' | 'global'
    providerId: string
    model: string
    now?: number
    billed?: boolean
  }): TaskOwnership {
    const key = this.keyOf(input.kind, input.taskId)
    const existing = this.entries.get(key)
    if (existing !== undefined) return { ...existing }
    return this.register(input)
  }

  /**
   * 幂等抢占该任务的唯一记账权：
   * - 仅当任务尚未记账（`billed === false`）且 `credit > 0` 时返回 `true` 并锁死 `billed = true`；
   * - 重复轮询或无积分消耗时返回 `false`。
   */
  claimBilling(kind: 'video' | '3d', taskId: string, credit: number | undefined): boolean {
    if (typeof credit !== 'number' || !Number.isFinite(credit) || credit <= 0) {
      return false
    }
    const key = this.keyOf(kind, taskId)
    const hit = this.entries.get(key)
    if (hit === undefined) return false
    hit.credit = credit
    if (hit.billed) return false
    hit.billed = true
    return true
  }

  cachedCredit(kind: 'video' | '3d', taskId: string): number | undefined {
    const hit = this.entries.get(this.keyOf(kind, taskId))
    return hit?.credit
  }

  async pollShared<T>(kind: 'video' | '3d', taskId: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const key = this.keyOf(kind, taskId)
    const active = this.flights.get(key) as Promise<T> | undefined
    if (active !== undefined) {
      return await waitPromiseWithSignal(active, signal)
    }
    const p = (async (): Promise<T> => {
      try {
        return await fn()
      } finally {
        this.flights.delete(key)
      }
    })()
    this.flights.set(key, p)
    p.catch(() => {})
    return await waitPromiseWithSignal(p, signal)
  }

  private evictIfNeeded(now: number): void {
    if (this.entries.size <= this.maxSize) return
    for (const [k, v] of this.entries) {
      if (now - v.createdAt > this.ttlMs) {
        this.entries.delete(k)
      }
    }
    while (this.entries.size > this.maxSize) {
      const lruKey = this.entries.keys().next().value
      if (lruKey === undefined) break
      this.entries.delete(lruKey)
    }
  }
}

/** 默认全局异步媒体任务台账。 */
export const mediaTaskLedger = new MediaTaskLedger()

// ─────────────────────── 候选账号智能筛选与容灾执行器 ───────────────────────

export interface RealmTarget {
  realm: 'cn' | 'global'
  providerId: string
}

export interface SelectedMediaAccount {
  uid: string
  realm: 'cn' | 'global'
  providerId: string
  credential: ProviderCredential
  pool: DurableObjectStub<AccountPoolDO>
}

function creditTier(account: AccountState): number {
  const raw = account as unknown as Record<string, unknown>
  const credits = typeof raw.credits === 'number' && Number.isFinite(raw.credits) ? raw.credits : undefined
  if (credits !== undefined && credits > 0) return 0
  if (credits === undefined) return 1
  const samples = Array.isArray(raw.samples) ? raw.samples : []
  if (credits === 0 && samples.length === 0) return 2
  return 3
}

function isHealthyCandidate(account: AccountState, now: number): boolean {
  if (account.disabled) return false
  const raw = account as unknown as Record<string, unknown>
  const deadlines = [
    account.until,
    typeof raw.hardUntil === 'number' ? raw.hardUntil : 0,
    account.breakerUntil,
    account.degradeUntil,
    account.restrictedUntil,
  ]
  for (const d of deadlines) {
    if (typeof d === 'number' && isActive(d, now)) return false
  }
  return true
}

/**
 * 筛选并按池优先级排列健康候选账号。
 *
 * - 剔除 `disabled` 及处于 `until` / `hardUntil` / `restrictedUntil` / `breakerUntil` / `degradeUntil` 冷却期的账号；
 * - `requireCredits: true` 时优先选有积分（临期积分优先、高余额优先）与未知积分账号，全 0 时才兜底使用零分账号。
 */
export async function selectMediaCandidates(
  pool: DurableObjectStub<AccountPoolDO>,
  realm: string,
  providerId: string,
  options: { now?: number; requireCredits?: boolean; exclude?: ReadonlySet<string> } = {},
): Promise<AccountState[]> {
  const now = options.now ?? Date.now()
  const accounts = await pool.listAccounts(realm, now)
  const exclude = options.exclude

  let permLocked = false
  if (options.requireCredits && typeof pool.getPermanentLocks === 'function') {
    try {
      const locks = await pool.getPermanentLocks()
      permLocked = locks?.[providerId] === true
    } catch {
      permLocked = false
    }
  }

  const filtered = accounts
    .map((account, index) => ({ account, index, tier: creditTier(account) }))
    .filter(({ account }) => {
      if ((account.provider ?? DEFAULT_PROVIDER) !== providerId) return false
      if (exclude?.has(account.uid)) return false
      if (!isHealthyCandidate(account, now)) return false
      if (permLocked && (account.credits ?? 0) > 0 && (account.creditsExpiring ?? 0) <= 0) {
        return false
      }
      return true
    })

  if (options.requireCredits) {
    filtered.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.tier === 0) {
        const expDiff = (b.account.creditsExpiring ?? 0) - (a.account.creditsExpiring ?? 0)
        if (expDiff !== 0) return expDiff
        const credDiff = (b.account.credits ?? 0) - (a.account.credits ?? 0)
        if (credDiff !== 0) return credDiff
      }
      return a.index - b.index
    })
  }

  return filtered.map((x) => x.account)
}

function normalizePoolCredential(
  raw: unknown,
  uid: string,
  providerId: string,
  realm: string,
): ProviderCredential | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const accessToken = typeof o.accessToken === 'string' ? o.accessToken.trim() : ''
  if (accessToken === '') return undefined
  const rawExtras = o.extras !== null && typeof o.extras === 'object' && !Array.isArray(o.extras)
    ? (o.extras as Record<string, string>)
    : {}
  return {
    provider: typeof o.provider === 'string' && o.provider !== '' ? o.provider : providerId,
    uid: typeof o.uid === 'string' && o.uid !== '' ? o.uid : uid.replace(/^(?:buddy|workbuddy):/, ''),
    accessToken,
    refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : '',
    expiresAt: typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : 0,
    nickname: typeof o.nickname === 'string' ? o.nickname : '',
    extras: { realm, ...rawExtras },
  }
}

function resolveProviderForRefresh(providerId: string, env: Env): Provider | undefined {
  const found = findProvider(providerId)
  if (found !== undefined) {
    return providerId === DEFAULT_PROVIDER ? bindBuddy(env) : found
  }
  if (providerId === WORKBUDDY_INTL.id) return workbuddyProvider
  if (providerId === DEFAULT_PROVIDER) return bindBuddy(env)
  return undefined
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof UpstreamError) {
    if (error.httpStatus === 401 || error.kind === 'auth_error' || error.kind === 'session_dead') {
      return true
    }
  }
  const msg = error instanceof Error ? error.message : String(error)
  return /\b401\b|auth_error|unauthor|invalid.?token|token.?expir|12153/i.test(msg)
}

function isClientBadRequest(error: unknown): boolean {
  if (error instanceof UpstreamError) {
    if (
      error.kind === 'bad_request'
      || error.kind === 'context_exceeded'
      || error.kind === 'image_invalid'
    ) {
      return true
    }
    if (error.httpStatus === 400 && error.kind !== 'auth_error' && error.kind !== 'rate_limited') {
      return true
    }
  }
  return false
}

function applyAccountPenaltyIfNeeded(
  pool: DurableObjectStub<AccountPoolDO>,
  uid: string,
  error: unknown,
  now: number,
  ctx?: ExecutionContext,
): void {
  if (typeof pool.applyFailure !== 'function') return
  if (error instanceof ThreeDNoCredentialError || isClientBadRequest(error)) return

  let kind: 'soft' | 'hard' | 'breaker' | 'session_dead' | 'restricted' | undefined
  let reason = redactThreeDSecrets(error instanceof Error ? error.message : String(error)).slice(0, 160)

  if (error instanceof UpstreamError) {
    switch (error.kind) {
      case 'credit_exhausted':
        kind = 'hard'
        break
      case 'request_illegal':
        kind = 'restricted'
        break
      case 'rate_limited':
      case 'waf_blocked':
        kind = 'soft'
        break
      case 'session_dead':
        kind = 'session_dead'
        break
      case 'server':
        kind = 'breaker'
        break
      default:
        if (error.httpStatus === 402) kind = 'hard'
        else if (error.httpStatus === 429) kind = 'soft'
        else if (error.httpStatus >= 500) kind = 'breaker'
        break
    }
    if (error.detail) {
      reason = redactThreeDSecrets(`${error.kind}: ${error.message}`).slice(0, 160)
    }
  } else {
    const c = classify(502, reason)
    if (c.kind === 'credit_exhausted') kind = 'hard'
    else if (c.kind === 'rate_limited') kind = 'soft'
  }

  if (kind === undefined) return
  const task = pool.applyFailure({ uid, kind, now, reason }).catch((e: unknown) => {
    console.warn('[media-router] applyFailure 写入失败：', e instanceof Error ? e.message : String(e))
  })
  if (ctx !== undefined) ctx.waitUntil(task)
  else void task
}

export type RefreshFn = (
  providerId: string,
  credential: ProviderCredential,
  env: Env,
) => Promise<ProviderCredential | undefined>

export interface FailoverOptions {
  now?: number
  requireCredits?: boolean
  maxAttemptsPerRealm?: number
  modelForStats?: string
  /** 若同步调用当场返回了积分消耗（如生图/改图），传入可实时扣减快照；异步任务提交阶段不传。 */
  extractCredit?: (value: unknown) => number | undefined
  refreshImpl?: RefreshFn
  ctx?: ExecutionContext
}

export interface FailoverSuccess<T> {
  value: T
  account: SelectedMediaAccount
  attempts: number
}

export class NoAvailableMediaAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoAvailableMediaAccountError'
  }
}

async function defaultRefreshCredential(
  providerId: string,
  credential: ProviderCredential,
  env: Env,
): Promise<ProviderCredential | undefined> {
  if (!credential.refreshToken) return undefined
  const provider = resolveProviderForRefresh(providerId, env)
  if (provider?.refresh === undefined) return undefined
  return await provider.refresh(credential, AbortSignal.timeout(25_000))
}

/**
 * 在给定的分片候选链上执行媒体/检索调用：
 * - 遇到 401 自动调用 `refresh` 回写池凭据并在本账号重试 1 次；
 * - 遇到 401/402/403/429/5xx/网络异常自动 failover 切换同分片下一个候选账号（再跨分片回退）；
 * - 遇到 400 请求参数错误立即 fail-fast 停止换号。
 */
export async function executeMediaWithFailover<T>(
  env: Env,
  targets: readonly RealmTarget[],
  fn: (account: SelectedMediaAccount) => Promise<T>,
  options: FailoverOptions = {},
): Promise<FailoverSuccess<T>> {
  const now = options.now ?? Date.now()
  const maxPerRealm = options.maxAttemptsPerRealm ?? MAX_MEDIA_ATTEMPTS_PER_REALM
  const doRefresh = options.refreshImpl ?? defaultRefreshCredential

  let totalAttempts = 0
  let lastError: unknown
  let sawThreeDNoCred: ThreeDNoCredentialError | undefined
  const tried = new Set<string>()

  for (const target of targets) {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(target.realm))
    const candidates = await selectMediaCandidates(pool, target.realm, target.providerId, {
      now,
      requireCredits: options.requireCredits,
      exclude: tried,
    })

    let realmAttempts = 0
    for (const candidate of candidates) {
      if (realmAttempts >= maxPerRealm) break
      const triedKey = `${target.realm}:${candidate.uid}`
      if (tried.has(triedKey)) continue
      tried.add(triedKey)

      const rawCred = await pool.getCredential(candidate.uid)
      const cred = normalizePoolCredential(rawCred, candidate.uid, target.providerId, target.realm)
      if (cred === undefined) continue

      realmAttempts += 1
      totalAttempts += 1
      let activeAccount: SelectedMediaAccount = {
        uid: candidate.uid,
        realm: target.realm,
        providerId: target.providerId,
        credential: cred,
        pool,
      }

      try {
        const value = await fn(activeAccount)
        const creditCost = options.extractCredit?.(value)
        if (typeof pool.noteSuccess === 'function') {
          const t = pool
            .noteSuccess(candidate.uid, Date.now(), undefined, options.modelForStats, creditCost)
            .catch(() => {})
          if (options.ctx !== undefined) options.ctx.waitUntil(t)
          else void t
        }
        return { value, account: activeAccount, attempts: totalAttempts }
      } catch (firstError) {
        let finalError: unknown = firstError

        // 遇到 401 鉴权失败：先走 provider.refresh 刷新并回写池凭据，在当前账号重试一次
        if (isAuthFailure(firstError)) {
          try {
            const refreshed = await doRefresh(target.providerId, cred, env)
            if (refreshed !== undefined && refreshed.accessToken !== '' && refreshed.accessToken !== cred.accessToken) {
              if (typeof pool.putCredential === 'function') {
                await pool.putCredential(candidate.uid, refreshed, Date.now())
              }
              activeAccount = { ...activeAccount, credential: refreshed }
              const retryValue = await fn(activeAccount)
              const creditCost = options.extractCredit?.(retryValue)
              if (typeof pool.noteSuccess === 'function') {
                const t = pool
                  .noteSuccess(candidate.uid, Date.now(), undefined, options.modelForStats, creditCost)
                  .catch(() => {})
                if (options.ctx !== undefined) options.ctx.waitUntil(t)
                else void t
              }
              return { value: retryValue, account: activeAccount, attempts: totalAttempts }
            }
          } catch (refreshOrRetryErr) {
            finalError = refreshOrRetryErr
          }
        }

        if (finalError instanceof ThreeDNoCredentialError) {
          sawThreeDNoCred = finalError
          continue
        }

        // 请求自身的参数/内容合规错误：立即 fail-fast，不罚号、不继续打其他账号
        if (isClientBadRequest(finalError)) {
          throw finalError
        }

        lastError = finalError
        applyAccountPenaltyIfNeeded(pool, candidate.uid, finalError, Date.now(), options.ctx)
      }
    }
  }

  if (lastError !== undefined) {
    throw lastError
  }
  if (sawThreeDNoCred !== undefined) {
    throw sawThreeDNoCred
  }
  const needsIntl = targets.length === 1 && targets[0]?.realm === 'global'
  throw new NoAvailableMediaAccountError(
    needsIntl
      ? '这个网关没有可用的 WorkBuddy 国际版账号。生图、视频等能力需要国际版支持，请先在面板「供应商与账号」登录或解冻一个国际版账号再重试。'
      : '没有可用的健康账号（请先在面板登录国内或国际版账号，或检查账号是否处于冷却/熔断中）',
  )
}

// ─────────────────────── 统一面板日志与用量台账记账 ───────────────────────

function recordMediaAudit(input: {
  env: Env
  pool: DurableObjectStub<AccountPoolDO>
  uid: string
  providerId: string
  model: string
  status: number
  startedAt: number
  logType?: 'api' | 'error' | 'mcp'
  credit?: number
  errorText?: string
  recordUsageEntry?: boolean
  ctx?: ExecutionContext
}): void {
  const now = Date.now()
  const durationMs = Math.max(0, now - input.startedAt)
  const safeError = input.errorText !== undefined ? redactThreeDSecrets(input.errorText).slice(0, 200) : undefined

  if (typeof input.pool.appendLog === 'function') {
    recordLog(
      input.pool,
      {
        type: input.logType ?? (input.status >= 400 ? 'error' : 'api'),
        model: input.model,
        provider: input.providerId,
        uid: input.uid,
        status: input.status,
        durationMs,
        ...(safeError === undefined ? {} : { error: safeError }),
      },
      input.ctx,
    )
  }

  if (input.recordUsageEntry !== false && typeof input.pool.recordUsage === 'function') {
    const ok = input.status < 400
    const usageTask = input.pool
      .recordUsage({
        at: now,
        uid: input.uid,
        model: input.model,
        input: 0,
        output: 0,
        ok,
        ...(ok ? {} : { errorKind: safeError ?? `http_${input.status}` }),
        ms: durationMs,
      })
      .catch((err: unknown) => {
        console.error('[media-router] 记录用量失败：', err instanceof Error ? err.message : String(err))
      })
    if (input.ctx !== undefined) input.ctx.waitUntil(usageTask)
    else void usageTask
  }

  if (input.credit !== undefined && input.credit > 0) {
    // 若子密钥配置了 token 预算，将媒体积分按整数计入 output 侧（无子密钥时 WeakMap 零开销）
    settleSubkeyUsage(input.ctx, input.env, 0, Math.ceil(input.credit), input.model)
  }
}

// ─────────────────────── Realm 解析助手 ───────────────────────

export async function resolveMediaRealm(env: Env, url: URL): Promise<string> {
  const explicit = url.searchParams.get('realm')
  if (explicit !== null && explicit !== '') return explicit
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
    const accounts = await pool.listAccounts('global', Date.now())
    const hasIntl = accounts.some(
      (a) => !a.disabled && (a.provider ?? DEFAULT_PROVIDER) === WORKBUDDY_INTL.id,
    )
    return hasIntl ? 'global' : 'cn'
  } catch {
    return 'global'
  }
}

function buildDualRealmTargets(preferredRealm: string): RealmTarget[] {
  return preferredRealm === 'global'
    ? [
        { realm: 'global', providerId: WORKBUDDY_INTL.id },
        { realm: 'cn', providerId: DEFAULT_PROVIDER },
      ]
    : [
        { realm: 'cn', providerId: DEFAULT_PROVIDER },
        { realm: 'global', providerId: WORKBUDDY_INTL.id },
      ]
}

// ─────────────────────── 异步任务（视频 / 3D）原号查询与探测收养 ───────────────────────

function isTaskNotOwnedError(error: unknown): boolean {
  if (error instanceof UpstreamError) {
    if (
      error.httpStatus === 404
      || error.httpStatus === 400
      || error.httpStatus === 403
      || error.kind === 'not_found'
      || error.kind === 'bad_request'
    ) {
      return true
    }
  }
  const msg = error instanceof Error ? error.message : String(error)
  return /not.?found|404|not.?exist|invalid.*job|invalid.*task/i.test(msg)
}

async function callSingleOwnerWithRefresh<T>(
  env: Env,
  owner: { uid: string; realm: 'cn' | 'global'; providerId: string },
  fn: (account: SelectedMediaAccount) => Promise<T>,
  refreshImpl: RefreshFn = defaultRefreshCredential,
): Promise<{ value: T; account: SelectedMediaAccount }> {
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(owner.realm))
  const rawCred = await pool.getCredential(owner.uid)
  const cred = normalizePoolCredential(rawCred, owner.uid, owner.providerId, owner.realm)
  if (cred === undefined) {
    throw new TaskOwnerGoneError(owner.uid)
  }

  let account: SelectedMediaAccount = {
    uid: owner.uid,
    realm: owner.realm,
    providerId: owner.providerId,
    credential: cred,
    pool,
  }

  try {
    const value = await fn(account)
    return { value, account }
  } catch (error) {
    if (isAuthFailure(error)) {
      const refreshed = await refreshImpl(owner.providerId, cred, env).catch(() => undefined)
      if (refreshed !== undefined && refreshed.accessToken !== '' && refreshed.accessToken !== cred.accessToken) {
        if (typeof pool.putCredential === 'function') {
          await pool.putCredential(owner.uid, refreshed, Date.now())
        }
        account = { ...account, credential: refreshed }
        const retryVal = await fn(account)
        return { value: retryVal, account }
      }
    }
    throw error
  }
}

async function probeAndAdoptTask<T>(
  env: Env,
  kind: 'video' | '3d',
  taskId: string,
  targets: readonly RealmTarget[],
  ledger: MediaTaskLedger,
  defaultModel: string,
  fn: (account: SelectedMediaAccount) => Promise<T>,
  refreshImpl: RefreshFn = defaultRefreshCredential,
): Promise<{ value: T; account: SelectedMediaAccount }> {
  let probed = 0
  let sawThreeDNoCred: ThreeDNoCredentialError | undefined

  for (const target of targets) {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(target.realm))
    const accounts = await pool.listAccounts(target.realm, Date.now())
    for (const acc of accounts) {
      if (probed >= MAX_PROBE_ACCOUNTS) break
      if (acc.disabled) continue
      if ((acc.provider ?? DEFAULT_PROVIDER) !== target.providerId) continue

      const rawCred = await pool.getCredential(acc.uid)
      const cred = normalizePoolCredential(rawCred, acc.uid, target.providerId, target.realm)
      if (cred === undefined) continue

      probed += 1
      let selected: SelectedMediaAccount = {
        uid: acc.uid,
        realm: target.realm,
        providerId: target.providerId,
        credential: cred,
        pool,
      }

      try {
        const value = await fn(selected)
        ledger.adopt({
          kind,
          taskId,
          uid: acc.uid,
          realm: target.realm,
          providerId: target.providerId,
          model: defaultModel,
        })
        return { value, account: selected }
      } catch (firstErr) {
        let err: unknown = firstErr
        if (isAuthFailure(firstErr)) {
          try {
            const refreshed = await refreshImpl(target.providerId, cred, env)
            if (refreshed !== undefined && refreshed.accessToken !== '' && refreshed.accessToken !== cred.accessToken) {
              if (typeof pool.putCredential === 'function') {
                await pool.putCredential(acc.uid, refreshed, Date.now())
              }
              selected = { ...selected, credential: refreshed }
              const retryVal = await fn(selected)
              ledger.adopt({
                kind,
                taskId,
                uid: acc.uid,
                realm: target.realm,
                providerId: target.providerId,
                model: defaultModel,
              })
              return { value: retryVal, account: selected }
            }
          } catch (retryErr) {
            err = retryErr
          }
        }

        if (err instanceof ThreeDNoCredentialError) {
          sawThreeDNoCred = err
          continue
        }
        // 不是这个账号的任务（404/400/403）：绝不罚号，继续问下一个账号
        if (isTaskNotOwnedError(err) || isAuthFailure(err)) {
          continue
        }
        // 429 限流或 5xx 上游故障：立即停止盲探，不罚号，如实抛出
        throw err
      }
    }
  }

  if (sawThreeDNoCred !== undefined && probed > 0) {
    throw sawThreeDNoCred
  }
  throw new TaskNotFoundError(kind === '3d' ? ' 3D ' : '视频', taskId)
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ─────────────────────── 结构化媒体执行函数（HTTP 与 MCP 共用） ───────────────────────

export interface MediaExecutionHooks {
  ledger?: MediaTaskLedger
  refreshImpl?: RefreshFn
  threeDOptions?: ThreeDCallOptions
  pollIntervalMs?: number
  ctx?: ExecutionContext
  signal?: AbortSignal
  logType?: 'api' | 'mcp'
}

export async function runMediaImageGeneration(
  env: Env,
  input: { prompt: string; model?: string; size?: string; n?: number },
  hooks: MediaExecutionHooks = {},
): Promise<{ result: ImageGenResult; uid: string }> {
  const startedAt = Date.now()
  const modelName = (input.model ?? '').trim() || INTl_IMAGE_MODEL
  const globalPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))

  try {
    const { value, account } = await executeMediaWithFailover(
      env,
      [{ realm: 'global', providerId: WORKBUDDY_INTL.id }],
      (acc) => generateImage({ uid: acc.uid, accessToken: acc.credential.accessToken }, env, input),
      {
        requireCredits: true,
        modelForStats: modelName,
        extractCredit: (v) => (v as ImageGenResult).credit,
        refreshImpl: hooks.refreshImpl,
        ctx: hooks.ctx,
      },
    )
    recordMediaAudit({
      env,
      pool: account.pool,
      uid: account.uid,
      providerId: account.providerId,
      model: hooks.logType === 'mcp' ? 'mcp:generate_image' : modelName,
      status: 200,
      startedAt,
      logType: hooks.logType,
      credit: value.credit,
      ctx: hooks.ctx,
    })
    return { result: value, uid: account.uid }
  } catch (error) {
    const status = error instanceof NoAvailableMediaAccountError ? 503 : isClientBadRequest(error) ? 400 : 502
    recordMediaAudit({
      env,
      pool: globalPool,
      uid: 'unassigned',
      providerId: WORKBUDDY_INTL.id,
      model: hooks.logType === 'mcp' ? 'mcp:generate_image' : modelName,
      status,
      startedAt,
      logType: hooks.logType,
      errorText: error instanceof Error ? error.message : String(error),
      ctx: hooks.ctx,
    })
    throw error
  }
}

export async function runMediaImageEdit(
  env: Env,
  input: { prompt: string; image: string | string[]; model?: string; size?: string },
  hooks: MediaExecutionHooks = {},
): Promise<{ result: ImageGenResult; uid: string }> {
  const startedAt = Date.now()
  const modelName = (input.model ?? '').trim() || INTl_IMAGE_MODEL
  const globalPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))

  try {
    const { value, account } = await executeMediaWithFailover(
      env,
      [{ realm: 'global', providerId: WORKBUDDY_INTL.id }],
      (acc) => editImage({ uid: acc.uid, accessToken: acc.credential.accessToken }, env, input),
      {
        requireCredits: true,
        modelForStats: modelName,
        extractCredit: (v) => (v as ImageGenResult).credit,
        refreshImpl: hooks.refreshImpl,
        ctx: hooks.ctx,
      },
    )
    recordMediaAudit({
      env,
      pool: account.pool,
      uid: account.uid,
      providerId: account.providerId,
      model: hooks.logType === 'mcp' ? 'mcp:edit_image' : modelName,
      status: 200,
      startedAt,
      logType: hooks.logType,
      credit: value.credit,
      ctx: hooks.ctx,
    })
    return { result: value, uid: account.uid }
  } catch (error) {
    const status = error instanceof NoAvailableMediaAccountError ? 503 : isClientBadRequest(error) ? 400 : 502
    recordMediaAudit({
      env,
      pool: globalPool,
      uid: 'unassigned',
      providerId: WORKBUDDY_INTL.id,
      model: hooks.logType === 'mcp' ? 'mcp:edit_image' : modelName,
      status,
      startedAt,
      logType: hooks.logType,
      errorText: error instanceof Error ? error.message : String(error),
      ctx: hooks.ctx,
    })
    throw error
  }
}

export async function runMediaVideoSubmit(
  env: Env,
  input: {
    prompt: string
    model?: string
    seconds?: number
    aspectRatio?: string
    resolution?: string
    enableAudio?: boolean
    image?: string
    lastImage?: string
    wait?: boolean
    timeoutSeconds?: number
  },
  hooks: MediaExecutionHooks = {},
): Promise<{
  submitted: VideoSubmitResult
  completedTask?: VideoTaskResult
  uid: string
  model: string
}> {
  const startedAt = Date.now()
  const modelName = (input.model ?? '').trim() || INTl_VIDEO_MODEL
  const ledger = hooks.ledger ?? mediaTaskLedger
  const globalPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))

  let submitted: VideoSubmitResult
  let account: SelectedMediaAccount
  try {
    const res = await executeMediaWithFailover(
      env,
      [{ realm: 'global', providerId: WORKBUDDY_INTL.id }],
      (acc) => submitVideo({ uid: acc.uid, accessToken: acc.credential.accessToken }, env, input),
      {
        requireCredits: true,
        modelForStats: modelName,
        refreshImpl: hooks.refreshImpl,
        ctx: hooks.ctx,
      },
    )
    submitted = res.value
    account = res.account
  } catch (error) {
    const status = error instanceof NoAvailableMediaAccountError ? 503 : isClientBadRequest(error) ? 400 : 502
    recordMediaAudit({
      env,
      pool: globalPool,
      uid: 'unassigned',
      providerId: WORKBUDDY_INTL.id,
      model: hooks.logType === 'mcp' ? 'mcp:generate_video' : modelName,
      status,
      startedAt,
      logType: hooks.logType,
      errorText: error instanceof Error ? error.message : String(error),
      ctx: hooks.ctx,
    })
    throw error
  }

  ledger.register({
    kind: 'video',
    taskId: submitted.taskId,
    uid: account.uid,
    realm: account.realm,
    providerId: account.providerId,
    model: modelName,
  })

  if (!input.wait) {
    // 异步提交成功：记录请求日志与请求次数（积分待任务终态查询时幂等结算）
    recordMediaAudit({
      env,
      pool: account.pool,
      uid: account.uid,
      providerId: account.providerId,
      model: hooks.logType === 'mcp' ? 'mcp:generate_video' : modelName,
      status: 200,
      startedAt,
      logType: hooks.logType,
      ctx: hooks.ctx,
    })
    return { submitted, uid: account.uid, model: modelName }
  }

  const timeoutSec = typeof input.timeoutSeconds === 'number' && input.timeoutSeconds > 0
    ? Math.min(Math.trunc(input.timeoutSeconds), MAX_WAIT_TIMEOUT_SECONDS)
    : MAX_WAIT_TIMEOUT_SECONDS
  const deadline = Date.now() + timeoutSec * 1000
  const pollInterval = hooks.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS

  let latestTask: VideoTaskResult | undefined
  while (Date.now() < deadline) {
    if (hooks.signal?.aborted) {
      throw hooks.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    }
    const queried = await runMediaVideoQuery(env, submitted.taskId, {
      ...hooks,
      ledger,
      // 轮询子步由外层合并或按完成结算，不在每次中间轮询刷屏重复 usage
      skipAuditLog: true,
    })
    latestTask = queried.task
    if (latestTask.status === 'completed' || latestTask.status === 'failed') {
      break
    }
    if (Date.now() + pollInterval > deadline) break
    await sleepWithAbort(pollInterval, hooks.signal)
  }

  recordMediaAudit({
    env,
    pool: account.pool,
    uid: account.uid,
    providerId: account.providerId,
    model: hooks.logType === 'mcp' ? 'mcp:generate_video' : modelName,
    status: 200,
    startedAt,
    logType: hooks.logType,
    credit: latestTask?.credit,
    recordUsageEntry: false, // 终态已在 runMediaVideoQuery 内幂等记过或尚未出片
    ctx: hooks.ctx,
  })
  return { submitted, completedTask: latestTask, uid: account.uid, model: modelName }
}

export async function runMediaVideoQuery(
  env: Env,
  taskId: string,
  hooks: MediaExecutionHooks & { skipAuditLog?: boolean } = {},
): Promise<{ task: VideoTaskResult; uid: string; model: string; newlyBilled: boolean }> {
  const startedAt = Date.now()
  const ledger = hooks.ledger ?? mediaTaskLedger
  const owner = ledger.get('video', taskId)

  const outcome = await ledger.pollShared('video', taskId, hooks.signal, async () => {
    if (owner !== undefined) {
      return await callSingleOwnerWithRefresh(
        env,
        owner,
        (acc) => getVideoTask({ uid: acc.uid, accessToken: acc.credential.accessToken }, env, taskId),
        hooks.refreshImpl,
      )
    }
    return await probeAndAdoptTask(
      env,
      'video',
      taskId,
      [{ realm: 'global', providerId: WORKBUDDY_INTL.id }],
      ledger,
      INTl_VIDEO_MODEL,
      (acc) => getVideoTask({ uid: acc.uid, accessToken: acc.credential.accessToken }, env, taskId),
      hooks.refreshImpl,
    )
  })

  const activeOwner = ledger.get('video', taskId)
  const modelName = activeOwner?.model || INTl_VIDEO_MODEL
  let effectiveCredit = outcome.value.credit
  let newlyBilled = false

  if (outcome.value.status === 'completed') {
    if (effectiveCredit !== undefined && effectiveCredit > 0) {
      newlyBilled = ledger.claimBilling('video', taskId, effectiveCredit)
      if (newlyBilled) {
        if (typeof outcome.account.pool.noteSuccess === 'function') {
          const t = outcome.account.pool
            .noteSuccess(outcome.account.uid, Date.now(), undefined, modelName, effectiveCredit)
            .catch(() => {})
          if (hooks.ctx !== undefined) hooks.ctx.waitUntil(t)
          else void t
        }
        recordMediaAudit({
          env,
          pool: outcome.account.pool,
          uid: outcome.account.uid,
          providerId: outcome.account.providerId,
          model: hooks.logType === 'mcp' ? 'mcp:get_video_task' : modelName,
          status: 200,
          startedAt,
          logType: hooks.logType,
          credit: effectiveCredit,
          recordUsageEntry: true,
          ctx: hooks.ctx,
        })
      }
    }
    if (effectiveCredit === undefined) {
      effectiveCredit = ledger.cachedCredit('video', taskId)
    }
  }

  if (!newlyBilled && !hooks.skipAuditLog) {
    // 非首次记账的轮询：记录面板日志供可观测排查，但不重复累加积分与计费台账
    recordMediaAudit({
      env,
      pool: outcome.account.pool,
      uid: outcome.account.uid,
      providerId: outcome.account.providerId,
      model: hooks.logType === 'mcp' ? 'mcp:get_video_task' : modelName,
      status: 200,
      startedAt,
      logType: hooks.logType,
      recordUsageEntry: false,
      ctx: hooks.ctx,
    })
  }

  const finalTask: VideoTaskResult = {
    ...outcome.value,
    credit: effectiveCredit,
  }
  return { task: finalTask, uid: outcome.account.uid, model: modelName, newlyBilled }
}

export function formatThreeDTaskPayload(
  jobId: string,
  state: ThreeDState,
  model: string,
  cachedCredit?: number,
): Record<string, unknown> {
  const effectiveModel = model || THREE_D_DEFAULT_MODEL
  const effectiveId = state.jobId || jobId
  const out: Record<string, unknown> = {
    id: effectiveId,
    job_id: effectiveId,
    object: '3d.task',
    status: state.status || 'SUBMITTED',
    model: effectiveModel,
  }
  if (state.requestId !== '') out.request_id = state.requestId
  if (state.resultUrl !== '') out.result_url = state.resultUrl
  if (state.resultFiles.length > 0) out.result_files = state.resultFiles
  if (Object.keys(state.rawResult).length > 0) out.raw_result = state.rawResult

  const credit = state.credit !== undefined && state.credit > 0 ? state.credit : cachedCredit
  if (credit !== undefined && credit > 0) {
    out.usage = { credit }
  }
  if (state.errorText !== '') {
    out.error = { message: state.errorText }
  }
  if (isThreeDSucceeded(state.status)) {
    out.hint = '3D 产物是腾讯云 COS 签名直链（约 24 小时有效），请尽快下载 GLB/OBJ 等文件保存。'
  } else if (!isThreeDDone(state.status)) {
    out.hint = '已提交。请使用 POST /v1/3d/tasks {"job_id":"…"} 或 MCP get_3d_task 按原 job_id 轮询进度，切勿重复提交。'
  }
  return out
}

export async function runMediaThreeDSubmit(
  env: Env,
  reqBody: Record<string, unknown>,
  options: {
    preferredRealm?: string
    explicitRealm?: string | null
  } & MediaExecutionHooks = {},
): Promise<{
  state: ThreeDState
  uid: string
  realm: 'cn' | 'global'
  model: string
  timedOutWaiting?: boolean
}> {
  const startedAt = Date.now()
  // 先本地严格校验参数约束（不通过直接抛错，零上游调用、不换号）
  const { model } = buildThreeDUpstreamBody(reqBody)
  const ledger = options.ledger ?? mediaTaskLedger

  const explicit = options.explicitRealm ?? (typeof reqBody.realm === 'string' ? reqBody.realm.trim() : '')
  const targets: RealmTarget[] = explicit === 'cn'
    ? [{ realm: 'cn', providerId: DEFAULT_PROVIDER }]
    : explicit === 'global'
      ? [{ realm: 'global', providerId: WORKBUDDY_INTL.id }]
      : buildDualRealmTargets(options.preferredRealm ?? 'global')

  const primaryPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(targets[0]?.realm ?? 'global'))

  let state: ThreeDState
  let account: SelectedMediaAccount
  try {
    const res = await executeMediaWithFailover(
      env,
      targets,
      async (acc) => {
        const enterpriseId = acc.credential.extras?.enterpriseId || acc.credential.extras?.enterprise_id
        const domain = acc.credential.extras?.domain
        const out = await submitThreeDJob(
          {
            uid: acc.uid,
            accessToken: acc.credential.accessToken,
            realm: acc.realm,
            ...(domain ? { domain } : {}),
            ...(enterpriseId ? { enterpriseId } : {}),
          },
          env,
          reqBody,
          {
            ...options.threeDOptions,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        )
        return out.state
      },
      {
        requireCredits: true,
        modelForStats: THREE_D_MODEL_ID,
        refreshImpl: options.refreshImpl,
        ctx: options.ctx,
      },
    )
    state = res.value
    account = res.account
  } catch (error) {
    const status =
      error instanceof ThreeDNoCredentialError || error instanceof NoAvailableMediaAccountError
        ? 503
        : isClientBadRequest(error)
          ? 400
          : 502
    recordMediaAudit({
      env,
      pool: primaryPool,
      uid: 'unassigned',
      providerId: targets[0]?.providerId ?? WORKBUDDY_INTL.id,
      model: options.logType === 'mcp' ? 'mcp:generate_3d' : `${THREE_D_MODEL_ID}-${model}`,
      status,
      startedAt,
      logType: options.logType,
      errorText: error instanceof Error ? error.message : String(error),
      ctx: options.ctx,
    })
    throw error
  }

  if (state.jobId !== '') {
    ledger.register({
      kind: '3d',
      taskId: state.jobId,
      uid: account.uid,
      realm: account.realm,
      providerId: account.providerId,
      model,
    })
  }

  const wantWait = reqBody.wait === true
  if (!wantWait || state.jobId === '' || isThreeDDone(state.status)) {
    let billedCredit: number | undefined
    if (isThreeDDone(state.status) && state.credit !== undefined && state.credit > 0) {
      if (state.jobId === '' || ledger.claimBilling('3d', state.jobId, state.credit)) {
        billedCredit = state.credit
        if (typeof account.pool.noteSuccess === 'function') {
          const t = account.pool
            .noteSuccess(account.uid, Date.now(), undefined, THREE_D_MODEL_ID, billedCredit)
            .catch(() => {})
          if (options.ctx !== undefined) options.ctx.waitUntil(t)
          else void t
        }
      }
    }
    recordMediaAudit({
      env,
      pool: account.pool,
      uid: account.uid,
      providerId: account.providerId,
      model: options.logType === 'mcp' ? 'mcp:generate_3d' : `${THREE_D_MODEL_ID}-${model}`,
      status: 200,
      startedAt,
      logType: options.logType,
      credit: billedCredit,
      ctx: options.ctx,
    })
    return { state, uid: account.uid, realm: account.realm, model }
  }

  const rawTimeout = typeof reqBody.timeout_seconds === 'number' ? reqBody.timeout_seconds : MAX_WAIT_TIMEOUT_SECONDS
  const timeoutSec = rawTimeout > 0
    ? Math.min(Math.trunc(rawTimeout), MAX_WAIT_TIMEOUT_SECONDS)
    : MAX_WAIT_TIMEOUT_SECONDS
  const deadline = Date.now() + timeoutSec * 1000
  const pollInterval = options.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS

  let latest = state
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    }
    const polled = await runMediaThreeDQuery(env, state.jobId, {
      ...options,
      ledger,
      skipAuditLog: true,
    })
    latest = polled.state
    if (isThreeDDone(latest.status)) {
      recordMediaAudit({
        env,
        pool: account.pool,
        uid: account.uid,
        providerId: account.providerId,
        model: options.logType === 'mcp' ? 'mcp:generate_3d' : `${THREE_D_MODEL_ID}-${model}`,
        status: 200,
        startedAt,
        logType: options.logType,
        recordUsageEntry: false,
        ctx: options.ctx,
      })
      return { state: latest, uid: account.uid, realm: account.realm, model }
    }
    if (Date.now() + pollInterval > deadline) break
    await sleepWithAbort(pollInterval, options.signal)
  }

  recordMediaAudit({
    env,
    pool: account.pool,
    uid: account.uid,
    providerId: account.providerId,
    model: options.logType === 'mcp' ? 'mcp:generate_3d' : `${THREE_D_MODEL_ID}-${model}`,
    status: 202,
    startedAt,
    logType: options.logType,
    recordUsageEntry: false,
    ctx: options.ctx,
  })
  return { state: latest, uid: account.uid, realm: account.realm, model, timedOutWaiting: true }
}

export async function runMediaThreeDQuery(
  env: Env,
  jobId: string,
  options: { preferredRealm?: string; skipAuditLog?: boolean } & MediaExecutionHooks = {},
): Promise<{
  state: ThreeDState
  uid: string
  model: string
  newlyBilled: boolean
  cachedCredit?: number
}> {
  const startedAt = Date.now()
  const ledger = options.ledger ?? mediaTaskLedger
  const owner = ledger.get('3d', jobId)

  const callQuery = async (acc: SelectedMediaAccount): Promise<ThreeDState> => {
    const enterpriseId = acc.credential.extras?.enterpriseId || acc.credential.extras?.enterprise_id
    const domain = acc.credential.extras?.domain
    return await queryThreeDJob(
      {
        uid: acc.uid,
        accessToken: acc.credential.accessToken,
        realm: acc.realm,
        ...(domain ? { domain } : {}),
        ...(enterpriseId ? { enterpriseId } : {}),
      },
      env,
      jobId,
      {
        ...options.threeDOptions,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
  }

  const outcome = await ledger.pollShared('3d', jobId, options.signal, async () => {
    if (owner !== undefined) {
      return await callSingleOwnerWithRefresh(env, owner, callQuery, options.refreshImpl)
    }
    return await probeAndAdoptTask(
      env,
      '3d',
      jobId,
      buildDualRealmTargets(options.preferredRealm ?? 'global'),
      ledger,
      THREE_D_DEFAULT_MODEL,
      callQuery,
      options.refreshImpl,
    )
  })

  const activeOwner = ledger.get('3d', jobId)
  const model = activeOwner?.model || THREE_D_DEFAULT_MODEL
  let newlyBilled = false

  if (isThreeDDone(outcome.value.status) && outcome.value.credit !== undefined && outcome.value.credit > 0) {
    newlyBilled = ledger.claimBilling('3d', jobId, outcome.value.credit)
    if (newlyBilled) {
      if (typeof outcome.account.pool.noteSuccess === 'function') {
        const t = outcome.account.pool
          .noteSuccess(outcome.account.uid, Date.now(), undefined, THREE_D_MODEL_ID, outcome.value.credit)
          .catch(() => {})
        if (options.ctx !== undefined) options.ctx.waitUntil(t)
        else void t
      }
      recordMediaAudit({
        env,
        pool: outcome.account.pool,
        uid: outcome.account.uid,
        providerId: outcome.account.providerId,
        model: options.logType === 'mcp' ? 'mcp:get_3d_task' : `${THREE_D_MODEL_ID}-${model}`,
        status: 200,
        startedAt,
        logType: options.logType,
        credit: outcome.value.credit,
        recordUsageEntry: true,
        ctx: options.ctx,
      })
    }
  }

  const cachedCredit = ledger.cachedCredit('3d', jobId)

  if (!newlyBilled && !options.skipAuditLog) {
    recordMediaAudit({
      env,
      pool: outcome.account.pool,
      uid: outcome.account.uid,
      providerId: outcome.account.providerId,
      model: options.logType === 'mcp' ? 'mcp:get_3d_task' : `${THREE_D_MODEL_ID}-${model}`,
      status: 200,
      startedAt,
      logType: options.logType,
      recordUsageEntry: false,
      ctx: options.ctx,
    })
  }

  return {
    state: outcome.value,
    uid: outcome.account.uid,
    model,
    newlyBilled,
    ...(cachedCredit === undefined ? {} : { cachedCredit }),
  }
}

export async function runMediaSearch(
  env: Env,
  input: { query: string; count?: number; maxResults?: number; rerank?: boolean },
  options: { targets?: readonly RealmTarget[] } & MediaExecutionHooks = {},
): Promise<{ result: SearchResult; uid: string }> {
  const startedAt = Date.now()
  const targets = options.targets ?? [{ realm: 'global', providerId: WORKBUDDY_INTL.id }]
  const primaryPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(targets[0]?.realm ?? 'global'))

  try {
    const { value, account } = await executeMediaWithFailover(
      env,
      targets,
      (acc) => {
        const enterpriseId = acc.credential.extras?.enterpriseId || acc.credential.extras?.enterprise_id
        return webSearch(
          {
            uid: acc.uid,
            accessToken: acc.credential.accessToken,
            realm: acc.realm,
            ...(enterpriseId ? { enterpriseId } : {}),
          },
          env,
          input,
        )
      },
      {
        requireCredits: false,
        modelForStats: 'web_search',
        refreshImpl: options.refreshImpl,
        ctx: options.ctx,
      },
    )
    recordMediaAudit({
      env,
      pool: account.pool,
      uid: account.uid,
      providerId: account.providerId,
      model: options.logType === 'mcp' ? 'mcp:web_search' : 'web_search',
      status: 200,
      startedAt,
      logType: options.logType,
      ctx: options.ctx,
    })
    return { result: value, uid: account.uid }
  } catch (error) {
    const status = error instanceof NoAvailableMediaAccountError ? 503 : isClientBadRequest(error) ? 400 : 502
    recordMediaAudit({
      env,
      pool: primaryPool,
      uid: 'unassigned',
      providerId: targets[0]?.providerId ?? WORKBUDDY_INTL.id,
      model: options.logType === 'mcp' ? 'mcp:web_search' : 'web_search',
      status,
      startedAt,
      logType: options.logType,
      errorText: error instanceof Error ? error.message : String(error),
      ctx: options.ctx,
    })
    throw error
  }
}

export async function runMediaFetch(
  env: Env,
  input: { url: string; prompt?: string },
  options: { targets?: readonly RealmTarget[] } & MediaExecutionHooks = {},
): Promise<{ result: FetchResult; uid: string }> {
  const startedAt = Date.now()
  const targets = options.targets ?? [{ realm: 'global', providerId: WORKBUDDY_INTL.id }]
  const primaryPool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(targets[0]?.realm ?? 'global'))

  try {
    const { value, account } = await executeMediaWithFailover(
      env,
      targets,
      (acc) => {
        const enterpriseId = acc.credential.extras?.enterpriseId || acc.credential.extras?.enterprise_id
        return webFetch(
          {
            uid: acc.uid,
            accessToken: acc.credential.accessToken,
            realm: acc.realm,
            ...(enterpriseId ? { enterpriseId } : {}),
          },
          env,
          input,
        )
      },
      {
        requireCredits: false,
        modelForStats: 'web_fetch',
        refreshImpl: options.refreshImpl,
        ctx: options.ctx,
      },
    )
    recordMediaAudit({
      env,
      pool: account.pool,
      uid: account.uid,
      providerId: account.providerId,
      model: options.logType === 'mcp' ? 'mcp:web_fetch' : 'web_fetch',
      status: 200,
      startedAt,
      logType: options.logType,
      ctx: options.ctx,
    })
    return { result: value, uid: account.uid }
  } catch (error) {
    const status = error instanceof NoAvailableMediaAccountError ? 503 : isClientBadRequest(error) ? 400 : 502
    recordMediaAudit({
      env,
      pool: primaryPool,
      uid: 'unassigned',
      providerId: targets[0]?.providerId ?? WORKBUDDY_INTL.id,
      model: options.logType === 'mcp' ? 'mcp:web_fetch' : 'web_fetch',
      status,
      startedAt,
      logType: options.logType,
      errorText: error instanceof Error ? error.message : String(error),
      ctx: options.ctx,
    })
    throw error
  }
}

// ─────────────────────── REST HTTP Handlers（供 src/index.ts 一行转发） ───────────────────────

async function parseJsonObjectBody(
  request: Request,
  limit = MAX_REQUEST_BYTES,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const parsed = await readJsonCapped(request, limit)
    if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: jsonError(400, '请求体必须是合法的 JSON 对象', 'invalid_request') }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { ok: false, response: jsonError(413, error.message, 'payload_too_large') }
    }
    return { ok: false, response: jsonError(400, '请求体不是合法 JSON', 'invalid_request') }
  }
}

function mapMediaErrorToResponse(error: unknown, fallbackNoAccountMsg?: string): Response {
  if (error instanceof NoAvailableMediaAccountError) {
    return jsonError(503, fallbackNoAccountMsg ?? error.message, 'no_available_account')
  }
  if (error instanceof ThreeDNoCredentialError) {
    return jsonError(503, error.message, 'three_d_credential_missing')
  }
  if (error instanceof TaskOwnerGoneError || error instanceof TaskNotFoundError) {
    return jsonError(404, error.message, 'task_not_found')
  }
  if (error instanceof UpstreamError) {
    if (isClientBadRequest(error)) {
      return jsonError(400, redactThreeDSecrets(error.message), 'invalid_request')
    }
    if (error.httpStatus === 429 || error.kind === 'rate_limited') {
      return jsonError(429, redactThreeDSecrets(error.message), 'rate_limit_error')
    }
    return jsonError(502, redactThreeDSecrets(error.message), 'upstream_error')
  }
  const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
  return jsonError(502, msg, 'upstream_error')
}

/** `POST /v1/images/generations` */
export async function handleImageGenerations(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const url = new URL(request.url)
  const realm = await resolveMediaRealm(env, url)
  if (!mediaCapable(realm)) {
    return jsonError(
      400,
      `图像生成目前只有**国际版**账号支持（${realm} 分片实测返回 401）。`
        + '请用 `?realm=global` 调用，或在面板添加 WorkBuddy 国际版账号。',
      'unsupported_realm',
    )
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return jsonError(400, 'prompt 必填', 'invalid_request')

  try {
    const { result: r } = await runMediaImageGeneration(
      env,
      {
        prompt,
        ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
        ...(typeof body.size === 'string' && body.size !== '' ? { size: body.size } : {}),
        ...(typeof body.n === 'number' ? { n: body.n } : {}),
      },
      { ctx, signal: request.signal },
    )
    if (r.images.length === 0) {
      return jsonError(502, '上游返回成功但没有图片（响应里 data 为空）', 'upstream_error')
    }
    return json({
      created: r.created,
      data: r.images,
      ...(r.credit === undefined ? {} : { usage: { credit: r.credit } }),
    })
  } catch (error) {
    return mapMediaErrorToResponse(error, '没有可用的国际版账号（请先在面板登录）')
  }
}

/** `POST /v1/images/edits` */
export async function handleImageEdits(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const url = new URL(request.url)
  const realm = await resolveMediaRealm(env, url)
  if (!mediaCapable(realm)) {
    return jsonError(400, `图像编辑目前只有**国际版**账号支持（${realm} 分片实测返回 401）。`, 'unsupported_realm')
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const rawImage = body.image
  const images: string[] = Array.isArray(rawImage)
    ? rawImage.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : typeof rawImage === 'string' && rawImage.trim() !== ''
      ? [rawImage.trim()]
      : []

  if (prompt === '') return jsonError(400, 'prompt 必填', 'invalid_request')
  if (images.length === 0) {
    return jsonError(
      400,
      'image 必填。**本网关不会替你下载图片** —— 请传公网可访问的 URL 或 `data:` URL，上游要能直接取到它。',
      'invalid_request',
    )
  }
  const bad = images.find((x) => !/^(https?:\/\/|data:image\/)/i.test(x))
  if (bad !== undefined) {
    return jsonError(
      400,
      'image 必须是 http(s) URL 或 `data:image/...;base64,...`。如果是本地图片，前端可以用 FileReader 读成 data URL 再传。',
      'invalid_request',
    )
  }

  try {
    const { result: r } = await runMediaImageEdit(
      env,
      {
        prompt,
        image: images,
        ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
        ...(typeof body.size === 'string' && body.size !== '' ? { size: body.size } : {}),
      },
      { ctx, signal: request.signal },
    )
    if (r.images.length === 0) return jsonError(502, '上游返回成功但没有图片', 'upstream_error')
    return json({
      created: r.created,
      data: r.images,
      ...(r.credit === undefined ? {} : { usage: { credit: r.credit } }),
    })
  } catch (error) {
    return mapMediaErrorToResponse(error, '没有可用的国际版账号')
  }
}

/** `POST /v1/videos/generations` */
export async function handleVideoGenerations(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const url = new URL(request.url)
  const realm = await resolveMediaRealm(env, url)
  if (!mediaCapable(realm)) {
    return jsonError(400, `视频生成目前只有**国际版**账号支持（${realm} 分片实测返回 401）。`, 'unsupported_realm')
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return jsonError(400, 'prompt 必填', 'invalid_request')

  const pickImage = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  const firstImage = pickImage(body.image)
  const lastImage = pickImage(body.last_image)
  for (const [name, imgUrl] of [['image', firstImage], ['last_image', lastImage]] as const) {
    if (imgUrl !== undefined && !/^(https?:\/\/|data:image\/)/i.test(imgUrl)) {
      return jsonError(400, `${name} 必须是 http(s) URL 或 \`data:image/...;base64,...\`。`, 'invalid_request')
    }
  }

  try {
    const { submitted, completedTask } = await runMediaVideoSubmit(
      env,
      {
        prompt,
        ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
        ...(typeof body.seconds === 'number' ? { seconds: body.seconds } : {}),
        ...(typeof body.aspect_ratio === 'string' && body.aspect_ratio !== ''
          ? { aspectRatio: body.aspect_ratio }
          : {}),
        ...(typeof body.resolution === 'string' && body.resolution !== ''
          ? { resolution: body.resolution }
          : {}),
        ...(typeof body.enable_audio === 'boolean' ? { enableAudio: body.enable_audio } : {}),
        ...(firstImage === undefined ? {} : { image: firstImage }),
        ...(lastImage === undefined ? {} : { lastImage }),
        ...(typeof body.wait === 'boolean' ? { wait: body.wait } : {}),
        ...(typeof body.timeout_seconds === 'number' ? { timeoutSeconds: body.timeout_seconds } : {}),
      },
      { ctx, signal: request.signal },
    )

    if (completedTask !== undefined) {
      const r = completedTask
      return json({
        id: r.taskId,
        object: 'video',
        status: r.status,
        ...(r.urls.length === 0 ? {} : { data: r.urls.map((u) => ({ url: u })) }),
        ...(r.durationSeconds === undefined ? {} : { seconds: r.durationSeconds }),
        ...(r.credit === undefined ? {} : { usage: { credit: r.credit } }),
        ...(r.error === undefined ? {} : { error: { message: r.error } }),
        ...(r.status === 'completed'
          ? { hint: '视频是签名直链（约 12 小时有效），需要请立即下载。' }
          : {}),
      })
    }

    return json({
      id: submitted.taskId,
      object: 'video',
      status: submitted.status,
      hint:
        '已提交。用 POST /v1/videos/tasks {"task_id":"…"} 查状态，通常 60–120 秒出片。'
        + '⚠️ 涉政 / 真实领导人 / 敏感事件等题材会被上游内容审核拒绝（返回 failed 与原因，不扣积分）；'
        + '普通题材（动物 / 静物 / 风景）不受影响。',
    })
  } catch (error) {
    return mapMediaErrorToResponse(error, '没有可用的国际版账号')
  }
}

/** `POST /v1/videos/tasks` */
export async function handleVideoTasks(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const rawId = typeof body.task_id === 'string' && body.task_id.trim() !== ''
    ? body.task_id
    : typeof body.id === 'string'
      ? body.id
      : ''
  const taskId = rawId.trim()
  if (taskId === '') return jsonError(400, 'task_id 必填', 'invalid_request')

  const url = new URL(request.url)
  const realm = await resolveMediaRealm(env, url)
  if (!mediaCapable(realm)) {
    return jsonError(400, `视频生成目前只有**国际版**账号支持（${realm} 分片实测返回 401）。`, 'unsupported_realm')
  }

  try {
    const { task: r } = await runMediaVideoQuery(env, taskId, { ctx, signal: request.signal })
    return json({
      id: r.taskId,
      object: 'video',
      status: r.status,
      ...(r.urls.length === 0 ? {} : { data: r.urls.map((u) => ({ url: u })) }),
      ...(r.durationSeconds === undefined ? {} : { seconds: r.durationSeconds }),
      ...(r.credit === undefined ? {} : { usage: { credit: r.credit } }),
      ...(r.error === undefined ? {} : { error: { message: r.error } }),
      ...(r.status === 'completed'
        ? { hint: '视频是签名直链（约 12 小时有效），需要请立即下载。' }
        : {}),
    })
  } catch (error) {
    return mapMediaErrorToResponse(error, '没有可用的国际版账号')
  }
}

/** `POST /v1/3d/generations` */
export async function handleThreeDGenerations(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request, THREE_D_MAX_BODY_BYTES)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  try {
    buildThreeDUpstreamBody(body)
  } catch (validationErr) {
    return jsonError(
      400,
      validationErr instanceof Error ? validationErr.message : String(validationErr),
      'invalid_request',
    )
  }

  const url = new URL(request.url)
  const explicitRealm = url.searchParams.get('realm')
  const preferredRealm = await resolveMediaRealm(env, url)

  try {
    const { state, model, timedOutWaiting } = await runMediaThreeDSubmit(env, body, {
      preferredRealm,
      explicitRealm,
      ctx,
      signal: request.signal,
    })
    const cachedCredit = state.jobId !== '' ? mediaTaskLedger.cachedCredit('3d', state.jobId) : undefined
    const payload = formatThreeDTaskPayload(state.jobId, state, model, cachedCredit)
    return json(payload, timedOutWaiting ? 202 : 200)
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 })
    }
    return mapMediaErrorToResponse(error)
  }
}

/** `POST /v1/3d/tasks` */
export async function handleThreeDTasks(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request, 64 * 1024)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const rawId = typeof body.job_id === 'string' && body.job_id.trim() !== ''
    ? body.job_id
    : typeof body.id === 'string' && body.id.trim() !== ''
      ? body.id
      : typeof body.task_id === 'string'
        ? body.task_id
        : ''
  const jobId = rawId.trim()
  if (jobId === '') return jsonError(400, 'job_id 必填', 'invalid_request')

  const url = new URL(request.url)
  const preferredRealm = await resolveMediaRealm(env, url)

  try {
    const { state, model, cachedCredit } = await runMediaThreeDQuery(env, jobId, {
      preferredRealm,
      ctx,
      signal: request.signal,
    })
    return json(formatThreeDTaskPayload(jobId, state, model, cachedCredit))
  } catch (error) {
    return mapMediaErrorToResponse(error)
  }
}

/** `GET /v1/3d/{job_id}` */
export async function handleThreeDJobGet(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  jobIdOverride?: string,
): Promise<Response> {
  const url = new URL(request.url)
  const rawFromPath = url.pathname.startsWith('/v1/3d/')
    ? decodeURIComponent(url.pathname.slice('/v1/3d/'.length))
    : ''
  const jobId = (jobIdOverride ?? rawFromPath).trim()
  if (jobId === '' || jobId === 'generations' || jobId === 'tasks' || jobId.includes('/')) {
    return jsonError(400, 'job_id 必填且格式必须合法', 'invalid_request')
  }

  const preferredRealm = await resolveMediaRealm(env, url)
  try {
    const { state, model, cachedCredit } = await runMediaThreeDQuery(env, jobId, {
      preferredRealm,
      ctx,
      signal: request.signal,
    })
    return json(formatThreeDTaskPayload(jobId, state, model, cachedCredit))
  } catch (error) {
    return mapMediaErrorToResponse(error)
  }
}

/** `POST /v1/search` */
export async function handleSearch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (query === '') return jsonError(400, 'query 不能为空', 'invalid_request_error')

  const countRaw = body.count ?? body.max_results
  const maxResults = typeof countRaw === 'number' && countRaw > 0 ? Math.min(countRaw, 20) : 5
  const rerank = typeof body.rerank === 'boolean' ? body.rerank : true

  const url = new URL(request.url)
  const preferredRealm = await resolveMediaRealm(env, url)
  const targets = buildDualRealmTargets(preferredRealm)

  try {
    const { result: r } = await runMediaSearch(
      env,
      { query, count: maxResults, rerank },
      { targets, ctx, signal: request.signal },
    )
    return json({
      query: r.query,
      results: r.results,
      ...(r.total === undefined ? {} : { total_results: r.total }),
    })
  } catch (error) {
    return mapMediaErrorToResponse(error, '没有可用的搜索凭据（请先登录国内或国际版账号）')
  }
}

/** `POST /v1/fetch` */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const parsed = await parseJsonObjectBody(request)
  if (!parsed.ok) return parsed.response
  const { body } = parsed

  const target = typeof body.url === 'string' ? body.url.trim() : ''
  if (!/^https?:\/\//i.test(target)) {
    return jsonError(400, 'url 必须是 http(s) 绝对地址', 'invalid_request_error')
  }
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() !== '' ? body.prompt.trim() : undefined

  const url = new URL(request.url)
  const preferredRealm = await resolveMediaRealm(env, url)
  const targets = buildDualRealmTargets(preferredRealm)

  try {
    const { result: r } = await runMediaFetch(
      env,
      { url: target, ...(prompt === undefined ? {} : { prompt }) },
      { targets, ctx, signal: request.signal },
    )
    return json({ url: r.url, title: r.title, content: r.content })
  } catch (error) {
    return mapMediaErrorToResponse(error, '没有可用的抓取凭据（请先登录国内或国际版账号）')
  }
}
