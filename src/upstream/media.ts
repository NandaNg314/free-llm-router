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
import { callUpstream, classify, isChallengePage, UpstreamError } from './client.js'
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
 * 检索查询的分词与相关性重排（Rerank / 语义去噪）。
 *
 * ## 要解决的问题（实测反馈）
 * 搜 `C2000` 时结果里混进了同名的「德州仪器 TI C2000 芯片」与
 * 「神州数码鲲鹏服务器」—— 上游全文检索只做字面匹配，**不理解语境**。
 *
 * ## 做法（轻量、无模型、可解释）
 * 1. **token 化**：中英文混排按「英文/数字串」「中文字符 bigram」双路切；
 * 2. **加权打分**：
 *    - 标题命中 `+3`、摘要命中 `+1`；
 *    - 全词组（原始 query）整串命中 `+6`（强信号）；
 *    - 稀有 token（IDF 高）权重更大 —— 用「该 token 在结果集中出现的次数」近似 IDF；
 * 3. **去噪**：明显不相关的（得分 <= 0）排到最后；
 * 4. **稳定**：得分相同保持上游原序（`stableScore` 兜底），避免结果每次抖动。
 */

/** 中文常见虚词/连接词：不参与打分（否则「的」「了」会稀释所有结果）。 */
const STOP_CHARS = new Set(['的', '了', '是', '在', '和', '与', '及', '或', '有', '这', '那', '我', '你', '他', '它'])

/** 英文停用词。 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'with', 'by', 'at', 'from', 'as',
])

/** 切词：英文/数字串整段 + 中文连续片段按 bigram 切。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  // 英文 / 数字 / 型号串（允许连字符、点、下划线，如 c2000 / node-seek / v4.1）
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/g)) {
    const tok = m[0]
    if (tok.length < 2 || STOP_WORDS.has(tok)) continue
    tokens.push(tok)
  }
  // 中文片段 → bigram（单字不切，避免噪声）
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0]
    if (seg.length === 1) {
      if (!STOP_CHARS.has(seg)) tokens.push(seg)
      continue
    }
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bigram = seg.slice(i, i + 2)
      if (STOP_CHARS.has(bigram.charAt(0)) && STOP_CHARS.has(bigram.charAt(1))) continue
      tokens.push(bigram)
    }
  }
  return tokens
}

/** 计算一组 token 的「逆文档频率」权重（出现越少越重要）。 */
function idfWeights(docs: readonly string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const token of new Set(tokenize(doc))) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const total = Math.max(docs.length, 1)
  const weights = new Map<string, number>()
  for (const [token, count] of df) {
    // 平滑 IDF：1 + ln(N / df)，出现于全部文档的 token 权重 ≈ 1
    weights.set(token, 1 + Math.log(total / count))
  }
  return weights
}

/** 相关性重排：高分在前，低分/零分保留（不硬删，只降权）以免误杀。 */
export function rankByRelevance<T extends { title: string; url: string; snippet: string }>(
  query: string,
  results: readonly T[],
): T[] {
  if (results.length <= 1) return [...results]
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return [...results]

  const docs = results.map((r) => `${r.title} ${r.snippet} ${r.url}`)
  const weights = idfWeights(docs)
  const querySet = new Set(queryTokens)
  const phrase = query.trim().toLowerCase()

  const scored = results.map((result, index) => {
    const titleTokens = new Set(tokenize(result.title))
    const bodyTokens = new Set(tokenize(`${result.snippet} ${result.url}`))
    let score = 0
    for (const token of querySet) {
      const weight = weights.get(token) ?? 1
      if (titleTokens.has(token)) score += 3 * weight
      else if (bodyTokens.has(token)) score += 1 * weight
    }
    // 整串命中是强信号（如型号 "c2000" 原样出现在标题）
    const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase()
    if (phrase !== '' && haystack.includes(phrase)) score += 6
    // 域名/标题里带 URL 主机名匹配也加分
    try {
      const host = new URL(result.url).hostname.toLowerCase()
      for (const token of querySet) if (host.includes(token)) score += 2
    } catch {
      /* 非法 URL 忽略 */
    }
    return { result, index, score }
  })

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return scored.map((s) => s.result)
}

/**
 * 联网检索（`POST /agenttool/v1/search`）。
 * 支持国内版（带 IDE 桌面头）与国际版，结果适配 DSH Search API 形状，
 * 并做一层**相关性重排**（压制同名不同物的噪声结果）。
 */
export async function webSearch(
  ctx: { uid: string; accessToken: string; realm?: string; enterpriseId?: string },
  env: Env,
  input: { query: string; maxResults?: number; count?: number; rerank?: boolean },
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
  // 默认开启重排；`rerank: false` 可关掉（调试 / 需要上游原序时）
  const ranked = input.rerank === false ? results : rankByRelevance(input.query, results)
  return {
    query: typeof data.query === 'string' ? data.query : input.query,
    results: ranked,
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
  let rawContent = ''
  let title = ''
  let url = input.url

  try {
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

    rawContent = typeof data.content === 'string' ? data.content : ''
    title = typeof data.title === 'string' ? data.title : ''
    url = typeof data.url === 'string' ? data.url : input.url

    // 有有效正文且不是盾页：直接返回
    if (rawContent && !isChallengePage(200, rawContent)) {
      return { url, title, content: rawContent }
    }
    console.warn(`[webfetch] 上游 webfetch 疑似被盾拦截或正文为空（${input.url}），回退直连抓取`)
  } catch (upstreamError) {
    /**
     * 🔴 **上游 webfetch 本身失败也要回退直连**（2026-11-07 实测）。
     *
     * 真实故障（AWS Sydney 节点：`3.25.148.48`）：
     * `edgebrowser: API error: domain rejected by via routing policy`
     * —— 上游的抓取代理有域名白名单，**不在白名单的站点直接拒绝**，
     * 连页面都没抓过一次。这不是「盾」，也不是「账号问题」，
     * 但用户看到的就是「抓取失败」。
     *
     * 而这类站点**我们的直连往往能拿到**（服务器出口 IP 干净、UA 正常）。
     * ⇒ 上游失败一律尝试直连，只有直连也失败才报错。
     *
     * ⚠️ 仍然**不伪造内容**：直连失败时抛出直连的真实原因。
     */
    console.warn(
      `[webfetch] 上游 webfetch 调用失败（${input.url}），回退直连抓取：`,
      upstreamError instanceof Error ? upstreamError.message : String(upstreamError),
    )
    try {
      return await directFetch(input.url)
    } catch (directError) {
      const upstreamMsg = upstreamError instanceof Error ? upstreamError.message : String(upstreamError)
      const directMsg = directError instanceof Error ? directError.message : String(directError)
      throw new UpstreamError({
        kind: 'unknown',
        httpStatus: 502,
        message: `抓取失败：上游接口与直连抓取均不可用`,
        detail: `上游：${upstreamMsg.slice(0, 300)}；直连：${directMsg.slice(0, 300)}`,
      })
    }
  }

  // 上游成功但没有正文 / 是盾页：回退直连抓取
  try {
    return await directFetch(input.url)
  } catch (directError) {
    // 直连也失败：如实报错，附带上游原文片段以便排查
    if (rawContent) {
      throw new UpstreamError({
        kind: 'unknown',
        httpStatus: 502,
        message: '目标站点有反爬保护（Cloudflare 盾 / 人机验证），上游与直连抓取均被拦截',
        detail: `直连错误：${directError instanceof Error ? directError.message : String(directError)}；上游正文：${rawContent.slice(0, 300)}`,
      })
    }
    throw directError
  }
}

/**
 * 将 HTML 转为干净 Markdown（轻量、无依赖）。
 *
 * 目标不是完美还原（那需要 DOM 解析器，体积与 CPU 都不适合 Worker），
 * 而是「抽掉脚本/样式/导航噪声，留下正文条款」—— 对模型足够可读。
 */
export function htmlToMarkdown(html: string, baseUrl = ''): { title: string; markdown: string } {
  // 提取标题
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? ''

  let body = html
  // 去掉脚本、样式、内嵌 SVG、注释等噪声块
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside|header)\b[^>]*>[\s\S]*?<\/\1>/gi, '')

  // 把块级标签转换成换行/前缀
  body = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, text) => `\n\n${'#'.repeat(Number(lvl))} ${text.trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/div>/gi, '\n')

  // 链接：保留文本与绝对地址
  body = body.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const label = stripTags(text).trim()
    if (label === '') return ''
    try {
      const abs = baseUrl ? new URL(href, baseUrl).toString() : href
      return `[${label}](${abs})`
    } catch {
      return `[${label}](${href})`
    }
  })

  // 处理图片：只保留 alt，避免产生无意义 URL
  body = body.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, ' $1 ').replace(/<img\b[^>]*>/gi, '')

  const text = stripTags(body)
  const markdown = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, idx, arr) => line !== '' || (arr[idx - 1] ?? '') !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, markdown }
}

/** 去掉所有 HTML 标签（保留文本）。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
}

/** 解码常见 HTML 实体（够用即可，不做完整实体表）。 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const code = Number.parseInt(ent.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (ent.startsWith('#')) {
      const code = Number.parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return named[ent.toLowerCase()] ?? whole
  })
}

/**
 * 直连抓取 + HTML 转 Markdown（**反爬回退路径**）。
 *
 * ## 为什么需要它
 * 上游 `/agenttool/v1/webfetch` 在目标站点挂有 Cloudflare 5 秒盾 / 人机验证时，
 * 会拿到一页「Just a moment...」或直接失败（实测 NodeSeek 等站点）。
 * 此时回退到**我们自己**发一次带完整浏览器 UA 的直连请求：
 * - 部分站点只校验 UA / Accept 头，直连即可拿到正常 HTML；
 * - 仍被盾拦截时如实报错（不伪造内容）。
 *
 * ⚠️ 刻意**不引入 Headless 浏览器**：Workers/Node 运行时都不支持完整 Chromium，
 * 强塞只会让镜像膨胀几百 MB 且内存爆掉。这里只做「UA + 头 + HTML 清洗」。
 */
export async function directFetch(url: string): Promise<FetchResult> {
  /**
   * ⚠️ **请求头必须「像浏览器但不过度伪装」**（2026-11-07 实测踩到）。
   *
   * ## 实测故障（AWS Sydney，直连 NodeSeek 返回 403；同机 `curl -A <UA>` 是 200）
   *
   * 第一版发了一整套 `Sec-Fetch-*` + `Sec-*` + `Accept-Encoding: br` 的「完整浏览器指纹」，
   * 结果 **403**。原因是**指纹必须自洽**：
   * - 声明 `br`（Brotli）却由 Node 的 undici 解码 —— 部分 CF 规则会因此判为非浏览器；
   * - `Sec-Fetch-Site: none` + 缺 `sec-ch-ua` ⇒ 就是「伪造了一半的 Chrome」，反而更可疑。
   *
   * ⇒ 收敛成 **curl / 普通 HTTP 客户端** 的形态：UA + Accept + Accept-Language 三件套。
   * 实测同机 curl 用这套是 **200**。**少即是多**：宁可不像浏览器，也不要「半像」。
   */
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(25_000),
  })

  const contentType = res.headers.get('content-type') ?? ''
  // 非 HTML：可能是纯文本 / JSON / markdown，原样返回
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    const text = await res.text()
    return { url, title: '', content: text.slice(0, 200_000) }
  }

  const html = (await res.text()).slice(0, 2_000_000)
  /**
   * ⚠️ **先判盾、再看状态码**（2026-11-07 实测）。
   *
   * Cloudflare 的 JS 挑战页常以 **HTTP 403** 返回，正文是 `Just a moment...`。
   * 若先按「非 2xx ⇒ 直接 throw 上游错误」处理，用户只会看到
   * 「目标站点返回 HTTP 403」，**完全看不出是盾**，也就不会知道该换个站点或换网络。
   * 故这里把盾页单独识别并给出可执行的建议。
   */
  if (isChallengePage(res.status, html)) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: res.status,
      message: '目标站点有 Cloudflare 人机验证（JS 挑战 / 5 秒盾）。'
        + '这需要真实浏览器执行 JS 才能通过，网关侧的纯 HTTP 抓取无法绕过；'
        + '请换用该站点的镜像、RSS、API，或直接从浏览器复制正文。',
      detail: `url=${url} status=${res.status}`,
    })
  }

  if (!res.ok) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: res.status,
      message: `直连抓取失败：目标站点返回 HTTP ${res.status}`,
      detail: `url=${url}`,
    })
  }

  const { title, markdown } = htmlToMarkdown(html, res.url || url)
  if (markdown === '') {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: '直连抓取成功，但页面正文为空（可能是纯前端渲染站点）',
      detail: `url=${url}`,
    })
  }
  return { url: res.url || url, title, content: markdown.slice(0, 200_000) }
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
