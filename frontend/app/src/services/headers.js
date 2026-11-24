/**
 * 唯一请求头 / API Key 非 ASCII 校验器（彻底消灭浏览器 fetch ISO-8859-1 原生 TypeError）。
 * - 设置页表单输入与发请求前共用此纯函数；
 * - 提供 toAsciiJson()：把含中文工作区路径的元数据序列化为纯 ASCII JSON（\uXXXX），
 *   彻底杜绝 Windows 中文目录触发 X-Harbor-Harness 报 NON_LATIN1_HEADER。
 */
import { HarborError } from './errors.js'

export function findNonLatin1Char(value) {
  const s = String(value == null ? '' : value)
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) return { index: i, char: s[i], code: s.charCodeAt(i) }
  }
  return null
}

/** 序列化为 100% 纯 ASCII 合法 JSON（所有 >0x7F 字符自动转 \uXXXX，服务端 JSON.parse 无损还原） */
export function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  )
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
