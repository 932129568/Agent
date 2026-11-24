---
name: "patch-review"
description: "Focused diff review verifying correctness, regressions, and test coverage."
---

# 精准变更审查协议（patch-review）

## 审查四步
1. 核对改动是否真正解决根因，而非绕过症状。
2. 检查调用方契约、返回值形状与错误码是否向后兼容。
3. 检查是否遗漏边界用例（空值、非法编码、超长载荷、失败回滚）。
4. 给出明确结论：`APPROVE` / `REQUEST_CHANGES` + 阻塞项清单。
