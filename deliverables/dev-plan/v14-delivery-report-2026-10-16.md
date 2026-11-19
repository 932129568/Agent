# GLM-Chat v1.4「体验版」实现交付报告

**日期**：2026-10-16 | **依据**：deliverables/product-strategy/prd-glmchat-v14-experience-2026-10-16.md
**版本**：VERSION 1.3.2 → **1.4.0** | **测试基线**：347 → **364 passed**（+17 v14 回归，全绿）

---

## 📌 TL;DR

v1.4 十项改动全部落地：UX 四项（压缩透明化 / 持久信任 / 会话搜索 / 设置导航）+ 省 token 四项（双条件压缩 / estTokens 采样修复 / A2 收紧 / 路由增强）+ 功能两项（会话导出 MD / MCP 超时可配）。Grill 三问已裁决（op 级信任 / 50 条备份上限 / 量化门不达打回）。契约四红线零漂移；量化基准（-25%/cache≥60%）需目标机复跑——本环境无外网，已备好协议与模板。

## 发布门验证（本机实测）

| 门禁 | 结果 |
|---|---|
| 全量 pytest | **364 passed**（347 基线 + 17 新增），复跑两次一致 |
| 契约差分 | test_api_contract.py 逐字节 legacy vs new **零漂移** |
| UI 契约 | check_contract.py **PASS**（40 id/13 onclick/43 callApi/39 类/21 变量只增未改） |
| 前端构建 | 37 模块成功，两次构建 md5 一致（62A18A5046574AE0503BA5FEAABE1BE6） |
| 版本 | APP_VERSION = 1.4.0 ✅ |

## 一、UX 痛点修复（A 组，4/4）

| # | 实现 | 主要文件 | 验收锚点 |
|---|---|---|---|
| UX-1 | 压缩透明化：① send-copy 瘦身消息 UI 打弱化标记「已瘦身 · 原文 N 字 → 发送约 M 字」（hover 摘要开头，与 shrinkHistoryForApi 同口径因子函数防漂移）；② in-place 压缩（compactNow/archiveOldTasks）存单份可恢复备份 `s._compactBackup`（上限 50 条超限标记不可恢复，gen 代号归属核对）；纪要消息挂 `__compactCard`，renderChatHistory 渲染卡片（estTokens before/after + 「↩ 恢复原文」按 kind 插回） | 30-history-shrink.js、97-compact.js、85-session-mgmt.js、65-session-store.js（备份跨重启保留）、index.template.html | TestUx1CompactBackup（备份/恢复/超限三态） |
| UX-2 | 持久信任：确认框第二勾选「永久信任此操作（重启后仍不再确认）」→ 同意后经既有 `guard_save_config` 写 guard.json `trustedOps`（op 级，白名单校验）；check()/enforce_exec() 认信任（**位置在名单 block 之后——名单永远优先**）；审计 decision=trust-persistent；设置面板信任状态展示 + 「重置全部信任」二次确认；首次启用常驻 toast 风险文案 | 26-guard.js、guard_service.py、index.template.html | TestUx2PersistentTrust（读写/enforce/重启/名单优先/重置） |
| UX-3 | 会话搜索：新模块 32-session-search.js——侧栏「⌕ 搜索」入口 → 150ms 防抖输入 → 遍历全部 sessions.messages（user/assistant/tool+工具调用，大小写不敏感）→ 结果列表（标题/角色·时间/±80 字片段 + `<mark>` 高亮，上限 100 条）→ 点击跳转（switchSession + data-midx 定位滚动 + 2.4s 高亮闪烁）；空关键词/无命中空态不报错 | 32-session-search.js（新）、85-session-mgmt.js（renderChatHistory 打 data-midx）、100-send.js/60-agent-loop.js（live 消息打标）、index.template.html | TestUx3SessionSearch（命中/高亮/跳转/空态） |
| UX-4 | 设置面板锚点导航：settingsPanel 顶部 sticky 导航条（按钮与 set-block 一一对应，scrollIntoView 平滑滚动 + rAF 节流滚动监听高亮）；DOM/CSS 纯新增 | 33-set-nav.js（新）、100-send.js（toggleSettings 钩子）、index.template.html | 源码断言 + UI 契约 PASS |

## 二、省 token 优化（B 组，4/4，量化主轴）

| # | 实现 | 主要文件 | 验收锚点 |
|---|---|---|---|
| TOK-1 | 压缩触发双条件（缓存优先）：`token ≥ 阈值 AND 上轮 cache 命中率 < 50%`；≥50% 放宽至 1.5× 阈值（冻结层多扛、前缀缓存多稳几轮）；自定义端点无缓存计价（__hitRate=0）退化为仅 token 阈值（v1.3.2 行为不回退）；跳过时 60s 节流透明提示 | 40-auto-compact.js、75-token-stat.js（lastCacheHitRate） | TestTok1DualConditionCompact（四态矩阵） |
| TOK-2 | estTokens 分层采样：每 3000 字符采 1000（首段必采），段内 ascii/3.5+非ascii/1.8 双比例，按覆盖率外推；消息级缓存（WeakMap+内容指纹防陈旧）——「前 3000 中文+后 3 万代码」与全量基准误差 <10%（实测 ~0.1%） | 40-auto-compact.js | TestTok2EstTokensSampling（误差/缓存） |
| TOK-3 | A2 瘦身收紧一档：keepTail 8→6 / toolMax 600→450 / aiMax 1200→900（与 UX-1 透明化同批上线对冲「AI 忘了」反噬）；read_file/read_more 豁免一字不动；瘦身副本因子函数（shrinkToolCopy/shrinkAiCopy）与标记共用口径 | 30-history-shrink.js | 源码断言 + 豁免回归 |
| TOK-4 | 路由输入增强：输入扩展为「最后 user 消息 + 最近 2 轮工具名 + 最近工具结果前 200 字符」；路由集 = 关键词域 ∪ 最近调用域 ∪ 邻接域（fileR→fileW、proc→shell）∪ ROUTE_ALWAYS；结果含路径形态 → 读写双域；**MCP 工具不裁**（agent-loop bypass 不变） | 55-tool-route.js、60-agent-loop.js | TestTok4RouteInputs（三类输入+空输入+MCP） |

## 三、功能更新（C 组，2/2）

| # | 实现 | 主要文件 | 验收锚点 |
|---|---|---|---|
| F1 | 会话导出 Markdown：会话列表 hover 出「⤓」→ exportSessionMd 前端序列化（角色标题/工具调用 json 块/工具结果 details/时间戳/usage 统计页脚）→ Blob 下载；零后端零新 js_api 零依赖；空会话正常、文件名非法字符净化 | 85-session-mgmt.js、index.template.html | TestF1ExportSerialization（净化/空会话） |
| F2 | MCP 每服务器 callTimeout：mcp_servers.json 新键（10-300s，缺省回落 60，_normalize 越界人话拒绝）；call_tool 读配置替代硬编码（min/max 兜底）；编辑器表单加字段；前端桥接 timeoutMs 动态 =(callTimeout+30)×1000 上限 330s；list_servers 透出供前端取数 | mcp_config_service.py、mcp_service.py、29-mcp.js、62-mcp-exec.js | TestF2CallTimeout（越界/生效/透出） |

## 四、Grill 裁决记录（实现前锁定）

| # | 分支 | 裁决 |
|---|---|---|
| 1 | 持久信任粒度 | **op 级**（trustedOps 存 op 列表，不随使用膨胀） |
| 2 | 压缩备份上限 | **保留 50 条上限可恢复**（超限标记不可恢复） |
| 3 | 量化门不达放行线 | **打回继续优化**（用户比 PRD 建议更严） |

## 五、测试基建修正（本轮）

- **tests/test_v14_experience.py（新，17 用例）**：TOK-1 矩阵 / TOK-2 误差+缓存 / TOK-4 三类输入 / UX-1 备份三态 / UX-2 信任五态 / F2 越界+生效 / UX-3 搜索四态 / F1 导出 / 契约红线（config.json 不污染/_V12_EXTRA 无新增/构建幂等）
- **tests/test_v13_mcp.py 一处启动竞态加固**：`test_close_fails_pending` 原依赖「预置响应入队 → dispatcher 消费」的隐含时序，全套件负载下 dispatcher 首轮 recv 可能在 connect() 注册 pending 前消费掉响应 → initialize 等 30s 超时（单跑不现的经典 flaky，v1.4 让套件变长从而暴露）。修法：响应就绪闸门（dispatcher 首次 recv 前阻塞至主线程投递完成）。**与 v1.4 功能无因果，属测试基建修正**。
- 前端 dataset 打标防御化（测试桩/降级路径不抛错——S4 断链教训的同型应用）

## 六、量化验收（G2 主轴）——目标机待办

本环境无外网，**基线采集与复跑需在目标机执行**（PRD §4.3 已如实标注）：
1. 基线：v1.3.2 跑 3 条标准任务链（纯问答 / 单文件修改 / 多文件+命令）各 2 次取中位 → 归档 `deliverables/metrics/baseline-v13.2-*.md`
2. 复跑：v1.4.0 同环境同链对比
3. 硬门：总 token ≤ 基线 × 75%（-25%）/ cache 命中率 ≥60%（链②③）；stretch -30%
4. **不达门处理（裁决）**：打回继续优化，不为凑数字牺牲质量（Non-goal 5 防伪）
5. 冒烟六步：永久信任全流程 / 压缩卡片恢复原文 / 会话搜索跳转 / 导出 MD / MCP 超时配置生效 / 路由关闭降级

## 七、边界与风险（实现侧如实记录）

| 项 | 说明 |
|---|---|
| UX-1 备份存储 | 备份随新压缩覆盖（单份）；saveSessions 对 >30000 字符消息截断——恢复的是截断态（已知限制，卡片可感知 truncated） |
| UX-2 信任粒度 | op 级信任意味着「该 op 的所有目标」都不再确认——首次启用常驻 toast 明示，重置入口在设置面板 |
| TOK-1 双条件 | 依赖 GLM 返回缓存计价字段；自定义端点无该字段时退化为纯 token 阈值（行为不回退） |
| TOK-3 收紧反噬 | 与 UX-1 同批上线（可见可恢复）；基准链②③需实测轮次不升才收口（目标机） |
| F2 超时上限 | 300s + 前端 330s 总上限；R4 熔断按签名计数不受影响 |
| 量化门 | 本环境只能保证测试层全绿 + 协议就绪；硬门结论以目标机复跑为准（未达 → 按裁决打回） |

## 八、文件清单

**新增**：`frontend/src/32-session-search.js`、`frontend/src/33-set-nav.js`、`tests/test_v14_experience.py`、本报告
**后端（改）**：guard_service.py（trustedOps）、mcp_config_service.py（callTimeout 校验+透出）、mcp_service.py（读配置超时）
**前端（改）**：30/40/55/60/65/70/75/85/97-compact、100-send、26-guard、29-mcp、62-mcp-exec、18-toast、index.template.html
**版本**：VERSION 1.3.2 → 1.4.0
