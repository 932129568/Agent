---
name: "grill-me-review"
description: "Adversarial design and architecture stress-test before writing code."
---

# 严苛架构拷问（grill-me-review）

## 拷问维度（逐项过筛）
1. **单一事实源**：同一份状态是否被双写？重启/刷新后以哪份为准？
2. **失败与中断**：请求超时、网络断开、用户中途取消或进程崩溃时，是否残留孤儿句柄或脏数据？
3. **边界与规模**：输入为空、超大（>10MB）、含非 ASCII/特殊字符、并发重入时表现如何？
4. **回滚与兼容**：是否破坏既有配置/数据格式？如何安全降级？

## 输出格式
按「阻断级缺陷 → 隐蔽竞态 → 建议简化项」输出，每条必须附带具体改进方案。
