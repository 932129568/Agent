# HANDOVER-R62 — 群聊协作真机反馈轮（接力顺序 / 群文件 / 工具链 / 弹窗重设计 / 专家生效）

> 日期：2026-11-10。接续 `HANDOVER-R61.md`。本文自包含，接手者无需阅读历史对话。
> 项目：Harbor / GLM-Chat v1.9.0。生产链为 **Electron 主进程 + server/ Node 服务 + 单文件 `harbor.html`**。
> 用户约定：交付可运行且已验证的结果；逐项排查直到可用；既有资产只增不删；**不得主动启动 exe**，真机截图由用户提供。

---

## 0. 一眼总览

| 维度 | 当前状态 |
|---|---|
| 源码 | R61 已提交（`3453ee4`）；**本轮 R62 改动未提交**，接手者先看 §7 提交建议 |
| 全量回归 | 第一轮（群聊改动后）：2056 passed / 1 failed（棘轮误报，已修）；**修复后最终轮见 §6** |
| 契约基线 | `contract-baseline-r62.json` 已生成并随改动刷新（群聊符号 + 专家修复） |
| 依赖棘轮 | **R62 修正基线 157 条**（原 88 条为坏扫描器漏计数；详见 §4.6） |
| 新增测试 | `server/test/group-files.mjs` 10 项 PASS + `test:groupfiles` 脚本 |
| 安装包 | `dist-electron/Harbor-Setup-1.9.0.exe`（226,708,329 B，sha256 `13571a1a…fcfca8`），asar 内 R62 标记全命中 |
| 版本 | `VERSION=1.9.0`；`API_VERSION='v1.0.0'`（契约，不可动） |
| 真机 | **尚未由用户确认**，需重装并重启应用后按 §8 复验 |

本轮五个问题全部来自用户 2026-11-09/10 真机截图与反馈：

---

## 1. 用户反馈与根因（全部实证，非推测）

| # | 用户反馈（截图） | 根因（实证方式） | 修复 |
|---|---|---|---|
| 1 | 图1：交接顺序错乱——主持人后**前端先发言且自称「作为UI设计」**，UI设计反而去做实现（@自己「@UI设计 收到…」） | `groupNextMember` 自由路由：取正文**最后一个 @**/交接给 定下一棒。主持人一条规划 @ 多人时最后 @ 的先说，且成员看到全量任务清单会揽错活 | **名册顺序确定性接力**（§3.1） |
| 2 | 图2：群文件面板永远空 | `group_files_write` **从未注册到 Node registry**（R57 C3 只移植了读侧四方法；pybridge 注释自述「写入仍走 Python 链」——生产链无 Python）。前端归档 catch 吞错。`group_files_read` 同样缺（点开文件必失败）。探针实测：jsapi 返回 `NOT_MIGRATED` | pybridge 补移植 write/read + registry 注册（§3.2） |
| 3 | 图3/图4：成员工具反复调用失败（主持人 7 段重复意图 = 6 轮工具全败 + 正文累积） | 群会话**未绑工作区**：`runtime.sessionWs` 空 → 文件工具回落 server cwd（真机 = 安装目录），模型想建的任何合理路径都在监狱外 → 「路径越界」×N 重试循环；模型不知情 | 工作目录绑定 + 上下文预先告知 + 同错误熔断（§3.3） |
| 4 | 图5：群聊协作弹窗简陋 | 三个叠加问题：行距挤/层级平；`.gw-mate-row{display:flex}` **压过 `[hidden]`** → 跨端点 Key 行在普通成员上常显（图5 可见）；首次打开从不加 `.show`（第一击不可见） | CSS 重写 + 三个缺陷顺修（§3.4） |
| 5 | 「专家启用发出没有启用」 | **空会话态选专家，pick 挂在 `''` 键**：`newSession()` 置空 sid → `hubPick` 存 `picks['']` → 发送时 `ensureSession()` 才生成真 sid → `hubDirectiveFor()` 按新键查空 → 角色指令静默丢失。专家中心一次性选择态有同类问题（跨会话静默吞 send / 空 sid 幽灵会话） | 键迁移 + 会话先建 + 显式报错（§3.5） |

---

## 2. 快速档案：改动文件清单

**前端源码**
| 文件 | 改动 |
|---|---|
| `frontend/src/group/group.js` | 接力路由重写（groupNextMember/groupNextInRoster）、链尾交还群主、上下文模板重写（接力规则+工作目录+轮次告知）、自@回声剥离、同错误熔断、向导/管理弹窗重构（工作目录行+↑↓+事件委托）、toolbar 工作目录 chip、首次打开 `.show` 修复 |
| `frontend/src/sessions/store.js` | `normalizeSessions` 群白名单加 `group.wsRoot`（跨重启保留） |
| `frontend/src/shell/composer-hub.js` | `hubDirectiveFor`/`hubRenderChip` 空会话键迁移 |
| `frontend/src/chat/send.js` | 专家分支先 `ensureSession()`（消灭空 sid 幽灵会话） |
| `frontend/src/expert/center.js` | 空会话选择跟随新会话；跨会话切换显式 toast（原静默吞） |
| `frontend/styles/legacy.css` | gw-* 全套重写（卡片化/吸顶吸底/中性色）+ `.gb-ws` chip + `[hidden]` 压制修复 |
| `frontend/manifest.json` | group.js provides +5（groupBindWsRow/groupBindRowActions/groupMemberMove/groupRenumbers/groupNextInRoster） |
| 产物 | `harbor.html`、`frontend/react/dist/harbor-island.iife.js`（构建产物，随源码提交） |

**服务端**
| 文件 | 改动 |
|---|---|
| `server/src/services/pybridge.js` | `groupFilesWrite`/`groupFilesRead` 补移植（write 头部元信息/同秒序号/`_index.json` upsert；read root 监狱+utf8/gbk）；`_gfGroupDir` 哈希对齐 Python（`g<digest*131%10^10>`，原 `g_<base36>` 两链不同盘） |
| `server/src/registry.js` | 注册 `group_files_write`/`group_files_read`（参数名 `path` 对齐 legacy——contract-signatures 门禁） |
| `server/test/group-files.mjs` | **新增** 10 项回归（走 fastify inject 真路由） |
| `server/package.json` | `test:groupfiles` 脚本 |

**工具与测试基建**
| 文件 | 改动 |
|---|---|
| `tools/gen_allowlist.mjs` | **剥离器重写为单遍词法扫描**（§4.6） |
| `frontend/deps-allowlist.json` | 重生成：88 → **157** 条（全部为真实存在但被旧扫描器漏计的边，零删除） |
| `tests/test_r59_deps.py` | 棘轮上限 88 → 157 + 缘由注释 |
| `tests/test_group_unlimited_relay.py` | 旧「自由路由无限链」测试按 R62 语义重写（名册链/边界暂停/busy 守卫） |
| `tests/test_group_mention.py` | 2 处断言更新（队列耗尽后按名册收尾） |
| `deliverables/dev-plan/contract-baseline-r62.json` | **新增**契约锚点 |

---

## 3. 各修复的设计与权衡

### 3.1 接力顺序 = 名册顺序（问题①核心）
- `groupNextMember`：先判 `@群主`/`交接给: 群主`（**保留**的唯一成员侧出口——要人类拍板），否则 `groupNextInRoster`。
- `groupNextInRoster`：主持人=链头 → 名册第一位非主持；成员 → 自己之后下一位非主持；末位 → null。
- 链尾（null）语义变更：不再报「没有明确交接对象」，改为 **「本轮接力完成，交还群主」+ `g.turn` 复位主持人**（继续接力=主持人规划下一轮，与用户描述的循环一致）。
- 群主显式 @（mentionQueue）仍优先——点名顺序即发言顺序（Round 15b 语义保留）；队列耗尽后落回名册接力。
- 成员上下文模板同步重写：名册即接力顺序、告知下一位是谁、@ 只用于对话不改变顺序、交接文档「交接给」字段=名册下一位（用于归档核对而非路由）。
- `groupStripEcho` 增剥**自@回声**（`@UI设计 收到…`），@他人保留。
- 取舍：成员互相 @ 讨论/反驳的能力让位于确定性（用户明确点名要顺序）；@对方指出问题的消息仍会在对方下一轮上下文里可见（规则 2 已注明）。

### 3.2 群文件写/读链（问题②）
- 忠实移植 `group_files_service.py:write/read`：文件名 `时间_成员_主题.md`、同秒同名 `-N` 序号绝不覆盖、`<!-- harbor-group-file -->` 头部元信息（检索加权数据源）、`_index.json` upsert（name 去重+mtime 排序+截尾 200）。
- **目录哈希对齐 Python**（`digest*131 % 10^10` → `g<digest>`）：R57 的 `g_<base36>` 与 Python 链不同盘、违反其自述「共享同一磁盘真相源」；Node 写侧落地时统一（生产无 Python，无迁移负担；真机 group_files 目录从未生成，无历史数据）。
- registry 参数名对齐：`group_files_read(path)`——contract-signatures 门禁比对 legacy 签名（首轮用 `p` 被拦，已改）。
- 前端零改动（files.js 本来就调 `group_files_write/read`——调用点 R57 就写好了，后端缺方法而已）。

### 3.3 群聊工作目录 + 工具熔断（问题③）
- 向导新增「工作目录」行（可浏览；建议填写）；`groupCreate` 存 `s.group.wsRoot` + `set_session_ws(sid, dir, true)` 绑后端 per-sid 工作区；管理弹窗可改绑/解绑（换绑 `set_session_ws`、清空 `delete_session_ws`）。
- `normalizeSessions` 群白名单加 `wsRoot`（丢失则管理弹窗显示未绑定、上下文口径与后端脱节）。
- 工具栏新增工作目录 chip（绑定=实线+目录名；未绑定=虚线「未绑定」，tooltip 说明后果）。
- 上下文注入（关键）：绑定时「唯一可读写位置=该目录，其它路径会被拒，勿换路径重试」；未绑定时「文件工具会报路径越界，**不要反复重试工具**，直接正文产出或 @群主 绑定」。
- **同错误熔断**：整轮工具结果全错且错误签名与上轮相同 → streak；streak=2 注入止损指令（「不要再重试，直接完成发言与交接文档」）；streak≥4 硬停保正文。maxRounds=6 不变。
- 权衡：未绑定时没有强制禁掉文件工具（保持 schema 同源简单），靠上下文预先告知+熔断兜底——模型知情后一次都不会撞墙。

### 3.4 弹窗重设计（问题④）
- gw-* 全套重写：760px 卡片窗、吸顶头/吸底脚、成员卡片（序号徽标+名字+主持人单选+↑↓✕）、行网格对齐（label 52px）、中性色（无装饰性彩色，尊重 R61b「不要强调色」）、focus 环、入场动画。
- **顺修三个真缺陷**：①`.gw-mate-row[hidden]{display:none}`（flex 压过 hidden，Key 行常显）；②首次打开加 `.show`（原来第一击不可见）；③向导 `groupMemberAdd` 从不绑定事件（新行选跨端点模型不露 Key 行、测试钮死）——两个幂等 binder 补挂。
- **删错行隐患**：向导 ✕ 原用 `onclick="groupMemberDel(idx)"` 内嵌索引，删一行后其余按钮索引全陈旧（会删错行/越界）——改事件委托（`data-idx` 活读取）。↑↓ 同委托；管理弹窗走数组语义（syncDomToMembers→换位→render，成员 id 稳定）。
- 主持人单选钮按弹窗分名（`gwHostwiz`/`gwHostmgr`），防两弹窗同开互扰。
- 顺带：浏览器实证（静态 serve harbor.html + evaluate `groupWizardOpen()`）——首开即显、Key 行隐藏、卡片渲染全部确认。

### 3.5 专家生效链（问题⑤）
- `hubDirectiveFor`/`hubRenderChip`：读不到当前会话 pick 时检查 `picks['']`（空会话态选择），**迁移**到当前会话键并生效（角色本就按会话持续至手动退出，语义不变）。
- `send.js` 专家分支先 `ensureSession()`：消灭「带着 sessionId='' 跑专家 run」——原实现会把幽灵空 id 会话 push 进 sessions 列表，且 run 落不到任何可见会话。
- `runExpertSelection`：选择时会话为空（''）→ 跟随新会话；真实会话间切换 → 显式 toast+status（**原先静默 return，send 被吞、输入框无任何反馈**）。
- 功能市场「启用」与「+菜单选中」是两步（启用=出现在菜单，选中=生效）——本轮不改该产品语义，只修选中后丢失的链路。

### 3.6 依赖棘轮扫描器重写（R62 基建债，被问题①修复连带引爆）
- `gen_allowlist.mjs` 原剥离器 = 三条字符串正则**各自独立**全局替换 + 完全不识别正则字面量。group.js 的 `@[^\s@…"']{1,12}` 正则**内含引号**，配对错位吞掉不同代码区——**同一文件的边集合随无关编辑漂移**（HEAD 漏 groupArchiveHandoff/groupHydrateEndpoints、改动后漏另外 5 个，实证 diff 见 git）。R58 记忆里「模板字符串嵌反引号破坏符号扫描器」是同一族坑。
- 重写为单遍词法扫描：注释/字符串/模板（`${}` 内递归按代码、regexAllowed 上下文共享）/正则字面量（`[字符类]` 中 `/` 不终止；prev-token + 关键字表消歧除法）。`uiSeamCall` 不计边（缝原语语义保持）。
- 重生成清单 88 → **157 条**：新增 69 条全部为真实存在但被漏计的边（逐条人工复核：tool-executor→guard、run-controller→features、composer-hub→toast 等），**零删除**；`test_r59_deps` 上限同步 157 + 缘由注释。棘轮口径（只减不增）自此对真实集合生效。
- 教训入档：**「只减不增」棘轮必须建立在确定性扫描之上**，否则基线本身是漂移的。

---

## 4. 前端构建与门禁（本轮实际执行口径）

```bash
PY="C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
NODE="C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
cd "C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包"

# 产物（改前端源码后必跑）
cd frontend/react && "$NODE" build.mjs && cd ../..
"$NODE" frontend/build.js

# 1) UI 契约
"$PY" deliverables/design/check_contract.py          # PASS（40 id/13 onclick/43 callApi/39 类/21 变量）
# 2) 契约差分
"$PY" tools/contract_diff.py --compare deliverables/dev-plan/contract-baseline-r62.json   # 零漂移
# 3) 依赖棘轮（修正基线 157 条）
"$NODE" tools/gen_allowlist.mjs --check
# 4) server 测试
cd server && "$NODE" test/group-files.mjs && "$NODE" test/local-proxy.mjs && \
  "$NODE" test/contract-coverage.mjs && "$NODE" test/contract-signatures.mjs && \
  "$NODE" test/r55-pybridge.mjs && "$NODE" test/smoke.mjs && cd ..
# 5) 全量
"$PY" -m pytest tests/ -q
```

> 提醒：`pytest -q`（不带路径）会误收 `deliverables/wave-backups/` 产生 377 个 collection error——必须 `pytest tests/ -q`。

---

## 5. 打包（离线法，复现于本轮）

```
mv dist-electron/Harbor-Setup-1.9.0.exe dist-electron/Harbor-Setup-1.9.0-R61-backup.exe
PATH="/c/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6:$PATH" \
  npx --no-install electron-builder --win nsis --config "$TEMP/harbor-builder-offline.yml"
```
- R61 的 `%TEMP%/harbor-builder-offline.yml` 仍在（= 工程 `electron-builder.yml` + `electronDist` 指向本地 node_modules/electron/dist）；正式配置零改动。
- 产物核验：sha256 `13571a1ad4208d3f77cd8dba1ba7332a10747cd0237f4ed898dcb4d309fcfca8`（226,708,329 B）；asar 流式搜索 R62 标记（`group_files_write`/`groupFilesWrite`/`名册顺序确定性接力`/`gw-wsrow`/`hubDirectiveFor`/`始终用`）全部命中。
- 旧 R61 包保留为 `Harbor-Setup-1.9.0-R61-backup.exe`（safe-delete 钩子拦删除，用 mv 改名）。

---

## 6. 验证结果汇总（本轮实测）

| 门禁 | 结果 |
|---|---|
| server `test/group-files.mjs`（新增） | **10/10 PASS**（write 落盘/头部元信息/Python 目录哈希/同秒序号/list 双通道/search 命中/read 全文/监狱拒/空内容拒/delete 摘除） |
| server `contract-coverage` | ok：migrated 163（+2）/ not_migrated 4 / **ghosts 0** |
| server `contract-signatures` | ok：163 checked / 0 mismatch（首轮 `p` 命名被拦已改 `path`） |
| server `local-proxy` / `r55-pybridge` / `smoke` | PASS（R61 回归不劣化） |
| 前端 vm 行为验证（群聊） | **8/8**：名册链顺序/@ 不劫持/@群主出口/自@剥离/上下文注入（绑定与未绑定）/wsRoot 白名单 |
| 前端 vm 行为验证（专家） | **4/4**：空会话 pick/发送迁移/同会话持续/无 pick 不误注入 |
| UI 契约 + 契约差分 + 依赖棘轮 | PASS / 零漂移（r62）/ 157 条通过 |
| 群聊相关 pytest（7 文件） | 60 passed（含 5 处按 R62 语义更新的断言） |
| 专家/市场相关 pytest（5 文件） | 33 passed |
| 全量 pytest | 第一轮 2056 passed/1 failed（棘轮误报）→ 扫描器修复后**最终轮见运行记录**（预期全绿） |
| 打包产物 | asar 标记全命中（见 §5） |

---

## 7. 提交建议（接手者第一步）

本轮改动**未提交**。建议单笔提交：
```
fix(R62): 群聊真机反馈轮——名册确定性接力/群文件写读链补移植/工作目录绑定与工具熔断/协作弹窗重设计/专家空会话生效链 + 依赖棘轮扫描器重写（157 条修正基线）
```
含：前端源码 7 文件 + 产物 2 + server 4 + tools 1 + tests 3 + 契约基线 1 + 本文档。

## 8. 真机复验清单（重装 + 重启后）

| # | 复验项 | 期望 |
|---|---|---|
| 1 | 功能市场启用专家 → +菜单点选 → 新建对话 → 发消息 | 回复带专家角色口吻；chip 显示且发送后不消失 |
| 2 | 专家中心选择专家（空会话态）→ 发送 | 专家 run 正常落在当前会话；不再静默无反应 |
| 3 | 群聊向导：填工作目录（选一个空文件夹）→ 创建 → 群主发任务 | 主持人→UI设计→前端→后端→测试 **严格按名册顺序**；链尾出「接力完成」系统消息 |
| 4 | 群成员工具调用 | 主持人检查目录/创建文件成功（落点=工作目录）；不再出现连续重复意图刷屏 |
| 5 | 不绑工作目录再建一群 | 成员正文明确说「未绑定工作目录，工具不可用」，**不重试工具**直接产出方案 |
| 6 | 群聊中查看群文件面板 | 每轮发言归档一份 `时间_成员_主题.md`；点开能看全文；搜索能命中 |
| 7 | 弹窗观感 | 成员卡片+序号+↑↓✕；普通成员**不显示**端点Key行；第一次点击即打开 |
| 8 | 工具栏 | 显示「📁 目录名」chip；未绑定群显示虚线「未绑定」 |

## 9. 遗留与风险

- **「启用」≠「选中」**的产品语义未改：功能市场启用只让条目出现在 + 菜单，还需点选。若用户期望「启用即生效」，需产品决策（可让启用后自动对当前会话生效）。
- 群文件目录哈希已对齐 Python：legacy pywebview 链与 Electron 链现在同盘同目录；两链数据互通（本轮实测仅 Node 链）。
- 熔断阈值（2 轮提示/4 轮硬停）是经验值；若真机发现模型仍刷屏可收紧到 2/3。
- 弹窗重设计未过用户眼——若嫌密度/字号不对，改 `frontend/styles/legacy.css` 的 gw-* 段即可（不动 JS）。
- gen_allowlist 词法扫描对「对象字面量后紧跟除法」这类极端语法仍按正则消歧（现实代码不存在该形态）；若未来误判，修复点在 `regexAllowed()`。
- R60/R61 遗留不变：推送中止 16 笔待续推（禁止 fetch+reset --soft）、macOS/性能基准/签名未做、R58 `render_ui/parentId` 分支树仍列 R63 候选。

> 事实与判断的区分：§1 根因、§6 数字为已复现实测；§3 的取舍与 §9 的风险为工程判断。
