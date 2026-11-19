# R69 · P0-③ 静态类型引入计划（第一阶段已落地）

> 用户「按标准设计执行」后的续轮。R69 评估把「类型安全」判为未达标
> （手写 TS = 0、无 `tsconfig.json`）。本文件给出分阶段路线与如实的环境边界。

## 0. 结论先行

**第一阶段（类型契约注解）已落地；第二阶段（静态类型检查）被环境阻塞，未伪造。**

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | JSDoc 类型契约试点 + 覆盖率棘轮 | **已落地** |
| 2 | `jsconfig.json` + `tsc --noEmit` / `checkJs` | blocked-by-environment |
| 3 | 试点扩到 `server/src/services/*.js`（27 文件） | 待阶段 2 |
| 4 | 渐进式 TypeScript 或全量 `checkJs` | 待阶段 3 |

## 1. 第一阶段交付

- 试点模块：`server/src/paths.js`（7 个导出符号 = 3 常量 + 4 函数），
  全部补齐 `@type` / `@param` / `@returns` / `@throws` 注解；**注释级改动，零行为变更**。
- `tools/type_annotation_audit.py`：静态解析导出符号的 JSDoc 覆盖率，
  与 `type-annotation-baseline-r69.json` 比较，**只增不减**。
- 实测 **7/7 = 100%**；纳入架构门禁与 CI 统一入口。

## 2. 环境边界（如实声明）

实测：`node_modules/typescript` / `server/node_modules/typescript` 均不存在，
`tsc` 不在 PATH；环境无外网不可安装。`@types/node` 已在位。

因此**当前不能运行 `tsc --noEmit` 或 `checkJs`**。
`type-annotation-r69.json` 中 `staticTypeCheck.status = blocked-by-environment`，
并写明解阻命令 `npm i -D typescript`。

**不得把 JSDoc 覆盖率冒充静态类型检查**：前者度量类型契约的文档化程度，
后者由编译器校验 3197 条依赖边的类型一致性。R69 报告的
「类型安全：未达标」判定**不因本阶段而改变**。

## 3. 第二阶段验收门（有网后执行）

1. 安装 `typescript`，新增 `jsconfig.json`：
   `allowJs: true`、`checkJs: true`、`noEmit: true`、
   `moduleResolution: nodenext`、`target: ES2022`、`types: ["node"]`。
2. 以 `server/src/paths.js` 为首个 `noEmit` 检查目标，修完所有诊断。
3. 把 `tsc --noEmit` 加入 `tools/run_normalized_gates.py`，
   并在 `gate_coverage.py` 的 canonical 清单登记。
4. 逐模块扩大 `checkJs` 范围，每批以「错误数只减不增」为棘轮。

## 4. 与 P0 其它项的关系

- 与 P0-①（消除双轨）无依赖，可并行。
- 与 P0-②（SCC 棘轮）共用同一「只增不减」纪律与统一门禁入口。
- 与 P0-⑤（代码覆盖率）同为环境阻塞项，均按 QA 口径如实登记，未伪造。
