/* R80 第一批 · 出图 + 结构审计（工程师自验，非 QA 结论）
   用法：node scripts/r80-audit.mjs
   产出：qa/r80-audit/b1-1440-light.png / b1-1440-dark.png + 控制台审计表 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const QA = join(DESIGN, 'qa', 'r80-audit');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r80-audit-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

mkdirSync(QA, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
});
try {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForTimeout(500);

  const audit = await page.evaluate(() => {
    const vis = n => n.offsetParent !== null || (getComputedStyle(n).position === 'fixed' && n.getClientRects().length > 0);
    const all = [...document.querySelectorAll('*')].filter(vis);
    const fs = {}, rad = {};
    const small11 = [], tiny = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      const f = cs.fontSize;
      fs[f] = (fs[f] || 0) + 1;
      if (parseFloat(f) <= 10) tiny.push({ tag: el.tagName, cls: String(el.className).slice(0, 30), f });
      if (parseFloat(f) === 11 && el.textContent.trim() && el.children.length === 0) {
        small11.push({ tag: el.tagName, cls: String(el.className).slice(0, 34) });
      }
      const r = cs.borderTopLeftRadius;
      if (r && r !== '0px') rad[r] = (rad[r] || 0) + 1;
      const r2 = cs.borderBottomRightRadius;
      if (r2 && r2 !== '0px' && r2 !== r) rad['(br)' + r2] = (rad['(br)' + r2] || 0) + 1;
    }
    const blur = all.filter(el => { const b = getComputedStyle(el).backdropFilter; return b && b !== 'none'; })
      .map(el => el.id || String(el.className).slice(0, 24));
    const bigShadow = all.filter(el => {
      const s = getComputedStyle(el).boxShadow;
      if (!s || s === 'none') return false;
      return /(\d{2,})px/.test(s) && Math.max(...(s.match(/(\d+)px/g) || ['0px']).map(v => parseInt(v))) >= 40;
    }).map(el => el.id || String(el.className).slice(0, 24));
    const layout = {};
    for (const id of ['glass-top', 'mainStage', 'observerWindow', 'glass-ribbon']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      layout[id] = { x: +r.x.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    }
    const gaps = (() => {
      const a = document.getElementById('glass-top').getBoundingClientRect();
      const b = document.getElementById('mainStage').getBoundingClientRect();
      const c = document.getElementById('observerWindow').getBoundingClientRect();
      return { rail2stage: +(b.x - (a.x + a.width)).toFixed(1), stage2obs: +(c.x - (b.x + b.width)).toFixed(1) };
    })();
    const msgKids = [...document.querySelectorAll('.msg')].slice(0, 6).map(m => ({
      cls: String(m.className).slice(0, 28),
      bdf: getComputedStyle(m).backdropFilter,
      kids: [...m.children].map(k => k.className || k.tagName).slice(0, 4)
    }));
    const opt = document.documentElement.getAttribute('data-optics');
    return {
      fontSizes: fs, radii: rad, tiny10: tiny, count11: small11.length, small11: small11.slice(0, 20),
      blur, bigShadow, layout, gaps, msgKids, optics: opt,
      themes: document.documentElement.getAttribute('data-theme')
    };
  });
  console.log(JSON.stringify(audit, null, 2));

  /* 入场动画必须落定再出图：.reveal 在 is-in 之前是 opacity 0~1 的过程态，
     截在中间会让整块台面读成被洗白，这不是材质问题而是时序问题。 */
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach(n => n.classList.add('is-in')));
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(QA, 'b1-1440-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(QA, 'b1-1440-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(400);
  console.log('errors:', errs.length ? errs : 'none');
} finally {
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
