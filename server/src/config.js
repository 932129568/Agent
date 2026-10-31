/**
 * 运行配置：zod 校验的环境变量（Node 27 基线，ESM）。
 *
 * 安全默认：
 *   - HOST 仅允许 loopback——本服务是桌面应用的本地后端，绑定 0.0.0.0 会把
 *     文件/命令执行能力暴露给局域网，属于越权面扩大，配置层直接拒绝。
 *   - AUTH_ENABLED 默认 false：保留单机单用户语义。开启认证属于独立变更，
 *     不允许随依赖引入而隐式改变所有接口的鉴权边界。
 */
import { z } from 'zod'

const LoopbackHost = z.string().refine(
  value => ['127.0.0.1', 'localhost', '::1'].includes(value),
  { message: 'HOST 仅允许 loopback（127.0.0.1 / localhost / ::1）' },
)

const EnvSchema = z.object({
  HOST: LoopbackHost.default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('file:./data/harbor.db'),
  AUTH_ENABLED: z.enum(['true', 'false']).default('false'),
  /** 前端源（开发期 vite dev server）；生产为 file:// 桌面壳，无需 CORS */
  CORS_ORIGIN: z.string().optional(),
})

export const config = EnvSchema.parse({
  HOST: process.env.HOST,
  PORT: process.env.PORT,
  LOG_LEVEL: process.env.LOG_LEVEL,
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_ENABLED: process.env.AUTH_ENABLED,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
})

export const isLoopback = value => ['127.0.0.1', 'localhost', '::1'].includes(value)
