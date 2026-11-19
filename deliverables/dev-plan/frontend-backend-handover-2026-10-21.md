# 前后端交接文档 —— 前端就绪度与未接清单（2026-10-21）

> 对账方式：两轮确定性扫描（`callApi('x')` 直调正则 + 零引用项全前端字符串二次检索），非目测。
> 基线：commit `bdd8b1d`（历史存放自选目录 + 真删）；前端 86 种调用 / 后端 126 个方法。

## 一、历史存放点功能的前端配合结论

后端 `bdd8b1d` 已交付：`history_dir_get/set`（history.json 独立配置 + 目录校验 + 可选迁移）、
`session_purge`（真删：sessions 条目 + ws 绑定 + plan + checkpoint 快照）。

**前端配合状态（本轮补齐后）**：
- ✅ 接线完好：入口钮（sessions 面板底部「📁 历史目录」）→ 对话框（浏览/迁移勾选/恢复默认）
  复用 legacy `pick_folder`；真删经 monkey-patch `deleteSession` → `session_purge`，
  确认文案已升级为「彻底删除」并回报删除明细（历史条目/工作区/计划/快照）
- ✅ **本轮补**：12 个类级 CSS（`history-dir-btn/mask/panel` + `hd-*` 全套）此前零样式（裸渲染），
  已按 v4 体系补全（玻璃模态 + emphasized 入场 + focus 内发光 + 按压反馈 + fx-off 停列）
- 无其它前端缺口：目录切换后 `refreshHistoryFoot` 已刷新按钮显示当前路径

## 二、对账结论总览

| 类别 | 数量 | 结论 |
|---|---|---|
| A. 前端调用但后端不存在 | **0** | 前端无悬空调用 ✓（86 种全部有后端实现） |
| B1. 后端有、前端经封装转发已接 | 25 | 正常（guard_*/hybrid_*/software_*/plan_*/checkpoint_*/search_*/memory_delete 等） |
| B2. 后端有、前端零引用 | 12 | 见下表逐项定性 |

## 三、B2 零引用 12 项逐项定性（交接核心）

### 🟥 值得前端补的真缺口（3 项）

| 方法 | 签名 | 现状与建议 |
|---|---|---|
| `local_readiness` | `(base_url, model='', api_key='')` | **v18 方案 W2 的 readiness 8 项评分——后端早已备好，前端面板从未做**（此前误判为「需 api.py」，实际现成）。建议：34-local-model.js 加评分面板（8 项 pass/fail 清单 + 总分 + 低分降级建议），调本方法即得 |
| `_software_remove` | `(name)` | 64 软件面板的自定义软件**没有删除入口**（后端已支持，仅限自定义条目、预设不可删）。建议：sw-row 上加删除钮（仅 source=custom 时显示），经 `rpc('_software_remove', [name])` 调用 |
| `pick_save_path` + `save_export_file` | `(default_name='export.md')` / `(path, content)` | 会话导出目前是前端 Blob 下载（浏览器另存）。后端已备**系统级另存为对话框 + 写盘**，体验更原生。建议：exportSessionMd 改走这两方法（失败回落 Blob） |

### 🟨 工具链使用（合理零前端引用，4 项）

| 方法 | 说明 |
|---|---|
| `copy_into_ws` | Agent 工具（workspace_service，带 P0 消毒）——经工具执行链使用，非前端直调 |
| `set_workspace` / `get_session_ws` / `get_ws_enabled` | 工作区域工具/内部方法（38-ws-quick 走既有配置通道） |

### 🟩 低优 / 设计内合理（5 项）

| 方法 | 说明 |
|---|---|
| `mcp_shutdown` | main.py atexit 自动注册调用——设计内无 UI ✓ |
| `plan_get` | 断线重连/刷新用（v18 方案已标注低优）——71-checkpoint-mgr 的 plan_list 已覆盖主场景 |
| `trace_new` | 后端自动生成 trace；前端发送入口显式分界调用属可选增强 |
| `list_recent_ws` | 工作区最近列表（wsqList 走 config 的 recent 数组已有等效数据源） |

## 四、给开发的行动清单（按优先级）

1. **readiness 面板**（最高价值）：后端就绪、纯前端工作——新模块挂 34-local-model.js 或独立 73-readiness.js；返回结构见 `local_model_service` 的 8 项实现
2. **自定义软件删除入口**：64-software-panel.js 的 sw-row 条件渲染 + rpc 转发（注意 `_software_remove` 是私有方法名，经 `rpc` 暴露）
3. **原生导出对话框**：85-session-mgmt.js 的 exportSessionMd 增加后端优先路径（pick_save_path → save_export_file → 失败回落现有 Blob）
4. B1 类 25 个封装转发为既定模式（pcCall/ggCall/swCall/hyCall/tmCall），新增面板沿用即可

## 五、历史遗留对照（此前盘点记录的缺口更新）

- ~~readiness 需 api.py~~ → **本文档更正：后端 `local_readiness` 现成**，纯前端工作
- F1 Reflexion 自反思环 / 记忆结构化三类：仍在并行开发 WIP 域（guard_service/hybrid_router/api.py），待其提交后另行对账
- R23 剪贴板实测已闭环（f2305f6：Job UI Flag 无效，strict 档不加，KNOWN_ISSUES §17 已修订）
