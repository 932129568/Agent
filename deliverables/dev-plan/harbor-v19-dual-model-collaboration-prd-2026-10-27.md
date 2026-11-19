# Harbor 双模型协同增量 PRD：云端规划验收与本地执行

- 日期：2026-10-27
- 状态：需求锁定，交架构师统一设计；本阶段只读审计与文档，不改产品代码
- Project Name：`harbor_v19_dual_model_collaboration`
- 技术边界：Python stdlib + pywebview + WebView2 + 原生 JavaScript；不引入新模型 SDK、框架或第二套运行时
- 上游：`harbor-v19-unified-parallel-architecture-2026-10-27.md`、专家模式 PRD、现有 HybridRouter 与混合路由 UI
- 原始需求：云端强模型负责理解、计划、拆解、验收并指挥本地执行；本地返回后云端检查、修正并整合。本地优先以降 Token，复杂推理、校验、本地失败或低置信才升级云端；同时保证隐私、预算、异常恢复和原单模型不变。

## 1. 产品定义

### 1.1 Product Goals

1. **一个运行时内的模型分工**：将双模型协同作为共享 ModelExecutor + TaskDAG 的分配策略与协作模式，不堆叠第三套模型/代理架构。
2. **本地执行为主、云端把关为界**：云端 planner/reviewer 负责计划与验收，本地 worker 承担多数可执行任务；升级必须有原因、预算和 provenance。
3. **隐私与成本可控、质量可证**：上传范围显式最小化，调用前预算阻断，工具副作用不自动重放；用确定性流程、质量 rubric 与分账验证，而非虚构真实端点质量。

### 1.2 User Stories

- 作为复杂任务用户，我希望云端把目标拆成可执行 DAG，本地逐步完成，云端再根据真实结果验收、修正并整合。
- 作为成本敏感用户，我希望本地承担大部分执行，云端只做必要规划/校验/升级，并在超过预算前停止而不是事后报警。
- 作为隐私敏感用户，我希望启用时明确知道哪些内容会上传，默认不带附件、工作区原文和全量历史；敏感任务可强制仅本地。
- 作为单模型用户，我希望协同默认关闭，原有请求体、工具、调用次数、usage、连接配置与交互完全不变。
- 作为维护者与 QA，我希望云/本地 actor 复用同一 executor、任务状态、取消、恢复与 Team/Expert 事件机制，且每步可追踪、可测试。

## 2. 现有能力盘点与缺口

### 2.1 可复用资产

| 现有能力 | 代码证据 | 本轮复用方式 |
|---|---|---|
| 可解释任务分类 | `HybridRouter.classify_task` 支持 understand/validate/plan/compose、置信度、scores/reasons | 作为任务分配候选信号，不另写关键词路由；不能把分类置信当质量置信 |
| 三策略路由 | `auto/saver/quality`，auto 分类、saver 本地优先、quality 全云 | 保留现有混合路由行为；collaboration 是默认 off 的新可选字段，不改旧 strategy 语义 |
| 本地时间预算 | understand 默认 5s、validate 默认 3s，`check_budget` 供在途判断 | 作为 worker 阶段 deadline 输入之一；不是云/总 token 预算 |
| 降级与升级 | 置信门 0.7、3 连败 unavailable + 60s 探测、degrade_notice | 复用本地健康与原因记录；协同 fallback 必须可被隐私策略禁用 |
| 小阶段请求 | `stage_request` 控制本地 max_tokens，Ollama keep_alive | 可复用 worker 请求组包思想，但协同统一走共享 transport/executor |
| 成本分账 | `record_usage/cost_split` 分 local/cloud token、费用与 saved；前端 hybridOnUsage/chip | 扩展为按 actor/phase/taskId/messageId 分账，避免 planner/worker/reviewer 重计 |
| 设置与就绪度 | `hybrid_get/save_config`、hybrid.json、混合路由卡、local_readiness 8 项 | 在原混合路由卡增加协同区，复用本地能力/连接检测，不新增平行设置 |
| 流式请求与 run | `providers/request.js` 有 fetch/retry/AbortSignal；run-controller 有工具循环、usage、取消、会话隔离 | 提取/使用共享 ModelExecutor 与角色 EndpointRef；不在 Python 新建客户端 |
| 连接配置 | `settings/connection.js` 有 providerState/localState、预设、Key、URL、模型和测试 | 复用已有配置与入口，不复制 API Key；角色请求绑定快照，不来回改全局端点 |
| 统一调度与专家 | 统一架构已有 TaskRegistry/DomainScheduler/TaskEnvelope、共享 ModelExecutor、Team actor/mailbox/event | 协同是模型角色路由；可复用 actor/event/projection/recovery，不新造协作协议 |

### 2.2 明确缺口与约束

- 现有 HybridRouter 只做**决策与记账**，没有完整的 `plan→tasks→dispatch→review→revise→final` 闭环，没有计划 schema、任务依赖、审查记录或修正整合语义。
- 当前 `run-controller.js` 仍含请求、SSE、工具、渲染、预算和持久化大循环；统一架构要求的共享 executor 是目标底座，不能把现有函数直接当可重入多 actor 运行时。
- 当前连接是**单活动端点状态机**：`providerState/localState` 随预设切换，active local/cloud 是互斥呈现。协同不能通过反复修改 `localState.mode/providerState` 或全局模型名来切换角色。
- 云端与本地 EndpointRef 必须从既有配置派生并绑定 run 快照；本地预设激活时云端配置来源、云端预设激活时本地配置来源需架构明确，但不得复制秘密或建立第二配置体系。
- 现有 `record_usage` 主要按 completion tokens 和全局 local/cloud 分账；协同需要 prompt+completion、调用次数、角色/阶段、费用和重试的精确口径。
- 本轮未重跑测试、未构建、未启动 exe；当前大量 W2/W3 未提交迁移继续受原正确性门约束。

## 3. 统一方案与红线

### 3.1 协作定位

**CollaborationController = ModelExecutor 上的一种 run 模式 + TaskDAG 的模型分配策略。**

- `cloud-planner`：理解用户目标，生成受 schema 约束的 DAG、验收标准与数据范围。
- `local-worker`：按 task 能力/依赖执行，返回结构化结果、证据引用、usage 与自评。
- `cloud-reviewer`：对照计划与验收标准检查结果，给出 pass/revise/fail、问题定位与修正意见。
- `local-reviser` 或 `cloud-reviser`：按复杂度/失败/低置信选择修正执行者，修改后必须重新验收。
- `cloud-finalizer`：只整合已通过的结果与必要修正，生成最终答复；不得把未执行/未通过任务写成完成。

这些是可复用 **actor 角色**，不是新模型客户端。普通聊天、单 Agent、Expert/Team 可按同一角色路由复用；Team 的 lead/member 关系不被改成云/本角色，二者是正交维度。

### 3.2 默认与兼容红线

- collaboration **默认关闭**；只有用户显式启用并确认上传范围后才可进入协同模式。
- 原单模型与旧 hybrid strategy 行为不变：请求体、tools、调用次数、usage、终态、端点和设置均做差分。
- 不新建 Python 模型客户端，不复制 API Key/endpoint 秘密，不把云端 planner 当全局 lead 注入普通聊天。
- config.json 不变；优先在 hybrid.json 增加可选 `collaboration` 对象，缺省等价 off，旧 hybrid.json 与旧字段保持原义。
- 新 js_api 仅 `_V12_EXTRA`，get_api_info 逐字节不变；运行控制优先前端内部函数，不增加不必要的后端 run API。
- 现有 sessions 是唯一会话事实源；协同事件/计划/结果/审查引用复用 SessionStore 与专家事件机制，不建第二协作数据库。
- Guard/审计/工作区/工具权限、预算硬停、取消/会话隔离、公开 DOM/API/CSS 契约不被削弱。

## 4. 状态机与任务分配

### 4.1 Run 状态

```text
draft → planning → planned → dispatching → reviewing
                         ↘ failed/partial/cancelled/budget_exceeded
reviewing → revising → reviewing
reviewing → completed（仅全部必需任务 pass 且 final 已整合）
任意非终态 → cancelled / budget_exceeded / failed / partial
```

- `planned` 仅在 schema、DAG、数据范围与预算预检通过后进入；无效计划返回 planning 有限修正或 failed，不直接 dispatch。
- `reviewing` 必须消费真实 task resultRef；无结果、结果不匹配或证据缺失不得 pass。
- `completed` 必须满足：必需任务全 pass、未决修正为 0、最终整合已生成且引用正确。其他有产出但未全通过为 `partial`。
- 本地/云端连接失败、schema 失败、超时、取消、预算不足均有明确状态与可恢复 checkpoint；重载不假装仍在运行。

### 4.2 Plan / Task schema（产品契约）

```text
CollaborationPlan {
  schemaVersion, planId, runId, goal, createdBy: cloud-planner,
  dataScopeRef, acceptanceCriteria[], tasks[], budgetSnapshot, planDigest
}
CollaborationTask {
  taskId, title, instruction, dependsOn[],
  capability { kind, requiredTools[], outputKind, complexity },
  sensitivity, inputRefs[], outputSchemaRef,
  route { preferred: local|cloud, reason, confidence? },
  attempt { current, max }, resultRef?, review?, revisionOf?
}
TaskResult {
  taskId, attempt, actor, status, contentRef, evidenceRefs[],
  usageRef, selfCheck { ok, issues[], confidence? }, provenance, terminalReason?
}
TaskReview {
  taskId, attempt, verdict: pass|revise|fail,
  issues[{ code, message, evidenceRefs[], severity }],
  revisionInstruction?, confidence?, reviewer, reviewDigest
}
```

约束：taskId 在 plan 内唯一；dependsOn 无环且引用存在；P0 限制任务数/深度/正文与结果大小（由架构冻结）；attempt、resultRef、reviewDigest 一一对应，旧 review 不覆盖新 attempt。

### 4.3 分配规则

1. **云端规划/验收**：协同完整流程的 planner/reviewer 默认云端；轻任务是否可省略规划由架构定义，但不得借“本地优先”取消用户要求的云端验收。
2. **本地优先执行**：默认 `preferred=local`，本地执行大多数可执行子任务；只有以下情况升级云端：
   - 复杂推理/规划/跨任务整合超出本地能力；
   - 独立校验或云端 reviewer 必需；
   - 本地失败、超时、schema 连续不合法、工具能力不足；
   - 本地结果低置信或 reviewer 要求云端修正。
3. **能力判定**：综合 `local_readiness`、工具支持、上下文窗口、任务 capability、历史确定性失败；关键词 classify 只辅助，不把模型自我声明当唯一事实。
4. **本地优先不等于本地调用比例承诺**：调用结构随任务而变；成本验收分别报告 local/cloud 调用和 token，不伪造“本地占多数”结果。
5. **fallback 受隐私约束**：本地失败可升云仅当数据范围允许；强制仅本地或 fallback disabled 时进入 partial/failed，不上传。

## 5. 重试、预算、取消与恢复

### 5.1 重试与副作用

- 仅**幂等模型请求**可在连接失败、可重试 429/5xx、可重放 schema 校验失败时按 max retry 重试；沿用 transport 的 abortable backoff，保留 attempt 与 usage。
- 已产生完整响应但 schema 无效，可要求同角色修正；不得无界重复 planner/reviewer。
- 工具写操作、命令、MCP call、文件修改、WebDAV、外部副作用 **不自动重放**。模型重试必须生成新计划/修正意图，并经原 Guard/去重/用户授权重新审查。
- 网络超时不知道上游是否完成时标 `unknown`，不得同时重放本地与云端相同副作用任务。

### 5.2 预算与 deadline

- hybrid.json 可选字段至少覆盖：`enabled`、`local_first`、`cloud_token_budget`、`total_token_budget`、`max_review_rounds`、`max_model_retries`、`deadline_s`、`fallback_policy`、`upload_scope`。
- token 同时约束 cloud prompt+completion 与 total local+cloud prompt+completion；费用限额另按 cloud 实际价格估算/真实 usage。
- **每次模型调用前**原子检查并预留额度；planner/reviewer/finalizer 必须先保留云端额度，不得全被 worker 用完后无法验收。
- 无可靠 usage 的端点按现有估算口径标记“估”，预算使用保守上限；实际 usage 到达后结算，未用预留释放，messageId 防重复。
- deadline 覆盖 planning/dispatch/review/revise/final 全链路；超时后可保留 partial，不发起新的云/本地调用。

### 5.3 取消与恢复

- 顶层 run 只有一个 active owner；planner/worker/reviewer 是子 actor。所有事件带 runId/sessionId/generation/taskId/attempt。
- 取消停止当前 fetch、待派发任务与后续 review；工具副作用按原同步 RPC 取消真相处理，不宣称强杀。
- checkpoint 保存 planDigest、已完成 task/result/review refs、未消费事件、预算消耗与数据范围；恢复使用新 runId/parentRunId，已完成无副作用结果不自动重跑。
- 旧 run 的迟到帧、usage、review 不得修改新 run；恢复时重新检查本地/云连接、预算和隐私许可。

## 6. 配置与连接兼容

### 6.1 hybrid.json 可选扩展

```json
{
  "strategy": "auto",
  "local_budget_understand_s": 5,
  "local_budget_validate_s": 3,
  "confidence_gate": 0.7,
  "cost_split_display": true,
  "collaboration": {
    "enabled": false,
    "local_first": true,
    "cloud_token_budget": 30000,
    "total_token_budget": 120000,
    "max_review_rounds": 2,
    "max_model_retries": 1,
    "deadline_s": 1800,
    "fallback_policy": "allow_bounded",
    "upload_scope": "task_summary_only"
  }
}
```

- 缺省 collaboration 或任一字段时，按安全默认补齐；`enabled` 永远默认 false。旧配置字段、保存部分更新、损坏备份和未知键策略需要向后兼容。
- 不将数值示例写成所有模型通用最佳值；架构可调整范围，但必须能配置更严，包/模型不能放宽宿主上限。
- 原 strategy=auto/saver/quality 继续表示旧路由；collaboration.enabled=true 时明确新模式优先，关闭后回到原策略，不改旧配置值。

### 6.2 EndpointRef 与秘密复用

- 复用现有 cloud provider 与 local 连接、模型、价格、测试、local proxy；秘密只从现有 provider/key 内存/配置通道取得，不写 hybrid.json、事件、日志或第二密钥库。
- `EndpointRef {role, preset, baseUrlRef, model, credentialRef, prices, toolCapability, ctxWindow, snapshotDigest}` 在 run 启动冻结；credentialRef 是可解析引用，不是秘密副本。
- planner/reviewer/finalizer 使用 cloud EndpointRef，worker 使用 local EndpointRef；transport 明确接收 EndpointRef，禁止靠 `localModeActive()` 或全局切换区分角色。
- 本地预设激活时云端快照、云端预设激活时本地快照如何由既有 provider_*/local_* 与预设记录派生，是架构必答项；不得隐式改写用户当前单模型端点。

## 7. 隐私与上传范围

### 7.1 默认最小化

- 启用协同即表示用户任务文本可发往云端；启用页必须明确此点，不宣称“完全本地”。
- 默认 **不上传**附件/图片/视频、工作区原文、完整 sessions 历史、工具原始输出、路径列表、Key/token/凭证、未挑选的本地结果。
- 云端只接收：用户任务、完成当前计划/验收必需的有界摘要、经规则筛选的 local result、acceptance criteria 与 provenance。
- 默认 scope=`task_summary_only`；其他范围必须显式选择并在 run 前可见，不能由 planner 自行扩大。

### 7.2 脱敏、预览与强制本地

- 上传前执行有界脱敏：Windows/POSIX 路径、API Key/Bearer/token、URL userinfo/query 凭证、常见 secret 字段与本地连接信息；保留可定位的引用 ID 而非原始秘密。
- 本地结果上传前提供范围预览与规则结果；大结果只上传必要片段/摘要，摘要本身也需脱敏，不能把摘要当天然安全。
- `sensitivity=local_only` 的任务强制仅本地；任何 planner/reviewer 不得请求其原文。无法本地完成时 partial/failed。
- `fallback_policy=disabled` 禁止本地失败升云；`allow_bounded` 也只能使用当前 dataScope 已允许的内容。
- 每段云输入记录 `{source, actor, taskId, resultRef, digest, bytes, redactions[], scope}`；日志只记元数据，不记正文/秘密。

## 8. UI 需求

### 8.1 设置与连接

- 在现有**混合路由设置卡**内增加“协同模式”区：开关、local-first、云/总 token、review/retry/deadline、fallback、上传范围；不新增平行设置页或第二套云/本地连接。
- 云/本地连接复用“连接与模型”和本地探测/测试入口；显示协同将使用的两个 EndpointRef 摘要及不可用原因，不显示 Key。
- 原 hybrid 三策略与分账 chip 保留；协同启用时解释新优先级，关闭时回到原策略。

### 8.2 运行可见性

- 对话运行区展示 planning/planned/dispatching/reviewing/revising/终态、计划 DAG、当前 task、本地/云 actor、review verdict、修正轮次与停止按钮。
- 显示数据范围、实际上传类别、脱敏计数、local/cloud 调用次数、prompt/completion token、费用与剩余预算。
- 失败/超时/取消/partial 显示原因、已完成结果、恢复入口；未验收任务不得显示绿色完成。
- 复用现代精致圆润 tokens、列表/状态块/浮层与专家 timeline 组件；不新增“AI 双脑”营销视觉。
- 375×812 单列显示计划/task/review/预算，停止与数据范围始终可达；44px、焦点、对比度、reduced-motion 与深浅主题按全局矩阵验收。

## 9. 端到端验证

### 9.1 fake transport 流程与路由

1. **完整闭环**：fake 云端 planner 返回 2+ 任务 DAG → 本地 worker 执行 → 云端 reviewer → 一项 revise → 修正执行 → 云端复审 pass → 云端 finalizer；断言调用顺序、taskId/attempt/resultRef/reviewDigest 与最终引用。
2. **本地优先**：可本地任务不升云，云调用只用于规划/校验/明确升级；分别报告 local/cloud 调用，若 fixture 设计本地多数则断言多数，不把该比例外推。
3. **升级原因**：复杂、校验、本地失败、低置信分别只触发预期云调用；fallback disabled/local_only 时云调用为 0。
4. **单模型差分**：collaboration off 时请求体/tools/calls/usage/终态/设置与原基线完全一致，无 planner/reviewer/协同事件。
5. **普通 Agent/Expert 复用**：同一角色路由可在 Agent actor 使用，不生成第二 executor；Team 默认串行与 mailbox 真回流不回退。

### 9.2 异常、预算与副作用

- 云 planner 失败、local worker 失败、云 reviewer 失败、schema 无效、timeout、取消、切会话、恢复分别覆盖；终态准确且无悬挂任务。
- token 在每次调用前阻断：预留 reviewer/finalizer 后，worker 不得耗尽；超额调用次数为 0，实际 usage 结算不重复。
- retry 只发生在允许的幂等模型请求；写工具/命令/MCP/文件/WebDAV spy 断言 **0 次自动重放**。
- 修正后必须重新 review；旧 attempt 不得覆盖新 attempt；未决任务不能 completed。
- 恢复后已完成结果不重复调用，新 runId/parentRunId 正确，旧迟到 usage/result 不污染新 run。

### 9.3 隐私负例

- 附件/图片/视频不上传；工作区原文与全量历史默认不上传；仅当前任务和有界摘要进入 cloud fake 请求。
- Key、Bearer、token、路径、URL userinfo/query 凭证、local endpoint 秘密均不出现在 cloud payload、事件正文或日志。
- local_only/fallback disabled 下任何本地上云为 0；预览/脱敏后范围扩大被阻断。
- 恶意 local result 指示云端泄露/改计划/跳过验收时仍按宿主 schema/权限处理，provenance 可查。

### 9.4 质量 rubric（确定性 fixtures）

- 计划完整：目标、依赖、能力、验收标准、数据范围齐全；无循环/未知引用/伪工具。
- 无伪成功：缺 result、未执行、review fail、未整合修正均不得 completed。
- 修正整合：review 指出的每个阻断问题在后续 result/final 中有对应修改与引用。
- 格式与引用：plan/task/result/review schema 合法；final 引用真实 resultRef/evidenceRefs，不凭空增加事实。
- 成本：对比单云、纯本地（若能力允许）与协同 fixtures 的 local/cloud prompt+completion token、费用、云端调用次数；不把本地 token 当费用，不用固定“节省百分比”替代实测。
- 真实 FreeToken/Ollama/云端点质量、延迟和模型能力列 **UNCOVERED**，除非实际执行并保存输入/输出/rubric；fake 通过不冒充真实质量。

### 9.5 回归与视觉

- 当次全量 0 failed，API/release/UI 契约、build×2、config/hybrid 旧 fixture、sessions 旧格式通过。
- 375/768/800/1280 协同设置与运行区截图；深浅主题、空/加载/错误/禁用、长计划、焦点/44px/reduced-motion 通过。
- 不主动启动 exe；真实端点与 exe 未测明确标未覆盖。

## 10. P0 / P1 / P2

### P0 / Must

- 默认 off 的 collaboration 配置与 EndpointRef；共享 executor 内 cloud-planner/local-worker/cloud-reviewer/finalizer。
- plan/task/result/review schema、DAG、完整规划→执行→验收→必要修正→整合闭环；本地优先与有理由升级。
- 调用前预算与云端验收预留、幂等模型重试、工具副作用零自动重放、取消/超时/恢复。
- 最小上传、预览/脱敏/provenance/local_only/fallback disabled；原混合设置内协同卡与运行可见性。
- fake 全链路、质量 rubric、成本分账、隐私负例、旧单模型差分。

### P1 / Should

- 按 phase/指定 task 恢复、精细 capability profile、更多数据范围模板、按 task 成本/延迟分析。
- 复杂摘要策略与增量 review，减少重复上传；本地多数任务的真实性能/质量对照。
- 普通 Agent/Expert 更多复用场景与可选 reviewer 策略。

### P2 / Could

- 独立任务有界并行（先满足统一 Team/资源/预算门禁）、自适应路由（仅以可复现数据训练/评估）、多 reviewer。
- 真实端点质量基准扩展；不得用自适应名义绕过隐私、预算或人工验收。

## 11. 风险与控制

| 风险 | 控制 |
|---|---|
| 堆出第三套协同运行时 | 只作为 ModelExecutor 模式 + TaskDAG 策略；复用 Team actor/mailbox/event/SessionStore |
| 全局 local/cloud 切换污染普通请求 | EndpointRef 快照注入 transport；禁止改全局 providerState/localState 切角色 |
| 本地优先变成无云端验收 | planner/reviewer/finalizer 云额度预留；完整闭环 fake 阻断验收 |
| 云端调用与费用失控 | cloud/total token 调用前预留、max review/retry/deadline、分 actor usage |
| 重试重复工具副作用 | 仅幂等模型请求 retry；副作用 spy 0 重放；unknown 状态不双端重放 |
| 摘要/本地上传泄密 | 默认最小范围、预览/脱敏、local_only/fallback disabled、payload 负例 |
| reviewer 橡皮图章 | resultRef/evidenceRefs/rubric/未决不 completed；修正后强制复审 |
| 与 Team/Expert 语义混淆 | 云/本角色与 lead/member 正交；Team 仍星型串行，协同只分配模型 |
| 配置或旧会话漂移 | collaboration 可选 off、旧 hybrid/config/sessions fixture 与单模型差分 |
| fake 结果被写成真实质量 | 真实端点另列 UNCOVERED，保存实际样本才允许升级结论 |

## 12. 需架构师裁决

1. **路由归属**：CollaborationController 与 ModelExecutor、RunRegistry、DomainScheduler、HybridRouter 的方法边界；HybridRouter 哪些纯函数直接复用。
2. **计划 schema**：任务/深度/结果大小上限、outputSchema、DAG 校验、修正 attempt 与 final 引用的精确不变量。
3. **本地能力判定**：local_readiness、工具/上下文/历史失败与任务 capability 如何形成确定性路由；低置信来自哪里，如何与 classify 置信区分。
4. **验收阈值**：pass/revise/fail 的 rubric、reviewer confidence 使用边界、哪些问题必须云端修正或人工介入。
5. **上下文摘要**：dataScope、引用、摘要长度、敏感分类与脱敏规则；云端 reviewer 需要哪些最小证据。
6. **预算预留**：planner/reviewer/finalizer 的预留比例/绝对额度、无 usage 端点保守估算、云费用上限与结算规则。
7. **EndpointRef**：本地预设激活时云端配置、云端预设激活时本地配置如何从既有 provider_*/local_* 派生，不复制 Key、不改单端点现状。
8. **Team/Expert 关系**：角色路由与 lead/member、专家包 capabilities、 mailbox/event 的复用方式；是否允许 Expert lead 为 cloud-planner、member 为 local-worker，默认如何关闭。
9. **实施顺序**：共享 executor/W2 正确性门之后，配置与 schema → 单 worker 闭环 → review/revise → 隐私/预算 → UI → Agent/Expert 复用的 Wave 安排。
10. **质量门槛**：确定性 fixtures、真实端点质量集、成本基线和允许回归如何冻结，避免云端多轮反而更差/更贵。

## 13. Out of Scope

- 新建第三套 Agent/Team/模型运行时、Python 第二模型客户端、第二密钥库或平行设置页。
- 默认开启协同、自动上传附件/工作区/全量历史、把本地失败静默升云到所有内容。
- 自动重放工具副作用、无上限 planner/reviewer 循环、未验收即完成。
- 以 classify 置信度代替结果质量，以 fake transport 结果冒充真实模型质量或固定节省承诺。
- 改变原单模型/旧 hybrid strategy、公开 js_api/config/sessions/Guard/审计契约，主动启动 exe。

---

**总验收口径**：一个 executor、一个任务 DAG、两个模型角色；本地执行优先但云端必须真实验收，上传最小且预算先行，任何修正可追踪，任何未决不伪完成。