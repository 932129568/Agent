# P0-1 最终结论：145 方法跨语言行为差分全结论

- 日期：2026-10-30
- 执行：工程师（寇豆码）；harness=P0-1（T01-T03）、修复=P0-1b（T01-T05）、全覆盖=本 T05
- 基线链：首轮差分 66 suspect → P0-1b 修复 62 项 + 4 登记 → 本轮 11 新族 92 方法补齐
- **最终全量证据**：`outputs/diff/20261030172234/`（fixtures=28 / calls=265 / match=174 / intentional=5 / suspect=86 / error=0）；覆盖率门禁 `npm run diff:coverage` **exit 0**（fixture 139 ∪ uncovered 13 = 152 方法宇宙全覆盖，145 注册方法无缺口）

## 一、145 方法四分类总表

| 分类 | 数量 | 方法 |
|---|---|---|
| **match**（双侧行为等价） | 70 | meta：—；sessions 族：set_current_sid、session_purge；plans：plan_create/get/list/update、checkpoint_create/list/rollback、begin_task；guard 全 14（check/confirm_token/session_trust/rule_add/list/remove/task_grant/revoke/status/approval_budget/audit/get_audit_log/get_config/save_config）；commands：run_command、run_powershell、run_admin_command；export：pick_save_path、save_export_file；browser 全 10 错误路径（navigate/extract/click/fill/screenshot/close/sessions/set_mode/search/takeover）；software：software_list/call/probe；files：list_dir、search_replace、write_file；workspace：set_workspace、get_cwd、pick_folder、append_worklog、get_worklog；memory：append_memory；misc-config：sandbox_save_config、clear_caches；provider：cache_tool_output、trace_new、clarify_collect、check_update、get_update_progress、start_update_download、apply_update；experts：expert_get/save_preferences/set_enabled/delete_package；mcp：mcp_delete_server、mcp_save_subscriptions、mcp_shutdown；rpc：save_config、get_config；selftest 3（分类器自检已随修复收敛为回归金丝雀） |
| **intentional**（已登记差异，ID-001 已签核 / ID-101..104 待签核） | 4 方法（5 登记） | get_api_info（ID-001 exe）；save_sessions（ID-101 存储分叉 + ID-104 解析器文案）；get_sessions（ID-102 回读级联）；history_dir_set（ID-103 migrate 语义） |
| **suspect**（疑似缺陷——只登记不修，P0-1c 评审输入） | 65 | 见 §二 分类明细 |
| **uncovered**（环境绑定，登记豁免） | 6 方法（13 登记） | 正向路径未差分：browser_open、take_screenshot、open_app、open_url、open_billing（真实本机副作用/非确定输出）；list_processes（宿主机瞬时态）。另 7 项登记（browser 六原语+search 正向）已有错误路径 fixture 覆盖，登记仅覆盖其正向分支 |

## 二、65 项 suspect 分类明细（新发现，P0-1c 评审清单）

**【形状分叉类（键集不同）——39 项，多数为 Node 简化实现】**
- 工作区族 9：get_effective_ws（{sid,ws,source,exists} vs {ok,ws,enabled,bound}）、get_session_ws、set_session_ws、get_ws_enabled、get_ws_state、set_ws_enabled、delete_session_ws、list_recent_ws（对象数组 vs 字符串数组）、save_workspace_file
- 配置族 9：hybrid_get/save_config、model_prefs_get/save、reader_config_get/save、sandbox_get_config、sandbox_status、search_cache_stats（{entries,hits,misses,ttl_minutes,size_kb} vs {ok,entries,bytes}）、search_reader_stats、search_status
- MCP 族 9：mcp_list_servers、mcp_save_server、mcp_get_server_detail、mcp_set_tool_tier、mcp_check_tool、mcp_call_tool、mcp_test_server、mcp_import_claude、mcp_list_resources、mcp_read_resource
- 文件族 5：read_file（行号/分页/编码细节）、append_file（限流 note）、get_file_info、make_dir、move_path、copy_path、delete_path（recycled 字段）
- 其他 7：get_clipboard（JSON 对象 vs 裸文本）、set_clipboard（{ok,len,verified} vs {ok}）、get_platform_info（services 七接口 vs node/arch）、ui_nudge（visibility 键）、get_local_proxy（{port,base_url} vs {base_url}）、get_memory/memory_delete/memory_retrieve（ts_iso 键）、read_more

**【内容/文案类——19 项】**
- provider 6：build_system_prompt（沙箱尾注/记忆注入段）、build_tools（工具描述集）、prompt_get、test_provider_endpoint、local_models、local_probe、local_readiness（评分口径）
- webdav 5：webdav_get/save_config、webdav_test、webdav_export、webdav_restore（离线错误文案）
- experts 4：expert_list（Python 构造期导入 8 内置包 vs Node 空注册表——**功能缺失类**）、expert_import_directory、expert_read_resource
- kill_process（pid→名称反查拒杀语义）、rpc（数组 payload 语义：Python 归一 {} 报缺参 vs Node 展开位置参数）、copy_into_ws（Python 时间戳前缀 `005407_copy.txt`）、run_admin 之外的 dedup 细节

**【安全/前端消费类（评审优先标注）】**
- **expert_list 内置包缺失**：Node 未迁移 builtin experts 导入（功能缺失，P0-1c 或 P0-3 处置）
- **kill_process**：Python 有 pid→进程名反查 + 伪造名拒杀（防绕过名单），Node 直接 taskkill——**安全语义缺失**
- **read_file 分页/编码**：前端文件查看器直接消费面（行号/total_lines/offset 字段）
- **build_tools / build_system_prompt**：Agent 工具面与系统提示词——模型行为直接影响面

## 三、证据链

| 阶段 | runId | 结果 |
|---|---|---|
| P0-1 首轮（八族） | 20261030125905 | match=54 / intentional=1 / suspect=66 |
| P0-1b 修复后 | 20261030155054 → 20261030163332 | suspect 66→0（match=120 / intentional=5） |
| T05 新 11 族首轮 | 20261030165346 | match=48 / suspect=86 / error=0 |
| T05 稳定性复跑 | 20261030165809 | 同上逐项一致（suspect 全部稳定非抖动） |
| **T05 全量终轮** | **20261030172234** | **match=174 / intentional=5 / suspect=86 / error=0；既有 14 fixture 零翻转** |
| 覆盖率门禁 | 20261030171748 等 | **exit 0**（139 fixture ∪ 13 uncovered = 152 宇宙无缺口） |

回归：16 组 Node 测试全绿；Python 全量新基线保持（1767/0/3/1，见 outputs/pytest-tmp/t05-regress/junit.xml）。

## 四、残留与交接

1. **P0-1c（建议立项）**：65 项新 suspect——39 形状分叉（多为 Node 简化实现的补齐）+ 19 文案/内容 + 安全类 4（kill_process 反查、expert 内置包、read_file 消费面、工具面）。数量与 P0-1b 相当，建议按同一模式（架构师方案→修复→差分收敛）排期
2. **ID-101..104 签核**：intentional-deltas.json 已预登记（approvedBy="pending"），待 team-lead 签核生效
3. **P0-2**：存储语义定案（ID-101/102/103 的 DB 侧等价语义）
4. **P0-3/P0-4**：browser 六原语正向路径（真机验收 P1-2）；admin Electron 对话框接线；React 侧 browser_set_mode 收紧确认
5. **门禁常规化**：`npm run diff:coverage` exit 0 已纳入常规验证口径（未进 test:all——主理人批准后纳入）
6. **selftest 族角色演化**：三个分类器自检 fixture 已随 P0-1b 修复收敛为「修复回归金丝雀」（shape-divergent 的 set_current_sid、value-diff 的 guard label/tier、shape-mask 的 %r 均已 match）——形状分叉检测能力在 P0-1b 期间验证后未再变更 comparator 代码；如需重建分叉检测用例，可从 65 项现存 suspect 中选取登记
