/* ============================================================================
   R78b · OPT-17 区分力诊断（工程师自查，非 QA 结论）
   背景：OPT-17 的反例二注入 `--lg-l2-far: transparent` 后，顶边不对称只从
   .0391 掉到 .0227，仍高于阈值 .010 ⇒ 判据"仍绿 ✗ 无区分力"。
   本探针逐层归因：到底是哪一层新材料在顶边左右各贡献了多少亮度差，
   以便判断是"改材质"还是"改判据口径"（或两者都不是）。
   采样口径与 OPT-17 完全一致：.stage rect 内缩 16px、20×20 块、亮度中位数。
   ============================================================================ */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78b-opt17-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

const INSET = 16, BLOCK = 20;

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
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
const lumOf = (r, g, b) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
function blockLumMedian(img, x0, y0, w, h) {
  const vals = [];
  for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
    for (let x = Math.round(x0); x < Math.round(x0 + w); x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const d = (y * img.w + x) * 4;
      vals.push(lumOf(img.data[d], img.data[d + 1], img.data[d + 2]));
    }
  }
  vals.sort((a, b) => a - b);
  return vals[(vals.length - 1) >> 1];
}

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const rect = await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    window.scrollTo(0, 0);
    const st = document.querySelector('#mainStage') || document.querySelector('.stage');
    const b = st.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await page.waitForTimeout(250);

  const setInject = async (css) => {
    await page.evaluate((c) => {
      let s = document.getElementById('__probe');
      if (!s) { s = document.createElement('style'); s.id = '__probe'; document.head.appendChild(s); }
      s.textContent = c;
    }, css);
    await page.waitForTimeout(180);
  };

  const measure = async () => {
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } });
    const img = decodePng(buf);
    const at = (x, y) => blockLumMedian(img, x, y, BLOCK, BLOCK);
    return {
      LT: at(rect.x + INSET, rect.y + INSET),
      RT: at(rect.x + rect.w - INSET - BLOCK, rect.y + INSET),
      LB: at(rect.x + INSET, rect.y + rect.h - INSET - BLOCK),
      RB: at(rect.x + rect.w - INSET - BLOCK, rect.y + rect.h - INSET - BLOCK)
    };
  };
  const f = (v) => v.toFixed(4);
  const show = (tag, L) => console.log(
    `${tag.padEnd(34)} LT=${f(L.LT)} RT=${f(L.RT)} LB=${f(L.LB)} RB=${f(L.RB)}  asym(LT-RT)=${f(L.LT - L.RT)}  drop(LT-RB)=${f(L.LT - L.RB)}`);

  const curLx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--light-x')));
  const curBx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lg-l2-bloom-x')));
  const mLx = (100 - curLx).toFixed(3), mBx = (100 - curBx).toFixed(3);
  console.log('当前 --light-x =', curLx + '%', '→ 镜像', mLx + '%', '｜ --lg-l2-bloom-x =', curBx + '%', '→ 镜像', mBx + '%');

  const variants = [
    ['base', ''],
    ['far ONLY transparent', ':root{--lg-l2-far:transparent!important;}'],
    ['bloom ONLY transparent', ':root{--lg-l2-bloom:transparent!important;}'],
    ['key ONLY transparent', ':root{--lg-l2-key:transparent!important;}'],
    ['MIRROR light-x + bloom-x', `:root{--light-x:${mLx}%!important;--lg-l2-bloom-x:${mBx}%!important;}`],
    ['MIRROR light-x only', `:root{--light-x:${mLx}%!important;}`],
    ['restore', '']
  ];
  console.log('抽样矩形 .stage =', JSON.stringify(rect));
  for (const [tag, css] of variants) {
    await setInject(css);
    show(tag, await measure());
  }

  /* 颜色取证（色散环是否可见）：沿上沿与左右内侧 1px 取色 */
  await setInject('');
  await page.waitForTimeout(150);
  const railBox = await page.evaluate(() => {
    const b = document.querySelector('#glass-top').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  const buf = await page.screenshot({ clip: { x: Math.floor(railBox.x), y: Math.floor(railBox.y), width: 60, height: 60 } });
  const img = decodePng(buf);
  const col = (x, y) => { const d = (y * img.w + x) * 4; return [img.data[d], img.data[d + 1], img.data[d + 2]]; };
  console.log('\n#glass-top 左上角 12×8 取色（x→, y↓）：');
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 12; x++) { const c = col(x, y); row.push(`${c[0]},${c[1]},${c[2]}`.padEnd(12)); }
    console.log('  y' + y + ' ' + row.join(' '));
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
