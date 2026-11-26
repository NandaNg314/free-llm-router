import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const overlay = 'fixed inset-0 z-50 bg-black/35 backdrop-blur-[3px] transition-opacity duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]'

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}

/** 居中对话框（表单、确认，毛玻璃浮层）。 */
export function Dialog({ open, onOpenChange, title, description, children, footer, className }: Props) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content
          className={cn(
            'glass-surface fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white/86 shadow-[0_24px_48px_rgba(0,0,0,0.16)] outline-none dark:border-white/[0.09] dark:bg-[#121215]/86 dark:shadow-[0_24px_56px_rgba(0,0,0,0.6),inset_0_1px_0_0_rgba(255,255,255,0.08)]',
            className,
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
            <div className="min-w-0">
              <D.Title className="text-[16px] font-semibold tracking-[-0.01em]">{title}</D.Title>
              {description ? (
                <D.Description className="text-muted-foreground mt-1 text-[13px] leading-relaxed">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{String(title)}</D.Description>
              )}
            </div>
            <D.Close
              className="text-muted-foreground -mr-2 cursor-pointer rounded-lg p-1.5 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
              aria-label="关闭"
            >
              <X className="size-4" strokeWidth={1.75} />
            </D.Close>
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div> : <div className="h-4" />}
          {footer && (
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-black/[0.06] bg-black/[0.025] px-6 py-3 dark:border-white/[0.07] dark:bg-white/[0.03]">
              {footer}
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 抽屉浮层（供应商详情、日志诊断、手机端导航）。 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = 'right',
  className,
}: Omit<Props, 'footer'> & { side?: 'left' | 'right' }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content
          className={cn(
            'glass-surface fixed inset-y-0 z-50 flex w-full flex-col bg-white/88 shadow-[0_24px_56px_rgba(0,0,0,0.2)] outline-none sm:w-1/2 sm:max-w-[860px] dark:bg-[#121215]/88 dark:shadow-[0_24px_64px_rgba(0,0,0,0.65),inset_0_1px_0_0_rgba(255,255,255,0.07)]',
            side === 'right'
              ? 'right-0 border-l border-black/[0.07] dark:border-white/[0.08]'
              : 'left-0 max-w-72 border-r border-black/[0.07] sm:w-72 dark:border-white/[0.08]',
            className,
          )}
        >
          <D.Title className="sr-only">{typeof title === 'string' ? title : '面板'}</D.Title>
          <D.Description className="sr-only">{typeof description === 'string' ? description : ''}</D.Description>
          <D.Close
            className="text-muted-foreground absolute top-3.5 right-3.5 z-10 cursor-pointer rounded-lg p-1.5 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
            aria-label="关闭"
          >
            <X className="size-4" strokeWidth={1.75} />
          </D.Close>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
