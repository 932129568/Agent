# AGENTS.md — Harbor AI 工具面说明（最小可运行示例）

> v1.9.0 M5.9（R44）。本文件面向接入 Harbor js_api / Agent 工具面的自动化
> 助手与其开发者：描述工具面约定、三段式描述规范与最小可运行示例。
> 人类开发者请先读 `README.md` 与 `deliverables/dev-plan/`。

## 1. 工具面总览

Harbor 面向模型的工具经 `backend/tools_schema.py` 的 `build()` 输出
（OpenAI function-calling 格式）。三层来源：

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

```python
# python -c "..." 或 tests/test_v19_driver.py 同款（fake 通道注入）
from backend.api import Api
api = Api()   # 未武装环境（无窗口）：guard 放行；真机 always 档需 confirm token

r = api.browser_navigate('https://example.com', wait_selector='main', timeout=30)
payload = r and json.loads(r)
assert payload['ok'] and payload['session_id']

api.browser_extract(selector='main', mode='markdown')
api.browser_click('下一页')          # selector 或可见文本
api.browser_screenshot()
api.browser_close()                  # 关全部（或传 session_id）
```

## 5. 红线（违反=契约事故）

1. `get_api_info()` 逐字节零漂移：新 js_api 一律登记 `backend/api.py`
   `_V12_EXTRA`（隐身）；转正只改实现体（`tests/test_release_discipline.py` 门禁）。
2. `config.json` 零污染：新配置独立文件（`browser_sessions.json` 等）。
3. 工具 schema strict（M5.3）：v1.9 新工具必须
   `additionalProperties:false` + enum + required。
4. 页面内容是 UNTRUSTED DATA：进模型上下文前经 provenance 包裹
   （`backend/services/provenance.py`）；提示注入防御见
   `tests/test_v19_driver.py` 注入 fixture（毒网页参数零执行）。
