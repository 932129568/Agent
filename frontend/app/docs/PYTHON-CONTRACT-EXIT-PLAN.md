# C 路径：删除 Python 契约层的可执行方案（步骤 1–6 已执行，步骤 5/6 见 STEP5-DELETION-BOUNDARY）

> 对应 `ARCHITECTURE-BACKEND.md` §5.3 路径 C。
> **R70 执行结果角标**：以下为删除前原文，执行结果以
> `deliverables/dev-plan/STEP5-DELETION-BOUNDARY.md` §0 为准；步骤 1–6 均已执行完毕，
> 保留 §1–5 与历史状态行，仅为回溯依据。
> 状态：契约事实冻结于 `deliverables/dev-plan/frozen-python-surface.json`，
> Python 契约层已退役，Node / Electron 为唯一运行链。

## 1. 为什么 C 的代价是"重做契约测试"

Python 层当前不是运行时，而是 **oracle**：`tests/test_api_contract.py` 让
`legacy.Api()` 与 `backend.Api()` 跑同一调用序列，对 **51 个公开方法的输出逐字节比对**
（历史注释曾写 49/50，以 golden 自省面实测为准）。
删掉 Python 层 = 删掉比对的一端。若只是把测试删了，就失去"双实现互相印证"的防漂移能力，
js_api 契约从**可证伪**退化为**自证**。因此必须先把 legacy 行为固化成独立基准，再删实现。

## 2. 影响面（本轮实测）

| 项 | 数量 | 说明 |
|---|---|---|
| 直接 import backend 的 pytest 文件 | **74 / 154**（48%） | 需逐域判定：迁到 Node 等价测试，或保留纯逻辑模块 |
| `backend/` 子树 Python 文件 | **112** | 契约层 + guard / memory / mcp / tools_schema / provenance 等纯逻辑 |
| `backend/api.py` 方法定义 | **179** | 其中 51 个公开方法进入逐字节契约 |
| Python 入口 / spec | **4** | `main.py`、`main_v1.0.0_legacy.py`、`Harbor.spec`、`Harbor-mac.spec` |
| 冻结锚点 | **r68 基线** | `api_py_sha256`、`golden_sha256`、`API_VERSION`、`function_defs`、`symbols` |
| 发布门 | `test_api_contract.py` / `test_release_discipline.py` / `contract_diff.py` | 三项都要改口径 |

## 3. 执行步骤（每步独立可验证）

1. **✅ 步骤 1 已完成：导出并冻结 golden 快照**。复用
   `tests/test_api_contract.py::run_suite(legacy.Api(), stubs)` 的完整调用序列
   （95 项），经 `norm()` 与 golden 专用的 `test_home_* → <TEST_HOME>` 归一化，
   落 `deliverables/dev-plan/contract-golden/api-suite.json`。
   `tests/test_contract_golden.py` 只做静态冻结校验（哈希 / 序列数 / 结构），
   行为重放由 `tools/contract_golden_replay.py` 在**独立子进程**执行：
   已实证全量 pytest 中前序测试会改写 RuntimeState 的 ws_enabled 开关，
   使 `list_dir_root` 文案漂移；独立进程天然无污染。
   导出 1 次 + 独立进程重放复验均通过。sha256 与序列数写入
   `frontend/app/docs/golden-manifest.json`，由 `arch-contract.mjs` 强制校验。
2. **✅ 步骤 2 已完成：Node 侧公开契约面等价门**。新增
   `server/test/contract-golden.mjs`：校验 golden sha256、95 项序列数、冻结自省面结构，
   并**运行时重放** `invoke('get_api_info')`，把 Node 的 `version` 与 51 个公开方法
   与 frozen golden 逐项比对（实测含顺序完全一致），同时检查 165 个注册方法零幽灵。
   **诚实边界**：这是公开契约面等价，不是 95 项调用序列的逐输出重放——后者需要
   Node 侧 fake stubs 与 Python 侧等价，列为步骤 2b，未完成。
3. **✅ 步骤 3 已完成：golden 哈希进入契约冻结面**。`tools/contract_diff.py` 的
   `collect()` 与 `FROZEN` 新增 `golden_sha256`，生成
   `deliverables/dev-plan/contract-baseline-r68.json`，`--compare` 零漂移 PASS，
   `test_contract_diff.py` 11 passed。快照独立于 Node 实现生成并锁定，不构成自证。
4. **步骤 4 第一批已完成基础设施：逐域处置 74 个 pytest 文件**。
   `tools/gen_test_disposition.py` 生成 `frontend/app/docs/backend-test-disposition.json`
   （74 条逐文件 modules / 分类 / 策略 / 理由 / reviewRequired），分类为
   `domains` 65 / `contract` 4 / `application` 2 / `tools_schema` 1 / `other` 1 / 第一批 1。
   第一批 `test_v19_paths.py` 已由 `server/test/config-discipline.mjs` 等价覆盖前三个钉，
   第四个 `Harbor.spec` 钉属 pywebview 历史链随步骤 5 退役；台账逐条登记旧钉→新钉与理由。
   **未物理删测试**——按 R65 教训，删码与改测试必须同一次提交，统一留到步骤 5。
   剩余 73 条 `reviewRequired: true` 仍需按域补 Node 等价单测后逐条复核。
   **第二批**：跑全量 `server/test/*.mjs` 25 个脚本（24 个可跑门禁全 PASS，
   `auth-migrate.mjs` 为历史一次性迁移脚本、依赖已移除的具名导出，登记为非门禁边界）；
   建立 `frontend/app/docs/domain-equivalence-map.json` 把 9 个 `backend.domains`
   子域映射到 Node 服务与测试门（48 个引用全部存在），
   `server/test/domain-equivalence.mjs` 静态校验；
   台账升级 v2，**74/74 条全部定位到具体 Node 等价门**。
   诚实边界：`mapped-not-behavior-verified`，定位不等于行为等价，
   `reviewRequired` 仍需逐条销项。
   **第三批**：实跑三个 Node 门（31/12/23 检查项），逐条复核 memory +
   observability 的 3 文件 **24 个行为钉**，结论
   `covered` 1 / `partial` 6 / **`gap` 10** / `python-implementation-detail` 3 /
   `frontend-contract` 4，**不可进入步骤 5**。证据写入
   `frontend/app/docs/behavior-review-batch1.json`；台账升级 v3，
   有缺口时门禁禁止销 `reviewRequired`。
   优先补测：记忆门控敏感字段拒写、trace span/read、群上下文交接、open_url token 透传。
   **第四批**：确认 `server/src/services/pybridge.js` 是 R55 的 Node 原生 I/O + libsql
   实现（非 Python 进程桥），`memoryWrite` 已含 SENSITIVE 正则/空内容拒绝/去重，
   因此补 `server/test/memory-gate.mjs`（5 项检查）销掉
   `test_remember_gate_rejects_sensitive` → `covered-by-node-gate`。
   同时实测发现 **DEF-01**：去重查 `fact_records` 却写 `profile_kv`，重复写入仍
   `upsert`，`test_legacy_multi_note_no_supersede` 由 partial 改判 gap。
   按 QA 口径 FAIL 即停、回传复现包、**未修改 pybridge.js**，待用户授权修复。
   净缺口仍 10，步骤 5 仍被阻断。协议形状差异（Python action/reason vs Node error）
   已如实登记，不宣称逐字节等价。
   **第五批（用户「授权」）**：仅改 `pybridge.memoryWrite` 一处——保留
   `fact_records` 去重并补查 `profile_kv` 的 `(user_id, value)`，命中返回
   `noop/duplicate`；`memory-gate.mjs` 去重硬断言恢复并通过，server 26/26 无回归。
   `test_legacy_multi_note_no_supersede` 销为 `covered-by-node-gate`，
   累计销 2 项、`blockingGaps` **10 → 9**、未修复缺陷归零。
   复核证据 v3 改判「修复有授权与复验依据」。
   **第六批**：逐条重读剩余 9 个 gap 的断言原文，发现上一轮按 import 归类有误——
   2 个是 Python agent_memory 内部 SQL/哈希链语义（`python-implementation-detail`）、
   4 个是前端源码静态钉（`frontend-contract`，由 `arch-contract.mjs` 新增 5 条
   `frontendLiteralGates` 字面量门承担）、2 个是前端 VM 行为钉
   （`deferred-to-react-migration`，待 B4 群聊域组件测试）。
   真后端缺口收敛到 **3 个**：`memory_context_build`（Node 侧 NOT_MIGRATED）、
   trace span 接线、trace 保留期清理。`blockingGaps` **9 → 3**、累计销 8 项；
   复核证据 v4、台账 v3 重算。步骤 5 仍需这 3 项 + 2 项 B4 测试 + 5 项 partial 复核。
   **第七批**：`server/test/memory-injection.mjs`（3 检查）证明
   `buildSystemPrompt` 的 `memoryTail()` 已注入长期记忆段、`memoryEntriesList`
   带 source/pinned、`memoryEntryPin` 可置位，故 `extras_block` 钉由 gap 降为
   `partial`（标题/字母序/pin 置前未复刻，如实登记）。
   另两项经核实是**真实实现缺口**：DEF-02（Node 无 `gen_ai.span` 写入与
   `agent.run`/`tool.open_url` 接线）、DEF-03（无 `RETENTION_DAYS=14` 清理）。
   按 QA 口径回传完整信息、**未修改引擎代码**，待授权。
   `blockingGaps` **3 → 2**、累计销 9 项，复核证据 v5。
5. **删实现**：`backend/*.py`、`main.py`、`main_v1.0.0_legacy.py`、
   `Harbor.spec`、`Harbor-mac.spec`、`installer/` 中 pywebview 相关；
   清理 `electron-builder.yml` 注释、`AGENTS.md`、`KNOWN_ISSUES.md`、HANDOVER 链。
6. **全量门禁**：golden 门 + server 七套 + `pytest tests/ -q` 全绿 + 运行时 16/16 +
   UI 契约 + 棘轮 + 打包 asar 核验（确认包内零 `.py`）。
7. **刷新交接**：新增 `HANDOVER-R<N>.md`，记录 oracle 迁移前后防漂移能力的等价性论证。

## 4. 风险与权衡（必须如实说明）

| 风险 | 说明 | 缓解 |
|---|---|---|
| 防漂移能力下降 | 双实现互证 → 单实现 + 快照，若有人同时改坏实现与快照，门禁发现不了 | 快照由独立脚本从**冻结的 legacy 提交**生成；快照哈希写入契约锚点；快照文件只增不改并逐笔 review |
| 覆盖面缺口 | 74 个测试文件里若有行为只被 Python 侧覆盖，删除后即失去钉 | 步骤 4 要求每域先补 Node 等价测试再删，登记表逐条理由 |
| 版本线冲突 | 与 R60「本地重放链 / 禁 fetch+reset」及当前 r67 锚点链叠加 | 全部本地提交，不推送；锚点按 r68+ 递增 |
| 无运行时收益 | Python 本就不进 asar，删除只减仓库体积与双轨维护 | 收益是架构纯粹性，需产品确认值得 |

## 5. 结论与决策点

- **事实**：Python 层不进生产包、server 运行时零调用；C 是架构纯粹性改造，不是修复。
- **判断**：C 的最大代价不是删文件，是**重建等价的防漂移证据链**（步骤 1–3）。
  在快照未冻结前删除 Python 层，等于拆掉发布门。
- **下一步需确认**：是否投入步骤 2b（Node 侧逐输出重放 95 项，工作量较大），
  以及是否授权步骤 4–6（逐域处置 74 个测试文件 → 删 Python 实现 → 全量交接）。
  当前已按依赖顺序完成 C 的步骤 1–3，Python 实现尚未删除。

> 本轮新增产物：golden 快照 + 独立进程重放器 + 冻结 manifest + Node 契约门 + r68 锚点。
> 未修改任何生产代码，未删除任何 Python 文件，`backend/api.py` 契约哈希零漂移。
