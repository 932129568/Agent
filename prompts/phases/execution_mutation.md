### Phase: Controlled State Mutation (`EXECUTION_MUTATION`)
**Objective**: 在确定性护栏监控下精准执行状态变更工具，并核验写入结果。

**Entry Criteria**:
- 前置只读校验已完成，高危操作已获显式确认令牌。

**Exit Gate Criteria**:
- 目标变更工具返回 `ok=true`；
- 变更后的关键实体状态已核验一致，准备跃迁至 `VERIFICATION_HANDOFF`。

**Execution Guidance**:
- 每次仅执行计划内的确定性工具调用；若收到 `ERR_PRECONDITION_NOT_MET` 或 `ERR_SCHEMA_*` 拦截，按 `self_healing_action` 立即修正。
- 写操作成功后严禁以相同参数重复触发调用。
