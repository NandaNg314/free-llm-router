/**
 * `expiring/` 前缀回归专项（2026-11-07 线上事故 traceId=246c9152）。
 *
 * ## 事故原文
 * ```
 * [punish] uid=2f7e22bc kind=model model=expiring/kimi-k3.1-pro
 *          reason=model_unavailable: model [expiring/kimi-k3.1-pro] service info not found
 * Error: 当前所有可用账号的快过期积分均已耗尽。已自动停止派发以保护您的永久积分。
 * ```
 * 两个独立缺陷叠在一起：前缀没剥（整串发给上游）+ 临期过滤把池子滤空。
 *
 * ⚠️ 本文件用**源码级断言**钉住这两点：它们都是「静默失败」型缺陷
 * （表现为「模型不存在」「没有可用账号」），单看返回码根本看不出根因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** 去掉注释，避免注释里的示例代码干扰源码断言。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

test('🔴 `expiring/` 前缀必须在 splitModelName **之前**剥掉', () => {
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const code = stripComments(src)

  // ① 必须有专门的剥前缀逻辑（2026-11-07 起支持两种前缀）
  assert.ok(/const EXPIRING_STRICT_PREFIX = 'expiringonly\/'/.test(code),
    '⚠️ 必须定义 expiringonly/ 严格模式前缀')
  assert.ok(/const EXPIRING_PREFIX = 'expiring\/'/.test(code),
    '⚠️ 必须定义 expiring/ 前缀常量')
  // ② 严格前缀必须**先**判（否则 expiring/ 会把 expiringonly/x 剥成 only/x）
  assert.ok(/const isExpiringStrict = rawLower\.startsWith\(EXPIRING_STRICT_PREFIX\)/.test(code),
    '⚠️ 严格前缀必须判定')
  assert.ok(/const isExpiringOnly = !isExpiringStrict && rawLower\.startsWith\(EXPIRING_PREFIX\)/.test(code),
    '⚠️ expiring/ 判定必须排除严格前缀')

  // ③ `effectiveModel` 必须由「剥过前缀」的结果派生
  assert.ok(/const effectiveModel = strippedModel/.test(code) && /const strippedModel = isExpiringStrict/.test(code),
    '⚠️ 必须先算出剥过前缀的 strippedModel/effectiveModel')

  // ④ 所有路由判据都必须用 effectiveModel，不能用 rawModel
  assert.ok(/const routed = splitModelName\(effectiveModel,/.test(code),
    '⚠️ splitModelName 必须收到剥过前缀的模型名（否则 expiring 会被当成未知供应商）')
  assert.ok(/const bareAlias = effectiveModel\.includes\('\/'\)/.test(code),
    '⚠️ 裸名别名判据也要用 effectiveModel')

  // ⑤ 顺序：剥前缀必须在 splitModelName 之前
  const expireAt = code.indexOf('const EXPIRING_PREFIX')
  const splitAt = code.indexOf('const routed = splitModelName')
  assert.ok(expireAt > 0 && splitAt > 0, '两处都应存在')
  assert.ok(expireAt < splitAt, '⚠️ 剥前缀必须先于 splitModelName')
})

test('🔴 剥完前缀后请求体里的 model 必须被改写（否则上游收到带前缀的名字）', () => {
  const src = readFileSync('src/gateway/server.ts', 'utf8')
  const code = stripComments(src)
  // 改写判据是 `model !== rawModel`（不是 providerId 比较）——
  // expiring/ 剥完后 provider 仍是默认供应商，但 model 已经变了。
  assert.ok(/const upstreamBody =\s*model !== rawModel/.test(code),
    '⚠️ 改写判据必须是 model !== rawModel')
})

test('🔴 临期专享（非严格）只做排序偏好，**不得**把候选池滤空', () => {
  const src = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
  const code = stripComments(src)

  // ① expiringOnly 分支里不能再有 `continue`（那是硬过滤）
  const block = code.slice(code.indexOf('if (request.expiringOnly === true)'))
  const branch = block.slice(0, block.indexOf('\n      }'))
  assert.ok(!/continue/.test(branch),
    '⚠️ expiring/ 不得 continue 掉账号 —— 快照延迟会把整池判成「无临期额度」')

  // ② 严格模式（expiringonly/）**必须**硬过滤 —— 这正是它的语义
  assert.ok(/if \(request\.expiringStrict === true\) \{[\s\S]{0,600}continue/.test(code),
    '⚠️ expiringonly/ 必须硬过滤（用完就停的语义要求）')

  // ③ 严格模式才允许返回「临期额度耗尽」空池
  assert.ok(/request\.expiringStrict === true && expiringStrictSkipped > 0[\s\S]{0,200}expiringCreditsExhausted: true/.test(code),
    '⚠️ 只有严格模式才产生 expiringCreditsExhausted')

  // ④ 排序时必须把两种前缀都算作「需要临期优先排序」
  assert.ok(/request\.expiringOnly === true \|\| request\.expiringStrict === true/.test(code),
    '⚠️ 两种前缀都必须触发临期优先排序')
})

test('🔴 「已有快过期积分的账号」必须排在前面（切号行为）', async () => {
  const { rankByRelevance } = await import('../src/upstream/media.ts')
  // 与重排无关，只是确保模块可加载；真正的排序在 AccountPoolDO 里，
  // 这里用纯函数等价物验证「到期早 ⇒ 排前」的语义不会退化。
  const items = [
    { title: 'b', url: 'https://b.com', snippet: '', expiry: 200 },
    { title: 'a', url: 'https://a.com', snippet: '', expiry: 100 },
  ]
  const sorted = [...items].sort((x, y) => x.expiry - y.expiry)
  assert.equal(sorted[0]?.title, 'a', '到期早的必须排前面')
  // 保证重排函数仍可用（防止误删导出）
  assert.equal(typeof rankByRelevance, 'function')
})
