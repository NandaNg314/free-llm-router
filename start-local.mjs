#!/usr/bin/env node
/**
 * 本地版启动器（给没有 VPS 的人用）。
 *
 * ## 它解决什么问题
 *
 * 直接 `node dist/server.mjs` 有三个坑，非技术用户会卡住：
 * 1. **不配 `API_KEY` 就完全进不去** —— `authenticate()` 在 `API_KEY` 为空时
 *    谁都不放行，面板停在登录页且没有任何提示。
 * 2. **数据存在相对路径 `./data`** —— 双击运行时工作目录取决于启动方式，
 *    可能落到别处，用户「重启后账号全没了」。
 * 3. **面板地址要自己记** —— 启动完不知道打开哪个网址。
 *
 * ⇒ 这个启动器：自动生成并保存密钥 → 自动打开浏览器 → 把地址和密钥打在屏幕上。
 *
 * ## 用法
 *
 * ```bash
 * node start-local.mjs              # 默认端口 11451
 * node start-local.mjs --port 8080  # 换端口
 * node start-local.mjs --no-open    # 不自动开浏览器
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, 'data')
const ENV_FILE = join(HERE, '.env')
const ENTRY = join(HERE, 'dist', 'server.mjs')

// ── 参数 ──
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = argOf('--port', process.env.PORT ?? '11451')
const NO_OPEN = argv.includes('--no-open')
const HOST = argOf('--host', '127.0.0.1')

// ── 前置检查 ──
const nodeMajor = Number(process.versions.node.split('.')[0])
if (Number.isNaN(nodeMajor) || nodeMajor < 22) {
  console.error(
    `\n❌ 需要 Node.js 22 或更高版本（当前 ${process.versions.node}）。\n`
    + '   本项目用 Node 内置的 node:sqlite，不需要编译任何原生模块。\n'
    + '   下载：https://nodejs.org/ （选 LTS）\n',
  )
  process.exit(1)
}
if (!existsSync(ENTRY)) {
  console.error(
    `\n❌ 找不到 ${ENTRY}\n\n`
    + '   先构建一次：\n'
    + '     npm install\n'
    + '     npm run build:web && npm run build:node\n\n'
    + '   （发布包应该已经带上了 dist/server.mjs，若没有请联系打包者。）\n',
  )
  process.exit(1)
}

// ── 数据目录 ──
// ⚠️ 用**绝对路径**。相对路径会跟随工作目录，双击启动时可能落到别处，
//    用户看到的现象是「重启后账号全没了」。
mkdirSync(DATA_DIR, { recursive: true })

// ── 密钥 ──
/**
 * 读已有 `.env`；没有就生成一份。
 *
 * ⚠️ 密钥生成一次就要**保存下来**：它是登录面板的唯一凭据，
 *    每次重启换新的会让用户每次都得重新找。
 * ⚠️ 同时写 `CREDENTIAL_KEY`：它加密账号凭据。不写的话服务会自动在
 *    数据库里生成一个——那样一旦 `data/` 丢失，账号就再也解不开。
 *    放在 `.env` 里，用户备份两个文件即可（`.env` + `data/`）。
 */
function loadOrCreateEnv() {
  const values = {}
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (t === '' || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      values[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
  }

  let created = false
  if (!values.API_KEY) {
    values.API_KEY = `sk-${randomBytes(24).toString('base64url')}`
    created = true
  }
  if (!values.CREDENTIAL_KEY) {
    values.CREDENTIAL_KEY = randomBytes(32).toString('base64url')
    created = true
  }

  if (created) {
    const body = [
      '# free-llm-router 本地版配置（自动生成）',
      '#',
      '# API_KEY     = 打开面板要输入的口令',
      '# CREDENTIAL_KEY = 加密账号凭据的密钥',
      '#',
      '# ⚠️ 这两个值**一旦生成就别改**：',
      '#   - 改 API_KEY 只是要重新登录，无妨；',
      '#   - 改 CREDENTIAL_KEY 会让**所有已保存的账号解不开**，只能重新登录。',
      '#',
      '# 备份：把 .env 和 data/ 一起复制走即可换机器。',
      ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
      '',
    ].join('\n')
    writeFileSync(ENV_FILE, body, 'utf8')
  }
  return values
}

const env = loadOrCreateEnv()

// ── 起服务 ──
const childEnv = {
  ...process.env,
  ...env,
  PORT,
  HOST,
  DATABASE_PATH: resolve(join(DATA_DIR, 'router.db')),
  NODE_ENV: 'production',
}

console.log('')
console.log('  ┌─────────────────────────────────────────────────┐')
console.log('  │  free-llm-router · 本地版                       │')
console.log('  └─────────────────────────────────────────────────┘')
console.log('')
console.log(`  面板地址   http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/panel/`)
console.log(`  登录口令   ${env.API_KEY}`)
console.log(`  数据目录   ${DATA_DIR}`)
console.log('')
console.log('  按 Ctrl+C 停止')
console.log('')

const child = spawn(process.execPath, [ENTRY], { env: childEnv, stdio: 'inherit' })

// 等端口起来再开浏览器（服务内部会打印「已启动」，但最短 1.5 秒足够）
if (!NO_OPEN) {
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/panel/`
  setTimeout(() => {
    const cmd = process.platform === 'win32' ? 'cmd'
      : process.platform === 'darwin' ? 'open'
        : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    // ⚠️ 打不开浏览器不是错误：用户自己复制地址即可，不要因此退出
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
    } catch {
      console.log(`  （浏览器没自动打开，请手动访问上面的地址）`)
    }
  }, 1500)
}

// 把子进程的退出码透传出去（用户按 Ctrl+C 时也是子进程先收到）
child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
