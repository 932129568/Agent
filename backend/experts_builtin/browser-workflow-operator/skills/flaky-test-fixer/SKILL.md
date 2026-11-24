---
name: "flaky-test-fixer"
description: "Diagnose and eliminate timing races, overlay interceptions, and selector flakiness."
---

# 抖动测试根治手册（flaky-test-fixer）

## 常见根因
1. 浮层/Toast 遮挡点击（检查 `pointer-events`）；
2. 用固定 `waitForTimeout` 替代状态条件轮询；
3. 跨用例共享全局配置/端口导致顺序污染。
