# P0-2 存储统一与 DPAPI 迁移结论：定案裁决 + 迁移证据 + 拓扑定稿

- 日期：2026-10-31
- 执行：工程师（寇豆码，software-engineer-2）
- 输入：架构师方案 `design-2026-10-31-p0-2-storage.md`（§1-§9 全章）+ 主理人 Q1-Q7 全部裁定（ID-101/102 正式化接受 / 运行时绑定态本批不动 / history_dir 完整 DB 切换主方案 / DPAPI 双路径优先级+互解许可 / 明文备份保留+P0-3 清理提示 / 诊断端点合规接受 / worklog 不迁 Prisma）
- 红线遵守：`API_VERSION='v1.0.0'` 冻结、get_api_info 零改动、config.json 零污染（Meta 标记入 DB、新诊断端点不占 js_api 面）、harbor.html 未触碰、dist/Harbor.exe（含 Setup 安装器）未启动、backend/ 零改动、未删除文件、未记录密钥、**真实用户数据 ~/.glm-chat 全程零污染**（一切验证在临时副本/隔离环境）

## 一、定案裁决落笔（ID-101/102/103）

### ID-101/102（save/get_sessions 存储分叉）→ 正式化（长期契约差异，永久登记）

- `expires` → `2099-12-31`；`reason` 改写为定案表述：**Prisma 结构化校验拒绝非对象条目为定案行为；Python 数组原文保底写入语义不迁移**（四点理由：合法输入双侧逐字节一致；保底写入在 Prisma 模型下无自然等价物且污染存储模型；Node fail-closed 显式拒绝优于静默写坏；P0-4 后 Python 退役该宽容度无消费者）。
- `sessions-validation` fixture 转为长期契约差异存证用例（非待办缺陷）。
- approvedBy=team-lead（2026-10-31 已按 Q1 裁定统一签核，提交 4b45614）。

### ID-103（history_dir_set migrate）→ 已实现真实迁移语义，登记降级为介质披露

- **Node 等价语义 = 历史 DB 存放位置切换 + 数据搬移**（非仅物化静态副本）：源取当前生效库（W9 口径）、目标已存在跳过不覆盖（migrated 保持 false）、复制 DB 文件 + sessions.json 物化导出到目标目录（legacy 可读副本）、switchDatabase 原子换绑（ESM live binding）→ 切换后新会话写入跟随新目录。
- `migrated:true` 双侧一致（原「恒 false」登记事由消除）；`migrated_from` 值为旧 DB 文件路径（Python 为旧 sessions.json 路径）——**介质披露**（与 ID-001/ID-202 同构：语义已对齐，值披露实际介质）。
- 登记落笔：ID-103（c05 定案）+ ID-103A/B（c01/c03 sessions_file 介质披露）+ ID-103C（selftest 金丝雀介质披露存证）；expires 维持复评标记至 QA 复验后转永久或撤销；approvedBy=team-lead（2026-10-31 签核，提交 4b45614）。

### 范围澄清（Q2/Q7 裁定）

- 运行时绑定态（session_ws/recent/ws_enabled/memory）：**本批不动**（无双轨、probe 契约闭环）；「Prisma 唯一运行时数据源」= 会话数据运行时权威，不是所有状态入 DB。
- worklog（_glm_worklog.md）：**不迁 Prisma**——用户工作区产物（用户可见可编辑 markdown），数据四分类原则裁决。

## 二、拓扑定稿（§2.1 落地形态）

```
运行时权威（Prisma/libsql 单 DB 文件）：
  Session 表（id/title/…/payload原文）＋ Meta 表（schema_version、
  migration_legacy_sessions、dpapi-migration-v1.done）
        ▲ 一次性/增量导入                ▼ 物化导出（只读视图）
legacy sessions.json ─────► DB ─────► sessions.json（导出物）
（Python 时代存量，永不删除不改写）   （WebDAV 备份 / history migrate / 回退保险）

独立 JSON 文件纪律保留（配置/状态/契约面，不是第二数据源）：
  config.json、guard.json、audit_log.jsonl、memory.json、experts.json、
  plans/、checkpoints/、mcp_servers.json、webdav.json、model_prefs.json、
  reader.json、sandbox.json、hybrid.json、history.json、harbor-node-runtime.json
工作区产物文件保留：_glm_worklog.md、save_workspace_file/copy_into_ws 产物、导出文件
```

**触发纪律（staging 9c6fa8c 教训固化）**：迁移器绝不在模块 import 期执行——仅两入口：`index.js` 生产启动后台任务链（listen 后、不阻塞）与 `migrate:legacy` 显式 CLI；测试入口（run-diff/contract-*/node-driver）隔离 CONFIG_DIR 永不触发迁移（import 期零副作用有测试断言）。

## 三、迁移证据链

### 3.1 T01 迁移基建（f1c3bcd）

- 三原语：`importLegacySessions`（merge 跳过已有/replace 事务全量替换、非对象条目 warning、整批单事务回滚）/ `materializeSessions`（Python compact 序列化，§8.1 唯一转换口）/ `switchDatabase`（live binding + Core/公共锁分层）。
- Meta 表 + ensureSchema（与 prisma db push 逐字一致幂等 DDL）。
- 新 migration 测试组 **14/14**（merge/replace/物化/回滚/切换/bootstrap/import 期零副作用）。
- **临时副本验证器（tools/verify-migration.mjs）全断言通过**：
  - 真实目录完整复制 → 7 个真实会话全量导入（imported=7/skipped=0）；
  - **payload 全量保真**（每条与 legacy 原文深度一致）+ **id 类型保真**（数字 id 仍为数字）；
  - 幂等重跑 imported=0/skipped=7；原 sessions.json 与 .pre-node-migration.bak 备份字节不变；
  - **故障注入**：12000 条大文件导入中途 kill 进程 → 重跑幂等收敛（imported=12000，事务回滚语义）；
  - **真实 ~/.glm-chat 指纹：4196 文件 MD5 清单 hash 前后一致（零污染）**。

### 3.2 T02 history_dir 真实迁移（19c7ecc）

- history-dir 差分 11 calls = **8 match + 3 intentional + 0 suspect**：c05 migrated:true 双侧一致 + migrated_from 介质披露；c08 目标已存在跳过不覆盖、c09 migrate=false 空库切换均双侧一致。
- 实现缺陷修复：外层锁+内层锁自死锁（historyDirSet 整段互斥内调 switchDatabase）→ 拆公共锁包装/未持锁 Core 内核两层。

### 3.3 T03 DPAPI（0349e19）

- `dpapi.js` 原语层：双路径优先级（Electron safeStorage→**PowerShell .NET ProtectedData 主路径**→明文兜底 W17）；批量加解密；敏感值 stdin 传值（绝不走命令行/env）；isAvailable 探测缓存。
- **跨语言互解验证（tools/verify-dpapi-interop.mjs）双向各 1 例通过**：Node 加密 → Python `mcp_dpapi.decrypt_value` 解密一致；Python `encrypt_value`（历史密文）→ Node 解密一致（含中文+emoji，临时文件上进行，零 backend/ 改动）。
- 两处关键环境修复（如实记录）：①PowerShell `ConvertTo-Json` 单元素数组展开为标量问题（改逐元素编码拼接）；②PowerShell 控制台 stdin 按 GBK 解码问题（脚本显式 UTF-8——非 ASCII 密钥此前会被损坏，互解验证暴露并修复）。
- webdav/mcp 字段级加密落盘（{__enc__:dpapi:...}）；读取解密回显；IO 前解密（密文绝不当 Basic Auth/子进程/HTTP 头下发——下发边界置空）。
- 存量明文幂等迁移（Meta done 标记/备份不覆盖/原子写回/不可用保持明文重试）；`/storage/security` 诊断端点（非 js_api 面，仅状态计数不回显明文）。

### 3.4 T04 WebDAV 备份集（08c5812）

- export：sessions.json 由 materializeSessions 在暂存区生成（DB 当前态，sha256 入 manifest）；未配置错误路径不物化（missing 标记契约面零变化）。
- restore：恢复前自动备份当前 DB（harbor.db.pre-restore.bak）；sessions.json 经 importLegacySessions({mode:'replace'}) 事务全量替换（Python 文件级替换语义），不再写文件。
- webdav.mjs **19/19**：导出物化（dav-s1 含 messages 全文）→ 恢复往返（remote-s1 写回 DB）+ pre-restore 备份存在；webdav 差分 8/8 零翻转。

## 四、终验数字

- **最终全量差分（两次复跑零翻转）**：`outputs/diff/20261031082316/` 与 `outputs/diff/20261031083545/` —— **fixtures=29 / calls=279 / match=268 / intentional=11 / suspect=0 / error=0，退出码 0**（两轮逐数字一致；含新增 history c08/c09 与金丝雀 c07/c08 共 4 calls）
- 覆盖门禁：`npm run diff:coverage` exit 0 维持（fixture 覆盖 **139/145**，uncovered 登记 13，缺口 0，runId 20261031084533）
- Node 回归：**16 组 + 新 migration 组全绿**（migration 17 checks；webdav 19；mcp 20；smoke 38；state 31；其余组零回退）
- Python 全量回归：**1767 passed / 0 failed / 3 skipped / 1 deselected** 基线保持（新口径 `CODEBUDDY_SAFE_DELETE_ENABLED=0` + tests/ 限定 + 独立 basetemp + 静默串行 + deselect 安装器，junit 见 outputs/pytest-tmp/p02-regress/junit.xml）
- **真实 ~/.glm-chat 指纹全程不变**（T01 验证前后 4196 文件 hash 一致；T05 终验再次核验）

## 五、P0-3/P0-4 交接累积（本轮新增）

- **P0-3（前端）**：`/storage/security` 常驻提示 UI（明文状态横幅/首启横幅轮询）+ `.pre-dpapi.bak`「确认迁移成功后手动清理」入口 + `python` 键展示文案 + save_workspace_file 裸路径消费点 + history_dir_get.sessions_file 现指向 DB 库文件（「打开数据文件」类 UI 的介质预期）。
- **P0-4（桌面）**：Electron safeStorage 注入（DPAPI 路径 1 启用——dpapi.js 已含该分支）；bootstrap 迁移随桌面切换正式生效（生产链 Python 退役后无双写）；沙箱迁移单列立项（ID-201 解除条件，本批不含）。

## 六、修复执行记录（git）

| commit | 内容 |
|---|---|
| f1c3bcd | T01：存储迁移基建——三原语 + live binding DB 切换 + bootstrap 导入 + 临时副本验证器 + migration 测试组 |
| 19c7ecc | T02：history_dir_set 真实迁移（ID-103 落地）+ 自死锁修复 + fixture 语义更新 + ID-103A/B |
| 0349e19 | T03：DPAPI 原语层 + webdav/mcp 字段加密 + 存量明文迁移 + 诊断端点 + 跨语言互解双向验证 |
| 08c5812 | T04：WebDAV 备份集物化导出/恢复导入 + pre-restore 备份 + 往返测试 |
| （本提交） | T05：ID-101/102 正式化 + ID-103C 金丝雀 + 全量终验 + 结论文档归档 |

## 七、偏差与决策记录（相对方案）

1. **switchDatabase 拆公共锁/Core 两层**（方案未预见）：historyDirSet 整段互斥内再取锁会自死锁——公共包装锁供独立调用方、Core 内核供已持锁流程。
2. **PowerShell 两处环境缺陷修复**：ConvertTo-Json 单元素数组展开标量（影响批量结果解析）与控制台 stdin GBK 解码（影响一切非 ASCII 密钥）——互解验证暴露并修复，非方案预设项。
3. **webdav 测试远端 sessions.json 改为合法 JSON 数组**：T04 起恢复经 DB 导入（必须合法数组）而非写文件——测试数据语义修正，非契约变更。
4. **manifest 形状保持现状**（version/created_at/items）：T04 未新增 app_version 等字段——方案要求「形状零变化」，未对照 Python 补字段（无 fixture 覆盖该区域，登记为 P0-3 可评估项）。
5. **迁移验证真实指纹为 4196 文件**（QA 早期口径为 469 文件）：真实目录随使用增长；零污染证据 = 前后 MD5 清单 hash 一致，而非绝对文件数对齐。
