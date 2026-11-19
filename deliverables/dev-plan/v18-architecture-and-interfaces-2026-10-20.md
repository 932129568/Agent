# Harbor v1.8.0「Agent 能力版」· 系统架构与接口契约

**日期**：2026-10-20 · **版本**：v1.0（待产品负责人审定）
**基线**：v1.7.0（701 passed / 契约 PASS）+ v1.8.0 迭代方案 + Agent 自主调研
**范围**：v1.8.0 三大能力（B 搜索 / S 软件 / H 协同）+ v1.8.5 权限地基（A1/A2）+ v1.9.0 接口预留位
**配套文档**：`design/v18/ux-flows.md`（交互流程）· `design/v18/motion-spec.md`（动效规范）· `design/v18/prototype.html`（可交互原型）

---

## 1. 总体架构（四层正交，延续 v1.6 沙箱哲学）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 前端（harbor.html 单文件 · 42+ 模块 · v4 设计系统）                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────────────┐ │
│  │ 63-search   │ │ 64-software │ │ 65-hybrid   │ │ 66-guard-grant(v1.8.5)│ │ │
│  │ 搜索面板    │ │ 软件面板    │ │ 混合路由UI  │ │ L2 授权/白名单管理     │ │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └───────────┬──────────┘ │
│         │  executeToolRaw 分发（25-tool-exec.js 新分支）        │            │
│  ┌──────▼──────────────────────────────────────────────────────▼────────┐ │
│  │ 60-agent-loop（工具循环） · build_tools(include_agent) · guard 前置    │ │
│  └──────┬──────────────────────────────────────────────────────┬────────┘ │
└─────────┼──────────────────────────────────────────────────────┼──────────┘
          │ js_api（_V12_EXTRA 隐身新增）                        │
┌─────────▼──────────────────────────────────────────────────────▼──────────┐
│ 后端（Python · main.py → api.py → services/）                              │
│  ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────────┐ │
│  │ B 搜索栈            │ │ S 软件栈           │ │ H 协同栈               │ │
│  │ search_service     │ │ software_service   │ │ hybrid_router          │ │
│  │ search_browser     │ │ + sandbox_service  │ │ + local_model_service  │ │
│  │ search_adapters    │ │   (run_in_sandbox) │ │ + validator(V1)        │ │
│  │ search_extract     │ │                    │ │                        │ │
│  └─────────┬──────────┘ └─────────┬──────────┘ └───────────┬────────────┘ │
│            │                      │                       │              │
│  ┌─────────▼──────────────────────▼───────────────────────▼────────────┐ │
│  │ 正交层：guard_service（三档+任务授权+白名单） · audit_log · 熔断(R4)  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

**分层原则**（不变）：路由层决定「谁来做」（hybrid_router）→ 工具层决定「做什么」（新工具面）→ 护栏层决定「要不要做」（guard_service）→ 沙箱层决定「能做多大」（sandbox_service）。任一层失效不架空其余层。

## 2. 模块划分（新增 + 接线点）

### 2.1 后端新增（`backend/services/`）

| 模块 | 文件 | 职责 | 依赖 |
|---|---|---|---|
| 搜索编排 | `search_service.py` | 检索式构造、缓存（TTL+URL 归一）、过滤去重排序、护栏挂点、审计（op=web_search）、人工接管状态机 | search_browser/adapters |
| 窗口通道 | `search_browser.py` | pywebview 次窗口生命周期（load_url/evaluate_js/加载事件/8s 看门狗）；**独立 WebView2 profile**（`~/.glm-chat/search_webview`）；禁 file:// 导航、禁下载；空闲 60s 回收 | pywebview（既有） |
| 引擎适配器 | `search_adapters.py` | 每引擎 URL 模板 + **纯函数提取器**（HTML 串 → `[{title,url,snippet,position,date}]`）；Bing/DuckDuckGo/Baidu/Google + generic 兜底 | 无（纯函数） |
| 正文提取 | `search_extract.py` | readability 风格主体提取（纯函数：去 script/style/nav、文本密度打分）+ 选择器覆盖 | 无（纯函数） |
| 软件注册表 | `software_service.py` | `~/.glm-chat/software.json`：内置预设+用户自定义；PATH/winreg 探测；`--version` 验身份；CLI 走沙箱、GUI 标题核验（FindWindowW）、URI 协议；参数 JSON Schema 校验+错误回显 | sandbox_service（既有） |
| 混合路由 | `hybrid_router.py` | 任务分类器（understand/validate/plan/compose）+ 三策略（auto/saver/quality）+ 5s/3s 硬预算 + 置信门 0.7 + 降级链 + 成本分账 | local_model_service（既有） |
| 结果校验 | `tool_validator.py` | validator 注册表 + 内置 6 类（文件存在/退出码语义/搜索非空+相关度/…）+ reformulate 重试循环 | 无 |
| 护栏扩展 | `guard_service.py`（改） | + 任务授权 grant 状态（进程内 + TTL）+ allow_rules 白名单 + scope 判定（工作区内/外）；判定顺序：deny → allow_rules → task_grant → op 档 → 弹窗 | 既有 |

### 2.2 前端新增（`frontend/src/`，按文件名序拼接）

| 模块 | 职责 | 新 DOM（纯新增，不碰契约 id） |
|---|---|---|
| `63-search-panel.js` | 搜索面板：结果列表/原文预览/人工接管/缓存来源标注 | `#searchPanel` `.sp-*` |
| `64-software-panel.js` | 设置「外部软件」区块：探测列表/状态灯/测试调用/自定义向导 | `#softwareBlock` `.sw-*` |
| `65-hybrid.js` | 混合路由配置 + 会话头部分账 chip + 路由指示点 | `#hybridBlock` `.hy-*` `#costSplit` |
| `66-guard-grant.js`（v1.8.5） | L2 授权指示灯/倒计时/收回按钮 + 白名单管理 | `#grantIndicator` `.gg-*` |
| `67-plan-card.js`（v1.9.0 预留） | 计划卡/todo/偏差暂停条 | `#planCard` `.pc-*` |
| `25-tool-exec.js`（改） | `executeToolRaw` 新分支：`browser_*`/`software_*` 分发 + token 透传 | — |
| `60-agent-loop.js`（改） | `build_tools(include_agent)` 传参 + 人工接管等待态 + 分账渲染 | — |

### 2.3 与既有系统的接线点（改动清单，全部向后兼容）

| 既有文件 | 改动 | 兼容性 |
|---|---|---|
| `backend/tools_schema.py` / `api.py:build_tools` | 新增 `include_agent=False` 可选参数；True 时追加 browser_*/software_* 两个工具定义 | 默认路径输出逐字节不变（契约差分天然通过） |
| `backend/api.py` | 新方法全部注册进 `_V12_EXTRA`（隐身） | `get_api_info` 输出零漂移 |
| `frontend/src/100-send.js` / `110-boot.js` | 新面板区块挂载 + 功能分级开关读取 | 纯新增 |
| `backend/services/guard_service.py` | 判定链插入 grant/rules 维度；既有三档语义与测试不变 | 旧 guard.json 无新键时行为=现行为 |
| `~/.glm-chat/` | 新增 `software.json` / `hybrid.json` / `search_cache/` / `checkpoints/`（v1.9.0） | config.json 零污染（铁律） |

## 3. 核心接口定义与数据契约

**通用约定**：所有新 js_api 经 `callApi(name, args)` 调用；返回 JSON 字符串；错误统一 `{ok:false, error:{code, message, hint?}}`；成功 `{ok:true, ...}`。所有方法**审计**（audit_log.jsonl，op 字段见各接口）。

### 3.1 B 组 · 浏览器搜索（v1.8.0）

#### `browser_search`

```jsonc
// 请求
{
  "query": "string（必填，1-500 字）",
  "engine": "bing|duckduckgo|baidu|google|custom（默认 bing）",
  "site": "string（可选，限定站点如 github.com）",
  "filetype": "string（可选：pdf|docx|md|…）",
  "time_range": "day|week|month|year（可选）",
  "lang": "zh|en（可选）",
  "max_results": "int 1-20（默认 10）",
  "extract": "none|snippet|full（默认 snippet）"
}
// 响应（成功）
{
  "ok": true,
  "query": "构造后的检索式（回显）",
  "engine": "bing",
  "source": "live|cache",                    // 缓存命中标注
  "fetched_at": "ISO8601",
  "results": [
    {"title": "string", "url": "string", "snippet": "string",
     "position": 1, "date": "string|null", "domain": "string"}
  ],
  "cached": false,
  "truncated": false                        // 超长已截断（toolcache）
}
// 响应（需人工接管）
{"ok": false, "error": {"code": "CAPTCHA_REQUIRED",
  "message": "搜索引擎要求人机验证", "hint": "请在面板中手动完成后点击继续",
  "takeover_id": "tk_xxx"}}
```

**错误码**：`ENGINE_UNREACHABLE`（窗口+urllib 双失败）· `CAPTCHA_REQUIRED`（验证页特征）· `TIMEOUT`（8s 看门狗）· `NAV_BLOCKED`（file:// 等禁导航）· `GUARD_DENIED`（护栏拦截）· `BAD_PARAMS`
**扩展点**：`custom` 引擎经 `search_adapters` 注册表追加（用户可配 URL 模板+选择器，v1.8.1）；`results[]` 每项预留 `extra` 对象（引擎特有字段）。

#### `browser_open`

```jsonc
// 请求 {"url": "string（必填，http/https）", "selector": "string（可选 CSS 选择器）", "max_chars": "int 500-50000（默认 8000）"}
// 响应 {"ok":true, "url":"...", "title":"...", "content":"正文（≤max_chars）",
//        "truncated":true, "full_ref":"toolcache:tc_xxx（read_more 取全文）",
//        "extractor":"readability|selector"}
```

**错误码**：`NAV_BLOCKED` · `TIMEOUT` · `EMPTY_CONTENT`（提取为空）· `SELECTOR_NOT_FOUND`

#### `search_cache_stats`

```jsonc
// 请求 {} → 响应 {"ok":true,"entries":12,"hits":34,"misses":40,"ttl_minutes":30,"size_kb":820}
```

### 3.2 S 组 · 外部软件调用（v1.8.0）

#### `software_list`

```jsonc
// 请求 {"status": "all|probed|missing（默认 all）"}
// 响应 {"ok":true,"software":[
//   {"name":"git","kind":"cli","status":"probed","version":"2.43.0",
//    "source":"preset|user","risk_default":"read",
//    "actions":[{"name":"status","risk":"read","arg_schema":{...}}]}
// ]}
// status: probed（已探测含版本）| missing（未安装）| version_mismatch | unknown（未探测）
```

#### `software_probe`

```jsonc
// 请求 {"name": "string（可选，缺省=全部）"}
// 响应 {"ok":true,"probed":[{"name":"git","status":"probed","version":"2.43.0"}],"elapsed_ms":340}
```

#### `software_call`

```jsonc
// 请求 {"software":"git","action":"commit","args":{"message":"fix: ..."},"timeout":60（仅 CLI，5-600）}
// 响应（成功）{"ok":true,"software":"git","action":"commit","kind":"cli",
//   "exit_code":0,"stdout":"...","stderr":"...","duration_ms":1230,
//   "sandboxed":true,"truncated":false,"full_ref":"toolcache:tc_xxx?"}
// 响应（GUI 类）{"ok":true,"kind":"gui","launched":true,"window_verified":true,"window_title":"..."}
// 响应（URI 类）{"ok":true,"kind":"uri","protocol":"..."}
// 响应（参数校验失败→Agent 自校正）{"ok":false,"error":{"code":"SCHEMA_INVALID",
//   "message":"参数校验失败","violations":[{"path":"message","expect":"string(必填)"}],
//   "example":{"message":"fix: 描述"}}}
```

**错误码**：`NOT_INSTALLED`（含官网引导 hint）· `TIMEOUT`（已清剿进程树）· `NONZERO_EXIT`（stderr 人话映射+原始尾段）· `GUI_UNCONFIRMED`（FindWindowW 超时，提示 UAC/杀软）· `SCHEMA_INVALID`（自校正回显）· `GUARD_DENIED` · `IDENTITY_MISMATCH`（`--version` 验名失败，防同名假冒）
**护栏映射**：action.risk=read→session 档；mutate→session+审计；dangerous→always 强制确认（可挂 L2 任务授权，见 3.4）。

### 3.3 H 组 · 混合路由（v1.8.0）

#### `hybrid_get_config` / `hybrid_save_config`

```jsonc
// 请求（save）{"strategy":"auto|saver|quality","local_budget_understand_s":5,
//   "local_budget_validate_s":3,"confidence_gate":0.7,"cost_split_display":true}
// 响应 {"ok":true,"config":{...同请求...}}   // 读写 ~/.glm-chat/hybrid.json（独立文件）
```

**响应（get 失败时）**：`{ok:true, config:{...默认值...}, source:"default"}`——配置文件缺失返回默认而非报错（首启零配置可用）。

**前端触点**：`65-hybrid.js` 配置 UI + 会话头部 `#costSplit` chip（`本地 X tok · 云端 Y tok · 省 ≈¥Z`，来源 `60-agent-loop.js` 的 usage 累积分账）。

### 3.4 A 组 · 任务授权与白名单（v1.8.5）

#### `guard_task_grant` / `guard_task_revoke` / `guard_task_status`

```jsonc
// grant 请求 {"scope":"workspace_write+exec（位掩码或枚举数组）","ttl_seconds":7200（默认，≤86400）}
// grant 响应 {"ok":true,"grant_id":"g_xxx","expires_at":"ISO8601","scope":[...]}
// revoke 请求 {"grant_id":"string（可选，缺省=当前）"} → {"ok":true}
// status 响应 {"ok":true,"active":true,"grant_id":"g_xxx","expires_at":"...",
//   "remaining_s":5432,"scope":[...],"granted_by":"user"}
```

**语义**（铁律）：grant=提权不是免检——deny 清单（工作区外写/提权/凭证外传/永久删除关键路径/guard off）**先于** grant 生效；授权内操作审计记 `decision=grant`；TTL 到期自动失效；前端 `#grantIndicator` 常驻倒计时。

#### `guard_rule_list` / `guard_rule_add` / `guard_rule_remove`（L4 白名单）

```jsonc
// add 请求 {"op_pattern":"run_command","detail_pattern":"^git (status|diff|log)",
//   "note":"日常只读 git（第 3 次批准时一键升级）"}
// add 响应 {"ok":true,"rule_id":"r_xxx","warn":"detail 含写动词，确认宽模式规则？"}
// list 响应 {"ok":true,"rules":[{"rule_id":"r_xxx","op_pattern":"...","detail_pattern":"...",
//   "hits":7,"created_at":"...","note":"..."}]}
```

**语义**：窄规则 > 松模式（Safeguard 原则）；deny 清单覆盖的规则创建时即拒；规则命中审计记 `decision=rule`；删除即时生效。

### 3.5 v1.9.0 接口预留位（本期只占位不实现，保扩展性）

| 预留方法 | 用途 | 预留策略 |
|---|---|---|
| `plan_create` / `plan_update` / `plan_get` | Plan-Act 计划 CRUD | 方法名注册进 `_V12_EXTRA` 时间与 v1.9.0 对齐；前端 `67-plan-card.js` DOM 本期预留容器 |
| `clarify_respond` | 批量澄清表单回传 | clarify 伪工具的 LLM 侧协议本期定稿（工具定义进 include_agent 的 schema 预留） |
| `checkpoint_create` / `checkpoint_rollback` / `checkpoint_list` | 检查点与回滚 | `~/.glm-chat/checkpoints/` 目录约定本期写入文档 |

## 4. 前后端联调计划

### 4.1 并行开发边界（契约即边界）

```
                    ┌─ 后端：接口契约（§3）+ fixtures（引擎 HTML/文章页）
                    │   可独立开发：纯函数（adapters/extract/validator）本环境全绿
  契约冻结（T0）────┤
                    │   前端：Mock 层（§4.3）+ 面板/动效原型
                    └─ 联调：契约差分 + vm harness + CDP 真机冒烟
```

**T0 契约冻结**：§3 接口定义评审通过后，前后端按契约并行；变更必须走「契约变更单」（双方确认 + 版本号递增），禁止私改。

### 4.2 接口状态管理（前端）

- 每域一个状态模块（`63-search-panel`/`64-software`/`65-hybrid`/`66-guard-grant`）：本地状态对象 + 单一 refresh 入口（boot/事件/操作后三处调用，与 `refreshWsCard` 同模式）。
- **请求态**：所有 js_api 调用统一 `pending/success/error` 三态 + 请求序号 last-wins（防竞态，沿用 connect 识别同款）；长任务（搜索/软件调用）走「阶段文案 + 进度」可见等待（动效规范 §2）。
- **事件流**：后端推送无 WebSocket——用「轮询 + 事件钩子」：搜索面板打开时 1s 轮询 takeover 状态；分账 chip 在 usage 到达时刷新（既有 usage 事件延长）。

### 4.3 Mock 策略（三层）

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单测（本环境全绿） | 引擎适配器/正文提取=**纯函数**→ fixture HTML（Bing/DDG/百度/文章页各 1-2 个）；schema 校验/错误人话映射/路由决策矩阵/降级时序（mock 本地端点）/validator 六类/guard grant-rules 判定链 | B/S/H/V/A 全部逻辑面 |
| 前端 harness | vm 沙箱（既有 test_v13_qa 模式）测 `executeToolRaw` 新分支 + **Mock js_api**（`window.pywebview.api` 桩：预置响应+延迟+错误注入）测面板状态机/倒计时/接管流 | 全部前端模块 |
| 契约门 | `build_tools` 默认路径逐字节 + `get_api_info` + config.json 不污染 + `check_contract.py`（UI 契约只增不改） | 每次构建 |

**Mock 数据**：`tests/fixtures/v18/`（引擎结果页 HTML ×4、文章页 ×2、软件探测响应 ×3、本地端点降级时序脚本 ×1）——fixture 即契约的一部分，随契约变更单更新。

### 4.4 测试要点（联调验收清单）

1. **契约差分**：新方法全进 `_V12_EXTRA`；`build_tools(role)` 默认输出与 legacy 逐字节一致；`build_tools(role, include_agent=True)` 增量仅含 browser_*/software_* 两个工具。
2. **UI 契约**：新 DOM id/class 纯新增；40 id/13 onclick/43 callApi/39 类/21 变量零改动。
3. **真机冒烟**（目标机，本环境无显示设备）：① Bing 搜索三步（查询→提取→深度打开）② 反爬人工接管 ③ git/ffmpeg 真实调用（CLI+GUI）④ Ollama 协同全链（理解→执行→校验→分账）⑤ 降级：拔本地端点 ⑥ L2 授权全周期（授予→自动放行→越界仍拦→收回）⑦ 白名单「第 3 次批准升级为规则」。
4. **降级矩阵**：fx-off / prefers-reduced-motion 下全部新动效瞬时化且功能完整。

### 4.5 里程碑对齐（与迭代方案 W1-W5 一致）

| 周 | 后端 | 前端 | 联调门 |
|---|---|---|---|
| W1-W2 | B1 搜索核心（adapters/service/browser）+ fixtures | 63-search-panel + Mock + 动效 | 契约差分 + vm harness |
| W3 | S1/S2 软件栈 | 64-software-panel | 同上 |
| W3-W4 | H1/H2 协同 + V1 校验 + C1 缓存 | 65-hybrid + 分账 chip + U1 接管 | CDP 冒烟①-⑤ |
| W5（v1.8.5） | A1/A2 guard 扩展 | 66-guard-grant + 白名单 UI | CDP 冒烟⑥⑦ |
| W5 末 | 回归 + 发布 | — | 全量 688+ 测试网 + 契约门 |

## 5. 平滑演进方案（零破坏性变更）

| 红线 | 保障措施 |
|---|---|
| js_api 契约零变更 | 新方法全注册 `_V12_EXTRA`（MCP/本地模型同款先例）；`get_api_info` 输出逐字节不变；v1.9.0 预留位注册时间与实现对齐 |
| build_tools 逐字节 | `include_agent=False` 默认参数（`include_mcp` 同款先例）；契约差分测试天然通过 |
| config.json 零污染 | `software.json`/`hybrid.json`/`search_cache/`/`checkpoints/` 全部独立文件；guard.json 仅**追加**新键（`task_grants` 运行时态不入库、`allow_rules` 用户显式创建才写） |
| UI 契约只增不改 | 新面板/新 class 纯新增；既有 40 id/13 onclick/43 callApi/39 类/21 变量零改动；设置面板新增区块进 set-grid（连接块同款模式） |
| guard 语义不回退 | 三档（always/session/off）判定语义与既有测试零迁移；grant/rules 是**新增维度**，判定链 `deny → allow_rules → task_grant → op 档 → 弹窗`，旧配置（无新键）行为=现行为 |
| 行为兼容 | 功能分级开关（设置可单独关搜索/软件/混合，默认开）；GLM 端点仍走内置 web_search（双通道并存按端点自动选）；混合路由默认 `auto` 但本地不可用时静默降级=现行为 |
| 数据兼容 | 旧 `~/.glm-chat/` 无 software.json/hybrid.json → 首启用默认值生成；检查点目录 v1.9.0 才创建 |
| 版本策略 | APP_VERSION 1.7.0→1.8.0（v1.8.5 小版本号 1.8.5）；API_VERSION 契约版本不动 |

## 6. 风险与未决项（继承自源文档）

- R1 反爬（引擎容忍度排序+接管+GLM 双通道）· R2 WebView2 时序（选择器轮询+urllib 兜底）· R3 本地幻觉参数（schema 硬校验+置信门+高危 always）· R4 工具稀释（分级开关）· R5 软件假冒（--version 验身份）。
- 待产品负责人裁决（源文档 §13 + §11 共 7 问）：默认引擎 Bing、software_call 默认档位、混合默认 auto、版本合发/拆分、A1/A2 提前插 v1.8.5、L2 TTL 2h vs 任务生命周期、检查点保留策略。

---

> 本文档由主理人基于两份源文档汇编；UX 流程见 `design/v18/ux-flows.md`，动效规范见 `design/v18/motion-spec.md`，可交互原型见 `design/v18/prototype.html`（筑原型施工中）。
