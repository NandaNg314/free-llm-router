#!/usr/bin/env node
/**
 * 本地版零门槛无损升级脚本。
 *
 * ## 支持 3 种傻瓜升级方式
 *
 * 1. **直接传 `.zip` 压缩包（免解压）**：
 *    `node update-local.mjs ../free-llm-router-local-v1.4.0.zip`
 *    （Windows 用户也可直接把新版 `.zip` 拖到 `update-windows.bat` 图标上）
 * 2. **传解压后的目录（自动剥离嵌套目录）**：
 *    即使解压出 `free-llm-router-local-v1.4.0/free-llm-router-local/dist/server.mjs` 也能自动识别。
 * 3. **无参数双击自动发现**：
 *    不带参数运行 `update-windows.bat` / `./update-mac-linux.sh` / `node update-local.mjs`，
 *    自动在当前目录与父目录搜索最新的 `free-llm-router-local*.zip` 或解压目录完成升级。
 *
 * ## 绝对安全护栏
 *
 * - 升级前对新版 `dist/server.mjs` 做非空与 `node --check` 语法校验，损坏包绝不覆盖旧版；
 * - 升级前后对 `.env` 与 `data/` 做 SHA-256 快照比对，100% 保证账号与密钥零触碰；
 * - 自动备份旧 `dist/server.mjs.bak-<时间戳>`，并自动清理只保留最近 3 份备份。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'

const DEFAULT_HERE = dirname(fileURLToPath(import.meta.url))

/** 允许更新的程序本体文件清单（含升级器自更新）。 */
export const REPLACE_FILES = [
  'dist/server.mjs',
  'VERSION',
  'start-local.mjs',
  'start-windows.bat',
  'start-mac-linux.sh',
  'update-local.mjs',
  'update-windows.bat',
  'update-mac-linux.sh',
  'README.txt',
]

/** 绝对受保护的用户数据路径（绝不修改、删除或覆盖）。 */
export const PROTECTED_PATHS = ['.env', 'data']

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function isSupportedNodeVersion(versionStr = process.versions.node) {
  const clean = String(versionStr ?? '').trim().replace(/^v/i, '')
  const [majStr, minStr] = clean.split('.')
  const major = Number(majStr)
  const minor = Number(minStr ?? '0')
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  return major > 22 || (major === 22 && minor >= 13)
}

function extractVersionFromServerCode(code) {
  // 1. 精确匹配 esbuild 编译产物中的独立顶层变量 `var APP_VERSION = "1.4.0"`（\b 排除 EXTRA_APP_VERSION 等）
  const m1 = /\bAPP_VERSION\s*=\s*["'](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)["']/.exec(code)
  if (m1?.[1]) return m1[1]
  // 2. 匹配 /version 路由字面量 `{ name: "free-llm-router", version: "1.4.0" }`
  const m2 =
    /["']?name["']?\s*:\s*["']free-llm-router["']\s*,\s*["']?version["']?\s*:\s*["'](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)["']/.exec(
      code,
    )
  if (m2?.[1]) return m2[1]
  return '未知'
}

/**
 * 精确读取目录中本地版的真实版本号：
 * 优先读纯文本 `VERSION`，其次精确解析 `dist/server.mjs` 的 `APP_VERSION`，
 * 彻底杜绝旧版 `/v(\d+\.\d+\.\d+)/` 误匹配第三方库版本串的问题。
 */
export function guessVersion(dir) {
  try {
    const versionFile = join(dir, 'VERSION')
    if (existsSync(versionFile) && statSync(versionFile).isFile()) {
      const raw = readFileSync(versionFile, 'utf8').replace(/^\uFEFF/, '').trim()
      const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(raw)
      if (m?.[1]) return m[1]
    }
  } catch {
    // fallback to server.mjs
  }
  try {
    const serverFile = join(dir, 'dist', 'server.mjs')
    if (existsSync(serverFile) && statSync(serverFile).isFile()) {
      return extractVersionFromServerCode(readFileSync(serverFile, 'utf8'))
    }
  } catch {
    // ignore
  }
  return '未知'
}

/**
 * 比较两个语义化版本号（`a > b` 返回 1，`a < b` 返回 -1，相等返回 0，无法解析返回 null）。
 */
export function compareSemver(a, b) {
  const parse = (s) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(s ?? '').trim())
    if (!m) return null
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  return pa.pre > pb.pre ? 1 : -1
}

/**
 * 解析 ZIP 二进制 Buffer 的 Central Directory 条目列表，逐项校验结构合法性。
 * 支持 STORE (method=0) 与 DEFLATE (method=8)，严格拦截 Zip-Slip 路径穿越与符号链接。
 */
export function readZipEntries(zipBuf) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) {
    throw new Error('不是有效的 ZIP 文件（文件过小或为空）。')
  }

  // 从末尾向前扫描 End of Central Directory (0x06054b50)
  const minEocd = Math.max(0, zipBuf.length - 22 - 65535)
  let eocdPos = -1
  for (let p = zipBuf.length - 22; p >= minEocd; p--) {
    if (zipBuf.readUInt32LE(p) === 0x06054b50) {
      const commentLen = zipBuf.readUInt16LE(p + 20)
      if (p + 22 + commentLen === zipBuf.length) {
        eocdPos = p
        break
      }
      if (eocdPos === -1) eocdPos = p
    }
  }
  if (eocdPos < 0) {
    throw new Error('不是有效的 ZIP 压缩包（找不到 EOCD 目录尾签名）。')
  }

  const totalEntries = zipBuf.readUInt16LE(eocdPos + 10)
  const centralSize = zipBuf.readUInt32LE(eocdPos + 12)
  const centralOffset = zipBuf.readUInt32LE(eocdPos + 16)

  if (centralOffset + centralSize > eocdPos) {
    throw new Error('ZIP 文件结构损坏（Central Directory 越界）。')
  }

  const entries = []
  let pos = centralOffset
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > eocdPos || zipBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`ZIP 文件损坏（第 ${i + 1} 项 Central Header 签名无效）。`)
    }
    const versionMadeBy = zipBuf.readUInt16LE(pos + 4)
    const flags = zipBuf.readUInt16LE(pos + 8)
    const method = zipBuf.readUInt16LE(pos + 10)
    const expectedCrc = zipBuf.readUInt32LE(pos + 16)
    const compSize = zipBuf.readUInt32LE(pos + 20)
    const uncompSize = zipBuf.readUInt32LE(pos + 24)
    const nameLen = zipBuf.readUInt16LE(pos + 28)
    const extraLen = zipBuf.readUInt16LE(pos + 30)
    const commentLen = zipBuf.readUInt16LE(pos + 32)
    const externalAttr = zipBuf.readUInt32LE(pos + 38)
    const localOffset = zipBuf.readUInt32LE(pos + 42)

    const nameEnd = pos + 46 + nameLen
    if (nameEnd + extraLen + commentLen > eocdPos) {
      throw new Error('ZIP 文件损坏（文件名字段越界）。')
    }
    const rawName = zipBuf.subarray(pos + 46, nameEnd).toString('utf8')
    pos = nameEnd + extraLen + commentLen

    // 安全检查：拒绝空字节、绝对路径、盘符前缀、.. 路径穿越及 Unix 符号链接
    if (rawName.includes('\0')) {
      throw new Error('拒绝不安全的 ZIP 条目：文件名包含空字节。')
    }
    const normalized = rawName.replace(/\\/g, '/')
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((seg) => seg === '..')
    ) {
      throw new Error(`拦截不安全的 ZIP 路径穿越条目（Zip-Slip）：${rawName}`)
    }
    const hostOs = versionMadeBy >>> 8
    const unixFileType = (externalAttr >>> 16) & 0o170000
    if (hostOs === 3 && unixFileType === 0o120000) {
      throw new Error(`拒绝解压 ZIP 内的符号链接条目：${rawName}`)
    }

    entries.push({
      name: normalized,
      isDirectory: normalized.endsWith('/'),
      versionMadeBy,
      flags,
      method,
      crc32: expectedCrc,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      externalAttr,
      localOffset,
      readData() {
        if (normalized.endsWith('/')) return Buffer.alloc(0)
        if (localOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localOffset) !== 0x04034b50) {
          throw new Error(`ZIP 文件损坏（${normalized} 的 Local Header 无效）。`)
        }
        const localNameLen = zipBuf.readUInt16LE(localOffset + 26)
        const localExtraLen = zipBuf.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLen + localExtraLen
        const dataEnd = dataStart + compSize
        if (dataEnd > zipBuf.length) {
          throw new Error(`ZIP 文件已截断（${normalized} 数据块不完整）。`)
        }
        const slice = zipBuf.subarray(dataStart, dataEnd)
        let out
        if (method === 0) {
          out = Buffer.from(slice)
        } else if (method === 8) {
          out = inflateRawSync(slice)
        } else {
          throw new Error(`不支持的 ZIP 压缩算法（${normalized}, method=${method}）。`)
        }
        if (out.length !== uncompSize) {
          throw new Error(`ZIP 解压长度不匹配（${normalized}：期望 ${uncompSize}，实际 ${out.length}）。`)
        }
        const actualCrc = crc32(out)
        if (actualCrc !== expectedCrc) {
          throw new Error(
            `ZIP 文件校验失败（${normalized} CRC32 不一致：期望 0x${expectedCrc.toString(16)}，实际 0x${actualCrc.toString(16)}）。`,
          )
        }
        return out
      },
    })
  }

  return entries
}

/**
 * 将 `.zip` Buffer 安全解压到目标目录，逐项验证 CRC32 与 Zip-Slip 边界。
 */
export function extractZipBuffer(zipBuf, destDir) {
  const root = resolve(destDir)
  mkdirSync(root, { recursive: true })
  const entries = readZipEntries(zipBuf)

  for (const entry of entries) {
    const parts = entry.name.split('/').filter((s) => s !== '' && s !== '.')
    if (parts.length === 0) continue
    const targetPath = resolve(root, ...parts)
    const rel = relative(root, targetPath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`拦截越界解压路径（Zip-Slip）：${entry.name}`)
    }
    if (entry.isDirectory) {
      mkdirSync(targetPath, { recursive: true })
      continue
    }
    mkdirSync(dirname(targetPath), { recursive: true })
    const data = entry.readData()
    writeFileSync(targetPath, data)
    if (process.platform !== 'win32' && entry.versionMadeBy >>> 8 === 3) {
      const mode = (entry.externalAttr >>> 16) & 0o777
      if (mode & 0o111) {
        try {
          chmodSync(targetPath, 0o755)
        } catch {
          // ignore
        }
      }
    }
  }
  return entries.length
}

function guessZipVersion(zipPath) {
  try {
    const entries = readZipEntries(readFileSync(zipPath))
    const verEntry = entries.find((e) => !e.isDirectory && (e.name === 'VERSION' || e.name.endsWith('/VERSION')))
    if (verEntry) {
      const raw = verEntry.readData().toString('utf8').replace(/^\uFEFF/, '').trim()
      const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(raw)
      if (m?.[1]) return m[1]
    }
    const srvEntry = entries.find(
      (e) => !e.isDirectory && (e.name === 'dist/server.mjs' || e.name.endsWith('/dist/server.mjs')),
    )
    if (srvEntry) {
      const v = extractVersionFromServerCode(srvEntry.readData().toString('utf8'))
      if (v !== '未知') return v
    }
  } catch {
    // ignore broken zip during discovery; formal step will report if selected
  }
  const byName = /v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i.exec(basename(zipPath))
  return byName?.[1] ?? '未知'
}

/**
 * 自动剥离嵌套目录（最多向下识别 2 层）：
 * 兼容用户把 `free-llm-router-local-v1.4.0.zip` 解压到同名文件夹后形成
 * `free-llm-router-local-v1.4.0/free-llm-router-local/dist/server.mjs` 的常见结构。
 */
export function unwrapReleaseDir(dir) {
  const d0 = resolve(dir)
  if (!existsSync(d0) || !statSync(d0).isDirectory()) return null
  if (existsSync(join(d0, 'dist', 'server.mjs'))) return d0

  const namedChild = join(d0, 'free-llm-router-local')
  if (existsSync(join(namedChild, 'dist', 'server.mjs'))) return namedChild

  const level1Dirs = readdirSync(d0, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(d0, e.name))

  const level1Hits = level1Dirs.filter((d) => existsSync(join(d, 'dist', 'server.mjs')))
  if (level1Hits.length === 1) return level1Hits[0]

  if (level1Dirs.length === 1) {
    const sub = level1Dirs[0]
    if (existsSync(join(sub, 'free-llm-router-local', 'dist', 'server.mjs'))) {
      return join(sub, 'free-llm-router-local')
    }
    const level2Hits = readdirSync(sub, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(sub, e.name))
      .filter((d) => existsSync(join(d, 'dist', 'server.mjs')))
    if (level2Hits.length === 1) return level2Hits[0]
  }

  return null
}

function isZipFile(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size < 22) return false
    if (/\.zip$/i.test(filePath)) return true
    const head = readFileSync(filePath).subarray(0, 4)
    return head.length === 4 && head.readUInt32LE(0) === 0x04034b50
  } catch {
    return false
  }
}

/**
 * 无参数自动发现：在当前目录与父目录搜索比当前更新（或最新修改）的 `free-llm-router-local*.zip` 或兄弟解压目录。
 */
export function discoverUpgradeSource(hereDir) {
  const root = resolve(hereDir)
  const parent = resolve(root, '..')
  const currentVer = guessVersion(root)
  const candidates = []
  const seen = new Set()

  const addCandidate = (candPath, kind, version) => {
    const abs = resolve(candPath)
    if (abs === root || seen.has(abs)) return
    seen.add(abs)
    try {
      const mtimeMs = statSync(abs).mtimeMs
      candidates.push({ path: abs, kind, version, mtimeMs })
    } catch {
      // ignore
    }
  }

  for (const scanDir of [root, parent]) {
    let items = []
    try {
      items = readdirSync(scanDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = join(scanDir, item.name)
      if (item.isFile() && /^free-llm-router-local.*\.zip$/i.test(item.name)) {
        addCandidate(full, 'zip', guessZipVersion(full))
      } else if (
        item.isDirectory() &&
        /^free-llm-router-local/i.test(item.name) &&
        resolve(full) !== root &&
        !['data', 'dist', 'node_modules', 'release-local', '.git', '.build'].includes(item.name)
      ) {
        const unwrapped = unwrapReleaseDir(full)
        if (unwrapped && resolve(unwrapped) !== root) {
          addCandidate(full, 'dir', guessVersion(unwrapped))
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { found: null, reason: 'none', currentVer }
  }

  const sortBest = (list) =>
    [...list].sort((a, b) => {
      const cmp = compareSemver(b.version, a.version)
      if (cmp !== null && cmp !== 0) return cmp
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs
      if (a.kind !== b.kind) return a.kind === 'zip' ? -1 : 1
      return 0
    })

  if (currentVer !== '未知') {
    const newer = candidates.filter((c) => c.version !== '未知' && (compareSemver(c.version, currentVer) ?? -1) > 0)
    if (newer.length > 0) {
      return { found: sortBest(newer)[0], reason: 'newer', currentVer }
    }
    const equalOrUnknown = candidates.filter(
      (c) => c.version === '未知' || compareSemver(c.version, currentVer) === 0,
    )
    if (equalOrUnknown.length > 0) {
      return { found: sortBest(equalOrUnknown)[0], reason: 'same_or_unknown', currentVer }
    }
    return { found: null, reason: 'only_older', currentVer, candidates: sortBest(candidates) }
  }

  return { found: sortBest(candidates)[0], reason: 'unknown_current', currentVer }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function listFilesHashRecursive(dir, prefix = '') {
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      for (const [k, v] of listFilesHashRecursive(abs, rel)) out.set(k, v)
    } else if (e.isFile()) {
      out.set(rel, sha256File(abs))
    }
  }
  return out
}

function snapshotProtected(hereDir) {
  const envPath = join(hereDir, '.env')
  const dataDir = join(hereDir, 'data')
  return {
    envExists: existsSync(envPath),
    envHash: existsSync(envPath) && statSync(envPath).isFile() ? sha256File(envPath) : '',
    dataExists: existsSync(dataDir),
    dataFiles: listFilesHashRecursive(dataDir),
  }
}

function assertProtectedUnchanged(before, after) {
  if (before.envExists !== after.envExists || before.envHash !== after.envHash) {
    throw new Error('安全校验告警：检测到 .env 在升级前后发生变化！')
  }
  if (before.dataExists !== after.dataExists || before.dataFiles.size !== after.dataFiles.size) {
    throw new Error('安全校验告警：检测到 data/ 目录结构在升级前后发生变化！')
  }
  for (const [rel, h] of before.dataFiles.entries()) {
    if (after.dataFiles.get(rel) !== h) {
      throw new Error(`安全校验告警：检测到 data/${rel} 在升级前后发生变化！`)
    }
  }
}

function pruneOldBackups(distDir, keepCount = 3) {
  if (!existsSync(distDir)) return []
  const backups = readdirSync(distDir)
    .filter((name) => /^server\.mjs\.bak-\d+$/.test(name))
    .map((name) => {
      const ts = Number(name.slice('server.mjs.bak-'.length))
      const full = join(distDir, name)
      return { name, full, ts: Number.isFinite(ts) ? ts : 0 }
    })
    .sort((a, b) => b.ts - a.ts)

  const removed = []
  for (const old of backups.slice(keepCount)) {
    try {
      unlinkSync(old.full)
      removed.push(old.name)
    } catch {
      // ignore
    }
  }
  return removed
}

function validateServerSyntax(serverMjsPath) {
  if (!existsSync(serverMjsPath)) {
    return { ok: false, reason: '找不到新版 dist/server.mjs 文件。' }
  }
  const st = statSync(serverMjsPath)
  if (!st.isFile() || st.size === 0) {
    return { ok: false, reason: '新版 dist/server.mjs 文件为空（0 字节），升级包可能未下载完整。' }
  }
  const res = spawnSync(process.execPath, ['--no-warnings', '--check', serverMjsPath], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
  if (res.error) {
    return { ok: false, reason: `无法调用 Node 执行语法预检：${res.error.message}` }
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(0, 5).join('\n   ')
    return {
      ok: false,
      reason: `新版 dist/server.mjs 未通过语法完整性检查（退出码 ${res.status}）：\n   ${detail}`,
    }
  }
  return { ok: true }
}

export function runUpdate({ hereDir = DEFAULT_HERE, sourceArg } = {}) {
  const HERE = resolve(hereDir)
  let tempExtractDir = null

  try {
    let chosenInput = sourceArg
    let autoFoundLabel = null

    if (chosenInput === undefined || chosenInput.trim() === '') {
      const discovery = discoverUpgradeSource(HERE)
      if (!discovery.found) {
        if (discovery.reason === 'only_older') {
          const oldest = discovery.candidates?.[0]
          console.error(
            `\n⚠️ 未发现比当前版本（v${discovery.currentVer}）更新的升级包。\n` +
              `   仅检测到较低版本：${oldest ? `${basename(oldest.path)} (v${oldest.version})` : '无'}\n` +
              '   如果你确实需要回退到旧版本，请显式传入路径：\n' +
              `     node update-local.mjs "${oldest?.path ?? '<旧版.zip或目录>'}"\n`,
          )
          return { exitCode: 1 }
        }
        console.error(
          '\n❌ 未找到可用的新版发布包。\n\n' +
            '   你可以任选以下 3 种最省心的方式升级（全程绝不触碰 .env 与 data/ 账号数据）：\n' +
            '     方式 1（推荐）：把下载的 free-llm-router-local-vX.Y.Z.zip 放到当前目录或上一级目录，\n' +
            '                    直接双击 update-windows.bat（或运行 ./update-mac-linux.sh）即可自动升级！\n' +
            '     方式 2（拖拽）：Windows 下直接把新版 .zip 拖到 update-windows.bat 图标上松手。\n' +
            '     方式 3（命令）：node update-local.mjs <新版.zip 文件 或 解压后的目录>\n',
        )
        return { exitCode: 1 }
      }
      chosenInput = discovery.found.path
      autoFoundLabel = `${discovery.found.path}（v${discovery.found.version}）`
    }

    const inputAbs = resolve(chosenInput)
    if (!existsSync(inputAbs)) {
      console.error(`\n❌ 找不到指定的升级包或目录：${inputAbs}\n`)
      return { exitCode: 1 }
    }

    let SRC_RAW = inputAbs
    let sourceDisplay = inputAbs

    if (isZipFile(inputAbs)) {
      tempExtractDir = mkdtempSync(join(tmpdir(), 'flr-local-update-'))
      try {
        extractZipBuffer(readFileSync(inputAbs), tempExtractDir)
      } catch (err) {
        console.error(`\n❌ 解压升级包失败（${basename(inputAbs)}）：${err?.message || String(err)}\n`)
        return { exitCode: 1 }
      }
      SRC_RAW = tempExtractDir
      sourceDisplay = `${inputAbs}（ZIP 免解压直升）`
    }

    const SRC = unwrapReleaseDir(SRC_RAW)
    if (!SRC) {
      console.error(
        `\n❌ 在 ${inputAbs} 中找不到 dist/server.mjs —— 这不像是一个完整的本地版发布包。\n` +
          '   请确认传入的是官方 free-llm-router-local-vX.Y.Z.zip 或其解压目录。\n',
      )
      return { exitCode: 1 }
    }

    if (resolve(SRC) === HERE) {
      console.error('\n❌ 源目录与当前程序目录相同，无需自己覆盖自己。\n')
      return { exitCode: 1 }
    }

    // 升级前硬门禁：校验新版 dist/server.mjs 非空且语法合法
    const syntax = validateServerSyntax(join(SRC, 'dist', 'server.mjs'))
    if (!syntax.ok) {
      console.error(`\n❌ 升级已安全中止：${syntax.reason}\n   你现有的程序与账号数据完好无损。\n`)
      return { exitCode: 1 }
    }

    const beforeVer = guessVersion(HERE)
    const afterVer = guessVersion(SRC)

    console.log('')
    console.log('  free-llm-router · 本地版无损升级')
    console.log('  ─────────────────────────────────────')
    if (autoFoundLabel) {
      console.log(`  自动发现   ${autoFoundLabel}`)
    }
    console.log(`  当前版本   ${beforeVer === '未知' ? '未知' : `v${beforeVer}`}`)
    console.log(`  目标版本   ${afterVer === '未知' ? '未知' : `v${afterVer}`}`)
    console.log(`  升级来源   ${sourceDisplay}`)
    console.log('')

    // 升级前采集受保护文件（.env 与 data/）的完整性快照
    const protectedBefore = snapshotProtected(HERE)

    const plan = []
    for (const rel of REPLACE_FILES) {
      const from = join(SRC, rel)
      const to = join(HERE, rel)
      if (!existsSync(from)) {
        plan.push({ rel, action: 'skip' })
        continue
      }
      const same = existsSync(to) && statSync(to).isFile() && sha256File(from) === sha256File(to)
      plan.push({ rel, action: same ? 'same' : 'copy', from, to, expectedHash: sha256File(from) })
    }

    for (const p of plan) {
      const mark = p.action === 'copy' ? '更新' : p.action === 'same' ? '一致' : '跳过'
      console.log(`  [${mark}] ${p.rel}`)
    }

    const presentProtected = PROTECTED_PATHS.filter((f) => existsSync(join(HERE, f)))
    console.log('')
    console.log('  以下用户数据受严格保护（绝不触碰）：')
    if (presentProtected.length === 0) {
      console.log('    （当前目录尚无 .env / data，首次启动时将自动初始化）')
    } else {
      for (const f of presentProtected) console.log(`    ✅ ${f}`)
    }

    const changed = plan.filter((p) => p.action === 'copy')
    if (changed.length === 0) {
      console.log('\n  ✅ 所有程序文件均已是最新状态，无需重复更新。\n')
      return { exitCode: 0 }
    }

    // 备份旧 dist/server.mjs，并只保留最近 3 份 .bak-*
    const distDir = join(HERE, 'dist')
    mkdirSync(distDir, { recursive: true })
    let backupName = null
    const currentServer = join(distDir, 'server.mjs')
    if (existsSync(currentServer) && statSync(currentServer).isFile()) {
      let ts = Date.now()
      while (existsSync(join(distDir, `server.mjs.bak-${ts}`))) ts++
      const backupPath = join(distDir, `server.mjs.bak-${ts}`)
      copyFileSync(currentServer, backupPath)
      backupName = basename(backupPath)
      const pruned = pruneOldBackups(distDir, 3)
      console.log(
        `\n  已备份旧核心程序 → dist/${backupName}` +
          (pruned.length > 0 ? `（已自动清理 ${pruned.length} 份更早的历史备份，保留最近 3 份）` : ''),
      )
    }

    for (const p of changed) {
      mkdirSync(dirname(p.to), { recursive: true })
      copyFileSync(p.from, p.to)
      if (process.platform !== 'win32' && (p.rel.endsWith('.sh') || p.rel.endsWith('.mjs'))) {
        try {
          chmodSync(p.to, 0o755)
        } catch {
          // ignore
        }
      }
    }

    // 逐文件 SHA-256 复核
    const mismatch = changed.filter((p) => !existsSync(p.to) || sha256File(p.to) !== p.expectedHash)
    if (mismatch.length > 0) {
      console.error(`\n❌ 以下文件写入后校验不一致：${mismatch.map((m) => m.rel).join('、')}`)
      if (backupName) {
        console.error(`   可将 dist/${backupName} 改名回 dist/server.mjs 立即恢复。\n`)
      }
      return { exitCode: 1 }
    }

    // 升级后再次校验 .env 与 data/ 100% 未被改动
    const protectedAfter = snapshotProtected(HERE)
    assertProtectedUnchanged(protectedBefore, protectedAfter)

    console.log(`\n  ✅ 升级成功（${beforeVer === '未知' ? '旧版' : `v${beforeVer}`} → v${afterVer}）！`)
    console.log('     请重启正在运行的本地版窗口使新版本生效（双击 start-windows.bat 或运行 ./start-mac-linux.sh）。')
    if (backupName) {
      console.log(`     如需回滚，将 dist/${backupName} 改名回 dist/server.mjs 即可。`)
    }
    console.log('')
    return { exitCode: 0 }
  } finally {
    if (tempExtractDir) {
      try {
        rmSync(tempExtractDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  !process.argv[1].includes('.test.') &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]) &&
  /update-local\.mjs$/i.test(process.argv[1])

if (isMain) {
  const effectiveNodeVer = process.env.FLR_TEST_NODE_VERSION || process.versions.node
  if (!isSupportedNodeVersion(effectiveNodeVer)) {
    console.error(
      `\n❌ Node.js 版本过低：当前为 v${String(effectiveNodeVer).replace(/^v/i, '')}，需要 v22.13.0 或更高版本。\n` +
        '   请前往 https://nodejs.org/zh-cn 下载安装最新 LTS 版本后再运行升级。\n',
    )
    process.exit(1)
  }

  const hereOverride = process.env.FLR_TEST_HERE ? resolve(process.env.FLR_TEST_HERE) : DEFAULT_HERE
  const arg = process.argv[2]
  if (arg === '--help' || arg === '-h') {
    console.log(
      '\n用法：\n' +
        '  node update-local.mjs                                  # 自动搜索当前/父目录新版 .zip 或目录\n' +
        '  node update-local.mjs <新版.zip 文件>                  # 免解压直接用 .zip 升级\n' +
        '  node update-local.mjs <解压后的新版目录>               # 从解压目录升级（自动识别嵌套层）\n',
    )
    process.exit(0)
  }

  const { exitCode } = runUpdate({ hereDir: hereOverride, sourceArg: arg })
  process.exit(exitCode)
}
