/**
 * P0-2 T03 存储安全诊断端点（Q6 裁定：非 js_api fastify 普通路由——
 * 不占 145 契约面、不违 get_api_info 冻结）。
 *
 * GET /storage/security → {dpapi_available, source, webdav:{plaintext_password},
 *   mcp:{plaintext_fields}, migration:{done, pending}}
 * 供 P0-3 设置面板常驻提示/首启横幅轮询。仅状态计数——绝不回显任何密码明文。
 *
 * P0-4 T02（设计 §3.1）：增 source 字段披露 DPAPI codec 路径
 *   'electron-safeStorage' | 'powershell' | 'unavailable'——判定取自
 *   dpapi.js activeCodecPath()（唯一事实源；dpapi.js T02 修订注：路径 1 默认
 *   停用、HARBOR_SAFESTORAGE=1 选回）。旁路端点加字段=不占契约面。
 */
import { isAvailable, activeCodecPath } from '../services/dpapi.js'
import { scanPlaintextSecrets } from '../services/dpapi-migrate.js'
import { prisma } from '../db.js'

export async function storageStatusRoutes(app) {
  app.get('/storage/security', async () => {
    const [available, pending] = await Promise.all([isAvailable(), Promise.resolve(scanPlaintextSecrets())])
    let done = false
    try {
      done = !!(await prisma.meta.findUnique({ where: { key: 'dpapi-migration-v1.done' } }))
    } catch { /* Meta 未建表（历史库）→ done=false */ }
    return {
      dpapi_available: available,
      source: available ? activeCodecPath() : 'unavailable',
      webdav: { plaintext_password: pending.webdavPassword },
      mcp: { plaintext_fields: pending.mcpFields },
      migration: { done, pending: pending.pending },
    }
  })
}
