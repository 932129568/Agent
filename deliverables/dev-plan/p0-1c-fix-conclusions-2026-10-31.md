# P0-1c 修复结论：T05 全覆盖新发现 86 项 suspect 的契约对齐

- 日期：2026-10-31
- 执行：工程师（寇豆码，第二实例续任——前任实例 T03 中断后经交接备忘无损续做）
- 输入：架构师方案 `design-2026-10-30-p0-1c-fixes.md`（K1/E1-E3/F1-F6/M1-M4/CL1-CL2/PL1/W1-W8/CF1-CF7/WD1-WD2/MC1-MC9/RP1-RP2/PR1-PR7 + 主理人 Q1-Q7 裁定）
- 基线：P0-1 终版差分 `outputs/diff/20261030172234/`（86 call / 65 方法级 suspect）
- 红线遵守：backend/ 零改动（`git log backend/` 无本轮提交）；API_VERSION='v1.0.0' 冻结；get_api_info 零改动；config.json 零污染（各配置仍独立文件）；harbor.html 未触碰；未启动 dist/Harbor.exe；未删除文件；未记录密钥

## 一、根因 → 修复（7 类结构性根因，86 call 全收敛）

| 根因 | 修复（文件） | 收敛前 → 后 |
|---|---|---|
| R1 安全防线缺失 | `system.js` killProcess 四层防线完整复刻（C1 pid 数字校验→S2 tasklist 反查+权威→S3 通配符拒绝→P4 保护名单 15 项+自身 pid）+ `/T` 树杀 + GBK 解码截 2000 + api 层 resolve-failed/name-spoof 审计点位 | kill 五路径全收敛（安全级） |
| R2 功能缺失 | `expert-builtin.js` 内置导入器（8 包发现→消毒→严格导入，`HARBOR_BUILTIN_EXPERTS_DIR` env 化）；`files.js` read_file 全语义（keepends 尾行/自适应分页/24 万字符预算/64MB 预检/difflib 猜错/binary ok 语义反转修正） | experts 10/10、files 16/16 |
| R3 响应键集/编码方言 | workspace 族 W1-W8（sid null 透传/recent 对象数组/get 无 ok 键/裸路径字符串+时间戳前缀）；memory M1-M4（ts_iso 双字段/remaining/BAD_PARAMS 结构化）；clipboard CL1/CL2（verified 回读校验/{ok,text,len}）；build_system_prompt JSON 编码字符串（PR1） | workspace 12→17 全收敛、memory 6→11 全收敛 |
| R4 路径口径分叉 | make_dir/move/copy/delete/get_file_info/binary 响应改 resolved 绝对路径（F4/F5）；save_workspace_file 裸绝对路径 + `YYYYMMDD_HHMMSS_` 前缀（W6）；copy_into_ws `HHMMSS_` 前缀（W8） | 经 N05/N11 归一后全收敛 |
| R5 配置服务语义缺失 | **`config-specs.js` 新建（规格=纯数据）+ `jsonstore.js` 扩展（readConfigNormalized/mergeConfigValidated 两函数）**——hybrid 部分更新+BAD_PARAMS+hint/缺失落盘默认、model_prefs 缺键取当前+version:1、reader 越界拒绝禁夹逼、sandbox 宽松合并+status 平台能力声明（CF4 口径，与 ID-201 联动）；webdav WD1/WD2（密码必填才落盘/configured 检测在前/manifest 键） | config 18→0、webdav 7→0（非法值静默落盘的安全参数面全部关闭） |
| R6 文案/顺序/分类学 | mcp MC1-MC9（含 call_tool 校验顺序：服务器存在→启用→档位→decision 方言——用户拒绝话术不再掩盖未启用；MC9 崩溃修复）；rpc RP1/RP2（kwargs-only + CPython TypeError 固定格式合成——必填补齐源为 api.py AST 机械提取默认值表 `tools/diff/extract_rpc_defaults.py`）；provider PR1-PR7；experts E2/E3 | mcp 10→0、rpc 2→0、provider 15→13 match+2 登记 |
| R7 harness 伪差 | H1 三件套（种子二进制写入/快照 CRLF→LF 归一/worklog 时间戳行掩蔽）；N11 归一规则（本轮修复其 JSON 双重转义 bug——`\b\d{6}_` 此前永不匹配）；node-driver 工作区目录对齐 Desktop/GLM-Workspace（recent name=basename 伪差） | files/workspace 快照 sha 一致 |

**PL1 get_platform_info**：结构全对齐（os:'win'/machine x64→AMD64 映射/services 七接口就绪度/browser_backend 冻结文案）；`python` 键冻结、值披露 Node 版本串 → ID-202（与 ID-001 exe 字段同构）。

## 二、收敛证据

- **最终全量差分（两次复跑零翻转）**：`outputs/diff/20261031035719/` 与 `outputs/diff/20261031041627/` —— **fixtures=29 / calls=275 / match=267 / intentional=8 / suspect=0 / error=0，退出码 0**（两轮逐数字一致）
- 族级终态：meta 1i；sessions 12+3i；history-dir 8+1i；plans/ck 20；guard 25；commands 15；export 7；browser 22；software 11；files 16；workspace 17；memory 11；misc-config 21；provider 13+2i；os-system 8+1i；update 6；webdav 8；experts 10；mcp 16；rpc 11；selftest 10（含新建金丝雀 6）
- **suspect 86 → 0**（P0-1c 全部收敛；残留 3 项按方案登记为 ID-201/202/203）
- **intentional 5 → 8**（ID-201/202/203 预登记待签核，approvedBy=pending）
- 覆盖门禁：`npm run diff:coverage` exit 0 维持（fixture 覆盖 **139/145**，uncovered 登记 13，缺口 0，runId 20261031042522）
- selftest 金丝雀重建：`fixed-shape-canary.json` 新建（6 calls：ts/ts_iso 双字段/remaining+越界 BAD_PARAMS/sid null 透传/对照项）——今日全 match=修复在位，任一转 suspect=修复回退即时可见；既有三个分类器金丝雀维持
- Node 回归：**16 组测试全绿**（smoke 37 含 CF1-CF7+RP1/RP2+WD1/WD2 端到端、state 31、webdav 13、system/guard/files/experts/mcp/browser/contract 等）
- Python 回归：**1767 passed / 0 failed / 3 skipped / 1 deselected** 基线精确保持（backend/ 零改动只读回归，见 outputs/pytest-tmp/p01c-regress5/junit.xml——静默窗口 + `CODEBUDDY_SAFE_DELETE_ENABLED=0` 口径，见插曲说明）
  - 环境插曲（如实记录）：①第一次回归（p01c-regress/）漏带基线 deselect 参数，误执行真实安装器测试 `test_silent_install_uninstall_roundtrip`（Harbor.exe 本体未启动；测试自身卸载完成清理——HKCU 注册表键已删、开始菜单无残留、dist/ 无变化，均已实测验证）。②其后三次全量（p01c-regress2/3/4）出现 builtin experts 测试漂移性失败（import_all ok:false、imported 7/8，涉事测试每次不同、隔离单跑与探针 100% 过、backend/tests 零改动经 git 确认、涉事测试在 p01b/t05 两轮历史基线均 PASS）。二分 + 对照定位为**环境性文件 I/O 争用**：WorkBuddy safe-delete 回收站 shim（sitecustomize 打桩 os.remove/shutil.rmtree——P1-3 conftest 修复只剥离配额变量、回收站删除行为保留，致删除慢约 3.2 倍）叠加排查期间自身制造的全量/bisect 连跑文件风暴（数千新文件触发 AV/索引器追赶；失败全部聚集在重负载窗口内或紧随其后，静默窗口 6+ 连过）。③最终在静默窗口以 shim 关闭（`CODEBUDDY_SAFE_DELETE_ENABLED=0`，shim 自带显式关闭开关；纯环境变量、零项目文件改动）跑全量——基线精确恢复。补充建议（供 QA 后续基线采纳）：WorkBuddy 会话内跑 Python 全量回归统一加 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，并避免与其他重文件 I/O 任务并发
- 复跑防交叉：批间全量复跑 5 次（20261031021431 / 20261031024117 / 20261031030933 后四族 / 20261031033101 / 终态两连跑），已收敛项零翻转

## 三、残留 intentional 清单（8 项）

| 登记号 | fixture/call | 性质 | 签核状态 | 到期 |
|---|---|---|---|---|
| ID-001 | meta/api-info c01 | exe 字段宿主差异 | **已签核**（2026-10-30） | 2026-12-31 |
| ID-101 | sessions-validation c03 | 存储实现分叉 | **已签核**（2026-10-30） | P0-2 复评 |
| ID-102 | sessions-validation c04 | ID-101 回读级联 | **已签核**（2026-10-30） | P0-2 复评 |
| ID-103 | history-dir-basic c05 | DB 存储无文件可搬（migrate 语义） | **已签核**（2026-10-30） | P0-2 复评 |
| ID-104 | sessions-validation c01 | JSON 解析器文案（CPython vs V8） | **已签核**（2026-10-30） | 2099-12-31（永久，Q3 裁定） |
| ID-201 | prompts-tools c01 | build_system_prompt 沙箱尾注缺失（Node 无 Job 沙箱，不注入虚假安全声明；编码形态已对齐） | **pending 待签核** | P0-2 沙箱迁移后撤销 |
| ID-202 | clipboard-process c08 | get_platform_info python 键值披露宿主（结构/格式全对齐，键冻结值披露——ID-001 同构） | **pending 待签核** | 2099-12-31（永久，运行时身份） |
| ID-203 | prompts-tools c11 | test_provider_endpoint 库文本片段（urllib vs undici；键集与外层文案已对齐） | **pending 待签核** | 2099-12-31（永久，库实现细节） |

## 四、P0-2/P0-3/P0-4 交接累积清单

- **P0-2（沙箱/存储）**：沙箱服务迁移（ID-201 解除条件——迁移后注入真实尾注并撤销登记）；存储语义定案（ID-101/102/103 既有）；webdav/mcp 的 DPAPI 字段级加密迁移（Node 现明文落盘+W17 warning，读写对称不破坏行为）；harness mock 表 GBK 口径维持（kill 输出解码已对齐）。
- **P0-3（前端）**：save_workspace_file 裸路径字符串的 React 消费点核对（legacy callApi 返回值直接当路径用）；get_platform_info python 键展示文案；get_local_proxy base_url 口径消费点；search_status unknown_task 分支消费。
- **P0-4（桌面）**：builtin experts 资产打包（`backend/experts_builtin/` 纳入 Electron 资产或迁移 server 侧——`HARBOR_BUILTIN_EXPERTS_DIR` 已 env 化）；admin Electron 对话框（既有）；browser 正向路径真机验收（既有 P1-2）。

## 五、修复执行记录（git）

| commit | 内容 |
|---|---|
| 27ef69b | T01：kill_process 四层防线 + expert 内置导入器（安全/功能批） |
| 6c56fec | T02-H1：快照哈希环境产物归一（CRLF→LF + worklog 时间戳掩蔽，八族零翻转） |
| 9f33192 | T02：消费面批——read_file 全语义 + 工具面 + provider 错误分类（files 16/16） |
| d46b5f2 | T03 起步：CL1/CL2 剪贴板形状对齐 |
| fcafc1a | T03 WIP 保护提交（前任实例上下文中断；第二实例复核后续做） |
| 171f41e | T03 收官：W/M 补齐 + PL1 平台信息 + N11 转义修复 + 驱动目录对齐（workspace 17/17、memory 11/11） |
| 18591d5 | T04：config-specs 规格层 + webdav/mcp/rpc（四族 37 项全收敛） |
| （本提交） | T05：ID-201/202/203 登记 + 金丝雀重建 + 结论文档归档 |

## 六、偏差与决策记录（相对方案）

1. **前任 WIP 三处缺陷修复**（T03 复核发现，未盲目重写）：N11 规则 JSON 双重转义致正则永不匹配；get_effective_ws sid 归一空串（应为 null 透传）；node-driver 工作区目录名与 Python fakes 不一致致 recent name 伪差。
2. **超出备忘的保真补齐**（源码核对发现）：set_workspace 补 touch_recent（api.py 修复⑦）；recent/ws_enabled 持久化消费（Node 原重启即丢）；ws_enabled 键口径 sid or ''；save_workspace_file 异常返回 ''（H12 口径）；memory_delete 非整数 BAD_PARAMS 补 hint+%r 收到值+数字串 int 解析（_coerce_index 全口径，含 null 归 0 越权删除隐患修复）。
3. **rpc 必填补齐源改为 AST 机械提取**（方案未指定来源）：`tools/diff/extract_rpc_defaults.py` 从 api.py 提取 66 方法默认值表（可复现再生成），避免手工抄签名——AST 还纠正了直觉误判（build_tools 四参全可选）。
4. **webdav Node 无 DPAPI**：明文落盘 + W17 同款 warning（方案未覆盖此分支；非静默、读写对称，P0-2 迁移后收敛）。
5. **get_platform_info browser_backend.note 保留冻结文案**：mac 后端双侧均为理论实现（mac:false），文案差异不新开登记（ID-202 仅覆盖 python 键值——与方案 §5 一致）。
6. **Python 回归环境插曲**（如实记录）：①第一跑漏带 `--deselect tests/test_installer.py::TestSilentEndToEnd::test_silent_install_uninstall_roundtrip`（P1-3 既有排除口径），误执行真实安装器静默装/卸——测试自身卸载完成清理（注册表/开始菜单实测无残留，dist/ 无变化，Harbor.exe 未启动）。②其后全量出现 builtin experts 测试漂移性失败（imported 7/8、错误被导入器吞入 result）——定位为环境性文件 I/O 争用：safe-delete 回收站 shim（删除慢 3.2 倍）+ 排查连跑自身的文件风暴（AV/索引器追赶），失败全部聚集于重负载窗口、静默窗口 6+ 连过、涉事测试历史基线均 PASS、backend/tests 零改动；最终静默窗口 + `CODEBUDDY_SAFE_DELETE_ENABLED=0`（shim 显式关闭开关）跑通基线 1767/0/3/1 精确恢复。教训两条：基线命令口径须从设计文档 §6.10 复核而非凭记忆重构；WorkBuddy 会话内跑 Python 全量建议统一加 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 且避开重 I/O 并发（供 QA 采纳）。
