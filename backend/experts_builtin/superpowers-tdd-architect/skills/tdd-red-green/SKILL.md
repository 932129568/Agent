---
name: "tdd-red-green"
description: "Test-Driven Development red-green-refactor discipline for bug fixes and new features."
---

# TDD 红绿重构工作流（tdd-red-green）

## 触发场景
新增业务函数、修复可复现缺陷、重构核心算法或状态机。

## 执行步骤
1. **Red（先写失败断言）**：编写聚焦单一行为的自动化测试，明确输入、预期输出与异常边界，运行并确认它因目标缺陷而**真实失败**（防止假绿）。
2. **Green（最小正确实现）**：只写让该测试与既有测试全部通过的最简代码，不顺手夹带无关重构。
3. **Refactor（清理与加固）**：消除重复逻辑、补齐边界防御（空输入/非法类型/并发中断），重跑全量测试保持 100% 绿灯。
4. **交付清单**：输出「新增测试用例名 + 修改文件列表 + 实测命令结果」。
