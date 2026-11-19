# HANDOVER-R61 — 真机反馈轮（界面 / 编码 / 请求链路 / 提示词 / 缺陷排查）

> 日期：2026-11-09。接续 `HANDOVER-R60.md`。本文自包含，接手者无需阅读历史对话。
> 项目：Harbor / GLM-Chat v1.9.0。生产链为 **Electron 主进程 + server/ Node 服务 + 单文件 `harbor.html`**（R54 起，PyInstaller 链仅 legacy）。
> 用户约定：交付可运行且已验证的结果；逐项排查直到可用；既有资产（尤其模型文件）只增不删；**不得主动启动 exe**，真机截图由用户提供。

---

## 0. 一眼总览

| 维度 | 当前状态 |
|---|---|
| 源码 | **本轮全部改动未提交**（24 个已跟踪文件修改 + 3 个新文件）；最新提交仍是 R60 的 `e4cdee6` |
| 全量回归 | `pytest tests/ -q` → **2057 passed / 0 failed / 3 skipped** |
| UI 契约 | PASS（40 DOM id / 13 onclick / 43 callApi / 39 类 / 21 变量） |
| 契约基线 | `contract-baseline-r61.json`，`--compare` **零漂移**（117 模块 / 1310 符号 / 1309 函数 / 14 样式） |
| 后端差分 | 30 fixtures / 291 calls / match 279 / intentional 11 / suspect 1 / **error 0**（suspect 为既有 guard-chain 项，与本轮无关） |
| 新增测试 | `server/test/local-proxy.mjs` 11 项 PASS |
| 安装包 | `dist-electron/Harbor-Setup-1.9.0.exe`，226,702,625 B，sha256 `1114431769c1a912496b447ac7ec23b5f0830cbed47c976a8db4a54ccde0bb76` |
| 版本 | `VERSION=1.9.0`；`API_VERSION='v1.0.0'`（契约，不可动） |
| 真机 | **尚未由用户确认**，需重装并重启应用后按 §8 复验 |

本轮分五个子轮：R61（编码/UI/死代码）→ R61b（删除项目/去强调色）→ R61c（Failed to fetch 真因）→ R61d（默认简体中文）→ R61e（缺陷排查，7 处修复）。

---

## 1. 交接前必读：工作区状态

### 1.1 未提交清单（`git status --short`）

**已修改（24）**
```
backend/prompts/manifest.json          backend/prompts/system-base.md
backend/prompts/system-ws-off.md       deliverables/dev-plan/design-2026-11-01-local-proxy-pending.md
electron/main.js                       frontend/manifest.json
frontend/react/dist/harbor-island.iife.js   frontend/react/src/SessionHistory.jsx
frontend/react/src/index.jsx           frontend/react/src/island.css
frontend/src/agent/run-controller-base.js   frontend/src/agent/run-controller.js
frontend/src/group/group.js            frontend/src/providers/provider.js
frontend/src/providers/request.js      frontend/src/sessions/controller-base.js
frontend/src/sessions/controller.js    frontend/src/shell/island-host.js
frontend/styles/features/chat.css      harbor.html
server/package.json                    server/src/app.js
server/src/services/provider.js        server/src/services/system.js
```

**新增（3，另加本报告）**
```
deliverables/dev-plan/contract-baseline-r61.json
server/src/services/local-proxy.js
server/test/local-proxy.mjs
```
> 本报告 `HANDOVER-R61.md` 同样是新增文件，不计入上述 3 个；提交时一并纳入。

> 关键：`harbor.html` 与 `frontend/react/dist/harbor-island.iife.js` 是**被 git 跟踪的构建产物**，必须与源码一起提交，否则接手者 checkout 后源码与产物不一致，`check_contract.py` / `contract_diff` 立刻漂移。
> `dist-electron/` 目录目前只剩当前包一个 exe；历次备份 exe（`*-R60-backup.exe` 等）已不在目录，不要依赖它们做回滚。

### 1.2 相关文档
- `.workbuddy/memory/2026-11-09.md`：本轮逐子轮工作日志（事实底稿）。
- `deliverables/dev-plan/design-2026-11-01-local-proxy-pending.md`：已加 §0「R61c 落地记录」，关闭「待落地」状态；§一~§四 保留为历史留档，其中「未实现」等描述已失效。
- `KNOWN_ISSUES.md`：历史与遗留登记。

---

## 2. 用户反馈与验收口径

| # | 用户原话 / 反馈 | 验收标准 |
|---|---|---|
| 1 | 「无法正常使用」：群聊主持人连续两次「【主持人 调用失败】Failed to fetch」 | 模型请求成功返回，界面出现 token 统计 |
| 2 | 选择中文路径文件夹乱码（菱形问号 U+FFFD） | 项目名、路径行、tooltip、历史目录按钮均正常显示中文 |
| 3 | 项目空间不好区分；样例要求「每个项目单独显示项目文件夹名字、点一下收缩展开、无乱码」 | 独立卡片、文件夹名主标题（完整两行）、整头折叠、不同项目可分辨 |
| 4 | 「并行」按钮没意义；「没被调用就直接去掉，不保留」 | 按钮与相关死代码全库清零 |
| 5 | 项目删不掉；「不要单独搞其他颜色的强调色」；补充「文件夹图标需要」 | 项目可删除；无装饰性彩色强调；文件夹图标保留为中性灰 |
| 6 | 「系统提示词加一句『始终用简体中文回复，除非用户明确要求其它语言』」 | 四处处渲染路径均含该规则 |
| 7 | 「排除bug」 | 对本轮改动做专项复审并修复真实缺陷 |

---

## 3. 根因与修复（含决策权衡）

### 3.1 中文路径乱码（R61）
**根因**：`server/src/services/system.js` 的 `ps()` 用 `execFile('powershell.exe', ...)`，Windows PowerShell 5.1 stdout 走 OEM/GBK 代码页，Node 默认按 UTF-8 解码 → 中文路径变 U+FFFD；`pickFolder`/`pickSavePath` 直接 `stdout.trim()` 把损坏串返回前端。同一界面其它中文正常，正是「数据已损坏」而非字体问题的判据。

**修复**：
- `ps()` 加 `PS_UTF8_PRELUDE`（`[Console]::OutputEncoding` + `$OutputEncoding` = UTF8）、`encoding:'buffer'`，`decodePowerShell()` 按 UTF-8 优先 / `decodeConsole()` GBK 启发兜底、剥离 BOM。
- 两个对话框改走 **base64(UTF-8) ASCII 输出通道** `psDecodePath()`，彻底绕开 stdout 代码页歧义。
- 前端两侧显示层：按 Unicode 字符截断、路径感知；含 U+FFFD 的历史数据显示「路径编码异常，请重新选择文件夹」，并提供 `↻` 一键重新绑定（不删项目/会话）。

### 3.2 Failed to fetch（R61 → R61c）
**根因**：`design-2026-11-01-local-proxy-pending.md` 记载的 P0-4 缺口——Python 时代有 `LocalCorsProxy`（127.0.0.1:0 懒启动），Node 迁移只保留 `get_local_proxy` 的 `{ok,port,base_url}` 响应形状，**监听器从未实现**，`getLocalProxy()` 恒 `ok:false` → 前端回落 Chromium 直连 → 系统代理（Clash）拦截 → `Failed to fetch`。

**R61 的两次绕行（未解决，保留为双保险）**：Electron `proxy-bypass-list`、可诊断中文错误文案、`onHeadersReceived` 回环 CORS 兜底。用户第三次反馈「还是这样」后确认必须补齐监听器。

**R61c 正解**：新增 `server/src/services/local-proxy.js`。链路为
`浏览器 → http://127.0.0.1:<随机端口>（回环，不走系统代理）→ Node fetch → 真实端点`。Node 不读 Windows 系统代理设置，故绕开 Clash。

安全口径（**受控转发，不是任意 URL 转发器**，这是为了避开历史上 Mimosa 对通用转发器的 SSRF 误判）：
1. host 必须命中静态官方白名单，或 `config.json` 已登记端点；回环还要求端口在已知集或配置里；
2. 路径白名单，最终 URL 由已验证 URL 对象重建并**保留 base_url 路径前缀**（设计文档 §三 的 `new URL(reqPath, base)` 会丢掉 GLM 的 `/api/paas/v4` 导致 404，已修正）；
3. 非回环目标 DNS 解析到私网/保留地址则拒绝（解析失败交 fetch 报真实错误，避免代理先掐死可用连接）；
4. CORS 只回显可信来源（`harbor://app` / `null` / 回环），绝不 `ACAO:*`；补 Chromium **PNA 预检** `Access-Control-Allow-Private-Network`；
5. 32MB 请求体上限 / 5 分钟超时 / `redirect:'manual'`。

接线：`getLocalProxy()` 改懒启动返回 `ok:true`；`app.js` onClose 加 `shutdownLocalProxy()`；`resolveApiEndpoint()` 收紧为「代理可用时一律走回环」；`electron/main.js` 的 `onHeadersReceived` 改为只在上游无 ACAO 时补 `*`，不覆盖代理头。

### 3.3 项目空间 UI / 删除 / 强调色（R61、R61b）
- 两侧实现同步（React 岛 `SessionHistory.jsx` + legacy `controller-base.js`）：每个项目独立卡片，主标题为**文件夹名**（完整两行），副标题父路径，`title` 保留用户命名与完整路径，整头点击折叠，右侧会话数。
- 用户明确「不需要强调色」→ 删除 4 档色条、`toneOf`/`_projectTone`/`data-tone`；**文件夹图标保留**但改中性 `var(--text-3)`；active 背景、focus 环、异常文字、↻ 按钮全部中性化。
- 删除入口：React 岛 `i-project-del`（与折叠按钮并列的 `i-project-head-row`，避免 button 嵌套），`index.jsx` 透传 `onDeleteProject`，`island-host.js` 接 legacy `deleteProject`；legacy 侧 `data-project-delete` + `_bindSessionGroups` 绑定。
- `deleteProject()` 语义：`uiConfirm` 二次确认 → 删 `projects` 条目 → **项目下会话保留并转为普通任务**（不删历史）→ 解除后端工作区绑定 `delete_session_ws` → 清折叠态 → 持久化 → 刷新两处 → toast。放在 `controller.js`（刷新函数同模块，避免 R59 依赖棘轮新增前向边）。

### 3.4 死代码清理（R61）
全库检测确认 `harborStartParallelRun`、`runAgentLoopParallel`、`opts.parallel` **零调用**（唯一调用方是已删除的「并行」按钮），按用户要求直接删除：函数体、注释、CSS、manifest 声明、产物残留全部清零。`runAgentLoop` 的并行判定改为完全自动（存在其它会话在途 run 即并行）。

### 3.5 默认简体中文（R61d）
`backend/prompts/` 与前端设置原本都没有语言约束，模型按输入语言对齐（`hi` → 英文），不是故障。用户确认全局默认中文后，**四处同步**：`system-base.md`（工作区开）、`system-ws-off.md`（工作区关）、`provider.js` 两个降级兜底硬编码串。`manifest.json` 两条 sha256/bytes 重算、version `1.0.0 → 1.1.0`（`tests/test_prompts_w0.py` 与 `test_v19_prompts.py` 会逐条对拍，不同步必挂）。

### 3.6 缺陷排查（R61e，7 处）

| # | 严重度 | 缺陷 | 修复 |
|---|---|---|---|
| 1 | 高 | `save_config` 写 `provider_base_url`，代理 `dynamicAllow()` 原只读 `base_url`/`local_base_url` → **切换自定义端点后请求全被 403** | 补读 `provider_base_url`；配置 TTL 10s → 1s |
| 2 | 高 | 群聊 `useEp` 跨端点分支直连成员端点、不带代理头 → 系统代理下复发 Failed to fetch | 该分支也走回环代理，`X-Harbor-Target` 指向成员端点 |
| 3 | 中 | `ensureLocalProxyRunning()` 无单飞，启动正常路径与「桥晚到补偿」并发时各起监听器、端口泄漏 | `_starting` Promise 单飞，失败复位 |
| 4 | 中 | SSE 中途出错时 `jsonError()` 把 JSON 追加进已输出的事件流 | 已发头时仅 `res.end()` |
| 5 | 中 | 删除项目后会话仍绑定已删项目工作区 | 补 `delete_session_ws` |
| 6 | 低 | 岛层 async 回调同步 try 接不住 Promise rejection | 显式 `.catch` |
| 7 | 低 | `shutdownLocalProxy()` 未清并发标记 | 同步清理 |

---

## 4. 改动文件清单（逐文件用途）

### 后端 `server/`
| 文件 | 改动 |
|---|---|
| `src/services/local-proxy.js` | **新增**：本地 CORS 代理（受控转发、白名单、PNA、CORS、单飞） |
| `src/services/provider.js` | `getLocalProxy()` 改懒启动返回 `ok:true`；两处 `buildSystemPrompt` 兜底串加中文规则；import 新模块 |
| `src/services/system.js` | `ps()` UTF-8 前导 + buffer 解码；`decodePowerShell()` / `psDecodePath()`；两个对话框 base64 通道 |
| `src/app.js` | onClose 追加 `shutdownLocalProxy()` |
| `package.json` | 新增 `test:localproxy` 脚本 |
| `test/local-proxy.mjs` | **新增**：11 项回归（懒启动/并发单飞/`provider_base_url` 放行/OPTIONS+CORS+PNA/缺头 400/白名单 403/路径 403/POST 透传/SSE 分块/base 路径前缀/请求体原样/`get_local_proxy` 契约面） |

### 前端源码 `frontend/src/`
| 文件 | 改动 |
|---|---|
| `providers/provider.js` | `resolveApiEndpoint()` 收紧：代理可用时一律走回环 |
| `providers/request.js` | 网络层错误翻译成含端点与排查方向的中文提示 |
| `group/group.js` | 跨端点群聊（`useEp`）改走代理并带 `X-Harbor-Target` |
| `sessions/controller-base.js` | 路径 helper（`_pathSegments/_pathIsCorrupt/_folderName/_projectDisplayName/_shortDir`）、项目名显示文件夹名、损坏路径提示与 `↻`、删除按钮 HTML |
| `sessions/controller.js` | 新增 `rebindProjectFolder()` / `deleteProject()`；`_bindSessionGroups` 绑定 `data-project-rebind` / `data-project-delete` |
| `shell/island-host.js` | mount 传 `onDeleteProject`；两个 async 回调 `.catch` 收口 |
| `agent/run-controller.js` / `run-controller-base.js` | 删除并行死代码、修正误导注释 |
| `styles/features/chat.css` | 项目卡片化、中性化、两行名称、`.project-delete` / `.project-rebind` |

### React 岛 `frontend/react/src/`
| 文件 | 改动 |
|---|---|
| `SessionHistory.jsx` | 项目卡片化、文件夹名主标题、整头折叠、`i-project-del` 删除按钮、移除「并行」按钮与 `toneOf` |
| `island.css` | 项目卡片中性样式、`i-project-head-row`、删除按钮；删除 4 档强调色 |
| `index.jsx` | 透传 `onDeleteProject`，挂载契约注释同步 |

### Electron / 提示词 / 产物 / 文档
| 文件 | 改动 |
|---|---|
| `electron/main.js` | `proxy-bypass-list`（可经 `HARBOR_PROXY_BYPASS` 覆盖/关闭）；`onHeadersReceived` 仅在上游无 ACAO 时补 `*` |
| `backend/prompts/system-base.md` / `system-ws-off.md` | 各加一句中文回复规则 |
| `backend/prompts/manifest.json` | 两条 sha256/bytes 重算、version → 1.1.0 |
| `frontend/manifest.json` | 增减顶层符号登记（去重后的 1310 符号） |
| `harbor.html` | 构建产物（32,332 行） |
| `frontend/react/dist/harbor-island.iife.js` | 岛层构建产物 |
| `deliverables/dev-plan/contract-baseline-r61.json` | **新增**契约锚点 |
| `deliverables/dev-plan/design-2026-11-01-local-proxy-pending.md` | 加 §0 落地记录，关闭待落地状态 |

---

## 5. 工程铁律（违反 = 契约事故）

1. **js_api 契约零变更**：新增方法必须登记 `backend/api.py` 的 `_V12_EXTRA`（隐身，`get_api_info()` 不列）；转正只改实现体。门禁 `pytest tests/test_api_contract.py`（legacy vs new 逐字节）。本轮**未新增任何 js_api**，只改了 `get_local_proxy` / `build_system_prompt` 等既有方法实现体。
2. **`config.json` 零污染**：新配置存独立文件。本轮代理只读 `config.json` 的 `provider_base_url` / `local_base_url` / `base_url`，**不写**。
3. **版本分离**：`API_VERSION='v1.0.0'` 不可动；`VERSION`（发布线，用户管）→ `APP_VERSION` 动态读。
4. **前端构建纪律**：只改 `frontend/index.template.html` + `frontend/src/*.js` + `frontend/styles/*.css` + `frontend/react/src/*`；按以下顺序重建，**勿手改 `harbor.html`**：
   ```
   cd frontend/react && node build.mjs      # 生成 dist/harbor-island.iife.js
   cd ../.. && node frontend/build.js       # 拼出 harbor.html
   ```
   `build.js` 会校验 `manifest.json` 的 `provides` 与文件顶层符号严格一致。**踩过的坑**：在模板字符串里嵌套反引号会破坏其顶层符号扫描器的引号状态机，导致后续函数集体变成「幽灵符号」；新增函数必须同步登记 `provides`/`requires`。
5. **契约基线棘轮**：`tests/test_contract_diff.py` 自动取 `contract-baseline-r<N>.json` 中最大 N 做零漂移比对。**本轮已生成 r61**；接手者若再改前端源码，必须生成 **r62**：
   ```
   python tools/contract_diff.py --snapshot deliverables/dev-plan/contract-baseline-r62.json
   ```
   否则 `test_baseline_exists_and_current_contract_has_zero_drift` 失败。
6. **UI 契约**：`python deliverables/design/check_contract.py` 校验 40 DOM id / 13 onclick / 43 callApi / 39 类 / 21 变量，只增不改。新增动态类名不在此集合。
7. **依赖棘轮（R59）**：88 条冻结前向边只减不增（`tools/gen_allowlist.mjs --check`）。新增函数要放在「其依赖已加载」的模块；`rebindProjectFolder`/`deleteProject` 放 `controller.js` 正是为此。
8. **提示词纪律**：改 `backend/prompts/*.md` 必须同步 `manifest.json` 的 sha256 / bytes / version；哈希口径为「文本读（CRLF→LF）后 UTF-8 编码」，两组测试会逐条对拍。Python legacy 与 Node 共用同一 prompts 目录，故差分 `build_system_prompt` 两侧同步变化。
9. **测试口径**：全量回归必须写 `pytest tests/ -q`。**不带路径**的 `pytest -q` 会收集 `deliverables/wave-backups/` 下历史测试副本，产生 377 个 import mismatch collection errors（既有环境问题，非回归）。
10. **UISeam**：R59 起事件环走 `registerUISeam`/`uiSeamCall` 星型缝，不要重新引入跨模块直接环。

---

## 6. 可复现的验证命令

```bash
# 环境（本机固定路径）
PY="C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
NODE="C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
cd "C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包"

# 1) UI 契约
"$PY" deliverables/design/check_contract.py

# 2) 契约差分（零漂移）
"$PY" tools/contract_diff.py --compare deliverables/dev-plan/contract-baseline-r61.json

# 3) 本地代理回归（11 项）
cd server && "$NODE" test/local-proxy.mjs && cd ..

# 4) 后端差分
cd server && "$NODE" test/diff/run-diff.mjs --all && cd ..
# 期望：30 fixtures / 291 calls / match 279 / intentional 11 / suspect 1 / error 0

# 5) 后端单套
cd server && "$NODE" test/provider-http.mjs && "$NODE" test/smoke.mjs && "$NODE" test/system-misc.mjs && cd ..

# 6) 全量 pytest（约 8-11 分钟）
"$PY" -m pytest tests/ -q
# 期望：2057 passed / 3 skipped / 0 failed

# 7) 定向：提示词 + 依赖棘轮 + 项目空间
"$PY" -m pytest tests/test_prompts_w0.py tests/test_v19_prompts.py \
  tests/test_session_project_redesign.py tests/test_contract_diff.py \
  "tests/test_r59_deps.py::TestFrontendDepsRatchet::test_ratchet_check_passes" -q

# 8) 语法
for f in server/src/services/local-proxy.js server/src/services/provider.js \
         server/src/services/system.js server/src/app.js electron/main.js \
         frontend/src/group/group.js frontend/src/shell/island-host.js \
         frontend/src/sessions/controller.js frontend/src/providers/provider.js; do
  "$NODE" --check "$f" || exit 1
done
```

**运行时删除语义验证**：本轮用系统 TEMP 下的临时 Node vm 脚本（`harbor_r61b_verify.js`）加载 `controller-base.js` + `controller.js`，注入 sessions/projects/localStorage 桩，断言项目数 1→0、关联会话 1→0、普通任务 1→2、折叠清除、持久化、两处刷新、`delete_session_ws` 调用一次，结果 PASS。该脚本不在仓库内，需要时可依此描述重建。

---

## 7. 构建 / 打包 / 离线环境要点

- **无外网**。`ELECTRON_MIRROR=npmmirror` 不是合法 URL，会报 `Invalid URL`；不带 mirror 时 electron-builder 尝试下载 Electron 会 502。
- **离线打包法**（本轮成功）：本地已有 `node_modules/electron/dist`（Electron 45.2.1）与 `%LOCALAPPDATA%/electron/Cache/*.zip`。用系统 TEMP 下的临时配置 `harbor-builder-offline.yml`（内容 = 项目 `electron-builder.yml` + 一行 `electronDist: "C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包/node_modules/electron/dist"`），执行：
  ```
  npx --no-install electron-builder --win nsis --config "<TEMP>/harbor-builder-offline.yml"
  ```
  正式 `electron-builder.yml` **未改动**。`files` 白名单已含 `electron/**/*`、`harbor.html`、`backend/prompts/**/*`、`server/src/**/*`、`server/node_modules/**/*`，新增 `local-proxy.js` 会被打进 asar。
- `safe-delete` 钩子会拦 `dist/` 下旧 exe 的删除；本轮用 `mv` 改名保留旧包再打包（备份 exe 现已被清理，勿依赖）。
- PyInstaller 链（`Harbor.spec` / `dist/`）是 legacy；生产是 Electron（`dist-electron/`）。
- 打包后建议核验 asar：
  ```
  npx --no-install asar list dist-electron/win-unpacked/resources/app.asar | grep -F "server\src\services\local-proxy.js"
  ```
  本轮还用 Python 流式搜索 asar 二进制确认修复标记（`provider_base_url` / `_starting` / `delete_session_ws` / `R61e` / `始终用简体中文回复` / `ensureLocalProxyRunning` / `i-project-del`）全部命中。

---

## 8. 真机复验清单（接手者第一步）

**必须先重装 `dist-electron/Harbor-Setup-1.9.0.exe` 并重启应用**——`get_local_proxy` 只在 `bridgeDependentInit()` 启动时取一次，提示词也有缓存，仅重装不重启不生效。按约定不要主动启动 exe，请由用户操作并提供截图。

| # | 复验项 | 期望 |
|---|---|---|
| 1 | 单聊 / 群聊发消息 | 正常返回，有 token 统计，不再出现 `Failed to fetch` |
| 2 | 控制台 `JSON.parse(await callApi('get_local_proxy', []))` | `{ok:true, port>0, base_url:"http://127.0.0.1:<port>"}` |
| 3 | 控制台 `window.__localProxyBase` | 指向 `127.0.0.1` |
| 4 | 新建项目选中文路径文件夹 | 项目名/路径行/tooltip 中文正常，无菱形问号 |
| 5 | 项目空间外观 | 每个项目独立卡片、文件夹名单独一行、可点击折叠、中性灰无彩色条、文件夹图标在 |
| 6 | 项目删除 `✕` | 二次确认后项目消失，原会话保留为普通任务 |
| 7 | 历史记录会话卡片 | 无「并行」按钮 |
| 8 | 发英文 `hi` | 默认简体中文回复；明确说「用英文回答」时例外 |
| 9 | 切换自定义端点后发消息 | 正常（R61e 修复点 1） |
| 10 | 群聊成员绑定其它端点 | 正常（R61e 修复点 2） |
| 11 | 历史残留乱码项目 | 显示「路径编码异常，请重新选择文件夹」，可用 `↻` 重新绑定或直接删除 |

---

## 9. 已知边界、遗留项与风险

### 9.1 本轮边界（非缺陷）
- **代理是受控转发**：跨端点群聊若使用「自定义且未保存到设置」的端点，静态白名单仍会 403，但会返回可读错误；把该端点填进设置保存（写入 `provider_base_url`）即放行。这是安全边界，不要为方便改成任意 URL 转发器。
- **Clash TUN / 全局网络层接管、机器确实无外网出口**：Node 进程发出的请求同样到不了 GLM，任何应用层方案都无效。
- **系统提示词非绝对保证**：纯英文短输入仍可能被模型按输入语言对齐；「除非用户明确要求其它语言」按用户原句保留。若需强制，可追加「即使用户使用英文提问，也用简体中文回复」（需重算 manifest 哈希）。
- **删除项目语义**：项目消失、对话保留为普通任务。若产品口径改为连会话一起删，需追加 `session_purge` 并调整确认文案。
- `get_local_proxy` 响应形状未变，但语义由 `ok:false`（无代理）变为 `ok:true`（有代理）；若下游有代码按 `ok:false` 分支处理，需复核。

### 9.2 R60 遗留（本轮未动）
- 推送经用户指示中止：远端 main 指向等效重放链（32/48 笔已上），本地 origin/main 未 fetch；余 16 笔待续推。**禁止** `fetch + reset --soft`（会挤掉 R46-R59 提交）；续推流程见 `HANDOVER-R60.md` §1。
- 88 条冻结前向边棘轮：只减不增，逐批叶化/缝化为长期项。
- R58 候选 `render_ui/parentId` 分支树：属新功能迭代，列 R62 候选。
- OTel 远程 / A-P10 / hub-catalog 外链：P2 需产品决策。
- pywebview 链并行串行化：观察项，Electron 生产链零影响。
- macOS、性能基准、逃逸测试、代码签名：未做。
- 新版界面、流式渲染、浏览器六原语、CAPTCHA：仍需真机确认。
- `design-2026-11-01-local-proxy-pending.md` 的 P1 缺口 **本轮已关闭**。

### 9.3 风险提示
- 本轮改动**未提交**，存在工作区丢失风险；接手后第一优先是提交（含两个构建产物与 r61 基线）。
- 本地代理是新增网络监听面（仅 `127.0.0.1` 随机端口）。若后续要放宽白名单，必须同步评估 SSRF 与 DNS 重绑定，并补 `server/test/local-proxy.mjs` 断言。
- 前端 `resolveApiEndpoint()` 现在「代理可用即一律走代理」；若将来 `get_local_proxy` 返回不可用（空 base_url），会逐层回落直连，行为不劣化，但会重新暴露系统代理问题。

---

## 10. 诊断速查

| 现象 | 排查 |
|---|---|
| `Failed to fetch` | 先看控制台 `get_local_proxy` 是否 `ok:true`；再确认 `window.__localProxyBase`；若均正常，检查 Clash 是否 TUN 模式 / 机器是否有外网出口 |
| 代理返回 403 | 读响应体 `{"error":"X-Harbor-Target 不是已登记的官方端点或本地模型端口"}`；把端点填进设置保存，或确认使用静态白名单域名 |
| 代理返回 400 | 缺 `X-Harbor-Target`；检查 `localProxyHeaders()` / 群聊 `useEp` 分支 |
| 代理返回 404 | 多半是 base_url 路径前缀丢失；正常实现应拼成 `<base>/chat/completions`（GLM 为 `/api/paas/v4/chat/completions`） |
| 中文路径菱形问号 | 历史损坏数据：用 `↻` 重新绑定；新选路径仍乱码则查 `ps()` 编码链 |
| 契约测试失败「符号丢失」 | 改了前端源码但没生成新基线 → 生成 `contract-baseline-r62.json` |
| 构建失败「幽灵符号」 | 模板字符串里嵌套了反引号，或新增函数未登记 `manifest.json provides` |
| `pytest -q` 377 个 collection error | 误收 `deliverables/wave-backups/`；改用 `pytest tests/ -q` |

---

## 11. 环境与工具路径

| 项 | 路径 / 值 |
|---|---|
| Python (pytest) | `C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe` |
| Node | `C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（v22.22.2；项目 engines 声明 Node 27 基线，但本轮全部脚本在 22 下通过） |
| 工作区 | `C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包` |
| 配置目录 | `%USERPROFILE%/.glm-chat`（`HARBOR_CONFIG_DIR`，`config.json` / `harbor.db` 在此） |
| 离线打包临时配置 | `%TEMP%/harbor-builder-offline.yml` |
| 用户机器 | FreeToken Desktop（`127.0.0.1:1919` OpenAI 兼容）；GLM 端点 `open.bigmodel.cn` |
| 网络 | 无外网；系统代理（Clash）会拦 Chromium 直连 |

---

## 12. 接手建议

1. **立即提交**本轮 24 个修改 + 3 个新文件（含 `harbor.html`、island 产物、r61 基线），提交信息建议 `feat(R61): 真机反馈轮——中文路径编码修复/项目空间重做与删除/本地 CORS 代理落地/默认简体中文/缺陷排查 7 项`。遵守用户「不用推送」的历史指示，先只做本地提交。
2. **按 §8 组织用户真机复验**，拿到截图后再判定是否还有残留问题；不要主动启动 exe。
3. 复验通过后，若继续迭代，优先候选是 R58 `render_ui/parentId` 分支树；若做性能/安全加固，优先把本地代理的白名单与 PNA 行为补更多边界测试。
4. 任何前端源码改动后，按 §5-4 重建产物、按 §5-5 生成新契约基线，再跑 §6 全部门禁。

> 事实与判断的区分：本文「根因」「验证数字」「命令输出」为已复核实测；「接手建议」「风险提示」为基于当前状态的工程判断，需结合真机复验结果再定。
