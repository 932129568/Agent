# Harbor R50 轮报告（2026-11-07）——缺陷猎扫第三轮（未扫面+跨子系统交互）

> 协议同 R48/R49：双只读代理（Python settings/software/管线 + 前端未扫模块
> 与跨子系统交互流）。16 候选逐条实证：**14 真 2 记录**，全部修复。
> 扫描报告（本地）：`outputs/r50-scan/`。

---

## 0. 问题清单（按严重程度）

### 严重（P0/高危——数据丢失/安全/功能断裂）

| 编号 | 位置 | 触发条件 | 预期 vs 实际 | 影响 | 修复 |
|---|---|---|---|---|---|
| **A-P1** | container.py:119,145 | software_call / browser_search 截断产生 full_ref → read_more 续读 | 应返回全文续读；实际 read_more 恒「缓存不存在」（software/search 各自自建 ToolcacheService 实例，read_more 只查共享实例） | software_call 与搜索的全文续读功能完全断裂 | 容器装配补传 `toolcache=self.toolcache` |
| **A-P4** | software_service.py:769 | software.json 损坏（非法 JSON）后任意 probe/call 触发 _persist | 用户自定义条目保留；实际静默按纯预设重写，**无 .corrupt 备份全灭** | 用户软件注册表数据丢失 | 损坏时留 .corrupt 备份再覆写 |
| **A-P6** | software_service.py:384-418 | software.json 中 schema 值类型畸形（minLength='2'/pattern=123）→ software_call | 应返回结构化校验错误；实际 TypeError 穿透 _execute_guarded（只捕 OperationDenied）→ **审计不落、无错误码** | 审计缺口+不可诊断 | validate_args 全字段类型防御 |
| **A-P9** | toolcache_service.py:60 | 多实例（A-P1 修复前）同秒同序号 → 同 cid → atomic_write 互覆 | 各实例 cid 唯一；实际 A 内容被 B 覆盖、read_more 返回错内容 | 缓存数据完整性 | seq 改模块级共享 + 类锁 |
| **P1** | plan_service.py:172 | plan_create(risk='dangerous') | risk_max 应 = 'dangerous'；实际 `[:4]` 截成 `'dang'`，`_RISK_ORDER.get('dang',0)=0` → **风险色条错为最低档** | 计划卡风险等级全面失真 | `[:4]`→`[:16]` |
| **P2** | group/files.js + file_service.py | 群文件查看/模型读群文件 | 应能读取；实际 read_file 工作区监狱外恒「路径越界」→ **群文件查看与模型指引默认全断** | 群文件功能链断 | 新增 `group_files_read` js_api（root 监狱内）+ 前端改走 |
| **P7** | provenance.py:73 | 毒页正文含 `[END UNTRUSTED DATA]` 字面量 | 应中和（包裹完整性）；实际提前闭合，其后内容在模型上下文呈现于 UNTRUSTED 区外 | **provenance 越狱**（上下文侧无转义防线） | 零宽空格中和（唯一获准字节改写） |

### 中（P1/中危——功能错误/竞态）

| 编号 | 位置 | 触发条件 | 预期 vs 实际 | 修复 |
|---|---|---|---|---|
| **FE-1** | run-controller.js:981,1120 | B 会话普通聊天 run 在途时 A 会话有 running 计划 | B 的工具完成不应推进 A 的计划；实际 planCurrent 全局无会话绑定——B 工具完成把 A 步骤标 done/blocked，B 自然完成把 A 计划收尾 | 两处消费点加 `s.plan.task_id === planCurrent.task_id` 守卫 |
| **FE-2** | collaboration/ui.js:119,137 | planner 失败（非法 JSON/预算超限）→ plan=null 但 checkpoint 恒真值 → 恢复按钮显示 | 点击恢复应正常或报错；实际 `plan.goal` TypeError unhandled rejection 零反馈 | plan 存在性守卫 + try/catch |
| **FE-3** | expert/center.js:314 | 选中专家 + 本会话流式中点发送 | 应弹忙提示（键盘路径已有）；实际 capture 段 stopImmediatePropagation 绕过忙守卫 → RunRegistry.start 静默 cancel+abort 在途 run | capture 加 isSessionStreaming 守卫 |
| **FE-4** | collaboration/ui.js:91 | 本会话普通聊天在途时点「运行协同」 | 应忙守卫；实际 collaborationRun 无 isSessionStreaming 检查 → RunRegistry.start 静默取消在途 run | 加 isSessionStreaming 守卫 |
| **A-P2** | browser/service.py:672 | 搜索缓存 fetched_ts 落盘 monotonic（boot 相对时钟）→ 重启后差值为负 | 旧条目正常过期；实际**永不过期**（重启后所有缓存永久命中） | 构造器默认钟 monotonic→time.time（测试注入语义不变） |
| **A-P5** | search_reader.py:122 | reader.json 手改数值字段畸形（max_input_chars='abc'）→ web_open | 应钳制回默认；实际 int() ValueError 被外层 except:pass 吞→ **provenance 标注被跳过**（违红线 4） | read() 全数值字段 try 钳制 |
| **N5** | guard.js:306 | 白名单规则正则 + 64MB body 序列化文本同步 test | 应有上限；实际灾难回溯 → 冻结单线程 | rule_add 限长 200 + matchRule 文本截 8KB |
| **A-P8** | software_service.py:1152 | 沙箱 fail-closed/杀软拦截 → version 输出空 | 应 status=unknown（可重试）；实际 version_mismatch 固化 probe_cache → 恒报「同名假冒」 | 空输出判 unknown（不固化 mismatch） |
| **N3** | browser.js:129 | 会话池满且全 busy | 应 SESSION_BUSY；实际兜底驱逐 `[0]` 会 close 正在执行的会话（Target closed 崩） | 只挑非 busy；全 busy 抛错 |
| **N4** | browser.js:395 | browser_search 成功路径 | 应关会话（对照 browserOpen）；实际仅 error 路径关→ Chromium 进程遗留 | 成功路径补 closeOne |
| **N9** | sessions.js:66 | 空数组守卫 findMany 在事务外→通过后 deleteMany 前并发新写入被误删 | 守卫与 deleteMany 应同事务 | 移入 $transaction + throw→200+{error} |

### 低（P2/低危——纵深/写放大/边界）

| 编号 | 位置 | 缺陷 | 修复 |
|---|---|---|---|
| A-P3 | config_service.py:288,322 | history_dir_set 写失败静默 ok:true | _save_history_cfg 返回布尔 + 两调用点如实报 |
| N8 | commands.js:249 | admin 退出码非 0 也显示「已通过管理员权限执行」 | note 如实区分（exit_code 0=成功 / 非 0=失败） |
| N10 | files.js:31 | 指纹 Map 无上限（长进程慢性泄漏） | 512 上限逐出 |
| N11 | session-context.js:123 | withRootLock 键未小写归一（win32 分裂） | key.toLowerCase() |
| N13 | misc.js:112 | guardAudit 先 persistChainHead 再 append（断链窗口） | 交换顺序 |
| FE-6 | compact-command.js:244,263 | emoji 代理对截断腰斩（码元→码点） | `[...s].slice(n).join('')` |
| F1 | attachments.js:157 | dataUrl 属性上下文未转义/未校前缀（纵深） | data:image/ 前缀校验 + escapeHtml |

### 记录（本轮不修，留档）
| 编号 | 位置 | 原因 |
|---|---|---|
| A-P7 | config_service.py:227 | session_purge 对 session_ws.json 无锁——purge 用户操作频率极低，sync 写无交叠窗口 |
| A-P10 | software_service.py:1156 | 自定义 CLI 无 version_args 默认 probed（纵深缺口，需产品决策是否强制） |
| FE-5 | resume.js:129-168 | 逐计划 resume 卡是假的（不携带计划 draft）+ 跨会话污染——需 redesign，非 bug fix 范畴 |

## 1. 门禁记录

```
build×2 / 五契约 / 锚点 r50 差分零漂移 / upgrade_audit PASS / 桥侧 20 PASS
pytest tests/ -q → 2009 passed / 0 failed / 3 skipped
```

## 2. 扫描方法论增量
- **多实例资源分裂**：容器装配的服务依赖必须逐个核对——「默认自建」分支
  是分裂温床（A-P1/A-P9 同根）。
- **全局变量无会话绑定**：前端模块级可变状态（planCurrent）天然跨会话
  污染——新增消费点必须加会话绑定守卫（FE-1 两处）。
- **checkpoint 恒真值**：`_finish` 返回的 checkpoint 对象不含 plan 有效性
  信息——消费方须单独查 plan 存在性（FE-2）。
- **capture 段事件监听绕过主路径守卫**：stopImmediatePropagation 跳过的
  守卫必须在 capture 段内重建（FE-3）。

## 3. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R50.md` |
| 扫描报告（本地） | `outputs/r50-scan/` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r50.json` |
