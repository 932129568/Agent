/* ============================================================================
   measure-t6.mjs · T6「材质是活的，文字是死的」
   两帧相隔 ≥3s 的像素差分，分别量两个区域：
     · 背景区（台面内部，去掉文字取样框后的其余像素）
         要求：非零差分像素占比 ≥ 0.5% —— 证明液态层在动
               （--lq-a / --lq-b 由 OpticsClock 写，驱动 .atmosphere 与台面内部液团）
     · 文字区（T4 的 13 个文字块取样框）
         要求：**字芯像素**几乎零差分 —— 文字不许跟着抖
         口径：只取"A 帧里已经接近字芯色（距该块极值 ≤3 级）"的像素来比。
               抗锯齿边缘像素本来就会随底色变化而变，拿它判"文字抖了"是假红；
               字芯像素是不透明油墨，底色怎么变都不该动 1 级。
   用法：node scripts/measure-t6.mjs
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-t6-'));
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
const pix = (img, x, y) => {
  const d = (y * img.w + x) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2]];
};
const pxLuma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const maxDiff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

const T4_BLOCKS = [
  { sel: 'h1.brand-name', pick: 'first', label: '品牌' },
  { sel: '.nav-seg[data-view="sessions"]', label: '导航文字' },
  { sel: '.panel-title', label: '台面标题' },
  { sel: '.panel-sub', label: '台面副标题' },
  { sel: '.eyebrow', label: '台面眉标' },
  { sel: '.welcome-line', label: '台面正文段' },
  { sel: '.mini-note', label: '台面注释' },
  { sel: '.msg', label: '消息正文' },
  { sel: '.observer-row .data', label: '右栏读数' },
  { sel: '.observer-row > span:first-child', label: '右栏标签' },
  { sel: '.ribbon-readout .cost', label: '成本读数' },
  { sel: '.ctx-chip', label: '上下文读数' },
  { sel: '.rail-ver', label: '版本读数' }
];

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const geo = await page.evaluate((blocks) => {
    const g = (id) => { const b = document.querySelector(id).getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const boxes = [];
    for (const b of blocks) {
      const el = document.querySelector(b.sel);
      if (!el) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let pick = null, pickW = -1;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.nodeValue || '').replace(/\s+/g, '').length < 2) continue;
        if (b.pick === 'first') { pick = n; break; }
        const rg0 = document.createRange(); rg0.selectNodeContents(n);
        const w0 = rg0.getBoundingClientRect().width;
        if (w0 > pickW) { pickW = w0; pick = n; }
      }
      if (!pick) continue;
      const rg = document.createRange(); rg.selectNodeContents(pick);
      const bb = rg.getBoundingClientRect();
      boxes.push({ label: b.label, x: bb.x, y: bb.y, w: bb.width, h: bb.height });
    }
    return { stage: g('#mainStage'), rail: g('#glass-top'), boxes };
  }, T4_BLOCKS);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(1600);
    const a = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const t0 = Date.now();
    await page.waitForTimeout(3500);
    const b = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const gap = Date.now() - t0;

    /* ---- 背景区：台面内部 + 左栏玻璃内部，扣掉文字框（外扩 2px 抗锯齿边缘） ---- */
    const mask = new Uint8Array(a.w * a.h);
    for (const bx of geo.boxes) {
      for (let y = Math.floor(bx.y) - 2; y <= Math.ceil(bx.y + bx.h) + 2; y++) {
        if (y < 0 || y >= a.h) continue;
        for (let x = Math.floor(bx.x) - 2; x <= Math.ceil(bx.x + bx.w) + 2; x++) {
          if (x < 0 || x >= a.w) continue;
          mask[y * a.w + x] = 1;
        }
      }
    }
    const regions = [
      { name: '台面内部', r: geo.stage, inset: 10 },
      { name: '左栏玻璃', r: geo.rail, inset: 6 }
    ];
    console.log(`\n########## ${theme} ########## 帧间隔 ${gap}ms`);
    for (const reg of regions) {
      const x0 = reg.r.x + reg.inset, x1 = reg.r.x + reg.r.w - reg.inset;
      const y0 = reg.r.y + reg.inset, y1 = reg.r.y + reg.r.h - reg.inset;
      let tot = 0, diff = 0, sum = 0, mx = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (mask[y * a.w + x]) continue;
          tot++;
          const d = maxDiff(pix(a, x, y), pix(b, x, y));
          if (d >= 3) diff++;
          sum += d; if (d > mx) mx = d;
        }
      }
      const pct = tot ? (diff / tot) * 100 : 0;
      console.log(`T6 背景区【${reg.name}】${tot} 像素：非零差分(阈值≥3) ${diff} = ${pct.toFixed(2)}%（需 ≥0.5%）`
        + ` ｜ 平均差分 ${(tot ? sum / tot : 0).toFixed(2)} ｜ 最大 ${mx}`);
    }

    /* ---- 文字区：只比"字芯像素"（A 帧里距该块极值 ≤3 级） ---- */
    let coreTot = 0, coreDiff = 0, worstBox = { label: '-', n: 0 };
    for (const bx of geo.boxes) {
      const x0 = Math.max(0, Math.round(bx.x)), x1 = Math.min(a.w - 1, Math.round(bx.x + bx.w));
      const y0 = Math.max(0, Math.round(bx.y)), y1 = Math.min(a.h - 1, Math.round(bx.y + bx.h));
      const lumas = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) lumas.push(pxLuma(pix(a, x, y)));
      if (!lumas.length) continue;
      lumas.sort((p, q) => p - q);
      const bgL = lumas[lumas.length >> 1];
      const dark = bgL > 128;                        /* 深字浅底 ⇒ 字芯是暗端 */
      const coreRef = dark ? lumas[0] : lumas[lumas.length - 1];
      let n = 0, dd = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const la = pxLuma(pix(a, x, y));
          if (Math.abs(la - coreRef) > 3) continue;   /* 只保留字芯像素 */
          n++;
          if (maxDiff(pix(a, x, y), pix(b, x, y)) >= 3) dd++;
        }
      }
      coreTot += n; coreDiff += dd;
      if (dd > worstBox.n) worstBox = { label: bx.label, n: dd };
    }
    const corePct = coreTot ? (coreDiff / coreTot) * 100 : 0;
    console.log(`T6 文字区【${geo.boxes.length} 块】字芯像素 ${coreTot}：差分 ${coreDiff} = ${corePct.toFixed(2)}%（需 ≈0，取 ≤1%）`
      + ` ｜ 最差块 ${worstBox.label}(${worstBox.n}px)`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
