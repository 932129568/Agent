# Harbor 生成式 UI 外部证据矩阵与选型研究

- 日期：2026-10-27
- 范围：官方规范/文档、GitHub 源码、工程案例与社区讨论；不修改产品代码
- 有效条目：**80 条独立 URL**。同一项目的不同文档仅在独立价值明确时分列；镜像只用于辅助读取，不作为重复来源凑数
- 证据边界：star/issue 只是活跃度或问题线索，不是质量证明；宣传性数字不作为 Harbor 承诺；真实模型质量仍为 **UNCOVERED**

## 1. 结论摘要

1. 最符合 Harbor 的不是引入某个框架，而是吸收其共同约束：**组件目录 + 声明式 spec + 真实数据绑定 + 权限/动作注册 + 客户端状态 + 可降级流式**。
2. A2UI、json-render、assistant-ui、LangChain 进一步证明“只渲染完整元素/属性”比在半 JSON 上反复修补更可靠；Harbor P0 的完整 block 后投影方向成立。
3. MCP Apps/OpenUI/tldraw make-real 说明 iframe/自由 HTML 的表达力更高，但与 Harbor 的无 HTML/JS/CSS、统一 tokens、基本无障碍和小白名单目标不同，P0 反选。
4. JSONForms/Formily/RJSF 证明 schema 不能只描述数据结构，还需可见性、校验、错误状态和字段级状态；UiSpec 必须显式管理客户端状态，而非只画静态卡片。
5. Google A2UI/Genkit 文档提醒：catalog 结构校验不等于 prop 安全。DataRefResolver 必须再做数据类型、权限、来源、URL/文本 sanitization，不可声称“通过 schema 即安全”。
6. 当前 WorkBuddy Skill 市场检索 `generative UI AG-UI`、`declarative UI JSON schema`、`AI frontend component renderer` 均无匹配。**不安装、不虚构现成 Skill**；仓库内存在 Agent Skills 也不等于本环境可用或应引入。

## 2. 阅读口径

- 类型：官方规范 / 源码 / 工程案例 / 社区讨论。
- 日期：只写来源可核日期或版本；未显示则写“未标注”，不猜。
- 社区反馈：记录可读讨论、issue 或指标；找不到写“未覆盖”。引用第三方汇总时不把其观点当官方立场。
- 可复用性：**协议**=可直接采用设计原则，非声称兼容；**代码**=许可可评估但本轮不引入；**借鉴**=只参考架构/交互。

# A. AG-UI、A2UI、Open-JSON-UI、MCP 与 OpenAI（18 条）

| ID | 标题/项目（类型） | 来源 URL / 日期 | 核心思路与独立价值 | 动态组件 / 数据绑定 | 状态管理 | 安全约束 / 异常回退 | 渲染能力 | 社区反馈 | 依赖与许可 | 可复用性 |
|---|---|---|---|---|---|---|---|---|---|---|
| E01 | 2026 生成式 UI（公众号讨论） | https://mp.weixin.qq.com/s/j5SfMYuz3IyrHlql3vtlzQ?scene=1&click_id=1677060379 / 2026-10-26 | 布局枚举、白名单、真实绑定、客户端状态、旧入口；提供完整原则框架 | 固定布局与组件，tool/AppState 数据 | 选择/表单/滚动归客户端 | 未知组件/绑定失败/超时降级 | 声明式 JSON→组件 | 文章含40%等案例，非 Harbor 证据 | 公众号文章；不引入代码 | 原则直接采用；数字不采用 |
| E02 | AG-UI Generative UI Specs（官方概念） | https://docs.ag-ui.com/concepts/generative-ui-specs / 未标注 | 区分 AG-UI 交互协议与 A2UI/Open-JSON-UI/MCP-UI 规范，防止概念混用 | 多规范组件 | 双向事件/state | 应用验证并挂载 | 平台无关/自定义规范 | 未覆盖 | 官方文档；许可未核验 | 仅借鉴分层，不接协议 |
| E03 | AG-UI Generative UI Draft（官方草案） | https://www.ag-ui.com/drafts/generative-ui / Draft | 以 generateUserInterface 两阶段生成 UI 与结构化用户输入 | 描述、data、output schema | 客户端工具返回 | provider schema 限制与上下文成本明示 | 生成 JSON Schema/React 等 | 草案性质，非稳定承诺 | 官方草案；许可未核验 | 仅借鉴两阶段与局限 |
| E04 | CopilotKit/CopilotKit（源码） | https://github.com/CopilotKit/CopilotKit / 持续更新 | AG-UI、工具渲染、状态同步、HITL 全栈实现 | 工具/状态驱动组件 | useAgent 与共享状态 | 前端动作/人审 | React 等多端 | MIT 已核；issue 另列 | MIT；不引入 | 借鉴状态与动作，代码不引 |
| E05 | CopilotKit generative-ui 教学仓（源码/案例） | https://github.com/CopilotKit/generative-ui / 未标注 | 展示 A2UI 三 envelopes 与 renderer 接线的最小流程 | surface/components/data model | 流式 activity | 不完整生成需校验 | A2UI 原生组件 | 教学示例，非生产保证 | 仓库许可以根目录复核 | 借鉴 envelopes，不照搬框架 |
| E06 | A2UI 官方站与规范（官方规范） | https://a2ui.org/ / v0.9.1；v1.0 candidate | 声明式、无任意代码、跨端原生组件与增量消息 | catalog、JSON Pointer/data model | create/update/delete surface | 不支持 catalog 即拒绝/协商 | Angular/Flutter/Lit 等 | Apache-2.0 明示 | Apache-2.0；不引入 | 协议原则直接采用，暂不兼容 |
| E07 | A2UI with Any Agent Framework（官方指南） | https://a2ui.org/guides/a2ui-with-any-agent-framework / 未标注 | catalog definitions+renderers 注入，展示固定/动态接入方式 | Zod props 与自定义组件 | 客户端函数执行边界 | 无 catalog 不启用/警告 | React/CopilotKit | 版本要求以文档为准 | 文档与依赖；不引入 | 借鉴注册表接口 |
| E08 | Fixed Schema A2UI（工程案例） | https://docs.showcase.copilotkit.ai/ag2/generative-ui/a2ui/fixed-schema / 未标注 | 固定组件树，工具只更新数据；指出 bound prop 必须 literal-or-binding union | JSON Pointer 与数据模型 | schema 固定，数据流式更新 | 未声明 union 会渲染失败 | React 原生 | 提供具体误判案例 | 示例依赖；不引入 | 直接指导 DataRef 类型与默认模板 |
| E09 | A2UI Runtime and Renderer Wiring（源码指南） | https://github.com/ag-ui-protocol/ag-ui/blob/main/skills/ag-ui-a2ui-integration/references/a2ui-runtime-and-renderer.md / 未标注 | 区分 fixed/dynamic schema，校验/重试和 action 回传 | a2ui_operations/data | building/retry/fallback | 重复 middleware 禁止，失败降级 | AG-UI activity | 仓库内技能但本环境无匹配 | 仓库许可；不安装 | 借鉴固定模式与恢复，不安装 Skill |
| E10 | Open-JSON-UI（官方/展示文档） | https://docs.showcase.copilotkit.ai/langgraph-python/generative-ui/open-json-ui / 未标注 | OpenAI 内部声明式 schema 的开放标准化，完整 JSON 组件树 | card/component properties | 单 payload 替换 | 非原生流式，需自行降级 | JSON→组件 | 实现覆盖需另核，不能当现成 renderer | 文档许可未核验 | 仅借鉴，不接协议 |
| E11 | MCP Apps 官方扩展（官方规范） | https://modelcontextprotocol.io/docs/extensions/apps / 2026-01-26 系列 | ui://资源+postMessage JSON-RPC，iframe 内持久交互 | tool 输入/结果到 iframe | iframe 持久 state | 强制 sandbox、host 限制能力 | HTML/媒体/表单/dashboard | host 支持不一 | ext-apps 多许可；不引入 | P0 反选；仅借鉴能力协商 |
| E12 | MCP Apps API/示例（官方工程） | https://apps.extensions.modelcontextprotocol.io/api/ / stable 2026-01-26 | 多类型示例和 vanilla JS 证明不必 React；AppBridge 管理 postMessage | tools/notifications | app bridge/host context | CSP 默认拒绝、消息验证 | React/Vue/Svelte/vanilla | 示例并非支持所有 host | Apache/MIT/CC 过渡许可 | 借鉴 vanilla 可行性，代码不引 |
| E13 | MCP Apps 持久视图讨论（社区分析） | https://mcp.directory/blog/mcp-apps-spec-2026-when-should-your-server-render-ui / 2026 | 区分适合视觉/审批/工作流与纯文本，指出重绘、CSP、a11y 成本 | tool→UI resource | 持久视图仍有重绘问题 | iframe/权限元数据复杂 | HTML iframe | 提到每回合重绘的用户案例 | 社区分析；不作官方结论 | 借鉴反例，强化状态回挂 |
| E14 | Advanced ChatKit（OpenAI 官方） | https://platform.openai.com/docs/guides/custom-chatkit / 未标注 | widget streaming、server context 权限、client/server actions | Card/Text/List/Form | thread metadata/server state | context 传身份与权限 | inline widgets | 官方示例，非 Harbor 可直接接入 | OpenAI SDK；不引入 | 借鉴权限与流式 action |
| E15 | ChatKit.js（OpenAI 官方文档） | https://openai.github.io/chatkit-js / 未标注 | 框架无关聊天壳、widgets、取消、thread 与 client tools | widget nodes/actions | 完整 thread 状态 | 自托管/托管边界清晰 | Web Component/React | 生产聊天壳，不只是 spec | Apache-2.0；不引入 | 仅借鉴组件状态与取消 |
| E16 | Apps SDK UI（OpenAI 源码） | https://github.com/openai/apps-sdk-ui / 2025 起 | 有界设计 tokens 与可访问组件库，强调 Radix/暗色/响应式 | 设计系统组件 | provider 配置 | 可访问基础 | React+Tailwind | MIT 明示 | MIT；不引入 | 仅借鉴 tokens，框架不引 |
| E17 | OpenAI Generative UI Sample（官方源码） | https://github.com/openai/openai-structured-outputs-samples/tree/main/generative-ui / 2024-12 起 | Structured Outputs→递归组件；generate_ui 参数可观察 | components-definition 映射 | 多轮/流式参数累积 | 示例非生产安全证明 | React 递归渲染 | MIT 已核 | MIT；不引入 | 直接支持受控输出与 fake fixtures |
| E18 | OpenAI Conversational Assistant（官方案例） | https://github.com/openai/openai-structured-outputs-samples/tree/main/conversational-assistant / 2024-12 起 | 工具数据→carousel/chart/table→用户 action→新工具，闭环更完整 | tool data+user actions | 多轮 workflow | 工具错误与状态样例 | React 富组件 | 示例数据，非真实质量 | MIT；不引入 | 借鉴动作闭环和 fixture 设计 |

# B. Vercel、LangChain/LangGraph、assistant-ui（14 条）

| ID | 标题/项目（类型） | 来源 URL / 日期 | 核心思路与独立价值 | 动态组件 / 数据绑定 | 状态管理 | 安全约束 / 异常回退 | 渲染能力 | 社区反馈 | 依赖与许可 | 可复用性 |
|---|---|---|---|---|---|---|---|---|---|---|
| E19 | AI SDK Object Generation（官方指南） | https://ai-sdk.dev/v7/docs/ai-sdk-ui/object-generation / v7 | schema 驱动结构化对象流式生成，loading/error/stop 明确 | JSON object/enum | partial object + isLoading | 最终 schema 不匹配报错 | React/Svelte/Vue 等 | 官方示例，非生产承诺 | AI SDK Apache-2.0；不引入 | 借鉴骨架与 stop/error |
| E20 | useObject API（官方参考） | https://ai-sdk.dev/v7/docs/reference/ai-sdk-ui/use-object / v7 | 同 id 可共享状态，onFinish 给完整对象或 TypeValidationError | Zod/JSON Schema | id 共享/initial/clear | stop 与最终校验 | partial→complete | 版本差异须锁版本 | Apache-2.0；不引入 | 借鉴 specId 共享与终态校验 |
| E21 | vercel/ai（源码） | https://github.com/vercel/ai / 持续更新 | 统一模型、structured output、工具调用与 UI hooks，覆盖多提供商 | tools/structured output | 流式 chat/run | provider 差异和版本迁移成本 | TS 多框架 | Apache-2.0 已核；版本快变 | Apache-2.0；不引入 | 不引 SDK，借鉴抽象边界 |
| E22 | json-render 官方站（官方文档） | https://json-render.dev/ / 未标注 | catalog→约束生成→渐进渲染，组件/动作/数据绑定集中定义 | statePath、动作参数 | 双向绑定/validation | 输入校验与未知组件限制 | Web/mobile/代码导出 | 官网含完整组件说明 | Apache-2.0；不引入 | 协议思想直接采用 |
| E23 | vercel-labs/json-render（源码） | https://github.com/vercel-labs/json-render / 2026 创建 | JSON spec、条件可见、动态表达式、watch/action、多渲染器 | $state/$cond/$template | watchers 不初始触发 | spec/表单校验 | React/Vue/RN/Remotion | Apache-2.0 已核；高关注非质量证明 | Apache-2.0；不引入 | 借鉴表达式与 watch，避免自由求值 |
| E24 | AI Elements Introduction（官方文档） | https://elements.ai-sdk.dev/docs / React19/Tailwind4 | copy-in 组件源码，面向聊天/tool/reasoning，不是通用生成协议 | message parts/tools | 组件本地状态 | 只装所需组件，降低冲突 | React/shadcn | 源码拥有权便于审查 | Apache-2.0；不引入 | 借鉴源码审查与按需组件 |
| E25 | AI Elements Usage（官方文档） | https://elements.ai-sdk.dev/docs/usage / 未标注 | 组件进入代码库后可定制，重装询问覆盖，强调原生 props 扩展 | HTML attributes/message parts | 用户自定义状态 | 覆盖风险需审查 | React 组件 | 可修改源码是双刃剑 | Apache-2.0；不引入 | 借鉴白名单 renderer 所有权 |
| E26 | AI Elements LICENSE（源码证据） | https://github.com/vercel/ai-elements/blob/main/LICENSE / 2023 | 明确 copy-to-codebase 的 Apache 许可和署名边界 | 不适用 | 不适用 | 修改/再分发需保留许可 | 不适用 | 许可明确，不代表无维护风险 | Apache-2.0；不引入 | 代码可评估，当前仅记录不复制 |
| E27 | Vercel Chatbot（源码案例） | https://github.com/vercel/chatbot / 持续更新 | 全功能聊天模板：message parts、artifact、approval、持久化 | tool parts/artifacts | 会话与审批状态 | 工具审批/错误展示 | Next.js/React | Apache-2.0；模板非拿来即用 | Apache-2.0；不引入 | 借鉴 artifact 与审批，框架反选 |
| E28 | LangChain Declarative Generative UI（官方） | https://docs.langchain.com/oss/javascript/langchain/frontend/generative-ui / 未标注 | json-render catalog + 完整 elements 过滤 + loading，小目录质量更好 | root/elements/props | JSONUIProvider state/actions | 未到 children 静默跳过 | React/Vue/Svelte/Angular | 官方明确最佳实践 | 文档/库；不引入 | 直接支持完整 block 策略 |
| E29 | LangChain Controlled Generative UI（官方） | https://docs.langchain.com/oss/python/langchain/frontend/controlled-generative-ui / 未标注 | 品牌关键界面由作者组件，agent 只选与传数据，工具生命周期清晰 | components as tools/state | durable typed state | 可预测性最高但组件成本线性 | 高可控组件 | 适合高流量严格场景 | 文档；不引入 | 直接支持默认手写模板 |
| E30 | langchain-ai/langgraph（源码） | https://github.com/langchain-ai/langgraph / 持续更新 | graph 节点发 UI message，id 更新/删除与 state reducer 管理 | UIMessage name/props | graph state/merge | 需服务端约束组件名 | 前端注册组件 | MIT 已核 | MIT；不引入 | 借鉴 specId 更新/删除与 merge |
| E31 | LangGraph UI（官方文档） | https://langgraph.com.cn/agents/ui/index.html / 未标注 | Agent Chat UI 与生成 UI 的接入边界，HITL/工具结果可定制 | push UI props | stream/thread | 服务端/前端职责分离 | React chat | 文档不一定与最新版同步 | 文档许可未核验 | 仅借鉴运行事件，不引 LangGraph |
| E32 | LangChain Frontend Integrations（官方比较） | https://docs.langchain.com/oss/python/langchain/frontend/integrations / 未标注 | 横向比较 CopilotKit/AI Elements/assistant-ui/OpenUI 的定制与 streaming 差异 | 各库组件/state | useStream reactive state | 按 UI 类型选库而非一刀切 | 多前端库 | 官方比较，非性能排名 | 文档；不引入 | 直接支持反选框架堆叠 |
| E33 | assistant-ui Generative Components（官方 API） | https://www.assistant-ui.com/docs/api-reference/generative-ui/components / 未标注 | allowlist 是安全边界；默认可完整 props 才渲染，streamProperties 可选 | zod schema + render | partial/done 状态 | 未识别 type 拒绝，URL/HTML 仍需组件内校验 | React/跨表面转换 | 明确 schema≠intent 安全 | MIT；不引入 | 直接支持完整 props 与二次校验 |
| E34 | assistant-ui Spec Mode（官方文档） | https://www.assistant-ui.com/generative-frame/docs/spec-mode / 未标注 | flat spec + JSONL patches，坏行跳过并报告，actions/events 受 catalog 限制 | JSON Schema/state/events | 逐行 patch state | malformed line 不阻断其余 | React 等 | 格式与 json-render 不同不可混用 | 文档；不引入 | 借鉴完整行 patch 与错误指标 |
| E35 | assistant-ui Generative UI Vocabulary（源码技能） | https://github.com/assistant-ui/skills/blob/139674dc888ee076982b6726e8e6f5d0fe0b5f67/assistant-ui/skills/generative-ui/references/vocabulary.md / commit 139674d | 默认组件/流式 props/跨端渲染；schema 管形状不管意图 | zod/render/no eval | $status 与 action | 未识别丢弃，URL/raw HTML 特检 | React/Slack/Teams/A2UI | 仓库技能不等于当前市场可用 | MIT；不安装 | 借鉴安全说明，不安装技能 |
| E36 | assistant-ui/skills（源码） | https://github.com/assistant-ui/skills / 2026 创建 | 组件目录、动作注册、渲染器及 A2UI 适配资料集 | catalog/actions | present/promptUser | 两种 spec shape 不互换 | 多表面 | GitHub 有技能，当前 WorkBuddy 检索无匹配 | MIT；不安装 | 仅参考，不宣称现成 Skill |

# C. JSON Schema 表单与低代码（14 条）

| ID | 标题/项目（类型） | 来源 URL / 日期 | 核心思路与独立价值 | 动态组件 / 数据绑定 | 状态管理 | 安全约束 / 异常回退 | 渲染能力 | 社区反馈 | 依赖与许可 | 可复用性 |
|---|---|---|---|---|---|---|---|---|---|---|
| E37 | JSONForms Documentation（官方） | https://www.jsonforms.io/docs / 未标注 | data schema 与 UI schema 分离，声明式布局、控制与校验 | scope→data property | 表单数据/校验 | 自定义 renderer 处理特殊类型 | React/Angular/Vue | 官方成熟表单框架 | MIT；不引入 | 借鉴数据/视图 schema 分工 |
| E38 | JSONForms React API（官方） | https://jsonforms.io/api/react / 未标注 | readonly、validationMode、cells/registry、onChange errors 完整接口 | schema/uischema/data | change+validation result | readonly 可复用于 P0 | React 多 renderer | 官方社区论坛可用 | MIT；不引入 | 直接支持只读与错误模型 |
| E39 | react-jsonschema-form（官方文档） | https://rjsf-team.github.io/react-jsonschema-form/docs/ / 未标注 | 未见数据也可由 JSON Schema 生成表单，uiSchema 控制样式 | schema/formData | 受控表单/提交错误 | validator 独立 | React 多主题 | 成熟但定制有学习成本 | Apache-2.0；不引入 | 借鉴 schema 与校验，不引入 |
| E40 | Formily（源码） | https://github.com/alibaba/formily / 持续更新 | 字段级分布状态解决大树重绘，JSON Schema/JSchema 互转 | x-component/data path | 字段状态/联动副作用 | 校验/可见性/性能复杂 | React/RN/Vue | MIT；star 不是质量证明 | MIT；不引入 | 借鉴字段级状态与实体回挂 |
| E41 | Formily Validation（官方文档） | https://github.com/alibaba/formily/blob/9001580e4261353701a536eebcbfb9048bfbc4ca/docs/guide/advanced/validate.zh-CN.md / commit 9001580 | JSON Schema/x-validator/effects 联动校验，覆盖复杂动态表单 | validator/path/reactions | 校验状态与联动 | 错误可见与自定义规则 | React/Vue 等 | 官方示例 | MIT；不引入 | 借鉴校验和 reactions 但禁自由脚本 |
| E42 | Baidu amis（源码） | https://github.com/baidu/amis / 持续更新 | JSON 配置生成完整后台页面，组件/数据/API 映射丰富 | JSON page/schema/API | 页面与表单状态 | 配置过大会难维护 | React 管理后台 | Apache-2.0；大量 star 仅活跃度 | Apache-2.0；不引入 | 仅借鉴后台组件，反选大低代码 |
| E43 | Alibaba FormRender（源码） | https://github.com/alibaba/form-render / 未标注 | JSON Schema 生成配置表单，跨 AntD/Fusion，支持嵌套和校验 | propsSchema/uiSchema | 表单值/校验 | 自定义 widget 边界 | React 表单 | MIT；内部案例非普遍质量 | MIT；不引入 | 借鉴轻量表单 schema |
| E44 | LowCode Engine 官方（官方平台） | http://lowcode-engine.cn/#/ / 未标注 | 物料/搭建/资产协议与最小内核，编辑器、渲染、出码分层 | schema+components | 设计器 project state | 物料未声明无法渲染 | React 模拟渲染 | MIT；生态案例非 Harbor 目标 | MIT；不引入 | 仅借鉴物料声明，反选编辑器 |
| E45 | LowCode Runtime Renderer（官方文档） | https://lowcode-engine.cn/site/docs/guide/expand/runtime/renderer / 未标注 | schema 与 components 必须一一对应，直接证明 registry 缺失会失败 | componentName map | localStorage 示例持久化 | 未注册组件不渲染 | ReactRenderer | 官方最小例 | MIT；不引入 | 直接支持 unknown_component 降级 |
| E46 | TMagic Editor LICENSE（源码证据） | https://github.com/Tencent/tmagic-editor/blob/master/LICENSE / 2025 | Apache-2.0 与第三方组件例外提醒，复用需按文件检查 | 不适用 | 不适用 | 第三方许可不能一概而论 | Vue 低代码编辑器 | 许可证据明确 | Apache-2.0；不引入 | 仅记录复用边界 |
| E47 | Mitosis Overview（官方文档） | https://mitosis.builder.io/docs / 未标注 | 静态 JSX 子集→JSON AST→多框架，编译时跨端而非运行时自由生成 | JSON AST/state/bindings | useStore | 静态子集限制动态能力 | React/Vue/Angular 等 | 跨端编译非 UiSpec | MIT；不引入 | 反选编译器，借鉴受限 AST |
| E48 | Mitosis Components（官方文档） | https://mitosis.builder.io/docs/components / 未标注 | For/Show 等受控控制流和状态方法，说明表达能力由受控语法提供 | state/props/events | useStore/useState | 不支持任意 JS 控制流 | 多框架编译 | 文档与实现差异需测试 | MIT；不引入 | 借鉴有限控制语法，代码不引 |
| E49 | Builder Content Technical（官方） | https://www.builder.io/c/docs/how-builder-works-technical / 未标注 | blocks JSON+component map，编辑消息/patch 驱动实时预览 | component name/options | 内容 state/roles | components-only 限制与权限 | 多框架动态渲染 | 官方平台，非本地小运行时 | 商业平台/MIT 部分；不引入 | 借鉴 component map 与 patch |
| E50 | tldraw AI Integrations（官方文档） | https://tldraw.dev/docs/ai / 未标注 | canvas 输出、视觉工作流、agent 操作三层； typed actions 流式更新 | shapes/assets/bindings | canvas store/chat history | embed sandbox 与自定义 shape | 画布/图形/工作流 | SDK 许可以根目录另核 | 许可另核；不引入 | 仅借鉴实体与动作，反选画布 |
| E51 | tldraw make-real（源码案例） | https://github.com/tldraw/make-real / 2026-02 归档 | 草图→HTML→iframe custom shape，说明自由代码路线表现与风险 | image→HTML iframe | 多轮标注迭代 | 原始 HTML 需隔离与人工修正 | 交互原型 | 已归档只读；不能当活跃框架 | 许可以仓库为准；不引入 | P0 反选自由 HTML，保留案例警示 |
| E52 | OpenUI Thesys（官方站） | http://www.openui.com/ / 未标注 | OpenUI Lang 紧凑流式 DSL，组件库生成 prompt 与多渲染器 | line-based component/state | 流式 forward refs | 应用组件与 tokens 控制 | React/Vue/Svelte/RN/email | 自报 token 数字非 Harbor 承诺 | MIT；不引入 | 仅借鉴 DSL/骨架，不接 DSL |
| E53 | OpenUI Comparison（官方比较） | https://www.openui.com/docs/openui-lang/comparison / 未标注 | 对比 OpenUI/json-render/A2UI/OpenGenerativeUI 的格式、状态、数据与安全 | DSL/JSONL/HTML | state/data fetching | 开放 HTML 风险更高 | 多端与邮件等 | 官方自比，指标未独立验证 | MIT；不引入 | 用于反选/路线比较，不采指标 |
| E54 | OpenUI What's New 1.0（官方） | https://www.openui.com/docs/openui-lang/whats-new / 1.0 | defineFunction/defineAction/library.extend/message format；失败函数返回 null | 自定义函数/typed params | stored context | 无效 action no-op；版本兼容 | 1.0 暂 React，其他 0.4 | 1.0 功能尚未全平台 | MIT；不引入 | 借鉴动作/版本，暂不采用 |
| E55 | wandb/openui（旧源码） | https://github.com/wandb/openui / 2024 活跃期 | 自然语言→HTML 并转多框架，与 Thesys OpenUI 是不同项目 | prompt→HTML/React/Svelte | 迭代编辑 | 输出质量依模型，需审查 | HTML 原型 | 老项目，勿与新 OpenUI 混淆 | Apache-2.0；不引入 | 反选自由代码与实体消歧 |
| E56 | Flutter GenUI SDK（源码） | https://github.com/flutter/genui / 高实验性 | widget catalog→JSON UI，客户端 data model 回传 agent，A2UI 支持 | JSON/widget/data model | UI→agent 状态反馈 | 实验 API 可能大变 | Flutter 多端 | 实验状态明示 | BSD-3-Clause；不引入 | 借鉴双向状态，不引入 Flutter |
| E57 | Flutter GenUI LICENSE（源码证据） | https://github.com/flutter/genui/blob/main/LICENSE / 2025 | BSD-3-Clause 许可与禁止署名推广边界 | 不适用 | 不适用 | 修改分发保留声明 | 不适用 | 许可明确 | BSD-3-Clause；不引入 | 代码可评估，当前不复制 |
| E58 | JSON Schema 官方生态（官方规范） | https://json-schema.org/ / 未标注 | 数据一致性、校验、文档和互操作生态，是 UiSpec 的基础而非 UI 规范本身 | JSON data constraints | 不适用 | schema 不能保证权限/意图 | 多语言校验器 | 生态活跃非 UI 质量证明 | 规范许可按站点；不引入 | 仅借鉴 schema，不等同 UiSpec |

# D. Issue、社区工程讨论与反馈（22 条）

| ID | 标题/项目（类型） | 来源 URL / 日期 | 核心思路与独立价值 | 动态组件 / 数据绑定 | 状态管理 | 安全约束 / 异常回退 | 渲染能力 | 社区反馈 | 依赖与许可 | 可复用性 |
|---|---|---|---|---|---|---|---|---|---|---|
| E59 | CopilotKit stale action render issue（社区 issue） | https://github.com/CopilotKit/CopilotKit/issues/2501 / 2025 | 动态 action renderer 曾使用陈旧状态，修复为稳定 wrapper+最新 props | action props/cache | 缓存与最新 render | 陈旧 UI 需状态所有权修正 | React action UI | issue 证明状态冲突真实存在 | 项目 MIT；不引入 | 直接支持 revision/回挂测试 |
| E60 | CopilotKit issues 列表（社区指标） | https://github.com/CopilotKit/CopilotKit/issues / 2026-10 检索 | 另见 array index key 导致状态丢失、schema/binding 类型等问题，说明生产复杂性 | schema/props/key | 组件重挂载风险 | 不能只看功能截图 | React/A2UI | issue 是线索，不代表全部未修 | 项目 MIT；不引入 | 强制 entityId 非下标回挂 |
| E61 | Google Genkit A2UI Security（官方技能文档） | https://github.com/google/skills/blob/main/skills/cloud/developing-genkit-js/references/a2ui.md / 未标注 | 明确 strict 只查 envelope/type，不查 props/data；秘密可能经 action context 回传 | prop/data model | action context | renderer 必须 sanitize/CSP，秘密禁入 model | A2UI data parts | 直接否定“schema即安全” | 文档；不引入 | 强制 DataRefResolver 权限与脱敏 |
| E62 | StackOverflow：React dynamic form library accepting JSON schema（社区讨论） | https://stackoverflow.com/questions/72745012/react-dynamic-form-library-accepting-json-schema/78510532 / 2022 | 社区提供 react-declarative 映射与校验思路，说明库选择需按数据形态 | TypedField/schema | 表单校验/保存 | 非官方推荐，需自验 | React 表单 | 有回答但非官方最佳实践 | 社区内容；不引入 | 仅借鉴，不作选型依据 |
| E63 | StackOverflow：Dynamic form validation using JSON（社区讨论） | https://stackoverflow.com/questions/42551462/dynamic-form-validation-in-reactjs-using-json-data / 2017 | 从 JSON 属性驱动控件与 onChange 校验，说明错误状态应随输入更新 | JSON field metadata | errors/state rerender | 手写校验易重复/遗漏 | React 动态表单 | 老案例，仅历史参考 | 社区内容；不引入 | 借鉴错误状态，不采用代码 |
| E64 | Hacker News：OpenUI code-like spec（社区讨论） | https://news.ycombinator.com/item?id=47336804 / 2026 | 社区争论 JSONL 与 code-like DSL 何者更适合模型，提醒 token/语法权衡 | OpenUI Lang | 流式 DSL | 不是 JSON 也需校验与降级 | 多渲染器 | 评论观点非独立 benchmark | 社区讨论；不引入 | 反选新 DSL，保留格式比较 |
| E65 | Hacker News：A2UI declarative protocol（社区讨论） | https://news.ycombinator.com/item?id=46286407 / 2026 | 有评论质疑信任 LLM 输出、UI 冒充和可用性，补足安全反方 | catalog/components | 客户端状态 | 白名单不能代替全部威胁建模 | 原生组件 | 反对意见来自评论，不是官方结论 | 社区讨论；不引入 | 强化权限/确认/降级与测试 |
| E66 | Reddit OpenClaw：A2UI progressive enhancement（社区案例） | https://libreddit.vanillax.me/r/OpenClawDevs/hot / 2026 | 静态 shell+A2UI 内容，Markdown 与 A2UI 双轨，证明旧入口可保留 | 自定义 catalog/CRM data | WS/loading/empty state | 官方 canvas 不可用时本地 fallback | Next.js+React | 用户案例非通用方案 | 社区案例；不引入 | 直接支持渐进增强与双轨 |
| E67 | Reddit：catalog 太限制（社区观点） | https://www.reddit.com/r/AI_Agents/comments/1psb42l/a_new_generative_ui_proposal_stay_grounded_in/ / 未标注 | 担心目录导致界面雷同，说明白名单与表达力存在产品张力 | catalog/layout | 未覆盖 | 固定目录与动态覆盖折中 | 观点性讨论 |  Reddit 观点，未独立验证 | 社区讨论；不引入 | 保留5布局但跟踪模板重复感 |
| E68 | InfoQ：A2UI v0.9（行业报道） | https://www.infoq.com/news/2026/07/google-a2ui-genui/ / 2026-07 | 汇总 v0.9 双向、动态目录、流式修复与迁移，也纳入安全/雷同质疑 | schema/data sync | 客户端函数与版本协商 | fixed+dynamic fallback | React 官方渲染器出现 | 报道引用 HN/Reddit 多观点 | 行业报道；不引入 | 支持版本与降级，不追新协议 |
| E69 | InfoQ：支付宝 xUI（工程案例） | https://www.infoq.cn/article/at1UIEMQbHewc34wvFQ8 / 未标注 | 从 Markdown→HTML 容器→事项驱动组件的演进，强调完成服务而非生成页面 | MCP/Skill→卡片 | 多步服务状态 | 自研 Web 内核性能/稳定性 | 三端原生+Web 区块 | 企业案例，非通用基准 | 官方案例；不引入 | 借鉴任务/卡片与原生入口 |
| E70 | InfoQ：千问灵光生成式 UI（行业分析） | https://xie.infoq.cn/article/74ee607da6b468e045f99f33c / 未标注 | 设计态定义规则、运行态组合组件，融合实时适应与工作流可控 | 原子组件与设计系统 | 上下文规则 | Zod/TS 输出结构约束 | 生成式小程序 | 分析文章非生产证据 | 社区内容；不引入 | 直接支持设计态 token 约束 |
| E71 | DEV：Generative UI in 2026 What Works（社区案例） | https://dev.to/alexcloudstar/generative-ui-in-2026-what-actually-works-for-developers-fic / 2026 | 总结 registry、typed props、组件内临时状态与 agent 持久状态，框架次于设计纪律 | tool→component props | ephemeral vs durable state | 表单需允许修正模型猜测 | 多框架比较 | 作者经验，非对照实验 | 社区文章；不引入 | 直接支持状态分层与可修正 |
| E72 | DEV：Dynamic Dashboards（工程案例） | https://dev.to/programmingcentral/build-dynamic-dashboards-with-natural-language-the-ultimate-guide-to-generative-ui-3okm / 未标注 | AI 选择工具，服务端执行查询并流式返回可视化，强调凭证留服务端 | tool/data query | server/client transition | Zod 与异步错误处理 | React/RSC 图表 | 示例代码，非 Harbor 架构 | 社区案例；不引入 | 借鉴工具执行与渲染分权 |
| E73 | DEV：mdocUI streaming UI（社区项目） | https://dev.to/abhaygawade/why-markdoc-for-llm-streaming-ui-3m26 / 未标注 | 分析 JSON fence 半块与 JSX 混写问题，提出 Markdoc 标签流式组件 | markdown+component tags | AST 流式状态 | 半 JSON 不能可靠解析 | React 组件 | alpha，非成熟证明 | 社区项目；不引入 | 反证完整 block 与禁自由 JSX |
| E74 | DEV：Streaming UX Patterns（工程讨论） | https://dev.to/syncfusion/why-modern-ai-apps-feel-faster-streaming-ux-patterns-that-actually-work-4dd3 / 未标注 | 区分 TTFT、首可见、首可用和完成，强调取消、布局稳定与错误恢复 | partial events | 保留部分输出 | 连接中断仍可展示有用内容 | SSE/fetch/WS | 示例性指南，非性能数据 | 社区文章；不引入 | 直接完善首屏指标口径 |
| E75 | CSS-Tricks：Form design（设计指南） | https://css-tricks.com/form-design/ / 未标注 | 标签、输入关联与表单 UX 是动态组件也必须满足的基本功 | label/input | 用户输入与错误 | 缺标签会直接损害可访问性 | 原生 HTML | 实测经验分享 | 社区文章；不引入 | 强制组件 aria/label 验收 |
| E76 | CSS-Tricks：Accessible React Apps（工程案例） | https://www.css-tricks.com/accessible-web-apps-react-typescript-allyjs/ / 未标注 | 焦点圈定、首 tabbable、Esc 与卸载清理，适合动态浮层/视图 | dialog/focus | mount/unmount 清理 | 键盘不可达需显式修复 | React/Ally.js | 工程示例非生成 UI 专用 | 社区文章；不引入 | 复用到生成视图焦点管理 |
| E77 | Smashing：Formik and Yup（工程指南） | https://www.smashingmagazine.com/2020/10/react-validation-formik-yup/ / 2020-10 | 表单值、错误、提交状态需一致建模，动态校验不能只在末尾补 | values/errors/isSubmitting | handleChange+validate | 错误与提交联动 | React 表单 | 经典旧文，非 AI 专用 | 社区文章；不引入 | 借鉴客户端表单状态模型 |
| E78 | Smashing：Forms and Validation in Ionic React（工程指南） | https://smashingmagazine.com/2020/08/forms-validation-ionic-react/ / 2020-08 | 强调屏幕阅读文本与移动端组件事件差异，跨框架不能假设一致 | ARIA/change events | 移动表单状态 | 可访问性需实现而非赠送 | Ionic/React | 经典旧文 | 社区文章；不引入 | 强化375移动与aria测试 |
| E79 | 掘金：Google A2UI（社区解读） | https://juejin.cn/post/7621772907050041386 / 未标注 | 对比原生 catalog 与 MCP iframe 的安全、样式一致性和跨端取舍 | A2A/AG-UI/GenUI | 增量 JSON | 目录限制与版本预览风险 | React/Flutter 等 | 社区解读，日期/版本需另核 | 社区文章；不引入 | 仅作补充，不代替官方规范 |
| E80 | 掘金：动态表单渲染引擎（工程案例） | https://juejin.cn/post/7533619109297897507 / 2025 | 比较 Formily 与拖拽 DForm，说明协议、响应式和自由布局的成本不同 | Schema/RecursionField | 设计态/运行态同步 | 高联动和高自由各有学习成本 | 动态表单/设计器 | 社区案例非官方对比 | 社区文章；不引入 | 支持反选重型编辑器 |

## 3. 横向比较汇总

| 路线 | 协议/代表 | 动态组件与绑定 | 状态与流式 | 安全/降级 | 对 Harbor 的判断 |
|---|---|---|---|---|---|
| 交互协议 | AG-UI | 规范之外的传输与事件 | 双向事件/state | 应用负责验证 | 可借鉴事件边界，不接运行时 |
| 声明式跨端 | A2UI | catalog + data model | 增量 messages/多版本 | catalog 协商、renderer sanitize | **最贴近的参考协议**；仅 P2 评估适配 |
| 完整 JSON spec | Open-JSON-UI | component tree | 单 payload 替换 | 应用自管流式/降级 | 可借鉴完整 spec，非原生流式 |
| JSON spec 框架 | json-render / LangChain / assistant-ui | catalog + state + actions | partial props/JSONL patches | 完整元素过滤、错误报告 | **最直接工程参考**；不引 React/Zod |
| iframe App | MCP Apps/OpenAI Apps | ui:// HTML + tool data | iframe 持久交互/postMessage | sandbox/CSP/host 权限 | P0 反选，和禁 HTML/统一 a11y 不同 |
| 受控组件 | Controlled GenUI/AI Elements/ChatKit | 作者组件+tool data | 工具生命周期 | 可预测但开发成本线性 | **默认手写模板来源** |
| 表单 schema | JSONForms/RJSF/Formily/amis | data schema+UI schema+校验 | 字段级状态/联动 | 可见性/校验/错误 | 用于 DataRef、表单状态、错误模型，不引低代码 |
| 代码/DSL 生成 | OpenUI/tldraw make-real/wandb | DSL/HTML/自定义 shape | 流式代码或多轮迭代 | 沙箱/人工清理/质量不稳 | P0 反选；仅作反例与未来研究 |
| 跨端编译 | Mitosis | 静态 JSX→JSON AST→多框架 | 编译时状态 | 静态语法限制 | 非运行时 UiSpec，反选引入 |

## 4. 候选路线 A/B/C

### A. Harbor 原生受限 UiSpec（选择）

- 组件/布局白名单、真实 DataRef、ActionRegistry、AppState/SessionStore、现有 ModelExecutor artifact。
- 固定 5 布局/8 只读组件；完整 block 后投影 + Skeleton + 默认手写模板；actions 默认关闭。
- 优点：无新运行时、最小权限面、统一现代中性+钴蓝 tokens、与原四主面板/W4 兼容、可测试。
- 成本：需要自维护 schema/注册表/解析与评测，但不等于重写通用框架。

### B. 固定 schema 的 A2UI/json-render 适配（P2 可选，不在本轮引入）

- 仅当外部互操作成为真实需求，增加版本化 adapter：`Harbor UiSpec ↔ fixed A2UI/flat spec`，不引 React 或协议运行时。
- 借鉴：catalog、dataModel 分离、完整元素流式、updateDataModel、action 回传、版本协商。
- 前置：schema 映射、权限等价、数据引用转换、旧版本回退和全套契约测试。不得宣称天生兼容。

### C. 全框架 / iframe / 自由 HTML / 重型低代码（反选）

- MCP Apps iframe、OpenGenerativeUI、tldraw make-real、 wandb OpenUI、Mitosis 编译器、完整 CopilotKit/Vercel/LangChain/Formily 低代码。
- 反选原因：引入 React/Vue/新协议运行时或自由代码；扩大 XSS、权限、焦点、样式、状态、打包与维护成本；不符合 P0 只读和旧 UI 不变。
- 若未来确有独立微型 App 场景，应另立安全评审，不与当前 UiSpec 混合放行。

## 5. 可直接复用协议、代码与仅借鉴清单

| 类别 | 结论 |
|---|---|
| **可直接复用的协议思想** | catalog/registry、受限 spec、数据与结构分离、真实 DataRef、完整元素/块过滤、action 具名注册、revision、稳定 block/entity id、骨架与默认模板、无权限/未知/超时降级。 |
| **代码** | 本轮不直接复制或引入。MIT/Apache/BSD 项目只能在具体文件、版本、NOTICE 复核后复用；MCP ext-apps 还存在 MIT→Apache/CC 过渡，tldraw make-real 已归档，不能笼统写“开源随便用”。 |
| **仅借鉴** | CopilotKit/A2UI、Vercel/json-render、LangChain、assistant-ui、ChatKit、JSONForms/Formily、Builder/Mitosis、OpenUI/tldraw 的交互与状态模型；不照搬 React/Vue、依赖、协议或品牌视觉。 |
| **Skill** | 当前市场三次检索无匹配；GitHub 仓库中的技能只作普通资料阅读，不安装、不宣称 WorkBuddy 可复用。 |

## 6. 对现有 PRD 的直接修订依据

1. **保留 P0 原生 UiSpec**，不改成 A2UI/Open-JSON-UI/MCP-UI 兼容工程；未来适配走版本化 adapter。
2. **绑定层增加 prop/data 二次校验**：schema 验证结构后仍须校验数据类型、scope、字段、URL/文本、revision、provenance；秘密不得进入 data model/action context。
3. **流式坚持完整 block**：LangChain/assistant-ui 的完整 elements/props 策略与 OpenAI partial 示例证明，可靠增量应按已验证单元，而非通用半成品解析。
4. **默认模板不可缺**：Controlled generative UI 证实作者组件是高可控 fallback；模型超时/失败不能拖住旧入口。
5. **状态回挂是 P0 而非优化**：Copilot stale issue、array-index key、MCP 重绘与 Formily 字段状态都指向同一风险，必须按 blockId+entityId/revision 回挂并实测焦点/滚动。
6. **动作权限独立于组件渲染**：生成按钮不等于授权执行；P0 actions off，后续 copy/export/refresh 也须显式用户动作与原 Guard。
7. **指标按真实失败模式设计**：unknown_component、binding.miss、schema reject、overflow、stale spec、回挂率、骨架/有效 block 首屏 P95、旧入口可用率；文章和厂商 token 数字不作目标。

## 7. 缺口与未覆盖

- 知乎站内检索 `Formily` 未返回可读相关正文，未把转载当知乎原发证据；不影响 80 条独立 URL 总数。
- 未逐仓库执行测试、未验证真实模型生成质量、未运行候选框架、未启动 Harbor exe。
- 部分文档未标发布日期，已统一写“未标注”；版本和许可只按可读来源记录，未核验的不猜。
- 论坛观点只用于发现风险和替代方案，不升级为生产事实；star 不作为成熟度或安全性证明。
