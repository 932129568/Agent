# Harbor v1.8.0「Agent 能力版」迭代方案

**日期**：2026-10-20
**类型**：功能迭代方案（设计 + 模块划分 + 关键流程 + 落地措施）
**基线**：v1.7.0（安装器 + 沙箱，701 passed / 契约 PASS）
**状态**：v1.0（待产品负责人审定；§13 四个待确认问题需裁决）

---

## 📌 TL;DR

- **一句话**：v1.8.0 给 Agent 装上三只新手——**浏览器精准搜索**（自有 WebView2 做受控检索，替代 GLM 专属 web_search 的黑盒）、**外部软件调用**（本地软件注册表 + 结构化调用 + 沙箱执行）、**本地大模型协同**（任务级路由：本地管理解/指令/校验，云端管推理/终稿）——全部零第三方依赖、契约零变更。
- **总盘子**：P0 三大能力 16.5 人日 + P1 配套 6 人日 + 回归 2 人日 ≈ **24.5 人日**；单人全职约 5 周 / 2 人并行约 3 周。P2（任务模板宏等）留 v1.8.1。
- **三个最关键的设计判断**：① 搜索用**应用自己的 WebView2**（pywebview 双窗口 + evaluate_js），不引 Selenium/CDP——零依赖且与产品同栈；提取器写成**纯函数解析器**（HTML 串 → 结构化结果），可用 fixture 单测、可 urllib 兜底；② 软件调用复用**沙箱（Job Object）**执行 CLI 类，GUI 类用窗口标题核验启动；③ 本地协同的核心是**职责边界 + 降级链**——本地任何阶段超时/失败都不得阻塞主流程，静默降级云端。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 版本主题 | 「Agent 能力版」：搜索（信息获取）× 软件（执行面扩展）× 本地协同（成本/时延优化） |
| P0（不可裁剪） | B1 浏览器搜索核心 / B2 深度提取 / S1 软件注册表+CLI 调用 / S2 GUI/URI 调用 / H1 混合路由核心 / H2 降级链与成本分账 |
| P1（尽力） | V1 结果校验框架 / C1 搜索缓存 / U1 搜索面板+人工接管 / S3 软件设置面板 |
| P2（顺延 v1.8.1） | T1 任务模板（宏）/ 软件预设库扩充 / 搜索面板历史时间线 |
| 量化目标 | 非 GLM 端点搜索可用率 100%（现为 0）；搜索 P50 延迟 ≤3s（缓存命中 ≤300ms）；软件调用错误人话覆盖率 100%；混合路由本地阶段时延预算 5s/3s，超时降级率可观测 |
| 风险等级 | 中高——搜索引擎反爬、WebView2 evaluate_js 时序、本地模型幻觉参数、新工具改变 Agent 行为 |

---

## 1. 现状与差距（代码库实测 2026-10-20）

| 现状 | 位置 | 差距 |
|---|---|---|
| `web_search` 工具**仅 GLM 端点可用**（`isGlmEndpoint()` 门禁），且是模型黑盒：Agent 无法控制检索式构造、无过滤、`search_result:false` 不落结构化结果 | `60-agent-loop.js:111` | DeepSeek/本地/GitHub Models 端点**零搜索能力**；GLM 端点也无精准控制 |
| `open_app`/`open_url` 是无结构启动器（打开即走，无参数 schema、无结果、无异常语义） | `api.py:389/427`、`tools_schema.py:91/95` | 无法表达「用 VLC 播放 X」「用 git 提交并告诉我结果」 |
| `local_model_service` 已有探测/元数据/阈值/错误分类全套函数 | `local_model_service.py` | 只解决了「连上」，没有「协同」——无任务路由、无职责边界、无校验闭环 |
| 工具分发集中在 `25-tool-exec.js` 的 `executeToolRaw`（name → callApi 映射），MCP 走 `mcp__` 前缀专门分支 | `25-tool-exec.js:98-133` | 新工具接入点清晰，但工具集进 LLM 的通道 `build_tools` **被契约逐字节钉死**——必须走可选参数模式（MCP 的 `include_mcp` 先例） |

---

## 2. 总体架构

```
                    ┌──────────────────────── 云端/本地模型（H1 混合路由）────────────────────────┐
                    │  本地模型：意图理解 · 检索式构造 · 参数填充 · 结果校验（低成本快响应）      │
                    │  云端模型：复杂推理 · 多步规划 · 终稿生成（高质量）                          │
                    └──────────────────────────────────┬─────────────────────────────────────────┘
                                                       │ 工具调用
        ┌──────────────────────┬───────────────────────┼───────────────────────┬──────────────────────┐
        ▼                      ▼                       ▼                       ▼                      ▼
┌───────────────┐   ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ B 浏览器搜索   │   │ S 外部软件调用   │   │ 既有工具面        │   │ MCP 工具面        │   │ V 结果校验框架    │
│ search_service│   │ software_service│   │ 文件/命令/截屏…   │   │ mcp__ 前缀        │   │ validator+重试    │
│ · 双窗口 WebView│  │ · 注册表+探测    │   │ （guard 护栏）    │   │ （分层护栏）       │   │ · 全工具面复用    │
│ · 引擎适配器    │   │ · cli 走沙箱     │   │                  │   │                  │   │                  │
│ · 纯度提取器    │   │ · gui 标题核验   │   │                  │   │                  │   │                  │
│ · 缓存+去重     │   │ · uri 协议       │   │                  │   │                  │   │                  │
└───────────────┘   └─────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
```

**分层原则**（延续 v1.6 沙箱的四层正交哲学）：路由层决定「谁来做」，工具层决定「做什么」，护栏层决定「要不要做」，沙箱层决定「能做多大」——任一层失效不架空其余层。

---

## 3. 能力一 · 浏览器精准搜索（B 组，6.5 人日）

### 3.1 功能设计

**为什么用自有 WebView2**：pywebview 本身就是 WebView2 窗口，支持多窗口 + `evaluate_js()`（在页面里跑 JS 并取回值）——等于免费获得一个可编程浏览器。对比方案：Selenium/Playwright（第三方依赖，违反铁律）、CDP 外接 Chrome（KNOWN_ISSUES #1 实证被安全软件拦截）、纯 urllib 抓取（JS 渲染页面拿不到内容）——**自研 WebView2 通道是唯一同时满足零依赖 + 动态渲染 + 可编程提取的路径**。

**工具定义**（经 `build_tools(role, include_agent=True)` 下发，默认路径契约不变）：

```json
{
  "name": "browser_search",
  "description": "受控浏览器搜索：构造检索式→打开搜索引擎→提取结构化结果。适用于需要最新信息/站内查找/多来源对比的场景",
  "parameters": {
    "query": "检索关键词（必填）",
    "engine": "bing|duckduckgo|baidu|google|custom（默认 bing）",
    "site": "限定站点如 github.com（可选）",
    "filetype": "pdf|docx|md…（可选）",
    "time_range": "day|week|month|year（可选）",
    "lang": "zh|en（可选）",
    "max_results": "1-20（默认 10）",
    "extract": "none|snippet|full——是否对 Top N 结果做正文深度提取（默认 snippet）"
  }
}
{
  "name": "browser_open",
  "description": "打开指定 URL 并按规则提取正文内容（readability 主体提取或 CSS 选择器）",
  "parameters": {"url": "目标地址", "selector": "CSS 选择器（可选，缺省走主体提取）", "max_chars": "500-50000（默认 8000）"}
}
```

### 3.2 模块划分

| 模块 | 文件 | 职责 |
|---|---|---|
| 搜索编排 | `backend/services/search_service.py` | 意图→检索式映射、URL 构造、窗口调度、结果过滤/去重/排序、缓存、护栏挂点、审计 |
| 窗口通道 | `backend/services/search_browser.py` | pywebview 次窗口生命周期（load_url / evaluate_js / 加载完成事件 / 超时看门狗）；**独立 WebView2 用户数据目录**（搜索 cookie 与应用数据隔离） |
| 引擎适配器 | `backend/services/search_adapters.py` | 每引擎的 URL 模板 + **纯函数提取器**（HTML 字符串 → `[{title,url,snippet,position,date}]`）；Bing/DuckDuckGo/Baidu/Google 四预设 + generic 兜底（schema.org/微数据启发式） |
| 正文提取 | `backend/services/search_extract.py` | readability 风格主体提取（纯函数：去 script/style/nav、按文本密度打分选主区）+ 用户选择器覆盖 |
| 前端面板 | `frontend/src/63-search-panel.js` | 搜索面板（结果列表/原文预览/人工接管按钮）；新 DOM id 纯新增 |
| js_api | `api.py` | `browser_search` / `browser_open` / `search_cache_stats`（隐身 `_V12_EXTRA`） |

### 3.3 关键流程

```
Agent 调用 browser_search(query, filters)
  └─> H1 本地模型：意图→参数校验/补全（query 改写、engine 选择建议）——失败则直接用 LLM 原参
       └─> search_service：
            ① 检索式构造：query + site:/filetype:/时间词 → 引擎 URL（适配器模板）
            ② 缓存命中？ → 直接返回结构化结果（≤300ms）
            ③ 窗口调度：次窗口 load_url → 轮询等待选择器出现（≤8s，抗 SPA）
             │     └─> 窗口不可用/超时 → urllib 抓 HTML 兜底（非 JS 引擎可用）
            ④ 提取：适配器纯函数解析 → 原始结果列表
            ⑤ 过滤与定位：域名黑白名单 / 日期解析 / 必含词 / 去重（URL 归一） / 相关性重排
            ⑥ extract=full？ → 对 Top N 逐个 browser_open 正文提取
            ⑦ V1 本地校验：结果非空？与 query 相关？→ 不通过则本地改写 query 重试（≤2 次）
            ⑧ 结构化 JSON（超长走 toolcache 截断）+ 缓存写入 + 审计（op=web_search）
```

**护栏与隐私**：`browser_search` 默认 session 档（会话首次确认，可调）；次窗口独立 profile（搜索站 cookie 不落应用数据目录）；窗口禁导航 file://、禁下载；全部外联走应用进程→审计可见（弥补沙箱网络隔离缺口，见 KNOWN_ISSUES §17）。

### 3.4 反爬与降级（诚实边界）

搜索引擎对自动化导航可能返回验证页——应对：优先选容忍度高的引擎（Bing/DuckDuckGo）；结果页检测「验证码特征」→ 明确错误 + **人工接管**（U1：面板弹出可见窗口让用户手动过验证后点「继续」）；GLM 端点场景仍可用内置 web_search（双通道并存，按端点自动选）。

---

## 4. 能力二 · 外部软件调用（S 组，4.5 人日）

### 4.1 功能设计

**工具定义**：

```json
{
  "name": "software_call",
  "description": "调用本机已安装的外部软件（CLI/GUI/URI 三类），参数经 schema 校验，执行受护栏与沙箱管辖",
  "parameters": {
    "software": "注册表中的软件名（如 ffmpeg/git/7z/notepad++）",
    "action": "软件支持的动作名（预设定义，如 convert/commit/extract/open）",
    "args": "按该软件 schema 填充的参数对象",
    "timeout": "仅 CLI 类有效，5-600s"
  }
}
```

### 4.2 模块划分

| 模块 | 文件 | 职责 |
|---|---|---|
| 注册表 | `backend/services/software_service.py` | `~/.glm-chat/software.json`：内置预设 + 用户自定义；条目 = {name, kind, exe 解析式, actions[{name, arg_schema, risk, cmd_template}], verify_cmd} |
| 探测 | 同上 | PATH 扫描 + `winreg` 卸载键/App Paths 探测常见安装位；CLI 类跑 `--version` 验证身份（防同名假冒）；状态：已探测/未安装/版本不符 |
| 执行 | 同上 + 沙箱 | cli → `sandbox_service.run_in_sandbox`（Job Object 收编 + 超时清剿）；gui → ShellExecute + `FindWindowW` 标题核验启动（ctypes 零依赖）；uri → 协议调用 |
| 前端 | `frontend/src/64-software-panel.js` | 设置面板「外部软件」区块：探测列表/状态灯/测试调用/自定义添加 |
| js_api | `api.py` | `software_list` / `software_call` / `software_probe`（隐身） |

### 4.3 参数传递与异常处理

**参数传递**：每个 action 带 JSON Schema（类型/必填/枚举/路径约束）；LLM 填充 → 后端校验 → 失败时返回**结构化错误 + schema 回显**（Agent 自校正，而非裸报错）；路径参数一律过工作区门禁 + realpath 归一（防 `..`/junction 越界，v1.3.1 S5 同款）。

**异常矩阵**：

| 异常 | 检测 | 处理 |
|---|---|---|
| 软件未安装 | 探测缺失 | 人话「未检测到 X，是否去官网下载？」+ 引导链接（不自动下载） |
| CLI 超时 | 沙箱看门狗 | 清剿进程树 + 「已终止，可调大 timeout 重试」 |
| 非零退出 | exit code | stderr 人话映射（git/ffmpeg 常见错误码表）+ 原始输出尾段 |
| GUI 启动未确认 | FindWindowW 超时 | 「已发起启动但未检测到窗口（可能被 UAC/杀软拦截）」 |
| 参数非法 | schema 校验 | 结构化错误 + 正确示例回显 |
| 高危动作 | risk 字段 | guard always 档强制确认（如 `git push`/`ffmpeg -y` 覆盖写/删除类） |

### 4.4 风险分级

预设按风险标注：read（`git status`、`ffprobe`）→ session 档；mutate（`git commit`、`ffmpeg 转换`）→ session 档 + 审计；dangerous（`git push --force`、删除类）→ always 档 + 强制确认。用户自定义软件默认按 mutate 起步，可在设置调整。

---

## 5. 能力三 · 本地大模型协同（H 组，5.5 人日）

### 5.1 职责边界（用户点名问题）

| 阶段 | 本地模型 | 云端模型 |
|---|---|---|
| 任务理解 | ✅ 主责：意图解析、检索式构造、软件参数填充（schema 约束输出） | 兜底：本地不可用/低置信时接管 |
| 指令生成 | ✅ 主责：工具参数补全、query 改写、重试策略生成 | 兜底 |
| 执行规划 | ❌ 不做（上下文窗口与推理深度不足） | ✅ 主责 |
| 结果校验 | ✅ 主责：相关性/完整性/幻觉筛查（结构化 verdict + 置信度） | 复核：本地低置信时云端二次校验 |
| 终稿生成 | 轻量摘要可用 | ✅ 主责 |

### 5.2 模块与路由策略

`backend/services/hybrid_router.py` + `frontend/src/65-hybrid.js`（配置 UI + 会话头部分账显示）：

- **任务分类器**：understand（意图/参数）/ validate（校验）/ plan（规划）/ compose（终稿）四类，工具调用附带隐式分类（browser_search 的 query 构造 = understand；结果审查 = validate）
- **路由策略**（`hybrid.json` 独立配置）：
  - `auto`（默认）：understand/validate → 本地（可用则）；plan/compose → 云端
  - `saver`（省 token）：全部本地优先，compose 按任务复杂度分档（简单问答也本地）
  - `quality`：全云端（现行为）
- **执行时序**：理解（本地，5s 预算）→ 执行（工具/云端）→ 校验（本地，3s 预算）→ 置信门（≥0.7 通过；否则云端复核或 reformulate 重试 ≤2）

### 5.3 性能/准确率/时延优化（用户点名问题）

| 维度 | 措施 |
|---|---|
| **时延** | 理解阶段 max_tokens 128–256（本地首 token 50–500ms）；Ollama `keep_alive` 常驻防冷启；校验与下一步**流水重叠**（上一工具结果校验时预取下一轮上下文）；本地阶段硬超时 5s/3s，**超时即降级云端，绝不阻塞主流程** |
| **准确率** | 结构化输出约束（JSON mode/grammar 提示 + schema 校验，失败重试 1 次）；每任务类 few-shot 模板；校验产 `verdict+confidence+reason` 结构化三元组；置信 <0.7 自动升级云端复核（防本地幻觉参数流入执行） |
| **性能** | 本地请求走连接复用（v1.5.1 连接池同款 http.client）；理解/校验请求与主对话**并行**（理解在用户发送时即启动）；本地 token 单独计量（¥0 但计入统计） |
| **可观测** | 会话头部「本地 X tok / 云端 Y tok / 省 ≈¥Z」分账；路由决策日志（哪个阶段走了哪端、为何降级）进 `~/.glm-chat/logs/` |

---

## 6. 自主补充功能（用户授权「自己想」）

| # | 功能 | 价值 | 优先级 |
|---|---|---|---|
| V1 | **结果校验框架**：全工具面复用——每个工具有对应 validator（写文件→存在性+大小、命令→退出码语义、搜索→非空+相关度），失败自动 reformulate 重试。H 组「结果校验」职责的工程载体，也让既有工具面受益 | 高 | P1 |
| C1 | **搜索/调用结果缓存**：同 query TTL 内直返（默认 30 分钟，可关）；URL 归一去重；缓存统计可见。省 token + 省时延 + 省引擎配额 | 高 | P1 |
| U1 | **搜索面板 + 人工接管**：Agent 搜索时面板实时显示（用户看得见 AI 在搜什么）；反爬验证时可手动过检后交还；信任特性 | 高 | P1 |
| S3 | **软件设置面板**：探测列表/状态/测试调用/自定义软件向导（填 exe + schema） | 中 | P1 |
| T1 | **任务模板（宏）**：把「搜索→提取→保存 MD」类工具序列存为可复用模板，历史会话一键保存 | 中 | P2（v1.8.1） |
| — | 软件预设库扩充（Office/IDE/压缩/媒体 20+ 预设） | 中 | P2 |

---

## 7. 任务表（优先级/工作量/依赖/验收）

### P0（16.5 人日）

| # | 任务 | 工作量 | 依赖 | 验收标准 |
|---|---|---|---|---|
| B1 | 搜索核心：search_service + search_browser 双窗口通道 + 4 引擎适配器（纯度提取器）+ URL 构造 + 过滤去重 + `browser_search` js_api + `include_agent` 工具通道 | 4.0 | — | Given Bing 适配器 fixture HTML，When 解析，Then 提取 ≥10 条含 title/url/snippet 且单测通过；Given 非 GLM 端点，When Agent 搜索，Then 走自有通道返回结构化结果；契约差分（build_tools 默认路径逐字节）通过 |
| B2 | 深度提取：browser_open + readability 主体提取 + 选择器覆盖 + toolcache 截断 | 2.5 | B1 | Given 文章页 HTML fixture，When 提取，Then 主体文本完整（去导航/广告）；Given max_chars=500，When 提取，Then 截断落盘可 read_more |
| S1 | 软件注册表 + 探测（PATH/winreg/--version 验证）+ CLI 调用（沙箱执行 + 结果捕获 + 错误人话） | 2.5 | 沙箱（已具备） | Given 预置 git，When 探测，Then 状态=已探测且版本正确；Given `git status` 调用，When 执行，Then 结构化返回 exit/stdout；Given 未安装软件，When 调用，Then 人话未安装引导 |
| S2 | GUI/URI 调用 + 窗口标题核验 + UAC/异常矩阵 + 参数 schema 校验与自校正回显 | 2.0 | S1 | Given GUI 类预设（如 notepad++ 开文件），When 调用，Then FindWindowW 确认窗口出现；Given 参数缺必填项，When 调用，Then 返回结构化错误+schema 示例 |
| H1 | 混合路由：任务分类器 + 三策略 + 本地理解/校验调用 + 置信门 + `hybrid.json` 配置 | 3.5 | local_model_service（已具备） | Given saver 策略+本地可用，When 简单问答，Then 全程本地零云端调用；Given 本地校验置信 0.4，When 校验搜索结果的，Then 升级云端复核 |
| H2 | 降级链 + 时延预算 + 并行流水 + 成本分账显示 + 路由日志 | 2.0 | H1 | Given 本地端点宕机，When 任意阶段，Then 5s 内降级云端且用户可见提示；Given 混合会话，When 查看会话头，Then 本地/云端 token 与预估节省分账正确 |

### P1（6 人日）

| # | 任务 | 工作量 | 依赖 | 验收标准 |
|---|---|---|---|---|
| V1 | 结果校验框架：validator 注册表 + 内置 6 类校验器 + reformulate 重试循环 | 1.5 | B1/S1 | Given write_file 后校验器运行，When 文件缺失，Then 触发重试而非静默通过 |
| C1 | 搜索/调用缓存：TTL + URL 归一 + 统计 + 清理入口 | 1.0 | B1 | Given 同 query 30 分钟内二调，When 搜索，Then ≤300ms 缓存命中且标注来源 |
| U1 | 搜索面板 + 人工接管 + 反爬检测提示 | 2.0 | B1 | Given 引擎返回验证页，When 检测到特征，Then 面板弹出可见窗口 + 「手动过检后继续」按钮生效 |
| S3 | 软件设置面板（探测列表/测试/自定义向导） | 1.5 | S1 | Given 打开设置→外部软件，When 点击测试调用，Then 显示该软件真实回显 |

### P2（v1.8.1，不占本版）

T1 任务模板（宏）2 人日 / 预设库扩充 1.5 人日 / 搜索历史时间线 1 人日。

---

## 8. 里程碑与依赖

```
W1      W2      W3      W4      W5
├─ B1 搜索核心 ──────────┤
│    B2（依赖 B1）          │
│    C1（依赖 B1）          │
│         ├─ S1 软件核心 ──────┤
│         │    S2              │
│         │         ├─ H1 混合路由 ──────────┤
│         │         │    H2                    │
│         │         │         ├─ V1/U1/S3 配套 ──────┤
│         │         │         │                        ├─ 回归+发布 ─┤
```

**关键路径**：B1 → H1 → H2 → 回归。**并行面**：B2/C1 与 S1/S2 可并行（两组无交集）；U1 与 H2 可并行。
**降级规则**：时间告急时 P1 全顺延 v1.8.1；H 组可先上 `quality`（等价现行为）+ `saver` 两策略，`auto` 的启发式后补；**B1/S1/H1 不可裁剪**（分别是三大能力的生存底线）。

---

## 9. 契约红线核对

| 红线 | 本方案影响 |
|---|---|
| js_api 契约零变更 | 新方法（browser_search/browser_open/software_list/software_call/software_probe/hybrid_*/search_cache_stats 约 8 个）全部进 `_V12_EXTRA`；`get_api_info` 输出零漂移 |
| build_tools 逐字节 | **新增 `include_agent=False` 可选参数**（MCP `include_mcp` 同款先例）——默认路径输出不变，契约差分测试天然通过；前端 Agent 循环按功能开关传 `include_agent=true` |
| config.json 零污染 | `software.json`/`hybrid.json`/搜索缓存均独立文件（guard.json/mcp_servers.json 同模式） |
| UI 契约只增不改 | 搜索面板/软件面板/hybrid 配置全部新 DOM id/class；既有 40 id/13 onclick/43 callApi/39 类/21 变量零改动 |
| 零第三方依赖 | WebView2（pywebview 已依赖）/http.client/ctypes/winreg——全 stdlib 或既有栈 |
| 沙箱复用 | CLI 软件调用走 `sandbox_service.run_in_sandbox`（v1.6 资产），不新建执行通道 |

---

## 10. 测试验证策略

| 层 | 手段 |
|---|---|
| 单测（本环境全绿） | 引擎适配器/正文提取为**纯函数**→ fixture HTML（Bing/DDG/百度/文章页各 1-2 个）驱动；URL 构造/过滤去重/缓存 TTL/参数 schema 校验/错误人话映射/路由决策矩阵/降级时序（mock 本地端点）/validator 六类 |
| 契约门 | `build_tools` 默认路径逐字节 + `get_api_info` + config.json 不污染 + `check_contract.py` |
| 前端 harness | vm 沙箱测 `executeToolRaw` 新分支（browser_*/software_* 分发 + token 透传）；hybrid 配置 UI 状态机 |
| 目标机冒烟（本环境无显示设备） | ① 真实 WebView2 窗口搜索三步（Bing 查询→提取→深度打开）② 反爬人工接管 ③ git/ffmpeg 真实调用 ④ Ollama 协同全链（理解→执行→校验→分账）⑤ 降级：拔本地端点 |

---

## 11. 风险矩阵

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 搜索引擎反爬/验证码阻断自动化 | 高 | 引擎容忍度排序 + 验证页特征检测 + 人工接管（U1）+ GLM 端点走内置 web_search 双通道 |
| R2 | WebView2 evaluate_js 时序不稳（SPA/懒加载） | 高 | 选择器轮询等待（≤8s）+ 看门狗 + urllib 兜底（非 JS 引擎） |
| R3 | 本地模型幻觉参数流入执行 | 高 | schema 硬校验 + 置信门 <0.7 升级云端 + 高危动作 always 档确认 |
| R4 | 新工具改变 Agent 行为（工具过多稀释注意力） | 中 | 功能分级开关（设置可单独关搜索/软件/混合）；`include_agent` 按开关下发 |
| R5 | 软件注册表假冒（PATH 里的同名假 exe） | 中 | CLI 类 `--version` 验证身份；首次调用前用户确认 |
| R6 | 搜索缓存陈旧（TTL 外信息已变） | 低 | TTL 可配 + 结果标注获取时间 + 一键清理 |
| R7 | 双窗口内存占用 | 低 | 搜索窗口按需创建/空闲 60s 回收（MCP IDLE 同款机制） |

---

## 12. Non-goals（明确不做）

1. **不做浏览器自动化操作**（表单填写/点击/多步网页流程）——本版只做「搜索 + 提取」，浏览器 Agent 化是独立大功能，需过护栏成熟度评审。
2. **不做软件自动下载安装**——未检测到软件时只引导去官网，不静默下载执行（供应链风险）。
3. **不做 OAuth/需登录态的软件调用**——CLI/GUI/URI 三类之外的企业软件集成留 v1.9+。
4. **不改 js_api 契约、不碰 config.json、不引第三方依赖、不动打包配置**——工程铁律。
5. **本地模型不做执行规划与终稿**（saver 策略的简单问答除外）——职责边界是准确率前提，不为「全本地」叙事破坏边界。

---

## 13. 待确认问题

1. **搜索默认引擎与面板首批范围**：默认 Bing（容忍度最高）是否认可；U1 人工接管面板随首批交付（+2 人日）还是 v1.8.1？建议首批——反爬没有接管路径等于半成品。
2. **software_call 默认风险档位**：mutate 类默认 session 档（会话首次确认）是否接受；dangerous 类 always 是否过严（如常用 `git commit` 会被每次确认）——建议按预设分级 + 用户可调。
3. **混合路由默认策略**：`auto`（本地管理解/校验、云端管规划/终稿）作为默认是否认可；saver 全本地模式要不要加「质量下降自负」提示。
4. **版本号**：三大能力合发 v1.8.0（约 5 周单人）是否认可；或拆 v1.8.0 搜索+软件 / v1.8.1 混合协同两批（前者约 3 周先上）。

---

## ⚠️ 假设

- 工作量基于 v1.7.0 模块化结构与 701 测试网既有 velocity；WebView2 时序问题若比预期顽固（R2），B1 最坏 +1.5 人日，缓冲在 B1。
- 搜索引擎页面结构在开发期内不变（适配器为纯函数，结构变化只换 fixture + 选择器，不伤架构）。
- 本地模型 JSON 输出能力：Qwen/Llama3.1 级模型在 grammar 提示下可达 ≥80% schema 合规；更低级模型走降级链，不阻塞。
- 「非 GLM 端点搜索可用率 100%」指通道可用（含人工接管与兜底），不承诺每次无人值守成功（反爬是概率事件，诚实边界）。

---

## 📚 来源索引

**[内]** `frontend/src/60-agent-loop.js:111`（web_search GLM 门禁）、`backend/api.py:389/427`（open_app/open_url）、`backend/services/local_model_service.py`（本地层函数清单）、`frontend/src/25-tool-exec.js:98-133`（工具分发模式）、`backend/tools_schema.py`（契约比对范围）、`deliverables/dev-plan/iteration-plan-v16-2026-10-19.md`（v1.6 基线）、`deliverables/dev-plan/sandbox-architecture-2026-10-19.md`（四层正交哲学）、`KNOWN_ISSUES.md`（CDP 被拦截实证/沙箱网络缺口）。
**[外]** 无（本方案全部基于内部架构与实测；反爬应对策略为工程经验，标注为概率边界）。

---

> 本方案由产品通基于代码库实测与既有架构纪律编制；重要决策请由产品负责人审定。
