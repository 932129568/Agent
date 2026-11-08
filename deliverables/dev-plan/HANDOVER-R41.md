# Harbor R41 轮报告（2026-11-07）——遗留全清轮

> 接续 `HANDOVER-R40.md` §6：**上轮 P1 两项 + R36-R38 交接 §5 全部剩余项一次性清账**
> （唯二例外见 §3 处置表）。R36→R41 六轮累计，§5 留档 35 项 + 后续新发现全部闭环。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 本轮提交 | 2 笔（feat 主批 / fix 卫生+锚点批）+ 打包产物（§6） |
| 修复/新增 | 18 项（资源 3 + 桥侧 1 + 前端卫生 7 修 1 维持 + 工具链 7） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r41**（1260 符号）/ audit PASS / 桥侧 20 PASS / **pytest 1950 passed / 1 failed（预存遗留）/ 3 skipped** / **harbor:// 烟雾 origin OK** |

## 1. P1 两项收官

### 1.1 pywebview 链虚拟主机映射（F2d 改法①全宿主覆盖）
`main.py _patch_webview2_foreground` 增：就绪回调 `SetVirtualHostNameToFolderMapping
('app.local', 仓库根, Allow)` + `load_url` 重写（harbor.html → `https://app.local/harbor.html`）。
任一环失败静默回落 file://；`HARBOR_PYW_NO_VHOST=1` 逃生口。与 R40 Electron 侧
对齐后，**两条宿主链都吃 code cache**。

### 1.2 harbor:// 烟雾验证（R40 P1 遗留）
新增 `HARBOR_SMOKE=1` seam：隐藏窗（show:false）+ userData 隔离
`electron-smoke-profile` + 加载即校验即退出。**实跑结果**：
```
[habor] smoke: url = harbor://app/harbor.html
[harbor] smoke: origin OK | protocol = harbor
```
协议处理器（含 5 个 libs 外链经白名单服务）端到端打通。code cache 持久化
数值指标留真机二连启动对照（Chromium 需同脚本数日内 ≥2 次）。

## 2. §5 剩余项处置（本轮 18 项）

### 2.1 资源/性能类（§5.3 清零）
| 编号 | 修法 | 测试 |
|---|---|---|
| N7 | TaskRegistry 终态容量淘汰（256 FIFO；队列/在飞永不逐出；`_submitted` 真实计数器） | test_r41_registry_pipe.py（含「最早终态已逐出/最晚可回查/在飞不受影响」三向） |
| N9 | 沙箱管道边读边截：单流保留 2MB + 截断标记；继续排空管道防子进程写端阻塞（原全量进内存且调用方无截断点） | 同上（截断分支） |
| N11 | **open_url 入护栏矩阵**（契约面变更，双端+前端全链）：Py GUARD_OPS/DEFAULT_TIERS(off)/scopes/listless/labels/canonical + api.py `_execute_guarded` 挂点 + 尾随可选 `token` 参（open_app 先例）+ Node GUARD_OPS/tiers/LISTLESS + system.js enforceExec + registry 双参 + 前端映射/确认文案/detail/档位 UI（guard_open_url select）+ guard.mjs 17→18 档 | contract-signatures 回归绿；guard.mjs 39 checks |
| S2-16 | browser.js `privateIp` 与 Python `_is_public_host` 同口径：**198.18.0.0/15 fake-ip 基准段按公网放行**（Python 2026-10-24 真机修订 Node 未同步=代理用户 Electron 链全部浏览被 SSRF 误杀的分叉）；补 IPv6 site-local fec0::/10 + TEST-NET×3；rebinding TOCTOU 按 Python 同款裁决留档（route 级逐请求重校验已收窄） | browser.mjs +2 组（fake-ip 放行/私网仍拦） |
| S4-7 | panel.js typeof 回退分支也转义 | 源码契约（build lint） |
| S4-8 | hybrid.js rd-score 过 esc（端点响应=不可信输入） | 同上 |
| S4-15 | recoverExpertRun try/catch + runPromise 复位 | 同上 |
| S4-18 | select.js `CS.prune()` 断连清扫（closeAllCS/syncAll 入口；isConnected===false 才删，vm 沙箱不误删） | 同上 |
| S4-9 | **维持不修**（10s interval 页面级单例无拆除路径，扫描原判「页面级可接受」） | — |

### 2.2 工具链/CI（§5.4 清零）
| 编号 | 修法 |
|---|---|
| S4-10 | build_hub_catalog 缓存缺失 → SystemExit 人话（含 env 指引与离线快照指路） |
| S4-11 | `F:\workbuddy` 盘符 → `HARBOR_WB_HOME`/`HARBOR_WB_APP_RES` 可覆写 |
| S4-12 | round_runner 用户名路径 → USERPROFILE 派生（末位回退语义保留） |
| S4-13 | run() 超时/OS 异常 → CompletedProcess 假体记账（不炸轮） |
| S4-14 | probe_hub_mcp 证书校验默认开启；`HARBOR_PROBE_INSECURE=1` 显式降级 |
| S4-16 | CI entry_sweep 三态：0=完成 / 2=CDP 降级 / 其它=崩溃判失败 |
| S4-19 | upgrade_audit 锚点链空 → SystemExit 人话（原裸 assert） |

### 2.3 代码卫生（§5.5 清零）
| 编号 | 修法 |
|---|---|
| D13 | resume.js 头注释补 ` */` 闭合（原吞 isResumableError 的 JSDoc；函数体本就活跃） |
| D14 | controller-base.js 样式锚点更正 → `frontend/styles/legacy.css` + `components.css` |
| S4-6 | 六套手写 esc 补单引号 `&#39;`（sw/gg/brw/hy/mm/ob——纵深；现役 sink 仍全双引号） |
| S4-17 | desc 截断码元→码点（`[...s].slice(n).join('')`，emoji 不腰斩）×2 |
| S2-23 | R37 已修 ✓ |

## 3. 明确不做（与 R36 裁决一致）
- 混合记忆升级（bigram→jieba→向量）：触发条件未达（条数过千或精确率投诉）。
- DNS rebinding 的「解析结果直连」：需 CDP 代理层重构，Python 侧同款裁决已在
  威胁模型外；route 级逐请求重校验为现行收窄手段（双端口径一致）。

## 4. 门禁记录

```
node frontend/build.js ×2   → 31204 行逐字节一致
check_contract.py           → PASS（115 JS / 14 CSS）
contract_diff --snapshot r41 → 115 模块/1260 符号；--compare → 漂移项: 无
upgrade_audit.py            → 违规项: 无
server/test/*.mjs ×20       → 全 PASS（contract-signatures 对 open_url 双参比对绿）
pytest tests/ -q            → 1950 passed / 1 failed（预存遗留 windows-packaging）/ 3 skipped
HARBOR_SMOKE=1 实跑          → origin OK（harbor://app/harbor.html）
```

## 5. 本轮踩坑（增量）
1. **heredoc 三层转义**：JSON→bash→python 的 `\\n` 逐层吃掉一层——含 `\n`/`\U`
   的替换一律改用 Edit 工具直改（本轮 N9/S4-10 两次栽在这）。
2. **契约签名测试以 Python api.py 为准**：给 js_api 加尾随可选参，Node registry
   的 handler 箭头函数参数必须同步加（handlerSignature 按 arity 推导）——
   `contract-signatures.mjs` 即拦。
3. S2-16 扫描原报「漏 febx::」实为误报（feb 前缀已覆盖 fe80::/10）；真缺口是
   **fec0::/10** 与 fake-ip 分叉——扫描结论要复核不要照单全收。

## 6. 打包（P2）——含预存失败根治与真机冒烟抓缺陷
- **预存失败根治**（R37 起挂账的 `test_isolated_build_environment…`）：
  ①隔离 venv（outputs/release-w9-candidate/venv）补装 requirements-win.txt；
  ②check_build_dependencies 门禁与测试剥继承 PYTHONPATH（隔离 venv 本就完整，
  外层开发 shell 的共享 env 漂移版 pywebview 6.x 会假性 mismatch）→ 测试翻绿。
- **真机冒烟抓到 R39-D3（跨线程 SQLite）**：dist/Harbor.exe 启动冒烟实证
  `memory_entries_list` 炸 `SQLite objects created in a thread…`（pywebview
  每调用一线程；单测单线程全绿、真机必炸）。修复=MemoryManager conn
  `check_same_thread=False`（调用方 MemoryDbService._lock 串行化，安全）。
  修复后二次冒烟零 Traceback。**冒烟=打包交付的一部分。**
- 产物（2026-11-07 全新鲜，sha256 前 24 位）：
  | 产物 | 大小 | sha |
  |---|---|---|
  | `dist/Harbor.exe`（pywebview 链） | 22 MB | `151d2ecbafd3f45abe62acf5` |
  | `dist/Harbor-Setup-1.9.0.exe`（legacy 安装器） | 46 MB | `2edcc966cf74f634022ae607` |
  | `dist-electron/Harbor-Setup-1.9.0.exe`（NSIS，含 R39-R41） | 225 MB | `c30a9891bcd7cd4307cac722` |
- ⚠ 安装动作（覆盖 %LOCALAPPDATA%\Programs\harbor-desktop）留主理人执行。

## 7. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R41.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r41.json` |
| 历轮报告 | HANDOVER-R36-R38 / R39 / R40（§5 处置状态以本报告为准收口） |
