/**
 * 流式截断自动续写与「预告句悬停（Narration Hover）」救援模块单测。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CONTINUE_NUDGE,
  KEEPALIVE_FRAME,
  buildContinuationBody,
  extractLastSentence,
  mergeSegmentUsage,
  narrationTailPromises,
  narrationTailSuspends,
  shouldContinueTruncated,
  shouldRescueNarrationHover,
  toolCallMarkupState,
  wrapContinuationStream,
  yieldsToUser,
} from '../src/gateway/continuation.ts'
import { aggregateSse } from '../src/gateway/stream.ts'

function sseStreamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let idx = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(lines[idx++]!))
    },
  })
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

const AGENT_TOOL_BODY: Record<string, unknown> = {
  model: 'deepseek-v4.1-flash',
  tools: [
    {
      type: 'function',
      function: { name: 'edit_file', parameters: { type: 'object', properties: {} } },
    },
  ],
  messages: [
    { role: 'user', content: '修复网关超时 bug' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ],
}

test('🔴 截断续写判据：length 触发、残缺 tool_calls 拒绝、探活 max_tokens <= 16 拒绝', () => {
  // 正常无工具长文截断 → 续写
  assert.equal(
    shouldContinueTruncated({
      finishReason: 'length',
      textLength: 1200,
    }),
    true,
  )

  // 含工具调用分片（残缺 JSON 风险）→ 严禁续写
  assert.equal(
    shouldContinueTruncated({
      finishReason: 'length',
      hasToolCalls: true,
      textLength: 500,
    }),
    false,
  )

  // 探活极短 max_tokens <= 16 → 绝不续写
  for (const probeLimit of [1, 5, 16]) {
    assert.equal(
      shouldContinueTruncated({
        finishReason: 'length',
        textLength: 20,
        maxTokens: probeLimit,
        segmentCompletionTokens: probeLimit,
        segmentReasoningTokens: probeLimit,
      }),
      false,
      `max_tokens=${probeLimit} 是探活请求，绝不能续写`,
    )
  }

  // 普通显式 max_tokens（如 4096）未被思考吃空时尊重客户端上限；被思考吃掉 >=50% 时允许关思考续写
  assert.equal(
    shouldContinueTruncated({
      finishReason: 'length',
      textLength: 2000,
      maxTokens: 4096,
      segmentCompletionTokens: 4096,
      segmentReasoningTokens: 500,
    }),
    false,
  )
  assert.equal(
    shouldContinueTruncated({
      finishReason: 'length',
      textLength: 300,
      maxTokens: 4096,
      segmentCompletionTokens: 4096,
      segmentReasoningTokens: 3800,
    }),
    true,
  )

  // 段数达到上限或零输出时不续写
  assert.equal(
    shouldContinueTruncated({
      finishReason: 'length',
      textLength: 1000,
      segmentIndex: 2,
      maxSegments: 3,
    }),
    false,
  )
  assert.equal(
    shouldContinueTruncated({
      finishReason: 'length',
      textLength: 0,
      reasoningLength: 0,
    }),
    false,
  )
})

test('🔴 文件名与版本号中的 `.` 绝不误判为句末边界', () => {
  assert.equal(
    extractLastSentence('三处改动已检查完毕。接下来我来修改 internal/verify/check.go 里的逻辑'),
    '接下来我来修改 internal/verify/check.go 里的逻辑',
  )
  assert.equal(
    extractLastSentence('Checked previous logs. Let me update v1.2.0 in package.json'),
    'Let me update v1.2.0 in package.json',
  )
  assert.equal(
    extractLastSentence('三处都改完了。是否需要顺便改 config.go 里的超时'),
    '是否需要顺便改 config.go 里的超时',
  )
})

test('🔴 严格护栏：向用户提问/请确认拍板措辞一律停手不救（零误触）', () => {
  const mustNotRescue = [
    '邮件已经写好，请确认后我再发送。\n\n收件人：all@example.com\n主题：Q3 计划',
    '邮件已经写好，确认后我再发送。\n\n收件人：all@example.com\n主题：Q3 计划',
    '是否继续执行下一步修改？',
    '**是否继续？**',
    '需要我顺便把文档也一起更新吗？',
    '需要我继续修改 config.ts 吗',
    '三处都改完了。是否需要顺便改 config.go 里的超时',
    '要不要顺便把 v1.2 的配置也改掉',
    '要不要现在发送？\n\n收件人：all@example.com\n主题：Q3 计划',
    'Please confirm before I apply the migration:',
    'Let me know if you want me to update server.ts',
    'Should I update src/index.ts now?',
  ]

  for (const text of mustNotRescue) {
    assert.equal(yieldsToUser(text), true, `应当识别为向用户让渡：${text}`)
    const decision = shouldRescueNarrationHover({
      finishReason: 'stop',
      text,
      requestBody: AGENT_TOOL_BODY,
    })
    assert.equal(decision.rescue, false, `等用户确认/提问绝不能自动救援：${text}`)
  }
})

test('预告句悬停：准确识别中英文动作预告，且中段技术叙述不误拦、长总结不误救', () => {
  const shouldRescueSamples = [
    '接下来我来修改 src/gateway/server.ts',
    '接下来我来修改 src/gateway/server.ts。',
    'Let me update internal/verify/check.go',
    'Let me update internal/verify/check.go.',
    '5G 已降到 10 dBm。重新连接并测试下行：',
    'Reading failfirst.sh mutation script',
    // 中段含技术叙述词汇（确认无误 / 是否需要我们），但末句是明确动作承诺，照常救
    '我把改动逐行过了一遍。'.repeat(15) +
      '日志格式确认无误。是否需要我们更换钢丝绳要看趋势数据。\n\n我将开始修改 internal/verify/check.go',
  ]

  for (const text of shouldRescueSamples) {
    const decision = shouldRescueNarrationHover({
      finishReason: 'stop',
      text,
      requestBody: AGENT_TOOL_BODY,
    })
    assert.equal(decision.rescue, true, `应当触发预告句救援：${text}（reason=${decision.reason}）`)
  }

  // 长文总结收尾无句号（列表、表格、通过提示、对用户建议）绝不误救
  const longPrefix = '这一轮我把三处改动逐条过了一遍，结论如下。'.repeat(20) + '\n\n'
  const finishedTails = [
    '## 改动清单\n- 修复续写闸门\n- 新增回归测试',
    '| 文件 | 改动 |\n|---|---|\n| continue.ts | 续写闸门 |',
    '全部测试通过',
    '任务已全部完成',
    '接下来你可以运行 npm test 验证',
    '对我来说这次改动已经足够',
    'Testing: all 42 cases passed',
  ]
  for (const tail of finishedTails) {
    const text = longPrefix + tail
    assert.equal(narrationTailSuspends(text), true)
    const decision = shouldRescueNarrationHover({
      finishReason: 'stop',
      text,
      requestBody: AGENT_TOOL_BODY,
    })
    assert.equal(decision.rescue, false, `已写完的长总结不该误救：${tail}`)
  }

  // 完整 DSML / XML 工具调用标记不救，半截标记救 1 次
  const completeDsml = '先查文件</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>'
  assert.equal(toolCallMarkupState(completeDsml), 'complete')
  assert.equal(
    shouldRescueNarrationHover({
      finishReason: 'stop',
      text: completeDsml,
      requestBody: AGENT_TOOL_BODY,
    }).rescue,
    false,
  )

  const partialDsml = '先查文件<｜｜DSML｜｜ parameter name="path">src/a.ts'
  assert.equal(toolCallMarkupState(partialDsml), 'partial')
  assert.equal(
    shouldRescueNarrationHover({
      finishReason: 'stop',
      text: partialDsml,
      requestBody: AGENT_TOOL_BODY,
      narrationRescuesUsed: 0,
    }).rescue,
    true,
  )
  assert.equal(
    shouldRescueNarrationHover({
      finishReason: 'stop',
      text: partialDsml,
      requestBody: AGENT_TOOL_BODY,
      narrationRescuesUsed: 1,
    }).rescue,
    false,
    '结构未闭合最多只救 1 次',
  )

  // 无新产出即停 + 次数上限保护
  assert.equal(
    shouldRescueNarrationHover({
      finishReason: 'stop',
      text: '接下来我来修改 a.ts',
      requestBody: AGENT_TOOL_BODY,
      narrationRescuesUsed: 1,
      lastRescueTextLength: '接下来我来修改 a.ts'.length,
    }).reason,
    'no_new_progress',
  )
  assert.equal(
    shouldRescueNarrationHover({
      finishReason: 'stop',
      text: '接下来我来修改 a.ts，然后再改 b.ts',
      requestBody: AGENT_TOOL_BODY,
      narrationRescuesUsed: 2,
      maxNarrationRescues: 2,
    }).reason,
    'max_rescues_reached',
  )
})

test('wrapContinuationStream：截断无缝拼接 + 等待期发射 `: keepalive` + 跨段 usage 合并', async () => {
  // 首段：同时测试「末块同帧携带 content 与 finish_reason=length」不丢字
  const seg0 = sseStreamFromLines([
    'data: {"id":"cmpl_1","choices":[{"index":0,"delta":{"role":"assistant","content":"前半句，"}}]}\n\n',
    'data: {"id":"cmpl_1","choices":[{"index":0,"delta":{"content":"紧接断点，"},"finish_reason":"length"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"credit":0.2}}\n\n',
    'data: [DONE]\n\n',
  ])

  const sentBodies: Array<Record<string, unknown>> = []
  const wrapped = wrapContinuationStream(seg0, {
    requestBody: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '写长文' }] },
    keepaliveIntervalMs: 15,
    async openNextSegment(nextBody) {
      sentBodies.push(nextBody)
      // 模拟上游续写请求 TTFB 耗时 45ms，触发至少一次 `: keepalive\n\n`
      await new Promise((r) => setTimeout(r, 45))
      return sseStreamFromLines([
        'data: {"id":"cmpl_2","choices":[{"index":0,"delta":{"reasoning_content":"续写段内部思考应被剥离"}}]}\n\n',
        'data: {"id":"cmpl_2","choices":[{"index":0,"delta":{"content":"后半句圆满结束。"}}]}\n\n',
        'data: {"id":"cmpl_2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":160,"completion_tokens":30,"total_tokens":190,"credit":0.15}}\n\n',
        'data: [DONE]\n\n',
      ])
    },
  })

  const rawOut = await readStreamText(wrapped)
  assert.equal(sentBodies.length, 1)
  const nextMsgs = sentBodies[0]!.messages as Array<Record<string, unknown>>
  assert.deepEqual(nextMsgs[1], { role: 'assistant', content: '前半句，紧接断点，' })
  assert.deepEqual(nextMsgs[2], { role: 'user', content: CONTINUE_NUDGE })

  // 验证等待期发射了 `: keepalive` 注释心跳，且全流只有一个 [DONE]
  assert.ok(rawOut.includes(KEEPALIVE_FRAME.trim()), '异步续写等待期应发射 : keepalive 心跳')
  assert.equal((rawOut.match(/data: \[DONE\]/g) ?? []).length, 1, '合并流只能有唯一一个 [DONE]')

  // 聚合验证客户端收到的完整正文与合并后的 usage（prompt 取末段 160，completion 50+30=80，credit 0.2+0.15=0.35）
  const agg = aggregateSse(rawOut, { model: 'deepseek-v4.1-flash', now: Date.now() })
  assert.equal(agg.choices[0]!.message.content, '前半句，紧接断点，后半句圆满结束。')
  assert.equal(agg.choices[0]!.message.reasoning_content, undefined, '正文开始后的续写思考应剥离不外泄')
  assert.equal(agg.choices[0]!.finish_reason, 'stop')
  const u = agg.usage as Record<string, unknown>
  assert.equal(u.prompt_tokens, 160)
  assert.equal(u.completion_tokens, 80)
  assert.equal(u.total_tokens, 240)
  assert.ok(Math.abs((u.credit as number) - 0.35) < 1e-9)
})

test('wrapContinuationStream：预告句悬停自动救援补出 tool_calls，且无新产出时立即停手', async () => {
  const seg0 = sseStreamFromLines([
    'data: {"id":"n1","choices":[{"index":0,"delta":{"content":"接下来我来修改 src/gateway/server.ts"}}]}\n\n',
    'data: {"id":"n1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  let calls = 0
  const wrapped = wrapContinuationStream(seg0, {
    requestBody: AGENT_TOOL_BODY,
    async openNextSegment() {
      calls += 1
      return sseStreamFromLines([
        'data: {"id":"n2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fix","type":"function","function":{"name":"edit_file","arguments":"{\\"path\\":\\"server.ts\\"}"}}]}}]}\n\n',
        'data: {"id":"n2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    },
  })

  const rawOut = await readStreamText(wrapped)
  assert.equal(calls, 1)
  const agg = aggregateSse(rawOut, { model: 'deepseek-v4.1-flash', now: Date.now() })
  assert.equal(agg.choices[0]!.message.content, '接下来我来修改 src/gateway/server.ts')
  assert.equal(agg.choices[0]!.finish_reason, 'tool_calls')
  assert.equal(agg.choices[0]!.message.tool_calls?.length, 1)

  // 验证无新产出即停（不会连续死循环第 2 次救援）
  let emptyRescueCalls = 0
  const segStuck = sseStreamFromLines([
    'data: {"id":"s1","choices":[{"index":0,"delta":{"content":"Let me update check.go"}}]}\n\n',
    'data: {"id":"s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const stuckWrapped = wrapContinuationStream(segStuck, {
    requestBody: AGENT_TOOL_BODY,
    maxNarrationRescues: 2,
    async openNextSegment() {
      emptyRescueCalls += 1
      // 救援段返回空正文 + stop
      return sseStreamFromLines([
        'data: {"id":"s2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    },
  })
  await readStreamText(stuckWrapped)
  assert.equal(emptyRescueCalls, 1, '第 1 次救援零新增正文时必须立刻停手，绝不白烧第 2 次请求')

  // 纯函数校验 buildContinuationBody 与 mergeSegmentUsage
  const built = buildContinuationBody(
    { model: 'm', messages: [{ role: 'user', content: 'q' }], reasoning_effort: 'high' },
    { text: 'partial', reasoning: 'think' },
    'continue',
    { disableThinking: true },
  )
  assert.deepEqual(built.thinking, { type: 'disabled' })
  assert.equal(built.reasoning_effort, undefined)
  const merged = mergeSegmentUsage(
    { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    { prompt_tokens: 80, completion_tokens: 25, total_tokens: 105 },
  )
  assert.deepEqual(merged, { prompt_tokens: 80, completion_tokens: 35, total_tokens: 115 })
  assert.equal(narrationTailPromises('接下来我来修改 config.ts'), true)
})
