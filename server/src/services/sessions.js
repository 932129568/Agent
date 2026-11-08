/**
 * 会话读写（Prisma 实现）：与 legacy `get_sessions` / `save_sessions` 同形。
 *
 * 语义保持：
 *   - get_sessions() → JSON 数组字符串，按 updatedAt 倒序；
 *   - save_sessions(data) → 全量覆盖语义（不在列表中的条目删除），事务提交；
 *   - 非法输入（非数组 / 非对象条目）直接报错，不写库。
 */
import { z } from 'zod'
import { prisma } from '../db.js'

const SessionEntry = z.object({
  id: z.union([z.string(), z.number()]),   // P0-1b S4：id 原文类型保真（DB 主键另用 String(id) 索引）
  title: z.any().optional(),
  createdAt: z.any().optional(),
  updatedAt: z.any().optional(),
  runStatus: z.enum(['working', 'completed', 'paused', 'failed']).nullish(),
  projectId: z.any().optional(),
  projectName: z.any().optional(),
  projectWorkspace: z.any().optional(),
}).passthrough()

const SessionList = z.array(SessionEntry)

const toBigInt = (value, fallback = 0) => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? BigInt(Math.trunc(num)) : BigInt(fallback)
}

const toText = (value, fallback = '') => (value == null ? fallback : String(value))

export async function getSessions() {
  const rows = await prisma.session.findMany({ orderBy: { updatedAt: 'desc' } })
  // payload 是 legacy 原文，优先原样返回；列字段只用于排序/索引
  return JSON.stringify(rows.map(row => JSON.parse(row.payload)))
}

export async function saveSessions(data) {
  // P0-1b S3：legacy 校验方言——非法 JSON / 非数组 → 200 + {error:文本}
  // （CPython vs V8 解析器文案天然不同 → ID-104 登记；数组条目校验失败
  // 同走 200+{error}（存储分叉 → ID-101/102 登记 P0-2 复评））
  let parsed
  try {
    parsed = typeof data === 'string' ? JSON.parse(data) : data
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) })
  }
  if (!Array.isArray(parsed)) {
    return JSON.stringify({ error: 'sessions 必须是 JSON 数组，未写入' })
  }
  let entries
  try {
    entries = SessionList.parse(parsed)
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error).slice(0, 400) })
  }
  // R33：删除墓碑 —— 滞后的旧全量数组不得把已删会话写回 DB
  const { readDeletedIds } = await import('./session-migrate.js')
  const deleted = new Set(readDeletedIds())
  entries = entries.filter(entry => !deleted.has(String(entry.id)))
  // R39 修复（S2-7）：空数组 + 存在无墓碑会话 → 拒绝写入（保护性拦截）。
  // deleteMany(notIn=[]) 即清库——过期/损坏的客户端状态（空 localStorage 的
  // 第二窗口早于会话加载）发 [] 会把整库清空。合法「删光所有会话」每条都经
  // session_purge 落墓碑 → 墓碑全覆盖时照常清库；60 条裁剪不发墓碑（裁剪
  // 恒非空数组），不受影响。
  if (!entries.length) {
    const rows = await prisma.session.findMany({ select: { id: true } })
    const unbacked = rows.filter(r => !deleted.has(String(r.id)))
    if (unbacked.length) {
      return JSON.stringify({ error: 'save_sessions 收到空数组，但库中存在 ' +
        unbacked.length + ' 个会话没有删除墓碑——疑似过期状态的全量覆盖，已拒绝写入。' +
        '如确要清空，请逐条删除会话（产生墓碑）后再试。' })
    }
  }
  const keep = entries.map(entry => String(entry.id))

  await prisma.$transaction(async tx => {
    await tx.session.deleteMany(keep.length ? { where: { id: { notIn: keep } } } : undefined)
    for (const entry of entries) {
      const id = String(entry.id)
      const record = {
        title: toText(entry.title),
        createdAt: toBigInt(entry.createdAt, Date.now()),
        updatedAt: toBigInt(entry.updatedAt, Date.now()),
        runStatus: entry.runStatus ?? null,
        projectId: entry.projectId == null ? null : toText(entry.projectId),
        projectName: entry.projectName == null ? null : toText(entry.projectName),
        projectWorkspace: entry.projectWorkspace == null ? null : toText(entry.projectWorkspace),
        payload: JSON.stringify(entry),
      }
      await tx.session.upsert({ where: { id }, create: { id, ...record }, update: record })
    }
  })
  return '{"ok":true}'
}

export async function sessionCount() {
  return prisma.session.count()
}
