### Phase: Intake & Read-Only Discovery (`INTAKE_DISCOVERY`)
**Objective**: 明确用户核心目标、提取关键业务实体标识符，并通过只读工具完成现状探查。

**Entry Criteria**:
- 接收到新的用户请求或新一轮任务目标。

**Exit Gate Criteria**:
- 核心目标与约束条件已无歧义；
- 目标实体的当前基准状态已通过只读工具获取并写入上下文；
- 若任务仅需查询分析，可直接生成最终答复结束会话；若需状态变更，准备跃迁至 `PLANNING_ARCHITECTURE`。

**Execution Guidance**:
- 本阶段仅允许使用 `risk=read_only` 类工具与元工具进行信息收集。
- 优先检查 `[ANCHORED HANDOFF STATE]` 中是否已有可用实体状态，避免重复调用相同的只读查询。
