# HANDOVER-R60 — 遗留清零轮（推送尝试中止 / 安装包重打 / FE-5 / 启动 -55%）

> 日期：2026-11-08。接续 HANDOVER-R59.md。任务（用户）：「解决所有遗留」。
> 中途用户指示「不用推送了」——推送**主动中止**（详见 §1）。

## 0. 一眼总览

| 维度 | 状态 |
|---|---|
| 全量 pytest | **2057 passed / 0 failed / 3 skipped**（锚点 r60） |
| 安装包 | **dist-electron/Harbor-Setup-1.9.0.exe 重打成功**（216MB，sha256 272736a7…9776c） |
| server 启动导入 | **781 → 352ms（-55%）** |
| server 测试套 | 18 套全 PASS（含欠账三套修复） |
| 提交 | 2 笔本地（46c962e perf / 23110d4 fix）；**推送经用户指示中止** |

## 1. 推送（主动中止，中间态自洽）

blob API 重放按 R59 记忆流程执行，途中修三个脚本缺陷（均已实证）：
1. `git diff-tree` 默认首行输出 commit id → 解析器误当 blob 条目 → `--no-commit-id` + 40-hex 守卫；
2. http_post 引用未赋值 `$TOKEN`（set -u 下 curl 行静默死亡，code 恒空）→ `TOKEN="$HARBOR_TOKEN"`；
3. 删除条目 mode 用 newmode=000000 → GitHub 422「valid tree.mode」→ 改用 oldmode。

**进度**：32/48 笔成功重放到远端（等效重放链，R26→R45 树全等）；第 33 笔遇 401（token 偶发），重取 token 重跑到 34 笔附近遇删除条目 422 → 修复后用户叫停。

**中间态说明（重要，下次续推必读）**：
- 远端 main 现指向**重放链**（与本地提交 sha 不同、树逐笔等价）的 R45 附近位置；
- 本地 origin/main 引用**未 fetch**（仍指旧 014d2928）——保持现状：下次续推直接重跑脚本（rev-list origin/main..main 仍 48 笔，blob/tree 幂等，force PATCH 覆盖远端收敛到本地树等价物）；
- **禁止** fetch+reset--soft：当前远端链只覆盖前 32 笔，reset 会把 R46-R59 提交挤进暂存区；
- 种子文件 `$LOCALAPPDATA/Temp/uploaded_seed.txt`（359 blob sha）+ 脚本 `HARBOR_UPLOADED_SEED` env 可跳过已传 blob；token 走 `git credential fill` 现取。

## 2. 安装包重打 ✅

- 链路：`ELECTRON_MIRROR=npmmirror` + `npm run dist:win`（electron-builder NSIS，纯 Electron 链——files 白名单无 Python 载荷，R54 起生产即 Electron，无需 vendor Py3.13）；
- 产物：dist-electron/Harbor-Setup-1.9.0.exe（226,610,285 字节）；sha256 `272736a7065a35f1b3d8fa1109e2be48d51f74260b5879e7b57d86f16f79776c`；
- 含 R42→R60 全部改动（记忆工具化/浏览器七原语/懒加载/并发对齐/对话回退/依赖单向化/启动 -55%）。

## 3. server 延迟 require（R47 候选 2 落地）

`tools/import_cost.mjs`（新增）逐模块实测导入耗时 → 四处懒化：

| 模块 | 原因 | 解法 | 收益 |
|---|---|---|---|
| services/experts.js 397ms | 顶层 `await ensureBuiltinExperts()`（fs+哈希导入全部内置包） | `builtinOnceRun()` 单飞——首个 registry 读取入口（expertList/expertGet）按需 | -397ms |
| services/browser.js 215ms | 顶层 `import { chromium } from 'playwright-core'` | `getChromium()` 单飞动态导入，launch 点 await | -209ms |
| services/mcp.js 174ms | MCP SDK 三包顶层导入 | `getSdk()` 单飞，connect 点解构 | -174ms |
| db.js 239ms | PrismaClient 顶层实例化（adapter+libsql 引擎） | **Proxy 懒化**——`export const prisma = new Proxy({}, {get→_createPrisma()})`，消费方 `import { prisma }` 零改动；switchDatabase 换绑改为重置内部 ref（Proxy 透传保 ESM live-binding 语义） | -236ms |

**app.js 导入图 781 → 352ms（-55%）**；冒烟：prisma 经 Proxy 真查询可执行。

## 4. FE-5 plan resume 重设计（R50 扫描两条全修）

1. **①假恢复**：卡片「从断点续跑」原实现丢弃计划对象（与横幅「继续」同义）→ `go()` 现把 plan_list 数据**回填 s.plan**（task_id 匹配才回填、落盘、步骤/状态进会话）再续跑——真携带草稿；
2. **②跨会话污染**：plan_list 全局清单不过滤 → B 会话计划卡挂进 A 会话 → 挂载侧只认 `task_id === s.plan.task_id`（计划文件无会话归属字段，过滤只能在挂载侧）；他会话计划不再挂卡。
3. meta 文案改真话：「续跑将回填该计划草稿（步骤/状态），检查点仍可回滚」。

## 5. server 测试欠账（三套，R57/R59 改动只更了 pytest 侧的连带）

- smoke.mjs：hybrid 默认 6 键（+enabled）/ model_prefs 响应与落盘 +memory_inject（registry save 响应同步补齐）；
- contract-signatures.mjs：group_files_list Node 签名对齐 legacy（`[group_name]`，去 limit——limit 是 R57 多加的）；
- parallel.mjs：信任 per-sid 语义反转断言（R59 后切换不清信任——s-legacy2 的 clipboard_read 信任切到 s-legacy3 后依然生效）。

## 6. 遗留终态裁决

| 项 | 终态 |
|---|---|
| 推送 | 用户指示中止；32/48 已上远端（等效链），余 16 笔本地待将来续推（§1 流程可续） |
| 安装包 | ✅ 今日版（R60 源码态） |
| FE-5 / server 延迟 require / server 测试欠账 | ✅ 本轮全清 |
| 88 条冻结前向边 | 棘轮护栏已立（只减不增）；逐批「叶化/缝化」消化为长期项，本轮不动（toast/uiConfirm 类 UI glue 调用方 30+ 模块，批量迁移回归面大，收益/风险比不划算） |
| R58 候选 render_ui/parentId 分支树 | 非遗留缺陷——属新功能迭代，列 R61 候选 |
| OTel 远程 / A-P10 / hub-catalog 外链 | P2 需产品决策，维持留档 |
| pywebview 链并行串行化 | 观察项维持（Electron 生产链零影响） |

## 7. 提交

```
46c962e perf(R60): server 延迟 require——app.js 导入图 781→352ms（-55%）+ FE-5 plan resume 重设计 + server 测试欠账三套修复
23110d4 fix(R60): FE-5 ②续跑卡跨会话污染——plan_list 只取本会话绑定计划；锚点 r60
```
（两笔均本地，遵用户指示未推送）
