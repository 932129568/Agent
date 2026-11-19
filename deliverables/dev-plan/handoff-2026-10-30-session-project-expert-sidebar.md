# Harbor 交接报告 · 2026-10-30

> 交接对象：下一个会话的主理人/工程师/QA  
> 工作区：`C:\Users\陈\Desktop\GLM-Chat-v1.0.0-完整开发包`  
> 版本：`1.9.0`（未提交，工作区有大量历史未提交修改）  
> 纪律：不启动 `Harbor.exe` / 安装器；不覆盖旧候选；不把 API Key 写入源码或报告。

---

## 0. 交接结论（先读这一段）

当前代码已经完成：

1. 新会话独立选择页；
2. 项目空间（自定义名称 + 专属文件夹 + 项目内持续新建对话）；
3. 任务/空间分组、折叠、项目内新建对话；
4. 专家中心全中文 + 使用说明；
5. 专家在输入框内选择，发送时自动加载；
6. “允许完全访问”开关，普通对话不再有文件夹选择；
7. 历史会话固定到左侧栏；
8. 单活动 run 的后台继续与四态状态点；
9. 移动端侧栏改为抽屉，并修复 375 默认展开问题。

但**还没有完成**用户最新提出的 7 项架构级需求：

1. 真正的多会话并行、多任务隔离、任务交接报告；
2. 全模型统一思考模式与档位映射；
3. 移除所有 token 硬限制、允许亿级 token 长任务；
4. 内置浏览器取消搜索缓存、实时搜索；
5. 浏览器操作默认后台、不抢前台；
6. CAPTCHA/登录人工协助按会话弹窗并自动回后台；
7. “确认状态响应缓慢”的性能根因排查与修复。

**当前不能称为“全部完成”或“全功能测通”。**

---

## 1. 当前代码与构建基线

| 项目 | 值 |
|---|---|
| 当前 `harbor.html` | `1,355,247` bytes |
| 当前 SHA256 | `0a81878a1fe16d6bb8e579f29507ada6341b317ad3d1f8b07cba70a64bcc30fb` |
| build×2 | 一致 |
| 最新目标测试 | `13 passed`（`test_sidebar_run_status.py` + `test_session_project_redesign.py`） |
| 最新全量（移动抽屉最终修复前） | `1767 passed / 0 failed / 3 skipped / 1 deselected` |
| 最终修复后全量 | **尚未重跑**；只跑了 build×2 + 13 项目标测试 |
| `VERSION` | `1.9.0` |
| 当前 Harbor 进程 | 交接时未发现存活进程 |

### 关键纪律

- 不要运行 `TestSilentEndToEnd`，它会启动真实安装器。
- 全量测试必须使用：
  ```bash
  -k "not test_silent_install_uninstall_roundtrip"
  ```
- 不要启动 `Harbor.exe`，除非用户明确要求真机验收。
- 不要删除或覆盖已有 `dist/`、`outputs/release-w9-final*`。
- 不要把 `~/.glm-chat/config.json` 中的 Key 写入源码、报告、日志。

---

## 2. 已完成并验证的功能

### 2.1 新会话选择页

- `#newChatScreen` 已存在，位于 `#panelChat` 内、`#chatContainer` 前。
- 侧栏“新建对话”、会话面板“新建对话”、`Ctrl+N` 都进入该页。
- 选择历史会话或新建任务/项目后进入聊天。
- 无会话启动显示选择页；有会话启动打开最近会话。

关键文件：

- `frontend/index.template.html`
- `frontend/src/sessions/controller.js`
- `frontend/src/components/select.js`

### 2.2 项目空间

项目模型：

```js
{ id, name, workspace, createdAt, updatedAt }
```

- 存储：`localStorage['glm_projects']`
- 会话字段：`projectId`、`projectName`、`projectWorkspace`
- 创建项目：名称必填 + 工作文件夹必填（`pick_folder` 或手输）
- 项目内新建对话：复用 `project.workspace`，调用 `set_session_ws(sid, workspace, true)`
- 无项目 = 任务；有项目 = 空间

关键文件：

- `frontend/src/sessions/controller.js`
- `frontend/src/sessions/store.js`
- `frontend/index.template.html`

### 2.3 任务/空间分组

- 侧栏 `#sidebarHistory` 固定显示。
- 任务组可折叠。
- 空间按项目分组，每个项目可折叠。
- 项目组显示项目名、文件夹短路径、项目内“新建对话”按钮。
- 中央 `#newChatHistory` 保留 DOM，但已 `hidden`，历史只在左侧显示。

已验证：

- 375 / 768：抽屉内可见、可滚动；1280：固定侧栏。
- 分组头 44px、会话项 59px、无横向溢出。
- `hidden` 折叠已修复：`display:none / height:0`。

关键文件：

- `frontend/src/sessions/controller.js`
- `frontend/index.template.html`
- `frontend/styles/features/chat.css`
- `frontend/styles/shell.css`

### 2.4 专家中心与专家选择

- 专家中心全中文：
  - 单专家 / 专家团
  - 已启用 / 已停用 / 内置
  - 角色 / 限制 / 技能与资料
  - 使用说明（仅目录导入、包内容不可信、scripts 不执行、发送时自动加载）
- `expertSelectBtn` 文案：`选择此专家（发送时自动加载）`
- `expertPickerBtn` 在输入区。
- `expertSelectionChip` 在 `.input-row` 内。
- `#expertRunSelectedBtn` 保留 DOM 但 hidden，不再可见。
- `sendMessage()` 检测 `expertNextSelection`，回车和发送按钮都会自动走专家 run。
- 运行失败保留选择；只有 `completed` 才清空。

关键文件：

- `frontend/src/expert/center.js`
- `frontend/src/chat/send.js`
- `frontend/src/expert/controller.js`
- `frontend/index.template.html`
- `frontend/styles/features/expert.css`

### 2.5 权限简化

- 输入区 `#wsQuick` 文件夹选择器与 `#wsqInd` 已隐藏。
- 新增 `#accessToggle`：`允许完全访问`。
- 开 = `toolMode=full`；关 = `toolMode=readonly`。
- 说明文案：允许创建文件夹、写入文件和执行命令；仍受命令沙箱与安全护栏限制。
- 普通任务无可见文件夹选择；只有项目创建弹窗可指定工作文件夹。

### 2.6 左侧历史 + 后台 run + 状态点

已实现：

- `#sidebarHistory` 固定左侧；移动端 ≤768 为 off-canvas 抽屉。
- `#sidebarToggleBtn` 打开；`#sidebarBackdrop` 点击关闭；切会话/新会话自动关闭。
- session 新增 `runStatus`：`working` / `completed` / `paused` / `failed`。
- 状态显示：
  - working：主色脉冲 + “进行中”
  - completed：绿色 `#2fbf71`
  - paused/failed：红色 `#e55353`
- 启动时历史 `working` 迁移为 `paused`。
- 单活动 run：切换会话不 cancel，旧 run 进入后台；后台消息写 detached shadow，不污染当前会话。
- 活动 run 期间不切换 `set_current_sid` / `clear_caches`；工具批前绑定 run session；结束后恢复当前会话。
- 另一会话发送时提示“另一个会话正在运行，完成后可继续”，不启动第二 run。

关键文件：

- `frontend/src/agent/run-registry.js`
- `frontend/src/agent/run-controller.js`
- `frontend/src/chat/send.js`
- `frontend/src/sessions/controller.js`
- `frontend/src/sessions/store.js`
- `frontend/styles/shell.css`
- `frontend/styles/features/chat.css`

### 2.7 移动抽屉 375 修复

根因：`legacy.css` 的启动动画 `.sidebar{animation:v4BootRail ... both}` 在动画结束后保持 `transform:none`，覆盖 `shell.css` 的 `translateX(-102%)`。

修复：

```css
@media (max-width:768px){
  .sidebar{animation:none!important}
}
```

最新 Edge 实测（本报告生成前复跑）：

- 375×812 默认：`transform: matrix(...,-326.4,0)`、`left=-326`、`historyVisible=false`。
- 打开：`left=0`、`backdrop=true`。
- 遮罩关闭：回到 `left=-326`。
- 768×1024：默认收起；打开/关闭正常。
- 1280×720：固定侧栏 `left=64 / width=248`；collapsed 正常。

证据：

- `outputs/qa-w24/drawer-verify.json` 已由本次复跑覆盖为最新结果。
- 截图 `outputs/qa-w24/drawer-*.png` 可能混有旧版本，需以 `drawer-verify.json` 为准。

---

## 3. 最新候选与发布状态

### final5（旧，不包含最新侧栏/后台 run/抽屉修复）

路径：

```text
outputs/release-w9-final5-candidate/
```

- 基线：`a49ed3ece7d261a363ca012f53eb31f82796ef80cd4cdbe5f75655a9526ba01e`
- `Harbor.exe`：20,327,336 bytes / `1f2d1d9cc484edebe316d562a5a2ea80af9c097592b6d734c92736ecf66a8b29`
- Uninstall：12,258,054 bytes / `9024672c30b8ea14d7e8fe0f947b0ab9b45e2dbe8cbfd3e1b9d90c22021acf2e`
- Setup：44,431,839 bytes / `e0718ceeb5f79eae718dc60e05161c4b95cccbc137a3288507141be22dcf7057`
- QA 静态：`outputs/qa-w9/final5-report.json` PASS
- manifest：`QA_PASS_STATIC / USER_PENDING`

**不要直接把 final5 当最新版发布。** 它不包含：

- 左侧固定历史
- 后台 run / 状态点
- 移动抽屉
- 375 默认收起修复

### 需要做

- 当前源码 hash `0a81878a1fe16d6bb8e579f29507ada6341b317ad3d1f8b07cba70a64bcc30fb` 需重新构建 **final6**。
- 构建后仍要 QA 静态复验；不要启动 exe。

---

## 4. 未完成 / 未修复（按优先级）

### P0 · 真正多会话并行 + 多任务 + 交接报告（未实现）

当前实现仍是**单活动 run**：

- `RunRegistry` 单对象；
- `isStreaming` / `abortController` 全局；
- 后台 run 只是一个 run 继续，不能同时跑多个会话；
- 另一会话发送会被阻止。

用户新需求：

- 多会话并行且相互隔离；
- 同一项目下可并行多任务；
- 任务之间自动建立并维护交接报告；
- 交接报告可关联会话、只读读取，读取不得修改/打断原会话。

需要做：

- `RunRegistry` 改为按 sessionId 的 run Map；
- `isStreaming` 改为 per-session；
- `abortController` / usage / 状态 / 工具确认 / workspace 按 run 隔离；
- UI 投影按当前会话选择对应 run；
- 交接报告 schema、存储、生成时机、只读读取 API；
- 项目内多任务并发写同一 workspace 的冲突策略（建议 per-task 子目录 + 只读交接）。

### P0 · 全模型统一思考模式（未实现）

当前：

- `request-builder.js` 只支持 `thinking` / `reasoning_effort`；
- 不同 provider 的参数名不同（GLM、DeepSeek、Qwen、Moonshot、本地/自定义）；
- 设置可能对部分模型静默失效。

需要：

- 统一 UI 档位：低 / 中 / 高 / 自定义；
- provider 能力表 + 参数映射 + 请求前能力探测；
- 未知模型自动降级到兼容参数；
- 所有模型统一生效，并记录实际下发的参数。

### P0 · Token 限制移除（未实现）

当前仍存在：

- `session_budget` / `checkBudgetHardStop`
- `max_tokens`
- `autoResume <= 5`
- 300,000 token 提醒
- 上下文压缩 / 预算硬停
- 单任务轮次上限 60

用户要求：

- 移除所有会话/单任务 token 使用上限；
- 允许单任务突破亿级 token；
- 可保留不阻断的优化；
- 不得限制、中断或提前终止任务。

注意：

- 单次 API 回复仍受模型/服务商 `max_tokens` 与上下文窗口限制；
- “亿级 token”应通过跨轮持续运行实现，不是单次请求；
- 需要移除硬停、提前终止、自动续跑次数上限，并重新设计压缩/继续策略。

### P1 · 内置浏览器实时搜索 / 默认后台 / 人工协助（未实现）

当前：

- 存在搜索缓存路径（`search_cache` / search reader）；
- 浏览器驱动有隐藏/可见模式；
- CAPTCHA 接管仍可能是全局面板，不是对应会话弹窗。

需要：

1. 取消搜索缓存，统一实时搜索；
2. 模型浏览器操作默认后台执行，不切换前台；
3. CAPTCHA/登录在对应会话弹窗提醒；
4. 用户点击后打开可操作的内置浏览器；
5. 协助完成后自动退回后台，不停留前台。

### P1 · “确认状态响应缓慢”（未定位）

用户反馈：每次确认状态响应缓慢，此前很快。

当前状态：

- 已派 QA 做性能根因排查；
- 但该任务因 teammate runtime timeout 失败；
- **没有可信的根因结论或修复**。

需要重新做：

- 明确是工具确认、权限确认、设置确认还是状态栏刷新；
- 用 Edge/VM 测量点击到弹窗/状态更新的耗时；
- 检查重复 `renderSessionList`、`get_effective_ws` RPC、localStorage 全量写、事件重复绑定、动画/强制 reflow；
- 先证据后修复，不要凭猜测改。

### P1 · final6 构建与真机验收

- 当前源码 `0a81878a...` 尚未打包 final6。
- final5 静态 PASS ≠ 可启动。
- 未验证：
  - 真实 WebView2 加载/渲染
  - 项目文件夹 `pick_folder`
  - 后端 `set_session_ws` 落盘
  - 真实模型长跑/停止/失败
  - 内置 8 专家在 frozen 环境导入
  - 安装/卸载
  - macOS / 高 DPI 125%/150%/200%

### P2 · 后台 run 的已确认边界

- 切回正在后台运行的会话时，已有的 shadow 流式气泡不会重新挂回 DOM；完成时统一 `renderChatHistory` 展示终态，中途增量不实时重挂。
- 后台 run 命中工具确认 / CAPTCHA 时，仍可能触发全局面板或等待；未做真机会话级隔离。
- 真实 GLM-4.5-Flash 在 headless Edge 内 `fetch Failed`（外网不可达）；真实流式后台未在浏览器内跑通。
- 真实模型长跑、停止、熔断的 `runStatus` 端到端未验证。

---

## 5. 已知模型 / 端点问题

### GLM-4.5-Flash

- 当前 `~/.glm-chat/config.json` 已配置：
  - `provider_name: glm`
  - `provider_base_url: https://open.bigmodel.cn/api/paas/v4`
  - `provider_model: glm-4.5-flash`
  - `provider_prices: {in:0,out:0,cache:0}`
- 实测通过：
  - 最小对话
  - 流式
  - 工具调用 + tool result
  - 5 次稳定
  - 30,028 prompt tokens 长上下文
  - JSON 输出
  - 并发 3 路
  - 生成式 UI：TextBlock + Table DataRef（正确 schema 下）
- 关键边界：
  - 默认 thinking 开启时，小 `max_tokens` 会被 reasoning 吃满，正文为空；测试时需给足 token 或关闭 thinking。
  - 暂无发现 4.5 收费；官方免费。

### GLM-4.7-Flash

- 已加入 GLM preset / hot models / 价格 0。
- 实测当前官方持续 `429 / 1305 “访问量过大”`。
- 不是 Key 或 Base URL 错误；4.5 可用证明 Key 有效。

### Nemotron-3-Ultra-550B

- 端点：`https://legui.xyz/v1`，模型 `显卡一哥nemotron-3-ultra-550b`。
- 已跑 46 次真实请求，25 PASS / 2 FAIL。
- 当前 Key 间歇性 `401 INVALID_API_KEY`，且 12 次连续 401；不要再把该端点当稳定测试源。
- 2 个 FAIL：
  1. `response_format=json_object` 参数路径不稳定（3 次 1 次非法 JSON）；
  2. 生成式 UI 一次定向修复后仍失败，生产走 fallback。
- 报告：`outputs/nemotron-live/full-report.{json,md}`

---

## 6. 验证证据索引

| 内容 | 路径 |
|---|---|
| final5 静态复验 | `outputs/qa-w9/final5-report.json` |
| final4 静态复验 | `outputs/qa-w9/final4-report.json` |
| #22 会话/项目/专家复验 | `outputs/qa-w22/report-qa.json` |
| 侧栏/后台 run 证据 | `outputs/sidebar-history-run-status/report.json` |
| 移动抽屉几何 | `outputs/qa-w24/drawer-verify.json` |
| 移动抽屉截图 | `outputs/qa-w24/drawer-*.png` |
| 会话/项目/专家视觉证据 | `outputs/session-project-expert-redesign/` |
| Nemotron 全链路 | `outputs/nemotron-live/full-report.md` |
| GLM-4.5 真实测试 | `outputs/glm45-live/report.json` |
| GLM-4.5 生成式 UI | `outputs/glm45-live/genui-report.json` |
| GLM-4.7 导入/429 | `outputs/glm47-flash-import/report.json` |
| final5 manifest | `outputs/release-w9-final5-candidate/manifest.json` |
| final5 构建日志 | `outputs/release-w9-final5-candidate/build-all.log` |

---

## 7. 关键文件地图

### 会话/项目/侧栏

- `frontend/index.template.html`
- `frontend/src/sessions/controller.js`
- `frontend/src/sessions/store.js`
- `frontend/src/core/bootstrap.js`
- `frontend/styles/shell.css`
- `frontend/styles/features/chat.css`

### 专家

- `frontend/src/expert/center.js`
- `frontend/src/expert/controller.js`
- `frontend/src/expert/orchestrator.js`
- `frontend/src/chat/send.js`
- `frontend/styles/features/expert.css`

### Run/状态/后台

- `frontend/src/agent/run-registry.js`
- `frontend/src/agent/run-controller.js`
- `frontend/src/agent/model-executor.js`
- `frontend/src/core/state.js`
- `frontend/src/core/app-state.js`

### 模型/思考

- `frontend/src/settings/connection.js`
- `frontend/src/providers/provider.js`
- `frontend/src/agent/request-builder.js`
- `frontend/src/providers/request.js`

### 浏览器/搜索/人类接管

- `frontend/src/integrations/browser-driver.js`
- `frontend/src/search/panel.js`
- `backend/services/browser/*`
- `backend/services/search_reader.py`
- `backend/services/guard_service.py`

### 构建/安装

- `installer/build_setup.py`
- `Harbor.spec`
- `installer/Harbor-Setup.spec`
- `frontend/manifest.json`
- `frontend/build.js`

---

## 8. 建议的下一步顺序

1. **先修 final6 基线**：当前 `0a81878a` 已通过 375/768/1280 抽屉复跑和 13 项目标测试；先跑最终全量 + build×2，再打 final6。
2. **性能问题优先**：用户明确说“确认状态响应缓慢”，先定位再改。不要先动 7 项大功能。
3. **多会话并行架构**：把 `RunRegistry`、`isStreaming`、`abortController`、工具确认、workspace 上下文拆成 per-session。
4. **交接报告**：在并行 run 稳定后做，避免在单 run 架构上做无效报告。
5. **统一思考模式**：建 provider 能力表 + 参数映射；每模型真实请求验证。
6. **Token 上限移除**：移除硬停/轮次上限/自动续跑上限；保留不阻断的压缩与统计。
7. **浏览器/实时搜索/后台/人工协助**：在会话级 UI 就绪后做，避免全局面板回潮。
8. **final6 QA + 真机**：WebView2、pick_folder、set_session_ws、真实 GLM-4.5 长跑、安装/卸载。

---

## 9. 验证命令（安全口径）

```bash
# 目标测试（最新移动抽屉/会话/项目）
C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe -m pytest \
  tests/test_sidebar_run_status.py tests/test_session_project_redesign.py -q

# 全量（不得启动真实安装器）
C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe -m pytest \
  -q -k "not test_silent_install_uninstall_roundtrip" \
  --basetemp=outputs/pytest-tmp/handoff-$(date +%s)

# build×2
C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe frontend/build.js
sha256sum harbor.html

# 抽屉几何
C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe outputs/qa-w24/drawer-verify.js
```

### 构建 final6

不要覆盖 final5。使用隔离目录：

```bash
HARBOR_DIST=outputs/release-w9-final6-candidate/dist \
HARBOR_BUILD_ROOT=outputs/release-w9-final6-candidate/build \
outputs/release-w9-candidate/venv/Scripts/python.exe installer/build_setup.py
```

构建后必须做：

- 三产物 hash / payload / uninstaller / sha 一致
- CArchive/PYZ 含 webview / .NET / WebView2 / 8 个内置专家包
- 内嵌 `harbor.html` = 当前 `0a81878a…`
- 旧 final5/dist 未覆盖
- QA 静态复验 `QA_PASS_STATIC`

---

## 10. 纪律与红线

1. 不启动 exe/安装器，除非用户明确要求真机验收。
2. 不运行 `TestSilentEndToEnd`；它会启动真实安装器。
3. 不覆盖旧 `dist` / `final5` / `final6` 候选。
4. 不在源码/报告/日志写真实 API Key。
5. 不删除用户模型文件、历史目录、`~/.glm-chat` 配置。
6. `config.json` 零污染：新配置独立文件。
7. 新 js_api 必须登记 `backend/api.py` 的 `_V12_EXTRA`（隐身）。
8. UI 契约 40 DOM id / 13 onclick / 43 callApi / 39 CSS 类 / 21 变量只增不改。
9. 交付前必须给真实测试数、hash、失败项、UNCOVERED；禁止把“静态通过”说成“真机通过”。

---

## 11. 交接人最后确认

- 最新源码可 build：是
- 最新源码可测试：是
- 最新源码已 QA 最终签收：**否**（移动抽屉最终修复只做了 lead 复跑 + 13 目标测试，全量尚未在最终 CSS 修复后重跑）
- 最新 exe：**不存在**（final5 不含最新侧栏/后台/抽屉）
- 当前 Harbor 进程：未发现
- 未完成 P0：多会话并行、交接报告、统一思考、Token 上限移除、确认性能
- 未完成 P1：浏览器实时搜索/后台/CAPTCHA 会话化、final6 构建与真机

> 下一个会话请从“确认性能”与“final6 基线”开始；不要直接在 final5 上继续打补丁。
