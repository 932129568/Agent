import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  useSlice,
  toggleSearchDock,
  setWebSearchMode,
  clearWebActivities,
  refreshBrowserSessions,
  closeBrowserSession,
  openSourceInForeground,
  appendComposerDraft,
  fireShellImpact,
  pushToast,
} from '../../state/store.js'
import { playDrawerSlideIn, playDrawerSlideOut } from '../../platform/kinetic.js'
import './SearchDock.css'

/**
 * R22 前沿 Agent 联网动态与来源观测台（取代旧版手动搜索框）：
 * - 用户无需手动输入搜索：模型需要实时信息时自主后台静默检索，本面板实时沉淀 Agent 检索轨迹、引用来源与前台浏览窗口；
 * - 随时可切「自动后台 / 前台可视 / 离线」，或把任意来源一键在「前台浏览器窗口」打开观看。
 */
export default function SearchDock() {
  const ui = useSlice('ui')
  const search = useSlice('search')
  const settings = useSlice('settings')
  const [mounted, setMounted] = useState(!!ui.searchDockOpen)
  const panelRef = useRef(null)
  const closingRef = useRef(false)

  useEffect(() => {
    if (ui.searchDockOpen) {
      closingRef.current = false
      setMounted(true)
      refreshBrowserSessions().catch(() => {})
    } else if (mounted && !closingRef.current) {
      closingRef.current = true
      playDrawerSlideOut(
        panelRef.current,
        settings.motion,
        () => fireShellImpact('right', 'medium'),
        () => {
          closingRef.current = false
          setMounted(false)
        },
        'nav-toolbox'
      )
    }
  }, [ui.searchDockOpen])

  useLayoutEffect(() => {
    if (mounted && ui.searchDockOpen && panelRef.current) {
      playDrawerSlideIn(panelRef.current, settings.motion)
    }
  }, [mounted, ui.searchDockOpen])

  if (!mounted) return null

  const activities = Array.isArray(search.activities) ? search.activities : []
  const activeSessions = Array.isArray(search.activeSessions) ? search.activeSessions : []
  const mode = ui.webSearchMode || 'auto'

  return (
    <aside ref={panelRef} className="sd-panel" aria-label="Agent 联网动态与来源观测台">
      <div className="sd-head">
        <span className="sd-title">🌐 Agent 联网动态 ({activities.length})</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {activities.length > 0 && (
            <button type="button" className="sd-btn" onClick={() => clearWebActivities()}>清空</button>
          )}
          <button type="button" className="sd-btn" onClick={() => toggleSearchDock(false)} aria-label="关闭联网观测台">×</button>
        </div>
      </div>

      <div className="sd-mode-bar" role="group" aria-label="Agent 联网方式">
        <button
          type="button"
          className="sd-mode-btn"
          data-active={String(mode === 'auto')}
          onClick={() => setWebSearchMode('auto')}
          title="默认推荐：模型按需在后台静默极速搜索，零打扰"
        >
          🌐 自动后台
        </button>
        <button
          type="button"
          className="sd-mode-btn"
          data-active={String(mode === 'visible')}
          onClick={() => setWebSearchMode('visible')}
          title="模型搜索或访问网页时弹出真实浏览器窗口供你实时观看"
        >
          👁 前台可视
        </button>
        <button
          type="button"
          className="sd-mode-btn"
          data-active={String(mode === 'off')}
          onClick={() => setWebSearchMode('off')}
          title="纯离线模式：不给模型下发任何联网工具"
        >
          ⊘ 离线
        </button>
      </div>

      <div className="sd-body">
        {activeSessions.length > 0 && (
          <div className="sd-sess-box">
            <div className="sd-sess-row">
              <strong>👁 活跃浏览器窗口 ({activeSessions.length})</strong>
              <button type="button" className="sd-btn" onClick={() => closeBrowserSession('')}>全部关闭</button>
            </div>
            {activeSessions.map((bs) => (
              <div key={bs.session_id} className="sd-sess-row">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={bs.url}>
                  {bs.mode === 'visible' ? '👁 ' : '🌐 '}{bs.title || bs.url}
                </span>
                <button type="button" className="sd-btn" onClick={() => closeBrowserSession(bs.session_id)}>关闭</button>
              </div>
            ))}
          </div>
        )}

        {activities.length === 0 ? (
          <div className="sd-empty">
            <strong>无需手动输入搜索 —— 模型自主按需联网</strong>
            <span>
              就像前沿 AI Agent 一样，直接在左侧对话框提问（如最新资讯、价格、官方文档或事实核查），Harbor 会在需要时<strong>自主在后台静默检索并阅读原文</strong>，在此实时沉淀来源与摘录。
            </span>
            <span>
              需要亲眼看 AI 操作网页或登录验证时，切换上方 <strong>「👁 前台可视」</strong> 或在对话里直接说「打开浏览器前台搜给我看」。
            </span>
          </div>
        ) : (
          activities.map((act) => (
            <article key={act.id} className="sd-act">
              <div className="sd-act-head">
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {act.kind === 'search' ? `🔍 ${act.query || '后台检索'}` : (act.kind === 'captcha' ? '🛡 等待人工验证' : `📄 ${act.title || act.url}`)}
                </strong>
                <span
                  className="sd-badge"
                  data-tone={act.status === 'fail' ? 'err' : (act.mode === 'visible' ? 'visible' : (act.status === 'done' ? 'ok' : ''))}
                >
                  {act.status === 'running'
                    ? (act.mode === 'visible' ? '前台执行中…' : '后台检索中…')
                    : (act.status === 'fail'
                      ? '检索失败'
                      : (act.kind === 'search' ? `${act.mode === 'visible' ? '前台' : '后台'} · ${act.count || 0} 条${act.cached ? ' (缓存)' : ''}` : '已读取'))}
                </span>
              </div>

              {act.error && <div style={{ fontSize: 11.5, color: 'var(--err)' }}>{act.error}</div>}

              {act.excerpt && act.kind !== 'search' && (
                <div className="sd-source-snip">{act.excerpt}</div>
              )}

              {Array.isArray(act.results) && act.results.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {act.results.slice(0, 6).map((item, idx) => (
                    <div key={item.url || idx} className="sd-source">
                      <span className="sd-source-title">{item.title}</span>
                      {item.domain && <span className="sd-source-domain">{item.domain}</span>}
                      {item.snippet && <span className="sd-source-snip">{item.snippet}</span>}
                      <div className="sd-actions">
                        <button type="button" className="sd-btn" onClick={() => openSourceInForeground(item.url)}>
                          👁 前台打开看
                        </button>
                        <button
                          type="button"
                          className="sd-btn"
                          onClick={() => {
                            appendComposerDraft(`参考来源：${item.title} (${item.url})\n${item.snippet || ''}`)
                            pushToast('已引用该来源到输入框', 'ok')
                          }}
                        >
                          引用到对话
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {act.url && act.kind !== 'search' && (
                <div className="sd-actions">
                  <button type="button" className="sd-btn" onClick={() => openSourceInForeground(act.url)}>
                    👁 前台浏览器打开
                  </button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </aside>
  )
}
