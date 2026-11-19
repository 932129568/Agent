# v1.9.0 前后端核对报告（主理人汇编 · 2026-10-23）

> 数据源：master-plan-v19-2026-10-21（迭代总案）+ frontend-handover-v19-2026-10-23（前端交接）+ 代码库两轮确定性扫描（grep 实测，非目测）。
> 结论先行：**v19 前端 = 设计级完成（原型+契约），产品级移植为零；后端 12 个新 js_api 中 4 个已有（v1.8 遗留）、8 个全无（含 M1.9 占位）**。

## 一、前端「已完成」的真实成色（实测）

| 检查项 | 命令口径 | 实测结果 |
|---|---|---|
| v19 新组件进产品代码 | grep `brw-mode`/`grant-budget`/`plan-eta`/`audit-chain`/`mac-kbd`/`brw-row`/`plan-scope` × `frontend/src/`+`index.template.html` | **全部 0 命中** |
| `ckpt-list` 命中 2 文件 | grep 定位 | `67-plan-card.js`+`index.template.html`——**v1.8 旧检查点清单**，非 v19 新三态 |
| 原型交付 | `design/v19/prototypes/` | ✅ 6 文件（10-21~23），评审 PASS（五维 24/25 · P0=0） |
| 契约基线 | `design/v19/*.md` | ✅ api-contract-baseline + component-structure-baseline + quality-review + token-upgrade-plan（10-23） |
| 图片中 `index.html`（26.4KB） | 定位 | = `prototypes/index.html` 原型总览页，**非产品代码** |

**结论**：前端交付的是**原型 + 契约 + 移植规范**（交接报告 9 章），产品代码（frontend/src）零移植。前端自己的交接报告也确认了这一点：「前端按原型先行开发，后端按 M1-M5 里程碑补齐」。

## 二、后端 12 个 v19 新 js_api 现状（实测）

| 方法 | def | _V12_EXTRA | 状态定性 |
|---|---|---|---|
| `checkpoint_create`/`checkpoint_list`/`checkpoint_rollback` | 1/1/1 | ✅ | **已有**（v1.8 plan_service 遗留；M2.7 将升级六军规） |
| `plan_get` | 1 | ✅ | **已有**（A2：断线重连/关卡态刷新用，v1.9 优先级升 P1） |
| `browser_navigate`/`extract`/`click`/`fill`/`screenshot`/`close` | 0 | ❌（含占位） | **全无**（M3/M4/M5） |
| `get_platform_info` | 0 | ❌ | **全无**（M6.10；Win 部分本机可做） |
| `guard_approval_budget` | 0 | ❌ | **全无**（M2.4） |
| `search_reader_stats` | 0 | ❌ | **全无**（M2.1） |

## 三、A/B 差异账（接续 2026-10-21 交接文档口径）

### A 类 · 后端已具备、前端需补齐（前端主动项，非本轮后端范围）

| 项 | 状态 | 场景 |
|---|---|---|
| checkpoint 三兄弟 | 后端在位 | 检查点创建入口/清单对话框/回滚三态（原型已出，等前端产品移植） |
| `plan_get` | 后端在位、前端零调用 | v1.9 计划审查主关卡上线后优先级上升（关卡态刷新恢复） |
| `trace_new` | 后端在位、前端零调用 | 审计五维哈希链上线时应在发送入口显式分界 |
| `list_recent_ws` | 登记不动作 | wsqList 走 config recent 数组有等效数据源 |

### B 类 · 前端将具备、需后端实现（**本轮后端主战场**）

9 个方法（上表 ❌ 行）全部随 M1.9 `_V12_EXTRA` 占位先行（前端可发调用、后端返回未实现错误），按里程碑转正。**M1.9 占位本身也未做**——本轮第一件机械活。

## 四、范围决策（用户 2026-10-23 裁定）

用户原话「**全部搞完**」→ master-plan 九里程碑全量（M1-M9，~64-70 人日）。执行形态（主理人锁定，避免歧义）：

1. **顺序**：M1→M9 逐里程碑推进，每里程碑过门禁（pytest + 契约差分 + check_contract + build×2）才进下一级；
2. **macOS 部分**（M4/M6/M7）：按规格实现 + **明确标注「未实测」**并登记 KNOWN_ISSUES；Windows 可测部分优先闭环——不假装测过；
3. **前端产品移植**：UI 并行会话地界（8 改 1 新模块），本轮完成后端 + 接口契约定稿；
4. **分批交付**：本回合从 M1 开始（架构细化 → 实现 → QA 门禁），每批可验证。

## 五、遗留问题清单（开工基线）

| # | 问题 | 等级 | 处置 |
|---|---|---|---|
| L1 | macOS 真机不可用（本机 Windows）——M4/M6/M7/M9.4-9.5 无法实测 | 高 | Mock+headless 保开发；盲写项标注未实测；M6 前需确认真机窗口 |
| L2 | Apple Developer 账号（$99/年）未确认——M7 签名公证阻塞 | 中 | M7 前到位；未签名降级路径 M7.8 已规划 |
| L3 | 前端产品移植零起步——B 类接口联调需等 UI 会话排期 | 中 | 后端先行 + 契约定稿；占位让前端可并行开发 |
| L4 | dual-LLM-lite「本地」端点形态（Ollama/本地代理）的 schema 约束能力未实测 | 中 | M2.1 实现时按能力探测降级（response_format→grammar→提示词约束） |
| L5 | v1.8.0 tag 曾带 VERSION=1.7.0 出货（版本纪律缺口） | 低 | M1.10 修复（tag 前断言 VERSION==目标版本） |
