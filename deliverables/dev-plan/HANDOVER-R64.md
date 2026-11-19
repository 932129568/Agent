# HANDOVER-R64 — 全库模块优化调研（整体）+ server 冷启动懒化实施

> 2026-11-10。接续 `HANDOVER-R63.md`（R63 已提交 `7ff83d3`）。本文自包含。
> **主交付物：`module-optimization-r64.md`**（全库数据+六图+分级立项）与可复跑盘点器
> `tools/module-inventory.mjs`（数据快照 `module-inventory-r64.json`）。

## 用户要求

「继续调研整体模块优化，不是一个两个模块功能」——本轮范围=全部 117 前端模块 + 42 server
模块 + 打包链 + jsapi 面，量化与定性并重。

## 核心数字（全部实测，可复跑）

| 维度 | 值 |
|---|---|
| 前端 | 117 模块 / 3215KB / 26957 行 / 1318 符号；**全库求值仅 65ms（非瓶颈）** |
| hub-catalog.js | 1839KB（产物 48%）——**启动成本实测仅 6ms**（R47 字符串懒解析已生效；「体积≠成本」实证） |
| server 冷 import | 改前 **1245ms**，其中 better-auth 三件套 **755ms（60%）** |
| jsapi 面 | 注册 165 / 前端实调 123 / 注册未调 42（其中 software_*/browser_* 经动态名调用非死接口） |
| 引用环 | 前端 65 模块 1 个大 SCC（出度 Top：run-controller 43 / send 27 / sessions.controller 23）；server 小环 browser↔guard↔misc |
| 导出冗余 | 789 provides 仅内部使用（build 精确登记契约的税）+ **36 真死候选**（需人工核对动态 onclick 面） |
| 重复实现 | 15 文件自造 HTML 转义、私有 esc×3、sleep×4 |

## 本轮实施（1 项 P0）

**F8 server 冷启动懒化**：auth.js 重写为 `ensureAuth()` 单飞工厂（better-auth/kysely/libsql-kysely
动态 import 进工厂；fail-fast 密钥校验保留在模块加载期——只读 config 零成本）；routes/auth.js
处理器内 `await ensureAuth()`；test/auth-flow.mjs 同步改走工厂。
**冷 import 1245 → 516ms（-59%）**；auth-flow 全链路 PASS（注册/登录/错误密码拒绝全走懒路径）；
首次 /api/auth/* 请求多付一次性 ~750ms（仅显式开认证的用户遇到，可接受）。

**附带**：`tools/lib/js-lexer.mjs` 从 gen_allowlist.mjs 抽出（两处共用防剥离语义分叉；
--check 重跑 157 条零变化已验证行为不变）。

## 证伪记录（重要）

「hub-catalog 1.8MB=启动大头」的初判**被实测证伪**（6ms）——R47 的字符串懒解析早已生效。
已把教训写进报告：**体积≠成本，优化前必须先测**。F1 从 P0 降级为「不动」。

## 分级立项（详见 module-optimization-r64.md §三）

- **P1** run-controller 拆步（1365 行/出度 43→≤15，1-2 天）——待批准
- **P1** core/state.js 分域状态（入度 125 god-module，绞杀式每轮一域，建议 memory 试点）——待批准
- **P2** 重复 helper 收敛（15 处转义须逐处核对语义）/ 死面人工核对（36+33）/ auth 探测已完成

## 门禁

server：contract-coverage/signatures ✓、local-proxy ✓、group-files 16/16 ✓、smoke ✓、
auth-flow ✓（懒路径）、棘轮 157 ✓。前端无源码改动（contract 基线 r63 仍零漂移）。
全量 pytest 见运行记录（预期 2060 绿）。
