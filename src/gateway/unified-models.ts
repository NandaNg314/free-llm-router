/**
 * 出口感知「统一模型映射引擎」（对标 `workbuddy2api-hub` `v2.2.3/v2.2.4` PR #28 / #33）。
 *
 * ## 核心职责
 *
 * 1. 将一个对外统一模型名（如 `claude-sonnet`、`coder-pro`）按不同供应商出口映射为各自的真实模型 ID，
 *    使某出口停用或离线时互不串扰；
 * 2. 默认关闭（`enabled: false`），且**空表绝不自动回填示例数据**（PR #33 `7ce90c0` 铁律）；
 * 3. `/v1/models` 仅在该规则至少有一个目标供应商在线可用（且对应目标模型未被手动停用）时才暴露该 alias；
 * 4. 子密钥模型白名单安全兼容：
 *    - 若子密钥 `limits.models` 授权了 `alias` 本身，则该规则下所有在线目标均放行；
 *    - 若子密钥仅授权了其中某一个目标模型（如 `buddy/deepseek-v4.1-flash`），客户端用 `alias` 请求时
 *      准入预检放行，但实际路由候选**严格过滤为已授权目标**，未授权目标（如 `workbuddy/claude-sonnet-4-5`）
 *      绝不绕过越权！
 */

import type { OpenAiModel } from './models.js'
import { AGGREGATE_PROVIDER_ID } from './aggregate.js'
import { DEFAULT_PROVIDER, providerIds } from '../providers/index.js'
import { modelAllowed } from '../store/apikeys.js'

export interface UnifiedModelRule {
  /** 对外统一模型名（规范化为小写），如 `"claude-sonnet"` 或 `"coder-pro"`。 */
  alias: string
  /** `providerId -> realModelId`，对象键顺序即候选出口优先级顺序。 */
  targets: Record<string, string>
  /** 可选备注说明（已清洗控制字符与 HTML 尖括号）。 */
  description?: string
}

export interface UnifiedModelsConfig {
  /** 默认 `false`；关闭时不宣告、不改写任何请求，但配置表仍可读写保存。 */
  enabled: boolean
  /** 规则列表；空表绝不自动回填任何示例数据。 */
  rules: UnifiedModelRule[]
}

export interface ResolvedUnifiedCandidate {
  providerId: string
  modelId: string
  /** 带供应商前缀（并保留请求原有的 `expiring/` 或 `expiringonly/` 前缀）的完整路由模型名。 */
  routedModel: string
  /** 不含 `expiring/` 前缀的标准 `providerId/modelId`，供子密钥白名单与停用模型核对。 */
  canonicalTarget: string
}

export interface ResolveUnifiedOptions {
  /**
   * 受限子密钥的允许模型列表（`ApiKeyLimits.models`；空数组或 `undefined` 表示不限制）。
   *
   * 当子密钥未直接授权 `alias` 本身时，仅保留命中 `modelAllowed(canonicalTarget, allowedModels)` 的目标，
   * 杜绝借统一别名穿透到未授权的高价目标模型。
   */
  allowedModels?: readonly string[]
  /** 各供应商手动停用的模型集合（`providerId -> Set<modelId>`），已停用目标不参与候选。 */
  disabledModels?: ReadonlyMap<string, ReadonlySet<string>>
  /** 可选的外部供应商优先顺序；未提供时严格保持 `rule.targets` 的声明顺序。 */
  providerOrder?: readonly string[]
}

export interface AdvertiseUnifiedOptions {
  /** 当前 `/v1/models` 已构建出的真实模型列表（存在对应目标条目时自动继承上下文窗口与能力元数据）。 */
  existingModels?: ReadonlyArray<OpenAiModel>
  /** 各供应商手动停用的模型集合，目标被停用时不计为可用出口。 */
  disabledModels?: ReadonlyMap<string, ReadonlySet<string>>
  /** 已存在的模型 ID 集合（防重复宣告覆盖真实模型 ID）。 */
  existingIds?: ReadonlySet<string>
}

export const MAX_UNIFIED_MODEL_RULES = 200
export const MAX_UNIFIED_ALIAS_LEN = 128
export const MAX_UNIFIED_TARGET_LEN = 200
export const MAX_UNIFIED_DESCRIPTION_LEN = 240

/** 合法对外统一模型名：仅允许小写字母/数字开头，后接安全标识符字符（禁止 `/`、空白、HTML/XSS 字符）。 */
const SAFE_ALIAS_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/

/** 目标真实模型名禁止出现的危险字符（控制字符、空白、HTML/XSS 元字符）。 */
const UNSAFE_TARGET_CHAR_RE = /[\x00-\x20\x7f<>"'`&\\]/

/** 禁止被统一模型覆盖的保留别名（含虚拟路由、音频专用模型、网页工具伪模型）。 */
const RESERVED_EXACT_ALIASES: ReadonlySet<string> = new Set([
  'auto',
  AGGREGATE_PROVIDER_ID,
  'expiring',
  'expiringonly',
  'wb-search',
  'wb-fetch',
  'wb-search-fetch',
  'hunyuan-tts-2.5',
  'hunyuan-asr',
])

const EXPIRING_STRICT_PREFIX = 'expiringonly/'
const EXPIRING_PREFIX = 'expiring/'

/** 返回全新的默认空配置（绝不回填示例规则）。 */
export function defaultUnifiedModelsConfig(): UnifiedModelsConfig {
  return { enabled: false, rules: [] }
}

/** 拆解模型名前置的 `expiring/` 或 `expiringonly/` 修饰前缀。 */
export function parseExpiringModelPrefix(rawModel: string): {
  prefix: '' | 'expiring/' | 'expiringonly/'
  bareModel: string
  expiringOnly: boolean
  expiringStrict: boolean
} {
  const trimmed = typeof rawModel === 'string' ? rawModel.trim() : ''
  const lower = trimmed.toLowerCase()
  if (lower.startsWith(EXPIRING_STRICT_PREFIX)) {
    return {
      prefix: 'expiringonly/',
      bareModel: trimmed.slice(EXPIRING_STRICT_PREFIX.length).trim(),
      expiringOnly: false,
      expiringStrict: true,
    }
  }
  if (lower.startsWith(EXPIRING_PREFIX)) {
    return {
      prefix: 'expiring/',
      bareModel: trimmed.slice(EXPIRING_PREFIX.length).trim(),
      expiringOnly: true,
      expiringStrict: false,
    }
  }
  return {
    prefix: '',
    bareModel: trimmed,
    expiringOnly: false,
    expiringStrict: false,
  }
}

/** 判断某别名是否命中系统保留名或保留前缀（如 `wb-search`、`wb-*`、已知供应商 ID）。 */
export function isReservedUnifiedAlias(alias: string): boolean {
  const clean = alias.trim().toLowerCase()
  if (clean === '') return true
  if (RESERVED_EXACT_ALIASES.has(clean)) return true
  if (clean.startsWith('wb-')) return true
  const known = providerIds()
  return known.some((p) => p.toLowerCase() === clean)
}

function sanitizeDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // 剥除控制字符与 HTML 尖括号，防止管理端/目录回显发生反射或存储型 XSS
  const cleaned = raw.replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, MAX_UNIFIED_DESCRIPTION_LEN)
  return cleaned === '' ? undefined : cleaned
}

function sanitizeTargetModelId(providerId: string, rawTarget: unknown): string | undefined {
  if (typeof rawTarget !== 'string') return undefined
  let target = rawTarget.trim()
  if (target === '' || target.length > MAX_UNIFIED_TARGET_LEN) return undefined
  if (UNSAFE_TARGET_CHAR_RE.test(target)) return undefined

  // 若用户误把 "buddy/deepseek-v4.1-flash" 填进 buddy 的 target，自动剥除同供应商冗余前缀
  const prefix = `${providerId}/`
  if (target.toLowerCase().startsWith(prefix)) {
    target = target.slice(prefix.length).trim()
  }
  if (target === '' || target.length > MAX_UNIFIED_TARGET_LEN) return undefined
  const lower = target.toLowerCase()
  if (lower.startsWith('wb-') || lower === 'hunyuan-tts-2.5' || lower === 'hunyuan-asr') {
    return undefined
  }
  if (lower.startsWith(EXPIRING_PREFIX) || lower.startsWith(EXPIRING_STRICT_PREFIX) || lower.startsWith(`${AGGREGATE_PROVIDER_ID}/`)) {
    return undefined
  }
  return target
}

function sanitizeSingleRule(
  rawAlias: unknown,
  rawTargets: unknown,
  rawDescription: unknown,
  knownProviders: ReadonlySet<string>,
): UnifiedModelRule | undefined {
  if (typeof rawAlias !== 'string') return undefined
  const alias = rawAlias.trim().toLowerCase()
  if (alias === '' || alias.length > MAX_UNIFIED_ALIAS_LEN) return undefined
  if (!SAFE_ALIAS_RE.test(alias)) return undefined
  if (isReservedUnifiedAlias(alias)) return undefined

  if (rawTargets === null || typeof rawTargets !== 'object' || Array.isArray(rawTargets)) {
    return undefined
  }

  const targets: Record<string, string> = Object.create(null) as Record<string, string>
  let targetCount = 0
  for (const [rawProvider, rawModel] of Object.entries(rawTargets as Record<string, unknown>)) {
    const providerId = rawProvider.trim().toLowerCase()
    if (!knownProviders.has(providerId)) continue
    const cleanModel = sanitizeTargetModelId(providerId, rawModel)
    if (cleanModel === undefined) continue
    targets[providerId] = cleanModel
    targetCount += 1
  }
  if (targetCount === 0) return undefined

  const normalTargets: Record<string, string> = {}
  for (const [k, v] of Object.entries(targets)) {
    normalTargets[k] = v
  }
  const description = sanitizeDescription(rawDescription)
  return {
    alias,
    targets: normalTargets,
    ...(description !== undefined ? { description } : {}),
  }
}

/**
 * 纯函数校验与清洗统一模型配置：
 * - 防 XSS / 非法字符 / 原型污染；
 * - `alias` 转小写并去重；
 * - 禁止覆盖 `wb-search`、`wb-*`、`auto`、`aggregate`、音频模型及供应商名等保留标识；
 * - 过滤未知供应商与空目标，无任何有效目标的规则自动剔除；
 * - **空表绝不自动回填示例数据**。
 */
export function sanitizeUnifiedModelsConfig(raw: unknown): UnifiedModelsConfig {
  if (raw === null || typeof raw !== 'object') {
    return defaultUnifiedModelsConfig()
  }

  const knownProviders = new Set(providerIds().map((p) => p.toLowerCase()))
  let enabled = false
  let rawRulesSource: unknown = []

  if (Array.isArray(raw)) {
    rawRulesSource = raw
  } else {
    const obj = raw as Record<string, unknown>
    enabled = obj.enabled === true
    rawRulesSource = obj.rules
  }

  const rules: UnifiedModelRule[] = []
  const seenAliases = new Set<string>()

  if (Array.isArray(rawRulesSource)) {
    for (const item of rawRulesSource) {
      if (rules.length >= MAX_UNIFIED_MODEL_RULES) break
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const r = item as Record<string, unknown>
      const cleaned = sanitizeSingleRule(r.alias, r.targets, r.description, knownProviders)
      if (cleaned === undefined || seenAliases.has(cleaned.alias)) continue
      seenAliases.add(cleaned.alias)
      rules.push(cleaned)
    }
  } else if (rawRulesSource !== null && typeof rawRulesSource === 'object') {
    // 兼容字典形态 `{ [alias]: { [providerId]: realModelId } }`
    for (const [aliasKey, targetMap] of Object.entries(rawRulesSource as Record<string, unknown>)) {
      if (rules.length >= MAX_UNIFIED_MODEL_RULES) break
      const cleaned = sanitizeSingleRule(aliasKey, targetMap, undefined, knownProviders)
      if (cleaned === undefined || seenAliases.has(cleaned.alias)) continue
      seenAliases.add(cleaned.alias)
      rules.push(cleaned)
    }
  }

  return { enabled, rules }
}

/**
 * 查找请求模型名对应的统一模型规则（仅在 `config.enabled === true` 且请求为裸名或 `expiring/` 裸名时命中）。
 *
 * 显式携带 `provider/model`（如 `buddy/claude-sonnet`）的请求代表调用方已指定渠道，不做统一别名拦截。
 */
export function findUnifiedModelRule(
  requestedModel: unknown,
  config: UnifiedModelsConfig | undefined,
): UnifiedModelRule | undefined {
  if (typeof requestedModel !== 'string' || config?.enabled !== true || !Array.isArray(config.rules)) {
    return undefined
  }
  const { bareModel } = parseExpiringModelPrefix(requestedModel)
  if (bareModel === '' || bareModel.includes('/')) return undefined
  const lower = bareModel.toLowerCase()
  return config.rules.find((r) => r.alias.toLowerCase() === lower)
}

function isTargetModelDisabled(
  providerId: string,
  modelId: string,
  disabledModels?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (disabledModels === undefined) return false
  const set = disabledModels.get(providerId)
  if (set === undefined || set.size === 0) return false
  if (set.has(modelId)) return true
  const lower = modelId.toLowerCase()
  for (const item of set) {
    if (item.toLowerCase() === lower) return true
  }
  return false
}

/**
 * 按当前在线可用供应商集合解析统一模型别名，返回按优先级排列的候选列表。
 *
 * - `config.enabled !== true`、未命中规则、或显式带 `provider/` 前缀时返回 `[]`；
 * - 若传入 `availableProviders`，仅返回在线可用的目标供应商；
 * - 若传入 `options.allowedModels`（受限子密钥模型白名单），当白名单未直接授权 `alias` 本身时，
 *   自动剔除未获该子密钥授权的目标模型，确保绝不发生跨渠道越权穿透。
 */
export function resolveUnifiedModel(
  requestedModel: string,
  config: UnifiedModelsConfig | undefined,
  availableProviders?: Iterable<string>,
  options?: ResolveUnifiedOptions,
): ResolvedUnifiedCandidate[] {
  const rule = findUnifiedModelRule(requestedModel, config)
  if (rule === undefined) return []

  const { prefix } = parseExpiringModelPrefix(requestedModel)
  const availableSet =
    availableProviders === undefined
      ? undefined
      : new Set(Array.from(availableProviders, (p) => p.trim().toLowerCase()))

  const allowedModels = options?.allowedModels !== undefined ? [...options.allowedModels] : []
  const aliasDirectlyAllowed =
    allowedModels.length === 0 || modelAllowed(rule.alias, allowedModels)

  let entries = Object.entries(rule.targets)
  if (options?.providerOrder !== undefined && options.providerOrder.length > 0) {
    const rank = new Map<string, number>()
    options.providerOrder.forEach((p, idx) => {
      rank.set(p.trim().toLowerCase(), idx)
    })
    entries = [...entries].sort((a, b) => {
      const ra = rank.get(a[0].toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b[0].toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      return ra - rb
    })
  }

  const out: ResolvedUnifiedCandidate[] = []
  for (const [rawProvider, rawModelId] of entries) {
    const providerId = rawProvider.trim().toLowerCase()
    const modelId = rawModelId.trim()
    if (providerId === '' || modelId === '') continue
    if (availableSet !== undefined && !availableSet.has(providerId)) continue
    if (isTargetModelDisabled(providerId, modelId, options?.disabledModels)) continue

    const canonicalTarget = `${providerId}/${modelId}`
    if (!aliasDirectlyAllowed && !modelAllowed(canonicalTarget, allowedModels)) {
      continue
    }

    out.push({
      providerId,
      modelId,
      routedModel: `${prefix}${canonicalTarget}`,
      canonicalTarget,
    })
  }
  return out
}

/**
 * 解析统一模型首选真实路由目标（如 `"buddy/deepseek-v4.1-flash"`）；未命中或无可用出口时返回 `undefined`。
 */
export function resolveUnifiedPrimaryModel(
  requestedModel: string,
  config: UnifiedModelsConfig | undefined,
  availableProviders?: Iterable<string>,
  options?: ResolveUnifiedOptions,
): string | undefined {
  return resolveUnifiedModel(requestedModel, config, availableProviders, options)[0]?.routedModel
}

/**
 * 展开子密钥模型白名单准入候选集合：
 * - 始终包含客户端请求的原始模型名（及剥除 `expiring/` / `expiringonly/` 后的模型名）；
 * - 当 `config.enabled === true` 且请求命中某条统一模型 `alias` 时，追加其配置的目标 `${providerId}/${modelId}`。
 *
 * 这样当客户端以 `alias` 请求时：
 * - 子密钥白名单配置了 `alias` ⇒ 命中首项放行；
 * - 子密钥白名单配置了某目标模型（如 `buddy/deepseek-v4.1-flash` 或裸名 `deepseek-v4.1-flash`）⇒ 命中目标项放行
 *   （随后在 `resolveUnifiedModel(..., { allowedModels })` 中仅保留该授权目标，未授权目标绝不绕过！）；
 * - 子密钥白名单既未配置 `alias` 也未配置任何目标模型 ⇒ 全部不命中，403 拒绝！
 */
export function expandUnifiedModelCandidates(
  requestedModel: string,
  config: UnifiedModelsConfig | undefined,
): string[] {
  const trimmed = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  if (trimmed === '') return []

  const { bareModel } = parseExpiringModelPrefix(trimmed)
  const out: string[] = []
  const pushUnique = (v: string): void => {
    if (v !== '' && !out.includes(v)) out.push(v)
  }

  pushUnique(trimmed)
  pushUnique(bareModel)

  const rule = findUnifiedModelRule(trimmed, config)
  if (rule !== undefined) {
    pushUnique(rule.alias)
    for (const [providerId, modelId] of Object.entries(rule.targets)) {
      const p = providerId.trim().toLowerCase()
      const m = modelId.trim()
      if (p !== '' && m !== '') {
        pushUnique(`${p}/${m}`)
      }
    }
  }
  return out
}

/**
 * 判定一把受限子密钥（`allowedModels = limits.models`）是否有权发起本次模型请求。
 */
export function isSubkeyModelAllowedWithUnified(
  requestedModel: string,
  allowedModels: readonly string[],
  config: UnifiedModelsConfig | undefined,
): boolean {
  if (allowedModels.length === 0) return true
  const ruleList = [...allowedModels]
  const candidates = expandUnifiedModelCandidates(requestedModel, config)
  if (candidates.length === 0) return false
  return candidates.some((candidate) => modelAllowed(candidate, ruleList))
}

/**
 * 生成 `/v1/models` 的统一模型宣告条目：
 * **仅当该规则至少有一个目标供应商当前在线可用（且该目标模型未被手动停用）时，才在 `/v1/models` 暴露该 alias！**
 */
export function buildUnifiedModelEntries(
  config: UnifiedModelsConfig | undefined,
  availableProviders: Iterable<string>,
  options?: AdvertiseUnifiedOptions,
): OpenAiModel[] {
  if (config?.enabled !== true || !Array.isArray(config.rules) || config.rules.length === 0) {
    return []
  }

  const availableSet = new Set(Array.from(availableProviders, (p) => p.trim().toLowerCase()))
  if (availableSet.size === 0) return []

  const byId = new Map<string, OpenAiModel>()
  if (options?.existingModels !== undefined) {
    for (const m of options.existingModels) {
      if (typeof m.id === 'string' && m.id !== '') {
        byId.set(m.id.toLowerCase(), m)
      }
    }
  }

  const seenIds = new Set<string>()
  if (options?.existingIds !== undefined) {
    for (const id of options.existingIds) seenIds.add(id.toLowerCase())
  }
  for (const id of byId.keys()) seenIds.add(id)

  const entries: OpenAiModel[] = []
  for (const rule of config.rules) {
    const aliasLower = rule.alias.toLowerCase()
    if (seenIds.has(aliasLower)) continue

    const activeTargets = resolveUnifiedModel(rule.alias, config, availableSet, {
      disabledModels: options?.disabledModels,
    })
    if (activeTargets.length === 0) continue

    const primary = activeTargets[0]!
    const sourceEntry =
      byId.get(primary.canonicalTarget.toLowerCase()) ??
      (primary.providerId === DEFAULT_PROVIDER ? byId.get(primary.modelId.toLowerCase()) : undefined)

    const item: OpenAiModel = {
      ...(sourceEntry ?? {}),
      id: rule.alias,
      object: 'model',
      created: sourceEntry?.created ?? 0,
      owned_by: 'unified',
      name: rule.description !== undefined && rule.description !== '' ? `${rule.alias} (${rule.description})` : rule.alias,
    }
    entries.push(item)
    seenIds.add(aliasLower)
  }

  return entries
}
