# Harbor js_api 接口参考

> 本文档由 `tools/gen_api_reference.py` 从 `backend/api.py` 实扫生成（签名 + docstring 首段），发布前刷新——**勿手抄**（手抄必漂移）。
>
> - **契约面**：`get_api_info` 列出的方法（与 v1.0.0 legacy 逐字节一致，`tests/test_api_contract.py` 门禁）
> - **隐身面**：`_V12_EXTRA` 登记的新方法（自省不列出，防契约漂移；前端经 pywebview 桥直接调用）

**方法总数**：契约面 51 + 隐身面 80 = 131

## 契约面 · get_api_info 列名（v1.0.0 起逐字节锁定）

| 方法 | 签名 | 说明 |
|---|---|---|
| `append_file` | `(path, content)` | （v1.0.0 legacy 契约方法） |
| `append_memory` | `(entry_json)` | （v1.0.0 legacy 契约方法） |
| `append_worklog` | `(text)` | （v1.0.0 legacy 契约方法） |
| `build_system_prompt` | `(query='')` | query 可选（v1.8.0 W11 记忆注入）：传入当前用户消息 → 注入段按相关度 |
| `build_tools` | `(role='full', include_mcp=False, include_agent=False, is_glm_endpoint=False)` | v1.3：include_mcp=True 且 role='full' 时尾部追加 MCP 工具定义； |
| `cache_tool_output` | `(content)` | （v1.0.0 legacy 契约方法） |
| `copy_into_ws` | `(src, name)` | （v1.0.0 legacy 契约方法） |
| `copy_path` | `(path, new_path)` | （v1.0.0 legacy 契约方法） |
| `delete_path` | `(path, recycle=True, token=None)` | （v1.0.0 legacy 契约方法） |
| `delete_session_ws` | `(sid)` | （v1.0.0 legacy 契约方法） |
| `get_clipboard` | `(token=None)` | （v1.0.0 legacy 契约方法） |
| `get_config` | `()` | （v1.0.0 legacy 契约方法） |
| `get_cwd` | `()` | （v1.0.0 legacy 契约方法） |
| `get_effective_ws` | `()` | （v1.0.0 legacy 契约方法） |
| `get_file_info` | `(path)` | （v1.0.0 legacy 契约方法） |
| `get_memory` | `()` | （v1.0.0 legacy 契约方法） |
| `get_session_ws` | `(sid)` | （v1.0.0 legacy 契约方法） |
| `get_sessions` | `()` | （v1.0.0 legacy 契约方法） |
| `get_worklog` | `()` | （v1.0.0 legacy 契约方法） |
| `get_ws_enabled` | `(sid)` | （v1.0.0 legacy 契约方法） |
| `get_ws_state` | `(sid)` | （v1.0.0 legacy 契约方法） |
| `kill_process` | `(pid=None, name=None, token=None)` | （v1.0.0 legacy 契约方法） |
| `list_dir` | `(path=None)` | （v1.0.0 legacy 契约方法） |
| `list_processes` | `(keyword=None)` | （v1.0.0 legacy 契约方法） |
| `list_recent_ws` | `()` | （v1.0.0 legacy 契约方法） |
| `make_dir` | `(path)` | （v1.0.0 legacy 契约方法） |
| `move_path` | `(path, new_path)` | （v1.0.0 legacy 契约方法） |
| `open_app` | `(path, token=None)` | （v1.0.0 legacy 契约方法） |
| `open_billing` | `()` | （v1.0.0 legacy 契约方法） |
| `open_url` | `(url)` | 用默认浏览器打开网页 |
| `pick_folder` | `(sid=None)` | （v1.0.0 legacy 契约方法） |
| `read_file` | `(path, offset=0, limit=800, force=False)` | （v1.0.0 legacy 契约方法） |
| `read_more` | `(cache_id, offset=0, limit=400)` | （v1.0.0 legacy 契约方法） |
| `rpc` | `(name, payload_json='{}')` | （v1.0.0 legacy 契约方法） |
| `run_admin_command` | `(cmd, token=None, timeout=None)` | （v1.0.0 legacy 契约方法） |
| `run_command` | `(cmd, timeout=60, token=None)` | （v1.0.0 legacy 契约方法） |
| `run_powershell` | `(cmd, timeout=60, token=None)` | （v1.0.0 legacy 契约方法） |
| `save_config` | `(config_json)` | （v1.0.0 legacy 契约方法） |
| `save_sessions` | `(data)` | （v1.0.0 legacy 契约方法） |
| `save_workspace_file` | `(name, text)` | （v1.0.0 legacy 契约方法） |
| `search_replace` | `(path, old, new, replace_all=False)` | （v1.0.0 legacy 契约方法） |
| `set_clipboard` | `(text, token=None)` | （v1.0.0 legacy 契约方法） |
| `set_current_sid` | `(sid)` | （v1.0.0 legacy 契约方法） |
| `set_session_ws` | `(sid, path, enabled=True)` | （v1.0.0 legacy 契约方法） |
| `set_workspace` | `(path)` | （v1.0.0 legacy 契约方法） |
| `set_ws_dir` | `(path)` | （v1.0.0 legacy 契约方法） |
| `set_ws_enabled` | `(sid, enabled)` | （v1.0.0 legacy 契约方法） |
| `take_screenshot` | `(left=None, top=None, width=None, height=None, token=None)` | （v1.0.0 legacy 契约方法） |
| `write_file` | `(path, content)` | （v1.0.0 legacy 契约方法） |

## 隐身面 · _V12_EXTRA（v1.2.5 起新增方法，自省不列、前端可直接调）

| 方法 | 签名 | 说明 |
|---|---|---|
| `apply_update` | `()` | （v1.0.0 legacy 契约方法） |
| `begin_task` | `()` | 修复 W2（三轮）：任务开始重置后端命令去重器——原进程级存活（仅 clear_caches |
| `browser_click` | `(target)` | M3/M4（guard=always）：点击（selector\|text；前后态截图审计）。 |
| `browser_close` | `(session_id='')` | M3/M4：会话池回收（browser_sessions.json 状态同步）。 |
| `browser_extract` | `(selector='', mode='markdown')` | M3/M4 + M2.1：正文提取（readability 风格 → markdown + links）。 |
| `browser_fill` | `(selector, text)` | M3/M4（guard=always）：填充（回传 masked:true，禁回显原文）。 |
| `browser_navigate` | `(url, wait_selector='', timeout=60)` | M3 Win/M4 Mac：通用导航（任意 URL + 等待选择器/硬超时）。 |
| `browser_open` | `(params=None)` | B2：打开 URL 提取正文（selector 覆盖/密度提取；超长截断落 toolcache， |
| `browser_screenshot` | `(full_page=False)` | M3/M4：当前页截图（point 坐标系 b64）。 |
| `browser_search` | `(params=None, token=None)` | B1：浏览器搜索——检索式构造 → 缓存层（TTL 30min）→ 双通道取数 |
| `browser_takeover` | `(takeover_id, action)` | B5：人工接管续跑/放弃（ux-flows 流程 2 步骤 4a/4b）。 |
| `check_update` | `(manifest_url=None)` | （v1.0.0 legacy 契约方法） |
| `checkpoint_create` | `(task_id, files, ws_dir='')` | M3-D1：任务开始建检查点（git HEAD 锚点 / 非 git 文件快照，上限 200MB/500）。 |
| `checkpoint_list` | `(task_id)` | M3-D1：检查点清单（回滚确认浮层展示「将恢复的文件」）。 |
| `checkpoint_rollback` | `(task_id, ws_dir='')` | M3-D1：回滚到任务开始前（调用方须已完成清单二次确认——前端 inline 确认）。 |
| `clarify_collect` | `(questions, answers)` | M3-C1：批量澄清答案收集（缺项用默认值；返回 [{q, answer}]）。 |
| `get_audit_log` | `(limit=200, offset=0)` | 审计日志查看器数据源：倒序返回最新 limit 条（纯本地文件，无网络）。 |
| `get_local_proxy` | `()` | HF-P0：本地 CORS 代理基址——前端 local 模式 fetch 改打代理， |
| `get_platform_info` | `()` | M6.10：平台探测（os/arch/version/services 七接口就绪度）。 |
| `get_update_progress` | `()` | （v1.0.0 legacy 契约方法） |
| `guard_approval_budget` | `(limit=None)` | M2.4：会话级审批预算（{used, limit, escalated}；超限升级任务授权）。 |
| `guard_audit` | `(op, detail_json='{}', decision='allow')` | 前端上报用户决策（allow/deny/session-trust），落审计日志。 |
| `guard_check` | `(op, detail_json='{}')` | 三档判定：返回 {action: allow/confirm/block, reason?}。前端据 action 弹确认框或阻断。 |
| `guard_confirm_token` | `(op, detail_json='{}')` | 修复 S4①：前端确认框「允许」后换取一次性 confirm token（TTL 60s，绑定 op+detail 摘要）。 |
| `guard_get_config` | `()` | 护栏配置：三档矩阵 + 保护名单（guard.json 独立存储，不碰 config.json 契约）。 |
| `guard_rule_add` | `(op_pattern, detail_pattern=None, note=None)` | A5：添加白名单规则（窄规则优先；deny 清单覆盖的创建即拒 → |
| `guard_rule_list` | `()` | A4：白名单规则列表（读取类不落审计）。 |
| `guard_rule_remove` | `(rule_id)` | A6：删除白名单规则（幂等；删除即时生效）。 |
| `guard_save_config` | `(cfg_json)` | （v1.0.0 legacy 契约方法） |
| `guard_session_trust` | `(op)` | 修复 S4①：登记本会话信任（对应确认框「本会话内不再提示」勾选；切会话自动清空）。 |
| `guard_task_grant` | `(scope, ttl_seconds=7200)` | A1：任务授权（进程内状态，不入 guard.json；TTL 默认 7200s（2h 上限 |
| `guard_task_revoke` | `(grant_id=None)` | A2：收回授权（缺省=当前；幂等）。审计 op=guard_revoke。 |
| `guard_task_status` | `()` | A3：授权状态（#grantIndicator 倒计时校准源；含 idle_deadline 与 |
| `history_dir_get` | `()` | 当前历史存放目录（''=默认 ~/.glm-chat/）+ sessions.json 实际路径。 |
| `history_dir_set` | `(dir_path, migrate=False)` | 设置历史存放目录（空串恢复默认；migrate=True 搬旧 sessions.json）。 |
| `hybrid_get_config` | `()` | H1：读混合路由配置（hybrid.json 独立文件；缺失/损坏返回默认 + |
| `hybrid_save_config` | `(cfg_json)` | H2：保存混合路由配置（部分更新语义；字段级校验失败 → BAD_PARAMS， |
| `local_models` | `(base_url, api_key='')` | A3：补拉模型清单（探测过期时用）。 |
| `local_probe` | `(ports=None)` | A2：本地服务器并行探测（11434/1234/8000/8080，各 2s 超时）。 |
| `local_readiness` | `(base_url, model='', api_key='')` | W2：本地模型协同就绪度 8 项评分（deep-research W2）。 |
| `mcp_call_tool` | `(server, tool, arguments_json='{}', decision='deny', token=None)` | 执行 MCP 工具（decision 默认 deny；后端二次 enforce + 审计）。 |
| `mcp_check_tool` | `(server, tool, arguments_json='{}')` | 护栏定档：{action: allow/confirm/block, tier, tier_source, reason?}；落审计 check。 |
| `mcp_delete_server` | `(name)` | （v1.0.0 legacy 契约方法） |
| `mcp_get_server_detail` | `(name)` | （v1.0.0 legacy 契约方法） |
| `mcp_import_claude` | `(config_json)` | 导入 claude_desktop_config.json：{ok, imported, skipped:[{name, reason}], total}。 |
| `mcp_list_resources` | `(server)` | resources/list：{ok, resources:[{uri,name,mimeType,...}], supported}。 |
| `mcp_list_servers` | `()` | 服务器列表（状态灯/工具数/开关数据源）。 |
| `mcp_read_resource` | `(server, uri)` | resources/read：text 类直接返回文本；blob 类落盘 toolcache 并给 |
| `mcp_save_server` | `(name, config_json)` | 保存服务器配置。enabled=true 时：结构校验 → DPAPI 加密 → 预检测 → 测试连接， |
| `mcp_save_subscriptions` | `(server, uris_json='[]')` | 保存资源订阅（mcp_servers.json 新可选键 resourceSubs；Claude 兼容忽略）。 |
| `mcp_set_tool_tier` | `(server, tool, tier)` | （v1.0.0 legacy 契约方法） |
| `mcp_shutdown` | `()` | 关停全部 MCP 传输（main.py atexit 注册 + 测试用）。 |
| `mcp_test_server` | `(name)` | （v1.0.0 legacy 契约方法） |
| `memory_delete` | `(index)` | 实现 v1.8.0 W11：删除 memory.json 数组第 index 条（记忆面板「删除」按钮）。 |
| `memory_retrieve` | `(query, limit=5)` | W11：关键词检索 js_api（前端探活/测试用；items 带 kind）。 |
| `pick_save_path` | `(default_name='export.md')` | 弹出系统「另存为」对话框（SAVE_DIALOG，带默认文件名）→ {ok, path}。 |
| `plan_create` | `(title, steps, task_id='')` | M3-B1：创建计划。steps: [{'text','risk'}] 或 [str]。 |
| `plan_get` | `(task_id)` | M3-B1：读计划（前端刷新/断线重连用）。 |
| `plan_list` | `(limit=20)` | M3：计划清单（最近优先；完成摘要/回滚入口数据源）。 |
| `plan_update` | `(task_id, status='', step_index=None, step_status='')` | M3-B1/B2：改计划状态或步骤状态（批准=status approved；todo 推进=step_status）。 |
| `prompt_get` | `(prompt_id)` | W0 R19：前端读版本化提示词（efficiency/compact/plan-generate 等）。 |
| `sandbox_get_config` | `()` | 沙箱配置：开关 + 命令类别档位 + 各档限制（sandbox.json 独立存储）。 |
| `sandbox_save_config` | `(cfg_json)` | （v1.0.0 legacy 契约方法） |
| `sandbox_status` | `()` | 可用性（平台/创建能力）+ 启用态 + 进程级统计。 |
| `save_export_file` | `(path, content)` | 把导出内容写盘（UTF-8）→ {ok, path, bytes}。 |
| `search_cache_stats` | `()` | B3：搜索缓存统计 {entries, hits, misses, ttl_minutes, size_kb}。 |
| `search_reader_stats` | `()` | M2.1：dual-LLM-lite 读取器统计（reader_calls/schema_fail/degrade_count）。 |
| `search_status` | `(task_id='')` | B4：搜索进度回报通道（面板 1s 轮询，规范 §2.4 方案 A）。 |
| `session_purge` | `(sid, task_ids_json='[]')` | 真删一条会话的全部痕迹：sessions.json 条目 + session_ws 绑定 + |
| `software_call` | `(params=None, token=None)` | S3：外部软件调用三形态（CLI 沙箱执行 / GUI 标题核验 / URI 协议）。 |
| `software_list` | `(status='all')` | S1：外部软件注册表列表（status=all\|probed\|missing；读取类不落审计）。 |
| `software_probe` | `(name=None)` | S2：探测（PATH 扫描 + winreg 补探测 + --version 验身份）。 |
| `start_update_download` | `(url, sha256, version=None)` | （v1.0.0 legacy 契约方法） |
| `test_provider_endpoint` | `(base_url, api_key, model, timeout=15, local=False)` | OpenAI 兼容端点连通性测试（后端 urllib，规避前端跨域）。 |
| `trace_new` | `()` | 强制开启新 trace（js_api 隐身；前端发送入口可显式调用分界请求）。 |
| `webdav_export` | `()` | 导出备份（config+sessions+audit → MKCOL/PUT/manifest；用已存配置）。 |
| `webdav_get_config` | `()` | [预留] 读取 WebDAV 配置（webdav.json，DPAPI 解密 password）。 |
| `webdav_restore` | `(payload_json)` | 从备份恢复（下载 + sha256 对拍 + 三方冲突裁决 + 按策略落盘；用已存配置）。 |
| `webdav_save_config` | `(cfg_json)` | [预留] 保存 WebDAV 配置（校验通过；落盘执行器 v1.6 正式版）。 |
| `webdav_test` | `(cfg_json='{}')` | [预留] WebDAV 连通性测试（PROPFIND）。 |

