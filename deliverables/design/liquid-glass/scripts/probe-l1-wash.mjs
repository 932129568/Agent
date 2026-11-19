/* R78b 探针三：L1 玻璃上"白色提亮"逐令牌归因
   目的：横向扫描显示 raw 208→178 在玻璃后变成 237→224（落差被压掉一半），
        有效白色叠层 ≈ .60。逐个把令牌置 transparent，看谁在提亮。
   产出：控制台表格。 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78b-p3-'));
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
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      if (ch === 4) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
      else { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
    }
    prev = cur; off += 1 + stride;
  }
  return { w, h, data: out };
}
const at = (img, x, y) => { const d = (y * img.w + x) * 4; return [img.data[d], img.data[d + 1], img.data[d + 2]]; };

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); window.scrollTo(0, 0); });
  await page.waitForTimeout(1300);

  const box = await page.evaluate(() => {
    const b = document.querySelector('#glass-top').getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  });
  const ys = box.y + 444;
  const xs = [box.x + 40, box.x + 130, box.x + 220];

  const setCss = async (css) => {
    await page.evaluate((c) => {
      let s = document.getElementById('__p3');
      if (!s) { s = document.createElement('style'); s.id = '__p3'; document.head.appendChild(s); }
      s.textContent = c;
    }, css);
    await page.waitForTimeout(160);
  };
  const sample = async () => {
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    return xs.map(x => at(img, x, ys).join('/'));
  };

  const variants = [
    ['base（现状）', ''],
    ['fill → transparent', '.rail-left.glass{background-color:transparent!important;}'],
    ['bloom → transparent', ':root{--lg-l1-bloom:transparent!important;}'],
    ['sheen → transparent', ':root{--lg-l1-sheen:transparent!important;}'],
    ['inner → transparent', ':root{--lg-l1-inner:transparent!important;}'],
    ['box-shadow → none', '.rail-left.glass{box-shadow:none!important;}'],
    ['background-image → none（只留 fill）', '.rail-left.glass{background-image:none!important;}'],
    ['全部撤掉（只剩 backdrop-filter）', '.rail-left.glass{background-image:none!important;background-color:transparent!important;box-shadow:none!important;}'],
    ['+ backdrop-filter → none（=纯背景）', '.rail-left.glass{background-image:none!important;background-color:transparent!important;box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}']
  ];
  console.log('rail box =', JSON.stringify(box), ' 采样 y =', ys, ' x =', xs.join(','));
  for (const [tag, css] of variants) {
    await setCss(css);
    console.log('  ' + tag.padEnd(36) + (await sample()).join('   '));
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
