import { useEffect, useState } from 'react'
import {
  COMPANION_MODEL_PACKS,
  YALU_PROP_LOADOUTS,
  YALU_AURA_THEMES,
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
  getActiveModelPack,
} from '../../services/companionCatalog.js'
import YaluModelStage from '../../ui/YaluModelStage.jsx'
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
  const [viewAngle, setViewAngle] = useState('auto') // 'auto' | 'front' | 'side' | 'back' | 'video'

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

  const isYaluModel = (avatar.bodyForm || 'yalu_model') === 'yalu_model'
  const pack = getActiveModelPack(avatar.modelPackId)
  const packAssets = {
    front: pack.assets.front,
    turnFront: pack.assets.turnFront,
    side: pack.assets.side,
    back: pack.assets.back,
    staff: pack.assets.props.staff.src,
    bell: pack.assets.props.bell.src,
    showcaseVideo: pack.assets.showcaseVideo,
  }

  return (
    <div className="cc-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="芽露原版建模工坊与无人驾驶大脑设置"
        data-section="companion-customizer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cc-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="cc-title">🌿 芽露 · 原版建模工坊与全自动总管大脑</span>
            <div className="cc-tabs">
              <button type="button" className="cc-btn" data-active={String(tab === 'avatar')} onClick={() => setTab('avatar')}>🎨 建模视图与道具工坊</button>
              <button type="button" className="cc-btn" data-active={String(tab === 'llm')} onClick={() => setTab('llm')}>🧠 无人驾驶与专属大模型</button>
            </div>
          </div>
          <button type="button" className="cc-btn" onClick={onClose} aria-label="关闭捏脸工坊">×</button>
        </div>

        <div className="cc-body">
          <aside className="cc-stage">
            <div className="cc-stage-card" style={{ padding: viewAngle === 'video' ? 4 : 8 }}>
              {isYaluModel ? (
                <YaluModelStage
                  assets={packAssets}
                  actionState={previewPose}
                  propLoadout={avatar.propLoadout || 'both'}
                  auraTheme={avatar.auraTheme || 'natural'}
                  viewAngle={viewAngle}
                  scale={1}
                  width={212}
                  height={212}
                />
              ) : (
                <Companion3DCanvas avatar={avatar} actionState={previewPose} size={208} spinPreview={previewPose === 'idle'} />
              )}
            </div>
            <strong style={{ fontSize: 15, color: 'var(--text)' }}>{avatar.name || '芽露'}</strong>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
              {isYaluModel ? '原版建模三视图 · 双道具 · 60fps 成片' : '备用 3D 皮肤实时预览'}
            </span>

            {isYaluModel && (
              <div className="cc-pose-row" aria-label="三视图与 60fps 成片切换">
                {[
                  ['auto', '自动'],
                  ['front', '正面'],
                  ['side', '侧面'],
                  ['back', '背面'],
                  ['video', '🎬 60fps成片'],
                ].map(([vid, lbl]) => (
                  <button
                    key={vid}
                    type="button"
                    className="cc-btn"
                    style={{ padding: '3px 9px', fontSize: 11 }}
                    data-active={String(viewAngle === vid)}
                    onClick={() => setViewAngle(vid)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            )}

            <div className="cc-pose-row">
              {[
                ['idle', '待机'],
                ['run', '侧身小跑'],
                ['grabbed', '被拎起'],
                ['supervising', '挥杖监工'],
                ['deliver', '摇铃交稿'],
                ['magic_blackhole', '黑洞'],
                ['dance', '转圈'],
              ].map(([id, lbl]) => (
                <button
                  key={id}
                  type="button"
                  className="cc-btn"
                  style={{ padding: '3px 9px', fontSize: 11 }}
                  data-active={String(previewPose === id)}
                  onClick={() => { setViewAngle('auto'); setPreviewPose(id) }}
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
                  <span className="cc-label">已载入官方建模包（后续新建模包均在此架构扩展）</span>
                  <div className="cc-form-grid">
                    {COMPANION_MODEL_PACKS.map((mp) => (
                      <button
                        key={mp.id}
                        type="button"
                        className="cc-form-card"
                        data-active={String(isYaluModel && (avatar.modelPackId || 'yalu_official') === mp.id)}
                        onClick={() => onUpdateAvatar({ bodyForm: 'yalu_model', modelPackId: mp.id, name: '芽露' })}
                      >
                        <strong>{mp.name}</strong>
                        <span>{mp.tagline}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">一键套用预设造型</span>
                  <div className="cc-chips">
                    {COMPANION_PRESETS.map((p) => (
                      <button key={p.id} type="button" className="cc-btn" onClick={() => onUpdateAvatar({ ...p.avatar })}>
                        {p.name}
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
                      placeholder="芽露"
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

                {isYaluModel ? (
                  <>
                    <div className="cc-group">
                      <span className="cc-label">原版专属道具装配（露芽杖 & 酒红铃铛）</span>
                      <div className="cc-chips">
                        {YALU_PROP_LOADOUTS.map((pl) => (
                          <button
                            key={pl.id}
                            type="button"
                            className="cc-btn"
                            data-active={String((avatar.propLoadout || 'both') === pl.id)}
                            onClick={() => onUpdateAvatar({ propLoadout: pl.id })}
                          >
                            {pl.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="cc-group">
                      <span className="cc-label">原版 4 组表情差分（实时联动聊天头像与心情）</span>
                      <div className="cc-expr-grid">
                        {pack.assets.expressions.map((ex) => (
                          <button
                            key={ex.id}
                            type="button"
                            className="cc-expr-card"
                            data-active={String((avatar.expressionOverride || 'auto') === ex.id)}
                            onClick={() => onUpdateAvatar({ expressionOverride: avatar.expressionOverride === ex.id ? 'auto' : ex.id })}
                          >
                            <img src={ex.src} alt={ex.label} />
                            <span>{ex.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="cc-group">
                      <span className="cc-label">光晕氛围色调</span>
                      <div className="cc-chips">
                        {YALU_AURA_THEMES.map((au) => (
                          <button
                            key={au.id}
                            type="button"
                            className="cc-btn"
                            data-active={String((avatar.auraTheme || 'natural') === au.id)}
                            onClick={() => onUpdateAvatar({ auraTheme: au.id })}
                          >
                            <span className="cc-swatch" style={{ background: au.glow }} />
                            {au.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cc-group">
                      <span className="cc-label">备用皮肤细节（发色 / 发型 / 眼型 / 头饰 / 服装）</span>
                      <div className="cc-chips">
                        {COMPANION_HAIR_COLORS.map((c) => (
                          <button key={c.id} type="button" className="cc-btn" data-active={String(avatar.hairColor === c.id)} onClick={() => onUpdateAvatar({ hairColor: c.id })}>
                            <span className="cc-swatch" style={{ background: c.hex }} />{c.label}
                          </button>
                        ))}
                      </div>
                      <div className="cc-chips">
                        {COMPANION_HAIRSTYLES.map((h) => (
                          <button key={h.id} type="button" className="cc-btn" data-active={String(avatar.hairStyle === h.id)} onClick={() => onUpdateAvatar({ hairStyle: h.id })}>{h.label}</button>
                        ))}
                      </div>
                      <div className="cc-chips">
                        {COMPANION_EYE_STYLES.map((e) => (
                          <button key={e.id} type="button" className="cc-btn" data-active={String(avatar.eyeStyle === e.id)} onClick={() => onUpdateAvatar({ eyeStyle: e.id })}>{e.label}</button>
                        ))}
                        {COMPANION_EYE_COLORS.map((c) => (
                          <button key={c.id} type="button" className="cc-btn" data-active={String(avatar.eyeColor === c.id)} onClick={() => onUpdateAvatar({ eyeColor: c.id })}>
                            <span className="cc-swatch" style={{ background: c.hex }} />{c.label}
                          </button>
                        ))}
                      </div>
                      <div className="cc-chips">
                        {COMPANION_HEADGEARS.map((g) => (
                          <button key={g.id} type="button" className="cc-btn" data-active={String(avatar.headgear === g.id)} onClick={() => onUpdateAvatar({ headgear: g.id })}>{g.label}</button>
                        ))}
                        {COMPANION_OUTFITS.map((o) => (
                          <button key={o.id} type="button" className="cc-btn" data-active={String(avatar.outfit === o.id)} onClick={() => onUpdateAvatar({ outfit: o.id })}>{o.label}</button>
                        ))}
                        {COMPANION_SKINS.map((s) => (
                          <button key={s.id} type="button" className="cc-btn" data-active={String(avatar.skin === s.id)} onClick={() => onUpdateAvatar({ skin: s.id })}>{s.label}</button>
                        ))}
                        {COMPANION_ACCESSORIES.map((a) => (
                          <button key={a.id} type="button" className="cc-btn" data-active={String(avatar.accessory === a.id)} onClick={() => onUpdateAvatar({ accessory: a.id })}>{a.label}</button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div className="cc-group">
                  <span className="cc-label">切换形态 / 性格声线</span>
                  <div className="cc-chips">
                    {COMPANION_BODY_FORMS.map((f) => (
                      <button key={f.id} type="button" className="cc-btn" data-active={String((avatar.bodyForm || 'yalu_model') === f.id)} onClick={() => onUpdateAvatar({ bodyForm: f.id })}>
                        {f.label}
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
                      把任何真实需求发给芽露，她会自动挑选「智能对话+专家+Skill / 12支原生专家团 / 工作流 DAG / 多角色群聊 / 双模协同」，自动切到对应页面运行并实时监工交稿。
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
                    <strong style={{ fontSize: 13 }}>🧠 启用大模型（拟人闲聊与路由增强）</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      默认本地优先零 Token 消耗；开启后支持与芽露自由畅聊，并增强复杂任务的路线判断。
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
                      开启后所有动作决策、对话、自主路由均由助手专属大模型全面接管。
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
                      饱食度低时偶尔溜过去啃一口玻璃；甩碎玻璃后会自动跑去拾碎片修补。
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
