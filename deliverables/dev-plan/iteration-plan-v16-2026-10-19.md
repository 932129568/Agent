# Harbor v1.6.0「开放版」迭代方案

**日期**：2026-10-19
**类型**：迭代方案（基于交接文档 + 代码库实测 + 外部检索）
**基线**：v1.5.0（561 passed）+ 沙箱核心（2026-10-19 已实现，584 passed / 契约 PASS，UI 待接线）
**上游**：`deliverables/dev-plan/handover-2026-10-19.md`、`KNOWN_ISSUES.md`、`deliverables/dev-plan/roadmap-local-llm-mcp-2026-10-17.md`
**状态**：v1.0（待产品负责人审定；§8 三个待确认问题需裁决）

---

## 📌 TL;DR

- **一句话**：v1.6.0 把 Harbor 从「本地优先的单机客户端」推进到「**多云来源 + 可治理执行**」——新增 GitHub Models 免费层接入、DeepSeek 能力校准、五处提示词体系更新、页面信息架构重构，并收尾沙箱模块（UI + 真机冒烟）与三轮审查遗留的 Agent 问题。
- **总盘子**：约 26–28 人日，四个里程碑（M1 模型与提示词 / M2 沙箱收尾与 Agent 遗留 / M3 本地优化与布局重构 / M4 新功能落地）；单人全职约 5–6 周 / 2 人并行约 3.5–4 周。
- **最重要的三个判断**：① 用户点名的「DeepSeek」**已经实现**（v1.5 连接层 preset 完备），本版做实测校准而非从零接入；真正的接入工作量在 **GitHub Models 免费层**（外部检索已核实端点/鉴权/限额，见 §9）；② 沙箱后端已交付但**无 UI 即无治理**——设置面板接线是本版 P0，不能让安全特性裸奔；③ 布局重构是本版最大单项（约 5 人日），必须放在 M3 且 UI 契约只增不改。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 版本主题 | 「开放版」：多云来源（GitHub Models/DeepSeek 校准）+ 可治理执行（沙箱收尾）+ 体验重构（布局/提示词） |
| P0（不可裁剪） | GitHub Models 接入 / 沙箱 UI+冒烟 / 提示词体系 / W21-W26 连接池遗留 |
| P1（尽力） | 布局重构 / 本地模型运行优化 / MCP resources 能力 |
| P2（降级项） | 匿名遥测最小版 / DND 免打扰（二选一，见 Q3） |
| 量化目标 | 同任务链 token -15%（提示词+本地优化合力，v1.4 的 -25% 基础上累计）；GitHub Models 429 人话覆盖率 100%；沙箱六步冒烟全过 |
| 风险等级 | 中——布局重构的 UI 契约回归面、GitHub Models 免费层限额不确定性（外部源，[外]）、真机冒烟环境缺失（老问题） |

---

## 1. 六大领域 → 工作流映射

| 用户领域 | 归入 | 关键事实（代码库/外部核实） |
|---|---|---|
| ① 扩展本地大模型接入（DeepSeek + GitHub FreeToken） | **M1** | DeepSeek preset **已完备**（`36-connect.js`：`api.deepseek.com/v1` + v4.1-256k/v4.1 + 价格 + 256k ctx 徽标）[内]；GitHub Models = 新接入（端点/鉴权/限额已外部核实）[外] |
| ② 更新大模型提示词 | **M1** | 五处提示词源已定位：`build_system_prompt`（api.py）、`EFFICIENCY_PROMPT`（55-tool-route.js）、compact 压缩提示（97-compact.js）、MCP instructions（v1.3 已实现展示不注入）、本地模式段 [内] |
| ③ 优化本地大模型适配与运行表现 | **M3** | v1.5 已交付：并行探测/模型清单+ctx 元数据/免 Key 测试/工具能力三态/系统消息归一（Ollama 500 修复）/400 双降级链 [内]；缺口见 §5 |
| ④ 重构页面布局 | **M3** | 现状：chat 面板 + 设置浮层（10+ set-block + 33-set-nav 锚点）+ 38-ws-quick 工作区快捷条 + 审计查看器 + 会话搜索 [内] |
| ⑤ 调研 Agent 现有问题与能力缺口 | **M2** | 三轮审查遗留：W21-W26 连接池族边界、W27/W28/W30/W33 边界项；KNOWN_ISSUES 15 项中与本版相关 6 项 [内] |
| ⑥ 调研可新增功能 + 遗留补全 | **M4** | 候选池：MCP resources/prompts、OAuth、遥测、DND、多模态、真机冒烟、WebDAV 真实服务器联调 [内] |

---

## 2. M1 · 模型来源扩展与提示词体系（6 人日，W1–W2）

### 2.1 任务表

| # | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| T1 | **GitHub Models 预设接入**（`36-connect.js` PRESETS 新增 `github-models`）：base_url=`https://models.github.ai/inference`；Key 字段文案改为「GitHub PAT（models:read  scope）」+ 获取指引链接；价格表置零 + 徽标「免费层」 | P0 | 1.5 | — | Given 用户选 GitHub Models 预设，When 打开设置，Then 自动填充端点且 Key 占位符明示 PAT 与 scope；Given 粘贴非法 Key，When 测试连接，Then 401 人话提示含 scope 检查指引 |
| T2 | **GitHub 模型目录探测**（新后端 `github_models()` 或扩展 `local_models`）：`GET /catalog/models` 拉取清单（模型 ID 为 `provider/model` 格式，如 `openai/gpt-4o`——外部核实此格式，裸名会校验失败 [外]）；解析 name/context/modalities | P0 | 1.0 | T1 | Given 探测成功，When 打开模型下拉，Then 显示目录模型（含 ctx 徽标）；Given 目录接口失败，When 探测，Then 降级为手输模型名 + 明确错误 |
| T3 | **免费层限额人话映射**：429 响应头区分「请求频率」vs「每日配额」（外部核实 GitHub 用 header 区分 [外]）→ `humanize_http_error` 新增分支；设置面板常驻「免费层禁止生产使用」提示（外部核实 free tier 明确禁生产 [外]） | P0 | 0.5 | T1 | Given 触发 429，When 展示错误，Then 人话说明是 RPM 还是日额度及恢复时间；Given 用户查看设置，Then 可见免费层使用限制声明 |
| T4 | **DeepSeek 实测校准**：真机联调 deepseek-v4.1-256k 工具调用兼容性（已知 GLM 路径已验证，DeepSeek 的 function calling 需实测）；价格表按实测账单校准；联调结论入交付报告 | P0 | 1.0 | — | Given DeepSeek 端点，When 跑基准任务链②（单文件改），Then 工具调用全成功且花费计算正确；不达预期则记录降级路径（同 v1.2 Q4 模式） |
| T5 | **提示词体系更新**（五处，先基线后改动）：① `build_system_prompt` 增「沙箱告知段」（命令在受限环境执行：内存/进程/CPU/网络不隔离的边界描述，防 Agent 误判「沙箱=绝对安全」）；② `EFFICIENCY_PROMPT` 补 GitHub Models/免费层策略（限额敏感：合并轮次、禁全库扫描）与 MCP 工具铁律；③ compact 提示词增「保留工具调用序列」要求（现只保留文件路径）；④ 本地模式段增「上下文有限」提示；⑤ MCP instructions 维持展示不注入（v1.3 裁决不动） | P0 | 2.0 | 沙箱后端（已具备） | Given 任一提示词源改动，When 跑契约差分，Then `build_system_prompt` 不在逐字节比对清单（安全）+ 三条基准链输出质量不降（人工评审 checklist）；Given 沙箱启用，When 系统提示生成，Then 含沙箱边界告知段 |

### 2.2 接口设计要点

- **零新 js_api**：T2 优先扩展既有 `local_models(base_url)` 语义（传 GitHub 目录 URL 返回清单）；若目录响应结构差异大，新增 `github_models()` 并进 `_V12_EXTRA`（既有模式）。
- **config.json 新键**：`github_pat`（T1 的 Key 走 provider 既有键位，不新增）；价格表按模型名解析（v1.2 机制），免费层价格 0 短路三价计算。
- **契约红线**：T5 的 `build_system_prompt` 改动**已在 INTENTIONAL_DELTAS 白名单机制内**（v1.3.2 同款先例：工作区门禁段）；`build_tools` 默认路径零改动。

---

## 3. M2 · 沙箱收尾与 Agent 遗留修复（6 人日，W2–W3）

### 3.1 任务表

| # | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| T6 | **沙箱设置面板 + 状态灯**（前端新模块 `39-sandbox.js` + 模板纯新增区块）：开关 / 三命令类别档位下拉 / 三档限制编辑（内存/进程数/CPU/UI 级别）/ 状态灯（可用性 + 累计统计：jobs_created/runs_sandboxed/runs_failed_closed）/ 「重置默认」 | P0 | 2.0 | 沙箱后端（已完成） | Given 打开设置，When 进入沙箱区块，Then 显示当前档位与统计且可改；Given 改档位保存，When 下条命令执行，Then 按新档位生效（后端读盘验证）；Given 沙箱不可用（非 Windows），When 打开，Then 明示不可用而非空白 |
| T7 | **W21–W26 连接池族边界修复**（三轮审查遗留）：stale 300s 自动重 List 的竞态窗口、池化路径的边界项（逐项见 round3 报告 §四） | P0 | 2.5 | — | Given 构造竞态时序（桩），When 触发 stale 重 List，Then 无双弹/无状态错乱；每项配回归测试 |
| T8 | **W27/W28/W30/W33 边界项**：find 缺 size 参数、工具描述双引号转义两处口径等 | P1 | 1.0 | — | 逐项修复 + 测试；口径不一致处统一并注明 |
| T9 | **沙箱真机冒烟**（六步）：echo 正常 → 超时清剿 → fail-closed 拒绝路径 → 审计可见 → 切档位生效 → 非 Windows 降级提示；结论入交付报告 | P0 | 0.5 | T6 | 六步全过并截图/记录归档；任一步失败打回不改版 |

---

## 4. M3 · 本地模型优化与布局重构（7.5 人日，W3–W4）

### 4.1 任务表

| # | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| T10 | **本地模型运行优化补齐**（v1.5 已交付项的缺口）：① Ollama 503「model is loading」指数退避重试（2/4/8s，上限 120s，loading 态可见）；② 首 token 慢推理等待态（>5s 显示「本地推理中（已等待 Ns）」每秒刷新）；③ tokens/s 速度显示（流式期实时，无 usage 时按字符估算标注「估」）；④ `/api/tags` 元数据的 UI 真机验证（KNOWN_ISSUES #2 销项） | P1 | 2.5 | — | Given Ollama 冷启动，When 调用，Then 503 自动重试且界面有进度；Given CPU 推理首 token 30s，When 发送，Then 等待态每秒可见；KNOWN_ISSUES #2 转 🟢 |
| T11 | **页面布局重构**（信息架构重组，UI 契约只增不改）：① 左侧导航栏（对话/设置/审计/会话搜索/沙箱——替代设置浮层大杂烩，面板制切换）；② 设置浮层保留兼容（老入口不拆，双轨期）；③ 会话头部状态区重组（模型徽标/花费/沙箱态/缓存命中率一屏可达）；④ 空态引导（未配 Key 时首屏引导三步：选来源→填 Key→发问） | P1 | 5.0 | T6（沙箱状态灯并入导航） | Given 新导航上线，When 点击各区，Then 面板切换正常且 40 id/13 onclick/43 callApi/39 类/21 变量零改动（check_contract PASS）；Given 老用户升级，When 首次启动，Then 设置浮层老入口仍可达（兼容期一个版本）； Given 空态，When 无 Key 启动，Then 显示三步引导而非空白聊天区 |

---

## 5. M4 · 新功能落地与遗留补全（7–9 人日，W4–W5）

### 5.1 任务表

| # | 任务 | 优先级 | 工作量 | 依赖 | 验收标准 |
|---|---|---|---|---|---|
| T12 | **MCP resources 能力接入**（v1.3 Non-goal 重启评估）：`resources/list` + `resources/read`（text 类优先，blob 类落盘 toolcache）；UI：服务器详情页「资源」tab + 订阅选择（哪些资源注入上下文）；护栏：资源注入等同工具结果走审计； annotations 不可信原则沿用 | P1 | 4.0 | T7（池族稳定后） | Given 服务器提供 resources，When 启用并订阅，Then 选定资源内容进入上下文且有审计；Given 资源超限，When 读取，Then 截断落盘可 read_more；契约：无新 js_api 或全部隐身 |
| T13 | **遥测最小版 vs DND（二选一，Q3 裁决）**：遥测=匿名本地指标聚合导出（默认关，GDPR/个保法合规说明，30 天保留）；DND=免打扰（窗口失焦时非关键 toast 抑制 + 通知中心留存） | P2 | 1.0 | Q3 裁决 | 遥测：Given 开启，When 产生指标，Then 仅本地聚合、可一键清空、导出件不含任何身份信息；DND：Given 开启且窗口失焦，When 非关键 toast 触发，Then 不弹但入通知中心 |
| T14 | **回归与发布门**：全量 pytest（584 基线不降 + 新增 T2/T5/T7/T10/T12 用例）+ 契约差分 + UI 契约 + 构建幂等 + 基准链复跑（token -15% 累计目标） | P0 | 2.0 | 全部 | 五门全过；基准记录归档 `deliverables/metrics/` |
| T15 | **遗留补全确认**（评估后明确排期或关闭）：OAuth（MCP 远程认证）、多模态输入、WebDAV 真实服务器联调（坚果云/Nextcloud）、杀软误报发布说明、代码签名成本评估 | P2 | 0.5 | — | 每项给出「排期版本 / 明确不做 + 理由」二选一结论，入 roadmap 更新 |

---

## 6. 里程碑与依赖

```
W1      W2      W3      W4      W5
├─ M1 模型与提示词 ─┤
       T1→T2→T3（GitHub 链）
       T4（DeepSeek，可并行）
       T5（提示词，依赖沙箱后端✓）
              ├─ M2 沙箱收尾+Agent 遗留 ─┤
                    T6（沙箱 UI）→ T9（冒烟）
                    T7（W21-26）→ T12 前置
                    T8（边界项）
                           ├─ M3 优化+布局 ─┤
                                 T10（本地优化）
                                 T11（布局，依赖 T6）
                                        ├─ M4 新功能+发布 ─┤
                                              T12（MCP resources）
                                              T13（遥测/DND，Q3）
                                              T14（回归发布）
                                              T15（遗留结论）
```

**关键路径**：T6 → T11 → T14（沙箱 UI 是布局重构的状态区前置，回归是发布门）。
**并行建议**：T4（DeepSeek 实测）与 T1–T3 可并行（前者需目标机联网，后者纯代码）；T7 与 T10 可并行。
**降级规则**：时间告急时 P2（T13/T15）整体顺延 v1.6.1；T11 布局重构可拆「导航栏先行、状态区重组后随」；**T1–T3 / T6 / T9 / T14 不可裁剪**（分别是用户点名需求、安全治理、质量门）。

---

## 7. 量化目标与测试验证

| 目标 | 基线 | 目标值 | 验证方式 |
|---|---|---|---|
| 同任务链总 token | v1.4 基准（-25% 后） | 再 -15%（提示词铁律+本地优化合力） | 3 条标准链前后对比（本环境无外网→目标机执行，协议就绪） |
| GitHub Models 429 人话覆盖率 | 无（新接入） | 100%（频率/日额两分支） | 单测 mock 两种 429 响应头 |
| 沙箱治理可见性 | 后端已交付 | 设置面板全量可配 + 统计可见 | T6 验收 + UI 契约 |
| Agent 遗留 | W21–W33 共 9 项 | 本版清 7 项（W27/28/30/33 中留 2 项低危） | 逐项回归测试 |
| MCP resources | 未实现 | text 类全链路 + 订阅注入 | 打桩服务器（test_v13_mcp 模式延展） |
| 真机冒烟 | 从未做（KNOWN_ISSUES #1） | 沙箱六步 + Ollama 对话 + 搜索跳转 + midx 对齐 | 目标机清单（交接文档 §5 延伸） |

---

## 8. 待确认问题

1. **GitHub Models 的定位**：免费层「明确禁止生产使用」（外部核实 [外]）——Harbor 作为终端用户工具，用户用免费层跑自己的活儿是否在我们的支持范围内？建议：接入但设置面板明示限制，文档引导高频用户切付费层（DeepSeek/GLM）。请确认此立场。
2. **布局重构的双轨期**：新导航与旧设置浮层并存一个版本（兼容成本 ≈ +0.5 人日）还是直接切换（老用户入口断流一版）？建议双轨一版。
3. **P2 二选一**：遥测最小版（数据治理叙事，合规成本）vs DND（轻量体验项）——本版只做一个，另一个入 v1.6.1。请裁决。

---

## 9. 外部检索结论（GitHub Models，2026-10-19，[外]）

| 事实 | 来源 |
|---|---|
| 端点 `https://models.github.ai/inference`（OpenAI 兼容 chat/completions）；旧 Azure 端点 `models.inference.ai.azure.com` 已弃用 | github.blog + toolchew.com（2026） |
| 鉴权：GitHub PAT（classic 或 fine-grained `models:read` scope）作 Bearer token；Actions 可用内置 GITHUB_TOKEN | github.blog / getfreeai.net |
| 模型 ID 为 `provider/model` 格式（如 `openai/gpt-4o`），裸名报校验错误 | toolchew.com |
| 目录接口 `GET https://models.github.ai/catalog/models`（含 modalities 元数据） | toolchew.com |
| 免费层限额：低档约 15 RPM/150 RPD、高档约 10 RPM/50 RPD；429 header 区分频率与日额度；**免费层明确禁止生产使用** | toolchew.com / prismix.dev |
| 目录含 DeepSeek-R1（即 DeepSeek 也可经 GitHub 免费层到达） | github.blog / devpress |

**缺口如实标注**：本环境无法直连 GitHub Models 实测（无外网），上述限额数字为 2026-10 外部源，实施时（T2/T3）需在目标机用真实 PAT 复核目录结构与限额 header——若接口已变更，T2 降级为手输模型名 + T3 保留通用 429 人话。

---

## ⚠️ 假设

- 工作量基于 v1.5.0 模块化结构与 584 测试网既有 velocity；布局重构若在双轨期遇到意外契约回归，最坏 +1.5 人日（缓冲在 T11）。
- GitHub Models 免费层的可用性/限额以外部源为准（§9），接口变动风险由 T2 降级路径兜底。
- 沙箱后端已于 2026-10-19 交付（584 passed），本方案将其视为既有资产，仅计 UI 与冒烟工作量。
- 「token 再 -15%」为提示词与本地优化的合力目标，单项归因不做硬承诺（防为数字牺牲质量，延续 v1.4 Non-goal 5 纪律）。

---

## 📚 来源索引

**[内]** `deliverables/dev-plan/handover-2026-10-19.md`（v1.5.0 状态/铁律/遗留）、`KNOWN_ISSUES.md`（15 项）、`deliverables/dev-plan/sandbox-architecture-2026-10-19.md`（沙箱能力矩阵）、`frontend/src/36-connect.js`（DeepSeek preset 实证）、`frontend/src/34-local-model.js`（本地层实证）、`deliverables/dev-plan/roadmap-local-llm-mcp-2026-10-17.md`（M2 优化项）、`tests/`（584 基线）。
**[外]** GitHub Models 官方博客 + 两篇 2026 第三方评测（URL 见 §9 表内）。

---

> 本方案由产品通基于交接文档、代码库实测与外部检索编制；重要决策请由产品负责人审定。
