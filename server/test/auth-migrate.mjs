/**
 * 初始化 better-auth 数据表：走 auth context 自带的 runMigrations
 * （官方 @better-auth/cli 依赖 better-sqlite3，本环境装不了，故用程序内入口）。
 */
import { auth } from '../src/auth.js'

const ctx = await auth.$context
await ctx.runMigrations()
console.log(JSON.stringify({ ok: true, step: 'better-auth tables migrated via ctx.runMigrations' }))
process.exit(0)
