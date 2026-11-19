/* smoke-r79.mjs · 换色 + 24h 光模型的冒烟探针
   打印 4 个时刻 × 明暗两档的关键计算值，任何 undefined / NaN / 空串都直接点名。 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r79-smoke-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

const KEYS = ['--sun-h', '--moon-h', '--moon-w', '--disp-a-h', '--disp-b-h', '--atmo-1-rgb',
  '--atmo-2-rgb', '--atmo-3-rgb', '--caustic-x', '--caustic-y', '--caustic-w', '--caustic-h',
  '--caustic-a', '--halo-r', '--halo-a', '--light-x', '--light-y', '--sun-exposure',
  '--atmo-1', '--atmo-2', '--atmo-3', '--color-accent', '--color-bg', '--color-text'];

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const h of [6, 12, 19, 23]) {
      const out = await page.evaluate(({ h, keys }) => {
        if (!window.__SunClock) return { miss: '__SunClock 不存在' };
        window.__SunClock.setHour(h);
        const cs = getComputedStyle(document.documentElement);
        const r = {};
        for (const k of keys) r[k] = cs.getPropertyValue(k).trim();
        return r;
      }, { h, keys: KEYS });
      const bad = Object.entries(out).filter(([, v]) => v === '' || /NaN|undefined/.test(v));
      console.log(`[${theme} ${String(h).padStart(2)}:00] ` + KEYS.slice(0, 12).map(k => `${k.slice(2)}=${out[k]}`).join(' '));
      console.log(`              ` + KEYS.slice(12).map(k => `${k.slice(2)}=${out[k]}`).join(' '));
      if (bad.length) console.log('   ⚠ 异常通道：' + JSON.stringify(bad));
    }
  }
  const anims = await page.evaluate(() => document.getAnimations ? document.getAnimations().length : 0);
  const bdf = await page.evaluate(() => ['glass-ribbon', 'glass-top', 'mainStage', 'observerWindow']
    .map(id => id + '=' + (getComputedStyle(document.querySelector('#' + id)).backdropFilter || 'none')));
  console.log(`getAnimations() = ${anims}（OPT-02 要求 0）`);
  console.log('backdrop-filter → ' + bdf.join(' | '));
  console.log(errs.length ? '⚠ 错误：' + JSON.stringify(errs) : '✓ 零 pageerror / 零 console error');
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
