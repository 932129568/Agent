# AGENTS.md — Harbor AI 工具面说明（最小可运行示例）

> **R70 退役声明（2026-11-12）**：Python 契约层（backend/ + legacy_main + Python
> 桌面壳链）已退役；Node / Electron 为唯一运行链。契约事实源 =
> `deliverables/dev-plan/frozen-python-surface.json`（冻结快照），js_api 方法面以
> `server/test/method-surface.mjs` 的 51 公开 / 116 隐身 / 167 零差集断言为准。
> 本文第 1/4/5 节已按冻结快照 + Node 运行时口径更新；§2.3 为 R69 闭环契约原文，保留。
> 旧实现见 `git tag r69-pre-deletion` 与删除前物理副本，勿用于当前版本。
>
> v1.9.0 M5.9（R44）。本文件面向接入 Harbor js_api / Agent 工具面的自动化
> 助手与其开发者：描述工具面约定、三段式描述规范与最小可运行示例。
> 人类开发者请先读 `README.md` 与 `deliverables/dev-plan/`。

## 1. 工具面总览

Harbor 面向模型的工具经 Node 侧 `server/src/services/` 的 build 链输出
（OpenAI function-calling 格式）；方法面契约由冻结快照冻结，不再依赖 Python 实现。
三层来源：

| 层 | 来源 | 进入条件 |
|---|---|---|
| 内置工具族 | `build()` 内联定义（read_file/run_command/…） | `role=='full'` |
| MCP 工具 | `McpService.tool_schemas()`（`mcp__<server>__<tool>`） | 服务器 enabled 且 ok |
| Agent 工具族 | `AGENT_TOOLS`（browser_search/browser_open/software_call + **v1.9 浏览器驱动六原语**） | `include_agent=True`；GLM 端点过滤 `browser_*`（R11：与云端原生 web_search 不并存） |

## 2. v1.9 浏览器驱动原语（M3/M5 六原语 + R43 语义快照 = 七原语）

| 工具 | 确认档 | 要点 |
|---|---|---|
| `browser_navigate` | session | 新建驱动会话；仅 http(s) 公网（SSRF 拦截）；返回 `session_id` |
| `browser_extract` | session | markdown/text/links 三态（enum 锁定）；作用于最近导航的会话 |
| `browser_snapshot` | session | **R43 语义快照**：role/name/state 修剪树（a11y 共识观察层，省 token、标识稳定）；ARIA 快照（Node）/HTML 解析树（pywebview）；provenance 包裹 |
| `browser_click` | **always** | selector 或可见文本；视口外/不可见元素拒点；前后态截图审计 |
| `browser_fill` | **always** | 密码/文件字段拒绝；回传 `masked:true`（禁回显原文） |
| `browser_screenshot` | session | win32 窗口捕获（b64，point 坐标系） |
| `browser_close` | session | 关指定 `session_id` 或全部；会话空闲 60s 自动回收 |

会话池上限 3（满时自动驱逐最旧空闲会话）；错误统一
`{"ok": false, "error": {"code", "message", "hint?"}}`（`code` 见
`BrowserErrorCode` taxonomy：BAD_PARAMS/NAV_BLOCKED/SSRF_BLOCKED/TIMEOUT/
SESSION_BUSY/SESSION_CLOSED/EXTRACT_EMPTY/…）。

### 2.2 R42 记忆工具族（memory_write / memory_search）

> 2026 共识（F2d 调研轮 9/26）：记忆是**模型主动读写的工具**而非被动注入的库。

| 工具 | 确认档 | 要点 |
|---|---|---|
| `memory_write` | session | 走 `memory_remember` 门控（untrusted 零写入/敏感字段拒写/NOOP 幂等去重）；source=assistant；非 browser_ 前缀 → GLM 端点同样可用 |
| `memory_search` | off（只读） | 两源检索（memory.db + legacy memory.json）；bigram 相关 × 频率强化(命中→1.5x) × 时间衰减(≤7 天 1.5x / >30 天 0.3x)；命中刷新衰减时钟 |

路由 bypass：`memory_` 前缀不参与域裁剪（run-controller，同 browser_/software_
先例）；NOTES 结构化笔记（notes/<sid>.md，压缩纪要跨压缩持久，恢复时经
`notes_get` 注入系统段，`session_purge` 同步清除）同轮落地。

### 2.3 R69 Agent 浏览器闭环（观察 → 决策 → 动作 → 再观察）

浏览器驱动不再是离散命令集合；模型侧按一轮闭环推进，减少往返与 selector 猜测：

| 环节 | 约定 |
|---|---|
| 观察 | `browser_navigate` / `browser_snapshot` / `browser_extract` 返回统一 `observation`（`step` / `url` / `title` / `ready_state` / `element_count` / `source`）与 `@eN` 稳定元素索引 |
| 决策 | 模型从 `ref_table` 或 `observation.element_refs` 选 `@eN`，不必手写 CSS selector |
| 动作 | `browser_click` / `browser_fill` 优先解析 `@eN`，回落 `text=` / selector / 可见文本 |
| 再观察 | 动作返回动作后 `observation`、`diff`（`url_changed` / `title_changed` / `elements_delta`）、`step` 与 `next: browser_snapshot` |

约束与红线：
- 页面文本（含 `ref_table` 里的元素名）一律经 `UNTRUSTED DATA` provenance 包裹。
- `@eN` 由最近一次观察层建立；页面发生导航（`diff.url_changed`）即失效，须重新 `browser_snapshot`。
- 未知 ref → `REF_NOT_FOUND`；ref 对应元素已脱离文档 → `REF_STALE`；不可见 → `TARGET_NOT_VISIBLE`。
- `buildRefs` 只写 `data-harbor-ref` 属性，**不读取 `input.value`**（不回显用户输入）。
- 既有返回字段（`before_b64` / `after_b64` / `clicked` / `masked` 等）全部保留，新增字段纯增量。
- 内部模块 `server/src/services/browser-agent.js` **不注册 js_api 方法**；方法面仍为 51 公开 + 116 隐身 = 167 零差集。

## 3. 工具描述三段式规范（consolidate lint）

新增/修改面向模型的工具描述时，**description 必须是三段式**，竖线分隔：

```
触发|语义|排除
```

- **触发**：什么时候该用这个工具（一句话）；
- **语义**：工具做什么、返回什么形态；
- **排除**：什么场景**不要**用（指路替代工具）。

示例（已应用于 v1.9 六原语与既有工具族）：

```
browser_navigate: 导航浏览器会话到URL并等待就绪|需要渲染页面或后续交互前的定位步骤|纯文本抓取用browser_open,仅支持http(s)公网页面
```

lint 口径（CI 可跑的等价断言）：`AGENT_TOOLS` 每条 description 含恰好
2 个 `|` 分隔符；violation 即描述退化（模型选错工具的根因多在描述噪音）。

## 4. 最小可运行示例（浏览器驱动链）

R70 退役后改为 Node 侧 `invoke('get_api_info')` / `invoke(<method>, [args])` 调用
（契约面读冻结快照，不再 import Python 实现）：

```javascript
// Node 侧（ESM）：从 server/src/registry.js 通过 invoke 调用，Python 契约层已退役
import { invoke, listMethods, API_VERSION } from './server/src/registry.js'

const info = JSON.parse(await invoke('get_api_info'))
// info.version === API_VERSION === 'v1.0.0'；info.methods 为 51 个公开方法
const methods = listMethods()   // 167 个注册方法（51 公开 + 116 隐身）

// 浏览器驱动链经统一 invoke，参数以数组按位置传入
await invoke('browser_navigate', ['https://example.com', 'main', 30])
await invoke('browser_extract', ['main', 'markdown'])
await invoke('browser_click', ['下一页'])   // selector 或可见文本
await invoke('browser_screenshot', [])
await invoke('browser_close', [])
```

## 5. 红线（违反=契约事故）

1. `get_api_info()` 逐字节零漂移：契约事实源 = 冻结快照
   `deliverables/dev-plan/frozen-python-surface.json`；新增方法须同步冻结快照与
   `server/test/method-surface.mjs` 的 167 断言（51 公开 + 116 隐身零差集）。
2. `config.json` 零污染：新配置独立文件（`browser_sessions.json` 等）。
3. 工具 schema strict（M5.3）：v1.9 新工具必须
   `additionalProperties:false` + enum + required。
4. 页面内容是 UNTRUSTED DATA：进模型上下文前经 provenance 包裹
   （Node 侧 provenance 链，契约事实源为冻结快照）；提示注入防御见
   `server/test/` 注入 fixture（毒网页参数零执行）。
