/**
 * ModelScope（魔搭社区 API-Inference 免费推理池）供应商适配器。
 *
 * ## 协议与特性（参考 `zhuweiyou/codearts2api` / `dsh-providers-hub`）
 *
 * - 推理端点：`https://api-inference.modelscope.cn/v1`（OpenAI 兼容 `/models` 与 `/chat/completions`）；
 * - 算力豆余额：`https://www.modelscope.cn/openapi/v1/magicubes/balance`；
 * - 凭据形态：支持直接粘贴魔搭 SDK 访问令牌（`ms-...` 或 `modelscope:ms-...`），
 *   或 JSON 对象（`{ "provider": "modelscope", "accessToken": "ms-..." }` / `{ "MODELSCOPE_ACCESS_TOKEN": "..." }`），
 *   天然支持多账号轮转分摊魔搭单账号日调用配额（默认每日 2000 次免费推理）；
 * - 纯 Web Standard API（`fetch` / `Response` / `AbortSignal` / `TextEncoder`），100% 兼容 Cloudflare Workers 与 Node 22+。
 */

import { sseFrame } from './anthropic.js'
import { ProviderError } from './types.js'
import type {
  ChatRequest,
  Provider,
  ProviderBalance,
  ProviderCredential,
  ProviderModel,
} from './types.js'

export const MODELSCOPE_PROVIDER_ID = 'modelscope'
export const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1'
export const MODELSCOPE_BALANCE_URL = 'https://www.modelscope.cn/openapi/v1/magicubes/balance'
export const MODELSCOPE_REQUEST_TIMEOUT_MS = 120_000
export const MODELSCOPE_META_TIMEOUT_MS = 25_000
export const MODELSCOPE_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

/**
 * 魔搭访问令牌裸串判别式：`ms-` 前缀 + 至少 16 位可见字符（支持可选 `modelscope:` 前缀）。
 */
export const MODELSCOPE_BARE_TOKEN_PATTERN = /^(?:modelscope:)?ms-[A-Za-z0-9_-]{16,}$/

const EXTRA_BASE_URL = 'baseUrl'

/**
 * 魔搭 `/v1/models` 仍会返回、但推理端实际已下线的僵尸模型 ID（小写比对）。
 * 必须过滤，保留带日期后缀的在役版本（如 `-1017` / `-0813`），防止聚合路由误挑死模型。
 */
export const MODELSCOPE_RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-ai/deepseek-v4.1-flash',
  'deepseek-ai/deepseek-v4-pro',
])

/**
 * 魔搭常用免费推理模型兜底与元数据补全表。
 */
export const MODELSCOPE_FALLBACK_MODELS: readonly ProviderModel[] = [
  {
    id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'ZhipuAI/GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'ZhipuAI/GLM-5.1',
    name: 'GLM-5.1',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'Qwen/Qwen3.5-Plus',
    name: 'Qwen3.5-Plus',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'Qwen/Qwen3-Coder-Plus',
    name: 'Qwen3-Coder-Plus',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'Qwen/Qwen3.5-VL-72B-Instruct',
    name: 'Qwen3.5-VL-72B-Instruct',
    contextWindow: 131_072,
    maxOutput: 8_192,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'moonshotai/Kimi-K2.5',
    name: 'Kimi-K2.5',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'MiniMax/MiniMax-M2.5',
    name: 'MiniMax-M2.5',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'deepseek-ai/DeepSeek-V3.2',
    name: 'DeepSeek-V3.2',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
  {
    id: 'deepseek-ai/DeepSeek-R1-0528',
    name: 'DeepSeek-R1-0528',
    contextWindow: 131_072,
    maxOutput: 16_384,
    supportsImage: false,
    isFree: true,
  },
]

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of new TextEncoder().encode(input)) {
    hash = (hash ^ BigInt(byte)) & mask
    hash = (hash * prime) & mask
  }
  return hash.toString(16)
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

function unwrap(source: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['credential', 'credentials', 'data', 'modelscope', 'auth']) {
    const nested = source[key]
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>
    }
  }
  return source
}

export function isModelscopeTokenString(raw: string): boolean {
  return MODELSCOPE_BARE_TOKEN_PATTERN.test(raw.trim())
}

export function normalizeModelscopeToken(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith('modelscope:')
    ? trimmed.slice('modelscope:'.length).trim()
    : trimmed
}

/**
 * 对象形态判别式：仅在明确属于 ModelScope 时返回 `true`，绝不抢夺通用 `{ accessToken, uid }` 凭据。
 */
export function looksLikeModelscopeCredential(input: Record<string, unknown>): boolean {
  if (input['modelscope'] !== null && typeof input['modelscope'] === 'object' && !Array.isArray(input['modelscope'])) {
    return true
  }
  const source = unwrap(input)
  const providerTag =
    readString(input, ['provider'])?.toLowerCase() ?? readString(source, ['provider'])?.toLowerCase()
  if (providerTag === MODELSCOPE_PROVIDER_ID) {
    return (
      readString(source, [
        'accessToken',
        'access_token',
        'apiKey',
        'api_key',
        'token',
        'key',
        'MODELSCOPE_ACCESS_TOKEN',
        'MODELSCOPE_API_KEY',
      ]) !== undefined
    )
  }

  if (
    readString(source, [
      'MODELSCOPE_ACCESS_TOKEN',
      'MODELSCOPE_API_KEY',
      'modelscope_token',
      'modelscopeToken',
      'modelscope_api_key',
    ]) !== undefined
  ) {
    return true
  }

  const domainHint =
    readString(source, ['baseUrl', 'base_url', 'endpoint', 'domain']) ??
    readString(input, ['baseUrl', 'base_url', 'endpoint', 'domain']) ??
    ''
  if (domainHint.toLowerCase().includes('modelscope.cn')) {
    return (
      readString(source, ['accessToken', 'access_token', 'apiKey', 'api_key', 'token', 'key']) !== undefined
    )
  }

  const candidate = readString(source, ['accessToken', 'access_token', 'apiKey', 'api_key', 'token', 'key'])
  return candidate !== undefined && isModelscopeTokenString(candidate)
}

export function parseCredential(input: unknown): ProviderCredential {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!isModelscopeTokenString(trimmed)) {
      throw new ProviderError({
        provider: MODELSCOPE_PROVIDER_ID,
        message: 'ModelScope 裸令牌必须以 `ms-` 开头（如 `ms-xxxxxxxx...`），或提供包含 `accessToken` 的 JSON 对象',
      })
    }
    const token = normalizeModelscopeToken(trimmed)
    return {
      provider: MODELSCOPE_PROVIDER_ID,
      uid: `ms-${fnv1a64Hex(token)}`,
      accessToken: token,
      refreshToken: '',
      expiresAt: 0,
      nickname: `ModelScope (${token.slice(0, 7)}…)`,
      extras: {},
    }
  }

  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const root = input as Record<string, unknown>
    const source = unwrap(root)
    const rawToken =
      readString(source, [
        'MODELSCOPE_ACCESS_TOKEN',
        'MODELSCOPE_API_KEY',
        'modelscope_token',
        'modelscopeToken',
        'modelscope_api_key',
        'accessToken',
        'access_token',
        'apiKey',
        'api_key',
        'token',
        'key',
      ]) ??
      readString(root, [
        'MODELSCOPE_ACCESS_TOKEN',
        'MODELSCOPE_API_KEY',
        'accessToken',
        'access_token',
        'apiKey',
        'api_key',
        'token',
        'key',
      ])

    if (rawToken === undefined) {
      throw new ProviderError({
        provider: MODELSCOPE_PROVIDER_ID,
        message: 'ModelScope 凭据缺少有效的访问令牌（`accessToken` / `apiKey` / `ms-...`）',
      })
    }

    const token = normalizeModelscopeToken(rawToken)
    if (token === '') {
      throw new ProviderError({
        provider: MODELSCOPE_PROVIDER_ID,
        message: 'ModelScope 访问令牌不能为空',
      })
    }

    const rawBaseUrl =
      readString(source, ['baseUrl', 'base_url', 'endpoint']) ??
      readString(root, ['baseUrl', 'base_url', 'endpoint'])
    const baseUrl = rawBaseUrl !== undefined ? rawBaseUrl.replace(/\/+$/, '') : ''
    const customUid =
      readString(source, ['uid', 'user_id', 'userId', 'id']) ??
      readString(root, ['uid', 'user_id', 'userId', 'id']) ??
      ''
    const nickname =
      readString(source, ['nickname', 'name', 'username', 'label']) ??
      readString(root, ['nickname', 'name', 'username', 'label']) ??
      `ModelScope (${token.slice(0, 7)}…)`

    return {
      provider: MODELSCOPE_PROVIDER_ID,
      // ⚠️ 绝不把明文 token 放进 uid（防止面板/日志泄漏凭据）
      uid: customUid !== '' && customUid !== token ? customUid : `ms-${fnv1a64Hex(token)}`,
      accessToken: token,
      refreshToken: '',
      expiresAt: 0,
      nickname,
      extras: {
        ...(baseUrl !== '' ? { [EXTRA_BASE_URL]: baseUrl } : {}),
      },
    }
  }

  throw new ProviderError({
    provider: MODELSCOPE_PROVIDER_ID,
    message: 'ModelScope 凭据必须是 `ms-...` 令牌字符串或包含 `accessToken` / `apiKey` 的 JSON 对象',
  })
}

function modelscopeBaseUrl(credential: ProviderCredential): string {
  const custom = credential.extras[EXTRA_BASE_URL]
  if (typeof custom === 'string' && custom.trim() !== '') {
    return custom.trim().replace(/\/+$/, '')
  }
  return MODELSCOPE_BASE_URL
}

function stripModelscopePrefix(rawModel: string): string {
  let s = rawModel.trim()
  if (s.toLowerCase().startsWith('modelscope/')) s = s.slice('modelscope/'.length).trim()
  if (s.toLowerCase().startsWith('modelscope:')) s = s.slice('modelscope:'.length).trim()
  return s
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function extractModelscopeErrorDetail(text: string, status: number): string {
  const json = parseJsonObject(text)
  if (json !== undefined) {
    const err = json['error']
    if (err !== null && typeof err === 'object') {
      const rec = err as Record<string, unknown>
      const msg = typeof rec['message'] === 'string' ? rec['message'] : ''
      const code = typeof rec['code'] === 'string' || typeof rec['code'] === 'number' ? String(rec['code']) : ''
      if (msg !== '' || code !== '') {
        return `${code !== '' ? `[${code}] ` : ''}${msg}`.trim().slice(0, 240)
      }
    }
    if (typeof err === 'string' && err.trim() !== '') return err.trim().slice(0, 240)
    const errors = json['errors']
    if (errors !== null && typeof errors === 'object') {
      const msg = (errors as Record<string, unknown>)['message']
      if (typeof msg === 'string' && msg.trim() !== '') return msg.trim().slice(0, 240)
    }
    if (typeof json['message'] === 'string' && json['message'].trim() !== '') {
      return json['message'].trim().slice(0, 240)
    }
  }
  return text.trim() === '' ? `HTTP ${status}` : text.trim().slice(0, 240)
}

function extractModelscopeEnvelopeStatus(json: Record<string, unknown>): number {
  const candidates: unknown[] = [
    json['status_code'],
    json['statusCode'],
    json['http_status'],
    json['status'],
    json['code'],
  ]
  const err = json['error']
  if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
    const rec = err as Record<string, unknown>
    candidates.unshift(rec['status'], rec['status_code'], rec['code'])
  }
  for (const cand of candidates) {
    const num =
      typeof cand === 'number' && Number.isFinite(cand)
        ? Math.trunc(cand)
        : typeof cand === 'string' && /^\d{3}$/.test(cand.trim())
          ? Number.parseInt(cand.trim(), 10)
          : undefined
    if (num !== undefined && num >= 400 && num <= 599) {
      return num
    }
  }
  return 400
}

export function isModelscopeContextOverflow(body: string): boolean {
  return /maximum context length|context[_ ]?length[_ ]?exceeded|input length.*exceeds|prompt is too long|token limit exceeded/i.test(
    body,
  )
}

export function isModelscopeRetryable(status: number, body: string): boolean {
  if (isModelscopeContextOverflow(body)) return false
  if (status === 400 || status === 422) {
    return /invalid[_ ]?(?:api[_ ]?)?key|invalid[_ ]?token|token.*expired|unauthorized|rate[_ ]?limit|too many requests|quota[_ ]?exceeded|insufficient[_ ]?quota|daily[_ ]?limit|usage[_ ]?limit|overloaded|service[_ ]?unavailable|server[_ ]?busy/i.test(
      body,
    )
  }
  if (status === 401 || status === 402 || status === 403 || status === 408 || status === 429) {
    return true
  }
  return status >= 500
}

function findFallbackModelMeta(id: string): ProviderModel | undefined {
  const lower = id.toLowerCase()
  for (const item of MODELSCOPE_FALLBACK_MODELS) {
    const itemLower = item.id.toLowerCase()
    if (itemLower === lower) return item
    if (lower.startsWith(`${itemLower}-`) || itemLower.startsWith(`${lower}-`)) return item
  }
  return undefined
}

function inferSupportsImage(id: string, fallback?: ProviderModel): boolean {
  if (fallback !== undefined) return fallback.supportsImage
  const lower = id.toLowerCase()
  return lower.includes('-vl') || lower.includes('vision') || lower.includes('qvq') || lower.includes('kimi-k2.5')
}

export async function listModels(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderModel[]> {
  const url = `${modelscopeBaseUrl(credential)}/models`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODELSCOPE_META_TIMEOUT_MS)]),
    })
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderError({ provider: MODELSCOPE_PROVIDER_ID, message: '请求已被客户端取消' })
    }
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      retryable: true,
      message: `ModelScope 模型目录请求失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: response.status,
      retryable: isModelscopeRetryable(response.status, text),
      message: `ModelScope 拉取模型目录失败（http=${response.status}）：${extractModelscopeErrorDetail(text, response.status)}`,
    })
  }

  const payload = parseJsonObject(text)
  const rawList = Array.isArray(payload?.['data'])
    ? (payload!['data'] as unknown[])
    : Array.isArray(payload?.['models'])
      ? (payload!['models'] as unknown[])
      : []

  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const raw of rawList) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const rawId = typeof item['id'] === 'string' ? item['id'].trim() : ''
    if (rawId === '') continue
    const lowerId = rawId.toLowerCase()
    if (MODELSCOPE_RETIRED_MODEL_IDS.has(lowerId) || seen.has(lowerId)) continue
    seen.add(lowerId)

    const fallback = findFallbackModelMeta(rawId)
    const slashIdx = rawId.lastIndexOf('/')
    const shortName = slashIdx >= 0 ? rawId.slice(slashIdx + 1) : rawId
    const displayName =
      typeof item['display_name'] === 'string' && item['display_name'].trim() !== ''
        ? item['display_name'].trim()
        : (fallback?.name ?? shortName)
    const contextWindow =
      typeof item['context_length'] === 'number' && item['context_length'] > 0
        ? item['context_length']
        : typeof item['max_model_len'] === 'number' && item['max_model_len'] > 0
          ? item['max_model_len']
          : (fallback?.contextWindow ?? 131_072)
    const maxOutput =
      typeof item['max_output_tokens'] === 'number' && item['max_output_tokens'] > 0
        ? item['max_output_tokens']
        : (fallback?.maxOutput ?? 16_384)

    out.push({
      id: rawId,
      name: displayName,
      contextWindow,
      maxOutput,
      supportsImage: inferSupportsImage(rawId, fallback),
      isFree: true,
    })
  }

  if (out.length > 0) return out
  return MODELSCOPE_FALLBACK_MODELS.filter((m) => !MODELSCOPE_RETIRED_MODEL_IDS.has(m.id.toLowerCase())).map((m) => ({
    ...m,
  }))
}

function normalizeToolsForModelscope(rawTools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined
  const out: Array<Record<string, unknown>> = []
  for (const item of rawTools) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const t = item as Record<string, unknown>
    if (t['type'] === 'function' && t['function'] !== null && typeof t['function'] === 'object') {
      out.push(t)
      continue
    }
    if (typeof t['name'] === 'string' && t['name'].trim() !== '') {
      out.push({
        type: 'function',
        function: {
          name: t['name'].trim(),
          ...(typeof t['description'] === 'string' ? { description: t['description'] } : {}),
          parameters:
            t['parameters'] !== null && typeof t['parameters'] === 'object'
              ? t['parameters']
              : t['input_schema'] !== null && typeof t['input_schema'] === 'object'
                ? t['input_schema']
                : { type: 'object', properties: {} },
        },
      })
    }
  }
  return out.length > 0 ? out : undefined
}

export function buildModelscopeChatPayload(
  model: string,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const targetModel = stripModelscopePrefix(model) || MODELSCOPE_DEFAULT_MODEL
  const messages = Array.isArray(rawBody['messages']) ? [...(rawBody['messages'] as unknown[])] : []
  if (rawBody['system'] !== undefined) {
    const sys = rawBody['system']
    if (typeof sys === 'string' && sys.trim() !== '') {
      messages.unshift({ role: 'system', content: sys })
    } else if (Array.isArray(sys)) {
      const sysText = sys
        .map((b) =>
          typeof b === 'string'
            ? b
            : b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
              ? (b as { text: string }).text
              : '',
        )
        .filter((s) => s !== '')
        .join('\n')
      if (sysText !== '') messages.unshift({ role: 'system', content: sysText })
    }
  }

  if (messages.length === 0) {
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: 400,
      retryable: false,
      message: 'ModelScope 对话请求缺少非空的 messages 数组',
    })
  }

  const payload: Record<string, unknown> = {
    model: targetModel,
    messages,
    stream: true,
    stream_options:
      rawBody['stream_options'] !== null && typeof rawBody['stream_options'] === 'object'
        ? { ...(rawBody['stream_options'] as Record<string, unknown>), include_usage: true }
        : { include_usage: true },
  }

  const tools = normalizeToolsForModelscope(rawBody['tools'])
  if (tools !== undefined) {
    payload['tools'] = tools
    if (rawBody['tool_choice'] !== undefined) payload['tool_choice'] = rawBody['tool_choice']
  }

  for (const key of [
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'presence_penalty',
    'frequency_penalty',
    'reasoning_effort',
    'enable_thinking',
    'thinking_budget',
    'response_format',
    'stop',
  ] as const) {
    if (rawBody[key] !== undefined) payload[key] = rawBody[key]
  }

  return payload
}

function completionJsonToOpenAiSse(payload: Record<string, unknown>, fallbackModel: string): Response {
  const id = typeof payload['id'] === 'string' && payload['id'] !== '' ? payload['id'] : `chatcmpl-${Date.now()}`
  const created =
    typeof payload['created'] === 'number' && Number.isFinite(payload['created'])
      ? payload['created']
      : Math.floor(Date.now() / 1000)
  const model =
    typeof payload['model'] === 'string' && payload['model'] !== ''
      ? payload['model']
      : stripModelscopePrefix(fallbackModel) || MODELSCOPE_DEFAULT_MODEL
  const choices = Array.isArray(payload['choices']) ? (payload['choices'] as Array<Record<string, unknown>>) : []
  const first = choices[0] ?? {}
  const msg =
    first['message'] !== null && typeof first['message'] === 'object'
      ? (first['message'] as Record<string, unknown>)
      : {}
  const finishReason =
    typeof first['finish_reason'] === 'string' && first['finish_reason'] !== ''
      ? first['finish_reason']
      : Array.isArray(msg['tool_calls']) && (msg['tool_calls'] as unknown[]).length > 0
        ? 'tool_calls'
        : 'stop'

  const delta: Record<string, unknown> = { role: 'assistant' }
  if (typeof msg['reasoning_content'] === 'string' && msg['reasoning_content'] !== '') {
    delta['reasoning_content'] = msg['reasoning_content']
  }
  if (typeof msg['content'] === 'string') {
    delta['content'] = msg['content']
  }
  if (Array.isArray(msg['tool_calls']) && (msg['tool_calls'] as unknown[]).length > 0) {
    delta['tool_calls'] = (msg['tool_calls'] as Array<Record<string, unknown>>).map((tc, idx) => ({
      index: typeof tc['index'] === 'number' ? tc['index'] : idx,
      ...tc,
    }))
  }

  const frames: string[] = [
    sseFrame(
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      }),
    ),
    sseFrame(
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(payload['usage'] !== null && typeof payload['usage'] === 'object' ? { usage: payload['usage'] } : {}),
      }),
    ),
    'data: [DONE]\n\n',
  ]

  return new Response(frames.join(''), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
    },
  })
}

export async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const payload = buildModelscopeChatPayload(request.model, request.body)
  const url = `${modelscopeBaseUrl(credential)}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(MODELSCOPE_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    if (request.signal.aborted) {
      throw new ProviderError({ provider: MODELSCOPE_PROVIDER_ID, message: '请求已被客户端取消' })
    }
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      retryable: true,
      message: `ModelScope 请求网络失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const detail = extractModelscopeErrorDetail(text, response.status)
    const status = isModelscopeContextOverflow(text) ? 400 : response.status
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: status,
      retryable: isModelscopeRetryable(status, text),
      message: `ModelScope 推理失败（http=${response.status}）：${detail}`,
    })
  }

  if (response.body === null) {
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: 502,
      retryable: true,
      message: 'ModelScope 上游返回 200 但响应体为空',
    })
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.includes('text/html')) {
    const html = await response.text().catch(() => '')
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: 502,
      retryable: true,
      message: `ModelScope 返回 HTML 拦截页而非 SSE 流：${html.slice(0, 160)}`,
    })
  }

  if (contentType.includes('application/json')) {
    const text = await response.text().catch(() => '')
    const json = parseJsonObject(text)
    if (json === undefined) {
      throw new ProviderError({
        provider: MODELSCOPE_PROVIDER_ID,
        httpStatus: 502,
        retryable: true,
        message: `ModelScope 返回无法解析的 JSON：${text.slice(0, 180)}`,
      })
    }
    if (json['error'] !== undefined || json['errors'] !== undefined || json['success'] === false) {
      const envStatus = extractModelscopeEnvelopeStatus(json)
      const detail = extractModelscopeErrorDetail(text, envStatus)
      const effectiveStatus = isModelscopeContextOverflow(text) ? 400 : envStatus
      throw new ProviderError({
        provider: MODELSCOPE_PROVIDER_ID,
        httpStatus: effectiveStatus,
        retryable: isModelscopeRetryable(effectiveStatus, `${detail} ${text}`),
        message: `ModelScope 推理返回业务错误：${detail}`,
      })
    }
    return completionJsonToOpenAiSse(json, request.model)
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
    },
  })
}

export async function balance(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderBalance> {
  let response: Response
  try {
    response = await fetch(MODELSCOPE_BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Referer: 'https://www.modelscope.cn/my/overview',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODELSCOPE_META_TIMEOUT_MS)]),
    })
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderError({ provider: MODELSCOPE_PROVIDER_ID, message: '请求已被客户端取消' })
    }
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      retryable: true,
      message: `ModelScope 算力豆余额查询失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: response.status,
      retryable: isModelscopeRetryable(response.status, text),
      message: `ModelScope 余额查询失败（http=${response.status}）：${extractModelscopeErrorDetail(text, response.status)}`,
    })
  }

  const json = parseJsonObject(text)
  if (json === undefined || json['success'] === false) {
    throw new ProviderError({
      provider: MODELSCOPE_PROVIDER_ID,
      httpStatus: response.status,
      message: `ModelScope 余额响应异常：${extractModelscopeErrorDetail(text, response.status)}`,
    })
  }

  const data =
    json['data'] !== null && typeof json['data'] === 'object' && !Array.isArray(json['data'])
      ? (json['data'] as Record<string, unknown>)
      : json

  const rawTotal =
    data['total_balance'] ?? data['available_balance'] ?? data['balance'] ?? data['magicubes'] ?? 0
  const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : Number(rawTotal) || 0

  const rawExpiring = data['expiring_balance'] ?? data['expiring'] ?? 0
  const expiring =
    typeof rawExpiring === 'number' && Number.isFinite(rawExpiring) ? rawExpiring : Number(rawExpiring) || 0

  return {
    total,
    expiring,
    earliestExpiry: 0,
    packages: [{ name: '魔搭算力豆余额', amount: total, expiry: 0 }],
  }
}

export const modelscopeProvider: Provider = {
  id: MODELSCOPE_PROVIDER_ID,
  name: 'ModelScope (魔搭)',
  capabilities: {
    login: false,
    listModels: true,
    chat: true,
    balance: true,
    checkin: false,
    loginBlockedReason:
      'ModelScope 使用个人 SDK 访问令牌（形如 `ms-...`），无需 OAuth 浏览器回调登录；'
      + '请前往魔搭社区「账号设置 → 访问令牌」复制令牌后直接粘贴导入。',
    checkinBlockedReason:
      'ModelScope API-Inference 免费推理调用配额按自然日自动重置（无需手动签到领取）。',
  },
  parseCredential,
  matchesShape(input) {
    return looksLikeModelscopeCredential(input)
  },
  bareStringPattern: MODELSCOPE_BARE_TOKEN_PATTERN,
  shouldRotate(status, body) {
    return isModelscopeRetryable(status, body)
  },
  listModels,
  chat,
  balance,
}
