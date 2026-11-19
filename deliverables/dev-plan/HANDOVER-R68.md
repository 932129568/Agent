# HANDOVER-R68 — 全栈规范化架构（规范先行轮）

> 日期：2026-11-10。接续 `HANDOVER-R67.md`（R67 提交 `df9d6c6`）。
> 用户口径变更：R67 的「React 唯一 DOM 生成层 + legacy 服务层」被判定**未达标**；
> 用户要求「全面抛弃 legacy、全面接入 React、必须规范化」，随后在四条执行口径中
> 选择 **「先定规范再重写」**，并追加「现有 React 也规范化」「Node 及其他后端框架也规范化」
> 「Python 契约层为什么还没迁入框架」。
> 本轮因此是**规范 + 可执行门禁 + 可运行骨架 + 现状审计**，评审确认后才批量重写。

---

## 0. 一眼总览

| 维度 | 状态 |
|---|---|
| 前端规范 | `frontend/app/ARCHITECTURE.md`（13 节：分层 / 状态 / 服务 / DOM / 测试 / 契约演进 / B0–B9 / 红线） |
| 全栈后端规范 | `frontend/app/ARCHITECTURE-BACKEND.md`（7 节：Node / Electron / installer / **Python 契约层**） |
| 骨架 | `frontend/app/` 共 **60 项清单文件**，清单驱动、门禁逐项校验（`docs/skeleton-manifest.json`） |
| 骨架可运行 | 构建 711,854 B；L1 单测 **12/12**；L2 真实浏览器挂载 **6/6** |
| 架构门禁 | `frontend/app/tests/arch-contract.mjs` → **30/30 PASS** |
| 现有 React 审计 | 16 个文件：**2 已合规 / 14 迁移期违规**，18 项违规逐文件登记 5 组例外与退出条件 |
| 后端审计 | 打包白名单无 `backend/*.py`、server 零 python spawn、`api.py` 哈希零漂移 |
| Python 契约层 | 定位为**契约 oracle（非运行时）**；C 路径方案已成文，**未执行、需授权** |
| pytest | 全量 **2077 passed / 0 failed / 3 skipped**；R68 新增 11 项全通过 |
| R67 生产链 | 未改动，`harbor.html` 不含骨架 bundle；运行时验收 16/16 |
| 提交 | 本地（未推送，R60 口径） |

---

## 1. 用户追问的直接回答：Python 契约层为什么没"迁入框架"

**结论：它不是漏迁的运行层，是刻意保留的契约 oracle；搬进 React/Node 没有任何运行时收益，
却会立刻打断逐字节发布门。**

已核实证据：

| 事实 | 证据 |
|---|---|
| 不进生产包 | `electron-builder.yml` 的 files 白名单只有 `backend/prompts/**/*`、`backend/experts_builtin/**/*`，**无任何 `backend/*.py`** |
| 运行时不被调用 | `server/src` 中 `spawn/execFile python` **零命中** |
| 存在的唯一理由 | `tests/test_api_contract.py` 让 `legacy.Api()` 与 `backend.Api()` 跑同一调用序列，对 **49 个公开方法输出逐字节比对** |
| 冻结项 | `API_VERSION='v1.0.0'`、`get_api_info()` 输出、`_V12_EXTRA` 隐身规则、`contract_diff.py` 的 `api_py_sha256` |
| 迁移代价 | **75/153 个 pytest 文件（49%）** 直接 import backend；112 个 Python 文件；`api.py` 179 个方法定义；4 个入口/spec |

规范化落点（`ARCHITECTURE-BACKEND.md` §5.2）：把它登记为全栈第 5 层「契约层（Oracle）」，
写死职责边界——唯一职责是提供 legacy 行为基准；冻结输出与哈希；禁止新增运行时依赖、
禁止被 server 调用、禁止改公开方法形状；允许新增方法进 `_V12_EXTRA`。
门禁已把 `api_py_sha256`、白名单、零 python spawn 等做成只读断言。

**C 路径（删除 Python 层）**：用户点出「C 删除 Python 层需重做契约测试」——判断正确。
`docs/PYTHON-CONTRACT-EXIT-PLAN.md` 给出 7 步可执行方案，核心是**先把 49 方法行为导出并冻结
golden 快照，建 Node 侧等价门，再逐域处置 75 个 pytest 文件，最后才删实现**。
在快照未冻结前删除 = 拆掉发布门，使契约从「双实现可证伪」退化为「单实现自证」。
该方案**未执行**，需用户明确授权（与"评审前不改生产代码"口径冲突）。

---

## 2. 骨架补齐（针对用户"还有漏"的整改）

上一版骨架只落地了核心文件，规范 §3–§7 声明的多条路径仍是空目录。本轮改为**清单驱动**：

- `docs/skeleton-manifest.json` 列出 60 个必需文件 + 13 个必需目录 + 17 个前端域；
- `arch-contract.mjs` 逐项校验存在性，缺一项即 FAIL；
- `tools/gen-layout.mjs` 幂等生成 10 个 `layout/` 区域外壳，杜绝"只建目录不建文件"。

补齐内容：

| 层 | 新增 |
|---|---|
| `state/actions/` | 4 个域动作 + index（组件不得直接写 store） |
| `services/` | `tools.js`（工具循环/护栏）、`sanitize.js`（Markdown 净化）、`cache.js`（TTL/单飞/有界重试）、`index.js` |
| `platform/` | `libs.js`、`theme.js`、`storage.js`（config.json 写入守卫） |
| `layout/` | 10 个 PascalCase 区域组件 + `index.js` 导出真实组件（App.jsx 已改为渲染它们） |
| `ui/` | `Panel.jsx`、`Icon.jsx`、`Spinner.jsx` |
| `features/_template/` | 四件套 + `Feature.test.mjs`（模板自身契约测试） |
| `tests/` | `unit.test.mjs`（12 项 L1）、`smoke-render.mjs`（6 项 L2 真实浏览器） |
| 文档 | `README.md` 评审入口、两份规范、三份审计/方案 |

---

## 3. 现有 React 也规范化（只读审计，不改生产代码）

`docs/react-assets.json` + `docs/EXISTING-REACT-AUDIT.md`：

- 16 个 JS/JSX 文件，`SessionHistory.jsx` / `ParallelRuns.jsx` **2 个已合规**；
- 14 个带迁移期违规，共 18 项，分 5 类：`DOM_API` / `STRING_EVAL` / `STRING_EVENT` /
  `GLOBAL_SYMBOL` / `MODULE_STATE`；
- 5 组例外（EX-01…EX-05）逐条写明**理由 + 涉及文件 + 退出条件**，例如
  `data-h-events` 的退出条件是「B0 把 10 区域迁入 layout/ 并改 onClick，生成器与
  generated/ 一并删除」；
- 门禁强制：任何未登记的违规、任何新增违规、任何失效登记路径 → FAIL；
- 终态判据六项（例外归零 / 事件桥归零 / 全局符号归零 / generated 删除 / 单一分片 store /
  门禁通过）写进 JSON，逐轮度量。

资产去向映射见审计文档 §3；R67 的 `frontend/react/` 本轮**零修改**。

---

## 4. Node 及其他后端框架规范化

`ARCHITECTURE-BACKEND.md`：

- **Node 服务分层**：`http/ → application/ → domain/ → infra/` 单向；routes 禁止直接
  实例化 Prisma/chromium/MCP SDK；重依赖动态 import + 单飞（R60/R64 口径），
  冷 import 预算 ≤ 600 ms（当前 516 ms）；统一响应与错误码；per-sid 会话隔离；
  js_api 冻结；config.json 零污染；provenance 包裹；六套 server 门禁。
- **已知环** `browser ↔ guard ↔ misc` 登记为迁移期例外并写收敛条件（guard 判定下沉 domain/）。
- **Electron 主进程**：职责只含窗口/proxy-bypass/CORS/拉起 server；禁止业务逻辑与
  新增业务 IPC 通道。
- **installer / pywebview 链**：定位为发布工具与历史链，R54 起不进生产包；
  卸载测试的运行中环境性失败登记为已知边界。
- 门禁只读审计：白名单、零 python spawn、`api.py` 哈希、`API_VERSION`/`_V12_EXTRA`、
  `test_api_contract.py`、规范章节、C 路径未擅自执行。

---

## 5. 评审待拍板（确认后才动生产代码）

**前端（`ARCHITECTURE.md` §13）**：① UI 契约终态是否废止；② collaboration 去留；
③ 是否引入新依赖；④ 每批是否需真机签字。

**后端（`ARCHITECTURE-BACKEND.md` §7）**：① **Python 契约层 A/B/C 路径**（推荐 A）；
② `server/src` 是否物理重排；③ 已知环是否本轮解开；④ 冷启动预算是否进发布门。

**C 路径专项**：是否授权删除 Python 层并重做契约测试（`docs/PYTHON-CONTRACT-EXIT-PLAN.md`）。

**B0 开工授权**：外壳/布局 13 模块迁移。

---

## 6. 验证记录（本轮实测）

| 项 | 结果 |
|---|---|
| `node frontend/app/tests/arch-contract.mjs` | **30/30 PASS** |
| `node frontend/app/tools/gen-layout.mjs` | 10 个区域组件，幂等 |
| `node frontend/app/build.mjs` | `dist/harbor-app.iife.js` 711,854 B |
| `node --test unit.test.mjs + Feature.test.mjs` | **12/12 PASS** |
| `node frontend/app/tests/smoke-render.mjs` | **6/6 PASS**（真实 Edge 挂载、10 区域、store 派生、零业务全局符号） |
| `pytest tests/test_r68_arch_contract.py -q` | **11 passed** |
| `node tools/verify-react-render.mjs` | R67 生产链 **16/16 PASS**（DOMContentLoaded 810 ms 本次采样） |
| 全量 `pytest tests/ -q` | **2077 passed / 0 failed / 3 skipped**（584s；R67 为 2066，本轮 +11） |
| `harbor.html` | 未变（4,045,428 B），不含 `HarborApp` |

> 事实与判断区分：以上数字为实测；§5 的推荐路径、A 优于 C 的判断、B0 顺序为工程判断；
> C 路径影响面（75/153、112、179）为 grep/统计实测。

---

## 7. 边界与下一步

- 本轮**未修改**任何生产代码：`frontend/src/`（117 模块）、`frontend/react/`（16 文件）、
  `server/`、`electron/`、`backend/`、`installer/`、`harbor.html` 全部原状；
  `migration-ledger.json` 所有批次仍为 `pending`（B9 冻结）。
- 骨架产物 `frontend/app/dist/` 由 `.gitignore` 排除，不入库。
- 推送维持本地（R60 叫停 + 远端等效重放链，禁 `fetch + reset --soft`）。
- 用户确认口径后：按 `migration-ledger.json` 的 B0 → B9 启动逐域重写，
  每批走 §8.2 的六项门禁；若选择 C，先执行 `PYTHON-CONTRACT-EXIT-PLAN.md` 步骤 1–3
  冻结 golden 快照，再删实现。

---

## 8. 执行补记（用户「按我的意思进行」后）

用户授权按最激进口径推进，本轮**从规范转入实际执行**，按依赖关系完成两项：

### 8.1 B0 真实结构迁移（不再是占位）

- `frontend/app/tools/gen-layout.mjs` 升级为从 R67 `frontend/react/src/generated/<Area>.jsx`
  **投影真实结构**到规范 `src/layout/<Area>.jsx`：剥离 **85 处** `data-h-events` 事件桥、
  给根元素注入稳定 `data-area`、保留全部 `id/class/style/aria/defaultValue` 结构属性。
- 门禁新增三项验证：`B0 真实结构已投影 10/10`、`规范 layout 零事件桥`、
  `B0 结构零丢失（300 个 id 全覆盖）`——**300 个 id 一个未丢**。
- 骨架 bundle 由 711,854 B 增至 **851,045 B**；L1 12/12、L2 6/6 仍全通过。
- R67 的 `frontend/react/` 与 `harbor.html` **零修改**（生产链不受影响）。

### 8.2 C 路径步骤 1：golden 契约快照冻结

- 新增 `tests/test_contract_golden.py`：复用 `test_api_contract.py::run_suite(legacy.Api(), stubs)`
  的完整 **95 项调用序列**，经 `norm()` + golden 专用 `test_home_* → <TEST_HOME>` 归一化
  （原契约测试两侧共用同一 HOME，跨进程冻结必须额外抹掉随机临时目录名——这是首次复验
  漂移的根因）。
- 产物 `deliverables/dev-plan/contract-golden/api-suite.json`，
  sha256 `ad7cfe30c06b2df189d4504a9d87f95b86f94969c323d2b6ce58555c72fa5999`，
  写入 `frontend/app/docs/golden-manifest.json`，由架构门禁校验。
- 确定性实证：导出 1 次 + **独立进程重放**均通过。全量回归首次暴露
  `list_dir_root` 漂移，根因是前序测试改写了进程内 `RuntimeState.ws_enabled`；
  已把重放从 pytest 进程内移到 `tools/contract_golden_replay.py` 独立子进程，
  `tests/test_contract_golden.py` 改为静态冻结校验 + subprocess 调用重放器。
- `PYTHON-CONTRACT-EXIT-PLAN.md` 状态更新为「步骤 1 已执行，步骤 2–7 待续」；
  门禁把「C 未执行」改判为「C-1 已冻结、删除实现仍需授权」。

### 8.3 本阶段验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **36/36 PASS**（新增 6 项：golden 哈希/序列数/删除门禁、B0 三结构断言、关联文件） |
| 骨架构建 | 851,045 B |
| L1 `node --test` | 12/12 |
| L2 真实 Edge 挂载 | 6/6 |
| `pytest tests/test_r68_arch_contract.py tests/test_contract_golden.py -q` | **14 passed** |
| 全量 `pytest tests/ -q` | **2080 passed / 0 failed / 3 skipped**（470s；独立进程重放修复状态污染后复跑） |

### 8.4 边界与下一步

- **未删除任何 Python 文件**：`backend/api.py` 契约哈希零漂移，`conftest.py` 仍从
  `main_v1.0.0_legacy.py` 加载 legacy。原因是步骤 2–3（Node 侧等价门 + 锚点冻结）
  尚未建立，此时删除会把发布门从「可证伪」退化为「自证」。
- 下一步按依赖顺序：① 建 `server/test/contract-golden.mjs` 让 Node registry 重放同一序列；
  ② 把 golden sha256 写进契约锚点；③ 逐域处置 75/153 个 import backend 的 pytest 文件；
  ④ 才允许删实现。B0 的逻辑迁移（shell 13 模块）与 C 可并行推进。
- 生产链仍全绿；R67 运行时验收 16/16 未受影响。

---

## 9. 执行补记 2（用户「继续」：C 步骤 2–3）

### 9.1 步骤 2：Node 侧公开契约面等价门

- 新增 `server/test/contract-golden.mjs`：校验 golden sha256 与 manifest 一致、
  95 项序列数、冻结自省面结构；**运行时重放** `invoke('get_api_info')`，
  把 Node 的 `version` 与公开方法集合与 frozen golden 逐项比对。
- 实测：`frozen_public_methods = node_public_methods = 51`、**顺序也完全一致**、
  165 个注册方法**零幽灵**、`golden_sha256` 一致。
- **诚实边界**：这是公开契约面（51 方法 + 版本）等价，不是 95 项调用序列的逐输出重放；
  后者需要 Node 侧 fake stubs 与 Python 侧等价，登记为步骤 2b，未完成，不得冒充。
- 顺带纠正历史文档漂移：注释长期写 49/50 个公开方法，实测为 **51**，
  以 `golden-manifest.json` 的 `frozenPublicMethods` 为准。

### 9.2 步骤 3：golden 哈希进入契约冻结面

- `tools/contract_diff.py` 的 `collect()` 与 `FROZEN` 新增 `golden_sha256`
  （快照缺失时为 `None`，不硬崩）；生成 `contract-baseline-r68.json`。
- `--compare r68` **零漂移 PASS**；`test_contract_diff.py` **11 passed**；
  锚点链自动取最大编号 r68，历史 r67 保留。

### 9.3 本阶段验证

| 项 | 结果 |
|---|---|
| `server/test/contract-golden.mjs` | PASS（51/51 方法、零幽灵） |
| `arch-contract.mjs` | **39/39**（新增 3 项 C-2/3 断言） |
| `pytest test_r68 + golden + contract_diff -q` | **26 passed** |
| UI 契约 / 棘轮 / 契约差分 r68 | PASS / 157 / 零漂移 |
| 全量 `pytest tests/ -q` | **2081 passed / 0 failed / 3 skipped**（331s） |

### 9.4 边界与下一步

- **Python 实现仍未删**：`backend/api.py` 哈希零漂移，`conftest.py` 仍从
  `main_v1.0.0_legacy.py` 加载 legacy。删除前必须完成步骤 4：
  逐域处置 **75/153** 个 import backend 的 pytest 文件（每域先补 Node 等价测试再删，
  逐条写明「为何该钉不再钉」，R65 教训）。
- 可选步骤 2b：Node 侧逐输出重放 95 项，进一步增强防漂移能力。
- C 路径状态文件 `docs/golden-manifest.json` 已从 `step1-frozen` 推进到
  `step3-frozen`，门禁与 pytest 断言同步。

---

## 10. 执行补记 3（用户「下一步」：C 步骤 4 第一批）

### 10.1 精确盘点

实测 **74 个** pytest 文件耦合 backend（此前 75 的统计口径含 conftest 差异，以 74 为准）。
按耦合域初分：`domains` 65 / `contract` 4 / `application` 2 / `tools_schema` 1 /
`other` 1 / 第一批 1。生成脚本 `tools/gen_test_disposition.py` 可复跑，
产物 `frontend/app/docs/backend-test-disposition.json`（逐文件 modules / category /
strategy / rationale / reviewRequired）。

### 10.2 第一批闭环（不物理删测试）

- 选 `tests/test_v19_paths.py`（70 行、纯路径/打包纪律）作第一批。
  新增 `server/test/config-discipline.mjs` 作为 Node 侧等价门，覆盖其前三个行为钉：
  `CONFIG_PATH` 指向 config.json 且 `CONFIG_DIR` 可隔离、运行态一律独立
  `harbor-node-runtime.json`、独立配置族互异且不与 config.json 重合、`ensureDir` 幂等。
  实测 9 个独立 JSON 配置族、PASS。
- 第四个钉（`Harbor.spec` 的 datas / hiddenimports）属 pywebview 历史链，
  不迁到 Node；随步骤 5 删实现一并退役。台账逐条登记
  `oldPins → newPins` 与「为何该钉不再以旧形态存在」。
- **按 R65 教训，未物理删除该测试**：删码、改测试、逐条理由必须同一次提交，
  因此统一留到步骤 5（与删 Python 实现同批）。门禁已断言「第一批测试文件仍在」。

### 10.3 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **43/43**（新增 4 项台账断言） |
| server 门禁 | **八套全 PASS**（连跑两轮确认稳定；一次 `group-files` 偶发失败经单独复跑 16/16 PASS） |
| `config-discipline.mjs` | PASS（9 个独立 JSON 配置族） |
| 定向 pytest | **27 passed**（R68 + golden + contract_diff） |
| 全量 `pytest tests/ -q` | **2082 passed / 0 failed / 3 skipped**（479s） |

### 10.4 边界与下一步

- 步骤 4 剩余：65 个 `domains` 耦合文件需按域补 Node 等价单测并逐条复核；
  台账中 `reviewRequired: true` 的 73 条即剩余工作量，机器初分不等于结论。
- 步骤 5 触发条件：全部 74 条有等价覆盖或明确退役理由后，才与删实现同批删除。
- 可选并行：步骤 2b（Node 逐输出重放 95 项）、B0 的 shell 13 模块逻辑迁移。
- 生产链仍零改动；未推送。

---

## 11. 执行补记 4（用户「继续，无缝接上」：C 步骤 4 第二批）

### 11.1 全量 server 门禁实测

首次跑 `server/test/*.mjs` 全部 **25 个**脚本：**24 PASS / 1 非门禁**。
`auth-migrate.mjs` 是历史一次性 better-auth 迁移脚本，
`import { auth } from '../src/auth.js'` 依赖已移除的具名导出（该模块现导出
`ensureAuth` / `authEnabled` / `authSqlitePath`），单独复跑 rc=1 SyntaxError。
按「不越界修引擎代码」登记为**已知边界**，不计入门禁数；未修改该文件。

### 11.2 九域映射

- 新增 `frontend/app/docs/domain-equivalence-map.json`：
  9 个 `backend.domains` 子域 → Node 服务实现 + 已存在的 server 测试门，
  共 **48 个引用**全部核实存在。子域引用分布（按耦合测试文件数）：
  `integrations` 28 / `security` 24 / `workspace` 21 / `providers` 19 /
  `planning` 7 / `settings` 6 / `expert` 4 / `observability` 2 / `memory` 1。
- 新增 `server/test/domain-equivalence.mjs`：静态校验 9 个子域的 Python 目录、
  Node 服务、测试门均存在，并钉死「24 个既有可跑门 + 本门 = 25」、
  「1 个历史迁移脚本非门禁」的口径。
- **诚实边界**：`equivalenceStatus = mapped-not-behavior-verified`——
  定位到门不等于行为逐条等价，门禁明确拒绝把两者混同。

### 11.3 台账升级 v2

`tools/gen_test_disposition.py` 读映射表为每条分配 `domains` / `nodeGates` /
`nodeCoverageLocated`。重新生成后 **74/74 条全部定位到具体 Node 等价门，零缺失**；
`reviewRequired` 仍保持 true（行为复核未销项），物理删除仍留步骤 5。

### 11.4 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **47/47**（新增 4 项域映射断言） |
| `server/test/domain-equivalence.mjs` | PASS（9 域 / 48 引用 / 25 门） |
| server 门禁 | 24 个既有可跑门全 PASS（25 个脚本中 1 个历史迁移脚本除外） |
| 定向 pytest | **28 passed** |
| 全量 `pytest tests/ -q` | **2083 passed / 0 failed / 3 skipped**（472s） |

### 11.5 边界与下一步

- 剩余工作从「65 条未分类」收敛为「74 条已定位、待逐条行为复核」：
  按子域成批运行 `nodeGates`、对照 Python 行为钉销 `reviewRequired`。
- 步骤 5 触发条件不变：全部销项后才与删 Python 实现同批删除测试。
- 生产链零改动；未推送。

---

## 12. 执行补记 5（用户「下一步」：C 步骤 4 第三批 · 逐条行为复核）

### 12.1 复核方法

选两个小域做可验证示范：`memory` + `observability`，共 **3 个 pytest 文件 / 24 个行为钉**。
实跑对应 Node 门取实际检查项：`state-services.mjs` 31 项（其中 memory 相关 10 项）、
`parallel.mjs` 12 项、`system-misc.mjs` 23 项（自带 `uncovered` 声明：
`open_app/open_url`、GUI 对话框、GUI 截图）。逐条对照后写入
`frontend/app/docs/behavior-review-batch1.json`，每条钉给出 verdict 与证据。

### 12.2 结论：不可进入步骤 5

| verdict | 数量 | 含义 |
|---|---|---|
| `covered-by-contract-golden` | 1 | 由 golden / Node 公开面门承担 |
| `partial` | 6 | 同名能力有覆盖，但缺排序衰减、scrub、span/read 等关键子行为 |
| **`gap`** | **10** | Node 门无对应断言，必须先补等价测试 |
| `python-implementation-detail` | 3 | WAL / 迁移 / extras 容器，删实现后自然消失 |
| `frontend-contract` | 4 | 前端静态契约钉，改由 `arch-contract.mjs` + `check_contract.py` 承担 |

优先缺口：记忆门控敏感字段拒写（`AGENTS.md` 红线）、trace span/read、
群上下文交接、`open_url` token 透传。

### 12.3 台账 v3 与防冒进门禁

`tools/gen_test_disposition.py` 读复核记录，为 3 个文件写入
`behaviorReviewed` / `reviewedPins` / `verdictSummary` / `blockingGaps` /
`reviewConclusion = gaps-found`；`test_r48_scanfix.py` 额外登记 `frontendGates`。
门禁新增 4 项，其中 **「有缺口时不得销 `reviewRequired`」** 直接阻断步骤 5，
避免把"定位到门"冒充"行为已验证"。

### 12.4 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **51/51**（新增 4 项复核断言） |
| 定向 pytest | **29 passed** |
| 全量 `pytest tests/ -q` | **2084 passed / 0 failed / 3 skipped**（460s） |

### 12.5 边界与下一步

- 本批**不销任何 `reviewRequired`**：结论是发现 10 个缺口，而非完成复核。
  按 QA 口径，发现缺口即停并回传，不越界修引擎代码。
- 下一步按优先级补 Node 等价测试（记忆门控 / trace / 群上下文 / open_url），
  补一条销一条；随后按域继续复核剩余 71 条。
- 生产链零改动；未推送。

---

## 13. 执行补记 6（用户「继续」：C 步骤 4 第四批 · 补门销项 + FAIL 回传）

### 13.1 关键澄清：pybridge 不是 Python 进程桥

`server/src/services/pybridge.js` 文件头明确：R55 用 **Node 原生 I/O + libsql 直读
memory.db** 补齐了 14/16 个曾返回 NOT_MIGRATED 的方法，`memory_remember` 委托
`pybridge.memoryWrite`，其中已含 `SENSITIVE` 正则、空内容拒绝、去重写入。
因此「记忆门控敏感字段拒写」是**测试缺口，不是实现缺口**——可补断言门，无需改引擎代码。
（`memory_context_build` / `memory_audit_query` 仍为 NOT_MIGRATED，属另一类边界。）

### 13.2 新增等价门：销 1 项

`server/test/memory-gate.mjs`（5 项检查，隔离 `HARBOR_CONFIG_DIR`）：空内容拒绝、
**6 类敏感文本全部拒写且给出原因**、拒写内容未落库、正常写入可用、软/硬擦除接口可用。
据此把 `test_remember_gate_rejects_sensitive` 从 `gap` 销为 `covered-by-node-gate`
（`AGENTS.md` 红线）。

**协议形状差异（如实登记）**：Python 内部服务返回
`{action:'rejected', reason:'sensitive...'}`，Node 返回 `{error:'内容包含敏感字段…'}`；
语义同为拒绝写入，但**非逐字节等价**，不得据此宣称契约零漂移。

### 13.3 FAIL 即停：DEF-01 实现缺陷回传包

按 QA 口径执行「验收门 FAIL → 停测 → 回传完整复现包 → 不越界修引擎代码」：

| 项 | 内容 |
|---|---|
| 组件 | `server/src/services/pybridge.js::memoryWrite` |
| 现象 | 重复写入返回 `{action:'upsert'}` 而非 `{action:'noop', reason:'duplicate'}` |
| 根因 | 去重查询 `SELECT value FROM fact_records WHERE is_current=1`，写入却落 `INSERT ... INTO profile_kv`，**两表不一致，去重永远命中不到** |
| 影响钉 | `test_legacy_multi_note_no_supersede`，verdict 由 `partial` 改判 `gap` |
| 复现 | `node server/test/memory-gate.mjs`（输出 `implementationDefects` 段） |
| 处置 | **未修改 pybridge.js**；登记为 DEF-01，待用户决定是否授权修复 |

净结果：`blockingGaps` 仍为 **10**（销 1、新增 1），仍不可进入步骤 5。

### 13.4 台账与门禁

复核证据升级 v2（新增 `nodeGateAdditions` / `implementationDefects` / `protocolCaveat`）；
台账 v3 的 `verdictSummary` 随之重算；门禁新增 3 项断言（销项与缺陷登记、
敏感门落地、**实现缺陷按 QA 口径未擅自修引擎**）。

### 13.5 踩坑与修正

新增 `memory-gate.mjs` 后 `.mjs` 计数再次变化，`domain-equivalence.mjs` 的精确计数断言
第二次失效。已改为**下界断言** `totalRunnableGates >= baseline + 1`，并输出
`addedSinceBaseline`，避免每加一个门都要改数字。

### 13.6 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **54/54** |
| `server/test/memory-gate.mjs` | PASS（5 检查，含缺陷回传） |
| `server/test/domain-equivalence.mjs` | PASS（26 个可跑门 / 较基线 +2） |
| 定向 pytest | **30 passed** |
| 全量 `pytest tests/ -q` | **2085 passed / 0 failed / 3 skipped**（349s） |

### 13.7 下一步

1. **DEF-01 需用户决策**：是否授权修复 `pybridge.memoryWrite` 去重（修后销 1 个 gap）。
2. 继续补 Node 等价测试：trace span/read、群上下文交接、`open_url` token 透传等剩余 9 个 gap。
3. 按域复核剩余 71 条；`blockingGaps` 归零后才允许步骤 5。
4. 生产链零改动；未推送。

---

## 14. 执行补记 7（用户「授权」：DEF-01 修复与销项）

### 14.1 授权范围与最小改动

用户回复「授权」，对应上一轮待决项 ①。仅修改
`server/src/services/pybridge.js::memoryWrite` 一处：

- 保留原 `fact_records` 去重（兼容 Python 侧写入的数据）；
- 新增 `SELECT key FROM profile_kv WHERE user_id=? AND value=?` 查询，
  命中即返回 `{ok:true, action:'noop', reason:'duplicate'}`；
- 写入参数复用同一个 `stored = JSON.stringify(body)`，避免两处序列化不一致。

未改其他 Node 服务、未删任何测试或 Python 实现；`memory_remember` 属
`_V12_EXTRA` 隐身方法，不进 `get_api_info()` 公开自省面，契约面零影响。

### 14.2 复验

`server/test/memory-gate.mjs` 第 4 项恢复为**硬断言**：首次写入 `upsert`、
重复写入 `noop` + `reason=duplicate`。报告 `implementationDefects: []`、
`defectsFixed: [DEF-01]`。

### 14.3 销项结果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `covered-by-node-gate` | 1 | **2** |
| `blockingGaps` | 10 | **9** |
| `pinsClosed` | 1 | **2** |
| 未修复缺陷 | 1 | **0** |

`test_legacy_multi_note_no_supersede` 由 `gap` 销为 `covered-by-node-gate`。
复核证据升级 v3（新增 `defectsFixed` / `openImplementationDefects`），
台账 v3 的 `verdictSummary` 与 `blockingGaps` 重算；门禁把
「未擅自修引擎」改判为「修复有授权与复验依据」。

### 14.4 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **54/54** |
| `server/test/memory-gate.mjs` | PASS（5 检查，DEF-01 硬断言） |
| server 全量可跑门禁 | **26/26 PASS**（引擎改动无回归） |
| 定向 pytest | **30 passed** |
| 全量 `pytest tests/ -q` | **2085 passed / 0 failed / 3 skipped**（459s） |

### 14.5 下一步

- 剩余 **9 个 gap**：trace span/read、群上下文交接、`open_url` token 透传、
  memory 传播/墓碑/pin 优先级、MCP 路由 bypass、trace 保留期等。
- 其中若再次遇到实现缺陷，仍按 QA 口径先回传、待授权后修。
- 按域复核剩余 71 条；`blockingGaps` 归零后才允许步骤 5。
- 未推送。

---

## 15. 执行补记 8（用户「继续」：重读断言、纠正归类偏差）

### 15.1 根因：上一轮按 import 归类，未按断言原文归类

逐条重读剩余 9 个 gap 的测试体后确认，其中 **6 个不是后端缺口**：

| 类型 | 数量 | 证据 |
|---|---|---|
| Python `agent_memory` 内部语义 | 2 | `test_legacy_delete_propagates` 断言 `legacy_note:%` 在 `fact_records` 表的 SQL 传播；`test_hard_erase_tombstone` 断言 `stats().integrity` 哈希链墓碑。均属实现内部，删实现后自然退役，Node 侧对外 `memoryErase` 已由 `memory-gate.mjs` 验证可用 |
| 前端源码静态钉 | 4 | `test_r48_2` 读 `frontend/src/agent/tool-executor.js` 断言 `callApi('open_url', withToken(...))`；`test_r48_3` 读 `run-controller.js` 断言 `/^(browser_\|software_\|memory_\|mcp_search)/`；另 2 个同类。与后端 `open_url` 是否 `uncovered` 无关 |
| 前端 VM 行为钉 | 2 | `test_r46_final.py` 的 `_run_group` 用 JS VM 调 `groupContextFor`（`frontend/src/group/`），属群聊前端行为，需 B4 React 迁移时补组件测试 |

### 15.2 补可执行证据，不靠改标签冒充销项

- `docs/behavior-review-batch1.json` 升级 v4，新增 `frontendLiteralGates`：
  5 条字面量断言（`tool-executor.js` / `run-controller.js` / `composer-hub.js` /
  `build_hub_catalog.py` / `frontend/src/group` 的 `groupContextFor` 定位）。
- `arch-contract.mjs` 逐条读源码校验 `mustContain` / `mustNotContain`，
  实测 5 条全部成立；新增 2 项门禁断言。
- 新 verdict `deferred-to-react-migration`：明确定位到 B4 群聊域但**行为等价未验证**，
  既不计入后端 gap，也不算等价验证。

### 15.3 真缺口收敛到 3 项

| 缺口 | 依据 |
|---|---|
| `test_entries_pin_erase_and_extras_priority` | `extras_block` 系统提示注入依赖 `memory_context_build`，该 js_api 在 Node 侧仍 `NOT_MIGRATED`（`pybridge.js` 文件头明确） |
| `test_trace_wired_into_guarded_and_begin_task` | Node 侧 `trace_new` / `trace_recent` 有，但无 `gen_ai.span` 写入与 `agent.run` / `tool.open_url` 接线 |
| `test_r48_8_trace_retention` | Node 侧 `traceRecent` 只读 `gen_ai-*.jsonl`，无 `RETENTION_DAYS=14` 清理 |

指标：`blockingGaps` **9 → 3**、`pinsClosed` **2 → 8**、
`deferredToReactMigration` 2、`partial` 5（仍需复核）。台账 v3 重算，
门禁 56/56，定向 pytest 31 passed。

### 15.4 验证与下一步

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **56/56**（新增 2 项字面量门/收敛断言） |
| 定向 pytest | **31 passed** |
| 全量 `pytest tests/ -q` | **2086 passed / 0 failed / 3 skipped**（645s） |

- 步骤 5 仍需：3 个后端 gap 补实现/测试 + 2 项 B4 组件测试 + 5 项 partial 复核 +
  按域复核剩余 71 条。
- 其中若遇实现缺陷，仍按 QA 口径先回传、待授权后修。
- 生产链零改动；未推送。

---

## 16. 执行补记 9（用户「继续」：记忆注入门 + DEF-02/03 回传）

### 16.1 澄清：memory_context_build 标 NOT_MIGRATED，但注入能力在位

`provider.js::buildSystemPrompt()` 经 `memoryTail()` 调用 `getMemory()` +
`memoryRetrieve()` 注入「用户长期记忆（仅作偏好与约束参考）」段；
`pybridge.memoryEntriesList()` 返回带 `source` / `pinned` 的条目视图，
`memoryEntryPin()` 可置位。因此 `test_entries_pin_erase_and_extras_priority`
不是完全实现缺口，而是**部分覆盖**。

新增 `server/test/memory-injection.mjs`（3 项检查，隔离 `HARBOR_CONFIG_DIR`）：
系统提示注入长期记忆段 + 具体条目、entries 视图含 source/pinned 且初始未钉选、
pin 置位/取消在视图中反映。实测 PASS。

**未复刻（如实登记，不宣称等价）**：Python `extras_block` 的
`【长期记忆·扩展】` 标题、attribute 字母序、pin 置前排序。
该钉 verdict 由 `gap` 降为 `partial`。

### 16.2 DEF-02 / DEF-03：按 QA 口径回传，未修引擎

| ID | 组件 | 现象 | Python 侧行为 | 处置 |
|---|---|---|---|---|
| DEF-02 | `trace_new` / `provider.traceNew` | Node 仅返回 uuid、`traceRecent` 只读文件；无 `gen_ai.span` 写入，无 `agent.run` / `tool.open_url` 接线 | `begin_task()` + `open_url()` 后 `trace_recent` 应含两个 span | 回传待授权，未改代码 |
| DEF-03 | `pybridge.traceRecent` | 只读 `traces/gen_ai-*.jsonl`，无保留期清理 | `TraceService.RETENTION_DAYS == 14`，`_retain()` 清理 20 天前旧文件 | 回传待授权，未改代码 |

影响钉：`test_trace_wired_into_guarded_and_begin_task`、`test_r48_8_trace_retention`。
门禁新增「未授权实现缺陷不得进入步骤 5」，显式阻断。

### 16.3 指标与一处判定修正

`blockingGaps` **3 → 2**、`partial` **5 → 6**、累计销项 **8 → 9**、
`openImplementationDefects` **0 → 2**。复核证据 v5、台账 v3 重算。

修正：`gen_test_disposition.py` 原用 `blockingGaps > 0` 判定
`reviewConclusion`，memory 文件 gap 归零后被误判 `equivalent`；
已改为「gap 或 pending(partial/deferred) 任一存在即 `gaps-found`」，
并新增 `pendingVerdicts` 字段。门禁同步放宽为
`blockingGaps > 0 || pendingVerdicts > 0`。

### 16.4 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **58/58** |
| `server/test/memory-injection.mjs` | PASS（3 检查） |
| server 全量可跑门禁 | **27/27 PASS** |
| 定向 pytest | **32 passed** |
| 全量 `pytest tests/ -q` | **2086 passed / 1 环境性 FAIL / 3 skipped**（772s）——详见 §16.5 |

### 16.5 验收门 FAIL 复现包（按 QA 口径停测回传）

| 项 | 内容 |
|---|---|
| 用例 | `tests/test_contract_diff.py::test_function_graph_build_performance_under_baseline` |
| 判据 | `fg.collect()` 耗时 `< 1.2s`（优化前基线 1.62s） |
| 观察值 | **1.4241s** → FAIL |
| 命令/env | 全量 `pytest tests/ -q`，Windows，同机并发运行 2089 项；本轮全量耗时 772s（此前 5–8 分钟 / 349–480s） |
| 单独复跑 | `pytest tests/test_contract_diff.py::test_function_graph_build_performance_under_baseline -q` **连续 3 次全 PASS** |
| 改动面核查 | `function_graph.py` 扫描根为 `frontend/src`；本轮改动全在 `frontend/app/docs`、`server/test`、`tests`、`tools/gen_test_disposition.py`，**无交集** |
| 关联核验 | `contract_diff.py --compare r68` 零漂移 PASS；`harbor.html` / `libs/ui-schema.*` git diff 为空（仅行尾状态，内容哈希一致） |
| 判定 | **环境性 CPU 争用导致的偶发超时，非代码回归**（判断，非实测因果） |
| 处置 | 按 QA 口径停测回传；**未修改性能阈值、未改 `function_graph.py`、未改引擎代码** |

### 16.6 下一步

1. **需用户授权**：是否实现 DEF-02（span 写入/接线）与 DEF-03（保留期清理）。
2. 6 项 `partial` 逐条复核、2 项 B4 群聊组件测试、按域复核剩余 71 条。
3. 建议在系统空闲时复跑一次全量，确认性能门稳定（本轮单独复跑已 3/3 PASS）。
4. `blockingGaps` 归零且缺陷清零后，步骤 5 才可与删 Python 实现同批执行。
5. 生产链零改动；未推送。
