import { useState } from 'react'
import DiffView from './DiffView.jsx'
import './InlineApproval.css'

export default function InlineApproval({ request, onResolve }) {
  const [denyReason, setDenyReason] = useState('')
  const [trustSession, setTrustSession] = useState(false)
  if (!request) return null

  const args = request.args || {}
  const hasDiffPreview = request.tool === 'search_replace' && typeof args.old === 'string' && typeof args.new === 'string'

  return (
    <div className="ap-card" data-danger={String(!!request.danger)} role="alertdialog" aria-label="安全护栏内联审批">
      <div className="ap-head">
        <span className="ap-title">安全护栏审批：{request.tool}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {args.path || args.cmd || args.url || ''}
        </span>
      </div>
      <div className="ap-body">{request.reason}</div>
      {hasDiffPreview && <DiffView filePath={args.path} before={args.old} after={args.new} />}
      <input
        className="ap-reason"
        value={denyReason}
        onChange={(e) => setDenyReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onResolve({ ok: false, denyReason: denyReason.trim(), trustSession: false })
          }
        }}
        placeholder="若拒绝，可在此写一句原因或替代方案（回车直接拒绝并回灌给 AI）…"
      />
      <div className="ap-foot">
        <label className="ap-check">
          <input type="checkbox" checked={trustSession} onChange={(e) => setTrustSession(e.target.checked)} />
          <span>本会话信任同类 {request.tool} 操作</span>
        </label>
        <div className="ap-btns">
          <button type="button" className="ap-btn" onClick={() => onResolve({ ok: false, denyReason: denyReason.trim(), trustSession: false })}>
            拒绝
          </button>
          <button type="button" className="ap-btn ap-btn-ok" onClick={() => onResolve({ ok: true, denyReason: '', trustSession })}>
            允许执行
          </button>
        </div>
      </div>
    </div>
  )
}
