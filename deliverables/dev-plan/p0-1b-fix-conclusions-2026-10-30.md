# P0-1b 修复结论：首轮差分 66 项 suspect 的契约对齐

- 日期：2026-10-30
- 执行：工程师（寇豆码）
- 输入：架构师方案 `design-2026-10-30-p0-1b-fixes.md`（G1-G12/C1-C5/B1-B8/S1-S4/P1-P4/SW1-SW6 + 安全评估 E1-E8 + 主理人 Q1-Q5 裁定）
- 基线：首轮差分 `outputs/diff/20261030125905/`（match=54 / intentional=1 / suspect=66）

## 一、根因 → 修复（5 类结构性根因）

| 根因 | 修复（文件） | 收敛前 → 后 |
|---|---|---|
| R1 护栏判定链整体未对齐（scope 分类学/档位矩阵/回执形状/审计链） | `guard.js` 按 `guard_service.py` 同构重写（G1-G10）；`misc.js` 审计五维条目+哈希链（G11）；`registry.js` 配置面接线 | guard 15 → 0 |
| R2 armed 语义缺失（差分环境可比性） | `HARBOR_GUARD_ARMED` seam（生产缺省武装；差分驱动恒 false——B1/E7） | browser offline 8 项经 armed 放行后命中语义对齐 |
| R3 错误响应方言混用 | commands `{exit_code,output}`（C1，stdout/stderr 折叠为内部实现——§2.2 择优）；plans 拍平/结构化逐方法对齐（P2/P4）；sessions 校验方言（S3）；browser 文案 hint 逐字（B5-B8） | commands 8→0；plans/ck 5→0；sessions 7→4 intentional |
| R4 服务内校验顺序分叉 | browser 会话先于 mode（B3）、takeover action 先于 id（B6）；software 按 legacy 源码顺序重排（SW3：args→软件→动作→安装→schema→门禁→执行；dangerous 经 api 层 force_always 前置护栏） | browser 21→0；software 9→0 |
| R5 mock 对等缺口 | `preload-mocks.mjs` 修复 promisify custom 符号的 Buffer→String 转换（git 探测 restored）；`files.js` toolcache id 对齐 `tc<seq>_<epoch秒>`；`software.js` PRESETS 补 description + required 空不落键（SW1）；persist `{version:1,user,probe_cache}`（SW6） | software 9→0 |

另：P3 双口径修正——plan_create 用严格 `_TID_RE`（'bad id!' 拒绝），checkpoint 用宽松 `_safe_tid`（'bad id!' 合法、仅拒 `/ \ .` 与超长）；checkpoint files 字符串按 CSV 拆（'[]' 是文件名）；admin 人审门 fail-closed（E4，Q2 裁定）；EXT-2 Python 侧唯一例外（`service.py` results=[] 防崩溃兜底，d65884d）。

## 二、收敛证据

- **最终全量差分**：`outputs/diff/20261030163332/` —— **fixtures=14 / calls=125 / match=120 / intentional=5 / suspect=0 / error=0，退出码 0**
  （含 admin approve/deny fixture 补充批：commands 3 fixture 15/15 match——Python fake ShellExecuteW 真跑临时 bat ↔ Node mock 执行同形收敛）
- 族级收敛：meta 1 intentional；sessions-basic 8 match；sessions-validation 4 match + 3 intentional；history-dir 8 match + 1 intentional；checkpoints 9 match（含 side-effects）；plans 11 match；guard 25 match；commands-guarded 11 match + admin-approve 2 match + admin-deny 2 match；export 7 match；browser offline 14 match + tier-aligned 8 match；software 11 match
- 覆盖门禁：fixture 覆盖 **48/145** 无回退（缺口 92 为 T05 全覆盖范围，`diff:coverage` 报缺口属预期）
- Node 回归：15 个 npm test 入口（16 组）全绿（browser.mjs closed 断言按 B4 口径更新）
- Python 回归（新基线 1767/0/3/1 保持 0 failed）：见 outputs/pytest-tmp/p01b-regress/junit.xml
- 复跑防交叉：批间全量复跑 6 次（20261030152030 / 20261030153335 / 20261030154610 / 20261030155054 / 20261030162318 / 20261030163332），已收敛项零翻转（20261030162454 轮 ID-103 一次误报 suspect，两次复跑 + 登记簿直查均正常，未复现）

## 三、残留 intentional 清单（5 项，均待主理人签核）

| 登记号 | fixture/call | 性质 | expires |
|---|---|---|---|
| ID-001 | meta/api-info c01 | exe 字段宿主差异（已签核） | 2026-12-31 |
| ID-101 | sessions-validation c03 | 存储实现分叉（Python sessions.json 原文保底 vs Prisma 结构化拒绝） | P0-2 复评 |
| ID-102 | sessions-validation c04 | ID-101 回读级联 | P0-2 复评 |
| ID-103 | history-dir-basic c05 | DB 存储无 sessions.json 可搬（migrate 语义待 P0-2 重定义） | P0-2 复评 |
| ID-104 | sessions-validation c01 | JSON 解析器错误文案天然不同（CPython vs V8；形状同构） | 2099-12-31（永久，Q3 裁定） |

## 四、P0-2 交接事项

1. **存储语义定案**（ID-101/102/103）：sessions 迁移到 DB 后，「原文保底写入」「migrate 搬文件」两个 legacy 语义需在新存储下重定义（建议：导出/导入等价语义 + 前端迁移进度提示）。
2. **P1-1 前端**（Q5）：`browser_set_mode` 无会话从幂等成功收紧为 BAD_PARAMS——React 侧栏岛如有依赖幂等成功的调用点需同步（方案已登记交接）。
3. **P0-4 桌面切换**：admin 人审门在 Electron 对话框接线前 fail-closed（admin 命令一律人审拒绝，与 Python 生产对等）——接线清单项。
4. **T05 全覆盖**：家族 10-20（files/workspace/memory/misc-config/provider/os-system/update/webdav/experts/mcp/rpc 共 92 方法）fixture 补齐 + `diff:coverage` exit 0。
5. **EXT-2 后续观察**：`service.py` results=[] 兜底已修（偶发 UnboundLocalError 根因之一是外部代理空 200——环境面问题继续在 P1-3 豁免观察）。

## 五、修复执行记录（git）

| commit | 内容 |
|---|---|
| 4fad913 | 修复T01+T02：护栏判定链/armed + 命令族契约（suspect 66→43） |
| 8468f84 | 修复T03+T04+T05：browser/sessions/plans/software + ID-101..104 登记 + mock 修复（suspect 43→0） |
| e6f9d9f | 修复T02 收尾：admin approve/deny fixture + fixture env 字段 + fakes ShellExecuteW（14 fixture 125 call 全收敛） |
| d65884d | EXT-2：Python 侧 results 未初始化防崩溃兜底（唯一例外，单独提交） |
