/**
 * 国际版（workbuddy.ai）**每日活跃打卡**：把一条网页端云 agent 会话真正跑完。
 *
 * 移植自 [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)
 *（MIT）的 `wb_accounts.py::_daily_chat_web_once` 与 `wb_webagent.py::run_turn`。
 *
 * ## 为什么不是 chat/completions
 *
 * 国际版**没有**签到接口；官方的每日活跃积分（30/50）认的是「**跑完的网页端 agent 会话**」：
 * - 桌面身份发 chat/completions **不计数**（参考项目 issue #75、#59 实测）；
 * - 只建会话、不接沙箱也**不计数** —— 会话会永远停在 CREATING（issue #90 实测）。
 *
 * ## 流程（全部来自参考项目抓包）
 *
 * 1. `POST /console/as/conversations/` 建会话（只是**排队**）；
 * 2. `GET /console/as/conversations/{id}/session` 取沙箱 `link` + `token`；
 * 3. ACP over streamable HTTP：`GET link`（SSE）拿 `Acp-Connection-Id`，保持流打开；
 *    再逐条 `POST link` JSON-RPC：`initialize` → `session/load` →
 *    `session/set_model` → `session/prompt`；
 * 4. 轮询 `GET /console/as/conversations/{id}` 直到 `status === 'completed'`。
 *
 * ⚠️ `session/set_model` **必须发**：建会话 body 里的 `model` 只写进 manifest，
 * 不发这条的话这一轮按账号默认模型（网页端默认 Auto，**按付费模型计费**）跑 ——
 * 每天的活跃都在扣积分。失败不致命（仍把这一轮跑完），但会写进结果说明。
 *
 * ## Workers 预算
 *
 * 一次打卡 ≈ 1 建会话 + ≤3 取沙箱 + 1 SSE + 4 JSON-RPC + ≤25 轮询 ≈ 35 个子请求，
 * 在 Free 计划单次调用 50 的上限内 —— 故**只能**在 TaskRunner 的单步 alarm 里跑
 *（每步独立预算），不能在一个 HTTP 请求里对多个账号串行跑。
 */

export const WEB_ORIGIN = 'https://www.workbuddy.ai'
export const WEB_CONVERSATIONS_URL = `${WEB_ORIGIN}/console/as/conversations/`
/** 网页端 UA（参考项目抓包值）。 */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
/** 打卡用的免费模型（参考项目默认值；可用 env `WORKBUDDY_DAILY_CHAT_MODEL` 覆盖）。 */
export const DEFAULT_DAILY_CHAT_MODEL = 'deepseek-v4.1-flash'
export const DAILY_CHAT_PROMPT = 'Hi'

const ACP_PROTOCOL_VERSION = 1
/** 打卡只需要 agent 把话说完，不提供文件系统/终端能力。 */
const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false }

export interface WebDailyChatInput {
  uid: string
  accessToken: string
}

export interface WebDailyChatOptions {
  model?: string
  prompt?: string
  /** 发出 prompt 后最多等多久跑完（默认 120s；参考实测一次「Hi」十几秒）。 */
  waitMs?: number
  /** 状态轮询间隔（默认 5s）。 */
  pollMs?: number
  /** 单个 HTTP 请求的超时（默认 30s）。 */
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface WebDailyChatResult {
  ok: boolean
  conversationId: string
  status: string
  /** SSE 收到的 `session/update` 条数。 */
  updates: number
  /** 其中 `agent_message_chunk` 的条数（agent 真的说话了）。 */
  chunks: number
  /** `session/set_model` 是否成功（false ⇒ 这一轮可能按付费模型计费）。 */
  modelPinned: boolean
  /**
   * **收尾是否成功**（`session/stop` 或 `DELETE` 任一成功）。
   *
   * ⚠️ 必须往外暴露：未收尾的会话**占着该账号的活跃会话配额**
   *（上游上限 10 条），攒满后**再也建不出新会话** —— 明日的活跃打卡会直接失败，
   * 而失败原因看起来像「沙箱未就绪」，与真实原因（配额满）毫无关系。
   */
  released: boolean
  /** 收尾方式的说明（排障用：「为什么 released=false」）。 */
  releaseNote: string
  elapsedMs: number
  detail: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

class WebAgentError extends Error {}

/** 网页版 app 的出站头：只有 bearer 与 X-User-Id，没有桌面端指纹。 */
export function webAgentHeaders(input: WebDailyChatInput): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    // ⚠️ 账号池里的 uid 带 `workbuddy:` 前缀，上游要裸 uid（同 headers.ts 国际版桌面头）
    'X-User-Id': input.uid.replace(/^workbuddy:/, ''),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/app`,
    'User-Agent': WEB_USER_AGENT,
  }
}

/** 解析一段 SSE 文本里的 JSON-RPC 消息（只看 `data:` 行）。 */
export function parseSseMessages(text: string): Obj[] {
  const out: Obj[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const msg = JSON.parse(payload) as unknown
      if (isObj(msg)) out.push(msg)
    } catch {
      // 半行/非 JSON：忽略
    }
  }
  return out
}

/**
 * 跑一次国际版网页端每日活跃对话。
 *
 * **不抛异常**：任何失败都折成 `{ ok: false, detail }`，便于任务引擎如实记录。
 */
export async function runWebDailyChat(
  input: WebDailyChatInput,
  options: WebDailyChatOptions = {},
): Promise<WebDailyChatResult> {
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now
  const model = (options.model ?? '').trim() || DEFAULT_DAILY_CHAT_MODEL
  const prompt = options.prompt ?? DAILY_CHAT_PROMPT
  const waitMs = Math.max(1_000, options.waitMs ?? 120_000)
  const pollMs = Math.max(0, options.pollMs ?? 5_000)
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  const headers = webAgentHeaders(input)
  const started = now()

  const result: WebDailyChatResult = {
    ok: false, conversationId: '', status: '', updates: 0, chunks: 0, modelPinned: false,
    released: false, releaseNote: '未执行', elapsedMs: 0, detail: '',
  }
  const finish = (ok: boolean, detail: string): WebDailyChatResult => {
    result.ok = ok
    result.detail = detail
    result.elapsedMs = now() - started
    return result
  }

  const getJson = async (url: string, init: RequestInit): Promise<Obj> => {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) throw new WebAgentError(`HTTP ${res.status}${text === '' ? '' : `: ${text.slice(0, 120)}`}`)
    try {
      const parsed = JSON.parse(text === '' ? '{}' : text) as unknown
      if (!isObj(parsed)) throw new WebAgentError('响应不是 JSON 对象')
      return parsed
    } catch (error) {
      if (error instanceof WebAgentError) throw error
      throw new WebAgentError(`响应不是 JSON：${text.slice(0, 120)}`)
    }
  }
  const conversationStatus = async (id: string): Promise<string> => {
    try {
      const payload = await getJson(WEB_CONVERSATIONS_URL + encodeURIComponent(id), { method: 'GET', headers })
      return str(isObj(payload.data) ? payload.data.status : '').trim().toLowerCase()
    } catch {
      return ''
    }
  }

  /**
   * 🔴 **收尾：释放会话**（2026-11-05 补，社区实践确认的必要步骤）。
   *
   * ## 为什么必须有
   *
   * 国际版单个账号的**活跃会话上限是 10 条**。跑完不收尾的会话会一直挂着，
   * 攒满后 `POST /console/as/conversations/` 直接建不出新会话 ——
   * 而错误长相是「沙箱未就绪」，与真实原因（配额满）毫无关系，极难排查。
   *
   * ⇒ 每日打卡每天建一条 ⇒ **第 11 天起必然全挂**，且是静默累积的。
   *
   * ## 两种收尾方式（依次尝试，任一成功即可）
   *
   * 1. **ACP `session/stop`**：通过沙箱的 JSON-RPC 通道正式终止这一轮（最干净，
   *    上游会立刻回收沙箱）；
   * 2. **`DELETE /console/as/conversations/{id}`**：直删会话记录（兜底）。
   *    沙箱可能还在跑，但会话条目消失后不再占配额。
   *
   * ⚠️ 两者都失败才记 `released=false` —— 那要如实报到面板上，
   * 否则用户只会在 **10 天后**突然发现「活跃打卡全失败」。
   */
  const releaseConversation = async (
    conversationId: string,
    stop: (() => Promise<void>) | undefined,
  ): Promise<{ released: boolean; note: string }> => {
    const notes: string[] = []
    if (stop !== undefined) {
      try {
        await stop()
        return { released: true, note: 'session/stop 已终止' }
      } catch (error) {
        notes.push(`stop: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const res = await doFetch(WEB_CONVERSATIONS_URL + encodeURIComponent(conversationId), {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      // ⚠️ 404 也算成功：会话已经不在了 = 配额已释放（幂等）
      if (res.ok || res.status === 404) {
        return { released: true, note: notes.length > 0 ? `DELETE 兜底成功（${notes.join('；')}）` : 'DELETE 已删除' }
      }
      notes.push(`DELETE: HTTP ${res.status}`)
    } catch (error) {
      notes.push(`DELETE: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { released: false, note: notes.join('；') || '未知原因' }
  }

  // 1. 建会话（只是排队）
  let conversation = ''
  try {
    const payload = await getJson(WEB_CONVERSATIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt,
        model,
        // 网页端建会话时固定带上这两项（抓包所得），保持请求形态一致
        conversationOrigin: 'workbuddy-app',
        plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
      }),
    })
    conversation = str(isObj(payload.data) ? payload.data.id : '')
    const code = payload.code
    if ((code !== undefined && code !== null && code !== 0) || conversation === '') {
      return finish(false, `建会话失败：code=${str(code) || '?'} msg=${str(payload.msg) || str(payload.message) || '无'}`)
    }
  } catch (error) {
    return finish(false, `建会话失败：${error instanceof Error ? error.message : String(error)}`)
  }
  result.conversationId = conversation

  // 2. 取沙箱（刚建完可能还没分配，短轮询几次）
  let link = ''
  let token = ''
  let sessionId = conversation
  let cwd = '/workspace'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await getJson(`${WEB_CONVERSATIONS_URL}${encodeURIComponent(conversation)}/session`, {
        method: 'GET', headers,
      })
      const data = isObj(payload.data) ? payload.data : {}
      link = str(data.link) || str(data.endpoint)
      token = str(data.token)
      sessionId = str(data.sessionId) || str(data.session_id) || conversation
      cwd = str(data.cwd) || '/workspace'
    } catch (error) {
      if (attempt === 2) return finish(false, `沙箱查询失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (link !== '' && token !== '') break
    if (attempt < 2) await sleep(2_000)
  }
  if (link === '' || token === '') return finish(false, '沙箱未就绪（session 没有 link/token）')
  if (!/^https?:\/\//i.test(link)) return finish(false, `沙箱地址不可用：${link.slice(0, 80)}`)

  // 3. ACP：SSE 通道 + JSON-RPC
  const sseAbort = new AbortController()
  let sseReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let pump: Promise<void> | undefined
  let promptDone = false
  /**
   * 收尾用：`session/stop` 闭包（**必须在 SSE 通道关闭前**调用）。
   *
   * ⚠️ 在 try 里赋值，在 finally 里消费 —— 声明放在外面是为了跨块可见。
   * 未赋值 = 通道都没建立起来，没什么可 stop 的，直接走 DELETE 兜底。
   */
  let stopAcp: (() => Promise<void>) | undefined
  /**
   * 失败原因（在 catch 里落笔，在 finally 的收尾之后统一 `finish`）。
   *
   * ⚠️ 不能在 catch 里直接 return：那样会跳过 finally 之后的收尾结果回填，
   * 失败路径就看不到 `released` —— 而「失败且没释放」正是最需要报警的组合。
   */
  let failure = ''
  try {
    const sse = await doFetch(link, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'User-Agent': WEB_USER_AGENT },
      signal: sseAbort.signal,
    })
    if (sse.status !== 200) {
      await sse.body?.cancel().catch(() => {})
      throw new WebAgentError(`SSE 通道返回 HTTP ${sse.status}`)
    }
    const connectionId = sse.headers.get('Acp-Connection-Id') ?? ''
    if (connectionId === '') {
      await sse.body?.cancel().catch(() => {})
      throw new WebAgentError('SSE 通道没有返回 Acp-Connection-Id')
    }

    // 后台读流：统计 session/update；看到 session/prompt（id 4）的响应 ⇒ 这一轮说完了
    if (sse.body !== null) {
      const reader = sse.body.getReader()
      sseReader = reader
      pump = (async () => {
        const decoder = new TextDecoder()
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const cut = buf.lastIndexOf('\n')
            if (cut < 0) continue
            const complete = buf.slice(0, cut)
            buf = buf.slice(cut + 1)
            for (const msg of parseSseMessages(complete)) {
              if (msg.method === 'session/update') {
                result.updates += 1
                const update = isObj(msg.params) && isObj(msg.params.update) ? msg.params.update : {}
                if (update.sessionUpdate === 'agent_message_chunk') result.chunks += 1
              } else if (msg.id === 4 && ('result' in msg || 'error' in msg)) {
                promptDone = true
              }
            }
          }
        } catch {
          // 连接被关/超时：由状态轮询兜底
        }
      })()
    }

    const rpcRaw = async (id: number, method: string, params: Obj): Promise<Obj> => {
      const res = await doFetch(link, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Acp-Connection-Id': connectionId,
          Authorization: `Bearer ${token}`,
          'User-Agent': WEB_USER_AGENT,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text().catch(() => '')
      if (res.status !== 200 && res.status !== 202) throw new WebAgentError(`${method} 返回 HTTP ${res.status}`)
      // ⚠️ ACP 可能用 SSE 包一层（`data: {...}`），也可能直接回 JSON —— 两种都认。
      if (text.trim() === '') return {}
      const direct = (() => {
        try {
          const parsed = JSON.parse(text) as unknown
          return isObj(parsed) ? parsed : undefined
        } catch {
          return undefined
        }
      })()
      if (direct !== undefined) return direct
      const frames = parseSseMessages(text)
      return frames.find((f) => f.id === id) ?? {}
    }

    const rpc = async (id: number, method: string, params: Obj): Promise<void> => {
      await rpcRaw(id, method, params)
    }

    // ⚠️ `initialize` 的 result 里带 **agent 侧 sessionId** —— 后续所有 ACP 调用
    // 必须用它，不能用网页会话 id（两者不是一回事：前者是沙箱内 ACP 会话，
    // 后者是 `console/as/conversations` 的资源 id）。
    //
    // 原实现直接把网页会话 id 当成 ACP sessionId 传给 `session/load`，
    // 那条调用必然失败（我们只做了「不致命」的容错，所以从表面看不出问题）。
    let acpSessionId = sessionId
    try {
      const initRes = await rpcRaw(1, 'initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
      })
      const fromInit = str(isObj(initRes.result) ? (initRes.result as Obj).sessionId : '')
      if (fromInit !== '') acpSessionId = fromInit
    } catch {
      // initialize 失败会让后面全部失败 —— 由下面的 rpc 调用如实报错
    }
    await rpc(2, 'session/load', { sessionId: acpSessionId, cwd, mcpServers: [] })
    try {
      await rpc(3, 'session/set_model', { sessionId: acpSessionId, modelId: model })
      result.modelPinned = true
    } catch {
      result.modelPinned = false
    }
    await rpc(4, 'session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text: prompt }] })

    /**
     * 收尾用的 `session/stop`（在 SSE 通道关闭**之前**才能发，故这里先备好闭包）。
     *
     * ⚠️ 用独立 id（99）避免与 1–4 冲突。
     */
    stopAcp = () => rpc(99, 'session/stop', { sessionId: acpSessionId })

    // 4. 轮询会话状态（completed 才算数）
    const deadline = now() + waitMs
    for (;;) {
      const status = await conversationStatus(conversation)
      if (status !== '') result.status = status
      if (status === 'completed') break
      if (status === 'failed' || status === 'error') throw new WebAgentError(`会话状态=${status}`)
      if (now() + pollMs > deadline) {
        throw new WebAgentError(
          `会话在 ${Math.round(waitMs / 1000)}s 内没有跑完（状态=${result.status || '未知'}${promptDone ? '，agent 已回复' : ''}）`,
        )
      }
      await sleep(pollMs)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    failure = `网页端会话失败：${reason}`
  } finally {
    /**
     * 🔴 **收尾必须在关闭 SSE 之前做**（2026-11-05 补）。
     *
     * `session/stop` 走的是同一条 ACP 通道，通道先 abort 就发不出去了。
     * 顺序错了会静默退化成「只能 DELETE」—— 能救，但沙箱要多跑一会儿、
     * 也更容易被上游判成「客户端异常断开」。
     *
     * ⚠️ 收尾本身**不许抛**：会话已经跑完了，收尾失败不该把成功变成失败
     *（但必须如实报到 `released` / `releaseNote` 上）。
     */
    try {
      const r = await releaseConversation(conversation, stopAcp)
      result.released = r.released
      result.releaseNote = r.note
    } catch (error) {
      result.released = false
      result.releaseNote = `收尾异常：${error instanceof Error ? error.message : String(error)}`
    }
    sseAbort.abort()
    await sseReader?.cancel().catch(() => {})
    await pump?.catch(() => {})
  }

  // ⚠️ 收尾之后才判成功/失败：收尾失败**不影响** ok（见 finally 的注释），
  // 但要在 detail 里如实说一句，面板上才看得到「明天可能建不出会话」。
  if (failure !== '') return finish(false, `${failure}；收尾：${result.releaseNote}`)

  return finish(
    true,
    `网页端会话跑完：${result.chunks} 段输出`
      + (result.modelPinned ? `（模型 ${model}）` : `（⚠️ session/set_model 失败，可能按默认模型计费）`)
      + `；收尾：${result.released ? result.releaseNote : `⚠️ 未释放（${result.releaseNote}）`}`,
  )
}
