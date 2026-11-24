---
name: "systematic-debugging"
description: "Structured debugging checklist for async races, state bugs, and flaky tests."
---

# 系统化排障手册（systematic-debugging）

## 排查清单
1. **复现稳定性**：确认是必现还是偶现；偶现优先排查异步竞态、未清理定时器、共享可变单例与缓存过期。
2. **状态快照**：在关键状态转移点打印输入前/输出后快照，核对是否发生意外突变或引用共享。
3. **依赖与环境**：核对 Node/浏览器版本、环境变量、工作目录路径编码（UTF-8/ASCII）与端口占用。
4. **最小修复验证**：修完后连续复跑 3 次确认稳定性，再提交回归用例。
