# Harbor 完整交接报告（R36 – R38，2026-11-06）

> 接手人须知：本报告只写**已落地并验证**的内容，每条可复跑；未修项逐条列明根因与修法，不留模糊。
> 覆盖：R36（记忆模块 206 轮调研）→ R37（全夜缺陷全扫 + 五方向 503 轮调研）→ R38（记忆接入 / 留档收口 / 性能）。
> 逐轮/逐条细报在：`deliverables/dev-plan/R37-*.md`、`R38` 各提交说明、`outputs/r37-{arch,defects,research}/`（本地留存，outputs 在 .gitignore 中）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 本轮提交 | **7 笔**（`67f868a` → `8237aad`），工作区干净，**均未推送远端** |
| 全量门禁 | **1938 passed / 1 failed / 3 skipped**（唯一失败为预存遗留，§6.1 有实证） |
| 代码改动面 | 58 文件，+7672 / −237 行 |
| 修复总数 | **R37：51 项根因修复 + 1 项调研驱动升级；R38：4 项留档收口 + 1 项性能升级 + 1 个功能模块接入** |
| 调研 | R36 206 轮（记忆 9 簇）+ R37 503 轮（五方向 20 簇×25+3），全部逐轮日志落盘 |
| 未修（留档） | **35 项**（§5 全表，均附根因与修法） |
| 构建产物 | `harbor.html` 31,027 行（115 JS / 14 CSS），build×2 逐字节一致 |
| 契约锚点 | `contract-baseline-r37.json`（115 模块 / 1249 顶层符号） |
| 测试文件 | 新增 `tests/test_memory_db.py`（9）+ `tests/test_agent_memory.py`（32） |

---

## 1. 提交清单（时间线）

| 提交 | 时间 | 类型 | 内容 |
|---|---|---|---|
| `67f868a` | 02:06 | feat(R36) | 记忆模块调研收官：206 轮/12 疑点裁决/开发文档 v2.0/参考实现 v2/门禁测试（7 文件 +2640） |
| `d2d95f6` | 03:46 | fix(R37) | **44 项根因修复**（P0×1+P1×13+P2×25+P3×5）+ 测试对齐 4 处 + 架构勘察/扫描报告 + 锚点 r37（38 文件 +3950/−160） |
| `8f75eca` | 04:56 | docs(R37) | 五方向调研汇总（20 簇 503 轮）+ 全夜任务交接报告（+283） |
| `bbb5ec4` | 05:03 | fix(R37) | 三批：D20 死字段 / D34 纯浏览器签名基线 / S2-22 tokens 容量淘汰 + 锚点终照（7 文件 +45/−11） |
| `43ccf5f` | 08:21 | fix(R37) | 第四批：429 退避 full jitter（F4b P1）/ 快照防逃逸 / run 状态写入者 / software save-remove 回滚（8 文件 +82/−17） |
| `76b9733` | 08:54 | feat(R38-R1) | **记忆模块 v2 接入 Harbor**：SQLite 四层库渐进增强层（11 文件 +537/−11） |
| `8ffe5d7` | 09:10 | fix(R38-R2) | 留档收口：K2/K4 Node 记忆对齐 + K3 文案 + S2-13 admin 引号 + N4 路径锁（4 文件 +80/−51） |
| `8237aad` | 09:17 | perf(R38-R3) | 逐会话序列化缓存——全量 stringify 根治（4 文件 +74/−6） |

---

## 2. 已更改了什么（按层次）

### 2.1 后端 Python（`backend/`）

| 文件 | 改动 | 原因 |
|---|---|---|
| `domains/memory/db_service.py`（**新增**） | `MemoryDbService`：agent_memory 引擎懒加载与整体降级；legacy `memory.json` → `memory.db` 迁移（mtime+长度指纹变化重建 `legacy:` 命名空间，legacy 面板删除/新增如实传播）；`remember`/`context`/`extras_block`/`stats`/`erase` 能力面 | R36 开发文档 §8 接入设计 |
| `paths.py` | +`MEMORY_DB_PATH` | config.json 零污染纪律 |
| `bootstrap/container.py` | +`memory_db` 服务装配、`API_ALIASES['_memory_db']`、`SERVICE_NAMES`、shutdown 惰性取属 | 容器装配 + v13 生命周期测试兼容 |
| `api.py` | +5 个 `_V12_EXTRA` 隐身方法（`memory_context_build`/`memory_remember`/`memory_erase`/`memory_stats`/`memory_audit_query`）；`append_memory` 镜像 db（失败不阻断 legacy）；`_memory_inject` 追加「【长期记忆·扩展】」段（**仅当存在非 legacy 记忆时非空 → 纯 legacy 用户提示词逐字节不变**）；docstring 50→51 如实修正；`pick_save_path` 字符串返回防御；`history_dir_get` 异常收口；`mcp_save_server` 回弹结果检查 | 记忆接入 + R37 修复 |
| `domains/memory/__init__.py`（新增） | 包声明 | — |
| `domains/settings/config_service.py` | `session_purge` 错误如实上报（`errors` 键仅非空附加）+ 墓碑加锁 + `history_dir_set` 迁移后源改名退位 | K5/N10/N17 |
| `domains/settings/memory_service.py` | 越界文案统一为「序号越界：当前共 N 条记忆」 | K3 |
| `domains/security/guard_service.py` | `_load` 未知顶层键透传保留 | K6（白名单整写抹键） |
| `domains/integrations/software_service.py` | `_rebuild` 空 actions 继承预设；`save`/`remove` 持久化失败回滚内存态 | K7/N12 |
| `domains/workspace/file_service.py` | **按路径互斥锁**（`_path_lock`，write/append/search_replace 读改写全程）；`cmd_service` communicate 异常路径 kill+收尾 | N4/N8 |
| `domains/workspace/group_files_service.py` | 群文件根目录 realpath + 系统敏感目录校验 | N6 |
| `application/native_ui.py` | `history` 环形截断保尾 64（invoke/quarantine） | N2 |
| `bootstrap/container.py` shutdown | 全量收集关闭结果（status≠OK 或 ok=False 入 errors） | N16 |

### 2.2 Node 桥 / Electron（`server/`、`electron/`）

| 文件 | 改动 | 原因 |
|---|---|---|
| `services/system.js` | `ps()` 参数改为**单引号字面量内联**（零插值） | S2-1 命令注入（活体 PoC：`$( )` 被展开） |
| `services/plans.js` | `deleted` 声明提升（TDZ 崩溃）；快照目标防 `..` 逃逸 | S2-2 / S2-23 |
| `services/software.js` | 每次调用都过 `enforceExec`（修 `manual_test` 旁路） | S2-3 |
| `services/update.js` | 连接阶段 30s 守卫替换整流 30s 超时 | S2-4（>30s 下载必败） |
| `runtime.js` | `setCwd` 以盘上现值合并写 | S2-5（wsEnabled/recentWs 被抹） |
| `paths.js` | `atomicWriteJson` +fsync + EBUSY 重试 + tmp 清理 | S2-8 |
| `services/guard.js` | `.bad` 备份；未知键透传；tokens 容量 256 淘汰 | S2-9 / K6 / S2-22 |
| `services/mcp.js` | connect in-flight 去重 | S2-10（孤儿 stdio 子进程） |
| `services/browser.js` | 游标摘除而非改指他人会话 | S2-11（跨会话泄漏） |
| `index.js` | 进程级 `unhandledRejection`/`uncaughtException` 记录不退出 | S2-15 |
| `services/commands.js` | admin 命令 PS 单引号内联 | S2-13 |
| `services/memory.js` | 空 text 允许入库（对齐 Python）；kind 加成改乘法 ×1.3/×1.1 | K2 / K4 |
| `electron/main.js` | 禁 `will-navigate` 外跳 | S2-14 |

### 2.3 前端（`frontend/`）

| 文件 | 改动 | 原因 |
|---|---|---|
| `agent/tool-executor.js` | `set_current_sid([runSid])` | **D1（P0 跨会话写盘）** |
| `agent/run-controller.js` | stopHandler/cancel abort `run.abortController`；abort 路径按 sid 清 pendingShots；预算硬停复位 shotState；并行判定按「其他会话在跑」；`harborStartParallelRun` 取 `effectiveApiKey()`；`registerToolSig/Progress` 带 sid；`buildMessagesForAPI(s.messages, s)`；`__turnTokens` 可见性门控；`__agentRuns` typeof 守卫；WRITE_SEQ_TOOLS 归单源 | D2/D3/D35/D11/D7/D5/D12/D22/D18/D8 |
| `agent/budget.js` | 熔断状态按 **runSid 键控 Map**（64 桶 LRU，桩环境自愈） | D5（并行下成本防线失效） |
| `agent/sse-parser.js` | `data:` 后空格可选 | D17 |
| `agent/context-freeze.js` | `buildMessagesForAPI` 支持 sessionOverride | D12 |
| `agent/run-registry.js` | run 补 `status:'working'`/`startedAt` | D21 |
| `sessions/controller.js` | pendingShots 过滤谓词改 `!== __prevSid`；scroll 监听先卸后挂 | D4 / D6（内存泄漏） |
| `sessions/store.js` | 签名补 projectName/projectWorkspace/_spentCost；纯浏览器场景记录基线；**`_serializeSessions` 逐会话序列化缓存** | D9 / D34 / **R38-R3 性能** |
| `group/mention.js` | 头像字 textContent 装配 | D15 |
| `group/group.js` | 交接卡模型名转义；`groupAbort.controller` 死字段移除 | D16 / D20 |
| `integrations/software.js` | 护栏拒绝分支复位 `swTesting` | S4-1（按钮永久锁死） |
| `integrations/mcp-panel.js`、`settings/memory.js` | endpoint 改懒取函数；记忆面板「扩展记忆库」状态行 + 「删会话≠删记忆」明示 | S4-4 / R38-R1 |
| `generative/controller.js` | `productionUiGenerate` 支持 endpoint 函数 | S4-4 |
| `providers/request.js` | 429 退避改 **full jitter**（RA 存在=[RA,RA+1s) 夹紧 120s；缺失=random(1s,min(30s,2^n))） | F4b 调研 P1 |
| `frontend/manifest.json` | budget 三符号（先加后撤）、`memoryDbStatRefresh`、`_serializeSessions`/`_sessionJsonCache` 登记；run-controller requires +WRITE_SEQ_TOOLS | 构建 lint 铁律 |

### 2.4 工具与打包

| 文件 | 改动 | 原因 |
|---|---|---|
| `tools/entry_sweep.py` | 按稳定 key 寻址点击；采集失效判 `uncertain` 计入 BAD（不再假 OK） | S4-2 / S4-3 |
| `Harbor.spec` | hiddenimports + `agent_memory` | R38 打包可达 |

### 2.5 测试

| 文件 | 改动 |
|---|---|
| `tests/test_agent_memory.py`（新增） | 32 项：参考实现 v2 全能力 |
| `tests/test_memory_db.py`（新增） | 9 项：引擎/WAL/迁移/删除传播/门控/零漂移/擦除/墓碑/登记 |
| `tests/test_r20_scan_fixes.py` | 1 处断言按根因更新（原字面量钉住了缺陷行为：`===` → `!==`） |

---

## 3. 修复了什么（93 候选 → 56 项落地）

### 3.1 R37：51 项根因修复

**P0（1）**
- **D1 跨会话写盘**：pywebview 工具执行把后端会话切到「可见会话」，并行后台 run 的文件读写落进别人会话工作区 → 改路由到 run 所属会话。

**P1（13，全修）**
D2 停 A 杀 B（abort 全局 controller）│ D3 abort 清空他会话截图 │ D4 pendingShots 谓词与注释相反 │ D5 熔断单例被并行 run 清零 │ D6 scroll 监听器累积泄漏 │ D7 并行按钮恒空 Key → 401 │ N1 `pick_save_path` 把字符串当列表取 `[0]`（导出落错位置）│ S2-1 PowerShell `$( )` 命令注入 │ S2-2 plans.js TDZ 必崩 │ S2-3 `manual_test` 免 token 旁路 │ S2-4 更新包 >30s 必败 │ S2-5 runtime.json 短形状抹键 │ S4-1 软件测试按钮永久锁死

**P2（25）**
D8 WRITE_SEQ_TOOLS 双源 │ D9 签名漏字段 │ D12 冻结表读可见会话 │ D15 成员名未转义 │ D17 SSE 只认 `data: ` │ D18 裸引用守卫 │ D21 状态无写入者 │ D22 全局 token 读侧 │ D35 预算硬停截图黑洞 │ K5 purge 吞错恒 ok │ K6 guard.json 抹未知键（Py+Node）│ K7 software actions 被清空 │ K9 MCP 回弹不检查 │ N2 native_ui history 无界 │ N3 history_dir_get 异常穿透 │ N4 文件读写无锁 │ N6 群文件根无校验 │ N10 墓碑无锁 │ N12 software 内存/磁盘分裂（save+remove）│ N16 shutdown 丢结果 │ N17 迁移残留复活 │ S2-8 Node 原子写弱于 Python │ S2-9 guard 配置损坏无备份 │ S2-10 MCP connect 重复建连 │ S2-11 浏览器游标串会话

**P3（6）** D20 死字段 │ S2-14 导航逃逸 │ S2-15 进程级兜底 │ S2-22 tokens 淘汰（容量半）│ S2-23 快照 `..` 越界 │ S4-2/S4-3 扫描工具错位与假 OK

**另**：D34 纯浏览器签名基线

### 3.2 R37 第四批（5 项 + 1 项调研驱动升级）
429 退避 **full jitter**（F4b P1）│ 检查点快照防逃逸 │ run status/startedAt 写入者 │ software save/remove 回滚 │ K1 docstring 如实修正

### 3.3 R38 第一轮：记忆模块 v2 接入（功能新增）
- 独立 `memory.db`（WAL）四层库；legacy 契约（`get_memory/append_memory/memory_delete/memory_retrieve`）**不接管、零漂移**；
- 引擎不可用（打包缺件）→ 整体降级为 `enabled:false`，所有调用方回落 legacy，聊天主链路零风险；
- legacy 迁移与删除传播；写入门控（untrusted 零写入 / 敏感字段拦截 / NOOP 幂等）；
- 软擦除（视图层 scrub 覆盖摘要与窗口）+ 硬删除（墓碑+哈希链不断链）；
- 系统提示注入扩展段（纯 legacy 用户输出逐字节不变）；
- 面板状态行：WAL 模式 / 事实·画像·审计事件计数 / 完整性 ✓。

### 3.4 R38 第二轮：留档收口（4 项）
K2 空记忆条目双端对齐 │ K4 kind 加成乘法对齐 │ K3 越界文案统一 │ S2-13 admin 命令引号 │ **N4 路径锁**

### 3.5 R38 第三轮：性能升级（1 项）
**逐会话序列化缓存**：60 会话×160 消息场景原每次全量 `JSON.stringify` ≈89.6ms/17.3MB 主线程阻塞；现未变更会话复用上次串（签名判定与既有短路同语义），仅重串被改会话，**产物与全量 stringify 逐字节一致**，`save_sessions` 全量数组契约不变。

---

## 4. 调研产出（决策依据，不是任务）

| 轮次 | 覆盖 | 关键结论（已用于或待用于改造） |
|---|---|---|
| **R36 206 轮** | 记忆 9 簇（架构/检索/时态/账本/摘要/技能/遗忘/安全/评测） | 12 疑点裁决：41% 数字无源、本地单用户落 GDPR 家庭豁免、LoCoMo 不可作验收、mem0 97.8% 垃圾记忆为真、is_current 应保留、中文 bigram <1000 条站得住 |
| **R37 503 轮** | 功能/速度/CPU/调度/UI 各 100 + 主会话 3 | 见 `R37-五方向调研汇总.md`：file:// 下 V8 code cache 永久无效、块级冻结渲染 6x、orjson 10x、官方 SDK 退避口径、Ctrl+K 事实标准、流式无障碍播报 |

---

## 5. 未修复什么（35 项留档，按类别）

> 每条：编号｜位置｜问题｜**为什么本轮没修**｜建议修法。
> 完整证据链在 `outputs/r37-defects/scan-S{1..4}-*.md`（本地留存）。

### 5.1 契约/m 语义变更类（6 项）— 需双端同轮对齐 + 差分基线刷新
| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| K8 | `guard_service.py:177,476` | `_armed` 默认 False：无窗环境 always/session 档不校验 token（Python）vs Node 缺省 armed | 明确「无窗=不武装」是设计，还是补显式告警/统一口径；须改差分 fixture |
| S2-17 | `guard.js:102` | Node ARMED 缺省 true，与 Python 缺省 False 分叉 | 同上，双端同轮定口径 |
| S2-19 | `provider.js:388-399` | Node `build_system_prompt` 无沙箱尾注（ID-201 已登记） | 与 Python 文本对齐（改差分基线） |
| S2-20 | `guard.js:193-205` | persistCfg 把当前 sid 的 used/escalated 落盘；Python 剥离且会话级不落盘 | 按 Python 口径剥离后再写 |
| S2-18 | `provider.js:419-423` | Node `ui_nudge` 恒 `{nudged:false}`，Electron 宿主逼帧空转 | host seam 接真窗 RedrawWindow |
| N13 | `checkpoint_service.py:49` / `plan_service.py:39` | task_id 拒绝含 `.` 的 id | 若前端产生含点 id 则放宽白名单（先查前端实际生成规则） |

### 5.2 竞态加固类（8 项）— 需锁语义评审，避免夜间盲改伤契约
| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| K10 | `api.py:490-495` + `cmd_service.py:103` | `begin_task` 无条件 reset 去重器，与在飞 run_command 交叠时在飞登记被洗白 | reset 改「按任务代际」而非清空；或登记带 task_id 前缀 |
| N14 | `group_files_service.py:114` | `write()` 查名与落盘间无锁，同秒同标题并发互覆 | 目录级锁 + 重试命名 |
| N15 | `workspace_service.py:147` | `touch_recent_ws` 读改写无锁 | 复用 `self._lock` |
| S2-6 | `server/services/misc.js:261` | `history_dir_set` 对活体 SQLite `copyFileSync`（无 WAL checkpoint） | 先 `PRAGMA wal_checkpoint(TRUNCATE)` 再拷 |
| S2-7 | `server/services/sessions.js:63` | `save_sessions` 全量 `deleteMany(notIn)`（`[]` 即清库）+ 与 Python 双写窗口 | 空数组拒绝；双写期加互斥或改增量 upsert |
| S2-12 | `server/src/config.js:21` | DATABASE_URL 缺省 `file:./data/harbor.db` 锚 cwd | 与 main.js 一致锚 CONFIG_DIR |
| S2-21 | `server/src/auth.js:28` | AUTH_ENABLED=true 且无 AUTH_SECRET 仅 warn，回落固定 dev 密钥 | 无 secret 时直接拒绝启动 |
| S2-22（后半） | `guard.js:363-378` | token 未绑 sid（A 会话签发 B 可消费） | token 记录 sid，consume 时校验 |

### 5.3 资源/性能类（10 项）
| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| N7 | `application/registry.py:47` | `TaskRegistry._records` 只增不删 | 终态 ring buffer（需同步 `result()` 读取路径，本轮评估后缓行） |
| N9 | `sandbox_service.py:498` | 沙箱 `_read_pipe` 先全量进内存后截断 | 边读边截断 |
| N11 | `api.py:798` vs `763` | `open_url` 无 guard 挂点（`open_app` 有） | 入 GUARD_OPS 矩阵（改契约面） |
| S2-16 | `server/services/browser.js:40` | privateIp 漏 `febx::`；DNS 校验与实际解析两次查询（rebinding TOCTOU） | 补段 + 用解析结果直连 |
| S4-5 | `shell/grants.js:365` | 授权刷新与用户操作共享 seq，并发丢响应 | 独立 seq |
| S4-7/8 | `analytics/panel.js:181`、`providers/hybrid.js:408` | typeof 回退分支未转义（潜伏 XSS） | 回退分支也 escape |
| S4-9 | `analytics/tokens.js:140` | 10s interval 无清除句柄 | 页面级可接受，低优先 |
| S4-18 | `components/select.js:2` | `CS.reg` Map 强持 select（DOM 重建即泄漏） | LRU/WeakRef |
| D24 | `run-controller.js:595` | `onDelta` 每帧全文重解析（O(n²)） | **R39 首选**：块级冻结（F3a 6x 实证） |
| S4-15 | `expert/center.js:260` | `recoverExpertRun` 无 try/catch | 补 try + 状态复位 |

### 5.4 工具链/CI 类（6 项）
| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| S4-10 | `tools/build_hub_catalog.py:157` | 无守卫直读 WorkBuddy 缓存，非本机裸 traceback | 包 try + 人话退出 |
| S4-11 | `tools/build_hub_catalog.py:39` | 硬编码 `F:\workbuddy\...` 盘符 | 改相对/环境变量 |
| S4-12/13 | `tools/round_runner.py:32,53` | 硬编码用户名路径；`run()` 无 try | 环境变量 + try 记账 |
| S4-14 | `tools/probe_hub_mcp.py:64` | `ssl.CERT_NONE` + 启发式判 ready | 校验证书 + 结构化握手 |
| S4-16 | `.github/workflows/harbor-ci.yml:106` | 非 2 退出码（含脚本崩溃）在非严格模式一律 exit 0 | 区分 0/1/2 三态 |
| S4-19 | `tools/upgrade_audit.py:39` | import 期 `assert items` 裸崩 | 改显式 SystemExit 人话 |

### 5.5 代码卫生（5 项）
D13 `resume.js:1` 未闭合注释 │ D14 注释行号锚点失效 │ **S2-23 已修** │ S4-6 转义函数不转单引号（现役 sink 全双引号，纵深加固） │ S4-17 emoji 截断腰斩（纯展示）

### 5.6 明确**不做**的项
- **R36 12 疑点**全部裁决完毕，无遗留。
- 混合记忆（bigram→jieba→向量）升级：R36 裁决「<1000 条 bigram 站得住」，**触发条件**=条数过千或精确率投诉，届时再动。

---

## 6. 门禁与验证记录

### 6.1 终局全量
```
pytest tests/ -q  →  1938 passed / 1 failed / 3 skipped  (5m36s)
```
**唯一失败** `test_windows_packaging_dependencies::test_isolated_build_environment_has_complete_pywebview_runtime`：
已用 `git stash` 在**干净树**上复现 → **预存遗留**（打包环境依赖检查，与本轮任何改动无关）。

### 6.2 四门禁
| 门禁 | 命令 | 结果 |
|---|---|---|
| 构建幂等 | `node frontend/build.js` ×2 | 逐字节一致（31,027 行） |
| 五大 UI 契约 | `python deliverables/design/check_contract.py` | PASS（115 JS / 14 CSS） |
| 契约差分 | `python tools/contract_diff.py --snapshot …` | 锚点 r37 = 115 模块 / 1249 符号 |
| 升级审计 | `python tools/upgrade_audit.py` | PASS |

### 6.3 分域回归
- Node 桥 20 个测试脚本全过（改动 6 域分别单独复核 EXIT=0：guard/mcp/browser/update/checkpoint-git/system-misc/commands）。
- Python 定向：memory 相关 77 passed；store/session/group 527 passed；file/cmd 155 passed。

### 6.4 测试对齐说明（4 处，均非掩盖问题）
| 测试 | 原因 |
|---|---|
| `test_r20_scan_fixes.py` | 断言字面量钉住的是**缺陷行为**（`x.sid === __prevSid` 与注释相反），按注释语义改为 `!==` |
| `test_v13_qa.py` 桩 | v13 桩按**函数粒度**抽取拼装修，budget 三函数改为内联键逻辑（自包含） |
| `test_harbor_fix.py` 500 字符段窗口 | 注释外移到 handler 之外（保持文档 + 不占段窗口） |
| `test_group_mention.py` | 头像字改 textContent 装配（原依赖 escapeHtml，模块作用域无此符号） |

---

## 7. 遗留待办（按优先级，可直接派工）

### P0（建议下一轮立即做）
1. **块级冻结流式渲染**（D24）：`onDelta` 全文重解析 → 已闭合块冻结、只重渲染尾块；F3a 实证 6x 差距（1 万字 1.1s vs 6.4s）。落点 `markdown.js:23` + `run-controller.js:595`。
2. **R39 记忆模块 UI 完整化**：记忆面板逐条「删除 / 钉选 / 来源·置信度 / 上次命中」，以及 `memory_context_build` 接入发送链（当前仅 API 面与注入段可用）。

### P1（本轮留档中的高价值项）
3. 契约分叉 6 项（§5.1）双端同轮对齐 + 差分基线刷新。
4. 竞态 8 项（§5.2）：优先 S2-7（save_sessions 清库风险）、S2-12（DB 路径漂移）、S2-22 后半（token 绑 sid）。
5. `file://` → https 自定义协议（F2d）：解锁 V8 code cache，二次启动约 2×。

### P2
6. 资源类 10 项（§5.3）；工具链/CI 6 项（§5.4）；代码卫生 4 项（§5.5）。
7. `dist/Harbor.exe` 仍为 2026-10-26 旧包（前序遗留）——本批改动需重新打包才在安装版体现。

---

## 8. 接手操作手册

### 8.1 环境
```bash
PY="C:/Python315/python.exe"
export PYTHONPATH="C:/Users/陈/.workbuddy/binaries/python/envs/default/Lib/site-packages"
NODE="/c/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
```
- 测试口径必须是 `pytest tests/`（全仓跑会收集 `outputs/pytest-tmp/` 副本）。
- 打包必须用 vendor Py3.13（3.15 打包启动即崩）。

### 8.2 复跑四门禁
```bash
$NODE frontend/build.js && $NODE frontend/build.js     # 幂等
$PY deliverables/design/check_contract.py              # 五契约
$PY -m pytest tests/ -q                                # 全量（约 5-8 分钟）
$PY tools/contract_diff.py --snapshot deliverables/dev-plan/contract-baseline-r37.json
$PY tools/upgrade_audit.py
cd server && node test/guard.mjs && node test/smoke.mjs  # 桥侧
```

### 8.3 本轮踩过的坑（照抄避免重复）
1. **manifest 任何改动都要过 build lint**：新顶层符号必须登记 `provides`；手工插行极易破坏 JSON（本轮发生过一次，用精确 Edit 修复）。
2. **`api.py` 任何字节改动**（含 docstring）都会让契约锚点 `api_py_sha256` 漂移 → 必须重照快照再过 `contract_diff`/`upgrade_audit`。
3. **v13 桩按函数粒度抽取**：被抽函数必须自包含（不能引用同模块其它符号）。
4. **实例属性不要与方法同名**：`_legacy_fp` 曾遮蔽方法导致引擎永久不可用（已改 `_legacy_fp_seen`）。
5. **store.js 这类长函数做字符串替换**要防结尾 block 重复（本轮 D34 曾破坏语法，已修）。
6. 子代理**并发上限实测 1–2**；后台代理可用（`run_in_background`），但长跑仍可能被宿主回收。
7. Git Bash 下 `| tail` 会吞退出码——判断成败要 `echo EXIT=$?`。
8. `outputs/` 在 .gitignore：架构/扫描/调研报告都是本地留存，**未入库**（如需入库用 `git add -f`）。

### 8.4 关键约定（不可违反）
- js_api 契约零漂移：新方法一律 `_V12_EXTRA` 隐身。
- `config.json` 零污染：新配置走独立文件（本轮新增 `memory.db`）。
- 页面/工具输出=UNTRUSTED：进模型前 provenance 包裹；记忆的**安全边界在门控与确认档，不在提示词**。
- 跨 run/跨会话的模块级单例必须键控（本轮 D5 即此类）。

---

## 9. 交付物索引

| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R36-R38.md` |
| R37 交接 | `deliverables/dev-plan/R37-全夜任务交接报告.md` |
| 缺陷修复 | `deliverables/dev-plan/R37-缺陷修复报告.md`（51 项+升级，含每项修法） |
| 五方向调研 | `deliverables/dev-plan/R37-五方向调研汇总.md` |
| 记忆开发文档 v2 | `deliverables/dev-plan/Agent记忆模块开发文档-v2.md` |
| R36 调研主报告 | `deliverables/dev-plan/R36-记忆模块调研报告.md` + 轮次日志附录（206 行） |
| 架构勘察（本地） | `outputs/r37-arch/{fe,be}-architecture.md` |
| 缺陷扫描证据（本地） | `outputs/r37-defects/scan-S{1..4}-*.md` |
| 调研簇报告（本地） | `outputs/r37-research/F*.md` + `R37-轮次日志汇总索引.md` |
| 参考实现 | `agent_memory/memory_store.py`（v2）+ `demo.py`（44/44） |
| 门禁测试 | `tests/test_agent_memory.py`（32）、`tests/test_memory_db.py`（9） |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r37.json` |
