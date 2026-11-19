# Harbor R54 轮报告（2026-11-07）——全功能模拟实测

> 首次以 CDP 连接真实运行实例做端到端功能验证（非单元测试/非 VM 沙箱）。
> 环境：隔离 CONFIG_DIR + harbor:// 协议 + Node 桥 production 链。

---

## 0. 一眼看全局

| 维度 | 结果 |
|---|---|
| 启动 | ✅ harbor:// 协议加载 + bridge 端口 61132 + CDP 19222 |
| 页面渲染 | ✅ title=Harbor, origin=harbor://app, 3 面板, 0 JS errors |
| 关键符号 | ✅ 全部 function/object（renderMd/hubCatalog/callApi/sendMessage/RunRegistry/renderMdStream/memoryDbEntriesRefresh） |
| UI 元素 | ✅ sidebar/chatContainer/memoryBlock/settingsPanel/hubChip/guard_selects×10/notifyPop/bgTasksBlock |
| **桥 API 分类** | **26 可用 + 15 正确错误 + 7 裸文本 + 16 NOT_MIGRATED（Python 专属）** |
| 优雅降级 | ✅ 记忆面板正确显示「未启用（功能不受影响）」 |
| 会话操作 | ✅ sendBtn/userInput/mmAddBtn/mmList 全存在 |

## 1. 桥 API 61 方法全量探活分类

### 1.1 ✅ Node 桥已实现（26 个）——全功能可用
get_api_info, get_config, get_memory, get_sessions, list_recent_ws,
get_audit_log, search_cache_stats, search_status, memory_retrieve, trace_new,
mcp_list_servers, mcp_check_tool, guard_get_config, guard_check, guard_audit,
guard_task_status, guard_task_revoke, guard_approval_budget, guard_rule_remove,
guard_rule_list, begin_task, clear_caches, set_current_sid, build_system_prompt,
get_cwd, get_platform_info

### 1.2 ⚠️ NOT_MIGRATED（16 个）——Python 专属，Node 桥未实现
memory_stats, memory_entries_list, memory_search, memory_write, memory_erase,
memory_entries_erase, memory_entry_pin, memory_audit_query, memory_context_build,
memory_remember, memory_retrieve 已有但 memory 域扩展未迁移,
trace_recent, notes_append, notes_get, mcp_search, webdav_status, group_files_search

**影响**：R42-R50 新增的记忆工具/结构化笔记/trace/MCP 渐进披露在 **Electron
生产链不可用**（pywebview 链正常）。前端已优雅降级（面板显示「未启用」）。
**修复方向**：Node 桥补建（代理转发到 Python 或 JS 重实现）。

### 1.3 ✅ 正确错误（15 个）——方法存在、参数不足/边界拒绝
mcp_call_tool, guard_save_config, guard_confirm_token, guard_session_trust,
guard_task_grant, guard_rule_add, prompt_get, expert_get, expert_read_resource,
list_dir, read_file, write_file, append_file, search_replace, check_update

### 1.4 ✅ 裸文本返回（7 个）——legacy 协议
get_cwd, get_worklog, begin_task, clear_caches, build_system_prompt,
save_workspace_file, get_sessions

## 2. CDP UI 验证清单

| 验证项 | 结果 |
|---|---|
| 页面加载 | ✅ origin=harbor://app（R40 协议生效） |
| 主布局 | ✅ sidebar + chatContainer + 3 data-panel |
| 关键函数符号 | ✅ 全部存在（renderMd/renderMdStream/hubCatalog/callApi/sendMessage/RunRegistry/getActiveRuns/memoryPanelInit/planFinishIfNatural/memoryDbEntriesRefresh/routeTools） |
| 设置面板 | ✅ 可打开/关闭 |
| 记忆面板 | ✅ 正确显示「扩展记忆库：未启用」（NOT_MIGRATED 优雅降级） |
| 通知中心 | ✅ 打开/关闭正常 |
| 后台任务面板 | ✅ 渲染「无在途任务」 |
| 护栏档位 selects | ✅ 10 个 |
| hub catalog 数据 | ✅ hubCatalog().experts.length = 394 |
| JS 错误 | ✅ **0 个** |

## 3. 关键发现：Node 桥迁移缺口

**16 个 Python 专属方法在 Electron 生产链返回 NOT_MIGRATED**。这些方法的
功能（记忆工具/结构化笔记/trace/MCP 渐进披露/群文件读取）在 pywebview
链完全正常，但在 Electron 生产链不可用。

**前端已优雅降级**：记忆面板显示「未启用（功能不受影响）」，不会崩溃。

**修复方向**（优先级排序）：
1. Node 桥补建 memory_* 方法（代理转发到 Python 后端进程或 JS 重实现）
2. Node 桥补建 notes_*/trace_recent（简单——文件读写 + JSON 追加）
3. mcp_search 代理（MCP 楼层闸已移 Node 侧）

## 4. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R54.md` |
