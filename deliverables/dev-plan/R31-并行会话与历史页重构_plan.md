# R31 · 无上限并行会话 + 历史页重构 — 执行计划

> 技能：编程专家（dev-expert）｜档位：**大项目档**（跨 agent/sessions/group/chat 四模块 + 模板 + 构建链 + UI）
> 项目：`GLM-Chat-v1.0.0-完整开发包`（Harbor）｜基线：`65989be`(R29) + R30 未提交改动（本轮叠加）

## 状态

已完成（Wave1–Wave5 全部落地；全量门禁见报告 §5；按技能「版本控制约束」未代 git 提交）。

## 不卡死计数

- 诊断失败计数：0
- 换方法次数：0
- 门禁重走轮次：0
- CHECKPOINT：Wave1–Wave5 各一次。

---

## 1. 需求锁定（Step 1.5）

| 用户要求 | 可验收判据 |
|---|---|
| 不限数量群聊与单聊并行 | `__agentRuns` 为 Map，N 个会话各有独立 run；`RunRegistry.start()` **不再取消**他会话 run；无任何硬编码上限/队列/信号量 |
| 不设群聊数量、并发会话数、类型组合上限 | grep 证明无 `MAX_*`/`queue`/`semaphore`/`limit` 形式的并发闸门；群聊 `_busySid` 单值改 Set |
| 不提供开关/手动入口/配置项，不依赖用户操作 | 无新增 checkbox/button/config 字段；`parallel` 由会话身份自动判定（跨会话即并行） |
| 固化为全局默认规则，新建+已有会话自动生效 | 逻辑落在 run 启动/状态派生路径，与 session 生命周期无关，无需迁移 |
| 群聊与单聊互不干扰 | A 生成中 B 可发消息/搜索/切会话/看统计；A 结束不清 B 的流式态；群聊暂停不影响单聊 |
| 历史会话页面优化 | 统计条 + 类型筛选 + 搜索 + 富信息卡片 + 空态；视觉层次明显优于「标题+裸列表」 |

**In**：run 注册表多槽化、流式状态按会话派生、群聊多实例隔离、历史页重构、测试、锚点 r32、报告。
**Out**：后端 `api.py` / `config.json` / `VERSION` / js_api 契约变更；模块数与样式数变化；真机 GUI 目视（用户指定 exe，不主动启动）。

## 2. 实码 trace（Step 2 引用点确认）

| 引用点 | 位置 | 现状 |
|---|---|---|
| `RunRegistry.start` 无条件 cancel | `run-registry.js:5` | `if (__agentActiveRun && !cancelled) this.cancel();` → **并发上限=1 的根因** |
| `RunRegistry.current()` 单槽 | `run-registry.js:20` | 返回最后启动的 run → 切回原会话时停止键错乱 |
| `runAgentLoop` 跨会话 parallel | `run-controller.js:156-160` | 已判 parallel=true 不取消，但随后 `RunRegistry.start()` 仍取消 → 矛盾 |
| run 结束时 `isStreaming=false` | `run-controller.js:1176-1182` | 无条件置 false → A 结束误清 B 的流式态 |
| 全局 `isStreaming` 守卫 | `markdown.js:244` / `search.js:120` / `controller.js:11` / `compact-command.js:22,131` / `planning/card.js:233` | 跨会话误阻塞 |
| `send.js` 跨会话放行 | `send.js:5-20` | `__crossRun` 已放行，但 `activeRun` 取单槽 current() → 判定可能失准 |
| 群聊 busy 单值 | `group.js:762-763,847` | `groupSpeak._busySid` 单字符串 → 多群并行互相覆盖 |
| 群聊不进注册表 | `group.js` 全文无 `RunRegistry` | 多任务面板/停止不可感知群聊 |
| 历史页面结构 | `index.template.html:666-675` | `panel-head` + `<div class="session-list" id="sessionList">` 裸列表 |
| 历史页渲染 | `controller.js:517 renderSessionList()` → `_renderHistoryRoot` → `_sessionGroupsHtml` | 侧栏同款紧凑列表，无统计/筛选/搜索 |
| UI 契约 | `check_contract.py` | 40 DOM id / 13 onclick / 43 callApi / 39 类 / 21 变量，**只增不改** |
| 构建 lint | `build.js:227-261` | `provides` 与顶层符号**双向一致**校验；新增顶层函数必须登记 manifest |

## 3. 方案与取舍

| 候选 | 做法 | trade-off | 结论 |
|---|---|---|---|
| **A（采纳）** | `RunRegistry` 改多槽 Map；`isStreaming` 派生为「可见会话是否有 run」；新增 `isSessionStreaming(sid)`；群聊 busy 改 Set + 轻量 group run | 改动集中在 4 个 JS 模块，需新增顶层符号（登记 manifest） | ✅ |
| B | 只在 `start()` 删掉 cancel，其余不动 | `current()` 仍单槽 → 切会话后停止键/状态错乱，不满足「互不干扰」 | ❌ 反选 |
| C | 引入任务队列/并发池限流 | 与「不设上限」直接冲突 | ❌ 反选 |

**失败模式**：① 同会话重入 → 仍取消旧 run（S20 双发保护不变）；② 群聊 run 被单聊 UI 误接管 → `syncAgentRunUiForSession` 遇 `kind==='group'` 直接返回；③ 新增符号漏登记 → build lint 拦截（强制）。

## 4. 执行 Wave

- **W1** `run-registry.js` 多槽；`run-controller.js` 同会话取消语义 + finish 清理。
- **W2** `run-controller-base.js` 新增 `isSessionStreaming`；`run-controller.js` 结束态按可见会话重算；`send.js`/`sessions/search.js`/`sessions/controller.js`/`components/markdown.js`/`agent/compact-command.js`/`planning/card.js` 守卫改按会话。
- **W3** `group.js` `_busySid` → `_busySids` Set；group speak 期间注册 `kind:'group'` run；`syncAgentRunUiForSession` 跳过 group。
- **W4** `index.template.html` panelSessions 重构 + `sessions/controller.js` 富列表渲染（新函数登记 manifest）+ `features/chat.css` 样式（不新增样式文件）。
- **W5** `tests/test_r31_parallel.py`；全量 pytest；UI 契约；构建幂等；锚点 r32；`upgrade_audit.py` 支持新增符号白名单；报告。

## 5. 冻结面 / 允许面

- **冻结**：`api.py` 哈希 + `API_VERSION`、UI 五大契约既有项、`harbor.html` 既有 DOM 契约、模块数 111、样式数 14、`config.json`/`VERSION`。
- **允许**：顶层符号**新增**（须登记 manifest + 审计白名单）、函数体改写、DOM/class **新增**（只增不改）。
- 审计工具扩展：`upgrade_audit.py` 增加 `ALLOWED_NEW_SYMBOLS` 精确白名单（新增符号必须逐一列明，未列明即 FAIL）。

## 6. 验证方式

- `tests/test_r31_parallel.py`：多 run 并存（A/B/C 三会话）、同会话重入取消、A 结束不清 B、`isSessionStreaming` 语义、群聊 Set 多实例、历史页渲染含统计/筛选/搜索、无并发闸门 grep。
- 全量 `pytest tests/ -q`、`check_contract.py`、`build.js` ×2 幂等、`contract_diff.py --compare r32`、`upgrade_audit.py`。
- 证据类型：命令 + 退出码 + 原始输出；vm 真实调用（非静态断言）。

## 7. PLAN-GATE 三池

**A 池 10/10**：A1 需求→Wave 映射见 §1↔§4 ✔｜A2 每 Wave 有出口校验 ✔｜A3 依赖（manifest/vm 沙箱/build lint）已列 ✔｜A4 风险＋缓解见 §3 ✔｜A5 证据类型见 §6 ✔｜A6 回滚＝git 工作区 + r31 锚点 ✔｜A7 改动文件约 12 个 ✔｜A8 安全面：无外部输入/权限/DB（纯前端运行时）✔｜A9 不触碰 `dist/`、`config.json`、`VERSION` ✔｜A10 中断点＝Wave 边界 ✔
**B 池**：B1/B2/B3/B5/B7/B8 N/A（无 DB/新依赖/跨进程并发/外部接口/批处理/不可逆）｜B4 ✔ 并行开销需实测｜B6 ✔ 测试集已定｜B9 ✔ 影响面已 grep（4 模块 + 模板 + 样式）｜B10 ✔ 无硬编码路径｜B11 N/A（无外部输入边界变更）｜B12 ✔｜B13 N/A
**C 池**：C1 ✔ 每 Wave CHECKPOINT｜C2 ✔ 5 Wave + handoff


---

## 8. 实测证据归档（回填）

- `[GATE-W1]` RunRegistry 多槽重写：`Map<sessionId, run>`，`start()` 仅取消同会话旧 run。
- `[GATE-W2]` `isSessionStreaming` / `refreshStreamingFlag` 新增并登记 manifest；7 处跨会话守卫改按会话；`send.js` 加防御式包装。
- `[GATE-W3]` 群聊 `GROUP_BUSY_SIDS` / `GROUP_PAUSED_SIDS`（Set）+ 按会话 `AbortController` + 群聊 run 登记；`harborStopRun` 支持群聊；旧单值残留 grep=0（仅注释）。
- `[GATE-W4]` 历史页：模板 3 个新区块 + 4 种筛选；`_renderSessionHub` 富卡片渲染；样式入既有 chat.css（样式数仍 14）。
- `[GATE-W5]` `tests/test_r31_parallel.py` 7 passed；宽回归 21 文件 182 passed（+2 文件 13 passed）；UI 契约 PASS；审计 AUDIT PASS（r32 零漂移、白名单外变化 0）；构建幂等；模块 111 / 样式 14；**最终全量 1874 passed / 3 skipped / 0 failed（502.31s）**。
- 失败计数：3（旧断言与新语义冲突 1、契约锚点未推进 1、测试 harness 缺符号 1），均归因后修复；换方法 1（`node -e` → 临时文件，Windows 命令行长度上限）。
