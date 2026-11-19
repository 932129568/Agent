/** R64：共享 JS 词法剥离器（gen_allowlist 与 module-inventory 同源）。
 *
 * 单遍扫描：注释/字符串/模板字面量（${} 内按代码递归）/正则字面量（含
 * [字符类] 与 prev-token 除法消歧）之外原样保留，返回「代码骨架」。
 * 从 gen_allowlist.mjs 抽出（R62 引入的实现原样搬迁）——两处共用避免
 * 剥离语义分叉（R59 实测教训：唯一事实源）。
 */

const KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'await', 'yield'])

export function stripCode(src) {
  return stripCodeMap(src).out
}

/** 带位置映射的剥离：out[i] 来自 src[map[i]]（map.length === out.length）。
 * 供死面删除用：在骨架上做括号配对，再映射回 raw 坐标精确删块（免疫
 * 字符串/注释里的花括号与引号）。 */
export function stripCodeMap(src) {
  let out = ''
  const map = []
  let i = 0
  const n = src.length
  const put = (ch) => { out += ch; map.push(i) }
  const putSpace = () => { out += ' '; map.push(i) }
  // 除法 vs 正则字面量消歧：前一个有效字符是标识符字符/)/] → 除法；
  // 前导词是关键字（return /re/ 等）→ 正则；其余（运算符、括号、行首）→ 正则。
  const regexAllowed = () => {
    const t = out.replace(/\s+$/, '')
    if (!t) return true
    const mw = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(t)
    if (mw && KW.has(mw[0])) return true
    return !/[A-Za-z0-9_$)\]]/.test(t.slice(-1))
  }
  const readStr = (q) => {   // i 停在开引号；模板的 ${expr} 递归按代码扫描
    putSpace()
    i++
    while (i < n) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      if (c === q) { i++; return }
      if (q === '`' && c === '$' && src[i + 1] === '{') { i += 2; readExprUntilBrace(); continue }
      i++
    }
  }
  const readExprUntilBrace = () => {   // 消费到与 ${ 配对的 }，内容按代码计入
    let depth = 1
    while (i < n && depth > 0) {
      const c = src[i], d = src[i + 1]
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
      if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { readStr(c); continue }
      if (c === '/' && regexAllowed()) { readRegex(); continue }
      if (c === '{') depth++
      if (c === '}') { depth--; if (depth > 0) put(c); i++; continue }
      put(c); i++
    }
  }
  const readRegex = () => {
    putSpace()
    i++
    let inClass = false
    while (i < n) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      if (c === '[') { inClass = true; i++; continue }
      if (c === ']') { inClass = false; i++; continue }
      if (c === '/' && !inClass) { i++; while (i < n && /[a-z]/i.test(src[i])) i++; return }
      if (c === '\n') { return }   // 未闭合（非常规输入）：按除法回退，不吞行
      i++
    }
  }
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; putSpace(); continue }
    if (c === "'" || c === '"' || c === '`') { readStr(c); continue }
    if (c === '/' && regexAllowed()) { readRegex(); continue }
    put(c); i++
  }
  return { out, map }
}

/** 顶层函数/const 声明名提取（配合 stripCode 的骨架用；粗粒度，够盘点用）。 */
export function topLevelSymbols(src) {
  const clean = stripCode(src)
  const names = new Set()
  for (const m of clean.matchAll(/(?:^|\n)\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of clean.matchAll(/(?:^|\n)\s{0,4}(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of clean.matchAll(/(?:^|\n)\s{0,4}class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return [...names]
}
