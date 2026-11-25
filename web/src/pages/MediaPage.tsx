import {
  AlertTriangle,
  Box,
  Check,
  Copy,
  Download,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Loader2,
  Mic,
  Search,
  Sparkles,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Switch, Textarea } from '@/components/ui/input'
import { Empty, Segmented } from '@/components/ui/misc'
import {
  checkThreeDTask,
  checkVideoTask,
  fileToDataUrl,
  mediaProxyUrl,
  useEditImage,
  useGenerateImage,
  useSubmitThreeD,
  useSubmitVideo,
  useSynthesizeSpeech,
  useTranscribeAudio,
  useWebFetch,
  useWebSearch,
  type SpeechSynthesisOutput,
  type ThreeDTask,
  type VideoTask,
} from '@/lib/queries'
import { toast } from 'sonner'

type Tab = 'image' | 'video' | 'audio' | '3d' | 'search' | 'fetch'

const SIZES = ['1024x1024', '1024x768', '768x1024'] as const
const ASPECTS = ['16:9', '9:16', '1:1'] as const
const SECONDS = [4, 5, 8, 10] as const
const THREE_D_MODELS = [
  { value: '3.1', label: '混元 3D 3.1' },
  { value: '3.0', label: '混元 3D 3.0' },
] as const
const THREE_D_FORMATS = ['GLB', 'OBJ', 'FBX', 'STL', 'USDZ'] as const

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
        description="生成图片、生成视频、语音合成与转写、生成混元 3D 模型、联网搜索、抓取网页正文。"
        actions={
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            className="h-auto max-w-full flex-wrap gap-0.5 sm:h-9 sm:flex-nowrap [&_button]:px-2.5 sm:[&_button]:px-3"
            options={[
              { value: 'image', label: '生图' },
              { value: 'video', label: '视频' },
              { value: 'audio', label: '语音' },
              { value: '3d', label: '3D 生成' },
              { value: 'search', label: '联网检索' },
              { value: 'fetch', label: '抓网页' },
            ]}
          />
        }
      />

      <div className="border-primary/25 bg-primary/[0.05] mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px] leading-relaxed">
        <AlertTriangle className="text-primary mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
        <div className="min-w-0 space-y-1">
          <span>
            生图与视频<b>只有国际版账号</b>可用（国内账号实测返回 401，是腾讯网关层直接拒的）。
            没有国际版账号时请先到「供应商与账号」登录一个，否则会提示
            <code className="bg-black/[0.06] dark:bg-white/[0.08] mx-1 rounded px-1 py-0.5 font-mono text-[11.5px]">unsupported_realm</code>。
          </span>
          <span className="text-muted-foreground block text-xs">
            语音（TTS / ASR）、混元 3D 生成、联网检索与抓网页同时支持国内版与国际版账号自动选号与容灾。
          </span>
        </div>
      </div>

      {tab === 'image' && <ImageTab />}
      {tab === 'video' && <VideoTab />}
      {tab === 'audio' && <AudioTab />}
      {tab === '3d' && <ThreeDTab />}
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
  maxBytes = 8 * 1024 * 1024,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  hint: string
  maxBytes?: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)

  const pick = async (file: File | undefined) => {
    if (file === undefined) return
    if (file.size > maxBytes) {
      const mb = Math.round(maxBytes / (1024 * 1024))
      toast.error('图片太大', { description: `请选 ${mb}MB 以内的图片` })
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
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
              <span>共 {data.data.length} 张</span>
              {data.usage?.credit !== undefined && <span>消耗 {data.usage.credit} 积分</span>}
              <span className="text-warning inline-flex items-center gap-1">
                <AlertTriangle className="size-3.5 shrink-0" strokeWidth={1.75} />
                直链约 24 小时后失效，需要请立即下载
              </span>
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
    let r: VideoTask
    try {
      r = await submit.mutateAsync({
        prompt: prompt.trim(),
        seconds,
        aspect_ratio: aspect,
        ...(model === '' ? {} : { model }),
        ...(source === '' ? {} : { image: source }),
      })
    } catch {
      // 错误提示已由 useAction.onError 弹出 Toast，此处捕获避免触发浏览器 unhandledrejection
      return
    }
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
        <div className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            成功出片约 <b className="tabular-nums">29 积分</b>；涉政 / 真实领导人 / 敏感事件等题材会被上游风控拒绝（会明确报原因），<b>失败不扣积分</b>。普通题材（动物、静物、风景）不受影响。
          </span>
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

function ThreeDTab() {
  const submit = useSubmitThreeD()
  const [mode, setMode] = useState<'text' | 'image'>('text')
  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState('')
  const [model, setModel] = useState<string>('3.1')
  const [format, setFormat] = useState<string>('GLB')
  const [enablePbr, setEnablePbr] = useState(true)
  const [task, setTask] = useState<ThreeDTask | null>(null)
  const [polling, setPolling] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const isDoneStatus = (s: string) => s === 'DONE' || s === 'FAIL'

  const poll = (jobId: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setPolling(true)
    const tick = async () => {
      try {
        const t = await checkThreeDTask(jobId)
        setTask(t)
        if (isDoneStatus(t.status)) {
          setPolling(false)
          if (t.status === 'DONE') toast.success('3D 模型生成完成')
          else toast.error('3D 生成失败', { description: t.error?.message ?? '上游未给原因' })
          return
        }
      } catch {
        // 单次轮询抖动不终止，继续等待下一轮
      }
      timer.current = window.setTimeout(() => void tick(), 6000)
    }
    void tick()
  }

  const canSubmit = mode === 'text' ? prompt.trim() !== '' : source !== ''

  const run = async () => {
    if (!canSubmit) return
    if (timer.current !== null) window.clearTimeout(timer.current)
    setTask(null)
    const payload =
      mode === 'text'
        ? {
            prompt: prompt.trim(),
            model,
            result_format: format,
            enable_pbr: enablePbr,
          }
        : {
            image_base64: source,
            model,
            result_format: format,
            enable_pbr: enablePbr,
          }
    let submitted: ThreeDTask
    try {
      submitted = await submit.mutateAsync(payload)
    } catch {
      // 错误提示已由 useAction.onError 弹出 Toast，此处捕获避免触发浏览器 unhandledrejection
      return
    }
    setTask(submitted)
    const jobId = submitted.job_id || submitted.id
    if (isDoneStatus(submitted.status) || !jobId) {
      setPolling(false)
      if (submitted.status === 'DONE') toast.success('3D 模型生成完成')
      else if (submitted.status === 'FAIL') toast.error('3D 生成失败', { description: submitted.error?.message ?? '上游未给原因' })
      return
    }
    toast.success('3D 任务已提交', { description: '通常 1–3 分钟完成建模与贴图' })
    poll(jobId)
  }

  const statusTone = (s: string) =>
    s === 'DONE' ? 'success' : s === 'FAIL' ? 'danger' : 'warning'

  const files =
    task?.result_files && task.result_files.length > 0
      ? task.result_files.filter((f) => typeof f.Url === 'string' && f.Url !== '')
      : task?.result_url
        ? [{ Type: format, Url: task.result_url }]
        : []

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Box className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'text' | 'image')}
            options={[
              { value: 'text', label: '文生 3D' },
              { value: 'image', label: '图生 3D' },
            ]}
          />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground text-xs">PBR 材质</span>
            <Switch label="PBR 材质贴图" checked={enablePbr} onCheckedChange={setEnablePbr} />
          </div>
        </div>

        {mode === 'text' ? (
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="例如：一把带有金属铆钉与木质纹理的复古蒸汽朋克单手剑，精细PBR材质"
            className="resize-none text-[13.5px]"
          />
        ) : (
          <div className="max-w-sm">
            <ImagePicker
              value={source}
              onChange={setSource}
              maxBytes={6 * 1024 * 1024}
              label="主体参考图（必填，≤6MB）"
              hint="建议选择背景干净、主体完整的单物体图片，本地读取为 base64 直传"
            />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">格式</span>
          <Segmented
            value={format}
            onChange={setFormat}
            options={THREE_D_FORMATS.map((f) => ({ value: f, label: f }))}
          />
          <span className="text-muted-foreground ml-1 text-xs">版本</span>
          <Segmented
            value={model}
            onChange={setModel}
            options={THREE_D_MODELS.map((m) => ({ value: m.value, label: m.label }))}
          />
          <div className="ml-auto flex items-center gap-2">
            {polling && <Badge tone="warning">建模中，约 1–3 分钟</Badge>}
            <Button onClick={() => void run()} disabled={submit.isPending || polling || !canSubmit}>
              {submit.isPending ? <Loader2 className="animate-spin" /> : <Box strokeWidth={1.75} />}
              生成 3D 模型
            </Button>
          </div>
        </div>
        <div className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            混元 3D Pro 自动签发临时云凭证并绑定原提交账号轮询（需 OAuth 登录账号，静态 <code className="font-mono">ck_</code> 密钥不支持签发）。
          </span>
        </div>
      </div>

      <div className="p-5">
        {!task && !polling && (
          <Empty icon={<Box strokeWidth={1.75} />} title="还没有 3D 生成记录">
            <span className="block">支持导出 GLB、OBJ、FBX、STL、USDZ 五种网格格式，提交后自动轮询进度。</span>
          </Empty>
        )}
        {task && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 tabular-nums">
              <Badge tone={statusTone(task.status)}>{task.status}</Badge>
              {task.model && <span className="text-muted-foreground text-xs">模型 {task.model}</span>}
              {task.usage?.credit !== undefined && (
                <span className="text-muted-foreground text-xs">消耗 {task.usage.credit} 积分</span>
              )}
              <code
                className="text-muted-foreground ml-auto max-w-[220px] truncate font-mono text-[11px]"
                title={task.job_id || task.id}
              >
                {task.job_id || task.id}
              </code>
            </div>

            {task.status === 'FAIL' && (
              <div className="border-destructive/30 bg-destructive/5 rounded-lg border px-4 py-3 text-[13px] break-words">
                <div className="mb-1 font-medium">3D 生成失败</div>
                <div className="text-muted-foreground">{task.error?.message ?? '上游未返回详细原因'}</div>
              </div>
            )}

            {task.status === 'DONE' && files.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {files.map((file, idx) => {
                  const ext = (file.Type || format || 'glb').toLowerCase()
                  const fileUrl = file.Url ?? ''
                  return (
                    <div key={`${fileUrl}-${idx}`} className="min-w-0 rounded-xl border p-3.5">
                      {file.PreviewImageUrl && (
                        <div className="bg-muted/30 mb-3 overflow-hidden rounded-lg">
                          <img
                            src={mediaProxyUrl(file.PreviewImageUrl)}
                            alt={`3D 预览 ${idx + 1}`}
                            className="aspect-video w-full object-contain"
                            loading="lazy"
                          />
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Box className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
                          <span className="text-[13px] font-medium uppercase">{ext} 模型文件</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <MediaActions url={fileUrl} filename={`hunyuan3d-${Date.now()}-${idx + 1}.${ext}`} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {task.status === 'DONE' && (
              <div className="text-warning flex items-center gap-1.5 text-xs">
                <AlertTriangle className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span>3D 产物为腾讯云 COS 签名直链（约 24 小时有效），请及时下载保存</span>
              </div>
            )}

            {polling && (
              <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
                <Loader2 className="size-4 animate-spin" /> 正在构建三维网格与材质贴图，页面会自动刷新状态…
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

const TTS_DEFAULT_VOICE_ID = 'f191_female_cn_tts2.5_flash'
const ASR_MAX_FILE_BYTES = 3 * 1024 * 1024

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function AudioTab() {
  const tts = useSynthesizeSpeech()
  const asr = useTranscribeAudio()
  const [mode, setMode] = useState<'tts' | 'asr'>('tts')

  // TTS 状态
  const [ttsText, setTtsText] = useState('')
  const [voiceMode, setVoiceMode] = useState<'default' | 'custom'>('default')
  const [customVoice, setCustomVoice] = useState('')
  const [ttsFormat, setTtsFormat] = useState<'wav' | 'pcm'>('wav')
  const [speechOut, setSpeechOut] = useState<(SpeechSynthesisOutput & { url: string }) | null>(null)

  // ASR 状态
  const [asrFile, setAsrFile] = useState<File | null>(null)
  const [asrFormat, setAsrFormat] = useState<'json' | 'text'>('json')
  const [asrText, setAsrText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (speechOut?.url) URL.revokeObjectURL(speechOut.url)
    }
  }, [speechOut])

  const effectiveVoice =
    voiceMode === 'custom' && customVoice.trim() !== '' ? customVoice.trim() : TTS_DEFAULT_VOICE_ID

  const runTts = async () => {
    const trimmed = ttsText.trim()
    if (trimmed === '') return
    let out: SpeechSynthesisOutput
    try {
      out = await tts.mutateAsync({
        input: trimmed,
        voice: effectiveVoice,
        response_format: ttsFormat,
      })
    } catch {
      return
    }
    const nextUrl = URL.createObjectURL(out.blob)
    setSpeechOut({ ...out, url: nextUrl })
    toast.success('语音合成完成')
  }

  const downloadSpeech = () => {
    if (!speechOut) return
    const a = document.createElement('a')
    a.href = speechOut.url
    a.download = `speech-${Date.now()}.${speechOut.format}`
    a.click()
    toast.success('已开始下载音频')
  }

  const pickAudioFile = (file: File | undefined) => {
    if (!file) return
    if (file.size > ASR_MAX_FILE_BYTES) {
      toast.error('音频文件过大', { description: '上游硬性限制单文件不超过 3 MB，请裁剪或压缩后重试。' })
      return
    }
    if (file.size === 0) {
      toast.error('音频文件为空')
      return
    }
    setAsrFile(file)
    setAsrText(null)
  }

  const runAsr = async () => {
    if (!asrFile) return
    let res: { text: string }
    try {
      res = await asr.mutateAsync({ file: asrFile, responseFormat: asrFormat })
    } catch {
      return
    }
    setAsrText(res.text)
    toast.success('语音转写完成')
  }

  const copyTranscript = async () => {
    if (!asrText) return
    try {
      await navigator.clipboard.writeText(asrText)
      setCopied(true)
      toast.success('已复制识别结果')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('复制失败，请手动选中复制')
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {mode === 'tts' ? (
            <Volume2 className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
          ) : (
            <Mic className="text-muted-foreground size-4 shrink-0" strokeWidth={1.75} />
          )}
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'tts' | 'asr')}
            options={[
              { value: 'tts', label: '文字转语音（TTS）' },
              { value: 'asr', label: '语音转文字（ASR）' },
            ]}
          />
        </div>

        {mode === 'tts' ? (
          <div className="space-y-3">
            <Textarea
              value={ttsText}
              onChange={(e) => setTtsText(e.target.value)}
              rows={3}
              placeholder="输入要合成语音的文字，例如：你好，欢迎体验混元语音合成服务。"
              className="resize-none text-[13.5px]"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">音色</span>
              <Segmented
                value={voiceMode}
                onChange={(v) => setVoiceMode(v as 'default' | 'custom')}
                options={[
                  { value: 'default', label: '标准女声（默认）' },
                  { value: 'custom', label: '自定义 ID' },
                ]}
              />
              <span className="text-muted-foreground ml-1 text-xs">格式</span>
              <Segmented
                value={ttsFormat}
                onChange={(v) => setTtsFormat(v as 'wav' | 'pcm')}
                options={[
                  { value: 'wav', label: 'WAV' },
                  { value: 'pcm', label: 'PCM' },
                ]}
              />
              <div className="ml-auto flex items-center gap-2">
                {tts.isPending && <Badge tone="warning">合成中…</Badge>}
                <Button onClick={() => void runTts()} disabled={tts.isPending || ttsText.trim() === ''}>
                  {tts.isPending ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Volume2 strokeWidth={1.75} />}
                  生成语音
                </Button>
              </div>
            </div>
            {voiceMode === 'custom' && (
              <div className="max-w-md">
                <Input
                  value={customVoice}
                  onChange={(e) => setCustomVoice(e.target.value)}
                  placeholder={`输入上游支持的音色 ID（留空回退 ${TTS_DEFAULT_VOICE_ID}）`}
                  className="h-8 font-mono text-[12.5px]"
                />
              </div>
            )}
            <div className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 break-words">
                输出采样率 <span className="tabular-nums">24,000 Hz</span> · 单声道 · <span className="tabular-nums">16-bit</span>；在线试听建议选 WAV（裸 PCM 无容器头，仅供底层音频管线使用）。
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-dashed p-3.5">
              {asrFile === null ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="hover:bg-accent/40 flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md py-4 text-center transition-colors"
                >
                  <Upload className="text-muted-foreground size-4" strokeWidth={1.75} />
                  <span className="text-[13px] font-medium">选择本地音频文件上传识别</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    支持 WAV / MP3 / M4A / WebM / OGG 等带容器格式，单文件上限 3 MB
                  </span>
                </button>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium" title={asrFile.name}>
                      {asrFile.name}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                      {fmtBytes(asrFile.size)} · {asrFile.type || 'audio/*'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                      更换文件
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="移除音频文件"
                      onClick={() => {
                        setAsrFile(null)
                        setAsrText(null)
                      }}
                    >
                      <X strokeWidth={1.75} />
                    </Button>
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac"
                className="hidden"
                onChange={(e) => {
                  pickAudioFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">返回格式</span>
              <Segmented
                value={asrFormat}
                onChange={(v) => setAsrFormat(v as 'json' | 'text')}
                options={[
                  { value: 'json', label: 'JSON' },
                  { value: 'text', label: '纯文本（text）' },
                ]}
              />
              <div className="ml-auto flex items-center gap-2">
                {asr.isPending && <Badge tone="warning">识别中…</Badge>}
                <Button onClick={() => void runAsr()} disabled={asr.isPending || asrFile === null}>
                  {asr.isPending ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : <Mic strokeWidth={1.75} />}
                  开始识别
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-5">
        {mode === 'tts' ? (
          <>
            {tts.isError && (
              <Empty icon={<AlertTriangle strokeWidth={1.75} />} title="语音合成失败">
                <span className="block font-mono text-[11.5px] break-all">{tts.error.message}</span>
              </Empty>
            )}
            {!tts.isPending && !tts.isError && !speechOut && (
              <Empty icon={<Volume2 strokeWidth={1.75} />} title="还没有合成记录">
                <span className="block">输入文本后点击「生成语音」，支持在线试听与一键下载。</span>
              </Empty>
            )}
            {speechOut && (
              <div className="space-y-3">
                {speechOut.format === 'wav' ? (
                  <audio controls src={speechOut.url} className="w-full" />
                ) : (
                  <div className="bg-muted/40 rounded-lg border px-4 py-3 text-xs leading-relaxed">
                    已生成裸 PCM 音频流（浏览器原生播放器需 WAV 容器头才能直接试听，请点击下方按钮下载使用，或切换为 WAV 格式在线试听）。
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                    <span>格式 {speechOut.format.toUpperCase()}</span>
                    <span>大小 {fmtBytes(speechOut.byteLength)}</span>
                    <span className="max-w-[220px] truncate font-mono" title={effectiveVoice}>
                      音色 {effectiveVoice}
                    </span>
                  </div>
                  <Button size="sm" variant="outline" onClick={downloadSpeech}>
                    <Download strokeWidth={1.75} /> 下载 {speechOut.format.toUpperCase()}
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {asr.isError && (
              <Empty icon={<AlertTriangle strokeWidth={1.75} />} title="语音识别失败">
                <span className="block font-mono text-[11.5px] break-all">{asr.error.message}</span>
              </Empty>
            )}
            {!asr.isPending && !asr.isError && asrText === null && (
              <Empty icon={<Mic strokeWidth={1.75} />} title="还没有识别记录">
                <span className="block">上传 3 MB 以内的音频文件并点击「开始识别」。</span>
              </Empty>
            )}
            {asrText !== null && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    识别完成 · 共 {asrText.length} 个字符
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void copyTranscript()} disabled={asrText === ''}>
                    {copied ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
                    {copied ? '已复制' : '复制结果'}
                  </Button>
                </div>
                <pre className="bg-muted/40 max-h-[50vh] overflow-auto rounded-lg p-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                  {asrText || '（未识别出有效文字）'}
                </pre>
              </div>
            )}
          </>
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
