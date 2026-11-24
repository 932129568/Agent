import { useMemo } from 'react'
import './DiffView.css'

export function computeLcsHunks(beforeText, afterText, contextLines = 3) {
  const a = String(beforeText || '').split(/\r?\n/)
  const b = String(afterText || '').split(/\r?\n/)
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const ma = a.slice(p, a.length - s)
  const mb = b.slice(p, b.length - s)
  const ops = []
  for (let i = 0; i < p; i++) ops.push({ t: 'eq', text: a[i] })

  if (ma.length * mb.length <= 200000) {
    const n = ma.length
    const m = mb.length
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { ops.push({ t: 'eq', text: ma[i] }); i++; j++ }
      else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: 'del', text: ma[i] }); i++ }
      else { ops.push({ t: 'add', text: mb[j] }); j++ }
    }
  } else {
    ma.forEach((ln) => ops.push({ t: 'del', text: ln }))
    mb.forEach((ln) => ops.push({ t: 'add', text: ln }))
  }
  for (let k = 0; k < s; k++) ops.push({ t: 'eq', text: a[a.length - s + k] })

  const keep = new Uint8Array(ops.length)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t !== 'eq') {
      for (let k = Math.max(0, i - contextLines); k <= Math.min(ops.length - 1, i + contextLines); k++) keep[k] = 1
    }
  }
  const out = []
  let skipped = 0
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      if (skipped) { out.push({ t: 'fold', count: skipped }); skipped = 0 }
      out.push(ops[i])
    } else {
      skipped++
    }
  }
  if (skipped) out.push({ t: 'fold', count: skipped })
  return out
}

export default function DiffView({ filePath, before, after }) {
  const { hunks, adds, dels } = useMemo(() => {
    const rows = computeLcsHunks(before, after, 3)
    let a = 0
    let d = 0
    for (const r of rows) {
      if (r.t === 'add') a++
      else if (r.t === 'del') d++
    }
    return { hunks: rows, adds: a, dels: d }
  }, [before, after])

  return (
    <div className="hb-diff">
      <div className="hb-diff-head">
        <span>{filePath || '未命名文件'}</span>
        <span className="hb-diff-stat">
          <span className="hb-diff-stat-add">+{adds}</span>
          <span className="hb-diff-stat-del">-{dels}</span>
        </span>
      </div>
      <div className="hb-diff-body">
        {hunks.map((h, idx) => (
          <div key={idx} className={`hb-diff-ln ${h.t}`}>
            {h.t === 'fold'
              ? `⋯ 已折叠 ${h.count} 行未改动代码 ⋯`
              : `${h.t === 'add' ? '+ ' : h.t === 'del' ? '- ' : '  '}${h.text}`}
          </div>
        ))}
      </div>
    </div>
  )
}
