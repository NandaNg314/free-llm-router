/**
 * 猫猫旅行 / 连登兑换 / 抽奖（growth 域，走 chat base）。
 *
 * ## 幂等策略：靠**上游状态**而不是本地标记
 *
 * 这几个动作的上游状态机本身就是幂等的：
 * - 旅行：`TravelState.State`（idle/traveling/arrived）+ `DailyLimitReached`；
 * - 连登兑换：`status == "locked" | "claimed"` 即跳过；
 * - 抽奖：按 `chances` 抽完为止。
 *
 * ⇒ 每次执行前**先读状态**，再决定做什么。这样天然抗重放，
 * 也不需要本地维护「今天做过了」的标记（那反而会与上游状态不一致）。
 *
 * ## 时区
 *
 * 用**固定 +8 偏移**，不依赖 `Intl` / 本机时区（Workers 恒 UTC）。
 * Go 侧明确记录「不依赖容器 tzdata」（`travel.go:36`）。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { desktopHeaders } from './headers.js'

/** 旅行状态。 */
export interface TravelStatus {
  /** `idle` / `traveling` / `arrived`。 */
  state: string
  /** 今日已达上限。 */
  dailyLimitReached: boolean
  /** 目的地（展示用）。 */
  destination: string
}

/** 连登状态。 */
export interface StreakStatus {
  days: number
  monthTotalDays: number
  /** 已解锁但未兑换的档位（如 `7` / `14` / `28`）。 */
  redeemableTiers: string[]
  /** 可抽奖次数。 */
  lotteryChances: number
  /** 可用**补登卡**数量（0 = 没有补救能力）。 */
  makeupCards: number
  /** 已补登过的日期（`YYYY-MM-DD`）—— 是历史，**不是**待办清单。 */
  makeupDates: string[]
}

/** 用固定 +8 偏移算「今天」（`YYYY-MM-DD`）。 */
export function cstDay(now: number): string {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  return new Date(now + CST_OFFSET).toISOString().slice(0, 10)
}

/** 生成幂等令牌（前端 `randomUUID` 同款语义）。 */
export function clientToken(): string {
  return crypto.randomUUID()
}

/** growth 域通用请求。 */
async function growthCall(
  ctx: { uid: string; accessToken: string },
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  body?: string,
): Promise<{ ok: boolean; httpStatus: number; data: unknown; raw: string; code: number | undefined; msg: string }> {
  const bases = resolveUpstream(env)
  const res = await callUpstream({
    method,
    url: `${bases.chat}${path}`,
    headers: desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body,
  })
  const c = classify(res.httpStatus, res.raw)
  return {
    ok: res.ok,
    httpStatus: res.httpStatus,
    data: res.envelope?.data,
    raw: res.raw,
    code: typeof res.envelope?.code === 'number' ? res.envelope.code : undefined,
    msg: c.msg,
  }
}

/** 读旅行状态。 */
export async function travelStatus(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<TravelStatus> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/buddy/travel/status')
  if (!r.ok) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: r.httpStatus,
      code: r.code,
      message: `旅行状态查询失败：${r.msg || r.raw.slice(0, 120)}`,
      detail: r.raw.slice(0, 400),
    })
  }
  const d = (r.data ?? {}) as Record<string, unknown>
  return {
    state: typeof d.state === 'string' ? d.state : '',
    dailyLimitReached: d.daily_limit_reached === true,
    destination: typeof d.destination === 'string' ? d.destination : '',
  }
}

/**
 * 派猫猫出门旅行。
 *
 * 幂等：上游按 `DailyLimitReached` 保护，重复调用不会重复派出。
 * 故调用前不必查状态（但查了更省一次请求 —— 由调用方决定）。
 */
/**
 * 「没有可领的旅行奖励」算不算正常？
 *
 * ## ⚠️ 为什么抽成纯函数（实测踩到）
 *
 * 上游对「还没到领的时候」回的是 `no unclaimed travel`，
 * 而旧判据 `/not|arriv|未|还没/` **一个词都没命中**
 *（`unclaimed` 不含 `not`、`travel` 不含 `arriv`）⇒ 被当成未知错误抛出，
 * 面板上那一步显示**红色 ERR** —— 而真实情况是**正常**。
 *
 * 抽成纯函数是为了**能单测**：判据散在 async 函数里时只能做脆弱的源码正则断言，
 * 那种测试既容易误报也锁不住行为。
 */
export function isNoUnclaimedTravel(code: number | undefined, msg: string): boolean {
  if (code === 10001) return true
  return /unclaim|not|arriv|none|empty|未|还没|没有/i.test(msg)
}

/**
 * 「今天已经派过旅行」算不算正常？
 *
 * ⚠️ 同样抽成纯函数以便单测 —— 判据要覆盖上游会回的多种文案，
 * 漏一个就会把正常状态报成红色错误。
 */
export function isAlreadyDeparted(code: number | undefined, msg: string): boolean {
  if (code === 10001) return true
  return /limit|already|traveling|in ?progress|上限|已在|进行中/i.test(msg)
}

export async function travelDepart(
  ctx: { uid: string; accessToken: string },
  env: Env,
  locationId = 1,
): Promise<{ departed: boolean; detail: string }> {
  const payloads = [
    JSON.stringify({ location_id: locationId }),
    JSON.stringify({ locationId }),
    '{}',
  ]
  let lastR: { ok: boolean; httpStatus: number; code: number | undefined; msg: string; raw: string } = {
    ok: false,
    httpStatus: 0,
    code: undefined,
    msg: '',
    raw: '',
  }
  for (const body of payloads) {
    const r = await growthCall(ctx, env, 'POST', '/activity/growth/buddy/travel/depart', body)
    if (r.ok) return { departed: true, detail: '已派出旅行' }
    // 「已达上限 / 已在旅行中」都不是失败：今天已经派过了。
    if (isAlreadyDeparted(r.code, r.msg)) {
      return { departed: false, detail: '今日已派出过（幂等命中）' }
    }
    lastR = r
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: lastR.httpStatus,
    code: lastR.code,
    message: `派出旅行失败：${lastR.msg || lastR.raw.slice(0, 120)}`,
    detail: lastR.raw.slice(0, 400),
  })
}

/** 领旅行奖励（猫猫回来了才有）。 */
export async function travelClaim(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ claimed: boolean; detail: string }> {
  const r = await growthCall(ctx, env, 'POST', '/activity/growth/buddy/travel/claim', '{}')
  if (r.ok) return { claimed: true, detail: '旅行奖励已领取' }
  // ⚠️ 判据要**宽**，且必须覆盖实测遇到的文案。
  //
  // 实测（2026-10-04，线上任务运行）：上游对「没有可领奖励」回的是
  // `no unclaimed travel` —— 而旧判据 `/not|arriv|未|还没/` **一个词都没命中**
  //（`unclaimed` 不含 `not`，`travel` 不含 `arriv`），于是被当成未知错误抛出去。
  // 表现为面板上旅行那一步**显示红色 ERR**，而真实情况是「正常，只是还没到领的时候」。
  //
  // ⇒ 补上 `unclaim` / `no ` / `none` / `empty`；业务码 `10001` 是既有的幂等码。
  if (isNoUnclaimedTravel(r.code, r.msg)) {
    return { claimed: false, detail: '尚无可领奖励（幂等命中）' }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `领旅行奖励失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/** 读连登状态（含可兑换档位与抽奖次数）。 */
export async function streakStatus(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<StreakStatus> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/streak')
  if (!r.ok) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: r.httpStatus,
      code: r.code,
      message: `连登状态查询失败：${r.msg || r.raw.slice(0, 120)}`,
      detail: r.raw.slice(0, 400),
    })
  }
  const d = (r.data ?? {}) as Record<string, unknown>
  const streak = (d.streak ?? {}) as Record<string, unknown>

  // 档位列表：上游下发数组，元素含 tier/status
  const tiers = Array.isArray(d.tiers) ? d.tiers : []
  const redeemableTiers: string[] = []
  for (const raw of tiers) {
    if (raw === null || typeof raw !== 'object') continue
    const t = raw as Record<string, unknown>
    const status = typeof t.status === 'string' ? t.status : ''
    const tier = typeof t.tier === 'string' ? t.tier : ''
    // ⚠️ 跳过 locked 与 claimed（Go 侧 `streak.go:60-61` 同口径）
    if (tier !== '' && status !== 'locked' && status !== 'claimed') {
      redeemableTiers.push(tier)
    }
  }

  // 补登卡余额与已补登日期（2026-11-07 新增：断签补救需要它们）
  const cards = (d.makeup_cards ?? {}) as Record<string, unknown>
  const makeupCards = typeof cards.balance === 'number' ? Math.max(0, Math.trunc(cards.balance)) : 0
  const makeupDates: string[] = []
  if (Array.isArray(streak.makeup_dates)) {
    for (const v of streak.makeup_dates) {
      if (typeof v === 'string') makeupDates.push(v)
    }
  }

  return {
    days: typeof streak.days === 'number' ? streak.days : 0,
    monthTotalDays: typeof streak.month_total_days === 'number' ? streak.month_total_days : 0,
    redeemableTiers,
    lotteryChances: typeof d.lottery_chances === 'number' ? d.lottery_chances : 0,
    makeupCards,
    makeupDates,
  }
}

/**
 * 只取连登接口里的 `launch_date`（活动上线日）。
 *
 * ⚠️ 单独一个函数而不是塞进 `streakStatus`：补登判据需要它，
 * 但其它调用方（兑换/抽奖）用不上，塞进去会让那个结构越来越胖。
 */
export async function readStreakLaunchDate(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<string> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/streak')
  if (!r.ok) return ''
  const d = (r.data ?? {}) as Record<string, unknown>
  return typeof d.launch_date === 'string' ? d.launch_date : ''
}

/** 兑换连登档位。幂等：已兑换/未解锁由上游拒绝，不视为失败。 */
export async function redeemTier(
  ctx: { uid: string; accessToken: string },
  env: Env,
  tier: string,
): Promise<{ redeemed: boolean; detail: string }> {
  const r = await growthCall(
    ctx,
    env,
    'POST',
    '/activity/growth/redeem',
    JSON.stringify({ tier, client_token: clientToken() }),
  )
  if (r.ok) return { redeemed: true, detail: `档位 ${tier} 已兑换` }
  if (/locked|claimed|已|未解锁/i.test(r.msg) || r.code === 10001) {
    return { redeemed: false, detail: `档位 ${tier} 不可兑换（幂等命中）` }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `兑换档位 ${tier} 失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/**
 * 抽奖一次。
 *
 * 幂等：调用方应先读 `lotteryChances`，按次数抽完即停
 * （Go 侧 `streak.go:72-84` 同口径）。
 */
export async function lotteryDraw(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ drawn: boolean; detail: string }> {
  const r = await growthCall(
    ctx,
    env,
    'POST',
    '/activity/growth/lottery/draw',
    JSON.stringify({ client_token: clientToken() }),
  )
  if (r.ok) return { drawn: true, detail: '抽奖成功' }
  if (/chance|次数|已用完/i.test(r.msg) || r.code === 10001) {
    return { drawn: false, detail: '没有可抽次数（幂等命中）' }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `抽奖失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/** 按可用次数把抽奖抽完（有界：最多 maxDraws 次，防上游返回异常大的次数）。 */
export async function drawAllLottery(
  ctx: { uid: string; accessToken: string },
  env: Env,
  chances: number,
  maxDraws = 20,
): Promise<{ drawn: number; details: string[] }> {
  const limit = Math.min(Math.max(0, chances), maxDraws)
  const details: string[] = []
  let drawn = 0
  for (let i = 0; i < limit; i += 1) {
    const r = await lotteryDraw(ctx, env)
    details.push(r.detail)
    if (!r.drawn) break
    drawn += 1
  }
  return { drawn, details }
}

// ─────────────────────── 补登卡（断签补救） ───────────────────────
//
// ## 这个功能为什么重要（2026-11-07 从 88lin/workbuddy-auto-signin 移植）
//
// 本项目此前**完全没有**补登能力。而连登奖励按「当月断签即清零」计算：
// 一旦因为账号冷却 / 容器重启 / 网络抖动漏了一天，用户只能眼睁睁看着
// 连签天数归零、档位奖励全部作废。
//
// 上游其实提供了补登卡（`makeup-cards`）：每月最多 4 张，
// 可以把**当月**已断的日期补上，让连登链重新连续。
//
// ## 为什么必须靠 `heatmap` 而不是 `makeup_dates`
//
// - `makeup_dates` 是**已经补过的**历史，不是待办清单；
// - 判断「哪天断签」只能看活跃日历（`heatmap`）里 `score === 0` 的日期。
//
// ⚠️ 参考实现的纪律值得照抄：**结构异常时整段停止**，
// 不靠猜测去消耗补登卡（卡是稀缺资源，猜错就白费一张）。

/** 活跃日历单个日期的数据。 */
export interface HeatmapCell {
  date: string
  score: number
}

/** 读活跃日历（含服务端当天日期，避免本机时区把跨日算错）。 */
export async function fetchHeatmap(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ today: string; cells: HeatmapCell[] }> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/heatmap')
  if (!r.ok) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: r.httpStatus,
      code: r.code,
      message: `活跃日历查询失败：${r.msg || r.raw.slice(0, 120)}`,
      detail: r.raw.slice(0, 400),
    })
  }
  const d = (r.data ?? {}) as Record<string, unknown>
  const todayObj = (d.today ?? {}) as Record<string, unknown>
  const today = typeof todayObj.date === 'string' ? todayObj.date : ''
  const cells: HeatmapCell[] = []
  if (Array.isArray(d.cells)) {
    for (const raw of d.cells) {
      if (raw === null || typeof raw !== 'object') continue
      const c = raw as Record<string, unknown>
      if (typeof c.date !== 'string') continue
      const score = typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : 0
      cells.push({ date: c.date, score })
    }
  }
  return { today, cells }
}

/**
 * 计算**可补登**的日期（纯函数，便于单测）。
 *
 * 规则（对齐官方成长中心，逐条来自参考实现的实测结论）：
 * 1. **当月** —— 补登卡只能补本月；
 * 2. **今天之前** —— 今天还没过完，不能补；
 * 3. **活动上线之后** —— `launch_date` 之前的日期本来就不存在；
 * 4. **`score === 0`** —— 有活跃记录的日期不算断签；
 * 5. **不在 `makeup_dates` 里** —— 已补过的不重复补。
 *
 * ⚠️ 结构异常（日期格式不对 / score 非数 / 日历缺 today）
 * 一律**抛错而不是跳过** —— 宁可这轮不补，也不能白烧一张卡。
 */
export function makeupCandidates(input: {
  today: string
  launchDate: string
  cells: readonly HeatmapCell[]
  makeupDates: readonly string[]
}): string[] {
  const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v)
  if (!isDate(input.today)) throw new Error('活跃日历缺少服务端日期')
  const today = input.today
  const monthStart = `${today.slice(0, 7)}-01`
  const launch = isDate(input.launchDate) ? input.launchDate : monthStart
  const start = [monthStart, launch].sort()[1] as string

  const done = new Set(input.makeupDates.filter(isDate))
  const scores = new Map<string, number>()
  for (const cell of input.cells) {
    if (!isDate(cell.date)) throw new Error('活跃日历日期格式无效')
    if (!Number.isFinite(cell.score) || cell.score < 0) throw new Error('活跃日历分数无效')
    const prev = scores.get(cell.date)
    if (prev !== undefined && prev !== cell.score) throw new Error('活跃日历同一日期记录冲突')
    scores.set(cell.date, cell.score)
  }

  return [...scores.entries()]
    .filter(([day, score]) => day >= start && day < today && score === 0 && !done.has(day))
    .map(([day]) => day)
    .sort()
    .reverse() // 最近的断点优先：尽早把连登链接回去
}

/** 用一张补登卡补某个日期。 */
export async function useMakeupCard(
  ctx: { uid: string; accessToken: string },
  env: Env,
  day: string,
): Promise<{ used: boolean; detail: string }> {
  const r = await growthCall(
    ctx,
    env,
    'POST',
    '/activity/growth/makeup-cards/use',
    JSON.stringify({ date: day, client_token: clientToken() }),
  )
  if (r.ok) return { used: true, detail: `已补登 ${day}` }
  if (/no.*card|card.*empty|没有|已用完|used/i.test(r.msg) || r.code === 10001) {
    return { used: false, detail: `补登 ${day} 未成功（无可用补登卡）` }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `补登 ${day} 失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

// ─────────────────────── Buddy 盲盒 / 能量 ───────────────────────
//
// ## 为什么值得做（2026-11-07 移植）
//
// 盲盒开出来是**能量**，能量可以再开 Buddy 盲盒。本项目此前没有这条链路，
// 等于每天白白攒着额度不用。额度用不掉不会累积到明天。

/** 盲盒配额（还有几次可开）。 */
export async function buddyQuota(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ remaining: number; raw: string }> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/buddy/quota')
  if (!r.ok) return { remaining: 0, raw: r.raw.slice(0, 200) }
  const d = (r.data ?? {}) as Record<string, unknown>
  const n = typeof d.remaining === 'number' ? d.remaining : typeof d.quota === 'number' ? d.quota : 0
  return { remaining: Math.max(0, Math.trunc(n)), raw: r.raw.slice(0, 200) }
}

/**
 * 开一次 Buddy 盲盒。
 *
 * ⚠️ **会覆盖旅行记录**（参考实现实测结论）⇒ 调用方必须保证
 * 旅行状态是 `idle`，**派出旅行要放在开盲盒之后**。
 */
export async function buddyOpen(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<{ opened: boolean; detail: string }> {
  const r = await growthCall(
    ctx,
    env,
    'POST',
    '/activity/growth/buddy/open',
    JSON.stringify({ client_token: clientToken() }),
  )
  if (r.ok) return { opened: true, detail: '已开盲盒' }
  if (/quota|limit|次数|已用完|没有/i.test(r.msg) || r.code === 10001) {
    return { opened: false, detail: '无可用盲盒次数（幂等命中）' }
  }
  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: r.httpStatus,
    code: r.code,
    message: `开盲盒失败：${r.msg || r.raw.slice(0, 120)}`,
    detail: r.raw.slice(0, 400),
  })
}

/** 读能量余额。 */
export async function energyBalance(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<number> {
  const r = await growthCall(ctx, env, 'GET', '/activity/growth/energy')
  if (!r.ok) return 0
  const d = (r.data ?? {}) as Record<string, unknown>
  const v = typeof d.energy === 'number' ? d.energy : typeof d.balance === 'number' ? d.balance : 0
  return Math.max(0, Math.trunc(v))
}
