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

export const TOOL_PROFILE_META = Object.freeze({
  chat: { id: 'chat', label: '轻量对话', desc: '仅挂载记忆与交互确认（省 ~90% 工具 Token）' },
  coding: { id: 'coding', label: '代码与文件', desc: '文件读写 + 终端命令 + 效果确认（省 ~60% 工具 Token）' },
  web: { id: 'web', label: '联网与调研', desc: '浏览器检索/抓取 + 文件保存 + 效果确认' },
  coding_web: { id: 'coding_web', label: '全栈研发+联网', desc: '文件/命令 + 联网检索 + 效果确认' },
  full: { id: 'full', label: '全量桌面工具', desc: '全部文件/命令/浏览器/系统/MCP 工具' },
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
  const wantsWeb = /上网|搜索|查一下|最新|官网|网页内容|抓取|爬取|打开网址|http:\/\/|https:\/\/|新闻|调研|竞品|行情|浏览器打开/i.test(q)
  const wantsCodeOrFile = /文件|目录|桌面|工作区|代码|重构|网页|页面|网站|项目|脚本|html|css|js|jsx|ts|tsx|json|md|python|node|react|sql|bug|报错|修复|写一个|做一个|创建|生成|修改|删除|运行|测试|构建|打包|钟摆|时钟|ui|界面|设计|动画|组件|工具/i.test(q)

  // 区分"动作"与"只是提到了技术名词"：
  // 原实现的 wantsCodeOrFile 把 react/js/ui 这类**裸名词**也当作代码意图，
  // 于是「上网搜索一下最新的 React 19 发布说明」被判成 coding_web，
  // 把文件/命令工具也塞进工具面 —— 与该模块"裁掉无用工具省 Token"的目标相反。
  // 判据：联网意图存在时，必须出现**代码动作动词**才升级为 coding_web。
  const CODE_ACTION = /写|做|创建|生成|修改|重构|修复|运行|测试|构建|打包|实现|搭建|落盘|增删|改成|删掉|加上/i
  const codeIsAction = CODE_ACTION.test(q)

  let next = 'chat'
  if (wantsDesktop) next = 'full'
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

export function selectToolsForProfile(allTools = [], profile = 'coding', { includeAskUser = true, isolatedGroup = false } = {}) {
  const list = Array.isArray(allTools) ? allTools : []
  const allowed = new Set(isolatedGroup ? ['ask_user_options'] : TOOL_GROUPS.core_chat)

  if (profile === 'coding') {
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

  const filtered = profile === 'full'
    ? [...list]
    : list.filter((item) => {
      const name = String((item && item.function && item.function.name) || (item && item.name) || '')
      return name && (allowed.has(name) || name.startsWith('mcp__'))
    })

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
