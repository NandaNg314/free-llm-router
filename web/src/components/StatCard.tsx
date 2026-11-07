import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

const tones = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/12 text-danger',
  neutral: 'bg-muted text-muted-foreground',
}

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'neutral',
  loading,
  onClick,
  className,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon: LucideIcon
  tone?: keyof typeof tones
  loading?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <Card className={cn('p-4', onClick && 'hover:border-ring/40 cursor-pointer transition-colors', className)} onClick={onClick}>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-[13px]">{label}</span>
        <span className={cn('rounded-md p-1.5', tones[tone])}>
          <Icon className="size-3.5" strokeWidth={2.2} />
        </span>
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-16" />
      ) : (
        <div className="tabular mt-2 text-[26px] leading-tight font-semibold tracking-tight">{value}</div>
      )}
      {sub && <div className="text-muted-foreground mt-1 truncate text-xs">{sub}</div>}
    </Card>
  )
}

/**
 * 手机上隐藏副标题的 `StatCard` 外壳。
 *
 * ## 为什么需要它（2026-11-07 手机端）
 * 「供应商与账号」页顶部有 6 张 KPI 卡，每张的副标题在 390px 下都被 `truncate`
 * 截成「分布在 2 家…」「最早 5 天后…」——信息量几乎为零，却每张多占 16px 高度，
 * 6 张就是 ~100px，直接把账号列表推到首屏之外。
 *
 * ⇒ 用 `[&_.truncate]:hidden sm:[&_.truncate]:visible` 精确命中 StatCard 内部的
 *   副标题（它是唯一带 `truncate` 的元素），不改组件本身的 API、不影响其他页面。
 */
export function StatCardCompact(props: Parameters<typeof StatCard>[0]) {
  return <StatCard {...props} className={cn('[&_.truncate]:hidden sm:[&_.truncate]:block', props.className)} />
}
