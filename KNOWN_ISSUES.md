# 已知 Bug 与遗留问题清单

**当前版本**：v1.9.0 | **更新日期**：2026-10-25

> 本文保留各版本的历史问题与验收记录；历史测试数量、版本号和“未实现”描述只代表当时状态，不作为本轮 QA 结论。当前测试与发布结果以当次 QA 运行为准。
>
> 状态图例：🔴 未处理 | 🟡 部分处理/有条件规避 | 🟢 已处理（仅记录）

---

## 一、环境限制类（本机无法闭环，需目标机验证）

### 1. 起窗冒烟未做（GUI 真机验证受阻）
- **描述**：v1.3-v1.5 全部功能仅在自动化测试层验证（pytest + node vm 沙箱 + 本地回环服务器），未在真实 WebView2 窗口做端到端冒烟。2026-10-17 尝试三种 GUI 自动化方案均受阻：CDP 端口被本机安全软件拦截 Python 出站连接；开发模式直接跑页面白屏；坐标点击受窗口 z-order 干扰。
- **影响范围**：全部交互功能（理论风险低——测试层已全覆盖，但未经真实窗口确认）
- **处理状态**：🔴 未处理。已在 `main.py` 增加 `GLM_CDP_PORT` 环境变量开关（默认关，生产零影响）为后续验证铺路。

### 2. 本地模型 `/api/tags` 元数据优化未经 UI 真机验证
- **描述**：v1.5 新增的第四级元数据来源（Ollama `/api/tags` 权威声明优先于前缀猜测）在代码层验证通过（含真实 Ollama 实测：qwen3.5-9b → 256k + tools），但未经设置面板 UI 确认展示效果。
- **影响范围**：本地模型元数据徽标显示（窗口值/tool 能力标注）
- **处理状态**：🟡 一键销项就绪（2026-10-19 v1.6 遗留 L3）。目标机跑 `python deliverables/scripts/target_verify.py --ollama-url http://localhost:11434`，Ollama 项 PASS 即销项（脚本已覆盖 /api/tags + /api/show + 最小 generate 冷启动路径）。

### 3. 性能基准未实测
- **描述**：MCP 连接池改造目标为「本地回环 P95 -40%」（roadmap §6），WebDAV 上传下载、本地模型冷/温启耗时均无真实基准数据。
- **影响范围**：性能宣称（功能正确性不受影响）
- **处理状态**：🔴 未处理。基准脚本方法已就绪（127.0.0.1 自建回环服务器）。

### 4. WebDAV 未与真实服务器联调
- **描述**：WebDAV 执行器（PROPFIND/PUT/MKCOL/GET + 冲突四策略）仅在本地回环测试服务器验证，未对接真实 WebDAV 服务（坚果云/Nextcloud 等）。
- **影响范围**：WebDAV 备份/恢复的真实服务器兼容性
- **处理状态**：🔴 未处理。已留 `test_connection`（OPTIONS+PROPFIND）供用户一键自检。

---

## 二、平台与兼容性

### 5. 仅支持 Windows
- **描述**：依赖 pywebview（EdgeChromium）、ctypes DPAPI、PIL.ImageGrab、send2trash 等 Windows 专有路径；macOS/Linux 未适配（v1.3 PRD Non-goal）。
- **影响范围**：非 Windows 用户完全不可用
- **处理状态**：🟢 已明确为设计边界（roadmap 未排期）

### 6. 杀软误报风险
- **描述**：PyInstaller onefile 打包的 exe 可能被杀毒软件误报（尤其是含 ctypes/进程操作代码的自更新替换逻辑）。
- **影响范围**：首次运行被拦截 / 自动更新失败
- **处理状态**：🟡 部分处理。发布说明中需提示用户加信任；代码签名未做（成本未排期）。

### 7. WebView2 Runtime 依赖
- **描述**：未安装 WebView2 Runtime 的 Windows 10 旧版系统无法启动（已有友好提示框）。
- **影响范围**：Windows 10 老旧系统
- **处理状态**：🟢 已处理（启动失败弹原生 MessageBox 引导安装）

---

## 三、功能边界（roadmap 已规划未排期）

### 8. MCP resources / prompts 能力未实现
- **描述**：MCP 客户端仅实现 tools 能力；resources/prompts（如 Context7 的 instructions 展示）未接入（roadmap：建议 v1.5 发布后硬化审查再排期）。
- **影响范围**：MCP 服务器的高级能力利用率
- **处理状态**：🔴 未处理（roadmap v1.6+ 候选）

### 9. MCP OAuth 认证未实现
- **描述**：仅支持无认证 / Basic / 自定义 header；需要 OAuth 流的 MCP 服务器不可用。
- **影响范围**：企业级 MCP 服务器接入
- **处理状态**：🔴 未处理（roadmap v1.6+ 候选）

### 10. 多模态输入已支持（历史缺口已关闭）
- **当前事实**：对话支持图片、视频与文本附件输入；只读/纯聊天模式下文本附件不会写入工作区。实际视觉/视频理解能力取决于所选模型和端点。
- **历史记录**：v1.3 时对话输入尚不支持图片/文件拖拽，该结论已过时。
- **处理状态**：🟢 输入链路已实现；模型侧能力差异属于端点边界。

### 11. 云端同步/账号体系未实现
- **描述**：数据主权仅本机 + WebDAV 手动备份；无账号、无自动云同步。
- **影响范围**：多设备同步场景
- **处理状态**：🔴 未处理（WebDAV 为既定方案，v1.6 起）

---

## 四、已知小问题（测试钉住的行为）

### 12. 400 双降级链每轮只走一次
- **描述**：请求带 tools 收 400 时，若同时含 thinking 字段错误与 tools 不支持特征，当轮只降 thinking 不降 tools（下轮才生效）。
- **影响范围**：极小概率场景（自定义端点同时拒两种字段）
- **处理状态**：🟢 已记录为设计取舍（防病态端点诱导无限重试）

### 13. 本地模型元数据为估计值时的标注
- **描述**：前缀启发式推导的窗口/工具能力显示「（估）」标注；用户可在设置手设覆盖（手设值持久化到 config.json）。
- **影响范围**：元数据准确性（有 UI 出口）
- **处理状态**：🟢 已处理（估计值明示 + 手设覆盖 + `/api/tags` 权威源优先）

### 14. 压缩备份上限 50 条
- **描述**：就地压缩的单份可恢复备份超过 50 条后旧备份被挤出（v1.4 设计上限，防磁盘膨胀）。
- **影响范围**：深度压缩历史的可回溯深度
- **处理状态**：🟢 已处理（PRD 既定上限）

---

## 五、用户环境备注（非软件缺陷）

### 15. ModelScope MCP 免费期
- **描述**：用户自配的 ModelScope MCP 端点（函数计算 FC / PAI-DSW）仅三个月免费，到期不可用。
- **影响范围**：该 MCP 服务器的可用性
- **处理状态**：⚪ 用户侧事项（与软件无关）

---

## 六、v1.6 命令沙箱模块（2026-10-19 新增）
### 16. 沙箱已实现：Job Object 进程隔离 + 资源限制（后端核心完成）
- **范围**：run_command/run_powershell 默认走沙箱（standard 档：1GB 内存/16 进程/120s CPU/UI 限制 basic）；run_admin_command 显式排除（提权进程无法被中型父进程收编）；配置 `~/.glm-chat/sandbox.json`（不碰 config.json）；js_api：sandbox_get_config/sandbox_save_config/sandbox_status（隐身）
- **架构与风险矩阵**：deliverables/dev-plan/sandbox-architecture-2026-10-19.md
- **测试**：tests/test_sandbox.py 24 项真实 Win32 API 全过；全量 584 passed / 契约 PASS
- **处理状态**：🟡 后端核心完成；设置面板 UI 未接线（默认开箱生效）；真机起窗冒烟待做（同第 1 条）

### 17. 沙箱的已知能力边界（诚实缺口，文档化接受）
- **网络隔离不可达**：零依赖 + 无管理员前提下，Job Object 不含网络控制；沙箱内进程可外联。缓解：guard 审计可见 + 「netsh 封禁助手」脚本（需用户 UAC，opt-in）
- **剪贴板/截屏隔离不可达**（2026-10-21 R23 实测修订）：Job Object 的 JOB_OBJECT_UILIMIT_READCLIPBOARD（0x2）/ WRITECLIPBOARD（0x4）Flag **实测无效**——Win32 探针（父进程建 Job 设 Flag + AssignProcessToJobObject 收编子进程）三组对照（无 Job / READCLIP / READ+WRITE）子进程 OpenClipboard 全部成功（tests/test_r23_clipboard_flag.py 固化；Windows 交互桌面口径）。故 sandbox strict 档**不加**剪贴板 Flag（加了是安慰剂）。沙箱内进程仍可绕过应用层直接调 Win32 API，由 guard 三档确认兜底（应用层）
- **文件系统越界仅为应用层校验**：未做 ACL/AppContainer（与零依赖单文件约束冲突）；沙箱内进程直接调 API 写工作区外路径理论上可行，威胁模型主要为提示注入驱动的外联（R5/R6 同源）
- **处理状态**：🟡 文档化接受（sandbox-architecture §5 R4/R5/R6）；根治需重新评估定位（AppContainer 或独立低权限用户，涉及打包与启动链）

### 18. 【已修复】P0 潜伏 bug：非桩路径命令「执行成功但向 Agent 报错」
- **根因**：`cmd_service._exec` 的 Popen 路径 `return proc`——`proc.stdout` 是 BufferedReader 而非字节，`_dec(result.stdout)` 必抛 AttributeError。自 v1.1 重构起存在，被测试桩（stub subprocess.run）全面掩盖；真机现象=命令实际执行（弹窗/副作用发生）但 Agent 收到错误 → 重试 → 「cmd 反复弹窗」用户报告的部分同源
- **修复**：返回 `subprocess.CompletedProcess(popen_args, proc.returncode, communicate() 捕获的字节)`；回归测试 `test_cmd_service_no_sandbox_path_unchanged`（沙箱集成时实测发现）
- **处理状态**：🟢 已修复（584 passed 含回归）

---

## 七、v1.7 安装体验重构（2026-10-19 新增）

### 19. 安装器未做代码签名（SmartScreen 预期告警）
- **描述**：`Harbor-Setup-1.7.0.exe` 无 Authenticode 签名，首次运行 Windows SmartScreen 会拦截提示「未知发布者」。PyInstaller onefile + 未签名安装器的行业通例
- **影响范围**：新用户首次安装体验（点「更多信息 → 仍要运行」可继续）
- **处理状态**：🟡 Runbook 就绪（2026-10-19）。代码签名需购买证书（OV ¥1.5–4k/年 / EV ¥5–9k/年，**采购为人工项，AI 不可为**）——证书选购比价、signtool 双签命令、验证口径、CI 插入点、与自更新的关系已全部写成一条龙：`deliverables/dev-plan/release-signing-runbook.md`。证书到手后 10 分钟完成三 exe 签名；未签名期间发布说明引导文案保留。

### 20. 安装器 GUI 依赖 WebView2 Runtime
- **描述**：安装向导用 pywebview（与产品同栈）；未装 WebView2 的 Win10 旧系统无法显示向导。已做降级：原生 MessageBox 指引安装 WebView2 + 提示静默安装（`/S`）
- **影响状态**：🟢 已处理（降级路径 + 指引文案）
- **真机验证**：🔴 **回退待重走**（2026-10-21 复盘）：此前走访（2026-10-19）的截图显示纯黑、GUI 运行时路径未验证——真实窗口虽启动，但桥调用 / 进度轮询 / 完成页均未经过运行时闭环（pywebview evaluate_js 在沙箱会话不可用，DOM 断言以静态断言等价覆盖，不构成运行时证据）。已修复：installer_gui 桥返回值未 JSON.parse、安装失败误显「✓ 安装完成」（poll 错误分支）、未等 pywebviewready 即取 api、Uninstall.exe 无法删除自身（退出后 detached PowerShell 延迟补删）、check_target 每次按键 makedirs 副作用、卸载目录硬编码默认（改为 --dir > Uninstall.exe 所在目录含 Harbor.exe 校验 + install.json > 注册表 InstallLocation > 默认目录定位链）。待交互式会话重走全链路：选目录 → 安装 → 立即运行 → ARP 卸载。

---

## 八、第六轮·前端核心修复对抗证伪 + 遗留项清剿（2026-10-21 新增）

### 21. MCP 资源读取防连点（mcpResBusyUri）为单槽语义——有兜底，文档化接受
- **描述**：`29-mcp.js` 的 `mcpResBusyUri` 单字符串槽位在「两个不同资源并发读取」时，先完成者会把槽清空，理论上允许对同一 uri 的第三次并发读取。评估结论：**有兜底**——每个资源行的「读取」按钮在在途期间 `disabled=true`（UI 主防线），重复 uri 行并发读取需同时满足「同一服务器 resources 列表含重复 uri」+「三行同 uri 交错点击」，且后果仅为重复读取（无数据损坏）
- **处理状态**：🟢 文档化接受（不改为 Set——按钮级禁用已覆盖真实路径；改动面大于收益）。测试：`tests/test_round6_adversarial.py` 固化其余各项回归

### 22. 恶意 plan.task_id 依赖后端 skip 语义闭环（前端不 strip）
- **描述**：WebDAV/本地恢复的 sessions 数据可含恶意 `plan.task_id`（超长/含路径字符）。`normalizeSessions` 白名单只放行不校验（`String(x.plan.task_id)`），唯一消费路径是 `deleteSession → session_purge`；后端 `_safe_tid`（`^[A-Za-z0-9_-]{1,64}$`）对非法 tid **skip + warning 不抛**，purge 整体仍 ok、其余痕迹照清
- **处理状态**：🟢 设计决策（前端不重复校验）：后端 skip 语义已闭环（`tests/test_round6_adversarial.py::TestPurgeMaliciousTaskIdClosedLoop` 固化），前端额外 strip 会造成「前端放了后端拒」与「前端拒了后端本可清」的双口径分叉。保存往返（saveSessions 30000 字符截断）后 task_id 存活性已由白名单测试固化

### 23. 少数 focus 延时未令牌化（R27 已收口）
- **描述**：`32-session-search.js`（30ms）、`63-search-panel.js`（60ms）、`68-onboarding.js`（80ms）的 focus 延时仍为字面量；`110-boot.js bridgeDependentInit` 的 get_api_info 重试间隔 800ms 为重试语义（非动效，不属本项）
- **R27 处理（2026-11-05）**：新增 `--dur-focus-xs/-sm/-md`（30/60/80ms，tokens.css）+ `MOTION.focusXs/focusSm/focusMd`，三处调用改为经 MOTION 读取；**数值精确不变**（行为兼容），`body.fx-off` 变量级降级块把三令牌覆盖为 0ms（reduced-motion 下立即 focus）。`72-shortcuts` 既有 `MOTION.staggerSm()` 范式保持不变。测试：`tests/test_r27_upgrades.py`（默认值/源码去硬编码/CSS 覆盖矩阵）。
- **处理状态**：🟢 已处理（R27）

---

## 九、MCP 资源读取无档位判定的设计决策（2026-10-21 新增）

### 24. read_resource 为面板显式触发，不经 Agent 工具链，故无 guard 档位判定
- **描述**：`mcp_service.read_resource`（backend/domains/integrations/mcp/mcp_service.py:649，经 api.py `mcp_read_resource` 暴露为 js_api 方法）由用户在 MCP 面板对具体资源点「读取」按钮显式触发（frontend/src/29-mcp.js:448），与 `mcp_call_tool` 走 Agent 工具链（resolve_tier 定档 + 档位确认，mcp_service.py:435/459/485/514）不同：本方法无 tier 判定、无确认弹窗。安全性依赖：① 触发源是用户显式操作而非模型自主调用，用户对自己选定的服务器与资源负责；② 全程审计（op=mcp_resource，逐次记录 uri 与 text/blob 计数，T12 安全口径）；③ 资源内容等同工具结果进入对话上下文后，模型后续自主工具调用仍受 guard 三档约束，注入内容无法自行提权执行
- **影响范围**：MCP 资源读取的确认强度（低于 Agent 侧 call_tool）
- **处理状态**：🟢 设计决策（文档化接受）：如未来把 resources/read 开放为 Agent 可调用的 LLM 工具，需先补 resolve_tier + 对应档位确认再接入工具面，禁止以现状直接暴露给模型

---

## 十、第七轮·第五轮前端面板修复对抗性证伪 + 遗留项清剿（2026-10-21 新增）

背景：第五轮（077e8e1）前端面板修复此前未做对抗证伪（批次代理被中断）。本轮对
63/64/65/67/69 五面板 + 29/37/38/90/95/27/16 七模块逐项构造反例（vm harness
门控放行确定性时序），结论与修复如下。测试：`tests/test_round7_adversarial.py`（20 用例）。

### 25. 63-search-panel：CAPTCHA 重试分支按钮死局（已修复）
- **反例**：`browser_takeover continue` 复检仍为验证页时，后端 `entry['state']='prompting'` 回到等待态（search_service.py:881，注释明示「用户可再次 continue」），但 round5 前端 `retrying=true` 保持继续/放弃双按钮禁用 → toast「请重试」与禁用按钮自相矛盾，用户既不能继续也不能放弃，面板因 captcha 态关不掉 → 死局（唯一出路是另发新搜索）
- **修复**：重试分支改为解禁 + `searchPanelShowTakeover(d.error)` 刷新「继续（重试 n/3）」文案；在途防连点由入口禁用保证（后端 continue 幂等 + max_retries=3 兜底）
- **附带**：`searchPanelHideTakeover` 成为唯一收口——接管区收起即解禁双按钮（防 takeoverAction 在途被新搜索取代后 finally 因 seq 陈旧跳过复位 → 按钮永久禁用的孤儿态）+ captcha 态防御性复位（保「无接管会话就无 captcha 态」不变式，Esc/点外关闭不被拦）

### 26. 63-search-panel：接管竞态两处 + TTL 到期提示遗留项（已修复）
- **竞态 1**：pending 期轮询镜像可能把旧会话 takeover_id 挂进 `searchTakeoverId`，搜索成功时成功分支无清洗 → 成功态滞留 captcha 框。修复：成功分支清洗接管区
- **竞态 2**：终态（success/error）或面板空开（idle）后，滞留的旧会话 captcha 快照会经 setPhase 复活接管 UI（僵尸接管 + 误拦关闭）。修复：setPhase 挂接门控 `searchPanelState === 'pending'`
- **TTL 到期提示（原遗留项 A4，已实现）**：接管 TTL（后端 600s）到期前 60s 一次性 toast——`search/panel.js` 已落地 `SP_TAKEOVER_TTL_S=600` / `SP_TAKEOVER_WARN_LEAD_S` / `spTakeoverWarned`（每会话一次，新会话在 `spTakeoverReset` 重置），面板轮询复用 `takeover.elapsed_s` 零额外成本。R27 复核确认代码在位，本条由「遗留项」改为「已实现」；href 白名单矩阵（大写 scheme 放行 / 协议相对与 javascript:/file: 拦截 / fragment 无害）经 vm 验证成立

### 27. 64-software-panel：测试调用被其他在途流吞输出 + swDetail 覆写（已修复）
- **反例 1**：测试调用与列表/探测/保存共用 `softwareReqSeq`——探测约秒级返回而测试调用可跑数百秒，探测完成即使在途测试的返回被判陈旧静默丢弃：调用已真实执行（有副作用）却无任何输出渲染，用户重复点击即重复执行。修复：测试流独立 `swTestSeq`（同 63 面板 spStatsSeq 先例）
- **反例 2**：`softwarePanelRenderError` 整块覆写 `#swDetail`，测试在途时探测/刷新失败会摧毁测试 UI → `swTestOut` 失踪、输出永久丢失。修复：`swTesting` 在途时改走 toast 不碰测试区
- 另：`swCallElapsed` 复位移入 finally（陈旧路径一并归零）；陈旧路径 finally 四清（timer/按钮/swTesting/elapsed）经 vm 验证

### 28. 65-hybrid：NaN 校验整表回弹清空用户输入（已修复）
- **反例**：字段级校验失败原调用 `hybridRefresh()` 整表重渲染——异步返回时会把用户正在其它字段输入的内容一并清掉（刷新重渲染所有输入框）
- **修复**：`hyRevertField(el, key)` 仅复位犯规字段（配置已加载时）；无已加载配置才回落全量刷新。hyRdSeq 陈旧路径按钮态、connectIsLocalPreset 不存在降级经 vm 验证成立

### 29. 证伪成立无需改动项（证据见 tests/test_round7_adversarial.py）
- 63：finally seq 早退/正常路径终态一致；「旧 finally 晚于新分支」结构性不可达（所有入口先 ++seq 再动 DOM，旧 finally 的 seq 守卫必失败）
- 67：planShow 在途 reject 以 AbortError 传播、planModeRun catch（100-send.js:216-218）干净收尾且 isStreaming 已提前复位（无水球冻结）、无 unhandled rejection；rbTwice RPC 失败即移除浮层（按钮随之消失不永禁）、三连点单次 RPC；clarify 全按默认取 q.default 不与 .on 混合
- 69：删除前重取逐条文本比对可检出等长位移（中段淘汰/前部截尾）；MM_FEATURE_KEY 关闭不挂载不刷新；信封错误分支显示 error 不渲染空列表
- 29-mcp 独立 busy 交错不互吞；37-webdav 失败加载也建快照后「填新值→导出前自动保存」链路成立（保存失败即中止导出）；38-ws-quick 三连击退场竞态 + 委托 try/finally 刷新必执行；90-attachments n→0→n+1 快速序列 done 复核成立（_attachCount 拼写唯一）；95-compress 3s 兜底 + onload clearTimeout + settled 守卫；27-update 轮询续试总超时 1000 拍有效；16-panel-fx newEl null 守卫不影响正常路径
- G 组遗留确认：mcpResBusyUri 现状与 §八.21 文档一致；34-local-model stale 复位 seq 判定正确；36-connect cmIdentifyBtn 按当前预设重刷文案分支正确

---

## 历史发布检查清单（v1.5.0，非当前验收结论）

- [x] 全量测试 480 passed
- [x] UI 契约 check_contract.py PASS
- [x] 前端构建 40 模块幂等
- [x] 敏感信息扫描干净（无 API Key / 无个人 MCP 配置 / 无 DPAPI 密文）
- [x] VERSION = 1.5.0，exe 内嵌版本一致
- [x] 窗口标题显示应用版本（v1.5.0）而非契约版本

### 19. 【已校准】R20 DeepSeek preset 模型名/价格 + R21 GLM web_search 结构化结论（2026-10-21）
- **R20**（官网实测 `api-docs.deepseek.com/quick_start/pricing`）：现行模型名为 `deepseek-flash` / `deepseek-v4-pro`（ctx 1M / max out 384K / 高峰价 flash \$0.15+0.6、pro \$0.3+1.2 每 1M tok，非高峰半价）；preset 原 `deepseek-v4.1-256k`/`deepseek-v4.1` 已退役（旧名仍接受、由 V4.1-Flash-1017 服务）。36-connect.js preset 与 host 模型表已校准
- **R21**（GLM web_search 升级结构化 API）：GLM 内置 web_search 无公开结构化参数文档（模型黑盒触发）；本版自有 `browser_search` 通道（联调规范 §3.1）已覆盖「Harbor 侧构造检索参数」的同一目标，且双通道按端点自动选（R11 裁决口径）——R21 判定为与自有通道重复，不再单独投入；后续如 GLM 开放结构化 web_search 参数面再评估
- **处理状态**：🟢 R20 已校准（preset+host 表+价格注释）；🟢 R21 结论记录（不重复建设）

---

## v1.9.0「全域版」进行态（2026-10-23 登记）

### 20. v19 迭代进度与环境坑（开发期记录，随批次更新）

- **已完成**：M1 全量（T01 契约资产 / T02 browser 平台抽象包+搜索栈迁移，commit `d0044e0`，1196 passed）；M2 部分（批 2a：dual-LLM-lite 读取器 + provenance，commit `8691f51`；批 2b：Bing RSS 双通道 + 缓存分级 TTL + 输出四连洗，commit `e6fe2be`，1249 passed；已推远端 `65a13550`）；批 2c/2d/3a（RSS 主路径+provenance 三接入+审批预算+审计哈希链+检查点六军规，至 `0f9a21f` 1306 passed）
- **2026-10-24 新增完成（批 3b + 批 4 M3/M5 + 批 5 前端）**：
  - 批 3b（M2.10 MCP 收尾）：定期重验（24h/1h/15min 三档按健康度）+ lastReverifyAt/reverifyEnabled 纯增键（set_reverify_at 直写 + absent-keep 防抹）+ schema_poison_signals 四维投毒检测 + derive_tier input_schema 纯增 kwarg + resolve_tier tier_source='schema-poison'（38 测试）
  - M3（Win 浏览器六原语）：driver.py（BrowserService 会话池 + Bridge 提取桥 + DriverWindow 驱动次窗）+ session_win click/fill/screenshot 真实现（注入防御/视口外拒点/敏感字段拒填/前后态截图审计）+ win_capture.py（PrintWindow PW_RENDERFULLCONTENT）+ 下载拦截/外链策略 JS + 可见/隐藏模式 + browser_sessions.json 投影
  - M5（AI 驱动工具面）：六 js_api 转正（guard 矩阵 click/fill=always）+ tools_schema 六原语（strict：additionalProperties:false+enum+required）+ AGENTS.md（R44 三段式描述）+ M5.7 反爬（extract_guarded CAPTCHA_REQUIRED）
  - 批 5 前端：25-tool-exec 六原语分发 + agentGuardCheck browser 分支 + maybeBudgetInvite 任务授权邀请 + 26-guard 预算条（grant-budget）+ 28-audit-viewer 链块（audit-chain）+ 34-local-model 读取器状态灯（reader-status）+ 67-plan-card tools 徽标/approved_at/回滚两步 confirm + build 幂等 + UI 契约 PASS
- **本轮 bug 修复（10 项实证）**：① driver.navigate 会话并发移除 KeyError 竞态；② win_capture GDI 选中对象删除泄漏（3MB/次）；③ MCP TOFU 重验竞态（hash 对拍与 tools 交换原子化）；④ guard token 摘要不绑 browser 参数（W4 同型）；⑤ enforce_exec_ex 预算升级短路 grant/rule/trusted 授权链（改 reason 先行）；⑥ approval_budget.limit 不落盘（重启回 20）；⑦ DriverWindow eval_js 僵尸 worker 破坏单门串行（_pumpable 退役）；⑧ _drop 持池锁做窗口销毁 IO（锁外关闭）；⑨ click 文本 XPath 单引号转义缺失（谓词注入+错误码失真）；⑩ checkpoint git 模式 manifest 记工作区哈希令恢复后校验恒假失败（改记 HEAD 版哈希）
- **环境坑（本机实测，非代码问题，处置路径已验证）**：
  - venv python stub 对中文用户 profile 路径解析失败（exit 103，`did not find executable at C:\Users\?\...`）——**降级路径**：系统 `C:\Python315\python.exe` + `PYTHONPATH` 指向 venv 的 `Lib\site-packages`（QA 侧用 vendor python 3.13.14 同效，两路独立收敛）
  - PowerShell 会话不继承 git PATH——先 `$env:Path += ";C:\Program Files\Git\cmd"`；bash 的 MSYS 中文路径转换已坏，git/构建命令一律走 PowerShell 工具
  - 子代理工具环境间歇性 502（127.0.0.1:7863 代理拒连）——本地命令不走代理；重试一次仍失败则记录「环境故障未执行」并继续后续项，勿反复撞同一失败调用
- **行为变更备案**：CACHE_TTL_MINUTES 30→60（R30，general 档分级 TTL）——test_v18_search_service 两处 + `_mk_service` 默认 + test_v19_browser 共 4 处断言同步（方案原计两处，grep 实扫补全）；M5 转正后 test_release_discipline 占位断言更新（六 browser 方法正向转正断言 + get_platform_info 唯一剩余占位）
- **实现偏差登记**：会话池「上限 3 + 排队」实现为「驱逐最旧空闲」（master-plan §149 3.7）——js_api 同步调用无等待语义，LLM 调用方无法等待异步 close 事件；驱逐最旧空闲（Chrome tab discard 同型）+ 60s 空闲回收兜底，语义等价且不阻塞调用方
- **2026-10-24 第二批（批 6/7：M4+M6 理论实现 + M7 打包资产 + M8 静态项 + brw-mode 面板）**：
  - M4 session_mac.py：WKWebView 六原语**理论实现**（PyObjC 延迟探测 mac_backend_available；WebView 工厂/桥依赖注入——Windows 用 fake 全测；真机链路验证 M9.5）；create_session('mac') 工厂接线（PyObjC 缺失→UNSUPPORTED_PLATFORM 结构化降级）；BrowserService 工厂平台分支 + _settle_ready 上移基类 + navigate 等待先行修正
  - M6 platform/mac.py：七接口理论实现——Keychain（ctypes Security C API + SSH -25308 人话引导）/ sandbox-exec（**build_sbpl 纯函数**：deny default+最小 profile+网络三档，Windows 全测）/ Quartz 截屏（TCC 人话）/ NSFileManager 废纸篓 / ~/Library/Application Support/Harbor 路径 / ps 进程 / NSUserNotification；get_platform_info js_api 转正（os/machine/七接口就绪度/browser_backend mac 标注）
  - M7 打包资产：Harbor-mac.spec（BUNDLE+Info.plist 三键+版本注入 M7.9）/ tools/build_mac.sh（icns→PyInstaller→codesign 由内而外→notarytool→DMG 七步）/ mac-entitlements.plist（App Sandbox 不开决策记录）/ mac-unsigned-fallback.md（Gatekeeper Open Anyway 引导）——**理论支持，macOS 真机执行验证 M9**
  - M8 静态项：会话池预热 preheat()（M8.1，fake 可测）/ 威胁模型文档 deliverables/security/threat-model-v19.md（M8.9：T1-T7 + R42 两级答案归档）
  - 批 7 前端：71-browser-driver.js（brw-mode 面板：会话池视图/可见隐藏切换 browser_set_mode/手动工具条/UNTRUSTED 警示纹）+ 69-platform.js 接 get_platform_info 权威数据源 + boot 挂载；构建幂等（57 模块）+ UI 契约 PASS
- **处理状态**：🟡 开发中（M1+M2+M3+M5 完成 / M4+M6 macOS 理论实现（PyObjC 就绪即启用，真机验证 M9.4/9.5）/ M7 打包资产就绪待 mac 构建 / M8.1+8.9 静态项完成（8.5 基准/8.8 逃逸测试集待目标机）/ M9 发布文档草稿在位；每批过门禁：pytest 全绿 + 契约差分 + build 幂等）
