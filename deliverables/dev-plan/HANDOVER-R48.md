# Harbor R48 轮报告（2026-11-07）——缺陷猎扫轮（R39-R47 增量全扫）

> 协议：R37 同款——只读扫描代理广撒网（git diff 2e7e4b9..HEAD 全量 115 文件）
> → 主会话逐条实证 → 修复。扫描报告（本地）：
> `outputs/r48-scan/scan-report.md`。**8 候选 8 实证全真（0 误报）**，全部修复。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 扫描 | 全量增量 115 文件（R39-R47 九轮），8 候选 8 真 0 误报 |
| 修复 | 8/8（死路 1 + 提档死循环 1 + 裁剪逃逸 1 + 静默回退 2 + 生成器回退 1 + 诚实契约 1 + 死写者 2 + 保留期 1——部分条目双修） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r48**（1266 符号）/ audit PASS / 桥侧 20 PASS / **pytest 1991 passed / 0 failed / 3 skipped** |
| 新增测试 | `test_r48_scanfix.py`（8）+ r42 断言对齐 1 |

## 1. 修复清单（编号=扫描报告编号）

| 编号 | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| R48-1 | `chat/send.js` | **排队 steering 死路**：`_queued=true` 后必命中 `_sendSessionBusy` 同会话 return（与 RunRegistry 同读恒同真）→ 消息永不入库、输入残留、toast 失实；残留旗毒化 run 结束后的下一次正常发送（入库但跳过 runAgentLoop，永不回复） | busy 检查放行 `_queued`（`&& !sendMessage._queued`）；catch 路径清旗 |
| R48-2 | `tool-executor.js:119` | **open_url 提档死循环**：N11 入矩阵但分发丢 guardToken——确认后签发的 token 不携带，session/always 档 enforce_exec 恒拒 | 补 `withToken([args.url], guardToken)`（open_app H8 同款） |
| R48-3 | `run-controller.js:345,459` | **折叠模式 MCP 不可达**：mcp_search 不在路由 bypass 集（仅 mcp__/browser_/software_/memory_），MCP>25 折叠 + 路由命中时唯一发现入口被裁 | bypass 正则 +`mcp_search`（两处） |
| R48-4 | `composer-hub.js:270` | R47 改名后 `hubRenderAll` 仍读旧全局 `HUB_CATALOG`，typeof 守卫静默回退 `{}` → 目录四页签计数恒 0 | 改 `hubCatalog()` |
| R48-5 | `tools/build_hub_catalog.py:461` | 生成器 TEMPLATE 未随 R47 迁移——按文档跑刷新会整文件回退旧格式并与 manifest 失配 | TEMPLATE 懒加载化（HUB_CATALOG_JSON/hubCatalog/引用段全部改写） |
| R48-6 | `tools_schema.py` | memory_write schema 广告 kind enum 但分发丢弃（memory_remember 无 kind 形参）——诚实契约缺口 | schema 移除 kind（分层由分类器按句式自动判定，描述注明） |
| R48-7 | `run-registry/controller` | 面板死写者：run.status 仅 start 写 'working'（paused/failed 写的是 session.runStatus）、currentTool 全前端 0 写者 → 「等待输入」不可达、「在跑工具」恒空 | setSessionRunStatus 同步 run.status；executeRunTool 写/清 currentTool（finally） |
| R48-8 | `trace_service.py` | traces JSONL 无保留期——长跑磁盘只增（N7 同类只增面） | RETENTION_DAYS=14，span 写入时 _retain 按 mtime 清过期文件 |

## 2. 扫描排除项（已复核为防御/不可达，留档）
db_service 无锁读 conn（写侧 autocommit 单语句，R39 前既有形态）、notes `.index('\n')` 空窗（产品链路不可达）、search mktime 时区微偏（仅打分）、browserSnapshot elements 计数口径差（无消费方）、Node refundToken 死代码（既有面）、harbor:// 白名单/main.py vhost/S2-6/7/12/N7/N9/N14/N15/provenance R44 正则/registry 签名同步——复核无缺陷。

## 3. 测试对齐（非掩盖问题）
- r42 notes 断言：bypass 正则随 R48-3 扩展对齐（`+mcp_search`）。
- 新增 `test_r48_scanfix.py` ×8：逐项锁定修复形态（其中 R48-8 用 2000-01-01
  mtime 过期文件实证 _retain 清理）。

## 4. 门禁记录
```
build×2 / 五契约 / 锚点 r48 差分零漂移 / upgrade_audit PASS / 桥侧 20 PASS
pytest tests/ -q → 1991 passed / 0 failed / 3 skipped
```

## 5. 扫描方法论沉淀
- 排队/旗标类改动必须追「谁读这个标志、中间有没有同步 return」——本次
  R48-1 的死路正是 flag 写点与消费点之间被既有 busy 检查截断。
- 改名/形态迁移（R47 懒加载）后 grep 旧名的**引用侧**而不是定义侧——
  R48-4/R48-5 都是定义侧改完、消费侧（composer-hub/生成器 TEMPLATE）漏网。
- schema 广告的每个字段都要能在分发链找到消费者——「诚实契约」检查应进
  新工具的验收清单。

## 6. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R48.md` |
| 扫描报告（本地） | `outputs/r48-scan/scan-report.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r48.json` |
