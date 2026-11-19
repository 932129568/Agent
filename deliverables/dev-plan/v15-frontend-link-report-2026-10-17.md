# v1.5 预留接口层 · 前端联调实证报告（2026-10-17）

**范围**：对已落地的 v4 UI 动效体系（port-spec.md 执行结果）与 v1.5/v1.6 预留接口层（reserved-interfaces-v15）做**独立验证 + 联调实证**，不轻信自报。

## 结论：PASS（459 passed / 契约 PASS / 构建幂等）

## 一、验证方法与发现

### 1. 现状盘点（先查后做，避免重做）

| 层 | 状态 | 证据 |
|---|---|---|
| v4 CSS 令牌（port-spec §1/§2） | ✅ 已落地 | dur-ambient/v4AuroraA/兼容别名/au-3 退役/prefers-reduced-transparency 全在；transition:all 零命中；旧 keyframes（panelIn/fadeInUp/slideDown/toolPulse/tipIn）零残留；布局属性过渡仅 .sidebar margin-left 一处（登记例外） |
| v4 JS 改造（port-spec §3 十模块） | ✅ 已落地 | 16-panel-fx(_panelLeaving+'in-'/'out-'+dir 动态拼接)/18-toast(__closing+.out+closing)/10-cs(hiding)/105-ctx(hiding)/15-theme(theming+startViewTransition)/90-attach(_attachCount+enter)/78-analytics(MOTION.count()+staggerSm)/85-session(batch+swapping)/80-utils(sys-tip .out)；MOTION 现读令牌 9 文件 |
| v1.5 预留接口后端 | ✅ 已落地 | local_model_service/mcp_pool/webdav_service 在库；7 个隐身 js_api；test_v15_reserved 87 项 |
| v1.5 预留接口前端 | ✅ 已落地 | 34-local-model.js / 37-webdav.js / 71-provider local 分支；DOM/CSS 纯新增 |

### 2. 联调实证（新增 tests/test_v15_frontend_link.py，8 用例全绿）

vm 沙箱打桩 bridge，跑真实调用路径：

**34-local-model.js（A2/A3/A5）**
- `local_probe` 无参调用 → reachable/unreachable 双行渲染 → 命中预设（kind≠custom）自动填充 base_url 并**补拉清单**（fire-and-forget，微任务 flush 后验证）
- `local_models(base_url)` → option 刷新 + `localMetaCache` 填充 → 元数据徽标正确显示「32k · 工具可用」（三级来源：精确表→启发式→保守默认）
- `test_provider_endpoint(base, '', model, 30, true)` 五参 + timeoutMs=90000 → **loading 态区分**（503 冷启动显示 warn 色而非失败）
- 异常兜底：空 Base URL 前置 warn 不发请求；callApi reject → catch toast + finally 按钮复位；探测错误分支 toast(err)

**37-webdav.js（reserved）**
- `webdav_test(JSON)` 参数结构（url/https/remote_path 默认 /glm-chat-backup/conflict_policy=ask）→ reserved 分态渲染（「配置合法；执行器 v1.6 预留」与硬错误分支分离）
- `webdav_export()` 无参 → 导出计划渲染（missing 文件标注跳过 + sha 前缀）

### 3. 测试基建修正（2 处，均测试侧）

1. **innerHTML 忠实桩**：源码 `row.innerHTML='<span>×3'` 后按 `children[1]` 索引访问——真实 DOM 会构建子节点；初版桩 innerHTML 是纯字符串属性导致 children 空 → `undefined.textContent` 抛错被 catch 吞成「探测失败」。修法：桩的 innerHTML setter 解析 `<span></span>` 序列生成 children（conftest 假剪贴板同型教训：桩必须忠实）。
2. **vm `let` 不挂沙箱**：`let localMetaCache/localState` 在 runInContext 里是脚本作用域，`ctx.xxx` 取不到——改经 UI（徽标文本）间接验证语义，不直接读内部变量。

## 二、实现要点（给后续联调的人）

1. **本地模式零 Key**：`test_provider_endpoint` 第 5 参 `local=true` 走免 Key 分支（后端 A5）；前端固定传空 apiKey。
2. **冷启动 loading**：Ollama 503 返回 `state:'loading'`——**不得当失败**，UI 走 warn 色 + 「等待即可」语义。
3. **探测→清单链**：探测命中预设后自动补拉清单是 fire-and-forget（无 await）——测试需 flush 微任务；UI 侧清单按钮自带 loading，无竞态。
4. **元数据缓存失效**：每次探测/拉清单都重置 `localMetaCache`（模型集可能变），徽标从 localState 手设值或缓存取值。
5. **WebDAV reserved 约定**：`{reserved:true}` 与 `{error}` 是两个分支——前者渲染「配置合法+执行器预留」，后者走错误 UI；正式版接线只换后端执行器，前端零改。
6. **CS.syncAll**：模型 option 动态刷新后必须同步自定义下拉（10-custom-select 的显隐模式），否则已展开的下拉不同步。

## 三、边界场景覆盖矩阵

| 场景 | local-model | webdav |
|---|---|---|
| 加载中 | 按钮禁用+文案+finally 复位 ×3 处 | 同 |
| 空数据 | 空模型清单 → sel 空 + 徽标「元数据待获取」 | 导出计划空 → 「无文件」detail |
| 接口失败 | JSON.parse/callApi reject → catch toast(err) | 同 + 校验失败分支（URL 非 https） |
| 参数缺失 | 空 base/model 前置 warn 不发请求 | — |
| 特殊态 | loading（503 冷启动）区分展示 | reserved 分态渲染 |
| 部分失败 | unreachable 行单列不阻塞 reachable | 计划内 missing 标注跳过 |

## 四、遗留（目标机）

- 起窗冒烟（本环境无 webview）：本地模式端到端（探测→选型→对话）、WebDAV 配置 UI、v4 动效实机观感
- B1 上下文自适应压缩 / B2 去 tools 重发 / B3 流式 watchdog / B5 MCP 保守策略的**主链路接线**（判定函数已就绪，按 roadmap 后续迭代）
- WebDAV IO 执行器（v1.6 正式版）

## 五、门禁记录

- `pytest tests/ -q` → **459 passed**（451 基线 + 8 新增联调实证）
- `check_contract.py` → PASS（40 id/13 onclick/43 callApi/39 类/21 变量零改动）
- `node frontend/build.js` → 40 模块 6727 行，两次构建一致（幂等）
- `design/v4/check_prototype.js` → ALL-PASS
