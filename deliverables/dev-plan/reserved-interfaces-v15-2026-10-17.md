# GLM-Chat v1.5 预留接口设计说明（接口预留位置全图）

**日期**：2026-10-17
**类型**：工程文档（预留接口层交付物）
**基线**：v1.4.0（364 测试全绿 + UI 契约 PASS）
**范围**：按迭代路线图（roadmap-local-llm-mcp-2026-10-17）一次性覆盖 v1.5.0 本地模型（连接层 A + 适配层 B）、v1.5.1 MCP 稳定性与速度专项（S1-S5）、v1.6.0 WebDAV 数据主权的**接口契约与占位实现**。完整功能实现按各版本周期落地，本层保证「签名/返回 shape/错误码」终态，后续只填内部实现。

---

## 0. TL;DR

- **一句话**：三个新服务文件 + 7 个隐身 js_api + 1 个既有方法扩展 + 前端 3 个新模块，把 v1.5/v1.5.1/v1.6 全部计划项的接口面一次性落地；实现分「就绪」（连接层 A / 纯函数判定 / 池内核）与「预留占位」（IO 编排 / 传输接线 / WebDAV 执行器）两档。
- **契约零变更**：`get_api_info` 逐字节不动（新方法全部登记 `_V12_EXTRA`）；config.json 零污染（local_* 运行期合法、测试期不触发；webdav 凭证走独立文件）；UI 契约只增不改（check_contract.py PASS）。
- **测试**：`tests/test_v15_reserved.py` 87 项全绿；全量 364+87 基线。

---

## ⚡ 更新记录（2026-10-17 晚：「预留未接项全量接线」）

用户裁决「遗留项在这一版一起做完」，原「预留占位」档全部落地：

| 原占位项 | 落地内容 | 测试 |
|---|---|---|
| B1 上下文自适应压缩接线 | `autoCompactThreshold` local 分支 = 窗口×比例（34-local-model.js 前端同口径 `compactThresholdLocal`，与后端 `compact_threshold` 一字不差） | test_v15_wire.TestB1（阈值矩阵 12 断言） |
| B2 去 tools 重发 | 60-agent-loop 400 双降级链（thinking→tools），`local_tool_capable=off` 根本不发 tools + 提示 | test_v15_wire.TestB2 |
| B3 流式 watchdog | 首字节 >5s「本地推理中（已等待 Ns）」秒级更新 + idle 120s 停滞提示（并发 interval，函数级清理）+ local max_tokens 默认 4096 | 源码级（60-agent-loop） |
| B4 Ollama 特情 | `humanizeApiError(msg, isLocal)` 本地分支（503 loading/404 引导/401 免 Key）+ fetchGLMStream 503 指数退避 [2,4,8] | test_v15_wire.TestB4 |
| B5 MCP 保守策略 | local 模式确认框追加 MCP_LOCAL_CAUTION + 会话信任降级仅本任务有效 | 源码级（62-mcp-exec） |
| S1 HTTP 连接池 | `HttpTransport._post_pooled`（per host:port 复用/keep-alive/空闲 60s 回收/错误不污染池）；no-redirect（3xx 显式拒）/协议头覆盖/会话头回收/32MB 防 OMM 上限逐条保留；宿主替换 urlopen（测试桩）自动回落原路径 | test_v15_wire.TestS1PooledLoop（真实回环：复用/SSE/302 拒/错误不污染） |
| S2 stdio 温启 | `_spawn_client` 打点 spawn_ms；`_get_or_spawn` 温启优先（warm 命中活 client 跳过 spawn）；list_servers 透出 warm/spawn_ms；**设计修正**：IDLE 到期直接关（不停留 warm 续期——防停用服务器子进程多留 600s），warm 只承担启用预热索引 | test_v15_wire.TestS2Warm + test_idle_recycle 回归 |
| WebDAV IO 执行器 | 五方法接真：OPTIONS+PROPFIND 测试 / MKCOL+PUT 导出 / GET+manifest 恢复；**设计修正**：manifest sha 退位为三方基线（原对拍硬拒会误杀远端正常演进），完整性改落盘后对拍；冲突四策略（ask/local_wins/remote_wins/keep_both）+ 路径穿越防护 + DPAPI 凭证 | test_v15_wire.TestWebdavExecutor（本地 DAV 回环 8 用例） |

**测试基线**：全量 **477 passed**（459 + test_v15_wire 18 新增）；check_contract PASS；build 40 模块幂等。

---

## 1. 后端预留接口位置

### 1.1 新增服务文件

| 文件 | 覆盖计划项 | 状态 |
|---|---|---|
| `backend/services/local_model_service.py` | v1.5.0 A1-A5 + B1-B5 判定 | 连接层 A **实现就绪**；适配层 B 判定就绪、主链路编排预留 |
| `backend/services/webdav_service.py` | v1.6.0 配置/备份/冲突 | 校验与冲突判定就绪；IO 执行器 reserved 占位 |
| `backend/services/mcp_pool.py` | v1.5.1 S1-S5 | 池内核/并发限流/stale/退避 **实现就绪且已单测**；与 HttpTransport 接线预留 |

### 1.2 js_api 门面（`backend/api.py`，全部 `_V12_EXTRA` 隐身）

| 方法 | 签名 | 覆盖 | 状态 |
|---|---|---|---|
| `local_probe(ports=None)` | ports: JSON 数组字符串 \| None | A2 并行探测 | 就绪（ThreadPoolExecutor + urlopen_no_redirect） |
| `local_models(base_url)` | base_url: str | A3 模型清单（元数据内嵌） | 就绪（三形态解析） |
| `test_provider_endpoint(base_url, api_key, model, timeout=15, local=False)` | +local 标志 | A5 本地测试连接 | 就绪（免 Key/30s/loading 态） |
| `webdav_get_config()` | — | v1.6 | reserved |
| `webdav_save_config(cfg_json)` | cfg: JSON | v1.6 | 校验就绪，落盘 reserved |
| `webdav_test(cfg_json)` | cfg: JSON | v1.6 | reserved |
| `webdav_export()` | — | v1.6 | 导出计划就绪，上传 reserved |
| `webdav_restore(payload_json)` | manifest: JSON | v1.6 | manifest 校验就绪，恢复 reserved |

### 1.3 关键类型定义（返回 shape，终态）

- **探测**：`{ok, reachable:[{base_url, kind, reachable, models[], latency_ms, error?}], unreachable[], elapsed_ms}`
- **清单**：`{ok, base_url, models:[{id, ctx_window, tool_capable, estimated}]}`（未知模型保守 8192 + estimated）
- **错误分类**（`classify_local_error`）：`{kind: loading|model_not_found|context_length|tools_unsupported|generic, message, retryable, retry_after?}`；loading 退避 `[2,4,8]` 上限 120s
- **压缩阈值**（B1）：`compact_threshold(ctx, level)` = 窗口 × {aggressive:.4, std:.6, relaxed:.8}；GLM 128k×.6≈76.8k 衔接现标准档
- **冲突分类**（`classify_conflicts`）：`{unchanged[], only_local[], only_remote[], conflicts:[{path, local_sha, remote_sha, baseline_sha}]}`
- **池配置**（mcp_servers.json 每服务器可选键）：`keep_alive(bool, 默认 true)` / `max_concurrency(1-8, 默认 4)` / `warm_on_enable(bool, 默认 true)`——`mcp_config_service._normalize` 已校验，`list_servers` 仅在显式配置时透出

### 1.4 配置键（运行期合法、测试期不触发）

- config.json：`local_mode` / `local_preset` / `local_base_url` / `local_model` / `local_ctx_window` / `local_tool_capable`（经 `collectConfig → save_config` 合并；`validate_local_prefs` 只验证不落盘）
- mcp_servers.json：`keep_alive` / `max_concurrency` / `warm_on_enable`（可选，老配置零影响）
- webdav.json（v1.6 正式版）：`url`(https 强制，localhost 除外) / `username` / `password`(DPAPI) / `remote_path` / `auto_sync` / `conflict_policy`(ask/local_wins/remote_wins/keep_both)

---

## 2. 前端预留接口位置

| 文件 | 内容 |
|---|---|
| `frontend/src/00-motion.js` | MOTION 常量表（CSS 变量单一事实源，v4 动效体系配套） |
| `frontend/src/34-local-model.js` | 本地模式 UI：预设/探测/清单/元数据徽标/无 Key 测试；`localState` 状态；`collectLocalConfig/applyLocalConfig` |
| `frontend/src/37-webdav.js` | WebDAV 预留 UI：配置收集/测试/导出计划渲染 |
| `frontend/index.template.html` | 新增 2 个 set-block（本地模型 / WebDAV）+ `.local-probe-*`/`.local-badge` 样式（纯新增） |
| `frontend/src/71-provider.js` | `resolveApiEndpoint/isGlmEndpoint/effectiveApiKey/providerPriceFor/updateBrandModel` 接入 local 优先分支（local_mode 默认关 → 行为不变） |
| `frontend/src/70-config.js` / `110-boot.js` / `75-token-stat.js` / `60-agent-loop.js` | collect 合并 local_*、boot 回填、本地零费标签、端点名校验 |

**端到端路径已通**：探测 → 选模型 → 测试连接 → 对话（local 模式免 Key、零费、剥离 GLM 专属字段）。**预留未接**：B1 上下文自适应压缩接线、B2 去 tools 重发、B3 流式 watchdog、B5 MCP 保守策略文案注入（判定函数已就绪）。

---

## 3. 错误处理占位约定

- 所有 IO 失败返回**结构化错误**（`{ok: False, error: 人话}`），不抛异常穿桥接层；
- reserved 占位统一带 `reserved: True` 标记 + 说明文案 + 可用的前置产物（导出计划 / manifest 校验结果）；
- 探测失败分态：超时 / 未监听 / HTTP 错误 / 其他（`_probe_error_text`）；
- 后续迭代填实现时**不改签名与返回 shape**——只把 reserved 分支换成真执行。

---

## 4. 各计划项 → 接口映射速查

| 计划项 | 接口位置 | 状态 |
|---|---|---|
| A1 预设 | `LOCAL_PRESETS` + `LOCAL_UI_PRESETS` + `#localPreset` | 就绪 |
| A2 探测 | `local_probe()` + `localProbeNow()` | 就绪 |
| A3 清单+元数据 | `local_models()` + `LOCAL_MODEL_META`/`model_meta()` + `#localModelSelect`/`#localMetaBadge` | 就绪 |
| A4 本地计费 | `providerPriceFor` 本地短路 + `local_billing_label` + `updateLiveTokenStat` 分支 | 就绪 |
| A5 测试连接 | `test_provider_endpoint(local=True)` + `localTestNow()` | 就绪 |
| B1 窗口自适应 | `compact_threshold()` + `#localCtxWindow` | 判定就绪，压缩接线预留 |
| B2 工具降级 | `should_retry_without_tools()` / `tools_disabled_for()` | 判定就绪，重发编排预留 |
| B3 慢推理 | `FIRST_TOKEN_WAIT_HINT`/`IDLE_WATCHDOG`/`slow_reason_hint()` | 常量就绪，watchdog 预留 |
| B4 Ollama 特情 | `classify_local_error()` loading/model_not_found 分支 | 就绪 |
| B5 MCP 保守 | `MCP_LOCAL_CAUTION`/`MCP_LOCAL_TRUST_SCOPE` | 文案就绪，注入预留 |
| S1 连接池 | `HttpConnectionPool`（复用/回收/探活/统计，真实回环已测） | 内核就绪，接线预留 |
| S2 stdio 温启 | `WarmRegistry` | 接口就绪，spawn 编排预留 |
| S3 stale/重连 | `stale_needs_relist()` / `reconnect_backoff_delays()` | 就绪 |
| S4 审计延迟 | （未动——先测后优纪律，测量不过线不改） | 遵循 roadmap |
| S5 并发上限 | `ConcurrencyLimiter` + `max_concurrency` 配置 | 就绪 |
| v1.6 WebDAV | `WebDAVService` 五方法 + `37-webdav.js` | 校验/冲突就绪，IO reserved |

---

## 5. 测试与验证

- `tests/test_v15_reserved.py`：87 项（preset 完整性 / 元数据三级 / 阈值矩阵 / 错误分类 / 探测三态打桩 / 墙钟并行 / 三形态解析 / loading 态 / WebDAV 校验 / 冲突四分类 / 池复用/回收/探活/上限 / 真实回环 roundtrip / 温启回收 / js_api 隐身 / config.json 零污染）
- 回归门：`pytest tests/ -q` 全绿；`deliverables/design/check_contract.py` PASS；`node frontend/build.js` 成功幂等
- 本环境实证：`local_probe` 探测到本机真实 Ollama（11434，3 模型），`local_models` 元数据启发式正确命中（qwen3.8→32k，未知→8192 保守）
