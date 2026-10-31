/**
 * P0-3 多任务状态面板（React 岛扩展）：并发 run 列表（会话名/状态/停止按钮）。
 *
 * 数据源 = run-controller 的 getActiveRuns()（前端本地运行时态，不新增 js_api）。
 * 默认单活跃时面板不渲染（legacy 主区交互不变）；仅真实并行（≥2 在途 run
 * 或 ≥1 并行标记 run）时展示。2s 轮询（run 状态为前端本地态，无后端推送）。
 */
import { useEffect, useState } from 'react'

export default function ParallelRuns() {
  const [runs, setRuns] = useState([])

  useEffect(() => {
    const read = () => {
      if (typeof window.getActiveRuns === 'function') {
        try { setRuns(window.getActiveRuns()) } catch (e) { /* 读取失败保持现状 */ }
      }
    }
    read()
    const timer = setInterval(read, 2000)
    return () => clearInterval(timer)
  }, [])

  const visible = runs.length >= 2 || runs.some(run => run.parallel)
  if (!visible) return null

  return (
    <div className="i-parallel-runs" data-testid="parallel-runs-panel">
      <div className="i-parallel-title">并行任务（{runs.length}）</div>
      {runs.map(run => (
        <div className="i-parallel-item" key={run.sessionId}>
          <span className="i-parallel-name" title={run.sessionId}>
            {run.title || run.sessionId}
          </span>
          <span className={'i-status ' + (run.status || 'working')}>
            <i className="i-status-dot" aria-hidden="true" />
            {run.status === 'working' ? '进行中' : (run.status || '进行中')}
          </span>
          <button
            type="button"
            className="i-parallel-stop"
            onClick={() => {
              if (typeof window.harborStopRun === 'function') window.harborStopRun(run.sessionId)
            }}
          >停止</button>
        </div>
      ))}
    </div>
  )
}
