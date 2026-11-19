/* ============================================================================
   R78c · 主台面材质量化度量（工程师自查，非 QA 结论）
   一次跑出 T1 / T2 / T3 与 L1 彩边的实测数值，避免"我觉得更明显了"式收口。
     T1 台面内部水平扫描（y = 台面垂直中线）：亮度极差 / 一阶差分符号翻转次数
     T2 台面左右内边 3px 处 RGB 欧氏距离 + 两侧彩边实宽（容差判据见下）
     T3 上沿"亮度距纯白 ≤4%"的连续带宽
   用法：node scripts/metrics-r78c.mjs
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-metrics-'));
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
const at = (img, x, y) => {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.w || yi >= img.h) return [0, 0, 0];
  const d = (yi * img.w + xi) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2]];
};
/* 0..255 亮度（Rec.709 luma，与"12/255"这种口径直接可比） */
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/* 沿一条水平线取 luma 序列；为了抗 1px 网格/字形，取 3 行（y-1,y,y+1）的逐列中位数 */
function hProfile(img, x0, x1, y) {
  const out = [];
  for (let x = Math.round(x0); x <= Math.round(x1); x++) {
    const v = [luma(at(img, x, y - 1)), luma(at(img, x, y)), luma(at(img, x, y + 1))].sort((a, b) => a - b);
    out.push(v[1]);
  }
  return out;
}
/* 平滑后的一阶差分符号翻转次数（= 局部极值个数）；EPS 用来吃掉 1 级抖动 */
function signFlips(profile, eps = 0.35) {
  const s = profile.map((v, i, arr) => {
    const a = arr[Math.max(0, i - 1)], b = arr[Math.min(arr.length - 1, i + 1)];
    return (a + v + b) / 3;
  });
  let flips = 0, prevSign = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (Math.abs(d) < eps) continue;
    const sign = d > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) flips++;
    prevSign = sign;
  }
  return flips;
}
/* 彩边实宽：从边缘向内，直到与"内部参考色"距离 < tol 为止 */
function fringeWidth(img, xEdge, dir, y, innerRef, tol = 30, maxW = 20) {
  let w = 0;
  for (let i = 1; i <= maxW; i++) {
    const c = at(img, xEdge + dir * i, y);
    if (dist(c, innerRef) < tol) break;
    w = i;
  }
  return w;
}

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const boxes = await page.evaluate(() => {
    const g = (id) => { const b = document.querySelector(id).getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { stage: g('#mainStage'), rail: g('#glass-top') };
  });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); window.scrollTo(0, 0); }, theme);
    await page.waitForTimeout(1400);
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const st = boxes.stage, rl = boxes.rail;
    const yMid = st.y + Math.round(st.h / 2);

    /* ---- T1：台面内部水平扫描（左右各内缩 8px，避开 1px 描边与彩边） ---- */
    const prof = hProfile(img, st.x + 8, st.x + st.w - 8, yMid);
    const mx = Math.max(...prof), mn = Math.min(...prof);
    const mid = prof.slice(60, prof.length - 60);
    const mmx = Math.max(...mid), mmn = Math.min(...mid);
    console.log(`\n########## ${theme} ##########`);
    console.log(`T1 台面 y=${yMid} 扫描 ${prof.length}px：max=${mx.toFixed(1)} min=${mn.toFixed(1)} 极差=${(mx - mn).toFixed(1)}/255（需 ≥12）；一阶差分符号翻转=${signFlips(prof)} 次（需 ≥1）`);
    console.log(`   〔严格口径 · 去掉左右各 60px 边缘〕中段极差=${(mmx - mmn).toFixed(1)}/255、翻转=${signFlips(mid)} 次（边缘色散/描边不算证据）`);
    const step = Math.max(1, Math.floor(prof.length / 12));
    const samples = [];
    for (let i = 0; i < prof.length; i += step) samples.push(`${st.x + 8 + i}:${prof[i].toFixed(0)}`);
    console.log('   剖面抽样 → ' + samples.join('  '));

    /* ---- T2：台面左右内边 3px ---- */
    const iL = st.x + 1, iR = st.x + st.w - 2;
    const cL3 = at(img, iL + 3, yMid), cR3 = at(img, iR - 3, yMid);
    const innerRefL = at(img, iL + 14, yMid), innerRefR = at(img, iR - 14, yMid);
    console.log(`T2 台面 3px 处 左=${cL3.join('/')} 右=${cR3.join('/')} RGB 欧氏距离=${dist(cL3, cR3).toFixed(1)}（需 ≥40）`
      + ` ｜ 实宽 左=${fringeWidth(img, iL, 1, yMid, innerRefL)}px 右=${fringeWidth(img, iR, -1, yMid, innerRefR)}px（需各 ≥3px）`);

    /* ---- T3：上沿"距纯白 ≤4%"的连续带宽 ---- */
    /* 取"最长连续达标段"而不是"从第 0 行起算"：第 0 行是 1px 描边（比亮带暗），
       从 0 起算会把已经达标的 8px 亮带判成 0px（假红）。这是口径修正，不是放宽：
       仍然要求**连续** ≥6 行，跳行不算。 */
    let band = 0, run = 0;
    for (let dy = 0; dy < 24; dy++) {
      const row = [];
      for (let x = st.x + 40; x < st.x + st.w - 40; x += 7) row.push(luma(at(img, x, st.y + dy)));
      const med = row.sort((a, b) => a - b)[row.length >> 1];
      if (med >= 255 * 0.96) { run++; band = Math.max(band, run); } else { run = 0; }
    }
    const rowVals = [];
    for (let dy = 0; dy < 12; dy++) {
      const row = [];
      for (let x = st.x + 40; x < st.x + st.w - 40; x += 7) row.push(luma(at(img, x, st.y + dy)));
      rowVals.push(`${dy}:${row.sort((a, b) => a - b)[row.length >> 1].toFixed(0)}`);
    }
    console.log(`T3 台面上沿"距纯白≤4%"连续带宽=${band}px（需 ≥6）；逐行亮度 → ${rowVals.join(' ')}`);

    /* ---- 参考：L1 左栏彩边（同口径，便于对比"台面 vs 玻璃"） ---- */
    const ry = rl.y + Math.round(rl.h / 2);
    const rL3 = at(img, rl.x + 1 + 3, ry), rR3 = at(img, rl.x + rl.w - 2 - 3, ry);
    console.log(`参考 L1 左栏 3px 处 左=${rL3.join('/')} 右=${rR3.join('/')} 距离=${dist(rL3, rR3).toFixed(1)}`
      + ` ｜ 实宽 左=${fringeWidth(img, rl.x + 1, 1, ry, at(img, rl.x + 16, ry))}px 右=${fringeWidth(img, rl.x + rl.w - 2, -1, ry, at(img, rl.x + rl.w - 16, ry))}px`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
