/* probe-opt14.mjs · OPT-14 反例注入失效的几何归因
   问题：注入 --shaft/--mote 归零后，D 段"带内中心 vs 卡片底色合成"的差值仍有 +.0967
        （要求 |Δ|<.02）⇒ 说明带内的亮度差不是光柱造成的，而是台面液团的边界正好压在
        光柱采样带上。
   做法：打印光柱宿主 rect、台面 rect、三团液团按当前 --lq-a/--lq-b 换算出的像素圆心与
        椭圆半径，以及光柱带内 ±24px 的亮度剖面 —— 谁压在带上，一眼看得出来。 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-opt14-'));
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
  const xi = Math.round(x), yi = Math.round(y);
  const d = (yi * img.w + xi) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2]];
};
const pxLuma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(1200);

  const g = await page.evaluate(() => {
    const R = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const cs = getComputedStyle(document.documentElement);
    const num = (k, d) => { const v = parseFloat(cs.getPropertyValue(k)); return Number.isFinite(v) ? v : d; };
    return {
      stage: R('#mainStage'), card: R('.stage .chat-welcome'), shaft: R('.well-shaft'),
      lqA: num('--lq-a', 0), lqB: num('--lq-b', 0),
      blob: [6, 7, 8].map(i => ({
        i,
        x: num(`--liquid-${i}-x`, 0), y: num(`--liquid-${i}-y`, 0),
        c: cs.getPropertyValue(`--liquid-${i}`).trim()
      }))
    };
  });
  console.log(`#mainStage ${JSON.stringify(g.stage)}`);
  console.log(`.chat-welcome ${JSON.stringify(g.card)}  .well-shaft ${JSON.stringify(g.shaft)}`);
  console.log(`--lq-a=${g.lqA} --lq-b=${g.lqB}`);
  const blobs = [
    { i: 6, rx: 0.38, ry: 0.30, dxa: 28, dyb: 18, sign: [1, 1] },
    { i: 7, rx: 0.34, ry: 0.26, dxa: -24, dyb: 22, sign: [1, 1] },
    { i: 8, rx: 0.42, ry: 0.24, dxa: 20, dyb: -16, sign: [1, 1] }
  ];
  for (const b of blobs) {
    const meta = g.blob.find(z => z.i === b.i);
    /* views.css 里的写法：x 用 --lq-a 或 --lq-b，y 用另一个；这里按文件里的实际符号换算 */
    const cx = g.stage.x + meta.x / 100 * g.stage.w + (b.i === 6 ? g.lqA * 28 : b.i === 7 ? -g.lqB * 24 : g.lqB * 20)
      + (b.i === 7 || b.i === 8 ? 0 : 0);
    const cy = g.stage.y + meta.y / 100 * g.stage.h + (b.i === 6 ? g.lqB * 18 : b.i === 7 ? g.lqA * 22 : -g.lqA * 16);
    const rx = b.rx * g.stage.w, ry = b.ry * g.stage.h;
    console.log(`--liquid-${b.i} ${meta.c}  圆心≈(${cx.toFixed(0)},${cy.toFixed(0)})  椭圆半径 ${rx.toFixed(0)}×${ry.toFixed(0)}`
      + ` 核止(44%)≈${(rx * 0.44).toFixed(0)}×${(ry * 0.44).toFixed(0)} 淡出端(72%)≈${(rx * 0.72).toFixed(0)}×${(ry * 0.72).toFixed(0)}`);
  }
  const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
  if (g.shaft) {
    const cx = g.shaft.x + g.shaft.w / 2, ymid = g.shaft.y + g.shaft.h * 0.55;
    const prof = [];
    for (let dx = -30; dx <= 30; dx += 3) prof.push(`${dx}:${pxLuma(at(img, cx + dx, ymid)).toFixed(0)}`);
    console.log(`光柱中心(${cx.toFixed(0)},${ymid.toFixed(0)}) 水平剖面 ±30px → ${prof.join(' ')}`);
    const col = [];
    for (let dy = 0; dy < Math.min(240, g.shaft.h); dy += 20) col.push(`${dy}:${pxLuma(at(img, cx, g.shaft.y + dy)).toFixed(0)}`);
    console.log(`光柱纵向剖面 → ${col.join(' ')}`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
