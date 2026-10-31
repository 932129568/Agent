/**
 * better-auth 端到端验证：liveness → 注册 → 登录。
 * 走 fastify 真实路由（app.inject），证明认证能力已实际接入而非仅安装。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-auth-flow-'))
process.env.HARBOR_CONFIG_DIR = path.join(tmp, 'config')
process.env.DATABASE_URL = `file:${path.join(tmp, 'app.db')}`
process.env.LOG_LEVEL = 'silent'

const { buildServer } = await import('../src/app.js')
const { auth } = await import('../src/auth.js')
const { disconnectDb } = await import('../src/db.js')

// 认证表走官方迁移（与 Prisma 的 Session 表分库，避免同名冲突）
const ctx = await auth.$context
await ctx.runMigrations()

const app = await buildServer()
const email = `u${Date.now()}@local.test`
const password = 'local-only-pass-123'

try {
  const ok = await app.inject({ method: 'GET', url: '/api/auth/ok' })
  assert.equal(ok.statusCode, 200, 'better-auth /ok 应可用')
  assert.equal(JSON.parse(ok.body).ok, true)

  const signUp = await app.inject({
    method: 'POST', url: '/api/auth/sign-up/email',
    payload: { email, password, name: '本机用户' },
  })
  assert.equal(signUp.statusCode, 200, `注册失败: ${signUp.body}`)
  const up = JSON.parse(signUp.body)
  assert.ok(up.user && up.user.id, '注册应返回用户')

  const signIn = await app.inject({
    method: 'POST', url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  assert.equal(signIn.statusCode, 200, `登录失败: ${signIn.body}`)
  const session = JSON.parse(signIn.body)
  assert.ok(session.user && session.user.email === email)
  const setCookie = signIn.headers['set-cookie']
  assert.ok(setCookie, '登录应下发会话 Cookie')

  const badLogin = await app.inject({
    method: 'POST', url: '/api/auth/sign-in/email',
    payload: { email, password: 'wrong-password' },
  })
  assert.ok(badLogin.statusCode >= 400, '错误密码必须被拒绝')

  console.log(JSON.stringify({
    ok: true, node: process.version,
    checks: ['/api/auth/ok 存活', '邮箱注册成功', '登录成功并下发 Cookie', '错误密码被拒绝'],
  }, null, 2))
} finally {
  await app.close()
  await disconnectDb()
}
