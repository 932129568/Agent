/* ============================================================================
   probe-t4b.mjs · 像素级对比度的**估计量标定**
   问题：小字号（11~12px）在 1x 下笔画 ~1px，抗锯齿会把"字芯"抬亮 30~45 级。
        如果直接用 5% 分位当字色，会把 --color-muted（规格 4.5+）判成 2.8:1 —— 假红。
   做法：对每个文字块同时打印
         · computed color（规格值）
         · computed 合成底（与 C03/LG-03 同一套 over() 链）
         · 规格比值
         · 实测像素的 p0 / p1 / p2 / p5 / p50（底） / p95 / p100
       于是"分位 vs 规格色"的偏差可以直接读出来，选哪个估计量是数据决定，不是拍脑袋。
   ========================================================================== */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-t4b-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), off = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[off];
    const row = raw.subarray(off + 1, off + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur; off += 1 + stride;
  }
  return { w, h, data: out };
}
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const rel = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const wcag = (a, b) => {
  const l1 = rel(a), l2 = rel(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const SELECTORS = [
  'h1.brand-name', '.nav-seg[data-view="sessions"]', '.nav-seg[data-view="chat"]',
  '.panel-title', '.panel-sub', '.eyebrow', '.welcome-line', '.mini-note', '.msg',
  '.msg-meta time', '.observer-row .data', '.observer-row > span:first-child',
  '.ribbon-readout .cost', '.zone-label', '.rail-ver', '.ctx-chip', '.observer-title',
  '.nav-group', '#resTabObserver'
];

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const rects = await page.evaluate((sels) => {
    const parse = s => { const m = String(s).match(/[\d.]+/g); if (!m) return null; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
    const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
    const out = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) { out.push({ sel, miss: 'no-element' }); continue; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) { out.push({ sel, miss: 'hidden' }); continue; }
      /* 取"包围盒最宽的可见文本节点"：第一个节点可能是 display:none 的 span 文字 */
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let best = null, bestW = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.nodeValue || '').replace(/\s+/g, '').length < 2) continue;
        const rg0 = document.createRange(); rg0.selectNodeContents(n);
        const bb = rg0.getBoundingClientRect();
        if (bb.width > bestW) { bestW = bb.width; best = n; }
      }
      if (!best) { out.push({ sel, miss: 'no-text' }); continue; }
      const rg = document.createRange(); rg.selectNodeContents(best);
      const b = rg.getBoundingClientRect();
      if (b.width < 8 || b.height < 6) { out.push({ sel, miss: `rect ${Math.round(b.width)}x${Math.round(b.height)}` }); continue; }
      /* 规格底：与 C03/LG-03 相同的自下而上合成 */
      const layers = []; let n2 = el;
      while (n2 && n2.nodeType === 1) {
        const c = parse(getComputedStyle(n2).backgroundColor);
        if (c && c[3] > 0) layers.push(c);
        if (c && c[3] === 1) break;
        n2 = n2.parentElement;
      }
      let bgc = [255, 255, 255, 1];
      for (const l of layers.reverse()) bgc = over(l, bgc);
      out.push({
        sel, x: b.x, y: b.y, w: b.width, h: b.height,
        text: (best.nodeValue || '').trim().slice(0, 12),
        fs: parseFloat(cs.fontSize), color: parse(getComputedStyle(el).color), bgc: bgc.slice(0, 3)
      });
    }
    return out;
  }, SELECTORS);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(1200);
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    console.log(`\n########## ${theme} ##########`);
    console.log('  sel                            px  spec色 → spec底  spec比 | p0   p1   p2   p5  p50  p95 p100 | p1底比');
    for (const r of rects) {
      if (r.miss) { console.log(`  ✗ ${r.sel.padEnd(30)} ${r.miss}`); continue; }
      const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(img.w - 1, Math.round(r.x + r.w));
      const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(img.h - 1, Math.round(r.y + r.h));
      const px = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = (y * img.w + x) * 4;
        px.push([img.data[d], img.data[d + 1], img.data[d + 2]]);
      }
      px.sort((a, b) => luma(a) - luma(b));
      const P = (q) => px[Math.min(px.length - 1, Math.floor(px.length * q))];
      const bg = P(0.5), bgL = luma(bg);
      const isDark = bgL > 128;
      /* 字色估计量 = **单像素极值**（p0 / p100）。
         理由：抗锯齿只会把字芯向底色方向抬，绝不会让它更极端 ⇒ p0 是"字芯覆盖度最高"
         的那个像素，方向上永远**低估对比度**（保守）。p1/p2/p5 在 11~12px 上已经
         被抬亮 20~40 级，会把合规的弱化色判成假红。 */
      const fgPix = isDark ? P(0) : P(1);
      const specRatio = wcag(r.color, r.bgc);
      const pixRatio = wcag(fgPix, bg);
      const bias = isDark ? luma(fgPix) - luma(r.color) : luma(r.color) - luma(fgPix);
      console.log(`  ${r.sel.padEnd(30)} ${String(Math.round(r.fs)).padStart(2)}px spec ${specRatio.toFixed(2)}:1`
        + ` | p0 ${luma(P(0)).toFixed(0).padStart(3)} p50 ${bgL.toFixed(0).padStart(3)} p100 ${luma(P(1)).toFixed(0).padStart(3)}`
        + ` → 像素 ${pixRatio.toFixed(2)}:1 (AA 偏差 ${bias >= 0 ? '+' : ''}${bias.toFixed(0)} 级)  "${r.text}"`);
    }
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
