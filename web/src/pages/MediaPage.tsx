import {
  AlertTriangle,
  Download,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Loader2,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Empty, Segmented } from '@/components/ui/misc'
import {
  checkVideoTask,
  fileToDataUrl,
  mediaProxyUrl,
  useEditImage,
  useGenerateImage,
  useSubmitVideo,
  useWebFetch,
  useWebSearch,
  type VideoTask,
} from '@/lib/queries'
import { toast } from 'sonner'

type Tab = 'image' | 'video' | 'search' | 'fetch'

const SIZES = ['1024x1024', '1024x768', '768x1024'] as const
const ASPECTS = ['16:9', '9:16', '1:1'] as const
const SECONDS = [4, 5, 8, 10] as const

/**
 * 生图可选模型。
 *
 * ⚠️ 只列**实测可用**的。`/v1/models` 里虽然还有 `hunyuan-image-alpha`，
 * 但上游会回 `route config not found`（2026-11-09 实测），列进 UI 只会让人点了报错。
 * 等上游真接上再补。
 */
const IMAGE_MODELS = [
  { value: '', label: '默认（hy-image-3.5）' },
  { value: 'hy-image-3.5', label: '混元 hy-image-3.5' },
] as const

/**
 * 视频可选模型（两个都实测可用）。
 *
 * 空值 = 不传 model，由上游按自己的默认选。
 */
const VIDEO_MODELS = [
  { value: '', label: '默认' },
  { value: 'kling-video-v3', label: '可灵 v3' },
  { value: 'minimax-video-h3', label: '海螺 H3' },
] as const

export function MediaPage() {
  const [tab, setTab] = useState<Tab>('image')

  return (
    <>
      <PageHeader
        title="媒体与检索"
        description="生成图片、生成视频、联网搜索、抓取网页正文。这些能力由 WorkBuddy 国际版账号提供。"
        actions={
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { value: 'image', label: '生图' },
              { value: 'video', label: '视频' },
              { value: 'search', label: '联网检索' },
              { value: 'fetch', label: '抓网页' },
            ]}
          />
        }
      />

      <div className="border-primary/25 bg-primary/[0.05] mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px] leading-relaxed">
        <AlertTriangle className="text-primary mt-0.5 size-4 shrink-0" />
        <span>
          这四项能力<b>只有国际版账号</b>可用（国内账号实测返回 401，是腾讯网关层直接拒的）。
          没有国际版账号时请先到「供应商与账号」登录一个，否则会提示
          <code className="bg-black/[0.06] dark:bg-white/[0.08] mx-1 rounded px-1 py-0.5 font-mono text-[11.5px]">unsupported_realm</code>。
        </span>
      </div>

      {tab === 'image' && <ImageTab />}
      {tab === 'video' && <VideoTab />}
      {tab === 'search' && <SearchTab />}
      {tab === 'fetch' && <FetchTab />}
    </>
  )
}

/**
 * 下载/打开媒体直链。
 *
 * ## ⚠️ 为什么不直接 `<a download href={url}>`
 *
 * 上游是**跨域**的 COS 直链，浏览器的 `download` 属性对跨域资源**不生效**
 * （点开只会跳转到新标签页播放/显示）。而 `fetch(url).then(blob)` 又会被 COS 的
 * CORS 拦掉。
 *
 * ⇒ 走网关的同源代理 `/admin/media/proxy`，浏览器就当成同源资源，能正常下载。
 */
/**
 * 图片预览（带失败兜底）。
 *
 * ## ⚠️ 为什么不用 `<img src={直链}>`
 *
 * 上游是跨域 COS，浏览器请求会带 `Referer`，被防盗链拦成 403 ——
 * 表现就是**破图标 + 一片空白**（用户实测反馈）。
 * 走 `/admin/media/proxy` 同源代理后浏览器才当成普通资源。
 *
 * ⚠️ 代理也可能失败（签名过期 / 网络）。这时不能留个破图标让人猜，
 *    要明确说「预览失败，可以点下载或打开」。
 */
function ImagePreview({ url, index }: { url: string; index: number }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div className="bg-muted/30 flex aspect-square w-full flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertTriangle className="text-muted-foreground size-6" />
        <span className="text-muted-foreground text-xs leading-relaxed">
          预览加载失败
          <br />
          （链接可能已过期）
        </span>
        <div className="flex gap-1.5">
          <MediaActions url={url} filename={`generated-${Date.now()}-${index + 1}.png`} />
        </div>
      </div>
    )
  }

  return (
    <img
      src={mediaProxyUrl(url)}
      alt={`生成结果 ${index + 1}`}
      className="aspect-square w-full object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function MediaActions({ url, filename }: { url: string; filename: string }) {
  const [busy, setBusy] = useState(false)

  const download = async () => {
    setBusy(true)
    try {
      const res = await fetch(mediaProxyUrl(url), {
        headers: { authorization: `Bearer ${localStorage.getItem('wb_api_key') ?? ''}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      a.click()
      // ⚠️ 延迟释放：立刻 revoke 会让部分浏览器下载中断（尤其大文件/视频）
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
      toast.success('已开始下载')
    } catch (e) {
      toast.error('下载失败', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="bg-white/90 text-black hover:bg-white" onClick={() => window.open(url, '_blank', 'noopener')}>
        <ExternalLink /> 打开
      </Button>
      <Button size="sm" variant="outline" className="bg-white/90 text-black hover:bg-white" onClick={download} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Download />} 下载
      </Button>
    </>
  )
}

/** 选本地图片 → data URL（上游要求 data URL 或公网 URL，不接受裸 base64）。 */
function ImagePicker({
  value,
  onChange,
  label,
  hint,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  hint: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)

  const pick = async (file: File | undefined) => {
    if (file === undefined) return
    // ⚠️ 限制 8MB：data URL 会膨胀 ~33%，太大既慢又可能超上游上限
    if (file.size > 8 * 1024 * 1024) {
      toast.error('图片太大', { description: '请选 8MB 以内的图片' })
      return
    }
    setReading(true)
    try {
      onChange(await fileToDataUrl(file))
    } catch (e) {
      toast.error('读取失败', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setReading(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        {value !== '' && (
          <button className="text-muted-foreground ml-auto cursor-pointer hover:text-foreground" onClick={() => onChange('')} aria-label="移除图片">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {value === '' ? (
        <button
          className="hover:bg-accent/40 flex w-full cursor-pointer items-center justify-center gap-2 rounded-md py-3 text-xs transition-colors"
          onClick={() => ref.current?.click()}
          disabled={reading}
        >
          {reading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {reading ? '读取中…' : '选择图片'}
        </button>
      ) : (
        <img src={value} alt={label} className="h-20 w-full rounded-md object-cover" />
      )}
      <div className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">{hint}</div>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

function ImageTab() {
  const gen = useGenerateImage()
  const edit = useEditImage()
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<string>(SIZES[0])
  const [model, setModel] = useState<string>('')
  const [source, setSource] = useState('')
  const [mode, setMode] = useState<'text' | 'img2img'>('text')

  const busy = gen.isPending || edit.isPending
  const run = () => {
    if (prompt.trim() === '') return
    // model 为空串时不传，由上游用自己的默认模型
    const m = model === '' ? {} : { model }
    if (mode === 'img2img') {
      if (source === '') {
        toast.error('请先选择一张参考图')
        return
      }
      edit.mutate({ prompt: prompt.trim(), image: [source], size, ...m })
    } else {
      gen.mutate({ prompt: prompt.trim(), size, ...m })
    }
  }

  const data = mode === 'img2img' ? edit.data : gen.data
  const error = mode === 'img2img' ? edit.error : gen.error

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <ImageIcon className="text-muted-foreground size-4" />
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'text' | 'img2img')}
            options={[
              { value: 'text', label: '文生图' },
              { value: 'img2img', label: '图生图（改图）' },
            ]}
          />
        </div>
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder={mode === 'text' ? '例如：一只橘猫坐在窗台上，水彩风格' : '描述要改什么，例如：把背景换成星空'}
              className="resize-none text-[13.5px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  run()
                }
              }}
            />
          </div>
          {mode === 'img2img' && (
            <div className="w-40 shrink-0">
              <ImagePicker
                value={source}
                onChange={setSource}
                label="参考图"
                hint="本地图片会转成 data URL 直传，不经本机以外的地方"
              />
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">尺寸</span>
          <Segmented value={size} onChange={setSize} options={SIZES.map((s) => ({ value: s, label: s }))} />
          <span className="text-muted-foreground ml-2 text-xs">模型</span>
          <Segmented value={model} onChange={setModel} options={IMAGE_MODELS.map((m) => ({ value: m.value, label: m.label }))} />
          <div className="ml-auto flex items-center gap-2">
            {busy && <Badge tone="warning">生成中，约 10–15 秒</Badge>}
            <Button onClick={run} disabled={busy || prompt.trim() === ''}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {mode === 'text' ? '生成图片' : '生成改图'}
            </Button>
          </div>
        </div>
      </div>

      <div className="p-5">
        {error && (
          <Empty icon={<AlertTriangle />} title="生成失败">
            <span className="block font-mono text-[11.5px] break-all">{error.message}</span>
          </Empty>
        )}
        {!busy && !error && !data && (
          <Empty icon={<Sparkles />} title="还没有生成记录">
            <span className="block">输入提示词后按 Enter 或点按钮。图生图需要先选一张参考图。</span>
          </Empty>
        )}
        {data && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.data.map((img, i) => (
                <div key={img.url} className="group ring-foreground/10 relative overflow-hidden rounded-xl ring-1">
                  {/* ⚠️ 必须走同源代理：直链是跨域 COS，浏览器带 Referer 会被防盗链拦掉，
                      表现就是「破图标 + 一堆空白」（实测）。代理之后浏览器当成同源资源。 */}
                  <ImagePreview url={img.url} index={i} />
                  <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <MediaActions url={img.url} filename={`generated-${Date.now()}-${i + 1}.png`} />
                  </div>
                </div>
              ))}
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span>共 {data.data.length} 张</span>
              {data.usage?.credit !== undefined && <span>消耗 {data.usage.credit} 积分</span>}
              <span className="text-warning">⚠️ 直链约 24 小时后失效，需要请立即下载</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function VideoTab() {
  const submit = useSubmitVideo()
  const [prompt, setPrompt] = useState('')
  const [seconds, setSeconds] = useState<number>(4)
  const [aspect, setAspect] = useState<string>(ASPECTS[0])
  const [model, setModel] = useState<string>('')
  const [source, setSource] = useState('')
  const [task, setTask] = useState<VideoTask | null>(null)
  const [polling, setPolling] = useState(false)
  const timer = useRef<number | null>(null)

  // 卸载时清掉轮询定时器（切走页面不该继续烧请求）
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const poll = (id: string) => {
    setPolling(true)
    const tick = async () => {
      try {
        const t = await checkVideoTask(id)
        setTask(t)
        if (t.status === 'completed' || t.status === 'failed') {
          setPolling(false)
          if (t.status === 'completed') toast.success('视频生成完成')
          else toast.error('生成失败', { description: t.error?.message ?? '上游未给原因' })
          return
        }
      } catch {
        // 单次查询失败不终止轮询（网络抖动很常见）
      }
      timer.current = window.setTimeout(() => void tick(), 8000)
    }
    void tick()
  }

  const run = async () => {
    if (prompt.trim() === '') return
    setTask(null)
    const r = await submit.mutateAsync({
      prompt: prompt.trim(),
      seconds,
      aspect_ratio: aspect,
      ...(model === '' ? {} : { model }),
      ...(source === '' ? {} : { image: source }),
    })
    toast.success('已提交，正在生成', { description: '通常 60–120 秒' })
    poll(r.id)
  }

  const statusTone = (s: string) =>
    s === 'completed' ? 'success' : s === 'failed' ? 'danger' : 'warning'

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-4">
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="例如：一只橘色小猫在草地上奔跑，镜头平稳跟随，画面明亮温暖"
              className="resize-none text-[13.5px]"
            />
          </div>
          <div className="w-40 shrink-0">
            <ImagePicker
              value={source}
              onChange={setSource}
              label="首帧（可选）"
              hint="选图即「图生视频」；不选就是文生视频"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">时长</span>
          <Segmented value={String(seconds)} onChange={(v) => setSeconds(Number(v))} options={SECONDS.map((s) => ({ value: String(s), label: `${s}s` }))} />
          <span className="text-muted-foreground ml-1 text-xs">比例</span>
          <Segmented value={aspect} onChange={setAspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
          <span className="text-muted-foreground ml-1 text-xs">模型</span>
          <Segmented value={model} onChange={setModel} options={VIDEO_MODELS.map((m) => ({ value: m.value, label: m.label }))} />
          <div className="ml-auto flex items-center gap-2">
            {polling && <Badge tone="warning">生成中，约 1–2 分钟</Badge>}
            <Button onClick={() => void run()} disabled={submit.isPending || polling || prompt.trim() === ''}>
              {submit.isPending ? <Loader2 className="animate-spin" /> : <Film />}
              生成视频
            </Button>
          </div>
        </div>
        <div className="text-muted-foreground mt-2 text-xs">
          ⚠️ 成功出片约 <b>29 积分</b>；涉政 / 真实领导人 / 敏感事件等题材会被上游风控拒绝（会明确报原因），<b>失败不扣积分</b>。普通题材（动物、静物、风景）不受影响。
        </div>
      </div>

      <div className="p-5">
        {!task && !polling && (
          <Empty icon={<Film />} title="还没有生成记录">
            <span className="block">提交后会在这里显示进度，通常 60–120 秒出片。</span>
          </Empty>
        )}
        {task && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(task.status)}>{task.status}</Badge>
              {task.seconds !== undefined && <span className="text-muted-foreground text-xs">{task.seconds} 秒</span>}
              {task.usage?.credit !== undefined && <span className="text-muted-foreground text-xs">消耗 {task.usage.credit} 积分</span>}
              <code className="text-muted-foreground ml-auto font-mono text-[11px]">{task.id}</code>
            </div>

            {task.status === 'failed' && (
              <div className="border-destructive/30 bg-destructive/5 rounded-lg border px-4 py-3 text-[13px]">
                <div className="mb-1 font-medium">生成失败</div>
                <div className="text-muted-foreground">{task.error?.message ?? '上游未给原因'}</div>
              </div>
            )}

            {task.status === 'completed' && (task.data ?? []).map((v) => (
              <div key={v.url} className="space-y-2">
                {/* 同图片：跨域直链在 <video> 里同样加载不出（只有进度条没有画面） */}
                <video
                  src={mediaProxyUrl(v.url)}
                  controls
                  playsInline
                  className="w-full rounded-xl ring-1 ring-black/10"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <MediaActions url={v.url} filename={`video-${Date.now()}.mp4`} />
                  <span className="text-warning text-xs">直链约 12 小时后失效，需要请立即下载</span>
                </div>
              </div>
            ))}

            {polling && (
              <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
                <Loader2 className="size-4 animate-spin" /> 正在生成，页面会自动刷新状态…
              </div>
            )}
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
              <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="hover:bg-accent/50 block rounded-lg px-3 py-2.5 transition-colors">
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
            <pre className="bg-muted/40 max-h-[60vh] overflow-auto rounded-lg p-4 text-[12.5px] leading-relaxed whitespace-pre-wrap">
              {fetchPage.data.content}
            </pre>
          </div>
        )}
      </div>
    </Card>
  )
}
