/* ============================================================================
   probe-t4.mjs · 像素级正文对比度标定（T4 的判据原型）
   为什么要第三条对比度判据：ST-04 / C03 / LG-03 / QA-A2-3 四条读的都是
   computed style 再自己合成 —— 它们量的是"按样式推算应该是什么色"。
   本轮暴露的真实缺陷（.stage .msg 的"1px 亮线"其实是 37px 白雾）在这四条里
   全是绿的：因为那层雾是 background-image，四条判据一行都没读它。
   所以必须有一条直接数屏幕像素的判据。

   口径（逐字写清，避免"看着差不多"）：
     取每个文字块**第一个非空文本节点**的 Range 包围盒（只框字形，不含内边距/描边/底色），
     在整屏截图上按像素取样：
       · 背景色 = 该框内全部像素按 luma 排序后的中位数像素（文字覆盖率 < 40%，中位数即底）
       · 文字色 = 底色偏亮 ⇒ 取 5% 分位像素（字芯）；底色偏暗 ⇒ 取 95% 分位像素
       · 比值 = WCAG 2.1 相对亮度比
   用法：node scripts/probe-t4.mjs [selector...]
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-t4-'));
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

/* 逐像素取样 → {bg, fg, ratio} */
function blockContrast(img, r) {
  const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(img.w - 1, Math.round(r.x + r.w));
  const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(img.h - 1, Math.round(r.y + r.h));
  const px = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = (y * img.w + x) * 4;
      px.push([img.data[d], img.data[d + 1], img.data[d + 2]]);
    }
  }
  if (px.length < 24) return null;
  const sorted = px.slice().sort((a, b) => luma(a) - luma(b));
  const bg = sorted[sorted.length >> 1];
  const bgL = luma(bg);
  const fg = bgL > 128 ? sorted[Math.max(0, Math.floor(sorted.length * 0.05))]
                       : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { n: px.length, bg, fg, bgL: +bgL.toFixed(0), fgL: +luma(fg).toFixed(0), ratio: +wcag(fg, bg).toFixed(2) };
}

const SELECTORS = [
  '.brand-name', '.nav-group', '.nav-seg[data-view="chat"]', '.eyebrow', '.panel-title',
  '.panel-sub', '.welcome-line', '.mini-note', '.msg-body', '.observer-title',
  '.observer-row .data', '.ribbon-readout .cost', '[role="tab"]'
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
    const out = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) { out.push({ sel, miss: 'no-element' }); continue; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) { out.push({ sel, miss: 'hidden' }); continue; }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.nodeValue || '').replace(/\s+/g, '').length >= 2) { node = n; break; }
      }
      if (!node) { out.push({ sel, miss: 'no-text' }); continue; }
      const rg = document.createRange();
      rg.selectNodeContents(node);
      const b = rg.getBoundingClientRect();
      if (b.width < 8 || b.height < 6) { out.push({ sel, miss: 'rect-too-small', b: [b.width, b.height] }); continue; }
      out.push({ sel, x: b.x, y: b.y, w: b.width, h: b.height, text: (node.nodeValue || '').trim().slice(0, 12) });
    }
    return out;
  }, SELECTORS);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(1200);
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    console.log(`\n########## ${theme} ##########`);
    let hit = 0, worst = { ratio: 99, sel: '-' };
    for (const r of rects) {
      if (r.miss) { console.log(`  ✗ ${r.sel.padEnd(30)} ${r.miss}`); continue; }
      const c = blockContrast(img, r);
      if (!c) { console.log(`  ✗ ${r.sel.padEnd(30)} 像素不足`); continue; }
      hit++;
      if (c.ratio < worst.ratio) worst = { ratio: c.ratio, sel: r.sel };
      console.log(`  ${c.ratio >= 4.5 ? '✓' : '✗'} ${r.sel.padEnd(30)} "${r.text}" 框${Math.round(r.w)}×${Math.round(r.h)} `
        + `底=${c.bg.join('/')}(Y${c.bgL}) 字=${c.fg.join('/')}(Y${c.fgL}) → ${c.ratio}:1`);
    }
    console.log(`  命中 ${hit}/${rects.length} · 最低 ${worst.ratio}:1 @ ${worst.sel}`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
