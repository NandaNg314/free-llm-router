/**
 * 任务列表 / 接受 / 领奖（growth 域）。
 *
 * ## 🔴 领奖路径是本项目最大的历史坑，必须按此实现
 *
 * **错误做法**（Go 侧曾长期如此，一直失败）：
 * ```
 * POST {copilot.tencent.com}/v2/activity/growth/tasks/reward/claim
 * body: {"task_code": "..."}
 * ```
 * 该路径**根本不存在**，恒返回 400 `"task not completed"` —— 看起来像「任务没做完」，
 * 实际是**路径错了**。这是 Go 侧领奖长期失败的真实原因，极易误诊。
 *
 * **正确做法**：
 * ```
 * POST {www.workbuddy.cn}/activity/growth/tasks/<task_code>/claim
 * 无 body；任务码在**路径**里；必须带 x-client-platform: web
 * ```
 *
 * 判别要点：
 * - **域名不同**（web 域，不是 chat 域）；
 * - **路径结构不同**（有 `/v2` 前缀 vs 没有）；
 * - **任务码位置不同**（路径参数 vs body 字段）。
 *
 * mp 专属任务走 chat 域 + mp 头，chat 域 400 时降级到 web 域（实测 web 域可领）。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import type { MarketSkill } from './events.js'
import { billingHeaders, desktopHeaders, mpHeaders, webHeaders } from './headers.js'

/** 单个任务（对外视图，字段名对齐上游 JSON）。 */
export interface Task {
  taskCode: string
  title: string
  description: string
  credit: number
  energy: number
  target: number
  current: number
  acceptStatus: string
  status: string
  /** 进度达标且未领取（本地推算）。 */
  claimable: boolean
  /** 已领取。 */
  claimed: boolean
  /** 顺序任务未到解锁时间（上游 `locked: true` 时返回，未锁定时省略以保持向后兼容）。 */
  locked?: boolean
}

/** 领奖结果。 */
export interface ClaimResult {
  /** 本次到账积分（已领过时为 0）。 */
  credit: number
  energy: number
  /** 幂等命中：之前已领过。 */
  alreadyClaimed: boolean
}

/** mp 平台头值。 */
export const MP_PLATFORM = 'miniprogram'

/**
 * mp 专属任务码集合（对齐 `misakano7545/workbuddy2api-panel` 提交 `0a2a55f` / `autotask.go:214-226`）。
 *
 * ⚠️ 包含 `wb_wechat_oa_subscribe_task`（需带 `mp` 头 accept/claim）；
 * 注意 `Library_read` **不在**此集合中（它领奖走 Web 域权威路径），但 `listTasks` 默认对国服合并
 * 默认列表 + `mp` 列表，故即使 `Library_read` 只在 `mp` 口径下发也能正常回读与领奖。
 */
export const MP_TASK_CODES: ReadonlySet<string> = new Set([
  'school_season',
  'wb_wechat_oa_subscribe_task',
  'Sequential_Tasks_1',
  'Sequential_Tasks_2',
  'Sequential_Tasks_3',
  'Sequential_Tasks_4',
  'Sequential_Tasks_5',
  'Sequential_Tasks_6',
  'Sequential_Tasks_7',
])

/**
 * 判断 realm 是否为国内版（`cn` / `buddy` / 缺省）。
 *
 * ⚠️ **国际版（`global` / `intl` / `workbuddy`）严禁发送任何小程序 `mp` 请求头**：
 * 国际服无微信小程序业务面，发 `mp` 头会制造明显的非官方代理指纹特征。
 */
export function isCnRealm(realm?: string): boolean {
  const r = (realm ?? '').trim().toLowerCase()
  return r !== 'global' && r !== 'intl' && r !== 'workbuddy'
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 从 `progress` 字段解析 (current, target) —— 上游有两种形态，都要认。 */
function parseProgress(entry: Record<string, unknown>): { current: number; target: number } {
  const progress = entry.progress
  if (progress !== null && typeof progress === 'object' && !Array.isArray(progress)) {
    const p = progress as Record<string, unknown>
    return { current: num(p.current), target: num(p.target) }
  }
  // 扁平形态
  return { current: num(entry.current), target: num(entry.target) }
}

/** 解析任务列表响应。 */
export function parseTasks(data: unknown): Task[] {
  if (data === null || typeof data !== 'object') return []
  const tasks = (data as Record<string, unknown>).tasks
  if (!Array.isArray(tasks)) return []

  const out: Task[] = []
  for (const raw of tasks) {
    // ⚠️ 跳过非对象条目，以及**缺 task_code 的条目**。
    // 实测（本文件的单测发现）：`[null]` 或 `[{}]` 若照单全收，会产出一个
    // `taskCode: ''` 的**空任务**并进入执行队列 —— 那种任务无法 accept/领奖，
    // 只会污染 lastError 并浪费上游请求。task_code 是唯一标识，缺它就是脏数据。
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const taskCode = str(entry.task_code) || str(entry.code)
    if (taskCode === '') continue

    const { current, target } = parseProgress(entry)
    const acceptStatus = str(entry.accept_status)
    const status = str(entry.status)
    const claimed = acceptStatus === 'claimed' || status.toLowerCase() === 'claimed'
    // 达标且未领（或上游直接标 `accept_status === 'completed'`）⇒ 可领
    const claimable = !claimed && ((target > 0 && current >= target) || acceptStatus === 'completed')

    out.push({
      taskCode,
      title: str(entry.title),
      description: str(entry.description),
      // 上游字段名是 reward_ 前缀
      credit: num(entry.reward_credit),
      energy: num(entry.reward_energy),
      target,
      current,
      acceptStatus,
      status,
      claimable,
      claimed,
      ...(entry.locked === true ? { locked: true } : {}),
    })
  }
  return out
}

async function fetchSingleTaskList(
  ctx: { uid: string; accessToken: string; realm: string },
  env: Env,
  mp: boolean,
): Promise<Task[]> {
  const bases = resolveUpstream(env)
  const upstreamRealm = isCnRealm(ctx.realm) ? 'cn' : 'global'
  const headers = mp
    ? { ...mpHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }), 'X-Client-Platform': MP_PLATFORM }
    : desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken, realm: upstreamRealm })

  const res = await callUpstream({
    method: 'GET',
    url: `${bases.chat}/v2/activity/growth/tasks`,
    headers,
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `任务列表拉取失败（${c.kind}）：${c.msg}`,
      detail: res.raw.slice(0, 400),
    })
  }

  return parseTasks(res.envelope?.data)
}

/**
 * 拉取任务列表。
 *
 * ## 默认行为（对齐 `misakano7545/workbuddy2api-panel` 提交 `0a2a55f`）
 *
 * - 未显式指定 `options.mp` 时：对**国内版（`cn`）**自动拉取「默认口径 + 小程序 `mp` 口径」并按 `taskCode` 去重合并
 *   （`mp` 支路失败时容错回退默认列表，避免 `Library_read` 等偶发只在 `mp` 列表下发的任务被误判「没有此任务」）；
 * - `options.mp === true`：仅拉 `mp` 口径；若账号为**国际版（`global`）则直接返回空数组，绝不发送 `mp` 请求头**；
 * - `options.mp === false` 或 `options.mergeMp === false`：仅拉默认（桌面）口径。
 */
export async function listTasks(
  ctx: { uid: string; accessToken: string; realm: string },
  env: Env,
  options?: { mp?: boolean; mergeMp?: boolean },
): Promise<Task[]> {
  if (options?.mp === true) {
    if (!isCnRealm(ctx.realm)) return []
    return await fetchSingleTaskList(ctx, env, true)
  }

  const base = await fetchSingleTaskList(ctx, env, false)
  if (options?.mp === false || options?.mergeMp === false || !isCnRealm(ctx.realm)) {
    return base
  }

  try {
    const mp = await fetchSingleTaskList(ctx, env, true)
    return mergeTaskLists(base, mp)
  } catch {
    // mp 支路失败不致命，保留默认列表结果（与 Go 侧 TaskByCode / ListAllTasks 同口径）
    return base
  }
}

/**
 * 按任务码回读单条任务：国内版自动合并默认口径与 `mp` 口径，国际版仅查默认口径。
 */
export async function findTaskByCode(
  ctx: { uid: string; accessToken: string; realm: string },
  env: Env,
  taskCode: string,
): Promise<Task | undefined> {
  const all = await listTasks(ctx, env)
  return all.find((t) => t.taskCode === taskCode)
}

/** 合并默认口径与 mp 口径（按 taskCode 去重，默认口径优先）。 */
export function mergeTaskLists(base: Task[], mp: Task[]): Task[] {
  const seen = new Set(base.map((t) => t.taskCode))
  const merged = [...base]
  for (const t of mp) {
    if (!seen.has(t.taskCode)) {
      seen.add(t.taskCode)
      merged.push(t)
    }
  }
  return merged
}

/**
 * 接受任务（「报名」）。
 *
 * 语义要点（Go 侧 `tasks.go:1-22`）：accept **不产生进度**，只是把状态从
 * `not_accepted` 变成 `accepted`。进度由服务端行为事件点亮。
 * ⇒ accept 可**幂等重放**，重复调用无害。
 */
export async function acceptTasks(
  ctx: { uid: string; accessToken: string; realm: string },
  env: Env,
  taskCodes: string[],
  options?: { mp?: boolean },
): Promise<void> {
  if (taskCodes.length === 0) return
  if (options?.mp === true && !isCnRealm(ctx.realm)) return
  const bases = resolveUpstream(env)
  const upstreamRealm = isCnRealm(ctx.realm) ? 'cn' : 'global'
  const headers = options?.mp === true
    ? { ...mpHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }), 'X-Client-Platform': MP_PLATFORM }
    : desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken, realm: upstreamRealm })

  const res = await callUpstream({
    method: 'POST',
    url: `${bases.chat}/v2/activity/growth/tasks/accept`,
    headers,
    body: JSON.stringify({ task_codes: taskCodes }),
  })

  if (!res.ok) {
    // 幂等保护（对齐 L0NE-6/WorkBuddy-Daily `90c7501`）：已接受或已完成不算报错
    if (/already[_\s-]?accepted|already completed|已完成|已接受/i.test(res.raw)) {
      return
    }
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `接受任务失败（${c.kind}）：${c.msg}`,
      detail: res.raw.slice(0, 400),
    })
  }
}

/** 解析领奖响应 `{already_claimed, credit, energy}`。 */
export function parseClaim(data: unknown): ClaimResult {
  if (data === null || typeof data !== 'object') return { credit: 0, energy: 0, alreadyClaimed: false }
  const d = data as Record<string, unknown>
  return {
    credit: num(d.credit),
    energy: num(d.energy),
    alreadyClaimed: d.already_claimed === true,
  }
}

/**
 * 领取奖励（**Web 域权威路径**）。
 *
 * ⚠️ 见文件头的「历史坑」。要点复述：
 * - 域名：`{web}`（**不是** chat 域）；
 * - 路径：`/activity/growth/tasks/<code>/claim`（**没有** `/v2` 前缀）；
 * - 任务码在**路径**里，**无 body**；
 * - 必须带 `x-client-platform: web`。
 *
 * 幂等：已领过返回 `already_claimed: true` + credit 0，**不是错误**。
 */
export async function claimReward(
  ctx: { uid: string; accessToken: string; realm: string; enterpriseId?: string },
  env: Env,
  taskCode: string,
): Promise<ClaimResult> {
  const bases = resolveUpstream(env)
  const headers = webHeaders({ uid: ctx.uid, accessToken: ctx.accessToken })
  if (ctx.enterpriseId !== undefined && ctx.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = ctx.enterpriseId
    headers['X-Tenant-Id'] = ctx.enterpriseId
  }

  const res = await callUpstream({
    method: 'POST',
    url: `${bases.web}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
    headers,
    // 无 body
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `领奖失败（${c.kind}）：${c.msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  return parseClaim(res.envelope?.data)
}

/**
 * 领取 mp 专属任务奖励：chat 域 + mp 头，**失败降级到 web 域**。
 *
 * Go 侧实测：chat 域对该路径可能回 400（部分任务/租户形态），
 * 而 web 域可领 —— 故必须带降级，不能只试一个域名。
 */
export async function claimRewardMp(
  ctx: { uid: string; accessToken: string; realm: string; enterpriseId?: string },
  env: Env,
  taskCode: string,
): Promise<ClaimResult> {
  if (!isCnRealm(ctx.realm)) {
    return claimReward(ctx, env, taskCode)
  }
  const bases = resolveUpstream(env)
  const headers = {
    ...billingHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    'X-Client-Platform': MP_PLATFORM,
  }

  try {
    const res = await callUpstream({
      method: 'POST',
      url: `${bases.chat}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
      headers,
    })
    if (res.ok) return parseClaim(res.envelope?.data)

    // 仅 400 才降级（路径/形态不符）；其他错误原样抛出
    if (res.httpStatus !== 400) {
      const c = classify(res.httpStatus, res.raw)
      throw new UpstreamError({
        kind: c.kind,
        httpStatus: res.httpStatus,
        code: c.code,
        message: `mp 领奖失败（${c.kind}）：${c.msg}`,
        detail: res.raw.slice(0, 400),
      })
    }
  } catch (error) {
    // 网络层错误不降级（降级也大概率失败），直接抛
    if (!(error instanceof UpstreamError) || error.httpStatus !== 400) throw error
  }

  // 降级：web 域
  return claimReward(ctx, env, taskCode)
}

/** 该任务码是否属于 mp 口径（决定 accept/领奖走哪个变体）。 */
export function isMpTask(taskCode: string): boolean {
  return MP_TASK_CODES.has(taskCode)
}

// ─────────────────── 国服 skill_share：市场技能列表与 C2C 分享通道 ───────────────────

/**
 * 拉取技能市场真实技能列表（`POST /portal/operation-platform/market/skill/list`）。
 *
 * ⚠️ 参考 `xu20060420fan-cell` `4271a8a` 与 `L0NE-6/WorkBuddy-Daily` `68cbb25`：
 * `skill_share` 严禁编造假 `skill_id`，必须先从市场取真实条目。
 */
export async function marketSkillList(
  ctx: { uid: string; accessToken: string; realm?: string },
  env: Env,
  pageSize = 5,
): Promise<MarketSkill[]> {
  const bases = resolveUpstream(env)
  const upstreamRealm = isCnRealm(ctx.realm) ? 'cn' : 'global'
  const res = await callUpstream({
    method: 'POST',
    url: `${bases.chat}/portal/operation-platform/market/skill/list`,
    headers: desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken, realm: upstreamRealm }),
    body: JSON.stringify({
      page: 1,
      page_size: pageSize,
      sort_by: 'reco_rank',
      sort_order: 'desc',
    }),
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `技能市场列表拉取失败（${c.kind}）：${c.msg}`,
      detail: res.raw.slice(0, 400),
    })
  }

  const data = res.envelope?.data
  if (data === null || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  const rawList = Array.isArray(d.list)
    ? d.list
    : Array.isArray(d.skills)
      ? d.skills
      : Array.isArray(d.items)
        ? d.items
        : []

  const skills: MarketSkill[] = []
  for (const item of rawList) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const s = item as Record<string, unknown>
    const skillId = str(s.skill_id) || str(s.id)
    if (skillId === '') continue
    skills.push({
      skillId,
      name: str(s.name),
      displayNameZh: str(s.display_name_zh) || str(s.name),
      version: str(s.version) || '1.0.0',
      source: str(s.source) || 'market',
    })
  }
  return skills
}

/**
 * 构造 C2C 资产分享通道请求体（纯函数，便于单测锁死协议细节）。
 *
 * 🔴 关键协议约束（`4271a8a` / `68cbb25`）：
 * `asset_ref` **必须是二次序列化的 JSON 字符串** `"{\"asset_id\":\"...\"}"`（且内部键名为蛇形 `asset_id`），
 * 直接传嵌套对象 `{ asset_id: "..." }` 会被上游拒绝或产出无效通道。
 */
export function buildSkillShareBody(skill: Pick<MarketSkill, 'skillId' | 'source'>): string {
  const assetSource = skill.source !== '' ? skill.source : 'market'
  return JSON.stringify({
    asset_kind: 'skill',
    asset_source: assetSource,
    asset_ref: JSON.stringify({ asset_id: skill.skillId }),
    ways: ['link', 'wxacode', 'wxapath'],
  })
}

/**
 * 创建技能 C2C 分享通道（`POST /api/v2/open-platform/asset-shares/c2c/channels`），返回服务端签发的 `channelId`。
 *
 * ⚠️ 返回体缺 `channel_id` 时立即抛错中止，绝不拿空 `id` 去上报埋点。
 */
export async function createSkillShareChannel(
  ctx: { uid: string; accessToken: string; realm?: string },
  env: Env,
  skill: Pick<MarketSkill, 'skillId' | 'source'>,
): Promise<{ channelId: string }> {
  const bases = resolveUpstream(env)
  const upstreamRealm = isCnRealm(ctx.realm) ? 'cn' : 'global'
  const res = await callUpstream({
    method: 'POST',
    url: `${bases.chat}/api/v2/open-platform/asset-shares/c2c/channels`,
    headers: desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken, realm: upstreamRealm }),
    body: buildSkillShareBody(skill),
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `创建技能分享通道失败（${c.kind}）：${c.msg}`,
      detail: res.raw.slice(0, 400),
    })
  }

  const data = res.envelope?.data
  let channelId = ''
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    channelId = str(d.channel_id).trim() || str(d.id).trim()
  }
  if (channelId === '') {
    try {
      const top = JSON.parse(res.raw) as Record<string, unknown>
      channelId = str(top.channel_id).trim()
    } catch {
      // ignore
    }
  }
  if (channelId === '') {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: res.httpStatus,
      message: '创建技能分享通道响应缺少 channel_id',
      detail: res.raw.slice(0, 400),
    })
  }
  return { channelId }
}
