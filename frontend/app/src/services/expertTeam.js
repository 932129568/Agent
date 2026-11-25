/**
 * Harbor 原生多专家团队编排引擎（R25 重构：真正「开箱即用的完整专家团」，绝非让用户手动勾选拼凑）：
 * - 内置 12 支成建制多角色专业团队（含仓库 backend/experts_builtin/ 既有 5 支原生多 Agent 团队 + 7 支旗舰专业工作室）；
 * - 每支团队拥有固定主理总监 (Lead)、清晰分工角色链、既定 SOP 交付物与信箱交接顺序；
 * - 同时自动识别用户本机导入的多 Agent .codebuddy-plugin 团队包。
 */
import { streamChatCompletion } from './modelTransport.js'
import { isAbort } from './errors.js'

/** 安全提取文本（兼容 string 与 { zh, en } 多语言对象，彻底杜绝 React Error #31） */
export function safeExpertText(val, fallback = '') {
  if (val == null) return String(fallback || '')
  if (typeof val === 'string') return val.trim() || String(fallback || '')
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (typeof val === 'object') {
    const picked = val.zh || val['zh-CN'] || val.en || val.label || val.name || ''
    if (typeof picked === 'string' && picked.trim()) return picked.trim()
  }
  return String(fallback || '')
}

export const TEAM_CATEGORIES = Object.freeze([
  { id: 'all', label: '全部专家团' },
  { id: 'engineering', label: '软件与安全' },
  { id: 'design', label: '设计与产品' },
  { id: 'creative', label: '影视与游戏' },
  { id: 'business', label: '增长与投研' },
])

/** 12 支成建制原生专家团队（点击即直接派发任务，无需手动挑人） */
export const NATIVE_EXPERT_TEAMS = Object.freeze([
  {
    id: 'software-company',
    builtinDir: 'backend/experts_builtin/software-company',
    name: '全栈软件研发公司',
    subtitle: 'Software Company · 5 人成建制研发团',
    category: 'engineering',
    categoryLabel: '软件与安全',
    badge: '内置原生团',
    accent: '#0F84D4',
    tagline: '对照真实互联网产研组织：从需求拆解、系统架构、编码落地到 QA 验收全流程接力交付。',
    deliverables: ['需求范围与验收标准', '系统架构与接口契约', '核心实现方案', '测试矩阵与发布清单'],
    defaultGoal: '设计并落地一套支持多租户、权限审计与离线容灾的桌面/Web 协作应用架构与核心实现方案',
    lead: {
      id: 'software-team-lead',
      name: '技术项目总监',
      role: 'Lead · 统筹定稿',
      description: '统筹产品、架构、研发与测试产出，解决跨角色冲突，输出最终可执行交付蓝图。',
    },
    members: [
      { id: 'software-product-manager', name: '软件产品经理', role: '需求边界', description: '梳理用户故事、MVP 边界、关键流程状态机与验收指标。' },
      { id: 'software-architect', name: '首席系统架构师', role: '技术选型与架构', description: '设计分层模块边界、数据模型、API 契约与性能/安全护栏。' },
      { id: 'software-engineer', name: '全栈开发工程师', role: '核心代码实现', description: '按架构契约输出关键模块代码、错误处理与零依赖落地步骤。' },
      { id: 'software-qa-engineer', name: 'QA 质检工程师', role: '测试与验收', description: '编写单元/E2E 回归用例、边界故障矩阵与上线前回归清单。' },
    ],
  },
  {
    id: 'design-engine',
    builtinDir: 'backend/experts_builtin/design-engine',
    name: 'Design Engine 品牌与交互设计工作室',
    subtitle: 'Design Engine · 6 人旗舰设计团',
    category: 'design',
    categoryLabel: '设计与产品',
    badge: '内置原生团',
    accent: '#D4653E',
    tagline: '6 位设计专家协同流水线：需求洞察 → 品牌 Design Tokens → 交互原型 → 5D 审美拷问 → 开发交付。',
    deliverables: ['视觉方向与品牌气质', 'Design Tokens 规范', '高保真界面原型', '5D 反廉价审美审查报告'],
    defaultGoal: '为一款 Apple 液态玻璃风格的 AI 桌面工作台重新设计信息架构、核心页面视觉系统与交互微动效规范',
    lead: {
      id: 'design-engine-team-lead',
      name: '设计引擎总监',
      role: 'Lead · 创意总控',
      description: '统领全链路设计语言与品质把关，确保最终产出兼具惊艳审美与工程可落地性。',
    },
    members: [
      { id: 'discovery-analyst', name: '需求发现分析师', role: '用户心智与痛点', description: '拆解核心用户旅程、视觉噪声痛点与首要信息层级。' },
      { id: 'design-system-expert', name: '设计系统专家', role: 'Tokens 与材质', description: '定义色彩、玻璃通透度、字体阶梯、圆角、阴影与高光边缘规范。' },
      { id: 'prototype-builder', name: '交互原型师', role: '布局与状态机', description: '产出关键页面结构布局、空态/加载/报错态与微交互动效参数。' },
      { id: 'critique-reviewer', name: '5D 审美评审官', role: '反 AI 廉价感审计', description: '从对比度、留白呼吸感、一致性与高级感 5 维挑刺并打回平庸设计。' },
      { id: 'export-specialist', name: '研发交付专家', role: 'CSS/组件切图规范', description: '将设计规范转化为零歧义的 CSS Tokens 与前端组件实现清单。' },
    ],
  },
  {
    id: 'product-strategy-team',
    builtinDir: 'backend/experts_builtin/product-strategy-team',
    name: '一线产品战略咨询团',
    subtitle: 'Product Strategy Team · 6 人产品部',
    category: 'design',
    categoryLabel: '设计与产品',
    badge: '内置原生团',
    accent: '#6366F1',
    tagline: '从用户访谈洞察、竞品深挖、需求优先级、数据指标树到季度路线图的完整产品战略闭环。',
    deliverables: ['用户痛点洞察', '竞品差异化矩阵', 'RICE 优先级排期', '北极星指标树'],
    defaultGoal: '针对 AI 桌面智能体赛道，完成竞品差异化定位分析并输出未来 2 个季度的核心产品路线图与指标体系',
    lead: {
      id: 'product-director',
      name: '产品战略总监',
      role: 'Lead · 战略拍板',
      description: '综合用研、竞品、数据与排期建议，做出清晰的战略取舍与可执行季度规划。',
    },
    members: [
      { id: 'user-researcher', name: '用户研究专家', role: '人群与 JTBD', description: '提炼核心目标用户的真实高频任务、替代方案与付费触发点。' },
      { id: 'competitive-analyst', name: '竞品情报分析师', role: '竞争格局与护城河', description: '拆解头部竞品商业模式、真实用户差评与可攻破的差异化缝隙。' },
      { id: 'requirement-analyst', name: '需求拆解架构师', role: 'MVP 与功能切分', description: '将战略目标拆解为清晰的 P0/P1/P2 功能模块与边界约束。' },
      { id: 'data-analyst', name: '产品数据分析师', role: '北极星与漏斗指标', description: '设计激活、留存、复购与关键转化埋点指标体系。' },
      { id: 'roadmap-planner', name: '路线图规划师', role: '节奏与里程碑', description: '输出按双周/月度切分的发布节奏、依赖项与风险对冲方案。' },
    ],
  },
  {
    id: 'video-director-remotion',
    builtinDir: 'backend/experts_builtin/video-director-remotion',
    name: '商业短片与分镜制片组',
    subtitle: 'Video Director Studio · 3 人制片团',
    category: 'creative',
    categoryLabel: '影视与游戏',
    badge: '内置原生团',
    accent: '#EC4899',
    tagline: '从前 3 秒黄金钩子、逐秒分镜运镜表到可灵/即梦/Sora 提示词与 Remotion 动效脚本一站成片。',
    deliverables: ['3 秒完播钩子文案', '逐镜景别运镜分镜表', '中英双语 AIGC 提示词', 'BGM 与节奏剪辑指令'],
    defaultGoal: '为新品发布制作一条 45 秒高质感科技感产品宣传短片：输出完整分镜、旁白文案与 AI 视频生成提示词',
    lead: {
      id: 'video-director-lead',
      name: '短片总导演',
      role: 'Lead · 叙事与节奏',
      description: '把控整体情绪弧光、前 3 秒钩子与视听统一性，汇总输出最终可执行拍摄/生成脚本。',
    },
    members: [
      { id: 'storyboard-designer', name: '视觉分镜设计师', role: '景别与运镜设计', description: '按秒拆解景别、机位运动、光影转场、画面主体与字幕压屏节奏。' },
      { id: 'aigc-remotion-producer', name: 'AIGC 与动效制片人', role: '提示词与代码动画', description: '输出高一致度中英双语生图/生视频 Prompt 与 Remotion 关键帧参数。' },
    ],
  },
  {
    id: 'product-strategy-pm',
    builtinDir: 'backend/experts_builtin/product-strategy-pm',
    name: '敏捷产品立项突击队',
    subtitle: 'Agile PM Pod · 3 人立项小队',
    category: 'design',
    categoryLabel: '设计与产品',
    badge: '内置原生团',
    accent: '#8B5CF6',
    tagline: '专攻单个核心需求的极速立项：10 分钟输出零歧义 PRD、异常状态机与上线衡量标准。',
    deliverables: ['零歧义功能 PRD', '异常与边界状态表', '验收标准 AC 清单', '上线效果评估指标'],
    defaultGoal: '为一个「自定义模型保存中心 + 会话级快捷切换」核心功能撰写可直接交付研发的完整 PRD 与验收标准',
    lead: {
      id: 'pm-director-lead',
      name: '产品立项负责人',
      role: 'Lead · 方案定稿',
      description: '把关需求闭环与取舍边界，输出产研直接对齐的终版需求说明书。',
    },
    members: [
      { id: 'prd-spec-architect', name: 'PRD 规范架构师', role: '交互与逻辑契约', description: '定义字段校验、主/异常分支流程、权限约束与界面信息层级。' },
      { id: 'metrics-roadmap-analyst', name: '指标与排期分析师', role: 'ROI 与灰度验证', description: '制定埋点方案、灰度放量策略与上线后 7 日核心观测指标。' },
    ],
  },
  {
    id: 'short-drama-studio',
    name: '爆款短剧编导制片厂',
    subtitle: 'Short-Drama Writers Room · 4 人编剧室',
    category: 'creative',
    categoryLabel: '影视与游戏',
    badge: '爆款编剧室',
    accent: '#F43F5E',
    tagline: '按国际工业化编剧室流程协作：题材卡点钩子 → 多视角戏剧反讽 → 潜台词对白精修 → 视觉动作外化。',
    deliverables: ['3 幕节拍表与卡点钩子', '冲突场景终稿剧本', '潜台词与动作精修版', '首集投流黄金 15 秒'],
    defaultGoal: '创作一集 2 分钟高张力都市悬疑反转短剧：拒绝说教和廉价爽文，用视角差与潜台词拉满戏剧张力',
    lead: {
      id: 'drama-showrunner',
      name: '短剧总编剧导演',
      role: 'Lead · 剧作总控',
      description: '统筹人物弧光、强冲突节奏与视听落地，整合并终审高张力完整剧本。',
    },
    members: [
      { id: 'drama-beat-architect', name: '结构与钩子策划', role: '每 30 秒反转节拍', description: '设计信息不对称悬念、强迫选择困境与每集结尾强卡点钩子。' },
      { id: 'drama-subtext-writer', name: '对白与潜台词编剧', role: '去说教化台词', description: '删掉直白解释性废话，用锋利交锋、潜台词与停顿动作推动情绪升级。' },
      { id: 'drama-visual-director', name: '镜头与情绪导演', role: '动作外化与剪辑点', description: '将内心戏转化为特写道具、微表情与声音蒙太奇，强化成片质感。' },
    ],
  },
  {
    id: 'growth-war-room',
    name: '全域增长与电商爆单作战部',
    subtitle: 'Growth War Room · 4 人操盘团',
    category: 'business',
    categoryLabel: '增长与投研',
    badge: '商业变现',
    accent: '#F59E0B',
    tagline: '流量、种草、转化与复购四位一体：打通小红书/抖音爆文、官网高转化落地页与私域成交闭环。',
    deliverables: ['渠道流量打法矩阵', '5 组爆款封面与种草文案', '高转化落地页文案', '7 天私域与直播成交 SOP'],
    defaultGoal: '为一款面向效率人群的 AI 桌面工具制定 30 天零预算冷启动增长方案与首批爆款内容脚本',
    lead: {
      id: 'growth-vp-lead',
      name: '增长总操盘手',
      role: 'Lead · ROI 总控',
      description: '以获客成本与转化率为核心准绳，整合各渠道动作输出按 ROI 排序的 30 天作战表。',
    },
    members: [
      { id: 'viral-content-lead', name: '社媒爆款内容编导', role: '小红书 / 抖音种草', description: '提炼高点击率痛点标题、封面视觉逻辑与评论区自然引流埋点。' },
      { id: 'cro-landing-expert', name: '转化率与落地页专家', role: '落地页与定价锚点', description: '重构首屏价值主张、社会背书、消除顾虑 FAQ 与强 CTA 按钮文案。' },
      { id: 'lifecycle-crm-ops', name: '私域与直播成交师', role: '留存复购 SOP', description: '设计企微欢迎语、7 天培育剧本与高客单限时促单转化话术。' },
    ],
  },
  {
    id: 'security-red-blue-team',
    name: '红蓝对抗安全审计团',
    subtitle: 'Red & Blue SecOps · 4 人安全团',
    category: 'engineering',
    categoryLabel: '软件与安全',
    badge: '安全护航',
    accent: '#EF4444',
    tagline: '模拟真实攻防演练：红队寻找攻击面与提权链，源码审计师核查 OWASP 漏洞，蓝队给出最小加固补丁。',
    deliverables: ['威胁建模与攻击路径图', '高危漏洞分级清单', '最小化安全修复补丁', '回归验证测试项'],
    defaultGoal: '对当前桌面 AI Agent 的本地代理服务、文件读写沙箱与浏览器工具链路进行红蓝对抗安全审计并输出修复清单',
    lead: {
      id: 'ciso-lead',
      name: '首席安全架构师',
      role: 'Lead · 风险定级',
      description: '汇总攻防发现，按 P0/P1/P2 风险定级并给出兼顾体验与安全的最终加固方案。',
    },
    members: [
      { id: 'red-team-attacker', name: '红队渗透攻击专家', role: '攻击链推演', description: '从 Prompt 注入、SSRF、路径穿越与命令注入视角构造真实复现路径。' },
      { id: 'owasp-code-auditor', name: 'OWASP 源码审计师', role: '鉴权与竞态排查', description: '逐项排查鉴权绕过、密钥泄露、并发 TOCTOU 竞态与依赖安全隐患。' },
      { id: 'blue-team-defender', name: '蓝队加固架构师', role: '最小权限与护栏', description: '给出零破坏的最小防御补丁、输入规范化规则与安全回归测试用例。' },
    ],
  },
  {
    id: 'ai-agent-lab',
    name: '前沿 AI Agent 架构实验室',
    subtitle: 'Frontier Agent Lab · 4 人大模型团',
    category: 'engineering',
    categoryLabel: '软件与安全',
    badge: '2026 前沿',
    accent: '#06B6D4',
    tagline: '专攻高命中率 KV-Cache、动态工具路由、RAG/MCP 工具链与自动化评测闭环的顶级 Agent 工程团队。',
    deliverables: ['Agent 编排架构图', '95%+ KV-Cache 提示词方案', 'MCP 工具契约与护栏', 'Golden Eval 评测集'],
    defaultGoal: '优化一套多工具桌面 AI Agent 引擎：在保持复杂任务成功率的同时将 Prompt Cache 命中率推高至 92%+ 并降低延迟',
    lead: {
      id: 'agent-chief-lead',
      name: 'Agent 首席架构师',
      role: 'Lead · 系统权衡',
      description: '统一上下文工程、工具编排与延迟/成本目标，输出可直接实施的升级蓝图。',
    },
    members: [
      { id: 'prompt-cache-expert', name: 'Prompt 与缓存工程师', role: 'Append-Only 前缀优化', description: '固化系统提示与工具 Schema 字典序，剥离动态字段消除前缀抖动。' },
      { id: 'rag-mcp-builder', name: 'RAG 与 MCP 工具工程师', role: '检索与工具契约', description: '设计高信噪比混合检索、清晰防误调 Tool Schema 与结果摘要截断策略。' },
      { id: 'eval-cost-router', name: '评测与成本路由师', role: '分级路由与评测', description: '构建自动化评测基准与按任务复杂度分层调度的成本优化策略。' },
    ],
  },
  {
    id: 'vc-deal-advisory',
    name: '融资 BP 与商业法务尽调团',
    subtitle: 'VC & Deal Advisory · 4 人合伙人团',
    category: 'business',
    categoryLabel: '增长与投研',
    badge: '老板必备',
    accent: '#10B981',
    tagline: '一线 VC 叙事 + 严谨财务 UE 模型 + 中国商法知产排雷 + 模拟投资人犀利拷问，助你一次拿下融资与大单。',
    deliverables: ['12 页融资 BP 核心叙事', '12 个月 UE 与现金流模型', '合规与知产排雷清单', '投资人 10 大犀利 Q&A'],
    defaultGoal: '为一个 AI 生产力软件创业项目打磨天使轮融资 BP 核心逻辑、盈亏平衡测算与合规发布排雷清单',
    lead: {
      id: 'vc-partner-lead',
      name: '投融资战略合伙人',
      role: 'Lead · 商业叙事',
      description: '用一线机构视角统一商业故事、数据佐证与估值逻辑，输出终版融资与签约方案。',
    },
    members: [
      { id: 'ue-finance-modeler', name: '财务与 UE 建模师', role: '单位经济与现金流', description: '测算客单价、毛利率、LTV/CAC 与保守/中性/乐观三档现金流跑道。' },
      { id: 'legal-ip-counsel', name: '法务与知产合规官', role: '合同与隐私合规', description: '排查开源许可、PIPL 隐私合规、软著保护与投资条款红线。' },
      { id: 'skeptic-vc-grill', name: '模拟投资人拷问官', role: '死穴压力测试', description: '毫不留情地挑出伪需求、壁垒薄弱与增长天花板问题，并给出高分应答策略。' },
    ],
  },
  {
    id: 'deep-research-institute',
    name: '深度研报与顶会科研院',
    subtitle: 'Deep Research Institute · 4 人智库',
    category: 'business',
    categoryLabel: '增长与投研',
    badge: '麦肯锡级',
    accent: '#3B82F6',
    tagline: 'MECE 结构化拆解 + 信源可信度分级 + 量化图表建模 + 芒格逆向批判审查，杜绝水文与 AI 幻觉。',
    deliverables: ['MECE 核心结论框架', '分级信源证据表', '量化指标与图表方案', '反方风险与证伪审查'],
    defaultGoal: '针对 2026 年桌面端本地+云端混合 AI Agent 商业化趋势，输出一份决策级深度行业研究报告',
    lead: {
      id: 'chief-researcher-lead',
      name: '首席研究院长',
      role: 'Lead · 观点定稿',
      description: '统筹研究主线、核验论据闭环，输出结构严密、金句凝练的最终决策级研报。',
    },
    members: [
      { id: 'source-hunter', name: '一手信源与文献研究员', role: '证据分层与事实核查', description: '区分一手财报/论文与二手观点，建立可追溯的事实证据矩阵。' },
      { id: 'bi-quant-analyst', name: '数据统计与图表建模师', role: '量化测算与可视化', description: '将零散数据转为清晰的对比表格、趋势指标与图表规范。' },
      { id: 'inversion-critic', name: '逆向批判与定稿主编', role: '逻辑排雷与润色', description: '应用芒格逆向思维挑出幸存者偏差与隐含假设，消除空洞 AI 腔。' },
    ],
  },
  {
    id: 'game-studio-pod',
    name: '独立游戏策划与数值工作室',
    subtitle: 'Indie Game Studio · 4 人制作组',
    category: 'creative',
    categoryLabel: '影视与游戏',
    badge: '游戏制作组',
    accent: '#A855F7',
    tagline: '从核心玩法循环、关卡心流曲线、防通胀经济数值表到分支世界观叙事的一体化游戏设计制作组。',
    deliverables: ['核心玩法循环 GDD', '关卡心流节奏曲线', '经济与数值平衡表', '分支剧情与对话样稿'],
    defaultGoal: '设计一款赛博都市题材轻度肉鸽卡牌独立游戏的完整核心循环、数值成长曲线与首章分支剧情',
    lead: {
      id: 'game-producer-lead',
      name: '游戏制作人',
      role: 'Lead · 体验闭环',
      description: '平衡玩法爽感、开发体量与商业留存，整合并输出可直接立项开发的 GDD 文档。',
    },
    members: [
      { id: 'gameplay-level-designer', name: '核心玩法与关卡策划', role: '核心循环与心流', description: '设计 30 秒微循环、关卡难度波浪曲线与正负反馈机制。' },
      { id: 'economy-math-designer', name: '经济与数值平衡师', role: '成长曲线与防通胀', description: '建立产出/消耗水龙头模型、伤害公式与装备稀有度期望表。' },
      { id: 'narrative-world-writer', name: '世界观与分支编剧', role: '叙事与角色塑造', description: '打造鲜明阵营冲突、碎片化环境叙事与高代入感分支对白。' },
    ],
  },
])

/** 兼容旧引用名（平滑过渡） */
export const DREAM_TEAM_PRESETS = NATIVE_EXPERT_TEAMS

/** 将用户本机导入的多 Agent .codebuddy-plugin 团队包与内置 12 支原生团统一融合（自动去重） */
export function buildAvailableTeams(localExperts = []) {
  const list = [...NATIVE_EXPERT_TEAMS]
  const seen = new Set(list.map((t) => t.id))
  for (const pkg of (localExperts || [])) {
    if (!pkg || !pkg.id || seen.has(pkg.id)) continue
    const md = pkg.metadata || {}
    const rawAgents = Array.isArray(pkg.agents) ? pkg.agents : (Array.isArray(md.agents) ? md.agents : [])
    const isTeamPkg = rawAgents.length > 1 || Boolean(md.team) || /team|studio|company/i.test(pkg.id)
    if (!isTeamPkg) continue
    seen.add(pkg.id)
    const teamName = safeExpertText(md.displayName, safeExpertText(pkg.name, pkg.id))
    const teamDesc = safeExpertText(md.displayDescription || md.description, '本地导入的多角色专家团队包')
    const normAgents = rawAgents.map((a, idx) => {
      if (typeof a === 'string') {
        const clean = a.replace(/^.*[/\\]/, '').replace(/\.md$/i, '')
        return { id: clean, name: clean, role: idx === 0 ? 'Lead' : `成员 #${idx}`, description: '' }
      }
      return {
        id: (a && a.id) || `agent_${idx}`,
        name: safeExpertText(a && (a.displayName || a.name), `专家 #${idx + 1}`),
        role: safeExpertText(a && a.role, idx === 0 ? 'Lead' : `成员 #${idx}`),
        description: safeExpertText(a && a.description, ''),
      }
    })
    const lead = normAgents[0] || { id: `${pkg.id}_lead`, name: `${teamName} 主理`, role: 'Lead', description: teamDesc }
    const members = normAgents.slice(1).length ? normAgents.slice(1) : [lead]
    list.push({
      id: pkg.id,
      name: teamName,
      subtitle: `${pkg.id} · ${normAgents.length || 1} 人本地团队包`,
      category: 'engineering',
      categoryLabel: '本地导入团',
      badge: '本地导入团',
      accent: '#14B8A6',
      tagline: teamDesc,
      deliverables: ['团队协作报告', '分角色专业产出'],
      defaultGoal: `请以「${teamName}」标准协作流程完成当前任务并汇总交付报告`,
      lead,
      members,
    })
  }
  return list
}

export class ExpertMailbox {
  constructor(initialEvents = []) {
    this.events = Array.isArray(initialEvents) ? initialEvents.map((e) => ({ ...e })) : []
  }
  deliver({ runId, from, to, subject, body }) {
    const ev = {
      id: 'mb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
      runId,
      from: safeExpertText(from, '专家'),
      to: safeExpertText(to, '主理专家'),
      subject: safeExpertText(subject, '交接结论'),
      body: String(body || ''),
      consumed: false,
      at: Date.now(),
    }
    this.events.push(ev)
    return ev
  }
  consumeFor(memberName) {
    const key = safeExpertText(memberName)
    const hits = this.events.filter((e) => !e.consumed && (e.to === key || e.to === '*'))
    hits.forEach((e) => { e.consumed = true })
    return hits
  }
  unconsumed() {
    return this.events.filter((e) => !e.consumed).map((e) => ({ ...e }))
  }
}

export async function runExpertTeam({
  goal,
  lead,
  members = [],
  endpointConfig,
  recovery = null,
  signal = null,
  onUpdate = null,
}) {
  const safeLead = {
    id: (lead && lead.id) || 'lead',
    name: safeExpertText(lead && lead.name, '主理专家'),
    role: safeExpertText(lead && lead.role, 'Lead'),
    description: safeExpertText(lead && lead.description, ''),
    prompt: safeExpertText(lead && lead.prompt, ''),
  }
  const safeMembers = (Array.isArray(members) ? members : []).map((m, idx) => ({
    id: (m && m.id) || `m_${idx}`,
    name: safeExpertText(m && m.name, `专家 #${idx + 1}`),
    role: safeExpertText(m && m.role, `成员 #${idx + 1}`),
    description: safeExpertText(m && m.description, ''),
    prompt: safeExpertText(m && m.prompt, ''),
  }))

  const runId = 'team_' + Date.now().toString(36)
  const mailbox = new ExpertMailbox(
    recovery && Array.isArray(recovery.unconsumedMailbox)
      ? recovery.unconsumedMailbox.map((ev) => ({ ...ev, runId }))
      : []
  )
  const completedMap = new Map()
  if (recovery && Array.isArray(recovery.completedMembers)) {
    for (const item of recovery.completedMembers) {
      completedMap.set(safeExpertText(item.name), item.result)
    }
  }

  const timeline = []
  const emit = (type, label, detail = '') => {
    timeline.push({ id: `tl_${timeline.length}`, type, label: safeExpertText(label), detail: safeExpertText(detail), at: Date.now() })
    if (typeof onUpdate === 'function') {
      onUpdate({
        runId,
        timeline: [...timeline],
        mailbox: [...mailbox.events],
        completedMembers: [...completedMap.entries()].map(([name, result]) => ({ name, result })),
      })
    }
  }

  emit('team_created', `团队启动：${safeLead.name} 领衔（${safeMembers.length} 名固定编制成员）`, recovery ? '从检查点断点恢复' : '全新成建制信箱编排')

  const buildPauseResult = () => {
    const checkpoint = {
      runId,
      goal,
      completedMembers: [...completedMap.entries()].map(([name, result]) => ({ name, result })),
      unconsumedMailbox: mailbox.unconsumed(),
    }
    emit('team_paused', '团队编排已暂停（已保存断点恢复检查点）')
    return { status: 'paused', runId, timeline, mailbox: mailbox.events, checkpoint, finalReport: '' }
  }

  for (const member of safeMembers) {
    if (signal && signal.aborted) return buildPauseResult()

    if (completedMap.has(member.name)) {
      emit('member_skipped', `跳过已完成成员：${member.name}`, '断点恢复防重放')
      continue
    }

    const inbox = mailbox.consumeFor(member.name)
    emit('member_started', `成员「${member.name}」（${member.role}）开始执行`, member.description || '')

    const inboxText = inbox.length
      ? '\n\n【收到前序成员信箱交接】\n' + inbox.map((m) => `来自 ${m.from}（${m.subject}）：\n${m.body}`).join('\n---\n')
      : ''

    const sysPersona = member.prompt
      ? `${member.prompt}\n\n当前你在成建制专家团队中担任「${member.name}（${member.role}）」，请输出结构化高密度专业产出，便于主理总监汇总定稿。`
      : `你是成建制专家团队成员「${member.name}（${member.role}）」。核心职责：${member.description || '提供专业分析与可执行产出'}。请给出结构化高密度结论。`

    let resp
    const stepCtrl = new AbortController()
    const onOuterAbort = () => stepCtrl.abort()
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true })
    const stepTimer = setTimeout(() => stepCtrl.abort(new Error(`成员「${member.name}」响应超时`)), 45000)
    try {
      resp = await streamChatCompletion({
        ...endpointConfig,
        signal: stepCtrl.signal,
        messages: [
          { role: 'system', content: sysPersona },
          { role: 'user', content: `【团队目标】\n${goal}${inboxText}` },
        ],
      })
    } catch (err) {
      if (signal && signal.aborted) return buildPauseResult()
      throw err
    } finally {
      clearTimeout(stepTimer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
    }
    const output = String(resp.content || '').trim()
    completedMap.set(member.name, output)
    mailbox.deliver({ runId, from: member.name, to: safeLead.name, subject: `${member.name} 产出`, body: output })
    emit('member_completed', `成员「${member.name}」完成并投递信箱`, output.slice(0, 140))
  }

  if (signal && signal.aborted) return buildPauseResult()

  const allInbox = mailbox.consumeFor(safeLead.name)
  const summaryBody = [
    ...completedMap.entries().map(([name, res]) => `### 成员：${name}\n${res}`),
    ...allInbox.filter((e) => !completedMap.has(e.from)).map((e) => `### 信箱：${e.from}\n${e.body}`),
  ].join('\n\n')

  emit('lead_synthesizing', `主理总监「${safeLead.name}」正在综合信箱并撰写终版交付报告`)
  const leadSys = safeLead.prompt
    ? `${safeLead.prompt}\n\n你是本次团队主理总监「${safeLead.name}」。请综合各编制成员的信箱产出，去重对齐矛盾点，输出最终统一决策与分步执行清单。`
    : `你是团队主理总监「${safeLead.name}」。请综合各编制成员的信箱产出，输出最终统一决策与执行清单。`

  let leadResp
  try {
    leadResp = await streamChatCompletion({
      ...endpointConfig,
      signal,
      messages: [
        { role: 'system', content: leadSys },
        { role: 'user', content: `【总目标】\n${goal}\n\n【各成员产出】\n${summaryBody}` },
      ],
    })
  } catch (err) {
    if (isAbort(err) || (signal && signal.aborted)) return buildPauseResult()
    throw err
  }
  const finalReport = String(leadResp.content || '').trim()
  emit('team_finished', `团队编排完成（共 ${completedMap.size} 位编制专家交付）`)

  return {
    status: 'completed',
    runId,
    timeline,
    mailbox: mailbox.events,
    checkpoint: null,
    finalReport,
  }
}
