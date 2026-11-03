# UI/全码 30 轮扫描修复记账簿

- 发起:主理人 2026-11-03(「30 轮全代码扫描」:每轮=全代码扫一次→找出问题→全部修复→算一轮→下一轮)
- 问题域定义(主理人口径):不只是 bug,还包括「没有达到 agent 应该实现的效果」、用户体验、UI(文字对齐、图标)
- 质量门(每轮收口必过):前端 5 测试组全绿;构建幂等;契约面零翻转(涉后端时跑 diff:all);真机 CDP 抽验

## Round 0(基线,2026-11-03)

- 已知问题入库:
  1. 生成式UI未在并行后台完成时触发(所有权门 bug)——**已修**(run-controller finally 移出门外+chat-auto 待渲染队列+switchSession 兜底),随 Round 1 提交
  2. 文字对齐问题(用户报,具体位置待扫描定位)
  3. 应用图标丑(用户报,现为 PIL 手绘锚标 assets/harbor.ico)
- 测试基线:前端 5 组 83/83;build:all 幂等;Node/Python 基线不动

## Round 1(完成,2026-11-03,提交 e459eab/远端 8585c0d)

- 扫描:E UX链路域 agent 完成(10 发现全实证);A/C/D 域因账号并发上限改主会话自扫;主理人点名三项全部入轮
- 修复(13 项):
  1. 生成式UI触发链三连修(所有权门/待渲染队列/switchSession 兜底)——真机「没有出现」根因
  2. 生成视图持久化(uiSpec 写回消息+renderChatHistory 重建)——重启/切换不再丢失
  3. 图标 v2(4x 超采样/渐变/高光/投影)
  4~13. UX 十项:引导 Key 实时同步/向导落点收齐/生成式UI文案对齐/空态引导保留/
     /plan 可发现性/生成中轻提示/版本号残留/过时 Key 指引/开发者文案外露/
     视图条「不再自动生成」就地开关
- 门禁:前端 5 组 83/83;build 幂等;真机 E2E(blocks=7/stats=9/checklist=15)
- 经验:E 域 agent 扫描质量高(10/10 实证零误报);并行 agent 会撞账号并发上限
  ——Round 2 起改串行

## Round 2(完成,2026-11-03,提交 41c41fc/远端 1733997)

- 扫描:A UI视觉深扫 agent 完成(15 发现,行号级实证);C/D 域留待 Round 3
- 修复(15 项全修):
  - [2]high AI 消息三锚点对齐(正文/操作条/时间戳同轴——「文字没对齐」主源)
  - [1]high 浅色代码块残留淡彩高亮不可读+复制钮隐形→令牌色
  - [3]high 流式/重载 Markdown DOM 双标→addMessage 统一 .md-body 包装
  - [4]~[15] med/low 12 项:计划卡杂种样式/mono 中文行/空态引导居中/岛层级倒挂/
    状态点令牌化/隐形操作条脱流+防误触/按钮高度/时间戳锚点/描边统一 1.75/
    设置列居中/并行按钮触控目标/岛内联样式入表
- 附带:生成式UI 密钥链路根治(uiEndpointSnapshot 中心化,五调用方注入;
  修复 controller 内联快照 apiKey 恒空 → AI生成 401 从未可用的暗病)
- 门禁:前端 5 组 83/83;build 幂等;CDP 直证 StatTile 挂载+密钥快照

## Round 3+(待续)

## Round 3(完成,2026-11-03,提交 2ccf344/远端 38b2dfc)

- 扫描:联动深审(主会话逐项实证)——服务端保存链 .passthrough()/payload 原文存储
  → uiSpec round-trip 完整存活;enhanceCodeBlocks 后代查询 → .md-body 包装透明;
  并行双 generateUiSpec 控制器独立无冲突
- 升级(生成式UI):
  1. 低危动作接线 copy/export/refresh(userGesture 门+permission 链,计划卡同口径)
  2. refresh=同答案强制重生成(force 通道)
  3. Checklist 可点击打卡(渲染器级视图态)+宿主层委托持久化写回 message.uiSpec
- 真机验证(CDP 确定性注入):挂载→打卡→checkedCount=1→双向=0,全链通
- 门禁:前端 5 组 83/83
- 遗留:sequentialthinking 滥用的提示词节制(差分面影响待评估,主理人可先在
  MCP 设置禁用该服务器)

## Round 4+(待续)

候选扫描域:D 漏洞域深扫(新代码面)、B Agent效果复扫(节制指导落地后)、
C 前端功能正确性、计划工具入工具面评估(主理人裁定项)

## Round 4（2026-11-03）：生成式UI 交互真机实证域

> 主理人反馈：「切换会话视图还在这里、点框框无反应只会变个色、要又快又有质量」。
> 纪律：每条先隔离 profile + CDP 复现 → 定位真因 → 修 → 再测同一路径。

| # | 问题（真机复现） | 真因 | 修复 | 实证 |
|---|---|---|---|---|
| 4-1 | 切会话后旧视图跟到新会话 | switchSession 只重建目标历史，不清理容器内残留宿主 | 渲染前摘掉 chatContainer 内全部 `.ui-chat-host` | 塞残留后切换 → hosts 0 |
| 4-2 | 切回来视图消失 | 模型 spec **先**持久化再判优劣，1 块 TextBlock 盖掉本地 6 块视图 | 先算 richEnough，仅更优时持久化 | 持久化 spec = 3×SectionHeader+StatTile |
| 4-3 | 点框框只变颜色 | 只读块有 hover 位移/描边（被读成按钮）；视图无任何真按钮 | 取消 hover 假态 + cursor:default；标题条加复制/导出 | moved=false / cursor=default；toast 可见 |
| 4-4 | 打卡重启后丢失 | uiSpec 只改消息内部 → 撞上保存「未变更短路」整跳 | `_uiSpecRev` 进 `_sessionSaveSignature`，全部写路径打脏；修委托拿不到 message | 打卡→重启→1/3 仍在 |
| 4-5 | 分节标题挤左栏、卡片甩右栏 | card-grid auto-fit 把整幅块拆两列 | ≥2 张 Card 才 card-grid；CSS `grid-column:1/-1`；提示词补硬约束 | 截图：标题通栏、KPI 三卡并排 |

连带（平衡「快」与「质量」）：
- 质量闸 rich/seed/none：单块 TextBlock 不挂空壳视图；>1200 字无结构正文交模型
- 低质 spec → 「✦ 生成视图」小按钮（可点重转），不静默
- 启发式重写：按原文分节保序；KPI 语义闸（短量词才算指标，叙述留可打卡清单）
- minChars 240→120（结构化短答不再被长度闸误杀）
- 模型转换改**离屏**暂存容器，中断无残留节点

门禁：99 模块 / 25883 行；生成式 6 组 + 会话状态组 91+8 全绿；commit `9ef8943` 已推送。
遗留测试修正：并行默认化后「另一个会话正在运行」拦截已移除，用例改守新语义（不拦截、放行到输入读取）。

## Round 5(完成,2026-11-03,提交 8330cb8/已推送)

- 扫描:D 漏洞域 + C 前端功能正确性域(主会话自扫;并行 agent 撞 TPM 上限,
  Round 1 经验重申:扫描类一律串行)
- D 域结论:无高危。前端 innerHTML 全 sink 过 escape/常量;服务端执行面
  (commands/update/dpapi/software/jail/logger/preload)逐面复核 CLEAN。
  加固备忘:①browser 路由守卫 DNS TOCTOU(legacy 同口径)②回环服务无 Host
  白名单(动态端口+JSON-only 已缓解)
- C 域修复(3 处实证):
  1. [high] chat-auto 调用被 Round 4 重构包回 ownedFinish 门内(括号深度实证)
     → 并行后台视图再次静默跳过(P0-4 原 bug 复活)——移回门外
  2. [med] switchSession 补渲染在历史重建前执行 → 挂进将销毁的旧 DOM——
     移到两分支 renderChatHistory 之后
  3. [med] mini 提示抽共用 chatAutoShowMiniHint + provides 同步
- 误报排除:AppState 门面绑定同一顶层 let(非双状态树)
- 真机:pending 入队→动画切回→新 DOM 挂载(hosts=1/checks=4)→持久化重建
- 门禁:前端 13 组 92/92;build 幂等

## Round 6+(待续)
- 候选:B Agent 效果域(工具描述三段式 lint/sequentialthinking 节制)、
  UI 图标域(应用图标 v3)、D 域两条加固备忘落地评估

## Round 6(完成,2026-11-03,提交见 git log/已推送)

- 扫描:B Agent 效果域(工具描述三段式 lint 实跑+系统提示词引导面审计)
- 修复:
  1. v1.8 三 Agent 工具描述补齐三段式(browser_search/browser_open/software_call
     ——0 竖线违规,描述退化=模型选错工具根因面);lint 从 v19 子集扩到
     AGENT_TOOLS 全量(AGENTS.md §3 原口径)
  2. 契约复核:默认路径逐字节差分零翻转;内置工具族受 legacy 锁定无法三段式化
     ——AGENTS.md「已应用于既有工具族」与差分红线固有张力,以 CI lint 口径为准
- 误报排除:提示词 manifest「漂移」= 二进制读假象,loader 文本模式与 manifest
  口径一致,15 文件 round-trip 全部可追溯
- 门禁:合并 10 组 217/217

## Round 7+(待续)
- 候选:图标 v3、D 域两条加固落地评估、C 域续扫(attachments/settings 深 处)、
  sequentialthinking 节制(差分面待评估,可先 MCP 设置禁用)

## Round 7(完成,2026-11-04,提交 7a223ec/已推送)

- 扫描:深层次+功能层面双域(主理人点名)。功能面=54 内联 handler 全量接线
  核对(0 死按钮);深层面=主会话持久化链深扫 + 串行 agent 深审 planning/card
  +chat 主路径+expert/collaboration+mcp-panel(7 发现全实证)
- 修复(8 项,2 high/3 med/3 low):
  1. [high] 双源合并平局取截断镜像→重启丢正文(改 backend 优先)
  2. [high] planFinish 终态不复位 status→每次对话重放收尾(终态写回+防重入)
  3. [med] 保存签名漏 expert.events→纯事件轮重启丢日志(签名加维度)
  4. [med] 批准 60s 窗口无重入守卫→任务被静默吞(忙则复位计划态)
  5. [med] 切会话悬挂批准 Promise(planTeardownPendingApproval)
  6. [low] 自定义模型点击置空 modelSelect(注入 option)
  7. [low] MCP busy 单槽并发清零(持有者校验)
  8. [low] 设置跳转已开反关(先判 show)
- 误报排除:session 顶层字段全量 grep→maxTurns/lastRunId 为 this. 误匹配
- agent CLEAN:expert/collaboration 控制器、attachments、planning 澄清表单
- 门禁:8 组 289/289;CDP 三项实证;manifest 同步

## Round 8+(待续)
- 候选:图标 v3、D 域加固落地、sequentialthinking 节制、后端 routes 深扫

## Round 8(完成,2026-11-04,已推送)

- 扫描:主理人点名三线——功能正确性验证/提示词按 Agent 实际功能瘦身/UI 重构
- 提示词:消费链穷举(15→5),10 个零消费者删除(reflect/validate/understand/
  plan-generate/browser-*四件/system-local/system-sandbox);efficiency 删
  GitHub Models 硬编码段(端点无关化),回落常量两端逐字节同步;reader-extract
  安全规格回归保留
- UI 重构:删 main-nav 重复层(杂乱主源);低频工具收进「工具箱」二级弹出菜单
  (分析/审计/搜索/沙箱);rail 11→9;删 header 静态徽标;引导文案更新
- CDP:结构/工具箱路由/Esc 收起全过;截图复核排版达标
- 门禁:13 组 391+8 全绿

## Round 9+(待续)
- 候选:图标 v3、D 域加固、sequentialthinking 节制、后端 routes 深扫

## Round 9(完成,2026-11-04,提交 64e0cc1/已推送)

- 立项(主理人):群聊协作 Beta——新建页入口→群主配置 N 个大模型成员(模型+身份
  +主持人)→独立上下文+交接文档接力→自动续跑可暂停;本地大模型优化;打包 exe
- 交付:
  1. group.js 新模块:向导(软件开发团队预设)/群工具条/调度(交接给:X 两步
     匹配,匹配自己回主持人)/24 轮防失控自动暂停/隔离上下文(群主任务+指名
     消息+最近2份交接+自身历史)
  2. 本地大模型:本地端点 keep_alive 10m(接力间隙不卸载)+503 退避×3 既有+
     调度天然串行(本地并发互踩消除)
  3. 打包:dist-electron/Harbor-Setup-1.9.0.exe(NSIS 215MB,含全部修复)
- 自审去除无效设计:每成员独立端点覆盖/图片生成依赖/手动模式开关;
  修复:暂停不 abort 在途请求、groupAdvance 未定义、死代码两处
- 验证(CDP fake-model):建群→下发→主持人→UI设计接力→24轮上限自动暂停→
  持久化 round-trip;暂停=abort 生效/恢复续跑;错误路径(401)→失败消息+
  暂停+可恢复
- 门禁:10 组 308 绿;manifest 100 模块(计数门禁随更)

## Round 10+(待续)
- 候选:群聊真实多模型实测反馈、图标 v3、D 域加固、sequentialthinking 节制

## Round 10(完成,2026-11-04,提交 ac1832b/已推送)

- 立项(主理人):群聊 v2——工作气泡(简略态/点击展开)+群聊感知(@交流/自由
  讨论/可反驳)+界面与气泡精雕+生成式 UI 进一步升级
- 交付:
  1. 工作气泡 gwb:成员色环(稳定 hue)+玻璃拟态;working=呼吸点+实时字数,
     群里永不直接铺全文;done=摘要行(剔除交接段)+平滑展开全文;历史重建
     同形态
  2. 交接文档生成式卡(生成式 UI 升级):展开区内【交接文档】解析为键值卡,
     交接对象高亮,零模型调用
  3. 群聊感知上下文:身份声明+全员名册+交流规则(@/可反驳有理有据/不越职/
     群主唯一决策)+群流简略视图(他人 300 字/自己全文)
  4. 路由升级:@成员名优先于「交接给」;vm 直测路由矩阵 5/5
- 验证:CDP(working→done 生命周期/24 轮上限自动暂停/交接卡 24/24/名册与
  反驳规则全注入/摘要干净)+截图复核视觉达标
- 门禁:10 组 308 绿;安装包重打包(Harbor-Setup-1.9.0.exe 含气泡版)

## Round 11+(待续)
- 候选:群聊 v2 真机实测反馈、图标 v3、D 域加固
