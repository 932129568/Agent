# R70 · 30 轮自我迭代台账

> 主理人：齐活林（Qi）· 交付总监｜团队：`software-harbor`
> 任务：阅读最新源码 → 整体自我迭代 30 次
> 口径：**每次迭代 = 一轮「读源码证据 → 定位具体问题/改进点 → 落地可验证改动 → 跑定向门禁留痕」**，编号 I01–I30。
> 硬边界：51 公开 js_api 方法逐字节零漂移；`config.json` 零污染；`generated/*` 与 `harbor.html` 机器产物不手改；不新增 CSS 文件；不删除既有资产；每轮以门禁证据为准，不伪造通过。

## 0. 迭代前基线（2026-11-11 22:2x 实测）

| 判据 | 命令 | 观察值 | 结论 |
|---|---|---|---|
| 工作区干净 | `git status --short` | 空 | PASS |
| 统一门禁入口 | `python tools/run_normalized_gates.py` | 12/12 PASS，0 SKIP，0 FAIL，serverGates=36，nativeExitWarnings=0 | PASS |
| 契约零差集 | `node server/test/method-surface.mjs` | public=51 / hidden=116 / nodeRegistered=167 / missing=[] / ghosts=[] | PASS |
| 架构断言 | `node frontend/app/tests/arch-contract.mjs` | 82/82 | PASS |
| 门禁覆盖 | `python tools/gate_coverage.py` | canonical 16/16 (100%)；代码覆盖率 blocked-by-environment（如实登记） | PASS |
| 冻结快照 | 读 `frozen-python-surface.json` | 14 键；sourceCommit `e737c3e`；API_VERSION v1.0.0 | 完好 |
| 锚点 | 统一入口 `contract-diff --compare r68` | 零漂移 | PASS |

统一入口 12 门实测明细：`gate-coverage` / `arch-contract` / `frontend-l1` / `frontend-l2` / `golden-replay` / `contract-diff` / `allowlist-ratchet` / `scc-ratchet` / `type-annotation` / `arch-assessment` / `ui-contract` / `server-gates`（36 个 mjs 聚合），全部 PASS。

现场结构实测：`server/src/` 含 `services/` 28 文件、`routes/` 3、`cli/` 1、`generated/` 1 + 10 个根文件；`frontend/app/` 仍为规范骨架（含 `src/ tests/ docs/ tools/ build.mjs`）；`tests/*.py` 81 个；`server/test/*.mjs` 37 个（36 门 + `auth-migrate.mjs` 历史脚本）。

## 1. 迭代记录

> 每轮格式：编号 / 主题 / 目标与证据 / 改动文件 / 验收命令与观察值 / 结论 / 门禁回归。
> 待架构师高见远产出 30 轮路线图后由工程师寇豆码逐批填充，QA 严过关逐批核验。
> **本批次 = T01+T02（I01–I12），主理人裁决版 `R70-IMPLEMENTATION-SPEC.md` §3 为唯一事实源；T03–T05（I13–I30）尚未派发，未执行。**

### 1.1 批次 T01+T02 逐轮表（I01–I12，2026-11-11 实测）

| 轮次 | 主题 | 改动文件:行号 | 改动前证据 | 改动后验收命令 + 观察值 + rc | 结论 | 门禁 |
|---|---|---|---|---|---|---|
| I01 | CORE 死测试清单校准 + 启动期自检 | `tools/round_runner.py:39-63`（CORE 定义 39-47、`_assert_core_exists()` 49-61、模块级调用 63） | `tests/test_group_files.py`、`tests/test_modern_build.py` 实测 MISSING（随 74 个 pytest 删除）；`git show HEAD:tools/round_runner.py` 第 40/42 行仍引用二者；pytest 收不到目标时静默跳过 | 替换为现存的 `tests/test_ci_tooling.py`、`tests/test_contract_diff.py`（均 EXISTS）。`python -c "…assert all(Path(t).is_file() for t in r.CORE)"` → `CORE 12`，rc=0；`python tools/round_runner.py --help` → rc=0；8 文件 `py_compile` 全 OK | PASS | 12/12、定向 pytest 17 passed |
| I02 | CI_ONLY 检查面收紧为「YAML 非注释 `run:` 命令块」 | `tools/gate_coverage.py:67-113`（`extract_ci_run_blocks`）、`:184-193`（evaluate 的 `ci_runs` 判据）、`:10-13`（docstring） | HEAD 版 `:57-58` 用 `surface = ci_text + '\n' + entry_text` **全文包含**，YAML 注释行里的 token 也算命中 → 假覆盖。对照注入：`# 历史说明：…check_contract.py / round_runner.py / check_release.py / entry_sweep.py / run_normalized_gates.py`，旧逻辑 covered=16/16（假 PASS） | 新逻辑剥离 `#` 注释行 + 提取单行 `run:` 与 `run: |` 块。**R1 精准注入 A**：仅摘除第 84 行 `run: python tools/run_normalized_gates.py`、保留第 58 行注释（锚点 `assert anchor in ci` 自检）→ 改动前旧逻辑 16/16 PASS，改动后 `covered=15/16, status=FAIL, missingGates=['normalized-gate-entry']`。**反例**：YAML 全部 run: 行替换为占位符 → `covered=11 < 16`、FAIL。**正样本**：`python tools/gate_coverage.py` → `PASS 16/16 (100.0%) missing=[]`，rc=0 | PASS | 16/16、arch-contract 82/82（读数 `percentage===100`、`missingGates.length===0` 依赖） |
| I03 | 第二层解析式校验（消除「读自身恒真」自指涉） | `tools/gate_coverage.py:116-181`（`parse_gates` 116-153、`validate_gate_structure` 155-181）、`:221-226`（产物 `structuralCheck`）、`:239-249`（main 打印） | HEAD 版 `gate-coverage` 项的 token `gate_coverage.py` 出现在 `run_normalized_gates.py` 文本内即恒真；文本包含无法证明门文件真实可跑 | AST 解析 GATES 的 (id, argv, required)，逐项校验 argv 门文件 `is_file()` 且 required 为显式布尔。**R1 精准注入 B**：`'tools/gate_coverage.py'` → `'tools/__MISSING_DIR__/gate_coverage.py'`（保留 token 子串，锚点自检）→ 改动前旧逻辑 16/16 PASS；改动后文本层仍 16/16 恒真，但 `structuralCheck.errors=[{'gate':'gate-coverage','line':34,'kind':'gate-file-missing','detail':'门文件不存在: tools/__MISSING_DIR__/gate_coverage.py'}]`，`status=FAIL`。**正样本**：产物 `parsedGates=11, structuralErrors=0`，rc=0 | PASS | 16/16、统一入口 12/12（`structuralErrors=0` 主理人已独立复核） |
| I04 | **审计结论型迭代（零代码改动）** | 无（仅台账登记） | `node -v` → `v22.22.2`；CI `.github/workflows/harbor-ci.yml:40,73,107` → `node-version: '22'`；`node -e "…engines"` → root/server 均 `{"node":">=27.0.0-alpha.0.0.0","npm":">=12.0.0"}`。**三者不一致**：实测运行时 22.22.2 / CI 22 / engines 声明 ≥27.0.0-alpha | **裁决：不改 engines**。依据（规格 §0 裁决 2）：≥27 判断为「未来基线声明」，无文档依据；改 engines 会影响 `npm ci` 的 engine-strict 行为，进而改变用户/CI 安装语义；本轮为只读审计，配置变更影响面超出授权。由 I30 在 `electron/main.js` 注释引用该口径。`git diff -- package.json server/package.json` → **空**，rc=0 | PASS（审计结论，零代码改动） | 零代码改动，不影响门禁 |
| I05 | CI 依赖最小集 + 冻结构建依赖退役标注 + 注释计数 | `.github/workflows/harbor-ci.yml:45,78`（`-r requirements-ci.txt`）、`:61`（「server 27 门」→「37 个 mjs 文件，实际门禁数由统一入口动态统计」）；新增 `requirements-ci.txt:1-23`；`requirements-win.txt:1-4`（顶部追加退役标注） | 两个 job 的 `pip install -r requirements-win.txt` 会安装 pywebview/PyInstaller/pythonnet/Pillow/orjson 等冻结构建依赖，CI 门禁并不需要；CI 注释仍写「server 27 门」与实测 37 个 mjs 文件（36 门）漂移 | **先核实依赖**：AST 逐文件扫描两个 job 实际 Python 门禁的 import，结论「唯一第三方包 pytest；PyYAML / psutil 均为 try/except 可选降级；check_contract / function_graph / state_reset 为仓库内本地模块」，据此写最小 `requirements-ci.txt`（仅 `pytest` + 23 行核实注释）。验收：`grep -n requirements .github/workflows/harbor-ci.yml` → `:45,:78` 均指向 `requirements-ci.txt`；原 13 条冻结依赖逐条核对**全部保留**；`grep "27 门" CI` → 零命中；`requirements-ci.txt` 末行 `pytest` | PASS | test_ci_tooling 定向 pytest 17 passed；新配置独立文件，`config.json` 零污染 |
| I06 | 统一入口 note 去硬编码计数 | `tools/run_normalized_gates.py:37`（`'64 项架构断言'` → `'架构断言（数量以该门产物 checks 数为准，不硬编码）'`）、`:101`（注释「27 个」→ `len(srv)` 动态统计口径） | HEAD 版 `:37` note 硬编码「64 项架构断言」、`:101` 硬编码「27 个」，与产物 `checks` / `serverGates=36` 漂移；**不改 GATES 逻辑与数量** | `python -c "…print(len(g.server_gates()))"` → `36`，与产物 `serverGates=36` 一致，rc=0；`pytest`/统一入口 12/12 不变；`grep` 确认源码无「64 项」「27 个」 | PASS | 12/12、16/16、82/82 均未退化 |
| I07 | R6 删除 backend.ConfigService try/import | `tools/check_release.py:134-142` | HEAD 版 `:135` 有运行时 `from backend.domains.settings.config_service import ConfigService`，`:137` 用 `except ImportError` 兜底；契约层退役后该 import 恒失败 | 改为显式「契约层已退役」分支：直接读 `~/.glm-chat/config.json`（缺失即 `{}`），R6 对 `version`/`app_version` 判定逐字不变。`python tools/check_release.py --expect 1.9.0` → `发布纪律断言全过：VERSION=1.9.0 API_VERSION=v1.0.0 tag=1.8.0`，rc=0；`grep -n "from backend" tools/check_release.py` → 仅 `:18` docstring 说明性文字（HEAD 版另有 `:135` 运行时 import，已删） | PASS | check_release rc=0；契约差分零漂移 |
| I08 | 4 处 backend import 降级 → 显式退役常量 + 冻结快照 | `tests/helpers/state_reset.py:15-24,45-55`；`tools/diag/state_probe.py:21-39,72-99`；`tests/conftest.py:4（docstring 即将退役→已退役）,29-30,325-339` | HEAD 版 5 处运行时 `from/import backend…`（`state_reset.py:41`、`state_probe.py:68,86,97`、`conftest.py:334`）+ ImportError 降级；`conftest.py:3` docstring「即将退役」与已退役事实不符 | 改读冻结快照 `FROZEN_SURFACE` / 显式 `_CONTRACT_LAYER_RETIRED=True` 常量短路。**AST 精确验收**：3 文件 `ast.walk` 统计运行时 backend import = `0/0/0`，合计 0，rc=0；`grep -rn --include=*.py "from backend\|import backend" tests/ tools/diag/state_probe.py` → 仅 `conftest.py:5,262` 两处**说明性注释/文档文字**（「不再 import backend」否定式描述，非运行时 import）；`pytest tests/ -q --collect-only` → `478 tests collected in 0.59s`，**收集期 0 errors**，rc=0 | PASS | 收集期 0 errors；12/12；I30 后续将再动 conftest，本批次仅做 I08 部分 |
| I09 | 退役守卫三类分类 + `hasBackendLiteral` 代码行判定 | `tools/post_deletion_audit.py:59-72`（常量/正则族）、`:104-141`（`_code_only_lines` / `_uses_directory_guard` / `_classify_guard`）、`:222-251`（`scan_stubs` 输出 `backendImport`/`guardType`/`guardOk`） | HEAD 版 `:163` 对全文 `(?:from|import)\s+backend\b` 正则，把 `main.py` docstring「不再 import backend」误判为 `hasBackendLiteral=True`；9 个 stub 无守卫分类 | `_code_only_lines()` 剥离 Python 三引号 docstring/`#` 注释与 JS `/* */`/`//`；按 `file-guard`/`import-guard`/`pure-stub` 三类分别断言。**重跑** `python tools/post_deletion_audit.py` → rc=0，产物 `main.py.backendImport=False`；9 个 stub `guardType` 分别 `pure-stub×2 / file-guard×6 / import-guard×1`，`guardOk` 全 True，`usesDirectoryGuard` 全 False；`verdict.realDefectsFound=1`、`fixedFiles=6` **未动**（A2 硬锚点守住）；`node frontend/app/tests/arch-contract.mjs` → `82/82`，rc=0 | PASS | 82/82 不退化；verdict 未改 |
| I10 | `scan_stale_docs()` 固定 5 短语 → 正则族 + 活跃入口文档集 | `tools/post_deletion_audit.py:73-102`（`ACTIVE_ENTRY_DOCS` 4 个、`STALE_PATTERNS` 8 族）、`:254-290`（`scan_stale_docs`） | HEAD 版 `:176-177` 固定 5 短语表，对 `AGENTS.md`/`README.md`/`开发说明.txt`/`PYTHON-CONTRACT-EXIT-PLAN.md` 零命中（grep 实测）；`开发说明.txt` 为 `.txt` 且不在 `iter_files()` 扫描面 | 正则族 8 类 + 活跃入口文档集显式纳入（含 `.txt`，不受后缀限制）；**保留** `ALLOW_PREFIX` 的 `deliverables/dev-plan/` 与 `ALLOW_FILES` 历史原文豁免。重跑扫描 → `staleDocs=8`，命中文件恰为 `AGENTS.md`、`README.md`、`开发说明.txt`、`frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md`；`STEP5-DELETION-BOUNDARY.md` / `HANDOVER-R69.md` **未被误判**（豁免生效），rc=0 | PASS | 82/82（产物 `contractSurface` 三零差集不变）；为 T05 I27 预置判据 |
| I11 | 契约覆盖门加 167 下界断言（空集恒真） | `server/test/contract-coverage.mjs:35-39` | HEAD 版 `:35` 仅 `assert.deepEqual(ghosts,[])`，`missing` 只打印；`listMethods()` 返回 `[]` 时 ghosts/missing 皆空 → 假 PASS | 加 `assert.equal(legacy.size,167)`、`assert.equal(registered.size,167)`。**正样本**：`node server/test/contract-coverage.mjs` → `ok:true, legacy_methods:167, migrated:167, not_migrated:0, ghosts:0`，rc=0。**注入**（系统临时目录副本，`assert 'const { listMethods }' in src` 自检，`listMethods` monkeypatch 为 `() => []`）→ `AssertionError: Node 注册表方法面应为 167，实际 0`，`0 !== 167`，**rc=1 FAIL**。临时副本运行后已清理，仓库无残留 | PASS | 12/12（server-gates 聚合门含本门）、51/116/167 零差集 |
| I12 | 签名门 167 键断言 + golden 注释/下界同步（A3 锚点） | `server/test/contract-signatures.mjs:23-29`；`server/test/contract-golden.mjs:14,44-46` | HEAD 版 `contract-signatures.mjs:28` 仅比对 `mismatches`，注入 `{}` 时恒真空 → 假 PASS；`contract-golden.mjs:14` 注释「50 个公开方法」、`:44` `>=40` 与实测 51 漂移（A3 硬锚点） | 加 `assert.equal(Object.keys(node).length,167)`、`assert.equal(Object.keys(legacy).length,167)`。**正样本**：`node server/test/contract-signatures.mjs` → `ok:true, checked:167, mismatches:[]`，rc=0。**注入**（`node = {}`）→ `AssertionError: Node 签名表应为 167 键，实际 0`，**rc=1 FAIL**。golden 注释 50→51、`>=40` → `===51` 同步；`node server/test/contract-golden.mjs` → `order_identical:true, frozen_public_methods:51, node_public_methods:51, registered_methods:167`，rc=0 | PASS | 12/12、golden-replay 门、`method-surface.mjs:25,39,40` 的 116/51/167 硬锚点未动 |

### 1.1b 批次 T03 逐轮表（I13–I18，2026-11-12 实测，主理人正式派发）

> 本批次门禁数由 12→13（第 13 门）、CANONICAL 16→17、断言数保持 82。**回退兜底未触发**：首轮即同时收敛 13/13 + 82/82 + 契约差分零漂移，按裁决 1 无需撤销接入。
> 主理人裁决：I14 统一走 `generatedAt`（不做条件分支）、放**独立 meta 文件**（修正派单「写进 audit 产物本体」）、容差 10 分钟、判据抽成可导出纯函数、跨成员信息经主理人中转。

| 轮次 | 主题 | 改动文件:行号 | 改动前证据 | 改动后验收命令 + 观察值 + rc | 结论 | 门禁 |
|---|---|---|---|---|---|---|
| I13 | 第 13 门接入 + verdict 动态化 + A2/A5 同批同步 | `tools/post_deletion_audit.py:1-40`（docstring/META_OUT/import）、`:295-416`（`BLOCKING_DEAD_KIND`、`find_blocking_defects()`、`build_verdict()`、`write_freshness_meta()`、`main()`）、`:190`（`sorted(DELETED)` 幂等修）；`tools/run_normalized_gates.py:36-39`（GATES 第 2 项）；`tools/gate_coverage.py:34-42`（CANONICAL 17）；`.github/workflows/harbor-ci.yml:62-65`（注释）；`frontend/app/tests/arch-contract.mjs:644-665`（A2 动态化）；`tests/test_ci_tooling.py:112-131`（门禁数动态断言） | HEAD 版 `post_deletion_audit.py:303` 硬编码 `realDefectsFound:1`、`:306` 固定 6 个 `fixedFiles`、`:339` 恒 `return 0`；`arch-contract.mjs:647-648` 硬断言 `===1` 与 `.length===6`；统一入口 GATES=11（grep 实测）+ 1 聚合门 = 12；CANONICAL=16 | `verdict` 改由本次扫描动态生成（`realDefectsFound`=运行时配置类真问题数、`fixedFiles`=本次守卫合规 stub、`dynamic:true`、`basis` 明细）；`main()` 仅 `backend-in-runtime-config` 判红，**staleDocs=8 / exact-deleted-path=53 登记项不阻塞**；第 13 门按裁决插在 `gate-coverage` 之后、`arch-contract` 之前（产物顺序实测 `['gate-coverage','post-deletion-audit','arch-contract',…]`）；A2 两断言改为「与本次扫描明细动态交叉校验」，不再依赖固定数字；A5 四处同批同步。**正样本**：`python tools/post_deletion_audit.py` → `verdict: realDefectsFound=0, fixedFiles=9, dynamic=True`，rc=0；`python tools/run_normalized_gates.py` → **13/13 PASS**，rc=0。**注入**（`build_verdict` 纯函数）：注入 1 条运行时配置类真问题 → `realDefectsFound=1`；注入 10× staleDocs → 仍 `0`（文档漂移不判红）；子进程 monkeypatch `scan_dead_refs` 并把产物重定向到系统临时目录 → `INJECTED_RC=1`。**R1 注入 A/B 在 17 项口径下**：A 旧 17/17 假 PASS → 新 `16/17 FAIL missing=['normalized-gate-entry']`；B 旧 17/17 文本恒真 → 新 `17/17 但 structuralErrors 点名 gate-file-missing, status=FAIL` | PASS | 13/13、17/17、82/82、契约差分零漂移、check_contract PASS |
| I14 | 产物新鲜度（generatedAt / 独立 meta / 可导出纯函数） | 新增 `frontend/app/tests/audit-freshness.mjs:1-38`（`AUDIT_FRESHNESS_TOLERANCE_MS=10min` + `isAuditFresh()`）；新增 `deliverables/dev-plan/post-deletion-audit-meta-r69.json`（`version/source/generatedAt`）；`tools/post_deletion_audit.py:355-368`（`write_freshness_meta()`）；`frontend/app/tests/arch-contract.mjs:22-30`（import + `AUDIT_FRESHNESS_TOLERANCE_MS=600000` 具名常量与理由注释）、`:644-656`（新鲜度判据并入现有 check） | 三份产物顶层键均无 `generatedAt`（只有 `generatedBy` 脚本名字符串）；`post_deletion_audit.py` 自身也未写；QA Round 1 实测 audit mtime 恒定 `23:59:21`，normalized/gate-cov/arch-metrics 被并发刷新到 00:27–00:29，差距在 3h54m→11m54s→29m37s 间漂移 → mtime 口径不可靠；`arch-contract.mjs:19` 已 import `statSync` 但 `:51/:69/:439` 全是 `isDirectory()/isFile()`，无 mtime 断言，I14 未实施时 82/82 不受影响 | 按裁决二：`generatedAt` 写**独立 meta**（不写 audit 产物本体），产物本体连跑 3 次 sha256 恒为 `979e257b…a73`（**字节幂等 PASS**，修复了 `DELETED` set 跨进程 hash 随机化导致的 `deadReferences.items` 顺序漂移）；`arch-contract` 校验 `generatedAt` 与 `Date.now()` 差 ≤10 分钟，容差写成具名常量并注释理由；判据**并入现有 check 保持断言数 82**（避免触发回退条件）。**纯函数单元级正反例**：`isAuditFresh(刚生成ISO)=true`、`陈旧1h=false`、`undefined=false`、`非法串=false`、`9m59s=true`、`10m01s=false`。**整体级沙箱反例**：在系统临时目录构造陈旧 `generatedAt` 内容副本 → `STALE_FRESH=false`，真实 meta 逐字未改（`未 touch 真实产物`）。正样本 = 统一入口跑完立即验 → `PASS 删除后审计可复跑且契约面零差集且产物新鲜 51/116/167 + generatedAt ≤ 10min` | PASS | 82/82、13/13；裁决二/三/四全部落实 |
| I15 | 门数口径：显式 `NON_GATE_SCRIPTS` + 产物 `excluded` | `tools/run_normalized_gates.py:68-77`（常量 + `server_gates()`）、`:104`（注释）、`:126-132`（results `excluded`）、`:139-144`（summary `excludedFromServerGates`） | HEAD 版 `server_gates()` 只硬排除 `auth-migrate.mjs`，实测 36；规格 §3 I15 写「→36」与现场矛盾（37 个 mjs，排除 `auth-migrate.mjs` 后 36，再排除 `node-sqlite-probe.mjs` 应为 **35**）；主理人派单要求「先实测再定预期值，不要盲从规格数字」 | 实测：`ls server/test/*.mjs`=37，`auth-migrate.mjs`/`node-sqlite-probe.mjs` 均 EXISTS，`len(server_gates())` 旧=36 → 建立显式常量后 **35**（不盲从 36）；产物 `summary.serverGates=35`、`summary.excludedFromServerGates=['auth-migrate.mjs','node-sqlite-probe.mjs']`、`results[server-gates].excluded` 同值；`python -c "…print(len(g.server_gates()))"` → 35，rc=0；产物 `summary.total=13`（GATES 具名 12 + 聚合 1） | PASS | 13/13（server-gates 聚合门全绿、35 门 0 FAIL）；17/17 |
| I16 | `--strict` 死参数修复（同文件串行） | `tools/check_static_paths.py:1-9`（docstring）、`:98-117`（`main()` 的 `ok` 判定与 report） | QA 实测 `findings=0` 时只跑 `--strict` rc=0 假通过；构造非空 findings 后「非 strict rc=1 / strict rc=1」无分叉。本轮改动前实测：`findings=1`（`tools/post_deletion_audit.py:104` 的 `backend/services/provenance.py` 正则字面，`backend-services` 类），非 strict `rc=1`、`ok:false, strict:false`；strict `rc=1`、`ok:false, strict:true`——`ok` 计算恒纳入 findings，`--strict` 确为死参数 | 明确语义：非 strict 时 legacy findings 只登记不进 `ok`；strict 时纳入；运行时配置类 `deleted-contract-path` 属真问题两模式都阻塞。**验收**：`--json` → `非strict rc=0, ok:true, strict:false, legacy_count=1`；`--strict --json` → `rc=1, ok:false, strict:true, legacy_count=1`——**分叉成立**（改动前 1/1 无分叉）。正反例均在真实现场（findings 天然非空）与沙箱假配置根下各跑一遍 | PASS | 非门禁脚本，不影响 13/13；`--strict --json` rc=1 符合规格验收 |
| I17 | 扫描面 8 目录 + 删 2 条死豁免 + 已删契约层路径正则（同文件串行） | `tools/check_static_paths.py:10-30`（`SCAN_DIRS` 8 目录、`DELETED_CONTRACT_PATH` 支持多层 domains、`RUNTIME_CONFIG_FILES`）、`:37-55`（`iter_source_files` 补 `.yml/.yaml`）、`:57-90`（`find_legacy_references` 删整文件豁免/保留行级豁免/仅运行时配置类报错） | HEAD 版 `SCAN_DIRS=('backend','frontend','tests','tools','installer')` 仅 5 目录；`:44-46` 有 2 条指向已删测试的整文件豁免（`tests/test_modern_build.py`、`tests/test_modern_backend_architecture.py`，实测均 MISSING）；`tests/test_v19_browser.py` 亦 MISSING；无「已删契约层路径」正则 | 加 `electron`/`server`/`.github` 共 **8 目录**（产物新增 `scan_dirs` 字段留痕）；删规格点名的 2 条整文件死豁免（按最小改动**保留** `:52-54` 的 `test_v19_browser.py` 行级豁免，规格未点名）；新增正则 `backend/api.py` 与 `backend/domains/**/*.py`，**仅 RUNTIME_CONFIG_FILES 报错**。`--json` → `scan_dirs` 8 项；**沙箱假配置行注入**：`Harbor.spec` 写入 `backend/api.py` + `backend/domains/settings/config_service.py` → 命中 2 条 `deleted-contract-path` 且 `runtimeConfig=true`，非配置类 `tools/note.py` 同字面**不报错**（命中数仍 2），两模式 rc=1；真实现场 `deleted_contract_path_count=0`、非 strict rc=0 | PASS | 非门禁脚本；I16/I17 同文件串行、同批复验 |
| I18 | CI 断言：非注释行命中 / normalized-gates job / 3 job 覆盖 | `tests/test_ci_tooling.py:22-32`（`_active_text()`）、`:89-131`（3 个测试） | HEAD 版 `test_workflow_calls_both_tools` 用全文包含（注释亦命中）；`test_workflow_yaml_parses` 只覆盖 `{'gate','entry-sweep'}` 2 个 job，`normalized-gates` 缺失；无门禁数断言；CI YAML 行号已因 I05 由 L83→**L84** 漂移 | `_active_text()` 剥离整行 `#` 注释，文本包含改「非注释行命中」；新增 `test_workflow_normalized_gates_runs_entry`（内容锚点 `assert anchor in src`，**不用行号**，并自检注释行不命中）；新增 `test_normalized_gate_count_is_dynamic`（动态读数，不硬编码 12/13/16/17，校验第 13 门存在 + CANONICAL 同步 + token 在 GATES 命中）；`test_workflow_yaml_parses` 覆盖 **3 个 job** 且 PyYAML 不可用分支同步 3 项。**验收**：`pytest tests/test_ci_tooling.py -q` → `8 passed in 1.21s`，rc=0。**反例**（沙箱工程副本）：删除 `run: python tools/run_normalized_gates.py` 整行 → 定向用例 `1 failed`，rc=1；还原 → `1 passed`，rc=0；工作区未改 | PASS | pytest 8 passed；13/13、17/17 |

### 1.2 T03 追加：R1 注入在 CANONICAL=17 口径下的对照

| 注入 | 定义（内容锚点 + `assert anchor in src`，纯内存副本） | 改动前 | 改动后 | 结论 |
|---|---|---|---|---|
| 正样本（T03） | 未注入，CANONICAL 17 | 旧逻辑 17/17 PASS | 新逻辑 `17/17, status=PASS, missingGates=[], structuralErrors=0, parsedGates=12` | PASS |
| R1-A（I02，T03 复验） | 仅摘除 `run: python tools/run_normalized_gates.py` 行、保留注释 | 旧逻辑全文包含 → `17/17 PASS`（注释假覆盖） | 新逻辑 `covered=16/17, status=FAIL, missingGates=['normalized-gate-entry']` | 缺陷修复可证 |
| R1-B（I03，T03 复验） | GATES `'tools/gate_coverage.py'` → `tools/__MISSING_DIR__/gate_coverage.py`（保留 token 子串） | 旧逻辑文本包含 → `17/17 PASS`（读自身恒真自指涉） | 新逻辑文本层仍 17/17（正是恒真），`structuralCheck.errors=[{'gate':'gate-coverage','line':37,'kind':'gate-file-missing','detail':'门文件不存在: tools/__MISSING_DIR__/gate_coverage.py'}]` → `status=FAIL` | 缺陷修复可证 |

> 第 13 门新增 CANONICAL 项 `post-deletion-audit` 的 token `post_deletion_audit.py` 由 GATES 命中（实测 `token in entry_text = True`，非 CI_ONLY），I02 检查面不缺项；`gate_coverage.validate_gate_structure(parse_gates(entry))` 对全部 12 具名门 `errors=[]`。

### 1.3 T03 追加：R2 双向证据（I13 / I14 / I16 / I17 / I18）

| 轮 | 正样本（PASS） | 注入（FAIL） |
|---|---|---|
| I13 | `audit rc=0, realDefectsFound=0, dynamic=True, staleDocs=8 非阻塞` | 注入 1 条 `backend-in-runtime-config` → `realDefectsFound=1`、子进程 `INJECTED_RC=1`；注入 10× staleDocs → 仍 0（不误判红） |
| I14 | `isAuditFresh(刚生成ISO)=true`；arch-contract `82/82` | 陈旧 1h ISO → `false`；缺失/非法串 → `false`；沙箱陈旧 `generatedAt` 内容副本 → `STALE_FRESH=false`；`10m01s` → `false` |
| I16 | 非 strict `rc=0, strict:false` | strict 且 findings 非空 → `rc=1, strict:true`（改动前 1/1 无分叉） |
| I17 | 真实现场 `deleted_contract_path_count=0`、非 strict `rc=0` | 沙箱 `Harbor.spec` 含 `backend/api.py`/`backend/domains/**.py` → 命中 2 条、两模式 `rc=1`；非配置类同字面不报错 |
| I18 | `pytest tests/test_ci_tooling.py -q` → `8 passed` rc=0；还原 run: 行后定向用例 `1 passed` | 沙箱删除 `run: python tools/run_normalized_gates.py` → 定向用例 `1 failed` rc=1 |
| I15 | `len(server_gates())=35`、产物 `excluded` 2 项、`summary.total=13` | —（本轮为口径实测校准，无判红型反例；改动前 36 的漂移已如实登记） |

### 1.2 R1（主理人复核口径）精准注入对照汇总

| 注入 | 定义（锚点自检，纯内存副本） | 改动前 | 改动后 | 结论 |
|---|---|---|---|---|
| 正样本 | 未注入 | 旧逻辑 16/16 PASS | 新逻辑 `16/16, status=PASS, missingGates=[], structuralErrors=0` | PASS |
| R1-A（I02） | 仅摘除 `.github/workflows/harbor-ci.yml:84` 的 `run: python tools/run_normalized_gates.py`，保留 `:58` 注释里的 `run_normalized_gates.py`（`assert anchor in ci`） | 旧逻辑**全文包含** → 注释 token 仍命中 → `16/16 PASS`（假覆盖） | 新逻辑 → `covered=15/16, status=FAIL, missingGates=['normalized-gate-entry']` | 缺陷修复可证 |
| R1-B（I03） | GATES 第 34 行 `'tools/gate_coverage.py'` → `'tools/__MISSING_DIR__/gate_coverage.py'`，**保留 token 子串**（`assert anchor in entry`） | 旧逻辑**文本包含** → `16/16 PASS`（读自身恒真自指涉） | 新逻辑文本层仍 16/16（正是恒真），但解析式校验 `structuralCheck.errors` 具体点名 `tools/__MISSING_DIR__/gate_coverage.py 门文件不存在` → `status=FAIL` | 缺陷修复可证 |

> 注入均在 `gate_coverage.evaluate(ci_text, entry_text)` 纯函数上做内存副本，未写回工作区；锚点断言 `assert anchor in src` 保证注入确实命中目标行，避免「注入没生效却判绿」。

### 1.3 R2 三件套（I11 / I12）双向证据

| 门 | 正样本（167 时 PASS） | 注入（空集/空对象时 FAIL） |
|---|---|---|
| `contract-coverage.mjs` | `ok:true, legacy_methods:167, migrated:167, ghosts:0`，rc=0 | `listMethods` → `() => []`：`Node 注册表方法面应为 167，实际 0`，`0 !== 167`，rc=1 |
| `contract-signatures.mjs` | `ok:true, checked:167, mismatches:[]`，rc=0 | `node = {}`：`Node 签名表应为 167 键，实际 0`，rc=1 |
| `contract-golden.mjs` | `order_identical:true, frozen_public_methods:51, node_public_methods:51`，rc=0 | （同批同步注释 50→51、`>=40`→`===51`；A3 锚点 `method-surface.mjs:25,39,40` 未动） |

### 1.1c 批次 T04+T05 逐轮表（I19–I30，2026-11-12 实测，主理人正式派发）

> 门禁基线按 §6.1：统一入口 **13/13**、`gate_coverage` **17/17**、`arch-contract` **82/82**、`server_gates()=35`、`CANONICAL=17`、`method-surface` 51/116/167、契约差分 r68 零漂移、全量 pytest 478 passed / 2 skipped。**§6 优先级高于 §3 旧行号/旧数字**（I29 实测 deps 12 非 11；I15 `server_gates()` 35 非 36）。同文件串行：I24 先修算法 → I23 扩 SCOPE；I20→I21；I22↔I28 跨批串行。**I01–I18 逐轮表保持不动。**

| 轮次 | 主题 | 改动文件:行号 | 改动前证据 | 改动后验收命令 + 观察值 + rc | 结论 | 门禁 |
|---|---|---|---|---|---|---|
| I19 | `readJsonIfExists` 零行为变更 + 有界结构化 warnings（裁决 3） | `server/src/paths.js:54-95`（`readJsonWarnings`:54、`MAX_READ_WARNINGS=32`:57、`pushReadJsonWarning`:65/93、`return fallback`:43/77/95、JSDoc「不抛但留痕」:50/77/85）；新增 `server/test/paths-readjson.test.js`（4 用例） | HEAD 版 `catch:57` 静默吞掉一切异常，非 ENOENT / 非 SyntaxError 的 EACCES 等无任何留痕；无结构化 warnings | `node --test server/test/paths-readjson.test.js` → `# tests 4 # pass 4 # fail 0`，rc=0；**反例**：损坏 JSON 仍返回 `fallback`（零行为变更）、SyntaxError 不记 warning、模拟 `EACCES` → `warnings[0].code='EACCES'` 且含 `path`、连注 80 次 `warnings` 有界收敛在 **32**；`node server/test/method-surface.mjs` → `ok:true, nodeRegistered:167` | PASS | 13/13、167 零差集。`.js` 用例不进 `server_gates()` 的 `*.mjs` glob，35 门不退化 |
| I20 | `_latest_git_tag()` 三态 + TimeoutExpired 单独捕获（与 I21 串行） | `tools/check_release.py:53-80,134-137`（`no-tag`:63/80/134、`error`:64/71/73/75/137、`warning`:54/61/71/73/75/116、`TimeoutExpired`:70） | HEAD 版 `:69 except Exception: return ''` 把超时 / 命令失败一并吞成「[skip] 无 git tag（本地开发环境）」，故障被误报为正常 | `python tools/check_release.py --expect 1.9.0` → `发布纪律断言全过：VERSION=1.9.0 API_VERSION=v1.0.0 tag=1.8.0`，rc=0；**反例**：monkeypatch `subprocess.run` 抛 `TimeoutExpired` → `('', 'error', "[warning] git tag 查询超时（timeout=30s）…")`，`status='error'` 且 warning 非空，非 `[skip]` | PASS | check_release rc=0；非门禁脚本，不影响 13/13 |
| I21 | 缺陷正则修正 + spec 缺失无 traceback（与 I20 串行） | `tools/check_release.py:169-186`（新式正则 `r'datas[^\n]*node_modules'`:186、`isfile`:169/174、`R7 缺少…`:170/175） | 旧式 `r'datas[^\\n]*node_modules'` 用字面反斜杠-n，对构造样本判 **False**；`:154` 裸 `open()` 无 `isfile`，spec 缺失时抛 `Traceback FileNotFoundError`、rc=1 | 构造样本 `datas = [('n','node_modules')]`：旧式 **False** → 新式 **True**（真实 `Harbor.spec` 上两式均 False，故必须用构造样本，QA 实测）；源码含新式正则 + `isfile` 守卫 + `R7 缺少…`；`check_release --expect 1.9.0` rc=0 | PASS | check_release rc=0；契约差分零漂移 |
| I22 | `layer()` 读错误累计进 `scale.readErrors` + 幂等 | `tools/arch_assessment.py:26-58,133`（`READ_ERRORS` 缓冲、`scale.readErrors`:133） | HEAD 版 `except OSError:32 pass` 静默丢弃读错误，产物无 `readErrors` 字段 | 连跑 2 次 `architecture-metrics-r69.json` sha256 恒为 `2fef7c95…7400`（幂等 PASS）；产物 `scale.readErrors=[]`；注入不可读文件 → 非空（早期会话已验） | PASS | arch-assessment 门 13/13 内；产物字节幂等 |
| I23 | JSDoc 试点 SCOPE 1→4 文件 + 独立基线棘轮（**在 I24 之后**） | `tools/type_annotation_audit.py:28-29`（SCOPE 4 文件）；`server/src/{config,logger,runtime}.js`（纯注释级 JSDoc）；`type-annotation-baseline-r69.json`（`version=2`、18/18/100、7→18） | SCOPE 仅 `paths.js` 1 文件、7 符号；3 个短模块导出符号无紧邻 JSDoc | `python tools/type_annotation_audit.py` → `PASS 18/18 (100.0%) missing=[]`、`regressions=[]`；独立基线 `exportedSymbols=18 / annotatedSymbols=18 / coverage=100.0`；`node server/test/method-surface.mjs` → 167 零差集 | PASS | 13/13（type-annotation 门）、82/82（读 `18/18`）、167 |
| I24 | 用 `DOC_RE` 做紧邻块精确匹配 + 标签值非空 + `{type}` 括号配对（**先于 I23**） | `tools/type_annotation_audit.py:33-118`（`DOC_RE`:33、`_doc_is_well_formed`:41、`_required_tags`:62、`_adjacent_doc`:84、`audit`:114、`version=2`、产物 `algorithm` 字段） | `DOC_RE` 定义于 `:27` 后从未使用；旧判定对「符号前插普通注释 / 空标签值 / 花括号不配对」误判为已注解 | **四样本对照**：`adjacent=True` / `interleaved=False` / `novalue=False`（旧误判 True）/ `unbalanced=False`（旧误判 True），全部符合预期；**正样本**对 4 文件仍 `18/18 100%`（满足 §3.0 R2 三件套） | PASS | 13/13、82/82；I24→I23 顺序未颠倒，试点判红未发生 |
| I25 | AGENTS.md 改「冻结快照 + Node 运行时」口径（⚠ A1 最高风险） | `AGENTS.md:3,5,56,98,105,120`（顶部 R70 退役声明、§1/4/5 改写、`invoke('get_api_info')`、红线 1=冻结快照 + `method-surface.mjs` 167） | HEAD 版 §1/4/5 仍以 `from backend.api import Api`、Python 桌面壳、backend provenance 为口径；红线 4 含已删路径 | `node frontend/app/tests/arch-contract.mjs` → **82/82**（A1 正则 `:693` 仍命中）；`grep -c "## 2.3 R69 Agent 浏览器闭环" AGENTS.md` = **1**（标题字面量保留）；`grep "from backend.api import" AGENTS.md` **零命中**；§2.3 全部内容逐字保留（长度 1041 前后一致） | PASS | 82/82 不退化；A1 硬锚点守住 |
| I26 | README / 开发说明「只增不删」退役声明 + 历史链角标 | `README.md:3,96`；`开发说明.txt:3,16`（顶部 R70 退役声明 + 安装/打包段前角标） | 两文件顶部无退役声明，旧 pip / pywebview 安装段读作当前版本运行链；`开发说明.txt` 带 BOM | `head -20 README.md` 含 R70 退役声明；「历史链角标」在 `:96` / `:16`；原文 `pywebview`（`README.md:10`）等逐字保留；`python deliverables/design/check_contract.py` → UI 五大契约 PASS；`contract_diff --compare r68` 零漂移 | PASS | UI 五大契约、契约差分零漂移、13/13 |
| I27 | EXIT-PLAN / STEP5 只改标题与状态行 + 执行结果角标 | `frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md:1,4-8`；`deliverables/dev-plan/STEP5-DELETION-BOUNDARY.md:1` | HEAD 版标题「步骤 1–3 已执行」/「v2 · 待单独确认，本轮未执行」，状态行仍写「步骤 5 已执行」等删除前口径 | `grep -n "^#"` 两标题无「待确认/未执行」；EXIT-PLAN 标题改「步骤 1–6 已执行（步骤 5/6 见 STEP5…）」+ R70 执行结果角标；STEP5 标题改「v3 · 已执行，执行结果见 §0」；**§1-5 历史正文逐字一致**：EXIT-PLAN 122/122 行、STEP5 252/252 行，`BYTE-IDENTICAL=True`；5 个 `##` 章节头前后相同；「保留声明」仍在。**遗留：`scan_stale_docs()` 仍 7 条命中（其中 4 条在 EXIT-PLAN §1-5 保留正文），「不再命中/归零」未收敛 → 见 §3.5，按 QA 口径回传，不冒充完成** | PASS（标题/状态行/§1-5 保留/角标）+ **需人工复核**（staleDocs 子项） | 82/82、13/13、第 13 门 rc=0（归零注入复验，见 §3.5） |
| I28 | `ci_tokens` 对齐 gate_coverage + pythonContract retired + `:161` 过期文本（与 I22 跨批串行） | `tools/arch_assessment.py:70,78-79,97,104,184,195-198`；产物 `architecture-metrics-r69.json` | `ci_tokens` 缺 T03 新增的 `post_deletion_audit.py` 等；`pythonContract` 未标 retired；`:161` 残留 `'present (C path step 4 in progress)'` 删除前过期文本 | 检查面改为 `workflow + '\n' + entry_text` → 产物 `ci.detectedTokens=**17**` 与 `CANONICAL=17` **一一对齐**（含 `post_deletion_audit.py`）；`scale.layers.pythonContract.retired=True` + `contractFactSource`；`dualTrack.pythonContractLayer='retired (R69 删除后审计；契约事实源=冻结快照)'`；旧文本仅存在于说明性注释 `:195`（代码行零命中）；**`tests.serverRunnableGates:27` 历史数字按裁决 6 保留未改**；连跑 2 次 sha256 恒为 `2fef7c95…7400` | PASS | arch-assessment 门 13/13 内；82/82（读 `ci.detectedTokens`）、gate_coverage 17/17 |
| I29 | server deps 零死重：12 依赖命中文件证据 + 豁免登记（不删依赖） | `tests/test_api_surface_consistency.py:23,30,66-99`（`EXPECTED_SERVER_DEPS`、`ALLOWED_EXEMPTIONS`、`[dep-hit]`/`[dep-exempt]`） | 根 `package.json` 的 `dependencies={}` 使旧 `for name in deps` 恒真；`:54` 仍 glob `backend/**/*.py`（已删目录） | `pytest tests/test_api_surface_consistency.py -q -s` → `3 passed`；**实测 12 个 deps**（规格写 11，以实测为准），逐个输出 `[dep-hit]` 命中文件（11 项，如 `kysely → server/src/auth.js`）+ `[dep-exempt] @prisma/client`（prisma generate 动态引用，登记豁免不删）；AST 核验 live glob 仅 2 个 `'**/*.js'`，**`backend/**/*.py` 零残留**（仅 docstring `:11` 说明文字）；**反例**：注入不存在依赖 `__QA_FAKE_DEP__` → `AssertionError: server 依赖集合漂移…`，rc 判红 | PASS | 定向 pytest 3 passed；不删任何依赖 |
| I30 | `electron/main.js` 三处纯注释级更新（conftest 由 I08 完成，不重复改） | `electron/main.js:15,16,43,44` | `:15 Node 24.22.1 ≥ 24.22`、`:28 先例=main.py GLM_CDP_PORT seam`、`:40 红线对位：main.py / backend/ Python 零改动` 三处删除前口径 | 改「实测 v22.22.2（CI node-version 22；engines ≥27 为未来基线口径，见 I04 裁决）」/「历史 seam，已退役」/「契约事实源=冻结快照」；`grep "Node 24.22.1"` 零命中、`main.py` 历史溯源措辞保留（在报告中说明）；`pytest tests/ -q` 收集期 0 errors、478 passed；`tests/conftest.py` 的「即将退役→已退役」已由 I08 完成，本轮 **未重复改、未误判为未完成** | PASS | 全量 pytest 478/2/0、13/13；零行为变更 |

### 1.2c T04+T05 追加：反例对照汇总（§3.0 R2 三件套）

> 所有注入均在内存 monkeypatch / 系统临时目录副本内做，`assert anchor in src` 自检，未写回工作区。

| 轮 | 正样本（改动后 PASS） | 注入（FAIL）/ 对照 |
|---|---|---|
| I19 | 损坏 JSON → `fallback`；node --test 4/4 rc=0 | 模拟 EACCES → `warnings` 非空且含 `code`/`path`；连注 80 次 `warnings` 有界 ≤32（未溢出）；SyntaxError 不记 warning |
| I20 | `check_release --expect 1.9.0` rc=0、tag=1.8.0 | `subprocess.run` 抛 `TimeoutExpired` → `status='error'` + 显式 `[warning]`，不退化成 `[skip]` |
| I21 | 构造样本新式正则 **True**；`check_release` rc=0 | 构造样本旧式正则 **False**（改动前恒真缺陷可证）；真实 `Harbor.spec` 两式均 False（QA 实测，故必须用构造样本） |
| I22 | 连跑 2 次产物 sha256 恒 `2fef7c95…7400` | 注入不可读文件 → `readErrors` 非空（非恒空） |
| I24 | 4 文件 `18/18 100%` | 四样本 `adjacent=True` / `interleaved=False` / `novalue=False` / `unbalanced=False`，后两类改动前均误判 True（有区分力）；`assert anchor in src` 10/10 |
| I27 动态断言 | 真实文档 2 用例 PASS | **6 类注入全 FAIL**：标题改回「步骤 1–3 已执行」/ 残留「待确认」/ 删 STEP5 交叉引用 / 删 R70 角标 / 删 §5 章节头 / STEP5 标题回退未执行 |
| I23 动态断言 | 真实产物 + 独立基线 2 用例 PASS | **8 类注入全 FAIL**：产物 exportedSymbols 回退 7 / annotated≠exported / 内嵌 baseline 回退 7 / SCOPE 缩减 1 文件 / 基线 =6 破棘轮 / 基线 SCOPE 不一致 / regressions 非空 / staticTypeCheck 伪造可用 |
| I29 | 12 deps 逐个 `[dep-hit]`/`[dep-exempt]`，3 passed | 注入不存在依赖 → `AssertionError: server 依赖集合漂移…` |
| I28 | `ci.detectedTokens=17 == CANONICAL=17`、产物幂等 | `:161` 过期文本在代码行零命中（AST：仅剩说明性注释 `:195`） |
| §6.3 联动 | `staleDocs=0` 注入 → arch-contract **82/82**、第 13 门 rc=0、13/13 不退化 | 同一归零场景注入 1 条 `backend-in-runtime-config` → 第 13 门 **rc=1**、`realDefectsFound=1`（判据未被削弱，非橡皮图章） |

## 2. 门禁回归汇总

| 阶段 | 统一入口 | 零差集 | arch-contract | 契约差分 | gate_coverage | pytest | 备注 |
|---|---|---|---|---|---|---|---|
| 迭代前 | 12/12 | 167 | 82/82 | 零漂移 | 16/16 | 待 QA 全量 | 基线 |
| T01+T02 收尾（I01–I12） | **12/12**（0 SKIP / 0 FAIL / serverGates=36 / nativeExitWarnings=0） | **51/116/167**，`missing=[] ghosts=[]` | **82/82** | **零漂移**（模块数 117→117、样式 14→14、漂移项「无」） | **16/16**（100.0%，`missingGates=[]`，`structuralErrors=0`，`parsedGates=11`） | 定向 `17 passed in 9.94s`；`pytest tests/ --collect-only` 478 collected / 0 errors | 全绿，与迭代前基线一致 |
| T03 收尾（I13–I18） | **13/13**（0 SKIP / 0 FAIL / serverGates=**35** / `excluded` 2 项 / nativeExitWarnings=0） | **51/116/167**，`missing=[] ghosts=[]` | **82/82**（断言数未退化，新鲜度判据并入现有 check） | **零漂移**（模块数 117→117、样式 14→14、漂移项「无」） | **17/17**（100.0%，`missingGates=[]`，`structuralErrors=0`，`parsedGates=12`） | `pytest tests/test_ci_tooling.py -q` → `8 passed in 1.21s` | **回退兜底未触发**：首轮即收敛 13/13 + 82/82 + 零漂移；check_contract UI 五大契约 PASS |
| **T04+T05 收尾（I19–I30）** | **13/13**（0 SKIP / 0 FAIL / serverGates=35 / `excluded` 2 项） | **51/116/167**，`missing=[] ghosts=[]` | **82/82**（`staleDocs=0` 注入复验仍 82/82） | **零漂移**（模块数 117→117、样式 14→14、漂移项「无」） | **17/17**（100.0%，`missingGates=[]`，`structuralErrors=0`，`parsedGates=12`） | **全量 `pytest tests/ -q` → 478 passed / 2 skipped / 0 failed**（227.27s，rc=0；I14 session fixture 自动刷新 meta，无需人工预刷新） | `check_contract.py` UI 五大契约 PASS；`type_annotation_audit.py` **18/18 100%**；`git diff -- config.json` 空；§6.3 联动三层复验全绿，产物 sha256 逐字恢复。**首轮全量 pytest 曾判 2 FAIL（pytest 侧陈旧硬断言），已按 §3.3 口径修复，见 §3.5** |

**T03 收尾全套命令与 stdout 关键结论**：`contract_diff.py --compare contract-baseline-r68.json` →「结论: **零漂移 PASS** / 漂移项: 无」，rc=0；`node server/test/method-surface.mjs` → `publicMethods:51, hiddenMethods:116, nodeRegistered:167, missingInNode:[], ghostsInNode:[]`，rc=0；`node frontend/app/tests/arch-contract.mjs` → `[arch-contract] 82/82 通过`，rc=0；`python tools/run_normalized_gates.py` → `[normalized-gates] 13/13 PASS, 0 SKIP, FAIL=[]`，rc=0；`python tools/gate_coverage.py` → `[gate-coverage] PASS 17/17 (100.0%) missing=[] structuralErrors=0`，rc=0；`python deliverables/design/check_contract.py` → `结果: PASS — 五大契约全部保住（manifest: 117 JS / 14 CSS）`，rc=0；`pytest tests/test_ci_tooling.py -q` → `8 passed`，rc=0；`git diff -- config.json` → 空（零污染）。

## 3. 已知取舍与阻塞（如实登记）

- TypeScript / tsc / 代码覆盖率工具无外网不可用 → `staticTypeCheck=blocked-by-environment`，`codeCoverage.status=blocked-by-environment`（产物逐字保留），JSDoc 覆盖率不等于静态类型检查、gate-coverage 不等于代码覆盖率，**不伪造**。
- 真机 `dist/Harbor.exe` 复验由用户提供截图，本轮不主动启动 exe。
- 删除类动作须用户单独授权，本轮不做；`requirements-win.txt` 原 13 条依赖**一条未删**，仅追加顶部退役标注。
- 推送维持本地（R60 口径）。
- **I04 为零代码改动审计结论**：`node v22.22.2` / CI `node-version:'22'` / `engines >=27.0.0-alpha.0.0.0` 三者不一致，判断为「未来基线声明」，按主理人裁决**不改配置**（避免影响 `npm ci` engine-strict），由 I30 在 `electron/main.js` 注释引用口径。
- **门禁总数未变**：统一入口仍 12/12（GATES 仍 11 项 + 1 聚合门）、`gate_coverage.py` CANONICAL 仍 16 项、`arch-contract.mjs` 断言数仍 82；I13（第 13 门）不在本批次，未动 `verdict`（`realDefectsFound=1`、`fixedFiles=6` 保留）。
- **产物自动刷新（非手改）**：`gate-coverage-r69.json` / `normalized-gates-r69.json` / `post-deletion-audit-r69.json` / `architecture-metrics-r69.json` 为跑门禁时的正常产物刷新。其中 `architecture-metrics-r69.json` 仅 `tools.lines 9698→9987`、`pytest.lines 14332→14335`（源码行数变动导致），`totalSourceLines=44544` 等其余字段不变；已验证连跑 3 次 sha256 恒为 `d53b6b9a…c53efc`（幂等）。`serverRunnableGates:27` 为**历史原文数字**，按 §0 裁决 6「历史原文保留不改」不动，I28（T05）才处理。
- **I08 与 I30 的 conftest 重叠**：本批次仅做 I08 部分（4 处 import 降级 + docstring「即将退役」→「已退役」）；I30 由 T05 派发时处理，本轮未提前执行。`conftest.py:5,262` 两处「不再 import backend」为说明性文字，AST 层面运行时 backend import 为 0，符合 §3 I08「零运行时命中」口径。
- **I10 判据预置**：活跃入口文档（AGENTS.md / README.md / 开发说明.txt / PYTHON-CONTRACT-EXIT-PLAN.md）本批次只被 `scan_stale_docs()` 判为陈旧（8 条命中），**未改其原文**；补退役声明/角标属 T05 I25/I26/I27，本轮未执行。
- **未执行 / 回退 / 需人工复核**：I01–I12 **全部 PASS，无回退、无未验证轮次**。I13–I30（T03/T04/T05）**未执行**（主理人尚未派发）。需人工复核项：① I04 的 engines 漂移是否需要在未来版本基线中正式收口（本轮裁决不改）；② I10 命中 4 个活跃入口文档的 8 条 `staleDocs` 属预期，T05 补声明后按 I27 验收应「不再命中」。
- **主理人独立复核（不采信汇报）**：00:1x 复跑统一入口 12/12（0 SKIP / 0 nativeExitWarnings）、`method-surface` 167 双向零差集、`arch-contract` 82/82、`gate-coverage` 16/16（`structuralErrors=0`）、`contract_diff --compare r68` 漂移项「无」、`git diff -- config.json` 空；抽查 `gate_coverage.py:125` 确有 `ast.parse(GATES)`、`post_deletion_audit.py:57` 后缀白名单含 `.txt` 且 `:79` 显式纳入 `开发说明.txt`、两个契约门确有 `===167` 下界断言、4 个文件的运行时 `from backend` import 清零（仅余说明性文字）。台账 §1 经脚本核验 `ids=[I01..I12]` 共 12 行。
- **串行派发约束（主理人决策，2026-11-12）**：QA 正式验收对象包含 `gate_coverage.py`、`.github/workflows/harbor-ci.yml`、`post_deletion_audit.py`、`check_release.py`、`tests/conftest.py`，而 T03（I13–I18）与 T05（I25/I26/I27）恰好要改这些文件；尤其 I10 的 `staleDocs=8` 命中 4 个活跃入口文档，I25/I26/I27 正是要给这些文档补退役声明。**在 QA 第 1 轮回传前不派发任何后续实现批次**，避免并发污染验收对象（QA 矩阵 R3 同源风险）。此为编排决策，非阻塞。
- **产物新旧方向（QA Round 1 复核，更正主理人此前误判）**：审计产物**始终早于**统一入口产物，方向并未反转。实测三个时点：`19:02:14 / 22:56:20`（差 3h54m）、`23:59:21 / 00:11:15`（11m54s）、`23:59:21 / 00:28:58`（29m37s，QA 未运行 `post_deletion_audit.py` 故其 mtime 恒定，而 G4/G5/arch-assessment 刷新了另外三份）。主理人此前所述「方向相反」为误判，实为「差距大幅缩小 + 其余产物被并发重跑刷新」，**特此更正**。这直接印证矩阵 R3：mtime 口径的新鲜度断言随「谁最后跑门」漂移。I14 实施时须先读实现确定口径（mtime 还是 `generatedAt`）；若走 `generatedAt`，`touch` 反例根本无效、须改注入旧内容副本，且一律在沙箱内做 + `os.utime` 精确恢复。
- **QA Round 1 正式验收（2026-11-12）**：I01–I12 **12/12 PASS**、契约回归 G1–G9 **9/9 PASS**、源码 Bug 0 项、FAIL 复现包无；全量 `pytest tests/ -q` = **476 passed / 2 skipped / 0 failed**（233.59s，rc=0）。R1 两个精准注入由 `git show HEAD:tools/gate_coverage.py` 取得旧实现并用 `exec` 加载对照（零落盘）：注入 A 旧 16/16 假 PASS → 新 `FAIL 15/16, missing=['normalized-gate-entry']`；注入 B 旧 16/16 自指涉假绿 → 新 `structuralErrors=1, kind=gate-file-missing`。QA 主动披露一次自身用例 Bug 并按路由自修（G7 判定脚本曾要求正则命中 `0 failed`，而 pytest 全过输出不打印该字段），未回传工程师、未构成正式 FAIL。Round 1 完成即退出，未消耗 Round 2。**串行派发约束自 QA 回传起解除。**
- **口径补记（QA §9 脚注）**：注入 B 的 `missingGates=[]` 属预期——它刻意保留 token 子串，文本包含必然仍 16/16，FAIL 来自 I03 结构层 `structuralCheck.errors`。强求 `missing` 非空会破坏注入精度、退回无区分力反例。此差别属 I02（文本层）与 I03（结构层）的本质区分，如实登记不伪造、不放宽判据。

### 3.1 T03 追加取舍（2026-11-12；上方 §3 条目为 T01+T02 阶段历史原文，保留不改）

- **上方「门禁总数未变 / I13 不在本批次 / verdict 未动」等条目均为 T01+T02 阶段口径**；T03 经主理人裁决 1 正式授权后，门禁数已由 12→13、CANONICAL 16→17、verdict 已动态化（A2 两断言同步改为动态读数）。此为**阶段演进**，非对历史记录的改写。
- **回退兜底未触发（如实登记）**：I13 首轮即同时收敛「统一入口 13/13 + arch-contract 82/82 + 契约差分零漂移」，无需撤销第 13 门接入；未放宽任何判据、未改引擎行为、未伪造通过。因此裁决三的「回退路径在 CI 加 `run: python tools/post_deletion_audit.py` 辅助行」**本批次未执行**——I13 成功接入时按裁决不需该行；若未来回退，须补该行以保证 meta 不陈旧。
- **I14 口径（主理人裁决，授权痕迹留存供 QA 判据①核查）**：裁决一「统一走 `generatedAt`，不做条件分支」；裁决二「`generatedAt` 放**独立 meta 文件** `deliverables/dev-plan/post-deletion-audit-meta-r69.json`，不写进 audit 产物本体」——这是**主理人明确授权新增该文件**的痕迹，规格 §0 裁决 4 未列明的新授权面由本裁决覆盖；裁决三「容差 10 分钟 + 具名常量 `AUDIT_FRESHNESS_TOLERANCE_MS` + 可导出纯函数 `isAuditFresh()`」；裁决四「跨成员信息经主理人中转」——本批次工程师未直连 QA，全部经 team-lead。新增 `frontend/app/tests/audit-freshness.mjs` 为裁决三「可导出纯函数」的落地文件（`.mjs` 不在 `server_gates()` 的 glob、不进 GATES/CANONICAL，门禁总数实测未受影响）。
- **裁决二引出的幂等缺陷（本轮发现并修复，如实登记）**：`post_deletion_audit.py` 的 `DELETED = set(...)` 跨进程 hash 随机化使 `deadReferences.items` 顺序漂移，audit 产物连跑 3 次 sha256 各不相同（首次实测 `a733b6…`/`7ab596…`/`61b831…`，`byKind` 与 items 集合完全相同、仅顺序不同）。修为 `for target in sorted(DELETED)` 后连跑 3 次 sha256 恒为 `979e257b…a73`，**字节幂等 PASS**；产物本体无 `generatedAt` 字段，`version` 由 1→2、`ensure_ascii=False, indent=2` 保持。此修复属 I13 范围（裁决二要求产物本体幂等），未放宽任何判据。
- **I15 预期值实测校准**：规格 §3 I15 写「`len(server_gates())` → 36」与现场矛盾；实测 `server/test/*.mjs`=37，排除 `auth-migrate.mjs` 后 36，再排除 `node-sqlite-probe.mjs` 后 **35**。按主理人派单「先实测再定预期值，不要盲从规格数字」定为 35 并写入产物 `excluded`；`serverGates` 由 36→35，`architecture-metrics-r69.json` 的 `serverRunnableGates:27` 仍为历史原文数字、未改（留 I28）。
- **I13 阻塞性判定口径**：`staleDocs=8`（4 个活跃入口文档的过时措辞）与 `exact-deleted-path=53` 均为**文档漂移/历史引用登记项，不阻塞**；只有 `deadReferences` 中 `backend-in-runtime-config` 运行时配置类引用才使 `main()` 返回 1。已用「注入 10× staleDocs 仍 `realDefectsFound=0`」与「注入 1 条真问题 → rc=1」双向验证。T05 I25/I26/I27 补退役声明后 `staleDocs` 应归零，届时第 13 门仍不应判红。
- **本地单独跑 arch-contract 的新约束（裁决三要求登记）**：I13 成功接入时 audit 是第 13 门，统一入口每轮都刷新 meta，故「先跑统一入口再验」在 10 分钟内 PASS；**本地单独跑 `node frontend/app/tests/arch-contract.mjs` 前须先跑 `python tools/post_deletion_audit.py`** 刷新 meta，否则新鲜度判据会因陈旧而判红。AGENTS.md 的说明可留到 T05 I25 一并补。
- **I17 最小改动边界**：规格只点名删 2 条整文件死豁免（`tests/test_modern_build.py`、`tests/test_modern_backend_architecture.py`），故**保留** `tests/test_v19_browser.py` 的行级豁免（虽该文件亦已删，但规格未点名，按最小改动不扩权）；`iter_source_files` 补 `.yml/.yaml` 后缀是为让新增 `.github` 扫描目录真正生效。
- **I14 断言数保持 82**：新鲜度判据**并入**现有「删除后审计可复跑且契约面零差集」check，未新增 check 条目，避免触发裁决 1 的「82/82 全绿」回退条件；纯函数 `isAuditFresh` 供 QA 做单元级反例，无需复制整棵工程树、不污染工作区。
- **I16/I17 非门禁脚本**：`tools/check_static_paths.py` 不在统一入口 GATES 也不在 CANONICAL，`--strict` 分叉语义修正不影响 13/13；`--strict --json` 在真实现场 findings 非空时 rc=1（符合规格 I16 验收），不加 `--strict` rc=0。
- **未执行 / 回退 / 需人工复核（T03）**：I13–I18 **全部 6 轮 PASS，无回退、无未验证轮次**；T04+T05（I19–I30）**未执行**（主理人明确 T04+T05 暂不开始）。需人工复核项：① 裁决三的回退路径 CI 辅助行本批次未加（因 I13 成功接入），若后续 T03 复核决定回退须补；② 本地单独跑 arch-contract 前须先跑 audit 的新约束；③ I13 动态 verdict 在 T05 补退役声明、`staleDocs` 归零后的行为复验；④ I15 的 `serverRunnableGates:27` 历史数字留 I28 处理。
- **信息中转口径（裁决四）**：本批次工程师与 QA 之间的锚点清单、I14 判据、反例方式等一律经 team-lead 中转，未直连；QA 的验收矩阵由主理人同步，工程师未自行对齐口径。

### 3.2 最终口径复核（2026-11-12，主理人裁决条与派发单消息交叉后的追加核验）

> 主理人在 T03 完成回传**之后**又发出「最终口径确认 + 正式开工 T03」与「I15 门数实测修正」两条，与工程师完成回传属消息交叉。工程师**未重做代码**（避免重复落盘），而是重读规格四处并逐条核对已落盘实现，结论 **22/22 全部一致**。此节为追加角标，§3/§3.1 历史原文保留不改。

- **规格四处已重读**：`R70-IMPLEMENTATION-SPEC.md` §0 裁决 4（补充授权 `post-deletion-audit-meta-r69.json`，注明「应工程师不自行扩权请求」）、裁决 6（I15 后历史文档 37/27 门数字保留不改）、裁决 7（I14 统一 `generatedAt` + 独立 meta、不采纳条件分支）、裁决 8（跨成员信息经主理人中转）；§3 I14 已全文改写（ISO 8601 UTC `generatedAt`/`source`/`version=1`、`ensure_ascii=False, indent=2`、产物本体不新增字段保字节幂等、具名常量、纯函数、回退路径 CI 前置行、授权痕迹）；§3 I15 已标注「主理人 2026-11-12 实测修正，原 →36 作废」并改为 **35**。
- **最终口径 22 项逐条核对（全 PASS）**：meta 三字段齐 / `version=1` / `generatedAt` 以 `+00:00` 结尾且含 `T` / `indent=2`；audit 产物本体无 `generatedAt`（顶层 10 键）、`version=2`（结构变更递增）；`arch-contract.mjs` 有 `const AUDIT_FRESHNESS_TOLERANCE_MS = 10 * 60 * 1000` 且注释含「10 分钟 / 不用 mtime」；`audit-freshness.mjs` 导出 `isAuditFresh(generatedAt, now, toleranceMs)` 且函数体不读系统时钟；**无 mtime 条件分支**（`mtimeMs` / `statSync(post` 均不在 arch-contract 中）；`server_gates()=35`、`NON_GATE_SCRIPTS` 2 项；`GATES` 具名 12 + 聚合 1 = **13**；`CANONICAL=17`；产物 `summary.total=13` 与 `serverGates=35` **分离记录不混淆**；`results[server-gates].excluded` 2 脚本；规格 §0 裁决 4 与台账 §3.1 均有授权痕迹；回退未触发故 CI 前置 audit 行 **0 处**。
- **I15 两种门数分别登记（按主理人第二条要求）**：① `GATES` 具名门 11→12、聚合门恒 1、统一入口总数 12→**13**（I13 接入）；② `serverGates` 是聚合门**内部遍历数**，36→**35**（I15 排除探针），两者相互独立，已在 §1.1b I13 / I15 两行与 §2 回归行分别记录。`node-sqlite-probe.mjs` 实测为 440 B SQLite 可用性探针、确在旧门禁列表内，与 `auth-migrate.mjs` 一并列入 `NON_GATE_SCRIPTS`。
- **QA 新增两条验收判据的沙箱自验（主理人第二条特别提示）**：构造「回退路径」CI 副本，在 `run: python tools/run_normalized_gates.py` 之前插入辅助行 `run: python tools/post_deletion_audit.py`（纯内存，未写回工作区）。结果：① `CANONICAL` 仍 17 项、`covered=17/17`、`status=PASS` → 辅助行**未被误计为 CANONICAL 门禁**；② 再叠加 R1-A 注入（摘除统一入口 run: 行、保留注释）→ `covered=16/17, status=FAIL, missing=['normalized-gate-entry']` → **注释命中反例仍稳定判红**；③ `GATES` 具名 12、聚合 1、总数 13 不变 → 辅助行不进 GATES、不改变门禁总数。即**即便未来触发回退并按裁决 4 补该行，两条新增判据均成立**；本批次首轮收敛未回退，故该行实际不存在（CI YAML 中计数 0）。
- **裁决 8 遵守**：本批次所有跨成员信息（I14 口径、锚点清单、反例方式、I15 实测）均经 team-lead 中转，工程师未与 QA 直连；本节的口径核对亦仅回报主理人。

- **QA T03 Round 1 判 FAIL 并停测（2026-11-12，如实登记，不掩盖）**：G7 全量 `pytest tests/ -q` = `1 failed, 477 passed, 2 skipped`（rc=1，231.86s）。失败用例 `tests/test_r68_arch_contract.py::test_retired_stubs_do_not_crash`，断言 `:357` `assert audit['verdict']['realDefectsFound'] == 1` 得 `assert 0 == 1`。根因：I13 把 verdict 动态化后，当前无 `backend-in-runtime-config` 真问题（`deadReferences.byKind={'exact-deleted-path':55}`），正确值为 **0**；该 pytest 文件**不在 T03 改动清单**（`git diff --name-only` 为空），是历史硬编码未同步。**责任归属：A2 锚点同步只覆盖 `frontend/app/tests/arch-contract.mjs:672-679`，遗漏 pytest 侧；主理人独立核验只跑门禁未跑全量 pytest，亦未发现，由 QA 补上。** 路由 = Engineer（仓库测试资产 Bug），QA 不自改、不停测后续判据、不套用 §7 环境性偶发（确定性 `0==1`，与负载无关）。G1–G6 / G8 / G9 全部 PASS（13/13、17/17、82/82、167、零漂移、UI 五大契约、禁区零命中）；I14 授权痕迹已查到；回退辅助行标「不适用」。**Round 1 因源码 Bug 停止，待工程师修复后进入 Round 2（最多 2 轮硬上限）**。
- **QA T03 Round 1 未执行项（停测，不冒充 PASS）**：I13 动态 verdict 三态反例、A2 锚点同步专项、R1-A/B 在 17 项 CANONICAL 复验、I14 `isAuditFresh` 单元级与沙箱整体级反例、I16 分叉、I17、I18 沙箱副本、**顺带幂等修复的连跑 3 次 sha256 独立复核**——全部待 Round 2 补做。

### 3.3 QA T03 Round 1 FAIL 修复（2026-11-12，Engineer 最小修复）

> 主理人中转 QA 复现包 → 工程师单点修复。只改 `tests/test_r68_arch_contract.py:357` 一处，**不动 T04+T05**、不改引擎行为、不放宽判据、不删断言、未与 QA 直连（裁决 8）。I01–I18 逐轮表保持不动。

**复现包（工程师已独立复跑确认，非 QA 用例 Bug / 非环境偶发）**：`PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python -m pytest tests/test_r68_arch_contract.py::test_retired_stubs_do_not_crash -q` → `rc=1`、`1 failed in 2.46s`、`tests\test_r68_arch_contract.py:357: AssertionError  assert 0 == 1`。全量 G7 当时为 `1 failed, 477 passed, 2 skipped`。产物实测 `byKind={'exact-deleted-path':55}`（无 `backend-in-runtime-config`）、`realDefectsFound=0`、`dynamic=True`、`fixedFiles=9`、合规 stub 数 9。

**根因归属**：A2 锚点同步只覆盖 Node 侧（`arch-contract.mjs:668-680` 已动态化），遗漏 pytest 侧；I13 把 verdict 由本次扫描动态生成后，`:357` 的 `==1` 是 R69 删除后审计的历史硬编码残留。该文件不在 T03 改动清单（`git diff --name-only` 为空）。**正确值就是 0，不是把 1 改小、也不是放宽判据**。

**修复内容（`tests/test_r68_arch_contract.py:357-373`，与 Node 侧口径逐条对齐）**：单值硬断言改为「与本次扫描明细交叉校验」——`verdict['dynamic'] is True`；`isinstance(verdict['realDefectsFound'], int)`；**`verdict['realDefectsFound'] == by_kind.get('backend-in-runtime-config', 0)`**（关键：值等于本次扫描的阻塞类真问题数，不依赖任何固定数字）；`isinstance(verdict['fixedFiles'], list)` 且 `len == 合规 stub 数`（由 `retiredStubs` 中 `exists && guardOk && usesDirectoryGuard is False` 动态计算，当前 9）；`verdict['basis']['staleDocsNonBlocking'] is True`。**保留**原 `:358-359` 的 `contractSurface.missing == []` / `ghosts == []` 两条断言。未改 `tools/post_deletion_audit.py` 的 verdict 生成逻辑、未改 `arch-contract.mjs`、未改 `:390` 的 `deepScan.verification.realDefectsFound == 2`（独立产物，QA 已确认不受影响）。`git diff` 显示该文件仅此一处改动。

**正反例证据（沙箱工程副本，注入不写回工作区）**：`assert anchor in src` 自检 6 条断言（4 新 + 2 保留）均在源码。沙箱复制完整 `tools/`（含 `fakes.py` 等 stub 依赖）+ `tests/conftest.py` + 产物 + 9 个 stub 后：正样本 `rc=0`；4 类篡改均判红——`realDefectsFound=1`（旧假值）→ `rc=1, AssertionError: assert 1 == 0`；`dynamic=False` → `rc=1`（:367）；`fixedFiles=[]` → `rc=1`（:371）；`staleDocsNonBlocking=False` → `rc=1`（:372）。真实产物逐字未改。证明新判据**非恒真**。
> 过程中两次沙箱失败已如实排查：首轮缺 `tools/diff/fakes.py`（`ModuleNotFoundError`，补齐 `tools/` 后消除）；次轮归类脚本把两条**注释文字**误判为断言，改用「剥离注释行」精确口径后结论成立。均非源码缺陷。

**全库同类硬编码扫描**：`grep -rn "realDefectsFound\|fixedFiles" tests/ tools/ frontend/app/tests/ deliverables/design/`（排除 pyc）共 18 处命中，剥离注释后代码行 15 处；其中对动态 verdict 的固定数字 1/6 断言 **0 处**。剩余 `test_r68_arch_contract.py:390` 与 `arch-contract.mjs:630` 的 `==2` 均属 `deep-scan-r69.json` 的 `verification.realDefectsFound==2` 独立产物，与 I13 无关，按指令不动。**无第三处遗漏**。

**⚠ 全量 pytest 首次复跑的一处时序发现（如实登记，非本次修复引入，影响 Round 2 验收顺序）**：修复后第一次直接跑 `pytest tests/ -q`（未先刷新 meta）得到 `1 failed, 477 passed, 2 skipped`——但失败用例**不是**已修复的 `test_retired_stubs_do_not_crash`，而是 `test_skeleton_manifest_is_complete_and_machine_checked`：它内部调用 `arch-contract.mjs`，当时读到**陈旧的独立 meta**（`generatedAt` 距运行时刻超过 10 分钟），新鲜度 check 判红 → `[arch-contract] 81/82` → `tests/test_r68_arch_contract.py:141` 断言 `rc==0` 失败。刷新 meta 后单独跑 arch-contract 立即恢复 `82/82`。这**不是代码缺陷**，是裁决三已登记的「本地单独跑 arch-contract 前须先跑 audit」约束在**全量 pytest 场景**的延伸：全量 pytest 耗时约 237s，只要在启动前刷新 meta（实测 delta=0.3s），全程都在 600s 容差内。按该约束执行 `python tools/post_deletion_audit.py`（rc=0，刷新 `generatedAt`）→ 紧接着 `pytest tests/ -q` → **`478 passed, 2 skipped in 236.80s`，0 failed / 无 FAILED 行 / rc=0**。**请 QA Round 2 在全量 pytest 前先跑一次 audit 或统一入口刷新 meta**，否则会复现这一时序性判红（与 QA 用例无关）。已同步主理人转达。

**收尾全套门禁（命令 + stdout 关键结论 + rc 全留痕）**：`pytest tests/test_r68_arch_contract.py::test_retired_stubs_do_not_crash -q` → `1 passed`，rc=0；`pytest tests/ -q`（按上述顺序）→ `478 passed, 2 skipped`，rc=0；`run_normalized_gates.py` → `13/13 PASS, 0 SKIP, FAIL=[]`，rc=0；`gate_coverage.py` → `PASS 17/17 (100.0%) missing=[] structuralErrors=0`，rc=0；`arch-contract.mjs` → `82/82 通过`，rc=0；`method-surface.mjs` → `ok:true, nodeRegistered:167`，rc=0；`contract_diff --compare r68` →「零漂移 PASS」，rc=0；`git diff -- config.json` → 空。禁改边界：`harbor.html`/`manifest.json`/`config.json`/`package.json`/`server/package.json`/`frozen-python-surface.json`/`contract-baseline-r68.json` 全部未触碰；本轮唯一源码改动为 `tests/test_r68_arch_contract.py`（全库 21 files changed, 918 insertions(+), 233 deletions(-)，其余均为前三批既有改动）。

**结论**：本次 FAIL 为单点历史硬编码残留，已按「与本次扫描明细交叉校验」收紧修复，判据强度不降反升，正反例、全库扫描、全量 pytest、全套门禁均通过。**IS_PASS: YES**（待 QA Round 2 复核；全量 pytest 前须先刷新 meta 的顺序约束已登记）。

- **主理人升级判断（2026-11-12，不掩盖）：I14 时序耦合是设计缺陷，不只是「已登记约束的延伸」**。工程师上报「全量 pytest 前须先刷新 meta」后，我核验 CI 执行链发现更严重的后果：
  - `tools/round_runner.py:139` 在 `--full` 时执行 `pytest tests/`；`tests/test_r68_arch_contract.py:140` 的 `test_skeleton_manifest_is_complete_and_machine_checked` **直接调用 `arch-contract.mjs`**；
  - `arch-contract.mjs:652-663` 的新鲜度 check 用 `isAuditFresh(meta.generatedAt, Date.now(), 600000)`，meta 缺失（→ `undefined`）或陈旧即判红，使该项变 81/82、用例断言 `rc==0` 失败；
  - `.github/workflows/harbor-ci.yml` 的 `gate` job 与 `normalized-gates` job **并行独立、无 `needs` 依赖**；meta 是运行产物且 **`git ls-files` 显示未被跟踪** → `gate` job 从干净 checkout 出发根本没有 meta，而能刷新 meta 的第 13 门在另一个独立 workspace，刷新结果传不过来。
  - 结论：**CI 的 `gate` job 会确定性判红**，且本地任何超过 10 分钟未刷新就跑全量 pytest（或单独跑 arch-contract）同样判红。根因是把「时间新鲜度」这个只在统一入口调用链里有意义、且已被第 13 门顺序保证覆盖的条件，嵌进了一个被 pytest 间接调用的通用架构门。
  - **裁决**：判据零放宽（10 分钟容差、`isAuditFresh` 纯函数、QA 全部 I14 反例保持有效），改为把前置刷新**自动化到 pytest 调用链**——在 `tests/conftest.py` 加 session 级 autouse fixture，会话开始时调用 `post_deletion_audit.py` 刷新 meta，rc 非 0 显式报错不静默吞掉。CI 两 job 无需改动、门禁数/CANONICAL 不变、meta 不需入库。单独跑 arch-contract 的约束继续在台账与 T05 I25 的 AGENTS.md 说明中登记。
  - 这是主理人裁决 I14 引入的设计缺陷，责任在我；工程师按「约束延伸」定性偏轻，已升级。T04+T05 继续暂缓，待 QA Round 2 通过。

### 3.4 I14 时序缺陷修复（主理人升级裁决，2026-11-12，Engineer 实施）

> 上方 §3.3 末尾的主理人升级判断为历史原文，保留不改。本节记录修复落地与 5 类验证证据。**判据零放宽**：不改 10 分钟容差、不改 `isAuditFresh` 纯函数、不改 `arch-contract.mjs`、不把 meta 加入 git、不动门禁数 / GATES / CANONICAL / `NON_GATE_SCRIPTS` / `server_gates()`；I01–I18 逐轮表保持不动；未启动 T04+T05；未与 QA 直连（裁决 8）。

**因果链（工程师独立只读复核，5 条全成立）**：① `tools/round_runner.py:139` `--full` → `pytest tests/`；② `tests/test_r68_arch_contract.py:140-142` 的 `test_skeleton_manifest_is_complete_and_machine_checked` 直接 `_run(ARCH)` 调用 `arch-contract.mjs` 并断言 `rc==0`；③ `arch-contract.mjs:657-658` 用 `isAuditFresh(auditMeta?.generatedAt, Date.now(), 600000)`，meta 缺失 → `undefined` → false → 该 check 判红、整体 81/82；④ `.github/workflows/harbor-ci.yml` 中 `needs:` 出现次数 = **0**，`gate`(L29) / `normalized-gates`(L57) / `entry-sweep`(L99) 三 job 并行独立，`gate` L49 跑 `round_runner.py --rounds 1 --full`；⑤ `git ls-files --error-unmatch deliverables/dev-plan/post-deletion-audit-meta-r69.json` → `NOT TRACKED`（干净 checkout 后不存在）。→ **CI gate job 确定性判红**，本地超过 10 分钟未刷新同样判红。

**修复内容（唯一源码改动 `tests/conftest.py:32-66`，净增 34 行 / 35 行块）**：新增 `@pytest.fixture(scope='session', autouse=True) def _refresh_post_deletion_audit_meta()`，会话开始时用 `subprocess.run([sys.executable, script], cwd=PROJECT_ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)` 调用一次 `tools/post_deletion_audit.py` 刷新 audit 产物与独立 meta。显式报错四路：脚本缺失 / `subprocess.TimeoutExpired` / `OSError` / `rc != 0` 一律 `pytest.fail`（共 4 处），透传子进程 stdout+stderr，**不静默吞掉、不降级 warning**。注释写明因果链与「判据零放宽、覆盖四条链、只写两个产物、不引入新第三方依赖」。用 `sys.executable` 绝对路径解释器、`cwd=PROJECT_ROOT`、显式 `timeout=120`。选择 session 级 autouse fixture（而非只改 CI 或只改 arch-contract）是因为它同时覆盖 `pytest tests/ -q`、定向 `pytest tests/test_xxx.py -q`、`round_runner --full`、CI `gate` job 四条链。

**验证证据 1（模拟 CI 干净 checkout）**：删除未跟踪 meta（删前 `generatedAt=2026-11-11T17:40:40.888808+00:00`、删后 `is_file()=False`），**不手动预刷新**直接 `pytest tests/test_r68_arch_contract.py -q` → `30 passed in 137.55s`，rc=0；运行后 meta 自动重建、`generatedAt=2026-11-11T17:50:25.689146+00:00`、delta=100.7s < 600s。证明 fixture 自动生成 meta、arch-contract 保持 82/82。

**验证证据 2（反例，防止 fixture 变橡皮图章）**：`assert anchor in src` 自检 5 个锚点（session autouse / 函数名 / `subprocess.TimeoutExpired` / `pytest.fail('[I14]` / `proc.returncode != 0`）全部命中。沙箱工程副本（复制 `conftest.py` + `helpers/state_reset.py` + 一个 dummy 测试，脚本替换为 stub，**未写回工作区**）：正样本 `sys.exit(0)` stub → pytest rc=0；反例 `sys.exit(1)` + stderr `[STUB] simulated rc=1 failure` stub → pytest **rc=1**，输出含 `pytest.fail('[I14] post_deletion_audit.py 返回 rc=%d，拒绝静默继续…'` 并透传 `STUB` stderr；还原 `sys.exit(0)` → rc=0。超时路径用静态锚点核验 `timeout=120` + `except subprocess.TimeoutExpired → pytest.fail`。反例 PASS：显式报错、pytest 判 FAIL、未静默吞掉。

**验证证据 3（核心判据：全量 pytest 不手动预刷新）**：删除 meta（`is_file()=False`）后**直接** `pytest tests/ -q` → `478 passed, 2 skipped in 251.70s`，**0 failed / 无 FAILED 行 / rc=0**；运行后 meta 由 fixture 生成、delta=113.1s < 600s。修复前该命令会因陈旧 meta 在 `test_skeleton_manifest_is_complete_and_machine_checked` 判红（81/82）。

**验证证据 4（全套回归）**：`run_normalized_gates.py` → `13/13 PASS, 0 SKIP, FAIL=[]` rc=0；`gate_coverage.py` → `PASS 17/17 (100.0%) missing=[] structuralErrors=0` rc=0；`arch-contract.mjs` → `82/82 通过` rc=0；`method-surface.mjs` → `ok:true, nodeRegistered:167` rc=0；`contract_diff --compare r68` →「零漂移 PASS」rc=0；`git diff -- config.json` → 空。**四条链额外实测**：`round_runner.py --rounds 1 --no-record`（CORE 子集）→ `round 1: green build=True passed=74 failed=0`、meta 自动生成；**CI gate job 确切命令** `round_runner.py --rounds 1 --full --no-record --label "CI"`（删 meta 后）→ `round 1: green build=True passed=478 failed=0 (234s)`、`greens: 1/1`、rc=0、meta 存在 delta=108.5s < 600s。→ 四条链全部覆盖。

**验证证据 5（增量清单 + 禁改边界）**：`git diff --stat` 全库 `21 files changed, 952 insertions(+), 232 deletions(-)`（上一轮 §3.3 登记时为 `21 files / 918 insertions / 233 deletions`），**净变化仅 `tests/conftest.py` 一处**（`43 insertions / 11 deletions` 含前批 I08 与本期 I14 两段；源码 mtime 按时间戳排序确认 conftest.py 为本轮唯一改动）。`harbor.html` / `frontend/react/src/generated/*` / `frontend/styles/` / `frontend/manifest.json`(styles=14) / `config.json` / `frozen-python-surface.json` / `contract-baseline-r68.json` / `package.json` engines 全部未触碰；`arch-contract.mjs` / `audit-freshness.mjs` / `post_deletion_audit.py` / `run_normalized_gates.py` / `gate_coverage.py` 本轮未动（其 diff 为 T01–T03 既有）。meta 仍 `NOT TRACKED`（未入库，符合裁决）。容差常量计数 1、`isAuditFresh(auditMeta?.generatedAt, Date.now()` 调用计数 1；`GATES=12` / `server_gates()=35` / `CANONICAL=17` / `NON_GATE_SCRIPTS=2` 全部未变。

**结论**：设计缺陷已按「把前置刷新自动化到 pytest 调用链」修复，判据零放宽、QA 全部 I14 反例原样有效，5 类验证证据齐备、四条链全覆盖。**IS_PASS: YES**（待 QA Round 2 复核；全量 pytest 前不再需要人工预刷新，此前的顺序约束已被 fixture 自动化取代）。

### 3.5 T04+T05 联动复验结论、取舍与遗留（2026-11-12）

> 本节为最后一批（I19–I30）收尾追加，§3/§3.1–§3.4 历史原文保留不改。

**（1）§6.3 强制联动复验 —— PASS（三层，产物逐字恢复）**。派发单要求「T05 收尾必须复验 `staleDocs` 归零后 I13 verdict 断言仍成立、第 13 门 rc=0、13/13 不退化」。以审计产物 `post-deletion-audit-r69.json`（基线 sha256 `a676841d…8d8`，`staleDocs=7`）为准做三层复验：
- **L1 verdict 纯函数**：`build_verdict(dead, stubs, stale=7)` 与 `stale=[]` 对照 → `realDefectsFound=0 / dynamic=True / staleDocsNonBlocking=True / fixedFiles=9` 逐字段**完全相同**，仅 `basis.staleDocs` 7→0。证明 I13 的全部断言字段与 staleDocs 数量无关。
- **L2 arch-contract 整体级**：把产物 `staleDocs` 注入为 `[]` 且 `basis.staleDocs=0`（`assert` 锚点自检）→ `node frontend/app/tests/arch-contract.mjs` → **rc=0 / 82/82 通过**，A2 动态交叉校验项 `PASS 删除后审计可复跑且契约面零差集且产物新鲜 51/116/167 + generatedAt ≤ 10min` 未判红。`finally` 逐字写回原始字节，复原 sha256 与基线**完全一致**（`byte-identical=True`）。
- **L3 第 13 门 `main()`**：系统临时目录内重定向 `OUT`/`META_OUT`、monkeypatch `scan_stale_docs=lambda: []` → 第 13 门 `rc=0`，产物 `staleDocs=0`、`verdict.dynamic=True / staleDocsNonBlocking=True / basis.staleDocs=0`。**反向对照**：同一归零场景注入 1 条 `backend-in-runtime-config` → **rc=1 / realDefectsFound=1**，证明判据未被削弱（非橡皮图章）。临时目录已 `rmtree` 清理，真实产物/meta 未污染。
- **结论**：`staleDocs` 归零后 verdict 断言成立、第 13 门 rc=0、13/13 不退化；最终态复跑 `run_normalized_gates.py` → 13/13、`gate_coverage.py` → 17/17、arch-contract → 82/82。**回退分支未触发，未改第 13 门、未放宽任何判据。**

**（2）`staleDocs` 现状与「不再命中/归零」未收敛 —— 如实登记，按 QA 口径回传，不冒充完成**。T02 I10 建立判据时 `staleDocs=8`；T05 收尾实测 **7**（用 `git show HEAD:` 的 4 个活跃入口文档 + 当前正则族重建 T02 = 8，当前 = 7，逐条吻合）。净减 1 条来自 I25 把 AGENTS.md §1 的 `backend/tools_schema.py` 改为冻结快照口径；EXIT-PLAN 标题行的 `步骤 1–3 已执行` 由 I27 改为 `步骤 1–6 已执行` 而消除，但其 §1-5 保留正文里的 `未物理删测试` 等被同一正则族命中，故未净减。**剩余 7 条全部落在「必须逐字保留的历史原文」**：
- `AGENTS.md:32 pywebview` —— 位于 **A1 硬锚点 §2.3 R69 Agent 浏览器闭环** 章节正文（表格「ARIA 快照（Node）/HTML 解析树（pywebview）」），§6.3 要求 §2.3 全部内容逐字保留，**不可改**；
- `README.md:10 pywebview`、`开发说明.txt:11 Python 3.10+` —— I26「只增不删，原文字保留」的删除前原文，**不可改**；
- `PYTHON-CONTRACT-EXIT-PLAN.md` 4 条（`:22 import backend`、`:56 pywebview`、`:57 未物理删测试`、`:81 步骤 5 仍被阻断`）—— 全在 §1-5 历史正文，I27「只改标题与状态行，保留 §1-5 历史原文」，且已验证 §1-5 正文 122/122 行 `BYTE-IDENTICAL=True`，**不可改**。
- 另 `STEP5-DELETION-BOUNDARY.md` / `HANDOVER-R69.md` 在 `ALLOW_FILES` 历史豁免中，实测未被误判（I10 反例口径保持成立）。
- **取舍判断**：让 `scan_stale_docs()` 对这些文件「不再命中」只有两条路径——① 改写/删除上述受保护历史原文（违反 A1 / I26 / I27 / 裁决 5「不删资产」）；② 放宽正则族或把活跃入口文档加入豁免（违反派发单「不自行放宽判据」、且会破坏 QA 矩阵 I27 反例「往两文件注入陈旧短语 → I10 正则族须不因豁免而漏判活跃文档」）。**两条都在硬边界内被禁止，工程师不自行扩权。** 按派发单「若归零导致判红，按 QA 口径回传，不自行放宽判据、不改第 13 门」的同类口径，此项**如实登记为「未完全收敛 / 需人工复核」**，回传主理人裁决（是否授权后续增设「退役声明 + 删除前原文角标」的豁免识别机制），不冒充 PASS、不改判据、不改第 13 门、不删资产。`staleDocs` 属 I13 已定义的**非阻塞登记项**（`basis.staleDocsNonBlocking=True`），不影响任何门禁绿态。

**（3）首轮全量 pytest 的 2 处 FAIL 及最小修复（§3.3 同类，如实登记）**。收尾 `pytest tests/ -q` 首跑得到 `2 failed, 476 passed, 2 skipped`（rc=1），两处均在 `tests/test_r68_arch_contract.py`，均为**被本批规格授权改动打破的 pytest 侧陈旧硬编码断言**（非源码 Bug、非环境偶发、与 QA 用例无关）：
- `test_c_path_steps_1_to_3_frozen_but_deletion_still_gated:176` 断言 `'步骤 1–3 已执行' in plan and '步骤 5 已执行' in plan` —— I27 已按规格把标题改为「步骤 1–6 已执行」，旧字面量不再存在 → `AssertionError`。
- `test_r69_p0_3_type_safety_phase1:537` 断言 `audit['current']['exportedSymbols'] == 7` —— I23 已按规格把 SCOPE 1→4 文件、7→18，实测 `assert 18 == 7` → `AssertionError`。
- **修复口径（同 §3.3 QA T03 Round 1 FAIL，主理人已批准范式）**：不放宽、不删断言、判据强度不降反升——把单值硬断言改为「与本次状态/独立基线动态交叉校验」。I27 侧由 1 条字面量断言改为 10 条动态断言（标题 `# ` 起始、`步骤 1–6 已执行`、无「待确认/未执行」、指向 `STEP5-DELETION-BOUNDARY`、R70 角标在位、§1-5 五个章节头保留、STEP5 标题跨文档交叉校验）；I23 侧由 `==7` 改为独立基线 `expected>=7` 棘轮 + 产物/内嵌 baseline/SCOPE 三处与基线一致 + coverage 100% 语义，并**保留**原 `status/coverage/regressions/staticTypeCheck/pilot/plan` 全部断言。`git diff` 显示该文件仅这 2 处（另有 §3.3 已修的 `:372` 块，为历史改动）。
- **正反例证据**：`assert anchor in src` 10/10 锚点自检；内存 monkeypatch（未写回工作区）构造 I27 侧 **6 类注入全 FAIL** + I23 侧 **8 类注入全 FAIL**，两侧正样本均 PASS（详见 §1.2c）。全库同类硬编码扫描：`步骤 1–3 已执行` / `步骤 5 已执行` 仅此 1 处；`exportedSymbols==7` 仅此 1 处；其余 `==7` 命中均为 `total_tokens/usageDelta/nearest_rank` 等无关业务断言，`backend/**/*.py` 仅 docstring 说明文字（AST 证实 live glob 零残留），**无第三处遗漏**。
- **收尾**：定向 2 用例 `2 passed in 1.36s`（rc=0）；全量 `pytest tests/ -q` → **478 passed / 2 skipped / 0 failed**（rc=0）。此 2 处修复为 T04+T05 增量，已一并回报主理人。

**（4）其他取舍（如实登记）**：① TypeScript/tsc/代码覆盖率维持 `blocked-by-environment`，JSDoc 覆盖率 ≠ 静态类型检查、gate-coverage ≠ 代码覆盖率，不伪造；② `architecture-metrics-r69.json` 的 `tests.serverRunnableGates:27` 按裁决 6「历史原文保留不改」不动，I28 只增补字段并在 I28 行说明其为历史数字；③ I22/I28 产物为跑门禁自动刷新（非手改），连跑 2 次 sha256 恒 `2fef7c95…7400`；④ `post-deletion-audit-r69.json` 归零复验后逐字恢复，最终态 `staleDocs=7 / version=2 / verdict.dynamic=true / realDefectsFound=0 / fixedFiles=9`；独立 meta 仍 `NOT TRACKED`、10 分钟容差，session fixture 自动刷新；⑤ `electron/main.js` 保留 `main.py` 历史溯源措辞（纯注释、零行为变更）；`tests/conftest.py` 的「即将退役→已退役」由 I08 完成，本轮未重复改、未误判未完成。

**（5）「未执行 / 回退 / 需人工复核」明确清单**：
- **PASS**：I19–I26、I28–I30 共 11 轮全部 PASS；I27 的「标题/状态行/§1-5 逐字保留/执行结果角标」验收项 PASS。
- **未完全收敛 / 需人工复核（唯一遗留）**：I27 的 `scan_stale_docs()`「不再命中 / staleDocs 归零」子项 —— 真实值 7（T02 为 8），7 条全在受保护历史原文内；§6.3 要求的「归零后门禁不退化」复验已 PASS，但「真实归零」需主理人裁决是否授权豁免识别机制，见上文（2）。按 QA 口径回传，不冒充完成。
- **回退**：无。第 13 门、13/13、17/17、82/82 均未回退；gate 未判红。
- **未执行**：无本批次范围内的未执行轮次；T01–T03 已完成，I13–I18 不在本批。
- **信息中转（裁决 8）**：本批所有跨成员信息（反例口径、I27 遗留裁决请求、2 处 pytest FAIL 修复）一律经 team-lead 中转，工程师未与 QA 直连。

- **主理人裁决 9（2026-11-12）：I27 `staleDocs` 遗留项 = 规格缺陷，责任在主理人，非工程师实现问题**。规格 §3 I27 原要求「重跑 `scan_stale_docs()` 不再命中这 2 文件」，但 §1 裁决 5 / §6.3 I26-I27 同时要求「§1-5 历史原文逐字保留、只增不删」，而这些受保护原文恰含那 7 条陈旧措辞 —— 两条判据在硬边界内**数学上不可达、自相矛盾**。两条收敛路径均被禁止：① 改写/删除受保护历史原文（违反 A1/I26/I27/裁决 5）；② 放宽正则族或把活跃入口文档加入豁免（违反「不自行放宽判据」，且会破坏 QA 矩阵 I27 反例「注入陈旧短语须不因豁免而漏判活跃文档」）。
  **裁决**：采纳「长期保留为 I13 已定义的非阻塞登记项」（`basis.staleDocsNonBlocking=True`），**不授权豁免识别机制**。撤销规格 §3 I27 与 §6.3 的「不再命中 / 归零」不可达判据，替换为三条可达且强度不降的判据：① 命中数不增（T02=8 → 当前 7，减少 1）；② 7 条命中逐条全部归属受保护历史原文（A1 §2.3 正文 / I26 只增不删原文 / I27 §1-5 保留正文），STEP5/HANDOVER 仍不误判；③ 归零后 I13 动态 verdict / 第 13 门 / 13/13 不退化（工程师已做 L1/L2/L3 三层复验 + 反向注入真问题仍 rc=1）。**扫描器强度、正则族、活跃入口文档集一字未改，不放宽任何判据**。当前 7 条实测：`AGENTS.md:32`、`README.md:10`、`开发说明.txt:11`、`PYTHON-CONTRACT-EXIT-PLAN.md:22/56/57/81`。登记为 Known Issue，不冒充完成。
- **T04+T05 两处 pytest 侧增量修复（工程师按 §3.3 已批准范式执行，主理人已核验 diff）**：首轮全量 pytest 判 2 FAIL，均为本批规格授权改动打破的 pytest 侧陈旧硬编码：`tests/test_r68_arch_contract.py:176` `'步骤 1–3 已执行' in plan`（I27 改标题后失效）、`:537` `exportedSymbols == 7`（I23 7→18 后失效）。修复口径为**固定字面量 → 动态交叉校验 + 只增不减棘轮**：I27 侧改为 10 条动态断言（标题声明 1–6 已执行、无「待确认/未执行」、指向 STEP5、角标在架、§1-5 五章节头保留、STEP5 跨文档交叉校验）；I23 侧改为独立基线棘轮 + 产物/内嵌 baseline/SCOPE 三处一致。判据强度不降反升、未删断言。工程师给出 10/10 锚点自检、I27 6 类 + I23 8 类注入全 FAIL、两正样本 PASS、全库同类扫描无第三处、定向 2 passed、全量 478 passed。**交 QA 最终验收复核**。

## 4. 全局一致性审查（T01+T02）

- 8 个改动 Python 文件 `ast.parse` 全部 OK，跨文件 import 无缺失/循环；3 个 `.mjs` 门 + CI YAML + 2 个 requirements 交叉引用自洽。
- 接口契约：`CANONICAL=16`、`GATES=11`（+1 聚合门 = 12）、`server_gates()=36` 与产物 `serverGates=36` 一致、`round_runner.CORE=12`；A5 一一对应关系成立（5 项由 CI 非注释 `run:` 块/聚合门覆盖，11 项由 GATES 解析式校验）。
- 数据流：`gate_coverage.evaluate()` 纯函数 → 产物字段 → `arch-contract.mjs:512-515` 的 `status/percentage/missingGates/codeCoverage.status` 读值全部仍满足；`post_deletion_audit.scan_stubs()` 新增 `guardType`/`guardOk`/`backendImport` 字段不影响 `arch-contract.mjs:639-648` 硬断言。
- 无重复实现：`extract_ci_run_blocks` / `parse_gates` / `validate_gate_structure` / `evaluate` / `main` 在 `gate_coverage.py` 各仅 1 处定义。
- **IS_PASS: YES**（T01+T02）

### 4.1 全局一致性审查（T03）

- 5 个改动 Python 文件 `ast.parse` 全 OK，跨文件 import 无缺失/循环；`arch-contract.mjs` import `./audit-freshness.mjs` 的纯函数、`post_deletion_audit.py` 写独立 meta、统一入口第 13 门调用 audit，交叉引用自洽。
- 接口契约：`GATES` 具名门 **12** + 1 聚合门 = `results.total` **13**；`CANONICAL` **17**（新增项 token 由 GATES 命中，实测 `uncovered=[]`）；`CI_ONLY` 5；`NON_GATE_SCRIPTS` 2 项 → `server_gates()=35`；`SCAN_DIRS` **8**；`BLOCKING_DEAD_KIND='backend-in-runtime-config'`。`gate_coverage.validate_gate_structure(parse_gates(entry))` 对全部 12 门 `errors=[]`。
- 数据流/顺序依赖：GATES 前三门实测 `['gate-coverage','post-deletion-audit','arch-contract']`，满足裁决「audit 在 gate-coverage 之后、arch-contract 之前」，保证 arch-contract 读到本轮刷新的 audit 产物与 meta；产物 `summary.total=13`、`serverGates=35`、`excludedFromServerGates` 与实际一致。
- 幂等：`post-deletion-audit-r69.json` 连跑 3 次 sha256 恒为 `979e257b…a73`；`generatedAt` 只在独立 meta；`version` 由 1→2、`ensure_ascii=False, indent=2` 保持；`contract_diff --compare r68` 零漂移未受影响。
- 无重复实现：`gate_coverage.py`（5 个关键函数）、`post_deletion_audit.py`（`find_blocking_defects`/`build_verdict`/`write_freshness_meta`/`main`）、`check_static_paths.py`（4 个关键函数）各仅 1 处定义。
- **IS_PASS: YES**（T03；首轮审查即通过，无需第 2 轮修复重审）

### 4.2 全局一致性审查（T04+T05，I19–I30）

> 审查范围：本批 12 轮全部落盘文件 + 与 T01–T03 既有改动的跨文件一致性。首轮审查发现 2 处 pytest 侧陈旧硬断言（全量 pytest 判红），已按 §3.3 范式修复并复验（详见 §3.5(3)），故本轮为**第 1 轮修复后重审**，结论如下。

- **语法/导入**：本批新增/改动的 3 个 Python 文件（`tools/check_release.py`、`tools/arch_assessment.py`、`tools/type_annotation_audit.py`、`tests/test_api_surface_consistency.py`、`tests/test_r68_arch_contract.py`）`ast.parse` 全部 OK；`server/src/*.js` 4 文件 + `server/test/paths-readjson.test.js` + `electron/main.js` 均可被 Node 解析 / `--test` 加载成功；跨文件 import 无缺失、无循环（`paths.js` 的 `readJsonWarnings` 单向导出给 `paths-readjson.test.js`）。
- **接口契约**：`run_normalized_gates.GATES` 具名 12 + 聚合 1 = `summary.total=13`；`CANONICAL=17` 与 `arch_assessment.ci.detectedTokens=17` 一一对齐（I28）；`NON_GATE_SCRIPTS` 2 项 → `server_gates()=35`（I19 新增 `.js` 用例不进 `*.mjs` glob，35 门不退化）；`type_annotation_audit.SCOPE` 4 文件与独立基线 `type-annotation-baseline-r69.json` 的 `scope` 逐项一致，产物 `baseline/current = 18/18/100`（I23）。
- **数据流**：`post_deletion_audit.build_verdict()` → 产物 `verdict.dynamic/staleDocsNonBlocking` → `arch-contract.mjs` A2 动态交叉校验（Node 侧）与 `tests/test_r68_arch_contract.py:372`（pytest 侧）双向一致；§6.3 `staleDocs=0` 注入复验三层全绿、产物字节恢复；I14 meta 经 `tests/conftest.py` session autouse fixture 自动刷新，`pytest tests/ -q`、`round_runner --full`、CI `gate` job 四条链覆盖；`check_release._latest_git_tag()` 三态返回值被 `:134` 调用点正确解包。
- **文档锚点**：A1 `AGENTS.md` §2.3 标题字面量保留（grep 计数 1，`arch-contract.mjs` 82/82）；EXIT-PLAN / STEP5 §1-5 正文 `BYTE-IDENTICAL=True`（122/122、252/252），仅改标题/状态行；`开发说明.txt` BOM 保留、原文字逐字未删。
- **无重复实现**：`_doc_is_well_formed`/`_required_tags`/`_adjacent_doc`（I24）、`pushReadJsonWarning`（I19）、`_latest_git_tag`（I20）、`READ_ERRORS` 累计（I22）各仅 1 处定义；`tests/test_r68_arch_contract.py` 无对 `步骤 1–3 已执行` / `==7` 的第二处硬编码（全库扫描证实）。
- **取边界**：`harbor.html`/`frontend/react/src/generated/*`/`frontend/styles/`/`frontend/manifest.json`(styles=14、末位 responsive.css)/`config.json`/`frozen-python-surface.json`/`contract-baseline-r68.json`/`package.json`+`server/package.json` engines 全部未触碰（§5.2 逐项复核）；51 公开方法零漂移；无既有资产删除；TypeScript/覆盖率维持 `blocked-by-environment` 不伪造。
- **IS_PASS: YES**（T04+T05；第 1 轮修复 2 处 pytest 侧陈旧硬断言后重审通过）。**遗留 1 项不改变本结论**：I27 的 `staleDocs` 真实归零需主理人裁决（§3.5(2)），该项属「文档漂移登记项」而非代码/契约不一致，归零场景的门禁不退化已单独复验 PASS。

## 5. `git diff --stat` 全量清单与禁改边界确认

```
 .github/workflows/harbor-ci.yml                    |   7 +-
 deliverables/dev-plan/architecture-metrics-r69.json |   6 +-   （门禁产物自动刷新，非手改）
 deliverables/dev-plan/gate-coverage-r69.json       |  24 ++-    （门禁产物）
 deliverables/dev-plan/normalized-gates-r69.json    |   8 +-    （门禁产物）
 deliverables/dev-plan/post-deletion-audit-r69.json | 186 +++---  （门禁产物）
 requirements-win.txt                               |   4 +
 server/test/contract-coverage.mjs                  |   5 +
 server/test/contract-golden.mjs                    |   7 +-
 server/test/contract-signatures.mjs                |   6 +
 tests/conftest.py                                  |  19 +-
 tests/helpers/state_reset.py                       |  26 ++-
 tools/check_release.py                             |  22 +--
 tools/diag/state_probe.py                          |  42 ++---
 tools/gate_coverage.py                             | 202 +++++-
 tools/post_deletion_audit.py                       | 140 +++++-
 tools/round_runner.py                              |  24 ++-
 tools/run_normalized_gates.py                      |   5 +-
 17 files changed, 571 insertions(+), 162 deletions(-)
```
另新增 `requirements-ci.txt`（独立文件，23 行，未跟踪）；`R70-IMPLEMENTATION-SPEC.md` / `R70-ITERATION-LEDGER.md`（本台账）/ `R70-QA-VERIFICATION-MATRIX.md` 为主理人/QA 产出，非工程师改动。

**禁改边界逐项确认（全部未触碰）**：`harbor.html` ✓、`frontend/react/src/generated/*` ✓、`frontend/styles/` ✓（未新增 CSS）、`frontend/manifest.json` ✓（styles=14、末位 `frontend/styles/responsive.css`、scripts=117、prebuilt=1 保持不变）、`config.json` ✓（`git diff -- config.json` 为空）、`deliverables/dev-plan/frozen-python-surface.json` ✓（逐字节未变，51 公开方法零漂移）、`package.json` / `server/package.json` 的 `engines` ✓（`git diff -- package.json server/package.json` 为空）、`contract-baseline-r68.json` ✓、`AGENTS.md` 的 `## 2.3 R69 Agent 浏览器闭环` 章节标题字面量 ✓（A1 锚点，`arch-contract.mjs:662` 仍 82/82）；`post_deletion_audit.py` 的 `verdict` ✓（A2 锚点未动）；`method-surface.mjs:25,39,40` 的 116/51/167 ✓（A3 锚点未动）；`contract_diff.py:127-128,159` ✓（A4 锚点未动）；统一入口 GATES 数量 / `gate_coverage.py` CANONICAL 16 / `arch-contract.mjs` 断言数 ✓（A5 锚点未动）。无既有资产删除。

### 5.1 T03 `git diff --stat` 增量清单与禁改边界复核

> 上方 §5 为 T01+T02 收尾时的全量清单（历史原文保留）。以下为 **T03 收尾后**的全量实测（`20 files changed, 902 insertions(+), 232 deletions(-)`；台账自身不进 git diff 统计，该数为源码/产物清单）。相对 T01+T02 的**增量**为：新增改动 `tests/test_ci_tooling.py`、`tools/check_static_paths.py`、`frontend/app/tests/arch-contract.mjs`，以及 T03 对既有 6 个文件的续改。

```
 .github/workflows/harbor-ci.yml                    |  10 +-
 deliverables/dev-plan/architecture-metrics-r69.json |   6 +-   （门禁产物自动刷新，非手改）
 deliverables/dev-plan/gate-coverage-r69.json       |  30 ++-    （门禁产物）
 deliverables/dev-plan/normalized-gates-r69.json    |  36 ++-    （门禁产物）
 deliverables/dev-plan/post-deletion-audit-r69.json | 234 +++++---  （门禁产物，本体字节幂等）
 frontend/app/tests/arch-contract.mjs               |  41 +++-    （I14 新鲜度 + A2 动态化；T03 新增改动）
 requirements-win.txt                               |   4 +
 server/test/contract-coverage.mjs                  |   5 +
 server/test/contract-golden.mjs                    |   7 +-
 server/test/contract-signatures.mjs                |   6 +
 tests/conftest.py                                  |  19 +-
 tests/helpers/state_reset.py                       |  26 ++-
 tests/test_ci_tooling.py                           |  75 +++++   （I18；T03 新增改动）
 tools/check_release.py                             |  22 +--
 tools/check_static_paths.py                        |  65 +++++   （I16/I17；T03 新增改动）
 tools/diag/state_probe.py                          |  42 ++--
 tools/gate_coverage.py                             | 204 ++++++-  （I13 CANONICAL 17）
 tools/post_deletion_audit.py                       | 247 ++++++-  （I13 verdict/meta/幂等）
 tools/round_runner.py                              |  24 ++-
 tools/run_normalized_gates.py                      |  23 +--     （I13 第 13 门 + I15 excluded）
 20 files changed, 902 insertions(+), 232 deletions(-)
```
**T03 新增未跟踪文件**（相对 T01+T02 增量，均为主理人裁决授权）：`deliverables/dev-plan/post-deletion-audit-meta-r69.json`（裁决二，独立新鲜度 meta，119 B）、`frontend/app/tests/audit-freshness.mjs`（裁决三，可导出纯函数，2006 B）。原有未跟踪 `requirements-ci.txt`（I05）与 `R70-IMPLEMENTATION-SPEC.md` / `R70-ITERATION-LEDGER.md`（本台账）/ `R70-QA-VERIFICATION-MATRIX.md`（QA 产出）不变。

**禁改边界 T03 复核（逐项实测，全部未触碰）**：`harbor.html` 未触碰 ✓；`frontend/react/src/generated/*` 未触碰 ✓；`frontend/styles/` 未触碰 ✓（未新增 CSS）；`frontend/manifest.json` 未触碰 ✓（styles=14 / 末位 `frontend/styles/responsive.css` / scripts=117）；`config.json` ✓（`git diff -- config.json` 为空）；`deliverables/dev-plan/frozen-python-surface.json` ✓（逐字节未变，51 公开方法零漂移）；`package.json` / `server/package.json` 的 `engines` ✓（`git diff` 内无 engine 行）；`contract-baseline-r68.json` ✓；A1 `AGENTS.md` 的 `2.3 R69 Agent 浏览器闭环` 标题字面量仍在（grep 计数 1，`arch-contract.mjs` 82/82）✓；A3 `method-surface.mjs` 116/51/167 未动 ✓；A4 `contract_diff.py` 未动 ✓。**A2/A5 按 I13 授权同批同步**（`arch-contract.mjs:647-648` 两条硬断言改动态读数、CANONICAL 16→17、CI 注释、`tests/test_ci_tooling.py` 门禁数断言），断言总数仍 82，门禁总数按裁决 1 由 12→13。无既有资产删除，TypeScript/覆盖率维持 `blocked-by-environment` 不伪造。

### 5.2 T04+T05 收尾 `git diff --stat` 全量清单与禁改边界确认

> 上方 §5 / §5.1 为 T01+T02 / T03 收尾时的历史清单（保留不改）。以下为 **T04+T05 收尾后**的全量实测：`36 files changed, 1520 insertions(+), 375 deletions(-)`（相对 T03 收尾 `20 files / 902 insertions / 232 deletions` 的**增量**约为 16 个新改动文件 + 618 行新增）。台账自身、规格、QA 矩阵为未跟踪文件，不进 `git diff` 统计。

```
 .github/workflows/harbor-ci.yml                    |  10 +-
 AGENTS.md                                          |  47 ++--       （I25；§2.3 逐字保留）
 README.md                                          |  10 +         （I26；只增不删）
 deliverables/dev-plan/STEP5-DELETION-BOUNDARY.md   |   2 +-        （I27；只改标题）
 deliverables/dev-plan/architecture-metrics-r69.json |  34 ++-       （I22/I28 产物）
 deliverables/dev-plan/gate-coverage-r69.json       |  30 ++-        （门禁产物）
 deliverables/dev-plan/normalized-gates-r69.json    |  38 +++-       （门禁产物）
 deliverables/dev-plan/post-deletion-audit-r69.json | 243 +++++---     （门禁产物，staleDocs=7）
 deliverables/dev-plan/type-annotation-baseline-r69.json | 17 +-     （I23 独立基线 v2/18）
 deliverables/dev-plan/type-annotation-r69.json     | 147 ++++++--     （I23/I24 产物）
 electron/main.js                                   |  14 +-        （I30 纯注释）
 frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md     |  15 +-        （I27 标题/状态行/角标）
 frontend/app/tests/arch-contract.mjs               |  41 +++-       （T03 既有，本批未动）
 requirements-win.txt                               |   4 +         （I05 既有）
 server/src/config.js                               |   8 +         （I23 JSDoc）
 server/src/logger.js                               |   9 +-        （I23 JSDoc）
 server/src/paths.js                                |  37 +++        （I19 warnings + I23 JSDoc）
 server/src/runtime.js                              |  32 ++-        （I23 JSDoc）
 server/test/contract-coverage.mjs                  |   5 +         （T02 既有）
 server/test/contract-golden.mjs                    |   7 +-        （T02 既有）
 server/test/contract-signatures.mjs                |   6 +         （T02 既有）
 tests/conftest.py                                  |  54 ++++-      （I08/I14 既有，本批未动）
 tests/helpers/state_reset.py                       |  26 ++-        （T02 既有）
 tests/test_api_surface_consistency.py              |  73 ++++--     （I29；T04+T05 新增）
 tests/test_ci_tooling.py                           |  75 +++++-      （T03 既有）
 tests/test_r68_arch_contract.py                    |  54 ++++-      （§3.3 既有 :372 + 本批 2 处动态断言修复）
 tools/arch_assessment.py                           |  51 +++-       （I22/I28；T04+T05 新增）
 tools/check_release.py                             |  76 ++++--     （I07 既有 + I20/I21；T04+T05 续改）
 tools/check_static_paths.py                        |  65 +++++       （T03 既有）
 tools/diag/state_probe.py                          |  42 ++--       （T02 既有）
 tools/gate_coverage.py                             | 204 +++++--     （T02/T03 既有）
 tools/post_deletion_audit.py                       | 251 +++++---     （T02/T03 既有，本批未动）
 tools/round_runner.py                              |  24 ++-        （T01 既有）
 tools/run_normalized_gates.py                      |  23 +--        （T01/T03 既有）
 tools/type_annotation_audit.py                     | 113 +++--      （I23/I24；T04+T05 新增）
 开发说明.txt                                       |   8 +         （I26；只增不删，BOM 保留）
 36 files changed, 1520 insertions(+), 375 deletions(-)
```

**T04+T05 新增未跟踪文件**（唯一）：`server/test/paths-readjson.test.js`（I19 的 `node --test` 用例，`.js` 后缀不进 `*.mjs` glob）。其余未跟踪文件为前三批既有：`requirements-ci.txt`（I05）、`deliverables/dev-plan/post-deletion-audit-meta-r69.json`（裁决二，NOT TRACKED）、`frontend/app/tests/audit-freshness.mjs`（裁决三）、`R70-IMPLEMENTATION-SPEC.md`（主理人）、`R70-ITERATION-LEDGER.md`（本台账）、`R70-QA-VERIFICATION-MATRIX.md`（QA 产出）。

**禁改边界逐项复核（`git status --short` 全量核对，全部零命中）**：`harbor.html` ✓（未手改，机器产物）、`frontend/react/src/generated/*` ✓、`frontend/styles/` ✓（未新增 CSS 文件）、`frontend/manifest.json` ✓（styles=14、末位 `frontend/styles/responsive.css`、scripts=117，未触碰）、`config.json` ✓（`git diff -- config.json` 为空，零污染）、`deliverables/dev-plan/frozen-python-surface.json` ✓（逐字节未变，51 公开方法零漂移）、`package.json` / `server/package.json` 的 `engines` ✓（未改，I04 零代码改动裁决保持）、`deliverables/dev-plan/contract-baseline-r68.json` ✓、`STEP5` §0 / `HANDOVER-R69` §16/§17/§392 保留声明 ✓（未改写，仅改 STEP5 标题）。A1 `AGENTS.md` §2.3 标题字面量与全部内容逐字保留 ✓（82/82）；A3 `method-surface.mjs` 116/51/167 未动 ✓；A4 `contract_diff.py` 未动 ✓；A2/A5 本批未动（`arch-contract.mjs` / `CANONICAL=17` / GATES 13 / `tests/test_ci_tooling.py` 均为 T03 既有状态）。**无既有资产删除**（`git status` 无 `D` 行）；TypeScript / tsc / 代码覆盖率维持 `blocked-by-environment` 如实登记，不伪造。
