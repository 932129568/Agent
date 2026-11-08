# Harbor R44 轮报告（2026-11-07）——前沿落地第三批

> 接续 R43：HANDOVER-R42 §4 排期的改进 5（MCP 渐进披露）与 12（注入预筛精简版）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 落地 | MCP 工具面渐进披露（阈值折叠 + mcp_search 元工具 + 动态执行）· 注入预筛标注（spotlighting 精简版） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r44**（1260 符号）/ audit PASS / 桥侧 20 PASS / **pytest 1972 passed / 0 failed / 3 skipped** |
| 契约面变更 | js_api 58→59（+mcp_search，_V12_EXTRA）；AGENT_TOOLS 条件含 mcp_search 元工具（仅折叠态） |

## 1. MCP 工具面渐进披露（改进 5）
- **执行链核实**（折叠可行性前提）：mcp__ 工具执行走 `mcpExecTool →
  mcp_call_tool(server, tool, args, decision, token)`——**与 schema 面解耦的
  动态执行**，折叠后模型按检索到的 schema 直接调用动态名天然可行。
- **折叠**（`tools_schema.build`）：mcp__ 定义数 > `MCP_FOLD_THRESHOLD`（25）
  → 全部折叠为单个 `mcp_search` 元工具（三段式 + strict schema）。≤25 全量
  （零行为）。
- **检索**（`mcp_service.search_tools`）：打分=全 query 命中（名×3/描述×1）+
  分词命中（名×1.5/描述×0.5）；**不受楼层闸限制**（被 MAX_TOTAL_TOOLS 截掉的
  工具仍可按需发现——渐进披露的核心价值）；返回完整条目（inputSchema 全文，
  模型据此构造参数）；disabled 服务器不入检索面。
- **前端**：mcp_search 分发 → callApi；模型随后按条目 name 调 mcp__xxx 走
  既有 mcpExecTool（护栏 mcp__ 前缀挂点/确认档/审计全链不变）。
- 测试：折叠阈值两侧 / 元工具 strict+三段式 / 检索打分与 disabled 剔除 /
  空查询 / Api 层无服务器空结果（`test_r44_mcp_fold.py` ×5）。
- 测试对齐：v13 V12 一致性计数 13→14（+mcp_search 登记，按契约演进）。

## 2. 注入预筛标注（改进 12 精简版；spotlighting）
- `provenance.scan_injection`：四类已知指令句式（ignore_previous/
  role_override/system_prompt_probe/exfil_instruction，中英双语）。纯函数，
  **只标注不阻断**——认知沙箱/dual-LLM 留调研延伸。
- `tag_payload` 纯增 `injection_suspect: [模式名]`（内容一字不改——红线
  「包裹只增标记」；url 字段不入扫描面）。
- 测试：四类命中/正常文本零误报/契约 source 键不覆盖/包裹文本不变
  （`test_r44_injection.py` ×4）。

## 3. 排期余量（R42 §4 未落项）
6 排队式 steering（ModelExecutor 轮间语义，需设计评审）/ 7 群聊摘要回传 /
8 专家包三层化 / 10 OTel span / 11 后台任务面板。

## 4. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R44.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r44.json` |
