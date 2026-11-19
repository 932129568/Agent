# v1.5 遗留项全量接线交付报告（2026-10-17 晚）

**任务**：用户裁决「遗留项在这一版一起做完」——将 v1.4 联调报告中列出的预留未接项全部落地。
**基线**：459 passed → **477 passed 全绿**（+18 新增），check_contract PASS，build 40 模块幂等。

## TL;DR

三批全部完成：**B1-B5 适配层接线**（压缩自适应/工具降级/慢推理 watchdo×/Ollama 特情/MCP 保守）+ **S1-S2 MCP 池化温启**（连接池真实回环/spawn 打点透出）+ **WebDAV IO 执行器**（五方法接真+冲突四策略）。过程中修正两个原预留设计缺陷（S2 泄漏面、WebDAV 对拍误杀），均以真实回环测试钉住。

## 一、B 组 · 适配层接线（5/5）

| # | 落地 | 文件 | 测试 |
|---|---|---|---|
| B1 | local 模式压缩阈值 = 模型窗口 × 档位比例（.4/.6/.8）；前端 `compactThresholdLocal` 与后端 `compact_threshold` 同口径复刻（窗口三级来源：元数据→手设→默认 8k） | 34-local-model.js、40-auto-compact.js | 阈值矩阵 12 断言 |
| B2 | 400 双降级链：thinking 被拒→剥 GLM 字段重发；错误体含 tool/function 特征→去 tools 重发+toast；`local_tool_capable=off` 根本不发 tools | 60-agent-loop.js | 特征匹配 4 断言 |
| B3 | 首字节 >5s「本地推理中（已等待 Ns）」秒级刷新；idle 120s 停滞提示（并发 interval 检测——read() 挂起期间循环体不执行，必须如此）；local max_tokens 默认 4096（仅覆盖模板默认 16384，显式值尊重） | 60-agent-loop.js（函数级 timer，catch 清理） | 源码级 |
| B4 | `humanizeApiError(msg, isLocal)` 本地错误表（503 loading/404 双型引导/401 免 Key），未命中回落通用表；fetchGLMStream 503 指数退避 [2,4,8]s | 76-cost-estimate.js、45-request-debounce.js | 四态分类断言 |
| B5 | local 模式 MCP 确认框追加「本地模型生成的工具参数未经云端模型校验」；会话信任降级仅本任务有效 | 62-mcp-exec.js | 源码级 |

## 二、S 组 · MCP 稳定性与速度（S1/S2）

**S1 连接池**：`HttpTransport._post_pooled`——http.client per host:port 复用、keep-alive、空闲 60s 回收、错误连接不污染池。安全口径逐条保留并用**本地回环服务器**实证：
- no-redirect：302 显式拒绝带 code（实测）
- 协议头强制覆盖/用户头垫底（不变）
- Mcp-Session-Id 回收（成功+错误双路径，实测 sess-loop-1）
- SSE 增量读/watchdog（复用 S14 路径，实测）
- 32MB 防 OMM 上限（不用 provider 的 64KB——MCP 工具结果帧天然数百 KB，会砍断 read_file 大结果）
- **双路径兼容**：宿主替换过 urlopen（测试桩/嵌入方）自动回落原 urllib 路径——既有 HTTP 用例零修改全绿

**S2 温启**（含一次设计修正）：
- `_spawn_client` 打点 spawn_ms；`_get_or_spawn` 温启优先（warm 命中活 client 跳过 spawn）；list_servers 透出 warm/spawn_ms
- **设计修正实录**：初版实现「IDLE 到期转 warm 续期 600s」——被既有测试 test_idle_recycle 挡下后复查发现真实风险：**停用服务器的子进程会多活 600s**（泄漏面翻倍）。最终版：IDLE 到期直接关（原语义），warm 只承担启用预热索引（mcp_save_server 启用路径本就走 test_server，预热已天然具备）+ 关闭路径同步摘除
- WarmRegistry 新增 `pop()`（取出并关，防 reap 后子进程泄漏）

## 三、WebDAV IO 执行器（含一次设计修正）

五方法接真（stdlib http.client，零依赖）：
- `test_connection`：OPTIONS（DAV 能力声明）+ PROPFIND depth 0；401 人话
- `export_backup`：MKCOL（409=已存在 OK）→ 逐文件 PUT → manifest.json
- `restore_backup`：下载 → 三方冲突判定 → 按策略落盘
- 配置：webdav.json 独立文件，DPAPI 字段级加密（复用 mcp_dpapi）

**设计修正实录**：初版「下载内容 sha256 vs manifest 硬对拍，不符拒恢复」——写测试构造「远端演进」场景时发现该逻辑会把**另一台机器的正常备份更新误杀成完整性错误**，用户连冲突决策的机会都没有。修正：manifest sha 退位为「上次导出快照=三方基线」，完整性保障改为**落盘后重算 sha 与下载内容对拍**（磁盘写入一致性）。ask 策略检出真冲突返回 need_decision 交 UI。

安全：路径穿越防护（仅 BACKUP_SCOPE 白名单相对名）、https 强制（localhost 除外）、no-redirect、错误响应 64KB 读上限。

## 四、测试（tests/test_v15_wire.py，18 用例全绿）

- B1 阈值矩阵 / B2 特征匹配 / B4 错误四态
- S1 真实回环：连接复用 + SSE + 302 拒绝 + 错误不污染池
- S2 WarmRegistry 生命周期（注册/过期/pop/reap）+ stale/backoff 助手 + 并发限流
- WebDAV 本地 DAV 服务器：连接/401/导出/remote_wins 下拉/ask 冲突不落盘/keep_both 另存/远端演进/路径穿越/配置 DPAPI 往返

## 五、测试基建修正（本轮 6 处，均为测试侧）

1. `waiting` 是 property 非方法
2. vm 沙箱 `let` 不挂 sandbox（改 UI 间接验证）
3. innerHTML 忠实桩（children 索引访问）
4. 元素引用 vs 值捕获（状态文本被后续操作覆盖）
5. remote_wins 测试场景构造错（only_local ≠ only_remote）
6. DAV 远端路径推导漏 URL 前缀

## 六、门禁与遗留

- `pytest tests/ -q` → **477 passed**；check_contract → PASS；build → 40 模块幂等
- **起窗冒烟仍需目标机**（本环境无 webview）：本地模式端到端、WebDAV 真实服务器、连接池性能实感
- 性能基准（P95 -40% 目标）需目标机本地回环实测
- v1.5.x 版本号未 bump（代码全部就绪，建议随发布节奏 bump 1.5.0）
