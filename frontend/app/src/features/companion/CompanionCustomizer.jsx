import { useState } from 'react'
import {
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
  initialTab = 'avatar', // 'avatar' | 'llm'
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

  if (!open) return null

  return (
    <div className="cc-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="cc-modal" role="dialog" aria-modal="true" aria-label="3D 助手捏脸与专属大模型设置" data-section="companion-customizer">
        <div className="cc-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="cc-title">🐾 3D 二次元娱乐协助助手 · 捏脸工坊与大脑配置</span>
            <div className="cc-tabs">
              <button type="button" className="cc-btn" data-active={String(tab === 'avatar')} onClick={() => setTab('avatar')}>🎨 3D 捏脸换装</button>
              <button type="button" className="cc-btn" data-active={String(tab === 'llm')} onClick={() => setTab('llm')}>🧠 专属大模型与驱动开关</button>
            </div>
          </div>
          <button type="button" className="cc-btn" onClick={onClose} aria-label="关闭捏脸工坊">×</button>
        </div>

        <div className="cc-body">
          <aside className="cc-stage">
            <div className="cc-stage-card">
              <Companion3DCanvas avatar={avatar} actionState={previewPose} size={200} spinPreview={previewPose === 'idle'} />
            </div>
            <strong style={{ fontSize: 14, color: 'var(--text)' }}>{avatar.name || '米露'}</strong>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>实时 3D 立体渲染 · 动作预览</span>
            <div className="cc-pose-row">
              {[['idle', '待机'], ['run', '小跑'], ['crouch_click', '蹲点'], ['write_input', '手写'], ['magic_blackhole', '黑洞'], ['sneak_eat', '啃玻璃'], ['repair_glass', '修补']].map(([id, lbl]) => (
                <button key={id} type="button" className="cc-btn" style={{ padding: '3px 9px', fontSize: 11 }} data-active={String(previewPose === id)} onClick={() => setPreviewPose(id)}>
                  {lbl}
                </button>
              ))}
            </div>
          </aside>

          <div className="cc-controls">
            {tab === 'avatar' ? (
              <>
                <div className="cc-group">
                  <span className="cc-label">一键套用预设造型</span>
                  <div className="cc-chips">
                    {COMPANION_PRESETS.map((p) => (
                      <button key={p.id} type="button" className="cc-btn" onClick={() => onUpdateAvatar({ ...p.avatar })}>{p.name}</button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">助手昵称与体型缩放 ({Math.round((avatar.scale || 1) * 100)}%)</span>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input className="cc-input" style={{ maxWidth: 200 }} value={avatar.name || ''} onChange={(e) => onUpdateAvatar({ name: e.target.value })} placeholder="给助手起个名字" />
                    <input type="range" min="82" max="124" value={Math.round((avatar.scale || 1) * 100)} onChange={(e) => onUpdateAvatar({ scale: Number(e.target.value) / 100 })} />
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">发型（{COMPANION_HAIRSTYLES.length} 款）</span>
                  <div className="cc-chips">
                    {COMPANION_HAIRSTYLES.map((h) => (
                      <button key={h.id} type="button" className="cc-btn" data-active={String(avatar.hairstyle === h.id)} onClick={() => onUpdateAvatar({ hairstyle: h.id })}>{h.label}</button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">发色（{COMPANION_HAIR_COLORS.length} 色）</span>
                  <div className="cc-chips">
                    {COMPANION_HAIR_COLORS.map((c) => (
                      <button key={c.id} type="button" className="cc-btn" data-active={String(avatar.hairColor === c.id)} onClick={() => onUpdateAvatar({ hairColor: c.id })}>
                        <span className="cc-swatch" style={{ background: c.hex }} />{c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">眼型与瞳色（含异色双瞳）</span>
                  <div className="cc-chips">
                    {COMPANION_EYE_STYLES.map((e) => (
                      <button key={e.id} type="button" className="cc-btn" data-active={String(avatar.eyeStyle === e.id)} onClick={() => onUpdateAvatar({ eyeStyle: e.id })}>{e.label}</button>
                    ))}
                  </div>
                  <div className="cc-chips">
                    {COMPANION_EYE_COLORS.map((c) => (
                      <button key={c.id} type="button" className="cc-btn" data-active={String(avatar.eyeColor === c.id)} onClick={() => onUpdateAvatar({ eyeColor: c.id })}>
                        <span className="cc-swatch" style={{ background: c.rightHex ? `linear-gradient(90deg, ${c.hex} 50%, ${c.rightHex} 50%)` : c.hex }} />{c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">头饰 / 兽耳（{COMPANION_HEADGEARS.length} 款）</span>
                  <div className="cc-chips">
                    {COMPANION_HEADGEARS.map((g) => (
                      <button key={g.id} type="button" className="cc-btn" data-active={String(avatar.headgear === g.id)} onClick={() => onUpdateAvatar({ headgear: g.id })}>{g.label}</button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">服装风格（{COMPANION_OUTFITS.length} 套）</span>
                  <div className="cc-chips">
                    {COMPANION_OUTFITS.map((o) => (
                      <button key={o.id} type="button" className="cc-btn" data-active={String(avatar.outfit === o.id)} onClick={() => onUpdateAvatar({ outfit: o.id })}>
                        <span className="cc-swatch" style={{ background: o.primary }} />{o.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">随身配饰 & 肤色 & 性格</span>
                  <div className="cc-chips">
                    {COMPANION_ACCESSORIES.map((a) => (
                      <button key={a.id} type="button" className="cc-btn" data-active={String(avatar.accessory === a.id)} onClick={() => onUpdateAvatar({ accessory: a.id })}>{a.label}</button>
                    ))}
                  </div>
                  <div className="cc-chips">
                    {COMPANION_SKINS.map((s) => (
                      <button key={s.id} type="button" className="cc-btn" data-active={String(avatar.skin === s.id)} onClick={() => onUpdateAvatar({ skin: s.id })}>
                        <span className="cc-swatch" style={{ background: s.hex }} />{s.label}
                      </button>
                    ))}
                    {COMPANION_PERSONALITIES.map((p) => (
                      <button key={p.id} type="button" className="cc-btn" data-active={String(avatar.personality === p.id)} onClick={() => onUpdateAvatar({ personality: p.id })}>✦ {p.label}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="cc-group">
                  <span className="cc-label">驱动模式开关（也可直接右键 3D 助手随时切换）</span>
                  <div className="cc-chips">
                    <button type="button" className="cc-btn" data-active={String(Boolean(config.llmEnabled))} onClick={() => onUpdateConfig({ llmEnabled: !config.llmEnabled })}>
                      🧠 启用大模型闲聊：{config.llmEnabled ? '已开启' : '已关闭（省 Token）'}
                    </button>
                    <button type="button" className="cc-btn" data-active={String(Boolean(config.fullLlmDrive))} onClick={() => onUpdateConfig({ fullLlmDrive: !config.fullLlmDrive, ...(config.fullLlmDrive ? {} : { llmEnabled: true }) })}>
                      ⚡ 完全使用大模型驱动：{config.fullLlmDrive ? '已开启' : '已关闭（本地优先）'}
                    </button>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.55 }}>
                    • 关闭「完全大模型驱动」时：软件代操作（跑去点击 / 拿笔手写 / 黑洞取文件）、Harbor 深度功能教学与玻璃修补 100% 由本地引擎瞬间执行，零 Token 消耗；<br />
                    • 开启「完全大模型驱动」后：所有回复与软件动作指令均交由下方专属大模型自主接管。
                  </span>
                </div>

                <div className="cc-group">
                  <span className="cc-label">液态玻璃互动开关</span>
                  <div className="cc-chips">
                    <button type="button" className="cc-btn" data-active={String(config.sneakEatEnabled !== false)} onClick={() => onUpdateConfig({ sneakEatEnabled: config.sneakEatEnabled === false })}>
                      🍪 平时偷偷啃液态玻璃：{config.sneakEatEnabled !== false ? '开启' : '关闭'}
                    </button>
                    <button type="button" className="cc-btn" data-active={String(config.autoRepairShattered !== false)} onClick={() => onUpdateConfig({ autoRepairShattered: config.autoRepairShattered === false })}>
                      🛠 方块碎裂后被动拾碎片修补：{config.autoRepairShattered !== false ? '开启' : '关闭'}
                    </button>
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">助手专属大模型（独立于主聊天，支持选已保存模型或单独填端点）</span>
                  <ModelPicker
                    direction="down"
                    align="left"
                    ariaLabel="选择助手专属保存模型"
                    value={config.modelProfileId || ''}
                    defaultModel={`跟随全局 (${defaultModel})`}
                    models={savedModels}
                    onChange={(id) => onUpdateConfig({ modelProfileId: id })}
                  />
                  <input className="cc-input" value={config.customBaseUrl || ''} onChange={(e) => onUpdateConfig({ customBaseUrl: e.target.value })} placeholder="可选：助手独立 Base URL（留空使用上方所选模型）" />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="cc-input" value={config.customModel || ''} onChange={(e) => onUpdateConfig({ customModel: e.target.value })} placeholder="可选：独立模型 ID（如 deepseek-chat）" />
                    <input className="cc-input" type="password" value={config.customApiKey || ''} onChange={(e) => onUpdateConfig({ customApiKey: e.target.value })} placeholder="可选：独立 API Key" />
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
