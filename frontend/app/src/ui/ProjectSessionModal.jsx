import { useEffect, useState } from 'react'
import './ProjectSessionModal.css'

/**
 * 项目会话文件夹绑定弹窗（支持「新建项目会话」与「将当前普通会话转为项目会话 / 更换目录」）：
 * 纯展示组件，文件夹浏览与落盘回调由宿主经 props 注入（严格遵守铁律 LAW-03 / LAW-07）。
 */
export default function ProjectSessionModal({
  request,
  recentFolders = [],
  onPickFolder,
  onCancel,
  onConfirm,
}) {
  const [dirPath, setDirPath] = useState('')
  const [title, setTitle] = useState('')
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!request) return
    setDirPath(String(request.initialDir || ''))
    setTitle(String(request.initialTitle || ''))
    setPicking(false)
  }, [request && request.id])

  if (!request) return null

  const isBind = request.mode === 'bind'

  const handleBrowse = async () => {
    if (typeof onPickFolder !== 'function' || picking) return
    setPicking(true)
    try {
      const picked = await onPickFolder()
      if (picked) {
        setDirPath(picked)
        if (!title.trim()) {
          const base = String(picked).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || ''
          if (base) setTitle(base)
        }
      }
    } finally {
      setPicking(false)
    }
  }

  const handleSubmit = () => {
    const cleanDir = dirPath.trim()
    if (!cleanDir) return
    onConfirm({
      mode: request.mode || 'create',
      sid: request.sid || '',
      workspaceDir: cleanDir,
      title: title.trim(),
    })
  }

  const normalizedRecent = (Array.isArray(recentFolders) ? recentFolders : [])
    .map((item) => (typeof item === 'string' ? item : (item && item.path) || ''))
    .filter(Boolean)
    .slice(0, 6)

  return (
    <div className="pm-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="pm-modal" role="dialog" aria-modal="true" aria-label={isBind ? '设置项目工作文件夹' : '新建项目会话'}>
        <header className="pm-head">
          <span className="pm-kicker">📁 项目会话 · 专属工作文件夹隔离</span>
          <h3 className="pm-title">{isBind ? '绑定项目工作文件夹' : '新建项目会话'}</h3>
          <p className="pm-sub">
            项目会话会绑定一个专属工作目录，读写文件与执行命令默认在该目录内展开；普通会话则保持轻量纯对话、不锁定项目目录。
          </p>
        </header>

        <div className="pm-body">
          <div className="pm-field">
            <label className="pm-label" htmlFor="pm-dir-input">项目工作文件夹路径（必填）</label>
            <div className="pm-row">
              <input
                id="pm-dir-input"
                className="pm-input"
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="例如：C:\Users\你\Desktop\my-project"
              />
              <button type="button" className="pm-btn" disabled={picking} onClick={handleBrowse}>
                {picking ? '选择中…' : '浏览文件夹'}
              </button>
            </div>
          </div>

          <div className="pm-field">
            <label className="pm-label" htmlFor="pm-title-input">项目名称（可选，留空自动取文件夹名）</label>
            <input
              id="pm-title-input"
              className="pm-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
              placeholder="例如：个人官网 / Harbor 客户端"
            />
          </div>

          {normalizedRecent.length > 0 && (
            <div className="pm-field">
              <span className="pm-label">最近使用过的文件夹</span>
              <div className="pm-recent">
                {normalizedRecent.map((fp) => (
                  <button
                    key={fp}
                    type="button"
                    className="pm-chip"
                    title={fp}
                    onClick={() => setDirPath(fp)}
                  >
                    📁 {fp}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="pm-foot">
          <button type="button" className="pm-btn" onClick={onCancel}>取消</button>
          <button type="button" className="pm-btn pm-btn-primary" disabled={!dirPath.trim()} onClick={handleSubmit}>
            {isBind ? '确认绑定项目文件夹' : '创建项目会话 →'}
          </button>
        </footer>
      </div>
    </div>
  )
}
