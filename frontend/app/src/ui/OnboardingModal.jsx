import { useEffect, useState } from 'react'
import './OnboardingModal.css'

const GUIDE_SLIDES = [
  {
    id: 'highlights',
    tab: '软件特色',
    icon: '✦',
    title: '欢迎来到 Harbor Desktop · 下一代本地优先 AI 协同工作台',
    desc: '硬件原生窗外透色、物理阻尼触觉交互、90%+ KV-Cache 省钱架构与全链路本地隐私掌控。',
    cards: [
      { title: '🪟 真窗外硬件透色', text: 'Windows 11 原生 Acrylic / Mica 与 macOS Vibrancy 实时透出窗外桌面，拒绝假壁纸贴图，右上角「外观 ▾」随心切明暗与通透度。' },
      { title: '🧲 真实 3D 物理撞击动效', text: '弹窗从触发按钮空间展开、关闭飞回归属位置撞击主壳产生 3D 微倾与光波扩散，可在设置中一键切至「静息无障碍 (0×)」。' },
      { title: '⚡ 90%+ 前缀缓存 & 智能裁工具', text: '严格 Append-Only 前缀冻结 + 按意图裁剪工具 Schema，单会话省 55%–85% 冗余 Token，底栏实时可视化本轮与累计命中率。' },
      { title: '🔒 本地数据主权与安全护栏', text: '密钥走系统级加密存储，高危命令支持沙箱隔离与三级审批档位，所有对话/群文件/工作流均保存在本机。' },
    ],
    tips: [
      { k: 'Ctrl+K', v: '全局命令面板' },
      { k: 'Ctrl+Shift+F', v: 'Zen 无干扰专注模式' },
      { k: 'Ctrl+Alt+D', v: '右侧上下文副屏与实时画布' },
      { k: 'Esc', v: '逐层平滑收起菜单与弹窗' },
    ],
  },
  {
    id: 'chat-models',
    tab: '对话与模型中心',
    icon: '💬',
    title: '普通会话 / 项目会话双形态 + 全局「模型保存中心」',
    desc: '按场景自由隔离文件夹上下文，自定义保存多厂商模型并在任意位置一键切换。',
    cards: [
      { title: '📁 普通会话 vs 项目会话', text: '左侧栏支持一键新建「普通会话」（轻量纯对话）或「📁 项目会话」（绑定专属工作文件夹），输入区模式条可随时换目录或互转。' },
      { title: '🧠 模型保存中心（全站联动）', text: '在「系统设置 → 模型保存中心」自定义添加并保存多套模型（独立 Base URL / API Key / 思考档位 / 对话·生图·视频分类）。' },
      { title: '🔄 随处一键切模型', text: '无需反复进设置：顶部灵动岛、对话输入条、角色群聊成员、DAG 工作流节点与双模协同均可直接下拉切换已保存的模型。' },
      { title: '🌿 DAG 分叉编辑与一键导出', text: '任意消息支持分叉重问、回退撤销、提炼入长期记忆、代码块一键复制及导出完整 Markdown 纪要（/export）。' },
    ],
    tips: [
      { k: '/', v: '呼出 /compact /project /img /video /wf /export' },
      { k: '@', v: '快速引用行业专家胶囊或项目文件' },
      { k: '双击侧栏', v: '内联重命名任意会话或群聊' },
    ],
  },
  {
    id: 'group',
    tab: '多角色群聊',
    icon: '👥',
    title: '多角色协同接力 · 独立群文件空间',
    desc: '把复杂任务交给一支多角色 AI 团队协作完成，每一棒均可指定不同模型与思考深度。',
    cards: [
      { title: '🎙 主持人智能调度', text: '默认由主持人分析议题，自动挑选最合适的角色与先后顺序（如先架构/UI 设计，后编码/审查），也可切回固定名册顺序。' },
      { title: '🗂 左侧群聊列表 + 严格群隔离', text: '切入「角色群聊」时左侧栏自动切换为「群聊列表/+ 新建群聊」；每个群拥有专属磁盘文件夹，删群时可选彻底清空群文件。' },
      { title: '⏸ 中途暂停与纠偏续跑', text: '光梭接力轨道实时展示当前接力棒次，随时点暂停补充方向纠偏后原地续跑，绝不浪费已完成棒次。' },
      { title: '⚡ 群聊一键转 DAG 工作流', text: '在群聊顶栏「⋯ 更多」点击「编译为 DAG 工作流」，瞬间把现有角色班底升级为可拖拽并行分支的自动化流水线。' },
    ],
    tips: [
      { k: '⚙ 角色与模型', v: '内置全栈/视频/增长等行业班底，支持从模型中心下拉选模型' },
      { k: '🎯 效果先问我', v: '动手前先弹卡片拍板风格，或切「⚡ 自主发挥」直出' },
    ],
  },
  {
    id: 'workflow-media',
    tab: '工作流与生图/视频',
    icon: '⚡',
    title: '插件化可视化 DAG 工作流 + 多模态 AI 生图/视频',
    desc: '10 类一等节点自由拖拽编排，内置 8 大旗舰插件与多厂商图片/视频兼容引擎。',
    cards: [
      { title: '🖱 自由拖拽定位与端口拉线', text: '按住节点卡片任意排布，按住右侧橙点 ● 拖向目标节点即时连线（Kahn 算法防环路），支持 20 步 ↶ 撤销/重做与单节点「▶ 从此跑」。' },
      { title: '✨ 一句话生成并发 DAG', text: '点击「✨ 一句话生成流」，输入调研/审计/研发/生图/短片创意，1 秒自动合成多泳道并行拓扑图。' },
      { title: '🎨 AI 生图 & 🎬 图生视频 (I2V)', text: '兼容智谱 CogView-4/CogVideoX-3、OpenAI GPT-Image/Sora、硅基流动 FLUX/Wan2.1、MiniMax 及本地网关，上游首帧图自动喂给下游视频节点。' },
      { title: '🧩 插件热插拔中心', text: '支持零脚本注入的自定义 JSON 插件热安装与即时启停，同步贡献工作流、一等工具、斜杠指令与提示词钩子。' },
    ],
    tips: [
      { k: '/img', v: 'AI 双风格并行视觉海报流' },
      { k: '/video', v: 'AI 导演分镜 → 首帧图 → 图生视频流' },
      { k: '/refine', v: '有界 3 轮自检迭代精修环' },
    ],
  },
  {
    id: 'canvas-experts',
    tab: '画布、专家与上手',
    icon: '🚀',
    title: '实时交互沙箱画布 · 18 大行业专家库 · 3 步快速开始',
    desc: '对话即软件，无需切出窗口即可实时预览交互网页、SVG、图片画廊与视频。',
    cards: [
      { title: '🖼 防套娃实时交互画布', text: 'AI 输出 HTML/SVG 或生图/视频后，点击「✦ 实时画布」即可在沙箱 iframe 中切换桌面/手机视口实时体验、查看源码或下载。' },
      { title: '🌟 18 大前沿行业专家包', text: '覆盖软件工程、AI 提示词、云原生 DevOps、办公文档、电商直播、学术论文、游戏叙事、金融法务合规等 10 大行业，支持一键入输入框或群聊。' },
      { title: '① 第一步：配置并保存模型', text: '点左侧「系统设置」进入模型保存中心，填入你的主力 API Key（或本机 Ollama 端口）并点击保存，即可全站随处切换。' },
      { title: '② 第二步：开始你的第一个任务', text: '新建项目会话绑定本地文件夹，或在群聊/工作流中试跑一条并发流水线——随时可从顶部「外观 ▾」或 Ctrl+K 重新打开本指南。' },
    ],
    tips: [
      { k: '✦ 选专家', v: '专家包胶囊随消息发送，精准注入行业方法论' },
      { k: '⬇ 导出', v: '普通会话、群聊与工作流均支持一键导出 Markdown 交付报告' },
    ],
  },
]

export default function OnboardingModal({ open = false, onClose, onOpenSettings }) {
  const [step, setStep] = useState(0)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setStep(0)
      setClosing(false)
    }
  }, [open])

  const closeWith = (afterFn = null) => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      if (typeof onClose === 'function') onClose(true)
      if (typeof afterFn === 'function') afterFn()
    }, 150)
  }

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeWith()
      } else if (e.key === 'ArrowRight') {
        setStep((s) => Math.min(GUIDE_SLIDES.length - 1, s + 1))
      } else if (e.key === 'ArrowLeft') {
        setStep((s) => Math.max(0, s - 1))
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [open, closing])

  if (!open) return null

  const cur = GUIDE_SLIDES[step] || GUIDE_SLIDES[0]
  const isLast = step === GUIDE_SLIDES.length - 1

  return (
    <div className="ob-backdrop" data-closing={String(closing)} onClick={(e) => { if (e.target === e.currentTarget) closeWith() }}>
      <div className="ob-modal" role="dialog" aria-modal="true" aria-label="Harbor 使用指南与核心特色">
        <header className="ob-head">
          <div>
            <span className="ob-kicker">✦ HARBOR DESKTOP v2.0 · 快速上手与特色导览</span>
            <h2 className="ob-title">欢迎使用 Harbor 智能协同工作台</h2>
            <p className="ob-sub">1 分钟了解核心特色、模型保存中心、项目会话、多角色群聊与可视化插件工作流。</p>
          </div>
          <button type="button" className="ob-btn" onClick={() => closeWith()} aria-label="跳过指南">跳过 ×</button>
        </header>

        <nav className="ob-tabs" role="tablist" aria-label="指南章节">
          {GUIDE_SLIDES.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className="ob-tab"
              aria-selected={String(step === idx)}
              data-active={String(step === idx)}
              onClick={() => setStep(idx)}
            >
              {idx + 1}. {s.tab}
            </button>
          ))}
        </nav>

        <div key={cur.id} className="ob-body">
          <div className="ob-slide-head">
            <div className="ob-slide-icon">{cur.icon}</div>
            <div>
              <h3 className="ob-slide-title">{cur.title}</h3>
              <p className="ob-slide-desc">{cur.desc}</p>
            </div>
          </div>

          <div className="ob-grid">
            {cur.cards.map((c) => (
              <div key={c.title} className="ob-card">
                <strong>{c.title}</strong>
                <p>{c.text}</p>
              </div>
            ))}
          </div>

          {Array.isArray(cur.tips) && cur.tips.length > 0 && (
            <div className="ob-kbd-row">
              {cur.tips.map((t) => (
                <span key={t.k} className="ob-kbd-pill">
                  <code>{t.k}</code>{t.v}
                </span>
              ))}
            </div>
          )}
        </div>

        <footer className="ob-foot">
          <div className="ob-dots" aria-label="引导进度">
            {GUIDE_SLIDES.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                className="ob-dot"
                data-active={String(step === idx)}
                aria-label={`跳至第 ${idx + 1} 页：${s.tab}`}
                onClick={() => setStep(idx)}
              />
            ))}
          </div>
          <div className="ob-actions">
            {step > 0 && (
              <button type="button" className="ob-btn" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                ← 上一步
              </button>
            )}
            {typeof onOpenSettings === 'function' && (
              <button type="button" className="ob-btn" onClick={() => closeWith(onOpenSettings)}>
                ⚙ 去配置模型
              </button>
            )}
            {isLast ? (
              <button type="button" className="ob-btn ob-btn-primary" onClick={() => closeWith()}>
                开始使用 Harbor →
              </button>
            ) : (
              <button type="button" className="ob-btn ob-btn-primary" onClick={() => setStep((s) => Math.min(GUIDE_SLIDES.length - 1, s + 1))}>
                下一步 →
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
