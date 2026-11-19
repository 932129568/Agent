# GLM-Chat v1.2「信任版」开发交付报告

**日期**：2026-10-15
**范围**：v1.2.0 安全批（R2/R3/R4）+ v1.2.1 体验批（R1/R5）+ v1.2.2 开放批（R6）——按用户要求「看完报告一起做完」一次性交付
**输入文档**：PRD v1.2（R1–R6 / 45 人日）、路线图三批发布策略、竞品分析、v1.1 重构交付报告、QA 回归报告、UI 设计交付索引
**规划文档**：`architecture-and-tasks-v1.2-2026-10-15.md`（同目录）

---

## 📌 TL;DR

- **六项需求全部落地**：R2 护栏拉齐 / R3 通知体系 / R4 成本防御 / R1 自动更新 / R5 成本透明 / R6 多模型。
- **测试 62 passed**（既有契约差分 + 安全测试 31 项零回归，新增 v1.2 功能测试 31 项）；UI 契约校验 PASS；前端构建成功（32 模块）。
- **契约红线守住**：`get_api_info` 输出与 legacy 逐字节一致（新方法 `_V12_EXTRA` 隐身），50 个 js_api 契约零变更，41 DOM id / 43 callApi / 39 CSS 类 / 21 主题变量全保住。
- **遗留人工项**：装机环境起窗冒烟、exe 打包冒烟、DeepSeek 真实端点联调（本环境无 webview/PIL/外网）。

---

## 1. 需求实现矩阵（PRD §6 验收标准 → 实现 → 测试）

| 需求 | 实现要点 | 验收依据 | 测试 |
|---|---|---|---|
| **R2 护栏拉齐** | `guard_service`：delete/kill/剪贴板读写/截屏五操作三档矩阵（每次确认/仅保护名单/会话内首次确认/不拦截），保护名单 fnmatch 通配（`C:\Users\*\Documents\**`），前端拦截 + 后端 `Api.delete_path/kill_process` 双重 enforce，审计日志 `audit_log.jsonl`；RunDeduper 修复 `rem `/`:: ` 前缀变体绕过 | 拒绝时向 Agent 返回原因、保护名单直接阻断、第 2 条相同命令（含 rem 变体）即拦截 | `TestGuardService` 18 项 + `TestRunDeduperRemPrefix` 5 项 |
| **R3 通知体系** | `18-toast.js`：toast 三态（ok/warn/err）分离、队列上限 5 条不重叠、可手动关闭、错误可展开明细；uiConfirm/uiPrompt 取代全部 alert/confirm（14 处）；静默吞错升级为 toast 可见（配置保存/会话保存/附件读取/解压等） | 工具失败不再静默、连续通知不重叠、破坏性场景走 R2 确认框 | 构建产物函数存在性 + 契约校验 |
| **R4 成本防御** | `36-cost-defense.js`：每轮 fetch 前预算硬停检查点（Q2 采纳语义：停止发起新请求，进行中跑完即停）；同工具同参数 ×3 / 交替模式 / 连续 15 步无进展三维熔断；暂停面板三选项（提高预算断点续跑 / 终止会话保留上下文 / 只读模式继续） | 预算触达后调用被阻断且显示已花费/预算；第 3 次循环调用暂停并高亮序列；恢复不重复扣费（断点在消息流） | 函数存在性 + 契约校验；端到端需真机走查 |
| **R1 自动更新** | `update_service`：manifest 拉取 + 版本比对（APP_VERSION=1.2.2 与契约版本号分离）；后台线程下载 + SHA256 校验（失败删产物保旧版）；进度轮询；`.bat` 辅助脚本自替换（等旧进程退出→备份 .bak→替换→拉起新版，失败自动回滚）；前端 pill 提示 + 更新说明弹窗 | 有新版才提示；校验失败保留旧版可重试；重启后版本号变化 | `TestUpdateService` 7 项（含篡改 payload 场景） |
| **R5 成本透明化** | `75-token-stat` calcUsage 三价细分（标准/缓存/输出）；会话头部「本会话约花费 ¥X」每轮 1 秒内更新；输入框聚焦/输入刷新发送前预估区间；1113/401/403/404/429/网络错误人话映射（含可行操作） | 花费与 token 统计同口径；发送前显示预估；1113 不再裸奔 | 函数存在性 + 契约校验 |
| **R6 多模型** | `71-provider.js` + `provider_service`：GLM 默认，opt-in 自定义 OpenAI 兼容端点（DeepSeek 预设）；端点测试走后端 urllib（规避跨域）；thinking/reasoning_effort/web_search 仅 GLM 端点发送；计费按配置价格 + usage 字段适配 | 测试连接失败有明确原因；切端点计费正确；契约差分零变更 | `TestProviderService` 6 项 + 契约差分 |

---

## 2. 变更清单

### 新增后端（3 个 service）
- `backend/services/guard_service.py`（197 行）：确认矩阵/保护名单/审计日志
- `backend/services/update_service.py`（211 行）：APP_VERSION 1.2.2 + 检查/下载/自替换
- `backend/services/provider_service.py`（92 行）：端点测试 + HTTP 错误人话映射

### 修改后端（3 个文件）
- `api.py`：装配三 service；`delete_path/kill_process` 前置保护名单 enforce；新增 9 个 js_api 方法；`get_api_info` 按 `_V12_EXTRA` 过滤保证契约输出零漂移
- `cmd_service.py`：`subprocess_norm` 补 `rem `/`:: ` 前缀剥离（堵去重绕过）
- 其余 service 零改动

### 新增前端（6 个模块）
`18-toast.js` / `26-guard.js` / `27-update.js` / `36-cost-defense.js` / `71-provider.js` / `76-cost-estimate.js`

### 修改前端（9 个文件）
`00-state.js`（新状态）、`25-tool-exec.js`（护栏挂点）、`45-request-debounce.js`（端点解析）、`60-agent-loop.js`（R4 检查点/熔断/R6 字段剥离/R5 错误人话与花费）、`65-session-store.js`+`70-config.js`（吞错 toast/配置键）、`75-token-stat.js`（三价细分）、`85-session-mgmt.js`+`100-send.js`+`110-boot.js`+`90-attachments.js`（alert/confirm → toast/uiConfirm、provider/护栏装载、更新检查、预估监听）、`index.template.html`（安全护栏/模型服务商/软件更新区块 + 新样式，纯新增）

### 新增测试
`tests/test_v12_features.py`（31 项：护栏 18 + 去重修复 5 + 更新 7 + provider 6 + 契约隐身 1）

---

## 3. 验收门（DoD）执行结果

| 门 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `pytest tests/ -q` | **62 passed**（契约差分 legacy vs new 逐字节一致） |
| 前端构建 | `node frontend/build.js` | 32 模块 → glm-chat.html，幂等 |
| UI 契约 | `check_contract.py` | **PASS**（40 id / 13 onclick / 43 callApi / 39 类 / 21 变量） |
| 契约隐身 | `TestApiInfoHidesV12Methods` | 9 个新方法不在 methods 清单但全部可调用 |
| 模块编译 | tests 全量 import backend | PASS |

---

## 4. 遗留人工项（本环境无法覆盖）

1. **装机冒烟**：`python main.py` 起窗 → 设置 Key → 发消息 → 走文件/命令/剪屏/剪贴板工具 → 确认删除/kill 弹窗 → 触发预算熔断。
2. **exe 打包冒烟**：PyInstaller 原命令打包；自更新链路（下载→校验→替换→重启）需真实发布 manifest 实测；杀软可能误报 .bat 替换脚本（已在设计文档预警，发布说明需提示）。
3. **DeepSeek 联调**（PRD Q4）：`test_provider_endpoint` 已就绪，真实端点连通性与工具调用兼容性需有网环境验证；若不达预期，R6 的降级路径（仅 provider 抽象、接入顺延）已由 PRD 批准。
4. **默认档位用研验证**（PRD Q3）：当前默认 delete/kill/clipboard_write=每次确认、clipboard_read/screenshot=会话内首次确认，均可在设置中调整。

---

## 5. 与 PRD 待确认问题的落地口径

- Q1 更新源：manifest 地址可配置（设置 → 软件更新），默认 GitHub Releases；自建源只改地址即可。
- Q2 硬停语义：采纳「停止发起新请求，进行中跑完即停」（检查点位于 fetch 前）。
- Q3 确认粒度：三档全量可配 + 「本会话内不再提示」勾选（平衡弹窗疲劳）。
- Q4 DeepSeek：预设已内置（deepseek-v4.1-256k + 价格占位），联调退路见遗留项 3。
- Q5 遥测：v1.2 不做（Non-goals 未动）。
- Q6 审计日志：按内嵌口径落地（guard_check/决策入 audit_log.jsonl），未单列查看器（v1.3 候选）。

---

> 本报告由软件工坊主理人生成；装机/exe 冒烟与 DeepSeek 联调待工程负责人在目标环境执行。
