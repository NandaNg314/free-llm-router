/**
 * 国内 5.11.3 指纹、全链路 `X-Client-*` 三头与 `/v2/report` 版本三元组双向隔离单测。
 *
 * 参考提交：`misakano7545/workbuddy2api-panel` `2fa6876`、`96265d7`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  billingHeaders,
  billingUserAgent,
  CLI_VERSION,
  CLIENT_IDENTITY_PLATFORM,
  CLIENT_IDENTITY_PRODUCT,
  CLIENT_VERSION,
  CLIENT_VERSION_INTL,
  cliChatHeaders,
  cliCommonHeaders,
  clientIdentityHeaders,
  cliUserAgent,
  cliUserAgentIntl,
  DESKTOP_CLI_VERSION,
  DESKTOP_COMMIT_CN,
  DESKTOP_COMMIT_GL,
  DESKTOP_RELEASE_DATE_CN,
  DESKTOP_RELEASE_DATE_GL,
  DESKTOP_VERSION,
  DESKTOP_VERSION_GL,
  desktopHeaders,
  desktopUserAgent,
  desktopVersionTriple,
  INTL_CLI_VERSION,
  INTL_DESKTOP_UA,
  INTL_DESKTOP_VERSION,
  mpHeaders,
  referenceChatHeaders,
  webHeaders,
} from '../src/upstream/headers.ts'

const CLIENT_ID_KEYS = ['X-Client-Version', 'X-Client-Platform', 'X-Client-Product'] as const

test('🔴 国内 5.11.3 / CLI 2.176.0 与国际 5.9.4 / CLI 2.165.0 版本段严格按 realm 隔离，绝不混拼', () => {
  assert.equal(CLIENT_VERSION, '5.11.3')
  assert.equal(DESKTOP_VERSION, '5.11.3')
  assert.equal(CLI_VERSION, '2.176.0')
  assert.equal(DESKTOP_CLI_VERSION, '2.176.0')

  assert.equal(INTL_DESKTOP_VERSION, '5.9.4')
  assert.equal(CLIENT_VERSION_INTL, '5.9.4')
  assert.equal(DESKTOP_VERSION_GL, '5.9.4')
  assert.equal(INTL_CLI_VERSION, '2.165.0')

  assert.equal(cliUserAgent(), 'WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.176.0')
  assert.equal(desktopUserAgent('cn'), 'WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.176.0')
  assert.equal(billingUserAgent('cn'), 'WorkBuddy/5.11.3')

  assert.equal(INTL_DESKTOP_UA, 'WorkBuddy/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0')
  assert.equal(cliUserAgentIntl(), 'WorkBuddy/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0')
  assert.equal(desktopUserAgent('global'), 'workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0')
  assert.equal(billingUserAgent('global'), 'WorkBuddy/5.9.4')

  // 严禁拼出官方不存在的跨包混血 UA
  for (const glUa of [INTL_DESKTOP_UA, cliUserAgentIntl(), desktopUserAgent('global')]) {
    assert.ok(!glUa.includes('2.176.0'), `国际 UA 不得混入国内 CLI 2.176.0: ${glUa}`)
    assert.ok(!glUa.includes('5.11.3'), `国际 UA 不得混入国内 5.11.3: ${glUa}`)
  }
  for (const cnUa of [cliUserAgent(), desktopUserAgent('cn')]) {
    assert.ok(!cnUa.includes('2.165.0'), `国内 UA 不得混入国际 CLI 2.165.0: ${cnUa}`)
    assert.ok(!cnUa.includes('5.9.4'), `国内 UA 不得混入国际 5.9.4: ${cnUa}`)
  }
})

test('🔴 X-Client-* 三头双向隔离：国内 WorkBuddy 全链路必带，国际链路一个不发（issue #257 / 96265d7）', () => {
  assert.deepEqual(clientIdentityHeaders('cn'), {
    'X-Client-Version': '5.11.3',
    'X-Client-Platform': CLIENT_IDENTITY_PLATFORM,
    'X-Client-Product': CLIENT_IDENTITY_PRODUCT,
  })
  assert.equal(CLIENT_IDENTITY_PLATFORM, 'windows')
  assert.equal(CLIENT_IDENTITY_PRODUCT, 'WorkBuddy')
  assert.deepEqual(clientIdentityHeaders('global'), {})

  const cnBuilders: Array<[string, Record<string, string>]> = [
    ['cliCommonHeaders(cn)', cliCommonHeaders({ uid: 'u-cn', machineId: 'm1', sessionId: 's1', variant: 'buddy' })],
    [
      'cliChatHeaders(cn)',
      cliChatHeaders({
        uid: 'u-cn',
        machineId: 'm1',
        sessionId: 's1',
        accessToken: 'at',
        conversationRequestId: 'a'.repeat(32),
        variant: 'buddy',
      }),
    ],
    ['billingHeaders(cn)', billingHeaders({ uid: 'u-cn', accessToken: 'at' })],
    ['desktopHeaders(cn)', desktopHeaders({ uid: 'u-cn', accessToken: 'at' })],
  ]

  for (const [name, h] of cnBuilders) {
    assert.equal(h['X-Client-Version'], '5.11.3', `${name} 缺或错 X-Client-Version`)
    assert.equal(h['X-Client-Platform'], 'windows', `${name} 缺或错 X-Client-Platform`)
    assert.equal(h['X-Client-Product'], 'WorkBuddy', `${name} 缺或错 X-Client-Product`)
  }

  const glBuilders: Array<[string, Record<string, string>]> = [
    ['cliCommonHeaders(gl)', cliCommonHeaders({ uid: 'u-gl', machineId: 'm1', sessionId: 's1', variant: 'workbuddy' })],
    [
      'cliChatHeaders(gl)',
      cliChatHeaders({
        uid: 'u-gl',
        machineId: 'm1',
        sessionId: 's1',
        accessToken: 'at',
        conversationRequestId: 'a'.repeat(32),
        variant: 'workbuddy',
      }),
    ],
    ['referenceChatHeaders(gl)', referenceChatHeaders({ uid: 'workbuddy:u-gl', accessToken: 'at', variant: 'workbuddy' })],
    ['billingHeaders(gl explicit)', billingHeaders({ uid: 'u-gl', accessToken: 'at', realm: 'global' })],
    ['billingHeaders(gl uid prefix)', billingHeaders({ uid: 'workbuddy:u-gl', accessToken: 'at' })],
    ['desktopHeaders(gl explicit)', desktopHeaders({ uid: 'u-gl', accessToken: 'at', realm: 'global' })],
    ['desktopHeaders(gl uid prefix)', desktopHeaders({ uid: 'workbuddy:u-gl', accessToken: 'at' })],
  ]

  for (const [name, h] of glBuilders) {
    for (const key of CLIENT_ID_KEYS) {
      assert.ok(!(key in h), `${name} 国际链路绝不能携带 ${key}（实际=${h[key]}）`)
    }
  }

  // Web 领奖头与小程序头必须维持各自专属平台标识，不被桌面 windows 覆盖
  const web = webHeaders({ uid: 'u-cn', accessToken: 'at' })
  assert.equal(web['x-client-platform'], 'web')
  assert.ok(!('X-Client-Platform' in web))
  const mp = mpHeaders({ uid: 'u-cn', accessToken: 'at' })
  assert.equal(mp['X-Client-Platform'], 'mp-weixin')
  assert.equal(mp['X-Client-Product'], 'workbuddy-mp')
})

test('🔴 桌面端 /v2/report 版本三元组按 realm 与 UA 同源对齐（2fa6876）', () => {
  const cn = desktopVersionTriple('cn')
  assert.deepEqual(cn, {
    version: '5.11.3',
    commit: 'ecace0f7028166695994300182295329b8b95449',
    releaseDate: 1794502169764,
    cliVersion: '2.176.0',
  })
  assert.equal(cn.commit, DESKTOP_COMMIT_CN)
  assert.equal(cn.releaseDate, DESKTOP_RELEASE_DATE_CN)
  assert.ok(desktopUserAgent('cn').includes(`WorkBuddy/${cn.version}`))
  assert.ok(desktopUserAgent('cn').includes(`CLI/${cn.cliVersion}`))

  const gl = desktopVersionTriple('global')
  assert.deepEqual(gl, {
    version: '5.9.4',
    commit: 'fa0a0901906addaa1a4259f6df347388a5563ded',
    releaseDate: 1793288804029,
    cliVersion: '2.165.0',
  })
  assert.equal(gl.commit, DESKTOP_COMMIT_GL)
  assert.equal(gl.releaseDate, DESKTOP_RELEASE_DATE_GL)
  assert.ok(desktopUserAgent('global').includes(`workbuddy-ai/${gl.version}`))
  assert.ok(desktopUserAgent('global').includes(`CLI/${gl.cliVersion}`))
})

test('⚠️ realtime.ts 真实对话请求与桌面 5.11.3 头族同源，不残留旧版本硬编码', () => {
  const src = readFileSync('src/upstream/realtime.ts', 'utf8')
  assert.ok(src.includes('DESKTOP_VERSION'))
  assert.ok(src.includes('clientIdentityHeaders'))
  assert.ok(!src.includes("'5.5.6'"))
})
