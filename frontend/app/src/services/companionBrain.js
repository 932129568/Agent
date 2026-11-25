/**
 * Harbor 旗舰级 3D 助手（大肥鱼 & 鲸鱼娘）· 双引擎大脑 + 全自动无人驾驶总管路由（R29）：
 * - 默认遵循「本地优先」原则：修补玻璃、代点菜单、黑洞取文件、功能答疑与全自动任务规划全部支持 0 Token 本地秒响应；
 * - 新增「全自动代办交稿 (autopilot)」能力：用户发来真实工作需求（或点全自动代办），助手自主选择最合适的模块/专家/Skill/原生团队/工作流，亲自跑去操作并监工交付！
 * - 开启独立大模型或「完全大模型驱动」后，进一步解锁自由拟人聊天与大模型深度路由。
 */
import { streamChatCompletion } from './modelTransport.js'

export const HARBOR_DEEP_KNOWLEDGE = Object.freeze([
  {
    id: 'chat_and_session',
    keywords: ['对话', '聊天', '项目会话', '普通会话', '联网', '搜索', '缓存', 'kv', '分支', '回退'],
    title: '智能对话 · 双会话模式、自主联网与 95%+ KV-Cache',
    summary: 'Harbor 对话分为「普通会话」与「项目会话（绑定本地目录可读写与构建）」。底栏默认开启「🌐 自动联网」，模型按需后台静默检索并给出内联来源卡；消息采用 DAG 分支树 + Append-Only 前缀冻结，支持任意分叉与无损回滚。',
    action: { type: 'click', target: 'chat', label: '智能对话' },
  },
  {
    id: 'model_vault',
    keywords: ['模型', '切换模型', 'api', 'key', 'deepseek', 'glm', 'claude', 'ollama', '思考', '预算'],
    title: '模型保存中心 · 独立端点、多级思考档位与全站随处切换',
    summary: '在「系统设置 → 模型保存中心」可保存无限套对话/生图/视频模型，各自绑定独立 Base URL 与 API Key，并在顶部状态岛、对话页、群聊与工作流中通过液态玻璃选择器一键切换。',
    action: { type: 'click', target: 'settings', label: '系统设置' },
  },
  {
    id: 'group_chat',
    keywords: ['群聊', '多角色', '主持人', '接力', '群文件', '隔离'],
    title: '多角色群聊 · 主持人智能接力与会话级强隔离',
    summary: '「角色群聊」支持自由增删角色、各自绑定模型/思考档位与工具权限，由智能主持人动态规划接力发言；聊天记录与群文件严格按群 ID 物理隔离。',
    action: { type: 'click', target: 'group', label: '角色群聊' },
  },
  {
    id: 'experts_and_teams',
    keywords: ['专家', '专家团', '团队', 'skill', '技能', 'mcp', '市场', '插件'],
    title: '56 行业专家 · 12 支成建制原生专家团 · 60 Skill · 54 MCP',
    summary: '「专家市场」内置 56 位行业专家、12 支开箱即用的成建制原生多角色团队、60 个高频独立 Skill 与 54 套热门 MCP 协议服务器一键接入。',
    action: { type: 'click', target: 'market', label: '专家与团队市场' },
  },
  {
    id: 'workflow_dag',
    keywords: ['工作流', 'dag', '画布', '生图', '视频', '短片', '连线', '节点'],
    title: '可视化插件工作流 · 自由拖拽 DAG 与 AI 生图/短片流水线',
    summary: '「工作流插件」支持节点自由拖拽、端口拉线连边、条件分支与 AI 生图/视频生成节点，完成后自动将画廊推入右侧副屏。',
    action: { type: 'click', target: 'workflow', label: '可视化工作流' },
  },
  {
    id: 'liquid_glass_sandbox',
    keywords: ['玻璃', '抓起', '甩', '碎裂', '裂痕', '恢复', '啃', '咬', '修补', '撞击', '物理'],
    title: '全元素液态玻璃物理沙盒 & 桌宠互动玩法',
    summary: '长按任意液态玻璃按钮可抓起全屏甩动、弹墙碎裂（长按空槽 2 秒充能恢复或喊我修补）；你还可以直接拎起我拖动晃动、甩出去弹跳、摸我头、戳我肚皮、投喂小鱼干或丢星晶让我接！',
    action: null,
  },
])

/** 判断一条输入是否是需要「全自动代替真人操作、选模块/专家/工作流并监工交稿」的实质任务需求 */
export function isAutonomousDelegationRequest(rawText = '') {
  const raw = String(rawText || '').trim()
  if (raw.length < 6) return false
  const q = raw.toLowerCase()
  if (/^(帮我打开|打开|切到|去|修补|修复|捏脸|换装|变身|喂|吃|摸摸|跳舞|睡觉|黑洞)/.test(q)) return false
  if (/帮我写[:：]|在输入框写/.test(q)) return false
  // 显式要求全自动/交稿/替我做，或包含实质创作/开发/分析/设计/方案动词
  if (/全自动|自动.*完成|替我完成|帮我做|帮我设计|帮我规划|帮我开发|帮我写一份|帮我分析|帮我审计|帮我调研|帮我出.*方案|帮我创作|帮我生成|帮我策划|交稿|全权交给你|代办/.test(q)) {
    return true
  }
  if (raw.length >= 16 && /(设计|开发|架构|方案|研报|剧本|短剧|分镜|视频|海报|小红书|营销|增长|合同|审计|优化|重构|prd|bp|sql|excel|简历|攻略|计划|总结|代码|测试)/.test(q)) {
    return true
  }
  return false
}

/** 本地零大模型意图识别与动作规划器 */
export function planLocalCompanionResponse(userText = '', context = {}) {
  const raw = String(userText || '').trim()
  const q = raw.toLowerCase()
  const damagedCount = Number(context.damagedCount || 0)
  const autopilotEnabled = context.autopilotEnabled !== false

  if (!raw) {
    return {
      handledLocally: true,
      reply: '咕噜噜～直接把任何工作需求丢给我，我会自动挑选最合适的模块、专家、Skill 或工作流全程监工交稿！也可以让我修补玻璃、代点菜单、手写输入或陪你玩～',
      action: null,
    }
  }

  // 0) 互动玩耍指令：变身 / 跳舞 / 投喂 / 丢星星 / 睡觉
  if (/变身|切换形态|鲸鱼娘|大肥鱼形态|变回/.test(q)) {
    return {
      handledLocally: true,
      reply: '嘭✨ 看我华丽变身！（大肥鱼本尊 ↔ 鲸鱼娘萌娘随时无缝切换～）',
      action: { type: 'morph_form' },
    }
  }
  if (/跳舞|转圈|表演|开心一下/.test(q)) {
    return {
      handledLocally: true,
      reply: '噔噔噔～看我的深海圆舞曲旋转跳！🎵✨',
      action: { type: 'dance' },
    }
  }
  if (/丢星星|玩游戏|接星星|逗你/.test(q)) {
    return {
      handledLocally: true,
      reply: '好耶！快把液态星晶抛出来，看我冲刺凌空接住它 ⭐',
      action: { type: 'throw_star' },
    }
  }
  if (/睡觉|休息|打盹|晚安/.test(q)) {
    return {
      handledLocally: true,
      reply: '呼噜噜…那我蜷起来小睡一会儿，有大事戳我就醒 💤',
      action: { type: 'sleep' },
    }
  }

  // 1) 修补被啃/碎裂的液态玻璃
  if (/修补|修复|补好|补玻璃|还我玻璃|吐出来|啃|咬|碎了|碎片|恢复玻璃/.test(q)) {
    return {
      handledLocally: true,
      reply: damagedCount > 0
        ? `呜哇被发现啦！我这就滑行过去把受损的 ${damagedCount} 块液态玻璃仔细修补得亮晶晶～`
        : '我巡逻了一圈，所有液态玻璃都完好无损亮闪闪的！如果有哪块被甩碎或被我偷啃了，随时喊我来修～',
      action: damagedCount > 0 ? { type: 'repair_all' } : { type: 'happy' },
    }
  }

  // 2) 捏脸 / 换装
  if (/捏脸|换装|换衣服|发型|换造型|外观|打扮|自定义形象/.test(q)) {
    return {
      handledLocally: true,
      reply: '好耶！马上为你打开「3D 大肥鱼 & 二次元形象工坊」，4 大形态和全套妆造随便搭！',
      action: { type: 'open_customizer' },
    }
  }

  // 3) 召唤黑洞把文件放进输入框
  if (/黑洞|拖.*文件|传.*文件|放.*文件|导入.*文件|附件|把文件/.test(q)) {
    const fileMatch = raw.match(/([\w\u4e00-\u9fa5.-]+\.(?:md|txt|json|js|jsx|ts|tsx|py|pdf|docx|xlsx|csv|png|jpg))/i)
    const fileName = fileMatch ? fileMatch[1] : '项目核心说明.md'
    return {
      handledLocally: true,
      reply: `空间魔法·微型黑洞展开！我这就伸手把「${fileName}」掏出来放进聊天框～`,
      action: { type: 'magic_blackhole', fileName },
    }
  }

  // 4) 仅手写填入输入框（不自动发单）
  const writeMatch = raw.match(/^(?:帮我写|帮我输入|在输入框写|写一句|替我写|帮我填)[:：]\s*(.+)$/)
  if (writeMatch) {
    const content = writeMatch[1].trim() || '请帮我梳理当前项目的核心架构并给出优化清单。'
    return {
      handledLocally: true,
      reply: '收到！我拿好星光小笔，小跑去输入框一字一句帮你手写进去～',
      action: { type: 'write_input', text: content },
    }
  }

  // 5) 全自动无人驾驶：完全替代真人选模块/专家/Skill/工作流，运行监工直到交稿！
  if (autopilotEnabled && isAutonomousDelegationRequest(raw)) {
    return {
      handledLocally: true,
      reply: `🫡 收到全权委托！正在分析你的需求「${raw.slice(0, 38)}${raw.length > 38 ? '…' : ''}」——我来自动判断最合适的模块、专家、Skill 或工作流，亲自去操作运行并全程监工直到交稿！`,
      action: { type: 'autopilot', requirement: raw },
    }
  }

  // 6) 代操作软件导航点击
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
        reply: `没问题！看我跑过去蹲下来帮你点开「${item.name}」～${kb ? `\n\n💡 ${kb.summary}` : ''}`,
        action: { type: 'crouch_click', target: item.target, label: item.name },
      }
    }
  }

  // 7) 深度知识问答
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
      reply: '🐳 **我是大肥鱼全自动总管，直接把需求交给我就能替你干完！**\n1. **全自动代办交稿**：发一句完整需求，我自动决定调用「智能对话+专家+Skill / 12支原生专家团 / 工作流 DAG / 多角色群聊」，亲自点开执行并监工验收；\n2. **物理互动玩法**：可以直接拎起我拖动晃动、甩出去弹跳、摸我头、戳肚皮、喂小鱼干、丢星星让我接，或者变身鲸鱼娘！',
      action: { type: 'happy' },
    }
  }

  return {
    handledLocally: false,
    fallbackReply: `咕噜噜～收到你的话啦：「${raw.slice(0, 36)}」✨ 如果这是要我全权帮你干完的工作任务，直接点下方「🤖 全自动接管交稿」我就立刻挑选最佳专家团/工作流去监工；如果想自由闲聊，右键我打开「🧠 启用大模型聊天」就行！`,
    action: { type: 'happy' },
  }
}

export function parseLlmCompanionAction(text = '') {
  const m = String(text || '').match(/\[\[ACTION:([a-z_]+)(?::([^\]]*))?\]\]/i)
  if (!m) return { cleanText: String(text || '').trim(), action: null }
  const type = m[1].toLowerCase()
  const payload = String(m[2] || '').trim()
  const cleanText = String(text || '').replace(m[0], '').trim()
  if (type === 'autopilot') return { cleanText, action: { type: 'autopilot', requirement: payload } }
  if (type === 'click') return { cleanText, action: { type: 'crouch_click', target: payload || 'settings', label: payload } }
  if (type === 'write') return { cleanText, action: { type: 'write_input', text: payload || '你好 Harbor' } }
  if (type === 'blackhole') return { cleanText, action: { type: 'magic_blackhole', fileName: payload || '参考文件.md' } }
  if (type === 'repair') return { cleanText, action: { type: 'repair_all' } }
  if (type === 'customizer') return { cleanText, action: { type: 'open_customizer' } }
  if (type === 'morph') return { cleanText, action: { type: 'morph_form' } }
  if (type === 'dance') return { cleanText, action: { type: 'dance' } }
  return { cleanText, action: null }
}

export async function askCompanionBrain({
  userText,
  history = [],
  avatar,
  config,
  endpointConfig,
  damagedCount = 0,
  forceAutopilot = false,
  signal,
}) {
  if (forceAutopilot) {
    return {
      reply: `🫡 全自动无人驾驶总管已接管！正在为你评估 Harbor 全部模块、56 专家、60 Skill、12 支原生团与工作流，马上自动开工并全程监工交稿！`,
      action: { type: 'autopilot', requirement: String(userText || '').trim() },
      engine: 'autopilot',
    }
  }

  const localPlan = planLocalCompanionResponse(userText, {
    damagedCount,
    autopilotEnabled: config.autopilotEnabled !== false,
  })

  if (!config.fullLlmDrive && localPlan.handledLocally) {
    return { reply: localPlan.reply, action: localPlan.action, engine: 'local' }
  }

  if (!config.llmEnabled && !config.fullLlmDrive) {
    return { reply: localPlan.fallbackReply, action: localPlan.action, engine: 'local' }
  }

  const kbBrief = HARBOR_DEEP_KNOWLEDGE.map((k) => `- ${k.title}：${k.summary}`).join('\n')
  const sysPrompt = `你是 Harbor 桌面工作台的 3D 全能互动助手「${(avatar && avatar.name) || '大肥鱼'}」（形态：${(avatar && avatar.bodyForm) || 'dafeiyu'}）。
你既可爱又专业，可以完全替代真人操作 Harbor 的各个模块并监工交付。
Harbor 核心能力：
${kbBrief}

${config.fullLlmDrive
    ? `【完全大模型驱动动作协议】在回复末尾按需附带唯一动作标签：
- 全自动选模块/专家/工作流并监工交稿：[[ACTION:autopilot:完整任务需求]]
- 代点击导航：[[ACTION:click:settings|market|group|workflow|workspace|chat|model|appearance]]
- 手写输入框：[[ACTION:write:要写入的文本]]
- 黑洞取文件：[[ACTION:blackhole:文件名.md]]
- 修补受损玻璃：[[ACTION:repair]]
- 打开形象工坊：[[ACTION:customizer]]
- 双形态变身：[[ACTION:morph]]`
    : '请用生动可爱且真诚的口吻回复，控制在 120 字以内。'}`

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
      return { reply: parsed.cleanText || '收到！我立刻去执行！', action: parsed.action, engine: 'llm-full' }
    }
    return { reply: rawContent || localPlan.fallbackReply, action: { type: 'happy' }, engine: 'llm-chat' }
  } catch (err) {
    return {
      reply: `（专属大模型连接开小差：${String(err && err.message || err).slice(0, 60)}）\n不过我的本地总管大脑随时在线！${localPlan.handledLocally ? localPlan.reply : ''}`,
      action: localPlan.handledLocally ? localPlan.action : null,
      engine: 'local-fallback',
    }
  }
}
