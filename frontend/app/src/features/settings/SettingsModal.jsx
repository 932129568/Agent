import { useEffect, useState } from 'react'
import {
  useSlice,
  updateVisualSettings,
  saveBackendConfig,
  refreshSettingsAux,
  checkAppUpdate,
  fireShellImpact,
  saveModelProfile,
  deleteModelProfile,
  activateSavedModelGlobal,
  testModelEndpoint,
  probeLocalEndpoints,
  saveHybridSettings,
  saveGuardTiersConfig,
  saveSandboxSettings,
  probeExternalSoftware,
  runWebdavSyncAction,
  downloadAppUpdate,
  applyAppUpdate,
  saveMcpServerConfig,
  testMcpServerConfig,
  deleteMcpServerConfig,
  addLongTermMemory,
  deleteLongTermMemory,
  pushToast,
} from '../../state/store.js'
import { assertLatin1Value } from '../../services/headers.js'
import { CONTEXT_WINDOW_PRESETS, MAX_OUTPUT_PRESETS, REASONING_TIERS, buildReasoningRequestParams } from '../../services/reasoningPresets.js'
import { MEDIA_PROVIDER_PRESETS } from '../../services/mediaGen.js'
import { MODEL_VAULT_PRESETS } from '../../services/modelVault.js'
import './SettingsModal.css'

const DOMAINS = [
  { id: 'model', label: '模型、混合路由与推理', keywords: '模型 api key base url 本地 ollama 混合 hybrid 上下文 context 输出 max_tokens 思考 reasoning thinking 档位 预算' },
  { id: 'tools', label: '工具、MCP、沙箱与软件', keywords: 'mcp 护栏 沙箱 sandbox 外部软件 software 工具' },
  { id: 'memory', label: '记忆与 WebDAV 同步', keywords: '记忆 memory webdav 同步 备份 恢复' },
  { id: 'optics', label: '透色、动效与自动更新', keywords: '外观 主题 透明 acrylic mica 四幕 动效 更新 update' },
]

export default function SettingsModal() {
  const settings = useSlice('settings')
  const runtime = useSlice('runtime')
  const [domain, setDomain] = useState('model')
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(() => ({ ...settings.backendConfig }))
  const [hybridDraft, setHybridDraft] = useState(() => ({ ...settings.hybridConfig }))
  const [sandboxDraft, setSandboxDraft] = useState(() => ({ ...settings.sandboxConfig }))
  const [guardTiersDraft, setGuardTiersDraft] = useState(() => ({ ...((settings.guardConfig && settings.guardConfig.tiers) || {}) }))
  const [webdavDraft, setWebdavDraft] = useState(() => ({ ...settings.webdavConfig }))
  const [errMsg, setErrMsg] = useState('')
  const [probeRes, setProbeRes] = useState('')
  const [newMem, setNewMem] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpCmd, setMcpCmd] = useState('')
  const [swProbing, setSwProbing] = useState(false)
  const [vaultDraft, setVaultDraft] = useState({
    id: '',
    label: '',
    model: '',
    kind: 'chat',
    baseUrl: '',
    apiKey: '',
    contextWindow: 128000,
    maxTokens: 4096,
    reasoningTier: 'auto',
    notes: '',
  })

  useEffect(() => { setDraft({ ...settings.backendConfig }) }, [settings.backendConfig])
  useEffect(() => { setHybridDraft({ ...settings.hybridConfig }) }, [settings.hybridConfig])
  useEffect(() => { setSandboxDraft({ ...settings.sandboxConfig }) }, [settings.sandboxConfig])
  useEffect(() => { setGuardTiersDraft({ ...((settings.guardConfig && settings.guardConfig.tiers) || {}) }) }, [settings.guardConfig])
  useEffect(() => { setWebdavDraft((prev) => ({ ...settings.webdavConfig, password: prev.password || '' })) }, [settings.webdavConfig])
  useEffect(() => { refreshSettingsAux().catch(() => {}) }, [])

  const visibleDomains = DOMAINS.filter((d) => {
    const q = search.trim().toLowerCase()
    return !q || d.label.toLowerCase().includes(q) || d.keywords.includes(q)
  })

  const handleSaveModel = async (alsoTest) => {
    try {
      const baseVal = draft.provider_base_url || draft.provider_base || ''
      const keyVal = draft.api_key || draft.provider_key || ''
      assertLatin1Value('API Key', keyVal)
      assertLatin1Value('Base URL', baseVal)
      if (draft.local_base_url) assertLatin1Value('本地端点 URL', draft.local_base_url)
      setErrMsg('')
      await saveBackendConfig({ ...draft, provider_base_url: baseVal, provider_base: baseVal, api_key: keyVal, provider_key: keyVal })
      if (alsoTest) {
        await testModelEndpoint({
          baseUrl: draft.local_mode ? draft.local_base_url : baseVal,
          apiKey: keyVal,
          model: draft.local_mode ? draft.local_model : (draft.model || draft.provider_model || 'glm-4.5-flash'),
          localMode: !!draft.local_mode,
        })
      }
    } catch (e) {
      setErrMsg(e.message)
      pushToast(e.message, 'err')
    }
  }

  const handleProbeLocal = async () => {
    setProbeRes(await probeLocalEndpoints())
  }

  const handleSaveHybrid = () => saveHybridSettings(hybridDraft)

  const handleSaveGuardTiers = async (overrideTiers = null) => {
    const nextTiers = overrideTiers || guardTiersDraft
    const r = await saveGuardTiersConfig(nextTiers)
    if (r && r.ok) setGuardTiersDraft(nextTiers)
  }

  const handleSaveSandbox = async () => {
    const r = await saveSandboxSettings(sandboxDraft)
    if (r && r.ok && r.offTiers) setGuardTiersDraft(r.offTiers)
  }

  const handleProbeSoftware = async () => {
    setSwProbing(true)
    try { await probeExternalSoftware() } finally { setSwProbing(false) }
  }

  const handleWebdav = (act) => runWebdavSyncAction(act, webdavDraft)

  const handleDownloadUpdate = () => downloadAppUpdate()

  return (
    <div className="st-shell">
      <nav className="st-nav" aria-label="设置分组">
        <input className="st-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索设置…" />
        {visibleDomains.map((d) => (
          <button key={d.id} type="button" className="st-nav-btn" data-active={String(domain === d.id)} onClick={() => setDomain(d.id)}>
            {d.label}
          </button>
        ))}
      </nav>

      <div className="st-body">
        {domain === 'model' && (
          <>
            <div className="st-card" data-section="model-vault">
              <div className="st-row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>🧠 模型保存中心（已保存 {(settings.savedModels || []).length} 个 · 全站随时切换）</h3>
                <button
                  type="button"
                  className="st-btn"
                  onClick={async () => {
                    const mName = draft.model || draft.provider_model || 'glm-4.5-flash'
                    await saveModelProfile({
                      label: `${mName}（主力配置）`,
                      model: mName,
                      kind: 'chat',
                      baseUrl: draft.provider_base_url || draft.provider_base || '',
                      apiKey: draft.api_key || draft.provider_key || '',
                      contextWindow: Number(draft.context_window) || 128000,
                      maxTokens: Number(draft.max_tokens) || 4096,
                      reasoningTier: draft.reasoning_effort || 'auto',
                    })
                  }}
                >
                  + 将当前主力配置存入中心
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                在此自定义添加并保存多套模型（对话 / 生图 / 视频，可各自绑定独立端点与 Key）；保存后可在顶部灵动岛、对话输入条、群聊角色、DAG 工作流与双模协同中一键切换。
              </div>

              <div className="st-row">
                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>一键填模板：</span>
                {MODEL_VAULT_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="st-btn"
                    style={{ fontSize: 11.5, padding: '4px 10px' }}
                    onClick={() => setVaultDraft({
                      id: '',
                      label: p.label,
                      model: p.model,
                      kind: p.kind,
                      baseUrl: p.baseUrl,
                      apiKey: '',
                      contextWindow: p.contextWindow,
                      maxTokens: p.maxTokens,
                      reasoningTier: p.reasoningTier,
                      notes: p.notes,
                    })}
                  >
                    + {p.label.split('（')[0]}
                  </button>
                ))}
              </div>

              <div className="st-row">
                <input
                  className="st-input"
                  style={{ flex: 1.2, minWidth: 140 }}
                  aria-label="保存模型显示名称"
                  value={vaultDraft.label}
                  onChange={(e) => setVaultDraft({ ...vaultDraft, label: e.target.value })}
                  placeholder="自定义显示名称（如：DeepSeek 代码主力）"
                />
                <input
                  className="st-input"
                  style={{ flex: 1, minWidth: 130 }}
                  aria-label="保存模型ID"
                  value={vaultDraft.model}
                  onChange={(e) => setVaultDraft({ ...vaultDraft, model: e.target.value })}
                  placeholder="模型标识（如：deepseek-chat）"
                />
                <select
                  className="st-btn"
                  aria-label="保存模型类型"
                  value={vaultDraft.kind}
                  onChange={(e) => setVaultDraft({ ...vaultDraft, kind: e.target.value })}
                >
                  <option value="chat">对话模型</option>
                  <option value="image">图片生成</option>
                  <option value="video">视频生成</option>
                </select>
              </div>

              <div className="st-row">
                <input
                  className="st-input"
                  style={{ flex: 2, minWidth: 180 }}
                  aria-label="保存模型端点URL"
                  value={vaultDraft.baseUrl}
                  onChange={(e) => setVaultDraft({ ...vaultDraft, baseUrl: e.target.value })}
                  placeholder="Base URL（留空继承全局端点，如 https://api.deepseek.com/v1）"
                />
                <input
                  className="st-input"
                  style={{ flex: 1.3, minWidth: 130 }}
                  type="password"
                  aria-label="保存模型API Key"
                  value={vaultDraft.apiKey}
                  onChange={(e) => setVaultDraft({ ...vaultDraft, apiKey: e.target.value })}
                  placeholder="独立 API Key（留空继承）"
                />
                <select
                  className="st-btn"
                  value={vaultDraft.reasoningTier || 'auto'}
                  onChange={(e) => setVaultDraft({ ...vaultDraft, reasoningTier: e.target.value })}
                  title="默认思考档位"
                >
                  {REASONING_TIERS.filter((t) => t.id !== 'custom').map((t) => (
                    <option key={t.id} value={t.id}>思考:{t.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="st-btn st-btn-primary"
                  onClick={async () => {
                    const r = await saveModelProfile(vaultDraft)
                    if (r && r.ok) {
                      setVaultDraft({
                        id: '', label: '', model: '', kind: 'chat', baseUrl: '', apiKey: '',
                        contextWindow: 128000, maxTokens: 4096, reasoningTier: 'auto', notes: '',
                      })
                    }
                  }}
                >
                  {vaultDraft.id ? '更新已保存模型' : '+ 保存到模型中心'}
                </button>
              </div>

              {(settings.savedModels || []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  {(settings.savedModels || []).map((m) => (
                    <div key={m.id} className="st-mem-row" data-saved-model-id={m.id}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong style={{ fontSize: 12.5 }}>
                          {m.kind === 'image' ? '🎨 ' : (m.kind === 'video' ? '🎬 ' : (m.isLocal ? '💻 ' : '☁ '))}
                          {m.label}
                        </strong>
                        <span style={{ marginLeft: 8, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
                          {m.model}{m.baseUrl ? ` · ${m.baseUrl}` : ' · 继承主端点'}
                        </span>
                      </div>
                      <div className="st-row">
                        <button type="button" className="st-btn" onClick={() => activateSavedModelGlobal(m.id)}>设为默认</button>
                        <button type="button" className="st-btn" onClick={() => setVaultDraft({ ...m })}>编辑</button>
                        <button type="button" className="st-btn" onClick={() => deleteModelProfile(m.id)}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="st-card">
              <h3>云端 / OpenAI 兼容端点与会话预算</h3>
              <div className="st-field">
                <label>Base URL</label>
                <input className="st-input" value={draft.provider_base_url || draft.provider_base || ''} onChange={(e) => setDraft({ ...draft, provider_base_url: e.target.value, provider_base: e.target.value })} />
              </div>
              <div className="st-field">
                <label>API Key（自动拦截中文/全角非 ASCII 字符）</label>
                <input className="st-input" type="password" value={draft.api_key || ''} onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} placeholder="sk-..." />
              </div>
              <div className="st-row">
                <div className="st-field" style={{ flex: 1 }}>
                  <label>模型名</label>
                  <input className="st-input" value={draft.model || ''} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
                </div>
                <div className="st-field" style={{ width: 110 }}>
                  <label>温度</label>
                  <input className="st-input" type="number" step="0.1" min="0" max="2" value={draft.temperature ?? 0.7}
                    onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })} />
                </div>
                <div className="st-field" style={{ width: 130 }}>
                  <label>单会话预算 (¥)</label>
                  <input className="st-input" type="number" step="0.5" min="0" value={draft.session_budget ?? 0}
                    onChange={(e) => setDraft({ ...draft, session_budget: Number(e.target.value) })} />
                </div>
              </div>
              {errMsg && <div className="st-err">{errMsg}</div>}
              <div className="st-row">
                <button type="button" className="st-btn st-btn-primary" onClick={() => handleSaveModel(false)}>保存配置</button>
                <button type="button" className="st-btn" onClick={() => handleSaveModel(true)}>保存并测试连接</button>
              </div>
            </div>

            <div className="st-card">
              <h3>上下文长度、最大输出与多级思考档位</h3>
              <div className="st-field">
                <label>上下文长度（Context Window：{Number(draft.context_window || 128000).toLocaleString()} tokens，驱动自动压缩时机）</label>
                <div className="st-row">
                  {CONTEXT_WINDOW_PRESETS.map((p) => (
                    <button key={p.value} type="button" className="st-btn"
                      data-active={String(Number(draft.context_window || 128000) === p.value)}
                      onClick={() => setDraft({ ...draft, context_window: p.value })}>{p.label}</button>
                  ))}
                  <input className="st-input" style={{ width: 116 }} type="number" min="4096" max="1000000" step="4096"
                    value={draft.context_window ?? 128000}
                    onChange={(e) => setDraft({ ...draft, context_window: Number(e.target.value) || 32768 })} />
                </div>
              </div>

              <div className="st-field">
                <label>最大输出长度（Max Tokens：{Number(draft.max_tokens || 4096).toLocaleString()}）</label>
                <div className="st-row">
                  {MAX_OUTPUT_PRESETS.map((p) => (
                    <button key={p.value} type="button" className="st-btn"
                      data-active={String(Number(draft.max_tokens || 4096) === p.value)}
                      onClick={() => setDraft({ ...draft, max_tokens: p.value })}>{p.label}</button>
                  ))}
                  <input className="st-input" style={{ width: 116 }} type="number" min="256" max="128000" step="512"
                    value={draft.max_tokens ?? 4096}
                    onChange={(e) => setDraft({ ...draft, max_tokens: Number(e.target.value) || 4096 })} />
                </div>
              </div>

              <div className="st-field">
                <label>思考档位（内置 低 / 中 / 高 / 超高 / 极致 + 自定义，自动适配各厂商协议）</label>
                <div className="st-row">
                  {REASONING_TIERS.map((t) => (
                    <button key={t.id} type="button" className="st-btn" title={t.desc}
                      data-active={String((draft.reasoning_effort || 'auto') === t.id)}
                      onClick={() => setDraft({ ...draft, reasoning_effort: t.id })}>{t.label}</button>
                  ))}
                </div>
              </div>

              {(draft.reasoning_effort || 'auto') === 'custom' && (
                <div className="st-row">
                  <div className="st-field" style={{ flex: 1 }}>
                    <label>自定义思考 Token 预算（如 8192 / 24576 / 65536）</label>
                    <input className="st-input" type="number" min="0" max="128000" step="1024"
                      value={draft.thinking_budget ?? 8192}
                      onChange={(e) => setDraft({ ...draft, thinking_budget: Number(e.target.value) || 0 })} />
                  </div>
                  <div className="st-field" style={{ flex: 1 }}>
                    <label>可选：自定义原始 effort 参数名（如 minimal / xhigh）</label>
                    <input className="st-input" value={draft.custom_effort || ''}
                      onChange={(e) => setDraft({ ...draft, custom_effort: e.target.value })}
                      placeholder="留空按预算自动映射" />
                  </div>
                </div>
              )}

              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
                协议映射预览：{buildReasoningRequestParams({
                  baseUrl: draft.local_mode ? draft.local_base_url : (draft.provider_base_url || draft.provider_base),
                  model: draft.local_mode ? draft.local_model : (draft.model || draft.provider_model),
                  tier: draft.reasoning_effort || 'auto',
                  customBudget: draft.thinking_budget,
                  customEffort: draft.custom_effort,
                }).summary}
              </div>
              <div className="st-row">
                <button type="button" className="st-btn st-btn-primary" onClick={() => handleSaveModel(false)}>保存推理参数</button>
              </div>
            </div>

            <div className="st-card">
              <h3>🎨 图片与视频生成模型配置（兼容多厂商 + 本地代理转发）</h3>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                留空地址或 Key 时自动继承上方主模型端点与 API Key；支持 GLM CogView/CogVideoX、OpenAI GPT-Image/Sora、硅基流动 FLUX/Wan2.1、MiniMax 及本地网关。
              </div>
              <div className="st-row">
                {MEDIA_PROVIDER_PRESETS.map((mp) => (
                  <button
                    key={mp.id}
                    type="button"
                    className="st-btn"
                    onClick={() => setDraft({
                      ...draft,
                      image_base_url: mp.imageBaseUrl,
                      image_model: mp.imageModel,
                      video_base_url: mp.videoBaseUrl,
                      video_model: mp.videoModel,
                    })}
                  >
                    套用 {mp.name.split(' ')[0]}
                  </button>
                ))}
              </div>
              <div className="st-row">
                <div className="st-field" style={{ flex: 2 }}>
                  <label>图片生成端点 URL（可选，留空继承主端点）</label>
                  <input className="st-input" value={draft.image_base_url || ''} onChange={(e) => setDraft({ ...draft, image_base_url: e.target.value })} placeholder="例如：https://open.bigmodel.cn/api/paas/v4" />
                </div>
                <div className="st-field" style={{ flex: 1 }}>
                  <label>图片模型名</label>
                  <input className="st-input" value={draft.image_model || ''} onChange={(e) => setDraft({ ...draft, image_model: e.target.value })} placeholder="cogview-4-250304 / gpt-image-1" />
                </div>
                <div className="st-field" style={{ flex: 1 }}>
                  <label>独立生图 Key（可选）</label>
                  <input className="st-input" type="password" value={draft.image_api_key || ''} onChange={(e) => setDraft({ ...draft, image_api_key: e.target.value })} placeholder="留空继承主 Key" />
                </div>
              </div>
              <div className="st-row">
                <div className="st-field" style={{ flex: 2 }}>
                  <label>视频生成端点 URL（可选，留空继承主端点）</label>
                  <input className="st-input" value={draft.video_base_url || ''} onChange={(e) => setDraft({ ...draft, video_base_url: e.target.value })} placeholder="例如：https://open.bigmodel.cn/api/paas/v4" />
                </div>
                <div className="st-field" style={{ flex: 1 }}>
                  <label>视频模型名</label>
                  <input className="st-input" value={draft.video_model || ''} onChange={(e) => setDraft({ ...draft, video_model: e.target.value })} placeholder="cogvideox-3 / sora-2 / video-01" />
                </div>
                <div className="st-field" style={{ flex: 1 }}>
                  <label>独立视频 Key（可选）</label>
                  <input className="st-input" type="password" value={draft.video_api_key || ''} onChange={(e) => setDraft({ ...draft, video_api_key: e.target.value })} placeholder="留空继承主 Key" />
                </div>
              </div>
              <div className="st-row">
                <button type="button" className="st-btn st-btn-primary" onClick={() => handleSaveModel(false)}>保存图片与视频端点配置</button>
              </div>
            </div>

            <div className="st-card">
              <h3>本地模型 & 云+本地混合路由策略</h3>
              <label className="st-row" style={{ cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={!!draft.local_mode} onChange={(e) => setDraft({ ...draft, local_mode: e.target.checked })} />
                <span>主对话优先走本地模型端点（0 API 费用）</span>
              </label>
              <div className="st-row">
                <input className="st-input" style={{ flex: 2 }} value={draft.local_base_url || ''} onChange={(e) => setDraft({ ...draft, local_base_url: e.target.value })} placeholder="http://127.0.0.1:11434/v1" />
                <input className="st-input" style={{ flex: 1 }} value={draft.local_model || ''} onChange={(e) => setDraft({ ...draft, local_model: e.target.value })} placeholder="本地模型名" />
                <button type="button" className="st-btn" onClick={handleProbeLocal}>探测本机端口</button>
              </div>
              {probeRes && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{probeRes}</div>}
              <div className="st-row" style={{ paddingTop: 6 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>混合路由策略：</span>
                {[['auto', '自动分类路由'], ['saver', '省 Token 优先本地'], ['quality', '质量优先全云端']].map(([k, lbl]) => (
                  <button key={k} type="button" className="st-btn" data-active={String((hybridDraft.strategy || 'auto') === k)}
                    onClick={() => setHybridDraft({ ...hybridDraft, strategy: k })}>{lbl}</button>
                ))}
                <button type="button" className="st-btn st-btn-primary" onClick={handleSaveHybrid}>保存混合路由</button>
              </div>
            </div>
          </>
        )}

        {domain === 'tools' && (
          <>
            <div className="st-card">
              <h3>安全护栏与命令审批档位（控制是否弹窗拦截授权）</h3>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                说明：<strong>安全护栏</strong>决定命令/删文件是否弹窗确认（与下方进程沙箱隔离相互独立）；若不想每次执行命令都被拦，把 <code>run_command</code> / <code>run_powershell</code> 设为 <code>off（自动放行）</code> 即可。
              </div>
              <div className="st-row">
                {[
                  ['run_command', '执行命令'],
                  ['run_powershell', 'PowerShell'],
                  ['delete_path', '删除文件'],
                  ['browser_click', '网页点击'],
                  ['software_call', '外部软件'],
                ].map(([opKey, lbl]) => (
                  <label key={opKey} style={{ fontSize: 12 }}>
                    {lbl}：
                    <select
                      className="st-btn"
                      aria-label={`护栏档位-${opKey}`}
                      value={guardTiersDraft[opKey] || (opKey === 'run_command' || opKey === 'run_powershell' ? 'off' : 'session')}
                      onChange={(e) => setGuardTiersDraft({ ...guardTiersDraft, [opKey]: e.target.value })}
                    >
                      <option value="off">off（自动放行）</option>
                      <option value="session">session（每会话确认一次）</option>
                      <option value="always">always（每次确认）</option>
                    </select>
                  </label>
                ))}
              </div>
              <div className="st-row">
                <button type="button" className="st-btn st-btn-primary" onClick={() => handleSaveGuardTiers()}>保存护栏档位</button>
                <button
                  type="button"
                  className="st-btn"
                  onClick={() => handleSaveGuardTiers({ ...guardTiersDraft, run_command: 'off', run_powershell: 'off' })}
                >
                  一键关闭命令拦截（自动放行）
                </button>
              </div>
            </div>

            <div className="st-card">
              <h3>沙箱与工作区路径隔离总开关（关闭后解除目录监狱与命令弹窗）</h3>
              <div className="st-row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                <label className="st-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={sandboxDraft.enabled !== false}
                    onChange={(e) => setSandboxDraft({ ...sandboxDraft, enabled: e.target.checked })} />
                  <span>启用沙箱与工作区目录隔离（取消勾选并保存 = 允许自由读写桌面/全盘用户文件与命令）</span>
                </label>
                <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  状态：{settings.sandboxStatus && settings.sandboxStatus.available ? '可用 (Job Object)' : '当前平台降级'}
                </span>
              </div>
              <div className="st-row">
                {['run_command', 'run_powershell', 'run_admin_command'].map((cls) => (
                  <label key={cls} style={{ fontSize: 12 }}>
                    {cls}：
                    <select className="st-btn" value={(sandboxDraft.command_profiles && sandboxDraft.command_profiles[cls]) || 'standard'}
                      onChange={(e) => setSandboxDraft({
                        ...sandboxDraft,
                        command_profiles: { ...(sandboxDraft.command_profiles || {}), [cls]: e.target.value },
                      })}>
                      <option value="off">off</option>
                      <option value="standard">standard</option>
                      <option value="strict">strict</option>
                    </select>
                  </label>
                ))}
                <button type="button" className="st-btn st-btn-primary" onClick={handleSaveSandbox}>保存沙箱档位</button>
              </div>
            </div>

            <div className="st-card">
              <h3>外部软件探测与调用</h3>
              <div className="st-row">
                <button type="button" className="st-btn st-btn-primary" disabled={swProbing} onClick={handleProbeSoftware}>
                  {swProbing ? '探测中…' : '🔍 扫描本机已安装外部软件'}
                </button>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>共 {(settings.softwareList || []).length} 项</span>
              </div>
              {(settings.softwareList || []).slice(0, 8).map((sw, i) => (
                <div key={i} className="st-mem-row">
                  <span>{sw.name || sw.id} · {sw.status || 'unknown'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-3)' }}>{sw.version || sw.path || ''}</span>
                </div>
              ))}
            </div>

            <div className="st-card">
              <h3>MCP 服务器管理</h3>
              <div className="st-row">
                <input className="st-input" style={{ width: 150 }} value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="服务名" />
                <input className="st-input" style={{ flex: 1 }} value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} placeholder="启动命令，如 npx -y @modelcontextprotocol/server-filesystem ." />
                <button type="button" className="st-btn st-btn-primary" onClick={async () => {
                  if (await saveMcpServerConfig(mcpName, mcpCmd)) { setMcpName(''); setMcpCmd('') }
                }}>添加</button>
              </div>
              {(settings.mcpServers || []).map((srv, idx) => {
                const name = typeof srv === 'string' ? srv : (srv.name || `mcp_${idx}`)
                return (
                  <div key={name} className="st-mem-row">
                    <span>{name}</span>
                    <div className="st-row">
                      <button type="button" className="st-btn" onClick={() => testMcpServerConfig(name)}>测试</button>
                      <button type="button" className="st-btn" onClick={() => deleteMcpServerConfig(name)}>删除</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {domain === 'memory' && (
          <>
            <div className="st-card">
              <h3>WebDAV 数据主权同步与加密备份</h3>
              <div className="st-row">
                <input className="st-input" style={{ flex: 2 }} value={webdavDraft.url || ''} onChange={(e) => setWebdavDraft({ ...webdavDraft, url: e.target.value })} placeholder="WebDAV 地址（https://...）" />
                <input className="st-input" style={{ flex: 1 }} value={webdavDraft.remote_path || ''} onChange={(e) => setWebdavDraft({ ...webdavDraft, remote_path: e.target.value })} placeholder="/harbor-backup" />
              </div>
              <div className="st-row">
                <input className="st-input" style={{ flex: 1 }} value={webdavDraft.username || ''} onChange={(e) => setWebdavDraft({ ...webdavDraft, username: e.target.value })} placeholder="用户名" />
                <input className="st-input" style={{ flex: 1 }} type="password" value={webdavDraft.password || ''} onChange={(e) => setWebdavDraft({ ...webdavDraft, password: e.target.value })} placeholder="密码（不回显，仅修改或测试时输入）" />
                <select className="st-btn" value={webdavDraft.conflict_policy || 'ask'} onChange={(e) => setWebdavDraft({ ...webdavDraft, conflict_policy: e.target.value })}>
                  <option value="ask">冲突询问</option>
                  <option value="local">本地优先</option>
                  <option value="remote">远端优先</option>
                </select>
              </div>
              <div className="st-row">
                <button type="button" className="st-btn" onClick={() => handleWebdav('test')}>测试连接</button>
                <button type="button" className="st-btn st-btn-primary" onClick={() => handleWebdav('export')}>立即备份上传</button>
                <button type="button" className="st-btn" onClick={() => handleWebdav('restore')}>从远端恢复</button>
              </div>
            </div>

            <div className="st-card">
              <h3>长期记忆库（共 {(settings.memories || []).length} 条）</h3>
              <div className="st-row">
                <input className="st-input" style={{ flex: 1 }} value={newMem} onChange={(e) => setNewMem(e.target.value)} placeholder="输入一句偏好或项目规则…" />
                <button type="button" className="st-btn st-btn-primary" onClick={async () => {
                  if (await addLongTermMemory(newMem)) setNewMem('')
                }}>添加记忆</button>
              </div>
              {(settings.memories || []).map((m, idx) => (
                <div key={idx} className="st-mem-row">
                  <span>[{m.kind || 'fact'}] {m.text}</span>
                  <button type="button" className="st-btn" onClick={() => deleteLongTermMemory(idx)}>删除</button>
                </div>
              ))}
            </div>
          </>
        )}

        {domain === 'optics' && (
          <>
            <div className="st-card">
              <h3>真窗外实时透色与四幕大动画强度</h3>
              <div className="st-field">
                <label>窗外材质（Electron 原生硬件合成，零假桌面壁纸）</label>
                <div className="st-row">
                  {[['acrylic', 'Acrylic（实时透窗外窗口与桌面）'], ['mica', 'Mica（柔和桌面色调）'], ['none', '纯实色']].map(([m, label]) => (
                    <button key={m} type="button" className="st-btn" data-active={String(settings.backdrop === m)}
                      onClick={() => updateVisualSettings({ backdrop: m })}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="st-field">
                <label>主舞台通透度：{Math.round(settings.opacity * 100)}%</label>
                <input type="range" min="22" max="90" value={Math.round(settings.opacity * 100)}
                  onChange={(e) => updateVisualSettings({ opacity: Number(e.target.value) / 100 })} />
              </div>
              <div className="st-field">
                <label>明暗主题 & 动效档位</label>
                <div className="st-row">
                  {[['dark', '深色玻璃'], ['light', '浅色暖玻璃']].map(([t, label]) => (
                    <button key={t} type="button" className="st-btn" data-active={String(settings.theme === t)}
                      onClick={() => updateVisualSettings({ theme: t })}>{label}</button>
                  ))}
                  {[['dynamic', '灵动四幕 (1.0×)'], ['balanced', '轻盈平衡 (0.58×)'], ['reduced', '静息无障碍 (0×)']].map(([mo, label]) => (
                    <button key={mo} type="button" className="st-btn" data-active={String(settings.motion === mo)}
                      onClick={() => updateVisualSettings({ motion: mo })}>{label}</button>
                  ))}
                  <button type="button" className="st-btn st-btn-primary" onClick={() => fireShellImpact('left', 'strong')}>
                    ⚡ 试一下物理撞击手感（5.5px + 弧形高光）
                  </button>
                </div>
              </div>
            </div>

            <div className="st-card">
              <h3>软件自动更新（HTTPS 清单 + SHA256 校验）</h3>
              <div className="st-row">
                <input className="st-input" style={{ flex: 1 }} value={draft.update_manifest_url || ''}
                  onChange={(e) => setDraft({ ...draft, update_manifest_url: e.target.value })}
                  placeholder="可选：自定义更新清单 URL（https://.../manifest.json）" />
                <button type="button" className="st-btn" onClick={() => checkAppUpdate(true)}>检查更新</button>
              </div>
              {runtime.updateInfo && (
                <div className="st-row">
                  <span style={{ color: 'var(--ok)', fontSize: 12.5 }}>新版本 v{runtime.updateInfo.latest} 可用</span>
                  <button type="button" className="st-btn st-btn-primary" onClick={handleDownloadUpdate}>下载更新包</button>
                  <button type="button" className="st-btn" onClick={() => applyAppUpdate()}>立即安装重启</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
