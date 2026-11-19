# HANDOVER-R65 — 全量优化批次执行轮（1 项落地、一批回退、方法论教训）

> 2026-11-10。接续 `HANDOVER-R64.md`。主记录：`module-optimization-r64.md` §五。

## 结果

- **落地**：onboarding.js `obTestKey` 的 `const key` 遮蔽修复（帮助函数缺失时空 Key 恒失败的真 bug）。
- **回退**：死面清理批次（36 符号 + 2 整文件 + hubAll 不可达链 + 9 私有 esc 委托）——build/契约/
  棘轮全绿但**全量 pytest 51 failed**，全量回退恢复 2060 绿。
- **缓议**：F2 state.js 分域（memory 三变量是 R59 M4 刻意下沉拆环的）、F3 run-controller 拆步
  （出度 43 中枢需独立轮次）——维持方案定稿，见 R64 报告。

## 教训（方法论级，已入报告 §5.2）

**测试即一等消费者**：collaboration 测试直接调用 router/schemas/config 的「生产零调用」函数、
hub 测试钉 hubAll 模态 DOM、round6/7 harness vm 单模块加载 esc（无 markdown.js 环境）。
**「生产零调用」≠可删**；死面判定必须把 tests/ 纳入引用面；更新测试域=松动行为钉=产品决策
（如 collaboration 子域裁剪），不能当纯技术死代码处理。回退清单与正确姿势见报告 §5.2/§5.4。

## 工具资产（保留，长期复用）

- `tools/lib/js-lexer.mjs`：+`stripCodeMap`（骨架↔raw 坐标映射，免疫字符串花括号）
- `tools/module-inventory.mjs`：全库盘点（R64）
- verify-dead 思路已入报告；若重启死面清理，先把它扩展到 tests/ 域

## 门禁

contract 基线 **r65**（117 模块/1318 符号，与 r63 等价内容刷新）、check_contract PASS、
棘轮 157 PASS、**全量 pytest 2060 绿**。onboarding harness 绿（含 key 修复）。
