/**
 * 普通会话 vs 项目会话纯函数契约（R13）：
 * - 普通会话（kind: 'chat', workspaceDir: ''）：纯对话，不绑定专属项目文件夹；
 * - 项目会话（kind: 'project', workspaceDir: '<abs_dir>'）：绑定独立工作文件夹，
 *   切换会话自动同步后端 sessionWs，支持随时更换目录或一键转回普通会话。
 */

export function normalizeSessionKind(session) {
  if (!session || typeof session !== 'object') return 'chat'
  if (session.kind === 'project' || String(session.workspaceDir || '').trim()) return 'project'
  return 'chat'
}

export function shortFolderLabel(dirPath = '') {
  const clean = String(dirPath || '').trim().replace(/[\\/]+$/, '')
  if (!clean) return ''
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : clean
}

export function applyProjectWorkspace(session, dirPath, customTitle = '') {
  const cleanDir = String(dirPath || '').trim()
  if (!cleanDir) return session
  const folderName = shortFolderLabel(cleanDir)
  const curTitle = String((session && session.title) || '').trim()
  const nextTitle = String(customTitle || '').trim()
    || (!curTitle || curTitle === '新对话' ? folderName : curTitle)
  return {
    ...session,
    kind: 'project',
    workspaceDir: cleanDir,
    title: nextTitle || folderName || '项目会话',
    updatedAt: Date.now(),
  }
}

export function clearProjectWorkspace(session) {
  if (!session || typeof session !== 'object') return session
  return {
    ...session,
    kind: 'chat',
    workspaceDir: '',
    updatedAt: Date.now(),
  }
}
