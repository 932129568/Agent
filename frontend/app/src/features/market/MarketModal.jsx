import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  useSlice,
  refreshMarket,
  refreshSettingsAux,
  toggleCuratedPackEnabled,
  addComposerToken,
  setComposerDraft,
  addGroupMember,
  saveMcpServerConfig,
  closeModal,
  setActivePanel,
  activateLocalExpertPackage,
  previewLocalExpertSkills,
  importLocalExpertDirectory,
  toggleLocalExpertEnabled,
  pushToast,
} from '../../state/store.js'
import {
  EXPERT_CATEGORIES,
  SKILL_CATEGORIES,
  CURATED_INDUSTRY_PACKS,
  CURATED_SKILLS,
  filterCuratedPacks,
  filterCuratedSkills,
} from '../../services/industryExperts.js'
import {
  MCP_CATEGORIES,
  CURATED_MCP_SERVERS,
  filterCuratedMcpServers,
} from '../../services/mcpCatalog.js'
import { NATIVE_EXPERT_TEAMS } from '../../services/expertTeam.js'
import ExpertTeamRunner from './ExpertTeamRunner.jsx'
import './MarketModal.css'

function pickZhText(val, fallback = '') {
  if (!val) return fallback
  if (typeof val === 'string') return val
  if (typeof val === 'object') return val.zh || val.en || fallback
  return fallback
}

export default function MarketModal() {
  const ui = useSlice('ui')
  const market = useSlice('market')
  const settings = useSlice('settings')
  const [tab, setTab] = useState(() => ui.marketTab || 'industry')

  useEffect(() => {
    if (ui.marketTab && ui.marketTab !== tab) setTab(ui.marketTab)
  }, [ui.marketTab])
  const [category, setCategory] = useState('all')
  const [skillCategory, setSkillCategory] = useState('all')
  const [mcpCategory, setMcpCategory] = useState('all')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [importPath, setImportPath] = useState('')
  const [installingMcp, setInstallingMcp] = useState('')

  useEffect(() => {
    refreshMarket('').catch(() => {})
    refreshSettingsAux().catch(() => {})
  }, [])

  const curatedList = useMemo(
    () => filterCuratedPacks({ category, query: deferredQuery }),
    [category, deferredQuery]
  )
  const skillList = useMemo(
    () => filterCuratedSkills({ category: skillCategory, query: deferredQuery }),
    [skillCategory, deferredQuery]
  )
  const mcpList = useMemo(
    () => filterCuratedMcpServers({ category: mcpCategory, query: deferredQuery }),
    [mcpCategory, deferredQuery]
  )
  const disabledSet = useMemo(
    () => new Set(market.disabledCurated || []),
    [market.disabledCurated]
  )
  const installedMcpSet = useMemo(() => {
    const names = (settings.mcpServers || []).map((s) => (typeof s === 'string' ? s : (s && s.name) || ''))
    return new Set(names.filter(Boolean))
  }, [settings.mcpServers])

  const localPackages = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return (market.experts || []).filter((pkg) => {
      if (!q) return true
      const md = pkg.metadata || {}
      const text = [pkg.id, pkg.name, pickZhText(md.displayName), pickZhText(md.description)].join(' ').toLowerCase()
      return text.includes(q)
    })
  }, [market.experts, deferredQuery])

  const attachCuratedPack = (pack, prefillPrompt = '') => {
    addComposerToken({
      id: pack.id,
      name: pack.name,
      kind: pack.kind || 'agent',
      prompt: pack.prompt,
    })
    if (prefillPrompt) setComposerDraft(prefillPrompt)
    closeModal('left')
    setActivePanel('chat')
    pushToast(`已装载行业专家「${pack.name}」到对话输入框`, 'ok')
  }

  const attachStandaloneSkill = (skill) => {
    addComposerToken({
      id: skill.id,
      name: `Skill · ${skill.name}`,
      kind: 'skill',
      prompt: skill.prompt,
    })
    closeModal('left')
    setActivePanel('chat')
    pushToast(`已挂载独立技能「${skill.name}」到对话输入框`, 'ok')
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

  const handleQuickInstallMcp = async (mcp) => {
    setInstallingMcp(mcp.id)
    try {
      await saveMcpServerConfig(mcp.serverKey, mcp.command)
    } finally {
      setInstallingMcp('')
    }
  }

  const handleImport = async () => {
    if (!importPath.trim()) return
    if (await importLocalExpertDirectory(importPath.trim())) {
      setImportPath('')
    }
  }

  return (
    <div className="mk-body">
      <div className="mk-seg-bar" role="tablist" aria-label="生态市场板块">
        <button type="button" className={tab === 'industry' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('industry')}>
          🔥 行业专家库（{CURATED_INDUSTRY_PACKS.length}）
        </button>
        <button type="button" className={tab === 'team' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('team')}>
          ✦ 多专家团队（{NATIVE_EXPERT_TEAMS.length}）
        </button>
        <button type="button" className={tab === 'skills' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('skills')}>
          ⚡ 热门 Skill 库（{CURATED_SKILLS.length}）
        </button>
        <button type="button" className={tab === 'mcp' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('mcp')}>
          🔌 热门 MCP 生态（{CURATED_MCP_SERVERS.length}）
        </button>
        <button type="button" className={tab === 'local' ? 'mk-btn mk-btn-primary' : 'mk-btn'} onClick={() => setTab('local')}>
          📦 本地插件包（{(market.experts || []).length}）
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
              placeholder={`搜索 ${CURATED_INDUSTRY_PACKS.length} 大行业专家（如：FastAPI、小程序、小红书、短剧、Excel、简历、旅行、合同）…`}
            />
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>共 {curatedList.length} 项</span>
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

      {tab === 'skills' && (
        <>
          <div className="mk-bar">
            <input
              className="mk-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索 ${CURATED_SKILLS.length} 个独立热门实用 Skill（如：去 AI 味、根因排障、Excel、合同、PRD、周报、SQL）…`}
            />
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>共 {skillList.length} 项</span>
          </div>
          <div className="mk-cats" role="tablist" aria-label="Skill 分类筛选">
            {SKILL_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className="mk-btn"
                data-active={String(skillCategory === c.id)}
                onClick={() => setSkillCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="mk-grid" data-section="skills-grid">
            {skillList.map((sk) => (
              <article key={sk.id} className="mk-card">
                <div className="mk-card-head">
                  <div>
                    <div className="mk-card-title">⚡ {sk.name}</div>
                    <div className="mk-card-sub">{sk.categoryLabel} · #{sk.id}</div>
                  </div>
                  <span className="mk-badge">{sk.badge}</span>
                </div>
                <div className="mk-desc">{sk.description}</div>
                <div className="mk-actions">
                  <button type="button" className="mk-btn mk-btn-primary" onClick={() => attachStandaloneSkill(sk)}>
                    ✦ 装载此 Skill
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {tab === 'mcp' && (
        <>
          <div className="mk-bar">
            <input
              className="mk-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索 ${CURATED_MCP_SERVERS.length} 套热门 MCP 服务器（如：Context7、GitHub、Playwright、Figma、Notion、Postgres、飞书）…`}
            />
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>已接入 {installedMcpSet.size} / 目录 {mcpList.length}</span>
          </div>
          <div className="mk-cats" role="tablist" aria-label="MCP 分类筛选">
            {MCP_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className="mk-btn"
                data-active={String(mcpCategory === c.id)}
                onClick={() => setMcpCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="mk-grid" data-section="mcp-grid">
            {mcpList.map((mcp) => {
              const installed = installedMcpSet.has(mcp.serverKey)
              return (
                <article key={mcp.id} className="mk-card">
                  <div className="mk-card-head">
                    <div>
                      <div className="mk-card-title">🔌 {mcp.name}</div>
                      <div className="mk-card-sub">{mcp.categoryLabel} · {mcp.serverKey}</div>
                    </div>
                    <span className="mk-badge">{installed ? '已接入' : mcp.badge}</span>
                  </div>
                  <div className="mk-desc">{mcp.description}</div>
                  <div className="mk-skill-tag" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mcp.command}>
                    {mcp.command}
                  </div>
                  <div className="mk-source" title={mcp.sourceRepo}>
                    {mcp.envHint ? `提示：${mcp.envHint} · ` : ''}来源：{mcp.sourceRepo}
                  </div>
                  <div className="mk-actions">
                    <button
                      type="button"
                      className={installed ? 'mk-btn' : 'mk-btn mk-btn-primary'}
                      disabled={installingMcp === mcp.id}
                      onClick={() => handleQuickInstallMcp(mcp)}
                    >
                      {installingMcp === mcp.id ? '接入中…' : (installed ? '✓ 重新保存接入' : '⚡ 一键接入 MCP')}
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
                      <button type="button" className="mk-btn mk-btn-primary" onClick={() => activateLocalExpertPackage(pkg)}>
                        ✦ 加入输入框
                      </button>
                      <button type="button" className="mk-btn" onClick={() => previewLocalExpertSkills(pkg)}>
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
