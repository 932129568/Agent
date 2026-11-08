# Harbor R43 轮报告（2026-11-07）——前沿落地第二批

> 接续 `HANDOVER-R42.md` §4 排期：改进 3（权限记忆化收口）/ 4（browser_snapshot
> 语义原语）/ 9（harness 级评测集）三项全部落地。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 落地 | 权限记忆化高危收口（双端）· browser_snapshot 第七原语（双链）· 评测集（selection 8 例 + compact 机器侧回归） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r43**（1260 符号）/ audit PASS / 桥侧 20 PASS / pytest 见提交 |
| 契约面变更 | AGENT_TOOLS 13→14（+browser_snapshot）；GUARD_OPS 18→19 档（Py+Node）；js_api 57→58 |

## 1. 权限记忆化收口（改进 3；裁决修正）
- **裁决修正**：调研报告判定「缺确认弹窗 UX 闭环」**有误**——v1.4 UX-2 已有
  「本会话内不再提示 + 永久信任」双勾选（= once/always(会话)/always(工具)/拒绝
  四选闭环）。真缺口 = **高危操作未禁用信任记忆**。
- 修法（双端纵深）：前端确认弹窗对 delete_path/kill_process/run_admin_command
  **不渲染信任勾选**（每次必须人审，once-only）；后端 guard_save_config 拒绝
  高危 op 进 trustedOps（Python 报错人话）+ Node 加载/保存期剥离（历史残留
  静默剥离=更安全方向，注释裁决）。
- 审计已有（guard_audit allow/session-trust/trust-persistent/deny 四态）✓。

## 2. browser_snapshot 语义原语（改进 4；六原语→七原语）
- **纯函数核心**（`browser/snapshot.py`，stdlib html.parser 零依赖）：HTML →
  role/name/state 修剪树（可交互元素+heading/img/[role]；名称优先级
  aria-label>placeholder>alt>title>文本；状态位 disabled/required/checked/
  selected/expanded；href/type 附加）；void 元素不压栈（深度不漂移）、
  aria-hidden/type=hidden 剔除；深度 ≤10/条目 ≤400/字符 ≤max_chars。
- **双链实现**：pywebview（WinSession/HeadlessSession 对 _html 出树——
  BrowserSession 抽象 +7；注意插入时勿偷相邻方法装饰器，本轮踩过已修）；
  Node（playwright-core 1.64 `locator.ariaSnapshot()`；provenance 包裹与
  extract 同口径；browser.mjs 活测真链路绿）。
- **全链接线**：tools_schema 第七原语（三段式+strict）→ tool-executor 分发
  （guard 流）→ GUARD_OPS 19 档（session 档，双端）→ canonical digest →
  contract-signatures（Node register 第三参签名 `['selector','max_chars','token']`
  与 Python 对齐）→ AGENTS.md 原语表更新。

## 3. harness 级评测集（改进 9 最小可行）
`tests/test_r43_evals.py`（node vm 单模块沙箱，est_calibration 同款基建）：
- **selection evals ×8**：任务描述 → 断言 routeTools 域选择正确。**上线即抓
  两个真缺口**：路由词表缺「截屏/画面/网页」→ 已补（sys hints）。
- **compact 机器侧回归**：compactHistory 分类执行——超长工具结果摘要化
  （summarizeToolResult 文案含「已压缩」）、read_file 豁免、决策句/结论句
  保留、_compacted 标记、变更落盘。
- 评测基建三坑（照抄）：调用点必须在 vm 内（__vmEval，Node main 看不见
  vm ctx global）；__fe 用完整 relative key（router.js 有歧义双文件，basename
  alias 被丢弃）；外部依赖（saveSessions）须 globalThis 挂载（compactHistory
  变量解析用定义时作用域）。

## 4. 门禁记录
```
build×2 / 五契约 / 锚点 r43 差分零漂移 / upgrade_audit PASS / 桥侧 20 PASS
  （contract-signatures 146 对称含 browser_snapshot；guard.mjs 19 档）
pytest tests/ -q → 全绿（终态数字见 git log 提交说明）
```

### 4.1 全量中抓到并修复的三处（本轮测试对齐，均非掩盖问题）
1. **MacSession 缺新抽象**：BrowserSession +snapshot 后 mac 类不可实例化 →
   test_v19_mac 11 炸 → mac 补 snapshot（同 _html 源，同 Win 口径）。
2. **_DummySession 状态机桩缺新抽象** → 补 snapshot 桩（只做状态进出）。
3. **test_protect_list_beats_trust 钉旧行为**：原用 `trustedOps:['delete_path']`
   搭「持久信任」场景——R43 高危禁令正确拒绝该 save → 测试改用非高危 op
   搭场景 + 新增 R43 语义断言（高危进 trustedOps 被 save_config 拒绝且不入库）。
4. **锚点时效**：mac/router 改动晚于初照 → 重照 r43 终态（源码行多重集
   0d3df8a3…，与初照一致——mac/router 改动不在差分面）。

## 5. 剩余排期（R42 §4 中未落项）
5 MCP 渐进披露 / 6 排队式 steering / 7 群聊摘要回传 / 8 专家包三层化 /
10 OTel span / 11 后台任务面板 / 12 注入认知沙箱预筛。

## 6. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R43.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r43.json` |
