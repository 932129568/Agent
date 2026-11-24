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
  convertGroupToWorkflow,
  runActiveWorkflow,
  stopWorkflowRun,
  resetWorkflowRun,
  triggerWorkflowShowcase,
  pushToast,
} from '../../state/store.js'
import { analyzeWorkflowDag, WORKFLOW_NODE_KINDS } from '../../services/workflowEngine.js'
import { SAMPLE_CUSTOM_PLUGIN_JSON } from '../../services/pluginRegistry.js'
import { copyText, downloadTextFile } from '../../platform/dom.js'
import WorkflowGraph from '../../ui/WorkflowGraph.jsx'
import './WorkflowPanel.css'

export default function WorkflowPanel() {
  const pluginsState = useSlice('plugins')
  const workflows = Array.isArray(pluginsState.workflows) ? pluginsState.workflows : []
  const plugins = Array.isArray(pluginsState.plugins) ? pluginsState.plugins : []
  const activeWf = workflows.find((w) => w.id === pluginsState.activeWorkflowId) || workflows[0] || null
  const run = pluginsState.run || { status: 'idle', nodeStates: {}, activeEdges: [], logs: [] }

  const [goalInput, setGoalInput] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [editingNode, setEditingNode] = useState(null)
  const [showAddNode, setShowAddNode] = useState(false)
  const [newNodeLabel, setNewNodeLabel] = useState('')
  const [newNodeKind, setNewNodeKind] = useState('llm')
  const [newNodeFrom, setNewNodeFrom] = useState('')
  const [showInstallBox, setShowInstallBox] = useState(false)
  const [pluginJsonDraft, setPluginJsonDraft] = useState(SAMPLE_CUSTOM_PLUGIN_JSON)

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

  const handleRun = () => {
    if (!activeWf || isRunning) return
    const text = goalInput.trim() || '请按本工作流标准执行示范任务并输出完整交付'
    runActiveWorkflow({ workflowId: activeWf.id, input: text, resume: false })
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

  const handleSaveEditedNode = () => {
    if (!activeWf || !editingNode) return
    const nextNodes = activeWf.nodes.map((n) => (n.id === editingNode.id ? { ...n, ...editingNode } : n))
    const saved = saveWorkflowDef({ ...activeWf, nodes: nextNodes })
    if (saved && saved.ok) setEditingNode(null)
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

  const handleInstallPlugin = () => {
    const res = installPluginJson(pluginJsonDraft)
    if (res && res.ok) {
      setShowInstallBox(false)
    }
  }

  const enabledPluginCount = plugins.filter((p) => p.enabled).length

  return (
    <section className="wf-root">
      <header className="wf-head">
        <div className="wf-head-left">
          <h2 className="wf-title">⚡ 插件化 DAG 工作流引擎</h2>
          <div className="wf-seg" role="tablist" aria-label="工作流视图切换">
            <button
              type="button"
              className="wf-seg-btn"
              data-active={String(pluginsState.viewTab !== 'plugins')}
              onClick={() => setWorkflowViewTab('studio')}
            >
              可视化编排工坊 ({workflows.length})
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
              <button type="button" className="wf-chip" onClick={() => createNewWorkflow()}>+ 新建空白流</button>
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
                <button
                  type="button"
                  className="wf-chip"
                  onClick={() => {
                    downloadTextFile(`${activeWf.id}.json`, JSON.stringify(activeWf, null, 2), 'application/json;charset=utf-8')
                    pushToast(`已导出工作流 JSON：${activeWf.id}.json`, 'ok')
                  }}
                >
                  ⬇ 导出 JSON
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
                <button type="button" className="wf-btn" onClick={handleInstallPlugin}>校验并热安装插件 →</button>
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
            {activeWf && (
              <div className="wf-meta-bar">
                <div className="wf-meta-desc">
                  <strong>{activeWf.name}</strong>
                  {activeWf.description ? ` — ${activeWf.description}` : ''}
                </div>
                <div className="wf-meta-badges">
                  <span className="wf-badge">{activeWf.nodes.length} 节点</span>
                  <span className="wf-badge">{dag.layers.length} 拓扑层</span>
                  <span className="wf-badge">{activeWf.builtin ? '插件提供' : '可编辑自定义'}</span>
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
                  nodeStates={run.workflowId === (activeWf && activeWf.id) ? run.nodeStates : {}}
                  activeEdges={run.workflowId === (activeWf && activeWf.id) ? run.activeEdges : []}
                  selectedNodeId={effectiveSelectedId}
                  onSelectNode={(nid) => { setSelectedNodeId(nid); setEditingNode(null) }}
                />

                <aside className="wf-inspector" aria-label="节点属性与实时输出检视器">
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
                            <button type="button" className="wf-chip" data-active="true" onClick={handleSaveEditedNode}>保存</button>
                          ) : (
                            <button type="button" className="wf-chip" onClick={() => setEditingNode({ ...selectedNode })}>编辑</button>
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
                                独立模型名（留空继承）
                                <input className="wf-input" value={editingNode.model || ''} onChange={(e) => setEditingNode({ ...editingNode, model: e.target.value })} placeholder="例如：deepseek-v4.1 / glm-4.5" />
                              </label>
                              <label className="wf-field">
                                提示词模板（支持 {'{{input}}'} / {'{{upstream}}'}）
                                <textarea className="wf-textarea" value={editingNode.prompt || ''} onChange={(e) => setEditingNode({ ...editingNode, prompt: e.target.value })} />
                              </label>
                            </>
                          )}
                          {editingNode.kind === 'tool' && (
                            <label className="wf-field">
                              工具名（如 list_dir / read_file / run_command）
                              <input className="wf-input" value={editingNode.toolName || ''} onChange={(e) => setEditingNode({ ...editingNode, toolName: e.target.value })} />
                            </label>
                          )}
                        </>
                      ) : (
                        <>
                          {selectedNode.prompt && (
                            <div className="wf-field">
                              <span>节点指令模板</span>
                              <pre className="wf-output-pre">{selectedNode.prompt}</pre>
                            </div>
                          )}
                          {selectedNode.kind === 'tool' && (
                            <div className="wf-field">
                              <span>直调工具配置</span>
                              <pre className="wf-output-pre">{selectedNode.toolName}({JSON.stringify(selectedNode.toolArgs || {})})</pre>
                            </div>
                          )}
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
                    <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>点击左侧画布任意节点查看或编辑配置。</div>
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
