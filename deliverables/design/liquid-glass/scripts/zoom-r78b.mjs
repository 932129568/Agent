/* R78b 诊断探针：放大取色 + 数值取证（不参与判据，仅工程师目视辅助）
   产出：
     qa/r78b-zoom-{light,dark}-top.png     L1 上沿 4× 放大
     qa/r78b-zoom-{light,dark}-left.png    L1 左侧内缘 6× 放大
     qa/r78b-zoom-{light,dark}-right.png   L1 右侧内缘 6× 放大
   数值：上沿逐行 RGB / 左右内缘逐列 RGB / 玻璃背后横向色差 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const QA = join(DESIGN, 'qa');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r78b-zoom-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');
mkdirSync(QA, { recursive: true });

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

  /* 放大工具：把截到的 PNG 画进 canvas 放大 k 倍（pixelated），再截图 */
  const zoomShot = async (clip, k, file) => {
    const buf = await page.screenshot({ clip });
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    await page.evaluate(({ url, k }) => new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        let cv = document.getElementById('__zoomcv');
        if (cv) cv.remove();
        cv = document.createElement('canvas');
        cv.id = '__zoomcv';
        cv.width = img.width * k; cv.height = img.height * k;
        cv.style.cssText = `position:fixed;left:0;top:0;z-index:999999;image-rendering:pixelated;width:${img.width * k}px;height:${img.height * k}px;`;
        const g = cv.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, cv.width, cv.height);
        document.body.appendChild(cv);
        res(true);
      };
      img.src = url;
    }), { url: dataUrl, k });
    await page.waitForTimeout(80);
    await page.screenshot({ path: join(QA, file), clip: { x: 0, y: 0, width: Math.min(clip.width * k, 1440), height: Math.min(clip.height * k, 900) } });
    await page.evaluate(() => { const c = document.getElementById('__zoomcv'); if (c) c.remove(); });
  };

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); window.scrollTo(0, 0); }, theme);
    await page.waitForTimeout(1300);
    const box = await page.evaluate(() => {
      const b = document.querySelector('#glass-top').getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    });

    /* 数值取证：上沿逐行、左右内缘逐列 */
    const buf = await page.screenshot({ clip: { x: box.x - 4, y: box.y - 4, width: box.w + 8, height: 120 } });
    const img = decodePng(buf);
    const ox = box.x - 4, oy = box.y - 4;
    const colRows = [];
    const cx = Math.round(box.w / 2);
    for (let y = 0; y < 16; y++) colRows.push(`y${y}=${at(img, cx - ox, y + 4 - 4 + 0).join(',')}`);
    const head = [];
    for (let y = 0; y < 18; y++) {
      const c = at(img, cx, y);
      head.push(`+${y}:${c.join('/')}`);
    }
    const left = [];
    const right = [];
    for (let dx = 0; dx < 10; dx++) {
      left.push(`${dx}:${at(img, dx, 60).join('/')}`);
      right.push(`${dx}:${at(img, img.w - 1 - dx, 60).join('/')}`);
    }
    /* 玻璃背后横向色差：在 rail 内部同一条 y 上扫 9 个点 */
    const walk = [];
    for (let i = 0; i <= 8; i++) {
      const x = Math.round(8 + (box.w - 16) * (i / 8));
      walk.push(`${x}:${at(img, x + 4 - 4, 96).join('/')}`);
    }
    console.log(`\n===== ${theme} · #glass-top 上沿逐行（x=中心） =====`);
    console.log('  ' + head.join('  '));
    console.log(`  ── 左内缘逐列（y=+60）: ${left.join('  ')}`);
    console.log(`  ── 右内缘逐列（y=+60）: ${right.join('  ')}`);
    console.log(`  ── 横向扫描（y=+96）: ${walk.join('  ')}`);
    console.log('  colRows(sanity):', colRows.length);

    await zoomShot({ x: box.x, y: box.y, width: 140, height: 70 }, 5, `r78b-zoom-${theme}-top.png`);
    await zoomShot({ x: box.x, y: box.y + 40, width: 26, height: 90 }, 6, `r78b-zoom-${theme}-left.png`);
    await zoomShot({ x: box.x + box.w - 26, y: box.y + 40, width: 26, height: 90 }, 6, `r78b-zoom-${theme}-right.png`);
    await zoomShot({ x: box.x + box.w, y: box.y + 200, width: 300, height: 200 }, 2, `r78b-zoom-${theme}-behind.png`);
    console.log(`  [zoom] ${theme} 完成`);
  }

  /* 页面背景（液态三团）本体取证：不透过任何面板，直接看 .atmosphere 的伪元素区域 */
  const bgBuf = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 40 } });
  const bgImg = decodePng(bgBuf);
  const row = [];
  for (let i = 0; i <= 14; i++) {
    const x = Math.min(1439, Math.round((1439 * i) / 14));
    row.push(`${x}:${at(bgImg, x, 6).join('/')}`);
  }
  console.log('\n===== 页面顶部 y=6 横向扫描（.atmosphere 本体，未透过面板） =====');
  console.log('  ' + row.join('  '));
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
