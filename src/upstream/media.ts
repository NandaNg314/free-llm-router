/**
 * 国际版（workbuddy.ai）的**媒体生成**与**联网检索**能力。
 *
 * ## 🔴 为什么只走「国际版」
 *
 * 2026-11-05 用池内真实账号实测，两套 realm 的权限**完全不同**：
 *
 * | 能力 | 国内（buddy / www.workbuddy.cn） | 国际（workbuddy / www.workbuddy.ai） |
 * |---|---|---|
 * | `/agenttool/v1/search` | **401**（APISIX 网关层直接拒） | ✅ 200 真实结果 |
 * | `/agenttool/v1/webfetch` | **401** | ✅ 200 markdown 正文 |
 * | `/v2/images/generations` | **401** | ✅ 200 出图（实测 9s、credit 0.03） |
 * | `/v2/chat/busy` | ✅ 200 | **404**（国际版没有这条路由） |
 *
 * ⚠️ **这是我在这次实现里踩过的坑，写下来防重犯**：
 * 我第一次用**国内账号**探测，拿到 401 就断定「上游不支持」—— 结论是**错的**。
 * 同一组请求头，换国际账号就是 200。
 * ⇒ 教训：**权限类问题必须每个 realm 各测一次**，不能拿一个号的结果代表全部。
 *
 * ⚠️ 还有第二个坑：域名。`agenttool` 与 `images` 挂在 **`www.workbuddy.ai`**
 * 而不是 `copilot.tencent.com`（chat 域）。用错域会得到 `404 Route Not Found`。
 *
 * ⚠️ **第三个坑（本文件第一版就踩了）**：`resolveUpstream(env).web` 的默认值是
 * **国内域名 `www.workbuddy.cn`**（见 `env.ts` 的 `DEFAULT_UPSTREAM`）。
 * 直接用它会对国内域发请求 ⇒ 401。国际版必须写死 `www.workbuddy.ai`，
 * 只有需要调试时才允许环境变量覆盖。
 */
import type { Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { desktopHeaders } from './headers.js'

/** 国际版 web 域（**固定**，不跟随 `UPSTREAM_WEB_BASE`）。 */
export const INTl_WEB_BASE = 'https://www.workbuddy.ai'

/** 国内版 agenttool 域（`copilot.tencent.com`，挂载搜索与抓取）。 */
export const CN_AGENT_TOOL_BASE = 'https://copilot.tencent.com'

/** 媒体生成 / 检索用的模型（国际版 `/v3/config` 实测下发）。 */
export const INTl_IMAGE_MODEL = 'hy-image-3.5'
export const INTl_VIDEO_MODEL = 'kling-video-v3'

/**
 * 媒体能力是否可用（生图、视频等目前只有国际版支持）。
 */
export function mediaCapable(realm: string): boolean {
  return realm === 'global'
}

/**
 * 搜索与抓取能力是否可用（国内版与国际版均支持，国内站需补齐官方 IDE 桌面头）。
 */
export function webToolCapable(realm: string): boolean {
  return realm === 'global' || realm === 'cn'
}

/** 生图结果（上游 `data` 原样透传，我们只补一层错误语义）。 */
export interface ImageGenResult {
  created: number
  images: Array<{ url: string; size?: string }>
  /** 本次消耗的积分（上游 `usage.credit`；未知时 undefined）。 */
  credit: number | undefined
}

/** 联网检索结果（满足 DSH Search API 契约）。 */
export interface SearchResult {
  query: string
  results: Array<{ title: string; url: string; snippet: string; date: null }>
  total: number | undefined
}

/** 网页抓取结果（满足 DSH Fetch API 契约）。 */
export interface FetchResult {
  url: string
  title: string
  content: string
}

function agentToolTraceparent(): string {
  const buf = new Uint8Array(24)
  crypto.getRandomValues(buf)
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
  return `00-${hex.slice(0, 32)}-${hex.slice(32)}-01`
}

function buildCnAgentToolHeaders(uid: string, accessToken: string, enterpriseId?: string): Record<string, string> {
  const cleanUid = uid.replace(/^buddy:|^workbuddy:/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.8.3',
    'X-Private-Data': 'true',
    'X-Codebuddy-Request': '1',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-Product': 'SaaS',
    'X-User-Id': cleanUid,
  }
  if (enterpriseId) {
    headers['X-Tenant-Id'] = enterpriseId
    headers['X-Enterprise-Id'] = enterpriseId
  }
  headers['traceparent'] = agentToolTraceparent()
  return headers
}

/**
 * 通用「媒体 / 工具」族请求：支持国际版与国内版（国内版自动补齐桌面端 IDE 头）。
 */
async function mediaCall<T = unknown>(
  ctx: { uid: string; accessToken: string; realm?: string; enterpriseId?: string },
  env: Env,
  path: string,
  body: unknown,
  timeoutMs = 120_000,
): Promise<{ data: T; raw: string; credit: number | undefined }> {
  const isCn = ctx.realm === 'cn'
  const base = INTl_WEB_BASE
  const endpointBase = isCn ? CN_AGENT_TOOL_BASE : base
  const headers = isCn
    ? buildCnAgentToolHeaders(ctx.uid, ctx.accessToken, ctx.enterpriseId)
    : desktopHeaders({ uid: ctx.uid.replace(/^workbuddy:/, ''), accessToken: ctx.accessToken })
  const res = await callUpstream({
    method: 'POST',
    url: `${endpointBase}${path}`,
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `${path} 失败（${c.kind}）：${c.msg || res.raw.slice(0, 200)}`,
      detail: res.raw.slice(0, 600),
    })
  }

  const envelope = res.envelope as { code?: unknown; msg?: unknown; data?: unknown } | undefined
  const code = envelope?.code
  if (code !== undefined && code !== 0) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: res.httpStatus,
      code: typeof code === 'number' ? code : undefined,
      message: `${path} 业务码 ${String(code)}：${typeof envelope?.msg === 'string' ? envelope.msg : ''}`,
      detail: res.raw.slice(0, 600),
    })
  }

  /**
   * 🔴 **两种响应形态，必须都认**（2026-11-05 实测踩到）。
   *
   * - **媒体类**（`/v2/images/*`）回**标准信封**：
   *   `{"code":0,"msg":"OK","data":{"created":...,"data":[{"url":...}],"usage":{...}}}`
   * - **agenttool 类**（`/agenttool/v1/*`）回**裸对象**（没有 code 信封）：
   *   `{"query":"…","type":"text2text","results":[…]}`
   *
   * ⚠️ 我第一版只读 `envelope.data` ⇒ agenttool 的 `data` 是 `undefined`
   * ⇒ 工具返回「没有找到结果」，**看起来像上游没有结果，其实是解析路径错**。
   * 这种「静默空结果」比报错更难查 —— 所以这里显式兜住裸对象。
   *
   * ⚠️ 判据是「有 envelope 且 envelope.data 是对象」才用 envelope.data；
   * 否则把整个响应体当数据（但**排除**那种顶层带 code 的错误形态，
   * 因为那已经被上面拦掉了）。
   */
  const envelopeData = envelope?.data
  const data = (envelopeData !== undefined && envelopeData !== null && typeof envelopeData === 'object'
    ? envelopeData
    : (() => {
        try {
          const parsed = JSON.parse(res.raw) as unknown
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        } catch {
          return {}
        }
      })()) as T

  // ⚠️ `credit` 在 `data.usage.credit`（媒体）或顶层 `usage.credit` 两处都见过，
  // 读不到就是 undefined —— **不要**当成 0（0 表示「免费」，语义完全不同）。
  const d = data as Record<string, unknown>
  const usage = (d.usage ?? {}) as Record<string, unknown>
  const credit = typeof usage.credit === 'number' ? usage.credit : undefined
  return { data, raw: res.raw, credit }
}

/**
 * 文生图（`POST /v2/images/generations`）。
 *
 * ⚠️ **必须带 `model`**：不带时上游回
 * `400 {"code":14401,"msg":"Image model [] route config not found"}` ——
 * 那个 `[]` 会被误读成「没有可用的图像模型」，其实只是没传。
 */
export async function generateImage(
  ctx: { uid: string; accessToken: string },
  env: Env,
  input: { prompt: string; model?: string; size?: string; n?: number },
): Promise<ImageGenResult> {
  const model = (input.model ?? '').trim() || INTl_IMAGE_MODEL
  const size = (input.size ?? '').trim() || '1024x1024'
  const n = typeof input.n === 'number' && Number.isInteger(input.n) && input.n > 0
    ? Math.min(input.n, 4) // ⚠️ 上限 4：一次多张会成倍消耗积分，且上游可能超时
    : 1

  const { data, credit } = await mediaCall<{
    created?: unknown
    data?: unknown
    usage?: { credit?: unknown }
  }>(ctx, env, '/v2/images/generations', { model, prompt: input.prompt, size, n })

  const images: Array<{ url: string; size?: string }> = []
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      if (url === '') continue
      images.push({ url, ...(typeof rec.size === 'string' ? { size: rec.size } : {}) })
    }
  }

  const usageCredit = data.usage !== null && typeof data.usage === 'object'
    ? (data.usage as Record<string, unknown>).credit
    : undefined

  return {
    created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
    images,
    credit: typeof usageCredit === 'number' ? usageCredit : credit,
  }
}

/** 改图（`POST /v2/images/edits`）。`image` 传公网 URL 或 `data:` URL。 */
export async function editImage(
  ctx: { uid: string; accessToken: string },
  env: Env,
  input: {
    prompt: string
    /**
     * 输入图。支持两种：
     * - 字符串：单张（公网 URL 或 `data:` URL）
     * - 数组：多张（上游 `image` 字段是 **data URL 数组**）
     *
     * ⚠️ 我们**不下载、不转存**图片 —— 上游要能直接取到它。
     */
    image: string | string[]
    model?: string
    size?: string
  },
): Promise<ImageGenResult> {
  const model = (input.model ?? '').trim() || INTl_IMAGE_MODEL
  const { data, credit } = await mediaCall<{
    created?: unknown
    data?: unknown
    usage?: { credit?: unknown }
  }>(ctx, env, '/v2/images/edits', {
    model,
    prompt: input.prompt,
    // ⚠️ 单张时上游也接受字符串，但多张必须是数组 —— 统一传数组最省心
    image: Array.isArray(input.image) ? input.image : [input.image],
    ...(input.size === undefined ? {} : { size: input.size }),
  })

  const images: Array<{ url: string; size?: string }> = []
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      if (url !== '') images.push({ url, ...(typeof rec.size === 'string' ? { size: rec.size } : {}) })
    }
  }
  const usageCredit = data.usage !== null && typeof data.usage === 'object'
    ? (data.usage as Record<string, unknown>).credit
    : undefined
  return {
    created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
    images,
    credit: typeof usageCredit === 'number' ? usageCredit : credit,
  }
}

function siteFallbackUrl(site: unknown): string {
  if (typeof site !== 'string') return ''
  const s = site.trim()
  if (!s || s.includes(' ') || !s.includes('.')) return ''
  return `https://${s.replace(/^\.+|\.+$/g, '')}`
}

/** 官方默认的网页抓取提取 Prompt。 */
export const DEFAULT_WEB_FETCH_PROMPT =
  'Extract the main content of this page as clean Markdown. Keep headings, lists, code blocks and key facts. Remove navigation, ads and boilerplate.'

/**
 * 联网检索（`POST /agenttool/v1/search`）。
 * 支持国内版（带 IDE 桌面头）与国际版，结果适配 DSH Search API 形状。
 */
export async function webSearch(
  ctx: { uid: string; accessToken: string; realm?: string; enterpriseId?: string },
  env: Env,
  input: { query: string; maxResults?: number; count?: number },
): Promise<SearchResult> {
  const countRaw = input.count ?? input.maxResults
  const maxResults = typeof countRaw === 'number' && countRaw > 0
    ? Math.min(countRaw, 20)
    : 5
  const { data } = await mediaCall<{
    query?: unknown
    results?: unknown
    total_results?: unknown
  }>(ctx, env, '/agenttool/v1/search', {
    query: input.query,
    type: 'text2text',
    max_results: maxResults,
  }, 20_000)

  const results: SearchResult['results'] = []
  if (Array.isArray(data.results)) {
    for (const item of data.results) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      let url = typeof rec.url === 'string' ? rec.url.trim() : ''
      if (url === '') {
        url = siteFallbackUrl(rec.site)
      }
      if (url === '') continue // DSH 解码器要求非空 URL
      results.push({
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
        date: null,
      })
    }
  }
  return {
    query: typeof data.query === 'string' ? data.query : input.query,
    results,
    total: typeof data.total_results === 'number' ? data.total_results : undefined,
  }
}

/**
 * 抓网页正文（`POST /agenttool/v1/webfetch`）。
 * 支持国内版与国际版，上游返回 markdown 正文，适配 DSH Fetch API 形状。
 */
export async function webFetch(
  ctx: { uid: string; accessToken: string; realm?: string; enterpriseId?: string },
  env: Env,
  input: { url: string; prompt?: string },
): Promise<FetchResult> {
  const { data } = await mediaCall<{
    url?: unknown
    title?: unknown
    content?: unknown
  }>(ctx, env, '/agenttool/v1/webfetch', {
    url: input.url,
    format: 'markdown',
    prompt: input.prompt || DEFAULT_WEB_FETCH_PROMPT,
    timeout: 30,
    max_length: 100000,
  }, 30_000)

  const content = typeof data.content === 'string' ? data.content : ''
  if (!content) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: '上游未返回可用的页面正文',
      detail: '上游 webfetch 响应缺少有效 content',
    })
  }

  return {
    url: typeof data.url === 'string' ? data.url : input.url,
    title: typeof data.title === 'string' ? data.title : '',
    content,
  }
}

// ─────────────────────── 视频（可灵） ───────────────────────

/** 视频任务状态（上游原样，不做归并 —— `in_progress` / `queued` 都有意义）。 */
export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | string

export interface VideoSubmitResult {
  taskId: string
  status: VideoStatus
}

export interface VideoTaskResult {
  taskId: string
  status: VideoStatus
  /** 出片后才有（签名直链，约 12 小时有效）。 */
  urls: string[]
  /** 实际时长（秒；`completed` 后上游才给）。 */
  durationSeconds: number | undefined
  /** 消耗积分（`completed` 后才有）。 */
  credit: number | undefined
  /** 失败原因（上游原话，例如风控拦截）。 */
  error: string | undefined
}

/**
 * 提交视频生成（`POST /v2/videos/generations`）。
 *
 * ## 🔴 真实请求结构（2026-11-05 从社区协议文档核对，修正了本文件此前的三处错误）
 *
 * ```json
 * {
 *   "prompt": "...",
 *   "model": "kling-video-v3",
 *   "seconds": 4,
 *   "negative_prompt": "...",
 *   "watermark": true,
 *   "image_url": "...",        // ← 图生视频的首帧（**不是 image**）
 *   "last_image_url": "...",   // ← 尾帧（**不是 last_image**）
 *   "extra_parameters": {      // ← 分辨率/音频/比例嵌在这层里（**不是顶层**）
 *     "resolution": "768P",
 *     "enable_audio": true,
 *     "aspect_ratio": "16:9"   // ⚠️ 仅文生视频有效
 *   }
 * }
 * ```
 *
 * ⚠️⚠️ **这是三处同型错误，都出在「凭直觉拼字段名」上**：
 * 1. `image` → 真实是 **`image_url`**；`last_image` → **`last_image_url`**
 *    （用户实测反馈「加了图片也没出现图的内容」—— 就是因为字段名错，上游直接忽略）；
 * 2. `aspect_ratio` 原放在**顶层**，真实位置是 `extra_parameters` 内；
 * 3. `extra_parameters` 这层完全没发（分辨率、音频开关都在里面）。
 *
 * ⚠️ 教训：**上游字段名不能猜**。为名一致的 `images/edits` 用 `image`，
 *    而 `videos/generations` 用 `image_url` —— 同一家厂商、同一条通道，命名却不同。
 *
 * ## ⚠️ 这是**异步**的，不要同步等
 *
 * 实测（2026-11-05）：4 秒片子 **73 秒**出片。直接等会超过多数 HTTP 客户端超时，
 * 所以这里只提交、立刻返回 `task_id`，出片靠 {@link getVideoTask} 轮询。
 *
 * ## ⚠️ 内容合规
 *
 * 实测同一天两次提交：
 * - 「一个人在北京天安门广场骑自行车」⇒ **62 秒后 `failed`**，
 *   `error.message = "Failure to pass the risk control system"`；
 * - 「一只橘色的小猫在阳光下的草地上奔跑」⇒ 73 秒 `completed`。
 *
 * ⇒ 拦的是**内容合规**（涉政 / 真实领导人 / 敏感事件），不是「画面里有人」。
 *    换普通题材（动物、静物、风景）即可正常出片。
 *    调用方必须把 `failed` 的 `error.message` 原样交给用户 ——
 *    笼统报「生成失败」会让人反复重试同一个 prompt。
 */
export async function submitVideo(
  ctx: { uid: string; accessToken: string },
  env: Env,
  input: {
    prompt: string
    model?: string
    seconds?: number
    aspectRatio?: string
    /** 分辨率（如 `768P`），进 `extra_parameters`。 */
    resolution?: string
    /** 是否生成音轨（上游默认 true）。 */
    enableAudio?: boolean
    /**
     * 图生视频的**首帧**（可选）。
     *
     * ⚠️ 上游字段名是 **`image_url`**（不是 `image`）—— 写错会被静默忽略，
     *    表现为「加了图但生成结果和纯文本一样」。
     * ⚠️ 必须是**公网可访问的 URL** 或 **`data:` URL** —— 上游要能直接取到它，
     * 不接受裸 base64。我们**不会**替你下载或转存图片。
     */
    image?: string
    /** 尾帧（可选，字段名 **`last_image_url`**）。 */
    lastImage?: string
  },
): Promise<VideoSubmitResult> {
  const model = (input.model ?? '').trim() || INTl_VIDEO_MODEL
  const seconds = typeof input.seconds === 'number' && input.seconds > 0
    ? Math.min(Math.max(Math.round(input.seconds), 1), 15) // 实测支持 4–15
    : 5
  const aspect = (input.aspectRatio ?? '').trim() || '16:9'
  const hasImage = input.image !== undefined && input.image !== ''

  /**
   * `extra_parameters` 里放什么。
   *
   * ⚠️ `aspect_ratio` **仅文生视频有效**（社区协议文档明确）——
   *    图生视频时比例跟着输入图走，传了也会被忽略。
   *    这里图生图时不传，避免制造「我设了 9:16 却没生效」的误解。
   */
  const extra: Record<string, unknown> = {}
  if (!hasImage) extra.aspect_ratio = aspect
  if (input.resolution !== undefined && input.resolution !== '') extra.resolution = input.resolution
  if (input.enableAudio !== undefined) extra.enable_audio = input.enableAudio

  const { data } = await mediaCall<{ id?: unknown; task_id?: unknown; status?: unknown }>(
    ctx, env, '/v2/videos/generations',
    {
      model,
      prompt: input.prompt,
      seconds,
      watermark: true,
      // ⚠️ 字段名是 image_url / last_image_url，**不是 image / last_image**
      ...(hasImage ? { image_url: input.image } : {}),
      ...(input.lastImage === undefined || input.lastImage === '' ? {} : { last_image_url: input.lastImage }),
      ...(Object.keys(extra).length === 0 ? {} : { extra_parameters: extra }),
    },
  )

  // ⚠️ 提交响应里任务 id 在 `id`（不是 `task_id`）；两个都认，防止上游改字段
  const taskId = typeof data.id === 'string' ? data.id
    : typeof data.task_id === 'string' ? data.task_id : ''
  if (taskId === '') throw new UpstreamError({
    kind: 'unknown', httpStatus: 200,
    message: '提交成功但响应里没有任务 id（字段既不是 id 也不是 task_id）',
    detail: JSON.stringify(data).slice(0, 300),
  })

  return { taskId, status: typeof data.status === 'string' ? data.status : 'queued' }
}

/**
 * 查询视频任务（**`POST /v2/videos/tasks`**，body `{task_id}`）。
 *
 * ⚠️⚠️ **不是 GET `/v2/videos/generations/{id}`** —— 那条路径返回
 * `404 page not found`。我第一版就是按 REST 习惯写的 GET，结果永远查不到状态，
 * 看起来像「视频一直卡在排队」。
 */
export async function getVideoTask(
  ctx: { uid: string; accessToken: string },
  env: Env,
  taskId: string,
): Promise<VideoTaskResult> {
  const { data } = await mediaCall<{
    id?: unknown
    task_id?: unknown
    status?: unknown
    data?: unknown
    url?: unknown
    video_url?: unknown
    usage?: unknown
    error?: unknown
  }>(ctx, env, '/v2/videos/tasks', { task_id: taskId })

  const status = typeof data.status === 'string' ? data.status : ''

  // 出片地址：`data[]` 数组为主，也见过顶层 `url` / `video_url`
  const urls: string[] = []
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const u = typeof rec.url === 'string' ? rec.url : ''
      if (u !== '') urls.push(u)
    }
  }
  if (urls.length === 0) {
    const flat = typeof data.video_url === 'string' ? data.video_url : typeof data.url === 'string' ? data.url : ''
    if (flat !== '') urls.push(flat)
  }

  const usage = data.usage !== null && typeof data.usage === 'object' ? (data.usage as Record<string, unknown>) : {}
  const err = data.error !== null && typeof data.error === 'object'
    ? (data.error as Record<string, unknown>)
    : undefined

  return {
    taskId: typeof data.id === 'string' ? data.id : taskId,
    status,
    urls,
    durationSeconds: typeof usage.output_video_duration === 'number' ? usage.output_video_duration : undefined,
    credit: typeof usage.credit === 'number' ? usage.credit : undefined,
    error: err !== undefined && typeof err.message === 'string' ? err.message : undefined,
  }
}
