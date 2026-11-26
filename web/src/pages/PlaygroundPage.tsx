import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CornerDownLeft,
  Gauge,
  MessagesSquare,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  User,
  Zap,
} from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/input'
import { Segmented } from '@/components/ui/misc'
import { auth } from '@/lib/api'
import { priceOf, useModelCatalog, useProbeCache, type GatewayModel } from '@/lib/models'
import { useHashParam } from '@/lib/router'
import { cn, fmtInt } from '@/lib/utils'

type Protocol = 'openai' | 'anthropic'

interface Telemetry {
  ttftMs: number | null
  totalMs: number
  tokPerSec: number | null
  inputTokens: number | null
  outputTokens: number | null
  estimatedOutput: boolean
  protocol: Protocol
  model: string
}

interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  streaming?: boolean
  error?: string
  telemetry?: Telemetry
}

const DEFAULT_MODEL = 'aggregate/auto'

const QUICK_PROMPTS = [
  { label: '连通性与身份探测', text: '请用两句话介绍你当前的模型特点，并给出一个简洁的 TypeScript 防抖函数示例。' },
  { label: '深度推理测试', text: '有 3 个开关对应房间里的 3 盏白炽灯，只能进房间看一次，如何确定每个开关对应哪盏灯？请展示简洁的推理步骤。' },
  { label: 'JSON 结构化输出', text: '请输出一个符合苹果 HIG 色彩规范的深浅双色 Token 示例代码块（仅含 JSON 代码块与简短说明）。' },
]

function makeId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x4e00) cjk++
  }
  const rest = text.length - cjk
  return Math.max(1, Math.round(cjk * 0.65 + rest / 3.8))
}

function extractHttpError(text: string, status: number): string {
  const trimmed = text.trim()
  if (!trimmed) return `请求失败 (HTTP ${status})`
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    const err = obj.error
    if (typeof err === 'string' && err) return err
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message
      if (typeof msg === 'string' && msg) return msg
    }
    if (typeof obj.message === 'string' && obj.message) return obj.message
    if (typeof obj.detail === 'string' && obj.detail) return obj.detail
  } catch {
    // 非 JSON 错误文本直接截取展示
  }
  return trimmed.slice(0, 400)
}

/** 纯 React 行内富文本解析（支持行内代码与加粗，零 HTML 注入风险）。 */
function renderInline(line: string): ReactNode[] {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          className="rounded-md border border-black/[0.07] bg-black/[0.04] px-1.5 py-0.5 font-mono text-[12px] break-words dark:border-white/[0.1] dark:bg-white/[0.07]"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <Fragment key={idx}>{part}</Fragment>
  })
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败')
    }
  }
  return (
    <div className="my-2.5 max-w-full min-w-0 overflow-hidden rounded-xl border border-black/[0.08] bg-[#FAFAFC] dark:border-white/[0.09] dark:bg-[#0D0D10]">
      <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] bg-black/[0.025] px-3 py-1.5 text-[11.5px] dark:border-white/[0.07] dark:bg-white/[0.03]">
        <span className="text-muted-foreground truncate font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="text-muted-foreground hover:text-foreground inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
        >
          {copied ? <Check className="size-3.5 text-[#30D158]" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
          <span>{copied ? '已复制' : '复制代码'}</span>
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed [&::-webkit-scrollbar]:h-1.5">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** 安全纯 JSX Markdown 渲染器（兼容流式未闭合代码块，零横向溢出）。 */
function SafeMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: ({ kind: 'code'; lang: string; code: string } | { kind: 'text'; content: string })[] = []
    const lines = text.split('\n')
    let inCode = false
    let codeLang = ''
    let buf: string[] = []

    for (const line of lines) {
      const fence = /^```([\w+-]*)\s*$/.exec(line.trimEnd())
      if (!inCode && fence) {
        if (buf.length > 0) {
          out.push({ kind: 'text', content: buf.join('\n') })
          buf = []
        }
        inCode = true
        codeLang = fence[1] ?? ''
      } else if (inCode && line.trim() === '```') {
        out.push({ kind: 'code', lang: codeLang, code: buf.join('\n') })
        buf = []
        inCode = false
        codeLang = ''
      } else {
        buf.push(line)
      }
    }
    if (buf.length > 0) {
      if (inCode) out.push({ kind: 'code', lang: codeLang, code: buf.join('\n') })
      else out.push({ kind: 'text', content: buf.join('\n') })
    }
    return out
  }, [text])

  return (
    <div className="min-w-0 space-y-2 text-[13.5px] leading-relaxed break-words">
      {blocks.map((b, i) => {
        if (b.kind === 'code') return <CodeBlock key={i} lang={b.lang} code={b.code} />
        const lines = b.content.split('\n')
        return (
          <div key={i} className="min-w-0 space-y-1.5">
            {lines.map((line, j) => {
              const trimmed = line.trim()
              if (!trimmed) return <div key={j} className="h-1" />
              if (trimmed.startsWith('### '))
                return (
                  <h4 key={j} className="pt-1 text-[14.5px] font-semibold tracking-tight">
                    {renderInline(trimmed.slice(4))}
                  </h4>
                )
              if (trimmed.startsWith('## '))
                return (
                  <h3 key={j} className="pt-1.5 text-[15.5px] font-semibold tracking-tight">
                    {renderInline(trimmed.slice(3))}
                  </h3>
                )
              if (trimmed.startsWith('# '))
                return (
                  <h2 key={j} className="pt-2 text-[17px] font-semibold tracking-tight">
                    {renderInline(trimmed.slice(2))}
                  </h2>
                )
              if (trimmed.startsWith('- ') || trimmed.startsWith('* '))
                return (
                  <div key={j} className="flex min-w-0 gap-2 pl-1">
                    <span className="text-muted-foreground select-none">•</span>
                    <span className="min-w-0 flex-1">{renderInline(trimmed.slice(2))}</span>
                  </div>
                )
              const ordered = /^(\d+)\.\s+(.*)$/.exec(trimmed)
              if (ordered)
                return (
                  <div key={j} className="flex min-w-0 gap-2 pl-1">
                    <span className="text-muted-foreground shrink-0 font-sans text-xs tabular-nums select-none">{ordered[1]}.</span>
                    <span className="min-w-0 flex-1">{renderInline(ordered[2]!)}</span>
                  </div>
                )
              if (trimmed.startsWith('> '))
                return (
                  <blockquote key={j} className="text-muted-foreground border-l-2 border-[#0071E3]/40 pl-3 italic dark:border-[#0A84FF]/50">
                    {renderInline(trimmed.slice(2))}
                  </blockquote>
                )
              return <p key={j}>{renderInline(line)}</p>
            })}
          </div>
        )
      })}
    </div>
  )
}

function ReasoningPanel({ reasoning, streaming, hasContent }: { reasoning: string; streaming?: boolean; hasContent: boolean }) {
  const [open, setOpen] = useState(true)
  const userToggledRef = useRef(false)

  useEffect(() => {
    // 正文开始输出后若用户未手动干预，保持适度折叠或展开：流式思考中自动展开，完成后如果很长也允许用户随时折叠
    if (streaming && !hasContent && !userToggledRef.current) {
      setOpen(true)
    }
  }, [streaming, hasContent])

  if (!reasoning) return null
  const activelyThinking = Boolean(streaming && !hasContent)

  return (
    <div className="mb-3 min-w-0 overflow-hidden rounded-xl border border-black/[0.06] bg-black/[0.02] dark:border-white/[0.08] dark:bg-white/[0.03] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true
          setOpen((v) => !v)
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <Brain className={cn('size-3.5 shrink-0 text-[#0071E3] dark:text-[#409CFF]', activelyThinking && 'animate-pulse')} strokeWidth={1.75} />
        <span className="truncate">{activelyThinking ? '正在深度思考…' : '思考过程 (Reasoning)'}</span>
        <span className="text-muted-foreground ml-auto shrink-0 font-sans text-[11px] tabular-nums">{fmtInt(reasoning.length)} 字</span>
        <ChevronRight
          className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]', open && 'rotate-90')}
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <div className="text-muted-foreground max-h-72 overflow-y-auto border-t border-black/[0.05] px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words dark:border-white/[0.06]">
          {reasoning}
        </div>
      )}
    </div>
  )
}

function ModelPicker({
  value,
  onChange,
  models,
}: {
  value: string
  onChange: (m: string) => void
  models: GatewayModel[]
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const { cache: probeCache } = useProbeCache()

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const merged = useMemo(() => {
    const hasAuto = models.some((m) => m.id === DEFAULT_MODEL)
    return hasAuto
      ? models
      : [{ id: DEFAULT_MODEL, name: '自动选择最优可用模型', owned_by: 'aggregate', isFree: true }, ...models]
  }, [models])

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = q
      ? merged.filter((m) => `${m.id} ${m.name ?? ''} ${m.owned_by}`.toLowerCase().includes(q))
      : merged
    const map = new Map<string, GatewayModel[]>()
    for (const m of filtered) {
      const group = m.id.startsWith('aggregate/') ? '智能聚合路由' : m.owned_by || '其他渠道'
      const list = map.get(group) ?? []
      list.push(m)
      map.set(group, list)
    }
    return [...map.entries()]
  }, [merged, filter])

  const currentMeta = merged.find((m) => m.id === value)

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1 sm:max-w-xs lg:max-w-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="选择测试模型"
        className="flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-black/[0.08] bg-white px-3 text-left text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:bg-black/[0.02] dark:border-white/[0.09] dark:bg-[#18181C] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] dark:hover:bg-white/[0.05]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-3.5 shrink-0 text-[#0071E3] dark:text-[#409CFF]" strokeWidth={1.75} />
          <span className="truncate font-medium">{value}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {currentMeta && priceOf(currentMeta, probeCache[currentMeta.id])?.label === '免费' && (
            <span className="hidden rounded-full bg-[#30D158]/14 px-1.5 py-0.5 text-[10.5px] font-medium text-[#1D8338] sm:inline dark:text-[#30D158]">
              免费
            </span>
          )}
          <ChevronDown className="text-muted-foreground size-3.5" strokeWidth={1.75} />
        </div>
      </button>

      {open && (
        <div className="glass-surface absolute left-0 z-40 mt-1.5 flex max-h-80 w-full min-w-[260px] flex-col overflow-hidden rounded-xl border border-black/[0.08] bg-white/94 shadow-[0_16px_40px_rgba(0,0,0,0.14)] sm:w-[380px] dark:border-white/[0.1] dark:bg-[#16161A]/94 dark:shadow-[0_20px_48px_rgba(0,0,0,0.65)]">
          <div className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.08]">
            <Search className="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filter.trim()) {
                  const first = grouped[0]?.[1]?.[0]
                  onChange(first ? first.id : filter.trim())
                  setOpen(false)
                }
              }}
              placeholder="筛选模型或直接输入统一模型别名…"
              className="placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 [&::-webkit-scrollbar]:w-1.5">
            {filter.trim() && !merged.some((m) => m.id === filter.trim()) && (
              <button
                type="button"
                onClick={() => {
                  onChange(filter.trim())
                  setOpen(false)
                }}
                className="mb-1 flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg bg-[#0071E3]/[0.08] px-2.5 py-1.5 text-left text-xs font-medium text-[#0071E3] dark:bg-[#0A84FF]/[0.15] dark:text-[#409CFF]"
              >
                <span className="truncate">使用自定义模型 / 统一别名：{filter.trim()}</span>
                <CornerDownLeft className="size-3.5 shrink-0" strokeWidth={1.75} />
              </button>
            )}

            {grouped.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-xs">无匹配模型，按回车可直接填入自定义模型名</div>
            ) : (
              grouped.map(([group, list]) => (
                <div key={group} className="mb-2 last:mb-0">
                  <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wider uppercase">{group}</div>
                  {list.map((m) => {
                    const active = m.id === value
                    const p = priceOf(m, probeCache[m.id])
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onChange(m.id)
                          setOpen(false)
                        }}
                        className={cn(
                          'flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                          active
                            ? 'bg-[#0071E3]/[0.1] font-medium text-[#0071E3] dark:bg-[#0A84FF]/[0.18] dark:text-[#409CFF]'
                            : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{m.id}</div>
                          {m.name && m.name !== m.id && <div className="text-muted-foreground truncate text-[11px] font-normal">{m.name}</div>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {p && (
                            <Badge tone={p.tone} className="h-[18px] px-1.5 text-[10px]">
                              {p.label}
                            </Badge>
                          )}
                          {active && <Check className="size-3.5 shrink-0" strokeWidth={2} />}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function PlaygroundPage() {
  const hashModel = useHashParam('model')
  const catalog = useModelCatalog()

  const [model, setModel] = useState(() => hashModel || DEFAULT_MODEL)
  const [protocol, setProtocol] = useState<Protocol>('openai')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [temperature, setTemperature] = useState<number>(0.7)
  const [maxTokens, setMaxTokens] = useState<number>(4096)

  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const scrollEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (hashModel && hashModel.trim()) {
      setModel(hashModel.trim())
    }
  }, [hashModel])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length])

  const stopGeneration = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)))
  }

  const clearConversation = () => {
    stopGeneration()
    setTurns([])
  }

  const sendPrompt = async (promptText: string, baseHistory?: ChatTurn[]) => {
    const trimmed = promptText.trim()
    if (!trimmed || streaming) return

    const history = (baseHistory ?? turns).filter((t) => !t.error || t.content)
    const userTurn: ChatTurn = { id: makeId(), role: 'user', content: trimmed, reasoning: '' }
    const assistantId = makeId()
    const assistantTurn: ChatTurn = {
      id: assistantId,
      role: 'assistant',
      content: '',
      reasoning: '',
      streaming: true,
    }

    const nextHistory = [...history, userTurn]
    setTurns([...nextHistory, assistantTurn])
    if (!baseHistory) setInput('')
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    const startedAt = performance.now()
    let ttftMs: number | null = null
    let accContent = ''
    let accReasoning = ''
    let inputTokens: number | null = null
    let outputTokens: number | null = null

    const markFirstToken = () => {
      if (ttftMs === null) {
        ttftMs = Math.max(1, Math.round(performance.now() - startedAt))
      }
    }

    const syncTurn = (patch?: Partial<ChatTurn>) => {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === assistantId
            ? {
                ...t,
                content: accContent,
                reasoning: accReasoning,
                ...patch,
              }
            : t,
        ),
      )
    }

    try {
      const endpoint = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'
      const headers: Record<string, string> = {
        authorization: 'Bearer ' + auth.get(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      }
      if (protocol === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01'
      }

      const body =
        protocol === 'openai'
          ? {
              model,
              stream: true,
              stream_options: { include_usage: true },
              temperature,
              max_tokens: maxTokens,
              messages: [
                ...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : []),
                ...nextHistory.map((m) =>
                  m.role === 'assistant'
                    ? {
                        role: 'assistant',
                        content: m.content,
                        ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
                      }
                    : { role: 'user', content: m.content },
                ),
              ],
            }
          : {
              model,
              stream: true,
              max_tokens: Math.max(1, maxTokens || 4096),
              temperature,
              ...(systemPrompt.trim() ? { system: systemPrompt.trim() } : {}),
              messages: nextHistory.map((m) =>
                m.role === 'assistant'
                  ? {
                      role: 'assistant',
                      content: [
                        ...(m.reasoning ? [{ type: 'thinking', thinking: m.reasoning }] : []),
                        { type: 'text', text: m.content || ' ' },
                      ],
                    }
                  : { role: 'user', content: m.content },
              ),
            }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      if (res.status === 401) {
        window.dispatchEvent(new Event('auth:expired'))
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(extractHttpError(errText, res.status))
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!res.body || contentType.includes('application/json')) {
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
        markFirstToken()
        if (protocol === 'openai') {
          const choices = Array.isArray(json.choices) ? json.choices : []
          const first = (choices[0] as { message?: Record<string, unknown> } | undefined)?.message
          if (first) {
            if (typeof first.reasoning_content === 'string') accReasoning += first.reasoning_content
            if (typeof first.content === 'string') accContent += first.content
          }
          const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
          if (typeof usage?.prompt_tokens === 'number') inputTokens = usage.prompt_tokens
          if (typeof usage?.completion_tokens === 'number') outputTokens = usage.completion_tokens
        } else {
          const blocks = Array.isArray(json.content) ? json.content : []
          for (const b of blocks) {
            if (!b || typeof b !== 'object') continue
            const blk = b as { type?: string; thinking?: string; text?: string }
            if (blk.type === 'thinking' && typeof blk.thinking === 'string') accReasoning += blk.thinking
            if (blk.type === 'text' && typeof blk.text === 'string') accContent += blk.text
          }
          const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined
          if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens
          if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens
        }
      } else {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = ''

        const handleSseData = (dataStr: string, eventName: string) => {
          const trimmedData = dataStr.trim()
          if (!trimmedData || trimmedData === '[DONE]') return
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(trimmedData) as Record<string, unknown>
          } catch {
            return
          }

          if (parsed.error) {
            const msg = extractHttpError(trimmedData, 500)
            throw new Error(msg)
          }

          if (protocol === 'openai') {
            const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined
            if (usage && typeof usage === 'object') {
              if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens
              else if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
              if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens
              else if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
            }
            const choices = Array.isArray(parsed.choices) ? parsed.choices : []
            for (const rawChoice of choices) {
              if (!rawChoice || typeof rawChoice !== 'object') continue
              const choice = rawChoice as { delta?: Record<string, unknown>; message?: Record<string, unknown> }
              const carrier = choice.delta ?? choice.message
              if (!carrier) continue
              const r =
                typeof carrier.reasoning_content === 'string'
                  ? carrier.reasoning_content
                  : typeof carrier.reasoning === 'string'
                    ? carrier.reasoning
                    : ''
              const c = typeof carrier.content === 'string' ? carrier.content : ''
              if (r) {
                markFirstToken()
                accReasoning += r
              }
              if (c) {
                markFirstToken()
                accContent += c
              }
            }
            syncTurn()
          } else {
            const evType = (typeof parsed.type === 'string' ? parsed.type : eventName).trim()
            if (evType === 'error') {
              throw new Error(extractHttpError(trimmedData, 500))
            }
            if (evType === 'message_start') {
              const msg = parsed.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined
              if (typeof msg?.usage?.input_tokens === 'number' && msg.usage.input_tokens > 0) inputTokens = msg.usage.input_tokens
              if (typeof msg?.usage?.output_tokens === 'number' && msg.usage.output_tokens > 0) outputTokens = msg.usage.output_tokens
            } else if (evType === 'content_block_start') {
              const blk = parsed.content_block as { type?: string; thinking?: string; text?: string } | undefined
              if (blk?.type === 'thinking' && blk.thinking) {
                markFirstToken()
                accReasoning += blk.thinking
                syncTurn()
              } else if (blk?.type === 'text' && blk.text) {
                markFirstToken()
                accContent += blk.text
                syncTurn()
              }
            } else if (evType === 'content_block_delta') {
              const delta = parsed.delta as { type?: string; thinking?: string; text?: string } | undefined
              if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                markFirstToken()
                accReasoning += delta.thinking
                syncTurn()
              } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                markFirstToken()
                accContent += delta.text
                syncTurn()
              }
            } else if (evType === 'message_delta') {
              const usage = parsed.usage as { input_tokens?: number; output_tokens?: number } | undefined
              if (typeof usage?.input_tokens === 'number' && usage.input_tokens > 0) inputTokens = usage.input_tokens
              if (typeof usage?.output_tokens === 'number' && usage.output_tokens > 0) outputTokens = usage.output_tokens
            }
          }
        }

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '')
            if (line === '') {
              currentEvent = ''
              continue
            }
            if (line.startsWith(':')) continue
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              handleSseData(line.slice(5), currentEvent)
            }
          }
        }
        if (buffer.trim().startsWith('data:')) {
          handleSseData(buffer.trim().slice(5), currentEvent)
        }
      }

      const totalMs = Math.max(1, Math.round(performance.now() - startedAt))
      const finalOutTokens = outputTokens && outputTokens > 0 ? outputTokens : estimateTokens(accContent + accReasoning)
      const estimatedOutput = !(outputTokens && outputTokens > 0)
      const genWindowSec = Math.max(0.05, (totalMs - (ttftMs ?? 0)) / 1000)
      const tokPerSec = finalOutTokens > 0 ? finalOutTokens / (totalMs > (ttftMs ?? 0) + 80 ? genWindowSec : totalMs / 1000) : null

      syncTurn({
        streaming: false,
        telemetry: {
          ttftMs,
          totalMs,
          tokPerSec,
          inputTokens,
          outputTokens: finalOutTokens,
          estimatedOutput,
          protocol,
          model,
        },
      })
    } catch (e) {
      if (ctrl.signal.aborted) {
        const totalMs = Math.max(1, Math.round(performance.now() - startedAt))
        const est = estimateTokens(accContent + accReasoning)
        syncTurn({
          streaming: false,
          telemetry:
            accContent || accReasoning
              ? {
                  ttftMs,
                  totalMs,
                  tokPerSec: est > 0 ? est / Math.max(0.1, totalMs / 1000) : null,
                  inputTokens,
                  outputTokens: outputTokens ?? est,
                  estimatedOutput: outputTokens === null,
                  protocol,
                  model,
                }
              : undefined,
        })
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        syncTurn({ streaming: false, error: msg })
      }
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null
        setStreaming(false)
      }
    }
  }

  const retryLast = () => {
    if (streaming) return
    let lastUserIdx = -1
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]?.role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return
    const targetUser = turns[lastUserIdx]!
    const prior = turns.slice(0, lastUserIdx)
    void sendPrompt(targetUser.content, prior)
  }

  const copyReply = async (turn: ChatTurn) => {
    try {
      await navigator.clipboard.writeText(turn.content)
      setCopiedTurnId(turn.id)
      toast.success('回复已复制到剪贴板')
      setTimeout(() => setCopiedTurnId((id) => (id === turn.id ? null : id)), 1500)
    } catch {
      toast.error('复制失败')
    }
  }

  const endpointPath = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages'

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="对话试炼场"
        description={
          <span>
            双协议真实流式回路实测，直连同源接口 <code className="rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-xs break-words dark:bg-white/[0.07]">{endpointPath}</code>，实时观测思考过程与首字延迟。
          </span>
        }
        actions={
          turns.length > 0 ? (
            <Button variant="outline" size="sm" onClick={clearConversation} disabled={streaming}>
              <Trash2 strokeWidth={1.75} />
              清空会话
            </Button>
          ) : undefined
        }
      />

      <Card className="flex min-h-[calc(100dvh-13.5rem)] flex-col overflow-hidden">
        {/* 一体化工具栏（桌面紧凑单栏，390px 手机端自适应折行零溢出） */}
        <div className="border-b border-black/[0.06] bg-black/[0.015] px-3.5 py-3 sm:px-5 dark:border-white/[0.07] dark:bg-white/[0.02]">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <ModelPicker value={model} onChange={setModel} models={catalog.data?.models ?? []} />

            <Segmented<Protocol>
              value={protocol}
              onChange={setProtocol}
              options={[
                {
                  value: 'openai',
                  label: (
                    <span>
                      OpenAI <span className="hidden md:inline">(/v1/chat/completions)</span>
                    </span>
                  ),
                },
                {
                  value: 'anthropic',
                  label: (
                    <span>
                      Anthropic <span className="hidden md:inline">(/v1/messages)</span>
                    </span>
                  ),
                },
              ]}
            />

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                variant={advancedOpen ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
              >
                <SlidersHorizontal strokeWidth={1.75} />
                <span>参数</span>
              </Button>
              {turns.length > 0 && (
                <Button variant="ghost" size="icon-sm" onClick={clearConversation} title="清空对话" aria-label="清空对话">
                  <Trash2 strokeWidth={1.75} />
                </Button>
              )}
            </div>
          </div>

          {advancedOpen && (
            <div className="mt-3 grid min-w-0 gap-3 border-t border-black/[0.06] pt-3 sm:grid-cols-12 dark:border-white/[0.07]">
              <div className="min-w-0 sm:col-span-7">
                <Label htmlFor="pg-sys" hint="可选，作为 system 指令下发">
                  System Prompt
                </Label>
                <Input
                  id="pg-sys"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="例如：你是一位严谨的资深系统架构师，回答简洁清晰…"
                />
              </div>
              <div className="min-w-0 sm:col-span-3">
                <Label htmlFor="pg-temp" hint={`${temperature.toFixed(1)}`}>
                  Temperature
                </Label>
                <div className="flex h-9 items-center gap-2.5 px-1">
                  <input
                    id="pg-temp"
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.1}
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-[#0071E3] dark:accent-[#0A84FF]"
                  />
                  <span className="w-7 shrink-0 text-right font-sans text-xs font-medium tabular-nums">{temperature.toFixed(1)}</span>
                </div>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <Label htmlFor="pg-max">Max Tokens</Label>
                <Input
                  id="pg-max"
                  type="number"
                  min={64}
                  max={65536}
                  step={256}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Math.max(64, Number(e.target.value) || 4096))}
                  className="font-sans tabular-nums"
                />
              </div>
            </div>
          )}
        </div>

        {/* 消息流工作区 */}
        <div className="min-h-[320px] flex-1 overflow-y-auto px-3.5 py-5 sm:px-6">
          {turns.length === 0 ? (
            <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center py-10 text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-black/[0.06] bg-[#0071E3]/[0.08] text-[#0071E3] dark:border-white/[0.08] dark:bg-[#0A84FF]/[0.15] dark:text-[#409CFF]">
                <MessagesSquare className="size-5" strokeWidth={1.75} />
              </div>
              <h2 className="text-[16px] font-semibold tracking-[-0.01em]">开始流式对话实测</h2>
              <p className="text-muted-foreground mt-1.5 max-w-md text-[13px] leading-relaxed">
                当前选用 <span className="text-foreground font-medium">{model}</span>，通过{' '}
                <span className="text-foreground font-medium">{protocol === 'openai' ? 'OpenAI Chat' : 'Anthropic Messages'}</span> 协议验证路由选号、思考链路与流式吞吐。
              </p>

              <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
                {QUICK_PROMPTS.map((qp) => (
                  <button
                    key={qp.label}
                    type="button"
                    onClick={() => void sendPrompt(qp.text)}
                    className="group flex min-w-0 cursor-pointer flex-col items-start rounded-xl border border-black/[0.06] bg-black/[0.02] p-3 text-left transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-[#0071E3]/35 hover:bg-white active:scale-[0.98] dark:border-white/[0.07] dark:bg-white/[0.03] dark:hover:border-[#0A84FF]/40 dark:hover:bg-white/[0.05]"
                  >
                    <span className="text-[12.5px] font-medium group-hover:text-[#0071E3] dark:group-hover:text-[#409CFF]">{qp.label}</span>
                    <span className="text-muted-foreground mt-1 line-clamp-2 text-[11.5px] leading-snug">{qp.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {turns.map((turn, idx) => {
                if (turn.role === 'user') {
                  return (
                    <div key={turn.id} className="flex min-w-0 justify-end gap-2.5">
                      <div className="max-w-[88%] min-w-0 rounded-2xl rounded-tr-md bg-[#0071E3] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words text-white shadow-[0_1px_2px_rgba(0,113,227,0.2)] sm:max-w-[78%] dark:bg-[#0A84FF]">
                        {turn.content}
                      </div>
                      <div className="hidden size-7 shrink-0 items-center justify-center rounded-full border border-black/[0.07] bg-black/[0.04] sm:flex dark:border-white/[0.1] dark:bg-white/[0.06]">
                        <User className="text-muted-foreground size-3.5" strokeWidth={1.75} />
                      </div>
                    </div>
                  )
                }

                const isLast = idx === turns.length - 1
                const tel = turn.telemetry
                return (
                  <div key={turn.id} className="flex min-w-0 items-start gap-2.5 sm:gap-3">
                    <div className="mt-0.5 hidden size-7 shrink-0 items-center justify-center rounded-full border border-black/[0.07] bg-[#0071E3]/[0.09] text-[#0071E3] sm:flex dark:border-white/[0.1] dark:bg-[#0A84FF]/[0.16] dark:text-[#409CFF]">
                      <Bot className="size-3.5" strokeWidth={1.75} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <ReasoningPanel reasoning={turn.reasoning} streaming={turn.streaming} hasContent={Boolean(turn.content)} />

                      {turn.error ? (
                        <div className="rounded-xl border border-[#FF453A]/25 bg-[#FF453A]/[0.06] px-4 py-3 text-[13px] text-[#D70015] dark:border-[#FF453A]/30 dark:bg-[#FF453A]/[0.1] dark:text-[#FF6961]">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
                            <div className="min-w-0 flex-1 break-words">{turn.error}</div>
                          </div>
                        </div>
                      ) : turn.content ? (
                        <div className="min-w-0 rounded-2xl rounded-tl-md border border-black/[0.06] bg-[#FAFAFC] px-4 py-3 dark:border-white/[0.07] dark:bg-[#17171C]">
                          <SafeMarkdown text={turn.content} />
                          {turn.streaming && (
                            <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse rounded-xs bg-[#0071E3] align-middle dark:bg-[#0A84FF]" />
                          )}
                        </div>
                      ) : turn.streaming ? (
                        <div className="text-muted-foreground inline-flex items-center gap-2 rounded-xl border border-black/[0.06] bg-[#FAFAFC] px-3.5 py-2.5 text-xs dark:border-white/[0.07] dark:bg-[#17171C]">
                          <span className="size-2 animate-ping rounded-full bg-[#0071E3] dark:bg-[#0A84FF]" />
                          <span>正在等待上游首字响应…</span>
                        </div>
                      ) : null}

                      {/* 底部极客遥测微徽标（全 tabular-nums） */}
                      {!turn.streaming && (tel || turn.error) && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                          {tel && (
                            <>
                              {tel.ttftMs !== null && (
                                <span className="text-muted-foreground inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-black/[0.025] px-2 py-0.5 font-sans tabular-nums dark:border-white/[0.07] dark:bg-white/[0.04]">
                                  <Zap className="size-3 text-[#30D158]" strokeWidth={1.75} />
                                  TTFT {fmtInt(tel.ttftMs)} ms
                                </span>
                              )}
                              <span className="text-muted-foreground inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-black/[0.025] px-2 py-0.5 font-sans tabular-nums dark:border-white/[0.07] dark:bg-white/[0.04]">
                                <Clock className="size-3" strokeWidth={1.75} />
                                总耗时 {(tel.totalMs / 1000).toFixed(1)}s
                              </span>
                              {tel.tokPerSec !== null && (
                                <span className="text-muted-foreground inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-black/[0.025] px-2 py-0.5 font-sans tabular-nums dark:border-white/[0.07] dark:bg-white/[0.04]">
                                  <Gauge className="size-3 text-[#0071E3] dark:text-[#409CFF]" strokeWidth={1.75} />
                                  {tel.tokPerSec.toFixed(1)} tok/s
                                </span>
                              )}
                              {tel.outputTokens !== null && (
                                <span className="text-muted-foreground inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-black/[0.025] px-2 py-0.5 font-sans tabular-nums dark:border-white/[0.07] dark:bg-white/[0.04]">
                                  {tel.inputTokens !== null ? `输入 ${fmtInt(tel.inputTokens)} · ` : ''}
                                  输出 {tel.estimatedOutput ? '~' : ''}
                                  {fmtInt(tel.outputTokens)} tok
                                </span>
                              )}
                            </>
                          )}

                          <div className="ml-auto flex items-center gap-1">
                            {turn.content && (
                              <button
                                type="button"
                                onClick={() => void copyReply(turn)}
                                className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                              >
                                {copiedTurnId === turn.id ? (
                                  <Check className="size-3 text-[#30D158]" strokeWidth={2} />
                                ) : (
                                  <Copy className="size-3" strokeWidth={1.75} />
                                )}
                                <span>复制</span>
                              </button>
                            )}
                            {isLast && (
                              <button
                                type="button"
                                onClick={retryLast}
                                className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                              >
                                <RotateCcw className="size-3" strokeWidth={1.75} />
                                <span>重试</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              <div ref={scrollEndRef} />
            </div>
          )}
        </div>

        {/* 底部消息输入栏 */}
        <div className="border-t border-black/[0.06] bg-white/70 p-3 sm:px-5 sm:py-3.5 dark:border-white/[0.07] dark:bg-[#121215]/70">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void sendPrompt(input)
            }}
            className="mx-auto flex max-w-3xl min-w-0 items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void sendPrompt(input)
                }
              }}
              rows={2}
              placeholder="输入测试消息…（Enter 发送，Shift + Enter 换行）"
              aria-label="对话输入框"
              className="placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-ring/30 max-h-40 min-h-[44px] min-w-0 flex-1 resize-y rounded-xl border border-black/[0.09] bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed shadow-[0_1px_2px_rgba(0,0,0,0.02)] outline-none focus-visible:ring-[3px] dark:border-white/[0.1] dark:bg-[#18181C]"
            />
            {streaming ? (
              <Button type="button" variant="destructive" size="md" onClick={stopGeneration} className="h-[44px] px-4">
                <Square className="fill-current" strokeWidth={1.75} />
                <span>停止</span>
              </Button>
            ) : (
              <Button type="submit" variant="default" size="md" disabled={!input.trim()} className="h-[44px] px-4">
                <CornerDownLeft strokeWidth={1.75} />
                <span>发送</span>
              </Button>
            )}
          </form>
        </div>
      </Card>
    </div>
  )
}
