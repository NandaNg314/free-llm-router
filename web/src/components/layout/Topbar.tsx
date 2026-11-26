import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, ChevronDown, Menu as MenuIcon, Monitor, Moon, RefreshCw, Route, Search, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Kbd } from '@/components/ui/misc'
import { useRoutingConfig, useSaveRouting, type Strategy } from '@/lib/config'
import { useTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { NavItem } from './nav'

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

const STRATEGIES: { value: Strategy; label: string; shortLabel: string; hint: string }[] = [
  { value: 'expiry', label: '临期优先', shortLabel: '临期', hint: '最早过期积分先消耗' },
  { value: 'roundrobin', label: '轮询', shortLabel: '轮询', hint: '按最久未用依次轮换' },
  { value: 'random', label: '均衡', shortLabel: '均衡', hint: '按积分权重均衡分流' },
]

export function Topbar({
  item,
  onOpenNav,
  onOpenCommandPalette,
}: {
  item: NavItem
  onOpenNav: () => void
  onOpenCommandPalette: () => void
}) {
  const qc = useQueryClient()
  const fetching = useIsFetching() > 0
  const { theme, resolved, setTheme } = useTheme()
  const routing = useRoutingConfig()
  const saveRouting = useSaveRouting()

  const currentStrategy: Strategy = routing.data?.strategy ?? 'expiry'
  const currentStrategyMeta = STRATEGIES.find((s) => s.value === currentStrategy) ?? STRATEGIES[0]!

  const switchStrategy = (next: Strategy) => {
    if (next === currentStrategy || saveRouting.isPending) return
    saveRouting.mutate(routing.data ? { ...routing.data, strategy: next } : { strategy: next })
  }

  return (
    <header className="glass-surface sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-black/[0.06] bg-white/80 px-3 sm:gap-3 sm:px-4 lg:px-8 dark:border-white/[0.07] dark:bg-[#121215]/82">
      <Button variant="ghost" size="icon-sm" className="-ml-1 lg:hidden" onClick={onOpenNav} aria-label="打开导航">
        <MenuIcon strokeWidth={1.75} />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        <span className="text-muted-foreground hidden shrink-0 sm:inline">控制台</span>
        <span className="text-muted-foreground/50 hidden shrink-0 sm:inline">/</span>
        <span className="truncate font-semibold tracking-[-0.01em]">{item.label}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {/* 桌面端 ⌘K 搜索胶囊 */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="打开全局命令面板 (Ctrl+K)"
          className="text-muted-foreground hidden h-8 w-48 cursor-pointer items-center gap-2 rounded-lg border border-black/[0.07] bg-black/[0.03] px-2.5 text-xs transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-black/[0.12] hover:bg-black/[0.05] hover:text-foreground active:scale-[0.98] sm:inline-flex lg:w-60 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:border-white/[0.14] dark:hover:bg-white/[0.07]"
        >
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="flex-1 truncate text-left">搜索跳转或模型…</span>
          <Kbd className="h-[18px] px-1 text-[10.5px]">⌘K</Kbd>
        </button>

        {/* 手机端放大镜触发按钮 */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="sm:hidden"
          onClick={onOpenCommandPalette}
          aria-label="打开全局命令面板"
          title="搜索跳转或模型 (Ctrl+K)"
        >
          <Search strokeWidth={1.75} />
        </Button>

        {/* 桌面端路由策略快捷切换内凹胶囊 */}
        <div
          className="hidden h-8 items-center rounded-xl bg-black/[0.05] p-0.5 xl:inline-flex dark:bg-white/[0.06]"
          role="group"
          aria-label="路由策略快捷切换"
        >
          {STRATEGIES.map((s) => {
            const active = s.value === currentStrategy
            return (
              <button
                key={s.value}
                type="button"
                disabled={!routing.data || saveRouting.isPending}
                onClick={() => switchStrategy(s.value)}
                title={`路由策略：${s.label}（${s.hint}）`}
                className={cn(
                  'h-7 cursor-pointer rounded-[9px] px-2.5 text-xs font-medium whitespace-nowrap transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.98] disabled:opacity-60',
                  active
                    ? 'bg-white text-[#1D1D1F] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-800 dark:text-[#EDEDEF] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s.label}
              </button>
            )
          })}
        </div>

        {/* 窄屏/中屏紧凑路由策略下拉胶囊（确保 390px 零横向溢出） */}
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="切换路由策略"
              title={`当前路由策略：${currentStrategyMeta.label}`}
              className="text-muted-foreground inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-black/[0.07] bg-black/[0.03] px-2 text-xs font-medium transition-colors hover:bg-black/[0.06] hover:text-foreground xl:hidden dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
            >
              <Route className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span>{currentStrategyMeta.shortLabel}</span>
              <ChevronDown className="size-3 opacity-60" strokeWidth={1.75} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-48">
            <MenuLabel>路由策略快捷切换</MenuLabel>
            <MenuSeparator />
            {STRATEGIES.map((s) => (
              <MenuItem key={s.value} active={s.value === currentStrategy} onSelect={() => switchStrategy(s.value)}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] leading-tight">{s.label}</div>
                  <div className="text-muted-foreground text-[11px] font-normal">{s.hint}</div>
                </div>
                {s.value === currentStrategy && <Check className="ml-auto shrink-0" strokeWidth={1.75} />}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>

        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label="刷新数据" title="刷新数据" onClick={() => qc.invalidateQueries()}>
            <RefreshCw className={cn(fetching && 'animate-spin')} strokeWidth={1.75} />
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="切换主题" title="切换主题">
                {resolved === 'dark' ? <Moon strokeWidth={1.75} /> : <Sun strokeWidth={1.75} />}
              </Button>
            </MenuTrigger>
            <MenuContent>
              {THEMES.map((t) => (
                <MenuItem key={t.value} onSelect={() => setTheme(t.value)} active={theme === t.value}>
                  <t.icon strokeWidth={1.75} /> {t.label}
                  {theme === t.value && <Check className="ml-auto" strokeWidth={1.75} />}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="项目文档"
            title="项目文档"
            onClick={() => window.open('https://github.com/NandaNg314/free-llm-router#readme', '_blank', 'noopener,noreferrer')}
          >
            <BookOpen strokeWidth={1.75} />
          </Button>
        </div>
      </div>
    </header>
  )
}
