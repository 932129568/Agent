# GLM-Chat / Harbor 交接报告
## 覆盖范围：Round 16 – Round 25（2026-11-04 深夜 → 2026-11-05 凌晨）

> 接手人须知：本报告只写**已经落地并验证过**的内容，每条都带提交号或可复跑命令。
> 上一份报告为止（Round 15 三批优化）的内容见 `five-round-iteration-report.md`。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 本轮提交 | 9 个（`907ab98` → `d141df9`），**全部已推送** `origin/main` |
| 全量门禁 | **1827 passed / 0 failed / 3 skipped**（项目历史首次零失败） |
| 测试文件 | 120 个 |
| 前端模块 | 104 个（manifest 拼接式构建，14 个样式） |
| 安装器 | 桌面 `Harbor-Setup-1.9.0.exe`，225,669,785 B，2026-11-05 04:48，sha256 `bbba0c96…b7ecf3` |
| 性能 | 400 条消息渲染 1548ms → **221ms**（-86%）；1000 条 419ms |
| 本轮修掉的缺陷 | 源码扫描 10 项（含 2 个高危 XSS）+ 入口扫描 1 项 + 自测暴露 3 项 |

---

## 1. 五轮迭代（R16–R20）：能力突破 + 验证方式

### R16 · Resume 机制（`907ab98`）
**做了什么**
- 新增 `frontend/src/agent/resume.js`：
  - `isResumableError`：错误分类。网络/超时/5xx/429 判为**可恢复**；401/403/400 判为确定性失败（继续只会再失败，不弹恢复）。
  - `shouldOfferResume`：只有 `runStatus=paused` 且消息流停在 assistant/tool 才弹横幅。
  - `resumeBannerMount`：⚡横幅「上次任务在第 N 轮被中断，已输出内容与工具状态均已保留」+ [▸ 继续任务][放弃]。
- `run-controller.js` error 路径与 abort 对齐：部分正文固化入历史 + `fillMissingToolResults` 配平 + 置 paused。
- `renderChatHistory` 尾部挂横幅；「继续」= `runAgentLoop` 重入（不重发用户原文，不重复计费）。

**盘点结论（为什么只做这一块）**：截断续跑（length≤5 次）与群聊接力恢复此前已闭环，唯一缺口就是 error 路径。

**验证**：`tests/test_resume.py` 7 项（错误分类矩阵 / 横幅判定矩阵 / 继续与放弃交互 / 健全会话不弹 / 接线断言 / 计划上下文增强）。

### R17 · 全入口运行时健康扫描
**做了什么**：新增 `tools/entry_sweep.py` —— 通过 CDP 对运行中应用**逐个真实点击**全部可点入口，捕获未捕获异常与 unhandledrejection；带护栏跳过清单（删除/解绑/重置/恢复/文件选择器）；每击 Esc 收尾防状态串扰。

**结果**：两遍扫描 172 入口 BAD=0；**抓出一个真缺陷** —— `toggleTheme` 连续点击时 ViewTransition 的 `ready` promise 拒绝（窗口遮挡场景）→ 三通道抑制（updateCallbackDone 降级直切 + ready/finished 静默），修复后复扫 BAD=0。

**复跑**：`python tools/entry_sweep.py --port <调试端口> --json out.json`

### R18 · 图标系统重设计（随 `32a148c`）
**问题（审计数据）**：15 个 symbol 全靠 CSS 继承描边（闭合路径有黑块风险）、3 个死 symbol、chrome 内联 SVG 双轨 18 处、emoji 混用 129 行。

**做法**
- sprite **15 → 35 symbol**，每个 symbol **自声明** `fill/stroke/stroke-width/linecap/linejoin`；
- 高质量 feather path 升级进 sprite；chrome 内联 SVG **18 处清零**（rail/header/新对话屏/输入区/工作区全部 `<use>`）；
- `theme.js` 主题切换常量与 `markdown.js` 的 `MSG_ICONS` 五个图标同源化；
- 高频 chrome emoji 退役：👥群聊 / 📁群文件 / 📂打开 / ⚡恢复横幅 / ⤓导出 → sprite。

**门禁**：`tests/test_icon_system.py` 6 项（自声明 / 零悬空 use / 零死 symbol / chrome 零内联 / 构建产物同步 / 群 chrome emoji 退役）。
**运行时体检**：35 symbol / 54 use / 0 悬空 / rail 全 sprite。

### R19 · 前后端一致性 + 依赖核查 + 性能（`75479ea`）
- `tests/test_api_surface_consistency.py`：前端每个 `callApi`/`pcCall` 目标必须存在于后端（定义或 `_V12_EXTRA`）——全量核对 **零悬空**；死重依赖门禁。
- **zod**：全仓零引用 → 从 `package.json` + `package-lock.json` 移除（安装器少 386KB）。
- **性能实测（CDP 计时）**：400 条消息 `renderChatHistory` **1548ms**。根因实证：`addMessage` 每条都写 `scrollTop=scrollHeight`（400 次强制回流）。修复：batch 重建期跳过逐条滚底 + 收尾一次归底（滚底行为保持）。
- `tests/test_perf_guards.py` 锁定不回退。

### R20 · 源码深度扫描与实证修复（`0483284` + `e108352`）
**方法**：只读子代理广撒网（6 类缺陷）→ 主会话**逐条实证** → 10/10 落地：

| # | 缺陷 | 严重度 | 修复 |
|---|---|---|---|
| 1 | 工作气泡 `__setBrief` 拼接模型工具名进 innerHTML | **高（XSS）** | textNode 装配 |
| 2 | 交接文档卡键名（模型正文解析）直拼 innerHTML | **高（XSS）** | textContent 装配 |
| 3 | 成员名/模型在气泡头/chip/详情页/队列预告未转义 | 中低 | 统一转义 |
| 4 | guardTrusted/mcpTrusted/agentTrusted 全局 Set 跨会话泄漏 | 中高 | **按 runSid 键控** |
| 5 | pendingShots 截图串会话（注入他端点请求） | 中 | 打 sid 标，消费/出队/清理全按会话 |
| 6 | 保存签名漏 `s.group` → 改成员配置不发言就丢 | 中 | 签名补 group |
| 7 | `uiConfirm` 键名错配（确认框正文恒空） | 中低 | body/okText |
| 8 | `groupSpeak._acc` 并行群会话共享 | 低 | 调用局部 |
| 9 | `getActiveRuns` 重复定义 | 低 | 去重 |
| 10 | `maxTokens` parseInt 无兜底（null 写脏 config） | 低 | `||4096` |

**零发现声明**（逐类核验）：吞错、资源泄漏、前后端参数契约（~120 处逐一核对一致）。

**门禁**：`tests/test_r20_scan_fixes.py` 10 项。

---

## 2. 新一轮升级（R21–R25）（`47f4e54`）

### R21 · 性能调度 + 工具调用
- **懒渲染**：视口外老消息走轻量形态（纯文本，保留 `.message` 形状与 `data-midx`，搜索跳转不受影响），滚入视口 ±200px 升级为完整渲染（renderMd + 操作条 + 代码增强）。群聊会话**不懒**（气泡映射按 `.message` 逐条对位）。
- **踩坑记录（重要）**：被遮挡窗口里 IntersectionObserver 与 scroll 事件**都不派发**（实测 `ioFired=0`/`scrollFired=0`）→ 最终方案：滚动即时升级 + **400ms 兜底轮询**（有 lazy 才转，清零自毁）。
- **实测**：400 条 **404→221ms**；1000 条 **419ms**。
- **群聊工具面缓存**：原来每次成员发言都打一次 `build_tools` RPC → 按 `(档位|端点)` 缓存 60s，`saveConfig` 时失效。

### R22 · 本地大模型调度
- **同端点 FIFO 串行队列**：本地推理服务是单 GPU，并发只会造成 KV-cache 上下文切换。槽位在**响应流消费完毕**才释放（streaming 全程占 GPU），实现为响应体包装 `release-on-close/cancel/error`。云端端点不受限。
- **冷加载退避**：3 档 14s → **6 档 119s**（7B–32B 冷启动 30–90s 常见），云端保持 3 档。

### R23 · UI
- 5 处 ✕ glyph（toast 关闭 / 附件移除 ×3 / 自定义模型删除）→ `i-close` sprite；
- `:focus-visible` 键盘焦点环统一（鼠标点击不显示，Tab 导航显示）。

### R24 · Resume 升级
- `shotState` 全局单例 → **`run.shotState`**（R20 遗留风险 #1 清零）。
- **网络断流自动续跑**：可恢复错误 2.5s 后自动 `continueLastGeneration`，每会话 5 分钟窗口内**最多 2 次**防无限循环；超限走恢复横幅人工决定。

### R25 · 遗留任务清零 → 门禁首次零失败
| 遗留项 | 处理 |
|---|---|
| v15 `transition:all`（R20 引入 3 处） | 改具体属性过渡（同时对齐 v4 禁项） |
| v16 batch1 效率提示词断言过时 | 对齐 Round 8 瘦身后的现役契约 |
| v16 batch2 导航断言过时 | 对齐 Round 8 IA 重构（rail + toolsPop + notifyPop） |
| v16 batch2 503 退避 | 对齐 R22 六档 |
| windows-packaging | 隔离 venv 补装 Pillow（ImageGrab）——环境漂移 |
| **自测暴露**：newSession 误引 `__prevSid`（TDZ） | 修复——**项目工作区绑定因此失效的真 bug** |

---

## 3. 源码扫描与全量审查结果

- **静态面**：模板 46 + 动态 11 个 onclick 函数**全部有定义**（零悬空）；键盘入口 32 处成对闭环。
- **API 面**：前端 ~120 处 `callApi` 与后端签名逐一核对一致；`_V12_EXTRA` 被引用方法全部在位（隐身≠缺失）。
- **依赖面**：运行时依赖唯一一项 zod 曾是死重 → 已清除并门禁化；devDeps 3 项全部在用。
- **缺陷面**：6 类猎扫 10 项候选全实证处理；3 类零发现。
- **既有防线**：release-discipline（`get_api_info` 零漂移）、manifest lint、generative registry（构建幂等/离线构建）全绿。

---

## 4. 逐轮检测记录

- 原始记录：`deliverables/dev-plan/scan-rounds.jsonl`（append-only，**219 轮**，每轮含构建/语法哨兵/测试数/失败清单/耗时）
- 执行器：`tools/round_runner.py --rounds N --full|core --label "..."`

如实统计（不美化）：

| 区段 | 轮数 | 结果 |
|---|---|---|
| 修复前全量 | 3 | 1812 绿 / 6 败（暴露 generative 漂移） |
| 修复中全量 | 5 | 1817 绿 / 10 败（暴露键控改动的沙箱缺口 → 随即修复） |
| 正式全量 | 5 | **1823 绿 / 4 已知漂移** |
| 核心子集（前段） | 104 | 测试实跑通过，但 runner 摘要解析 bug 记为 None（已修，人工复核） |
| 核心子集（正式） | **100** | **100/100 全绿** |
| 其他小轮 | 2 | 绿 |

之后 R21–R25 收口时全量门禁：**1827 passed / 0 failed**。

---

## 5. 交付物清单

| 类别 | 位置 |
|---|---|
| 安装器 | 桌面 `Harbor-Setup-1.9.0.exe`（sha256 `bbba0c96…b7ecf3`，asar 反查 11 项关键标记全在包内） |
| 五轮报告 | `deliverables/dev-plan/five-round-iteration-report.md` |
| Ledger 记账 | `deliverables/dev-plan/ui-scan-rounds-ledger.md`（R16–R25） |
| 逐轮记录 | `deliverables/dev-plan/scan-rounds.jsonl` |
| 工具 | `tools/entry_sweep.py`（入口扫描）、`tools/round_runner.py`（轮次 runner） |
| 代码 | `907ab98` `32a148c` `75479ea` `0483284` `e108352` `a654d54` `c679983` `47f4e54` `d141df9` |

---

## 6. 接手人必知的约束与坑

1. **构建**：`node frontend/build.js`，**新顶层符号必须登记进 `frontend/manifest.json` 的 `provides`**，否则 lint 拦构建（本轮被拦下 4 次）。模块数从 100 涨到 104，`test_frontend_tree` / `test_modern_build` 里有硬编码计数。
2. **打包**：git bash 下 `| tail` 会吞退出码，**别用管道判断成功**；网络不稳时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；打包前必须关掉所有 `Harbor.exe`/`electron`，否则 `node_modules` rename 失败。
3. **`test_generative_registry` 的 offline 场景**会 rename `node_modules` —— 运行时必须先停 electron。
4. **CDP 扫描/性能测试**：用 `npx electron electron/main.js --remote-debugging-port=<port>` 跑开发树，别用 `win-unpacked`（那是旧 asar）。
5. **群聊状态**挂在 `session.group`（members/turn/phase/round/autoRelay/**endpoints**/**mentionQueue**），持久化白名单在 `sessions/store.js` 的 `normalizeSessions`，localStorage 镜像会剥掉 `api_key`。
6. **信任集**按 `runSid` 键控（`sid|op`），后端 `guard_session_trust` 也是 per-sid，两边必须一致。
7. **截图** `pendingShots` 元素是 `{sid, comp}`，所有读写都要按 sid 过滤。

---

## 7. 遗留风险与建议下一步

1. `shotState` 全局变量仍存在（已不参与逻辑，仅兼容面）——可在下个版本彻底删除 `core/state.js` 中的声明与 app-state 的 getter/setter。
2. 计划任务的步进级恢复依赖 `checkpoint_rollback` 既有链路；横幅只提供上下文与续跑入口，**逐计划 resume 卡片未做**。
3. 群聊「测试端点」按钮依赖 callApi 桥在线，桥未就绪时静默（有 toast）。
4. 懒渲染后**搜索跳转**依赖 `data-midx`（轻量节点保留），已验证；但若未来改成虚拟列表，需重新设计该跳转。
5. 建议把 `tools/entry_sweep.py` + `tools/round_runner.py` 接进 CI，每次发版前各跑一遍。
