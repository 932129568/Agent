# HANDOVER-R58 — 会话对话逻辑升级（编辑重发/回退/定点重生成）+ 生成式 UI 版本化

> 日期：2026-11-08。接续 HANDOVER-R57.md。任务（用户）：「优化会话页面聊天对话逻辑
> （回退/重新编辑重新发送等），调研更新一下；对生成式 UI 进一步更新迭代」。
> 调研：`outputs/r58-research/方向A-对话回退与重发.md` · `方向B-生成式UI迭代.md`
>（双方向前沿调研——ChatGPT/Claude.ai/Cursor/LangGraph 分支语义 + Vercel json-render/
> Google A2UI/OpenAI Canvas/Artifacts 生成式 UI 谱系）。

## 0. 一眼总览

| 维度 | 状态 |
|---|---|
| 全量 pytest | **2046 passed / 0 failed / 3 skipped**（R57 基线 2042 → +6：R58 新测 6） |
| 契约锚点 | **r58**（116 模块 / 1298 符号） |
| build | ×2 幂等 ✓（harbor.html 31985 行） |
| 提交 | 本轮 1 笔 |

## 1. 对话逻辑（R58 实施项）

| 功能 | 语义 | 位置 |
|---|---|---|
| **编辑并重发**（新） | user 消息操作条：内联 textarea 编辑 → 截断其后全部 → 替换内容（数组形态保图片段）→ 重跑 Agent 循环。`edited` 标记 + 历史渲染「已编辑」小徽标 | markdown.js `msgEditResend` |
| **回退至此**（新） | user 消息操作条：保留 [0..midx]（含本条），其后消息进**内存撤销缓冲**（单槽、不随 sessions.json 持久化——撤销窗口=页面生命周期），横幅 10s 一键撤销（拼接回历史，不重跑模型） | markdown.js `msgRollback` + `_rollbackUndoBanner` |
| **定点重生成**（升级） | 历史 assistant 操作条 regen 带自身 `midx`——从**本轮提问**起重跑（原实现点旧消息实际总从最后一条 user 重跑，语义误导）；live 气泡/缺省语义不变 | send.js `regenerate(midx)` |
| 配平守卫 | 三入口均限 user 边界截断（assistant.tool_calls+tool 消息不可分割——调研 A1 的 safeTruncate 语义以「构造上不可越界」达成）；流式中一律拦（同 msgRecall） | 三函数共用 `_convBusyGuard` |
| 计费口径 | usage 单调累计不退还（R37 S8 语义保持）；回退横幅注明「已消耗 token 不退还」 | — |

**裁决**：分支树（parentId 单字段，调研 A2/A3 主推）**留 R59**——v1 先 truncate-and-resend
（数据结构零改动，旧会话零迁移）；usage 双口径（A4）/fork 新会话（A5）/回退三档联动
checkpoint（A8）同留档。共同前置项：消息级 id（调研冲突点 #2 的 dedup 签名升级已先落地）。

## 2. 生成式 UI 迭代（R58 实施项 = 调研 B2）

**UiSpec 版本化（Claude Artifacts 模式）**：
- `message.uiVersions[]`（上限 4）+ `message.uiSpec`（激活版）——本地即时视图→模型编排升级、
  手动重转的每次变更都留版本，重生成不再「一刷新旧视图就没了」；
- 视图标题栏 `‹ n/m ›` 切换箭头（多版本时显示）——**纯本地换序重挂，不重跑模型**；
  切换=把选中版移到时间线末尾（Artifacts 语义），激活版恒为末位；
- 两个持久化点（本地即时 + 模型成品）改走 `chatAutoStoreVersion`（同 spec 幂等不推版本）；
- **dedup 签名升级**（调研冲突点 #2 实证）：`sid::回答长度` → `sid::最近assistant下标::回答长度`
  （消息级回退/同长度重发后撞签名 → 该渲染的不渲染）。

**留档下一轮**（调研 P0/P1 剩余）：`render_ui` 工具直产（B1——模型主动生成视图，需契约面
加法轮：tools_schema+provider+dispatch+lint+双链）、块级编辑回路（B3 Canvas 模式）、
流式渐进渲染（B4，projection 重复 commit 地基已在）、HTML 自由视图（B5——若做必须
iframe srcdoc + sandbox=allow-scripts **且绝不加 allow-same-origin** + 内层 CSP，
Shadow DOM 无安全边界不适用于不受信内容；L3 HTML 全文禁入 messages）。

## 3. 测试

`tests/test_r58_conversation.py`（6 测试）：
- 编辑重发 harness：busy 拦截/截断替换重跑/数组内容文本段替换保图/空编辑拒/非 user 拒；
- 回退 harness：中段截断进缓冲/横幅挂载/撤销恢复原序/最新位 noop/assistant 边界拒/busy 拦；
- regenerate(midx) harness：中段定点/缺省末轮/误传回落（**截到提问本身**——期望初版算错已纠）；
- 版本化 harness：首存无历史/二存推历史/同 spec 幂等/上限 4/激活版恒末位/切换换序保时间序；
- 静态接线断言（midx 透传/徽标/dedup 签名/manifest 登记）。
- 基建教训：**模块 const 遮蔽 eval 全局**（round6 同款）；DOM 桩必须前置于模块（const 后置
  =全脚本 TDZ）；`_fe()` 解析用 basename 或 legacy 别名。

## 4. 调研要点（下轮直接取用）

1. **parentId 单字段分支树**（Open WebUI 方案）：存双份 childrenIds 正是其 issue #29299
   切分支失效根源——只存 parentId，children 派生。每消息 +60-100B，零迁移。
2. **prompt 缓存失配 12.5x**：编辑点越靠前重发越贵——编辑重发确认框（后续轮可加）应提示。
3. **A2UI（2025-12 开源）/json-render** 验证了 Harbor UiSpec 白名单组件路线押对；
   render_ui 工具直产是 L2 共识，列为 R59 首选。
4. 消息体膨胀红线：uiSpec（KB 级）可入 messages；HTML 全文（MB 级）必须落独立文件+哈希。

## 5. 提交

```
feat(R58): 会话对话逻辑升级——编辑重发（截断+替换+重跑+已编辑徽标）+ 任意位置回退（内存撤销缓冲+横幅一键恢复）+ 定点重生成（历史 regen 带本轮边界）+ 配平守卫（user 边界截断/流式拦截）；生成式UI 版本化（uiVersions 上限4+‹n/m›切换+dedup 签名升级）；锚点 r58；pytest 2046 绿
```
