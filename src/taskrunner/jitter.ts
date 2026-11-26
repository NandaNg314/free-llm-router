/**
 * 国内版福利随机错峰排程器（对标 `workbuddy2api-hub` `v2.2.4` PR #32）。
 *
 * ## 设计目标
 *
 * 1. **默认零破坏**：`cnTaskJitter === false`（缺省）时严格维持既有 `09:00` / `21:00` 北京时间排程，`delayMs = 0`；
 * 2. **开启后均匀打散**：基于 `uid + utc8DateKey` 计算确定性 FNV-1a 哈希，将池内多个国内账号均匀映射到
 *    北京时间 `08:00–10:00`（120 分钟窗口：`slotHour` 为 `8` 或 `9`，叠加毫秒级 `delayMs` 偏移）内错峰执行，
 *    彻底消除多账号在整点 `00` 秒同时并发请求签到/活动接口的机器齐刷特征；
 * 3. **10:00 窗口兜底补跑 + 21:00 晚间错峰补领**：
 *    - `10:00` 作为 `08:00–10:00` 随机窗口收尾兜底槽（若进程在 `08:xx`/`09:xx` 重启错过某账号槽位，
 *      `10:00` 会为当日尚未完成的账号触发补跑，已完成的账号由 `shouldSkipScheduledRun` 幂等跳过）；
 *    - `21:00` 保留晚间补签/猫猫旅行领奖机会，开启错峰时同样在 `0–15` 分钟内按账号确定性打散。
 * 4. **100% Web Standard 纯函数**：零外部依赖、零存储副作用，Workers Cron 可直接将 `now + decision.delayMs`
 *    传给 `TaskRunnerDO.start()` 的 `setAlarm` 持久化延迟唤起，不阻塞 Cron 10ms CPU 预算。
 */

import { cstDay } from '../upstream/travel.js'

/** 北京时间偏移（UTC+8，毫秒）。 */
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000

/** 早间福利随机窗口起始小时（北京时间 `08:00`，含）。 */
export const CN_JITTER_START_HOUR = 8
/** 早间福利随机窗口结束小时（北京时间 `10:00`，左闭右开区间 `[08:00, 10:00)`，且 `10:00` 为兜底补跑整点）。 */
export const CN_JITTER_END_HOUR = 10
/** 晚间补跑/领奖整点（北京时间 `21:00`）。 */
export const CN_EVENING_RETRY_HOUR = 21

/** 单小时毫秒数。 */
const ONE_HOUR_MS = 60 * 60 * 1000
/** 早间 `08:00–10:00` 总窗口宽度（120 分钟 = 7,200,000 ms）。 */
export const CN_JITTER_WINDOW_MS = (CN_JITTER_END_HOUR - CN_JITTER_START_HOUR) * ONE_HOUR_MS
/** `10:00` 兜底补跑与 `21:00` 晚间重试的错峰打散窗口（15 分钟）。 */
export const CN_RETRY_JITTER_MAX_MS = 15 * 60 * 1000

export interface CnAccountJitterSlot {
  uid: string
  /** UTC+8 日期键（`YYYY-MM-DD`）。 */
  dateKey: string
  /** 分配的早间触发整点槽位（`8` 或 `9`）。 */
  slotHour: 8 | 9
  /** 相对所属整点的延迟毫秒数（`0 <= delayMs < 3_600_000`）。 */
  delayMs: number
  /** 相对当日 `08:00:00` 北京时间的总偏移毫秒数（`0 <= windowOffsetMs < 7_200_000`）。 */
  windowOffsetMs: number
  /** 人类可读的北京时间触发时刻（`HH:MM:SS`，落在 `08:00:00`～`09:59:59`）。 */
  slotTimeUtc8: string
}

export interface CnTaskDispatchDecision {
  /** 当前整点是否应当为该账号入队任务。 */
  shouldRun: boolean
  /** 入队后延迟多少毫秒再触发首步 alarm（`cnTaskJitter = false` 时恒为 `0`）。 */
  delayMs: number
  /** 触发原因标签，便于日志观测。 */
  reason: 'legacy_fixed' | 'jitter_slot' | 'window_catchup' | 'evening_retry' | 'not_this_hour'
  /** 开启错峰时的早间专属槽位信息。 */
  slot?: CnAccountJitterSlot
}

/** 计算给定 epoch ms 对应的北京时间小时（`0..23`）。 */
export function utc8HourOf(now: number): number {
  return new Date(now + CST_OFFSET_MS).getUTCHours()
}

/**
 * 确定性 32 位无符号哈希（双轮 FNV-1a + avalanche 雪崩混合）。
 *
 * 确保相邻或仅差一位字符的 `uid`（如 `u1`、`u2`）在同一天也能均匀散列到不同小时与分钟。
 */
export function deterministicHash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Murmur3 32-bit finalizer avalanche，消除短字符串的线性聚集
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 基于 `uid + utc8DateKey` 计算该账号当日在 `08:00–10:00` 北京时间窗口内的确定性错峰槽位。
 */
export function computeCnAccountJitterSlot(uid: string, dateKeyOrNow: string | number): CnAccountJitterSlot {
  const dateKey = typeof dateKeyOrNow === 'number' ? cstDay(dateKeyOrNow) : dateKeyOrNow.trim()
  const cleanUid = uid.trim()
  const hash = deterministicHash32(`cn-daily:${cleanUid}@${dateKey}`)
  // 取秒级精度（0..7199 秒），日志清晰且足够把上百个账号彻底打散
  const totalSeconds = Math.floor(CN_JITTER_WINDOW_MS / 1000)
  const offsetSec = hash % totalSeconds
  const windowOffsetMs = offsetSec * 1000
  const slotHour = (CN_JITTER_START_HOUR + Math.floor(windowOffsetMs / ONE_HOUR_MS)) as 8 | 9
  const delayMs = windowOffsetMs % ONE_HOUR_MS

  const minute = Math.floor(delayMs / 60_000)
  const second = Math.floor((delayMs % 60_000) / 1000)
  const slotTimeUtc8 = `${pad2(slotHour)}:${pad2(minute)}:${pad2(second)}`

  return {
    uid: cleanUid,
    dateKey,
    slotHour,
    delayMs,
    windowOffsetMs,
    slotTimeUtc8,
  }
}

/**
 * 判断某个北京时间整点是否属于国内版每日签到/福利的候选唤醒时点。
 *
 * - `cnTaskJitter = false`（默认）：仅 `9`、`21`（与历史排程逐字节一致）；
 * - `cnTaskJitter = true`：`8`、`9`（随机主窗口）+ `10`（窗口收尾补跑）+ `21`（晚间补领）。
 */
export function isCnDailyScheduleHour(hourUtc8: number, cnTaskJitter = false): boolean {
  if (!cnTaskJitter) {
    return hourUtc8 === 9 || hourUtc8 === CN_EVENING_RETRY_HOUR
  }
  return (
    hourUtc8 === 8 ||
    hourUtc8 === 9 ||
    hourUtc8 === CN_JITTER_END_HOUR ||
    hourUtc8 === CN_EVENING_RETRY_HOUR
  )
}

/**
 * 国际版（`workbuddy.ai`）每日活跃打卡的唤醒整点（不受国内版福利错峰开关影响，恒保持 `09:00` / `21:00`）。
 */
export function isIntlDailyScheduleHour(hourUtc8: number): boolean {
  return hourUtc8 === 9 || hourUtc8 === CN_EVENING_RETRY_HOUR
}

/**
 * 决策单个国内账号在当前整点 `hourUtc8` 是否派发每日福利任务及延迟毫秒数。
 */
export function decideCnTaskDispatch(input: {
  uid: string
  now: number
  /** 可选显式传入 UTC+8 小时；省略时由 `now` 自动换算。 */
  hourUtc8?: number
  /** 是否开启国内版福利随机错峰（默认 `false`）。 */
  cnTaskJitter?: boolean
}): CnTaskDispatchDecision {
  const hour = input.hourUtc8 ?? utc8HourOf(input.now)
  const enabled = input.cnTaskJitter === true

  if (!enabled) {
    if (hour === 9 || hour === CN_EVENING_RETRY_HOUR) {
      return { shouldRun: true, delayMs: 0, reason: 'legacy_fixed' }
    }
    return { shouldRun: false, delayMs: 0, reason: 'not_this_hour' }
  }

  const dateKey = cstDay(input.now)
  const slot = computeCnAccountJitterSlot(input.uid, dateKey)

  if (hour === 8 || hour === 9) {
    if (slot.slotHour === hour) {
      return {
        shouldRun: true,
        delayMs: slot.delayMs,
        reason: 'jitter_slot',
        slot,
      }
    }
    return {
      shouldRun: false,
      delayMs: 0,
      reason: 'not_this_hour',
      slot,
    }
  }

  if (hour === CN_JITTER_END_HOUR) {
    const catchupHash = deterministicHash32(`cn-catchup:${input.uid.trim()}@${dateKey}`)
    const delayMs = (catchupHash % Math.floor(CN_RETRY_JITTER_MAX_MS / 1000)) * 1000
    return {
      shouldRun: true,
      delayMs,
      reason: 'window_catchup',
      slot,
    }
  }

  if (hour === CN_EVENING_RETRY_HOUR) {
    const eveningHash = deterministicHash32(`cn-evening:${input.uid.trim()}@${dateKey}`)
    const delayMs = (eveningHash % Math.floor(CN_RETRY_JITTER_MAX_MS / 1000)) * 1000
    return {
      shouldRun: true,
      delayMs,
      reason: 'evening_retry',
      slot,
    }
  }

  return {
    shouldRun: false,
    delayMs: 0,
    reason: 'not_this_hour',
    slot,
  }
}
