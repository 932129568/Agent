# HANDOVER-R63 — 本地模型修复 / 群文件配置族 / 中止优雅化 / 实时气泡 / 架构全景

> 2026-11-10。接续 `HANDOVER-R62.md`（R62 已提交 `a0df8e2`）。本文自包含。
> 架构图/拆分建议/Agent 重设计提案：**`architecture-r63.md`（本轮主交付物之一）**。

## 用户反馈 → 根因（全部实证） → 修复

| # | 反馈 | 根因 | 修复 |
|---|---|---|---|
| 1 | 本地大模型报错（getReader already locked），云端正常 | `resp.body = 包装流` 静默无效——**Response.body 是只读 getter**（非严格模式赋值即静默丢弃），包装器 start() 已把原流锁死 → parseSseStream 读到的仍是锁死的原流。仅 local=true 走包装器，故云端无恙（Node vm + 桩 fetch 复现，R22 起长期存在） | `new Response(包装流, {status, headers})` 重建返回（request.js:96 区）；vm 回归固化 |
| 2 | 群文件「保存目录」弹 `[object Object]`，无法绑定 | `group_files_config_get/set` 未注册 Node 桥（R57 漏项第三批；R62 补了 write/read） | pybridge 补移植（含系统目录黑名单/可写校验/空串恢复默认）+ registry 注册；前端 4 处错误显示经 groupFilesErrText 人话化 |
| 3 | 【前端 调用失败】signal is aborted without reason | 用户点「暂停接力」→ abort() 无原因 → fetch 拒真原文直出 | abort 携带可读原因（DOMException '用户暂停接力'）；groupSpeak 对中止类错误**保留部分正文**、气泡标「（已暂停）」，不再伪装调用失败 |
| 4 | 交接文档只是一串话、不全 | 归档只存【交接文档】小节，模型正文全丢 | 归档**完整发言**（正文+文档）；结构化渲染仍由详情页交接卡承担 |
| 5 | 群聊看得到在输出但不知道在输出什么 | 工作态气泡只有字数 | 工作态气泡可点 → **实时详情页**（流式正文+工具动态，400ms 刷新，完成即停，关闭清计时器，复制取快照） |

## 门禁（实测）

- 全量 pytest：**2060 passed / 0 failed / 3 skipped**（新增 tests/test_r63_frontend_fixes.py 3 项：本地流双锁确定性复现/中止分类/归档全文化；均 vm 零网络）
- server：group-files.mjs **15/15**（config 族 6 项边界：默认/自定义绑定/写入落点/C:\Windows 拒/非法 JSON/恢复默认）；contract-coverage 165 migrated ghosts 0；contract-signatures 0 mismatch
- 契约基线 **r63** 已生成（1318 符号）；UI 契约 PASS；依赖棘轮 157 条通过
- 安装包重打：`dist-electron/Harbor-Setup-1.9.0.exe` sha256 `130c3024…a0c467`；asar 六个 R63 标记全命中；R61 备份保留，R62 中间包已清理（同日被 R63 取代）

## 真机复验清单

1. 本地模型（Ollama 等）单聊+群聊发消息 → 正常流式，不再 getReader 报错
2. 群聊进行中点「暂停接力」→ 成员气泡显示部分正文+（已暂停），无英文报错
3. 群文件面板改目录 → 保存成功提示目录路径；指到 C:\Windows → 「不能使用系统目录」
4. 群聊工作气泡点击 → 实时输出滚动 + 工具调用状态；完成后点开为全文
5. 群文件点开任一归档 → 含正文与【交接文档】全节

## 遗留

- Agent 重设计三原则（过程可见/失败即接管/配置即生效）与 harbor.html 拆分方案见 `architecture-r63.md`——待用户拍板后立项实施（涉及 manifest 符号约束，属独立大轮）。
- 激进测试下轮候选清单见 architecture-r63.md §八。
