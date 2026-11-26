import type { Tone } from '@/components/ui/badge'
import type { Account } from './types'

export type AccountStatus =
  | 'ok'
  | 'cooling'
  | 'credit_exhausted'
  | 'breaker'
  | 'model'
  | 'restricted'
  | 'degraded'
  | 'relogin'
  | 'disabled'

/**
 * 账号状态判定。
 *
 * ⚠️ **必须与后端 `healthy()` 的维度对齐**，且区分：
 * - `disabled`：用户手动停用；
 * - `relogin`（`needsRelogin`）：凭据过期需重登（纳入异常筛选，重登或导入后自动恢复，不混同于手动停用）；
 * - `credit_exhausted`（`until > now && coolKind === 'hard'`）：当日免费额度耗尽（次日 04:00 恢复）。
 */
export function accountStatus(a: Account, now = Date.now()): AccountStatus {
  if (a.disabled) return 'disabled'
  if (a.needsRelogin) return 'relogin'
  if ((a.restrictedUntil ?? 0) > now) return 'restricted'
  if (a.breakerUntil > now) return 'breaker'
  if ((a.degradeUntil ?? 0) > now) return 'degraded'
  if (a.until > now) return a.coolKind === 'hard' ? 'credit_exhausted' : 'cooling'
  if (a.modelCooldowns?.some((m) => m.until > now)) return 'model'
  return 'ok'
}

export const STATUS_META: Record<AccountStatus, { label: string; tone: Tone }> = {
  ok: { label: '正常', tone: 'success' },
  cooling: { label: '冷却中', tone: 'warning' },
  credit_exhausted: { label: '额度耗尽', tone: 'warning' },
  breaker: { label: '熔断', tone: 'danger' },
  degraded: { label: '降权中', tone: 'warning' },
  model: { label: '模型限流', tone: 'warning' },
  restricted: { label: '上游封号', tone: 'danger' },
  relogin: { label: '需重登', tone: 'warning' },
  disabled: { label: '已停用', tone: 'neutral' },
}

/**
 * 「还要等多久」：把剩余时长压成一句话，给「恢复（还剩 7 分钟）」用。
 *
 * ⚠️ 本文件会被后端单测在无 `web/node_modules` 环境下直接 import，故**只能有 `import type`**。
 */
export function fmtRemaining(until: number, now = Date.now()): string {
  if (!until || until <= now) return ''
  const totalSec = Math.ceil((until - now) / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const totalMin = Math.ceil(totalSec / 60)
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/**
 * 「什么时候恢复、还剩多久」—— 账号行状态下面那行小字。
 *
 * 按当前状态取各自对应的截止时刻（避免封号 5 分钟却因降权 30 分钟被 Math.max 误报成 30 分钟）。
 */
export function recoveryText(a: Account, s: AccountStatus, now = Date.now()): string {
  const until =
    s === 'restricted'
      ? (a.restrictedUntil ?? 0)
      : s === 'degraded'
        ? (a.degradeUntil ?? 0)
        : s === 'breaker'
          ? Math.max(a.until, a.breakerUntil)
          : s === 'cooling' || s === 'credit_exhausted'
            ? a.until
            : s === 'model'
              ? Math.max(0, ...(a.modelCooldowns ?? []).map((m) => m.until))
              : 0
  if (!(until > now)) return ''
  const left = fmtRemaining(until, now)
  return left === '' ? '' : `恢复（还剩 ${left}）`
}
