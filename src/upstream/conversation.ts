/**
 * 会话 ID 稳定派生（**纯函数**，不碰网络、不碰存储）。
 *
 * ## ⚠️ 为什么必须稳定，而不是每请求现生成
 *
 * 上游国际服（`www.workbuddy.ai`）从 2026-10-20 起强校验**会话头族**：
 * 缺 `X-Conversation-ID` 等 5 个头直接 400 `11-128 request illegal`。
 * 补齐之后，`X-Conversation-ID` 的**取值语义**同样影响画像：
 *
 * - 官方客户端在同一个对话里**复用同一个** `X-Conversation-ID`，
 *   每轮用户发送复用同一个 `X-Conversation-Request-ID`；
 * - 网关如果每个请求现生成一个，等于把一次多轮对话拆成上千个「一次性会话」，
 *   是反作弊眼里最明显的非人类形态（也是被风控误伤的直接来源）。
 *
 * ⇒ 按「账号 + 会话键」稳定派生：同一账号的同一会话多轮复用同一个 id，
 * 不同账号 / 不同会话互不相同。
 *
 * ## ⚠️ 为什么不能拿同一个 id 发给多个账号
 *
 * 那才是真正的关联键 —— 同一段会话 id 出现在两个账号的请求里，
 * 上游立刻能把两个号串起来。故派生的种子**必须包含 uid**。
 */

/** 32 位 hex（请求级 / 消息级 id，实测形态）。 */
function randomHex32(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * 由「账号 + 会话键」稳定派生一个**带连字符的 UUID**（`X-Conversation-ID`）。
 *
 * 版本位 / 变体位固定成 UUIDv4 的样子 —— 真实客户端抓包里就是这个形状。
 *
 * @param uid 账号 uid（作为派生种子，保证跨账号不撞）
 * @param sessionKey 会话键（空串表示无法判定会话，此时退回随机，**不伪造稳定值**）
 */
export async function deriveIntlConversationId(uid: string, sessionKey: string): Promise<string> {
  if (sessionKey === '') return crypto.randomUUID()
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`conv:${uid}:${sessionKey}`),
  )
  const h = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
  // ⚠️ 版本位在**第 7 个字节**的高 4 位（`h[6]`），变体位在**第 9 个字节**的高 2 位（`h[9]`）。
  // 写错字节位不会报错 —— 只是产出一个 variant 非法的「假 UUID」，
  // 而它恰恰是最容易被指纹识别盯上的地方（官方客户端的都是合规 v4）。
  h[6] = '4' // 版本位：UUIDv4
  const variantByte = Number.parseInt(h[9] ?? '0', 16)
  h[9] = ((variantByte & 0x3f) | 0x80).toString(16).padStart(2, '0') // 变体位：RFC 4122
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/**
 * 一轮用户发送的 `X-Conversation-Request-ID`。
 *
 * 官方语义：在「一次 user send」开始时生成，这一轮里所有请求（含重试）复用它；
 * 只有消息级 id（`X-Request-ID` / `X-Conversation-Message-ID`）是每请求新生成。
 * 故必须由调用方在重试循环**外**生成一次再传进来，不能放在头构造函数里现生成。
 */
export function newTurnRequestId(): string {
  return randomHex32()
}
