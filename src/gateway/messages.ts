/**
 * **Anthropic Messages API** 原生入站适配（`POST /v1/messages` 与 `POST /v1/messages/count_tokens`）。
 *
 * ## 设计策略：与 `responses.ts` 完全同构，复用 `handleChatCompletions`
 *
 * ```
 * Anthropic Messages 请求 ──messagesToChatBody()──▶ Chat Completions 请求
 *                                                         │
 *                                            handleChatCompletions()  ← 选号/轮转/冷却/子密钥记账/防封全复用
 *                                                         │
 *                   ┌─────────────────────────────────────┴─────────────────────────────────────┐
 *                   ▼                                                                           ▼
 *   非流式：aggregateSse() → toAnthropicMessage()                              流式：toAnthropicSse()
 * ```
 *
 * 依据与社区参考：
 * - `misakano7545/workbuddy2api-panel`（`internal/server/messages.go` 及提交 `fa4d62c` 结构化输出映射）
 * - 本项目 `src/gateway/responses.ts` 与 `src/gateway/stream.ts` 的零整包缓冲纪律
 *
 * ## 关键协议差异（必守）
 *
 * 1. **Usage 口径与 Responses 相反**：Anthropic 官方规范中 `usage.input_tokens` **不含**缓存命中/写入，
 *    缓存命中单列在 `cache_read_input_tokens`。Claude Code 用 `input_tokens + cache_read_input_tokens`
 *    计算总上下文占用，若不扣除缓存命中，上下文占用会被虚抬一倍导致过早触发压缩。
 * 2. **工具结果内嵌图片**：Chat Completions 的 `role: 'tool'` 消息不允许携带 `image_url` 分块；
 *    直接拼 base64 字符串既消耗巨量 token 又无法触发视觉编码。故拆出文本留给 `role: 'tool'`，
 *    待同批连续 `tool_result` 全部落地后紧跟一条 `role: 'user'` 视觉附件消息（避免插在并行
 *    工具结果中间触发上游 `11148` 配对断裂错误）。
 */

import { BodyTooLargeError, readJsonCapped } from './body.js'
import {
  aggregateSse,
  detectErrorFrame,
  findErrorFrameInRaw,
  isEmptyAssistantTurn,
  parseSseLine,
  sseHeaders,
  type AggregatedCompletion,
} from './stream.js'
import { handleChatCompletions } from './server.js'
import type { Env } from '../env.js'

// ─────────────────────────── 类型与基础工具 ───────────────────────────

/** Anthropic `/v1/messages` 请求体（声明我们会读取的字段）。 */
export interface MessagesRequest {
  model?: unknown
  messages?: unknown
  system?: unknown
  max_tokens?: unknown
  stop_sequences?: unknown
  stream?: unknown
  temperature?: unknown
  top_p?: unknown
  top_k?: unknown
  tools?: unknown
  tool_choice?: unknown
  thinking?: unknown
  output_config?: unknown
  metadata?: unknown
  user?: unknown
}

/** 请求转换错误（由入口映射为 Anthropic 标准错误响应）。 */
export class MessagesError extends Error {
  readonly status: number
  readonly errorType: string
  constructor(message: string, status = 400, errorType = 'invalid_request_error') {
    super(message)
    this.name = 'MessagesError'
    this.status = status
    this.errorType = errorType
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function positiveInt(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new MessagesError(`${field} must be a positive integer`)
  }
  return v
}

function hexId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${s}`
}

function formatMessageId(rawId: string | undefined): string {
  const trimmed = rawId?.trim() ?? ''
  if (trimmed === '') return hexId('msg')
  return trimmed.startsWith('msg_') ? trimmed : `msg_${trimmed}`
}

/** HTTP 状态码 → Anthropic 官方 `error.type`。 */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 413:
      return 'request_too_large'
    case 429:
      return 'rate_limit_error'
    case 503:
    case 529:
      return 'overloaded_error'
    default:
      return 'api_error'
  }
}

/** 构造 Anthropic 标准错误 JSON 响应。 */
export function anthropicErrorJson(
  message: string,
  status = 400,
  errorType = anthropicErrorType(status),
): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: errorType,
        message,
      },
    },
    {
      status,
      headers: { 'cache-control': 'no-store' },
    },
  )
}

// ─────────────────────────── 入站请求转换 ───────────────────────────

/** 提取顶层 `system`（支持纯字符串或 text block 数组）。 */
function extractSystemText(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  const parts: string[] = []
  for (const raw of system) {
    if (!isObject(raw)) continue
    if (typeof raw.text === 'string' && raw.text !== '') {
      parts.push(raw.text)
    }
  }
  return parts.join('\n')
}

/**
 * Anthropic `image` 内容块 → OpenAI `image_url` 内容块。
 *
 * ⚠️ 安全红线：对于 `url` 类型只原样透传字符串，**绝不在网关侧主动发起下载**（防 SSRF）。
 */
function imageBlockToChatPart(block: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = block.source
  if (isObject(source)) {
    const srcType = typeof source.type === 'string' ? source.type.trim().toLowerCase() : ''
    if (srcType === 'base64') {
      const data = nonEmptyString(source.data)
      if (data === undefined) throw new MessagesError('image base64 source requires non-empty data')
      const mediaType = nonEmptyString(source.media_type) ?? 'image/png'
      return {
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${data}` },
      }
    }
    if (srcType === 'url') {
      const url = nonEmptyString(source.url)
      if (url === undefined) throw new MessagesError('image url source requires non-empty url')
      return {
        type: 'image_url',
        image_url: { url },
      }
    }
  }
  // 兼容混合客户端直接传入 image_url 字段的情形
  const directUrl = isObject(block.image_url)
    ? nonEmptyString(block.image_url.url)
    : nonEmptyString(block.image_url) ?? nonEmptyString(block.url)
  if (directUrl !== undefined) {
    return {
      type: 'image_url',
      image_url: { url: directUrl },
    }
  }
  return undefined
}

/** 提取 `document` 块的文本表示。 */
function extractDocumentText(block: Record<string, unknown>): string {
  const title = nonEmptyString(block.title) ?? ''
  const source = isObject(block.source) ? block.source : undefined
  let body = ''
  if (source !== undefined) {
    const srcType = typeof source.type === 'string' ? source.type : ''
    if (srcType === 'text') {
      body = typeof source.data === 'string' ? source.data : ''
    } else if (srcType === 'content') {
      body = flattenContentToText(source.content)
    } else if (srcType === 'base64') {
      const media = nonEmptyString(source.media_type) ?? 'application/octet-stream'
      body = `[document ${media} omitted]`
    } else if (srcType === 'url') {
      body = typeof source.url === 'string' ? source.url : ''
    }
  }
  if (title !== '' && body !== '') return `${title}\n${body}`
  return title !== '' ? title : body
}

function extractBlockText(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text
  if (typeof block.thinking === 'string') return block.thinking
  if ('content' in block) return flattenContentToText(block.content)
  return ''
}

function flattenContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const item of content) {
      if (!isObject(item)) continue
      const t = typeof item.type === 'string' ? item.type : ''
      if (t === 'document') out += extractDocumentText(item)
      else if (t !== 'image') out += extractBlockText(item)
    }
    return out
  }
  if (isObject(content)) {
    if ('type' in content) return extractBlockText(content)
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return content === null || content === undefined ? '' : String(content)
}

/**
 * 拆分 `tool_result.content` 为纯文本与附带的图片块列表。
 *
 * Chat 的 `role: 'tool'` 消息不支持图片数组，必须将图片剥出并在整批 `tool_result`
 * 之后作为一条合成 `user` 消息附上。
 */
function splitToolResultContent(content: unknown): {
  text: string
  images: Array<Record<string, unknown>>
} {
  if (!Array.isArray(content)) {
    return { text: flattenContentToText(content), images: [] }
  }
  const texts: string[] = []
  const images: Array<Record<string, unknown>> = []
  for (const item of content) {
    if (!isObject(item)) continue
    const t = typeof item.type === 'string' ? item.type : ''
    if (t === 'image' || t === 'image_url') {
      const img = imageBlockToChatPart(item)
      if (img !== undefined) images.push(img)
      continue
    }
    if (t === 'document') {
      texts.push(extractDocumentText(item))
      continue
    }
    texts.push(extractBlockText(item))
  }
  return { text: texts.join(''), images }
}

function serializeToolArguments(input: unknown): string {
  if (typeof input === 'string') return input !== '' ? input : '{}'
  if (input === undefined || input === null) return '{}'
  try {
    return JSON.stringify(input) ?? '{}'
  } catch {
    return '{}'
  }
}

function hasToolResultBlock(blocks: unknown[]): boolean {
  for (const b of blocks) {
    if (isObject(b) && b.type === 'tool_result') return true
  }
  return false
}

/** 将 Anthropic `messages` 数组转换为 Chat `messages` 数组。 */
function convertAnthropicMessages(rawMessages: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let pendingToolImages: Array<Record<string, unknown>> = []

  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    out.push({
      role: 'user',
      content: pendingToolImages,
    })
    pendingToolImages = []
  }

  for (const entry of rawMessages) {
    if (!isObject(entry)) {
      throw new MessagesError('each message entry must be an object')
    }
    const role = nonEmptyString(entry.role) ?? 'user'
    if (role !== 'user' && role !== 'assistant') {
      throw new MessagesError(`unsupported message role: ${role}`)
    }

    const rawContent = entry.content
    if (typeof rawContent === 'string') {
      flushToolImages()
      out.push({ role, content: rawContent })
      continue
    }

    if (!Array.isArray(rawContent)) {
      if (rawContent === undefined || rawContent === null) {
        flushToolImages()
        out.push({ role, content: '' })
        continue
      }
      throw new MessagesError('message content must be a string or an array of blocks')
    }

    if (!hasToolResultBlock(rawContent)) {
      flushToolImages()
    }

    const toolMsgs: Array<Record<string, unknown>> = []
    const currentToolImgs: Array<Record<string, unknown>> = []
    const toolCalls: Array<Record<string, unknown>> = []
    const thinkingParts: string[] = []
    const textParts: string[] = []
    const userParts: Array<Record<string, unknown>> = []
    let hasNonText = false

    for (const rawBlock of rawContent) {
      if (!isObject(rawBlock)) continue
      const blockType = typeof rawBlock.type === 'string' ? rawBlock.type : 'text'

      if (blockType === 'thinking') {
        const thinkingText = typeof rawBlock.thinking === 'string' ? rawBlock.thinking : ''
        if (thinkingText !== '') thinkingParts.push(thinkingText)
        continue
      }
      if (blockType === 'redacted_thinking') {
        // 加密思考块无明文语义，跳过不报错
        continue
      }
      if (blockType === 'tool_use' || blockType === 'server_tool_use') {
        const name = nonEmptyString(rawBlock.name)
        if (name === undefined) throw new MessagesError('tool_use block requires name')
        const id = nonEmptyString(rawBlock.id) ?? hexId('toolu')
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name,
            arguments: serializeToolArguments(rawBlock.input),
          },
        })
        continue
      }
      if (blockType === 'tool_result') {
        const toolUseId = nonEmptyString(rawBlock.tool_use_id) ?? nonEmptyString(rawBlock.id)
        if (toolUseId === undefined) throw new MessagesError('tool_result block requires tool_use_id')
        const split = splitToolResultContent(rawBlock.content)
        let text = split.text
        if (rawBlock.is_error === true) {
          text = text !== '' ? `error: ${text}` : 'error'
        } else if (text === '' && split.images.length > 0) {
          text = '[tool result image attached in following user message]'
        }
        toolMsgs.push({
          role: 'tool',
          tool_call_id: toolUseId,
          content: text,
        })
        if (split.images.length > 0) {
          currentToolImgs.push(
            { type: 'text', text: `[image from tool result ${toolUseId}]` },
            ...split.images,
          )
        }
        continue
      }
      if (blockType === 'image' || blockType === 'image_url') {
        const img = imageBlockToChatPart(rawBlock)
        if (img !== undefined) {
          hasNonText = true
          userParts.push(img)
        }
        continue
      }
      if (blockType === 'document') {
        const docText = extractDocumentText(rawBlock)
        hasNonText = true
        textParts.push(docText)
        userParts.push({ type: 'text', text: docText })
        continue
      }

      // 默认按文本块处理（含 type === 'text' 及未知扩展块）
      const t = extractBlockText(rawBlock)
      textParts.push(t)
      userParts.push({ type: 'text', text: t })
    }

    if (toolMsgs.length > 0) {
      out.push(...toolMsgs)
      if (currentToolImgs.length > 0) {
        pendingToolImages.push(...currentToolImgs)
      }
    }

    const hasOwnBody =
      toolCalls.length > 0 || thinkingParts.length > 0 || textParts.length > 0 || hasNonText
    if (!hasOwnBody) continue

    // 同一条消息里既有 tool_result 又有后续用户文本/图片时，先落工具图片再落用户正文，
    // 保证所有 role:'tool' 消息紧挨着前一条 assistant.tool_calls。
    flushToolImages()

    if (role === 'assistant') {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: textParts.join(''),
      }
      if (thinkingParts.length > 0) {
        msg.reasoning_content = thinkingParts.join('\n')
      }
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls
      }
      out.push(msg)
    } else {
      out.push({
        role: 'user',
        content: hasNonText ? userParts : textParts.join(''),
      })
    }
  }

  flushToolImages()
  return out
}

/** Anthropic `tools` → Chat `tools`（同时收集上游不支持的托管服务端工具名）。 */
function convertAnthropicTools(rawTools: unknown): {
  tools: Array<Record<string, unknown>> | undefined
  skippedServerTools: string[]
} {
  if (rawTools === undefined || rawTools === null) {
    return { tools: undefined, skippedServerTools: [] }
  }
  if (!Array.isArray(rawTools)) {
    throw new MessagesError('tools must be an array')
  }
  const out: Array<Record<string, unknown>> = []
  const skippedServerTools: string[] = []

  for (const item of rawTools) {
    if (!isObject(item)) continue
    if (isObject(item.function)) {
      out.push(item)
      continue
    }
    if (!('input_schema' in item)) {
      const label = nonEmptyString(item.name) ?? nonEmptyString(item.type)
      if (label !== undefined) skippedServerTools.push(label)
      continue
    }
    const name = nonEmptyString(item.name)
    if (name === undefined) continue
    const fn: Record<string, unknown> = {
      name,
      description: typeof item.description === 'string' ? item.description : '',
      parameters: isObject(item.input_schema)
        ? item.input_schema
        : { type: 'object', properties: {} },
    }
    out.push({ type: 'function', function: fn })
  }

  return {
    tools: out.length > 0 ? out : undefined,
    skippedServerTools,
  }
}

/** Anthropic `tool_choice` → Chat `tool_choice` + `parallel_tool_calls`。 */
function convertAnthropicToolChoice(rawChoice: unknown): {
  toolChoice?: unknown
  parallelToolCalls?: boolean
} {
  if (rawChoice === undefined || rawChoice === null) return {}
  if (typeof rawChoice === 'string') {
    const lower = rawChoice.trim().toLowerCase()
    if (lower === 'any') return { toolChoice: 'required' }
    if (lower === 'auto' || lower === 'none' || lower === 'required') {
      return { toolChoice: lower }
    }
    return {}
  }
  if (!isObject(rawChoice)) return {}

  const result: { toolChoice?: unknown; parallelToolCalls?: boolean } = {}
  if (rawChoice.disable_parallel_tool_use === true) {
    result.parallelToolCalls = false
  }
  const kind = typeof rawChoice.type === 'string' ? rawChoice.type.trim().toLowerCase() : ''
  switch (kind) {
    case 'auto':
      result.toolChoice = 'auto'
      break
    case 'any':
      result.toolChoice = 'required'
      break
    case 'none':
      result.toolChoice = 'none'
      break
    case 'tool': {
      const name = nonEmptyString(rawChoice.name)
      if (name === undefined) throw new MessagesError('tool_choice of type "tool" requires name')
      result.toolChoice = { type: 'function', function: { name } }
      break
    }
    default:
      break
  }
  return result
}

/**
 * Anthropic `thinking` + `output_config.effort` → Chat `thinking` 与 `reasoning_effort`。
 *
 * `budget_tokens` 分档对齐社区 Hermes / workbuddy2api-panel 口径：
 * `>=32000 → xhigh`、`>=16000 → high`、`>=8000 → medium`、`<8000 → low`。
 */
function convertAnthropicThinking(body: MessagesRequest): {
  thinking?: Record<string, unknown>
  reasoningEffort?: string
} {
  const outputEffort = isObject(body.output_config)
    ? nonEmptyString(body.output_config.effort)
    : undefined

  if (!isObject(body.thinking)) {
    return outputEffort !== undefined ? { reasoningEffort: outputEffort } : {}
  }

  const kind = typeof body.thinking.type === 'string' ? body.thinking.type.trim().toLowerCase() : ''
  if (kind === 'disabled') {
    return {
      thinking: { type: 'disabled' },
      reasoningEffort: 'none',
    }
  }
  if (kind === 'enabled') {
    if (outputEffort !== undefined) {
      return { thinking: { type: 'enabled' }, reasoningEffort: outputEffort }
    }
    const budget = body.thinking.budget_tokens
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
      const tier =
        budget >= 32_000
          ? 'xhigh'
          : budget >= 16_000
            ? 'high'
            : budget >= 8_000
              ? 'medium'
              : 'low'
      return { thinking: { type: 'enabled' }, reasoningEffort: tier }
    }
    return { thinking: { type: 'enabled' } }
  }
  if (outputEffort !== undefined) {
    return { reasoningEffort: outputEffort }
  }
  return {}
}

/**
 * Anthropic `output_config.format` → Chat `response_format`（结构化输出，对齐 `fa4d62c`）。
 */
function convertOutputFormat(body: MessagesRequest): Record<string, unknown> | undefined {
  if (!isObject(body.output_config) || !isObject(body.output_config.format)) {
    return undefined
  }
  const fmt = body.output_config.format
  const kind = typeof fmt.type === 'string' ? fmt.type.trim().toLowerCase() : ''
  if (kind === 'json_schema') {
    if (!isObject(fmt.schema)) {
      throw new MessagesError('output_config.format of type "json_schema" requires an object schema')
    }
    return {
      type: 'json_schema',
      json_schema: {
        name: nonEmptyString(fmt.name) ?? 'response',
        strict: typeof fmt.strict === 'boolean' ? fmt.strict : true,
        schema: fmt.schema,
      },
    }
  }
  if (kind === 'json_object') return { type: 'json_object' }
  if (kind === 'text') return { type: 'text' }
  return undefined
}

/**
 * 将入站 Anthropic Messages 请求体转换为内部 Chat Completions 请求体。
 */
export function messagesToChatBody(body: MessagesRequest, model: string): Record<string, unknown> {
  if (!Array.isArray(body.messages)) {
    throw new MessagesError('messages must be an array')
  }

  const chatMessages: Array<Record<string, unknown>> = []
  const system = extractSystemText(body.system)
  if (system !== '') {
    chatMessages.push({ role: 'system', content: system })
  }

  const { tools, skippedServerTools } = convertAnthropicTools(body.tools)
  if (skippedServerTools.length > 0) {
    chatMessages.push({
      role: 'system',
      content: `These Anthropic server tools are not available here: ${skippedServerTools.join(', ')}. Do not call them.`,
    })
  }

  const converted = convertAnthropicMessages(body.messages)
  chatMessages.push(...converted)

  if (chatMessages.length === 0) {
    throw new MessagesError('messages contains no usable message')
  }

  const chat: Record<string, unknown> = {
    model,
    messages: chatMessages,
  }

  const maxTokens = positiveInt(body.max_tokens, 'max_tokens')
  if (maxTokens !== undefined) {
    chat.max_tokens = maxTokens
  }

  if (tools !== undefined) {
    chat.tools = tools
  }

  const { toolChoice, parallelToolCalls } = convertAnthropicToolChoice(body.tool_choice)
  if (toolChoice !== undefined) chat.tool_choice = toolChoice
  if (parallelToolCalls !== undefined) chat.parallel_tool_calls = parallelToolCalls

  const { thinking, reasoningEffort } = convertAnthropicThinking(body)
  if (thinking !== undefined) chat.thinking = thinking
  if (reasoningEffort !== undefined) chat.reasoning_effort = reasoningEffort

  const responseFormat = convertOutputFormat(body)
  if (responseFormat !== undefined) {
    chat.response_format = responseFormat
  }

  if (Array.isArray(body.stop_sequences)) {
    const stops = body.stop_sequences.filter((s): s is string => typeof s === 'string' && s !== '')
    if (stops.length > 0) chat.stop = stops
  }

  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    chat.temperature = body.temperature
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) {
    chat.top_p = body.top_p
  }

  const userId = isObject(body.metadata)
    ? nonEmptyString(body.metadata.user_id)
    : nonEmptyString(body.user)
  if (userId !== undefined) {
    chat.user = userId
  }

  return chat
}

// ─────────────────────────── 出站响应转换 ───────────────────────────

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'stop_sequence'
  | 'refusal'

/** 上游 `finish_reason` → Anthropic `stop_reason`。 */
export function toAnthropicStopReason(
  finishReason: string | null | undefined,
  hasToolCalls = false,
): AnthropicStopReason {
  const fr = typeof finishReason === 'string' ? finishReason.trim().toLowerCase() : ''
  if (fr === 'length' || fr === 'max_tokens') return 'max_tokens'
  if (fr === 'tool_calls' || fr === 'function_call' || hasToolCalls) return 'tool_use'
  if (fr === 'stop_sequence') return 'stop_sequence'
  if (fr === 'content_filter') return 'refusal'
  return 'end_turn'
}

/**
 * 上游 Chat `usage` → Anthropic `usage`。
 *
 * ⚠️ Claude 口径：`input_tokens` **不含**缓存读/写命中；命中部分放入 `cache_read_input_tokens`。
 */
export function toAnthropicUsage(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) {
    return { input_tokens: 0, output_tokens: 0 }
  }
  const prompt = typeof raw.prompt_tokens === 'number' && Number.isFinite(raw.prompt_tokens)
    ? raw.prompt_tokens
    : typeof raw.input_tokens === 'number' && Number.isFinite(raw.input_tokens)
      ? raw.input_tokens
      : 0
  const completion = typeof raw.completion_tokens === 'number' && Number.isFinite(raw.completion_tokens)
    ? raw.completion_tokens
    : typeof raw.output_tokens === 'number' && Number.isFinite(raw.output_tokens)
      ? raw.output_tokens
      : 0

  const promptDetails = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const cacheReadRaw =
    typeof raw.cache_read_input_tokens === 'number'
      ? raw.cache_read_input_tokens
      : typeof raw.prompt_cache_hit_tokens === 'number'
        ? raw.prompt_cache_hit_tokens
        : promptDetails !== undefined && typeof promptDetails.cached_tokens === 'number'
          ? promptDetails.cached_tokens
          : undefined
  const cacheWriteRaw =
    typeof raw.cache_creation_input_tokens === 'number'
      ? raw.cache_creation_input_tokens
      : typeof raw.prompt_cache_write_tokens === 'number'
        ? raw.prompt_cache_write_tokens
        : undefined

  const cacheRead = typeof cacheReadRaw === 'number' && cacheReadRaw > 0 ? cacheReadRaw : 0
  const cacheWrite = typeof cacheWriteRaw === 'number' && cacheWriteRaw > 0 ? cacheWriteRaw : 0
  // 若入参已是纯 input_tokens（无 prompt_tokens），不再重复扣减
  const inputTokens = typeof raw.prompt_tokens === 'number'
    ? Math.max(0, prompt - cacheRead - cacheWrite)
    : Math.max(0, prompt)

  const usage: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: Math.max(0, completion),
  }
  if (cacheRead > 0 || typeof raw.cache_read_input_tokens === 'number') {
    usage.cache_read_input_tokens = cacheRead
  }
  if (cacheWrite > 0 || typeof raw.cache_creation_input_tokens === 'number') {
    usage.cache_creation_input_tokens = cacheWrite
  }
  return usage
}

/** 将工具参数字符串解析为 Anthropic `tool_use.input` 对象（协议要求必须是字典对象）。 */
function parseToolUseInput(rawArgs: unknown): Record<string, unknown> {
  if (isObject(rawArgs)) return rawArgs
  if (typeof rawArgs !== 'string' || rawArgs.trim() === '') return {}
  try {
    const parsed = JSON.parse(rawArgs) as unknown
    if (isObject(parsed)) return parsed
    if (parsed === null || parsed === undefined) return {}
    return { value: parsed }
  } catch {
    return { raw: rawArgs }
  }
}

/**
 * 从非流式聚合结果构造 Anthropic `message` 响应对象。
 */
export function toAnthropicMessage(
  model: string,
  aggregated: AggregatedCompletion,
  fallbackId?: string,
): Record<string, unknown> {
  const choice = aggregated.choices[0]
  const message = choice?.message
  const content: Array<Record<string, unknown>> = []

  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
  if (reasoning !== '') {
    content.push({ type: 'thinking', thinking: reasoning })
  }

  const rawText = typeof message?.content === 'string' ? message.content : ''
  const refusal = typeof message?.refusal === 'string' ? message.refusal : ''
  const visibleText = rawText !== '' ? rawText : refusal

  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const toolBlocks: Array<Record<string, unknown>> = []

  if (isObject(message?.function_call)) {
    const legacyName = nonEmptyString(message.function_call.name)
    if (legacyName !== undefined) {
      toolBlocks.push({
        type: 'tool_use',
        id: hexId('toolu'),
        name: legacyName,
        input: parseToolUseInput(message.function_call.arguments),
      })
    }
  }

  for (const call of rawCalls) {
    if (!isObject(call)) continue
    const fn = isObject(call.function) ? call.function : {}
    const name = nonEmptyString(fn.name)
    if (name === undefined) continue
    toolBlocks.push({
      type: 'tool_use',
      id: nonEmptyString(call.id) ?? hexId('toolu'),
      name,
      input: parseToolUseInput(fn.arguments),
    })
  }

  if (visibleText !== '' || (reasoning === '' && toolBlocks.length === 0)) {
    content.push({ type: 'text', text: visibleText })
  }
  content.push(...toolBlocks)

  const id = formatMessageId(nonEmptyString(aggregated.id) ?? fallbackId)

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toAnthropicStopReason(choice?.finish_reason, toolBlocks.length > 0),
    stop_sequence: null,
    usage: toAnthropicUsage(aggregated.usage),
  }
}

// ─────────────────────────── 流式 SSE 转换 ───────────────────────────

interface StreamToolAccumulator {
  index: number
  blockIndex: number
  id: string
  name: string
  pendingArgs: string
  opened: boolean
  closed: boolean
}

const encoder = new TextEncoder()

/**
 * 将上游 Chat Completions SSE 流逐帧转换为 Anthropic Messages SSE 事件流。
 *
 * 事件序列严格闭合：
 * `message_start` → (`content_block_start` → `content_block_delta`* → `content_block_stop`)* → `message_delta` → `message_stop`
 */
export function toAnthropicSse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  fallbackId?: string,
): ReadableStream<Uint8Array> {
  let buffer = ''
  let started = false
  let finished = false
  let failed = false
  let messageId = formatMessageId(fallbackId)
  let currentModel = model
  let finishReason: string | null = null
  let latestUsage: Record<string, unknown> | undefined

  let nextBlockIndex = 0
  let thinkingBlockIndex: number | undefined
  let textBlockIndex: number | undefined
  const tools = new Map<number, StreamToolAccumulator>()
  const toolOrder: number[] = []

  const emitEvent = (event: string, payload: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`

  const ensureMessageStart = (chunk?: Record<string, unknown>): string[] => {
    if (started) return []
    started = true
    if (chunk !== undefined) {
      const cid = nonEmptyString(chunk.id)
      if (cid !== undefined) messageId = formatMessageId(cid)
      const cmodel = nonEmptyString(chunk.model)
      if (cmodel !== undefined && model === '') currentModel = cmodel
    }
    return [
      emitEvent('message_start', {
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: currentModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]
  }

  const closeThinking = (): string[] => {
    if (thinkingBlockIndex === undefined) return []
    const idx = thinkingBlockIndex
    thinkingBlockIndex = undefined
    return [emitEvent('content_block_stop', { index: idx })]
  }

  const closeText = (): string[] => {
    if (textBlockIndex === undefined) return []
    const idx = textBlockIndex
    textBlockIndex = undefined
    return [emitEvent('content_block_stop', { index: idx })]
  }

  const closeOpenTools = (): string[] => {
    const out: string[] = []
    for (const tcIdx of toolOrder) {
      const acc = tools.get(tcIdx)
      if (acc === undefined || !acc.opened || acc.closed) continue
      acc.closed = true
      out.push(emitEvent('content_block_stop', { index: acc.blockIndex }))
    }
    return out
  }

  const openThinking = (): string[] => {
    if (thinkingBlockIndex !== undefined) return []
    const out: string[] = []
    out.push(...closeText())
    out.push(...closeOpenTools())
    const idx = nextBlockIndex++
    thinkingBlockIndex = idx
    out.push(
      emitEvent('content_block_start', {
        index: idx,
        content_block: { type: 'thinking', thinking: '' },
      }),
    )
    return out
  }

  const openText = (): string[] => {
    if (textBlockIndex !== undefined) return []
    const out: string[] = []
    out.push(...closeThinking())
    out.push(...closeOpenTools())
    const idx = nextBlockIndex++
    textBlockIndex = idx
    out.push(
      emitEvent('content_block_start', {
        index: idx,
        content_block: { type: 'text', text: '' },
      }),
    )
    return out
  }

  const openTool = (acc: StreamToolAccumulator): string[] => {
    if (acc.opened) return []
    const out: string[] = []
    out.push(...closeThinking())
    out.push(...closeText())
    // 若前一个不同槽位的工具块仍开着，先将其闭合，保证块序单调闭合不交叠
    for (const prevIdx of toolOrder) {
      if (prevIdx === acc.index) continue
      const prev = tools.get(prevIdx)
      if (prev !== undefined && prev.opened && !prev.closed) {
        prev.closed = true
        out.push(emitEvent('content_block_stop', { index: prev.blockIndex }))
      }
    }
    acc.opened = true
    acc.blockIndex = nextBlockIndex++
    if (acc.id === '') acc.id = hexId('toolu')
    out.push(
      emitEvent('content_block_start', {
        index: acc.blockIndex,
        content_block: {
          type: 'tool_use',
          id: acc.id,
          name: acc.name,
          input: {},
        },
      }),
    )
    if (acc.pendingArgs !== '') {
      out.push(
        emitEvent('content_block_delta', {
          index: acc.blockIndex,
          delta: { type: 'input_json_delta', partial_json: acc.pendingArgs },
        }),
      )
      acc.pendingArgs = ''
    }
    return out
  }

  const applyCarrier = (carrier: Record<string, unknown>): string[] => {
    const out: string[] = []

    const reasoning = typeof carrier.reasoning_content === 'string' ? carrier.reasoning_content : ''
    if (reasoning !== '') {
      out.push(...openThinking())
      if (thinkingBlockIndex !== undefined) {
        out.push(
          emitEvent('content_block_delta', {
            index: thinkingBlockIndex,
            delta: { type: 'thinking_delta', thinking: reasoning },
          }),
        )
      }
    }

    const rawText = typeof carrier.content === 'string' ? carrier.content : ''
    const refusal = typeof carrier.refusal === 'string' ? carrier.refusal : ''
    const text = rawText !== '' ? rawText : refusal
    if (text !== '') {
      out.push(...openText())
      if (textBlockIndex !== undefined) {
        out.push(
          emitEvent('content_block_delta', {
            index: textBlockIndex,
            delta: { type: 'text_delta', text },
          }),
        )
      }
    }

    if (Array.isArray(carrier.tool_calls)) {
      for (const rawTc of carrier.tool_calls) {
        if (!isObject(rawTc)) continue
        const tcIdx = typeof rawTc.index === 'number' ? rawTc.index : 0
        let acc = tools.get(tcIdx)
        if (acc === undefined) {
          acc = {
            index: tcIdx,
            blockIndex: -1,
            id: '',
            name: '',
            pendingArgs: '',
            opened: false,
            closed: false,
          }
          tools.set(tcIdx, acc)
          toolOrder.push(tcIdx)
        }
        const id = nonEmptyString(rawTc.id)
        if (id !== undefined) acc.id = id
        const fn = isObject(rawTc.function) ? rawTc.function : undefined
        const name = fn !== undefined ? nonEmptyString(fn.name) : undefined
        if (name !== undefined) acc.name = name
        const args = fn !== undefined && typeof fn.arguments === 'string' ? fn.arguments : ''

        if (!acc.opened) {
          if (args !== '') acc.pendingArgs += args
          // 工具名尚未到达时暂缓开块（防止发出 name:"" 的非法 tool_use 块）
          if (acc.name !== '') {
            out.push(...openTool(acc))
          }
        } else if (!acc.closed && args !== '') {
          out.push(
            emitEvent('content_block_delta', {
              index: acc.blockIndex,
              delta: { type: 'input_json_delta', partial_json: args },
            }),
          )
        }
      }
    }

    return out
  }

  const finalizeStream = (): string[] => {
    if (finished || failed) return []
    finished = true
    const out: string[] = []
    out.push(...ensureMessageStart())
    out.push(...closeThinking())
    out.push(...closeText())

    let validToolCount = 0
    for (const tcIdx of toolOrder) {
      const acc = tools.get(tcIdx)
      if (acc === undefined || acc.name === '') continue
      validToolCount += 1
      if (!acc.opened) {
        out.push(...openTool(acc))
      }
      if (!acc.closed) {
        acc.closed = true
        out.push(emitEvent('content_block_stop', { index: acc.blockIndex }))
      }
    }

    out.push(
      emitEvent('message_delta', {
        delta: {
          stop_reason: toAnthropicStopReason(finishReason, validToolCount > 0),
          stop_sequence: null,
        },
        usage: toAnthropicUsage(latestUsage),
      }),
    )
    out.push(emitEvent('message_stop', {}))
    return out
  }

  const processLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (finished || failed) return
    const trimmed = line.trim()
    if (trimmed === '') return
    // 透传上游 / 续写层的 SSE 保活注释帧（如 `: keepalive`），防客户端空闲超时断连
    if (trimmed.startsWith(':')) {
      controller.enqueue(encoder.encode(`${trimmed}\n\n`))
      return
    }

    const frame = parseSseLine(line)
    if (frame.kind === 'done') {
      for (const ev of finalizeStream()) {
        controller.enqueue(encoder.encode(ev))
      }
      return
    }
    if (frame.kind === 'error') {
      failed = true
      controller.enqueue(
        encoder.encode(
          emitEvent('error', {
            error: { type: 'api_error', message: frame.error ?? '非预期的上游 SSE 帧' },
          }),
        ),
      )
      return
    }
    if (frame.kind !== 'chunk' || frame.data === undefined) return

    let parsed: Record<string, unknown>
    try {
      const obj = JSON.parse(frame.data) as unknown
      if (!isObject(obj)) return
      parsed = obj
    } catch {
      return
    }

    const errMsg = detectErrorFrame(parsed)
    if (errMsg !== undefined) {
      failed = true
      controller.enqueue(
        encoder.encode(
          emitEvent('error', {
            error: { type: 'api_error', message: errMsg },
          }),
        ),
      )
      return
    }

    for (const ev of ensureMessageStart(parsed)) {
      controller.enqueue(encoder.encode(ev))
    }

    if (isObject(parsed.usage)) {
      latestUsage = parsed.usage
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    for (const rawChoice of choices) {
      if (!isObject(rawChoice)) continue
      const fr = rawChoice.finish_reason
      if (typeof fr === 'string' && fr !== '') {
        finishReason = fr
      }
      const carrier = isObject(rawChoice.delta)
        ? rawChoice.delta
        : isObject(rawChoice.message)
          ? rawChoice.message
          : undefined
      if (carrier !== undefined) {
        for (const ev of applyCarrier(carrier)) {
          controller.enqueue(encoder.encode(ev))
        }
      }
    }
  }

  const decoder = new TextDecoder()
  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          processLine(line, controller)
        }
      },
      flush(controller) {
        const tail = (buffer + decoder.decode()).trim()
        if (tail !== '') {
          processLine(tail, controller)
        }
        if (!finished && !failed) {
          for (const ev of finalizeStream()) {
            controller.enqueue(encoder.encode(ev))
          }
        }
      },
    }),
  )
}

// ─────────────────────────── Token 估算（count_tokens） ───────────────────────────

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const IMAGE_FIXED_TOKENS = 1600

function estimateStringTokens(text: string): number {
  if (text === '') return 0
  // data:image/...;base64,... 内联图片按固定 1600 token 计，避免把 MB 级 base64 当文本算爆上下文
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
    return IMAGE_FIXED_TOKENS
  }
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 轻量估算 Anthropic Messages 请求体的 `input_tokens`。
 *
 * - CJK 字符按 `1 字 ≈ 1 token`，其余字符按 `4 字符 ≈ 1 token`；
 * - 图片（`source.type === 'base64'` 或 `type === 'image'`）按每张固定 `1600` token 估算。
 */
export function estimateMessagesTokens(value: unknown): number {
  if (typeof value === 'string') return estimateStringTokens(value)
  if (Array.isArray(value)) {
    let sum = 0
    for (const item of value) sum += estimateMessagesTokens(item)
    return sum
  }
  if (isObject(value)) {
    if (value.type === 'image') return IMAGE_FIXED_TOKENS
    if (value.type === 'base64' && typeof value.data === 'string') return IMAGE_FIXED_TOKENS
    let sum = 0
    for (const [k, v] of Object.entries(value)) {
      if (k === 'model' || k === 'stream' || k === 'max_tokens' || k === 'type') continue
      if (k === 'data' && typeof v === 'string' && v.length > 256) {
        sum += IMAGE_FIXED_TOKENS
        continue
      }
      sum += estimateMessagesTokens(v)
    }
    return sum
  }
  return 0
}

// ─────────────────────────── HTTP 入口 ───────────────────────────

/**
 * 处理 `POST /v1/messages/count_tokens`（供 Claude Code 等客户端探测上下文长度决定是否触发压缩）。
 */
export async function handleMessagesCountTokens(
  request: Request,
): Promise<{ response: Response }> {
  let raw: unknown
  try {
    raw = await readJsonCapped(request)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { response: anthropicErrorJson(error.message, 413, 'request_too_large') }
    }
    return { response: anthropicErrorJson('请求体必须是合法 JSON', 400, 'invalid_request_error') }
  }

  if (!isObject(raw)) {
    return { response: anthropicErrorJson('request body must be a JSON object', 400, 'invalid_request_error') }
  }

  const estimated = estimateMessagesTokens(raw)
  const hasPayload =
    (Array.isArray(raw.messages) && raw.messages.length > 0) ||
    (typeof raw.system === 'string' && raw.system !== '') ||
    (Array.isArray(raw.system) && raw.system.length > 0)

  return {
    response: Response.json(
      { input_tokens: hasPayload ? Math.max(1, estimated) : estimated },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    ),
  }
}

/**
 * 处理 `POST /v1/messages`。
 *
 * 将入站 Anthropic 请求转换为内部 Chat Completions 请求并委托给 `handleChatCompletions`，
 * 完整复用选号、容灾、冷却、防封与子密钥记账。
 */
export async function handleMessages(
  request: Request,
  env: Env,
  realm = 'cn',
  ctx?: ExecutionContext,
): Promise<{ response: Response }> {
  let body: MessagesRequest
  try {
    const parsed = await readJsonCapped(request)
    if (!isObject(parsed)) {
      throw new MessagesError('request body must be a JSON object')
    }
    body = parsed as MessagesRequest
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { response: anthropicErrorJson(error.message, 413, 'request_too_large') }
    }
    if (error instanceof MessagesError) {
      return { response: anthropicErrorJson(error.message, error.status, error.errorType) }
    }
    return { response: anthropicErrorJson('请求体必须是合法 JSON', 400, 'invalid_request_error') }
  }

  const model = nonEmptyString(body.model)
  if (model === undefined) {
    return { response: anthropicErrorJson('model 必填', 400, 'invalid_request_error') }
  }

  let chatBody: Record<string, unknown>
  try {
    chatBody = messagesToChatBody(body, model)
  } catch (error) {
    if (error instanceof MessagesError) {
      return { response: anthropicErrorJson(error.message, error.status, error.errorType) }
    }
    return {
      response: anthropicErrorJson(
        error instanceof Error ? error.message : String(error),
        400,
        'invalid_request_error',
      ),
    }
  }

  // 上游只支持流式，与 handleResponses 同口径强制 stream = true，再按客户端 wantsStream 分流转换
  chatBody.stream = true
  const wantsStream = body.stream === true
  const fallbackMsgId = hexId('msg')

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
      if (typeof parsed.error?.message === 'string' && parsed.error.message !== '') {
        message = parsed.error.message
      }
    } catch {
      // 非 JSON：保留原文
    }
    return {
      response: anthropicErrorJson(
        message || `上游返回 HTTP ${inner.response.status}`,
        inner.response.status,
      ),
    }
  }

  if (wantsStream) {
    return {
      response: new Response(toAnthropicSse(inner.response.body, model, fallbackMsgId), {
        status: 200,
        headers: sseHeaders(),
      }),
    }
  }

  // 非流式：聚合上游 SSE 流并执行与 Chat / Responses 完全一致的流内错误与空回复守卫
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
      // 忽略
    }
  }

  const aggregated = aggregateSse(raw, { model, now: Date.now() })

  const upstreamError = findErrorFrameInRaw(raw)
  if (upstreamError !== undefined) {
    return { response: anthropicErrorJson(upstreamError, 502, 'api_error') }
  }
  if (isEmptyAssistantTurn(aggregated.choices[0])) {
    const snippet = raw.trim().slice(0, 200)
    return {
      response: anthropicErrorJson(
        '上游返回了空响应（既没有正文/思考内容，也没有可识别的错误帧）。' +
          '这通常意味着上游临时拒绝或该模型不可用，请稍后重试。' +
          (snippet === '' ? '' : `上游原文片段：${snippet}`),
        502,
        'api_error',
      ),
    }
  }

  return {
    response: Response.json(toAnthropicMessage(model, aggregated, fallbackMsgId), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    }),
  }
}
