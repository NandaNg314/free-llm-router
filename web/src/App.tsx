import { useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { NAV_ITEMS } from '@/components/layout/nav'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { Sheet } from '@/components/ui/dialog'
import { auth } from '@/lib/api'
import { useView, type View } from '@/lib/router'
import { useTheme } from '@/lib/theme'
import { ApiKeysPage } from '@/pages/ApiKeysPage'
import { LoginPage } from '@/pages/LoginPage'
import { LogsPage } from '@/pages/LogsPage'
import { ProvidersPage } from '@/pages/providers/ProvidersPage'
// 按需分包加载组件与页面（确保 models 模块不打入主包）
const CommandPalette = lazy(() => import('@/components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const UsagePage = lazy(() => import('@/pages/UsagePage').then((m) => ({ default: m.UsagePage })))
const TasksPage = lazy(() => import('@/pages/TasksPage').then((m) => ({ default: m.TasksPage })))
const ModelsPage = lazy(() => import('@/pages/ModelsPage').then((m) => ({ default: m.ModelsPage })))
const ConfigPage = lazy(() => import('@/pages/ConfigPage').then((m) => ({ default: m.ConfigPage })))
const MediaPage = lazy(() => import('@/pages/MediaPage').then((m) => ({ default: m.MediaPage })))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage').then((m) => ({ default: m.PlaygroundPage })))

export function App() {
  const [authed, setAuthed] = useState(() => !!auth.get())
  const { resolved } = useTheme()
  const qc = useQueryClient()

  useEffect(() => {
    const on = () => {
      auth.clear()
      qc.clear()
      setAuthed(false)
    }
    window.addEventListener('auth:expired', on)
    return () => window.removeEventListener('auth:expired', on)
  }, [qc])

  const logout = () => {
    auth.clear()
    qc.clear()
    setAuthed(false)
  }

  return (
    <>
      {authed ? <Shell onLogout={logout} /> : <LoginPage onLogin={() => setAuthed(true)} />}
      <Toaster theme={resolved} position="bottom-right" richColors closeButton />
    </>
  )
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useView()
  const [navOpen, setNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const item = NAV_ITEMS.find((i) => i.view === view) ?? NAV_ITEMS[0]!

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const go = (v: View) => {
    setView(v)
    setNavOpen(false)
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="min-h-dvh w-full lg:pl-60">
      <aside className="bg-sidebar fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-black/[0.06] lg:block dark:border-white/[0.07]">
        <Sidebar view={view} onNavigate={go} onLogout={onLogout} />
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen} title="导航" side="left" className="bg-sidebar">
        <Sidebar view={view} onNavigate={go} onLogout={onLogout} />
      </Sheet>

      <Suspense fallback={null}>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} currentView={view} onNavigate={go} />
      </Suspense>

      <Topbar item={item} onOpenNav={() => setNavOpen(true)} onOpenCommandPalette={() => setPaletteOpen(true)} />
      <main key={view} className="view-transition mx-auto min-w-0 max-w-[1400px] px-4 py-6 lg:px-8 lg:py-8">
        {view === 'providers' && <ProvidersPage />}
        {view === 'apikeys' && <ApiKeysPage />}
        {view === 'logs' && <LogsPage />}
        <Suspense fallback={null}>
          {view === 'playground' && <PlaygroundPage />}
          {view === 'usage' && <UsagePage />}
          {view === 'tasks' && <TasksPage />}
          {view === 'models' && <ModelsPage />}
          {view === 'media' && <MediaPage />}
          {view === 'config' && <ConfigPage />}
        </Suspense>
      </main>
    </div>
  )
}
