#!/usr/bin/env node
/**
 * 本地版**升级**脚本。
 *
 * ## 为什么需要它
 *
 * 发布包发给别人之后就没法更新了：让用户「重新下载、解压、覆盖」有三重风险 ——
 * 1. **覆盖掉 `.env`** ⇒ 面板口令和凭据加密密钥全变 ⇒ 所有账号解不开；
 * 2. **覆盖掉 `data/`** ⇒ 账号、用量、日志全丢；
 * 3. 用户不知道**哪些文件能覆盖**，多半整套拷过去，于是就踩了 1 和 2。
 *
 * ⇒ 把所有「该更新 / 绝不能动」的知识**写进脚本**，用户只跑一条命令。
 *
 * ## 用法
 *
 * ```bash
 * # 把新版发布包解压到旁边（比如 free-llm-router-local-new/），然后：
 * node update-local.mjs ../free-llm-router-local-new
 * ```
 *
 * 脚本只替换 `dist/server.mjs` 与几个启动脚本，**从不碰** `.env` 和 `data/`。
 */
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 会被替换的（**程序本体**）。 */
const REPLACE = [
  'dist/server.mjs',
  'start-local.mjs',
  'start-windows.bat',
  'start-mac-linux.sh',
  'update-local.mjs',
  'README.txt',
]

/**
 * **绝不能覆盖**的（用户数据）。
 *
 * ⚠️ 这不是可选项：`.env` 里有 `CREDENTIAL_KEY`，它是加密账号凭据的密钥。
 *    覆盖 ⇒ 所有已保存的账号解不开，只能逐个重新登录。
 */
const PROTECTED = ['.env', 'data']

const srcDir = process.argv[2]
if (srcDir === undefined) {
  console.error(
    '\n用法：node update-local.mjs <新版目录>\n\n'
    + '  把新版发布包解压到任意位置（例如 free-llm-router-local-new/），\n'
    + '  然后把那个目录路径传进来。脚本只更新程序本体，不碰你的账号数据。\n',
  )
  process.exit(1)
}

const SRC = resolve(srcDir)
if (!existsSync(SRC)) {
  console.error(`\n❌ 目录不存在：${SRC}\n`)
  process.exit(1)
}
if (!existsSync(join(SRC, 'dist', 'server.mjs'))) {
  console.error(
    `\n❌ ${SRC} 里没有 dist/server.mjs —— 这不像是一个发布包。\n`
    + '   请确认传的是**解压后的**新版目录。\n',
  )
  process.exit(1)
}

// 自我保护：不能指向自己，否则等于什么都没做
if (resolve(SRC) === resolve(HERE)) {
  console.error('\n❌ 源目录和目标目录相同，没有可更新的内容。\n')
  process.exit(1)
}

/** 取文件版本号（从 panel 里嵌的版本串猜）。 */
function guessVersion(dir) {
  try {
    const t = readFileSync(join(dir, 'dist', 'server.mjs'), 'utf8')
    const m = t.match(/v(\d+\.\d+\.\d+)/)
    return m?.[1] ?? '未知'
  } catch {
    return '未知'
  }
}

const before = guessVersion(HERE)
const after = guessVersion(SRC)

console.log('')
console.log('  free-llm-router · 本地版升级')
console.log('  ─────────────────────────────────────')
console.log(`  当前版本   v${before}`)
console.log(`  目标版本   v${after}`)
console.log(`  源目录     ${SRC}`)
console.log('')

// 记录源文件指纹，更新后核对（防止「拷了一半」）
const hashOf = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : '')

const plan = []
for (const rel of REPLACE) {
  const from = join(SRC, rel)
  const to = join(HERE, rel)
  if (!existsSync(from)) {
    plan.push({ rel, action: 'skip', why: '新版里没有这个文件' })
    continue
  }
  const same = existsSync(to) && hashOf(from) === hashOf(to)
  plan.push({ rel, action: same ? 'same' : 'copy', from, to })
}

// 打印计划，让用户看清将要发生什么
for (const p of plan) {
  const mark = p.action === 'copy' ? '更新' : p.action === 'same' ? '相同' : '跳过'
  console.log(`  [${mark}] ${p.rel}`)
}

// 明确告诉用户哪些**不会**被碰（这是他们最担心的）
const present = PROTECTED.filter((f) => existsSync(join(HERE, f)))
console.log('')
console.log('  以下内容**不会被修改**：')
if (present.length === 0) {
  console.log('    （当前还没有 .env / data，首次运行会自动创建）')
} else {
  for (const f of present) console.log(`    ✅ ${f}`)
}

const changed = plan.filter((p) => p.action === 'copy')
if (changed.length === 0) {
  console.log('\n  已经是最新版本，无需更新。\n')
  process.exit(0)
}

// 更新前给旧程序留一份（出问题能立刻回滚）
const backup = join(HERE, `dist`, `server.mjs.bak-${Date.now()}`)
if (existsSync(join(HERE, 'dist', 'server.mjs'))) {
  copyFileSync(join(HERE, 'dist', 'server.mjs'), backup)
  console.log(`\n  已备份旧程序 → ${basename(backup)}`)
}

for (const p of changed) {
  copyFileSync(p.from, p.to)
}

// 核对：每个复制过去的文件都要和目标一致
const bad = changed.filter((p) => hashOf(p.from) !== hashOf(p.to))
if (bad.length > 0) {
  console.error(`\n❌ 以下文件复制后校验不一致：${bad.map((b) => b.rel).join('、')}`)
  console.error(`   可以把 ${basename(backup)} 改名回 server.mjs 回滚。\n`)
  process.exit(1)
}

console.log('\n  ✅ 更新完成。')
console.log('     重启本地版即可生效（双击 start-windows.bat / 跑 start-mac-linux.sh）。')
console.log(`     若新版有问题，把 dist/${basename(backup)} 改名回 dist/server.mjs 即可回滚。`)
console.log('')
// statSync 只为确保 import 被用到（未来可能读 mtime 做校验）
void statSync
