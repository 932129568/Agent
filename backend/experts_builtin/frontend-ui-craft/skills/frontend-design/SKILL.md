---
name: "frontend-design"
description: "Anti-slop visual hierarchy, color palette discipline, and crisp layout craft."
---

# 反模板化前端美学规范（frontend-design）

## 视觉四原则
1. **明确焦点**：每屏只有一个视觉主角，用字重、留白和明暗对比拉开主次，而不是靠到处加边框和阴影。
2. **高可读对比**：正文与背景对比度遵循 WCAG AA（≥4.5:1），磨砂玻璃表面必须补顶部高光边与柔和描边。
3. **空间节奏**：统一 4px/8px 间距网格，避免容器横向溢出（Flex/Grid 子项必设 `min-width: 0`）。
4. **完整状态覆盖**：任何界面都需具备空态引导、加载过程态、错误提示态与成功反馈态。
