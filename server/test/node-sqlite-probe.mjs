// 验证 Node 27 内置 SQLite（node:sqlite）可用性：零原生依赖
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t(id TEXT PRIMARY KEY, payload TEXT)')
db.prepare('INSERT INTO t VALUES (?, ?)').run('s1', '{"ok":true}')
const row = db.prepare('SELECT payload FROM t WHERE id = ?').get('s1')
console.log(JSON.stringify({ ok: true, node: process.version, row }))
db.close()
