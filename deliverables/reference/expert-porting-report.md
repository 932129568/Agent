# WorkBuddy 专家/专家团模式移植报告

> 版本：v1.0 ｜ 日期：2026-10-26 ｜ 状态：已实测验证
> 实测环境：Windows + Python 3.13，样本为本机官方专家包 `design-engine`、`product-strategy-team`、`qa-testing`、`fullstack-dev-engineer`
> 配套交付：`expert_portable.py`（可运行参考实现，本报告第 9 章附实测输出）

---

## 0. 执行摘要

**结论：可以移植，且成本低于预期。**

WorkBuddy 的专家/专家团不是封闭能力，而是一套**开放格式的提示词资产 + 一套可复现的协作协议**：

1. 专家包 = 纯 Markdown 角色提示词（`agents/*.md`）+ JSON 元数据（`plugin.json`）+ 可选技能目录（`skills/`）。无二进制、无私有格式、无运行时绑定，全部可读可拷。
2. **Agent 型专家**：`agents/<id>.md` 的正文就是完整的 system prompt，搬到任何 LLM 应用中是零改动的。
3. **Team 型专家团**：团队协作不是框架魔法，而是主理人提示词中约定的一套协议（TeamCreate → Agent spawn → SendMessage → 主理人汇编）。只要你的 agent 运行时具备**子代理派生**与**消息回传**两项原语，注册两个同构工具后，主理人提示词可原文复用。
4. 本报告给出两条移植路径的完整接入代码、4 份可直接复制的提示词模板（T1–T4）、设计精髓与反模式清单、上线前验证清单。

**移植工作量评估**：Agent 型约 0.5 人日（主要是路由与提示词管理）；Team 型约 2–3 人日（编排层 + 工具契约对齐）。

---

## 1. 专家包格式规范（v2.0）

### 1.1 目录结构

以本机官方专家团 `product-strategy-team`（产品战略团队）为例：

```
product-strategy-team/
├── .codebuddy-plugin/
│   └── plugin.json            # 元数据：类型、主理人、成员清单、展示字段
├── agents/
│   ├── product-director.md    # 主理人：SOP + 协作铁律 + 成员能力清单
│   ├── requirement-analyst.md # 团员：角色定义 + 分析框架 + 输出模板
│   ├── user-researcher.md
│   ├── competitive-analyst.md
│   ├── data-analyst.md
│   └── roadmap-planner.md
├── skills/
│   └── product-playbook/
│       └── SKILL.md           # 可选：共享知识，按需加载
├── avatars/                   # 头像资源，移植时可忽略
└── README.md
```

> 注：市场下载的包元数据位于 `.codebuddy-plugin/plugin.json`，本地自建包位于 `.workbuddy-plugin/plugin.json`。移植时两种路径都要兼容（参考实现已做兼容）。

### 1.2 plugin.json 字段规范

**通用字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 唯一标识，kebab-case，技能命名空间前缀 |
| `version` | string | 语义化版本号 |
| `description` | string | 英文一句话描述 |
| `author` | `{name, email}` | 作者信息 |

**类型字段（决定移植路径）**

| 字段 | 说明 |
|------|------|
| `expertType` | `"agent"`（单专家）/ `"team"`（专家团） |
| `agentName` | 主 Agent 名称 = agents/ 下 MD 文件名（不含 .md），必须有业务语义，禁用 `team-lead` 等通用名 |
| `teamInfo` | team 型必填：`{leadAgent, memberAgents[]}`，memberAgents 不含主理人 |

**资源声明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `agents` | string 或 string[] | 目录（如 `"./agents/"`）或文件列表（如 `["./agents/a.md"]`），两种写法官方包均有使用 |
| `skills` | string[] | 技能目录列表 |

**展示字段**（市场分发用；纯自用可裁剪）

| 字段 | 说明 |
|------|------|
| `displayName` / `profession` | `{en, zh}` 展示名与职业头衔；team 型 profession 须与 displayName 一致 |
| `displayDescription` | 中文 40–50 字能力描述 |
| `categoryId` | 行业分类 ID（如 `01-ProductDesign`） |
| `tags` | 固定 3 个 `{en, zh}` 标签 |
| `quickPrompts` / `defaultInitPrompt` | 固定 3 个推荐提示词；第一条 = defaultInitPrompt |
| `members[]` | team 型成员清单：`{id, name, profession, avatar, role}`，role 为 `lead`/`member`，主理人必须在列 |

### 1.3 agents/*.md 规范

**Frontmatter**（解析后用于路由与展示）：

```yaml
---
name: discovery-analyst              # = 文件名，Agent ID
description: Requirement discovery analyst - guides users through ...  # 英文，AI 判断激活时机
displayName: { zh: 许明需, en: Xu }
profession: { zh: 需求发现分析师, en: Requirement Discovery Analyst }
maxTurns: 50                          # 主理人建议 150–200，团员 50
---
```

**正文六段式**（团员/独立专家）：

1. `# 角色名称 - 花名` —— 一句话定位「你是谁」
2. `## 核心能力` —— 3–4 个具体能力点
3. `## 工作流程` —— 分步骤的分析框架（官方样例：许明需的「五维度需求收集」）
4. `## 输出规范` —— 结构化输出模板（表格/Markdown 骨架）
5. `## 注意事项` —— 边界与约束
6. （团队成员必备）**回传要求**：明确「完成后通过 SendMessage 将结果回传主理人」

**主理人正文差异**：在六段式之外增加三块——`## 团队成员`（Agent ID + 花名 + 擅长领域 + 典型问法）、`## 标准工作流程（SOP）`（Phase 编排图）、`## 团队协作机制（铁律）`（4 条正则 + 严禁行为清单）、`## 路由：单 agent 直调`（简单问题直调对应成员）。

### 1.4 skills/ 渐进式披露

技能是「按需加载的知识包」，结构为 `skills/<name>/SKILL.md` + `references/` + `scripts/` + `templates/`。SKILL.md 的 frontmatter 含 `name`、`description`（含触发词），正文只放索引与使用方式，大段知识放 `references/` 由模型自行取读。移植时原样保留即可（参考实现的 `load_package` 已解析）。

### 1.5 settings.json（team 型必需）

```json
{ "agent": "{team}-team-lead" }
```

值必须与 plugin.json 的 `agentName`、主理人 MD 的 `name` 三处一致。

---

## 2. 运行机制解构

### 2.1 Agent 型链路

```
用户问题 → 路由（按 description/tags 匹配）→ system = agents/<id>.md 全文 → LLM 调用 → 返回
```

### 2.2 Team 型链路

```
用户问题
  → 主理人（system = 主理人 MD，含 SOP 与铁律）
      → TeamCreate（建立本次任务团队，仅主理人可执行）
      → 按 SOP Phase 调用 Agent(name=<成员ID>, prompt=<任务>, subagent_type=<成员ID>)
          → 成员子代理（system = 成员 MD，独立上下文）
              → SendMessage(to=<主理人>, content=<产出>)
      → 主理人收集中转，驱动下一 Phase
      → 汇编最终产出返回用户
```

### 2.3 本质

团队协作的全部约束都写在**主理人的提示词里**（铁律、SOP、路由表、Agent ID 清单），运行时只提供两个原语：**派生独立上下文的子代理**、**在代理间传递消息**。这意味着移植工作 = 复刻两个原语 + 对齐工具命名，而不需要复刻任何框架逻辑。

---

## 3. 移植路径 A：Agent 型（零改动复用）

### 3.1 接入步骤

1. 定位专家包目录（本机：`~/.workbuddy/plugins/marketplaces/experts/plugins/<name>/` 或自建 `~/.workbuddy/plugins/marketplaces/my-experts/plugins/<name>/`）。
2. 读取 `plugin.json` 取 `agentName`，读取 `agents/<agentName>.md`，剥离 frontmatter 后作为 system prompt。
3. 用 `description` + `tags` 做问题路由，决定激活哪个专家。
4. 如需附带知识，将 `skills/` 目录挂到你的知识加载层（见第 5 章）。

### 3.2 接入代码

```python
from expert_portable import load_package

pkg = load_package("path/to/qa-testing")          # agent 型专家
agent = pkg.agents[pkg.meta["agentName"]]

# 你的 LLM 调用：system = 提示词正文，零改动
answer = your_llm(system=agent.body, user=user_query)
```

### 3.3 提示词模板 T1：独立专家 / 团队成员 MD

```markdown
---
name: {agent-id}
description: {英文一句话：角色定位 + 核心职责，供路由判断激活时机}
displayName:
  zh: "{花名}"
  en: "{Name}"
profession:
  zh: "{职业头衔}"
  en: "{Profession}"
maxTurns: 50
---

# {领域} - {花名}

你是{团队名或产品名}的**{职业}{花名}**，负责{核心职责}。你的核心理念是「{一句工作哲学}」。

## 核心能力

1. **{能力1}**：{具体描述}
2. **{能力2}**：{具体描述}
3. **{能力3}**：{具体描述}

## 工作流程

### 步骤 1：{阶段名}

{必须执行的动作、判断分支、输入输出}

### 步骤 2：{阶段名}

{...}

## 输出规范

输出格式为「{产出物名}」：

````markdown
## {产出物标题}

| 维度 | 结论 |
|------|------|
| {维度1} | {结论} |

### {小节}
- {要点}
````

## 注意事项

- {边界条件1：何时不做某事}
- {边界条件2：信息不足时的行为}
- {边界条件3：输出纪律}

## 回传要求（团队成员必填）

完成后必须通过 SendMessage 将完整产出回传给主理人，不得只给摘要；如需用户补充信息，向主理人说明缺失项。
```

---

## 4. 移植路径 B：Team 型专家团

### 4.1 运行时能力要求

| 能力 | 说明 | 缺失时的降级 |
|------|------|-------------|
| 子代理派生 | 以成员 MD 为 system prompt，启动独立上下文实例 | 只能串行「分段扮演」，团队价值大减 |
| 消息回传 | 成员产出可送达主理人信箱 | 退化为函数返回值直传（可接受） |
| 并行调度 | 同 Phase 多成员同时执行 | 串行执行，结果等价、耗时增加 |

最低可行组合：**派生 + 回传**即可跑通；并行是优化项。

### 4.2 编排层实现

配套参考实现 `expert_portable.py` 的 `TeamRuntime` 已完成编排层，核心契约：

```python
from expert_portable import load_package, TeamRuntime

pkg = load_package("path/to/design-engine")

# 你只需实现这一个函数：接入自己的 LLM（支持工具调用）
def my_llm(agent_id, system, user, tools):
    return your_llm_api(system=system, messages=[{"role": "user", "content": user}],
                        functions=[t.schema for t in tools])

runtime = TeamRuntime(pkg, my_llm)
final_answer = runtime.run("帮我做一个 SaaS 落地页")
```

`TeamRuntime` 向主理人暴露两个与 WorkBuddy **同名同参**的工具：

- `Agent(name, prompt, subagent_type)` —— 按 Agent ID 派生成员子代理，返回其产出
- `SendMessage(to, content)` —— 成员回传通道

主理人提示词（含铁律、SOP、Agent ID 清单）**原文复用，无需改写**。

### 4.3 工具名对齐策略（三选一）

主理人 MD 中写死了 `Agent(...)` / `SendMessage(...)` / `TeamCreate(...)` 的调用方式，移植时必须让「提示词里的工具名」与「运行时注册的工具名」一致：

| 策略 | 做法 | 适用 |
|------|------|------|
| A. 同名注册（推荐） | 运行时注册名为 `Agent`、`SendMessage` 的函数，参数保持 `(name, prompt, subagent_type)` | 自建运行时，提示词零改动 |
| B. 全局替换 | 将 MD 中的工具名替换为你的工具名（如 `spawn_agent`） | 已有成熟工具命名体系 |
| C. 适配层 | 注册薄封装，把你的工具映射到 WorkBuddy 签名 | 复用多个专家包、命名不统一时 |

`TeamCreate` 在移植版中最简实现为一个空操作或团队上下文初始化（团队边界由 mailbox 天然隔离），不影响主流程。

### 4.4 真实 LLM 接入示例（OpenAI 兼容风格）

```python
from openai import OpenAI
from expert_portable import load_package, TeamRuntime

client = OpenAI()                      # 或任何 OpenAI 兼容端点（含本地 vLLM/Ollama）
pkg = load_package("path/to/design-engine")

def make_tool_schema(fn):
    # 将 python 函数转为 OpenAI function schema（此处省略签名反射细节）
    ...

def my_llm(agent_id, system, user, tools):
    resp = client.chat.completions.create(
        model="your-model",
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        tools=[make_tool_schema(t) for t in tools],
    )
    msg = resp.choices[0].message
    while msg.tool_calls:              # 工具调用循环：执行并回填结果
        for call in msg.tool_calls:
            fn = next(t for t in tools if t.__name__ == call.function.name)
            result = fn(**json.loads(call.function.arguments))
            # 将 result 作为 tool message 追加后再次请求……
        resp = client.chat.completions.create(model="your-model", messages=msgs,
                                              tools=[make_tool_schema(t) for t in tools])
        msg = resp.choices[0].message
    return msg.content

print(TeamRuntime(pkg, my_llm).run("为我的产品创建一套品牌级设计系统"))
```

### 4.5 提示词模板 T2：主理人 MD

```markdown
---
name: {team}-team-lead
description: {Team name} lead who orchestrates {member roles} on {domain} workflows
displayName: { zh: "{主理人花名}", en: "{Name}" }
profession: { zh: "{调度风格定位，如：交付总监}", en: "{Delivery Director}" }
maxTurns: 200
---

# {团队名称} - 主理人

你是{团队名称}的**主理人{花名} · {职业头衔}**，负责编排和协调{业务领域}全流程。

**你不直接做专业产出**，而是：
1. 理解用户意图，明确任务边界
2. 按 SOP 阶段调度成员执行
3. 收集各成员产出，传递给下一阶段
4. 综合各环节产出，确保最终交付物达到专业水准

## 团队成员

| 成员 | Agent ID | 花名 | 擅长领域 | 典型问法 |
|------|----------|------|---------|---------|
| {职业1} | `{member-id-1}` | {花名1} | {3-5 个能力点} | "{什么问题该调它}" |
| {职业2} | `{member-id-2}` | {花名2} | {...} | "{...}" |

## 路由：单 agent 直调（简单问题）

| 问法类型 | 直接调谁 |
|----------|----------|
| 只问{某单一维度} | `{member-id-x}` |
| 综合性问题 | 走下方标准 SOP |

## 标准工作流程（SOP）

````
Phase 1 {阶段名} ── {member-id-1}（{花名}）
    ↓ [{阶段产出物名}]
Phase 2 {阶段名} ── {member-id-2}（{花名}）
    ↓ [{产出物}]
Phase N 最终交付 ── 主理人汇总输出
````

### Phase 1: {阶段名}

调用 **{member-id-1}**（{花名}），传入：{输入依赖}。
要求产出：{输出物}。将其作为后续阶段的输入。

### Phase 2: {阶段名}

{...}

## 团队协作机制（铁律）

你必须走正式的**团队协作流程**，严禁简化或跳过：

1. **建立团队**：任务开始时由主理人亲自创建本次任务的团队，明确协作边界。**团队创建必须且只能由主理人执行，严禁委派任何成员创建团队**
2. **调度成员**：按 SOP 阶段将每位成员拉入协作、下发独立任务；成员作为独立协作方输出专业产出，不得由主理人代写
3. **消息中转**：成员产出回传给你，由你汇总、转交下一阶段；所有跨成员信息流必须经主理人中转，不得互相直连
4. **成员结论为准**：任何专业意见必须由对应成员输出后再采信，主理人只做编排与汇编

### 严禁行为

- ❌ 禁止跳过建团流程，直接自己模拟成员发言或并行写出多角色内容
- ❌ 禁止自己代写任何团队成员的专业产出
- ❌ 禁止未完成前序阶段就跳到后续阶段
- ❌ 禁止让成员互相直连通信

### 子任务命名（CRITICAL）

调度每位成员时，**必须**在 Agent 工具的 `name` 参数中传入该成员的 **Agent ID**，`subagent_type` 也传入相同值。完整列表：
- `name: "{member-id-1}", subagent_type: "{member-id-1}"`
- `name: "{member-id-2}", subagent_type: "{member-id-2}"`
```

### 4.6 提示词模板 T3：plugin.json（team 型最小可用版）

```json
{
  "name": "{team-kebab-name}",
  "version": "1.0.0",
  "description": "{English one-line description}",
  "agents": "./agents/",
  "expertType": "team",
  "agentName": "{team}-team-lead",
  "teamInfo": {
    "leadAgent": "{team}-team-lead",
    "memberAgents": ["{member-a}", "{member-b}"]
  },
  "displayName": { "en": "{Team Name}", "zh": "{团队名}" },
  "profession": { "en": "{Team Name}", "zh": "{团队名}" },
  "displayDescription": { "zh": "{40-50 字能力描述}" },
  "categoryId": "02-Engineering",
  "members": [
    { "id": "{team}-team-lead", "name": { "zh": "{花名}" }, "profession": { "zh": "{头衔}" }, "role": "lead" },
    { "id": "{member-a}", "name": { "zh": "{花名}" }, "profession": { "zh": "{头衔}" }, "role": "member" }
  ]
}
```

---

## 5. 技能（skills）移植

### 5.1 渐进式披露机制

WorkBuddy 技能采用三层结构，直接照搬可显著降低上下文占用：

```
skills/<name>/
├── SKILL.md            # 第一层：frontmatter（name + description 含触发词）+ 索引正文
├── references/         # 第二层：大段知识，模型按需取读
├── scripts/            # 第三层：可执行脚本
└── templates/          # 输出模板
```

移植要点：启动时只注入各技能的 `name` + `description`（含触发词），模型判断相关后才读取 SKILL.md 全文，再按需读 `references/`。参考实现的 `load_package` 已解析 `skills/` 字段。

### 5.2 提示词模板 T4：SKILL.md

```markdown
---
name: {skill-name}
description: |
  {一句话能力描述}。{覆盖范围}。
  触发词：{词1}、{词2}、{词3}
---

# {技能标题}

## 功能说明

{这个技能解决什么问题，何时用它}

## 核心内容索引

- {主题1}：参考 @references/{file1}.md
- {主题2}：参考 @references/{file2}.md

## 使用方式

1. {步骤1}
2. {步骤2}
3. {步骤3}
```

---

## 6. 设计精髓与反模式

### 6.1 六条精髓（建议全部继承）

1. **提示词即资产**：角色与代码解耦，专家包是纯数据，可版本化、可分发、可市场交易。
2. **星型拓扑**：所有跨成员信息必须经主理人中转，防止多代理上下文互相污染。
3. **SOP 预编排**：高频场景固化为「触发条件 + Phase 串并行 + 输入输出依赖」的工作流，省去每次临场调度的决策成本与不稳定性。
4. **铁律用显式禁止清单**：负向约束（「禁止主理人代写成员产出」）比正向描述更能稳定约束 LLM 的编排行为。
5. **成员结论为准**：专业产出必须由独立上下文的子代理生成，从机制上杜绝主理人「幻觉代写」。
6. **Agent ID 规范**：kebab-case，`agentName` = MD 文件名，路由与调度可预期、可校验。

### 6.2 六个反模式（移植时避免）

1. **单循环里分段扮演多角色**：没有独立上下文，角色人格互相渗透，产出质量接近单代理。
2. **成员互相直连**：信息流不经主理人，上下文迅速发散，最终汇编失去事实基线。
3. **主理人代写成员产出**：团队退化为「一个模型写多份文档」，失去专家分工的意义。
4. **SOP 缺失、全靠临场调度**：同一问题每次编排路径不同，结果不可复现。
5. **工具名与提示词不对齐**：主理人按提示词调用 `Agent(...)`，运行时未注册同名工具，编排指令静默落空。
6. **技能全文常驻上下文**：不按渐进式披露加载，token 成本随技能数线性膨胀。

---

## 7. 兼容性矩阵与局限

| 维度 | Agent 型 | Team 型 |
|------|----------|---------|
| 运行时要求 | 任意 LLM 调用 | 子代理派生 + 消息回传 |
| 提示词改动 | 零 | 零（工具同名注册时） |
| 并行支持 | 不涉及 | 需要并发执行能力（否则串行降级） |
| 主要风险 | 路由误激活 | 工具契约不对齐、maxTurns 耗尽 |

**已知局限**：

1. **并行是硬门槛**：若你的运行时只能串行单循环，Team 型将退化为分段扮演，此时建议只移植 Agent 型成员，用普通路由分流。
2. **maxTurns 是自管项**：WorkBuddy 侧由 harness 强制执行 frontmatter 的 `maxTurns`；移植后需在你的 agent loop 中自行实现轮数上限（主理人建议 150–200）。
3. **官方市场专家包的再分发**需遵守 marketplace 协议；自建专家（`~/.workbuddy/plugins/marketplaces/my-experts/plugins/`）可自由处置。
4. **头像、市场展示字段**（`displayName`、`categoryId`、`quickPrompts` 等）仅影响分发展示，纯自用可全部裁剪，只保留 `name`/`expertType`/`agentName`/`teamInfo`/`agents`。

---

## 8. 上线前验证清单

移植完成后逐项核对：

- [ ] `plugin.json` 可解析，`expertType` 与 `agentName` 正确
- [ ] agents/ 下每个 MD 均可加载，frontmatter 解析无丢字段
- [ ] team 型：`teamInfo.leadAgent` 与全部 `memberAgents` 均有对应 MD
- [ ] 主理人 MD 中引用的每个 Agent ID 都能在运行时成功派生（用参考实现 `validate` 命令自动核对）
- [ ] `Agent` / `SendMessage` 工具已注册，且参数签名与提示词一致
- [ ] 一次端到端 dry-run：主理人收到任务 → 派生至少一个成员 → 回传 → 汇编
- [ ] SOP Phase 解析结果与人工阅读一致（`sop` 命令）
- [ ] maxTurns 上限已在你的 loop 中生效
- [ ] 简单问题走单 agent 直调路由，未触发完整 SOP

---

## 9. 附录：参考实现实测结果

配套文件 `expert_portable.py`（仅标准库，Python 3.8+）。本机实测输出摘要：

**加载两个官方专家团（`list`）**：

```
■ 设计原型专家团  [专家团]
  expertType=team  agentName=design-engine-team-lead
  主理人: design-engine-team-lead
  成员:   discovery-analyst, design-system-expert, prototype-builder, critique-reviewer, export-specialist
  技能:   design-systems, prototype-templates, quality-review

■ 产品战略团队  [专家团]
  expertType=team  agentName=product-director
  成员:   requirement-analyst, user-researcher, competitive-analyst, data-analyst, roadmap-planner
```

**契约校验（`validate`，4 个官方包全部 PASS）**：

```
[PASS] 设计原型专家团
    - [info] 提示词引用的工具: ['Agent', 'TeamCreate'] —— 移植时需注册同名工具或全局替换
[PASS] 产品战略团队
    - [info] 提示词引用的工具: ['Agent', 'SendMessage', 'TeamCreate']
[PASS] Horizon（qa-testing，agent 型）
[PASS] 栈师（fullstack-dev-engineer，agent 型）
```

**SOP 解析（`sop`，design-engine 的 6 阶段 + 审查门控条件行）**：

```
1. Phase 1 需求发现 discovery-analyst（许明需）      -> 派生 ['discovery-analyst']
2. Phase 2 设计系统选择 design-system-expert（彩格调） -> 派生 ['design-system-expert']
3. Phase 3 原型生成 prototype-builder（筑原型）      -> 派生 ['prototype-builder']
4. Phase 4 质量审查 critique-reviewer（严过审）      -> 派生 ['critique-reviewer']
5. PASS Phase 5 / REVISE 返回 Phase 3（最多 2 轮）    -> 主理人汇编
6. Phase 5 导出交付 export-specialist（交付达）       -> 派生 ['export-specialist']
7. Phase 6 最终交付 主理人汇总输出                   -> 主理人汇编
```

**dry-run 编排演练（`dryrun`）**：

```
[dry-run] 主理人 'design-engine-team-lead' 收到任务（system 4225 字符，tools=['tool_agent', 'tool_send_message']）
[dry-run] SOP 静态解析结果：（同上 7 阶段）

[dry-run] agent 型专家 Horizon（qa-testing）
    接入方式: system = agents/qa-testing.md 全文（750 字符）
    工具依赖: 无（单代理直调）
```

**使用方式**：

```bash
python expert_portable.py list <专家包目录> [更多目录...]     # 列出专家/团队成员/技能
python expert_portable.py show <专家包目录> <agent-id>       # 查看角色提示词
python expert_portable.py validate <专家包目录> [...]        # 移植契约校验
python expert_portable.py sop <专家包目录>                   # 解析 SOP 编排
python expert_portable.py dryrun <专家包目录> "任务描述"      # 无 LLM 编排演练
```

接入真实模型时，实现 `my_llm(agent_id, system, user, tools)` 并传给 `TeamRuntime`（见 4.2 / 4.4 节）。

---

## 10. 结论

1. **Agent 型专家**：拷贝 `agents/*.md` 即可在任何 LLM 应用中使用，工作量以小时计。
2. **Team 型专家团**：在自有运行时注册 `Agent` / `SendMessage` 两个同构工具后，主理人提示词（含 SOP 与铁律）原文复用；核心投入在编排层与工具契约对齐，约 2–3 人日。
3. 无论是否采用专家包文件格式，第 6 章的六条设计精髓（提示词即资产、星型拓扑、SOP 预编排、显式禁止清单、成员结论为准、Agent ID 规范）都值得作为自有 agent 的架构原则。
