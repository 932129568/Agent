# Harbor 生成式 UI 研究与增量 PRD：融合式原生 UiSpec 只读视图

- 日期：2026-10-27
- 状态：融合路线锁定，交架构师统一设计与工程师实施；本阶段只读审计与文档，不改产品代码
- Project Name：`harbor_v19_generative_ui`
- 技术边界：原生 JavaScript + 现有 WebView2/components/AppState/ModelExecutor；仅允许 Zod 单一通用 schema 依赖（vendor）及构建期 esbuild；不引入 A2UI/Lit、Vue/React、AG-UI、iframe、Genkit、第二页面运行时、第二状态库或 Python 模型客户端
- 上游：`harbor-v19-unified-parallel-architecture-2026-10-27.md`、W4A/W4B 当前组件与样式、plan/MCP/memory 真实数据链

## 1. 研究来源、交叉核对与局限

### 1.1 用户指定文章

来源：微信公众平台《2026 生成式 UI：当界面不再固定，前端要重新发明一次》  
URL：https://mp.weixin.qq.com/s/j5SfMYuz3IyrHlql3vtlzQ?scene=1&click_id=1677060379

可采纳的原则：

1. **布局枚举，内容生成**：模型从固定布局/组件中选择，不自由发明视觉体系。
2. **组件、数据、动作三层白名单**：运行时 schema 而非提示词是安全边界；max/min/default 约束不可少。
3. **真实数据绑定**：数据来自工具结果或已有状态；绑定解析层负责路径存在性、权限和失败，不让模型编数字。
4. **增量骨架与降级**：未知组件、绑定失败、布局溢出和超时均有普通模板兜底，不白屏。
5. **客户端持有临时状态**：选择、展开、表单与滚动按稳定 block/entity key 回挂；业务数据仍在原事实源。
6. **生成是增强不是替换**：常用入口前置，旧 UI 始终可用；先做只读视图，再逐步开放低危动作。

### 1.2 权威资料交叉核对

来源：AG-UI 官方概念文档《Generative UI》  
URL：https://docs.ag-ui.com/concepts/generative-ui-specs

官方资料明确：A2UI、Open-JSON-UI、MCP-UI 是生成式 UI 规范；**AG-UI 本身不是生成式 UI 规范，而是 Agent↔User 双向交互协议**。A2UI 采用声明式、JSONL/streaming、平台无关渲染；AG-UI 允许应用采用自己的生成式 UI 标准。

对 Harbor 的约束：可借鉴“声明式描述 + 应用验证/挂载 + 受控交互”，但不宣称兼容 AG-UI/A2UI，也不引入其运行时。Harbor 的 UiSpec 是现有 ModelExecutor 的一种受约束输出类型，并非另接一套协议。

### 1.3 不作为项目承诺的内容

- 文章的“首屏可感知时间降低 40%”“操作步数 4.3→1.8”“8 组件覆盖 80%”等是作者案例/宣传性经验，**不是 Harbor 基线或验收承诺**。
- 文章的固定 1.2s 超时、React/Vue 组件实例、通用 IncrementalJSONParser 不直接照搬。Harbor 采用完整 block 后投影，避免在半 JSON 上伪增量。
- 文章也承认生成式 UI 可测试性更弱、运行时校验与权限成本更高；因此 P0 必须小组件集、只读、真实数据、真 DOM 测试，而非追求“任何界面都能生成”。

## 2. 当前事实与产品定位

### 2.1 当前可复用资产

- `core/app-state.js` 是既有顶层状态的单一门面，不创建第二状态树；可扩展 UI 临时状态，但不得另建 UIStore。
- `agent/model-executor.js` 已是共享完整模型/tool loop，返回 content/messages/usage/toolCalls/status；可增加受控 artifact 输出，不新建模型调用。
- `components/markdown.js` 有调度/终帧与消毒路径；生成式 UiSpec 不走 Markdown/HTML 字符串，而复用调度思想和现有 DOM 主线程。
- `components/overlays.js` 有 toast/modal、焦点圈定/返回与 Guard 确认载体；生成动作复用这些能力。
- `sessions/store.js` 保留 sessions 双源/墓碑/附加 expert 字段；可增加可选 UiSpec 元数据，旧会话兼容。
- W4A 已完成并有历史验证；W4B manifest 当前为 snapshotted，不能当 completed。视觉只复用当前现代 tokens、44px 与圆润层级；W4B quiet controls 必须保留，生成式 UI 不另建皮肤。
- plan 有真实 `task_id/title/steps/status` 与状态机；MCP 有 `mcpServers` 真实列表/状态/工具数；memory 有 `get_memory` 真实条目/时间戳。三者可作为 P0 数据场景。
- 工具结果当前多以 `{id,name,content}` 进入消息，content 常为 JSON 字符串；DataRefResolver 必须按已注册工具 schema 有界解析，不能任意 eval 或信任文本中的“数据路径”。

### 2.2 产品定位

**生成式 UI 是现有页面与聊天结果的增强投影，不是替换。**

- 默认普通聊天、对话/会话/分析/工作区四主面板、plan/MCP/memory 原入口与 W4 视觉不变。
- 只有用户显式开启功能并点击“生成视图”，或显式调用具名生成动作时才产生 UiSpec；不因模型文本自动改页面。
- 原列表/计划卡/记忆面板始终可达；生成视图与原始视图可切换，失败自动回到原模板，不能删除旧入口。
- 全局 W4、专家模式、双模型协同仍按统一架构完成；生成式 UI 不得成为跳过它们或提前结束实施的理由。

## 3. 统一架构：扩展现有底座，不堆叠运行时

### 3.1 模块职责

| 模块 | 唯一职责 | 不拥有 |
|---|---|---|
| `UiSpec` | 版本化的布局/block/component/binding/action 描述 | HTML/JS/CSS、业务数据副本、临时 UI 状态 |
| `ComponentRegistry` | 注册白名单组件、props schema、渲染器、role/aria 与限额 | 数据查询、任意动作、模型调用 |
| `DataRefResolver` | 解析白名单 DataRef、tool JSON、权限/数据范围/revision/provenance | 任意路径、文件系统访问、伪造数据 |
| `ActionRegistry` | 注册低危具名动作、参数 scope、Guard/确认与执行适配 | 模型自由代码、任意 URL/API、第二工具面 |
| `UiProjection` | spec→view-model→DOM 的增量投影、骨架/降级/状态回挂 | 第二 active run、第二 sessions/AppState |
| `ModelExecutor` | 在现有输出中增加 `artifacts:[{type:'ui-spec',specRef}]` 或等价 observer 事件 | 直接 DOM 渲染、第二模型客户端 |

依赖：`ModelExecutor artifact → UiSpec validation → DataRefResolver → ComponentRegistry/ActionRegistry → UiProjection → AppState/SessionStore`。DOM 只在 renderer 主线程；后端不接收 HTML，不执行 UiSpec。**UiSpec 是唯一生成协议，不再维护 A2UI envelope、第二套 schema 或第二 renderer；未来若需外部适配另立评审，不在本轮兼容。**

### 3.1.1 融合选型：逐项借鉴与规避

| 证据路线 | 借鉴 | 规避/不采用 |
|---|---|---|
| A2UI | 版本化 envelope、catalog、data model 与结构分离、平台无关思想 | 协议版本升级与完整 Lit renderer/runtime；不接 AG-UI、Genkit，不维护 A2UI 兼容层 |
| json-render/LangChain/assistant-ui | flat blocks、完整元素/props 后投影、registry/actions/unknown reject | 任意 state/path 写、React/Vue 框架耦合与自由表达式 |
| Vercel useObject/OpenAI | loading/error/stop、终态校验、Structured Outputs、权限上下文 | partial 对象天然可信、厂商锁定；半 JSON 仍保持 Skeleton |
| CopilotKit | 稳定 entityId、revision/latest props、HITL | stale render、数组下标 key 和平行 agent runtime |
| JSONForms/Formily | data schema 与 UI schema 分离、字段级错误/状态 | 表单专用/重型低代码与联动表达式依赖 |
| MCP Apps | 能力协商与 sandbox 思想 | iframe/freeHTML/postMessage 第二页面运行时 |
| Controlled GenUI | 手写默认模板兜底 | 组件数量无界与自由组合 |
| CSS/a11y 资料 | role/label/focus/scroll/mobile/键盘与 reduced-motion | 不假设框架赠送可访问性，必须真实 DOM 验证 |

最终只选 **Harbor 原生声明式 UiSpec + Zod schema 校验 + 现有 components/AppState/ModelExecutor**，不是多框架拼装。Zod 只负责结构校验，不代替 DataRef 权限、脱敏、业务规则或组件意图审查。

### 3.2 状态与数据事实源

- AppState 增加同一 owner 下的 `uiGenerative` 临时投影与客户端状态；不创建第二棵状态树。
- 业务实体仍来自原 tool result、plan/MCP/memory 服务与 SessionStore；UiSpec 只保存 DataRef/provenance，不复制为另一份业务真相。
- sessions 可保存可选 `session.uiGenerative.specs` 与 `message.uiSpecRef`；旧读取器无字段时正常工作。事件/描述只作恢复输入，不包含秘密。
- `revision/runId/sessionId/generation/specId` 决定提交权；旧 spec、旧工具结果或旧 run 不得覆盖新视图。

## 4. P0 UiSpec 与组件白名单

### 4.1 顶层结构

```json
{
  "schemaVersion": 1,
  "specId": "host-generated-id",
  "layout": "single-column",
  "title": "计划进度",
  "blocks": [
    {
      "blockId": "plan-progress",
      "component": "Timeline",
      "props": { "title": "执行步骤", "maxItems": 20 },
      "bind": { "source": "appState", "selector": "plan.current.steps", "scope": "current-plan" },
      "actions": []
    }
  ]
}
```

- `specId` 由宿主生成；模型只能提供稳定、语义化 `blockId`，不能指定 DOM id、run/session 或数据 revision。
- `bind` 是注册 selector，不是任意对象路径/文件路径/URL。`props` 仅接受组件 schema 声明字段。
- 数字展示必须由绑定数据计算；模型可提供标题/说明，但不能用 props 伪造金额、状态、计数、时间或证据。

### 4.2 布局（恰好 5 种）

1. `single-column`：单列详情；
2. `two-column`：桌面双列，窄屏单列；
3. `card-grid`：有界卡片网格；
4. `table-focus`：表格主视图 + 可选摘要；
5. `timeline`：阶段/事件顺序视图。

模型只选择，不生成列宽、像素、grid/flex 任意值或媒体查询。

### 4.3 组件（恰好 8 个）

| 组件 | P0 用途与主要约束 |
|---|---|
| `Table` | columns 1–8、pageSize 5–50（默认 10）、行字段白名单；长文本局部换行/截断 |
| `Card` | 单个摘要实体；字段≤8，不允许自由 HTML/图片 URL |
| `KeyValue` | 1–12 个键值项；适合绑定失败的通用降级 |
| `Timeline` | 1–50 项，状态映射到注册语义；保留原始顺序 |
| `BarChart` | 1–12 条，非负有限数值；SVG 由真实数据计算，标签/值同时可读 |
| `TextBlock` | 有界纯文本/Markdown 纯文本替代，不解析 HTML |
| `EmptyState` | 空、无权限、绑定失败、未知数据类型的明确说明 |
| `Skeleton` | 按组件类型预留稳定尺寸的加载/不完整 block 占位 |

P0 不注册 Form/Button/自由 URL/iframe/Image/Video/CodeScript。只读选择/展开由组件内部标准行为提供，不暴露任意表单提交。

### 4.4 Schema 限额与校验

- `schemaVersion=1`；未知主版本拒绝，未知字段按注册策略拒绝或明确告警，不能静默变成可执行内容。
- 初始上限供架构冻结：单 spec≤64KiB、blocks≤12、嵌套≤3、title≤200 字符、单文本≤10000 字符、每 block actions≤2。
- 每个组件声明 `required/type/min/max/default/items`；数值必须 finite，不接受 NaN/Infinity/负数异常。
- 超限采用“安全截断 + 明示还有 N 项”或整块降级，不能悄悄丢关键字段；权限/版本错误不可靠截断通过。
- 注册组件必须提供 role/aria 模板、键盘行为与响应式规则，否则注册失败。

### 4.5 唯一 schema 依赖与离线打包

- 运行时新增依赖仅 `zod@4.6.7`（MIT、zero external dependencies）；构建工具 `esbuild@0.28.2`（MIT、dev-only）。版本由 package-lock 固定，不能用 `^`/`~` 漂移。
- 以受控 esbuild 将 Zod 与 Harbor schema adapter 生成 `libs/ui-schema.bundle.js`；禁止 CDN/在线字体/运行时联网。普通 `frontend/build.js` 只消费已 vendor 文件，无 node_modules 时也可离线构建。
- `package.json`、`package-lock.json`、`frontend/vendor/`（adapter源）、`tools/build_ui_schema_bundle.js`、NOTICE 必须入库。逐包审查实际 lock；bundle 只含 Zod 运行所需代码，不把 esbuild 或其平台包打进产品。
- G1 实测并记录 `libs/ui-schema.bundle.js` 的**确切字节数、SHA256、gzip 大小与构建环境**，当前文档不预估值。`Harbor.spec`、`Harbor-mac.spec` 继续以 `libs` 整目录收包，release/static guard 必须显式检查该文件、NOTICE 与源映射。
- 升级仅 minor/patch 候选，major 必须重新评审 schema 行为；每次升级跑全量 UiSpec/安全/真实 DOM/build×2/PyInstaller 检查。失败回退到 lock 中上一版本，并重新生成可复现 bundle；不保留两个 Zod 版本。

## 5. 数据绑定与动作

### 5.1 DataRefResolver

允许的 DataRef 类型：

```text
{ source:'tool', toolCallId, selector, resultRevision, scope }
{ source:'appState', selector, scope, expectedRevision }
```

- `toolCallId` 必须属于当前 run/session 的真实工具结果；`selector` 必须在该工具注册的返回 schema 中。
- `appState.selector` 仅来自显式表，如 `plan.current.steps`、`mcp.servers`、`memory.items`、`analytics.current`；不开放 `sessions[*]`、任意对象遍历或秘密字段。
- 工具 content 先按该工具的 JSON/文本方言解析，限制深度/节点/字节；非 JSON 不猜结构。
- 解析层执行：当前用户/run/scope 权限、工作区/数据范围、字段级脱敏、数据类型、revision、provenance digest。模型不能读取任意文件路径或构造新 DataRef 绕过白名单。
- `binding.miss` 区分 not_found/type_mismatch/stale；`forbidden` 独立显示“当前无权查看”，不能伪装空数据。

### 5.2 ActionRegistry

- P0 默认 `actionsEnabled=false`，三个真实 fixtures 均只读；spec 带 action 时降级移除并记录，不执行。
- 注册表仍定义低危动作接口，供显式开启的受控试验：`copy`、`export`、`refresh`。每个动作声明参数 scope、数据权限、确认和现有 handler。
- 即使低危动作也只能由用户显式点击，不能由模型自动触发；`refresh` 重新走原读取 API/Guard，`export` 走原导出/路径选择，`copy` 仅复制当前已授权文本。
- 写操作/删除/批准/回滚/命令/MCP 写调用不进入 P0 ActionRegistry。后续写动作必须与手写按钮同级 Guard、确认、审计和参数 scope，不能因 AI 生成而放宽。

## 6. 流式、骨架与降级

### 6.1 P0 完整 block 投影

1. 显式生成动作开始时按场景先显示骨架；工具返回结构可提供模板类型，不显示伪造数据。
2. 模型输出采用有界 envelope。只有**完整 block** 到达后才 JSON.parse、schema 校验并投影；不完整 block 保持 Skeleton。
3. 不在半 JSON 上反复 `JSON.parse`，不自行实现通用 IncrementalJSONParser，不把字符串修补当可靠增量。
4. 完整 spec 终态再次验证 schemaVersion、block 唯一性、引用与 revision；通过后才替换对应 block，失败保留已验证旧 block或原模板。
5. 超时/取消/模型失败时使用同一真实数据的 handwritten 默认 UiSpec；无默认模板则保留旧 UI 和错误说明。

### 6.2 降级矩阵

| 情况 | 行为 |
|---|---|
| 未知组件 | `unknown_component` 计数，降级 KeyValue/EmptyState，不白屏 |
| 未知布局/props | 使用默认布局/默认 props；关键字段缺失则该 block 降级 |
| binding not_found/type/stale | EmptyState + 可重试低危动作（若开启）；不显示 undefined |
| binding forbidden | 无权限说明，不显示任何敏感值或条目数 |
| spec/数据超限 | 明示截断或默认模板，记录 overflow；不冻结主线程 |
| 流式中断/超时 | 已验证 block 保留，其余使用默认模板；不提交半 spec |
| 旧 revision/run | 拒绝提交，保留当前视图，记录 ignored_late_spec |

### 6.3 DOM 与 XSS 边界

- 生成路径只用 `createElement/createElementNS/textContent/createTextNode` 与受控属性；**禁止 innerHTML/eval/new Function/inline onclick/自由 style**。
- SVG 只生成受控元素和数值属性；禁止外部 URL、foreignObject、事件属性、自由 path 字符串。
- 所有标题、描述、tool/MCP/memory 数据均视为不可信文本；不把其内容插入 selector/HTML/CSS。
- 现有 Markdown 的 innerHTML 不成为生成式 UiSpec 的复用借口；P0 生成路径必须有独立静态禁项检查。

## 7. 客户端状态、恢复与可访问性

### 7.1 状态回挂

- 临时状态存 AppState.uiGenerative：`selection`、`expanded`、`formDraft`（P0 仅只读控件状态）、`scroll`、`focusKey`。
- key = `specId/blockId/entityId`；entityId 必须来自真实数据注册字段，不能用数组下标代替稳定业务 ID。
- 同语义 blockId 新 spec 到来时按 entityId 回挂；已消失实体移除选择，不能把选择转给同位置的另一实体。
- 数据 revision 更新但实体仍存在时保留选择/展开/滚动；新 specId 或用户明确重置时才清空。
- sessions 只保存 spec/描述与必要恢复引用；高频滚动/焦点/表单临时状态默认不写 config.json，也不形成第二业务库。

### 7.2 Focus / aria / 键盘

- 每个组件注册 role/aria-label/labelledby；表格、图表、时间线同时提供文本等价信息。
- 用户主动首次生成后可聚焦容器标题一次；后续数据/spec 更新不打断当前焦点，不自动跳到第一个按钮。
- `aria-live="polite"` 只播报汇总“已更新 N 条/失败原因”，不逐 token/逐行刷屏；Skeleton 标 `aria-busy`。
- 键盘可选择/展开/复制/切换原视图；焦点丢失时回最近合理标题；动态删除 active element 时不得落到 body。
- 375/768 下触控目标≥44px、无页面横溢出；reduced-motion/fx-off 下骨架不循环、内容直接出现。

## 8. P0 真实场景与生成闭环

### 8.1 三个手写 UiSpec fixtures（必须接真实数据）

| Fixture | 布局/组件 | 真实 DataRef | 原入口 |
|---|---|---|---|
| **Plan 进度** | timeline + Timeline/KeyValue | 当前 `planCurrent` 或显式 `plan_get(task_id)` 的 steps/status/task_id | 原计划卡、批准/检查点入口保持不变 |
| **MCP 服务器** | table-focus + Table/Card | `AppState.mcpServers` 经 `mcp_list_servers` 刷新的 name/transport/tool_count/status | 原设置→MCP 列表/详情/编辑入口保持不变 |
| **Memory 列表** | single-column 或 card-grid + Card/Timeline/EmptyState | 显式 `get_memory` 的 text/ts，按真实 index 建立 entity key | 原记忆设置/添加/删除/搜索入口保持不变 |

- fixtures 是 handwritten UiSpec，不是写死数据；空、加载、错误、长文本与状态更新均由真实数据驱动。
- 每个场景提供显式“生成视图”按钮和“原始视图”切换；不通过模型自动替换当前页。
- 任一 fixture 数据缺失/无权/更新时必须走 DataRefResolver，不能绕过后端直接读文件。

### 8.2 fake 模型生成闭环

`用户点击生成视图 → fake transport 输出 UiSpec block → 完整 block 校验 → DataRefResolver 绑定真实 fixture 数据 → ComponentRegistry 渲染 → 状态回挂 → 原视图可切换`。

必须另测 fake 模型选择布局/组件的闭环，不能只展示三个手写 fixture 或只写协议。再注入 unknown component、binding.miss、毒数据、超时，验证默认模板和指标。

## 9. 指标与验证

### 9.1 指标

- `unknown_component`：按组件名/specId/模型来源计数与比例。
- `binding.miss`：not_found/type_mismatch/stale/forbidden 分计，forbidden 不计作普通缺失。
- `overflow`：spec、blocks、列/行/文本、SVG、布局横向溢出与 LongTask 分类。
- **状态回挂率**：可保留实体中正确恢复 selection/expanded/scroll/focus 的比例，分场景报告。
- **首屏 P95**：生成动作→首个有效骨架，以及→首个真实数据 block，分开测量；≥30 次尾延迟并保留原样本。
- **旧入口可用率**：所有生成/失败/降级场景后原计划/MCP/memory/四主面板入口仍可操作，P0 必须 100%。
- 补充：schema reject、ignored_late_spec、XSS 禁项、动作调用次数、渲染耗时、DOM 节点数。

### 9.2 功能与安全测试

1. schema：未知版本/组件/layout/props、重复 blockId、NaN/Infinity、超限、默认 min/max/default。
2. 权限：假 toolCallId、跨 run/session、任意 selector、任意文件路径/URL、过期 revision、非 JSON content、forbidden 字段。
3. XSS/毒数据：HTML/SVG/事件属性/自由 URL/CSS/eval 字符串、prototype pollution 键、长无空格文本；生成路径无 innerHTML/eval。
4. 动作：模型自动调用必须为 0；未注册 action 为 0；refresh/export/copy 只在显式开启+用户点击+原权限后执行；写 action 在 P0 为 0。
5. 流式：半 block、坏 JSON、重复 block、超时、取消、旧 spec；骨架和默认模板正确，不提交半 spec。
6. 状态：同 block/entity 更新、删除实体、乱序数据、旧 run、滚动/焦点回挂；不把选择挂到同下标新实体。
7. 视觉：375×812、768×1024、1280×720，浅色/深色、空/加载/错误/禁用、长文本、44px、键盘、aria-live、reduced-motion/fx-off。
8. 测试类型：fake transport + **真实 DOM 测试**（不只是字符串快照）；保留 W4B 当前成果与原视觉回归。
9. 真实模型选型质量、生成稳定性、真实 WebView2/exe 质量列 **UNCOVERED**；fake 通过不冒充模型质量或真机通过。

## 10. 实施波次（G1–G4）

每波均执行 WaveGuard 白名单快照与 post-hash，禁止回写 W4B snapshotted 证据。波次出口必须同时证明：真实动态生成、正常交互、失败安全降级、旧功能兼容。

| Wave | 文件白名单 | 接口/输入 → 输出 | 边界与真实测试出口 |
|---|---|---|---|
| W4B 封波确认 | 仅读取 W4B manifest/现有 styles/components；不修改其前像 | 现有 UI/测试/视觉基线 | 确认 snapshotted 不当 completed；保存现状，不夹带生成式改动 |
| G1 schema+registry+最小动态渲染 | `package.json`, `package-lock.json`, `frontend/vendor/*`, `tools/build_ui_schema_bundle.js`, `libs/ui-schema.bundle.js`, `frontend/src/generative/{schemas,registry,projection}.js`, `frontend/src/components/*`, `frontend/manifest.json`, `Harbor.spec`, `Harbor-mac.spec`, `tools/check_release.py`, `tests/test_generative_registry.py`, NOTICE | 手写一条有效 UiSpec + 未知组件/坏props → 原生 DOM / EmptyState | Zod/vendor字节与hash实测、5布局8组件注册、aria/tokens、unknown reject、无innerHTML/eval、离线build×2、静态路径/spec |
| G2 真实 DataRef | `frontend/src/generative/{data-ref,fixtures}.js`, `frontend/src/planning/card.js`, `frontend/src/integrations/mcp-panel.js`, `frontend/src/settings/memory.js`, `frontend/src/sessions/store.js`, `tests/test_generative_data_ref.py` | 真实 plan steps/MCP servers/memory items → DataRef→view model；原视图↔生成视图 | plan_get vs planCurrent权威、MCP刷新、memory index entityId；伪造toolCallId/path/secret/stale/forbidden、长文本、状态更新与旧入口100%可用 |
| G3 fake完整block闭环与降级 | `frontend/src/agent/model-executor.js`, `frontend/src/generative/{artifact,projection}.js`, `tests/test_generative_artifact.py`, `tests/test_generative_dom.py` | fake 模型完整block/半block/毒数据/超时/旧revision → 验证投影或Skeleton/手写fallback | 不只字符串快照：真实DOM动态生成、选择布局/组件、正常展开/切换、半JSON不parse、unknown/binding.miss/XSS/overflow、超时取消旧spec |
| G4 状态/低危动作/视觉性能 | `frontend/src/core/app-state.js`（或当前core/state.js对应映射）, `frontend/src/generative/{actions,state}.js`, `frontend/src/components/overlays.js`, `frontend/styles/features/generative.css`, `tools/perf_*`, `tests/test_generative_state.py`, `tests/test_generative_visual.py` | selection/expanded/scroll/focus + 显式copy/export/refresh（默认off）→ 回挂或Guard | actions默认0调用；显式开启+用户点击+原Guard才执行；entity/revision回挂、375/768/1280、深浅主题、44px/focus/aria/reduced-motion、P95首屏/回挂率/LongTask/旧入口 |

G1→G2→G3→G4 全部完成后再进入 W5A–D 专家。真实模型生成质量与真实 WebView2/exe 未测统一写 UNCOVERED，不以 fake 结果冒充。

## 11. 交付优先级

### P0 / Must

- 显式开关/生成动作，默认旧 UI 不变；五个 UiSpec 模块仅扩展现有 executor/components/AppState。
- 5 布局、8 只读组件、严格 schema、真实 DataRef 权限/provenance、动作默认关闭与低危注册边界。
- 完整 block 后投影、Skeleton、未知/绑定/超限/超时降级、无 innerHTML/eval、revision 防旧覆盖。
- 客户端状态回挂、aria/focus/键盘、三个真实场景 fixtures + 显式生成视图 + fake 模型闭环。
- 指标、真实 DOM、安全/权限/毒数据/旧 spec/移动/主题/reduced-motion 验证；真实模型质量 UNCOVERED。

### P1 / Should

- 显式开启 copy/export/refresh；更多真实工具 schema 与只读场景、优化的完整 block 流式到达与恢复。
- 表单只读预览/客户端 draft、更多可访问图表、P95 与回挂率调优。
- 在证明安全与质量后增加写动作候选，仍走原 Guard/确认/审计。

### P2 / Could

- 若外部互操作成为真实需求，另评版本化只读 adapter；本路线不内置 A2UI/Open-JSON-UI 兼容层，不自行伪实现通用增量解析器。
- 多视图编排、有限自定义模板、真实模型质量基准与生成推荐；不得放开 HTML/JS/CSS/任意样式。

## 12. 风险与控制

| 风险 | 控制 |
|---|---|
| 变成第二页面运行时/状态库 | UiSpec 仅 artifact，AppState/SessionStore 唯一 owner；无 Python 客户端与第二 UIStore |
| 生成替换旧 UI/W4 成果 | 默认 off、原视图切换、旧入口 100% 验收、W4B 现状与 WaveGuard 保留 |
| 模型编数据/越权绑定 | 真实 tool/AppState 白名单、解析层权限/provenance/revision，binding.miss/forbidden 分离 |
| XSS/CSS 注入 | createElement/textContent、无自由 style/URL/HTML/eval、静态禁项 + 毒数据 DOM 测试 |
| 伪流式与状态闪回 | 完整 block 后投影、稳定骨架、blockId+entityId、旧 revision 拒绝 |
| AI 动作绕 Guard | P0 actions off；显式用户点击 + 原 handler/Guard/确认；写动作不开放 |
| 组件自由度失控 | 5 布局/8 组件/schema 限额，超限降级并计数，不按模型建议扩表 |
| 生成耗时伤害主路径 | 骨架/默认模板/超时/取消；首屏与有效 block 分测，旧入口随时可用 |
| fake 被误写为真实质量 | 真实模型与 exe UNCOVERED，报告分栏，不用文章案例数字承诺 |
| 跳过专家/双模型/全局 UI | 统一 Wave 顺序与出口；生成式 UI 只是增量投影，不替代其他实施 |

## 13. 需架构师裁决（已按融合路线冻结）

1. **Spec 版本与限额**：schemaVersion、块/文本/节点/数据上限、未知字段策略、默认模板与超时取值。
2. **注册表接口**：ComponentRegistry renderer/view-model 接口、8 组件 props schema、aria 要求、DataRef/ActionRef 类型。
3. **Executor 输出形态**：`artifacts` 还是 observer ui-spec event；spec 与 assistant/message/toolCall 的引用和 usage 归属。
4. **数据权限**：tool schema 注册、AppState selector 白名单、scope/工作区/字段脱敏、entityId 与 revision 规则。
5. **动作与 Guard**：P0 actions off 的统一开关；copy/export/refresh 何时开放，写动作候选如何复用 OperationCoordinator/Guard/确认。
6. **流式粒度**：完整 block envelope 格式、骨架提前量、终态提交、默认模板和超时时序；是否保留未来真正增量解析接口。
7. **状态与恢复**：AppState.uiGenerative 形状、sessions 元数据、block/entity key、form/scroll/focus 持久化范围与重置规则。
8. **真实场景接线**：planCurrent 与 plan_get 的权威选择、MCP 状态刷新、memory index/entityId，以及旧视图与生成视图的切换位置。
9. **实施顺序**：W4B 收口→registry/schema/DataRef→三 fixtures→fake 生成→状态/动作→完整验证；与专家/双模型共享 artifact/event 的依赖。
10. **验收门槛**：首屏 P95 基线、状态回挂率、overflow 预算、真实 DOM harness 和真实模型质量集。

## 14. Out of Scope

- 模型输出 HTML/JS/CSS、自由 URL/iframe/style、任意文件路径或任意 action。
- 第二套页面运行时、第二 AppState/sessions、Python 模型客户端、直接采用 AG-UI/A2UI 运行时。
- 默认自动生成并替换四主面板、plan/MCP/memory 原页面或 W4B quiet controls。
- P0 写动作、自动执行动作、通用半 JSON 解析器、用案例百分比作性能承诺。
- 跳过全局视觉、专家、双模型或以 fake 结果宣称真实模型/真机质量通过。

---

**总验收口径**：模型只选择受约束的结构，真实数据由解析层绑定，客户端掌握状态与交互；生成失败仍是一套可用旧 UI，生成成功也不牺牲权限、可访问性和既有架构。