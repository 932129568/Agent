import { useEffect, useMemo, useState } from 'react'
import {
  useSlice,
  refreshMarket,
  toggleCuratedPackEnabled,
  addComposerToken,
  setComposerDraft,
  addGroupMember,
  setDockPreview,
  closeModal,
  setActivePanel,
  activateLocalExpertPackage,
  previewLocalExpertSkills,
  importLocalExpertDirectory,
  toggleLocalExpertEnabled,
  pushToast,
} from '../../state/store.js'
import { EXPERT_CATEGORIES, CURATED_INDUSTRY_PACKS, filterCuratedPacks } from '../../services/industryExperts.js'
import ExpertTeamRunner from './ExpertTeamRunner.jsx'
import './MarketModal.css'

function pickZhText(val, fallback = '') {
  if (!val) return fallback
  if (typeof val === 'string') return val
  if (typeof val === 'object') return val.zh || val.en || fallback
  return fallback
}

export default function MarketModal() {
  const market = useSlice('market')
  const [tab, setTab] = useState('industry') // 'industry' | 'local' | 'team'
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [importPath, setImportPath] = useState('')

  useEffect(() => { refreshMarket('').catch(() => {}) }, [])

  const curatedList = useMemo(
    () => filterCuratedPacks({ category, query }),
    [category, query]
  )
  const disabledSet = useMemo(
    () => new Set(market.disabledCurated || []),
    [market.disabledCurated]
  )

  // 本机导入的专家包：过滤掉旧版混乱英文占位包（若用户手动导入新目录则优先完整展示）
  const localPackages = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (market.experts || []).filter((pkg) => {
      if (!q) return true
      const md = pkg.metadata || {}
      const text = [pkg.id, pkg.name, pickZhText(md.displayName), pickZhText(md.description)].join(' ').toLowerCase()
      return text.includes(q)
    })
  }, [market.experts, query])

  const attachCuratedPack = (pack, prefillPrompt = '') => {
    addComposerToken({
      id: pack.id,
      name: pack.name,
      kind: pack.kind || 'skill',
      prompt: pack.prompt,
    })
    if (prefillPrompt) setComposerDraft(prefillPrompt)
    closeModal('left')
    setActivePanel('chat')
    pushToast(`已装载行业专家「${pack.name}」到对话输入框`, 'ok')
  }

  const addPackToGroup = (pack) => {
    addGroupMember({
      name: pack.name.split('·')[0].trim().slice(0, 14),
      persona: `${pack.description}\n核心技能：${(pack.skills || []).join(', ')}`,
      model: '',
      capabilities: pack.capabilities || ['text'],
      reasoningTier: 'auto',
      allowTools: true,
    })
    pushToast(`已将「${pack.name}」加入群聊接力名册`, 'ok')
  }

  const handleUseLocalExpert = (pkg) => activateLocalExpertPackage(pkg)

  const handlePreviewPackageSkills = (pkg) => previewLocalExpertSkills(pkg)

  const handleImport = async () => {
    if (!importPath.trim()) return
    if (await importLocalExpertDirectory(importPath.trim())) {
      setImportPath('')
    }
  }

  return (
    <div className="mk-body">
      <div className="mk-bar">
        <button type="button" className={tab === 'industry' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('industry')}>
          🔥 热门行业专家与 Skill 库（{CURATED_INDUSTRY_PACKS.length}）
        </button>
        <button type="button" className={tab === 'local' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('local')}>
          📦 标准 .codebuddy-plugin 包（{(market.experts || []).length}）
        </button>
        <button type="button" className={tab === 'team' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('team')}>
          ✦ 多专家团队编排器
        </button>
      </div>

      {tab === 'team' && <ExpertTeamRunner />}

      {tab === 'industry' && (
        <>
          <div className="mk-bar">
            <input
              className="mk-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索行业、技能或场景（如：PPT、视频分镜、TDD、合同审查、SQL、SEO）…"
            />
          </div>
          <div className="mk-cats" role="tablist" aria-label="行业分类筛选">
            {EXPERT_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className="mk-btn"
                data-active={String(category === c.id)}
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="mk-grid">
            {curatedList.map((pack) => {
              const disabled = disabledSet.has(pack.id)
              return (
                <article key={pack.id} className="mk-card" data-disabled={String(disabled)}>
                  <div className="mk-card-head">
                    <div>
                      <div className="mk-card-title">{pack.name}</div>
                      <div className="mk-card-sub">{pack.categoryLabel} · {pack.subtitle}</div>
                    </div>
                    <span className="mk-badge">{pack.badge}</span>
                  </div>
                  <div className="mk-desc">{pack.description}</div>
                  <div className="mk-skills">
                    {(pack.skills || []).map((sk) => (
                      <span key={sk} className="mk-skill-tag">#{sk}</span>
                    ))}
                  </div>
                  <div className="mk-source" title={pack.sourceRepo}>开源参考：{pack.sourceRepo}</div>
                  {Array.isArray(pack.quickPrompts) && pack.quickPrompts.length > 0 && (
                    <div className="mk-prompts">
                      {pack.quickPrompts.slice(0, 1).map((qp, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className="mk-prompt-btn"
                          title="点击立即带此场景词进入对话"
                          onClick={() => attachCuratedPack(pack, qp)}
                        >
                          ▶ 试一试：{qp}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mk-actions">
                    <button type="button" className="mk-btn mk-btn-primary" disabled={disabled} onClick={() => attachCuratedPack(pack)}>
                      ✦ 加入输入框
                    </button>
                    <button type="button" className="mk-btn" disabled={disabled} onClick={() => addPackToGroup(pack)}>
                      + 加入群聊
                    </button>
                    <button type="button" className="mk-btn" onClick={() => toggleCuratedPackEnabled(pack.id)}>
                      {disabled ? '启用' : '停用'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </>
      )}

      {tab === 'local' && (
        <>
          <div className="mk-bar">
            <input
              className="mk-search"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder="导入本地专家包 / SKILL.md 目录绝对路径（支持 .codebuddy-plugin / plugin.json）…"
            />
            <button type="button" className="mk-btn mk-btn-primary" onClick={handleImport}>导入目录</button>
          </div>
          {market.loading ? (
            <div style={{ color: 'var(--text-3)' }}>正在扫描本地专家包…</div>
          ) : (
            <div className="mk-grid">
              {localPackages.map((pkg) => {
                const md = pkg.metadata || {}
                const title = pickZhText(md.displayName, pkg.name || pkg.id)
                const prof = pickZhText(md.profession, '')
                const desc = pickZhText(md.description, '本地导入的专家技能包')
                return (
                  <article key={pkg.id} className="mk-card">
                    <div className="mk-card-head">
                      <div>
                        <div className="mk-card-title">{title}</div>
                        <div className="mk-card-sub">{pkg.id}{prof ? ` · ${prof}` : ''}{md.skillsCount ? ` · ${md.skillsCount} 技能` : ''}</div>
                      </div>
                      <span className="mk-badge">{pkg.kind || 'agent'}</span>
                    </div>
                    <div className="mk-desc">{desc}</div>
                    <div className="mk-actions">
                      <button type="button" className="mk-btn mk-btn-primary" onClick={() => handleUseLocalExpert(pkg)}>
                        ✦ 加入输入框
                      </button>
                      <button type="button" className="mk-btn" onClick={() => handlePreviewPackageSkills(pkg)}>
                        📄 预览 SKILL
                      </button>
                      <button
                        type="button"
                        className="mk-btn"
                        onClick={() => toggleLocalExpertEnabled(pkg)}
                      >
                        {pkg.enabled === false ? '启用' : '停用'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
