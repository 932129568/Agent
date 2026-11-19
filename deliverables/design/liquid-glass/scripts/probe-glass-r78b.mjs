/* R78b 探针二：玻璃背后到底有什么 + 左右内侧色散是否真的有像素
   做法：在同一位置各截一次「有玻璃」和「玻璃 visibility:hidden」，
        对比 RGB ⇒ 分离"背后有什么"与"玻璃自己画了什么"。
   产出：控制台表格（不落盘，不参与判据）。 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78b-p2-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, colorType = 0, bitDepth = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
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

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); window.scrollTo(0, 0); }, theme);
    await page.waitForTimeout(1300);
    const box = await page.evaluate(() => {
      const b = document.querySelector('#glass-top').getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    });
    /* 全屏截一张 → 用页面坐标采样 */
    const grab = async () => decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const withGlass = await grab();
    await page.evaluate(() => { document.querySelector('#glass-top').style.visibility = 'hidden'; });
    await page.waitForTimeout(120);
    const noGlass = await grab();
    await page.evaluate(() => { document.querySelector('#glass-top').style.visibility = ''; });
    await page.waitForTimeout(120);

    console.log(`\n########## ${theme} ##########`);
    console.log('横向扫描：x 有玻璃 / 无玻璃（y = rail 中部 ' + (box.y + 420) + '）');
    const y = box.y + 420;
    for (let i = 0; i <= 6; i++) {
      const x = Math.round(box.x + 20 + ((box.w - 40) * i) / 6);
      console.log(`  x=${String(x).padStart(4)}  ${at(withGlass, x, y).join('/').padEnd(14)}  ←raw ${at(noGlass, x, y).join('/')}`);
    }
    console.log('左右内缘（y = ' + y + '，offset 从边缘向内 0..7px）');
    for (let d = 0; d <= 7; d++) {
      const xl = box.x + d, xr = box.x + box.w - 1 - d;
      console.log(`  +${d}px  左 ${at(withGlass, xl, y).join('/').padEnd(14)} 右 ${at(withGlass, xr, y).join('/')}   (raw 左 ${at(noGlass, xl, y).join('/')} 右 ${at(noGlass, xr, y).join('/')})`);
    }
    console.log('上下内缘（x = 中点，offset 0..7px）');
    const cx = Math.round(box.x + box.w / 2);
    for (let d = 0; d <= 7; d++) {
      console.log(`  +${d}px  上 ${at(withGlass, cx, box.y + d).join('/').padEnd(14)} 下 ${at(withGlass, cx, box.y + box.h - 1 - d).join('/')}`);
    }
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
