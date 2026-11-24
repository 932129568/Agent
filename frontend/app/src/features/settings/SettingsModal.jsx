import { useEffect, useState } from 'react'
import {
  useSlice,
  updateVisualSettings,
  saveBackendConfig,
  refreshSettingsAux,
  checkAppUpdate,
  pushToast,
} from '../../state/store.js'
import * as api from '../../services/bridge.js'
import { assertLatin1Value } from '../../services/headers.js'
import './SettingsModal.css'

const DOMAINS = [
  { id: 'model', label: '模型、混合路由与推理', keywords: '模型 api key base url 本地 ollama 混合 hybrid reader 预算' },
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
  const [webdavDraft, setWebdavDraft] = useState(() => ({ ...settings.webdavConfig }))
  const [errMsg, setErrMsg] = useState('')
  const [probeRes, setProbeRes] = useState('')
  const [newMem, setNewMem] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpCmd, setMcpCmd] = useState('')
  const [swProbing, setSwProbing] = useState(false)

  useEffect(() => { setDraft({ ...settings.backendConfig }) }, [settings.backendConfig])
  useEffect(() => { setHybridDraft({ ...settings.hybridConfig }) }, [settings.hybridConfig])
  useEffect(() => { setSandboxDraft({ ...settings.sandboxConfig }) }, [settings.sandboxConfig])
  useEffect(() => { setWebdavDraft((prev) => ({ ...settings.webdavConfig, password: prev.password || '' })) }, [settings.webdavConfig])
  useEffect(() => { refreshSettingsAux().catch(() => {}) }, [])

  const visibleDomains = DOMAINS.filter((d) => {
    const q = search.trim().toLowerCase()
    return !q || d.label.toLowerCase().includes(q) || d.keywords.includes(q)
  })

  const handleSaveModel = async (alsoTest) => {
    try {
      assertLatin1Value('API Key', draft.api_key || '')
      assertLatin1Value('Base URL', draft.provider_base || '')
      if (draft.local_base_url) assertLatin1Value('本地端点 URL', draft.local_base_url)
      setErrMsg('')
      await saveBackendConfig(draft)
      if (alsoTest) {
        const res = await api.testProviderEndpoint(
          draft.local_mode ? draft.local_base_url : draft.provider_base,
          draft.api_key || '',
          draft.local_mode ? draft.local_model : draft.model,
          15,
          !!draft.local_mode
        )
        if (res && res.ok) pushToast('端点连接测试成功', 'ok')
        else pushToast(`连接测试失败：${(res && (res.error || res.message)) || '请检查地址与 Key'}`, 'err')
      }
    } catch (e) {
      setErrMsg(e.message)
      pushToast(e.message, 'err')
    }
  }

  const handleProbeLocal = async () => {
    try {
      const r = await api.localProbe([])
      const hits = (r && Array.isArray(r.reachable)) ? r.reachable : []
      setProbeRes(hits.length ? hits.map((x) => `${x.kind}(${x.base_url}) 模型: ${(x.models || []).join(',')}`).join(' | ') : '未探测到本机运行的 Ollama / LMStudio / vLLM 端点')
    } catch (e) {
      setProbeRes(`探测失败：${e.message}`)
    }
  }

  const handleSaveHybrid = async () => {
    try {
      await api.hybridSaveConfig(hybridDraft)
      await refreshSettingsAux()
      pushToast('云+本地混合路由策略已保存', 'ok')
    } catch (e) { pushToast(e.message, 'err') }
  }

  const handleSaveSandbox = async () => {
    try {
      await api.sandboxSaveConfig(sandboxDraft)
      await refreshSettingsAux()
      pushToast('命令沙箱配置已保存', 'ok')
    } catch (e) { pushToast(e.message, 'err') }
  }

  const handleProbeSoftware = async () => {
    setSwProbing(true)
    try {
      await api.softwareProbe('')
      await refreshSettingsAux()
      pushToast('外部软件探测完成', 'ok')
    } catch (e) { pushToast(e.message, 'err') }
    finally { setSwProbing(false) }
  }

  const handleWebdav = async (act) => {
    try {
      await api.webdavSaveConfig(webdavDraft)
      if (act === 'test') {
        const r = await api.webdavTest(webdavDraft)
        pushToast(r && r.ok ? 'WebDAV 连接测试通过' : `测试失败：${(r && r.error) || ''}`, r && r.ok ? 'ok' : 'err')
      } else if (act === 'export') {
        const r = await api.webdavExport()
        pushToast(r && r.ok ? '已加密同步导出至 WebDAV' : `导出失败：${(r && r.error) || ''}`, r && r.ok ? 'ok' : 'err')
      } else if (act === 'restore') {
        const r = await api.webdavRestore({ conflict_policy: webdavDraft.conflict_policy || 'ask' })
        pushToast(r && r.ok ? '已从 WebDAV 恢复数据' : `恢复结果：${(r && (r.error || r.status)) || ''}`, r && r.ok ? 'ok' : 'info')
      }
    } catch (e) { pushToast(e.message, 'err') }
  }

  const handleDownloadUpdate = async () => {
    const u = runtime.updateInfo
    if (!u || !u.url) return
    try {
      await api.startUpdateDownload(u.url, u.sha256 || '', u.latest || '')
      pushToast('已启动后台更新下载（SHA256 校验）', 'ok')
    } catch (e) { pushToast(e.message, 'err') }
  }

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
            <div className="st-card">
              <h3>云端 / OpenAI 兼容端点与会话预算</h3>
              <div className="st-field">
                <label>Base URL</label>
                <input className="st-input" value={draft.provider_base || ''} onChange={(e) => setDraft({ ...draft, provider_base: e.target.value })} />
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
              <h3>命令沙箱（Windows Job Object 进程隔离）</h3>
              <div className="st-row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                <label className="st-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={sandboxDraft.enabled !== false}
                    onChange={(e) => setSandboxDraft({ ...sandboxDraft, enabled: e.target.checked })} />
                  <span>启用命令执行沙箱隔离</span>
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
                  if (!mcpName.trim() || !mcpCmd.trim()) return
                  const parts = mcpCmd.trim().split(/\s+/)
                  await api.mcpSaveServer(mcpName.trim(), { command: parts[0], args: parts.slice(1), enabled: true })
                  setMcpName(''); setMcpCmd(''); await refreshSettingsAux(); pushToast('MCP 已保存', 'ok')
                }}>添加</button>
              </div>
              {(settings.mcpServers || []).map((srv, idx) => {
                const name = typeof srv === 'string' ? srv : (srv.name || `mcp_${idx}`)
                return (
                  <div key={name} className="st-mem-row">
                    <span>{name}</span>
                    <div className="st-row">
                      <button type="button" className="st-btn" onClick={async () => { const r = await api.mcpTestServer(name); pushToast(r && r.ok ? `${name} 测试通过` : '测试失败', r && r.ok ? 'ok' : 'err') }}>测试</button>
                      <button type="button" className="st-btn" onClick={async () => { await api.mcpDeleteServer(name); await refreshSettingsAux() }}>删除</button>
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
                  if (!newMem.trim()) return
                  await api.appendMemory({ text: newMem.trim(), distill: true })
                  setNewMem(''); await refreshSettingsAux(); pushToast('已写入长期记忆', 'ok')
                }}>添加记忆</button>
              </div>
              {(settings.memories || []).map((m, idx) => (
                <div key={idx} className="st-mem-row">
                  <span>[{m.kind || 'fact'}] {m.text}</span>
                  <button type="button" className="st-btn" onClick={async () => { await api.memoryDelete(idx); await refreshSettingsAux() }}>删除</button>
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
                <input type="range" min="32" max="94" value={Math.round(settings.opacity * 100)}
                  onChange={(e) => updateVisualSettings({ opacity: Number(e.target.value) / 100 })} />
              </div>
              <div className="st-field">
                <label>明暗主题 & 动效档位</label>
                <div className="st-row">
                  {[['dark', '深色玻璃'], ['light', '浅色暖玻璃']].map(([t, label]) => (
                    <button key={t} type="button" className="st-btn" data-active={String(settings.theme === t)}
                      onClick={() => updateVisualSettings({ theme: t })}>{label}</button>
                  ))}
                  {[['dynamic', '灵动四幕 (1.0×)'], ['balanced', '轻盈平衡 (0.55×)'], ['reduced', '静息无障碍 (0×)']].map(([mo, label]) => (
                    <button key={mo} type="button" className="st-btn" data-active={String(settings.motion === mo)}
                      onClick={() => updateVisualSettings({ motion: mo })}>{label}</button>
                  ))}
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
                  <button type="button" className="st-btn" onClick={async () => { await api.applyUpdate(); pushToast('正在应用更新…', 'info') }}>立即安装重启</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
