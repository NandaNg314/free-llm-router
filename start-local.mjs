#!/usr/bin/env node
/**
 * 本地版零配置启动器（面向 Windows / macOS / Linux 桌面用户）。
 *
 * ## 核心职责
 *
 * 1. **精确检查 Node.js >= 22.13.0**：`node:sqlite` 自 22.13.0 起默认免 flag 可用，
 *    旧版本直接给出清晰中文升级指引，避免裸抛模块缺失堆栈；同时静默 SQLite 实验警告。
 * 2. **安全读写 `.env`**：自动剥离 Windows 记事本写入的 UTF-8 BOM（`\uFEFF`），
 *    兼容单/双引号与行尾注释；补全缺失项时严格保留用户原有键值与注释，绝不重置已有密钥。
 * 3. **幂等防呆与端口自愈**：
 *    - 若目标端口已运行 `free-llm-router`，直接提示并打开面板（退出码 0，零报错）；
 *    - 若未显式传 `--port` 而默认端口被其他软件占用，自动顺延探测 `PORT+1 .. PORT+10`。
 * 4. **同进程托管与优雅落盘**：通过 `import()` 在同一进程内启动服务，
 *    避免 Windows 下父进程 `child.kill('SIGTERM')` 强杀子进程导致 SQLite WAL 损坏。
 * 5. **真实就绪轮询**：轮询 `/healthz` 返回 200 后再拉起浏览器，慢盘/杀软扫描下不白屏。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'

// 屏蔽 Node 加载内置 node:sqlite 时的 ExperimentalWarning 刷屏（保留其他真正的告警）
const originalEmit = process.emit
process.emit = function patchedEmit(event, warning, ...rest) {
  if (
    event === 'warning' &&
    warning &&
    typeof warning === 'object' &&
    warning.name === 'ExperimentalWarning' &&
    /sqlite/i.test(String(warning.message ?? ''))
  ) {
    return false
  }
  return originalEmit.call(this, event, warning, ...rest)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, 'data')
const ENV_FILE = join(HERE, '.env')
const ENTRY = join(HERE, 'dist', 'server.mjs')

/**
 * 校验 Node.js 版本是否满足 `>= 22.13.0`（稳定免 flag `node:sqlite` 最低版本）。
 */
export function isSupportedNodeVersion(versionStr = process.versions.node) {
  const clean = String(versionStr ?? '').trim().replace(/^v/i, '')
  const [majStr, minStr] = clean.split('.')
  const major = Number(majStr)
  const minor = Number(minStr ?? '0')
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  return major > 22 || (major === 22 && minor >= 13)
}

/**
 * 解析单行 `.env` 值：支持双引号转义、单引号原样值以及未加引号时的 ` # 行尾注释`。
 */
export function parseEnvValue(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('"')) {
    let out = ''
    let escaped = false
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (escaped) {
        if (ch === 'n') out += '\n'
        else if (ch === 'r') out += '\r'
        else if (ch === 't') out += '\t'
        else out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') return out
      out += ch
    }
    return out
  }
  if (trimmed.startsWith("'")) {
    const closeIdx = trimmed.indexOf("'", 1)
    return closeIdx >= 1 ? trimmed.slice(1, closeIdx) : trimmed.slice(1)
  }
  const commentMatch = /\s+#/.exec(trimmed)
  return (commentMatch ? trimmed.slice(0, commentMatch.index) : trimmed).trim()
}

/**
 * 解析 `.env` 文本：必须先剥离 UTF-8 BOM `\uFEFF`，防止记事本保存后首行键名损坏导致密钥被重置。
 */
export function parseEnvText(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '')
  const values = {}
  for (const line of clean.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const body = t.startsWith('export ') ? t.slice(7).trim() : t
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (key === '') continue
    values[key] = parseEnvValue(body.slice(eq + 1))
  }
  return values
}

/**
 * 读取或补全 `.env`。
 *
 * - 若已有 `API_KEY` 与 `CREDENTIAL_KEY`，绝不改写磁盘上的 `.env`（原样保留 BOM/注释/自定义项）；
 * - 若缺失其中某项，仅在原文件末尾追加缺失项，绝不覆盖任何已有键值或注释行。
 */
export function loadOrCreateEnv(envFile = ENV_FILE) {
  if (!existsSync(envFile)) {
    const values = {
      API_KEY: `sk-${randomBytes(24).toString('base64url')}`,
      CREDENTIAL_KEY: randomBytes(32).toString('base64url'),
    }
    const body = [
      '# free-llm-router 本地版配置（自动生成）',
      '#',
      '# API_KEY        = 打开面板与调用接口的主口令',
      '# CREDENTIAL_KEY = 加密账号凭据的主密钥',
      '# PORT           = 可选，取消注释可固定端口（默认 11451）',
      '#',
      '# 重要提示：请勿随意修改 CREDENTIAL_KEY，否则已保存的账号凭据将无法解密。',
      '# 迁移备份：将 .env 与 data/ 文件夹一起复制即可完整迁移。',
      `API_KEY=${values.API_KEY}`,
      `CREDENTIAL_KEY=${values.CREDENTIAL_KEY}`,
      '',
    ].join('\n')
    writeFileSync(envFile, body, 'utf8')
    return values
  }

  const rawText = readFileSync(envFile, 'utf8')
  const values = parseEnvText(rawText)
  const missingLines = []

  if (!values.API_KEY) {
    values.API_KEY = `sk-${randomBytes(24).toString('base64url')}`
    missingLines.push(`API_KEY=${values.API_KEY}`)
  }
  if (!values.CREDENTIAL_KEY) {
    values.CREDENTIAL_KEY = randomBytes(32).toString('base64url')
    missingLines.push(`CREDENTIAL_KEY=${values.CREDENTIAL_KEY}`)
  }

  if (missingLines.length > 0) {
    const eol = rawText.includes('\r\n') ? '\r\n' : '\n'
    const cleanExisting = rawText.replace(/^\uFEFF/, '')
    const sep = cleanExisting === '' || cleanExisting.endsWith('\n') ? '' : eol
    writeFileSync(envFile, cleanExisting + sep + missingLines.join(eol) + eol, 'utf8')
  }

  return values
}

/**
 * 解析命令行与环境配置。
 *
 * 优先级：`命令行 --port/--host` > `系统环境变量 process.env` > `.env 文件` > `默认值`。
 */
export function resolveLaunchConfig(argv, sysEnv, dotEnv) {
  let cliPort
  let cliHost
  let noOpen = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-open') {
      noOpen = true
    } else if (a === '--help' || a === '-h') {
      help = true
    } else if (a === '--port') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: '参数 --port 缺少端口号（请输入 1 到 65535 之间的整数，例如 --port 8080）。' }
      }
      cliPort = next
      i++
    } else if (a.startsWith('--port=')) {
      cliPort = a.slice('--port='.length)
    } else if (a === '--host') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: '参数 --host 缺少监听地址（例如 --host 127.0.0.1 或 --host 0.0.0.0）。' }
      }
      cliHost = next
      i++
    } else if (a.startsWith('--host=')) {
      cliHost = a.slice('--host='.length)
    }
  }

  const hasCliPort = cliPort !== undefined
  const sysPort = typeof sysEnv.PORT === 'string' && sysEnv.PORT.trim() !== '' ? sysEnv.PORT.trim() : undefined
  const filePort = typeof dotEnv.PORT === 'string' && dotEnv.PORT.trim() !== '' ? dotEnv.PORT.trim() : undefined
  const rawPort = (cliPort ?? sysPort ?? filePort ?? '11451').trim()

  if (!/^\d+$/.test(rawPort)) {
    return {
      ok: false,
      error: `端口配置无效：${JSON.stringify(rawPort)}。\n   端口号必须是 1 到 65535 之间的纯数字整数（默认 11451）。`,
    }
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      error: `端口号超出范围：${rawPort}。\n   请使用 1 到 65535 之间的整数（推荐 1024 以上，默认 11451）。`,
    }
  }

  const sysHost = typeof sysEnv.HOST === 'string' && sysEnv.HOST.trim() !== '' ? sysEnv.HOST.trim() : undefined
  const fileHost = typeof dotEnv.HOST === 'string' && dotEnv.HOST.trim() !== '' ? dotEnv.HOST.trim() : undefined
  const host = (cliHost ?? sysHost ?? fileHost ?? '127.0.0.1').trim() || '127.0.0.1'

  return { ok: true, port, hasCliPort, host, noOpen, help }
}

function toConnectHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function toSocketHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1'
  return host.replace(/^\[|\]$/g, '')
}

/**
 * 探测目标端口是否已有正在运行的 `free-llm-router` 实例（1.5s 超时）。
 */
export async function probeExistingRouter(host, port, timeoutMs = 1500) {
  const connectHost = toConnectHost(host)
  try {
    const res = await fetch(`http://${connectHost}:${port}/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (res.status !== 200) {
      return { kind: 'occupied_other' }
    }
    const data = await res.json().catch(() => null)
    if (data && typeof data === 'object' && data.name === 'free-llm-router') {
      const version = typeof data.version === 'string' && data.version.trim() !== '' ? data.version.trim() : '未知'
      return { kind: 'running_router', version }
    }
    return { kind: 'occupied_other' }
  } catch {
    return { kind: 'no_http' }
  }
}

/**
 * 检测目标 `bindHost:port` 是否真正空闲可绑定：
 * 1. 先尝试 TCP 连接对端（拦截 Windows 下非独占绑定导致的假空闲）；
 * 2. 再用临时 Server 测试 `exclusive: true` 绑定（拦截 EADDRINUSE 与系统保留端口 EACCES）。
 */
export async function checkPortBindable(bindHost, port) {
  const socketHost = toSocketHost(bindHost)
  const tcpListening = await new Promise((resolveConn) => {
    const sock = net.createConnection({ host: socketHost, port })
    let settled = false
    const done = (listening) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolveConn(listening)
    }
    sock.setTimeout(350)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
  if (tcpListening) {
    return { available: false, code: 'EADDRINUSE' }
  }

  return new Promise((resolveBind) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', (err) => {
      resolveBind({ available: false, code: err?.code || 'ERROR' })
    })
    srv.listen({ port, host: bindHost, exclusive: true }, () => {
      srv.close(() => resolveBind({ available: true }))
    })
  })
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {
      console.log('  （未能自动拉起浏览器，请手动复制上方地址打开）')
    })
    child.unref()
  } catch {
    console.log('  （未能自动拉起浏览器，请手动复制上方地址打开）')
  }
}

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })
}

/**
 * 轮询 `/healthz`（每 200ms 一次，最长 12s），收到 200 立即回调打开浏览器；
 * 若服务提前退出或报错则立即中止，绝不乱弹白屏窗口。
 */
export async function waitHealthzThenOpen({ host, port, isAborted, onReady, maxWaitMs = 12_000, intervalMs = 200 }) {
  const connectHost = toConnectHost(host)
  const healthUrl = `http://${connectHost}:${port}/healthz`
  const deadline = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    if (isAborted()) return false
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
      if (res.status === 200) {
        if (isAborted()) return false
        onReady()
        return true
      }
    } catch {
      // 服务尚未就绪，继续轮询
    }
    if (isAborted()) return false
    await sleep(intervalMs)
  }
  return false
}

async function main() {
  const effectiveNodeVer = process.env.FLR_TEST_NODE_VERSION || process.versions.node
  if (!isSupportedNodeVersion(effectiveNodeVer)) {
    console.error(
      `\n❌ Node.js 版本过低：当前为 v${String(effectiveNodeVer).replace(/^v/i, '')}，需要 v22.13.0 或更高版本。\n` +
        '   原因：本程序使用 Node.js 22.13+ 内置稳定版 node:sqlite 数据库引擎（22.0～22.12 尚未内置）。\n' +
        '   升级步骤：\n' +
        '     1) 打开 https://nodejs.org/zh-cn 下载最新 LTS 安装包覆盖安装\n' +
        '     2) 重新打开终端或再次双击启动脚本\n',
    )
    process.exit(1)
  }

  const entryPath = process.env.FLR_TEST_ENTRY ? resolve(process.env.FLR_TEST_ENTRY) : ENTRY
  if (!existsSync(entryPath)) {
    console.error(
      `\n❌ 找不到服务端程序文件：${entryPath}\n\n` +
        '   如果你是在源码仓库中运行，请先执行构建：\n' +
        '     npm install\n' +
        '     npm run build:web && npm run build:node\n\n' +
        '   如果你下载的是本地版压缩包，请确认已完整解压（不要直接在压缩包预览窗口内双击）。\n',
    )
    process.exit(1)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  const dotEnv = loadOrCreateEnv(ENV_FILE)

  const parsed = resolveLaunchConfig(process.argv.slice(2), process.env, dotEnv)
  if (!parsed.ok) {
    console.error(`\n❌ ${parsed.error}\n`)
    process.exit(1)
  }

  if (parsed.help) {
    console.log(
      '\n用法：node start-local.mjs [--port <1-65535>] [--host <地址>] [--no-open]\n\n' +
        '选项：\n' +
        '  --port <端口>   指定监听端口（默认读取 .env 中的 PORT，未设则为 11451）\n' +
        '  --host <地址>   指定监听网卡（默认 127.0.0.1，局域网共享可传 0.0.0.0）\n' +
        '  --no-open       启动后不自动打开浏览器\n',
    )
    process.exit(0)
  }

  const effectiveApiKey =
    (typeof process.env.API_KEY === 'string' && process.env.API_KEY.trim() !== ''
      ? process.env.API_KEY.trim()
      : dotEnv.API_KEY) || ''

  const basePort = parsed.port
  const finalHost = parsed.host

  // ── 情形 A：检查目标端口是否已经是正在运行的 free-llm-router（重复双击防呆） ──
  const existing = await probeExistingRouter(finalHost, basePort, 1500)
  if (existing.kind === 'running_router') {
    const panelUrl = `http://${toConnectHost(finalHost)}:${basePort}/panel/`
    console.log('')
    console.log('  ┌─────────────────────────────────────────────────┐')
    console.log('  │  free-llm-router · 本地版（已在运行中）         │')
    console.log('  └─────────────────────────────────────────────────┘')
    console.log('')
    console.log(`  检测到 free-llm-router 已在运行中（v${existing.version}），正在为你打开面板...`)
    console.log('')
    console.log(`  面板地址   ${panelUrl}`)
    console.log(`  登录口令   ${effectiveApiKey}`)
    console.log(`  数据目录   ${DATA_DIR}`)
    console.log('')
    if (!parsed.noOpen) {
      openBrowser(panelUrl)
    }
    process.exit(0)
  }

  // ── 情形 B：检查端口可用性；未显式传 --port 时自动顺延探测 PORT+1 .. PORT+10 ──
  let finalPort = basePort
  let switchedFromPort = null

  const firstBind =
    existing.kind === 'occupied_other'
      ? { available: false, code: 'EADDRINUSE' }
      : await checkPortBindable(finalHost, basePort)

  if (!firstBind.available) {
    if (parsed.hasCliPort) {
      const suggestPort = Math.min(65535, basePort + 1)
      console.error(
        `\n❌ 无法在端口 ${basePort} 启动：该端口已被其他程序占用（或被系统保留）。\n` +
          '   排查建议：\n' +
          `     1) 换用其他空闲端口：node start-local.mjs --port ${suggestPort}\n` +
          '     2) 或先关闭占用该端口的程序后再试。\n',
      )
      process.exit(1)
    }

    const maxCandidate = Math.min(65535, basePort + 10)
    let foundPort = null
    for (let candidate = basePort + 1; candidate <= maxCandidate; candidate++) {
      // 若顺延端口上已有早先顺延启动的 free-llm-router 实例，直接复用打开面板
      const runningOnCandidate = await probeExistingRouter(finalHost, candidate, 600)
      if (runningOnCandidate.kind === 'running_router') {
        const panelUrl = `http://${toConnectHost(finalHost)}:${candidate}/panel/`
        console.log('')
        console.log(`  检测到 free-llm-router 已在顺延端口 ${candidate} 运行中（v${runningOnCandidate.version}），正在为你打开面板...`)
        console.log(`  面板地址   ${panelUrl}`)
        console.log(`  登录口令   ${effectiveApiKey}`)
        console.log('')
        if (!parsed.noOpen) openBrowser(panelUrl)
        process.exit(0)
      }
      if (runningOnCandidate.kind === 'occupied_other') continue
      const check = await checkPortBindable(finalHost, candidate)
      if (check.available) {
        foundPort = candidate
        break
      }
    }

    if (foundPort === null) {
      console.error(
        `\n❌ 无法启动：默认端口 ${basePort} 及顺延端口 ${basePort + 1}～${maxCandidate} 均被占用。\n` +
          '   请手动指定一个空闲端口启动，例如：\n' +
          '     node start-local.mjs --port 18080\n',
      )
      process.exit(1)
    }

    finalPort = foundPort
    switchedFromPort = basePort
  }

  // 将 .env 键值注入当前进程环境（系统已显式设置的同名变量优先）
  for (const [k, v] of Object.entries(dotEnv)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v
    }
  }
  const databasePath = resolve(join(DATA_DIR, 'router.db'))
  process.env.PORT = String(finalPort)
  process.env.HOST = finalHost
  process.env.DATABASE_PATH = databasePath
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
  process.env.LOCAL_MODE = '1'

  const panelUrl = `http://${toConnectHost(finalHost)}:${finalPort}/panel/`

  console.log('')
  console.log('  ┌─────────────────────────────────────────────────┐')
  console.log('  │  free-llm-router · 本地版                       │')
  console.log('  └─────────────────────────────────────────────────┘')
  if (switchedFromPort !== null) {
    console.log('')
    console.log(`  ⚠️  默认端口被占用，本次已自动切换到端口 ${finalPort}（原端口 ${switchedFromPort}）`)
  }
  console.log('')
  console.log(`  面板地址   ${panelUrl}`)
  console.log(`  登录口令   ${effectiveApiKey}`)
  console.log(`  数据目录   ${DATA_DIR}`)
  console.log('')
  console.log('  保持本窗口开启即可使用；按 Ctrl+C 可安全停止并保存数据。')
  console.log('')

  let aborted = false
  process.once('exit', () => {
    aborted = true
  })

  if (!parsed.noOpen) {
    void waitHealthzThenOpen({
      host: finalHost,
      port: finalPort,
      isAborted: () => aborted,
      onReady: () => openBrowser(panelUrl),
    })
  }

  // 同进程加载并启动服务端：Windows 控制台 Ctrl+C / 关闭窗口（SIGINT / SIGBREAK）直达服务端 shutdown() 落盘 SQLite WAL
  const mod = await import(pathToFileURL(entryPath).href)
  if (typeof mod.startServer === 'function') {
    const started = mod.startServer({
      port: finalPort,
      host: finalHost,
      databasePath,
      localMode: true,
    })
    if (started?.server) {
      started.server.once('close', () => {
        aborted = true
      })
      started.server.once('error', () => {
        aborted = true
      })
    }
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  !process.argv[1].includes('.test.') &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]) &&
  /start-local\.mjs$/i.test(process.argv[1])

if (isMain) {
  main().catch((err) => {
    console.error(`\n❌ 启动过程发生未预期错误：${err?.message || String(err)}\n`)
    process.exit(1)
  })
}
