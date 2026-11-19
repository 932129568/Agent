# GLM-Chat v1.2「信任版」开发架构规划与任务分工

**日期**：2026-10-15
**输入**：PRD v1.2（R1–R6，45 人日）、路线图（三批发布）、竞品分析、v1.1 重构交付报告、QA 回归报告、UI 设计交付索引
**范围**：v1.2.0 安全批（R2/R3/R4）+ v1.2.1 体验批（R1/R5）+ v1.2.2 开放批（R6）一次性完成
**版本目标号**：APP_VERSION = 1.2.2（js_api 契约版本号 `v1.0.0` 保持不变，理由见 §2.1）

---

## 1. 现有架构基线（v1.1 重构后）

```
main.py                 薄入口（装配 + 启动，<60 行，import 无副作用）
backend/
  api.py                Api 门面：50 个 js_api 公开方法（契约层，逐字保持 v1.0.0）
  runtime.py            RuntimeState：win/current_sid/ws_enabled 唯一所有者（带锁）
  paths.py              ~/.glm-chat 路径常量 + frozen 适配
  errors.py / logging_setup.py
  tools_schema.py       工具 schema 唯一数据源
  services/             8 个 service（config/file/cmd/clipboard/process/screenshot/toolcache/workspace）
frontend/
  index.template.html   骨架 + CSS（41 DOM id / 39 CSS 类 / 21 主题变量 契约）
  src/*.js              24 个模块（按文件名前导数字保序拼接）
  build.js              零依赖构建 → 根目录 glm-chat.html
tests/                  契约差分（legacy vs new 逐字节）+ 安全修复测试，31 passed
```

**三条不可逾越的红线**（来自 PRD §8 + QA 报告）：
1. 50 个 js_api 契约零变更——`pytest tests/test_api_contract.py` 是发布门。
2. 前端 41 DOM id / 43 callApi 点 / onclick 函数 / CSS 类 / 主题变量必须存在（`check_contract.py`），新增允许，删改禁止。
3. 写操作串行规则与 system prompt 硬规则文案不得破坏。

---

## 2. v1.2 总体架构设计

### 2.1 新增模块与「契约隐身」机制

新增 js_api 方法必须对 `get_api_info()` 的方法清单**隐身**——该方法输出与 legacy 逐字节比对（契约测试），故新方法列入类级排除集 `_V12_EXTRA`，`get_api_info` 自省时过滤。pywebview 桥接照常暴露新方法（桥接按属性枚举，不受该方法清单影响），前端 `backendWarning` 检查用的 `need` 清单不变。

应用版本号与契约版本号分离：`API_VERSION='v1.0.0'`（get_api_info 输出，动不得）；新增 `APP_VERSION='1.2.2'`（自动更新比对用，位于 update_service）。

### 2.2 模块挂点图（R2/R4/R5 共用「工具调用前检查」挂点）

```
前端 Agent 主循环（60-agent-loop.js）
  ├─ 每轮 fetch 前 ──→ R4 预算硬停检查点（checkCostDefenses）
  ├─ 工具调用前 ──→ R2 确认矩阵（guardCheckTool → 后端 guard_check → 确认框/阻断）
  ├─ 工具调用后 ──→ R4 循环检测（同工具同参数 ×3 熔断 / 15 步无进展熔断）
  └─ usage 返回 ──→ R5 实时花费（calcUsage 细分三价）+ 预估
后端 Api 门面
  ├─ delete_path / kill_process ──→ R2 保护名单后端强制执行（guard.enforce）
  └─ 新增：guard_* / update_* / test_provider_endpoint（_V12_EXTRA 隐身）
```

### 2.3 新增后端文件

| 文件 | 职责 | 需求 |
|---|---|---|
| `backend/services/guard_service.py` | 确认矩阵配置（~/.glm-chat/guard.json，独立文件避免污染 config.json 契约）、保护名单匹配（fnmatch 通配）、guard_check 三档判定、审计日志 audit_log.jsonl | R2 |
| `backend/services/update_service.py` | APP_VERSION、check_update（manifest 拉取+版本比对）、start_update_download（后台线程+SHA256 校验）、get_update_progress、apply_update（onefile 自替换 .bat 辅助脚本：等待旧进程退出→替换→重启） | R1 |
| `backend/services/provider_service.py` | test_provider_endpoint（OpenAI 兼容端点连通性测试，urllib 后端发请求避免 CORS）；端点配置本体存 config.json 新增键（save_config 合并逻辑已支持） | R6 |

**修改的后端文件**：`api.py`（新增 9 个方法 + `_V12_EXTRA` 过滤 + delete_path/kill_process 前置 enforce）、`cmd_service.py`（RunDeduper 归一化补 `rem `/`:: ` 前缀剥离，堵前缀变体绕过）。

### 2.4 新增/修改前端文件

| 文件 | 动作 | 职责 | 需求 |
|---|---|---|---|
| `src/18-toast.js` | 新增 | toast 组件（ok/warn/err 三态、队列不重叠、手动关闭）+ uiConfirm/uiPrompt 模态（alert/confirm 的替代品，R2 确认框的载体） | R3+R2 |
| `src/26-guard.js` | 新增 | guardCheckTool 拦截器（delete_path/kill_process/clipboard_write/clipboard_read/take_screenshot 五操作）、会话级信任集合、护栏设置 UI 绑定 | R2 |
| `src/27-update.js` | 新增 | 启动检查更新、版本 pill、下载进度、重启确认 | R1 |
| `src/36-cost-defense.js` | 新增 | checkCostDefenses（预算硬停）、循环熔断（sig 计数 ≥3、15 步无进展）、暂停面板（提高预算/终止/只读继续 三选项） | R4 |
| `src/76-cost-estimate.js` | 新增 | 发送前预估费用、1113 等错误码人话映射 humanizeApiError | R5 |
| `src/71-provider.js` | 新增 | resolveApiEndpoint（GLM 默认 / 自定义端点）、provider 设置 UI、价格表扩展 | R6 |
| `src/25-tool-exec.js` | 修改 | executeToolRaw 头部接 guardCheckTool | R2 |
| `src/45-request-debounce.js` | 修改 | API_URL → resolveApiEndpoint() | R6 |
| `src/60-agent-loop.js` | 修改 | fetch 前硬停检查点；工具后熔断检测；错误走 humanizeApiError；web_search/thinking 仅 GLM 端点发送 | R4/R5/R6 |
| `src/75-token-stat.js` | 修改 | calcUsage 返回标准输入/缓存/输出三价细分；liveTokenStat 显示「本会话约花费 ¥X」 | R5 |
| `src/00-state.js` | 修改 | guardTrusted 集合等新状态 | R2 |
| `src/70-config.js` | 修改 | collectConfig 纳入 provider/guard/update 配置键 | R6 |
| `src/85/100/110` 等 | 修改 | alert/confirm 全部替换为 toast/uiConfirm | R3 |
| `index.template.html` | 修改 | 设置面板新增「安全护栏」「模型服务商」「软件更新」区块；toast/modal/暂停面板/更新 pill 的 CSS（纯新增） | 全部 |

### 2.5 关键流程落点（与 PRD §7 对齐）

- **7.1 破坏性确认**：前端拦截 → `guard_check(op, detail)` 返回 `allow/confirm/block` → confirm 时 uiConfirm 弹窗（含操作类型/完整路径/影响面 + 「本会话不再提示」勾选）→ 拒绝则向 Agent 返回 `{info:'用户拒绝…', skipped:true}`；block（保护名单）前后端双重执行（后端 enforce 在 Api.delete_path/kill_process 内，即使前端被绕过也拦得住）。审计：每次判定/决策追加 `~/.glm-chat/audit_log.jsonl`。
- **7.2 预算熔断**：硬停语义采用 PRD Q2 建议的「停止发起新请求，进行中的工具调用跑完即停」——检查点位于每轮 fetch 之前。三选项：提高预算（uiPrompt 输入新额度→断点续跑）/ 终止会话（保留上下文）/ 只读模式继续（切 toolMode=readonly 续跑）。
- **7.3 自动更新**：启动后台 check → 有新版 header pill 轻提示 → 点击下载（后台线程+SHA256，进度轮询）→ 校验失败保留旧版可重试 → 成功后确认重启 → apply_update 写 .bat（等 pid 退出→替换 exe→拉起新版）。

### 2.6 Non-goals 落实（本次不做）

多模态/GLM-6V、macOS、MCP、账号体系、云同步、插件市场、遥测（v1.3）、浏览器 Agent。

---

## 3. 任务分工（软件公司角色 × 需求）

| 角色 | 批次/任务 | 交付物 | 验收（DoD） |
|---|---|---|---|
| **架构师** | W0 | 本文档；`_V12_EXTRA` 契约隐身机制设计 | 契约差分测试通过（get_api_info 输出零漂移） |
| **后端 A（安全）** | v1.2.0 | guard_service.py（三档矩阵/保护名单/审计）、cmd_service rem 绕过修复、Api enforce 挂点 | PRD R2 三条 Given/When/Then 全过 |
| **前端 A（安全+通知）** | v1.2.0 | 18-toast.js、26-guard.js、25 拦截、alert/confirm 替换、吞错 toast | PRD R2/R3 验收标准全过；toast 三态不重叠 |
| **前端 B（成本）** | v1.2.0+体验批 | 36-cost-defense.js、60-agent-loop 检查点、75 三价细分、76 预估+1113 人话 | PRD R4/R5 验收标准全过 |
| **后端 B（分发+开放）** | 体验批+开放批 | update_service.py（含自替换脚本）、provider_service.py、45/71 端点切换 | PRD R1/R6 验收标准全过 |
| **QA** | 各批发布门 | tests/test_v12_features.py（guard/绕过修复/update/provider 全打桩）；pytest 全量；node build；check_contract.py | 契约差分 0 变更 + 新增测试全绿 |
| **技术写作** | 收尾 | 开发说明.txt v1.2 段落、交付报告 | — |

**依赖与顺序**：18-toast（确认框载体）→ 26-guard（R2）→ 36-cost-defense（R4，复用检查挂点）→ 27-update（R1，独立）→ 71/76（R5/R6）。后端三个 service 互相独立，可并行。

---

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 新方法破坏 get_api_info 契约 | `_V12_EXTRA` 过滤 + 契约差分测试为发布门 |
| guard.json 写入影响 config.json 契约比对 | 独立文件存储，config.json 一个字节不碰 |
| 自更新替换失败变砖 | .bat 前先备份旧 exe 为 .bak；校验失败不删旧版；发布说明提示杀软误报 |
| 非法端点 tool_calls 格式差异 | R6 保留 GLM 默认；自定义端点手动开启；thinking/web_search 仅 GLM 发送 |
| 确认弹窗疲劳（PRD Q3） | 默认档位：delete/kill=每次确认，剪贴板写=每次确认，剪贴板读/截屏=会话内首次确认；全部可配 |

---

## 5. 验收清单（本次交付的 DoD）

1. `pytest tests/ -q` 全绿（含既有 31 项契约/安全测试 + 新增 v1.2 测试）。
2. `node frontend/build.js` 构建成功且幂等。
3. `python deliverables/design/check_contract.py` 全过。
4. PRD §6 R1–R6 验收标准逐条走查（能自动化的一律自动化为 pytest 用例）。
5. 交付报告落盘 deliverables/dev-plan/。
