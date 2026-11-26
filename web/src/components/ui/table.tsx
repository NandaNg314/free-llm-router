import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Table = ({
  className,
  containerClassName,
  ...p
}: HTMLAttributes<HTMLTableElement> & { containerClassName?: string }) => (
  <div className={cn('w-full max-w-full overflow-x-auto [&::-webkit-scrollbar]:h-1.5', containerClassName)}>
    <table className={cn('w-full border-collapse text-[13px]', className)} {...p} />
  </div>
)

export const THead = ({
  className,
  sticky,
  ...p
}: HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) => (
  <thead
    className={cn(
      'bg-black/[0.025] text-muted-foreground border-y text-xs dark:bg-white/[0.03]',
      sticky && 'sticky top-0 z-10 bg-[#FAFAFC]/95 backdrop-blur-md dark:bg-[#141418]/95',
      className,
    )}
    {...p}
  />
)

export const TR = ({ className, ...p }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('hover:bg-black/[0.025] border-b transition-colors last:border-b-0 dark:hover:bg-white/[0.03]', className)} {...p} />
)

export const TH = ({ className, ...p }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-9 px-4 text-left text-xs font-medium whitespace-nowrap first:pl-5 last:pr-5', className)} {...p} />
)

export const TD = ({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('h-11 px-4 py-2.5 align-middle first:pl-5 last:pr-5', className)} {...p} />
)
