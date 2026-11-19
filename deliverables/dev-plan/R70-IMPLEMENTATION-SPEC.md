# R70 实施规格 · 30 轮自我迭代（主理人裁决版）

> 主理人：齐活林（Qi）· 交付总监｜架构设计：高见远（Gao）
> 事实源：`deliverables/dev-plan/R70-ITERATION-LEDGER.md`（迭代前基线）
> 上游：架构师阶段一报告（M1–M14 实测、系统设计、I01–I30 路线图）；关键实测已由主理人独立复核 M8 / M11 / M15。
> 本文件是工程师寇豆码的**唯一实施依据**，自包含，不依赖对话上下文。

---

## 0. 主理人裁决（覆盖架构师 B-8 待明确事项）

| # | 架构师提问 | 裁决 | 依据 |
|---|---|---|---|
| 1 | I13 是否把 `post_deletion_audit.py` 升为第 13 门 | **授权，但带回退兜底**。同批同步 4 处硬锚点；若 3 轮内无法收敛到「统一入口 13/13 + arch-contract 82/82 全绿」，回退到「保留 12 门 + I14 独立版新鲜度断言 + 手工体检」，并如实登记为回退，不判失败、不伪造通过 | verdict 硬编码 + 恒 `return 0` 是真实门禁缺陷；但接入面耦合 4 处，须可回退 |
| 2 | I04 `engines >=27.0.0-alpha` 是否改为 `>=22` | **不改配置，零代码改动**。本轮定性为「审计结论型迭代」：实测 v22.22.2 / CI `node-version:'22'` / engines 声明三者不一致，判断为未来基线声明（无文档依据），改 engines 会影响 `npm ci` 的 engine-strict 行为。登记漂移，由 I30 在 `electron/main.js` 注释中明确引用该口径 | 推断无文档依据；配置变更影响用户环境 |
| 3 | I19 `readJsonIfExists` 是否收紧异常 | **走零行为变更替代方案**：保留返回兜底，把非 ENOENT 异常写入结构化 `warnings` 并留痕，新增断言门覆盖。不抛异常、不改调用方语义 | 运行时路径行为变更风险高；留痕同样解决「静默吞掉」 |
| 4 | 新增文件是否授权 | **授权** `requirements-ci.txt`（独立文件，不污染 `config.json`）；`type-annotation-baseline-r69.json` 允许更新；**不落盘** `docs/system_design_r70.md` 等设计文档（避免冗余资产）。新增 `requirements-ci.txt` 前须先核实 `.github/workflows/harbor-ci.yml` 两个 job 中 Python 门禁的实际依赖，只收最小集。**补充授权（2026-11-12，应工程师「不自行扩权」请求）**：新增 `deliverables/dev-plan/post-deletion-audit-meta-r69.json`（I14 新鲜度 meta），字段/时钟源/比较基准/幂等/version 口径见 §3 I14；属独立文件、不污染 `config.json`、不破坏既有产物本体字节幂等 | 只增不删；独立文件符合零污染 |
| 5 | I29 暴露死重依赖怎么办 | **只登记豁免理由，不删任何依赖**；用例须输出每个依赖的「命中文件」证据 | 铁律：不删既有资产 |
| 6 | I15 后历史文档中的 37/27 门数字是否同步 | **历史原文保留不改**；仅产物字段与脚本注释改动态计数 | 项目「历史原文保留」约定 |
| 7 | I14 新鲜度判据口径（成员请示） | **统一走 `generatedAt` + 独立 meta 文件，不采纳「I13 成功→mtime / 回退→generatedAt」的条件分支**；容差 10 分钟；判据抽为可导出纯函数；回退路径在 CI 加一行前置 audit 命令刷新 meta | QA 实测 mtime 差距在 3h54m→11m54s→29m37s 漂移、随「谁最后跑门」变化，任何固定容差终将失效；`touch` 反例必须动真实产物违反 R3；条件分支会让反例与实现随 I13 成败分叉。独立 meta 保住 audit 产物字节幂等 |
| 8 | 成员间口径对齐方式 | **一律经主理人中转**。已要求工程师不再与 QA 直连判据细节；由主理人统一转给双方 | 专家团铁律：所有跨成员信息流经主理人中转 |
| 9 | **I27 `staleDocs` 遗留项（主理人规格缺陷，2026-11-12 裁决）** | **采纳「长期保留为非阻塞登记项」，不授权豁免识别机制**。撤销规格 §3 I27 与 §6.3 中「`scan_stale_docs()` 不再命中 / 归零」这一**不可达验收判据**（责任在主理人规格，非工程师实现）。替换为三条可达且强度不降的判据：① 命中数不增（T02=8 → 当前 7，减少 1）；② 7 条命中**逐条全部归属受保护历史原文**（A1 §2.3 正文 / I26 只增不删原文 / I27 §1-5 保留正文），STEP5/HANDOVER 仍不误判；③ 归零后 I13 动态 verdict / 第 13 门 / 13/13 不退化（工程师已做 L1/L2/L3 三层复验 + 反向注入真问题仍 rc=1）。`staleDocs` 按 I13 既有定义维持 `basis.staleDocsNonBlocking=True` 登记项，**不作为阻塞缺陷**。登记为 Known Issue，不冒充完成 | 规格自相矛盾：§3 I27 要求「不再命中」，而 §1 裁决 5 / §6.3 I26-I27 要求「§1-5 历史原文逐字保留、只增不删」，这些原文恰含那 7 条陈旧措辞。两条收敛路径均被硬边界禁止：① 改写/删除受保护历史原文（违反 A1/I26/I27/裁决 5）；② 放宽正则族或把活跃入口文档加入豁免（违反「不自行放宽判据」，且会破坏 QA 矩阵 I27 反例「注入陈旧短语须不因豁免而漏判活跃文档」）。**不采纳方案②即为不放宽判据**；扫描器强度、正则族、活跃入口文档集均一字未改 |

**超授权项（架构师 B-6，本轮一律不执行）**：X1 删 pyc/空目录、X2 从 requirements-win.txt 移除条目、X3 把 `frontend/app/` 接入生产链、X4 手改 `harbor.html`/`generated/*`、X5 新增 CSS 文件、X6 改冻结快照或 51 公开方法、X7 改 `config.json`、X8 覆盖 `docs/system_design.md`。

---

## 1. 硬边界（违反即回退该轮）

1. 契约事实源 = `deliverables/dev-plan/frozen-python-surface.json`（51 公开 / 116 隐身 / 167 方法定义 / 9 domains / `API_VERSION=v1.0.0` / `api_py_sha256=0bff58fe…c4d`）。**51 个公开 js_api 方法逐字节零漂移**；任何新门禁不得 import/读取 `backend/`；本轮不新增任何 js_api 方法。
2. `config.json` 零污染；新配置一律独立文件。
3. `frontend/react/src/generated/*.jsx`、`harbor.html` 是机器产物，**禁止手改**；`frontend/manifest.json` styles 必须仍为 14 且末位 `frontend/styles/responsive.css`；本轮不新增 CSS。
4. `contract_diff.py` 的 `html.dom_ids` 锚点 `contract-baseline-r68.json`（含 `golden_sha256`）零漂移；每批收尾必须 `--compare` 复验。
5. **不删除任何既有资产**。历史文档「保留原文」声明（`STEP5-DELETION-BOUNDARY.md §0`、`HANDOVER-R69.md §16/§17/§392`）不得改写，只允许改标题/状态行或追加角标。
6. 环境：Python `C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（3.13.14）；Node `C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（v22.22.2）；无外网。TypeScript / tsc / 覆盖率工具维持 `blocked-by-environment` 如实登记，**不得伪造**。
7. 门禁产物 JSON：`ensure_ascii=False, indent=2`，`version` 递增，幂等；SKIP 与原生退出崩溃必须显式留痕。
8. **每轮必须有可观察证据**：改动前的问题证据 + 改动后的验收命令与 stdout/rc。无证据的轮次记为「未验证」，不得标 PASS。

## 2. 硬锚点（改动前必须同批同步，否则判红）

| 锚点 | 位置 | 约束 |
|---|---|---|
| A1 | `frontend/app/tests/arch-contract.mjs:662` | 正则 `/2\.3 R69 Agent 浏览器闭环/` 直接读 `AGENTS.md` → **必须保留该章节标题字面量** |
| A2 | `frontend/app/tests/arch-contract.mjs:639-648` | 硬绑定 `post-deletion-audit-r69.json` 的 `version>=1`、`contractSurface` 三零差集、`retiredStubs[].usesDirectoryGuard===false`、以及 **`verdict.realDefectsFound===1`、`verdict.fixedFiles.length===6`** → I13 动态化 verdict 必须同步改这 2 条断言 |
| A3 | `server/test/method-surface.mjs:25,39,40` | 硬编码 `116/51/167`；`contract-golden.mjs:44` 硬编码 `>=40` → 改为 `===51` 时须同步注释「50 个公开方法」→ 51 |
| A4 | `tools/contract_diff.py:127-128,159` | FROZEN 7 键 + `style_count=14` + `verify_frozen_anchor()` 三方交叉，不改 |
| A5 | `tools/gate_coverage.py:24-41` | CANONICAL 16 项 / CI_ONLY 5 项与 `run_normalized_gates.py:32-58` GATES 一一对应 → 新增第 13 门须同步 CANONICAL、CI YAML 注释、`arch-contract.mjs` 门禁数断言、`tests/test_ci_tooling.py` |
| A6 | `frontend/manifest.json` | styles=14、末位 `responsive.css`、scripts=117、prebuilt=1 |

## 3. 30 轮精确指令

**通用验收门（每批收尾必跑，不可跳过）**：
```
python tools/contract_diff.py --compare deliverables/dev-plan/contract-baseline-r68.json   # 零漂移
node server/test/method-surface.mjs                                                       # 51/116/167
node frontend/app/tests/arch-contract.mjs                                                 # 82/82（或授权后新数）
python tools/run_normalized_gates.py                                                      # 12/12（或 13/13）
git diff --stat                                                                           # 确认未触碰 harbor.html / generated/* / frontend/styles/
```
`config.json` 零污染检查：`git diff -- config.json` 必须为空。

### 3.0 反例三件套（QA 严过关复核后强制，覆盖 §3 全部轮次）

QA 只读实测发现三条会让验收流于橡皮图章的风险，**本节优先级高于 §3 各轮原有的简写判据**：

**R1 · I02/I03 反例强度必须选对（原判据 `covered<16` 作废）**
QA 实测：`gate_coverage.py` 原始 16/16；「全删所有 `run:` 行」→ **14/16 已 FAIL**，故「全删后 covered<16」在改动前就成立，工程师哪怕没改也能「通过」，无区分力。唯一有效的两个精准注入（改动前均为 16/16 PASS）：
- **注入 A（注释专项）**：仅摘除 `.github/workflows/harbor-ci.yml` 第 83 行 `run: python tools/run_normalized_gates.py`，**保留第 58 行注释** → 改动前仍 16/16 PASS；修复后必须 FAIL，且 `missing` 列表必须具体指出该项（不能只报数字下降）。
- **注入 B（自指涉专项）**：把 `run_normalized_gates.py` 的 GATES 中某门路径改成不存在的目录，但**保留 token 子串** → 改动前仍 16/16 PASS；修复后的解析式校验必须 FAIL。
I02/I03 的验收必须同时给出 A、B 两个精准注入的「改动前 PASS / 改动后 FAIL」对照 + 正样本 16/16 PASS。

**R2 · 每个反例必须三件套，缺一不可**：① 改动前恒真（注入后旧实现仍 PASS）② 正样本仍 PASS（未注入时门必须 ok:true）③ 注入后 FAIL。缺 ② 时实现可写成「一律抛错」骗过反例。QA 实测三处易踩：
- I24「符号前插普通注释」在改动前**已判 False**，单独作反例无区分力 → 必须四样本对照：`adjacent=True` / `interleaved=False` / `novalue=False`（当前误判 True）/ `unbalanced=False`（当前误判 True）。
- I16 当前工作区 `findings=0`，只跑 `--strict` 会得 rc=0 假通过 → 必须先构造非空 findings，再验证非 strict rc=0 / strict rc=1 的分叉。
- I11/I12 必须同时验证「167 时 PASS」与「空集/空对象注入时 FAIL」。

**R3 · 产物与注入锚点必须自检、沙箱化**
- I14 的 mtime / `touch` 反例必须在**沙箱副本**内做并用 `os.utime` 精确恢复；工程师每跑一次统一入口就会刷新 `normalized-gates-r69.json` 的 mtime（QA 实测 post-audit 已陈旧约 4h，并发重跑会污染反例）。若实现走 `generatedAt` 字段而非 mtime，则 `touch` 根本不生效 → **必须先读实现确定口径**，再选对应反例。
- 所有 `replace(anchor, …)` 注入脚本必须 `assert anchor in src` 自检；工程师并行改文件后锚点失配会静默失效、跑出假 PASS。
- I13 的 A2 硬锚点（`arch-contract.mjs:647-648` 的 `realDefectsFound===1` / `fixedFiles.length===6`）另设专项反例：验证「脚本改了、锚点也同步了」，不能只验脚本 rc。

**I10 补充（QA 实测）**：`post_deletion_audit.iter_files()` 当前只扫 `.md`，而 `开发说明.txt` 是 `.txt` → 必须扩展后缀白名单，否则该活跃入口文档永远不命中，`staleDocs>0` 的验收会假通过。

**I21 补充（QA 实测）**：真实 `Harbor.spec` 上当前式与修复式**均判 False**，必须用构造样本 `datas = [('n','node_modules')]` 验证（当前 False → 修复后 True）；另 spec 缺失时当前是 rc=1 且抛 `Traceback FileNotFoundError`，修复后必须输出 `R7 缺少…` 且**无 traceback**。

**通用**：正式验收时以 `git show HEAD:tools/gate_coverage.py` 取「改动前基线」重跑恒真对照（QA 观察到工程师并发已把该文件改为 M，矩阵 §3 数值是并行中点快照，不冒充迭代前基线）。

---

### 批次 T01 · 基础设施与门禁基线校准（I01–I06）

**I01 · `tools/round_runner.py:37-41`**（主理人复核：`CORE` 12 项中 `tests/test_group_files.py`、`tests/test_modern_build.py` 已删）
- 用现存测试 `tests/test_ci_tooling.py`、`tests/test_contract_diff.py` 替换这 2 项；在 `CORE` 定义处加启动期 `is_file()` 自检（缺失即明确报错，不静默跳过）。
- 验收：`python -c "import sys;sys.path.insert(0,'tools');import round_runner as r;from pathlib import Path;assert all(Path(t).is_file() for t in r.CORE)"` → rc=0；`python tools/round_runner.py --help` rc=0。

**I02 · `tools/gate_coverage.py:45-58` + `.github/workflows/harbor-ci.yml`**
- CI_ONLY 检查面从「全文包含」改为「YAML 非注释 `run:` 命令块」：正则提取单行 `run:` 与 `run: |` 多行块，剥离 `#` 注释行；CANONICAL token 不变。
- 验收：**按 §3.0 R1 的两个精准注入**给出「改动前 16/16 PASS → 改动后 FAIL 且 `missing` 具体列出该项」的对照；正样本仍 16/16。**不要用「全删 `run:` 行 → covered<16」作唯一反例**（QA 实测改动前已 14/16 FAIL，无区分力）。

**I03 · `tools/gate_coverage.py:56-58`**
- 增加第二层解析式校验：从 `run_normalized_gates.py` 解析 `GATES` 的 argv，逐项校验门文件 `is_file()` 且 `required=True`；文本包含降为辅助。消除「读自身即恒真」的自指涉。
- 验收：**按 §3.0 R1 注入 B**（GATES 门路径改不存在目录但保留 token 子串）给出「改动前 16/16 PASS → 改动后 FAIL」对照；正样本仍 16/16。
- 注意：I02 与 I03 同文件，**串行**实现，同批复验。

**I04 · `package.json:6-9`、`server/package.json:7-10`**（裁决：零代码改动）
- 不做任何配置修改。在 `R70-ITERATION-LEDGER.md` 登记审计结论：实测 `node v22.22.2`、CI `node-version:'22'`、`engines >=27.0.0-alpha` 三者不一致；判断为「未来基线声明」（无文档依据，推断）；不改以免影响 `npm ci` engine-strict。由 I30 在 `electron/main.js` 注释中引用该口径。
- 验收：`node -e "console.log(require('./package.json').engines)"` 与 `grep node-version .github/workflows/harbor-ci.yml` 输出登记入台账；`git diff -- package.json server/package.json` 必须为空。

**I05 · `.github/workflows/harbor-ci.yml:41-45,73-77,60-61` + 新增 `requirements-ci.txt`**
- 先核实两个 job 中 Python 门禁实际 import 的第三方包（预计仅 `pytest`），据此新增最小 `requirements-ci.txt`；两个 job 的 `pip install -r requirements-win.txt` 改为新文件；`requirements-win.txt` **仅追加顶部退役标注**（保留全部原有条目）；注释「server 27 门」→ 动态或改为 37。
- 验收：`grep -n "requirements" .github/workflows/harbor-ci.yml` → 指向 `requirements-ci.txt`；`cat requirements-win.txt` 原条目全在 + 新增标注；CI 注释无「27 门」。

**I06 · `tools/run_normalized_gates.py:37,101`**（主理人复核：确有「64 项架构断言」「27 个」）
- note 改为动态计数文案（`serverGates` 写 `len(srv)`）；arch-contract note 改「以产物 checks 数为准」，不硬编码数字。
- 验收：`python -c "import sys;sys.path.insert(0,'tools');import run_normalized_gates as g;print(len(g.server_gates()))"` → 与产物 `serverGates` 一致。

---

### 批次 T02 · 删除后残留判据与契约门断言增强（I07–I12）

**I07 · `tools/check_release.py:134-140`**
- 删除 R6 的 `from backend.domains.settings.config_service import ConfigService` try/import，改为显式「契约层已退役」分支：直接读 `~/.glm-chat/config.json`（缺失即 `{}`），保留 R6 对 `version`/`app_version` 的判定不变。
- 验收：`python tools/check_release.py --expect 1.9.0` rc=0；`grep -n "from backend" tools/check_release.py` 仅剩说明性文字。

**I08 · `tests/helpers/state_reset.py:41`、`tools/diag/state_probe.py:68,86,97`、`tests/conftest.py:334,3`**
- 4 处 `from backend… import` + ImportError 降级改为读冻结快照 / 显式 `_CONTRACT_LAYER_RETIRED=True` 常量；`conftest.py` docstring「即将退役」→「已退役」。
- 验收：`grep -rn "from backend\|import backend" tests/ tools/diag/state_probe.py` 零运行时命中；`pytest tests/ -q` 收集期 0 errors。

**I09 · `tools/post_deletion_audit.py:141-164`**
- 守卫按 `file-guard` / `import-guard` / `pure-stub` 三类分别断言；`hasBackendLiteral` 改为只匹配代码行（剥离注释/docstring），修正把 main.py「不再 import backend」误判为 True；输出新增 `guardType` 字段。
- 验收：重跑扫描 → `main.py.backendImport=False`，9 个 stub 均 `guardType` 明确且 `usesDirectoryGuard=False`；`node frontend/app/tests/arch-contract.mjs` 82/82 不退化。

**I10 · `tools/post_deletion_audit.py:167-180`**
- `scan_stale_docs()` 的固定 5 短语表改为正则族 + 活跃入口文档集（`AGENTS.md`、`README.md`、`开发说明.txt`、`frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md`）；**保留** `ALLOW_PREFIX` 的 `deliverables/dev-plan/` 与 `ALLOW_FILES` 历史原文豁免。
- 验收：重跑扫描 → `staleDocs>0` 且命中上述文件；`STEP5-DELETION-BOUNDARY.md`/`HANDOVER-R69.md` 不被误判。

**I11 · `server/test/contract-coverage.mjs:29-37`**
- 目前只 `assert.deepEqual(ghosts,[])`，`missing` 仅打印，空集恒真。加下界 `assert.equal(legacy.size,167)`、`assert.equal(registered.size,167)`。
- 验收：`node server/test/contract-coverage.mjs` → `ok:true, legacy_methods:167, migrated:167`；把 `listMethods` monkeypatch 成 `[]` 时门必须 FAIL（需给出可复现的注入方式）。

**I12 · `server/test/contract-signatures.mjs:21-29` + `server/test/contract-golden.mjs:14,44`**
- 加 `assert.equal(Object.keys(node).length,167)` 与 `assert.equal(Object.keys(legacy).length,167)`；`contract-golden.mjs` 注释「50 个公开方法」→ 51，第 44 行 `>=40` → `===51`。
- 验收：`node server/test/contract-signatures.mjs` → `checked:167, mismatches:[]`；空对象注入时 FAIL；`node server/test/contract-golden.mjs` 仍 `order_identical:true`。

---

### 批次 T03 · 门禁接入、静态扫描与 CI 断言（I13–I18）

**I13 · `tools/post_deletion_audit.py:183-227` + `run_normalized_gates.py:32-58`**（关键路径，⚠ 裁决已授权带兜底）
- `verdict` 由本次扫描结果动态生成（不再硬编码 `realDefectsFound=1` / `fixedFiles` 6 项）；`main()` 发现运行时配置类真问题时返回 1；作为第 13 门接入统一入口（`gate_coverage.py` 之后）。
- **必须同批同步 A2/A5**：`gate_coverage.py CANONICAL` 16→17、CI YAML 注释、`arch-contract.mjs:647-648` 的 2 条硬断言、`tests/test_ci_tooling.py`。
- 验收：`python tools/run_normalized_gates.py` → 13/13；`python tools/post_deletion_audit.py` rc=0 且 verdict 随注入的真问题变化；`node frontend/app/tests/arch-contract.mjs` 82/82。
- **回退条件**：3 轮收敛仍无法同时满足 13/13 与 82/82 → 撤销接入，保留 12 门，改为 I14 独立版 + 手工体检，并在台账如实登记「回退」。

**I14 · `frontend/app/tests/arch-contract.mjs:634-648`**
- **统一走 `generatedAt` + 独立 meta 文件，不按 I13 成败做条件分支**（主理人 2026-11-12 裁决）。新建 `deliverables/dev-plan/post-deletion-audit-meta-r69.json`，含 ISO 8601 `generatedAt`（UTC、`datetime.now(timezone.utc).isoformat()`）、`source`、`version`（初始 1，结构变更时递增）；`ensure_ascii=False, indent=2`。**audit 产物本体不新增字段**，保持字节幂等；新鲜度与 I13 的 verdict 动态化解耦。
- `arch-contract.mjs` 用具名常量 `AUDIT_FRESHNESS_TOLERANCE_MS = 10 * 60 * 1000`（注释说明理由：CI 上 audit 门与 arch-contract 秒级差，本地「先跑统一入口再验」也在 10 分钟内），校验 `Date.now() - Date.parse(meta.generatedAt) <= 容差`。**把判据抽成可导出的纯函数** `isAuditFresh(generatedAt, now, toleranceMs)`，供 QA 做单元级反例。
- **验收**：正样本 = 统一入口跑完后立即验 → PASS；反例 = **沙箱副本内注入陈旧 `generatedAt` 内容副本**（不是 `touch`）→ FAIL；`assert anchor in src` 自检；不污染真实产物。接入 I13 后整体 82/82 不退化。
- **回退路径自洽**：若 I13 触发回退（保留 12 门），在 `.github/workflows/harbor-ci.yml` 的 `normalized-gates` job 中，于 `run: python tools/run_normalized_gates.py` 之前加一行 `run: python tools/post_deletion_audit.py` 刷新 meta。该行是辅助命令，**不新增门、不改变 12 门总数、不进 CANONICAL**。本地单独跑 arch-contract 前须先跑 audit，此约束在台账「已知取舍」如实登记。
- **授权痕迹**：见 §0 裁决 4 的「补充授权（2026-11-12）」——QA 验收时须能查到主理人明确授权，否则标「待授权项」不判 PASS。

**I15 · `tools/run_normalized_gates.py:61-65`**
- 建立显式 `NON_GATE_SCRIPTS = {'auth-migrate.mjs','node-sqlite-probe.mjs'}` 常量并写入产物 `excluded` 字段；`server_gates()` 读常量（探针不算门禁）。
- 验收（**主理人 2026-11-12 实测修正，原「→ 36」作废**）：`ls server/test/*.mjs | wc -l` = 37；当前 `server_gates()` = 36（仅排除 `auth-migrate.mjs`，实测 `node-sqlite-probe.mjs` 在列）；I15 再排除探针后应为 **35**。判据以 `python -c "import sys;sys.path.insert(0,'tools');import run_normalized_gates as g;print(len(g.server_gates()))"` = 35 为准，产物含 `excluded` 列出两个非门禁脚本；`I05/I06` 注释已是动态统计口径，不写死数字。

**I16 · `tools/check_static_paths.py:89-90,98,100`**
- `--strict` 目前是死参数（解析但不参与 `ok` 判定）。明确语义：`--strict` 时把 `legacy-flat-js` / `backend-services` findings 一并纳入 `ok`；非 strict 保持现状。
- 验收：`python tools/check_static_paths.py --strict --json` → `strict:true` 且 findings 非空时 rc=1；不加 `--strict` rc=0。

**I17 · `tools/check_static_paths.py:9-10,44-45`**
- `SCAN_DIRS` 加 `electron`、`server`、`.github`（共 8 目录）；删 2 条已删测试的死豁免；新增「已删除契约层路径」正则（`backend/api.py`、`backend/domains/*.py`）只对运行时配置类报错。
- 验收：`python tools/check_static_paths.py --json` → 扫描面含 8 目录；构造含 `backend/api.py` 的假配置行能命中。

**I18 · `tests/test_ci_tooling.py:78-100`**
- 增加 `normalized-gates` job 与 `tools/run_normalized_gates.py` 的 `run:` 行断言；文本包含改为「非注释行命中」；`test_workflow_yaml_parses` 覆盖 3 个 job。
- 验收：`pytest tests/test_ci_tooling.py -q` 全过；删除 YAML 中该 `run:` 行后用例 FAIL。

---

### 批次 T04 · 错误处理与 JSDoc 试点扩展（I19–I24）

**I19 · `server/src/paths.js:54-59`**（裁决：零行为变更替代方案）
- `readJsonIfExists` 保留 `return fallback`，但把非 ENOENT / 非 SyntaxError 异常写入结构化 `warnings`（有界、含 code/path），补 JSDoc `@throws` 说明「不抛，但留痕」；不改调用方语义。
- 验收：新增 `node --test` 用例覆盖「损坏 JSON → fallback」「模拟 EACCES → warnings 非空」；`node server/test/method-surface.mjs` 仍 ok:true。

**I20 · `tools/check_release.py:60-70,120-121`**
- `_latest_git_tag()` 区分三态：成功且有 v* tag / 成功但无 tag（skip）/ 命令失败或超时（写入 `fails` 或显式 `warning`）；`subprocess.run` 的 `timeout=30` 单独捕获。不再把故障误报为「[skip] 无 git tag（本地开发环境）」。
- 验收：`python tools/check_release.py --expect 1.9.0` rc=0；monkeypatch `subprocess.run` 抛 `TimeoutExpired` → 输出含显式 warning 而非 `[skip]`。

**I21 · `tools/check_release.py:157-161`**（主理人复核：当前正则 False、意图正则 True）
- `r'datas[^\\n]*node_modules'` → `r'datas[^\n]*node_modules'`；spec 读取加 `os.path.isfile` + try/except，缺失追加到 `fails` 而非 traceback。
- 验收：复现脚本两式一致 True；临时移走 spec 副本 → 输出 `R7 缺少…` 且 rc=1，无 traceback。

**I22 · `tools/arch_assessment.py:29-33`**
- `layer()` 内 `except OSError: pass` 改为累计 `readErrors` 列表写入 `architecture-metrics-r69.json`；保留幂等（相同输入同 sha256）。
- 验收：连续两次运行产物 sha256 一致；注入不可读文件后 `readErrors` 非空。

**I23 · `tools/type_annotation_audit.py:23` + `server/src/{config,logger,runtime}.js` + `type-annotation-baseline-r69.json`**
- 试点扩第一批 3 个短模块，补 `@type`/`@param`/`@returns`（**注释级、零行为变更**）；SCOPE 扩到 4 文件；更新独立基线 JSON（coverage 100%、exportedSymbols 新值），保持只增不减棘轮。
- 验收：`python tools/type_annotation_audit.py` → `PASS, coverage=100%, regressions=[]`；`node server/test/method-surface.mjs` 仍 ok:true。

**I24 · `tools/type_annotation_audit.py:25-56`**
- 用已定义但从未使用的 `DOC_RE` 做「紧邻 JSDoc 块」精确匹配（块结束行与符号声明行之间只隔空行）；加「标签值非空 + `{type}` 括号配对」最小格式校验；删死代码。
- 验收：构造「符号前插普通注释」的临时样本 → `annotated=false`；`python tools/type_annotation_audit.py` 仍 100%。

---

### 批次 T05 · 文档漂移收口与度量口径（I25–I30）

**I25 · `AGENTS.md:9,91-92,107,113-114`**（⚠ 硬锚点 A1）
- **必须保留 `## 2.3 R69 Agent 浏览器闭环` 标题字面量与 §2.3 全部内容**；第 1/4/5 节改为「冻结快照 + Node 运行时」口径；示例 `from backend.api import Api` → `invoke('get_api_info')` / Node 侧调用；红线 1 改为「契约事实源 = 冻结快照，新增方法须同步快照与 `method-surface.mjs` 167 断言」；顶部加 R70 退役声明。
- 验收：`node frontend/app/tests/arch-contract.mjs` **82/82 不退化**；`grep -n "from backend.api import" AGENTS.md` 零命中；`grep -n "2.3 R69 Agent 浏览器闭环" AGENTS.md` 仍命中。

**I26 · `README.md:3,96-97,149,154` + `开发说明.txt:4-5,9,26,41,46,61,75`**
- **只增不删**：两文件顶部追加「R70 退役声明」段落（Node/Electron 唯一运行链、冻结快照路径、旧实现见 `git tag r69-pre-deletion` 与物理副本）；「安装依赖/打包」段落加「历史链，勿用于当前版本」角标；原文字保留。
- 验收：`head -20 README.md` 含退役声明；`python deliverables/design/check_contract.py` UI 五大契约仍 PASS；契约差分零漂移。

**I27 · `frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md:1,11,131` + `deliverables/dev-plan/STEP5-DELETION-BOUNDARY.md:1,59`**
- **只改标题与状态行**，保留 §1-5 历史原文与「保留声明」；EXIT-PLAN 标题改「步骤 1–6 已执行（步骤 5/6 见 STEP5-DELETION-BOUNDARY）」；加角标「以下为删除前原文，执行结果以 §0 为准」。
- 验收：`grep -n "^#" …` 标题无「待确认/未执行」；STEP5 §1-5 行数不变。**「`scan_stale_docs()` 不再命中」判据已由主理人裁决 9 撤销**（与「§1-5 历史原文逐字保留」自相矛盾，见 §0 裁决 9），替换为「命中数不增 + 全部命中归属受保护历史原文 + 归零后 I13 动态断言与 13/13 不退化」。

**I28 · `tools/arch_assessment.py:52,68-73`**
- `ci_tokens` 增补 `run_normalized_gates.py` / `gate_coverage.py` / `type_annotation_audit.py` / `scc_ratchet.py`；`pythonContract` 层标注 `retired:True` 与 `files:0`（保留度量可比性，不删层）；同步 `architecture-metrics-r69.json`。
- 验收：CI token 命中数与 gate_coverage 口径对齐；产物幂等 sha256 一致。

**I29 · `tests/test_api_surface_consistency.py:48-63`**
- 根 `package.json` 的 `dependencies={}` 使 `for name in deps` 恒真 → 改为校验 `server/package.json` 的 dependencies 在 `server/src/**/*.js` 可检索，逐个输出「命中文件」证据；未命中者须显式登记豁免理由（**不删依赖**）；移除 `backend/**/*.py` glob；更新删除前语义的 docstring。
- 验收：`pytest tests/test_api_surface_consistency.py -q` 全过且输出每个依赖的命中文件；把某依赖名改错 → 用例 FAIL。

**I30 · `electron/main.js:15,28,40-41` + `tests/conftest.py:3`**
- 纯注释级更新：Node 基线改「实测 v22.22.2（CI node-version 22；engines 声明 >=27 为未来基线口径，见 I04 裁决）」；`main.py` seam 引用改「历史 seam，已退役」；红线改「契约事实源=冻结快照」；conftest「即将退役」→「已退役」。**零行为变更**。
- 验收：`grep -n "Node 24.22.1\|main.py\|即将退役" electron/main.js tests/conftest.py` 零命中（保留的「历史 seam」措辞除外，需在报告中说明）；`pytest tests/ -q` 收集期 0 errors。

---

## 4. 执行顺序与文件所有权

| 批次 | 轮次 | 主要所有权 | 前置 |
|---|---|---|---|
| T01 | I01–I06 | `tools/` + CI/配置/新文件 | — |
| T02 | I07–I12 | `tools/` + `server/test/*.mjs` + `tests/` | T01 |
| T03 | I13–I18 | `tools/` + `arch-contract.mjs` + `tests/` + CI | T01,T02（I13 关键路径） |
| T04 | I19–I24 | `server/src/` + `tools/` + 基线 JSON | T01 |
| T05 | I25–I30 | 文档组 + `tools/` + `tests/` + `electron/` | T02,T04,T03 |

**同文件串行**：I02↔I03、I16↔I17、I20↔I21、I23↔I24、I10↔I27 / I25 同批复验。
**每批完成后**：跑第 3 节通用验收门，把命令 + stdout 关键结论 + rc 写入台账，再进入下一批。

## 5. 交付格式（工程师回报要求）

1. 逐轮表格：`I编号 | 改动文件:行号 | 改动前证据 | 改动后验收命令 + 观察值 + rc | 结论(PASS/回退/未验证)`。
2. 全局一致性审查 `IS_PASS: YES/NO`（NO 则修复后重审，最多 2 轮）。
3. `git diff --stat` 全量清单 + 确认未触碰 `harbor.html` / `generated/*` / `frontend/styles/` / `config.json` / 冻结快照。
4. 每批的统一入口、契约差分、零差集、arch-contract 结果。
5. 明确列出「未执行 / 回退 / 需人工复核」的轮次，不冒充完成。

---

## 6. T04+T05 派发补充规格（主理人预置，2026-11-12；基于 T03 完成后的新基线）

> 本节只修订口径与联动约束，不改写 §3 各轮原指令；冲突处以本节为准。**派发时点**：须等 QA 对 T03 的正式验收回传后，因 T04/T05 要改 `tools/check_release.py`、`tests/conftest.py`、`AGENTS.md`，与 QA 验收对象重叠。

### 6.1 门禁基线已变（所有 T04/T05 验收判据按新值）
| 项 | T02 收尾 | **T03 收尾（现行）** |
|---|---|---|
| 统一入口 | 12/12 | **13/13**（新增 `post-deletion-audit` 门，位于 `gate-coverage` 之后、`arch-contract` 之前） |
| `gate_coverage` CANONICAL | 16/16 | **17/17** |
| GATES 具名门 | 11 | **12** |
| `server_gates()` | 36 | **35**（`NON_GATE_SCRIPTS` 排除 `auth-migrate.mjs` 与 `node-sqlite-probe.mjs`） |
| `arch-contract` | 82/82 | **82/82（断言数不变）** |
| audit 产物 | `version=1`、verdict 静态 | `version=2`、`verdict.dynamic=true`、`realDefectsFound=0`、字节幂等 sha256 `979e257b…` |
| 新鲜度 meta | 无 | **新增** `post-deletion-audit-meta-r69.json`（`generatedAt` UTC，10 分钟容差） |

**T04/T05 收尾必跑**：`python tools/run_normalized_gates.py` → 13/13；`python tools/gate_coverage.py` → 17/17；`node frontend/app/tests/arch-contract.mjs` → 82/82；`node server/test/method-surface.mjs` → 51/116/167；`python tools/contract_diff.py --compare …r68.json` → 零漂移；`python deliverables/design/check_contract.py` → UI 五大契约 PASS；`python tools/type_annotation_audit.py` → 100%；`pytest tests/ -q` → 0 failed；`git diff -- config.json` 空。
**⚠ 时序约束**：单独跑 `arch-contract.mjs` 前必须先跑一次 `python tools/post_deletion_audit.py` 或统一入口刷新 meta，否则 10 分钟容差会让新鲜度断言判红（裁决三已登记，非源码 Bug）。

### 6.2 T04（I19–I24）逐轮补充
- **I19**（裁决 3，零行为变更）：`server/src/paths.js:54-59` 的 `readJsonIfExists` **保留 `return fallback`**，把非 ENOENT / 非 SyntaxError 异常写入有界结构化 `warnings`（含 `code`/`path`），补 JSDoc 说明「不抛、但留痕」。新增 `node --test` 用例覆盖「损坏 JSON→fallback」「模拟 EACCES→warnings 非空」。**注意**：`paths.js` 同时是 I23 的 JSDoc 试点文件，新增 `warnings` 后须确认 `type_annotation_audit.py` 的 `SCOPE` 与基线 JSON 同步，避免覆盖率退化。
- **I20 / I21**（同文件 `tools/check_release.py` **串行**）：I20 `_latest_git_tag()` 区分三态、`subprocess.run` 的 `timeout=30` 单独捕获，命令失败/超时写显式 `warning` 而非 `[skip]`；I21 正则 `r'datas[^\\n]*node_modules'` → `r'datas[^\n]*node_modules'`、spec 缺失追加 `fails` 不抛 traceback。**I21 必须用构造样本** `datas = [('n','node_modules')]` 验证（QA 实测真实 `Harbor.spec` 上新旧两式**均判 False**，用真实文件会假通过）；另需验证 spec 缺失时输出 `R7 缺少…` 且**无 traceback**（改动前是 rc=1 + `FileNotFoundError` traceback）。
- **I22**：`tools/arch_assessment.py:29-33` 的 `except OSError: pass` 改为累计 `readErrors` 写入产物；**保持连跑 2 次 sha256 一致**（幂等）。
- **I23 / I24**（同文件 `tools/type_annotation_audit.py`，**顺序：先 I24 修算法，再 I23 扩 SCOPE**）：I24 先用已定义但未使用的 `DOC_RE` 做「紧邻 JSDoc 块」精确匹配（块结束行与符号声明行之间只隔空行）+ 标签值非空 + `{type}` 括号配对的最小格式校验，删死代码；**先确保对现有 `paths.js` 7 符号仍判 7/7=100%**，再由 I23 把 `SCOPE` 扩到 `config.js`/`logger.js`/`runtime.js` 共 4 文件并更新独立基线 JSON（coverage 100%、exportedSymbols 新值、只增不减棘轮）。若顺序颠倒，新算法可能先让试点覆盖率判红。
  - **I24 反例必须四样本对照**（QA 实测改动前 `interleaved` 已判 False，单独作反例无区分力）：`adjacent=True`、`interleaved=False`、`novalue=False`（改动前误判 True）、`unbalanced=False`（改动前误判 True）；并给「167/正样本仍 100%」的正对照，满足 §3.0 R2 三件套。
- **I28**（T05，但改同一 `tools/arch_assessment.py`，与 I22 跨批串行）：`ci_tokens` 增补时须纳入 T03 新增的 `post_deletion_audit.py` 门；`pythonContract` 层标 `retired:true` + `files:0`。**按裁决 6「历史原文保留不改」，`architecture-metrics-r69.json` 的 `serverRunnableGates:27` 不改写**，只增补新字段，并在台账说明其为历史数字。

### 6.3 T05（I25–I30）联动与硬锚点
- **I25（最高风险）**：`AGENTS.md` 第 1/4/5 节改「冻结快照 + Node 运行时」口径、示例改 `invoke('get_api_info')`、红线 1 改「契约事实源 = 冻结快照」、顶部加 R70 退役声明；**必须保留 `## 2.3 R69 Agent 浏览器闭环` 标题字面量与 §2.3 全部内容**（`arch-contract.mjs:662` 硬断言，实测 grep 计数 1）。验收 `arch-contract.mjs` 仍 82/82。
- **I26 / I27（只增不删）**：`README.md`、`开发说明.txt` 顶部追加退役声明 + 历史链角标，原文字保留；`PYTHON-CONTRACT-EXIT-PLAN.md` 与 `STEP5-DELETION-BOUNDARY.md` **只改标题与状态行**，保留 §1-5 历史原文与「保留声明」。
- **⚠ I10 ↔ I27 ↔ I13 联动（本批最关键；「归零」判据已由裁决 9 撤销，以裁决 9 为准）**：T02 的 `scan_stale_docs()` 当前 `staleDocs=8`。**「补退役声明后不再命中 / 归零」是不可达判据**（与「§1-5 历史原文逐字保留、只增不删」自相矛盾），已由主理人裁决 9 撤销并替换为「命中数不增 + 全部命中归属受保护历史原文 + 归零后不退化」三条。仍需复验：I13 的 `verdict` / `arch-contract.mjs` 动态交叉校验在 `staleDocs` 归零时仍成立、第 13 门 rc=0、13/13 不退化。
- **I29**：`tests/test_api_surface_consistency.py` 改为校验 `server/package.json` 的 dependencies 在 `server/src/**/*.js` 可检索并逐个输出「命中文件」；**QA 实测 server deps 为 12 个（规格写 11，以实测为准）**；未命中者只登记豁免理由，**不删任何依赖**；移除 `backend/**/*.py` glob；更新删除前语义 docstring。反例：把某依赖名改错 → 用例 FAIL。
- **I30**：纯注释级。`electron/main.js` 的 Node 基线改「实测 v22.22.2（CI node-version 22；engines >=27 为未来基线口径，见 I04 裁决）」、`main.py` seam 引用改「历史 seam，已退役」、红线改「契约事实源=冻结快照」。**`tests/conftest.py` 的「即将退役」→「已退役」已由 I08 完成，本轮不要重复改、也不要误判为未完成**；验收 `pytest tests/ -q` 收集期 0 errors。
- **I04 收口**：在台账登记 engines 漂移的三方实测与「不改」裁决（T02 已做），I30 的注释引用该口径即闭环。

### 6.3b 现行行号勘误（主理人 2026-11-12 实测，T03 收尾后）
> 架构师规格的行号来自早期勘察；CI YAML 已发生过 L83→L84 漂移。以下为**当前文件实测行号**，派发 T04+T05 以此为准，注入锚点仍一律用内容锚点 + `assert anchor in src`。

| 轮次 | 目标 | 实测行号与现场事实 | 规格原写 |
|---|---|---|---|
| I19 | `server/src/paths.js` | `readTextIfExists:39`（`catch:42`）、`readJsonIfExists:54`（`catch:57`）、`atomicWriteJson` 附近 `catch:86` | `:54-59` 大致吻合 |
| I20 | `tools/check_release.py` | `_latest_git_tag():53-71`，`subprocess.run` **已有 `timeout=30`**（`:63`），但 `:69` `except Exception: return ''` 把超时与命令失败一并吞掉；调用点 `:106` | `:60-70` |
| I21 | 同上 | spec 循环 `:153`，`open(...).read()` **无 `isfile`**（`:154`），缺陷正则 `r'datas[^\\n]*node_modules'` 在 `:156`；`:148-152` 已有 R7 的 UiSchema 文件存在性检查可作写法范例 | `:157-161` |
| I22 / I28 | `tools/arch_assessment.py` | `layer():23`、`except OSError:32`；`pythonContract:'backend':52`；`ci_tokens:69`、`ci_present:73`；**`:161` 另有删除前过期文本** `'pythonContractLayer': 'present (C path step 4 in progress)'` —— I28 须一并改为退役口径（规格未点名，属新增发现） | `:29-33` / `:52,68-73` |
| I23 / I24 | `tools/type_annotation_audit.py` | `BASELINE:19`、`SCOPE:23`（当前仍 1 文件）、`DOC_RE:27`（定义后未使用）、`audit():30`、基线读取 `:61`、覆盖率棘轮 `:77` / exportedSymbols `:79` | `:23` / `:25-56` |
| I29 | `tests/test_api_surface_consistency.py` | `_backend_methods():27`；`test_no_dead_runtime_dependencies():48`，`deps:50`、`for name in deps:52`、`:54` 仍 glob `backend/**/*.py`；**`server/package.json` dependencies 实测 12 个**（`@libsql/client`、`@libsql/kysely-libsql`、`@modelcontextprotocol/sdk`、`@prisma/adapter-libsql`、`@prisma/client`、`better-auth`、`fastify`、`iconv-lite`、`kysely`、`pino`、`playwright-core`、`zod`），不是规格写的 11 | `:48-63` / deps 11 |
| I30 | `electron/main.js` | `:15` `Node 24.22.1 ≥ 24.22 实测验证基线`、`:28` `先例=main.py GLM_CDP_PORT seam`、`:40` `红线对位：main.py / backend/ Python 零改动` 三处均为删除前口径；`tests/conftest.py` 的「即将退役」→「已退役」已由 I08 完成 | `:15,28,40-41` 吻合 |

**I21 补充依据**：`datas[^\\n]*node_modules` 对构造样本 `datas = [('n','node_modules')]` 判 **False**、修复式 `[^\n]*` 判 **True**；但 QA 实测**真实 `Harbor.spec` 上两式均判 False**，故必须用构造样本验收，用真实文件会假通过。另 spec 缺失当前会抛 `Traceback FileNotFoundError`（`:154` 裸 `open`），修复后须输出 `R7 缺少…` 且无 traceback。

### 6.4 T04+T05 全局约束
1. 51 公开方法逐字节零漂移、冻结快照与 r68 锚点不动；`config.json` 零污染；`harbor.html`/`generated/*`/`frontend/styles/`/`frontend/manifest.json`(styles=14) 不动；不删既有资产；不新增 CSS 文件。
2. 历史文档「保留原文」声明（`STEP5` §0、`HANDOVER-R69` §16/§17/§392）不得改写，只允许改标题/状态行或追加角标。
3. TypeScript/tsc/代码覆盖率维持 `blocked-by-environment`，JSDoc 覆盖率 ≠ 静态类型检查，不伪造。
4. 门禁总数维持 **13/13、17/17、82/82**；若 T05 的 `staleDocs` 归零影响 I13 的 verdict 断言，按 QA 口径回传，不擅自改第 13 门或放宽判据。
5. 每轮按 §3.0 反例三件套留证（改动前恒真 + 正样本仍 PASS + 注入后 FAIL），注入锚点 `assert anchor in src`，mtime/产物类反例在沙箱副本内做。
6. 台账 §1 追加 I19–I30 共 12 行（保持 I01–I18 不动）、§2 追加 T04/T05 回归行、§4 追加全局审查 `IS_PASS`、§5 追加增量 `git diff --stat` 与禁改边界确认。
