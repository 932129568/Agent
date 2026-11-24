import { useEffect, useState } from 'react'
import './ClarifyModal.css'

/**
 * 效果与需求拍板交互弹窗（R20：支持 Escape 快捷放行 + 145ms 平滑退场动画）。
 */
export default function ClarifyModal({ request, onResolve }) {
  const questions = (request && Array.isArray(request.questions)) ? request.questions : []
  const [selected, setSelected] = useState({})
  const [customNote, setCustomNote] = useState('')
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (!request) return
    const init = {}
    for (const q of (request.questions || [])) {
      const opts = Array.isArray(q.options) ? q.options : []
      if (opts.length > 0 && !q.multi) init[q.id] = [opts[0].id]
      else init[q.id] = []
    }
    setSelected(init)
    setCustomNote('')
    setClosing(false)
  }, [request && request.id])

  const finishWithAnim = (payload) => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      onResolve(payload)
    }, 145)
  }

  useEffect(() => {
    if (!request) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finishWithAnim({ mode: 'autonomous', answers: {}, customNote: '', summary: '用户已授权 AI 自主发挥（本轮按最佳审美与工程方案直接落地）' })
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [request && request.id, closing])

  if (!request) return null

  const toggleOption = (q, optId) => {
    setSelected((prev) => {
      const cur = Array.isArray(prev[q.id]) ? prev[q.id] : []
      if (q.multi) {
        return { ...prev, [q.id]: cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId] }
      }
      return { ...prev, [q.id]: [optId] }
    })
  }

  const handleConfirm = () => {
    const answers = {}
    const summaryLines = []
    for (const q of questions) {
      const chosenIds = Array.isArray(selected[q.id]) ? selected[q.id] : []
      const chosenOpts = (q.options || []).filter((o) => chosenIds.includes(o.id))
      const labels = chosenOpts.map((o) => o.label)
      answers[q.id] = { ids: chosenIds, labels }
      if (labels.length) summaryLines.push(`- ${q.label}：${labels.join('、')}`)
    }
    const custom = customNote.trim()
    if (custom) summaryLines.push(`- 自定义补充要求：${custom}`)
    finishWithAnim({
      mode: 'selected',
      answers,
      customNote: custom,
      summary: summaryLines.join('\n') || '采用默认推荐方案',
    })
  }

  return (
    <div className="cl-backdrop" data-closing={String(closing)} role="presentation">
      <div className="cl-modal" role="dialog" aria-modal="true" aria-label={request.title || '方案与效果确认'}>
        <header className="cl-head">
          <span className="cl-kicker">🎯 效果与方向确认 · 落地前拍板</span>
          <h3 className="cl-title">{request.title || '请选择你期望的效果方向'}</h3>
          {request.subtitle && <p className="cl-sub">{request.subtitle}</p>}
        </header>

        <div className="cl-body">
          {questions.map((q) => {
            const cur = Array.isArray(selected[q.id]) ? selected[q.id] : []
            return (
              <div key={q.id} className="cl-q">
                <div className="cl-q-label">
                  <span>{q.label}</span>
                  <span className="cl-q-hint">{q.multi ? '（可多选）' : '（单选）'}</span>
                </div>
                <div className="cl-opts">
                  {(q.options || []).map((opt) => {
                    const active = cur.includes(opt.id)
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className="cl-opt"
                        data-selected={String(active)}
                        onClick={() => toggleOption(q, opt.id)}
                      >
                        <div className="cl-opt-top">
                          <span className="cl-opt-title">{active ? '● ' : '○ '}{opt.label}</span>
                          {opt.tag && <span className="cl-opt-tag">{opt.tag}</span>}
                        </div>
                        {opt.desc && <span className="cl-opt-desc">{opt.desc}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {request.allow_custom !== false && (
            <div className="cl-custom-wrap">
              <label className="cl-q-label" htmlFor="cl-custom-input">自定义补充 / 专属要求（可选）</label>
              <input
                id="cl-custom-input"
                className="cl-custom-input"
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm() }}
                placeholder="例如：主色调改用暖金色、加入音效开关、适配手机竖屏…"
              />
            </div>
          )}
        </div>

        <footer className="cl-foot">
          <button
            type="button"
            className="cl-btn"
            onClick={() => finishWithAnim({ mode: 'autonomous', answers: {}, customNote: '', summary: '用户已授权 AI 自主发挥（本轮按最佳审美与工程方案直接落地）' })}
          >
            ⚡ 交给 AI 自主发挥
          </button>
          <button type="button" className="cl-btn cl-btn-primary" onClick={handleConfirm}>
            确认方案并继续执行 →
          </button>
        </footer>
      </div>
    </div>
  )
}
