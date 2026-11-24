---
name: "owasp-audit"
description: "Checklist for injection, XSS, SSRF, path traversal, CORS, and auth bypass."
---

# OWASP 高危漏洞审计清单（owasp-audit）

## 必查项
1. **注入类**：SQL 拼接、Shell/PowerShell 字符串拼接、`eval`/`new Function` 动态执行。
2. **客户端与 CORS**：`dangerouslySetInnerHTML`/`innerHTML` 是否经 DOMPurify 净化；CORS 是否误放 `ACAO: *` 或反射任意 Origin。
3. **文件系统与网络**：用户输入路径是否做规范化边界校验（防 `..`/symlink/junction）；代理转发是否屏蔽私网 IP 与 DNS 重绑定。
