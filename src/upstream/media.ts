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

/** 媒体生成 / 检索用的模型（国际版 `/v3/config` 实测下发）。 */
export const INTl_IMAGE_MODEL = 'hy-image-3.5'
export const INTl_VIDEO_MODEL = 'kling-video-v3'

/**
 * 国际版能力是否可用（**按 realm 判断**，不按账号猜）。
 *
 * ⚠️ 只有 `global` 分片有这些权限（见文件头对照表）。
 * 调用方必须在**无权限时如实报错**，而不是静默回落成「对话」——
 * 那会让用户以为「联网检索返回的是模型编的」。
 */
export function mediaCapable(realm: string): boolean {
  return realm === 'global'
}

/** 生图结果（上游 `data` 原样透传，我们只补一层错误语义）。 */
export interface ImageGenResult {
  created: number
  images: Array<{ url: string; size?: string }>
  /** 本次消耗的积分（上游 `usage.credit`；未知时 undefined）。 */
  credit: number | undefined
}

/** 联网检索结果。 */
export interface SearchResult {
  query: string
  results: Array<{ title: string; url: string; snippet: string; date?: string }>
  total: number | undefined
}

/** 网页抓取结果。 */
export interface FetchResult {
  url: string
  title: string
  content: string
}

/**
 * 国际版「媒体 / 工具」族通用请求。
 *
 * ⚠️ **必须用 `INTl_WEB_BASE`**（`www.workbuddy.ai`），不是 chat 域 ——
 * 这是上面那个「404 Route Not Found」坑的根因。
 * ⚠️ 头族用 `desktopHeaders`（与 growth/report 同源）：实测这组头能过 APISIX，
 * 换 CLI 头也行，但既然已验证这条，就固定用它，不再猜。
 */
async function mediaCall<T = unknown>(
  ctx: { uid: string; accessToken: string },
  env: Env,
  path: string,
  body: unknown,
  timeoutMs = 120_000,
): Promise<{ data: T; raw: string; credit: number | undefined }> {
  // ⚠️ **必须用国际版固定域**，不能用 `resolveUpstream(env).web` ——
  // 后者的默认值是国内域 `www.workbuddy.cn`，在那里这些端点一律 401。
  const base = INTl_WEB_BASE
  const res = await callUpstream({
    method: 'POST',
    url: `${base}${path}`,
    headers: desktopHeaders({ uid: ctx.uid.replace(/^workbuddy:/, ''), accessToken: ctx.accessToken }),
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

/**
 * 联网检索（`POST /agenttool/v1/search`）。
 *
 * ⚠️ 实测**查询本身免费**（响应里没有 credit 字段）。但其结果会被注入对话上下文，
 * 那部分按 token 计费 —— 所以别在一个请求里检索几十次。
 */
export async function webSearch(
  ctx: { uid: string; accessToken: string },
  env: Env,
  input: { query: string; maxResults?: number },
): Promise<SearchResult> {
  const maxResults = typeof input.maxResults === 'number' && input.maxResults > 0
    ? Math.min(input.maxResults, 20)
    : 5
  const { data } = await mediaCall<{
    query?: unknown
    results?: unknown
    total_results?: unknown
  }>(ctx, env, '/agenttool/v1/search', { query: input.query, max_results: maxResults })

  const results: SearchResult['results'] = []
  if (Array.isArray(data.results)) {
    for (const item of data.results) {
      if (item === null || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      results.push({
        title: typeof rec.title === 'string' ? rec.title : '',
        url: typeof rec.url === 'string' ? rec.url : '',
        snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
        ...(typeof rec.date === 'string' ? { date: rec.date } : {}),
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
 *
 * ⚠️ 返回的 `content` 是**已经转成 markdown 的正文**（上游做完了提取与清洗）。
 * 不要自己再解析一遍 HTML。
 */
export async function webFetch(
  ctx: { uid: string; accessToken: string },
  env: Env,
  input: { url: string },
): Promise<FetchResult> {
  const { data } = await mediaCall<{
    url?: unknown
    title?: unknown
    content?: unknown
  }>(ctx, env, '/agenttool/v1/webfetch', { url: input.url })

  return {
    url: typeof data.url === 'string' ? data.url : input.url,
    title: typeof data.title === 'string' ? data.title : '',
    content: typeof data.content === 'string' ? data.content : '',
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
 * ## ⚠️ 这是**异步**的，不要同步等
 *
 * 实测（2026-11-05）：4 秒片子 **73 秒**出片。直接等会超过多数 HTTP 客户端超时，
 * 所以这里只提交、立刻返回 `task_id`，出片靠 {@link getVideoTask} 轮询。
 *
 * ## ⚠️ 风控会直接拒
 *
 * 实测同一天两次提交：
 * - 「一个人在北京天安门广场骑自行车」⇒ **62 秒后 `failed`**，
 *   `error.message = "Failure to pass the risk control system"`；
 * - 「一只橘色的小猫在阳光下的草地上奔跑」⇒ 73 秒 `completed`。
 *
 * ⇒ **含真实地点 + 人物的组合容易被拦**。调用方必须把 `failed` 的
 * `error.message` 原样交给用户 —— 笼统报「生成失败」会让人反复重试同一个 prompt。
 */
export async function submitVideo(
  ctx: { uid: string; accessToken: string },
  env: Env,
  input: {
    prompt: string
    model?: string
    seconds?: number
    aspectRatio?: string
    /**
     * 图生视频的**首帧**（可选）。
     *
     * ⚠️ 必须是**公网可访问的 URL** 或 **`data:` URL** —— 上游要能直接取到它，
     * 不接受裸 base64。我们**不会**替你下载或转存图片：
     * 那会让网关变成图片托管，且失败时用户不知道是图的问题还是网络的问题。
     */
    image?: string
    /** 尾帧（可选，同样要 URL / data URL）。 */
    lastImage?: string
  },
): Promise<VideoSubmitResult> {
  const model = (input.model ?? '').trim() || INTl_VIDEO_MODEL
  const seconds = typeof input.seconds === 'number' && input.seconds > 0
    ? Math.min(Math.max(Math.round(input.seconds), 1), 15) // 实测支持 4–15
    : 5
  const aspect = (input.aspectRatio ?? '').trim() || '16:9'

  const { data } = await mediaCall<{ id?: unknown; task_id?: unknown; status?: unknown }>(
    ctx, env, '/v2/videos/generations',
    {
      model,
      prompt: input.prompt,
      seconds,
      aspect_ratio: aspect,
      wait: false,
      ...(input.image === undefined || input.image === '' ? {} : { image: input.image }),
      ...(input.lastImage === undefined || input.lastImage === '' ? {} : { last_image: input.lastImage }),
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
