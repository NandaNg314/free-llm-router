import {
  AlertTriangle,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Empty, Segmented } from '@/components/ui/misc'
import { useGenerateImage, useWebSearch, useWebFetch } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Tab = 'image' | 'search' | 'fetch'

const SIZES = ['1024x1024', '1024x768', '768x1024'] as const

/**
 * 媒体页：生图 / 联网检索 / 抓网页。
 *
 * ## ⚠️ 为什么这三件事放在一起
 *
 * 它们**共用同一条上游通道**（国际版 `www.workbuddy.ai` 的 agenttool 与 images），
 * 权限也完全一致（国内账号一律 401）。放在同一页，用户一次就能分清
 * 「我需要国际版账号」这件事，而不用在三个地方各踩一遍。
 */
export function MediaPage() {
  const [tab, setTab] = useState<Tab>('image')

  return (
    <>
      <PageHeader
        title="媒体与检索"
        description="生成图片、联网搜索、抓取网页正文。这三项能力由 WorkBuddy 国际版账号提供。"
        actions={
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { value: 'image', label: '生图' },
              { value: 'search', label: '联网检索' },
              { value: 'fetch', label: '抓网页' },
            ]}
          />
        }
      />

      {/* 统一提示：三个 tab 共用同一条权限边界，说一次胜过各说一遍 */}
      <div className="border-primary/25 bg-primary/[0.05] mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px] leading-relaxed">
        <AlertTriangle className="text-primary mt-0.5 size-4 shrink-0" />
        <span>
          这三项能力<b>只有国际版账号</b>可用（国内账号实测返回 401）。
          没有国际版账号时请先到「供应商与账号」登录一个，否则会提示
          <code className="bg-black/[0.06] dark:bg-white/[0.08] mx-1 rounded px-1 py-0.5 font-mono text-[11.5px]">unsupported_realm</code>。
        </span>
      </div>

      {tab === 'image' && <ImageTab />}
      {tab === 'search' && <SearchTab />}
      {tab === 'fetch' && <FetchTab />}
    </>
  )
}

function ImageTab() {
  const gen = useGenerateImage()
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<string>(SIZES[0])

  const run = () => {
    if (prompt.trim() === '') return
    gen.mutate({ prompt: prompt.trim(), size })
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <ImageIcon className="text-muted-foreground size-4" />
          <span className="text-[13px] font-medium">提示词</span>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="例如：一只橘猫坐在窗台上，水彩风格，柔和自然光"
          className="resize-none text-[13.5px]"
          onKeyDown={(e) => {
            // ⚠️ Enter 直接生成，Shift+Enter 换行 —— 与对话类界面一致的习惯
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              run()
            }
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">尺寸</span>
          <Segmented
            value={size}
            onChange={setSize}
            options={SIZES.map((s) => ({ value: s, label: s }))}
          />
          <div className="ml-auto flex items-center gap-2">
            {gen.isPending && <Badge tone="warning">生成中，约 10–15 秒</Badge>}
            <Button onClick={run} disabled={gen.isPending || prompt.trim() === ''}>
              {gen.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
              生成图片
            </Button>
          </div>
        </div>
      </div>

      <div className="p-5">
        {gen.isError && (
          <Empty icon={<AlertTriangle />} title="生成失败">
            <span className="block font-mono text-[11.5px] break-all">{gen.error.message}</span>
          </Empty>
        )}
        {!gen.isPending && !gen.isError && !gen.data && (
          <Empty icon={<Sparkles />} title="还没有生成记录">
            <span className="block">输入提示词后按 Enter 或点「生成图片」。</span>
          </Empty>
        )}
        {gen.data && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {gen.data.data.map((img) => (
                <div key={img.url} className="group ring-foreground/10 relative overflow-hidden rounded-xl ring-1">
                  <img src={img.url} alt={prompt} className="aspect-square w-full object-cover" loading="lazy" />
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button size="sm" variant="outline" className="bg-white/90 text-black hover:bg-white" onClick={() => window.open(img.url, '_blank', 'noopener')}>
                      <ExternalLink /> 打开
                    </Button>
                    <Button size="sm" variant="outline" className="bg-white/90 text-black hover:bg-white" onClick={() => window.open(img.url, '_blank', 'noopener')}>
                      <Download /> 下载
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span>共 {gen.data.data.length} 张</span>
              {gen.data.usage?.credit !== undefined && <span>消耗 {gen.data.usage.credit} 积分</span>}
              <span className="text-warning">⚠️ 图片是签名直链，约 24 小时后失效，需要请立即下载</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function SearchTab() {
  const search = useWebSearch()
  const [q, setQ] = useState('')

  const run = () => {
    if (q.trim() === '') return
    search.mutate({ query: q.trim() })
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b px-5 py-4">
        <Search className="text-muted-foreground size-4 shrink-0" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索实时信息，例如：今天的上证指数"
          className="h-9 text-[13.5px]"
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <Button onClick={run} disabled={search.isPending || q.trim() === ''}>
          {search.isPending ? <Loader2 className="animate-spin" /> : <Search />}
          搜索
        </Button>
      </div>

      <div className="p-5">
        {search.isError && (
          <Empty icon={<AlertTriangle />} title="搜索失败">
            <span className="block font-mono text-[11.5px] break-all">{search.error.message}</span>
          </Empty>
        )}
        {!search.isPending && !search.isError && !search.data && (
          <Empty icon={<Search />} title="还没有搜索">
            <span className="block">结果来自上游官方检索通道，不是模型编的。</span>
          </Empty>
        )}
        {search.data && (
          <div className="space-y-1">
            {search.data.results.length === 0 && <Empty icon={<Search />} title="没有结果" />}
            {search.data.results.map((r) => (
              <a
                key={r.url}
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="hover:bg-accent/50 block rounded-lg px-3 py-2.5 transition-colors"
              >
                <div className="text-[13.5px] font-medium">{r.title || r.url}</div>
                <div className="text-primary mt-0.5 truncate text-xs">{r.url}</div>
                <div className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-relaxed">{r.snippet}</div>
              </a>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

function FetchTab() {
  const fetchPage = useWebFetch()
  const [url, setUrl] = useState('')

  const run = () => {
    if (url.trim() === '') return
    fetchPage.mutate({ url: url.trim() })
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b px-5 py-4">
        <ExternalLink className="text-muted-foreground size-4 shrink-0" />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…（抓取正文并转成 Markdown）"
          className="h-9 text-[13.5px]"
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <Button onClick={run} disabled={fetchPage.isPending || url.trim() === ''}>
          {fetchPage.isPending ? <Loader2 className="animate-spin" /> : <Download />}
          抓取
        </Button>
      </div>

      <div className="p-5">
        {fetchPage.isError && (
          <Empty icon={<AlertTriangle />} title="抓取失败">
            <span className="block font-mono text-[11.5px] break-all">{fetchPage.error.message}</span>
          </Empty>
        )}
        {!fetchPage.isPending && !fetchPage.isError && !fetchPage.data && (
          <Empty icon={<ExternalLink />} title="还没有抓取">
            <span className="block">上游已经做完正文提取与清洗，这里拿到的是 Markdown。</span>
          </Empty>
        )}
        {fetchPage.data && (
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{fetchPage.data.title || fetchPage.data.url}</span>
              <Button size="icon-sm" variant="ghost" aria-label="在新窗口打开" onClick={() => window.open(fetchPage.data!.url, '_blank', 'noopener')}>
                <ExternalLink />
              </Button>
            </div>
            <pre className={cn('bg-muted/40 max-h-[60vh] overflow-auto rounded-lg p-4 text-[12.5px] leading-relaxed whitespace-pre-wrap')}>
              {fetchPage.data.content}
            </pre>
          </div>
        )}
      </div>
    </Card>
  )
}
