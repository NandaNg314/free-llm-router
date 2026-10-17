/**
 * 上游同步增量的单测（2026-10-17 从上游 fork 移植，**UI 部分未移植**）。
 *
 * 锁三件事：
 * 1. 计费倍率解析（上游真实字段形态各异，解析错会把付费说成免费/反之）；
 * 2. 裸名别名必须**早于** `splitModelName`（写反会报“未知供应商 aggregate”）；
 * 3. 子密钥的 CIDR / 配额边界（写错会出现“白名单形同虚设”或“永久超限”）。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BARE_MODEL_ALIASES,
  aggregateAliasForBareModel,
  parseCreditsFactor,
} from '../src/providers/canonical-models.js'
import {
  checkQuota,
  emptyApiKeyUsage,
  generateApiKey,
  hashApiKey,
  ipAllowed,
  ipMatchesRule,
  isIpLiteral,
  isWindowExpired,
  keyPrefix,
  modelAllowed,
  normalizeApiKeyLimits,
  resetUsageWindow,
  toApiKeyView,
  type ApiKeyRecord,
} from '../src/store/apikeys.js'

test('计费倍率：认上游各家的真实形态，解析不出返回 undefined（不是 0）', () => {
  assert.equal(parseCreditsFactor('x0.21'), 0.21)
  assert.equal(parseCreditsFactor('×0.21'), 0.21)
  assert.equal(parseCreditsFactor('X0.21'), 0.21)
  assert.equal(parseCreditsFactor('0.21'), 0.21)
  assert.equal(parseCreditsFactor(0.05), 0.05)
  assert.equal(parseCreditsFactor('free'), 0)
  assert.equal(parseCreditsFactor('免费'), 0)
  // ⚠️ 「没给倍率」与「免费」是两件事，不能混成 0
  assert.equal(parseCreditsFactor(undefined), undefined)
  assert.equal(parseCreditsFactor(''), undefined)
  assert.equal(parseCreditsFactor(null), undefined)
  assert.equal(parseCreditsFactor('n/a'), undefined)
  assert.equal(parseCreditsFactor(-1), undefined)
})

test('裸名别名：大小写/空格/`· x0.xx` 后缀都归一；未知拼写照旧不命中', () => {
  assert.equal(aggregateAliasForBareModel('DeepSeek-V4.1-Flash'), 'deepseek-v4-1-flash')
  assert.equal(aggregateAliasForBareModel('deepseek-v4.1-flash'), 'deepseek-v4-1-flash')
  assert.equal(aggregateAliasForBareModel('DEEPSEEK-V4.1-FLASH'), 'deepseek-v4-1-flash')
  assert.equal(aggregateAliasForBareModel('DeepSeek V4.1 Flash · x0.21'), 'deepseek-v4-1-flash')
  assert.equal(aggregateAliasForBareModel('GLM-5.3-Flash'), 'glm-5-3-flash')
  assert.equal(aggregateAliasForBareModel('gpt-9-ultra'), undefined)
  assert.ok(BARE_MODEL_ALIASES.size > 0)
})

test('🔴 别名判定必须在 splitModelName **之前**（否则 aggregate 被当成未知供应商）', () => {
  const gw = readFileSync('src/gateway/server.ts', 'utf8')
  const aliasAt = gw.indexOf('aggregateAliasForBareModel(rawModel)')
  const splitAt = gw.indexOf('splitModelName(rawModel')
  assert.ok(aliasAt > 0 && splitAt > 0, '应能定位两处')
  assert.ok(aliasAt < splitAt, '⚠️ 别名判定必须早于 splitModelName')
  // ⚠️ 只在裸名时生效：显式 `buddy/xxx` 的意图明确，不该被改写
  assert.ok(/rawModel\.includes\('\/'\)/.test(gw), '别名只对裸名生效')
})

test('模型名兜底倍率：只在该家没提供真实倍率时才用（目录一处收口）', () => {
  const src = readFileSync('src/index.ts', 'utf8')
  // ⚠️ 守的是**不变式**（真实倍率优先 + 经归一），不是某一行的字面排版 ——
  // 归一函数包在外面后，整行匹配会假失败而约束根本没变。
  assert.ok(/priceFactorOrNull\(m\.priceFactor \?\? priceFactorFromName\(/.test(src),
    '应先取 provider 解析出的真实倍率，再退回名字解析，且结果经归一')
  assert.ok(/providerName: provider\.name/.test(src), '目录项应带 providerName')
  // ⚠️ realm 必须是**账号实际所在**分片，不按 providerId 猜
  assert.ok(/realm: picked\.realm/.test(src), '目录项应带账号实际 realm')
})

test('目录里的 priceFactor 必须是「有限数字或 null」，不得让 Infinity 漏进 JSON', () => {
  // ## 为什么单独钉这一条
  //
  // `JSON.stringify(Infinity)` 得到的是 **`null`** —— 字段还在、值变成空。
  // 结果是「未标注」与「字段坏了」在客户端无法区分，面板只能靠
  // `Number.isFinite()` 反推；而一旦有人把倍率当数字用（排序、求和），
  // `null` 会静默变成 0 ⇒ 把付费模型说成免费。
  // ⇒ 在唯一出口用 `priceFactorOrNull` 显式归一，语义写死：
  //    `null` = 未标注（仍可调用），`0` = 免费。
  const src = readFileSync('src/index.ts', 'utf8')
  assert.ok(/function priceFactorOrNull\(/.test(src), '应有 priceFactorOrNull 归一函数')
  assert.ok(!/priceFactor: m\.priceFactor \?\? priceFactorFromName/.test(src),
    '⚠️ 不得把可能为 Infinity 的原始值直接塞进响应')
  assert.ok(/priceFactor: priceFactorOrNull\(m\.priceFactor/.test(src), '供应商条目应经归一')
  assert.ok(/priceFactor: priceFactorOrNull\(cheapestOf/.test(src), '聚合条目也应经归一')
})

test('CIDR：v4/v6 边界与跨族不匹配', () => {
  assert.ok(ipMatchesRule('10.1.2.3', '10.0.0.0/8'))
  assert.ok(ipMatchesRule('10.1.2.3', '10.1.2.3'))
  assert.ok(!ipMatchesRule('11.1.2.3', '10.0.0.0/8'))
  // /0 匹配一切；/32 只匹配自己（`1 << 32` 在 JS 里会回绕，必须单独处理）
  assert.ok(ipMatchesRule('8.8.8.8', '0.0.0.0/0'))
  assert.ok(!ipMatchesRule('8.8.8.9', '8.8.8.8/32'))
  assert.ok(ipMatchesRule('2001:db8::1', '2001:db8::/32'))
  // ⚠️ 跨族不得匹配（最常见的 CIDR 实现缺陷）
  assert.ok(!ipMatchesRule('2001:db8::1', '10.0.0.0/8'))
  assert.ok(!ipMatchesRule('10.0.0.1', '2001:db8::/32'))
  // 前导零歧义（`010` 可能被当八进制）⇒ 直接判非法
  assert.ok(!isIpLiteral('010.1.1.1'))
  assert.ok(isIpLiteral('10.1.1.1'))
})

test('IP 白名单：空列表 = 不限（不是全禁）；有列表时空 IP 直接拒（fail-closed）', () => {
  assert.ok(ipAllowed('1.2.3.4', []))
  assert.ok(ipAllowed('1.2.3.4', ['1.2.3.0/24']))
  assert.ok(!ipAllowed('', ['1.2.3.0/24']))
  assert.ok(!ipAllowed('5.6.7.8', ['1.2.3.0/24']))
})

test('模型白名单：裸名跨供应商生效；空列表 = 全部允许', () => {
  assert.ok(modelAllowed('buddy/glm-5.3-flash', []))
  assert.ok(modelAllowed('buddy/glm-5.3-flash', ['glm-5.3-flash']))
  assert.ok(modelAllowed('buddy/glm-5.3-flash', ['buddy/glm-5.3-flash']))
  assert.ok(!modelAllowed('trae/glm-5.3-flash', ['buddy/glm-5.3-flash']))
})

test('配额窗口：0 小时 = 不重置；窗口过期后重置保留“最后使用”观察值', () => {
  const never = normalizeApiKeyLimits({ windowHours: 0 })
  assert.equal(never.windowHours, 0, '⚠️ 0 是合法值，不能被 `|| 默认` 吃掉')
  const u = { ...emptyApiKeyUsage(), windowStart: 1000, requests: 9, lastAt: 1234, lastIp: '1.1.1.1' }
  assert.ok(!isWindowExpired(u, never, 10_000_000))
  const daily = normalizeApiKeyLimits({ windowHours: 24 })
  assert.ok(isWindowExpired(u, daily, 1000 + 24 * 3600 * 1000))
  const reset = resetUsageWindow(u, 5000)
  assert.equal(reset.requests, 0)
  assert.equal(reset.windowStart, 5000)
  assert.equal(reset.lastIp, '1.1.1.1', '重置窗口不该丢掉诊断用的最后使用信息')
})

test('配额判定：停用/过期/IP/模型/请求数/token 各自给出可读原因', () => {
  const base: ApiKeyRecord = {
    id: 'k1', name: 't', hash: 'h', prefix: 'sk-abc',
    createdAt: 0, lastUsedAt: 0, enabled: true,
    limits: normalizeApiKeyLimits({}),
  }
  const usage = emptyApiKeyUsage()
  const now = 1_000_000
  assert.deepEqual(checkQuota(base, usage, '1.2.3.4', '', now), { ok: true })

  assert.equal(checkQuota({ ...base, enabled: false }, usage, '1.2.3.4', '', now).ok, false)
  const expired = { ...base, limits: normalizeApiKeyLimits({ expiresAt: now - 1 }) }
  assert.equal(checkQuota(expired, usage, '1.2.3.4', '', now).ok, false)
  const ipLimited = { ...base, limits: normalizeApiKeyLimits({ allowedIps: ['9.9.9.9'] }) }
  assert.equal(checkQuota(ipLimited, usage, '1.2.3.4', '', now).ok, false)
  const modelLimited = { ...base, limits: normalizeApiKeyLimits({ models: ['glm-5.3-flash'] }) }
  assert.equal(checkQuota(modelLimited, usage, '1.2.3.4', 'other/model', now).ok, false)
  // ⚠️ `/v1/models` 传空模型串：不该被模型白名单拒掉（否则连目录都拉不到）
  assert.equal(checkQuota(modelLimited, usage, '1.2.3.4', '', now).ok, true)

  const reqLimited = { ...base, limits: normalizeApiKeyLimits({ maxRequests: 2 }) }
  const used = { ...emptyApiKeyUsage(), requests: 2, windowStart: now }
  const verdict = checkQuota(reqLimited, used, '1.2.3.4', '', now)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok ? '' : verdict.reason, 'requests')
})

test('子密钥生成：sk- 前缀、长度、每次不同；视图对象绝不带出 hash', async () => {
  const a = generateApiKey()
  const b = generateApiKey()
  assert.match(a, /^sk-[A-Za-z0-9]{40}$/)
  assert.notEqual(a, b)
  assert.equal(keyPrefix(a).length, 9)
  const h1 = await hashApiKey(a)
  const h2 = await hashApiKey(a)
  assert.equal(h1, h2, '同一明文哈希必须稳定（否则查表永远不命中）')
  assert.notEqual(h1, await hashApiKey(b))
  assert.ok(!h1.includes('+') && !h1.includes('/') && !h1.includes('='), 'base64url 形态')

  const record: ApiKeyRecord = {
    id: 'x', name: 'n', hash: h1, prefix: keyPrefix(a),
    createdAt: 1, lastUsedAt: 2, enabled: true, limits: normalizeApiKeyLimits({}),
  }
  const view = toApiKeyView(record, emptyApiKeyUsage())
  assert.ok(!('hash' in view), '⚠️ 视图绝不能带 hash')
  assert.equal(JSON.stringify(view).includes(h1), false, '⚠️ 序列化后也不得出现 hash')
})
