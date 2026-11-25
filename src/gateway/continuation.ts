/**
 * 流式截断自动续写与「预告句悬停（Narration Hover）」救援模块。
 *
 * ## 解决的两类线上高频中断
 *
 * 1. **输出上限截断（`finish_reason === 'length'`）**：
 *    上游对单次输出常设硬上限（如 32000 token），或思考链吃掉绝大部分 `max_tokens` 预算，
 *    导致长代码/长文档写到半截中断。对于无工具调用分片且非探活（`max_tokens > 16`）的截断流，
 *    将已产出的正文作为 `assistant` 前缀追加续写指令重发，在帧级无缝拼成同一条连续 SSE 流。
 *
 * 2. **预告句悬停（Narration Hover，`finish_reason === 'stop'` 但零工具调用）**：
 *    Agent 场景下模型常只写一句「接下来我来修改 `src/foo.ts`… / Let me update…」或停在冒号 `：` 上
 *    就直接返回 `stop` 且不发 `tool_calls`，客户端回合意外终止。
 *    通过严格护栏（提问/请确认拍板措辞零触碰、文件名/版本号半角点不误切句、最多救援 1–2 次、
 *    无新产出即停）识别真悬停并自动补发一次执行提示。
 *
 * 3. **异步换段期间 `: keepalive\n\n` 保活**：
 *    续写请求在途等待首字节（TTFB 常需数秒至十余秒）期间定时发射 SSE 注释帧 `: keepalive\n\n`，
 *    防止客户端或中间层因流空闲超时掐断连接。
 *
 * 参考社区实现：
 * - `misakano7545/workbuddy2api-panel`（`internal/server/continue.go`、`narration.go`、`toolonly.go`；
 *   提交 `06a401e`、`2827974`、`89c84fb`、`6c50888`）
 */

import { detectErrorFrame, parseSseLine } from './stream.js'

// ─────────────────────────── 常量与提示词 ───────────────────────────

/** 探活级 `max_tokens` 阈值：小于等于该值一律视为探针或极短分类请求，绝不续写。 */
export const PROBE_MAX_TOKENS_THRESHOLD = 16

/** 客户端显式传入的 `max_tokens` 达到该阈值时按「期望完整长输出」处理，允许截断续写。 */
export const CLIENT_LONG_ANSWER_TOKENS = 32_000

/** 思考占比阈值：显式限额请求中若思考消耗达到总输出的 50% 以上且已有正文，允许关思考续写。 */
export const THINKING_STARVED_SHARE = 0.5

/** 默认单请求最大总段数（1 段首请求 + 最多 2 次截断续写）。 */
export const DEFAULT_MAX_CONTINUE_SEGMENTS = 3

/** 预告句悬停单请求默认最大救援次数（最多 2 次，无新产出立即停止）。 */
export const DEFAULT_MAX_NARRATION_RESCUES = 2

/** 标点型悬停（以冒号/逗号等结尾）的正文最大字节数闸门，防止长排版列表误触发。 */
export const NARRATION_MAX_PUNCTUATED_BYTES = 400

/** 句号结尾的短承诺句（如「接下来我来修改 foo.ts。」）最大字节数闸门。 */
export const NARRATION_SHORT_PERIOD_PROMISE_BYTES = 300

/** 换段等待或吞帧静默期间发射 `: keepalive` 的默认间隔（毫秒）。 */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000

/** 标准 SSE 注释心跳帧。 */
export const KEEPALIVE_FRAME = ': keepalive\n\n'

/** Codex 浏览器回合提前收尾控制标记前缀（`6dc02b3`）。 */
export const BROWSER_COMPLETE_PREFIX = '::browser-complete'

/**
 * 合成续写指令的纯中性标记前缀（同步自 `workbuddy2api-panel` `2e2358c`、`f60c68d`）：
 * 既让模型能将 `role: 'user'` 的合成续写指令与真实用户授权输入区分开，
 * 又严格不含任何网关自称词或实现项目名（如 `wb2api`、`free-llm-router`、`网关`、`非用户消息`）。
 */
export const INTERNAL_NUDGE_PREFIX = '【内部续写指令·非用户输入】'

/** `finish_reason=length` 截断续写指令。 */
export const CONTINUE_NUDGE =
  `${INTERNAL_NUDGE_PREFIX}你上一条回复因达到输出长度上限被截断。请从中断处继续输出剩余内容；不要重复已输出过的部分，不要道歉或解释，直接继续。如果已经写完整，不要输出任何内容，直接结束。`

/** 标点/结构悬停（如停在 `：` 或半截代码块）救援指令。 */
export const NARRATION_COLON_NUDGE =
  `${INTERNAL_NUDGE_PREFIX}你上一条回复停在一句预告（例如以冒号结尾的「……：」）上就结束了，剩余内容还没写。请紧接着把剩下的部分写完：需要查看文件、执行命令或调用工具就直接调用，不要重复已经写过的内容，不要重新开头，不要道歉或解释。如果你确实已经写完了，什么都不要输出，直接结束这一轮。`

/** 动作承诺句悬停（如「我将开始修改… / Let me update…」）救援指令。 */
export const NARRATION_PROMISE_NUDGE =
  `${INTERNAL_NUDGE_PREFIX}你上一条回复最后停在「我将…」「接下来我来…」「Let me…」这类承诺句上就结束了，承诺的动作没有执行。请直接执行它：需要查看文件、执行命令或调用工具就直接调用，不要解释为什么停下，不要重复已经写过的内容，不要重新开头。如果你确实已经写完了，什么都不要输出，直接结束这一轮。`

/** 独立 `::browser-complete{...}` 控制标记误收尾救援指令（`6dc02b3`、`f60c68d`、`2e2358c`）。 */
export const BROWSER_COMPLETE_NUDGE =
  `${INTERNAL_NUDGE_PREFIX}你刚才只输出了 \`::browser-complete{...}\` 浏览器完成控制标记，但用户任务还没有结束。不要只输出完成标记，也不要假装已经完成；请继续执行用户要求的下一步，完成后给出最终结果。如果你确认已经完成，不要输出任何内容，直接结束。`

/**
 * 判断正文是否**恰好仅包含一条独立的 `::browser-complete{...}` 控制标记**（允许首尾空白，不允许夹带其他正文，`6dc02b3`）。
 */
export function isBrowserCompleteDirectiveOnly(text: string): boolean {
  const s = text.trim()
  if (!s.startsWith(`${BROWSER_COMPLETE_PREFIX}{`)) return false
  const rest = s.slice(BROWSER_COMPLETE_PREFIX.length)
  const end = rest.indexOf('}')
  return end >= 0 && rest.slice(end + 1).trim() === ''
}

// ─────────────────────────── 基础工具与句子切分 ───────────────────────────

const utf8Encoder = new TextEncoder()

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch)
}

/**
 * 提取文本最后一句（去掉末尾句末标点与空白）。
 *
 * ## 关键细节：文件名与版本号中的 `.` 绝不误判为句末
 * - 全角 `。！？` 在任意位置均视为句子边界；
 * - 半角 `. ! ?` **仅当位于文本末尾或紧跟空白字符**时才视为句子边界，
 *   因此 `internal/verify/check.go`、`config.ts`、`v1.2.0`、`https://a.b/c.js` 不会被拦腰切断。
 */
export function extractLastSentence(text: string): string {
  const trimmed = text.replace(/[ \t\r\n]+$/g, '')
  if (trimmed === '') return ''

  const chars = Array.from(trimmed)
  let start = 0
  let end = chars.length

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]!
    if (!'。！？!?.'.includes(ch)) continue

    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80 && i + 1 < chars.length && !isWhitespaceChar(chars[i + 1])) {
      continue
    }

    if (i === end - 1) {
      // 跳过句尾自身的连续终止标点（如 `...` 或 `？！`）
      end = i
      continue
    }

    start = i + 1
    break
  }

  if (start >= end) return ''
  return chars.slice(start, end).join('').trim()
}

// ─────────────────────────── 工具标记与用户让渡护栏 ───────────────────────────

const TOOL_CALL_MARKUP_MARKERS = [
  '｜｜DSML｜｜',
  '|DSML|',
  '</function_calls>',
  '<function_calls>',
  'antml:invoke',
  '<invoke name=',
  '</tool_calls>',
  '<tool_calls>',
] as const

export type ToolMarkupState = 'none' | 'complete' | 'partial'

/**
 * 检测正文中写成文本形态的工具调用标记（如 DeepSeek DSML / XML invoke）：
 * - `'complete'`：已完整闭合，客户端会自行解析执行，**严禁**续写（否则导致工具重复执行）；
 * - `'partial'`：写到一半断掉，可补救一次将其闭合；
 * - `'none'`：不含此类文本标记。
 */
export function toolCallMarkupState(text: string): ToolMarkupState {
  if (text === '') return 'none'
  let found = false
  for (const marker of TOOL_CALL_MARKUP_MARKERS) {
    if (text.includes(marker)) {
      found = true
      break
    }
  }
  if (!found) return 'none'

  const t = text.replace(/[ \t\r\n]+$/g, '')
  if (t.endsWith('</function_calls>') || t.endsWith('</tool_calls>')) {
    return 'complete'
  }
  if (t.endsWith('calls>') && (t.includes('DSML') || t.includes('dsml'))) {
    return 'complete'
  }
  return 'partial'
}

/** 无论出现在正文何处都代表「模型正在等用户拍板/确认」的强信号词（全小写对比）。 */
const USER_YIELD_STRONG_MARKERS = [
  '请确认',
  '请你确认',
  '你确认后',
  '等你确认',
  '待你确认',
  '等你回复',
  '让我知道',
  '是否继续',
  '要不要继续',
  '请决定',
  '请指示',
  'please confirm',
  'let me know',
  'awaiting your confirmation',
  'waiting for your confirmation',
] as const

/**
 * 既可用于向用户提问、也可能出现在技术叙述中段的协商措辞。
 * 在预告句救援中仅当位于：末句、末尾问句（后跟无句读草稿）、或紧跟单数「我/你」（排除「我们/你们」）时判定为向用户让渡。
 */
const USER_YIELD_DELIBERATION_MARKERS = [
  '是否需要',
  '需不需要',
  '要不要',
  '确认后',
  '确认无误',
  '请告知',
  '你希望',
  '可以吗',
  '行吗',
  '好吗',
  '是否可以',
  'should i ',
  'shall i ',
  'do you want',
  'would you like',
  'awaiting your',
  'waiting for your',
  'confirm before',
] as const

/** 直接向用户发问的句式正则（如「需要我帮你修改吗」「需要我现在提交吗？」）。 */
const DIRECT_USER_QUESTION_RE =
  /需要我[^\n。！!]{0,40}(?:吗|呢|\?|？)|(?:是否|要不要|需不需要)(?:我|现在|立即|直接|继续)/i

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true
  }
  return false
}

/**
 * 提取正文最后一个问句（仅当问号之后不再有完整陈述句，只剩草稿行/参数列表时返回该问句）。
 */
function extractTrailingQuestion(lowerText: string): string {
  const qIdx = Math.max(lowerText.lastIndexOf('？'), lowerText.lastIndexOf('?'))
  if (qIdx < 0) return ''
  const after = lowerText.slice(qIdx + 1)
  if (/[。！？!?]/.test(after)) return ''
  return extractLastSentence(lowerText.slice(0, qIdx + 1))
}

function deliberationAddressesUser(lowerText: string): boolean {
  for (const marker of USER_YIELD_DELIBERATION_MARKERS) {
    let pos = 0
    for (;;) {
      const idx = lowerText.indexOf(marker, pos)
      if (idx < 0) break
      pos = idx + marker.length
      const rest = lowerText.slice(pos)
      if (
        (rest.startsWith('我') || rest.startsWith('你')) &&
        !rest.startsWith('我们') &&
        !rest.startsWith('你们')
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * 严格护栏：判断模型正文是否正在**向用户提问或等待用户确认拍板**。
 *
 * 命中时**绝对禁止**自动救援续写（防止替用户确认高危操作或打断正常追问）。
 */
export function yieldsToUser(text: string, deliberationAnywhere = false): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false

  // 剥除末尾可能包裹的 Markdown 强调符（如 `**是否继续？**`）再检查尾部问号
  const unwrappedTail = trimmed.replace(/[*_`~]+$/g, '').trimEnd()
  if (unwrappedTail.endsWith('？') || unwrappedTail.endsWith('?')) {
    return true
  }

  const lower = trimmed.toLowerCase()
  if (containsAny(lower, USER_YIELD_STRONG_MARKERS)) {
    return true
  }
  if (DIRECT_USER_QUESTION_RE.test(lower)) {
    return true
  }

  const last = extractLastSentence(lower)
  // 末句以中文疑问语气词「吗」结尾（模型漏打问号时的防御）
  if (last.endsWith('吗')) {
    return true
  }

  if (deliberationAnywhere) {
    return containsAny(lower, USER_YIELD_DELIBERATION_MARKERS)
  }

  return (
    containsAny(last, USER_YIELD_DELIBERATION_MARKERS) ||
    containsAny(extractTrailingQuestion(lower), USER_YIELD_DELIBERATION_MARKERS) ||
    deliberationAddressesUser(lower)
  )
}

// ─────────────────────────── 预告句尾部特征判据 ───────────────────────────

const TAIL_HANG_PUNCT = '：:，,、—–…（(【['
const SENTENCE_FINISH_CHARS = '。.!！?？"\'”’）)》】]}`*~&'

/** 预告下一步动作的承诺词（全小写匹配）。 */
const NARRATION_PROMISE_MARKERS = [
  '我将',
  '我会',
  '我先',
  '我要',
  '我来',
  '我继续',
  '我现在',
  '让我',
  '我需要',
  '我得',
  '我打算',
  '我开始',
  '我再',
  '我接着',
  '我还要',
  '我马上',
  '我这就',
  '接下来我',
  '接下来开始',
  '下一步我',
  '我们接着',
  '现在开始',
  '正在',
  'let me',
  "let's",
  "i'll",
  'i will',
  "i'm going to",
  'i am going to',
  "i'm updating",
  "i'm checking",
  "i'm reading",
  "i'm modifying",
  'i need to',
  'i should',
  'now i ',
  'next, i ',
  'next i ',
] as const

/** 含承诺字面但并非动作承诺的固定搭配噪音（如「对我来说」「在我看来」）。 */
const NARRATION_PROMISE_NOISE = ['我来说', '我来看'] as const

/** 明确表示总结收尾的词语：短句带句号时若含收尾词（如「任务已完成，我来总结一下。」），不触发救援。 */
const CLOSING_SUMMARY_MARKERS = [
  '总结',
  '已完成',
  '全部完成',
  '已经完成',
  '完毕',
  '收尾',
  '到这里',
  '已经足够',
  '全部通过',
  '测试通过',
  'all done',
  'task completed',
  'all tests passed',
] as const

function countOccurrences(str: string, sub: string): number {
  if (sub === '') return 0
  let count = 0
  let pos = 0
  for (;;) {
    const idx = str.indexOf(sub, pos)
    if (idx < 0) return count
    count += 1
    pos = idx + sub.length
  }
}

/** 尾部是否处于结构性未闭合状态（奇数个 ``` 代码围栏，或半截工具调用文本标记）。 */
export function narrationTailStructurallyOpen(text: string): boolean {
  if (toolCallMarkupState(text) === 'partial') return true
  const trimmed = text.replace(/[ \t\r\n]+$/g, '')
  return countOccurrences(trimmed, '```') % 2 === 1
}

/** 尾部是否停在冒号、逗号、省略号、破折号、左括号等悬停标点上。 */
export function narrationTailPunctuated(text: string): boolean {
  const trimmed = text.replace(/[ \t\r\n]+$/g, '')
  if (trimmed === '') return false
  const chars = Array.from(trimmed)
  const last = chars[chars.length - 1]!
  return TAIL_HANG_PUNCT.includes(last)
}

/**
 * 最后一句是否在承诺即将执行的下一步动作（如「接下来我来修改 foo.ts」「Let me update...」「Reading script...」）。
 */
export function narrationTailPromises(text: string): boolean {
  let last = extractLastSentence(text).toLowerCase()
  if (last === '') return false

  for (const noise of NARRATION_PROMISE_NOISE) {
    last = last.replaceAll(noise, '')
  }

  for (const marker of NARRATION_PROMISE_MARKERS) {
    if (last.includes(marker)) return true
  }

  // 英文现在分词开头的动作旁白（如 "Reading failfirst.sh mutation script"），排除带冒号的标题（如 "Testing: ..."）
  const spaceIdx = last.indexOf(' ')
  if (spaceIdx > 0) {
    const firstWord = last.slice(0, spaceIdx)
    if (firstWord.length >= 5 && firstWord.endsWith('ing') && /^[a-z]+$/.test(firstWord)) {
      return true
    }
  }

  return false
}

/** 正文尾部在结构/标点上是否呈现出「话没说完」的悬停形态。 */
export function narrationTailSuspends(text: string): boolean {
  const markup = toolCallMarkupState(text)
  if (markup === 'complete') return false
  if (markup === 'partial') return true

  const trimmed = text.replace(/[ \t\r\n]+$/g, '')
  if (trimmed === '') return false

  if (
    trimmed.endsWith('</summary>') ||
    trimmed.endsWith('</details>') ||
    trimmed.endsWith('</analysis>')
  ) {
    return false
  }

  if (countOccurrences(trimmed, '```') % 2 === 1) {
    return true
  }

  const chars = Array.from(trimmed)
  const last = chars[chars.length - 1]!
  if (TAIL_HANG_PUNCT.includes(last)) return true
  if (SENTENCE_FINISH_CHARS.includes(last)) return false
  return true
}

/** 从 Chat 请求体提取工具上下文特征（是否声明了 `tools`、历史消息中是否已有工具轮）。 */
export function inspectRequestToolShape(body: unknown): {
  hasDeclaredTools: boolean
  hasToolHistory: boolean
} {
  if (!isObject(body)) {
    return { hasDeclaredTools: false, hasToolHistory: false }
  }
  const hasDeclaredTools = Array.isArray(body.tools) && body.tools.length > 0
  let hasToolHistory = false
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isObject(m)) continue
      if (
        m.role === 'tool' ||
        (typeof m.tool_call_id === 'string' && m.tool_call_id !== '') ||
        (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
      ) {
        hasToolHistory = true
        break
      }
    }
  }
  return { hasDeclaredTools, hasToolHistory }
}

/** 从请求体读取显式设置的输出 token 限额（`max_tokens` / `max_completion_tokens` / `max_output_tokens`）。 */
export function extractExplicitMaxTokens(body: unknown): number | undefined {
  if (!isObject(body)) return undefined
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const) {
    const val = body[key]
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return Math.floor(val)
    }
  }
  return undefined
}

// ─────────────────────────── 核心纯函数判据 ───────────────────────────

export interface TruncationCheckInput {
  finishReason: string | null | undefined
  /** 本段是否出现过 `tool_calls` 分片（含工具调用时严禁拼接残缺 JSON）。 */
  hasToolCalls?: boolean
  /** 本段或整轮是否出现过上游错误帧。 */
  hasError?: boolean
  /** 客户端是否已主动断开连接。 */
  clientAborted?: boolean
  /** 已累积的正文字符数。 */
  textLength: number
  /** 已累积的思考字符数。 */
  reasoningLength?: number
  /** 客户端请求显式携带的 `max_tokens`（未携带传 `undefined`）。 */
  maxTokens?: number
  /** 当前段序号（首段为 `0`）。 */
  segmentIndex?: number
  /** 允许的最大总段数（默认 `3`，即最多续写 2 次）。 */
  maxSegments?: number
  /** 本段总 completion_tokens（用于判断思考是否吃光预算）。 */
  segmentCompletionTokens?: number
  /** 本段思考 reasoning_tokens（用于判断思考是否吃光预算）。 */
  segmentReasoningTokens?: number
  /** 是否允许对普通显式 `max_tokens`（17..31999）也强制续写（默认 `false`）。 */
  allowExplicitMaxTokens?: boolean
}

/**
 * 纯函数判据：当前流式段是否应当触发**截断自动续写**。
 */
export function shouldContinueTruncated(input: TruncationCheckInput): boolean {
  if (input.clientAborted === true || input.hasError === true) return false
  if (input.hasToolCalls === true) return false

  const seg = input.segmentIndex ?? 0
  const maxSegs = input.maxSegments ?? DEFAULT_MAX_CONTINUE_SEGMENTS
  if (seg >= maxSegs - 1) return false

  const fr = typeof input.finishReason === 'string' ? input.finishReason.trim().toLowerCase() : ''
  if (fr !== 'length' && fr !== 'max_tokens') return false

  const textLen = input.textLength
  const reasonLen = input.reasoningLength ?? 0
  if (textLen <= 0 && reasonLen <= 0) return false

  const maxTokens = input.maxTokens
  if (maxTokens !== undefined) {
    // 探活极短请求（如 max_tokens <= 16）一律不续写
    if (maxTokens <= PROBE_MAX_TOKENS_THRESHOLD) return false

    if (maxTokens < CLIENT_LONG_ANSWER_TOKENS && input.allowExplicitMaxTokens !== true) {
      const segComp = input.segmentCompletionTokens ?? 0
      const segThink = input.segmentReasoningTokens ?? 0
      const starvedByThinking =
        textLen > 0 &&
        segComp > 0 &&
        segThink > 0 &&
        segThink >= THINKING_STARVED_SHARE * segComp
      if (!starvedByThinking) return false
    }
  }

  return true
}

export interface NarrationCheckInput {
  /** 当前段结束时的 `finish_reason`（必须为 `'stop'` 才考虑预告句救援）。 */
  finishReason: string | null | undefined
  /** 当前已累积的完整可见正文。 */
  text: string
  /** 是否已产生任何工具调用（已有工具调用说明模型已动手，无需救援）。 */
  hasToolCalls?: boolean
  /** 是否出现错误帧。 */
  hasError?: boolean
  /** 客户端是否已断开连接。 */
  clientAborted?: boolean
  /** 请求体是否声明了 `tools`（默认 `true`；传入 `requestBody` 时可自动推断）。 */
  hasDeclaredTools?: boolean
  /** 请求历史中是否已有工具调用/结果轮次。 */
  hasToolHistory?: boolean
  /** 原始请求体（可选：传入后自动推导 `hasDeclaredTools` / `hasToolHistory` / 探活上限）。 */
  requestBody?: unknown
  /** 本次请求已执行的预告句救援次数（默认 `0`）。 */
  narrationRescuesUsed?: number
  /** 允许的最大预告句救援次数（默认 `2`）。 */
  maxNarrationRescues?: number
  /** 上一次救援发起时的正文字符长度（用于「无新产出即停」判据）。 */
  lastRescueTextLength?: number
}

export interface NarrationDecision {
  rescue: boolean
  nudge?: string
  reason: string
}

/**
 * 纯函数判据：判断模型是否处于「预告句悬停（只说接下来要改什么却以 `stop` 停下未调工具）」状态。
 */
export function shouldRescueNarrationHover(input: NarrationCheckInput): NarrationDecision {
  if (input.clientAborted === true) return { rescue: false, reason: 'client_aborted' }
  if (input.hasError === true) return { rescue: false, reason: 'has_error' }
  if (input.hasToolCalls === true) return { rescue: false, reason: 'already_has_tool_calls' }

  const fr = typeof input.finishReason === 'string' ? input.finishReason.trim().toLowerCase() : ''
  if (fr !== 'stop') return { rescue: false, reason: 'not_stop_finish' }

  const text = input.text
  if (text.trim() === '') return { rescue: false, reason: 'empty_text' }

  const maxTokens =
    input.requestBody !== undefined ? extractExplicitMaxTokens(input.requestBody) : undefined
  if (maxTokens !== undefined && maxTokens <= PROBE_MAX_TOKENS_THRESHOLD) {
    return { rescue: false, reason: 'probe_max_tokens' }
  }

  const used = input.narrationRescuesUsed ?? 0
  const maxRescues = input.maxNarrationRescues ?? DEFAULT_MAX_NARRATION_RESCUES
  if (used >= maxRescues) return { rescue: false, reason: 'max_rescues_reached' }

  if (
    input.lastRescueTextLength !== undefined &&
    text.length <= input.lastRescueTextLength
  ) {
    return { rescue: false, reason: 'no_new_progress' }
  }

  const shape =
    input.requestBody !== undefined ? inspectRequestToolShape(input.requestBody) : undefined
  const hasDeclaredTools = input.hasDeclaredTools ?? shape?.hasDeclaredTools ?? false
  const hasToolHistory = input.hasToolHistory ?? shape?.hasToolHistory ?? false
  if (!hasDeclaredTools) {
    return { rescue: false, reason: 'no_tools_declared' }
  }

  // 护栏 1：完整文本态工具调用标记不救（客户端会自行执行）
  const markup = toolCallMarkupState(text)
  if (markup === 'complete') {
    return { rescue: false, reason: 'complete_tool_markup' }
  }

  // 护栏 2：向用户提问或等用户确认拍板的措辞一律停手不救
  if (yieldsToUser(text, false)) {
    return { rescue: false, reason: 'yields_to_user' }
  }

  const structurallyOpen = narrationTailStructurallyOpen(text)
  if (structurallyOpen && used >= 1) {
    // 结构未闭合最多补救 1 次
    return { rescue: false, reason: 'structural_open_already_retried' }
  }

  const byteLen = utf8ByteLength(text)
  const promisesAction = narrationTailPromises(text)
  const tailSuspends = narrationTailSuspends(text)
  const tailPunctuated = narrationTailPunctuated(text)

  if (tailSuspends) {
    // 非工具历史首轮会话：只有明确说出「我将/接下来我来/Let me…」等动作承诺或结构未闭合时才救，
    // 防止普通闲聊/角色扮演客户端挂载了工具但用冒号结尾被误判。
    if (!hasToolHistory && !promisesAction && !structurallyOpen) {
      return { rescue: false, reason: 'no_tool_history_for_non_promise_tail' }
    }

    // 超长正文护栏：标点型悬停超过 400B 视为正常排版；无标点长文仅当末句明确承诺下一步动作才救
    if (
      !structurallyOpen &&
      byteLen > NARRATION_MAX_PUNCTUATED_BYTES &&
      (tailPunctuated || !promisesAction)
    ) {
      return { rescue: false, reason: 'long_finished_summary' }
    }

    const nudge =
      !tailPunctuated && !structurallyOpen ? NARRATION_PROMISE_NUDGE : NARRATION_COLON_NUDGE
    return { rescue: true, nudge, reason: 'suspended_narration_tail' }
  }

  // 句号收尾的短动作预告句（如「接下来我来修改 src/index.ts。」「Let me update config.ts.」）
  if (promisesAction && byteLen <= NARRATION_SHORT_PERIOD_PROMISE_BYTES) {
    const lastLower = extractLastSentence(text).toLowerCase()
    if (!containsAny(lastLower, CLOSING_SUMMARY_MARKERS)) {
      return {
        rescue: true,
        nudge: NARRATION_PROMISE_NUDGE,
        reason: 'short_promise_sentence',
      }
    }
  }

  return { rescue: false, reason: 'normal_completion' }
}

export interface BrowserCompleteCheckInput {
  finishReason: string | null | undefined
  text: string
  hasToolCalls?: boolean
  hasError?: boolean
  clientAborted?: boolean
  hasDeclaredTools?: boolean
  hasToolHistory?: boolean
  requestBody?: unknown
  browserCompleteTried?: boolean
  segmentIndex?: number
  maxSegments?: number
}

/**
 * 纯函数判据：当模型在有工具上下文的回合仅输出一条独立的 `::browser-complete{...}` 控制标记即 `stop` 时，
 * 触发单次续写救援（`6dc02b3`）。
 */
export function shouldRescueBrowserComplete(input: BrowserCompleteCheckInput): NarrationDecision {
  if (input.browserCompleteTried === true) return { rescue: false, reason: 'already_tried' }
  if (input.clientAborted === true) return { rescue: false, reason: 'client_aborted' }
  if (input.hasError === true) return { rescue: false, reason: 'has_error' }
  if (input.hasToolCalls === true) return { rescue: false, reason: 'already_has_tool_calls' }

  const fr = typeof input.finishReason === 'string' ? input.finishReason.trim().toLowerCase() : ''
  if (fr !== 'stop') return { rescue: false, reason: 'not_stop_finish' }

  const seg = input.segmentIndex ?? 0
  const maxSegs = input.maxSegments ?? DEFAULT_MAX_CONTINUE_SEGMENTS
  if (seg >= maxSegs - 1) return { rescue: false, reason: 'segment_cap' }

  const maxTokens =
    input.requestBody !== undefined ? extractExplicitMaxTokens(input.requestBody) : undefined
  if (maxTokens !== undefined && maxTokens <= PROBE_MAX_TOKENS_THRESHOLD) {
    return { rescue: false, reason: 'probe_max_tokens' }
  }

  if (!isBrowserCompleteDirectiveOnly(input.text)) {
    return { rescue: false, reason: 'not_standalone_browser_complete' }
  }

  const shape =
    input.requestBody !== undefined ? inspectRequestToolShape(input.requestBody) : undefined
  const hasDeclaredTools = input.hasDeclaredTools ?? shape?.hasDeclaredTools ?? false
  const hasToolHistory = input.hasToolHistory ?? shape?.hasToolHistory ?? false
  if (!hasDeclaredTools && !hasToolHistory) {
    return { rescue: false, reason: 'no_tool_context' }
  }

  return {
    rescue: true,
    nudge: BROWSER_COMPLETE_NUDGE,
    reason: 'standalone_browser_complete',
  }
}

// ─────────────────────────── 续写请求构造与 Usage 合并 ───────────────────────────

/**
 * 构造续写/救援请求的 Chat 请求体（不修改原对象）：
 * 在原 `messages` 末尾追加 `{ role: 'assistant', content, reasoning_content? }` 与 `{ role: 'user', content: nudge }`。
 */
export function buildContinuationBody(
  originalBody: Record<string, unknown>,
  accumulated: { text: string; reasoning?: string },
  nudge: string,
  options?: { disableThinking?: boolean },
): Record<string, unknown> {
  const prevMessages = Array.isArray(originalBody.messages) ? originalBody.messages : []
  const assistantMsg: Record<string, unknown> = {
    role: 'assistant',
    content: accumulated.text,
  }
  if (typeof accumulated.reasoning === 'string' && accumulated.reasoning !== '') {
    assistantMsg.reasoning_content = accumulated.reasoning
  }

  const next: Record<string, unknown> = {
    ...originalBody,
    messages: [
      ...prevMessages,
      assistantMsg,
      { role: 'user', content: nudge },
    ],
  }

  if (options?.disableThinking === true) {
    next.thinking = { type: 'disabled' }
    delete next.reasoning_effort
    delete next.reasoningEffort
  }

  return next
}

function sumNestedNumbers(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const prev = dst[k]
      dst[k] = typeof prev === 'number' && Number.isFinite(prev) ? prev + v : v
    } else if (isObject(v)) {
      const existing = dst[k]
      if (isObject(existing)) {
        const cloned = { ...existing }
        sumNestedNumbers(cloned, v)
        dst[k] = cloned
      } else {
        const cloned: Record<string, unknown> = {}
        sumNestedNumbers(cloned, v)
        dst[k] = cloned
      }
    } else {
      dst[k] = v
    }
  }
}

/**
 * 跨段合并面向客户端展示的 `usage`：
 * - `prompt_tokens` 及缓存命中明细取**最新一段**（续写段输入天然包含前文，累加会导致上下文长度虚高 N 倍）；
 * - `completion_tokens`、`credit` 等输出计费字段跨段累加；
 * - `total_tokens` 重算为 `prompt_tokens + completion_tokens`。
 */
export function mergeSegmentUsage(
  accumulated: Record<string, unknown> | undefined,
  segmentUsage: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = accumulated !== undefined ? { ...accumulated } : {}
  for (const [k, v] of Object.entries(segmentUsage)) {
    if (
      k === 'prompt_tokens' ||
      k === 'prompt_cache_hit_tokens' ||
      k === 'prompt_cache_miss_tokens' ||
      k === 'prompt_tokens_details'
    ) {
      out[k] = v
      continue
    }
    if (k === 'total_tokens') {
      out[k] = v
      continue
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const prev = out[k]
      out[k] = typeof prev === 'number' && Number.isFinite(prev) ? prev + v : v
      continue
    }
    if (isObject(v)) {
      const prev = out[k]
      const merged: Record<string, unknown> = isObject(prev) ? { ...prev } : {}
      sumNestedNumbers(merged, v)
      out[k] = merged
      continue
    }
    out[k] = v
  }

  if (typeof out.prompt_tokens === 'number') {
    const comp = typeof out.completion_tokens === 'number' ? out.completion_tokens : 0
    out.total_tokens = out.prompt_tokens + comp
  }
  return out
}

// ─────────────────────────── 可选流式包装器（供 server.ts 接线） ───────────────────────────

export interface ContinuationStreamOptions {
  /** 总开关（传 `false` 时直接原样返回 `initialStream`，零开销）。 */
  enabled?: boolean
  /** 是否启用 `finish_reason === 'length'` 截断续写（默认 `true`）。 */
  enableTruncationContinue?: boolean
  /** 是否启用预告句悬停救援（默认 `true`）。 */
  enableNarrationRescue?: boolean
  /** 原始 Chat 请求体对象（用于提取 `messages`、`tools`、`max_tokens` 并构造续写请求体）。 */
  requestBody: Record<string, unknown>
  /**
   * 发起下一段上游流请求的回调（同一账号/同一模型重发 `nextBody`）。
   * 返回 `null` 或抛错时自动优雅降级，按已有内容正常收尾，绝不弄坏已发出的流。
   */
  openNextSegment: (
    nextBody: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array> | null>
  /** 客户端请求的 `AbortSignal`（客户端取消时立即停止续写）。 */
  signal?: AbortSignal
  /** 换段等待期间发射 `: keepalive\n\n` 的间隔毫秒数（默认 `10_000`）。 */
  keepaliveIntervalMs?: number
  /** 最大总段数（默认 `3`）。 */
  maxContinueSegments?: number
  /** 最大预告句救援次数（默认 `2`）。 */
  maxNarrationRescues?: number
  /** 是否启用独立 `::browser-complete` 控制标记救援（默认随 `enableNarrationRescue` 开启）。 */
  enableBrowserCompleteRescue?: boolean
  /** 换段触发时的可选观测回调（供日志打点）。 */
  onSegmentSwitch?: (info: {
    kind: 'truncation' | 'narration' | 'browser_complete'
    segmentIndex: number
    reason: string
    textBytes: number
  }) => void
}

/**
 * 包装一条上游 OpenAI 兼容 SSE 流，透明执行截断自动续写、预告句悬停救援与等待期 `: keepalive\n\n` 心跳。
 *
 * 下游（`streamResponse` / `toResponsesSse` / `toAnthropicSse`）看到的始终是一条完整的单次 SSE 流：
 * 中间段的 `finish_reason` 与 `[DONE]` 被自动消隐，末尾统一输出合并后的 `usage` 帧与单个 `data: [DONE]\n\n`。
 */
export function wrapContinuationStream(
  initialStream: ReadableStream<Uint8Array>,
  options: ContinuationStreamOptions,
): ReadableStream<Uint8Array> {
  if (options.enabled === false) {
    return initialStream
  }

  const enableTrunc = options.enableTruncationContinue !== false
  const enableNarr = options.enableNarrationRescue !== false
  const enableBrowserComplete = options.enableBrowserCompleteRescue ?? enableNarr
  if (!enableTrunc && !enableNarr && !enableBrowserComplete) {
    return initialStream
  }

  const keepaliveMs =
    options.keepaliveIntervalMs !== undefined && options.keepaliveIntervalMs > 0
      ? options.keepaliveIntervalMs
      : DEFAULT_KEEPALIVE_INTERVAL_MS
  const maxSegments = options.maxContinueSegments ?? DEFAULT_MAX_CONTINUE_SEGMENTS
  const maxRescues = options.maxNarrationRescues ?? DEFAULT_MAX_NARRATION_RESCUES
  const explicitMaxTokens = extractExplicitMaxTokens(options.requestBody)

  const abortController = new AbortController()
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      abortController.abort(options.signal.reason)
    } else {
      options.signal.addEventListener(
        'abort',
        () => abortController.abort(options.signal?.reason),
        { once: true },
      )
    }
  }

  const isClientAborted = (): boolean => abortController.signal.aborted

  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let currentStream: ReadableStream<Uint8Array> = initialStream
      let segmentIndex = 0
      let narrationRescuesUsed = 0
      let lastRescueTextLength: number | undefined
      let browserCompleteTried = false

      let fullText = ''
      let fullReasoning = ''
      let sawToolCalls = false
      let sawError = false
      let emittedAnyData = false
      let lastEmitAt = Date.now()
      let streamId = ''
      let mergedUsage: Record<string, unknown> | undefined

      const emitRaw = (raw: string): void => {
        controller.enqueue(encoder.encode(raw))
        lastEmitAt = Date.now()
      }

      const emitDataPayload = (payload: string): void => {
        emittedAnyData = true
        emitRaw(`data: ${payload}\n\n`)
      }

      const maybeEmitKeepalive = (): void => {
        if (!emittedAnyData) return
        if (Date.now() - lastEmitAt >= keepaliveMs) {
          emitRaw(KEEPALIVE_FRAME)
        }
      }

      /** 异步等待下一段上游连接建立，等待窗口内按 `keepaliveMs` 发射 `: keepalive\n\n`。 */
      const openNextWithKeepalive = async (
        nextBody: Record<string, unknown>,
      ): Promise<ReadableStream<Uint8Array> | null> => {
        let settled = false
        const openPromise = options
          .openNextSegment(nextBody, abortController.signal)
          .then((res) => {
            settled = true
            return res
          })
          .catch((err: unknown) => {
            settled = true
            console.warn(
              '[continuation] 续写段请求失败，按已有内容收尾：',
              err instanceof Error ? err.message : String(err),
            )
            return null
          })

        while (!settled && !isClientAborted()) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const tick = new Promise<'tick'>((resolve) => {
            timer = setTimeout(() => resolve('tick'), keepaliveMs)
          })
          try {
            const winner = await Promise.race([
              openPromise.then((s) => ({ kind: 'done' as const, stream: s })),
              tick.then(() => ({ kind: 'tick' as const })),
            ])
            if (winner.kind === 'done') {
              return winner.stream
            }
            if (emittedAnyData && !isClientAborted()) {
              emitRaw(KEEPALIVE_FRAME)
            }
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        }

        return isClientAborted() ? null : await openPromise
      }

      try {
        for (;;) {
          const reader = currentStream.getReader()
          activeReader = reader
          const decoder = new TextDecoder()
          let buffer = ''
          let segFinishReason: string | null = null
          let segSawDone = false
          let segCompletionTokens = 0
          let segReasoningTokens = 0
          let segLatestUsage: Record<string, unknown> | undefined
          let tailPayloads: string[] = []
          let browserHold = ''
          let browserCompleteSeen = false
          let browserIncomplete = false
          let suppressedBrowserDirectiveText = ''

          const filterBrowserContent = (deltaText: string): { visible: string; hidden: boolean } => {
            if (
              !enableBrowserComplete ||
              browserCompleteTried ||
              browserCompleteSeen ||
              (browserHold === '' && fullText.trim() !== '')
            ) {
              return { visible: deltaText, hidden: false }
            }

            const combined = browserHold + deltaText
            browserHold = ''
            const core = combined.replace(/^[ \t\r\n]+/, '')
            if (core === '') {
              browserHold = combined
              return { visible: '', hidden: true }
            }
            if (
              !BROWSER_COMPLETE_PREFIX.startsWith(core) &&
              !core.startsWith(BROWSER_COMPLETE_PREFIX)
            ) {
              return { visible: combined, hidden: false }
            }
            if (!core.startsWith(BROWSER_COMPLETE_PREFIX)) {
              browserHold = combined
              return { visible: '', hidden: true }
            }
            const rest = core.slice(BROWSER_COMPLETE_PREFIX.length)
            if (rest === '') {
              browserHold = combined
              return { visible: '', hidden: true }
            }
            if (!rest.startsWith('{')) {
              // 前缀误报（例如 `::browser-completed`）：完整吐回之前暂存的片段
              return { visible: combined, hidden: false }
            }
            const end = rest.indexOf('}')
            if (end < 0) {
              browserHold = combined
              return { visible: '', hidden: true }
            }
            browserCompleteSeen = true
            const closeOffsetInCombined =
              combined.length - core.length + BROWSER_COMPLETE_PREFIX.length + end + 1
            suppressedBrowserDirectiveText = combined.slice(0, closeOffsetInCombined)
            const tail = rest.slice(end + 1)
            if (tail.trim() === '') {
              return { visible: '', hidden: true }
            }
            // 控制标记后紧跟真实正文：标记不触发独立救援，把整段原样交还可见流以免吞字
            suppressedBrowserDirectiveText = ''
            return { visible: combined, hidden: false }
          }

          const flushBrowserHold = (): void => {
            const pending = browserHold
            browserHold = ''
            if (pending === '' || pending.trim() === '') return
            browserIncomplete = true
            const chunkFrame: Record<string, unknown> = {
              id: streamId,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: pending }, finish_reason: null }],
            }
            emitDataPayload(JSON.stringify(chunkFrame))
          }

          const handleLine = (line: string): void => {
            const trimmed = line.trim()
            if (trimmed === '') return
            if (trimmed.startsWith(':')) {
              emitRaw(`${trimmed}\n\n`)
              return
            }

            const parsedLine = parseSseLine(line)
            if (parsedLine.kind === 'done') {
              segSawDone = true
              return
            }
            if (parsedLine.kind === 'error') {
              sawError = true
              const errJson = JSON.stringify({
                error: { message: parsedLine.error ?? '非预期 SSE 帧', type: 'upstream_error' },
              })
              emitDataPayload(errJson)
              return
            }
            if (parsedLine.kind !== 'chunk' || parsedLine.data === undefined) return

            let frame: Record<string, unknown>
            try {
              const obj = JSON.parse(parsedLine.data) as unknown
              if (!isObject(obj)) {
                emitDataPayload(parsedLine.data)
                return
              }
              frame = obj
            } catch {
              emitDataPayload(parsedLine.data)
              return
            }

            if (detectErrorFrame(frame) !== undefined) {
              sawError = true
              emitDataPayload(parsedLine.data)
              return
            }

            if (typeof frame.id === 'string' && frame.id !== '' && streamId === '') {
              streamId = frame.id
            }

            let rebuilt = false
            let hasUsage = false
            if (isObject(frame.usage)) {
              hasUsage = true
              segLatestUsage = frame.usage
              if (typeof frame.usage.completion_tokens === 'number') {
                segCompletionTokens = frame.usage.completion_tokens
              }
              if (typeof frame.usage.completion_thinking_tokens === 'number') {
                segReasoningTokens = frame.usage.completion_thinking_tokens
              } else if (
                isObject(frame.usage.completion_tokens_details) &&
                typeof frame.usage.completion_tokens_details.reasoning_tokens === 'number'
              ) {
                segReasoningTokens = frame.usage.completion_tokens_details.reasoning_tokens
              }
              delete frame.usage
              rebuilt = true
            }

            let deltaNonEmpty = false
            let hiddenContentOnly = false
            let frameFinish: string | null = null

            if (Array.isArray(frame.choices) && frame.choices.length > 0) {
              const c0 = frame.choices[0]
              if (isObject(c0)) {
                if (typeof c0.finish_reason === 'string' && c0.finish_reason !== '') {
                  frameFinish = c0.finish_reason
                  segFinishReason = c0.finish_reason
                }
                const delta = isObject(c0.delta) ? c0.delta : undefined
                if (delta !== undefined) {
                  const rc = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
                  if (rc !== '') {
                    fullReasoning += rc
                    // 续写段在正文已开始后剥离思考分片，防止下游重开第二个 reasoning 块导致事件乱序
                    if (segmentIndex > 0 && fullText.length > 0) {
                      delete delta.reasoning_content
                      rebuilt = true
                    } else {
                      deltaNonEmpty = true
                    }
                  }
                  const content = typeof delta.content === 'string' ? delta.content : ''
                  if (content !== '') {
                    const filtered = filterBrowserContent(content)
                    fullText += content
                    if (filtered.hidden) {
                      hiddenContentOnly = filtered.visible === ''
                      if (hiddenContentOnly) {
                        delete delta.content
                      } else {
                        delta.content = filtered.visible
                      }
                      rebuilt = true
                    } else if (filtered.visible !== content) {
                      delta.content = filtered.visible
                      rebuilt = true
                    }
                    if (filtered.visible !== '') {
                      deltaNonEmpty = true
                    }
                  }
                  const refusal = typeof delta.refusal === 'string' ? delta.refusal : ''
                  if (refusal !== '') {
                    deltaNonEmpty = true
                  }
                  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                    sawToolCalls = true
                    deltaNonEmpty = true
                  }
                  if (isObject(delta.function_call)) {
                    sawToolCalls = true
                    deltaNonEmpty = true
                  }
                }

                // 若同一帧同时携带有效 delta 与 finish_reason：先把 delta 立即下发，
                // 再把纯 finish_reason 留入 tailPayloads（若触发续写则丢弃，不触发则收尾回放）。
                if (frameFinish !== null && deltaNonEmpty) {
                  const contentFrame: Record<string, unknown> = {
                    ...frame,
                    choices: [{ ...c0, finish_reason: null }],
                  }
                  emitDataPayload(JSON.stringify(contentFrame))
                  const terminalOnly: Record<string, unknown> = {
                    id: streamId || (typeof frame.id === 'string' ? frame.id : ''),
                    object: 'chat.completion.chunk',
                    ...(typeof frame.model === 'string' ? { model: frame.model } : {}),
                    choices: [{ index: 0, delta: {}, finish_reason: frameFinish }],
                  }
                  tailPayloads.push(JSON.stringify(terminalOnly))
                  return
                }
              }
            }

            const outPayload = rebuilt ? JSON.stringify(frame) : parsedLine.data

            if (segFinishReason !== null) {
              if (frameFinish !== null || deltaNonEmpty) {
                tailPayloads.push(outPayload)
              }
              return
            }

            if (hasUsage && !deltaNonEmpty) {
              return
            }

            if (hiddenContentOnly && !deltaNonEmpty && frameFinish === null) {
              maybeEmitKeepalive()
              return
            }

            if (segmentIndex > 0 && !deltaNonEmpty) {
              maybeEmitKeepalive()
              return
            }

            emitDataPayload(outPayload)
          }

          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value === undefined) continue
              buffer += decoder.decode(value, { stream: true })
              let nl = buffer.indexOf('\n')
              while (nl >= 0) {
                const line = buffer.slice(0, nl)
                buffer = buffer.slice(nl + 1)
                nl = buffer.indexOf('\n')
                handleLine(line)
              }
            }
            const rest = (buffer + decoder.decode()).trim()
            if (rest !== '') handleLine(rest)
          } finally {
            try {
              reader.releaseLock()
            } catch {
              // 忽略
            }
            activeReader = undefined
          }

          if (segLatestUsage !== undefined) {
            mergedUsage = mergeSegmentUsage(mergedUsage, segLatestUsage)
          }

          // 未闭合的 `::browser-...` 候选片段原样刷出，保证非控制标记正文零吞字
          flushBrowserHold()

          // ── 段结束：依次判定「`::browser-complete` 控制标记救援」「预告句悬停救援」「截断自动续写」──
          let nextBody: Record<string, unknown> | undefined
          let switchKind: 'narration' | 'truncation' | 'browser_complete' | undefined
          let switchReason = ''

          if (enableBrowserComplete && browserCompleteSeen) {
            const bcDecision = shouldRescueBrowserComplete({
              finishReason: segFinishReason,
              text: fullText,
              hasToolCalls: sawToolCalls,
              hasError: sawError,
              clientAborted: isClientAborted(),
              requestBody: options.requestBody,
              browserCompleteTried,
              segmentIndex,
              maxSegments,
            })
            if (bcDecision.rescue && bcDecision.nudge !== undefined) {
              nextBody = buildContinuationBody(
                options.requestBody,
                { text: fullText, reasoning: fullReasoning },
                bcDecision.nudge,
              )
              switchKind = 'browser_complete'
              switchReason = bcDecision.reason
            }
          }

          if (nextBody === undefined && enableNarr && !browserIncomplete && !browserCompleteTried && !browserCompleteSeen) {
            const narrDecision = shouldRescueNarrationHover({
              finishReason: segFinishReason,
              text: fullText,
              hasToolCalls: sawToolCalls,
              hasError: sawError,
              clientAborted: isClientAborted(),
              requestBody: options.requestBody,
              narrationRescuesUsed,
              maxNarrationRescues: maxRescues,
              ...(lastRescueTextLength !== undefined ? { lastRescueTextLength } : {}),
            })
            if (narrDecision.rescue && narrDecision.nudge !== undefined) {
              nextBody = buildContinuationBody(
                options.requestBody,
                { text: fullText, reasoning: fullReasoning },
                narrDecision.nudge,
              )
              switchKind = 'narration'
              switchReason = narrDecision.reason
            }
          }

          if (nextBody === undefined && enableTrunc) {
            const shouldCont = shouldContinueTruncated({
              finishReason: segFinishReason,
              hasToolCalls: sawToolCalls,
              hasError: sawError,
              clientAborted: isClientAborted(),
              textLength: fullText.length,
              reasoningLength: fullReasoning.length,
              ...(explicitMaxTokens !== undefined ? { maxTokens: explicitMaxTokens } : {}),
              segmentIndex,
              maxSegments,
              segmentCompletionTokens: segCompletionTokens,
              segmentReasoningTokens: segReasoningTokens,
            })
            if (shouldCont) {
              const starved =
                explicitMaxTokens !== undefined &&
                segCompletionTokens > 0 &&
                segReasoningTokens >= THINKING_STARVED_SHARE * segCompletionTokens
              nextBody = buildContinuationBody(
                options.requestBody,
                { text: fullText, reasoning: fullReasoning },
                CONTINUE_NUDGE,
                { disableThinking: starved },
              )
              switchKind = 'truncation'
              switchReason = starved ? 'length_thinking_starved' : 'length_truncated'
            }
          }

          if (nextBody !== undefined && switchKind !== undefined) {
            const prevRescueCount = narrationRescuesUsed
            const prevRescueTextAt = lastRescueTextLength
            const prevBrowserTried = browserCompleteTried
            if (switchKind === 'narration') {
              narrationRescuesUsed += 1
              lastRescueTextLength = fullText.length
            } else if (switchKind === 'browser_complete') {
              browserCompleteTried = true
            }
            const nextStream = await openNextWithKeepalive(nextBody)
            if (nextStream !== null) {
              segmentIndex += 1
              tailPayloads = []
              suppressedBrowserDirectiveText = ''
              options.onSegmentSwitch?.({
                kind: switchKind,
                segmentIndex,
                reason: switchReason,
                textBytes: utf8ByteLength(fullText),
              })
              currentStream = nextStream
              continue
            }
            // 换段请求失败：回退计数并按原段尾帧正常收尾
            narrationRescuesUsed = prevRescueCount
            lastRescueTextLength = prevRescueTextAt
            browserCompleteTried = prevBrowserTried
          }

          // 若吞下了独立的 `::browser-complete{...}` 但未触发救援（如无工具上下文）或续写请求失败，原样补发以免回空流
          if (suppressedBrowserDirectiveText !== '') {
            const fallbackFrame: Record<string, unknown> = {
              id: streamId,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: suppressedBrowserDirectiveText }, finish_reason: null }],
            }
            emitDataPayload(JSON.stringify(fallbackFrame))
            suppressedBrowserDirectiveText = ''
          }

          // ── 最终收尾：回放末段终态帧 → 输出合并 usage 帧 → [DONE] ──
          for (const tail of tailPayloads) {
            emitDataPayload(tail)
          }
          if (mergedUsage !== undefined) {
            const usageFrame: Record<string, unknown> = {
              id: streamId,
              object: 'chat.completion.chunk',
              choices: [],
              usage: mergedUsage,
            }
            emitDataPayload(JSON.stringify(usageFrame))
          }
          if (segSawDone || emittedAnyData) {
            emitRaw('data: [DONE]\n\n')
          }
          break
        }
      } finally {
        controller.close()
      }
    },
    async cancel(reason) {
      abortController.abort(reason)
      if (activeReader !== undefined) {
        try {
          await activeReader.cancel(reason)
        } catch {
          // 忽略
        }
      }
    },
  })
}
