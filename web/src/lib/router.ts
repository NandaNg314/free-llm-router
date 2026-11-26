import { useEffect, useState } from 'react'

export type View = 'providers' | 'usage' | 'logs' | 'playground' | 'media' | 'tasks' | 'apikeys' | 'models' | 'config'
export const VIEWS: View[] = ['providers', 'usage', 'logs', 'playground', 'media', 'tasks', 'apikeys', 'models', 'config']

function parseHash(raw = location.hash): { view: View; params: URLSearchParams } {
  const clean = raw.replace(/^#\/?/, '')
  const qIdx = clean.indexOf('?')
  const pathPart = (qIdx >= 0 ? clean.slice(0, qIdx) : clean).replace(/\/+$/, '')
  const queryPart = qIdx >= 0 ? clean.slice(qIdx + 1) : ''
  const v = pathPart as View
  return {
    view: VIEWS.includes(v) ? v : 'providers',
    params: new URLSearchParams(queryPart),
  }
}

/** 极简 hash 路由：支持 `#/usage` 与带参数的 `#/playground?model=aggregate/auto`。 */
export function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => parseHash().view)
  useEffect(() => {
    const on = () => setView(parseHash().view)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [view, (v) => (location.hash = '/' + v)]
}

/** 响应式读取当前 hash 查询参数（如 `useHashParam('model')`）。 */
export function useHashParam(name: string): string {
  const [value, setValue] = useState(() => parseHash().params.get(name) ?? '')
  useEffect(() => {
    const on = () => setValue(parseHash().params.get(name) ?? '')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [name])
  return value
}

/** 跨页跳转（例如任务中心 → 配置）。 */
export function navigate(v: View): void {
  location.hash = '/' + v
  window.scrollTo({ top: 0 })
}

/** 跳转到「对话试炼场」，可选预选目标模型 ID。 */
export function navigateToPlayground(modelId?: string): void {
  const trimmed = modelId?.trim()
  location.hash = trimmed ? `/playground?model=${encodeURIComponent(trimmed)}` : '/playground'
  window.scrollTo({ top: 0 })
}
