# Harbor 并行架构与性能增量 PRD：多核、线程、设备协同与流畅性

- 日期：2026-10-27
- 状态：需求锁定，交架构师统一设计；本阶段只读审计与文档，不改产品代码
- Project Name：`harbor_v19_parallel_performance`
- 技术边界：Python stdlib + pywebview + WebView2 + 原生 JavaScript + Node 内置工具；不引入新框架、模型 SDK、npm/Python 运行时依赖
- 上游：`harbor-v19-modern-refactor-prd-2026-10-26.md`、`harbor-v19-expert-modern-architecture-2026-10-26.md`
- 原始需求：从底层支持多核并行、多线程，提升 CPU/GPU 利用率与流畅性。**以正确性、响应延迟、吞吐和资源证据为目标，不以线程数或全核占用率为目标。**

## 1. 产品定义

### 1.1 Product Goals

1. **先恢复正确性，再建立可信性能基线**：W2 功能失败、迁移路径和测试接缝未关闭前，不以性能重构掩盖或扩大失败面。
2. **按工作类型选择并发模型**：UI 单线程、网络事件驱动、Python I/O 有界调度、CPU 重任务经 profiler 后选 Worker/进程，原生窗口回 UI 线程。
3. **可测量地提升体验**：降低长任务、等待与尾延迟，提高独立任务吞吐，同时约束内存、线程、句柄、背压、取消和恢复成本。

### 1.2 User Stories

- 作为对话用户，我希望文件、MCP、WebDAV 或本地模型等待时界面仍能输入、切换和停止，而不是被同步 I/O 或长渲染卡住。
- 作为 Agent 用户，我希望独立只读任务有界并行，同一文件/会话/stdio 等共享资源仍按序，Guard、审计与终态不漂移。
- 作为本地模型用户，我希望代理流式转发及时、断开可停止、慢上游不耗尽线程；也清楚推理由外部服务完成，Harbor 线程数不等于 GPU 加速。
- 作为维护者，我希望每个并行点都有资源键、ownership、幂等、背压和 A/B 数据；没有收益的并发可以单点撤销。
- 作为 QA，我希望功能失败与性能回退分别呈现，冷/热、基线/A/B/压力/竞争/取消证据不混淆。

## 2. 当前事实与发布阻断

### 2.1 功能状态优先

- 主理人提供的最近全量结果为 **1510 passed / 25 failed / 1 skipped，W2 未验收**。此后工作区又有测试文件修改，因此该结果既不是当前通过证明，也不能据此精确宣称当前失败数。
- 当前 `backend/services/**` 已迁移为 `backend/domains/**`，大量产品/测试/spec 引用变更；W2 现场文件明确为 IN PROGRESS / NOT VERIFIED。不得用旧 1509/0 failed 或旧三 exe 代替当前验证。
- `prompt_loader.py` 已迁至 `backend/domains/providers/`，但 `prompts_dir()` 仍为 `dirname(__file__)/../prompts`，会指向 `backend/domains/prompts`；注释仍称本文件位于 services 下级。该路径与注释是 P0 修复项，不是性能候选。
- 当前 `frontend/build.js` 已是 manifest 驱动，旧“数字前缀/扁平 src”注释不能作为现状；`test_round6_adversarial.py` 等 CSS 读取接缝必须以 manifest 合并样式为准。构建注释、CSS 接缝与 W2 测试失败先修。
- 本轮未重跑测试、未构建、未启动 exe。性能优化不得删测、放松断言、跳过失败或把 mock 结果写成真实 GPU/端点提升。

### 2.2 已有测量与局限

**补充实测环境（2026-10-27）**：i7-12700H（14 核 20 逻辑线程），NVIDIA GeForce RTX 4070 Laptop GPU（nvidia-smi 报告 8188MiB，约 8GB）。只读 `nvidia-smi` 查询可用，当前 GPU/显存利用率均为 0%；这只证明设备与观测工具可用，**不证明 Harbor 正在使用 GPU，也不构成推理或渲染加速证据**。

最新基线 `outputs/perf/parallel-baseline.json`（7 次，Windows/Python 源码 + Node VM）：

| 指标 | 中位数 | 正确解释 |
|---|---:|---|
| `search_cache_stats` | 3.490ms | 首轮首次目录枚举为 324.321ms，后续为热 OS-cache；不能将含首轮的总体中位数称为冷启动，也不能把首轮与热样本混算 |
| `history_dir_get` | 0.324ms | 临时目录 Python 源码测量，不含 js_api/IPC |
| `list_dir`（5000 文件） | 11.708ms | 算法优化后的 Python 源码测量，不是多线程结果 |
| `session_search_miss` | 10.174ms | Node VM 扫描，不含真实 DOM 事件绑定/layout |
| `stream_schedule_coalesced` | 1.680ms | Node VM 调度，不含网络/DOM/paint |
| `analytics_render_aggregation` | 47.186ms | **每样本 10 轮聚合总耗时**，不可直接写成单次 47.186ms 或 >50ms LongTask；真实 WebView 单次与绘制仍待测 |
| `terminal_render_with_pending` | 0.001ms | Node stub 终帧调用，不是 WebView2 实际绘制时长 |

| 证据 | 已有结果 | 不能外推为 |
|---|---|---|
| `baseline.json` / `after-cache-index.json` | 512 cache entries，5 次热样本中位数 147.507ms→3.630ms；首次枚举约 345–358ms | GUI 启动、全核加速、当前 W2 性能；冷/热混合不能当独立冷启动对照 |
| `baseline-t02.json` / `after-t02.json` | 5000 文件 list_dir 7 次中位数 136.776ms→12.395ms；history open 2→1；同 checksum | 多线程收益；这是扫描/stat 算法优化，不是并行证明 |
| `baseline-t03.json` | 当前基准工具记录 search 9.925ms、schedule 1.665ms、analytics 10 rounds 104.469ms | WebView2 DOM/layout/paint、真实 SSE 总时长；analytics 是 10 次聚合总和，不能误写单次 104ms |
| 前端 benchmark 限制 | Node VM 不包含真实 DOM、DOMPurify/layout/paint、Markdown 全解析与网络等待 | 浏览器帧率、WebView2 卡顿、真实模型吞吐 |
| 当前工具汇总 | 至少 7 次可运行，保留 min/max/median、环境、原始样本与 correctness | 尚无 P95/P99、tasks/s、CPU/RSS/线程/句柄/I/O 等待、GPU 或竞争/取消指标 |

已有数据证明“先减少无效 I/O 与重复计算”有效，**没有证据证明更多线程、更多进程或 GPU 利用率提升会带来收益**。

## 3. 实际场景分类与设备边界

| 场景 | 当前执行/等待特征 | 正确并发方向 | 禁止误判 |
|---|---|---|---|
| pywebview / WebView2 UI 与 DOM | JS 在 renderer 主线程；DOM、组件更新、焦点和布局有单线程亲和 | DOM 仅主线程；rAF/定时器合帧、分片、懒加载；纯计算经 profiler 后才可 Worker | 不用多线程操作 DOM，不把 Node VM 当 WebView2 |
| JS 流式模型与本地/云代理 | `fetch` + ReadableStream + AbortController；45 重试/sleep，60 SSE 聚合、工具循环 | 保持事件驱动 Promise/fetch；减少同步解析/渲染长任务；按 run 背压和取消 | 不为网络等待创建 JS/Python 线程，不复制第二模型客户端 |
| Python js_api / 文件 / JSON | pywebview 多线程回调；同步文件/JSON/锁；公开方法同步返回 JSON | 门面适配到按领域有界 I/O executor；资源键串行；快照后出锁 I/O；截止/背压 | Python 线程不绕 GIL，不在持锁时做慢 I/O，不改公开返回 |
| MCP HTTP / stdio | HTTP pool、per-server limiter、stdio reader/stderr 线程、pending/event、重连锁 | 同 server/stdio 顺序约束；独立 HTTP origin 有界并行；连接/请求级 deadline 和取消 | 不共享单 connection 并发写，不让重连风暴或队列无限增长 |
| WebDAV / provider / update | stdlib http.client/urllib 同步网络与文件 hash/上传下载 | 每备份 job/主机有界调度，网络与 hash 分阶段，流式读写，失败恢复 | 不重复写同一备份，不自动重试非幂等 PUT/恢复 |
| 本地 CORS 代理 | `ThreadingHTTPServer` 每连接线程 + serve 线程；8KB flush；上游 socket 300s | 每连接有界、全局/目标限流、断开传播、读写背压；保留事件驱动的浏览器侧 | 不把每连接无限线程称多核优化，不在代理内做模型推理 |
| 原生 Win32 窗口 / 浏览器驱动 | create_window/evaluate_js/destroy 有线程亲和；`_js_lock` 单门；超时 zombie 风险；`ui_nudge` RedrawWindow | 统一 native UI dispatcher 回 UI 线程；窗口 key 串行；调用结果异步回传；保留超时降级 | 不从 worker 直接操作 Win32/WebView，不用更多窗口线程掩盖亲和冲突 |
| FreeToken / Ollama / 云模型推理 | 推理在外部进程/服务；Harbor 仅 HTTP/代理/SSE | 优化请求并发、限流、流式传输与本地响应；外部指标单列 | **Harbor 无证据直接执行 CUDA/GPU 推理；多线程不等于 GPU 提升** |
| CPU 重任务候选 | Markdown/highlight、JSON、压缩、hash、搜索/分析可能有 CPU 成分 | profiler 证明占比后选 JS Worker 或 Windows spawn 进程池；小任务留原线程 | 不用 Python 线程绕 GIL，不为微毫秒任务付 IPC/序列化成本 |

## 4. 瓶颈定位矩阵：测量事实与静态嫌疑分开

“静态嫌疑”只确定 profile 优先级，不代表已证实瓶颈。

| 类别 | 已有测量/代码事实 | 静态嫌疑与需补证据 |
|---|---|---|
| 计算 | Markdown/highlight 历史源码测量有成本；聚合、JSON、diff/hash 为纯 CPU 候选 | cProfile/JS profiler 确定占比、输入规模与分配；未证明不得 Worker/进程化 |
| I/O | list_dir 136.776→12.395ms；cache 147.507→3.630ms 来自算法/I/O 减少 | 大文件、MCP、WebDAV、网络磁盘的 read/write/wait 分解；磁盘与远端分别测 |
| 同步等待 | fetch/urllib/http.client、MCP Event.wait、evaluate_js join、锁等待存在 | 首字节、RPC wall、lock wait、连接获取、队列等待时间戳；不能只看函数总时长 |
| 依赖 | lead/member、写工具、同一 stdio、同窗口、同 config/session 文件有顺序约束 | 画资源 DAG，区分可并行只读与必须串行写；不做全局限流一刀切 |
| 共享状态竞争 | RuntimeState 用 RLock；file/mcp/pool 等多把锁；pool close 曾有 TOCTOU 修复 | 锁顺序、快照一致性、close/reconnect/release 竞态压力测试；检查锁内慢调用 |
| 线程亲和 | evaluate_js 明示线程不安全且单门；窗口创建/销毁与 Win32 存在原生边界 | 记录创建线程/调用线程/HWND owner；证明 dispatcher 回 UI 线程，不只加锁 |
| 设备协同 | 外部推理服务与 WebView2 合成器独立；本地代理仅转发 | 分别记录 Harbor 进程、renderer、外部推理进程；GPU 仅在外部可观测时报告 |
| 序列化 | js_api JSON 字符串、SSE JSON、MCP 帧、sessions 深拷贝/双序列化、大附件 | 测量字节数、serialize/parse/copy/IPC；大 payload 分片与背压，不盲目多线程 |
| 渲染/长任务 | schedule 合并已有；rAF+120ms 兜底；真实 DOM 不在 Node 基准内 | CDP LongTask>50ms、layout/paint、帧间隔、Markdown/代码块/1000 事件与长列表 |
| 启动/依赖等待 | boot 有多次 await、3s config race、晚桥补偿；本地代理装配启动 | 标 navigation/DCL/load/bridge/interactive；区分必要串行与可延迟工作，不改状态可见性 |
| 队列/资源 | local proxy 每连接线程；MCP 有 per-server limiter；浏览器池上限 3 | 全局/目标线程、连接、句柄、队列上限与拒绝/降级；压力后 RSS/线程是否回落 |

## 5. 方案比较与选择

| 方案 | 优点 | 主要问题 | 决策 / 撤销条件 |
|---|---|---|---|
| A. 全局大线程池 | 接入快，表面支持多任务 | 资源键冲突、UI 亲和、GIL、连接/内存放大、全局限流、取消困难；易把 I/O 等待变竞争 | **反选**。不得作为默认架构；任何局部 pool 也须有界与所有权 |
| B. 按领域调度器 + 资源键串行 | 保持公开门面，独立 I/O 并行，共享资源有序；可背压/截止/审计/单点撤销 | 需要资源分类、状态与测试；同步阻塞 C/Win32 调用仍只能协作取消 | **选择**。先共享 executor/状态，再逐域 A/B；无收益或回退即恢复该域串行 |
| C. 全进程 / 微服务重写 | 隔离明确，理论可利用多核、独立扩缩 | IPC/部署/安全/契约/会话语义成本最高；微服务网络增加延迟与故障面 | **反选整体重写**。仅允许 profiler 证明的 Windows 进程池执行纯 CPU job |
| D. 全部异步化 / 全 JS Worker | 网络与 UI 模型看似统一 | 重写 stdlib/Win32/公开同步 API，Worker 无 DOM，序列化成本与 sanitization 边界复杂 | 不作为整体方案；仅保留 JS 事件驱动与个别纯计算 Worker |

选择原则：并发度从 **1** 起步，以测量调高；默认不超过领域资源与上游限额。任何“多核=更快”“线程越多越流畅”均无依据。

## 6. 目标架构方向

### 6.1 线程与设备模型

1. **Native UI thread**：拥有 webview 主/次窗 create/destroy/evaluate_js 与需亲和的 Win32；原生 dispatcher 是唯一入口。后台只准备参数和等待结果，不直接触碰窗口。
2. **WebView renderer main JS thread**：唯一 DOM owner；网络、SSE、timer 和 Promise 保持事件驱动；组件按 run/revision 合帧更新。
3. **Python callback/domain workers**：pywebview 回调只进入门面和调度；I/O worker 有界，按 domain/resource key 排队；不得调用 DOM/native UI。
4. **CPU worker（按需）**：JS Web Worker 仅纯数据计算、无 DOM/桥/localStorage；Windows 进程池仅 spawn、纯函数、可序列化、可取消/回收 job。Python 线程只用于 I/O 等待，不用于绕 GIL。
5. **GPU**：Harbor 不声明 CUDA/GPU 计算。WebView2 合成由运行环境管理；FreeToken/Ollama/云推理由外部进程/服务管理。仅在可观测外部进程时单列 GPU util/memory，不据此归因 Harbor 优化。

### 6.2 按领域调度与资源键

| 领域 | 建议资源键 / 初始并发 | 顺序与背压要求 |
|---|---|---|
| config/history/model prefs/experts | 每 canonical 文件 + history generation；写 1，读有界 | 读写锁语义与原子写不变；锁内取快照，慢 I/O 出锁；保存 trailing 最终态必达 |
| sessions / SessionStore | sessionId + store revision；每 store 写 1 | 会话间只读可并行，同一 session 事件顺序；双源/墓碑/60 条不变 |
| workspace files | canonical root + path；同 path 写 1，独立只读有界 | 写前后 fingerprint/Guard 顺序；跨 path 操作按排序键防死锁；不自动重试写 |
| Guard/audit/plan/checkpoint | operationId / taskId / audit sink；写 1 | enforce→executor→audit 顺序；回滚单 task 串行；审计不丢、不乱因果 |
| MCP stdio | serverId；每 client 1 | request id/pending 匹配；写锁与 reader 不变；取消通知 best-effort，关闭清理进程 |
| MCP HTTP | serverId + origin；每 server 1–4 起步 | 连接不共享并发写；per-server queue 有界；重连单 owner、等待者可取消 |
| WebDAV/update | backupId/jobId + host；每 job 1 | manifest/上传/下载阶段化；非幂等操作不盲重试；冲突与恢复原子性不变 |
| local proxy | connectionId + target；全局与每 target 有界 | 上游读/下游写背压；client abort 关上游；慢连接不占满全部 worker |
| native browser | windowId/native UI queue；每窗 1 | UI dispatcher 串行；超时退役但不得再与 zombie 并发；销毁按序 |
| frontend stream/render | runId + element/revision；DOM 1 | 网络分片有界合并，最新帧替换未绘帧；终帧 flush，旧 run 不写新 UI |
| Team | runId/memberRunId；P0 全串行 | 仅独立成员、无共享资源冲突且预算/限流/ownership 证明后才评估并行 |

### 6.3 任务 DAG、ownership 与幂等

统一内部任务 envelope（不改变公开 js_api JSON）：

`taskId, domain, resourceKeys[], sessionId/runId/generation, operationId, deadline, cancelToken, attempt, queueAt/startAt/endAt, payloadBytes, idempotencyKey?, result/error`

DAG 示例：

`API admission → 参数/Guard → 依赖快照 → 排队 → resource-key 执行 → 序列化/提交 → 响应`

- **Ownership**：回调与提交同时校验 session/run/generation/task；取消先阻止未开始任务，再协作中止当前步骤；迟到结果只归原任务，不写新状态。
- **幂等**：读任务可按同 snapshot+key 去重；写、命令、MCP call、WebDAV PUT/恢复默认不去重、不自动重试。需要重试时必须有服务端/本地 idempotency key 与冲突检测。
- **背压**：每 domain/resource key 有运行数、队列条数与队列字节上限；超过上限采用可见等待/结构化忙/降级中的既有兼容方式，不静默无限排队。取消和停止控制优先出队。
- **截止**：deadline 覆盖 queue+connect+read/write+serialize，不只单次 socket；同步 js_api 等待有界。到期返回原错误协议，不虚构后端已停止。
- **异常恢复**：worker 异常不丢队列；连接/文件按所有权清理；重连单 owner；部分任务标 partial，已提交审计/数据不回滚成假成功。
- **锁规则**：固定全局锁顺序，禁止锁内调用 native UI、网络或未知回调；快照出锁后按 revision 提交，冲突走既有语义。

### 6.4 模块改动边界（供架构师映射，非直接实施）

| 模块 | 增量职责 |
|---|---|
| `backend/application/` | TaskEnvelope、DomainScheduler、ResourceKeyQueue、deadline/cancel/backpressure、指标钩子；Operation/Session 协调保持权威 |
| `backend/bootstrap/container.py` | 每领域 executor 单例装配与逆序关闭；不建第二全局大池，不复制 RuntimeState |
| `backend/runtime.py` | 仍只拥有 win/current_sid/ws_enabled；并行任务控制存独立 TaskRegistry，不塞第二运行时状态 |
| `backend/domains/settings|workspace|security|planning` | 声明资源键、快照/提交边界与写顺序；Guard/审计/原子写不变 |
| `backend/domains/integrations/mcp|webdav|browser` | 适配有界网络/连接/窗口调度；保留协议、SSRF、DPAPI、窗口降级与清理 |
| `backend/domains/providers` | local proxy 有界连接与断开传播；provider 仅连通测试，不成为第二模型运行时；先修 prompt_loader 路径 |
| `main.py` / native dispatcher | native UI 线程注册、调用、关闭排空；不主动启动 exe 验证 |
| `frontend/providers/request.js`（由 45 提取） | fetch/SSE/AbortSignal/deadline/backoff；保持事件驱动与端点行为 |
| `frontend/agent/model-executor.js`（由 60 提取） | run/actor ownership、工具 DAG、写串行、背压与终态；普通/专家共用 |
| `frontend/stream-renderer`（由 50 提取） | DOM 单线程合帧、latest-wins、终帧 flush；Worker 只接收纯文本并返回安全中间结果 |
| `frontend/analytics`（78） | revision 快照、按需计算/分片； profiler 后再决定 Worker |
| `frontend/boot`（110） | 必要串行与懒加载 DAG；晚桥幂等，不能为并行启动改变配置可见顺序 |
| `tools/perf_*` | 增加系统/浏览器/竞争/取消/压力指标与原始样本；无新依赖、无 exe 自启动 |

## 7. CPU / GPU 工作分配

| 工作 | 主执行位置 | 可选卸载与前提 |
|---|---|---|
| DOM/layout/focus/组件提交 | WebView renderer 主线程 | 不可卸载；只减少工作、分片与合帧 |
| fetch/SSE/重试/Abort | JS 事件循环 | 不加网络线程；大 JSON/SSE parse 经 profile 后可纯 Worker |
| Markdown/highlight | 默认主线程终态/闭合块 | profile 证明 >50ms 或帧回退后，Worker 处理纯文本；消毒与 DOM 仍主线程 |
| Python 文件/网络/子进程等待 | 有界 I/O worker | 不承诺多核 CPU；减少无效 I/O 优先 |
| JSON/diff/hash/压缩 | 默认当前域 | profiler 证明大 payload CPU 占比且收益超过 IPC 后，Windows spawn 进程池 |
| Win32/WebView 窗口 | native UI dispatcher | 不可卸载到普通 worker；纯截图像素处理可另行 profile |
| 模型推理 | FreeToken/Ollama/云外部进程/服务 | Harbor 不做 CUDA 调度；只优化请求/传输/显示，外部 GPU 指标单列 |
| WebView2 GPU 合成 | Chromium/WebView2 内部 | 不暴露为 Harbor CUDA 成果；减少 blur/重绘/大面积图层 |

## 8. 性能验证 PRD

### 8.1 协议与样本

- 以 `outputs/perf/parallel-baseline.json` 为当前首轮对照起点；同机、同电源模式、同 OS/WebView2/Python/Node、同数据集、同端口/上游与后台负载记录；baseline/A/B 背靠背，顺序交替，保存 dirty tree hash。
- 冷/热分开：冷包含新进程/新 profile/首次枚举；热明确预热内容。不得把首轮高值混入热样本后再宣称提升。
- 每场景 **至少 7 次有效样本**，报告中位数、P95/P99、min/max 和全部原始样本；说明 percentile 算法。7 次仅探索，P99 小样本不稳定，发布尾延迟结论宜 ≥30 次，禁止删异常值而不披露。
- 每组都有 correctness checksum/返回形状/事件顺序/usage/终态断言；性能脚本失败不得转成性能通过。

### 8.2 指标

| 维度 | 必采指标 |
|---|---|
| 延迟 | queue/connect/first-byte/total/交互响应；median/P95/P99；RPC 与模型等待分解 |
| 吞吐 | 完成任务 tasks/s、文件 entries/s、网络 MiB/s、SSE chunks/s；按并发度与数据规模 |
| 流畅性 | JS LongTask >50ms 次数/总时长、帧间隔、layout/paint、卡顿窗口、输入到绘制 |
| CPU | Harbor Python、renderer、worker/process pool 分进程利用率与时间；按逻辑核归一，拒绝只看总机百分比 |
| 内存 | 峰值/稳态 RSS、JS heap、payload 与队列字节；压力结束后回落 |
| 资源 | 线程数、句柄、socket/连接、进程数、队列深度/等待、僵尸 worker |
| I/O | read/write bytes、open/stat 次数、磁盘等待（工具可得时）、网络等待与重试 |
| GPU | 仅外部推理进程或 WebView2 可观测时，单列 util/memory/进程来源；工具缺失标未覆盖 |

### 8.3 场景矩阵

1. **Baseline/A/B**：当前串行 vs 领域调度，同 fixtures；先算法去重版本与并行版本分开比较，避免把算法收益归因多线程。
2. **并发度扫描**：每领域 1/2/4（必要时 8）任务；记录吞吐与尾延迟拐点，默认选满足回退门的最低并发。
3. **压力**：大目录/大 JSON/长 Markdown/1000 sessions-events、多 MCP 主机、慢 WebDAV、慢/断开本地上游、队列超限；持续至资源达到稳态并观察回落。
4. **竞争**：同文件写、同 session 保存、同 stdio、同 server 404 重连、pool close+release、同窗口 evaluate/destroy、跨会话取消；验证锁顺序与幂等。
5. **取消/截止**：queue 中、connect、read、write、render、member 等待时取消；停止/切会话后无新任务、无新 UI、无失控线程，迟到结果正确归属。
6. **真实边界分列**：Node no-DOM、Python 源码、静态 headless、源码 WebView2、外部 FreeToken/Ollama、exe 真机分别报告；不主动启动 exe，未覆盖不填 PASS。

### 8.4 性能回退门

- **功能门先于性能门**：W2 与当次全量 0 failed 后才允许性能验收；任何新增正确性失败、契约漂移、Guard/审计弱化均阻断。
- 普通默认路径不得因共享 executor 增加无意义任务/线程/包调用；启动无并行需求时保持现有行为。
- 候选优化至少在一个目标指标有稳定收益，且其他关键指标无未解释回退。初步回退门：median 或 P95 退化超过 `max(10%, 同机预注册噪声下限)`、出现新增 >50ms 长任务、峰值 RSS/线程/句柄不回落、取消变慢或终态错误即拒绝；具体绝对噪声下限由首轮基线冻结。
- 全核 CPU/GPU 占用率本身不是成功；高占用伴随吞吐不升、P95/P99 变差或资源泄漏即为反证。
- 无提升或收益小于调度开销时撤销该域并行，保留测量与串行路径；不保留长期双执行路径。

## 9. P0 / P1 / P2 实施顺序

### P0：正确性、测量与共享底座

1. 修复 W2 全部功能失败并重新跑当次全量；不得沿用 1510/25 作为当前结果。
2. 修复 `prompt_loader` 迁移路径/注释、构建器 manifest 注释与 CSS manifest 接缝；import/py_compile、静态路径、API/release/UI/build×2 全通过。
3. 冻结性能协议与基线：补 queue/wait/tasks/s/P95/P99/RSS/线程/句柄/LongTask，标清 Node/headless/源码/外部边界。
4. 建共享 TaskEnvelope/executor/ownership/deadline/backpressure 与 native UI dispatcher；初始并发 1，行为差分零变化。
5. 共享前端 transport/executor/render 与后端资源键；普通聊天、文件、MCP、会话、Guard/审计先验证串行等价。
6. 全局现代 UI 与专家模式继续按统一架构实际完成，不停留在本文档。

### P1：逐域有界并行与体验优化

1. 独立只读文件/搜索、独立 MCP HTTP origin、独立 WebDAV/网络任务按 A/B 开启；资源键与背压全量竞争测试。
2. local proxy 连接限额、慢上游背压与断开传播；MCP 重连/关闭、WebDAV 非幂等恢复专项。
3. 前端长任务分片、分析/事件索引与启动 DAG；CDP 证明长任务和交互改善。
4. profiler 证明后选择单点 JS Worker 或 Windows 进程池；做 spawn/IPC/取消/冻结/PyInstaller 验证。
5. Team 仍默认串行；仅独立成员在预算、上游限流、ownership、mailbox 顺序和 A/B 全部通过后评估并行。

### P2：扩展与调优

1. 按数据调整每领域并发、队列与缓存；保留最低并发默认与一键退回串行。
2. 有界 Team 并行、更多 Worker job、外部 GPU 观测面板（仅证据存在时）。
3. 跨机器基线与长期性能趋势；不得把一台机器结果写成普遍 SLA。

## 10. 风险与撤销条件

| 风险 | 控制 / 撤销 |
|---|---|
| 用性能改动掩盖 W2 失败 | P0 功能门；失败名单独立追踪，性能分支不得改断言或跳过 |
| 全局池导致资源耗尽 | 按域/目标有界队列、RSS/线程/句柄压力回落；失控即回该域串行 |
| 共享资源竞态与死锁 | 资源键、锁顺序、写 1、竞争/关闭测试；任何数据/审计错误即撤销 |
| UI/native 线程亲和破坏 | DOM 单线程 + native dispatcher；记录线程身份，违规调用测试失败 |
| Python GIL 假多核 | I/O 与 CPU 分类；CPU 仅 profiler 后进程池，不用线程数证明加速 |
| IPC/序列化大于收益 | 小任务不卸载；A/B 包含序列化和 spawn；无净收益撤销 |
| 网络重试放大数据/费用 | 非幂等不自动重试；上游限流/预算/deadline；队列字节上限 |
| 取消伪语义 | queue/步骤协作取消，socket close best-effort；同步 C/Win32 不宣称强杀 |
| Team 提前并行破坏回流 | P0 串行真回流；并行需独立成员/预算/限流/mailbox/order 证据 |
| GPU 表述失真 | 外部推理与 WebView 合成单列；无 CUDA 证据、工具缺失标未覆盖 |
| 覆盖现有未提交成果 | 新 WaveGuard 白名单/hash，按域小批，不整库 reset/checkout/stash，不改历史证据 |

## 11. Out of Scope

- 全局无线程上限的大池、为绕 GIL 使用 Python 线程、全微服务重写、引入新框架/模型 SDK/运行时依赖。
- 在 Harbor 内实现 CUDA/ROCm/Metal 推理，或将多线程/多进程描述成 GPU 加速。
- Worker 直接访问 DOM/pywebview/localStorage，普通线程直接操作 native window。
- 改变 js_api/config/sessions/Guard/审计/公开返回、普通/专家 run 语义或默认 Team 串行。
- 通过删测、skip、放松契约、隐藏长任务或全核占用率制造性能成功。
- 主动启动 exe；无工具/无端点/无外部 GPU 数据时编造覆盖。

## 12. 需架构师统一裁决

1. DomainScheduler 与现有 OperationCoordinator/SessionCoordinator/TaskRegistry 的唯一所有权及公开同步门面适配。
2. 各领域 resource key、锁顺序、默认/最大并发、队列条数/字节与 deadline；哪些读可去重，哪些写永不重试。
3. native UI dispatcher 在 pywebview 当前版本的可行实现；create/evaluate/destroy/RedrawWindow 的线程亲和和超时退役语义。
4. local proxy 在 stdlib 下如何限制每连接线程、传播 browser abort 并关闭上游，避免慢连接耗尽。
5. 共享 ModelExecutor 的工具 DAG 如何保留 WRITE_SEQ_TOOLS、Guard、CAPTCHA、usage 与普通/专家终态。
6. 性能工具的 Windows/Node/CDP 无依赖采集方案；P95/P99 样本量、噪声下限与绝对回退门。
7. 哪些纯 CPU job 达到 Worker/进程池门槛；spawn 在 PyInstaller onefile 的冻结引导与资源清理如何验证。
8. W2 修复、共享 executor、全局 UI、专家模式与逐域并行的新 Wave 顺序和文件白名单。
9. Team 并行的独立成员证明、每上游限流、预算分配、mailbox 顺序与默认关闭策略。

---

**总验收口径**：先功能正确，再按资源类型并发；先减少无效工作，再讨论多核；UI/原生窗口守线程亲和，I/O 有界且可取消，CPU/GPU 结论必须有进程级证据。