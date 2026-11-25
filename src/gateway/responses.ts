/**
 * **OpenAI Responses API** 出口（`POST /v1/responses`）。
 *
 * ## 为什么要有它
 *
 * 本项目最初只有 `/v1/chat/completions`。而新一代客户端（Codex CLI、以及各家
 * 「只认 Responses」的 agent）**不发** `messages` / `max_tokens`，而是发
 * `input` / `instructions` / `max_output_tokens`，并且只解析 Responses 的
 * SSE 事件（`response.output_text.delta` / `response.output_item.done` /
 * `response.completed`）。协议外壳不同，往里塞 Chat Completions 是塞不进的。
 *
 * 依据：
 * - 参考实现 `deepseek-harness-codearts/src/openai-gateway/responses.ts:2-16`
 * - `misakano7545/workbuddy2api-panel` 提交 `0e41952`（多轮思维链保真回放、compaction 摘要、元数据跳过）
 * - `licyk/Hoshimi` 提交 `307ba02`（工具输出图片保留）、`d3e4392`（namespace 工具透传）、`9da6bee`（custom 工具往返）
 *
 * ## ⚠️ 两个端点**同时可用**，不做「格式开关」
 *
 * 客户端用哪套协议由它自己请求的 URL 决定。做成互斥开关只会让「另一个协议的
 * 客户端在切换后突然失效」，而网关这边本来就没有任何互斥的理由 ——
 * 两者共用同一份 provider 路由、账号池与图片入站。
 *
 * ## 实现策略：**借用 Chat 路径，只做协议外壳转换**
 *
 * 本模块**不重新实现**选号 / 轮转 / 冷却 / 续期那一整套（那是网关最复杂、
 * 已用真实账号验证过的部分）。做法是：
 *
 * ```
 * Responses 请求  ──toChatBody()──▶  Chat 请求体
 *                                      │
 *                          handleChatCompletions()   ← 复用全部既有能力
 *                                      │
 *              ┌───────────────────────┴───────────────────────┐
 *              ▼                                               ▼
 *   非流式：aggregateSse() → toResponsesObject()      流式：toResponsesSse()
 * ```
 *
 * ⚠️ **与 Chat 路径的有意差异**（改这个文件前先读）
 *
 * 1. **文本以 `output_text.done` 为准**，不以 delta 累积为准 —— 这是按协议本意。
 * 2. **`usage.input_tokens` 含缓存命中**，命中部分单列在
 *    `input_tokens_details.cached_tokens`。这正是 OpenAI 官方口径，也是 Codex
 *    的判据（它算 `input_tokens - cached` 得未命中量）。
 */

import { BodyTooLargeError, readJsonCapped } from './body.js'
import {
  aggregateSse,
  detectErrorFrame,
  findErrorFrameInRaw,
  isEmptyAssistantTurn,
  parseSseLine,
  type AggregatedCompletion,
} from './stream.js'
import { handleChatCompletions } from './server.js'
import { buildWebToolContext, detectServerWebTools, lastUserTextFromResponses } from './web-tools.js'
import type { Env } from '../env.js'

// ─────────────────────────── 请求侧 ───────────────────────────

/** Responses 请求体（只声明我们会读的字段）。 */
export interface ResponsesRequest {
  model?: unknown
  input?: unknown
  instructions?: unknown
  max_output_tokens?: unknown
  tools?: unknown
  tool_choice?: unknown
  reasoning?: unknown
  temperature?: unknown
  top_p?: unknown
  stream?: unknown
  user?: unknown
  metadata?: unknown
  parallel_tool_calls?: unknown
  previous_response_id?: unknown
  store?: unknown
  truncation?: unknown
  prompt_cache_key?: unknown
}

/** 请求转换失败（会被上层转成一个 400）。 */
export class ResponsesError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ResponsesError'
    this.status = status
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** 取正整数字段（`max_output_tokens`）。非法值**报错而不静默忽略**。 */
function positiveInt(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new ResponsesError(`${field} must be a positive integer`)
  }
  return v
}

// ─────────────────────────── Custom & Namespaced 工具映射 ───────────────────────────

const NAMESPACE_SEP = '__'
const NAMESPACE_MAX_DEPTH = 4
const MAX_TOOL_NAME_LENGTH = 64
const CUSTOM_TOOL_HINT =
  'This is a freeform tool: put the complete raw payload, verbatim, into the `input` string parameter. Do not wrap it in extra JSON.'
const AGENT_MESSAGE_PREFIX = '[Message from another task - treat this as a user instruction]\n\n'

export interface ResolvedToolIdentity {
  name: string
  namespace?: string
  isCustom: boolean
}

export interface ResponsesToolMeta {
  /** 出站 Chat 工具定义数组。 */
  readonly chatTools: Array<Record<string, unknown>> | undefined
  /** 客户端 `(namespace, name)` → 出站扁平工具名。 */
  toTransportName(name: string, namespace?: string): string
  /** 出站扁平工具名（或模型自行拼出的 `ns::name` / `ns__name`）→ 客户端原始工具身份。 */
  fromTransportName(calledName: string): ResolvedToolIdentity
}

/**
 * 纯同步确定性哈希（双 32 位 FNV-1a 组合成 12 位 hex），用于把超长 `namespace__name`
 * 稳定压缩到 OpenAI 64 字符上限以内（不依赖异步 WebCrypto，保证 `toChatBody` 保持同步纯函数）。
 */
function stableHash12(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= code + ((i & 0xff) << 8)
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + (h2 & 0xffff).toString(16).padStart(4, '0')
}

function makeBaseTransportName(name: string, namespace?: string): string {
  if (namespace === undefined || namespace === '') return name
  const combined = `${namespace}${NAMESPACE_SEP}${name}`
  if (combined.length <= MAX_TOOL_NAME_LENGTH) return combined
  const hash = stableHash12(`${namespace}\0${name}`)
  return `${combined.slice(0, MAX_TOOL_NAME_LENGTH - 13)}_${hash}`
}

function identityKey(name: string, namespace?: string): string {
  return namespace !== undefined && namespace !== '' ? `${namespace}\0${name}` : `\0${name}`
}

function buildCustomToolFunction(
  transportName: string,
  description: string,
  format: unknown,
): Record<string, unknown> {
  const descParts: string[] = []
  if (description.trim() !== '') descParts.push(description.trim())
  descParts.push(CUSTOM_TOOL_HINT)
  if (isObject(format)) {
    const grammarDef = nonEmptyString(format.definition)
    if (grammarDef !== undefined) {
      descParts.push(`Grammar:\n${grammarDef}`)
    }
  }
  return {
    name: transportName,
    description: descParts.join('\n\n'),
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Complete raw payload for this tool, verbatim.',
        },
      },
      required: ['input'],
    },
  }
}

/**
 * 解析 Responses 的 `tools`，同时支持：
 * - 普通 `type: "function"` 工具
 * - `type: "custom"` 自定义自由文本工具（如 Codex `apply_patch`，降级为单 `input` 字符串参数的 function）
 * - `type: "namespace"` 命名空间工具组（展开子工具并在往返时精确恢复 `namespace` 与原 `name`）
 * - 其余托管工具（`web_search` / `file_search` / `computer_use` 等）维持丢弃，避免上游 400。
 */
export function buildResponsesToolMeta(rawTools: unknown): ResponsesToolMeta {
  if (rawTools !== undefined && rawTools !== null && !Array.isArray(rawTools)) {
    throw new ResponsesError('tools must be an array')
  }

  const chatTools: Array<Record<string, unknown>> = []
  const transportToIdentity = new Map<string, ResolvedToolIdentity>()
  const identityToTransport = new Map<string, string>()
  const usedTransportNames = new Set<string>()

  const allocateTransportName = (
    name: string,
    namespace: string | undefined,
    isCustom: boolean,
  ): string => {
    const key = identityKey(name, namespace)
    const existing = identityToTransport.get(key)
    if (existing !== undefined) return existing

    const base = makeBaseTransportName(name, namespace)
    let candidate = base
    let suffix = 2
    while (usedTransportNames.has(candidate)) {
      const tag = `_${suffix}`
      candidate =
        base.length + tag.length <= MAX_TOOL_NAME_LENGTH
          ? `${base}${tag}`
          : `${base.slice(0, MAX_TOOL_NAME_LENGTH - tag.length)}${tag}`
      suffix += 1
    }

    usedTransportNames.add(candidate)
    identityToTransport.set(key, candidate)
    transportToIdentity.set(candidate, {
      name,
      ...(namespace !== undefined && namespace !== '' ? { namespace } : {}),
      isCustom,
    })
    return candidate
  }

  const collectTool = (
    entry: unknown,
    depth: number,
    inheritedNs?: string,
    inheritedDesc?: string,
  ): void => {
    if (depth > NAMESPACE_MAX_DEPTH || !isObject(entry)) return
    const rawType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : ''

    if (rawType === 'namespace') {
      const nsName = nonEmptyString(entry.name) ?? inheritedNs
      if (nsName === undefined) return
      const nsDesc = nonEmptyString(entry.description)
      const combinedNsDesc = [inheritedDesc, nsDesc].filter(Boolean).join('\n\n')
      const children = Array.isArray(entry.tools)
        ? entry.tools
        : Array.isArray(entry.children)
          ? entry.children
          : Array.isArray(entry.functions)
            ? entry.functions
            : []
      for (const child of children) {
        collectTool(child, depth + 1, nsName, combinedNsDesc || undefined)
      }
      return
    }

    // 在 namespace 内部允许省略子工具 type（默认按 function 处理）；顶层必须显式是 function 或 custom
    const effectiveType = rawType === '' && inheritedNs !== undefined ? 'function' : rawType
    if (effectiveType !== 'function' && effectiveType !== 'custom') return

    // 兼容嵌套 `{ type: 'function', function: { name, ... } }` 与扁平 `{ type: 'function', name, ... }`
    const nestedFn = isObject(entry.function) ? entry.function : undefined
    const origName = nonEmptyString(entry.name) ?? (nestedFn ? nonEmptyString(nestedFn.name) : undefined)
    if (origName === undefined) return

    const explicitNs = nonEmptyString(entry.namespace) ?? inheritedNs
    const rawDesc =
      typeof entry.description === 'string'
        ? entry.description
        : nestedFn && typeof nestedFn.description === 'string'
          ? nestedFn.description
          : ''
    const fullDesc = [inheritedDesc, rawDesc].filter((s) => s !== undefined && s !== '').join('\n\n')

    if (effectiveType === 'custom') {
      const transportName = allocateTransportName(origName, explicitNs, true)
      chatTools.push({
        type: 'function',
        function: buildCustomToolFunction(transportName, fullDesc, entry.format),
      })
      return
    }

    const transportName = allocateTransportName(origName, explicitNs, false)
    const rawParams = isObject(entry.parameters)
      ? entry.parameters
      : nestedFn && isObject(nestedFn.parameters)
        ? nestedFn.parameters
        : isObject(entry.input_schema)
          ? entry.input_schema
          : { type: 'object', properties: {} }

    const fnDef: Record<string, unknown> = {
      name: transportName,
      description: fullDesc,
      parameters: rawParams,
    }
    const strictVal = 'strict' in entry ? entry.strict : nestedFn?.strict
    if (typeof strictVal === 'boolean') {
      fnDef.strict = strictVal
    }
    chatTools.push({
      type: 'function',
      function: fnDef,
    })
  }

  if (Array.isArray(rawTools)) {
    for (const item of rawTools) {
      collectTool(item, 0)
    }
  }

  return {
    chatTools: chatTools.length > 0 ? chatTools : undefined,
    toTransportName(name: string, namespace?: string): string {
      const exact = identityToTransport.get(identityKey(name, namespace))
      if (exact !== undefined) return exact
      // 若请求未声明 namespace 但全表只有一个重名 namespace 映射，保持原名；显式带了 namespace 则按统一规则编码
      return makeBaseTransportName(name, namespace)
    },
    fromTransportName(calledName: string): ResolvedToolIdentity {
      const direct = transportToIdentity.get(calledName)
      if (direct !== undefined) return direct

      // 容忍模型自发使用 `ns::name` 返回工具名的情况
      const colonIdx = calledName.indexOf('::')
      if (colonIdx > 0) {
        const ns = calledName.slice(0, colonIdx)
        const tail = calledName.slice(colonIdx + 2)
        const mapped = identityToTransport.get(identityKey(tail, ns))
        if (mapped !== undefined) {
          const found = transportToIdentity.get(mapped)
          if (found !== undefined) return found
        }
        return { name: tail, namespace: ns, isCustom: false }
      }

      return { name: calledName, isCustom: false }
    },
  }
}

/**
 * 严格解包 custom(freeform) 工具的返回参数。
 *
 * 仅接受 `{"input": "<string>"}`（单键且值为字符串）或 JSON 字符串字面量。
 * 残缺 JSON、非字符串或空载荷返回 `{ input: '', ok: false }`，交由出站标为 `incomplete`，
 * 防止客户端把半截补丁当成合法补丁执行。
 */
export function unwrapCustomToolInput(rawArgs: string): { input: string; ok: boolean } {
  const trimmed = rawArgs.trim()
  if (trimmed === '') return { input: '', ok: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return { input: '', ok: false }
  }
  if (typeof parsed === 'string') {
    return parsed !== '' ? { input: parsed, ok: true } : { input: '', ok: false }
  }
  if (isObject(parsed)) {
    const keys = Object.keys(parsed)
    if (keys.length === 1 && typeof parsed.input === 'string' && parsed.input !== '') {
      return { input: parsed.input, ok: true }
    }
  }
  return { input: '', ok: false }
}

function packCustomToolInput(rawInput: unknown): string {
  let str = ''
  if (typeof rawInput === 'string') {
    str = rawInput
  } else if (rawInput !== undefined && rawInput !== null) {
    try {
      str = JSON.stringify(rawInput) ?? ''
    } catch {
      str = String(rawInput)
    }
  }
  return JSON.stringify({ input: str })
}

// ─────────────────────────── 内容块、思维链回放与 Compaction ───────────────────────────

function extractImagePart(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  // ⚠️ 只透传 URL / data URL 字符串，绝不在网关侧下载外部图片 URL（防 SSRF）
  let url: string | undefined
  let detail: string | undefined

  if (typeof raw.detail === 'string' && raw.detail !== '') {
    detail = raw.detail
  }

  if (typeof raw.image_url === 'string' && raw.image_url !== '') {
    url = raw.image_url
  } else if (isObject(raw.image_url)) {
    url = nonEmptyString(raw.image_url.url)
    if (detail === undefined && typeof raw.image_url.detail === 'string' && raw.image_url.detail !== '') {
      detail = raw.image_url.detail
    }
  } else if (typeof raw.url === 'string' && raw.url !== '') {
    url = raw.url
  }

  if (url === undefined) return undefined
  return {
    type: 'image_url',
    image_url: detail !== undefined ? { url, detail } : { url },
  }
}

/**
 * Responses 的 content 块 → Chat 的 content 块。
 *
 * | Responses | Chat |
 * |---|---|
 * | `input_text` / `output_text` / `text` | `text` |
 * | `input_image` / `image_url` | `image_url` |
 */
function chatPartsFromResponses(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const raw of content) {
    if (!isObject(raw)) continue
    const type = raw.type
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === undefined) {
      if (typeof raw.text === 'string') {
        out.push({ type: 'text', text: raw.text })
      }
      continue
    }
    if (type === 'input_image' || type === 'image_url') {
      const img = extractImagePart(raw)
      if (img !== undefined) out.push(img)
      continue
    }
    // 未知块类型静默跳过，避免上游新增块类型导致整轮对话 400
  }
  return out.length > 0 ? out : ''
}

/** 从 content 里抽出纯文本（assistant / system 历史用）。 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const raw of content) {
    if (!isObject(raw)) continue
    if (typeof raw.text === 'string') out += raw.text
  }
  return out
}

/**
 * 拆分工具输出的文本与图片（`function_call_output` / `custom_tool_call_output` 共用）。
 *
 * Chat 的 `role: 'tool'` 消息不允许直接含 `image_url`（上游会报 400），
 * 故文本留在 `role: 'tool'`，图片收集后在本批连续工具回复末尾以一条 `role: 'user'` 视觉消息附上。
 */
function splitToolOutputImages(output: unknown): {
  text: string
  images: Array<Record<string, unknown>>
} {
  if (typeof output === 'string') {
    return { text: output, images: [] }
  }
  if (!Array.isArray(output)) {
    if (output === undefined || output === null) return { text: '', images: [] }
    try {
      return { text: JSON.stringify(output) ?? '', images: [] }
    } catch {
      return { text: String(output), images: [] }
    }
  }
  const texts: string[] = []
  const images: Array<Record<string, unknown>> = []
  for (const raw of output) {
    if (!isObject(raw)) continue
    const t = raw.type
    if (t === 'input_image' || t === 'image_url') {
      const img = extractImagePart(raw)
      if (img !== undefined) images.push(img)
      continue
    }
    if (typeof raw.text === 'string') {
      texts.push(raw.text)
    }
  }
  return { text: texts.join(''), images }
}

/** 拼接两段可见思考文本（完全相同时去重，不同时以 `\n` 连接，不做 trim 保留原始缩进）。 */
function appendVisibleReasoning(current: string, addition: string): string {
  if (addition === '') return current
  if (current === '') return addition
  if (current === addition) return current
  return `${current}\n${addition}`
}

function extractTextArrayParts(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  const parts: string[] = []
  for (const item of val) {
    if (!isObject(item)) continue
    if (typeof item.text === 'string' && item.text !== '') {
      parts.push(item.text)
    }
  }
  return parts
}

/** 提取 `reasoning` 输入项中的思考文本（优先 `summary`，其次 `content` / `reasoning_content`）。 */
function extractReasoningItemText(item: Record<string, unknown>): string {
  if (typeof item.summary === 'string' && item.summary !== '') return item.summary
  const summaryParts = extractTextArrayParts(item.summary)
  if (summaryParts.length > 0) return summaryParts.join('\n')

  if (typeof item.content === 'string' && item.content !== '') return item.content
  const contentParts = extractTextArrayParts(item.content)
  if (contentParts.length > 0) return contentParts.join('\n')

  if (typeof item.reasoning_content === 'string' && item.reasoning_content !== '') {
    return item.reasoning_content
  }
  return ''
}

const REASONING_SUBSTANTIVE_TYPES = new Set([
  'message',
  'user',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'compaction',
  'compaction_summary',
  'context_compaction',
  'agent_message',
])

function findNextSubstantiveItem(
  items: unknown[],
  startIndex: number,
): Record<string, unknown> | undefined {
  for (let i = startIndex + 1; i < items.length; i += 1) {
    const cand = items[i]
    if (!isObject(cand)) continue
    const t = typeof cand.type === 'string' ? cand.type : ''
    if (t === '' || REASONING_SUBSTANTIVE_TYPES.has(t)) {
      return cand
    }
  }
  return undefined
}

function itemStartsAssistantTurn(target: Record<string, unknown> | undefined): boolean {
  if (target === undefined) return false
  const t = typeof target.type === 'string' ? target.type : ''
  if (t === 'function_call' || t === 'custom_tool_call') return true
  if (t === '' || t === 'message') {
    return target.role === 'assistant'
  }
  return false
}

/**
 * 纯 Web Standard UTF-8 Base64 解码：解码 `compaction` 项的 `encrypted_content`。
 *
 * 标准形态为 `base64(JSON {"v":1,"summary":"..."})`；若不是合法 base64 或无 `summary` 字段，
 * 则原样保留非空文本作为上下文检查点摘要（绝不因解码失败丢失唯一一份压缩历史）。
 */
export function decodeCompactionSummary(blob: unknown): string {
  if (typeof blob !== 'string') return ''
  const trimmed = blob.trim()
  if (trimmed === '') return ''

  // 兼容 URL-safe Base64 并补齐 `=` 填充位
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    try {
      const binary = atob(padded)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
      const parsed = JSON.parse(utf8) as unknown
      if (isObject(parsed) && typeof parsed.summary === 'string' && parsed.summary.trim() !== '') {
        return parsed.summary.trim()
      }
    } catch {
      // 非 Base64 JSON：回退为原文
    }
  }

  return trimmed
}

/** 元数据/托管控制项集合：不生成消息，且不打断连续 reasoning 组。 */
const SKIPPED_METADATA_ITEM_TYPES = new Set([
  'additional_tools',
  'compaction_trigger',
  'local_shell_call',
  'local_shell_call_output',
  'web_search_call',
  'file_search_call',
  'computer_call',
  'computer_call_output',
  'image_generation_call',
  'code_interpreter_call',
  'mcp_list_tools',
  'mcp_approval_request',
  'mcp_approval_response',
  'mcp_call',
])

/**
 * 校验那些「语义会变、故不能静默忽略」的字段。
 */
function assertSupported(body: ResponsesRequest): void {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw new ResponsesError(
      'previous_response_id is not supported: this gateway is stateless and stores no responses. ' +
        'Please send the full conversation in `input` each time.',
    )
  }
  if (body.store === true) {
    throw new ResponsesError(
      'store:true is not supported: this gateway is stateless and keeps no response history.',
    )
  }
}

function normalizeOutboundToolChoice(
  rawChoice: unknown,
  toolMeta: ResponsesToolMeta,
): unknown {
  if (rawChoice === undefined || rawChoice === null) return undefined
  if (typeof rawChoice === 'string') return rawChoice
  if (!isObject(rawChoice)) return rawChoice

  const kind = typeof rawChoice.type === 'string' ? rawChoice.type.trim().toLowerCase() : ''
  if (kind === 'function' || kind === 'custom') {
    const nestedFn = isObject(rawChoice.function) ? rawChoice.function : undefined
    const name = nonEmptyString(rawChoice.name) ?? (nestedFn ? nonEmptyString(nestedFn.name) : undefined)
    const ns = nonEmptyString(rawChoice.namespace)
    if (name !== undefined) {
      return {
        type: 'function',
        function: { name: toolMeta.toTransportName(name, ns) },
      }
    }
  }
  return rawChoice
}

/**
 * Responses 请求体 → Chat 请求体。
 *
 * @param body 已解析的 Responses 请求体
 * @param model 已由调用方确定（或透传给 `handleChatCompletions` 路由）的模型名
 */
export function toChatBody(body: ResponsesRequest, model: string): Record<string, unknown> {
  assertSupported(body)

  const toolMeta = buildResponsesToolMeta(body.tools)
  const messages: Array<Record<string, unknown>> = []

  // `instructions` 转为首条 `system` 消息（国际版上游要求首条为 system，否则报 11128）
  const instructions = nonEmptyString(body.instructions)
  if (instructions !== undefined) {
    messages.push({ role: 'system', content: instructions })
  }

  const input = body.input
  if (typeof input === 'string') {
    if (input !== '') messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    let pendingToolCalls: Array<Record<string, unknown>> = []
    let pendingReasoning = ''
    let pendingToolImages: Array<Record<string, unknown>> = []

    const flushToolImages = (): void => {
      if (pendingToolImages.length === 0) return
      messages.push({
        role: 'user',
        content: pendingToolImages,
      })
      pendingToolImages = []
    }

    const flushToolCalls = (): void => {
      if (pendingToolCalls.length === 0) return
      const prev = messages.length > 0 ? messages[messages.length - 1] : undefined
      // 若同一轮紧挨在前面的是尚无 tool_calls 的 assistant 正文消息，且中间没有新一段独立思考，
      // 直接把本批 tool_calls 挂到该条 assistant 上，避免同轮拆成两条相邻 assistant。
      if (
        pendingReasoning === '' &&
        prev !== undefined &&
        prev.role === 'assistant' &&
        !Array.isArray(prev.tool_calls)
      ) {
        prev.tool_calls = pendingToolCalls
        pendingToolCalls = []
        return
      }
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: '',
        tool_calls: pendingToolCalls,
      }
      if (pendingReasoning !== '') {
        msg.reasoning_content = pendingReasoning
        pendingReasoning = ''
      }
      messages.push(msg)
      pendingToolCalls = []
    }

    for (let idx = 0; idx < input.length; idx += 1) {
      const raw = input[idx]
      if (!isObject(raw)) {
        throw new ResponsesError('input entries must be objects')
      }
      const type = typeof raw.type === 'string' ? raw.type : undefined

      // 非工具输出项到来前，先把上一批并行工具结果附带的图片统一落地成一条 user 消息
      if (type !== 'function_call_output' && type !== 'custom_tool_call_output') {
        flushToolImages()
      }

      if (type === undefined || type === 'message' || type === 'user') {
        flushToolCalls()
        const role = type === 'user' ? 'user' : raw.role
        if (role === 'user') {
          pendingReasoning = ''
          messages.push({ role: 'user', content: chatPartsFromResponses(raw.content) })
          continue
        }
        if (role === 'assistant') {
          const msg: Record<string, unknown> = {
            role: 'assistant',
            content: textFromContent(chatPartsFromResponses(raw.content)),
          }
          let mergedReasoning = pendingReasoning
          pendingReasoning = ''
          if (typeof raw.reasoning_content === 'string' && raw.reasoning_content !== '') {
            mergedReasoning = appendVisibleReasoning(mergedReasoning, raw.reasoning_content)
          }
          if (mergedReasoning !== '') {
            msg.reasoning_content = mergedReasoning
          }
          // 保留 Chat 形态混排回放时的内联 tool_calls（避免下游 tool 消息变成孤儿撞 11148）
          if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
            msg.tool_calls = raw.tool_calls.map((tc) => {
              if (!isObject(tc) || !isObject(tc.function)) return tc
              const fnName = nonEmptyString(tc.function.name)
              if (fnName === undefined) return tc
              const ns = nonEmptyString(tc.namespace)
              return {
                ...tc,
                function: {
                  ...tc.function,
                  name: toolMeta.toTransportName(fnName, ns),
                },
              }
            })
          }
          messages.push(msg)
          continue
        }
        if (role === 'system' || role === 'developer') {
          pendingReasoning = ''
          messages.push({ role: 'system', content: textFromContent(chatPartsFromResponses(raw.content)) })
          continue
        }
        if (role === 'tool') {
          // 兼容客户端直接混排 Chat 形态 `{ role: "tool", tool_call_id, content }`
          pendingReasoning = ''
          const callId = nonEmptyString(raw.tool_call_id) ?? nonEmptyString(raw.call_id)
          if (callId === undefined) throw new ResponsesError('tool message requires tool_call_id')
          const split = splitToolOutputImages(raw.content)
          let text = split.text
          if (text === '' && split.images.length > 0) {
            text = '[tool result image attached in following user message]'
          }
          messages.push({ role: 'tool', tool_call_id: callId, content: text })
          if (split.images.length > 0) {
            pendingToolImages.push(
              { type: 'text', text: `[image output of tool call ${callId}]` },
              ...split.images,
            )
          }
          continue
        }
        throw new ResponsesError(`unsupported message role: ${String(role)}`)
      }

      if (type === 'function_call' || type === 'custom_tool_call') {
        const callId = nonEmptyString(raw.call_id) ?? nonEmptyString(raw.id)
        const name = nonEmptyString(raw.name)
        if (callId === undefined || name === undefined) {
          throw new ResponsesError(`${type} requires call_id and name`)
        }
        const ns = nonEmptyString(raw.namespace)
        const transportName = toolMeta.toTransportName(name, ns)
        const args =
          type === 'custom_tool_call'
            ? packCustomToolInput(raw.input)
            : typeof raw.arguments === 'string' && raw.arguments !== ''
              ? raw.arguments
              : '{}'
        pendingToolCalls.push({
          id: callId,
          type: 'function',
          function: { name: transportName, arguments: args },
        })
        continue
      }

      if (type === 'function_call_output' || type === 'custom_tool_call_output') {
        flushToolCalls()
        pendingReasoning = ''
        const callId = nonEmptyString(raw.call_id) ?? nonEmptyString(raw.id)
        if (callId === undefined) {
          throw new ResponsesError(`${type} requires call_id`)
        }
        const split = splitToolOutputImages(raw.output)
        let text = split.text
        if (text === '' && split.images.length > 0) {
          text = '[tool result image attached in following user message]'
        }
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: text,
        })
        if (split.images.length > 0) {
          pendingToolImages.push(
            { type: 'text', text: `[image output of tool call ${callId}]` },
            ...split.images,
          )
        }
        continue
      }

      if (type === 'reasoning') {
        flushToolCalls()
        const text = extractReasoningItemText(raw)
        if (text !== '') {
          const target = findNextSubstantiveItem(input, idx)
          const prev = messages.length > 0 ? messages[messages.length - 1] : undefined
          if (!itemStartsAssistantTurn(target) && prev !== undefined && prev.role === 'assistant') {
            const existing = typeof prev.reasoning_content === 'string' ? prev.reasoning_content : ''
            prev.reasoning_content = appendVisibleReasoning(existing, text)
          } else {
            pendingReasoning = appendVisibleReasoning(pendingReasoning, text)
          }
        }
        continue
      }

      if (type === 'compaction' || type === 'compaction_summary' || type === 'context_compaction') {
        flushToolCalls()
        pendingReasoning = ''
        const rawSummary = raw.encrypted_content ?? raw.summary ?? raw.content
        const decoded = decodeCompactionSummary(rawSummary)
        if (decoded !== '') {
          messages.push({
            role: 'system',
            content: `Summary of the earlier conversation (context checkpoint):\n\n${decoded}`,
          })
        }
        continue
      }

      if (type === 'agent_message') {
        flushToolCalls()
        pendingReasoning = ''
        const text = textFromContent(chatPartsFromResponses(raw.content)).trim()
        if (text !== '') {
          messages.push({
            role: 'user',
            content: `${AGENT_MESSAGE_PREFIX}${text}`,
          })
        }
        continue
      }

      if (type === 'item_reference') {
        flushToolCalls()
        throw new ResponsesError(
          'item_reference is not supported: this gateway is stateless and cannot resolve references.',
        )
      }

      if (SKIPPED_METADATA_ITEM_TYPES.has(type)) {
        // 元数据与托管调用记录跳过：不造假空消息，也不清空 pendingReasoning
        continue
      }

      // 其他未知扩展项同样安全跳过（避免新型客户端附加元数据项导致 400 中断整轮任务）
      continue
    }

    flushToolCalls()
    flushToolImages()
  } else if (input !== undefined && input !== null) {
    throw new ResponsesError('input must be a string or an array of items')
  }

  if (messages.length === 0) throw new ResponsesError('input contains no usable message')

  const chat: Record<string, unknown> = { model, messages }

  const maxOut = positiveInt(body.max_output_tokens, 'max_output_tokens')
  if (maxOut !== undefined) chat.max_completion_tokens = maxOut

  if (toolMeta.chatTools !== undefined) chat.tools = toolMeta.chatTools
  const normalizedChoice = normalizeOutboundToolChoice(body.tool_choice, toolMeta)
  if (normalizedChoice !== undefined) chat.tool_choice = normalizedChoice

  // `parallel_tool_calls` 在 Responses 与 Chat Completions 中同名同语义，但缺省不同（对齐 `workbuddy-manager` `a7e9891`）：
  // 仅当客户端显式传入布尔值（尤其 `false` 单工具回合约束）时原样透传；缺省或非布尔值一律不编造字段，保留上游默认行为。
  if (typeof body.parallel_tool_calls === 'boolean') {
    chat.parallel_tool_calls = body.parallel_tool_calls
  }
  if (typeof body.temperature === 'number') chat.temperature = body.temperature
  if (typeof body.top_p === 'number') chat.top_p = body.top_p

  const user = nonEmptyString(body.user) ?? nonEmptyString(body.prompt_cache_key)
  if (user !== undefined) chat.user = user

  if (isObject(body.reasoning)) {
    const effort = nonEmptyString(body.reasoning.effort)
    if (effort !== undefined) chat.reasoning_effort = effort
  }

  return chat
}

// ─────────────────────────── 响应侧 ───────────────────────────

/** 一个输出项的累积状态。 */
interface Item {
  kind: 'message' | 'reasoning' | 'function_call' | 'custom_tool_call'
  id: string
  outputIndex: number
  text: string
  callId: string
  name: string
  namespace?: string
  args: string
  input?: string
  status?: 'completed' | 'incomplete'
  opened?: boolean
  closed?: boolean
}

function hexId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${s}`
}

/** 上游 `finish_reason` → Responses 的 `status`。 */
function statusOf(finishReason: string | null | undefined): 'completed' | 'incomplete' {
  return finishReason === 'length' || finishReason === 'max_tokens' ? 'incomplete' : 'completed'
}

/** 组装最终的 `output[]`（**必须按 outputIndex 排序**）。 */
function outputOf(items: Item[], defaultStatus: 'completed' | 'incomplete' = 'completed'): unknown[] {
  const sorted = [...items].sort((a, b) => a.outputIndex - b.outputIndex)
  return sorted.map((it) => {
    if (it.kind === 'message') {
      return {
        id: it.id,
        type: 'message',
        status: it.status ?? defaultStatus,
        role: 'assistant',
        content: [{ type: 'output_text', text: it.text, annotations: [] }],
      }
    }
    if (it.kind === 'reasoning') {
      return {
        id: it.id,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: it.text }],
      }
    }
    if (it.kind === 'custom_tool_call') {
      return {
        id: it.id,
        type: 'custom_tool_call',
        status: it.status ?? defaultStatus,
        call_id: it.callId,
        name: it.name,
        ...(it.namespace !== undefined && it.namespace !== '' ? { namespace: it.namespace } : {}),
        input: it.input ?? '',
      }
    }
    return {
      id: it.id,
      type: 'function_call',
      status: it.status ?? defaultStatus,
      call_id: it.callId,
      name: it.name,
      ...(it.namespace !== undefined && it.namespace !== '' ? { namespace: it.namespace } : {}),
      arguments: it.args,
    }
  })
}

/**
 * 从**非流式**的聚合结果构造 Responses JSON 对象。
 */
export function toResponsesObject(
  request: ResponsesRequest,
  model: string,
  aggregated: AggregatedCompletion,
  responseId: string,
  precomputedToolMeta?: ResponsesToolMeta,
): Record<string, unknown> {
  const toolMeta = precomputedToolMeta ?? buildResponsesToolMeta(request.tools)
  const choice = aggregated.choices[0]
  const message: Record<string, unknown> = choice?.message ?? {}
  const items: Item[] = []
  let idx = 0

  const status = statusOf(choice?.finish_reason)

  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  if (reasoning !== '') {
    items.push({
      kind: 'reasoning',
      id: hexId('rs'),
      outputIndex: idx++,
      text: reasoning,
      callId: '',
      name: '',
      args: '',
    })
  }

  const content = typeof message.content === 'string' ? message.content : ''
  const refusal = typeof message.refusal === 'string' ? message.refusal : ''
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  if (content !== '' || refusal !== '' || calls.length === 0) {
    items.push({
      kind: 'message',
      id: hexId('msg'),
      outputIndex: idx++,
      text: content !== '' ? content : refusal,
      callId: '',
      name: '',
      args: '',
      status,
    })
  }

  const pushToolItem = (rawCallId: string, rawName: string, rawArgs: string): void => {
    if (rawName === '') return
    const resolved = toolMeta.fromTransportName(rawName)
    const callId = rawCallId !== '' ? rawCallId : hexId('call')
    if (resolved.isCustom) {
      const unwrapped = unwrapCustomToolInput(rawArgs)
      items.push({
        kind: 'custom_tool_call',
        id: callId,
        outputIndex: idx++,
        text: '',
        callId,
        name: resolved.name,
        ...(resolved.namespace !== undefined ? { namespace: resolved.namespace } : {}),
        args: rawArgs,
        input: unwrapped.input,
        status: unwrapped.ok ? status : 'incomplete',
      })
      return
    }
    items.push({
      kind: 'function_call',
      id: hexId('fc'),
      outputIndex: idx++,
      text: '',
      callId,
      name: resolved.name,
      ...(resolved.namespace !== undefined ? { namespace: resolved.namespace } : {}),
      args: rawArgs,
      status,
    })
  }

  const legacyCall = isObject(message.function_call) ? message.function_call : undefined
  if (legacyCall !== undefined) {
    pushToolItem(
      '',
      nonEmptyString(legacyCall.name) ?? '',
      typeof legacyCall.arguments === 'string' ? legacyCall.arguments : '',
    )
  }

  for (const call of calls) {
    const c = isObject(call) ? call : {}
    const fn = isObject(c.function) ? c.function : {}
    pushToolItem(
      nonEmptyString(c.id) ?? '',
      nonEmptyString(fn.name) ?? '',
      typeof fn.arguments === 'string' ? fn.arguments : '',
    )
  }

  const effort = isObject(request.reasoning) ? request.reasoning.effort ?? null : null

  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model,
    output: outputOf(items, status),
    parallel_tool_calls: request.parallel_tool_calls === false ? false : true,
    previous_response_id: null,
    reasoning: { effort, summary: null },
    store: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: usageOf(aggregated.usage as Record<string, unknown> | undefined),
    user: typeof request.user === 'string' ? request.user : null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  }
}

/**
 * Chat 的 `usage` → Responses 的 `usage`。
 *
 * ## 🔴 `input_tokens` 必须**含**缓存命中（官方口径）
 */
export function usageOf(raw: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  const prompt = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0
  const completion = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0
  const details = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const cached =
    typeof details.cached_tokens === 'number'
      ? details.cached_tokens
      : typeof raw.prompt_cache_hit_tokens === 'number'
        ? raw.prompt_cache_hit_tokens
        : 0
  const reasoning =
    isObject(raw.completion_tokens_details) &&
    typeof raw.completion_tokens_details.reasoning_tokens === 'number'
      ? raw.completion_tokens_details.reasoning_tokens
      : 0
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : prompt + completion,
  }
}

// ─────────────────────────── 流式 ───────────────────────────

const encoder = new TextEncoder()

/**
 * 把上游的 Chat SSE 流**逐帧**转成 Responses SSE 事件流。
 */
export function toResponsesSse(
  upstreamBody: ReadableStream<Uint8Array>,
  request: ResponsesRequest,
  model: string,
  responseId: string,
  precomputedToolMeta?: ResponsesToolMeta,
): ReadableStream<Uint8Array> {
  const toolMeta = precomputedToolMeta ?? buildResponsesToolMeta(request.tools)
  let sequence = 0

  let buffer = ''
  const items: Item[] = []
  let msgItem: Item | undefined
  let reasonItem: Item | undefined
  const calls = new Map<number, Item>()
  let usage: Record<string, unknown> | null = null
  let finishReason: string | null = null
  let sawAny = false
  let failed = false

  const emit = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`

  const snapshot = (
    status: string,
    err: Record<string, unknown> | null = null,
  ): Record<string, unknown> => ({
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: err,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model,
    output:
      status === 'in_progress'
        ? []
        : outputOf(items, status === 'incomplete' ? 'incomplete' : 'completed'),
    parallel_tool_calls: request.parallel_tool_calls === false ? false : true,
    previous_response_id: null,
    reasoning: {
      effort: isObject(request.reasoning) ? request.reasoning.effort ?? null : null,
      summary: null,
    },
    store: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: status === 'in_progress' ? null : usageOf(usage),
    user: typeof request.user === 'string' ? request.user : null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  })

  const openMessage = (): string[] => {
    if (msgItem !== undefined) return []
    const item: Item = {
      kind: 'message',
      id: hexId('msg'),
      outputIndex: items.length,
      text: '',
      callId: '',
      name: '',
      args: '',
    }
    msgItem = item
    items.push(item)
    return [
      emit('response.output_item.added', {
        output_index: item.outputIndex,
        item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }),
      emit('response.content_part.added', {
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ]
  }

  const openReasoning = (): string[] => {
    if (reasonItem !== undefined) return []
    const item: Item = {
      kind: 'reasoning',
      id: hexId('rs'),
      outputIndex: items.length,
      text: '',
      callId: '',
      name: '',
      args: '',
    }
    reasonItem = item
    items.push(item)
    return [
      emit('response.output_item.added', {
        output_index: item.outputIndex,
        item: { id: item.id, type: 'reasoning', summary: [] },
      }),
      emit('response.reasoning_summary_part.added', {
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    ]
  }

  const closeMessage = (): string[] => {
    const it = msgItem
    if (it === undefined) return []
    msgItem = undefined
    const itemStatus = statusOf(finishReason)
    it.status = itemStatus
    return [
      emit('response.output_text.done', {
        item_id: it.id,
        output_index: it.outputIndex,
        content_index: 0,
        text: it.text,
        logprobs: [],
      }),
      emit('response.content_part.done', {
        item_id: it.id,
        output_index: it.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: it.text, annotations: [] },
      }),
      emit('response.output_item.done', {
        output_index: it.outputIndex,
        item: {
          id: it.id,
          type: 'message',
          status: itemStatus,
          role: 'assistant',
          content: [{ type: 'output_text', text: it.text, annotations: [] }],
        },
      }),
    ]
  }

  const closeReasoning = (): string[] => {
    const it = reasonItem
    if (it === undefined) return []
    reasonItem = undefined
    return [
      emit('response.reasoning_summary_text.done', {
        item_id: it.id,
        output_index: it.outputIndex,
        summary_index: 0,
        text: it.text,
      }),
      emit('response.reasoning_summary_part.done', {
        item_id: it.id,
        output_index: it.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: it.text },
      }),
      emit('response.output_item.done', {
        output_index: it.outputIndex,
        item: {
          id: it.id,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: it.text }],
        },
      }),
    ]
  }

  const announceToolItem = (it: Item): string[] => {
    if (it.opened) return []
    it.opened = true
    it.outputIndex = items.length
    if (it.callId === '') it.callId = hexId('call')
    items.push(it)
    const nsField =
      it.namespace !== undefined && it.namespace !== '' ? { namespace: it.namespace } : {}
    if (it.kind === 'custom_tool_call') {
      it.id = it.callId
      return [
        emit('response.output_item.added', {
          output_index: it.outputIndex,
          item: {
            id: it.id,
            type: 'custom_tool_call',
            status: 'in_progress',
            call_id: it.callId,
            name: it.name,
            ...nsField,
            input: '',
          },
        }),
      ]
    }
    return [
      emit('response.output_item.added', {
        output_index: it.outputIndex,
        item: {
          id: it.id,
          type: 'function_call',
          status: 'in_progress',
          call_id: it.callId,
          name: it.name,
          ...nsField,
          arguments: '',
        },
      }),
    ]
  }

  const closeCalls = (): string[] => {
    const out: string[] = []
    const defaultItemStatus = statusOf(finishReason)
    for (const [idx, it] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      calls.delete(idx)
      if (it.name === '') {
        // 始终没有工具名的残片不作为合法 item 发出
        continue
      }
      if (!it.opened) {
        out.push(...announceToolItem(it))
        if (it.kind === 'function_call' && it.args !== '') {
          out.push(
            emit('response.function_call_arguments.delta', {
              item_id: it.id,
              output_index: it.outputIndex,
              delta: it.args,
            }),
          )
        }
      }
      const nsField =
        it.namespace !== undefined && it.namespace !== '' ? { namespace: it.namespace } : {}
      if (it.kind === 'custom_tool_call') {
        const unwrapped = unwrapCustomToolInput(it.args)
        const itemStatus = unwrapped.ok ? defaultItemStatus : 'incomplete'
        it.input = unwrapped.input
        it.status = itemStatus
        if (unwrapped.ok && unwrapped.input !== '') {
          out.push(
            emit('response.custom_tool_call_input.delta', {
              item_id: it.id,
              output_index: it.outputIndex,
              delta: unwrapped.input,
            }),
          )
        }
        out.push(
          emit('response.custom_tool_call_input.done', {
            item_id: it.id,
            output_index: it.outputIndex,
            input: unwrapped.input,
          }),
          emit('response.output_item.done', {
            output_index: it.outputIndex,
            item: {
              id: it.id,
              type: 'custom_tool_call',
              status: itemStatus,
              call_id: it.callId,
              name: it.name,
              ...nsField,
              input: unwrapped.input,
            },
          }),
        )
        continue
      }

      it.status = defaultItemStatus
      out.push(
        emit('response.function_call_arguments.done', {
          item_id: it.id,
          output_index: it.outputIndex,
          arguments: it.args,
        }),
        emit('response.output_item.done', {
          output_index: it.outputIndex,
          item: {
            id: it.id,
            type: 'function_call',
            status: defaultItemStatus,
            call_id: it.callId,
            name: it.name,
            ...nsField,
            arguments: it.args,
          },
        }),
      )
    }
    return out
  }

  const applyDelta = (delta: Record<string, unknown>): string[] => {
    const out: string[] = []
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
    if (reasoning !== '') {
      out.push(...openReasoning())
      const it = reasonItem
      if (it !== undefined) {
        it.text += reasoning
        out.push(
          emit('response.reasoning_summary_text.delta', {
            item_id: it.id,
            output_index: it.outputIndex,
            summary_index: 0,
            delta: reasoning,
          }),
        )
      }
    }

    const rawContent = typeof delta.content === 'string' ? delta.content : ''
    const refusalDelta = typeof delta.refusal === 'string' ? delta.refusal : ''
    const content = rawContent !== '' ? rawContent : refusalDelta
    if (content !== '') {
      if (reasonItem !== undefined) out.push(...closeReasoning())
      out.push(...openMessage())
      const it = msgItem
      if (it !== undefined) {
        it.text += content
        out.push(
          emit('response.output_text.delta', {
            item_id: it.id,
            output_index: it.outputIndex,
            content_index: 0,
            delta: content,
            logprobs: [],
          }),
        )
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isObject(raw)) continue
        const idx = typeof raw.index === 'number' ? raw.index : 0
        const fn = isObject(raw.function) ? raw.function : {}
        let it = calls.get(idx)
        if (it === undefined) {
          if (msgItem !== undefined) out.push(...closeMessage())
          if (reasonItem !== undefined) out.push(...closeReasoning())
          it = {
            kind: 'function_call',
            id: hexId('fc'),
            outputIndex: -1,
            text: '',
            callId: nonEmptyString(raw.id) ?? '',
            name: '',
            args: '',
            opened: false,
          }
          calls.set(idx, it)
        }
        if (it.callId === '') {
          it.callId = nonEmptyString(raw.id) ?? ''
        }
        const rawName = nonEmptyString(fn.name)
        if (rawName !== undefined && it.name === '') {
          const resolved = toolMeta.fromTransportName(rawName)
          it.name = resolved.name
          if (resolved.namespace !== undefined) it.namespace = resolved.namespace
          it.kind = resolved.isCustom ? 'custom_tool_call' : 'function_call'
        }
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''

        if (!it.opened) {
          if (args !== '') it.args += args
          if (it.name !== '') {
            out.push(...announceToolItem(it))
            if (it.kind === 'function_call' && it.args !== '') {
              out.push(
                emit('response.function_call_arguments.delta', {
                  item_id: it.id,
                  output_index: it.outputIndex,
                  delta: it.args,
                }),
              )
            }
          }
          continue
        }

        if (args !== '') {
          it.args += args
          // custom_tool_call 的底层传输是 JSON 包裹 `{"input":"..."}`，需等完整到达解包后再发 input.delta
          if (it.kind === 'function_call') {
            out.push(
              emit('response.function_call_arguments.delta', {
                item_id: it.id,
                output_index: it.outputIndex,
                delta: args,
              }),
            )
          }
        }
      }
    }
    return out
  }

  const decoder = new TextDecoder()
  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(emit('response.created', { response: snapshot('in_progress') })))
        controller.enqueue(encoder.encode(emit('response.in_progress', { response: snapshot('in_progress') })))
      },
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (failed) continue

          const trimmed = line.trim()
          if (trimmed.startsWith(':')) {
            // 透传 SSE 注释心跳（如续写层 `: keepalive`），不占 sequence_number，防止 Codex 空闲断连
            controller.enqueue(encoder.encode(`${trimmed}\n\n`))
            continue
          }

          const frame = parseSseLine(line)
          if (frame.kind === 'done') continue
          if (frame.kind !== 'chunk' || frame.data === undefined) continue

          let parsed: Record<string, unknown>
          try {
            const obj = JSON.parse(frame.data) as unknown
            if (!isObject(obj)) continue
            parsed = obj
          } catch {
            continue
          }
          const errMsg = detectErrorFrame(parsed)
          if (errMsg !== undefined) {
            failed = true
            controller.enqueue(
              encoder.encode(
                emit('response.failed', {
                  response: snapshot('failed', { code: 'upstream_error', message: errMsg }),
                }),
              ),
            )
            continue
          }
          if (isObject(parsed.usage)) usage = parsed.usage
          const choices = Array.isArray(parsed.choices) ? parsed.choices : []
          for (const c of choices) {
            if (!isObject(c)) continue
            const fr = c.finish_reason
            if (typeof fr === 'string' && fr !== '') finishReason = fr
            const delta = isObject(c.delta) ? c.delta : undefined
            if (delta === undefined) continue
            sawAny = true
            for (const ev of applyDelta(delta)) controller.enqueue(encoder.encode(ev))
          }
        }
      },
      flush(controller) {
        if (failed) return
        const out: string[] = []
        out.push(...closeReasoning())
        out.push(...closeMessage())
        out.push(...closeCalls())
        if (items.length === 0) {
          out.push(...openMessage())
          if (msgItem !== undefined && !sawAny) {
            msgItem.text = '（上游未返回任何内容）'
          }
          out.push(...closeMessage())
        }
        const status = statusOf(finishReason)
        out.push(emit(`response.${status}`, { response: snapshot(status) }))
        for (const ev of out) controller.enqueue(encoder.encode(ev))
      },
    }),
  )
}

// ─────────────────────────── 入口 ───────────────────────────

/**
 * 处理 `POST /v1/responses`。
 */
export async function handleResponses(
  request: Request,
  env: Env,
  realm = 'cn',
  ctx?: ExecutionContext,
): Promise<{ response: Response }> {
  let body: ResponsesRequest
  try {
    const parsed = await readJsonCapped(request)
    if (!isObject(parsed)) throw new ResponsesError('request body must be a JSON object')
    body = parsed as ResponsesRequest
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { response: errorJson(error.message, 413, 'payload_too_large') }
    }
    if (error instanceof ResponsesError) {
      return { response: errorJson(error.message, error.status) }
    }
    return { response: errorJson('请求体必须是合法 JSON') }
  }

  const model = nonEmptyString(body.model)
  if (model === undefined) return { response: errorJson('model 必填') }

  let toolMeta: ResponsesToolMeta
  let chatBody: Record<string, unknown>
  try {
    toolMeta = buildResponsesToolMeta(body.tools)
    chatBody = toChatBody(body, model)
  } catch (error) {
    if (error instanceof ResponsesError) return { response: errorJson(error.message, error.status) }
    return { response: errorJson(error instanceof Error ? error.message : String(error)) }
  }

  chatBody.stream = true

  // 托管网页工具（web_search / web_fetch）由网关执行预检索后注入上下文。
  const serverTools = detectServerWebTools(body.tools)
  if (serverTools.search || serverTools.fetch) {
    const webContext = await buildWebToolContext({
      search: serverTools.search,
      fetch: serverTools.fetch,
      text: lastUserTextFromResponses(body.input),
      env,
      ctx,
      signal: request.signal,
    })
    if (webContext !== undefined && Array.isArray(chatBody.messages)) {
      chatBody.messages = [{ role: 'system', content: webContext }, ...(chatBody.messages as unknown[])]
    }
  }

  const wantsStream = body.stream === true
  const responseId = hexId('resp')

  const forwardHeaders: Record<string, string> = {
    'content-type': 'application/json',
  }
  const pinnedAccount = request.headers.get('x-flr-account')
  if (pinnedAccount !== null && pinnedAccount.trim() !== '') {
    forwardHeaders['x-flr-account'] = pinnedAccount.trim()
  }
  const clientIp = request.headers.get('cf-connecting-ip')
  if (clientIp !== null && clientIp.trim() !== '') {
    forwardHeaders['cf-connecting-ip'] = clientIp.trim()
  }

  const chatRequest = new Request(new URL('/v1/chat/completions', request.url), {
    method: 'POST',
    headers: forwardHeaders,
    signal: request.signal,
    body: JSON.stringify(chatBody),
  })
  const inner = await handleChatCompletions(chatRequest, env, realm, ctx)

  if (!inner.response.ok || inner.response.body === null) {
    const text = await inner.response.text().catch(() => '')
    let message = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string') message = parsed.error.message
    } catch {
      // 非 JSON：保留原文
    }
    return {
      response: errorJson(message || `上游返回 HTTP ${inner.response.status}`, inner.response.status),
    }
  }

  if (wantsStream) {
    return {
      response: new Response(toResponsesSse(inner.response.body, body, model, responseId, toolMeta), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      }),
    }
  }

  const reader = inner.response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 忽略 */
    }
  }

  const aggregated = aggregateSse(raw, { model, now: Date.now() })

  const upstreamError = findErrorFrameInRaw(raw)
  if (upstreamError !== undefined) {
    return { response: errorJson(upstreamError, 502) }
  }
  if (isEmptyAssistantTurn(aggregated.choices[0])) {
    const snippet = raw.trim().slice(0, 200)
    return {
      response: errorJson(
        '上游返回了空响应（既没有正文/思考内容，也没有可识别的错误帧）。' +
          '这通常意味着上游临时拒绝或该模型不可用，请稍后重试。' +
          (snippet === '' ? '' : `上游原文片段：${snippet}`),
        502,
      ),
    }
  }

  return {
    response: Response.json(toResponsesObject(body, model, aggregated, responseId, toolMeta), {
      headers: { 'cache-control': 'no-store' },
    }),
  }
}

/** 错误响应（Responses 风格的 error 对象）。 */
function errorJson(message: string, status = 400, type = 'invalid_request_error'): Response {
  return Response.json({ error: { message, type } }, { status })
}
