---
name: "motion-physics"
description: "Source-anchored FLIP transitions and damped spring physics with reduced-motion fallback."
---

# 物理弹簧与空间起源动效（motion-physics）

## 动效设计准则
1. **空间连续性**：模态/抽屉打开从触发按钮坐标 FLIP 展开，关闭飞回归属位置并触发轻微弹性反馈。
2. **独立量纲弹簧**：位移（px）、旋转（deg）、缩放（ratio）分别配置独立收敛阈值，杜绝小量纲轴被误杀或残余抖动。
3. **无障碍退避**：`prefers-reduced-motion: reduce` 或应用静息档下，所有位移与高频动画归零。
