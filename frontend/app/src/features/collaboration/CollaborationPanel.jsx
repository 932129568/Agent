import { useState } from 'react'
import {
  useSlice,
  updateCollaborationConfig,
  startCollaborationRun,
  stopCollaborationRun,
  setDockPreview,
} from '../../state/store.js'
import MarkdownView from '../../ui/MarkdownView.jsx'
import ModelPicker from '../../ui/ModelPicker.jsx'
import GlassSelect from '../../ui/GlassSelect.jsx'
import './CollaborationPanel.css'

export default function CollaborationPanel() {
  const collab = useSlice('collaboration')
  const settings = useSlice('settings')
  const savedChatModels = (settings.savedModels || []).filter((m) => !m.kind || m.kind === 'chat')
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
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <span>隐私上传：</span>
            <GlassSelect ariaLabel="隐私上传范围" value={cfg.upload_scope} onChange={(v) => updateCollaborationConfig({ upload_scope: v })}
              options={[{ value: 'task_summary_only', label: '仅传脱敏摘要', hint: '推荐' }, { value: 'selected_results_only', label: '精选结果摘要' }, { value: 'local_only', label: '纯本地离线不上传' }]} />
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <span>评审轮数：</span>
            <GlassSelect ariaLabel="评审轮数" value={cfg.max_review_rounds} onChange={(v) => updateCollaborationConfig({ max_review_rounds: Number(v) })}
              options={[{ value: 0, label: '0 轮（仅规划+执行）' }, { value: 1, label: '1 轮评审修订' }, { value: 2, label: '2 轮严格评审' }]} />
          </div>
          {savedChatModels.length > 0 && (
            <>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <span>云端规划：</span>
                <ModelPicker
                  direction="down"
                  ariaLabel="选择云端规划模型"
                  value={cfg.cloud_model_id || ''}
                  defaultModel="默认云端端点"
                  models={savedChatModels}
                  onChange={(id) => updateCollaborationConfig({ cloud_model_id: id })}
                />
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <span>本地执行：</span>
                <ModelPicker
                  direction="down"
                  ariaLabel="选择本地执行模型"
                  value={cfg.local_model_id || ''}
                  defaultModel="默认本地端点"
                  models={savedChatModels}
                  onChange={(id) => updateCollaborationConfig({ local_model_id: id })}
                />
              </div>
            </>
          )}
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
