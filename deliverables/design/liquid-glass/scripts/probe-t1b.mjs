/* probe-t1b.mjs · 卡片"吃掉 85% 落差"的层栈归因
   目的：elementsFromPoint 列出 (531,412) 处的完整绘制栈 + 每层的 background/阴影/伪元素，
   然后用"逐项关闭 → 取同一点 luma"的方式量化每一项吃掉了多少。 */
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
const PROFILE = mkdtempSync(join(tmpdir(), 'r78c-t1b-'));
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
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    prev = cur; off += 1 + stride;
  }
  return { w, h, data: out };
}
const at = (img, x, y) => {
  const d = (Math.round(y) * img.w + Math.round(x)) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2]];
};
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, args: ['--allow-file-access-from-files', '--force-color-profile=srgb']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(1200);

  const stack = await page.evaluate(() => {
    const els = document.elementsFromPoint(531, 412);
    return els.map((e) => {
      const cs = getComputedStyle(e);
      const pre = getComputedStyle(e, '::before'), post = getComputedStyle(e, '::after');
      return {
        tag: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''),
        bg: cs.backgroundColor, bgi: (cs.backgroundImage || 'none').slice(0, 90),
        op: cs.opacity, bf: cs.backdropFilter, mix: cs.mixBlendMode,
        shadow: cs.boxShadow.slice(0, 70),
        preBg: pre.content !== 'none' ? `${pre.backgroundColor} / op${pre.opacity}` : 'none',
        postBg: post.content !== 'none' ? `${post.backgroundColor} / bgi:${(post.backgroundImage || 'none').slice(0, 40)} / op${post.opacity}` : 'none'
      };
    });
  });
  console.log('=== (531,412) 绘制栈（上 → 下）===');
  for (const s of stack) {
    console.log(`· ${s.tag}\n    bg=${s.bg} op=${s.op} bf=${s.bf} mix=${s.mix}\n    bgi=${s.bgi}\n    shadow=${s.shadow}\n    ::before=${s.preBg}  ::after=${s.postBg}`);
  }

  const steps = [
    ['基线', ''],
    ['去掉 .msg 的 background-color', '.msg{background-color:transparent!important}'],
    ['再去掉 .msg 的 background-image', '.msg{background-image:none!important}'],
    ['再去掉 .msg 的 box-shadow', '.msg{box-shadow:none!important}'],
    ['清 ::after', '.msg::after{content:none!important}'],
    ['清 ::before', '.msg::before{content:none!important}'],
    ['清 .msg-body 及其子元素', '.msg-body,.msg-body *{background-color:transparent!important;background-image:none!important}']
  ];
  console.log('\n=== 逐项关闭后 (531,412) / (881,412) 两点 luma ===');
  for (const [label, css] of steps) {
    if (css) await page.addStyleTag({ content: css });
    await page.waitForTimeout(320);
    const img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const a = at(img, 531, 412), b = at(img, 881, 412);
    console.log(`· ${label.padEnd(30)} L6=${a.join('/')} Y=${luma(a).toFixed(0)}   L7=${b.join('/')} Y=${luma(b).toFixed(0)}`);
  }
} finally {
  if (ctx) await ctx.close().catch(() => {});
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
