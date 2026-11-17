/**
 * 混元 3D（`src/upstream/three-d.ts`）专项单测：
 * - 纯 Web Crypto TC3-HMAC-SHA256 签名与 Node crypto 独立真值逐字节对拍
 * - `/v2/api-keys` 900s 临时云凭证自动签发、按 uid 缓存、提前 60s 刷新、同号并发 singleflight
 * - 上游 401/403/`AuthFailure*` 自动清缓存重签自愈
 * - 凭证绝不进错误消息/日志脱敏红线、双运行时 Web Standard 纯净性检查
 * - 文生/图生/多视角/Sketch/LowPoly 与 OBJ/GLB/USDZ/FBX/STL 协议约束校验
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Env } from '../src/env.ts'
import { UpstreamError } from '../src/upstream/client.ts'
import {
  AUTO_KEY_MARGIN_MS,
  buildTc3Headers,
  buildThreeDUpstreamBody,
  callThreeDProxy,
  fetchClientTempKey,
  parseThreeDKeyExpiresAt,
  parseThreeDState,
  queryThreeDJob,
  redactThreeDSecrets,
  submitThreeDJob,
  THREE_D_KEY_NAME,
  THREE_D_KEY_PATH,
  THREE_D_KEY_TTL_SECONDS,
  THREE_D_PROXY_PATH,
  THREE_D_SUBMIT_ACTION,
  ThreeDCredentialManager,
  ThreeDNoCredentialError,
} from '../src/upstream/three-d.ts'

const dummyEnv = {} as Env

function nodeTc3Reference(host: string, action: string, payload: string, token: string, epochSec: number): string {
  const date = new Date(epochSec * 1000).toISOString().slice(0, 10)
  const contentType = 'application/json; charset=utf-8'
  const payloadHash = createHash('sha256').update(payload, 'utf8').digest('hex')
  const canonical =
    `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\n`
    + `content-type;host;x-tc-action\n${payloadHash}`
  const scope = `${date}/ai3d/tc3_request`
  const toSign = `TC3-HMAC-SHA256\n${epochSec}\n${scope}\n${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  const kDate = createHmac('sha256', 'TC3codebuddy').update(date, 'utf8').digest()
  const kService = createHmac('sha256', kDate).update('ai3d', 'utf8').digest()
  const kSign = createHmac('sha256', kService).update('tc3_request', 'utf8').digest()
  const sig = createHmac('sha256', kSign).update(toSign, 'utf8').digest('hex')
  return `TC3-HMAC-SHA256 Credential=hy-3d.${token}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${sig}`
}

test('🔴 Web Standard 纯净性：three-d.ts 与 media-router.ts 零 node:* / Buffer / process.env', () => {
  for (const file of ['src/upstream/three-d.ts', 'src/gateway/media-router.ts']) {
    const raw = readFileSync(file, 'utf8')
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(!/\bnode:/.test(stripped), `${file} 不得导入 node:* 模块`)
    assert.ok(!/\bBuffer\b/.test(stripped), `${file} 不得使用 Buffer`)
    assert.ok(!/\bprocess\.env\b/.test(stripped), `${file} 不得直接读取 process.env`)
  }
  const threeDSrc = readFileSync('src/upstream/three-d.ts', 'utf8')
  assert.ok(/crypto\.subtle\.importKey/.test(threeDSrc) && /crypto\.subtle\.sign/.test(threeDSrc), 'TC3 签名必须走 crypto.subtle')
})

test('🔴 TC3-HMAC-SHA256 签名：与官方向量及独立参考实现逐字节一致', async () => {
  const epochSec = 1794551118 // 2026-11-13 UTC（对齐 workbuddy2api-panel 557b3d5 单测向量）
  const payload = '{"Model":"3.1"}'
  const headers = await buildTc3Headers({
    host: 'www.workbuddy.ai',
    action: THREE_D_SUBMIT_ACTION,
    payload,
    tempToken: 'ck_t_abc',
    nowMs: epochSec * 1000,
  })

  const expectedAuth = nodeTc3Reference('www.workbuddy.ai', THREE_D_SUBMIT_ACTION, payload, 'ck_t_abc', epochSec)
  assert.equal(headers.Authorization, expectedAuth)
  assert.ok(headers.Authorization?.includes('Credential=hy-3d.ck_t_abc/2026-11-13/ai3d/tc3_request'))
  assert.equal(headers['X-TC-Action'], THREE_D_SUBMIT_ACTION)
  assert.equal(headers['X-TC-Version'], '2025-05-13')
  assert.equal(headers['X-TC-Region'], 'ap-guangzhou')
  assert.equal(headers['X-TC-Timestamp'], String(epochSec))
})

test('fetchClientTempKey：用国际版/企业版 accessToken 调 /v2/api-keys 换 900s ck_t_ 凭证，且严格隔离 realm 头', async () => {
  const captured: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(
      JSON.stringify({ code: 0, data: { key: 'ck_t_intl_secret_123', expires_at: '2099-01-02T03:04:05Z' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  // 1. 国际版个人号：走 www.workbuddy.ai，绝不注入国内 X-Client-* 三头
  const r1 = await fetchClientTempKey(
    { uid: 'workbuddy:u-intl', accessToken: 'oauth_intl_token', realm: 'global' },
    dummyEnv,
    { fetchImpl: fakeFetch },
  )
  assert.equal(r1.key, 'ck_t_intl_secret_123')
  assert.ok(r1.expiresAt > Date.parse('2099-01-01T00:00:00Z'))
  assert.equal(captured[0]?.url, `https://www.workbuddy.ai${THREE_D_KEY_PATH}`)
  assert.equal(captured[0]?.headers.get('authorization'), 'Bearer oauth_intl_token')
  assert.equal(captured[0]?.headers.get('x-enterprise-id'), null)
  assert.equal(captured[0]?.headers.get('x-client-version'), null, '国际版不得泄漏 X-Client-Version')
  assert.deepEqual(captured[0]?.body, {
    name: THREE_D_KEY_NAME,
    expire_in_seconds: THREE_D_KEY_TTL_SECONDS,
    temporary: true,
  })

  // 2. 国内企业号：注入 X-Enterprise-Id 与国内 X-Client-* 三头
  await fetchClientTempKey(
    { uid: 'u-cn', accessToken: 'oauth_cn_token', realm: 'cn', enterpriseId: 'ent-99' },
    dummyEnv,
    { fetchImpl: fakeFetch },
  )
  assert.equal(captured[1]?.url, `https://copilot.tencent.com${THREE_D_KEY_PATH}`)
  assert.equal(captured[1]?.headers.get('x-enterprise-id'), 'ent-99')
  assert.ok(captured[1]?.headers.get('x-client-version') !== null, '国内版应携带 X-Client-Version')
})

test('fetchClientTempKey：静态 API Key 账号短路不打上游，OAuth 401 透出 auth_error 供外层续期', async () => {
  let httpCalls = 0
  const fakeFetch: typeof fetch = async () => {
    httpCalls += 1
    return new Response('{"code":0,"data":{"key":"ck_t_x"}}', { status: 200 })
  }

  await assert.rejects(
    () => fetchClientTempKey({ uid: 'k1', accessToken: 'ck_static_key' }, dummyEnv, { fetchImpl: fakeFetch }),
    (err: unknown) => err instanceof ThreeDNoCredentialError,
  )
  assert.equal(httpCalls, 0, 'ck_ 静态密钥账号不得发起网络请求')

  const auth401Fetch: typeof fetch = async () => new Response('Unauthorized Bearer secret_tok', { status: 401 })
  await assert.rejects(
    () => fetchClientTempKey({ uid: 'u1', accessToken: 'expired_oauth' }, dummyEnv, { fetchImpl: auth401Fetch }),
    (err: unknown) => {
      assert.ok(err instanceof UpstreamError)
      assert.equal(err.kind, 'auth_error')
      assert.ok(!err.message.includes('secret_tok') && !err.detail.includes('secret_tok'))
      return true
    },
  )
})

test('🔴 ThreeDCredentialManager：按 uid 缓存、到期前 60s 刷新、同账号并发 Singleflight 与等待方独立取消', async () => {
  let fetchCount = 0
  let releaseFlight!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseFlight = resolve
  })

  const baseNow = 1_700_000_000_000
  const mgr = new ThreeDCredentialManager(async (ctx) => {
    fetchCount += 1
    await gate
    return { key: `ck_t_${ctx.uid}_${fetchCount}`, expiresAt: baseNow + 900_000 }
  })

  // 1. 5 个同账号并发调用 + 1 个中途取消的等待方
  const abortCtrl = new AbortController()
  const canceledWaiter = mgr.resolve({ uid: 'u1', accessToken: 'at1' }, dummyEnv, {
    nowMs: baseNow,
    signal: abortCtrl.signal,
  })
  const callers = Array.from({ length: 5 }, () =>
    mgr.resolve({ uid: 'u1', accessToken: 'at1' }, dummyEnv, { nowMs: baseNow }),
  )

  // 中途取消等待方：该等待方立即失败，但不影响其余 5 个并发调用
  abortCtrl.abort(new Error('caller_aborted'))
  await assert.rejects(canceledWaiter, /caller_aborted/)

  releaseFlight()
  const results = await Promise.all(callers)
  assert.equal(fetchCount, 1, '同账号 5 并发 + 1 取消等待方只应触发 1 次底层签发')
  for (const r of results) {
    assert.equal(r.tempToken, 'ck_t_u1_1')
  }

  // 2. 缓存有效期内再次获取：命中缓存，不重签
  const cached = await mgr.resolve({ uid: 'u1', accessToken: 'at1' }, dummyEnv, { nowMs: baseNow + 60_000 })
  assert.equal(cached.fromCache, true)
  assert.equal(cached.tempToken, 'ck_t_u1_1')
  assert.equal(fetchCount, 1)

  // 3. 不同账号隔离：u2 单独签发，不影响 u1
  const u2 = await mgr.resolve({ uid: 'u2', accessToken: 'at2' }, dummyEnv, { nowMs: baseNow + 60_000 })
  assert.equal(u2.tempToken, 'ck_t_u2_2')
  assert.equal(fetchCount, 2)

  // 4. 进入到期前 60s 边界（expiresAt - AUTO_KEY_MARGIN_MS）：自动淘汰重签
  const refreshed = await mgr.resolve({ uid: 'u1', accessToken: 'at1' }, dummyEnv, {
    nowMs: baseNow + 900_000 - AUTO_KEY_MARGIN_MS + 1,
  })
  assert.equal(refreshed.fromCache, false)
  assert.equal(refreshed.tempToken, 'ck_t_u1_3')
  assert.equal(fetchCount, 3)
})

test('ThreeDCredentialManager：支持环境变量手工覆盖（THREE_D_TEMP_TOKENS / THREE_D_AUTO_TOKEN=false）', async () => {
  let autoCalls = 0
  const mgr = new ThreeDCredentialManager(async () => {
    autoCalls += 1
    return { key: 'ck_t_auto', expiresAt: Date.now() + 600_000 }
  })

  const manualEnv = {
    THREE_D_TEMP_TOKENS: JSON.stringify({ u1: 'ck_t_manual_u1', '*': 'ck_t_manual_star' }),
  } as unknown as Env

  const c1 = await mgr.resolve({ uid: 'workbuddy:u1', accessToken: 'at' }, manualEnv)
  assert.equal(c1.tempToken, 'ck_t_manual_u1')
  assert.equal(c1.fromManual, true)

  const c2 = await mgr.resolve({ uid: 'u99', accessToken: 'at' }, manualEnv)
  assert.equal(c2.tempToken, 'ck_t_manual_star')
  assert.equal(autoCalls, 0, '命中手工表时绝不触发自动签发')

  const disabledAutoEnv = { THREE_D_AUTO_TOKEN: 'false' } as unknown as Env
  await assert.rejects(
    () => mgr.resolve({ uid: 'u99', accessToken: 'at' }, disabledAutoEnv),
    (err: unknown) => err instanceof ThreeDNoCredentialError,
  )
})

test('🔴 callThreeDProxy：上游返回 401/403 或 AuthFailure 时自动清缓存重签并自愈，且绝不泄露 ck_t_ 凭证', async () => {
  let issueCount = 0
  const mgr = new ThreeDCredentialManager(async () => {
    issueCount += 1
    return { key: `ck_t_gen_${issueCount}_topsecret`, expiresAt: Date.now() + 900_000 }
  })

  // 先预热缓存拿到第 1 代凭证
  await mgr.resolve({ uid: 'u1', accessToken: 'at1', realm: 'global' }, dummyEnv)
  assert.equal(issueCount, 1)

  const seenAuthHeaders: string[] = []
  let proxyCalls = 0
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    assert.equal(url, `https://www.workbuddy.ai${THREE_D_PROXY_PATH}`)
    proxyCalls += 1
    const h = new Headers(init?.headers)
    seenAuthHeaders.push(h.get('authorization') ?? '')
    if (proxyCalls === 1) {
      // 模拟旧临时凭证在服务端提前失效（HTTP 200 + AuthFailure.TokenExpired 或 HTTP 401）
      return new Response(
        JSON.stringify({
          Response: { Error: { Code: 'AuthFailure.TokenFailure', Message: 'ck_t_gen_1_topsecret expired' } },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ Response: { JobId: 'job-healed-1', Status: 'SUBMITTED', RequestId: 'req-1' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const submitted = await submitThreeDJob(
    { uid: 'u1', accessToken: 'at1', realm: 'global' },
    dummyEnv,
    { prompt: 'Q版机甲青蛙', result_format: 'GLB', enable_pbr: true },
    { credentials: mgr, fetchImpl: fakeFetch },
  )

  assert.equal(submitted.state.jobId, 'job-healed-1')
  assert.equal(issueCount, 2, '401/AuthFailure 后必须清空旧缓存并重签第 2 代凭证')
  assert.equal(proxyCalls, 2)
  assert.ok(seenAuthHeaders[0]?.includes('hy-3d.ck_t_gen_1_topsecret/'))
  assert.ok(seenAuthHeaders[1]?.includes('hy-3d.ck_t_gen_2_topsecret/'))

  // 若重签后依然失败，抛出的异常里绝不能出现任何 ck_t_ 明文
  const alwaysFailFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        Response: { Error: { Code: 'AuthFailure', Message: 'bad token ck_t_gen_2_topsecret Bearer my_oauth_tok' } },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )

  await assert.rejects(
    () => queryThreeDJob({ uid: 'u1', accessToken: 'my_oauth_tok', realm: 'global' }, dummyEnv, 'job-1', {
      credentials: mgr,
      fetchImpl: alwaysFailFetch,
    }),
    (err: unknown) => {
      const text = `${err instanceof Error ? err.message : String(err)} ${(err as UpstreamError).detail ?? ''}`
      assert.ok(!text.includes('ck_t_gen_'), `错误消息泄露了临时凭证: ${text}`)
      assert.ok(!text.includes('my_oauth_tok'), `错误消息泄露了 OAuth 令牌: ${text}`)
      return true
    },
  )

  assert.equal(
    redactThreeDSecrets('Credential=hy-3d.ck_t_secret.123/2026, Authorization: Bearer eyJhbGciOi, Signature=deadbeef'),
    'Credential=hy-3d.[REDACTED]/2026, Authorization: Bearer [REDACTED], Signature=[REDACTED]',
  )
})

test('buildThreeDUpstreamBody：完整覆盖文生/图生/多视角/Sketch/LowPoly 与五种输出格式校验', () => {
  // 1. 五种输出格式 OBJ / GLB / USDZ / FBX / STL 全部合法通过（含小写自动转大写）
  for (const fmt of ['obj', 'GLB', 'USDZ', 'fbx', 'STL']) {
    const { body, model } = buildThreeDUpstreamBody({
      prompt: '古代青铜鼎',
      result_format: fmt,
      face_count: 100_000,
      enable_pbr: true,
    })
    assert.equal(model, '3.1')
    assert.equal(body.ResultFormat, fmt.toUpperCase())
    assert.equal(body.FaceCount, 100_000)
    assert.equal(body.EnablePBR, true)
  }

  // 2. data:image/...;base64,... 自动剥前缀，且多视角 ViewImageUrl 公网 URL 不误做 base64 解码
  const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const multi = buildThreeDUpstreamBody({
    image_base64: `data:image/png;base64,${tinyPngB64}`,
    multi_view_images: [
      { ViewType: 'back', ViewImageUrl: 'https://cos.ap-guangzhou.myqcloud.com/back.png' },
      { ViewType: 'left', ViewImageBase64: `data:image/png;base64,${tinyPngB64}` },
    ],
  })
  assert.equal(multi.body.ImageBase64, tinyPngB64)
  assert.deepEqual(multi.body.MultiViewImages, [
    { ViewType: 'back', ViewImageUrl: 'https://cos.ap-guangzhou.myqcloud.com/back.png' },
    { ViewType: 'left', ViewImageBase64: tinyPngB64 },
  ])

  // 3. Sketch 模式约束：必须同时有 prompt + 参考图
  assert.throws(() => buildThreeDUpstreamBody({ prompt: '草图杯子', generate_type: 'Sketch' }), /Sketch/)
  assert.throws(
    () => buildThreeDUpstreamBody({ image_url: 'https://example.com/a.png', generate_type: 'Sketch' }),
    /Sketch/,
  )
  const sketchOk = buildThreeDUpstreamBody({
    prompt: '陶瓷马克杯',
    image_url: 'https://example.com/sketch.png',
    generate_type: 'Sketch',
  })
  assert.equal(sketchOk.body.GenerateType, 'Sketch')

  // 4. LowPoly 必须 model=3.0
  assert.throws(() => buildThreeDUpstreamBody({ prompt: '树', generate_type: 'LowPoly' }), /LowPoly 需要 model=3\.0/)
  assert.equal(
    buildThreeDUpstreamBody({ prompt: '树', model: '3.0', generate_type: 'LowPoly', polygon_type: 'quadrilateral' })
      .body.Model,
    '3.0',
  )

  // 5. multi_view_images 与 prompt 互斥、且必须带主图
  assert.throws(
    () =>
      buildThreeDUpstreamBody({
        prompt: '不能共存',
        image_url: 'https://example.com/front.png',
        multi_view_images: [{ ViewType: 'back', ViewImageUrl: 'https://example.com/back.png' }],
      }),
    /multi_view_images/,
  )
  assert.throws(
    () =>
      buildThreeDUpstreamBody({
        multi_view_images: [{ ViewType: 'back', ViewImageUrl: 'https://example.com/back.png' }],
      }),
    /multi_view_images/,
  )

  // 6. 空请求、非法格式、越界面数均被拦截
  assert.throws(() => buildThreeDUpstreamBody({}), /至少提供一种/)
  assert.throws(() => buildThreeDUpstreamBody({ prompt: 'x', result_format: 'PLY' }), /result_format/)
  assert.throws(() => buildThreeDUpstreamBody({ prompt: 'x', face_count: 999 }), /face_count/)
})

test('parseThreeDState 与 parseThreeDKeyExpiresAt：优先提取 GLB 直链、映射状态码与消费积分', () => {
  const st = parseThreeDState(
    JSON.stringify({
      Response: {
        JobStatusCode: 5,
        ResultCreditConsumed: 30,
        RequestId: 'req-88',
        ResultFile3Ds: [
          { Type: 'OBJ', Url: 'https://ai3d.cos.ap-guangzhou.myqcloud.com/out.obj.zip' },
          { Type: 'GLB', Url: 'https://ai3d.cos.ap-guangzhou.myqcloud.com/out.glb' },
        ],
      },
    }),
    'job-fallback',
  )
  assert.equal(st.jobId, 'job-fallback')
  assert.equal(st.status, 'DONE')
  assert.equal(st.credit, 30)
  assert.equal(st.resultUrl, 'https://ai3d.cos.ap-guangzhou.myqcloud.com/out.glb')
  assert.equal(st.resultFiles.length, 2)

  assert.ok(parseThreeDKeyExpiresAt('2099-01-01T00:00:00Z') > 0)
  assert.equal(parseThreeDKeyExpiresAt(1700000000), 1700000000 * 1000)
  assert.equal(parseThreeDKeyExpiresAt(1700000000123), 1700000000123)
  assert.equal(parseThreeDKeyExpiresAt('invalid'), 0)
  assert.equal(parseThreeDKeyExpiresAt(null), 0)
})

test('callThreeDProxy：无临时云凭证时发请求前即失败，绝不拿账号 OAuth token 硬打 tcproxy', async () => {
  let proxyHit = 0
  const mgr = new ThreeDCredentialManager(async () => {
    throw new ThreeDNoCredentialError('no key')
  })
  const fakeFetch: typeof fetch = async () => {
    proxyHit += 1
    return new Response('{}', { status: 200 })
  }
  await assert.rejects(
    () =>
      callThreeDProxy(
        { uid: 'u1', accessToken: 'oauth_tok', realm: 'global' },
        dummyEnv,
        THREE_D_SUBMIT_ACTION,
        { Model: '3.1', Prompt: 'cube' },
        { credentials: mgr, fetchImpl: fakeFetch },
      ),
    (err: unknown) => err instanceof ThreeDNoCredentialError,
  )
  assert.equal(proxyHit, 0, '缺少 ck_t_ 凭证时不得向 tcproxy 发起任何请求')
})
