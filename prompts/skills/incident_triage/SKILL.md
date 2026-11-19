---
skill_id: skill_incident_triage_v4
name: 异常工单诊断与根因定位技能
description: 当用户报告接口报错、任务失败、状态异常或请求排查故障时按需挂载。
trigger_keywords: [报错, 异常, 失败, 排查, 诊断, 超时, error, failed, timeout, bug]
allowed_phases: [INTAKE_DISCOVERY, PLANNING_ARCHITECTURE, VERIFICATION_HANDOFF]
recommended_tools: [query_execution_trace, fetch_system_metrics]
priority: 85
ttl_turns: 3
---

### 1. 适用边界
适用于针对特定业务流水号、任务 ID 或时间窗口内异常行为的根因定位与修复建议生成。

### 2. 标准执行序列
1. **锚定时间与标识**：确认请求中是否包含明确的 `trace_id`、`task_id` 或时间范围；若缺失，优先通过只读查询工具按用户/租户检索最近一条失败记录。
2. **拉取执行轨迹**：调用 `inspect_tool_schema` 激活 `query_execution_trace` 并获取完整错误码、失败节点与上游返回值（若日志超过长度阈值，自动落盘后使用关键字检索关键 `ERROR` 片段）。
3. **交叉核验指标**：若轨迹显示为外部依赖超时或资源瓶颈，调用 `fetch_system_metrics` 核实对应时间窗口的错误率与延迟分布，区分“偶发瞬断”与“持续性配置/代码缺陷”。
4. **结构化结论输出**：按 **【现象摘要 -> 根因定位（附证据 ID） -> 影响范围 -> 修复建议】** 四段式输出。

### 3. 高信息密度参考示例
- **输入**：“任务 `task_9821` 刚才跑失败了，帮我查下原因。”
- **正确执行路径**：
  1. 激活并调用 `query_execution_trace(task_id="task_9821")`；
  2. 发现报错 `ERR_UPSTREAM_AUTH_401`（发生于步骤 `sync_warehouse`）；
  3. 输出结论明确指出失败节点、原始状态码 `401` 及凭证轮换修复动作，而非笼统回复“请检查网络”。

### 4. 常见陷阱提示
- 严禁仅凭报错名称主观猜测根因，必须以 `query_execution_trace` 返回的实际失败节点日志为准。
