# Harbor v1.6.0「开放版」交付总结

**日期**：2026-10-19 · **commit**：`b95ab5d` · **测试**：677 passed / 1 skipped / 0 failed
**三闸**：build 9627 行 md5 幂等（`af24d656...`）· UI 契约 PASS · 全量回归绿
**发布门（T14）**：五闸全过；`dist/Harbor.exe` 拆归档验证内嵌 harbor.html 与磁盘逐字节一致，五大新特性俱在。

---

## 一、交付内容（T1-T14 全部落地）

| 里程碑 | 任务 | 状态 | 关键实现 |
|---|---|---|---|
| M1 | T1 GitHub Models 预设 | ✅ | `models.github.ai/inference`、PAT models:read scope 指引、免费层徽标 + 禁生产常驻声明（裁决①口径） |
| M1 | T2 目录探测 | ✅ | 延展 `local_models` 按 host 分流 catalog（**零新 js_api**）；provider/model 格式过滤、ctx 三别名、modalities 容错、401/403/429 人话、失败降级热门兜底+手输 |
| M1 | T3 429 人话 | ✅ | RPM vs 日额度双分支（header 解析）+ 无头兜底，5 用例锁定 |
| M1 | T4 DeepSeek 校准 | ✅ 代码级 | preset 结构与官方一致，结构锁定测试；**真机联调待目标机** |
| M1 | T5 提示词五处 | ✅ | 沙箱边界告知段（INTENTIONAL_DELTAS 白名单，关时不注入）/ 限额策略+ MCP 铁律 / compact 保留工具序列 / 本地上下文有限 / MCP instructions 维持不注入 |
| M2 | T6 沙箱面板 | ✅ | `39-sandbox.js`：开关/三类别档位/限制编辑/状态灯/累计统计/重置/非 Windows 明示 |
| M2 | T7 W21-26 | ✅ | 池并发限制接线/stale 去抖/404 退避/_closed 态防复活/forget 代际/keep_both 毫秒戳 |
| M2 | T8 边界项 | ✅ | W27 墓碑 backendOk 门/W28 生成中 continue/W30 compact 逐条 try/W33 并发探测 last-wins |
| M2 | T9 冒烟 | ✅ **六步全过** | 真实 Job Object：echo/超时清剿孙进程/fail-closed/审计/切档位真实生效/非 Windows 降级（代码级） |
| M3 | T10 本地优化 | ✅ | 503 指数退避（锁定 v1.5）/首 token 等待态/tokens-s 实时显示（无 usage 标「估」） |
| M3 | T11 布局直切 | ✅ | `41-nav.js` 五区导航（对话/设置/审计/搜索/沙箱+通知中心）；老入口 DOM 保留行为并入；空态三步引导；首次引导（裁决②口径） |
| M4 | T12 MCP resources | ✅ | list（分页聚合）+ read（text 直出/blob 落盘 toolcache）+ 订阅注入 + 全程审计 + UI 资源 tab；三 js_api 进 `_V12_EXTRA` |
| M4 | T13 DND | ✅ | 失焦抑制 ok/info（warn/err 放行）+ 通知中心红点/列表/清空（裁决③口径） |
| M4 | T14 发布门 | ✅ | 677 passed / 契约 PASS / build 幂等 / exe 拆归档验证 |

## 二、过程中抓到并修复的问题（不止方案清单）

1. **测试地基级 bug**：`sandbox_service._STATS` 模块级计数器跨测试累积 → 文件间顺序依赖（`importlib.reload` 巧合掩盖）。修法：conftest autouse 显式 reset + delta 断言，正反两种顺序 61/61 实证。
2. **T1 引入的 UX 退化**：GitHub 热门兜底表使识别失败（如 401）被吞成「已加载 N 个模型」静默成功 → 失败 warn 透因 + 兜底说明。
3. **QA 自引入顺序依赖**（T9 step3 类重绑定）+ **测试 harness ~20% 抖动**（401 前不读 body 踩连接重置）——均测试侧修复。
4. 双实例并发的文件边界协调（T2 主体/文案/测试文件分工，无双写事故）。

## 三、T15 遗留结论（排期/不做二选一）

| 项 | 结论 | 理由 |
|---|---|---|
| **T4 DeepSeek 真机联调** | **排期 v1.6.1**（首条） | 无外网环境不可为；代码级校准已完成 |
| **Ollama /api/tags 真机销项**（KNOWN_ISSUES #2） | 排期 v1.6.1（同 T4 一批目标机验证） | 代码级验证已过 |
| **token -15% 量化目标** | 排期 v1.6.1 目标机基准链复跑 | 本环境无外网，协议就绪（3 条标准链） |
| **GitHub Models 限额复核** | 排期 v1.6.1 真机（真实 PAT） | §9 外部源数字需实测校准 |
| **遥测最小版** | **明确不做（v1.6.x 内）** | DND 已裁决入选；遥测的合规叙事收益低于成本，如未来重启动机需先过隐私设计评审 |
| **OAuth（MCP 远程认证）** | 明确不做（v1.6.x） | stdio+本地 HTTP 场景无刚需；远程 MCP 需求出现时再评估 |
| **多模态输入** | 明确不做（v1.6.x） | v1.2 起 Non-goals 延续 |
| **WebDAV 真实服务器联调** | 排期 v1.7 | 需坚果云/Nextcloud 账号与冲突合并 UX 设计稿 |
| **代码签名** | 排期发布前评估 | 成本项，先积累误报反馈数据再决策 |

## 四、验证矩阵

| 门 | 数字 | 执行方 |
|---|---|---|
| pytest 全量 | 677 passed / 1 skipped / 0 failed | 主理人终验 + QA 独立复跑 |
| UI 契约 | PASS（40/13/43/39/21 + libs 4/4） | 主理人终验 |
| build 幂等 | 9627 行，两遍 md5 `af24d656...` | 主理人终验 |
| exe 拆归档 | 内嵌与磁盘 md5 一致；五新特性俱在 | 主理人 |
| 沙箱冒烟 | 六步全过（真实 Job Object） | QA |
| 修复抽查 | 12/12 逻辑真实 | QA |
| 顺序无关性 | 正反/混合序 61+61+37 | QA + 工程师 |

## 五、给用户的下一步（目标机清单）

1. **DeepSeek 真机校准**：跑基准链②（单文件改），验证工具调用全成功+计费正确（T4 销项）
2. **Ollama 冷启动**：验证 503 退避可见+首 token 等待态+/api/tags 徽标（KNOWN_ISSUES #2 销项）
3. **GitHub Models**：真实 PAT 探测目录（provider/model 格式）、触发 429 看 RPM/RPD 人话
4. **布局直切验收**：老用户升级后老设置按钮→新导航通路、空态三步引导、首次引导 toast
5. **基准链复跑**：3 条标准链前后对比，记录 token 累计（-15% 目标）

---

## 附录：外部实测与遗留项清零（2026-10-19 晚，v1.6 遗留批次）

### A. 真机网络探测取证（主理人执行）

| 端点 | 探测结果 | 结论 |
|---|---|---|
| `models.github.ai`（GET/POST 全路径） | **全部返回 200 `OK`（text/plain 4 字节）**——含 POST chat/completions，真实 API 不可能 | **中间网络设备全量拦截**，GitHub Models 真机验证本环境不可为（外部源 §9 的目录结构描述无法在本环境采信） |
| `api.deepseek.com/v1/chat/completions` | 真 401：`{"error":{"message":"Authentication Fails, Your api key: ****e000 is invalid (request_id: 37dfc259-...)","type":"authentication_error"}}` | **真可达**，错误体已用于校准人话映射 |
| `open.bigmodel.cn/api/paas/v4/chat/completions` | 真 401：`{"error":{"code":"1000","message":"身份验证失败。"}}` | 真可达，中文错误体校准 |
| Ollama localhost:11434 | 连接超时 | 本机未运行 |

### B. L1 错误人话校准（真错误体 fixture）
`76-cost-estimate.js` 新增 `humanizeAuthError`：DeepSeek「Authentication Fails」→ 人话 + `request_id` 提取（排查可定位）；GLM「身份验证失败」/code 1000 → 平台错误码人话。**仅云端路径生效**（local 模式让位本地免 Key 提示——此优先级由回归测试抓出并修正）。11 项回归测试全绿（tests/test_v16_leftover.py）。

### C. L2 catalog 双路径（T2 鲁棒性）
因 §A 的中间设备反证，`github_catalog_models` 改为双路径：先 `/catalog/models`（外部源格式），失败 fallback `{inference_base}/models`（OpenAI 标准清单），双败才降级（前端热门兜底+手输）。真实 PAT 场景多一条路；fallback 保留裸名（宽松，有胜于无）。

### D. L3 目标机一键验证（`deliverables/scripts/target_verify.py`，零依赖）
一条命令完成全部遗留验证并出 md 报告。**PowerShell 用户（Windows 默认 shell）推荐 config 模式**——bash 续行符 `\` 在 PowerShell 非法且反斜杠路径会被转义，凭证进 JSON 可彻底规避：

```powershell
# 1) 创建 verify.json（模板见脚本 docstring 头部）
notepad verify.json
# 2) 一条命令（无续行、无反斜杠坑）
python deliverables/scripts/target_verify.py --config verify.json
```

参数式（PowerShell 续行符是反引号 `` ` ``，不是 bash 的 `\`）：

```powershell
python deliverables/scripts/target_verify.py `
  --deepseek-key sk-xxx --github-pat ghp_xxx `
  --ollama-url http://localhost:11434 `
  --bench-base https://api.deepseek.com/v1 --bench-key sk-xxx `
  --baseline baseline.json `
  --output deliverables/metrics/target-verify-2026-10-19.md
```

覆盖：① DeepSeek 工具调用校准+计费对算（T4 销项）② GitHub 双路径目录真实结构打印+429 header 形态（T2/T3 校准回填）③ Ollama tags/show/generate（KNOWN_ISSUES #2 销项）④ 3 条基准链 token 统计 vs 基线算 -15% 达成率。已本机自测（无参打印 PowerShell 用法 rc=0；config 模式跑通；坏 config rc=2 带用法）。

### E. 遗留项状态更新

| 遗留项 | 新状态 |
|---|---|
| T4 DeepSeek 真机联调 | 🟡 端点连通+错误体已实证；工具调用/计费 → 目标机一键（target_verify DeepSeek 项 PASS 即销） |
| GitHub 限额/目录实测 | 🟡 本环境被网络设备拦截不可为 → 目标机一键（脚本自动打印真实结构回填校准） |
| Ollama /api/tags（#2） | 🟡 一键销项就绪（KNOWN_ISSUES #2 已更新） |
| token -15% 基准链 | 🟡 基准 harness 就绪 → 目标机一键出达成率 |
| 遥测/OAuth/多模态 | ⚫ 明确不做（v1.6.x） |
| WebDAV 真实联调 | 排 v1.7 |
