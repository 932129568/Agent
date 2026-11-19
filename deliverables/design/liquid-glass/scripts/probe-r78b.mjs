/* ============================================================================
   R78b · 材质取证探针（工程师自查，非 QA 结论）
   目的：把「编排层声称已落地」的四件事逐条实测，避免只看代码下结论。
     ① .atmosphere::before 的液态三团是否真的被解析（calc 混算是否被丢弃）
     ② 四个结构 id 的实际 backdrop-filter blur 值（明 / 暗）
     ③ 色散双环 inset 1px 1px 0 -1px 是否真的产生可见像素差
     ④ rail-left 文字承载面合成对比度（LG-03 同口径）
   用法：node scripts/probe-r78b.mjs
   ============================================================================ */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78b-probe-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

const IDS = ['glass-top', 'glass-ribbon', 'mainStage', 'observerWindow'];

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const dump = await page.evaluate((IDS_) => {
    const out = {};
    const atmo = document.querySelector('.atmosphere');
    const cs = getComputedStyle(atmo, '::before');
    out.atmoBgImage = cs.backgroundImage;
    out.atmoOpacity = cs.opacity;
    out.atmoBgSlices = (cs.backgroundImage.match(/radial-gradient/g) || []).length;
    out.atmoHasLiquid = /rgba?\(\s*46,\s*214,\s*172|46, 214, 172|255, 158, 74|88, 146, 255/.test(cs.backgroundImage);
    out.lqA = getComputedStyle(atmo).getPropertyValue('--lq-a').trim();
    out.lqB = getComputedStyle(atmo).getPropertyValue('--lq-b').trim();
    out.liquid1 = getComputedStyle(atmo).getPropertyValue('--liquid-1').trim();
    out.liquid2 = getComputedStyle(atmo).getPropertyValue('--liquid-2').trim();
    out.liquid3 = getComputedStyle(atmo).getPropertyValue('--liquid-3').trim();
    out.l1fill = getComputedStyle(atmo).getPropertyValue('--lg-l1-fill').trim();
    out.sunExposure = getComputedStyle(atmo).getPropertyValue('--sun-exposure').trim();
    out.blur = {};
    out.bdf = {};
    out.bgImage = {};
    out.bgColor = {};
    out.boxShadow = {};
    IDS_.forEach((id) => {
      const el = document.querySelector('#' + id);
      if (!el) { out.blur[id] = 'MISSING'; return; }
      const s = getComputedStyle(el);
      const m = String(s.backdropFilter).match(/blur\(([\d.]+)px\)/);
      out.blur[id] = m ? +m[1] : 0;
      out.bdf[id] = s.backdropFilter;
      out.bgColor[id] = s.backgroundColor;
      out.bgImage[id] = String(s.backgroundImage).slice(0, 120);
      out.boxShadow[id] = String(s.boxShadow).slice(0, 400);
    });
    /* 色散环取证：分三处取像素差 —— 内侧 1px 左上角 / 内侧 1px 右下角 / 中心 */
    const rail = document.querySelector('#glass-top');
    const r = rail.getBoundingClientRect();
    out.railRect = { x: r.x, y: r.y, w: r.width, h: r.height };
    /* 对比度（LG-03 口径） */
    const parse = (s) => { const m = String(s).match(/[\d.]+/g); if (!m) return null; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
    const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const root = getComputedStyle(document.documentElement);
    const exp = parseFloat(root.getPropertyValue('--sun-exposure')) || 1;
    let base = parse(getComputedStyle(document.body).backgroundColor);
    if (!base || base[3] < 1) base = parse(getComputedStyle(document.documentElement).backgroundColor);
    out.base = base;
    out.exp = exp;
    const l1fill = parse(getComputedStyle(atmo).getPropertyValue('--lg-l1-fill'));
    const bed = base.map((v, i) => i < 3 ? v * exp : 1);
    const composed = l1fill ? over(l1fill, bed) : bed;
    out.composedBed = composed.map((v) => Math.round(v));
    return out;
  }, IDS);

  console.log('=== ① .atmosphere::before 液态层 ===');
  console.log('  radial-gradient 条数 :', dump.atmoBgSlices, '(期望 6 = 3 液态 + 3 环境)');
  console.log('  含液态色令牌      :', dump.atmoHasLiquid);
  console.log('  --lq-a / --lq-b   :', dump.lqA, '/', dump.lqB);
  console.log('  --liquid-1/2/3    :', dump.liquid1, '|', dump.liquid2, '|', dump.liquid3);
  console.log('  --lg-l1-fill      :', dump.l1fill);
  console.log('  ::before opacity  :', dump.atmoOpacity);
  console.log('  background-image  :', dump.atmoBgImage.slice(0, 900));

  console.log('\n=== ② 四个结构 id 的 blur（当前主题） ===');
  IDS.forEach((id) => console.log(`  ${id.padEnd(15)} blur=${dump.blur[id]}  bdf="${dump.bdf[id]}"`));
  console.log('\n  backgroundColor:');
  IDS.forEach((id) => console.log(`  ${id.padEnd(15)} ${dump.bgColor[id]}`));
  console.log('\n  boxShadow #glass-top:');
  console.log('  ', dump.boxShadow['glass-top']);

  console.log('\n=== ④ LG-03 口径底合成 ===');
  console.log('  body/base =', dump.base, ' × exp', dump.exp, ' → bed', dump.composedBed);

  /* 暗档复测 */
  await page.locator('#themeToggle').click();
  await page.waitForTimeout(900);
  const dark = await page.evaluate((IDS_) => {
    const out = { blur: {}, bdf: {}, bgColor: {}, atmoBgSlices: 0, atmoHasLiquid: false, theme: document.documentElement.getAttribute('data-theme') };
    const cs = getComputedStyle(document.querySelector('.atmosphere'), '::before');
    out.atmoBgSlices = (cs.backgroundImage.match(/radial-gradient/g) || []).length;
    out.atmoHasLiquid = /46, 214, 172|255, 158, 74|88, 146, 255|40, 220, 180|255, 150, 70|78, 132, 255/.test(cs.backgroundImage);
    IDS_.forEach((id) => {
      const el = document.querySelector('#' + id);
      if (!el) { out.blur[id] = 'MISSING'; return; }
      const s = getComputedStyle(el);
      const m = String(s.backdropFilter).match(/blur\(([\d.]+)px\)/);
      out.blur[id] = m ? +m[1] : 0;
      out.bdf[id] = s.backdropFilter;
      out.bgColor[id] = s.backgroundColor;
    });
    return out;
  }, IDS);
  console.log('\n=== ② 暗档 blur（theme=' + dark.theme + '） ===');
  IDS.forEach((id) => console.log(`  ${id.padEnd(15)} blur=${dark.blur[id]}  bdf="${dark.bdf[id]}"  bg=${dark.bgColor[id]}`));
  console.log('  液态层条数:', dark.atmoBgSlices, '含液态色:', dark.atmoHasLiquid);

  /* 截图（明暗），供像素级比对色散环与上沿亮带 */
  await page.locator('#themeToggle').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(DESIGN, 'qa', 'probe-light-full.png') });
  const rail = await page.locator('#glass-top').boundingBox();
  if (rail) {
    await page.screenshot({
      path: join(DESIGN, 'qa', 'probe-light-rail.png'),
      clip: { x: rail.x, y: rail.y, width: Math.min(rail.width, 260), height: Math.min(rail.height, 300) }
    });
    console.log('\n  rail box:', JSON.stringify(rail));
  }
  await page.locator('#themeToggle').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(DESIGN, 'qa', 'probe-dark-full.png') });
  if (rail) {
    await page.screenshot({
      path: join(DESIGN, 'qa', 'probe-dark-rail.png'),
      clip: { x: rail.x, y: rail.y, width: Math.min(rail.width, 260), height: Math.min(rail.height, 300) }
    });
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 清 profile 失败不阻塞 */ }
}
