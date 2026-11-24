import { useEffect, useState } from 'react'
import { useSlice, runGroupRelay, refreshGroupFiles, setDockPreview } from '../../state/store.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import './GroupPanel.css'

export default function GroupPanel() {
  const group = useSlice('group')
  const [topic, setTopic] = useState('')

  useEffect(() => { refreshGroupFiles().catch(() => {}) }, [])

  const handleSend = () => {
    if (!topic.trim() || group.running) return
    const q = topic.trim()
    setTopic('')
    runGroupRelay(q)
  }

  return (
    <section className="gp-root">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>多角色群聊接力</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)' }}>
            按名册顺序接力推演，结束后自动生成交接文档并支持一键送入右侧副屏预览
          </p>
        </div>
        <div className="gp-roster">
          {group.members.map((m) => <span key={m.id} className="gp-member">✦ {m.name}</span>)}
        </div>
      </div>

      <div className="gp-feed">
        {group.messages.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>输入一个架构或产品议题，启动 3 位成员顺序接力讨论。</div>
        ) : (
          group.messages.map((m) => (
            <article key={m.id} className="gp-msg">
              <div className="gp-author">
                <span>{m.author}</span>
                {m.role === 'assistant' && (
                  <button type="button" style={{ border: 0, background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: 11.5 }}
                    onClick={() => setDockPreview(`### ${m.author}\n\n${m.content}`)}>
                    副屏预览 →
                  </button>
                )}
              </div>
              <MarkdownView content={m.content} />
            </article>
          ))
        )}
      </div>

      <div className="gp-bar">
        <input className="gp-input" value={topic} onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          placeholder="输入群聊议题，如：评估缓存失效方案的边界条件…" />
        <button type="button" className="gp-btn" disabled={group.running} onClick={handleSend}>
          {group.running ? '接力中…' : '发起接力'}
        </button>
      </div>
    </section>
  )
}
