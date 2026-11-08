# R30 · 全库迭代升级与 UI 重构 — 执行计划

> 技能：编程专家（dev-expert）｜档位：**大项目档**（111 前端模块跨 17 类 + 后端 7 域 + 构建链 + UI 视觉层）
> 生成时间：2026-11-05 | 项目：`GLM-Chat-v1.0.0-完整开发包`（Harbor）

## 状态

已完成（Step 1.5→Step 6 全七步闭环执行完毕；全量门禁见 §6 归档；按技能「版本控制约束」未代 git 提交，17 个文件待用户手动提交）。

## 不卡死计数

- 诊断失败计数：0
- 换方法次数：0
- 门禁重走轮次：0
- CHECKPOINT：Wave 1 完成 / Wave 2 完成 / Wave 3 完成 / Wave 4 完成 各落一次。

---

## 1. Step 1.5 需求锁定（验收口径，实施前冻结）

### 1.1 用户原话拆解 → 可验收判据

| 用户要求 | 可验收判据（冻结） |
|---|---|
| 逐一梳理当前所有功能模块，分析各自问题与改进空间 | 报告逐类覆盖 17 类前端（111 模块）+ 后端 7 域 + 工具链 + 测试/CI，每类含「职责 / 已具备 / 问题与改进空间 / 本轮处置 / 理由」 |
| 针对每个功能提出并实施升级方案 | 每类至少 1 条**实码级**升级或明确的「保持 + 理由」；本轮 4 类升级（性能 / 结构 / 健壮性 / UX）+ **UI 重构**均有**产品侧**改动（非仅工具链） |
| 性能优化 | 至少 1 处可实测基线与优化后对比，附命令 + 输出 |
| 代码结构改进 | 至少 1 处重复/散落定义收敛为单一事实源，附「旧范式残留 grep = 0」 |
| 健壮性与错误处理增强 | 至少 1 处真实缺陷修复，附「异常输入 → 无污染」的 vm 真实调用证据 |
| 用户体验提升 | 至少 1 处可见行为改善，附断言 |
| **ui 重构**（本轮新增） | CSS 视觉层实质重构：焦点环令牌统一 + 新增无障碍媒体查询；五大 UI 契约 PASS |
| 保持核心用途与对外行为兼容、不引入破坏性变更 | 冻结面零漂移（见 §1.2）；正常输入下输出逐字节一致；不新增/删除顶层符号 |
| 汇总每项功能的优化点与升级效果 | 报告含逐功能表格（优化点 / 效果 / 验证证据 / 未覆盖边界） |

### 1.2 冻结面与允许面（关键纪律，先声明后动手）

**冻结面（必须零漂移）**：
- `backend/api.py` 逐字节哈希 + `API_VERSION='v1.0.0'`
- UI 五大契约：40 DOM id / 13 onclick / 43 callApi / 39 CSS 类 / 21 CSS 变量
- `harbor.html` 的 DOM id / onclick / callApi 目标集合
- 顶层符号集合（1155 项，不新增、不删除、不改名）
- 模块数 111 / 样式数 14 / `EXPECTED_ORDER` 逐项顺序
- `config.json` / `VERSION` / `get_api_info()` 零改动

**允许面（预期变化，作为升级证据逐项列明）**：
- `source_line_multiset_sha256`（JS 源码非空行多重集）→ 必然变化（函数体改写）
- `function_defs`（逐函数定义体哈希）→ **仅声明白名单内函数变化**，其余 1150+ 项恒定

**处理方式**：生成 `contract-baseline-r31.json`（升级后锚点）入库；用 `tools/upgrade_audit.py` 做 r30→r31 定向审计，断言「对外契约零漂移 + 函数哈希变更集合 ⊆ 白名单」。**不修改 `contract_diff.py` 的 FROZEN 判据**（技能「门禁资产只读」），不弱化任何既有断言。

### 1.3 假设与 In/Out

- **假设 A**：CSS 视觉层改动（新增变量、新增媒体查询、统一色值引用）不触碰 `check_contract.py` 的 PRESENCE 判据（该脚本只查 `v + ':'` 存在性）。撤销条件：契约校验报 CSS 变量/类缺失。
- **假设 B**：`analytics/tokens.js` 的 `calcUsage` 等函数在 vm 沙箱可真实调用（既有 8 个测试文件已覆盖）。撤销条件：vm 加载失败。
- **In**：UI 重构（CSS）、产品 JS 性能/健壮性/UX、升级审计工具、测试、r31 锚点、逐类盘点报告、全量验证、复盘交接。
- **Out**：真机 GUI（用户指定 `dist/Harbor.exe` 且由其提供截图，不主动启动）、macOS、性能基准、代码签名、`outputs/` 清理、后端业务重构、模块拆分（R28/R29 已做，本轮不引入新破坏性变更）、`js_api` 契约变更。

---

## 2. Step 2 方案（五段）

### 2.1 输入 / 输出 / 约束

- **输入**：`frontend/styles/*.css`（14 个，其中 5 个含焦点环规则）、`frontend/src/analytics/tokens.js`、契约锚点 r28/r29/r30、UI 契约常量。
- **输出**：升级后的 CSS/JS、`harbor.html` 重建产物、`tools/upgrade_audit.py`、`tests/test_r30_upgrades.py`、`contract-baseline-r31.json`、`R30-契约差分与升级审计.md`、`R30-全库逐类盘点与升级效果报告.md`。
- **硬约束**：只改 `frontend/index.template.html`（本轮不改）+ `frontend/src/*.js` + `frontend/styles/*.css`；`node frontend/build.js` 重建；勿手改 `harbor.html`；不新增顶层符号；不新增模块/样式；不删任何文件。

### 2.2 候选方案与取舍

| 候选 | 做法 | trade-off | 结论 |
|---|---|---|---|
| **A（采纳）** | 行为兼容增量升级：CSS 令牌收敛 + 函数体内改写 + 新增无障碍媒体查询；新锚点 r31 + 定向审计 | 源码面哈希变化需如实披露，但对外契约可证明零漂移；风险最低、可逐项验证 | ✅ 采纳 |
| B | 精确行搬移式重构（R28/R29 模式），保持源码哈希恒定 | 只能改文件归属，无法改函数体 → **无法满足「性能优化/健壮性增强/UI 重构」的实质要求** | ❌ 反选（撤销条件：用户要求零源码变化） |
| C | 全量重构 111 模块 + 后端 7 域 | 直接违背「不引入破坏性变更」，推翻 1861 项零失败基线 | ❌ 反选 |

### 2.3 边界与失败模式

| 失败模式 | 处置档位 |
|---|---|
| UI 契约校验因新增 CSS 变量失败 | **拒绝**（回滚该变量，改用已有变量） |
| `function_defs` 变更集合超出白名单 | **拒绝**（定位越界改动并回退） |
| vm 沙箱 `document.addEventListener` 不存在 | **放行 + 标记**（`typeof` 守卫，测试桩提供该 API） |
| 正常输入下 `calcUsage` 输出与升级前不一致 | **拒绝**（逐字段对比断言） |
| 后台隐藏时跳过轮询导致统计陈旧 | **放行 + 标记**：visibilitychange 恢复时立即补刷一次，用户可见态数据始终最新 |
| 全量 pytest 出现新增失败 | **拒绝**（定位 + 修复；门禁资产不得为通过而弱化判据） |

**二阶效应**：改动 `--focus-ring` 色值引用 → 影响所有 `:focus-visible` 规则外观，但不改变 DOM/JS；新增 `document.hidden` 早退 → 影响轮询时机，但可见态行为不变且补刷闭环。枚举后判定：**无跨模块二阶效应**（全部限于 CSS 表现层与单模块函数体）。

**歧义清单**：「UI 重构」在本轮中被解释为**视觉一致性 + 无障碍增强的重构**（不改 DOM 结构、不改交互流程）——这是「不引入破坏性变更」硬约束下唯一自洽的解释。声明假定，证伪条件=用户明确要求改 DOM 结构。

**未知清单**：均已闭合（见 §2.5 实码 trace）。

### 2.4 权衡结论

选择「产品侧实质升级 + 契约差分如实披露」，代价是源码面哈希不再恒定；换取的是用户明确要求的性能/健壮性/UX/UI 四类真实改进。**该代价通过 r31 新锚点 + 逐函数白名单审计转化为可机读证据**，而非静默放过。

### 2.5 环境事实行与引用点实码 trace（命令实测，非记忆）

```
Node        : v22.22.2（PATH）
Python      : 3.13.14（C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe）
git HEAD    : 65989be feat(R29)（R29 24 文件已由本轮收口提交，工作区干净）
manifest    : 111 scripts / 14 styles
UI 契约     : PASS — 五大契约全部保住（40 id / 13 onclick / 43 callApi / 39 类 / 21 变量）
```

| 引用点 | 实码位置 | 确认结果 |
|---|---|---|
| 焦点环 4 种色值 | `components.css:44,127-136,143` / `chat.css:52,74` / `generative.css:17,41,209` / `legacy.css:196,539` / `base.css:14` | `--accent`×7 / `--primary`×10 / `--focus-ring`×2 / `--ui-accent`×1，确证不统一 |
| `--focus-ring` 定义 | `tokens.css` :root 末尾 | `var(--accent)`，dark 未覆盖 |
| `prefers-contrast` / `forced-colors` | 全 14 CSS grep | **0 处**，确证空白 |
| `button:disabled` 重复 | `base.css:12` / `components.css:43` / `legacy.css:2344` | 3 处完全重复 |
| 滚动条硬编码 | `legacy.css:198` | `10px` 字面量 |
| `updateTokenStat` O(n²) | `analytics/tokens.js:69` | `allMsgs = allMsgs.concat(s.messages)` |
| 10s 轮询 | `analytics/tokens.js:120` | `setInterval(...,10000)` 无 hidden 早退 |
| `document.hidden` 先例 | `overlays.js:24` / `navigation.js:214-215` | 已有 visibilitychange 监听范式可复用 |
| `calcUsage` 负值风险 | `analytics/tokens.js:12-18` | `(prompt - c)` 在 `c > prompt` 时为负，`u.*_tokens` 无非数值兜底 |
| `providerPriceFor` | `providers/provider.js:128-139` | 所有分支均返回 `{in,out,cache}`，`Number(...)||0` 兜底 → 价格对象本身安全 |
| 后端 `json.loads` 17 处 | 上下文窗口 ±4 行扫描 | **全部在 try/except 或调用层保护内**（误报），不改后端 |
| `contract_diff.py` FROZEN | `:111-112` | `('ui','api_version','api_py_sha256','html','source_line_multiset_sha256','function_defs')` |
| `_source_line_multiset` | `:60-68` | 仅 `frontend/src/**/*.js` 非空行 → CSS 改动不影响该面 |
| `_html_contract` | `:69-76` | 仅 DOM id/onclick/callApi 目标 → CSS 改动不影响该面 |

---

## 3. Step 3 执行（Wave 链式，每 Wave 落 CHECKPOINT）

### Wave 1 · UI 重构（任务 #23）
1. `tokens.css`：新增 `--focus-ring-w:2px` / `--focus-ring-offset:2px` / `--disabled-opacity:.48` / `--scrollbar-size:10px`；`body.dark` 覆盖 `--focus-ring` 为高对比亮蓝；新增 `@media (prefers-contrast:more)` 提升焦点环宽度与边框对比。
2. `base.css`：`:focus-visible` / `:disabled` / `::selection` 改引用新令牌；新增 `@media (forced-colors:active)` 规则（焦点环用 `Highlight` 系统色、禁用态用 `GrayText`）。
3. `components.css` / `chat.css` / `generative.css` / `legacy.css`：把 `outline:2px solid var(--accent|--primary|--ui-accent)` 统一为 `outline:var(--focus-ring-w) solid var(--focus-ring)`；`button:disabled` 3 处收敛为 `opacity:var(--disabled-opacity)`；滚动条 `10px` → `var(--scrollbar-size)`。
4. **旧范式残留 grep = 0** 证据：`outline:2px solid var(--` 应为 0；`opacity:.48` / `opacity:.5` 在 disabled 规则中应为 0。
5. CHECKPOINT：build lint + UI 契约 + 目视 diff。

### Wave 2 · 产品 JS 升级（任务 #24）
1. `updateTokenStat`：`allMsgs.concat` → 分项累加（直接 `sessions.forEach` 内累加 total/cached/cost*），输出字段与文本完全一致。
2. 10s 轮询：回调内加 `if (typeof document !== 'undefined' && document.hidden) return;`；新增 `visibilitychange` 监听，恢复可见时立即 `updateLiveTokenStat()`（复用 `try/catch` 与 `!isStreaming` 早退）。**不新增顶层符号**（用 IIFE 内匿名回调 + `typeof` 守卫）。
3. `calcUsage` / `accumulateUsage`：`num()` 局部 helper 做 `Number.isFinite` 兜底，`Math.max(0, prompt - c)` 防负值。正常数据输出逐字节一致。
4. CHECKPOINT：vm 真实调用对比（正常数据 / 异常数据 / hidden 态）。

### Wave 3 · 审计工具 + 测试 + 锚点（任务 #25）
1. `tools/upgrade_audit.py`（新增，不碰 `contract_diff.py`）：读 r30/r31，断言 ① ui / api_version / api_py_sha256 / html 全等 ② symbols 集合全等 ③ module/style count 全等 ④ `function_defs` 变更集合 ⊆ 白名单 ⑤ 白名单外函数哈希零变化；输出可机读 JSON + 人读报告。
2. `tests/test_r30_upgrades.py`：CSS 令牌/媒体查询/残留断言 + vm 行为等价 + 异常输入健壮性 + hidden 早退 + 审计工具自检。
3. 生成 `contract-baseline-r31.json`；`contract_diff.py --compare r30` 如实列明漂移面（预期 2 项）。
4. CHECKPOINT：审计 PASS + 新增测试全绿。

### Wave 4 · 终验与交付（任务 #26）
1. 全量 pytest（后台）+ UI 契约 + 构建幂等 ×2 + 契约差分 r30/r31 + 升级审计。
2. `R30-全库逐类盘点与升级效果报告.md`：17 类前端 + 7 域后端 + 工具链 + 测试/CI 逐类表；每项优化点 / 效果 / 证据 / 未覆盖边界。
3. 收尾 5 字段 + 四类复盘 + `.ai-memory/` 三层记忆 + `handoff.md`。
4. **不代 git 提交**（技能「版本控制约束」），列出待提交清单。

---

## 4. Step 4 验证清单（大项目档全项）

- [ ] 清单化质量自审 10 条 + 安全红线 10 条逐项打勾
- [ ] 覆盖完整性枚举：正常/异常/边界/调用方/分支 + 静态全量扫描
- [ ] 配对契约：新增 CSS 变量 ↔ 引用点 grep 同源；旧范式残留 = 0
- [ ] 真人功能验证（L0）：vm 沙箱真实调用 `calcUsage` / `updateLiveTokenStat`（真实入口 → 操作 → 输出断言）；UI 用构建产物 CSS 规则断言替代静态检查（真机 GUI 属既有边界，如实披露）
- [ ] 证据 ≥1 条/改动文件（原始命令输出）
- [ ] 根因闭环：升级前基线 → 升级后断言 → 测试入库路径
- [ ] 回归基线：同模块无新增失败；全量 ≥1861 passed / 0 failed
- [ ] 回滚决策：所有改动均在 git 工作区可 `git checkout` 回退；r30 锚点保留

---

## 5. PLAN-GATE 三池打勾

**A 池（10/10）**：A1 需求→步骤映射见 §1.1↔§3 ✔｜A2 每 Wave 含出口校验 ✔｜A3 依赖/配置显式列出（CSS 令牌、vm 沙箱、pytest venv）✔｜A4 风险＋缓解见 §2.3 ✔｜A5 证据类型见 §4 ✔｜A6 回滚＝git 工作区 + r30 锚点 ✔｜A7 改动文件数：CSS 6 + JS 1 + 新增 3 + 报告 2 + 锚点 1 ≈ 13 ✔｜A8 安全触发面：无外部输入/权限/DB/上传/后台操作（纯前端表现层与纯函数）✔｜A9 用户定制文件：`dist/` exe、`config.json`、`VERSION`、`KNOWN_ISSUES.md` 均不触碰 ✔｜A10 中断点＝每 Wave CHECKPOINT，回退到上一 Wave 末状态 ✔

**B 池**：B1/B2/B3/B7/B8 N/A（无 DB/新依赖/并发幂等/批处理/不可逆操作）｜B4 ✔ 性能需基线对比（`updateTokenStat` O(n²) 实测）｜B5 N/A（无外部系统接口）｜B6 ✔ 测试集已选定（`tests/test_r30_upgrades.py` + 全量）｜B9 ✔ 依赖影响面已查（function_graph + grep 复核，见 §2.5）｜B10 ✔ 命令参数完整无硬编码路径｜B11 N/A（纯内部同构改动，无外部输入边界变更）｜B12 ✔ plan 回读确认｜B13 N/A（未命中 error-ledger 索引触发词）

**C 池**：C1 ✔ 改动 ≥5 文件 → 每 Wave 落 CHECKPOINT｜C2 ✔ 跨 4 Wave → 每 Wave 完成落 handoff 检查点

**规划自审**：占位符扫描 = 0 ✔｜签名一致（`calcUsage(messages)` / `accumulateUsage(s,u)` / `updateLiveTokenStat()` 均实码确认）✔｜需求→步骤反向核对 = 全部覆盖 ✔｜引用点实码 trace = §2.5 全表 ✔

---

## 6. 实测证据归档

（随 Wave 推进回填，收尾报告引用 `[GATE-n]` 行号。）

- `[GATE-0]` 基线：`git log -1` = 65989be（R29 24 文件已由本轮收口提交），工作区干净；UI 契约 PASS（111 JS / 14 CSS）；r30 锚点自比对零漂移。
- `[GATE-1]` Wave1：`node frontend/build.js` EXIT=0（111 模块 / 14 样式 / 28880 行）；`check_contract.py` PASS；令牌闭环 `--focus-ring-w` 定义 3/引用 22、`--focus-ring-offset` 1/15、`--disabled-opacity` 1/3、`--scrollbar-size` 1/2；焦点令牌引用 18；旧范式残留 = 2（cn-flash 有意保留）。
- `[GATE-2]` Wave2：`build.js` EXIT=0；symbols 1155→1155（新增/丢失均空）；ui/api_version/api_py_sha256/html 全零漂移；function_defs 变更集合恰 4 项。
- `[GATE-3]` 审计：`upgrade_audit.py` AUDIT PASS（冻结面 7 项零漂移、白名单外变化 0、函数体总数 1154→1154）；r31 锚点自比对零漂移 PASS。
- `[GATE-4]` 证伪：篡改 `newSession` 哈希 → 检出「白名单外函数定义体变化(1)」；删 `chatContainer` → 检出「对外契约面漂移: ui」。
- `[GATE-4b]` 性能隔离基准：旧 calc+concat 11.2ms / 旧 calc+push 5.2ms / 新 calc(num闭包)+concat 32.1ms / 新 calc+push 27.0ms / **出口兜底+push 6.9ms**；最终 vm 实测 old=12.3ms new=5.8ms（53% 提升），正常数据 calcUsage/accumulateUsage/updateTokenStat 逐字段一致，异常数据旧版被污染、新版全有限非负，hidden/可见补刷/可见轮询三态 True。
- `[GATE-5]` 终验：构建幂等 OK；UI 五大契约 PASS；审计 PASS；`git status` 17 个待提交文件。
- `[GATE-6]` 门禁回归处置：首轮全量 1 failed（`test_contract_diff` BASELINE 硬编码 r29）→ 改为自动发现最新锚点 + 补链单调断言，17 passed（契约工具 + R30）。
- `[GATE-7]` 最终全量 pytest：**1867 passed / 3 skipped / 0 failed**（361.21s），较 R29 净增 6 项恰为本轮新增测试；零失败基线保持。

## 7. 实测证据归档（不卡死计数复核）

- 诊断失败计数：2（UI 测试断言过宽 1 次、性能反转 1 次），均经归因后修复，非同签名重复。
- 换方法次数：1（健壮性校验由热循环内逐字段 → 循环出口兜底，依据 2×2 隔离基准）。
- 门禁重走轮次：1（全量 1 failed → 锚点链自动发现 → 重跑）。
- CHECKPOINT：Wave1 / Wave2 / Wave3 / Wave4 各 1 次，共 4 次。
