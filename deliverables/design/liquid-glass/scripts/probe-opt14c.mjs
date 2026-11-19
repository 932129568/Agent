/* probe-opt14c.mjs · OPT-14 实际取样处（#emptyGuide 内的 .well-shaft）逐项关闭 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-o14c-'));
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
const at = (img, x, y) => {
  const d = (Math.round(y) * img.w + Math.round(x)) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2]];
};
const rel = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(600);

  const geo = await page.evaluate(() => {
    let s = document.querySelector('.well-shaft');
    let b = s ? s.getBoundingClientRect() : null;
    let host = '#chatWelcome';
    if (!b || b.width === 0) {
      const eg = document.querySelector('#emptyGuide');
      if (eg && eg.hasAttribute('hidden')) { eg.removeAttribute('hidden'); s = eg.querySelector('.well-shaft'); host = '#emptyGuide'; }
    }
    const bb = s.getBoundingClientRect();
    const card = s.closest('.chat-welcome');
    const cb = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    return {
      host,
      shaft: { x: bb.x, y: bb.y, w: bb.width, h: bb.height },
      card: { x: cb.x, y: cb.y, w: cb.width, h: cb.height },
      cardBg: cs.backgroundColor, cardOp: cs.opacity, cardBgi: cs.backgroundImage.slice(0, 100),
      glyph: (() => { const g = card.querySelector('.stage-word'); if (!g) return null; const gb = g.getBoundingClientRect(); return { x: gb.x, y: gb.y, w: gb.width, h: gb.height, fs: getComputedStyle(g).fontSize, color: getComputedStyle(g).color }; })()
    };
  });
  console.log(`宿主 ${geo.host}`);
  console.log(`shaft ${JSON.stringify(geo.shaft)}`);
  console.log(`card  ${JSON.stringify(geo.card)} bg=${geo.cardBg} opacity=${geo.cardOp}`);
  console.log(`  bgi=${geo.cardBgi}`);
  console.log(`glyph ${JSON.stringify(geo.glyph)}`);
  await page.waitForTimeout(600);

  const cx = geo.shaft.x + geo.shaft.w / 2;
  const yT = geo.shaft.y + 12, yB = geo.shaft.y + geo.shaft.h - 12;
  const STEPS = [
    ['基线', ''],
    ['shaft/mote 归零', ':root{--mote:rgba(255,255,255,0)!important;--shaft-core:rgba(255,255,255,0)!important;--shaft-mid:rgba(255,255,255,0)!important;--shaft-bed:rgba(255,255,255,0)!important;--shaft-edge:rgba(255,255,255,0)!important}'],
    ['+ shaft 隐藏', '.well-shaft{display:none!important}'],
    ['+ .stage-word 隐藏', '.stage-word{display:none!important}'],
    ['+ 卡片纯 raised', '.chat-welcome{background-color:#FBFCFA!important;background-image:none!important;opacity:1!important}']
  ];
  for (const [label, css] of STEPS) {
    if (css) await page.addStyleTag({ content: css });
    await page.waitForTimeout(300);
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const col = (x) => {
      const v = [];
      for (let y = Math.round(yT); y <= Math.round(yB); y += 8) v.push(rel(at(img, x, y)).toFixed(3));
      v.sort();
      return v[v.length >> 1];
    };
    console.log(`· ${label.padEnd(20)} 中心列中位 ${col(cx)} ｜ 左-24 ${col(cx - 24)} ｜ 右+24 ${col(cx + 24)} ｜ 带外-30 ${col(geo.shaft.x - 30)}`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
