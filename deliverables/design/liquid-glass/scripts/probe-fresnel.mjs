/* R79 一阶段 · 菲涅尔剖面 / 色散有序性 / 位移实效 的度量探针（诊断用，非交付物）
   用法：node scripts/probe-fresnel.mjs [light|dark]

   方法（为什么不是"直接量绝对值"）：
     明档的 L1 填充只有 .10，背后就是页面底色（≈250），反射几乎没有上升空间 ——
     直接量到的剖面会被"背景已经很亮"这件事压平，N(15) 甚至能大于 N(8)。
     所以剖面按**增量**量：先注入一组 `transparent` 把整个边缘栈（菲涅尔四档 +
     接触线 + 色散 + 上下沿）关掉，取基线；再取正常态；Δ(d) = on − off。
     N(d) = Δ(d) / Δ(0.5)。这条口径只量"边缘材质栈贡献了多少亮度"，
     与背景亮不亮、透过去什么颜色都无关 —— 也和"反例注入必须翻红"是同一套纪律。 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const QA = join(DESIGN, 'qa');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r79-fres-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

/* ---- 零依赖 PNG 解码（RGBA / RGB / 灰度 8bit 非隔行） ---- */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!ch || bd !== 8) throw new Error('unsupported png ct=' + ct + ' bd=' + bd);
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}
const px = (img, x, y) => { const i = (y * img.w + x) * img.ch; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const f3 = v => (v === null || !isFinite(v) ? 'NA' : v.toFixed(3));

const theme = process.argv[2] === 'dark' ? 'dark' : 'light';
mkdirSync(QA, { recursive: true });

const RING_VARS = ['--lg-fres-1', '--lg-fres-2', '--lg-fres-3', '--lg-fres-4',
  '--lg-fres-top', '--lg-fres-bottom', '--lg-contact-hl', '--lg-contact-sh',
  '--lg-disp-warm', '--lg-disp-cool'];
/* 关掉边缘栈时**连上下沿 1px 与内 1px 环一起关**：它们同属"边缘材质栈"，
   留在基线里会让 Δ(0.5) 变小、把 N 归一化放大。色散两段也一起关 ——
   L5 要单独证明"顺序"，不能在剖面里混进去。 */
const RING_OFF_CSS = ':root{' + RING_VARS.map(v => v + ':transparent').join(';') +
  ';--lg-l1-hl:transparent;--lg-l1-shade:transparent;--lg-l1-edge:transparent}';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
});
try {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForTimeout(400);
  await page.evaluate(t => {
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.reveal').forEach(n => n.classList.add('is-in'));
  }, theme);
  await page.waitForTimeout(900);

  const geo = await page.evaluate(() => {
    const g = id => { const el = document.getElementById(id); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return { top: g('glass-top'), ribbon: g('glass-ribbon'), stage: g('mainStage') };
  });
  console.log('geometry', JSON.stringify(geo));

  const shoot = async (name) => {
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } });
    if (name) writeFileSync(join(QA, name), buf);
    return decodePng(buf);
  };

  const on = await shoot(`r79-fres-${theme}.png`);
  await page.addStyleTag({ content: RING_OFF_CSS });
  await page.waitForTimeout(200);
  const off = await shoot(`r79-fres-${theme}-ringsoff.png`);
  await page.evaluate(() => { const n = document.getElementById('r79-ring-off'); if (n) n.remove(); });
  /* addStyleTag 会在 head 末尾插一个 <style>；摘掉它用不了 id，直接按内容找 */
  await page.evaluate(sel => {
    const st = [...document.querySelectorAll('style')].filter(s => s.textContent.indexOf('--lg-fres-1:transparent') >= 0);
    st.forEach(s => s.remove());
  });
  await page.waitForTimeout(150);

  /* ---------- 边际材质的增量剖面 ---------- */
  function rowProfile(img, el, dir, span) {
    const x0 = Math.round(el.x + 12), x1 = Math.round(el.x + el.w - 12);
    const out = [];
    for (let d = 0; d < span; d++) {
      const y = dir === 'top' ? Math.round(el.y) + d : Math.round(el.y + el.h) - 1 - d;
      const vals = [];
      for (let x = x0; x < x1; x++) vals.push(luma(px(img, x, y)));
      out.push(median(vals));
    }
    return out;
  }
  const dTop = (a, b, n) => { const pa = rowProfile(a, geo.top, 'top', n), pb = rowProfile(b, geo.top, 'top', n); return pa.map((v, i) => v - pb[i]); };
  const dBot = (a, b, n) => { const pa = rowProfile(a, geo.top, 'bottom', n), pb = rowProfile(b, geo.top, 'bottom', n); return pa.map((v, i) => v - pb[i]); };

  const top = dTop(on, off, 60);
  const bot = dBot(on, off, 30);
  const peak = Math.max(...top.slice(0, 3));
  const N = d => top[d] / peak;
  console.log('Δtop d=0..24 :', top.slice(0, 25).map(v => v.toFixed(1)).join(' '));
  console.log('Δtop d=25..40:', top.slice(25, 40).map(v => v.toFixed(1)).join(' '));
  console.log('peak(0..2)=', peak.toFixed(2));
  console.log('N(0.5)=1 · N(1)=', f3(N(1)), 'N(4)=', f3(N(4)), 'N(8)=', f3(N(8)), 'N(15)=', f3(N(15)), 'N(20)=', f3(N(20)));
  const peakB = Math.max(...bot.slice(0, 3));
  console.log('Δbot d=0..12 :', bot.slice(0, 13).map(v => v.toFixed(1)).join(' '), '| peakB=', peakB.toFixed(2));
  console.log('上/下沿比 =', peakB > 0 ? (peak / peakB).toFixed(2) : 'NA');

  /* ---------- 色散有序性：左壁 / 右壁 逐点 R−B ---------- */
  const dispersion = (img, el) => {
    const y0 = Math.round(el.y + Math.max(8, el.h * 0.35));
    const y1 = Math.round(el.y + Math.min(el.h - 8, el.h * 0.65));
    const out = { left: [], right: [] };
    for (let d = 0; d < 8; d++) {
      const lv = [], rv = [];
      for (let y = y0; y < y1; y++) {
        const cl = px(img, Math.round(el.x) + d, y), cr = px(img, Math.round(el.x + el.w) - 1 - d, y);
        lv.push(cl[0] - cl[2]); rv.push(cr[0] - cr[2]);
      }
      out.left.push(median(lv)); out.right.push(median(rv));
    }
    return out;
  };
  const disp = dispersion(on, geo.top);
  console.log('R−B by d left :', disp.left.map(v => (v > 0 ? '+' : '') + v).join(' '));
  console.log('R−B by d right:', disp.right.map(v => (v > 0 ? '+' : '') + v).join(' '));

  /* ---------- 位移实效：位移态 vs 回落态 ---------- */
  const shotOf = async (optics) => {
    await page.evaluate(o => document.documentElement.setAttribute('data-optics', o), optics);
    await page.waitForTimeout(280);
    return decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
  };
  const a = await shotOf('displace');
  const b = await shotOf('blur');
  const cmpBox = (im1, im2, x0, x1, y0, y1) => {
    let n = 0, diff = 0, maxd = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p1 = px(im1, x, y), p2 = px(im2, x, y);
        const d = Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]), Math.abs(p1[2] - p2[2]));
        n++; if (d > 2) diff++; if (d > maxd) maxd = d;
      }
    }
    return { n, diff, pct: (100 * diff / Math.max(1, n)).toFixed(2) + '%', maxd };
  };
  const R = (el, inset) => [Math.round(el.x + inset), Math.round(el.x + el.w - inset), Math.round(el.y + inset), Math.round(el.y + el.h - inset)];
  console.log('中心区 #glass-top（inset 40%）：', JSON.stringify(cmpBox(a, b, ...R(geo.top, Math.round(geo.top.w * 0.40)))));
  console.log('中心区 #glass-ribbon（inset 40%）：', JSON.stringify(cmpBox(a, b, ...R(geo.ribbon, Math.round(geo.ribbon.h * 0.40)))));
  const bandOf = (im1, im2, el) => {
    let n = 0, diff = 0, maxd = 0;
    const x0 = Math.round(el.x), x1 = Math.round(el.x + el.w), y0 = Math.round(el.y), y1 = Math.round(el.y + el.h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const inBand = (x - x0) < 8 || (x1 - 1 - x) < 8 || (y - y0) < 8 || (y1 - 1 - y) < 8;
      if (!inBand) continue;
      const p1 = px(im1, x, y), p2 = px(im2, x, y);
      const d = Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]), Math.abs(p1[2] - p2[2]));
      n++; if (d > 2) diff++; if (d > maxd) maxd = d;
    }
    return { n, diff, pct: (100 * diff / Math.max(1, n)).toFixed(2) + '%', maxd };
  };
  console.log('边缘 8px 环带 #glass-top   ：', JSON.stringify(bandOf(a, b, geo.top)));
  console.log('边缘 8px 环带 #glass-ribbon：', JSON.stringify(bandOf(a, b, geo.ribbon)));
  console.log('内容层 #mainStage 全域      ：', JSON.stringify(cmpBox(a, b, ...R(geo.stage, 0))));
  await shotOf('displace');
  console.log('errors:', errs.length ? errs : 'none');
} finally {
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
