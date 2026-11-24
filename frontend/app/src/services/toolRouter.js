/**
 * 智能工具域预判路由器 + 效果确认工具定义（R11）：
 *
 * 核心价值：
 *   1. 解决“所有 33 个工具一股脑塞进缓存导致每轮平白多消耗 3,500–4,500 Token”的问题；
 *   2. 按任务语义预判所需最小工具集（chat / coding / web / coding_web / full），单会话内单调锁死
 *      （Sticky Monotonic Profile），既省 55%–85% 工具 Schema Token，又 100% 保护多轮 KV-Cache 前缀！
 *   3. 提供前端原生交互工具 `ask_user_options` 与自主发挥意图检测 `isAutonomousAuthorized()`，
 *      让普通会话与群聊在涉及视觉风格/交互效果/架构分叉时，先弹可视化选择卡片让用户拍板再落地。
 */

export const ASK_USER_OPTIONS_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'ask_user_options',
    description:
      '当任务涉及视觉风格、界面配色、交互效果、版面布局、功能范围或关键技术路线等主观/分叉选择，且用户未明确说「自主发挥/直接做/不要问我」时，在动手写代码或正式落地前先调用此工具弹出可视化选项卡片，向用户提供 2-4 个具体方案（自动支持用户自定义输入），拿到明确拍板后再精准执行。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '决策卡片标题，如「选择网页视觉风格与核心动效」' },
        subtitle: { type: 'string', description: '简短说明为什么需要用户确认，或不同选项的核心差异' },
        allow_custom: { type: 'boolean', description: '是否允许用户输入自定义要求（默认 true）' },
        questions: {
          type: 'array',
          description: '1 到 3 个聚焦的核心决策项（避免问繁琐细节）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: '问题标题，如「视觉风格方向」' },
              multi: { type: 'boolean', description: '是否多选（默认 false 单选）' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string', description: '选项名称（简短鲜明）' },
                    desc: { type: 'string', description: '一句话具体效果描述' },
                    tag: { type: 'string', description: '可选标签，如「推荐」「极简」「炫酷」' },
                  },
                  required: ['id', 'label'],
                },
              },
            },
            required: ['id', 'label', 'options'],
          },
        },
      },
      required: ['title', 'questions'],
    },
  },
})

const TOOL_GROUPS = Object.freeze({
  core_chat: new Set(['ask_user_options', 'memory_search', 'memory_write', 'append_memory']),
  files: new Set([
    'read_file', 'write_file', 'append_file', 'search_replace', 'list_dir',
    'make_dir', 'delete_path', 'move_path', 'copy_path', 'get_file_info', 'read_more',
  ]),
  shell: new Set(['run_command', 'run_powershell']),
  web: new Set([
    'browser_search', 'browser_open', 'browser_navigate', 'browser_extract',
    'browser_snapshot', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close',
    'open_url',
  ]),
  desktop: new Set([
    'open_app', 'open_url', 'take_screenshot', 'clipboard_read', 'clipboard_write',
    'list_processes', 'kill_process', 'software_call', 'run_admin_command', 'inspect_tool_schema',
  ]),
})

/** 群聊专属群文件只读工具（仅在群聊会话中挂载，且强制锁死在当前 groupId 独立目录内） */
export const GROUP_FILE_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'group_file_list',
      description: '列出「当前群聊」专属群文件目录中的交接文档清单（与其他群聊完全隔离，不可跨群访问）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'group_file_read',
      description: '读取「当前群聊」专属群文件中的指定文档全文（仅限本群文件，传 group_file_list 返回的 name）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '本群文件的文件名（由 group_file_list 返回）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'group_file_search',
      description: '在「当前群聊」专属群文件中按关键词检索片段（仅检索本群，不访问其他群聊）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          limit: { type: 'integer', description: '返回条数上限（默认 6）' },
        },
        required: ['query'],
      },
    },
  },
])

/** 一等多模态媒体生成工具（兼容 GLM CogView/CogVideoX、OpenAI GPT-Image/Sora、SiliconFlow Flux、MiniMax 与本地网关） */
export const GENERATE_IMAGE_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      '调用已配置的图片生成模型（兼容 CogView-4 / GPT-Image-1 / FLUX / MiniMax / 本地 ComfyUI 网关）根据文字提示词生成高清图片，自动在右侧实时画布展示成图并返回图片地址。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '详细画面描述（主体、光影、构图、质感、镜头风格）' },
        aspect_ratio: { type: 'string', description: '画幅比例：1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 21:9（默认 1:1）' },
        size: { type: 'string', description: '可选精确像素尺寸，如 1024x1024 / 1344x768' },
        style: { type: 'string', description: '可选美学风格，如 赛博朋克 / 胶片质感 / 极简扁平 / 3D 渲染' },
        quality: { type: 'string', description: '画质档位：standard 或 hd' },
        model: { type: 'string', description: '可选指定生图模型名（留空使用设置中心默认生图模型）' },
      },
      required: ['prompt'],
    },
  },
})

export const GENERATE_VIDEO_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'generate_video',
    description:
      '调用已配置的视频生成模型（兼容 CogVideoX-3 / Sora-2 / Wan2.1 / MiniMax video-01）生成短视频；传入 image_url 时自动切换为「图生视频 (I2V)」模式，自动轮询渲染并在右侧实时画布播放。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '镜头运动、主体动作、光影节奏与氛围描述' },
        image_url: { type: 'string', description: '可选首帧参考图 URL（传入后进入图生视频 I2V 模式）' },
        duration: { type: 'integer', description: '视频时长（秒，常见 5 或 10）' },
        aspect_ratio: { type: 'string', description: '画幅比例：16:9 / 9:16 / 1:1（默认 16:9）' },
        resolution: { type: 'string', description: '分辨率档位：720p / 1080p / 4k' },
        with_audio: { type: 'boolean', description: '是否同时生成环境音效（若模型支持）' },
        model: { type: 'string', description: '可选指定视频模型名（留空使用设置中心默认视频模型）' },
      },
      required: ['prompt'],
    },
  },
})

export const TOOL_PROFILE_META = Object.freeze({
  chat: { id: 'chat', label: '轻量对话', desc: '仅挂载记忆与交互确认（省 ~90% 工具 Token）' },
  coding: { id: 'coding', label: '代码与文件', desc: '文件读写 + 终端命令 + 效果确认（省 ~60% 工具 Token）' },
  web: { id: 'web', label: '联网与调研', desc: '浏览器检索/抓取 + 文件保存 + 效果确认' },
  media: { id: 'media', label: '视觉与视频创作', desc: '文生图 + 文生/图生视频 + 效果确认（省 ~80% 无关工具 Token）' },
  coding_web: { id: 'coding_web', label: '全栈研发+联网', desc: '文件/命令 + 联网检索 + 效果确认' },
  full: { id: 'full', label: '全量桌面工具', desc: '全部文件/命令/浏览器/系统/MCP/媒体工具' },
})

export function isAutonomousAuthorized(text = '') {
  const s = String(text || '').trim()
  if (!s) return false
  return /自主发挥|自由发挥|自行决定|你决定|你来定|你看着办|不用问|别问|不要问|直接做|直接开始|直接生成|全权负责|全权决定|直接落地|自行发挥|don'?t\s+ask|just\s+do\s+it|autonomous|yolo/i.test(s)
}

export function predictToolProfile(query = '', { hasEnabledMcp = false, forceFull = false, prevProfile = '' } = {}) {
  const q = String(query || '').trim()
  if (forceFull) return 'full'

  const wantsDesktop = /截图|截屏|剪贴板|进程|杀进程|打开软件|打开应用|管理员|powershell\s+提权|ffmpeg|python\s+外部|software_call|mcp/i.test(q) || hasEnabledMcp
  const wantsMedia = /画一张|画一幅|生图|文生图|图生图|生成图片|做海报|海报图|配图|封面图|插画|生成视频|文生视频|图生视频|拍一段|短片视频|分镜视频|cogview|cogvideo|sora|flux|dall-e|t2i|t2v|i2v/i.test(q)
  const wantsWeb = /上网|搜索|查一下|最新|官网|网页内容|抓取|爬取|打开网址|http:\/\/|https:\/\/|新闻|调研|竞品|行情|浏览器打开/i.test(q)
  const wantsCodeOrFile = /文件|目录|桌面|工作区|代码|重构|网页|页面|网站|项目|脚本|html|css|js|jsx|ts|tsx|json|md|python|node|react|sql|bug|报错|修复|写一个|做一个|创建|生成|修改|删除|运行|测试|构建|打包|钟摆|时钟|ui|界面|设计|动画|组件|工具/i.test(q)

  const CODE_ACTION = /写|做|创建|生成|修改|重构|修复|运行|测试|构建|打包|实现|搭建|落盘|增删|改成|删掉|加上/i
  const codeIsAction = CODE_ACTION.test(q)

  let next = 'chat'
  if (wantsDesktop) next = 'full'
  else if (wantsMedia && !/html|css|js|react|代码|网页|脚本/i.test(q)) next = 'media'
  else if (wantsCodeOrFile && wantsWeb) next = codeIsAction ? 'coding_web' : 'web'
  else if (wantsCodeOrFile) next = 'coding'
  else if (wantsWeb) next = 'web'
  else next = 'chat'

  if (!prevProfile || prevProfile === next) return next
  if (prevProfile === 'full' || next === 'full') return 'full'
  if ((prevProfile === 'coding' && next === 'web') || (prevProfile === 'web' && next === 'coding')) return 'coding_web'
  if (prevProfile === 'coding_web') return 'coding_web'
  if (prevProfile === 'coding' && next === 'chat') return 'coding'
  if (prevProfile === 'web' && next === 'chat') return 'web'
  return next
}

export function selectToolsForProfile(allTools = [], profile = 'coding', { includeAskUser = true, isolatedGroup = false, webSearchMode = '' } = {}) {
  const list = Array.isArray(allTools) ? allTools : []
  const allowed = new Set(isolatedGroup ? ['ask_user_options'] : TOOL_GROUPS.core_chat)

  if (profile === 'media') {
    allowed.add('read_file')
    allowed.add('write_file')
  } else if (profile === 'coding') {
    for (const t of TOOL_GROUPS.files) allowed.add(t)
    for (const t of TOOL_GROUPS.shell) allowed.add(t)
  } else if (profile === 'web') {
    for (const t of TOOL_GROUPS.web) allowed.add(t)
    allowed.add('read_file')
    allowed.add('write_file')
    allowed.add('read_more')
  } else if (profile === 'coding_web') {
    for (const t of TOOL_GROUPS.files) allowed.add(t)
    for (const t of TOOL_GROUPS.shell) allowed.add(t)
    for (const t of TOOL_GROUPS.web) allowed.add(t)
  }

  if (webSearchMode === 'auto') {
    allowed.add('browser_search')
    allowed.add('browser_open')
  } else if (webSearchMode === 'visible') {
    for (const t of TOOL_GROUPS.web) allowed.add(t)
  }

  let filtered = profile === 'full'
    ? [...list]
    : list.filter((item) => {
      const name = String((item && item.function && item.function.name) || (item && item.name) || '')
      return name && (allowed.has(name) || name.startsWith('mcp__'))
    })

  if (webSearchMode === 'off') {
    filtered = filtered.filter((item) => {
      const name = String((item && item.function && item.function.name) || (item && item.name) || '')
      return !TOOL_GROUPS.web.has(name)
    })
  }

  // 群聊强隔离：剔除跨会话全局记忆工具，注入仅绑定当前群聊 ID 的专属群文件工具
  const result = isolatedGroup
    ? filtered.filter((t) => {
      const n = String((t && t.function && t.function.name) || '')
      return n !== 'memory_search' && n !== 'memory_write' && n !== 'append_memory'
    })
    : filtered

  if (isolatedGroup) {
    for (const gt of GROUP_FILE_TOOLS) {
      if (!result.some((t) => ((t && t.function && t.function.name) || '') === gt.function.name)) {
        result.push(gt)
      }
    }
  }
  if (profile === 'media' || profile === 'full') {
    for (const mt of [GENERATE_IMAGE_TOOL, GENERATE_VIDEO_TOOL]) {
      if (!result.some((t) => ((t && t.function && t.function.name) || '') === mt.function.name)) {
        result.push(mt)
      }
    }
  }
  if (includeAskUser && !result.some((t) => ((t && t.function && t.function.name) || '') === 'ask_user_options')) {
    result.push(ASK_USER_OPTIONS_TOOL)
  }
  return result
}

export function buildClarifyDirective({ autonomous = false, askBeforeDesign = true } = {}) {
  if (autonomous || !askBeforeDesign) {
    return '【执行自主度】用户已授权自主发挥：无需调用 ask_user_options 询问风格或方案，直接按最高审美与工程标准高质量落地。'
  }
  return '【效果可控原则】若当前需求涉及视觉风格、交互动效、版面结构或方案取舍且用户未指定细节，在写文件或正式落地前先调用一次 ask_user_options 弹出 2-4 个具体方案卡片供用户选择或自定义，拿到确认后再严格按所选方向实现；若需求已非常具体或属于排障/查询类任务，直接执行即可，不要多此一举。'
}


/** R22 前沿 Agent 自主联网策略提示（对齐 Claude / ChatGPT / Perplexity / Manus 行为范式） */
export function buildWebSearchDirective(webSearchMode = 'auto') {
  if (webSearchMode === 'off') {
    return '【联网策略】当前为离线模式，严禁调用任何网页检索工具，请仅基于已有知识与本地工作区文件作答。'
  }
  if (webSearchMode === 'visible') {
    return '【前沿 Agent 联网策略 · 前台可视模式】当需要实时信息、外部网页核查或演示浏览时，调用 browser_search / browser_navigate 并显式传 mode="visible" 弹出前台浏览器窗口供用户实时观看；阅读具体网页可用 browser_open，回答末尾以 [来源标题](URL) 标注参考出处。'
  }
  return '【前沿 Agent 联网策略 · 自主后台模式】用户无需手动搜索——当问题涉及实时动态、最新价格/版本/新闻、事实核查或你不确定的外部信息时，请自主在后台静默调用 browser_search（默认 mode="hidden"），并对关键条目调用 browser_open 阅读原文，回答中以 [来源标题](URL) 标注信息出处；仅当用户明确要求「前台打开给我看 / 打开浏览器操作」或遇到需要人工登录验证的站点时，才传 mode="visible" 弹出可见浏览器窗口。'
}
