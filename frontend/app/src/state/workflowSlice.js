/**
 * 插件与 DAG 工作流领域切片（R16 架构解耦）：
 * - 独立管理插件启用态、用户自定义热插拔插件、工作流列表 CRUD、DAG 运行状态与断点；
 * - 零反向耦合 store.js，仅依赖 state/kernel.js 与 services/*，严守 LAW-07。
 */
import { readStorage, writeStorage } from '../platform/storage.js'
import { getState, patchSlice } from './kernel.js'
import {
  resolveAllPlugins,
  collectEnabledWorkflows,
  validateCustomPluginManifest,
} from '../services/pluginRegistry.js'
import {
  normalizeWorkflowDef,
  analyzeWorkflowDag,
  executeWorkflowDag,
  compileGroupToWorkflow,
} from '../services/workflowEngine.js'

const PLUGINS_ENABLED_KEY = 'harbor.v5.plugins.enabled'
const PLUGINS_CUSTOM_KEY = 'harbor.v5.plugins.custom'
const WORKFLOWS_CUSTOM_KEY = 'harbor.v5.workflows.custom'

function readJsonStorage(key, fallback) {
  try {
    const raw = readStorage(key, '')
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export function createInitialPluginsSlice() {
  const enabledMap = readJsonStorage(PLUGINS_ENABLED_KEY, {})
  const customPlugins = readJsonStorage(PLUGINS_CUSTOM_KEY, [])
  const customWorkflows = readJsonStorage(WORKFLOWS_CUSTOM_KEY, [])
  const plugins = resolveAllPlugins(enabledMap, customPlugins)
  const workflows = collectEnabledWorkflows(plugins, customWorkflows)
  return {
    enabledMap,
    customPlugins: Array.isArray(customPlugins) ? customPlugins : [],
    customWorkflows: Array.isArray(customWorkflows) ? customWorkflows : [],
    plugins,
    workflows,
    activeWorkflowId: (workflows[0] && workflows[0].id) || '',
    viewTab: 'studio', // 'studio' | 'plugins'
    run: {
      status: 'idle', // 'idle' | 'running' | 'paused' | 'done' | 'error'
      workflowId: '',
      input: '',
      nodeStates: {},
      activeEdges: [],
      logs: [],
      finalOutput: '',
      totalMs: 0,
      error: '',
      checkpoint: null,
    },
  }
}

function recomputeAndPersist(nextEnabledMap, nextCustomPlugins, nextCustomWorkflows, preferredWfId = '') {
  try { writeStorage(PLUGINS_ENABLED_KEY, JSON.stringify(nextEnabledMap)) } catch {}
  try { writeStorage(PLUGINS_CUSTOM_KEY, JSON.stringify(nextCustomPlugins)) } catch {}
  try { writeStorage(WORKFLOWS_CUSTOM_KEY, JSON.stringify(nextCustomWorkflows)) } catch {}
  const plugins = resolveAllPlugins(nextEnabledMap, nextCustomPlugins)
  const workflows = collectEnabledWorkflows(plugins, nextCustomWorkflows)
  const curId = preferredWfId || (getState().plugins && getState().plugins.activeWorkflowId) || ''
  const activeWorkflowId = workflows.some((w) => w.id === curId) ? curId : ((workflows[0] && workflows[0].id) || '')
  patchSlice('plugins', (p) => ({
    ...p,
    enabledMap: nextEnabledMap,
    customPlugins: nextCustomPlugins,
    customWorkflows: nextCustomWorkflows,
    plugins,
    workflows,
    activeWorkflowId,
  }))
  return { plugins, workflows, activeWorkflowId }
}

export function setWorkflowViewTab(tab) {
  patchSlice('plugins', { viewTab: tab === 'plugins' ? 'plugins' : 'studio' })
}

export function selectWorkflow(workflowId) {
  const st = getState().plugins
  if (!st || !st.workflows.some((w) => w.id === workflowId)) return
  patchSlice('plugins', (p) => ({
    ...p,
    activeWorkflowId: workflowId,
    viewTab: 'studio',
  }))
}

export function togglePluginEnabled(pluginId, enabled) {
  const st = getState().plugins
  const target = st.plugins.find((p) => p.id === pluginId)
  if (!target || target.locked) return { ok: false, message: '核心内核插件不可禁用' }
  const nextVal = typeof enabled === 'boolean' ? enabled : !target.enabled
  const nextMap = { ...st.enabledMap, [pluginId]: nextVal }
  recomputeAndPersist(nextMap, st.customPlugins, st.customWorkflows)
  return { ok: true, enabled: nextVal, name: target.name }
}

export function installCustomPlugin(rawJson) {
  const res = validateCustomPluginManifest(rawJson)
  if (!res.ok) return res
  const st = getState().plugins
  const filtered = st.customPlugins.filter((p) => p.id !== res.plugin.id)
  const nextCustom = [res.plugin, ...filtered]
  const nextMap = { ...st.enabledMap, [res.plugin.id]: true }
  const firstWfId = (res.plugin.contributes.workflows && res.plugin.contributes.workflows[0] && res.plugin.contributes.workflows[0].id) || ''
  recomputeAndPersist(nextMap, nextCustom, st.customWorkflows, firstWfId)
  return { ok: true, plugin: res.plugin }
}

export function uninstallCustomPlugin(pluginId) {
  const st = getState().plugins
  const nextCustom = st.customPlugins.filter((p) => p.id !== pluginId)
  const nextMap = { ...st.enabledMap }
  delete nextMap[pluginId]
  recomputeAndPersist(nextMap, nextCustom, st.customWorkflows)
  return { ok: true }
}

export function createBlankCustomWorkflow(name = '') {
  const st = getState().plugins
  const wf = normalizeWorkflowDef({
    id: `wf_custom_${Date.now().toString(36)}`,
    pluginId: 'custom',
    name: String(name || '').trim() || `自定义工作流 ${(st.customWorkflows || []).length + 1}`,
    description: '支持自由增删并行节点、直调工具、条件分支与实时画布输出。',
    category: 'custom',
    builtin: false,
    nodes: [
      { id: 'in', kind: 'input', label: '任务输入' },
      { id: 'step_1', kind: 'llm', label: '智能分析', role: '资深专家', prompt: '请深入分析以下任务并给出方案：\n{{input}}' },
      { id: 'step_2', kind: 'artifact', label: '实时画布输出', prompt: '{{upstream}}' },
    ],
    edges: [
      { from: 'in', to: 'step_1' },
      { from: 'step_1', to: 'step_2' },
    ],
  })
  const nextCustomWf = [wf, ...st.customWorkflows]
  recomputeAndPersist(st.enabledMap, st.customPlugins, nextCustomWf, wf.id)
  return wf
}

export function saveCustomWorkflowDef(rawWorkflow) {
  const norm = normalizeWorkflowDef({ ...rawWorkflow, builtin: false })
  const check = analyzeWorkflowDag(norm)
  if (!check.ok) return { ok: false, error: check.error }
  const st = getState().plugins
  const existsInCustom = st.customWorkflows.some((w) => w.id === norm.id)
  // 若编辑的是内置插件工作流，则自动克隆一份自定义副本（不破坏只读内置模板）
  const finalWf = (!existsInCustom && st.workflows.some((w) => w.id === norm.id && w.builtin))
    ? { ...norm, id: `${norm.id}_custom_${Date.now().toString(36)}`, name: `${norm.name}（自定义版）` }
    : norm
  const nextCustomWf = [finalWf, ...st.customWorkflows.filter((w) => w.id !== finalWf.id)]
  recomputeAndPersist(st.enabledMap, st.customPlugins, nextCustomWf, finalWf.id)
  return { ok: true, workflow: finalWf }
}

export function deleteCustomWorkflowDef(workflowId) {
  const st = getState().plugins
  const nextCustomWf = st.customWorkflows.filter((w) => w.id !== workflowId)
  recomputeAndPersist(st.enabledMap, st.customPlugins, nextCustomWf)
  return { ok: true }
}

export function compileActiveGroupToWorkflow() {
  const g = getState().group
  const wf = compileGroupToWorkflow(g)
  const st = getState().plugins
  const nextCustomWf = [wf, ...st.customWorkflows]
  recomputeAndPersist(st.enabledMap, st.customPlugins, nextCustomWf, wf.id)
  return wf
}

let _wfAbortCtrl = null
const _wfDemoTimers = []

export function stopWorkflowExecution() {
  while (_wfDemoTimers.length) clearTimeout(_wfDemoTimers.pop())
  if (_wfAbortCtrl) {
    _wfAbortCtrl.abort()
    _wfAbortCtrl = null
  }
  patchSlice('plugins', (p) => ({
    ...p,
    run: {
      ...p.run,
      status: p.run.status === 'running' ? 'paused' : p.run.status,
      activeEdges: [],
    },
  }))
}

export function resetWorkflowRunState() {
  stopWorkflowExecution()
  patchSlice('plugins', (p) => ({
    ...p,
    run: {
      status: 'idle',
      workflowId: p.activeWorkflowId,
      input: '',
      nodeStates: {},
      activeEdges: [],
      logs: [],
      finalOutput: '',
      totalMs: 0,
      error: '',
      checkpoint: null,
    },
  }))
}

export async function runWorkflowWithHandlers({
  workflowId = '',
  input = '',
  resume = false,
  runLlmNode,
  runToolNode,
  requestHumanGate,
  onArtifact,
}) {
  const st = getState().plugins
  const wf = st.workflows.find((w) => w.id === (workflowId || st.activeWorkflowId))
  if (!wf) return { ok: false, error: '未找到目标工作流' }
  while (_wfDemoTimers.length) clearTimeout(_wfDemoTimers.pop())
  if (_wfAbortCtrl) _wfAbortCtrl.abort()
  _wfAbortCtrl = new AbortController()

  const resumeOutputs = resume && st.run && st.run.checkpoint && st.run.checkpoint.workflowId === wf.id
    ? st.run.checkpoint.completedOutputs
    : null
  const finalInput = String(input || (st.run && st.run.checkpoint && st.run.checkpoint.input) || '').trim()

  patchSlice('plugins', (p) => ({
    ...p,
    activeWorkflowId: wf.id,
    run: {
      status: 'running',
      workflowId: wf.id,
      input: finalInput,
      nodeStates: {},
      activeEdges: [],
      logs: [],
      finalOutput: '',
      totalMs: 0,
      error: '',
      checkpoint: null,
    },
  }))

  const result = await executeWorkflowDag({
    workflow: wf,
    input: finalInput,
    resumeOutputs,
    signal: _wfAbortCtrl.signal,
    runLlmNode,
    runToolNode,
    requestHumanGate,
    onArtifact,
    onProgress: (prog) => {
      patchSlice('plugins', (p) => ({
        ...p,
        run: {
          ...p.run,
          ...prog,
        },
      }))
    },
  })

  _wfAbortCtrl = null
  patchSlice('plugins', (p) => ({
    ...p,
    run: {
      ...p.run,
      status: result.status,
      nodeStates: result.nodeStates,
      activeEdges: [],
      logs: result.logs,
      finalOutput: result.finalOutput || '',
      totalMs: result.totalMs || 0,
      error: result.error || '',
      checkpoint: result.checkpoint || null,
    },
  }))
  return result
}

/** 确定性 DAG 并发光流演练（无需模型 Key，一键体验拓扑扇出与画布联动）。 */
export function triggerWorkflowShowcaseRun(onArtifact) {
  const st = getState().plugins
  const wf = st.workflows.find((w) => w.id === st.activeWorkflowId) || st.workflows[0]
  if (!wf) return
  const dag = analyzeWorkflowDag(wf)
  if (!dag.ok) return
  stopWorkflowExecution()

  const nodeStates = {}
  for (const n of wf.nodes) nodeStates[n.id] = { status: 'pending', ms: 0, output: '', summary: '' }
  patchSlice('plugins', (p) => ({
    ...p,
    run: {
      status: 'running',
      workflowId: wf.id,
      input: '演练：构建 Harbor 插件化工作流实时看板',
      nodeStates: { ...nodeStates },
      activeEdges: [],
      logs: [{ id: 'demo_0', at: Date.now(), text: `▶ 开始演练插件工作流「${wf.name}」` }],
      finalOutput: '',
      totalMs: 0,
      error: '',
      checkpoint: null,
    },
  }))

  const schedule = (ms, fn) => _wfDemoTimers.push(setTimeout(fn, ms))
  dag.layers.forEach((layer, idx) => {
    const startAt = idx * 620 + 120
    const endAt = startAt + 480
    schedule(startAt, () => {
      const nextStates = { ...(getState().plugins.run.nodeStates || {}) }
      const activeEdges = []
      for (const id of layer) {
        const node = dag.nodesById.get(id)
        nextStates[id] = { status: node && node.kind === 'human_gate' ? 'waiting_human' : 'running', ms: 0, output: '', summary: '拓扑执行中…' }
        for (const e of (dag.incoming.get(id) || [])) activeEdges.push(e.id)
      }
      patchSlice('plugins', (p) => ({
        ...p,
        run: {
          ...p.run,
          nodeStates: nextStates,
          activeEdges,
          logs: [...p.run.logs, { id: `d_s_${idx}`, at: Date.now(), text: `⚡ 第 ${idx + 1} 拓扑层运行：${layer.map((id) => dag.nodesById.get(id).label).join(' ∥ ')}` }],
        },
      }))
    })
    schedule(endAt, () => {
      const nextStates = { ...(getState().plugins.run.nodeStates || {}) }
      for (const id of layer) {
        const node = dag.nodesById.get(id)
        nextStates[id] = {
          status: 'done',
          ms: 360 + idx * 45,
          output: `【演练产出 · ${node ? node.label : id}】已按插件契约完成本节点执行并向下游透传结构化上下文。`,
          summary: `已完成 ${node ? node.label : id}`,
        }
      }
      const isLast = idx === dag.layers.length - 1
      patchSlice('plugins', (p) => ({
        ...p,
        run: {
          ...p.run,
          status: isLast ? 'done' : 'running',
          nodeStates: nextStates,
          activeEdges: [],
          totalMs: isLast ? endAt : p.run.totalMs,
          finalOutput: isLast ? `演练完成：工作流「${wf.name}」全部 ${wf.nodes.length} 个节点已通过并发拓扑验证。` : '',
          logs: [...p.run.logs, { id: `d_e_${idx}`, at: Date.now(), text: isLast ? `✦ 演练全部完成（${wf.nodes.length} 节点）` : `✓ 第 ${idx + 1} 层完成` }],
        },
      }))
      if (isLast && typeof onArtifact === 'function') {
        onArtifact({
          id: `wf_demo_art_${Date.now()}`,
          kind: 'html',
          lang: 'html',
          title: `${wf.name} · 演练交付`,
          filename: 'workflow-showcase.html',
          code: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DAG 演练交付</title><style>body{margin:0;padding:28px;font-family:"Segoe UI","PingFang SC",sans-serif;background:linear-gradient(135deg,#faf7f2,#eef6fb);color:#171614}.card{background:rgba(255,255,255,.85);border:1px solid rgba(0,0,0,.1);border-radius:18px;padding:22px;box-shadow:0 16px 36px -12px rgba(0,0,0,.12)}h1{margin:0 0 8px;font-size:20px;color:#d4653e}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}.kpi{padding:12px;border-radius:12px;background:#fff;border:1px solid rgba(0,0,0,.08)}.kpi strong{display:block;font-size:20px;color:#1282c8}</style></head><body><div class="card"><h1>✦ ${wf.name}</h1><p>插件化 DAG 工作流引擎已完成 ${dag.layers.length} 层拓扑并发调度，产物已自动送入实时交互画布。</p><div class="grid"><div class="kpi"><span>总节点</span><strong>${wf.nodes.length}</strong></div><div class="kpi"><span>拓扑层数</span><strong>${dag.layers.length}</strong></div><div class="kpi"><span>状态</span><strong>PASS</strong></div></div></div></body></html>`,
        })
      }
    })
  })
}
