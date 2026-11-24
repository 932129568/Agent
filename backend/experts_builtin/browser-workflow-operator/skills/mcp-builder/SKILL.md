---
name: "mcp-builder"
description: "Build compliant Model Context Protocol servers in Node.js or Python."
---

# 标准 MCP Server 搭建指南（mcp-builder）

## 工程规范
- 清晰的工具名与精简 JSON Schema 描述（避免臃肿吞噬上下文）；
- 写操作与命令执行默认内置路径护栏与超时终止；
- 附带单测验证 `listTools` 与 `callTool` 异常路径。
