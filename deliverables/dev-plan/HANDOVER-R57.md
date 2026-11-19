# HANDOVER-R57 — agent 冲突收口 + 全功能前端开关中心

> 日期：2026-11-08。接续 HANDOVER-R56.md。任务（用户）：「调查 agent 冲突的东西，
> 去掉落后的部分防冲突，所有功能确保前端都有开关」。
> 方法：双只读扫描代理（冲突面 / 开关缺口）→ 主会话逐条实证（20 候选 18 真 2 误报）
> → 落地。报告：`outputs/r57-scan/冲突扫描.md`（含处置标注）。

## 0. 一眼总览

| 维度 | 状态 |
|---|---|
| 全量 pytest | **2042 passed / 0 failed / 3 skipped**（R56 基线 2023 → +19：R57 新测 19） |
| 契约锚点 | **r57**（contract-baseline-r57.json，116 模块 / 1288 符号） |
| build | ×2 幂等 ✓（116 模块，harbor.html 31732 行） |
| 提交 | 本轮 1 笔（见 §6） |

## 1. 真冲突修复（全部实证后落地）

| # | 冲突 | 根因 | 修复 |
|---|---|---|---|
| A1 | **provider.js 第三份工具 schema**：Electron 链缺 R42 memory_write/memory_search、缺 R43 browser_snapshot、无 R44 MCP 折叠、v1.8 三工具旧单段文案、ro 角色文案漂移 | R42/R44 只落在 Python tools_schema，Node 硬拷贝未随演进 | 五处逐字对齐（三段式/strict/折叠阈值 25） |
| A2 | **append_memory 键名断链**：schema 参数 content、两链存储只读 text → 内容全丢 | 前端整包 stringify 分发 | 分发归一 `{text: args.content}`（A3 描述指路回退——撞 legacy 逐字节锁定红线，见 §4 裁决 2） |
| B1 | **命令去重键三源分叉**：Python dedup_key（H3）vs Node/前端旧口径，注释均自称同源 | H3 四轮只升级 Python | 三端逐字移植（12 变体断言三键相等）；Node isWrite 补重定向/^；DEDUP_WINDOW_MS 死常量删 |
| B2 | **switchSession/newSession 仍 wholesale-clear 三信任集**（引用旧 W26 语义），与 R56 两链 clear-on-switch 移除矛盾 → 切走再切回重复弹窗 + 误伤并行后台 run | R56 只改了后端与注释，漏了前端清空点 | 两处零 clear（round6 项2 静态断言反转为零，防回归） |
| B5 | **mcp_search 双断链**：Electron 无折叠全量下发 + pybridge 空壳返回 [] | R44 未迁移 | Node 折叠（>25→mcp_search）+ pybridge 真实现（mcp.js 注册表打分，与 Python search_tools 同构） |
| C3 | **group_files 族 Node 整族缺失**（前端调用必失败；pybridge 注释「已有实现」为虚） | R46 只做了 Python | pybridge 移植 list/search/delete/open_dir（同一磁盘真相源）+ registry 注册 + 签名表 |
| D1 | **guard 矩阵局部漂移**：Node OP_GRANT_SCOPES 缺 open_url；OP_LABELS 两侧缺 browser_snapshot | R41/R43 增量未同步 | 补键（Node OP_LABELS 全量 19 op） |
| A7 | toolValidateResult web_search 死分支 | provider 级工具不经 executeTool | 删除 |
| E2 | **MCP 输出两侧均无 provenance 包裹**（外部服务器文本直入上下文，红线 4 之外最大未裹面） | R44 预筛只做标注型 | Python tag_payload(channel='mcp') + Node untrusted+source（纯增键） |
| 注释 | pybridge 头注释自相矛盾 / webdav_status 幽灵名 / guard.js 17→19 / registry 51→50 / state.js 切会话清空残留文案 | — | 全部诚实化 |

## 2. 功能开关中心（用户需求③）

**元缺口**（盘点 #9）：`glm_feat_*` 功能分级键此前**无任何 UI 写点**——用户不可见、关了开不回来。修复：

- 新模块 `frontend/src/settings/features.js`（116th 模块）：设置面板「功能开关」块，8 个 localStorage 键 checkbox + 2 个后端语义开关（混合路由→`hybrid_save_config({enabled})` 一闸两控 + 面板挂载键；记忆注入→`model_prefs_save({memory_inject})`）。
- **四门独立**（run-controller loadBackendTools）：搜索（browser_search 本体）/ 驱动（七原语）/ 软件 / 记忆四门拆分——原 browser_* 全族误绑搜索开关；includeAgent 判定 `(featSearch||featSoftware||featBrowser||featMemory)` 修记忆误挂（G2）；MCP 总闸走 build_tools include_mcp 入参（G6，零 js_api 变更）。
- 后端 gate：`hybrid.json.enabled`（hybrid_router route() 直通云端；_field_valid 补 bool；键缺省 True=既有行为不变）；`model_prefs.memory_inject`（_memory_inject 门；Python/Node 两侧规格同步）。
- 消费点接线：NOTES 注入+落盘（G8）、群聊摘要回传（G9）、自动续跑两处（G10 length 续跑 + 断线续跑）。
- **裁决不设开关**（盘点留档）：记忆检索算法参数（G7）、ui_nudge（G11）、take_screenshot 功能开关（已有 guard 档位，G12）、并行 run 上限（R31 裁定，G13）、通知中心（dnd 档已覆盖，G14）、provenance/护栏（安全特性常开，G15）。

## 3. 测试基建变化

1. `tests/test_frontend_tree.py` EXPECTED_ORDER +features.js（116 冻结序）。
2. `test_three_input_types` 空输入保底集 +memory_search/mcp_search（排序断言）。
3. `test_v18_software_hybrid` hybrid 默认字典 +enabled。
4. `round6 项2` 断言反转（clear()==0——新语义防回归）。
5. 新 `tests/test_r57_conflicts.py` 19 测试：Node 工具面增量/三段式/strict/GLM 过滤、pybridge mcp_search+群文件形态、Node guard 矩阵与 Python DEFAULT_TIERS 深比对、**三端去重键 12 变体逐字一致**（node 实测 grab+eval 移植函数）、append_memory 检索可达、switchSession 零 clear、MCP provenance 两链、四门独立+消费点接线。
6. 语义教训：`test_node_matches_python` 的 grab+eval 移植断言——**模块内同名 const 遮蔽 eval 注入的全局**（必须经 globalThis 调用）；shell 包装层吃反斜杠（连 quoted heredoc）——正则密集内容一律 Write/Edit 工具直写。

## 4. 裁决留档

1. **A1 单源化不做**：Node buildTools 保持独立硬拷贝（单源需 Node 拉 Python 面，跨进程成本>收益）；以差分测试锁定对齐（本轮起有 Node 面 parity 测试）。
2. **append_memory 描述回退**：legacy 内置工具族受逐字节差分锁定（test_build_tools_byte_identical 族），描述改动必须走锚点轮+双链同步——A3 目标由路由域+bypass 达成。
3. 沙箱/pool/缓存语义（R56 F8）不变。

## 5. 遗留

- 45+2 笔提交待推送（R26→R57）；安装包重打（落后 16 轮）。
- pybridge mcp_search 与 Python search_tools 的**词元打分口径**已同构但 Python 侧含 used 去重命名——Node 版 fnname 无 alias 表（单机量级影响≈0，留档）。
- R58（进行中）：会话对话逻辑优化（回退/重编辑重发）+ 生成式 UI 迭代。

## 6. 提交

```
feat(R57): agent 冲突收口——Node 工具面对齐（memory 工具族/snapshot/MCP 折叠/三段式）+ append_memory 键名断链修复 + 去重键三端 H3 对齐（12 变体断言）+ 切会话信任清空残留移除 + mcp_search/群文件族 Node 补建 + MCP 输出 provenance 两链 + guard 矩阵补键 + 功能开关中心（四门独立+hybrid/记忆注入后端 gate）；锚点 r57；pytest 2042 绿
```
