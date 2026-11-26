import {
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Trash2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge, type Tone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, Sheet } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Empty, Segmented, Skeleton } from '@/components/ui/misc'
import { Table, TD, TH, THead, TR } from '@/components/ui/table'
import { useClearLogs, useLogs, useProviders } from '@/lib/queries'
import { navigateToPlayground } from '@/lib/router'
import type { LogEntry } from '@/lib/types'
import { cn, fmtDateTime, fmtInt, fmtMs } from '@/lib/utils'

async function copyText(text: string, ok = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(ok)
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

type F = 'all' | 'api' | 'error' | 'task' | 'mcp'

function logTone(l: LogEntry): Tone {
  if (l.type === 'task') return l.error ? 'warning' : 'info'
  if (l.type === 'error' || (l.status ?? 200) >= 400 || !!l.error) return 'danger'
  return 'success'
}

function logBadgeLabel(l: LogEntry): string {
  if (l.type === 'task') return '任务'
  if (l.status !== undefined) return String(l.status)
  return l.type === 'error' ? '错误' : '请求'
}

function logStreamLabel(l: LogEntry): string {
  if (l.type === 'mcp') return 'MCP 工具调用'
  if (l.type === 'task') return '后台定时/手动任务'
  return l.stream ? 'SSE 流式响应' : '非流式 JSON'
}

export function LogsPage() {
  const [liveTail, setLiveTail] = useState(false)
  const logs = useLogs({ refetchInterval: liveTail ? 3_000 : false })
  const providers = useProviders()
  const clear = useClearLogs()
  const [f, setF] = useState<F>('all')
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [selected, setSelected] = useState<LogEntry | null>(null)

  const providerName = (id?: string) => {
    if (!id) return '—'
    return providers.data?.providers.find((p) => p.id === id)?.name ?? id
  }

  const rows = useMemo(() => {
    const kw = query.trim().toLowerCase()
    return (logs.data ?? []).filter((l) => {
      if (f === 'error') {
        if (!(l.type === 'error' || (l.status ?? 200) >= 400 || !!l.error)) return false
      } else if (f !== 'all' && l.type !== f) {
        return false
      }
      if (!kw) return true
      const hay = `${l.model ?? ''} ${l.uid ?? ''} ${l.provider ?? ''} ${l.status ?? ''} ${l.error ?? ''} ${l.type}`.toLowerCase()
      return hay.includes(kw)
    })
  }, [logs.data, f, query])

  return (
    <>
      <PageHeader
        title="日志"
        description="一体化请求可观测工作台：支持实时流追踪与点击行展开完整诊断明细。"
      />

      <Card className="min-w-0 overflow-hidden">
        {/* 一体化工作台顶栏：搜索 + 分段器 + Live Tail + 刷新/清空全数封装于 Card Header */}
        <div className="flex flex-col gap-2.5 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-64">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" strokeWidth={1.75} />
              <Input
                type="search"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="过滤模型 / UID / 状态码 / 错误…"
                aria-label="搜索过滤日志"
                className="h-8 pr-7 pl-8 text-[13px]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清空日志搜索词"
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded p-0.5"
                >
                  <X className="size-3.5" strokeWidth={1.75} />
                </button>
              )}
            </div>

            <Segmented<F>
              value={f}
              onChange={setF}
              className="max-w-full flex-wrap h-auto min-h-8 [&_button]:h-6 [&_button]:px-2.5 [&_button]:text-xs"
              options={[
                { value: 'all', label: '全部' },
                { value: 'api', label: '请求' },
                { value: 'mcp', label: 'MCP' },
                { value: 'error', label: '错误' },
                { value: 'task', label: '任务' },
              ]}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              role="switch"
              aria-checked={liveTail}
              aria-label="Live Tail 实时流自动轮询"
              onClick={() => setLiveTail((v) => !v)}
              title={liveTail ? '每 3 秒自动静默刷新最新日志，点击暂停以静态排查' : '开启 Live Tail 每 3 秒自动追踪最新请求流'}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-all active:scale-[0.98]',
                liveTail
                  ? 'border-[#30D158]/35 bg-[#30D158]/[0.08] text-[#1D8338] dark:border-[#30D158]/30 dark:bg-[#30D158]/[0.12] dark:text-[#30D158]'
                  : 'border-input bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="relative flex size-1.5 shrink-0">
                {liveTail && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#30D158] opacity-75" />}
                <span className={cn('relative inline-flex size-1.5 rounded-full', liveTail ? 'bg-[#30D158]' : 'bg-muted-foreground/50')} />
              </span>
              <span>Live Tail</span>
              {liveTail && <span className="tabular text-[11px] opacity-80">3s</span>}
            </button>

            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => logs.refetch()}
              aria-label="手动刷新日志"
              title="手动刷新"
              disabled={logs.isFetching && !liveTail}
            >
              <RefreshCw className={cn(logs.isFetching && !liveTail && 'animate-spin')} strokeWidth={1.75} />
            </Button>

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setConfirm(true)}
              aria-label="清空日志"
              title="清空全部日志"
              disabled={!logs.data?.length}
            >
              <Trash2 strokeWidth={1.75} />
            </Button>
          </div>
        </div>

        {logs.isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !rows.length ? (
          <Empty icon={<ScrollText strokeWidth={1.75} />} title={logs.data?.length ? '没有匹配的日志记录' : '没有日志'}>
            {logs.data?.length ? '尝试调整筛选类型或清空搜索关键词。' : '发起一次对话或执行任务后，请求流水将在此实时展示。'}
          </Empty>
        ) : (
          <Table containerClassName="max-h-[calc(100dvh-250px)] overflow-y-auto">
            <THead sticky className="border-t-0">
              <tr>
                <TH>时间</TH>
                <TH>状态</TH>
                <TH>模型</TH>
                <TH className="hidden md:table-cell">账号</TH>
                <TH className="hidden text-right sm:table-cell">Token</TH>
                <TH className="text-right">耗时</TH>
                <TH className="hidden lg:table-cell">说明</TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((l, i) => (
                <TR
                  key={`${l.id}-${i}`}
                  onClick={() => setSelected(l)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelected(l)
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`查看 ${l.model ?? l.type} 请求诊断详情`}
                  className="cursor-pointer focus-visible:bg-black/[0.04] focus-visible:outline-none dark:focus-visible:bg-white/[0.05]"
                >
                  <TD className="text-muted-foreground tabular font-sans text-xs whitespace-nowrap tabular-nums">
                    {fmtDateTime(l.time)}
                  </TD>
                  <TD className="whitespace-nowrap">
                    <Badge tone={logTone(l)} dot className="font-sans tabular-nums">
                      {logBadgeLabel(l)}
                    </Badge>
                  </TD>
                  <TD className="max-w-[160px] truncate font-mono text-[12.5px] whitespace-nowrap sm:max-w-[260px]" title={l.model}>
                    {l.model ?? '—'}
                  </TD>
                  <TD className="text-muted-foreground hidden max-w-[180px] truncate font-mono text-[12px] whitespace-nowrap md:table-cell" title={l.uid}>
                    {l.uid ?? '—'}
                  </TD>
                  <TD className="tabular text-muted-foreground hidden text-right font-sans text-xs whitespace-nowrap tabular-nums sm:table-cell">
                    {l.tokens ? fmtInt(l.tokens.total) : '—'}
                  </TD>
                  <TD className="tabular text-right font-sans text-xs whitespace-nowrap tabular-nums">
                    {fmtMs(l.durationMs ?? 0)}
                  </TD>
                  <TD className="text-muted-foreground hidden max-w-64 truncate text-xs lg:table-cell" title={l.error}>
                    {l.error ?? (l.type === 'mcp' ? '工具调用' : l.stream ? '流式' : '非流式')}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}

        {!!logs.data?.length && (
          <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2.5 text-xs">
            <span className="tabular font-sans tabular-nums">
              显示 {fmtInt(rows.length)} / {fmtInt(logs.data.length)} 条记录
            </span>
            <span>点击任意日志行可展开完整诊断抽屉</span>
          </div>
        )}
      </Card>

      {/* 右侧请求诊断抽屉（Sheet） */}
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="请求诊断详情"
        description={selected ? `${fmtDateTime(selected.time)} · ${selected.model ?? selected.type}` : ''}
      >
        {selected && (
          <div className="flex h-full min-w-0 flex-col">
            <div className="border-b px-6 pt-6 pb-4">
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <Badge tone={logTone(selected)} dot className="font-sans tabular-nums">
                  {logBadgeLabel(selected)}
                </Badge>
                <Badge tone="neutral">{logStreamLabel(selected)}</Badge>
                <span className="text-muted-foreground tabular font-sans text-xs tabular-nums">
                  {fmtDateTime(selected.time)}
                </span>
              </div>
              <div className="mt-2.5 min-w-0 font-mono text-sm font-semibold break-words">
                {selected.model ?? '系统任务 / 非模型调用'}
              </div>
              <div className="text-muted-foreground mt-1 truncate font-mono text-[11.5px]" title={selected.id}>
                日志 ID：{selected.id}
              </div>
            </div>

            <div className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {/* 核心遥测指标四宫格 */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <MetricBox
                  icon={<Clock className="size-3.5" strokeWidth={1.75} />}
                  label="总耗时"
                  value={fmtMs(selected.durationMs ?? 0)}
                />
                <MetricBox
                  icon={<Cpu className="size-3.5" strokeWidth={1.75} />}
                  label="输入 Token"
                  value={selected.tokens ? fmtInt(selected.tokens.input) : '—'}
                />
                <MetricBox
                  icon={<Cpu className="size-3.5" strokeWidth={1.75} />}
                  label="输出 Token"
                  value={selected.tokens ? fmtInt(selected.tokens.output) : '—'}
                />
                <MetricBox
                  icon={<Cpu className="size-3.5" strokeWidth={1.75} />}
                  label="合计 Token"
                  value={selected.tokens ? fmtInt(selected.tokens.total) : '—'}
                />
              </div>

              {/* 路由与账号溯源 */}
              <div className="divide-y rounded-xl border text-[13px]">
                <DetailRow label="时间戳" value={`${new Date(selected.time).toLocaleString('zh-CN', { hour12: false })} (${selected.time})`} tabular />
                <DetailRow label="请求分类" value={`${selected.type} · ${logStreamLabel(selected)}`} />
                <DetailRow
                  label="执行供应商"
                  value={selected.provider ? `${providerName(selected.provider)} (${selected.provider})` : '—'}
                />
                <DetailRow label="命中账号 UID" value={selected.uid ?? '—'} mono />
                <DetailRow label="请求模型 ID" value={selected.model ?? '—'} mono />
              </div>

              {/* 完整未截断错误原文或健康回执 */}
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">
                    {selected.error ? '上游错误与诊断原文（完整未截断）' : '执行状态诊断'}
                  </span>
                  {selected.error && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => copyText(selected.error!, '已复制错误信息')}
                    >
                      <Copy strokeWidth={1.75} /> 复制错误原文
                    </Button>
                  )}
                </div>
                {selected.error ? (
                  <pre className="border-danger/25 bg-danger/[0.05] text-foreground max-h-96 overflow-y-auto rounded-xl border p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                    {selected.error}
                  </pre>
                ) : (
                  <div className="flex items-center gap-2.5 rounded-xl border border-[#30D158]/25 bg-[#30D158]/[0.06] px-4 py-3 text-[13px]">
                    <CheckCircle2 className="size-4 shrink-0 text-[#30D158]" strokeWidth={1.75} />
                    <span>本次调用正常完成，未捕获上游异常或协议报错。</span>
                  </div>
                )}
              </div>
            </div>

            {/* 底部快捷动作栏（严格遵守单主按钮原则） */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-black/[0.02] px-6 py-3.5 dark:bg-white/[0.02]">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const text = selected.error
                    ? selected.error
                    : JSON.stringify(
                        {
                          id: selected.id,
                          time: new Date(selected.time).toISOString(),
                          type: selected.type,
                          status: selected.status,
                          model: selected.model,
                          provider: selected.provider,
                          uid: selected.uid,
                          durationMs: selected.durationMs,
                          tokens: selected.tokens,
                        },
                        null,
                        2,
                      )
                  void copyText(text, selected.error ? '已复制错误信息' : '已复制请求诊断摘要')
                }}
              >
                <Copy strokeWidth={1.75} /> {selected.error ? '复制错误信息' : '复制诊断摘要'}
              </Button>
              {selected.model && (
                <Button
                  size="sm"
                  onClick={() => {
                    const m = selected.model!
                    setSelected(null)
                    navigateToPlayground(m)
                  }}
                >
                  <MessageSquare strokeWidth={1.75} /> 在试炼场测试此模型
                </Button>
              )}
            </div>
          </div>
        )}
      </Sheet>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="清空全部日志？"
        description="请求与任务日志都会删除（国内版、国际版），用量统计不受影响。"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={clear.isPending} onClick={() => clear.mutate(undefined, { onSuccess: () => setConfirm(false) })}>
              清空
            </Button>
          </>
        }
      />
    </>
  )
}

function MetricBox({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-black/[0.015] px-3.5 py-2.5 dark:bg-white/[0.02]">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="tabular mt-1 truncate font-sans text-[15px] font-semibold tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  )
}

function DetailRow({ label, value, mono, tabular }: { label: string; value: string; mono?: boolean; tabular?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-muted-foreground shrink-0 text-xs flex items-center gap-1.5">
        <Server className="size-3 opacity-60" strokeWidth={1.75} />
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 text-xs break-all sm:text-right',
          mono && 'font-mono',
          tabular && 'tabular font-sans tabular-nums',
        )}
      >
        {value}
      </span>
    </div>
  )
}
