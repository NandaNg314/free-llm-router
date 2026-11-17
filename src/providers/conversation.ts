/**
 * 会话 / 轮级请求 id 的上下文（**纯数据**，不碰网络、不碰存储）。
 *
 * ## ⚠️ 为什么需要它与 `ChatRequest` 分开
 *
 * 上游国际服（`www.workbuddy.ai`）从 2026-10-20 起强校验会话头族：
 *
 * ```
 * X-Conversation-ID          同一对话内恒定
 * X-Conversation-Request-ID  一轮用户发送内恒定（重试复用）
 * X-Root-Request-ID          = 上一行
 * X-Conversation-Message-ID  每请求新生成
 * X-Request-ID               = 上一行
 * ```
 *
 * 前两个必须由**调用方在重试循环外**算好再传进来 —— 放在头构造函数里现生成，
 * 等于每次重试都开一个「新会话 / 新一轮」，正是上游画像里最显眼的非人类特征。
 *
 * 而 `ChatRequest` 是**所有 provider 共用的**结构（cline / minimax / gemini…），
 * 往里塞两个只有 WorkBuddy 国际服关心的字段会污染公共契约。
 * 故拆成独立结构，由 `ChatRequest.conversation` 可选携带。
 */
export interface ConversationContext {
  /**
   * `X-Conversation-ID`：带连字符的 UUID，同一会话恒定。
   *
   * ⚠️ 派生种子**必须包含账号 uid**：同一段会话 id 出现在两个账号的请求里，
   * 就是上游把两个号串起来的关联键。
   */
  conversationId: string
  /** `X-Conversation-Request-ID`（= `X-Root-Request-ID`）：32 位 hex，一轮恒定。 */
  turnRequestId: string
}

/**
 * 常见客户端硬编码的通用静态 `user` 占位值。
 *
 * 若将其直接当作会话标识，会把所有使用该客户端的不同用户流量全部焊死在同一账号上。
 */
export const GENERIC_CALLER_USERS: readonly string[] = [
  'default',
  'default-user',
  'default_user',
  'user',
  'chatbox',
  'nextchat',
  'admin',
  'root',
  'anonymous',
  '1',
]

/** 判断 `user` 标识是否为无区分度的客户端静态占位词。 */
export function isGenericCallerUser(value: string): boolean {
  const norm = value.trim().toLowerCase()
  return norm === '' || GENERIC_CALLER_USERS.includes(norm)
}

export interface SessionStickyOptions {
  /**
   * 显式下游调用方作用域（如子密钥 ID `subkey:<id>`、租户标识或请求体提取的用户标识）。
   *
   * ⚠️ 未提供（`undefined` 或空串）时，哈希输入与历史实现**逐字节一致**。
   */
  callerScope?: string
  /** 子密钥 ID 别名（等价于在无更高优先级 `callerScope` 时提供调用方隔离域）。 */
  subkeyId?: string
}

/** SHA-256 → 小写 hex（纯 WebCrypto，兼容 Cloudflare Workers 与 Node 22+）。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function resolveScopeOption(options?: string | SessionStickyOptions): string {
  if (typeof options === 'string') return options.trim()
  if (options !== undefined && options !== null && typeof options === 'object') {
    const direct = typeof options.callerScope === 'string' ? options.callerScope.trim() : ''
    if (direct !== '') return direct
    const subkey = typeof options.subkeyId === 'string' ? options.subkeyId.trim() : ''
    if (subkey !== '') return subkey
  }
  return ''
}

function extractMetadataUserId(body: Record<string, unknown>): string {
  if (body.metadata !== null && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    const meta = body.metadata as Record<string, unknown>
    for (const key of ['user_id', 'userId'] as const) {
      const v = meta[key]
      if (typeof v === 'string' && !isGenericCallerUser(v)) {
        return v.trim()
      }
    }
  }
  for (const key of ['user_id', 'userId'] as const) {
    const v = body[key]
    if (typeof v === 'string' && !isGenericCallerUser(v)) {
      return v.trim()
    }
  }
  return ''
}

/**
 * 提取下游调用方隔离标识（参考 `workbuddy2api-panel` `d700ec5` `callerIDOf` + 子密钥域）。
 *
 * 优先级：
 * 1. 请求体非通用 `user`
 * 2. 请求体 `metadata.user_id` / `metadata.userId`（Claude Code 等客户端标准字段）
 * 3. 请求体顶层 `user_id` / `userId`
 * 4. 网关鉴权层传入的子密钥标识 `subkeyScope`
 *
 * 均不存在时返回 `''`。
 */
export function extractCallerScope(rawBody: unknown, subkeyScope?: string): string {
  if (rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
    const body = rawBody as Record<string, unknown>
    if (typeof body.user === 'string' && !isGenericCallerUser(body.user)) {
      return body.user.trim()
    }
    const metaUser = extractMetadataUserId(body)
    if (metaUser !== '') return metaUser
  }
  return typeof subkeyScope === 'string' ? subkeyScope.trim() : ''
}

function extractTextFromContent(content: unknown, maxLen: number = 4096): string {
  if (typeof content === 'string') return content.trim().slice(0, maxLen)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let total = 0
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      total += block.length
    } else if (block !== null && typeof block === 'object') {
      const b = block as Record<string, unknown>
      const text =
        typeof b.text === 'string'
          ? b.text
          : typeof b.input_text === 'string'
            ? b.input_text
            : typeof b.content === 'string'
              ? b.content
              : ''
      if (text !== '') {
        parts.push(text)
        total += text.length
      }
    }
    if (total >= maxLen) break
  }
  return parts.join('\n').trim().slice(0, maxLen)
}

function extractConversationOpeningFingerprint(body: Record<string, unknown>): {
  systemText: string
  firstUserText: string
} {
  const systemParts: string[] = []
  if (body.system !== undefined) {
    const topSys = extractTextFromContent(body.system)
    if (topSys !== '') systemParts.push(topSys)
  }
  if (typeof body.instructions === 'string' && body.instructions.trim() !== '') {
    systemParts.push(body.instructions.trim().slice(0, 4096))
  }

  let firstUserText = ''
  if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      if (item === null || typeof item !== 'object') continue
      const msg = item as Record<string, unknown>
      const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : ''
      if ((role === 'system' || role === 'developer') && firstUserText === '') {
        const s = extractTextFromContent(msg.content)
        if (s !== '') systemParts.push(s)
      } else if (role === 'user' && firstUserText === '') {
        firstUserText = extractTextFromContent(msg.content)
        if (firstUserText !== '') break
      }
    }
  }

  if (firstUserText === '' && body.input !== undefined) {
    if (typeof body.input === 'string') {
      firstUserText = body.input.trim().slice(0, 4096)
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (item === null || typeof item !== 'object') continue
        const msg = item as Record<string, unknown>
        const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : 'user'
        if (role === 'user') {
          const text = extractTextFromContent(msg.content ?? msg.text)
          if (text !== '') {
            firstUserText = text
            break
          }
        }
      }
    }
  }

  return {
    systemText: systemParts.join('\n').slice(0, 4096),
    firstUserText,
  }
}

/**
 * 显式标识型会话粘性键派生（**不读取消息正文**，兼容 `server.ts` 的零误粘纪律）。
 *
 * - 当未提供 `callerScope`（且无 `metadata.user_id`）时，输出与原 `server.ts` `deriveSessionKey`
 *   **逐字节一致**（`u:<sha256(user).slice(0,32)>` / `c:<sha256(convId).slice(0,32)>` / `''`）；
 * - 当提供 `callerScope`（如子密钥 ID）时，将其以 `\0` 分隔符掺入哈希输入，使不同子密钥/租户互不撞车。
 */
export async function deriveSessionKey(
  rawBody: unknown,
  options?: string | SessionStickyOptions,
): Promise<string> {
  const explicitScope = resolveScopeOption(options)
  if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return explicitScope !== '' ? `u:${(await sha256Hex(explicitScope)).slice(0, 32)}` : ''
  }
  const body = rawBody as Record<string, unknown>

  const rawUser = typeof body.user === 'string' ? body.user.trim() : ''
  if (rawUser !== '' && !isGenericCallerUser(rawUser)) {
    const seed =
      explicitScope !== '' && explicitScope !== rawUser ? `${explicitScope}\u0000${rawUser}` : rawUser
    return `u:${(await sha256Hex(seed)).slice(0, 32)}`
  }

  const metaUser = extractMetadataUserId(body)

  for (const key of ['conversation_id', 'conversationId'] as const) {
    const v = body[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const convId = v.trim()
      const scope = explicitScope !== '' ? explicitScope : metaUser
      const seed = scope !== '' ? `${scope}\u0000${convId}` : convId
      return `c:${(await sha256Hex(seed)).slice(0, 32)}`
    }
  }

  if (metaUser !== '') {
    const seed =
      explicitScope !== '' && explicitScope !== metaUser ? `${explicitScope}\u0000${metaUser}` : metaUser
    return `u:${(await sha256Hex(seed)).slice(0, 32)}`
  }

  if (explicitScope !== '') {
    return `u:${(await sha256Hex(explicitScope)).slice(0, 32)}`
  }

  return ''
}

/**
 * 派生会话粘性键（参考 `workbuddy2api-panel` `d700ec5`，支持开场白指纹 + `callerScope` 分槽）：
 *
 * - 显式会话 ID（`conversation_id` / `conversationId` / `session_id` / `prompt_cache_key`）：
 *   无 `callerScope` 时输出 `c:<sha256(id).slice(0,32)>`（逐字节向后兼容）；
 *   有 `callerScope` 时输出 `c:<sha256(callerScope + "\0" + id).slice(0,32)>`。
 * - 开场对话派生（`system` + 首条 `user` 消息）：
 *   无任何 `callerScope`（且请求体无 `user` / `metadata.user_id`）时，哈希种子为
 *   `${systemText}\0${firstUserText}`（与未加 `callerScope` 前逐字节一致）；
 *   提供 `callerScope`（或请求体含 `user` / `metadata.user_id` / 子密钥 ID）时，哈希种子为
 *   `${scope}\0${systemText}\0${firstUserText}`：
 *     ① 不同下游客户端发相同 `"hi"` 或相同 Agent 系统提示词 → 分槽落不同账号；
 *     ② 同一用户的多轮追加对话（首条 `user` 与 `system` 不变）→ 稳定命中同一账号！
 */
export async function deriveStickySessionKey(
  rawBody: unknown,
  options?: string | SessionStickyOptions,
): Promise<string> {
  const explicitScope = resolveScopeOption(options)
  if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return explicitScope !== '' ? `u:${(await sha256Hex(explicitScope)).slice(0, 32)}` : ''
  }
  const body = rawBody as Record<string, unknown>
  const scope = explicitScope !== '' ? explicitScope : extractCallerScope(body)

  for (const key of ['conversation_id', 'conversationId', 'session_id', 'prompt_cache_key'] as const) {
    const v = body[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const convId = v.trim()
      const seed = scope !== '' ? `${scope}\u0000${convId}` : convId
      return `c:${(await sha256Hex(seed)).slice(0, 32)}`
    }
  }

  const { systemText, firstUserText } = extractConversationOpeningFingerprint(body)
  if (firstUserText !== '') {
    const seed =
      scope !== '' ? `${scope}\u0000${systemText}\u0000${firstUserText}` : `${systemText}\u0000${firstUserText}`
    return `d:${(await sha256Hex(seed)).slice(0, 32)}`
  }

  if (scope !== '') {
    return `u:${(await sha256Hex(scope)).slice(0, 32)}`
  }

  return ''
}
