import { useState } from 'react'
import {
  useSlice,
  closeModal,
  createNewSession,
  openProjectSessionModal,
  createNewGroup,
  selectSession,
  setActivePanel,
  openModal,
  toggleDock,
  toggleZenMode,
  exportCurrentSessionMarkdown,
  toggleSearchDock,
  updateVisualSettings,
  compactSessionNow,
  checkAppUpdate,
  triggerFourActShowcase,
  setWorkflowViewTab,
  openOnboardingModal,
} from '../../state/store.js'
import './CommandPalette.css'

export default function CommandPalette() {
  const sessionsState = useSlice('sessions')
  const settings = useSlice('settings')
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)

  const commands = [
    { id: 'new', label: '新建普通会话', hint: 'Ctrl+N', run: () => createNewSession('新对话') },
    { id: 'new-proj', label: '新建项目会话（绑定工作文件夹）', hint: '/project', run: () => openProjectSessionModal('create') },
    { id: 'new-grp', label: '新建隔离群聊（专属群文件空间）', hint: 'Group', run: () => { setActivePanel('group'); createNewGroup() } },
    { id: 'zen', label: '开关无干扰专注模式（隐藏导航与侧栏）', hint: 'Ctrl+Shift+F', run: () => toggleZenMode() },
    { id: 'export', label: '导出当前会话为 Markdown 纪要', hint: '/export', run: () => exportCurrentSessionMarkdown(sessionsState.currentId) },
    { id: 'wf-studio', label: '打开「插件化可视化 DAG 工作流工坊」', hint: '/wf', run: () => { setWorkflowViewTab('studio'); setActivePanel('workflow') } },
    { id: 'plug-hub', label: '打开「插件热插拔管理中心」', hint: '/plugins', run: () => { setWorkflowViewTab('plugins'); setActivePanel('workflow') } },
    { id: 'artifact', label: '打开实时交互 Artifact 画布', hint: 'Canvas', run: () => toggleDock('artifact') },
    { id: 'demo', label: '预览四幕大尺度动效 + 生成式 UI 仪表盘', hint: '/demo', run: () => { setActivePanel('chat'); triggerFourActShowcase(sessionsState.currentId) } },
    { id: 'compact', label: '立即压缩当前会话历史并生成锚点摘要', hint: '/compact', run: () => compactSessionNow(sessionsState.currentId, true) },
    { id: 'acrylic', label: '窗外透色：Acrylic（实时透窗外窗口）', hint: 'Optics', run: () => updateVisualSettings({ backdrop: 'acrylic' }) },
    { id: 'mica', label: '窗外透色：Mica（柔和桌面色）', hint: 'Optics', run: () => updateVisualSettings({ backdrop: 'mica' }) },
    { id: 'solid', label: '窗外透色：纯实色兜底', hint: 'Optics', run: () => updateVisualSettings({ backdrop: 'none' }) },
    { id: 'theme', label: '切换深色 / 浅色玻璃主题', hint: 'Theme', run: () => updateVisualSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' }) },
    { id: 'collab', label: '切换到「双模型协同 (Planner + Worker + Reviewer)」', hint: 'Collab', run: () => setActivePanel('collaboration') },
    { id: 'market', label: '打开「专家市场与多专家团队编排器」', hint: 'Market', run: () => openModal('market') },
    { id: 'dock', label: '开关右侧上下文工作台（Diff / 轨迹 / 预览）', hint: 'Ctrl+Alt+D', run: () => toggleDock() },
    { id: 'search', label: '开关浏览器分栏搜索面板', hint: 'Search', run: () => toggleSearchDock() },
    { id: 'model-vault', label: '打开「模型保存中心」（自定义保存与切换多模型）', hint: 'Models', run: () => openModal('settings') },
    { id: 'onboarding', label: '打开「Harbor 使用指南与核心特色」', hint: 'Guide', run: () => openOnboardingModal() },
    { id: 'settings', label: '打开设置中心（模型 / 混合路由 / 沙箱 / WebDAV / 软件）', hint: 'Settings', run: () => openModal('settings') },
    { id: 'update', label: '检查 Harbor 软件更新', hint: 'Update', run: () => checkAppUpdate(true) },
    { id: 'ws', label: '切换到「工作区与护栏」', hint: 'Panel', run: () => setActivePanel('workspace') },
    { id: 'plan', label: '切换到「计划与检查点回滚」', hint: 'Panel', run: () => setActivePanel('planning') },
    { id: 'group', label: '切换到「多角色群聊接力」', hint: 'Panel', run: () => setActivePanel('group') },
    { id: 'analytics', label: '切换到「用量洞察与审计」', hint: 'Panel', run: () => setActivePanel('analytics') },
    ...sessionsState.items.slice(0, 8).map((s) => ({
      id: `sess_${s.id}`,
      label: `跳转会话：${s.title || s.id}`,
      hint: `${(s.messages || []).length} 条`,
      run: () => selectSession(s.id),
    })),
  ]

  const filtered = commands.filter((c) => !q.trim() || c.label.toLowerCase().includes(q.trim().toLowerCase()))
  const activeIdx = Math.min(idx, Math.max(0, filtered.length - 1))

  const exec = (cmd) => {
    if (!cmd) return
    closeModal()
    cmd.run()
  }

  return (
    <div className="cp-wrap">
      <input
        autoFocus
        className="cp-input"
        value={q}
        onChange={(e) => { setQ(e.target.value); setIdx(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % Math.max(1, filtered.length)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length)) }
          else if (e.key === 'Enter') { e.preventDefault(); exec(filtered[activeIdx]) }
        }}
        placeholder="输入命令、切换透色、双模型协同或搜索最近会话…"
      />
      <div className="cp-list">
        {filtered.length === 0 ? (
          <div className="cp-empty">未找到匹配指令，试试输入「新建」「透色」「工作流」或「导出」</div>
        ) : (
          filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className="cp-row"
              data-active={String(i === activeIdx)}
              onMouseEnter={() => setIdx(i)}
              onClick={() => exec(c)}
            >
              <span>{c.label}</span>
              <span className="cp-hint">{c.hint}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
