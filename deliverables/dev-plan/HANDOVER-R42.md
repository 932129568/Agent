# Harbor R42 轮报告（2026-11-07）——前沿 Agent 形态调研与落地第一批

> 调研 + 迭代双段轮：①30 轮外部调研「2026-11 前沿 Agent 应是什么形态」；
> ②差距映射 12 条，本轮落地判定最大短板的前两条（记忆工具化 / 分类压缩+结构化
> 笔记），其余 10 条按性价比排期（§4）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 调研 | 30 轮（outputs/r42-research/frontier-agent-form.md，本地留存） |
| 落地 | 改进 1（记忆工具化+频率衰减）+ 改进 2（分类压缩+NOTES 结构化笔记） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r42**（1260 符号）/ audit PASS / 桥侧 20 PASS / pytest 见 §5 |
| 新增测试 | `test_r42_notes.py`（4）+ `test_memory_db.py` search 排序组 + strict/R11 断言扩展 |
| 契约面变更 | AGENT_TOOLS +2（memory_write/memory_search，三段式+strict）；js_api 54→57（memory_search + notes_append/notes_get） |

## 1. 调研结论（浓缩）

**前沿形态一句话**：以 harness 为产品、上下文为稀缺资源的可观测循环体——
文件型记忆工具（+39% 实证）、渐进披露的技能/工具面、摘要回传的编排者-工作者、
a11y 树为主的浏览器观察、once/always/never 权限记忆、排队式 steering、
后台沙箱任务、三层轨迹评测。多源交叉：Anthropic（Agent SDK/Skills/context
engineering）、OpenAI、Google ADK、Cursor（harness 持续演进/Keep Rate）、
Manus（六条语境工程）、Letta（sleep-time compute）、OTel gen_ai.*。

**Harbor 已踩在方向上**：记忆双时间戳（对齐 Zep valid_at/invalid_at）、
计划卡/回滚（对齐 Devin 检查点记忆）、GUARD_OPS 分档、三段式描述 lint
（对齐 ACI 打磨）、provenance 包裹、群聊接力。

## 2. 本轮落地

### 2.1 记忆工具化（改进 1）
- `memory_write`：模型主动写入（走 memory_remember 门控全链：untrusted 零写入/
  敏感字段拒写/NOOP 幂等去重，source=assistant+explicit）；`memory_search`：
  两源检索（memory.db + legacy memory.json）。
- **排序 = bigram 相关 × 频率强化（命中→最高 1.5x）× 时间衰减（≤7 天 1.5x /
  >30 天 0.3x）**——2026 共识重排序口径（arXiv 2601.18642）；profile 命中刷新
  衰减时钟（R16 既有语义接通）。
- 路由 bypass `memory_` 前缀（不参与域裁剪）；GLM 端点保留（与端点无关）。

### 2.2 分类压缩 + NOTES 结构化笔记（改进 2；落点裁决）
- 报告原写落点 `backend/application/task.py` **不准确**（Harbor 压缩在前端
  compaction 链）——修正为 `compact-command.js` + `prompts/compact.md`。
- **分类压缩**（prompt v1.1.0，前后端逐字节一致 + manifest sha 重照）：分类
  保留（目标/显式约束/路径/实现细节/未解决错误含报错关键行/下一步）分类丢弃
  （已处理工具输出原文/寒暄/支线）——Anthropic 口径。
- **NOTES**（`notes/<sid>.md` 独立文件，config.json 零污染）：compact 成功 →
  `notes_append` 落盘；`beforeRound` → `notes_get` 注入系统段（尾部 4000 字，
  空文件零注入）；`session_purge` 钩子清孤儿；sid 白名单防穿越；64KB 截尾保尾。

## 3. 落点核实与裁决记录
1. 报告改进 2 落点错误（task.py→前端 compaction）——调研报告的落点必须复核。
2. 「+39%」数字：Anthropic 官方（memory tool+context editing 组合）✓；
   「15x token」：multi-agent research system 原文 ✓。
3. R11 断言按契约演进更新：GLM 端点过滤后保留 `software_call + memory_*`。

## 4. 剩余 10 条改进的排期建议（按性价比）
| # | 方向 | 备注 |
|---|---|---|
| 3 | 权限记忆化（once/always 工具/always 会话/never 四选闭环） | guard_session_trust/trustedOps 已有底层，缺确认弹窗 UX 闭环 |
| 4 | browser_snapshot 语义原语（a11y/ARIA 快照） | 需动 Node 浏览器执行链，独立一轮 |
| 9 | harness 级评测（selection evals + compact 回归集） | tests/ 增量，可与 3/4 并行 |
| 5 | MCP 工具面渐进披露（>25 个或 >10% 窗口折叠为 search 元工具） | tools_schema.build 增量 |
| 6 | 排队式 steering（工具边界注入用户消息） | 改 ModelExecutor 轮间语义，需设计 |
| 7 | 群聊接力摘要回传（编排者-工作者） | 15x token 警示的应对 |
| 8 | 专家包 Skills 三层渐进披露（正文 ≤500 行） | expert 域 |
| 10 | OTel gen_ai.* span 导出 | logging_setup + 审计链 |
| 11 | 后台任务队列 + 等待输入面板 | 调度域 |
| 12 | 提示注入「认知沙箱」预筛 | provenance 域 |

## 5. 门禁记录
```
build×2 / 五契约 / 锚点 r42 差分零漂移 / upgrade_audit PASS / 桥侧 20 PASS
pytest tests/ -q → 见 git log（本轮新增 12+4 测试全绿）
```

## 6. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R42.md` |
| 调研报告（本地） | `outputs/r42-research/frontier-agent-form.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r42.json` |
