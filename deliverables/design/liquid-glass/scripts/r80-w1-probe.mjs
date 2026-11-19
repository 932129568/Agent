/* R80-R2 · W1 玻璃材质自验（不是 QA 结论，是工程师给自己看的证据）
   用法：node scripts/r80-w1-probe.mjs
   产出：qa/r80-r2/w1-1440-light.png / w1-1440-dark.png / w1-noblur.png / w1-noblur-diff.json
   覆盖契约 §5 的验收项：
     G2 中栏计算样式：backdrop-filter 含 blur(28px) · backgroundColor alpha ∈ [.66,.74]
     G3 .msg backdrop-filter === 'none'；.msg * 里 filter/backdrop-filter 非 none 的 = 0
     G1 给 .msg 临时加 blur(6px) 与不加，逐像素比中位差 < 3/255
     G7 滚动 120 帧采样 fps（中栏 blur(28px) 覆盖 55% 面积）
     G8 --wp-visible:0 时中栏仍是不透明可读暖白
     附加：blur 元素清单 / bigShadow 清单 / 玻璃上文字的实际色
*/
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const QA = join(DESIGN, 'qa', 'r80-r2');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r80-w1-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

mkdirSync(QA, { recursive: true });

/* PNG → {w,h,rgba}（只处理 Playwright 输出的 8bit / colorType 2 或 6） */
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : (colorType === 2 ? 3 : 0);
  if (!ch || bitDepth !== 8) throw new Error(`unsupported png colorType=${colorType} depth=${bitDepth}`);
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4 + 0] = cur[x * ch + 0];
      out[(y * w + x) * 4 + 1] = cur[x * ch + 1];
      out[(y * w + x) * 4 + 2] = cur[x * ch + 2];
      out[(y * w + x) * 4 + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, rgba: out };
}
const median = arr => {
  const a = arr.slice().sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
});
const report = {};
try {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  /* .reveal 未落定时截图会把整块面板读成"被洗白"（时序，不是材质问题） */
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach(n => n.classList.add('is-in')));
  await page.waitForTimeout(900);

  report.G2 = await page.evaluate(() => {
    const el = document.getElementById('mainStage');
    const cs = getComputedStyle(el);
    const m = cs.backgroundColor.match(/[\d.]+/g).map(Number);
    const rgba = [m[0], m[1], m[2], m[3] === undefined ? 1 : m[3]];
    return {
      backdropFilter: cs.backdropFilter,
      webkitBackdropFilter: cs.webkitBackdropFilter,
      backgroundColor: cs.backgroundColor,
      alpha: rgba[3],
      color: cs.color,
      hasBlur28: /blur\(28px\)/.test(cs.backdropFilter),
      alphaInRange: rgba[3] >= 0.66 && rgba[3] <= 0.74
    };
  });

  report.G3 = await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('.msg')];
    const bad = [];
    msgs.forEach(m => {
      const cs = getComputedStyle(m);
      if (cs.backdropFilter !== 'none') bad.push({ sel: 'MSG-SELF', v: cs.backdropFilter });
      m.querySelectorAll('*').forEach(n => {
        const s = getComputedStyle(n);
        if (s.filter !== 'none') bad.push({ sel: n.className || n.tagName, prop: 'filter', v: s.filter });
        if (s.backdropFilter !== 'none') bad.push({ sel: n.className || n.tagName, prop: 'bdf', v: s.backdropFilter });
        if (s.mixBlendMode !== 'normal') bad.push({ sel: n.className || n.tagName, prop: 'blend', v: s.mixBlendMode });
      });
    });
    return {
      msgCount: msgs.length,
      bdfOfFirst: msgs[0] ? getComputedStyle(msgs[0]).backdropFilter : null,
      badCount: bad.length,
      bad: bad.slice(0, 8)
    };
  });

  report.blurAndShadow = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')].filter(n => n.offsetParent !== null ||
      (getComputedStyle(n).position === 'fixed' && n.getClientRects().length > 0));
    const blur = all.filter(el => { const b = getComputedStyle(el).backdropFilter; return b && b !== 'none'; })
      .map(el => ({ id: el.id || null, cls: String(el.className).slice(0, 30), v: getComputedStyle(el).backdropFilter }));
    const big = all.filter(el => {
      const s = getComputedStyle(el).boxShadow;
      if (!s || s === 'none') return false;
      return Math.max(0, ...(s.match(/(\d+)px/g) || ['0px']).map(v => parseInt(v, 10))) >= 40;
    }).map(el => ({ id: el.id || null, cls: String(el.className).slice(0, 30), v: getComputedStyle(el).boxShadow.slice(0, 90) }));
    return { blur, big };
  });

  report.glassText = await page.evaluate(() => {
    const pick = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
    return {
      mainStage: pick('#mainStage'),
      msg: pick('.msg'),
      msgMeta: pick('.msg-meta'),
      time: pick('#mainStage time'),
      leftNav: pick('.nav-group'),
      rightRow: pick('.observer-row')
    };
  });

  /* ---- G1：给 .msg 临时加 blur(6px)，与不加逐像素比 ---- */
  await page.screenshot({ path: join(QA, 'g1-noblur.png') });
  await page.addStyleTag({ content: '.msg{backdrop-filter:blur(6px)!important;-webkit-backdrop-filter:blur(6px)!important}' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(QA, 'g1-blur6.png') });
  await page.evaluate(() => {
    const tags = [...document.querySelectorAll('style')];
    const last = tags[tags.length - 1];
    if (last && /blur\(6px\)/.test(last.textContent)) last.remove();
  });
  await page.waitForTimeout(300);
  {
    const a = decodePng(readFileSync(join(QA, 'g1-noblur.png')));
    const b = decodePng(readFileSync(join(QA, 'g1-blur6.png')));
    const diffs = [];
    let sum = 0, n = 0;
    for (let i = 0; i < a.rgba.length; i += 4) {
      const d = (Math.abs(a.rgba[i] - b.rgba[i]) + Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) + Math.abs(a.rgba[i + 2] - b.rgba[i + 2])) / 3;
      diffs.push(d); sum += d; n++;
    }
    report.G1 = {
      size: `${a.w}x${a.h}`,
      medianDiff: +median(diffs).toFixed(3),
      meanDiff: +(sum / n).toFixed(3),
      pass: median(diffs) < 3
    };
  }

  /* ---- G7：滚动 120 帧采样 ---- */
  report.G7 = await page.evaluate(async () => {
    const root = document.querySelector('[data-scroll-root]');
    const deltas = [];
    let last = performance.now();
    const t0 = last;
    let i = 0;
    await new Promise(res => {
      const step = () => {
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        i++;
        if (root) root.scrollTop = (i * 7) % Math.max(1, root.scrollHeight - root.clientHeight + 1);
        if (i >= 120) return res();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const total = performance.now() - t0;
    const sorted = deltas.slice(5).sort((x, y) => x - y);   // 丢掉前 5 帧（首帧含样式解析）
    const p = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return {
      frames: i,
      elapsedMs: +total.toFixed(1),
      fps: +((i - 5) / ((total - deltas.slice(0, 5).reduce((s, v) => s + v, 0)) / 1000)).toFixed(1),
      p50: +p(.5).toFixed(2), p95: +p(.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2),
      over20ms: sorted.filter(d => d > 20).length
    };
  });

  /* ---- 出图：明 / 暗 ---- */
  await page.screenshot({ path: join(QA, 'w1-1440-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(QA, 'w1-1440-dark.png') });
  report.darkG2 = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('mainStage'));
    return { backdropFilter: cs.backdropFilter, backgroundColor: cs.backgroundColor, color: cs.color };
  });

  /* ---- G8：--wp-visible:0（读不到壁纸）时中栏仍可读 ---- */
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--wp-visible', '0');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await page.waitForTimeout(500);
  report.G8 = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('mainStage'));
    const m = cs.backgroundColor.match(/[\d.]+/g).map(Number);
    return { backgroundColor: cs.backgroundColor, alpha: m[3], wpVisible: getComputedStyle(document.documentElement).getPropertyValue('--wp-visible').trim() };
  });
  await page.screenshot({ path: join(QA, 'w1-1440-nowallpaper.png') });

  report.pageErrors = errs;
} finally {
  await ctx.close();
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
writeFileSync(join(QA, 'w1-probe.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
