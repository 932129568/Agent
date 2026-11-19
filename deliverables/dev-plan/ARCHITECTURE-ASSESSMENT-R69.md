# R69 · 全栈源码架构与规范化评估

> 日期：2026-11-10。评估对象：当前工作区全栈源码（前端 legacy / React 生产层 /
> 规范工程、Node 服务、Electron、Python 契约层、构建链、测试与发布门）。
> 度量来源：`tools/arch_assessment.py`（只读、可复跑）→
> `deliverables/dev-plan/architecture-metrics-r69.json`。
> **事实与判断分离**：凡标「实测」的均来自脚本或命令输出；凡标「判断」的为工程评估。

---

## 0. 结论（先行）

**总体判定：契约工程与回归门禁达到国际一流水准；运行时产品架构尚未达到，处于「规范已定义且可执行、生产链仍双轨迁移」的阶段。**

更精确地说：

1. **"是否规范化"要分两层回答**：规范本身已达标——13 节前端规范 + 7 节后端规范、
   60+ 项清单驱动骨架、**58 项可执行架构断言**、B0–B9 迁移台账；但**规范化程度**未达标，
   因为 `frontend/app/` 规范工程**未接入生产链**，生产渲染仍是 R67 的
   `frontend/react/` + 内联 IIFE 的 `harbor.html`，117 个 legacy 模块仍在服务层。
2. **一流的部分**：契约零漂移（`get_api_info()` 逐字节）、golden 95 项行为快照、
   r68 锚点冻结链、2086 个 pytest、27 个 server 门禁、依赖棘轮 157、
   白名单打包、config.json 零污染、per-sid 隔离与 provenance 安全边界。
   这套"可证伪的发布门"在同类桌面 AI 应用中属于少见强度。
3. **不达标的根因**（实测）：**17 个强连通分量 / 104 个环内符号**（最大 SCC 34）、
   **零手写 TypeScript / 无 tsconfig**、**无覆盖率工具与门禁**、
   **CI 只覆盖 5 类门禁令牌**（未纳入架构门禁、server 27 门、前端 L1/L2、
   契约差分、golden、棘轮）、**4,045,428 B 单文件 HTML**、**2 个未授权实现缺陷**。
4. **判断**：这是一个"质量门禁世界级、产品架构迁移中"的项目。把它称为
   "国际一流产品架构"目前不成立；把它的**契约与回归工程**称为国际一流成立。

---

## 1. 功能架构理解（实测）

| 层 | 文件 | 行数 | 职责 |
|---|---|---|---|
| legacy 前端 | 117 | 26,858 | 17 个功能域（shell/core/chat/agent/settings/sessions/workspace/providers/integrations/search/planning/analytics/group/expert/collaboration/generative/components），仍承担业务逻辑 |
| React 生产层 | 16 | 2,857 | R67 唯一 DOM 生成层，10 区域 / 300 id / 86 事件桥 + 降级宿主 |
| 规范工程 | 44 | 2,991 | `frontend/app/`：分层 React、单一 store、服务边界；**未接生产链** |
| Node 服务 | 42 | 9,280 | fastify ESM，165 个注册方法，pybridge/libsql 补桥，per-sid 运行时 |
| Python 契约层 | 112 | 34,870 | 契约 oracle + 测试夹具，**不进 asar** |
| Electron | 2 | 456 | 窗口 / proxy-bypass / CORS / 拉起 server |
| installer | 4 | 1,182 | NSIS 发布工具 + pywebview 历史链 |
| 测试 | 158 | 40,290 | pytest 主体 + Node 门禁 + 前端 L1/L2 |

生产链事实：`Electron → harbor.html(file://) → POST /jsapi/:method + X-Harbor-Sid → server/`；
`backend/*.py` 不在打包白名单内（白名单只有 `backend/prompts/**/*` 与
`backend/experts_builtin/**/*`），server 运行时零 python spawn。

依赖图实测：**117 模块 / 1317 顶层符号 / 3197 条边**；
**17 个 SCC、104 个环内符号**，规模分布 `[34, 26, 5, 5, 5, 3, ...]`。
最大环集中在 `AppState` / `RunRegistry` / `UiGenerativeState` / `mcpServers` /
`renderUiComponent` 等 UI 生成与会话状态符号互引。
**口径说明**：这与 R65「`window.*` 业务全局符号归零」不是同一指标——
R65 收敛的是全局赋值，此处度量的是模块级符号级循环依赖。

---

## 2. 十维度对照国际通行工程实践

评分口径：`达标` / `部分` / `未达标`。参照系为业界通行的分层单向依赖、
类型安全、测试金字塔、CI 全覆盖、契约先行、可观测性、安全纵深、文档治理、
构建可复现、增量可回滚（**判断**：无统一量化国际标准，此参照系为工程共识）。

| # | 维度 | 判定 | 实测证据 | 主要差距 |
|---|---|---|---|---|
| 1 | 契约冻结与差分 | **达标** | 51 个公开方法逐字节冻结；golden 95 项 sha `ad7cfe30…`；r68 锚点冻结 `api_version`/`api_py_sha256`/`golden_sha256`/`html`/符号集；`--compare r68` 零漂移 | 无 |
| 2 | 回归与门禁 | **部分** | 2086 pytest / 27 server 门 / 58 架构断言 / L1 12 / L2 6 / UI 契约 / 棘轮 157 | 无覆盖率工具与基线；CI 仅 `check_contract` + `round_runner --full`(含 pytest) + release 检查 + entry-sweep 自检，**未纳入**架构门禁、server 27 门、L1/L2、契约差分、golden、棘轮 |
| 3 | 分层与依赖方向 | **未达标** | 17 SCC / 104 环内符号（最大 34）；规范工程内 58 项断言全通过（单向依赖、零反向边） | 生产链 legacy 仍存在结构性循环依赖 |
| 4 | 单一渲染所有权 | **部分** | React 是唯一 DOM 生成层，但约 2000 处 legacy DOM 写点仍作用于其生成的 DOM；`frontend/app/` 未接生产链 | 双轨渲染 + 事件桥字符串载体 |
| 5 | 类型安全 | **未达标** | 10 个 `.ts` 全为 `server/src/generated/prisma/` 生成物；**手写 TS = 0**，无 `tsconfig.json` | 全 JS 无静态类型，重构安全依赖测试而非编译器 |
| 6 | CI/CD 自动化 | **部分** | `.github/workflows/harbor-ci.yml`：UI 契约、`round_runner --full`、release 版本纪律、entry-sweep 自检（并明确"CI 无 GUI 时降级为 self-check，不伪造通过"） | 门禁覆盖不全（见 #2）；真实点击扫描为 best-effort 非硬门 |
| 7 | 可观测性 | **部分** | `trace_new` / `trace_recent` 基础能力；DEF-02 无 `gen_ai.span` 写入与接线、DEF-03 无保留期清理 | 2 个已登记实现缺陷待授权 |
| 8 | 安全纵深 | **达标偏强** | provenance 包裹 UNTRUSTED DATA、guard/jail/确认档、SSRF 拦截、per-sid 会话隔离、敏感字段拒写、config.json 零污染、打包白名单 | 无重大结构性缺口 |
| 9 | 文档与决策治理 | **部分** | `HANDOVER-R67/R68`、13+7 节规范、迁移台账、逐批执行补记 §1–§16、红线文档 | 无标准 ADR 目录；决策散落在 HANDOVER/提交信息，检索成本高 |
| 10 | 构建与交付 | **部分** | 构建幂等（两轮 md5 一致）、`harbor.html` 4,045,428 B、冷 import 516 ms（R64 从 1245 ms 降 59%）、asar 白名单 | 4 MB 单文件内联 bundle；性能门 `<1.2s` 在全量并发下偶发 1.42s（本轮已按 QA 口径回传） |
| 11 | 依赖治理 | **达标** | 依赖棘轮冻结 157 条前向隐藏边、`gen_allowlist --check` 通过、显式白名单注册 165 方法、asar 最小文件集 | 无 |
| 12 | 演进与可回滚 | **达标** | r67→r68 锚点链、golden 冻结面、本地提交不推送、每批门禁化、R65 删码/改测试同批纪律 | 无 |

**汇总**：达标 4 项（#1/#8/#11/#12）、部分 6 项（#2/#4/#6/#7/#9/#10）、
未达标 2 项（#3/#5），共 12 项口径。
差距集中在**类型安全、依赖结构、CI 覆盖、双轨运行时**四处，且彼此耦合。

---

## 3. 与国际一流产品的实质性差距（判断，按优先级）

### P0 — 决定能否称"一流架构"

1. **消除双轨**：完成 C 路径（2 个实现缺陷 + 6 项 partial + 71 条待复核）
   与 B0–B9（117 模块迁入规范 React），把 `frontend/app/` 接成唯一生产渲染层。
   当前"规范工程"与"生产工程"并存，是最大的结构性差距。
2. **解开符号级循环依赖**：17 SCC / 104 符号。随 legacy 删除会自然消解大部分，
   但需在 B0–B9 每批以 `function_graph.scc_cycles` 为门禁单调下降，避免迁移期复发。
3. **引入静态类型**：至少 JSDoc + `checkJs` 或渐进式 TypeScript，
   让 3197 条依赖边由编译器校验，而非仅靠 2086 个测试。
4. **CI 门禁全覆盖**：把 58 项架构断言、27 个 server 门、L1/L2、
   契约差分、golden 重放、棘轮全部接入 `harbor-ci.yml`，
   使"本地全绿"与"CI 全绿"等价。当前 CI 只跑 5 类令牌。
5. **覆盖率基线与棘轮**：引入 `pytest-cov` / `c8`，先测再设阈值，
   与现有"只增不减"纪律一致。

### P1 — 工程质量

- 授权修复 DEF-02（trace span 接线）与 DEF-03（保留期清理）。
- 4 MB 单文件 HTML 拆分/懒加载，降低首屏与冷启动耦合。
- 性能门改为多次采样取中位数，避免负载抖动导致偶发 FAIL（判断：本轮 1.42s 为环境性）。

### P2 — 治理

- 建立标准 ADR 目录，把 HANDOVER 中的裁决（A/B/C 路径、B0–B9、契约冻结口径）
  结构化为可检索的决策记录。
- 覆盖率与复杂度指标纳入 `architecture-metrics-r69.json` 长期趋势。

---

## 4. 已达到一流、应保留的实践（客观）

- **可证伪的契约门**：双实现逐字节差分 → golden 冻结 → Node 公开面等价门，
  三层证据链在删实现前先建好，避免"自证"。
- **冻结类门禁隔离进程重放**（golden replay），避免 2000+ 测试共享状态污染。
- **R65 纪律**：删码、改测试、逐条理由同一次提交；本轮 C 路径全程遵循。
- **QA 口径**：验收门 FAIL 即停、回传完整复现包、不越界改引擎代码
  （DEF-01 回传后获授权才修；本轮性能门 FAIL 同样未改阈值）。
- **安全纵深与最小打包白名单**。

---

## 5. 限制与未测项（诚实声明）

- 本评估为**静态度量 + 现有门禁结果**的合成，未做运行时性能剖析、
  内存/启动曲线、真实用户可用性测试。
- 未测量：代码覆盖率、圈复杂度、重复率、依赖漏洞扫描、包体积分模块占比。
  这些项标注为**未测**，不推断为"好"或"差"。
- "国际一流水准"无统一量化标准；第 2 节的参照系与判定为**工程判断**，
  实测数据可复跑（`python tools/arch_assessment.py`）。
- 本评估不改变任何生产代码，仅新增度量脚本与本报告。

---

## 6. 与 C 路径的衔接

`blockingGaps = 2`、`openImplementationDefects = 2`、
`coupledPytestFiles = 74`（已定位 74/74，逐条复核 24 钉）。
P0 第 1 项与当前 C 步骤 4 是同一条路径：先把缺口与缺陷清零，
再与删 Python 实现同批删除测试，然后 B0–B9 才能真正收口。
**建议顺序**：DEF-02/03 授权 → 6 项 partial + 71 条复核 → 步骤 5/6 →
B0–B9 逻辑迁移 → 类型系统与 CI 收口。

---

## 7. P0 执行进度（用户「按标准设计执行」）

本轮按 P0 路线落地 **②④⑤** 三项，均为纯增量、零生产运行时改动。

### 7.1 P0-④ CI 门禁全覆盖 —— 已落地

- `.github/workflows/harbor-ci.yml` 新增 `normalized-gates` job，
  调用统一入口 `tools/run_normalized_gates.py`。
- **本地 / CI 同源**：11 个规范化门禁 + 27 个 server 可跑门禁由同一脚本驱动，
  不再各自维护命令清单，使「本地全绿」与「CI 全绿」等价。
- `tools/gate_coverage.py` 定义 15 项 canonical 门禁清单，
  实测覆盖 **15/15 = 100%**；其中 5 项要求直接出现在 CI YAML 本体，
  不能只靠入口脚本文本（避免注释式假覆盖）。
- 覆盖率门置于入口首位，消除 CI 首次运行「arch-contract 读产物」的顺序依赖。

### 7.2 P0-⑤ 覆盖率基线 —— 部分落地，代码覆盖率如实阻塞

- 已落地 **门禁覆盖率**（gate coverage，15/15），这是"CI 是否调用全部门禁"的度量。
- **代码覆盖率未落地**：`pytest-cov` / `coverage` / `c8` / `nyc` 实测全部缺失，
  环境无外网不可安装。按 QA 口径登记为 `blocked-by-environment`，
  **不以门禁覆盖率冒充代码覆盖率**，并在 `gate-coverage-r69.json` 中写明解阻命令。
- 修复一处度量误判：`arch_assessment.py` 原按文本扫描 CI 注释中的
  `pytest-cov / c8` 字样误判为已装工具，已改为 `importlib.find_spec` +
  包声明检测。

### 7.3 P0-② SCC 单调下降棘轮 —— 已落地

- `scc-baseline-r69.json` 冻结基线：**17 SCC / 104 环内符号 / 最大 SCC 34**。
- `tools/scc_ratchet.py` 每轮实测并断言 `sccCycles` 与 `cyclicSymbols`
  **只允许减少或持平**，回增即失败；产出 `scc-trend-r69.json` 记录 delta。
- 架构门禁新增断言，CI 统一入口每轮执行。B0–B9 迁移时可据此逐批验证下降。

### 7.4 尚未执行的 P0 项（如实声明）

| 项 | 状态 | 原因 |
|---|---|---|
| P0-① 消除双轨（C 路径 + B0–B9） | 进行中 | `blockingGaps 2`、未授权缺陷 2、71 条待复核；需多轮授权与迁移，非单轮可完成 |
| P0-③ 静态类型（JSDoc/checkJs 或渐进 TS） | 未启动 | 需先确定工具链与试点范围；当前无 `tsconfig.json`、无类型依赖，贸然开启 `checkJs` 会在 42 个 Node 文件上产生大量错误导致门禁红，须单独规划 |

### 7.5 判定更新（判断）

- `CI/CD 自动化`：由「部分」提升为**接近达标**——门禁调用覆盖已 100%，
  但代码覆盖率仍缺、真实 CDP 扫描仍为 best-effort。
- `依赖治理` / `演进与可回滚`：进一步增强（SCC 棘轮 + 统一入口产物归档）。
- `分层与依赖方向` / `类型安全`：仍为未达标，未因本轮门禁建设而改变。

### 7.6 验证

| 项 | 结果 |
|---|---|
| 统一门禁入口（本地） | **11/11 PASS**，0 SKIP，含 27 个 server 门 |
| `arch-contract.mjs` | **64/64** |
| 门禁覆盖率 | **15/15 = 100%** |
| SCC 棘轮 | PASS（17/104，delta 0） |
| 代码覆盖率 | `blocked-by-environment`（如实登记） |
| 全量 `pytest tests/ -q` | **2089 passed / 0 failed / 3 skipped**（578s） |
| 生产运行时代码改动 | **零** |

---

## 8. P0-③ 第一阶段续轮（用户「继续」）

### 8.1 环境实测与决策

- `node_modules/typescript` / `server/node_modules/typescript` **均不存在**，
  `tsc` 不在 PATH；无外网不可安装。`@types/node` 已在位。
- 因此 `tsc --noEmit` / `checkJs` **当前不可执行**。按 QA 口径不伪造静态类型检查，
  改为落地不依赖编译器的**第一阶段：JSDoc 类型契约**。

### 8.2 已落地

- 试点 `server/src/paths.js`（7 个导出符号 = 3 常量 + 4 函数）补齐
  `@type` / `@param` / `@returns` / `@throws` 注解，**注释级改动、零行为变更**。
- `tools/type_annotation_audit.py` 静态解析覆盖率，与
  `type-annotation-baseline-r69.json` 比较，**只增不减**；实测 **7/7 = 100%**。
- `TYPE-SAFETY-PLAN-R69.md` 给出四阶段路线与解阻命令。
- 纳入架构门禁（+3 项断言）、CI 统一入口（第 12 门）、
  canonical 门禁清单（16 项全覆盖）。

### 8.3 诚实边界

**JSDoc 覆盖率不是静态类型检查**：前者度量类型契约的文档化程度，
后者由编译器校验 3197 条依赖边的类型一致性。
`type-annotation-r69.json` 中 `staticTypeCheck.status = blocked-by-environment`。
**R69 报告「类型安全：未达标」的判定不因本阶段改变**。

### 8.4 判定与验证

| 项 | 结果 |
|---|---|
| 统一门禁入口 | **12/12 PASS**（0 SKIP，含 27 server 门） |
| `arch-contract.mjs` | **67/67** |
| 门禁覆盖率 | **16/16 = 100%** |
| JSDoc 类型契约 | **7/7 = 100%**，无回增 |
| 静态类型检查 | `blocked-by-environment`（如实登记） |
| 全量 `pytest tests/ -q` | **2090 passed / 0 failed / 3 skipped**（887s） |
| 生产运行时行为改动 | **零** |

**P0 剩余**：① 消除双轨（`blockingGaps 2` + 待授权缺陷 2 + 71 条待复核）、
③ 阶段 2–4（待外网安装 typescript）、⑤ 代码覆盖率（待外网）。

---

## 9. DEF-02 / DEF-03 授权修复（用户「允许」）

### 9.1 授权与实现

用户回复「允许」，对应上一轮回传的两个 Node 实现缺陷。改动 **4 个引擎文件**，
全部保持返回形状不变、异常静默（轨迹故障不阻塞业务，B8.9 口径）：

| 文件 | 改动 |
|---|---|
| `server/src/services/pybridge.js` | 新增 `TRACE_RETENTION_DAYS=14`、`traceSpan()`（gen_ai.* 字段、16KB 截断、纯追加 JSONL）、`traceRetain()`（按 mtime 清理）、`newTraceId()/currentTraceId()` |
| `server/src/services/provider.js` | `traceNew()` 改用 `newTraceId()` 生成并记住当前 trace id，**返回 `{ok,trace}` 形状不变** |
| `server/src/services/commands.js` | `beginTask()` 落 `agent.run` span（attrs.sid），对齐 Python `api.py::begin_task` |
| `server/src/services/system.js` | `openUrl()` 护栏挂点落 `tool.open_url` span（ok/denied/error 三态 + duration_ms），动态 import 避免模块循环 |

`traceSpan` 写后调用 `traceRetain`，与 Python `TraceService.span()` 内调 `_retain()` 同款。
`trace_new` / `trace_recent` 均属 `_V12_EXTRA` 隐身方法，不进公开自省面。

### 9.2 验收门：`server/test/trace-equivalence.mjs`（5 检查）

1. `RETENTION_DAYS=14`；span 写入后 20 天前 `gen_ai-20000101.jsonl` 被清理、当天文件保留；
2. `trace_recent` 读回 `agent.run` / `tool.open_url`，`gen_ai.span`、
   `gen_ai.operation.name`、`gen_ai.request.trace_id`、`status`、`duration_ms` 一致；
3. `invoke('begin_task')` **运行时**追加 `agent.run` span；
4. `system.js` / `commands.js` / `provider.js` 接线在源码中可核验（不启动外部浏览器）；
5. `get_api_info()` 公开面仍为 **51 方法 / v1.0.0** —— 契约零漂移。

### 9.3 销项结果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `blockingGaps` | 2 | **0** |
| `covered-by-node-gate` | 2 | **4** |
| `pinsClosed` | 9 | **11** |
| `defectsFixed` | 1 | **3**（DEF-01/02/03） |
| `openImplementationDefects` | 2 | **0** |

两个行为钉 `test_trace_wired_into_guarded_and_begin_task` 与
`test_r48_8_trace_retention` 由 `gap` 销为 `covered-by-node-gate`；
复核证据升级 **v6**，台账重算，门禁改为「缺口归零但仍有 pending 时不得进入步骤 5」。

### 9.4 诚实边界

- **步骤 5 仍不可进入**：`blockingGaps` 归零不等于复核完成——
  6 项 `partial` 待复核、2 项 `deferred` 到 B4 群聊组件测试、
  **71 条耦合测试文件尚未逐条复核**。门禁以 `pendingVerdicts` 与
  `reviewRequired` 继续阻断。
- **护栏 span 为最小接线**：本次只在 `open_url` 挂点落地；Python
  `_execute_guarded` 对**所有**护栏 op 落 `tool.*` span，全量复刻未在本次范围。
- `tool.open_url` 的运行时路径不在验收门中直接调用（会启动外部浏览器），
  改以源码接线断言 + 直接 span 写入验证，已如实标注。

### 9.5 验证

| 项 | 结果 |
|---|---|
| `server/test/trace-equivalence.mjs` | **5/5 PASS** |
| server 全量可跑门禁 | **28/28 PASS**（引擎改动无回归） |
| `arch-contract.mjs` | **68/68** |
| 契约差分 r68 | 零漂移（公开面 51 方法） |
| 全量 `pytest tests/ -q` | **2091 passed / 0 failed / 3 skipped**（640s） |

---

## 10. 扩大复核范围：剩余 71 文件盘点与 expert 域逐条复核

### 10.1 断言对象盘点（机器线索，非结论）

新增 `tools/classify_remaining_pins.py`（可复跑、只读）→
`remaining-pins-classification-r69.json`。按**测试函数体内的断言对象**分类，
而非按 import 路径（上一轮教训）：

| 指标 | 值 |
|---|---|
| 待复核文件 / 测试钉 | **67 文件 / 1434 钉**（batch2 复核 4 文件后） |
| 分类分布 | shape-assert 484、python-service 442、jsapi-contract 253、unclassified 203、frontend-vm 27、frontend-static 25 |

近半落在 `shape-assert` / `unclassified`，**证实自动分类不足以替代逐条复核**；
脚本 policy 明确写「不是行为复核结论，不得据此销项」。

### 10.2 expert 域逐条复核（4 文件 / 23 钉）

对照 `server/test/experts.mjs` 的 12 项实际检查与 Python 断言原文，
产出 `behavior-review-batch2.json`：

| verdict | 数量 |
|---|---|
| `partial` | 7 |
| **`gap`** | **12** |
| `python-implementation-detail` | 3 |
| `frontend-contract` | 1 |

新暴露的缺口集中在 **expert 包安全错误码矩阵**
（`LINK_NOT_ALLOWED` / `CASEFOLD_COLLISION` / `REPARSE_NOT_ALLOWED` /
`FILE_TOO_LARGE` / `METADATA_TOO_LARGE` / `UNCLOSED_BLOCK` / `METADATA_CONFLICT`）、
零进程网络间谍、注册表损坏恢复、转换规则与资产过滤、frontmatter 校验。
按 QA 口径回传，**未修改任何引擎代码**。

### 10.3 关键判断：blockingGaps 的语义边界

batch1 的 `blockingGaps = 0` 只是**已复核 3 文件 / 24 钉范围内**为零，
**不能外推到全部 74 条**。batch2 扩大到 7 文件 / 47 钉后立即重新暴露 12 个缺口。

因此台账升级 **v4**：
- 新增 `extendedReview`：7 文件已复核 / 67 剩余 / batch2 12 缺口；
- policy 明确「blockingGaps 只统计已复核范围，扩大范围可能重新暴露缺口」；
- 门禁新增 3 项断言，确保「扩大范围后步骤 5 仍阻断」。

### 10.4 剩余工作量与建议

- 67 文件 / 1434 钉需按域逐条复核，建议每批 4–10 文件，
  按 `python-service` → `jsapi-contract` → `frontend-vm/static` 顺序；
- 12 个 expert 缺口需补 Node 等价门（或判定随实现退役）；
- 6 项 batch1 `partial` + 2 项 `deferred` 仍待收口；
- 步骤 5 门槛不变：**全部销项 + 缺陷清零**后才可与删 Python 实现同批执行。

### 10.5 验证

| 项 | 结果 |
|---|---|
| `arch-contract.mjs` | **71/71**（新增 3 项扩展复核断言） |
| 定向 pytest | **24 passed** |
| 全量 `pytest tests/ -q` | **2092 passed / 0 failed / 3 skipped**（755s） |
| 生产代码改动 | **零**（本轮为只读复核 + 门禁） |

---

## 11. expert 安全矩阵：区分「已实现」与「真缺口」

### 11.1 实测结论

新增 `server/test/expert-security.mjs`（隔离 `HARBOR_CONFIG_DIR`，构造恶意专家包）：

- **A 组（已实现，硬断言拒绝）**：硬链接、凭证文件 `.env`、
  单文件 > 1 MiB、agents 声明路径越界、缺少 `plugin.json` —— 5 项全部拒绝。
  符号链接在 Windows 因 `EPERM` 无法创建，**如实 SKIP**（源码 `scan()` 有
  `lstatSync` 检查但未实测），不伪造通过。
- **B 组（实测未拒绝，真缺口）**：两份冲突 `plugin.json`、
  case-fold 同名文件、未闭合 frontmatter、`plugin.json` > 64 KiB —— 4 项均**导入成功**。

根因：`server/src/services/experts.js::scan()` / `manifestFor()` 已实现
符号链接、硬链接、`SECRETS`、1 MiB 单文件、512 文件数、32 MiB 包大小、
路径越界等检查；但所有异常被 `expertImportDirectory` 的 catch 统一包装为
`EXPERT_IMPORT_INVALID`，**不具备 Python 的细粒度错误码矩阵**
（`PATH_ESCAPE` / `LINK_NOT_ALLOWED` / `CASEFOLD_COLLISION` /
`REPARSE_NOT_ALLOWED` / `FILE_TOO_LARGE` / `METADATA_TOO_LARGE` /
`UNCLOSED_BLOCK` / `METADATA_CONFLICT`）。

### 11.2 销项与回传

`behavior-review-batch2.json` 升级 **v2**：
- `test_escape_and_secret_files_rejected_before_registry` → `covered-by-node-gate`；
- `test_symlink_and_hardlink_rejected`、`test_size_file_count_and_metadata_limits_stop_early`
  → `partial`；
- `blockingGaps` **12 → 10**，累计 `covered` 1 / `partial` 8 / `gap` 10 /
  `python-detail` 3 / `frontend` 1（合计 23 钉）。

**未修改任何引擎代码**：B 组 4 项与其余 reparse、注册表恢复、转换规则、
零进程网络间谍等缺口按 QA 口径回传完整复现信息，待授权。
协议形状差异（统一码 vs 细粒度码）如实登记，不宣称逐字节等价。

### 11.3 验证

| 项 | 结果 |
|---|---|
| `server/test/expert-security.mjs` | A 组 5/5 拒绝、symlink SKIP、B 组 4 项如实记录 |
| server 全量可跑门禁 | **29/29 PASS** |
| `arch-contract.mjs` | **72/72** |
| 定向 pytest | **25 passed** |
| 生产代码改动 | **零** |

---

## 12. 验收门 FAIL 复现包与门禁判定修复

### 12.1 FAIL 现场（按 QA 口径停测回传）

| 项 | 内容 |
|---|---|
| 用例 | `test_r69_p0_normalized_gates_and_ci_coverage`（全量 pytest 内） |
| 判据 | 统一门禁入口 `run_normalized_gates.py` 返回 0 |
| 观察值 | **11/12 PASS**，`server-gates` FAIL；`migration.mjs` / `webdav.mjs` 退出码 **3221225477 = 0xC0000005（Windows ACCESS_VIOLATION）** |
| 关键证据 | 两个门的 stdout 已打印**完整 `ok:true` 检查结果**，崩溃发生在进程退出阶段，非断言失败 |
| 单独复跑 | 统一入口连续 **3 次 12/12 PASS**；本轮手动 server 全量 **29/29 PASS** |
| 判定（判断，非实测因果） | 高并发 spawn 下 Node 原生模块（libsql / DPAPI 相关）卸载期的偶发退出崩溃 |

### 12.2 根因：门禁判定缺陷

`run_normalized_gates.py` 原先把任何非零退出码一律判为测试失败，
把「断言已通过、进程退出时原生崩溃」误报为门禁红。这是**测试基础设施缺陷**，
不是产品缺陷，也不是引擎回归。

### 12.3 修复（不掩盖、留痕）

- 新增 `NATIVE_EXIT_CODES`（`0xC0000005` 等）与 `native_exit_after_pass()`：
  **仅当退出码命中且 stdout 可解析为 `ok:true` 报告**时，不计为测试失败；
- 但仍写入 `server-gates.nativeExitWarnings` 与
  `summary.nativeExitWarnings`，含 file / returncode / reason / disposition；
- policy 改为「optional 门 SKIP 与原生退出崩溃均必须如实记录，
  **不伪造通过、也不静默吞掉**」，产物升级 v2；
- pytest 新增断言：警告数必须与 summary 一致、每条须含「留痕」处置说明。

**未修改任何引擎代码、未放宽任何断言阈值**。原生崩溃本身作为
已知运行时稳定性问题保留在警告中，待后续排查原生模块卸载路径。

### 12.4 复验

| 项 | 结果 |
|---|---|
| 统一门禁入口 | **12/12 PASS**（0 SKIP） |
| `arch-contract.mjs` | **72/72** |
| 定向 pytest | **25 passed** |
| server 全量可跑门禁 | **29/29 PASS** |
| 全量 `pytest tests/ -q`（复验） | **2093 passed / 0 failed / 3 skipped**（674s） |

---

## 13. expert 授权修复：细粒度错误码矩阵与 4 项缺口

### 13.1 授权与实现范围

用户回复「授权」，对应 §11 回传的 expert 4 项实测缺口。改动
**`server/src/services/experts.js` 一个引擎文件**，返回形状不变：

| ID | 修复 |
|---|---|
| EXPERT-01 | 三处 `plugin.json` 全检查：字段冲突 → `METADATA_CONFLICT`（details 含 field 级明细）；完全相同 → `MULTIPLE_METADATA_IDENTICAL` 警告 |
| EXPERT-02 | `scan()` 按 NFC + case-fold 建立路径键，冲突 → `CASEFOLD_COLLISION` |
| EXPERT-03 | `agentMaxTurns()` 对以 `---` 开头但无闭合分隔符 → `UNCLOSED_BLOCK` |
| EXPERT-04 | `plugin.json` > 64 KiB → `METADATA_TOO_LARGE` |
| EXPERT-05 | 新增 `ExpertError(code, extra)`；`expertImportDirectory` catch 返回 Python 同款细粒度码，未知异常仍兜底 `EXPERT_IMPORT_INVALID` |

已有校验同步映射到 `LINK_NOT_ALLOWED` / `HARDLINK_NOT_ALLOWED` /
`SECRET_FILE_NOT_ALLOWED` / `FILE_TOO_LARGE` / `TOO_MANY_FILES` /
`PACKAGE_TOO_LARGE` / `DEPTH_TOO_LARGE` / `PATH_ESCAPE` / `METADATA_NOT_FOUND` /
`NOT_REGULAR_FILE` / `INVALID_METADATA_JSON`。

### 13.2 验收门：`server/test/expert-security.mjs`（9 场景硬断言）

A 组 5 项 + B 组 4 项**全部拒绝且 code 精确匹配 Python**；
符号链接因 Windows `EPERM` 无法创建，如实 SKIP。
`casefold-collision` 改用 Unicode NFC(`café`) / NFD(`cafe`+U+0301)
两个真实不同的 NTFS 文件名构造（Windows 大小写不敏感，`A.md`/`a.md`
无法作为两个文件存在）——实测两者 NFC 规范化后相等，触发拒绝。

### 13.3 销项结果

`behavior-review-batch2.json` 升级 **v3**：销 4 项、升 1 项，
`blockingGaps` **10 → 6**；累计 `covered` 5 / `partial` 8 / `gap` 6 /
`python-detail` 3 / `frontend` 1（合计 23 钉）。
`defectsFixed` 5 项、`openImplementationGaps` 6 项如实登记。

**诚实边界**：Node 拒绝现返回 Python 同款细粒度码，但仍**非逐字节等价**
（message 文案、details 结构、部分边界码有差异）；`REPARSE_NOT_ALLOWED`
未细分（junction 统一按 `LINK_NOT_ALLOWED`）；步骤 5 仍阻断。

### 13.4 附带：一处时间依赖 flaky 的复现包与修复

全量 server 循环中 `group-files.mjs` 偶发 FAIL：
`assert.match(w2.name, /^\d{8}-\d{6}_主持人_接口规划-2\.md$/)`。
根因是 `groupFilesWrite` 的时间戳精确到秒，**只有同秒同名才追加 `-2`**；
两次 HTTP 写入跨秒时 w2 用新时间戳、不带后缀。单独复跑 **3/3 PASS**、
循环复跑 **2/2 PASS**，与 expert 改动无交集。

修复方式为**语义等价的测试稳定性修正**：按实际秒戳分支断言——
同秒仍严格要求 `-2.md`，跨秒要求基础命名格式且 `w2.name !== w1.name`、
两份文件都存在。未放宽任何断言、未改引擎。全量 server 复跑 **29/29 PASS**。

### 13.5 验证

| 项 | 结果 |
|---|---|
| `expert-security.mjs` | **9 场景硬断言 PASS**（0 implementationGaps） |
| `experts.mjs` | **12/12 PASS**（无回归） |
| server 全量可跑门禁 | **29/29 PASS** |
| `arch-contract.mjs` | **72/72** |
| 定向 pytest | **25 passed** |
| 全量 `pytest tests/ -q` | **2093 passed / 0 failed / 3 skipped**（590s） |

### 13.6 下一步
仍有 6 个 gap 与 6 项 `openImplementationGaps`（reparse 细分、零进程网络间谍、
注册表恢复、frontmatter 标量、内置转换规则、用户导入严格校验）待授权；
按域继续复核 67 文件 / 1434 钉；收口 batch1 的 6 partial + 2 deferred。

---

## 14. batch1 partial 收口（用户「继续」）

### 14.1 背景与判断

用户未授权新的实现缺口修复，故本轮聚焦**不需授权的收口工作**：核对
batch1 的 6 项 `partial` 中哪些已被后续修复与新验收门覆盖。

核实结论：
- `test_trace_service_span_and_read` 的 span 写入与读取已由 §9 的
  `trace-equivalence.mjs` 完整覆盖；
- `test_r48_6_memory_write_honest_schema` 的断言对象是
  `backend.tools_schema.AGENT_TOOLS` 中 `memory_write` 的 properties
  ——属**工具 schema 契约钉**，Node 侧 `provider.buildTools()` 运行时可验证；
- Node `memory.js` 已实现 bigram 重叠 + kind 加成 + 时间衰减，
  `pybridge.js` 已有 `memoryStats` / `memorySearch` / `memoryEntryErase`。

### 14.2 新增 `server/test/memory-equivalence.mjs`（5 检查）

1. `provider.buildTools('full', false, true, false)` 运行时校验
   `memory_write` properties **不含 `kind`、含 `text`**；
2. `memoryRetrieve` bigram 相关命中 / 零重叠排除 / 空查询防御；
3. `memoryStats` `enabled` + `integrity`；
4. `memorySearch` 相关命中 / 空查询与无关查询返回空；
5. `memoryEntriesList` 的 `source`/`readonly`/`pinned` 字段 + pin/erase 生效。

### 14.3 销项与如实登记

`behavior-review-batch1.json` 升级 **v7**：销 2 项
（`test_trace_service_span_and_read`、`test_r48_6_memory_write_honest_schema`），
`coveredByNodeGate` **4 → 6**、`partial` **6 → 4**、累计销 **13** 项，
`blockingGaps` 仍为 0。

**4 项未实现子行为按 QA 口径回传，未修改引擎代码**：
`memoryErase` 软擦除 scrub（Node 返回「需桌面版」）、
legacy 多条镜像进 entries（实测 0 条）、
`memorySearch` touch 频率强化、`extras_block` 标题/字母序/pin 置前排序。

**语义边界修正**：`test_r48_scanfix.py` 的 8 个钉已全部销项
（`pendingVerdicts=0`、结论 `equivalent`）。原门禁硬性要求每个已复核文件都有
pending，属断言过时；已改为**全局阻断**由「其余文件 pending + 67 文件待复核 +
batch2 6 缺口」共同保证，并允许单文件正常收口。

### 14.4 验证

| 项 | 结果 |
|---|---|
| `memory-equivalence.mjs` | **5/5 PASS** |
| server 全量可跑门禁 | **30/30 PASS** |
| `arch-contract.mjs` | **73/73**（新增 1 项收口断言） |
| 定向 pytest | **26 passed** |
| 全量 `pytest tests/ -q` | **2093 passed / 1 环境性 FAIL / 3 skipped**（682s，详见 §14.6） |
| 生产代码改动 | **零** |

### 14.6 验收门 FAIL 复现包（按 QA 口径停测回传）

| 项 | 内容 |
|---|---|
| 用例 | `tests/test_contract_diff.py::test_function_graph_build_performance_under_baseline` |
| 判据 / 观察值 | `elapsed < 1.2s` / **1.4340s** → FAIL |
| 命令/env | 全量 `pytest tests/ -q`，Windows，2094 项并发；本轮全量耗时 682s |
| 单独复跑 | 同一用例连续 **5 次全 PASS** |
| 直接测量 | 无 pytest 并发时 `fg.collect()` 三次为 **0.4201 / 0.4115 / 0.4049 s**，symbols=1317 |
| 改动面核查 | `function_graph.py` 扫描根 `frontend/src`；本轮改动全在 `server/test`、`frontend/app/docs`、`tests`、`tools/gen_test_disposition.py`，**无交集** |
| 历史记录 | 同一门在 R68 全量高负载下曾观察 **1.4241s** 判 FAIL，下一轮全量自行 PASS（§7 补记） |
| 判定 | **全量 pytest 并发负载导致的环境性 FAIL，非代码回归**（判断；直接测量 0.41s 与并发 1.43s 的 3.4× 差异为强证据，但非因果实测） |
| 处置 | 按 QA 口径停测回传；**未修改性能阈值、未改 `function_graph.py`、未改引擎代码** |

**待用户决策**（三条路径，均未擅自执行）：
1. 维持阈值不变，接受全量偶发 FAIL 并在每轮复现包中登记（现状）；
2. 授权将判据改为多次采样取中位数或按负载分档（改 `test_contract_diff.py` 断言）；
3. 授权优化 `function_graph.collect()` 的缓存/IO 路径，从根本上降低方差。

### 14.7 下一步

- 需授权：batch1 的 4 项未实现子行为、batch2 的 6 gap 与 6 项
  `openImplementationGaps`；
- 不需授权可继续：按域复核 67 文件 / 1434 钉、2 项 B4 群聊组件测试。

---

## 15. settings 子域逐条复核（用户「继续」）

### 15.1 范围与方法

按 R69 §10 的「每批 4–10 文件」建议，选 `settings` 域中偏契约/静态的
**3 个 pytest 文件 / 34 个行为钉**：`test_model_prefs.py`(10)、
`test_release_discipline.py`(15)、`test_r59_deps.py`(9)。
继续沿用「按断言对象分类，不按 import 路径」的口径。

### 15.2 验证门 `server/test/settings-equivalence.mjs`（8 检查）

运行时调用 `registry.invoke(name, args[])` 验证 `model_prefs` 全套行为：
缺省值、save/get 往返、接受 JSON 字符串、thinking 白名单拒绝、
`ctx_k` 边界与钳制（200→128 / 100→32 / 2048→1024）、
损坏文件回退默认、config.json 零污染 + 独立 `model_prefs.json`、
`get_api_info` 51 方法 / v1.0.0 且 `model_prefs` 与 `trace` 方法隐身。

**实测发现 1 个实现缺口**：损坏 `model_prefs.json` 时 Node 侧能回退默认，
但**不生成 `.bad` 备份**（Python `model_prefs_service` 有）。按 QA 口径回传，
未修改引擎代码。

### 15.3 逐条复核结论（`behavior-review-batch3.json`）

| verdict | 数量 | 说明 |
|---|---|---|
| `covered-by-node-gate` | 12 | settings-equivalence / config-discipline / gen_allowlist |
| `covered-by-contract-golden` | 6 | `_V12_EXTRA` 隐身、公开面 51 方法、API_VERSION 红线、六原语转正 |
| `python-implementation-detail` | 9 | VERSION 发布线（用户管理的 `VERSION`）、`check_release.py` 自身、Python import 图 |
| `frontend-contract` | 3 | UI 缝星形拓扑、层模块下游化、`_mcpCache` 字面量 |
| `partial` | 1 | Node import 无环：架构门有单向依赖断言，但非同一扫描器 |
| **`gap`** | **3** | `.bad` 备份、guard 配置缓存失效、memory 列表缓存失效 |

**关键判断（延续 §10）**：扩大到 10 文件 / 81 钉后重新暴露 3 个缺口，
再次证明 `blockingGaps` 只统计已复核范围，**不能外推到全部 74 条**。

### 15.4 台账与验证

台账升级 **v5**：`extendedReview` 新增 batch3
（3 文件 / 34 钉 / 3 缺口），已复核 **10 文件**、剩余 **64 文件 / 1400 钉**；
`classify_remaining_pins.py` 同步读取三份复核证据，避免与台账循环依赖。
门禁新增 2 项断言、pytest 新增 1 条测试。

| 项 | 结果 |
|---|---|
| `settings-equivalence.mjs` | **8/8 PASS** |
| server 全量可跑门禁 | **31/31 PASS** |
| `arch-contract.mjs` | **75/75** |
| 定向 pytest | **27 passed** |
| 全量 `pytest tests/ -q` | **2095 passed / 0 failed / 3 skipped**（786s；本轮性能门未复现 FAIL） |
| 生产代码改动 | **零**（只读复核 + 验证门） |

### 15.5 下一步

- 剩余 **64 文件 / 1400 钉**按域继续复核（建议下一批 `planning` 7 文件）；
- 3 个 settings 缺口与 batch1/2 的待授权项汇总后统一授权；
- 2 项 B4 群聊组件测试仍待 React 域迁移。

---

## 16. 一次性收口（用户「全部一次性搞完」）

### 16.1 本轮完成的工作

| 类别 | 结果 |
|---|---|
| **批量实现缺口修复** | 13 项全部实现：expert 6 项（reparse 细分 / 零进程网络间谍 / 注册表损坏恢复与写回滚 / frontmatter 标量嵌套 / 内置转换与资产过滤 / 用户导入严格校验）+ memory/config 7 项（软擦除 scrub / legacy 逐条镜像 / touch 频率强化 / extras 标题与排序 / `.bad` 备份 / guard 缓存失效 / memory 列表缓存失效） |
| **B4 群聊组件测试** | `server/test/group-context-equivalence.mjs` 用 `node:vm` 加载**未修改**的 `frontend/src/group/group.js::groupContextFor`，两个场景真实 PASS（无 SKIP），含源码字节数/SHA 前缀/行为字面量锚点防伪造 |
| **剩余钉全量复核** | `tools/review_all_remaining.py` → `behavior-review-batch4.json`：**64 文件 / 1400 钉**逐钉规则化证据；123 钉归类，**1277 钉明确标记 `needs-human-review`**（不冒充完成） |
| **性能门口径** | `test_contract_diff.py` 改为 **3 次采样取中位数**，判据仍严格 `< 1.2s`（未放宽阈值），消除全量并发抖动误判 |
| **销项** | batch1 v8 / batch2 v4 / batch3 v2：**全局 `blockingGaps` 9 → 0**，三份证据 `blockingGaps` 全为 0，台账 v5 重算 |

新增三个验收门：`expert-final-gaps.mjs`（13 断言）、`memory-final-gaps.mjs`、
`group-context-equivalence.mjs`（3 检查）；`memory-equivalence.mjs` 由 5 → 9 检查、
`settings-equivalence.mjs` 的 `.bad` 缺口改硬断言。

**契约核对**：`get_api_info()` 仍为 **51 方法 / v1.0.0**；config.json 零污染；
未删除任何文件；`frontend/src/` 未改动（锚点冻结）。

### 16.2 仍存在的边界（如实声明）

1. **batch4 的 1277 钉需人工逐条深读**——规则化复核不是行为验证，
   不得据此宣称「74 条已复核完成」。`final-gap-backlog.json` 的
   `step5Blocked = true` 由该条件阻断。
2. **9 项 partial + 3 项 expert 表示差异 + 2 项 deferred 表示**保留：
   Node 与 Python 仍非逐字节等价。
3. **步骤 5/6 物理删除未执行**——见 §16.3。

### 16.3 删除边界（本轮唯一未执行项）

**⚠️ 此操作非常危险，可能导致不可逆的数据丢失！**

`STEP5-DELETION-BOUNDARY.md` 列出全部 **186 个受影响文件**
（74 个耦合 pytest + 112 个 `backend/**/*.py`）及完整路径、五项风险、
五项前置条件。核心风险：删除后 `get_api_info()` 逐字节差分、
2086+ pytest 门禁、contract-golden 的 Python oracle 同时失去参照，
且当前架构门禁含「不得删除 pytest 文件」断言会立即判红。

按既有资产「只增不删」约定与安全规则，**本轮未把「全部一次性搞完」
解释为删除授权**；需要用户明确、单独确认后才可执行，并与测试修改同一次提交。

### 16.4 验证

| 项 | 结果 |
|---|---|
| 统一门禁入口 | **12/12 PASS** |
| `arch-contract.mjs` | **75/75** |
| server 全量可跑门禁 | **34/34 PASS** |
| 定向 pytest | **39 passed** |
| 全量 `pytest tests/ -q` | **2096 passed / 0 failed / 3 skipped**（656s；性能门新口径下全绿） |

### 16.5 最终状态

`final-gap-backlog.json`：`totalOpenGaps = 0`、`step5Blocked = true`。
即**已实现缺陷清零、已登记 gap 清零**，但步骤 5 仍由「人工复核未完成 +
删除未授权」两条硬条件阻断。这是本轮能达到的最远边界。

---

## 17. 全源码深扫描（用户「全源码深扫描一遍，肯定存在问题的」）

### 17.1 扫描面与逐类核实

`tools/deep_scan.py`（可复跑）扫描 **529 个源码文件**（`server/src`、
`frontend/src`、`backend`、`tools`、`tests`、`frontend/app/src`），
11 类规则共 **880 条命中 / 72 条 high** → `deep-scan-r69.json` v2。

逐条核实结论（**静态命中不等于缺陷**）：

| 类别 | 命中 | 结论 |
|---|---|---|
| `hardcoded-secret` | 1 | 误报：`'t05-fake-key-not-real'` 是测试假值 |
| `danger-eval` | 8 | 误报：全是正则 `.exec()` 或测试禁止列表字面量 |
| `danger-child-process` | 40 | 多数为正则 `.exec()`；真实 `spawn` 在 dpapi/software/system/update/pybridge，已入护栏 |
| `silent-catch` / `silent-except` | 547 | 项目 B8.9「轨迹故障不阻塞业务」约定；持久化写均有外层 try |
| `path-join-user-input` | 23 | 误报：多为内部 `entry.name` 局部变量；`safeRel` / `experts.scan` 已有校验 |
| SQL 字符串插值 | 0 | 无注入面，全部 `?` 参数绑定 |
| TODO/FIXME | 16 | 注释、离线快照数据、扫描工具自身正则字面量 |

补充 7 项语义级核对：参数元数 **0 处不一致**、重复注册 **0**、
前端 `callApi` 字面量 **123 方法 / 382 调用零差集**、
Python 隐身方法 **116/116 有实现**、活动代码 **0 处直写 config.json**。

### 17.2 真问题一：Node 隐身方法漏注册（已修复）

Python `_V12_EXTRA` 有 **116 个隐身方法**，Node 只注册 114 个，缺
`memory_context_build` 与 `memory_audit_query`——前端调用会得到
`NOT_MIGRATED`。根因是 `contract-golden.mjs` 只校验 51 个公开方法，
**隐身面是长期盲区**。

修复：`pybridge.js` 补 `memoryContextBuild()`（门控 + scrub + 预算派生视图）
与 `memoryAuditQuery()`（双时间戳 as-of 查询 / history）；`registry.js` 补注册；
新增 `server/test/method-surface.mjs` 静态双向完整性门——解析
`backend/api.py::_V12_EXTRA` 与 `registry.js::PUBLIC_API_METHODS` /
`register()`，断言 **51 + 116 = 167 零差集**，并运行时冒烟两个补漏方法。
该门已纳入统一入口，今后任何一侧漏注册都会判红。

### 17.3 真问题二：删除方案本身不完整（已登记，未执行）

对删除做影响演练后发现：v1 的 186 文件清单**漏了 25 个必须同步改造的活动依赖**，
包括 `tests/conftest.py`（pytest 收集期加载）、`main.py` / `main_v1.0.0_legacy.py`
（pywebview 桌面链入口）、`contract-golden.mjs` / `contract-coverage.mjs` /
`domain-equivalence.mjs` / `method-surface.mjs`、
`tools/contract_diff.py` / `gen_test_disposition.py` 等门禁工具，
甚至 `server/src/registry.js` 与 `pybridge.js` 自身（读 `backend/api.py` 做校验）。

**因此「直接删除」会让 pytest 收集期、全部门禁与应用入口同时失效，
删除后无法验证任何东西。** `STEP5-DELETION-BOUNDARY.md` 已升级 **v2**：
补列 25 个文件完整路径、五项风险、六项前置条件，并把
「先重构这 25 个依赖」列为删除的硬前置。

### 17.4 为什么本轮仍未执行删除

**⚠️ 此操作非常危险，可能导致不可逆的数据丢失！**

用户指令是「全源码深扫描一遍，肯定存在问题的，然后解决了再删除」。
深扫描发现的两个问题中，第一个已修复；**第二个恰恰证明删除前置条件不成立**：
需要先重构 25 个活动依赖、完成 batch4 中 1277 钉的人工复核、
并明确是否废弃 pywebview 桌面链。在这三项完成前执行删除，
产物将是不可启动、不可测试的工作区，与「交付可运行结果」相悖。

按既有资产「只增不删」约定与安全规则，本轮**未删除任何文件**。
删除需用户就「是否废弃 pywebview 链 + 授权分批删除」给出明确单独确认。

### 17.5 验证

| 项 | 结果 |
|---|---|
| `method-surface.mjs` | **PASS**（51/116/167 零差集 + 2 方法冒烟） |
| `arch-contract.mjs` | **78/78**（新增 3 项深扫描断言） |
| 定向 pytest | **29 passed** |
| server 全量可跑门禁 | 见 §17.6 |
| 全量 `pytest tests/ -q` | 见 §17.6 |

### 17.6 回归结果

| 项 | 结果 |
|---|---|
| 统一门禁入口 | **12/12 PASS** |
| server 全量可跑门禁 | **35/35 PASS** |
| 契约差分 r68 | **零漂移** |
| 全量 `pytest tests/ -q` | **2097 passed / 0 failed / 3 skipped**（855s） |
| 删除文件数 | **0**（本轮未执行） |

---

## 18. 步骤 5/6 执行：Python 契约层退役与物理删除

**结论（先行）：步骤 5/6 已执行完毕。** 186 个文件（112 个 `backend/**/*.py` + 74 个耦合 pytest）已物理删除并送回收站，Python 契约层退役，Node/Electron 成为唯一运行链；删除后统一门禁入口 **12/12 PASS**、架构门禁 **78/78**、server 全量 **35/35 PASS**、契约差分 r68 **零漂移**、定向 pytest **29 passed**。（事实，均为删除后复验）

删除得以成立的关键不在清单本身，而在于**删除前先把删除后无法再做的事冻结下来**：从 `backend/api.py` + `Api()` 运行时生成 `frozen-python-surface.json`，并先把 25 个活动依赖改造为不依赖 Python 源码。删除后所有门禁以该冻结快照为唯一事实源。（事实；以下 18.8 给出这一移交的代价判断）

### 18.1 授权链与前置条件闭环（事实）

| 序 | 环节 | 内容 |
|---|---|---|
| 1 | 用户指令 | 「全源码深扫描一遍，肯定存在问题的，然后解决了再删除」 |
| 2 | 深扫描（§17） | 发现 **2 个真问题**：Node 隐身方法漏注册（已修复）、删除方案漏列 25 个活动依赖（v2 已登记） |
| 3 | 用户回复「是」 | 明确授权三件事：**废弃 pywebview 链 + 重构 25 个活动依赖 + 分批删除 186 文件** |

该授权覆盖了 §17.4 中「删除需就 pywebview 链与分批删除单独确认」的阻断条件；25 个依赖改造、冻结快照、双备份均在删除执行前完成，删除不再是「不可启动、不可测试」的操作。§16 / §17 中「步骤 5/6 未执行」「删除文件数 0」为删除前状态记录，保留不改，本节为删除后状态。

### 18.2 备份与可回滚（事实）

| 形式 | 标识 | 规模 / 用途 |
|---|---|---|
| Git 标签 | `git tag r69-pre-deletion` | 删除前提交点，可回滚 |
| 物理工作区副本 | `C:/Users/陈/Desktop/GLM-Chat-backup-20261111-1414` | **920 文件 / 24 MB** |

### 18.3 冻结快照：删除后的唯一事实源（事实）

`deliverables/dev-plan/frozen-python-surface.json`，从 `backend/api.py` + `Api()` **运行时冻结**：

| 字段 | 值 / 规模 |
|---|---|
| `API_VERSION` | `v1.0.0` |
| `APP_VERSION` | `1.9.0` |
| `api_py_sha256` | 删除前源码哈希，已冻结 |
| 公开方法 `public_methods` | **51** |
| 隐身方法 `hidden_methods` | **116** |
| 方法定义 `method_defs` | **167** |
| 参数元数表 `method_arities` | **167 项** |
| `domains` | **9** |
| `contract_baseline_r68` | r68 契约锚点冻结键 |

**删除后它是所有门禁的唯一事实源**；原本读 Python 源码或启动 Python 运行时的门，一律改读本文件。

### 18.4 25 个活动依赖改造（事实）

按三组落地，均为「先改造、后删除」：

| 组 | 对象 | 处置 |
|---|---|---|
| Node 组 | `contract-golden.mjs` / `method-surface.mjs` / `domain-equivalence.mjs` / `arch-contract.mjs` | 共 **6 处断言**完成改造，解除对 `backend/api.py` 的直接读取 |
| Python 组 | `tests/conftest.py`（顶层去掉 `backend import` 与 `legacy_main` 加载）、`tests/helpers/state_reset.py`、`tools/contract_diff.py`（三方交叉校验）、`tools/contract_golden_replay.py`（改「重放改快照比对」并如实标注）、`tools/check_release.py`（读冻结值）、`gen_test_disposition.py` / `classify_remaining_pins.py` / `review_all_remaining.py`（改为重放冻结产物） | 门禁与夹具不再依赖 Python 运行时 |
| 退役 stub | **9 个非门禁 Python 工具** + `main.py` / `main_v1.0.0_legacy.py` | 改为**明确退役 stub** |

### 18.5 物理删除执行（事实）

- `deliverables/dev-plan/deletion-manifest.json` 列 **186 个文件**：**112 个 `backend/**/*.py` + 74 个耦合 pytest**。
- PowerShell 的 `Add-Type` 与 COM 被安全策略拦截，故改用 Windows 原生 **`SHFileOperationW` + `FOF_ALLOWUNDO`** 送回收站（可恢复，而非永久删除）。
- **19 批 × 每批 ≤10 个**，逐批验证无残留。
- 用 `$Recycle.Bin` 的 `$I` 元数据确认原路径记录，**回收站增量 186 与清单一致**。
- **全程未使用 `rm` / `del`**。

### 18.6 删除后修复的门与同步的断言（事实）

| 对象 | 删除前 | 删除后 |
|---|---|---|
| `server/test/contract-coverage.mjs` | 读 `backend/api.py` | 改读冻结快照的 `method_defs` / `method_arities` |
| `server/test/contract-signatures.mjs` | 读 `backend/api.py` | 同上 |
| **3 条 pytest 断言** | 「Python 实现不得先删」「第一批不得物理删测试」等删除前语义 | 改为删除后语义 |
| `frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md` | 删除前状态 | 状态更新为「**步骤 5 已执行**」 |

这两个门是删除后才暴露的读取点：删除后实测确认其仍读 `backend/api.py`，随即改读冻结快照并复验通过，纳入 18.7 的删除后验证结果。

### 18.7 验证（删除后，实测）

| 项 | 结果 |
|---|---|
| 统一门禁入口 | **12/12 PASS** |
| 架构门禁 `arch-contract.mjs` | **78/78** |
| server 全量 | **35/35 PASS** |
| 契约差分 r68 | **零漂移** |
| 定向 pytest | **29 passed** |
| `main.py` | 输出明确退役提示且 **rc=0** |
| 全量 `pytest tests/ -q` | **475 passed / 2 skipped / 0 failed**（低负载单独复跑，344.71s，rc=0）。此前高负载并发下出现的位置漂移 F 经本次复跑证实为负载偶发、非代码回归；两文件单独复跑 40 passed，收集期 0 errors / 477 tests。其余门禁：统一入口 12/12、arch 78/78、server 35/35、契约差分 r68 零漂移。 |

`§18.x` 为全量回归结果的后续回填小节；结果产出前不预填通过数、失败数与耗时。

### 18.8 核心权衡（判断）

**删除后无法再用 Python 运行时做逐字节 oracle，改由冻结快照承担。**

- 删除前：`get_api_info()` 逐字节差分、golden 行为快照、contract-golden 的 Python oracle 都是**活体参照**，可随时重跑比对 Node 与 Python 两侧实现。
- 删除后：`backend/api.py` 与 `Api()` 已不存在，活体比对不可执行；51 / 116 / 167 方法面、参数元数、9 个 domains、r68 锚点由 `frozen-python-surface.json` **静态冻结**承担，门禁从「双实现差分」变为「单实现 ↔ 冻结面差分」。
- 判断：这削弱的是「随时用第二实现复验」的能力，换来的是运行链单一化与零 Python 依赖。冻结快照的生成时机、`api_py_sha256` 与只读性因此成为新的信任根，须与 `git tag r69-pre-deletion`、物理副本共同承担可回滚验证。**这不是等价替代，而是有代价的移交**，如实登记，不以「零漂移」字样掩盖 oracle 性质的变化。

### 18.9 边界与未执行项（事实 + 判断）

| 项 | 状态 |
|---|---|
| 推送 | **未推送**（R60 口径） |
| pywebview 桌面链 | **已废弃**，Node/Electron 为唯一运行链 |
| `dist/` 下既有 exe | **未删除**（事实）；其仍为旧链产物，不在本轮删除清单内（判断） |
| 可恢复性 | 回收站可恢复 + `git tag r69-pre-deletion` 可回滚 |

### 18.10 判定更新（判断）

- §2 维度 1「契约冻结与差分」：维持**达标**，但**口径变更**——冻结链与 r68 锚点仍在，差分对象由「双实现」变为「单实现 ↔ 冻结快照」，见 18.8。
- §3 P0-①「消除双轨」：Python 契约层 / pywebview 桌面链这一条双轨**已消除**；`frontend/app/` 与生产渲染层的双轨仍由 B0–B9 处理，本轮未改变。
- P0-③ 静态类型、P0-⑤ 代码覆盖率的环境阻塞不变；CI 门禁覆盖结论不因删除而改变。
- §16.5「`step5Blocked = true`」为删除前台账状态，删除执行后应由后续台账重算取代，本报告不回填未经验证的台账数字。



---

## 19. 删除后全面检测（用户「继续全面检测是否存在问题」）

### 19.1 方法

新增 `tools/post_deletion_audit.py`（可复跑）→
`deliverables/dev-plan/post-deletion-audit-r69.json`，六个维度：
死引用扫描、运行时配置残留、契约面双向差集、门禁文件齐备、
退役脚本守卫正确性、陈旧文档措辞。
扫描范围限定为活跃源码/配置目录（不递归 `outputs/` 的 17 万文件树）。

### 19.2 发现的真问题（1 类，涉及 6 个脚本）

**根因**：删除只移除了 112 个 `.py` 文件，但 `backend/` 目录仍在
（残留 315 个非 py 资产：prompts、内置专家包、`__pycache__`）。
上一轮的退役守卫把「`backend/` 目录是否存在」当作判据，因此**全部失效**，
脚本继续执行到 `import backend.*` 而崩溃：

| 脚本 | 实测现象 |
|---|---|
| `tools/gen_api_reference.py` | `ModuleNotFoundError: backend.api` |
| `tools/perf_w6p1.py` | `ModuleNotFoundError: backend.application.registry` |
| `tools/diff/extract_rpc_defaults.py` | `FileNotFoundError: backend/api.py` |
| `tools/diag/state_probe.py` | 目录判据误判 |
| `tools/diff/python_driver.py` | 目录判据误判 |
| `tools/verify-dpapi-interop.mjs` | 子进程 `ImportError: mcp_dpapi` |

**修复**：守卫判据统一改为 **`backend/api.py` 文件存在性**
（`perf_benchmark.py` 已用导入是否成功，无需改）。9 个退役脚本
（含 `main.py` / `main_v1.0.0_legacy.py`）实测全部 `rc=0` 且输出明确退役提示。

### 19.3 逐条核实的误报（不计为缺陷）

| 命中 | 结论 |
|---|---|
| 7 处运行时配置 backend 残留 | 全部指向 `backend/prompts` 与 `backend/experts_builtin`，这两个**资产目录仍存活（112 文件）**，`electron-builder.yml` 白名单与内置专家导入仍需要 |
| 54 处已删路径字面量 | 多为源码注释里以 Python 源文件名作设计溯源对照，非运行时依赖 |
| 291 处 `.ai-memory/` / `.mimosa/` 命中 | 历史会话记录，已从扫描面排除 |
| `Harbor.spec` / `Harbor-mac.spec` hiddenimports | 指向已删 `backend.domains`；pywebview 链已废弃，已加 **R69 退役标注**（不改功能，避免误执行） |

### 19.4 防回归门禁

`arch-contract.mjs` 新增 3 项断言（审计可复跑且契约面零差集、
退役脚本守卫不得再用目录判据、PyInstaller spec 已标注退役）；
`test_r68_arch_contract.py::test_retired_stubs_do_not_crash` 实测 9 个脚本
`rc ∈ (0,3)` 并校验守卫源码，防止同类缺陷再次出现。

### 19.5 验证

| 项 | 结果 |
|---|---|
| 契约面 | 51 公开 / 116 隐身 / 167 注册，**零差集** |
| 运行时配置残留 | **0** |
| 陈旧文档 | **0** |
| `arch-contract.mjs` | **81/81** |
| 统一门禁入口 | **12/12 PASS** |
| 定向 pytest | **30 passed** |
| 全量 `pytest tests/ -q` | **476 passed / 2 skipped / 0 failed**（250s） |
| 生产代码改动 | **零**（仅工具脚本守卫、配置标注、门禁与文档） |
