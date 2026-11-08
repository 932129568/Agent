# R29 计划 · 依赖图 / 逐函数契约差分 / 继续拆分 / 四类升级

## 状态
已完成（Step 0–6 全部走完；Step 4 全量 1861 passed / 0 failed；Step 5 收尾报告已出；Step 6 复盘/交接已落盘）。按技能约束**未代 git 提交**，待用户手动执行。

## 不卡死计数
- 连续失败计数：0
- 失败签名去重计数：0
- Wave 检查点：Wave1(工具) / Wave2(拆分) / Wave3(升级+汇总) / Wave4(终验+交付)
- 回滚点：`git` 工作区 `0a7cfd3`（R28 提交）；按技能约束本轮 **Agent 不代提交**，由用户手动提交

---

## 环境事实行（实测 2026-11-05）
- Node `v22.22.2`；Python `3.13.14`（venv `C:\Users\陈\.workbuddy\binaries\python\envs\default`）
- HEAD `0a7cfd3`；工作区干净（拆分前）
- `frontend/manifest.json`：108 模块 / 14 样式
- 目标模块符号数：`settings/connection.js` 44、`sessions/controller.js` 47、`agent/run-controller.js` 20、`search/panel.js` 24
- 既有门禁：`frontend/build.js` lint（provides/requires 顺序）、`tests/test_frontend_tree.py` EXPECTED_ORDER 108 项 + 2 处计数、`tests/test_modern_build.py` 1 处计数、`deliverables/design/check_contract.py`

## 需求 → 步骤映射
| 用户需求 | 步骤 | 出口校验 |
|---|---|---|
| ① 建立依赖图 | W1-1 `tools/function_graph.py` | `--build` 产出 JSON；`--query connectApplyPresetNow --direction both --depth 2` 有结果；`--cycles` 输出 SCC |
| ① 逐函数契约差分 | W1-2 扩展 `tools/contract_diff.py` 第 6 类 | 逐符号定义体哈希可采集；篡改任一函数体能被 `--compare` 检出 |
| ④ 契约基线更新入库 | W1-3 生成 `contract-baseline-r29.json` | 文件落 `deliverables/dev-plan/`，108 模块 / 1155 符号 / 逐函数哈希齐全 |
| ①② 继续拆高耦合函数与三大模块 | W2-1..W2-4 | 单模块 ≤25 符号；build lint 一次通过；`MODULE_FAMILIES` 同步；契约差分零漂移 |
| ④ 四类升级 + 逐模块盘点 | W3-1..W3-4 | 性能/结构/健壮性/UX 各 ≥1 处真实落地并附测试；17 类前端 + 后端 7 域 + 工具链盘点表 |
| 全量验证 | W4-1 | 全量 pytest 0 failed；UI 五大契约 PASS；契约差分零漂移；构建幂等 |
| 交付/复盘 | W4-2 | 5 字段收尾报告、四类复盘、handoff、待提交清单（不代提交） |

## A 池（10 项，全命中）
- A1 需求→步骤映射：见上表 ✔
- A2 每步出口校验：见上表右列 ✔
- A3 数据/外部依赖：`frontend/manifest.json`、`tests/helpers/frontend.py::MODULE_FAMILIES`、`contract-baseline-r28.json`（历史锚点）、Node vm harness ✔
- A4 风险+缓解：① 单文件 vm 加载假设（R28 已踩，缓解=MODULE_FAMILIES 同步 + 13 文件复跑）② 双向依赖导致 lint 失败（缓解=依赖图 SCC 检测，只切单向组）③ 定义体哈希因注释归属漂移（缓解=精确行搬移 + 归一化）④ 冻结计数遗漏（缓解=grep 全仓 `== 108`）✔
- A5 验证方式：命令+退出码、pytest 报告、契约差分报告、构建幂等 cmp ✔
- A6 回滚：git 工作区可 `git diff` 逐文件回退；基线 JSON 保留 r28/r29 双锚点；不删任何文件 ✔
- A7 批量范围：预计 ~12 个前端文件 + manifest + 2 测试计数 + helper + 2 工具 + 3 报告/基线 ✔
- A8 安全触发面：无生产配置/DB/权限/凭证/文件上传；仅前端拼接式 JS 与本地工具 ✔
- A9 用户定制文件：`harbor.html` 为构建产物（由 build.js 重建，不手改）；`VERSION`/`config.json`/`backend/api.py` 不动 ✔
- A10 中断点：每 Wave 末 checkpoint；失败回退到该 Wave 起点（git diff 可逐文件还原）✔

## B 池（命中项）
- B4 性能敏感路径：四类升级中的性能项须有前后实测对比，禁无基线声称提升 ✔
- B6 测试：选定 `tests/test_contract_diff.py` + 新增依赖图/逐函数差分测试 + 全量 pytest ✔
- B7 批处理：试点（先 1 个模块）→ 备份（git）→ 分批（每模块一次）✔
- B9 多文件依赖影响面：`function_graph.py --query` + grep 复核（图谱仅加速器）✔
- B10 命令行/脚本：参数化，禁硬编码绝对路径 ✔
- B12 方案需回读：plan 写后回读 ✔
- 其余 B1/B2/B3/B5/B8/B11/B13：N/A（无 DB/新依赖/并发/外部系统/不可逆操作/外部输入/error-ledger 触发词）

## C 池
- C1 每 5 文件 CHECKPOINT：Wave 边界落 checkpoint 输出 ✔
- C2 跨 Wave：每 Wave 落 handoff 片段（写入本报告 §状态）✔

## 方案五段 / 取舍
1. **输入/输出/约束**：输入=108 个 `frontend/src/**/*.js` + manifest；输出=依赖图 JSON、逐函数哈希、拆分后模块、盘点报告；硬约束=符号集合/UI/API/源码行多重集/定义体哈希零漂移、js_api 契约零变更、config.json 零污染。
2. **候选与取舍**：A「依赖图先行 + 单向切分 + 精确行搬移」（推荐；trade-off=拆分粒度受限于依赖图，撤销条件=SCC 显示无可单向切分组则停）；B「按行盲拆」（反选：R28 已证明会破坏 lint 与 vm harness）；C「只做工具不做拆分」（反选：不满足用户指令①②）。
3. **失败模式**：lint 顺序依赖失败→回退该模块；vm harness 失败→同步 MODULE_FAMILIES；定义体哈希漂移→撤销搬移；全量回归→定位并修。
4. **权衡结论**：优先「可验证零漂移」而非「拆得最多」；代价=部分高耦合簇仍保留。
5. **产出与局限**：交付物见需求映射；局限=真机 GUI/macOS/性能基准/代码签名未覆盖（Out）。

## 二阶效应 / 歧义 / 未知
- 二阶效应：新增模块 ⇒ manifest 顺序变 ⇒ build 产物变 ⇒ vm harness 单文件加载假设（R28 已实证）⇒ 必须同步 `MODULE_FAMILIES`。观察指标=全量 pytest 失败数；兜底=回退拆分。
- 歧义清单：①「小模块」口径未给 → **声明假定** ≤25 顶层符号，证伪条件=用户给出其它阈值；②「全面升级」范围 → **声明假定** 四类各 ≥1 处 + 逐类盘点，不重构业务语义。
- 未知清单：`connectApplyPresetNow` / `connectScheduleIdentify` 的实际耦合边 → 由 W1-1 依赖图 `--query` 闭合；三大模块可单向切分组 → 由 W1-1 `--cycles` 闭合。

## 引用点实码 trace（写码前确认）
- `MODULE_FAMILIES`：`tests/helpers/frontend.py`（R28 已建，4 组）
- `EXPECTED_ORDER`：`tests/test_frontend_tree.py`（108 项）
- `contract_diff.py`：`tools/contract_diff.py`（5 类契约面，FROZEN 元组）
- `check_contract.py` 常量：`deliverables/design/check_contract.py`（DOM_IDS 等）
- `build.js` lint：`frontend/build.js::validateSymbolsAndOrder`

## TDD 判定
`[TDD判定] 联动` —— ≥2 模块联动 + 单文件 >200 行（connection.js/controller.js/run-controller.js 均 >200 行）；联动 `tests/test_contract_diff.py` + 新增依赖图测试；全量 pytest 作回归。
