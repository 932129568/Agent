/* ============================================================================
   shoot-r78c.mjs · R78c 目视验收截图（工程师自用，非 QA 结论）
   产出（全部 1440×900 视口，deviceScaleFactor=1，与实测口径一致）：
     qa/r78c-light-1440.png / qa/r78c-dark-1440.png   整屏
     qa/r78c-{light,dark}-stage-top.png               台面上沿（T3 亮带）1:1 裁切
     qa/r78c-{light,dark}-stage-edges.png             台面左右内缘（T2 色散）1:1 裁切
     qa/r78c-{light,dark}-stage-zoom.png              台面中段 2x（看液团边界）
   约束同其它脚本：playwright-core 取自 <工程根>/server/node_modules；
   profile 放 os.tmpdir() 并在 finally 递归删除（R71 教训）。
   ========================================================================== */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = join(DESIGN, 'index.html');
const QA = join(DESIGN, 'qa');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-shot-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

mkdirSync(QA, { recursive: true });

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const boxes = await page.evaluate(() => {
    const g = (id) => { const b = document.querySelector(id).getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { stage: g('#mainStage'), rail: g('#glass-top') };
  });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); window.scrollTo(0, 0); }, theme);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: join(QA, `r78c-${theme}-1440.png`), fullPage: false });
    /* 上沿：台面顶部 0..40px */
    await page.screenshot({
      path: join(QA, `r78c-${theme}-stage-top.png`),
      clip: { x: boxes.stage.x, y: boxes.stage.y, width: boxes.stage.w, height: 40 }
    });
    /* 左右内缘：各取 40px 宽的竖条，拼一屏看色散是否不对称 */
    const midY = boxes.stage.y + Math.round(boxes.stage.h / 2) - 80;
    await page.screenshot({
      path: join(QA, `r78c-${theme}-stage-edges.png`),
      clip: { x: boxes.stage.x, y: midY, width: 60, height: 160 }
    });
    await page.screenshot({
      path: join(QA, `r78c-${theme}-stage-edges-r.png`),
      clip: { x: boxes.stage.x + boxes.stage.w - 60, y: midY, width: 60, height: 160 }
    });
    console.log(`[shot] ${theme} 整屏 + 上沿 + 左右内缘 → qa/r78c-${theme}-*.png`);
  }
  console.log(errors.length ? `[shot] pageerror: ${JSON.stringify(errors)}` : '[shot] 零 pageerror');
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
