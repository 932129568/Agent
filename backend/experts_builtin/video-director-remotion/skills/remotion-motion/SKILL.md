---
name: "remotion-motion"
description: "Frame-accurate Remotion React video patterns using useCurrentFrame and spring."
---

# Remotion 代码化视频规范（remotion-motion）

## 工程红线
- 严禁依赖 CSS `transition`/`setTimeout` 驱动画面，所有动效必须由 `useCurrentFrame()` + `spring()` / `interpolate()` 纯函数计算，保证无头渲染逐帧确定性。
