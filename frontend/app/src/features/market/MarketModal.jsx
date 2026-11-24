import { useEffect, useState } from 'react'
import {
  useSlice,
  refreshMarket,
  addComposerToken,
  closeModal,
  setActivePanel,
  pushToast,
} from '../../state/store.js'
import * as api from '../../services/bridge.js'
import ExpertTeamRunner from './ExpertTeamRunner.jsx'
import './MarketModal.css'

export default function MarketModal() {
  const market = useSlice('market')
  const [tab, setTab] = useState('catalog')
  const [query, setQuery] = useState('')
  const [importPath, setImportPath] = useState('')

  useEffect(() => { refreshMarket('').catch(() => {}) }, [])

  const handleUseExpert = (pkg) => {
    const meta = pkg.metadata || pkg
    const name = meta.displayName || meta.name || pkg.id
    addComposerToken({
      id: pkg.id,
      name,
      kind: pkg.kind || 'expert',
      prompt: meta.description || `请以「${name}」专家身份回答。`,
    })
    closeModal()
    setActivePanel('chat')
    pushToast(`已将专家「${name}」加入输入框胶囊，随消息一同发送`, 'ok')
  }

  const handleImport = async () => {
    if (!importPath.trim()) return
    try {
      const r = await api.expertImportDirectory(importPath.trim())
      if (r && r.ok) {
        setImportPath('')
        await refreshMarket(query)
        pushToast('专家目录导入成功', 'ok')
      } else {
        pushToast((r && r.error) || '导入失败', 'err')
      }
    } catch (e) {
      pushToast(e.message, 'err')
    }
  }

  return (
    <div className="mk-body">
      <div className="mk-bar">
        <button type="button" className={tab === 'catalog' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('catalog')}>
          专家包目录（{(market.experts || []).length}）
        </button>
        <button type="button" className={tab === 'team' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('team')}>
          ✦ 多专家团队编排器（信箱 / 时间线 / 恢复）
        </button>
      </div>

      {tab === 'team' ? (
        <ExpertTeamRunner />
      ) : (
        <>
          <div className="mk-bar">
            <input className="mk-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索专家包 / 技能 / 角色…" />
            <button type="button" className="mk-btn mk-btn-primary" onClick={() => refreshMarket(query)}>搜索</button>
          </div>
          <div className="mk-bar">
            <input className="mk-search" value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="导入本地专家包目录路径（可选）…" />
            <button type="button" className="mk-btn" onClick={handleImport}>导入目录</button>
          </div>
          {market.loading ? (
            <div style={{ color: 'var(--text-3)' }}>正在读取内置与本地专家包…</div>
          ) : (
            <div className="mk-grid">
              {(market.experts || []).map((pkg) => {
                const meta = pkg.metadata || pkg
                const name = meta.displayName || meta.name || pkg.id
                return (
                  <div key={pkg.id} className="mk-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{name}</strong>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{pkg.kind || 'expert'}</span>
                    </div>
                    <div className="mk-desc">{meta.description || '内置专业角色包，点击立即嵌入对话输入框'}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="mk-btn mk-btn-primary" onClick={() => handleUseExpert(pkg)}>
                        ✦ 加入输入框
                      </button>
                      <button type="button" className="mk-btn" onClick={async () => {
                        await api.expertSetEnabled(pkg.id, pkg.enabled === false, pkg.snapshot_id || '')
                        await refreshMarket(query)
                      }}>
                        {pkg.enabled === false ? '启用' : '停用'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
