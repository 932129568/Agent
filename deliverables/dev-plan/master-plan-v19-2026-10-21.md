# Harbor v1.9.0「全域版」总集成方案（三报告合并终版）

**日期**：2026-10-21
**类型**：版本范围 + 里程碑 + 模块结构 + 数据结构 + 接口 + 流程 + 顺序依赖 + 兼容迁移 + 验证——可直接指导编码
**合并的三份输入**：
- **A**《v1.8.0 单版本全量实现方案》（`outputs/deep-research/deep-research-20261020-harbor-v18-bcf7ab8e.md`，54.5 人日）
- **B**《六大方向全网调研与 v1.8.0 迭代方案·第二批》（`outputs/deep-research/deep-research-20261021-six-directions-v18-720e5c81.md`，R26-R45 修订 +4.5 人日）
- **C**《双平台内置 AI 浏览器 + macOS 版同开发方案》（`deliverables/dev-plan/macos-browser-plan-2026-10-21.md`，100 包 58-66 人日）
**状态**：v1.0（待技术负责人审定）

---

## 📌 TL;DR

- **一句话**：把 A/B/C 三份方案合并为**单一版本 v1.9.0「全域版」**——① 补完 v1.8 路线图最后遗留（dual-LLM-lite 本地读取器等）+ 调研修订未落地项（R26/R27/R37/R39 等）；② 浏览器从「Windows 搜索专用」升级为 **Win/macOS 双端通用 AI 驱动浏览器**（六原语）；③ 完成 Harbor **整版 macOS 移植**（平台服务/UI/安装器/打包公证分发），一个版本交付，不拆分。
- **当前基线（实测）**：VERSION=**1.7.0**（文件实测；远端 v1.8.0 tag 已发但 tag 内 VERSION 文件滞后为 1.7.0——版本纪律问题已列修复项），1082 passed/0 failed，契约 PASS，HEAD=a40f183 领先 origin/main 5 个提交。
- **总量**：**100 个工作包 / 9 个里程碑 / 约 64 人日（区间 62-70）**；单人约 13 周 / 2 人约 7-8 周。
- **去重账**：A 已交付约 47 人日的内容不重排；dual-LLM-lite 在 A 遗留与 C 的 M3 双出处，**只计一次**；C 与 A 共用的搜索面板/guard 接线/缓存只计增量。

---

## 1. 三份输入的合并口径与去重账

### 1.1 映射关系（每个输入的内容落在本方案哪里）

| 输入内容 | 原出处 | 落入本方案 |
|---|---|---|
| B 浏览器搜索（四件套+面板+缓存） | A W3-W5 | **已交付**（v1.8 线）→ 仅迁移与扩展，不重排 |
| S 软件调用 / H 混合路由 / V1 校验 / F1 反思 / F2 记忆 / prompts 两表 / estTokens / trace_id / readiness / MCP TOFU+健康度 | A W0-W2/W6/W7/W10/W11 | **已交付**（代码库实测确认） |
| dual-LLM-lite 本地读取器（+provenance 包裹） | A W3-W5 遗留 + C M3.5 | **M2.1/2.2**（双出处合一） |
| R26 计划审查主关卡 / R27 审批预算 / R41 计划卡 UX | B | **M2.3-2.5**（计划卡 UI 已交付，升级关卡逻辑） |
| R37 审计五维+哈希链 | B | **M2.6** |
| R39 检查点六军规（checkpoint_service） | B（+A W8-W9 D 组） | **M2.7/2.8**（plan_service 已交付，检查点未建） |
| R28 Bing RSS 优先 | B | **M2.9** |
| R36 定期重验+楼层规则扩 schema 全字段 | B（连接时 TOFU+调用前重校已交付） | **M2.10**（收尾） |
| R30/R32 缓存分级 TTL / stderr 清洗核对 | B（主体随 A 交付，深度待核） | **M2.11**（核对后补齐） |
| R42 剪贴板两级答案 | B（R23 已实测：Win11 Flag 无效） | **M8.9**（MXC 文档化为演进路线） |
| R44 AGENTS.md / R45 竞品基线 | B | **M5.9 / M8.5+M9.8** |
| 平台抽象 browser/ 包 + PlatformServices | C M0 | **M1** |
| Windows 浏览器完整化（click/fill/screenshot/close） | C M1 | **M3**（v1.8 搜索浏览器无交互原语——代码库实测） |
| macOS WKWebView 后端 | C M2 | **M4** |
| AI 驱动工具面（6 js_api+guard+schema） | C M3 | **M5**（与 M2.1 读取器衔接） |
| macOS 平台服务（Keychain/Seatbelt/截屏/废纸篓/路径/进程/通知） | C M4 | **M6.1-6.9** |
| macOS UI 适配 + DMG 安装器 | C M5 | **M6.10-6.14** |
| macOS 打包（codesign/公证/DMG） | C M6 | **M7** |
| 性能/安全/测试/真机/发布 | C M7-M9 | **M8/M9** |

### 1.2 工作量去重账

| 输入 | 原始估算 | 调整 | 入本方案 |
|---|---|---|---|
| A 实现方案 | 54.5 人日 | 已交付约 47（W0/W1/W2/W6/W7/W10/W11 + B/S 组主体，代码库实测） | 遗留 ~7.5 |
| B 调研修订 | +4.5 人日 | R29/R30/R33/R34/R35 随 A 交付；R36 主体随 W10 交付 | 未落地 ~2.5 |
| C 双平台+macOS | 58-66 人日 | 与 A/B 双出处去重 -4（dual-LLM-lite 2 + 搜索面板/guard/缓存复用 2） | ~54-62 |
| **合计** | — | — | **~64 人日（62-70）** |

---

## 2. 当前状态基线（代码库实测，2026-10-21）

### 2.1 已交付清单（不重排，仅作依赖前提）

- **能力棒**：搜索四件套（search_browser/adapters/extract/service）+ browser_search/browser_open/search_status/browser_takeover/search_cache_stats js_api；software_service（software.json+探测+调用+面板）；hybrid_router（路由+预算+降级+日志）；validation_service + F1 reflect_loop；memory_service（三类结构化+检索+注入）
- **放权棒**：plan_service（计划状态机）+ 67-plan-card.js；guard deny 清单/allow_rules/task_grant 五层判定链；26-guard 授权条 + agentGuardCheck
- **信任棒**：prompts/ 两表模式（10 文件+manifest+loader）；estTokens 校准+usage 对账；trace_id 全链；readiness 8 项+面板；MCP TOFU（schema hash+call_tool 前置拒）+健康度三态；导出修复；历史自选目录+真删；R23 剪贴板实测（结论：Win11 无效，KNOWN_ISSUES §17 已修订）；R20 DeepSeek 校准；R21 判重复建设不投入

### 2.2 未交付清单（本方案范围）

| # | 项 | 原出处 | 落点 |
|---|---|---|---|
| 1 | **dual-LLM-lite 本地读取器**（最大遗留） | A+C | M2.1/2.2 |
| 2 | 计划审查主关卡+审批预算+计划卡 UX 升级 | B R26/R27/R41 | M2.3-2.5 |
| 3 | 审计五维+哈希链 | B R37 | M2.6 |
| 4 | checkpoint_service 六军规+UI | B R39 / A D 组 | M2.7/2.8 |
| 5 | Bing RSS 优先 | B R28 | M2.9 |
| 6 | MCP 定期重验+楼层规则扩全字段 | B R36 收尾 | M2.10 |
| 7 | 缓存分级 TTL / stderr 清洗核对 | B R30/R32 | M2.11 |
| 8 | Windows 浏览器交互原语（click/fill/screenshot/close） | C M1 | M3 |
| 9 | macOS 浏览器后端（WKWebView） | C M2 | M4 |
| 10 | 6 个浏览器驱动 js_api+guard+schema+反爬+AGENTS.md | C M3 + B R44 | M5 |
| 11 | macOS 平台服务七接口 | C M4 | M6.1-6.9 |
| 12 | macOS UI 适配+DMG 安装器+权限引导 | C M5 | M6.10-6.14 |
| 13 | macOS 打包签名公证分发 | C M6 | M7 |
| 14 | 双端性能/安全/测试/真机/发布 | C M7-M9 + B R45 | M8/M9 |

---

## 3. 版本范围与目标

**版本号**：VERSION 1.7.0 → **1.9.0**（v1.8.0 tag 已在远端发放；`update_service.py` 回退常量同步；**版本纪律修复**：VERSION bump 进发布 checklist——v1.8.0 tag 曾带 VERSION=1.7.0 出货，见 M1.10）。

**范围（单版本全量，不拆分）**：

| 棒 | 内容 | 人日 |
|---|---|---|
| 补完 | dual-LLM-lite+provenance / 计划审查关卡+审批预算 / 审计五维哈希链 / 检查点六军规 / Bing RSS / MCP 收尾 | 8.5 |
| 双端浏览器 | 平台抽象 / Win 完整化（六原语）/ macOS WKWebView 后端 / AI 驱动工具面（6 js_api） | 25 |
| macOS 整版 | 平台服务七接口 / UI 适配 / DMG 安装器 / 打包签名公证分发 | 32.5 |
| 质量 | 双端性能基准 / 安全加固 / 测试矩阵 / 双真机验证 / 发布 | 15.5 |
| 门禁回归 | 全量测试+契约+UI 契约+构建幂等+安装器 e2e+注入 fixture | （含上述各项） |

**目标（可证伪）**：
1. 非 GLM 端点获得受控搜索 + **双端可用的通用 AI 驱动浏览器**（Win/macOS 同输出，注入 fixture 零触发）
2. 确认弹窗/任务 -60%（计划审查主关卡+任务授权+审批预算）
3. 任务结果自检覆盖率 100%（dual-LLM-lite+Reflexion 已在位，本版补读取器闭环）
4. macOS 版可分发：DMG 拖拽安装 → 权限引导 → 全功能冒烟通过
5. 1082 既有测试零回归 + 新增约 150 项全绿；契约/UI 契约零漂移

---

## 4. 里程碑与 100 批次实施计划（9 里程碑）

> 每包：编号 / 任务 / 交付物 / 依赖。P0 不可裁剪，P1 尽力，P2 可砍。

### M1 · 地基与平台抽象（5.5 人日，12 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 1.1 | 建 `browser/` 包 + `__init__.py` 平台探测（sys.platform → win/mac/headless） | 包骨架 | — |
| 1.2 | `session_base.py`：BrowserSession 抽象（六原语签名+状态机+错误 taxonomy） | 基类 | 1.1 |
| 1.3 | `platform/` 包：PlatformServices 抽象（Secrets/Sandbox/Screen/Trash/Paths/Process/Notify 七接口） | 抽象 | 1.1 |
| 1.4 | Windows 平台服务实现（DPAPI/JobObject/ImageGrab/send2trash/tasklist/toast 适配器） | win impl | 1.3 |
| 1.5 | 搜索四件套迁入 browser/（search_browser→session_win、search_service→service、adapters/extract 随迁） | 迁移 | 1.2/1.4 |
| 1.6 | 迁移回归：既有 browser_search/open/takeover/cache_stats 测试全绿 | 测试 | 1.5 |
| 1.7 | api.py import 路径更新 + 契约差分（get_api_info 逐字节） | 接线 | 1.5 |
| 1.8 | prompts/ 扩展：browser-navigate/extract/click/fill 四个新提示词 + manifest 版本 bump + 迁移逐字一致断言 | 提示词 | — |
| 1.9 | `_V12_EXTRA` 批量占位（本版全部新 js_api 名先登记后实现） | 契约 | — |
| 1.10 | **版本纪律修复**：VERSION bump 进发布 checklist（tag 前断言 VERSION==目标版本）+ update_service 回退常量同步 | 流程 | — |
| 1.11 | headless 后端骨架（urllib + adapter 复用） | 后端 | 1.2 |
| 1.12 | M1 出口：全量测试 + 契约差分 + 构建幂等 | 门禁 | 1.1-1.11 |

### M2 · Agent 遗留与调研修订落地（8.5 人日，12 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 2.1 | **dual-LLM-lite 本地读取器**：hybrid_router 驱动，schema 约束 JSON，无指令权；读取器系统提示禁祈使句/禁工具名样式 | AI 核心 | M1 |
| 2.2 | provenance 包裹（来源 URL + UNTRUSTED DATA 标记）接入搜索/浏览器/软件三类输出 | 安全 | 2.1 |
| 2.3 | R26 计划审查主关卡：发送后计划卡先行（Intent Preview：步骤+时间估计+风险+边界声明），批准才执行；单命令确认收缩到 deny+高风险档 | 关卡 | M1 |
| 2.4 | R27 审批预算：会话级确认计数，超限升级「任务授权」而非继续弹窗；高风险档禁快捷确认 | 关卡 | 2.3 |
| 2.5 | R41 计划卡 UX 升级（<30s 可扫/批准带累计上下文/渐进委托）+ 授权条常驻一键收回 | UI | 2.3 |
| 2.6 | R37 审计五维+哈希链：双身份/意图/计划/执行证据（参数哈希非原文）/结果；条目哈希链防篡改；记忆检索事件入账 | 审计 | M1 |
| 2.7 | R39 checkpoint_service：六军规（差异恢复/绝不删未备份/自有影子仓库/shell 前后快照/清单+确认/恢复后校验）+ ≤200MB/500 文件/保留 3 份 | 服务 | M1 |
| 2.8 | 检查点 UI 入口（计划卡回滚链接 + 清单确认对话框 + 回滚后校验提示） | UI | 2.7 |
| 2.9 | R28 Bing 适配器 RSS 优先（format=rss 主路径 4KB + HTML 兜底 .b_algo + 双通道一致性 fixture + UA + 验证码结构化错误） | 适配器 | M1 |
| 2.10 | R36 收尾：MCP 定期重验（健康度联动）+ 楼层规则扩 schema 全字段（参数名/类型/枚举/默认值投毒） | 安全 | M1 |
| 2.11 | R30/R32 核对补齐：缓存分级 TTL（新闻 5min/通用 1h/百科 24h）核对校准；软件 stderr 回灌前 ANSI/bidi/零宽清洗核对 | 核对 | M1 |
| 2.12 | M2 出口：dual-LLM 隔离 fixture（读取器零工具权）+ 审计哈希链验证 + 全量门禁 | 门禁 | 2.1-2.11 |

### M3 · Windows 浏览器完整化（5.5 人日，10 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 3.1 | session_win 泛化：通用导航（任意 URL，解除搜索 URL 假设） | 后端 | M1 |
| 3.2 | click/fill 原语（evaluate_js 派发 + 前后态截图审计） | 后端 | 3.1 |
| 3.3 | screenshot 原语（win32 窗口捕获，point 坐标系） | 后端 | 3.1 |
| 3.4 | close 原语 + 会话生命周期接入 BrowserService | 后端 | 3.2 |
| 3.5 | js_api 提取桥（on_extract 回调 + 主线程派发 + **加锁**——官方明示线程不安全） | 后端 | 3.1 |
| 3.6 | 下载拦截（默认禁）+ 外链策略（target=_blank → 系统浏览器） | 后端 | 3.1 |
| 3.7 | 会话池（预热/空闲 60s 回收/上限 3 + 排队） | 后端 | 3.4 |
| 3.8 | 可见/隐藏驱动模式切换（AI 后台驱动 vs 用户可见浏览；复用 takeover 机制） | 后端 | 3.4 |
| 3.9 | 注入 fixture（毒网页零触发）+ 视口外元素拒点 + 敏感字段识别 | 测试 | 3.2 |
| 3.10 | M3 出口：六原语 Windows 全链路 + 既有搜索回归不破 | 门禁 | 3.1-3.9 |

### M4 · macOS 浏览器后端（10 人日，12 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 4.1 | PyObjC 环境隔离安装方案（extras: pywebview[cocoa]；Windows 端不装） | 依赖声明 | M1 |
| 4.2 | `session_mac.py`：NSWindow + WKWebView 创建（PyObjC 桥） | 后端 | 1.2/4.1 |
| 4.3 | WKWebViewConfiguration：独立 data store（cookie 隔离）+ jsBridge 注册 | 后端 | 4.2 |
| 4.4 | load_url + 导航委托（didFinishNavigation/didFail） | 后端 | 4.2 |
| 4.5 | 等待原语（选择器轮询 + DOM 稳定，与 Win 语义一致） | 后端 | 4.4 |
| 4.6 | js_api 提取桥（on_extract 回调 + 主线程派发） | 后端 | 4.3 |
| 4.7 | 页面截图（takeSnapshotWithCompletionHandler，point 坐标系） | 后端 | 4.4 |
| 4.8 | click/fill 原语（evaluateJavaScript 派发 + 前后态截图） | 后端 | 4.5 |
| 4.9 | 下载拦截 + 外链策略（与 Win 3.6 语义对齐） | 后端 | 4.2 |
| 4.10 | 会话池（预热/回收/上限 3，与 Win 对齐） | 后端 | 4.2 |
| 4.11 | headless 完整化 + 无显示环境自动降级 + 日志 | 后端 | 1.11 |
| 4.12 | M4 出口：**三后端一致性 fixture**（同 HTML → 同结构化输出） | 门禁 | 4.5-4.11 |

### M5 · AI 驱动工具面（双端同一套，5 人日，10 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 5.1 | 6 个 js_api（navigate/extract/click/fill/screenshot/close）+ `_V12_EXTRA` 转正 | 接口 | M1 |
| 5.2 | guard 矩阵接线（click/fill=always，其余 session）+ token 透传 | 安全 | 5.1 |
| 5.3 | 工具 schema strict（additionalProperties:false + enum + required） | schema | 5.1 |
| 5.4 | 服务端双门校验（strict 只保形状）+ isError 回传 + 重试上限 1 | 校验 | 5.3 |
| 5.5 | dual-LLM-lite 接入浏览器提取（复用 M2.1 读取器） | AI | 2.1/4.6 |
| 5.6 | 等待三保险（选择器/DOM 稳定 innerText 三连稳/硬超时+输出校验拒 loading） | 引擎 | 4.5 |
| 5.7 | 反爬检测（验证码特征 → browser_takeover 人工接管，双端） | 引擎 | M3/M4 |
| 5.8 | 缓存分级 TTL + URL 归一化（utm/片段/尾斜杠/查询排序）+ 适配器版本入键 | 缓存 | 2.11 |
| 5.9 | R44 AGENTS.md 最小可运行示例 + 工具描述三段式（触发/语义/排除）+ consolidate lint | 提示词 | 5.3 |
| 5.10 | M5 出口：双端注入 fixture（毒网页零触发）+ 全量门禁 | 门禁 | 5.1-5.9 |

### M6 · macOS 平台服务 + UI + 安装器（12 人日，14 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 6.1 | macOS Keychain 服务（ctypes Security C API：add/find/delete；**绕开 Tahoe 已坏的 security CLI**） | secrets | 1.3 |
| 6.2 | Secrets 抽象切换（DPAPI↔Keychain 按平台；Windows 已有值不动） | secrets | 6.1 |
| 6.3 | Keychain 边界测试（GUI 会话依赖/ACL/SSH -25308 人话引导） | 测试 | 6.1 |
| 6.4 | sandbox-exec 后端（SBPL 生成器 deny default + 最小 profile + 网络三档 none/loopback/full） | sandbox | 1.3 |
| 6.5 | 沙箱自检（尝试违规读写/网络验证被拦）+ 子进程树继承验证（sh -c 嵌套逃逸测试） | 测试 | 6.4 |
| 6.6 | 截屏 macOS 后端（CGDisplayCreateImage via Quartz；TCC 权限引导） | screen | 1.3 |
| 6.7 | 废纸篓 macOS 后端（NSFileManager）+ 路径层（`~/Library/Application Support/Harbor`） | trash/paths | 1.3 |
| 6.8 | 进程服务（ps/NSTask）+ 通知服务（NSUserNotification + 权限引导） | process/notify | 1.3 |
| 6.9 | M6a 出口：七接口双端一致性 + 路径迁移测试（Win 路径零变化断言） | 门禁 | 6.1-6.8 |
| 6.10 | 平台探测 js_api（get_platform_info）+ 前端平台分支基建（macOS 根类 + Cmd/Ctrl 双映射表） | 接口/前端 | 5.1 |
| 6.11 | 菜单栏（App Menu：About/Preferences Cmd+,/Hide/Quit Cmd+Q）+ 窗口行为（traffic lights/关窗不退出/Dock 还原） | 前端 | 6.10 |
| 6.12 | 快捷键体例（Cmd+Enter 发送/Esc 停止/Cmd+F 搜索）+ 控件 mac 风格（overlay scrollbar/switch/focus ring）+ SF 字体栈 | 前端 | 6.10 |
| 6.13 | DMG 安装器（背景图 + Applications 链接 + 拖拽安装 + 卸载说明）+ 首次运行权限引导（TCC/Keychain） | 安装器 | 6.9 |
| 6.14 | M6b 出口：UI 契约差分（40 DOM id 零漂移）+ 安装冒烟 | 门禁 | 6.10-6.13 |

### M7 · macOS 打包分发（5.5 人日，10 包，P1）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 7.1 | macOS build spec（--windowed + BUNDLE + Info.plist 三键） | spec | M1 |
| 7.2 | 图标资产（.icns 从 harbor-icon.png 生成） | 资产 | 7.1 |
| 7.3 | PyInstaller macOS 构建（arm64）+ 冒烟启动 | 构建 | 7.1/7.2 |
| 7.4 | codesign 脚本（由内而外：find Mach-O → 逐个签 → 整体签 + hardened runtime） | 签名 | 7.3 |
| 7.5 | entitlements 决策（App Sandbox 不开——需文件/网络全权；记录决策） | 配置 | 7.4 |
| 7.6 | notarytool 公证流水线（ZIP 提交 + wait + stapler + 失败日志） | 公证 | 7.4 |
| 7.7 | DMG 制作（create-dmg/hdiutil + 拖拽安装布局） | 分发 | 7.6 |
| 7.8 | 未签名降级路径（文档化 Gatekeeper「Open Anyway」引导） | 文档 | 7.3 |
| 7.9 | 版本注入（VERSION → CFBundleShortVersionString 一致性断言） | 构建 | 7.1 |
| 7.10 | M7 出口：.app 签名验证（spctl）+ DMG 挂载安装冒烟 | 门禁 | 7.7 |

### M8 · 性能与安全（双端，4.5 人日，10 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 8.1 | 会话池预热（首个导航前建窗；量化冷启耗时，双端） | 优化 | 3.7/4.10 |
| 8.2 | 空闲回收 + 内存基线测试（常驻 <150MB，双端） | 优化 | 3.7 |
| 8.3 | 提取带宽优化（只回传序列化结果；禁整页 HTML）+ 多会话上限 3 | 优化 | 3.5 |
| 8.4 | Retina 截图坐标修正（point 坐标系，macOS） | 优化 | 4.7 |
| 8.5 | R45 双端性能基准报告（内存 <150MB / 中文检索 ≥90% / 安装到首问 <3min） | 基准 | 8.1-8.4 |
| 8.6 | SBPL profile 评审（最小权限：无 network 默认；工作区外零写） | 安全 | 6.4 |
| 8.7 | 注入防御复核（provenance+二元信号+弱评估器熔断）+ click/fill 前后态审计 + 敏感字段掩码 | 安全 | 2.2/3.2 |
| 8.8 | cookie 隔离验证 + 沙箱逃逸测试集（符号链接/junction/管道继承/环境变量注入）+ Keychain ACL 审计 | 测试 | 4.3/6.5 |
| 8.9 | 威胁模型文档（macOS 特有：TCC 滥用/AppleEvent/LaunchAgent；R42 两级答案归档：Job 进程级 + MXC 平台级演进路线） | 文档 | 8.6 |
| 8.10 | M8 出口：双端安全测试全绿 + 基准报告评审 | 门禁 | 8.1-8.9 |

### M9 · 测试矩阵 / 真机 / 发布（6 人日，10 包，P0/P1）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 9.1 | 单元：session_mac 全原语（Mock PyObjC 层，CI 可跑） | 测试 | M4 |
| 9.2 | 契约：本版全部新 js_api 差分（get_api_info 逐字节 + config.json 零污染） | 测试 | M5 |
| 9.3 | 集成：headless 后端全工具链（CI nightly） | 测试 | 4.11 |
| 9.4 | 平台真机：Keychain/Seatbelt（仅 macOS runner） | 测试 | M6 |
| 9.5 | MacBook 冒烟：导航→等待→提取→点击→截图全链路 + 权限流（TCC/Keychain 引导）+ Gatekeeper 全流程 | 冒烟 | M5/M6/M7 |
| 9.6 | 性能实测对标（双端冷启/导航/提取）+ 回退验证（无网/无权限/沙箱拒闯） | 基准 | M8 |
| 9.7 | Windows 真机回归（浏览器完整化不破坏搜索 + Setup exe 安装器不受影响） | 回归 | M3 |
| 9.8 | 七门全量 + 基准链复跑（3 条标准任务链：token -15%/TTFT/cache hit/确认 -60%/成功率） | 门禁 | 全部 |
| 9.9 | 发布文档（双平台安装指引：Setup exe / DMG + 权限说明 + FAQ + KNOWN_ISSUES 更新 + api 参考重生） | 文档 | M7 |
| 9.10 | M9 出口：发布评审 + 归档（Setup exe / .app / .dmg / 校验和 / 发布说明） | 门禁 | 9.1-9.9 |

---

## 5. 核心模块与文件结构（合并增量）

### 5.1 新增后端

| 文件 | 职责 | 来源 |
|---|---|---|
| `backend/services/browser/`（session_base/session_win/session_mac/session_headless/service/adapters/extract） | 跨平台浏览器包（四件套迁入+两新后端） | C M0-M4 |
| `backend/services/platform/`（secrets/sandbox_exec/screen/trash/paths/process/notify） | PlatformServices 七接口双实现 | C M0/M4 |
| `backend/services/checkpoint_service.py` | 检查点六军规（影子仓库/文件快照/差异恢复/保留策略） | B R39 / A D 组 |
| `backend/prompts/browser-*.md`（4 个） | 浏览器驱动提示词（两表模式扩展） | C M3 |

### 5.2 修改后端（相对已交付状态的增量）

| 文件 | 改动 |
|---|---|
| `backend/services/hybrid_router.py` | 增 dual-LLM-lite 读取器驱动（understand 类复用；schema 约束；无工具权） |
| `backend/services/search_service.py` | 接入读取器+provenance；Bing RSS 优先；缓存分级 TTL 校准 |
| `backend/services/guard_service.py` | 审批预算（会话级计数）；browser_* 工具档位接线；计划审查关卡挂钩 |
| `backend/services/mcp_service.py` | 定期重验 + 楼层规则扩 schema 全字段 |
| `backend/services/plan_service.py` | 计划审查关卡（Intent Preview 字段：时间估计/边界声明/累计上下文）；检查点调度 |
| `backend/api.py` | 装配 browser/platform/checkpoint；6+browser 与 platform 新 js_api 全入 `_V12_EXTRA`；trace_id/审计五维接线 |
| `backend/tools_schema.py` | `_AGENT_TOOLS` 增 browser_navigate/extract/click/fill/screenshot/close（include_agent 默认 False） |
| `backend/paths.py` | 增 `BROWSER_PROFILE_DIR`/`PLATFORM_DIR`/`CHECKPOINTS_DIR` 常量 |
| `backend/services/software_service.py` | stderr 清洗核对（ANSI/bidi/零宽） |

### 5.3 前端（增量）

| 文件 | 改动 |
|---|---|
| 新增 `69-platform.js` | 平台探测展示 + macOS 分支根类 + 权限引导入口 |
| `26-guard.js` | 审批预算提示 + 高风险档差异化 + 授权条增强 |
| `66-plan.js`（计划卡） | Intent Preview 升级（时间估计/边界声明/累计上下文/回滚链接） |
| `39-search-panel.js` | 浏览器驱动模式切换（可见/隐藏）+ 反爬接管复用 |
| `34-local-model.js` | dual-LLM-lite 状态灯（读取器可用性） |
| `60-agent-loop.js` | 计划审查主关卡分支（批准才执行） |
| `25-tool-exec.js` | browser_* 六工具分发 + 校验器挂钩 |
| `index.template.html` | 纯新增：平台区块/检查点对话框样式/macOS 根类 |

---

## 6. 关键数据结构与接口（增量）

### 6.1 新配置文件（独立于 config.json）

```json
// ~/.glm-chat/browser_sessions.json（双端通用）
{"version":1,"sessions":[{"id":"bs_xxx","mode":"hidden|visible","created":"iso",
  "last_url":"...","state":"ready|idle|closed"}]}

// ~/.glm-chat/checkpoints.json
{"version":1,"items":[{"id":"cp_xxx","kind":"git|files","ref":"...",
  "files":[...],"size_mb":12,"created":"iso"}]}   // 保留 3 份，超限随创建清理
```

### 6.2 新增 js_api（约 14 个，全 `_V12_EXTRA` 隐身）

| 方法 | 签名 | 返回 |
|---|---|---|
| `browser_navigate` | `(url, wait_selector?, timeout?)` | `{ok, title, url, trace_id}` |
| `browser_extract` | `(selector?, mode)` | `{ok, markdown, links, truncated}` |
| `browser_click` | `(selector\|text)` | `{ok, before_b64, after_b64}` |
| `browser_fill` | `(selector, text)` | `{ok, masked:true}` |
| `browser_screenshot` | `(full_page?)` | `{ok, b64}` |
| `browser_close` | `(session_id)` | `{ok}` |
| `get_platform_info` | `()` | `{os, arch, version, services:{...}}` |
| `checkpoint_create` / `checkpoint_list` / `checkpoint_rollback` | `(label)` / `()` / `(cp_id)` | `{ok,id}` / 列表 / `{ok, restored:[...]}` |
| `guard_approval_budget` | `(limit?)` | `{used, limit, escalated}` |
| `search_reader_stats` | `()` | `{reader_calls, schema_fail, degrade_count}` |

### 6.3 会话/审计增字段（纯增）

```json
// sessions.json 增
{"browser":{"session_id":"bs_xxx","mode":"hidden"},
 "audit_chain":{"head":"sha256:...","len":42}}
// guard.json 增
{"approval_budget":{"limit":20,"used":3,"escalated":false}}
```

---

## 7. 主要执行流程（合并后）

### 7.1 Plan-Act 主循环（v1.8 在位 + M2 升级）

```
用户发送
 → hybrid.classify → understand（本地 5s 预算；超时→云端→原样透传）
 → plan_service.propose(intent) → **计划卡先行（M2.3 Intent Preview：步骤+时间估计+风险+边界声明）**
 → 用户：批准 / 编辑后批准 / 拒绝
     └─ L2 授权中 + 计划全 low 风险 → 自动批准（授权条可见）
     └─ 审批预算超限（M2.4）→ 升级为任务授权邀请，不继续弹窗
 → Act：按步骤执行，工具分发过五层判定链
     └─ browser_* 工具：click/fill=always（前后态截图审计）；其余 session
     └─ validation_service 失败 → reformulate ≤2 → blocked
 → Reflect：hybrid validate（本地 3s）→ verdict+confidence；<0.7 → 云端复核
 → Deliver：摘要 + 回滚链接（M2.8）+ trace_id 落审计五维链（M2.6）
```

### 7.2 browser_extract（dual-LLM-lite，双端同一管线）

```
agent → browser_extract(url/selector)
 → 后端选择（Win WebView2 / macOS WKWebView / headless 兜底）
 → 等待三保险（选择器 ≤8s / DOM 稳定三连稳 / 硬超时+输出校验）
 → 页面 JS 采集 → window.pywebview.api.on_extract(json) 回调（加锁转主队列）
 → dual-LLM-lite 读取器（本地，schema 约束，无指令权）→ 结构化 JSON
 → provenance 包裹（来源 URL + UNTRUSTED DATA）→ 进主模型上下文
 → 缓存写入（分级 TTL + 适配器版本入键）+ 审计
 → 降级：窗口超时 → headless urllib；验证码特征 → 面板人工接管
```

### 7.3 macOS 特有流程

```
安装：DMG 拖拽 → /Applications/Harbor.app → 首次运行
 → Gatekeeper（签名+公证直开 / 未签名 Open Anyway 引导）
 → 权限引导：TCC 截屏/文件 + Keychain 首次写入（SSH 会话 -25308 → 引导桌面会话）
 → 数据目录 ~/Library/Application Support/Harbor（Windows ~/.glm-chat 不动）
 → 更新：整包 .app 替换 + Gatekeeper 重新引导（禁 .bat 语义）
```

---

## 8. 顺序与依赖

**关键路径**：M1 抽象 → M2 dual-LLM-lite/关卡 → M3 Win 完整化 → M4 Mac 后端 → M5 工具面 → M6 平台服务+UI → M7 打包 → M9 发布。

**可并行**：
- M3（Win 完整化）与 M4（Mac 后端）可双人并行——共用 session_base 契约，出口都是各自全链路
- M6.1-6.9（平台服务）与 M6.10-6.14（UI+安装器）可并行
- M8 性能与安全随 M3-M7 滚动穿插
- M2 与 M1 完成后即可全面开工（M2 只依赖地基）

**纪律**：每里程碑结束跑 `pytest + 契约差分 + check_contract + build×2`；未测代码不跨里程碑；macOS 专属包在 Windows 开发机上以 Mock/headless 验证，真机项集中 M9。

---

## 9. 兼容性与迁移

| 面 | 处理方式 |
|---|---|
| js_api 契约 | `build_tools` 默认路径（include_agent=False）逐字节不变；约 14 新方法全入 `_V12_EXTRA`，`get_api_info()` 零漂移 |
| config.json | 零写入零读取变更；新配置独立文件（browser_sessions/checkpoints/platform） |
| guard.json / mcp_servers.json / sessions.json | 纯增键（approval_budget / 定期重验字段 / browser+audit_chain）；旧文件缺省合并 |
| UI 契约 | 新 DOM id/class 纯增；check_contract 既有 40 id/13 onclick/43 callApi/39 类/21 变量零改动 |
| 搜索四件套迁移 | 行为等价迁移（M1.6 回归全绿）；既有 js_api 签名不变 |
| Windows 数据路径 | `~/.glm-chat` 红线不动；macOS 用 `~/Library/Application Support/Harbor`；双端不互通（各自独立数据目录，文档化） |
| 提示词迁移 | 新 browser-*.md 落盘即 v1.0；既有提示词输出逐字一致（已有 manifest 断言沿用） |
| 安装器 | Windows Setup exe 三件套不变；macOS DMG 新增双轨；installer_core 可跨平台复用部分 |
| VERSION | 1.7.0 → 1.9.0（v1.8.0 已在远端发放）；**tag 前断言 VERSION==目标版本**（M1.10 纪律修复） |
| 测试基线 | 1082 passed 零回归是硬门；新增约 150 项 |

---

## 10. 验证要点（九门 + 基准）

| 门 | 方式 | 通过标准 |
|---|---|---|
| G1 全量测试 | `pytest tests/ -q` | 1082 既有 + 新增约 150 全绿 |
| G2 契约差分 | `test_api_contract.py`（legacy vs new 逐字节） | build_tools 默认路径 + get_api_info + config.json 零漂移 |
| G3 UI 契约 | `check_contract.py` | PASS（只增不改） |
| G4 构建幂等 | `node frontend/build.js` ×2 | md5 一致 |
| G5 安装器 e2e | Setup exe `--silent` 安装/卸载 + DMG 挂载安装 | exit 0 + 注册表四项/拖拽布局 + 清理干净 |
| G6 注入 fixture | 毒网页 + 毒 MCP 描述 + Deadbugz 时序（前两次良性第三次毒） | 双端零触发且被 surface |
| G7 三端一致性 | 同 HTML fixture → Win/Mac/headless | 同结构化输出 |
| G8 真机冒烟 | ① Win 六原语全链路 ② MacBook 全链路+权限流+Gatekeeper ③ 计划批准→执行→回滚 ④ 记忆跨会话 ⑤ onboarding ⑥ 授权授予/收回 | 全过 |
| G9 基准链 | 3 条标准任务链 × v1.8.0 基线 vs v1.9.0 | token -15% / 确认 -60% / 内存 <150MB / 中文检索 ≥90% / 安装到首问 <3min |

**新增测试文件**：`test_v19_browser.py`（六原语/三端一致性/提取桥加锁/反爬）、`test_v19_reader.py`（dual-LLM-lite 隔离/provenance/schema 失败降级）、`test_v19_gate.py`（计划审查关卡/审批预算/Intent Preview 字段）、`test_v19_audit_chain.py`（五维/哈希链/篡改检测）、`test_v19_checkpoint.py`（六军规/差异恢复/上限/未跟踪文件保护）、`test_v19_platform_mac.py`（Mock PyObjC/Keychain C API mock/SBPL 生成）、`test_v19_installer_mac.py`（DMG 结构/plist/版本注入）。

---

## 11. 风险与止损

| 风险 | 等级 | 止损规则 |
|---|---|---|
| PyObjC 学习曲线 + WKWebView 调试超预估 | 高 | M4 含 3 人日学习曲线；Mock 层先行（CI 可跑）；真机项集中 M9 不阻塞开发 |
| 公证流程卡住（账号/税务） | 中 | 提前注册走完流程；未签名降级路径（M7.8）；DMG 可先行分发 |
| Keychain SSH 会话拒写（-25308） | 中 | 首次写入引导桌面会话；错误码人话；DPAPI 侧不回退 |
| SBPL 误伤合法请求 | 中 | 最小 profile + 自检（尝试违规操作）+ 网络三档 |
| 双平台行为分歧 | 中 | 三端一致性 fixture（M4.12/G7）；抽象层单一定义 |
| Windows 完整化回归破坏既有搜索 | 中 | M3.10 搜索回归 + M9.7 真机回归 |
| 单版本体量大（~64 人日）质量稀释 | 高 | 九里程碑门禁；P2 明确可砍（DMG 美化/8.4 Retina 细化/健康徽标细化）；契约红线碰即停 |
| macOS 真机不可用 | 高 | Mock+headless 保开发；M9.4/9.5 顺延风险需在 M6 前确认真机窗口 |

---

## ⚠️ 假设

- 工作量按已交付基线（1082 测试网）估算；64 人日含单测不含审查（审查 +5-8 人日另计）
- macOS 真机（Intel + Apple Silicon 各一为佳）在 M6 前可用；Apple Developer 账号（$99/年）由项目方提供，M7 前到位
- arm64 CI runner 可用于 M7.3；无则本地 Apple Silicon 机构建 + 文档化
- dual-LLM-lite 的「本地」含 Ollama 与本地代理端点（既有 `__localProxyBase` 分流）；云端降级链不变
- 「AI 直接驱动」范围 = 6 工具原语 + 读取器；不含自主多步网页任务规划（另立项）
- v1.8.0 tag 已发放事实以远端 tag 为准；VERSION 文件滞后问题按纪律修复项处理，不影响范围

## 免责声明

⚠️ 本方案由三份既有报告合并编制（A 实现方案 / B 全网调研修订 / C 双平台方案），全部技术主张可回溯至原报告证据链；Apple 平台政策以官方最新文档为准；重要架构决策请由技术负责人审定后开工。
