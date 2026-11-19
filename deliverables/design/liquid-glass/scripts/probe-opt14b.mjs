/* probe-opt14b.mjs · "卡片面为什么只有 .72，而底色合成值是 .9353"
   逐项关闭，看哪一层在压暗光柱所在的卡片面（明色，y 取卡片垂直中线）。 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-o14b-'));
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

const STEPS = [
  ['基线', ''],
  ['shaft/mote 令牌全归零', ':root{--mote:rgba(255,255,255,0)!important;--shaft-core:rgba(255,255,255,0)!important;--shaft-mid:rgba(255,255,255,0)!important;--shaft-bed:rgba(255,255,255,0)!important;--shaft-edge:rgba(255,255,255,0)!important}'],
  ['+ .well-shaft 隐藏', '.well-shaft{display:none!important}'],
  ['+ 卡片改纯 --color-raised', '.chat-welcome{background-color:#FBFCFA!important;background-image:none!important}'],
  ['+ 台面液团全关', ':root{--liquid-6:transparent!important;--liquid-7:transparent!important;--liquid-8:transparent!important}'],
  ['+ 台面图层全关（只留 fill）', '.stage{background-image:none!important}']
];

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
  await page.waitForTimeout(1200);

  const geo = await page.evaluate(() => {
    const el = document.querySelector('.stage .chat-welcome');
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    /* 光柱宿主：非空态被搬进 #chatWelcome */
    const s = document.querySelector('.well-shaft');
    const sb = s ? s.getBoundingClientRect() : null;
    return {
      card: { x: b.x, y: b.y, w: b.width, h: b.height },
      shaft: sb ? { x: sb.x, y: sb.y, w: sb.width, h: sb.height, disp: getComputedStyle(s).display } : null,
      bg: cs.backgroundColor, bgi: cs.backgroundImage.slice(0, 120)
    };
  });
  console.log(`.chat-welcome ${JSON.stringify(geo.card)} bg=${geo.bg}`);
  console.log(`  bgi=${geo.bgi}`);
  console.log(`.well-shaft ${JSON.stringify(geo.shaft)}`);
  const yMid = Math.round(geo.card.y + geo.card.h / 2);
  const xs = [geo.card.x + 20, Math.round(geo.card.x + geo.card.w / 2), Math.round(geo.card.x + geo.card.w - 20)];

  for (const [label, css] of STEPS) {
    if (css) await page.addStyleTag({ content: css });
    await page.waitForTimeout(320);
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const out = xs.map(x => { const c = at(img, x, yMid); return `${x}:${c.join('/')}(${rel(c).toFixed(4)})`; });
    console.log(`· ${label.padEnd(26)} y=${yMid} → ${out.join('  ')}`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
