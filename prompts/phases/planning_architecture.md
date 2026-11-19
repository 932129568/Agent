### Phase: Mutation Planning & Risk Assessment (`PLANNING_ARCHITECTURE`)
**Objective**: 基于已探明的实体基准状态，确定最小变更步骤序列并识别高危写入边界。

**Entry Criteria**:
- 已完成相关只读状态探查，且确认用户意图需要执行数据/状态修改。

**Exit Gate Criteria**:
- 变更所需的全部必填参数已齐备且类型合法；
- 若涉及 `risk=destructive_write` 操作，已生成面向用户的变更确认清单；
- 准备跃迁至 `EXECUTION_MUTATION`。

**Execution Guidance**:
- 核对目标工具的 `requires=...` 前置依赖列表，确保所有前置读取工具均已在当前检查点中成功执行。
- 若存在多种可行修改路径，优先选择幂等（`idempotent_write`）且影响范围最小的路径。
