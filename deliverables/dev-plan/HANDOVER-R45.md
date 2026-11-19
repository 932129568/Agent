# Harbor R45 轮报告（2026-11-07）——前沿落地第四批

> 接续 R44：HANDOVER-R42 §4 排期的改进 6（排队式 steering）与 8（专家包三层化）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 落地 | 排队式 steering（同会话在途消息排队，轮边界注入）· 专家包三层化（正文预算裁剪 + 资源索引常驻） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r45**（1262 符号，+EXPERT_PROMPT_BUDGET_CHARS/expertPromptBudget）/ audit PASS / **pytest 1975 passed / 0 failed / 3 skipped** |
| 新增测试 | `test_r45_steering_expert.py`（3：预算裁剪/资源索引/排队接线） |

## 1. 排队式 steering（改进 6；调研轮 21）
- **现状核实**：同会话 run 在途时 sendMessage 直接拦截（toast「点停止键」）——
  中途纠偏唯一方式=硬打断。**裁决：ModelExecutor 无需改动**——轮间
  beforeRound 重建请求时天然读取 s.messages，消息在轮间入库即「轮边界注入」
  （Claude Code 语义的 Harbor 化，机制已存在缺的只是入口）。
- **实现**（`chat/send.js`）：`_sameRun` 分支改为排队——消息照常入库
  （气泡+历史+附件解析+saveSessions），`sendMessage._queued = true`，
  runAgentLoop 调用点按标志跳过（不启动第二 run）；toast 明示
  「已排队：当前工具步骤结束后 AI 将看到」。群聊（_busySid 语义）与
  专家一次性消费维持原拦截；isStreaming 由在途 run 所有权管理（排队路径
  不得复位——防误伤在途 run）。多条排队天然支持（多次 Enter）。
- 停止/预算/续跑路径与排队消息无冲突（消息已在历史，W21 固化语义不变）。

## 2. 专家包三层化（改进 8；调研轮 7/24）
- **现状核实**：validator 的 maxPromptBytes=256KB 是防滥用上限而非注入预算
  （≈12 万 token 全量常驻）；context.js 的 skill 检索分支是储备基建
  （`source.skill` 无任何调用方传入）。
- **实现**（`expert/context.js`）：
  - `expertBodyBudget`：actor.text >16000 字符（500 行口径）→ 裁剪为
    「头部 + 截断声明（含完整正文字数与拆分指引）」；预算内一字不动。
  - **资源索引常驻**：snapshot.skills 逐条入 system（[skill] 名·描述·资源
    目录 + 每资源 path/kind/KB）——三层化的「目录层」，模型可见包内有什么
    可按需索取，不再盲猜。
- provenance/host 规则/UNTRUSTED 结构零变化（测试断言锁定）。
- **踩坑（重要，照抄）**：foundation 测试基建用 `.replace('SOURCES',...).replace('BODY',...)`
  两段式嵌入——**新增顶层常量名含 'BODY' 子串（EXPERT_BODY_BUDGET_CHARS）会被
  二次 replace 破坏生成的 js**（22 个 expert 测试齐炸）。修=常量改名
  EXPERT_PROMPT_BUDGET_CHARS。教训：给被 foundation 套件注入的模块加符号时，
  名字避开 SOURCES/BODY 字面子串。

## 3. 剩余排期（R42 §4）
7 群聊摘要回传（编排语义评审）/ 10 OTel span / 11 后台任务面板。

## 4. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R45.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r45.json` |
