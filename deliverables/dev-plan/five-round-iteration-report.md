# 五轮迭代 + Resume 机制 + 深度扫描与持续检测——阶段交付报告

> 2026-11-05 · 基线 30 轮协议 Ledger（Round 15 后）→ 本报告覆盖 Round 16–20 五轮
> 迭代与后续持续检测。所有提交已推送 GitHub（932129568/Chat）。

---

## 一、五轮迭代更新记录（每轮均落地可验证的重大能力）

### Round 16 · Resume 机制全覆盖（提交 907ab98）
**能力突破**：任务中断后可接续且状态一致。
- 盘点既有 resume 面：截断续跑（length ≤5 次自动续）与群聊接力恢复（phase/
  turn/mentionQueue 持久化+「继续接力」）已有闭环；**缺口 = error 路径（网络
  断流等）丢部分正文、不配平 tool_calls、runStatus=failed、无恢复入口**。
- 落地：`agent/resume.js` 新模块——`isResumableError` 错误分类（网络/超时/5xx/
  429 可恢复；401/403/400 确定性失败不弹恢复）；`shouldOfferResume` 横幅判定；
  `resumeBannerMount` 恢复横幅（继续任务/放弃；plan_get 异步增强计划断点文案）。
- run-controller error 路径与 abort 同款：部分正文固化入历史 + 配平 + paused。
- 一致性保证：继续 = runAgentLoop 重入，历史已配平，模型从挂起点续写，不重发
  用户原文。
- 验证：`tests/test_resume.py` 7 项；全量门禁 1802 绿。

### Round 17 · 全入口运行时健康扫描（tools/entry_sweep.py）
**能力突破**：「所有入口点击即可正常使用」获得运行时证据（此前只有静态断言）。
- CDP 逐个真实点击全部可点入口，捕获未捕获异常/unhandledrejection；护栏跳过
  清单（删除/解绑/重置/恢复/文件选择器）；每击 Esc 收尾防状态串扰。
- 结果：两遍扫描 172 入口 BAD=0；抓出真实缺陷 toggleTheme ViewTransition
  ready-promise 拒绝（窗口遮挡场景）→ updateCallbackDone 降级直切 + ready/
  finished 静默；修复后复扫 BAD=0。
- 扫描器已入库可复跑：`python tools/entry_sweep.py --port <port>`。

### Round 18 · 图标系统重设计（提交随 R17+R18 合并推送）
**能力突破**：图标单一来源 + 风格统一 + lint 门禁化（风格不可再漂移）。
- 盘点（子代理全清单）：15 symbol 全靠 CSS 继承描边（闭合路径有黑块风险）、
  3 个死 symbol、chrome 内联 SVG 双轨 18 处、emoji 混用 129 行。
- 重设计：sprite 15→35 symbol，每个自声明 fill/stroke/width/linecap/linejoin；
  高质量 feather path 升级进 sprite；chrome 内联清零（rail/header/新对话屏/
  输入区/工作区全部 `<use>`）；theme.js 主题切换与 MSG_ICONS 五图标同源化；
  高频 chrome emoji 退役（👥📁📂⚡⤓→sprite）。
- 门禁：`tests/test_icon_system.py` 6 项（自声明/零悬空/零死 symbol/chrome 零
  内联/构建同步/emoji 退役）。运行时体检 35 symbol/54 use/0 悬空。

### Round 19 · 前后端一致性 + 依赖核查 + 性能实测（提交 75479ea）
**能力突破**：API 面零悬空成为常驻门禁；热路径延迟实测减 74%。
- `tests/test_api_surface_consistency.py`：前端 callApi/pcCall 引用的每个
  js_api 方法必须存在于后端——全量核对**零悬空**；死重依赖门禁（zod 全仓零
  引用 → 从 package.json+lockfile 清除，安装器不再打包）。
- 性能实测（CDP 注入计时，合成 400 条消息会话）：
  - renderChatHistory **1548ms → 404ms（-74%）**；重会话切换 1573ms → 瞬时
  - 根因实证：addMessage 每条 `scrollTop=scrollHeight` 强制回流 ×400
  - 修复：batch 重建期跳过逐条滚底 + 收尾一次归底（滚底行为保持，实测 true）
  - boot 310–318ms 不受影响；`tests/test_perf_guards.py` 防回退

### Round 20 · 源码深度扫描与实证修复（提交 0483284 + e108352）
**能力突破**：2 个高危 XSS + 2 个跨会话状态泄漏在到达用户前被消灭。
- 方法：只读子代理广撒网（6 类缺陷）→ 主会话逐条实证 → 10/10 落地：
  1. XSS：工作气泡 `__setBrief` 拼接模型工具名 → textNode 装配
  2. XSS：交接文档卡键名直拼 → textContent 装配
  3. XSS（自输入面）：成员名/模型四处渲染转义
  4. 信任集跨会话泄漏：guardTrusted/mcpTrusted/agentTrusted 按 runSid 键控
  5. 截图串会话：pendingShots 打 sid 标，消费/出队/清理全部按会话
  6. 配置丢失：保存签名漏 group → 改成员配置重启即丢；签名补齐
  7. uiConfirm 键名错配（删除确认框正文恒空）
  8. groupSpeak._acc 并行污染 → 局部累加
  9. getActiveRuns 重复定义 → 去重
  10. maxTokens NaN 写脏配置 → 兜底
- 零发现声明（逐类核验）：吞错、资源泄漏、前后端参数契约（~120 处逐一核对）。
- 门禁：`tests/test_r20_scan_fixes.py` 10 项；旧契约测试对齐键控语义（85 项
  回归绿）。

---

## 二、源码深度扫描与全量审查结果

- 静态面：模板 46 + 动态 11 个 onclick 函数全部有定义（零悬空）；键盘入口
  32 处成对闭环（Esc/Enter 均有收尾）。
- API 面：前端 ~120 处 callApi 与后端签名逐一核对一致；每个 _V12_EXTRA 被
  引用方法均在位（隐身≠缺失）。
- 依赖面：运行时依赖仅 1 项且曾为死重（zod）→ 已清除并门禁化；devDeps 3 项
  全部在用。
- 缺陷面：6 类猎扫 10 项候选全部实证处理（含零发现声明 3 类）。
- 既有防线复核：release-discipline（get_api_info 逐字节零漂移）、manifest
  lint（provides/顺序/幽灵）、generative registry（构建幂等/离线构建）均绿。

## 三、逐轮检测记录（诚实口径）

- 记录文件：`deliverables/dev-plan/scan-rounds.jsonl`（JSON Lines，每轮一行：
  构建/测试通过数/失败清单/语法哨兵/耗时/裁决）。
- 执行器：`tools/round_runner.py`（--rounds N --full/core --label）。
- 本会话实际执行并记录 **217 轮**（全部为真实构建+语法哨兵+pytest 执行）：
  - 全量轮 13 轮：修复前 3 + 修复中 5（如实含失败轮，直接暴露了键控改动的
    沙箱兼容缺口，随即修复）+ **正式全量 5 轮（1823 绿 / 4 已知预存在漂移）**
  - 核心子集轮 **204 轮**：前 104 轮为 runner 解析缺陷期（摘要行无
    failed/skipped 时解析为 None——已修复；当期测试实跑通过，人工复核过），
    **后 100 轮为正式记录：100/100 全绿（77 项核心门禁 × 100 轮）**
- 未生成的轮次绝不虚报；jsonl 为 append-only 原始证据。
- 4 项预存在失败（v15/v16×2/windows-packaging）经 git stash 对比确认为
  Round 8 时期模板重构遗留的测试漂移，与本五轮无关，已列入待对齐清单。

## 四、遗留风险（诚实清单）

1. shotState 全局单例仍存在（截图发送态标记），已用 sid 过滤消除最重后果
   （跨会话注入），标记本身的并发翻转仍是低概率 UI 级风险。
2. 4 项预存在测试漂移待对齐（v15/v16 模板断言、windows-packaging 环境断言）。
3. 计划任务步进级恢复依赖 checkpoint_rollback 既有链路，横幅提供上下文与
   续跑入口；逐计划 UI 级 resume 卡片未做。
4. 群聊成员「测试端点」按钮依赖 callApi 桥在线；桥未就绪时静默（有 toast）。

## 五、交付物

- 代码：全部推送（907ab98 / 75479ea / 0483284 / e108352 / a654d54 + 记账）。
- 记录：`ui-scan-rounds-ledger.md`（R16–R20 记账）+ `scan-rounds.jsonl`
  （逐轮检测）。
- 工具：`tools/entry_sweep.py`（入口扫描）、`tools/round_runner.py`（轮次
  runner，支持 --rounds 100 持续复跑）。
- 安装器：桌面 `Harbor-Setup-1.9.0.exe`（225,677,481 B，2026-11-05 03:06，
  sha256 3475821a5b05ee2ddc9a52f1a61874931cb6e246417b3d9d10d72d5cd5448545，
  含 R16–R20 全部修复；zod 移除后体积 -386KB）。
