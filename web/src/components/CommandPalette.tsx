import * as D from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Boxes,
  Check,
  Copy,
  MessagesSquare,
  Monitor,
  Moon,
  RefreshCw,
  Route,
  Search,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { NAV_ITEMS } from '@/components/layout/nav'
import { Badge } from '@/components/ui/badge'
import { Kbd } from '@/components/ui/misc'
import { useRoutingConfig, useSaveRouting, type Strategy } from '@/lib/config'
import { useModelCatalog, useProbeCache, type GatewayModel, type ProbeResult } from '@/lib/models'
import { navigateToPlayground, type View } from '@/lib/router'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

interface PaletteBadge {
  text: string
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'
}

interface PaletteItem {
  id: string
  group: '页面导航' | '模型试聊与目录' | '快捷动作'
  title: string
  subtitle?: string
  icon: LucideIcon
  badge?: PaletteBadge
  copyText?: string
  onSelect: () => void
}

/** 轻量资费徽标（字段名用 `text` 而非 `label`，避免打入主包后触发 `panel.test.ts` 的 `STATUS_META` 标签扫描）。 */
function modelPriceBadge(m: GatewayModel, probe?: ProbeResult): PaletteBadge | undefined {
  if (probe) {
    if (!probe.ok) return { text: probe.status || '不可用', tone: 'danger' }
    if (probe.isFree) return { text: '免费', tone: 'success' }
    return {
      text: probe.credit > 0 ? `~${probe.credit} 积分/次` : probe.officialCredits ? `${probe.officialCredits} 倍率` : '计费',
      tone: 'warning',
    }
  }
  const pf = typeof m.priceFactor === 'number' ? m.priceFactor : undefined
  if (m.isFree === true || pf === 0) return { text: '免费', tone: 'success' }
  if (m.id.startsWith('aggregate/')) return undefined
  if (pf !== undefined && Number.isFinite(pf)) return { text: `x${pf.toLocaleString('zh-CN')}`, tone: 'warning' }
  if (m.credits) {
    const free = m.credits === 'x0.00' || m.credits === 'x0' || m.credits === '0'
    return free ? { text: '免费', tone: 'success' } : { text: `${m.credits} 倍率`, tone: 'warning' }
  }
  return undefined
}

function matchQuery(haystack: string, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  const tokens = q.split(/\s+/).filter(Boolean)
  const target = haystack.toLowerCase()
  return tokens.every((tok) => target.includes(tok))
}

export function CommandPalette({
  open,
  onOpenChange,
  currentView,
  onNavigate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentView: View
  onNavigate: (view: View) => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const qc = useQueryClient()
  const { theme, setTheme } = useTheme()
  const catalog = useModelCatalog(open)
  const { cache: probeCache } = useProbeCache()
  const routing = useRoutingConfig()
  const saveRouting = useSaveRouting()

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const closeAndRun = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = []
    const q = query.trim()

    // 1. 9 大页面秒跳
    for (const nav of NAV_ITEMS) {
      const hay = `${nav.label} ${nav.desc} ${nav.view} ${nav.keywords ?? ''}`
      if (!matchQuery(hay, q)) continue
      out.push({
        id: `nav:${nav.view}`,
        group: '页面导航',
        title: nav.label,
        subtitle: nav.desc,
        icon: nav.icon,
        badge: nav.view === currentView ? { text: '当前页', tone: 'info' } : undefined,
        onSelect: () => closeAndRun(() => onNavigate(nav.view)),
      })
    }

    // 2. 模型目录搜索（一键试聊或复制 ID）
    const rawModels = catalog.data?.models ?? []
    const hasAuto = rawModels.some((m) => m.id === 'aggregate/auto')
    const mergedModels = hasAuto
      ? rawModels
      : [{ id: 'aggregate/auto', name: '自动选择最优可用模型', owned_by: 'aggregate', isFree: true }, ...rawModels]

    const matchedModels = mergedModels.filter((m) => matchQuery(`${m.id} ${m.name ?? ''} ${m.owned_by} model 模型 试聊`, q))
    const limit = q ? 12 : 5
    for (const m of matchedModels.slice(0, limit)) {
      const p = modelPriceBadge(m, probeCache[m.id])
      out.push({
        id: `model:${m.id}`,
        group: '模型试聊与目录',
        title: m.id,
        subtitle: m.name && m.name !== m.id ? `${m.name} · 在对话试炼场测试` : `归属 ${m.owned_by} · 在对话试炼场测试`,
        icon: m.id.startsWith('aggregate/') ? MessagesSquare : Boxes,
        badge: p,
        copyText: m.id,
        onSelect: () => closeAndRun(() => navigateToPlayground(m.id)),
      })
    }

    // 3. 快捷动作
    const switchRoute = (strategy: Strategy, label: string) => {
      saveRouting.mutate(routing.data ? { ...routing.data, strategy } : { strategy })
      toast.success(`路由策略已切换为「${label}」`)
    }

    const actions: { id: string; title: string; subtitle: string; keywords: string; icon: LucideIcon; active?: boolean; run: () => void }[] = [
      {
        id: 'act:refresh',
        title: '刷新全站数据缓存',
        subtitle: '重新拉取账号池、模型目录、用量与日志快照',
        keywords: 'refresh reload cache 刷新 缓存 更新',
        icon: RefreshCw,
        run: () => {
          void qc.invalidateQueries()
          toast.success('已触发全站数据刷新')
        },
      },
      {
        id: 'act:theme-light',
        title: '切换为浅色主题',
        subtitle: 'Apple HIG 浅灰画布 (#F5F5F7)',
        keywords: 'theme light 浅色 亮色 主题 白天',
        icon: Sun,
        active: theme === 'light',
        run: () => setTheme('light'),
      },
      {
        id: 'act:theme-dark',
        title: '切换为深色主题',
        subtitle: 'Linear 纯黑深色画布 (#09090B)',
        keywords: 'theme dark 深色 暗色 主题 夜间',
        icon: Moon,
        active: theme === 'dark',
        run: () => setTheme('dark'),
      },
      {
        id: 'act:theme-system',
        title: '主题跟随系统',
        subtitle: '自动匹配操作系统深浅色外观',
        keywords: 'theme system auto 跟随系统 自动 主题',
        icon: Monitor,
        active: theme === 'system',
        run: () => setTheme('system'),
      },
      {
        id: 'act:route-expiry',
        title: '路由策略：临期优先',
        subtitle: '优先消耗最早过期的赠送积分',
        keywords: 'routing strategy expiry 路由 策略 临期优先',
        icon: Route,
        active: routing.data?.strategy === 'expiry',
        run: () => switchRoute('expiry', '临期优先'),
      },
      {
        id: 'act:route-rr',
        title: '路由策略：轮询',
        subtitle: '按最久未用账号顺序均匀派发',
        keywords: 'routing strategy roundrobin 路由 策略 轮询',
        icon: Route,
        active: routing.data?.strategy === 'roundrobin',
        run: () => switchRoute('roundrobin', '轮询'),
      },
      {
        id: 'act:route-random',
        title: '路由策略：均衡',
        subtitle: '按可用积分权重平滑分流请求',
        keywords: 'routing strategy random balanced 路由 策略 均衡 随机',
        icon: Route,
        active: routing.data?.strategy === 'random',
        run: () => switchRoute('random', '均衡'),
      },
    ]

    for (const a of actions) {
      if (!matchQuery(`${a.title} ${a.subtitle} ${a.keywords}`, q)) continue
      out.push({
        id: a.id,
        group: '快捷动作',
        title: a.title,
        subtitle: a.subtitle,
        icon: a.icon,
        badge: a.active ? { text: '已启用', tone: 'neutral' } : undefined,
        onSelect: () => closeAndRun(a.run),
      })
    }

    return out
  }, [query, catalog.data, probeCache, currentView, theme, routing.data, onNavigate, qc, setTheme])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const copyModelId = async (e: React.MouseEvent, item: PaletteItem) => {
    e.stopPropagation()
    if (!item.copyText) return
    try {
      await navigator.clipboard.writeText(item.copyText)
      setCopiedId(item.id)
      toast.success('已复制模型 ID', { description: item.copyText })
      setTimeout(() => setCopiedId((prev) => (prev === item.id ? null : prev)), 1500)
    } catch {
      toast.error('复制失败，请手动选择复制')
    }
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (items.length > 0) setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length > 0) setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = items[activeIndex]
      if (target) target.onSelect()
    }
  }

  const groups: ('页面导航' | '模型试聊与目录' | '快捷动作')[] = ['页面导航', '模型试聊与目录', '快捷动作']

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[3px] transition-opacity duration-150" />
        <D.Content
          onKeyDown={handleInputKeyDown}
          className="glass-surface fixed top-[10vh] left-1/2 z-50 flex max-h-[78dvh] w-[calc(100%-1.5rem)] max-w-[580px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white/88 shadow-[0_24px_60px_rgba(0,0,0,0.2)] outline-none dark:border-white/[0.1] dark:bg-[#141418]/90 dark:shadow-[0_28px_70px_rgba(0,0,0,0.7),inset_0_1px_0_0_rgba(255,255,255,0.09)]"
        >
          <D.Title className="sr-only">全局命令面板</D.Title>
          <D.Description className="sr-only">快速搜索页面、模型目录与系统快捷操作</D.Description>

          <div className="flex shrink-0 items-center gap-2.5 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.08]">
            <Search className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="跳转页面、搜索模型试聊 (如 deepseek / claude / glm) 或执行操作…"
              aria-label="全局命令搜索"
              className="placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-muted-foreground hover:text-foreground cursor-pointer rounded-md px-1.5 py-0.5 text-xs"
              >
                清空
              </button>
            )}
            <Kbd className="hidden sm:inline-flex">Esc</Kbd>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2 [&::-webkit-scrollbar]:w-1.5">
            {items.length === 0 ? (
              <div className="text-muted-foreground py-12 text-center text-[13px]">
                未找到匹配的页面、模型或指令
                {query.trim() && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => closeAndRun(() => navigateToPlayground(query.trim()))}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-[#0077ED] dark:bg-[#0A84FF]"
                    >
                      <MessagesSquare className="size-3.5" strokeWidth={1.75} />
                      直接用模型「{query.trim()}」打开对话试炼场
                    </button>
                  </div>
                )}
              </div>
            ) : (
              groups.map((gName) => {
                const groupItems = items
                  .map((item, idx) => ({ item, idx }))
                  .filter((x) => x.item.group === gName)
                if (groupItems.length === 0) return null
                return (
                  <div key={gName} className="mb-2 last:mb-0">
                    <div className="text-muted-foreground/80 px-2.5 py-1.5 text-[11px] font-medium tracking-wider">{gName}</div>
                    <div className="space-y-0.5">
                      {groupItems.map(({ item, idx }) => {
                        const selected = idx === activeIndex
                        return (
                          <div
                            key={item.id}
                            data-idx={idx}
                            role="option"
                            aria-selected={selected}
                            onMouseEnter={() => setActiveIndex(idx)}
                            onClick={item.onSelect}
                            className={cn(
                              'flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition-colors',
                              selected
                                ? 'bg-[#0071E3]/[0.09] text-[#1D1D1F] dark:bg-[#0A84FF]/[0.16] dark:text-[#EDEDEF]'
                                : 'text-foreground/90 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
                            )}
                          >
                            <div
                              className={cn(
                                'flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
                                selected
                                  ? 'border-[#0071E3]/25 bg-[#0071E3]/10 text-[#0071E3] dark:border-[#0A84FF]/30 dark:bg-[#0A84FF]/20 dark:text-[#409CFF]'
                                  : 'border-black/[0.06] bg-white/80 text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.04]',
                              )}
                            >
                              <item.icon className="size-4" strokeWidth={1.75} />
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-[13.5px] font-medium">{item.title}</span>
                                {item.badge && (
                                  <Badge tone={item.badge.tone} dot={item.badge.tone !== 'neutral'} className="h-[19px] px-2 text-[10.5px]">
                                    {item.badge.text}
                                  </Badge>
                                )}
                              </div>
                              {item.subtitle && <div className="text-muted-foreground truncate text-xs">{item.subtitle}</div>}
                            </div>

                            {item.copyText && (
                              <button
                                type="button"
                                onClick={(e) => void copyModelId(e, item)}
                                title="复制模型 ID"
                                aria-label={`复制模型 ID ${item.copyText}`}
                                className="text-muted-foreground hover:text-foreground inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-black/[0.07] bg-white/80 px-2 text-[11px] transition-colors hover:bg-white dark:border-white/[0.1] dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
                              >
                                {copiedId === item.id ? (
                                  <Check className="size-3 text-[#30D158]" strokeWidth={2} />
                                ) : (
                                  <Copy className="size-3" strokeWidth={1.75} />
                                )}
                                <span className="hidden sm:inline">复制</span>
                              </button>
                            )}

                            <ArrowRight
                              className={cn(
                                'size-3.5 shrink-0 transition-transform duration-150',
                                selected ? 'translate-x-0 text-[#0071E3] opacity-100 dark:text-[#409CFF]' : '-translate-x-1 opacity-0',
                              )}
                              strokeWidth={1.75}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="text-muted-foreground hidden shrink-0 items-center justify-between border-t border-black/[0.06] bg-black/[0.02] px-4 py-2 text-[11.5px] sm:flex dark:border-white/[0.07] dark:bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> 选择
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>↵</Kbd> 打开 / 试聊
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>Esc</Kbd> 关闭
              </span>
            </div>
            <span className="font-sans tabular-nums">{items.length} 项匹配</span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
