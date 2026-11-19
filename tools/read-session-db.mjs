/**
 * 只读会话库检查工具（verify-migration 配套）：node tools/read-session-db.mjs <dbPath>
 * 输出 {count, rows:[{id,payload}]}。只读不写；不设 CONFIG_DIR，无副作用。
 */
process.env.DATABASE_URL = `file:${process.argv[2]}`
process.env.LOG_LEVEL = 'silent'
const { prisma, disconnectDb } = await import('../server/src/db.js')
const rows = await prisma.session.findMany()
console.log(JSON.stringify({ count: rows.length, rows: rows.map(r => ({ id: r.id, payload: r.payload })) }))
await disconnectDb()
