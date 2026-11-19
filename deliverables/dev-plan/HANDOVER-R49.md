# Harbor R49 轮报告（2026-11-07）——缺陷猎扫第二轮（换面深扫）

> 协议同 R48：**双只读代理并行**（Node 桥 server/src 全域 / Python 域+前端未扫
> 模块——与 R48 的增量面不重叠）。22 候选逐条实证：**18 真 2 误报 2 延伸确认**，
> 全部修复。扫描报告（本地）：`outputs/r49-scan/`。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 扫描 | 双代理 22 候选（Node 13 + Py/FE 9）→ 实证 18 真 2 误报 2 记录 |
| 修复 | Node ×11（N1-N5/N8-N13）· Python ×5（P1/P4/P5/P7/P8/P9/P10）· FE ×2（P2/P6/F1） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r49**（1266 符号）/ audit PASS / 桥侧 20 PASS / **pytest 2009 passed / 0 failed / 3 skipped** |
| 契约面变更 | js_api 60→61（+group_files_read，_V12_EXTRA） |
| 新增测试 | `test_r49_scanfix.py`（18）+ parallel.mjs 断言对齐 1 |

## 1. Node 桥（13 候选：11 修 2 判否）

| 编号 | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| **N1** | workspace.js | **delete_path PS 注入**（高危）：回收站脚本用 `JSON.stringify(target)` 内联 PS **双引号串**——`$()` 在双引号串内执行（`a$(calc).txt` 合法文件名→任意命令执行；S2-13 同型漏网） | 改 PS 单引号字面量（`'→''` 唯一转义，零插值） |
| **N2** | files.js | **search_replace 编码损坏**（数据损坏）：win32 翻译分支 (a)非 UTF-8 编码 `payload.toString('utf8')` 乱码回写；(b)CRLF 文件未归一即 `\n→\r\n` → **\r\r\n 翻倍**。Node 逐字实证双损坏 | 换行翻译改 JS 字符串层（先归一 CRLF→LF 再 LF→CRLF）后按原编码一次性编码 |
| N3 | browser.js | 会话池满全 busy 时兜底驱逐 `[0]` 会 close 正在执行的会话（Target closed 崩） | 只挑非 busy 驱逐；全 busy 抛 SESSION_BUSY |
| N4 | browser.js | browser_search 成功路径不关会话（对照 browserOpen）→ 每次搜索遗留 Chromium 进程 | 成功路径补 closeOne（CAPTCHA 分支保留——takeover 需要） |
| N5 | guard.js | 免护栏收任意正则 + matchRule 对 64MB body 序列化文本同步 test → ReDoS 冻结单线程 | rule_add 限长 200；matchRule 文本截 8KB |
| N8 | commands.js | run_admin_command note 恒「已通过管理员权限执行」——用户取消 UAC/失败也显示成功 | note 如实区分（exit_code 0=成功 / 非 0=「执行结束，退出码 N（非 0=失败）」） |
| N9 | sessions.js | 空数组守卫 findMany 在事务外——通过后 deleteMany 前并发新写入行被误删 | 守卫移入 $transaction（tx.findMany）+ throw→200+{error} 方言 |
| N10 | files.js | 指纹 Map 无上限（长进程慢性泄漏） | 512 上限插入序逐出 |
| N11 | session-context.js | withRootLock 键未小写归一——win32 同根不同大小写绑定时互斥静默分裂 | key.toLowerCase() |
| N12 | plans.js | rollback 快照源 `path.join(dest, rel)` 未复跑 dest 包含校验（S2-23 只修 create 侧）——篡改 manifest 可复制目录外文件 | rollback 侧补 startsWith 校验 |
| N13 | misc.js | guardAudit 先 persistChainHead 再 appendFileSync——append 失败时链头已前进→审计链永久断链 | 交换顺序（append 先行=幂等重试；断言更新 parallel.mjs） |
| ~~N6~~ | session-migrate.js | ~~rememberDeletedId 无锁~~ | **判否**：readFileSync+atomicWriteText 全同步，单线程无交叠窗口 |
| ~~N7~~ | runtime.js | ~~runtime.json 整文件读合并写无互斥~~ | **判否**：atomicWriteJson 全同步（同上） |

## 2. Python/前端（9 候选：7 修 2 记录）

| 编号 | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| **P1** | plan_service.py | 步骤 risk `[:4]` 截断→`dangerous→dang`，`_RISK_ORDER` 全称键永不命中→风险色条错为最低档 | `[:4]`→`[:16]`（全称保真） |
| **P2** | group files 前端+后端 | **群文件读取链默认全断**：群文件存 ~/.glm-chat/group_files（read_file 工作区监狱外）恒「路径越界」 | 后端新增 `group_files_read` js_api（root 监狱内读，_V12_EXTRA，js_api 61 个）；前端 files.js 查看与注入指引改走新通道 |
| P3 | browser/service.py | `_enter_captcha` takeover 无容量淘汰（反复 CAPTCHA 不操作→无界增长） | 加容量淘汰（超 32 删最旧过期项） |
| **P4** | local_proxy.py | _relay Content-Length 分支上游断流未置 close_connection→keep-alive 互等永久挂起 | `remaining>0` 时 `self.close_connection = True` |
| **P5** | file_service.py | search_replace 未拒 `old=''`：replace_all=true 时逐字符间插入全文毁损 | 早拒空 old（人话文案） |
| P6 | expert/orchestrator.js | recovery 后 pendingConsumption 不恢复；restore 事件带旧 runId→从二次 checkpoint 投影消失 | restore 重钉 runId |
| **P7** | provenance.py | wrap_untrusted 不中和正文中伪闭合标记→毒页提前闭合包裹越狱（上下文侧无转义防线） | 零宽空格中和（可见内容不变；破窗完整性优先于字节纯度，docstring 记例外） |
| P8 | search_reader.py | 手工改 reader.json 负 max_input_chars→`text[:负]` 去尾切片截断失效 | 钳制 [0, 200000] |
| P9 | session_win.py | _ensure_window 锁外建窗→并发双建隐藏次窗先建者泄漏 | 锁内复查+后到者 destroy |
| P10 | guard_service.py | 白名单规则每次命中全量重写 guard.json（写放大） | hits 内存累计，每 32 次摊销落盘 |
| F1 | attachments.js | `<img src="${a.dataUrl}">` 属性未转义/未校前缀（纵深缺口） | data:image/ 前缀校验 + escapeHtml |

## 3. 判否与记录
- N6/N7：两个「竞态」实为**同步代码误报**——readFileSync/atomicWriteJson
  全同步，Node 单线程无交叠窗口。教训：扫描代理报竞态时先核 fs API 同步性。
- P6 的 completed-cache 分支（缓存命中不触发 mailbox.consume 的深层状态机
  问题）记录为已知边界——恢复链 runId 重钉已解投影消失的主损害。

## 4. 门禁记录
```
build×2 / 五契约 / 锚点 r49 差分零漂移 / upgrade_audit PASS / 桥侧 20 PASS
  （parallel.mjs 断言随 N8 对齐）
pytest tests/ -q → 2009 passed / 0 failed / 3 skipped
```

## 5. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R49.md` |
| 扫描报告（本地） | `outputs/r49-scan/` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r49.json` |
