import type { HTMLAttributes, ReactNode } from 'react'
import { cn, providerHue } from '@/lib/utils'

export const Skeleton = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('animate-pulse rounded-lg bg-black/[0.05] dark:bg-white/[0.07]', className)} {...p} />
)

/** 分段控制器（Apple HIG / Linear 内凹槽 + 白卡浮起）。 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
}) {
  return (
    <div
      className={cn(
        'inline-flex h-9 max-w-full items-center overflow-x-auto rounded-xl bg-black/[0.05] p-1 dark:bg-white/[0.06] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap',
              'transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.98] motion-reduce:active:scale-100',
              '[&_svg]:size-[14px] [&_svg]:shrink-0',
              active
                ? 'bg-white text-[#1D1D1F] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-800 dark:text-[#EDEDEF] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function ProviderAvatar({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' }) {
  const h = providerHue(id)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-semibold select-none',
        size === 'sm' ? 'size-6 text-[11px]' : 'size-9 text-sm',
      )}
      style={{
        background: `oklch(0.62 0.14 ${h} / 0.14)`,
        color: `oklch(0.54 0.16 ${h})`,
      }}
    >
      {name
        .replace(/[^A-Za-z\u4e00-\u9fa5]/g, '')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  )
}

export function Progress({
  value,
  tone = 'primary',
  className,
}: {
  value: number
  tone?: 'primary' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  const bg = {
    primary: 'bg-[#0071E3] dark:bg-[#0A84FF]',
    success: 'bg-[#30D158]',
    warning: 'bg-[#FF9F0A]',
    danger: 'bg-[#FF453A]',
  }[tone]
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]', bg)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="text-muted-foreground mb-3 rounded-xl border border-black/[0.06] bg-black/[0.03] p-3 dark:border-white/[0.07] dark:bg-white/[0.04] [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="text-muted-foreground mt-1 max-w-sm text-[13px] leading-relaxed">{children}</div>}
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'text-muted-foreground inline-flex h-5 items-center justify-center rounded-[5px] border border-black/[0.08] bg-white/90 px-1.5 font-sans text-[11px] font-medium shadow-[0_1px_0_rgba(0,0,0,0.04)] dark:border-white/[0.1] dark:bg-white/[0.06]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
