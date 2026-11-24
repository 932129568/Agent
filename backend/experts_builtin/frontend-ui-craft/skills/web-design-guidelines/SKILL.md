---
name: "web-design-guidelines"
description: "Accessibility, keyboard navigation, responsive layout, and typography checklist."
---

# Web 界面与无障碍审查清单（web-design-guidelines）

## 逐项自检
- 键盘 `Tab` / `Enter` / `Escape` 焦点流完整，弹窗打开与关闭焦距合理。
- 所有图标按钮提供 `aria-label` 或可读 `title`，数字列开启 `font-variant-numeric: tabular-nums`。
- 纯展示 Toast 必须 `pointer-events: none`，绝不遮挡底层操作按钮。
- 窄屏与缩放（125%/150% DPI）下零文字截断、零按钮重叠。
