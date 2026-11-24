/**
 * 唯一请求头 / API Key 非 ASCII 校验器（彻底消灭浏览器 fetch ISO-8859-1 原生 TypeError）。
 * 设置页表单输入与发请求前共用此纯函数。
 */
import { HarborError } from './errors.js'

export function findNonLatin1Char(value) {
  const s = String(value == null ? '' : value)
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) return { index: i, char: s[i], code: s.charCodeAt(i) }
  }
  return null
}

export function assertLatin1Value(fieldName, value, hint = '请只输入英文数字与半角符号') {
  const bad = findNonLatin1Char(value)
  if (!bad) return String(value == null ? '' : value)
  throw new HarborError(
    'NON_LATIN1_HEADER',
    `${fieldName} 含非法字符「${bad.char}」（第 ${bad.index + 1} 个字符，非 ASCII）。${hint}`,
    { hint }
  )
}

export function assertLatin1Headers(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue
    assertLatin1Value(`请求头 ${k}`, v, '请检查「设置 → 模型连接」里的 API Key 或 Base URL 是否混入中文/全角字符')
    out[k] = String(v)
  }
  return out
}
