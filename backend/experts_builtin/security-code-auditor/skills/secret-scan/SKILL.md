---
name: "secret-scan"
description: "Detect hardcoded API keys, tokens, credentials in code, logs, and build artifacts."
---

# 凭证与敏感信息防泄露检查（secret-scan）

## 审查范围
- 源码、测试用例、日志输出与异常堆栈中是否出现明文 API Key / Token / 私钥。
- `.gitignore` 与打包白名单（如 `electron-builder.yml`）是否排除了 `.env`、本地开发 DB 与凭证文件。
- 错误提示与前端遥测中应对密钥做脱敏处理，绝不把未解密密文下发 HTTP 头。
