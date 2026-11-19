# R70 独立验收矩阵与反例注入用例

> 编制：严过关（Yan）· QA 工程师｜团队 `software-harbor`｜派发：主理人齐活林（Qi）
> 事实源：`R70-IMPLEMENTATION-SPEC.md`（30 轮精确指令 / 硬边界 / 硬锚点 / 验收门）、`R70-ITERATION-LEDGER.md`（迭代前基线）
> 阶段：**并行只读设计阶段**（编制时）→ **2026-11-12 已进入正式验收第 1 轮**（见 §9，工程师 T01+T02 已落盘，主理人派发正式独立验收）。工程师寇豆码在编制时正在并行实现 T01+T02（I01–I12）。
> 本文件是 QA 唯一落盘产物；**全程未修改、也不会修改任何实现文件**（`tools/*.py`、`server/test/*.mjs`、`tests/*.py`、`.github/`、`AGENTS.md`、`README.md` 等一律不动）。正式验收阶段只刷新了门禁派生产物 JSON（`G4/G5/arch-assessment` 重跑），未改源码。

---

## 0. 本文档定位与只读边界

| 项 | 说明 |
|---|---|
| 目标 | 设计能**证明改动真的有效**的独立验证，而非确认文件存在。正向验收照抄规格 §3 判据（不放宽），负向验收用「反例注入」构造「改动没做/做错了，门必须 FAIL」的场景 |
| 本阶段产物 | 仅本文件。所有反例脚本以**代码片段**形式给出，供工程师完成后的正式验收阶段执行 |
| 已运行的命令 | **设计阶段**：全部只读（文件读取、`git status/diff`、`node` 跑不写产物的单门、`python` 内存复现、`TemporaryDirectory` 沙箱注入）。**正式验收第 1 轮（§9）**：按主理人派单已运行 G1–G9 全量（含 `run_normalized_gates.py`、`gate_coverage.py`、`pytest tests/ -q`），env/观察值/PASS-FAIL 逐门记录于 §9.1 |
| **设计阶段未运行（禁止）→ 正式验收已解除** | 设计阶段禁止 `python tools/run_normalized_gates.py`、`python tools/gate_coverage.py`、`python tools/contract_diff.py --snapshot`、`python tools/post_deletion_audit.py`（真实工作区）、任何 `--snapshot`/写产物入口、`pytest tests/ -q` 全量，以免覆盖迭代前基线或与工程师并发冲突；**该禁令仅适用于并行只读设计阶段**。正式验收阶段已按派单解除，但仍**未运行** `post_deletion_audit.py`（避免覆盖 audit 产物，见 §9.5）与 `--snapshot` |
| 环境 | Python `C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（3.13.14）；Node `C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（v22.22.2）；**无外网** |
| 命令前缀 | `PYTHONUTF8=1 PYTHONIOENCODING=utf-8`（Windows 中文路径 + heredoc 中文脚本必需）；下文简写为 `$PY` / `$NODE` / `$ROOT` |
| 证据时点 | 2026-11-11 并行阶段约 22:5x。**不是**台账「迭代前基线 22:2x」；此时 `tools/round_runner.py` 已被工程师修改（I01 进行中），`normalized-gates-r69.json` 已被刷新。所有数值标注为「并行中点快照」，不冒充迭代前基线 |

**变量定义（所有脚本通用）**
```bash
PY="C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
NODE="C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
ROOT="C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包"
```

---

## 1. QA 硬口径与智能路由（不可协商）

1. **判为 FAIL 立即停止后续测试**，回传完整复现包：`命令 / env / 观察值 / 判据 / PASS-FAIL / 源码文件+函数 / 堆栈`，不自行修改引擎代码。
2. **逐门精确记录**：命令、环境、观察值 vs 判据、PASS/FAIL；本文件 §3 与 §9 即为记录模板。
3. **不伪造通过、不为通过放宽判据**；明确区分三层：**构建通过**（进程能起、无 traceback）≠ **断言通过**（判据满足）≠ **功能可用**（真实用户场景可用）。三层各自留痕，不得互相冒充。
4. 结果通过**正式汇报通道 `SendMessage` 回传 `team-lead`**，不用纯文本冒充。

**智能路由判定规则（最多 2 轮，硬上限）**

| 观察 | 判定 | 动作 |
|---|---|---|
| 断言期望符合 PRD/规格，实际输出不符 | **源码 Bug** | 回传工程师（附复现包），等待修复 |
| 断言本身写错（判据、样本、锚点、转义有误） | **测试 Bug** | QA 自行修，不打扰工程师 |
| 全通过 | **NoOne** | 报成功 |
| Round 1：写/修用例 → 跑 → 分析 → 路由 | — | 源码 Bug 送出后等待；测试 Bug 自修即算 Round 1 完成 |
| Round 2：回归复跑 | — | 全过则退出；仍失败**立即退出**，剩余问题写入「Known Issues」，**不进入 Round 3** |

> 本阶段已发生一次**测试 Bug 自修**：首版 `strip_run_blocks()` 用正则 `\S`/`\1` 过度剥离，导致 `ci2` 前 6 行变空、假覆盖数值失真。按路由规则由 QA 自行改为**纯字符串状态机**（§2.2），未打扰工程师。此项记录以证明「QA 对自己写的用例也做反例校验」。

**本阶段判定结论**：所有只读命令进程 rc=0 执行成功；出现的 `rc=1` / `Traceback` 均为**反例注入的预期观察值**（I16 死参数、I21 spec 缺失），已逐条标注，不是验收门 FAIL，故不触发「立即停止」。

---

## 2. 反例注入方法论（本矩阵核心）

### 2.1 三种注入模式

| 模式 | 用途 | 污染 | 恢复 |
|---|---|---|---|
| **M · 内存复现** | 复现「当前实现的恒真/假覆盖」；import 模块但**不调用 `main()`**（不写产物） | 零 | 进程退出即净 |
| **S · 沙箱副本** | 需要真实运行被测脚本（会写产物）时，在 `TemporaryDirectory` 里复制最小骨架 + 注入 + 运行副本入口。`ROOT` 由 `__file__` 推导，故副本脚本的 `OUT` 落在副本内 | 零工作区写入 | `TemporaryDirectory` 自动清理 |
| **P · 锚点 monkeypatch** | 进程内替换 `fs.readFileSync` / `subprocess.run` / `io.open` / `find_legacy_references` 等，模拟 EACCES、TimeoutExpired、OSError | 零 | 进程退出即净 |

### 2.2 通用沙箱骨架（各轮 `sandbox(...)` 均引用此段）

```python
# -*- coding: utf-8 -*-
# 验收阶段写入系统临时目录执行，或 python - <<'PY' 直接喂入；不落盘到 $ROOT
import tempfile, shutil, subprocess, json, sys, re, os
from pathlib import Path
ROOT = Path(r'C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包')
PY   = r'C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe'
NODE = r'C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'

def sandbox(files, mutate, cmd_fn, capture_json=None, timeout=180):
    """复制最小骨架 → 注入 → 运行副本入口 → 返回 (rc, stdout+stderr, 产物dict|None)。
    files: 需复制的相对路径（必须含被测脚本自身）
    mutate: fn(dst: Path) -> None，注入改写；内部必须 assert 注入锚点命中
    cmd_fn: fn(dst: Path) -> list[str]，返回完整 argv
    """
    with tempfile.TemporaryDirectory(prefix='qa-r70-') as d:
        dst = Path(d)
        (dst / 'deliverables' / 'dev-plan').mkdir(parents=True, exist_ok=True)
        for f in files:
            p = ROOT / f
            if p.is_file():
                q = dst / f
                q.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, q)
        mutate(dst)                       # ← 注入点
        r = subprocess.run(cmd_fn(dst), cwd=str(dst), capture_output=True,
                           text=True, encoding='utf-8', errors='replace', timeout=timeout)
        doc = None
        if capture_json:
            q = dst / capture_json
            if q.is_file():
                doc = json.loads(q.read_text(encoding='utf-8'))
        return r.returncode, (r.stdout or '') + (r.stderr or ''), doc
    # 退出 with：临时目录自动删除，工作区零污染

def inject_replace(rel, anchor, replacement):
    """生成 mutate：替换文本并强制锚点自检。锚点未命中即 AssertionError（反例作废，不判 PASS）。"""
    def _m(dst):
        p = dst / rel
        s = p.read_text(encoding='utf-8')
        assert anchor in s, '注入锚点失效：%s :: %r' % (rel, anchor[:60])
        p.write_text(s.replace(anchor, replacement, 1), encoding='utf-8')
    return _m
```

### 2.3 反例有效性的四条硬约束（缺一即橡皮图章）

1. **改动前必须复现「门恒真」**：先证明当前实现在注入下仍 PASS（或仍报 16/16、`ok:true`、rc=0）。没有这条，「改动后 FAIL」无法归因于本次改动。
2. **注入锚点必须自检**：`assert anchor in src`。工程师并行改文件后锚点常会漂移；若替换静默失效，脚本继续跑出 PASS 就是**假通过**。本矩阵所有 `inject_replace` 均自带该断言。
3. **正负样本成对**：只给负样本时，实现「一律判 false / 一律 FAIL」也能全过。每个反例必须配一条「注入撤除/正样本仍 PASS」的对照。
4. **注入强度要说清**：见 §10 R1 —— 「全删 `run:` 行」与「只摘除关键 `run:` 行但保留注释」是**两种不同强度**，前者当前实现已 FAIL，后者才真正检验「注释不算命中」。

### 2.4 恢复现场与零污染规约

- S/M/P 模式天然零污染：运行前后各执行一次 `git -C "$ROOT" status --short` 与 `git -C "$ROOT" diff --stat`，两次输出必须一致（工程师并发改动需单独注明、不归咎 QA）。
- **禁止在真实工作区 `touch` 产物**（I14 反例尤其）：`post-deletion-audit-r69.json` / `normalized-gates-r69.json` / `gate-coverage-r69.json` 是门禁产物，touch 会改 mtime 并可能被工程师并发重跑刷新。若确需触碰，必须：
  ```python
  st = os.stat(p); a, m = st.st_atime_ns, st.st_mtime_ns
  try:
      ...  # 注入 + 断言
  finally:
      os.utime(p, ns=(a, m))            # 精确恢复 atime/mtime
      assert 'Traceback' not in out
  ```
  并在末尾 `git diff -- <产物>` 确认内容未变。
- 沙箱内运行会写产物的脚本时，产物落在副本 `deliverables/dev-plan/`，**不覆盖迭代前基线**。

---

## 3. 改动前实测基线（逐门：命令 / 环境 / 观察值 vs 判据 / PASS-FAIL）

> 全部为只读实测，2026-11-11 并行阶段中点快照。**「观察值」是反例的对照锚**：改动后必须与此不同，否则改动无效。

| # | 只读命令（要点） | 观察值 | 判据 / 用途 | PASS-FAIL |
|---|---|---|---|---|
| E01 | `python` 内存复现 `gate_coverage.CANONICAL/CI_ONLY`（原始 CI YAML + 原始 `run_normalized_gates.py`） | `covered=(16, [])` | 现状 16/16 | 观察值登记 |
| E02 | 同上，但**全删所有 `run:` 行**（纯字符串状态机，注释保留） | `covered=(14, ['release-discipline','ui-contract'])`；残留注释仍含 `round_runner.py`/`entry_sweep.py`/`run_normalized_gates.py` | 现状在全删下**已 FAIL** → 单靠此反例不足以证明 I02 有效 | 观察值登记 |
| E03 | 同上，但**仅占位化/删除 `normalized-gates` 的 `run: python tools/run_normalized_gates.py`（L83），注释全留** | `covered=(16, [])` ← **两种注入都是 16/16 PASS** | **I02 核心铁证**：注释中的 `tools/run_normalized_gates.py`（L58）被当作命中 | 观察值登记 |
| E04 | 同上，但把 GATES 中 `'tools/contract_golden_replay.py'` 改为 `'tools/__QA_MISSING__/contract_golden_replay.py'`（保留 token 子串、`is_file=False`） | `covered=(16, [])` | **I03 核心铁证**：文本包含无法检出「门文件不存在」 | 观察值登记 |
| E05 | `python` import `post_deletion_audit`（不调 `main()`）→ `scan_stubs()` | `main.py.hasBackendLiteral = True`；共 **8/9** stub 判 True | I09：注释「不再 import backend」被误判 | 观察值登记 |
| E06 | 同上 → `scan_stale_docs()` | `staleDocs = 0` | 固定 5 短语表当前零命中 | 观察值登记 |
| E07 | 读 4 个活跃入口文档，查 5 短语 | `AGENTS.md`/`README.md`/`开发说明.txt`/`PYTHON-CONTRACT-EXIT-PLAN.md` 命中**全空**；`开发说明.txt` 后缀 `.txt`（当前 `scan_stale_docs` 仅扫 `.md`） | I10：必须换正则族 + 扩后缀 + 活跃入口集 | 观察值登记 |
| E08 | 读 `STEP5-DELETION-BOUNDARY.md` / `HANDOVER-R69.md` | 均含 `不得先删`，且均在 `ALLOW_FILES` → 当前**不误判** | I10：豁免必须保留，反例须验证「不误判历史原文」 | 观察值登记 |
| E09 | `python` 正则对比，样本 `datas = [('n','node_modules')]` | `r'datas[^\\n]*node_modules'` → **False**；`r'datas[^\n]*node_modules'` → **True** | I21 判据精确对上 | 观察值登记 |
| E10 | 同上两式对真实 `Harbor.spec` | old=False / new=False | **关键**：真实文件无法证明修复，必须构造样本（否则反例无效） | 观察值登记 |
| E11 | `python` 内存 `check_static_paths.find_legacy_references(ROOT)` | `findings=0`；`SCAN_DIRS=('backend','frontend','tests','tools','installer')`（5 个） | I16：当前 findings 恒 0 → 只跑 `--strict` 会得到 rc=0 的假通过；I17：需扩到 8 | 观察值登记 |
| E12 | `python` 内存注入 `FAKE` findings（P 模式）跑 `main()` | 非 strict → `rc=1, ok=False, strict=False`；`--strict` → `rc=1, ok=True→False, strict=True` | **I16 铁证**：`--strict` 当前是死参数，两种模式无分叉 | 观察值登记 |
| E13 | `node` 只读跑 5 个门 | `method-surface.mjs` rc=0；`contract-coverage.mjs` `legacy=167/migrated=167`；`contract-signatures.mjs` `ok:true,checked:167`；`contract-golden.mjs` rc=0；`arch-contract.mjs` **`82/82`** rc=0 | 契约零漂移基线 | **PASS**（只读门） |
| E14 | S 模式注入 `listMethods=()=>[]` / `listSignatures=()=>({})`（锚点命中 True） | `contract-coverage.mjs` **rc=0**、`ok:true, migrated:0`；`contract-signatures.mjs` **rc=0**、`ok:true, checked:0, mismatches:[]` | **I11/I12 铁证：ok:true 恒真** | 观察值登记 |
| E15 | S 模式运行 `post_deletion_audit.py`，往 CI YAML 副本注入 `run: python backend/domains/settings/config_service.py` | 死引用检出 `backend-in-runtime-config:1`，但 **rc=0**，`verdict.realDefectsFound=1`（静态）、`fixedFiles.length=6`（静态） | **I13 铁证**：verdict 硬编码 + 恒 return 0 | 观察值登记 |
| E16 | S 模式运行 `check_release.py --expect 1.9.0`，**故意不复制 `Harbor.spec`** | `rc=1` 且 **`Traceback: FileNotFoundError ... Harbor.spec`** | I21：spec 缺失当前 traceback；修复后须输出 `R7 缺少…` 且无 traceback | 观察值登记 |
| E17 | `python` 构造 4 个 JSDoc 样本（P 模式重定向 `type_annotation_audit.ROOT`） | `adjacent.js→True`；`interleaved.js→False`；**`novalue.js→True`**；**`unbalanced.js→True`** | I24：`@type` 无值 / `{type}` 括号不配对当前被误判为 annotated=True | 观察值登记 |
| E18 | `grep` 等价统计 | `AGENTS.md` 中 `from backend.api import` 命中 **1**；`2.3 R69 Agent 浏览器闭环` 命中 **1**；`arch-contract.mjs` A1 正则在架 True | I25 正向 + 反例锚点 | 观察值登记 |
| E19 | 读 `test_ci_tooling.py` / `package.json` / `server/package.json` / CI YAML | 现有用例**不含** `run_normalized_gates` 断言；`test_workflow_yaml_parses` 仅断言 `gate`+`entry-sweep` 两 job；根 `dependencies={}`；server deps **12** 个；CI 两处 `requirements-win.txt`；`requirements-ci.txt` **不存在**；`requirements-win.txt` 13 条实体条目 | I18 / I29 / I05 反例锚点 | 观察值登记 |
| E20 | 读冻结快照 / baseline | `frozen-python-surface.json` 14 键、`method_defs=167`、`public=51`、`hidden=116`、`API_VERSION=v1.0.0`；`contract-baseline-r68.json` 10 键 | 契约零漂移判据 | **PASS** |
| E21 | `git status --short` / `git diff --stat` / `git diff -- config.json` | `M normalized-gates-r69.json`、`M tools/round_runner.py`、`?? R70-*.md`；diff 仅 2 文件；**`git diff -- config.json` 空（零污染 PASS）** | 与台账「工作区干净」不同：并行阶段工程师已改动，如实登记 | 观察值登记 |
| E22 | `git diff -- normalized-gates-r69.json` + `stat` 三份产物 mtime | diff 仅 `tail` 里的 `duration_ms` 数字与 warning 文本刷新 → **纯产物刷新，非源码漂移**；`post-deletion-audit-r69.json` **19:02:14** / `gate-coverage-r69.json` 22:55:06 / `normalized-gates-r69.json` **22:56:20** | **I14 关键**：现场 post-audit 已比 normalized-gates 陈旧约 4h；mtime 口径对并发重跑极敏感 | 观察值登记 |

**环境噪声登记（不得静默吞掉）**：所有 `node` 门输出均带
`Warning: Ignoring extra certs from C:\Users\陈\.workbuddy\system-ca-bundle.pem, load failed: error:80000003:system library::No such process`。
判据：**该 warning 不影响 rc、不属于断言失败**，逐门记录但不判 FAIL；若某门 rc≠0，须先排除此噪声再归因。

---

## 4. 契约零漂移回归（每批收尾必跑，不可跳过）

> **执行责任划分**：下列会写产物的入口由**工程师**在每批收尾运行并把 `命令 + stdout 关键结论 + rc` 写入台账；**QA 复核 stdout/rc 并逐门记录**（本阶段只读，标「未验证」，不伪造）。QA 自行可跑的只读门：`node server/test/method-surface.mjs`、3 个 `server/test/*.mjs` 契约门、`node frontend/app/tests/arch-contract.mjs`、`python deliverables/design/check_contract.py`、定向 `pytest`、全部 `git diff/grep`、M/S/P 反例。

| 门 | 命令 | 判据（规格 §3 / 台账基线，不放宽） | 本阶段状态 |
|---|---|---|---|
| G1 | `python tools/contract_diff.py --compare deliverables/dev-plan/contract-baseline-r68.json` | 零漂移；10 键、`golden_sha256` 不变 | 未验证（会写产物，QA 不跑） |
| G2 | `node server/test/method-surface.mjs` | `public=51 / hidden=116 / nodeRegistered=167 / missing=[] / ghosts=[]` | **PASS**（E13 实测 rc=0） |
| G3 | `node frontend/app/tests/arch-contract.mjs` | **82/82**（I13 授权接入后仍须 82/82，或新数须显式裁决） | **PASS**（E13 实测 82/82） |
| G4 | `python tools/run_normalized_gates.py` | 12/12 →（I13 接入后）13/13；0 SKIP 伪造、0 FAIL；`serverGates=36` | 未验证（会写产物，QA 不跑） |
| G5 | `python tools/gate_coverage.py` | canonical 16/16 →（I13 后）17/17；`codeCoverage.status=blocked-by-environment` | 未验证（会写产物，QA 不跑） |
| G6 | `python deliverables/design/check_contract.py` | UI 五大契约 PASS | 未验证（本阶段未跑） |
| G7 | `pytest tests/ -q` | **476 passed / 2 skipped / 0 failed**；收集期 0 errors | 未验证（本阶段未跑全量，避免并发） |
| G8 | `git diff -- config.json` | **必须空** | **PASS**（E21 实测为空） |
| G9 | `git diff --stat` | 未触碰 `harbor.html`、`frontend/react/src/generated/*`、`frontend/styles/`、冻结快照、`config.json`；新增 `requirements-ci.txt` 为独立文件 | 未验证（并行中，最终由工程师全量清单确认） |

**三层区分口径**：G1–G9 的「命令 rc=0」只证明**构建通过**；「51/116/167、82/82、零漂移」才是**断言通过**；「功能可用」需 I19 的 EACCES 场景、I13 真问题 rc=1 等反例证明门真的会拦，二者不得互相冒充。

---

## 5. 逐轮独立验收矩阵（I01–I30）

> 字段说明：**正向**＝规格 §3 验收命令 + 可观察判据 + 期望 stdout/rc；**反例**＝注入模式（M/S/P）+ 注入方式 + 改动前实测 + 注入后期望失败信号；**恢复**＝统一引用 §2.4（例外单独写）；**契约回归**＝§4 中相关门；**状态**＝本阶段一律 `未验证（只读设计）`，工程师完成后由 QA 正式验收填写。
> 所有 `sandbox(...)` / `inject_replace(...)` 引用 §2.2；`CANONICAL/CI_ONLY` 内存复现引用 §6.1。

### 批次 T01 · I01–I06

#### I01 · `round_runner.py` CORE 自检
- **正向**：`$PY -c "import sys;sys.path.insert(0,'tools');import round_runner as r;from pathlib import Path;assert all(Path(t).is_file() for t in r.CORE)"` → rc=0 且 CORE 内 12 项全部 `is_file()`；`$PY tools/round_runner.py --help` rc=0。
- **反例（S）**：`inject_replace('tools/round_runner.py', 'tests/test_ci_tooling.py', 'tests/__QA_MISSING__.py')`（锚点须在改动后的 CORE 中存在；若工程师用 `test_contract_diff.py` 替换则改用该锚点）→ 期望 `import round_runner` **抛明确异常/非零 rc**，不得静默跳过。
- **正对照**：撤除注入 → `import` 成功、`--help` rc=0（证明实现不是「一律报错」）。
- **改动前实测**：原 CORE 含 `tests/test_group_files.py`、`tests/test_modern_build.py`（已删），当前无启动期自检 → 缺失文件会被静默跳过。
- **恢复** §2.4 / **契约回归** G7、G9 / **状态** 未验证。

#### I02 · CI_ONLY 检查面改为 YAML 非注释 `run:` 命令块 ⚠ 高价值
- **正向**：构造「把 YAML 全部 `run:` 行替换为占位符」的复现脚本 → 新逻辑 `covered < 16`（能检出缺失）；现状 `python tools/gate_coverage.py` 16/16。
- **反例 A（M，核心，必须做）**：只读内存复现，把 CI YAML 中 **`run: python tools/run_normalized_gates.py`（L83）仅替换为 `run: echo QA-PLACEHOLDER` 或整行删除，全部注释保留**（§6.1 脚本 `ciA`/`ciA2`）。
  - 改动前实测：**`covered=16/16, missing=[]` → 门仍判 PASS**（E03）。
  - 注入后期望失败信号：新逻辑 `covered < 16`、`missing` 至少含 `normalized-gate-entry`，`status=FAIL` / rc=1。
  - 判据要点：**注释 L58 `# R69 P0-④：本地与 CI 共用 tools/run_normalized_gates.py 单一入口` 不得被计为命中**。若实现仍全文包含 → 反例 PASS 即橡皮图章。
- **反例 B（M，任务点名）**：删除/占位化**全部** `run:` 行（§6.1 `strip_run_commands`）→ 新逻辑 `covered < 16` 且须显著低于 14；改动前实测 `14/16, missing=['release-discipline','ui-contract']`（E02）。**注意**：B 单独使用无效（当前已 FAIL），必须与 A 成对。
- **恢复** M 模式零污染 / **契约回归** G5、G9、G4 / **状态** 未验证。

#### I03 · GATES 解析式校验（消除读自身恒真）⚠ 高价值
- **正向**：构造「把 GATES 中某门路径改成不存在的文件」→ 新校验 FAIL；现状 16/16。
- **反例（M）**：`entry.replace("'tools/contract_golden_replay.py'", "'tools/__QA_MISSING__/contract_golden_replay.py'", 1)` —— **保留 token 子串、只改目录使其 `is_file()==False`**（§6.1 `entryC`）。
  - 改动前实测：**`covered=16/16, missing=[]` → PASS**（E04）。若改成完全不含 token 的路径，当前文本包含也会 MISS，反例就失去区分力 —— 这是注入精度要求。
  - 注入后期望失败信号：新校验报「门文件不存在 / `required=True` 校验失败」，rc=1。
- **补充反例（2026-11-12 经 QA 自修 #2 修正）**：把某门 `required` 由 `True` 改成**非布尔字面量**（`'True'` 字符串 / `None`）→ 新校验须报 `required-not-bool` 并 FAIL。
  - ⚠ **原稿错误，已作废**：原写「`True` 改 `False` → 须 FAIL」。实测 `False` 仍是**显式布尔**，`validate_gate_structure()` 只校验 `isinstance(required, bool)`，故 `PASS, errors=0`（仅 `requiredTrue` 由 10 变 9）。`frontend-l2` 本身就是合法的 `required=False`（11 门中唯一 optional 门）。工程师回传提醒后由 QA 独立实测确认并自行修正，详见 §9.7。
  - 实测：`True→'True'` → `FAIL errors=1 required-not-bool/gate-coverage`；`True→None` → `FAIL errors=1 required-not-bool/gate-coverage`；正样本 `PASS requiredTrue=10 errors=0`。
- **恢复** M 零污染 / **契约回归** G4、G5 / **状态** 未验证。
- 注：I02↔I03 同文件串行实现，**必须同批复验两个反例**。

#### I04 · engines 审计结论型迭代（零代码改动）
- **正向**：`$NODE -e "console.log(require('./package.json').engines)"`；`grep node-version .github/workflows/harbor-ci.yml`；`git diff -- package.json server/package.json` **必须为空**；台账登记 `v22.22.2` / CI `'22'` / `engines >=27.0.0-alpha` 三者不一致。
- **反例（S）**：沙箱副本把 `package.json` 的 `engines.node` 改为 `>=22` → 期望「配置零改动判据」FAIL。实现方式用可执行断言而非目视：
  ```bash
  git -C "$ROOT" diff --quiet -- package.json server/package.json; echo "rc=$?"   # 期望 rc=0
  ```
  并在沙箱里断言 `engines` 字面量仍为 `>=27.0.0-alpha`（若实现误改，此断言 FAIL）。
- **改动前实测**：E19 未涉及 engines，需工程师完成后核；本轮为「零改动」型，反例的价值在于**证明没偷偷改配置**。
- **恢复** §2.4 / **契约回归** G8、G9 / **状态** 未验证。

#### I05 · `requirements-ci.txt` 与 CI 依赖收口
- **正向**：`grep -n "requirements" .github/workflows/harbor-ci.yml` → 两处均指向 `requirements-ci.txt`；`cat requirements-win.txt` 原 13 条实体条目全在 + 顶部新增退役标注；CI 注释无「27 门」。
- **反例（S）**：在沙箱 CI YAML 副本中把 `requirements-ci.txt` 改回 `requirements-win.txt`（或删除新文件）→ 期望 `grep` 判据 FAIL；再删 `requirements-win.txt` 副本中的任一原条目 → 「原条目全在」断言 FAIL（验证「只增不删」）。
- **改动前实测**：E19 → CI 两处 `requirements-win.txt`、`requirements-ci.txt` 不存在、13 条实体条目、L61 注释含「server 27 门」。
- **恢复** §2.4 / **契约回归** G9（新增文件须为独立文件，不污染 `config.json`）/ **状态** 未验证。

#### I06 · note 动态计数
- **正向**：`$PY -c "import sys;sys.path.insert(0,'tools');import run_normalized_gates as g;print(len(g.server_gates()))"` → 与产物 `summary.serverGates` 一致；note 不得硬编码「64 项架构断言」「27 个」。
- **反例（S）**：沙箱副本在 `server/test/` 下**新增/删除**一个 `*.mjs`（非 `auth-migrate.mjs`）→ `len(server_gates())` 变化；期望产物 `serverGates` 与 note 文案同步变化；若 note 仍为固定数字 → FAIL。
- **改动前实测**：`run_normalized_gates.py:37` note「64 项架构断言」、L101 注释「27 个」均为硬编码（已读源码）。
- **恢复** §2.4 / **契约回归** G4 / **状态** 未验证。

### 批次 T02 · I07–I12

#### I07 · `check_release.py` 退役分支
- **正向**：`$PY tools/check_release.py --expect 1.9.0` rc=0；`grep -n "from backend" tools/check_release.py` 仅剩**说明性文字**。
- **反例（P，AST 判据）**：`grep` 会命中 docstring 第 18–19 行「不再 import backend」→ 判据必须用 AST 而非裸 grep：
  ```python
  import ast
  tree = ast.parse((ROOT/'tools/check_release.py').read_text(encoding='utf-8'))
  imports = [n for n in ast.walk(tree)
             if isinstance(n, (ast.Import, ast.ImportFrom))
             and (getattr(n, 'module', '') or '').startswith('backend')]
  assert imports == [], '退役后不得存在运行时 backend import'
  ```
  注入：沙箱副本加回 `from backend.domains.settings.config_service import ConfigService` 代码行 → AST 断言 FAIL。
- **功能反例**：沙箱在 `~/.glm-chat/config.json` 位置不可写时用 `HOME` 重定向注入含 `version` 键的 config → R6 必须报污染 rc=1（证明退役分支真的读了 config.json 而非恒 `cfg={}`）。
- **恢复** §2.4 / **契约回归** G7 / **状态** 未验证。

#### I08 · 4 处 backend 降级改冻结快照
- **正向**：`grep -rn "from backend\|import backend" tests/ tools/diag/state_probe.py` 零**运行时**命中；`pytest tests/ -q` 收集期 0 errors；`conftest.py` docstring「已退役」。
- **反例（P+S）**：AST 扫描上述路径无 `ImportFrom(module='backend*')`；沙箱副本往 `tests/helpers/state_reset.py` 加回运行时 `from backend… import` → AST 门 FAIL。注入 `_CONTRACT_LAYER_RETIRED=True` 常量缺失 → 常量存在性断言 FAIL。
- **恢复** §2.4 / **契约回归** G7 / **状态** 未验证。

#### I09 · `scan_stubs()` 剥离注释 + `guardType` ⚠ 高价值
- **正向**：重跑扫描 → `main.py.backendImport=False`；9 个 stub 均 `guardType` 明确且 `usesDirectoryGuard=False`；`node frontend/app/tests/arch-contract.mjs` 82/82 不退化。
- **反例 A（S，任务点名）**：沙箱副本 `main.py` 注入**纯注释** `# 不再 import backend` / `"""import backend"""`（当前文件 L4–L5 已天然存在）→ 修复后 `backendImport` 必须仍为 **False**。改动前实测 **True**（E05），且 8/9 stub 判 True。
- **反例 B（正对照，必须做）**：沙箱副本 `main.py` 注入**真实代码行** `import backend`（非注释）→ 修复后 `backendImport` 必须为 **True**。若实现「一律 False」也能过 A，B 用于戳破。
- **反例 C**：注入一个 `usesDirectoryGuard` 为真的 stub（`is_dir()` 判据）→ 门必须 FAIL；9 个 stub 的 `guardType` 三分类（`file-guard`/`import-guard`/`pure-stub`）须全部非空。
- **改动后期望失败信号**：`post-deletion-audit-r69.json` 中 `retiredStubs[main.py].hasBackendLiteral` 变化；`arch-contract.mjs:644-649` 断言集不退化。
- **恢复** §2.4（产物写副本）/ **契约回归** G3、G4 / **状态** 未验证。

#### I10 · `scan_stale_docs()` 正则族 + 活跃入口集 ⚠ 高价值
- **正向**：重跑扫描 → `staleDocs>0` 且命中 `AGENTS.md`、`README.md`、`开发说明.txt`、`frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md`；`STEP5-DELETION-BOUNDARY.md` / `HANDOVER-R69.md` **不被误判**；`ALLOW_PREFIX('deliverables/dev-plan/')` 与 `ALLOW_FILES` 豁免保留。
- **反例 A（S）**：沙箱副本往 4 个活跃入口文档各注入一句陈旧表述（如 `Python 契约层仍在`、`步骤 5 未执行`、`不得先删`）→ `staleDocs` 必须命中这 4 个文件；**特别注意 `开发说明.txt` 是 `.txt`**，若实现仍只扫 `.md` 则漏判 → FAIL。
- **反例 B（不误判）**：往 `STEP5-DELETION-BOUNDARY.md` / `HANDOVER-R69.md` 副本注入**同样的历史原文** → 必须**不命中**（豁免生效）；若命中即误判，门 FAIL。改动前实测：两者均含 `不得先删` 且在 `ALLOW_FILES`，当前不误判（E08）。
- **反例 C（正对照）**：撤除全部注入 → `staleDocs` 不含这 4 个文件（防止「一律命中」）。
- **改动前实测**：`staleDocs=0`、4 入口 phraseHits 全空（E06/E07）。
- **恢复** §2.4 / **契约回归** G3、G4（I27 同批复验）/ **状态** 未验证。

#### I11 · `contract-coverage.mjs` 加 167 下界 ⚠ 高价值
- **正向**：`$NODE server/test/contract-coverage.mjs` → `ok:true, legacy_methods:167, migrated:167`。
- **反例（S，已实测可执行）**：`inject_replace('server/test/contract-coverage.mjs', "const { listMethods } = await import('../src/registry.js')", "const listMethods = () => []  /* QA-INJECT */")`，副本只需 `server/test/` + `deliverables/dev-plan/frozen-python-surface.json`（§6.2 脚本）。
  - 改动前实测：**锚点命中 True、注入后 `rc=0`、`ok:true, migrated:0`**（E14）→ 空集恒真。
  - 注入后期望失败信号：`AssertionError`（`registered.size !== 167` 或 `legacy.size !== 167`）、**rc=1**，输出不得为 `ok:true`。
- **正对照**：不注入 → `migrated:167` 且 rc=0。
- **恢复** S 自动清理 / **契约回归** G2、G4（server-gates 聚合）/ **状态** 未验证。

#### I12 · `contract-signatures.mjs` / `contract-golden.mjs` ⚠ 高价值
- **正向**：`$NODE server/test/contract-signatures.mjs` → `checked:167, mismatches:[]`；空对象注入时 FAIL；`$NODE server/test/contract-golden.mjs` 仍 `order_identical:true`；注释「50 个公开方法」→ 51、L44 `>=40` → `===51`（A3 同步）。
- **反例（S，已实测可执行）**：`inject_replace('server/test/contract-signatures.mjs', "const { listSignatures } = await import('../src/registry.js')", "const listSignatures = () => ({})  /* QA-INJECT */")`。
  - 改动前实测：**`rc=0`、`ok:true, checked:0, mismatches:[]`**（E14）。
  - 注入后期望失败信号：rc=1，`Object.keys(node).length !== 167`。
- **A3 反例**：沙箱把 `contract-golden.mjs:44` 的 `>=40` 改回宽松值、或把 `frozenInfo.methods` 副本裁到 50 → 若 L44 未改 `===51` 则仍 PASS（橡皮图章）；改动后必须 FAIL。
- **恢复** §2.4 / **契约回归** G2、G4 / **状态** 未验证。

### 批次 T03 · I13–I18

#### I13 · verdict 动态化 + 第 13 门接入 ⚠ 关键路径／带兜底 ⚠ 高价值
- **正向**：`$PY tools/run_normalized_gates.py` → 13/13；`$PY tools/post_deletion_audit.py` rc=0 且 verdict 随注入真问题变化；`node frontend/app/tests/arch-contract.mjs` 82/82；A2/A5 四处硬锚点同批同步。
- **反例 A（S，已实测可执行）**：`sandbox(files=[...见 §6.3...], mutate=往 CI YAML 副本追加 'run: python backend/domains/settings/config_service.py', cmd_fn=[PY, dst/tools/post_deletion_audit.py], capture_json='deliverables/dev-plan/post-deletion-audit-r69.json')`。
  - 改动前实测：死引用检出 `backend-in-runtime-config:1`，但 **rc=0、`realDefectsFound=1`（静态）、`fixedFiles.length=6`（静态）**（E15）。
  - 注入后期望失败信号：**rc=1**，`verdict.realDefectsFound` 与 `fixedFiles` **动态变化**（不再是 1/6），`deadReferences.byKind['backend-in-runtime-config']>=1`。
- **反例 B（A2 锚点同步，必须做）**：在注入真问题后运行 `node frontend/app/tests/arch-contract.mjs`（沙箱副本需含 `frontend/app/tests/`、`AGENTS.md`、`Harbor.spec` 等）→ 若 `arch-contract.mjs:647-648` 仍是 `realDefectsFound===1` / `fixedFiles.length===6`，则动态 verdict 会让该 check **FAIL**。期望：A2 两条断言已改为动态口径，注入下 82/82 仍成立或按新裁决显式给出期望值。**这一条专门抓「改了脚本忘了同步硬锚点」**。
- **反例 C（A5 同步）**：把 `gate_coverage.CANONICAL` 副本改回 16 项 / CI YAML 注释未同步 / `tests/test_ci_tooling.py` 未更新 → `gate_coverage` 与 `run_normalized_gates` 17 项口径不一致 → 门 FAIL。
- **回退路径登记**：若 3 轮收敛仍无法同时满足 13/13 与 82/82 → 按规格 §0 裁决回退「12 门 + I14 独立版 + 手工体检」，台账如实登记「回退」，**不判失败、不伪造通过**；此时反例 A 的 rc=1 判据改为「独立版体检输出含真问题」。
- **恢复** §2.4（产物写副本）/ **契约回归** G3、G4、G5、G7 / **状态** 未验证。

#### I14 · 产物新鲜度断言 ⚠ 高价值
- **正向**：`statSync(post-deletion-audit-r69.json).mtimeMs >= statSync(normalized-gates-r69.json).mtimeMs - 容差` 或校验 `generatedAt`；I13 接入后 82/82。
- **反例（S，任务点名）**：**在沙箱副本内** `os.utime(post-audit, ns=(..., 旧时间戳))` 或用 `touch -t 200001010000`，使 post-audit 比 normalized-gates 陈旧 → 该项 check 必须 **FAIL**（82→81/82、rc=1）。
- **⚠ 实现口径决定反例有效性**：若实现走 **mtime**，touch 生效；若实现走 **`generatedAt` 字段**，touch 改不了内容 → 该反例**会假通过**，必须改为「复制一份旧 `generatedAt` 的产物覆盖副本」再验。QA 必须先读实现确定口径，再选对应注入，不得直接套用 touch 脚本。
- **⚠ 并发陷阱（E22 实测）**：真实现场 `post-deletion-audit-r69.json` 19:02 已比 `normalized-gates-r69.json` 22:56 陈旧约 4h —— 工程师每跑一次统一入口就刷新 mtime。**禁止在真实工作区做 touch 反例**（会污染产物且时灵时不灵）；验收前须确认「基线是否本就陈旧」，区分「注入致陈旧」与「基线陈旧」。
- **恢复** §2.4 的 `os.utime` 精确恢复 / **契约回归** G3、G4 / **状态** 未验证。

#### I15 · `NON_GATE_SCRIPTS` 与 `excluded`
- **正向**：`$PY -c "…print(len(g.server_gates()))"` → **36**，与 I05/I06 注释一致；产物含 `excluded` 字段。
- **反例（S）**：沙箱 `server/test/` 下新增 `qa-probe.mjs`（模拟探针）→ 若未进 `NON_GATE_SCRIPTS`，`serverGates` 变 37 → 门 FAIL；再删掉 `node-sqlite-probe.mjs` 副本 → 若常量硬编码未同步 → `excluded` 与实际不符 → FAIL。
- **恢复** §2.4 / **契约回归** G4 / **状态** 未验证。

#### I16 · `--strict` 语义 ⚠ 高价值
- **正向**：`$PY tools/check_static_paths.py --strict --json` → `strict:true` 且 findings 非空时 **rc=1**；不加 `--strict` **rc=0**。
- **反例（P，已实测可执行）**：内存注入 `find_legacy_references=lambda root: FAKE`、`check_template_paths=lambda root: []`，`sys.argv` 分别设 `--json` / `--strict --json`，调 `main()` 取 rc（§6.4 脚本）。**必须构造 findings**（当前工作区 findings 恒 0，E11；只跑 `--strict` 会得到 rc=0 的**假通过**）。
  - 改动前实测：非 strict `rc=1, strict=False` / `--strict` `rc=1, strict=True` —— **两种无分叉，`--strict` 是死参数**（E12）。
  - 注入后期望失败信号：**非 strict rc=0 / strict rc=1**，且 `report.strict` 与 argv 一致。
- **正对照**：FAKE 置空 → 两种模式均 rc=0。
- **恢复** P 零污染 / **契约回归** G4 / **状态** 未验证。

#### I17 · `SCAN_DIRS` 扩到 8 + 契约层路径正则
- **正向**：`$PY tools/check_static_paths.py --json` → 扫描面含 8 目录；构造含 `backend/api.py` 的假配置行能命中。
- **反例 A（S）**：沙箱 `electron/qa-fixture.js` 写入 `backend/services/foo` → 若 `SCAN_DIRS` 未加 `electron` 则 `findings=0` → 门 FAIL（漏检）。同样对 `server/`、`.github/` 各放一个样本。
- **反例 B**：沙箱运行时配置文件写入 `backend/domains/foo.py` → 新增正则须命中 `deleted-contract-path` 类；注入 `frontend/src/123-legacy.js` → `legacy-flat-js` 类须命中且**只在 strict 下影响 rc**（与 I16 联动）。
- **改动前实测**：`SCAN_DIRS` 5 目录、`findings=0`（E11）。
- **恢复** §2.4 / **契约回归** G4 / **状态** 未验证。

#### I18 · `test_ci_tooling.py` CI 断言 ⚠ 高价值
- **正向**：`pytest tests/test_ci_tooling.py -q` 全过；`test_workflow_yaml_parses` 覆盖 **3 个 job**（`gate` / `normalized-gates` / `entry-sweep`）；文本包含改为「非注释行命中」。
- **反例（S，任务点名）**：沙箱 CI YAML 副本**删除 `run: python tools/run_normalized_gates.py`（L83），但保留 L58 注释** → 新用例必须 **FAIL**。若新用例仍是全文包含，则会因注释命中而 PASS（橡皮图章）。
- **反例 B（任务点名）**：把某依赖名改错（如 `python -m pip install -r requirements-ci.txt` → `requirements-CI-typo.txt`）→ 用例须 FAIL。
- **反例 C**：`test_workflow_yaml_parses` 删除 `normalized-gates` job → 3-job 断言 FAIL。
- **改动前实测**：现有用例**不含** `run_normalized_gates` 断言；`test_workflow_yaml_parses` 仅断言 `gate`+`entry-sweep`（E19）。
- **恢复** §2.4 / **契约回归** G7、G9 / **状态** 未验证。

### 批次 T04 · I19–I24

#### I19 · `readJsonIfExists` 结构化 `warnings` ⚠ 高价值
- **正向**：新增 `node --test` 用例覆盖「损坏 JSON → fallback」「模拟 EACCES → warnings 非空」；`$NODE server/test/method-surface.mjs` 仍 `ok:true`。
- **反例（P，任务点名）**：`node --test` 中 `import { mock } from 'node:test'`、`import fs from 'node:fs'`，`mock.method(fs, 'readFileSync', () => { const e = new Error('EACCES'); e.code='EACCES'; throw e })` → 断言 `readJsonIfExists(file, fb) === fb`（**返回值仍是 fallback，零行为变更**）且 `warnings` 非空、含 `code/path`、有界。
  ```js
  test('非 ENOENT 异常 → warnings 非空且返回 fallback', () => {
    const fb = { sentinel: true }
    const err = Object.assign(new Error('EACCES injected'), { code: 'EACCES' })
    const restore = mock.method(fs, 'readFileSync', () => { throw err })
    try {
      assert.deepEqual(readJsonIfExists('/qa/eacces.json', fb), fb)
      assert.ok(getWarnings().length > 0)       // 具体读取接口以实现为准
    } finally { restore() }
  })
  ```
- **正对照（三态，防「一律写 warnings」）**：ENOENT → fallback + warnings 不增长；`SyntaxError`（损坏 JSON）→ fallback，按规格「非 ENOENT / 非 SyntaxError 才写 warnings」口径判定；`mock.restore()` 后调用行为回到原状。
- **零行为变更反例**：对现有调用方做一次前后 stdout 对比，注入 EACCES 前后除 `warnings` 外输出逐字节一致。
- **恢复** P 进程内 / **契约回归** G2、G4 / **状态** 未验证。

#### I20 · `_latest_git_tag()` 三态
- **正向**：`$PY tools/check_release.py --expect 1.9.0` rc=0；monkeypatch `subprocess.run` 抛 `TimeoutExpired` → 输出含**显式 warning** 而非 `[skip]`。
- **反例（P）**：`import check_release as c; c.subprocess.run = lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired('git', 30))` → 调 `c._latest_git_tag()` 后 `main()` 输出**不得**含 `[skip] R3 无 git tag（本地开发环境）`，须含 `warning`/`fails` 显式留痕。改动前 `except Exception: return ''` 会把超时吞成 `[skip]`。
- **正对照**：成功且有 `v*.*.*` tag / 成功但无 tag / 失败三态分别可区分。
- **恢复** P / **契约回归** G7 / **状态** 未验证。

#### I21 · datas 正则 + spec 缺失不 traceback ⚠ 高价值
- **正向**：复现脚本两式一致 True；临时移走 spec 副本 → 输出 `R7 缺少…` 且 **rc=1、无 traceback**。
- **反例 A（M，任务点名，已实测）**：样本 `datas = [('n','node_modules')]`，`old=r'datas[^\\n]*node_modules'` → **False**，`new=r'datas[^\n]*node_modules'` → **True**（E09）。**必须用构造样本**：真实 `Harbor.spec` 上两式均 False（E10），只跑真实文件证明不了修复。
- **反例 B（S，已实测可执行）**：`sandbox(files=[check_release.py, VERSION, frozen 快照, 4 个 UiSchema 文件, Harbor-mac.spec]（**故意不含 Harbor.spec**）, cmd_fn=[PY, dst/tools/check_release.py, '--expect','1.9.0'])` → 改动前 **rc=1 + `Traceback ... FileNotFoundError: Harbor.spec`**（E16）；改动后须 `rc=1` 且 stdout 含 `R7 缺少`、`'Traceback' not in out`。
- **恢复** §2.4 / **契约回归** G7 / **状态** 未验证。

#### I22 · `arch_assessment.layer()` readErrors
- **正向**：连续两次运行产物 sha256 一致（幂等）；注入不可读文件后 `readErrors` 非空。
- **反例（P）**：`import arch_assessment as aa; _o=aa.io.open; aa.io.open = lambda p,*a,**k: (_ for _ in ()).throw(OSError('EACCES injected')) if str(p).endswith('UNREADABLE.js') else _o(p,*a,**k)`；沙箱 `server/src/` 放 `UNREADABLE.js` → `aa.layer('server/src')['readErrors']` 必须非空。改动前该函数只返回 `files/lines`（无 `readErrors`）→ KeyError，证明改动有效。
- **幂等反例**：同一输入连跑两次，对产物取 `sha256` 必须相等；注入 `readErrors` 后仍保持确定性（错误列表顺序稳定）。
- **恢复** P / **契约回归** G4 / **状态** 未验证。

#### I23 · JSDoc 试点扩 3 模块 ⚠ 高价值
- **正向**：`$PY tools/type_annotation_audit.py` → `PASS, coverage=100%, regressions=[]`；SCOPE 4 文件；`node server/test/method-surface.mjs` 仍 `ok:true`；独立基线 JSON 更新且「只增不减棘轮」。
- **反例（S）**：沙箱副本删掉 `server/src/config.js` 的 `@type` 行 → `coverage<100%` → 门 **FAIL**；把 `type-annotation-baseline-r69.json` 副本的 `coverage` 调到 101 / `exportedSymbols` 调大 → `regressions` 非空 → FAIL。
- **正对照**：撤除注入 → 100%、`regressions=[]`。
- **零行为变更反例**：对 3 个新模块的导出做 `node --test` 冒烟，改注释前后输出一致（注释级改动不触碰运行时）。
- **恢复** §2.4 / **契约回归** G2、G4 / **状态** 未验证。

#### I24 · `DOC_RE` 紧邻匹配 + 最小格式校验 ⚠ 高价值
- **正向**：构造「符号前插普通注释」临时样本 → `annotated=false`；`$PY tools/type_annotation_audit.py` 仍 100%；删死代码。
- **反例（P，已实测，四样本成对）**：重定向 `type_annotation_audit.ROOT` 到临时目录（§6.5 脚本）：
  | 样本 | 内容 | 改动前实测 | 改动后期望 |
  |---|---|---|---|
  | `adjacent.js`（正样本） | JSDoc 紧邻 + `@type {number}` | `True` | **仍 True** |
  | `interleaved.js`（任务点名负样本） | JSDoc 与符号间插 `// 普通注释` | `False` | **False** |
  | `novalue.js`（强反例） | `/** @type */` 标签无值 | **`True`（误判）** | **False** |
  | `unbalanced.js`（强反例） | `/** @type {number */` 括号不配对 | **`True`（误判）** | **False** |
  - **关键**：`interleaved.js` 改动前已判 False（E17）→ **只用它作反例是橡皮图章**（实现「一律判 false」也能过）。必须由 `adjacent.js`（正对照）+ `novalue/unbalanced`（格式校验）共同构成有效反例集。
- **恢复** P / **契约回归** G4 / **状态** 未验证。

### 批次 T05 · I25–I30

#### I25 · `AGENTS.md` 口径收口（A1 硬锚点）⚠ 高价值
- **正向**：`node frontend/app/tests/arch-contract.mjs` **82/82 不退化**；`grep -n "from backend.api import" AGENTS.md` **零命中**；`grep -n "2.3 R69 Agent 浏览器闭环" AGENTS.md` **仍命中**。
- **反例 A（S，任务点名）**：沙箱 `AGENTS.md` 副本把标题 `2.3 R69 Agent 浏览器闭环` 改成 `2.3 R70 Agent 浏览器闭环`（**只改标题、内容全留**）→ 运行副本 `frontend/app/tests/arch-contract.mjs`（需一并复制 `frontend/app/tests/`、`AGENTS.md`、`Harbor.spec` 等依赖）→ 第 662 行 check 必须 **FAIL**（82→81/82，rc=1）。这证明 A1 真的在校验标题字面量，而非「文件存在即通过」。
- **反例 B**：沙箱 `AGENTS.md` 加回 `from backend.api import Api` → `grep` 零命中判据 FAIL。
- **反例 C（正对照）**：撤除注入 → 82/82、标题命中、`from backend.api import` 零命中同时成立。
- **改动前实测**：标题命中 **1**、`from backend.api import` 命中 **1**、A1 正则在架 True（E18）。**注意标题实际是 `### 2.3 ...`（三级标题）**，规格/派单写作 `##`；判据以正则字面量 `/2\.3 R69 Agent 浏览器闭环/` 为准，不要用错 grep 模式。
- **恢复** §2.4 / **契约回归** G3、G9（只改文档，不触碰机器产物）/ **状态** 未验证。

#### I26 · README / 开发说明 只增不删
- **正向**：`head -20 README.md` 含 R70 退役声明；`python deliverables/design/check_contract.py` UI 五大契约仍 PASS；契约差分零漂移。
- **反例（S）**：沙箱副本**删掉** README 任一段历史原文 → 「只增不删」判据 FAIL。可执行判据：改动前后 `len(lines)` 不减少 + 原文关键子串仍在 + `git diff -- README.md 开发说明.txt` 仅含新增行（无 `-` 行）。
- **恢复** §2.4 / **契约回归** G1、G6、G9 / **状态** 未验证。

#### I27 · 标题/状态行收口
- **正向**：`grep -n "^#" …` 标题无「待确认/未执行」；`STEP5-DELETION-BOUNDARY.md` §1-5 **行数不变**；重跑 I10 的 `scan_stale_docs()` **不再命中**这 2 文件。
- **反例（S）**：沙箱把 EXIT-PLAN 标题改回「步骤 5 未执行（待确认）」→ 标题断言 FAIL；把 §1-5 删一行 → 行数断言 FAIL；往两文件注入陈旧短语 → I10 正则族须**不因豁免而漏判活跃文档**（与 I10 反例 B 联动）。
- **恢复** §2.4 / **契约回归** G3、G4 / **状态** 未验证。

#### I28 · `arch_assessment.py` ci_tokens / retired 标注
- **正向**：CI token 命中数与 gate_coverage 口径对齐；`pythonContract` 层 `retired:True` 且 `files:0`；产物幂等 sha256 一致。
- **反例（S）**：沙箱 CI YAML 副本**仅删除 `run: python tools/run_normalized_gates.py`、保留 L58 注释** → 若 `ci_tokens` 仍是全文包含，`detectedTokens` 不会减少 → 反例 FAIL（与 I02 同一类「注释命中」陷阱）。改动后须按「非注释 run: 块」口径使该 token 消失。
- **反例 B**：把 `ci_tokens` 副本中 4 个新增 token 删掉 → 命中数与 G5 不一致 → FAIL。
- **恢复** §2.4 / **契约回归** G4、G5 / **状态** 未验证。

#### I29 · 依赖零死重改为 server 侧 ⚠ 高价值
- **正向**：`pytest tests/test_api_surface_consistency.py -q` 全过且**输出每个依赖的「命中文件」证据**；把某依赖名改错 → 用例 FAIL；未命中者显式登记豁免理由（**不删依赖**）；移除 `backend/**/*.py` glob。
- **反例（S，任务点名）**：沙箱 `server/package.json` 把 `fastify` 改名为 `fastify-QA-BROKEN` → 新用例须 **FAIL**（未命中且不在显式豁免白名单）。
- **⚠ 反例强度要求**：若实现把「未命中依赖」**运行时自动登记豁免**，则改错依赖名会被自动豁免吞掉、用例仍 PASS → **橡皮图章**。判据必须要求：豁免是**代码中的显式白名单常量**（人工逐条登记理由），不得按运行时结果自动豁免；反例脚本须附带检查「豁免集合是字面量常量、不随注入变化」。
- **正对照**：撤除注入 → 12 个依赖逐个输出命中文件、全过。
- **改动前实测**：根 `package.json` `dependencies={}` → `for name in deps` 恒真、`dead=[]`、用例恒过；server deps 12 个（E19）。
- **恢复** §2.4 / **契约回归** G7、G9（不删依赖）/ **状态** 未验证。

#### I30 · 注释级口径收口
- **正向**：`grep -n "Node 24.22.1\|main.py\|即将退役" electron/main.js tests/conftest.py` **零命中**（保留的「历史 seam」措辞除外，须在报告中逐条说明）；`pytest tests/ -q` 收集期 0 errors；`engines >=27` 未来基线口径在 `electron/main.js` 注释中引用 I04 裁决。
- **反例（S）**：沙箱把 `electron/main.js` 的旧注释写回（`内嵌 Node 24.22.1`、`main.py / backend/ Python 零改动`）或把 `tests/conftest.py` docstring 改回「即将退役」→ grep 零命中判据 FAIL。
- **正对照**：撤除注入后须同时满足「零命中」+「历史 seam 措辞存在且不误伤」+ pytest 0 errors。
- **零行为变更**：`electron/main.js` 与 `conftest.py` 均为注释级，`git diff` 不得出现非注释行变更。
- **恢复** §2.4 / **契约回归** G7、G9 / **状态** 未验证。

---

## 6. 高价值反例脚本全集（可直接复制执行）

### 6.1 I02/I03 内存复现（M 模式，零落盘；§3 E01–E04 即此脚本输出）
```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" - <<'PY'
import sys
from pathlib import Path
ROOT = Path(r'C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包')
sys.path.insert(0, str(ROOT / 'tools'))
import gate_coverage as gc
ci    = (ROOT / '.github/workflows/harbor-ci.yml').read_text(encoding='utf-8')
entry = (ROOT / 'tools/run_normalized_gates.py').read_text(encoding='utf-8')

def calc(ci_text, entry_text):
    surface = ci_text + '\n' + entry_text
    covered = sorted(k for k, t in gc.CANONICAL.items()
                     if t in (ci_text if k in gc.CI_ONLY else surface))
    return len(covered), sorted(set(gc.CANONICAL) - set(covered))

def strip_run_commands(text):
    """纯字符串状态机：删 run: 行及其多行块内容，保留全部注释。"""
    out, in_block, run_indent = [], False, 0
    for ln in text.splitlines():
        s = ln.strip(); indent = len(ln) - len(ln.lstrip())
        if (s.startswith('run:') or s.startswith('- run:')) and not s.startswith('#'):
            in_block, run_indent = True, indent; continue
        if in_block:
            if (not s) or indent > run_indent: continue
            in_block = False
        out.append(ln)
    return '\n'.join(out)

ciB = strip_run_commands(ci)                                   # 反例 B：全删
ciA = ci.replace('run: python tools/run_normalized_gates.py',
                 'run: echo QA-PLACEHOLDER', 1)                # 反例 A：仅占位化关键行
assert ciA != ci, '注入锚点失效'
ciA2 = '\n'.join(x for x in ci.splitlines()
                 if 'run: python tools/run_normalized_gates.py' not in x)
entryC = entry.replace("'tools/contract_golden_replay.py'",
                       "'tools/__QA_MISSING__/contract_golden_replay.py'", 1)
assert entryC != entry, 'GATES 注入锚点失效'
for tag, c, e in [('原始', ci, entry), ('B-全删run', ciB, entry),
                  ('A-仅占位关键run', ciA, entry), ('A2-仅删关键run', ciA2, entry),
                  ('C-GATES路径不存在', ci, entryC)]:
    print('%-22s covered=%s' % (tag, calc(c, e)))
PY
```
**改动前期望**（实测）：`原始 (16,[])` / `B (14,['release-discipline','ui-contract'])` / `A (16,[])` / `A2 (16,[])` / `C (16,[])`。
**改动后期望**：`A/A2/C` 至少出现 `missing` 非空或新校验报错；`B` 的 covered 显著低于 14。

### 6.2 I11/I12 空集恒真沙箱（S 模式；§3 E14 即此脚本输出）
```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" - <<'PY'
import tempfile, shutil, subprocess
from pathlib import Path
ROOT = Path(r'C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包')
NODE = r'C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
TARGETS = {
 'contract-coverage.mjs': ("const { listMethods } = await import('../src/registry.js')",
                           "const listMethods = () => []  /* QA-INJECT */"),
 'contract-signatures.mjs': ("const { listSignatures } = await import('../src/registry.js')",
                             "const listSignatures = () => ({})  /* QA-INJECT */"),
}
for name, (anchor, repl) in TARGETS.items():
    with tempfile.TemporaryDirectory(prefix='qa-r70-') as d:
        dst = Path(d)
        (dst/'server'/'test').mkdir(parents=True)
        (dst/'deliverables'/'dev-plan').mkdir(parents=True)
        src = (ROOT/'server'/'test'/name).read_text(encoding='utf-8')
        assert anchor in src, '注入锚点失效：' + name       # ← 必须自检
        (dst/'server'/'test'/name).write_text(src.replace(anchor, repl, 1), encoding='utf-8')
        shutil.copy2(ROOT/'deliverables'/'dev-plan'/'frozen-python-surface.json',
                     dst/'deliverables'/'dev-plan'/'frozen-python-surface.json')
        r = subprocess.run([NODE, str(dst/'server'/'test'/name)], cwd=str(dst),
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=60)
        print(name, 'rc=', r.returncode, '|', ((r.stdout or '')+(r.stderr or '')).strip()[-200:])
PY
```
**改动前**：两个门均 `rc=0`（`ok:true, migrated:0` / `checked:0`）。**改动后**：两个门均须 `rc=1`（AssertionError 167 下界）。

### 6.3 I13 verdict 动态化沙箱（S 模式；§3 E15 即此脚本输出）
```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" - <<'PY'
# 引用 §2.2 sandbox()；FILES 为最小骨架
FILES = ['tools/post_deletion_audit.py',
         'deliverables/dev-plan/deletion-manifest.json',
         'deliverables/dev-plan/frozen-python-surface.json',
         '.github/workflows/harbor-ci.yml', 'Harbor.spec', 'Harbor-mac.spec',
         'package.json', 'requirements-win.txt', 'requirements-mac.txt',
         'README.md', 'AGENTS.md', 'KNOWN_ISSUES.md', 'main.py',
         'main_v1.0.0_legacy.py', 'harbor.html', 'server/src/registry.js']
def mutate(dst):
    p = dst/'.github/workflows/harbor-ci.yml'
    s = p.read_text(encoding='utf-8')
    p.write_text(s + '\n# QA-INJECT 运行时配置类真问题\n'
                     'run: python backend/domains/settings/config_service.py\n',
                 encoding='utf-8')
rc, out, doc = sandbox(FILES, mutate,
    cmd_fn=lambda d: [PY, str(d/'tools/post_deletion_audit.py')],
    capture_json='deliverables/dev-plan/post-deletion-audit-r69.json')
print('rc=', rc, '| realDefectsFound=', doc['verdict']['realDefectsFound'],
      '| fixedFiles.len=', len(doc['verdict']['fixedFiles']),
      '| backend-in-runtime-config=', doc['deadReferences']['byKind'].get('backend-in-runtime-config'))
PY
```
**改动前**：`rc=0, realDefectsFound=1, fixedFiles.len=6, backend-in-runtime-config=1`（E15）。
**改动后**：**`rc=1`** 且 verdict 两字段动态变化；A2 反例另跑 `arch-contract.mjs` 副本验 647-648 已同步。

### 6.4 I16 `--strict` 分叉（P 模式；§3 E12 即此脚本输出）
```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" - <<'PY'
import sys, io, json, contextlib
from pathlib import Path
ROOT = Path(r'C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包')
sys.path.insert(0, str(ROOT/'tools'))
import check_static_paths as csp
FAKE = [{'path':'electron/qa-fixture.js','line':7,'kind':'backend-services','value':'backend/services/foo'},
        {'path':'tools/qa-fixture.js','line':3,'kind':'legacy-flat-js','value':'frontend/src/123-legacy.js'}]
csp.find_legacy_references = lambda root: FAKE       # 必须构造 findings
csp.check_template_paths   = lambda root: []
for flags in ([], ['--strict']):
    sys.argv = ['check_static_paths.py', *flags, '--json']
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): rc = csp.main()
    rep = json.loads(buf.getvalue())
    print(flags or '(非 strict)', 'rc=', rc, 'ok=', rep['ok'], 'strict=', rep['strict'])
PY
```
**改动前**：`(非strict) rc=1` / `(--strict) rc=1`（E12）。**改动后**：`非strict rc=0` / `strict rc=1`。撤除 FAKE 的正对照：两种均 rc=0。

### 6.5 I24 四样本正负对照（P 模式；§3 E17 即此脚本输出）
```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 "$PY" - <<'PY'
import sys, tempfile
from pathlib import Path
ROOT = Path(r'C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包')
sys.path.insert(0, str(ROOT/'tools'))
import type_annotation_audit as taa
S = {'adjacent.js':    '/**\n * @type {number}\n */\nexport const A = 1\n',
     'interleaved.js': '/**\n * @type {number}\n */\n// 普通注释插在中间\nexport const B = 2\n',
     'novalue.js':     '/**\n * @type\n */\nexport const C = 3\n',
     'unbalanced.js':  '/**\n * @type {number\n */\nexport const D = 4\n'}
with tempfile.TemporaryDirectory(prefix='qa-r70-i24-') as d:
    tmp = Path(d)
    for n, b in S.items(): (tmp/n).write_text(b, encoding='utf-8')
    orig = taa.ROOT; taa.ROOT = tmp
    for n in S: print(n, [(s['name'], s['annotated']) for s in taa.audit(n)])
    taa.ROOT = orig
PY
```
**改动前**：`A=True / B=False / C=True / D=True`（E17）。**改动后**：`A=True / B=False / C=False / D=False`。

### 6.6 I14 新鲜度反例（S 模式，含精确恢复；**禁止在真实工作区执行**）
```python
import os, time
# 在 sandbox() 副本内执行；先记录原始 ns，finally 精确恢复
p = dst/'deliverables/dev-plan/post-deletion-audit-r69.json'
st = os.stat(p); a0, m0 = st.st_atime_ns, st.st_mtime_ns
try:
    old = int(time.mktime(time.strptime('2000-01-01', '%Y-%m-%d')) * 1e9)
    os.utime(p, ns=(old, old))                      # mtime 口径 → 注入陈旧
    rc, out, _ = run_arch_contract(dst)             # 期望 rc=1，check 名含「新鲜度」
    assert rc == 1 and 'Traceback' not in out, '反例未生效'
finally:
    os.utime(p, ns=(a0, m0))                        # 精确恢复
```
> 若实现走 `generatedAt` 字段：把 `os.utime` 换成「用旧 `generatedAt` 的 JSON 覆盖副本产物」，否则 touch 反例会假通过（见 §5 I14 口径警告）。

---

## 7. 环境阻塞的诚实登记与偶发 FAIL 判据

### 7.1 阻塞项（一律 `blocked-by-environment`，不得伪造）
| 项 | 状态 | 说明 |
|---|---|---|
| TypeScript / `tsc --noEmit` / `checkJs` | `blocked-by-environment` | 未安装 + 无外网；`type_annotation_audit.py` 的 `staticTypeCheck` 已如实标注。**JSDoc 覆盖率 ≠ 静态类型检查**，I23/I24 的 100% 不得冒充类型检查通过 |
| 代码覆盖率（pytest-cov / coverage / c8 / nyc） | `blocked-by-environment` | `gate_coverage.py` 的 `codeCoverage.status` 已标注；**门禁覆盖率 ≠ 代码覆盖率**，16/16 不得冒充 |
| 真机 `dist/Harbor.exe` 复验 | 未执行 | 由用户提供截图，本轮不主动启动 exe |
| 新增 CA 证书 warning | 环境噪声，非失败 | `Ignoring extra certs ... system-ca-bundle.pem ... error:80000003`，见 §3 末 |

### 7.2 已知偶发：`test_function_graph_build_performance_under_baseline`
- 现象：全量高负载下偶发 **FAIL（1.42s vs 判据 <1.2s，超阈约 18%）**；单独复跑 **5/5 PASS**；`fg.collect()` 单独测得 **0.40–0.42s**；并发放大约 **3.4×**。
- **区分「环境性偶发」与「本次回归」的判据（全部满足才判环境性，缺一即登记 Known Issues）**：
  1. **隔离复跑**：`pytest tests/<file>::test_function_graph_build_performance_under_baseline -q` 连续 5 次 → 5/5 PASS 且每次 <1.2s。
  2. **归因测量**：单独计时 `fg.collect()` 5 次，max ≤0.6s（基线 0.40–0.42s）。
  3. **并发因子**：全量耗时 ÷ 单独耗时 ≈ 3.4×，且超阈幅度 ≤20%（1.42/1.2）；若单独复跑也 >1.2s 或 ≥2/5 失败 → **判回归**，回传工程师。
  4. **变更相关性**：`git diff --stat` 确认本次 30 轮**未触碰** `tools/function_graph.py`、该测试文件及其输入集（此为必要不充分条件，不得单独据此免责）。
  5. **三层标注**：该 FAIL 属**断言层超时**，不等于「功能不可用」，也不等于「构建失败」；登记为 `environmental-flake / not-a-regression`。
- **处置口径**：**不得直接判本次改动失败**（无变更相关性 + 隔离复跑全过），**也不得静默吞掉**（必须在台账与本报告逐条记录观察值、复跑次数、并发因子）；若 2 轮回归后仍偶发，列入「Known Issues」并说明影响面与解除条件。

---

## 8. 复现包格式（判 FAIL 时立即回传，停止后续测试）
```
[QA-FAIL 复现包]
轮次/用例：Ixx / test_xxx
命令：<完整命令，含 $PY/$NODE 绝对路径>
env：PYTHONUTF8=1 PYTHONIOENCODING=utf-8；HARBOR_NODE=<...>；cwd=<...>；并行阶段文件状态=<git status 摘要>
观察值：<stdout 关键行 + rc + 产物字段>
判据：<规格 §3 / 本矩阵对应条目，原值不放宽>
PASS-FAIL：FAIL
源码定位：<文件:行号 + 函数名>
堆栈 / 错误：<AssertionError / Traceback 全文>
注入与恢复：<模式 M/S/P、注入锚点、恢复方式、git status 前后对比>
路由：Engineer（源码 Bug） / QA-self-fix（测试 Bug）
轮次：Round 1 / Round 2（硬上限 2）
```

---

## 9. 交付判据矩阵（汇总）

> **正式验收第 1 轮（2026-11-12，QA 严过关独立复跑，不采信主理人/工程师结论）**：工程师 T01+T02（I01–I12）已落盘。I01–I12 逐轮独立验收**全部 PASS**；I13–I30 尚未实施，一律保持 `未验证（尚未实施）`，不提前判、不冒充 PASS。全程未修改任何实现文件；「判 FAIL 立即停止」未触发。逐门命令/env/观察值 vs 判据见 §9.1。

| 轮次 | 正向证据（实测） | 反例证据（实测） | 契约回归 | PASS/FAIL/未验证 |
|---|---|---|---|---|
| I01 | CORE 12 项 `is_file()=True`；`--help` rc=0；模块级 `_assert_core_exists()` 在架 | 注入 `tests/__QA_MISSING__.py` → 明确报错 `round_runner.CORE 含不存在的测试文件`；撤除后正对照不报错 | G7 G9 | **PASS** |
| I02 | G5 `PASS 16/16 (100.0%) missing=[] structuralErrors=0` | **注入 A**（仅摘 `run: python tools/run_normalized_gates.py`、L58 注释全留）：旧(HEAD) **16/16 PASS** → 新 **FAIL 15/16 `missing=['normalized-gate-entry']`**；正样本旧/新均 16/16 PASS | G4 G5 G9 | **PASS** |
| I03 | `structuralCheck.parsedGates=11 / requiredTrue=10 / errors=0` | **注入 B**（GATES 路径改 `tools/__QA_MISSING__/` 但保留 token 子串）：旧(HEAD) **16/16 PASS** → 新 **FAIL `gate-file-missing: tools/__QA_MISSING__/contract_golden_replay.py`**；`missingGates=[]`，FAIL 由结构层精确列出¹ | G4 G5 | **PASS** |
| I04 | `engines={"node":">=27.0.0-alpha.0.0.0","npm":">=12.0.0"}`；CI `node-version:'22'` ×3；`git diff -- package.json server/package.json` 空 | 零代码改动型：以「engines 字面量未变 + diff 为空」为反向判据，实测均满足 | G8 G9 | **PASS** |
| I05 | CI `requirements-ci.txt` ×2；`requirements-win.txt` 原 13 条实体条目零缺失；CI 无「27 门」；新文件存在且含 `pytest` | 以 `git show HEAD:requirements-win.txt` 逐条比对，13/13 全在（「只增不删」反向判据）；CI 注释已改动态计数 | G9 | **PASS** |
| I06 | `len(server_gates())=36` == 产物 `summary.serverGates=36`；note 无「64 项」/「27 个」 | 动态计数口径与产物一致；G4 重跑后仍一致 | G4 | **PASS** |
| I07 | `check_release.py --expect 1.9.0` rc=0；AST 无运行时 `backend` ImportFrom；说明性文字「不再 import backend」保留 | 用 **AST 判据**替代裸 grep（后者会误伤 docstring），实测零运行时命中 | G7 | **PASS** |
| I08 | AST 扫描 `tests/**/*.py` + `tools/diag/state_probe.py` 零运行时 backend import；`conftest.py`「已退役」=True、「即将退役」=False | AST 门（非全文 grep）；G7 收集期 0 errors | G7 | **PASS** |
| I09 | `main.py.backendImport=False` / `hasBackendLiteral=False` / `guardType=pure-stub` / `guardOk=True` / `usesDirectoryGuard=False`；9 stub `guardType` 全明确、`guardOk` 全真、`usesDirectoryGuard` 全假 | 双向正对照：注释样本 `# 不再 import backend` → **False**；代码行样本 `import backend` → **True**（证明非「一律 False」） | G3 G4 | **PASS** |
| I10 | `staleDocs=8`，命中 `AGENTS.md`/`README.md`/`开发说明.txt`(**.txt**)/`PYTHON-CONTRACT-EXIT-PLAN.md` 共 4 个活跃入口；`source` 全 `active-entry`；STEP5/HANDOVER **未误判** | P 模式沙箱：基线 `staleDocs=0` → 注入后 `=8`，4 活跃入口全命中（含 `.txt`）、历史原文未误判、撤除正对照成立 | G3 G4 | **PASS** |
| I11 | `contract-coverage.mjs` rc=0，`migrated:167` | **R2 三件套**：167 时 PASS；空集注入 `listMethods=()=>[]` → **rc=1 `AssertionError actual:0 expected:167`**；注入锚点 `assert` 自检命中 | G2 G4 | **PASS** |
| I12 | `contract-signatures.mjs` rc=0 `checked:167`；golden rc=0 `order_identical:true`；`===51` 在架、注释「50 个公开方法」已改 | 空对象注入 `listSignatures=()=>({})` → **rc=1 `AssertionError actual:0 expected:167`**；167 正样本 PASS；A3 锚点同步核实 | G2 G4 | **PASS** |
| I13 | — | — | G3 G4 G5 G7 | **PASS（Round 2）** |
| I14 | — | 仅登记产物 mtime 方向变化（§9.5），I14 断言尚未实施 | G3 G4 | **PASS（Round 2）** |
| I15 | — | — | G4 | **PASS（Round 2）** |
| I16 | — | P 构造非空 findings 探测：非 strict `rc=1` / strict `rc=1`（**无分叉**，`--strict` 仍为死参数）→ 确认 T03 尚未实施，按主理人口径**标未验证、不判 FAIL** | G4 | **PASS（Round 2）** |
| I17 | — | — | G4 | **PASS（Round 2）** |
| I18 | — | — | G7 G9 | **PASS（Round 2）** |
| I19 | — | — | G2 G4 | **PASS（最终验收）** |
| I20 | — | — | G7 | **PASS（最终验收）** |
| I21 | — | — | G7 | **PASS（最终验收）** |
| I22 | — | — | G4 | **PASS（最终验收）** |
| I23 | — | — | G2 G4 | **PASS（最终验收）** |
| I24 | — | — | G4 | **PASS（最终验收）** |
| I25 | — | — | G3 G9 | **PASS（最终验收）** |
| I26 | — | — | G1 G6 G9 | **PASS（最终验收）** |
| I27 | — | — | G3 G4 | **PASS（最终验收）** |
| I28 | — | — | G4 G5 | **PASS（最终验收）** |
| I29 | — | — | G7 G9 | **PASS（最终验收）** |
| I30 | — | — | G7 G9 | **PASS（最终验收）** |

> ¹ 主理人要求「新实现 FAIL 且 `missing` 具体列出该项」。实测**注入 A 由 `missingGates` 精确列出 `normalized-gate-entry`**；**注入 B 的 `missingGates=[]`，FAIL 来自 `structuralCheck.errors` 的 `gate-file-missing: tools/__QA_MISSING__/contract_golden_replay.py`**。这是 I02（文本层）与 I03（结构层）的本质差异：注入 B 保留了 token 子串，文本包含必然仍 16/16，若强行要求 `missing` 非空反而要破坏注入精度。如实登记，不伪造、不放宽判据。

### 9.1 逐门精确记录（命令 / env / 观察值 vs 判据 / PASS-FAIL）

**统一 env**：`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`HARBOR_NODE=C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`；`cwd=C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包`；Python 3.13.14 / Node v22.22.2；**无外网**。

| 门 | 命令 | 观察值 | 判据 | PASS-FAIL |
|---|---|---|---|---|
| G1 | `python tools/contract_diff.py --compare deliverables/dev-plan/contract-baseline-r68.json` | rc=0；`结论: 零漂移 PASS`；`## 漂移项 - 无`；模块数 117→117、样式 14→14 | 零漂移 | **PASS** |
| G2 | `node server/test/method-surface.mjs` | rc=0；`publicMethods:51 / hiddenMethods:116 / nodeRegistered:167 / missingInNode:[] / ghostsInNode:[]` | 51/116/167 双向零差集 | **PASS** |
| G3 | `node frontend/app/tests/arch-contract.mjs` | rc=0；`[arch-contract] 82/82 通过` | 82/82 | **PASS** |
| G4 | `python tools/run_normalized_gates.py` | rc=0；`[normalized-gates] 12/12 PASS, 0 SKIP, FAIL=[]`；`serverGates=36` | 12/12（I13 未实施，不要求 13/13） | **PASS** |
| G5 | `python tools/gate_coverage.py` | rc=0；`[gate-coverage] PASS 16/16 (100.0%) missing=[] structuralErrors=0`；`代码覆盖率: blocked-by-environment` | 16/16 + structuralErrors=0 | **PASS** |
| G6 | `python deliverables/design/check_contract.py` | rc=0；`结果: PASS — 五大契约全部保住（manifest: 117 JS / 14 CSS）` | UI 五大契约 PASS | **PASS** |
| G7 | `python -m pytest tests/ -q`（重跑） | rc=0；`476 passed, 2 skipped in 233.59s`；无 `FAILED` 行、无 `= FAILURES =` | 476 passed / 2 skipped / 0 failed | **PASS** |
| G8 | `git diff -- config.json` | 输出空 | 必须空 | **PASS** |
| G9 | `git diff --stat` + `git diff --name-only -- <禁区>` | 17 文件改动；禁区集合（`harbor.html` / `frontend/react/src/generated/*` / `frontend/styles/` / `frozen-python-surface.json` / `package.json` / `config.json` / `server/package.json`）**零命中** | 未触碰禁区、engines 未改 | **PASS** |

**三层区分**：以上 rc=0 仅证明**构建通过**；`51/116/167`、`82/82`、`12/12`、`16/16+structuralErrors=0`、`零漂移`、`476/2/0` 才是**断言通过**；**功能可用**由 §9.2 反例注入证明（门在错误注入下确实会 FAIL，而非恒真），三者不互相冒充。

### 9.2 反例注入对照数值（本轮验收核心）

旧实现基线由 `git show HEAD:tools/gate_coverage.py` 取得并 `exec` 加载（**不调用 `main()`、零落盘**），与新实现 `gate_coverage.evaluate()` 对**同一注入文本**对比；已核验新旧 `CANONICAL(16)` / `CI_ONLY(5)` 一致，对照可比。注入锚点全部用**内容锚点**并 `assert anchor in src`（R3）——CI YAML 行号已由设计阶段 L83 漂移到 **L84**，行号锚点会失效。

| 场景 | 旧实现（HEAD） | 新实现 | 判定 |
|---|---|---|---|
| 正样本（原始 ci + entry） | `PASS 16/16 missing=[]` | `PASS 16/16 missing=[] structuralErrors=0`；`ciRunCommands=55 parsedGates=11 requiredTrue=10` | **PASS** |
| **注入 A**：仅摘 `run: python tools/run_normalized_gates.py` → `run: echo QA-PLACEHOLDER`，L58 注释全留 | `PASS 16/16 missing=[]`（假覆盖） | **`FAIL 15/16 missing=['normalized-gate-entry'] structuralErrors=0`** | **PASS**（改动有效） |
| **注入 B**：GATES `'tools/contract_golden_replay.py'` → `'tools/__QA_MISSING__/contract_golden_replay.py'`，保留 token 子串、`is_file=False` | `PASS 16/16 missing=[]`（自指涉假绿） | **`FAIL 16/16 missing=[] structuralErrors=1`** → `kind=gate-file-missing, gate=golden-replay, detail=门文件不存在: tools/__QA_MISSING__/contract_golden_replay.py` | **PASS**（改动有效） |
| **I11** 167 正样本 / `listMethods=()=>[]` 注入 | rc=0 `ok:true, migrated:0`（设计阶段 E14 实测） | rc=0 `migrated:167` / 注入 **rc=1 `AssertionError actual:0 expected:167`** | **PASS** |
| **I12** 167 正样本 / `listSignatures=()=>({})` 注入 | rc=0 `ok:true, checked:0`（设计阶段 E14 实测） | rc=0 `checked:167` / 注入 **rc=1 `AssertionError actual:0 expected:167`** | **PASS** |
| **I09** 注释/代码行双向 | 注释样本误判 True（E05） | 注释 **False** / 代码行 **True** | **PASS** |
| **I10** 沙箱基线 → 注入 → 撤除 | `staleDocs=0`（E06） | `0 → 8 → 0`；4 活跃入口（含 `.txt`）全命中，STEP5/HANDOVER 未误判 | **PASS** |
| **I16** 构造非空 findings | 非 strict `rc=1` / strict `rc=1`（E12） | 仍 `rc=1 / rc=1`，**无分叉** → T03 尚未实施 | 未验证（不判 FAIL） |

### 9.3 QA 测试 Bug 自修登记（智能路由：测试 Bug → QA 自行修）

- **现象**：首版 G7 判定脚本要求正则 `(\d+) failed` 命中且为 `0`。pytest 全过时输出为 `476 passed, 2 skipped in 234.35s`，**不打印 `0 failed` 字段**，导致 `baseline_ok=False`，脚本误入「基线未吻合」分支并打印了 `路由: Engineer` 的 QA-FAIL 字样。
- **判定**：**断言本身写错 → 测试/用例 Bug，非源码 Bug**。按 §1 智能路由由 **QA 自行修**，不回传工程师。
- **处置**：改为 `rc==0 ∧ 476 passed ∧ 2 skipped ∧ 无 ^FAILED 行 ∧ 无 = FAILURES =`，`0 failed` 由 rc=0 与无 FAILED 行证明；**未复用旧 stdout**，直接重跑全量 G7（233.59s）→ `476 passed, 2 skipped` / rc=0 / **PASS**。
- **未污染正式通道**：该误判仅存在于本地脚本 stdout，**从未通过 `SendMessage` 发给 team-lead 或工程师**，不构成一次正式 FAIL 汇报。本轮仍为 **Round 1 内的用例自修复跑**，未进入 Round 2（Round 2 指工程师修复后的回归）。
- **诚实登记**：不静默吞掉，完整记录于此。

### 9.4 环境阻塞与偶发判据（§7 执行登记）

- `TypeScript / tsc / checkJs`、`pytest-cov / coverage / c8 / nyc` 维持 **`blocked-by-environment`**，无外网不可安装；G5 输出 `代码覆盖率: blocked-by-environment（如实登记，未伪造）`；`16/16` 是**门禁覆盖率 ≠ 代码覆盖率**，I23/I24 的 JSDoc 覆盖率 ≠ 静态类型检查。不得伪造通过。
- `test_function_graph_build_performance_under_baseline`：本轮全量 **未触发偶发 FAIL**（G7 全绿）。仍按 §7 五判据核实备用状态并留痕，不静默吞掉：
  - ① 隔离复跑 `-k <case>` 5 次：`[(0,2.21),(0,2.21),(0,2.25),(0,2.29),(0,2.27)]` → **5/5 PASS**；
  - ② `fg.collect()` 单独 5 次：`[0.300,0.309,0.306,0.313,0.311]s`（本轮比矩阵基线 0.40–0.42s 更快）；
  - ③ 并发因子口径：全量 1.42s / 单独 0.40–0.42s ≈ 3.4×，超阈 1.42/1.2 ≈ 18%（≤20%）；
  - ④ 变更相关性：`git diff --name-only` 触碰 `function_graph` / 该用例文件 = **[]**（零触碰）；
  - ⑤ 三层标注：断言层超时 ≠ 功能不可用 ≠ 构建失败。
  - 结论：若后续偶发，按 `environmental-flake / not-a-regression` 登记，既不直接判本次改动失败，也不吞掉；2 轮后仍偶发则列 Known Issues。
- `node` 门环境噪声 `Warning: Ignoring extra certs ... system-ca-bundle.pem ... error:80000003` 不影响 rc，逐门登记、不判 FAIL。

### 9.5 I14 产物 mtime 方向变化登记（并发刷新实证，R3）

| 时点 | post-deletion-audit | normalized-gates | gate-coverage | architecture-metrics |
|---|---|---|---|---|
| 矩阵设计阶段（§3 E22） | 19:02:14 | 22:56:20 | 22:55:06 | — |
| 主理人 00:11 / QA 验收起始 | 23:59:21 | 00:11:15 | 00:11:16 | 00:10:07 |
| QA 验收结束（本轮） | **23:59:21（未变）** | 00:28:58 | 00:27:18 | 00:28:59 |

- 实测结论：audit **始终早于** normalized，方向未反转；但差距由约 **3h54m → 11m54s → 29m37s** 动态变化。主理人所述「方向相反」实为「差距大幅缩小 + 其余产物被并发重跑刷新」；以实测数值为准。
- QA 本轮**未运行** `post_deletion_audit.py`（避免覆盖产物），故 audit mtime 恒定；G4/G5/arch-assessment 门刷新了其余三份。这直接印证 **R3**：mtime 口径的新鲜度断言随「谁最后跑门」漂移。
- 对 I14 实施的要求（保持不变）：必须先读实现确定口径（mtime vs `generatedAt`）；若走 `generatedAt`，`touch` 反例根本无效，须改注入旧内容副本；反例一律在沙箱副本内做 + `os.utime` 精确恢复 + `git status` 前后对比。
- 产物刷新登记：`git diff --stat` 由起始 `571 insertions/162 deletions` 变为 `570/161`，差异来自 `normalized-gates-r69.json` 的 `tail` 耗时字段刷新（**派生产物，非源码漂移**）；`git status --short` 文件集合与起始完全一致，**QA 零污染**。

### 9.6 智能路由判定结论（Round 1）

| 项 | 结论 |
|---|---|
| 源码 Bug | **0 项**。I01–I12 全部通过正向验收与反例注入，无一处需要回传工程师 |
| 测试/用例 Bug | **1 项**（§9.3 G7 判定脚本），已由 QA 自行修并重跑确认，未打扰工程师 |
| 全通过 | **YES**（I01–I12 = 12/12 PASS；G1–G9 = 9/9 PASS） |
| FAIL 复现包 | **无**（「判 FAIL 立即停止」未触发；唯一 QA-FAIL 字样属测试 Bug 自修，非正式汇报） |
| 未验证 | I13–I30 共 18 轮，标「未验证（尚未实施）」；I16 附 T03 未实施探测证据，不判 FAIL |
| 轮次 | **Round 1 完成即退出**（按 §1「全通过 → 报成功」），**未进入 Round 2**；2 轮硬上限未消耗完 |
| Known Issues | 本轮无；环境阻塞项与偶发备用判据见 §9.4，产物 mtime 并发敏感性见 §9.5 |

### 9.7 协作反馈处理与 QA 用例自修 #2（2026-11-12，Round 1 之后）

工程师回传 R1 交叉印证与现场锚点清单后，QA 独立复核三项，均为**只读验证 + 仅修改本矩阵文件**，未触碰实现：

**(1) I03 `required` 补充反例 —— QA 用例 Bug，自行修（§5 I03 已改）**

| 注入 | 实测 | 判定 |
|---|---|---|
| 基线 | `PASS requiredTrue=10 errors=0` | 正样本 |
| 原矩阵断言 `True→False` | `PASS requiredTrue=9 errors=0` | **原断言错误**：`False` 仍是显式布尔 |
| 修正 `True→'True'` | `FAIL errors=1 required-not-bool/gate-coverage` | 有效反例 |
| 修正 `True→None` | `FAIL errors=1 required-not-bool/gate-coverage` | 有效反例 |

路由：**测试/用例 Bug → QA 自行修**，不回传工程师、不判源码 Bug；这是本会话第 2 次用例自修（第 1 次见 §9.3）。工程师同时指出 `frontend-l2` 是唯一 `required=False`（11 门中唯一 optional 门），与实测 `requiredTrue=10` 吻合。

**(2) 注入 B 双锚点交叉印证**：复核工程师用的 GATES 第 34 行 `'tools/gate_coverage.py'` → `tools/__MISSING_DIR__/gate_coverage.py`，得 `FAIL / covered=16/16 / missing=[] / gate-file-missing gate-coverage`；与 QA 用的第 43 行 `contract_golden_replay.py` 结论一致 → I03 的 AST 解析式校验对 GATES **全部 11 项**一致生效，非特判。两条独立路径（工程师 `evaluate()` 内存副本 / QA `git show HEAD` + exec 旧实现）同结论。

**(3) I14 口径独立核实（对 T03 的关键输入）**
- 实测 `audit - normalized = -1,777,567 ms ≈ -29.6 min`；容差 `0 / 1min / 10min` → **判红**，`30min / 60min` → PASS。差值随每次门禁重跑 `normalized` **单调扩大**，故任何固定容差终将失效 —— 工程师判断成立。
- ⚠ **新发现**：三份产物 `post-deletion-audit-r69.json` / `normalized-gates-r69.json` / `gate-coverage-r69.json` **均无 `generatedAt` 字段**（只有 `generatedBy` 脚本名字符串，不是时间戳）。因此「改走 `generatedAt`」**不是现成字段，必须新增产物字段**；且需定义「新鲜」的比较基准（与谁比、时钟源、幂等性）。
- **I13 与 I14 强关联**：实测 `GATES` 不含 `post_deletion_audit`（I13 未接入）正是 audit mtime 恒定、其余产物被刷新的根因；**I13 一旦接入第 13 门，统一入口每次都会重跑 audit，mtime 口径的差距将自然收敛**。故 I14 实现应与 I13 同批决策，不宜按当前现场单独定容差。
- `arch-contract.mjs` 已 `import statSync` 但**尚无** `mtimeMs` / `generatedAt` 断言（I14 未实施），当前 82/82 不受影响。
- 对 QA 反例的约束不变：实现前先确定口径；mtime 口径用沙箱 `os.utime` 反例，`generatedAt` 口径用「旧内容副本覆盖」反例，二者均不污染真实产物。

**(4) 改动后现场锚点清单（工程师回传，QA 复核采纳）**：CI YAML `run: python tools/run_normalized_gates.py` = **L84**（原 L83，漂移源 = L61 注释改动态计数新增一行）；注入 A 需保留的注释 = L58 `# R69 P0-④：本地与 CI 共用 tools/run_normalized_gates.py 单一入口，`。QA 反例脚本一律用**内容锚点 + `assert anchor in src`**，不依赖行号；T03 若 I18 再动 CI YAML，由工程师同步新字面量后 QA 更新脚本。

**(5) 工程师复现回执与 T03 验收清单增量（2026-11-12）**
- 工程师**只读取证**复现发现 A/B，**未重跑门禁、未刷新任何 mtime**（保护 QA 现场），结论与 QA 完全一致；并采纳「先裁决 I13 接入与否、I14 同批决策」的顺序，已把「请裁决 I14 口径」修正后升级主理人。
- QA 独立核对工程师补充的现场事实：`arch-contract.mjs` 的 `statSync` 共 **4 行 = L19 import + L51/L69/L439 三处调用**，均作 `isDirectory()/isFile()` 用，**非 mtime 断言** → I14 若走 mtime 口径无需新增 import；`tools/post_deletion_audit.py:322` 仅写 `generatedBy`，**无 `generatedAt`/`mtimeMs`** → 与「产物无该字段」互证。当前 82/82 不含新鲜度断言，I14 未实施。
- ⚠ **T03 验收新增判据（授权面）**：若 I14 走 `generatedAt`，须在 `post-deletion-audit-r69.json`（及比对基准产物）**新增字段**。规格 §0 裁决 4 的新增文件授权仅列 `requirements-ci.txt` 与 `type-annotation-baseline-r69.json`；给既有产物加字段属**新授权面**。QA 在 T03 验收时将检查：① 是否留有主理人明确授权痕迹（台账/裁决）；② 新增字段不破坏 §1.7 的 `version` 递增、`ensure_ascii=False, indent=2`、幂等；③ `contract_diff --compare r68` 零漂移不受影响；④ `arch-contract` 82/82 不退化。**无授权痕迹即登记为待授权项，不判 PASS、也不擅自放行**。
- 口径对齐承诺（双方一致）：工程师派发后先把实现口径（mtime 容差基准 / `generatedAt` 字段结构与比较基准）发 QA 对齐再动代码；QA 据此选定反例注入方式（mtime → 沙箱 `os.utime` + 精确恢复；`generatedAt` → 旧内容副本覆盖，不用 touch 以免假通过），两边判据一致再落盘。

### 9.8 T03 正式验收 Round 1 · FAIL 立即停测（2026-11-12）

主理人派发 T03（I13–I18）正式独立验收，QA 独立复跑（不采信上游结论）。**判为 FAIL → 立即停止后续测试**，完整复现包已通过 `SendMessage` 回传 `team-lead`（路由 Engineer，经主理人中转；QA 不自改）。

**PASS 项（组 1a，独立复跑）**：S0 刷新 meta + I13 正样本（rc=0、`realDefectsFound=0`、`fixedFiles=9`、`dynamic=True`、meta `2026-11-11T17:16:00.158497+00:00`）；G3 **82/82**（紧跟刷新，I14 正样本）；G1 零漂移「无」；G2 51/116/167；G4 **13/13 PASS, 0 SKIP, FAIL=[]**；G5 **17/17 structuralErrors=0**；G6 五大契约 PASS；G8 `config.json` 空；G9 禁区零命中。产物 `summary.total=13 / passed=13 / serverGates=35 / excluded=['auth-migrate.mjs','node-sqlite-probe.mjs']`，GATES 前 3 = `gate-coverage → post-deletion-audit → arch-contract`（**第 13 门在 arch-contract 之前，I14 顺序前提成立**）。授权痕迹（规格 §0 裁决 4 L17「补充授权（2026-11-12）」新增 meta）**已查到**；CI YAML 无 `post_deletion_audit` 前置行 → 回退辅助行标「不适用」，不判 FAIL。

**FAIL 项**：G7 `python -m pytest tests/ -q` → `rc=1, 1 failed, 477 passed, 2 skipped in 231.86s`；`tests/test_r68_arch_contract.py:357` `assert audit['verdict']['realDefectsFound'] == 1` → `assert 0 == 1`。根因：I13 动态化 verdict 后当前 `realDefectsFound=0`（`dynamic=True`, `basis.blockingDefects=0`）为**符合规格的正确行为**，而历史测试资产仍硬编码 R69 值 `1`；该文件 `git diff --name-only` 为空（**不在 T03 改动清单**，上游核验遗漏）。**非环境性偶发**：失败用例非性能用例、确定性失败；§7 备用五判据仍留痕（性能用例隔离复跑 5/5 PASS、`fg.collect()` 0.315–0.322s、diff 零触碰），本次不得登记为 environmental-flake、也不吞掉。

**智能路由**：源码/仓库测试资产 Bug → **Engineer**（`tests/*.py` 属工程师所有权，按「FAIL 不自行修改引擎代码」QA 不自改）；Round 1 停止，任务 #8 保持 `in_progress`，等待修复后 **Round 2 回归**（最多 2 轮硬上限）。

**因立即停测而未执行（不冒充 PASS）**：I13 三态反例（真问题 rc=1 / 10×staleDocs 不误判）、A2 锚点同步专项（注入真问题后跑 arch-contract、断言总数仍 82）、R1-A/B 在 17 项 CANONICAL 复验、I14 `isAuditFresh` 单元级与沙箱整体级反例、I16 分叉、I17、I18 沙箱副本、**「顺带幂等修复」连跑 3 次 sha256 独立复核** —— 全部标「未验证」。幂等仅有只读观察（产物 `version=2`、本体顶层键无 `generatedAt`、`for target in sorted(DELETED)` 在 L192 在架），与字节幂等设计一致但**未下结论**。

**§9 表格状态**：I13–I18 本轮**不回填 PASS**（整体验收因 FAIL 未完成），状态列已统一改为「未验证（T03 已实施，Round 1 停测）」；I19–I30 保持「未验证（尚未实施）」。停测后仅做 grep/sed/读 JSON 的只读取证，未运行任何门禁、反例或 pytest，未修改实现文件，未与工程师直连。

### 9.9 T03 正式验收 Round 2 · 全通过（2026-11-12，2 轮硬上限用尽）

主理人修复 `tests/test_r68_arch_contract.py:357`（pytest 侧 verdict 动态断言同步）与 `tests/conftest.py:32-66`（I14 session autouse fixture 刷新 meta）后派发最后一轮。QA 独立复跑（不采信上游）。**结论：I13–I18 6/6 PASS、契约回归 G1–G9 9/9 PASS、全部反例成立、0 源码 Bug、路由 NoOne**；§9 表格 I13–I18 状态列已回填「PASS（Round 2）」，I19–I30 保持「未验证（尚未实施）」。

**核心回归（G7 不预刷新直跑）**：`python -m pytest tests/ -q` → `rc=0, 478 passed, 2 skipped in 225.25s`，无 FAILED 行；meta `generatedAt` 由 `18:11:20Z` 刷新为 `18:16:44Z`，距现在 `105.8s < 600s` → fixture 生效，Round 1 的确定性 FAIL 已消除。

**契约回归**：G3 `82/82`、G1 零漂移「无」、G2 `51/116/167`、G4 `13/13 PASS, 0 SKIP, FAIL=[]`、G5 `17/17 structuralErrors=0`、G6 五大契约、G8 `config.json` 空、G9 禁区零命中（修正判定后）。产物 `total=13 / serverGates=35 / excluded=[auth-migrate.mjs,node-sqlite-probe.mjs]`，GATES 第 2 项 = `post-deletion-audit`（在 arch-contract 之前）。

**反例对照数值（全部实测）**
| 项 | 数值 | 判定 |
|---|---|---|
| R1-A（17 项口径） | 旧全文包含 `17/17 PASS` → 新 `FAIL 16/17 missing=['normalized-gate-entry']` | PASS |
| R1-B（17 项口径） | 旧 `17/17 PASS` → 新 `FAIL 17/17 missing=[] structuralErrors=1`，`gate-file-missing: tools/__QA_MISSING__/contract_golden_replay.py` | PASS |
| I13 三态 | 正样本 `rc=0/defects=0`；注入 1 条真问题 `rc=1/realDefectsFound=1/byKind=1`；10×8 类陈旧措辞 `staleDocs 8→32, rc=0/defects=0, staleDocsNonBlocking=True` | PASS |
| A2 专项 | 注入 **2 条**真问题 → `realDefectsFound=2, byKind=2, fixedFiles=9`；`arch-contract 82/82`（旧硬编码 `===1` 必 FAIL，动态交叉校验生效） | PASS |
| 修复一 pytest 侧 | 正样本 `rc=0`；篡改 `realDefectsFound=1` → `rc=1`；`dynamic=False` → `rc=1` | PASS |
| I14 单元级 | 容差 `600000`；刚生成/9m59s `true`；陈旧1h/undefined/非法串/10m01s/空串/负容差/now=NaN `false` → **9/9 PASS** | PASS |
| I14 整体级 | 沙箱注入陈旧 `generatedAt` → `arch-contract rc=1, 81/82`，失败 check「…且产物新鲜」；还原 → `82/82`；**真实 meta 逐字未改**（隔离验证 sha256 `74fbac5133021065` 前后一致、未 touch） | PASS |
| I16 分叉 | legacy 类：非 strict `rc=0, strict=False` / strict `rc=1, strict=True`；`deleted-contract-path`：两模式均 `rc=1` | PASS |
| I17 | `SCAN_DIRS=8`；沙箱假配置行命中 **2 条**且全 `runtimeConfig=true`；非配置类同字面不报错；真实现场 `count=0`、非 strict `rc=0` | PASS |
| I18 | 沙箱删 `run:` 行 → `rc=1`（`test_workflow_normalized_gates_runs_entry` FAIL，1 failed/7 passed）；还原 → `rc=0`；真实 `8 passed`；3 job 全覆盖 | PASS |
| CI 干净 checkout | 删 meta 不预刷新 → 定向 pytest `rc=0`、fixture 重建 meta、随后 `arch-contract 82/82`；gate job 命令 `round_runner.py --rounds 1 --full --no-record --label "CI"` 与 G7 同源（等价证据，未独立复跑副本全量） | PASS |
| fixture 反例 | 脚本换 `rc=1` stub → pytest `rc=1`、输出含「拒绝静默继续」、透传 `STUB-STDERR` | PASS |
| 幂等复核 | 连跑 3 次 `post_deletion_audit.py` 产物 sha256 恒为 `231da16446d63514…`；`version` 1→2 递增、`indent=2`、`ensure_ascii=False`、本体顶层键**不含** `generatedAt` | PASS |
| 新增验证点 | `CANONICAL=17 / GATES=12 / server_gates()=35` 未变；`NON_GATE_SCRIPTS={auth-migrate.mjs,node-sqlite-probe.mjs}`；diff 21 文件，相对 Round 1 仅新增 `tests/test_r68_arch_contract.py`（`tests/conftest.py` 19→54 行）；meta **NOT TRACKED**；授权痕迹（规格 §0 裁决 4 L17）在架 | PASS |

**智能路由与 QA 用例自修（本轮 5 次，均为测试 Bug → QA 自行修，未回传工程师、未判源码 Bug）**：#3 组 B 的 G9 判定把 stderr CRLF warning 混入 `o` 导致误判（改 stdout-only + `git diff --name-only` 双重确认后 PASS）；#4 I14 单元级用例把 `expected` 二次取反（改记录原始返回值后 9/9 PASS）；#5 I16 的 P 模式 monkeypatch 未还原污染 I17（独立进程重新 import 后命中 2 条）；#6 `shutil.copytree` 目标目录已存在缺 `dirs_exist_ok=True`；#7 `run()` 第二位置参数误当 timeout 传入整数导致 `NotADirectoryError`。**每次均只读取证定位 → 自修 → 重跑确认**，不静默吞掉、不误判源码。

**三层区分**：G1–G9 的 rc=0 = 构建通过；`13/13 / 17/17 / 82/82 / 167 / 零漂移 / 478 passed` = 断言通过；**功能可用**由上表反例证明门在错误注入下确实会 FAIL（I13 真问题判红、I14 陈旧判红、A2 动态同步、I16/I18 分叉、fixture 拒绝静默继续），三者不互相冒充。

**环境登记**：TypeScript/覆盖率 `blocked-by-environment`，不伪造；`test_function_graph_build_performance_under_baseline` 本轮未触发偶发，§7 五判据备用核实留痕（隔离复跑 5/5 PASS `3.21–3.24s`、`fg.collect()` `0.298–0.304s`、diff 零触碰、并发因子≈3.4×、断言层超时≠功能不可用）。

**遗留问题清单（Known Issues / 约束，非本轮回归）**：① meta 为 untracked 运行产物，任何**不经过 pytest** 直接单跑 `arch-contract.mjs` 且距上次 audit >10min 仍会判红 —— 裁决三已登记的已知约束，本地须先跑统一入口/audit；② CI `gate` 与 `normalized-gates` 两 job 无 `needs`、并行独立，gate 侧靠 conftest fixture 刷新自己 workspace 的 meta，本轮给出**等价证据链**（删除 meta 的沙箱 pytest + G7 478 passed + 命令同源），**未独立复跑副本 `round_runner --full` 全量**；③ 幂等 sha256 本轮为 `231da16446d63514…`，与工程师先前报的 `979e257b…` 不同，原因是产物内容随 T03 修复变化（不同快照），本轮连跑 3 次恒定，非缺陷；④ 回退辅助行（CI 前置 audit）本批次未加且按裁决**标「不适用」**，不判 FAIL；⑤ I19–I30 尚未实施，一律「未验证」；⑥ TypeScript/覆盖率无外网不可解除。

**轮次**：Round 1（FAIL 停测）→ 工程师修复 → **Round 2 全通过 → 报成功（NoOne）**，2 轮硬上限用尽，退出，不进入 Round 3。

### 9.10 T04+T05（I19–I30）最终验收 · 30 轮收口（2026-11-12）

主理人派发 30 轮迭代最后一道验收门，QA 独立复跑（不采信上游）。**总体交付结论：IS_PASS: YES — 30 轮全部验收通过，可交付**。I19–I30 **12/12 PASS**、契约回归 G1–G9 **9/9 PASS**、0 源码 Bug、路由 **NoOne**；§9 表格 I19–I30 状态列已回填「PASS（最终验收）」。

**契约回归（组 A）**：G7 不预刷新直跑 `478 passed, 2 skipped in 226.19s` / rc=0 / 无 FAILED 行（meta 由 I14 session fixture 刷新）；G3 `82/82`、G1 零漂移「无」、G2 `51/116/167`、G4 `13/13`、G5 `17/17 structuralErrors=0`、G6 五大契约、`type_annotation_audit 18/18 100%`、G8 `config.json` 空、G9 禁区零命中；A1 标题命中 1、`from backend.api import` 零命中。

**⚠ 裁决 9（I27 staleDocs 遗留项）— 登记 Known Issue，不判 PASS、不判 FAIL**
- 实测 `staleDocs=7`，逐条归属与主理人清单完全一致：`AGENTS.md:32`、`README.md:10`、`开发说明.txt:11`、`PYTHON-CONTRACT-EXIT-PLAN.md:22/56/57/81`；`source` 全 `active-entry`；STEP5/HANDOVER **未误判**；`verdict.basis.staleDocsNonBlocking=True`、`realDefectsFound=0`、`dynamic=True`。
- 三条可达判据全部满足：① 命中数不增（T02=8 → 7，减少 1）；② 7 条全部归属受保护历史原文；③ 沙箱三层归零复验有效 —— L1 `staleDocs=0 / rc=0 / dynamic=True`、L2 `arch-contract 82/82`、L3 第 13 门 rc=0（真实工作区 13/13 见组 A），**反向注入 1 条真问题仍 `rc=1 / realDefectsFound=1 / byKind=1` 且 arch-contract 82/82**。
- 扫描器**一字未放宽**：`STALE_PATTERNS=8`、`ACTIVE_ENTRY_DOCS=4`、`ALLOW_PREFIX` 含 `deliverables/dev-plan/`、`ALLOW_FILES=14`、活跃入口**未加入豁免**、仍逐 `pattern.search`；规格 §0 裁决 9 / §3 I27 / §6.3 与台账 §3 裁决条、Known Issue 登记均在架。两条被硬边界禁止的收敛路径（改写受保护原文 / 放宽正则族或加豁免）均未被采用。

**两处 pytest 侧增量修复的判据强度复核（重点二，独立复跑）**
- I27 侧 `test_c_path_steps_1_to_3_frozen_but_deletion_still_gated`（L180-194）：改为 10 条量级动态交叉校验（标题 1–6 已执行、无待确认/未执行、指向 STEP5、角标、§1-5 五章节头、STEP5 跨文档交叉），**未删断言、强度不降反升**。
- I23 侧 `test_r69_p0_3_type_safety_phase1`（L561-570）：独立基线棘轮 + 产物/内嵌 baseline/SCOPE 三处一致。
- 沙箱完整树内 **I27 6 类 + I23 8 类注入全部 `rc=1`（14/14 有效 FAIL）**、**两正样本 `rc=0`（PASS）**、**注入锚点自检 14/14 命中**；精确判定（`exportedSymbols==7` / 旧步骤字面量，仅非注释代码行）**无第三处同类硬编码**。

**逐轮实测要点**
| 轮次 | 关键观察值 |
|---|---|
| I19 | `return fallback` 保留、`readJsonWarnings` 有界 **32**（连注 80 次收敛 32，含 code/path）、`node --test paths-readjson.test.js` **4/4**、`server_gates()=35`（`.js` 不进 `*.mjs` glob） |
| I20 | `TimeoutExpired` 单独捕获 → `('', 'error', '[warning] …')`，main 含 `[warning]`、**不含 `[skip] R3 无 git tag`**，rc=0 |
| I21 | 构造样本旧式 `False`→新式 `True`；真实 `Harbor.spec` 两式**均 False**（证明必须用构造样本）；spec 缺失 `R7 缺少…` 且**无 Traceback**；`--expect 1.9.0` rc=0 |
| I22 | `READ_ERRORS` 注入后非空（含 layer/path/code）、连跑 2 次产物 sha256 恒为 `2fef7c95652462c0…`（与工程师一致） |
| I23/I24 | 四样本 `adjacent=T / interleaved=F / novalue=F / unbalanced=F` 全符合；正样本 `18/18 100%`；SCOPE 1→4、独立基线 v2 18/18、只增不减 7→18、三处一致 |
| I25 | §2.3 章节 **BYTE-IDENTICAL 1534/1534 字节**；`invoke('get_api_info')`、冻结快照口径、红线 1 在架；`from backend.api import` 零命中；arch-contract 82/82 |
| I26 | README 199→209 行、开发说明 90→98 行（只增不减）；退役声明/历史链角标在架；pywebview 原文保留；`开发说明.txt` **BOM 保留**；UI 五大契约/零漂移 PASS |
| I27 | 标题「步骤 1–6 已执行」+ 角标、STEP5「v3·已执行」、标题无「待确认/未执行」；§1-5 **BYTE-IDENTICAL**（EXIT-PLAN 122 行/9955 字节、STEP5 309 行/17136 字节含 §0 口径；工程师纯 §1-5 报 122/122、252/252）；staleDocs 见裁决 9 |
| I28 | `ci.detectedTokens=17 == CANONICAL=17`（含 `post_deletion_audit.py`）、`pythonContract.retired=True/files=0`、`serverRunnableGates:27` 历史数字保留、L155-165 零过期文本、产物幂等 |
| I29 | server deps **12**（非规格 11）；`-s` 后 `[dep-hit]` **11 条** + `[dep-exempt] @prisma/client` 1 条；AST 中**无** live `backend/**/*.py` glob（仅 docstring 说明「已移除」）；注入不存在依赖 → `rc=1`；定向 pytest `3 passed` |
| I30 | `electron/main.js` L15-16 三处纯注释级（实测 v22.22.2 / `CI node-version '22'` / `engines >=27` 见 I04 裁决）、历史 seam 已退役、契约事实源=冻结快照；`Node 24.22.1` 零命中；pytest 收集期 0 errors |

**30 轮台账齐全性**：主逐轮表 I01–I30 **30/30 零缺失**；相对 T03 Round 2 的 diff 新增 **15 个源码/产物文件**，新增未跟踪**仅** `server/test/paths-readjson.test.js`（共 7 个 ??）；`git status` 起始/结束均 **43 项（36 M + 7 ??）**完全一致，`config.json` 与禁区（`harbor.html`/`generated/*`/`styles/`/`manifest.json`/冻结快照/`package.json`/`contract-baseline-r68.json`）diff 为空，meta 仍 NOT TRACKED。QA 零污染。

**智能路由**：源码 Bug **0 项** → 全通过 **NoOne**。本轮 4 次异常均为 **QA 自身验收脚本 Bug（自修 #8–#11，不回传工程师、不判源码 Bug、未发出正式 FAIL 复现包）**：#8 `aa.io.open` monkeypatch 连 `Path.write_text()` 一并拦截导致自撞（缩窄 patch 范围）；#9 `nonlocal anchors` 用在模块级作用域语法错（改可变计数容器）；#10 两类注入无效（`## 3.`→`### 3.` 仍含子串；`SCOPE=SCOPE[:3]` 追加在 `__main__` 之后不执行）——修正为整行替换 / 插到 `__main__` 之前后 14/14 有效；#11 硬编码判据 `== 7` 过宽误命中 `total_tokens==7`/`==74`/`==7200`（精确化后同类硬编码 `[]`）。每次均「只读取证 → 自修 → 重跑确认」，不静默吞掉。

**三层区分**：rc=0 = 构建通过；`13/13 / 17/17 / 82/82 / 167 / 18/18 / 478 passed` = 断言通过；**功能可用**由全部反例证明门在错误注入下确实 FAIL（裁决 9 归零复验、14 类 pytest 注入、I19 EACCES、I20 超时、I21 spec 缺失、I22 不可读、I29 依赖不存在、I23/I24 四样本），三者不互相冒充。

**环境登记**：TypeScript / 覆盖率维持 `blocked-by-environment` 不伪造；性能用例本轮未触发偶发，§7 五判据备用核实留痕（隔离复跑 **5/5 PASS** `3.23–3.27s`、`fg.collect()` `0.300–0.310s`、diff 零触碰、并发因子≈3.4×、断言层超时≠功能不可用）。

**遗留问题清单（Known Issues / 约束，非本轮回归）**：① **裁决 9 — `staleDocs=7` 长期保留为 I13 已定义的非阻塞登记项**（受保护历史原文逐字保留与「归零」数学不可达），不判 PASS/FAIL，不授权豁免识别机制；② meta 为 untracked 运行产物，不经过 pytest 直接单跑 `arch-contract.mjs` 且距上次 audit >10min 仍判红（既有约束）；③ CI `gate` / `normalized-gates` 两 job 无 `needs`、并行独立（T03 已登记等价证据链）；④ TypeScript/覆盖率无外网不可解除；⑤ I27 §1-5 行数口径差异（含 §0 的 309 行 BYTE 对比 vs 纯 §1-5 252/252，两者均 BYTE-IDENTICAL，非缺陷）；⑥ I22 `layer()` 不直接返回 `readErrors`（写模块级 `READ_ERRORS` 并入产物），按实现口径复核通过；⑦ I29 `[dep-hit]` 证据需 `pytest -s` 放开 capsys 才可见（默认捕获，非缺陷）。

**契约零漂移回归覆盖**：G1–G9 在 T01–T05 **每批收尾必跑**；本轮实测汇总：统一入口 12/12（I13 后目标 13/13）、零差集 51/116/167、arch-contract 82/82、gate-coverage 16/16 且 `structuralErrors=0`、契约差分零漂移、UI 五大契约 PASS、pytest 476/2/0、`git diff -- config.json` 空、`git diff --stat` 未触碰禁区。

---

## 10. 最可能流于橡皮图章的 3 个风险点（QA 独立判断）

**R1 · I02/I03 反例强度选错：「全删 `run:` 行」根本证明不了改动有效。**
实测：全删后当前实现已是 `14/16, status=FAIL`（E02），也就是说**工程师哪怕什么都没改，这个反例也可能「通过」**。真正能证明「注释不算命中 / 解析式校验生效」的只有两个精准注入：① 仅摘除 `run: python tools/run_normalized_gates.py`（L83）而保留 L58 注释 —— 改动前 **16/16 PASS**（E03）；② 把 GATES 门路径改成不存在目录但**保留 token 子串** —— 改动前 **16/16 PASS**（E04）。若验收只跑「全删」，I02/I03 就是橡皮图章。规格 §3 的「`covered<16`」也不足以区分，必须补 `missing` 具体项与注释专项断言。

**R2 · 反例只有负样本、无「改动前恒真」与「正样本仍 PASS」对照，实现可用「一律判 false / 一律 FAIL」骗过。**
三处实证：① I24 的 `interleaved.js`（符号前插普通注释）改动前**已判 False**（E17），单独用它作反例毫无区分力，必须配 `adjacent.js=True` 与 `novalue/unbalanced=False`；② I16 当前工作区 `findings=0`（E11），只跑 `--strict --json` 会得到 rc=0 的「通过」，必须**构造 findings** 才有意义；③ I11/I12 若只检查「空集时 FAIL」而不检查「167 时 PASS」，门可以被写成恒定抛错。同理 I09 的「注释注入判 False」必须配「真实代码行判 True」。**每个反例强制三件套：改动前恒真证据 + 注入后失败信号 + 撤除注入的正对照**（§2.3）。

**R3 · 产物/mtime 类反例在真实工作区做，被并发重跑意外刷新；且注入锚点未自检导致「替换静默失效 → 假 PASS」。**
实测 `post-deletion-audit-r69.json` 19:02 已比 `normalized-gates-r69.json` 22:56 陈旧约 4 小时（E22），而工程师每跑一次统一入口就刷新 mtime —— I14 的 `touch` 反例在真实工作区会时灵时不灵，且 touch 本身污染产物；若实现改走 `generatedAt` 字段，touch **根本不生效**，反例会假通过。必须：全部在 S 沙箱副本内做 + `os.utime` 精确恢复 + 先读实现确定判据口径 + `git status` 前后对比。同源风险：工程师并行改文件后，注入脚本的 `replace(anchor, ...)` 可能**锚点失配却不报错**，脚本继续跑出 PASS —— 因此 §2.2 的 `inject_replace` 强制 `assert anchor in src`，I13/I14 的 A2 硬锚点（`arch-contract.mjs:647-648`）也必须单独设反例验证「脚本改了、锚点也同步了」。

---

## 11. QA 只读命令白名单 / 禁止清单（防与工程师并发冲突）

**允许**：`Read`/`Glob`/`Grep`；`git status --short`、`git diff`、`git diff --stat`、`git diff -- <file>`；`node server/test/method-surface.mjs`、`node server/test/contract-*.mjs`、`node frontend/app/tests/arch-contract.mjs`；`python deliverables/design/check_contract.py`；定向 `pytest <file> -q`；`python -c` / heredoc 的 M 内存复现与 P monkeypatch；`TemporaryDirectory` 沙箱内运行副本脚本（产物落副本）。

**禁止（本阶段及与工程师并发期间）**：`python tools/run_normalized_gates.py`、`python tools/gate_coverage.py`、`python tools/post_deletion_audit.py`（真实工作区）、`python tools/contract_diff.py --snapshot`、`python tools/type_annotation_audit.py`、`python tools/arch_assessment.py`（真实工作区，会写产物）、任何 `touch`/写 `-r69.json` 产物、任何修改 `tools/*.py` / `server/test/*.mjs` / `tests/*.py` / `.github/` / `AGENTS.md` / `README.md` 的操作。

**收尾核对**：`git status --short` 与 `git diff --stat` 在 QA 工作前后必须一致（本文件为唯一新增落盘产物）；`git diff -- config.json` 为空。
