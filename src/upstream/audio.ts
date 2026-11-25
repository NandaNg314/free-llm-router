/**
 * WorkBuddy 语音能力（TTS / ASR）的上游协议适配。
 *
 * - TTS：`POST /v2/audio/speech`，SSE 里回 base64 PCM（24 kHz / 单声道 / 16 bit）。
 *   上游不提供 MP3，故只接受 `wav` 与 `pcm` 两种 `response_format`。
 * - ASR：`POST /agenttool/v1/asr`，multipart 字段名必须是 `audio`，上限 3 MiB。
 *
 * 两类失败必须区分：未知音色 / 无法识别的音频是**请求错误**（400，不换号、不罚号）；
 * 其余才是账号或上游故障（交由媒体路由换号）。
 */
import type { Env } from '../env.js'
import { classify, UpstreamError } from './client.js'
import { desktopUserAgent } from './headers.js'
import { INTl_WEB_BASE } from './media.js'

export const TTS_DEFAULT_MODEL = 'hunyuan-tts-2.5'
export const TTS_DEFAULT_VOICE = 'f191_female_cn_tts2.5_flash'
export const TTS_SAMPLE_RATE = 24_000
export const TTS_CHANNELS = 1
export const TTS_SAMPLE_WIDTH = 2
export const TTS_MAX_PCM_BYTES = 32 * 1024 * 1024

export const ASR_DEFAULT_MODEL = 'hunyuan-asr'
export const ASR_MAX_BYTES = 3 * 1024 * 1024
export const ASR_REQUEST_MAX_BYTES = ASR_MAX_BYTES + 64 * 1024
export const ASR_FIELD_NAMES = ['file', 'audio'] as const
export const ASR_RESPONSE_FORMATS = ['json', 'text'] as const
export type AsrResponseFormat = (typeof ASR_RESPONSE_FORMATS)[number]

type AudioContext = {
  uid: string
  accessToken: string
  realm?: string
  enterpriseId?: string
}

export class AudioRequestError extends UpstreamError {
  constructor(status: number, code: string, message: string) {
    const numeric = Number.parseInt(code, 10)
    super({
      kind: 'bad_request',
      httpStatus: status,
      ...(Number.isFinite(numeric) ? { code: numeric } : {}),
      message,
      detail: code,
    })
    this.name = 'AudioRequestError'
  }
}

/**
 * 语音端点挂在**产品前端域名**上（官方客户端用 `productManager.getEndpoint()`）：
 * Cn 是 `www.workbuddy.cn`，国际版是 `www.workbuddy.ai`。
 * 用 `copilot.tencent.com` 会得到 11101 `missing required header`（实测 2026-11-21）。
 */
const CN_AUDIO_BASE = 'https://www.workbuddy.cn'

function audioBase(realm: string): string {
  return realm === 'cn' ? CN_AUDIO_BASE : INTl_WEB_BASE
}

function audioHeaders(ctx: AudioContext, accept: string): Record<string, string> {
  // 头族与官方 TTS 客户端逐项对齐（app.asar `TtsService.consumeSpeechStream`）：
  // IDE 身份 + 四个 UUID 会话头 + UA + X-Domain。多带 agenttool 那套头会被判成
  // 11101 `missing required header`（实测 2026-11-21）。
  const realm = ctx.realm === 'cn' ? 'cn' : 'global'
  const domain = realm === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai'
  const uid = realm === 'cn' ? ctx.uid : ctx.uid.replace(/^workbuddy:/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: accept,
    Authorization: `Bearer ${ctx.accessToken}`,
    'X-User-Id': uid,
    'X-Domain': domain,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'User-Agent': desktopUserAgent(realm),
    'X-Request-ID': crypto.randomUUID(),
    'X-Conversation-ID': crypto.randomUUID(),
    'X-Conversation-Request-ID': crypto.randomUUID(),
    'X-Conversation-Message-ID': crypto.randomUUID(),
  }
  if (ctx.enterpriseId !== undefined && ctx.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = ctx.enterpriseId
    headers['X-Tenant-Id'] = ctx.enterpriseId
  }
  return headers
}

function upstreamErrorOf(path: string, httpStatus: number, raw: string): UpstreamError {
  const c = classify(httpStatus, raw)
  return new UpstreamError({
    kind: c.kind,
    httpStatus,
    code: c.code,
    message: `${path} 失败（${c.kind}）：${c.msg || raw.slice(0, 200)}${raw === '' ? '' : ` | ${raw.slice(0, 300)}`}`,
    detail: raw.slice(0, 600),
  })
}

function errorMessageOf(obj: Record<string, unknown>): { message: string; code: string } {
  const error = obj.error
  if (error !== null && typeof error === 'object') {
    const e = error as Record<string, unknown>
    const message = typeof e.message === 'string' ? e.message : typeof e.msg === 'string' ? e.msg : ''
    return { message, code: e.code === undefined ? '' : String(e.code) }
  }
  const message = typeof obj.message === 'string' ? obj.message : typeof obj.msg === 'string' ? obj.msg : ''
  return { message, code: obj.code === undefined ? '' : String(obj.code) }
}

function isRequestCode(code: string, message: string): boolean {
  if (code === '10000' || code === '15053') return true
  const lower = message.toLowerCase()
  return (
    lower.includes('invalid voice')
    || lower.includes('voice not found')
    || lower.includes('asr recognition failed')
    || lower.includes('unsupported audio')
  )
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function pcmChunkOf(obj: Record<string, unknown>): string | undefined {
  const audio = obj.audio
  if (audio !== null && typeof audio === 'object') {
    const data = (audio as Record<string, unknown>).data
    if (typeof data === 'string' && data !== '') return data
  }
  const data = obj.data
  if (data !== null && typeof data === 'object') {
    const inner = (data as Record<string, unknown>).audio
    if (typeof inner === 'string' && inner !== '') return inner
  }
  if (typeof audio === 'string' && audio !== '') return audio
  return undefined
}

/** 把 16 bit 小端 PCM 包成 RIFF/WAVE。 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate = TTS_SAMPLE_RATE,
  channels = TTS_CHANNELS,
  sampleWidth = TTS_SAMPLE_WIDTH,
): Uint8Array {
  const blockAlign = channels * sampleWidth
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, sampleWidth * 8, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

/** 逐行解析上游 SSE，累计 base64 PCM；任何 error 帧或未见 `speech.audio.done` 的截断流立刻抛出。 */
async function collectTtsPcm(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    throw new UpstreamError({ kind: 'unknown', httpStatus: 502, message: 'TTS 上游没有响应体', detail: '' })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let total = 0
  let sawDone = false
  let buffer = ''

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(':')) return
    const data = line.startsWith('data:') ? line.slice(5).trim() : line
    if (data === '' || data === '[DONE]') return
    let obj: unknown
    try {
      obj = JSON.parse(data)
    } catch {
      return
    }
    if (obj === null || typeof obj !== 'object') return
    const record = obj as Record<string, unknown>
    if (record.type === 'error' || record.error !== undefined) {
      const { message, code } = errorMessageOf(record)
      throw isRequestCode(code, message)
        ? new AudioRequestError(400, code || 'tts_bad_request', message || 'TTS 请求参数不合法')
        : new UpstreamError({
            kind: 'unknown',
            httpStatus: 502,
            message: message || 'TTS 上游返回错误',
            detail: code,
          })
    }
    if (record.type === 'speech.audio.done') {
      sawDone = true
    }
    if (record.type !== 'speech.audio.delta' && record.type !== 'speech.audio.done') return
    const chunk = pcmChunkOf(record)
    if (chunk === undefined) return
    const bytes = decodeBase64(chunk)
    total += bytes.byteLength
    if (total > TTS_MAX_PCM_BYTES) {
      throw new UpstreamError({
        kind: 'unknown',
        httpStatus: 502,
        message: 'TTS 音频超过 32 MiB 上限',
        detail: '',
      })
    }
    chunks.push(bytes)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        consumeLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      for (const rem of buffer.split('\n')) {
        consumeLine(rem)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock?.()
  }
  // APISIX 分块流偶发在 delta 中途断开：未收到 speech.audio.done 说明音频残缺，
  // 必须抛可重试的 network/502 交由 media-router 换号重试，绝不能把半段音频包成 200 返回。
  if (!sawDone) {
    throw new UpstreamError({
      kind: 'network',
      httpStatus: 502,
      message: total > 0
        ? `TTS 上游音频流被提前截断（已收 ${total} 字节，缺少 speech.audio.done）`
        : 'TTS 上游流未正常完成（缺少 speech.audio.done）',
      detail: 'truncated_tts_stream',
    })
  }
  if (total === 0) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: 'TTS 上游没有返回音频数据',
      detail: '',
    })
  }
  const pcm = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.byteLength
  }
  return pcm
}

export async function speechToPcm(
  ctx: AudioContext,
  _env: Env,
  input: { text: string; voice: string; signal?: AbortSignal },
): Promise<{ pcm: Uint8Array }> {
  const path = '/v2/audio/speech'
  const body = {
    model: TTS_DEFAULT_MODEL,
    stream: true,
    speech: {
      input: input.text,
      voice: input.voice,
      response_format: 'pcm',
      sample_rate: TTS_SAMPLE_RATE,
    },
  }
  const signal = input.signal === undefined
    ? AbortSignal.timeout(120_000)
    : AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  let response: Response
  try {
    response = await fetch(`${audioBase(ctx.realm ?? '')}${path}`, {
      method: 'POST',
      headers: audioHeaders(ctx, 'text/event-stream'),
      body: JSON.stringify(body),
      signal,
      redirect: 'manual',
    })
  } catch (error) {
    throw new UpstreamError({
      kind: 'network',
      httpStatus: 0,
      message: `TTS 上游请求失败：${error instanceof Error ? error.message : String(error)}`,
      detail: '',
    })
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw upstreamErrorOf(path, response.status, raw)
  }
  return { pcm: await collectTtsPcm(response) }
}

/** 解析 multipart，提取 `file` / `audio` 音频字段及可选 `response_format` / `model` / `realm` 文本字段。 */
export function parseAudioMultipart(
  body: Uint8Array,
  contentType: string,
): {
  data: Uint8Array
  filename: string
  mime: string
  responseFormat: AsrResponseFormat
  model?: string
  realm?: string
} {
  const marker = 'boundary='
  const pos = contentType.toLowerCase().indexOf(marker)
  if (pos < 0) throw new AudioRequestError(400, 'invalid_multipart', 'multipart boundary is missing')
  const boundary = (contentType.slice(pos + marker.length).split(';')[0] ?? '').trim().replace(/^"|"$/g, '')
  if (boundary === '') throw new AudioRequestError(400, 'invalid_multipart', 'multipart boundary is empty')

  const separator = new TextEncoder().encode(`--${boundary}`)
  const crlfcrlf = new TextEncoder().encode('\r\n\r\n')
  const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
    outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (haystack[i + j] !== needle[j]) continue outer
      }
      return i
    }
    return -1
  }

  let audioPart: { data: Uint8Array; filename: string; mime: string } | undefined
  let rawResponseFormat = ''
  let model: string | undefined
  let realm: string | undefined

  let cursor = 0
  for (;;) {
    const start = indexOf(body, separator, cursor)
    if (start < 0) break
    let partStart = start + separator.length
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2
    else if (body[partStart] === 10) partStart += 1
    if (body[partStart] === 45 && body[partStart + 1] === 45) break
    const next = indexOf(body, separator, partStart)
    if (next < 0) break
    let partEnd = next
    if (body[partEnd - 2] === 13 && body[partEnd - 1] === 10) partEnd -= 2
    else if (body[partEnd - 1] === 10) partEnd -= 1
    cursor = next

    const headEnd = indexOf(body, crlfcrlf, partStart)
    if (headEnd < 0 || headEnd > partEnd) continue
    const head = new TextDecoder().decode(body.subarray(partStart, headEnd))
    let field = ''
    let filename = 'audio.wav'
    let mime = 'application/octet-stream'
    for (const line of head.split('\r\n')) {
      const lower = line.toLowerCase()
      if (lower.startsWith('content-disposition:')) {
        for (const piece of line.split(';')) {
          const trimmed = piece.trim()
          if (trimmed.toLowerCase().startsWith('name=')) field = trimmed.slice(5).trim().replace(/^"|"$/g, '')
          if (trimmed.toLowerCase().startsWith('filename=')) {
            filename = trimmed.slice(9).trim().replace(/^"|"$/g, '') || filename
          }
        }
      } else if (lower.startsWith('content-type:')) {
        mime = line.slice(13).trim() || mime
      }
    }

    const partData = body.subarray(headEnd + crlfcrlf.length, partEnd)
    if ((ASR_FIELD_NAMES as readonly string[]).includes(field)) {
      if (audioPart === undefined) {
        if (partData.byteLength === 0) {
          throw new AudioRequestError(400, 'empty_audio', '音频文件为空')
        }
        audioPart = { data: partData, filename, mime }
      }
      continue
    }

    if (field === 'response_format') {
      rawResponseFormat = new TextDecoder().decode(partData).trim()
    } else if (field === 'model') {
      const m = new TextDecoder().decode(partData).trim()
      if (m !== '') model = m
    } else if (field === 'realm') {
      const r = new TextDecoder().decode(partData).trim()
      if (r !== '') realm = r
    }
  }

  if (audioPart === undefined) {
    throw new AudioRequestError(400, 'missing_audio', 'multipart 里必须包含 file 或 audio 字段')
  }

  const normalizedFormat = rawResponseFormat.toLowerCase() || 'json'
  if (normalizedFormat !== 'json' && normalizedFormat !== 'text') {
    throw new AudioRequestError(
      400,
      'unsupported_response_format',
      `response_format "${rawResponseFormat}" 不支持：上游不提供词级时间戳（不支持 srt / vtt / verbose_json），请改用 json 或 text`,
    )
  }

  return {
    ...audioPart,
    responseFormat: normalizedFormat,
    ...(model === undefined ? {} : { model }),
    ...(realm === undefined ? {} : { realm }),
  }
}

function buildAsrMultipart(audio: Uint8Array, filename: string, mime: string): { body: Uint8Array; contentType: string } {
  const boundary = `----wb-audio-${audio.byteLength.toString(36)}`
  const safeName = filename.replace(/"/g, '_').replace(/[\r\n]/g, '_') || 'audio.wav'
  const safeMime = mime.replace(/[\r\n]/g, '') || 'application/octet-stream'
  const head = new TextEncoder().encode(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="audio"; filename="${safeName}"\r\n`
      + `Content-Type: ${safeMime}\r\n\r\n`,
  )
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.byteLength + audio.byteLength + tail.byteLength)
  body.set(head, 0)
  body.set(audio, head.byteLength)
  body.set(tail, head.byteLength + audio.byteLength)
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

export async function transcribeAudio(
  ctx: AudioContext,
  _env: Env,
  input: { audio: Uint8Array; filename: string; mime: string; signal?: AbortSignal },
): Promise<string> {
  const path = '/agenttool/v1/asr'
  const multipart = buildAsrMultipart(input.audio, input.filename, input.mime)
  const headers = audioHeaders(ctx, 'application/json')
  headers['Content-Type'] = multipart.contentType
  const signal = input.signal === undefined
    ? AbortSignal.timeout(120_000)
    : AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  let response: Response
  try {
    response = await fetch(`${audioBase(ctx.realm ?? '')}${path}`, {
      method: 'POST',
      headers,
      body: multipart.body,
      signal,
      redirect: 'manual',
    })
  } catch (error) {
    throw new UpstreamError({
      kind: 'network',
      httpStatus: 0,
      message: `ASR 上游请求失败：${error instanceof Error ? error.message : String(error)}`,
      detail: '',
    })
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) throw upstreamErrorOf(path, response.status, raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: 'ASR 上游返回了非 JSON 响应',
      detail: raw.slice(0, 600),
    })
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: 'ASR 上游返回了非对象响应',
      detail: raw.slice(0, 600),
    })
  }
  const record = parsed as Record<string, unknown>
  const inner = record.data !== null && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : record
  const code = record.code === undefined ? inner.code : record.code
  const text = typeof inner.text === 'string' ? inner.text : typeof record.text === 'string' ? record.text : undefined
  if ((code === undefined || code === 0 || code === '0') && text !== undefined) {
    return text
  }
  const { message } = errorMessageOf(record)
  const codeText = code === undefined ? '' : String(code)
  const status = codeText === '15052' ? 413 : isRequestCode(codeText, message) ? 400 : 502
  if (status === 502) {
    throw new UpstreamError({
      kind: 'unknown',
      httpStatus: 502,
      message: message || 'ASR 识别失败',
      detail: raw.slice(0, 600),
    })
  }
  throw new AudioRequestError(status, codeText || 'asr_error', message || 'ASR 识别失败')
}
