/* ============================================================================
   R78b · 目视验收截图（工程师自用，非 QA 结论）
   产出：qa/r78b-light-1440.png / qa/r78b-dark-1440.png（1440×900 整屏）
   约束：
     · playwright-core 在 <工程根>/server/node_modules（ESM 里用 createRequire 取）
     · 浏览器 profile 必须放 os.tmpdir()，finally 里递归删除
       （R71 教训：放工程目录会生成 600+ 缓存文件污染交付清单）
     · 系统 Edge，waitUntil 'domcontentloaded'
   ============================================================================ */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78b-shot-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

mkdirSync(QA, { recursive: true });

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  /* 等入场动画跑完 + 光学时钟稳定几次写字 */
  await page.waitForTimeout(1600);

  const shoot = async (theme, file) => {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      window.scrollTo(0, 0);
    }, theme);
    await page.waitForTimeout(1200);            /* 主题过渡 1.2s linear */
    await page.screenshot({ path: join(QA, file), fullPage: false });
    const meta = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      anims: document.getAnimations ? document.getAnimations().length : 0,
      bdf: ['glass-top', 'glass-ribbon', 'mainStage', 'observerWindow']
        .map(id => `${id}=${(getComputedStyle(document.querySelector('#' + id)).backdropFilter || 'none')}`),
      l1fill: getComputedStyle(document.querySelector('#glass-top')).backgroundColor
    }));
    console.log(`[shot] ${file} →`, JSON.stringify(meta));
  };

  await shoot('light', 'r78b-light-1440.png');
  await shoot('dark', 'r78b-dark-1440.png');

  /* 局部特写：L1 结构玻璃（左栏）上沿 + 侧壁，便于逐像素看亮带与色散边 */
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      window.scrollTo(0, 0);
    }, theme);
    await page.waitForTimeout(1200);
    const box = await page.evaluate(() => {
      const b = document.querySelector('#glass-top').getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    await page.screenshot({
      path: join(QA, `r78b-${theme}-l1-closeup.png`),
      clip: { x: box.x, y: box.y, width: box.w, height: 220 }
    });
    await page.screenshot({
      path: join(QA, `r78b-${theme}-l1-bottom.png`),
      clip: { x: box.x, y: box.y + box.h - 160, width: box.w, height: 160 }
    });
    console.log(`[shot] r78b-${theme}-l1-closeup.png + r78b-${theme}-l1-bottom.png ←`, JSON.stringify(box));
  }
  console.log('[shot] pageErrors =', JSON.stringify(errors));
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 清 profile 失败不阻塞 */ }
}
