# 现有 React 资产合规审计（R68）

> 审计对象：`frontend/react/`（R67 生产 React 层）。审计器：`frontend/app/tests/arch-contract.mjs`。
> 口径：用户「先定规范再重写」——**评审前不改生产代码**，只把现状纳入规范度量与例外登记。
> 机器可读清单：`frontend/app/docs/react-assets.json`。

## 1. 结论

现有 React 共 **16 个 JS/JSX 文件**，其中 **2 个已合规**（`SessionHistory.jsx`、`ParallelRuns.jsx`），
**14 个带迁移期违规**。违规不是"写坏了"，而是 R67 为兼容 legacy 而刻意保留的过渡层，
集中在 5 类：`DOM_API` / `STRING_EVAL` / `STRING_EVENT` / `GLOBAL_SYMBOL` / `MODULE_STATE`。

规范不要求现在删除它们，但要求**逐文件登记理由与退出条件**，并由架构门禁强制：
任何未登记的违规 → 门禁 FAIL；任何新出现的违规（例如有人又加了一个 `data-h-events`）→ 同样 FAIL。

## 2. 五类例外与收敛条件

| ID | 类型 | 涉及文件 | 为什么存在 | 何时归零 |
|---|---|---|---|---|
| EX-01 | DOM_API | `index.jsx`、`AgentProcessPanel.jsx`、`generated/MainShell.jsx` | React 生成 DOM 后 legacy 约 2000 处写点仍作用于真实 DOM；挂载点/独立 root/聚焦需要原生 API | B0–B9 全迁完、写点归零 |
| EX-02 | STRING_EVAL | `index.jsx` | 86 个内联 `on*` 用 `el.onXxx = fn` 属性式桥接，保留 `this`/原生 event/`return false`/legacy 覆盖 | 事件全改 React 合成事件 |
| EX-03 | STRING_EVENT | `generated/` 11 个 + `index.jsx` | HTML→JSX 生成器把 1025 行模板的 86 个事件编码进 `data-h-events` | B0 把 10 区域迁入 `layout/` |
| EX-04 | GLOBAL_SYMBOL | `index.jsx` | `__HARBOR_REACT_BGTASKS__` 让 legacy 不再写 `#bgTaskList`，避免两套渲染器抢 DOM | shell 域（B0）删除后 |
| EX-05 | MODULE_STATE | `store.js` | 侧栏岛模块级 state，行为正确但未按规范分片 | 并入 `state/` 四分片 store |

## 3. 资产去向映射

| 现有 | 目标（规范工程） | 批次 |
|---|---|---|
| `index.jsx` | `src/main.jsx` + `src/app/Root.jsx` | B0 |
| `generated/App.jsx` | `src/app/App.jsx` | B0 |
| `generated/<Area>.jsx` ×10 | `src/layout/<Area>.jsx` | B0 |
| `store.js` | `src/state/{createStore,slices,selectors}.js` | B2 |
| `SessionHistory.jsx` / `ParallelRuns.jsx` | `src/features/sessions/` | B2 |
| `AgentProcessPanel.jsx` | `src/features/agent/` | B3 |
| `island.css` | `src/ui/island.css` | B0 |
| `build.mjs` | `frontend/app/build.mjs` | B0 |

## 4. 终态判据

`exceptionCountZero` / `dataHEventsZero` / `globalSymbolsZero` /
`generatedDirectoryRemoved` / `singleShardedStore` / `archContractPass` 六项全真，
才允许把 `frontend/react/` 从生产链移除。这些判据已写进 `react-assets.json`，
由门禁逐轮度量，不靠人工口头确认。

## 5. 与生产链隔离声明

本次审计**只读** `frontend/react/`，未修改其任何文件；R67 的 16/16 运行时验收与
2066 个 pytest 用例保持全绿。评审确认后才按 B0–B9 动生产链。
