#!/usr/bin/env node
/**
 * 打包「本地版」零依赖发布包（Windows / macOS / Linux 通用）。
 *
 * ## 产物结构
 *
 * ```
 * free-llm-router-local/
 * ├── start-windows.bat       ← Windows 双击启动
 * ├── start-mac-linux.sh      ← macOS / Linux 启动（自带 0755 可执行位）
 * ├── start-local.mjs         ← 跨平台启动内核（端口自愈 + 幂等防呆 + BOM 兼容）
 * ├── update-windows.bat      ← Windows 拖拽 .zip 或双击一键无损升级
 * ├── update-mac-linux.sh     ← macOS / Linux 一键无损升级（自带 0755 可执行位）
 * ├── update-local.mjs        ← 升级器内核（支持 .zip 免解压直升 + 嵌套目录剥离 + 备份回滚）
 * ├── VERSION                 ← 纯文本精确版本号
 * ├── dist/server.mjs         ← 单文件完整网关与控制台前端
 * └── README.txt              ← 详尽中文上手与升级指南
 * ```
 *
 * ## 安全与质量硬门禁
 *
 * 1. 严禁打包 `.env`、`data/`、`node_modules/` 或任何疑似真实密钥文本；
 * 2. `.sh` 强制归一化为纯 LF（`\n`），`.bat` 强制归一化为纯 CRLF（`\r\n`）且无 UTF-8 BOM；
 * 3. ZIP Central Directory 写入 Unix `version made by = (3 << 8) | 20` 与外部文件权限位
 *    （`.sh` / `.mjs` 为 `0o100755`，其余文件为 `0o100644`），macOS / Linux 解压即用；
 * 4. 打包末尾重新读取生成的 `.zip`，逐条用 `inflateRawSync` 解压复核 CRC32、权限位与零敏感残留。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const ROOT = process.cwd()
const OUT = join(ROOT, 'release-local', 'free-llm-router-local')

console.log('📦 打包本地版...\n')

// ① 必须已有构建产物
if (!existsSync(join(ROOT, 'dist', 'server.mjs'))) {
  console.error('❌ 缺 dist/server.mjs —— 先跑：npm run build:web && npm run build:node')
  process.exit(1)
}

// ② 清空重建输出目录
rmSync(join(ROOT, 'release-local'), { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ③ 复制启动器与升级器全套脚本，并严格规整换行符与编码（无 BOM）
const FILES = [
  'start-windows.bat',
  'start-mac-linux.sh',
  'start-local.mjs',
  'update-windows.bat',
  'update-mac-linux.sh',
  'update-local.mjs',
]

for (const f of FILES) {
  const srcPath = join(ROOT, f)
  if (!existsSync(srcPath)) {
    console.error(`❌ 缺 ${f}`)
    process.exit(1)
  }
  const text = readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '')
  if (f.endsWith('.sh')) {
    writeFileSync(join(OUT, f), text.replace(/\r\n/g, '\n'), 'utf8')
  } else if (f.endsWith('.bat')) {
    writeFileSync(join(OUT, f), text.replace(/\r?\n/g, '\r\n'), 'utf8')
  } else {
    writeFileSync(join(OUT, f), text.replace(/\r\n/g, '\n'), 'utf8')
  }
}

mkdirSync(join(OUT, 'dist'), { recursive: true })
cpSync(join(ROOT, 'dist', 'server.mjs'), join(OUT, 'dist', 'server.mjs'))

// ④ 写入纯文本 VERSION 与详尽 README.txt
const version = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version).trim()
writeFileSync(join(OUT, 'VERSION'), `${version}\n`, 'utf8')

writeFileSync(
  join(OUT, 'README.txt'),
  `free-llm-router 本地版 v${version}
========================================

这是什么
--------
把你自己的 WorkBuddy / CodeBuddy / Qoder / Trae / Cline 等多家供应商账号，
聚合为统一的本地 AI 网关，内置可视化网页控制台：
  - 对话与推理：兼容 OpenAI (/v1/chat/completions, /v1/responses)
                与 Anthropic Claude Code 原生协议 (/v1/messages)
  - 语音能力  ：文字转语音 TTS (/v1/audio/speech) 与语音识别 ASR (/v1/audio/transcriptions)
  - 视觉与 3D ：文生图/图生图、文生视频/图生视频（支持多模态参考素材）、混元 3D 模型生成
  - 联网与工具：真实联网搜索 (/v1/tools/search)、网页正文抓取 (/v1/tools/fetch) 与 MCP (/mcp)

所有密钥、账号凭据与调用日志均保存在你电脑本地（.env + data/router.db），不经过任何第三方服务器。


快速上手（三步）
----------------
第 1 步：安装 Node.js（只需装一次，版本要求 >= 22.13.0）

  本程序使用 Node.js 22.13+ 内置稳定版 SQLite 引擎，无需编译任何原生插件。

  ◆ Windows
    1) 打开 https://nodejs.org/zh-cn 下载绿色按钮的 LTS（长期支持版 .msi）
    2) 双击安装，保持默认勾选 "Add to PATH"，一路点击「下一步」
    3) 打开命令行输入 node -v，确认显示 v22.13.0 或更高版本（如 v22.14+ / v24.x）

  ◆ macOS
    方法一（Homebrew）：brew install node
    方法二（安装包）  ：访问 https://nodejs.org/zh-cn 下载 LTS 的 .pkg 双击安装

  ◆ Linux
    使用 nvm 或官方源安装 Node.js 22.13+（例如：nvm install --lts）


第 2 步：启动程序

  ◆ Windows
      直接双击 start-windows.bat
      （若弹出 SmartScreen 提示「已保护你的电脑」，点击「更多信息」→「仍要运行」）

  ◆ macOS / Linux
      发布包已预设可执行权限，在终端进入目录后直接执行：
          ./start-mac-linux.sh
      （或执行：node start-local.mjs）

  贴心特性：
  - 服务真实就绪后会自动为你弹出浏览器控制台；
  - 若不小心重复双击启动，程序会自动识别已在运行的实例并直接打开面板，不会报错；
  - 若默认端口 11451 被其他软件占用，会自动顺延切换到空闲端口并在窗口顶部醒目提示。


第 3 步：登录控制台与接入客户端

  启动窗口会打印「面板地址」与自动生成的「登录口令」（保存在 .env 的 API_KEY 中）：
  1. 在「供应商与账号」中添加你的账号（支持设备码/扫码登录或导入凭据）；
  2. 在「API Key」页面可签发受限子密钥（支持按模型、IP、额度限流）；
  3. 在「配置」页面可一键复制 Claude Code (/v1/messages)、OpenAI SDK、Cherry Studio、MCP 接入配置；
  4. 在「媒体与检索」页面可直接在线体验：
     - 语音合成（TTS 在线试听与 WAV/PCM 下载）与语音转文字（ASR 识别）
     - 文生图 / 图生图、文生视频 / 图生视频
     - 混元 3D（文生 3D / 图生 3D，支持 GLB/OBJ/FBX/STL/USDZ 导出与 PBR 材质）
     - 官方通道实时联网搜索与网页抓取


如何无损升级到新版本（绝对不丢账号数据）
----------------------------------------
⚠️ 请勿把新版压缩包直接解压覆盖旧文件夹！请使用内置的一键无损升级器：

  ◆ 方法一：拖拽升级（Windows 最省心）
      下载新版 free-llm-router-local-vX.Y.Z.zip（无需解压！），
      直接用鼠标把 .zip 文件拖到旧目录里的 update-windows.bat 图标上松手即可！

  ◆ 方法二：双击自动发现升级
      把下载的新版 .zip 放到旧目录里（或旧目录的上一级文件夹），
      直接双击 update-windows.bat（macOS/Linux 运行 ./update-mac-linux.sh）即可自动识别升级！

  ◆ 方法三：命令行指定路径（支持传 .zip 文件或解压目录）
      node update-local.mjs ../free-llm-router-local-vX.Y.Z.zip

升级器安全承诺：
  - 升级前自动检查新版程序语法完整性，损坏包绝不覆盖；
  - 全程绝不触碰 .env 与 data/，升级前后自动做 SHA-256 完整性校验；
  - 自动将旧版核心程序备份为 dist/server.mjs.bak-<时间戳>（保留最近 3 份），随时可改名回滚。


数据备份与常用参数
------------------
  data/router.db   —— 账号池、任务状态、子密钥与日志（SQLite 数据库）
  .env             —— 面板主口令（API_KEY）、凭据加密密钥（CREDENTIAL_KEY）及可选 PORT 配置

  ⚠️ 换电脑迁移时，请务必将 .env 和 data/ 文件夹**一起**复制（丢失 CREDENTIAL_KEY 将无法解密已存账号）。

  常用命令参数：
    node start-local.mjs --port 8080      # 指定固定端口（也可在 .env 中写 PORT=8080）
    node start-local.mjs --host 0.0.0.0   # 允许局域网其他设备访问
    node start-local.mjs --no-open        # 启动后不自动弹出浏览器
`,
  'utf8',
)

// ⑤ 硬门禁：严禁携带任何密钥、数据库、源码或依赖目录
const FORBIDDEN = ['.env', 'data', 'node_modules', 'src', 'tests', 'web']
for (const f of FORBIDDEN) {
  if (existsSync(join(OUT, f))) {
    console.error(`❌ 发布包里出现了禁止携带的 ${f}（可能含密钥或凭据），已中止`)
    process.exit(1)
  }
}

const looksLikeKey = (text) => {
  for (const m of text.matchAll(/sk-[A-Za-z0-9_-]{30,}/g)) {
    const s = m[0]
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return s.slice(0, 12) + '…'
  }
  return undefined
}

const TEXT_CHECK_FILES = [
  'start-local.mjs',
  'start-windows.bat',
  'start-mac-linux.sh',
  'update-local.mjs',
  'update-windows.bat',
  'update-mac-linux.sh',
  'VERSION',
  'README.txt',
  'dist/server.mjs',
]

for (const f of TEXT_CHECK_FILES) {
  const hit = looksLikeKey(readFileSync(join(OUT, f), 'utf8'))
  if (hit !== undefined) {
    console.error(`❌ ${f} 内检测到疑似真实 API Key（${hit}），已中止`)
    process.exit(1)
  }
}

// ⑥ 写入跨平台标准 ZIP（带 Unix 0755 / 0644 外部权限位）
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const VERSION_MADE_BY_UNIX = (3 << 8) | 20 // Host OS = 3 (Unix), Spec = 2.0 (20)

function unixModeForEntry(entryName) {
  return entryName.endsWith('.sh') || entryName.endsWith('.mjs') ? 0o100755 : 0o100644
}

function writeZip(outFile, entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)
    const unixMode = unixModeForEntry(name)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed to extract
    local.writeUInt16LE(0x0800, 6) // UTF-8 flag
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x21, 12) // mod date (1980-01-01，确定性可复现构建)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4) // Unix 属性创建者标识
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8) // UTF-8 flag
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE((unixMode << 16) >>> 0, 38) // Unix external file attributes
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  writeFileSync(outFile, Buffer.concat([...locals, centralBuf, end]))
}

function listFiles(dir, base = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? e.name : `${base}/${e.name}`
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(abs, rel))
    else out.push({ name: rel, data: readFileSync(abs), abs })
  }
  return out
}

/**
 * ⑦ 构建后自检门禁：重读磁盘上的 `.zip`，逐条解压核对 CRC32、字节一致性、Unix 权限位、LF 换行符与敏感文件零残留。
 */
function verifyBuiltZip(zipPath, expectedEntries) {
  const zipBuf = readFileSync(zipPath)
  const eocdPos = zipBuf.length - 22
  if (eocdPos < 0 || zipBuf.readUInt32LE(eocdPos) !== 0x06054b50) {
    throw new Error('ZIP 自检失败：EOCD 签名缺失')
  }
  const total = zipBuf.readUInt16LE(eocdPos + 10)
  const centralSize = zipBuf.readUInt32LE(eocdPos + 12)
  const centralOffset = zipBuf.readUInt32LE(eocdPos + 16)
  if (total !== expectedEntries.length) {
    throw new Error(`ZIP 自检失败：条目数不符（期望 ${expectedEntries.length}，实际 ${total}）`)
  }

  const expectedMap = new Map(expectedEntries.map((e) => [e.name, e.data]))
  let pos = centralOffset
  for (let i = 0; i < total; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`ZIP 自检失败：第 ${i + 1} 条 Central Header 签名错误`)
    }
    const versionMadeBy = zipBuf.readUInt16LE(pos + 4)
    const method = zipBuf.readUInt16LE(pos + 10)
    const expectedCrc = zipBuf.readUInt32LE(pos + 16)
    const compSize = zipBuf.readUInt32LE(pos + 20)
    const uncompSize = zipBuf.readUInt32LE(pos + 24)
    const nameLen = zipBuf.readUInt16LE(pos + 28)
    const extraLen = zipBuf.readUInt16LE(pos + 30)
    const commentLen = zipBuf.readUInt16LE(pos + 32)
    const extAttr = zipBuf.readUInt32LE(pos + 38)
    const localOffset = zipBuf.readUInt32LE(pos + 42)
    const entryName = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen

    if (entryName.includes('\\') || entryName.includes('..') || !entryName.startsWith('free-llm-router-local/')) {
      throw new Error(`ZIP 自检失败：非法条目路径 ${entryName}`)
    }
    if (/(^|\/)(\.env|data|node_modules|router\.db)(\/|$)/i.test(entryName)) {
      throw new Error(`ZIP 自检失败：发现敏感残留条目 ${entryName}`)
    }
    if (versionMadeBy !== VERSION_MADE_BY_UNIX) {
      throw new Error(`ZIP 自检失败：${entryName} 的 versionMadeBy 非 Unix 标识 (0x${versionMadeBy.toString(16)})`)
    }
    const expectedMode = unixModeForEntry(entryName)
    const actualMode = extAttr >>> 16
    if (actualMode !== expectedMode) {
      throw new Error(
        `ZIP 自检失败：${entryName} 权限位错误（期望 0o${expectedMode.toString(8)}，实际 0o${actualMode.toString(8)}）`,
      )
    }

    if (zipBuf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 自检失败：${entryName} Local Header 签名错误`)
    }
    const lNameLen = zipBuf.readUInt16LE(localOffset + 26)
    const lExtraLen = zipBuf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const slice = zipBuf.subarray(dataStart, dataStart + compSize)
    const raw = method === 0 ? Buffer.from(slice) : method === 8 ? inflateRawSync(slice) : null
    if (!raw) {
      throw new Error(`ZIP 自检失败：${entryName} 未知压缩方式 ${method}`)
    }
    if (raw.length !== uncompSize) {
      throw new Error(`ZIP 自检失败：${entryName} 解压大小不一致`)
    }
    if (crc32(raw) !== expectedCrc) {
      throw new Error(`ZIP 自检失败：${entryName} CRC32 校验不匹配`)
    }
    const sourceBuf = expectedMap.get(entryName)
    if (!sourceBuf || Buffer.compare(raw, sourceBuf) !== 0) {
      throw new Error(`ZIP 自检失败：${entryName} 解压内容与源文件逐字节比对不一致`)
    }
    if (entryName.endsWith('.sh') && raw.includes(0x0d)) {
      throw new Error(`ZIP 自检失败：${entryName} 含有 CR (\\r) 字符，必须在 Linux/macOS 下保持纯 LF`)
    }
  }
}

console.log('🗜  压缩并写入 Unix 可执行权限位...')
const zipName = `free-llm-router-local-v${version}.zip`
const zipPath = join(ROOT, 'release-local', zipName)
const entries = listFiles(OUT).map((f) => ({
  name: `free-llm-router-local/${f.name}`,
  data: f.data,
}))

writeZip(zipPath, entries)
verifyBuiltZip(zipPath, entries)

console.log(`✅ 构建后自检通过（${entries.length} 个文件 CRC32 / Unix 权限位 / 敏感数据零残留全部核验无误）`)
console.log(`✅ 完成 → release-local/${zipName}`)
