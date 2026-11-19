# GLM-Chat / Harbor 交接报告
## 覆盖范围：Round 26 – Round 35（2026-11-05 全天）

> 接手人须知：本报告只写**已落地并验证**的内容，每条带提交号或可复跑命令。
> R16–R25 见 `HANDOVER-R16-R25.md`（其 §8 为 R26 原始记录）；R27–R35 的逐轮专项报告见
> `deliverables/dev-plan/R27-*.md … R35-*.md` 与 `outputs/R35-*.md`。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 本轮提交 | 9 个（`da1b0cd` → `fa9f216`），工作区干净 |
| 全量门禁 | **1898 passed / 3 skipped / 0 failed**（1901 collected，`pytest tests/ -q`） |
| 测试文件 | 131 个 `tests/test_*.py` |
| 前端模块 | **115 JS / 14 CSS**（manifest 拼接式构建） |
| 契约锚点 | r28 → r36 共 9 个入库；最新 r36 = 115 模块 / 1246 顶层符号 / API_VERSION `v1.0.0` |
| UI 五大契约 | PASS（40 DOM id / 13 onclick / 43 callApi / 39 CSS 类 / 21 CSS 变量） |
| 内置目录 | 394 专家 / 54 专家团 / 377 技能 / **50 可直连连接器** / 15 专家分类 / 16 技能分类 / 60 热门 |
| 构建产物 | `harbor.html` 3,815,255 B（`node frontend/build.js`，连跑两次逐字节一致） |
| 安装器 | ⚠️ `dist/Harbor.exe` **仍是 2026-10-26 旧包**，不含本轮任何 UI（见 §9.1） |
| 本轮修掉的缺陷 | 会话删除复活（服务端墓碑）、上传入口分裂、市场空分区、市场英文/缺项、连接器假可用 |

---

## 1. 十轮范围一览

| 轮次 | 主题 | 提交 | 关键产出 | 全量门禁 |
|---|---|---|---|---|
| R26 | 五项遗留清零 + CI | `da1b0cd` | `shotState` 裸全局清零、逐计划 resume 卡片、虚拟列表、`entry_sweep`/`round_runner` 接入 GitHub Actions | 1843 passed |
| R27 | 全库盘点 + 四类升级 + 旧文件清理 | `918e704` `6d53744` | 17 类前端模块逐类盘点；motion 令牌、grants TTL 兜底、搜索跳转 toast、`syntax_sweep` 提速 31.73s→0.54s；17/17 旧文件入回收站 | 1850 passed |
| R28 | 四个大模块拆分 | `0a7cfd3` | `connection-presets` / `panel-state` / `run-controller-utils` / `controller-meta`；104→108 模块；新增 `tools/contract_diff.py` | 1855 passed |
| R29 | 依赖图 + 逐函数差分 + 继续拆分 | `65989be` | `tools/function_graph.py`（111 模块 / 1154 符号 / 2743 边 / 14 个 SCC 循环簇）；契约差分新增第 6 类「逐函数定义体哈希」；108→111 | 1861 passed |
| R30 | 全库升级 + UI 重构 | 随 `b484811` | `--focus-ring` 等 4 个语义令牌、18 处焦点环统一、`prefers-contrast`/`forced-colors`；`updateTokenStat` **12.3ms→5.8ms** | 1867 passed |
| R31 | 无上限并行会话 + 历史页 | 随 `b484811` | `RunRegistry` 改 `Map<sessionId, run>`；群聊按 sid 键控 busy/paused；历史页富卡片；无任何并发上限/开关/配置 | 1874 passed |
| R32 | 内置 WorkBuddy 市场目录 + 加号菜单 | `b484811` | 740 项目录（100% 带可注入指令）、`composer-hub.js`、统一附件入口；111→113 | 1880 passed |
| R33 | 删除会话墓碑 + 上传合并 + 功能市场启用制 | `a60a8a7` | 服务端 `deleted_session_ids` 墓碑、`hub-market.js` 与 `localStorage['harbor_hub_enabled']`；113→114 | 1885 passed |
| R34 | 市场技能/连接器分区恒空修复 | `dccd964` | `hubMarketSections()` + 切分区重置筛选态 + 非法分区回落 | 1887 passed |
| R35 | 功能市场收口（中文 / 全量 / 真实可用） | `fa9f216` | 在线全量重采、504 端点实测、只留 50 个可直连、连接器真实接入 MCP 运行时；114→115 | **1898 passed** |

> R30 / R31 当时按用户要求「不代提交」，其改动随 R32 的 `b484811` 一并入库，故提交号合并。

---

## 2. 重点一：功能市场（R32 → R35，用户三次纠偏的收敛过程）

### 2.1 三次纠偏与根因

| 用户反馈 | 根因 | 修复 |
|---|---|---|
| 「不只是我下载的这些，市场还有很多」 | R32 采集器只读本机 `marketplace.json` 缓存，得 17 连接器 / 292 技能 | 新增 `tools/fetch_hub_market.py`，直接拉 WorkBuddy 在线市场包 `connector-plugins.zip` + `connector-plugins-internal.zip` |
| 「不只是检索到，点了我真的可以用」 | `hubCatalogPrompt()` 对连接器返回空串；`hubPick()` 只跳设置页 | 新增 `hub-connector.js`，启用即真实注册进后端 MCP 运行时，并注入 `mcp__<server>__<tool>` 调用约定 |
| 「怎么有的是英语的」 | 中文元数据藏在插件包 `plugin.json` 的 `extensions["ai.workbuddy"].display.name_zh / description_zh / examples_zh`，R32 只读了 `marketplace.json` 的英文 `description` | 全量重采；新增 `tools/hub_localize.py`（精确覆盖表 + 前缀规则） |

### 2.2 数据源与规模

| 数据源 | 规模 | 用途 |
|---|---|---|
| `connector-plugins.zip` + `connector-plugins-internal.zip` | **628 连接器**（609 条中文描述、538 条带真实 `mcp.json`） | 连接器目录 |
| 本机 `skill-market.json` 首屏 | 106 条 SkillHub 中文热门 + 16 官方分类 | 技能目录 |
| 本机 `.skill-list-cache.json` / 插件市场 / 内置技能 | 292 条 | 技能目录补全 |
| 本机 `app/cache/experts/manifest.json` + 精选推荐 | 448 条（394 专家 + 54 专家团），60 条热门 | 专家目录 |

固化产物：`tools/data/hub-market-snapshot.json`（615 KB，离线可重放，不依赖联网）。
最终目录：`frontend/src/shell/hub-catalog.js`（1.86 MB，纯静态 JS 数据 + 查询函数）。

### 2.3 关键实证：不能把「配置里没写密钥」当成「可直连」

`tools/probe_hub_mcp.py` 对全部 **504 个 HTTP 型 MCP 端点**发一次标准 `initialize` 握手（不调工具、不写用户配置）：

| 结果 | 数量 | 含义 |
|---|---:|---|
| 匿名握手成功 | **59** | 真正无需凭证即可连 |
| HTTP 401 / 403 | 419 | WorkBuddy 用自家账号 / OAuth 会话注入凭证，Harbor 无该登录态 |
| 超时 / 不可达 | 21 | 内网或已下线 |
| 200 但业务层 unauthorized | 5 | 同样不可用 |

抽样复核：`api.githubcopilot.com/mcp`（GitHub）、`mcp.notion.com/mcp`（Notion）均返回 **401**。
结论：**这些 MCP 是 WorkBuddy 市场上的第三方服务，不是 Harbor 自带能力**；目录数据可离线内置，能否调用取决于各服务自身鉴权。

### 2.4 按用户要求「不能直连的直接去掉」

- 目录**只保留 50 个**：59 个握手成功中，剔除 9 个配置带 `headers`/`env`（仍需密钥）者。
- 其余 **578 个**（需授权 / 仅目录 / SSE / 需本机 CLI）全部移出，不留占位卡片。
- 市场页顶部如实写明：`已实测可直连 50 项 · 其余服务需 WorkBuddy 账号授权，已按你的要求从市场移除`。
- 测试断言 `github` / `notion` 等 401 端点已查不到，且对它们的接入请求不触发任何 MCP 注册。

### 2.5 「真的能用」的闭环（保留的 50 个）

```
市场点「启用并接入」
  → mcp_import_claude   写入 ~/.glm-chat/mcp_servers.json（真实 mcp.json 配置）
  → mcp_save_server(enabled=true)  实测连接、回传工具数
  → run-controller 的 build_tools(role=full, include_mcp=true) 下发 mcp__<server>__<tool>
  → 模型调用 → mcpExecTool → mcp_call_tool → 真实外部服务
会话「+」选中连接器 → hubCatalogPrompt() 注入能力说明与调用约定
```

- **零新增后端方法**：全部复用既有隐身 js_api（`mcp_import_claude` / `mcp_save_server` / `mcp_list_servers`）。
- **不碰 `config.json`**：接入状态写独立 `localStorage['harbor_hub_connector_state']`；启用清单写 `localStorage['harbor_hub_enabled']`。
- 卡片显示真实状态：接入中 / 已接入 · N 个工具 / 失败原因；提供「测试连接」重试；失败不谎报成功。

### 2.6 市场页面结构

| Tab | 分区（动态生成） | 条目 |
|---|---|---:|
| 专家 | 15 个官方分类 | 394 |
| 专家团 | 同左 | 54 |
| 技能 | 16 个分区（个人已装·热门 / 官方内置 / 连接器技能 / 插件技能 / 开发者插件市场 / 协作与团队市场 / 办公协同 / 开发工具 / 数据分析 / 内容创作 / 效率工具 / 信息资讯 / 投资理财 / 教育学习 / 生活服务 / OPC·一人公司） | 377 |
| 连接器 | 8 个分区（开发工具 / 知识与检索 / 商业信息 / 金融数据 / 电商零售 / 企业专属 / 生活服务 / 更多服务） | 50 |

分页 48 项/页，`hubSetMarketPage()` 可翻至末页；搜索、分类、排序、仅看已启用均在同一状态机内，切 Tab/分区强制重置筛选态（R34 修复点）。

---

## 3. 重点二：无上限并行会话（R31）

| 项 | 改动 |
|---|---|
| 运行态容器 | `agent/run-registry.js`：单例 run → `Map<sessionId, run>`；新增 `isSessionStreaming(sessionId)`、`refreshStreamingFlag()`、`RunRegistry.last()`、`_nextRunId()` |
| 群聊并发 | `group.js` 用 `GROUP_BUSY_SIDS` / `GROUP_PAUSED_SIDS` 集合 + `groupAbortController(sid)`；群 run 打 `kind:'group'` |
| 上限 | **无** `MAX_*` / 信号量 / 队列 / 池；测试静态断言 4 个核心模块关键词为 0 |
| 隔离 | 工具信任集、截图 `pendingShots`、群成员队列全部按 `runSid` 键控 |
| 历史页 | `_renderSessionHub()` 改富卡片（模型、消息数、时间、运行态、项目归属） |

回归：`tests/test_r31_parallel.py` 7 项 + 18 文件宽回归 164 passed。

---

## 4. 重点三：结构重构与契约工程（R27–R30）

### 4.1 模块拆分路径

| 轮次 | 模块数 | 新增前置子模块 |
|---|---:|---|
| R26 基线 | 104 | — |
| R28 | 108 | `settings/connection-presets.js`、`search/panel-state.js`、`agent/run-controller-utils.js`、`sessions/controller-meta.js` |
| R29 | 111 | `settings/connection-base.js`、`sessions/controller-base.js`、`agent/run-controller-base.js` |
| R32 | 113 | `shell/hub-catalog.js`、`shell/composer-hub.js` |
| R33 | 114 | `shell/hub-market.js` |
| R35 | **115** | `shell/hub-connector.js` |

拆分纪律：新模块插在原模块**紧前面**；原模块 `provides` 删去迁移符号、`requires` 追加；**不新增顶层符号、不改任何函数体**（由源码行多重集哈希 + 逐函数哈希双重证明）。

### 4.2 三件契约工具

| 工具 | 作用 | 产物 |
|---|---|---|
| `tools/contract_diff.py` | 6 类契约面差分：模块数/样式数、顶层符号集合、UI 契约、源码行多重集、逐函数定义体哈希、HTML 契约 | `deliverables/dev-plan/contract-baseline-r*.json` |
| `tools/function_graph.py` | 解析 115 模块顶层声明，Tarjan SCC 找循环簇，输出依赖边 | `deliverables/dev-plan/r29-function-graph.json`（R29 时 111/1154/2743） |
| `tools/upgrade_audit.py` | 白名单制审计：允许「模块数变化 + 符号归属迁移」，其余改动一律违规 | 终端结论 PASS/FAIL |

锚点链：r28（108）→ r29（111 拆分前）→ r30（111 拆分后）→ r31 → r32（113）→ r33 → r34（114）→ r35 → **r36（115 / 1246 符号）**。
纪律：**每次破坏性重构后必须 `--snapshot` 新锚点并入库**，旧锚点只读不改。

R35 的 r35→r36 差分结论为「漂移 FAIL」，属预期：新增 18 个顶层符号（`hubConn*` / `HUB_CONN_*` / `HUB_MARKET_PAGE_SIZE` / `hubCatalogLink` / `hubCatalogMcp` / `hubSetMarketPage`）+ 1 个 DOM id（`hmLinkStat`）。新锚点 r36 入库后 `upgrade_audit` PASS、白名单外变化 0。

### 4.3 性能与健壮性实绩（均已门禁化）

| 项 | 改前 | 改后 |
|---|---|---|
| 400 条消息渲染（R21 起保持） | 1548ms | **221ms** |
| `updateTokenStat`（60 会话 × 80 消息） | 12.3ms | **5.8ms** |
| `function_graph` 构建（1154 符号） | 1.62s | **0.55s** |
| 全库语法扫描 `syntax_sweep` | 31.73s | **0.54s** |
| 焦点环颜色 | 4 色混用 | 1 个 `--focus-ring` 令牌（零视觉变化） |

---

## 5. 重点四：数据一致性修复（R33）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 已删除会话复活 | legacy 迁移每次启动无条件 `importLegacySessions`，删除只删当前库、不留痕 | 服务端墓碑：`server/src/services/session-migrate.js` 的 `readDeletedIds()` / `rememberDeletedId(sid)`；`provider.js` 的 `sessionPurge` 删除前写墓碑；`sessions.js` 的 `saveSessions` 过滤墓碑；Python 端 `backend/domains/settings/config_service.py` 写同一文件 |
| 上传入口分裂（图片/视频/文本/压缩包四个按钮） | 按类型分派 | `composer.js` 的 `PLUS_ITEMS` 合并为单项「上传文件」；`unifiedFileInput` 去 `accept`；`attachments.js` 的 `hubFileKind(file)` 未知类型回落 `'file'`；`send.js` 注入 `[附件文件]` 元信息 |

墓碑文件：`~/.glm-chat/deleted_session_ids.json`（与历史库分离，向后兼容旧库）。

---

## 6. 验证记录

### 6.1 门禁总表（本机隔离 venv）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量回归 | `pytest tests/ -q` | **1898 passed / 3 skipped / 0 failed** |
| API 契约（legacy vs new 逐字节） | `pytest tests/test_api_contract.py -q` | 6 passed |
| UI 五大契约 | `python deliverables/design/check_contract.py` | PASS（40/13/43/39/21；115 JS / 14 CSS） |
| 构建幂等 | `node frontend/build.js` ×2 | 产物逐字节一致 |
| 契约差分 | `python tools/contract_diff.py --snapshot …` | r36 零漂移 |
| 升级审计 | `python tools/upgrade_audit.py` | AUDIT PASS |
| R32–R35 宽回归 | `pytest tests/test_r3[2-5]*.py -q` | 51 passed |
| 端点实测 | `python tools/probe_hub_mcp.py --timeout 6 --workers 16` | 504 端点 / 59 可握手 |

### 6.2 复跑命令

```bash
PY="C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
NODE="C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"

"$NODE" frontend/build.js                       # 构建（115 JS / 14 CSS，幂等）
"$PY" deliverables/design/check_contract.py     # UI 五大契约
"$PY" -m pytest tests/ -q                       # 全量门禁（约 9–10 分钟）
"$PY" tools/upgrade_audit.py                    # 升级审计
"$PY" tools/contract_diff.py --snapshot deliverables/dev-plan/contract-baseline-r37.json   # 下一轮锚点
```

### 6.3 市场数据重采（顺序不可颠倒）

```bash
"$PY" tools/fetch_hub_market.py                 # 联网重采在线市场包；无网用 --offline 读现有快照
"$PY" tools/probe_hub_mcp.py --timeout 6 --workers 16    # 实测端点，写 hub-mcp-probe.json（白名单）
"$PY" tools/build_hub_catalog.py                # 只收录 probe 白名单内的连接器，重建 hub-catalog.js
"$NODE" frontend/build.js                       # 重建 harbor.html
```

> `probe` 必须在 `build` 之前：可直连白名单是过滤的唯一依据。跳过 `probe` 直接 `build` 会因白名单缺失而得到 0 个连接器。

---

## 7. 交付物清单

| 类别 | 位置 |
|---|---|
| 交接报告（本份） | `deliverables/dev-plan/HANDOVER-R26-R35.md` |
| 逐轮报告 | `deliverables/dev-plan/R27…R34-*.md`、`outputs/R35-功能市场收口报告.md`、`outputs/R35-契约差分报告.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r28…r36.json` |
| 市场快照 | `tools/data/hub-market-snapshot.json`（628 连接器 + 106 技能 + 16 分类） |
| 端点实测 | `tools/data/hub-mcp-probe.json`（504 端点结果 + 59 白名单） |
| 采集/构建工具 | `tools/fetch_hub_market.py`、`tools/probe_hub_mcp.py`、`tools/hub_localize.py`、`tools/build_hub_catalog.py` |
| 契约工具 | `tools/contract_diff.py`、`tools/function_graph.py`、`tools/upgrade_audit.py` |
| CI / 扫描 | `.github/workflows/harbor-ci.yml`、`tools/cdp_lib.py`、`tools/entry_sweep.py`、`tools/round_runner.py` |
| 前端产物 | `harbor.html`、`frontend/manifest.json`、`frontend/src/shell/hub-*.js` |

---

## 8. 接手人必知的约束与坑

1. **构建**：只改 `frontend/index.template.html` + `frontend/src/*.js` + `frontend/styles/**`，改完跑 `node frontend/build.js`。**新顶层符号必须登记 `frontend/manifest.json` 的 `provides`**，否则 lint 拦构建。
2. **模块顺序**：`tests/test_frontend_tree.py` 有冻结的 `EXPECTED_ORDER`，新增模块**必须手工插入**该常量（计数断言已改动态，顺序断言不会自动跟随）。
3. **契约锚点**：破坏性重构后 `contract_diff.py --snapshot` 新锚点并入库；旧锚点只读。锚点 `api_py_sha256` 与 `API_VERSION` 是发布门，不能漂移。
4. **js_api 零新增**：新方法一律进 `backend/api.py` 的 `_V12_EXTRA`（隐身，`get_api_info` 不列）。本轮连接器功能**零新增后端方法**，全部复用既有 `mcp_*`。
5. **`config.json` 零污染**：新配置存独立文件或 `localStorage`。本轮新增的两个 key：`harbor_hub_enabled`（启用清单）、`harbor_hub_connector_state`（接入状态）。
6. **测试口径必须是 `pytest tests/`**：直接跑 `pytest`（全仓）会收集 `outputs/pytest-tmp/` 下的历史副本，产生数百个 collection error。这不是代码缺陷。
7. **前端老测试的硬编码**：R35 已把模块数 / 技能数 / 连接器数的 `== 114`、`== 292`、`== 17` 改为动态或下限断言；但 `.js` 模板里的字面量仍散落在个别断言中，扩容后按报错逐条改。
8. **市场目录是生成物**：`hub-catalog.js` 1.86 MB，**不要手改**，改 `tools/build_hub_catalog.py` / `tools/hub_localize.py` 后重建。
9. **Electron 宿主启动**（开发树，加载最新 `harbor.html`）：

   ```bash
   unset ELECTRON_RUN_AS_NODE NODE_OPTIONS
   ./node_modules/electron/dist/electron.exe electron/main.js
   ```

   `ELECTRON_RUN_AS_NODE=1` 会导致 `app is undefined`；`Start-Process` 启动的窗口会被会话回收，需用受管理的后台任务。
10. **打包**：git bash 下 `| tail` 会吞退出码，别用管道判断成功；打包前必须关掉所有 `Harbor.exe` / `electron`，否则 `node_modules` rename 失败；`test_generative_registry` 的 offline 场景也会 rename `node_modules`。
11. **`dist/Harbor.exe` 与源码不同步**：用户桌面的 exe 是 10/26 包，与 `harbor.html` 无关联。任何「界面没变」的判断，先确认打开的是 Electron 宿主还是旧 exe。

---

## 9. 遗留风险与建议下一步

### 9.1 P0：正式安装包未重打

`dist/Harbor.exe` 为 2026-10-26 构建，不包含 R27–R35 的任何界面与能力。用户当前是通过 Electron 宿主查看新界面。
**建议**：确认界面后执行 `pyinstaller Harbor.spec`（先停所有 electron 进程），核对 asar/包内 `harbor.html` 的 mtime 与大小（应为 3,815,255 B）。

### 9.2 连接器只验证了握手，未验证工具

50 个保留项仅通过 `initialize`；`tools/list` 与真实工具调用未逐个跑。匿名握手成功 ≠ 所有工具免鉴权。
**建议**：抽 5–10 个高频项（开发工具 / 知识与检索分区）跑 `mcp_save_server` → `tools/list` → 单次只读工具调用，把结果回填 `tools/data/hub-mcp-probe.json` 的 `verified` 字段。

### 9.3 技能/专家是「指令注入」，不是执行 SKILL.md 代码

377 技能与 394 专家均为一次性系统提示注入（人格原文 / 工作流摘要，约 1600 字符），不执行 WorkBuddy 的 SKILL.md 脚本，也不安装依赖。这是设计选择（Harbor 无 WorkBuddy 运行时），不是缺陷；但对「技能能跑脚本」的预期需提前说明。

### 9.4 在线全量尚未采尽

- 技能：在线 SkillHub 全库约 4.9 万条，当前只取首屏 106 条热门 + 本机 292 条，共 377。
- 专家：来自本机 `app/cache/experts/manifest.json`（448 条），未验证在线专家市场是否更多。
- 连接器：628 条已全量采集，但按用户要求只展示 50 条可直连。

**建议**：若需真正「全量」，为 `fetch_hub_market.py` 增加分页拉取与本地缓存过期策略；技能全量入库会使 `hub-catalog.js` 增至数十 MB，需改为按需加载的独立 JSON + 索引。

### 9.5 历史遗留（本轮未动）

macOS 打包验证、性能基准对比、安全逃逸测试、代码签名均未做；`KNOWN_ISSUES.md` 登记在案。installer 卸载测试在 Harbor 运行中会环境性失败（非代码问题）。

---

## 10. 一页速查：本轮「用户可见变化」

1. 加号菜单合并为单一「上传文件」，任意格式可选，附件带类型元信息。
2. 功能市场（原专家中心）四个 Tab 均有内容，全中文，可搜索/分类/翻页/启用。
3. 已启用项才出现在会话「+」菜单；停用即移除。
4. 连接器点「启用并接入」会真实注册 MCP，成功后模型可直接调用其工具。
5. 删除的会话不再复活（服务端墓碑，跨重启生效）。
6. 多个群聊与单聊可同时流式输出，互不中断、无数量上限。
7. 历史会话页改为富卡片列表。

[wbs-reply-done]: #
