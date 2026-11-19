# Harbor R39 轮报告（2026-11-07）

> 接手人须知：本报告只写**已落地并验证**的内容，每条可复跑。上轮遗留见
> `HANDOVER-R36-R38.md` §5（35 项留档）——本轮消化其中 P0 全部 + P1 的 9 项，
> 另发现并修复 1 个 R38 引入的新缺陷（R39-D1 记忆折叠）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 本轮提交 | 2 笔（feat+perf P0 批 / fix P1 批） |
| 代码改动面 | 18 文件，+约 800 / −40 行 |
| 修复/新增 | P0×3（D24 流式渲染、记忆 UI 完整化、发送链接入）+ R39-D1 新缺陷修复 + P1×9 |
| 门禁 | build×2 逐字节一致 / 五契约 PASS / 契约差分零漂移（锚点 **r39**）/ 升级审计 PASS / 桥侧 20 脚本全 EXIT=0 / **pytest 1942 passed / 1 failed（预存遗留）/ 3 skipped** |
| 契约锚点 | `contract-baseline-r39.json`（115 模块 / 1259 顶层符号；api.py 新增 3 隐身方法后重照） |
| 新增测试 | `test_perf_guards.py` +1（D24 源码契约）、`test_memory_db.py` +3（折叠/逐条管理/Api 面）、`server/test/guard.mjs` +3（S2-20/S2-22）、`server/test/migration.mjs` +2（S2-7） |

## 1. P0-1 块级冻结流式渲染（D24，F3a 落地）

**根因**：`run-controller.js` onDelta 每次 paint 都 `renderMd(fullContent)` 全文
marked+DOMPurify 重解析 → O(n²)，1 万字回复流式全程卡顿。

**修法**（`frontend/src/components/markdown.js` 新增 `renderMdStream`/`resetMdStream`）：
- 按 `marked.lexer` 顶层 token 切分，**已闭合块冻结**（`doneRaw`/`doneHtml` 累计，
  每块终身只过一次解析+消毒），每 delta 只重渲染尾部活动块；
- 未闭合 ``` 围栏由 lexer 自动按代码块补全（F3a③，消除裸符号闪烁）；
- 增量前提破坏（重生成/截断/换轮内容）→ startsWith 校验失败自动全量重建（自愈）；
- 轮次边界 `beforeRound` 调 `resetMdStream(mdBody)` 复位（mdBody 每 run 一个、每轮重写）；
- 轮末/流末保留 `renderMd` 全文权威渲染（跨块语义如引用链接后置定义，终帧纠正）；
- 降级环境（无 marked.lexer/DOMPurify）原路 `renderMd`。

**实证**（Node 冒烟，1 万字/120 delta）：全文重解析 32ms → 块级冻结 3ms，**10.7x**
（真机 DOMPurify 占比更高，收益更大；对标 F3a 调研的 6x 与业界 1.1s vs 6.4s）。
流式尾帧结构与全量渲染段落数一致（40/40）。

## 2. P0-2 记忆模块 UI 完整化 + R39-D1 新缺陷修复

### 2.1 R39-D1（新发现，R38 引入）：多条记忆互相折叠只剩最后一条
- **根因**：`agent_memory` 的 `facts.put` 同 `(entity_id, attribute)` latest-wins
  （R15 唯一性 partial index 设计）；R38 接入把所有 legacy note 与默认记忆全写进
  同一 `attribute='legacy_note'`（`db_service._sync_legacy` / `api.append_memory`
  镜像 / `memory_remember` 缺省 `'note'`）→ 第二条起逐条 supersede 前一条。
  Python 侧实证复现：3 条迁移后 current 仅剩最后 1 条。
- **修法**（Harbor 侧，不动参考实现）：新增 `_text_attr(prefix, text)`——
  attribute 携带规范化文本 sha1 指纹（`legacy_note:<sha12>` / `note:<sha12>`），
  多条并存；同文本重放幂等（facts.put 值相同 → noop）。`_sync_legacy` 重建
  DELETE 改前缀 LIKE，兼容清理 R38 时代的折叠残留库（整库自愈）；
  `extras_block` 过滤同步改前缀口径。
- **测试**：`test_legacy_multi_note_no_supersede`（3 条并存）+ 2 处旧断言按根因
  更新（原断言钉住折叠行为，R37 `===`→`!==` 同款先例）。

### 2.2 面板逐条管理（删除/钉选/来源·置信度/上次命中）
- 后端：`MemoryDbService.list_entries/pin/erase_entry`（`ui_meta` 伴生表存钉选，
  agent_memory 参考实现零改动；审计走 `events.append` 保哈希链；fact 单条删除=
  双时间轴软关闭 is_current=0+valid_to=now，历史行保留可审计；legacy 命名空间
  条目只读——重建会复活，删除仍归 legacy 面板管）。
- api.py：3 个 `_V12_EXTRA` 隐身方法 `memory_entries_list/memory_entry_erase/
  memory_entry_pin`（docstring 51→54 如实修正）。
- 前端（`settings/memory.js`）：扩展记忆库状态行下挂逐条区——每条文本 + 徽标
  （来源人话/置信★级/命中次数·上次命中或记录时间）+ 钉选/删除按钮；钉选条目
  注入段恒置前（`extras_block` 排序）；legacy 增删后扩展区自动同步刷新。
- manifest 新符号 9 个登记（provides/requires 同步，build lint 验证）。

### 2.3 发送链接入（P0-2b）
`run-controller beforeRound` 的 `build_system_prompt` 调用现在传当前任务文本
（routeText 前 400 字）作 query——W11 相关性注入自此真正激活（此前恒空 query，
只有常驻 rule/preference 生效，query 相关 top2 与扩展库排序是死路径）。
纯 legacy/无记忆用户输出逐字节不变（`_memory_inject` 空段回退语义未动）。

## 3. P1 契约分叉裁决与竞态收口（上轮留档 §5.1/§5.2 消化 9 项）

### 3.1 代码修复（5 项）
| 编号 | 位置 | 修法 |
|---|---|---|
| S2-20 | `server/src/services/guard.js` persistCfg | used/escalated 会话级**不落盘**（写 0/false，对齐 Python load 亦不加载语义）——原把当前 sid 计数落盘，重启残留误导审计。断言：guard.mjs ⑧c |
| S2-22 后半 | 同上 token 三函数 | token 绑签发会话 sid（ALS ctxSid），consume 校验同 sid；他会话消费被拒。断言：guard.mjs ⑧b（跨会话拒/同会话过） |
| S2-7 | `server/src/services/sessions.js` saveSessions | **空数组 + 存在无墓碑会话 → 拒绝写入**（过期状态清库保护）；合法「删光」每条经 session_purge 落墓碑 → 墓碑全覆盖照常清库；60 条裁剪不发墓碑（恒非空数组）不受影响。断言：migration.mjs ×2 |
| S2-12 | `server/src/db.js` resolveSqlitePath | 相对 `file:` 路径锚 **CONFIG_DIR**（与 electron/main.js 注入口径一致）——原锚 cwd，启动方式不同→不同库文件（「会话丢了」假象） |
| S2-18 | `server/src/host.js` + `provider.js` uiNudge + `electron/main.js` | 宿主逼帧 seam（setHostRedrawProvider）→ Electron `webContents.invalidate()` 接真窗（对齐 Python RedrawWindow）；无宿主行为不变（原恒 {nudged:false} 空转） |

### 3.2 口径裁决落档（4 项，注释即裁决书）
- **K8/S2-17**（armed 缺省 Py=False / Node=true）：**运行时形态差异非行为分叉**。
  Node 桥只随 Electron 宿主运行（恒有真窗）→ 缺省武装即桌面语义；Python 可无窗
  （测试/沙箱/次窗），武装由 `Api._set_window` 挂窗置位。两侧语义同为「有真窗=武装」。
  （`guard.js` ARMED 注释全文裁决）
- **S2-19**（Node build_system_prompt 无沙箱尾注，ID-201）：**有意分叉**——沙箱
  尾注描述 Python 侧 Job 沙箱事实，Node 照搬即伪造安全声明。差分基线按预期差异
  处理。（`provider.js` 注释扩写）
- **N13**（task_id 拒绝含 `.`）：**实证无需放宽**——前端零自产 task_id，统一
  后端 `_new_task_id()='task_<ms>'`（合 `^[A-Za-z0-9_-]{1,64}$`）；白名单收紧
  是防穿越的正确设计。
- **K10**（begin_task reset 去重器，§5.2 竞态首项）：本轮**未动**（需「按任务代际」
  语义评审，见 §6 遗留）。

## 4. 门禁记录

```
node frontend/build.js ×2          → 31173 行逐字节一致（BUILD=0/0）
python deliverables/design/check_contract.py → PASS（115 JS / 14 CSS）
python tools/contract_diff.py --snapshot contract-baseline-r39.json → 115 模块/1259 符号
python tools/contract_diff.py --compare contract-baseline-r39.json → 漂移项: 无
python tools/upgrade_audit.py      → 违规项: 无
server/test/*.mjs（20 脚本）        → 全部 EXIT=0（含 guard 39 checks / migration 新增 2 组断言）
pytest tests/ -q                   → **1942 passed / 1 failed / 3 skipped**
```

pytest 全量唯一失败仍为 `test_windows_packaging_dependencies::test_isolated_build_…`
（R37 起预存遗留，干净树可复现，与本轮改动无关——详见 HANDOVER-R36-R38 §6.1）。
另：`test_v15_wire::test_test_connection`（本地 DAV fixture）在满负载全量跑中
出现过一次超时型 flake（复跑单跑/文件级/第三轮全量均绿，与本轮改动面无交集）。

## 5. 测试对齐说明（非掩盖问题）
| 测试 | 原因 |
|---|---|
| `test_memory_db.py` 两处 `attribute='legacy_note'` 恰 1 条 current | 断言钉住的是**折叠缺陷行为**（多条 fact 记忆互相 supersede），按修复后语义改前缀计数；并新增 `test_legacy_multi_note_no_supersede` 正向锁定 |
| `server/test/guard.mjs` ⑧ 组后追加 ⑧b/⑧c | S2-22/S2-20 行为锁定 |
| `server/test/migration.mjs` 换绑段后追加 S2-7 两组 | 空数组拦截 + 墓碑全覆盖放行双向锁定 |

## 6. 遗留待办（本轮后剩余，按优先级）

### P1（下轮优先）
1. **file:// → https 自定义协议**（F2d）：解锁 V8 code cache，二次启动约 2×。
2. K10 begin_task 去重器代际化（§5.2 竞态评审类，需锁语义设计）。
3. 竞态其余 5 项：N14 群文件写锁 / N15 touch_recent_ws 锁 / S2-6 SQLite WAL checkpoint 再拷 / S2-21 AUTH_SECRET 缺失拒启 / S4-5 grants seq 分离。
4. 记忆面板 v2 收尾：钉选条目在 `memory_context_build` full 模式下的排序权重（当前仅 extras_block 置前）。

### P2
5. 资源类 10 项（§5.3）/ 工具链 CI 6 项（§5.4）/ 代码卫生 4 项（§5.5）。
6. `dist/Harbor.exe` 旧包重打（vendor Py3.13；前序遗留）。
7. 混合记忆升级（bigram→jieba→向量）：触发条件不变（条数过千或精确率投诉）。

## 7. 本轮踩坑（照抄避免重复）
1. **manifest provides 必须含下划线开头顶层常量**（`_mdStreamMap` 被 lint 拦下——
   顶层符号=一切 `const/let/function`，不分可见性）。
2. **`saveSessions` 返回 JSON 字符串**——桥侧断言先 `JSON.parse` 再取 `.error`
   （本轮 migration 测试第一次写就栽在这）。
3. **ESM 解构是快照拷贝**：`const { prisma } = await import(db.js)` 在
   switchDatabase 换绑后仍指旧 client（migration.mjs 既有断言属巧合通过）——
   换绑后的活绑定证据一律走 getSessions/saveSessions（模块内部引用）。
4. `marked.lexer` 的顶层 token `.raw` 拼接恒等于输入串（Node 实证），块级增量
   的 doneRaw 累计以此为基础；破坏时 startsWith 守卫自动全量重建兜底。
5. **`git stash pop` 会按 autocrlf 把工作区重写为 CRLF**：字节级审计
   （upgrade_audit 的 api_py_sha256）随即漂移失败，且 `git diff` 因行尾归一化
   **看不出来**。处置=按 HEAD 行尾基线批量还原（HEAD 原生 LF → 工作区还原
   LF）；凡是字节级锚点的工作流，stash/pop 后必须重验哈希。

## 8. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R39.md` |
| 上轮总报告 | `deliverables/dev-plan/HANDOVER-R36-R38.md`（遗留清单 §5/§7 仍有效，本轮已消化项见上文） |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r39.json`（r37 保留作历史） |
| 流式渲染调研 | `outputs/r37-research/F3a-render-cpu.md`（本地留存） |
