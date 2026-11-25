/**
 * 本地版（Local Release）全链路零 Bug 专项端到端单测。
 *
 * 覆盖全部 8 项核心契约：
 * 1. Node.js `>= 22.13.0` 精确版本门禁（拦截 22.0~22.12）+ 零 SQLite ExperimentalWarning 刷屏；
 * 2. `.env` UTF-8 BOM 剥离、单双引号与行尾注释解析、补全缺失项绝不覆盖已有密钥、`PORT/HOST` 四级优先级；
 * 3. 重复启动幂等防呆（识别 `/version` 返回 0）+ 默认端口占用自动顺延 `PORT+1..PORT+10` + 显式 `--port` 友好报错；
 * 4. 同进程托管优雅停机（Windows `SIGBREAK` / POSIX `SIGINT` 真落盘 SQLite WAL）+ `LOCAL_MODE=1` 零重复横幅；
 * 5. `/healthz` 200ms 真实就绪轮询（慢启动等待就绪、提前退出绝不乱弹浏览器）；
 * 6. `start-windows.bat` / `update-windows.bat` / `.sh` 脚本在含中文、空格、括号路径下的健壮性与换行符规范；
 * 7. `update-local.mjs` 精确版本识别、嵌套目录剥离、`.zip` 免解压直升、无参数自动发现、语法预检、Zip-Slip 拦截、备份限留 3 份；
 * 8. `scripts/build-local-release.mjs` 写入 ZIP Unix 0755/0644 外部权限位 + 构建后 CRC32 与零敏感残留自检。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { deflateRawSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

import {
  isSupportedNodeVersion,
  parseEnvText,
  loadOrCreateEnv,
  resolveLaunchConfig,
  waitHealthzThenOpen,
} from '../start-local.mjs'
import {
  crc32,
  guessVersion,
  compareSemver,
  readZipEntries,
  extractZipBuffer,
} from '../update-local.mjs'

const ROOT = process.cwd()

/** 创建带中文、空格与括号的临时沙盒目录，验证恶劣路径兼容性。 */
function makeAdversarialSandbox(label: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `flr 本地沙盒 (${label}) `))
  return base
}

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

/** 构造测试用标准 ZIP Buffer（支持自定义 method / Unix 权限位 / 刻意破坏 CRC 或注入路径）。 */
function buildTestZip(
  items: Array<{
    name: string
    data: Buffer | string
    method?: 0 | 8
    unixMode?: number
    corruptCrc?: boolean
  }>,
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const item of items) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data, 'utf8')
    const method = item.method ?? 8
    const body = method === 8 ? deflateRawSync(raw) : raw
    const goodCrc = crc32(raw)
    const crc = item.corruptCrc ? (goodCrc ^ 0xffffffff) >>> 0 : goodCrc
    const mode = item.unixMode ?? 0o100644

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

/** 复制启动器与升级器全套脚本到沙盒目录。 */
function copyLauncherSuiteTo(sandboxDir: string): void {
  for (const f of [
    'start-local.mjs',
    'start-windows.bat',
    'start-mac-linux.sh',
    'update-local.mjs',
    'update-windows.bat',
    'update-mac-linux.sh',
  ]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(sandboxDir, f))
  }
}

/** 生成轻量级可运行的模拟 `dist/server.mjs`（带真实 `node:sqlite` 落盘与 SIGINT/SIGTERM/SIGBREAK 处理）。 */
function makeMockServerCode(version: string): string {
  return `import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'

var ZCODE_APP_VERSION_FALLBACK = "3.14.3"
var EXTRA_APP_VERSION = "appVersion"
var APP_VERSION = "${version}"
const LEGACY_DECOY = "v0.9.9"

export function startServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 11451)
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1'
  const dbPath = opts.databasePath ?? process.env.DATABASE_PATH ?? ':memory:'
  const localMode = Boolean(opts.localMode || process.env.LOCAL_MODE === '1')

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);')
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('boot_version', APP_VERSION)

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'free-llm-router' }))
      return
    }
    if (req.url === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'free-llm-router', version: APP_VERSION, decoy: LEGACY_DECOY }))
      return
    }
    if (req.url === '/test-shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ shuttingDown: true }))
      setImmediate(() => process.emit(process.platform === 'win32' ? 'SIGBREAK' : 'SIGINT'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body>free-llm-router panel</body></html>')
  })

  server.listen(port, host, () => {
    if (localMode) {
      console.log('  ✅ 服务已就绪（监听 http://' + host + ':' + port + '）')
    } else {
      console.log('🚀 free-llm-router 已启动并在 VPS 上运行！')
    }
  })

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    server.closeAllConnections?.()
    server.close(() => {
      db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('clean_shutdown', 'yes')
      db.close()
      console.log('💾 SQLite 数据库连接已安全关闭（全部连接已结束）。')
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  if (process.platform === 'win32') process.on('SIGBREAK', shutdown)
  return { server, runtime: { db } }
}
`
}

test('Bug 1 & Bug 6：Node >= 22.13.0 精确校验 + 脚本换行符编码规范 + 恶劣路径（中文/空格/括号）兼容', () => {
  // 1. 版本矩阵单测
  assert.equal(isSupportedNodeVersion('18.20.4'), false)
  assert.equal(isSupportedNodeVersion('20.18.1'), false)
  assert.equal(isSupportedNodeVersion('22.0.0'), false)
  assert.equal(isSupportedNodeVersion('22.5.0'), false)
  assert.equal(isSupportedNodeVersion('22.12.0'), false)
  assert.equal(isSupportedNodeVersion('v22.12.99'), false)
  assert.equal(isSupportedNodeVersion('22.13.0'), true)
  assert.equal(isSupportedNodeVersion('v22.14.0'), true)
  assert.equal(isSupportedNodeVersion('23.0.0'), true)
  assert.equal(isSupportedNodeVersion('24.15.0'), true)

  // 2. 检查 .sh 纯 LF 与 bash -n 语法，检查 .bat 纯 UTF-8 无 BOM + CRLF + chcp 65001
  for (const shName of ['start-mac-linux.sh', 'update-mac-linux.sh']) {
    const raw = fs.readFileSync(path.join(ROOT, shName))
    assert.equal(raw.includes(0x0d), false, `${shName} 严禁包含 CR (\\r) 字符`)
    assert.notEqual(raw[0], 0xef, `${shName} 严禁带 UTF-8 BOM`)
  }
  for (const batName of ['start-windows.bat', 'update-windows.bat']) {
    const raw = fs.readFileSync(path.join(ROOT, batName))
    assert.equal(
      raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
      false,
      `${batName} 严禁带 UTF-8 BOM（会导致 cmd 首行 @echo off 乱码报错）`,
    )
    const text = raw.toString('utf8')
    assert.ok(text.includes('\r\n'), `${batName} 应使用 CRLF 换行`)
    assert.ok(text.includes('setlocal EnableExtensions'), `${batName} 应启用 EnableExtensions`)
    assert.ok(text.includes('chcp 65001 >nul'), `${batName} 应设置 UTF-8 代码页`)
    assert.ok(text.includes('cd /d "%~dp0"'), `${batName} 应使用双引号切回脚本所在目录`)
  }

  // 3. 在含中文、空格、括号的沙盒路径下实测 Node 22.12 拦截（mjs + bat）
  const sandbox = makeAdversarialSandbox('版本拦截')
  try {
    copyLauncherSuiteTo(sandbox)

    const r1 = spawnSync(process.execPath, [path.join(sandbox, 'start-local.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, FLR_TEST_NODE_VERSION: '22.12.0' },
      windowsHide: true,
    })
    assert.equal(r1.status, 1)
    assert.match(r1.stderr, /22\.13\.0/)
    assert.doesNotMatch(r1.stderr, /ERR_UNKNOWN_BUILTIN_MODULE/)

    const r2 = spawnSync(process.execPath, [path.join(sandbox, 'update-local.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, FLR_TEST_NODE_VERSION: '22.5.1' },
      windowsHide: true,
    })
    assert.equal(r2.status, 1)
    assert.match(r2.stderr, /22\.13\.0/)

    if (process.platform === 'win32') {
      for (const bat of ['start-windows.bat', 'update-windows.bat']) {
        const batRes = spawnSync('cmd.exe', ['/d', '/c', path.join(sandbox, bat)], {
          encoding: 'utf8',
          env: { ...process.env, FLR_TEST_NODE_VERSION: '22.12.0', FLR_NO_PAUSE: '1' },
          windowsHide: true,
        })
        assert.equal(batRes.status, 1, `${bat} 在 Node 22.12 下应返回退出码 1`)
        assert.match(batRes.stdout, /22\.13\.0/, `${bat} 应打印友好升级提示`)
        assert.doesNotMatch(batRes.stderr + batRes.stdout, /此时不应有|unexpected at this time/i)
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Bug 2：.env UTF-8 BOM 剥离、引号与行尾注释兼容、缺项补全不覆盖原密钥、PORT 优先级与范围校验', () => {
  // 1. UTF-8 BOM + 单/双引号 + 行尾注释解析
  const rawWithBom =
    '\uFEFF# 记事本保存的配置文件\r\n' +
    'CREDENTIAL_KEY="cred-secret-value==\\n" # 主加密密钥注释\r\n' +
    "API_KEY='sk-my-fixed-key#keep' # 单引号内井号保留\r\n" +
    'PORT=11465 # 自定义端口\r\n' +
    'TOKEN_WITH_HASH=abc#123\r\n' +
    'export HOST=0.0.0.0\r\n'

  const parsed = parseEnvText(rawWithBom)
  assert.equal(parsed.CREDENTIAL_KEY, 'cred-secret-value==\n')
  assert.equal(parsed.API_KEY, 'sk-my-fixed-key#keep')
  assert.equal(parsed.PORT, '11465')
  assert.equal(parsed.TOKEN_WITH_HASH, 'abc#123')
  assert.equal(parsed.HOST, '0.0.0.0')

  const sandbox = makeAdversarialSandbox('env解析')
  try {
    // 2. 已有含 BOM 的完整 .env 时，loadOrCreateEnv 绝不改写磁盘文件（字节哈希 100% 不变）
    const envPath = path.join(sandbox, '.env')
    const bomEnvContent = '\uFEFFCREDENTIAL_KEY=fixed_cred_999\r\nAPI_KEY=sk-fixed_api_888\r\nPORT=11465\r\n'
    fs.writeFileSync(envPath, bomEnvContent, 'utf8')
    const hashBefore = sha256(envPath)

    const loaded = loadOrCreateEnv(envPath)
    assert.equal(loaded.CREDENTIAL_KEY, 'fixed_cred_999')
    assert.equal(loaded.API_KEY, 'sk-fixed_api_888')
    assert.equal(loaded.PORT, '11465')
    assert.equal(sha256(envPath), hashBefore, '含 BOM 但键值齐全的 .env 必须逐字节保持原样')

    // 3. 仅缺 CREDENTIAL_KEY 时，只追加缺失项，完整保留已有 API_KEY、PORT 与注释行
    const partialEnvPath = path.join(sandbox, '.env.partial')
    fs.writeFileSync(
      partialEnvPath,
      '\uFEFF# 用户手写注释\r\nAPI_KEY="sk-user-defined-key"\r\nPORT=18888 # 固定端口\r\n',
      'utf8',
    )
    const completed = loadOrCreateEnv(partialEnvPath)
    assert.equal(completed.API_KEY, 'sk-user-defined-key', '绝不能覆盖用户已有的 API_KEY')
    assert.equal(completed.PORT, '18888')
    assert.ok(completed.CREDENTIAL_KEY && completed.CREDENTIAL_KEY.length >= 20)

    const savedText = fs.readFileSync(partialEnvPath, 'utf8')
    assert.ok(savedText.includes('# 用户手写注释'), '必须保留用户注释行')
    assert.ok(savedText.includes('API_KEY="sk-user-defined-key"'), '必须原样保留用户原有键值行')
    assert.ok(savedText.includes('PORT=18888 # 固定端口'), '必须保留用户自定义 PORT 行')
    assert.ok(savedText.includes(`CREDENTIAL_KEY=${completed.CREDENTIAL_KEY}`))

    // 4. 优先级：CLI --port > process.env.PORT > .env PORT > 11451
    assert.equal(resolveLaunchConfig([], {}, {}).port, 11451)
    assert.equal(resolveLaunchConfig([], {}, { PORT: '8080' }).port, 8080)
    assert.equal(resolveLaunchConfig([], { PORT: '9090' }, { PORT: '8080' }).port, 9090)
    const cliWin = resolveLaunchConfig(['--port', '7070'], { PORT: '9090' }, { PORT: '8080' })
    assert.equal(cliWin.ok, true)
    if (cliWin.ok) {
      assert.equal(cliWin.port, 7070)
      assert.equal(cliWin.hasCliPort, true)
    }

    // 5. 非法端口拦截（友好中文提示，不崩溃）
    for (const badArgs of [['--port', 'abc'], ['--port', '0'], ['--port', '65536'], ['--port']]) {
      const bad = resolveLaunchConfig(badArgs, {}, {})
      assert.equal(bad.ok, false)
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Bug 1/2/3/4：真实子进程启动、零实验警告、含 BOM .env 生效、重复双击幂等退出 0、优雅落盘 SQLite WAL', async () => {
  const sandbox = makeAdversarialSandbox('启动与幂等')
  const port = await getFreePort()

  try {
    copyLauncherSuiteTo(sandbox)
    fs.mkdirSync(path.join(sandbox, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, 'dist', 'server.mjs'), makeMockServerCode('1.4.0'), 'utf8')

    // 写入带 UTF-8 BOM 的 .env（配置 PORT 与固定密钥）
    const envPath = path.join(sandbox, '.env')
    fs.writeFileSync(
      envPath,
      `\uFEFFCREDENTIAL_KEY=my_fixed_credential_key_123456\r\nAPI_KEY=sk-fixed_panel_login_token\r\nPORT=${port}\r\n`,
      'utf8',
    )
    const envHashBefore = sha256(envPath)

    // 1. 不带 --no-warnings 直接用 node 启动 start-local.mjs --no-open
    let stdout = ''
    let stderr = ''
    const proc = spawn(process.execPath, [path.join(sandbox, 'start-local.mjs'), '--no-open'], {
      cwd: os.tmpdir(), // 刻意设置非程序目录的工作目录，验证绝对路径 DATA_DIR 与 ENV_FILE
      env: (() => {
        const e = { ...process.env }
        delete e.PORT
        delete e.HOST
        delete e.API_KEY
        delete e.CREDENTIAL_KEY
        return e
      })(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf8')
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
    })

    // 轮询等待服务在 .env 指定的端口就绪
    let ready = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/version`)
        if (r.status === 200) {
          const j = (await r.json()) as { name?: string; version?: string }
          assert.equal(j.name, 'free-llm-router')
          assert.equal(j.version, '1.4.0')
          ready = true
          break
        }
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(ready, true, `服务应在 .env 配置的端口 ${port} 启动就绪（stderr=${stderr}）`)

    // 验证零 ExperimentalWarning、单横幅、密钥与 BOM .env 完全未被篡改
    assert.doesNotMatch(stderr, /ExperimentalWarning/i, '不应向控制台输出 SQLite ExperimentalWarning')
    assert.match(stdout, /sk-fixed_panel_login_token/, '横幅应打印 .env 中的真实登录口令')
    assert.match(stdout, /服务已就绪/, '应输出精简就绪确认')
    assert.doesNotMatch(stdout, /在 VPS 上运行/, '本地模式不应出现重复的 VPS 横幅')
    assert.equal(sha256(envPath), envHashBefore, '启动过程不得破坏含 BOM 的已有 .env')

    // 2. 情形 A：模拟用户重复第二次双击 start-local.mjs --no-open
    const dup = spawnSync(process.execPath, [path.join(sandbox, 'start-local.mjs'), '--no-open'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: (() => {
        const e = { ...process.env }
        delete e.PORT
        delete e.API_KEY
        return e
      })(),
      windowsHide: true,
    })
    assert.equal(dup.status, 0, `重复启动必须以退出码 0 正常返回（stderr=${dup.stderr}）`)
    assert.match(dup.stdout, /检测到 free-llm-router 已在运行中（v1\.4\.0）/)
    assert.match(dup.stdout, /sk-fixed_panel_login_token/)
    assert.doesNotMatch(dup.stderr + dup.stdout, /EADDRINUSE/)

    // 3. 触发优雅停机信号（Windows SIGBREAK / POSIX SIGINT），验证 db.close() 真正执行且落盘无损
    const exitPromise = new Promise<number | null>((resolveExit) => {
      proc.once('exit', (code) => resolveExit(code))
    })
    await fetch(`http://127.0.0.1:${port}/test-shutdown`)
    const exitCode = await exitPromise
    assert.equal(exitCode, 0, '优雅停机应以退出码 0 结束')
    assert.match(stdout, /SQLite 数据库连接已安全关闭/, '优雅停机必须执行 db.close() 落盘 SQLite WAL')

    const dbFile = path.join(sandbox, 'data', 'router.db')
    assert.equal(fs.existsSync(dbFile), true, 'SQLite 数据库应落在沙盒绝对路径 data/router.db')
    const checkDb = new DatabaseSync(dbFile)
    try {
      const row = checkDb.prepare('SELECT v FROM kv WHERE k = ?').get('clean_shutdown') as { v?: string }
      assert.equal(row?.v, 'yes', '停机前写入的事务应完整落盘')
      const integrity = checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      assert.equal(integrity?.integrity_check, 'ok')
    } finally {
      checkDb.close()
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Bug 3 情形 B：端口被其他程序占用时，默认自动顺延切换端口；显式 --port 给出友好中文提示', async () => {
  const sandbox = makeAdversarialSandbox('端口自愈')
  // 占用一个端口模拟第三方软件（非 free-llm-router）
  const occupier = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ app: 'other-service' }))
  })
  await new Promise<void>((r) => occupier.listen(0, '127.0.0.1', () => r()))
  const busyPort = (occupier.address() as net.AddressInfo).port

  try {
    copyLauncherSuiteTo(sandbox)
    fs.mkdirSync(path.join(sandbox, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, 'dist', 'server.mjs'), makeMockServerCode('1.4.0'), 'utf8')
    fs.writeFileSync(
      path.join(sandbox, '.env'),
      `API_KEY=sk-port-fallback-test\nCREDENTIAL_KEY=cred-port-fallback-test\nPORT=${busyPort}\n`,
      'utf8',
    )

    // 1. 显式指定 --port <busyPort>：不自动改端口，友好中文报错并退出 1（无裸堆栈）
    const explicitFail = spawnSync(
      process.execPath,
      [path.join(sandbox, 'start-local.mjs'), '--port', String(busyPort), '--no-open'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    )
    assert.equal(explicitFail.status, 1)
    assert.match(explicitFail.stderr, /已被其他程序占用/)
    assert.doesNotMatch(explicitFail.stderr, /Error: listen EADDRINUSE/)

    // 2. 未显式传 --port：自动顺延探测 busyPort+1..busyPort+10 空闲端口启动
    let stdout = ''
    const proc = spawn(process.execPath, [path.join(sandbox, 'start-local.mjs'), '--no-open'], {
      env: (() => {
        const e = { ...process.env }
        delete e.PORT
        delete e.HOST
        return e
      })(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf8')
    })

    let switchedPort: number | null = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const m = /默认端口被占用，本次已自动切换到端口 (\d+)/.exec(stdout)
      if (m) {
        switchedPort = Number(m[1])
        try {
          const r = await fetch(`http://127.0.0.1:${switchedPort}/healthz`)
          if (r.status === 200) break
        } catch {
          // wait
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    assert.ok(
      switchedPort !== null && switchedPort > busyPort && switchedPort <= busyPort + 10,
      `应自动顺延至 ${busyPort + 1}..${busyPort + 10} 空闲端口（实际 stdout=${stdout}）`,
    )

    // 优雅关闭顺延实例
    const exited = new Promise<void>((r) => proc.once('exit', () => r()))
    await fetch(`http://127.0.0.1:${switchedPort}/test-shutdown`)
    await exited
  } finally {
    await new Promise<void>((r) => occupier.close(() => r()))
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Bug 5：waitHealthzThenOpen 真实轮询 /healthz 就绪才触发打开，提前退出立即取消', async () => {
  // 1. 模拟慢启动：前 3 次返回 503，第 4 次才返回 200
  let hits = 0
  let openedAtHit = -1
  const slowServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      hits++
      if (hits < 4) {
        res.writeHead(503)
        res.end('booting')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', () => r()))
  const slowPort = (slowServer.address() as net.AddressInfo).port

  try {
    const ok = await waitHealthzThenOpen({
      host: '127.0.0.1',
      port: slowPort,
      isAborted: () => false,
      onReady: () => {
        openedAtHit = hits
      },
      maxWaitMs: 5000,
      intervalMs: 80,
    })
    assert.equal(ok, true)
    assert.ok(openedAtHit >= 4, '必须等 /healthz 真正返回 200 后才触发打开浏览器')
  } finally {
    await new Promise<void>((r) => slowServer.close(() => r()))
  }

  // 2. 模拟服务启动失败提前退出：绝不能乱弹浏览器
  const unusedPort = await getFreePort()
  let aborted = false
  let openedOnDead = false
  setTimeout(() => {
    aborted = true
  }, 150).unref()

  const deadOk = await waitHealthzThenOpen({
    host: '127.0.0.1',
    port: unusedPort,
    isAborted: () => aborted,
    onReady: () => {
      openedOnDead = true
    },
    maxWaitMs: 5000,
    intervalMs: 80,
  })
  assert.equal(deadOk, false)
  assert.equal(openedOnDead, false, '服务进程提前退出时严禁弹出白屏浏览器')
})

test('Bug 7：无损升级器（精确版本号、嵌套目录剥离、.zip 直升、自动发现、语法护栏、Zip-Slip 拦截、备份限留 3 份）', () => {
  assert.equal(compareSemver('1.4.0', '1.3.0'), 1)
  assert.equal(compareSemver('1.3.0', '1.4.0'), -1)
  assert.equal(compareSemver('1.4.0', '1.4.0'), 0)

  const workspace = makeAdversarialSandbox('升级器全测')
  const appDir = path.join(workspace, 'old-app')
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(appDir, 'data'), { recursive: true })
  copyLauncherSuiteTo(appDir)

  // 旧版无 VERSION 文件，且代码前部刻意放第三方库版本串 `v0.9.9` 与 `ZCODE_APP_VERSION_FALLBACK = "3.14.3"`
  fs.writeFileSync(path.join(appDir, 'dist', 'server.mjs'), makeMockServerCode('1.2.0'), 'utf8')
  assert.equal(guessVersion(appDir), '1.2.0', 'guessVersion 不得被第三方库版本串误导')

  // 写入受保护的用户 .env（含 UTF-8 BOM）与真实 SQLite 数据库
  const envFile = path.join(appDir, '.env')
  const dbFile = path.join(appDir, 'data', 'router.db')
  fs.writeFileSync(envFile, '\uFEFFCREDENTIAL_KEY=precious_user_cred_key\r\nAPI_KEY=sk-precious_api_key\r\nPORT=11465\r\n', 'utf8')
  const initDb = new DatabaseSync(dbFile)
  initDb.exec("CREATE TABLE accounts (uid TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('user-uid-001');")
  initDb.close()

  const envShaBefore = sha256(envFile)
  const dbShaBefore = sha256(dbFile)

  try {
    // ── 安全护栏 1：拦截 Zip-Slip 路径穿越与符号链接 ──
    const slipZip = buildTestZip([{ name: '../../escaped.txt', data: 'pwned' }])
    assert.throws(() => readZipEntries(slipZip), /Zip-Slip/)

    const symlinkZip = buildTestZip([{ name: 'free-llm-router-local/link', data: '/etc/passwd', unixMode: 0o120777 }])
    assert.throws(() => readZipEntries(symlinkZip), /符号链接/)

    const badCrcZip = buildTestZip([
      { name: 'free-llm-router-local/VERSION', data: '1.3.0\n', corruptCrc: true },
    ])
    assert.throws(
      () => extractZipBuffer(badCrcZip, path.join(workspace, 'bad-crc-out')),
      /CRC32/,
    )

    // ── 安全护栏 2：拦截语法损坏的新版 server.mjs（绝不污染旧版） ──
    const brokenDir = path.join(workspace, 'broken-release', 'free-llm-router-local')
    fs.mkdirSync(path.join(brokenDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(brokenDir, 'dist', 'server.mjs'), 'export function broken((( {', 'utf8')
    const brokenRes = spawnSync(
      process.execPath,
      [path.join(appDir, 'update-local.mjs'), path.join(workspace, 'broken-release')],
      { encoding: 'utf8', windowsHide: true },
    )
    assert.equal(brokenRes.status, 1, '损坏的 server.mjs 必须被 node --check 拦截')
    assert.equal(guessVersion(appDir), '1.2.0', '拦截后原程序版本必须完好无损')

    // ── 方式 ①：嵌套目录自动剥离升级（1.2.0 -> 1.3.0） ──
    const nestedOuter = path.join(workspace, 'extracted-v1.3.0')
    const nestedInner = path.join(nestedOuter, 'free-llm-router-local')
    fs.mkdirSync(path.join(nestedInner, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(nestedInner, 'VERSION'), '1.3.0\n', 'utf8')
    fs.writeFileSync(path.join(nestedInner, 'dist', 'server.mjs'), makeMockServerCode('1.3.0'), 'utf8')
    fs.writeFileSync(path.join(nestedInner, 'README.txt'), 'README v1.3.0', 'utf8')

    const rNested = spawnSync(process.execPath, [path.join(appDir, 'update-local.mjs'), nestedOuter], {
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(rNested.status, 0, `嵌套目录升级应成功（stderr=${rNested.stderr}）`)
    assert.equal(guessVersion(appDir), '1.3.0')

    // ── 方式 ②：免解压直接传入 .zip 升级（同时混合 STORE 与 DEFLATE，连续升 3 次测试备份清理：1.3.1, 1.3.2, 1.3.3） ──
    for (const ver of ['1.3.1', '1.3.2', '1.3.3']) {
      const zipFile = path.join(workspace, `pkg-${ver}.zip`)
      const zBuf = buildTestZip([
        { name: 'free-llm-router-local/VERSION', data: `${ver}\n`, method: 0 },
        { name: 'free-llm-router-local/dist/server.mjs', data: makeMockServerCode(ver), method: 8, unixMode: 0o100755 },
        { name: 'free-llm-router-local/README.txt', data: `README ${ver}\n`, method: 8 },
      ])
      fs.writeFileSync(zipFile, zBuf)

      const rZip = spawnSync(process.execPath, [path.join(appDir, 'update-local.mjs'), zipFile], {
        encoding: 'utf8',
        windowsHide: true,
      })
      assert.equal(rZip.status, 0, `直接用 .zip 升级到 ${ver} 应成功（stderr=${rZip.stderr}）`)
      assert.equal(guessVersion(appDir), ver)
    }

    // ── 方式 ③：无参数双击自动在父目录发现更新的 free-llm-router-local-v1.4.0.zip（含 .bat 自更新实测） ──
    const autoZip = path.join(workspace, 'free-llm-router-local-v1.4.0.zip')
    const autoZipBuf = buildTestZip([
      { name: 'free-llm-router-local/VERSION', data: '1.4.0\n', method: 0 },
      { name: 'free-llm-router-local/dist/server.mjs', data: makeMockServerCode('1.4.0'), method: 8, unixMode: 0o100755 },
      {
        name: 'free-llm-router-local/update-local.mjs',
        data: fs.readFileSync(path.join(ROOT, 'update-local.mjs')),
        method: 8,
        unixMode: 0o100755,
      },
      {
        name: 'free-llm-router-local/update-windows.bat',
        data: fs.readFileSync(path.join(ROOT, 'update-windows.bat')),
        method: 8,
      },
      {
        name: 'free-llm-router-local/update-mac-linux.sh',
        data: fs.readFileSync(path.join(ROOT, 'update-mac-linux.sh')),
        method: 8,
        unixMode: 0o100755,
      },
      { name: 'free-llm-router-local/README.txt', data: 'README v1.4.0\n', method: 8 },
    ])
    fs.writeFileSync(autoZip, autoZipBuf)

    if (process.platform === 'win32') {
      const rBatAuto = spawnSync('cmd.exe', ['/d', '/c', path.join(appDir, 'update-windows.bat')], {
        encoding: 'utf8',
        env: { ...process.env, FLR_NO_PAUSE: '1' },
        windowsHide: true,
      })
      assert.equal(rBatAuto.status, 0, `无参数双击 update-windows.bat 自动发现升级应成功（output=${rBatAuto.stdout}\n${rBatAuto.stderr}）`)

      // 回归实测 #68：模拟 Windows Explorer 拖拽「无空格但含括号」的未加引号路径（如 D:\dir(1)\pkg(1).zip）到 update-windows.bat
      const noSpaceParenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flr_drag(1)_'))
      try {
        const unquotedZip = path.join(noSpaceParenRoot, 'free-llm-router-local-v1.4.1(1).zip')
        fs.writeFileSync(
          unquotedZip,
          buildTestZip([
            { name: 'free-llm-router-local/VERSION', data: '1.4.1\n', method: 0 },
            { name: 'free-llm-router-local/dist/server.mjs', data: makeMockServerCode('1.4.1'), method: 8, unixMode: 0o100755 },
            { name: 'free-llm-router-local/README.txt', data: 'README v1.4.1\n', method: 8 },
          ]),
        )
        assert.equal(unquotedZip.includes(' '), false, '测试路径应不含空格以复现 Explorer 不套引号行为')
        const rawCmd = `"${path.join(appDir, 'update-windows.bat')}" ${unquotedZip}`
        const rDrag = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${rawCmd}"`], {
          encoding: 'utf8',
          env: { ...process.env, FLR_NO_PAUSE: '1' },
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
        assert.equal(
          rDrag.status,
          0,
          `拖拽未加引号的含括号路径到 update-windows.bat 不得触发 cmd 括号闭合崩溃（output=${rDrag.stdout}\n${rDrag.stderr}）`,
        )
        assert.doesNotMatch(rDrag.stdout + rDrag.stderr, /unexpected at this time|此时不应有/i)
        assert.equal(guessVersion(appDir), '1.4.1')
      } finally {
        fs.rmSync(noSpaceParenRoot, { recursive: true, force: true })
      }
    } else {
      const rAuto = spawnSync(process.execPath, [path.join(appDir, 'update-local.mjs')], {
        encoding: 'utf8',
      })
      assert.equal(rAuto.status, 0, `无参数自动发现升级应成功（stderr=${rAuto.stderr}）`)
      assert.equal(guessVersion(appDir), '1.4.0')
    }

    // 验证共经历了 5 次升级后，dist/ 下只保留最近 3 份 .bak-*
    const baks = fs.readdirSync(path.join(appDir, 'dist')).filter((n) => n.startsWith('server.mjs.bak-'))
    assert.equal(baks.length, 3, `备份文件应自动修剪至最多 3 份（实际：${baks.join(', ')}）`)

    // 验证经历全部升级与故障注入后，含 BOM 的 .env 与 data/router.db 100% 逐字节未变
    assert.equal(sha256(envFile), envShaBefore, '升级前后 .env 字节哈希必须 100% 一致')
    assert.equal(sha256(dbFile), dbShaBefore, '升级前后 data/router.db 字节哈希必须 100% 一致')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('Bug 8：build-local-release.mjs 产出 ZIP 具备 Unix 0755/0644 权限位、完整 9 文件、CRC32 通过且零敏感泄漏', () => {
  // 在隔离临时目录模拟仓库根目录跑 build-local-release.mjs，避免并发测试改动主目录 release-local/
  const fakeRepo = makeAdversarialSandbox('构建发布包')
  try {
    copyLauncherSuiteTo(fakeRepo)
    fs.mkdirSync(path.join(fakeRepo, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(fakeRepo, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(fakeRepo, 'package.json'), JSON.stringify({ name: 'free-llm-router', version: '1.4.0' }), 'utf8')
    fs.writeFileSync(path.join(fakeRepo, 'dist', 'server.mjs'), makeMockServerCode('1.4.0'), 'utf8')
    fs.copyFileSync(
      path.join(ROOT, 'scripts', 'build-local-release.mjs'),
      path.join(fakeRepo, 'scripts', 'build-local-release.mjs'),
    )
    // 在假仓库根放敏感 .env 与 data/，断言它们绝不会被带进发布包
    fs.writeFileSync(path.join(fakeRepo, '.env'), 'API_KEY=sk-LiveSecretKey1234567890AbCdEfGhIjKl\n', 'utf8')
    fs.mkdirSync(path.join(fakeRepo, 'data'), { recursive: true })
    fs.writeFileSync(path.join(fakeRepo, 'data', 'router.db'), 'secret-db', 'utf8')

    const buildRes = spawnSync(process.execPath, [path.join(fakeRepo, 'scripts', 'build-local-release.mjs')], {
      cwd: fakeRepo,
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(buildRes.status, 0, `build-local-release.mjs 应成功退出（stderr=${buildRes.stderr}）`)
    assert.match(buildRes.stdout, /构建后自检通过/)

    const zipPath = path.join(fakeRepo, 'release-local', 'free-llm-router-local-v1.4.0.zip')
    assert.equal(fs.existsSync(zipPath), true, '应生成对应版本号的 zip 包')

    const entries = readZipEntries(fs.readFileSync(zipPath))
    const names = entries.map((e) => e.name).sort()
    assert.deepEqual(names, [
      'free-llm-router-local/README.txt',
      'free-llm-router-local/VERSION',
      'free-llm-router-local/dist/server.mjs',
      'free-llm-router-local/start-local.mjs',
      'free-llm-router-local/start-mac-linux.sh',
      'free-llm-router-local/start-windows.bat',
      'free-llm-router-local/update-local.mjs',
      'free-llm-router-local/update-mac-linux.sh',
      'free-llm-router-local/update-windows.bat',
    ])

    for (const entry of entries) {
      assert.equal(entry.versionMadeBy, (3 << 8) | 20, `${entry.name} 应标记 Unix 创建者属性`)
      const mode = entry.externalAttr >>> 16
      if (entry.name.endsWith('.sh') || entry.name.endsWith('.mjs')) {
        assert.equal(mode, 0o100755, `${entry.name} 应具备 0o100755 可执行位`)
      } else {
        assert.equal(mode, 0o100644, `${entry.name} 应具备 0o100644 普通文件权限位`)
      }
      const raw = entry.readData() // 内部同时校验 CRC32 与解压长度
      if (entry.name.endsWith('.sh')) {
        assert.equal(raw.includes(0x0d), false, `${entry.name} 在 ZIP 内必须保持纯 LF`)
      }
      if (entry.name.endsWith('/VERSION')) {
        assert.equal(raw.toString('utf8').trim(), '1.4.0')
      }
      if (entry.name.endsWith('/README.txt')) {
        const readme = raw.toString('utf8')
        assert.match(readme, /update-windows\.bat/, 'README.txt 应说明拖拽/双击一键升级')
        assert.match(readme, /TTS|语音/, 'README.txt 应包含语音 TTS/ASR 说明')
        assert.match(readme, /3D/, 'README.txt 应包含混元 3D 说明')
        assert.match(readme, /\/v1\/messages/, 'README.txt 应包含 Claude Code /v1/messages 说明')
      }
    }
  } finally {
    fs.rmSync(fakeRepo, { recursive: true, force: true })
  }
})
