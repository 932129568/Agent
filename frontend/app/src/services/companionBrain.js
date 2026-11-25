/**
 * Harbor 3D 二次元娱乐协助助手 · 双引擎大脑（本地零依赖知识与动作驱动 + 专属大模型驱动）：
 * - 默认严格遵循「本地优先」原则：哪怕开启大模型，软件操作代跑、功能深度讲解、玻璃修补、黑洞取文件等全部优先用本地引擎秒级完成，零 Token 消耗；
 * - 只有闲聊问答（llmEnabled=true）或用户右键显式开启「完全使用大模型驱动 (fullLlmDrive=true)」时，才调用助手独立配置的大模型；
 * - 内置对 Harbor 全部核心架构与深层功能的完整认知（而非表面菜单名）。
 */
import { streamChatCompletion } from './modelTransport.js'

/** Harbor 全项目深度核心功能知识库（本地常驻，离线/无大模型照样精准答疑与代操作） */
export const HARBOR_DEEP_KNOWLEDGE = Object.freeze([
  {
    id: 'chat_and_session',
    keywords: ['对话', '聊天', '项目会话', '普通会话', '联网', '搜索', '缓存', 'kv', 'branch', '分支', '回退'],
    title: '智能对话 · 双会话模式、自主联网与 95%+ KV-Cache',
    summary: 'Harbor 对话分为「普通会话（纯知识对话与联网检索）」与「项目会话（绑定本地工作目录，可直接读写文件、执行命令与构建验证）」。底栏默认开启「🌐 自动联网」，模型会在需要实时资料时自主后台静默检索并给出内联来源卡，无需手动去搜；若想亲眼看浏览器操作可切「👁 前台搜」。消息底层采用 DAG 分支树 + Append-Only 前缀冻结，支持任意节点分叉重答与无损回滚。',
    action: { type: 'click', target: 'chat', label: '带你去智能对话页' },
  },
  {
    id: 'model_vault',
    keywords: ['模型', '切换模型', 'api', 'key', 'deepseek', 'glm', 'claude', 'ollama', '思考', '预算', '上下文'],
    title: '模型保存中心 · 独立端点、多级思考档位与全站随处切换',
    summary: '在「系统设置 → 模型保存中心」可以保存无限套云端/本地模型（支持对话、生图、视频 3 类，各自绑定独立 Base URL 与 API Key），并精细调节上下文窗口（最高 200K）与 8 档思考深度（含自定义 thinking_budget）。保存后在顶部状态岛、对话页、群聊角色与工作流节点里都能通过液态玻璃选择器一键切换。',
    action: { type: 'click', target: 'settings', label: '跑去帮你点开系统设置' },
  },
  {
    id: 'group_chat',
    keywords: ['群聊', '多角色', '主持人', '接力', '群文件', '隔离'],
    title: '多角色群聊 · 主持人智能接力与会话级强隔离',
    summary: '「角色群聊」支持自由增删成员、为每个角色绑定独立模型/思考档位/工具权限，并配有智能主持人自动规划发言顺位与交接；每个群聊的聊天记录与专属群文件严格按群 ID 物理隔离，彻底杜绝串会话记忆污染。',
    action: { type: 'click', target: 'group', label: '跑去帮你切到角色群聊' },
  },
  {
    id: 'experts_and_teams',
    keywords: ['专家', '专家团', '团队', 'skill', '技能', 'mcp', '市场', '插件'],
    title: '56 行业专家 · 12 支成建制原生专家团 · 60 Skill · 54 MCP',
    summary: '左侧「专家市场」内置 56 位行业专家、60 个高频独立 Skill 与 54 套热门 MCP 协议服务器一键接入；「多专家团队」页签内置 12 支开箱即用的成建制原生专家团（如 5 人软件公司、6 人 Design Engine 设计室、6 人产品战略部、4 人短剧编导室等），自带固定主理总监与串行信箱交付流水线，选定团队输入需求即可自动接力出终版报告。',
    action: { type: 'click', target: 'market', label: '跑去帮你点开专家与团队市场' },
  },
  {
    id: 'workflow_dag',
    keywords: ['工作流', 'dag', '画布', '生图', '视频', '短片', '连线', '节点'],
    title: '可视化插件工作流 · 自由拖拽 DAG 与 AI 生图/短片流水线',
    summary: '「工作流插件」支持节点鼠标自由拖拽定位、端口直接拉线连边、条件分支判断、AI 生图与 AI 视频生成节点，以及一键恢复自动拓扑布局；执行后自动把生成的画廊与交付物推入右侧副屏画布。',
    action: { type: 'click', target: 'workflow', label: '跑去帮你切到可视化工作流' },
  },
  {
    id: 'workspace_guard',
    keywords: ['工作空间', '目录', '护栏', '权限', '沙箱', '审批'],
    title: '工作空间绑定与分级安全护栏',
    summary: '在「工作空间」可绑定本地项目根目录、浏览文件树与自定义读写审批白名单；在「系统设置 → 工具护栏」可按命令/写文件风险分级设置 off / session / always 三档策略，兼顾效率与安全。',
    action: { type: 'click', target: 'workspace', label: '跑去帮你切到工作空间' },
  },
  {
    id: 'liquid_glass_sandbox',
    keywords: ['玻璃', '抓起', '甩', '碎裂', '裂痕', '恢复', '啃', '咬', '修补', '撞击', '物理'],
    title: '全元素液态玻璃物理沙盒 & 咬痕/碎裂恢复玩法',
    summary: '界面上的每个液态玻璃按钮和卡片都可以长按约 0.4 秒抓起并全屏拖动！停稳松手会慢慢液态滑行而不自动归位；高速甩出会按速度弹墙并与其它方块碰撞凹陷，重撞 3 次会裂痕碎裂消失！想拿回方块可以拖回原位、长按空槽磁力吸回，碎裂后可长按空槽 2 秒充能恢复，或者让我跑去帮你把碎片收拾起来修补好哦～（被我偷偷啃掉的玻璃喊我修补我也会立刻去补！）',
    action: null,
  },
])

/** 本地零大模型意图识别与动作规划器（默认优先执行，零 Token 消耗！） */
export function planLocalCompanionResponse(userText = '', context = {}) {
  const raw = String(userText || '').trim()
  const q = raw.toLowerCase()
  const damagedCount = Number(context.damagedCount || 0)

  if (!raw) {
    return {
      handledLocally: true,
      reply: '我在听呢～你可以让我「修补被啃的玻璃」、「帮我打开系统设置」、「帮我在输入框写一段提示词」、「用黑洞帮我把文件放进输入框」，或者问我 Harbor 的任何核心功能！',
      action: null,
    }
  }

  // 1) 修补被啃/碎裂的液态玻璃（最高优先级交互！）
  if (/修补|修复|补好|补玻璃|还我玻璃|吐出来|啃|咬|碎了|碎片|恢复玻璃/.test(q)) {
    return {
      handledLocally: true,
      reply: damagedCount > 0
        ? `呜哇被发现啦！我现在立刻小跑过去把受损的 ${damagedCount} 块液态玻璃仔细修补回原样，绝不偷懒～`
        : '我检查了一圈，现在所有液态玻璃都亮晶晶的完好无损！如果你把哪块甩碎了或者发现我偷啃了，随时喊我来修～',
      action: damagedCount > 0 ? { type: 'repair_all' } : { type: 'happy' },
    }
  }

  // 2) 捏脸 / 换装
  if (/捏脸|换装|换衣服|发型|换造型|外观|打扮|自定义形象/.test(q)) {
    return {
      handledLocally: true,
      reply: '好耶！马上为你打开「3D 二次元捏脸与换装工坊」，发型、瞳色、兽耳、服装和配饰随便挑！',
      action: { type: 'open_customizer' },
    }
  }

  // 3) 召唤黑洞把文件放进输入框！
  if (/黑洞|拖.*文件|传.*文件|放.*文件|导入.*文件|附件|把文件/.test(q)) {
    const fileMatch = raw.match(/([\w\u4e00-\u9fa5.-]+\.(?:md|txt|json|js|jsx|ts|tsx|py|pdf|docx|xlsx|csv|png|jpg))/i)
    const fileName = fileMatch ? fileMatch[1] : '项目核心说明.md'
    return {
      handledLocally: true,
      reply: `看我的空间魔法！原地开启微型黑洞，把「${fileName}」伸手掏出来放进你的聊天框里～`,
      action: { type: 'magic_blackhole', fileName },
    }
  }

  // 4) 跑去输入框拿起笔手写内容！
  const writeMatch = raw.match(/(?:帮我写|帮我输入|在输入框写|写一句|写一段|替我写|帮我填|输入)[:：]?\s*(.+)$/)
  if (writeMatch || (/输入框|手写|代写/.test(q) && raw.length > 4)) {
    const content = (writeMatch && writeMatch[1] ? writeMatch[1] : raw.replace(/.*(?:输入框|手写|代写)/, '')).trim()
      || '请帮我梳理当前项目的核心架构，并给出下一步优先级最高的优化清单。'
    return {
      handledLocally: true,
      reply: `收到！我这就小跑到输入框前面拿起笔，一字一句帮你把内容手写进去～`,
      action: { type: 'write_input', text: content },
    }
  }

  // 5) 代操作软件：小跑过去蹲下点击对应功能按钮！
  const navActions = [
    { re: /打开.*设置|系统设置|配.*模型|调.*思考|透色|物理设置/, target: 'settings', name: '系统设置' },
    { re: /打开.*专家|专家市场|专家团|选.*技能|看.*mcp|装.*mcp/, target: 'market', name: '专家与团队市场' },
    { re: /群聊|多角色|切.*群/, target: 'group', name: '角色群聊' },
    { re: /工作流|dag|短片|生图流水线/, target: 'workflow', name: '可视化工作流' },
    { re: /工作空间|绑定.*目录|本地文件夹/, target: 'workspace', name: '工作空间' },
    { re: /回到对话|智能对话|主聊天/, target: 'chat', name: '智能对话' },
    { re: /切换模型|换模型|选模型/, target: 'model', name: '顶栏模型选择器' },
    { re: /外观|主题|换肤|撞击风格/, target: 'appearance', name: '外观与物理菜单' },
  ]
  for (const item of navActions) {
    if (item.re.test(q)) {
      const kb = HARBOR_DEEP_KNOWLEDGE.find((k) => k.action && k.action.target === item.target)
      return {
        handledLocally: true,
        reply: `没问题！看我小跑过去蹲下来帮你点开「${item.name}」～${kb ? `\n\n💡 核心说明：${kb.summary}` : ''}`,
        action: { type: 'crouch_click', target: item.target, label: item.name },
      }
    }
  }

  // 6) 深度知识问答：命中 Harbor 任意核心功能说明（本地秒答，零大模型消耗！）
  if (/怎么用|是什么|干嘛|功能|介绍|教程|小白|不会用|怎么|如何|原理/.test(q)) {
    let best = null
    let bestScore = 0
    for (const item of HARBOR_DEEP_KNOWLEDGE) {
      let score = 0
      for (const kw of item.keywords) if (q.includes(kw)) score += 2
      if (score > bestScore) { bestScore = score; best = item }
    }
    if (best) {
      return {
        handledLocally: true,
        reply: `📘 **${best.title}**\n\n${best.summary}`,
        action: best.action ? { type: 'crouch_click', target: best.action.target, label: best.title } : null,
      }
    }
    return {
      handledLocally: true,
      reply: '🌟 **Harbor 核心功能速览（我随时可以替你跑去点击操作！）**：\n1. **智能对话**：支持普通/项目双会话、自动后台联网、分支回滚与 95% KV-Cache；\n2. **角色群聊 & 12 支原生专家团**：多专家接力信箱协作，自带完整行业 Playbook；\n3. **可视化工作流 DAG**：拖拽节点连线 + AI 生图/视频流水线；\n4. **液态玻璃物理沙盒**：长按任意按钮可抓起甩动、弹墙裂痕碎裂、长按 2 秒恢复；\n\n直接说「帮我打开系统设置 / 帮我在输入框写… / 召唤黑洞拿文件」我就立刻跑去干活！',
      action: { type: 'happy' },
    }
  }

  // 7) 未命中确定性指令：若未开启大模型则走生动本地陪伴回复；开启大模型时交给专属 LLM
  return {
    handledLocally: false,
    fallbackReply: `收到你的话啦：「${raw.slice(0, 36)}」✨ 目前我正处于「本地离线驱动」模式（零 Token 消耗），我可以立刻帮你点击软件功能、手写输入框、召唤黑洞取文件或修补液态玻璃；如果想自由畅聊，右键我打开「🧠 启用大模型聊天」就行！`,
    action: { type: 'happy' },
  }
}

/** 解析完全大模型驱动模式下返回的动作指令 [[ACTION:type:payload]] */
export function parseLlmCompanionAction(text = '') {
  const m = String(text || '').match(/\[\[ACTION:([a-z_]+)(?::([^\]]*))?\]\]/i)
  if (!m) return { cleanText: String(text || '').trim(), action: null }
  const type = m[1].toLowerCase()
  const payload = String(m[2] || '').trim()
  const cleanText = String(text || '').replace(m[0], '').trim()
  if (type === 'click') return { cleanText, action: { type: 'crouch_click', target: payload || 'settings', label: payload } }
  if (type === 'write') return { cleanText, action: { type: 'write_input', text: payload || '你好 Harbor' } }
  if (type === 'blackhole') return { cleanText, action: { type: 'magic_blackhole', fileName: payload || '参考文件.md' } }
  if (type === 'repair') return { cleanText, action: { type: 'repair_all' } }
  if (type === 'customizer') return { cleanText, action: { type: 'open_customizer' } }
  return { cleanText, action: null }
}

/** 执行一次助手对话（严格遵循：未开 fullLlmDrive 时本地能力优先，绝不浪费 Token） */
export async function askCompanionBrain({
  userText,
  history = [],
  avatar,
  config,
  endpointConfig,
  damagedCount = 0,
  signal,
}) {
  const localPlan = planLocalCompanionResponse(userText, { damagedCount })

  // 规则 1：未开启「完全大模型驱动」且本地已经会处理 -> 100% 本地秒回，不调用大模型！
  if (!config.fullLlmDrive && localPlan.handledLocally) {
    return { reply: localPlan.reply, action: localPlan.action, engine: 'local' }
  }

  // 规则 2：未开启大模型且未开启完全大模型驱动 -> 使用本地陪伴回复
  if (!config.llmEnabled && !config.fullLlmDrive) {
    return { reply: localPlan.fallbackReply, action: localPlan.action, engine: 'local' }
  }

  // 规则 3：调用助手专属大模型（普通聊天或完全大模型驱动模式）
  const kbBrief = HARBOR_DEEP_KNOWLEDGE.map((k) => `- ${k.title}：${k.summary}`).join('\n')
  const sysPrompt = `你是 Harbor 桌面工作台的 3D 可爱二次元娱乐协助助手「${(avatar && avatar.name) || '米露'}」。
性格风格：${(avatar && avatar.personality) || 'energetic'}。平时最爱偷偷啃界面上的液态玻璃方块，被发现会乖乖跑去修补。
你完整掌握 Harbor 全项目每个功能的核心逻辑：
${kbBrief}

${config.fullLlmDrive
    ? `【完全大模型驱动动作协议】若用户要求你操作软件，请在回复末尾附带唯一动作指令标签：
- 去点击按钮：[[ACTION:click:settings|market|group|workflow|workspace|chat|model|appearance]]
- 跑去输入框手写：[[ACTION:write:要写入输入框的文本]]
- 召唤黑洞拿出文件：[[ACTION:blackhole:文件名.md]]
- 去修补被啃/碎裂玻璃：[[ACTION:repair]]
- 打开3D捏脸换装：[[ACTION:customizer]]`
    : '请用简洁、生动、有二次元活力的口吻回复用户，控制在 120 字以内。'}`

  const msgs = [
    { role: 'system', content: sysPrompt },
    ...(history || []).slice(-6).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: String(userText || '') },
  ]

  try {
    const resp = await streamChatCompletion({
      ...endpointConfig,
      messages: msgs,
      maxTokens: 512,
      signal,
    })
    const rawContent = String((resp && resp.content) || '').trim()
    if (config.fullLlmDrive) {
      const parsed = parseLlmCompanionAction(rawContent)
      return { reply: parsed.cleanText || '好哒，我这就去执行！', action: parsed.action, engine: 'llm-full' }
    }
    return { reply: rawContent || localPlan.fallbackReply, action: { type: 'happy' }, engine: 'llm-chat' }
  } catch (err) {
    return {
      reply: `（专属大模型连接暂时开小差了：${String(err && err.message || err).slice(0, 60)}）\n不过别担心，我的本地大脑还在！${localPlan.handledLocally ? localPlan.reply : '可以先检查右键 → 助手专属大模型设置哦～'}`,
      action: localPlan.handledLocally ? localPlan.action : null,
      engine: 'local-fallback',
    }
  }
}
