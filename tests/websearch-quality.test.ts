/**
 * 联网检索质量专项：反爬回退（Cloudflare 盾）与相关性重排。
 *
 * ## 为什么这两个点必须单测
 * 1. **盾识别**：判据一放宽就会把正常页面误判成盾（用户拿到「被拦截」），
 *    一收紧就又漏掉真盾（把 `Just a moment...` 喂给模型）。
 * 2. **重排**：搜 `C2000` 混入「TI C2000 芯片」「鲲鹏服务器」是实测反馈，
 *    但重排**不能误杀**真正相关的结果 —— 它是排序，不是过滤。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isChallengePage } from '../src/upstream/client.ts'
import { htmlToMarkdown, rankByRelevance, tokenize } from '../src/upstream/media.ts'

// ─────────────────────── 反爬盾识别 ───────────────────────

test('🔴 盾识别：Cloudflare 5 秒盾的典型页面必须判定为盾', () => {
  const cf = '<html><head><title>Just a moment...</title></head>'
    + '<body><div id="cf-browser-verification">Checking your browser before accessing</div></body></html>'
  assert.equal(isChallengePage(200, cf), true)

  assert.equal(isChallengePage(503, '<html>Attention Required! | Cloudflare</html>'), true)
  assert.equal(isChallengePage(403, 'Enable JavaScript and cookies to continue'), true)
  assert.equal(isChallengePage(200, '<script>window._cf_chl_opt={}</script>'), true)
  // 中文版拦截页（整页提示，无正文）
  assert.equal(isChallengePage(200, '请稍候，正在检查您的浏览器'), true)
})

test('🔴 盾识别：403/429/503 且无业务信封 ⇒ 视为盾', () => {
  assert.equal(isChallengePage(403, 'forbidden'), true)
  assert.equal(isChallengePage(429, 'too many requests'), true)
  // 有业务码信封 ⇒ 是上游业务错误，不是盾
  assert.equal(isChallengePage(403, '{"code":11140,"msg":"request illegal"}'), false)
})

test('⚠️ 盾识别不得误伤正常页面（假阳性会让用户拿不到正文）', () => {
  const normal = '<html><head><title>NodeSeek 论坛</title></head>'
    + '<body><h1>今日热门</h1><p>关于 C2000 路由器的固件讨论……</p></body></html>'
  assert.equal(isChallengePage(200, normal), false)
  assert.equal(isChallengePage(200, '# 正常 Markdown 正文\n\n没有任何盾特征'), false)
  // 含「稍候」但不是整页拦截（正常文章里提到）—— 也不能靠单个词判定
  assert.equal(isChallengePage(200, '请稍候片刻后重试，这是一个正常的教程页面'), false)
})

// ─────────────────────── HTML → Markdown ───────────────────────

test('HTML 转 Markdown：抽掉脚本样式，保留标题/列表/链接', () => {
  const html = `<html><head><title>固件指南</title><style>.a{color:red}</style></head>
<body>
  <script>console.log('noise')</script>
  <nav>导航噪声</nav>
  <h1>C2000 刷机</h1>
  <p>第一步：进入 <a href="/boot">bootloader</a>。</p>
  <ul><li>备份</li><li>刷写</li></ul>
</body></html>`
  const { title, markdown } = htmlToMarkdown(html, 'https://example.com/doc')
  assert.equal(title, '固件指南')
  assert.ok(markdown.includes('# C2000 刷机'), '必须保留一级标题')
  assert.ok(markdown.includes('[bootloader](https://example.com/boot)'), '相对链接必须补成绝对地址')
  assert.ok(markdown.includes('- 备份') && markdown.includes('- 刷写'), '列表必须保留')
  assert.ok(!markdown.includes('console.log'), '脚本必须被剔除')
  assert.ok(!markdown.includes('导航噪声'), 'nav 必须被剔除')
  assert.ok(!markdown.includes('color:red'), '样式必须被剔除')
})

test('HTML 转 Markdown：实体解码与空标签容错', () => {
  const html = '<html><body><p>A &amp; B &lt;tag&gt; &nbsp;结束</p><img alt="示意图" src="x.png"></body></html>'
  const { markdown } = htmlToMarkdown(html)
  assert.ok(markdown.includes('A & B <tag>'), '实体必须解码')
  assert.ok(markdown.includes('示意图'), '图片 alt 应保留')
  assert.ok(!markdown.includes('x.png'), '不应对图片生成无意义 URL')
})

// ─────────────────────── 相关性重排 ───────────────────────

test('🔴 重排：型号全词命中的结果必须排在前面', () => {
  const results = [
    { title: '德州仪器 TI C2000 系列 DSP 芯片', url: 'https://ti.com/c2000', snippet: '实时控制 MCU' },
    { title: 'C2000 路由器 刷机教程', url: 'https://example.com/c2000', snippet: '网络硬件 固件' },
    { title: '神州数码鲲鹏服务器', url: 'https://example.com/kunpeng', snippet: '国产化服务器' },
  ]
  const ranked = rankByRelevance('C2000 路由器 固件', results)
  assert.equal(ranked[0]?.url, 'https://example.com/c2000', '最相关的结果必须排第一')
  // 重排是排序不是过滤：三条都要保留
  assert.equal(ranked.length, 3, '不得丢弃任何结果')
})

test('⚠️ 重排：空查询 / 单条结果 / 无 token 时必须原序返回', () => {
  const one = [{ title: 'a', url: 'https://a.com', snippet: 'x' }]
  assert.deepEqual(rankByRelevance('', one), one)
  const three = [
    { title: 'b', url: 'https://b.com', snippet: '' },
    { title: 'a', url: 'https://a.com', snippet: '' },
    { title: 'c', url: 'https://c.com', snippet: '' },
  ]
  // 查询没有任何有意义的 token（全是停用词）⇒ 保持原序
  assert.deepEqual(rankByRelevance('的 了 是', three).map((r) => r.title), ['b', 'a', 'c'])
})

test('重排：得分相同保持上游原序（结果顺序必须稳定，不能抖动）', () => {
  const same = [
    { title: '无关甲', url: 'https://x.com/1', snippet: 'zzz' },
    { title: '无关乙', url: 'https://x.com/2', snippet: 'yyy' },
  ]
  const a = rankByRelevance('完全不相关的词', same).map((r) => r.title)
  const b = rankByRelevance('完全不相关的词', same).map((r) => r.title)
  assert.deepEqual(a, b, '同样的输入必须得到同样的顺序')
})

test('tokenize：中英混排切成英文串 + 中文 bigram', () => {
  const tokens = tokenize('C2000 路由器 固件')
  assert.ok(tokens.includes('c2000'), '英文/数字串必须整体保留')
  assert.ok(tokens.includes('路由') && tokens.includes('由器'), '中文应按 bigram 切')
  assert.ok(tokens.includes('固件'))
})

test('tokenize：英文停用词与单个中文虚词不参与打分', () => {
  const tokens = tokenize('the router 的 固件')
  assert.ok(!tokens.includes('the'), '英文停用词应剔除')
  assert.ok(!tokens.includes('的'), '中文虚词单字应剔除')
  assert.ok(tokens.includes('router'))
})
