#!/usr/bin/env node
/**
 * 打包「本地版」发布包。
 *
 * ## 产物里有什么
 *
 * ```
 * free-llm-router-local/
 * ├── start-windows.bat       ← Windows 双击这个
 * ├── start-mac-linux.sh      ← macOS / Linux 用这个
 * ├── start-local.mjs         ← 真正的启动器
 * ├── update-local.mjs        ← 升级用（只换程序本体，不碰数据）
 * ├── dist/server.mjs         ← 单文件服务（含面板，2.6MB）
 * └── README.txt             ← 使用说明
 * ```
 *
 * ## 刻意**不**放什么
 *
 * - `node_modules/` —— 零依赖，不需要
 * - `.env` / `data/` —— **绝对不能带**：里面是发布者本人的密钥与账号凭据
 * - 源码 / 测试 / 工具脚本 —— 使用者不需要
 *
 * ⚠️ 打包前会**硬检查** `.env` 和 `data/` 没有被带进去。
 *    这不是多余：一旦带出去，别人的机器上就有你的账号凭据。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'release-local', 'free-llm-router-local')

console.log('📦 打包本地版...\n')

// ① 必须已有构建产物
if (!existsSync(join(ROOT, 'dist', 'server.mjs'))) {
  console.error('❌ 缺 dist/server.mjs —— 先跑：npm run build:web && npm run build:node')
  process.exit(1)
}

// ② 清空重建
rmSync(join(ROOT, 'release-local'), { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ③ 复制必需文件
const FILES = ['start-windows.bat', 'start-mac-linux.sh', 'start-local.mjs', 'update-local.mjs']
for (const f of FILES) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`❌ 缺 ${f}`)
    process.exit(1)
  }
  cpSync(join(ROOT, f), join(OUT, f))
}
mkdirSync(join(OUT, 'dist'), { recursive: true })
cpSync(join(ROOT, 'dist', 'server.mjs'), join(OUT, 'dist', 'server.mjs'))

// ④ 使用说明
//
// ⚠️ 文件名用 **ASCII**（`README.txt` 而不是「使用说明.txt」）：
//    zip 里的中文文件名在不同平台/工具下解码不一致，实测 Git Bash 的 unzip
//    会把「使用说明」解成乱码。文档内容仍是中文，只是文件名保持安全。
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
writeFileSync(join(OUT, 'README.txt'), `free-llm-router 本地版 v${version}
========================================

这是什么
--------
把你自己的 WorkBuddy / CodeBuddy 账号，变成一个 OpenAI 兼容的 API 网关，
附带一个网页控制台。所有数据都留在**你自己的电脑上**，不上传任何地方。


怎么用（三步）
--------------
第 1 步：安装 Node.js（只需要装一次）

  Node.js 是运行本程序的"引擎"，必须先装好。版本要 22 或更高。

  ◆ Windows
    1) 打开 https://nodejs.org/zh-cn
    2) 点绿色的大按钮下载 **LTS**（长期支持版），下载的是 .msi 安装包
    3) 双击安装，一路点「下一步」
       ⚠️ 中途有个选项叫 "Add to PATH"（添加到环境变量），**必须保持勾选**
          默认就是勾上的，不要取消
    4) 装完**重启电脑**（或者至少关掉所有命令行窗口再重开）
    5) 验证：按 Win+R，输入 cmd 回车，在黑色窗口里敲：
           node -v
       回车后如果看到类似 v22.x.x 或更高，就成功了

  ◆ macOS
    方法一（推荐，如果有 Homebrew）：
         打开「终端」，执行：brew install node
    方法二（图形安装）：
         打开 https://nodejs.org/zh-cn → 下载 LTS 的 .pkg → 双击安装
    验证：终端里敲 node -v，看到 v22.x.x 或更高即可

  ◆ Linux
    用官方源或 nvm 安装 Node 22+，装完执行 node -v 确认。
    例（Ubuntu/Debian，用 nvm）：
         curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
         nvm install 22

  ⚠️ 如果 node -v 提示"不是内部或外部命令"／"command not found"
     ⇒ 说明没装成功，或者 PATH 没生效。
     - Windows：重装一次，确认勾了 "Add to PATH"，然后重启电脑
     - Mac/Linux：关掉终端重新打开（安装后需要重载环境变量）


第 2 步：启动程序

  ◆ Windows
      双击 start-windows.bat
      （如果 Windows 弹出"已保护你的电脑"：点「更多信息」→「仍要运行」）

  ◆ macOS / Linux
      打开终端，cd 到这个文件夹，执行：
          chmod +x start-mac-linux.sh     ← 只有第一次需要
          ./start-mac-linux.sh
      （或者直接：node start-local.mjs）


第 3 步：打开控制台

  程序启动后会自动弹出浏览器。如果没弹，手动复制屏幕上显示的地址：
      http://127.0.0.1:11451/panel/
  登录口令也在同一个窗口里，复制粘贴进登录框即可。

  ⚠️ 这个黑色窗口**不能关** —— 关掉程序就停了。
     要停止时按 Ctrl+C，或直接关窗口。


第一次进来先做什么
------------------
1. 「供应商与账号」→ 添加账号（支持设备码登录 / 扫码 / 粘贴凭据）
2. 「模型」→ 看看有哪些模型可用
3. 「API Key」→ 给客户端签发一把钥匙
4. 「配置」→ 里面有接入指南（Claude Code / OpenAI SDK / Cherry Studio 等）


怎么用生图和视频
----------------
「媒体与检索」页可以直接点按钮生成图片、生成视频、联网搜索、抓网页。
注意：这三项能力**只有 WorkBuddy 国际版账号**支持，国内账号会提示
unsupported_realm。


数据在哪
--------
data/router.db   —— 账号、用量、日志（SQLite 单文件）
.env             —— 登录口令与加密密钥（首次运行自动生成）

⚠️ 备份 = 把 .env 和 data/ 一起复制走。
   ⚠️ 只备份 data/ 而丢了 .env 里的 CREDENTIAL_KEY，
      所有账号凭据都会解不开，只能重新登录。


怎么更新（重要）
----------------
这个包**不会自动更新**，需要你手动做一次。流程：

1. 去 https://github.com/NandaNg314/free-llm-router/releases 下载新版 zip
2. 解压到**任意一个新目录**（比如 free-llm-router-local-new/）
   ⚠️ 千万不要直接覆盖旧目录！那会把你的账号数据一起盖掉。
3. 打开**旧目录**的终端，执行：
      node update-local.mjs ../free-llm-router-local-new
4. 重启程序（双击 start-windows.bat / 跑 start-mac-linux.sh）

升级脚本**只替换程序本体**（dist/server.mjs 与几个启动脚本），
**绝不碰** .env 和 data/ —— 账号、密钥、用量都还在。

想回滚：脚本更新前会自动备份成 dist/server.mjs.bak-<时间戳>，
把那个文件改名回 dist/server.mjs 即可。

查当前版本：浏览器打开 http://127.0.0.1:11451/version


常见问题
--------
Q: 端口被占用？
A: 用别的端口启动：node start-local.mjs --port 8080

Q: 想给别人用（局域网）？
A: node start-local.mjs --host 0.0.0.0
   ⚠️ 这会监听所有网卡，同一局域网的人都能访问，请确认你信任他们。

Q: 关掉窗口就停了？
A: 是的，这是本地版。想要常驻可以用 Docker 或部署到服务器（见仓库 DEPLOY.md）。

Q: 更新后账号没了？
A: 正常情况不会 —— 升级脚本不碰 data/ 和 .env。
   如果真的没了，检查是不是解压时「直接覆盖」了旧目录。
   有备份的话，把 .env 和 data/ 拷回来即可恢复。
`)

// ⑤ 🔴 硬检查：绝对不能带出密钥或凭据
const FORBIDDEN = ['.env', 'data', 'node_modules', 'src', 'tests', 'web']
for (const f of FORBIDDEN) {
  if (existsSync(join(OUT, f))) {
    console.error(`❌ 发布包里出现了不该有的 ${f}（可能含密钥/凭据），已中止`)
    process.exit(1)
  }
}
// 再扫一遍文本内容里有没有明显的密钥形态
//
// ⚠️ 正则不能太宽：`dist/server.mjs` 里有 Tailwind 的 CSS 变量名
// （`--tw-gradient-from-position` 被压成 `sk-image-linear-from-pos` 之类），
// 会被 `sk-[A-Za-z0-9_-]{20,}` 误伤。
// ⇒ 真密钥的特征是**同时含大写、小写、数字**，且长度 30+（我们生成的是 32 字符 base64url）。
const looksLikeKey = (text) => {
  for (const m of text.matchAll(/sk-[A-Za-z0-9_-]{30,}/g)) {
    const s = m[0]
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return s.slice(0, 12) + '…'
  }
  return undefined
}
for (const f of ['start-local.mjs', 'update-local.mjs', 'README.txt', 'dist/server.mjs']) {
  const hit = looksLikeKey(readFileSync(join(OUT, f), 'utf8'))
  if (hit !== undefined) {
    console.error(`❌ ${f} 里疑似有 API Key（${hit}），已中止`)
    process.exit(1)
  }
}

// ⑥ 压缩
//
// ⚠️ **不能用 PowerShell 的 `Compress-Archive`** —— 它写的是**反斜杠**路径分隔符，
// 而 zip 规范要求 `/`，于是 Linux/macOS 的 `unzip` 直接报
// `appears to use backslashes as path separators` 并**解压失败**。
// （这是实测踩到的：一开始就用了 PowerShell，包发出去别人解不开。）
//
// ⚠️ 也不能依赖 `zip` 命令 —— Git Bash 里默认只有 `unzip` 没有 `zip`。
//
// ⇒ 用 Node 自己写 STORE（不压缩）格式的 zip：
//   规范简单、零依赖、跨平台都对。代价是体积大一点（本项目 2.6MB，可接受）。
import { deflateRawSync } from 'node:zlib'

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

/** 用 DEFLATE 写一个标准 zip（路径统一 `/`）。 */
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

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date（1980-01-01，固定值保证可复现）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
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

/** 递归列出目录下所有文件（相对路径用 `/`）。 */
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

console.log('🗜  压缩中...')
const name = `free-llm-router-local-v${version}.zip`
const zipPath = join(ROOT, 'release-local', name)
const entries = listFiles(OUT).map((f) => ({
  // ⚠️ 顶层目录名也要带上，解压出来才是一个文件夹而不是一堆散文件
  name: `free-llm-router-local/${f.name}`,
  data: f.data,
}))
// 保留可执行位（macOS/Linux 的 .sh 需要）—— zip 的 external attrs 在 Node 里
// 不便设置，改为在说明里提示 `chmod +x`（启动器已经会提示）。
writeZip(zipPath, entries)
console.log(`\n✅ 完成 → release-local/${name}`)
console.log(`   共 ${entries.length} 个文件`)

console.log('\n发出去之前请再过一遍：这个目录**不含**任何账号或密钥。')
