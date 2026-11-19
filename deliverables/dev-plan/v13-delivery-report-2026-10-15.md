# GLM-Chat v1.3.0「生态位」MCP 支持交付报告

**日期**：2026-10-15 | **类型**：交付报告 | **团队**：software-glmchat-v13（主理人齐活林 / 架构师高见远 / 工程师寇豆码 / QA 严过关三棒接力）
**输入**：PRD v1.1（grill 四问裁决冻结）→ 架构设计（T1-T5 / 21.5 人日）→ 全栈实现 → QA 对抗回归 → 发布门全绿

---

## 📌 TL;DR

v1.3.0 把 GLM-Chat 从「单机工具执行者」升级为「本地 MCP 宿主」：手写最小 MCP 客户端（stdio + Streamable HTTP，钉死 2025-06-18 协议）+ Claude 兼容配置与一键导入 + DPAPI 字段级加密 + 分层护栏（服务器默认关 / 注解推导三档 / 后端二次 enforce / 全量审计 / R4 熔断）。**151 个测试全绿，契约四红线零漂移，VERSION → 1.3.0。开放不以信任为代价。**

## 交付概览

| 项 | 结果 |
|---|---|
| 交付状态 | ✅ 完成（代码 + 测试 + 文档全部落盘） |
| 全量测试 | **151 passed**（66 既有 + test_v13_mcp.py 51 + test_v13_qa.py 34），主理人独立复跑两轮一致 |
| UI 契约 | check_contract.py PASS（40 DOM id / 13 onclick / 43 callApi / 39 CSS 类 / 21 主题变量，只增不改） |
| 构建幂等 | node frontend/build.js 两次 md5 一致（41fefe29d710325b4043544bb4c9aec4，35 模块） |
| 版本号 | VERSION 1.2.2 → **1.3.0**（APP_VERSION 动态读取验证 = 1.3.0；API_VERSION='v1.0.0' 契约号未动） |
| 已知源码缺陷 | **0**（QA 发现的 1 处已修复并摘 xfail 标记） |
| 遗留人工项 | 3 项（装机冒烟 / exe 打包自更新 / 真实 MCP 服务器联调——本环境无外网无 webview，只能验证到测试层） |

## 需求实现对照（R1–R7）

| 需求 | 实现 | 验收证据 |
|---|---|---|
| R1 协议客户端核心 | `mcp_client.py`（握手/版本钉死/游标分页/tools·call/ping/取消/-32601）+ `mcp_transport_stdio.py` / `mcp_transport_http.py` 双传输 | R1 五条 Given/When/Then 全部有测试取证（版本不匹配人话含 supported 列表、超时取消、HTTP 协议头断言） |
| R2 配置管理 | `mcp_config_service.py`（Claude 兼容 mcpServers + enabled/tierOverrides + 导入冲突跳过 + SSE 条目明确跳过）+ `~/.glm-chat/mcp_servers.json` | 导入 3 服务器默认 enabled=false、同名冲突报告、config.json 逐字节零污染（真实文件前后比对） |
| R3 分层护栏 | `mcp_service.py`（derive_tier 注解推导 / tierOverrides 优先 / enforce 矩阵 / 后端二次 enforce / 审计 op=mcp_call / R4 熔断接入零改动复用） | enforce 矩阵 9 组合全测、绕过前端（decision 缺失）always 档拒绝、×3 熔断、拒绝原因回传 Agent |
| R4 工具注入执行 | `build_tools(role, include_mcp=False)` 默认路径与 legacy 逐字节一致；`mcp__<server>__<tool>` 命名净化；仅 full 角色注入；structuredContent 序列化；超长截断落盘 read_more | 与 legacy **实例**逐字节比对（ro/chat/full × ws on/off）；双工具注入回传；前端 62-mcp-exec.js fail-closed |
| R5 设置面板 | `frontend/src/29-mcp.js`（列表/状态灯/表单/测试连接/逐工具档位/导入模态/instructions 展示）+ index.template.html 纯新增区块 | UI 契约 PASS；前端 node 实测（fail-closed/会话信任/标签/挂点） |
| R6 生命周期 | 按需拉起 + 崩溃自动重拉一次 + idle 600s 回收 + atexit 规范关闭序列（关 stdin→3s→TERM→2s→KILL）+ uvx/npx 预检测（shutil.which+PATHEXT） | 真实子进程退出无残留、SIGKILL 兜底（僵尸桩）、缺运行时人话指引、崩溃人话含真实退出码 |
| R7 测试契约 | test_v13_mcp.py（51）+ test_v13_qa.py（34 独立对抗） | 151 passed 全绿 ×2；契约差分 / UI 契约 / 构建幂等全过 |

## Grill 四问裁决落实（PRD §10）

| 裁决 | 落实 |
|---|---|
| Q1 DPAPI 捆绑 | `mcp_dpapi.py`：ctypes CryptProtectData 字段级加密（标记 `{"__enc__":"dpapi:..."}`，只加密 env/header 值，键名明文，解密失败明文兜底+日志） |
| Q2 仅 full 角色 | `tools_schema.build` 仅 role='full' 且显式 mcp_tools 时尾部追加；ro/chat 即使 include_mcp=True 也不注入（有专测） |
| Q3 启用时预检测+兜底 | `precheck_command`（expandvars+which+PATHEXT）缺失阻断启用并给 uv/Node 官网指引；which 通过仍失败走崩溃标记+重拉一次+红状态灯 |
| Q4 instructions 展示不注入 | initialize 响应 instructions 仅面板详情可见（标注不注入），不进任何 prompt 组装路径 |

## 文件清单

**后端新建（6）**：`backend/services/mcp_dpapi.py`、`mcp_config_service.py`、`mcp_transport_stdio.py`、`mcp_transport_http.py`、`mcp_client.py`、`mcp_service.py`
**后端修改（4）**：`backend/api.py`（_V12_EXTRA +10 隐身方法、build_tools 加 include_mcp=False、装配 McpService）、`backend/tools_schema.py`、`backend/paths.py`（+MCP_SERVERS_FILE）、`main.py`（atexit mcp_shutdown）
**前端新建（2）**：`frontend/src/29-mcp.js`（插 28 后 30 前）、`frontend/src/62-mcp-exec.js`（插 60 后 65 前）
**前端修改（6）**：`25-tool-exec.js`（护栏挂点+分发）、`60-agent-loop.js`（include_mcp 传参+mcp__ 路由放行）、`00-state.js`（mcpTrusted/mcpServers）、`80-utils.js`（buildToolLabel MCP 分支）、`28-audit-viewer.js`（d.server 审计分支）、`index.template.html`（MCP 设置区块+纯新增 CSS）；`100-send.js` +3 行（打开设置刷新 MCP 列表，计划外挂钩，QA 回归验证无破坏）
**测试新建（2）**：`tests/test_v13_mcp.py`（51 用例，工程师自测）、`tests/test_v13_qa.py`（34 用例，QA 独立对抗）
**测试修改（1）**：`tests/test_security_fixes.py`（修既有 flaky test_real_exit_code——monkeypatch 冻结 time.time）
**文档**：PRD v1.1（§10 四问裁决）、架构设计 architecture-and-tasks-v1.3-mcp-2026-10-15.md、本报告；`docs/` 三份为架构师输出规范副本
**版本**：`VERSION` → 1.3.0

## js_api 新方法（10 个，全部 _V12_EXTRA 隐身）

`mcp_list_servers` / `mcp_save_server` / `mcp_delete_server` / `mcp_test_server` / `mcp_get_server_detail` / `mcp_set_tool_tier` / `mcp_check_tool` / `mcp_call_tool`（decision 默认 deny 防绕过）/ `mcp_import_claude` / `mcp_shutdown`。`get_api_info` 输出与 legacy 逐字节一致；10 个方法均可直接调用。

## QA 过程实录（三棒接力，429 配额中断两次）

- **QA-1**：写完 54KB 对抗测试套件（34 用例：契约红线与 legacy 实例逐字节比对 / PRD 补证 / 八类对抗深挖 / 前端 node 实测 / 冒烟六步测试层自动化），取证到 1 处源码缺陷后被配额切断
- **QA-2**（reasoning 模型）：修复既有 flaky（位置勘误：在 test_security_fixes.py 而非工程师汇报的 test_v12_features.py），被切断
- **QA-3**（lite 模型）：裁定契约红线全量失败的根因 = **测试隔离缺陷，非源码漂移**——test_api_contract.py 循环末轮在 legacy 模块级内存 `_RT['ws_enabled']['']` 残留 False，conftest fresh_home 只清文件不清内存，导致全量顺序下 legacy 侧 ws_on=False、new 侧默认 True 的假失败；修法显式弹出残留，比对强度不降。修复后全绿。**其报告因配额未送达，QA 结论以测试工件（85 用例全绿）+ 主理人两轮独立复跑为准**
- **源码缺陷回路**：QA-1 取证崩溃人话 `client.transport` 应为 `_transport`（退出码永远显示 ?）→ 工程师返场修复（L361 属性名 + StdioTransport 已有 returncode property 无需新增 + 删除三处无人消费的 entry['transport'] 死写入）→ xfail 转真实回归门（摘标记为机械执行 QA 裁定意图，因 QA 配额耗尽由工程师执行、主理人验证，特此记录角色边界例外的理由）

## 已知问题与风险（非缺陷，信息项）

1. 架构文档示例加密标记曾写 `dp64:`，实现以类图 `dpapi:` 为准（文档笔误，不影响代码）
2. 模块数口径：前端 33 既有 + 2 新增 = 35 模块（文档曾写 34，为 32 旧口径）
3. `100-send.js` +3 行计划外挂钩（toggleSettings 打开时刷新 MCP 列表），QA 回归验证无破坏
4. 中风险（PRD §1 已载）：手写客户端协议正确性依赖打桩测试，真实服务器联调待装机环境；stdio 子进程可能被杀软误报（发布说明需提示）

## 遗留人工项（装机环境必测）

1. **起窗冒烟六步全链路**：导入 Claude 配置 → 启用服务器 → Agent 调用弹确认 → 拒绝后 Agent 收到原因 → 审计查看器可见 op=mcp_call → 同工具同参数 ×3 触发熔断暂停
2. **exe 打包 + 自更新实测**：PyInstaller onefile 打包 v1.3.0、1.2.2 → 1.3.0 自更新链路
3. **真实 MCP 服务器联调**：stdio（如 @modelcontextprotocol/server-filesystem）与 Streamable HTTP 服务器各一，验证握手/分页/调用/断连恢复
4. 观察杀软对 stdio 子进程拉起的误报情况

## 过程数据

- 架构设计 24 分钟（429 中断一次恢复）；工程实现 85 分钟一次过（IS_PASS: YES）；QA 三棒合计约 55 分钟有效工时；缺陷返修 + 清理 11 分钟
- 基础设施事件：429 队列/配额中断 3 次（架构师 1 次恢复成功；QA 2 次，经 default→reasoning→lite 模型轮换完成接力）
- 全量测试基线演进：62（v1.2）→ 117（+工程师 51）→ 150（+QA 34、修 flaky、修隔离）→ **151**（摘 xfail 转真实回归门）
