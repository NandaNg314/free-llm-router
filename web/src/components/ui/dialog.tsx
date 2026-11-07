import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const overlay = 'fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0'

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}

/** 居中对话框（表单、确认）。 */
export function Dialog({ open, onOpenChange, title, description, children, footer, className }: Props) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content
          className={cn(
            'bg-popover fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border shadow-2xl outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="text-muted-foreground mt-1 text-[13px]">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{String(title)}</D.Description>
              )}
            </div>
            <D.Close className="text-muted-foreground hover:bg-muted -mr-2 rounded-md p-1.5" aria-label="关闭">
              <X className="size-4" />
            </D.Close>
          </div>
          {children ? <div className="px-6 py-4">{children}</div> : <div className="h-4" />}
          {footer && <div className="bg-muted/50 flex justify-end gap-2 rounded-b-xl border-t px-6 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 右侧抽屉（供应商详情、手机端导航）。 */
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
            /*
              右侧抽屉宽度（2026-11-07 修「内容被挤成横向滚动」）。

              ## 改前
              `sm:max-w-xl` = 576px。在 2000px 的宽屏上这只占 ~29%，
              供应商详情里的账号表（账号/状态/积分三列 + 模型冷却明细）
              根本塞不下，底部只能出现横向滚动条，用户得左右拖着看。

              ## 改后
              `w-full sm:w-1/2` + `sm:max-w-[860px]`：
              - 宽屏（≥1720px）：恰好半屏 860px，信息一屏展开；
              - 中等屏（1280px）：一半 640px，仍比原来的 576px 宽；
              - 窄屏（< 640px）：整屏，手机上没有「半屏」可言。
            */
            'bg-popover fixed inset-y-0 z-50 flex w-full flex-col shadow-2xl outline-none sm:w-1/2 sm:max-w-[860px]',
            side === 'right' ? 'right-0 border-l' : 'left-0 max-w-72 border-r',
            className,
          )}
        >
          <D.Title className="sr-only">{typeof title === 'string' ? title : '面板'}</D.Title>
          <D.Description className="sr-only">{typeof description === 'string' ? description : ''}</D.Description>
          <D.Close className="text-muted-foreground hover:bg-muted absolute top-4 right-4 z-10 rounded-md p-1.5" aria-label="关闭">
            <X className="size-4" />
          </D.Close>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
