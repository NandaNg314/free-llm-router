import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectServerWebTools,
  findHttpUrl,
  handleWebToolChat,
  isWebToolModel,
  lastUserText,
  lastUserTextFromResponses,
} from '../src/gateway/web-tools.ts'

test('isWebToolModel：裸名与带 provider 前缀都识别，其他模型不误判', () => {
  assert.equal(isWebToolModel('wb-search'), true)
  assert.equal(isWebToolModel('buddy/wb-fetch'), true)
  assert.equal(isWebToolModel('WB-SEARCH-FETCH'), true)
  assert.equal(isWebToolModel('wb-searchx'), false)
  assert.equal(isWebToolModel('deepseek-v4.1-flash'), false)
})

test('detectServerWebTools：识别 Anthropic / Responses 的托管工具', () => {
  assert.deepEqual(detectServerWebTools([{ type: 'web_search_20250305', name: 'web_search' }]), {
    search: true,
    fetch: false,
  })
  assert.deepEqual(detectServerWebTools([{ type: 'web_fetch' }, { type: 'function' }]), {
    search: false,
    fetch: true,
  })
  assert.deepEqual(detectServerWebTools(undefined), { search: false, fetch: false })
})

test('findHttpUrl：只取 http(s) 绝对地址，去掉中文标点尾巴', () => {
  assert.equal(findHttpUrl('看这个 https://example.com/a?b=1。'), 'https://example.com/a?b=1')
  assert.equal(findHttpUrl('没有链接'), undefined)
})

test('lastUserText：Chat 与 Anthropic 两种 content 形态都能取到', () => {
  assert.equal(lastUserText([{ role: 'user', content: 'hi' }]), 'hi')
  assert.equal(
    lastUserText([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]),
    'a\nb',
  )
  assert.equal(lastUserText([{ role: 'assistant', content: 'x' }]), '')
})

test('lastUserTextFromResponses：input 为字符串或 message 数组', () => {
  assert.equal(lastUserTextFromResponses('直接问'), '直接问')
  assert.equal(
    lastUserTextFromResponses([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
    ]),
    'q',
  )
})

test('handleWebToolChat：wb-fetch 缺少 URL 直接 400，不触发上游调用', async () => {
  const result = await handleWebToolChat(
    { model: 'wb-fetch', messages: [{ role: 'user', content: '抓一下这个页面' }] },
    {} as never,
    undefined,
    'wb-fetch',
  )
  assert.equal(result.response.status, 400)
  const body = await result.response.json() as { error: { message: string } }
  assert.match(body.error.message, /URL/)
})
