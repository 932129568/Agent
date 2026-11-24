/**
 * Harbor 插件化架构总注册表（R19 全量升级 · 8 大内置生产级插件 + 无限热插拔 JSON 插件）：
 *
 * 每个插件通过标准声明式 Manifest 贡献：
 *   - contributes.workflows       : 可视化并发 DAG 工作流（支持 10 类节点含 AI 生图 / AI 视频 / 迭代精修环）
 *   - contributes.tools           : 一等 OpenAI 函数工具（含 generate_image / generate_video / list_workflow_plugins）
 *   - contributes.slashCommands   : 聊天输入框 `/` 斜杠指令（/wf /plugins /img /video /refine 等）
 *   - contributes.hooks           : 声明式生命周期钩子（beforePrompt / afterTool / afterTurn）
 */
import { normalizeWorkflowDef, analyzeWorkflowDag } from './workflowEngine.js'
import { GENERATE_IMAGE_TOOL, GENERATE_VIDEO_TOOL } from './toolRouter.js'

export const BUILTIN_PLUGINS = Object.freeze([
  {
    id: 'core.workflow-studio',
    name: 'DAG 工作流引擎核心',
    version: '2.2.0',
    category: 'core',
    builtin: true,
    locked: true,
    description: '提供 10 类一等节点（含生图/视频/迭代精修环）、自由拖拽编排画布、断点续跑与插件热插拔内核。',
    contributes: {
      panels: [
        { id: 'workflow', icon: 'workflow', label: '工作流插件', order: 25 },
      ],
      slashCommands: [
        { id: '/wf', label: '/wf', desc: '打开插件化 DAG 工作流工坊', action: 'open_workflow' },
        { id: '/plugins', label: '/plugins', desc: '打开插件热插拔管理中心', action: 'open_plugins' },
      ],
      paletteCommands: [
        { id: 'plug-wf', label: '切换到「工作流与插件工坊 (DAG)」', hint: '/wf', action: 'open_workflow' },
        { id: 'plug-hub', label: '打开「插件热插拔中心」', hint: '/plugins', action: 'open_plugins' },
      ],
      tools: [
        {
          name: 'list_workflow_plugins',
          description: '列出 Harbor 当前已启用的插件化 DAG 工作流清单，便于向用户推荐或编排多步自动化流水线。',
          parameters: { type: 'object', properties: {} },
          handlerKind: 'list_workflows',
        },
      ],
      workflows: [],
      hooks: [],
    },
  },
  {
    id: 'plugin.visual-image-studio',
    name: 'AI 视觉与海报生图工坊',
    version: '1.0.0',
    category: 'media',
    builtin: true,
    description: '兼容 GLM CogView-4 / OpenAI GPT-Image / SiliconFlow FLUX / MiniMax / 本地生图网关，提供提示词润色 → 风格拍板 → 双风格并行出图闭环。',
    contributes: {
      slashCommands: [
        { id: '/img', label: '/img', desc: '启动 AI 视觉与双风格并行生图工作流', action: 'run_workflow', workflowId: 'wf-visual-poster' },
      ],
      tools: [
        {
          ...GENERATE_IMAGE_TOOL.function,
          handlerKind: 'media_image',
        },
      ],
      workflows: [
        {
          id: 'wf-visual-poster',
          pluginId: 'plugin.visual-image-studio',
          name: 'AI 视觉海报（提示词总监 → 拍板 → 主视觉∥变体并行生图）',
          description: '自动润色光影与构图提示词，经风格拍板后并行渲染 2 组视觉方案并推入实时画布对比。',
          category: 'media',
          builtin: true,
          variables: { brand: 'Harbor', aspect_ratio: '16:9' },
          nodes: [
            { id: 'in', kind: 'input', label: '视觉需求输入' },
            {
              id: 'prompt_dir',
              kind: 'llm',
              label: '视觉提示词总监',
              role: '资深商业美术指导',
              prompt: '你是商业视觉提示词总监。请将以下需求润色为一段精确、高密度的画面描述（包含主体、景别、光影、材质、色彩层次，直接输出画面描述）：\n{{input}}',
            },
            {
              id: 'style_gate',
              kind: 'human_gate',
              label: '美学风格与画幅拍板',
              gateConfig: {
                title: '选择图片生成美学方向',
                subtitle: '确认后将并行渲染主视觉与创意变体两张高清成图',
                questions: [
                  {
                    id: 'aesthetic',
                    label: '视觉风格方向',
                    options: [
                      { id: 'cinematic', label: '电影级光影写实', desc: '体积光、景深虚化与高级胶片颗粒', tag: '推荐' },
                      { id: 'glass3d', label: '玻璃拟态 3D 渲染', desc: '通透折射材质、柔和渐变与现代科技感', tag: '潮流' },
                      { id: 'editorial', label: '极简平面海报风', desc: '大留白、强图形对比与精准视觉焦点', tag: '商业' },
                    ],
                  },
                ],
              },
            },
            {
              id: 'img_main',
              kind: 'image_gen',
              label: '主视觉成图 A',
              prompt: '{{nodes.prompt_dir.output}} · 风格：{{nodes.style_gate.output}}',
              mediaConfig: { aspectRatio: '16:9', style: '电影光影大片', quality: 'hd' },
            },
            {
              id: 'img_alt',
              kind: 'image_gen',
              label: '创意变体成图 B',
              prompt: '{{nodes.prompt_dir.output}} · 风格：{{nodes.style_gate.output}}',
              mediaConfig: { aspectRatio: '16:9', style: '极简艺术视觉', quality: 'hd' },
            },
            {
              id: 'deliver',
              kind: 'merge',
              label: '视觉成品汇总',
              prompt: '### 🎨 AI 视觉并行交付结果\n\n#### 方案 A（主视觉）\n{{nodes.img_main.output}}\n\n#### 方案 B（创意变体）\n{{nodes.img_alt.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'prompt_dir' },
            { from: 'prompt_dir', to: 'style_gate' },
            { from: 'style_gate', to: 'img_main' },
            { from: 'style_gate', to: 'img_alt' },
            { from: 'img_main', to: 'deliver' },
            { from: 'img_alt', to: 'deliver' },
          ],
        },
      ],
      hooks: [
        {
          event: 'beforePrompt',
          kind: 'append_directive',
          text: '【视觉插件就绪】当用户明确要求画图/生图/海报/配图时，可直接调用 generate_image 工具出图并在画布预览。',
        },
      ],
    },
  },
  {
    id: 'plugin.ai-video-director',
    name: 'AI 短片导演与文/图生视频引擎',
    version: '1.0.0',
    category: 'media',
    builtin: true,
    description: '兼容 GLM CogVideoX-3 / OpenAI Sora-2 / SiliconFlow Wan2.1 / MiniMax video-01，打通「导演分镜 → 首帧关键图 → 图生视频 (I2V) 异步轮询 → 放映厅」。',
    contributes: {
      slashCommands: [
        { id: '/video', label: '/video', desc: '启动 AI 短片分镜与文/图生视频流水线', action: 'run_workflow', workflowId: 'wf-ai-video-film' },
      ],
      tools: [
        {
          ...GENERATE_VIDEO_TOOL.function,
          handlerKind: 'media_video',
        },
      ],
      workflows: [
        {
          id: 'wf-ai-video-film',
          pluginId: 'plugin.ai-video-director',
          name: 'AI 短片导演（分镜脚本 → 节奏拍板 → 首帧生图 → 图生视频 I2V）',
          description: '上游生图首帧自动透传给下游视频节点，实现稳定可控的图生视频全链路。',
          category: 'media',
          builtin: true,
          variables: { aspect_ratio: '16:9', duration: '5' },
          nodes: [
            { id: 'in', kind: 'input', label: '短片创意输入' },
            {
              id: 'director',
              kind: 'llm',
              label: '总导演分镜策划',
              role: 'AI 广告与短片导演',
              prompt: '你是资深 AI 视频导演。请围绕以下创意设计开场核心镜头（明确主体、运镜方式、光影变化与氛围节奏，输出可直接用于首帧出图与视频渲染的高密度描述）：\n{{input}}',
            },
            {
              id: 'pace_gate',
              kind: 'human_gate',
              label: '画幅与运镜拍板',
              gateConfig: {
                title: '确认短片画幅与运镜风格',
                subtitle: '确认后将先渲染首帧关键概念图，再无缝进入图生视频渲染',
                questions: [
                  {
                    id: 'camera',
                    label: '运镜节奏偏好',
                    options: [
                      { id: 'dolly', label: '缓慢推进电影感', desc: '稳定推镜、光影流动与高级史诗氛围', tag: '推荐' },
                      { id: 'orbit', label: '360° 环绕展示', desc: '围绕核心主体流畅环绕，适合产品大片', tag: '产品' },
                      { id: 'dynamic', label: '快节奏潮流转场', desc: '动感跟拍与高能视觉冲击', tag: '短剧' },
                    ],
                  },
                ],
              },
            },
            {
              id: 'first_frame',
              kind: 'image_gen',
              label: '首帧关键概念图',
              prompt: '{{nodes.director.output}} · 运镜：{{nodes.pace_gate.output}}',
              mediaConfig: { aspectRatio: '16:9', style: '电影级宽银幕静帧', quality: 'hd' },
            },
            {
              id: 'render_video',
              kind: 'video_gen',
              label: '图生视频渲染 (I2V)',
              prompt: '{{nodes.director.output}} · 运镜：{{nodes.pace_gate.output}}',
              mediaConfig: { duration: 5, aspectRatio: '16:9', resolution: '1080p', withAudio: true },
            },
          ],
          edges: [
            { from: 'in', to: 'director' },
            { from: 'director', to: 'pace_gate' },
            { from: 'pace_gate', to: 'first_frame' },
            { from: 'first_frame', to: 'render_video' },
          ],
        },
      ],
      hooks: [
        {
          event: 'beforePrompt',
          kind: 'append_directive',
          text: '【视频插件就绪】当用户要求生成短视频/宣传片时，可先调用 generate_image 锁定首帧再调用 generate_video（传 image_url）实现高一致性图生视频。',
        },
      ],
    },
  },
  {
    id: 'plugin.fullstack-pipeline',
    name: '全栈并行交付流水线',
    version: '1.5.0',
    category: 'engineering',
    builtin: true,
    description: '架构拆解后并行扇出「UI 视觉规范 ∥ 安全基线 ∥ 人工拍板」，汇合后经迭代精修落地并直推实时画布。',
    contributes: {
      workflows: [
        {
          id: 'wf-fullstack-delivery',
          pluginId: 'plugin.fullstack-pipeline',
          name: '全栈并行交付（架构 → UI∥安全∥拍板 → 精修落地 → 画布）',
          description: '并行扇出 + 人工拍板门 + 实时交互画布输出的旗舰工程流水线。',
          category: 'engineering',
          builtin: true,
          nodes: [
            { id: 'in', kind: 'input', label: '需求输入' },
            {
              id: 'arch',
              kind: 'llm',
              label: '系统架构师',
              role: '系统架构师',
              prompt: '你是系统架构师。请为以下需求给出简洁清晰的模块划分、技术栈与交互契约：\n{{input}}',
            },
            {
              id: 'ui_spec',
              kind: 'llm',
              label: 'UI 视觉规范',
              role: '资深 UI 设计师',
              prompt: '你是资深 UI 设计师。依据架构设计制定配色、排版、玻璃层次与微交互规范：\n{{upstream}}',
            },
            {
              id: 'sec_spec',
              kind: 'llm',
              label: '安全与边界审查',
              role: '安全审计工程师',
              prompt: '你是安全与质量工程师。依据架构方案列出 3–5 条必须守住的边界条件、XSS/性能红线：\n{{upstream}}',
            },
            {
              id: 'gate',
              kind: 'human_gate',
              label: '效果方向拍板',
              gateConfig: {
                title: '落地前确认页面视觉与交互方向',
                subtitle: '架构与并行规范已就绪，请拍板最终实现偏好',
                questions: [
                  {
                    id: 'style',
                    label: '视觉质感偏好',
                    options: [
                      { id: 'glass', label: '通透玻璃拟态', desc: '高质感磨砂、柔和阴影与精致微动效', tag: '推荐' },
                      { id: 'minimal', label: '极简高对比工业风', desc: '高信息密度、锐利边框与零干扰布局', tag: '极简' },
                      { id: 'editorial', label: '暖调杂志排版', desc: '优雅衬线标题、留白呼吸感与细腻层次', tag: '精致' },
                    ],
                  },
                ],
              },
            },
            {
              id: 'merge_spec',
              kind: 'merge',
              label: '汇合全部规范',
              prompt: '【原始需求】\n{{input}}\n\n【UI 视觉规范】\n{{nodes.ui_spec.output}}\n\n【安全与边界基线】\n{{nodes.sec_spec.output}}\n\n【用户拍板方向】\n{{nodes.gate.output}}',
            },
            {
              id: 'impl',
              kind: 'llm',
              label: '全栈实现落地',
              role: '全栈实现工程师',
              allowTools: true,
              retryCount: 1,
              prompt: '你是全栈实现工程师。严格依据下方汇合规范输出完整可运行的代码（若是网页请给出完整 ```html 代码块供实时画布渲染）：\n{{upstream}}',
            },
            {
              id: 'canvas',
              kind: 'artifact',
              label: '实时画布预览',
              prompt: '{{nodes.impl.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'arch' },
            { from: 'arch', to: 'ui_spec' },
            { from: 'arch', to: 'sec_spec' },
            { from: 'arch', to: 'gate' },
            { from: 'ui_spec', to: 'merge_spec' },
            { from: 'sec_spec', to: 'merge_spec' },
            { from: 'gate', to: 'merge_spec' },
            { from: 'merge_spec', to: 'impl' },
            { from: 'impl', to: 'canvas' },
          ],
        },
      ],
      hooks: [
        {
          event: 'beforePrompt',
          kind: 'append_directive',
          text: '【插件提示 · 全栈工程规范】产出可运行页面或组件时优先提供完整自包含代码块，便于直接送入 Harbor 实时画布预览。',
        },
      ],
    },
  },
  {
    id: 'plugin.auto-qa-loop',
    name: '有界迭代精修与自检引擎',
    version: '1.0.0',
    category: 'quality',
    builtin: true,
    description: '利用有界迭代循环节点（最多 3 轮自检→挑刺→精修）把方案/代码/文案自动打磨至 APPROVED 达标线再交付。',
    contributes: {
      slashCommands: [
        { id: '/refine', label: '/refine', desc: '启动多轮自检迭代精修工作流', action: 'run_workflow', workflowId: 'wf-iterative-refine' },
      ],
      workflows: [
        {
          id: 'wf-iterative-refine',
          pluginId: 'plugin.auto-qa-loop',
          name: '有界迭代精修环（起草 → 最多 3 轮自检挑刺 → 达标验收）',
          description: '内置 Loop 迭代节点，自动发现草稿缺陷并持续修订，命中 APPROVED 提前收口。',
          category: 'quality',
          builtin: true,
          nodes: [
            { id: 'in', kind: 'input', label: '精修目标' },
            {
              id: 'refine_loop',
              kind: 'loop',
              label: '3 轮自检精修环',
              role: '首席质量精修官',
              loopConfig: { maxIterations: 3, stopKeyword: 'APPROVED' },
              prompt: '请高质量完成以下交付物，并在每轮自我挑刺补全细节：\n{{input}}',
            },
            {
              id: 'check_pass',
              kind: 'condition',
              label: '验收达标判定',
              condition: { op: 'contains', value: 'APPROVED' },
            },
            {
              id: 'art_ok',
              kind: 'artifact',
              label: '达标终稿画布',
              prompt: '{{nodes.refine_loop.output}}',
            },
            {
              id: 'polish_final',
              kind: 'llm',
              label: '人工复核清单补齐',
              role: '发布经理',
              prompt: '精修已达最大轮次，请整理最终交付正文及 3 条待人工确认清单：\n{{nodes.refine_loop.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'refine_loop' },
            { from: 'refine_loop', to: 'check_pass' },
            { from: 'check_pass', to: 'art_ok', when: 'true', label: '已达标' },
            { from: 'check_pass', to: 'polish_final', when: 'false', label: '需复核' },
          ],
        },
      ],
    },
  },
  {
    id: 'plugin.deep-research',
    name: '深度研究与反证报告引擎',
    version: '1.4.0',
    category: 'research',
    builtin: true,
    description: '并行拆解正方洞察与芒格反向质疑，汇合产出高颜值 HTML 可视化交互研究简报。',
    contributes: {
      workflows: [
        {
          id: 'wf-deep-research',
          pluginId: 'plugin.deep-research',
          name: '深度研究（正向拆解 ∥ 反向质疑 → 可视化报告）',
          description: '红蓝双视角并行推演，避免单视角盲区，最终产出可直接交互浏览的研究报告。',
          category: 'research',
          builtin: true,
          nodes: [
            { id: 'in', kind: 'input', label: '研究命题' },
            {
              id: 'thesis',
              kind: 'llm',
              label: '正向机会拆解',
              role: '首席行业分析师',
              prompt: '请用 MECE 框架拆解以下命题的核心趋势、关键驱动因素与最高杠杆机会：\n{{input}}',
            },
            {
              id: 'antithesis',
              kind: 'llm',
              label: '芒格反向质疑',
              role: '红队质疑专家',
              prompt: '请站在反方立场，找出以下命题中 3 个最容易被忽略的致命风险、伪需求或执行陷阱：\n{{input}}',
            },
            {
              id: 'synth',
              kind: 'merge',
              label: '红蓝观点汇合',
              prompt: '【研究命题】{{input}}\n\n【正向拆解】\n{{nodes.thesis.output}}\n\n【红队反证】\n{{nodes.antithesis.output}}',
            },
            {
              id: 'report',
              kind: 'llm',
              label: '交互简报生成',
              role: '报告视觉架构师',
              prompt: '请综合红蓝双视角输出一份精致的单页 HTML 执行摘要报告（用 ```html 代码块包裹，含清晰结论卡、风险矩阵与行动建议）：\n{{upstream}}',
            },
            {
              id: 'canvas',
              kind: 'artifact',
              label: '报告实时画布',
              prompt: '{{nodes.report.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'thesis' },
            { from: 'in', to: 'antithesis' },
            { from: 'thesis', to: 'synth' },
            { from: 'antithesis', to: 'synth' },
            { from: 'synth', to: 'report' },
            { from: 'report', to: 'canvas' },
          ],
        },
      ],
    },
  },
  {
    id: 'plugin.code-audit',
    name: '代码体检与安全重构插件',
    version: '1.3.0',
    category: 'security',
    builtin: true,
    description: '直调工作区目录扫描工具 → 静态与安全审计 → 风险条件分流 → 精准重构方案。',
    contributes: {
      workflows: [
        {
          id: 'wf-code-audit',
          pluginId: 'plugin.code-audit',
          name: '代码安全体检（目录探测 → 审计 → 条件分支重构）',
          description: '「确定性工具节点 + LLM 审计 + 条件分支」混合编排，零浪费 Token。',
          category: 'security',
          builtin: true,
          nodes: [
            { id: 'in', kind: 'input', label: '审计目标' },
            {
              id: 'scan',
              kind: 'tool',
              label: '工作区目录扫描',
              toolName: 'list_dir',
              toolArgs: { path: '.' },
            },
            {
              id: 'audit',
              kind: 'llm',
              label: '安全与架构审计',
              role: '安全审计架构师',
              allowTools: true,
              prompt: '基于审计目标「{{input}}」及工作区目录快照：\n{{nodes.scan.output}}\n\n请重点排查安全漏洞、并发竞态与架构债，并在存在高危项时明确标注关键词「HIGH_RISK」。',
            },
            {
              id: 'cond',
              kind: 'condition',
              label: '是否含高危风险',
              condition: { op: 'contains', value: 'HIGH_RISK' },
            },
            {
              id: 'fix_plan',
              kind: 'llm',
              label: '高危阻断修复方案',
              role: '首席重构工程师',
              prompt: '检测到高危项，请给出逐文件最小可验证修复补丁与回归用例：\n{{nodes.audit.output}}',
            },
            {
              id: 'clean_badge',
              kind: 'merge',
              label: '常规优化建议汇总',
              prompt: '未命中高危阻断项，已整理为常规演进建议：\n\n{{nodes.audit.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'scan' },
            { from: 'scan', to: 'audit' },
            { from: 'audit', to: 'cond' },
            { from: 'cond', to: 'fix_plan', when: 'true', label: '命中高危' },
            { from: 'cond', to: 'clean_badge', when: 'false', label: '常规通过' },
          ],
        },
      ],
    },
  },
  {
    id: 'plugin.content-studio',
    name: '图文并茂爆款内容工坊',
    version: '1.4.0',
    category: 'creative',
    builtin: true,
    description: '并行生成「开场钩子 ∥ 深度大纲 ∥ AI 封面配图」，汇合精修为图文并茂的多平台发布终稿。',
    contributes: {
      workflows: [
        {
          id: 'wf-content-studio',
          pluginId: 'plugin.content-studio',
          name: '图文内容工坊（钩子 ∥ 大纲 ∥ AI 封面图 → 终稿）',
          description: '三轨并行激发创意、逻辑与封面视觉，一键直出图文成品。',
          category: 'creative',
          builtin: true,
          nodes: [
            { id: 'in', kind: 'input', label: '选题与受众' },
            {
              id: 'hooks',
              kind: 'llm',
              label: '爆款钩子设计',
              role: '增长文案总监',
              prompt: '为以下选题设计 3 个高完播率/高点击率开场钩子（反常识/痛点/数据视角各 1 个）：\n{{input}}',
            },
            {
              id: 'outline',
              kind: 'llm',
              label: '深度结构大纲',
              role: '内容主编',
              prompt: '为以下选题规划节奏紧凑的 4 段式论证结构与核心金句：\n{{input}}',
            },
            {
              id: 'cover',
              kind: 'image_gen',
              label: 'AI 封面配图',
              prompt: 'Editorial high-impact cover illustration for: {{input}}',
              mediaConfig: { aspectRatio: '16:9', style: '杂志级精致插画', quality: 'hd' },
            },
            {
              id: 'polish',
              kind: 'llm',
              label: '主编整合图文终稿',
              role: '总编辑',
              prompt: '挑选最强钩子与大纲无缝融合，并将封面图嵌入文首输出可直接发布的图文终稿：\n\n【封面图】\n{{nodes.cover.output}}\n\n【钩子候选】\n{{nodes.hooks.output}}\n\n【内容大纲】\n{{nodes.outline.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'hooks' },
            { from: 'in', to: 'outline' },
            { from: 'in', to: 'cover' },
            { from: 'hooks', to: 'polish' },
            { from: 'outline', to: 'polish' },
            { from: 'cover', to: 'polish' },
          ],
        },
      ],
    },
  },
])

/** 校验并规范化外部/自定义 JSON 插件 Manifest（严格安全白名单，禁止脚本注入）。 */
export function validateCustomPluginManifest(raw) {
  let obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch (e) {
      return { ok: false, error: `插件 JSON 解析失败：${e.message}` }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '插件配置必须是 JSON 对象' }
  }
  const id = String(obj.id || '').trim()
  const name = String(obj.name || '').trim()
  if (!id || !/^[a-zA-Z0-9._-]{3,64}$/.test(id)) {
    return { ok: false, error: '插件 id 必须为 3–64 位英文/数字/点/横线（如 custom.my-flow）' }
  }
  if (!name) return { ok: false, error: '插件缺少 name 名称' }

  const rawContrib = (obj.contributes && typeof obj.contributes === 'object') ? obj.contributes : {}
  const workflows = []
  for (const w of (Array.isArray(rawContrib.workflows) ? rawContrib.workflows : [])) {
    const norm = normalizeWorkflowDef({ ...w, pluginId: id, builtin: false })
    const dag = analyzeWorkflowDag(norm)
    if (!dag.ok) return { ok: false, error: `插件工作流「${norm.name}」校验失败：${dag.error}` }
    workflows.push(norm)
  }

  const tools = (Array.isArray(rawContrib.tools) ? rawContrib.tools : [])
    .filter((t) => t && typeof t.name === 'string' && /^[a-zA-Z0-9_-]{2,48}$/.test(t.name))
    .map((t) => ({
      name: t.name,
      description: String(t.description || `插件工具 ${t.name}`),
      parameters: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object', properties: {} },
      handlerKind: String(t.handlerKind || 'template'),
      responseTemplate: String(t.responseTemplate || '{"ok":true}'),
    }))

  const hooks = (Array.isArray(rawContrib.hooks) ? rawContrib.hooks : [])
    .filter((h) => h && ['beforePrompt', 'afterTool', 'afterTurn'].includes(h.event))
    .map((h) => ({
      event: h.event,
      kind: String(h.kind || 'append_directive'),
      text: String(h.text || '').slice(0, 600),
    }))

  const slashCommands = (Array.isArray(rawContrib.slashCommands) ? rawContrib.slashCommands : [])
    .filter((c) => c && typeof c.label === 'string' && c.label.startsWith('/'))
    .map((c) => ({
      id: String(c.id || c.label),
      label: c.label,
      desc: String(c.desc || '插件指令'),
      action: String(c.action || 'run_workflow'),
      workflowId: String(c.workflowId || (workflows[0] && workflows[0].id) || ''),
    }))

  return {
    ok: true,
    plugin: {
      id,
      name,
      version: String(obj.version || '1.0.0'),
      category: String(obj.category || 'custom'),
      builtin: false,
      locked: false,
      description: String(obj.description || '用户自定义热插拔插件'),
      contributes: {
        panels: [],
        workflows,
        tools,
        slashCommands,
        paletteCommands: [],
        hooks,
      },
    },
  }
}

export function resolveAllPlugins(enabledMap = {}, customPlugins = []) {
  const byId = new Map()
  for (const bp of BUILTIN_PLUGINS) {
    const enabled = bp.locked ? true : (enabledMap[bp.id] !== false)
    byId.set(bp.id, { ...bp, enabled })
  }
  for (const cp of (Array.isArray(customPlugins) ? customPlugins : [])) {
    if (!cp || !cp.id || byId.has(cp.id)) continue
    byId.set(cp.id, { ...cp, builtin: false, enabled: enabledMap[cp.id] !== false })
  }
  return [...byId.values()]
}

export function collectEnabledWorkflows(plugins = [], customWorkflows = []) {
  const list = []
  const seen = new Set()
  for (const p of (Array.isArray(plugins) ? plugins : [])) {
    if (!p || !p.enabled || !p.contributes) continue
    for (const w of (p.contributes.workflows || [])) {
      const norm = normalizeWorkflowDef({ ...w, pluginId: p.id })
      if (!seen.has(norm.id)) {
        seen.add(norm.id)
        list.push(norm)
      }
    }
  }
  for (const cw of (Array.isArray(customWorkflows) ? customWorkflows : [])) {
    const norm = normalizeWorkflowDef(cw)
    if (!seen.has(norm.id)) {
      seen.add(norm.id)
      list.push(norm)
    }
  }
  return list
}

export function collectPluginTools(plugins = []) {
  const out = []
  const seen = new Set()
  for (const p of (Array.isArray(plugins) ? plugins : [])) {
    if (!p || !p.enabled || !p.contributes) continue
    for (const t of (p.contributes.tools || [])) {
      if (!t || !t.name || seen.has(t.name)) continue
      seen.add(t.name)
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} },
        },
        _pluginMeta: { pluginId: p.id, handlerKind: t.handlerKind, responseTemplate: t.responseTemplate },
      })
    }
  }
  return out
}

export function collectPluginSlashCommands(plugins = []) {
  const out = []
  const seen = new Set()
  for (const p of (Array.isArray(plugins) ? plugins : [])) {
    if (!p || !p.enabled || !p.contributes) continue
    for (const c of (p.contributes.slashCommands || [])) {
      if (!c || !c.label || seen.has(c.label)) continue
      seen.add(c.label)
      out.push({ ...c, pluginId: p.id })
    }
  }
  return out
}

export function runPluginBeforePromptHooks(plugins = []) {
  const directives = []
  for (const p of (Array.isArray(plugins) ? plugins : [])) {
    if (!p || !p.enabled || !p.contributes) continue
    for (const h of (p.contributes.hooks || [])) {
      if (h && h.event === 'beforePrompt' && h.text) {
        directives.push(h.text)
      }
    }
  }
  return directives.join('\n')
}

export function dispatchPluginTool(toolName, args = {}, { plugins = [], workflows = [] } = {}) {
  const activeTools = collectPluginTools(plugins)
  const hit = activeTools.find((t) => t.function.name === toolName)
  if (!hit) return null
  const meta = hit._pluginMeta || {}
  // 媒体工具交由 agentEngine 的原生 mediaToolDispatcher 走真实生成链路
  if (meta.handlerKind === 'media_image' || meta.handlerKind === 'media_video') return null
  if (meta.handlerKind === 'list_workflows') {
    const summary = workflows.map((w) => ({
      id: w.id,
      name: w.name,
      nodes: (w.nodes || []).length,
      description: w.description,
    }))
    return JSON.stringify({ ok: true, count: summary.length, workflows: summary })
  }
  let rendered = String(meta.responseTemplate || '{"ok":true}')
  for (const [k, v] of Object.entries(args || {})) {
    rendered = rendered.split(`{{${k}}}`).join(String(v ?? ''))
  }
  return rendered
}

export const SAMPLE_CUSTOM_PLUGIN_JSON = JSON.stringify({
  id: 'custom.prd-sprint',
  name: '敏捷 PRD 评审流水线（示例插件）',
  version: '1.0.0',
  category: 'product',
  description: '用户自定义热插拔插件示例：需求拆解 → 视觉概念图 → 交互式原型预览。',
  contributes: {
    slashCommands: [
      { id: '/prd', label: '/prd', desc: '启动自定义敏捷 PRD 流水线', action: 'run_workflow', workflowId: 'wf-custom-prd' },
    ],
    hooks: [
      { event: 'beforePrompt', kind: 'append_directive', text: '【自定义插件】回答产品需求时请顺手列出验收标准（AC）。' },
    ],
    workflows: [
      {
        id: 'wf-custom-prd',
        name: '自定义敏捷 PRD → 原型画布',
        description: '热插拔安装后立即可运行的自定义 DAG 工作流。',
        nodes: [
          { id: 'in', kind: 'input', label: '产品想法' },
          { id: 'prd', kind: 'llm', label: 'PRD 拆解', role: '产品经理', prompt: '请输出核心用户故事与功能清单：\n{{input}}' },
          { id: 'proto', kind: 'llm', label: '交互原型', role: '原型工程师', prompt: '基于 PRD 生成单页 HTML 可点击原型（用 ```html 代码块）：\n{{upstream}}' },
          { id: 'art', kind: 'artifact', label: '原型画布', prompt: '{{nodes.proto.output}}' },
        ],
        edges: [
          { from: 'in', to: 'prd' },
          { from: 'prd', to: 'proto' },
          { from: 'proto', to: 'art' },
        ],
      },
    ],
  },
}, null, 2)
