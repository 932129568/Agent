# Harbor 代码签名发布 Runbook（KNOWN_ISSUES §19 配套）

> 状态：2026-10-19 编制。**本环境无代码签名证书**（采购/人工项，AI 不可为）——
> 本 runbook 的价值：证书到手后照此执行，10 分钟完成签名与验证。
> 未签名期间的缓解：发布说明已引导「更多信息 → 仍要运行」（现行做法）。

## 1. 为什么必须签

Windows SmartScreen 对「无 Authenticode 签名 + 无下载信誉」的 exe 默认拦截
（「Windows 保护了你的电脑」蓝屏）。Harbor-Setup-1.7.0.exe（PyInstaller onefile）
首签前必然触发——**每多一个潜在用户在安装前被吓退，就是转化损失**。
签名不是技术炫耀，是安装漏斗的第一环。

## 2. 证书选购（唯一需要花钱的环节）

| 类型 | 年费量级 | SmartScreen 信誉 | 适用 |
|---|---|---|---|
| **OV（组织验证）** | ¥1,500–4,000 | 需下载量积累（数天到数周） | 当前阶段首选 |
| **EV（扩展验证）** | ¥5,000–9,000 | **签发即信誉**（立即免拦截） | 用户量上来后升级 |

- 采购平台（任选其一，比价后下单）：DigiCert、Sectigo、亚洲诚信（TrustAsia）、沃通（WoSign）
- 材料：营业执照（个人开发者可用个体工商户）、企业邮箱、电话（OV 审核 1–3 个工作日）
- **形态**：下载得到 `.pfx`（含私钥+证书链）或 HSM 令牌；本 runbook 按 pfx 写
- 保存：pfx 放**离线位置**（加密 U 盘/密码管理器），只在上签名时挂载；密码走环境变量不落盘

## 3. 签名命令（Windows SDK signtool）

> **本机自签实测记录（2026-10-19，签名流程已验证）**：本机 signtool（Windows SDK
> 10.0.26100.0）在位；用自签名证书对 Harbor.exe **临时副本**跑过下方双签命令——
> `sign` 0 warning 0 error、**RFC3161 时间戳成功嵌入**（digicert TSA 可达）、
> 签名后 PyInstaller onefile 归档仍完整可读（体积 +7.5KB 证书链）。
> 唯一失败点：自签证书 `verify /pa` 报「chain terminated in a root」、
> `Get-AuthenticodeSignature` Status=UnknownError——**这就是自签对 SmartScreen
> 无效的硬证据**（链不完整连本地校验都过不了，更无信誉）。真证书（CA 链完整）
> 到手后，下方命令**原样可用**，只需换 pfx 与密码。

先确认工具在位（Win10/11 装过 Windows SDK 或有 Visual Studio 即有）：

```powershell
# 检查（任一路径命中即可）
where.exe signtool
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" /?
```

双签（sha256 主签 + RFC3161 时间戳，保证证书过期后签名仍有效）：

```powershell
$pfx = $env:HARBOR_PFX_PATH        # pfx 路径（环境变量，不写死在脚本）
$pw  = $env:HARBOR_PFX_PASSWORD    # pfx 密码（环境变量）
$st  = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"
$ts  = "http://timestamp.digicert.com"   # RFC3161 时间戳服务器

# ① Harbor.exe（PyInstaller 产物，每次发版重签）
& $st sign /f $pfx /p $pw /fd sha256 /tr $ts /td sha256 /v dist\Harbor.exe

# ② 安装器（用户第一个接触的文件，**优先签**）
& $st sign /f $pfx /p $pw /fd sha256 /tr $ts /td sha256 /v dist\Harbor-Setup-1.7.0.exe

# ③ 卸载器（如单独分发）
& $st sign /f $pfx /p $pw /fd sha256 /tr $ts /td sha256 /v dist\Harbor-Uninstall.exe
```

CI 化（可选，证书只在构建机）：把签名步骤插在 `build_setup.py` 三 exe
产物之后、上传之前；pfx 走 CI secrets 环境变量。

## 4. 签名验证（发布前必跑）

```powershell
# 逐个验证（应见「数字签名列表」+ 签名者名 + 时间戳）
& $st verify /pa /v dist\Harbor-Setup-1.7.0.exe
& $st verify /pa /v dist\Harbor.exe

# PowerShell 一句话（Status 应为 Valid）
Get-AuthenticodeSignature dist\Harbor-Setup-1.7.0.exe | Format-List Status,SignerCertificate,TimeStamperCertificate
```

验收口径：Status=Valid + 时间戳在证书有效期内 + 签名者主体与采购主体一致。

## 5. 发布检查清单增补

上传前在既有清单（KNOWN_ISSUES §发布检查清单）上加两项：

- [ ] `Get-AuthenticodeSignature` 对 Setup/Harbor/Uninstall 三 exe 均 Valid
- [ ] 发布说明删除「更多信息 → 仍要运行」引导文案（签名生效后此提示不再出现）

## 6. 时间线与成本备注

- OV：采购 1–3 工作日 → 首次签名当天完成；SmartScreen 信誉积累需真实下载量
  （数百到数千次运行后拦截消退——可在发布说明请老用户多跑）
- EV：签完即免拦截，适合「新用户第一眼不能有警告」的阶段；年费贵约一倍
- 建议节奏：**v1.7 发布先用 OV**（如果证书已采购）；EV 等用户量证明产品留存后再上

## 7. 与自动更新的关系

签名**不影响** Harbor 现有 .bat 自更新替换逻辑（替换的是同路径文件）；
但注意：更新后的 Harbor.exe 同样需要签名（重新打包后签一次），否则用户
下次更新拿到的是未签名文件，SmartScreen 对「同路径替换」通常不重复拦截
（已有信誉），但全新机器下载仍会拦——**每次发版三 exe 全签**是纪律。
