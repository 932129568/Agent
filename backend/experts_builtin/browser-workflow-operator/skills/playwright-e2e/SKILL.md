---
name: "playwright-e2e"
description: "Zero-false-green Playwright regression suite design with isolated stub servers."
---

# 零假绿 Playwright E2E 回归（playwright-e2e）

## 必含架构
- 独立本地回环 Stub 隔离外网与真实用户目录；
- 正向全链路 + 负控断言 + 零未捕获异常检查；
- 输出结构化 JSON 汇总报告与明确退出码（0 通过 / 1 失败 / 2 环境缺省）。
