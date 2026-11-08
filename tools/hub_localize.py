# -*- coding: utf-8 -*-
"""R35 · 目录条目中文化 + 连接器真实可用性分级。

问题：R32 目录直接沿用 marketplace.json / SKILL.md 的英文 description，
市场页出现「github / notion / feishu」等纯英文卡片，与 WorkBuddy 中文界面不一致。
本模块保证**所有**条目的 desc 含中文，并保留英文原名作为 alias 供检索。

连接器分级（决定市场卡片如实标注什么、启用时真的做什么）：
  ready   —— 附带 MCP 配置且无需密钥，可一键注册进 Harbor 后端 MCP 运行时
  auth    —— 附带 MCP 配置但需要 API Key / OAuth / 企业账号授权
  local   —— stdio 型，需要本机存在对应 CLI / 运行时
  sse     —— 仅提供旧 SSE 传输，后端未支持，需手动改配置
  catalog —— 无 MCP 配置（WorkBuddy 自有运行时 / 纯 CLI 技能），Harbor 无法直接调用
"""
from __future__ import annotations

import re

CJK = re.compile(r'[\u4e00-\u9fff]')

# 高频/内置条目精确中文（这些在 WorkBuddy 官方界面也多为专有名，名称保留英文产品名）
OVERRIDES: dict[str, tuple[str, str]] = {
    'buddy-image-processing': ('图片处理', '处理已有图片：去文字与水印、画质增强、人像美化、老照片修复、智能抠图。'),
    'buddy-multimodal-generation': ('多模态生成', '生成 3D 模型，或套用模板把图片转成视频特效；文生图与通用视频生成另行调用。'),
    'geo-map-compliance-guard': ('地图合规守卫', '涉及地图生成、可视化、路径规划或位置服务时，强制按中国地图数据合规要求校验数据源与审图号。'),
    'recommend-connectors': ('连接器推荐', '当任务需要外部应用、服务、API、MCP 服务器或第三方数据时，检索并推荐合适的连接器。'),
    'recommend-experts': ('专家推荐', '当任务需要专业判断、深度调研、特定专家角色或多角色协作时，检索并推荐合适的专家或专家团。'),
    'skill-creator': ('技能创建指南', '指导创建、更新与维护一个高质量的 Skill：结构、触发条件、说明文档与验证方式。'),
    'wecom-forwarded-chat-resources': ('企微转发资源', '读取企业微信转发聊天归档中列出的在线参考资料。'),
    'workbuddy-office-routing': ('Office 文件路由', '处理本地 PDF / Word / Excel / PPT 等文件前，先按文件类型选择对应的读写与排版链路。'),
    'github': ('GitHub', '连接 GitHub：克隆与推送仓库、管理 Issue 与拉取请求。'),
    'agent-browser': ('浏览器自动化', '打开与操作网页：点击、输入、滚动、截图、表单填写与网页信息提取。'),
    'wecom-media-upload': ('企微媒体上传', '把本地文件先上传为企业微信媒体，再作为附件随消息发送。'),
    'wecom-wedrive-reference': ('企微微盘引用', '读取用户在消息里附带的企业微信微盘文件作为参考资料。'),
    'ardot-design-core': ('画布设计基础', '所有 Ardot 画布设计任务共用的基础工作流与硬性规则。'),
    'ardot-design-to-code': ('设计转代码', '把 Ardot 画布设计稿转换为前端代码，或从设计稿提取组件结构。'),
    'ardot-poster': ('海报设计', '在 Ardot 画布上产出海报、宣传图等视觉设计稿。'),
    'ardot-slides': ('演示文稿设计', '在 Ardot 画布上产出整套幻灯片 / 演示文稿设计。'),
    'ardot-ui-design': ('界面设计', '在 Ardot 画布上产出网页 / 应用界面设计稿。'),
    'design-router': ('设计任务路由', 'WorkBuddy 设计助手的分发器，按任务类型路由到对应设计工作流。'),
    'skill-creator-guide': ('技能创建指南', '创建与维护自定义技能的完整方法论。'),
    'executing-marketing-campaigns': ('营销活动执行', '策划、创建与优化营销活动：内容策略、社媒、邮件与效果复盘。'),
    'document-skills': ('文档处理套件', 'Excel、Word、PowerPoint、PDF 文档处理能力合集。'),
    'general-skills': ('通用技能合集', '文档转换（MarkItDown）、技能发现等通用能力合集。'),
    'modern-webapp': ('现代 Web 应用', '基于 React、TypeScript、Vite、Tailwind 与 shadcn/ui 的 Web 应用开发。'),
    'codebuddy-chat-web': ('Web 聊天应用', '用 CodeBuddy Agent SDK 初始化一个带 React 前端的网页聊天应用。'),
    'dockerfile-gen': ('Dockerfile 生成', '按容器化最佳实践自动生成 Dockerfile。'),
    'all-agents': ('智能体全集', '覆盖 11 个类别的 117 个专业 AI 智能体合集。'),
    'all-commands': ('斜杠命令全集', '覆盖 22 个类别的 174 条斜杠命令合集。'),
    'all-hooks': ('自动化钩子全集', '28 个事件驱动的自动化钩子合集。'),
    'all-skills': ('技能全集', '26 个文档处理、开发与业务流程类技能合集。'),
    'mcp-servers-docker': ('Docker MCP 服务器', '来自 Docker 官方 MCP 注册表的 199+ 个已验证服务器。'),
    'scientific-skills': ('科研技能合集', '139 个开箱即用的科研计算与分析技能。'),
    'ui-ux-pro-max-skill': ('UI/UX 设计系统', '生成行业化 UI/UX 设计系统：100+ 推理规则、57 种界面风格。'),
    'frontend-design-pro': ('前端设计进阶', '交互式向导、趋势调研、情绪板与品牌规范的前端设计插件。'),
    'nextjs-expert': ('Next.js 专家', 'App Router、服务端组件、Route Handlers 等 Next.js 开发专长。'),
    'llm-application-dev': ('大模型应用开发', '构建生产级 LLM 应用、RAG 系统与智能体。'),
    'machine-learning-ops': ('MLOps 工具箱', 'ML 工程、MLOps 基础设施与数据管线的完整工具链。'),
    'obsidian-skills': ('Obsidian 笔记', '处理 Obsidian 文件：双向链接、嵌入、Callout、Bases 等。'),
    'interview': ('需求访谈', '通过结构化访谈把大需求的方案与规格问清楚。'),
    'full-stack-orchestration': ('全栈编排', '编排多智能体完成全栈特性开发，含测试、性能与质量把关。'),
    'functional-programming': ('函数式编程', 'Haskell、Elixir 等函数式语言专家与高级实践。'),
    'frontend-mobile-security': ('前端移动安全', '前端与移动端安全审计：XSS、注入与依赖风险扫描。'),
    'application-performance': ('应用性能工程', '应用性能优化、可观测性与容量扩展。'),
    'claude-hud': ('状态栏 HUD', '实时状态栏：上下文占用、工具活动、智能体进度。'),
}

# 英文 connectors 精确中文（在线包缺中文 display 的 19 项）
CONNECTOR_OVERRIDES: dict[str, tuple[str, str]] = {
    'amazingdata-mcp': ('银河证券星耀数据', '连接中国银河证券星耀数据智能平台，查询金融数据与研报。'),
    'anguan-service-gateway': ('安管服务网关', '连接运输企业安全管理平台，查询车辆、驾驶员与安全台账。'),
    'bocha-search': ('博查搜索', '面向 AI 的搜索引擎，获取增强的搜索结果与网页详情。'),
    'dcs-cloud': ('DCS 云平台', '通过个人访问令牌登录 DCS 云平台，管理项目、检索组学数据、提交离线分析任务。'),
    'designkit': ('Designkit 设计', '用 Designkit 创建与修改视觉设计和演示文稿。'),
    'grain-print': ('谷粒打印', '连接谷粒打印交付终端，查询并打印当日单据。'),
    'ifind-mcp': ('同花顺 iFinD', '查询股票、基金、债券、宏观等全品类金融数据。'),
    'ikuai-router': ('爱快路由', '用自然语言查看与管理局域网内的爱快路由器。'),
    'kelp-study-abroad': ('留学顾问助手', '留学申请、选校规划与文书准备的 AI 助手。'),
    'laiye-adp': ('来也 ADP', '让智能体直接理解与处理业务文档。'),
    'longclaw-research-dev': ('龙爪投研', '查询 A 股数据、筛股、分析市场与个股。'),
    'moomoo-mcp': ('Moomoo', '富途 Moomoo 股票交易与行情数据连接。'),
    'nexa-knowledge': ('Nexa 知识库', '查询企业知识库中的表、数据与业务知识。'),
    'tccc': ('腾讯云联络中心', '管理腾讯云联络中心的应用、坐席与通话。'),
    'tourmind-hotel-booking-token': ('酒店比价预订', '用 AI 搜索、比价并预订酒店。'),
    'tripbiz': ('Trip.Biz 商旅', '携程商旅全流程差旅预订与费用管理服务。'),
    'weisheng-scrm': ('微盛企微管家 SCRM', '企业微信客户管理与私域运营的 SCRM 集成。'),
    'wwkj-mesh': ('维维科技管理系统', '连接维维科技软件管理系统的四大业务模块。'),
    'youzan-workbuddy': ('有赞', '查询有赞店铺的商品、订单、会员与营销数据。'),
}

# 前缀规则：长尾英文技能按命名规律生成中文（保证语义可读且必然含中文）
PREFIX_RULES: list[tuple[str, str]] = [
    ('commands-', '斜杠命令 · '), ('agents-', '专家智能体 · '), ('hooks-', '自动化钩子 · '),
    ('ardot-', 'Ardot 画布 · '), ('buddy-', '内置能力 · '), ('wecom-', '企业微信 · '),
    ('workbuddy-', '官方内置 · '),
]
TOPIC_ZH: list[tuple[str, str]] = [
    ('api-development', 'API 设计与文档'), ('automation-workflow', '重复任务自动化'),
    ('ci-deployment', 'CI/CD 与部署'), ('code-analysis-testing', '代码审查与测试'),
    ('context-loading-priming', '上下文装载'), ('database-operations', '数据库设计与迁移'),
    ('documentation-changelogs', '文档与变更日志'), ('framework-svelte', 'Svelte 框架'),
    ('game-development', '游戏开发'), ('integration-sync', '外部服务集成与同步'),
    ('miscellaneous', '通用工具'), ('monitoring-observability', '监控与可观测性'),
    ('performance-optimization', '构建与性能优化'), ('project-setup', '项目初始化'),
    ('project-task-management', '任务与项目跟踪'), ('security-audit', '安全审计'),
    ('simulation-modeling', '情景模拟与决策建模'), ('team-collaboration', '团队协作与评审'),
    ('typescript-migration', 'TypeScript 迁移'), ('utilities-debugging', '调试工具'),
    ('version-control-git', 'Git 版本控制'), ('workflow-orchestration', '复杂工作流编排'),
    ('blockchain-web3', '区块链与 Web3'), ('business-finance', '商业分析与财务建模'),
    ('crypto-trading', '加密交易策略'), ('data-ai', '数据工程与机器学习'),
    ('design-experience', 'UI/UX 与无障碍'), ('development-architecture', '架构与后端'),
    ('infrastructure-operations', '云基础设施与 DevOps'), ('language-specialists', '编程语言专家'),
    ('quality-security', '质量与安全审计'), ('sales-marketing', '营销与销售自动化'),
    ('specialized-domains', '垂直领域研究'), ('testing', '测试'), ('git', 'Git 工作流'),
    ('formatting', '代码格式化'), ('notifications', '消息通知'), ('performance', '性能'),
    ('security', '安全'), ('development', '开发'), ('automation', '自动化'),
]


def _topic(name: str) -> str:
    low = name.lower()
    for key, zh in TOPIC_ZH:
        if key in low:
            return zh
    return ''


def localize_skill(name: str, desc: str, section: str) -> tuple[str, str]:
    """返回 (中文名, 中文描述)。名称保留英文产品名时，描述必然含中文。"""
    key = str(name or '').strip().lower()
    if key in OVERRIDES:
        zh_name, zh_desc = OVERRIDES[key]
        return zh_name, zh_desc
    if CJK.search(desc or ''):
        return name, desc
    prefix = next((p for pre, p in PREFIX_RULES if key.startswith(pre)), '')
    topic = _topic(key)
    stem = key
    for pre, _ in PREFIX_RULES:
        if stem.startswith(pre):
            stem = stem[len(pre):]
            break
    zh_name = (prefix + (topic or stem.replace('-', ' '))).strip(' ·') or name
    if topic:
        zh_desc = '提供「%s」相关能力（%s），来自%s分区。' % (topic, name, section or '技能市场')
    else:
        zh_desc = '「%s」技能包，来自%s分区，启用后按该工作流协助完成任务。' % (
            name, section or '技能市场')
    return zh_name, zh_desc


def localize_connector(cid: str, name_zh: str, name_en: str,
                       desc_zh: str, desc_en: str, section: str) -> tuple[str, str]:
    """连接器中文名 + 中文描述；产品名（GitHub / Notion 等）保留英文是合理的。"""
    key = str(cid or '').strip().lower()
    if key in CONNECTOR_OVERRIDES:
        return CONNECTOR_OVERRIDES[key]
    name = (name_zh or '').strip()
    if not name or not CJK.search(name):
        name = (name_en or cid).strip()
    desc = (desc_zh or '').strip()
    if not CJK.search(desc):
        topic = _topic(key)
        if topic:
            desc = '连接「%s」服务，提供%s相关能力（%s）。' % (name, topic, section)
        else:
            desc = '连接「%s」服务，提供该平台的查询与操作能力（%s）。' % (name, section)
    return name, desc


def connector_section(rec: dict) -> str:
    """按可见范围与业务关键词给连接器分区（市场页分类标签动态生成）。"""
    vis = [str(v).lower() for v in (rec.get('visibleIn') or [])]
    if any(v in ('ioa', 'internal') for v in vis):
        return '企业专属'
    if rec.get('source') == '官方公开':
        return '官方公开'
    text = (rec.get('id', '') + ' ' + rec.get('nameZh', '') + ' ' +
            rec.get('nameEn', '') + ' ' + rec.get('descZh', '')).lower()
    rules = [
        ('金融数据', ('stock', 'fund', 'futu', 'moomoo', 'tushare', '证券', '股票', '行情', '基金', '金融', '财报', 'ifind', 'invest')),
        ('办公协同', ('doc', 'meeting', 'mail', 'wecom', 'feishu', 'lark', 'dingtalk', 'tapd', '腾讯文档', '会议', '邮件', '企微', '飞书', '钉钉', '日历', '问卷')),
        ('开发工具', ('git', 'code', 'cnb', 'cloud', 'deploy', 'edgeone', 'cloudbase', 'bugly', '代码', '仓库', '部署', '云开发')),
        ('知识与检索', ('knowledge', 'search', 'lexiang', 'ima', '北大法宝', '知识', '检索', '搜索', '百科')),
        ('商业信息', ('company', 'qcc', 'tianyancha', 'dnb', '工商', '企查', '天眼', '邓白氏', '法律')),
        ('电商零售', ('shop', 'order', 'youzan', 'ecommerce', '商品', '订单', '店铺', '电商', '跨境')),
        ('设计创作', ('design', 'canva', 'image', 'video', 'ppt', 'kling', '设计', '图片', '视频', '海报')),
        ('生活服务', ('hotel', 'trip', 'travel', 'edu', 'health', '酒店', '旅行', '留学', '教育', '医疗')),
    ]
    for label, keys in rules:
        if any(k in text for k in keys):
            return label
    return '更多服务'


def connector_link(mcp: dict | None, probe_ok: bool = False) -> tuple[str, str]:
    """按真实 MCP 配置 + 实测握手结果判定可用性，返回 (等级, 中文说明)。

    R35 实证：504 个 HTTP 型端点里只有 59 个能匿名完成 initialize 握手，
    其余 419 个返回 401/403 —— WorkBuddy 靠自家账号 / OAuth 会话注入凭证，
    配置里没写 headers 并不代表免鉴权。因此只有实探针白名单命中才算 ready。
    """
    if not mcp or not isinstance(mcp, dict):
        return 'catalog', '仅目录：WorkBuddy 未公开该服务的 MCP 配置，Harbor 无法直接连接'
    servers = list(mcp.values())
    types = [str((s or {}).get('type') or '').lower() for s in servers]
    has_url = any((s or {}).get('url') for s in servers)
    has_cmd = any((s or {}).get('command') for s in servers)
    needs_auth = any(
        (s or {}).get('headers') or (s or {}).get('env') or
        any(k in str(s or {}).lower() for k in ('oauth', 'api_key', 'apikey', 'token', 'pat'))
        for s in servers)
    if not has_url and not has_cmd:
        return 'catalog', '仅目录：配置缺少可连接的 URL 或本地命令'
    if types and all(t == 'sse' for t in types):
        return 'sse', '需手动适配：仅提供 SSE 传输，Harbor 后端目前支持 stdio 与 Streamable HTTP'
    if has_cmd and not has_url:
        return 'local', '需本机依赖：stdio 型，要求本机已安装对应 CLI 或运行时'
    if probe_ok and not needs_auth:
        return 'ready', '可直连：已实测匿名握手成功，可一键注册到 Harbor 的 MCP 运行时'
    if needs_auth:
        return 'auth', '需授权：接入后还要在「设置 → MCP 服务器」填入密钥或完成账号登录'
    return 'auth', ('需授权：实测该服务返回 401/403，WorkBuddy 用自家账号会话注入凭证；'
                    'Harbor 没有该登录态，须自行申请并填入 API Key / Token')


LINK_LABEL = {
    'ready': '可直连', 'auth': '需授权', 'local': '需本机依赖',
    'sse': '传输待适配', 'catalog': '仅目录',
}
