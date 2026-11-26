import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const tones = {
  neutral: 'bg-black/[0.05] text-muted-foreground dark:bg-white/[0.07]',
  success: 'bg-[#30D158]/12 text-[#1D8338] dark:bg-[#30D158]/16 dark:text-[#30D158]',
  warning: 'bg-[#FF9F0A]/14 text-[#B25E00] dark:bg-[#FF9F0A]/16 dark:text-[#FF9F0A]',
  danger: 'bg-[#FF453A]/12 text-[#D70015] dark:bg-[#FF453A]/16 dark:text-[#FF453A]',
  info: 'bg-[#0071E3]/10 text-[#0071E3] dark:bg-[#0A84FF]/16 dark:text-[#409CFF]',
  outline: 'border border-black/[0.08] text-muted-foreground dark:border-white/[0.1]',
}

const dotColors: Record<keyof typeof tones, string> = {
  neutral: 'bg-muted-foreground/70',
  success: 'bg-[#30D158]',
  warning: 'bg-[#FF9F0A]',
  danger: 'bg-[#FF453A]',
  info: 'bg-[#0071E3] dark:bg-[#0A84FF]',
  outline: 'bg-muted-foreground/70',
}

export type Tone = keyof typeof tones

export function Badge({
  tone = 'neutral',
  dot,
  className,
  children,
  ...p
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn(
        'tabular inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
      {...p}
    >
      {dot && <span className={cn('size-1.5 shrink-0 rounded-full', dotColors[tone])} />}
      {children}
    </span>
  )
}
