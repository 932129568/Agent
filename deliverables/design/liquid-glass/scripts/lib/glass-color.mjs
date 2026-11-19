/* ============================================================================
   scripts/lib/glass-color.mjs —— 颜色/令牌解析的唯一实现
   ----------------------------------------------------------------------------
   契约 §11 D14 / §12 D19：`verify.mjs`（门禁）与 `verify-optics.mjs`（光学）
   必须共用**同一份**解析代码。此前的状态是两套：
     · verify.mjs   —— 已带 D10 的渐变硬前置 + gradientStops + expandVars
     · verify-optics.mjs —— 朴素的 /[\d.]+/g，`rgba(var(--x), .072)` 会返回 alpha=1
   两套实现让"同一个令牌"在两个判据里取值不同（OPT-08 的 alpha=1 就是这么来的），
   所以这里抽成一份，任何改动只改这一处。

   导出（语义与原实现逐字一致，只搬家，不改行为）：
     toRgb / alphaOf / gradientStops / expandVars / overRgba
   ============================================================================ */

/* toRgb：渐变入口硬前置（D10）。
   旧实现对渐变跑 /[\d.]+/g 会把几何参数（85/75/50）当 rgb、42 当 alpha ——
   必须抛错，不许产出"看起来正常"的垃圾值。 */
export function toRgb(s) {
  const str = String(s);
  if (/gradient\(/i.test(str)) {
    throw new Error('toRgb() 不接受渐变，请走 gradientStops()：' + str.slice(0, 80));
  }
  const v = str.trim();
  if (v.charAt(0) === '#') {
    let h = v.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = v.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : null;
}

/* alphaOf：同 toRgb，渐变直接抛（避免"换个函数就绕过防御"）。 */
export function alphaOf(s) {
  const str = String(s);
  if (/gradient\(/i.test(str)) {
    throw new Error('alphaOf() 不接受渐变，请走 gradientStops()：' + str.slice(0, 80));
  }
  const m = str.match(/[\d.]+/g);
  return m ? (m[3] === undefined ? 1 : +m[3]) : 0;
}

/* gradientStops：只认颜色，不认几何；`at` 不参与加权（WCAG 按最不利位置判定）。 */
export function gradientStops(str) {
  const s = String(str || '');
  if (!/gradient\(/i.test(s)) return null;
  const out = [];
  const re = /((?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8})\s*([\d.]+%)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const rgb = toRgb(m[1]);
    if (!rgb) continue;
    out.push({ rgb, a: alphaOf(m[1]), at: m[2] === undefined ? null : parseFloat(m[2]) });
  }
  return out;
}

/* expandVars：把 var(--x[, fallback]) 递归展开（深度上限 8，防循环）。
   为什么必须前置：`rgba(var(--scrim-rgb), .072)` 未展开时 alphaOf 取不到 .072
   （返回 1），别名形式的令牌会被当成"缺失"。展开后就是浏览器实际使用的值。 */
export function expandVars(map) {
  const one = (v, depth) => {
    if (depth > 8) return v;
    return String(v).replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
      (all, name, fb) => {
        const raw = map[name] !== undefined ? map[name] : fb;
        if (raw === undefined || raw === null) return all;
        return one(String(raw).trim(), depth + 1);
      });
  };
  const out = {};
  for (const k of Object.keys(map)) out[k] = one(map[k], 0);
  return out;
}

/* overRgba：把带 alpha 的前景色合成到不透明底色上（WCAG 合成口径）。
   fg 可以是 rgb 数组（此时必须显式给 alpha）或颜色字符串（自动取 alpha）。
   为什么加第三个参数：原实现只收数组、内部又对数组调 alphaOf，字符串化后
   只剩 3 个数字 ⇒ alpha 恒为 1；单色 fill 一旦走到这条分支就会算出"实心"。
   当前 C03 的被测令牌都是渐变，走不到这里，所以数值一字未变；但接口不能留着坑。 */
export function overRgba(fg, bg, alpha) {
  const a = alpha === undefined ? (typeof fg === 'string' ? alphaOf(fg) : 1) : alpha;
  const c = typeof fg === 'string' ? toRgb(fg) : fg;
  return [c[0] * a + bg[0] * (1 - a), c[1] * a + bg[1] * (1 - a), c[2] * a + bg[2] * (1 - a)];
}
