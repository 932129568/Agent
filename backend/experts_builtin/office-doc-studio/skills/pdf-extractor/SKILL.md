---
name: "pdf-extractor"
description: "Extract structured tables, key fields, and action items from PDF documents."
---

# PDF 结构化信息抽取（pdf-extractor）

## 抽取规范
1. 输出统一字段表：`字段名 | 抽取原文 | 来源页码/段落 | 置信度/备注`。
2. 遇到扫描模糊、印章遮挡或文档未提及字段，如实标记 `未提及/待人工核对`，绝不脑补。
