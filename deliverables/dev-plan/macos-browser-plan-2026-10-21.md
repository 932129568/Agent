# Harbor 双平台内置 AI 浏览器 + macOS 版同开发方案（v1.9.0「全域版」）

**日期**：2026-10-21
**类型**：技术选型 + 系统架构 + AI 驱动集成 + 双平台（Win/macOS）兼容与性能 + 100 批次实施计划
**基线**：v1.8.0（Windows 搜索浏览器四件套已落地：search_browser/search_adapters/search_extract/search_service + browser_search/browser_open/browser_takeover/search_status/search_cache_stats js_api）
**状态**：v1.0（待技术负责人审定）

---

## 📌 TL;DR

- **一句话**：把已验证的 Windows 搜索浏览器泛化为**跨平台 AI 驱动浏览器模块**（`backend/services/browser/`，三后端：Win/WebView2、macOS/WKWebView、headless 兜底），**Windows 端从「搜索专用」完整化为通用内置浏览器**（补齐 click/fill/screenshot/close 交互原语），**macOS 端从零建设同能力后端**；同步完成 Harbor 整版 macOS 移植（平台服务：Keychain 替代 DPAPI、Seatbelt 替代 Job Object、CG 截屏、废纸篓、`~/Library/Application Support` 路径、NSUserNotification；UI 适配：菜单栏/快捷键/窗口行为/控件风格；分发：.app + codesign + 公证 + DMG 拖拽安装），两端能力对齐、一套 schema、一套 guard、一套提取管线。
- **与上版方案的范围差异（重要）**：上版只做「macOS 浏览器」；本版按「**两个系统都内置浏览器 + macOS 同开发**」修正为——① Windows 浏览器完整化（新增 ~10 包，原搜索四件套只有导航+读取，无交互原语）；② macOS UI 适配与安装器成为独立里程碑（原方案缺失，这是「macOS 版本」的主体）；③ 双端一致性门禁贯穿全里程碑。
- **关键技术判断**：① pywebview 双平台同 API 面（Win=EdgeChromium/WebView2，macOS=Cocoa/WKWebView+PyObjC 9.x）——**抽象层只包「会话/等待/提取/交互」四件套，平台差异关进三个后端**；② 提取通道走 **js_api 回调**（Win WebView2 execute 受页面 CSP `unsafe-eval` 约束，macOS evaluateJavaScript 不受——回调是唯一双平台安全公约数）；③ macOS 沙箱用 **sandbox-exec（Seatbelt SBPL）** 默认拒绝+白名单+子进程树继承，文件/网络隔离实际强于 Windows Job Object；④ 分发必须过 **codesign（由内而外签每个 Mach-O）+ notarization + DMG**，$99/年开发者账号是硬成本。
- **总量**：100 个工作包（10 里程碑），预估 **58-66 人日**（含 macOS 真机验证窗口）；关键路径 = 平台抽象 → Windows 完整化 → macOS 后端 → 平台服务移植 → UI 适配/安装器 → 打包公证。

---

## 1. 技术选型

| 方案 | 评估 | 结论 |
|---|---|---|
| **pywebview + 双平台系统 WebView**（Win WebView2 / macOS WKWebView+PyObjC） | 与已验证的 Windows 搜索浏览器同 API 面（create_window/load_url/evaluate_js/js_api）；零打包浏览器内核；系统 WebKit 随 OS 更新 | **选定**。抽象层三后端（win/mac/headless） |
| 内嵌 Chromium（CEF/Electron） | 违背「零依赖/小体积」铁律；CEF 授权与打包复杂度高 | 弃选 |
| 纯 HTTP 抓取（无渲染） | 无法驱动需要 JS 的站点；丢失「浏览器」本质 | 仅作 CI/无显示环境的兜底后端 |
| 原生 Swift/AppKit 重写 | 双代码库维护，违背单 Python 代码库策略 | 弃选 |

**PyObjC 依赖面**（macOS 专属，按 extras 隔离安装，Windows 端零感知）：pyobjc-core、pyobjc-framework-Cocoa、Quartz、WebKit、Security、UniformTypeIdentifiers（≥9.0）。

---

## 2. 系统架构

```
┌─────────────────────────────────────────────┐
│ Agent 工具面（AI 驱动层，双端同一套）          │
│  browser_navigate / browser_extract           │
│  browser_click / browser_fill                 │
│  browser_screenshot / browser_close           │
│  guard 三档 + 沙箱 + 审计 + trace_id           │
├─────────────────────────────────────────────┤
│ BrowserService（会话编排，平台无关）            │
│  会话生命周期 / 等待策略（选择器+DOM 稳定）/     │
│  提取管线（js_api 回调 → dual-LLM-lite 读取器）│
│  反爬检测 / 人工接管 / 缓存（TTL 分级）         │
├──────────────┬──────────────┬────────────────┤
│ SessionWin   │ SessionMac   │ HeadlessSession│
│ (WebView2)   │ (WKWebView)  │ (urllib 兜底)  │
│ edgechromium │ cocoa+PyObjC │                │
├──────────────┴──────────────┴────────────────┤
│ 平台服务抽象层（PlatformServices）             │
│  Secrets: DPAPI(win) / Keychain(mac)          │
│  Sandbox:  JobObject(win) / Seatbelt(mac)     │
│  Screen:   ImageGrab(win) / CGDisplay(mac)    │
│  Trash:    send2trash(win) / NSFileManager    │
│  Paths:    ~/.glm-chat(win) / ~/Library/App   │
│  Process:  tasklist(win) / ps+NSTask(mac)     │
│  Notify:   toast(win) / NSUserNotification    │
└─────────────────────────────────────────────┘
```

**目录结构**（新增 `backend/services/browser/` 包，Windows 现有四件套迁入泛化）：

```
backend/services/browser/
  __init__.py          # 平台探测 + 后端选择（win/mac/headless）
  session_base.py      # BrowserSession 抽象基类 + 六原语签名 + 状态机
  session_win.py       # WebView2 后端（自 search_browser.py 迁入泛化+补交互原语）
  session_mac.py       # WKWebView/PyObjC 后端（新增，能力对齐 Win）
  session_headless.py  # urllib + adapters 兜底（CI/无显示）
  service.py           # BrowserService（自 search_service.py 扩为通用）
  adapters/            # 引擎适配器（自 search_adapters.py 迁入）
  extract.py           # 正文提取（自 search_extract.py 迁入）
backend/services/platform/
  __init__.py          # PlatformServices 门面 + 平台探测
  secrets.py           # Secrets 抽象 + DPAPI/Keychain 双实现
  sandbox_exec.py      # Seatbelt SBPL 生成器（macOS 专用）
  screen.py / trash.py / paths.py / process.py / notify.py
```

---

## 3. AI 驱动集成方式（双端同一套）

### 3.1 工具面（6 个新 js_api，全进 `_V12_EXTRA` 隐身）

| 工具 | 参数 | guard 档 | 说明 |
|---|---|---|---|
| `browser_navigate` | url, wait_selector?, timeout | session | 导航+等待就绪；回 page_title/url |
| `browser_extract` | selector? / mode(snippet\|full) | session | 提取结构化结果（markdown+links） |
| `browser_click` | selector / text | always | 点击元素（写操作，前后态截图审计） |
| `browser_fill` | selector, text | always | 表单填写（敏感字段 always+掩码） |
| `browser_screenshot` | full_page? | session | 页面截图（复用截屏管线） |
| `browser_close` | session_id | — | 关闭会话 |

### 3.2 提取通道（跨平台安全公约数）

```
Agent → browser_extract
  → 页面 JS 采集（querySelectorAll + 序列化）
  → window.pywebview.api.on_extract(json) 回调   ← 两平台都不受页面 CSP 约束
  → dual-LLM-lite：本地模型解析为结构化结果（schema 约束，无指令权）
  → provenance 包裹（来源 URL + 「UNTRUSTED DATA」标记）后进主模型上下文
```

**双平台差异说明**：macOS WKWebView 的 `evaluateJavaScript:completionHandler:` 是原生 API 不受页面 CSP 约束；Windows WebView2 的 ExecuteScript **受** unsafe-eval 约束——回调是唯一双平台安全通道，架构上不搞平台分歧。

### 3.3 等待策略（三保险，抗 SPA，双端共用）

1. `wait_selector`（显式选择器，≤8s）
2. DOM 稳定性（innerText 长度三连稳 ×500ms）
3. 硬超时兜底 + 输出校验（拒含 "loading" 的残留，重试一次）

---

## 4. 双平台兼容性策略

### 4.1 平台服务映射（PlatformServices 抽象）

| 能力 | Windows 现状 | macOS 方案 | 迁移风险 |
|---|---|---|---|
| 密钥存储 | DPAPI（ctypes crypt32，mcp_dpapi.py） | **Keychain C API via ctypes**（SecKeychainAddGenericPassword/FindGenericPassword） | Tahoe 26.x 的 `security` CLI 已坏（挂起/exit 36）——**必须走 C API 不走 CLI**；打包应用以自身 bundle-id 获得稳定 ACL；SSH 会话需 GUI 上下文（errSecInteractionNotAllowed）——首次写入引导用户在桌面会话完成 |
| 沙箱 | Job Object（sandbox_service.py） | **sandbox-exec + SBPL**（deny default；放行系统读/工作区读写/网络策略 none\|loopback\|full） | SBPL 配置错误会误伤合法请求——每平台一套最小 profile + 自检（尝试违规操作验证被拦）；macOS 无 rlimit 硬限制（pre_exec 的 fork 在多线程进程有险）——资源限制降级为「监控+告警」并文档化 |
| 截屏 | PIL.ImageGrab | screencapture CLI / CGDisplayCreateImage via Quartz | 权限弹窗（Screen Recording）需引导；TCC 权限在 .app 打包后才稳定 |
| 废纸篓 | send2trash | NSFileManager trashItemAtURL（PyObjC） | 无 |
| 数据目录 | `~/.glm-chat` | **`~/Library/Application Support/Harbor`**（macOS 规范） | Windows 路径不动（CONFIG_DIR_NAME 红线）；Mac 新版无迁移负担 |
| 进程枚举 | tasklist/wmic | ps + NSTask | 无 |
| 通知 | Windows toast | NSUserNotification | 权限引导 |
| 更新 | .bat 自替换 | .app 整包替换 + Gatekeeper 重新引导 | 公证后的 app 内二进制替换会破坏签名 |

### 4.2 macOS UI 适配（「macOS 版本」的主体，上版缺失）

| 面 | 适配项 |
|---|---|
| 菜单栏 | App Menu：About / Preferences（Cmd+,）/ Hide / Quit（Cmd+Q）；pywebview macOS 原生菜单桥 |
| 窗口行为 | traffic lights 语义（红=关窗不退出进程）/ 全屏 / 最小尺寸 / 关窗再点 Dock 还原 |
| 快捷键 | Cmd vs Ctrl 双映射表（Cmd+C/V/X/A/Z、Cmd+Enter 发送、Cmd+, 设置、Esc 停止） |
| 控件风格 | overlay scrollbar / 开关（switch）样式 / 焦点环（focus ring）保留 |
| 字体渲染 | SF 字体栈（-apple-system, BlinkMacSystemFont）+ 抗锯齿 |
| 安装器 | **DMG 拖拽安装**（背景图 + Applications 符号链接 + 首次运行权限引导），与 Windows Setup exe 双轨并存 |

### 4.3 打包与分发链（macOS）

```
PyInstaller --windowed → Harbor.app（Info.plist: CFBundleShortVersionString/
  NSHighResolutionCapable/NSSupportsAutomaticGraphicsSwitching）
  → codesign 由内而外（find Mach-O → 逐个 --options=runtime → 整体签）
  → ditto -c -k ZIP → xcrun notarytool submit --wait → xcrun stapler
  → create-dmg / hdiutil → Harbor-<ver>.dmg（拖拽安装体验）
```

---

## 5. 性能优化策略（双端）

| 场景 | 策略 |
|---|---|
| 浏览器会话冷启 | 会话池预热（首个导航前 500ms 建窗）；空闲 60s 回收 |
| 多标签/多会话 | WebKit 进程池天然多进程；单会话内存 ~80-150MB；上限 3 并发会话 |
| 提取带宽 | js_api 回调只回传序列化结果（不回整页 HTML）；adapter 版本入缓存键；RSS 优先（4KB vs 100KB） |
| Retina/外接显示器 | hidpi 缩放由 WebView 原生处理；截图按 point 坐标（非 pixel）避免 2x 偏移 |
| Apple Silicon | PyObjC 9.x 原生 arm64；PyInstaller 目标架构按构建机（CI 用 arm64 runner） |
| 内存基线 | 启动常驻 <150MB（对齐 v1.8 竞品基线）；浏览器会话按需装卸 |
| 本地模型时延 | 前缀缓存（system+tools 稳定前缀每轮复用）；理解 max_tokens 128-256 |

---

## 6. 100 批次实施计划（10 里程碑）

> 每包：编号 / 任务 / 交付物 / 依赖。P0 不可裁剪，P1 尽力，P2 可砍。

### M0 · 平台抽象与双端地基（W1，10 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 0.1 | 建 `browser/` 包 + `__init__.py` 平台探测（sys.platform → win/mac/headless） | 包骨架 | — |
| 0.2 | `session_base.py`：BrowserSession 抽象（六原语签名 + 状态机 + 错误 taxonomy） | 基类 | 0.1 |
| 0.3 | `platform/` 包：PlatformServices 抽象（Secrets/Sandbox/Screen/Trash/Paths/Process/Notify 七接口） | 抽象 | 0.1 |
| 0.4 | Windows 平台服务实现（DPAPI/JobObject/ImageGrab/send2trash/tasklist/toast 适配器） | win impl | 0.3 |
| 0.5 | 搜索四件套迁入 browser/（search_browser→session_win、search_service→service） | 迁移 | 0.2/0.4 |
| 0.6 | 迁移回归：既有 browser_search/browser_open/takeover 测试全绿 | 测试 | 0.5 |
| 0.7 | api.py import 路径更新 + 契约差分（get_api_info 逐字节） | 接线 | 0.5 |
| 0.8 | 会话状态机文档（created→navigating→ready→interacting→extracting→closed） | 文档 | 0.2 |
| 0.9 | headless 后端骨架（urllib + adapter 复用） | 后端 | 0.2 |
| 0.10 | M0 出口：全量测试 + 契约差分 + 构建幂等 | 门禁 | 0.1-0.9 |

### M1 · Windows 浏览器完整化（W1-W2，10 包，P0）

> 现状：SearchBrowser 只有 open_url/_read_dom/urllib 兜底——无交互原语。本里程碑把「搜索专用」扩为「通用内置浏览器」。

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 1.1 | session_win 泛化：通用导航（任意 URL，解除搜索 URL 假设） | 后端 | 0.5 |
| 1.2 | 交互原语补全：click/fill（evaluate_js 派发 + 前后态截图） | 后端 | 1.1 |
| 1.3 | screenshot 原语（win32 PrintWindow/ImageGrab 窗口捕获） | 后端 | 1.1 |
| 1.4 | close 原语 + 会话生命周期接入 BrowserService | 后端 | 1.2 |
| 1.5 | js_api 提取桥（on_extract 回调 + 主线程派发，双端公约数在 Win 侧落地） | 后端 | 1.1 |
| 1.6 | 下载拦截（默认禁）+ 外链策略（target=_blank → 系统浏览器） | 后端 | 1.1 |
| 1.7 | 会话池（预热/空闲 60s 回收/上限 3）+ 排队 | 后端 | 1.4 |
| 1.8 | 可见/隐藏驱动模式切换（AI 后台驱动 vs 用户可见浏览；复用 takeover 机制） | 后端 | 1.4 |
| 1.9 | Windows 端注入 fixture（毒网页零触发）+ 点击越界防护（视口外元素拒点） | 测试 | 1.2 |
| 1.10 | M1 出口：六原语 Windows 全链路 + 搜索回归不破 | 门禁 | 1.1-1.9 |

### M2 · macOS 浏览器后端（W2-W3，12 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 2.1 | PyObjC 环境隔离安装方案（extras: pywebview[cocoa]；Windows 端不装） | 依赖声明 | 0.1 |
| 2.2 | `session_mac.py`：NSWindow + WKWebView 创建（PyObjC 桥） | 后端 | 0.2/2.1 |
| 2.3 | WKWebViewConfiguration：独立 data store（会话 cookie 隔离）+ jsBridge 注册 | 后端 | 2.2 |
| 2.4 | load_url + 导航委托（didFinishNavigation/didFail） | 后端 | 2.2 |
| 2.5 | 等待原语（选择器轮询 + DOM 稳定，与 Win 语义一致） | 后端 | 2.4 |
| 2.6 | js_api 提取桥（on_extract 回调 + 主线程派发） | 后端 | 2.3 |
| 2.7 | 页面截图（takeSnapshotWithCompletionHandler，point 坐标系） | 后端 | 2.4 |
| 2.8 | click/fill 原语（evaluateJavaScript 派发 + 前后态截图） | 后端 | 2.5 |
| 2.9 | 下载拦截 + 外链策略（与 Win 1.6 语义对齐） | 后端 | 2.2 |
| 2.10 | 会话池（预热/回收/上限 3，与 Win 对齐） | 后端 | 2.2 |
| 2.11 | headless 完整化 + 无显示环境自动降级 + 日志 | 后端 | 0.9 |
| 2.12 | M2 出口：三后端一致性 fixture（同 HTML → 同结构化输出） | 门禁 | 2.5-2.11 |

### M3 · AI 驱动工具面（双端同一套，W3，10 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 3.1 | 6 个 js_api 定义（navigate/extract/click/fill/screenshot/close）+ _V12_EXTRA | 接口 | 0.7 |
| 3.2 | guard 矩阵接线（click/fill=always，其余 session）+ token 透传 | 安全 | 3.1 |
| 3.3 | 工具 schema（strict：additionalProperties:false + enum + required） | schema | 3.1 |
| 3.4 | 服务端校验（schema 双门 + isError 回传 + 重试上限 1） | 校验 | 3.3 |
| 3.5 | dual-LLM-lite 读取器（本地模型解析原始→结构化 JSON，无指令权） | AI | 2.6 |
| 3.6 | provenance 包裹（来源 URL + UNTRUSTED DATA 标记） | 安全 | 3.5 |
| 3.7 | 等待策略三保险落地（选择器/DOM 稳定/硬超时+输出校验） | 引擎 | 2.5 |
| 3.8 | 反爬检测（验证码特征 → browser_takeover 人工接管，双端） | 引擎 | 2.4 |
| 3.9 | 缓存分级 TTL（新闻 5min/通用 1h/百科 24h）+ URL 归一化 + 适配器版本入键 | 缓存 | 0.9 |
| 3.10 | M3 出口：双端注入 fixture（毒网页零触发）+ 全量门禁 | 门禁 | 3.1-3.9 |

### M4 · macOS 平台服务移植（W3-W4，10 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 4.1 | macOS Keychain 服务（ctypes Security C API：add/find/delete） | secrets | 0.3 |
| 4.2 | Secrets 抽象切换（DPAPI↔Keychain 按平台；Windows 已有值不动） | secrets | 4.1 |
| 4.3 | Keychain 边界测试（GUI 会话依赖/ACL/Tahoe CLI 坏绕验证） | 测试 | 4.1 |
| 4.4 | sandbox-exec 后端（SBPL 生成器：deny default + 白名单模板） | sandbox | 0.3 |
| 4.5 | SBPL 最小 profile（系统读/工作区读写/网络策略 none-loopback-full） | sandbox | 4.4 |
| 4.6 | 沙箱自检（尝试违规读写/网络 → 验证被拦）+ 子进程树继承验证 | 测试 | 4.5 |
| 4.7 | 截屏服务 macOS 后端（CGDisplayCreateImage via Quartz；TCC 权限引导） | screen | 0.3 |
| 4.8 | 废纸篓 macOS 后端（NSFileManager）+ 路径层（~/Library/Application Support/Harbor） | trash/paths | 0.3 |
| 4.9 | 进程服务（ps/NSTask）+ 通知服务（NSUserNotification + 权限引导） | process/notify | 0.3 |
| 4.10 | M4 出口：七接口双端一致性 + 路径迁移测试（Win 路径零变化断言） | 门禁 | 4.1-4.9 |

### M5 · macOS UI 适配与安装器（W4-W5，10 包，P1）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 5.1 | 平台探测 js_api（get_platform_info：os/arch/version，进 _V12_EXTRA） | 接口 | 3.1 |
| 5.2 | 前端平台分支基建（macOS 类名根节点 + 双快捷键映射表） | 前端 | 5.1 |
| 5.3 | 菜单栏适配（App Menu：About/Preferences Cmd+,/Hide/Quit Cmd+Q） | 前端 | 5.2 |
| 5.4 | 窗口行为（traffic lights 语义/关窗不退出/Dock 还原/最小尺寸） | 前端 | 5.2 |
| 5.5 | 快捷键体例（Cmd+Enter 发送/Esc 停止/Cmd+F 搜索 双映射） | 前端 | 5.2 |
| 5.6 | 控件 mac 风格（overlay scrollbar/switch 开关/focus ring） | 前端 | 5.2 |
| 5.7 | 字体渲染（SF 字体栈 + 抗锯齿）+ 高分行距修正 | 前端 | 5.2 |
| 5.8 | macOS 安装器（DMG：背景图 + Applications 链接 + 拖拽安装 + 卸载说明） | 安装器 | M4 |
| 5.9 | 首次运行权限引导（TCC 截屏/文件 + Keychain 首次写入引导桌面会话） | 前端 | 4.3/4.7 |
| 5.10 | M5 出口：UI 契约差分（40 DOM id 零漂移）+ 安装冒烟 | 门禁 | 5.1-5.9 |

### M6 · macOS 打包分发（W5，10 包，P1）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 6.1 | macOS build spec（--windowed + BUNDLE + Info.plist 三键） | spec | 0.10 |
| 6.2 | 图标资产（.icns 从 harbor-icon.png 生成） | 资产 | 6.1 |
| 6.3 | PyInstaller macOS 构建（arm64）+ 冒烟启动 | 构建 | 6.1/6.2 |
| 6.4 | codesign 脚本（由内而外：find Mach-O → 逐个签 → 整体签 + hardened runtime） | 签名 | 6.3 |
| 6.5 | entitlements 决策（App Sandbox 不开——需文件/网络全权；记录决策） | 配置 | 6.4 |
| 6.6 | notarytool 公证流水线（ZIP 提交 + wait + stapler + 失败日志） | 公证 | 6.4 |
| 6.7 | DMG 制作（create-dmg/hdiutil + 拖拽安装布局） | 分发 | 6.6 |
| 6.8 | 未签名降级路径（文档化 Gatekeeper「Open Anyway」引导） | 文档 | 6.3 |
| 6.9 | 版本号注入（VERSION → CFBundleShortVersionString 一致性断言） | 构建 | 6.1 |
| 6.10 | M6 出口：.app 签名验证（spctl）+ DMG 挂载安装冒烟 | 门禁 | 6.7 |

### M7 · 性能优化（双端，W6，8 包，P1）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 7.1 | 会话池预热（首个导航前建窗；量化冷启耗时，双端） | 优化 | 1.7/2.10 |
| 7.2 | 空闲回收 60s + 内存基线测试（常驻 <150MB，双端） | 优化 | 1.7 |
| 7.3 | 提取带宽优化（只回传序列化结果；禁整页 HTML 回传） | 优化 | 1.5 |
| 7.4 | 多会话并发上限 3 + 排队策略（双端一致） | 优化 | 1.7 |
| 7.5 | Retina 截图坐标修正（point 坐标系，macOS） | 优化 | 2.7 |
| 7.6 | 提取管线批处理（Top N 结果并行提取，上限 3） | 优化 | 3.5 |
| 7.7 | 缓存命中率面板（hit rate + 节省 token 估算） | 可观测 | 3.9 |
| 7.8 | M7 出口：双端性能基准报告（对齐竞品基线三项） | 门禁 | 7.1-7.7 |

### M8 · 安全加固（双端，W6-W7，8 包，P0）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 8.1 | SBPL profile 评审（最小权限：无 network 默认；工作区外零写） | 安全 | 4.5 |
| 8.2 | 提取内容注入防御复核（provenance + 二元信号 + 弱评估器熔断） | 安全 | 3.6 |
| 8.3 | click/fill 前后态截图审计 + 敏感字段识别（password/token → always+掩码） | 审计 | 1.2/2.8 |
| 8.4 | 会话 cookie 隔离验证 + 沙箱逃逸测试集（符号链接/junction/管道继承/环境变量注入） | 测试 | 2.3/4.6 |
| 8.5 | Keychain ACL 审计（打包应用身份稳定 + 无明文回落） | 审计 | 4.2 |
| 8.6 | Windows 既有安全回归（Job Object/guard/DPAPI 不因重构回退） | 回归 | M0-M1 |
| 8.7 | 威胁模型文档（macOS 特有：TCC 权限滥用/AppleEvent/LaunchAgent） | 文档 | 8.1 |
| 8.8 | M8 出口：双端安全测试全绿 + 威胁模型评审 | 门禁 | 8.1-8.7 |

### M9 · 测试矩阵 / 真机验证 / 发布（W7-W8，12 包，P0/P1）

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| 9.1 | 单元：session_mac 全原语（Mock PyObjC 层，CI 可跑） | 测试 | M2 |
| 9.2 | 契约：6 新 js_api 差分（get_api_info 逐字节 + config.json 零污染） | 测试 | 3.1 |
| 9.3 | 集成：headless 后端全工具链（CI nightly） | 测试 | 2.11 |
| 9.4 | 平台：Keychain/Seatbelt 真机测试（仅 macOS runner） | 测试 | M4 |
| 9.5 | MacBook 冒烟：导航→等待→提取→点击→截图 全链路 | 冒烟 | M2/M3/M4 |
| 9.6 | 权限流：TCC（截屏/文件）+ Keychain 首次写入引导 | 冒烟 | M4/M5 |
| 9.7 | Gatekeeper 全流程：未签名→Open Anyway；签名→直开 | 冒烟 | M6 |
| 9.8 | 性能实测：双端冷启/导航/提取三基准对标 | 基准 | M7 |
| 9.9 | 回退验证：无网络/无权限/沙箱拒闯三异常路径 | 冒烟 | M8 |
| 9.10 | Windows 真机回归（浏览器完整化不破坏既有搜索 + 安装器不受影响） | 回归 | M1 |
| 9.11 | 发布文档（双平台安装指引：Setup exe / DMG + 权限说明 + FAQ） | 文档 | M6 |
| 9.12 | M9 出口：发布评审 + 归档（.app/.dmg/Setup exe/校验和/发布说明） | 门禁 | 9.1-9.11 |

---

## 7. 关键依赖与并行面

- **关键路径**：M0 → M1 → M2 → M3 → M4 → M5 → M6 → M9（约 10-12 周单人 / 6-7 周双人）
- **可并行**：M1（Win 完整化）与 M2（Mac 后端）可双人并行——共用 session_base 契约；M7 性能与 M8 安全并行；M9 测试矩阵随里程碑滚动；M9.11 文档可提前
- **外部硬依赖**：① Apple Developer Program 账号（$99/年，M6 前必须到位）；② macOS 真机 Intel + Apple Silicon 各一为佳（M4/M9）；③ arm64 CI runner（M6.3）
- **Windows 端零影响承诺**：M0 迁移回归 + M3.10/M9.2 契约差分 + M8.6 安全回归三重保证；`sys.platform` 分支外无行为变化；CONFIG_DIR_NAME 路径红线不动

---

## 8. 风险与验证

| 风险 | 等级 | 缓解 | 验证 |
|---|---|---|---|
| PyObjC 版本碎片化（9.x 多框架） | 中 | extras 锁定最低版本；CI 双 Python 验证 | M9.4 |
| Keychain 在 SSH/无 GUI 会话拒写（-25308） | 中 | 首次写入引导桌面会话完成；明确错误码人话 | M4.3/M9.6 |
| 公证流程卡住（税务/银行信息不全） | 中 | 提前注册开发者账号走完流程；未签名降级路径 | M6.6/M6.8 |
| SBPL 误伤（白名单过紧） | 中 | 最小 profile + 自检（尝试违规操作）；三档网络策略 | M4.6 |
| 沙箱无 rlimit（资源炸弹） | 中 | 监控+告警降级；文档化 | M8.7 |
| .app 内更新破坏签名 | 中 | 整包替换策略 + Gatekeeper 重引导 | M4/M9.7 |
| 双平台行为分歧（等待/提取/交互语义） | 中 | 三后端一致性 fixture；抽象层单一定义 | M2.12 |
| Windows 完整化回归破坏既有搜索 | 中 | M1.10 搜索回归 + M9.10 真机回归 | M1/M9 |
| 体量（58-66 人日） | 中 | P2 可砍（DMG 美化/性能 7.6 可顺延；M5 UI 可分期但建议不拆） | 里程碑出口评审 |

---

## ⚠️ 假设

- 工作量按 v1.8 已落地浏览器四件套复用度估算（M0/M3 大量为泛化而非新写）；PyObjC 学习曲线已按 3 人日计入 M2
- macOS 真机在 W4-W8 可用；Apple Developer 账号可由项目方提供
- 「AI 直接驱动」范围 = 6 工具原语 + dual-LLM-lite 提取；不含自主多步网页任务规划（那属浏览器 Agent 化，另立项）
- 竞品基线（<150MB 常驻）延续 v1.8 验收口径
- Windows 安装器（Setup exe）与 macOS 安装器（DMG）双轨并存，installer_core 核心逻辑可跨平台复用，GUI/打包各端独立

## 免责声明

⚠️ 本方案基于公开调研（pywebview 官方文档/PyInstaller 与 Apple 公证实践/Keychain C API 实践/Seatbelt 沙箱先例）与代码库实测编制；Apple 平台政策（公证/签名/TCC）以官方最新文档为准；重要架构决策请由技术负责人审定。
