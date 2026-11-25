
/**
 * 上游渠道拦截码的两种书写形态（**码点构造**，源码里不写裸字面量）。
 *
 * - `FP_BARE`：不带连字符的 5 位裸码 —— 反探测的**触发串**（请求里出现即整单拦截，
 *   Go 侧 `sanitize.go` 与 workbuddy2api-hub 都按它改写），也是参考实现记录的数字 `code`。
 * - `FP`：带 ASCII 连字符的 6 字符形态 —— workbuddy2api-hub 把裸码改写成的样子，
 *   本仓库也有样本记录它出现在错误信封里。2026-10-19 曾把它当成「唯一真实码」，
 *   导致裸码不再被改写（2026-10-21 纠正）。两种都改写成 `FP_SAFE`，不赌哪一种。
 *
 * ⚠️ 写字面量**不安全**：ASCII 连字符与 U+2011 等渲染一模一样，
 * 编辑器/构建链任一处归一化都会让判据与替身同形，函数静默变成空操作。
 */
const FP_BARE = String.fromCharCode(0x31, 0x31, 0x31, 0x32, 0x38)
const FP = String.fromCharCode(0x31, 0x31, 0x2d, 0x31, 0x32, 0x38)

/**
 * 脱敏后的替身：中间放 U+2011（NON-BREAKING HYPHEN）。
 *
 * ⚠️ 必须与 `FP` / `FP_BARE` 都是**不同码点序列**，否则 `replaceAll` 就是空操作
 * （本项目真实发生过，且单测写成「输入 === 期望值」而永远通过）。
 * NFKC 归一化会把 U+2011 变成 U+2010，仍不会还原成裸码。
 */
const FP_SAFE = String.fromCharCode(0x31, 0x31, 0x2011, 0x31, 0x32, 0x38)

/**
 * 出站请求体准备（**纯函数**）。
 *
 * ## 为什么需要这一层
 *
 * OpenAI 客户端发的请求体**不能原样**转给 WorkBuddy 上游，有四处硬性差异
 * （逐条来自 Go 侧实测，AGENTS.md §6）：
 *
 * | 差异 | 后果（若不处理） |
 * |---|---|
 * | 上游**只认 `max_tokens`**，不认 `max_completion_tokens` | 别名被忽略 → 回落默认输出上限（实测 32000）→ **长流被截断** |
 * | 上游要求 **`stream: true`** | 非流式请求被上游按流式处理不当 |
 * | `tool_choice` 只认**字符串** | 对象形式 → **400 code=11101** |
 * | `stream_options.include_usage` 缺省需补 | 末帧不返回 usage → 用量统计恒为 0 |
 *
 * ## 分层纪律
 *
 * 纯函数、无网络、无存储 —— 上游改判据时**只改这个文件**，网关逻辑不动。
 */

/** 需要翻译的字段名（OpenAI 新字段 → 上游认的旧字段）。 */
export function translateMaxCompletionTokens(body: Record<string, unknown>): void {
  const alias = body.max_completion_tokens
  delete body.max_completion_tokens

  // ⚠️ 显式 max_tokens 优先：别名只删不译（避免把别名值覆盖掉用户显式给的值）
  if (body.max_tokens !== undefined) return

  // 只有正整数才翻译。0/null 是「未设置」语义，负数是非法值 —— 都不该变成 max_tokens
  if (typeof alias === 'number' && Number.isSafeInteger(alias) && alias > 0) {
    body.max_tokens = alias
  }
}

/**
 * 请求体里**是否带图片**（纯函数，聚合路由用）。
 *
 * ## 为什么需要它（同步自上游 XuexGao/free-llm-router `916242d`）
 *
 * 聚合会在同一规范名的**多个渠道**之间挑一个。这些渠道的图片能力**不一致**
 *（实测 `codearts` 的 DeepSeek 不支持图片，而 `trae` / `qoder` 支持）。
 *
 * ⚠️ 若不带这个判据，带图请求会**随机**落到不支持的那家并被上游拒绝 ——
 * 「有时能用、有时失败」比明确报「不支持」更糟（用户无法判断该重试还是换模型）。
 *
 * ⇒ 聚合路由用它在**派发前**过滤候选：带图 ⇒ 只留 `supportsImage` 的；
 * 纯文本 ⇒ 不过滤。这样目录能如实报「支持图片」（确实有渠道能处理），
 * 且不会随机失败。两处**必须成对**（见 `aggregate.ts` 的 `imageCapableOf`）。
 *
 * 只认 OpenAI 标准的 `image_url` 内容块 —— 不做模糊匹配（`type` 里含
 * "image" 的字面猜测会把 `image_generation` 之类的工具声明误判成输入图）。
 */
export function requestHasImage(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const messages = (body as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return false
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const content = (raw as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue
      if ((part as Record<string, unknown>).type === 'image_url') return true
    }
  }
  return false
}

/**
 * 归一化 `tool_choice`：上游该字段是 **string**，对象形式会 400 `code=11101`。
 *
 * - `'auto'` / `'none'` / `'required'`（大小写/空白不敏感）→ 规范小写透传；
 * - 对象 `{type:'none'|'auto'|'required'}` → 同名字符串（Responses / 部分 SDK 的写法）；
 * - 其余对象形式（含具名函数 `{type:'function', function:{name}}`）→ 降级为 `'auto'`
 *  （**不是**报错：降级能让请求成功，报错会让整个对话失败。而具名选择在多数客户端里只影响
 *   偏好，不影响正确性）；
 * - 其他未知形态 → 删除该字段（缺省即 `auto`）。
 *
 * ⚠️ `none` **只改 tool_choice，不删 tools**：删掉工具声明会让模型拿不到函数签名、
 * 把调用降级成伪 JSON 文本塞进正文，agent 原地空转（workbuddy2api-hub 踩过的坑）。
 */
export function normalizeToolChoice(body: Record<string, unknown>): void {
  const choice = body.tool_choice
  if (choice === undefined) return

  if (typeof choice === 'string') {
    const v = choice.trim().toLowerCase()
    if (v === 'auto' || v === 'none' || v === 'required') {
      if (v !== choice) body.tool_choice = v
      return
    }
    // 未知字符串：删掉（缺省即 auto），比传给上游被拒好
    delete body.tool_choice
    return
  }

  if (choice !== null && typeof choice === 'object' && !Array.isArray(choice)) {
    const t = (choice as Record<string, unknown>).type
    const v = typeof t === 'string' ? t.trim().toLowerCase() : ''
    body.tool_choice = v === 'none' || v === 'required' ? v : 'auto'
    return
  }

  delete body.tool_choice
}

/**
 * 补齐 `stream_options.include_usage`。
 *
 * 只有**显式没带**时才补：用户显式设了 `include_usage: false` 就尊重它。
 */
export function ensureStreamOptions(body: Record<string, unknown>): void {
  if (body.stream_options !== undefined) return
  body.stream_options = { include_usage: true }
}

type Msg = Record<string, unknown>

function isObj(v: unknown): v is Msg {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** assistant 消息「没有正文」：`undefined` / `null` / `''` / `[]` 都算（各家客户端写法不一）。 */
function isEmptyContent(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** 把 `src.reasoning_content` 并进 `dst`（两边都有时换行拼接）。就地改 `dst`（调用方保证它是副本）。 */
function mergeReasoningContent(dst: Msg, src: Msg): void {
  const rc = src.reasoning_content
  if (typeof rc !== 'string' || rc === '') return
  const prev = dst.reasoning_content
  dst.reasoning_content = typeof prev === 'string' && prev !== '' ? `${prev}\n${rc}` : rc
}

/**
 * 单个 assistant 的 `tool_calls` 逐项修整：
 * - 剔除**名字为空**的调用（Go 侧记录过它跨 provider 传染，上游报 11133 且不指出字段）；
 * - `function.arguments` 不是字符串时序列化成 JSON 字符串，缺省补 `"{}"`
 *  （上游 Go 结构体把它定死为 string，传对象/数组/数字会 400 `code=11101`）。
 *
 * @returns 修整后的数组；无改动时返回 `undefined`
 */
function fixToolCalls(calls: unknown[]): unknown[] | undefined {
  let changed = false
  const out: unknown[] = []
  for (const call of calls) {
    if (!isObj(call)) {
      changed = true
      continue
    }
    const fn = call.function
    if (!isObj(fn)) {
      changed = true
      continue
    }
    const name = fn.name
    if (typeof name !== 'string' || name === '') {
      changed = true
      continue
    }
    const args = fn.arguments
    if (typeof args === 'string') {
      out.push(call)
      continue
    }
    let text: string
    if (args === undefined || args === null) {
      text = '{}'
    } else {
      try {
        text = JSON.stringify(args) ?? '{}'
      } catch {
        text = String(args)
      }
    }
    changed = true
    out.push({ ...call, function: { ...fn, arguments: text } })
  }
  return changed ? out : undefined
}

/** 提取单条 assistant 消息 `tool_calls` 里的非空字符串调用 ID（保持声明顺序）。 */
function declaredToolCallIds(raw: unknown): string[] {
  if (!isObj(raw) || raw.role !== 'assistant' || !Array.isArray(raw.tool_calls)) return []
  const ids: string[] = []
  for (const tc of raw.tool_calls as unknown[]) {
    if (isObj(tc) && typeof tc.id === 'string' && tc.id !== '') {
      ids.push(tc.id)
    }
  }
  return ids
}

/**
 * 将早于其 `assistant(tool_calls)` 出现的 `role: 'tool'` 消息移到对应 `assistant`
 *（及其紧随的连续 `role: 'tool'` 结果批次）之后（同步自 `workbuddy2api-panel` `27b7458`、`e14a3d0`）。
 *
 * ## 为什么必须排在配对管线最前面
 *
 * 部分客户端（特别是 Codex 经本地代理走 `/v1/responses` 时）会把 `function_call_output`
 * 排在声明它的 `function_call` 之前。若不先重排：
 * - `repackToolResultBlocks` 只从 `assistant` 起扫，前面的 `tool` 被原样放过；
 * - `cleanupOrphanToolCalls` 见两侧 ID 齐全判定「非孤儿」，倒置顺序直通上游触发 `400 code=11148`。
 *
 * ## 跨轮同 ID 安全归属（`e14a3d0` + 槽位容量守恒）
 *
 * 网关在流式缺 ID 时可能按轮内下标生成 `call_0` / `toolu_0`，多轮历史中同一 ID 会合法重复出现。
 * 按每个声明槽位追踪是否已配对：
 * - 若前序已有未配对的同 ID 声明槽位 ⇒ 正常顺序配对，原地不动；
 * - 否则向后寻找**最近**一个尚未认领的同 ID 声明槽位 ⇒ 归入该声明批次并预占槽位；
 * - 前后均无可用声明槽位的孤儿结果 ⇒ 原地不动，交由后续 `cleanupOrphanToolCalls` 裁剪；
 * - 本来有序的历史零改动，直接返回原数组引用。
 */
export function reorderEarlyToolResults(messages: unknown[]): unknown[] {
  if (messages.length < 2) return messages

  interface DeclSlot {
    declIdx: number
    claimed: boolean
  }
  const slotsById = new Map<string, DeclSlot[]>()
  for (let i = 0; i < messages.length; i += 1) {
    for (const id of declaredToolCallIds(messages[i])) {
      let list = slotsById.get(id)
      if (list === undefined) {
        list = []
        slotsById.set(id, list)
      }
      list.push({ declIdx: i, claimed: false })
    }
  }
  if (slotsById.size === 0) return messages

  const early = new Array<boolean>(messages.length).fill(false)
  const group = new Map<number, unknown[]>()
  let anyEarly = false

  for (let i = 0; i < messages.length; i += 1) {
    const raw = messages[i]
    if (!isObj(raw) || raw.role !== 'tool') continue
    const id = raw.tool_call_id
    if (typeof id !== 'string' || id === '') continue
    const slots = slotsById.get(id)
    if (slots === undefined) continue

    // 优先匹配前序（declIdx < i）尚未配对的最近/最早声明槽位 ⇒ 顺序正常，不搬移
    let matchedPrior = false
    for (const slot of slots) {
      if (slot.declIdx >= i) break
      if (!slot.claimed) {
        slot.claimed = true
        matchedPrior = true
        break
      }
    }
    if (matchedPrior) continue

    // 无前序未配对声明：向后找最近（declIdx > i）尚未认领的声明槽位
    for (const slot of slots) {
      if (slot.declIdx > i && !slot.claimed) {
        slot.claimed = true
        early[i] = true
        anyEarly = true
        let bucket = group.get(slot.declIdx)
        if (bucket === undefined) {
          bucket = []
          group.set(slot.declIdx, bucket)
        }
        bucket.push(raw)
        break
      }
    }
  }

  if (!anyEarly) return messages

  const out: unknown[] = []
  const pending: unknown[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    out.push(...pending)
    pending.length = 0
  }

  for (let i = 0; i < messages.length; i += 1) {
    if (early[i]) continue
    const raw = messages[i]
    const role = isObj(raw) && typeof raw.role === 'string' ? raw.role : ''
    // 紧随所属 assistant 的连续正常 tool 结果先出；遇到非 tool 消息时把同批早到结果补在末尾
    if (pending.length > 0 && role !== 'tool') {
      flush()
    }
    out.push(raw)
    const attached = group.get(i)
    if (attached !== undefined) {
      pending.push(...attached)
    }
  }
  flush()
  return out
}

/**
 * 合并**相邻**的 assistant `tool_calls` 消息（移植自 workbuddy2api-hub `merge_adjacent_tool_calls`）。
 *
 * 部分 agent 客户端把一批并行调用回放成**多条相邻 assistant**、每条只带一个 tool_call。
 * DeepSeek 系上游对这种形状回 400 `code=11148`（tool_call_sequence_broken），
 * 且每次重试都回放同样的历史 ⇒ 整条会话报废，换号也没用。
 *
 * 条件刻意收得很窄（不发明语义）：
 * - 形态 1：本条带 tool_calls 且**无正文**，前一条是带 tool_calls 的 assistant ⇒ 调用并入前一条；
 * - 形态 2：本条**不带** tool_calls、正文是非空字符串，前一条是带 tool_calls 且**无正文**的 assistant
 *   ⇒ 正文并入前一条（同一批被按另一种顺序拆开回放）。
 * 两种形态都保留 `reasoning_content`（DeepSeek 多轮思考要求原样带回）。
 */
export function mergeAdjacentToolCalls(messages: unknown[]): unknown[] {
  if (messages.length < 2) return messages
  const out: unknown[] = []
  let changed = false
  for (const m of messages) {
    const prev = out.length > 0 ? out[out.length - 1] : undefined
    if (isObj(m) && m.role === 'assistant' && isObj(prev) && prev.role === 'assistant') {
      const calls = m.tool_calls
      const prevCalls = prev.tool_calls
      // 形态 1
      if (Array.isArray(calls) && calls.length > 0 && isEmptyContent(m.content)
        && Array.isArray(prevCalls) && prevCalls.length > 0) {
        const merged: Msg = { ...prev, tool_calls: [...prevCalls, ...calls] }
        mergeReasoningContent(merged, m)
        out[out.length - 1] = merged
        changed = true
        continue
      }
      // 形态 2
      if (!('tool_calls' in m) && typeof m.content === 'string' && m.content !== ''
        && Array.isArray(prevCalls) && prevCalls.length > 0 && isEmptyContent(prev.content)) {
        const merged: Msg = { ...prev, content: m.content }
        mergeReasoningContent(merged, m)
        out[out.length - 1] = merged
        changed = true
        continue
      }
    }
    out.push(m)
  }
  return changed ? out : messages
}

/**
 * 让一批 tool 结果**紧跟**发起它的 assistant（移植自 workbuddy2api-hub `repack_tool_result_blocks`）。
 *
 * 上游要求 `role:'tool'` 结果紧跟请求它们的 assistant，中间不能夹别的消息。
 * 典型反例：Codex 的 `image_resize_notice` 以 developer 消息插在工具输出之后 ——
 * 并行调用时它落在两条结果之间 ⇒ 上游判配对断裂 ⇒ 400 `code=11148`，整条会话报废。
 *
 * 只**重排**：结果原样、相对顺序不变，插队的消息挪到整批结果之后。
 */
export function repackToolResultBlocks(messages: unknown[]): unknown[] {
  if (messages.length < 3) return messages
  const out: unknown[] = []
  let changed = false
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (!isObj(m) || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      out.push(m)
      i += 1
      continue
    }
    const want = new Set<string>()
    for (const tc of m.tool_calls as unknown[]) {
      if (isObj(tc) && typeof tc.id === 'string' && tc.id !== '') want.add(tc.id)
    }
    out.push(m)
    i += 1
    const results: unknown[] = []
    const between: unknown[] = []
    while (i < messages.length) {
      const mm = messages[i]
      if (!isObj(mm)) break
      if (mm.role === 'tool') {
        const id = mm.tool_call_id
        if (!(typeof id === 'string' && want.has(id))) break
        results.push(mm)
        i += 1
        continue
      }
      // 任何 assistant 都结束这一批
      if (mm.role === 'assistant') break
      // 非结果消息只有在**后面还有本批结果**时才算「插队者」（挪到整批之后）；
      // 否则是正常的后续消息，原样留给外层循环
      let j = i
      while (j < messages.length) {
        const nx = messages[j]
        if (!isObj(nx) || nx.role === 'tool' || nx.role === 'assistant') break
        j += 1
      }
      const nx = messages[j]
      const moreResults =
        isObj(nx) && nx.role === 'tool' && typeof nx.tool_call_id === 'string' && want.has(nx.tool_call_id)
      if (!moreResults) break
      for (; i < j; i += 1) between.push(messages[i])
    }
    if (results.length > 0) {
      out.push(...results, ...between)
      if (between.length > 0) changed = true
    } else {
      out.push(...between)
    }
  }
  return changed ? out : messages
}

/**
 * 两侧同时剪孤儿（移植自 workbuddy2api-hub `cleanup_orphan_tool_calls`）：
 * - 没有结果的 tool_call 删掉（工具调用失败/超时后客户端**永远不会**补结果，
 *   但这条声明会跟着历史每轮重发，上游每轮都 400 `code=11148`）；
 * - 没有声明的 tool 结果删掉。
 *
 * 两侧按**同一个 id 交集**修剪，不会留下半个配对。
 */
export function cleanupOrphanToolCalls(messages: unknown[]): unknown[] {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  let sawTool = false
  for (const m of messages) {
    if (!isObj(m)) continue
    if (m.role === 'tool') {
      sawTool = true
      const id = m.tool_call_id
      if (typeof id === 'string' && id !== '') resultIds.add(id)
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as unknown[]) {
        if (isObj(tc) && typeof tc.id === 'string' && tc.id !== '') callIds.add(tc.id)
      }
    }
  }
  if (!sawTool && callIds.size === 0) return messages

  let changed = false
  const out: unknown[] = []
  for (const m of messages) {
    if (!isObj(m)) {
      out.push(m)
      continue
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id
      if (typeof id === 'string' && callIds.has(id) && resultIds.has(id)) {
        out.push(m)
      } else {
        changed = true
      }
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const calls = m.tool_calls as unknown[]
      const kept = calls.filter((tc) => isObj(tc) && typeof tc.id === 'string' && resultIds.has(tc.id))
      if (kept.length !== calls.length) {
        changed = true
        const copy: Msg = { ...m }
        if (kept.length > 0) copy.tool_calls = kept
        else delete copy.tool_calls
        out.push(copy)
        continue
      }
    }
    out.push(m)
  }
  return changed ? out : messages
}

/** 消息裁剪结果。 */
export interface TrimMessagesResult {
  /**
   * 裁剪后的消息数组。
   *
   * ⚠️ **未超限时返回的就是入参本身**（同一个引用），调用方靠 `result.messages !== messages`
   * 就能判断「有没有动过」—— 与 `cleanupToolPairing` / `scrubFingerprints` 的口径一致。
   */
  messages: unknown[]
  /** 被省略的**更早**消息条数（0 = 未裁剪）。供日志用，不含任何消息内容。 */
  dropped: number
}

/** 摘要提示消息的抬头（日志与测试都按它识别，改文案时先看这里）。 */
export const CONTEXT_TRIM_NOTE_PREFIX = '（系统提示·上下文压缩）'

/**
 * 构造一条「更早的消息已省略」的提示消息。
 *
 * ⚠️ 刻意用 `role: 'system'` 而不是 `user`：
 * - 用 `user` 会在「上一条恰好也是 user」时形成**连续两条 user**，Gemini 系要求
 *   user/model 交替，会被判非法请求（本项目的 gemini provider 也按 `role` 分流）；
 * - 用 `user` 还会让模型把这段提示当成**用户真的说过的话**，进而顺着它回答。
 *   而 `system` 在 gemini provider 里被并进 `systemInstruction`（见 `gemini.ts`），
 *   在 OpenAI 兼容上游里也是合法位置。
 *
 * ⚠️ **不得**把被省略的消息内容摘进这条提示：那等于把隐私写进日志/上下文，
 * 也失去「压缩」的意义。
 *
 * ⚠️ **文案必须与当轮条数无关**（这条踩过）：
 * 早先写的是「更早的 619 条消息…最近 101 条」，而这两个数字**每一轮都在变**
 *（窗口随对话滑动）。于是 [首条 system + 摘要] 这一段前缀**每轮都不同** ⇒
 * 上游 prefix cache 在摘要处就断掉，整段历史每轮全价重算。
 * 现在只描述「发生过截断」这个事实，数字只进日志（日志不进上下文、不影响缓存）。
 * 换来的收益：首条 system + 摘要 成为稳定前缀，可被缓存命中。
 */
function buildTrimNote(): Msg {
  return {
    role: 'system',
    content:
      `${CONTEXT_TRIM_NOTE_PREFIX} 更早的消息因超出单请求消息数上限已被省略，`
      + '下面紧接的是保留的最近原文。省略的只是历史长度，不影响当前任务的上下文；'
      + '若确实需要其中某个细节，请向用户确认后重新索取。',
  }
}

/**
 * 单请求消息数**硬上限**：超出就把更早的历史折叠成一条「已省略 X 条」的提示。
 *
 * ## 为什么必须做（真实依据，不是预防性设计）
 *
 * 同类项目 workbuddy2api 的封禁复盘记录：三次账号封禁前，**最后一次成功请求都是超大消息数**
 * —— 2552 条、428→434 条、987~993 条连发。上游腾讯云风控把「超大上下文 + 高频」识别为
 * 机器行为。本项目此前**原样转发**上千条消息，这是最明确的危险信号。
 *
 * ## 保留规则
 *
 * - **首条 system（含 `developer`）恒保留**：身份/规则丢了这个会话就废了；
 *   只认**数组开头那一条** —— 不去别处搜 system（把中间的 system 提到最前面会改变语义，
 *   上游对 system 的位置也敏感）。
 * - **保留最近 `limit` 条**。
 * - 中间插一条摘要提示（`buildTrimNote`）。
 *
 * ⇒ 结果条数最多为 `1（system，若有）+ 1（摘要）+ limit`。`limit` 定义的是
 *   「保留的最近历史条数」，与 `MAX_CONTEXT_MESSAGES` 的语义一致（默认 100）。
 *
 * ## ⚠️ 绝不能把 tool_calls 与对应 tool_result 拆散
 *
 * 上游要求每个 `role:'tool'` 结果都有**前序** assistant 的 `tool_calls` 与之配对，
 * 否则对之后每条消息都回 400 `code=11148`（整条会话报废、换号也没用，见
 * `cleanupToolPairing` 的说明）。裁剪窗口的左边界最容易制造这种孤儿：
 * 起点若落在一条 `role:'tool'` 上，它对应的 assistant 声明已经在被丢掉的那一段里。
 *
 * 处置：把左边界**向后**推进到第一条非 tool 消息（宁可少留几条，也不留半个配对）。
 * 最后再复用 `cleanupOrphanToolCalls` 按**同一套 id 交集判据**兜一遍 ——
 * 正常情况下它是空操作（返回同一引用），只在入参本身就带着破损历史时才真删东西。
 *
 * 兜底：若整个窗口都是 tool 结果（并行批次长到占满窗口），向后让位会**一条都不剩**，
 * 只留 `[system, 摘要]` 的请求在部分上游会被判「缺少 user 消息」400 ⇒ 此时改为
 * 向**前回溯**到发起这批调用的 assistant，把「声明 + 全部结果」整批留下。
 * 即边界修复只允许**扩张**窗口，绝不拆散配对、也不留空尾巴。
 *
 * @param limit ≤ 0 表示**显式不限制**（`0` 是合法配置值，绝不能用 `limit || 默认值` 判）
 */
export function trimMessagesByLimit(messages: unknown[], limit: number): TrimMessagesResult {
  // ⚠️ 判据用 `!(limit > 0)` 而不是 `!limit`：`NaN` 同样该被当成「不限制」的非法输入，
  // 而 `limit === 0` 是**用户显式要求放开**的合法值。
  if (!(limit > 0) || messages.length <= limit) return { messages, dropped: 0 }

  const head = messages[0]
  const keepHead = isObj(head) && (head.role === 'system' || head.role === 'developer')
  const reserved = keepHead ? 1 : 0

  // 最近 limit 条的左边界。
  const naiveStart = messages.length - limit
  if (naiveStart < reserved) return { messages, dropped: 0 } // 防御：窗口与首条重叠 ⇒ 没得剪
  let start = naiveStart

  // 左边界**向后**推到第一条非 tool 消息（见函数头「绝不能拆散配对」）。
  while (start < messages.length) {
    const m = messages[start]
    if (isObj(m) && m.role === 'tool') start += 1
    else break
  }

  // 兜底：窗口整段都是 tool 结果 ⇒ 向后让位会一条不剩，改为回溯到发起这批调用的 assistant。
  if (start >= messages.length) {
    for (let back = naiveStart; back > reserved; back -= 1) {
      const m = messages[back]
      if (isObj(m) && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        start = back
        break
      }
    }
  }

  const dropped = start - reserved
  if (dropped <= 0) return { messages, dropped: 0 }

  const out: unknown[] = []
  if (keepHead) out.push(head)
  const kept = messages.length - start
  out.push(buildTrimNote())
  for (let i = start; i < messages.length; i += 1) out.push(messages[i])

  // 兜底：同一套「id 交集」判据（与出站前的配对修复**共用**一个实现，不重写一遍）。
  return { messages: cleanupOrphanToolCalls(out), dropped }
}

/**
 * 工具配对修复：developer 角色处理 + tool_call 修整 + 相邻合并 + 结果重排 + 两侧剪孤儿。
 *
 * ## 为什么必须做（Go 侧 `tool_pairing.go` 记录的严重缺陷）
 *
 * OpenAI 规范要求每个 `role:'tool'` 消息都有一个**前序** assistant 消息里的
 * `tool_calls` 与之配对（靠 `tool_call_id`），且结果紧跟调用。
 *
 * 若配对不完整，上游会**对之后每条消息都返 400**（`code=11148`）——
 * 也就是整条会话报废，且错误信息不指出是哪个字段。
 *
 * 客户端在中断/重试/切模型/工具失败时很容易产生这类历史，故必须先行修复。
 * 合并 / 重排 / 两侧剪孤儿三步移植自 ardeyouxipianyi/workbuddy2api-hub（MIT）。
 *
 * ⚠️ **不修改入参**：要改的消息一律复制后再改（重试会复用同一份请求体）。
 *
 * @returns 清理后的消息数组（无改动时返回原数组）
 */
export function cleanupToolPairing(messages: unknown[]): unknown[] {
  // ⚡ 性能快判：如果消息历史中完全没有 developer、tool 角色，也没有任何 tool_calls，
  // 直接原样返回，彻底免除双重扫描与新数组内存分配（长对话省下数毫秒 CPU）。
  let needsScan = false
  for (const raw of messages) {
    if (raw !== null && typeof raw === 'object') {
      const msg = raw as Record<string, unknown>
      if (msg.role === 'developer' || msg.role === 'tool' || msg.tool_calls !== undefined) {
        needsScan = true
        break
      }
    }
  }
  if (!needsScan) return messages

  let out: unknown[] = []
  let changed = false

  for (const raw of messages) {
    if (!isObj(raw)) {
      out.push(raw)
      continue
    }
    const msg = raw

    // ⚠️ **处理 `role: 'developer'` 消息**（实测缺陷，用户报两处 11128）。
    //
    // OpenAI 的**新**规范引入了 `developer` 角色，而**上游只认**
    // `system` / `user` / `assistant` / `tool`。
    // 实测：pi（`pi-coding-agent`）把系统提示词放在
    // `{role:'developer', content:'You are an expert coding assistant…'}` 里，
    // 原样转发 ⇒ 上游判定「首条不是 system」⇒ 国际版回
    // `11128 Illegal API invocation from an unapproved channel`。
    //
    // 内容非空时**降级为 `system`**（保住提示词语义），只有空内容（纯元数据，如
    // `tool-addition` / `tool-removal`）才真正丢弃。
    if (msg.role === 'developer') {
      const content = msg.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('')
          : ''
      changed = true
      if (text.trim() === '') continue // 纯元数据 ⇒ 丢弃
      out.push({ role: 'system', content: msg.content })
      continue
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const fixed = fixToolCalls(msg.tool_calls as unknown[])
      if (fixed !== undefined) {
        changed = true
        const copy: Msg = { ...msg }
        if (fixed.length > 0) copy.tool_calls = fixed
        else delete copy.tool_calls
        out.push(copy)
        continue
      }
    }

    out.push(msg)
  }

  // ⚠️ 顺序即语义：先将早到的 tool 结果挪回所属声明之后，再合并拆开的声明，再重排插队消息，最后剪孤儿。
  for (const step of [reorderEarlyToolResults, mergeAdjacentToolCalls, repackToolResultBlocks, cleanupOrphanToolCalls]) {
    const next = step(out)
    if (next !== out) {
      changed = true
      out = next
    }
  }

  return changed ? out : messages
}

/** 模型裸名（去掉 `provider/` 前缀，小写）。 */
function bareModel(model: unknown): string {
  if (typeof model !== 'string') return ''
  const i = model.lastIndexOf('/')
  return (i >= 0 ? model.slice(i + 1) : model).trim().toLowerCase()
}

/**
 * DeepSeek 本轮是否处于**思考模式**（口径同 workbuddy2api-hub `build_upstream_body`）：
 * `thinking.type === 'enabled'`，或没有显式关闭（`type !== 'disabled'` 且 `reasoning_effort !== 'none'`）。
 */
export function isDeepseekThinking(body: Record<string, unknown>): boolean {
  if (!bareModel(body.model).startsWith('deepseek')) return false
  const thinking = body.thinking
  const type = isObj(thinking) && typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : ''
  if (type === 'enabled') return true
  const effort = body.reasoning_effort ?? body.reasoningEffort
  const effortText = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  return type !== 'disabled' && effortText !== 'none'
}

/**
 * DeepSeek：客户端**显式开了思考**（`thinking.type === 'enabled'`）却没给档位时补 `high`。
 *
 * 上游只认档位：workbuddy2api-hub 实测 deepseek-v4.1-flash 同一提示词下，
 * `thinking.enabled` 不带档位 ⇒ reasoning_tokens 0；带 `reasoning_effort=high` ⇒ 正常思考。
 * 只补「明确要思考却没说多深」这一种；没开思考、显式关闭或客户端自己给了档位都不碰
 *（hub 默认对所有 DeepSeek 请求强补 high，曾导致整轮都在思考、没有正文，hub #508）。
 *
 * @returns 是否改动
 */
export function fillDeepseekEffort(body: Record<string, unknown>): boolean {
  if (!bareModel(body.model).startsWith('deepseek')) return false
  const thinking = body.thinking
  if (!isObj(thinking) || typeof thinking.type !== 'string' || thinking.type.trim().toLowerCase() !== 'enabled') return false
  const effort = body.reasoning_effort ?? body.reasoningEffort
  if (typeof effort === 'string' ? effort.trim() !== '' : effort !== undefined && effort !== null) return false
  body.reasoning_effort = 'high'
  delete body.reasoningEffort
  return true
}

/**
 * DeepSeek 多轮一致性：给每条 assistant 补 `reasoning_content`（移植自 workbuddy2api-hub）。
 *
 * 上游在思考模式下要求每条 assistant 都带回 `reasoning_content` 字符串，否则 400
 * `code=11155`（the reasoning content from the previous turn must be passed back in thinking mode）。
 * 第三方客户端普遍**不回传**思考内容（本项目的 Responses 转换也刻意丢弃 reasoning 项）。
 *
 * - 触发：DeepSeek 模型，且思考模式开启**或**历史里已有思考痕迹；
 * - `reasoning_content` 不是字符串时补成 `reasoning`（若有）或 `''`；
 * - 上游还校验 `reasoning` 非空 ⇒ 镜像到 `reasoning`，空时用一个空格占位（不带任何语义）。
 */
export function backfillReasoningContent(messages: unknown[], model: unknown, thinkingEnabled: boolean): unknown[] {
  if (!bareModel(model).startsWith('deepseek')) return messages
  let hasTrace = false
  for (const m of messages) {
    if (!isObj(m)) continue
    if ((typeof m.reasoning === 'string' && m.reasoning !== '') || 'reasoning_content' in m) {
      hasTrace = true
      break
    }
  }
  if (!thinkingEnabled && !hasTrace) return messages

  let changed = false
  const out = messages.map((m) => {
    if (!isObj(m) || m.role !== 'assistant') return m
    let rc = m.reasoning_content
    const needRc = typeof rc !== 'string'
    if (needRc) rc = typeof m.reasoning === 'string' ? m.reasoning : ''
    const needMirror = !(typeof m.reasoning === 'string' && m.reasoning !== '')
    if (!needRc && !needMirror) return m
    changed = true
    const item: Msg = { ...m, reasoning_content: rc }
    if (needMirror) item.reasoning = rc !== '' ? rc : ' '
    return item
  })
  return changed ? out : messages
}

/**
 * 空 `text` 段补一个空格（移植自 workbuddy2api-hub #840）。
 *
 * 上游对每个 `type:"text"` 段做长度校验：空串回 400 `code=11151`，
 * 且会把该会话标脏、后续重试同样失败。客户端（尤其是 Anthropic / Responses
 * 转 Chat 的路径）常常产出只有图片没有文字的 text 段。
 */
export function padEmptyTextParts(messages: unknown[]): unknown[] {
  let changed = false
  const out = messages.map((m) => {
    if (!isObj(m) || !Array.isArray(m.content)) return m
    let touched = false
    const parts = m.content.map((part) => {
      if (!isObj(part) || part.type !== 'text' || typeof part.text !== 'string' || part.text !== '') return part
      touched = true
      return { ...part, text: ' ' }
    })
    if (!touched) return m
    changed = true
    return { ...m, content: parts }
  })
  return changed ? out : messages
}

/**
 * 把非空 `reasoning_content` 镜像到上游读取的 `reasoning` 字段
 * （移植自 workbuddy2api-hub v2.0.2）。
 *
 * kimi / glm / minimax / mimo / step / space-bunny 的上游只读 `reasoning`，
 * 而客户端回放历史时往往只带 `reasoning_content`。只镜像**非空**内容，
 * 不写空白占位（DeepSeek 那条路径的占位规则见 {@link backfillReasoningContent}）。
 */
const REASONING_MIRROR_PREFIXES = ['kimi', 'glm', 'minimax', 'mimo', 'step', 'space-bunny'] as const

export function mirrorReasoningContent(messages: unknown[], model: unknown): unknown[] {
  const bare = bareModel(model)
  if (bare === '' || !REASONING_MIRROR_PREFIXES.some((prefix) => bare.startsWith(prefix))) return messages
  let changed = false
  const out = messages.map((m) => {
    if (!isObj(m) || m.role !== 'assistant') return m
    const rc = m.reasoning_content
    if (typeof rc !== 'string' || rc === '') return m
    if (typeof m.reasoning === 'string' && m.reasoning !== '') return m
    changed = true
    return { ...m, reasoning: rc }
  })
  return changed ? out : messages
}

/**
 * `stop` 归一化：字符串 → 单元素数组（移植自 workbuddy2api-hub `normalize_stop`）。
 *
 * OpenAI 允许 `string | string[]`，上游 Go 端却定死为 `[]string`：
 * `"stop":"END"` ⇒ 400 `code=11101`，`"stop":["END"]` ⇒ 200。语义完全等价。
 * 空串 / 空数组 / null / 非法类型一律删字段（含义都是「没有停止序列」）。
 *
 * @returns 是否改动
 */
export function normalizeStop(body: Record<string, unknown>): boolean {
  if (!('stop' in body)) return false
  const val = body.stop
  if (Array.isArray(val) && val.length > 0 && val.every((s) => typeof s === 'string' && s !== '')) return false
  const list = typeof val === 'string'
    ? (val === '' ? [] : [val])
    : Array.isArray(val)
      ? val.filter((s): s is string => typeof s === 'string' && s !== '')
      : []
  if (list.length > 0) body.stop = list
  else delete body.stop
  return true
}

/**
 * GPT 系上游要求输出上限 ≥ 16，更小（探针常用 `max_tokens:1`）会 400 `integer_below_min_value`。
 *
 * @returns 是否改动
 */
export function clampGptMaxTokens(body: Record<string, unknown>): boolean {
  if (!bareModel(body.model).startsWith('gpt-')) return false
  const mt = body.max_tokens
  if (typeof mt !== 'number' || !Number.isFinite(mt) || mt >= 16) return false
  body.max_tokens = 16
  return true
}

const MAX_SCHEMA_DEPTH = 64

const SCHEMA_TYPE_ALIAS: Record<string, string> = {
  str: 'string',
  text: 'string',
  int: 'integer',
  bool: 'boolean',
  dict: 'object',
  list: 'array',
  float: 'number',
}
const SCHEMA_VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

/**
 * 值本身是**用户数据**而非 JSON Schema 节点的关键字（`workbuddy2api-panel` `d6301fe`）。
 *
 * - `default` / `const` / `example` 允许直接取值为 `null`（如 `const: null`、`default: null`），不能当缺失元数据删掉；
 * - 这五个键内部出现的任何对象（哪怕含 `type: "str"`、`items`、`required`、`null`）都是客户端声明的字面取值，
 *   **严禁递归进去按 Schema 改写**。
 */
const SCHEMA_NULLABLE_DATA_KEYS = new Set(['default', 'const', 'example'])
const SCHEMA_DATA_KEYS = new Set(['default', 'const', 'enum', 'example', 'examples'])

/** 自身键是用户属性名/定义名的纯子 Schema 映射容器（容器键本身绝不当 Schema 关键字处理，`615dc75`）。 */
const SCHEMA_MAP_CONTAINERS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const

/** 组合子 Schema 列表关键字（空数组或非数组会被上游拒 11129，`dsh-connect-workbuddy` `#253`）。 */
const SCHEMA_COMPOSITION_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const

/** 单子 Schema 关键字（合法值为 boolean schema 或 plain object schema）。 */
const SCHEMA_SINGLE_SUBSCHEMAS = [
  'additionalProperties',
  'additionalItems',
  'not',
  'contains',
  'if',
  'then',
  'else',
  'propertyNames',
] as const

const SCHEMA_STRING_KEYWORDS = [
  'title',
  'description',
  'pattern',
  'format',
  '$comment',
  'contentMediaType',
  'contentEncoding',
  '$id',
  '$schema',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
] as const

const SCHEMA_NUMBER_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
] as const

const SCHEMA_BOOLEAN_KEYWORDS = ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'] as const

/**
 * UTF-16 代理区码元转义 `\uD800`–`\uDFFF`（含单反斜杠、字面双反斜杠 `\\uD800`、花括号 `\u{D800}`
 * 及单层 JSON 解析落入内存的孤立代理码元，十六进制大小写不敏感）。
 *
 * 依据：
 * - `dingminhua/dsh-connect-workbuddy` 提交 `e5d53ef`（issue #274，REA MCP 260 工具实测）：
 *   上游 RE2 schema 解析器拒绝 `pattern` 中出现的 `\uD800`–`\uDFFF`（报 400 `code=11129` 整包工具被拒），
 *   而边界外的 `\uD7FF` / `\uE000`、合法代理对（真实 emoji 字符）以及非 `pattern` 字段中的同款字面量均返回 200；
 * - `misakano7545/workbuddy2api-panel` 提交 `abed839`（issue #276）：
 *   覆盖字面双反斜杠 `\\uD800`–`\\uDFFF`、`\u{D800}`–`\u{DFFF}` 与内存态孤立代理码元（`JSON.stringify`
 *   在出站时会把孤立 UTF-16 代理重新序列化成 `\ud800`–`\udfff`）。
 */
const SURROGATE_ESCAPE_RE =
  /\\+u\{0*[dD][89a-fA-F][0-9a-fA-F]{2}\}|\\+u[dD][89a-fA-F][0-9a-fA-F]{2}/

function hasLoneSurrogateCodeUnit(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1 // 合法代理对（如真实 emoji），整体跳过不误删
        continue
      }
      return true
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function hasIllegalSurrogatePattern(pattern: string): boolean {
  return SURROGATE_ESCAPE_RE.test(pattern) || hasLoneSurrogateCodeUnit(pattern)
}

/** 当 `enum` 存在但缺 `type` 时，仅在所有元素同属单一标量类型时无损推断 `type`（`615dc75`）。 */
function inferEnumType(values: unknown[]): string {
  if (values.length === 0) return ''
  let kind = ''
  let allInt = true
  for (const v of values) {
    if (typeof v === 'string') {
      if (kind !== '' && kind !== 'string') return ''
      kind = 'string'
    } else if (typeof v === 'boolean') {
      if (kind !== '' && kind !== 'boolean') return ''
      kind = 'boolean'
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      if (kind !== '' && kind !== 'number') return ''
      kind = 'number'
      if (!Number.isInteger(v)) allInt = false
    } else {
      // 含 null / 对象 / 数组或混合类型时不猜测
      return ''
    }
  }
  if (kind === 'number') return allInt ? 'integer' : 'number'
  return kind
}

/** 将 draft-4 布尔型 `exclusiveMinimum` / `exclusiveMaximum` 安全转换为现代数值型（`dsh-connect-workbuddy` `#253`）。 */
function normalizeExclusiveBound(
  s: Msg,
  exclusiveKey: 'exclusiveMinimum' | 'exclusiveMaximum',
  boundKey: 'minimum' | 'maximum',
  mark: () => void,
): void {
  const val = s[exclusiveKey]
  if (val === false) {
    delete s[exclusiveKey]
    mark()
    return
  }
  if (val !== true) return
  const bound = s[boundKey]
  if (typeof bound === 'number' && Number.isFinite(bound)) {
    s[exclusiveKey] = bound
    delete s[boundKey]
  } else {
    delete s[exclusiveKey]
  }
  mark()
}

/**
 * 递归规整单个 JSON Schema 节点（就地修改副本，合规字段零改动以稳定 prompt cache）。
 *
 * 覆盖：
 * - 剔除值为 `null` 的非数据关键字，保留 `const: null` / `default: null` / `example: null`（`d6301fe`）；
 * - 剥离 `pattern` 中含 `\uD800`–`\uDFFF` 代理区转义的正则（`e5d53ef`），修复 `\_` 非标转义（`615dc75`）；
 * - draft-4 布尔 `exclusiveMinimum`/`exclusiveMaximum`、外部 `$ref`、重复/字符串 `required`、元关键字类型纠偏；
 * - 严格区分 Schema 节点、容器键（`properties` / `dependencies` / `dependentRequired` 等）与数据键
 *   （`default` / `const` / `enum` / `example` / `examples`），绝不篡改用户参数名或数据字面量。
 */
function normalizeSchema(s: Msg, mark: () => void, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) return

  // 1. 剔除值为 null 的非数据关键字（保留 default:null / const:null / example:null）
  for (const k of Object.keys(s)) {
    if (s[k] === null && !SCHEMA_NULLABLE_DATA_KEYS.has(k)) {
      delete s[k]
      mark()
    }
  }

  // 2. Draft-4 布尔型开区间边界迁移（必须在数值类型校验前执行）
  normalizeExclusiveBound(s, 'exclusiveMinimum', 'minimum', mark)
  normalizeExclusiveBound(s, 'exclusiveMaximum', 'maximum', mark)

  // 3. 剥离无法被上游解析的外部 $ref（保留 #/... 文档内引用）
  if ('$ref' in s) {
    const ref = s.$ref
    if (typeof ref !== 'string' || ref.trim() === '' || !ref.startsWith('#')) {
      delete s.$ref
      mark()
    }
  }

  // 4. 元 Schema 标量/数组关键字类型纠偏
  for (const k of SCHEMA_STRING_KEYWORDS) {
    if (k in s && typeof s[k] !== 'string') {
      delete s[k]
      mark()
    }
  }
  for (const k of SCHEMA_NUMBER_KEYWORDS) {
    if (k in s && (typeof s[k] !== 'number' || !Number.isFinite(s[k] as number))) {
      delete s[k]
      mark()
    }
  }
  for (const k of SCHEMA_BOOLEAN_KEYWORDS) {
    if (k in s && typeof s[k] !== 'boolean') {
      delete s[k]
      mark()
    }
  }
  for (const k of ['enum', 'examples'] as const) {
    if (k in s && !Array.isArray(s[k])) {
      delete s[k]
      mark()
    }
  }

  // 5. pattern 规整：剥离 \uD800–\uDFFF / \\uD800–\\uDFFF / 孤立代理区转义（e5d53ef / abed839），修复 \_（615dc75）
  if (typeof s.pattern === 'string') {
    if (hasIllegalSurrogatePattern(s.pattern)) {
      delete s.pattern
      mark()
    } else if (s.pattern.includes('\\_')) {
      s.pattern = s.pattern.replaceAll('\\_', '_')
      mark()
    }
  }

  // 6. type 别名归一化、联合类型数组清洗与 enum 缺 type 推断
  if ('type' in s) {
    const typ = s.type
    if (typeof typ === 'string') {
      const lower = typ.trim().toLowerCase()
      const alias = SCHEMA_TYPE_ALIAS[lower]
      const next = alias ?? (SCHEMA_VALID_TYPES.has(lower) ? lower : undefined)
      if (next === undefined) {
        mark()
        if ('properties' in s) s.type = 'object'
        else if ('items' in s) s.type = 'array'
        else delete s.type
      } else if (next !== typ) {
        s.type = next
        mark()
      }
    } else if (Array.isArray(typ)) {
      const list: string[] = []
      for (const t of typ) {
        if (typeof t !== 'string' || t.trim() === '') continue
        const lower = t.trim().toLowerCase()
        const mapped = SCHEMA_TYPE_ALIAS[lower] ?? lower
        if (SCHEMA_VALID_TYPES.has(mapped) && !list.includes(mapped)) {
          list.push(mapped)
        }
      }
      if (list.length === 0) {
        delete s.type
        mark()
      } else if (list.length !== typ.length || list.some((t, i) => t !== typ[i])) {
        s.type = list
        mark()
      }
    } else {
      delete s.type
      mark()
    }
  } else if (!('properties' in s) && Array.isArray(s.enum) && s.enum.length > 0) {
    const inferred = inferEnumType(s.enum)
    if (inferred !== '') {
      s.type = inferred
      mark()
    }
  }

  if (s.type === 'object' || ('properties' in s && s.type === undefined)) {
    if (s.type === undefined) {
      s.type = 'object'
      mark()
    }
    if (!isObj(s.properties)) {
      s.properties = {}
      mark()
    }
  }

  // 7. required 规整（去空、去非字符串、去重；空数组删除）
  if ('required' in s) {
    const req = s.required
    if (Array.isArray(req)) {
      const cleaned: string[] = []
      for (const x of req) {
        if (typeof x !== 'string') continue
        const trimmed = x.trim()
        if (trimmed === '' || cleaned.includes(trimmed)) continue
        cleaned.push(trimmed)
      }
      if (cleaned.length === 0) {
        delete s.required
        mark()
      } else if (cleaned.length !== req.length || cleaned.some((x, i) => x !== req[i])) {
        s.required = cleaned
        mark()
      }
    } else if (typeof req === 'string' && req.trim() !== '') {
      s.required = [req.trim()]
      mark()
    } else {
      delete s.required
      mark()
    }
  }

  // 8. items 规整（解包 tuple 数组，递归子 Schema）
  if ('items' in s) {
    const items = s.items
    if (Array.isArray(items)) {
      const first = items.find(isObj)
      s.items = first !== undefined ? { ...first } : { type: 'string' }
      mark()
      if (isObj(s.items)) normalizeSchema(s.items, mark, depth + 1)
    } else if (isObj(items)) {
      normalizeSchema(items, mark, depth + 1)
    } else if (typeof items !== 'boolean') {
      delete s.items
      mark()
    }
  }

  // 9. 容器级映射：键名是用户属性名/定义名（绝不当 Schema 关键字改写），仅递归其子 Schema
  for (const key of SCHEMA_MAP_CONTAINERS) {
    if (!(key in s)) continue
    const container = s[key]
    if (!isObj(container)) {
      if (key === 'properties' && s.type === 'object') s.properties = {}
      else delete s[key]
      mark()
      continue
    }
    if (key === 'patternProperties') {
      let keyFixed = false
      const rebuilt: Msg = {}
      for (const [pk, pv] of Object.entries(container)) {
        let nextKey = pk
        if (hasIllegalSurrogatePattern(nextKey)) {
          keyFixed = true
          continue
        }
        if (nextKey.includes('\\_')) {
          nextKey = nextKey.replaceAll('\\_', '_')
          keyFixed = true
        }
        rebuilt[nextKey] = pv
      }
      if (keyFixed) {
        s.patternProperties = rebuilt
        mark()
      }
    }
    const target = s[key] as Msg
    for (const [propName, child] of Object.entries(target)) {
      if (child === null) {
        delete target[propName]
        mark()
        continue
      }
      if (isObj(child)) {
        normalizeSchema(child, mark, depth + 1)
      } else if (typeof child !== 'boolean') {
        delete target[propName]
        mark()
      }
    }
  }

  // 10. 依赖容器：dependentRequired 与 draft-4/7 dependencies（键是用户属性名！）
  if ('dependentRequired' in s) {
    const dr = s.dependentRequired
    if (!isObj(dr)) {
      delete s.dependentRequired
      mark()
    } else {
      for (const [propName, depList] of Object.entries(dr)) {
        if (!Array.isArray(depList)) {
          delete dr[propName]
          mark()
          continue
        }
        const cleaned = depList.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        if (cleaned.length !== depList.length) {
          dr[propName] = cleaned
          mark()
        }
      }
    }
  }

  if ('dependencies' in s) {
    const deps = s.dependencies
    if (!isObj(deps)) {
      delete s.dependencies
      mark()
    } else {
      for (const [propName, depVal] of Object.entries(deps)) {
        if (depVal === null) {
          delete deps[propName]
          mark()
        } else if (Array.isArray(depVal)) {
          const cleaned = depVal.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          if (cleaned.length !== depVal.length) {
            deps[propName] = cleaned
            mark()
          }
        } else if (isObj(depVal)) {
          normalizeSchema(depVal, mark, depth + 1)
        } else if (typeof depVal !== 'boolean') {
          delete deps[propName]
          mark()
        }
      }
    }
  }

  // 11. 组合子 Schema 列表（allOf / anyOf / oneOf / prefixItems）
  for (const key of SCHEMA_COMPOSITION_LISTS) {
    if (!(key in s)) continue
    const rawList = s[key]
    if (!Array.isArray(rawList) || rawList.length === 0) {
      delete s[key]
      mark()
      continue
    }
    const kept = rawList.filter((v) => isObj(v) || typeof v === 'boolean')
    if (kept.length === 0) {
      delete s[key]
      mark()
      continue
    }
    if (kept.length !== rawList.length) {
      s[key] = kept
      mark()
    }
    for (const v of kept) {
      if (isObj(v)) normalizeSchema(v, mark, depth + 1)
    }
  }

  // 12. 单子 Schema 关键字（additionalProperties / not / if / then / else / contains / propertyNames）
  for (const key of SCHEMA_SINGLE_SUBSCHEMAS) {
    if (!(key in s)) continue
    const sub = s[key]
    if (typeof sub === 'boolean') continue
    if (isObj(sub)) {
      normalizeSchema(sub, mark, depth + 1)
    } else {
      delete s[key]
      mark()
    }
  }

  void SCHEMA_DATA_KEYS
}

/**
 * 归一化单个工具顶层 `parameters` JSON Schema（无改动时返回原对象引用）。
 */
export function normalizeToolParameters(params: unknown): Msg {
  if (!isObj(params)) return { type: 'object', properties: {} }
  let changed = false
  const mark = (): void => {
    changed = true
  }
  const p = structuredClone(params) as Msg
  if (typeof p.type === 'string') {
    const lower = p.type.trim().toLowerCase()
    const mapped = SCHEMA_TYPE_ALIAS[lower] ?? lower
    if (mapped !== 'object') {
      p.type = 'object'
      mark()
    } else if (p.type !== 'object') {
      p.type = 'object'
      mark()
    }
  } else {
    p.type = 'object'
    mark()
  }
  if (!isObj(p.properties)) {
    p.properties = {}
    mark()
  }
  normalizeSchema(p, mark, 0)
  return changed ? p : params
}

/** 修一个 function 定义的 `parameters`（返回新对象；无改动返回原对象）。 */
function normalizeFunctionDef(fn: Msg): Msg {
  const nextParams = normalizeToolParameters(fn.parameters)
  return nextParams === fn.parameters ? fn : { ...fn, parameters: nextParams }
}

/**
 * 工具声明归一化（移植自 workbuddy2api-hub `normalize_tools`，避免 400 `code=11129`）：
 * - 老客户端的根级 `functions` → `tools`；
 * - 顶层 `{name, description, parameters}` 写法包成 `{type:'function', function:{…}}`；
 * - `parameters` 缺失/非对象 → 空 object schema；不合法的 schema 递归修复；
 * - 既无 `function` 也无 `name` 的条目（如 Responses 的内置工具）丢弃 —— 上游只认 function 工具；
 * - 修完为空则删掉 `tools`。
 *
 * @returns 是否改动
 */
export function normalizeTools(body: Record<string, unknown>): boolean {
  let changed = false
  if ('functions' in body && !('tools' in body)) {
    const funcs = body.functions
    delete body.functions
    changed = true
    if (Array.isArray(funcs)) body.tools = funcs.filter(isObj).map((f) => ({ type: 'function', function: f }))
  }
  if (!('tools' in body)) return changed
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    delete body.tools
    return true
  }
  const norm: unknown[] = []
  for (const t of tools) {
    if (!isObj(t)) {
      changed = true
      continue
    }
    if (!isObj(t.function)) {
      if (typeof t.name !== 'string' || t.name === '') {
        changed = true
        continue
      }
      const fn: Msg = {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: t.parameters ?? {},
      }
      if ('strict' in t) fn.strict = t.strict
      norm.push({ type: 'function', function: normalizeFunctionDef(fn) })
      changed = true
      continue
    }
    const fn = normalizeFunctionDef(t.function)
    if (fn !== t.function || t.type !== 'function') {
      norm.push({ ...t, type: 'function', function: fn })
      changed = true
    } else {
      norm.push(t)
    }
  }
  if (norm.length > 0) body.tools = norm
  else delete body.tools
  return changed
}

// ── 客户端指纹脱敏（移植自 workbuddy2api-hub `sanitize_text` / `sanitize_messages`） ──
//
// 上游 WAF 对几段**特定客户端**的系统提示词原文回 `11128`（unapproved channel）。
// 改写刻意收得很窄：只动已确认的指纹短语，不删 agent 身份与行为约束。
const FINGERPRINT_LITERALS = [
  'x-anthropic-billing-header',
  'cc_entrypoint=',
  'You are Claude Code',
  'Main branch (',
  'You are a coding agent running in the Codex CLI',
  'github.com/anthropics/',
  'are paths the user',
  'workspace root',
  'DeepSeek Harness Web GUI',
  'the DeepSeek Harness Web GUI',
  'Grok Build',
  'released by xAI',
]
const FINGERPRINT_CI = /x-anthropic-billing-header|Sisyphus-Junior - Focused executor from OhMyOpenCode/i
const FINGERPRINT_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ['Main branch (you will usually use this for PRs)', 'Default branch (you will usually use this for PRs)'],
  [
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.',
  ],
  [
    'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
  ],
  ['are paths the user', 'are paths that the user'],
  ['workspace root', 'workspace base'],
  [
    'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.',
    'You are interacting with the user through a Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.',
  ],
  ['the DeepSeek Harness Web GUI', 'a Web GUI'],
  ['Grok released by xAI', 'WorkBuddy'],
  ['Grok Build', 'WorkBuddy'],
]
const OMO_JUNIOR_RE = /Sisyphus-Junior - Focused executor from OhMyOpenCode/gi
const BILLING_HDR_RE = /x-anthropic-billing-header:[^;\r\n]*;?\s*/gi
const BARE_BILLING_HDR_RE = /x-anthropic-billing-header/gi
const CC_KV_RE = /\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi
const GROK_XAI_RE = /You are(?:[^\n]{0,256}?)released by xAI/gi

/**
 * 第三方 CLI「`<Vendor>'s official CLI for <Product>`」渠道自述句改写（同步自 `dsh-connect-workbuddy` `7513e88`，issue #293）。
 *
 * Claude Code 的 system 提示词自带 `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`，
 * 上游在正文任意位置做精确子串匹配回 `400 / 11128`（仅把原本的 `CLI` 改成 `CLI tool` 或在前方加中性头均不够稳妥，且换产品/厂商仍会命中）。
 * 锚定行首或前一句句末标点后的 `You are <Product>, <Vendor>'s official CLI for <Target>...` 整句替换为中性句（保留句末句点与缩进），
 * 普通散文提及 CLI 时逐字节放过，二次调用严格幂等。
 */
const OFFICIAL_CLI_PROBE = /(?:'s|\u2019s)\s+official\s+cli\s+for\b/i
const OFFICIAL_CLI_RE =
  /(^[ \t]*|(?<=[.!?][ \t]+))You are\s+[\w-]+(?:\s+[\w.-]+){0,3}\s*,\s*[A-Za-z0-9][\w-]*(?:\s+[A-Za-z0-9][\w-]*)?(?:'s|\u2019s)\s+official\s+CLI\s+for\s+[\w.-]+\b(?:[^.\n]|\.(?=\d))*/gim
export const OFFICIAL_CLI_REPLACEMENT = 'You are an autonomous coding agent'

/**
 * 剥离 `assistant` 历史消息开头被注入或模型模仿叠加的重复中性头残留（同步自 `dsh-connect-workbuddy` `a8280b1`，issue #297）。
 *
 * 边界严格收窄：
 * - 仅对 `role === 'assistant'` 生效（`system` 头是国际版上游硬要求，绝不能剥；`user` / `tool` 属用户数据绝不触碰）；
 * - 仅剥离「中性头 + 空行」（`You are a helpful assistant.\n\n` / `You are a helpful AI assistant.\n\n`），
 *   不带空行的真实散文原封保留；
 * - 最多剥离 8 层，且若剥完只剩空白则保留最后一层，绝不把消息剥成空串。
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'
const INJECTED_ASSISTANT_HEAD_RE = /^You are a helpful (?:AI )?assistant\.\r?\n\r?\n/
const MAX_INJECTED_HEAD_LAYERS = 8

export function stripInjectedAssistantHead(text: string): string {
  let out = text
  for (let layer = 0; layer < MAX_INJECTED_HEAD_LAYERS; layer += 1) {
    const m = INJECTED_ASSISTANT_HEAD_RE.exec(out)
    if (m === null) break
    const rest = out.slice(m[0].length)
    if (rest.trim() === '') break
    out = rest
  }
  return out
}

function stripInjectedHeadFromContent(content: unknown): unknown {
  if (typeof content === 'string') return stripInjectedAssistantHead(content)
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((part) => {
    if (!isObj(part) || part.type !== 'text' || typeof part.text !== 'string') return part
    const next = stripInjectedAssistantHead(part.text)
    if (next === part.text) return part
    changed = true
    return { ...part, text: next }
  })
  return changed ? out : content
}

/**
 * 「客户端自我介绍句式 + 品牌」组合指纹（hub #533 / #537 / #539，2026-10-21）。
 *
 * 上游对这类整句做**大小写不敏感的连续子串匹配**，命中即 400 + 渠道拦截码：
 * - `You are an AI agent powered by DeepSeek Harness.`（DSH 系统提示首句）
 * - `You are a coding agent powered by the deepseek-v4.1-flash model.`
 * - `You are an AI assistant built on DeepSeek.`
 *
 * 单独的品牌词、拆开的词组都放行，所以只把**整句**换成中性句，不依赖具体品牌。
 * 表现是「同一账号官方客户端正常、经网关换号/换身份都失败、短请求却正常」。
 *
 * ⚠️ 只作用于 system / developer（见 `scrubFingerprints`）：user / assistant / tool
 * 里的同名文本是用户数据，改写会让模型看到与磁盘不一致的内容（hub #537）。
 */
const IDENTITY_RE =
  /You are an?(?:\s+AI)?(?:\s+coding)?\s+(?:agent\s+powered by|assistant\s+built on)[^\n]*?(?:\.(?=\s|$)|(?=\n|$))/gi
const IDENTITY_PROBE = /agent\s+powered by|assistant\s+built on/i
const IDENTITY_REPLACEMENT = 'You are a helpful AI assistant.'

function hasFingerprint(text: string, identity: boolean, officialCli = true): boolean {
  for (const f of FINGERPRINT_LITERALS) if (text.includes(f)) return true
  if (text.includes(FP_BARE)) return true
  if (FINGERPRINT_CI.test(text)) return true
  if (officialCli && OFFICIAL_CLI_PROBE.test(text)) return true
  return identity && IDENTITY_PROBE.test(text)
}

/**
 * 改写一段文本里的客户端指纹（无指纹时原样返回同一字符串）。
 *
 * @param identity 是否同时改写「自我介绍句 + 品牌」（只对 system / developer 开）。
 * @param trim 是否去除改写后文本的首尾空白（默认 `true`）。
 * @param officialCli 是否改写 `<Vendor>'s official CLI for <Product>` 自述句（对 system / developer / assistant 开，对 user / tool 关）。
 */
export function scrubFingerprintText(
  text: string,
  identity = false,
  trim = true,
  officialCli = true,
): string {
  if (text === '' || !hasFingerprint(text, identity, officialCli)) return text
  let out = text.replace(OMO_JUNIOR_RE, 'Sisyphus-Junior - Focused executor')
  out = out.replace(GROK_XAI_RE, 'You are WorkBuddy')
  if (officialCli) out = out.replace(OFFICIAL_CLI_RE, `$1${OFFICIAL_CLI_REPLACEMENT}`)
  if (identity) out = out.replace(IDENTITY_RE, IDENTITY_REPLACEMENT)
  for (const [from, to] of FINGERPRINT_REWRITES) out = out.replaceAll(from, to)
  out = out.replaceAll(FP_BARE, FP_SAFE)
  out = out.replace(BILLING_HDR_RE, '')
  if (out.includes('cc_')) {
    for (let prev = ''; prev !== out;) {
      prev = out
      out = out.replace(CC_KV_RE, '')
    }
  }
  out = out.replace(BARE_BILLING_HDR_RE, 'x-anthropic-billing-hdr')
  return trim ? out.trim() : out
}

/**
 * 工具调用参数（JSON 字符串）的指纹脱敏：**只改 JSON 里的字符串值**。
 *
 * 直接按文本替换会把 `{"line":` + 裸码 + `}` 这种数字改成非法 JSON；
 * 这里先解析，逐个字符串值脱敏（不 trim —— 文件内容的首尾空白有意义），
 * 有改动才重新序列化。数字里的裸码无法在不改语义的前提下处理，保持原样。
 * 解析失败（流式残片等）才退回整段文本改写。
 */
export function scrubToolArguments(args: string): string {
  if (args === '' || !hasFingerprint(args, false, false)) return args
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return scrubFingerprintText(args, false, true, false)
  }
  if (parsed === null || typeof parsed !== 'object') {
    return typeof parsed === 'string' ? JSON.stringify(scrubFingerprintText(parsed, false, false, false)) : args
  }
  let changed = false
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = scrubFingerprintText(v, false, false, false)
      if (s !== v) changed = true
      return s
    }
    if (Array.isArray(v)) return v.map(walk)
    // fromEntries 走 CreateDataProperty：`__proto__` 键仍是普通自有属性，不会改原型
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const next = walk(parsed)
  return changed ? JSON.stringify(next) : args
}

function scrubContent(content: unknown, identity: boolean, officialCli: boolean): unknown {
  if (typeof content === 'string') return scrubFingerprintText(content, identity, true, officialCli)
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((part) => {
    if (!isObj(part) || part.type !== 'text' || typeof part.text !== 'string') return part
    const text = scrubFingerprintText(part.text, identity, true, officialCli)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? out : content
}

/**
 * 对整段消息历史做指纹脱敏（正文 / 文本分段 / reasoning_content / 工具参数 / assistant 注入中性头剥离）。无改动返回原数组。
 *
 * - 身份句改写（`IDENTITY_RE`）只对 `system` / `developer` 生效；
 * - 第三方 `official CLI` 渠道自述句改写对 `system` / `developer` / `assistant` 生效，`user` / `tool` 保持逐字节不变；
 * - `assistant` 历史消息额外剥离被注入的重复中性头残留（`#297`）。
 */
export function scrubFingerprints(messages: unknown[]): unknown[] {
  let changed = false
  const out = messages.map((m) => {
    if (!isObj(m)) return m
    let item: Msg | undefined
    const identity = m.role === 'system' || m.role === 'developer'
    const officialCli = identity || m.role === 'assistant'
    let content = scrubContent(m.content, identity, officialCli)
    if (m.role === 'assistant') {
      content = stripInjectedHeadFromContent(content)
    }
    if (content !== m.content) (item ??= { ...m }).content = content
    if (typeof m.reasoning_content === 'string') {
      const rc = scrubFingerprintText(m.reasoning_content, false, true, officialCli)
      if (rc !== m.reasoning_content) (item ??= { ...m }).reasoning_content = rc
    }
    if (Array.isArray(m.tool_calls)) {
      let callsChanged = false
      const calls = (m.tool_calls as unknown[]).map((tc) => {
        if (!isObj(tc) || !isObj(tc.function) || typeof tc.function.arguments !== 'string') return tc
        const args = scrubToolArguments(tc.function.arguments)
        if (args === tc.function.arguments) return tc
        callsChanged = true
        return { ...tc, function: { ...tc.function, arguments: args } }
      })
      if (callsChanged) (item ??= { ...m }).tool_calls = calls
    }
    if (item === undefined) return m
    changed = true
    return item
  })
  return changed ? out : messages
}

/** 准备结果。 */
export interface PrepareResult {
  body: string
  /** 做过的改写（供日志与排查）。 */
  applied: string[]
}

/**
 * 完整准备管线。
 *
 * ⚠️ 顺序即语义：先翻译字段名（影响后续判断），再修消息历史
 * （配对错误会让整个请求失败，必须修好内容）。
 */
export function prepareChatBody(input: unknown): PrepareResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const body = { ...(input as Record<string, unknown>) }
  const applied: string[] = []

  // ① 强制 stream（上游要求）
  if (body.stream !== true) {
    body.stream = true
    applied.push('stream=true')
  }

  // ② max_completion_tokens → max_tokens
  if (body.max_completion_tokens !== undefined) {
    translateMaxCompletionTokens(body)
    applied.push('max_completion_tokens→max_tokens')
  }
  if (clampGptMaxTokens(body)) applied.push('max_tokens≥16')

  // ③ stream_options 补默认
  if (body.stream_options === undefined) {
    ensureStreamOptions(body)
    applied.push('stream_options.include_usage')
  }

  // ④ tool_choice 归一化（对象形式会 400）
  if (body.tool_choice !== undefined) {
    const before = body.tool_choice
    normalizeToolChoice(body)
    if (body.tool_choice !== before) applied.push('tool_choice')
  }

  // ⑤ tools / stop 归一化（schema 不合法 11129、stop 字符串 11101）
  if (normalizeTools(body)) applied.push('tools')
  if (normalizeStop(body)) applied.push('stop[]')
  if (fillDeepseekEffort(body)) applied.push('reasoning_effort=high')

  // ⑥ 消息历史：指纹脱敏 → 工具配对修复 → DeepSeek 思考回填
  if (!Array.isArray(body.messages)) throw new Error('messages 必须是数组')
  let messages = body.messages as unknown[]
  const scrubbed = scrubFingerprints(messages)
  if (scrubbed !== messages) {
    messages = scrubbed
    applied.push('fingerprint')
  }
  const cleaned = cleanupToolPairing(messages)
  if (cleaned !== messages) {
    messages = cleaned
    applied.push('tool-pairing')
  }
  const padded = padEmptyTextParts(messages)
  if (padded !== messages) {
    messages = padded
    applied.push('empty-text-pad')
  }
  const mirrored = mirrorReasoningContent(messages, body.model)
  if (mirrored !== messages) {
    messages = mirrored
    applied.push('reasoning-mirror')
  }
  const backfilled = backfillReasoningContent(messages, body.model, isDeepseekThinking(body))
  if (backfilled !== messages) {
    messages = backfilled
    applied.push('reasoning_content')
  }
  body.messages = messages

  return { body: JSON.stringify(body), applied }
}

/**
 * 反探测脱敏（AGENTS.md §6.6）—— 整体请求体上的兜底一遍。
 *
 * 裸 5 位拦截码已在 `scrubFingerprintText` 里按**文本字段**改写（正文 / 推理 / 工具参数，
 * 与参考实现同口径）；这里不对整串做裸码替换：请求体里的 base64 图片、数字字段都可能
 * 碰巧含这 5 位，整串替换会改坏图片或把数字变成非法 JSON。
 * 带连字符的形态不可能出现在数字与标准 base64 里，故仍在整串上改写。
 * 零宽空格无效（上游会归一化），故替身用 U+2011。
 */
export function sanitizeChatBody(body: string): string {
  if (!body.includes(FP)) return body
  return body.replaceAll(FP, FP_SAFE)
}
