# 从开源项目补齐功能的操作手册

> 建立时间：2026-11-05
> 适用场景：上游接口不公开、文档缺失，而社区已有实测结论时

---

## 零、先读这条：为什么必须找开源项目

腾讯的 WorkBuddy / CodeBuddy **没有公开 API 文档**。我们每一个接口都是逆出来的。
逆向有两条路：

| 路子 | 代价 | 可靠性 |
|---|---|---|
| **自己抓包** | 需要装官方客户端 + 抓包工具 + 反复试 | 最高，但要花时间 |
| **读社区代码** | 几乎免费 | 高（别人已实测过），但要**核对时效** |

本项目 90% 的判据来自社区代码。**不读社区 = 每一个坑都要自己踩一遍。**

---

## 一、第一步：找到项目

### 1.1 GitHub 搜索（按关键词，不要搜项目名）

```bash
# 主战场
https://github.com/search?q=workbuddy2api&sort=updated&type=repositories
https://github.com/search?q=codebuddy+checkin&sort=updated&type=repositories
https://github.com/search?q=workbuddy+api+proxy&sort=updated&type=repositories
```

⚠️ **一定按 `updated` 排序**。这类项目死得很快 —— 上游一收紧，作者就停更。

### 1.2 API 方式（可脚本化）

```bash
curl -s "https://api.github.com/search/repositories?q=workbuddy2api&sort=updated&order=desc&per_page=20" \
  | jq '.items[] | {full_name, stargazers_count, pushed_at, language}'
```

关键看 **`pushed_at`**：

| 最后推送 | 判断 |
|---|---|
| 7 天内 | ✅ **优先读这家** —— 说明还在跟上游 |
| 1 个月内 | 🟡 可读，但要核对 |
| 半年以上 | ❌ 判据大概率已失效，别抄 |

### 1.3 值得长期盯的几个（2026-11-05 快照）

| 项目 | 语言 | 为什么看它 |
|---|---|---|
| `misakano7545/workbuddy2api-panel`（854★） | Go | **最活跃**，有真机抓包夹具 `testdata/official_*_head.txt` |
| `ardeyouxipianyi/workbuddy2api-hub`（3555★） | Python | 最全（媒体/国际服/webagent），但已转低频维护 |
| `luoyechenfei/ai-checkin` | JS | 多平台签到，接口表清楚 |
| `FlapPearLabs/workbuddy-toolkit` | Python | 工程规范好，有 `incidents/` 事故复盘 |

⚠️ **star 高 ≠ 该抄**。`workbuddy2api-hub` 3.5k★ 但 10-23 起停更；`workbuddy2api-panel` 854★ 天天更新。
**看 `pushed_at`，不看 star。**

---

## 二、第二步：找到代码里那一行（不要读 README）

README 会过期、会简化。**直接读源码。**

### 2.1 列出仓库文件树

```bash
curl -s "https://api.github.com/repos/OWNER/REPO/git/trees/HEAD?recursive=1" \
  | jq -r '.tree[].path' | grep -E '\.(go|py|ts|js)$'
```

### 2.2 按功能关键词过滤文件名

```bash
# 找任务相关
... | jq -r '.tree[].path' | grep -iE 'task|growth|checkin|expert'
# 找请求头相关
... | jq -r '.tree[].path' | grep -iE 'header|client|request'
# 找媒体相关
... | jq -r '.tree[].path' | grep -iE 'image|video|media|search'
```

### 2.3 直接抓原始文件

```bash
curl -s "https://raw.githubusercontent.com/OWNER/REPO/main/internal/upstream/desktop.go"
```

⚠️ **分支名要先试 `main` 再试 `master`**，否则 404 会让你以为文件不存在。

### 2.4 用 grep 定位，不要通读

```bash
# 搜函数/常量名
curl -s .../desktop.go | grep -n "DesktopTemplateUseSequence" -A 40
# 搜 URL 路径
curl -s .../search.go | grep -nE '"/[a-z0-9/_-]+"'
# 搜事件名
curl -s .../desktop.go | grep -nE 'eventCode'
```

---

## 三、第三步：**必须先读 testdata 夹具**

这是最容易被忽略、但**价值最高**的一步。

`workbuddy2api-panel` 仓库里有：

```
internal/upstream/testdata/official_chat_head.txt        ← 真机抓的 chat 请求头
internal/upstream/testdata/official_report_cn_head.txt   ← /v2/report 的完整头
internal/upstream/testdata/official_chat_busy_head.txt
internal/upstream/testdata/official_v3config_head.txt
```

**这些是真机抓包原文，比任何代码注释都准。**

```bash
curl -s ".../git/trees/HEAD?recursive=1" | jq -r '.tree[].path' | grep -i 'testdata\|fixture'
curl -s "https://raw.githubusercontent.com/OWNER/REPO/main/internal/upstream/testdata/official_report_cn_head.txt"
```

### 我们从这里学到的最硬的事实

```
POST /v2/report HTTP/1.1
Accept: application/json, text/plain, */*
User-Agent: WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0
Host: www.workbuddy.cn        ← 注意！不是 copilot.tencent.com
```

⇒ 这一行直接推翻了我「agenttool 挂在 copilot 域」的错误假设。

---

## 四、第四步：**必须每个 realm 各测一次**

### 🔴 我犯过的错（2026-11-05，代价：差点得出「上游不支持」的错误结论）

```
用国内账号测 /agenttool/v1/search → 401
⇒ 我的结论：「上游不支持这个能力」
⇒ 实际：国际账号测同一个接口 → 200，返回真实搜索结果
```

**根因**：国内版（`www.workbuddy.cn`）和国际版（`www.workbuddy.ai`）**权限完全不同**。

| 能力 | 国内 | 国际 |
|---|---|---|
| `/agenttool/v1/search` | 401 | ✅ 200 |
| `/v2/images/generations` | 401 | ✅ 200 |
| `/v2/chat/busy` | ✅ 200 | 404 |

⇒ **纪律**：任何「接口不可用」的结论，**至少要用 2 个 realm 的账号各测一次**才能下。

---

## 五、第五步：验证的四个陷阱

### 陷阱 1：401 / 404 不等于「能力不存在」

| 现象 | 更可能的原因 |
|---|---|
| `401 <html> APISIX` | 域错了 / realm 权限不够 / 头不齐 |
| `404 {"error_msg":"404 Route Not Found"}` | 域对了但**路径版本错**（`/v1/` vs `/v2/`） |
| `404 page not found`（纯文本） | 路径**完全不存在** |

我们踩过的：
```
/v1/images/generations  → 404 Route Not Found
/v2/images/generations  → 200 ✅（正确）
```

### 陷阱 2：HTTP 200 ≠ 成功

```json
{"code": 12153, "msg": "refresh token failed: invalid_grant"}
```
HTTP 是 200，业务码是失败。**必须解 `code` 字段**。

### 陷阱 3：上报成功 ≠ 计分

这是最坑的：
```
事件上报 → HTTP 200
回读进度 → 仍是 0/1
```
**不报错、不进日志、不告警**，只是永远不涨。

我们从这踩出两个真 bug：
- `Buddy_App`：事件名写成 `buddy_app_discover`，真实是 `buddyapp_discover_click`
- `template_5`：只发 2 个孤立事件，真实要 **chat 链 + 2 事件**

⇒ **判据类的东西必须回读验证，不能只看 200。**

### 陷阱 4：任务标题 ≠ 市场里的名字

| 任务标题 | 市场真实名 |
|---|---|
| 中国电商运营专家 | **卖得好** |
| 抖音策略师 | **斗音音** |
| 商家宣传页与海报设计师 | **商家宣传设计师** |
| 直播电商教练 | **播旺旺** |

⇒ **按 ID 匹配，别按名字。**

---

## 六、第六步：抄什么、不抄什么

### ✅ 值得抄

| 类型 | 例子 |
|---|---|
| **真机抓包夹具** | `testdata/official_*_head.txt` |
| **实测结论注释** | 「三账号实测 5/5 点亮」 |
| **固定 ID 表** | `ex_2cvvUZQhDyeJ`（轻量云专家） |
| **事件名清单** | `buddyapp_*_click` |

### ❌ 别抄

| 类型 | 为什么 |
|---|---|
| 部署方式（Docker/bat/脚本） | 我们有自己的 |
| 面板 UI | 我们的更好 |
| 架构设计 | 我们是 Workers + Node 双形态，结构不同 |
| **没有 `pushed_at` 更新的项目** | 判据大概率已失效 |

### ⚠️ 抄了必须做的一件事

**在注释里写清「来源 + 实测时间 + 验证方式」**。例如：

```ts
// 事件名来源：workbuddy2api-panel/internal/upstream/desktop.go
// 实测 2026-11-05：三账号 5/5 点亮
```

半年后回头看，不说清来源的注释等于没有。

---

## 七、完整实操流程（copy 这份）

```bash
# ========== 1. 找项目 ==========
curl -s "https://api.github.com/search/repositories?q=WORKBUDDY_KEYWORD&sort=updated&per_page=15" \
  | jq -r '.items[] | "\(.pushed_at[0:10])  \(.stargazers_count)★  \(.full_name)  \(.language)"' | head -20

# ========== 2. 看文件树 ==========
curl -s "https://api.github.com/repos/OWNER/REPO/git/trees/HEAD?recursive=1" \
  | jq -r '.tree[].path' | grep -E '\.(go|py|ts)$'

# ========== 3. 先读夹具（最高价值） ==========
curl -s ".../git/trees/HEAD?recursive=1" | jq -r '.tree[].path' | grep -i testdata

# ========== 4. 按功能读源码（grep 定位，别通读） ==========
curl -s "https://raw.githubusercontent.com/OWNER/REPO/main/PATH" | grep -n "关键词" -A 40

# ========== 5. 我们这边实测验证 ==========
# ⚠️ 国内 + 国际各测一次
# ⚠️ 不只看 HTTP 200，要回读业务结果
```

---

## 八、这次补全的成果对比

| 功能 | 来源 | 我们原来 | 现在 |
|---|---|---|---|
| 4 个指定专家任务 | 任务 `jump_url` 里的 expertId | ❌ 无 | ✅ +200/天 |
| `WorkBuddy_Valorant` | `workbuddy2api-panel` 的 `runValorantExpert` | ❌ 无 | ✅ +100 |
| `Buddy_App` 事件名 | 同上 `DesktopBuddyAppSequence` | ❌ 名错，0/1 | ✅ 1/1 |
| `template_5` chat 链 | 同上 `DesktopTemplateUseSequence` | ❌ 缺链，0/5 | ✅ 5/5 |
| 生图/检索域名 | `testdata/official_report_cn_head.txt` | ❌ 域错 401 | ✅ 200 |
| MCP 协议形态 | OpenCode 官方文档 | ❌ 无 | ✅ 可用 |

---

## 九、一句话总结

> **判据类的问题（事件名、字段、域名、权限）不要靠推理，要靠样本。**
> 样本 = 真机抓包夹具 或 有 `pushed_at` 更新的社区代码。
> 而且**每个 realm 都要各测一次** —— 这是我这轮犯得最大的错。
