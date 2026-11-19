/* R80-R2 · W1 镜像层取证 + 玻璃上文字像素对比
   用法：node scripts/r80-w1-mirror.mjs
   做四件事：
     ① #desktopMirror 的计算样式与**层级取证**（谁在谁上面，逐点 elementFromPoint）
     ② 路径验证：`assets/wallpaper.jpg` 与 `../assets/wallpaper.jpg` 哪个真的加载成功
        （CSS 里的相对 url() 以**样式表所在目录**为基准解析，styles/assets 不存在）
     ③ 装上壁纸后出图（明 / 暗）
     ④ 逐元素像素对比：底取矩形内 luma 中位数、前景取 p0，WCAG 2.1 复算
        —— 不信任算式，直接量像素（team-lead 明确要求）
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r80-mirror-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');
mkdirSync(QA, { recursive: true });

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : (colorType === 2 ? 3 : 0);
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
      if (ft === 1) v += a; else if (ft === 2) v += b;
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
const lum = (r, g, b) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/* 在截图里量一个矩形的「字 vs 底」：底 = luma 中位数，前景 = 偏亮取 p0 / 偏暗取 p100 */
function rectContrast(img, rect) {
  const xs = Math.max(0, Math.floor(rect.x)), ys = Math.max(0, Math.floor(rect.y));
  const xe = Math.min(img.w - 1, Math.ceil(rect.x + rect.width)), ye = Math.min(img.h - 1, Math.ceil(rect.y + rect.height));
  const ls = [];
  for (let y = ys; y <= ye; y++) for (let x = xs; x <= xe; x++) {
    const i = (y * img.w + x) * 4;
    ls.push({ l: lum(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]), i });
  }
  if (!ls.length) return null;
  const sorted = ls.slice().sort((a, b) => a.l - b.l);
  const med = sorted[(sorted.length - 1) >> 1].l;
  const darkest = sorted[0];
  const brightest = sorted[sorted.length - 1];
  /* 底偏亮 ⇒ 字是暗的 ⇒ 取最暗像素；底偏暗 ⇒ 取最亮像素 */
  const fg = med > 0.35 ? darkest : brightest;
  return {
    bed: +med.toFixed(4),
    fgL: +fg.l.toFixed(4),
    ratio: +ratio(med, fg.l).toFixed(2),
    bedRgb: [img.rgba[fg.i], img.rgba[fg.i + 1], img.rgba[fg.i + 2]]
  };
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
});
const out = {};
try {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach(n => n.classList.add('is-in')));
  await page.waitForTimeout(800);

  /* ① 层级取证 */
  out.layer = await page.evaluate(() => {
    const m = document.getElementById('desktopMirror');
    const cs = getComputedStyle(m);
    const pts = [[720, 450], [360, 450], [1250, 450], [720, 60], [100, 100]];
    return {
      computed: {
        position: cs.position, zIndex: cs.zIndex, opacity: cs.opacity,
        backgroundImage: cs.backgroundImage, pointerEvents: cs.pointerEvents,
        inset: [cs.top, cs.right, cs.bottom, cs.left].join(' ')
      },
      /* 每个采样点最上层是谁 —— 镜像层只要出现在这里就是压住了内容 */
      topAt: pts.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return { x, y, top: el ? (el.id || String(el.className).slice(0, 28) || el.tagName) : null };
      }),
      msgActs: [...document.querySelectorAll('.msg-acts')].map(a => {
        const s = getComputedStyle(a); const r = a.getBoundingClientRect();
        return { position: s.position, rect: [r.x, r.y, r.width, r.height].map(v => +v.toFixed(0)) };
      })
    };
  });

  /* ② 两条相对路径哪个真的能加载 */
  out.paths = await page.evaluate(async () => {
    const tryLoad = src => new Promise(res => {
      const im = new Image();
      im.onload = () => res({ src, ok: true, w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ src, ok: false });
      im.src = src;
    });
    return {
      /* 以 index.html 为基准 */
      fromHtml_assets: await tryLoad('assets/wallpaper.jpg'),
      fromHtml_up: await tryLoad('../assets/wallpaper.jpg'),
      /* 以 styles/ 为基准（CSS url() 的真实解析基准） */
      fromCss_assets: await tryLoad('styles/assets/wallpaper.jpg'),
      fromCss_up: await tryLoad('styles/../assets/wallpaper.jpg')
    };
  });

  /* ③ 令牌已由 W5 落地（--wp-url / --wp-visible:1），这里**不再覆盖** ——
     覆盖了就测的是"我以为的值"，不是真实交付态。只做一次存在性确认。 */
  await page.waitForTimeout(500);

  out.mirrorVisible = await page.evaluate(() => {
    const m = document.getElementById('desktopMirror');
    const cs = getComputedStyle(m);
    return {
      opacity: cs.opacity,
      backgroundImage: cs.backgroundImage.slice(0, 140),
      wpUrl: getComputedStyle(document.documentElement).getPropertyValue('--wp-url').trim(),
      wpVisible: getComputedStyle(document.documentElement).getPropertyValue('--wp-visible').trim()
    };
  });

  await page.screenshot({ path: join(QA, 'w1-mirror-light.png') });
  const lightImg = decodePng(readFileSync(join(QA, 'w1-mirror-light.png')));

  /* ④ 逐元素像素对比 */
  const rects = await page.evaluate(() => {
    const pick = sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      /* 文字节点包围盒（只框字形，不含内边距） */
      const tn = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
      const r = tn ? (() => { const g = document.createRange(); g.selectNodeContents(tn); return g.getBoundingClientRect(); })() : el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { sel, x: r.x, y: r.y, width: r.width, height: r.height, color: cs.color, fontSize: cs.fontSize };
    };
    return ['.panel-title', '#mainStage .msg-body', '#mainStage .msg-meta', '.msg-meta', '.stage-head-meta', '.mini-note', '.chat-welcome .panel-title']
      .map(pick).filter(Boolean);
  });
  out.pixel = rects.map(r => ({ ...r, m: rectContrast(lightImg, r) }));

  /* 中栏内「最暗的一小块**底**」：逐 8×8 块取中位数再取最小 ——
     直接用单像素最小值会被字形像素污染（字是画面上最暗的东西），
     块中位数才是"这一小片区域的底色"。 */
  out.darkestBed = await page.evaluate(() => {
    const b = document.getElementById('mainStage').getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }).then(rect => {
    let min = { l: 9, x: 0, y: 0 };
    const S = 8;
    for (let y = Math.floor(rect.y) + 2; y < rect.y + rect.height - S; y += S) {
      for (let x = Math.floor(rect.x) + 2; x < rect.x + rect.width - S; x += S) {
        const ls = [];
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
          const i = ((y + dy) * lightImg.w + (x + dx)) * 4;
          ls.push(lum(lightImg.rgba[i], lightImg.rgba[i + 1], lightImg.rgba[i + 2]));
        }
        ls.sort((a, b) => a - b);
        const med = ls[(ls.length - 1) >> 1];
        if (med < min.l) {
          const i = (y * lightImg.w + x) * 4;
          min = { l: +med.toFixed(4), x, y, rgb: [lightImg.rgba[i], lightImg.rgba[i + 1], lightImg.rgba[i + 2]] };
        }
      }
    }
    /* 最暗底上放深墨字 #141413（l = .00697）的对比 */
    const inkL = lum(20, 20, 19);
    return {
      ...min, stageRect: rect,
      inkContrastOnDarkestBed: +ratio(Math.max(min.l, inkL), Math.min(min.l, inkL)).toFixed(2)
    };
  });

  /* 暗档同样出图 */
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(QA, 'w1-mirror-dark.png') });

  out.pageErrors = errs;
} finally {
  await ctx.close();
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
writeFileSync(join(QA, 'w1-mirror.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
