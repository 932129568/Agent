# Harbor 专家模式增量 PRD：单专家、专家团与生产级协作运行

- 日期：2026-10-26
- 状态：需求锁定，交架构师继续目标架构与整体重构设计；本轮只新增 PRD，不写产品代码
- Project Name：`harbor_v19_expert_mode`
- 技术约束：沿用 Python stdlib + pywebview + HTML/CSS/原生 JavaScript + Node 内置构建器；不引入新框架、模型 SDK 或运行时依赖
- 上游：`harbor-v19-modern-refactor-prd-2026-10-26.md`、`harbor-v19-modern-architecture-design-2026-10-26.md`、用户附件 `expert-porting-report.md` / `expert_portable.py`
- 原始需求：准备移植 Agent 单专家与 Team 专家团，先设计最好的架构，再纳入 Harbor 整体重构。**专家模式是本轮增量，不替代或暂停正在进行的彻底架构重组与全局现代 UI 改造。**

## 1. 产品定义

### 1.1 Product Goals

1. **显式、可信的专家能力**：用户可导入并明确选择单专家或专家团；普通聊天默认路径、模型配置、工具权限与体验不变。
2. **真正可协作而非多角色扮演**：Team 具备独立成员上下文、星型 mailbox、成员回流 lead、轮次/预算/超时/取消与可恢复终态，复用 Harbor 唯一模型与 run 链路。
3. **安全、兼容、可观察**：专家包和技能均按不受信资产处理，严格校验路径/schema/资源；运行事件、成员产出、usage、失败与部分完成均可追溯。

### 1.2 User Stories

- 作为普通聊天用户，我希望未主动选择专家时完全沿用原对话，以免专家提示词、额外 token 或团队工具静默介入。
- 作为专业用户，我希望选择 Agent 后以其角色与按需技能完成一次任务，并看到专家身份、运行状态和费用。
- 作为复杂任务用户，我希望 Team lead 能派生成员、接收成员回流并继续下一阶段，最终汇总真实成员产出，而非一次调用后假装团队协作完成。
- 作为安全敏感用户，我希望导入毒包、越界路径或恶意提示词不能获得额外文件/命令权限，技能脚本不会因导入或运行自动执行。
- 作为长时间任务用户，我希望停止、切换会话、超时、轮次或预算耗尽后得到明确终态，成员已完成结果不丢失且可继续处理。
- 作为维护者与 QA，我希望专家包校验、run/phase/member/mailbox/event 状态与现有流式/取消/会话隔离共用可测试边界。

## 2. 事实基线与参考实现纠偏

### 2.1 Harbor 当前基础

- 既有前端 `fetchGLMStream` + `runAgentLoop` 已负责 OpenAI 兼容流式、工具循环、usage、停止与工具终态；`agentRunCurrent`、`cancelActiveAgentLoop`、`AbortController`、会话 id 检查保证 run 所有权和隔离。
- `SessionStore` 维持 sessions 双源归一、墓碑、截断与串行保存；config、Guard、审计、预算等既有红线继续适用。
- 现代架构目标已指定 `AppState` 为唯一业务状态树、`RunRegistry` 为唯一 active run owner；专家模式必须扩展该体系，不能建立平行 `isStreaming`、第二会话库或第二模型客户端。
- W1 `deliverables/wave-backups/W1-modern/manifest.json` 当前为 **completed**：`frontend/manifest.json` 已声明 scripts/styles 顺序及 provides/requires；W1 证据为 241 passed、UI 契约 PASS、build×2 字节一致。W1 尚无专家模块，后续新增文件必须进入 manifest 与新 Wave 白名单，不能回写或回滚 W1 证据。
- 既有最近全量基线仍是 1509 passed / 0 failed / 1 skipped；本 PRD 未重跑测试、未构建、未启动 exe。

### 2.2 附件能参考什么

可借鉴：三种 plugin.json 位置、Agent/Team 元数据、agents Markdown、settings.json、skills 渐进披露、星型协作理念、包展示与静态检查思路。

不可当作生产事实：报告中的“2–3 人日”“同名注册两个工具即可”“TeamCreate 可空操作”“并行是硬门槛/串行会退化为分段扮演”等结论。独立上下文串行调度仍然是真团队协作；并行只影响耗时与资源竞争，不是 Team 成立条件。

### 2.3 `expert_portable.py` 的代码证据与不足

| 代码事实 | 生产影响 / 本轮纠正 |
|---|---|
| `TeamRuntime.run()` 只对 lead 调用一次 `llm`；`tool_agent()` 对成员调用一次 `llm` | 没有完整模型 tool-call loop；工具结果不会自动回填并再次请求，不能支撑多轮 lead/member 协作 |
| `tool_send_message()` 只把字符串放进 `mailbox[to]`；`run()` 不读取 mailbox、不唤醒 lead | **mailbox 不回流 lead**，无法保证 member→lead→下一 phase；函数返回值直传也不能替代显式回流事件 |
| 未实现 `TeamCreate` 工具或团队实体；lead 仅获得 Agent/SendMessage | 没有 TeamCreate 真状态、成员名册、run 作用域或生命周期；不能空操作冒充建团 |
| 无 maxTurns 执行、深度限制、超时、取消、预算、usage 汇总、并发所有权或恢复 | 可能无限循环、越权嵌套、迟到写入、成本失控；均须由生产状态机强制，不靠提示词 |
| `_parse_frontmatter()` 仅 key/value 与一层 dict，值基本按字符串处理 | 不能视为 YAML 兼容；数组、块字符串、布尔/数字、转义、多层结构会丢失或误读，必须定义受限 schema 与严格类型 |
| `validate_package()` 的引用检查含 `and/or` 优先级组合及 `design-/product-` 前缀过滤 | 存在布尔优先级和命名启发式误判/漏报；SOP 正则也不能作为运行时编排真相 |
| `root / agents_field`、`root / item` 后直接读取，无 canonical containment、symlink/reparse、大小/数量限制 | 可路径穿越或跟随链接读取包外文件；导入与技能引用均需封闭根目录校验 |
| agents 以 `p.stem` 覆盖写入 dict，skills 以 `d.name` 覆盖 | 重复 ID/大小写冲突可静默覆盖，必须 fail-closed |
| `DryRunLLM` 只记录一次 lead 调用和静态 SOP 文本 | dry-run 只证明展示/解析样例，不证明真实 Agent 调用、回流、工具循环、终态或安全性 |

**结论：附件是格式与交互参考，不是可接入 Harbor 的生产运行时。不得直接复制 `TeamRuntime` 作为专家模式实现。**

## 3. 范围、激活与契约红线

### 3.1 激活原则

- 同时支持 **Agent 单专家**与 **Team 专家团**；默认普通聊天，不自动按 description/tags 路由，不根据提示词内容静默激活。
- 只有用户在输入区/专家中心显式选择某个专家或团队后才启用；选择作用于“下一条/当前草稿”还是“整个会话”必须有清晰 UI 与持久化规则，默认建议仅下一次 run，避免意外持续生效。
- 普通聊天不加载专家正文、skills 索引或 Team 工具，不产生额外模型调用；清除选择立即恢复普通链路。
- 禁用、校验失败、不兼容或已删除的包不可启动；运行中包被变更时，当前 run 固定使用启动时的不可变版本快照。

### 3.2 既有红线

- `config.json` 零污染；现有公开 js_api 参数/返回、`get_api_info` 逐字节与 `API_VERSION` 不变。新增专家 js_api 只能登记 `_V12_EXTRA`。
- 既有 sessions 是唯一会话事实源；不新建第二套 conversations/expert-sessions。旧消息无专家字段时必须原样可读、可搜索、可导出、可继续。
- 既有 DOM id/onclick/callApi/CSS 类/变量只增不改；四主面板与普通聊天入口不删除、不改造成营销页。
- 流式、usage、Guard/审计、工作区、停止、会话隔离、晚桥、build×2、无新运行时依赖与不主动启动 exe 全部沿用。
- 专家包提示词不能修改 Harbor host policy、公开 API、Guard、预算或工具 schema；不能以“系统提示词”名义获得高于宿主规则的权限。

## 4. 需求池

### 4.1 A. 包格式、注册与渐进披露

| ID | 优先级 | 需求 | 验收要点 |
|---|---|---|---|
| A1 | P0 | 兼容 `.codebuddy-plugin/plugin.json`、`.workbuddy-plugin/plugin.json`、root `plugin.json`；多处同时存在时按固定优先级并披露，不允许互相矛盾静默通过。 | 三种官方样例均可加载；冲突/多个元数据给出确定结果和错误详情。 |
| A2 | P0 | 支持 `agents` 为目录字符串、文件数组或缺省 `agents/*.md`；支持 Agent/Team 的 `agentName`、`teamInfo`、`members` 与 team `settings.json`。 | lead/member/settings/frontmatter name/文件名一致；缺失、重复、未知类型、引用不存在均 fail-closed。 |
| A3 | P0 | 定义受限 frontmatter/schema，而非声称完整 YAML：支持所需 string/bool/int、一层本地化 dict、必要数组与块文本；未知字段有版本化策略。 | 类型错误、重复 key、非法缩进、未闭合分隔符、超限和危险类型有精确行列/字段错误；不错误静默转成字符串。 |
| A4 | P0 | skills 支持 `SKILL.md` 索引 → 全文 → references/templates 按需读取；启动仅加载有界 name/description 索引。 | 普通聊天零加载；未触发不注入全文；读取仍限包根；references 路径穿越/链接/二进制/超限被拒绝。 |
| A5 | P0 | 导入采用临时 staging → 全量校验 → 原子注册；包内容形成带版本/摘要的只读快照。 | 失败不留下半注册包；同 ID 不同版本不静默覆盖；运行固定 snapshot；删除不影响既有会话阅读。 |
| A6 | P1 | 包列表、搜索、详情、启用/停用、版本与来源展示；提供可诊断校验报告。 | 错误定位到文件/字段；agent/team/skill 状态一致；无包/损坏包/超长元数据可用。 |
| A7 | P2 | 在明确许可与用户需求下支持受控导出/更新和兼容性报告。 | 不默认再分发官方包；更新产生新版本，不改写历史 run 快照。 |

### 4.2 B. 模型链路与生产级运行状态机

| ID | 优先级 | 需求 | 验收要点 |
|---|---|---|---|
| B1 | P0 | Agent 直调复用既有前端流式模型链：system 由宿主策略 + 选定专家资产组成，用户消息/附件/工具/usage/终态沿用现有能力。 | 只有一次逻辑专家 run；流式分片、usage、停止、重生成与普通聊天一致；无 Python OpenAI/urllib 第二客户端。 |
| B2 | P0 | Team 的 lead 与每个 member 都通过同一前端模型 executor 获得独立上下文与完整 tool-call loop；后端不直接调用模型。 | 每个 tool_call 执行结果回填后才继续；成员不是 lead 同一上下文的分段扮演；模型端点/Key 不复制到后端。 |
| B3 | P0 | 建立 run→phase→member→mailbox→event 层级状态机和不变量，所有异步写入携带 runId/sessionId/phaseId/memberRunId/generation。 | 旧 run/旧 phase/旧会话迟到事件不能写新状态；同一 member 运行不可重复占有；UI 只投影权威事件。 |
| B4 | P0 | 星型拓扑：仅 lead 可 TeamCreate/Agent 派生；member 用 SendMessage 回 lead；mailbox 投递产生 lead 可见事件并恢复/继续 lead loop。 | 实测 lead→member→lead 回流后才可进入下一 phase；member 不可直连、不可派生、不可建团；无“mailbox 只存不读”。 |
| B5 | P0 | TeamCreate/Agent/SendMessage 是 **expert run 作用域工具**，按调用者角色和当前 Team 实例注入，不进入普通聊天或全局工具表。 | 普通聊天工具列表无三者；跨 run/跨会话/未知 member/伪造 lead 调用均拒绝并留审计事件。 |
| B6 | P0 | maxTurns 同时约束 run 总轮次与各 member/lead 调用轮次；团队协作深度=1；限制总成员调用数、mailbox 大小和事件速率。 | 到达上限进入 `budget_exceeded`/`turn_limit` 等明确终态，不继续请求；frontmatter 只能收窄宿主上限，不能放宽。 |
| B7 | P0 | 超时、取消、预算与 usage：复用现有 run ownership/AbortController/会话隔离和成本防御；汇总 lead+members 的 token/费用。 | 停止传播到当前 fetch 与待派生队列；不伪称同步 RPC 被强杀；迟到 usage 只归原 run；普通/专家统计口径一致且不重复。 |
| B8 | P0 | 默认串行，Team 同 phase 也先串行；并行仅在正确性、ownership、预算和限流证明后评估。 | 串行 lead/member 独立上下文与回流完整；无全局并发锁误伤其他会话；并行不是 P0 验收前提。 |
| B9 | P0 | 明确定义 `queued/running/waiting_member/waiting_lead/completed/partial/failed/cancelled/timed_out/turn_limit/budget_exceeded` 等状态及合法迁移。 | 非法迁移拒绝；所有出口幂等；未决工具/成员不伪 done；失败保留 partialContent 和已投递 mailbox。 |
| B10 | P0 | 失败/部分完成可恢复：事件与结果写入当前会话的专家元数据，重载后可重建时间线、查看错误并以新 run 链接续办。 | 刷新/重开不丢已持久化结果；续办生成新 runId/parentRunId，不复活旧所有权；不另建第二会话事实源。 |
| B11 | P1 | 用户可选择从失败 phase/指定已完成成员结果继续，lead 获得有界恢复摘要。 | 已完成成员不无故重复计费；恢复输入有 provenance；历史快照不变。 |
| B12 | P2 | 评估同 phase 有界并行、成员超时独立策略与吞吐优化。 | 前后正确性/费用/延迟对照；默认仍串行，可随时关闭并行。 |

### 4.3 C. 安全、权限与 provenance

| ID | 优先级 | 需求 | 验收要点 |
|---|---|---|---|
| C1 | P0 | 包根 canonical 化；所有声明和引用必须 containment 检查。拒绝绝对路径、`..`、UNC/设备路径、符号链接、junction/reparse、硬链接异常与大小写重复。 | Windows/POSIX 风格穿越均失败；导入和每次按需读取都重新校验，不只启动时检查。 |
| C2 | P0 | 限制包总大小、单文件、文件数、agents/skills/references 数、嵌套深度、单条提示词与 mailbox 消息；默认值由架构冻结并可配置更严。 | 超限在读取前/流式读取中均中止；zip/目录炸弹（若支持压缩包）无资源耗尽；错误不泄露秘密。 |
| C3 | P0 | JSON duplicate key、ID/schema/UTF-8/MIME/文本资源严格检查；不依赖文件名前缀猜测 Agent 引用。 | 重复 ID/键、case-fold 冲突、非法 semver/type、lead/member 不一致全部阻断；SOP 正则只作展示提示。 |
| C4 | P0 | prompts、frontmatter、SKILL/references/templates 全部标为 **untrusted asset**；宿主指令与包指令分层，引用资料以带来源的数据边界注入。 | 恶意“忽略宿主/关闭 Guard/泄露 Key/调用工具”不能提升权限；界面与事件可定位来源 package/version/file/hash。 |
| C5 | P0 | skills scripts 只作静态资产展示，导入、校验、索引、运行、读取技能均 **零自动执行**；不 import、不 child_process、不 shell、不动态 eval。 | 含可执行扩展/自动运行指示/恶意脚本的包在上述路径均无进程、网络或写文件副作用；脚本内容默认不注入。 |
| C6 | P0 | 成员默认无额外权限；可用工具取普通聊天当前权限与包所需能力的交集，所有工具仍走既有 Guard/审计/工作区/预算。 | 包声明不能扩权；lead/member 危险操作同样确认；审计增加 expert/run/member/provenance，不改变原返回形状。 |
| C7 | P1 | 安全扫描报告区分错误/警告/信息，支持用户查看被拒绝文件与原因。 | warning 不被误报为安全认证；无“官方即可信”假设；日志不记录 Key/凭证。 |
| C8 | P2 | 许可元数据与再分发提醒。 | 官方包再分发仅标“需核对原市场/作者许可”，不臆断允许或禁止；不作为运行时安全背书。 |

### 4.4 D. 数据与 API

| ID | 优先级 | 需求 | 验收要点 |
|---|---|---|---|
| D1 | P0 | 新增独立 `experts.json`：注册记录、启用状态、用户偏好、默认限额和快照索引；不含密钥，不污染 config。 | 原子写、锁、损坏恢复、版本字段、路径校验与保存失败回滚；不写 API Key/端点秘密。 |
| D2 | P0 | 现有 sessions 消息可附加可选 `expert` 元数据：package/id/version/run/phase/member/parentRun/provenance/事件或投影引用。 | 旧读取器忽略未知可选字段；旧会话无字段正常；搜索/导出/compact/60 条/双源/墓碑不回退。 |
| D3 | P0 | 会话中的专家事件与结果是该会话恢复投影的来源；`experts.json` 不保存第二份对话或运行真相。 | 删除 experts 注册不删历史；同事件只持久化一次；内存 projection 可由会话事件重建。 |
| D4 | P0 | 后端仅负责包导入/读取/校验/注册/限额/安全与适合后端的文件职责；运行时最终归属由架构师决定，但模型调用留在前端唯一 executor。 | 无 Python 模型客户端；新 js_api 全进 `_V12_EXTRA`；get_api_info 差分不变。 |
| D5 | P1 | usage 与统计导出包含专家/团队聚合视图。 | lead+member 汇总只计一次；普通分析无专家数据时外观与结果不变。 |

### 4.5 E. 专家中心与运行 UI

| ID | 优先级 | 需求 | 验收要点 |
|---|---|---|---|
| E1 | P0 | 在输入区提供显式专家选择，在既有导航辅助区新增专家中心入口；四主面板保持不变。 | 默认显示普通聊天；选中身份可见且可一键清除；不自动路由、不增加营销 hero。 |
| E2 | P0 | 专家中心：包列表、搜索、Agent/Team 类型、启用/校验状态、版本/来源、详情、成员、skills 与导入。 | 空/加载/错误/禁用/长文本完整；校验错误可定位；危险删除有确认。 |
| E3 | P0 | 运行区：当前 phase/member 状态、lead/member 时间线、mailbox 事件、usage/预算、停止、失败与部分完成。 | 不只显示 spinner；member→lead 回流可见；事件顺序稳定；敏感提示词默认折叠且有访问控制说明。 |
| E4 | P0 | 终态与恢复：完成、取消、超时、轮次/预算上限、部分失败提供明确原因与可行动按钮。 | 不伪报成功；部分产出可复制/导出/续办；旧 run 按钮不影响新 run。 |
| E5 | P0 | 视觉沿用现代精致圆润工作台 token、圆角、间距、阴影与字阶，复用共享控件/浮层。 | 无第二套紫色“AI 专家”皮肤；普通聊天与四主面板无营销化；深浅主题对比度通过。 |
| E6 | P0 | 375/768 移动与触摸/键盘可用；目标≥44px、焦点圈定/返回、reduced-motion/fx-off。 | 375 下列表/详情/时间线重排且无页面横溢出；停止/关闭始终可达；事件动画降级后状态不丢。 |
| E7 | P1 | 大量包/事件虚拟化或有界分页、事件过滤与成员搜索。 | 1000 事件不造成不可接受长任务；过滤不改变权威事件顺序或持久化。 |

## 5. 目标运行语义（产品契约，具体模块归属由架构师裁决）

### 5.1 Agent

`用户显式选择 Agent → 固定包快照 → 宿主策略 + 专家正文 + 有界 skills 索引 → 既有 send/run executor → 流式/工具/usage → 当前会话专家元数据与终态`。

- 单专家可使用普通工具，但没有 TeamCreate/Agent/SendMessage 团队工具。
- 若专家调用普通工具，仍按当前会话工具权限、Guard 与预算处理。

### 5.2 Team

`用户显式选择 Team → 创建 run → lead TeamCreate（真实 teamId/名册/深度1）→ lead 完整 tool loop → Agent 派生 member 独立 run → member 完整 tool loop → SendMessage 投递 lead mailbox → 持久化 mailbox/event → lead 被投递事件唤醒并继续 → 下一 phase/终态汇总`。

- lead 可决定直调某成员或完整 SOP；SOP 文本是包的协作建议，运行时状态与上限才是硬约束。
- 不允许 member→member、member→任意用户、member 再 Agent/TeamCreate；所有跨成员内容经 lead 中转。
- `SendMessage` 成功表示“已持久化投递到当前 run 的 lead mailbox”，不是“最终任务完成”；只有 lead 汇总且满足终态条件才完成 run。
- 默认串行不共享成员上下文；每个成员只获得 lead 明确下发的有界任务与必要 provenance，不自动读取其他成员全部对话。

### 5.3 状态与恢复最低不变量

1. 一个会话最多一个可写 active expert run；新 run 先撤销旧所有权，旧异步事件只可记录为迟到/忽略，不改变新 UI。
2. phase/member 终态幂等；mailbox 以 eventId 去重，至少一次回调不重复插入 lead 上下文。
3. 每个模型轮次和工具调用都计 turns/usage；取消后不再派生新成员或发起新模型请求。
4. 超时/轮次/预算不是普通 `failed` 的模糊别名；UI、统计和恢复原因可区分。
5. 部分完成必须保留已完成成员与已投递消息；恢复用新 runId 链接旧结果，不篡改历史事件。

## 6. UI 覆盖与视觉验收矩阵

所有区域覆盖浅色/深色、默认/空/加载/错误/禁用、长文本、键盘、reduced-motion；1280×720 全量，375×812、768×1024、800×600、1024×640、1440×900、1920×1080 代表抽样。

| 区域 | 必测状态与内容 |
|---|---|
| 普通聊天 | 未选专家完全原样；选择/清除；下一会话不意外继承；无团队工具 |
| 包列表 | 无包、搜索无结果、Agent/Team、启用/停用、损坏/过期、长名称/标签 |
| 导入与校验 | 三种元数据路径、文件数组、settings/skills、毒包逐类错误、部分 staging 清理 |
| 包详情 | lead/members/skills/references、版本/来源/hash、脚本“不会自动执行”说明 |
| Agent 运行 | 流式、工具、usage、停止、失败、重生成、会话切换 |
| Team 运行 | TeamCreate、phase/member、mailbox 投递/回流、等待、下一 phase、最终汇总 |
| 异常终态 | 取消、超时、turn/budget、member failed、partial、未知工具/非法迁移 |
| 恢复 | 重载时间线、部分产出、parentRun 续办、包已删除但历史可读 |
| 移动与无障碍 | 375/768 列表/详情/时间线、44px、焦点、对比度、减少动态、屏幕阅读名称 |

## 7. 端到端验收

### 7.1 功能与状态机

1. **默认不变**：未选专家时请求体、工具表、模型调用次数、usage 与普通聊天基线一致。
2. **Agent 直调**：选定包正文生效，流式/工具/usage/停止/重生成正确；skills 只在需要时逐级读取。
3. **Team 真回流**：lead TeamCreate→派生至少一个 member→member SendMessage→事件持久化→**lead 再次运行并消费该消息**→最终汇总；断言独立 system/context 与调用顺序。
4. **完整 tool loop**：lead/member 的工具结果均回填并触发后续模型响应；不允许一次调用直接返回伪完成。
5. **星型/作用域**：member 直连、嵌套 Agent、TeamCreate、跨 run/伪造收件人均失败；普通聊天无团队工具。
6. **取消/切会话**：在 lead 流式、member 流式、等待 mailbox、待派生阶段分别取消/切换；旧事件不写新会话，不再发新请求。
7. **超时/maxTurns/深度/预算**：分别命中并给精确终态；成员与总 usage 汇总不重复；深度永远为 1。
8. **失败/部分完成/恢复**：成员失败、lead 失败、部分 mailbox 已投递后刷新；历史结果仍在，新 run 可引用续办且无旧所有权复活。

### 7.2 安全负例

- 路径：`../`、绝对路径、Windows 反斜杠穿越、UNC、symlink/junction/reparse、包外 references、重复/case-fold ID。
- 资源：超大文件/总包、过多文件、深嵌套、非法 UTF-8、JSON 重复键、frontmatter 错类型/未闭合、冲突 plugin/settings/teamInfo。
- 恶意提示词：要求忽略宿主、关闭 Guard、泄露 Key、扩权、执行脚本；只能作为包内指令/数据，不得改变宿主权限或暴露秘密。
- **skills 脚本零自动执行**：导入、校验、列表、详情、Agent run、Team run、SKILL/references 读取均监控无子进程、无动态 import/eval、无脚本网络/写入副作用。
- provenance：所有包正文、技能与 member 结果可追踪到 package/version/file/hash/run/event，UI 转义，不能注入 HTML。

### 7.3 兼容、回归与视觉

- 无 expert 字段的旧 sessions 与含新字段 sessions 双向读取；搜索、导出、compact、双源合并、墓碑、60 条限制通过。
- `config.json` fixture 不变；`experts.json` 原子写/损坏/保存失败/无密钥通过；新 js_api 仅 `_V12_EXTRA`，get_api_info 逐字节不变。
- 全量 `pytest tests/ -q` 无新增失败、不删测、不新增无解释 skip；API/release/UI 契约 PASS。
- manifest 包含所有专家 JS/CSS，构建两次字节一致；无第二模型客户端静态守卫；`harbor.html` 仅构建生成。
- 按 §6 保存截图/布局/44px/焦点/对比度/reduced-motion 证据；真实 exe、实际端点未运行则标未覆盖，不主动启动 exe。

## 8. P0 / P1 / P2 交付切分

- **P0 / Must**：显式 Agent+Team、三种包路径与 schema/path 安全、独立专家 preferences、唯一前端模型 executor、完整 tool loop、真 TeamCreate、星型 mailbox 回流、run/phase/member/event 状态机、深度1/maxTurns/取消/超时/预算/串行、部分完成恢复、专家中心与移动/无障碍、全部负例与回归。
- **P1 / Should**：按 phase 续办、丰富过滤/统计、包版本更新体验、大量事件性能优化、详细安全报告。
- **P2 / Could**：有界并行、受控导出/更新、许可元数据增强；不得提前于 P0/P1 正确性。

## 9. Out of Scope

- 直接采用附件 `TeamRuntime`、在 Python 新建 OpenAI 兼容客户端、把模型 Key 复制到专家后端。
- 默认自动专家路由、普通聊天静默注入专家/skills、全局注册 TeamCreate/Agent/SendMessage。
- member 互联、嵌套团队、无上限轮次、以 SOP 正则作为运行时真相、以一次 lead 调用冒充 Team 完成。
- 自动执行 skills scripts、自动安装依赖、导入即运行任意代码、官方包免安全校验。
- 第二套会话/运行时事实源、config.json 扩展、公开 API 契约变化、数据库迁移。
- P0 并行调度、官方包再分发许可法律结论、生产发布、主动启动 exe。

## 10. 风险与控制

| 风险 | 控制 |
|---|---|
| 复制参考实现导致“伪 Team” | 以 member→mailbox→lead 再次运行作为 P0 阻断验收；无完整 tool loop 不得交付 |
| 前端 run 重构与专家增量相互覆盖 | 复用现代架构 RunRegistry/AppState；新增独立 Wave 与 manifest 白名单，先对齐架构师，不改 W1 已完成证据 |
| 异步 member/迟到 mailbox 污染新会话 | 全事件 run/session/generation 所有权、eventId 幂等、取消后不再派生 |
| 成本与轮次失控 | 宿主硬上限优先、frontmatter 只能收窄、总/成员预算和串行默认 |
| 包提示词或 skills 提权 | 不受信资产分层、provenance、工具交集、Guard/审计、脚本零自动执行 |
| 路径/解析校验误放行 | canonical containment + 每次读取复查 + 严格 schema/duplicate 检测 + Windows 链接负例 |
| 专家事件形成第二会话库 | 事件附加在现有 sessions；experts.json 仅注册/偏好/限额；重载投影测试 |
| 专家 UI 破坏普通聊天和现代视觉 | 默认路径对照、复用 tokens/components、四主面板回归、375/1280 截图矩阵 |
| 串行耗时诱发过早并行 | 先保证可取消/可观察/可恢复；并行只列 P2，以测量与正确性证据评估 |

## 11. 需架构师裁决的问题

1. **运行时归属**：在既定前端 RunRegistry/AppState 中，ExpertRunController、TeamOrchestrator、MemberContext、Mailbox、EventJournal 如何划分？后端包服务通过哪些 `_V12_EXTRA` 最小接口提供快照与按需资源？
2. **完整 tool loop 复用**：现有 `runAgentLoop` 如何泛化为 lead/member 可重入 executor，同时保持普通会话单 active run、工具写串行与现有终态？成员等待时 active run 的所有权如何表达？
3. **mailbox 唤醒**：SendMessage 持久化后如何向 lead 注入 tool result/user-like 系统事件并继续同一 lead context，避免重复 system/messages 或丢失已流式内容？
4. **事件持久化**：哪些事件直接作为 sessions 消息的可选 expert 元数据，哪些是投影？如何限长、compact、去重并保证旧读取器兼容？
5. **恢复粒度**：P0 “可恢复”采用重载时间线 + 新 run 续办是否足够；phase/member checkpoint 的最小数据是什么？
6. **包存储与快照**：managed package root、digest、版本与删除策略如何设计；导入目录/压缩包支持范围是什么；如何防止 TOCTOU 和链接替换？
7. **受限 frontmatter**：无 YAML 依赖时支持哪些确切语法；是否采用 JSON-compatible frontmatter 子集 + 明确块字符串，而非自行实现不完整 YAML？
8. **资源限额**：包总大小、单文件、文件数、agents/skills/events/mailbox/turns/timeouts 的默认值及 `experts.json` 可配置范围是什么？
9. **工具 schema 与 Guard**：Agent/SendMessage/TeamCreate 如何按 run 注入而不污染 `tools_schema` 的全局公开面；审计如何增加 expert 维度而不改旧返回？
10. **usage/预算**：lead/member usage 如何进入会话累计、成本防御和分析，重试/迟到帧/部分失败如何避免重复？
11. **UI 入口与状态**：专家中心采用独立浮层还是辅助页；当前选择是一次 run 还是会话偏好；运行区如何复用聊天而非形成第二套消息视图？
12. **整体实施顺序**：专家运行依赖 W2/W3 Run/Session 重组的哪些出口；如何安排独立 Wave，确保架构重组+全局 UI 与专家模式都实际实施，而非只交文档？

## 12. 与整体重构的执行关系

1. 先由架构师把本 PRD 纳入现代目标架构，明确 RunRegistry/SessionStore/组件/manifest 与后端包服务边界。
2. 继续执行既定 W2 后端、W3 前端 Run/Session、W4 全局 UI；专家模式以新增 Wave 接入这些公共底座，不另起平行架构。
3. 实施顺序建议：包服务与安全 → Agent 直调 → Team 状态机/回流 → 恢复与 usage → 专家中心 → 全量安全/视觉/回归。
4. 每波遵守 WaveGuard 文件白名单和 hash 拒绝；保留当前所有未提交成果。任何专家功能未完成不得阻断或撤销已完成的架构/UI 批次。
5. 最终交付必须同时包含：整体架构重组、全局现代 UI、专家模式实际代码与测试、三 exe 构建及真实覆盖缺口；**不以本 PRD 或后续架构文档代替实施。**

---

**验收总口径**：Agent 是真直调，Team 必须有 member→lead 真回流；专家资产默认可读不可执行；默认普通聊天零变化；所有运行复用唯一模型、会话与权限体系。