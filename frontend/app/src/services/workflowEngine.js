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
  { id: 'image_gen', label: 'AI 生图', badge: 'IMG', desc: '调用文生图模型出图并同步送入实时画布' },
  { id: 'video_gen', label: 'AI 视频', badge: 'VID', desc: '文生视频 / 图生视频（可衔接上游生图首帧）' },
  { id: 'loop', label: '迭代精修环', badge: 'LOOP', desc: '有界多轮「生成 → 挑刺 → 精修」直到达标' },
  { id: 'tool', label: '直调工具', badge: 'TOOL', desc: '直接执行工作区或插件工具（零 Token）' },
  { id: 'human_gate', label: '人工拍板门', badge: 'GATE', desc: '暂停执行并弹出选项卡片由用户确认方向' },
  { id: 'condition', label: '条件分支', badge: 'IF', desc: '按声明式规则路由到不同下游分支' },
  { id: 'merge', label: '并行汇合', badge: 'JOIN', desc: '汇总多条并行分支产出供下游消费' },
  { id: 'artifact', label: '画布产出', badge: 'UI', desc: '提取或封装 HTML/SVG/媒体画廊推送实时画布' },
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
    mediaConfig: (n && n.mediaConfig && typeof n.mediaConfig === 'object') ? { ...n.mediaConfig } : null,
    loopConfig: (n && n.loopConfig && typeof n.loopConfig === 'object') ? { ...n.loopConfig } : null,
    retryCount: Math.max(0, Math.min(3, Math.round(Number(n && n.retryCount) || 0))),
    timeoutMs: Math.max(0, Math.min(300000, Math.round(Number(n && n.timeoutMs) || 0))),
    pos: (n && n.pos && Number.isFinite(Number(n.pos.x)) && Number.isFinite(Number(n.pos.y)))
      ? { x: Math.max(12, Math.round(Number(n.pos.x))), y: Math.max(12, Math.round(Number(n.pos.y))) }
      : null,
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
    variables: (w.variables && typeof w.variables === 'object' && !Array.isArray(w.variables)) ? { ...w.variables } : {},
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

  let maxRight = totalWidth
  let maxBottom = totalHeight
  layers.forEach((layer, colIdx) => {
    const colH = layer.length * NODE_H + Math.max(0, layer.length - 1) * ROW_GAP
    const startY = Math.round((totalHeight - colH) / 2)
    const autoX = PAD_X + colIdx * (NODE_W + COL_GAP)
    layer.forEach((id, rowIdx) => {
      const node = nodesById.get(id)
      const x = node && node.pos ? node.pos.x : autoX
      const y = node && node.pos ? node.pos.y : (startY + rowIdx * (NODE_H + ROW_GAP))
      positions[id] = { x, y, width: NODE_W, height: NODE_H, col: colIdx, row: rowIdx }
      if (x + NODE_W + PAD_X > maxRight) maxRight = x + NODE_W + PAD_X
      if (y + NODE_H + PAD_Y > maxBottom) maxBottom = y + NODE_H + PAD_Y
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
    layout: { width: maxRight, height: maxBottom, positions },
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
/** 计算某节点及其全部下游可达子图（用于单节点/局部重跑）。 */
export function collectDownstreamSet(workflow, startNodeId) {
  const wf = normalizeWorkflowDef(workflow)
  const out = new Set([startNodeId])
  const queue = [startNodeId]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const e of wf.edges) {
      if (e.from === cur && !out.has(e.to)) {
        out.add(e.to)
        queue.push(e.to)
      }
    }
  }
  return out
}

export async function executeWorkflowDag({
  workflow,
  input = '',
  vars = {},
  resumeOutputs = null,
  runFromNodeId = '',
  signal = null,
  runLlmNode,
  runToolNode,
  runImageNode,
  runVideoNode,
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
  let lastArtifact = null

  const mergedVars = { ...(wf.variables || {}), ...(vars || {}) }
  const rerunScope = runFromNodeId ? collectDownstreamSet(wf, runFromNodeId) : null

  for (const n of wf.nodes) {
    const canReuse = resumeOutputs
      && Object.prototype.hasOwnProperty.call(resumeOutputs, n.id)
      && (!rerunScope || !rerunScope.has(n.id))
    if (canReuse) {
      const prevRec = resumeOutputs[n.id]
      const prevObj = (prevRec && typeof prevRec === 'object') ? prevRec : { output: String(prevRec || '') }
      nodeStates[n.id] = { status: 'done', ms: 0, output: prevObj.output || '', imageUrl: prevObj.imageUrl || '', videoUrl: prevObj.videoUrl || '', summary: '断点/上游已复用' }
      outputs[n.id] = { ...prevObj }
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
    const tplCtx = { input, upstream: upstreamText, nodes: outputs, vars: mergedVars }

    const nodeT0 = Date.now()
    for (const e of inEdges) {
      if (branchPass.get(e.id) !== false) activeEdges.add(e.id)
    }
    nodeStates[node.id] = { status: node.kind === 'human_gate' ? 'waiting_human' : 'running', ms: 0, output: '', summary: '执行中…' }
    emit()

    let outText = ''
    let extraMeta = {}
    const runWithRetry = async (fn) => {
      const maxTries = 1 + (Number(node.retryCount) || 0)
      let lastErr
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        if (signal && signal.aborted) throw new Error('USER_PAUSED')
        try {
          if (node.timeoutMs > 0) {
            return await Promise.race([
              fn(attempt),
              new Promise((_, rej) => setTimeout(() => rej(new Error(`节点执行超时（>${node.timeoutMs}ms）`)), node.timeoutMs)),
            ])
          }
          return await fn(attempt)
        } catch (e) {
          lastErr = e
          if (isAbort(e) || (signal && signal.aborted) || String(e && e.message) === 'USER_PAUSED' || attempt >= maxTries) {
            throw e
          }
          pushLog(`↻ 节点「${node.label}」第 ${attempt} 次失败，准备重试（${attempt}/${maxTries - 1}）…`)
          emit()
        }
      }
      throw lastErr
    }

    try {
      if (node.kind === 'input') {
        outText = String(input || '').trim()
      } else if (node.kind === 'image_gen') {
        const mc = node.mediaConfig || {}
        const finalPrompt = interpolateTemplate(node.prompt || '{{upstream}}' || '{{input}}', tplCtx).trim() || String(input || '').trim()
        const imgRes = await runWithRetry(() => (
          typeof runImageNode === 'function'
            ? runImageNode({
              node,
              prompt: finalPrompt,
              aspectRatio: mc.aspectRatio || '1:1',
              size: mc.size || '',
              style: mc.style || '',
              quality: mc.quality || 'standard',
              model: node.model || mc.model || '',
              signal,
            })
            : Promise.resolve({
              ok: true,
              simulated: true,
              items: [{ url: `https://example.local/mock-image-${node.id}.png` }],
            })
        ))
        const firstUrl = (imgRes && Array.isArray(imgRes.items) && imgRes.items[0] && imgRes.items[0].url) || ''
        extraMeta = { imageUrl: firstUrl, mediaItems: (imgRes && imgRes.items) || [] }
        if (imgRes && imgRes.artifact) {
          lastArtifact = imgRes.artifact
          if (typeof onArtifact === 'function') onArtifact(imgRes.artifact)
        }
        outText = firstUrl
          ? `![${node.label}](${firstUrl})

- **生图模型**：\`${(imgRes && imgRes.model) || node.model || 'auto'}\`（${(imgRes && imgRes.aspectRatio) || mc.aspectRatio || '1:1'}）
- **生图提示词**：${finalPrompt.slice(0, 260)}`
          : `图片生成完成（${finalPrompt.slice(0, 120)}）`
      } else if (node.kind === 'video_gen') {
        const mc = node.mediaConfig || {}
        const finalPrompt = interpolateTemplate(node.prompt || '{{upstream}}' || '{{input}}', tplCtx).trim() || String(input || '').trim()
        // 自动继承上游 image_gen 节点产出的首帧图（实现无缝 T2I → I2V 图生视频接力！）
        const inheritedImg = inEdges
          .map((e) => outputs[e.from] && outputs[e.from].imageUrl)
          .find(Boolean) || ''
        const refImg = interpolateTemplate(mc.imageUrl || '', tplCtx).trim() || inheritedImg
        const vidRes = await runWithRetry(() => (
          typeof runVideoNode === 'function'
            ? runVideoNode({
              node,
              prompt: finalPrompt,
              imageUrl: refImg,
              duration: Number(mc.duration) || 5,
              aspectRatio: mc.aspectRatio || '16:9',
              resolution: mc.resolution || '1080p',
              withAudio: !!mc.withAudio,
              model: node.model || mc.model || '',
              signal,
              onProgress: (prog) => {
                nodeStates[node.id] = {
                  status: 'running',
                  ms: Date.now() - nodeT0,
                  output: String((prog && prog.message) || '视频渲染中…'),
                  summary: String((prog && prog.message) || '视频渲染中…').slice(0, 68),
                }
                emit()
              },
            })
            : Promise.resolve({
              ok: true,
              simulated: true,
              items: [{ url: `https://example.local/mock-video-${node.id}.mp4`, coverUrl: refImg }],
            })
        ))
        const firstVid = (vidRes && Array.isArray(vidRes.items) && vidRes.items[0] && vidRes.items[0].url) || ''
        extraMeta = { videoUrl: firstVid, imageUrl: refImg, mediaItems: (vidRes && vidRes.items) || [] }
        if (vidRes && vidRes.artifact) {
          lastArtifact = vidRes.artifact
          if (typeof onArtifact === 'function') onArtifact(vidRes.artifact)
        }
        outText = `🎬 **AI 视频渲染完成**（${refImg ? '图生视频 I2V' : '文生视频 T2V'} · ${(vidRes && vidRes.model) || node.model || 'auto'} · ${Number(mc.duration) || 5}s）
- **视频地址**：${firstVid || '已在右侧实时画布打开'}
- **分镜提示词**：${finalPrompt.slice(0, 260)}`
      } else if (node.kind === 'loop') {
        const lc = node.loopConfig || {}
        const maxIter = Math.max(1, Math.min(5, Math.round(Number(lc.maxIterations) || 3)))
        const stopKw = String(lc.stopKeyword || 'APPROVED').trim()
        const basePrompt = interpolateTemplate(
          // r19 这里是**单引号包了一个跨 4 行的字符串**（JS 非法）⇒ esbuild:
          // "Unterminated string literal"，整个应用无法构建。改为模板字符串，
          // 内容与 {{input}} / {{upstream}} 占位符逐字保留。
          node.prompt || `请完成并迭代优化以下任务：
{{input}}

上游上下文：
{{upstream}}`,
          tplCtx
        )
        let currentDraft = ''
        const traceLines = []
        for (let iter = 1; iter <= maxIter; iter++) {
          if (signal && signal.aborted) throw new Error('USER_PAUSED')
          const iterPrompt = iter === 1
            ? `${basePrompt}

（当前为第 1/${maxIter} 轮精修：请输出高质量首稿，若已完全达标请在末尾写 ${stopKw}）`
            : `【第 ${iter}/${maxIter} 轮自检与精修】
请严格审查下方上一轮草稿中的逻辑漏洞、体验短板与细节瑕疵并直接输出升级后的完整终稿；若已达到生产交付水准，在末尾标注 ${stopKw}：

${currentDraft}`
          nodeStates[node.id] = {
            status: 'running',
            ms: Date.now() - nodeT0,
            output: currentDraft || `第 ${iter}/${maxIter} 轮精修推演中…`,
            summary: `精修循环 ${iter}/${maxIter} 轮…`,
          }
          emit()
          const iterRes = await runWithRetry(() => (
            typeof runLlmNode === 'function'
              ? runLlmNode({ node, prompt: iterPrompt, upstream: upstreamText, input, signal })
              : Promise.resolve({ content: `[Loop #${iter}] 已精修（${stopKw}）` })
          ))
          currentDraft = typeof iterRes === 'string' ? iterRes : String((iterRes && iterRes.content) || '')
          traceLines.push(`第 ${iter} 轮（${currentDraft.length} 字）`)
          pushLog(`🔁 循环节点「${node.label}」完成第 ${iter}/${maxIter} 轮精修`)
          emit()
          if (stopKw && currentDraft.toUpperCase().includes(stopKw.toUpperCase())) {
            pushLog(`✓ 循环节点「${node.label}」于第 ${iter} 轮命中达标标记 ${stopKw}，提前收口`)
            break
          }
        }
        outText = currentDraft
        extraMeta = { iterations: traceLines.length }
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
        if (artifact) {
          lastArtifact = artifact
          if (typeof onArtifact === 'function') onArtifact(artifact)
        }
        outText = artifact ? `已推送交互画布产物：「${artifact.title}」（${artifact.filename}）\n\n${sourceText.slice(0, 600)}` : sourceText
      } else {
        // llm node（支持流式增量实时回推到画布节点与右侧检视器）
        const promptText = interpolateTemplate(
          node.prompt || `请以「${node.role || node.label}」身份完成以下任务：\n{{input}}\n\n前序节点输出：\n{{upstream}}`,
          tplCtx
        )
        let lastDeltaEmit = 0
        const onDelta = (partialText, cps = 0) => {
          const now = Date.now()
          if (now - lastDeltaEmit < 90) return
          lastDeltaEmit = now
          const str = String(partialText || '')
          nodeStates[node.id] = {
            status: 'running',
            ms: now - nodeT0,
            cps: Math.round(Number(cps) || 0),
            output: str,
            summary: str.replace(/\s+/g, ' ').trim().slice(-72) || '实时推理中…',
          }
          emit()
        }
        if (typeof runLlmNode === 'function') {
          const res = await runLlmNode({ node, prompt: promptText, upstream: upstreamText, input, signal, onDelta })
          outText = typeof res === 'string' ? res : String((res && res.content) || '')
        } else {
          outText = `[${node.label}] 已处理：${promptText.slice(0, 120)}`
        }
      }

      const ms = Date.now() - nodeT0
      outputs[node.id] = { output: outText, ...extraMeta }
      nodeStates[node.id] = {
        status: 'done',
        ms,
        output: outText,
        ...extraMeta,
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
    emit({ status: 'done', totalMs, finalOutput, lastArtifact })
    return {
      status: 'done',
      workflowId: wf.id,
      nodeStates,
      outputs,
      finalOutput,
      lastArtifact,
      totalMs,
      logs,
      checkpoint: null,
    }
  } catch (err) {
    const aborted = isAbort(err) || (signal && signal.aborted) || String(err && err.message) === 'USER_PAUSED'
    const completedOutputs = {}
    for (const [nid, rec] of Object.entries(outputs)) completedOutputs[nid] = rec
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


/** 一句话自然语言智能编译为多节点并发 DAG 工作流（离线零延迟确定性合成，覆盖研发/调研/审计/创作四大范式）。 */
export function synthesizeWorkflowFromPrompt(goalText = '') {
  const goal = String(goalText || '').trim()
  const titleSeed = goal.slice(0, 18) || '智能定制流水线'
  const isVideo = /视频|短片|宣传片|片头|动画短片|分镜视频|sora|cogvideo|t2v|i2v|movie|film/i.test(goal)
  const isImage = /画一张|生图|图片|海报|封面|插画|logo|视觉图|壁纸|配图|cogview|flux|poster/i.test(goal)
  const isResearch = /调研|研究|竞品|对比|分析|报告|swot|市场|趋势/i.test(goal)
  const isAudit = /审计|安全|漏洞|体检|重构|压测|review|bug|报错/i.test(goal)
  const isContent = /文案|文章|脚本|公众号|小红书|营销|宣传/i.test(goal)

  if (isVideo) {
    return normalizeWorkflowDef({
      id: `wf_gen_${Date.now().toString(36)}`,
      pluginId: 'custom',
      name: `AI 视频流水线：${titleSeed}`,
      description: `由「${goal}」自动编排的导演分镜 → 拍板 → 首帧概念生图 → 图生视频 (I2V) → 放映厅全链路。`,
      category: 'media',
      builtin: false,
      nodes: [
        { id: 'in', kind: 'input', label: '短片创意' },
        { id: 'script', kind: 'llm', label: '导演分镜与提示词', role: 'AI 影片导演', prompt: `围绕「${goal}」（{{input}}）拆解 3 镜头节奏，并提炼 1 段精炼英文视觉首帧提示词与动态运镜描述。` },
        { id: 'gate', kind: 'human_gate', label: '画幅与节奏拍板' },
        { id: 'keyframe', kind: 'image_gen', label: '首帧关键图生成', prompt: '{{nodes.script.output}} · 风格：{{nodes.gate.output}}', mediaConfig: { aspectRatio: '16:9', quality: 'hd' } },
        { id: 'clip', kind: 'video_gen', label: '图生视频渲染 (I2V)', prompt: '{{nodes.script.output}}', mediaConfig: { duration: 5, aspectRatio: '16:9', resolution: '1080p', withAudio: true } },
      ],
      edges: [
        { from: 'in', to: 'script' },
        { from: 'script', to: 'gate' },
        { from: 'gate', to: 'keyframe' },
        { from: 'keyframe', to: 'clip' },
      ],
    })
  }

  if (isImage) {
    return normalizeWorkflowDef({
      id: `wf_gen_${Date.now().toString(36)}`,
      pluginId: 'custom',
      name: `AI 视觉生图：${titleSeed}`,
      description: `由「${goal}」自动编排的提示词总监 → 风格拍板 → 双风格并行出图流水线。`,
      category: 'media',
      builtin: false,
      nodes: [
        { id: 'in', kind: 'input', label: '画面需求' },
        { id: 'art_dir', kind: 'llm', label: '视觉提示词总监', role: '资深视觉指导', prompt: `围绕「${goal}」（{{input}}）提炼高精度构图、光影与材质描述，便于生图模型直出大片。` },
        { id: 'gate', kind: 'human_gate', label: '画幅与美学拍板' },
        { id: 'img_a', kind: 'image_gen', label: '主视觉成图 A', prompt: '{{nodes.art_dir.output}} · 方向：{{nodes.gate.output}}', mediaConfig: { aspectRatio: '16:9', style: '电影光影写实', quality: 'hd' } },
        { id: 'img_b', kind: 'image_gen', label: '创意变体 B', prompt: '{{nodes.art_dir.output}} · 方向：{{nodes.gate.output}}', mediaConfig: { aspectRatio: '16:9', style: '极简潮流艺术', quality: 'hd' } },
        { id: 'join', kind: 'merge', label: '双图交付汇总' },
      ],
      edges: [
        { from: 'in', to: 'art_dir' },
        { from: 'art_dir', to: 'gate' },
        { from: 'gate', to: 'img_a' },
        { from: 'gate', to: 'img_b' },
        { from: 'img_a', to: 'join' },
        { from: 'img_b', to: 'join' },
      ],
    })
  }

  if (isResearch) {
    return normalizeWorkflowDef({
      id: `wf_gen_${Date.now().toString(36)}`,
      pluginId: 'custom',
      name: `智能生成：${titleSeed}`,
      description: `由自然语言需求「${goal}」自动编排的双轨调研与可视化报告流水线。`,
      category: 'research',
      builtin: false,
      nodes: [
        { id: 'in', kind: 'input', label: '调研命题' },
        { id: 'pro', kind: 'llm', label: '核心维度拆解', role: '资深行业分析师', prompt: `围绕目标「${goal}」及输入「{{input}}」，输出结构化核心事实与对比维度。` },
        { id: 'risk', kind: 'llm', label: '盲区与反证', role: '红队评审专家', prompt: `针对「${goal}」（{{input}}），找出 3 个关键风险、隐藏成本与常见误区。` },
        { id: 'join', kind: 'merge', label: '双轨洞察汇合' },
        { id: 'html_rep', kind: 'llm', label: 'HTML 报告生成', role: '信息可视化设计师', prompt: '将以下双轨洞察渲染为一份高颜值单页 HTML 执行报告（用 ```html 代码块输出）：\n{{upstream}}' },
        { id: 'art', kind: 'artifact', label: '报告实时画布', prompt: '{{nodes.html_rep.output}}' },
      ],
      edges: [
        { from: 'in', to: 'pro' },
        { from: 'in', to: 'risk' },
        { from: 'pro', to: 'join' },
        { from: 'risk', to: 'join' },
        { from: 'join', to: 'html_rep' },
        { from: 'html_rep', to: 'art' },
      ],
    })
  }

  if (isAudit) {
    return normalizeWorkflowDef({
      id: `wf_gen_${Date.now().toString(36)}`,
      pluginId: 'custom',
      name: `智能生成：${titleSeed}`,
      description: `由需求「${goal}」自动编排的目录扫描 → 审计 → 条件分流重构流水线。`,
      category: 'security',
      builtin: false,
      nodes: [
        { id: 'in', kind: 'input', label: '审计输入' },
        { id: 'scan', kind: 'tool', label: '工作区目录扫描', toolName: 'list_dir', toolArgs: { path: '.' } },
        { id: 'audit', kind: 'llm', label: '深度代码审计', role: '首席安全架构师', allowTools: true, prompt: `目标：${goal}\n补充：{{input}}\n目录：{{nodes.scan.output}}\n若存在高危问题请标注 HIGH_RISK。` },
        { id: 'cond', kind: 'condition', label: '高危判定门', condition: { op: 'contains', value: 'HIGH_RISK' } },
        { id: 'fix', kind: 'llm', label: '紧急修复补丁', role: '重构专家', prompt: '给出可落地的修复步骤与验证清单：\n{{nodes.audit.output}}' },
        { id: 'ok_sum', kind: 'merge', label: '常规改进汇总', prompt: '未发现阻断高危，常规建议如下：\n{{nodes.audit.output}}' },
      ],
      edges: [
        { from: 'in', to: 'scan' },
        { from: 'scan', to: 'audit' },
        { from: 'audit', to: 'cond' },
        { from: 'cond', to: 'fix', when: 'true', label: '含高危' },
        { from: 'cond', to: 'ok_sum', when: 'false', label: '常规' },
      ],
    })
  }

  if (isContent) {
    return normalizeWorkflowDef({
      id: `wf_gen_${Date.now().toString(36)}`,
      pluginId: 'custom',
      name: `智能生成：${titleSeed}`,
      description: `由需求「${goal}」自动编排的并行创意钩子 + 结构化终稿流水线。`,
      category: 'creative',
      builtin: false,
      nodes: [
        { id: 'in', kind: 'input', label: '创作命题' },
        { id: 'hook', kind: 'llm', label: '开场钩子', role: '增长文案总监', prompt: `针对「${goal}」（{{input}}）设计 3 个高吸睛开场。` },
        { id: 'body', kind: 'llm', label: '核心结构', role: '内容主编', prompt: `针对「${goal}」（{{input}}）规划高密度正文脉络与案例。` },
        { id: 'gate', kind: 'human_gate', label: '风格语气拍板' },
        { id: 'merge', kind: 'merge', label: '创意汇合' },
        { id: 'final', kind: 'llm', label: '终稿精修', role: '总编辑', prompt: '结合所选风格输出可直接发布的成稿：\n{{upstream}}' },
      ],
      edges: [
        { from: 'in', to: 'hook' },
        { from: 'in', to: 'body' },
        { from: 'in', to: 'gate' },
        { from: 'hook', to: 'merge' },
        { from: 'body', to: 'merge' },
        { from: 'gate', to: 'merge' },
        { from: 'merge', to: 'final' },
      ],
    })
  }

  // 默认工程并行交付流水线
  return normalizeWorkflowDef({
    id: `wf_gen_${Date.now().toString(36)}`,
    pluginId: 'custom',
    name: `智能生成：${titleSeed}`,
    description: `由需求「${goal || '全栈交付'}」自动编排的架构 → 并行规范/拍板 → 代码实现 → 实时画布流水线。`,
    category: 'engineering',
    builtin: false,
    nodes: [
      { id: 'in', kind: 'input', label: '需求输入' },
      { id: 'arch', kind: 'llm', label: '方案架构', role: '系统架构师', prompt: `围绕「${goal}」（{{input}}）拆解核心功能与实现架构。` },
      { id: 'design', kind: 'llm', label: '界面与交互规范', role: 'UI 设计师', prompt: '制定高质感配色、布局与动效细节：\n{{upstream}}' },
      { id: 'gate', kind: 'human_gate', label: '方案方向拍板' },
      { id: 'join', kind: 'merge', label: '规范汇合' },
      { id: 'impl', kind: 'llm', label: '工程落地实现', role: '全栈工程师', allowTools: true, prompt: '严格按汇合规范输出完整可运行实现（网页请用 ```html 代码块）：\n{{upstream}}' },
      { id: 'art', kind: 'artifact', label: '实时交互画布', prompt: '{{nodes.impl.output}}' },
    ],
    edges: [
      { from: 'in', to: 'arch' },
      { from: 'arch', to: 'design' },
      { from: 'arch', to: 'gate' },
      { from: 'design', to: 'join' },
      { from: 'gate', to: 'join' },
      { from: 'join', to: 'impl' },
      { from: 'impl', to: 'art' },
    ],
  })
}

/** 将工作流运行结果格式化为完整 Markdown 交付报告。 */
export function formatWorkflowRunMarkdown(workflow, run) {
  if (!workflow) return ''
  const states = (run && run.nodeStates) || {}
  const lines = [
    `# 工作流执行报告：${workflow.name || '未命名工作流'}`,
    '',
    `- **工作流 ID**：\`${workflow.id}\``,
    `- **执行状态**：${(run && run.status) || 'idle'}`,
    `- **总耗时**：${(run && run.totalMs) || 0} ms`,
    ...(run && run.input ? [`- **输入目标**：${run.input}`] : []),
    '',
    '---',
    '',
  ]
  for (const n of (workflow.nodes || [])) {
    const st = states[n.id] || {}
    lines.push(`## ${n.label} (\`${n.id}\` · ${n.kind} · ${st.status || 'pending'})`, '')
    lines.push(String(st.output || '（无输出）').trim(), '', '---', '')
  }
  return lines.join('\n')
}


/** 清除全部手动拖拽坐标，一键恢复 Kahn 拓扑自动分层排布。 */
export function resetWorkflowLayoutPositions(workflow) {
  const wf = normalizeWorkflowDef(workflow)
  return {
    ...wf,
    nodes: wf.nodes.map((n) => ({ ...n, pos: null })),
  }
}
