import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type P = HTMLAttributes<HTMLDivElement>

export const Card = ({ className, ...p }: P) => (
  <div
    className={cn(
      'min-w-0 rounded-xl border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:border-white/[0.07] dark:bg-[#121215] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]',
      className,
    )}
    {...p}
  />
)

export const CardHeader = ({ className, ...p }: P) => (
  <div className={cn('flex min-w-0 items-start justify-between gap-4 px-5 pt-5 pb-3', className)} {...p} />
)

export const CardTitle = ({ className, ...p }: P) => (
  <div className={cn('min-w-0 text-[15px] leading-snug font-semibold tracking-[-0.01em]', className)} {...p} />
)

export const CardDescription = ({ className, ...p }: P) => (
  <div className={cn('text-muted-foreground mt-1 text-[13px] leading-relaxed', className)} {...p} />
)

export const CardContent = ({ className, ...p }: P) => <div className={cn('min-w-0 px-5 pb-5', className)} {...p} />
