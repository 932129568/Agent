/* CSS 结构自检（零依赖）
   用法：node deliverables/design/liquid-glass/scripts/css-lint.mjs [files...]
        · 无参 → 自动取「真实目标」（与 cwd 无关，见下）
        · 有参 → 只查传入文件（相对 cwd，供临时抽查）
   ----------------------------------------------------------------------------
   存在的唯一理由：CSS 有一类故障**不报错、也不留痕**。
     注释的收尾符之后跟裸文本（中文说明、分隔线、★ 标记）时，CSS 解析器会把紧随
     其后的「选择器 + 声明块」整段当成那个乱码选择器的声明块，**静默丢弃**。
     pageerror = 0、console = 0、document.styleSheets 也不抛异常，
     只是样式凭空消失 —— 排查时看到的是「属性没生效」，方向完全指错。
   R80-R2 真实踩过：`#desktopMirror` 因此整条规则丢失，
   表现为 `position: static / height: 0 / filter: none`（镜像层不存在）。
   R89 真实踩过（第二次）：`frontend/styles/legacy.css` 注释正文把 `wait-*` 与
   `/sw-light` 直接连写（那条注释因此自带收尾符），注释提前闭合，`body.fx-off …{animation:none}`
   整条规则被丢弃（关特效时动画不停）。本门存在的价值即此。

   三条检查（都是结构性的，不涉及任何设计判断）：
     ① 注释配对：起止符数量相等，且不存在孤立的收尾符
     ② 按配平规则剥离注释后，任何 `{` 之前的选择器文本里不得出现
        中日韩字符 / ★ / — 等不会出现在合法选择器里的字符
     ③ 花括号配平：起止数量相等（少一个收尾会把后面整片规则一起改义）

   R89 反「假绿」改造（本文件的核心约束）：
     · 无参时的目标**不再相对 cwd**：从脚本自身位置解析仓库根，取
       ① `frontend/manifest.json` 的 `styles`（生产面唯一事实源，14 个）
       ② 本设计目录的 `styles/{tokens,base,components,views}.css`（预览面）
       ③ 去重后逐个 lint。
     · **文件缺失 = FAIL**（旧版 SKIP 后仍打印 `N / N PASS`，是彻底的空转绿）。
     · 输出三计数：请求 / 实际 lint / 通过，只有
       `实际 == 请求 && 通过 == 实际 && 缺失 == 0` 才算 PASS，否则 exit 1。
   ★ 本文件自己的注释里刻意不写那两个字面连写 —— 它把我自己坑过一次。
   ---------------------------------------------------------------------------- */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));       // …/liquid-glass/scripts
const DESIGN = resolve(HERE, '..');                          // …/liquid-glass
const ROOT = resolve(HERE, '..', '..', '..', '..');          // 仓库根
const MANIFEST = resolve(ROOT, 'frontend', 'manifest.json');

/* 设计预览面（本目录下的四件套；与 verify.mjs 的 RUNTIME 同源） */
const PREVIEW_STYLES = ['styles/tokens.css', 'styles/base.css',
  'styles/components.css', 'styles/views.css'];

const ILLEGAL_IN_SELECTOR = /[\u4e00-\u9fff\u3000-\u303f\u2605\u2014\uff00-\uffef]/;

/* 按配平规则剥离注释；同时报「未闭合」与「孤立收尾符」。
   刻意用 startsWith 而不是正则：正则里写不出这两个符号的字面量。 */
const OPEN = '/' + '*';
const CLOSE = '*' + '/';

function stripComments(raw) {
  let out = '';
  let i = 0;
  let depth = 0;
  let strayClose = 0;
  while (i < raw.length) {
    if (depth === 0 && raw.startsWith(OPEN, i)) { depth = 1; i += 2; continue; }
    if (depth > 0) {
      if (raw.startsWith(CLOSE, i)) { depth = 0; i += 2; continue; }
      i += 1;
      continue;
    }
    if (raw.startsWith(CLOSE, i)) { strayClose += 1; i += 2; continue; }
    out += raw[i];
    i += 1;
  }
  return { out, unclosed: depth > 0 ? 1 : 0, strayClose };
}

/** 相对仓库根展示路径（便于回传与 diff） */
function display(p) {
  const rel = relative(ROOT, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : p;
}

/**
 * 解析本次要 lint 的文件清单。
 * @returns {{files: string[], source: string, manifestError: string}}
 */
function resolveTargets() {
  const argv = process.argv.slice(2);
  if (argv.length) {
    return { files: argv.map((p) => resolve(process.cwd(), p)), source: '命令行参数', manifestError: '' };
  }
  const files = [];
  let manifestError = '';
  if (existsSync(MANIFEST)) {
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
      const styles = Array.isArray(manifest.styles) ? manifest.styles : [];
      if (!styles.length) manifestError = 'manifest.styles 为空';
      for (const p of styles) files.push(resolve(ROOT, p));
    } catch (error) {
      manifestError = 'manifest 解析失败: ' + error.message;
    }
  } else {
    manifestError = '缺少 ' + display(MANIFEST);
  }
  for (const p of PREVIEW_STYLES) files.push(resolve(DESIGN, p));
  const uniq = [...new Set(files)];
  return {
    files: uniq,
    source: `frontend/manifest.json(${uniq.length - PREVIEW_STYLES.length}) + 设计预览(${PREVIEW_STYLES.length})，共 ${uniq.length} 个`,
    manifestError,
  };
}

/**
 * 光井皮肤段选择器前缀守卫（R90）。
 *
 * 背景：React Island 运行时把 tokens.css 文本副本 appendChild 到 <head> 末尾
 * （frontend/react/src/index.jsx:44-50），其 :root 特异性 (0,1,0) 晚于本文件所在
 * 的 <style> 生效。皮肤层若写 `:root{...}` 或裸 `.gwb-ava{...}`，必被压掉且
 * 静默失效 —— 视觉上看不出错，实际一个字都没生效。故以本规则强制前缀。
 *
 * 判据：从皮肤段标记之后，每个规则块头的每条选择器都必须包含
 *       `[data-skin="lightwell"]`。@ 规则（@media/@supports/@keyframes）跳过。
 *
 * 【取段起点必须回退到注释的 `/*`】标记 'LIGHTWELL R90' 出现在段落头注释内部，
 * 若直接 slice(idx) 则在注释中途切口 —— 该注释的 `/*` 落在切片之外，去注释正则
 * 匹配不到它，注释正文会被当成"第一个选择器头"，再被 split(',') 切成伪选择器。
 * R90 踩过两次：注释里写 (0,1,1) 这类带半角逗号的特异性记法，就凭空产生一个
 * 缺前缀的幽灵选择器（实测报错 `缺前缀："1"`）。故先回退到该注释起点再剥注释，
 * 使注释内容（逗号、括号、任何字面量）都不参与判据，也不必靠"注释禁用逗号"规避。
 *
 * @param {string} cssText 完整 CSS 文本
 * @returns {{ok:boolean, checkedSelectors:number, violations:string[]}}
 */
export function lintLightwellSkinSpecificity(cssText) {
  const MARKER = 'LIGHTWELL R90';
  const text = String(cssText || '');
  const idx = text.indexOf(MARKER);
  if (idx === -1) return { ok: true, checkedSelectors: 0, violations: [] };

  // 回退到包裹标记的那条注释的起点（找不到就退回文件开头，仍能把注释剥干净）。
  const cmtOpen = text.lastIndexOf('/*', idx);
  const start = cmtOpen === -1 ? 0 : cmtOpen;

  const section = text.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
  const violations = [];
  let checkedSelectors = 0;

  const re = /([^{}]+)\{/g;
  let m = re.exec(section);
  while (m !== null) {
    const header = m[1].trim();
    if (header && !header.startsWith('@')) {
      for (const sel of header.split(',').map(s => s.trim()).filter(Boolean)) {
        checkedSelectors += 1;
        if (!sel.includes('[data-skin="lightwell"]')) violations.push(sel.replace(/\s+/g, ' ').slice(0, 100));
      }
    }
    m = re.exec(section);
  }
  return { ok: violations.length === 0, checkedSelectors, violations };
}

/**
 * 主流程。导出是为了让门禁脚本能复用，而不必 import 一个「进来就 process.exit」
 * 的模块 —— 旧版本顶层直接执行 + process.exit，被 import 时会当场终止调用方进程。
 * @returns {boolean} 是否全绿
 */
export function runCssLint() {
const { files, source, manifestError } = resolveTargets();

let requested = 0;
let linted = 0;
let passed = 0;
let failedCount = 0;
const missing = [];
const failedFiles = [];

// 目标解析失败本身就是 FAIL：不允许「目标都不在 → 静默全绿」。
if (manifestError) {
  console.log(`FAIL 目标解析: ${manifestError}`);
  failedCount += 1;
}

for (const file of files) {
  requested += 1;
  if (!existsSync(file)) {
    missing.push(display(file));
    console.log(`FAIL ${display(file)} — 文件不存在（R89：缺失即判红，不再 SKIP 后报全绿）`);
    failedCount += 1;
    continue;
  }
  linted += 1;
  const raw = readFileSync(file, 'utf8');
  const { out, unclosed, strayClose } = stripComments(raw);

  const opens = (out.match(/\{/g) || []).length;
  const closes = (out.match(/\}/g) || []).length;

  /* 逐个「左花括号」回看它前面的选择器文本（上一个右花括号之后的全部内容） */
  const suspicious = [];
  const re = /([^{}]*)\{/g;
  let m = re.exec(out);
  while (m !== null) {
    const sel = m[1].trim();
    if (sel && ILLEGAL_IN_SELECTOR.test(sel)) {
      suspicious.push(sel.replace(/\s+/g, ' ').slice(0, 90));
    }
    m = re.exec(out);
  }

  const ok = unclosed === 0 && strayClose === 0 && opens === closes && suspicious.length === 0;
  if (ok) passed += 1;
  else {
    failedCount += 1;
    failedFiles.push(display(file));
  }

  console.log(`${ok ? 'PASS' : 'FAIL'} ${display(file)} — 注释 未闭合=${unclosed} 孤立收尾=${strayClose} ｜ 花括号 ${opens}/${closes} ｜ 可疑选择器=${suspicious.length}`);
  suspicious.slice(0, 8).forEach(s => console.log(`   ⚠ 裸文本被当成选择器："${s}"`));
}

const allOk = failedCount === 0 && linted === requested && requested > 0;
console.log(`\n[CSS-LINT] 目标来源: ${source}`);
console.log(`[CSS-LINT] 请求 ${requested} / 实际 lint ${linted} / 通过 ${passed}`
  + (missing.length ? ` / 缺失 ${missing.length}` : '')
  + (failedFiles.length ? ` / 有结构问题 ${failedFiles.length}` : ''));
if (missing.length) console.log(`[CSS-LINT] 缺失清单: ${missing.join(', ')}`);
console.log(allOk
  ? `[CSS-LINT] PASS（仅当 请求==实际且通过==实际 才算绿）`
  : `[CSS-LINT] FAIL`);

// 皮肤段附加守卫：只对本仓真实存在的 responsive.css 生效（设计预览侧无此文件）
const responsivePath = resolve(ROOT, 'frontend', 'styles', 'responsive.css');
if (existsSync(responsivePath)) {
  const guard = lintLightwellSkinSpecificity(readFileSync(responsivePath, 'utf8'));
  if (guard.checkedSelectors > 0) {
    console.log(`[CSS-LINT] 皮肤段选择器前缀: 检查 ${guard.checkedSelectors} 条 / 违规 ${guard.violations.length}`);
    guard.violations.slice(0, 8).forEach(sel => console.log(`   ✗ 缺 [data-skin="lightwell"] 前缀："${sel}"`));
  }
  if (!guard.ok) return false;
}

return allOk;
}

/**
 * 只在被直接执行时跑主流程并设置退出码。
 *
 * 为什么必须加这个 guard：R90 之前的版本顶层即执行、末尾 process.exit(...)。
 * 任何 `import { lintLightwellSkinSpecificity } from '.../css-lint.mjs'` 都会
 * 把整个 lint 跑一遍并当场退出调用方进程 —— 门禁脚本永远走不到自己的断言。
 */
function isDirectRun() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exit(runCssLint() ? 0 : 1);
}
