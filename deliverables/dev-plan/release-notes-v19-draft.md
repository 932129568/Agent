# Harbor v1.9.0「全域版」发布说明（草稿 · M9.9）

> 状态：功能冻结口径的安装/使用指引草稿；发布评审（M9.10）前复核
> KNOWN_ISSUES 与七门记录后转正。版本号以 VERSION 文件为准（1.9.0）。

## 一、本版新增（用户视角）

| 域 | 内容 |
|---|---|
| AI 驱动浏览器（Windows 全量 / macOS 理论支持） | 六原语：导航/提取/点击/填充/截图/关闭——AI 可见/隐藏双驱动模式（隐藏=AI 后台；可见=CAPTCHA 人工接管）；点击与填充每次用户确认，密码/文件字段拒填，点击前后自动截图留证 |
| dual-LLM-lite 本地读取器 | 搜索/网页正文经**本地**小模型压缩为结构化摘要再进主模型（隐私前处理，不升云；未配置时原文直出不受影响） |
| 审批预算与任务授权 | 会话内确认次数有上限（默认 20，可调 1-100）；超限自动升级为「任务授权邀请」——一次授权替代连环弹窗 |
| 审计哈希链 | 审计日志条目哈希链防篡改；审计查看器显示链头/长度，断链标红，支持全量校验 |
| MCP 供应链防护 | 工具 schema 首用锁定 + 定期重验（服务器悄悄换工具会被阻断待人工重审）；参数面投毒检测（危险参数名/shell 元字符枚举/恶意默认值） |
| 检查点六军规 | 计划批准即自动建检查点；回滚两步确认（清单→执行）+ 恢复后哈希校验；绝不删未备份文件 |
| Bing RSS 优先搜索 | 搜索主路径走 RSS（更快更省）；验证码结构化提示人工接管 |
| macOS 版 | 平台服务与 WKWebView 后端为**理论实现**（PyObjC 就绪即启用）；DMG 打包/签名/公证流水线就绪（`tools/build_mac.sh`） |

## 二、Windows 安装

1. 下载 `Harbor-Setup-1.9.0.exe` → 双击向导（或静默 `--silent`）。
2. 首次运行 SmartScreen「未知发布者」提示（未签名期间）：**更多信息 → 仍要运行**（签名 runbook 见 `deliverables/dev-plan/release-signing-runbook.md`）。
3. 依赖：Windows 10 1809+ 与 WebView2 Runtime（未装时安装器给出指引；Win11 自带）。
4. 数据目录 `~/.glm-chat/`（沿用既有版本零迁移；卸载不清数据）。

## 三、macOS 安装（理论支持口径）

1. 下载 `Harbor-1.9.0.dmg` → 打开 → 拖 Harbor 到 Applications。
2. 首次打开 Gatekeeper 引导：**取消 → 系统设置 → 隐私与安全性 → 仍要打开**
   （签名公证后此步消失；详见 `deliverables/dev-plan/mac-unsigned-fallback.md`）。
3. 首次使用授权（按需触发，均有中文人话引导）：
   - 屏幕截图：屏幕录制权限（勾选后重启应用）；
   - 外链打开：自动化权限；
   - 密钥存取：桌面会话完成首次 Keychain 写入（SSH 会话会提示）。
4. 数据目录 `~/Library/Application Support/Harbor`（与 Windows 版互不相通）。

## 四、升级与回滚

- v1.7/v1.8 → v1.9：Setup.exe 原地升级（配置/历史/检查点全保留）；mac 整包 .app 替换。
- 回滚：安装旧版 Setup 即可（数据向前兼容；`browser_sessions.json` 等新文件旧版忽略）。

## 五、已知限制（摘 KNOWN_ISSUES）

- macOS 全链路（Keychain/Seatbelt/Gatekeeper/DMG 实机）待真机验证（M9.4/9.5）；
- 浏览器驱动截图整页捕获（full_page）为窗口客户区口径（M8.4 细化项）；
- installer 卸载测试在 Harbor 运行中会环境性失败（非代码问题）；
- 性能基准（内存 <150MB/中文检索 ≥90%/安装到首问 <3min）待目标机实测（M9.6）。

## 六、校验和

发布时附 `SHA256SUMS.txt`（Setup exe / DMG / zip）；校验：
```powershell
Get-FileHash Harbor-Setup-1.9.0.exe -Algorithm SHA256
```
```bash
shasum -a 256 Harbor-1.9.0.dmg
```
