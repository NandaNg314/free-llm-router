import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from './api'
import { fmtInt } from './utils'
import type { Account, AccountPin, ApiKey, ApiKeyLimits, LogEntry, PinMode, PoolCounts, Provider, Realm, Usage, UsageRow } from './types'

// 账号按凭据 realm 分片：WorkBuddy 国际版在 global，其余在 cn —— 两边都要查再合并
const REALMS: Realm[] = ['cn', 'global']

/** 按面板保存的顺序排列；没排过的家按注册表原顺序跟在后面（只影响展示，不影响默认供应商）。 */
export function sortByOrder<T extends { id: string }>(list: T[], order: string[] = []): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return list
    .map((p, i) => ({ p, k: rank.get(p.id) ?? order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p)
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: async () => {
      const r = await api<{
        default: string
        providers: Provider[]
        order?: string[]
        disabled?: string[]
      }>('/admin/providers')
      return { ...r, providers: sortByOrder(r.providers, r.order) }
    },
    staleTime: 5 * 60_000,
  })
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const out: Account[] = []
      for (const realm of REALMS) {
        const r = await api<{ accounts: Omit<Account, 'realm'>[] }>(`/admin/accounts?realm=${realm}`)
        for (const a of r.accounts) out.push({ ...a, realm })
      }
      return out
    },
  })
}

export function usePool() {
  return useQuery({
    queryKey: ['pool'],
    queryFn: async () => {
      const sum: PoolCounts = {
        total: 0,
        healthy: 0,
        disabled: 0,
        cooling: 0,
        modelExempt: 0,
      }
      for (const realm of REALMS) {
        const r = await api<{ counts: PoolCounts }>(`/admin/pool?realm=${realm}`)
        for (const k of Object.keys(sum) as (keyof PoolCounts)[]) sum[k] += r.counts[k] ?? 0
      }
      return sum
    },
  })
}

function mergeRows<K extends string>(key: K, lists: (UsageRow & Record<K, string>)[][]) {
  const map = new Map<string, UsageRow & Record<K, string>>()
  for (const list of lists)
    for (const r of list) {
      const hit = map.get(r[key])
      if (!hit) map.set(r[key], { ...r })
      else {
        hit.count += r.count
        hit.failed += r.failed
        hit.input += r.input
        hit.output += r.output
      }
    }
  return [...map.values()]
}

export function useUsage(days: number) {
  return useQuery({
    queryKey: ['usage', days],
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Usage> => {
      const parts: Usage[] = []
      for (const realm of REALMS) parts.push(await api<Usage>(`/admin/usage?realm=${realm}&days=${days}`))
      const total = parts.reduce((s, p) => s + p.total, 0)
      return {
        total,
        ok: parts.reduce((s, p) => s + p.ok, 0),
        failed: parts.reduce((s, p) => s + p.failed, 0),
        inputTokens: parts.reduce((s, p) => s + p.inputTokens, 0),
        outputTokens: parts.reduce((s, p) => s + p.outputTokens, 0),
        avgMs: total ? parts.reduce((s, p) => s + p.avgMs * p.total, 0) / total : 0,
        byHour: mergeRows(
          'hour',
          parts.map((p) => p.byHour ?? []),
        ).sort((a, b) => a.hour.localeCompare(b.hour)),
        byDay: mergeRows(
          'day',
          parts.map((p) => p.byDay ?? []),
        ).sort((a, b) => a.day.localeCompare(b.day)),
        byModel: mergeRows(
          'model',
          parts.map((p) => p.byModel ?? []),
        ).sort((a, b) => b.count - a.count),
        byAccount: mergeRows(
          'uid',
          parts.map((p) => p.byAccount ?? []),
        ).sort((a, b) => b.count - a.count),
        activeDays: Math.max(...parts.map((p) => p.activeDays ?? 0)),
        detailCount: parts.reduce((s, p) => s + (p.detailCount ?? 0), 0),
        detailCapped: parts.some((p) => p.detailCapped),
      }
    },
  })
}

export function useApiKeys() {
  return useQuery({
    queryKey: ['apikeys'],
    queryFn: () => api<{ keys: ApiKey[] }>('/admin/apikeys').then((r) => r.keys),
  })
}

/** 日志按分片写（国际版在 global），两边都读再按时间合并。 */
export function useLogs() {
  return useQuery({
    queryKey: ['logs'],
    queryFn: async () => {
      const all: LogEntry[] = []
      for (const realm of REALMS) all.push(...(await api<{ logs: LogEntry[] }>(`/admin/logs?realm=${realm}&limit=200`)).logs)
      return all.sort((x, y) => y.time - x.time).slice(0, 300)
    },
  })
}

export const useClearLogs = () =>
  useAction(
    async () => {
      for (const realm of REALMS) await api('/admin/logs/clear', { json: { realm } })
    },
    ['logs'],
    '日志已清空',
  )

/** 写操作：成功后刷新相关查询并 toast，失败 toast 出上游原因。 */
function useAction<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: string[], ok?: string) {
  const qc = useQueryClient()
  return useMutation<R, Error, V>({
    mutationFn: fn,
    onSuccess: () => {
      for (const k of invalidate) qc.invalidateQueries({ queryKey: [k] })
      if (ok) toast.success(ok)
    },
    onError: (e) => toast.error('操作失败', { description: e.message }),
  })
}

export const useToggleAccount = () =>
  useAction(
    (a: Pick<Account, 'uid' | 'realm' | 'disabled'>) =>
      api('/admin/accounts/toggle', {
        json: { uid: a.uid, realm: a.realm, disabled: !a.disabled },
      }),
    ['accounts', 'pool'],
    '账号状态已更新',
  )

export const useRemoveAccount = () =>
  useAction(
    (a: Pick<Account, 'uid' | 'realm'>) =>
      api('/admin/accounts/remove', {
        json: { uid: a.uid, realm: a.realm, confirm: true },
      }),
    // 删除账号会连带清掉指向它的指定
    ['accounts', 'pool', 'pins'],
    '账号已删除',
  )

export const useImportAccount = () => useAction((payload: unknown) => api('/admin/import', { json: payload }), ['accounts', 'pool'], '账号已导入')

export const useCreateApiKey = () =>
  useAction((v: { name: string; limits: ApiKeyLimits }) => api<{ key: string }>('/admin/apikeys', { json: v }), ['apikeys'])

export const useToggleApiKey = () =>
  useAction((k: ApiKey) => api('/admin/apikeys/update', { json: { id: k.id, enabled: !k.enabled } }), ['apikeys'], '已更新')

export const useRemoveApiKey = () => useAction((k: ApiKey) => api('/admin/apikeys/remove', { json: { id: k.id } }), ['apikeys'], '密钥已删除')
// ── 指定账号 ──

export function usePins() {
  return useQuery({
    queryKey: ['pins'],
    queryFn: () => api<{ pins: AccountPin[] }>('/admin/pins').then((r) => r.pins),
  })
}

/** 账号当前的指定模式（未被指定时为 undefined）。 */
export function pinModeOf(a: Pick<Account, 'uid' | 'realm' | 'provider'>, pins: AccountPin[] | undefined): PinMode | undefined {
  return pins?.find((p) => p.realm === a.realm && p.provider === a.provider && p.uid === a.uid)?.mode
}

/** 指定（mode）或取消指定（mode = null）。 */
export function useSetPin() {
  const qc = useQueryClient()
  return useMutation<
    unknown,
    Error,
    {
      account: Pick<Account, 'uid' | 'realm' | 'provider' | 'nickname'>
      mode: PinMode | null
      providerName: string
      warn?: string
    }
  >({
    mutationFn: ({ account: a, mode }) =>
      api('/admin/pins', {
        json: mode === null ? { realm: a.realm, provider: a.provider, uid: '' } : { realm: a.realm, uid: a.uid, mode },
      }),
    onSuccess: (_r, { account: a, mode, providerName, warn }) => {
      qc.invalidateQueries({ queryKey: ['pins'] })
      const who = a.nickname || a.uid
      if (mode === null) toast.success(`已取消指定，${providerName} 恢复自动选号`)
      else if (mode === 'only')
        toast[warn ? 'warning' : 'success'](`${providerName} 的请求只用「${who}」`, {
          description: warn ?? '它不可用时请求会直接报错，不会换号。',
        })
      else
        toast.success(`${providerName} 优先用「${who}」`, {
          description: '它不可用时自动换到其他账号。',
        })
    },
    onError: (e) => toast.error('操作失败', { description: e.message }),
  })
}

// ── 账号余额刷新 ──

export function useRefreshBalance() {
  const qc = useQueryClient()
  return useMutation<
    {
      refreshed: number
      results: { uid: string; ok: boolean; credits?: number; error?: string }[]
    },
    Error,
    Pick<Account, 'uid' | 'realm' | 'nickname'>
  >({
    mutationFn: (a) =>
      api('/admin/accounts/balance', {
        json: { realm: a.realm, uid: a.uid },
        timeoutMs: 60_000,
      }),
    onSuccess: (r, a) => {
      qc.invalidateQueries({ queryKey: ['accounts'] })
      const hit = r.results.find((x) => x.uid === a.uid)
      if (hit?.ok)
        toast.success(`「${a.nickname || a.uid}」余额已刷新`, {
          description: `当前 ${fmtInt(hit.credits ?? 0)} 积分`,
        })
      else
        toast.error('余额刷新失败', {
          description: hit?.error ?? '没有返回结果',
        })
    },
    onError: (e) => toast.error('余额刷新失败', { description: e.message }),
  })
}

// ── 供应商模型开关 ──

export interface ProviderModelRow {
  id: string
  name?: string
  disabled: boolean
}

export function useProviderModels(provider: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['provider-models', provider],
    enabled: !!provider && enabled,
    retry: false,
    queryFn: () =>
      api<{
        models: ProviderModelRow[]
        disabledCount?: number
        note?: string
      }>(`/admin/providers/models?provider=${encodeURIComponent(provider!)}`, {
        timeoutMs: 60_000,
      }),
  })
}

export function useToggleProviderModels() {
  const qc = useQueryClient()
  return useMutation<unknown, Error, { provider: string; models: string[]; enabled: boolean }>({
    mutationFn: ({ provider, models, enabled }) =>
      models.length === 1
        ? api('/admin/providers/models/toggle', {
            json: { provider, model: models[0], enabled },
          })
        : api('/admin/providers/models/bulk', {
            json: { provider, models, enabled },
          }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['provider-models', v.provider] })
      qc.invalidateQueries({ queryKey: ['models'] })
      if (v.models.length > 1) toast.success(`已${v.enabled ? '开启' : '关闭'} ${v.models.length} 个模型`)
    },
    onError: (e) => toast.error('操作失败', { description: e.message }),
  })
}

export const useUpdateApiKey = () =>
  useAction((v: { id: string; name: string; limits: ApiKeyLimits }) => api('/admin/apikeys/update', { json: v }), ['apikeys'], '密钥设置已保存')

export const useResetApiKey = () => useAction((k: ApiKey) => api<{ key: string }>('/admin/apikeys/reset', { json: { id: k.id } }), ['apikeys'])

export const useResetApiKeyUsage = () =>
  useAction((k: ApiKey) => api('/admin/apikeys/reset-usage', { json: { id: k.id } }), ['apikeys'], '窗口用量已清零')

// ── 媒体能力（生图 / 联网检索 / 抓网页） ──
//
// ⚠️ 这三个能力**只有国际版账号支持**（实测国内分片 401）。
// 服务端已做默认 realm 解析（没给 ?realm= 时自动选 global），
// 前端**不需要**拼参数 —— 拼了反而会在没有国际账号的部署上写死错误值。

export interface GeneratedImage {
  url: string
  size?: string
}

export function useGenerateImage() {
  return useMutation<{ created: number; data: GeneratedImage[]; usage?: { credit?: number } }, Error, { prompt: string; size?: string; model?: string }>({
    mutationFn: (v) =>
      api('/v1/images/generations', {
        json: v,
        // ⚠️ 上游出图实测 10~15 秒，默认 30 秒够，但给到 120 秒避免慢时有假超时
        timeoutMs: 120_000,
      }),
    onError: (e) => toast.error('生成失败', { description: e.message }),
  })
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
  date?: string
}

export function useWebSearch() {
  return useMutation<{ query: string; results: SearchHit[]; total_results?: number }, Error, { query: string }>({
    mutationFn: (v) => api('/v1/search', { json: { query: v.query, max_results: 6 }, timeoutMs: 90_000 }),
    onError: (e) => toast.error('搜索失败', { description: e.message }),
  })
}

export function useWebFetch() {
  return useMutation<{ url: string; title: string; content: string }, Error, { url: string }>({
    mutationFn: (v) => api('/v1/fetch', { json: v, timeoutMs: 90_000 }),
    onError: (e) => toast.error('抓取失败', { description: e.message }),
  })
}

/** 把本地图片文件读成 `data:` URL（上游要求 data URL 或公网 URL）。 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取图片失败'))
    r.readAsDataURL(file)
  })
}

/** 图生图（`/v1/images/edits`）。 */
export function useEditImage() {
  return useMutation<
    { created: number; data: GeneratedImage[]; usage?: { credit?: number } },
    Error,
    { prompt: string; image: string[]; size?: string; model?: string }
  >({
    mutationFn: (v) => api('/v1/images/edits', { json: v, timeoutMs: 180_000 }),
    onError: (e) => toast.error('生成失败', { description: e.message }),
  })
}

// ── 视频（异步：提交 → 轮询） ──

export interface VideoTask {
  id: string
  status: string
  data?: Array<{ url: string }>
  seconds?: number
  usage?: { credit?: number }
  error?: { message: string }
  hint?: string
}

export function useSubmitVideo() {
  return useMutation<{ id: string; status: string; hint?: string }, Error, { prompt: string; seconds?: number; aspect_ratio?: string; image?: string; model?: string }>({
    mutationFn: (v) => api('/v1/videos/generations', { json: v, timeoutMs: 120_000 }),
    onError: (e) => toast.error('提交失败', { description: e.message }),
  })
}

/** 查视频任务（**POST**，不是 GET —— 上游那样写会 404）。 */
export const checkVideoTask = (taskId: string) =>
  api<VideoTask>('/v1/videos/tasks', { json: { task_id: taskId }, timeoutMs: 60_000 })

/** 媒体直链的**同源代理**（跨域资源浏览器不让 download，必须走它）。 */
export function mediaProxyUrl(url: string): string {
  return `/admin/media/proxy?url=${encodeURIComponent(url)}`
}
