# R100 磁盘清理清单（2026-11-19）

> **前置状态**：pytest 基线 `514 passed, 2 skipped`（306.61s）
> **原则**：只删「旧过程资料 / 旧轮次产物 / 无用残留」，**不删任何源码与门禁依赖**

---

## 一、删除范围

### 1.1 开发过程稿与 QA 截图（最大占用）

| 路径 | 体积 | 判定依据 |
|---|---|---|
| `deliverables/design/liquid-glass/qa/` | ~250 MB / 845 文件 | 每轮视觉调试截图，无门禁引用 |
| `deliverables/design/{_r74-inject-DONE,lg-qa-tmp,r69-polish,r71-dossier,r72-glass,r73-OPTICS-SPEC.md,shots,v18,v19,v3,v4,v4-harness,preview-*.html,make_preview*.py}` | ~60 MB | R69-R74 设计迭代过程稿 |
| `deliverables/design/*.md`（除 README.md） | 小 | R72-R92 各轮落地记录 |
| `deliverables/design/liquid-glass/{qa,r80,r81,HANDOVER-*,R7*-*.md,R8*-*.md,PREVIEW.html,index.html,KNOWN_ISSUES.md,RELEASE-CHECKLIST.md}` | 大 | R77-R83 设计稿过程资料 |
| `qa/` | 49 MB / 194 文件 | r90/r92/r95/r96 各轮截图与探针 |

### 1.2 旧轮次备份与一次性产物

| 路径 | 判定依据 |
|---|---|
| `deliverables/wave-backups/` | 69 MB，G1-G4 波次备份；git 已不跟踪（.gitignore 排除） |
| `deliverables/source-export/` | 4.1 MB，我生成的导出包（已在桌面留副本） |
| `outputs/`（除 5 个测试夹具目录） | 一次性调试脚本与调研报告，79 条目 |
| `attachments/` | 单个无主附件 |

### 1.3 早期产品/评审文档

| 路径 | 判定依据 |
|---|---|
| `deliverables/code-review/` | R12 时代代码评审报告（8 份） |
| `deliverables/product-strategy/` | v12-v14 PRD 与竞品分析（5 份） |
| `deliverables/gstack/` | 早期 gstack 流程记录（3 份） |
| `deliverables/metrics/` | 10-19 度量截图（5 份） |
| `deliverables/scripts/` | gui_walkthrough.py / target_verify.py（一次性） |
| `deliverables/reference/` | expert_portable.py（Python 退役链） |
| `deliverables/security/` | threat-model-v19.md（v19 时代） |

### 1.4 缓存与系统残留

| 路径 | 判定依据 |
|---|---|
| `**/__pycache__/` | Python 字节码缓存 |
| `deliverables/design/__pycache__/` | 同上 |

---

## 二、**必须保留**（依赖已实证）

### 2.1 门禁直接依赖

| 文件 | 依赖方 | 删了会怎样 |
|---|---|---|
| `deliverables/design/check_contract.py` | `run_normalized_gates.py:70` (ui-contract 门) | 第 13 门直接 FAIL |
| `deliverables/design/liquid-glass/scripts/css-lint.mjs` | `lightwell-skin-gate.mjs:16` import | 皮肤门禁无法加载 |
| `deliverables/design/liquid-glass/scripts/**`（其余 39 个） | 同上目录整体保留 | 脚本间互相 import |
| `deliverables/design/liquid-glass/styles/**`（4 个 CSS） | `css-lint.mjs:43-44` PREVIEW_STYLES | 请求 18 / 实际 14 → 判红 |
| `deliverables/design/liquid-glass/assets/wallpaper.jpg` | `optics.js` / `verify.mjs` / `wallpaper.js` | 设计稿自测链断裂 |
| `deliverables/design/liquid-glass/r81/CONTRACT-R81.md` | `liquid.js` / `optics.js` | 同上 |

### 2.2 pytest 测试夹具（**最关键**）

> ⚠️ **本节原清单有漏项，直接导致本轮事故**。原清单只列 6 个，实际 **11 个**。
> 漏列 5 个（`chat-log-centering` / `frontend` / `generative-g1` / `generative-g3` / `perf`）
> 曾被删除，**已从 Windows 回收站完整恢复并验证通过**。详见 `KNOWN_ISSUES.md` 第十二节。

**原清单已列（6 个，均幸存）**

| 目录 | 依赖测试 | 说明 |
|---|---|---|
| `outputs/ui-w4a/` | `test_w4a_visual.py:52,72,86` | 读 `layout-report.json` + PNG 断言 size>1000 |
| `outputs/ui-w4b/` | `test_w4b_visual.py:56,65,69,82` | 同上 |
| `outputs/collaboration-w5e4/` | `test_collaboration_visual.py:7` | 输出目录常量 |
| `outputs/expert-w5d/` | `test_expert_visual.py:7` | 同上 |
| `outputs/generative-g4/` | `test_generative_visual.py:12,22,24` | 同上 |
| `outputs/pytest-tmp/` | `conftest.py:399` 注释说明 | pytest basetemp 证据归档 |

**原清单漏列（5 个，误删后已从回收站恢复）**

| 目录 | 依赖测试 | 引用方式 | 恢复文件数 |
|---|---|---|---|
| `outputs/chat-log-centering/` | `test_chat_log_centering.py` 全 5 项 | `:7` `OUT = ROOT/'outputs'/'chat-log-centering'` | 34 |
| `outputs/frontend/w3c1-semantic-equivalence.json` | `test_frontend_tree.py:166` | `ROOT / 'outputs' / 'frontend' / ...` | 1 |
| `outputs/generative-g1/layout-report.json` | `test_generative_registry.py:301` | `ROOT / 'outputs' / 'generative-g1' / ...` | 8 |
| `outputs/generative-g3/` | `test_generative_dom.py:117,124` | `ROOT / 'outputs' / 'generative-g3' / ...` | 9 |
| `outputs/perf/w7-w8-gate.json` | `test_w7_w8_gate.py:10` | `ROOT / 'outputs' / 'perf' / ...` | 15 |

**漏检根因**：普查只 grep 了 `tests/*.py` 里的字面字符串 `outputs/`，而上述 5 处全部用
`ROOT / 'outputs' / ...` 拼接写法，字面不符。**同类漏检的正确做法**：对 `tests/` 全目录
grep `'outputs'`（带引号的片段），而非 grep `outputs/`。

**结构性风险**：`outputs/` 整体在 `.gitignore`（第 46、72 行）内，`git ls-files outputs/` = 0。
即上述 11 个目录**都不具备可恢复性**（本次能救回纯靠回收站在位，且在系统清空回收站前抢回）。
详见 `KNOWN_ISSUES.md` §31.7 待办 1。

### 2.3 契约与交接（保留）

- `deliverables/dev-plan/**`（契约基线 r67/r68/r98/r99、冻结快照、审计产物）
- `deliverables/handover/**`（R97/R98/R99 交接文档）

---

## 三、执行方式

**用回收站，不用 `rm`**：所有删除走 `gio trash` / Windows 回收站 API，可在误删后还原。

---

## 四、验收判据

> **实际结果：判据 1 部分达成**。其余 5 条全部达成。
> 判据 1 实测 `513 passed / 3 skipped / 0 failed`。相对 `514/2` 的差 1 项是
> 已退役构建链的隔离 venv 未恢复（保持 skipped），见 `KNOWN_ISSUES.md` §31.4。
> 曾因误删 5 组证据导致的 9 项失败**已全部回归**（合跑 22 passed）。

1. `pytest tests` → **513 passed / 3 skipped / 0 failed**（原定 `514/2`；差 1 项为已退役链 venv，详见 §31.4）✅
2. `run_normalized_gates.py` → 13/13 ✅
3. `arch-contract` → 82/82 ✅
4. `lightwell-skin-gate` → 21/21 ✅
5. `css-lint` → 18/18（请求==实际）✅
6. `contract_diff` → 零漂移 ✅