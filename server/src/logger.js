/**
 * 日志：pino（生产 JSON 行），默认脱敏一切凭证字段。
 *
 * 红线（沿用 Harbor 既有纪律）：API Key / token / 会话正文不进日志。
 * redact 采用「路径命中即整段置 [redacted]」，覆盖请求头、请求体与配置对象。
 */
import { pino } from 'pino'
import { config } from './config.js'

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'apiKey',
  'api_key',
  'key',
  'token',
  'confirm_token',
  'password',
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.password',
  'config.provider_api_key',
]

/**
 * 应用级 pino 日志器（生产 JSON 行，凭证字段自动脱敏）。
 * @type {object} 已配置 redact 的 logger 实例
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'harbor-server', node: process.version },
  timestamp: pino.stdTimeFunctions.isoTime,
})

/**
 * 创建按域命名的业务子日志器。
 * @type {(scope: string, bindings?: object) => object} 返回带 scope 的 child logger
 */
export const childLogger = (scope, bindings = {}) => logger.child({ scope, ...bindings })
