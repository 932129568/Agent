import { useEffect, useState } from 'react'
import './GroupDeleteModal.css'

/**
 * 删除群聊确认弹窗：让用户明确选择「仅删除群聊（保留本地群文件）」或「同时清空该群聊的专属群文件」。
 */
export default function GroupDeleteModal({ request, onCancel, onConfirm }) {
  const [deleteFiles, setDeleteFiles] = useState(true)

  useEffect(() => {
    if (request) setDeleteFiles(true)
  }, [request && request.groupId])

  if (!request) return null

  const fileCount = Number(request.fileCount) || 0

  return (
    <div className="gd-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="gd-modal" role="dialog" aria-modal="true" aria-label="删除群聊确认">
        <header className="gd-head">
          <h3 className="gd-title">删除群聊「{request.title || '未命名群聊'}」</h3>
          <p className="gd-sub">
            该群聊与其他群聊、普通会话完全隔离；当前名下共有 <strong>{fileCount}</strong> 份本群专属群文件。请选择处理方式：
          </p>
        </header>

        <div className="gd-body">
          <label className="gd-choice gd-choice-danger" data-selected={String(deleteFiles)}>
            <input type="radio" name="gd-mode" checked={deleteFiles} onChange={() => setDeleteFiles(true)} />
            <div>
              <div className="gd-choice-title">同时删除该群聊的全部群文件</div>
              <div className="gd-choice-desc">
                彻底清空该群专属磁盘目录（{fileCount} 份文档），新建群聊绝不会再看到任何残留内容。
              </div>
            </div>
          </label>

          <label className="gd-choice" data-selected={String(!deleteFiles)}>
            <input type="radio" name="gd-mode" checked={!deleteFiles} onChange={() => setDeleteFiles(false)} />
            <div>
              <div className="gd-choice-title">仅删除群聊记录，保留本地群文件</div>
              <div className="gd-choice-desc">
                仅移出群聊列表，本地磁盘归档文件原样留存备查；新群聊会使用全新独立群 ID，不会读取此旧群文件。
              </div>
            </div>
          </label>
        </div>

        <footer className="gd-foot">
          <button type="button" className="gd-btn" onClick={onCancel}>取消</button>
          <button
            type="button"
            className={deleteFiles ? 'gd-btn gd-btn-danger' : 'gd-btn gd-btn-primary'}
            onClick={() => onConfirm({ groupId: request.groupId, deleteFiles })}
          >
            {deleteFiles ? '确认删除群聊与群文件' : '仅删除群聊（保留文件）'}
          </button>
        </footer>
      </div>
    </div>
  )
}
