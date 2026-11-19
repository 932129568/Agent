# Harbor 规范化架构 · 评审入口（R68）

> 用户口径：**先定规范再重写**。本目录是规范草案 + 可执行门禁 + 可运行骨架，
> **评审确认前不接入生产链、不删除任何 legacy 源码、不改后端生产代码**。
> R67 的生产链（`harbor.html` / `frontend/react/` / `server/`）保持全绿不变。

## 1. 先看什么

| 文档 | 内容 |
|---|---|
| `ARCHITECTURE.md` | 前端规范：分层、目录、单一状态源、服务边界、DOM 规范、测试口径、契约演进、B0–B9 批次、红线 |
| `ARCHITECTURE-BACKEND.md` | 全栈后端规范：Node 服务分层、Electron 主进程、installer、**Python 契约层定位与 A/B/C 路径** |
| `docs/EXISTING-REACT-AUDIT.md` | 现有 `frontend/react/` 逐文件合规差距、例外登记、去向映射、终态判据 |
| `docs/PYTHON-CONTRACT-EXIT-PLAN.md` | C 路径（删除 Python 层）的契约测试重做清单与精确代价（步骤 1 已完成） |
| `docs/golden-manifest.json` | C-1 冻结的 golden 快照哈希、95 项调用序列、后续步骤 |
| `deliverables/dev-plan/ARCHITECTURE-ASSESSMENT-R69.md` | **R69 全栈架构与规范化评估**：12 维度对照国际工程实践，实测数据由 `tools/arch_assessment.py` 复跑；§7 记录 P0 执行进度 |
| `tools/run_normalized_gates.py` | **本地 / CI 共用的统一门禁入口**（12 门 + 27 个 server 门），CI `normalized-gates` job 直接调用 |
| `deliverables/dev-plan/TYPE-SAFETY-PLAN-R69.md` | P0-③ 静态类型四阶段路线；第一阶段 JSDoc 类型契约已落地，阶段 2 待外网装 typescript |
| `server/test/trace-equivalence.mjs` | DEF-02/03 授权修复的验收门：span 写入/接线、14 天保留期、公开面 51 方法零漂移 |
| `migration-ledger.json` | B0–B9 迁移登记表：17 子域 / 117 模块 / 旧钉→新钉 / 验收门 |
| `docs/skeleton-manifest.json` | 骨架文件唯一清单（门禁逐项校验，漏一项即 FAIL） |

## 2. 怎么验证（评审前请先跑一遍）

```bash
NODE="C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
cd <项目根>

"$NODE" frontend/app/tools/gen-layout.mjs        # 幂等生成 10 个区域外壳
"$NODE" frontend/app/build.mjs                   # 骨架 bundle（只写 app/dist，不碰 harbor.html）
"$NODE" frontend/app/tests/arch-contract.mjs     # 架构门禁：声明/依赖/禁用 API/React 审计/后端边界
"$NODE" --test frontend/app/tests/unit.test.mjs  # L1 单元
"$NODE" frontend/app/tests/smoke-render.mjs      # L2 真实浏览器挂载
"$PY"  -m pytest tests/test_r68_arch_contract.py -q
"$NODE" tools/verify-react-render.mjs            # R67 生产链 16/16 未受影响
```

## 3. 评审需要拍板的 4 件事

1. 前端规范 `ARCHITECTURE.md` §13 的 4 个开放项（UI 契约终态 / collaboration 去留 /
   是否引入新依赖 / 每批是否要真机签字）。
2. 后端规范 `ARCHITECTURE-BACKEND.md` §7 的 4 个开放项（**Python 契约层 A/B/C 路径** /
   server 是否物理重排 / 已知环是否本轮解 / 冷启动预算是否进发布门）。
3. **C 步骤 1–3 已完成**：golden 冻结、Node 公开契约面等价门、`golden_sha256`
   进入 r68 锚点。是否投入步骤 2b（逐输出重放）与授权步骤 4–6
   （处置 74 个耦合测试文件 → 删 Python 实现 → 全量交接）。
4. **51 个公开方法**：历史注释写 49/50，实测为 51，以 golden 自省面为准。
4. B0 是否可以开工（外壳/布局 13 模块迁移）。

## 4. 当前状态与边界

- 骨架可运行：`HarborApp.bootstrap()` 在真实浏览器挂载 10 个区域、单一 store 派生状态栏。
- **B0 结构已真实迁移**：10 个 `layout/` 组件由 R67 generated 投影（剥离 85 处事件桥、
  300 个 id 零丢失），不再是占位外壳。
- **C-1~3 已完成**：95 项 legacy 调用序列快照入库并哈希锁定；
  `server/test/contract-golden.mjs` 证明 Node 运行时 51 个公开方法与冻结面逐项一致；
  `golden_sha256` 进入 `contract-baseline-r68.json` 冻结面。Python 实现未删。
- **步骤 4 第一/二批**：`docs/backend-test-disposition.json` v2 机器盘点 74 条，
  `server/test/config-discipline.mjs` 覆盖第一批纪律钉；
  `docs/domain-equivalence-map.json` 把 9 个子域映射到 Node 服务与 24 个测试门，
  **74/74 条全部定位到等价门**（`mapped-not-behavior-verified`）。
  物理删测试留步骤 5 与删实现同批（R65）。
- **步骤 4 第三批**：`docs/behavior-review-batch1.json` 逐条复核 memory/observability
  的 3 文件 24 钉，结论 **10 个 gap / 6 个 partial**，明确「不可进入步骤 5」；
  4 个前端契约钉改由前端门禁承担。台账 v3 有缺口不销 `reviewRequired`。
- **步骤 4 第六批**：重读 9 个 gap 的断言原文，纠正按 import 归类的偏差——
  2 个是 Python 内部语义、4 个是前端源码静态钉、2 个是前端 VM 行为钉（deferred 到 B4）。
  新增 5 条可执行字面量门，真缺口收敛 **9 → 3**，
  `docs/behavior-review-batch1.json` v4、累计销 8 项。
- **步骤 4 第七批**：`server/test/memory-injection.mjs` 证明记忆注入/entries/pin
  能力面在位，1 个 gap 降为 `partial`；**DEF-02**（trace span 写入接线）、
  **DEF-03**（trace 保留期清理）经核实为 Node 实现缺口，按 QA 口径回传待授权。
  `blockingGaps` **3 → 2**、累计销 9 项。
- 规范已**可执行**：58 项架构断言、现有 React 例外登记、后端只读审计。
- **尚未迁移任何业务域**：`frontend/src/` 117 模块、`frontend/react/` 16 个文件、
  `server/` 42 模块均保持原状。所有批次在 `migration-ledger.json` 中仍为 `pending`
  （B9 为 `frozen-pending-product-decision`）。
- 本目录产物不进 git 追踪的是 `dist/`（构建产物，见 `.gitignore`）。
