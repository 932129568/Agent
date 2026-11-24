import { useEffect, useState } from 'react'
import {
  useSlice,
  refreshWorkspace,
  setWorkspacePath,
  toggleWorkspaceEnabled,
  previewWorkspaceFile,
  pushToast,
} from '../../state/store.js'
import * as api from '../../services/bridge.js'
import './WorkspacePanel.css'

export default function WorkspacePanel() {
  const ws = useSlice('workspace')
  const [pathInput, setPathInput] = useState(ws.rootPath || '')
  const [ruleOp, setRuleOp] = useState('write_file')
  const [rulePat, setRulePat] = useState('')

  useEffect(() => { refreshWorkspace().catch(() => {}) }, [])
  useEffect(() => { if (ws.rootPath) setPathInput(ws.rootPath) }, [ws.rootPath])

  const handlePickFolder = async () => {
    try {
      const res = await api.pickFolder('')
      if (res && res.path) await setWorkspacePath(res.path)
    } catch (e) {
      pushToast(`选择目录失败：${e.message}`, 'err')
    }
  }

  const handleAddRule = async () => {
    if (!rulePat.trim()) return
    try {
      await api.guardRuleAdd(ruleOp, rulePat.trim(), 'React 控制台添加')
      setRulePat('')
      await refreshWorkspace()
      pushToast('护栏规则已添加', 'ok')
    } catch (e) {
      pushToast(e.message, 'err')
    }
  }

  return (
    <section className="ws-root">
      <div className="ws-card">
        <div className="ws-row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>工作区与文件空间</h2>
          <label className="ws-row" style={{ fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={ws.enabled} onChange={(e) => toggleWorkspaceEnabled(e.target.checked)} />
            <span>启用工作区工具权限</span>
          </label>
        </div>
        <div className="ws-row">
          <input className="ws-input" value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder="输入项目根目录路径…" />
          <button type="button" className="ws-btn ws-btn-primary" onClick={() => setWorkspacePath(pathInput)}>切换目录</button>
          <button type="button" className="ws-btn" onClick={handlePickFolder}>浏览文件夹</button>
          <button type="button" className="ws-btn" onClick={() => refreshWorkspace()}>↻ 刷新</button>
        </div>
      </div>

      <div className="ws-card">
        <div style={{ fontWeight: 600 }}>目录文件预览</div>
        <div className="ws-split">
          <div className="ws-list">
            {(ws.entries || []).length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>目录为空或工作区未启用。</div>
              : ws.entries.map((ent, idx) => {
                const name = typeof ent === 'string' ? ent : (ent.name || ent.path || '')
                const isDir = typeof ent === 'object' && (ent.type === 'dir' || ent.isDir)
                return (
                  <button key={idx} type="button" className="ws-entry" onClick={() => !isDir && previewWorkspaceFile(name)}>
                    {isDir ? '📁 ' : '📄 '}{name}
                  </button>
                )
              })}
          </div>
          <pre className="ws-pre">
            {ws.previewFile ? `// ${ws.previewFile.path}\n${ws.previewFile.content}` : '点击左侧文件即可预览内容（前 200 行）'}
          </pre>
        </div>
      </div>

      <div className="ws-card">
        <div style={{ fontWeight: 600 }}>护栏白名单规则（{(ws.guardRules || []).length}）</div>
        <div className="ws-row">
          <select className="ws-btn" value={ruleOp} onChange={(e) => setRuleOp(e.target.value)}>
            <option value="write_file">write_file</option>
            <option value="search_replace">search_replace</option>
            <option value="run_command">run_command</option>
            <option value="delete_path">delete_path</option>
          </select>
          <input className="ws-input" value={rulePat} onChange={(e) => setRulePat(e.target.value)} placeholder="路径或命令匹配模式…" />
          <button type="button" className="ws-btn ws-btn-primary" onClick={handleAddRule}>添加规则</button>
        </div>
        {(ws.guardRules || []).map((r) => (
          <div key={r.id} className="ws-row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
            <span>[{r.op_pattern || r.op}] {r.detail_pattern || r.pattern}</span>
            <button type="button" className="ws-btn" onClick={async () => { await api.guardRuleRemove(r.id); await refreshWorkspace() }}>移除</button>
          </div>
        ))}
      </div>
    </section>
  )
}
