/**
 * `11129` 工具 JSON Schema 深度规整专项单测。
 *
 * 覆盖：
 * 1. `pattern` 中的 UTF-16 代理区转义 `\uD800`–`\uDFFF` 精准剥离，边界与非 `pattern` 字段原样保留
 *    （参考 `dingminhua/dsh-connect-workbuddy` 提交 `e5d53ef`）；
 * 2. 数据关键字（`default`/`const`/`enum`/`example`/`examples`）与合法 `null` 取值保护，
 *    容器键（`properties`/`dependencies`/`dependentRequired`）下的用户属性名零篡改
 *    （参考 `misakano7545/workbuddy2api-panel` 提交 `615dc75`、`d6301fe`、`501242b`）；
 * 3. 深层 draft-4 与不兼容元 Schema 关键字自愈（布尔开区间、外部 `$ref`、重复 `required`、
 *    `enum` 类型推断、`additionalProperties` / `not` / `if` 等深层子 Schema 递归）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeToolParameters, normalizeTools, prepareChatBody } from '../src/gateway/payload.ts'

type M = Record<string, unknown>

function parametersViaPrepare(parameters: unknown): M {
  const res = prepareChatBody({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'tool', description: 'd', parameters } }],
  })
  const parsed = JSON.parse(res.body) as { tools: Array<{ function: { parameters: M } }> }
  return parsed.tools[0]!.function.parameters
}

function propAfterPrepare(schema: M): M {
  const out = parametersViaPrepare({ type: 'object', properties: { a: schema }, additionalProperties: false })
  return (out.properties as Record<string, M>).a!
}

const SURROGATE_PATTERN = '^[^\\uD800-\\uDFFF]*$'

test('🔴 issue #274（e5d53ef）：剥离 pattern 里的 UTF-16 代理区转义 \\uD800–\\uDFFF（正例）', () => {
  // 1. 单独属性上的代理区正则被剥离，工具与属性本身保留
  assert.deepEqual(propAfterPrepare({ type: 'string', pattern: SURROGATE_PATTERN }), { type: 'string' })

  // 2. REA 真实 allOf 结构：只剥离坏成员里的 pattern 留 {}，其余成员与同级约束原封不动
  const rea = propAfterPrepare({
    type: 'string',
    minLength: 1,
    allOf: [
      { pattern: '^[^\\x00]*$' },
      { pattern: SURROGATE_PATTERN },
      { pattern: '^\\/' },
    ],
  })
  assert.equal(rea.minLength, 1)
  assert.deepEqual(rea.allOf, [{ pattern: '^[^\\x00]*$' }, {}, { pattern: '^\\/' }])

  // 3. 十六进制大小写不敏感（\ud800 / \uDaFf）
  assert.deepEqual(propAfterPrepare({ type: 'string', pattern: '^[^\\ud800-\\udfff]*$' }), { type: 'string' })
  assert.deepEqual(propAfterPrepare({ type: 'string', pattern: '^[^\\uDaFf]*$' }), { type: 'string' })

  // 4. 字符类外的裸代理转义同样剥离
  assert.deepEqual(propAfterPrepare({ type: 'string', pattern: '\\uD800-\\uDFFF' }), { type: 'string' })

  // 5. 顶层与深层 additionalProperties 子 Schema 里的 pattern 同样生效
  const top = parametersViaPrepare({
    type: 'object',
    properties: { a: { type: 'string' } },
    pattern: SURROGATE_PATTERN,
    additionalProperties: { type: 'string', pattern: '\\uDC00' },
  })
  assert.equal(top.pattern, undefined)
  assert.deepEqual(top.additionalProperties, { type: 'string' })
})

test('🔴 issue #274（e5d53ef）：边界 D7FF/E000、普通转义、真 emoji 与非 pattern 关键字原样保留（反例）', () => {
  // 1. 精确边界：D7FF 与 E000 上游 200 接受，严禁误删
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^[^\\uD7FF]*$' }).pattern, '^[^\\uD7FF]*$')
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^[^\\uE000]*$' }).pattern, '^[^\\uE000]*$')

  // 2. BMP 全范围、ASCII 十六进制、普通正则转义与真实 emoji 字符原样保留
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^[^\\u0000-\\uFFFF]*$' }).pattern, '^[^\\u0000-\\uFFFF]*$')
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^[\\u0041-\\u005A]+$' }).pattern, '^[\\u0041-\\u005A]+$')
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^[^\\x00]*$' }).pattern, '^[^\\x00]*$')
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^\\d+$' }).pattern, '^\\d+$')
  assert.equal(propAfterPrepare({ type: 'string', pattern: '^[^😀]*$' }).pattern, '^[^😀]*$')

  // 3. 其他字符串/数据关键字里的同款代理区转义字面量一律不碰
  const other = propAfterPrepare({
    type: 'string',
    description: 'x\\uD800-\\uDFFFy',
    title: 'x\\uD800-\\uDFFFy',
    const: '\\uD800-\\uDFFF',
    enum: ['\\uD800-\\uDFFF'],
    default: '\\uD800-\\uDFFF',
    format: 'x\\uD800-\\uDFFFy',
  })
  assert.equal(other.description, 'x\\uD800-\\uDFFFy')
  assert.equal(other.title, 'x\\uD800-\\uDFFFy')
  assert.equal(other.const, '\\uD800-\\uDFFF')
  assert.deepEqual(other.enum, ['\\uD800-\\uDFFF'])
  assert.equal(other.default, '\\uD800-\\uDFFF')
  assert.equal(other.format, 'x\\uD800-\\uDFFFy')
})

test('🔴 数据关键字（default/const/enum/example/examples）内部对象不按 Schema 篡改，合法 null 取值保留（d6301fe）', () => {
  const params = normalizeToolParameters({
    type: 'object',
    properties: {
      mode: { type: 'object', default: { type: 'str', items: ['a'], required: 'x', note: null } },
      tags: { type: 'array', items: { type: 'string' }, examples: [{ required: [null, ''] }] },
      kind: { const: { type: 'int', pattern: SURROGATE_PATTERN } },
      shape: { enum: [{ type: 'list', items: [1] }] },
      x: { const: null, description: null },
      y: { type: ['string', 'null'], default: null, title: null },
    },
  })
  const props = params.properties as Record<string, M>
  assert.deepEqual(props.mode!.default, { type: 'str', items: ['a'], required: 'x', note: null })
  assert.deepEqual(props.tags!.examples, [{ required: [null, ''] }])
  assert.deepEqual(props.kind!.const, { type: 'int', pattern: SURROGATE_PATTERN })
  assert.deepEqual(props.shape!.enum, [{ type: 'list', items: [1] }])

  // const: null 与 default: null 必须保留；description: null 与 title: null 必须剔除
  assert.equal('const' in props.x!, true)
  assert.equal(props.x!.const, null)
  assert.equal('description' in props.x!, false)

  assert.equal('default' in props.y!, true)
  assert.equal(props.y!.default, null)
  assert.deepEqual(props.y!.type, ['string', 'null'])
  assert.equal('title' in props.y!, false)
})

test('🔴 容器键保护：properties / dependentRequired / dependencies 下名为 pattern/type/required/items/dependencies 的用户属性绝不误改', () => {
  const params = normalizeToolParameters({
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '用户搜索正则参数' },
      type: { type: 'str', description: '资源类型' },
      required: { type: 'boolean', description: '是否必填' },
      items: { type: 'array', items: { type: 'int' } },
      dependencies: { type: 'object', properties: { pkg: { type: 'string' } } },
    },
    dependentRequired: { items: ['type', 'pattern'] },
    dependencies: {
      type: ['items'],
      pattern: { type: 'str', pattern: '\\_foo\\_' },
    },
  })
  const props = params.properties as Record<string, M>
  assert.deepEqual(props.pattern, { type: 'string', description: '用户搜索正则参数' })
  assert.deepEqual(props.type, { type: 'string', description: '资源类型' })
  assert.deepEqual(props.required, { type: 'boolean', description: '是否必填' })
  assert.deepEqual(props.items, { type: 'array', items: { type: 'integer' } })
  assert.deepEqual(props.dependencies, { type: 'object', properties: { pkg: { type: 'string' } } })

  assert.deepEqual(params.dependentRequired, { items: ['type', 'pattern'] })
  const deps = params.dependencies as Record<string, unknown>
  assert.deepEqual(deps.type, ['items'])
  assert.deepEqual(deps.pattern, { type: 'string', pattern: '_foo_' })
})

test('⚠️ 深层 draft-4 与元 Schema 规整：布尔开区间、外部 $ref、重复 required、enum 推断与脏关键字清理', () => {
  const params = normalizeToolParameters({
    type: 'object',
    properties: {
      pos: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false },
      orphanBound: { type: 'number', exclusiveMinimum: true },
      extRef: { $ref: 'https://example.com/schema.json', description: 'keep doc' },
      localRef: { $ref: '#/$defs/Node' },
      status: { enum: ['open', 'closed'] },
      mixedEnum: { enum: ['a', 1] },
      badMeta: { type: 'string', title: 123, minimum: '0', uniqueItems: 'true', allOf: [], not: 'invalid' },
    },
    $defs: {
      Node: { type: 'dict', properties: { v: { type: 'int' } } },
    },
    required: ['pos', 'pos', 'status'],
  })

  const props = params.properties as Record<string, M>
  assert.deepEqual(props.pos, { type: 'number', exclusiveMinimum: 0, maximum: 10 })
  assert.deepEqual(props.orphanBound, { type: 'number' })
  assert.deepEqual(props.extRef, { description: 'keep doc' })
  assert.deepEqual(props.localRef, { $ref: '#/$defs/Node' })
  assert.deepEqual(props.status, { enum: ['open', 'closed'], type: 'string' })
  assert.deepEqual(props.mixedEnum, { enum: ['a', 1] }, '混合标量 enum 不臆猜 type')
  assert.deepEqual(props.badMeta, { type: 'string' })
  assert.deepEqual((params.$defs as Record<string, M>).Node, {
    type: 'object',
    properties: { v: { type: 'integer' } },
  })
  assert.deepEqual(params.required, ['pos', 'status'])

  // 完全合规的复杂 Schema 必须零改动，返回原对象引用
  const cleanTool = {
    type: 'function',
    function: {
      name: 'clean',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', pattern: '^[a-z]+$' },
          nullable: { type: ['string', 'null'], default: null },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  }
  const body: M = { tools: [cleanTool] }
  assert.equal(normalizeTools(body), false)
  assert.equal((body.tools as unknown[])[0], cleanTool)
})
