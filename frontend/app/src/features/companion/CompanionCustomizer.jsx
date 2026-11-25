import { useEffect, useState } from 'react'
import {
  COMPANION_MODEL_PACKS,
  YALU_RENDER_MODES,
  YALU_AURA_THEMES,
  COMPANION_PERSONALITIES,
  getActiveModelPack,
} from '../../services/companionCatalog.js'
import YaluModelStage from '../../ui/YaluModelStage.jsx'
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
  const [viewAngle, setViewAngle] = useState('auto')

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

  const pack = getActiveModelPack(avatar.modelPackId)
  const packAssets = {
    front: pack.assets.front,
    side: pack.assets.side,
    back: pack.assets.back,
    animIdleStrip: pack.assets.animIdleStrip,
    animActionStrip: pack.assets.animActionStrip,
    animFrames: pack.assets.animFrames,
    showcaseVideo: pack.assets.showcaseVideo,
  }

  return (
    <div className="cc-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="芽露 3D 活体工坊与无人驾驶大脑设置"
        data-section="companion-customizer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cc-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="cc-title">🌿 芽露 · 3D 动作工坊与总管大脑</span>
            <div className="cc-tabs">
              <button type="button" className="cc-btn" data-active={String(tab === 'avatar')} onClick={() => setTab('avatar')}>🧊 3D 模型与设定鉴赏</button>
              <button type="button" className="cc-btn" data-active={String(tab === 'llm')} onClick={() => setTab('llm')}>🧠 无人驾驶与专属大模型</button>
            </div>
          </div>
          <button type="button" className="cc-btn" onClick={onClose} aria-label="关闭捏脸工坊">×</button>
        </div>

        <div className="cc-body">
          <aside className="cc-stage">
            <div className="cc-stage-card" style={{ padding: viewAngle === 'video' ? 4 : 8 }}>
              <YaluModelStage
                assets={packAssets}
                renderMode={avatar.renderMode || 'yalu_3d'}
                actionState={previewPose}
                auraTheme={avatar.auraTheme || 'natural'}
                viewAngle={viewAngle}
                scale={1}
                width={212}
                height={212}
              />
            </div>
            <strong style={{ fontSize: 15, color: 'var(--text)' }}>{avatar.name || '芽露'}</strong>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
              {viewAngle === 'auto'
                ? ((avatar.renderMode || 'yalu_3d') === 'yalu_3d' ? '60fps 3D 全骨骼物理活体' : '60fps 原版成片逐帧引擎')
                : '原版设定三视图 / 成片鉴赏'}
            </span>

            <div className="cc-pose-row" aria-label="视图与成片切换">
              {[
                ['auto', '3D活体'],
                ['front', '正面设定'],
                ['side', '侧面设定'],
                ['back', '背面设定'],
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

            <div className="cc-pose-row" aria-label="3D 骨骼动作试演">
              {[
                ['idle', '待机'],
                ['run', '小跑'],
                ['sit_edge', '坐边荡脚'],
                ['stretch', '伸懒腰'],
                ['bell_play', '敲腰铃'],
                ['supervising', '执杖监工'],
                ['magic_blackhole', '黑洞施法'],
                ['grabbed', '拎起挣扎'],
                ['sleep', '打盹'],
              ].map(([id, lbl]) => (
                <button
                  key={id}
                  type="button"
                  className="cc-btn"
                  style={{ padding: '3px 9px', fontSize: 11 }}
                  data-active={String(viewAngle === 'auto' && previewPose === id)}
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
                  <span className="cc-label">驱动渲染引擎（均严格忠实于芽露原版建模与 60fps 成片）</span>
                  <div className="cc-form-grid">
                    {YALU_RENDER_MODES.map((rm) => (
                      <button
                        key={rm.id}
                        type="button"
                        className="cc-form-card"
                        data-active={String((avatar.renderMode || 'yalu_3d') === rm.id)}
                        onClick={() => { setViewAngle('auto'); onUpdateAvatar({ renderMode: rm.id }) }}
                      >
                        <strong>{rm.label}</strong>
                        <span>{rm.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">已载入建模包（后续所有新建模包均在此扩展）</span>
                  <div className="cc-form-grid">
                    {COMPANION_MODEL_PACKS.map((mp) => (
                      <button
                        key={mp.id}
                        type="button"
                        className="cc-form-card"
                        data-active={String((avatar.modelPackId || 'yalu_official') === mp.id)}
                        onClick={() => onUpdateAvatar({ modelPackId: mp.id })}
                      >
                        <strong>{mp.name}</strong>
                        <span>{mp.tagline}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">昵称与体型缩放 ({Math.round((avatar.scale || 1) * 100)}%)</span>
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

                <div className="cc-group">
                  <span className="cc-label">原版表情差分（联动对话头像） & 身上自带道具细节设定</span>
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
                    <div className="cc-expr-card" style={{ cursor: 'default' }} title="已自然佩戴在芽露腰间丝带并带物理摇摆">
                      <img src={pack.assets.props.bell.src} alt="酒红铃铛" />
                      <span>腰间·酒红铃铛</span>
                    </div>
                    <div className="cc-expr-card" style={{ cursor: 'default' }} title="施法/手写/监工/修补时自然握持在芽露右手">
                      <img src={pack.assets.props.staff.src} alt="露芽杖" />
                      <span>手持·露芽杖</span>
                    </div>
                  </div>
                </div>

                <div className="cc-group">
                  <span className="cc-label">光晕氛围与性格声线</span>
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
                      把任何真实需求发给芽露，她会自动判断选用「智能对话+专家+Skill / 12支原生专家团 / 工作流 DAG / 多角色群聊 / 双模协同」，自动切页运行并监工交稿。
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
                    <strong style={{ fontSize: 13 }}>🌿 自主活体生命行为（自动散步 / 坐边 / 走出桌面漫游与回窗）</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      空闲时自然走动、坐边荡脚、敲腰间铃铛、打盹，并在桌面端自主走出窗口到桌面溜达一圈再回来（也可随时直接拎着她跨窗拖动）。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cc-btn"
                    data-active={String(config.autonomousLifeEnabled !== false)}
                    onClick={() => onUpdateConfig({ autonomousLifeEnabled: config.autonomousLifeEnabled === false })}
                  >
                    {config.autonomousLifeEnabled !== false ? '已开启' : '已关闭'}
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
                  <span className="cc-label">绑定芽露专属已保存模型（独立于主聊天模型）</span>
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
                  <span className="cc-label">或单独填写独立 API 端点 / 模型 / Key（留空继承上方）</span>
                  <input className="cc-input" value={config.customBaseUrl || ''} onChange={(e) => onUpdateConfig({ customBaseUrl: e.target.value })} placeholder="独立 Base URL（如 https://api.deepseek.com/v1）" />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="cc-input" value={config.customModel || ''} onChange={(e) => onUpdateConfig({ customModel: e.target.value })} placeholder="独立模型 ID（如 deepseek-chat）" />
                    <input className="cc-input" type="password" value={config.customApiKey || ''} onChange={(e) => onUpdateConfig({ customApiKey: e.target.value })} placeholder="独立 API Key" />
                  </div>
                </div>

                <div className="cc-switch-card">
                  <div>
                    <strong style={{ fontSize: 13 }}>🍪 液态玻璃互动：饿了偷啃 & 自动拾碎片修补</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                      甩碎玻璃后会自动跑去拾碎片用露芽杖修补；精力低时偶尔会悄悄啃一口玻璃。
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
