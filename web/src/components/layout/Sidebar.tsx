import { Coins, LogOut, Route } from 'lucide-react'
import { useAccounts, usePool } from '@/lib/queries'
import type { View } from '@/lib/router'
import { cn, fmtCompact, fmtInt } from '@/lib/utils'
import { NAV } from './nav'

export function Sidebar({ view, onNavigate, onLogout }: { view: View; onNavigate: (v: View) => void; onLogout: () => void }) {
  const pool = usePool()
  const accounts = useAccounts()
  const c = pool.data

  const activeAccounts = (accounts.data ?? []).filter((a) => !a.disabled && !a.needsRelogin)
  const totalCredits = activeAccounts.reduce((s, a) => s + Math.max(0, a.credits || 0), 0)
  const expiringCredits = activeAccounts.reduce((s, a) => s + Math.max(0, a.creditsExpiring || 0), 0)

  const statusDot =
    !c || c.total === 0
      ? 'bg-muted-foreground/60'
      : c.healthy > 0
        ? 'bg-[#30D158]'
        : 'bg-[#FF9F0A]'

  const issueCount = c ? c.cooling + c.disabled : 0

  return (
    <div className="flex h-full flex-col select-none">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-black/[0.05] px-4 dark:border-white/[0.06]">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[#0071E3] text-white shadow-[0_2px_6px_rgba(0,113,227,0.28),inset_0_1px_0_rgba(255,255,255,0.22)] dark:bg-[#0A84FF]">
          <Route className="size-4" strokeWidth={2} />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">free-llm-router</div>
          <div className="text-muted-foreground font-sans text-[11px] tabular-nums">控制台 · v{__APP_VERSION__}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4 [&::-webkit-scrollbar]:hidden">
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="text-muted-foreground/75 mb-1.5 px-2.5 text-[11px] font-medium tracking-wider">{g.group}</div>
            <div className="space-y-0.5">
              {g.items.map((it) => {
                const active = it.view === view
                return (
                  <button
                    key={it.view}
                    type="button"
                    onClick={() => onNavigate(it.view)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-8.5 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px]',
                      'transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.99] motion-reduce:active:scale-100',
                      active
                        ? 'bg-[#0071E3]/[0.09] text-[#0071E3] font-medium dark:bg-[#0A84FF]/[0.15] dark:text-[#409CFF]'
                        : 'text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]',
                    )}
                  >
                    <it.icon className="size-[15px] shrink-0" strokeWidth={active ? 2 : 1.75} />
                    <span className="truncate">{it.label}</span>
                    {it.view === 'providers' && issueCount > 0 && (
                      <span className="ml-auto rounded-full bg-[#FF9F0A]/15 px-1.5 font-sans text-[11px] font-medium text-[#B25E00] tabular-nums dark:bg-[#FF9F0A]/18 dark:text-[#FF9F0A]">
                        {issueCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="shrink-0 space-y-2 border-t border-black/[0.05] p-3 dark:border-white/[0.06]">
        <div className="rounded-xl border border-black/[0.06] bg-white p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] dark:border-white/[0.07] dark:bg-[#121215] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <span className="relative flex size-2 shrink-0">
                {c && c.healthy > 0 && (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#30D158] opacity-45 motion-reduce:hidden" />
                )}
                <span className={cn('relative inline-flex size-2 rounded-full', statusDot)} />
              </span>
              <span className="truncate">网关运行中</span>
            </span>
            <span className="text-muted-foreground shrink-0 font-sans text-[11.5px] font-medium tabular-nums">
              {c ? `${c.healthy}/${c.total} 可用` : '读取中…'}
            </span>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-black/[0.05] pt-2 text-[11.5px] dark:border-white/[0.06]">
            <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 truncate">
              <Coins className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className="truncate">可用积分</span>
            </span>
            <span
              className="shrink-0 font-sans font-semibold tracking-tight tabular-nums"
              title={accounts.data ? `合计 ${fmtInt(totalCredits)} 积分` : undefined}
            >
              {accounts.data ? fmtCompact(totalCredits) : '—'}
              {expiringCredits > 0 && (
                <span className="ml-1 font-normal text-[#B25E00] dark:text-[#FF9F0A]" title={`含临期 ${fmtInt(expiringCredits)} 积分`}>
                  (临期 {fmtCompact(expiringCredits)})
                </span>
              )}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="text-muted-foreground flex h-8.5 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
        >
          <LogOut className="size-[15px] shrink-0" strokeWidth={1.75} />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  )
}
