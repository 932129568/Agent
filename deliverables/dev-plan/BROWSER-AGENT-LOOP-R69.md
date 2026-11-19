# R69 浏览器逻辑重构 · Agent 闭环设计说明

> 交付日期：2026-11-11　|　范围：`server/src/services/browser.js` 内部实现重构

## 1. 问题诊断

原实现是「一组浏览器命令」，不是 Agent 软件的闭环。四处结构性差距：

| # | 差距 | 后果 |
|---|---|---|
| 1 | `browser_snapshot` 返回 ARIA 树文本，但**没有稳定元素引用** | 模型看完快照仍需自己猜 CSS selector，选错率高 |
| 2 | `browser_click` 只返回前后截图 b64，**不返回动作后的语义状态** | 模型无法判断动作是否生效，必须再发一轮 snapshot，token 与延迟翻倍 |
| 3 | 六个原语返回字段各异 | 模型需按工具分别记忆形状，决策负担转移到提示词 |
| 4 | 错误码靠字面量散落，`asError` 兜底 `INTERNAL` | 缺少可机器判读的 taxonomy |

## 2. 目标架构

```
        ┌─────────────── 观察 Observation ───────────────┐
        │ browser_navigate / snapshot / extract          │
        │ → 统一 observation + @eN 稳定元素索引           │
        └───────────────────┬───────────────────────────┘
                            │ 模型按 @eN 决策
        ┌───────────────────▼───────────────────────────┐
        │ 动作 Action：browser_click / browser_fill       │
        │ → resolveTarget(@eN 优先) + 前后 compactState   │
        └───────────────────┬───────────────────────────┘
                            │ 返回 observation + diff + next
        ┌───────────────────▼───────────────────────────┐
        │ 再观察：next="browser_snapshot"                 │
        │ 页面导航则旧 refs 失效，强制重建索引             │
        └────────────────────────────────────────────────┘
```

新增内部模块 `server/src/services/browser-agent.js`（**不注册 js_api 方法**）：

| 能力 | 实现 |
|---|---|
| 统一观察信封 | `observe(entry, {includeRefs})` → `step` / `url` / `title` / `ready_state` / `element_count` / `element_refs` / `ref_count` / `untrusted` / `source` |
| 稳定引用 | `buildRefs(page)` 给可交互元素注入 `data-harbor-ref="@eN"`，产出 ref→selector 映射；`refTableText()` 产出可读索引 |
| 目标解析 | `resolveTarget(page, target, refs)`：`@eN` → `text=` → CSS selector → 可见文本回落；缺失 `REF_NOT_FOUND`、脱离文档 `REF_STALE` |
| 动作闭环 | `compactState()` 前后各取一次，`stateDiff()` 计算 `url_changed` / `title_changed` / `elements_delta`；`recordStep()` 递增 step 并留有界轨迹；`nextHint()` 给出下一步 |
| 错误码 | `BrowserErrorCode`（15 码，`Object.freeze`）+ `agentError()` 结构化构造 |
| 安全 | `wrapUntrusted()` 统一 provenance 包裹；`buildRefs` **不读取 `input.value`** |

## 3. 原语改造（返回字段纯增量）

| 原语 | 新增字段 |
|---|---|
| `browser_navigate` | 初始 `observation`（含 `element_refs`，导航即建索引） |
| `browser_snapshot` | `observation`、`ref_table`（UNTRUSTED 包裹）、`ref_count`、`next` |
| `browser_extract` | 轻量 `observation` |
| `browser_click` | 支持 `@eN`；新增 `action_id`、`target_kind`、`ref`、`step`、`observation`、`diff`、`next`、`reason` |
| `browser_fill` | 同上 |
| `browser_sessions` | `step`、`ref_count` |

**既有字段全部保留**：`session_id` / `url` / `final_url` / `title` / `mode` / `clicked` / `before_b64` / `after_b64` / `filled` / `masked` / `text_len` / `content` / `snapshot` / `closed` 等。

## 4. 模型侧可见性

`server/src/services/provider.js` 的 5 条浏览器工具描述更新，**仍严格保持三段式（恰好 2 个 `|`）**：向模型明确 `@eN`、`observation`、`diff` 与 `next`。`AGENTS.md` 新增 §2.3 记录闭环约定与红线。

## 5. 契约与兼容边界

| 约束 | 状态 |
|---|---|
| js_api 方法面 | 51 公开 + 116 隐身 = **167 零差集**（内核为内部模块，未新增 register） |
| 参数元数 | 12 个 `browser_*` 方法全部不变 |
| 冻结快照 | `frozen-python-surface.json` 未改 |
| UI 契约 / DOM | 零变更 |
| 既有返回字段 | 全部保留，新增字段纯增量 |
| `config.json` 零污染 | 状态仍在内存 / `guard.json` |

## 6. 验证

| 门 | 结果 |
|---|---|
| `server/test/browser.mjs`（既有 20 项原语兼容性） | **20/20 PASS** |
| `server/test/browser-agent.mjs`（新增闭环 10 项） | **10/10 PASS** |
| `method-surface.mjs` | 51/116/167 零差集 |
| 统一门禁入口 | 12/12 PASS（serverGates 纳入新门） |
| 架构门禁 | 82/82 |
| 契约差分 r68 | 零漂移 |
| 全量 pytest | 见提交记录 |

新增闭环门覆盖：错误码 taxonomy、`REF_NOT_FOUND` / `REF_STALE` 单元分支、导航观察信封、快照 ref 索引（UNTRUSTED）、`@eN` 填充与点击、step 递增、动作 diff、点击副作用、向后兼容字段、会话投影。

## 7. 已知取舍

- `@eN` 索引在**每次 `includeRefs=true` 的观察**时重建；页面 DOM 动态变化但未重新观察时，旧 ref 可能指向已移除元素 → 由 `REF_STALE` 明确报错，不静默误点。
- `buildRefs` 上限 200 个可交互元素；超出部分不进索引，模型需改用 selector 或 `selector` 参数收窄快照范围。
- 注入 `data-harbor-ref` 会轻微改动页面 DOM 属性，但不影响布局与行为；对严格校验 DOM 的站点，改用 `browser_extract` 观察。
- 动作后的 `observation` 是紧凑状态（不含完整 ARIA 树），完整语义树仍由 `browser_snapshot` 提供——这是控制每步开销的主动取舍。
