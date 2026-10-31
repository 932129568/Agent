/**
 * Prisma 连接（Prisma 7 规范）：schema 不含 url，运行期由 driver adapter 连接。
 *
 * 驱动选择（实测）：
 *   - better-sqlite3 在本环境无 node-v153 预编译且 node-gyp 不可用 → 弃用；
 *   - **libsql 在 Node 27 上实测可执行 SQL**，故运行期采用
 *     `@prisma/adapter-libsql` + 生成的 Prisma Client（TypeScript，由 Node 原生
 *     类型擦除直接加载，不需要额外编译步骤）。
 *
 * 表结构由 `prisma/schema.prisma` 定义，`npx prisma db push` 建库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/prisma/client.ts'
import { config } from './config.js'

function resolveSqlitePath(databaseUrl) {
  const raw = String(databaseUrl || '').replace(/^file:/, '')
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}

export const sqlitePath = resolveSqlitePath(config.DATABASE_URL)
fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })

const adapter = new PrismaLibSql({ url: `file:${sqlitePath}` })

export const prisma = new PrismaClient({ adapter })

export async function disconnectDb() {
  await prisma.$disconnect()
}

export const driverName = 'prisma+libsql'
