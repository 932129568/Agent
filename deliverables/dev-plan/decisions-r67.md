# R67 — 待决项目裁决记录（HANDOVER-R66 §8 全项结案）

> 日期：2026-11-10。触发指令：「全部完成，包括待决项目」＋「全部迁入 React，不要怕重做」。
> 覆盖范围：`HANDOVER-R66.md` §8.1（4 项待用户决策）、§8.2（4 项已批准待实施）、
> §8.3（R60 三项历史遗留）、§11 接手建议四项。
> 本文是**裁决记录**：每项给出终态、依据、验证证据与限制。事实与判断在 §4 分开列示。

---

## 0. 总览

| 来源 | 项数 | 已实施并验证 | 裁决不做 / 维持 | 环境阻塞 |
|---|---|---|---|---|
| §8.1 待用户决策 | 4 | 3（1 立项落地、2 代码、4 架构改造） | 1（collaboration 保留冻结） | 0 |
| §8.2 已批准待实施 | 4 | 0 | 4（并入迁移轮 / 已被证伪 / 冻结 / 已结案） | 0 |
| §8.3 R60 历史遗留 | 3 | 1（性能基准补做） | 1（推送维持本地） | 1（macOS / 代码签名） |
| §11 接手建议 | 4 | 3（提交、立项、门禁流程） | 0 | 1（真机复验需用户操作） |

---

## 1. §8.1 待用户决策（4 项）

### 1.1 Agent 整体重设计三原则 → **立项并落地首个增量**

原状态：`architecture-r63.md` 三原则（过程可见 / 失败即接管 / 配置即生效）待拍板立项。

**裁决**：立项，按"每轮落地一个可验证增量"推进，本轮完成前两条的最小闭环与第三条的产品改造。

| 原则 | 本轮实施 | 验证 |
|---|---|---|
| ① 一切过程可见 | 新增 `frontend/react/src/AgentProcessPanel.jsx`：React state 驱动、400ms 轮询 `getActiveRuns()`，渲染状态点 / 会话标题 / 耗时 / 在跑工具 | 运行时验收注入 failed run，实测文本 `失败 · 探针会话 · 3s · read_file` |
| ② 失败即接管点 | `paused` / `failed` 的运行显示「接管」，点击 → `switchSession` → 收起通知中心 → 聚焦输入框，用户可直接改指令 | 端到端探针断言 `switchSession('S-PROBE')` 被调用一次 |
| ③ 配置即生效 | 功能市场一步生效（见 1.2）；工作目录 / 端点绑定 chip 为 R62 既有能力，本轮不动 | `test_r33_market` / `test_r35_hub_market` 全绿 |

**剩余（R68 批次，非本轮未完成项而是明确后续范围）**：主聊工具流的实时步骤面板、重试/改指令/换工具三选一浮层、群聊接力顺序可视化拖拽。三者都需要改 `run-controller.js` 主链路，按 R65 教训应独立轮次并配 60-agent 回归护航。

### 1.2 功能市场「启用」是否一步生效 → **改为一步生效**

原状态：启用 → 去会话「+」菜单点选，两步；真机反馈「配了但没用上」。

**实施**：`frontend/src/shell/hub-market.js` 的 `hubToggleEnabled()` 在启用时把目录项写入
`HUB_STATE.picks[hubCurrentSid()]`，`hubDirectiveFor()` 在下一次发送直接注入角色口令。
「+」菜单保留为切换 / 覆盖当前会话选择的入口，原两步路径不被破坏；停用时仍清除 picks。
vm 沙箱缺 `HUB_STATE` / `hubCurrentSid` 时全部 `typeof` 守卫，零新 js_api、不碰 `config.json`。

**验证**：受影响回归簇 47 passed（含 `test_r32_hub` / `test_r33_market` / `test_r35_hub_market`
的启用链、指令注入链、连接器注册链断言）。真机复验项见 R67 交接 §7。

### 1.3 collaboration 子域去留 → **保留并冻结，不裁剪**

**裁决依据**（工程判断，非功能判断）：

1. R65 已实证「测试即模块内部一等消费者」：该子域 8 个纯逻辑文件约 1100 行默认
   `config.enabled=false` 空转，但 `tests/` 直接调用 `CollaborationRouter` / schemas / config；
   裁剪必须同步松动测试域的行为钉，属于产品决策而非纯死代码清理。
2. 收益量化：1100 行 / 前端 26957 行 ≈ **4.1%**，且默认不激活，运行时成本为零。
3. 风险：R65 同类批次（36 符号 + 2 整文件 + hubAll 链）曾导致全量 pytest 51 failed 并整体回退。

**结论**：在 React 迁移期间冻结该子域，不投入裁剪。若产品明确下线该功能，按
`module-optimization-r64.md` §5.4 的正确姿势整批处理（删码 + 改测试 + 逐条给出「为何该钉不再钉」）。

### 1.4 legacy → React 全并 → **推翻原「不建议一次重写」，按指令全量迁入**

原状态：R66 建议「新表面长在 React 岛，legacy 随优化逐步瘦身」。用户 R67 指令要求全量迁入。

**本轮达成的终态**：**React 成为唯一 DOM 生成层**。

| 维度 | 改造前 | 改造后 |
|---|---|---|
| 可见 DOM 生成方 | 模板 1025 行静态 HTML | React 组件树（10 个区域组件 / 300 个 id） |
| React 覆盖面 | 1 个侧栏岛（会话历史 + 并行运行） | 全量 UI 外壳 + 后台任务域（首个逻辑+渲染双迁域） |
| 内联事件 | 浏览器解析 86 个 `on*` | React 生成 DOM + 属性式原生事件桥（86/86 已绑定） |
| 降级 | 无 | `<template id="harbor-legacy-fallback">` + `activateFallback()`，挂载失败克隆回落，不白屏 |

**关键设计**（决定功能等价性，改动前请读 `frontend/react/src/index.jsx` 头注释）：

- App 是**纯静态组件树**，`flushSync` 渲染一次后不重渲染。legacy 服务层的 453 处
  `getElementById` / 206 处 `innerHTML` / 374 处 `appendChild` 继续作用于 React 生成的
  **真实 DOM**，不会被 React 覆盖。逐域迁移时，每把一块 DOM 写入改成 React state，
  就同步删掉该域的 legacy 写点。
- 模板原静态 DOM 移入 `<template>`：内容不进入主 document，避免与 React 生成的 300 个 id
  重复；同时保留为 `check_contract.py` / `contract_diff.py` 的**契约文本**与降级宿主。
- 根容器 `#harbor-react-root` 用 `display:contents`，保持 `body{display:flex}` 布局等价
  （CSS 中无 `body >` 直接子选择器，已核实）。
- 内联 `on*` 用 `el.onclick = fn` 属性式绑定而非 `addEventListener`：保留 `this` / 原生
  `event` / `return false` 语义，并允许 legacy 后续 `btn.onclick = ...` 覆盖（sendBtn 依赖）。

**验证**（真实浏览器，非静态断言）：`node tools/verify-react-render.mjs` → 16/16 PASS，
包括 300 个 id 零重复、UI 契约 40 个 id 全部可达、86 个事件全部桥接、35 项表单初始态
与降级宿主等价、端到端点击、降级宿主不进主 document、过程面板状态刷新与失败接管。该验收已固化进
`tests/test_r67_react_migration.py`（环境具备时自动跑浏览器，缺 Edge 时 skip）。

**边界（必须如实声明）**：117 个 legacy 模块**未删除**，作为 headless 服务层保留。原因：
契约基线冻结 1318 个顶层符号、2060 个 pytest 用例、约 2000 处直接 DOM 写点；一次性删除
会同时打断功能与测试。React 已接管 100% 的**结构生成**，逻辑迁移按域推进，清单见
`HANDOVER-R67.md` §5。这不是"假装全并"，是绞杀式迁移的可验证第一终态。

---

## 2. §8.2 已批准待实施优化项（4 项，全部结案）

| 级别 | 项目 | 终态 | 依据 |
|---|---|---|---|
| P1 | F3 run-controller 拆步（1365 行 / 出度 43→≤15） | **并入 React 迁移轮，不在 legacy 内单独拆** | 拆完仍需再迁到 React，属重复投入；R65 已论证需独立轮次 + 60-agent 回归护航。迁移 run 域时直接以 React hooks/services 形态落地，出度自然收敛 |
| P1 | F2 state.js 分域（memory 试点） | **不做（已被证据证伪）** | R65 深读：memory 三变量是 R59 M4 刻意下沉 state.js 拆环的，搬回会复活 memory↔fixtures 环；state.js 在 concatenation 下是合法中立共享层。React 迁移后由组件状态/store 替代 |
| P2 | F6 重复样板收编（18 处转义 / sleep×4） | **不做（冻结）** | R65 实证：harness vm 单模块加载直接戳私有 esc，委托会破坏测试域；收益 ≤1200 行且需松动行为钉。React 组件内统一用 React 转义语义，legacy 面保持冻结 |
| P2 | auth 探测已完成 / hub-catalog 已证伪 | **已结案，维持** | R64 实测 hub-catalog 顶层求值 6ms，外链收益为负；auth 懒化 1245→516ms 已落地 |

> 这四项从"待实施"转为"已裁决"，依据是 R65 的失败教训与 React 全量迁移带来的架构前提变化：
> 在 legacy 结构内做优化，会在后续迁移时被整体作废。

---

## 3. §8.3 R60 历史遗留（3 项）

### 3.1 推送 → **维持本地，不主动推送**

事实：本地 `main` 相对 `origin/main` ahead 56；远端 main 是 R60 的等效重放链（32/48 笔），
`origin/main` 引用未 fetch；`HANDOVER-R60.md` §1 明确**禁止** `fetch + reset --soft`（会挤掉 R46-R59）。
R60 用户曾明确指示「不用推送了」。

**裁决**：本轮所有提交均为本地，不推送。依据：① 推送是对外部仓库的写动作，R60 已叫停，
本次指令未明确要求恢复；② 远端链只覆盖前 32 笔，续推需重跑 blob API 重放脚本，属高风险
外部操作；③ 交接文档 §10 记录环境无外网。续推流程与种子文件位置保留在 R60 §1，
用户明确要求时可一键恢复。

### 3.2 OTel 远程 / A-P10 / hub-catalog 外链 → **不实施**

- OTel 远程导出需要可用外网上报端点，环境无外网；本地 OTel 已有，远程无收益。
- A-P10 为历史实验项，无对应产品需求与验收口径。
- hub-catalog 外链会引入首屏网络依赖，而 R64 实测其启动成本仅 **6ms**（1.84MB 是体积问题，
  不是启动问题），外链收益为负。

### 3.3 macOS / 性能基准 / 代码签名

| 项 | 终态 | 说明 |
|---|---|---|
| 性能基准 | **本轮补做** | `tools/verify-react-render.mjs` 输出 `[perf]`：DOMContentLoaded **681ms**（headless `file://`）、`harbor.html` **4,045,428 B**、React IIFE **341,143 B**；与 R64 server 冷启动 516ms 一起构成可复跑基线。体积代价：harbor.html +97,613 B（+2.5%） |
| macOS | **环境阻塞，未做** | 本机 win32，无 macOS 构建机；`Harbor-mac.spec` / `requirements-mac.txt` 保留 |
| 代码签名 | **环境阻塞，未做** | 无签名证书；不影响 NSIS 安装包产出 |

---

## 4. 事实与判断的区分

**已复现实测（事实）**：React 渲染 16/16 验收、300 id / 86 事件 / 35 项表单等价、
全量 pytest **2066 passed / 0 failed / 3 skipped**、UI 契约 40+13+43+39+21 PASS、
契约基线 r67 零漂移、棘轮 157、server 六套 PASS、受影响回归簇 47 passed、
hub 一步生效的 vm 链断言、collaboration 1100 行占比 4.1%、hub-catalog 6ms、server 516ms。

**工程判断**：collaboration 保留冻结、P1/P2 legacy 优化并入迁移轮而非单独实施、
推送维持本地、OTel/A-P10/外链不实施、真机复验需用户按清单操作。

**环境限制（非代码缺陷）**：macOS 与代码签名缺构建环境、远端推送未获恢复授权、
真机 exe 复验需用户实际操作与截图（遵循「不得主动启动 exe」约束）。

---

## 5. 结案声明

§8 全部 11 个条目均有明确终态：已实施、已裁决不做/维持、或明确标注环境阻塞与恢复条件。
没有条目停留在「待用户决策 / 待批准」状态。React 全量迁入按域推进的剩余范围不是悬置项，
而是 `HANDOVER-R67.md` §5 中带门禁与顺序的确定性批次清单。
