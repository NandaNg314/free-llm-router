import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AudioRequestError,
  pcmToWav,
  parseAudioMultipart,
  speechToPcm,
  transcribeAudio,
} from '../src/upstream/audio.ts'

const enc = new TextEncoder()

function multipartBody(parts: Array<{ field: string; filename?: string; mime?: string; data: Uint8Array }>): {
  body: Uint8Array
  contentType: string
} {
  const boundary = '----wb-test-boundary'
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    const disposition = part.filename === undefined
      ? `Content-Disposition: form-data; name="${part.field}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\n`
        + `Content-Type: ${part.mime ?? 'application/octet-stream'}\r\n\r\n`
    chunks.push(enc.encode(`--${boundary}\r\n${disposition}`))
    chunks.push(part.data)
    chunks.push(enc.encode('\r\n'))
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`))
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

test('pcmToWav：44 字节 RIFF 头 + 原始 PCM 数据', () => {
  const pcm = new Uint8Array([1, 2, 3, 4])
  const wav = pcmToWav(pcm)
  assert.equal(wav.byteLength, 48)
  const text = new TextDecoder().decode(wav.subarray(0, 16))
  assert.equal(text.slice(0, 4), 'RIFF')
  assert.equal(text.slice(8, 12), 'WAVE')
  assert.equal(text.slice(12, 16), 'fmt ')
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint32(4, true), 36 + 4)
  assert.equal(view.getUint16(22, true), 1, '单声道')
  assert.equal(view.getUint32(24, true), 24_000)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 4)
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4])
})

test('parseAudioMultipart：读取 audio 字段，保留二进制首尾字节', () => {
  const data = new Uint8Array([0x0d, 0x0a, 0x00, 0xff, 0x0d, 0x0a])
  const { body, contentType } = multipartBody([{ field: 'audio', filename: 'a.wav', mime: 'audio/wav', data }])
  const part = parseAudioMultipart(body, contentType)
  assert.equal(part.filename, 'a.wav')
  assert.equal(part.mime, 'audio/wav')
  assert.deepEqual([...part.data], [...data])
})

test('parseAudioMultipart：file 字段同样接受；缺字段 / 缺 boundary 报 400', () => {
  const { body, contentType } = multipartBody([{ field: 'file', filename: 'a.mp3', mime: 'audio/mpeg', data: new Uint8Array([1]) }])
  assert.deepEqual([...parseAudioMultipart(body, contentType).data], [1])

  const other = multipartBody([{ field: 'image', filename: 'a.png', data: new Uint8Array([1]) }])
  assert.throws(
    () => parseAudioMultipart(other.body, other.contentType),
    (error: unknown) => error instanceof AudioRequestError && error.httpStatus === 400,
  )
  assert.throws(
    () => parseAudioMultipart(body, 'multipart/form-data'),
    (error: unknown) => error instanceof AudioRequestError,
  )
})

type FetchLike = typeof fetch

async function withFetch(impl: FetchLike, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('speechToPcm：拼接 SSE 里的 base64 PCM 分片', async () => {
  const frame = (text: string): string => `data: ${JSON.stringify(text)}\n\n`
  const sse = frame({ type: 'speech.audio.delta', audio: { data: btoa('ab') } })
    + frame({ type: 'speech.audio.delta', audio: { data: btoa('cd') } })
    + 'data: [DONE]\n\n'
  await withFetch(
    async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const { pcm } = await speechToPcm({ uid: 'u', accessToken: 't', realm: 'cn' }, {} as never, {
        text: '你好',
        voice: 'v',
      })
      assert.equal(new TextDecoder().decode(pcm), 'abcd')
    },
  )
})

test('speechToPcm：未知音色是请求错误（400），不是账号故障', async () => {
  const sse = `data: ${JSON.stringify({ type: 'error', error: { code: 15053, message: 'invalid voice' } })}\n\n`
  await withFetch(
    async () => new Response(sse, { status: 200 }),
    async () => {
      await assert.rejects(
        () => speechToPcm({ uid: 'u', accessToken: 't', realm: 'cn' }, {} as never, { text: 'x', voice: 'bad' }),
        (error: unknown) => error instanceof AudioRequestError && error.httpStatus === 400,
      )
    },
  )
})

test('transcribeAudio：成功返回文本；15052 映射为 413', async () => {
  await withFetch(
    async () => Response.json({ code: 0, text: '识别结果' }),
    async () => {
      const text = await transcribeAudio(
        { uid: 'u', accessToken: 't', realm: 'cn' },
        {} as never,
        { audio: new Uint8Array([1]), filename: 'a.wav', mime: 'audio/wav' },
      )
      assert.equal(text, '识别结果')
    },
  )

  await withFetch(
    async () => Response.json({ code: 15052, msg: 'audio too large' }),
    async () => {
      await assert.rejects(
        () => transcribeAudio(
          { uid: 'u', accessToken: 't', realm: 'cn' },
          {} as never,
          { audio: new Uint8Array([1]), filename: 'a.wav', mime: 'audio/wav' },
        ),
        (error: unknown) => error instanceof AudioRequestError && error.httpStatus === 413,
      )
    },
  )
})
