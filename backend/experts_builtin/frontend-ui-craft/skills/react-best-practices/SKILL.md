---
name: "react-best-practices"
description: "React 19 state isolation, memoization, and streaming render performance patterns."
---

# React 19 性能工程实践（react-best-practices）

## 高频优化模式
1. **避免高频状态污染大树**：流式文本/计时器下沉到独立子组件，历史消息用 `React.memo` + 稳定回调 `useCallback` 锁死零重渲染。
2. **流式合批**：SSE 高速吐字做 30fps（~32ms）合批刷新，首字立即直出降低感知延迟。
3. **防白屏与资源回收**：顶层挂 `ErrorBoundary`，所有 `rAF` / `setInterval` / 事件监听在 `useEffect` cleanup 中 100% 释放。
