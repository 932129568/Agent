/**
 * 行业专家包市场领域切片（R18 彻底收口）：
 * 承接 MarketModal 的专家包读取、SKILL 预览、目录导入与启停动作，
 * 让 features/market/MarketModal.jsx 零直接依赖 services/bridge.js（遵守 LAW-14）。
 */
import * as api from '../services/bridge.js'
import { addComposerToken, closeModal, setActivePanel, setDockPreview, pushToast } from './uiSlice.js'
import { refreshMarket } from './domainSlice.js'

function pickDisplayText(val, fallback = '') {
  if (!val) return fallback
  if (typeof val === 'string') return val
  if (typeof val === 'object') return val['zh-CN'] || val.zh || val.en || Object.values(val)[0] || fallback
  return String(val)
}

export async function activateLocalExpertPackage(pkg) {
  if (!pkg) return
  const md = pkg.metadata || {}
  const name = pickDisplayText(md.displayName, pkg.name || pkg.id)
  let promptText = pickDisplayText(md.description, `请以「${name}」专家身份回答。`)
  try {
    const detail = await api.expertGet(pkg.id, pkg.active_snapshot || '')
    const firstAgent = detail && detail.package && Array.isArray(detail.package.agents) && detail.package.agents[0]
    if (firstAgent && detail.package.snapshot_id) {
      const res = await api.expertReadResource(detail.package.snapshot_id, firstAgent)
      if (res && res.ok && typeof res.text === 'string' && res.text.trim()) {
        promptText = res.text.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 4000)
      }
    }
  } catch {}
  addComposerToken({
    id: pkg.id,
    name,
    kind: pkg.kind || 'expert',
    prompt: promptText,
  })
  closeModal('left')
  setActivePanel('chat')
  pushToast(`已将标准专家包「${name}」完整指令加入输入框胶囊`, 'ok')
}

export async function previewLocalExpertSkills(pkg) {
  if (!pkg) return
  try {
    const detail = await api.expertGet(pkg.id, pkg.active_snapshot || '')
    const p = detail && detail.package
    if (!p || !p.snapshot_id) {
      pushToast('未能读取专家包快照内容', 'err')
      return
    }
    const sections = [`## 📦 ${pickDisplayText((p.metadata && p.metadata.displayName), pkg.id)} (\`${pkg.id}\` v${p.version || '1.0.0'})`]
    for (const sk of (p.skills || []).slice(0, 4)) {
      const rel = `${String(sk).replace(/\/+$/, '')}/SKILL.md`
      const r = await api.expertReadResource(p.snapshot_id, rel).catch(() => null)
      if (r && r.ok && r.text) {
        sections.push(r.text.replace(/^---[\s\S]*?---\s*/, '').trim())
      }
    }
    if (sections.length === 1 && Array.isArray(p.agents) && p.agents[0]) {
      const r = await api.expertReadResource(p.snapshot_id, p.agents[0]).catch(() => null)
      if (r && r.ok && r.text) sections.push(r.text.replace(/^---[\s\S]*?---\s*/, '').trim())
    }
    closeModal('left', true)
    setDockPreview(sections.join('\n\n---\n\n'))
  } catch (e) {
    pushToast(`预览 SKILL 失败：${e.message}`, 'err')
  }
}

export async function importLocalExpertDirectory(dirPath) {
  const clean = String(dirPath || '').trim()
  if (!clean) return false
  try {
    const r = await api.expertImportDirectory(clean)
    if (r && r.ok) {
      await refreshMarket('')
      pushToast('本地专家目录导入成功', 'ok')
      return true
    }
    pushToast((r && ((r.error && r.error.message) || r.error)) || '导入失败', 'err')
    return false
  } catch (e) {
    pushToast(e.message, 'err')
    return false
  }
}

export async function toggleLocalExpertEnabled(pkg) {
  if (!pkg) return
  try {
    await api.expertSetEnabled(pkg.id, pkg.enabled === false, pkg.active_snapshot || '')
    await refreshMarket('')
  } catch (e) {
    pushToast(e.message, 'err')
  }
}
