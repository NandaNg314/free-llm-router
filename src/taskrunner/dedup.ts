/**
 * Cron 扇出的「按日去重」判据。
 *
 * ⚠️ 必须**失败可重试**：09:00 与 21:00 两个 daily 时点本来就互为重试机会。
 * 早期判据只看「今天已经 finished 过同一计划」，于是 09:00 失败一次后，
 * 21:00 会被当成「已跑过」直接跳过 —— 用户看到的就是「签到失败了，当天不再重试」。
 * 故只有**全部步骤成功且无 lastError** 时才跳过。
 */
import { utc8DayKey } from '../store/usage.js'
import type { RunState } from './steps.js'

export function shouldSkipScheduledRun(input: {
  status: RunState | undefined
  plan: string
  now: number
}): boolean {
  const { status, plan, now } = input
  if (status === undefined) return false
  if (!status.finished || status.plan !== plan) return false
  if (utc8DayKey(status.startedAt) !== utc8DayKey(now)) return false
  if ((status.lastError ?? '') !== '') return false
  return status.done.every((step) => step.ok === true)
}
