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

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'harbor-server', node: process.version },
  timestamp: pino.stdTimeFunctions.isoTime,
})

/** 业务子日志（按域命名，便于检索）。 */
export const childLogger = (scope, bindings = {}) => logger.child({ scope, ...bindings })
