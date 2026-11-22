# team-lead 独立事实核查（Harbor R101 UX 方案）

核查时间：2026-11-22 15:0x
基线：commit 6b18c13
方法：每个结论都来自实际执行的命令或读取的文件，不引用方案自述数字。

## 一、成立的事实（实测）

| 方案声称 | 实测 | 结论 |
|---|---|---|
| 103 颗按钮 | `frontend/index.template.html` 中 `<button>` = **103** | 成立 |
| 75 个 @keyframes | 定义 **76 个 / 唯一名 75 个**（legacy 63 / responsive 4 / shell 3 / components 2 / chat 2 / generative 1 / island.css 1） | 成立（76 定义 75 唯一，方案说的是唯一名） |
| v4MaskIn 重复定义 | legacy.css:454 与 :987，各 `@keyframes v4MaskIn{from{opacity:0}to{opacity:1}}` | 成立 |
| v4LineIn 死引用 | legacy.css 有 10+ 处 `animation:v4LineIn`，全仓 **无任何 `@keyframes v4LineIn`** | 成立 |
| ◐ 静态字符 | `run-controller.js:656` `<span class="tl-ic">◐</span>` | 成立（行号差 1，实测 656） |
| flat.slice(0,48) | `run-controller.js:654` | 成立 |
| 3 灰点 typing-dots | `run-controller.js:244` | 成立 |
| 「编辑（不可用）」死按钮 | `planning/card.js:144` `<button id="planEditBtn" disabled ...>编辑（不可用）</button>` | 成立 |
| text.slice(0,500) 灌记忆 | `markdown.js:284` 与 `run-controller.js:805` | 成立 |
| 流式期重建导致思考块弹关 | `run-controller.js:694` `scheduleRender(mdBody, () => reasonHtml(...) + renderMdStream(...))`；`markdown.js` `scheduleRender` 内部执行 `el.innerHTML = pending.fn()` ⇒ 整块重建，DOM 上的 `.open` class 丢失 | **成立（真实 Bug）** |
| scc 17 环 / 104 符号 | `scc_ratchet.py` → `cycles=17(+0) cyclicSymbols=104(+0) largest=34` | 成立 |
| 13 道门禁 | `run_normalized_gates.py` → **13/13 PASS, 0 SKIP, FAIL=[]**, serverGates=39 | 成立 |
| 168 js_api | `method-surface.mjs` → public 51 / hidden 117 / registered 168，零差集 | 成立（**168 = 51+117**） |
| 4 套空态并存 | 全部存在（id 各 1 处） | 成立 |
| 双权限并存 | `wsqToolChip` / `accessToggle` / `wsQuick` 各自存在 | 成立 |

## 二、不成立 / 需修正

| 方案声称 | 实测 | 结论 |
|---|---|---|
| 仓库 1,197 文件 | `git ls-tree -r HEAD` = **1,005** 条；`git ls-files --others --exclude-standard` = **0** | **不成立**。1,197 无法复现（连「含未跟踪」也解释不了，因为未跟踪为 0）。文档一律用 1,005 |
| js_api 167 | public 51 + hidden 117 = **168** | **不成立**。**仓内不存在任何能凑出 167 的组合**，`grep "116" frozen-python-surface.json` = 0 命中 ⇒ 116 零出处。167 是无来源数字 |
| 市场 811 项 | catalog 解析 **875**（394 experts / 54 teams / 377 skills / 50 connectors） | **不成立且无法复现**。已挂起（Q6），文档统一用 875 |
| harness 1,557 行 | `harness/*.py` 6 模块 + `__init__.py` = **1,676 行** | **口径差 119 行**。1,557 未复现 |

> 我的第一版核查表把 167 记成「成立（167=51+116 口径）」，把「8 处模块路径错误」定性为路径写错。两处均已被架构师纠正并经我复核：
> ① **116 在仓内零出处**，167 不是「第二种读法」而是无来源数字；
> ② 方案**从未写过任何路径**，通篇是裸文件名（如 `（guard.js / grants.js / sandbox.js）`）⇒ 定性应为「不可直接消费」而非「路径写错」。写错路径会被 `test -f` 立刻抓住；**缺目录是静默失败**——补全的人可能补错目录，而任何门禁都不红。

## 三、8 个模块引用缺目录（原定性「路径错误」已更正）

方案原文只给裸文件名，无目录。下表是**补全时应落的真实目录**：

| 方案原文（裸文件名） | 实仓真实路径 |
|---|---|
| `grants.js` | `frontend/src/shell/grants.js` |
| `sandbox.js` | `frontend/src/settings/sandbox.js` |
| `resume.js` | `frontend/src/agent/resume.js` |
| `mcp-panel.js` | `frontend/src/integrations/mcp-panel.js` |
| `local-model.js` | `frontend/src/settings/local-model.js` |
| `context.js` | `frontend/src/agent/context.js` ← **注意同名双份** |
| `shortcuts.js` | `frontend/src/shell/shortcuts.js` |
| `lightwellShell.js` | `frontend/skin/lightwellShell.js` ← **不在 `frontend/src`，属零契约红利区** |

**`context.js` 是唯一重名文件**：`frontend/src/agent/context.js`（134 行，`SHRINK={keepTail:6,toolMax:450,aiMax:900}`）vs `frontend/src/expert/context.js`。改造目标是 `agent/` 那份。**指错不红任何门禁**，静默无效——这是本项最危险的地方。

## 四、两条结构性不可落地

**1. 6.1 S2「按真实后端阶段切换文案」无信号源**
- `server/src/services/harness/` 只有 3 个文件（executionGuardrails / progressiveToolRegistry / providerBridge），无阶段事件
- `run-controller.js` 无阶段语义流
- 方案自己要求「绝不编造假进度」⇒ 当前只能 blocked，或降级为「只映射真实可得信号」（首字节时间 / 本地冷启 / localState.mode）

**2. 7.2「零回读输出感知亮度与方差」疑似自相矛盾**
- 感知亮度若要用于 APCA 阈值判定，CPU 侧需读到数值；GPU 内零回读则 CPU 无法判定
- 待架构师裁决：改措辞 or 改实现路径

## 五、方案漏掉的死控件

红线 4 要求「彻底清零禁用死控件」，方案只点了 `planEditBtn`。实仓还有 2 处 `disabled`：
- `index.template.html:617` `<button ... disabled>在下方输入框</button>`（空态第 3 步）
- `index.template.html:994` `<button id="expertEnableBtn" disabled>启停</button>`
- `index.template.html:995` `<button id="expertSelectBtn" disabled>选择此专家（发送时自动加载）</button>`

后两处是**按状态禁用**（未选专家时禁用是合理的），不是假按钮；但 617 那个是永久 disabled，属真死控件。

## 六、关键杠杆验证（决定 Phase A 策略）

我做了对照实验，结论是**契约门禁对 CSS 与 JS 的敏感度完全不对称**：

| 实验 | 操作 | contract_diff 结果 |
|---|---|---|
| A | 只往 `frontend/styles/legacy.css` 追加一行注释 | **零漂移 PASS**（rc=0） |
| B | 只往 `frontend/src/core/motion.js` 追加一行注释 | **漂移 FAIL**（`source_line_multiset_sha256` 4b54a50b… → 3bc6fad3…） |

原因：`contract_diff.py` 的 `SRC=frontend/src`，对**所有非空行（含注释）**排序后取哈希。CSS 在 `frontend/styles`、皮肤在 `frontend/skin`、模板在 `frontend/index.template.html`，**都不在 SRC 内**。

**由此得出的执行策略**：
1. **能纯 CSS 实现的改动，一律不动 JS** —— 零契约风险。例如：动效令牌、keyframes 整合（删 v4MaskIn 重复定义、给 v4LineIn 补定义）、按状态禁用的样式、视觉分层。
2. **必须改 `frontend/src/**` 的改动，全部归入 r101 基线**，一次性推进，不要分散多次推基线。典型的必须改 JS 项：
   - 思考容器与正文容器 DOM 分区（修「展开即弹关」）—— 结构性，CSS 无解
   - `flat.slice(0,48)` → 滑动尾行
   - `text.slice(0,500)` → 提炼确认
   - 记忆/权限/审批等交互逻辑
3. **一次推基线比多次推好**：每次推基线都要重跑 4 类负控 + 全量 13 门，且新基线的 `symbols` file 归属若写错会污染锚点。建议 **Phase A 的所有 JS 改动攒成一批，一次出 r101**。

实验后已完整恢复（`git status` 确认 `frontend/` 无改动），重新 `--compare` 回到零漂移 PASS。

> **⚠ 本节披露不全，此处补全（2026-11-22 修订）**
> 上述实验**实际上同时做了两件事**，我在初版核查表里只写了「往 `motion.js` 追加一行注释」：
> 1. 往 `frontend/src/core/motion.js` 追加一行注释（→ 契约漂移，已写进上表）
> 2. **删掉 `frontend/index.template.html` 的 `id="themeBtn"`**（→ 用于验证「延迟失败」陷阱，见下）
>
> 只披露第 1 件，会让「本 worktree 出现了未解释的模板改动」变成一条悬空线索。架构师在核验期间独立发现了这处改动并把它当作「坑 B」上报，我随后才说清是我做的。**这是信息缺口，不是隐私问题** —— 在共享 worktree 上做实验，必须事先报备、事后逐条列出改了哪些文件。
>
> **延迟失败陷阱的实测（同一实验的第 2 件产出，结论成立）**：
> ```
> 删模板 id="themeBtn"，不 rebuild：
>   check_contract.py  → [DOM id] 39/40 ; FAIL ; ✗ 缺少 DOM id: themeBtn
>   contract_diff.py   → 结论: 零漂移 PASS          ← 门禁自相矛盾
> 执行 node frontend/build.js 后：
>   contract_diff.py   → dom_ids: 丢失=['themeBtn'] 新增=[]
> ```
> 原因：`check_contract.py` 读 `frontend/index.template.html`（源码），`contract_diff.py` 读 `harbor.html`（**构建产物**）。⇒ **纪律：改模板必须 rebuild，且两道门都要跑；任何一道门单独报绿都不算绿。**
