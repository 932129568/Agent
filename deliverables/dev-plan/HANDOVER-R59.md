# HANDOVER-R59 — 架构依赖单向化（缝模式）+ 读盘热路径性能

> 日期：2026-11-08。接续 HANDOVER-R58.md。任务（用户）：「进一步优化，性能开销进一步
> 优化节省开销，优化逻辑，对源码架构所有依赖关系进行调整，全部改为单向依赖，
> 实在不能单向依赖的，也要拆到最小依赖关系」。
> 工具：`tools/dep_scan.py`（三图扫描）· `tools/dep_graph.py`（可复用 SCC 原语）·
> `tools/gen_allowlist.mjs`（前向隐藏边冻结清单 + `--check` 棘轮）。

## 0. 一眼总览

| 维度 | 状态 |
|---|---|
| 全量 pytest | **2057 passed / 0 failed / 3 skipped**（R58 基线 2046 → +11） |
| 契约锚点 | **r59**（117 模块 / 1306 符号） |
| build | 幂等 ✓（117 模块，harbor.html 32067 行） |
| 依赖棘轮 | `gen_allowlist.mjs --check` 通过（前向隐藏边冻结 88 条，只减不增） |
| 依赖环 | **Python 0 环（159 模块）/ Node 0 环（40 模块）/ 前端真环 0** |
| 提交 | 本轮 1 笔 |

## 1. 依赖图实证（起点 → 终点）

| 图 | 起点 | 终点 |
|---|---|---|
| Python（backend/ AST 导入图） | 0 环 / 148 模块 | 0 环 / 159 模块 ✓（本就单向） |
| Node（server/src ESM） | 0 环 / 40 模块 | 0 环 / 40 模块 ✓（本就单向） |
| 前端（拼接 + 函数提升） | **12 个交叉环** + 98 条前向隐藏边 | **0 真环** + 88 条冻结（棘轮锁死） |

前端 12 环逐条裁决（三条路径）：

**A. 可拆环 → 下沉早位叶模块（7 条）**

| 环 | 解法 | 落点 |
|---|---|---|
| tokens ↔ provider | `providerPriceFor` 自 provider.js 下沉 tokens.js（价格=计费域） | analytics/tokens.js |
| compact-command ↔ compaction | 估算/校准簇（estTokens/estTokensMsg/historyTokens/estTokensCalibrate/estTokensCalibrated/_estCalib）建**早位叶模块** | **core/tokens-est.js**（117th） |
| mcp-panel ↔ fixtures、memory ↔ fixtures | `mcpServersRevision` / `memoryReqSeq` / `mmLastItems` 态叶化 | core/state.js |
| group ↔ endpoints | `groupModelSelectOptions` + `groupEndpointCatalog` 移入 group.js（消费方同层） | group/group.js |
| utils ↔ quick | 控制流反转：`setWsQuickRefreshHook` 钩子宿主下沉 state.js，quick 顶层注册、utils 经 `wsQuickRefreshHookCall()` 调 | core/state.js |
| controller → center | `expertNextSelection`/`expertSelectionSessionId`/`expertSelectionLabelText` 态叶化；`clearExpertSelection` 的 chip 置隐改为 `setExpertChipResetHook` 钩子回补（叶不摸 DOM） | core/state.js + center.js 注册 |

**B. UI 事件核心环 → 缝模式（星型依赖，3 条）**
`send ↔ run-controller ↔ controller` 三模块互相调用（Agent 循环固有事环）。解法：
`run-controller-base.js`（52，最早）持 **UISeam 注册表**（`registerUISeam`/`uiSeamCall`），
晚加载模块把 owned 函数注册进去，早模块经 `uiSeamCall('name', ...)` 单向调用：
- controller.js → `{renderChatHistory, renderSessionList, setSessionRunStatus}`
- send.js → `{continueLastGeneration, closeSidebarDrawer}`
- compact-command.js → `{renderCompactCard, compactNow}`
依赖方向自此全部指向 base 叶模块（星型），**任一模块可独立单测**（globalThis 兜底保 vm 桩兼容）。

**C. 扫描误报（2 条）**：center.js 的 `newSession` 是局部 DOM 变量同名；`utils→controller`
为剥离器把转义串切坏造成的假边——raw grep 已证全部跨模块调用点为后向+缝调用。

## 2. 棘轮门禁（防回潮）

- `tools/gen_allowlist.mjs`：**唯一实现源**（无参=重生成 `frontend/deps-allowlist.json`；
  `--check`=棘轮：重算与冻结清单比对，清单外新增前向边即退出 1）。
- `tests/test_r59_deps.py::test_ratchet_check_passes` 承接门禁 + `len(frozen) <= 88` 防清单扩容。
- **实现教训**：build.js 内联版棘轮与 gen 的字符串剥离语义分叉（`\b` 断言在同文件既当
  「被剥对象」又当「检测器」），自举失败——改单一实现源（test 承载），build.js 保持原样。
- 消灭方式（供后续轮）：拆缝 `uiSeamCall` / 下沉早位叶模块 / 声明 requires（仅当目标更早）。

## 3. 性能（读盘热路径）

| # | 位置 | 原开销 | 修复 |
|---|---|---|---|
| P1 | `server/src/services/guard.js loadCfg()` | guard_check + enforce_exec 每工具调用 **≥2 次** readFileSync+JSON.parse 整个 guard.json | mtime+size 缓存；persistCfg 写档置 `_cfgCache=null`；外部改档自动失效 |
| P2 | `server/src/services/mcp.js data()` | 每次 MCP 调用/面板刷新重读 mcp_servers.json（含 DPAPI 密文） | mtime+size 缓存；`save()` 写档失效 |
| P3 | `backend/domains/settings/memory_service.py list()` | `build_system_prompt` **每轮**读盘+解析 memory.json（记忆注入） | mtime_ns+size 缓存 + RLock（多线程 js_api）+ `_save` 回填；外部改文件自动失效 |
| P4 | `frontend/src/analytics/tokens.js` | 顶层 `setInterval` 裸引用（vm/harness 环境 ReferenceError） | typeof 守卫（生产行为不变） |

冒烟实证：guard 缓存命中 `a===b`、写档即换档（confirm→allow）、外部写文件失效。

## 4. 测试基建变化（下轮须知）

1. **别名表**：`tests/helpers/frontend.py` + `00-tokens-est.js`（现 58 条）。
2. **冻结序**：EXPECTED_ORDER + `core/tokens-est.js`（插在 state.js 之后）。
3. **harness 随迁**（下沉/缝的必然连带，共 9 个测试文件）：
   - est 校准 / v14 阈值 → 先 `__fe('00-tokens-est.js')`；
   - 专家族（6 文件）→ `MODULES` 前置 `core/state.js`；
   - connect_merge → 补 `__fe('75-token-stat.js')`（providerPriceFor 新家）+ 删手写 MODEL_PRICE 桩（重复声明）+ 价格断言用**在售模型 glm-4.5**（Round 12 已淘汰 glm-5.3-*）；
   - round6/7 memory → 前置 `00-state.js`；
   - sidebar / session_project → ctx 补 `uiSeamCall` 桩；
   - 静态断言（resume / review_fixes / sidebar）→ 随缝改 `uiSeamCall('x', ...)`；
   - r30 / perf_frontend_benchmark → 补 `localModeActive`/`isGlmEndpoint` 桩；r30 对比用例从 NEW 源剔除 providerPriceFor（两侧同用桩，行为兼容判据不变）。
4. **缝编写规范**：早模块只允许 `uiSeamCall('name', ...)`（字符串键，扫描器豁免）；
   晚模块顶层 `registerUISeam({...})`；不得在早模块写 `typeof f === 'function' ? f() : ...`
   的裸引用（既构成前向边又绕过缝）。

## 5. 遗留

- 88 条冻结前向边可继续按「叶化/缝化」逐批消化（棘轮只允许减少）。
- 48+ 笔提交待推送；安装包重打（落后 18 轮）。
- R59 未做的更深层单源化：Python api.py 门面仍 ~2000 行（委托式，依赖已单向）。

## 6. 提交

```
refactor(R59): 架构依赖单向化——前端 12 环清零（估算/校准簇与跨域状态下沉早位叶模块、价格面归位、群/工作区函数归位）+ UI 事件环改 UISeam 星型缝（registerUISeam/uiSeamCall）+ 前向隐藏边冻结棘轮（gen_allowlist --check，冻结 88 条只减不增）+ 读盘热路径 mtime 缓存（guard.json/mcp_servers.json/memory.json）+ Python/Node 依赖图零环断言；锚点 r59；pytest 2057 绿
```
