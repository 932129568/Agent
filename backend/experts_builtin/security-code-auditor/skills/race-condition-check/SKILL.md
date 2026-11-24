---
name: "race-condition-check"
description: "Detect TOCTOU, double-submit, unguarded singleton init, and missing abort cleanup."
---

# 并发竞态与资源泄漏检查（race-condition-check）

## 高频竞态模式
1. **并发初始化泄漏**：懒加载端口/连接池必须单飞锁（single-flight promise），防止并发创建孤儿监听器。
2. **TOCTOU 校验失效**：文件存在性检查与读写之间、权限校验与消费之间必须原子化或绑定一次性令牌。
3. **异步中断残留**：检查 `AbortSignal`、定时器、文件句柄与子进程在异常/取消分支是否完整清理。
