/**
 * Harbor 插件化 DAG 工作流引擎（R16 全量重写 · 纯服务层，可直接 L1 单测）：
 *
 * 支持 7 类一等节点与真实并发拓扑执行：
 *   - input      : 入口需求与上下文变量注入
 *   - llm        : 模型推理节点（支持独立模型/思考档位/工具开关覆写 + 模板插值）
 *   - tool       : 确定性工具直调节点（零 LLM 往返，直接操作工作区或插件工具）
 *   - human_gate : 人工拍板决策门（运行中挂起并弹出 ClarifyModal，将人工选择回灌下游）
 *   - condition  : 无 eval 声明式条件分支（contains / not_contains / regex / min_length / always）
 *   - merge      : 多分支并行汇合节点（自动聚合上游并发分支结果）
 *   - artifact   : 实时交互画布发射节点（自动提取 HTML/SVG 或封装为交互预览卡送入 ArtifactCanvas）
 */
import { extractArtifactsFromMarkdown } from './artifacts.js'
import { isAbort } from './errors.js'

export const WORKFLOW_NODE_KINDS = Object.freeze([
  { id: 'input', label: '入口输入', badge: 'IN', desc: '接收用户任务目标与初始变量' },
  { id: 'llm', label: '模型智能体', badge: 'LLM', desc: '调用大模型执行分析、设计、编码或审查' },
  { id: 'tool', label: '直调工具', badge: 'TOOL', desc: '直接执行工作区或插件工具（零 Token）' },
  { id: 'human_gate', label: '人工拍板门', badge: 'GATE', desc: '暂停执行并弹出选项卡片由用户确认方向' },
  { id: 'condition', label: '条件分支', badge: 'IF', desc: '按声明式规则路由到不同下游分支' },
  { id: 'merge', label: '并行汇合', badge: 'JOIN', desc: '汇总多条并行分支产出供下游消费' },
  { id: 'artifact', label: '画布产出', badge: 'UI', desc: '提取或封装 HTML/SVG 推送至实时交互画布' },
])

/** 规范化任意工作流定义，确保节点/边结构完整。 */
export function normalizeWorkflowDef(raw = {}) {
  const w = raw && typeof raw === 'object' ? raw : {}
  const nodes = (Array.isArray(w.nodes) ? w.nodes : []).map((n, i) => ({
    id: String((n && n.id) || `n_${i + 1}`).trim(),
    kind: WORKFLOW_NODE_KINDS.some((k) => k.id === (n && n.kind)) ? n.kind : 'llm',
    label: String((n && n.label) || `节点 ${i + 1}`).trim(),
    role: String((n && n.role) || '').trim(),
    prompt: String((n && n.prompt) || '').trim(),
    model: String((n && n.model) || '').trim(),
    reasoningTier: String((n && n.reasoningTier) || 'auto').trim(),
    allowTools: n && n.allowTools === true,
    toolName: String((n && n.toolName) || '').trim(),
    toolArgs: (n && n.toolArgs && typeof n.toolArgs === 'object') ? n.toolArgs : {},
    gateConfig: (n && n.gateConfig && typeof n.gateConfig === 'object') ? n.gateConfig : null,
    condition: (n && n.condition && typeof n.condition === 'object') ? n.condition : null,
  }))
  const idSet = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(w.edges) ? w.edges : [])
    .filter((e) => e && idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to)
    .map((e, i) => ({
      id: String(e.id || `e_${e.from}_${e.to}_${i}`),
      from: String(e.from),
      to: String(e.to),
      when: e.when === 'true' || e.when === 'false' ? e.when : 'always',
      label: String(e.label || ''),
    }))
  return {
    id: String(w.id || `wf_${Date.now().toString(36)}`),
    pluginId: String(w.pluginId || 'custom'),
    name: String(w.name || '未命名工作流').trim(),
    description: String(w.description || '').trim(),
    category: String(w.category || 'custom').trim(),
    builtin: Boolean(w.builtin),
    nodes,
    edges,
  }
}

/**
 * 拓扑分层与环路检测（Kahn 算法）：
 * - 若存在环路，返回 `{ ok: false, error, cycleNodes }`；
 * - 否则返回 `{ ok: true, order, layers, layout }`，自动为可视化 DAG 画布算出无重叠坐标。
 */
export function analyzeWorkflowDag(workflow) {
  const wf = normalizeWorkflowDef(workflow)
  const nodesById = new Map(wf.nodes.map((n) => [n.id, n]))
  const inDegree = new Map(wf.nodes.map((n) => [n.id, 0]))
  const outgoing = new Map(wf.nodes.map((n) => [n.id, []]))
  const incoming = new Map(wf.nodes.map((n) => [n.id, []]))

  for (const e of wf.edges) {
    outgoing.get(e.from).push(e)
    incoming.get(e.to).push(e)
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1)
  }

  const layers = []
  const order = []
  let frontier = wf.nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id)
  const remaining = new Map(inDegree)

  while (frontier.length > 0) {
    layers.push([...frontier])
    const nextFrontier = []
    for (const id of frontier) {
      order.push(id)
      for (const edge of outgoing.get(id) || []) {
        const d = (remaining.get(edge.to) || 0) - 1
        remaining.set(edge.to, d)
        if (d === 0) nextFrontier.push(edge.to)
      }
    }
    frontier = nextFrontier
  }

  if (order.length !== wf.nodes.length) {
    const cycleNodes = wf.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id)
    return {
      ok: false,
      error: `工作流 DAG 存在循环依赖（涉及节点：${cycleNodes.join(' → ')}），请移除回边后重试。`,
      cycleNodes,
      order: [],
      layers: [],
      layout: { width: 640, height: 240, positions: {} },
    }
  }

  // 自动分层布局坐标（支持横向 DAG + 并行泳道垂直居中对齐）
  const NODE_W = 196
  const NODE_H = 82
  const COL_GAP = 72
  const ROW_GAP = 28
  const PAD_X = 28
  const PAD_Y = 26

  const maxRows = Math.max(1, ...layers.map((l) => l.length))
  const totalHeight = PAD_Y * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP
  const totalWidth = PAD_X * 2 + layers.length * NODE_W + Math.max(0, layers.length - 1) * COL_GAP
  const positions = {}

  layers.forEach((layer, colIdx) => {
    const colH = layer.length * NODE_H + Math.max(0, layer.length - 1) * ROW_GAP
    const startY = Math.round((totalHeight - colH) / 2)
    const x = PAD_X + colIdx * (NODE_W + COL_GAP)
    layer.forEach((id, rowIdx) => {
      positions[id] = {
        x,
        y: startY + rowIdx * (NODE_H + ROW_GAP),
        width: NODE_W,
        height: NODE_H,
        col: colIdx,
        row: rowIdx,
      }
    })
  })

  return {
    ok: true,
    error: '',
    order,
    layers,
    nodesById,
    outgoing,
    incoming,
    layout: { width: totalWidth, height: totalHeight, positions },
  }
}

/** 安全模板插值：`{{input}}` / `{{upstream}}` / `{{nodes.id.output}}` / `{{vars.key}}`。 */
export function interpolateTemplate(template, ctx = {}) {
  const src = String(template || '')
  if (!src.includes('{{')) return src
  const nodes = ctx.nodes || {}
  const vars = ctx.vars || {}
  return src.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, pathKey) => {
    if (pathKey === 'input') return String(ctx.input || '')
    if (pathKey === 'upstream') return String(ctx.upstream || '')
    if (pathKey.startsWith('nodes.')) {
      const parts = pathKey.split('.')
      const nid = parts[1]
      const field = parts[2] || 'output'
      const rec = nodes[nid]
      return rec && rec[field] !== undefined ? String(rec[field]) : ''
    }
    if (pathKey.startsWith('vars.')) {
      const k = pathKey.slice(5)
      return vars[k] !== undefined ? String(vars[k]) : ''
    }
    return ''
  })
}

/** 无 eval 声明式条件求值（100% 遵守 LAW-02 零 eval/Function 安全铁律）。 */
export function evaluateConditionRule(rule, text = '') {
  const r = rule && typeof rule === 'object' ? rule : { op: 'always' }
  const val = String(text || '')
  const target = String(r.value || '')
  switch (r.op) {
    case 'contains':
      return val.toLowerCase().includes(target.toLowerCase())
    case 'not_contains':
      return !val.toLowerCase().includes(target.toLowerCase())
    case 'min_length':
      return val.trim().length >= (Number(r.value) || 1)
    case 'regex':
      try { return new RegExp(target, 'i').test(val) } catch { return false }
    case 'always':
    default:
      return true
  }
}

/**
 * 执行插件化 DAG 工作流：
 * - 按拓扑层并发执行同层就绪节点（Promise.all）；
 * - 遇到 condition 节点自动计算分支激活态，跳过未命中的下游节点；
 * - 遇到 human_gate 节点暂停等待用户选择（ClarifyModal）；
 * - 遇到 artifact 节点自动提取 HTML/SVG 推送至实时画布；
 * - 全程可中止，且支持断点恢复（resumeOutputs）。
 */
export async function executeWorkflowDag({
  workflow,
  input = '',
  vars = {},
  resumeOutputs = null,
  signal = null,
  runLlmNode,
  runToolNode,
  requestHumanGate,
  onArtifact,
  onProgress,
}) {
  const wf = normalizeWorkflowDef(workflow)
  const analysis = analyzeWorkflowDag(wf)
  if (!analysis.ok) {
    throw new Error(analysis.error)
  }

  const nodeStates = {}
  const outputs = {}
  const activeEdges = new Set()
  const branchPass = new Map() // edge.id -> boolean
  const logs = []

  for (const n of wf.nodes) {
    if (resumeOutputs && Object.prototype.hasOwnProperty.call(resumeOutputs, n.id)) {
      nodeStates[n.id] = { status: 'done', ms: 0, output: String(resumeOutputs[n.id] || ''), summary: '断点恢复已复用' }
      outputs[n.id] = { output: String(resumeOutputs[n.id] || '') }
    } else {
      nodeStates[n.id] = { status: 'pending', ms: 0, output: '', summary: '' }
    }
  }
  for (const e of wf.edges) branchPass.set(e.id, true)

  const emit = (extra = {}) => {
    if (typeof onProgress === 'function') {
      onProgress({
        workflowId: wf.id,
        nodeStates: { ...nodeStates },
        activeEdges: [...activeEdges],
        logs: [...logs],
        ...extra,
      })
    }
  }

  const pushLog = (text) => {
    logs.push({ id: `wl_${logs.length}_${Date.now()}`, at: Date.now(), text })
  }

  const tStart = Date.now()
  pushLog(`启动插件工作流「${wf.name}」（共 ${wf.nodes.length} 节点 · ${analysis.layers.length} 拓扑层）`)
  emit({ status: 'running' })

  const runSingleNode = async (node) => {
    if (signal && signal.aborted) throw new Error('USER_PAUSED')
    if (nodeStates[node.id] && nodeStates[node.id].status === 'done') return

    const inEdges = analysis.incoming.get(node.id) || []
    if (inEdges.length > 0) {
      const anyActive = inEdges.some((e) => branchPass.get(e.id) !== false && nodeStates[e.from] && nodeStates[e.from].status === 'done')
      if (!anyActive) {
        nodeStates[node.id] = { status: 'skipped', ms: 0, output: '', summary: '条件分支未命中，已跳过' }
        for (const outE of analysis.outgoing.get(node.id) || []) branchPass.set(outE.id, false)
        pushLog(`↷ 跳过节点「${node.label}」（条件分支未命中）`)
        emit()
        return
      }
    }

    const upstreamParts = inEdges
      .filter((e) => branchPass.get(e.id) !== false && outputs[e.from] && outputs[e.from].output)
      .map((e) => {
        const srcNode = analysis.nodesById.get(e.from)
        return `【来自 ${srcNode ? srcNode.label : e.from}】\n${outputs[e.from].output}`
      })
    const upstreamText = upstreamParts.join('\n\n---\n\n')
    const tplCtx = { input, upstream: upstreamText, nodes: outputs, vars }

    const nodeT0 = Date.now()
    for (const e of inEdges) {
      if (branchPass.get(e.id) !== false) activeEdges.add(e.id)
    }
    nodeStates[node.id] = { status: node.kind === 'human_gate' ? 'waiting_human' : 'running', ms: 0, output: '', summary: '执行中…' }
    emit()

    let outText = ''
    try {
      if (node.kind === 'input') {
        outText = String(input || '').trim()
      } else if (node.kind === 'condition') {
        const subject = node.prompt ? interpolateTemplate(node.prompt, tplCtx) : (upstreamText || input)
        const passed = evaluateConditionRule(node.condition, subject)
        outText = passed ? 'TRUE' : 'FALSE'
        for (const outE of analysis.outgoing.get(node.id) || []) {
          if (outE.when === 'true') branchPass.set(outE.id, passed)
          else if (outE.when === 'false') branchPass.set(outE.id, !passed)
          else branchPass.set(outE.id, true)
        }
        pushLog(`◇ 条件节点「${node.label}」判定结果：${passed ? '命中 TRUE 分支' : '走 FALSE 分支'}`)
      } else if (node.kind === 'merge') {
        outText = node.prompt
          ? interpolateTemplate(node.prompt, tplCtx)
          : (upstreamText || String(input || ''))
      } else if (node.kind === 'human_gate') {
        const cfg = node.gateConfig || {
          title: `工作流确认：${node.label}`,
          subtitle: '请在下游继续执行前选择期望方案或输入自定义要求',
          questions: [
            {
              id: 'direction',
              label: '执行偏好',
              options: [
                { id: 'balanced', label: '均衡高质量方案', desc: '兼顾视觉质感、工程结构与交付速度', tag: '推荐' },
                { id: 'deep', label: '极致深度打磨', desc: '放宽推理与细节打磨，产出完整工程文档', tag: '深度' },
                { id: 'fast', label: '快速精简原型', desc: '最短路径直出可运行核心版本', tag: '极速' },
              ],
            },
          ],
        }
        if (typeof requestHumanGate === 'function') {
          const ans = await requestHumanGate({
            title: interpolateTemplate(cfg.title || node.label, tplCtx),
            subtitle: interpolateTemplate(cfg.subtitle || '', tplCtx),
            allow_custom: cfg.allow_custom !== false,
            questions: cfg.questions || [],
          })
          outText = (ans && ans.summary) || '采用默认方案继续'
        } else {
          outText = '自动放行：采用默认推荐方案'
        }
      } else if (node.kind === 'tool') {
        const resolvedArgs = {}
        for (const [k, v] of Object.entries(node.toolArgs || {})) {
          resolvedArgs[k] = typeof v === 'string' ? interpolateTemplate(v, tplCtx) : v
        }
        if (typeof runToolNode === 'function') {
          const raw = await runToolNode({ node, toolName: node.toolName, args: resolvedArgs, signal })
          outText = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
        } else {
          outText = JSON.stringify({ ok: true, simulated: true, tool: node.toolName, args: resolvedArgs })
        }
      } else if (node.kind === 'artifact') {
        const sourceText = node.prompt ? interpolateTemplate(node.prompt, tplCtx) : upstreamText
        const found = extractArtifactsFromMarkdown(sourceText)
        let artifact = found[0] || null
        if (!artifact && sourceText.trim()) {
          const safeTitle = String(node.label || wf.name || '工作流产出').replace(/</g, '&lt;')
          const safeBody = sourceText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          artifact = {
            id: `wf_art_${node.id}_${Date.now()}`,
            kind: 'html',
            lang: 'html',
            title: safeTitle,
            filename: `${safeTitle.replace(/\s+/g, '-')}.html`,
            code: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safeTitle}</title><style>body{font-family:"Segoe UI","PingFang SC",system-ui,sans-serif;max-width:860px;margin:0 auto;padding:28px;line-height:1.7;background:#faf8f4;color:#1b1a18}h1{border-bottom:2px solid #d4653e;padding-bottom:8px}pre{white-space:pre-wrap;background:#fff;padding:16px;border-radius:12px;border:1px solid rgba(0,0,0,.1)}</style></head><body><h1>✦ ${safeTitle}</h1><pre>${safeBody}</pre></body></html>`,
          }
        }
        if (artifact && typeof onArtifact === 'function') onArtifact(artifact)
        outText = artifact ? `已推送交互画布产物：「${artifact.title}」（${artifact.filename}）\n\n${sourceText.slice(0, 600)}` : sourceText
      } else {
        // llm node
        const promptText = interpolateTemplate(
          node.prompt || `请以「${node.role || node.label}」身份完成以下任务：\n{{input}}\n\n前序节点输出：\n{{upstream}}`,
          tplCtx
        )
        if (typeof runLlmNode === 'function') {
          const res = await runLlmNode({ node, prompt: promptText, upstream: upstreamText, input, signal })
          outText = typeof res === 'string' ? res : String((res && res.content) || '')
        } else {
          outText = `[${node.label}] 已处理：${promptText.slice(0, 120)}`
        }
      }

      const ms = Date.now() - nodeT0
      outputs[node.id] = { output: outText }
      nodeStates[node.id] = {
        status: 'done',
        ms,
        output: outText,
        summary: outText.replace(/\s+/g, ' ').trim().slice(0, 90),
      }
      pushLog(`✓ 节点「${node.label}」完成（${ms}ms）`)
      emit()
    } catch (err) {
      const ms = Date.now() - nodeT0
      const aborted = isAbort(err) || (signal && signal.aborted) || String(err && err.message) === 'USER_PAUSED'
      nodeStates[node.id] = {
        status: aborted ? 'pending' : 'error',
        ms,
        output: '',
        summary: aborted ? '已中止' : String(err && err.message || err),
      }
      if (!aborted) pushLog(`✗ 节点「${node.label}」失败：${String(err && err.message || err)}`)
      emit()
      throw err
    } finally {
      for (const e of inEdges) activeEdges.delete(e.id)
    }
  }

  try {
    for (const layer of analysis.layers) {
      if (signal && signal.aborted) throw new Error('USER_PAUSED')
      const nodesInLayer = layer.map((id) => analysis.nodesById.get(id)).filter(Boolean)
      if (nodesInLayer.length > 1) {
        pushLog(`⚡ 并行扇出 ${nodesInLayer.length} 个节点：${nodesInLayer.map((n) => n.label).join(' ∥ ')}`)
        emit()
      }
      await Promise.all(nodesInLayer.map((n) => runSingleNode(n)))
    }
    const lastId = analysis.order[analysis.order.length - 1]
    const finalOutput = (lastId && outputs[lastId] && outputs[lastId].output) || ''
    const totalMs = Date.now() - tStart
    pushLog(`✦ 工作流「${wf.name}」执行完成（总耗时 ${totalMs}ms）`)
    emit({ status: 'done', totalMs, finalOutput })
    return {
      status: 'done',
      workflowId: wf.id,
      nodeStates,
      outputs,
      finalOutput,
      totalMs,
      logs,
      checkpoint: null,
    }
  } catch (err) {
    const aborted = isAbort(err) || (signal && signal.aborted) || String(err && err.message) === 'USER_PAUSED'
    const completedOutputs = {}
    for (const [nid, rec] of Object.entries(outputs)) completedOutputs[nid] = rec.output
    const status = aborted ? 'paused' : 'error'
    const errMsg = aborted ? '工作流已暂停（可从断点继续）' : String(err && err.message || err)
    emit({ status, error: errMsg })
    return {
      status,
      workflowId: wf.id,
      nodeStates,
      outputs,
      finalOutput: '',
      totalMs: Date.now() - tStart,
      logs,
      error: errMsg,
      checkpoint: { workflowId: wf.id, input, completedOutputs },
    }
  }
}

/** 将群聊名册一键编译为可视化可编辑 DAG 工作流（实现群聊与插件工作流大一统）。 */
export function compileGroupToWorkflow(group = {}) {
  const members = Array.isArray(group.members) && group.members.length
    ? group.members
    : [{ id: 'm1', name: '架构师', persona: '设计方案' }, { id: 'm2', name: '实现工程师', persona: '编写代码' }]
  const nodes = [
    { id: 'in', kind: 'input', label: '群聊议题输入' },
    ...members.map((m, i) => ({
      id: `step_${i + 1}`,
      kind: 'llm',
      label: m.name || `成员 ${i + 1}`,
      role: m.name || `成员 ${i + 1}`,
      model: m.model || '',
      reasoningTier: m.reasoningTier || 'auto',
      allowTools: m.allowTools !== false,
      prompt: `你是「${m.name}」（职责：${m.persona || '按专长交付'}）。\n用户议题：{{input}}\n\n前序交接：\n{{upstream}}\n\n请输出你的高密度专业交付。`,
    })),
    { id: 'out_art', kind: 'artifact', label: '实时画布归档', prompt: '{{upstream}}' },
  ]
  const edges = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: `ge_${i}`, from: nodes[i].id, to: nodes[i + 1].id, when: 'always' })
  }
  return normalizeWorkflowDef({
    id: `wf_from_grp_${Date.now().toString(36)}`,
    pluginId: 'plugin.group-bridge',
    name: `群聊编译：${group.title || '多角色班底'}`,
    description: `由 ${members.length} 名群聊角色自动编译生成的可视化 DAG 工作流，支持继续增删并行分支与拍板门。`,
    category: 'custom',
    builtin: false,
    nodes,
    edges,
  })
}
