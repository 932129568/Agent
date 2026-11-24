---
name: "root-cause-tracing"
description: "Evidence-backed root-cause tracing protocol that forbids blind patching."
---

# 证据链根因追踪协议（root-cause-tracing）

## 铁律
- 未拿到直接证据（堆栈、日志、源码行号、网络状态码）前，**禁止修改生产代码**。
- 禁止用 `try/catch {}` 静默吞错或扩大超时掩盖真因。

## 四步定位法
1. **锁定边界**：区分错误发生在编译期、网络/协议层（CORS/Header/状态码）、状态更新层还是渲染层。
2. **最小二分**：对比正常样本与失败样本的输入载荷和环境差异，把嫌疑范围缩到单一模块。
3. **源码实证**：直接阅读触发行及上游调用链，写出因果链 `条件 A → 行为 B → 报错 C`。
4. **回归锁定**：修复后补充针对根因的负控测试，确保同类回归永久被门禁拦截。
