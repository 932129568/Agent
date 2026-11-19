/**
 * P0-2 T03 存量明文密钥迁移（§5.2，幂等可重入）：
 *   webdav.json.password / mcp_servers.json 各 server env/headers 中非 'dpapi:'
 *   前缀的值 → DPAPI 加密落盘。
 *
 * 流程：Meta 标记检测 → 无待迁移项写标记退出 → 备份（.pre-dpapi.bak 不覆盖）
 *   → 批量加密原子写回 → 标记最后写（崩溃重入幂等）。
 * DPAPI 不可用 → 保持明文 + W17 warning（不写 done 标记，下次启动重试——
 *   与 Python「不锁死用户配置」同口径）。
 *
 * 纪律：仅生产启动流程（index.js）或显式测试调用触发；模块 import 期零副作用。
 * 备份含明文：保留于同目录 ACL（数据保护红线，不删除——P0-3 提供清理提示）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, atomicWriteJson, readJsonIfExists } from '../paths.js'
import { prisma, ensureSchema } from '../db.js'
import { ENC_PREFIX, isAvailable, encryptValue, encryptField } from './dpapi.js'
import { childLogger } from '../logger.js'

const log = childLogger('dpapi-migrate')

export const DPAPI_META_KEY = 'dpapi-migration-v1.done'
export const DPAPI_BACKUP_SUFFIX = '.pre-dpapi.bak'

function backupOnce(file, suffix = DPAPI_BACKUP_SUFFIX) {
  if (!fs.existsSync(file)) return
  const backup = `${file}${suffix}`
  if (fs.existsSync(backup)) return
  fs.copyFileSync(file, backup)
}

/** 扫描存量明文项：{webdavPassword:boolean, mcpFields:number}。 */
export function scanPlaintextSecrets() {
  const webdav = readJsonIfExists(path.join(CONFIG_DIR, 'webdav.json'), null)
  const webdavPassword = !!(webdav && typeof webdav.password === 'string'
    && webdav.password && !webdav.password.startsWith(ENC_PREFIX))
  let mcpFields = 0
  const mcp = readJsonIfExists(path.join(CONFIG_DIR, 'mcp_servers.json'), { mcpServers: {} })
  for (const cfg of Object.values(mcp.mcpServers || {})) {
    for (const field of ['env', 'headers']) {
      for (const raw of Object.values(cfg?.[field] || {})) {
        const marker = raw && typeof raw === 'object' && typeof raw.__enc__ === 'string' ? raw.__enc__ : raw
        if (typeof marker === 'string' && marker && !marker.startsWith(ENC_PREFIX)) mcpFields += 1
      }
    }
  }
  return { webdavPassword, mcpFields, pending: (webdavPassword ? 1 : 0) + mcpFields }
}

async function writeDoneMarker(value) {
  await prisma.meta.upsert({
    where: { key: DPAPI_META_KEY },
    create: { key: DPAPI_META_KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
}

/** 存量明文迁移主函数（生产启动后台任务）。返回 {ok, migrated?, pending?, error?}。 */
export async function migratePlaintextSecrets() {
  await ensureSchema(prisma)
  const done = await prisma.meta.findUnique({ where: { key: DPAPI_META_KEY } })
  if (done) return { ok: true, already: true, migrated: 0 }
  const pending = scanPlaintextSecrets()
  if (pending.pending === 0) {
    await writeDoneMarker({ at: new Date().toISOString(), skipped: 0 })
    return { ok: true, migrated: 0 }
  }
  if (!(await isAvailable())) {
    // DPAPI 不可用：保持明文 + W17（不写 done 标记——下次启动重试）
    log.warn({ pending: pending.pending }, 'DPAPI 不可用，存量密钥保持明文（W17；下回启动重试）')
    return { ok: false, error: 'DPAPI 不可用，保持明文（W17）', pending: pending.pending }
  }
  let migrated = 0
  // webdav.json.password
  const webdavFile = path.join(CONFIG_DIR, 'webdav.json')
  const webdav = readJsonIfExists(webdavFile, null)
  if (pending.webdavPassword && webdav) {
    backupOnce(webdavFile)
    webdav.password = await encryptValue(webdav.password)
    atomicWriteJson(webdavFile, webdav)
    migrated += 1
  }
  // mcp_servers.json env/headers
  const mcpFile = path.join(CONFIG_DIR, 'mcp_servers.json')
  const mcp = readJsonIfExists(mcpFile, { mcpServers: {} })
  if (pending.mcpFields > 0) {
    backupOnce(mcpFile)
    for (const cfg of Object.values(mcp.mcpServers || {})) {
      for (const field of ['env', 'headers']) {
        if (!cfg?.[field]) continue
        // 该字段前置明文值数（已是标记的原样透传不计入新迁移）
        const pendingInField = Object.values(cfg[field]).filter(raw => {
          const marker = raw && typeof raw === 'object' && typeof raw.__enc__ === 'string' ? raw.__enc__ : raw
          return typeof marker === 'string' && marker && !marker.startsWith(ENC_PREFIX)
        }).length
        const encrypted = await encryptField(cfg[field])
        cfg[field] = encrypted.values
        migrated += pendingInField
      }
    }
    atomicWriteJson(mcpFile, mcp)
  }
  await writeDoneMarker({ at: new Date().toISOString(), migrated })
  log.info({ migrated }, '存量明文密钥 DPAPI 迁移完成')
  return { ok: true, migrated }
}
