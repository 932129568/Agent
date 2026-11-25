import { useEffect, useState } from 'react'
import {
  COMPANION_BODY_FORMS,
  COMPANION_HAIRSTYLES,
  COMPANION_HAIR_COLORS,
  COMPANION_EYE_STYLES,
  COMPANION_EYE_COLORS,
  COMPANION_HEADGEARS,
  COMPANION_OUTFITS,
  COMPANION_ACCESSORIES,
  COMPANION_SKINS,
  COMPANION_PERSONALITIES,
  COMPANION_PRESETS,
} from '../../services/companionCatalog.js'
import Companion3DCanvas from '../../ui/Companion3DCanvas.jsx'
import ModelPicker from '../../ui/ModelPicker.jsx'
import './CompanionCustomizer.css'

export default function CompanionCustomizer({
  open,
  initialTab = 'avatar',
  avatar,
  config,
  savedModels = [],
  defaultModel = 'glm-4.5-flash',
  onUpdateAvatar,
  onUpdateConfig,
  onClose,
}) {
  const [tab, setTab] = useState(initialTab)
  const [previewPose, setPreviewPose] = useState('idle')

  useEffect(() => {
    if (open) setTab(initialTab || 'avatar')
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => globalThis.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const isWhaleForm = avatar.bodyForm === 'dafeiyu' || avatar.bodyForm === 'liquid_cat'

  return (
    <div className="cc-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="3D 助手形象工坊与无人驾驶大脑设置"
        data-section="companion-customizer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cc-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="cc-title">🐳 大肥鱼 & 二次元全能助手 · 形象工坊与总管大脑</span>
            <div className="cc-tabs">
              <button type="button" className="cc-btn" data-active={String(tab === 'avatar')} onClick={() => setTab('avatar')}>🎨 形态与捏脸换装</button>
              <button type="button" className="cc-btn" data-active={String(tab === 'llm')} onClick={() => setTab('llm')}>🧠 无人驾驶与专属大模型</button>
            </div>
          </div>
          <button type="button" className="cc-btn" onClick={onClose} aria-label="关闭捏脸工坊">×</button>
        </div>

        <div className="cc-body">
          <aside className="cc-stage">
            <div className="cc-stage-card">
              <Companion3DCanvas avatar={avatar} actionState={previewPose} size={208} spinPreview={previewPose === 'idle'} />
            </div>
            <strong style={{ fontSize: 15, color: 'var(--text)' }}>{avatar.name || '大肥鱼'}</strong>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>实时赛璐璐立体渲染 · 动作预览</span>
            <div className="cc-pose-row">
              {[
                ['idle', '待机'],
                ['grabbed', '被拎起'],
                ['pat', '摸摸头'],
                ['dance', '转圈舞'],
                ['eat_snack', '吃零食'],
                ['supervising', '监工中'],
                ['deliver', '交稿啦'],
                ['magic_blackhole', '黑洞'],
                ['sleep', '打盹'],
              ].map(([id, lbl]) => (
                <button
                  key={id}
                  type="button"
                  className="cc-btn"
                  style={{ padding: '3px 9px', fontSize: 11 }}
                  data-active={String(previewPose === id)}
                  onClick={() => setPreviewPose(id)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </aside>

          <div className="cc-controls">
            {tab === 'avatar' ? (
              <>
                <div className="cc-group">
                  <span className="cc-label">一键套用热门旗舰造型（含经典大肥鱼 & 鲸鱼娘）</span>
                  <div className="cc-chips">
                    {COMPANION_PRESETS.map((p) => (
                      <button key={p.id} type="button" className="cc-btn" onClick={() => onUpdateAvatar({ ...p.avatar })}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">选择核心建模形态（4 大精绘模型）</span>
                  <div className="cc-form-grid">
                    {COMPANION_BODY_FORMS.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className="cc-form-card"
                        data-active={String((avatar.bodyForm || 'dafeiyu') === f.id)}
                        onClick={() => onUpdateAvatar({ bodyForm: f.id })}
                      >
                        <strong>{f.label}</strong>
                        <span>{f.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">助手昵称与体型缩放 ({Math.round((avatar.scale || 1) * 100)}%)</span>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input
                      className="cc-input"
                      style={{ maxWidth: 210 }}
                      value={avatar.name || ''}
                      onChange={(e) => onUpdateAvatar({ name: e.target.value.slice(0, 12) })}
                      placeholder="起个喜欢的名字"
                    />
                    <input
                      type="range"
                      min="80"
                      max="130"
                      value={Math.round((avatar.scale || 1) * 100)}
                      onChange={(e) => onUpdateAvatar({ scale: Number(e.target.value) / 100 })}
                    />
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">{isWhaleForm ? '主色调与瓷感涂装（8 色）' : '发色与光泽（8 色）'}</span>
                  <div className="cc-chips">
                    {COMPANION_HAIR_COLORS.map((c) => (
                      <button key={c.id} type="button" className="cc-btn" data-active={String(avatar.hairColor === c.id)} onClick={() => onUpdateAvatar({ hairColor: c.id })}>
                        <span className="cc-swatch" style={{ background: c.hex }} />
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                {!isWhaleForm && (
                  <div className="cc-group">
                    <span className="cc-label">发型（{COMPANION_HAIRSTYLES.length} 款）</span>
                    <div className="cc-chips">
                      {COMPANION_HAIRSTYLES.map((h) => (
                        <button key={h.id} type="button" className="cc-btn" data-active={String(avatar.hairStyle === h.id)} onClick={() => onUpdateAvatar({ hairStyle: h.id })}>
                          {h.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="cc-group">
                  <span className="cc-label">眼型与宝石瞳色（含异色双瞳）</span>
                  <div className="cc-chips">
                    {COMPANION_EYE_STYLES.map((e) => (
                      <button key={e.id} type="button" className="cc-btn" data-active={String(avatar.eyeStyle === e.id)} onClick={() => onUpdateAvatar({ eyeStyle: e.id })}>
                        {e.label}
                      </button>
                    ))}
                  </div>
                  <div className="cc-chips">
                    {COMPANION_EYE_COLORS.map((c) => (
                      <button key={c.id} type="button" className="cc-btn" data-active={String(avatar.eyeColor === c.id)} onClick={() => onUpdateAvatar({ eyeColor: c.id })}>
                        <span className="cc-swatch" style={{ background: c.rightHex ? `linear-gradient(90deg, ${c.hex} 50%, ${c.rightHex} 50%)` : c.hex }} />
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">头饰 / 喷水浪花 / 兽耳（{COMPANION_HEADGEARS.length} 款）</span>
                  <div className="cc-chips">
                    {COMPANION_HEADGEARS.map((g) => (
                      <button key={g.id} type="button" className="cc-btn" data-active={String(avatar.headgear === g.id)} onClick={() => onUpdateAvatar({ headgear: g.id })}>
                        {g.label}
                      </button>
                    ))}
                  </div>
                </div>

                {!isWhaleForm && (
                  <div className="cc-group">
                    <span className="cc-label">服装与肤色</span>
                    <div className="cc-chips">
                      {COMPANION_OUTFITS.map((o) => (
                        <button key={o.id} type="button" className="cc-btn" data-active={String(avatar.outfit === o.id)} onClick={() => onUpdateAvatar({ outfit: o.id })}>
                          <span className="cc-swatch" style={{ background: o.primary }} />
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <div className="cc-chips">
                      {COMPANION_SKINS.map((s) => (
                        <button key={s.id} type="button" className="cc-btn" data-active={String(avatar.skin === s.id)} onClick={() => onUpdateAvatar({ skin: s.id })}>
                          <span className="cc-swatch" style={{ background: s.hex }} />
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="cc-group">
                  <span className="cc-label">随身配饰 & 性格人设</span>
                  <div className="cc-chips">
                    {COMPANION_ACCESSORIES.map((a) => (
                      <button key={a.id} type="button" className="cc-btn" data-active={String(avatar.accessory === a.id)} onClick={() => onUpdateAvatar({ accessory: a.id })}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <div className="cc-chips">
                    {COMPANION_PERSONALITIES.map((p) => (
                      <button key={p.id} type="button" className="cc-btn" data-active={String(avatar.personality === p.id)} onClick={() => onUpdateAvatar({ personality: p.id })}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="cc-switch-card">
                  <div>
                    <strong style={{ fontSize: 13 }}>🤖 全自动无人驾驶接管（推荐开启）</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      把任何真实需求发给助手，它会自动判断该用「智能对话+专家+Skill / 12支原生专家团 / 工作流 DAG / 多角色群聊 / 双模协同」，亲自操作运行并监工验收交稿。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cc-btn"
                    data-active={String(config.autopilotEnabled !== false)}
                    onClick={() => onUpdateConfig({ autopilotEnabled: config.autopilotEnabled === false })}
                  >
                    {config.autopilotEnabled !== false ? '已开启' : '已关闭'}
                  </button>
                </div>

                <div className="cc-switch-card">
                  <div>
                    <strong style={{ fontSize: 13 }}>🧠 启用大模型（仅用于拟人闲聊与可选路由增强）</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      默认本地优先零 Token 消耗；开启后支持与大肥鱼自由畅聊，并增强复杂任务的路线判断。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cc-btn"
                    data-active={String(Boolean(config.llmEnabled))}
                    onClick={() => onUpdateConfig({ llmEnabled: !config.llmEnabled, ...(!config.llmEnabled ? {} : { fullLlmDrive: false }) })}
                  >
                    {config.llmEnabled ? '已开启' : '已关闭'}
                  </button>
                </div>

                <div className="cc-switch-card">
                  <div>
                    <strong style={{ fontSize: 13 }}>⚡ 完全使用大模型驱动</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      开启后所有动作决策、对话、自主路由均由助手专属大模型全面接管（会消耗所选模型 Token）。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cc-btn"
                    data-active={String(Boolean(config.fullLlmDrive))}
                    onClick={() => onUpdateConfig({ fullLlmDrive: !config.fullLlmDrive, ...(!config.fullLlmDrive ? { llmEnabled: true } : {}) })}
                  >
                    {config.fullLlmDrive ? '完全接管中' : '本地优先'}
                  </button>
                </div>

                <div className="cc-group">
                  <span className="cc-label">绑定助手专属已保存模型（完全独立于主聊天模型）</span>
                  <ModelPicker
                    direction="down"
                    align="left"
                    ariaLabel="选择助手专属保存模型"
                    value={config.modelProfileId || ''}
                    defaultModel={`跟随主配置 (${defaultModel})`}
                    models={savedModels}
                    onChange={(id) => onUpdateConfig({ modelProfileId: id })}
                  />
                </div>

                <div className="cc-group">
                  <span className="cc-label">或为助手单独填写独立 API 端点 / 模型 / Key（留空继承上方）</span>
                  <input className="cc-input" value={config.customBaseUrl || ''} onChange={(e) => onUpdateConfig({ customBaseUrl: e.target.value })} placeholder="独立 Base URL（如 https://api.deepseek.com/v1）" />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="cc-input" value={config.customModel || ''} onChange={(e) => onUpdateConfig({ customModel: e.target.value })} placeholder="独立模型 ID（如 deepseek-chat）" />
                    <input className="cc-input" type="password" value={config.customApiKey || ''} onChange={(e) => onUpdateConfig({ customApiKey: e.target.value })} placeholder="独立 API Key" />
                  </div>
                </div>

                <div className="cc-switch-card">
                  <div>
                    <strong style={{ fontSize: 13 }}>🍪 趣味互动：偷啃液态玻璃 & 主动拾碎片修补</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      饱食度低时偶尔溜过去啃一口玻璃（投喂小鱼干可安抚）；甩碎玻璃后会自动跑去拾碎片修补。
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="cc-btn" data-active={String(config.sneakEatEnabled !== false)} onClick={() => onUpdateConfig({ sneakEatEnabled: config.sneakEatEnabled === false })}>
                      {config.sneakEatEnabled !== false ? '偷啃:开' : '偷啃:关'}
                    </button>
                    <button type="button" className="cc-btn" data-active={String(config.autoRepairShattered !== false)} onClick={() => onUpdateConfig({ autoRepairShattered: config.autoRepairShattered === false })}>
                      {config.autoRepairShattered !== false ? '自动修碎:开' : '自动修碎:关'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
