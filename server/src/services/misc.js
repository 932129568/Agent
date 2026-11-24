/**
 * 搜索缓存统计、历史目录配置与审计门面（审计哈希链已下沉至独立叶子模块 audit.js，
 * 彻底消除 browser ↔ guard ↔ misc 循环依赖，同时保留同名导出 100% 兼容既有调用方与测试）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '../paths.js'
import { readConfigJson, mergeConfig, readConfigNormalized } from './jsonstore.js'
import { CONFIG_SPECS } from './config-specs.js'
import { runtime } from '../runtime.js'
import { currentDbPath, switchDatabaseCore, withDbSwitchLock } from '../db.js'
import { materializeSessions } from './session-migrate.js'
export { guardAudit, getAuditLog } from './audit.js'

const okJson = (value) => JSON.stringify(value)

/* ---------------- 搜索缓存统计 / 历史目录（不变） ---------------- */
/** 读取器统计的进程起点（search_reader._started_at = time.time() 同口径）。 */
const READER_STARTED_AT = Date.now() / 1000

export async function searchCacheStats() {
  // P0-1c CF5（service.py:1329-1387）：{ok, entries, hits, misses, ttl_minutes,
  // ttl_classes, size_kb}——entries/size_kb 按落盘文件实时统计（ttl_class 缺分类
  // 计入 general）；hits/misses 为进程内计数（Node 搜索缓存未迁移 → 0 起步，
  // 与 Python 空起步一致）；size_kb = int(bytes/1024) 截断
  const dir = path.join(CONFIG_DIR, 'search_cache')
  let entries = 0
  let size = 0
  const ttlClasses = { news: 0, general: 0, encyclopedia: 0 }
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) continue
        entries += 1
        size += stat.size
        let cls = 'general'
        try { cls = (JSON.parse(fs.readFileSync(file, 'utf8') || '{}') || {}).ttl_class || 'general' } catch { /* 分类失败计入 general */ }
        if (Object.hasOwn(ttlClasses, cls)) ttlClasses[cls] += 1
      } catch { /* OSError continue（service.py 同款防御） */ }
    }
  }
  return okJson({ ok: true, entries, hits: 0, misses: 0, ttl_minutes: 60,
    ttl_classes: ttlClasses, size_kb: Math.trunc(size / 1024) })
}

export async function searchReaderStats() {
  // P0-1c CF6（search_reader.stats:154-162）：{ok, reader_calls, schema_fail,
  // degrade_count, local_available, configured, last_error, since}——Node 读取器
  // 未迁移，计数器 0/false/'' 起步与 Python 空态一致；configured 按 reader.json
  // base_url 判定（归一化读取）；since=进程起点 epoch（N 规则掩蔽键）
  const { config } = readConfigNormalized(CONFIG_SPECS.reader)
  return okJson({ ok: true, reader_calls: 0, schema_fail: 0, degrade_count: 0,
    local_available: true, configured: !!String(config.base_url || '').trim(),
    last_error: '', since: READER_STARTED_AT })
}

export async function searchStatus(taskId = '') {
  const { searchStatus: browserSearchStatus } = await import('./browser.js')
  return browserSearchStatus(taskId)
}

export async function historyDirGet() {
  const cfg = readConfigJson('history.json', {})
  const dir = cfg.dir || ''
  // P0-2（ID-103 新口径）：sessions_file 披露当前生效 DB 文件路径——
  // 介质披露（Python 为 sessions.json、Node 为 Prisma 库文件），与 ID-001/202 同构
  return okJson({ ok: true, dir, default_dir: CONFIG_DIR, sessions_file: currentDbPath() })
}

export async function historyDirSet(dirPath, migrate = false) {
  // P0-2 T02（ID-103 落地）：history_dir_set = 历史 DB 存放位置切换 + 数据搬移
  // （config_service.history_dir_set:243-287 等价语义）——非仅物化静态副本：
  // 切换后新会话写入跟随新目录（用户意图的忠实实现）。
  const input = String(dirPath || '').trim()
  if (!input) {
    // 恢复默认：切回默认库并写空 dir（migrate 语义在恢复路径不触发，同 Python）
    const switched = await withDbSwitchLock(() => switchDatabaseCore(path.join(CONFIG_DIR, 'harbor.db')))
    if (switched.error) return okJson({ error: switched.error })
    await mergeConfig('history.json', JSON.stringify({ dir: '' }))
    return okJson({ ok: true, dir: '', migrated: false, migrated_from: '' })
  }
  let target
  try { target = fs.realpathSync(path.resolve(input)) } catch { return okJson({ error: `目录不存在：${input}（请先创建）` }) }
  if (!fs.statSync(target).isDirectory()) return okJson({ error: `目录不存在：${input}（请先创建）` })
  try { fs.accessSync(target, fs.constants.W_OK) } catch { return okJson({ error: `目录不可写：${target}` }) }
  const normalized = target.replace(/[\\/]+$/, '').toLowerCase()
  const sensitive = [process.env.WINDIR || 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter(Boolean).map(x => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase())
  const driveRoot = path.parse(target).root.replace(/[\\/]+$/, '').toLowerCase()
  if (normalized === driveRoot || sensitive.some(x => normalized === x || normalized.startsWith(x + path.sep))) {
    return okJson({ error: `不能使用系统目录：${target}` })
  }
  // 互斥锁整段（W4：校验-迁移-落 history.json 与并发切换不得交错）
  return withDbSwitchLock(async () => {
    const sourceDb = currentDbPath()
    const targetDb = path.join(target, 'harbor.db')
    let migrated = false
    let migratedFrom = ''
    if (migrate && fs.existsSync(sourceDb)
      && path.resolve(path.dirname(sourceDb)).toLowerCase() !== path.resolve(target).toLowerCase()) {
      // 迁移源取当前生效库（W9 口径）；目标已存在 → 跳过不覆盖（migrated 保持 false）
      if (!fs.existsSync(targetDb)) {
        try {
          // R40 修复（S2-6）：拷贝前对活体库做 WAL checkpoint(TRUNCATE)——
          // 原直接 copyFileSync，已提交事务还在 -wal 文件里，拷出的 .db 缺
          // 尾部事务（目标库静默丢数据）。checkpoint 失败仍拷（退化为原行为）。
          const { prisma } = await import('../db.js')
          await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
          fs.copyFileSync(sourceDb, targetDb)
          // 复制 DB 文件 → 物化导出 sessions.json 到目标目录（legacy 可读副本）
          await materializeSessions(path.join(target, 'sessions.json'))
          migrated = true
          migratedFrom = sourceDb
        } catch (error) { return okJson({ error: `迁移失败: ${error.message}` }) }
      }
    }
    // 切换 DB：migrate=false 目标为空库（不存在则建库+schema），旧库原地保留
    // （Core 内核——本函数已持整段互斥锁，勿再取公共包装锁防自死锁）
    const switched = await switchDatabaseCore(targetDb)
    if (switched.error) return okJson({ error: switched.error })
    await mergeConfig('history.json', JSON.stringify({ dir: target }))
    return okJson({ ok: true, dir: target, migrated, migrated_from: migratedFrom })
  })
}
