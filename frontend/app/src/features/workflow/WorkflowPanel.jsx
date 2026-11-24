import { useMemo, useState } from 'react'
import {
  useSlice,
  setWorkflowViewTab,
  togglePlugin,
  installPluginJson,
  uninstallPlugin,
  createNewWorkflow,
  saveWorkflowDef,
  deleteWorkflowDef,
  cloneCurrentWorkflow,
  importWorkflowFromJson,
  synthesizeWorkflowNow,
  convertGroupToWorkflow,
  runActiveWorkflow,
  stopWorkflowRun,
  resetWorkflowRun,
  triggerWorkflowShowcase,
  openArtifactCanvas,
  exportWorkflowRunReport,
  pushToast,
} from '../../state/store.js'
import { analyzeWorkflowDag, WORKFLOW_NODE_KINDS } from '../../services/workflowEngine.js'
import { REASONING_TIERS } from '../../services/reasoningPresets.js'
import { SAMPLE_CUSTOM_PLUGIN_JSON } from '../../services/pluginRegistry.js'
import { copyText, downloadTextFile } from '../../platform/dom.js'
import WorkflowGraph from '../../ui/WorkflowGraph.jsx'
import './WorkflowPanel.css'

const TOOL_PRESET_NAMES = ['list_dir', 'read_file', 'write_file', 'search_replace', 'run_command', 'browser_search', 'list_workflow_plugins']

export default function WorkflowPanel() {
  const pluginsState = useSlice('plugins')
  const workflows = Array.isArray(pluginsState.workflows) ? pluginsState.workflows : []
  const plugins = Array.isArray(pluginsState.plugins) ? pluginsState.plugins : []
  const activeWf = workflows.find((w) => w.id === pluginsState.activeWorkflowId) || workflows[0] || null
  const run = pluginsState.run || { status: 'idle', nodeStates: {}, activeEdges: [], logs: [], lastArtifact: null }

  const [goalInput, setGoalInput] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [editingNode, setEditingNode] = useState(null)
  const [toolArgsDraft, setToolArgsDraft] = useState('{}')
  const [gateOptionsDraft, setGateOptionsDraft] = useState('')
  const [zoom, setZoom] = useState(1)

  const [showAddNode, setShowAddNode] = useState(false)
  const [newNodeLabel, setNewNodeLabel] = useState('')
  const [newNodeKind, setNewNodeKind] = useState('llm')
  const [newNodeFrom, setNewNodeFrom] = useState('')

  const [edgeTargetId, setEdgeTargetId] = useState('')
  const [edgeWhen, setEdgeWhen] = useState('always')

  const [showSynthBox, setShowSynthBox] = useState(false)
  const [synthPrompt, setSynthPrompt] = useState('')
  const [showEditMeta, setShowEditMeta] = useState(false)
  const [metaName, setMetaName] = useState('')
  const [metaDesc, setMetaDesc] = useState('')

  const [showInstallBox, setShowInstallBox] = useState(false)
  const [pluginJsonDraft, setPluginJsonDraft] = useState(SAMPLE_CUSTOM_PLUGIN_JSON)
  const [showImportWf, setShowImportWf] = useState(false)
  const [importWfDraft, setImportWfDraft] = useState('')

  const dag = useMemo(
    () => (activeWf ? analyzeWorkflowDag(activeWf) : { ok: false, error: '暂无可用工作流', layers: [], layout: { width: 640, height: 240, positions: {} } }),
    [activeWf]
  )

  const effectiveSelectedId = (activeWf && activeWf.nodes.some((n) => n.id === selectedNodeId))
    ? selectedNodeId
    : (activeWf && activeWf.nodes[0] ? activeWf.nodes[0].id : '')
  const selectedNode = activeWf ? activeWf.nodes.find((n) => n.id === effectiveSelectedId) : null
  const selectedState = (run.workflowId === (activeWf && activeWf.id) && effectiveSelectedId && run.nodeStates[effectiveSelectedId]) || null
  const isRunning = run.status === 'running'
  const canResume = run.status === 'paused' && run.checkpoint && activeWf && run.checkpoint.workflowId === activeWf.id

  const outEdges = activeWf && selectedNode ? activeWf.edges.filter((e) => e.from === selectedNode.id) : []
  const inEdges = activeWf && selectedNode ? activeWf.edges.filter((e) => e.to === selectedNode.id) : []
  const connectableTargets = activeWf && selectedNode
    ? activeWf.nodes.filter((n) => n.id !== selectedNode.id && !outEdges.some((e) => e.to === n.id))
    : []

  const beginEditNode = (node) => {
    setEditingNode({
      ...node,
      condition: node.condition ? { ...node.condition } : { op: 'contains', value: '' },
      gateConfig: node.gateConfig ? JSON.parse(JSON.stringify(node.gateConfig)) : {
        title: `确认：${node.label}`,
        subtitle: '请在下游继续执行前拍板方向',
        questions: [{ id: 'dir', label: '偏好方向', options: [{ id: 'a', label: '方案 A' }, { id: 'b', label: '方案 B' }] }],
      },
    })
    setToolArgsDraft(JSON.stringify(node.toolArgs || {}, null, 2))
    const q0 = node.gateConfig && node.gateConfig.questions && node.gateConfig.questions[0]
    setGateOptionsDraft(q0 && Array.isArray(q0.options) ? q0.options.map((o) => o.label).join('，') : '通透玻璃拟态，极简高对比，暖调杂志风')
  }

  const handleSaveEditedNode = () => {
    if (!activeWf || !editingNode) return
    const updated = { ...editingNode }
    if (updated.kind === 'tool') {
      try {
        updated.toolArgs = JSON.parse(toolArgsDraft || '{}')
      } catch {
        pushToast('工具参数必须是合法 JSON 对象', 'err')
        return
      }
    }
    if (updated.kind === 'human_gate') {
      const optLabels = gateOptionsDraft.split(/[，,\n]+/).map((s) => s.trim()).filter(Boolean)
      const opts = (optLabels.length ? optLabels : ['推荐方案', '深度打磨']).map((label, i) => ({
        id: `opt_${i + 1}`,
        label,
        desc: `按「${label}」方向推进后续节点`,
      }))
      updated.gateConfig = {
        title: (updated.gateConfig && updated.gateConfig.title) || updated.label,
        subtitle: (updated.gateConfig && updated.gateConfig.subtitle) || '请确认执行方向',
        allow_custom: true,
        questions: [{ id: 'dir', label: '选择期望方向', options: opts }],
      }
    }
    const nextNodes = activeWf.nodes.map((n) => (n.id === updated.id ? { ...n, ...updated } : n))
    const saved = saveWorkflowDef({ ...activeWf, nodes: nextNodes })
    if (saved && saved.ok) setEditingNode(null)
  }

  const handleAddEdge = () => {
    if (!activeWf || !selectedNode) return
    const tgt = edgeTargetId || (connectableTargets[0] && connectableTargets[0].id)
    if (!tgt) return
    const when = selectedNode.kind === 'condition' ? edgeWhen : 'always'
    const label = when === 'true' ? 'TRUE' : (when === 'false' ? 'FALSE' : '')
    const nextEdges = [...activeWf.edges, { id: `e_${selectedNode.id}_${tgt}_${Date.now().toString(36)}`, from: selectedNode.id, to: tgt, when, label }]
    const saved = saveWorkflowDef({ ...activeWf, edges: nextEdges })
    if (saved && saved.ok) setEdgeTargetId('')
  }

  const handleRemoveEdge = (edgeId) => {
    if (!activeWf) return
    const nextEdges = activeWf.edges.filter((e) => e.id !== edgeId)
    saveWorkflowDef({ ...activeWf, edges: nextEdges })
  }

  const handleAddNode = () => {
    if (!activeWf || !newNodeLabel.trim()) return
    const id = `n_${Date.now().toString(36)}`
    const parentId = newNodeFrom || (activeWf.nodes[activeWf.nodes.length - 1] && activeWf.nodes[activeWf.nodes.length - 1].id) || ''
    const nextNode = {
      id,
      kind: newNodeKind,
      label: newNodeLabel.trim(),
      role: newNodeKind === 'llm' ? newNodeLabel.trim() : '',
      prompt: newNodeKind === 'llm' ? `请以「${newNodeLabel.trim()}」身份处理：\n{{input}}\n\n前序结果：\n{{upstream}}` : '',
      toolName: newNodeKind === 'tool' ? 'list_dir' : '',
      toolArgs: newNodeKind === 'tool' ? { path: '.' } : {},
      condition: newNodeKind === 'condition' ? { op: 'contains', value: 'PASS' } : null,
    }
    const nextEdges = parentId
      ? [...activeWf.edges, { id: `e_${parentId}_${id}`, from: parentId, to: id, when: 'always' }]
      : [...activeWf.edges]
    const saved = saveWorkflowDef({ ...activeWf, nodes: [...activeWf.nodes, nextNode], edges: nextEdges })
    if (saved && saved.ok) {
      setSelectedNodeId(id)
      setNewNodeLabel('')
      setShowAddNode(false)
    }
  }

  const handleDeleteSelectedNode = () => {
    if (!activeWf || !selectedNode || activeWf.nodes.length <= 2) {
      pushToast('工作流至少需保留 2 个节点', 'warn')
      return
    }
    const nextNodes = activeWf.nodes.filter((n) => n.id !== selectedNode.id)
    const nextEdges = activeWf.edges.filter((e) => e.from !== selectedNode.id && e.to !== selectedNode.id)
    saveWorkflowDef({ ...activeWf, nodes: nextNodes, edges: nextEdges })
    setEditingNode(null)
  }

  const handleRun = () => {
    if (!activeWf || isRunning) return
    const text = goalInput.trim() || '请按本工作流标准执行示范任务并输出完整交付'
    runActiveWorkflow({ workflowId: activeWf.id, input: text, resume: false })
  }

  const handleSynthesize = () => {
    if (!synthPrompt.trim()) return
    synthesizeWorkflowNow(synthPrompt.trim())
    setSynthPrompt('')
    setShowSynthBox(false)
  }

  const handleSaveMeta = () => {
    if (!activeWf || !metaName.trim()) return
    const saved = saveWorkflowDef({ ...activeWf, name: metaName.trim(), description: metaDesc.trim() })
    if (saved && saved.ok) setShowEditMeta(false)
  }

  const enabledPluginCount = plugins.filter((p) => p.enabled).length

  return (
    <section className="wf-root">
      <header className="wf-head">
        <div className="wf-head-left">
          <h2 className="wf-title">⚡ 插件化 DAG 工作流工坊</h2>
          <div className="wf-seg" role="tablist" aria-label="工作流视图切换">
            <button
              type="button"
              className="wf-seg-btn"
              data-active={String(pluginsState.viewTab !== 'plugins')}
              onClick={() => setWorkflowViewTab('studio')}
            >
              编排工坊 ({workflows.length})
            </button>
            <button
              type="button"
              className="wf-seg-btn"
              data-active={String(pluginsState.viewTab === 'plugins')}
              onClick={() => setWorkflowViewTab('plugins')}
            >
              🧩 插件中心 ({enabledPluginCount}/{plugins.length})
            </button>
          </div>
        </div>

        <div className="wf-actions">
          {pluginsState.viewTab !== 'plugins' ? (
            <>
              <button type="button" className="wf-chip" data-active={String(showSynthBox)} onClick={() => setShowSynthBox((v) => !v)}>
                ✨ 一句话生成流
              </button>
              <button type="button" className="wf-chip" onClick={() => createNewWorkflow()}>+ 空白流</button>
              <button type="button" className="wf-chip" onClick={() => convertGroupToWorkflow()}>👥 群聊转 DAG</button>
              {activeWf && (
                <button
                  type="button"
                  className="wf-chip"
                  data-active={String(showAddNode)}
                  onClick={() => {
                    setNewNodeFrom(effectiveSelectedId)
                    setShowAddNode((v) => !v)
                  }}
                >
                  + 加节点
                </button>
              )}
              {activeWf && (
                <button type="button" className="wf-chip" onClick={() => cloneCurrentWorkflow(activeWf.id)}>克隆</button>
              )}
              <button type="button" className="wf-chip" data-active={String(showImportWf)} onClick={() => setShowImportWf((v) => !v)}>
                导入 JSON
              </button>
              {activeWf && (
                <button
                  type="button"
                  className="wf-chip"
                  onClick={() => {
                    downloadTextFile(`${activeWf.id}.json`, JSON.stringify(activeWf, null, 2), 'application/json;charset=utf-8')
                    pushToast(`已导出工作流 JSON：${activeWf.id}.json`, 'ok')
                  }}
                >
                  ⬇ JSON
                </button>
              )}
              {run.lastArtifact && (
                <button type="button" className="wf-chip" data-active="true" onClick={() => openArtifactCanvas(run.lastArtifact)}>
                  ✦ 打开画布
                </button>
              )}
              {run.status === 'done' && (
                <button type="button" className="wf-chip" onClick={() => exportWorkflowRunReport()}>
                  ⬇ 运行报告
                </button>
              )}
              <button type="button" className="wf-chip" onClick={() => triggerWorkflowShowcase()}>
                ▶ 演练并发 DAG 动效
              </button>
            </>
          ) : (
            <button
              type="button"
              className="wf-chip"
              data-active={String(showInstallBox)}
              onClick={() => setShowInstallBox((v) => !v)}
            >
              {showInstallBox ? '收起安装器' : '+ 热插拔安装 JSON 插件'}
            </button>
          )}
        </div>
      </header>

      {pluginsState.viewTab === 'plugins' ? (
        <div className="wf-studio-body">
          {showInstallBox && (
            <div className="wf-install-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 13.5 }}>🧩 热插拔安装自定义 JSON 插件（支持声明工作流 / 工具 / 指令 / Hook，零脚本注入）</strong>
                <button type="button" className="wf-chip" onClick={() => setPluginJsonDraft(SAMPLE_CUSTOM_PLUGIN_JSON)}>
                  重置示例模板
                </button>
              </div>
              <textarea
                className="wf-textarea"
                style={{ minHeight: 170 }}
                value={pluginJsonDraft}
                onChange={(e) => setPluginJsonDraft(e.target.value)}
                aria-label="自定义插件 JSON Manifest"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="wf-chip" onClick={() => setShowInstallBox(false)}>取消</button>
                <button type="button" className="wf-btn" onClick={() => { if (installPluginJson(pluginJsonDraft)?.ok) setShowInstallBox(false) }}>
                  校验并热安装插件 →
                </button>
              </div>
            </div>
          )}

          <div className="wf-plugins-grid">
            {plugins.map((p) => {
              const wfCnt = (p.contributes && p.contributes.workflows && p.contributes.workflows.length) || 0
              const toolCnt = (p.contributes && p.contributes.tools && p.contributes.tools.length) || 0
              const hookCnt = (p.contributes && p.contributes.hooks && p.contributes.hooks.length) || 0
              const cmdCnt = (p.contributes && p.contributes.slashCommands && p.contributes.slashCommands.length) || 0
              return (
                <article key={p.id} className="wf-plugin-card" data-plugin-id={p.id} data-enabled={String(!!p.enabled)}>
                  <div className="wf-plugin-top">
                    <div>
                      <div className="wf-plugin-name">{p.name}</div>
                      <div className="wf-plugin-id">{p.id} · v{p.version}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="wf-chip"
                        data-active={String(!!p.enabled)}
                        disabled={!!p.locked}
                        onClick={() => togglePlugin(p.id, !p.enabled)}
                      >
                        {p.locked ? '核心常驻' : (p.enabled ? '✓ 已启用' : '已停用')}
                      </button>
                      {!p.builtin && (
                        <button type="button" className="wf-chip" onClick={() => uninstallPlugin(p.id)}>卸载</button>
                      )}
                    </div>
                  </div>
                  <p className="wf-plugin-desc">{p.description}</p>
                  <div className="wf-plugin-tags">
                    <span className="wf-badge">{p.builtin ? '内置插件' : '热插拔自定义'}</span>
                    {wfCnt > 0 && <span className="wf-badge">⚡ {wfCnt} 工作流</span>}
                    {toolCnt > 0 && <span className="wf-badge">🔧 {toolCnt} 工具</span>}
                    {cmdCnt > 0 && <span className="wf-badge">/ {cmdCnt} 指令</span>}
                    {hookCnt > 0 && <span className="wf-badge">🪝 {hookCnt} Hook</span>}
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="wf-studio-body">
            {showSynthBox && (
              <div className="wf-synth-bar">
                <input
                  className="wf-input"
                  style={{ flex: 1, minWidth: 220 }}
                  value={synthPrompt}
                  onChange={(e) => setSynthPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSynthesize() }}
                  placeholder="用一句话描述你要的流程（如：调研竞品定价并做红蓝反证，最后生成 HTML 简报）…"
                />
                <button type="button" className="wf-btn" onClick={handleSynthesize}>生成并载入 DAG →</button>
              </div>
            )}

            {showImportWf && (
              <div className="wf-install-box">
                <strong style={{ fontSize: 13 }}>导入工作流 JSON</strong>
                <textarea
                  className="wf-textarea"
                  value={importWfDraft}
                  onChange={(e) => setImportWfDraft(e.target.value)}
                  placeholder='粘贴导出的工作流 JSON（含 nodes / edges）…'
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="wf-chip" onClick={() => setShowImportWf(false)}>取消</button>
                  <button type="button" className="wf-btn" onClick={() => { if (importWorkflowFromJson(importWfDraft)?.ok) { setImportWfDraft(''); setShowImportWf(false) } }}>
                    导入工作流
                  </button>
                </div>
              </div>
            )}

            {activeWf && (
              <div className="wf-meta-bar">
                {showEditMeta ? (
                  <div style={{ display: 'flex', gap: 8, flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input className="wf-input" style={{ width: 220 }} value={metaName} onChange={(e) => setMetaName(e.target.value)} placeholder="工作流名称" />
                    <input className="wf-input" style={{ flex: 1, minWidth: 180 }} value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} placeholder="简短描述" />
                    <button type="button" className="wf-chip" data-active="true" onClick={handleSaveMeta}>保存名称</button>
                    <button type="button" className="wf-chip" onClick={() => setShowEditMeta(false)}>取消</button>
                  </div>
                ) : (
                  <div className="wf-meta-desc">
                    <strong>{activeWf.name}</strong>
                    {activeWf.description ? ` — ${activeWf.description}` : ''}
                  </div>
                )}
                <div className="wf-meta-badges">
                  <span className="wf-badge">{activeWf.nodes.length} 节点 · {activeWf.edges.length} 边 · {dag.layers.length} 层</span>
                  <div style={{ display: 'inline-flex', gap: 3 }}>
                    {[0.75, 1, 1.2].map((z) => (
                      <button key={z} type="button" className="wf-chip" style={{ padding: '2px 7px', fontSize: 11 }} data-active={String(zoom === z)} onClick={() => setZoom(z)}>
                        {Math.round(z * 100)}%
                      </button>
                    ))}
                  </div>
                  {!showEditMeta && (
                    <button
                      type="button"
                      className="wf-chip"
                      onClick={() => { setMetaName(activeWf.name); setMetaDesc(activeWf.description || ''); setShowEditMeta(true) }}
                    >
                      改名
                    </button>
                  )}
                  {!activeWf.builtin && (
                    <button type="button" className="wf-chip" onClick={() => deleteWorkflowDef(activeWf.id)}>删工作流</button>
                  )}
                </div>
              </div>
            )}

            {showAddNode && activeWf && (
              <div className="wf-meta-bar" style={{ borderColor: 'var(--primary)' }}>
                <input
                  className="wf-input"
                  style={{ width: 170 }}
                  value={newNodeLabel}
                  onChange={(e) => setNewNodeLabel(e.target.value)}
                  placeholder="新节点名称（如：代码审查）"
                />
                <select className="wf-select" style={{ width: 140 }} value={newNodeKind} onChange={(e) => setNewNodeKind(e.target.value)}>
                  {WORKFLOW_NODE_KINDS.filter((k) => k.id !== 'input').map((k) => (
                    <option key={k.id} value={k.id}>{k.badge} · {k.label}</option>
                  ))}
                </select>
                <select className="wf-select" style={{ width: 170 }} value={newNodeFrom} onChange={(e) => setNewNodeFrom(e.target.value)}>
                  {activeWf.nodes.map((n) => (
                    <option key={n.id} value={n.id}>接在「{n.label}」之后</option>
                  ))}
                </select>
                <button type="button" className="wf-btn" onClick={handleAddNode}>添加并连线</button>
              </div>
            )}

            {!dag.ok ? (
              <div className="wf-meta-bar" style={{ borderColor: 'var(--err)', color: 'var(--err)' }}>
                {dag.error}
              </div>
            ) : (
              <div className="wf-split">
                <WorkflowGraph
                  nodes={activeWf ? activeWf.nodes : []}
                  edges={activeWf ? activeWf.edges : []}
                  layout={dag.layout}
                  zoom={zoom}
                  nodeStates={run.workflowId === (activeWf && activeWf.id) ? run.nodeStates : {}}
                  activeEdges={run.workflowId === (activeWf && activeWf.id) ? run.activeEdges : []}
                  selectedNodeId={effectiveSelectedId}
                  onSelectNode={(nid) => { setSelectedNodeId(nid); setEditingNode(null); setEdgeTargetId('') }}
                />

                <aside className="wf-inspector" aria-label="节点属性、连线编排与实时输出检视器">
                  {selectedNode ? (
                    <>
                      <div className="wf-insp-head">
                        <div>
                          <strong style={{ fontSize: 13 }}>{selectedNode.label}</strong>
                          <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                            {selectedNode.id} · {selectedNode.kind}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {editingNode ? (
                            <>
                              <button type="button" className="wf-chip" data-active="true" onClick={handleSaveEditedNode}>保存</button>
                              <button type="button" className="wf-chip" onClick={() => setEditingNode(null)}>取消</button>
                            </>
                          ) : (
                            <button type="button" className="wf-chip" onClick={() => beginEditNode(selectedNode)}>编辑</button>
                          )}
                          <button type="button" className="wf-chip" onClick={handleDeleteSelectedNode}>删</button>
                        </div>
                      </div>

                      {editingNode ? (
                        <>
                          <label className="wf-field">
                            节点名称
                            <input className="wf-input" value={editingNode.label} onChange={(e) => setEditingNode({ ...editingNode, label: e.target.value })} />
                          </label>
                          {editingNode.kind === 'llm' && (
                            <>
                              <label className="wf-field">
                                独立模型名（留空继承全局）
                                <input className="wf-input" value={editingNode.model || ''} onChange={(e) => setEditingNode({ ...editingNode, model: e.target.value })} placeholder="例如：deepseek-v4.1 / glm-4.5" />
                              </label>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, alignItems: 'end' }}>
                                <label className="wf-field">
                                  思考档位
                                  <select className="wf-select" value={editingNode.reasoningTier || 'auto'} onChange={(e) => setEditingNode({ ...editingNode, reasoningTier: e.target.value })}>
                                    {REASONING_TIERS.filter((t) => t.id !== 'custom').map((t) => (
                                      <option key={t.id} value={t.id}>{t.label}</option>
                                    ))}
                                  </select>
                                </label>
                                <button
                                  type="button"
                                  className="wf-chip"
                                  data-active={String(!!editingNode.allowTools)}
                                  onClick={() => setEditingNode({ ...editingNode, allowTools: !editingNode.allowTools })}
                                >
                                  {editingNode.allowTools ? '🔧 允许调工具' : '仅文本推理'}
                                </button>
                              </div>
                              <label className="wf-field">
                                提示词模板（支持 {'{{input}}'} / {'{{upstream}}'} / {'{{nodes.id.output}}'}）
                                <textarea className="wf-textarea" value={editingNode.prompt || ''} onChange={(e) => setEditingNode({ ...editingNode, prompt: e.target.value })} />
                              </label>
                            </>
                          )}
                          {editingNode.kind === 'tool' && (
                            <>
                              <label className="wf-field">
                                直调工具名
                                <select className="wf-select" value={editingNode.toolName || 'list_dir'} onChange={(e) => setEditingNode({ ...editingNode, toolName: e.target.value })}>
                                  {TOOL_PRESET_NAMES.map((tn) => <option key={tn} value={tn}>{tn}</option>)}
                                </select>
                              </label>
                              <label className="wf-field">
                                工具参数 JSON（支持模板插值）
                                <textarea className="wf-textarea" value={toolArgsDraft} onChange={(e) => setToolArgsDraft(e.target.value)} />
                              </label>
                            </>
                          )}
                          {editingNode.kind === 'condition' && (
                            <>
                              <label className="wf-field">
                                判断操作符
                                <select
                                  className="wf-select"
                                  value={(editingNode.condition && editingNode.condition.op) || 'contains'}
                                  onChange={(e) => setEditingNode({ ...editingNode, condition: { ...(editingNode.condition || {}), op: e.target.value } })}
                                >
                                  <option value="contains">包含关键词 (contains)</option>
                                  <option value="not_contains">不包含关键词 (not_contains)</option>
                                  <option value="min_length">最小字数 (min_length)</option>
                                  <option value="regex">正则匹配 (regex)</option>
                                  <option value="always">恒真 (always)</option>
                                </select>
                              </label>
                              <label className="wf-field">
                                匹配值 / 阈值
                                <input
                                  className="wf-input"
                                  value={(editingNode.condition && editingNode.condition.value) || ''}
                                  onChange={(e) => setEditingNode({ ...editingNode, condition: { ...(editingNode.condition || {}), value: e.target.value } })}
                                  placeholder="例如：HIGH_RISK 或 200"
                                />
                              </label>
                            </>
                          )}
                          {editingNode.kind === 'human_gate' && (
                            <>
                              <label className="wf-field">
                                拍板弹窗标题
                                <input
                                  className="wf-input"
                                  value={(editingNode.gateConfig && editingNode.gateConfig.title) || ''}
                                  onChange={(e) => setEditingNode({ ...editingNode, gateConfig: { ...(editingNode.gateConfig || {}), title: e.target.value } })}
                                />
                              </label>
                              <label className="wf-field">
                                选项列表（用逗号分隔）
                                <input className="wf-input" value={gateOptionsDraft} onChange={(e) => setGateOptionsDraft(e.target.value)} />
                              </label>
                            </>
                          )}
                          {(editingNode.kind === 'merge' || editingNode.kind === 'artifact') && (
                            <label className="wf-field">
                              聚合 / 输出模板
                              <textarea className="wf-textarea" value={editingNode.prompt || ''} onChange={(e) => setEditingNode({ ...editingNode, prompt: e.target.value })} placeholder="留空默认消费 {{upstream}}" />
                            </label>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="wf-field">
                            <span>连线拓扑（入边 {inEdges.length} · 出边 {outEdges.length}）</span>
                            <div className="wf-edge-list">
                              {outEdges.map((e) => {
                                const targetNode = activeWf.nodes.find((x) => x.id === e.to)
                                return (
                                  <div key={e.id} className="wf-edge-row">
                                    <span>⟶ {targetNode ? targetNode.label : e.to}{e.when !== 'always' ? ` [${e.when.toUpperCase()}]` : ''}</span>
                                    <button type="button" className="wf-chip" style={{ padding: '1px 6px' }} onClick={() => handleRemoveEdge(e.id)}>×</button>
                                  </div>
                                )
                              })}
                              {connectableTargets.length > 0 && (
                                <div className="wf-edge-add">
                                  <select
                                    className="wf-select"
                                    style={{ flex: 1 }}
                                    value={edgeTargetId || connectableTargets[0].id}
                                    onChange={(e) => setEdgeTargetId(e.target.value)}
                                    aria-label="选择连线下游节点"
                                  >
                                    {connectableTargets.map((n) => (
                                      <option key={n.id} value={n.id}>连到「{n.label}」</option>
                                    ))}
                                  </select>
                                  {selectedNode.kind === 'condition' && (
                                    <select className="wf-select" style={{ width: 76 }} value={edgeWhen} onChange={(e) => setEdgeWhen(e.target.value)}>
                                      <option value="true">TRUE</option>
                                      <option value="false">FALSE</option>
                                      <option value="always">总是</option>
                                    </select>
                                  )}
                                  <button type="button" className="wf-chip" data-active="true" onClick={handleAddEdge}>+ 连线</button>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="wf-field">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span>实时运行输出</span>
                              {selectedState && selectedState.output && (
                                <button
                                  type="button"
                                  className="wf-chip"
                                  onClick={async () => { await copyText(selectedState.output); pushToast('已复制节点产出', 'ok') }}
                                >
                                  复制
                                </button>
                              )}
                            </div>
                            <pre className="wf-output-pre">
                              {(selectedState && selectedState.output) || '尚未运行或等待上游节点完成…'}
                            </pre>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>点击左侧画布任意节点查看、连线或编辑配置。</div>
                  )}
                </aside>
              </div>
            )}

            {Array.isArray(run.logs) && run.logs.length > 0 && (
              <div className="wf-logs" aria-live="polite">
                {run.logs.map((l) => <div key={l.id}>{l.text}</div>)}
              </div>
            )}
          </div>

          <div className="wf-runbar">
            <input
              className="wf-run-input"
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRun() }}
              placeholder={activeWf ? `输入任务目标并驱动「${activeWf.name}」执行…` : '请先启用或新建一个工作流…'}
            />
            {canResume && !isRunning && (
              <button type="button" className="wf-chip" data-active="true" onClick={() => runActiveWorkflow({ workflowId: activeWf.id, input: goalInput, resume: true })}>
                ▶ 断点续跑
              </button>
            )}
            {run.status !== 'idle' && !isRunning && (
              <button type="button" className="wf-chip" onClick={() => resetWorkflowRun()}>重置状态</button>
            )}
            {isRunning ? (
              <button type="button" className="wf-btn wf-btn-err" onClick={() => stopWorkflowRun()}>■ 中止执行</button>
            ) : (
              <button type="button" className="wf-btn" onClick={handleRun}>▶ 运行 DAG 工作流</button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
