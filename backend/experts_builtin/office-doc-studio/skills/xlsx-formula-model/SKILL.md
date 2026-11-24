---
name: "xlsx-formula-model"
description: "Build clean multi-sheet Excel templates with dynamic formulas and checks."
---

# Excel 自动化公式模型（xlsx-formula-model）

## 建模规范
- 分 Sheet 设计：`01_参数假设`、`02_明细台账`、`03_汇总看板`。
- 优先使用 `SUMIFS` / `COUNTIFS` / `XLOOKUP` / `IFERROR`，显式注明货币单位与日期格式。
- 必须内置勾稽校验行（如 `=ABS(明细汇总-总表金额)<0.01`）。
