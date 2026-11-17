/**
 * `/v1/messages` 与 `/v1/messages/count_tokens`（原生 Anthropic Messages API）单测。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  MessagesError,
  estimateMessagesTokens,
  handleMessagesCountTokens,
  messagesToChatBody,
  toAnthropicMessage,
  toAnthropicSse,
  toAnthropicStopReason,
  toAnthropicUsage,
} from '../src/gateway/messages.ts'

function streamFromStrings(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]!))
    },
  })
}

async function collectSseEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<{ events: Array<{ event: string; data: Record<string, unknown> }>; comments: string[] }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }
  raw += decoder.decode()

  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const comments: string[] = []
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith(':')) {
      comments.push(trimmed)
      continue
    }
    let eventName = ''
    let dataLine = ''
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLine = line.slice(5).trim()
    }
    if (dataLine !== '') {
      events.push({ event: eventName, data: JSON.parse(dataLine) as Record<string, unknown> })
    }
  }
  return { events, comments }
}

test('Anthropic 入站：system 支持字符串与 text block 数组两种形态', () => {
  const a = messagesToChatBody(
    {
      system: '你是代码助手',
      messages: [{ role: 'user', content: 'hi' }],
    },
    'claude-sonnet-4-5',
  )
  const msgsA = a.messages as Array<Record<string, unknown>>
  assert.deepEqual(msgsA[0], { role: 'system', content: '你是代码助手' })

  const b = messagesToChatBody(
    {
      system: [
        { type: 'text', text: '第一段系统指令', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '第二段系统指令' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
    'claude-sonnet-4-5',
  )
  const msgsB = b.messages as Array<Record<string, unknown>>
  assert.deepEqual(msgsB[0], { role: 'system', content: '第一段系统指令\n第二段系统指令' })
})

test('Anthropic 入站：image(base64/url)、thinking、tool_use、tool_result 全量映射', () => {
  const chat = messagesToChatBody(
    {
      max_tokens: 8192,
      stop_sequences: ['</stop>', 'EOF'],
      temperature: 0.2,
      top_p: 0.9,
      metadata: { user_id: 'user_claude_001' },
      thinking: { type: 'enabled', budget_tokens: 16000 },
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        },
      },
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看一下这张图' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/pic.jpg' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先读取配置文件确认路径', signature: 'sig_ignored' },
            { type: 'redacted_thinking', data: 'encrypted_blob' },
            { type: 'text', text: '我来读取文件' },
            { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'export const x = 1' },
          ],
        },
      ],
    },
    'deepseek-v4.1-flash',
  )

  assert.equal(chat.max_tokens, 8192)
  assert.deepEqual(chat.stop, ['</stop>', 'EOF'])
  assert.equal(chat.temperature, 0.2)
  assert.equal(chat.top_p, 0.9)
  assert.equal(chat.user, 'user_claude_001')
  assert.deepEqual(chat.thinking, { type: 'enabled' })
  assert.equal(chat.reasoning_effort, 'high')
  assert.equal(chat.tool_choice, 'required')
  assert.equal(chat.parallel_tool_calls, false)
  assert.deepEqual(chat.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      strict: true,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    },
  })

  const tools = chat.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 1, '无 input_schema 的服务端工具不应混入 function tools')
  assert.deepEqual(tools[0], {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  })

  const msgs = chat.messages as Array<Record<string, unknown>>
  // 第 0 条是 skippedServerTools 提示 system
  assert.equal(msgs[0]!.role, 'system')
  assert.ok(String(msgs[0]!.content).includes('web_search'))

  // 用户带图消息
  assert.equal(msgs[1]!.role, 'user')
  assert.deepEqual(msgs[1]!.content, [
    { type: 'text', text: '看一下这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    { type: 'image_url', image_url: { url: 'https://example.com/pic.jpg' } },
  ])

  // assistant 保留 reasoning_content + tool_calls
  assert.deepEqual(msgs[2], {
    role: 'assistant',
    content: '我来读取文件',
    reasoning_content: '先读取配置文件确认路径',
    tool_calls: [
      {
        id: 'toolu_01',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
      },
    ],
  })

  // tool_result 转为 role: 'tool'
  assert.deepEqual(msgs[3], {
    role: 'tool',
    tool_call_id: 'toolu_01',
    content: 'export const x = 1',
  })
})

test('🔴 tool_result 内嵌截图：保持并行 tool 消息连续不触发 11148，图片后置为 user 视觉消息', () => {
  const chat = messagesToChatBody(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'screenshot', input: { page: 1 } },
            { type: 'tool_use', id: 'toolu_2', name: 'get_dom', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: '截图成功' },
                { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              is_error: true,
              content: 'selector timeout',
            },
          ],
        },
      ],
    },
    'm',
  )

  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['assistant', 'tool', 'tool', 'user'],
    '所有 tool 结果必须紧跟 assistant，视觉附件消息排在整批 tool 之后',
  )
  assert.equal(msgs[1]!.content, '截图成功')
  assert.ok(!String(msgs[1]!.content).includes('UklGRg=='), 'base64 不得被塞进 tool 文本')
  assert.equal(msgs[2]!.content, 'error: selector timeout')
  const imgContent = msgs[3]!.content as Array<Record<string, unknown>>
  assert.equal(imgContent.length, 2)
  assert.deepEqual(imgContent[1], {
    type: 'image_url',
    image_url: { url: 'data:image/webp;base64,UklGRg==' },
  })
})

test('Anthropic tool_choice 全分支映射与 thinking 预算分档', () => {
  const tTool = messagesToChatBody(
    {
      tool_choice: { type: 'tool', name: 'bash' },
      thinking: { type: 'enabled', budget_tokens: 32000 },
      messages: [{ role: 'user', content: 'run' }],
    },
    'm',
  )
  assert.deepEqual(tTool.tool_choice, { type: 'function', function: { name: 'bash' } })
  assert.equal(tTool.reasoning_effort, 'xhigh')

  const tOff = messagesToChatBody(
    {
      tool_choice: { type: 'none' },
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'run' }],
    },
    'm',
  )
  assert.equal(tOff.tool_choice, 'none')
  assert.equal(tOff.reasoning_effort, 'none')
  assert.deepEqual(tOff.thinking, { type: 'disabled' })

  assert.throws(
    () =>
      messagesToChatBody(
        {
          tool_choice: { type: 'tool' },
          messages: [{ role: 'user', content: 'run' }],
        },
        'm',
      ),
    MessagesError,
  )
})

test('🔴 Anthropic 出站非流式：thinking + text + tool_use 与 Claude 缓存扣除口径', () => {
  const msg = toAnthropicMessage(
    'claude-sonnet-4-5',
    {
      id: 'chatcmpl_123',
      object: 'chat.completion',
      created: 1,
      model: 'claude-sonnet-4-5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            reasoning_content: '先看目录结构',
            content: '我将列出当前目录。',
            tool_calls: [
              {
                id: 'toolu_abc',
                type: 'function',
                function: { name: 'ls', arguments: '{"dir":"."}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 750 },
      },
    },
    'msg_fallback',
  )

  assert.equal(msg.id, 'msg_chatcmpl_123')
  assert.equal(msg.type, 'message')
  assert.equal(msg.role, 'assistant')
  assert.equal(msg.stop_reason, 'tool_use')
  assert.deepEqual(msg.content, [
    { type: 'thinking', thinking: '先看目录结构' },
    { type: 'text', text: '我将列出当前目录。' },
    { type: 'tool_use', id: 'toolu_abc', name: 'ls', input: { dir: '.' } },
  ])
  // Claude 口径：input_tokens 不含缓存命中（1000 - 750 = 250），命中量单列 cache_read_input_tokens
  assert.deepEqual(msg.usage, {
    input_tokens: 250,
    output_tokens: 80,
    cache_read_input_tokens: 750,
  })
  assert.equal(toAnthropicStopReason('length'), 'max_tokens')
  assert.equal(toAnthropicStopReason('stop_sequence'), 'stop_sequence')
  assert.equal(toAnthropicStopReason('stop'), 'end_turn')
  assert.deepEqual(toAnthropicUsage(undefined), { input_tokens: 0, output_tokens: 0 })
})

test('🔴 Anthropic 出站流式 SSE：thinking + text + 多 tool_use 混合事件闭合无漏帧且透传 keepalive', async () => {
  const upstream = streamFromStrings([
    ': keepalive\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考第1步"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"、思考第2步"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"开始执行："}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_1","type":"function","function":{"name":"read","arguments":""}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file\\":\\"a.ts\\"}"}}]}}]}\n\n',
    // 测试先到参数分片、后到函数名的乱序分块保护
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"toolu_2","function":{"arguments":"{\\"x\\":"}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"name":"write","arguments":"1}"}}]}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":500,"completion_tokens":45,"prompt_cache_hit_tokens":300}}\n\n',
    'data: [DONE]\n\n',
  ])

  const { events, comments } = await collectSseEvents(toAnthropicSse(upstream, 'claude-sonnet-4-5', 'msg_init'))
  assert.deepEqual(comments, [': keepalive'])

  const types = events.map((e) => e.event)
  assert.deepEqual(types, [
    'message_start',
    'content_block_start', // block 0: thinking
    'content_block_delta',
    'content_block_delta',
    'content_block_stop', // block 0 closed before text
    'content_block_start', // block 1: text
    'content_block_delta',
    'content_block_stop', // block 1 closed before tool 0
    'content_block_start', // block 2: tool_use #0
    'content_block_delta',
    'content_block_stop', // block 2 closed before tool 1
    'content_block_start', // block 3: tool_use #1 (opened once name arrived)
    'content_block_delta', // pendingArgs + current args
    'content_block_stop', // block 3 closed on finalize
    'message_delta',
    'message_stop',
  ])

  // 校验所有开启过的 index 全部一一闭合
  const startedIndices = events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => e.data.index)
  const stoppedIndices = events
    .filter((e) => e.event === 'content_block_stop')
    .map((e) => e.data.index)
  assert.deepEqual(startedIndices, [0, 1, 2, 3])
  assert.deepEqual(stoppedIndices, [0, 1, 2, 3])

  const msgDelta = events.find((e) => e.event === 'message_delta')!
  assert.deepEqual(msgDelta.data.delta, { stop_reason: 'tool_use', stop_sequence: null })
  assert.deepEqual(msgDelta.data.usage, {
    input_tokens: 200,
    output_tokens: 45,
    cache_read_input_tokens: 300,
  })
})

test('🔴 Anthropic 出站流式 SSE：上游错误帧转换为 Anthropic error 事件且不伪造 message_stop', async () => {
  const upstream = streamFromStrings([
    'data: {"error":{"message":"rate limit exceeded","type":"upstream_error"}}\n\n',
    'data: [DONE]\n\n',
  ])
  const { events } = await collectSseEvents(toAnthropicSse(upstream, 'claude-sonnet-4-5'))
  assert.equal(events.length, 1)
  assert.equal(events[0]!.event, 'error')
  assert.deepEqual(events[0]!.data, {
    type: 'error',
    error: { type: 'api_error', message: 'rate limit exceeded' },
  })
})

test('count_tokens：CJK 按字估算，巨幅截图 base64 按固定 1600 token 计算不爆表', async () => {
  const hugeBase64 = 'A'.repeat(200_000)
  const req = new Request('http://localhost/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      system: '你好世界',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: hugeBase64 } },
          ],
        },
      ],
    }),
  })
  const { response } = await handleMessagesCountTokens(req)
  assert.equal(response.status, 200)
  const data = (await response.json()) as { input_tokens: number }
  // 若误把 20 万字符 base64 按字符算会高达 50,000+；正确按固定 1600 算应在 1600~1700 区间
  assert.ok(data.input_tokens >= 1600 && data.input_tokens < 1700, `actual=${data.input_tokens}`)
  assert.equal(estimateMessagesTokens('data:image/png;base64,' + hugeBase64), 1600)
})
