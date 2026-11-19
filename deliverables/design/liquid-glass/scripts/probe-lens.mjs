/* R79 一阶段 · 位移能力探测的最小取证（非交付物）
   目的：确认 ①内联 SVG 滤镜被解析 ②位移图 href 落到 feImage ③canvas 像素探测能区分
        "url 被丢弃" 与 "url 生效" ④data-optics 的判定结果。
   用法：node scripts/probe-lens.mjs */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r79-lens-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
});
try {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForTimeout(600);

  const r = await page.evaluate(() => {
    const out = { optics: document.documentElement.dataset.optics || '(unset)' };
    out.report = window.__Optics ? window.__Optics.report() : null;
    const svg = document.querySelector('svg.optics-defs');
    out.svg = !!svg;
    const filter = document.getElementById('lg-lens');
    out.filter = filter ? filter.getAttribute('width') + '/' + filter.getAttribute('height') : '(none)';
    out.svgHasXmlns = svg ? svg.hasAttribute('xmlns') : null;
    /* 独立复算一遍像素：不经 OpticsLens，直接读 feImage 里那张图的中性核 */
    const img = document.getElementById('lg-lens-map');
    out.hrefLen = img ? (img.getAttribute('href') || '').length : -1;
    out.bdf = ['glass-top', 'glass-ribbon', 'mainStage', 'observerWindow'].map(id => {
      const el = document.getElementById(id);
      return id + '=' + (el ? getComputedStyle(el).backdropFilter : 'MISSING');
    });
    out.anim = document.getAnimations ? document.getAnimations().length : -1;
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  console.log('errors:', errs.length ? errs : 'none');

  /* 位移图取证：把 feImage 的 dataURL 抓出来，解 PNG，读中性核与环形带的通道值 */
  const mapProbe = await page.evaluate(async () => {
    const img = document.getElementById('lg-lens-map');
    const href = img ? img.getAttribute('href') || '' : '';
    if (!href) return { err: 'no href' };
    const im = new Image();
    im.src = href;
    await im.decode().catch(() => {});
    const c = document.createElement('canvas');
    c.width = im.naturalWidth || 256; c.height = im.naturalHeight || 256;
    const cx = c.getContext('2d');
    cx.drawImage(im, 0, 0);
    const px = (x, y) => Array.from(cx.getImageData(x, y, 1, 1).data);
    const N = c.width;
    return {
      size: N,
      center: px(N / 2, N / 2),
      r_0_30: px(Math.round(N / 2 + 0.30 * N / 2), N / 2),
      r_0_55: px(Math.round(N / 2 + 0.55 * N / 2), N / 2),
      r_0_70: px(Math.round(N / 2 + 0.70 * N / 2), N / 2),
      r_0_90: px(Math.round(N / 2 + 0.90 * N / 2), N / 2),
      r_0_99: px(N - 1, N / 2),
      corner: px(N - 1, N - 1),
      /* 中性核内"是否每个像素都恰好 128" —— 抽 5 圈 24 个点 */
      coreAll128: (() => {
        let bad = 0, n = 0;
        for (const rr of [0.05, 0.15, 0.30, 0.45, 0.60]) {
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            const x = Math.round(N / 2 + Math.cos(a) * rr * N / 2);
            const y = Math.round(N / 2 + Math.sin(a) * rr * N / 2);
            const d = px(x, y); n++;
            if (d[0] !== 128 || d[1] !== 128 || d[2] !== 0 || d[3] !== 255) bad++;
          }
        }
        return { bad, n };
      })()
    };
  });
  console.log('map:', JSON.stringify(mapProbe, null, 2));
} finally {
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
