/* R80 · 文字对比度逐节点取证（工程师自验，非 QA 结论）
   用法：node scripts/r80-probe-contrast.mjs
   目的：verify.mjs 的 QA-A2-3 / C03 / LG-03 只打印「前 3 个 / 最低值」，
        定位不到到底是哪一个节点、哪一对色在拖后腿。本脚本把 9 个抽样节点
        **全部**打出来，并附上是哪一个 token 在起作用，供归因。
   口径与 verify.mjs 完全一致（复制而非改写，避免两套尺子）：
     底 = 自身及祖先的 background-color 逐层 over() 合成，遇到 alpha=1 停；
     前景 = getComputedStyle().color；比值 = WCAG 2.1 相对亮度比。 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r80-probe-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

const probe = () => {
  const parse = s => { const m = String(s).match(/[\d.]+/g); if (!m) return null; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const sels = ['h1', '.panel-title', '.mini-note', '.msg', '.status-chip', '.meta-chip',
    '.ribbon-readout .cost', '.zone-label', '.observer-row', '.nav-seg', '.brand-name', '.nav-group'];
  const out = [];
  sels.forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    const fg = parse(getComputedStyle(el).color);
    const layers = []; let n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) layers.push({ c, at: n.id || String(n.className).slice(0, 24) || n.tagName });
      if (c && c[3] === 1) break;
      n = n.parentElement;
    }
    let bg = [255, 255, 255, 1];
    for (const l of layers.slice().reverse()) bg = over(l.c, bg);
    out.push({
      sel, ratio: +ratio(fg, bg).toFixed(3),
      color: `rgb(${fg[0]},${fg[1]},${fg[2]})`,
      bed: `rgb(${bg[0].toFixed(0)},${bg[1].toFixed(0)},${bg[2].toFixed(0)})`,
      stack: layers.map(l => `${l.at}:rgba(${l.c.join(',')})`).join(' < ')
    });
  });
  return out;
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
});
try {
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
      await page.waitForTimeout(600);
    }
    const rows = await page.evaluate(probe);
    const bad = rows.filter(r => r.ratio < 4.5);
    console.log(`\n===== ${theme} · ${rows.length} 节点，<4.5 的 ${bad.length} 个 =====`);
    for (const r of rows.slice().sort((a, b) => a.ratio - b.ratio)) {
      console.log(`${r.ratio < 4.5 ? 'FAIL' : ' ok '} ${r.ratio.toFixed(3).padStart(6)}  ${r.sel.padEnd(22)} 字 ${r.color.padEnd(18)} 底 ${r.bed.padEnd(18)} ${r.stack}`);
    }
  }
} finally {
  await ctx.close();
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
