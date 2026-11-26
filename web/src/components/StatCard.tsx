import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

const tones = {
  primary: 'bg-[#0071E3]/10 text-[#0071E3] dark:bg-[#0A84FF]/16 dark:text-[#409CFF]',
  success: 'bg-[#30D158]/12 text-[#1D8338] dark:bg-[#30D158]/16 dark:text-[#30D158]',
  warning: 'bg-[#FF9F0A]/14 text-[#B25E00] dark:bg-[#FF9F0A]/16 dark:text-[#FF9F0A]',
  danger: 'bg-[#FF453A]/12 text-[#D70015] dark:bg-[#FF453A]/16 dark:text-[#FF453A]',
  neutral: 'bg-black/[0.04] text-muted-foreground dark:bg-white/[0.06]',
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
    <Card
      className={cn(
        'p-4 transition-[border-color,transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
        onClick && 'cursor-pointer hover:border-[#0071E3]/35 active:scale-[0.99] dark:hover:border-[#0A84FF]/40',
        className,
      )}
      onClick={onClick}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-[12.5px] font-medium">{label}</span>
        <span className={cn('shrink-0 rounded-lg p-1.5', tones[tone])}>
          <Icon className="size-[15px]" strokeWidth={1.75} />
        </span>
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-16" />
      ) : (
        <div className="mt-2 font-sans text-[25px] leading-tight font-semibold tracking-tight tabular-nums">{value}</div>
      )}
      {sub && <div className="text-muted-foreground mt-1 truncate font-sans text-xs tabular-nums">{sub}</div>}
    </Card>
  )
}

/** 手机端隐藏副标题的紧凑 `StatCard` 外壳，收紧首屏纵向占用。 */
export function StatCardCompact(props: Parameters<typeof StatCard>[0]) {
  return <StatCard {...props} className={cn('[&_.truncate:last-child]:hidden sm:[&_.truncate:last-child]:block', props.className)} />
}
