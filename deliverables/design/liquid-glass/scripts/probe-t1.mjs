/* ============================================================================
   probe-t1.mjs · T1 归因探针（诊断用，不参与验收）
   目的：回答"台面液团到底有没有画出来 / 被谁吃掉了"这一个问题。
   做法：同一视口连拍三张 ——
     A 现状
     B 把 .msg 卡片清零（背景透明、去图、去投影、去内发光）
     C 在 B 之上再把 .chat-welcome / .slab / .enamel 也清零（台面只剩自己的 background-image）
   然后在同一 y（台面垂直中线）上取剖面，并把三团液团的**几何中心**逐个取色，
   差值即"卡片吸收了多少"。归因链路一旦确定，改哪一层就没有猜测空间。
   用法：node scripts/probe-t1.mjs
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-t1-'));
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
  if (xi < 0 || yi < 0 || xi >= img.w || yi >= img.h) return [0, 0, 0];
  const d = (yi * img.w + xi) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2]];
};
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function hProfile(img, x0, x1, y) {
  const out = [];
  for (let x = Math.round(x0); x <= Math.round(x1); x++) {
    const v = [luma(at(img, x, y - 1)), luma(at(img, x, y)), luma(at(img, x, y + 1))].sort((a, b) => a - b);
    out.push(v[1]);
  }
  return out;
}
const range = (a) => Math.max(...a) - Math.min(...a);

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const info = await page.evaluate(() => {
    const st = document.querySelector('#mainStage');
    const cs = getComputedStyle(st);
    const li = cs.backgroundImage;
    /* 顶层逗号切分足够：本工程不在这条属性上用会带逗号的函数（color-mix 已禁用） */
    const layers = li === 'none' ? [] : li.split(/,(?![^(]*\))/).map(s => s.trim()).slice(0, 40);
    const r = st.getBoundingClientRect();
    return {
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      fill: cs.backgroundColor,
      nLayers: layers.length,
      liquidLayers: layers.filter(s => s.includes('rgb') && /radial-gradient/.test(s)).length,
      /* 三团液团的几何中心（把 calc 里的 px 偏移当成 0 读，误差 <=28px，足够定位） */
      centers: [6, 7, 8].map((i) => {
        const v = getComputedStyle(document.documentElement).getPropertyValue(`--liquid-${i}`);
        return { i, color: v.trim() };
      })
    };
  });
  const st = info.box;
  const yMid = st.y + Math.round(st.h / 2);
  console.log(`#mainStage box=${JSON.stringify(st)} fill=${info.fill}`);
  console.log(`background-image 层数=${info.nLayers}（其中 radial=${info.liquidLayers}）`);
  console.log('液团令牌 → ' + info.centers.map(c => `--liquid-${c.i}:${c.color}`).join('  '));

  const shots = [];
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(1200);
  shots.push(['A 现状', await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } })]);

  await page.addStyleTag({
    content: `.msg{background-color:transparent!important;background-image:none!important;
      box-shadow:none!important;border-color:transparent!important;backdrop-filter:none!important}`
  });
  await page.waitForTimeout(500);
  shots.push(['B .msg 清零', await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } })]);

  await page.addStyleTag({
    content: `.chat-welcome,.slab,.enamel,.composer,.tool-step-rail,.sessions-frame
      {background-color:transparent!important;background-image:none!important;
       box-shadow:none!important;border-color:transparent!important}`
  });
  await page.waitForTimeout(500);
  shots.push(['C 卡片全清', await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } })]);

  const x0 = st.x + 8, x1 = st.x + st.w - 8;
  const cx = [0.30, 0.74, 0.52].map(p => st.x + p * st.w);
  for (const [label, buf] of shots) {
    const img = decodePng(buf);
    const prof = hProfile(img, x0, x1, yMid);
    const mid = prof.slice(60, prof.length - 60);
    console.log(`\n【${label}】y=${yMid}  整段极差=${range(prof).toFixed(1)}  中段极差=${range(mid).toFixed(1)}`);
    const s = [];
    for (let i = 0; i < prof.length; i += Math.max(1, Math.floor(prof.length / 12))) s.push(`${x0 + i}:${prof[i].toFixed(0)}`);
    console.log('  剖面 → ' + s.join('  '));
    console.log('  液团中心取色 → ' + cx.map((x, k) => `L${6 + k}@${Math.round(x)}=${at(img, x, yMid).join('/')}(Y${luma(at(img, x, yMid)).toFixed(0)})`).join('  '));
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
