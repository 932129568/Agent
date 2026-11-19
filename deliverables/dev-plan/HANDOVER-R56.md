# HANDOVER-R56 — 多会话并发调用对齐 + 工具调用优化第一批

> 日期：2026-11-08。接续 `handover-2026-11-07-全量交接.md`（§6/§7 两项 P0）。
> 轮类型：**并发正确性轮**（多模型/多会话同时调用同一工具）+ 前沿调研落地。
> 调研产出：`outputs/r56-research/方向A-工具调用优化.md` · `方向B-并发控制.md`（前端未动代码，全部建议经主会话实证后才落地）。

## 0. 一眼总览

| 维度 | 状态 |
|---|---|
| 全量 pytest | **2023 passed / 0 failed / 3 skipped**（R55 基线 2009 → +14） |
| 桥侧测试 | 9/9 PASS |
| 契约锚点 | **r56**（contract-baseline-r56.json，115 模块 / 1274 符号） |
| upgrade_audit | **零违规** |
| build | ×2 幂等 ✓（harbor.html 31530 行；manifest provides 增 9 符号） |
| 提交 | 本轮 1 笔（见 §7） |

## 1. 实证结论（六风险面逐条复核，接交接文档 §7）

| 风险面 | 实证结论 | 处置 |
|---|---|---|
| 跨会话写文件 | Python 链 R37-N4 路径锁已覆盖 write/append/search_replace；**move/copy/delete 漏锁**；Node 链 withRootLock（per-root）已覆盖 | F7a：补 move/copy/delete 路径互斥（ExitStack 去重取锁防自锁）；F1b：前端 withPathLocks |
| memory.db 双写者 | Python 写者① R14 已 WAL+busy_timeout=30s+BEGIN IMMEDIATE ✓；**Node 写者② pybridge 零 busy 处理** | F6：createClient timeout:30000（libsql 本地库 busy_timeout）+ busyRetry 指数退避 ×3 |
| browser 会话池 | busy 跳过 ✓；**游标全局单例**（并行 run 互相串页——比交接文档预估更重）+ 无 per-sid 配额 | F5：游标 per 来源 sid（owner 无游标回退全局——legacy 逐字节不变）+ owner_sid 归组 + 自配额驱逐（OWNER_SESSION_QUOTA=2，先自牺牲） |
| guard confirm token | **Node 链 R39 已 sid 绑定 ✓**；Python 链三缺口（token 不绑 sid / 信任全局单集 / clear 全清） | F2/F3/F4：Python 对齐 Node 语义（见 §2 裁决） |
| sandbox 进程 | 并行 software_call=独立子进程无共享损坏；沙箱路径已有 Job Object 资源限额 | **F8 裁决：不加全局信号量**——串行会把 600s 长任务的排队阻塞转嫁无关会话；进程池化在 Windows 无对应技术（调研轮裁决），`_run_cli` docstring 留档 |
| toolcache/search cache | 查询键缓存跨会话复用=同查询同结果，语义安全 | **裁决：零改动**（R50 单例共享即正确语义） |

### 新实锤（交接文档未列）

**N1 pywebview 链并行 sid 竞态**：pywebview 后端以「当前会话」全局态路由工作区，前端 per-call `set_current_sid` 与并发工具调用交错 → 工具读写落错会话工作区（R37 只修了 HTTP 链 header 路由，pywebview 链遗留）。
**N2 两链 clear-on-switch 在并行世界均为毒**：Node `registry.js:122` 切全局 sid 清上一 sid 信任容器 → B run 启动抹掉 A 的信任 → A 前端跳弹窗（agentTrusted 命中）+ 后端拒 token（无 token）→ 死循环；Python `session.py:24` 更重（全清含 token）。

## 2. 语义裁决（本轮最重要的两个决定）

1. **clear-on-switch 全面移除（两链）**：guard/MCP 信任与 token 是 per-sid 资产，
   `set_current_sid` 不再清理（原 W26 语义属单活跃世界；前端 agentTrusted 自 R20
   起 per-sid 且不随切换清理，两侧自此对齐）。清理挂点：`session_purge`
   （api.py purge 后清 guard 信任+token / MCP 信任；Node 走既有 purgeSid→容器清理）
   与重启。`clear_session_trust(sid)` 保留定向清理（sid=None 全清为 legacy 兼容）。
2. **token 三不变式补齐 Python 链**：一次性 ✓（既有）+ 绑 op+detail 摘要 ✓（既有 W4）
   + **绑签发会话 sid**（本轮；消费侧 (tok_sid||'')!=(cur_sid||'') 即拒；先取后验
   语义不变——跨 sid 失败尝试也销毁 token 防重放）。无身份 hook 环境（测试/无窗）
   两侧皆 ''，legacy 行为不变。

## 3. 落地清单

| # | 文件 | 内容 |
|---|---|---|
| F2 | `backend/domains/security/guard_service.py` | `_session_trust` set→dict(sid→set)；token 3 元组→4 元组（+sid）；`issue/consume/refund` 三点绑 sid；`clear_session_trust(sid=None)` 定向化；`current_sid()` 公开读 |
| F3 | `backend/domains/integrations/mcp/mcp_service.py` | 信任 per-sid（安全读 guard.current_sid——测试桩 guard 无该方法时退化为 ''） |
| F4 | `backend/application/session.py` · `backend/api.py` · `server/src/registry.js` · `server/src/session-context.js` · `server/src/services/guard.js` | 两链 clear-on-switch 移除 + purge 挂点 + 注释对齐；`clearTrustForSid` 函数删除 |
| F5 | `backend/domains/integrations/browser/driver.py` · `backend/bootstrap/container.py` | 游标 per-sid（`_cursor_by_sid`）+ `owner_sid` 入条目 + `_evict_if_full`→`_evict_for(owner)`（自配额+先自牺牲）；container 装配 `set_sid_hook`（与 guard 身份 hook 同源） |
| F6 | `server/src/services/pybridge.js` | libsql `timeout:30000` + `busyRetry()`（写路径 ×4 套装） |
| F7a | `backend/domains/workspace/file_service.py` | move/copy/delete 补路径互斥（ExitStack 去重取锁；**src==dst 单键防自锁**——契约测试 `copy_exists` 抓出的真 bug） |
| F1 | `frontend/src/agent/tool-executor.js` | `withPySidSlot`（pywebview 链整段原子对——sid 切换+护栏+token+op 同段，token 签发=消费 sid 必然成立；HTTP 链不受影响）；`withPathLocks`（写类工具 8 分支跨 run 同路径互斥，多键字典序防死锁）；`executeToolRaw`→门面+`executeToolRawDispatch` |
| O1 | `frontend/src/agent/run-controller.js` | build_tools 结果进程内 TTL 缓存（指纹键 [role,full,includeAgent,glm,feat×2,enableSearch,engine] + 60s；返回副本防缓存体改写）——每 run 一次 HTTP → 命中即零往返 |
| O2 | 同上 | 读批 per-task catch（批内单工具意外异常不放大全批；工具条目 fail 样式兜底） |
| O3 | `tests/test_v19_driver.py` | 三段式 lint 加长度上限 160（现库最长 software_call 115；AGENTS.md §3 口径扩展） |

测试：`tests/test_r56_concurrency.py`（14 测试）——guard sid 绑定 5 态 / SessionCoordinator 不清信任 / MCP 定向清 / 驱动游标内容级断言（marker 级——错配立现）/ 自配额驱逐（B 会话安然无恙）/ 文件三工具回归 + 自拷贝自锁回归 + 并发写无撕裂 / **前端 node 实测**（路径锁串行+大小写归一同键+异路径并行+多键无死锁+sid 原子对+HTTP 链无 set_current_sid）。

## 4. 调研裁决（outputs/r56-research，采纳/留档）

| 项 | 裁决 |
|---|---|
| A1 guard 本地预判+合并 RTT | **留档候选**——guard_check 独立 RTT 承担确认前零副作用审计语义，合并需动协议 |
| A2 读批 allSettled | ✅ 采纳（O2；实测原 Promise.all 靠内层 try 兜底，本改动是外层加固） |
| A3 build_tools 缓存 | ✅ 采纳（O1；逐字节复用+副本返回，与调研约束一致） |
| A4 routeTools 轮级裁剪打爆 KV-cache | **实测不适用**——routeTools 已是任务级冻结（run 内一次计算非每轮），无需改 |
| A5 schema lint 长度上限 | ✅ 采纳（O3） |
| B1 池活跃保护+singleflight | ✅ 部分采纳（busy 跳过已有；补 per-sid 游标+配额） |
| B2 SQLite 统一配方 | ✅ 采纳（F6；timeout 30000 与 Python 侧同口径） |
| B3 per-resource 锁表 | ✅ 采纳（F1b+F7a） |
| B4 token 三不变式 | ✅ 采纳（F2；Node 侧 R39 已满足） |
| B5 沙箱进程池 | ❌ 不适用（Windows 桌面无 Firecracker/gVisor 对应；F8 裁决留档） |

## 5. 测试基建变化（下轮须知）

1. **manifest provides**：tool-executor +7 符号（`__pathLocks/__pySidTail/_pathLockAcquire/executeToolRawDispatch/withPathLocks/withPySidSlot`）、run-controller +2（`__BUILD_TOOLS_TTL_MS/__buildToolsCache`）——新顶层符号必须登记，否则 build 门禁拒。
2. **test_v13_qa harness**：MCP harness 由单函数抽取改**整模块注入**（门面拆分后抽取不自足）；agent-loop harness 注入缓存变量声明 + 「非数组抛错」检查前 `__buildToolsCache.tools = null`（同键 TTL 命中会短路 HTTP）。
3. **契约锚点 r56**：api.py session_purge 体变更（+purge 清理挂点）→ api_py_sha256 漂移为合法升级，锚点已重照。
4. 旧语义测试改名/改写：`test_session_switch_clears_two_trust_stores_and_rotates_trace`→`test_session_switch_keeps_trust_and_rotates_trace`；`test_session_trust_bypasses_token_then_cleared_on_sid_change`→`test_session_trust_per_sid_survives_switch`（切回原 sid 信任存活=新语义正向断言）。

## 6. 遗留与下一步

- **P0**（延续交接文档 §8）：推送 44+1 笔提交（blob API 重放流程）；重出安装包（R41 版产物现已落后 15 轮）；handover-2026-11-07 全量交接文档随本轮入库。
- P1：pybridge mcp_search 接 mcp.js 注册表（仍 TODO）；guard 合并 RTT（A1）立项评审；`loadBackendTools` 缓存失效面（MCP 服务器增删 60s 滞后）如需即时可挂配置变更事件。
- 观察项：pywebview 链并行 run 工具全串行（N1 修复的代价，含确认弹窗排队）——Electron 生产链零影响；若 fallback 链并行体验成问题再议细化分段。

## 7. 提交

```
feat(R56): 多会话并发调用对齐——guard/MCP 信任与 token per-sid 化（Python 链对齐 Node R39 语义）+ 两链 clear-on-switch 移除（挂点 session_purge）+ browser 池游标 per-sid/自配额驱逐 + pybridge busy_timeout/重试 + move/copy/delete 补路径互斥 + 前端 sid 原子对/路径锁表 + build_tools TTL 缓存/读批 catch/lint 长度上限；锚点 r56；pytest 2023 绿
```
