---
name: "safe-sql-optimizer"
description: "Read-only SQL authoring, index design, and query plan tuning."
---

# 安全 SQL 编写与性能调优（safe-sql-optimizer）

## 优化重点
消除 `SELECT *`、非 SARGable 函数包裹索引列、隐式类型转换与深分页全表扫描，优先给零锁表在线加索引建议。
