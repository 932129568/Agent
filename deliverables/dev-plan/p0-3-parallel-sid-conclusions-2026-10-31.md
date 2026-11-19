# P0-3 并行会话与 sid 隔离结论：架构定稿 + 兼容语义表 + 并行实证

- 日期：2026-10-31
- 执行：工程师（寇豆码，software-engineer-2；T01 中段遇 503 上游超时中断，WIP 97072a1 保护后无损续做）
- 输入：架构师方案 `design-2026-10-31-p0-3-parallel-sid.md` + 主理人 Q1-Q6 裁定
- 主理人裁定（执行依据）：并行范围=agent run 工具面+会话绑定态隔离（UI/设置/配置保持全局）；前端展示=frontend/src 岛扩展；set_workspace header 写 per-sid cwd（无头写全局现状不变）；浏览器池上限保持 3；并行 UX=默认单活跃+显式「并行运行」入口；全局 activeSid 永久保留为 legacy 默认上下文
- 红线遵守：`API_VERSION='v1.0.0'` 冻结、get_api_info 零改动、config.json 零污染（sessionCwds 并入 harbor-node-runtime.json 增键）、harbor.html 构建产物仅 build:all 幂等再生（未手改）、dist 未启动、backend/ 零改动、pywebview 生产链路径逐行保留（前端仅 HTTP 路径改造）、无新增 js_api 方法/响应字段、真实 ~/.glm-chat 零污染

## 一、架构定稿

```text
POST /jsapi/<method>
  │  headers: x-harbor-sid: <sid>（可选——缺省=legacy 路径）
  ▼
jsapi 路由：ctx = resolveContext(request)
  ├─ 有 header → { sid: headerSid, explicitSid: true }
  └─ 无 header → { sid: runtime.currentSid（请求时读全局）, explicitSid: false }
  ▼
als.run(ctx, () => invoke(method, args))     ← 每 HTTP 请求异步链独立持有
  ▼
服务层统一访问器（session-context.js）：
  ctxSid()      = als.getStore()?.sid ?? runtime.currentSid   // 缺省与现状逐字节一致
  ctxExplicit() = als.getStore()?.explicitSid ?? false
  ctxRoot()     = sessionWs[sid]（显式绑定）→ sessionCwds.get(sid)（仅 explicit
                  请求的 set_workspace 覆盖）→ runtime.cwd（现状回退）
```

**为什么 ALS 而非逐函数传 sid 参**：145 个 js_api 方法签名与响应形状冻结——不能给服务函数加 sid 参数（registry 签名面变动会破坏 contract-signatures 契约门）。ALS 使 sid 路由完全发生在运行时层，对外 API 形状零变化。

**per-sid 状态容器**（懒创建 + Map<sid, container> + LRU 200 护在途）：
- `trustBySid`（会话信任 Set<op>）/ `grants`（任务授权）/ `budgetBySid`（审批计数）/ `recent`（命令去重 `${sid}:${cmd}` 命名空间 + `lastKeys` per-sid）/ `cursors`（浏览器游标 sid→sessionId，池全局上限 3 不变）/ `sessionCwds`（per-sid cwd 覆盖，唯一事实源=runtime.sessionCwds 持久化对象，只读适配器防 split-brain）。
- 清理：`session_purge(sid)` 挂接 `purgeSid`（全容器清理）；LRU 上限 200（在途请求的 sid 不驱逐）。
- 易失态不持久化（trust/grant/dedup/cursor 与 Python 同为进程级）；sessionCwds 并入 runtime.json 持久化（向后兼容缺省 {}）。
- **per-root 写互斥**（withRootLock）：同 root 写操作串行（不撕裂）、跨 root 并行——Python「写文件串行」硬规则从进程级精化为工作区级；files.js 七写函数 + workspace.js 三写函数接锁；run_command 等子进程不加锁（与 Python 语义一致）。

**前端多 run**：`__agentRuns: Map<sessionId, run>` + `agentRunCurrent` 按会话判定活跃（不再全局唯一活跃指针）+ `runAgentLoop(opts.parallel)`（默认单活跃取消语义不变）+ `runAgentLoopParallel` 显式并行入口 + 结束摘除。run.id 唯一写者（每 run 只写自己 session 的 runStatus 持久化字段，R8 竞态防线）。

## 二、兼容语义表（零翻转契约）

| 调用形态 | 上下文解析 | 行为 |
|---|---|---|
| `X-Harbor-Sid: s1` 头 | `{sid:'s1', explicitSid:true}` | 全部服务读 s1 的上下文；**不触碰全局 activeSid** |
| 无头（legacy 前端/pywebview 现状） | `{sid:runtime.currentSid, explicitSid:false}` | **与现状逐字节一致**（差分 279 call 兜底） |
| `set_current_sid(sid)` | 设置全局 activeSid | 响应 `'{"ok":true}'` 不变；语义=「设置默认（活跃）会话」；**不影响已 pin 的 header 请求上下文**；触发切会话时**仅清旧全局 sid 的会话信任项**（legacy clear-on-switch 保留） |
| `set_workspace(path)` | 无头=写全局 cwd（现状）；header=写该 sid 的 sessionCwds | Q3 裁定：header 的工作区切换只影响本会话，不污染其他会话全局 cwd |
| `get_effective_ws` | header 请求返回请求 sid（自省与路由一致）；无头返回全局 sid | 键形状 `{sid,ws,source,exists}` 不变（无新增字段） |
| `get_cwd` | header 请求若有本会话 cwd 覆盖则返回覆盖值；无头=全局 cwd | 与 set_workspace 的 per-sid 语义闭环 |
| 会话信任/授权/预算/去重/游标 | per-sid Map | A 的状态永不命中 B；单 sid 时与原单值变量行为一致 |
| save_sessions | 全量覆盖语义不变 | R4 共享知识硬约束：前端恒提交全量会话数组（禁止按 run 切片保存——并行交替 save 不丢条目由 parallel.mjs 实证） |

**并行=Node 增强非契约差异**（§3.4 判定）：Python 无并行对应物，不属 145 方法差分面；单会话默认路径响应逐字节不变为底线（两次全量差分零翻转验证）；并行面正确性由 Node 侧 parallel.mjs 实证而非跨语言对拍；`uncovered.json` 的 `_meta.parallelBoundary` 已注明该边界（跨 sid 去重命名空间属并行增强语义，不在无头单会话 fixture 对照）。

## 三、并行实证证据（server/test/parallel.mjs，11/11 全绿）

1. **A/B header 各自 set_workspace 只影响本会话**（Q3 语义）：A/B 各自 get_cwd 独立、全局 cwd 不受 header 写入污染。
2. **get_effective_ws 按 header 自省**：A/B 各自 sid 与 ws 独立。
3. **会话信任隔离**：A trust 后 B 执行点仍要求确认（用 session 档 clipboard_read 执行路径——guard_check 查询路径本就不查会话信任，信任只作用于 enforceExec；run_command 默认 off 档不适用）。
4. **命令去重隔离**：A 重复命令被拒（{info,skipped:true} lastKey 变体）、B 同命令放行（per-sid 命名空间）。
5. **任务授权隔离**：A grant 不影响 B 的 status；审批预算计数增量独立（B 再信任只涨 B 的计数、A 纹丝不动）。
6. **写互斥**：同 root 两会话并发 write_file 同一文件 50 次——最终为某次完整写入（无撕裂、无 .tmp 残留）。
7. **legacy 混用**：无头走全局 activeSid（set_current_sid 切换生效）与 header 互不污染；clear-on-switch 保留（切换后旧 sid 信任失效）。
8. **purge 清理**：session_purge 后该 sid 的 cwd 覆盖/grant/trust 全清、其他 sid 不受影响。
9. **A/B 交替 save 全量数组不丢条目**（R4 纪律：恒提交全量数组——切片保存会删除他方条目，本用例按纪律建模全量列表交替保存）。
10. **静态防回归断言**：services/** 无 runtime.currentSid 直读（persist 全局默认写除外——单点收口防新代码绕过）。
11. **并行 run 端到端**：未修改 frontend bridge 源码在 vm 沙箱 → 真实 HTTP 监听 → 两会话同时 run（各 6 次 set_workspace+write_file）→ 各自文件落在各自工作区（A 的文件不在 B 目录、get_cwd 各自独立）。

## 四、终验数字

- **最终全量差分（两次复跑零翻转）**：runId 20261031104448（T01/T02 批）与 T04 两连跑（见交付回传）——**fixtures=29 / calls=279 / match=268 / intentional=11 / suspect=0 / error=0，EXIT 0**（无头单会话路径逐字节——底线）。
- 覆盖门禁：`npm run diff:coverage` exit 0 维持（139/145 fixture 覆盖、uncovered 13、缺口 0）。
- Node 回归：**17 组测试（16+migration/parallel）全绿**——parallel.mjs 11/11（五组实证+静态断言+bridge 端到端）、smoke 38、guard 36、state 31、commands 10、browser 17、files 23、其余组零回退。
- Python 全量回归：**1767 passed / 0 failed / 3 skipped / 1 deselected** 基线保持（`CODEBUDDY_SAFE_DELETE_ENABLED=0` + tests/ 限定 + 独立 basetemp + 静默串行 + deselect 安装器，junit 见交付回传）。
- **真实 ~/.glm-chat 指纹不变**（4196 文件 MD5 清单 hash 与 P0-2 终验一致）。
- **build:all 幂等**：两次构建 harbor.html SHA256 完全一致（2dff81f70f14678f…，构建可复现；产物变化仅限预期源码改动）。

## 五、P0-4 交接累积（本轮新增）

- **桌面 Electron 化后**：并行 run 的 UI 展示与 admin 对话框/浏览器窗口的会话归属（哪个会话的确认弹窗）需按 sid 路由到对应窗口——P0-4 窗口管理设计输入（Q 裁定累积）。
- **MCP guard helpers（mcpGuardCheck/mcpExecTool，62-mcp-exec.js）**：本批保持全局上下文（MCP 客户端池共享 per design §5.2；其护栏 trust/grant 已 per-sid——若后续要 MCP 工具级并行路由，需对该文件补 runSid 透传，已登记为可选评估项）。
- **diff harness 的并行面扩展（如需）**：driver 支持 X-Harbor-Sid 注入后可做「并行增强面的双版本回归」——Python 侧无并行对应物，仅 Node 侧 parallel.mjs 实证（边界已注明 uncovered.json）。
- **pywebview 生产链（P0-4 前）保持串行语义不变**——并行能力仅在 Node 后端路径生效。

## 六、修复执行记录（git）

| commit | 内容 |
|---|---|
| 97072a1 | WIP 保护提交（T01 中段 503 中断时的进行中状态保全：ALS 容器/路由/10 服务文件收口/parallel.mjs 初版 + 设计文档） |
| f94c5a7 | T01 收官：请求级会话上下文（ALS）与 sid 路由基建（含 sessionCwds split-brain 修复——统一为 runtime 对象只读适配器） |
| 02d7fc9 | T02：per-root 写互斥 + purge 清理挂接 + parallel.mjs 五组实证（交错隔离/写互斥 50 次无撕裂/legacy 混用/purge/全量数组）+ 静态断言 |
| d9bfe8f | T03：前端 sid 注入 + 多 run 实例管理 + React 岛并行展示 + build:all 幂等 + 并行 run 端到端实证 |
| （本提交） | T04：默认上下文等价金丝雀 + uncovered 并行边界注明 + 全量终验 + 结论文档归档 |

## 七、偏差与决策记录（相对方案）

1. **sessionCwds split-brain 修复**（T01 自验发现）：初版 session-context 持有独立空 Map 而 setSessionCwd 写 runtime.sessionCwds 持久化对象——两处写入不同源导致 per-sid cwd 不生效。统一为 runtime 对象只读适配器（唯一事实源），purgeSid 显式清理并持久化。
2. **信任隔离验证改用执行路径**（非 guard_check 查询路径）：guardCheck 查询链本就不查会话信任（信任只作用于 enforceExec 执行点）——初版测试误用查询路径；改用 session 档 clipboard_read 的 get_clipboard 执行路径，并注意 run_command 默认 off 档不适用。
3. **默认上下文等价金丝雀的环境适配**：差分驱动统一 HARBOR_GUARD_ARMED=false（信任语义在该环境不可观察），故金丝雀改为确定性剪贴板写读序列（set_clipboard 定值+get_clipboard 回读），clear-on-switch 的武装语义由 parallel.mjs（ARMED=true）承载。
4. **写互斥测试用共享 root**：per-sid 路径监狱要求目标在各自 root 内——两会话须显式共享同一 root 才能同文件并发写（per-root 锁正是按该共享根互斥）。
5. **R4 save 测试按纪律建模**：save_sessions 是全量覆盖语义——初版测试按切片保存（恰好展示被禁止的模式导致他方条目被删）；改为恒提交全量数组的交替保存以证明 R4 纪律下不丢条目。
6. **编辑-差分竞态教训**：一次全量差分与 files.js 的 withRootLock 包装编辑并发，驱动在编辑间隙加载到中间态文件报语法错误——此后差分一律在批次边界（文件状态稳定后）运行。
7. **MCP guard helpers 保持全局**：mcpGuardCheck/mcpExecTool（62-mcp-exec.js）本批未做 runSid 透传（MCP 客户端池共享 per design §5.2），已登记 P0-4 可选评估项。
