# v1.9.0 macOS 未签名降级路径（M7.8）

> 适用：无 Apple Developer 账号（$99/年未采购）或公证流程未就绪期间，
> 以未签名 `.app` / `.dmg` 分发。签名后本文件自动作废（runbook 见
> `release-signing-runbook.md` + `tools/build_mac.sh --no-sign`）。

## Gatekeeper「Open Anyway」引导（用户侧三步）

1. 首次打开 Harbor.app：Gatekeeper 弹「无法验证开发者」→ 点 **取消**
   （不要丢废纸篓）。
2. 系统设置 → 隐私与安全性 → 滚到底：「Harbor.app 已被阻止使用」→
   点 **仍要打开** → 认证 → 再开一次即放行（一次性，系统记忆）。
3. 命令行等价（进阶用户）：
   ```bash
   xattr -dr com.apple.quarantine /Applications/Harbor.app
   ```

## 首次运行权限引导（TCC / Keychain）

| 权限 | 触发时机 | 引导口径 |
|---|---|---|
| 屏幕录制（TCC） | 首次 take_screenshot / browser_screenshot | 系统设置 → 隐私与安全性 → 屏幕录制 → 勾选 Harbor → **重启应用**（后端返回 `TCC_PERMISSION_REQUIRED` 人话，`ScreenMac.capture` 内置） |
| 文件访问 | 工作区选目录 | macOS 无全盘弹窗；受限目录（桌面/文稿/下载）首次触发 TCC 按需授权 |
| 自动化（AppleEvent） | 外链系统浏览器打开 | 首次弹「控制 Safari/Finder」→ 允许（`NSAppleEventsUsageDescription` 已在 Info.plist 声明） |
| Keychain | MCP/Provider 密钥存取 | SSH 会话首次写入会得 -25308（`KEYCHAIN_INTERACTION_REQUIRED` 人话已内置）——请在**桌面会话**完成首写 |

## 与签名版的差异（诚实清单）

- SmartScreen 等价告警（首次打开多一步 Open Anyway）；
- 无公证装订：离线机器首次打开也走上述引导（公证的价值是在线校验免引导）；
- 自更新（update_service）替换 .app 后 Gatekeeper **重新**评估——引导重走
  一次（签名版无此步）；v1.9 更新语义为整包 .app 替换（master-plan §7.3）。

## 分发建议

未签名期间 DMG 内附 `未签名应用打开指引.txt`（本文件前两节的浓缩版），
README 双平台安装指引同步引用（`release-notes-v19-draft.md` §macOS）。
