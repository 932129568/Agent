/**
 * Prisma 7 配置（破坏性变更适配）：
 *   `datasource.url` 已从 schema.prisma 移除，连接串统一收敛到本文件；
 *   运行期连接由 driver adapter（@prisma/adapter-better-sqlite3）承担，
 *   不再依赖 schema 内的 env("DATABASE_URL")。
 */
import { defineConfig } from 'prisma/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  schema: path.join(here, 'prisma', 'schema.prisma'),
  migrations: { path: path.join(here, 'prisma', 'migrations') },
  datasource: {
    // 本地 SQLite 文件，不引入外部数据库服务（桌面单机语义保持不变）
    url: process.env.DATABASE_URL || `file:${path.join(here, 'data', 'harbor.db')}`,
  },
})
