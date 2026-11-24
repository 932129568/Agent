/**
 * Harbor 插件化架构总注册表（R16 全量重写 · 纯服务层，零 eval，100% 遵守 LAW-02/LAW-07）：
 *
 * 每个插件（内置或用户热插拔 JSON 插件）均通过统一 Manifest 声明其贡献点：
 *   - contributes.panels          : 侧边主导航工作台面板
 *   - contributes.workflows       : 可视化 DAG 工作流定义
 *   - contributes.tools           : 注入给 Agent 的一等 OpenAI 函数工具
 *   - contributes.slashCommands   : 聊天输入框 `/` 斜杠指令
 *   - contributes.paletteCommands : Ctrl+K 命令面板动作
 *   - contributes.hooks           : 声明式生命周期钩子（beforePrompt / afterTool / afterTurn）
 */
import { normalizeWorkflowDef, analyzeWorkflowDag } from './workflowEngine.js'

export const BUILTIN_PLUGINS = Object.freeze([
  {
    id: 'core.workflow-studio',
    name: 'DAG 工作流引擎核心',
    version: '2.0.0',
    category: 'core',
    builtin: true,
    locked: true,
    description: '提供可视化 DAG 编排画布、并发拓扑执行器、人类拍板门与插件热插拔中心。',
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
          description: '列出 Harbor 当前已启用的插件化 DAG 工作流清单，便于向用户推荐或编排复杂多步流水线。',
          parameters: { type: 'object', properties: {} },
          handlerKind: 'list_workflows',
        },
      ],
      workflows: [],
      hooks: [],
    },
  },
  {
    id: 'plugin.fullstack-pipeline',
    name: '全栈并行交付流水线',
    version: '1.2.0',
    category: 'engineering',
    builtin: true,
    description: '架构拆解后并行扇出「UI 视觉规范 ∥ 安全与边界基线」，经人工效果拍板门后由工程师落地并送入实时画布。',
    contributes: {
      workflows: [
        {
          id: 'wf-fullstack-delivery',
          pluginId: 'plugin.fullstack-pipeline',
          name: '全栈并行交付（架构 → UI∥安全 → 拍板 → 落地）',
          description: '典型并行扇出 + 人工拍板门 + 实时画布输出的现代 Agent 工程流水线。',
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
    id: 'plugin.deep-research',
    name: '深度研究与反证报告引擎',
    version: '1.1.0',
    category: 'research',
    builtin: true,
    description: '并行拆解正方洞察与反方质疑，经条件门分流输出高颜值 HTML 可视化研究简报。',
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
    version: '1.0.0',
    category: 'security',
    builtin: true,
    description: '直调工作区目录扫描工具 → 静态与安全审计 → 风险条件分流 → 精准重构方案。',
    contributes: {
      workflows: [
        {
          id: 'wf-code-audit',
          pluginId: 'plugin.code-audit',
          name: '代码安全体检（目录探测 → 审计 → 条件分支重构）',
          description: '演示「确定性工具节点 + LLM 审计 + 条件分支」混合编排，零浪费 Token。',
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
    name: '爆款内容并行创作工坊',
    version: '1.0.0',
    category: 'creative',
    builtin: true,
    description: '并行生成「开场钩子 ∥ 深度结构大纲」，汇合精修为多平台可直接发布的成品文案。',
    contributes: {
      workflows: [
        {
          id: 'wf-content-studio',
          pluginId: 'plugin.content-studio',
          name: '内容工坊（钩子 ∥ 大纲 → 精修成稿）',
          description: '并行激发创意与逻辑双轨，快速产出高质量文章或视频脚本。',
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
              id: 'polish',
              kind: 'llm',
              label: '主编整合精修',
              role: '总编辑',
              prompt: '挑选最强钩子并与大纲无缝融合，输出可直接发布的终稿：\n\n【钩子候选】\n{{nodes.hooks.output}}\n\n【内容大纲】\n{{nodes.outline.output}}',
            },
          ],
          edges: [
            { from: 'in', to: 'hooks' },
            { from: 'in', to: 'outline' },
            { from: 'hooks', to: 'polish' },
            { from: 'outline', to: 'polish' },
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

/** 合并内置插件与用户自定义插件，返回带 enabled 状态的完整注册表快照。 */
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

/** 运行声明式插件生命周期钩子（fail-open，单个插件异常绝不阻塞核心流程）。 */
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

/** 执行插件声明式工具（安全无 eval）。 */
export function dispatchPluginTool(toolName, args = {}, { plugins = [], workflows = [] } = {}) {
  const activeTools = collectPluginTools(plugins)
  const hit = activeTools.find((t) => t.function.name === toolName)
  if (!hit) return null
  const meta = hit._pluginMeta || {}
  if (meta.handlerKind === 'list_workflows') {
    const summary = workflows.map((w) => ({
      id: w.id,
      name: w.name,
      nodes: (w.nodes || []).length,
      description: w.description,
    }))
    return JSON.stringify({ ok: true, count: summary.length, workflows: summary })
  }
  // 声明式模板响应工具
  let rendered = String(meta.responseTemplate || '{"ok":true}')
  for (const [k, v] of Object.entries(args || {})) {
    rendered = rendered.split(`{{${k}}}`).join(String(v ?? ''))
  }
  return rendered
}

/** 给用户热插拔测试的一键示例插件 JSON 模板。 */
export const SAMPLE_CUSTOM_PLUGIN_JSON = JSON.stringify({
  id: 'custom.prd-sprint',
  name: '敏捷 PRD 评审流水线（示例插件）',
  version: '1.0.0',
  category: 'product',
  description: '用户自定义热插拔插件示例：需求拆解 → 人工确认门 → 交互式原型预览。',
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
        name: '自定义敏捷 PRD → 拍板 → 原型画布',
        description: '热插拔安装后立即可运行的 3 步自定义 DAG 工作流。',
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
