# Harbor R40 轮报告（2026-11-07）

> 接续 `HANDOVER-R39.md` §6 待办：P1 四项全部落地 + 新发现缺陷 R39-D2 修复。
> 逐项含实证；修法与测试对齐说明如实。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 本轮提交 | 2 笔（feat 主批 / fix 桥侧+锚点批） |
| 修复/新增 | R40-1 harbor:// 协议（code cache 解锁）· R40-2 K10 per-sid · 竞态 5 项（N14/N15/S2-6/S2-21/S4-5）· R40-4 记忆钉选 full 视图 + **R39-D2 新缺陷修复** |
| 门禁 | build×2 逐字节一致 / 五契约 PASS / 差分零漂移（锚点 **r40**）/ upgrade_audit PASS / 桥侧 20 脚本 PASS / **pytest 1948 passed / 1 failed（预存遗留）/ 3 skipped** |
| 契约锚点 | `contract-baseline-r40.json`（115 模块 / 1260 符号；ggRulesSeq 登记后重照） |
| 新增测试 | `test_r40_desktop_protocol.py`（3）· `test_r40_k10.py`（3）· `test_memory_db.py` 钉选回归锁强化（反字母序） |

## 1. R40-1 harbor:// 自定义协议（F2d 改法①落地）

**依据**（F2d 调研 25 轮）：code cache 仅对 http(s)/WebUI 启用，file:// 页永远无
（crbug 40288216）；命中 code cache 反序列化≈快 2×。Harbor 前端 3.8MB 单文件
+ 5 个 libs 外链，二者都吃不到 cache——本改法不动 HTML 结构。

**实现**（`electron/main.js`，生产链；pywebview 回退链保持 file:// 留待办）：
- `protocol.registerSchemesAsPrivileged`：`harbor` scheme 带 `standard+secure+
  supportFetchAPI+stream+codeCache`（Electron 45 d.ts 明示 codeCache privilege
  即为 custom protocol 启用 V8 code cache）；模块顶层调用（先于 app ready）。
- `protocol.handle('harbor')`：**严格白名单**（harbor.html + build.js
  REQUIRED_LIBS 同源 5 个 libs 文件），hostname 必须 `app`，越界/未知 404，
  处理器异常 fail-closed 500；MIME 按扩展名（js 不得 text/html）。
- `loadURL('harbor://app/harbor.html')` 替代 loadFile；CORS_ORIGIN 注入
  `null,harbor://app`（server 精确匹配集合）；S2-14 will-navigate 守卫随
  加载方式二选一（PAGE_ORIGIN_OK）。
- 回退开关：`HARBOR_LEGACY_FILE_PROTOCOL=1` 恢复 file://（排障用）。
- 前端零改动（grep 证无 file:// 依赖；CSP 无 connect-src 限制）。

**门禁**：`tests/test_r40_desktop_protocol.py`（3）——privileges 注册、白名单
闭集+fail-closed、CORS/导航守卫/MIME 源码契约。真机 code cache 生效验证留
待下轮真机轮（DevTools Performance 看 Evaluate Script/Compile 差异）。

## 2. R40-2 K10：begin_task 去重器 per-sid 化

**原缺陷**（R37 留档 §5.2 首项）：`api.begin_task` 无条件清全局 RunDeduper——
与他会话在飞 run_command 交叠时其在飞登记被洗白（模型循环写命令的安全网失效）。
**Node 侧 P0-3 时已修**（commands.js `${sid}:${cmd}` 前缀 + begin_task 仅清当前
sid）——本轮 Python 侧对齐同语义。

**实现**：`CmdService` 增 per-sid 命名空间（`_deduper_for(sid)`，容量 64 FIFO
防线；空 sid 回落 legacy 单实例契约兼容；`__new__` 直构懒初始化兜底）；
`run_command/run_powershell/run_admin_command` 的 check/unmark 全部按入参 sid
路由；`begin_task` 只清 `runtime.get_current_sid()` 的窗口（W2「同会话新任务
从零」保留）。RunDeduper 类本体零改动。

**测试**：`test_r40_k10.py`（3）——A 的登记不被 B 的 begin_task 洗白 /
run_command 按 sid 隔离+回滚不串台 / Api 层 begin_task 接线。

## 3. R40-3 竞态五项（R37 留档 §5.2 消化）

| 编号 | 位置 | 修法 |
|---|---|---|
| N14 | `group_files_service.py` write | 查名+落盘包进模块级 `_WRITE_LOCK`——原 exists 探测与原子写之间无锁，同秒同标题并发互覆 |
| N15 | `workspace_service.py` touch_recent_ws | 读改写包进实例 `_lock`（RLock 可重入，set_session_ws 持锁调用兼容） |
| S2-6 | `server/services/misc.js` history_dir_set | 拷贝前对活体库 `PRAGMA wal_checkpoint(TRUNCATE)`——原直接 copyFileSync，已提交事务还在 -wal 里，拷出目标库静默丢尾部事务；checkpoint 失败退化为原行为 |
| S2-21 | `server/src/auth.js` | AUTH_ENABLED=true 且 AUTH_SECRET<32 字符 → **fail-fast 拒绝启动**（原仅 warn 后回落固定 dev 密钥——假性安全比不认证更危险）；缺省 AUTH_ENABLED=false 零行为变化 |
| S4-5 | `frontend/shell/grants.js` | `guardGrantRulesRefresh` 独立 `ggRulesSeq`——原与用户操作共享 grantReqSeq，刷新 bump 静默丢弃在途操作响应（manifest 登记） |

## 4. R40-4 记忆钉选 full 视图 + R39-D2 新缺陷修复

**R39-D2（新发现，R39 引入）**：fact 钉选在注入段**完全无效**——钉选按
`fact_id` 存（list_entries/pin），注入排序比对的是 `attribute` 键，恒不命中。
实证：pin 前后 extras_block 顺序不变；R39 的原断言因 attribute 字母序
（backup<deploy）**巧合通过**。

**修复**：`db_service._pinned_keys()`——profile 按 key、fact 解析
fact_id→attribute（is_current=1，被软关闭的钉选条目自然退出排序）；
extras_block 与 context（full/profile_only 派生视图）统一用它排序。

**R40-4**：`memory_context_build`（full 模式）的 current_facts/profile 现同样
钉选置前（R39 仅 extras_block 生效）。

**回归锁强化**：`test_memory_db.py` 钉选用例 attribute 改反字母序（z_deploy
钉选 vs a_backup）——字母序巧合通过被结构性排除；新增 full 视图断言。

## 5. 门禁记录

```
node frontend/build.js ×2   → 31176 行逐字节一致
check_contract.py           → PASS（115 JS / 14 CSS）
contract_diff --snapshot r40 → 115 模块/1260 符号；--compare → 漂移项: 无
upgrade_audit.py            → 违规项: 无
server/test/*.mjs ×20       → 全 PASS（migration.mjs 曾一次 Segmentation fault，
                              三连复跑+全量复跑均绿——libsql 原生绑定高频起停
                              偶发，非本轮改动引入，留观）
pytest tests/ -q            → 1948 passed / 1 failed（预存遗留 windows-packaging）/ 3 skipped
```

## 6. 遗留待办

### P1（下轮优先）
1. **pywebview 回退链的虚拟主机映射**（WebView2 `SetVirtualHostNameToFolderMapping`
   → `https://app.local/`）——Electron 已做，Python 链对齐后两条宿主都吃 code cache。
2. **真机验证 harbor:// code cache**：DevTools Performance 对比 Evaluate
   Script/Compile；`HARBOR_LEGACY_FILE_PROTOCOL=1` 对照。
3. 竞态余项：K10 之外的 §5.2 剩余（N7 ring buffer / N9 边读边截 / N11 open_url
   入矩阵 / S2-16 privateIp 补段 / S2-16 DNS rebinding / S4-7/8 回退分支转义）。
4. 资源类 §5.3 剩余 5 项 + 工具链 CI §5.4 六项 + 代码卫生 §5.5 四项。

### P2
5. `dist/Harbor.exe` 旧包重打（vendor Py3.13）——本批 electron/main.js 改动
   需重打包才在安装版体现。
6. 混合记忆升级触发条件不变（条数过千或精确率投诉）。

## 7. 本轮踩坑（增量）
1. **测试断言防「字母序巧合」**：R39-D2 的教训——涉及排序的断言，构造数据时
   让「未修复」与「已修复」的期望顺序相反（反字母序钉选），巧合通过被结构性排除。
2. libsql（@prisma/adapter-libsql）在高频起停的测试循环里偶发 Segmentation
   fault（本轮 migration.mjs 一次，三连复跑全绿）——桥侧脚本报 FAIL 先复跑
   三次再定性。

## 8. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R40.md` |
| 上轮报告 | `deliverables/dev-plan/HANDOVER-R39.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r40.json` |
| F2d 调研 | `outputs/r37-research/F2d-frontend-loading.md`（本地留存） |
