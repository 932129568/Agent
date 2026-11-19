# Harbor 前端架构规范 v1.0（R68 · 待评审）

> 状态：**规范草案 + 可执行门禁 + 可运行骨架**，尚未接入生产链。
> 适用目标：全面抛弃 `frontend/src/` 的 concatenation 全局脚本，重建为规范化 React 工程。
> 评审确认后，按 §11 的 B1–B9 批次批量重写；本文件是唯一架构事实源，冲突时以本文件为准。
> 依据：`HANDOVER-R67.md`（React 唯一 DOM 生成层现状）、`module-optimization-r64.md`
> （65 模块大 SCC、state.js 入度 125、run-controller 出度 43）、R65 教训（测试即一等消费者）。

---

## 1. 现状问题（规范化要解决的病根）

| 编号 | 病根 | 量化证据 | 本规范的对策 |
|---|---|---|---|
| A1 | concatenation 全局脚本 | 117 模块按 manifest 顺序拼进同一个 `<script>`，1317 个顶层符号全在全局作用域 | §3 分层 + ESM 显式 import，零全局符号 |
| A2 | 65 模块大 SCC / 157 条前向边 | 任意模块可互相引用，靠 `typeof` 守卫掩盖加载顺序 | §3 单向依赖 + 架构门禁静态扫描 |
| A3 | god-module 状态 | `core/state.js` 入度 125，12+ 域状态混居 | §5 分片单一 store，禁止跨层直读 |
| A4 | 渲染权分裂 | 约 2000 处 `innerHTML`/`appendChild`/`getElementById` 直写 DOM | §7 React 唯一 DOM 所有者 |
| A5 | 隐式契约 | 86 个内联 `on*` 字符串、`sendBtn.onclick` 运行时劫持、模板字符串拼 onclick | §7 事件走 React 合成事件，零字符串求值 |
| A6 | 测试与实现同构 | 47 个测试文件直接加载 `frontend/src/*.js` 单文件，删码即断钉 | §8 三层测试 + 迁移登记表"旧钉→新钉"逐条理由 |
| A7 | 契约面与实现耦合 | `contract_diff.py` 冻结 1318 符号、源码行多重集、逐函数定义体哈希 | §9 契约演进：冻结 js_api，UI/符号契约随批迁移 |

---

## 2. 运行时约束（不可改变的前提）

1. **Electron + `file://` 单文件 `harbor.html`**：无 dev server、无外网、无 Node 运行时在渲染层；
   React 与业务代码必须打成单个 IIFE/ESM bundle 内联，零外部资源。
2. **后端只有 HTTP 桥**：`POST /jsapi/:method` + `X-Harbor-Sid` 头；`callApi` 是唯一出口，
   js_api 契约逐字节冻结（`_V12_EXTRA` 隐身规则不变）。
3. **预编译 libs 以全局 script 加载**：`marked` / `purify` / `highlight` / `flate` / `ui-schema`，
   由 `platform/` 统一适配，禁止 feature 层直接读 `window.marked` 等。
4. **模型请求经 local-proxy**：`127.0.0.1:<随机端口>`，白名单目标；SSE 流式解析。
5. **页面内容是 UNTRUSTED DATA**：进模型上下文前必须经 provenance 包裹。
6. **`config.json` 零污染**：新配置一律独立文件。

---

## 3. 分层与依赖方向（强制单向）

```
app/          入口、根组件、错误边界、路由级编排
   ↓ 只能依赖
features/     业务域（chat / sessions / group / settings / expert / ...）
   ↓ 只能依赖
ui/           无业务语义的展示组件
state/        单一状态源（slice / selector / action）
   ↓ 只能依赖
services/     后端桥、模型流、工具执行、缓存、错误归一化
   ↓ 只能依赖
platform/     浏览器/ Electron 适配、libs 适配、env、DOM 白名单
```

**规则**：

- 只允许**向下** import；同层之间禁止互相 import（跨域协作一律经 `state/` 或 `services/`）。
- `platform/` 不依赖任何上层；`services/` 不 import React；`state/` 不依赖 DOM 与网络
  （唯一例外 `state/storeContext.jsx`：React context 绑定层，不含业务逻辑；
  下沉到这里就是为了避免 `features → app` 的反向边）。
- 禁止 `app/` 被任何下层 import（防环）。
- 所有相对 import 必须带扩展名（`.js` / `.jsx`），禁止目录模糊解析。
- 架构门禁 `frontend/app/tests/arch-contract.mjs` 静态扫描并按违规数非零退出。

---

## 4. 目录规范

| 目录 | 职责 | 允许 | 禁止 |
|---|---|---|---|
| `src/app/` | 单一入口 `main.jsx`、`App.jsx`、`Root.jsx`、错误边界 | 组合 layout/features | 业务逻辑、直接 DOM |
| `src/layout/` | 10 个区域外壳（Rail / Sidebar / MainShell / Dialogs…） | 结构 JSX、布局 | 业务状态、后端调用 |
| `src/features/<domain>/` | 每个业务域一个目录 | `Feature.jsx` / `useXxx.js` / `service.js` / `*.test.*` | 跨域直接 import |
| `src/state/` | `createStore.js` / `slices.js` / `selectors.js` / `actions/` | 纯状态与派生 | React、DOM、网络 |
| `src/services/` | `bridge.js` / `modelTransport.js` / `tools.js` / `errors.js` | 后端通信、缓存、错误归一化 | React、DOM |
| `src/platform/` | `dom.js` / `env.js` / `libs.js` | 唯一的原生 DOM / 全局适配 | 业务语义 |
| `src/ui/` | 无状态展示组件 | props 驱动 | 业务状态、后端调用 |
| `src/features/_template/` | 迁移模板（每域复制后填充） | — | 直接投产 |

**命名**：组件 `PascalCase.jsx`；hook `useXxx.js`；服务 `xxxService.js`；测试 `*.test.mjs`；
slice `xxxSlice.js`。文件禁止使用全局序号前缀（旧 concatenation 的顺序约定作废）。

---

## 5. 状态规范（单一状态源）

- 采用 **`useSyncExternalStore` + 分片 store**，不引入 Redux/Zustand（无外网、React 19 内置、
  项目已有同款实现）。实现见 `src/state/createStore.js`。
- 四个分片，各自独立订阅，避免全量重渲染：

| Slice | 内容 | 写入者 |
|---|---|---|
| `sessionSlice` | 会话列表、当前 sid、消息投影、runStatus | `services/` 回填 + `actions/` |
| `uiSlice` | 面板开关、弹窗、主题、选中态、chip | `features/` |
| `runtimeSlice` | 在途 run、工具调用进度、后台任务、接管态 | `services/modelTransport` |
| `settingsSlice` | 端点、护栏档位、工作目录、功能市场启用集 | `actions/` + 持久化 |

- **服务端态不入库**：原始响应、SSE 增量、工具结果由 `services/` 消费后只写"投影"进 slice。
- 禁止组件直接写 `store.state`；一律经 `actions/`。
- 派生数据一律走 `selectors.js`，禁止在组件里重算跨 slice 逻辑。
- 持久化只由 `platform/storage.js` 负责，且写独立文件，不碰 `config.json`。
- 会话隔离：所有 run 相关状态以 `sid` 为键，禁止用全局 `isStreaming`（R31 教训）。

---

## 6. 服务边界规范

- `services/bridge.js` 是**唯一** `callApi` 出口；组件/hook 不得直接 `fetch` 或直接拼 jsapi 名称。
- 每个后端方法一个具名函数（`getConfig()`、`groupFilesWrite()`…），参数与返回经类型守卫校验。
- `services/modelTransport.js` 统一 SSE：免费档节流 / 429 退避 / 5xx 重试 / 本地端点 FIFO 槽位 /
  `new Response(wrapped)` 重建（R63 双锁修复不得回归）/ AbortController 传播。
- `services/tools.js` 统一工具循环与护栏（`guardCheckTool` / `agentGuardCheck` / `mcpGuardCheck`）。
- 缓存、单飞、超时、重试策略集中在 `services/`，禁止散落在组件。
- **错误模型统一**：所有服务抛 `HarborError { code, message, hint?, cause? }`，
  `code` 复用 `BrowserErrorCode` taxonomy 与 server `{ok,error}` 口径；UI 只渲染 `message/hint`。

---

## 7. 渲染与 DOM 规范

1. **React 是唯一 DOM 所有者**。feature / ui / layout 层禁止出现
   `innerHTML` / `outerHTML` / `appendChild` / `insertAdjacentHTML` / `document.createElement` /
   `document.getElementById` / `querySelector`；架构门禁逐文件扫描。
2. 例外只在 `platform/dom.js`，且必须登记在白名单注释中（如 Portal 宿主、焦点管理、
   第三方 libs 挂载点），每个例外写明理由与退出条件。
3. 事件一律走 **React 合成事件**（`onClick` / `onChange`），禁止字符串求值
   （`new Function` / `eval` / `data-h-events`）；迁移完成时 `data-h-events` 计数必须归零。
4. 禁止跨模块运行时改绑 `btn.onclick`（R63 的 sendBtn 劫持）；按钮态由 `runtimeSlice` 驱动。
5. 富文本/Markdown 一律经 `services/sanitize.js`（`marked` + `DOMPurify` 适配）后渲染，
   禁止裸 `dangerouslySetInnerHTML`。
6. 样式：CSS 变量主题由 `platform/theme.js` 统一；组件样式走 CSS Module 或带域前缀的类名，
   禁止内联拼 `style.cssText`。
7. 可访问性：交互元素必须有可命名标签、`aria-expanded` / `aria-controls` 与 `uiSlice` 同步。

---

## 8. 测试口径与迁移规则

### 8.1 三层测试

| 层 | 范围 | 工具 | 判据 |
|---|---|---|---|
| L1 单元 | 纯函数、状态 slice、服务归一化 | Node 断言 / vm | 零 DOM、零网络，确定性 |
| L2 组件 | 单域组件挂载与交互 | `playwright-core` + headless Edge（现有资产） | 真实 DOM 断言 |
| L3 端到端 | 全量 UI + 关键链路 | `tools/verify-react-render.mjs`（扩展） | 16/16 起步，逐批增项 |

### 8.2 迁移规则（R65 教训的制度化）

删除任一 `frontend/src` 模块时，必须**同一次提交**完成：

1. 在 `frontend/app/migration-ledger.json` 把该域状态改为 `migrated`，并逐条登记
   「旧 vm harness 钉 → 新 L1/L2 钉」映射；
2. 为每个被删的行为钉写明「为何该钉不再以旧形态存在」（禁止只删测试不改理由）；
3. 新增等价或更强的新测试，且该域 L1+L2 全绿；
4. 刷新 `contract-baseline-r<N>.json` 锚点；
5. 跑 `arch-contract.mjs` + UI 契约 + 棘轮 + 全量 pytest + 运行时验收；
6. 只有上述全绿，才允许从 manifest `scripts` 移除该模块并删除源文件。

**禁止**：以"生产零调用"为删码依据（collaboration / hubAll 链曾导致 51 failed 全量回退）。

---

## 9. 契约演进

| 契约面 | 迁移期 | 终态（全部域迁完后，需用户拍板） |
|---|---|---|
| `backend/api.py` / js_api | **永久冻结，逐字节不动** | 不变 |
| `config.json` | 零污染 | 不变 |
| UI 契约 40 DOM id / 13 onclick / 43 callApi | 保留为兼容断言，允许新增不允许丢失 | 由组件级契约替代，需用户确认后废止 |
| `contract_diff.py` 1318 符号 / 源码行多重集 / 函数体哈希 | 每批刷新锚点 | 符号面随删码只减不增，最终归零或切换为新契约 |
| 依赖棘轮 157 条 | 只减不增 | 归零 |
| `data-h-events` 86 条 | 逐域递减 | **归零**（迁移完成判据之一） |

---

## 10. 构建与发布规范

```
frontend/app/build.mjs         # esbuild：单一入口 → dist/harbor-app.iife.js
frontend/build.js              # 注入 harbor.html（唯一产物写入口）
```

- 禁止 `manifest.scripts` 拼接进生产 `<script>`；终态 `harbor.html` 只含一个应用 bundle。
- 构建必须确定性（两遍 md5 一致）；禁止手改 `harbor.html` 与 `dist/` 产物。
- 每次前端改动后：构建 → UI 契约 → 契约差分（新锚点）→ 棘轮 → 架构门禁 →
  运行时验收 → 全量 pytest → 打包 → asar 核验。
- 打包沿用离线 `electron-builder` 配置；打包产物不入库。

---

## 11. 迁移模板与批次

### 11.1 单域迁移 checklist（复制 `src/features/_template/` 后逐项打勾）

1. 读全该域所有 legacy 模块，列出：依赖的全局符号、DOM 写点、callApi 目标、内联事件、测试钉。
2. 在 `services/` 抽后端调用与流；在 `state/` 抽状态到对应 slice；在 `features/<domain>/` 写组件与 hook。
3. 把 DOM 写点逐条改成 state 驱动（登记表记录每条写点的去向）。
4. 迁移测试：旧 vm harness → L1/L2，逐条写明理由（§8.2）。
5. 删 legacy 模块与 manifest 条目，刷新锚点，跑全套门禁。
6. 更新 `migration-ledger.json` 与 `HANDOVER-R<N>.md`。

### 11.2 批次表

| 批次 | 域 | 模块数 | 关键风险 | 验收门 |
|---|---|---|---|---|
| B0 | shell（外壳/布局/导航/弹窗） | 13 | 10 区域外壳与既有 layout 组件对齐 | 导航与弹窗行为等价 |
| B1 | chat + composer/send | 5 | 主链路、流式、发送按钮态 | L3 端到端发消息 |
| B2 | sessions + 会话态 | 6 | `switchSession` 是 8 域枢纽 | 会话切换/并行 run |
| B3 | agent（run-controller 1365 行） | 18 | 工具循环、熔断、恢复横幅 | 60-agent 回归全绿 |
| B4 | group | 4 | 接力顺序、群文件、实时气泡 | 群聊全链路 |
| B5 | settings | 11 | 表单密集、端点/护栏配置 | 配置持久化 |
| B6 | expert + generative + planning | 24 | 专家生效链、生成式 UI | 角色/计划链 |
| B7 | analytics + search + integrations + workspace + providers | 14 | 外围面板 | 面板回归 |
| B8 | core + components | 11 | 共享层最后下沉 | 全量契约 |
| B9 | collaboration | 11 | **产品决策前置**（冻结中） | 见 `decisions-r67.md` §1.3 |

---

## 12. 红线（违反 = 架构事故）

1. 任何全局符号（`window.xxx =` 暴露业务函数）、任何 `data-h-events` 新增。
2. 任何反向 / 同层跨域 import（架构门禁拦截）。
3. feature/ui/layout 层出现原生 DOM 写 API。
4. 组件直接 `callApi` / `fetch` / 直接读第三方全局 libs。
5. 新增 js_api 方法未登记 `_V12_EXTRA`；写 `config.json`。
6. 删 legacy 模块但登记表无「旧钉→新钉」理由，或该域新测试未全绿。

---

## 13. 待评审确认的开放项

1. UI 契约（40 DOM id 等）在终态是否废止、由组件级契约替代——需产品/QA 拍板。
2. `collaboration` 子域是保留还是整批下线（决定是否执行 B9）。
3. 是否允许引入 `react-router` 等新依赖（当前规范选择零新依赖）。
4. 每批是否要求用户真机复验签字后才进下一批。

> 本规范配套：可执行门禁 `frontend/app/tests/arch-contract.mjs`、
> 登记表 `frontend/app/migration-ledger.json`、可运行骨架 `frontend/app/src/`。
> **评审确认前不接入生产链、不删除任何 legacy 源码**——这是用户选择的"先定规范再重写"口径。
