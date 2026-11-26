import {
  Activity,
  CalendarClock,
  Coins,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  GitBranch,
  Globe,
  Layers,
  Lock,
  Plus,
  Route,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldCog,
  Snowflake,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input, Switch } from '@/components/ui/input'
import { Empty, ProviderAvatar, Segmented, Skeleton } from '@/components/ui/misc'
import { auth } from '@/lib/api'
import {
  type RoutingConfig,
  type SafetyConfig,
  type Strategy,
  type UnifiedModelRule,
  type UnifiedModelsConfig,
  useClearCooldowns,
  useClearWaf,
  useCorsConfig,
  useCredentialCount,
  usePermanentLocks,
  useRoutingConfig,
  useSafetyConfig,
  useSaveCorsConfig,
  useSaveRouting,
  useSaveSafety,
  useSaveUnifiedModels,
  useSetPermanentLock,
  useUnifiedModelsConfig,
  useWaf,
} from '@/lib/config'
import { dshSnippet } from '@/lib/dsh'
import { useModelCatalog } from '@/lib/models'
import { useAccounts, usePool, useProviders } from '@/lib/queries'
import { cn, fmtDateTime, fmtInt } from '@/lib/utils'

async function copyText(text: string, ok = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(ok)
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

type GroupId = 'connect' | 'routing' | 'automation' | 'security' | 'status'

interface GroupMeta {
  id: GroupId
  label: string
  shortLabel: string
  icon: typeof Terminal
  desc: string
}

const GROUPS: GroupMeta[] = [
  { id: 'connect', label: '快速接入', shortLabel: '快速接入', icon: Terminal, desc: '双协议接入片段与只读额度汇总接口' },
  { id: 'routing', label: '路由与统一模型', shortLabel: '路由与映射', icon: Route, desc: '选号策略、流式续写与出口感知别名映射' },
  { id: 'automation', label: '自动化与防封', shortLabel: '自动化防封', icon: ShieldCog, desc: '国内福利错峰排程、续期与风控规避阈值' },
  { id: 'security', label: '安全与跨域', shortLabel: '安全与跨域', icon: Lock, desc: '数据面 CORS 白名单与永久积分保护锁' },
  { id: 'status', label: '运行态与维护', shortLabel: '运行态维护', icon: Activity, desc: '账号池健康度、WAF 拦截解除与冷却清理' },
]

interface SearchableCardItem {
  id: string
  group: GroupId
  keywords: string
  render: () => ReactNode
}

export function ConfigPage() {
  const [activeGroup, setActiveGroup] = useState<GroupId>('connect')
  const [search, setSearch] = useState('')

  const items: SearchableCardItem[] = useMemo(
    () => [
      {
        id: 'connect-guide',
        group: 'connect',
        keywords: '快速接入 接入指南 base url 主密钥 api_key curl claude code messages anthropic openai python env 环境变量 dsh reasoningEfforts x-flr-account mcp 媒体 语音',
        render: () => <ConnectCard />,
      },
      {
        id: 'balance-summary',
        group: 'connect',
        keywords: '额度查询 余额汇总 balance-summary /v1/balance-summary 积分 临期积分 状态栏 小组件 只读 子密钥',
        render: () => <BalanceSummaryCard />,
      },
      {
        id: 'routing-strategy',
        group: 'routing',
        keywords: '路由与调度 选号策略 临期优先 轮询 随机 expiry roundrobin random 失败换号 maxRetries 限流冷却 softCooldownSeconds 流式截断自动续写 悬停救援 autoContinuation',
        render: () => <RoutingCard />,
      },
      {
        id: 'unified-models',
        group: 'routing',
        keywords: '统一模型映射 出口感知别名 unified-models alias 别名 映射 claude sonnet opus deepseek glm buddy workbuddy codearts modelscope 国内版 国际版',
        render: () => <UnifiedModelsCard />,
      },
      {
        id: 'automation-schedule',
        group: 'automation',
        keywords: '定时自动化 自动签到 每日任务 autoTaskCron 国内福利随机错峰排程 错峰 窗口 cnTaskJitter 08:00 10:00 猫猫旅行 签到 自动续期登录凭据 autoRefreshCredential',
        render: () => <AutomationScheduleCard />,
      },
      {
        id: 'safety-antiban',
        group: 'automation',
        keywords: '防封 风控规避 会话链 sessionTrace b3 x-conversation 模型级冷却 modelCooldownEnabled 单请求消息数上限 上下文裁剪 maxContextMessages 消耗熔断 burnRate qps 限速 随机抖动 rateJitterMs',
        render: () => <SafetyCard />,
      },
      {
        id: 'cors-security',
        group: 'security',
        keywords: '数据面跨域 cors 跨域 白名单 origins 允许来源 浏览器 CORS_ORIGINS',
        render: () => <CorsCard />,
      },
      {
        id: 'permanent-locks',
        group: 'security',
        keywords: '永久积分锁 锁 积分保留线 0倍率 免费模型 豁免 permanent-locks 保护',
        render: () => <LocksCard />,
      },
      {
        id: 'runtime-status',
        group: 'status',
        keywords: '运行状态 维护 waf 出口 ip 拦截 解除 冷却 清空 解冻 凭据 加密 备份 迁移 CREDENTIAL_KEY',
        render: () => <StatusCard />,
      },
    ],
    [],
  )

  const kw = search.trim().toLowerCase()
  const isSearching = kw.length > 0

  const matchedByGroup = useMemo(() => {
    if (!isSearching) {
      return GROUPS.filter((g) => g.id === activeGroup).map((g) => ({
        group: g,
        cards: items.filter((it) => it.group === g.id),
      }))
    }
    const tokens = kw.split(/\s+/).filter(Boolean)
    return GROUPS.map((g) => ({
      group: g,
      cards: items.filter((it) => {
        if (it.group !== g.id) return false
        const hay = `${g.label} ${g.desc} ${it.keywords}`.toLowerCase()
        return tokens.every((t) => hay.includes(t))
      }),
    })).filter((section) => section.cards.length > 0)
  }, [activeGroup, isSearching, items, kw])

  const totalMatches = matchedByGroup.reduce((sum, s) => sum + s.cards.length, 0)

  return (
    <>
      <PageHeader
        title="配置"
        description="客户端接入方式、统一模型路由、防封自动化与安全维护。"
        actions={
          <div className="relative w-full sm:w-72">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" strokeWidth={1.75} />
            <Input
              type="search"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索配置项（如 跨域、映射、续写、错峰、锁…）"
              aria-label="搜索配置项"
              className="h-9 pr-8 pl-9 text-[13px]"
            />
            {isSearching && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="清空搜索"
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer rounded p-0.5"
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </button>
            )}
          </div>
        }
      />

      {/* 手机端与平板端顶部自适应胶囊分组栏（零横向滚动条，390px 自然折行） */}
      {!isSearching && (
        <nav
          aria-label="配置分组导航"
          className="mb-4 flex flex-wrap gap-1.5 rounded-xl bg-black/[0.04] p-1.5 lg:hidden dark:bg-white/[0.05]"
        >
          {GROUPS.map((g) => {
            const Icon = g.icon
            const active = activeGroup === g.id
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setActiveGroup(g.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-all active:scale-[0.98]',
                  active
                    ? 'bg-white text-foreground shadow-xs dark:bg-zinc-800'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span>{g.shortLabel}</span>
              </button>
            )
          })}
        </nav>
      )}

      <div className={cn('min-w-0', !isSearching && 'lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:items-start lg:gap-6')}>
        {/* 桌面端左窄二级分组侧栏（w-52 = 208px） */}
        {!isSearching && (
          <aside aria-label="配置二级导航" className="hidden w-52 shrink-0 lg:sticky lg:top-20 lg:block">
            <div className="space-y-1">
              {GROUPS.map((g) => {
                const Icon = g.icon
                const active = activeGroup === g.id
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setActiveGroup(g.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-all active:scale-[0.98]',
                      active
                        ? 'bg-white text-foreground ring-1 shadow-xs ring-black/[0.06] dark:bg-[#18181C] dark:ring-white/[0.08]'
                        : 'text-muted-foreground hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]',
                    )}
                  >
                    <Icon
                      className={cn('size-4 shrink-0 transition-colors', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')}
                      strokeWidth={1.75}
                    />
                    <span className="truncate">{g.label}</span>
                  </button>
                )
              })}
            </div>
          </aside>
        )}

        {/* 右侧主内容区（min-w-0 确保代码块与表格绝不撑宽视口） */}
        <div className="min-w-0 space-y-5">
          {isSearching && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-black/[0.06] bg-white/70 px-4 py-2.5 text-xs dark:border-white/[0.07] dark:bg-[#121215]/70">
              <span className="text-muted-foreground">
                跨全部分组搜索「<span className="text-foreground font-medium">{search.trim()}</span>」，共命中{' '}
                <span className="text-foreground tabular font-semibold">{fmtInt(totalMatches)}</span> 项配置卡
              </span>
              <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setSearch('')}>
                返回分组视图
              </Button>
            </div>
          )}

          {matchedByGroup.length === 0 ? (
            <Card>
              <Empty icon={<Search strokeWidth={1.75} />} title="没有匹配的配置项">
                <span>未找到与「{search.trim()}」相关的设置，试试搜「映射」「跨域」「续写」「错峰」或「锁」。</span>
                <div className="mt-3">
                  <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                    清空搜索词
                  </Button>
                </div>
              </Empty>
            </Card>
          ) : (
            matchedByGroup.map(({ group, cards }) => (
              <section key={group.id} className="min-w-0 space-y-4">
                {isSearching && (
                  <div className="flex items-center gap-2 px-1">
                    <group.icon className="text-muted-foreground size-3.5" strokeWidth={1.75} />
                    <span className="text-muted-foreground text-xs font-semibold tracking-wide">{group.label}</span>
                  </div>
                )}
                {cards.map((c) => (
                  <div key={c.id} className="min-w-0">
                    {c.render()}
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </>
  )
}

function SectionIcon({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-black/[0.04] text-muted-foreground dark:bg-white/[0.06] [&_svg]:size-4">
      {children}
    </span>
  )
}

function Head({ icon, title, desc, action }: { icon: ReactNode; title: string; desc?: ReactNode; action?: ReactNode }) {
  return (
    <CardHeader className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-start">
      <div className="flex w-full min-w-0 flex-1 items-start gap-3 sm:w-auto">
        <SectionIcon>{icon}</SectionIcon>
        <div className="min-w-0 flex-1">
          <CardTitle>{title}</CardTitle>
          {desc && <CardDescription className="mt-1 leading-relaxed break-words">{desc}</CardDescription>}
        </div>
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </CardHeader>
  )
}

// ── 1. 快速接入：接入指南 ──

type Snippet = 'curl' | 'claude' | 'python' | 'env' | 'dsh'

function ConnectCard() {
  const [show, setShow] = useState(false)
  const [snippet, setSnippet] = useState<Snippet>('curl')
  const key = auth.get()
  const masked = key.length > 16 ? `${key.slice(0, 4)}${'•'.repeat(12)}${key.slice(-4)}` : '•'.repeat(Math.max(key.length, 8))
  const origin = location.origin
  const base = `${origin}/v1`
  const catalog = useModelCatalog(snippet === 'dsh')
  const code = useMemo(() => {
    const k = show ? key : 'YOUR_API_KEY'
    if (snippet === 'dsh') return dshSnippet(base, k, catalog.data?.models ?? [])
    if (snippet === 'claude')
      return `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_API_KEY="${k}"

# 也可直调原生 Anthropic Messages API（兼容 x-api-key 与 Bearer）：
curl ${base}/messages \\
  -H "x-api-key: ${k}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model":"aggregate/auto","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'`
    if (snippet === 'curl')
      return `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"aggregate/auto","messages":[{"role":"user","content":"你好"}]}'`
    if (snippet === 'python')
      return `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${k}")
r = client.chat.completions.create(
    model="aggregate/auto",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)`
    return `OPENAI_BASE_URL=${base}
OPENAI_API_KEY=${k}
ANTHROPIC_BASE_URL=${origin}
ANTHROPIC_API_KEY=${k}`
  }, [snippet, show, key, base, origin, catalog.data])

  return (
    <Card>
      <Head
        icon={<Terminal strokeWidth={1.75} />}
        title="接入指南"
        desc="兼容 OpenAI 与 Anthropic 双协议：/v1/models、/v1/chat/completions、/v1/responses、/v1/messages（含 count_tokens），并支持 /v1/images/*、/v1/videos/*、/v1/audio/*、/v1/3d/*、/v1/tools/* 与 /mcp。"
      />
      <div className="space-y-3 px-5 pb-5">
        <Field label="Base URL" value={base} onCopy={() => copyText(base, '已复制 Base URL')} />
        <Field
          label="主密钥"
          value={show ? key : masked}
          mono
          onCopy={() => copyText(key, '已复制主密钥')}
          extra={
            <Button variant="ghost" size="icon-sm" onClick={() => setShow((v) => !v)} aria-label={show ? '隐藏' : '显示'}>
              {show ? <EyeOff strokeWidth={1.75} /> : <Eye strokeWidth={1.75} />}
            </Button>
          }
          hint="主密钥能登录控制台，给客户端用更推荐在「API Key」页签发子密钥。"
        />
        <div className="pt-1">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <Segmented<Snippet>
              value={snippet}
              onChange={setSnippet}
              className="max-w-full flex-wrap h-auto min-h-8 [&_button]:h-6 [&_button]:px-2.5 [&_button]:text-xs"
              options={[
                { value: 'curl', label: 'cURL' },
                { value: 'claude', label: 'Claude' },
                { value: 'python', label: 'Python' },
                { value: 'env', label: '环境变量' },
                { value: 'dsh', label: 'DSH' },
              ]}
            />
            <Button variant="ghost" size="sm" onClick={() => copyText(code.replaceAll('YOUR_API_KEY', key), '已复制（含真实密钥）')}>
              <Copy strokeWidth={1.75} /> 复制
            </Button>
          </div>
          <pre className={cn('bg-muted/70 overflow-x-auto rounded-lg px-4 py-3 font-mono text-[12px] leading-relaxed', snippet === 'dsh' && 'max-h-96 overflow-y-auto')}>{code}</pre>
          {snippet === 'dsh' && (
            <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
              DSH 只给配置里声明了 <code className="font-mono">reasoningEfforts</code> 的模型开「推理努力」，否则在本地直接报「不支持推理努力」。
              这份片段按「模型」页的真实目录生成（档位取上游下发的值），改完重启 DSH；模型 id 必须与这里一致。
              {catalog.isFetching && !catalog.data && ' 正在读取模型目录，稍等再复制…'}
              {catalog.data?.fallback && ' 当前没拉到真实模型，展示的是内置清单（没有档位与上下文信息）。'}
            </p>
          )}
        </div>
        <ul className="text-muted-foreground space-y-1.5 pt-1 text-[12.5px] leading-relaxed break-words">
          <li>
            <span className="text-foreground font-medium">模型怎么填：</span>
            <code className="font-mono">aggregate/auto</code> 自动挑可用的模型；
            <code className="font-mono">aggregate/&lt;模型&gt;</code> 在所有家里找同一个模型；
            <code className="font-mono">&lt;供应商&gt;/&lt;模型&gt;</code> 只走这一家。完整列表见「模型」页。
          </li>
          <li>
            <span className="text-foreground font-medium">双协议鉴权：</span>
            <span>数据面同时接受 Bearer 与 x-api-key 请求头（主密钥与子密钥均支持）。</span>
          </li>
          <li>
            <span className="text-foreground font-medium">媒体、语音与检索端点：</span>
            <code className="font-mono">/v1/images/generations</code>、
            <code className="font-mono">/v1/videos/generations</code>、
            <code className="font-mono">/v1/audio/speech</code>、
            <code className="font-mono">/v1/audio/transcriptions</code>、
            <code className="font-mono">/v1/3d/generations</code>、
            <code className="font-mono">/v1/tools/search</code>、
            <code className="font-mono">/mcp</code>。
          </li>
          <li>
            <span className="text-foreground font-medium">临时指定账号：</span>
            请求头加 <code className="font-mono">X-FLR-Account: &lt;uid&gt;</code>
            ，只对这一次请求生效，且不换号。
          </li>
        </ul>
      </div>
    </Card>
  )
}

// ── 1b. 快速接入：只读额度汇总接口 GET /v1/balance-summary ──

function BalanceSummaryCard() {
  const key = auth.get()
  const endpoint = `${location.origin}/v1/balance-summary`
  const curlPreview = `curl -s "${endpoint}" \\\n  -H "Authorization: Bearer YOUR_API_KEY"`
  const curlReal = `curl -s "${endpoint}" \\\n  -H "Authorization: Bearer ${key}"`

  return (
    <Card>
      <Head
        icon={<Coins strokeWidth={1.75} />}
        title="额度查询接口（GET /v1/balance-summary）"
        desc="轻量只读汇总池内可用账号的缓存积分与临期额度，不主动请求上游，毫秒级响应，适合接入桌面状态栏、监控探针或用量小组件。"
      />
      <div className="space-y-3 px-5 pb-5">
        <Field label="只读额度端点" value={endpoint} onCopy={() => copyText(endpoint, '已复制额度查询地址')} />
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">调用示例（支持主密钥或受限子密钥）</span>
            <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => copyText(curlReal, '已复制额度查询命令（含密钥）')}>
              <Copy strokeWidth={1.75} /> 复制命令
            </Button>
          </div>
          <pre className="bg-muted/70 overflow-x-auto rounded-lg px-4 py-3 font-mono text-[12px] leading-relaxed">{curlPreview}</pre>
        </div>
        <ul className="text-muted-foreground space-y-1 pt-0.5 text-[12.5px] leading-relaxed break-words">
          <li>
            <span className="text-foreground font-medium">返回字段：</span>
            汇总 <code className="font-mono">totalCredits</code>、<code className="font-mono">expiringCredits</code>、<code className="font-mono">earliestExpiry</code>、<code className="font-mono">healthyAccounts</code>、<code className="font-mono">totalAccounts</code> 及按供应商拆分的 <code className="font-mono">byProvider</code>。
          </li>
          <li>
            <span className="text-foreground font-medium">鉴权与权限隔离：</span>
            支持 <code className="font-mono">Authorization: Bearer</code>、<code className="font-mono">x-api-key</code> 请求头（状态栏小组件亦支持同名查询参数传入密钥）；使用受限子密钥调用时，仅统计该子密钥有权访问的供应商范围，绝不回传任何凭据敏感字段。
          </li>
        </ul>
      </div>
    </Card>
  )
}

function Field({
  label,
  value,
  mono = true,
  onCopy,
  extra,
  hint,
}: {
  label: string
  value: string
  mono?: boolean
  onCopy: () => void
  extra?: ReactNode
  hint?: string
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs">{label}</div>
      <div className="flex min-w-0 items-center gap-1 rounded-lg border py-1 pr-1 pl-3">
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', mono && 'font-mono')}>{value}</span>
        {extra}
        <Button variant="ghost" size="icon-sm" onClick={onCopy} aria-label={`复制${label}`}>
          <Copy strokeWidth={1.75} />
        </Button>
      </div>
      {hint && <div className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">{hint}</div>}
    </div>
  )
}

// ── 2. 路由与统一模型：路由策略与流式续写 ──

const STRATEGIES: { value: Strategy; title: string; desc: string }[] = [
  {
    value: 'expiry',
    title: '临期优先',
    desc: '积分最早过期的账号先用，少浪费',
  },
  { value: 'roundrobin', title: '轮询', desc: '最久没用的账号先用，负载均匀' },
  { value: 'random', title: '随机', desc: '每次随机挑一个可用账号' },
]

function RoutingCard() {
  const q = useRoutingConfig()
  const save = useSaveRouting()
  const [form, setForm] = useState<RoutingConfig | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const dirty =
    !!form &&
    !!q.data &&
    (form.strategy !== q.data.strategy ||
      form.maxRetries !== q.data.maxRetries ||
      form.softCooldownSeconds !== q.data.softCooldownSeconds ||
      Boolean(form.autoContinuation) !== Boolean(q.data.autoContinuation))

  const set = <K extends keyof RoutingConfig>(k: K, v: RoutingConfig[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const retriesOk = !!form && Number.isInteger(form.maxRetries) && form.maxRetries >= 0 && form.maxRetries <= 10
  const softOk = !!form && Number.isInteger(form.softCooldownSeconds) && form.softCooldownSeconds >= 10 && form.softCooldownSeconds <= 3600

  return (
    <Card>
      <Head
        icon={<Route strokeWidth={1.75} />}
        title="路由与选号策略"
        desc="网关怎么在可用账号之间挑选、失败后重试几次，以及长输出截断自动续写。"
        action={
          form && (
            <>
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => q.data && setForm(q.data)}>
                  还原
                </Button>
              )}
              <Button
                size="sm"
                disabled={!dirty || !retriesOk || !softOk || save.isPending}
                onClick={() =>
                  save.mutate({
                    strategy: form.strategy,
                    maxRetries: form.maxRetries,
                    softCooldownSeconds: form.softCooldownSeconds,
                    autoContinuation: form.autoContinuation === true,
                  })
                }
              >
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </>
          )
        }
      />
      {!form ? (
        <div className="space-y-3 px-5 pb-5">
          <Skeleton className="h-20" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <div className="space-y-5 px-5 pb-5">
          <div>
            <div className="mb-2 text-[13px] font-medium">选号策略</div>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="选号策略">
              {STRATEGIES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  role="radio"
                  aria-checked={form.strategy === s.value}
                  onClick={() => set('strategy', s.value)}
                  className={cn(
                    'cursor-pointer rounded-xl border px-3.5 py-3 text-left transition-all active:scale-[0.99]',
                    form.strategy === s.value ? 'border-primary bg-primary/[0.05] ring-primary/20 ring-2' : 'hover:bg-muted/60',
                  )}
                >
                  <div className="text-[13px] font-medium">{s.title}</div>
                  <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{s.desc}</div>
                </button>
              ))}
            </div>
            <div className="text-muted-foreground mt-1.5 text-[11.5px]">面板里「指定账号」与永久积分锁优先于策略生效。</div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumField
              label="失败换号次数"
              hint="一次请求失败后最多再换几个账号重试（0–10）"
              value={form.maxRetries}
              min={0}
              max={10}
              ok={retriesOk}
              onChange={(v) => set('maxRetries', v)}
            />
            <NumField
              label="限流冷却起步（秒）"
              hint="被限流的账号先歇这么久，连续限流翻倍，最长 30 分钟（10–3600）"
              value={form.softCooldownSeconds}
              min={10}
              max={3600}
              ok={softOk}
              onChange={(v) => set('softCooldownSeconds', v)}
            />
          </div>

          <div className="divide-y rounded-xl border">
            <ToggleRow
              title="流式截断自动续写与悬停救援"
              desc="当长回答因上限截断（finish_reason=length）或 Agent 停在预告句未执行工具时，自动无缝续写并通过 SSE 心跳保活（也可设环境变量 AUTO_CONTINUATION=true）。"
              checked={form.autoContinuation === true}
              onChange={(v) => set('autoContinuation', v)}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

// ── 2b. 路由与统一模型：出口感知别名映射可视化配置卡 ──

const UNIFIED_TARGET_COLUMNS: { key: string; label: string; placeholder: string }[] = [
  { key: 'buddy', label: '国内 Buddy', placeholder: '如 deepseek-v4.1-flash' },
  { key: 'workbuddy', label: '国际 WorkBuddy', placeholder: '如 claude-sonnet-4-5' },
  { key: 'codearts', label: 'CodeArts', placeholder: '可选目标模型 ID' },
  { key: 'modelscope', label: 'ModelScope', placeholder: '可选目标模型 ID' },
]

function normalizeDraftConfig(cfg: UnifiedModelsConfig): UnifiedModelsConfig {
  return {
    enabled: cfg.enabled,
    rules: cfg.rules.map((r) => {
      const cleanedTargets: Record<string, string> = {}
      for (const [k, val] of Object.entries(r.targets ?? {})) {
        const tv = val.trim()
        if (tv) cleanedTargets[k] = tv
      }
      const desc = r.description?.trim() ?? ''
      return {
        alias: r.alias.trim(),
        targets: cleanedTargets,
        ...(desc ? { description: desc } : {}),
      }
    }),
  }
}

function validateUnifiedDraft(cfg: UnifiedModelsConfig): string | null {
  const seen = new Set<string>()
  for (let i = 0; i < cfg.rules.length; i++) {
    const r = cfg.rules[i]!
    const alias = r.alias.trim()
    const rowNo = i + 1
    if (!alias) return `第 ${rowNo} 条规则的对外别名不能为空`
    if (alias.includes('/') || /\s/.test(alias)) return `第 ${rowNo} 条别名「${alias}」不能包含斜杠或空白字符`
    const lower = alias.toLowerCase()
    if (lower.startsWith('wb-search')) return `第 ${rowNo} 条别名「${alias}」使用了系统保留前缀 wb-search`
    if (seen.has(lower)) return `对外别名「${alias}」存在重复定义`
    seen.add(lower)
    const hasTarget = Object.values(r.targets ?? {}).some((v) => v.trim() !== '')
    if (!hasTarget) return `第 ${rowNo} 条别名「${alias}」至少需填写一个渠道的目标模型 ID`
  }
  return null
}

function UnifiedModelsCard() {
  const q = useUnifiedModelsConfig()
  const save = useSaveUnifiedModels()
  const [draft, setDraft] = useState<UnifiedModelsConfig | null>(null)

  useEffect(() => {
    if (q.data) setDraft(q.data)
  }, [q.data])

  const normalizedDraft = useMemo(() => (draft ? normalizeDraftConfig(draft) : null), [draft])
  const normalizedServer = useMemo(() => (q.data ? normalizeDraftConfig(q.data) : null), [q.data])
  const dirty = !!normalizedDraft && !!normalizedServer && JSON.stringify(normalizedDraft) !== JSON.stringify(normalizedServer)
  const validationError = useMemo(() => (draft ? validateUnifiedDraft(draft) : null), [draft])

  const addRule = () => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            enabled: prev.rules.length === 0 ? true : prev.enabled,
            rules: [...prev.rules, { alias: '', targets: {}, description: '' }],
          }
        : prev,
    )
  }

  const updateRule = (idx: number, patch: Partial<UnifiedModelRule>) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = [...prev.rules]
      const cur = next[idx]
      if (!cur) return prev
      next[idx] = { ...cur, ...patch }
      return { ...prev, rules: next }
    })
  }

  const updateTarget = (idx: number, providerId: string, modelId: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = [...prev.rules]
      const cur = next[idx]
      if (!cur) return prev
      const nextTargets = { ...cur.targets }
      if (modelId === '') delete nextTargets[providerId]
      else nextTargets[providerId] = modelId
      next[idx] = { ...cur, targets: nextTargets }
      return { ...prev, rules: next }
    })
  }

  const removeRule = (idx: number) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, rules: prev.rules.filter((_, i) => i !== idx) }
    })
  }

  return (
    <Card>
      <Head
        icon={<GitBranch strokeWidth={1.75} />}
        title="统一模型映射（出口感知别名）"
        desc="定义对外统一模型名（alias），网关按当前在线可用的供应商出口自动解析为对应渠道的真实模型 ID；仅当至少有一个目标渠道在线时才在 /v1/models 暴露该别名，且严格受子密钥模型白名单约束。"
        action={
          draft && (
            <>
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => q.data && setDraft(q.data)}>
                  还原
                </Button>
              )}
              <Button
                size="sm"
                disabled={!dirty || !!validationError || save.isPending}
                onClick={() => normalizedDraft && save.mutate(normalizedDraft)}
              >
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </>
          )
        }
      />

      {!draft ? (
        <div className="space-y-3 px-5 pb-5">
          {q.isError ? (
            <div className="border-danger/30 bg-danger/[0.06] rounded-lg border px-3.5 py-3">
              <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
                <ShieldAlert className="size-4" strokeWidth={1.75} /> 读取统一模型映射失败
              </div>
              <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{q.error.message}</div>
              <Button size="sm" variant="outline" className="mt-2.5" disabled={q.isFetching} onClick={() => q.refetch()}>
                重试
              </Button>
            </div>
          ) : (
            <>
              <Skeleton className="h-12" />
              <Skeleton className="h-28" />
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4 px-5 pb-5">
          <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <span>启用统一模型映射</span>
                <Badge tone={draft.enabled ? 'success' : 'neutral'} dot>
                  {draft.enabled ? `已启用 · ${fmtInt(draft.rules.length)} 条规则` : '未启用'}
                </Badge>
              </div>
              <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                开启后，客户端请求 <code className="font-mono">model</code> 填统一别名即可跨国内/国际可用出口无缝路由。
              </div>
            </div>
            <Switch
              label="启用统一模型映射"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((prev) => (prev ? { ...prev, enabled } : prev))}
            />
          </div>

          {validationError && (
            <div className="bg-warning/12 text-warning rounded-lg px-3.5 py-2 text-xs font-medium">
              {validationError}
            </div>
          )}

          {draft.rules.length === 0 ? (
            <div className="rounded-xl border border-dashed">
              <Empty icon={<Layers strokeWidth={1.75} />} title="暂未配置统一模型映射规则">
                <span>按需添加自定义对外别名（不会自动填充假数据）。例如将统一别名同时映射到国内与国际渠道模型。</span>
                <div className="mt-3">
                  <Button variant="outline" size="sm" onClick={addRule}>
                    <Plus strokeWidth={1.75} /> 添加第一条映射规则
                  </Button>
                </div>
              </Empty>
            </div>
          ) : (
            <div className="space-y-3">
              {draft.rules.map((rule, idx) => (
                <div
                  key={idx}
                  className="min-w-0 space-y-3 rounded-xl border border-black/[0.06] bg-black/[0.015] p-3.5 dark:border-white/[0.07] dark:bg-white/[0.02]"
                >
                  <div className="grid min-w-0 gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-end">
                    <div className="min-w-0">
                      <label className="text-muted-foreground mb-1 block text-[11.5px] font-medium">
                        对外别名（alias）
                      </label>
                      <Input
                        value={rule.alias}
                        onChange={(e) => updateRule(idx, { alias: e.target.value })}
                        placeholder="如 coder-pro 或 claude-sonnet"
                        aria-label={`第 ${idx + 1} 条对外别名`}
                        className="h-8 font-mono text-[12.5px]"
                      />
                    </div>
                    <div className="min-w-0">
                      <label className="text-muted-foreground mb-1 block text-[11.5px] font-medium">
                        备注（可选）
                      </label>
                      <Input
                        value={rule.description ?? ''}
                        onChange={(e) => updateRule(idx, { description: e.target.value })}
                        placeholder="用途或主力模型说明"
                        aria-label={`第 ${idx + 1} 条规则备注`}
                        className="h-8 text-[12.5px]"
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeRule(idx)}
                        aria-label={`删除第 ${idx + 1} 条映射规则`}
                        title="删除此条映射规则"
                      >
                        <Trash2 strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>

                  <div className="grid min-w-0 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                    {UNIFIED_TARGET_COLUMNS.map((col) => (
                      <div key={col.key} className="min-w-0">
                        <label className="text-muted-foreground mb-1 block text-[11px]">
                          {col.label}
                        </label>
                        <Input
                          value={rule.targets[col.key] ?? ''}
                          onChange={(e) => updateTarget(idx, col.key, e.target.value)}
                          placeholder={col.placeholder}
                          aria-label={`第 ${idx + 1} 条 ${col.label} 目标模型`}
                          className="h-8 font-mono text-xs"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-1">
                <Button variant="outline" size="sm" onClick={addRule}>
                  <Plus strokeWidth={1.75} /> 添加映射规则
                </Button>
                <span className="text-muted-foreground text-xs">留空的渠道表示该别名不路由到对应供应商</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── 3. 自动化与防封：定时福利错峰排程与续期 ──

function AutomationScheduleCard() {
  const q = useRoutingConfig()
  const save = useSaveRouting()
  const [form, setForm] = useState<RoutingConfig | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const dirty =
    !!form &&
    !!q.data &&
    (form.autoTaskCron !== q.data.autoTaskCron ||
      Boolean(form.cnTaskJitter) !== Boolean(q.data.cnTaskJitter) ||
      form.autoRefreshCredential !== q.data.autoRefreshCredential)

  const set = <K extends keyof RoutingConfig>(k: K, v: RoutingConfig[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  return (
    <Card>
      <Head
        icon={<CalendarClock strokeWidth={1.75} />}
        title="自动化任务与错峰排程"
        desc="管理每日自动签到、成长福利任务、国内账号随机错峰窗口以及登录凭据自动续期。"
        action={
          form && (
            <>
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => q.data && setForm(q.data)}>
                  还原
                </Button>
              )}
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate({
                    autoTaskCron: form.autoTaskCron,
                    cnTaskJitter: form.cnTaskJitter === true,
                    autoRefreshCredential: form.autoRefreshCredential,
                  })
                }
              >
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </>
          )
        }
      />
      {!form ? (
        <div className="space-y-3 px-5 pb-5">
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="px-5 pb-5">
          <div className="divide-y rounded-xl border">
            <ToggleRow
              title="自动签到与每日任务"
              desc="北京时间 09:00、21:00 签到，01:00 跑完整每日任务（CodeBuddy 含成长任务与领奖）。关掉后仍会每小时刷新余额。"
              checked={form.autoTaskCron}
              onChange={(v) => set('autoTaskCron', v)}
            />
            <ToggleRow
              title="国内福利随机错峰排程（08:00–10:00）"
              desc="开启后，在北京时间 08:00–10:00 窗口内按账号确定性哈希分散执行国内签到与猫猫旅行福利，消除整点同秒批量齐刷特征；关闭时保持默认 09:00 / 21:00 排程。"
              checked={form.cnTaskJitter === true}
              onChange={(v) => set('cnTaskJitter', v)}
            />
            <ToggleRow
              title="自动续期登录凭据"
              desc="定时检查快过期的登录凭据并自动刷新，避免账号突然掉线。"
              checked={form.autoRefreshCredential}
              onChange={(v) => set('autoRefreshCredential', v)}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

function NumField({
  label,
  hint,
  value,
  min,
  max,
  ok,
  step = 1,
  zero,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  ok: boolean
  step?: number | 'any'
  zero?: string
  onChange: (v: number) => void
}) {
  const id = `num-${label}`
  const decimal = step === 'any' || !Number.isInteger(step)
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] font-medium">
        <span>{label}</span>
        {zero && value === 0 && <Badge tone="neutral">{zero}</Badge>}
      </label>
      <Input
        id={id}
        type="number"
        inputMode={decimal ? 'decimal' : 'numeric'}
        step={step === 'any' ? 'any' : step}
        min={min}
        max={max}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className={cn('tabular w-32', !ok && 'border-danger focus-visible:border-danger')}
        aria-invalid={!ok}
      />
      <div className={cn('mt-1 text-[11.5px] leading-relaxed', ok ? 'text-muted-foreground' : 'text-danger')}>{hint}</div>
    </div>
  )
}

function ToggleRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed break-words">{desc}</div>
      </div>
      <Switch label={title} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

// ── 3b. 自动化与防封：防封 ──

const MS_PER_MINUTE = 60_000
const minutesOf = (ms: number) => (Number.isFinite(ms) ? Math.round(ms / 6) / 10_000 : Number.NaN)

function SafetyCard() {
  const q = useSafetyConfig()
  const save = useSaveSafety()
  const [form, setForm] = useState<SafetyConfig | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])
  const dirty = !!form && !!q.data && JSON.stringify(form) !== JSON.stringify(q.data)
  const set = <K extends keyof SafetyConfig>(k: K, v: SafetyConfig[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  const ctxOk = !!form && Number.isInteger(form.maxContextMessages) && form.maxContextMessages >= 0 && form.maxContextMessages <= 100_000
  const windowOk = !!form && Number.isFinite(form.burnRateWindowMs) && form.burnRateWindowMs >= 0 && form.burnRateWindowMs <= 86_400_000
  const pctOk = !!form && Number.isFinite(form.burnRateThresholdPct) && form.burnRateThresholdPct >= 0 && form.burnRateThresholdPct <= 100
  const qpsOk = !!form && Number.isFinite(form.rateLimitQps) && form.rateLimitQps >= 0 && form.rateLimitQps <= 50
  const jitterOk = !!form && Number.isInteger(form.rateJitterMs) && form.rateJitterMs >= 0 && form.rateJitterMs <= 10_000
  const allOk = ctxOk && windowOk && pctOk && qpsOk && jitterOk

  return (
    <Card>
      <Head
        icon={<ShieldCog strokeWidth={1.75} />}
        title="防封与风控规避"
        desc="降低被上游风控判成机器行为的开关，可按需开关。五个数值项填 0 都有明确含义（不限制 / 关闭 / 不限速 / 不抖动），不是「没设置」。"
        action={
          form && (
            <>
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => q.data && setForm(q.data)}>
                  还原
                </Button>
              )}
              <Button size="sm" disabled={!dirty || !allOk || save.isPending} onClick={() => form && save.mutate(form)}>
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </>
          )
        }
      />
      {!form ? (
        <div className="space-y-3 px-5 pb-5">
          {q.isError ? (
            <div className="border-danger/30 bg-danger/[0.06] rounded-lg border px-3.5 py-3">
              <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
                <ShieldAlert className="size-4" strokeWidth={1.75} /> 读取防封配置失败
              </div>
              <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{q.error.message}</div>
              <Button size="sm" variant="outline" className="mt-2.5" disabled={q.isFetching} onClick={() => q.refetch()}>
                {q.isFetching ? '重试中…' : '重试'}
              </Button>
            </div>
          ) : (
            <>
              <Skeleton className="h-14" />
              <Skeleton className="h-28" />
            </>
          )}
        </div>
      ) : (
        <div className="space-y-5 px-5 pb-5">
          {q.isError && (
            <div className="text-warning bg-warning/10 rounded-md px-3 py-2 text-xs leading-relaxed">
              没读到最新配置（{q.error.message}），下面是上次读到的值；保存仍以表单为准。
            </div>
          )}

          <div className="divide-y rounded-xl border">
            <ToggleRow
              title="会话链（b3 + x-conversation-*）"
              desc="关掉 = 不再发 b3 三件套，请求失去可串联的链路特征；x-conversation-* 那 5 个是必需头（缺了上游直接回 11‑128），仍照发。"
              checked={form.sessionTrace}
              onChange={(v) => set('sessionTrace', v)}
            />
            <ToggleRow
              title="模型级冷却（某个模型失败后暂时拉黑它）"
              desc="关掉后失败的请求照样报错、照样换号，但不再把「这个账号 + 这个模型」的组合锁上几分钟到几小时。实测上游的 429 / 排队多为瞬时，锁起来经常变成「明明还能用却选不到号」。账号级冷却（熔断、余额耗尽、上游封号）不受此开关影响。"
              checked={form.modelCooldownEnabled}
              onChange={(v) => set('modelCooldownEnabled', v)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumField
              label="单请求消息数上限"
              hint="0 = 不限制；建议 300 —— 已观测到的封禁样本最少也带了 434 条消息。"
              value={form.maxContextMessages}
              min={0}
              max={100_000}
              ok={ctxOk}
              zero="不限制"
              onChange={(v) => set('maxContextMessages', v)}
            />
            <NumField
              label="消耗熔断窗口（分钟）"
              hint="0 = 关闭；窗口不能短于采样间隔（整点 cron ⇒ 至少 60 分钟），否则每轮都在跟自己的起点比，检测永远不会触发。"
              value={minutesOf(form.burnRateWindowMs)}
              min={0}
              max={1440}
              step="any"
              ok={windowOk}
              zero="已关闭"
              onChange={(v) => set('burnRateWindowMs', Math.round(v * MS_PER_MINUTE))}
            />
            <NumField
              label="消耗熔断阈值（%）"
              hint="0 = 关闭；窗口内消耗掉的积分占窗口起点余额的百分比，超过就熔断。"
              value={form.burnRateThresholdPct}
              min={0}
              max={100}
              ok={pctOk}
              zero="已关闭"
              onChange={(v) => set('burnRateThresholdPct', v)}
            />
            <NumField
              label="每账号 QPS 上限"
              hint="0 = 不限速；开了之后同一账号的上游请求要排队，吞吐明显下降，只在上游 429 咬过之后才建议开（可填 0.5）。"
              value={form.rateLimitQps}
              min={0}
              max={50}
              step="any"
              ok={qpsOk}
              zero="不限速"
              onChange={(v) => set('rateLimitQps', v)}
            />
            <NumField
              label="请求前随机抖动（毫秒）"
              hint="0 = 不抖动；每次请求前随机等 0~N 毫秒，把固定节奏打散。"
              value={form.rateJitterMs}
              min={0}
              max={10_000}
              step={100}
              ok={jitterOk}
              zero="不抖动"
              onChange={(v) => set('rateJitterMs', v)}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

// ── 4. 安全与跨域：数据面 CORS ──

function CorsCard() {
  const q = useCorsConfig()
  const save = useSaveCorsConfig()
  const [enabled, setEnabled] = useState(false)
  const [originsText, setOriginsText] = useState('')

  useEffect(() => {
    if (q.data) {
      setEnabled(q.data.enabled)
      setOriginsText(q.data.origins.join(', '))
    }
  }, [q.data])

  const baselineOrigins = q.data?.origins.join(', ') ?? ''
  const dirty = !!q.data && (enabled !== q.data.enabled || originsText.trim() !== baselineOrigins.trim())

  return (
    <Card>
      <Head
        icon={<Globe strokeWidth={1.75} />}
        title="数据面跨域（CORS）"
        desc="控制浏览器端应用直调 /v1/* 与 /mcp 的跨域白名单（也可设环境变量 CORS_ORIGINS）。管理接口 /admin/* 始终禁止跨域。"
        action={
          q.data && dirty ? (
            <Button
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ enabled, origins: originsText })}
            >
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-3 px-5 pb-5">
        {!q.data ? (
          <Skeleton className="h-20" />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">启用跨域放行</div>
                <div className="text-muted-foreground text-xs">
                  {q.data.source === 'runtime' ? '当前使用面板覆盖值' : '当前跟随环境变量 CORS_ORIGINS'}
                </div>
              </div>
              <Switch label="启用跨域放行" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div>
              <div className="text-muted-foreground mb-1 text-xs">允许来源（逗号分隔，填 * 允许任意来源）</div>
              <Input
                value={originsText}
                onChange={(e) => setOriginsText(e.target.value)}
                placeholder="例如：https://app.example.com, http://localhost:3000 或 *"
                className="font-mono text-[12.5px]"
              />
            </div>
            {q.data.source === 'runtime' && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground cursor-pointer text-xs underline decoration-dotted"
                disabled={save.isPending}
                onClick={() => save.mutate({ resetToEnv: true })}
              >
                恢复跟随环境变量（{q.data.envOrigins.length ? q.data.envOrigins.join(', ') : '默认关闭'}）
              </button>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

// ── 4b. 安全与跨域：永久积分锁（含 0 倍率免费模型自动豁免提示） ──

function LocksCard() {
  const providers = useProviders()
  const accounts = useAccounts()
  const locks = usePermanentLocks()
  const setLock = useSetPermanentLock()
  const [all, setAll] = useState(false)
  const used = new Set((accounts.data ?? []).map((a) => a.provider))
  const list = (providers.data?.providers ?? []).filter((p) => all || used.has(p.id) || locks.data?.[p.id])
  const hidden = (providers.data?.providers.length ?? 0) - list.length

  return (
    <Card>
      <Head
        icon={<Lock strokeWidth={1.75} />}
        title="永久积分锁"
        desc="开启后，这家「只剩永久积分」的账号不再参与计费模型选号，免得免费额度用完后悄悄烧掉花钱买的积分。"
      />
      <div className="space-y-3 px-5 pb-5">
        <div className="flex items-start gap-2.5 rounded-xl border border-[#0071E3]/20 bg-[#0071E3]/[0.05] px-3.5 py-2.5 text-xs leading-relaxed dark:border-[#0A84FF]/25 dark:bg-[#0A84FF]/[0.08]">
          <Sparkles className="text-primary mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
          <div className="min-w-0 flex-1 break-words">
            <span className="text-foreground font-medium">0 倍率纯免费模型自动豁免保留线：</span>
            <span className="text-muted-foreground">
              调用已确认 0 倍率的纯免费模型时（不扣减任何积分），即使账号开启了永久积分锁或跌破保留线，只要账号未停用、未熔断且未被上游封号，网关仍会正常派发免费模型请求。
            </span>
          </div>
        </div>

        {!locks.data || !providers.data ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="divide-y rounded-xl border">
            {list.map((p) => {
              const on = !!locks.data[p.id]
              return (
                <div key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <ProviderAvatar id={p.id} name={p.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{p.name}</div>
                    <div className="text-muted-foreground text-[11.5px]">{on ? '已锁定，永久积分受保护（0 倍率免费模型豁免）' : '未锁定，可能消耗永久积分'}</div>
                  </div>
                  {on && <Badge tone="success" dot>已锁</Badge>}
                  <Switch
                    label={`${p.name} 永久积分锁`}
                    checked={on}
                    disabled={setLock.isPending}
                    onCheckedChange={(v) =>
                      setLock.mutate({
                        provider: p.id,
                        name: p.name,
                        locked: v,
                      })
                    }
                  />
                </div>
              )
            })}
            {!list.length && <div className="text-muted-foreground px-3.5 py-5 text-center text-[13px]">还没有账号</div>}
          </div>
        )}
        {(hidden > 0 || all) && (
          <button type="button" className="text-muted-foreground hover:text-foreground cursor-pointer text-xs" onClick={() => setAll((v) => !v)}>
            {all ? '只看有账号的供应商' : `显示其余 ${hidden} 家没有账号的供应商`}
          </button>
        )}
      </div>
    </Card>
  )
}

// ── 5. 运行态与维护：运行状态 ──

function StatusCard() {
  const pool = usePool()
  const waf = useWaf()
  const creds = useCredentialCount()
  const clearWaf = useClearWaf()
  const clearCd = useClearCooldowns()
  const [confirm, setConfirm] = useState(false)
  const blocked = waf.data?.filter((w) => w.active) ?? []
  const c = pool.data
  const cooling = (c?.cooling ?? 0) + (c?.modelExempt ?? 0)

  return (
    <Card>
      <Head icon={<Gauge strokeWidth={1.75} />} title="运行状态与维护" desc="实时观测池内账号健康度、出口 IP 拦截状态与冷却清理。" />
      <div className="space-y-3 px-5 pb-5">
        <div className="grid grid-cols-3 divide-x rounded-xl border">
          {[
            ['账号', c?.total],
            ['可用', c?.healthy],
            ['已存凭据', creds.data],
          ].map(([k, v]) => (
            <div key={k as string} className="min-w-0 px-3.5 py-2.5">
              <div className="text-muted-foreground truncate text-xs">{k}</div>
              <div className="tabular mt-0.5 font-sans text-lg font-semibold tracking-tight tabular-nums">
                {v === undefined ? '—' : fmtInt(v as number)}
              </div>
            </div>
          ))}
        </div>

        {c && creds.data !== undefined && creds.data < c.total && (
          <div className="text-warning bg-warning/10 rounded-md px-3 py-2 text-xs leading-relaxed">
            有 {fmtInt(c.total - creds.data)} 个账号没有存下凭据，网关用不了它们，需要重新登录或导入。
          </div>
        )}
        {blocked.length ? (
          <div className="border-danger/30 bg-danger/[0.06] rounded-xl border px-3.5 py-3">
            <div className="text-danger flex items-center gap-2 text-[13px] font-medium">
              <ShieldAlert className="size-4" strokeWidth={1.75} /> 出口 IP 被上游拦截
            </div>
            <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {blocked.map((w) => `${w.realm === 'cn' ? '国内版' : '国际版'}${w.until ? `，${fmtDateTime(w.until)} 自动恢复` : ''}`).join('；')}
              。期间该分片的请求会直接失败，避免越试越封。确认已换 IP 可以提前解除。
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2.5"
              disabled={clearWaf.isPending}
              onClick={() => clearWaf.mutate(blocked.map((w) => w.realm))}
            >
              立即解除
            </Button>
          </div>
        ) : (
          <Row
            icon={<ShieldCheck className="text-success" strokeWidth={1.75} />}
            title="出口 IP 正常"
            desc={waf.isLoading ? '检查中…' : '国内版、国际版都没有被上游 WAF 拦截'}
          />
        )}

        <Row
          icon={<Snowflake className={cooling ? 'text-warning' : 'text-muted-foreground'} strokeWidth={1.75} />}
          title={cooling ? `${fmtInt(cooling)} 个账号在冷却 / 限流` : '没有账号在冷却'}
          desc="冷却到期会自动恢复；确认上游已恢复可以手动全部清空。"
          action={
            <Button size="sm" variant="outline" disabled={!cooling || clearCd.isPending} onClick={() => setConfirm(true)}>
              全部清空
            </Button>
          }
        />
        <Row
          icon={<CalendarClock className="text-muted-foreground" strokeWidth={1.75} />}
          title="定时器每小时触发一次"
          desc="每小时刷新余额、续期凭据；北京时间 01 / 09 / 21 点另跑签到与每日任务（开启随机错峰后于 08:00–10:00 分散触发）。"
        />
        <Row
          icon={<Lock className="text-muted-foreground" strokeWidth={1.75} />}
          title="凭据加密存储与备份迁移"
          desc="账号凭据用 AES-GCM 加密后落盘（HTTP 接口不回传明文令牌）；跨机器完整备份或迁移时请同时拷贝 data/ 目录与 .env 中的 CREDENTIAL_KEY。"
        />
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="清空全部冷却？"
        description="所有账号立刻回到可选状态。如果上游仍在限流，它们会很快再次进入冷却。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button
              onClick={() =>
                clearCd.mutate(undefined, {
                  onSuccess: () => setConfirm(false),
                })
              }
              disabled={clearCd.isPending}
            >
              清空
            </Button>
          </>
        }
      />
    </Card>
  )
}

function Row({ icon, title, desc, action }: { icon: ReactNode; title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border px-3.5 py-3">
      <span className="shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed break-words">{desc}</div>
      </div>
      {action}
    </div>
  )
}
