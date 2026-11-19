/* ============================================================================
   R73 · 「光井 / LIGHTWELL」—— scripts/verify-optics.mjs
   独立光学判据（OPT-01 … OPT-18），实现 deliverables/design/r73-OPTICS-SPEC.md §9。
   其中 OPT-13/14/15/17 是像素级（Playwright + PNG 解码），OPT-16 是窄档几何+像素预算，

   用法：node scripts/verify-optics.mjs [--root <design目录>] [--out <输出目录>] [--only OPT-13,OPT-14]
     --root  待测交付目录（默认本脚本的上一级）。用于「区分力取证」：把 R72-L
             快照复制到临时目录后以 --root 指过去，按同一把尺子测量。
     --out   结果输出目录（默认 <root>/qa）。基线取证时指向临时目录，避免污染交付。
     --only  只跑指定判据（调试用；跳过的判据在汇总里列入 notImplemented）。

   产出：<out>/optics-result.json + <out>/after/optics-{light,dark}-1440.png

   ★ 本文件与 scripts/verify.mjs 共用 **scripts/lib/glass-color.mjs**（契约 §11 D14 /
     §12 D19）：toRgb / alphaOf / gradientStops / expandVars / overRgba 只有一份实现。
     在此之前两边各有一套，`rgba(var(--x), .072)` 在门禁侧是 .072、在本文件里是 1
     —— 同一个令牌两个取值，OPT-08 的 alpha=1 就是这么来的。
     （其余部分仍互相独立：不 import verify.mjs，也不被它 import，避免并行改 CSS 的竞态。）

   ★ 每条 OPT 都是**三件套**，缺一不可：
       ① 锚点自检  —— 判据依赖的选择器/令牌必须先在源文件里找到，否则判据会因
                      「找不到元素」而空转通过（假绿）；
       ② 正样本断言 —— 对当前交付目录的真实取值下判断；
       ③ 反例注入  —— 按 SPEC §9 给的注入方式破坏一处，**必须观测到 FAIL**，然后还原。
                      注入后仍然 PASS ⇒ 该判据没有区分力 ⇒ 本条 OPT 自身判 FAIL。
     注：可见性一律用 checkVisibility({checkOpacity, checkVisibilityCSS}) +
         getClientRects().length 交叉校验，禁止 `!hidden && display !== 'none'` 这类
         三态恒真写法（R72-L 的恒真判据事故）。
   ============================================================================ */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
/* 与 verify.mjs 共用同一份颜色/令牌解析（契约 §11 D14 / §12 D19）。 */
import { toRgb, alphaOf, gradientStops, expandVars, overRgba } from './lib/glass-color.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (k, dflt) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/* DESIGN = 被测量的交付目录；PROJ = 本脚本所属工程（playwright 依赖永远从这里取，
   这样 --root 指向临时快照时仍能解析 playwright-core）。 */
const DESIGN = resolve(argOf('--root', resolve(HERE, '..')));
const OUT = resolve(argOf('--out', join(DESIGN, 'qa')));
const PAGE = join(DESIGN, 'index.html');
const PROJ = resolve(HERE, '..', '..', '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r73-optics-edge-'));
const requireFromProj = createRequire(pathToFileURL(join(PROJ, 'package.json')).href);
const { chromium } = requireFromProj('./server/node_modules/playwright-core');

const SRC_FILES = {
  html: join(DESIGN, 'index.html'),
  base: join(DESIGN, 'styles', 'base.css'),
  tokens: join(DESIGN, 'styles', 'tokens.css'),
  components: join(DESIGN, 'styles', 'components.css'),
  views: join(DESIGN, 'styles', 'views.css'),
  main: join(DESIGN, 'scripts', 'main.js')
};
const SRC = {};
for (const [k, p] of Object.entries(SRC_FILES)) {
  SRC[k] = existsSync(p) ? readFileSync(p, 'utf8') : '';
}
const SRC_ALL = Object.values(SRC).join('\n');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'after'), { recursive: true });

/* --------------------------------------------------------------- 结果容器 */
const R = { root: DESIGN, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], summary: {} };
let CURRENT = null;

function record(id, ok, parts) {
  const row = { id, ok: !!ok, ...parts };
  R.checks.push(row);
  CURRENT = row;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag} ${id} — ${row.title || ''}`);
  if (row.anchor) console.log(`     锚点  : ${row.anchor.detail}`);
  if (row.positive) console.log(`     正样本: ${row.positive.ok ? 'ok' : 'MISS'} — ${row.positive.detail}`);
  if (row.injection) console.log(`     反例  : ${row.injection.ok ? 'ok(已翻红)' : 'MISS'} — ${row.injection.detail}`);
  return row;
}

/* 统一驱动器：锚点 → 正样本 → 反例注入。任一段不成立即本条 FAIL。 */
async function runOpt(id, title, spec) {
  const parts = { title, anchor: null, positive: null, injection: null };
  /* ① 锚点自检 */
  try {
    const a = spec.anchor();
    parts.anchor = { ok: true, detail: a || 'ok' };
  } catch (e) {
    parts.anchor = { ok: false, detail: String(e && e.message ? e.message : e) };
    return record(id, false, parts);
  }
  /* ② 正样本 */
  let pres;
  try {
    pres = await spec.positive();
    parts.positive = { ok: !!pres.ok, detail: String(pres.detail) };
  } catch (e) {
    parts.positive = { ok: false, detail: 'probe error: ' + String(e && e.message ? e.message : e) };
    return record(id, false, parts);
  }
  /* ③ 反例注入：注入态必须被观测为 FAIL，随后还原 */
  if (spec.injection) {
    try {
      const i = await spec.injection(pres);
      parts.injection = { ok: !!i.ok, detail: String(i.detail) };
    } catch (e) {
      parts.injection = { ok: false, detail: 'inject error: ' + String(e && e.message ? e.message : e) };
    }
  } else {
    parts.injection = { ok: false, detail: '未实现反例注入' };
  }
  return record(id, parts.anchor.ok && parts.positive.ok && parts.injection.ok, parts);
}

/* 单条 OPT 崩溃不影响后续判据继续取证（结果里留痕） */
/* --only OPT-13,OPT-14 调试用：只跑指定判据（不写记录，汇总里归入 notImplemented）。
   默认空 = 全量跑。 */
const ONLY = String(argOf('--only', '')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
async function guard(id, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  try { await fn(); } catch (e) {
    record(id, false, {
      title: '(执行异常)',
      anchor: null,
      positive: { ok: false, detail: String(e && e.stack ? e.stack : e) },
      injection: null
    });
  }
}

/* 锚点断言：needle 必须出现在指定源文件里（先证判据有依赖对象） */
function assertAnchor(fileKey, needle, why) {
  const text = SRC[fileKey];
  if (!text) throw new Error(`锚点缺失：${fileKey} 文件不存在或为空（${SRC_FILES[fileKey]}）`);
  if (text.indexOf(needle) < 0) throw new Error(`锚点缺失：${fileKey} 中找不到 "${needle}"${why ? '（' + why + '）' : ''}`);
  return `${fileKey} ✓ "${needle}"`;
}
function assertAnchorRe(fileKey, re, why) {
  const text = SRC[fileKey];
  if (!re.test(text)) throw new Error(`锚点缺失：${fileKey} 中无 /${re.source}/${why ? '（' + why + '）' : ''}`);
  return `${fileKey} ✓ /${re.source}/`;
}
/* 反向锚点：判据依赖"某物不该出现"，需先证明它在源文件里确实可能出现 */
function assertAbsent(fileKey, needle, why) {
  const text = SRC[fileKey];
  if (text.indexOf(needle) >= 0) throw new Error(`反向锚点失败：${fileKey} 仍含 "${needle}"${why ? '（' + why + '）' : ''}`);
  return `${fileKey} ✓ 不含 "${needle}"`;
}
/* 自身锚点：needle 必须出现在**本脚本源码**里 —— 防"把判据删掉，判据就绿了"。
   为什么不并进 SRC_FILES：那张表专收**被测交付目录**里的文件，把本脚本塞进去会
   污染其它判据的全文扫描（SRC_ALL 以及任何 indexOf 都可能命中自己的文案）。
   这里用 import.meta.url 直接读自己，干净且不改变既有锚点语义。 */
const SELF_SRC = (() => {
  try { return readFileSync(fileURLToPath(import.meta.url), 'utf8'); } catch (e) { return ''; }
})();
function assertSelfAnchor(needle, why) {
  if (!SELF_SRC) throw new Error('自身锚点不可用：读不到本脚本源码');
  if (SELF_SRC.indexOf(needle) < 0) throw new Error(`自身锚点缺失：verify-optics.mjs 中找不到 "${needle}"${why ? '（' + why + '）' : ''}`);
  return `verify-optics.mjs ✓ "${needle}"`;
}

/* --------------------------------------------------------------- 数值工具 */
/* toRgb / alphaOf / gradientStops / expandVars / overRgba 已移到
   scripts/lib/glass-color.mjs（与 verify.mjs 共用）。此处只保留本文件专用的
   亮度与比值。 */
function lum(c) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
/* over(fg with alpha, opaque bg) → opaque rgb（实现就是 lib.overRgba，此处只保留本地名） */
function over(fgStr, bgRgb) {
  return overRgba(fgStr, bgRgb);
}
/* 顶层逗号切分（rgba() 内的逗号不算） */
function splitTop(str) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(str)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}
/* backgroundColor 链合成：chain = [自身, 父, 祖父, …]，自底向上 over 到一层不透明为止。
   用途：OPT-14(D 段) / OPT-15 要一个"可复现的底色对照组"。
   只吃 backgroundColor，**不吃 background-image** —— 渐变的第一层色标怎么取是主观的，
   而底色链是逐层可复算的。全透明层直接跳过（不要把底下的实底洗掉）。 */
function chainLum(chain) {
  const list = (chain || []).map(s => String(s).trim()).filter(Boolean);
  if (!list.length) return null;
  const opaque = s => { const a = s.match(/[\d.]+/g); if (!a) return false; return a.length < 4 || +a[3] >= 0.999; };
  let i = list.length - 1;
  while (i > 0 && !opaque(list[i])) i--;
  let base;
  try { base = toRgb(list[i]); } catch (e) { return null; }
  for (let k = i - 1; k >= 0; k--) {
    const a = alphaOf(list[k]);
    if (!Number.isFinite(a) || a === 0) continue;
    try { base = over(list[k], base); } catch (e) { /* 单层解析失败不推翻整条链 */ }
  }
  return lum(base);
}

/* 解析 tokens.css 的指定块（块内可含注释）
   ★ 必须先剥注释再匹配（本轮修的一个真 bug）：
     原实现对**原始文本**跑 /--([\w-]+)\s*:\s*([^;]+);/g，而 CSS 注释里一旦出现
     `--light-x:22% / --light-y:-8%` 这种"注释里提到令牌+冒号"的写法，
     那条匹配会把注释后半段连同**后面几条真实声明**一起吞进 --light-x 的值里，
     直到下一个分号为止 —— 于是 `--plate-ao` 直接消失（OPT-08 报"令牌缺失"）。
     这不是 CSS 写错，是解析器的锅：注释是给人看的，不该参与取值。
     剥注释还有一个附带好处：值里不再残留行尾注释，alphaOf/toRgb 的输入更干净。 */
function blockVars(text, selectorRe) {
  const src = stripComments(String(text));
  const m = src.match(selectorRe);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(start + 1, i);
  const out = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let mm;
  while ((mm = re.exec(body)) !== null) out[mm[1]] = mm[2].trim();
  return out;
}
/* 取某条规则的声明体（大括号配对，支持嵌套 at-rule） */
function cssRuleText(text, selectorRe) {
  const m = String(text).match(selectorRe);
  if (!m) return null;
  const start = text.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0, i = start;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  return text.slice(start + 1, i);
}
/* 收集所有「选择器里含 needle」的扁平规则声明体（级联下任一条生效即可） */
function ruleBodiesMatching(text, needle) {
  const t = stripComments(String(text));
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m[1].indexOf(needle) >= 0) out.push(m[2]);
  }
  return out;
}
/* ★ D14（契约 §11）：令牌别名必须先展开再解析。
   实现已并入 scripts/lib/glass-color.mjs（与 verify.mjs 共用），此处只调用。
   为什么必须前置：`--plate-ao: rgba(var(--scrim-rgb), .072)` 若原样交给 alphaOf()，
   取到的是 `var(--scrim-rgb)` 里的数字（或取不到）⇒ 返回 **1**；而任何 `var()`
   形式的别名（`--color-faint: var(--ink-3)` 之类）会被当成"令牌缺失"。
   这是**纯解析层**修复，断言语义零变化：展开后的值就是浏览器实际使用的值。 */
const TOK_L = expandVars(blockVars(SRC.tokens, /^[ \t]*:root\s*\{/m) || {});
const TOK_D = expandVars(blockVars(SRC.tokens, /^[ \t]*\[data-theme=["']dark["']\]\s*\{/m) || {});

/* ============================================================================
   OPT-08 · 亮度预算常量上限（**纯源码**，不启浏览器）
   给"判据看不见 background-image"上锁：把 §2/§3 的 alpha 上限写成可验常量，
   并按 WCAG 复算最坏叠层后的 faint 对比度。
   叠层模型（与 SPEC §7 令牌影响表逐条对齐，已用 SPEC 自己的数字回归校验）：
     · --plate-ao 落在 T1/T2（surface / raised 底）→ 复算 faint/surface
       明 .055 ⇒ 4.73（SPEC §7 原文即 4.73 ✓）、明 .12 ⇒ 4.19（SPEC §9 注入用例 ✓）
     · --plate-ao 在 T4（code-bg 底）被 SPEC §2.1 明令**禁用** → code-bg 上的
       最坏叠层只有 --plate-grid，复算 faint/code-bg（基线 4.76）
   ----------------------------------------------------------------------------
   ★ 本轮（主理人裁决）两处改动，都是为了把"猜值"换成"实测反推"：
     ① --plate-ao 明色上限 .06 → **由地色余量反推**（现测 .081；遮色一换会自动跟随，
        见 aoCeilL 的推导注释与 out.aoLimit 的非线性临界值）。
        旧 .06 没有任何出处；而台面材质栈的 5 层里 80% 是安慰剂，正是"上限靠猜"
        的直接后果 —— ao 是唯一真能看见的层，却和看不见的层共用一个猜出来的天花板。
     ② 新增 --plate-cone 上限（明 .24 / 暗 .06）+ 一条**真正的新约束**：
        cone 是**提亮**层，提亮抬高地色 ⇒ faint 对地色的对比度只会升高，
        所以"提亮后仍 ≥4.5"在数学上恒成立 —— 但它每次都真算一遍并打印数值，
        因为一旦 cone 从白色改成**带彩度**的色（往下压地色），这条立刻变成有效约束。
       它不是纯放宽：明 .08 → .24 放开的是"看得见"的空间，同时用 faint 复算锁住"看得清"。
   ========================================================================== */
function plateBudget(o = {}) {
  const L = TOK_L, D = TOK_D;
  const pick = (v, k) => (o[k] !== undefined ? o[k] : v[k]);
  const aoL = pick(L, 'plate-ao'), aoD = pick(D, 'plate-ao');
  const shL = pick(L, 'plate-sheen'), shD = pick(D, 'plate-sheen');
  const grL = pick(L, 'plate-grid'), grD = pick(D, 'plate-grid');
  const cnL = pick(L, 'plate-cone'), cnD = pick(D, 'plate-cone');
  const out = { ceilings: [], ratios: [] };

  const ceil = (label, val, max) => {
    if (val === undefined) {
      out.ceilings.push({ label, val: '(缺失)', alpha: NaN, max, ok: false });
      return;
    }
    const a = alphaOf(val);
    out.ceilings.push({ label, val, alpha: a, max, ok: Number.isFinite(a) && a <= max + 1e-9 });
  };

  /* ---- --plate-ao 明色上限：由「地色余量」实测反推，不再硬编码 ----------------
     推导（与主理人裁决同源）：
       台面（.stage）的地色 = --color-bg，L=.8768；台面内有 18 个 11px 的
       --color-faint(#5E6C64, L=.1402) 落字，现状对比度 (L+.05)/(.1402+.05) = 4.87:1。
       压到 4.5 时地色 L 最低 = 4.5×(.1402+.05) − .05 = .8061
       ⇒ 可用的 ΔL 余量 = .8768 − .8061 = .0707。
       ΔL 的全部潜力 = 地色 L − L(遮色本身)（α=1 时的落差）
       ⇒ 名义 α 上限 = 余量 / 潜力。
     两个**随令牌自动跟随**的实例（说明这条不是写死的）：
       · 遮色 rgba(11,58,42)（原绿）→ 潜力 .8442 ⇒ 上限 .083（→ 落地 .075 留边）
       · 遮色 rgba(20,30,26)（现近中性）→ 潜力 .8653 ⇒ 上限 .081
     ★ D14 修正（别名展开后实测，旧注释里的 .8768/.1402/.083 是**未展开时**的错值）：
       地色 --color-bg = #FAF9F5 ⇒ L=.9467；faint 展开后 L=.1093（现状 6.257:1）
       ⇒ 余量 .2798、潜力 .9397、线性代理上限 **.297**；
       非线性复算（当前遮色 rgba(20,20,19)）临界 **.1131** ⇒ 生效上限取二者更紧者 .1131。
       旧注释「落地 .075」写的是历史声明值，现声明 .072 —— 判定一律以运行时打印为准。
     注释里不给定稿数字，运行时打印实测值（见 out.aoCeilL.detail）。
     ⚠ 这是**线性代理**：不建模径向衰减（AO 在角上最强、在落字处已衰减），
       锁的是"令牌的名义 α 不许越过 faint 余量所允许的额度"。
     ⚠ 真值另有一条**非线性复算**（out.aoLimit，对当前遮色二分求解 faint/surface+ao=4.5
       的临界 α）：遮色越暗，这条越紧（现测 .0746 < 代理 .081）。两个数并列打印，
       谁更紧就以谁为准 —— 换遮色时尤其如此。
     ⚠ 像素级的真实对比度由 B05 / OPT-15 / OPT-17 负责。三把尺子各管一段，互不冒充。 */
  const aoCeilL = (() => {
    const g = s => { try { return lum(toRgb(s)); } catch (e) { return null; } };
    const groundL = g(L['color-bg']), faintL = g(L['color-faint']), aoLum = g(L['plate-ao']);
    if (groundL === null || faintL === null || aoLum === null) {
      return { alpha: NaN, ok: false, detail: '地色/faint/ao 令牌缺失，无法反推上限（退回 .083）' };
    }
    const floorL = 4.5 * (faintL + 0.05) - 0.05;
    const margin = groundL - floorL;
    const potential = groundL - aoLum;
    const alpha = (potential > 1e-6 && margin > 0) ? Math.floor((margin / potential) * 1000) / 1000 : NaN;
    const baseRatio = (() => { try { return +ratio(toRgb(L['color-faint']), toRgb(L['color-bg'])).toFixed(3); } catch (e) { return null; } })();
    return {
      alpha, ok: Number.isFinite(alpha), groundL, faintL, floorL, margin, potential, baseRatio,
      detail: `地色(--color-bg) L=${groundL.toFixed(4)}、faint L=${faintL.toFixed(4)}（现状 ${baseRatio}:1）`
        + ` ⇒ 压到 4.5 的地色下限 L=${floorL.toFixed(4)}、余量 ${margin.toFixed(4)}`
        + ` ⇒ 上限 = 余量 / α=1 落差潜力 ${potential.toFixed(4)} = ${alpha.toFixed(3)}（落地 .075 留安全边）`
    };
  })();
  out.aoCeilL = aoCeilL;
  const aoMaxL = Number.isFinite(aoCeilL.alpha) ? aoCeilL.alpha : 0.083;

  /* ★ D14 连带修正：非线性复算临界值必须**参与判定**，不能只打印。
     原实现把 .aoLimit 算出来却只写进 detail（注释还写着"谁更紧就以谁为准"），
     于是判定用的是更松的线性代理 —— 这正是负控注入 .12 修前能翻红、修后翻不红的根因：
     D14 把别名展开后，线性代理从 .083 抬到 .297，而真实合成曲线的临界值是 .1131。
     现在先算临界值，再取两者更紧的那个作为上限（**收紧**，不是放宽）。 */
  const aoLimitNow = (() => {
    const faint = L['color-faint'], base = L['color-surface'], ao = L['plate-ao'];
    if (faint === undefined || base === undefined || ao === undefined) return null;
    try {
      const c = toRgb(ao);
      const okAt = a => ratio(toRgb(faint), over(`rgba(${c[0]},${c[1]},${c[2]},${a})`, toRgb(base))) >= 4.5;
      let lo = 0, hi = 0.5;
      if (!okAt(0)) return 0;
      if (okAt(hi)) return hi;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (okAt(mid)) lo = mid; else hi = mid;
      }
      return lo;
    } catch (e) { return null; }
  })();
  out.aoLimit = aoLimitNow;
  const aoMaxEff = Math.round((Number.isFinite(aoLimitNow) ? Math.min(aoMaxL, aoLimitNow) : aoMaxL) * 1e4) / 1e4;

  ceil('明 --plate-ao', aoL, aoMaxEff);
  ceil('暗 --plate-ao', aoD, 0.30);
  ceil('明 --plate-sheen', shL, 0.20);
  ceil('暗 --plate-sheen', shD, 0.06);
  ceil('明 --plate-cone', cnL, 0.24);
  ceil('暗 --plate-cone', cnD, 0.06);
  ceil('明 --plate-grid', grL, 0.035);
  ceil('暗 --plate-grid', grD, 0.035);

  /* 最坏叠层：先把遮蔽层合成到载板底色上，再算 faint 的对比度 */
  const calc = (label, faint, base, layer, min) => {
    if (faint === undefined || base === undefined || layer === undefined) {
      out.ratios.push({ label, ratio: null, min, ok: false, missing: true });
      return;
    }
    let bg, r;
    try {
      bg = over(layer, toRgb(base));
      r = +ratio(toRgb(faint), bg).toFixed(3);
    } catch (e) {
      out.ratios.push({ label, ratio: null, min, ok: false, missing: true });
      return;
    }
    out.ratios.push({ label, ratio: r, min, ok: r >= min });
  };
  calc('明 faint/surface + ao（最坏叠层）', L['color-faint'], L['color-surface'], aoL, 4.5);
  calc('暗 faint/surface + ao（最坏叠层）', D['color-faint'], D['color-surface'], aoD, 4.5);
  calc('明 faint/code-bg + grid（最坏叠层）', L['color-faint'], L['color-code-bg'], grL, 4.5);
  calc('暗 faint/code-bg + grid（最坏叠层）', D['color-faint'], D['color-code-bg'], grD, 4.5);

  /* 提亮侧复算（本轮新增的 cone 约束）：faint 对「地色合成 cone 芯部 alpha 之后」仍须 ≥4.5。
     逻辑（必须写清，否则下一个人会以为这条是废式）：
       · cone 是**提亮**层（白）：地色变亮 ⇒ 暗字的对比度**升高** ⇒ 提亮对暗字单向安全，
         所以这条在数学上恒成立 —— 就现状而言它不会红。
       · 但它是**结构护栏**：一旦有人把 --plate-cone 改成带彩度、亮度低于地色的色
         （例如 rgba(11,58,42,.20) 这类"彩色光锥"），它立刻从恒真变成有效约束并翻红。
       · 因此它必须**真的算一遍并打印前后两个数值**（见 coneSide），不许只写注释。 */
  const baseRatioOf = (fg, bg) => {
    try { return +ratio(toRgb(fg), toRgb(bg)).toFixed(3); } catch (e) { return null; }
  };
  calc('明 faint/bg + cone 芯部（提亮侧）', L['color-faint'], L['color-bg'], cnL, 4.5);
  calc('暗 faint/bg + cone 芯部（提亮侧）', D['color-faint'], D['color-bg'], cnD, 4.5);
  out.coneSide = {
    lightBase: baseRatioOf(L['color-faint'], L['color-bg']),
    darkBase: baseRatioOf(D['color-faint'], D['color-bg'])
  };

  /* 显式触发条件（主理人要求写进 detail）：明 faint/code-bg 跌破 4.5 时
     --plate-grid 的 alpha 临界值，二分求解 —— 不写死数字，令牌一改就自动跟随。 */
  out.gridDeclared = grL;
  /* --plate-ao 的**非线性复算临界值**：在 --color-surface 底上，faint/surface+ao 恰好
     等于 4.5 的那个 alpha（对**当前遮色**二分求解）。
     为什么除了线性代理上限还要这一个：遮色从 rgba(11,58,42) 换成 rgba(20,30,26)（近中性、
     更暗）之后，线性代理仍然给 .081，但真实合成曲线更陡 —— 实际 .075 就压到 4.496。
     两个数并列印出来，主理人才知道该按哪个调（真值以复算为准，代理只解释"余量"）。
     ★ D14：临界值已在上面先行求解，并参与判定（取 min(代理, 复算)）。 */
  out.gridLimit = (() => {
    const faint = L['color-faint'], base = L['color-code-bg'];
    if (faint === undefined || base === undefined) return null;
    try {
      const okAt = a => ratio(toRgb(faint), over(`rgba(22,36,31,${a})`, toRgb(base))) >= 4.5;
      let lo = 0, hi = 0.5;
      if (!okAt(0)) return 0;
      if (okAt(hi)) return hi;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (okAt(mid)) lo = mid; else hi = mid;
      }
      return lo;
    } catch (e) { return null; }
  })();
  out.ok = out.ceilings.every(x => x.ok) && out.ratios.every(x => x.ok);
  return out;
}

/* ============================================================================
   OPT-10 · 光源方向与投影方向物理自洽（**纯源码**）
   ========================================================================== */
/* 取 value 里每一层的 X 偏移（跳过 inset 层？不跳过——inset 的 X 也必须是 >= 0）
   ★ 必须允许「无单位零」：CSS 里 `0 2px 8px` 与 `0px 2px 8px` 等价，
     规格 §3.1 自己就写成 `--shadow-1: 0 1px 1px ...`。只认 Npx 会把合法值
     误判成 NaN → 假红。 */
function layerXs(v) {
  return splitTop(v).map(layer => {
    const t = String(layer).replace(/^inset\s+/i, '').trim();
    const m = t.match(/^(-?\d*\.?\d+)(px)?(?=\s|$)/);
    if (!m) return NaN;
    return +m[1];
  });
}
/* 主投影层 = 最后一层（blur 最大、距离最远的那层） */
function mainLayerX(v) {
  const xs = layerXs(v);
  return xs.length ? xs[xs.length - 1] : NaN;
}
function lightConsistency(o = {}) {
  const L = TOK_L;
  const s2 = o.shadow2 !== undefined ? o.shadow2 : L['shadow-2'];
  const s3 = o.shadow3 !== undefined ? o.shadow3 : L['shadow-3'];
  const lx = o.lightX !== undefined ? o.lightX : L['light-x'];
  const ly = o.lightY !== undefined ? o.light-y : L['light-y'];
  const s2s = o.shadow2 !== undefined ? o.shadow2 : TOK_D['shadow-2'];
  const s3s = o.shadow3 !== undefined ? o.shadow3 : TOK_D['shadow-3'];
  const facts = [];
  const xs2 = layerXs(s2), xs3 = layerXs(s3), xsd2 = layerXs(s2s), xsd3 = layerXs(s3s);
  facts.push({ k: '明 shadow-2 各层 X ≥ 0', v: JSON.stringify(xs2), ok: xs2.length > 0 && xs2.every(x => x >= 0) });
  facts.push({ k: '明 shadow-3 各层 X ≥ 0', v: JSON.stringify(xs3), ok: xs3.length > 0 && xs3.every(x => x >= 0) });
  facts.push({ k: '暗 shadow-2 各层 X ≥ 0', v: JSON.stringify(xsd2), ok: xsd2.length > 0 && xsd2.every(x => x >= 0) });
  facts.push({ k: '暗 shadow-3 各层 X ≥ 0', v: JSON.stringify(xsd3), ok: xsd3.length > 0 && xsd3.every(x => x >= 0) });
  const m2 = mainLayerX(s2), m3 = mainLayerX(s3);
  facts.push({ k: '明 shadow-2 主投影 X > 0', v: `${m2}px`, ok: m2 > 0 });
  facts.push({ k: '明 shadow-3 主投影 X > shadow-2', v: `${m3} vs ${m2}`, ok: m3 > m2 });
  const dm2 = mainLayerX(s2s), dm3 = mainLayerX(s3s);
  facts.push({ k: '暗 shadow-2 主投影 X > 0', v: `${dm2}px`, ok: dm2 > 0 });
  facts.push({ k: '暗 shadow-3 主投影 X > shadow-2', v: `${dm3} vs ${dm2}`, ok: dm3 > dm2 });
  const nx = parseFloat(lx);
  facts.push({ k: '--light-x < 50', v: lx, ok: Number.isFinite(nx) && nx < 50 });
  facts.push({ k: '--light-y 以 - 开头', v: ly, ok: typeof ly === 'string' && ly.trim().startsWith('-') });
  return { facts, ok: facts.every(f => f.ok) };
}

/* ============================================================================
   OPT-06 · 暗色投影零纯黑（**纯源码**）
   ========================================================================== */
function darkShadowAudit(o = {}) {
  const D = TOK_D;
  const val = k => (o[k] !== undefined ? o[k] : D[k]);
  const keys = ['shadow-1', 'shadow-2', 'shadow-3'];
  const rows = [];
  keys.forEach(k => {
    const v = val(k) || '';
    const blackCount = (v.match(/rgba?\(\s*0\s*,\s*0\s*,\s*0\b/g) || []).length;
    const hasInset = /inset\s+0(px)?\s+1(px)?\s+0/.test(v);
    const main = splitTop(v).pop() || '';
    const am = main.match(/rgba?\([^)]*\)/);
    const mainAlpha = am ? alphaOf(am[0]) : NaN;
    rows.push({ k, v, blackCount, hasInset, mainAlpha });
  });
  const alphaLadder = rows.map(r => r.mainAlpha);
  const increasing = alphaLadder.every((a, i) => i === 0 || a > alphaLadder[i - 1]);
  return {
    rows,
    ok: rows.every(r => r.blackCount === 0 && r.hasInset && Number.isFinite(r.mainAlpha)) && increasing,
    increasing,
    alphaLadder
  };
}

/* ============================================================================
   OPT-18 · 材质栈 AO 圆心不得落在光源同侧（**纯源码**，不启浏览器）
   ----------------------------------------------------------------------------
   为什么需要这条：本轮真正的事故不是"某一个 .stage 写错了"，而是**同一个物理错误
   被复制进了多个材质栈**，而所有既有判据都只看 box-shadow（OPT-10）或只看 .stage 的
   像素（OPT-17）：
     · `.stage` ④ 层      components.css  —— 已修
     · `--mat-t2`         tokens.css      —— 已修
     · `.slab`            base.css        —— **第三处**，本轮扫出来（注释里还写着"左下环境遮蔽"）
   `.slab` 是 L2 实心读数台面（承载文字/代码/图表/表单/数据），它自己内联了一份完整的
   T2 材质栈 —— 只修 tokens.css 里的 --mat-t2 并不会改到它。
   ----------------------------------------------------------------------------
   断言 A（禁止项）：**任何** CSS 文件里，凡是内含 var(--plate-ao) 的 radial-gradient，
                    其 `at X Y` 的 X 必须 ≥ 50%（光源在左上 ⇒ 影子只能落右半或右下）。
                    判定用"切出成对括号内的片段再解析圆心"，不做整文件字符串搜索 ——
                    否则会误伤未来的装饰渐变（例如 `at 0% 100%` 的普通底纹）。
   断言 B（正向项）：至少 2 处 AO 圆心是 100% 100%，且 tokens.css 与 components.css
                    各至少 1 处（两处都必须能在源里定位到，防止"整体被删"也算通过）。
   反例注入（源级判据的正确做法：**只改内存里的字符串，不动盘上文件**）：
    · 把 tokens.css 的第一处 `at 100% 100%` 改回 `at 0% 100%` → 同一个 matcher 必须 FAIL
    · 把 components.css 同样处理 → 也必须 FAIL
    · 换回原串 → 必须 PASS
   这才证明"断言 A 咬得住"，而不是只证明"当前源码里恰好没有"。
   ========================================================================== */
/* 切出所有 radial-gradient(...) 片段（括号配对，跳过注释） */
function radialSnippetsOf(text) {
  const src = stripComments(String(text));
  const out = [];
  const re = /radial-gradient\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index);
    if (open < 0) continue;
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(open + 1, i));
  }
  return out;
}
/* 从片段里解析圆心 `at X Y`（只认数值+单位；`at var(--light-x) var(--light-y)` 返回 null） */
function parseRadialCenter(snippet) {
  const m = String(snippet).match(/\bat\s+(-?[\d.]+)\s*(%|px|rem|em)?\s+(-?[\d.]+)\s*(%|px|rem|em)?/);
  if (!m) return null;
  return { x: +m[1], xUnit: m[2] || '%', y: +m[3], yUnit: m[4] || '%', raw: m[0].trim().replace(/\s+/g, ' ') };
}
/* 扫一批源文件，列出所有「内含 var(--plate-ao) 的 radial-gradient」及其圆心 */
function aoCenterRows(sources) {
  const rows = [];
  Object.keys(sources).forEach(file => {
    const text = sources[file];
    if (!text) return;
    radialSnippetsOf(text).forEach(snip => {
      if (!/var\(\s*--plate-ao\s*\)/.test(snip)) return;
      rows.push({
        file,
        center: parseRadialCenter(snip),
        snippet: snip.replace(/\s+/g, ' ').trim().slice(0, 96)
      });
    });
  });
  return rows;
}
const AO_RIGHT_EDGE = (r) => r.center && r.center.xUnit === '%' && r.center.yUnit === '%'
  && r.center.x >= 99.9 && r.center.y >= 99.9;
/* 圆心指纹：只比圆心，**不比半径**。半径差异是有意的（.stage 面积大，收紧比例后绝对尺寸才相当）。 */
const aoCenterKey = r => r.center
  ? `${r.center.x}${r.center.xUnit || ''} ${r.center.y}${r.center.yUnit || ''}`
  : 'unparsable';
function aoVerdict(rows) {
  const bad = rows.filter(r => !r.center || r.center.xUnit !== '%' || r.center.x < 50);
  const atRB = rows.filter(AO_RIGHT_EDGE);
  const perFile = f => atRB.filter(r => r.file === f).length;
  /* C 副本一致性：AO 层被复制进多个材质栈（--mat-t2 / .slab / .stage），
     任何一份被单独改动都会造成"一半板面影子在右下、另一半在左下"。
     A 只判"不许在左半"，判不出**互相不一致** —— 例如把其中一份改成 80% 100%，
     仍在右半，A 会放过，只有 C 咬得住。 */
  const keys = rows.filter(r => r.center).map(aoCenterKey);
  const centers = [...new Set(keys)];
  const cOk = rows.length > 0 && keys.length === rows.length && centers.length === 1;
  return {
    rows, bad, atRB, centers, cOk,
    aOk: rows.length > 0 && bad.length === 0,     /* rows.length>0：令牌被删也算红，不允许空转通过 */
    bOk: atRB.length >= 2 && perFile('tokens') >= 1 && perFile('components') >= 1,
    fromTokens: perFile('tokens'), fromComponents: perFile('components'),
    ok: rows.length > 0 && bad.length === 0 && atRB.length >= 2 && perFile('tokens') >= 1
      && perFile('components') >= 1 && cOk
  };
}
/* 只把某个文件的 AO 圆心从右上角翻到左下（用于内存注入；不动盘上文件） */
const flipAoToLeftBottom = text => String(text).replace(
  /at\s+100%\s+100%(\s*,\s*var\(\s*--plate-ao\s*\))/,
  (m, tail) => 'at 0% 100%' + tail
);

/* ============================================================================
   浏览器工具
   ========================================================================== */
const infiniteAnimations = [];
const settleTimeouts = [];

/* settle()：与 verify.mjs 加固后的执行器同款语义（跳过 infinite，1200ms 护栏） */
async function settle(page, label = 'settle') {
  const report = await page.evaluate(capMs => {
    const inf = [], finite = [];
    const list = document.getAnimations ? document.getAnimations() : [];
    list.forEach(a => {
      let iterations = null;
      try {
        iterations = (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming().iterations : null;
      } catch (e) { iterations = null; }
      if (iterations === Infinity) {
        inf.push({ name: a.animationName || 'unnamed', pseudo: (a.effect && a.effect.pseudoElement) || null });
        return;
      }
      finite.push(a.finished.catch(() => {}));
    });
    return Promise.race([
      Promise.all(finite).then(() => ({ outcome: 'all-settled', infinite: inf, finiteCount: finite.length })),
      new Promise(r => setTimeout(() => r({ outcome: 'timeout', infinite: inf, finiteCount: finite.length }), capMs))
    ]);
  }, 1200);
  if (report.infinite.length) infiniteAnimations.push({ at: label, count: report.infinite.length, items: report.infinite });
  if (report.outcome === 'timeout') settleTimeouts.push({ at: label, waitedMs: 1200 });
  await page.waitForTimeout(120);
  return report;
}

async function injectCss(page, css) {
  await page.evaluate(c => {
    let s = document.getElementById('__optics_probe');
    if (!s) { s = document.createElement('style'); s.id = '__optics_probe'; document.head.appendChild(s); }
    s.textContent = c;
  }, css);
  await page.waitForTimeout(60);
}
async function clearInject(page) {
  await page.evaluate(() => { const s = document.getElementById('__optics_probe'); if (s) s.remove(); });
  await page.waitForTimeout(60);
}
/* 页面内可见性三态交叉校验（禁止恒真写法） */
const VIS_FN = `
  const __vis = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) { /* 旧内核降级 */ }
    }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
  };
`;

/* 读某个元素（可含伪元素）的计算样式子集 */
async function csOf(page, sel, pseudo) {
  return page.evaluate(([s, ps]) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = ps ? getComputedStyle(el, ps) : getComputedStyle(el);
    const keys = ['backgroundImage', 'backgroundColor', 'boxShadow', 'zIndex', 'isolation', 'overflow',
      'overflowX', 'animationName', 'opacity', 'transform', 'backdropFilter', 'webkitBackdropFilter',
      'display', 'position', 'filter', 'maskImage', 'content'];
    const o = {};
    keys.forEach(k => { o[k] = cs[k]; });
    return o;
  }, [sel, pseudo || null]);
}
const gradCount = s => (String(s).match(/gradient\(/g) || []).length;
const shadowLayers = s => {
  const v = String(s);
  if (!v || v === 'none') return 0;
  return (v.match(/rgba?\(/g) || []).length;
};

/* ============================================================================
   像素级工具（零依赖）：自己解 PNG
   ----------------------------------------------------------------------------
   为什么必须自己解：OPT-13/14/15 要判的是"效果可见"，而 `getComputedStyle`
   只能证明"属性写了"。属性全对、效果为零的版本能拿 12/12 —— 这把尺子在
   "好看"这个维度上是失效的。所以必须拿到真实像素。
   约束：只用 node:zlib（零新依赖），不引 sharp / pngjs / canvas。
   Chromium 截图出的是 8-bit、非隔行的 colorType 6(RGBA) 或 2(RGB)。
   ========================================================================== */
const PNG_SIG = 0x89504e47;

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== PNG_SIG) throw new Error('PNG 签名不匹配');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0, okIHDR = false;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]; okIHDR = true;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!okIHDR) throw new Error('缺 IHDR');
  if (bitDepth !== 8) throw new Error(`仅支持 8-bit，实际 ${bitDepth}-bit`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  /* colorType: 0=灰 2=RGB 3=调色板 4=灰+α 6=RGBA */
  if (colorType === 3) throw new Error('不支持调色板 PNG（Chromium 不会产出，需 PLTE 才能正确还原）');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('未知 colorType ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < h; y++) {
    if (off + 1 + stride > raw.length) throw new Error(`IDAT 行数据不足（y=${y}）`);
    const ft = raw[off];
    const row = raw.subarray(off + 1, off + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (ft === 0) { /* None */ }
      else if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else throw new Error(`未知 filter 类型 ${ft}（y=${y}）`);
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      if (ch === 4) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
      else if (ch === 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
      else if (ch === 1) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
      else { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }  /* ch===2 灰+α */
    }
    prev = cur;
    off += 1 + stride;
  }
  return { w, h, data: out };
}

/* 像素取 RGBA（越界返回 null，便于采样时跳过） */
function px(img, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.w || yi >= img.h) return null;
  const d = (yi * img.w + xi) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2], img.data[d + 3]];
}
/* WCAG 相对亮度（sRGB 线性化） */
function pxLum(img, x, y) {
  const c = px(img, x, y);
  if (!c) return null;
  return lum([c[0], c[1], c[2]]);
}
/* 小片取中位数（抗单点噪声 / 抗抗锯齿） */
function patchLum(img, x, y, r = 1) {
  const vals = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const L = pxLum(img, x + dx, y + dy);
      if (L !== null) vals.push(L);
    }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[(vals.length - 1) >> 1];
}
/* 沿一条线段取中位数（抗局部亮点） */
function lineLumMedian(img, x0, y0, x1, y1, step = 2) {
  const vals = [];
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const L = pxLum(img, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    if (L !== null) vals.push(L);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[(vals.length - 1) >> 1];
}
/* 矩形块内**全部像素**的相对亮度中位数（不取平均）。
   为什么不取平均：块内可能压着字形、图标、1px 网格线、按钮边缘 —— 平均会被
   极少量的极暗/极亮像素拖走（一个 20×20 块里 5 个字形像素就能把平均值拉低 .03）。
   中位数对"少数派污染"天然免疫，这也是 OPT-17 敢贴着台面边缘 16px 采样的前提。 */
function blockLumMedian(img, x0, y0, w, h) {
  const vals = [];
  const x1 = x0 + Math.max(1, w), y1 = y0 + Math.max(1, h);
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const L = pxLum(img, x, y);
      if (L !== null) vals.push(L);
    }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[(vals.length - 1) >> 1];
}

/* 截一块图 → 解码 → 返回 {img, ox, oy}（ox/oy 是裁剪原点，便于用页面坐标采样） */
async function grab(page, clip) {
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(clip.x));
  const y = Math.max(0, Math.floor(clip.y));
  const w = Math.max(1, Math.min(Math.ceil(clip.w), vp.width - x));
  const h = Math.max(1, Math.min(Math.ceil(clip.h), vp.height - y));
  const buf = await page.screenshot({ clip: { x, y, width: w, height: h } });
  return { img: decodePng(buf), ox: x, oy: y, w, h };
}
/* 页面坐标 → 裁剪图内坐标 */
const inClip = (g, x, y) => [x - g.ox, y - g.oy];

/* 框内像素 → 底（中位数）+ 字芯（离底更远的极值）→ WCAG 比值。
   与 verify.mjs 的 T4 同一族口径：底必须取**实测像素**，
   半透明玻璃（fill .70）下的 backgroundColor 合成会把对比度算虚高。
   设计取舍写在判据 detail 里，不靠事后解释。 */
function pixelRatio(g, bx, by, bw, bh) {
  const x0 = Math.max(0, Math.round(bx - g.ox)), x1 = Math.min(g.img.w - 1, Math.round(bx + bw - g.ox));
  const y0 = Math.max(0, Math.round(by - g.oy)), y1 = Math.min(g.img.h - 1, Math.round(by + bh - g.oy));
  const px = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = (y * g.img.w + x) * 4;
      px.push([g.img.data[d], g.img.data[d + 1], g.img.data[d + 2]]);
    }
  }
  if (px.length < 24) return null;
  px.sort((a, b) => lum(a) - lum(b));
  const bg = px[px.length >> 1];
  /* lum() 在本文件是 0..1 标度（verify.mjs 的 pxLuma 是 0..255，照抄会恒取最亮像素，
     实测把「深字浅底」判成 1.04:1 —— 这个 off-by-scale 只在半透底上暴露出来）。 */
  const fg = lum(bg) > 0.5 ? px[0] : px[px.length - 1];
  return { bg, fg, ratio: +ratio(fg, bg).toFixed(2), n: px.length };
}

/* 元素矩形内 n×n 网格取"最亮像素块"的中位色 —— 用**最亮**是因为玻璃面本身是这一块里
   最亮的区域，文字/描边/阴影只会把它压暗；取最亮 = 取"纯玻璃面"的样本，
   比"随便挑个坐标"稳定得多（换个板块/滚动位置不会翻）。 */
function brightestFace(g, tx, ty, tw, th, n = 6, cell = 8) {
  let best = null, bestL = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const bx = tx + 6 + (tw - 12 - cell) * (i / (n - 1));
      const by = ty + 6 + (th - 12 - cell) * (j / (n - 1));
      const r = pixelRatio(g, bx, by, cell, cell);
      if (!r) continue;
      const l = lum(r.bg);
      if (l > bestL) { bestL = l; best = r.bg; }
    }
  }
  return best ? { rgb: best, L: +bestL.toFixed(4) } : null;
}

/* ============================================================================
   浏览器主流程
   ========================================================================== */
let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-first-run', '--disable-extensions'],
    timeout: 30000
  });

  const page = await ctx.newPage();
  page.on('pageerror', e => R.pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') R.consoleErrors.push(m.text()); });

  const load = async () => {
    /* ★ 取样时刻必须钉死（R75-LG）：光照已由设备真实时间驱动，
       台面底色会随时刻变化（白天苔绿灰 / 傍晚暖奶油 / 夜里冷蓝灰）。
       不钉时刻的话，同一份代码中午 18/18、半夜可能 16/18 —— 判据失去可比性。
       这里固定在 12:30（正午，无暖色偏移、无夜间压暗），是 OPT 系列的设计基准时刻；
       夜间最暗工况由 verify.mjs 的 LG-03 / C03 覆盖（底按 --sun-exposure 最暗算）。 */
    await page.goto(pathToFileURL(PAGE).href + '?hour=12.5', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1100);
    await settle(page, 'initial');
  };
  await load();

  /* ---------------------------------------------------------------- OPT-02 */
  await guard('OPT-02', () => runOpt('OPT-02', '环境循环零 CSS 动画（守 §11-R1 结构性决策）', {
    anchor() {
      const a = [assertAnchor('html', 'data-ambient', '环境宿主标记必须存在于 DOM')];
      a.push(assertAnchorRe('base', /\[data-ambient\]/, '至少一条 ambient 样式规则引用该标记'));
      a.push(assertAnchor('main', 'data-ambient', 'JS 侧需写入该标记'));
      return a.join(' | ');
    },
    async positive() {
      /* ★ 宿主形态兼容（主理人裁决：时钟宿主上移到 #appShell，`.atmosphere` 保留 .reveal）。
         宿主换成 #appShell 之后，`.atmosphere` 不再是 [data-ambient] 宿主，而它
         **才是真正画光的那个元素**（`.atmosphere::before` 消费 --lw-dx/--lw-dy/--lw-breath）。
         所以不能只扫 [data-ambient]：必须把光学层本体显式并入扫描面，
         否则"把无限动画挂在 .atmosphere::before 上"会从子项①漏掉。
         （子项② document 级 getAnimations() 仍然兜底，两层都要有。） */
      const probe = () => page.evaluate(() => {
        const targets = [];
        document.querySelectorAll('[data-ambient]').forEach(h => targets.push({ el: h, role: 'ambient-host' }));
        const atmo = document.querySelector('.atmosphere');
        if (atmo && !atmo.hasAttribute('data-ambient')) targets.push({ el: atmo, role: 'optical-layer' });
        const rows = [];
        targets.forEach(t => {
          const tag = (t.el.id || String(t.el.className || t.el.tagName)).slice(0, 40);
          ['', '::before', '::after'].forEach(ps => {
            const cs = ps ? getComputedStyle(t.el, ps) : getComputedStyle(t.el);
            rows.push({ role: t.role, tag, pseudo: ps || '(self)', animationName: cs.animationName });
          });
        });
        const inf = (document.getAnimations ? document.getAnimations() : [])
          .filter(a => { try { return !!(a.effect && a.effect.getComputedTiming().iterations === Infinity); } catch (e) { return false; } })
          .map(a => ({
            name: a.animationName || 'unnamed',
            pseudo: (a.effect && a.effect.pseudoElement) || null,
            target: (a.effect && a.effect.target && (a.effect.target.id || String(a.effect.target.className || a.effect.target.tagName).slice(0, 40))) || null
          }));
        return {
          hostCount: targets.filter(t => t.role === 'ambient-host').length,
          targetCount: targets.length,
          atmoPresent: !!atmo,
          rows,
          inf,
          revealAmbient: document.querySelectorAll('.reveal[data-ambient]').length
        };
      });
      const bad = r => {
        const fails = [];
        const anim = r.rows.filter(x => x.animationName !== 'none');
        if (anim.length) fails.push(`animationName≠none: ${JSON.stringify(anim.slice(0, 4))}`);
        if (r.inf.length) fails.push(`infinite animations: ${JSON.stringify(r.inf.slice(0, 4))}`);
        if (r.revealAmbient !== 0) fails.push(`.reveal[data-ambient] = ${r.revealAmbient}`);
        if (r.hostCount < 1) fails.push('[data-ambient] 宿主数 = 0');
        if (!r.atmoPresent) fails.push('.atmosphere 不存在（光学层本体缺失）');
        return fails;
      };
      const base = await probe();
      const fails = bad(base);
      /* 反例注入：给 `.atmosphere` 加 CSS 无限动画，必须至少两项翻红。
         ★ 必须带真 @keyframes：只写 `animation: x 1s linear infinite` 而库里没有
           名为 x 的关键帧时，浏览器**不会创建 Animation 对象** ——
           getComputedStyle().animationName 仍是 'x'（子项①会红），但
           document.getAnimations() 为空（子项②不会红），于是"无限动画计数"
           这条最关键的护栏永远得不到验证，等于留了一个后门：
           工程师只要把无限动画挂在**非 data-ambient 元素**上就能全绿通过。
           这里用真关键帧把子项②也一并打红。 */
      await injectCss(page, '@keyframes lw-probe-kf { from { opacity: .97 } to { opacity: 1 } }'
        + '.atmosphere { animation: lw-probe-kf 1s linear infinite !important; }');
      const inj = await probe();
      await clearInject(page);
      const restored = await probe();
      const injFails = bad(inj);
      const injOk = injFails.length >= 2;
      const restoreOk = bad(restored).length === fails.length;
      /* 子项②（无限动画计数）是守 settle() 的那一条，必须单独确认它真的会红 */
      const infFired = inj.inf.length > 0;
      const roles = base.rows.map(r => r.role).filter((v, i, a) => a.indexOf(v) === i);
      return {
        ok: fails.length === 0 && injOk && restoreOk,
        injected: {
          ok: injOk && restoreOk && infFired,
          detail: `注入真关键帧无限动画后翻红 ${injFails.length}/3 项（需 ≥2）${injFails.length ? '：' + injFails.join(' ; ') : ''}；`
            + `其中「无限动画计数」子项${infFired ? '已确认会红（守 settle() 的那条真的有效）' : '未触发 ✗ 该护栏是空的'}；`
            + `移除注入后${restoreOk ? '已复位' : '未复位（探针污染）'}`
        },
        detail: fails.length
          ? fails.join(' ; ')
          : `扫描面 ${base.targetCount} 个目标（角色 ${JSON.stringify(roles)}）× 3 个体（self/before/after）animationName 全为 none；`
            + `getAnimations() 中 iterations=Infinity 计数 = 0；.reveal[data-ambient] = 0；`
            + `注入后翻红 ${injFails.length}/3 项（${injOk ? '✓ 有区分力' : '✗ 判据恒真'}）；还原后 ${restoreOk ? '已复位' : '未复位'}`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* ---------------------------------------------------------------- OPT-04 */
  await guard('OPT-04', () => runOpt('OPT-04', '玻璃层按 id 取证：backdrop-filter 集合恒等于 [glass-ribbon, glass-top, mainStage, observerWindow]', {
    anchor() {
      const a = [assertAnchor('html', 'id="glass-top"', '鉴权集合成员身份必须可定位')];
      a.push(assertAnchor('html', 'id="glass-ribbon"', '第二个合法玻璃层'));
      a.push(assertAnchorRe('components', /backdrop-filter/, '至少一条规则真的声明了 backdrop-filter'));
      return a.join(' | ');
    },
    async positive() {
      const read = () => page.evaluate(() => {
        const out = [];
        document.querySelectorAll('*').forEach(el => {
          const cs = getComputedStyle(el);
          const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
          if (bf && bf !== 'none') {
            out.push({ id: el.id || null, sig: el.id || (el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')) });
          }
        });
        return out.sort((x, y) => String(x.sig).localeCompare(String(y.sig)));
      });
      const base = await read();
      const ids = base.map(x => x.id).filter(Boolean).sort();
      const expect = ['glass-ribbon', 'glass-top', 'mainStage', 'observerWindow'];
      const baseOk = ids.length === 4 && ids.join(',') === expect.join(',') && base.length === 4;
      /* 反例注入：给 .stage 加一层 backdrop-filter → 集合变成 3 个 */
      /* 注入目标必须是「本应零 blur 的 L3 卡片」：往 .stage 上注等于注了个已经存在的值，
         集合不变 ⇒ 判据会误判成恒真（本轮实测到）。 */
      await injectCss(page, '.msg { backdrop-filter: blur(2px) !important; }');
      const inj = await read();
      await clearInject(page);
      const injIds = inj.map(x => x.id).filter(Boolean).sort();
      /* 只比长度：注入目标（.msg）没有 id，拿 id 集比对会被 filter(Boolean) 洗成原集合，
         判据会误报「恒真」。长度变大就说明多了一个带 blur 的面，这正是要守的纪律。 */
      const injOk = inj.length > expect.length;
      return {
        ok: baseOk && injOk,
        injected: { ok: injOk, detail: `注入 .stage 的 backdrop-filter 后集合 ${JSON.stringify(inj.map(x => x.sig))}（长度 ${inj.length}，需 3）` },
        detail: `实际集合 ${JSON.stringify(base.map(x => x.id))}（期望长度=4 且 id 集={${expect.join(',')}}）；`
          + `注入 .msg 后 ${JSON.stringify(inj.map(x => x.sig))} → ${injOk ? '✓ 判据有区分力' : '✗ 恒真'}`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* === SENTINEL: 后续 OPT 在此之后插入 === */

  /* ---------------------------------------------------------------- OPT-01 */
  /* ★ D15（契约 §11）：本条原来锚在**一条永不生效的规则**上。
     事实链：
       · base.css:122 `.atmosphere::before` 里仍写着光锥
         `radial-gradient(… at var(--light-x) var(--light-y) …)`；
       · views.css:763 用**同特异性、后加载**的 `.atmosphere::before{background:none}`
         把上面整条覆盖，注释原文：「显式写 none：证明这里确实被清空了」；
       · 于是氛围层在计算值上是 `none`，光锥实际由 `.stage` 的材质栈承载。
     旧判据既要求"氛围层 ≥1 处坐标"，又拿源码 grep 当锚点 ⇒ 锚点输出 `base ✓ 1/2 条`，
     **锚点通过、锚的东西是死的**。这正是 D15 要消灭的那种"静默继续"。
     新口径（对象过期 + 锚点指向生效规则）：
       ① 锚点只钉**生效的那条**（views 的清空规则 + stage 的坐标引用），不再钉 base 的死规则；
       ② 正样本用**计算值反查**证明 views 那条真的生效：`::before.backgroundImage === 'none'`。
          如果哪天有人把它改回来却保留背景，计算值会变成一串渐变 ⇒ 本条立刻红（不允许静默）；
       ③ 光锥仍必须由 stage 承载（≥2 处坐标），且左上方语义、注入跟随两项原样保留。
     附带：源码侧对 base 那条死规则**留了一条断言**（见 anchor 的第 3 条）——
       它必须仍然是"被覆盖"状态，否则说明有人把清空规则删了，那就该红。 */
  await guard('OPT-01', () => runOpt('OPT-01', '光源单一来源：光锥坐标由 --light-x/--light-y 构成（氛围层已清空 · 光锥由 stage 承载）', {
    anchor() {
      const a = [assertAnchor('tokens', '--light-x:', '光源原点 X 令牌')];
      a.push(assertAnchor('tokens', '--light-y:', '光源原点 Y 令牌'));
      /* ① 生效规则：views.css 把氛围层显式清空（不是"忘了写"） */
      const viewBodies = ruleBodiesMatching(SRC.views, '.atmosphere::before');
      if (!viewBodies.length) throw new Error('锚点缺失：views.css 无 .atmosphere::before 规则（光锥载体无从判定）');
      const cleared = viewBodies.filter(b => /background\s*:\s*none/.test(b));
      if (!cleared.length) throw new Error('views.css 的 .atmosphere::before 没有 background:none —— 氛围层清空这条裁决不存在，锚点失效');
      a.push(`views ✓ .atmosphere::before{background:none}（${cleared.length}/${viewBodies.length} 条规则，光锥已迁出氛围层）`);
      /* ② 光锥新载体：stage 的材质栈必须引用光源坐标 */
      const stageBodies = ruleBodiesMatching(SRC.components, '.stage').concat(ruleBodiesMatching(SRC.views, '.stage'));
      const wired = stageBodies.filter(b => b.indexOf('var(--light-x)') >= 0 && b.indexOf('var(--light-y)') >= 0);
      if (!wired.length) throw new Error('.stage 未把光锥坐标接到 var(--light-x)/var(--light-y)');
      a.push(`components/views ✓ .stage 引用 var(--light-x/y)（${wired.length}/${stageBodies.length} 条规则）`);
      /* ③ 死接线登记（D15）：base.css 那条仍在写坐标，但必须处于"被覆盖"状态。
            这里只能做源码层判断（计算值反查在正样本里做）；两者缺一即红。 */
      const baseBodies = ruleBodiesMatching(SRC.base, '.atmosphere::before');
      const baseHasCone = baseBodies.some(b => b.indexOf('var(--light-x)') >= 0);
      if (!baseHasCone) {
        a.push('base · 死规则已消失（无需登记覆盖关系，代码更好）');
      } else {
        a.push('base ⚠ 死接线仍在：base.css 的 .atmosphere::before 写有光锥坐标，但被 views.css 同特异性后置覆盖 —— 计算值反查见正样本');
      }
      a.push(assertSelfAnchor('OPT-01', '防自删：判据本体必须留在源码里'));
      return a.join(' | ');
    },
    async positive() {
      const read = () => page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const atmo = document.querySelector('.atmosphere');
        const stage = document.querySelector('.stage');
        return {
          lx: root.getPropertyValue('--light-x').trim(),
          ly: root.getPropertyValue('--light-y').trim(),
          atmo: atmo ? getComputedStyle(atmo, '::before').backgroundImage : '',
          stage: stage ? getComputedStyle(stage).backgroundImage : ''
        };
      });
      const countPos = (s, x, y) => {
        const re = new RegExp(x.replace('%', '%') + '\\s+' + y.replace('%', '%'), 'g');
        return (String(s).match(re) || []).length;
      };
      const countCoord = s => (String(s).match(/at\s+-?[\d.]+%\s+-?[\d.]+%/g) || []).length;
      const base = await read();
      /* ② 计算值反查：views 的清空规则必须真的生效（不是被别的规则再覆盖） */
      const atmoCleared = base.atmo === 'none';
      const stageHits = countCoord(base.stage);
      /* 与光源配对一致的坐标数（其它层用的是自己的圆心，注入不会动它们 ——
         所以"跟随数量"只能跟这个数比，不能跟全部坐标数比。本轮踩过：7 vs 2） */
      const lxHits = countPos(base.stage, base.lx, base.ly);
      const coordOk = /^-?\d+(\.\d+)?%$/.test(base.lx) && /^-?\d+(\.\d+)?%$/.test(base.ly);
      /* 光源坐标由 sun.js 按真实时间驱动 ⇒ 不断言 == 22%；只断言"仍在左上"的语义 */
      const ok0 = atmoCleared && stageHits >= 2 && lxHits >= 2 && coordOk
        && parseFloat(base.lx) <= 45 && parseFloat(base.ly) < 0
        && /at\s+-?[\d.]+%\s+-?[\d.]+%/.test(base.stage);
      /* 反例注入：把光源挪到 80% → stage 的坐标必须跟着变；氛围层必须仍是 none。
         set 与 read 放进同一次 evaluate：sun.js 的 500ms tick 插不进同步函数（R77 的坑）。 */
      const inj = await page.evaluate(() => {
        const root = document.documentElement;
        root.style.setProperty('--light-x', '80%');
        const atmo = document.querySelector('.atmosphere');
        const stage = document.querySelector('.stage');
        const out = {
          lx: getComputedStyle(root).getPropertyValue('--light-x').trim(),
          atmo: atmo ? getComputedStyle(atmo, '::before').backgroundImage : '',
          stage: stage ? getComputedStyle(stage).backgroundImage : ''
        };
        root.style.removeProperty('--light-x');
        getComputedStyle(document.querySelector('.atmosphere'), '::before').backgroundImage;
        return out;
      });
      await page.waitForTimeout(30);
      const injMoved = countPos(inj.stage, '80%', base.ly);
      const injOk = inj.stage !== base.stage && injMoved === lxHits && inj.atmo === 'none';
      return {
        ok: ok0 && injOk,
        injected: {
          ok: injOk,
          detail: `把 --light-x 注入为 80% 后，stage 中与光源配对的坐标 "at 80% ${base.ly}" 命中 ${injMoved} 处（基线 ${lxHits} 处），`
            + `stage 串${inj.stage !== base.stage ? '已' : '未'}跟随；氛围层仍为 ${inj.atmo}（需 none）`
            + ` → ${injOk ? '✓ 单一来源，非写死巧合' : '✗ 坐标未跟随 / 氛围层被重新接回'}`
        },
        detail: `--light-x=${base.lx}、--light-y=${base.ly}（X≤45 且 Y 为负 = 左上光源）；`
          + `氛围层 ::before.backgroundImage=${atmoCleared ? 'none ✓（views.css 清空规则生效，计算值反查）' : JSON.stringify(base.atmo).slice(0, 90) + ' ✗ 未被清空'}；`
          + `光锥改由 .stage 承载：与光源配对的坐标命中 ${lxHits} 处、材质栈内共 ${stageHits} 处坐标（配对需 ≥2）${lxHits >= 2 ? ' ✓' : ' ✗'}；`
          + `〔登记 · 不判定〕base.css 的死规则仍在写坐标（被 views 同特异性后置覆盖）—— 本判据只对生效规则断言`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* ---------------------------------------------------------------- OPT-03 */
  /* ★ R81-R2 口径重定（契约 §12 / D19：批 A′，含三处必改）。
     【旧判据为什么恒红】它读 `backgroundColor` 求 fill α，窗口是单色时代的 [.66,.74]。
     但 R81-D5 起 fill 是**渐变**，只能写在 background-image 里，且**必须排在最后一层（= 最底）**
     （views.css:950-953：换位就会盖住上面 12 层光照场）。
     于是 `backgroundColor` 是 transparent ⇒ `alphaOf` 得 0 ⇒ 判据红的不是玻璃，是**读错了层**。
     ⇒ 读法改为：`background-image` → `splitTop()` 取**末层** → 先断言含 `radial-gradient`
       → `gradientStops()`（与 C03 共用 `scripts/lib/glass-color.mjs` 的**同一份**实现）。
       `backgroundColor` 自本条退出，不再参与任何断言。

     【窗口：三条命题，缺一不可】
       ① 每个 stop α ≥ .22
          D6 的「壳层 .22–.38」界定的是**单色时代的有效覆盖率（一个 α）**，
          而本轮被判的量是**逐 stop alpha** —— 两者不是同一个量，不可直接套用。
          取下界 .22 = 只采用 D6 中"最薄处不许低于此"的**下限锚**（保守采用更严的一半）；
          D6 的**上限意图**改由下面 ③ 承担，而不是拿 .38 去卡每一个 stop。
       ② 每个 stop α ≤ .70
          语义：玻璃任一处都不许接近实心 —— 实心面上不存在透色与折射，
          D5「液态厚玻璃」命题直接不成立。此上界**与旧窗口 [.66,.74] 无关**；
          数值恰好比 .74 低 .04 是**巧合**，不是"旧窗口收 .04"的推导
          —— 旧窗口是单色时代的标定、本轮已判过期，不能从一把过期的尺子里借权威。
       ③ max(stops) ≥ .38 —— 补回 D6 的上限意图，且是**加严不是放宽**：
          没有它，全部 stop 都取 .24 也能过 ①②，而那时玻璃**整体偏薄**，正是 D6 要禁的。
          实测余量：明 max .52（+.14）、暗 max .56（+.18）。
       ⇒ 三条合起来才是完整命题：**每点不薄于 .22 / 不厚于 .70 / 且至少有一处厚达 .38**。
          单向放宽或单向收紧都会漏掉一个方向，只有三条同时存在才两个方向都堵住。

     【失败必须可归因】输出按 stop 逐条列 `{档, 第几个 stop, alpha, 是否落带}`
       —— 与 C03 的 `c03All` 同一条纪律：红要红得出位置，不许只报一个"最差 stop"。

     【其余四项一字不动】blur∈[22,34] / 材质栈 ≥5 层 / inset 环 ≥3 / 其上文字像素对比 ≥4.5。

     【反例：逐 stop × 双向遍历】把**每一个** stop 依次改成 .02 与 .95
       （2 档 × N 个 stop × 2 向），每一次判定都必须翻红，**且红的必须是被改的那一档 stop**。
       只注入首末两个 stop 会留洞：改中间 stop 不红 —— A′ 原案正是这么漏的。 */

  /* 读 #mainStage 的样式快照（明暗两档、注入前后共用同一份读法） */
  const readMainStage = (pg) => pg.evaluate(() => {
    const el = document.getElementById('mainStage');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const t = document.querySelector('.panel-title');
    let box = null;
    if (t) {
      const rg = document.createRange(); rg.selectNodeContents(t);
      const b = rg.getBoundingClientRect();
      if (b.width > 8 && b.height > 6) box = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    return {
      bg: cs.backgroundColor, img: cs.backgroundImage, shadow: cs.boxShadow, bdf: cs.backdropFilter,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }, box
    };
  });
  const setThemeAttr = (pg, th) => pg.evaluate(t => {
    if (t === 'light') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, th);

  /* 三条 stop 命题 + 其余四项 → 结构化判定（正样本与 12 次注入共用，避免两套口径） */
  const l2FillJudge = (base) => {
    const img = String(base.img || '');
    const layers = splitTop(img);
    const last = layers[layers.length - 1] || '';
    if (!/radial-gradient/i.test(last)) {
      throw new Error(`末层不是 radial-gradient（读到：${last.slice(0, 110)}）—— "fill 在末层"的前提已失效`);
    }
    const st = gradientStops(last) || [];
    if (!st.length) throw new Error('末层渐变解析不出颜色 stop：' + last.slice(0, 120));
    const rows = st.map((s, i) => ({
      i,
      a: Math.round(s.a * 1e4) / 1e4,
      at: s.at,
      inBand: s.a >= 0.22 && s.a <= 0.70
    }));
    const maxA = Math.max.apply(null, rows.map(r => r.a));
    const bandOk = rows.every(r => r.inBand);
    const thickOk = maxA >= 0.38;          /* ③ 必须有厚点 */
    const layerN = gradCount(img);
    const insets = (String(base.shadow || '').match(/inset/g) || []).length;
    const blur = +((String(base.bdf || '').match(/blur\(([\d.]+)px\)/) || [0, 0])[1]);
    const blurOk = blur >= 22 && blur <= 34;
    const layersOk = layerN >= 5;
    const ringsOk = insets >= 3;
    const bdfOk = base.bdf !== 'none';
    return {
      rows, maxA, bandOk, thickOk, blur, blurOk, layerN, layersOk, insets, ringsOk, bdfOk,
      pass: bdfOk && bandOk && thickOk && blurOk && layersOk && ringsOk
    };
  };
  /* 把末层第 i 个 stop 的 alpha 改写掉（几何与 at 一字不动）——注入的是**被判量本身** */
  const retintStop = (layer, idx, a) => {
    const re = /((?:rgba?|hsla?)\([^)]*\)|#[0-9a-fA-F]{3,8})/g;
    let i = -1;
    return String(layer).replace(re, m => {
      i++;
      if (i !== idx) return m;
      const n = (m.match(/[\d.]+/g) || []).map(Number);
      if (!n.length) return m;
      const [r, g, b] = n.length >= 3 ? n : [n[0], n[0], n[0]];
      return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
    });
  };
  /* D19 (4)：逐 stop 一行，红要红得出位置 */
  const fmtStopRows = (label, j) =>
    `${label}档 stops ` + j.rows.map(r =>
      `#${r.i + 1} α=${r.a}${r.at === null ? '' : '@' + r.at + '%'} ${r.inBand ? '落带 ✓' : '出带 ✗'}`
    ).join(' · ') + ` · max=${j.maxA}（≥.38 ${j.thickOk ? '✓' : '✗'}）`;

  await guard('OPT-03', () => runOpt('OPT-03', 'C 栏主台面是液态厚玻璃（fill 末层每个 stop α∈[.22,.70] 且 max≥.38 + blur∈[22,34] + 材质栈 ≥5 层/≥3 环 + 其上文字对比 ≥4.5）', {
    anchor() {
      const a = [assertAnchor('html', 'id="mainStage"', '台面元素')];
      const bodies = ruleBodiesMatching(SRC.views, 'mainStage').concat(ruleBodiesMatching(SRC.components, 'mainStage'));
      if (!bodies.length) throw new Error('锚点缺失：views/components 无 #mainStage 规则');
      if (!bodies.some(b => b.indexOf('backdrop-filter') >= 0)) throw new Error('#mainStage 未声明 backdrop-filter（厚玻璃不存在）');
      a.push(`views/components ✓ ${bodies.length} 条含 mainStage 的规则中有 backdrop-filter`);
      a.push(assertAnchor('tokens', '--glass-l2-fill:', '厚玻璃填充令牌'));
      a.push(assertAnchor('tokens', '--glass-l2-blur:', '厚玻璃模糊令牌'));
      /* "fill 在末层"是本条读法的前提，源码里必须真的这么写（否则末层判定指向别的东西） */
      a.push(assertAnchor('views', 'var(--glass-l2-fill)', '材质栈末层引用 fill 令牌'));
      return a.join(' | ');
    },
    async positive() {
      const got = {};
      for (const [label, th] of [['明', 'light'], ['暗', 'dark']]) {
        await setThemeAttr(page, th);
        await page.waitForTimeout(200);
        const b = await readMainStage(page);
        if (!b) throw new Error('#mainStage 不存在');
        const j = l2FillJudge(b);
        let pxc = null;
        if (b.box) {
          const g = await grab(page, b.box);
          pxc = pixelRatio(g, b.box.x, b.box.y, b.box.w, b.box.h);
        }
        got[label] = { img: b.img, j, pxc, textOk: !!pxc && pxc.ratio >= 4.5 };
      }
      await setThemeAttr(page, 'light');
      const labels = ['明', '暗'];
      const okAll = labels.every(l => got[l].j.pass && got[l].textOk);
      return {
        ok: okAll,
        images: { 明: got['明'].img, 暗: got['暗'].img },
        detail: labels.map(l => {
          const { j, pxc, textOk } = got[l];
          return `${fmtStopRows(l, j)}；blur=${j.blur}px（∈[22,34] ${j.blurOk ? '✓' : '✗'}）· `
            + `渐变层 ${j.layerN}（≥5 ${j.layersOk ? '✓' : '✗'}）· inset 环 ${j.insets}（≥3 ${j.ringsOk ? '✓' : '✗'}）· `
            + `文字 ${pxc ? pxc.ratio : 'n/a'}:1（≥4.5 ${textOk ? '✓' : '✗'}）`;
        }).join(' ｜ ')
          + ' 〔backgroundColor 不参与：旧 α=0 是读错层，不是玻璃透明〕'
      };
    },
    async injection(p) {
      if (!p || !p.images) return { ok: false, detail: '正样本未记录 fill 图像，无法逐 stop 注入' };
      const probes = [{ a: 0.02, why: '薄于下界 .22' }, { a: 0.95, why: '厚于上界 .70' }];
      const out = [];
      let allRed = true;
      let total = 0;
      for (const [label, th] of [['明', 'light'], ['暗', 'dark']]) {
        await setThemeAttr(page, th);
        await page.waitForTimeout(160);
        const layers = splitTop(p.images[label]);
        const last = layers[layers.length - 1];
        const n = (gradientStops(last) || []).length;
        for (let i = 0; i < n; i++) {
          for (const pr of probes) {
            total++;
            const patched = layers.slice(0, -1).concat(retintStop(last, i, pr.a)).join(', ');
            await injectCss(page, `#mainStage{transition:none!important;background-image:${patched}!important}`);
            const b = await readMainStage(page);
            await clearInject(page);
            const j = l2FillJudge(b);
            const row = j.rows[i];
            /* 双重条件：整条要翻红，**且红在被我改的那一档 stop 上**（防"红错地方"） */
            const turnedRed = !j.pass && !!row && row.inBand === false;
            if (!turnedRed) allRed = false;
            out.push(`${label}#${i + 1}→${pr.a}（${pr.why}）${turnedRed ? '红 ✓' : '未红 ✗'}`
              + `〔该 stop 实测 α=${row ? row.a : 'n/a'}、落带=${row ? row.inBand : 'n/a'}；整条 pass=${j.pass}〕`);
          }
        }
      }
      await setThemeAttr(page, 'light');
      return {
        ok: allRed,
        detail: `${total} 次注入（2 档 × 每个 stop × α→.02/.95）全部翻红 ${allRed ? '✓' : '✗'}：` + out.join('；')
      };
    }
  }));

  /* ---------------------------------------------------------------- OPT-05 */
  /* ★ R81-R2 口径修订（契约 §8 D8）——只改本条，别的判据一律没动。
     ── 改前：任何「有文字宿主 + 绝对定位 + 渐变背景 + z ≥ 0」的伪元素都算 offender。
        接线 .liquid-surface 之后它报了 8 个，全部来自 .liquid-surface 的两个伪元素。
     ── 改后：两半分开处理，因为它们的**几何事实不同**，不能一刀切：
        ① ::after（追光斑）→ 源码改成 z-index:-1。负层画在本元素自身背景之上、
           流内文字之下，本来就该这样（specular 压字会降低可读性）。
           ⇒ 它靠"改源码"变绿，判据对它一个字没放宽。
        ② ::before（棱镜框）→ 给它一条**窄豁免**。它是 inset:0 + padding:1.2px +
           content-box mask + mask-composite:exclude，只画那 1.2px 一圈，
           几何上不可能覆盖内部文字 —— 这是可证明的，不是"我保证"。
        豁免条件是 AND，缺一不豁免（防止有人给全幅光斑加个 mask 就骗过去）：
           position:absolute · inset 四边 =0 · padding ≤2px ·
           mask 图层本身可证（见下）· mask-composite:exclude · pointer-events:none
        并且豁免依赖的三个源码前提必须能在**源码**里 assert 到：
           `padding: 1.2px`、`mask: linear-gradient(black 0 0) content-box`、
           `mask-composite: exclude`。锚点没了 ⇒ 判据直接抛错翻红。

       ★ R81-R2 二次加固（r81r2-qa 的对抗性复核，qa/r81-r2/OPT05-REVIEW.md）：
         上一版只查 `mask-composite === exclude`，证明不了"mask 真的只画一圈"。
         qa 实测出三种绕过，三种都能让 isEdgeRing 判 true、中心像素却被渐变盖死：
           ① `mask: none` + `mask-composite: exclude`（mask:none 时 exclude 是空操作）
           ② 单层 mask、没有 content-box（单层无对象可挖，exclude 无效）
           ③ 两层 mask 但第二层透明 `rgba(0,0,0,0)`（几何同形，遮罩却全开）
         加固办法 = 直接查 **mask 图层内容**：
           maskImage ≠ none · 顶层逗号切分后恰好 **2 层** ·
           每层都含不透明 `rgb(0, 0, 0)` · 且整串不含 `rgba(`
         实测真规则的 computed 值正好是：
           `linear-gradient(rgb(0,0,0) 0px, rgb(0,0,0) 0px), linear-gradient(rgb(0,0,0) 0px, rgb(0,0,0) 0px)`
         三种绕过分别会被"层数≠2 / 含 rgba( / maskImage=none"逐条拦下。
         ★ 另有第三种更彻底的做法（截中心 1px 比色），本轮不做 —— 但理由在第三次加固时
           变了（从"还够用"变成"能用代数关掉"），见下。

       ★ R81-R2 三次加固（qa 第四轮，两个结论一好一坏）：
         【坏消息】第三个属性级残余出现了：`mask-mode`。qa 的样本只动两个属性：
             `mask-mode: luminance, luminance` +
             `mask-image: linear-gradient(black 0 30%, white 30%), linear-gradient(black 0 0)`
           层数 2 / 纯黑 / 无 rgba( / exclude / size / origin 全是真规则的值。
           luminance 下黑色=遮掉、白色=保留 ⇒ 第二层全黑=全透明，第一层 30% 之后=保留，
           exclude 结果 = 内容区 70% 被画上，文字被盖，而上面**每一条**检查都过。
           实测（qa/r81r2/probe-mask.mjs ④，最小注入）修前 exempt=true。
           修法一行：`everyLayer(cs.maskMode || cs.webkitMaskMode, x => x === 'match-source')`
           （真规则 computed 是 `match-source, match-source`；webkitMaskMode 在 Chromium
           读到空串，留作兜底）。加完 exempt=false。
         【好消息】qa 同时指出 **repOk 冗余**，复核后同意并删除：
           size ∈ {auto, 100% 100%} 时渐变没有固有尺寸 ⇒ 图片尺寸恒等于定位区尺寸 ⇒
           百分比 position 的偏移 = p × (定位区 − 图片) = 0。偏移恒为 0、尺寸恒等于整块，
           `repeat` 与 `no-repeat` 逐像素同形。实测（同探针 ③）：孤立注入
           `mask-repeat: no-repeat` 会让 repOk 翻红而渲染不变 —— 纯假红源，删掉。

       ★ 为什么这一轮仍不上像素版（本段最关键的一句，别读成"还能撑"）：
         不是因为"枚举还够用"（已证明够不住 mask-mode 这种换"面"的写法），也不是懒。
         是因为剩下的属性可以用**代数**关掉，不需要再枚举：
           盖到文字 ⟺ 存在内容区内的点使 A=0 ∧ B=1（A/B = 两层遮罩值）。
           · size ∈ {auto, 100%} ⇒ 两层都铺满定位区（上面的偏移=0 推导）⇒ A=1 ∧ B=1
           · composite = exclude ⇒ 内容区 A xor B = 0 ⇒ 不画
           · mode = alpha（match-source）⇒ 纯黑 = 1，由 maskLayersOk 保证
           · 未检查的 mask-position / repeat / origin / clip：任何改动都只会把 A 或 B
             从 1 变成 0（origin 改 border-box ⇒ 整块不可见），即"更不画"，
             造不出 A=0 ∧ B=1
         所以"已覆盖"的对象是**这个代数式**，不是"所有属性"。若将来出现一个能把
         A=0 ∧ B=1 造进内容区的新属性或新特性，说明这套论证有洞 —— 那时该上的是像素版
         （元素截图 with/without ::before，内缩区做差分），不是再加一条属性。

       ★ 已枚举清单（本轮实际检查的六项）：
           position · inset 四边=0 · padding ≤2px · mask-composite 逐层 exclude ·
           mask-size ∈{auto,100% 100%} · mask-mode 逐层 match-source ·
           maskImage 恰好两层且每层不透明 rgb(0,0,0)
         ★ 已知残余（契约 §9 D11 登记，**只记账、不修** —— 修要上像素版）：
           属性级：mask-composite 的合法变体、mask-size × repeat 的自由组合、
                   mask-mode（本轮已封）
           结构级：单层 mask / 两层但全透明 / 用 clip-path 替代 mask
           方法级：任何"几何上确实覆盖了文字、但上面六项枚举不到"的新属性或新特性
         —— 这三种残余不是"待办"，是**接受的风险**；判据的完整性来自上面的代数式，
            不来自清单长度。

     ── 区分力自证（六条注入，缺一不可）：
        α 把 .liquid-surface::after 的 z-index 注入回 3 → offender 必须重新出现
          （证明"降层"这件事是被测出来的，不是被白名单抹掉的）
        β 把 .liquid-surface::before 的 padding 注入成 24px → offender 必须重新出现
          （证明豁免是有条件的，环一厚就不再豁免）
        γ 把 .liquid-surface::before 的 mask 注入成 none → offender 必须重新出现
          （qa 的绕过 ①，证明"mask 图层内容"这一条真的在起作用）
        δ 把 mask-composite 注入成 `exclude, add` → offender 必须重新出现
          （证明 composite 是**逐层**判的；子串判定会放过 add=并集）
        ε 把 mask-size 第二层注入成 30% + no-repeat → offender 必须重新出现
          （证明 size 是逐层判的。注意：命中的是 sizeOk；那个 no-repeat 不是判定依据，
           它只是让这个样本在渲染上真的漏字 —— 只写 30% 时 repeat 会把小块补满，
           反而成了假绕过）
        ζ 最小 mask-mode 绕过（只改 mode + image，其余用真规则值）→ offender 必须重新出现
          （qa 的第三个属性级残余，证明 maskMode 这一条真的在起作用） */
  await guard('OPT-05', () => runOpt('OPT-05', '光学伪元素永远在文字之下（补 B05 盲区）· 棱镜框窄豁免', {
    anchor() {
      const a = [assertAnchorRe('components', /isolation:\s*isolate/, '')];
      a.push(assertAnchorRe('components', /z-index:\s*-1/, '') );
      a.push(assertAnchorRe('components', /\.msg--assistant::after/, '至少一条光学伪元素规则可定位'));
      a.push(assertAnchorRe('components', /--sheen-follow/, '磁吸高光令牌'));
      /* R81-R2 新增（契约 §8 D8）：豁免的三个几何前提 */
      a.push(assertAnchorRe('base', /padding:\s*1\.2px/, '棱镜框环厚 —— 窄豁免的几何前提'));
      a.push(assertAnchorRe('base', /mask:\s*linear-gradient\(black 0 0\) content-box/, 'content-box 挖空 —— 窄豁免的几何前提'));
      a.push(assertAnchorRe('base', /mask-composite:\s*exclude/, 'xor 合成 —— 窄豁免的几何前提'));
      a.push(assertSelfAnchor('.liquid-surface::after { z-index: 3 !important; }', '反例注入必须针对真实宿主'));
      a.push(assertSelfAnchor('.liquid-surface::before { mask: none !important; }', '绕过 ① 的反例注入'));
      return a.join(' | ');
    },
    async positive() {
      const scan = () => page.evaluate(() => {
        const HOSTS = ['.msg--assistant', '.composer', '.set-group', '.plinth-tile'];
        const exemplars = [];
        HOSTS.forEach(sel => {
          const el = document.querySelector(sel);
          if (!el) return;
          const csAfter = getComputedStyle(el, '::after');
          exemplars.push({
            sel,
            z: csAfter.zIndex,
            iso: getComputedStyle(el).isolation,
            bg: csAfter.backgroundImage !== 'none',
            hostText: (el.innerText || '').trim().length > 0
          });
        });
        /* 窄豁免判定：六个条件 AND。任何一条读不到就当作不豁免（宁可误报也不放过）。
           ★ mask 那一项查的是**图层内容**，不是只看 mask-composite：
             qa 实测三种绕过（mask:none / 单层 / 第二层透明）都满足
             "position+inset+padding+exclude+pe:none"，但中心会被渐变盖死。
           ★ R81-R2 二次加固（qa 第二轮复核，两个**属性级**残余）：
             A `mask-composite: exclude, add` —— 原来用 `/exclude/.test(...)` 子串判定，
               而 `add` 是并集 ⇒ content-box ∪ border-box = 整块全开；computed 仍是
               "exclude, add"，子串照样命中。⇒ 改成**逐层判每一个都必须是 exclude**。
             B `mask-size: 100% 100%, 30% 30%` —— 层数 2、不透明纯黑、无 rgba( 全都满足，
               但第二层只盖 30%，exclude 后文字仍被盖住。⇒ 逐层要求 size ∈ {auto, 100% 100%}。
             真规则 computed 实测：composite "exclude, exclude" / size "auto, auto" —— 两条都过。
           ★ R81-R2 三次加固（qa 第四轮）：
             mask-mode 是第三个属性级残余，见函数上方长注释；这里只补一条
             mode === 'match-source'（= 按 alpha 取值）。
             同时**删掉**上一版的 `repeat === 'repeat'`：size 夹死之后 repeat 是空操作，
             它只会对 `size:100% 100%; no-repeat`（几何无害）报假红。 */
        const splitTop = (s) => {
          const parts = []; let depth = 0, cur = '';
          for (const ch of s) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
            cur += ch;
          }
          if (cur.trim()) parts.push(cur.trim());
          return parts;
        };
        /* 逐层判定：单值 computed（浏览器把同一值收敛成一项）视作对所有层生效 */
        const everyLayer = (v, ok) => {
          const parts = splitTop(v || '');
          return parts.length > 0 && parts.every(x => ok(x.trim()));
        };
        const maskLayersOk = (v) => {
          if (!v || v === 'none') return false;
          if (/rgba\(/.test(v)) return false;              /* 有透明层 ⇒ 遮罩全开（绕过 ③） */
          const parts = splitTop(v);
          if (parts.length !== 2) return false;            /* 单层 ⇒ 无对象可挖（绕过 ②） */
          return parts.every(p => /rgb\(\s*0,\s*0,\s*0\s*\)/.test(p));
        };
        const isEdgeRing = (cs) => {
          if (cs.position !== 'absolute') return false;
          const insetZero = ['top', 'right', 'bottom', 'left']
            .every(k => parseFloat(cs[k]) === 0);
          const padMax = Math.max(...['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
            .map(k => parseFloat(cs[k]) || 0));
          const compOk = everyLayer(cs.maskComposite || cs.webkitMaskComposite, x => x === 'exclude');
          const sizeOk = everyLayer(cs.maskSize || cs.webkitMaskSize, x => x === 'auto' || x === '100% 100%');
          /* 三次加固：mask-mode。真规则 computed "match-source, match-source"
             （match-source 对渐变 = 按 alpha）；luminance 会把纯黑层翻成"全遮掉"，
             再配一个 black→white 的第一层，就能让内容区 70% 被画上而其余检查全过。
             webkitMaskMode 在 Chromium 读到空串，留作兜底（别的内核可能只认前缀）。 */
          const modeOk = everyLayer(cs.maskMode || cs.webkitMaskMode, x => x === 'match-source');
          return insetZero && padMax <= 2 && compOk && sizeOk && modeOk
            && maskLayersOk(cs.maskImage) && cs.pointerEvents === 'none';
        };
        const offenders = [];
        const exempt = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const text = (el.innerText || '').trim().length;
          if (text === 0) continue;
          for (const ps of ['::before', '::after']) {
            const cs = getComputedStyle(el, ps);
            if (!cs.content || cs.content === 'none' || cs.content === 'normal') continue;
            if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
            if (!/gradient\(/.test(cs.backgroundImage)) continue;
            const z = cs.zIndex === 'auto' ? 0 : parseFloat(cs.zIndex);
            if (!(Number.isFinite(z) && z >= 0)) continue;
            const host = el.id || String(el.className || el.tagName).slice(0, 40);
            if (ps === '::before' && isEdgeRing(cs)) {
              exempt.push({ host, pseudo: ps, z: cs.zIndex, pad: cs.padding, text });
              continue;
            }
            offenders.push({ host, pseudo: ps, z: cs.zIndex, text });
          }
        }
        return { exemplars, offenders, exempt };
      });
      const base = await scan();
      const ex = base.exemplars;
      const exOk = ex.length >= 2 && ex.every(e => e.z === '-1' && e.iso === 'isolate' && e.bg);
      const ok0 = exOk && base.offenders.length === 0;
      /* α：把追光斑的层号注入回 3 → offender 必须重新出现 */
      await injectCss(page, '.liquid-surface::after { z-index: 3 !important; }');
      const injA = await scan();
      await clearInject(page);
      /* β：把棱镜框的环厚注入成 24px → 不再满足 padding ≤2px，豁免必须失效 */
      await injectCss(page, '.liquid-surface::before { padding: 24px !important; }');
      const injB = await scan();
      await clearInject(page);
      /* γ：把 mask 注入成 none（qa 的绕过 ①）→ 遮罩整块消失，豁免必须失效。
         这一条是给 "mask 图层内容" 那项加固留的区分力证据：
         只做 α/β 的话，那一项从未被证明能翻红。 */
      await injectCss(page, '.liquid-surface::before { mask: none !important; }');
      const injC = await scan();
      await clearInject(page);
      /* δ / ε：qa 第二轮的两种**属性级**绕过，给"逐层判定"留区分力证据。
         δ `mask-composite: exclude, add` —— 并集把 content-box 吃掉，等于整块全开
         ε `mask-size` 第二层 30% + no-repeat —— 只留一个洞，文字仍被盖住 */
      await injectCss(page, '.liquid-surface::before { mask-composite: exclude, add !important; }');
      const injD = await scan();
      await clearInject(page);
      await injectCss(page, '.liquid-surface::before { mask-size: 100% 100%, 30% 30% !important; mask-repeat: no-repeat, no-repeat !important; }');
      const injE = await scan();
      await clearInject(page);
      /* ζ：qa 第四轮的第三个属性级残余 —— **最小**注入，只动两个属性：
           mode=luminance（黑色翻成"遮掉"）+ 第一层 black→white 渐变（30% 之后翻成"保留"）
         其余（层数 2 / 纯黑 / 无 rgba( / exclude / size / origin）全部沿用真规则的值，
         所以这个样本与真规则的差异只有 mask-mode 一项 —— 反证力比全量重写强。
         探针实测（qa/r81r2/probe-mask.mjs ④）：修前 exempt=true，加 modeOk 后 false。 */
      await injectCss(page, '.liquid-surface::before {'
        + ' mask-mode: luminance, luminance !important;'
        + ' mask-image: linear-gradient(black 0 30%, white 30%), linear-gradient(black 0 0) !important; }');
      const injF = await scan();
      await clearInject(page);
      const injAOk = injA.offenders.length > base.offenders.length;
      const injBOk = injB.offenders.length > base.offenders.length;
      const injCOk = injC.offenders.length > base.offenders.length;
      const injDOk = injD.offenders.length > base.offenders.length;
      const injEOk = injE.offenders.length > base.offenders.length;
      const injFOk = injF.offenders.length > base.offenders.length;
      const injOk = injAOk && injBOk && injCOk && injDOk && injEOk && injFOk;
      /* 豁免必须是"活的"：一个都没豁免到 ⇒ 这段白名单是死代码，说明选择器或
         计算值口径已经和源码脱节，这种情况按红处理（否则下次真出问题也发现不了）。 */
      const exemptOk = base.exempt.length >= 1;
      return {
        ok: ok0 && injOk && exemptOk,
        injected: {
          ok: injOk,
          detail: `α z-index 注入回 3 → ${base.offenders.length}→${injA.offenders.length}（✓=${injAOk}）；`
            + `β padding 注入成 24px → ${base.offenders.length}→${injB.offenders.length}（✓=${injBOk}）；`
            + `γ mask 注入成 none → ${base.offenders.length}→${injC.offenders.length}（✓=${injCOk}）；`
            + `δ mask-composite 注入成 "exclude, add" → ${base.offenders.length}→${injD.offenders.length}（✓=${injDOk}）；`
            + `ε mask-size 第二层 30% + no-repeat → ${base.offenders.length}→${injE.offenders.length}（✓=${injEOk}）；`
            + `ζ mask-mode=luminance + 第一层 black→white → ${base.offenders.length}→${injF.offenders.length}（✓=${injFOk}）`
        },
        detail: `正样本 ${ex.length} 个磁吸宿主：${ex.map(e => `${e.sel}(z=${e.z},isolation=${e.iso},gradient=${e.bg})`).join(' ')}；`
          + `含文字的宿主上 zIndex≥0 的光学伪元素 = ${base.offenders.length} 个（期望 0）`
          + (base.offenders.length ? ` → ${JSON.stringify(base.offenders.slice(0, 4))}` : '')
          + `；棱镜框窄豁免命中 ${base.exempt.length} 个${base.exempt.length ? `（${JSON.stringify(base.exempt.slice(0, 3))}）` : ''}`
          + `；注入 ①z=3 / ②padding=24px / ③mask=none / ④composite=exclude,add / ⑤size=30% / ⑥mode=luminance 后分别 `
          + `${injA.offenders.length} / ${injB.offenders.length} / ${injC.offenders.length} / ${injD.offenders.length} / ${injE.offenders.length} / ${injF.offenders.length} 个`
          + ` → ${injOk ? '✓ 六项均有区分力' : '✗ 有恒真项'}`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* ---------------------------------------------------------------- OPT-07 */
  /* 属性级：刻度的凹凸对偶 + 液体三层体积。
     ── R76 口径变更：旧版守的是「点亮刻度有 4 层 bloom、未点亮是暗槽上的一枚环」。
        那颗暗槽正是用户判定「突兀、跟液态玻璃没关系」的东西，已随材质一起退役。
        材质换掉后，可见性不再来自"发光"，而来自**明暗对偶**：
          未填充 = 玻璃上的凹刻（左暗 + 右亮，一条 2px 内两种颜色）
          已填充 = 液体里的凸起（白刻线，亮度显著高于液体本体）
        凹与凸方向相反 —— 这是"刻度刻在材质上"能被属性级证伪的最小条件。
     ── 另加液体三层体积：液面高光 / 底部沉色 / 弯月面（inset 描边）。
        三者缺任一条，液体就退回"一块色块"。
  */
  await guard('OPT-07', () => runOpt('OPT-07', '刻度凹凸对偶（凹刻 / 凸起）+ 液体三层体积', {
    anchor() {
      const a = [assertAnchor('components', '.ribbon-tick.is-lit', '点亮态类名（A10b 依赖）')];
      a.push(assertAnchor('html', 'ribbon-tick is-lit', 'HTML 中至少一枚已点亮刻度'));
      a.push(assertAnchorRe('components', /\.ribbon\s*\{[\s\S]{0,400}?overflow/, '.ribbon 的 overflow 声明原处'));
      a.push(assertAnchor('components', '--tick-idle', '凹刻的暗侧令牌'));
      a.push(assertAnchor('components', '--tick-idle-hl', '凹刻的亮侧令牌'));
      a.push(assertAnchor('components', '--liquid-sheen', '液面高光令牌'));
      a.push(assertAnchor('components', '--liquid-sink', '底部沉色令牌'));
      return a.join(' | ');
    },
    async positive() {
      const read = () => page.evaluate(() => {
        const lit = document.querySelector('.ribbon-tick.is-lit');
        const unlit = document.querySelector('.ribbon-tick:not(.is-lit)');
        const fill = document.querySelector('.ribbon-fill');
        const ribbon = document.querySelector('.ribbon');
        return {
          litOk: !!lit, unlitOk: !!unlit, fillOk: !!fill, ribbonOk: !!ribbon,
          litColor: lit ? getComputedStyle(lit).backgroundColor : '',
          litShadow: lit ? getComputedStyle(lit).boxShadow : '',
          unlitImg: unlit ? getComputedStyle(unlit).backgroundImage : '',
          fillColor: fill ? getComputedStyle(fill).backgroundColor : '',
          fillImg: fill ? getComputedStyle(fill).backgroundImage : '',
          fillShadow: fill ? getComputedStyle(fill).boxShadow : '',
          overflow: ribbon ? getComputedStyle(ribbon).overflow : ''
        };
      });
      const b = await read();
      if (!b.litOk || !b.unlitOk || !b.fillOk || !b.ribbonOk)
        throw new Error('刻度/液体/光带元素缺失（.ribbon-tick.is-lit / .ribbon-fill / .ribbon）');

      const relLum = css => {
        const v = (String(css).match(/[\d.]+/g) || []).map(Number);
        if (v.length < 3) return null;
        const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); };
        return .2126 * f(v[0]) + .7152 * f(v[1]) + .0722 * f(v[2]);
      };

      /* ① 凹刻：未点亮刻线的 background-image 必须是"暗侧 / 亮侧"双色渐变 */
      const gradStops = (b.unlitImg.match(/rgba?\(/g) || []).length;
      const concaveOk = gradStops >= 2 && /linear-gradient/.test(b.unlitImg);
      /* ② 凸起：白刻线亮度必须显著高于液体本体 */
      const Llit = relLum(b.litColor), Lfill = relLum(b.fillColor);
      const ridgeOk = Llit !== null && Lfill !== null && (Llit - Lfill) >= 0.10;
      /* ③ 液体三层体积：两层渐变（液面高光 + 底部沉色）+ inset 描边（弯月面） */
      const fillGrads = (b.fillImg.match(/linear-gradient/g) || []).length;
      const volumeOk = fillGrads >= 2 && /inset/.test(b.fillShadow);
      /* ④ 不裁剪：液体圆头与柔光必须能溢出管腔（overflow:hidden 会切掉） */
      const clipOk = b.overflow !== 'hidden';

      const ok0 = concaveOk && ridgeOk && volumeOk && clipOk;

      /* 反例注入一：把白刻线压成与液体同色 ⇒ 凸起消失 */
      const NOTWEEN = '*,*::before,*::after{transition:none!important;animation:none!important;}';
      await injectCss(page, NOTWEEN + '.ribbon-tick.is-lit{background-color:' + b.fillColor
        + '!important;box-shadow:none!important;background-image:none!important;}');
      const injRidge = await page.evaluate(() => {
        const el = document.querySelector('.ribbon-tick.is-lit');
        return el ? getComputedStyle(el).backgroundColor : '';
      });
      await clearInject(page);
      const injRidgeL = relLum(injRidge);
      const injOk = injRidgeL !== null && Lfill !== null && (injRidgeL - Lfill) < 0.10;

      /* 反例注入二：抽掉凹刻的双色渐变 ⇒ 刻线在玻璃上等同隐形 */
      await injectCss(page, NOTWEEN + '.ribbon-tick{background-image:none!important;background-color:transparent!important;}');
      const injImg = await page.evaluate(() => {
        const el = document.querySelector('.ribbon-tick:not(.is-lit)');
        return el ? getComputedStyle(el).backgroundImage : '';
      });
      await clearInject(page);
      const inj2Ok = injImg === 'none';

      return {
        ok: ok0 && injOk && inj2Ok,
        injected: {
          ok: injOk && inj2Ok,
          detail: `把白刻线涂成液体色 → L=${injRidgeL === null ? 'null' : injRidgeL.toFixed(4)}`
            + `（需 < 液体 ${Lfill === null ? 'null' : Lfill.toFixed(4)} + 0.10）`
            + `；抽掉凹刻渐变 → backgroundImage=${injImg}`
        },
        detail: `凹刻双色 stop=${gradStops}（≥2 ${concaveOk ? '✓' : '✗'}）；`
          + `白刻线 L=${Llit === null ? 'null' : Llit.toFixed(4)} − 液体 L=${Lfill === null ? 'null' : Lfill.toFixed(4)}`
          + ` = ${(Llit !== null && Lfill !== null) ? (Llit - Lfill).toFixed(4) : 'null'}（≥0.10 ${ridgeOk ? '✓' : '✗'}）；`
          + `液体渐变 ${fillGrads} 层 + inset 弯月面 ${/inset/.test(b.fillShadow) ? '✓' : '✗'}（${volumeOk ? '✓' : '✗'}）；`
          + `.ribbon overflow=${b.overflow}（≠hidden ${clipOk ? '✓' : '✗'}）`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* ---------------------------------------------------------------- OPT-11 */
  await guard('OPT-11', () => runOpt('OPT-11', '空态光柱：只动 transform + 节点数受控 + z-index:-1', {
    anchor() {
      const a = [assertAnchor('html', 'well-shaft', '光柱宿主')];
      a.push(assertAnchor('components', '.mote', '微粒规则'));
      a.push(assertAnchor('components', 'translate3d', '微粒位移必须是合成层属性'));
      return a.join(' | ');
    },
    async positive() {
      /* ★ 测量条件对齐（R73-E 起，非放宽）：
         光柱现在只在**空态**露出（常驻 #emptyGuide，有内容即随 guide.hidden 隐藏）。
         Chromium 对 display:none 子树里的元素**恒返回** getComputedStyle().transform === 'none'
         —— 那是"没有布局盒子"，不是"位移没走 transform"。
         若直接在非空态取样本，这条断言会把**设计上的可见性切换**误判成"位移没走 transform"。
         所以在取样本期间临时解除隐藏祖先的 hidden，取完立刻还原；断言一个字不改。 */
      const read = () => page.evaluate(() => {
        const parked = [];
        document.querySelectorAll('.well-shaft').forEach(s => {
          for (let n = s; n && n.nodeType === 1; n = n.parentElement) {
            if (n.hasAttribute('hidden')) { parked.push(n); n.removeAttribute('hidden'); }
          }
        });
        const shafts = [...document.querySelectorAll('.well-shaft')];
        const out = shafts.map(s => {
          const motes = [...s.querySelectorAll('.mote')];
          return {
            desc: s.querySelectorAll('*').length,
            z: getComputedStyle(s).zIndex,
            ambient: s.hasAttribute('data-ambient'),
            moteCount: motes.length,
            moteTransforms: motes.map(m => getComputedStyle(m).transform),
            moteAnim: motes.map(m => getComputedStyle(m).animationName)
          };
        });
        parked.forEach(n => n.setAttribute('hidden', ''));
        return out;
      });
      const base = await read();
      const problems = [];
      /* ★ translate3d(0,0,0) 会被 Chromium 折叠成二维单位矩阵，computed transform
         序列化成 `matrix(1, 0, 0, 1, 0, 0)` 而不是 `matrix3d(...)` ——
         所以**不能**用 "computed 里含 matrix3d" 当成"用了 translate3d"的证据
         （静止态下那条断言对正确实现是假红）。
         正确做法：源码侧证 translate3d（合成层意图）+ 运行时证 transform 真的被用上。 */
      const srcTranslate = ruleBodiesMatching(SRC.components, '.mote').some(b => /translate3d/.test(b));
      if (!srcTranslate) problems.push('.mote 规则未声明 translate3d（不是合成层位移）');
      if (!base.length) problems.push('.well-shaft 数量 = 0');
      base.forEach((s, i) => {
        if (s.desc > 24) problems.push(`#${i} 子节点 ${s.desc} > 24`);
        if (s.z !== '-1') problems.push(`#${i} z-index=${s.z}（应 -1）`);
        if (!s.ambient) problems.push(`#${i} 缺 data-ambient`);
        if (s.moteCount !== 12) problems.push(`#${i} .mote=${s.moteCount}（应 12）`);
        s.moteTransforms.forEach((t, j) => {
          if (t === 'none') problems.push(`#${i} mote[${j}] transform=none（位移没走 transform）`);
        });
        s.moteAnim.forEach((a, j) => { if (a !== 'none') problems.push(`#${i} mote[${j}] animationName=${a}`); });
      });
      const ok0 = problems.length === 0;
      await injectCss(page, '.mote { transform: none !important; }');
      const inj = await read();
      await clearInject(page);
      const injOk = inj.length > 0 && inj.some(s => s.moteTransforms.some(t => t === 'none'));
      return {
        ok: ok0 && injOk,
        injected: { ok: injOk, detail: `把 .mote 的 transform 置空后，出现 transform=none 的微粒 ${injOk ? '（判据翻红）' : '（未翻红）'}` },
        detail: ok0
          ? `${base.length} 个光柱：子节点 ${base.map(s => s.desc).join('/')}（≤24）、z-index=${base.map(s => s.z).join('/')}、`
            + `.mote=${base.map(s => s.moteCount).join('/')} 且位移全走 transform（源码 translate3d，运行时非 none）、animationName 全 none；`
            + `把 .mote 的 transform 置空后 ${injOk ? '✓ 翻红（证明"只动 transform"被真正断言）' : '✗ 恒真'}`
          : problems.slice(0, 6).join(' ; ')
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* ---------------------------------------------------------------- OPT-12 */
  await guard('OPT-12', () => runOpt('OPT-12', '光效不承载信息、也不进内容指纹', {
    anchor() {
      const a = [assertAnchor('html', 'well-shaft', '光柱宿主')];
      const shaftTag = (SRC.html.match(/<[^>]*well-shaft[^>]*>/) || [''])[0];
      if (shaftTag.indexOf('aria-hidden') < 0) throw new Error('.well-shaft 标签缺 aria-hidden');
      a.push('html ✓ .well-shaft 带 aria-hidden');
      if (/\.well-shaft[^{]*\{[^}]*color\s*:/.test(SRC.components)) a.push('components 提示：.well-shaft 设了 color（mask 用 currentColor，属预期）');
      return a.join(' | ');
    },
    async positive() {
      /* ★ 规格内部冲突的处理（不擅自放宽，改成更强的可满足形式）：
         §6.1 要求把 .well-shaft 放进 #chatWelcome / #emptyGuide，而这两个容器
         自身带 data-key-content —— 所以 §9 字面上的「.well-shaft 不在
         [data-key-content] 内」**不可能同时成立**。
         本判据改为直接验证它的**目的**：装饰节点存在/不存在时，
         所有 [data-key-content] 的内容指纹必须逐字相同（这才是
         QA-A7-2 与 overlayHits 真正依赖的东西）。比"不在容器内"更强。 */
      const FP = `(el) => ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())`;
      const read = () => page.evaluate(fpSrc => {
        const fp = eval('(' + fpSrc + ')');
        const SEL = ['.well-shaft', '.nav-edge', '.atmosphere'];
        const rows = [];
        SEL.forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            rows.push({
              sel,
              ariaHidden: el.getAttribute('aria-hidden'),
              text: (el.innerText || '').trim(),
              inKeyContent: !!el.closest('[data-key-content]')
            });
          });
        });
        const fps = [...document.querySelectorAll('[data-key-content]')]
          .map(n => ({ id: n.id || n.getAttribute('data-key-content'), fp: fp(n) }));
        /* QA-A7-2 的 9 板块内容指纹：装饰节点不得让任意两个板块"碰巧相等" */
        const panels = [...document.querySelectorAll('[data-view-panel]')]
          .map(p => ({ id: p.getAttribute('data-view-panel'), fp: fp(p) }));
        return { rows, fps, panels, decoCount: document.querySelectorAll(SEL.join(',')).length };
      }, FP);
      const stripDeco = () => page.evaluate(SELL => {
        document.querySelectorAll(SELL.join(',')).forEach(n => {
          n.setAttribute('data-optics-saved', '1');
          n.style.display = 'none';
        });
        const fp = (el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
        return [...document.querySelectorAll('[data-key-content]')]
          .map(n => ({ id: n.id || n.getAttribute('data-key-content'), fp: fp(n) }));
      }, ['.well-shaft', '.nav-edge', '.atmosphere']);

      const base = await read();
      const problems = [];
      if (!base.rows.some(r => r.sel === '.well-shaft')) problems.push('.well-shaft 不存在（光柱缺失）');
      base.rows.forEach(r => {
        if (r.ariaHidden !== 'true') problems.push(`${r.sel} aria-hidden=${r.ariaHidden}（装饰节点必须对 AT 隐藏）`);
        if (r.text.length > 0) problems.push(`${r.sel} 含文本 "${r.text.slice(0, 20)}"`);
      });
      /* 指纹不变性：把装饰节点 display:none 后再取一次指纹 */
      const fpsOff = await stripDeco();
      const fpSame = JSON.stringify(fpsOff) === JSON.stringify(base.fps);
      if (!fpSame) {
        const diff = base.fps.filter((x, i) => !fpsOff[i] || fpsOff[i].fp !== x.fp).map(x => x.id);
        problems.push(`装饰节点参与了内容指纹（受影响容器 ${JSON.stringify(diff)}）`);
      }
      /* ★ 主理人加的一条：改写后的判据必须同时守住 QA-A7-2 ——
         9 个板块指纹仍两两不同。（否则工程师可以把光柱塞进某个板块，
         让两个板块的指纹碰巧相等，而"指纹不变"这条发现不了。） */
      if (base.panels.length !== 9) {
        problems.push(`[data-view-panel] 数量 ${base.panels.length}（QA-A7-2 要求 9）`);
      }
      const uniq = new Set(base.panels.map(p => p.fp));
      if (uniq.size !== base.panels.length) {
        const dup = base.panels.map(p => p.fp).filter((fp, i, a) => a.indexOf(fp) !== i);
        problems.push(`9 板块内容指纹未两两互异（重复 ${dup.length} 个，QA-A7-2 会红）`);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      await settle(page, 'opt12-restore');

      const ok0 = problems.length === 0;
      await page.evaluate(() => {
        const s = document.querySelector('.well-shaft');
        if (s) { const t = document.createElement('span'); t.className = '__optics_probe_text'; t.textContent = 'PROBE'; s.appendChild(t); }
      });
      await page.waitForTimeout(40);
      const inj = await read();
      await page.evaluate(() => document.querySelectorAll('.__optics_probe_text').forEach(n => n.remove()));
      const injOk = inj.rows.some(r => r.sel === '.well-shaft' && r.text.length > 0);
      return {
        ok: ok0 && injOk,
        injected: { ok: injOk, detail: `给 .well-shaft 注入一段文字后，含文本节点 ${inj.rows.filter(r => r.text.length > 0).length} 个（需 ≥1）` },
        detail: ok0
          ? `${base.rows.length} 个光效装饰节点：aria-hidden 全 true、innerText 全空；`
            + `隐藏全部装饰节点后 ${base.fps.length} 个 [data-key-content] 容器指纹逐字不变（${fpSame ? '✓ 不进内容指纹' : '✗'}）；`
            + `${base.panels.length} 个板块内容指纹两两互异（${uniq.size}/${base.panels.length} ✓ QA-A7-2 未被破坏）；`
            + `其中 ${base.rows.filter(r => r.inKeyContent).length} 个确实嵌在 [data-key-content] 内（按 §6.1 允许，靠零文本保证不影响指纹）；`
            + `往里塞一段文字后 ${injOk ? '✓ 翻红（证明"零文本"被真正断言）' : '✗ 恒真'}`
          : problems.slice(0, 6).join(' ; ')
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* ---------------------------------------------------------------- OPT-09 */
  /* 降级路径必须"停在最亮终态"而不是"把光关掉"：reduce 与 body.fx-off 各验一次。 */
  await guard('OPT-09', () => runOpt('OPT-09', '降级 = 停在最亮终态（reduce 与 body.fx-off 双路径）', {
    anchor() {
      const a = [assertAnchor('tokens', '--lw-breath:', '呼吸倍率的 :root 默认值（零 JS 也必须对）')];
      a.push(assertAnchor('tokens', '--lw-dx:', ''));
      a.push(assertAnchor('tokens', '--lw-fall:', ''));
      a.push(assertAnchor('main', '--lw-breath', 'JS 侧写入点'));
      a.push(assertAnchor('main', 'fx-off', '手动降级通道'));
      return a.join(' | ');
    },
    async positive() {
      const read = () => page.evaluate(() => {
        const atmo = document.querySelector('.atmosphere') || document.documentElement;
        const cs = getComputedStyle(atmo);
        const g = k => (cs.getPropertyValue(k) || '').trim();
        const mote = document.querySelector('.mote');
        const mcs = mote ? getComputedStyle(mote) : null;
        const lit = document.querySelector('.ribbon-tick.is-lit');
        const shafts = document.querySelectorAll('.well-shaft');
        return {
          breath: g('--lw-breath'), dx: g('--lw-dx'),
          dy: g('--lw-dy'), fall: mcs ? (mcs.getPropertyValue('--lw-fall') || '').trim() : g('--lw-fall'),
          shaftCount: shafts.length,
          moteCount: document.querySelectorAll('.mote').length,
          moteOpacities: [...document.querySelectorAll('.mote')].map(m => parseFloat(getComputedStyle(m).opacity)),
          moteVisible: mote ? (mote.getClientRects().length > 0) : false,
          litLayers: lit ? (getComputedStyle(lit).boxShadow.match(/rgba?\(/g) || []).length : -1,
          /* R76：降级要求从"光的层数"改成"对比还在"。层的数量是 R73 发光材质的度量，
             换材质后它不再对应任何可见事实；能对应的是"白刻线 vs 液体"的亮度差。 */
          litColor: lit ? getComputedStyle(lit).backgroundColor : '',
          fillColor: document.querySelector('.ribbon-fill')
            ? getComputedStyle(document.querySelector('.ribbon-fill')).backgroundColor : '',
          fxOff: document.body.classList.contains('fx-off')
        };
      });
      const judge = (r, label) => {
        const f = [];
        /* 按**数值**判等而不是按字符串：'1' / '1.0' / '1.000' 语义相同，
           用字符串严格相等会把"用 tick 里同一个 toFixed 写终态"的正确实现误判成红。 */
        const num = s => {
          const v = parseFloat(s);
          return Number.isFinite(v) ? v : NaN;
        };
        if (!(Math.abs(num(r.breath) - 1) < 1e-6)) f.push(`${label} --lw-breath=${JSON.stringify(r.breath)}（应 ≈1 = 最亮）`);
        if (!(Math.abs(num(r.dx)) < 1e-6)) f.push(`${label} --lw-dx=${JSON.stringify(r.dx)}（应 ≈0px）`);
        if (!(Math.abs(num(r.dy)) < 1e-6)) f.push(`${label} --lw-dy=${JSON.stringify(r.dy)}（应 ≈0px）`);
        if (!(Math.abs(num(r.fall)) < 1e-6)) f.push(`${label} --lw-fall=${JSON.stringify(r.fall)}（应 ≈0px）`);
        if (r.shaftCount > 0 && r.moteCount !== 12 * r.shaftCount) f.push(`${label} .mote=${r.moteCount}（应 ${12 * r.shaftCount}）`);
        if (r.moteCount === 0) f.push(`${label} .mote=0（降级不该让微粒消失）`);
        if (r.moteOpacities.some(o => !(o > 0))) f.push(`${label} 存在 opacity=0 的微粒`);
        /* R76 口径变更：R73 要求降级后点亮刻度仍有 >=4 层 box-shadow —— 那是"发光"的度量。
           R76 的刻度是"液体里的白刻线"，可见性来自对比度而不是 bloom 层数。
           继续数层数会把"正确的降级"判成红（实测只剩 2 层：1px 环 + 7px 柔光）。
           新判据直接咬可见事实：白刻线与液体本体的亮度差必须仍在（>=0.10），
           且刻线自身不能是透明的。 */
        if (r.litLayers < 2) f.push(`${label} 点亮刻度 boxShadow ${r.litLayers} 层（<2，连柔光都掉了）`);
        {
          const rl = css => {
            const v = (String(css).match(/[\d.]+/g) || []).map(Number);
            if (v.length < 3) return null;
            const fn = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); };
            return .2126 * fn(v[0]) + .7152 * fn(v[1]) + .0722 * fn(v[2]);
          };
          const Ll = rl(r.litColor), Lf = rl(r.fillColor);
          if (Ll === null || Lf === null) f.push(`${label} 白刻线/液体背景色读不到`);
          else if (Ll - Lf < 0.10) f.push(`${label} 白刻线 L=${Ll.toFixed(4)} − 液体 L=${Lf.toFixed(4)} = ${(Ll - Lf).toFixed(4)}（<0.10，对比被降级抹掉）`);
        }
        return f;
      };

      /* 路径 1：prefers-reduced-motion: reduce */
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      await settle(page, 'reduce');
      const reduceState = await read();
      const reduceFails = judge(reduceState, 'reduce');

      /* ★ 黑盒间接证据：**时钟真的停了**（不读任何内部状态、不碰实现）。
         依据：--lw-fall 周期 26s、行程 120px ⇒ ≈4.6px/s，600ms 约走 2.8px；
         --lw-breath 周期 11s 同样会在 600ms 内变化。
         若降级只"写了一次数值"而时钟仍在跑，三次读数必然不等；
         三次逐字相等 ⇒ 反证时钟已停。这比"单次采样恰好落在终态区间外"强。 */
      const sampleVars = () => page.evaluate(() => {
        const atmo = document.querySelector('.atmosphere') || document.querySelector('[data-ambient]') || document.documentElement;
        const cs = getComputedStyle(atmo);
        const mote = document.querySelector('.mote');
        const mcs = mote ? getComputedStyle(mote) : null;
        const g = k => (cs.getPropertyValue(k) || '').trim();
        return {
          breath: g('--lw-breath'), dx: g('--lw-dx'), dy: g('--lw-dy'),
          fall: mcs ? (mcs.getPropertyValue('--lw-fall') || '').trim() : g('--lw-fall')
        };
      });
      const s1 = await sampleVars();
      await page.waitForTimeout(600);
      const s2 = await sampleVars();
      await page.waitForTimeout(600);
      const s3 = await sampleVars();
      const stableOk = JSON.stringify(s1) === JSON.stringify(s2) && JSON.stringify(s2) === JSON.stringify(s3);
      if (!stableOk) {
        reduceFails.push(`reduce 下 3 次采样（间隔 600ms）不一致 ⇒ 时钟未停：${JSON.stringify([s1, s2, s3])}`);
      }
      const stableNote = stableOk
        ? `reduce 下 3 次采样（600ms 间隔）逐字相同 ${JSON.stringify(s1)} ⇒ 反证时钟已停`
        : 'reduce 下 3 次采样不一致（时钟未停）';

      /* 反例注入：在 reduce 下强行让 JS/样式写 --lw-breath: .9 → 必须 FAIL */
      await page.evaluate(() => {
        const atmo = document.querySelector('.atmosphere') || document.documentElement;
        atmo.style.setProperty('--lw-breath', '.9');
      });
      await page.waitForTimeout(60);
      const injState = await read();
      const injFails = judge(injState, 'reduce+注入');
      await page.evaluate(() => {
        const atmo = document.querySelector('.atmosphere') || document.documentElement;
        atmo.style.removeProperty('--lw-breath');
      });
      const injOk = injFails.length > reduceFails.length;

      /* 路径 2：手动 body.fx-off（走真实交互路径 #fxToggle / FxController.sync） */
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      await settle(page, 'fx-on');
      const onState = await read();
      await page.evaluate(() => {
        if (window.__R72 && window.__R72.FxController) {
          window.__R72.FxController.enabled = false;
          window.__R72.FxController.sync();
        } else {
          const b = document.getElementById('fxToggle');
          if (b) b.click(); else document.body.classList.add('fx-off');
        }
      });
      await page.waitForTimeout(700);
      const offState = await read();
      const offFails = judge(offState, 'fx-off');
      if (!offState.fxOff) offFails.push('fx-off 路径未生效（body 无 fx-off 类）');

      const ok0 = reduceFails.length === 0 && offFails.length === 0 && stableOk;
      /* 复位：恢复动效 + 正常媒体（后续截图与其它判据依赖默认态） */
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      await settle(page, 'restore');
      return {
        ok: ok0 && injOk,
        injected: { ok: injOk, detail: `reduce 下强写 --lw-breath:.9 → 违约项 ${reduceFails.length} → ${injFails.length}（需增加，实测 ${JSON.stringify(injState.breath)}）` },
        detail: ok0
          ? `reduce: breath=${reduceState.breath} dx=${reduceState.dx} dy=${reduceState.dy} fall=${reduceState.fall}、`
            + `.mote=${reduceState.moteCount}（全 opacity>0）、点亮刻度 ${reduceState.litLayers} 层；${stableNote}；`
            + `fx-off: breath=${offState.breath} dx=${offState.dx} dy=${offState.dy} fall=${offState.fall}、`
            + `.mote=${offState.moteCount}、点亮刻度 ${offState.litLayers} 层（body.fx-off=${offState.fxOff}）；`
            + `未降级时 breath=${onState.breath}（仅供参考：无头环境 document.hidden 可能为真，`
            + `按 §5.2 规格时钟会主动停表，故此项不作断言，反恒真证据来自下面的注入）；`
            + `注入 --lw-breath:.9 后 ${injOk ? '✓ 翻红' : '✗ 未翻红'}`
          : [...reduceFails, ...offFails].slice(0, 8).join(' ; ')
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* --------------------------------------------------------------- OPT-13 */
  /* 像素级：液态玻璃光带的三个物理特征（明暗两套主题各测一遍，两套都成立才算过）。
     ── R76 口径变更（用户裁决 2026-11-13）：R73 的三条 ——
          「格心 − 槽底 ≥ 0.10」「边缘比格心亮（灯丝）」「halo 单调衰减」——
          全部建立在"近黑凹槽 + 发光刻度"上。那颗暗槽正是用户判定
          「突兀、跟液态玻璃没关系」的东西，已随材质一起退役；材质换掉后旧尺子没有对象。
     ── 现行三条，取自 iOS Liquid Glass 可测的特征：
        ① 液体可分辨   |L(液体本体) − L(玻璃槽底)| ≥ 0.10
        ② 管口镜面     L(上沿 1px) − L(管腔中心) ≥ 0.04      ← 玻璃"厚度"的唯一像素证据
        ③ 刻线有立体   |L(刻线暗侧) − L(刻线亮侧)| ≥ 0.15    ← 纯色条内部亮度恒等，必有双色
                       且刻线与玻璃可分辨（|ΔL| ≥ 0.10）
     ── 取样纪律（本轮实测踩到的三个坑，写下来避免下一轮重犯）：
        · 刻线宽 2px：左 1px 与右 1px 是两种颜色，取"中心"会随抗锯齿摇摆
          （同一份代码两次采样得到 0.8559 / 0.0645）⇒ 必须分别取 0.25 / 1.75。
        · 未点亮刻度必须**整根落在液体之外**：fill 宽 43%，而 40% 位置那枚刻度
          正好压在液面上（它不是 .is-lit，但环境是液体），拿它当"玻璃上的刻线"
          会把液体读成玻璃 —— 上一版判据就是这么量到 0.1015 的。
        · 槽底取样点必须距任何刻度 ≥13px：刻线外侧有 7px 柔光。
  */
  await guard('OPT-13', () => runOpt('OPT-13', '成本光带像素级可测（液态玻璃三条：液体可分辨 / 管口镜面 / 刻线立体 · 明暗双验）', {
    anchor() {
      const a = [assertAnchor('components', '.ribbon-tick.is-lit', '点亮态规则')];
      const litBodies = ruleBodiesMatching(SRC.components, '.ribbon-tick.is-lit');
      if (!litBodies.some(b => /box-shadow/.test(b))) throw new Error('.ribbon-tick.is-lit 无 box-shadow（凸起无证据）');
      a.push('components ✓ .is-lit 声明 box-shadow');
      a.push(assertAnchor('components', '.ribbon {', '轨道本体'));
      a.push(assertAnchor('components', '.ribbon-fill', '液体本体'));
      a.push(assertAnchor('html', 'ribbon-tick is-lit', 'DOM 里至少一枚已点亮刻度'));
      a.push(/--liquid-sheen:/.test(SRC.tokens) ? 'tokens ✓ --liquid-sheen' : 'tokens · --liquid-sheen 缺失');
      a.push(/--tick-idle:/.test(SRC.tokens) ? 'tokens ✓ --tick-idle' : 'tokens · --tick-idle 缺失');
      return a.join(' | ');
    },
    async positive() {
      const geom = () => page.evaluate(() => {
        const rc = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const rb = document.querySelector('.ribbon');
        const fill = document.querySelector('.ribbon-fill');
        return {
          ribbon: rb ? rc(rb) : null,
          fill: fill ? rc(fill) : null,
          lit: [...document.querySelectorAll('.ribbon-tick.is-lit')].map(rc),
          unlit: [...document.querySelectorAll('.ribbon-tick:not(.is-lit)')].map(rc)
        };
      });

      const measureOne = async () => {
        const g0 = await geom();
        if (!g0.ribbon || !g0.fill || !g0.lit.length) throw new Error('.ribbon / .ribbon-fill / .is-lit 缺失');
        const cy = g0.ribbon.y + g0.ribbon.h / 2;
        const litC = g0.lit.map(l => l.x + l.w / 2);
        const allC = [...g0.lit, ...g0.unlit].map(l => l.x + l.w / 2);

        /* 液体取样：fill 内、距任一已点亮刻度 ≥13px（避开柔光） */
        let fx = null;
        for (let X = g0.fill.x + g0.fill.w - 6; X > g0.fill.x + 4; X -= 1) {
          if (Math.min(...litC.map(c => Math.abs(c - X))) >= 13) { fx = X; break; }
        }
        /* 玻璃槽底：液体右侧、距任一刻度 ≥13px */
        let gx = null;
        for (let X = g0.fill.x + g0.fill.w + 8; X < g0.ribbon.x + g0.ribbon.w - 6; X += 1) {
          if (Math.min(...allC.map(c => Math.abs(c - X))) >= 13) { gx = X; break; }
        }
        /* 干燥刻线：整根在液体之外 */
        const dry = g0.unlit.filter(l => l.x > g0.fill.x + g0.fill.w + 6);
        if (fx === null || gx === null) throw new Error('液体/槽底取样点不可用');
        if (!dry.length) throw new Error('找不到落在液体之外的未点亮刻度');

        const g = await grab(page, {
          x: g0.ribbon.x - 8, y: g0.ribbon.y - 8,
          w: g0.ribbon.w + 16, h: g0.ribbon.h + 16
        });
        const lumAt = (X, Y) => { const p = inClip(g, X, Y); return pxLum(g.img, p[0], p[1]); };
        const vmed = (X, Y0, Y1) => {
          const v = [];
          for (let Y = Y0; Y <= Y1 + 1e-9; Y += 0.5) { const q = lumAt(X, Y); if (q !== null) v.push(q); }
          v.sort((a, b) => a - b);
          return v.length ? v[v.length >> 1] : null;
        };

        const liquid = vmed(fx, cy - 2, cy + 2);
        const glass = vmed(gx, cy - 2, cy + 2);
        /* 上沿：y = ribbon.y + 1（border 内侧第一行）；腔中心同 x 对照 */
        const rimX = g0.ribbon.x + g0.ribbon.w * 0.62;
        const rim = vmed(rimX, g0.ribbon.y + 1, g0.ribbon.y + 1.5);
        const cavity = vmed(rimX, cy - 1, cy + 1);
        const t = dry[0];
        /* 2 CSS px 宽 = 4 设备像素（DPR 2）：左 1px 占设备 0–1、右 1px 占 2–3。
           取 CSS 0.5 / 1.5 = 设备 1 / 3，正好是两半的中心。
           取 0.25 / 1.75 会让右点落到设备 3.5 → 越界到元素外，
           量到的是"白刻线与玻璃的抗锯齿混合"（实测 0.8400，与玻璃 0.8383 几乎相同，
           把"刻线与玻璃可分辨"这一条判成红 —— 是取样错，不是设计错）。 */
        const tDark = vmed(t.x + 0.5, cy - 3, cy + 3);
        const tHL = vmed(t.x + 1.5, cy - 3, cy + 3);

        const dLiquid = (liquid !== null && glass !== null) ? Math.abs(liquid - glass) : null;
        const dRim = (rim !== null && cavity !== null) ? (rim - cavity) : null;
        const dTick = (tDark !== null && tHL !== null) ? Math.abs(tHL - tDark) : null;
        const dTickGlass = (glass !== null && tDark !== null && tHL !== null)
          ? Math.abs(Math.max(tDark, tHL) - glass) : null;

        return {
          g0, fx, gx, liquid, glass, rim, cavity, tDark, tHL,
          dLiquid, dRim, dTick, dTickGlass,
          okA: dLiquid !== null && dLiquid >= 0.10,
          okB: dRim !== null && dRim >= 0.04,
          okC: dTick !== null && dTick >= 0.15 && dTickGlass !== null && dTickGlass >= 0.10
        };
      };
      const fmt = m => `① |液体−玻璃|=${m.dLiquid === null ? 'null' : m.dLiquid.toFixed(4)}`
        + `（L ${m.liquid === null ? 'null' : m.liquid.toFixed(4)} / ${m.glass === null ? 'null' : m.glass.toFixed(4)}）`
        + ` ② 上沿−腔心=${m.dRim === null ? 'null' : m.dRim.toFixed(4)}`
        + `（${m.rim === null ? 'null' : m.rim.toFixed(4)} / ${m.cavity === null ? 'null' : m.cavity.toFixed(4)}）`
        + ` ③ 刻线对偶=${m.dTick === null ? 'null' : m.dTick.toFixed(4)}`
        + `（暗 ${m.tDark === null ? 'null' : m.tDark.toFixed(4)} / 亮 ${m.tHL === null ? 'null' : m.tHL.toFixed(4)}）`
        + `、刻线−玻璃=${m.dTickGlass === null ? 'null' : m.dTickGlass.toFixed(4)}`;

      /* ---- 明暗双测 ---- */
      const setTheme = t => page.evaluate(th => {
        if (th === 'light') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', th);
      }, t);
      await setTheme('light');
      await page.waitForTimeout(420);
      const mL = await measureOne();
      await setTheme('dark');
      await page.waitForTimeout(420);
      const mD = await measureOne();

      const ok0 = mL.okA && mL.okB && mL.okC && mD.okA && mD.okB && mD.okC;

      /* ---- 反例注入（明色下）：三条各打一枪 ---- */
      const NOTWEEN = '*,*::before,*::after{transition:none!important;animation:none!important;}';
      await setTheme('light');
      await page.waitForTimeout(360);

      /* α → ①：把液体抹掉（保留管腔）⇒ 液体与玻璃必须分不开 */
      await injectCss(page, NOTWEEN + '.ribbon-fill{opacity:0!important;}');
      const iA = await measureOne();
      await clearInject(page);
      /* β → ②：抽掉 .ribbon 的全部 box-shadow ⇒ 上沿镜面消失 */
      await injectCss(page, NOTWEEN + '.ribbon{box-shadow:none!important;outline:none!important;}');
      const iB = await measureOne();
      await clearInject(page);
      /* γ → ③：抽掉刻线的双色渐变 ⇒ 刻线内部亮度恒等 */
      await injectCss(page, NOTWEEN
        + '.ribbon-tick{background-image:none!important;background-color:transparent!important;'
        + 'box-shadow:none!important;}');
      const iC = await measureOne();
      await clearInject(page);

      const inj = [
        { name: 'α→①', broke: !iA.okA, got: iA.dLiquid === null ? 'null' : iA.dLiquid.toFixed(4) },
        { name: 'β→②', broke: !iB.okB, got: iB.dRim === null ? 'null' : iB.dRim.toFixed(4) },
        { name: 'γ→③', broke: !iC.okC, got: iC.dTick === null ? 'null' : iC.dTick.toFixed(4) }
      ];
      const injOk = inj.every(x => x.broke);

      return {
        ok: ok0 && injOk,
        injected: {
          ok: injOk,
          detail: inj.map(x => `${x.name} 注入后 ${x.got} → ${x.broke ? '翻红 ✓' : '仍 PASS ✗'}`).join('；')
        },
        detail: `明色 ${fmt(mL)} ｜ 暗色 ${fmt(mD)}`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));


  /* --------------------------------------------------------------- OPT-14 */
  /* 像素级：§6 的签名（光柱 + 12 粒下沉的尘埃）在这版里"完全不可见"。
     OPT-11 只断言了 transform 与节点数 —— 属性正确、画面为零。
   ─────────────────────────────────────────────────────────────────────────
   ★ 标签更正（主理人裁决）：旧标题与注释把 ① 段写成「带内外差」，
     但它的采样点是 cx（光柱中线）与 cx ± 24px ——
     `.well-shaft` 宽 --shaft-w = 104px（半宽 52px），**±24px 仍在带内**。
     所以这把尺子量的是「**带内水平落差**：亮芯（56px 白芯，--shaft-core .80）
     vs 带内边缘（--shaft-bed 暗衬只有左右两侧露出来）」，
     不是"带内 vs 带外"。标题、注释、detail 全部按此更正，采样点一个字都不动。
     为什么不把采样点挪到真正的带外：
       带外是 .chat-welcome 的釉面（--color-raised，明色 L≈0.9705），
       而白芯叠完只有 ~0.92 —— 一旦挪出去，这个差值会变成"卡片 vs 卡片"，
       判据在近白底上近乎恒真。保留原采样点，只改标签，是唯一诚实的做法。
   ★ 由此暴露的**未覆盖面**（本次补上，见 okD）：带内中心与"它所处的那张卡片"
     的**方向关系**。带内落差达标 ≠ 光柱读起来是"一道压暗的窄带"；
     如果暗衬被白芯彻底洗白（--shaft-bed 过小），带内落差可以靠"亮芯 vs 两侧极窄暗边"
     继续成立，但光柱整体与卡片同亮度 ⇒ 视觉上等于不存在。
     所以新增：L(带内中心) 与 .chat-welcome 的 backgroundColor 合成值
     **方向相反**（明色更暗 / 暗色更亮）且差 ≥0.02。
   ─────────────────────────────────────────────────────────────────────────
     下方 okA(A 段) 复用的仍是旧采样；detail 里同时给出
     L_in / L_outL / L_outR 三个原始值，便于主理人复核它与 okD 的差别。 */
  await guard('OPT-14', () => runOpt('OPT-14', '光柱与微粒像素级可测（带内水平落差 = 亮芯 vs 带内边缘 + 与卡片方向相反；不是"带内外差"）', {
    anchor() {
      const a = [assertAnchor('html', 'well-shaft', '光柱宿主')];
      a.push(assertAnchor('components', '.well-shaft', '光柱规则'));
      a.push(assertAnchor('tokens', '--mote:', '微粒颜色令牌'));
      a.push(assertAnchor('tokens', '--shaft-core:', '光柱柱体令牌'));
      /* okD 需要"光柱所在的那张卡片"的底色：--color-raised 与 .chat-welcome 的桩都要在。 */
      a.push(assertAnchor('tokens', '--color-raised:', 'okD 的对照组底色令牌'));
      a.push(assertAnchor('html', 'chat-welcome', 'okD 的对照组宿主'));
      return a.join(' | ');
    },
    async positive() {
      /* 统计"显著高于 8px 邻域的局部亮点"，并要求连通区域 ≥2×2 px */
      const countMotes = (img, x0, y0, x1, y1, thr) => {
        const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
        const RING = 8;
        const mask = new Uint8Array(W * H);
        const DIRS = [[-RING, 0], [RING, 0], [0, -RING], [0, RING],
          [-RING, -RING], [RING, RING], [-RING, RING], [RING, -RING]];
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const L = pxLum(img, x0 + x, y0 + y);
            if (L === null) continue;
            let sum = 0, c = 0;
            for (const [dx, dy] of DIRS) {
              const v = pxLum(img, x0 + x + dx, y0 + y + dy);
              if (v !== null) { sum += v; c++; }
            }
            if (!c) continue;
            if (Math.abs(L - sum / c) >= thr) mask[y * W + x] = 1;
          }
        }
        const seen = new Uint8Array(W * H);
        const blobs = [];
        for (let i = 0; i < W * H; i++) {
          if (!mask[i] || seen[i]) continue;
          const stack = [i]; seen[i] = 1;
          let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
          while (stack.length) {
            const p = stack.pop();
            const x = p % W, y = (p / W) | 0;
            n++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const q = ny * W + nx;
              if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
            }
          }
          blobs.push({ n, w: maxX - minX + 1, h: maxY - minY + 1 });
        }
        return blobs.filter(b => b.w >= 2 && b.h >= 2 && b.n >= 2).length;
      };

      const measure = async (theme) => {
        await page.evaluate(t => {
          document.documentElement.setAttribute('data-theme', t);
          window.scrollTo(0, 0);
        }, theme);
        await page.waitForTimeout(180);
        const g0 = await page.evaluate(() => {
          const shafts = [...document.querySelectorAll('.well-shaft')]
            .filter(s => getComputedStyle(s).display !== 'none' && s.getClientRects().length > 0);
          let s = shafts[0];
          if (!s) {
            const eg = document.querySelector('#emptyGuide');
            if (eg && eg.hasAttribute('hidden')) { eg.removeAttribute('hidden'); s = eg.querySelector('.well-shaft'); }
          }
          if (!s) return null;
          const b = s.getBoundingClientRect();
          /* okD 的对照组：光柱**所处的那张卡片** = 最近的 .chat-welcome。
             取它的 backgroundColor 链（自底向上直到不透明），交给 Node 侧合成。
             只取 backgroundColor、不取 background-image：T2/T3 材质栈是受光边/网格/余晖，
             按"第一层色标"取会引入与 OPT-15 同类的主观口径；底色链是唯一可复现的对照。 */
          const card = s.closest('.chat-welcome') || document.querySelector('.chat-welcome');
          const chain = [];
          if (card) {
            for (let n = card; n && n.nodeType === 1 && chain.length < 12; n = n.parentElement) {
              const bg = getComputedStyle(n).backgroundColor;
              chain.push(bg);
              const m = bg.match(/[\d.]+/g);
              if (m && m[3] !== undefined && +m[3] >= 1) break;
              if (!m || m[3] === undefined) break;   /* rgb() 三参 = 不透明 */
            }
          }
          return { x: b.x, y: b.y, w: b.width, h: b.height, motes: s.querySelectorAll('.mote').length, chain };
        });
        if (!g0) return { missing: true };
        const pad = 40;
        /* R89-fix（多点采样）：旧实现只在 waitForTimeout(180) 后抓**一张**图，
           冷启动 / 机器负载抖动时会漏检——实测 4 跑 1 败（OPT-14 光柱像素落差 MISS）。
           改为 N 点独立采样、**逐测点取中位数**后再交给判据。
           这是统计稳健化，不是「失败重试到过」：判据阈值一个字没动，
           也不存在「某一次过了就算过」——每次采样都参与中位数计算。
           极差（spread）只进 detail 供复核，不参与任何放宽。 */
        const SAMPLE_N = 3;
        const shots = [];
        for (let si = 0; si < SAMPLE_N; si++) {
          if (si) await page.waitForTimeout(90);
          shots.push(await grab(page, { x: g0.x - pad, y: g0.y - pad, w: g0.w + pad * 2, h: g0.h + pad * 2 }));
        }
        const medOf = (vals) => {
          const xs = vals.filter(v => v !== null && typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
          if (!xs.length) return null;
          return xs[(xs.length - 1) >> 1];
        };
        const spreadOf = (vals) => {
          const xs = vals.filter(v => v !== null && typeof v === 'number' && !Number.isNaN(v));
          return xs.length ? Math.max(...xs) - Math.min(...xs) : null;
        };
        const cx = g0.x + g0.w / 2;
        const yTop = g0.y + 12, yBot = g0.y + g0.h - 12;
        /* 带内落差：① = 亮芯（光柱中线）②③ = 带内左右边缘（仍在中线 ±24px，**没出带**）。
           三个原始值都要原样报出去（主理人复核口径用）。 */
        const lumSeries = (xAbs) => shots.map((sh) =>
          lineLumMedian(sh.img, xAbs - sh.ox, yTop - sh.oy, xAbs - sh.ox, yBot - sh.oy, 3));
        const inSeries = lumSeries(cx);
        const outLSeries = lumSeries(cx - 24);
        const outRSeries = lumSeries(cx + 24);
        const cardSeries = lumSeries(g0.x - 30);
        const L_in = medOf(inSeries);
        const L_outL = medOf(outLSeries);
        const L_outR = medOf(outRSeries);
        const L_out = (L_outL !== null && L_outR !== null) ? (L_outL + L_outR) / 2 : (L_outL !== null ? L_outL : L_outR);
        /* 像素参考（不参与断言）：同一 y 上、光柱带外 30px 的卡片面亮度中位数。
           与 Node 侧按 backgroundColor 链合成的 L(卡片) 互为佐证。 */
        const L_cardPx = medOf(cardSeries);
        /* 微粒：在带内扫局部亮点（N 次取中位数） */
        const moteSeries = shots.map((sh) =>
          countMotes(sh.img, g0.x + 6 - sh.ox, yTop - sh.oy, g0.x + g0.w - 6 - sh.ox, yBot - sh.oy, 0.04));
        const motes = medOf(moteSeries);
        /* 光柱边界：水平扫描线在左右边缘处必须出现单像素梯度跳变（N 次取中位数） */
        const jumpSeries = (edgeX) => shots.map((sh) => {
          const midY = g0.y + g0.h / 2 - sh.oy;
          let best = 0;
          for (let x = Math.round(edgeX - sh.ox) - 3; x <= Math.round(edgeX - sh.ox) + 3; x++) {
            const a = pxLum(sh.img, x, midY), b = pxLum(sh.img, x + 1, midY);
            if (a !== null && b !== null) best = Math.max(best, Math.abs(b - a));
          }
          return best;
        });
        const jumpLSeries = jumpSeries(g0.x);
        const jumpRSeries = jumpSeries(g0.x + g0.w);
        const jumpL = medOf(jumpLSeries);
        const jumpR = medOf(jumpRSeries);
        const sampleSpread = {
          n: SAMPLE_N,
          L_in: spreadOf(inSeries), L_outL: spreadOf(outLSeries), L_outR: spreadOf(outRSeries),
          motes: spreadOf(moteSeries), jumpL: spreadOf(jumpLSeries), jumpR: spreadOf(jumpRSeries),
        };
        return { L_in, L_out, L_outL, L_outR, L_cardPx, motes: motes, jumpL, jumpR, domMotes: g0.motes, rect: g0, chain: g0.chain || [], sampleSpread };
      };

      const light = await measure('light');
      const dark = await measure('dark');
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await page.waitForTimeout(120);
      if (light.missing || dark.missing) throw new Error('.well-shaft 不可见（含隐藏 #emptyGuide 兜底后仍无）');

      const dL = m => (m.L_in === null || m.L_out === null) ? null : Math.abs(m.L_in - m.L_out);
      const dLight = dL(light), dDark = dL(dark);
      /* A 段 = 带内水平落差（亮芯 vs 带内边缘）。名称已更正，量纲不变。 */
      const okA = dLight !== null && dLight >= 0.02 && dDark !== null && dDark >= 0.02;
      const okB = light.motes >= 8 && dark.motes >= 8;
      const okC = light.jumpL >= 0.008 && light.jumpR >= 0.008;

      /* D 段 = 带内中心 vs 它所在的卡片（backgroundColor 链合成值），方向必须相反。
         这一步补的正是 A 段覆盖不到的那块：A 段在带内自比，即使暗衬被白芯洗白到
         与卡片同亮度，靠"亮芯 vs 两侧极窄暗边"也还能维持 ≥0.02 —— 但那样光柱
         整体与卡片等亮，视觉上等于不存在。
         方向约定：明色 L(卡片) − L(带内中心) ≥ +0.02（光柱更暗，暗衬承载"井"）；
                   暗色 L(带内中心) − L(卡片) ≥ +0.02（光柱更亮，微光进井）。 */
      const dirDelta = (m, Lcard, wantDarker) => {
        if (Lcard === null || m.L_in === null) return null;
        return wantDarker ? (Lcard - m.L_in) : (m.L_in - Lcard);
      };
      const LcardLight = chainLum(light.chain), LcardDark = chainLum(dark.chain);
      const dirLight = dirDelta(light, LcardLight, true);
      const dirDark = dirDelta(dark, LcardDark, false);
      const okD = dirLight !== null && dirLight >= 0.02 && dirDark !== null && dirDark >= 0.02;

      const ok0 = okA && okB && okC && okD;

      /* 余量探针（**不参与断言**，只报告）：--shaft-bed 已由 .50 压到 .20（明色）。
         .20 是"氛围级压暗"的上限裁决，压得再狠就会读成脏板、且把 okD 的余量吃掉。
         这里注入比现值更狠的 .30 重测一次：仍若 ≥0.02，说明现值离翻红还有一档缓冲；
         若已翻红，说明 .20 就是悬崖边 —— 两个结论都比"看起来还行"有用。
         （旧版此处注入的就是 .20，与 tokens.css 同值，等于空转且文案声称"仍是 .50"，已修） */
      let dry = null;
      try {
        await injectCss(page, ':root{--shaft-bed:rgba(11,58,42,.30)!important;}');
        const dryLight = await measure('light');
        await clearInject(page);
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        const Lc = chainLum(dryLight.chain);
        dry = { L_in: dryLight.L_in, L_outL: dryLight.L_outL, L_outR: dryLight.L_outR, card: Lc, d: dirDelta(dryLight, Lc, true) };
      } catch (e) {
        try { await clearInject(page); } catch (e2) { /* 预演失败不影响断言 */ }
        dry = null;
      }

      /* 反例注入：微粒与柱体 alpha 归零 → 带内落差与亮点数必须一起塌掉 */
      await injectCss(page, ':root{--mote:rgba(255,255,255,0)!important;'
        + '--shaft-core:rgba(255,255,255,0)!important;--shaft-mid:rgba(255,255,255,0)!important;'
        + '--shaft-bed:rgba(255,255,255,0)!important;--shaft-edge:rgba(255,255,255,0)!important;}');
      const injLight = await measure('light');
      await clearInject(page);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      const dInj = dL(injLight);
      /* 注入后 D 段也必须一起塌掉（光柱与卡片同亮度 ⇒ 方向差归零） */
      const dirInj = dirDelta(injLight, chainLum(injLight.chain), true);
      const injOk = (dInj === null || dInj < 0.02) && injLight.motes < 8
        && (dirInj === null || Math.abs(dirInj) < 0.02);
      const f4 = v => (v === null || v === undefined ? 'null' : v.toFixed(4));
      const dirStr = (v) => (v === null ? 'null' : (v >= 0 ? '+' : '') + v.toFixed(4));
      return {
        ok: ok0 && injOk,
        injected: {
          ok: injOk,
          detail: `--mote/--shaft-* alpha 归零后：带内落差 ${f4(dInj)}（需 <0.02）、`
            + `带内中心 vs 卡片方向差 ${dirStr(dirInj)}（需 |Δ|<0.02）、`
            + `局部亮点 ${injLight.motes} 个（需 <8）`
        },
        detail: `【A 带内水平落差（亮芯 vs 带内边缘，±24px 仍在带内）】`
          + `明色：L_in=${f4(light.L_in)}、L_outL=${f4(light.L_outL)}、L_outR=${f4(light.L_outR)}`
          + `（带内边缘均值 L_out=${f4(light.L_out)}）→ |Δ|=${f4(dLight)}；`
          + `暗色：L_in=${f4(dark.L_in)}、L_outL=${f4(dark.L_outL)}、L_outR=${f4(dark.L_outR)}`
          + `（L_out=${f4(dark.L_out)}）→ |Δ|=${f4(dDark)}`
          + `（明暗均需 ≥0.02 ${okA ? '✓' : '✗ 光柱在像素上不可测'}）；`
          + `【B 微粒】明 ${light.motes} / 暗 ${dark.motes} 个（DOM 里共有 ${light.domMotes} 个 .mote，需各 ≥8 ${okB ? '✓' : '✗ 微粒看不见'}）；`
          + `【C 边界跳变】左 ${f4(light.jumpL)} / 右 ${f4(light.jumpR)}（均需 ≥0.008 ${okC ? '✓' : '✗ 没有边界，只是散射'}）；`
          + `【D 与卡片方向相反】明色 L(带内中心)=${f4(light.L_in)} vs L(.chat-welcome 底色合成)=${f4(LcardLight)}`
          + ` → 卡片−中心=${dirStr(dirLight)}（需 ≥+0.02 即光柱更暗 ${okD && dirLight !== null && dirLight >= 0.02 ? '✓' : '✗ 光柱与卡片同亮度，读不出"一道压暗的窄带"'}）；`
          + `暗色 ${f4(dark.L_in)} vs ${f4(LcardDark)} → 中心−卡片=${dirStr(dirDark)}（需 ≥+0.02 即光柱更亮）；`
          + `〔像素参考，不参与断言〕带外 30px 卡片面中位数：明 ${f4(light.L_cardPx)} / 暗 ${f4(dark.L_cardPx)}`
          + `（与底色合成值同量级则两条管道互证；差异大说明材质栈在起作用，以底色合成值为准）；`
          + `〔余量探针 · 不参与断言〕现值 .20 再压到 .30 后：L_in=${dry ? f4(dry.L_in) : 'n/a'}、`
          + `卡片−中心=${dry ? dirStr(dry.d) : 'n/a'}（${dry && dry.d !== null && dry.d >= 0.02 ? '.30 仍 ≥0.02 ⇒ 现值 .20 离翻红还有一档缓冲' : '.30 已跌破 0.02 ⇒ .20 是悬崖边，不得再压'}）；`
          + `注入归零后 带内落差 ${f4(dInj)} / 方向差 ${dirStr(dirInj)} / 亮点 ${injLight.motes} 个 → ${injOk ? '✓ 有区分力' : '✗ 恒真'}；`
          + `〔采样稳健性 · 不参与断言〕每态 ${light.sampleSpread.n} 点独立采样取中位数；`
          + `明色极差 L_in=${f4(light.sampleSpread.L_in)} / 亮点=${light.sampleSpread.motes} / 左跳变=${f4(light.sampleSpread.jumpL)}；`
          + `暗色极差 L_in=${f4(dark.sampleSpread.L_in)} / 亮点=${dark.sampleSpread.motes} / 左跳变=${f4(dark.sampleSpread.jumpL)}`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* --------------------------------------------------------------- OPT-15 */
  /* R80-R2 重写（主理人裁决：改成"同族的新台阶"）。
     【旧判据为什么恒红】它要求「明色台面与内层釉牌**面**亮度比值 ≥1.08」。
     那个 1.08 是**实心时代**的数：台面 α .90、釉牌实色，两块不透明的板之间才有
     "亮度台阶"可言。R2 台面 α .70 变成半透，其**合成亮度由背后的桌面决定**
     （本轮实测：台面 .7556 vs 气泡 .7584，比值 1.004），台账式的面亮度比较
     已经不对应任何视觉事实。

     【新口径：同族比较（玻璃 vs 玻璃）】保住旧判据真正要保护的东西 ——
     "层级之间分得出边界"。三层各自是同一族（半透玻璃），比较它们的**实际呈现亮度**：
       ① 主台阶：#mainStage 玻璃面 vs --bg-canvas 地面，|ΔL| ≥ 0.03
          （台面必须"浮"在地面之上，这是旧判据的 1.08 想守的东西）
       ② 内层台阶：.msg 玻璃面 vs #mainStage 玻璃面，|ΔL| ≥ 0.02
          （玻璃叠玻璃时两层要能区分，防止"玻璃在卡片底下等于没做"）
       ③ 正方向：两个 ΔL 都不得为 0（"完全贴平"必须红）
       ④ ⑤ 两侧探针：把 .msg 的 fill 注入成与 #mainStage 同值 → ② 必须翻红；
          把 #mainStage 的 fill 注入成透明 → ① 必须翻红
     ⚠ 取样口径：**像素实测最亮块**（AT 元素矩形内 6×6 网格取 L 最大的 8×8 块的中位色）。
       为什么不取文字样本框：玻璃面被文字覆盖时中位数会取到字色，比值测的就不是"面 vs 面"。
       为什么不取 backgroundColor 合成：那是"样式说应该长什么样"，看不见
       backdrop-filter 采到的桌面（本轮实测地面是暗林 rgb(22,27,25)/L=.0102，
       而 --bg-canvas 是 #FAF9F5/L=.96 —— 用样式合成会得出完全相反的结论）。
     ⚠ 地面样本取**视口左上角 (4,4) 12×12**：那是壁纸镜像层唯一不被任何玻璃覆盖的区域。 */
  await guard('OPT-15', () => runOpt('OPT-15', '玻璃层级之间可辨（主台面 vs 地面 ΔL≥0.03 · 气泡 vs 台面 ΔL≥0.02 · 像素口径）', {
    anchor() {
      const a = [assertAnchor('html', 'id="mainStage"', '台面'), assertAnchor('html', 'class="msg', '气泡')];
      a.push(assertAnchor('tokens', '--glass-l2-fill:', '台面玻璃填充'));
      a.push(assertAnchor('tokens', '--glass-msg-fill:', '气泡玻璃填充'));
      a.push(assertAnchor('tokens', '--bg-canvas:', '地面底'));
      return a.join(' | ');
    },
    async positive() {
      /* 取样前置：壁纸镜像层是**异步解码**的。不等它，地面样本会在
         "暗林 L=0.017" 与 "还没画出来的纯白画布 L=0.9467" 之间随机跳 ——
         实测两轮同一份代码分别得到 0.0172 / 0.9467，主台阶 0.526 / 0.076，
         后者会把"地面"取成一片白，判据的物理含义整个漂掉。
         所以先 decode() 再等一帧，把竞态钉死；这不是放宽阈值，是让尺子每次量同一块面。 */
      await page.evaluate(async () => {
        document.documentElement.setAttribute('data-theme', 'light');
        window.scrollTo(0, 0);
        const el = document.getElementById('desktopMirror');
        if (!el) return;
        const url = (getComputedStyle(el).backgroundImage.match(/url\(\s*["']?([^"')]+)["']?\s*\)/) || [])[1];
        if (!url || url === 'none') return;
        const im = new Image(); im.src = url;
        try { await im.decode(); } catch (e) { /* 解码失败由 WP-01 管，这里只管等待 */ }
      });
      await page.waitForTimeout(180);
      /* 取样点必须落在"这块玻璃自己的裸面"上：用 elementFromPoint 逐点回测，
         只保留命中的就是目标元素本身的坐标。
         为什么不用"元素矩形内最亮块"：矩形里还铺着子卡片（气泡 / composer / 标题牌），
         那些白卡比玻璃面更亮，实测会把"台面面"取成子卡片的 250/249/245，
         注入台面全透明后台面亮度纹丝不动（0.9295 → 0.9295）—— 那种取法测的是子卡片。
         也不用文字样本框：中位数会取到字色，比值测的就不是"面 vs 面"。 */
      const pts = await page.evaluate(() => {
        const pick = sel => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const own = [], near = [];
          for (let i = 0; i < 16; i++) {
            for (let j = 0; j < 16; j++) {
              const x = r.x + 8 + (r.width - 16) * i / 15;
              const y = r.y + 8 + (r.height - 16) * j / 15;
              const hit = document.elementFromPoint(x, y);
              if (!hit) continue;
              if (hit === el) own.push([+x.toFixed(1), +y.toFixed(1)]);
              else if (el.contains(hit) && !(hit.textContent || '').trim()) near.push([+x.toFixed(1), +y.toFixed(1)]);
            }
          }
          return { own, near };
        };
        return { stage: pick('#mainStage'), msg: pick('.msg') };
      });
      if (!pts.stage || !pts.msg) throw new Error('#mainStage 或 .msg 不存在');
      const choose = p => (p.own.length >= 3 ? p.own : p.near);
      const stagePts = choose(pts.stage), msgPts = choose(pts.msg);
      if (stagePts.length < 1 || msgPts.length < 1) throw new Error('找不到玻璃裸面取样点（子元素覆盖过密）');
      const medL = (g, list) => {
        const ls = list.map(([x, y]) => { const r = pixelRatio(g, x - 4, y - 4, 8, 8); return r ? lum(r.bg) : null; })
          .filter(v => v !== null).sort((a, b) => a - b);
        return ls.length ? +ls[ls.length >> 1].toFixed(4) : null;
      };
      const gAll = await (async () => {
        /* 稳定采样（诊断版）：镜像层是 fixed + z-index:0 的独立合成层，
           headless 截图偶尔会抓到它还没被合成的帧 —— 此刻视口左上露出的是
           body 底色 #FAF9F5（L=0.9467），而不是壁纸暗林（L=0.017）。
           实测同一份代码连跑两次分别命中两端，主台阶 0.526 / 0.076。
           所以这里不是"等两次采样一致"（那样连续两次白底也会被判稳定），
           而是**等到镜像层真的出现在像素里**（左上角亮度落到暗端），
           最多等 2.4s；等不到就把 attempts 与诊断一起带回，由判据响亮地红 ——
           绝不拿白底去算台阶（那等于把"镜像层没画出来"这个真缺陷洗成 PASS）。
           阈值一个没动。 */
        let last = null, attempts = 0, firstL = null;
        for (let i = 0; i < 12; i++) {
          attempts = i + 1;
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          last = await grab(page, { x: 0, y: 0, w: 1440, h: 900 });
          const tl = pixelRatio(last, 4, 4, 12, 12);
          const l = tl ? +lum(tl.bg).toFixed(4) : 1;
          if (firstL === null) firstL = l;
          if (l < 0.35) break;
          await page.waitForTimeout(200);
        }
        last.diag = { attempts, firstL, ok: true };
        return last;
      })();
      const groundTL = pixelRatio(gAll, 4, 4, 12, 12);
      const groundR = pixelRatio(gAll, 1428, 440, 10, 10);
      const ground = [groundTL, groundR].filter(Boolean).sort((a, b) => lum(b.bg) - lum(a.bg))[0];
      const groundL = ground ? +lum(ground.bg).toFixed(4) : null;
      const stageL = medL(gAll, stagePts);
      const msgL = medL(gAll, msgPts);
      if (groundL === null || stageL === null || msgL === null) throw new Error('取样失败');
      const dStage = +Math.abs(stageL - groundL).toFixed(4);
      const dMsgVsEdge = +Math.abs(msgL - stageL).toFixed(4);   /* 旧口径，仅作参照打印 */
      const okStage = dStage >= 0.03;
      const ok0 = okStage && dStage !== 0;
      /* ★ D13（契约 §11）：负控必须**移除被判量本身**，不是"随便改点什么"。
         改前只清 background-color/image/box-shadow，实测两只探针都翻不了红
         （气泡 .1974→.0672、台面 .3986→.089），原因有三层，必须都写下来：
           ① D5 之后 fill 在 background-image **末层**，`.liquid-surface` 的
              ::before（棱镜框）/ ::after（追光斑）仍在元素内部绘制 ⇒ 注入没打在 fill 上；
           ② 台面与"地面样本点(4,4)"之间还隔着 **母体底盘 `.shell::before`**
              （inset:6px）—— 只关台面，取样点塌到的是底盘而不是地面；
           ③ ★ 更根本的一层（本轮实测才看清）：②的旧口径拿"气泡"去比"台面**边缘**裸面"，
              而台面材质栈本身是 85%×75% 的径向渐变（边缘厚、中心薄）—— 实测台面边缘
              L=.4184、气泡身下的台面 L=.3512，中心比边缘**暗 .0672**。
              换句话说旧口径的 .1974 是"气泡 .2646 减去台面梯度 .0672"的结果：
              **台面自己的亮度梯度替气泡吃掉了一部分台阶**，方向还是让判据变松。
              气泡关得再干净也消不掉这块梯度 —— 旧口径把台面的量记在了气泡头上。
         ⇒ 新口径：②改成**同点反事实** —— 在同一批取样点上关掉气泡的全部绘制输出，
           量它身下的"床"，差值才是气泡自身的贡献。这不是换阈值，是换被测对象；
           台面边缘 vs 中心那块梯度改由 ①（台面 vs 地面）继续管。
         ⇒ ① 的负控仍按 D13：killPaint + 关底盘，取样点必须塌回地面（实测 .0226 < .03）。 */
      const killPaint = (sel) =>
        `${sel}{background:none!important;box-shadow:none!important;border-color:transparent!important;`
        + `backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;outline:none!important}`
        + `${sel}::before,${sel}::after{content:none!important;background:none!important;box-shadow:none!important;`
        + `border:0!important;mask:none!important;-webkit-mask:none!important;filter:none!important}`;
      /* 探针一（②的同点反事实）：关掉 .msg 全部绘制输出（含伪元素/backdrop-filter） */
      await injectCss(page, killPaint('.msg'));
      await page.waitForTimeout(140);
      const injA = await grab(page, { x: 0, y: 0, w: 1440, h: 900 });
      const bedMsgL = medL(injA, msgPts);
      await clearInject(page);
      await page.waitForTimeout(140);
      /* 探针二（① 的负控）：关掉台面全部绘制输出 + 底盘 → 台面点塌回地面 */
      await injectCss(page, killPaint('#mainStage') + '.shell::before{display:none!important}');
      await page.waitForTimeout(140);
      const injB = await grab(page, { x: 0, y: 0, w: 1440, h: 900 });
      const stageInjL = medL(injB, stagePts);
      await clearInject(page);
      await page.waitForTimeout(140);
      const dMsg = bedMsgL === null ? null : +Math.abs(msgL - bedMsgL).toFixed(4);
      const okMsg = dMsg !== null && dMsg >= 0.02;
      /* 注入是否真的生效：关掉气泡后像素必须改变（否则 CSS 被静默丢弃，反事实不成立） */
      const attribOk = bedMsgL !== null && dMsg !== null && dMsg >= 0.02;
      const dStageInj = stageInjL === null ? null : +Math.abs(stageInjL - groundL).toFixed(4);
      const injOk = attribOk && dStageInj !== null && dStageInj < 0.03;
      const canvasTok = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim());
      return {
        ok: ok0 && okMsg && injOk,
        injected: {
          ok: injOk,
          detail: `②同点反事实：关掉 .msg 全部绘制输出后 气泡 L=${msgL} → 同点床 L=${bedMsgL}（落差 ${dMsg}，需 ≥0.02；反事实差按构造为 0）→ ${okMsg ? '✓ 归零' : '✗ 未归零'}；`
            + `①负控：关掉台面全部绘制输出 + 底盘（.shell::before）后 台面-地面 ΔL ${dStage} → ${dStageInj}（需 <0.03）→ ${dStageInj !== null && dStageInj < 0.03 ? '✓ 归零' : '✗ 未归零'}`
        },
        detail: `【像素口径 · 裸面取样点 ${stagePts.length}/${msgPts.length} 个（elementFromPoint 回测命中自身），取 8×8 中位色的中位数】`
          + `地面 L=${groundL} rgb(${ground.bg.map(Math.round).join(',')})（视口左上裸露区）；`
          + `台面 L=${stageL} → 主台阶 ΔL=${dStage}（≥0.03 ${okStage ? '✓' : '✗'}）；`
          + `气泡 L=${msgL} vs 同点床 L=${bedMsgL === null ? 'n/a' : bedMsgL} → 内层台阶 ΔL=${dMsg === null ? 'n/a' : dMsg}（≥0.02 ${okMsg ? '✓' : '✗'}）；`
          + `〔参照 · 不判定〕旧口径（气泡 vs 台面边缘样本）ΔL=${dMsgVsEdge}，比同点床口径少 ${(dMsgVsEdge - (dMsg || 0)).toFixed(4)} —— 那是台面径向渐变（边缘厚、中心薄，中心比边缘暗 .0672）替气泡吃掉的台阶，见 D13 注释③；`
          + `〔参照 · 不判定〕--bg-canvas 令牌 ${canvasTok}（样式合成口径本轮已不适用：地面实际是壁纸镜像，不是这个色）`
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* --------------------------------------------------------------- OPT-16 */
  /* 窄档（768 / 375）的光带**尺寸预算**：轨道本体装得进成本区，靠的是"外环"——
     但 `box-shadow: 0 0 0 14px` 的 14px 环**不占任何 rect**（不改变布局、不影响
     D04/LAY 几何判据），它是纯视觉外扩。18px 的轨道 + 上下各 14px 环 = 46px，
     而 768 档 `.dock-zone--cost` 只有 44px 高（≤767 档 `.ribbon` 收到 14px，
     42px 才勉强装得下）。这一层溢出没有任何现有判据看得见：
       · verify.mjs 的 D02/D03 只管**整条 dock** 的高度（375:56px / 768:104px）；
       · OPT-13 只管刻度的发光强度。
     所以本条补的是"**光带本体 vs 它所在的那个区**"的预算，与 D02/D03 不重叠。
     ★ 两条断言（判定）+ 一条观察（不判定）：
       (a) 几何：pillOuter = ribbonRect.height（**border-box**，含上下各 1px 描边）
           + 2×环外扩 ≤ 成本区内容盒高度；且与区标签、金额各留 ≥8px 净空。
           ⚠ 用 border-box 而不是 content-box：环贴在描边**外侧**，那 2px 描边也是
             要占画面的。若按 content-box（18−2=16）算，768 档会从"溢出 2px"变成
             "刚好 44px"，结论反转 —— 这个口径差已单独报给主理人裁。
       (b) 像素兜底：外环右缘 → 金额左缘 的净空带里，"暗槽级"像素占比 <5%。
           为什么不直接扫金额矩形：矩形里本来就有 ¥ 字形（--color-text，明色
           L≈0.015）与它自己的深色描边，扫它必然 >5% ⇒ 判据恒假、没有区分力。
           真正要保护的是那条**净空带**：环一变宽就先渗进来，而"环压到金额左边"
           正是窄档最典型的破相。暗的判据随主题走：L < min(0.35, L(面)×0.5)，
           这样明色/暗色两种面都能用同一把尺子。净空带宽度 ≤0 时直接判 FAIL
           （不是"不适用"——那时它已经没有被保护的对象了）。
       (观察) 外环是否越出内容盒**左右**边：只报越界量，不判定。
           把它并入判定等于要求 375 档环 ≤1px（标签收起后光带就是第一个 flex item，
           紧贴内容盒左缘）—— 那是替设计做决定，不是取证。
  */
  await guard('OPT-16', () => runOpt('OPT-16', '窄档光带尺寸预算（768 / 375）：外环外沿装得进成本区，且与标签、金额各留 ≥8px 净空', {
    anchor() {
      const a = [assertAnchor('components', '.ribbon {', '轨道本体')];
      a.push(assertAnchor('tokens', '--tick-trough:', '外环色令牌（预算要能算）'));
      const bodies = ruleBodiesMatching(SRC.components, '.ribbon');
      if (!bodies.some(b => /box-shadow/.test(b) && /0\s+0\s+0\s+\d+px/.test(b))) {
        throw new Error('.ribbon 没有 "0 0 0 Npx" 形式的外环 box-shadow —— 本判据的预算对象不存在');
      }
      a.push('components ✓ .ribbon 有 0 0 0 Npx 外环');
      if (!bodies.some(b => /height:\s*\d+px/.test(b))) {
        throw new Error('.ribbon 高度没有显式 px 声明 —— 预算无法脱离运行时推算');
      }
      a.push('components ✓ .ribbon 显式高度');
      /* 与 D02/D03 的分工前提：那两条必须真的存在，否则本条就是在重复别人没做的事。 */
      const vpath = join(DESIGN, 'scripts', 'verify.mjs');
      const vtext = existsSync(vpath) ? readFileSync(vpath, 'utf8') : '';
      if (vtext.indexOf('D02 375 成本光带 56px') < 0 || vtext.indexOf('D03 768 成本光带上下两行 104px') < 0) {
        throw new Error('verify.mjs 里 D02/D03 的 dock 高度断言缺失 —— "本条只管光带本体"的分工前提不成立');
      }
      a.push('verify.mjs ✓ D02/D03 已管 dock 高度（本条只管光带本体，不重复）');
      return a.join(' | ');
    },
    async positive() {
      /* 外环外扩量 = 第一条**非 inset** 图层的 (spread + blur)。
         硬环 `0 0 0 14px` → 14；带模糊的溢光按 spread+blur 计（保守取大）。 */
      const ringOf = (shadow) => {
        for (const L of splitTop(shadow)) {
          if (/inset/.test(L)) continue;
          const nums = (L.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).map(s => parseFloat(s));
          if (nums.length < 4) continue;
          return { x: nums[0], y: nums[1], blur: nums[2], spread: nums[3], extent: Math.max(0, nums[3]) + Math.max(0, nums[2]) };
        }
        return null;
      };

      const geoAt = async (w, h) => {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        await page.waitForTimeout(260);
        await settle(page, 'opt16-' + w);
        return page.evaluate(() => {
          const rc = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
          const vis = (el) => {
            if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
            if (typeof el.checkVisibility === 'function') {
              try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) { /* 旧内核降级 */ }
            }
            const cs = getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
          };
          const rib = document.querySelector('#costRibbon') || document.querySelector('.ribbon');
          const zone = document.querySelector('.dock-zone--cost');
          if (!rib || !zone) return null;
          const zcs = getComputedStyle(zone);
          const pad = {
            t: parseFloat(zcs.paddingTop) || 0, r: parseFloat(zcs.paddingRight) || 0,
            b: parseFloat(zcs.paddingBottom) || 0, l: parseFloat(zcs.paddingLeft) || 0
          };
          const label = [...zone.querySelectorAll('.zone-label')].find(vis) || null;
          const amount = [...zone.querySelectorAll('.ribbon-readout')].find(vis) || null;
          const cost = zone.querySelector('#costValue');
          /* 成本区的底色链（像素兜底据此判断"什么算暗"） */
          const chain = [];
          for (let n = zone; n && n.nodeType === 1 && chain.length < 12; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            chain.push(bg);
            const m = bg.match(/[\d.]+/g);
            if (!m || m[3] === undefined || +m[3] >= 1) break;
          }
          return {
            ribbon: rc(rib), shadow: getComputedStyle(rib).boxShadow,
            zone: rc(zone), pad,
            label: label ? { ...rc(label), text: String(label.textContent).trim() } : null,
            amount: amount ? { ...rc(amount), text: String(amount.textContent).trim() } : null,
            cost: cost ? { ...rc(cost), text: String(cost.textContent).trim() } : null,
            chain
          };
        });
      };

      const measureAt = async (tag, w, h) => {
        const g = await geoAt(w, h);
        if (!g) throw new Error(`${tag}: #costRibbon 或 .dock-zone--cost 不存在`);
        const ring = ringOf(g.shadow);
        if (!ring) throw new Error(`${tag}: .ribbon 的 boxShadow 里没有可解析的非 inset 图层`);
        const pillH = g.ribbon.h + ring.extent * 2;
        const pillT = g.ribbon.y - ring.extent;
        const pillB = g.ribbon.bottom + ring.extent;
        const pillL = g.ribbon.x - ring.extent;
        const pillR = g.ribbon.right + ring.extent;
        const zoneInnerH = g.zone.h - g.pad.t - g.pad.b;
        const zoneL = g.zone.x + g.pad.l;
        const zoneR = g.zone.right - g.pad.r;
        const fitsV = pillH <= zoneInnerH + 0.5;
        /* 横向包含关系**只报告、不判定**：主理人给的预算式只管高度与净空。
           把一个"外环不许越出内容盒左右边"加进判定，等于要求 375 档环 ≤1px
           （标签收起后光带就是第一个 flex item，紧贴内容盒左缘）—— 那是替设计做决定，
           不是取证。所以这里只把越界量报出来，供主理人裁。 */
        const fitsH = pillL >= zoneL - 0.5 && pillR <= zoneR + 0.5;
        const bleedL = zoneL - pillL, bleedR = pillR - zoneR;
        /* 净空：标签在左、金额在右。375 档 .zone-label 被 display:none 收起 → 该项豁免。 */
        const clrLabel = g.label ? (g.ribbon.x - ring.extent) - g.label.right : null;
        const clrAmount = g.amount ? g.amount.x - (g.ribbon.right + ring.extent) : null;
        const okLabel = clrLabel === null ? true : clrLabel >= 8;
        const okAmount = clrAmount !== null && clrAmount >= 8;

        /* (b) 像素兜底：净空带暗像素占比 */
        const gutL = pillR + 1;
        const gutR = (g.amount ? g.amount.x : zoneR) - 1;
        const gutW = gutR - gutL;
        const gy0 = Math.max(pillT, g.zone.y), gy1 = Math.min(pillB, g.zone.bottom);
        const gutH = gy1 - gy0;
        const Lface = chainLum(g.chain);
        const thr = Lface === null ? null : Math.min(0.35, Lface * 0.5);
        let darkShare = null, gutPx = 0, gutNote = '';
        if (gutW >= 4 && gutH >= 6 && thr !== null) {
          const gg = await grab(page, { x: gutL, y: gy0, w: gutW, h: gutH });
          let dark = 0, tot = 0;
          for (let y = 0; y < gg.img.h; y++) {
            for (let x = 0; x < gg.img.w; x++) {
              const L = pxLum(gg.img, x, y);
              if (L === null) continue;
              tot++;
              if (L < thr) dark++;
            }
          }
          gutPx = tot;
          darkShare = tot ? dark / tot : null;
        } else {
          /* 净空带宽度 ≤0 本身就是"环已经把净空吃掉"的强证据：
             此时不是"这条断言不适用"，而是它**没有可保护的对象**了 ⇒ 判 FAIL。 */
          gutNote = `净空带已消失（${gutW.toFixed(1)}×${gutH.toFixed(1)}px：外环右缘 ${pillR.toFixed(1)} 已压到金额左缘 ${(g.amount ? g.amount.x : zoneR).toFixed(1)} 右边）`;
        }
        const okPix = darkShare !== null && darkShare < 0.05;
        return {
          tag, vp: `${w}×${h}`, ring: ring.extent, ribbonH: g.ribbon.h,
          pillH, zoneInnerH, pillL, pillR, zoneL, zoneR,
          label: g.label ? g.label.text : '(收起)',
          clrLabel, clrAmount, amountText: g.amount ? g.amount.text : '(无)',
          gutW, gutH, darkShare, thr, gutPx, Lface, gutNote,
          okLabel, okAmount, okPix, fitsH, bleedL, bleedR,
          ok: fitsV && okLabel && okAmount && okPix,
          failures: [
            !fitsV ? `高 ${pillH.toFixed(1)}px > 区内容高 ${zoneInnerH.toFixed(1)}px（溢出 ${(pillH - zoneInnerH).toFixed(1)}px）` : null,
            !okLabel ? `与区标签净空 ${clrLabel === null ? 'n/a' : clrLabel.toFixed(1) + 'px'} < 8px` : null,
            !okAmount ? `与金额净空 ${clrAmount === null ? 'n/a' : clrAmount.toFixed(1) + 'px'} < 8px` : null,
            !okPix ? (gutNote || `净空带暗像素 ${(darkShare * 100).toFixed(1)}% ≥5%`) : null
          ].filter(Boolean)
        };
      };

      const m768 = await measureAt('768', 768, 1024);
      const m375 = await measureAt('375', 375, 812);
      const ok0 = m768.ok && m375.ok;

      /* 可满足性预演（**不参与判定**，只报告）：
         交付一条"谁也修不绿"的红判据等于设计死胡同。所以顺手证一遍它**有解** ——
         375 档把外环收到 0、间距放到 24px（只动几何，不碰任何颜色/材质/令牌），
         看它能不能变绿。能绿 ⇒ 红是"当前参数装不下"，不是"判据不可满足"。 */
      let feas = null;
      try {
        await injectCss(page, '.dock-zone--cost{gap:24px!important;padding:0 8px!important;}'
          + '.ribbon{height:14px!important;box-shadow:0 0 0 0 var(--tick-trough),'
          + 'inset 0 1px 2px var(--trough-inset),inset 0 -1px 0 var(--tick-slot)!important;}');
        feas = await measureAt('feas-375', 375, 812);
        await clearInject(page);
      } catch (e) {
        try { await clearInject(page); } catch (e2) { /* 预演失败不影响判定 */ }
        feas = null;
      }

      /* 反例注入：把外环写回 24px（等价于"保留/放大 14px 环"的破相版本）→ 预算必须破。
         注：若当前版本本身已是红（正是本轮要修的状态），注入不能"从绿变红"，
         但"注入态被观测为 FAIL"这一条仍然成立 —— 差别写在 detail 里，不装作有区分力。 */
      await injectCss(page, '.ribbon{box-shadow:0 0 0 24px var(--tick-trough)!important;}');
      const inj768 = await measureAt('inject-768', 768, 1024);
      await clearInject(page);
      /* 复位到基准视口，后续截图仍是 1440 */
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await page.waitForTimeout(200);
      await settle(page, 'opt16-restore');
      const injOk = inj768.ok === false && inj768.pillH > m768.pillH + 1;
      const baseAlreadyRed = !ok0;

      const fmt = m => `${m.vp}：轨道 ${m.ribbonH}px（border-box，含上下各 1px 描边）+ 环 ${m.ring}px×2 = 外沿 ${m.pillH.toFixed(1)}px`
        + ` vs 成本区内容高 ${m.zoneInnerH.toFixed(1)}px（${m.pillH <= m.zoneInnerH + 0.5 ? '✓ 装得下' : '✗ 溢出 ' + (m.pillH - m.zoneInnerH).toFixed(1) + 'px'}）；`
        + `净空 标签 ${m.clrLabel === null ? 'n/a（' + m.label + '）' : m.clrLabel.toFixed(1) + 'px' + (m.okLabel ? ' ✓' : ' ✗')} / `
        + `金额 ${m.clrAmount === null ? 'n/a' : m.clrAmount.toFixed(1) + 'px' + (m.okAmount ? ' ✓' : ' ✗')}`
        + `（需各 ≥8px；金额="${m.amountText}"）；`
        + `净空带 ${m.gutW.toFixed(1)}×${m.gutH.toFixed(1)}px 暗像素 `
        + `${m.darkShare === null ? 'n/a — ' + m.gutNote : (m.darkShare * 100).toFixed(1) + '%'}`
        + `（阈值 L<${m.thr === null ? 'n/a' : m.thr.toFixed(3)}，面 L=${m.Lface === null ? 'n/a' : m.Lface.toFixed(4)}，需 <5% ${m.okPix ? '✓' : '✗'}）`
        + `；〔仅供裁决 · 不判定〕外环横向越出内容盒：左 ${m.bleedL.toFixed(1)}px / 右 ${m.bleedR.toFixed(1)}px`;
      const fails = [...m768.failures.map(x => '768 ' + x), ...m375.failures.map(x => '375 ' + x)];
      return {
        ok: ok0 && injOk,
        injected: {
          ok: injOk,
          detail: `外环写回 24px 后（768 档）：外沿 ${inj768.pillH.toFixed(1)}px vs 内容高 ${inj768.zoneInnerH.toFixed(1)}px、`
            + `金额净空 ${inj768.clrAmount === null ? 'n/a' : inj768.clrAmount.toFixed(1) + 'px'} → ${inj768.ok ? '仍绿（无区分力）' : 'FAIL ✓'}`
            + `（基准态${baseAlreadyRed ? '本身已是红：注入前就溢出，所以本条的翻红证据来自 768/375 的实测溢出量' : '为绿，注入后翻红'}）`
        },
        detail: (ok0 ? '' : `✗ ${fails.join('；')} ｜ `) + fmt(m768) + ' ｜ ' + fmt(m375)
          + ` ｜〔可满足性预演 · 不参与判定〕375 注入"外环 0 + 间距 24px"后：`
          + (feas
            ? `外沿 ${feas.pillH.toFixed(1)}px ≤ ${feas.zoneInnerH.toFixed(1)}px、金额净空 ${feas.clrAmount === null ? 'n/a' : feas.clrAmount.toFixed(1) + 'px'}、`
              + `净空带暗像素 ${feas.darkShare === null ? 'n/a' : (feas.darkShare * 100).toFixed(1) + '%'} → `
              + `${feas.ok ? '✓ 本条有解（红的是当前参数装不下，不是判据不可满足）' : '✗ 仍红：' + feas.failures.join('；')}`
            : 'n/a（预演未完成）')
      };
    },
    async injection(p) {
      return p.injected || { ok: false, detail: '正样本未记录注入结果' };
    }
  }));

  /* --------------------------------------------------------------- OPT-17 */
  /* 台面光照方向自洽（**像素级**，明色，1440×900，入场动画结束后）。
     ─────────────────────────────────────────────────────────────────────────
     为什么必须有这条：台面 5 层材质栈里 --plate-cone / --plate-sheen 的 alpha 原来
     都是"猜"的（cone .08 ⇒ ΔL 仅 .008 = 看不见），而光源坐标 --light-x:22% /
     --light-y:-8%（左上、略出画面外）与 AO 圆心 0% 100%（**左下**）方向矛盾 ——
     光从左上打来，影子不可能落左下。OPT-10 只校验 box-shadow 的 X 偏移，
     扫不到 background-image 里的径向渐变 ⇒ 这是 126 条判据里的盲区，本轮补上。
     ─────────────────────────────────────────────────────────────────────────
     取样口径（全部是"同一块台面内部"的自比，不跨底色）：
       .stage 的 getBoundingClientRect() 内缩 16px，四角各取一个 20×20 的块，
       取块内**全部像素**的 WCAG 相对亮度**中位数**（不取平均：块里可能压着字形、
       按钮边缘、1px 网格线，平均数会被少数派像素拖走；中位数天然免疫）。
       16px 内缩同时满足两件事：① 落在圆角 30px/12px 之内侧（不采到台面外）；
       ② 底部块落在 composer 与台面下沿之间的空带上（实测 composer 底 ≈ y+770，
          inset 20px 起就会采到 composer 的高光，故取 16px）。
       四角命名：LT 左上 / RT 右上 / LB 左下 / RB 右下。
     三条断言：
       ① 方向正确  L(LT) 四者最大、L(RB) 四者最小（.002 噪声容差）
       ② 落差可测  L(LT) − L(RB) ≥ .030，**且顶边左右不对称 ≥ .010**（LT 必须比 RT 亮）
                   为什么必须拆成两半（实测裁决，不许只看总落差）：
                     AO 一家就能把 Δ 撑到 .117，cone 在左上角只有 .017 ⇒ 光看总落差，
                     "把光锥整层删掉"仍然能过（实测 Δ 只从 .129 掉到 .117，远高于 .030）。
                     换句话说：② 若只写总落差，它测的是"遮蔽在不在"，跟光锥无关。
                   ② 的第二半（顶边不对称）才是**只有光锥能产生**的量：
                     AO 在右下、sheen 是 180deg 垂直渐变（左右同高 ⇒ 对 LT/RT 等量）、
                     grid 是 24px 周期（两侧同相），三者都不可能让"顶边左边更亮"。
                     实测梯度（同一把尺子，逐档改 --plate-cone）：
                       cone .20 → asym .0144（现状）；.16 → .0083；.12 → .0060；.08 → .0060；0 → −.0023
                     ⇒ 取 .010：现状过（余量 44%），cone 归零必翻红，且 .16 以下会被叫停 ——
                       这正是"光锥必须看得见"该有的位置（原始缺陷 .08 的量级就在 .006）。
       ③ 对角单调  L(RT) 与 L(LB) 都**严格**落在 (L(RB), L(LT)) 开区间内 ——
                   这是"单一径向光锥 + 对角遮蔽"的必然结果；两者跑到区间外，
                   说明台面上不止一个光源（或 AO 不在光锥对角）。
     双反例注入（各自单独跑、各自还原、都要求翻红）：
       · AO 圆心改回 0% 100%（左下）→ ① 必须 FAIL（右下不再是最暗）
       · 光源整体镜像到右侧（--light-x 与 --lg-l2-bloom-x 取 100−自身）
         → ② 的第二半必须 FAIL：顶边不对称要**翻号**且幅度 ≥ ASYM_MIN。
         （R78b 升级：改前是"抽掉 --lg-l2-far 要求塌到 < .010"，前提是 far 是顶边
           不对称的**唯一**来源；R78 材质重做后该前提不成立 —— 台面背后底色变暗，
           bloom 份额反超 far，实测 far .0159 / bloom .0212 / key .0023，
           任何一个单独归零都还在 .010 之上 ⇒ 旧注入必然假红。逐层归因数据与
           为什么"翻号"比"塌掉一个来源"更强，见注入二处的注释。
           R78c 裁决一：far 归零**重新入断言**，但口径换成**相对降幅 ≥15%**
           （实测 44.2%）—— 不再要求绝对值塌到 .010 以下，那正是假红的来源。）
     另附一条**不参与断言**的取证：cone 归零前后同一采样点的差（"光锥自身份额"，实测 .0167），
     它是 ② 阈值 .010 的标定依据，也是"这条判据到底在测什么"的自证。
     injOk=false 时本条自判 FAIL（沿用本文件既有约定）。
  */
  await guard('OPT-17', async () => {
    const INSET = 16;            /* 台面 rect 内缩 */
    const BLOCK = 20;            /* 采样块边长 */
    const NOISE = 0.002;         /* ① 的噪声容差 */
    const DROP_MIN = 0.030;      /* ② 总落差下限（**主理人给定，不得下调**） */
    /* ★ D16（契约 §11）：顶边不对称下限从 .010 提到 **.150**。
       旧 .010 是"只要还能测出来"的量级；现测 .2217，设 .15 = 留 1.48× 余量，
       要求的是"光锥真的把左顶边显著提亮"，不是"比噪声大一点"。**收紧**。 */
    const ASYM_MIN = 0.150;
    /* ② 第三半（R78c 补回，D16 改口径）：--lg-l2-far 归零后，顶边不对称的
       **绝对贡献**必须 ≥ FAR_ABS_MIN。
       为什么从"相对降幅 ≥15%"改成绝对值（这是本条的第二次修正，两次的教训要一起写）：
         · 标定轮（R78c）：基准 asym .0360 → far 归零 .0201 ⇒ 绝对贡献 .0159、相对 44.2%。
           15% 就是拿 44.2% ÷ 3 取的整数档，当时隐含的前提是"分母 .036 不会变"。
         · R81 之后：基准 asym .2217 → far 归零 .2013（实测，见 qa/r81-r2/optics-*.log）
           ⇒ 绝对贡献 **.0204**（比标定轮还大 28%），但分母涨了 6.2 倍，
           相对占比只剩 **9.2%** ⇒ 旧判据判红。
           这就是"度量口径错了，不是阈值错了"：**做得更好反而被判更差**。
         · 绝对贡献才对应"far 这一层到底抬了多少亮度"，与分母无关，不会被
           "别的层变强"稀释。相对占比保留为观察值打印，不参与判定。
       阈值推导（不用"刚好能过"的数）：
         旧判据实际要求的绝对贡献 = 15% × 标定基准 asym .0360 = **.0054**；
         新阈值取它的 **3 倍 = .0162**（与标定轮实测 .0159 几乎重合 ⇒ 等价于
         "回到 R78c 那个已经被证明可测的量级再留 3 倍安全边"）；
         现测 .0204 ⇒ 余量 .0042（26%），不是贴线。
       负控纪律同 D13：far 归零后若绝对贡献 < .0162（例如 far 本来就是 transparent），
       本条立刻红 —— 判据必须能被"far 真的没参与"这件事证伪。 */
    const FAR_ABS_MIN = 0.0162;

    /* 明色、滚到顶、等入场动画结束，再整屏截图（坐标与页面坐标 1:1） */
    const measure = async () => {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(200);
      const rect = await page.evaluate(() => {
        const st = document.querySelector('#mainStage') || document.querySelector('.stage');
        if (!st) return null;
        const b = st.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
      if (!rect) return null;
      const g = await grab(page, { x: 0, y: 0, w: 1e6, h: 1e6 });   /* grab 内已按 viewport 裁剪 */
      const at = (x, y) => blockLumMedian(g.img, x - g.ox, y - g.oy, BLOCK, BLOCK);
      return {
        rect,
        L: {
          LT: at(rect.x + INSET, rect.y + INSET),
          RT: at(rect.x + rect.w - INSET - BLOCK, rect.y + INSET),
          LB: at(rect.x + INSET, rect.y + rect.h - INSET - BLOCK),
          RB: at(rect.x + rect.w - INSET - BLOCK, rect.y + rect.h - INSET - BLOCK)
        }
      };
    };
    const numOk = L => !!L && [L.LT, L.RT, L.LB, L.RB].every(v => v !== null && Number.isFinite(v));
    /* ① 方向：LT 最大、RB 最小（带容差） */
    const dirOk = L => {
      if (!numOk(L)) return false;
      const ltMax = L.LT >= Math.max(L.RT, L.LB, L.RB) - NOISE;
      const rbMin = L.RB <= Math.min(L.LT, L.RT, L.LB) + NOISE;
      return ltMax && rbMin;
    };
    const f4 = v => (v === null || v === undefined ? 'null' : v.toFixed(4));

    await runOpt('OPT-17', '台面光照方向自洽（四角亮度场：左上最亮 / 右下最暗 / 对角单调 / 光锥自身可测）', {
      anchor() {
        /* ★ 锚点口径（本轮修正）：原来钉的是字面量 "radial-gradient(52% 44% at 100% 100%"，
           而主理人随后把 AO 半径 52%×44% → 26%×22%（G3：缩污染面积，圆心不动）。
           字面量锚点当场失效，红的却是"锚点缺失"——把真正要咬的方向问题藏了起来。
           所以改成**锁圆心、放开半径**：AO 层必须是 radial-gradient(...at 100% 100%, var(--plate-ao))。
           半径是造型，圆心是物理；物理不许动，造型随便调。 */
        const a = [assertAnchorRe('components', /radial-gradient\([^,]*at 100% 100%\s*,\s*var\(--plate-ao\)/, 'AO 圆心必须锚死在右下 = 光源对角（半径可调，圆心不可）')];
        a.push(assertAnchor('components', 'var(--plate-cone-mid) 34%', '光锥必须是三点衰减（0 / 34% / 76%）'));
        a.push(assertAnchor('tokens', '--plate-cone-mid:', '光锥中段令牌'));
        a.push(assertAnchor('html', 'class="stage', '台面宿主'));
        a.push(assertSelfAnchor('OPT-17', '防自删：判据本体必须留在源码里'));
        return a.join(' | ');
      },
      async positive() {
        await settle(page, 'opt-17');
        const base = await measure();
        if (!base) throw new Error('.stage 不存在（台面宿主缺失）');
        const L = base.L;
        if (!numOk(L)) throw new Error(`四角采样越界：${JSON.stringify(L)}（.stage 是否完整落在视口内？）`);

        const ok1 = dirOk(L);
        const drop = L.LT - L.RB;
        const ok2a = drop >= DROP_MIN;
        const asym = L.LT - L.RT;            /* 顶边不对称：只有光锥能产生的量 */
        const ok2b = asym >= ASYM_MIN;
        const ok3 = (L.RT > L.RB && L.RT < L.LT) && (L.LB > L.RB && L.LB < L.LT);

        /* ---- 注入一：AO 圆心 100% 100% → 0% 100%（右下 → 左下） --------------
           实现：读**计算后**的 background-image 整串，只替换圆心坐标再写回。
           为什么不手写整条材质栈：手写必然把 ①②③ 的顺序或色标抄错，那样注入的是
           "另一个设计"，不是"同一设计里的方向错误"，也就证明不了本判据对此敏感。 */
        let inj1 = null, inj3 = null, restored = null;
        const safeClear = async () => { try { await clearInject(page); } catch (e) { /* 清理失败不覆盖已有结论 */ } };
        try {
          const bgImage = await page.evaluate(() => {
            const st = document.querySelector('#mainStage') || document.querySelector('.stage');
            return st ? getComputedStyle(st).backgroundImage : '';
          });
          if (!/at 100% 100%/.test(bgImage)) throw new Error('计算后的 background-image 里找不到 "at 100% 100%"（AO 层形状变了，注入方式需同步）');
          await injectCss(page, `.stage{background-image:${bgImage.split('at 100% 100%').join('at 0% 100%')}!important;}`);
          inj1 = await measure();
          await safeClear();
        } catch (e) {
          await safeClear();
          inj1 = null;
        }
        /* ---- 注入二（R78b 升级）：把光源**整体镜像**到右侧 ----
           ⚠ 这不是放宽，是把"抽掉单个令牌必须塌掉"换成"翻面必须翻号"，根因见下。

           改前：注入 `--lg-l2-far: transparent`，要求顶边不对称塌到 < .010。
           前提是 R76 的那句话——"明色下**唯一**能造出顶边左右不对称的手段是 --lg-l2-far"。
           R78 的材质重做之后这个前提**已经不成立**了，实测逐层归因（1440×900 明色、
           与正样本同一把尺子，每次只归零一个令牌）：
              基准                        asym = .0360
              --lg-l2-far  归零           asym = .0201  ⇒ far 份额 .0159
              --lg-l2-bloom 归零          asym = .0148  ⇒ bloom 份额 .0212（最大）
              --lg-l2-key  归零           asym = .0337  ⇒ key 份额 .0023
              --lg-l2-tint 归零           asym = .0360  ⇒ 0（右下苔绿不在顶边）
           代价从哪来：R78 把 --lg-l1-fill 降到 .10、背景抬出三团液态色 ⇒ 台面背后的
           底色变暗（LT 从 R76 的 ≈.94 掉到 .899），不再有 8bit 封顶压缩。
           于是 bloom（--lg-l2-bloom 白 .46）重新获得提亮能力，成为顶边不对称的
           **最大单源**，far 退到第二。
           ⇒ 三个来源都不再"必要"：任何单个令牌归零，剩下的都还在 .010 之上
             （.0201 / .0148 都 > .010）。旧注入在这种情况下**必然假红**，
             继续钉它等于要求"把 far 调到 -.02 才叫合格"，那是反向优化。

           新负向控制：把 --light-x 与 --lg-l2-bloom-x 一起镜像（100 − 当前值），
           要求顶边不对称**翻号**且翻转幅度 ≥ ASYM_MIN：
              实测 mirror（R78c）：LT .8455 / RT .9091 ⇒ asym = −.0635；
              R81 现状 mirror：asym = −.2146（门槛已由 D16 提到 .150，余量 1.43×）
           为什么这比"抽掉一个令牌"更强，而不是更弱：
             · 它测的是**方向的因果**，不是"某个数字还够不够大"——后者会随材质配比
               漂移（本轮就是这么坏掉的），前者是物理定义：光源换边，亮边必须换边；
             · 无法靠噪声或单个弱层蒙混：翻号需要 key / far / cone / bloom 四层
               同时反号，任一层没跟着光源走，翻号幅度就残缺（实测只镜像 --light-x、
               不镜像 bloom ⇒ 翻号只剩 −.0276，正好证明 bloom 也参与了方向）；
             · 镜像后 ③ 对角单调、② 顶边不对称在**注入态**必然是错的，判据若失效
               就不可能翻号 ⇒ 这是一次真正的自证。
           --lg-l2-far 归零：保留为负向控制三，断言口径按 D16 从"相对降幅 ≥15%"
           改成"**绝对贡献 ≥ .0162**"。理由与推导见常量声明处 —— 一句话：
           分母变了 6.2 倍，相对量不再度量"实质参与"，绝对值才是。 */
        let mirror = null, obsFar = null;
        try {
          const cur = await page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement);
            return {
              lx: parseFloat(cs.getPropertyValue('--light-x')),
              bx: parseFloat(cs.getPropertyValue('--lg-l2-bloom-x'))
            };
          });
          if (!Number.isFinite(cur.lx) || !Number.isFinite(cur.bx)) {
            throw new Error('--light-x / --lg-l2-bloom-x 不可解析（镜像注入必须跟着令牌走，不能写死角度）');
          }
          await injectCss(page, ':root{--light-x:' + (100 - cur.lx).toFixed(3) + '%!important;'
            + '--lg-l2-bloom-x:' + (100 - cur.bx).toFixed(3) + '%!important;}');
          mirror = await measure();
          await safeClear();
        } catch (e) {
          await safeClear();
          mirror = null;
        }
        /* ---- 观察项（不参与断言）：远端衰减份额 ---- */
        try {
          await injectCss(page, ':root{--lg-l2-far:transparent!important;}');
          obsFar = await measure();
          await safeClear();
        } catch (e) {
          await safeClear();
          obsFar = null;
        }
        /* ---- 观察项（不参与断言）：cone 自身份额 ---- */
        try {
          await injectCss(page, ':root{--plate-cone:rgba(255,255,255,0)!important;'
            + '--plate-cone-mid:rgba(255,255,255,0)!important;}');
          inj3 = await measure();
          await safeClear();
        } catch (e) {
          await safeClear();
          inj3 = null;
        }
        /* 还原后复测（观察项，不参与断言）：证明两次注入是**非破坏性**的 */
        try { restored = await measure(); } catch (e) { restored = null; }

        const inj1Dir = (inj1 && numOk(inj1.L)) ? dirOk(inj1.L) : null;        /* 期望 false */
        const mirrorAsym = (mirror && numOk(mirror.L)) ? (mirror.L.LT - mirror.L.RT) : null;  /* 期望 ≤ −ASYM_MIN */
        const obsFarAsym = (obsFar && numOk(obsFar.L)) ? (obsFar.L.LT - obsFar.L.RT) : null;  /* 负向控制三 */
        /* far 归零后的**绝对贡献**（D16 判定量）与**相对降幅**（只作观察）。
           绝对量 = asym − asym(far=0)：与分母无关，不会被"别的层变强"稀释；
           相对量保留打印，用来对照"为什么旧口径会把做得更好判成更差"。 */
        const farAbs = (obsFarAsym !== null && Number.isFinite(asym))
          ? +(asym - obsFarAsym).toFixed(4)
          : null;
        const farDrop = (obsFarAsym !== null && Number.isFinite(asym) && asym > 0)
          ? (asym - obsFarAsym) / asym
          : null;
        const okFar = farAbs !== null && farAbs >= FAR_ABS_MIN;
        const coneGain = (inj3 && inj3.L && inj3.L.LT !== null) ? (L.LT - inj3.L.LT) : null;
        const ok2 = ok2a && ok2b;
        const ok0 = ok1 && ok2 && ok3 && okFar;

        /* 注入态必须被观测为 FAIL：
           ① AO 挪到左下后方向断言必须为假；
           ② 光源镜像到右侧后，顶边不对称必须**翻号**且翻转幅度 ≥ ASYM_MIN。 */
        const injOk = inj1Dir === false && mirrorAsym !== null && mirrorAsym <= -ASYM_MIN;

        const restoredDrift = (restored && numOk(restored.L)) ? Math.abs(restored.L.LT - L.LT) : null;
        const dropAfterRestore = (restored && numOk(restored.L)) ? (restored.L.LT - restored.L.RB) : null;
        /* 观察项（**不参与断言**）：其余材质栈里是否还有 AO 圆心在左下。
           本轮只修了 .stage 的 ④ 层，但 T2 材质栈（--mat-t2）里仍写着
           `radial-gradient(60% 70% at 0% 100%, var(--plate-ao) ...)` —— 与光源同一个物理错误。
           为什么不在这里判红：修 CSS 是主理人的裁决范围（本条只量 .stage）。
           但盲区必须被**看见**，所以每次跑都把它印出来，别让第二处错误继续躲着。 */
        const strayAo = /radial-gradient\([^,]*at 0% 100%\s*,\s*var\(--plate-ao\)/
          .test(stripComments(SRC.tokens + '\n' + SRC.components));

        return {
          ok: ok0 && injOk,
          injected: {
            ok: injOk,
            detail: `注入一（AO 圆心 → 0% 100% 左下）：四角 ${inj1 ? [f4(inj1.L.LT), f4(inj1.L.RT), f4(inj1.L.LB), f4(inj1.L.RB)].join(' / ') : 'n/a'}`
              + ` ⇒ 方向断言 ${inj1Dir === null ? 'n/a（注入失败）' : (inj1Dir ? '仍绿 ✗ 无区分力' : '翻红 ✓ 右下不再最暗')}；`
              + `注入二（光源镜像：--light-x 与 --lg-l2-bloom-x 各取 100−自身）：四角 ${mirror ? [f4(mirror.L.LT), f4(mirror.L.RT), f4(mirror.L.LB), f4(mirror.L.RB)].join(' / ') : 'n/a'}`
              + ` ⇒ 顶边不对称 ${f4(asym)} → ${mirrorAsym === null ? 'n/a' : f4(mirrorAsym)}`
              + `（需 ≤−${ASYM_MIN} 即翻号才翻红）⇒ ${mirrorAsym !== null && mirrorAsym <= -ASYM_MIN ? '翻红 ✓ 光源换边 ⇒ 亮边换边' : '仍绿 ✗ 方向不随光源走'}；`
              + `〔负向控制三〕--lg-l2-far 归零后顶边不对称 ${f4(asym)} → ${obsFarAsym === null ? 'n/a' : f4(obsFarAsym)}`
              + ` ⇒ 绝对贡献 ${farAbs === null ? 'n/a' : f4(farAbs)}（需 ≥${FAR_ABS_MIN} `
              + `${okFar ? '✓ far 仍参与顶边不对称' : '✗ far 已与顶边不对称脱钩'}）`
              + `［观察 · 不判定］相对降幅 ${farDrop === null ? 'n/a' : (farDrop * 100).toFixed(1) + '%'}（旧口径 15% 就是在这里误判的）；`
              + `〔观察项〕光锥份额 ${coneGain === null ? 'n/a' : f4(coneGain)}（单独不达门槛，故不作注入对象）`
          },
          detail: `【四角亮度场 · 明色 1440×900 · .stage rect ${base.rect.w.toFixed(0)}×${base.rect.h.toFixed(0)} 内缩 ${INSET}px 取 ${BLOCK}×${BLOCK} 块的中位数】`
            + `LT=${f4(L.LT)} / RT=${f4(L.RT)} / LB=${f4(L.LB)} / RB=${f4(L.RB)}`
            + ` → Δ(LT−RB)=${f4(drop)}（需 ≥${DROP_MIN} ${ok2a ? '✓' : '✗ 落差不可测'}）；`
            + `① 方向（LT 最大 + RB 最小）：${ok1 ? '✓' : '✗ 光与影不在对角'}`
            + `（LB−RB=${f4(L.LB - L.RB)}，容差 ${NOISE}）；`
            + `② 顶边不对称 LT−RT=${f4(asym)}（需 ≥${ASYM_MIN} ${ok2b ? '✓ 右侧远离光源 ⇒ 更暗' : '✗ 顶边左右一样亮，光源方向读不出来'}；`
            + `far 归零后 ${obsFarAsym === null ? 'n/a' : f4(obsFarAsym)} ⇒ 绝对贡献 ${farAbs === null ? 'n/a' : f4(farAbs)}`
            + `（需 ≥${FAR_ABS_MIN} ${okFar ? '✓' : '✗ 远端衰减已不参与顶边方向'}；相对降幅 ${farDrop === null ? 'n/a' : (farDrop * 100).toFixed(1) + '%'} 仅观察）；`
            + `参照：cone 归零后同点 L(LT)=${inj3 ? f4(inj3.L.LT) : 'n/a'} ⇒ 光锥自身份额 ${coneGain === null ? 'n/a' : f4(coneGain)}，不参与断言）；`
            + `③ 对角单调 RT/LB ∈ (RB, LT) 开区间：${ok3 ? '✓' : '✗ 台面上有第二个光源'}；`
            + `〔还原复测 · 不参与断言〕各次注入清除后 LT=${restored ? f4(restored.L.LT) : 'n/a'}`
            + `（漂移 ${restoredDrift === null ? 'n/a' : f4(restoredDrift)}）、Δ=${dropAfterRestore === null ? 'n/a' : f4(dropAfterRestore)}`
            + ` ⇒ ${restoredDrift !== null && restoredDrift <= NOISE ? '注入非破坏性 ✓' : '还原后读数偏移，后续判据可能被污染 ✗'}；`
            + `〔其余材质栈 · 不参与断言〕${strayAo
              ? '⚠ --mat-t2 里仍有 radial-gradient(at 0% 100%, var(--plate-ao))：圆心在**左下**，与光源方向矛盾（本条只量 .stage，此处仅登记，待主理人裁决）'
              : '已无其它 AO 圆心落在 0% 100% ✓'}`
        };
      },
      async injection(p) {
        return (p && p.injected) || { ok: false, detail: '正样本未记录注入结果' };
      }
    });
  });

  /* --------------------------------------------------------------- OPT-18 */
  /* 源级：任何材质栈的 AO 圆心都必须在光源对角（与 OPT-17 互补 ——
     OPT-17 量的是 .stage 的像素，本条管的是"同一错误有没有被复制到别的材质栈"）。 */
  await guard('OPT-18', () => runOpt('OPT-18', '材质栈 AO 圆心不得落在光源同侧（源级：任何 var(--plate-ao) 径向渐变的 X ≥ 50%）', {
    anchor() {
      const a = [assertAnchor('tokens', '--plate-ao:', '遮蔽层令牌')];
      a.push(assertAnchorRe('tokens', /at\s+100%\s+100%\s*,\s*var\(--plate-ao\)/, 'tokens 侧 AO 圆心必须可定位（--mat-t2）'));
      a.push(assertAnchorRe('components', /at\s+100%\s+100%\s*,\s*var\(--plate-ao\)/, 'components 侧 AO 圆心必须可定位（.stage ④ 层）'));
      a.push(assertSelfAnchor('OPT-18', '防自删：判据本体必须留在源码里'));
      return a.join(' | ');
    },
    async positive() {
      const srcs = { base: SRC.base, tokens: SRC.tokens, components: SRC.components, views: SRC.views };
      const v = aoVerdict(aoCenterRows(srcs));
      const fmt = r => `${r.file}「${r.center ? r.center.raw : '圆心不可解析'}」`;
      const list = v.rows.map(r => `${fmt(r)} ← ${r.snippet}`).join(' ｜ ');
      return {
        ok: v.ok,
        detail: `${v.rows.length} 处 var(--plate-ao) 径向渐变：${list}`
          + ` ｜ A 禁止项（圆心 X ≥ 50%）${v.aOk
            ? '✓ 全部在右半 / 右下'
            : '✗ 仍在光源同侧：' + v.bad.map(fmt).join('、')}`
          + ` ｜ B 正向项（≥2 处 100% 100%，且 tokens/components 各 ≥1）${v.bOk
            ? `✓ tokens ${v.fromTokens} 处 / components ${v.fromComponents} 处`
            : `✗ tokens ${v.fromTokens} 处 / components ${v.fromComponents} 处`}`
          + ` ｜ C 副本一致性（${v.rows.length} 份副本圆心必须全同，只比圆心不比半径）${v.cOk
            ? `✓ 全部 = ${v.centers[0]}`
            : `✗ 出现 ${v.centers.length} 种圆心：${v.centers.join(' / ')}`}`
      };
    },
    async injection() {
      /* 源级注入：**只改内存字符串**，不碰盘上文件。
         ① 把 tokens.css 的第一处 100% 100% 翻回 0% 100% → A 必须 FAIL
         ② components.css 同样处理 → A 必须 FAIL
         ③ 换回原串 → A 必须 PASS
         matcher 与正样本**完全相同**（aoVerdict/aoCenterRows），否则注入证明不了什么。 */
      const aOnFile = (f, text) => aoVerdict(aoCenterRows({ [f]: text })).aOk;
      const injT = aOnFile('tokens', flipAoToLeftBottom(SRC.tokens));
      const injC = aOnFile('components', flipAoToLeftBottom(SRC.components));
      const backT = aOnFile('tokens', SRC.tokens);
      const backC = aOnFile('components', SRC.components);
      const flipped = injT === false && injC === false;
      const restored = backT === true && backC === true;
      /* ③ 副本一致性注入：把 base.css（.slab 的内联副本）圆心改成 80% 100% ——
         **仍在右半**，所以 A 会放过它；只有 C 能咬住。这一步是整个 C 子断言存在的理由：
         多副本结构最典型的错不是"全错"，而是"改了一处、漏了另一处"。 */
      const ALL = { base: SRC.base, tokens: SRC.tokens, components: SRC.components, views: SRC.views };
      const mutatedBase = String(SRC.base).replace(
        /at\s+100%\s+100%(\s*,\s*var\(\s*--plate-ao\s*\))/, (m, tail) => 'at 80% 100%' + tail);
      const vMut = aoVerdict(aoCenterRows({ ...ALL, base: mutatedBase }));
      const cCatch = vMut.cOk === false && vMut.aOk === true;   /* C 必须红，且 A 必须仍绿 */
      const cBack = aoVerdict(aoCenterRows(ALL)).cOk === true;
      return {
        ok: flipped && restored && cCatch && cBack,
        detail: `注入 tokens.css（100% 100% → 0% 100%）→ A ${injT ? '仍绿 ✗' : 'FAIL ✓'}；`
          + `注入 components.css 同样处理 → A ${injC ? '仍绿 ✗' : 'FAIL ✓'}；`
          + `换回原串 → A ${restored ? 'PASS ✓' : '仍红 ✗'}；`
          + `注入 base.css 圆心改 80% 100%（仍在右半）→ A ${vMut.aOk ? '仍绿 ✓（符合预期，A 本就不该捉它）' : '也红了（A 的判据边界比预期宽）'} / `
          + `C ${cCatch ? 'FAIL ✓（一致性断言捉住了"改一处漏一处"）' : '仍绿 ✗ 一致性断言无效'}；`
          + `还原后 C ${cBack ? 'PASS ✓' : '仍红 ✗'}`
      };
    }
  }));

  /* ---------------------------------------------------------------- 截图 */
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.documentElement.setAttribute('data-theme', t); }, theme);
    await settle(page, 'shot-' + theme);
    const f = join(OUT, 'after', `optics-${theme}-1440.png`);
    await page.screenshot({ path: f });
    R.screenshots.push(f);
  }

  await ctx.close();
  ctx = null;
} catch (err) {
  record('HARNESS', false, {
    title: '光学判据执行器异常',
    anchor: null,
    positive: { ok: false, detail: String(err && err.stack ? err.stack : err) },
    injection: null
  });
} finally {
  if (ctx) { try { await ctx.close(); } catch (e) { /* 关闭失败不覆盖已有结论 */ } }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 临时 profile 清理失败不影响结论 */ }
}

/* ------------------------------------------------------- 纯源码判据（无浏览器） */
await guard('OPT-06', () => runOpt('OPT-06', '暗色投影零纯黑（受光边 + 描边替代压黑）', {
  anchor() {
    const a = [assertAnchorRe('tokens', /\[data-theme=["']dark["']\]\s*\{/, '暗色令牌块必须存在')];
    ['shadow-1', 'shadow-2', 'shadow-3'].forEach(k => a.push(assertAnchor('tokens', '--' + k + ':', '三条投影令牌缺一不可')));
    return a.join(' | ');
  },
  async positive() {
    const r = darkShadowAudit();
    const bad = r.rows.filter(x => x.blackCount > 0 || !x.hasInset || !Number.isFinite(x.mainAlpha));
    return {
      ok: r.ok,
      detail: bad.length
        ? bad.map(x => `${x.k}: 纯黑 ${x.blackCount} 处 / inset ${x.hasInset} / 主投影 alpha ${x.mainAlpha}`).join(' ; ')
        : `三级主投影 alpha = ${JSON.stringify(r.alphaLadder)} 严格递增；三条均含 inset 0 1px 0 受光边；纯黑 rgba(0,0,0 命中 0`
    };
  },
  async injection() {
    const inj = darkShadowAudit({ 'shadow-2': '0 8px 24px rgba(0,0,0,.48)' });
    const flipped = !inj.ok && inj.rows.some(r => r.k === 'shadow-2' && r.blackCount > 0 && !r.hasInset);
    return { ok: flipped, detail: flipped ? '把 --shadow-2 写回 rgba(0,0,0,.48) → 纯黑命中 1、inset 丢失 → 判据翻红 ✓' : '注入后仍绿色（恒真）' };
  }
}));

await guard('OPT-08', () => runOpt('OPT-08', '亮度预算常量上限 + faint 最坏叠层 WCAG 复算（纯源码；ao 上限由地色余量反推）', {
  anchor() {
    const a = [assertAnchor('tokens', '--plate-ao:', '遮蔽层令牌')];
    a.push(assertAnchor('tokens', '--plate-sheen:', '柔光层令牌'));
    a.push(assertAnchor('tokens', '--plate-cone:', '光锥芯部令牌（上限 + 提亮侧复算的输入）'));
    a.push(assertAnchor('tokens', '--plate-grid:', '微刻度令牌'));
    a.push(assertAnchor('tokens', '--color-faint:', '被复算的文字色'));
    a.push(assertAnchor('tokens', '--color-bg:', '反推 ao 上限所用的地色'));
    a.push(assertAnchor('tokens', '--color-code-bg:', '被复算的底板色'));
    a.push(assertAnchorRe('tokens', /\[data-theme=["']dark["']\]\s*\{/, '暗色上限必须可读'));
    return a.join(' | ');
  },
  async positive() {
    const r = plateBudget();
    const badC = r.ceilings.filter(x => !x.ok);
    const badR = r.ratios.filter(x => !x.ok);
    /* 显式触发条件串（主理人要求）：工程师看到红时能立刻知道自己越了哪条线 */
    const limitNote = r.gridLimit === null
      ? '触发条件：--plate-grid 临界值无法求解（令牌缺失）'
      : `触发条件：--plate-grid > ${r.gridLimit.toFixed(4)} 时明 faint/code-bg 复算跌破 4.5`
        + `（当前声明值 ${r.gridDeclared}；规格上限 .035 比该临界值更松，故 code-bg 侧以复算为准）`;
    const aoRow = r.ceilings.find(x => x.label === '明 --plate-ao');
    const aoNote = `--plate-ao 明色上限来源：${r.aoCeilL.detail}`
      + (r.aoLimit === null
        ? '；复算临界值无法求解（令牌缺失）'
        : `；非线性复算临界值：--plate-ao > ${r.aoLimit.toFixed(4)} 时明 faint/surface 跌到 4.5 以下`
          + `（对当前遮色二分求出；当前声明 ${aoRow ? aoRow.val : '?'}，真值以这一条为准）`);
    const cone1 = r.ratios.find(x => x.label.indexOf('明 faint/bg + cone') === 0);
    const cone2 = r.ratios.find(x => x.label.indexOf('暗 faint/bg + cone') === 0);
    const coneNote = `光锥提亮侧复算：明 faint/bg ${r.coneSide.lightBase} →（叠 cone 芯部）${cone1 ? cone1.ratio : 'n/a'}`
      + `（≥4.5 ${cone1 && cone1.ok ? '✓ 提亮抬高地色，对暗字单向安全' : '✗ 光锥把地色压向 faint，越界'}）；`
      + `暗 ${r.coneSide.darkBase} → ${cone2 ? cone2.ratio : 'n/a'}（≥4.5 ${cone2 && cone2.ok ? '✓' : '✗'}）`;
    return {
      ok: r.ok,
      detail: (badC.length || badR.length)
        ? [...badC.map(x => (x.val === '(缺失)'
              ? `${x.label} 令牌缺失`
              : `${x.label} alpha=${x.alpha} > 上限 ${x.max}`)),
           ...badR.map(x => (x.missing ? `${x.label} 令牌缺失/无法解析` : `${x.label} = ${x.ratio} < ${x.min}`))].join(' ; ')
          + ` ｜ ${limitNote} ｜ ${aoNote} ｜ ${coneNote}`
        : `8 条 alpha 上限全部合规（ao ≤${aoRow ? aoRow.max : '.083'}/.30、sheen ≤.20/.06、cone ≤.24/.06、grid ≤.035）；`
          + r.ratios.map(x => `${x.label}=${x.ratio}`).join('，')
          + ` ｜ ${limitNote} ｜ ${aoNote} ｜ ${coneNote}`
    };
  },
  async injection() {
    /* ★ D14：负控必须**越过生效上限**。旧载荷写死 `rgba(11,58,42,.12)` ——
       D14 把别名展开后，真实上限从旧代理的 .083 变成 min(.297, 复算 .1131)；
       .12 恰好落在"超代理但未超复算"的缝里，因此不再翻红。
       新载荷：**同一个遮色颜色、α 抬到 1**（不写死颜色，跟着令牌走）。
       α=1 同时越过代理与复算两条上限，且 faint 对比必然跌破 4.5 —— 两极都打穿。 */
    const aoRaw = TOK_L['plate-ao'] || '';
    const rgbm = aoRaw.match(/rgba?\(([^)]+)\)/);
    if (!rgbm) return { ok: false, detail: `负控无法构造：--plate-ao 解析不出颜色（${aoRaw}）` };
    const rgb = rgbm[1].split(',').slice(0, 3).map(s => s.trim()).join(',');
    const inj = plateBudget({ 'plate-ao': `rgba(${rgb},1)` });
    const hit = inj.ceilings.find(x => x.label === '明 --plate-ao');
    const rt = inj.ratios.find(x => x.label.indexOf('明 faint/surface') === 0);
    const flipped = !inj.ok && hit && !hit.ok && hit.alpha > hit.max && rt && !rt.ok;
    return {
      ok: !!flipped,
      detail: flipped
        ? `把 --plate-ao 改成 rgba(${rgb},1)（同一遮色、α 拉满）→ alpha ${hit.alpha} > 生效上限 ${hit.max}`
          + `，且 faint/surface 复算降至 ${rt.ratio} < 4.5 → 判据翻红 ✓`
        : `注入后仍绿色（恒真）：alpha=${hit ? hit.alpha : '?'} 上限=${hit ? hit.max : '?'} ratio=${rt ? rt.ratio : '?'}`
    };
  }
}));

await guard('OPT-10', () => runOpt('OPT-10', '光源方向与投影方向物理自洽（单光源模型的真正证据）', {
  anchor() {
    const a = [assertAnchor('tokens', '--light-x:', '光源原点 X')];
    a.push(assertAnchor('tokens', '--light-y:', '光源原点 Y'));
    a.push(assertAnchor('tokens', '--shadow-2:', '') );
    a.push(assertAnchor('tokens', '--shadow-3:', ''));
    return a.join(' | ');
  },
  async positive() {
    const r = lightConsistency();
    return {
      ok: r.ok,
      detail: r.facts.map(f => `${f.k}=${f.v}${f.ok ? '' : ' ✗'}`).join('；')
    };
  },
  async injection() {
    const inj = lightConsistency({ shadow2: '-1px 3px 8px rgba(11,58,42,.07), 2px 12px 28px rgba(11,58,42,.10)' });
    const neg = inj.facts.find(f => f.k === '明 shadow-2 各层 X ≥ 0');
    const flipped = !inj.ok && neg && !neg.ok;
    return {
      ok: !!flipped,
      detail: flipped ? '把 --shadow-2 首层 X 改成 -1px → 出现负 X 偏移 → 判据翻红 ✓' : '注入后仍绿色（恒真）'
    };
  }
}));

/* --------------------------------------------------------------- 汇总写出 */
/* OPT-16 是 R73 补的「窄档光带尺寸预算」（主理人 2026 裁决）：14px 外环不占 rect，
   D02/D03 与 OPT-13 都看不见那层溢出。
   OPT-17 是本轮补的「台面光照方向自洽」：OPT-10 只校验 box-shadow 的 X 偏移，
   扫不到 background-image 里的径向渐变 ⇒ AO 画错方向在 126 条判据里是盲区。
   OPT-18 是它的源级补位：同一个错误被复制进多个材质栈（--mat-t2 / .slab / .stage），
   OPT-17 只量 .stage 的像素，扫不到另外两处。 */
const ALL_OPT = Array.from({ length: 18 }, (_, i) => 'OPT-' + String(i + 1).padStart(2, '0'));
R.summary = {
  total: R.checks.length,
  passed: R.checks.filter(c => c.ok).length,
  failed: R.checks.filter(c => !c.ok).map(c => c.id),
  notImplemented: ALL_OPT.filter(id => !R.checks.some(c => c.id === id))
};
R.infiniteAnimations = infiniteAnimations;
R.settleTimeouts = settleTimeouts;
writeFileSync(join(OUT, 'optics-result.json'), JSON.stringify(R, null, 2), 'utf-8');
console.log('\n[OPTICS]', R.summary.passed, '/', R.summary.total, 'PASS | FAIL =', JSON.stringify(R.summary.failed));
console.log('未被本轮实现的判据：', JSON.stringify(R.summary.notImplemented));
process.exitCode = R.summary.failed.length ? 1 : 0;
