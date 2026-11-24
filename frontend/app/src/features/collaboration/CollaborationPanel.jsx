import { useState } from 'react'
import {
  useSlice,
  updateCollaborationConfig,
  startCollaborationRun,
  stopCollaborationRun,
  setDockPreview,
} from '../../state/store.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import './CollaborationPanel.css'

export default function CollaborationPanel() {
  const collab = useSlice('collaboration')
  const [goal, setGoal] = useState('')
  const cfg = collab.config

  return (
    <section className="co-root">
      <div className="co-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>双模型协同（Cloud Planner + Local Worker + Reviewer）</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)' }}>
            云端出方案与评审（自动脱敏密钥），本地低成本高频执行；云端 Token 上限硬熔断
          </p>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
          云端 {collab.cloudTokens} tok · 本地 {collab.localTokens} tok
        </span>
      </div>

      <div className="co-card">
        <div className="co-row">
          <label style={{ fontSize: 12.5 }}>
            隐私上传范围：
            <select className="co-btn" style={{ marginLeft: 6 }} value={cfg.upload_scope}
              onChange={(e) => updateCollaborationConfig({ upload_scope: e.target.value })}>
              <option value="task_summary_only">仅传脱敏摘要 (task_summary_only)</option>
              <option value="selected_results_only">精选结果摘要 (selected_results_only)</option>
              <option value="local_only">纯本地离线不上传 (local_only)</option>
            </select>
          </label>
          <label style={{ fontSize: 12.5 }}>
            评审轮数：
            <select className="co-btn" style={{ marginLeft: 6 }} value={cfg.max_review_rounds}
              onChange={(e) => updateCollaborationConfig({ max_review_rounds: Number(e.target.value) })}>
              <option value={0}>0 轮（仅规划+执行）</option>
              <option value={1}>1 轮评审修订</option>
              <option value={2}>2 轮严格评审</option>
            </select>
          </label>
          <label style={{ fontSize: 12.5 }}>
            云端预算 (tok)：
            <input className="co-btn" style={{ width: 92, marginLeft: 6 }} type="number" min={6000} max={30000} step={2000}
              value={cfg.cloud_token_budget}
              onChange={(e) => updateCollaborationConfig({ cloud_token_budget: Number(e.target.value) })} />
          </label>
        </div>

        <div className="co-row">
          <input className="co-input" value={goal} onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && goal.trim() && !collab.running) startCollaborationRun(goal.trim()) }}
            placeholder="输入需要云端规划 + 本地执行 + 云端评审的复杂任务…" />
          {collab.running ? (
            <button type="button" className="co-btn co-btn-primary" onClick={() => stopCollaborationRun()}>■ 停止协同</button>
          ) : (
            <button type="button" className="co-btn co-btn-primary" onClick={() => goal.trim() && startCollaborationRun(goal.trim())}>▶ 启动协同</button>
          )}
          {collab.finalAnswer && (
            <button type="button" className="co-btn" onClick={() => setDockPreview(collab.finalAnswer)}>副屏预览终稿 →</button>
          )}
        </div>
      </div>

      {collab.events.length > 0 && (
        <div className="co-card">
          <strong>协同时间线（{collab.events.length} 步）</strong>
          {collab.events.map((ev) => (
            <div key={ev.id} className="co-ev" data-phase={ev.phase}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <strong>{ev.actor}</strong>
                <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{ev.phase}</span>
              </div>
              <MarkdownView content={ev.content} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
