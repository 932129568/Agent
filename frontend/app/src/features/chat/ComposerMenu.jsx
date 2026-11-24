import './ComposerMenu.css'

export function buildComposerMenuItems(draft, { workspaceEntries = [], experts = [] } = {}) {
  const txt = String(draft || '')
  const mSlash = txt.match(/(?:^|\s)(\/[^\s]*)$/)
  if (mSlash) {
    const q = mSlash[1].toLowerCase()
    const cmds = [
      { id: '/compact', kind: 'cmd', label: '/compact', desc: '压缩本会话历史并生成锚点摘要', insert: '/compact' },
      { id: '/sub', kind: 'cmd', label: '/sub <探索任务>', desc: '派生隔离子代理并行检索（省主对话 Token）', insert: '/sub ' },
      { id: '/plan', kind: 'cmd', label: '/plan <目标>', desc: '先拆解可执行步骤并创建检查点', insert: '/plan ' },
      { id: '/demo', kind: 'cmd', label: '/demo', desc: '播放四幕大尺度动效演示（含生成式 UI）', insert: '/demo' },
      { id: '/wf', kind: 'cmd', label: '/wf', desc: '打开插件化可视化 DAG 工作流工坊', insert: '/wf' },
      { id: '/plugins', kind: 'cmd', label: '/plugins', desc: '打开插件热插拔管理中心', insert: '/plugins' },
      { id: '/project', kind: 'cmd', label: '/project', desc: '为当前对话绑定专属项目工作文件夹', insert: '/project' },
      { id: '/export', kind: 'cmd', label: '/export', desc: '一键导出当前会话为 Markdown 纪要', insert: '/export' },
      { id: '/zen', kind: 'cmd', label: '/zen', desc: '开关无干扰专注模式（Ctrl+Shift+F）', insert: '/zen' },
      { id: '/clear', kind: 'cmd', label: '/clear', desc: '新建空白对话', insert: '/clear' },
    ]
    return { trigger: mSlash[1], items: cmds.filter((c) => c.label.toLowerCase().startsWith(q)) }
  }

  const mAt = txt.match(/(?:^|\s)@([^\s@]*)$/)
  if (mAt) {
    const q = mAt[1].toLowerCase()
    const items = []
    for (const pkg of (experts || []).slice(0, 12)) {
      const meta = pkg.metadata || pkg
      const name = String(meta.displayName || meta.name || pkg.id)
      if (!q || name.toLowerCase().includes(q)) {
        items.push({ id: `exp_${pkg.id}`, kind: 'expert', label: `@${name}`, desc: '专家胶囊（随消息发送）', expert: pkg })
      }
    }
    for (const ent of (workspaceEntries || []).slice(0, 16)) {
      const name = typeof ent === 'string' ? ent : String(ent.name || ent.path || '')
      if (name && (!q || name.toLowerCase().includes(q))) {
        items.push({ id: `file_${name}`, kind: 'file', label: `@${name}`, desc: '工作区文件引用', insert: `@${name} ` })
      }
    }
    return { trigger: '@' + mAt[1], items: items.slice(0, 10) }
  }
  return { trigger: '', items: [] }
}

export default function ComposerMenu({ items, activeIndex, onPick }) {
  if (!items || !items.length) return null
  return (
    <div className="cm-menu" role="listbox" aria-label="输入补全菜单">
      {items.map((it, idx) => (
        <button
          key={it.id}
          type="button"
          className="cm-item"
          data-active={String(idx === activeIndex)}
          onMouseDown={(e) => { e.preventDefault(); onPick(it) }}
        >
          <span>{it.label}</span>
          <span className="cm-desc">{it.desc}</span>
        </button>
      ))}
    </div>
  )
}
