/**
 * 运营活动任务查询与领奖模块（`/portal/activity/...`，小程序口径）。
 *
 * ## 协议背景（对齐社区实测 `misakano7545/workbuddy2api-panel` 提交 `0fadf98` / `1c007bb` / `93bbef3` / `56f7631`）
 *
 * 1. **活动根路径默认无子模块前缀**（`1c007bb` 实测修正）：
 *    真实星巴克 / 新闻官等运营活动挂在 `/portal/activity/tasks?activity_code=<代码>`，
 *    而 `/portal/activity/campaign/tasks` 虽然返回 HTTP 200 `code:0`，但 `data.tasks` 恒为空。
 *    因此 `module` 默认空串 `""`（拼为 `/portal/activity`），非空时才拼 `/portal/activity/<module>`。
 * 2. **进度数组独立下发，必须按 `task_code` 合并**：
 *    `GET /portal/activity/tasks` 返回 `{ tasks: [...], progress: [...] }` 两张表；
 *    账号当前进度、已读时刻、领奖时刻都在 `progress[]` 里，不合并会导致所有任务进度恒为 0。
 * 3. **已达标未领（`ready`）判据**（`93bbef3`）：
 *    `target > 0 && status !== 'claimed' && claimedAt === '' && progress >= target`。
 *    已领取项必须严格过滤，避免重复触发写请求。
 * 4. **领奖顺序与默认安全闸门**：
 *    先调 `POST .../tasks/<code>/viewed`（失败不阻断），再调 `POST .../tasks/<code>/claim`。
 *    批量领奖入口 `claimAccountCampaignTasks` **默认 `dryRun = true`**（只预演 `wouldClaim` 不写上游），
 *    仅显式传 `dryRun: false` 才真正发 `viewed` + `claim`。
 *    上游业务码 `12304`（条件未满足）归入 `skipped` 而非硬错误。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify } from './client.js'
import type { HeaderMap } from './headers.js'

/** 默认活动模块路径段（空串表示直挂 `/portal/activity`，不加 `/campaign` 子段）。 */
export const CAMPAIGN_DEFAULT_MODULE = ''

/** 默认活动代码。 */
export const CAMPAIGN_DEFAULT_CODE = 'campaign_starbucks_2026'

/** 上游「任务条件未满足」业务码（正常未达标，非系统故障）。 */
export const CAMPAIGN_NOT_MET_CODE = 12304

/** 同一账号连续领取多个活动奖励时的反风控间隔（毫秒）。 */
export const CAMPAIGN_CLAIM_GAP_MS = 3000

/** 合法活动标识符正则：仅允许字母、数字、下划线、连字符，最长 64 字符（防 `../` 路径穿越与 SSRF）。 */
const CAMPAIGN_IDENT_RE = /^[A-Za-z0-9_-]{0,64}$/

/** 校验 `module` 或 `code` 是否为安全的 URL 标识符（`module` 允许空串）。 */
export function isValidCampaignIdent(value: string): boolean {
  return CAMPAIGN_IDENT_RE.test(value)
}

/** 构造活动 API 根路径：`module === ''` 时为 `/portal/activity`，否则 `/portal/activity/<module>`。 */
export function campaignBasePath(module = CAMPAIGN_DEFAULT_MODULE): string {
  const m = module.trim()
  return m === '' ? '/portal/activity' : `/portal/activity/${m}`
}

/**
 * 判断账号是否具备国内个人版运营活动参与资格。
 *
 * - 国际版（`realm` 为 `global` / `intl` / `workbuddy`，或 `provider !== 'buddy'`）不参与；
 * - 企业版账号（`enterpriseId` 非空）不参与个人小程序活动；
 * - 缺少 `accessToken` 的账号无法请求。
 */
export function isCampaignEligible(account: {
  realm?: string
  provider?: string
  enterpriseId?: string
  accessToken?: string
}): boolean {
  if (account.accessToken !== undefined && account.accessToken.trim() === '') return false
  if ((account.enterpriseId ?? '').trim() !== '') return false
  const provider = (account.provider ?? '').trim().toLowerCase()
  if (provider !== '' && provider !== 'buddy') return false
  const realm = (account.realm ?? '').trim().toLowerCase()
  if (realm === 'global' || realm === 'intl' || realm === 'workbuddy') return false
  return true
}

/** 运营活动请求异常（携带上游 HTTP 状态码与业务 `code`）。 */
export class CampaignError extends Error {
  readonly httpStatus: number
  readonly code: number | undefined
  readonly msg: string
  readonly raw: string

  constructor(init: { httpStatus: number; code?: number; msg: string; raw?: string; message?: string }) {
    super(init.message ?? (`运营活动接口失败（HTTP ${init.httpStatus}${init.code !== undefined ? ` code=${init.code}` : ''}）：${init.msg}`))
    this.name = 'CampaignError'
    this.httpStatus = init.httpStatus
    this.code = init.code
    this.msg = init.msg
    this.raw = init.raw ?? ''
  }
}

/** 是否为上游「未达标 / 条件未满足」（`code === 12304`）。 */
export function isCampaignNotMet(error: unknown): boolean {
  return error instanceof CampaignError && error.code === CAMPAIGN_NOT_MET_CODE
}

/** 活动查询参数。 */
export interface CampaignQueryOptions {
  /** 路径子模块（默认 `""` → `/portal/activity`）。 */
  module?: string
  /** 活动代码（默认 `campaign_starbucks_2026`）。 */
  code?: string
}

/** 归一化并校验 `module` 与 `code`。 */
export function resolveCampaignSpec(options?: CampaignQueryOptions): { module: string; code: string } {
  const module = (options?.module ?? CAMPAIGN_DEFAULT_MODULE).trim()
  const rawCode = (options?.code ?? CAMPAIGN_DEFAULT_CODE).trim()
  const code = rawCode === '' ? CAMPAIGN_DEFAULT_CODE : rawCode

  if (!isValidCampaignIdent(module)) {
    throw new CampaignError({
      httpStatus: 400,
      msg: `非法活动 module 参数：${module}`,
      message: `非法活动 module 参数（仅允许字母、数字、下划线与连字符）：${module}`,
    })
  }
  if (code === '' || !isValidCampaignIdent(code)) {
    throw new CampaignError({
      httpStatus: 400,
      msg: `非法活动 code 参数：${code}`,
      message: `非法活动 code 参数（仅允许字母、数字、下划线与连字符）：${code}`,
    })
  }
  return { module, code }
}

/** 单条运营活动任务（已合并账号 `progress[]`）。 */
export interface CampaignTask {
  id: number
  taskCode: string
  taskName: string
  description: string
  target: number
  rewardType: string
  rewardDesc: string
  periodType: string
  jumpType: string
  jumpTarget: string
  sortOrder: number
  progress: number
  periodKey: string
  viewedAt: string
  completedAt: string
  claimedAt: string
  status: string
  /** 已领取（`status === 'claimed'` 或 `claimedAt` 非空）。 */
  claimed: boolean
  /** 已达标且未领取（可领奖）。 */
  ready: boolean
}

/** 已发放的奖券/兑换码记录。 */
export interface CampaignVoucher {
  taskCode: string
  voucherCode: string
  rewardType: string
  rewardDesc: string
  claimedAt: string
}

/** 单个账号的运营活动完整快照。 */
export interface CampaignSnapshot {
  module: string
  activityCode: string
  title: string
  startAt: string
  endAt: string
  inPeriod: boolean
  serverTime: string
  tasks: CampaignTask[]
  vouchers: CampaignVoucher[]
  /** 已达标且未领取的任务码（按字典序稳定排序）。 */
  ready: string[]
  /** 已领取的任务码（按字典序稳定排序）。 */
  claimed: string[]
}

/** 单任务领奖返回。 */
export interface CampaignClaimResult {
  taskCode: string
  voucherCode: string
  rewardType: string
  rewardDesc: string
  claimedAt: string
}

/** 单账号批量领奖（或预演）结果。 */
export interface AccountCampaignClaimSummary {
  uid: string
  module: string
  activityCode: string
  dryRun: boolean
  inPeriod: boolean
  /** `dryRun=true` 时列出将要领取的任务码（零写请求）。 */
  wouldClaim: string[]
  /** `dryRun=false` 时实际领取成功的任务码。 */
  claimed: string[]
  /** 实际领取拿到的奖券/兑换码明细。 */
  results: CampaignClaimResult[]
  /** 跳过原因（如不在活动期、12304 条件未满足）。 */
  skipped: string[]
  /** 非预期的失败项。 */
  errors: string[]
}

/** 运营活动小程序请求头（对齐 `campaign.go:doCampaign`）。 */
export function campaignHeaders(input: { uid: string; accessToken: string }): HeaderMap {
  const uid = input.uid.trim()
  const token = input.accessToken.trim()
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Platform': 'miniprogram',
    ...(uid === '' ? {} : { 'X-User-Id': uid }),
    ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 任务是否已领取。 */
export function isCampaignTaskClaimed(task: Pick<CampaignTask, 'status' | 'claimedAt'>): boolean {
  if (task.status.trim().toLowerCase() === 'claimed') return true
  return task.claimedAt.trim() !== ''
}

/**
 * 任务是否已达标且尚未领取（`ready` 判据）。
 *
 * 对齐 `campaign.go:campaignTaskReady`：
 * - `target <= 0` 不算可领（防脏数据误判 `0 >= 0`）；
 * - `status === 'claimed'` 或 `claimedAt !== ''` 已领过滤；
 * - `progress >= target` 达标可领。
 */
export function campaignTaskReady(
  task: Pick<CampaignTask, 'target' | 'progress' | 'status' | 'claimedAt'>,
): boolean {
  if (task.target <= 0) return false
  if (isCampaignTaskClaimed(task)) return false
  return task.progress >= task.target
}

/**
 * 解析 `/portal/activity/tasks` 的 `data` 字段：合并 `tasks[]` 与 `progress[]`，过滤脏条目并标注 `claimed`/`ready`。
 *
 * 抽成纯函数便于单测直接覆盖各种边界形态。
 */
export function parseCampaignTasksPayload(data: unknown): {
  tasks: CampaignTask[]
  ready: string[]
  claimed: string[]
} {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { tasks: [], ready: [], claimed: [] }
  }
  const root = data as Record<string, unknown>
  const rawTasks = Array.isArray(root.tasks) ? root.tasks : []
  const rawProgress = Array.isArray(root.progress) ? root.progress : []

  const progressByCode = new Map<string, Record<string, unknown>>()
  for (const item of rawProgress) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const p = item as Record<string, unknown>
    const code = str(p.task_code).trim()
    if (code !== '') progressByCode.set(code, p)
  }

  const tasks: CampaignTask[] = []
  for (const item of rawTasks) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const t = item as Record<string, unknown>
    const taskCode = str(t.task_code).trim()
    if (taskCode === '') continue

    const p = progressByCode.get(taskCode)
    const progressVal = p !== undefined && p.progress !== undefined ? num(p.progress) : num(t.progress)
    const periodKey = p !== undefined ? str(p.period_key) : str(t.period_key)
    const viewedAt = p !== undefined ? str(p.viewed_at) : str(t.viewed_at)
    const completedAt = p !== undefined ? str(p.completed_at) : str(t.completed_at)
    const claimedAt = p !== undefined ? str(p.claimed_at) : str(t.claimed_at)
    let status = p !== undefined && str(p.status) !== '' ? str(p.status) : str(t.status)
    if (claimedAt.trim() !== '' && status.trim() === '') {
      status = 'claimed'
    }

    const base = {
      id: num(t.id),
      taskCode,
      taskName: str(t.task_name) || str(t.title),
      description: str(t.description),
      target: num(t.target),
      rewardType: str(t.reward_type),
      rewardDesc: str(t.reward_desc),
      periodType: str(t.period_type),
      jumpType: str(t.jump_type),
      jumpTarget: str(t.jump_target),
      sortOrder: num(t.sort_order),
      progress: progressVal,
      periodKey,
      viewedAt,
      completedAt,
      claimedAt,
      status,
    }
    const claimed = isCampaignTaskClaimed(base)
    const ready = campaignTaskReady(base)
    tasks.push({ ...base, claimed, ready })
  }

  const ready = tasks.filter((t) => t.ready).map((t) => t.taskCode).sort()
  const claimed = tasks.filter((t) => t.claimed).map((t) => t.taskCode).sort()
  return { tasks, ready, claimed }
}

/** 解析 `/portal/activity/vouchers` 的 `data` 字段。 */
export function parseCampaignVouchersPayload(data: unknown): CampaignVoucher[] {
  if (data === null || typeof data !== 'object') return []
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>).vouchers)
      ? ((data as Record<string, unknown>).vouchers as unknown[])
      : Array.isArray((data as Record<string, unknown>).list)
        ? ((data as Record<string, unknown>).list as unknown[])
        : []

  const out: CampaignVoucher[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const v = item as Record<string, unknown>
    const voucherCode = str(v.voucher_code) || str(v.code)
    const taskCode = str(v.task_code)
    if (voucherCode === '' && taskCode === '') continue
    out.push({
      taskCode,
      voucherCode,
      rewardType: str(v.reward_type),
      rewardDesc: str(v.reward_desc),
      claimedAt: str(v.claimed_at),
    })
  }
  return out
}

async function doCampaignCall(
  ctx: { uid: string; accessToken: string },
  env: Env,
  method: 'GET' | 'POST',
  pathWithQuery: string,
  body?: string,
): Promise<unknown> {
  const bases = resolveUpstream(env)
  const res = await callUpstream({
    method,
    url: `${bases.chat}${pathWithQuery}`,
    headers: campaignHeaders(ctx),
    body,
  })
  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new CampaignError({
      httpStatus: res.httpStatus,
      ...(c.code === undefined ? {} : { code: c.code }),
      msg: c.msg || res.raw.slice(0, 160),
      raw: res.raw.slice(0, 400),
    })
  }
  return res.envelope?.data
}

/**
 * 查询单个账号的运营活动完整进度快照（`/config` + `/tasks` + `/vouchers`）。
 *
 * - `/tasks` 是核心数据源，失败则抛 `CampaignError`；
 * - `/config` 与 `/vouchers` 为辅助信息，若失败则降级默认值（`inPeriod = true`），不让主列表挂掉。
 */
export async function fetchCampaignSnapshot(
  ctx: { uid: string; accessToken: string; realm?: string },
  env: Env,
  options?: CampaignQueryOptions,
): Promise<CampaignSnapshot> {
  const { module, code } = resolveCampaignSpec(options)
  const base = campaignBasePath(module)
  const qs = `activity_code=${encodeURIComponent(code)}`

  const [configData, tasksData, vouchersData] = await Promise.all([
    doCampaignCall(ctx, env, 'GET', `${base}/config?${qs}`).catch(() => undefined),
    doCampaignCall(ctx, env, 'GET', `${base}/tasks?${qs}`),
    doCampaignCall(ctx, env, 'GET', `${base}/vouchers?${qs}`).catch(() => undefined),
  ])

  let title = ''
  let startAt = ''
  let endAt = ''
  let inPeriod = true
  let serverTime = ''
  if (configData !== undefined && configData !== null && typeof configData === 'object' && !Array.isArray(configData)) {
    const cfg = configData as Record<string, unknown>
    const activity = cfg.activity !== null && typeof cfg.activity === 'object' && !Array.isArray(cfg.activity)
      ? (cfg.activity as Record<string, unknown>)
      : cfg
    title = str(activity.title) || str(activity.name) || str(cfg.title)
    startAt = str(activity.start_at) || str(cfg.start_at)
    endAt = str(activity.end_at) || str(cfg.end_at)
    serverTime = str(cfg.server_time) || str(activity.server_time)
    if (typeof cfg.in_period === 'boolean') inPeriod = cfg.in_period
    else if (typeof activity.in_period === 'boolean') inPeriod = activity.in_period
  }

  const parsedTasks = parseCampaignTasksPayload(tasksData)
  const vouchers = parseCampaignVouchersPayload(vouchersData)

  return {
    module,
    activityCode: code,
    title,
    startAt,
    endAt,
    inPeriod,
    serverTime,
    tasks: parsedTasks.tasks,
    vouchers,
    ready: parsedTasks.ready,
    claimed: parsedTasks.claimed,
  }
}

/**
 * 标记运营活动任务已读（`POST {base}/tasks/{task_code}/viewed?activity_code={code}`）。
 *
 * 部分跳转类任务要求先 `viewed` 才能 `claim`；任务码使用 `encodeURIComponent` 转义防路径注入（`56f7631`）。
 */
export async function viewCampaignTask(
  ctx: { uid: string; accessToken: string },
  env: Env,
  taskCode: string,
  options?: CampaignQueryOptions,
): Promise<void> {
  const trimmedTask = taskCode.trim()
  if (trimmedTask === '') {
    throw new CampaignError({ httpStatus: 400, msg: 'taskCode 不能为空' })
  }
  const { module, code } = resolveCampaignSpec(options)
  const base = campaignBasePath(module)
  const path = `${base}/tasks/${encodeURIComponent(trimmedTask)}/viewed?activity_code=${encodeURIComponent(code)}`
  await doCampaignCall(ctx, env, 'POST', path, '{}')
}

/**
 * 领取单条运营活动任务奖励（`POST {base}/tasks/{task_code}/claim?activity_code={code}`）。
 *
 * 上游若返回业务码 `12304`（条件未满足），抛出的 `CampaignError` 可通过 {@link isCampaignNotMet} 识别。
 */
export async function claimCampaignTask(
  ctx: { uid: string; accessToken: string },
  env: Env,
  taskCode: string,
  options?: CampaignQueryOptions,
): Promise<CampaignClaimResult> {
  const trimmedTask = taskCode.trim()
  if (trimmedTask === '') {
    throw new CampaignError({ httpStatus: 400, msg: 'taskCode 不能为空' })
  }
  const { module, code } = resolveCampaignSpec(options)
  const base = campaignBasePath(module)
  const path = `${base}/tasks/${encodeURIComponent(trimmedTask)}/claim?activity_code=${encodeURIComponent(code)}`
  const data = await doCampaignCall(ctx, env, 'POST', path, '{}')
  const d = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
  return {
    taskCode: trimmedTask,
    voucherCode: str(d.voucher_code) || str(d.code),
    rewardType: str(d.reward_type),
    rewardDesc: str(d.reward_desc),
    claimedAt: str(d.claimed_at),
  }
}

/**
 * 扫描并（可选）领取单个账号的所有已达标未领活动任务。
 *
 * ⚠️ **默认 `dryRun = true`**：不显式传 `dryRun: false` 时只返回 `wouldClaim` 预演清单，绝不触发写操作。
 * 真正领取时按「先 `viewed`（失败忽略）→ 再 `claim`」顺序执行，并对 `12304` 条件未满足归入 `skipped`。
 */
export async function claimAccountCampaignTasks(
  ctx: { uid: string; accessToken: string; realm?: string },
  env: Env,
  options?: CampaignQueryOptions & {
    /** 默认 `true`（仅预演，不发 POST）。 */
    dryRun?: boolean
    /** 同一账号多任务领取间隔（毫秒，默认 `CAMPAIGN_CLAIM_GAP_MS = 3000`）。 */
    gapMs?: number
    /** 可选只领指定任务码子集（空则领全部 `ready` 任务）。 */
    taskCodes?: readonly string[]
  },
): Promise<AccountCampaignClaimSummary> {
  const dryRun = options?.dryRun ?? true
  const gapMs = options?.gapMs ?? CAMPAIGN_CLAIM_GAP_MS
  const snap = await fetchCampaignSnapshot(ctx, env, options)

  const summary: AccountCampaignClaimSummary = {
    uid: ctx.uid,
    module: snap.module,
    activityCode: snap.activityCode,
    dryRun,
    inPeriod: snap.inPeriod,
    wouldClaim: [],
    claimed: [],
    results: [],
    skipped: [],
    errors: [],
  }

  if (!snap.inPeriod) {
    summary.skipped.push('活动不在进行期内')
    return summary
  }

  const filterSet = options?.taskCodes !== undefined && options.taskCodes.length > 0
    ? new Set(options.taskCodes.map((c) => c.trim()).filter((c) => c !== ''))
    : undefined

  const candidates = snap.tasks.filter((t) => {
    if (filterSet !== undefined && !filterSet.has(t.taskCode)) return false
    return campaignTaskReady(t)
  })

  if (dryRun) {
    summary.wouldClaim = candidates.map((t) => t.taskCode)
    return summary
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const task = candidates[i]
    if (task === undefined) continue
    // 先标已读（部分任务强制要求，已读过则幂等；即使失败也不阻断 claim 尝试）
    await viewCampaignTask(ctx, env, task.taskCode, options).catch(() => {})
    try {
      const result = await claimCampaignTask(ctx, env, task.taskCode, options)
      summary.claimed.push(task.taskCode)
      summary.results.push(result)
    } catch (error) {
      if (isCampaignNotMet(error)) {
        const msg = error instanceof CampaignError ? error.msg : '12304'
        summary.skipped.push(`${task.taskCode}: 条件未满足（${msg}）`)
      } else {
        summary.errors.push(`${task.taskCode}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (gapMs > 0 && i < candidates.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, gapMs))
    }
  }

  return summary
}
