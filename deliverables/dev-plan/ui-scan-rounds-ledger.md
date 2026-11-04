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

## Round 11(完成,2026-11-04,提交 6771291/已推送)

- 立项(主理人):长按成员名管理(改身份/模型/增删)+气泡点击进独立详情页
  (打开↔返回)+界面国际水准+安装器到桌面(装完即用+桌面快捷方式)
- 交付:
  1. 群聊管理面板:长按(500ms 鼠标/触屏同语义)工具条 chip 或气泡名字打开;
     成员卡即编辑器;修复「编辑期间重绘丢输入」(syncDomToMembers,CDP 实证);
     删除后 id 重排/主持人兜底/turn 校验
  2. 详情页:全屏独立页(返回钮/Esc/滚动锁/入场过渡),毛玻璃头部+阅读排版+
     交接生成式卡;原位展开移除,气泡整卡可点
  3. 安装器:createDesktopShortcut always+开始菜单(原显式关闭);oneClick
     runAfterFinish 装完即启;Electron 运行时/依赖树全内置零用户环境配置;
     exe 已复制到桌面
- 验证:CDP 全链(长按开面板→改名+增员→保存 3 成员/详情页 show/交接卡/
  返回/Esc/重复开关无泄漏)+截图复核
- 门禁:10 组 308 绿;v3 打包含全部修复

## Round 12(完成,2026-11-04,提交 7a83290/ccb393f/4a5f54d,已推送)

- 立项(主理人):群聊气泡「挤在中间」布局修复 + 安装器自定义文件夹 +
  **换机装完智谱免费模型必 429**(主理人断言:「就是你配置的问题」)
- 交付:
  1. 群聊气泡布局:历史重建消息加 group-msg 类,覆盖 `.message .content`
     的 max-width:76% + 20px 底距 → 全宽气泡 + 6px 间距;摘要行空白修复
     (done 态补 groupBriefOf);截图复核
  2. 安装器:oneClick=false + allowToChangeInstallationDirectory=true +
     perMachine=false → 向导式可选安装目录,装完自启,桌面/开始菜单快捷方式
  3. 免费模型 429 根因链(三重):
     a) 预设/兜底/价格表/模板静态下拉全是幽灵模型名(glm-5.3-flash 等,
        平台不存在 → 1211);智能档取「第一个 *flash 选项」也命中幽灵名
        → 全面换成 glm-4.5-flash / glm-4-flash / glm-4.5
     b) 免费档误发 reasoning_effort/thinking(flash 系不支持)→ 免费档剔除
     c) 免费档无节流:新增 paceFreeTier 全局串行 + 3.2s 最小间隔
     d) 429 退避:1 次/2 秒 → 3 次指数退避(4s/12s/30s,跨配额窗口)+
        遵循 Retry-After;余额/欠费类不重试直接报错
- 验证:node vm 假 fetch 实证(免费模型 hasEffort=false/hasThinking=false/
  waits=[3200];付费 glm-4.5 参数原样无等待;429 退避 calls=3 waits=[4000,12000]
  status=200)+asar 内 harbor.html 反查(幽灵 option 已清零)+全量门禁
- 门禁:全量 1762 绿 / 4 败为预存在测试漂移(git stash 对比实证:与本轮无关)
- 交付物:桌面 Harbor-Setup-1.9.0.exe(226,075,134 B,11:40 重打,
  sha256 da75ad1ae009a7a292b6e9bd7b7cf2c16025d04c0dbc314fdf4b9ef8cb388593)

## Round 13(完成,2026-11-04,提交 edb3792,已推送)

- 立项(主理人):取消群聊对话 24 轮限制,改为无限制(截图:「接力已达上限(24 轮),
  自动暂停交还群主」反复打断任务)
- 交付:
  1. GROUP_LIMITS.turnBudget 删除;唯一停手开关 = 群主「暂停接力」
  2. groupSpeak 递归 `await groupSpeak(s,next)` → while 迭代(不限轮后递归会
     持续加深调用栈,几百轮即 RangeError)
  3. groupSpeak._pausedSid:暂停置位后循环在下一轮边界立即退出(原仅靠 phase,
     插话/继续接力路径会重开循环)
  4. groupSpeak._busySid + try/finally:同会话只允许一条接力链,防并发双开
  5. 无交接对象提示语改为「接力暂停,交还群主」,不再谎称「已达上限」
- 验证:单测 4 项(60 轮不停/暂停即时/并发守卫/源码无 turnBudget 残留);
  打包后真机 CDP:41 轮无上限提示、暂停在第 3 轮立即生效、busy 正常释放
- 门禁:全量 1766 绿 / 4 败仍为预存在测试漂移(与本轮无关)
- 交付物:桌面 Harbor-Setup-1.9.0.exe(226,064,664 B,12:50,
  sha256 2c487557f8b0a9192cf5a8e4b3bb0ccc4f5b1f9779ce03450f9339276c9cf0aa)

## Round 15(完成,2026-11-04,提交 6e57824/2305e9e,已推送)

- 立项(主理人):@ 打字弹选择器/@ 多人只有最后一个响应/@ 顺序乱(先@的后
  说话)/模型不能跨服务商自由选/交接文档缩写看不清/要群文件功能(可自定义
  本地目录,名字清晰可检索)/glm-4.5 标「付费」但接不通(截图 1113)
- 交付:
  1. @选择器(mention.js):打 @ 弹成员候选(含群主),过滤/↑↓/Enter/Esc;
     capture 拦键防半截 @ 被发出;邮箱不误弹;非群聊零介入
  2. 多目标 @:groupMentionTargets 取全部被 @ 成员(最长名前缀/去重保序/
     无 id 兜底);Round 15b:显式队列 g._mentionQueue 优先于自由路由——
     先 @ 的先说话,队列耗尽才恢复模型自由接力;队列不受 autoRelay 开关限制
  3. 跨端点选模型(endpoints.js):成员下拉=全端点目录(当前/智谱/DeepSeek/
     …optgroup);'端点id::模型名' 按该端点 base_url+Key 发送(Key 成员行就地
     补填,只存群端点快照);缺 Key 明确报错;裸模型名兼容旧数据
  4. 群文件(backend/domains/workspace/group_files_service.py + files.js):
     交接文档每轮自动归档(时间_成员_主题.md+元信息头);write/list/search
     (关键词加权+命中片段);目录可自定义(group_files.json 独立配置);
     面板列表/搜索/换目录;上下文注入群文件索引
  5. 交接文档完整化:提示词禁「见上/同上/略」;交接卡去截断(原 8 行/300 字)
  6. 1113 人话:智谱欠费也报 1113(429 状态)——分流先于通用限流文案,
     给出路(换 glm-4.5-flash/glm-4-flash 或充值);glm-4.5 标签改「需余额/额度」
- 验证:群聊 4 套件 24 项绿(打字顺序保真/成员抢话被压制/单 @ 自由路由不
  回归/跨端点发送 URL+Key+model 逐项断言/缺 key 报错);真机 CDP 实测
  glm-4.5=1113 余额不足(非网络/配置)、1113 不重试立即交回;全量门禁
  1786 绿 / 4 败为预存在漂移
- 顺带修复:normalizeSystemMessages 裸引用 typeof 守卫(request.js/group.js)
- 记账补遗:Round 14(群聊工具循环+@群主交还+系统消息区分+回声剥离)因
  会话中断未及时落账,已并入本条;test_v12_features 1113 契约同步更新

## Round 15 优化批次(完成,2026-11-04/05,提交 6d9b175/2c2a9b0)

- 立项(主理人):「继续优化一下这些功能」「继续进一步优化升级」
- 交付(两批):
  批一(6d9b175):
  1. 持久化白名单补 group.endpoints+mentionQueue——根治重启后跨端点成员
     集体报「缺端点」、点名接力断档;localStorage 镜像投影层剥 api_key
     (W29 纪律不破:后端可存、镜像不落明文)
  2. 跨端点 Key 同址复用:成员端点=当前配置端点 → 直接用当前 Key
  3. 群文件面板「📂 打开」(group_files_open_dir,目录不存先建)+轮次展示
  4. @ 选择器前缀命中优先+色环头像(与气泡同源 groupHueOf);归档即时刷新
     工具栏计数
  批二(2c2a9b0):
  5. 群文件可删:group_files_delete(basename 归一+realpath 双保险锁群子目录)
     +面板 ✕(uiConfirm 确认)
  6. 成员行「测试」按钮:跨端点配置就地验证(端点+Key+模型一次实测)
  7. 工具栏 phase 显示点名队列「→ 测试→UI设计…」
  8. 详情页「⧉ 复制全文」三级降级(uiClipboard→navigator→set_clipboard)
  9. @ 选择器行内显示成员模型
- 门禁插曲:v18 幂等门禁拦下 manifest provides 漏登记(groupFilesDelete)——
  管道吞退出码所致,门禁有效性实证
- 验证:群聊 6 套件 31 项绿;构建幂等/树序/modern 复验 79 绿
- 交付物:桌面 Harbor-Setup-1.9.0.exe(00:12 批一版;批二版重打中)

## Round 16+(待续)
- 候选:真机实测反馈、图标 v3、D 域加固、4 项预存在失败测试对齐
