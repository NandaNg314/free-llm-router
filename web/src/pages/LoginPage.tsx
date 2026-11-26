import { AlertCircle, ArrowRight, Eye, EyeOff, Loader2, Route, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { api, ApiError, auth } from '@/lib/api'

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api('/admin/pool?realm=cn', { key: key.trim() })
      auth.set(key.trim())
      onLogin()
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? '口令不对，请检查部署时设置的 API_KEY' : '连不上网关：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden bg-[#F5F5F7] px-4 py-10 text-[#1D1D1F] dark:bg-[#09090B] dark:text-[#EDEDEF]">
      {/* 细腻柔和顶部环境光晕（纯装饰，不响应指针） */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(0,113,227,0.10),transparent)] dark:bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(10,132,255,0.16),transparent)]"
      />

      <div className="relative z-10 w-full max-w-[400px] min-w-0">
        {/* 居中高质感微光边框卡片 */}
        <div className="rounded-2xl border border-black/[0.06] bg-white p-6 shadow-[0_8px_30px_rgba(0,0,0,0.04)] sm:p-8 dark:border-white/[0.08] dark:bg-[#121215] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_18px_42px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#0071E3] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_2px_8px_rgba(0,113,227,0.28)] dark:bg-[#0A84FF]">
                <Route className="size-5" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-tight">free-llm-router</div>
                <div className="text-muted-foreground truncate text-xs">多账号池智能路由网关</div>
              </div>
            </div>
            <Badge tone="neutral" className="font-sans tabular-nums">
              v{__APP_VERSION__}
            </Badge>
          </div>

          <div className="mt-6">
            <h1 className="text-xl font-semibold tracking-tight">登录控制台</h1>
            <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
              输入部署时配置的 <code className="font-mono text-xs">API_KEY</code> 主密钥以管理账号池与路由规则。
            </p>
          </div>

          <form onSubmit={submit} className="mt-6" noValidate>
            <div>
              <Label htmlFor="key" hint="管理面鉴权口令">
                主密钥
              </Label>
              <div className="relative">
                <Input
                  id="key"
                  name="password"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  className="h-10 pr-10 font-mono text-[13px]"
                  placeholder="输入 API_KEY…"
                  aria-required="true"
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? 'login-key-error' : 'login-key-hint'}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer rounded p-1 transition-colors"
                  aria-label={show ? '隐藏主密钥' : '显示主密钥'}
                >
                  {show ? <EyeOff className="size-4" strokeWidth={1.75} /> : <Eye className="size-4" strokeWidth={1.75} />}
                </button>
              </div>

              {err ? (
                <div
                  id="login-key-error"
                  role="alert"
                  aria-live="polite"
                  className="border-danger/25 bg-danger/[0.06] text-danger mt-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed"
                >
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 break-words">{err}</span>
                </div>
              ) : (
                <p id="login-key-hint" className="text-muted-foreground mt-2 text-[11.5px] leading-relaxed">
                  支持 OpenAI 与 Anthropic 双协议统一调度、冷却熔断与每日福利自动化。
                </p>
              )}
            </div>

            <Button type="submit" className="mt-5 h-10 w-full" disabled={!key.trim() || busy}>
              {busy ? (
                <>
                  <Loader2 className="animate-spin" strokeWidth={1.75} /> 验证中…
                </>
              ) : (
                <>
                  进入控制台 <ArrowRight strokeWidth={1.75} />
                </>
              )}
            </Button>
          </form>

          <div className="text-muted-foreground mt-6 space-y-2 border-t pt-4 text-xs leading-relaxed">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span>Cloudflare 部署</span>
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">wrangler secret put API_KEY</code>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span>Node / 本地版</span>
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">环境变量 API_KEY</code>
            </div>
            <div className="text-muted-foreground/85 flex items-center gap-1.5 pt-1 text-[11.5px]">
              <ShieldCheck className="size-3.5 shrink-0 text-[#30D158]" strokeWidth={1.75} />
              <span>口令仅保存在当前浏览器本地存储，不使用 Cookie。</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
