import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const variants = {
  default:
    'bg-[#0071E3] text-white shadow-[0_1px_2px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-[#0077ED] dark:bg-[#0A84FF] dark:hover:bg-[#1F8FFF]',
  outline:
    'border border-black/[0.08] bg-white text-[#1D1D1F] shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-black/[0.03] dark:border-white/[0.09] dark:bg-[#18181C] dark:text-[#EDEDEF] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] dark:hover:bg-white/[0.06]',
  secondary: 'bg-black/[0.05] text-foreground hover:bg-black/[0.08] dark:bg-white/[0.07] dark:hover:bg-white/[0.11]',
  ghost: 'text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.07]',
  destructive: 'bg-[#FF453A] text-white shadow-[0_1px_2px_rgba(0,0,0,0.1)] hover:bg-[#FF453A]/90',
}

const sizes = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 gap-2 text-[13.5px]',
  icon: 'size-9',
  'icon-sm': 'size-8',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
}

/** 按钮外观的 class（也给需要长得像按钮的 `<a>` 用，避免把 button 嵌进 a）。 */
export function buttonClass(variant: keyof typeof variants = 'default', size: keyof typeof sizes = 'md', className?: string) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg font-medium whitespace-nowrap',
    'transition-[transform,background-color,border-color,color,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.98] motion-reduce:active:scale-100',
    'focus-visible:ring-ring/40 outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-[15px] [&_svg]:shrink-0',
    variants[variant],
    sizes[size],
    className,
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />
  ),
)
Button.displayName = 'Button'
