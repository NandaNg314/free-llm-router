/**
 * `/v1/responses`（OpenAI Responses API）单测。
 *
 * ⚠️ 只测**纯转换与流转换**（不碰外部网络）—— 端到端由部署后实测覆盖。
 * 原因：这里全是「形状转换」，而形状写错的症状是**静默**的
 *（模型不调工具、上下文丢失、客户端算错 token），必须用单测钉死。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ResponsesError,
  decodeCompactionSummary,
  toChatBody,
  toResponsesObject,
  toResponsesSse,
  unwrapCustomToolInput,
  usageOf,
} from '../src/gateway/responses.ts'

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

async function collectResponsesSse(
  stream: ReadableStream<Uint8Array>,
): Promise<{ events: Array<Record<string, unknown>>; comments: string[] }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }
  raw += decoder.decode()

  const events: Array<Record<string, unknown>> = []
  const comments: string[] = []
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith(':')) {
      comments.push(trimmed)
      continue
    }
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('data:')) {
        events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
      }
    }
  }
  return { events, comments }
}

test('🔴 Responses 的 `tools` 是**扁平**的，必须转成 Chat 的嵌套形状', () => {
  const chat = toChatBody(
    {
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    'm',
  )
  const tools = chat.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.type, 'function')
  const fn = tools[0]!.function as Record<string, unknown>
  assert.equal(fn.name, 'get_weather', '⚠️ 必须嵌到 function 下')
  assert.equal(fn.description, '查天气')
  assert.deepEqual(fn.parameters, { type: 'object', properties: {} })
  assert.equal(tools[0]!.name, undefined, '顶层不该有 name')
})

test('⚠️ 托管服务端工具（web_search / file_search）必须丢弃（上游不支持，发过去会整个 400）', () => {
  const chat = toChatBody(
    {
      input: 'hi',
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'keep_me', parameters: {} },
        { type: 'file_search' },
      ],
    },
    'm',
  )
  const tools = chat.tools as Array<Record<string, unknown>>
  assert.equal(tools.length, 1, '只保留可转换为 function 的客户端工具')
  assert.equal((tools[0]!.function as Record<string, unknown>).name, 'keep_me')
})

test('🔴 `instructions` 必须转成首条 system（国际版硬要求）', () => {
  const chat = toChatBody({ instructions: '你是助手', input: '你好' }, 'm')
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.role, 'system')
  assert.equal(msgs[0]!.content, '你是助手')
  assert.equal(msgs[1]!.role, 'user')
})

test('⚠️ `input` 字符串与数组两种形态都要支持', () => {
  const a = toChatBody({ input: 'hi' }, 'm')
  assert.deepEqual((a.messages as unknown[])[0], { role: 'user', content: 'hi' })

  const b = toChatBody(
    {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    },
    'm',
  )
  const msgs = b.messages as Array<Record<string, unknown>>
  assert.deepEqual(
    msgs[0],
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    '⚠️ input_text 必须转成 Chat 的 text',
  )
})

test('⚠️ `developer` 角色必须转成 system（保住提示词顺序）', () => {
  const chat = toChatBody(
    {
      input: [{ type: 'message', role: 'developer', content: '系统提示' }, { role: 'user', content: 'hi' }],
    },
    'm',
  )
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs[0]!.role, 'system', '⚠️ developer 必须转成 system')
  assert.equal(msgs[0]!.content, '系统提示')
})

test('⚠️ 工具调用的历史（function_call / function_call_output）必须能往返', () => {
  const chat = toChatBody(
    {
      input: [
        { role: 'user', content: '天气' },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"c":"bj"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '晴' },
      ],
    },
    'm',
  )
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 3)
  const asst = msgs[1]!
  assert.equal(asst.role, 'assistant')
  const calls = asst.tool_calls as Array<Record<string, unknown>>
  assert.equal(calls[0]!.id, 'call_1')
  assert.equal((calls[0]!.function as Record<string, unknown>).name, 'get_weather')
  const tool = msgs[2]!
  assert.equal(tool.role, 'tool')
  assert.equal(tool.tool_call_id, 'call_1', '⚠️ tool 消息靠 tool_call_id 配对，写错就整条会话 400')
  assert.equal(tool.content, '晴')
})

test('⚠️ `function_call` 缺 call_id 时回落到 `id`', () => {
  const chat = toChatBody(
    {
      input: [{ type: 'function_call', id: 'fc_abc', name: 'f', arguments: '{}' }],
    },
    'm',
  )
  const calls = (chat.messages as Array<Record<string, unknown>>)[0]!.tool_calls as Array<
    Record<string, unknown>
  >
  assert.equal(calls[0]!.id, 'fc_abc')
})

test('⚠️ 空 summary 或紧跟 user 边界的过期 `reasoning` 不产生孤立消息也不跨轮串味', () => {
  const chat = toChatBody(
    {
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '过期思考' }] },
        { role: 'user', content: 'hi' },
        { type: 'message', role: 'assistant', content: 'hello' },
      ],
    },
    'm',
  )
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.role, 'user')
  assert.equal(msgs[1]!.role, 'assistant')
  assert.equal(msgs[1]!.reasoning_content, undefined, '跨 user 边界的过期思考必须清空')
})

test('🔴 多轮思维链保真回放：连续段拼接、跨元数据项归组、工具批次挂载、Chat 内联保留、末尾归位', () => {
  const chat = toChatBody(
    {
      input: [
        { role: 'user', content: '开始任务' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '第一段推理' }] },
        // 元数据项（local_shell_call / additional_tools）跳过不造空消息，也不切断思考组
        { type: 'additional_tools', tools: [] },
        { type: 'local_shell_call', call_id: 'meta_1' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '第二段推理' }] },
        { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"p":"a.ts"}' },
        { type: 'function_call', call_id: 'c2', name: 'read_file', arguments: '{"p":"b.ts"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file_a' },
        { type: 'function_call_output', call_id: 'c2', output: 'file_b' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '总结推理' }] },
        { type: 'message', role: 'assistant', content: '两份文件已读完' },
        // 末尾补记 reasoning 归入前一条 assistant
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '尾部补充推理' }] },
      ],
    },
    'kimi-k2.5',
  )

  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant', 'tool', 'tool', 'assistant'],
  )
  assert.equal(msgs[1]!.reasoning_content, '第一段推理\n第二段推理')
  assert.equal((msgs[1]!.tool_calls as unknown[]).length, 2, '并行 function_call 应聚合成同批 tool_calls')
  assert.equal(msgs[4]!.content, '两份文件已读完')
  assert.equal(msgs[4]!.reasoning_content, '总结推理\n尾部补充推理')

  // Chat 形态混排回放：保留内联 reasoning_content、tool_calls 与 role:'tool'
  const chatShaped = toChatBody(
    {
      input: [
        { role: 'user', content: 'edit' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '内联思考',
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc_1', content: 'done' },
      ],
    },
    'm',
  )
  const csMsgs = chatShaped.messages as Array<Record<string, unknown>>
  assert.equal(csMsgs.length, 3)
  assert.equal(csMsgs[1]!.reasoning_content, '内联思考')
  assert.equal((csMsgs[1]!.tool_calls as unknown[]).length, 1)
  assert.equal(csMsgs[2]!.role, 'tool')
})

test('🔴 compaction 上下文压缩项解码为 system 摘要（含 UTF-8 中文 Base64、纯文本兜底与空白跳过）', () => {
  const payload = JSON.stringify({ v: 1, summary: '前情提要：已完成网关三个核心模块改造' })
  const bytes = new TextEncoder().encode(payload)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = btoa(bin)

  assert.equal(decodeCompactionSummary(b64), '前情提要：已完成网关三个核心模块改造')
  assert.equal(decodeCompactionSummary('纯文本交接摘要'), '纯文本交接摘要')
  assert.equal(decodeCompactionSummary('   '), '')

  const chat = toChatBody(
    {
      input: [
        { type: 'compaction', encrypted_content: b64 },
        { type: 'compaction_summary', encrypted_content: '   ' },
        { role: 'user', content: '继续下一步' },
      ],
    },
    'm',
  )
  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.equal(msgs.length, 2, '空 compaction 不造消息，非空 compaction 解码为 system')
  assert.equal(msgs[0]!.role, 'system')
  assert.ok(String(msgs[0]!.content).includes('前情提要：已完成网关三个核心模块改造'))
})

test('🔴 工具输出图片（function_call_output / custom_tool_call_output）：并行结果不拆散，图像附为后续 user 消息', () => {
  const chat = toChatBody(
    {
      input: [
        { role: 'user', content: '查看两张截图' },
        { type: 'function_call', call_id: 'call_img_1', name: 'view_image', arguments: '{}' },
        { type: 'custom_tool_call', call_id: 'call_img_2', name: 'snap', input: 'screen' },
        {
          type: 'function_call_output',
          call_id: 'call_img_1',
          output: [
            { type: 'input_text', text: '截图一元数据' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'high' },
          ],
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_img_2',
          output: [{ type: 'input_image', image_url: 'data:image/webp;base64,BBB' }],
        },
        { role: 'user', content: '对比差异' },
      ],
    },
    'm',
  )

  const msgs = chat.messages as Array<Record<string, unknown>>
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant', 'tool', 'tool', 'user', 'user'],
    '两条并行 tool 消息必须紧跟 assistant，合成视觉 user 消息排在整批 tool 之后',
  )
  assert.equal(msgs[2]!.content, '截图一元数据')
  assert.ok(!String(msgs[2]!.content).includes('AAA'))
  assert.equal(msgs[3]!.tool_call_id, 'call_img_2')

  const imgParts = msgs[4]!.content as Array<Record<string, unknown>>
  assert.deepEqual(imgParts[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAA', detail: 'high' },
  })
  assert.deepEqual(imgParts[3], {
    type: 'image_url',
    image_url: { url: 'data:image/webp;base64,BBB' },
  })
})

test('🔴 Custom 工具（apply_patch）与 Namespaced 工具（含 >64 字符超长命名空间）流式与非流式完整往返', async () => {
  const longNs = 'mcp_enterprise_workspace_filesystem_adapter_v2_extra_long_namespace'
  const patchText = '*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch'
  const grammar = 'start: "*** Begin Patch" /[\\s\\S]*/ "*** End Patch"'

  const reqBody = {
    input: '请打补丁并读文件',
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply unified patch.',
        format: { type: 'grammar', syntax: 'lark', definition: grammar },
      },
      {
        type: 'namespace',
        name: 'mcp_first',
        description: 'First MCP',
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
      },
      {
        type: 'namespace',
        name: longNs,
        description: 'Long MCP',
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
      },
      { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } },
    ],
    tool_choice: { type: 'function', namespace: longNs, name: 'read' },
  }

  const chat = toChatBody(reqBody, 'gpt-5')
  const chatTools = chat.tools as Array<{ type: string; function: Record<string, unknown> }>
  assert.equal(chatTools.length, 4)

  // 校验所有出站函数名互不冲突且严格 <= 64 字符
  const outNames = chatTools.map((t) => String(t.function.name))
  assert.equal(new Set(outNames).size, 4)
  assert.ok(outNames.every((n) => n.length <= 64), `存在超过 64 字符的工具名：${outNames.join(',')}`)

  // 校验 custom 工具的 grammar 指引与 input 字符串 schema
  assert.equal(outNames[0], 'apply_patch')
  assert.ok(String(chatTools[0]!.function.description).includes(grammar))
  assert.deepEqual(chatTools[0]!.function.parameters, {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Complete raw payload for this tool, verbatim.' },
    },
    required: ['input'],
  })

  // 校验带 namespace 的 tool_choice 映射到对应的扁平传输名
  assert.deepEqual(chat.tool_choice, {
    type: 'function',
    function: { name: outNames[2] },
  })

  // 非流式回程还原
  const nonStreamObj = toResponsesObject(
    reqBody,
    'gpt-5',
    {
      id: 'c_1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'patch_1',
                type: 'function',
                function: { name: 'apply_patch', arguments: JSON.stringify({ input: patchText }) },
              },
              {
                id: 'read_1',
                type: 'function',
                function: { name: outNames[2], arguments: '{"path":"a.ts"}' },
              },
            ],
          },
        },
      ],
    },
    'resp_rt',
  )
  const output = nonStreamObj.output as Array<Record<string, unknown>>
  assert.equal(output.length, 2)
  assert.deepEqual(output[0], {
    id: 'patch_1',
    type: 'custom_tool_call',
    status: 'completed',
    call_id: 'patch_1',
    name: 'apply_patch',
    input: patchText,
  })
  assert.equal(output[1]!.type, 'function_call')
  assert.equal(output[1]!.namespace, longNs)
  assert.equal(output[1]!.name, 'read')

  // 流式回程还原（含 `: keepalive` 注释透传、custom_tool_call_input.delta 解包、added 即带 namespace）
  const sseIn = streamFromStrings([
    ': keepalive\n\n',
    `data: {"id":"s_1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"patch_s","type":"function","function":{"name":"apply_patch","arguments":${JSON.stringify(JSON.stringify({ input: patchText }))}}},{"index":1,"id":"read_s","type":"function","function":{"name":${JSON.stringify(outNames[1])},"arguments":"{\\"ok\\":true}"}}]}}]}\n\n`,
    'data: {"id":"s_1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const { events, comments } = await collectResponsesSse(
    toResponsesSse(sseIn, reqBody, 'gpt-5', 'resp_stream'),
  )
  assert.deepEqual(comments, [': keepalive'])

  const addedItems = events
    .filter((e) => e.type === 'response.output_item.added')
    .map((e) => e.item as Record<string, unknown>)
  assert.equal(addedItems[0]!.type, 'custom_tool_call')
  assert.equal(addedItems[1]!.namespace, 'mcp_first')
  assert.equal(addedItems[1]!.name, 'read')

  const customDelta = events.find((e) => e.type === 'response.custom_tool_call_input.delta')!
  assert.equal(customDelta.delta, patchText)

  // 将首轮 output 原样塞回二轮 input 历史验证闭环不丢
  const followupChat = toChatBody(
    {
      ...reqBody,
      input: [
        { role: 'user', content: 'edit' },
        ...output,
        { type: 'custom_tool_call_output', call_id: 'patch_1', output: 'patched' },
        { type: 'function_call_output', call_id: 'read_1', output: 'read ok' },
      ],
    },
    'gpt-5',
  )
  const followupMsgs = followupChat.messages as Array<Record<string, unknown>>
  const followupCalls = followupMsgs[1]!.tool_calls as Array<{ function: { name: string; arguments: string } }>
  assert.equal(followupCalls[0]!.function.name, 'apply_patch')
  assert.deepEqual(JSON.parse(followupCalls[0]!.function.arguments), { input: patchText })
  assert.equal(followupCalls[1]!.function.name, outNames[2])

  // 残缺 custom 参数保护
  assert.equal(unwrapCustomToolInput('{"input":').ok, false)
  assert.equal(unwrapCustomToolInput('{}').ok, false)
  assert.equal(unwrapCustomToolInput('{"input":42}').ok, false)
})

test('🔴 `previous_response_id` 必须**报错**，不能静默忽略', () => {
  assert.throws(() => toChatBody({ input: 'hi', previous_response_id: 'resp_x' }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({ input: 'hi', store: true }, 'm'), ResponsesError)
})

test('🔴 `usage.input_tokens` 必须**含**缓存命中（官方口径）', () => {
  const u = usageOf({
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 800 },
  })!
  assert.equal(u.input_tokens, 1000, '⚠️ 必须是**总输入**（含缓存），不是 200')
  assert.deepEqual(u.input_tokens_details, { cached_tokens: 800 })
  assert.equal(u.output_tokens, 50)
  assert.equal(u.total_tokens, 1050)
  assert.equal((u.input_tokens as number) - 800, 200)
})

test('⚠️ `max_output_tokens` → `max_completion_tokens`（由 Chat 路径统一改写）', () => {
  const chat = toChatBody({ input: 'hi', max_output_tokens: 4096 }, 'm')
  assert.equal(chat.max_completion_tokens, 4096)
  assert.equal(chat.max_tokens, undefined)
})

test('⚠️ `reasoning.effort` → 顶层 `reasoning_effort`（不转会静默丢失档位）', () => {
  const chat = toChatBody({ input: 'hi', reasoning: { effort: 'high' } }, 'm')
  assert.equal(chat.reasoning_effort, 'high')
  assert.throws(() => toChatBody({ input: 'hi', max_output_tokens: -1 }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({ input: 'hi', max_output_tokens: 1.5 }, 'm'), ResponsesError)
})

test('⚠️ 图片块：input_image → image_url，且**绝不**自行下载 URL', () => {
  const chat = toChatBody(
    {
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }] }],
    },
    'm',
  )
  const msg = (chat.messages as Array<Record<string, unknown>>)[0]!
  assert.deepEqual(msg.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }])
})

test('⚠️ 空 input / 无可用消息必须报错（不能发出一个空请求）', () => {
  assert.throws(() => toChatBody({ input: [] }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({ input: [{ type: 'reasoning' }] }, 'm'), ResponsesError)
  assert.throws(() => toChatBody({}, 'm'), ResponsesError)
})

test('🔴 非流式输出对象必须含官方要求的全部字段', () => {
  const obj = toResponsesObject(
    { input: 'hi', max_output_tokens: 100, reasoning: { effort: 'low' } },
    'test-model',
    {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    'resp_1',
  )
  assert.equal(obj.id, 'resp_1')
  assert.equal(obj.object, 'response')
  assert.equal(obj.status, 'completed')
  assert.equal(obj.model, 'test-model')
  assert.equal(obj.background, false)
  assert.equal(obj.store, false)
  assert.equal(obj.error, null)
  assert.equal(obj.incomplete_details, null)
  assert.equal(obj.previous_response_id, null)
  assert.deepEqual(obj.reasoning, { effort: 'low', summary: null })
  assert.deepEqual(obj.text, { format: { type: 'text' } })
  assert.equal(obj.max_output_tokens, 100)
  assert.ok(typeof obj.created_at === 'number' && (obj.created_at as number) < 1e11, '⚠️ created_at 必须是**秒**')
  const out = obj.output as Array<Record<string, unknown>>
  assert.equal(out.length, 1)
  assert.equal(out[0]!.type, 'message')
  assert.equal(out[0]!.role, 'assistant')
  const content = out[0]!.content as Array<Record<string, unknown>>
  assert.equal(content[0]!.type, 'output_text')
  assert.equal(content[0]!.text, '你好')
  assert.deepEqual(content[0]!.annotations, [])
})

test('⚠️ `finish_reason: length` → status `incomplete` + incomplete_details', () => {
  const obj = toResponsesObject(
    { input: 'hi' },
    'm',
    {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '截断' }, finish_reason: 'length' }],
    },
    'r',
  )
  assert.equal(obj.status, 'incomplete')
  assert.deepEqual(obj.incomplete_details, { reason: 'max_output_tokens' })
})

test('🔴 工具调用必须产出 function_call 输出项，且正文为空时不发空 message', () => {
  const obj = toResponsesObject(
    { input: 'hi' },
    'm',
    {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
          },
        },
      ],
    },
    'r',
  )
  const out = obj.output as Array<Record<string, unknown>>
  assert.equal(out.length, 1, '⚠️ 不该发空的 message 项')
  assert.equal(out[0]!.type, 'function_call')
  assert.equal(out[0]!.call_id, 'call_1')
  assert.equal(out[0]!.name, 'f')
  assert.equal(out[0]!.arguments, '{"a":1}')
})

test('⚠️ reasoning_content 要单独成一个 reasoning 输出项', () => {
  const obj = toResponsesObject(
    { input: 'hi' },
    'm',
    {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '答案', reasoning_content: '思考中' },
          finish_reason: 'stop',
        },
      ],
    },
    'r',
  )
  const out = obj.output as Array<Record<string, unknown>>
  assert.equal(out.length, 2)
  assert.equal(out[0]!.type, 'reasoning', '⚠️ reasoning 项应在正文之前')
  assert.deepEqual(out[0]!.summary, [{ type: 'summary_text', text: '思考中' }])
  assert.equal(out[1]!.type, 'message')
  assert.equal(out[0]!['output_index'], undefined, 'output 项本身不带 output_index（那是事件字段）')
})

test('⚠️ usage 为 null 时输出 null（不能编造 0 —— 那会被当成真实用量记账）', () => {
  assert.equal(usageOf(null), null)
  assert.equal(usageOf(undefined), null)
  const obj = toResponsesObject(
    { input: 'hi' },
    'm',
    {
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }],
    },
    'r',
  )
  assert.equal(obj.usage, null)
})
