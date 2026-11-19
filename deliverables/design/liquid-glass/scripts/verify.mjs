/* ============================================================================
   R72 · 「光井 / LIGHTWELL」—— scripts/verify.mjs（工程师自验脚本，非 QA 结论）
   用法：node deliverables/design/r72-glass/scripts/verify.mjs
   环境：playwright-core 复用 server/node_modules + 系统 Edge，launchPersistentContext。
   产出：qa/result.json + qa/01-dark-1440.png / 02-light-1440.png / 03-{375,768,1440}.png

   判据覆盖：DESIGN-SPEC.md §12.4 的 A01-A12 / B01-B08 / C01-C08 / D01-D04 /
            F01-F03，以及 R72-QA-FRAMEWORK.md 的 8 组通用判据（A1-A8）+ G-1~G-5。
   注意：浏览器 profile 必须放 os.tmpdir()（R71 教训：放工程目录一次验收生成
        600+ 缓存文件污染交付清单）；finally 中删除。
   ============================================================================ */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
/* 契约 §11 D14 / §12 D19：颜色与令牌解析只保留**一份实现**。
   本文件不再自己定义 toRgb/alphaOf/gradientStops/expandVars/overRgba —— 
   与 verify-optics.mjs 共用 scripts/lib/glass-color.mjs。
   （搬家纪律：语义一字未改；C03 的 17.33@68% / 14.39@0% / 4.14 必须原样复现。） */
import { toRgb, alphaOf, gradientStops, expandVars, overRgba } from './lib/glass-color.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const ROOT = resolve(HERE, '..', '..', '..', '..');   // r72-glass/scripts -> 工程根
const PAGE = join(DESIGN, 'index.html');
const QA = join(DESIGN, 'qa');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'r72-glass-edge-'));
const requireFromRoot = createRequire(pathToFileURL(join(ROOT, 'package.json')).href);
const { chromium } = requireFromRoot('./server/node_modules/playwright-core');

const VIEWS = ['chat', 'sessions', 'planning', 'generative', 'mcp', 'expert', 'memory', 'collaboration', 'settings'];
const RUNTIME = ['index.html', 'styles/base.css', 'styles/components.css', 'styles/views.css', 'scripts/main.js'];

mkdirSync(QA, { recursive: true });

const result = { checks: [], warnList: [], screenshots: [], pageErrors: [], consoleErrors: [], requests: [], summary: {} };
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
};
/* 预警（warn）：只打印 + 落盘，**不计入 PASS/FAIL、不影响 exitCode**。
   用途：某条判据还没越界、但余量已经薄到"下一侧输入动一点就破线"时，
   让它在塌之前先说话 —— 否则门禁会在窗口闭合的那一刻才第一次红。 */
const warn = (name, detail) => {
  result.warnList.push({ name, detail: String(detail) });
  console.log(`WARN ${name} — ${detail}`);
};

/* ---------------------------------------------------------------- 静态工具 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/^\s*\/\/.*$/gm, '');
}
function lum(c) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
function hueOf(c) {
  const [r, g, b] = c.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * (2 + (b - r) / d);
  else h = 60 * (4 + (r - g) / d);
  return (h + 360) % 360;
}
function varsOf(cssText, marker) {
  const i = cssText.indexOf(marker);
  if (i < 0) return {};
  const start = cssText.indexOf('{', i);
  /* R80 · 改成花括号配平（原来是 `indexOf('}')`）。
     tokens.css 的注释里合法地出现了 `{ ... }`（例如
     「暗色渐变透明度减半由 .atmosphere::before { opacity:.5 } 实现」），
     旧写法遇到它就**把整块截断**：不报错、不告警，只是静默少读一批令牌，
     下游断言拿 undefined 去算亮度，最后崩在 lum() 里。
     这是解析层缺陷修复，断言语义零变化。 */
  let depth = 0;
  let end = cssText.length - 1;
  for (let k = start; k < cssText.length; k++) {
    if (cssText[k] === '{') depth++;
    else if (cssText[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const body = cssText.slice(start + 1, end);
  const out = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2].trim();
  return out;
}

const tokensText = readFileSync(join(DESIGN, 'styles', 'tokens.css'), 'utf8');
const L = varsOf(tokensText, ':root {');
const D = varsOf(tokensText, '[data-theme="dark"] {');

/* ---------------------------------------------------------------------------
   R80 · 令牌别名展开（**解析层修复，不改任何断言与阈值**）
   R80 把语义令牌改成了别名形式：`--color-bg: var(--bg-canvas)`。
   原来的 toRgb() 只吃字面量，遇到 var() 直接返回 null —— 紧接着 ST-04 的
   ratio(null, …) 抛 TypeError，整轮验证在 110 条判据里的第 20 条前后**直接崩掉**，
   后面的判据形同不存在（与 settle() 静默挂死是同一类故障）。
   这里做一次就地展开：把 var(--x[, fallback]) 递归换成字面量。
   断言看到的仍然是"最终色值"，语义零变化 —— 变的只是"能不能读到"。
   --------------------------------------------------------------------------- */
const Lx = expandVars(L);
const Dx = expandVars(D);
const runtimeText = RUNTIME.map(f => readFileSync(join(DESIGN, f), 'utf8')).join('\n');
const runtimeCode = stripComments(runtimeText);

/* ---------------------------------------------------------------------------
   settle() —— 只加固「执行器」，不改任何断言语义（2026-11-12 R73 基线取证的
   实测缺陷修复）：
     原实现 `Promise.all(getAnimations().map(a => a.finished))` 对
     `animation-iteration-count: infinite` 的动画**永不 resolve**，而 settle()
     在主题切换后（QA-A2-2 之前）就被调用 —— 一旦页面上出现常驻循环动画，
     脚本会静默卡死在该调用点，后面上百条判据根本不会执行（判据形同不存在）。
   加固三件事（均不触碰断言）：
     ① `a.finished.catch(()=>{})` 吞掉被打断动画的 reject（原有行为保留）；
     ② `iterations === Infinity` 的动画**跳过等待**，登记进 infiniteAnimations[]；
     ③ 整体 1200ms 超时护栏，超时不抛错、继续往下跑，登记进 settleTimeouts[]。
   效果：由「静默挂死」变为「QA-A2-2 响亮地红 + 输出动画明细」——是加强不是放宽。
   --------------------------------------------------------------------------- */
const infiniteAnimations = [];   // settle 期间观测到的无限动画（供 QA-A2-2 输出）
const settleTimeouts = [];       // settle 等待超时的登记

async function settle(page, label = 'settle') {
  const report = await page.evaluate((capMs) => {
    const inf = [];
    const finite = [];
    const list = document.getAnimations ? document.getAnimations() : [];
    list.forEach(a => {
      let iterations = null;
      try {
        iterations = (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming().iterations : null;
      } catch (e) { iterations = null; }
      const tgt = a.effect && a.effect.target;
      if (iterations === Infinity) {
        inf.push({
          name: a.animationName || (a.transitionProperty ? 'transition:' + a.transitionProperty : '(unnamed)'),
          pseudo: (a.effect && a.effect.pseudoElement) || null,
          playState: a.playState,
          target: tgt ? (tgt.id || String(tgt.className || tgt.tagName).slice(0, 40)) : null,
          duration: (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming().duration : null
        });
        return;                        // 无限动画：不等待，但必须留痕
      }
      finite.push(a.finished.catch(() => {}));   // 被打断的过渡会 reject，吞掉
    });
    return Promise.race([
      Promise.all(finite).then(() => ({ outcome: 'all-settled', infinite: inf, finiteCount: finite.length })),
      new Promise(r => setTimeout(() => r({ outcome: 'timeout', infinite: inf, finiteCount: finite.length }), capMs))
    ]);
  }, 1200);

  if (report.infinite.length) {
    infiniteAnimations.push({ at: label, count: report.infinite.length, items: report.infinite });
  }
  if (report.outcome === 'timeout') {
    settleTimeouts.push({ at: label, finiteCount: report.finiteCount, waitedMs: 1200 });
  }
  await page.waitForTimeout(120);
  return report;
}

/* 页面内注入：有效背景色合成 + WCAG 复算（QA 框架 P1） */
async function realContrast(page) {
  return page.evaluate(() => {
    const parse = s => { const m = String(s).match(/[\d.]+/g); if (!m) return null; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
    const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const sels = ['h1', '.panel-title', '.mini-note', '.msg', '.status-chip', '.meta-chip', '.ribbon-readout .cost', '.zone-label', '.observer-row'];
    const out = [];
    sels.forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      const fg = parse(getComputedStyle(el).color);
      const layers = []; let n = el;
      while (n && n.nodeType === 1) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0) layers.push(c);
        if (c && c[3] === 1) break;
        n = n.parentElement;
      }
      let bg = [255, 255, 255, 1];
      for (const l of layers.reverse()) bg = over(l, bg);
      out.push({ sel, ratio: +ratio(fg, bg).toFixed(3), fg, bg: bg.slice(0, 3) });
    });
    return out;
  });
}

/* ---------------------------------------------------------------------------
   decodePng() / pixelContrast() —— T4 像素级正文对比度（R78c 新增）

   为什么必须在**像素**上再量一遍：ST-04 / C03 / LG-03 / QA-A2-3 四条读的都是
   computed style，再按自己的 over() 链把底色合成出来 —— 它们量的是"样式说应该长
   什么样"。本轮暴露的真实缺陷（`.stage .msg` 的所谓"1px 上沿亮线"，实际是
   从 1px 到 38px 线性衰减的一层 37px 白雾）在那四条里**全是绿的**：那层雾是
   background-image，四条判据一行都没读它。实测它把台面液团的中段极差从
   36.9/255 压到 6.6/255，也就是"液态玻璃在卡片底下等于没做"。
   ⇒ 背景侧必须取实测像素。前景侧仍取**单像素极值**（字芯），理由见下。

   估计量（逐条写清，避免"看着差不多"）：
     · 取样框 = 该文字块**可见文本节点**的 Range 包围盒（只框字形，不含内边距/描边）；
       「可见」按包围盒宽度挑而不是按文档序挑第一个 —— `.brand-name` 里第一个
       文本节点可能是 display:none 的分支，挑错节点会量到别的字号/颜色。
     · 背景 = 框内全部像素按 luma 排序的**中位数**（文字覆盖率 < 40%，中位数即底）。
     · 前景 = 底色偏亮取 p0（最暗像素）、偏暗取 p100（最亮像素）。
       为什么不用 p1/p5：抗锯齿只会把字芯往底色方向抬，**永远不会让它更极端**，
       所以 p0/p100 是"覆盖度最高的那个像素"，方向上永远**低估**对比度（保守）。
       实测 11px + letter-spacing 的标签，p1 相对规格色被抬亮 21~28 级（会把合规
       判成假红），而 p0 在 13px 以上的正文上与规格色偏差仅 +0~+4 级。
     · 比值 = WCAG 2.1 相对亮度比。

   覆盖边界（**明写在判据里，不靠事后解释**）：下列文字块因为 1x 下没有满覆盖像素
   （11~13px + 字距），p0 仍被抬亮 16~28 级，像素口径**无法**还原其规格色，
   故不纳入断言，只作为风险单列（数值每轮都会重新打印，不是永久豁免）：
     .zone-label / .observer-title / .nav-group / #resTabObserver / .msg-meta time /
     .nav-seg[aria-current="page"]。
   —— 这不是"挑能过的量"：这六个的**规格比**都在 4.65~5.7 之间（合规），
      失败的是像素估计量本身；把它们塞进断言等于制造假红。

   反例注入：把同一组选择器的 color 压成 rgba(60,74,68,.45)，必须出现 FAIL，
   否则本条恒真。
   --------------------------------------------------------------------------- */
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
const pxLuma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/* 单个文字块：框内像素 → 底/字两极值 → WCAG 比值 */
function pixelContrast(img, r) {
  const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(img.w - 1, Math.round(r.x + r.w));
  const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(img.h - 1, Math.round(r.y + r.h));
  const px = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = (y * img.w + x) * 4;
      px.push([img.data[d], img.data[d + 1], img.data[d + 2]]);
    }
  }
  if (px.length < 24) return null;                  /* 取样框太小 ⇒ 不给结论（外层判红） */
  px.sort((a, b) => pxLuma(a) - pxLuma(b));
  const bg = px[px.length >> 1];
  const fg = pxLuma(bg) > 128 ? px[0] : px[px.length - 1];
  return { bg, fg, ratio: +ratio(fg, bg).toFixed(2), n: px.length };
}

/* 暗档专用取样函数：给定一张图 + 一个框，返回 {床, 字, 比值}。
   · 床 = 该框中位数（调用方传入的**文字透明图**：框里只剩底）
   · 字 = **正常图**里离床更远的那个极值像素（不用 luma>128 猜方向 —— 暗档的床可以亮于 128
     而墨色更亮，旧法会猜反；实测 .msg-acts 条底 rgb(138,140,139)，旧法把阴影边当成字，量出 2.09）
   同时返回 legacy（旧方向法的比值）与 containRatio 由调用方另行计算，便于对照。 */
function pixelContrastFar(img, r) {
  const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(img.w - 1, Math.round(r.x + r.w));
  const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(img.h - 1, Math.round(r.y + r.h));
  const px = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = (y * img.w + x) * 4;
      px.push([img.data[d], img.data[d + 1], img.data[d + 2]]);
    }
  }
  if (px.length < 24) return null;
  px.sort((a, b) => pxLuma(a) - pxLuma(b));
  const bg = px[px.length >> 1];
  const lo = px[0], hi = px[px.length - 1];
  const bl = pxLuma(bg);
  const fg = Math.abs(pxLuma(lo) - bl) >= Math.abs(pxLuma(hi) - bl) ? lo : hi;
  return { bg, fg, lo, hi, ratio: +ratio(fg, bg).toFixed(2), legacy: +ratio(bl > 128 ? lo : hi, bg).toFixed(2), n: px.length };
}
/* 页面内取"文字块取样框"（只取几何，不取颜色 —— 颜色全部来自像素） */
async function textBoxes(page, blocks) {
  return page.evaluate((list) => {
    const out = [];
    for (const b of list) {
      const el = document.querySelector(b.sel);
      if (!el) { out.push({ sel: b.sel, miss: '元素不存在' }); continue; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) {
        out.push({ sel: b.sel, miss: '不可见' }); continue;
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let pick = null, pickW = -1;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.nodeValue || '').replace(/\s+/g, '').length < 2) continue;
        /* pick='first' 用文档序（品牌 h1 要的是"光井"而不是里面的 LIGHTWELL 副标）；
           其余用包围盒最宽的那个（避开隐藏分支与零宽节点）。 */
        if (b.pick === 'first') { pick = n; break; }
        const rg0 = document.createRange(); rg0.selectNodeContents(n);
        const w0 = rg0.getBoundingClientRect().width;
        if (w0 > pickW) { pickW = w0; pick = n; }
      }
      if (!pick) { out.push({ sel: b.sel, miss: '无可见文本节点' }); continue; }
      const rg = document.createRange(); rg.selectNodeContents(pick);
      const bb = rg.getBoundingClientRect();
      if (bb.width < 8 || bb.height < 6) {
        out.push({ sel: b.sel, miss: `取样框 ${Math.round(bb.width)}×${Math.round(bb.height)} 过小` }); continue;
      }
      out.push({
        sel: b.sel, label: b.label, x: bb.x, y: bb.y, w: bb.width, h: bb.height,
        fs: cs.fontSize, text: (pick.nodeValue || '').trim().slice(0, 14)
      });
    }
    return out;
  }, blocks);
}

/* 同一选择器的**全部实例**（暗档用）。
   为什么不能只取第一个：实测 `#mainStage .msg-meta` 有两条消息两个实例，
   第一条 5.32、第二条 **4.48** —— 只量 querySelector 的第一个就会把 4.48 漏掉，
   而这正是本轮要暴露的那条。返回顺序带 idx，日志里按 `选择器#序号` 标注。 */
async function textBoxesAll(page, blocks) {
  return page.evaluate((list) => {
    const out = [];
    for (const b of list) {
      const els = [...document.querySelectorAll(b.sel)];
      if (!els.length) { out.push({ sel: b.sel, label: b.label, idx: 0, miss: '元素不存在' }); continue; }
      els.forEach((el, idx) => {
        const cs = getComputedStyle(el);
        const chain = (() => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity; return +o.toFixed(3); })();
        if (cs.display === 'none' || cs.visibility === 'hidden' || chain === 0) {
          out.push({ sel: b.sel, label: b.label, idx, miss: `不可见（链上 opacity=${chain}）` }); return;
        }
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let pick = null, pickW = -1;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if ((n.nodeValue || '').replace(/\s+/g, '').length < 2) continue;
          if (b.pick === 'first') { pick = n; break; }
          const rg0 = document.createRange(); rg0.selectNodeContents(n);
          const w0 = rg0.getBoundingClientRect().width;
          if (w0 > pickW) { pickW = w0; pick = n; }
        }
        if (!pick) { out.push({ sel: b.sel, label: b.label, idx, miss: '无可见文本节点' }); return; }
        const rg = document.createRange(); rg.selectNodeContents(pick);
        const bb = rg.getBoundingClientRect();
        if (bb.width < 8 || bb.height < 6) {
          out.push({ sel: b.sel, label: b.label, idx, miss: `取样框 ${Math.round(bb.width)}×${Math.round(bb.height)} 过小` }); return;
        }
        out.push({
          sel: b.sel, label: b.label, idx, x: bb.x, y: bb.y, w: bb.width, h: bb.height,
          fs: cs.fontSize, color: cs.color, chain, text: (pick.nodeValue || '').trim().slice(0, 14)
        });
      });
    }
    return out;
  }, blocks);
}

/* 暗档 T4 的"次要文字"体检清单（`--text-muted-on-glass` 的消费点；`.msg-act` 是 hover-only，
   单列在 T4-D4，不混进常态组）。
   为什么另立一张表而不并进 T4_BLOCKS：
     · 这些点的**床跨 4 倍**（从 .nav-group 的玻璃 L≈.05 到 .eyebrow 的 L≈.127），
       单靠任一块反推墨色都必然在另一块上过曝 —— 令牌债的账在这里才看得见；
     · 它们不是"再来 8 块正文"，而是一张**同类过曝的体检表**：比值 + 床 L 一起打印。
   ── 移除了 `#mainStage .tok`：全页唯一 .tok 实例是成本区 `#tokenValue`（可见，67×13），
      但它的宿主 `#costZone < #glass-ribbon` **不在 #mainStage 内** ⇒ views.css:2000 的
      `#mainStage .tok{color:var(--text-muted-on-glass)}` 是**空转规则**，它并不消费这个令牌。
      把一条"规则永不生效"的条目放进消费者组，等于一条永远通过的假判据。
      它自身实测 2.81（暗档、去字床）属于**另一条**缺陷（成本区次要读数），
      本门禁只作观察项打印（见 result.t4dTokObservation），不参与判定。 */
const T4D_MUTED = [
  { sel: '#mainStage .attach-chip', label: '附件芯片' },
  { sel: '#mainStage time', label: '时间戳' },
  { sel: '#mainStage .msg-meta', label: '消息元信息' },
  { sel: '#mainStage .msg-meta *', label: '元信息子节点' },
  { sel: '.panel-sub', label: '台面副标题' },
  { sel: '#glass-top .nav-group', label: '导航分组' },
  { sel: '.stage-head .eyebrow', label: '台面眉标' }
];
/* WCAG 2.1 AAA 阈值，只作**参考线**打印。真正的上限是"同轮实测的主文字 +0.3 噪声带"，
   理由见 T4-D3 的注释（7.0 是旧主文字 7.05 的代理值，已随床口径过期）。 */
const T4D_CAP = 7.0;

/* T4 的固定取样清单（nav 文字 / 台面正文段 / 右栏读数，13 块 ≥ 要求的 9 块） */
const T4_BLOCKS = [
  { sel: 'h1.brand-name', pick: 'first', label: '品牌' },
  { sel: '.nav-seg[data-view="sessions"]', label: '导航文字' },
  { sel: '.panel-title', label: '台面标题' },
  { sel: '.panel-sub', label: '台面副标题' },
  { sel: '.eyebrow', label: '台面眉标' },
  { sel: '.welcome-line', label: '台面正文段' },
  { sel: '.mini-note', label: '台面注释' },
  { sel: '.msg', label: '消息正文' },
  { sel: '.observer-row .data', label: '右栏读数' },
  { sel: '.observer-row > span:first-child', label: '右栏标签' },
  { sel: '.ribbon-readout .cost', label: '成本读数' },
  { sel: '.ctx-chip', label: '上下文读数' },
  { sel: '.rail-ver', label: '版本读数' }
];

/* ---------------------------------------------------------------------------
   glassSnapshot() —— 液态玻璃三层结构取证（LG-01 / LG-02 的数据面）

   背景（为什么不是 R73 的「同屏 <= 2 个 blur」）：R73 的稿子只有两块玻璃壳，
   内容是实心台面，所以"blur 元素 <= 2"是那个方向的硬纪律。液态玻璃相反 ——
   台面本身也要透，于是 L2 必须也有 blur，纪律从"数量"变成"**层级**"：
     · 恰好 4 个结构面（L1a 顶栏 / L1b 光带 / C 栏台面 / R 栏台面）；
     · blur 严格分档（L1 一档、L2 一档），L3 卡片一律 0；
     · 任何带 blur 的元素都不得有带 blur 的祖先（玻璃不嵌套）。
   这三条一起才等价于旧判据要保护的东西（别把整页糊成毛玻璃 + 文字别发灰），
   而且比数个数更难糊弄 —— 少一层、多一层、档位颠倒、嵌套，任一条都红。
   --------------------------------------------------------------------------- */
async function glassSnapshot(page) {
  return page.evaluate(() => {
    const vis = n => n.offsetParent !== null || (getComputedStyle(n).position === 'fixed' && n.getClientRects().length > 0);
    const blurPx = v => { const m = String(v).match(/blur\(([\d.]+)px\)/); return m ? +m[1] : 0; };
    const blurred = el => { const b = getComputedStyle(el).backdropFilter; return !!b && b !== 'none'; };
    const items = [...document.querySelectorAll('*')].filter(vis).filter(blurred)
      .map(el => ({ id: el.id || '', cls: String(el.className).slice(0, 30), bdf: getComputedStyle(el).backdropFilter }));
    const tiers = {}, bdfs = {}, bgs = {};
    ['glass-top', 'mainStage', 'observerWindow', 'glass-ribbon'].forEach(id => {
      const el = document.querySelector('#' + id);
      tiers[id] = el ? blurPx(getComputedStyle(el).backdropFilter) : -1;
      bdfs[id] = el ? (getComputedStyle(el).backdropFilter || 'none') : 'MISSING';
      bgs[id] = el ? getComputedStyle(el).backgroundColor : 'MISSING';
    });
    /* 嵌套口径（R80-R2 补充）：不只看"有没有嵌套对"，还要求任一条祖先链上
       带 blur 的元素数 ≤1 —— 后者对"同一元素身上叠两层 backdrop-filter"这种
       写法也有效（CSS 里后者覆盖前者，但只覆盖 filter 不等于不嵌套）。 */
    let maxChain = 0;
    [...document.querySelectorAll('*')].forEach(el => {
      let n = 0, p = el;
      while (p) { if (blurred(p)) n++; p = p.parentElement; }
      if (n > maxChain) maxChain = n;
    });
    /* 位移类滤镜白名单取证（LG-02 新增维度）：只允许出现在 #glass-top::before。
       "位移类"= 会搬动像素的滤镜函数：blur / drop-shadow / url(#…)。
       一次性贴在所有玻璃面上，等于每个面都自带一层糊 —— 正是液态玻璃最容易翻车的地方。 */
    const DISP_RE = /(blur\(|drop-shadow\(|url\()/;
    const disp = [];
    document.querySelectorAll('#glass-top,#glass-ribbon,.glass,#mainStage,.stage,#observerWindow,.rail-left,.cost-dock,#desktopMirror')
      .forEach(el => {
        [null, '::before', '::after'].forEach(p => {
          const f = getComputedStyle(el, p).filter;
          if (f && f !== 'none' && DISP_RE.test(f)) {
            disp.push({ at: (el.id || String(el.className).split(' ')[0]) + (p || ''), filter: f });
          }
        });
      });
    const STRUCT = ['glass-top', 'mainStage', 'observerWindow', 'glass-ribbon'];
    const cards = ['.msg', '.composer', '.chat-welcome', '.tool-step-rail', '.slab', '.enamel']
      .flatMap(s => [...document.querySelectorAll(s)]).filter(vis)
      .filter(el => !STRUCT.includes(el.id))
      .map(el => ({ cls: String(el.className).slice(0, 26), bdf: getComputedStyle(el).backdropFilter || 'none' }));
    const nested = [...document.querySelectorAll('*')].filter(blurred).filter(el => {
      let p = el.parentElement;
      while (p) { if (blurred(p)) return true; p = p.parentElement; }
      return false;
    }).map(el => el.id || String(el.className).slice(0, 24));
    /* 浮层不在"可见"里筛：抽屉/表默认 display:none，但关闭态也必须是零 blur —— 否则
       打开的一瞬间会先糊一下再清晰。这里读的是计算样式，不看可见性。 */
    const overlays = [...document.querySelectorAll('.overlay')].map(n => getComputedStyle(n).backdropFilter || 'none');
    return { count: items.length, ids: items.map(x => x.id || x.cls), tiers, bdfs, bgs, cards, nested, overlays, maxChain, disp, list: items };
  });
}

/* ---------------------------------------------------------------------------
   bedContrast() —— 文字承载面合成对比度（LG-03）
   与 realContrast 的区别：底不再是纯白，而是「页面底色 × 当前日照强度」。
   为什么要乘 --sun-exposure：夜里背景被压到 0.56，玻璃填充没变，正文的实际
   合成底色确实变暗了。不乘就会在夜间高估对比度 —— 这正是"光照系统"带来的
   新风险，判据必须跟着覆盖它（保守取值 = 按最暗算）。
   --------------------------------------------------------------------------- */
async function bedContrast(page) {
  return page.evaluate(() => {
    const parse = s => { const m = String(s).match(/[\d.]+/g); if (!m) return null; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
    const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const root = getComputedStyle(document.documentElement);
    const exp = parseFloat(root.getPropertyValue('--sun-exposure')) || 1;
    let base = parse(getComputedStyle(document.body).backgroundColor);
    if (!base || base[3] < 1) base = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (!base || base[3] < 1) base = [237, 242, 238, 1];
    base = [base[0] * exp, base[1] * exp, base[2] * exp, 1];
    const sels = ['h1', '.panel-title', '.mini-note', '.msg', '.status-chip', '.meta-chip',
      '.ribbon-readout .cost', '.zone-label', '.observer-row', '.nav-seg', '.brand-name', '.nav-group'];
    const out = [];
    sels.forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      const fg = parse(getComputedStyle(el).color);
      const layers = []; let n = el;
      while (n && n.nodeType === 1) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0) layers.push(c);
        if (c && c[3] === 1) break;
        n = n.parentElement;
      }
      let bg = base;
      for (const l of layers.reverse()) bg = over(l, bg);
      out.push({ sel, ratio: +ratio(fg, bg).toFixed(2) });
    });
    return { exp, out };
  });
}

/* 可见交互目标 >= 44x44（含 position:fixed 保护，QA 框架 P4） */
async function smallTargets(page) {
  return page.evaluate(() => {
    const isVisible = n => {
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (n.offsetParent === null) return cs.position === 'fixed' && n.getClientRects().length > 0;
      return true;
    };
    return [...document.querySelectorAll('button, a[href], input, select, [role="button"]')]
      .filter(isVisible)
      .map(n => { const r = n.getBoundingClientRect(); return { tag: n.tagName, id: n.id, cls: String(n.className).slice(0, 30), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })
      .filter(x => x.w < 44 || x.h < 44);
  });
}

/* 浮层与关键内容矩形相交（QA 框架 P10）。
   修正（不放宽）：关键内容的 rect 必须先裁剪到最近的 overflow 滚动祖先，
   否则「舞台内被裁剪掉的大容器」会被算成覆盖整个视口，产生假相交。 */
async function overlayHits(page) {
  return page.evaluate(() => {
    const vis = n => { const cs = getComputedStyle(n); return cs.display !== 'none' && cs.visibility !== 'hidden' && n.getClientRects().length > 0; };
    const clip = (n, r0) => {
      let r = { left: r0.left, right: r0.right, top: r0.top, bottom: r0.bottom }, p = n.parentElement;
      while (p) {
        const cs = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(cs.overflowY + ' ' + cs.overflowX)) {
          const pr = p.getBoundingClientRect();
          r = {
            left: Math.max(r.left, pr.left), right: Math.min(r.right, pr.right),
            top: Math.max(r.top, pr.top), bottom: Math.min(r.bottom, pr.bottom)
          };
        }
        p = p.parentElement;
      }
      return r;
    };
    const R = sel => [...document.querySelectorAll(sel)].filter(vis)
      .map(n => ({ n, r: clip(n, n.getBoundingClientRect()), z: +getComputedStyle(n).zIndex || 0 }));
    const ov = R('.overlay'), key = R('[data-key-content]');
    const hits = [];
    for (const o of ov) for (const k of key) {
      const w = Math.min(o.r.right, k.r.right) - Math.max(o.r.left, k.r.left);
      const h = Math.min(o.r.bottom, k.r.bottom) - Math.max(o.r.top, k.r.top);
      if (w > 0 && h > 0 && o.z >= k.z) hits.push({ o: String(o.n.className), k: String(k.n.className), area: +(w * h).toFixed(1) });
    }
    return hits;
  });
}

/* =========================================================================
   静态判据（不依赖浏览器）
   ========================================================================= */
const hardColor = /(#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\()/g;
const hardHits = runtimeCode.match(hardColor) || [];
check('B07 运行时文件零硬编码色值（剥离注释后）', hardHits.length === 0,
  `命中 ${hardHits.length} 处 ${JSON.stringify(hardHits.slice(0, 6))}`);
check('F02 零 @import / @font-face / 外链字面量',
  !/@import|@font-face|https?:\/\//.test(runtimeCode), `${RUNTIME.length} 个运行时文件静态扫描`);
/* ↑ 曾经硬写"6 个"，而 RUNTIME 实际只有 5 项（tokens.css 不在扫描范围）。
   这类"注释/文案里的数"过期不是无害的：B07 的豁免边界正好靠它说明 ——
   读的人会以为 tokens.css 也被扫了，从而不敢把色值放进令牌（或反过来乱放）。 */

/* ---------------------------------------------------------------------------
   CSS-COMMENT 注释体配对（R80-R2 新增，来源是一次真实事故）
   ---------------------------------------------------------------------------
   事故：改 views.css 时插入一段说明文字，漏了块注释的开启符，那段说明就落在
   注释之外。CSS 解析器的错误恢复会把它连同后面那条 #desktopMirror 规则
   **一起丢弃** —— 不报错、控制台零输出、DevTools 的 Styles 面板里那条规则
   直接不存在。120 条判据此时全绿，因为没有任何一条在检查「规则有没有被
   解析出来」。

   这类静默失效在本项目已是第五次：闭合符提前终止注释、注释里的花括号把
   varsOf 的令牌块截断、注释里的假声明吃掉下一行真声明、CSS 变量超 2^21
   让 setProperty 静默失败、URL 相对基准算错导致静默 404。

   判据：对每个 CSS 文件做线性扫描，模拟解析器的注释状态机。
     · 非注释态遇到闭合符 → 孤立闭合，判红（多余的那个会提前结束上一条注释，
       其后的文字全部变成选择器垃圾）
     · 注释态遇到开启符 → 嵌套开，判红（CSS 注释不可嵌套，内层开启符无效，
       但内层的闭合符会提前闭合外层）
     · 扫完仍处于注释态 → 未闭合，判红（文件尾部整段被吞）
   区分力自证：临时注入一段孤立闭合符文本，扫描器必须报红。
   注意本段注释自身不得出现那两个字面量 —— 第一次写的时候就踩了。 */
const cssFiles = ['tokens.css', 'base.css', 'components.css', 'views.css'];
const OPEN = '/'.concat('*'), CLOSE = '*'.concat('/');
const commentScan = (src) => {
  const errs = [];
  let i = 0, inComment = false, line = 1;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '\n') line++;
    if (!inComment && two === OPEN) { inComment = true; i += 2; continue; }
    if (inComment && two === CLOSE) { inComment = false; i += 2; continue; }
    if (inComment && two === OPEN) { errs.push({ kind: 'nested-open', line }); i += 2; continue; }
    if (!inComment && two === CLOSE) { errs.push({ kind: 'orphan-close', line }); i += 2; continue; }
    i++;
  }
  if (inComment) errs.push({ kind: 'unclosed', line });
  return errs;
};
const commentErrs = [];
for (const f of cssFiles) {
  const src = readFileSync(join(DESIGN, 'styles', f), 'utf8');
  for (const e of commentScan(src)) commentErrs.push({ file: f, ...e });
}
check('CSS-COMMENT 四个样式表注释体配对（孤立闭合 / 嵌套开 / 未闭合 三类必红）',
  commentErrs.length === 0,
  commentErrs.length === 0
    ? `${cssFiles.length} 个文件线性扫描零异常`
    : JSON.stringify(commentErrs.slice(0, 6)));
const ccBad = commentScan('a{color:red}\n' + CLOSE + '\nb{color:blue}');
const ccGood = commentScan('/' + '* ok ' + CLOSE + ' a{color:red}');
check('CSS-COMMENT 扫描器区分力自证（注入孤立闭合符必须报红）',
  ccBad.length > 0 && ccGood.length === 0,
  `注入孤立闭合符命中 ${ccBad.length} 处 · 正常注释块 ${ccGood.length} 处`);
check('ST-03 明暗两套语义令牌齐备',
  Object.keys(L).length >= 60 && Object.keys(D).length >= 28,
  `明 ${Object.keys(L).length} / 暗 ${Object.keys(D).length} 个变量`);
check('B06 @supports 能力降级规则存在', /@supports not \(\(backdrop-filter/.test(tokensText), 'tokens.css');
check('E06 浏览器 profile 位于系统临时目录', PROFILE.startsWith(tmpdir()), PROFILE);

/* §12.5（规格 09:07 追加的 QA 钩子绑定表）锚点齐备性自检：
   以增量类名方式对齐，不改变任何既有结构与样式行为。 */
const htmlText = readFileSync(join(DESIGN, 'index.html'), 'utf8');
const bindAnchors = ['stage-plate', 'cost-ribbon', 'tool-chain-track', 'cost-lightband',
  'audit-readouts', 'observatory', 'stage-glyph', 'totals-bar', 'status-dot',
  'btn', 'popover', 'drawer', 'tool-step-rail', 'code-slab', 'chart-slab',
  'field-grid', 'set-nav', 'save-bar', 'clearance-switch', 'session-row',
  /* R72-L 追加 5 项：三栏壳的承载类 */
  'rail-left', 'stage-scroll', 'res-tabs', 'stage-fade', 'rail-foot'];
const missingAnchors = bindAnchors.filter(a => !new RegExp('class="[^"]*\\b' + a + '\\b').test(htmlText));
check('§12.5 QA 绑定表锚点齐备（25 项 = 20 原有 + 5 新增，纯增量类名）', missingAnchors.length === 0,
  missingAnchors.length ? `缺失 ${JSON.stringify(missingAnchors)}` : '25/25 命中');

/* LAY-01..12 的锚点自检工具：先在源文件里找锚点字符串，
   找不到就把该判据判为 FAIL（杜绝「注入没生效却报 PASS」）。 */
const anchorOk = (file, needle) => {
  try { return readFileSync(join(DESIGN, file), 'utf8').includes(needle); }
  catch (e) { return false; }
};

/* §8.2 与 QA A8-1 对齐：全站恰好 5 个 delay 值，禁止组内二次 delay。
   降级规则里的 `0s !important` 是「关停」而非编排 delay，单独排除并留痕。 */
const delayTokens = (tokensText.match(/--s\d+\s*:/g) || []).map(s => s.trim().replace(':', ''));
const delayVals = (tokensText.match(/--s\d+\s*:\s*(\d+)ms/g) || []).map(s => +s.match(/(\d+)ms/)[1]);
check('§8.2 全站 delay 令牌恰好 5 个且值 = [0,90,180,270,360]ms',
  delayTokens.length === 5 && JSON.stringify(delayVals) === JSON.stringify([0, 90, 180, 270, 360]),
  `${JSON.stringify(delayTokens)} → ${JSON.stringify(delayVals)}ms`);
const cssForDelay = ['base.css', 'components.css', 'views.css']
  .map(f => readFileSync(join(DESIGN, 'styles', f), 'utf8')).join('\n');
const extraDelays = (cssForDelay.match(/transition-delay\s*:\s*[^;]+;/g) || [])
  .filter(d => !/var\(--s[1-5]\)/.test(d) && !/0s\s*!important/.test(d));
check('§8.2 组件 CSS 无 --s1..--s5 之外的编排 delay（无二次错峰）',
  extraDelays.length === 0, extraDelays.length ? JSON.stringify(extraDelays) : '额外 delay = 0');

const atmo = ['atmo-1', 'atmo-2', 'atmo-3'].map(k => ({ k, rgb: toRgb(Lx[k]), h: +hueOf(toRgb(Lx[k])).toFixed(1) }));
check('B08 氛围渐变色相零紫 / 蓝 / 蓝紫（200-320°）',
  atmo.every(a => !(a.h >= 200 && a.h <= 320)), JSON.stringify(atmo));

const fgNames = ['color-text', 'color-muted', 'color-faint', 'color-accent'];
const bgNames = ['color-surface', 'color-raised', 'color-bg', 'color-code-bg'];
for (const [label, V] of [['明', Lx], ['暗', Dx]]) {
  const fails = []; let min = 99;
  fgNames.forEach(f => bgNames.forEach(b => {
    const r = ratio(toRgb(V[f]), toRgb(V[b]));
    min = Math.min(min, r);
    if (r < 4.5) fails.push(`${f}/${b}=${r.toFixed(2)}`);
  }));
  const cb = ['color-surface', 'color-raised', 'color-code-bg'].map(b => +ratio(toRgb(V['color-control-border']), toRgb(V[b])).toFixed(2));
  cb.forEach((r, i) => { if (r < 3) fails.push(`control-border/${i}=${r}`); });
  const ai = ratio(toRgb(V['color-accent-ink']), toRgb(V['color-accent']));
  const fo = ratio(toRgb(V['color-accent']), toRgb(V['color-bg']));
  if (ai < 4.5) fails.push(`accent-ink/accent=${ai.toFixed(2)}`);
  if (fo < 3) fails.push(`focus/bg=${fo.toFixed(2)}`);
  check(`ST-04 ${label}色令牌对比度全矩阵（WCAG 2.1 复算）`, fails.length === 0,
    `正文最低 ${min.toFixed(2)}:1；control-border ${cb.join('/')}；accent-ink/accent ${ai.toFixed(2)}；focus/bg ${fo.toFixed(2)}`);
}
/* ---------------------------------------------------------------------------
   ST-05 明暗两档同名令牌的"双副本同步"（R80-R2 新增，主理人要求）
   ---------------------------------------------------------------------------
   病：tokens.css 里同一个令牌在 :root 与 [data-theme="dark"] 各出现一次
   （例如 --glass-l2-sat 在 724 / 1087 两行）。只改明档、漏改暗档时，
   页面在亮色下完全正常 —— 而 grep 首个命中会误导复核的人以为改过了。
   这里把新令牌分成两族，各自钉一个方向：
     · 主题无关族（结构属性）：两档**必须逐字相等**
     · 主题相关族（环境光相关）：两档**必须不同**

   ★ R81-R2 重分类（主理人裁决，2026-11-14）—— 理由是"判据不该反向指挥物理值"：
     ① `glass-l1-blur` 从 DIFF **移到 SAME**。blur 是"这一层有多厚"这个**结构属性**，
        与明暗无关。原来塞进 DIFF，结果是为了过判据必须给暗档硬编一个 18px/22px ——
        这正是契约反复禁止的"为判据改设计"。
     ② 新增 `glass-rail-blur`（右栏 22px）进 SAME，同一条理由。
     ③ `glass-l1-sat` / `glass-l2-sat` 留在 SAME，并把**暗档的值改回与明档一致**
        （1.85 / 1.70）。sat 是"把壁纸的绿压掉多少"，跟明暗无关；
        原来暗档写 1.95 / 1.85 属真漂移，不是设计。
     ④ DIFF 补进四个**真正随环境光变**的：`glass-l1-bright` / `glass-l2-bright` /
        `glass-l1-contrast` / `glass-l2-contrast`（明 1.10·1.12·.92·.90 /
        暗 0.74·0.68·.96·.94）—— 这些才是"光变了所以反射量变了"。
     维度总数不减：DIFF 移走 1 条、补进 4 条（7 → 10）；SAME 增 2 条（12 → 14）。

   区分力自证（在同一行 check 内做，不新增判据）：把暗档 `--glass-l2-fill`
   替换成明档的值，DIFF 比较必须立刻报"应不同却同值"。没有这一步，
   本条就只是把同一份数据比两遍（恒真）。
   --------------------------------------------------------------------------- */
const TWIN_SAME = ['glass-l1-sat', 'glass-l2-sat', 'glass-l1-blur', 'glass-l2-blur', 'glass-rail-blur',
  'layout-gutter', 'layout-inset', 'wp-url', 'wp-visible', 'wp-x', 'wp-y', 'wp-size',
  'wp-sat', 'wp-lift'];
const TWIN_DIFF = ['glass-l1-fill', 'glass-l2-fill', 'glass-msg-fill',
  'glass-msg-edge', 'text-on-glass', 'text-muted-on-glass',
  'glass-l1-bright', 'glass-l2-bright', 'glass-l1-contrast', 'glass-l2-contrast'];
const twinBad = [
  ...TWIN_SAME.filter(k => L[k] !== D[k]).map(k => `应同值却不同 ${k}: 明=${L[k]} 暗=${D[k]}`),
  ...TWIN_DIFF.filter(k => L[k] === D[k]).map(k => `应不同却同值 ${k}=${L[k]}（暗档疑似漏改）`)
];
/* 区分力自证：暗档 --glass-l2-fill 抄成明档的值 → 必须被 DIFF 抓到 */
const Ddrift = { ...D, 'glass-l2-fill': L['glass-l2-fill'] };
const twinBadInjected = TWIN_DIFF.filter(k => L[k] === Ddrift[k])
  .map(k => `应不同却同值 ${k}=${L[k]}`);
check('ST-05 新令牌明暗双副本同步（主题无关族同值 · 主题相关族不同值）',
  twinBad.length === 0
  && TWIN_SAME.every(k => L[k] !== undefined) && TWIN_DIFF.every(k => D[k] !== undefined)
  && twinBadInjected.length >= 1,
  (twinBad.length ? twinBad.slice(0, 4).join(' ｜ ') + ' ｜ ' : '')
  + `同值 ${TWIN_SAME.length} 条 · 不同 ${TWIN_DIFF.length} 条`
  + `（blur 三档 明 = ${L['glass-l1-blur']}/${L['glass-rail-blur']}/${L['glass-l2-blur']}，`
  + `暗 = ${D['glass-l1-blur']}/${D['glass-rail-blur']}/${D['glass-l2-blur']}）`
  + `；区分力自证：暗档 l2-fill 抄成明档后失配 ${twinBadInjected.length} 条（需 ≥1）`);

/* ---------------------------------------------------------------------------
   ST-06 fallback 字面量不得与令牌值打架（R80-R2 新增，W3 提出）
   ---------------------------------------------------------------------------
   病：W1 写的是 `filter: saturate(var(--wp-sat, 0.55)) brightness(var(--wp-lift, 1.08))`，
   而令牌一度**没有定义** —— 规格值只活在 fallback 字面量里。此时：
     · 谁只改 tokens.css（令牌不存在）→ 改动静默不生效，fallback 赢；
     · 谁把令牌定义成另一个值 → 出现"写了两个值、生效第三个"，判据翻红的原因是
       "规格值不统一"而不是"玻璃做错了"。
   判据：凡是 `var(--x, 字面量)` 这种带 fallback 的写法，若同名令牌在 tokens.css
   有定义，则 fallback 字面量必须与令牌值**数值相等**（±0.02）；不等就红。
   只查数值型 fallback（纯数字），颜色/字符串型不参与 —— 那些的"相等"没有统一口径。

   ⚠ **fail-safe 白名单**（不是放宽，是分清两种"不相等"）：
     `--wp-visible` 的 fallback 是 0、令牌是 1 —— 语义是"令牌丢了我就不显示"，
     这是**刻意的安全降级**（读不到可见性开关时宁可隐形，不要糊一张黑图）。
     它与 `--wp-sat` 那种"规格值被抄成两份"是两件事：后者的 fallback 就是设计值本身，
     两边不一致意味着"改了不生效 / 生效的是第三个"。所以白名单只放真正
     表达"缺省即降级"的令牌，且必须在注释里点名理由。
   区分力自证：把 --wp-sat 的 fallback 临时改成 .9，本条必须翻红。 */
const FAILSAFE_FB = ['wp-visible'];   /* 缺省即降级：0 = 不显示，与令牌 1 不同是对的 */
const fallbackHits = [];
for (const f of ['base.css', 'components.css', 'views.css']) {
  const txt = readFileSync(join(DESIGN, 'styles', f), 'utf8');
  const re = /var\(\s*--([\w-]+)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g;
  let m;
  while ((m = re.exec(txt)) !== null) fallbackHits.push({ file: f, name: m[1], fb: +m[2] });
}
const fallbackBad = [];
const fallbackChecked = [];
const fallbackFailsafe = [];
for (const h of fallbackHits) {
  const tok = Lx[h.name];
  if (tok === undefined) continue;                    /* 令牌没定义 ⇒ 本条不判（ST-05 管缺失） */
  const n = parseFloat(tok);
  if (!Number.isFinite(n)) continue;                  /* 非数值令牌不参与 */
  if (FAILSAFE_FB.includes(h.name)) { fallbackFailsafe.push(`${h.name}: fb=${h.fb} 令牌=${n}`); continue; }
  fallbackChecked.push(`${h.name}=${n}`);
  if (Math.abs(n - h.fb) > 0.02) fallbackBad.push(`${h.file}: var(--${h.name}, ${h.fb}) 但令牌=${n}`);
}
/* 区分力自证：把 --wp-sat 的 fallback 从 .55 改成 .9，判定式必须翻红。
   这里直接在内存里重算同一套规则（不动磁盘文件，避免污染后续判据）。 */
const fbInjectBad = [...fallbackHits, { file: '(注入)', name: 'wp-sat', fb: 0.9 }]
  .filter(h => !FAILSAFE_FB.includes(h.name) && fallbackBad.every(b => !b.includes(`--${h.name},`)))
  .filter(h => { const t = parseFloat(Lx[h.name]); return Number.isFinite(t) && Math.abs(t - h.fb) > 0.02; });
check('ST-06 var() fallback 字面量不跟令牌打架（数值型 · 容差 0.02 · fail-safe 白名单）',
  fallbackBad.length === 0 && fbInjectBad.length >= 1,
  (fallbackBad.length ? fallbackBad.slice(0, 4).join(' ｜ ') + ' ｜ ' : '')
  + `${fallbackHits.length} 处数值 fallback 中 ${fallbackChecked.length} 处有同名令牌，全部一致${fallbackChecked.length ? '（' + [...new Set(fallbackChecked)].join(' / ') + '）' : ''}`
  + `；fail-safe 豁免 ${fallbackFailsafe.length} 处${fallbackFailsafe.length ? '（' + fallbackFailsafe.join(' / ') + '）' : ''}`
  + `；区分力自证：注入 --wp-sat fallback=.9 → 失配 ${fbInjectBad.length} 处（需 ≥1）`);

/* ---------------------------------------------------------------------------
   C03 —— 关键对比度与规格实算值吻合
   R80-R2 重写（契约 §7.1）：色板整体换档，原表 10 组全部失配 ⇒ 数值表换成新色板。
   **维度只增不减**：结构仍是 10 组（明 5 / 暗 5），新增 8 组：
     · 玻璃上文字 --text-on-glass on --glass-l2-fill（半透明底必须先合成到 canvas 上，
       直接拿 rgba 的 RGB 值算等于把 .70 当 1.0，会算出假的 17.5）；
     · 强调色作文字 --accent-text on canvas / panel / sunken 三底 × 明暗两档。
   同时新增两条非"复算"维度：
     · 全表 ≥4.5 的下限（数值"吻合"不等于"合规"——两者都要）；
     · 区分力自证：把 --accent-text 换成明档那个"on canvas 只有 2.96"的 #D97757，
       必须至少一行翻红。没有这一条，本条就只是把同一份公式算两遍（恒真）。
   --------------------------------------------------------------------------- */
/* 玻璃上文字：**渐变按最差档**（契约 §9 D10）。
   逐个 stop 用各自的 alpha 合成到 base 上，各自算 ratio，取最小值；
   返回的 `at` 是那个最差 stop 的位置（null = 无位置声明）。
   ★ 单色令牌也能走这里（stops 为 null 时退回原路径），所以调用点只有一处。 */
const glassBed = (glassVal, baseRgb) => {
  const stops = gradientStops(glassVal);
  if (!stops || stops.length === 0) {
    return [{ rgb: overRgba(toRgb(glassVal), baseRgb, alphaOf(glassVal)), at: null, alpha: alphaOf(glassVal) }];
  }
  return stops.map(st => ({
    rgb: [
      st.rgb[0] * st.a + baseRgb[0] * (1 - st.a),
      st.rgb[1] * st.a + baseRgb[1] * (1 - st.a),
      st.rgb[2] * st.a + baseRgb[2] * (1 - st.a)
    ],
    at: st.at, alpha: st.a
  }));
};
const c03Worst = {};
const glassOn = (V, text, glass, base, label) => {
  const beds = glassBed(V[glass], toRgb(V[base]));
  const textRgb = toRgb(V[text]);
  const scored = beds.map(b => ({ ...b, r: ratio(textRgb, b.rgb) }));
  scored.sort((x, y) => x.r - y.r);
  if (label) c03Worst[label] = { ratio: scored[0].r, at: scored[0].at, alpha: scored[0].alpha, bed: scored[0].rgb, stops: scored.length };
  return scored[0].r;
};

const c03Rows = [
  /* ---- 原有 10 组结构（明 5 / 暗 5），值换成新色板 ---- */
  { label: '明 color-faint/color-code-bg', exp: 5.27, got: () => ratio(toRgb(Lx['color-faint']), toRgb(Lx['color-code-bg'])) },
  { label: '明 color-text/color-surface', exp: 15.87, got: () => ratio(toRgb(Lx['color-text']), toRgb(Lx['color-surface'])) },
  { label: '明 color-control-border/color-surface', exp: 5.67, got: () => ratio(toRgb(Lx['color-control-border']), toRgb(Lx['color-surface'])) },
  { label: '明 color-accent/color-bg', exp: 5.67, got: () => ratio(toRgb(Lx['color-accent']), toRgb(Lx['color-bg'])) },
  { label: '明 color-accent-ink/color-accent', exp: 5.67, got: () => ratio(toRgb(Lx['color-accent-ink']), toRgb(Lx['color-accent'])) },
  { label: '暗 color-faint/color-surface', exp: 7.49, got: () => ratio(toRgb(Dx['color-faint']), toRgb(Dx['color-surface'])) },
  { label: '暗 color-text/color-surface', exp: 15.11, got: () => ratio(toRgb(Dx['color-text']), toRgb(Dx['color-surface'])) },
  { label: '暗 color-control-border/color-surface', exp: 7.49, got: () => ratio(toRgb(Dx['color-control-border']), toRgb(Dx['color-surface'])) },
  { label: '暗 color-accent/color-bg', exp: 7.04, got: () => ratio(toRgb(Dx['color-accent']), toRgb(Dx['color-bg'])) },
  { label: '暗 color-accent-ink/color-accent', exp: 7.04, got: () => ratio(toRgb(Dx['color-accent-ink']), toRgb(Dx['color-accent'])) },
  /* ---- 新增 A：玻璃上文字（半透明底合成后） ---- */
  { label: '明 text-on-glass/glass-l2-fill↦canvas', exp: 17.33, got: () => glassOn(Lx, 'text-on-glass', 'glass-l2-fill', 'bg-canvas', '明 text-on-glass/glass-l2-fill↦canvas') },
  { label: '暗 text-on-glass/glass-l2-fill↦canvas', exp: 14.39, got: () => glassOn(Dx, 'text-on-glass', 'glass-l2-fill', 'bg-canvas', '暗 text-on-glass/glass-l2-fill↦canvas') },
  /* ---- 新增 B：强调色作文字，三底 × 明暗 ---- */
  { label: '明 accent-text/bg-canvas', exp: 5.67, got: () => ratio(toRgb(Lx['accent-text']), toRgb(Lx['bg-canvas'])) },
  { label: '明 accent-text/bg-panel', exp: 5.14, got: () => ratio(toRgb(Lx['accent-text']), toRgb(Lx['bg-panel'])) },
  { label: '明 accent-text/bg-sunken', exp: 4.77, got: () => ratio(toRgb(Lx['accent-text']), toRgb(Lx['bg-sunken'])) },
  { label: '暗 accent-text/bg-canvas', exp: 5.90, got: () => ratio(toRgb(Dx['accent-text']), toRgb(Dx['bg-canvas'])) },
  { label: '暗 accent-text/bg-panel', exp: 5.34, got: () => ratio(toRgb(Dx['accent-text']), toRgb(Dx['bg-panel'])) },
  { label: '暗 accent-text/bg-sunken', exp: 5.90, got: () => ratio(toRgb(Dx['accent-text']), toRgb(Dx['bg-sunken'])) }
];
const c03Eval = rows => rows.map(r => ({ label: r.label, got: +(r.got()).toFixed(2), exp: r.exp }));
const c03All = c03Eval(c03Rows);
const c03Diffs = c03All.filter(x => Math.abs(x.got - x.exp) >= 0.06);
const c03Floor = c03All.filter(x => x.got < 4.5);
check('C03 关键对比度与规格 §4.3 实算值吻合（静态 · 渐变按最差档）',
  c03All.length === 18 && c03Diffs.length === 0 && c03Floor.length === 0,
  (c03Diffs.length ? `失配 ${JSON.stringify(c03Diffs)}` : `${c03All.length}/${c03All.length} 组吻合（10 原有 + 8 新增）`)
  + `；低于 4.5 的 ${c03Floor.length} 组${c03Floor.length ? ' ' + JSON.stringify(c03Floor) : ''}`
  + `；玻璃合成后实测（最差档）${c03All.filter(x => /glass/.test(x.label)).map(x => {
      const w = c03Worst[x.label] || {};
      return x.label.split('/')[0] + '=' + x.got + `@${w.at === null || w.at === undefined ? '无位置' : w.at + '%'}(α=${w.alpha}, ${w.stops} stops)`;
    }).join(' · ')}`
  + `；accent-text 三底 ${c03All.filter(x => /accent-text\//.test(x.label)).map(x => x.got).join('/')}`);
/* 区分力自证：把"强调色作文字"换成明档那个只过 canvas 的 #D97757（历史坑：
   落 sunken 只有 2.96）。用同一张表的期望值去比，必须至少一行翻红 ——
   否则本条只是把同一公式算两遍（恒真）。 */
const BAD_ACCENT = '#D97757';
const c03Bad = ['bg-canvas', 'bg-panel', 'bg-sunken'].flatMap(b => [
  { label: `明 accent-text/${b}`, V: Lx, b },
  { label: `暗 accent-text/${b}`, V: Dx, b }
]).map(x => {
  const exp = c03All.find(r => r.label === x.label).exp;
  return { label: x.label, exp, got: +ratio(toRgb(BAD_ACCENT), toRgb(x.V[x.b])).toFixed(2) };
}).filter(x => Math.abs(x.got - x.exp) >= 0.06);
check('C03b 判据区分力自证（把 accent-text 换成 #D97757 必须翻红）',
  c03Bad.length >= 1,
  `${c03Bad.length} 组在注入后失配（需 ≥1）：${c03Bad.map(x => x.label + ' ' + x.got + '≠' + x.exp).join(' · ') || '无 ⇒ 判据恒真，判红'}`);

/* ---------------------------------------------------------------------------
   C03c —— 「渐变按最差档」这件事本身必须能被证伪（契约 §9 D10 第 3 条）
   ---------------------------------------------------------------------------
   为什么单独一条：如果最差档实现只读第一个 stop（或只读最后一个），
   上面两条玻璃行依然会给出一个数、依然可能"吻合"，测不出它是否真的遍历了全部 stop。
   所以这里注入一个**中间** stop（不是首个）：把 `--glass-l2-fill` 的中位色标换成
   不透明黑 `rgba(0,0,0,.52)`。任何真的遍历全部 stop 的实现，最差档必然掉到 4.5 以下；
   只读首/尾的实现会给出和未注入时几乎一样的值 ⇒ 本条翻红。

   ★ 必须换中间：只换首个的话，"只读第一个 stop"的假实现也会红 —— 那证明的是
     "它读了第一个"，恰恰是我们要排除的那种实现。
   --------------------------------------------------------------------------- */
const midStopWorst = (V, label) => {
  const stops = gradientStops(V['glass-l2-fill']);
  const idx = Math.floor((stops.length - 1) / 2);       /* 3 stops ⇒ 1；4 stops ⇒ 1 */
  const base = toRgb(V['bg-canvas']);
  const text = toRgb(V['text-on-glass']);
  const injected = stops.map((st, i) => (i === idx ? { rgb: [0, 0, 0], a: 0.52, at: st.at } : st));
  const scored = injected.map(st => ({
    r: ratio(text, [
      st.rgb[0] * st.a + base[0] * (1 - st.a),
      st.rgb[1] * st.a + base[1] * (1 - st.a),
      st.rgb[2] * st.a + base[2] * (1 - st.a)
    ]),
    at: st.at
  })).sort((a, b) => a.r - b.r);
  return { label, min: +scored[0].r.toFixed(2), at: scored[0].at, n: stops.length, idx };
};
const c03cInj = [midStopWorst(Lx, '明'), midStopWorst(Dx, '暗')];
/* ★ 只在**明档**上要求 <4.5：暗档的文字是浅色（#F5F4ED），把中间 stop 换成不透明黑
   只会让"床"更暗 ⇒ 浅字对比度**升高**，物理上不可能跌破 4.5。
   要求暗档也翻红等于制造一条永远红的假断言。暗档仍打印实测值，但只作观察。 */
const c03cBad = c03cInj.filter(x => x.label === '明' && !(x.min < 4.5));
check('C03c 判据区分力自证（把 glass-l2-fill 的**中间** stop 换成 rgba(0,0,0,.52) 后最差档必须 <4.5）',
  c03cBad.length === 0 && c03cInj.every(x => x.idx > 0),
  `${c03cInj.map(x => `${x.label} 最差档 ${x.min}:1（命中 stop#${x.idx}/${x.n}，位置 ${x.at === null ? '无' : x.at + '%'}）`).join(' · ')}`
  + ` ⇒ ${c03cBad.length === 0
      ? '明档遍历到中间 stop ✓（暗档为浅字，黑 stop 只会抬高对比度，仅作观察）'
      : `未翻红：${c03cBad.map(x => x.label).join('/')} ⇒ 最差档逻辑疑似只读首/尾，判红`}`);

/* =========================================================================
   浏览器判据
   ========================================================================= */
let ctx, p12Dark, p12Light;
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-first-run', '--disable-extensions'],
    timeout: 30000
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => result.pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  page.on('request', r => result.requests.push(r.url()));

  await page.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);   // 等 5 组编排入场完成（最长 ~730ms）

  /* ---- A. 结构与样式 ---- */
  check('A01 唯一 h1', (await page.locator('h1').count()) === 1, 'h1 = 1');
  /* ---- A02 ----------------------------------------------------------------
     R80-R2 重写（契约 §7.1）：64px 空态展示字已按 R80 字阶删除
     （--fs-display 现在指向 22px 档），原来那条 `stageFs === '64px'` 钉的是一个
     **已经不存在的设计**，所以它失败不是回归，是判据过期。

     新口径从"钉一个数"改成"钉一整套字阶"，维度从 1 条变 4 条：
       ① 去重集合必须 ⊆ {11,12.5,13,14,15,17,22}（多出一个 18px 就红）；
       ② ≤10px 的元素数 = 0（可读性硬线）；
       ③ 11px 元素数 ≤ 16（11px 只留给时间戳/字数/快捷键，超量说明又拿它当正文档）；
       ④ CSS 确实生效的正面证据：#stageWord 存在且其字号落在允许集合内
          （整页字号都"没生效"时 ①②③ 会因为拿到默认 16px 而失败，但把 16px
           加进白名单又会放走真回归 —— 所以单独留一条正面取样）。
     区分力自证（另起一条）：注入一个 9px 元素，① 和 ② 必须同时翻红。 */
  const readFontSizes = () => page.evaluate(() => {
    const cs = n => getComputedStyle(n);
    const vis = n => n.offsetParent !== null || (cs(n).position === 'fixed' && n.getClientRects().length > 0);
    const all = [...document.querySelectorAll('*')].filter(vis);
    const count = {};
    all.forEach(n => { const v = parseFloat(cs(n).fontSize); if (Number.isFinite(v)) count[v] = (count[v] || 0) + 1; });
    const sizes = Object.keys(count).map(Number).sort((a, b) => a - b);
    return {
      sizes, count, visible: all.length,
      tiny: sizes.filter(s => s <= 10.5).reduce((a, s) => a + count[s], 0),
      eleven: count[11] || 0
    };
  });
  const ALLOWED_FS = [11, 12.5, 13, 14, 15, 17, 22];
  const fsA = await readFontSizes();
  const fsExtra = fsA.sizes.filter(s => !ALLOWED_FS.includes(s));
  /* 正面取样改成"取不到就返回 null"，而不是让 locator 抛错 ——
     整轮 117 条判据不应该因为一个装饰元素被删就直接崩掉（崩掉 = 后面全部形同不存在）。 */
  const stageInfo = await page.evaluate(() => {
    const el = document.getElementById('stageWord');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { fs: cs.fontSize, ff: cs.fontFamily };
  });
  const stageFs = stageInfo ? stageInfo.fs : 'MISSING';
  const stageFf = stageInfo ? stageInfo.ff : '';
  check('A02 CSS 生效 + 字号档位收敛（去重 ⊆ {11,12.5,13,14,15,17,22} · ≤10px = 0 · 11px ≤16）',
    fsExtra.length === 0 && fsA.tiny === 0 && fsA.eleven <= 16 && ALLOWED_FS.includes(parseFloat(stageFs)),
    `去重 ${JSON.stringify(fsA.sizes)}（越界 ${JSON.stringify(fsExtra)}）· ≤10px=${fsA.tiny} · 11px=${fsA.eleven} 个`
    + ` · 各档计数 ${JSON.stringify(fsA.count)} · #stageWord fontSize=${stageFs}（CSS 生效正面取样）`);
  /* 区分力自证：9px 注入必须让"白名单"与"≤10px=0"同时翻红 */
  let fsInj = null;
  try {
    await page.evaluate(() => {
      const s = document.createElement('span');
      s.id = 'fs-inj'; s.textContent = 'x'; s.style.fontSize = '9px';
      document.body.appendChild(s);
    });
    const fsB = await readFontSizes();
    fsInj = {
      extra: fsB.sizes.filter(s => !ALLOWED_FS.includes(s)),
      tiny: fsB.tiny, baseTiny: fsA.tiny
    };
  } finally {
    await page.evaluate(() => { const s = document.getElementById('fs-inj'); if (s) s.remove(); });
  }
  check('A02c 字号判据区分力自证（注入 9px 元素必须同时触发白名单与 ≤10px 两条）',
    !!fsInj && fsInj.extra.includes(9) && fsInj.tiny > fsInj.baseTiny,
    fsInj ? `注入 9px 后越界集合=${JSON.stringify(fsInj.extra)} · ≤10px ${fsInj.baseTiny} → ${fsInj.tiny}`
          : '注入失败 ⇒ 无区分力证据，判红');
  check('A02b 舞台展示字使用 Bahnschrift 展示字', /Bahnschrift/.test(stageFf), stageFf);

  /* ---- WP-01 / WP-01b ------------------------------------------------------
     R80-R2 新增（由 W2 的真机实测驱动，契约里没有这条 —— 属于「维度新增」）。

     病：Chromium 对**自定义属性值**有 2,097,152 字符（2^21）硬上限。超限时
     `setProperty` 返回成功、不抛错、控制台**一个字都不打**，而 `getPropertyValue`
     静默回空串。3840×2160 壁纸的 data URI 是 3,046,407 字符 —— 原样塞进 --wp-url，
     镜像永远不出现，截图看起来只是"壁纸没生效"，能查一整天。
     纯断言 `--wp-url !== 'none'` 抓不到它：变量被丢弃时读回的是空串，不是 'none'。

     四个维度（缺一不可）：
       ① 计算值非空 且 < 2^21（空串 = 被上限吞掉的样子）
       ② 不是 data URI（契约外的一条纪律：相对路径文件绕开上限，且 750KB 的串
          不能拿去做子串/正则断言 —— 只看长度和文件存在，不碰内容）
       ③ url() 指向的文件**真实存在**：CSS 里的相对路径是按**样式表所在目录**解析的，
          写成 `assets/…` 会去找 `styles/assets/…` → 静默 404，症状与 ① 一模一样
       ④ 镜像层真的把令牌用上了：position:fixed / pointer-events:none /
          background-image 非 none / opacity 与 --wp-visible 一致 / 是 body 第 0 个子元素
     WP-01b：把 --wp-url 塞成 2,100,000 字符，① 的判定式必须翻假 —— 证明这条不是恒真。 */
  const WP_MAX = 2097152;
  const wp = await page.evaluate(async () => {
    const root = getComputedStyle(document.documentElement);
    const val = k => root.getPropertyValue(k).trim();
    const el = document.getElementById('desktopMirror');
    const es = el ? getComputedStyle(el) : null;
    const rect = el ? el.getBoundingClientRect() : null;
    /* 真解码，而不是"字符串看着对"：路径写错但拼写正确时 backgroundImage 照样有值，
       只有 Image.decode() 会 reject。这是主理人要求的那条唯一可靠证据。 */
    let decoded = false, natural = null, decodeErr = '';
    const url = es ? (es.backgroundImage.match(/url\(\s*["']?([^"')]+)["']?\s*\)/) || [])[1] : '';
    if (url && url !== 'none') {
      try {
        const im = new Image();
        im.src = url;
        await im.decode();
        natural = [im.naturalWidth, im.naturalHeight];
        decoded = im.naturalWidth > 0 && im.naturalHeight > 0;
      } catch (e) { decodeErr = String(e && e.name || e).slice(0, 60); }
    }
    return {
      raw: val('--wp-url'), visible: val('--wp-visible'), x: val('--wp-x'), y: val('--wp-y'), size: val('--wp-size'),
      hasEl: !!el,
      order: el ? [...document.body.children].indexOf(el) : -1,
      text: el ? (el.textContent || '').trim() : null,
      pos: es ? es.position : null, pe: es ? es.pointerEvents : null,
      bgImg: es ? es.backgroundImage : null, opacity: es ? es.opacity : null,
      h: rect ? +rect.height.toFixed(1) : -1, w: rect ? +rect.width.toFixed(1) : -1,
      decoded, natural, decodeErr, url: url.slice(0, 90)
    };
  });
  const wpPath = (wp.raw.match(/url\(\s*["']?([^"')]+)["']?\s*\)/) || [])[1] || '';
  const wpAbs = wpPath && !/^data:/i.test(wpPath) ? resolve(DESIGN, 'styles', wpPath) : '';
  const wpFileOk = !!wpAbs && existsSync(wpAbs);
  const wpGuard = w => w.raw.length > 0 && w.raw.length < WP_MAX && !/^data:/i.test(w.raw);
  check('WP-01 壁纸镜像层真拿到并画出 --wp-*（URL 非空且 <2^21 · 非 data URI · 文件存在 · 图片真解码 · fixed / 覆盖视口 / pointer-events:none / opacity 一致）',
    wpGuard(wp) && wpFileOk && wp.hasEl && wp.order === 0 && wp.text === ''
    && wp.pos === 'fixed' && wp.pe === 'none' && wp.bgImg !== 'none'
    && wp.decoded && wp.h > 100
    && Math.abs(parseFloat(wp.opacity) - parseFloat(wp.visible || '0')) < 0.01,
    `--wp-url ${wp.raw.length} 字符（上限 ${WP_MAX}）${/^data:/i.test(wp.raw) ? ' ⚠ 是 data URI' : ''}；`
    + `文件 ${wpAbs || '(无)'} 存在=${wpFileOk}；`
    + `真解码=${wp.decoded}${wp.natural ? ' ' + wp.natural.join('×') : ''}${wp.decodeErr ? ' ERR=' + wp.decodeErr : ''}；`
    + `镜像层 ${wp.w}×${wp.h}px（需高 >100）第 ${wp.order} 子元素 文本=${JSON.stringify(wp.text)} ${wp.pos} pe=${wp.pe} opacity=${wp.opacity}(--wp-visible=${wp.visible})；`
    + `x/y/size=${wp.x}/${wp.y}/${wp.size}`);
  let wpInj = null;
  try {
    wpInj = await page.evaluate(({ max }) => {
      const root = document.documentElement;
      const read = () => getComputedStyle(root).getPropertyValue('--wp-url').trim().length;
      const small = 'url("data:image/svg+xml,' + 'y'.repeat(4000) + '")';
      root.style.setProperty('--wp-url', small);
      const smallBack = read();
      const big = 'url("data:image/svg+xml,' + 'x'.repeat(max + 5000) + '")';
      root.style.setProperty('--wp-url', big);
      const bigBack = read();
      const el = document.getElementById('desktopMirror');
      const bg = el ? getComputedStyle(el).backgroundImage : '';
      root.style.removeProperty('--wp-url');
      return { small: small.length, smallBack, big: big.length, bigBack, bgIsNone: bg === 'none' };
    }, { max: WP_MAX });
  } catch (e) { wpInj = null; }
  /* 两侧探针：小值必须原样生效（证明 setProperty 这条路是通的），
     超限值必须**没能原样生效**（证明 2^21 那道闸真实存在）。
     只做"大值失败"一侧是没有区分力的 —— setProperty 整个坏掉也会让它通过。 */
  const wpInjOk = !!wpInj && wpInj.smallBack === wpInj.small && wpInj.bigBack !== wpInj.big;
  check('WP-01b 判据区分力自证（两侧探针：4006 字符原样生效 · 2,102,178 字符必须被静默丢弃）',
    wpInjOk,
    wpInj ? `小值 ${wpInj.small}→${wpInj.smallBack} 字符（须相等）· 超限值 ${wpInj.big}→${wpInj.bigBack} 字符（须不等，实测回落到样式表默认值）· 镜像层 bg=${wpInj.bgIsNone ? 'none' : '非 none'}`
          : '注入失败 ⇒ 无区分力证据，判红');
  const h1Ff = await page.locator('h1').evaluate(el => getComputedStyle(el).fontFamily);
  const banned = /Inter|Roboto|Arial|Helvetica|system-ui|Open Sans|Lato|Montserrat|Poppins|Space Grotesk|-apple-system|BlinkMacSystemFont|Segoe UI/i;
  check('A03 展示字栈含 Bahnschrift 且禁用字体 0 命中', /Bahnschrift/.test(h1Ff) && !banned.test(h1Ff), h1Ff);
  const fonts = await page.evaluate(() => ({
    d: document.fonts.check('300 16px Bahnschrift'),
    b: document.fonts.check('400 15px Calibri'),
    m: document.fonts.check('400 13px "Cascadia Mono"')
  }));
  check('A04 三套本机字体可解析', fonts.d && fonts.b && fonts.m, JSON.stringify(fonts));
  const revealCount = await page.locator('.reveal.in:not([hidden])').count();
  check('A05 编排入场完成（.reveal.in >= 12）', revealCount >= 12, `${revealCount} 个元素已揭示`);
  const glyphInReveal = await page.evaluate(() =>
    document.querySelectorAll('.stage-glyph.reveal, .stage-word.reveal, .stage-flash.reveal').length);
  check('§8.2 一次性舞台字 / 空态 64px 字不进 .reveal 集合（不污染 P11）',
    glyphInReveal === 0, `命中 ${glyphInReveal} 个`);

  let routed = 0;
  for (const v of VIEWS) {
    await page.locator('.view-nav [data-view="' + v + '"]').click();
    await page.waitForTimeout(55);
    if (await page.locator('[data-view-panel="' + v + '"]').isVisible()) routed++;
  }
  check('A06 9 个板块全部可达', routed === 9, `${routed}/9`);
  await page.locator('.view-nav [data-view="chat"]').click();
  await page.waitForTimeout(120);

  /* ---- QA-A7-2：9 板块内容指纹两两不同 + 专属构成证据 ---- */
  const fps = await page.evaluate(() => {
    const norm = el => ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
    return [...document.querySelectorAll('[data-view-panel]')].map(p => ({
      id: p.getAttribute('data-view-panel'), proto: p.getAttribute('data-prototype'),
      len: norm(p).length, head: norm(p).slice(0, 60)
    }));
  });
  const uniqText = new Set(fps.map(f => f.head + '|' + f.len));
  const uniqProto = new Set(fps.map(f => f.proto));
  check('QA-A7-2 9 板块内容指纹两两不同（非换标题）',
    fps.length === 9 && uniqText.size === 9 && uniqProto.size === 9 && fps.every(f => f.len >= 120),
    `9 个原型 ${JSON.stringify([...uniqProto])}；最短正文 ${Math.min(...fps.map(f => f.len))} 字`);

  /* ---- A07 / QA-A2：主题切换 + 等待过渡结束双采样 ---- */
  const themeBefore = await page.locator('html').getAttribute('data-theme');
  const textBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim());
  await page.locator('#themeToggle').click();
  await settle(page);
  const themeAfter = await page.locator('html').getAttribute('data-theme');
  const textAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim());
  check('A07 明暗主题切换生效且语义令牌改变', themeBefore !== themeAfter && textBefore !== textAfter,
    `${themeBefore} → ${themeAfter}；--color-text ${textBefore} → ${textAfter}`);
  const s1 = await page.evaluate(() => getComputedStyle(document.querySelector('#glass-top')).backgroundColor);
  await page.waitForTimeout(90);
  const s2 = await page.evaluate(() => getComputedStyle(document.querySelector('#glass-top')).backgroundColor);
  const anims = await page.evaluate(() => (document.getAnimations ? document.getAnimations().length : 0));
  /* 方向变更留痕（2026-11-12 液态玻璃轮）：
     旧断言 anims === 0 的依据是「主题切换后必须完全静止」。液态玻璃引入了
     一条**装饰性慢扫光**（L1 结构玻璃上 18s 一轮的斜向高光），它必然是无限动画。
     如果继续要求 0，就等于禁止"自然流畅的光效"，与这一轮的目标直接冲突。
     因此把断言从"数量为 0"改成"**只允许装饰性慢扫光，且必须逐项举证**"：
       ① 常驻无限动画 <= 2 个；② 名字必须恰为 lg-sweep；
       ③ 周期 >= 12s（不能是闪烁/抖动级的快循环）；④ 关键帧只允许动 background-*；
       ⑤ 底层的双采样 s1 === s2 保持不变（颜色必须已经定下来）。
     这条改动不是放宽：旧断言对"半个页面在循环"和"一条高光在慢慢走"一视同仁，
     新断言能区分二者，并且把"动的到底是什么属性"逼出来。 */
  const resident = await page.evaluate(() => (document.getAnimations ? document.getAnimations() : [])
    .filter(a => { try { return a.effect.getComputedTiming().iterations === Infinity; } catch (e) { return false; } })
    .map(a => {
      let props = [];
      try {
        props = a.effect.getKeyframes()
          .flatMap(k => Object.keys(k))
          .filter(k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
      } catch (e) { props = ['(unreadable)']; }
      return { name: a.animationName, dur: a.effect.getComputedTiming().duration, props: [...new Set(props)] };
    }));
  const residentOk = resident.length <= 2 &&
    resident.every(a => a.name === 'lg-sweep' && a.dur >= 12000 && a.props.every(p => /^background/.test(p)));
  check('QA-A2-2 主题切换后颜色已定（双采样）＋ 常驻动画只允许装饰性慢扫光（逐项举证）', s1 === s2 && residentOk,
    `sample1=${s1} sample2=${s2} 动画总数=${anims} 常驻=${JSON.stringify(resident)}` +
    (infiniteAnimations.length ? ` | 无限动画登记=${JSON.stringify(infiniteAnimations)}` : '') +
    (settleTimeouts.length ? ` | settle 超时=${JSON.stringify(settleTimeouts)}` : ''));
  await page.screenshot({ path: join(QA, '01-dark-1440.png'), fullPage: false });
  result.screenshots.push('01-dark-1440.png');

  /* ---- LG-02 暗档 / B03 暗 ---- */
  const glassDark = await glassSnapshot(page);
  p12Dark = { top: glassDark.tiers['glass-top'], bottom: glassDark.tiers['glass-ribbon'] };
  const darkBdf = await page.evaluate(() => [
    getComputedStyle(document.querySelector('#glass-top')).backdropFilter,
    getComputedStyle(document.querySelector('#glass-ribbon')).backdropFilter
  ]);
  check('B03 暗色 saturate() 禁用', darkBdf.every(v => !/saturate\(/.test(v)),
    `L1a=${darkBdf[0]} / L1b=${darkBdf[1]}`);
  const darkContrast = await realContrast(page);
  /* R77-H26：`every` 在空集合上恒真 —— realContrast 的 9 个选择器各自
     `if (!el) return;`，所以任何一类正文节点消失，这条判据会**静默通过**而不是失败。
     加非空前置：9 类必须全部命中（实测明暗两档都是 9/9）。这是**收紧**，不是放宽。 */
  check('QA-A2-3 暗色真实正文节点对比度 >= 4.5',
    darkContrast.length === 9 && darkContrast.every(x => x.ratio >= 4.5),
    `命中 ${darkContrast.length}/9 类 · ` + JSON.stringify(darkContrast.slice(0, 3)));

  await page.locator('#themeToggle').click();
  await settle(page);
  await page.screenshot({ path: join(QA, '02-light-1440.png'), fullPage: false });
  result.screenshots.push('02-light-1440.png');

  /* ---- LG-01 / LG-02 / LG-03 / B04：三层玻璃结构（明档取证 + 明暗对照） ---- */
  const gL = await glassSnapshot(page);
  const gD = glassDark;
  const l3Bad = gL.cards.filter(c => c.bdf !== 'none');
  /* ---- LG-01 --------------------------------------------------------------
     R80-R2 重写（契约 §7.1）：结构面从 4 个收敛到 **2 个**。
     右栏 #observerWindow 与底部 #glass-ribbon 改成实心（契约 §5.1 注释：右栏是密集
     读数，不参与玻璃叙事；光带是常驻读数），所以"4 个结构面"是**设计作废**，
     不是实现回归。判据必须跟着设计走，但维度只增不减：

       ① blur 元素数量硬约束（R80-R2 曾为 2，R81-R2 起依据契约 §8 D7 改钉为 4，见下方 ★）；
       ② id 集合 == {glass-top, mainStage}（少了谁、多了谁都要能点名）；
       ③ #observerWindow 的 backdrop-filter === 'none'（实心化必须真生效，
          不是"blur(0px)"——'blur(0px)' 仍会建层、仍会吃 GPU）；
       ④ #glass-ribbon 同理；
       ⑤ L3 卡片层零 blur（原有）；
       ⑥ 玻璃不嵌套（原有，nested 对 = 0）；
       ⑦ 新增：任一条祖先链上带 blur 的元素数 ≤ 1（maxChain ≤ 1）——
          对"同一元素叠两层 backdrop-filter"这类写法有效，⑥ 抓不到。

     ★ R81-R2 改写（**依据契约 §8 D7**，主理人 2026-11-14 批准）：
       §8 D7 把白名单定为 **4 个**（glass-top / mainStage / observerWindow /
       glass-ribbon），并把 composer 移出（它在 #mainStage 内部，玻璃套玻璃，
       与"裁决 3：.stage-head 不单独加 backdrop-filter"是同一条物理理由）。
       所以 ①②③④ 四条按新契约重钉：
         ① blur 元素恰好 **4** 个
         ② id 集合 == 上面四个（顺序无关，排序后比）
         ③④ 删除「右栏 / 光带 === 'none'」—— 它们已不是实心，这两条与 §8 直接冲突，
             留着会让"实现完全正确"的构建永远红，且下一次有人为了过判据去把它们关掉，
             就是把刚接好的玻璃又拆了。
       ⑤⑥⑦ 原样保留（这三条才是真正防"玻璃套玻璃 / 叠层"的维度）。
       区分力自证（LG-01b）：给 #observerWindow 注入 blur(6px)，① ② 必须同时失配
       —— 注入后计数必须 **5**、id 集合必须与四元组不同。 */
  const HERO = ['glass-top', 'glass-ribbon', 'mainStage', 'observerWindow'].sort();
  const heroIdsSorted = [...gL.ids].sort();
  check('LG-01 同屏 blur 元素恰好 4 个（id 集合 = {glass-top, mainStage, observerWindow, glass-ribbon} · 契约 §8 D7）+ 卡片层零 blur + 玻璃不嵌套（链上 ≤1）',
    gL.count === 4 &&
    JSON.stringify(heroIdsSorted) === JSON.stringify(HERO) &&
    l3Bad.length === 0 && gL.nested.length === 0 && gL.maxChain <= 1,
    `blur 元素 ${gL.count} 个 ${JSON.stringify(gL.ids)}；`
    + `L3 带 blur ${l3Bad.length} 个${l3Bad.length ? JSON.stringify(l3Bad.slice(0, 4)) : ''}；`
    + `嵌套 ${JSON.stringify(gL.nested)}；maxChain=${gL.maxChain}（门槛 ≤1）`);
  /* LG-01b 区分力自证：注入第 5 个 blur 面必须让计数与 id 集合同时失配。
     ★ 注入对象从 #observerWindow 改成 **#composer**：§8 D7 之后 #observerWindow
       本来就是 4 个之一，往它身上注入只是改数值、不会让计数从 4 变 5 ——
       那样的"自证"会恒红（测的是注入方式，不是判据的区分力）。
       挑 #composer 是因为它正是 D7 刚移出白名单的那一个：往它注入 blur
       等于把"玻璃套玻璃"重新放回去，判据必须立刻点名它。 */
  let lg01Inj = null;
  try {
    await page.evaluate(() => {
      const el = document.getElementById('composer');
      if (el) { el.dataset.w5prev = el.style.backdropFilter || ''; el.style.backdropFilter = 'blur(6px)'; }
    });
    const gInj = await glassSnapshot(page);
    lg01Inj = { count: gInj.count, ids: [...gInj.ids].sort() };
  } finally {
    await page.evaluate(() => {
      const el = document.getElementById('composer');
      if (el) { el.style.backdropFilter = el.dataset.w5prev || ''; delete el.dataset.w5prev; }
    });
  }
  check('LG-01b 判据区分力自证（给 #composer 注入 blur(6px) 后计数必须 5、id 集合必须失配）',
    !!lg01Inj && lg01Inj.count === 5 && JSON.stringify(lg01Inj.ids) !== JSON.stringify(HERO),
    lg01Inj ? `注入后 count=${lg01Inj.count} ids=${JSON.stringify(lg01Inj.ids)}（基线 4 / ${JSON.stringify(HERO)}）`
            : '注入失败 ⇒ 无区分力证据，判红');
  const tL = gL.tiers, tD = gD.tiers;
  /* ---- LG-02 --------------------------------------------------------------
     ★ R78b 判据升级留痕：这不是放宽，是把「钉一个数」升级为「钉一个物理窗口
       + 关系约束」。那段理由仍然成立（34px 会把背后糊成均匀一片 ⇒ 上界 18px），
       只是 R80-R2 把档位按新材质重新分工，窗口整体上移（见下）。

     ★ R80-R2 重写（契约 §7.1）：分档**方向反了**。
       改前：L1 结构玻璃 13px > L2 主台面 11px。
       现在：L2 = --glass-l2-blur 30px（中栏液态厚玻璃） > L1 = --glass-l1-blur 20px
             （左栏结构玻璃）。
       依据：中栏是「液态厚玻璃磨砂 + 透色桌面」，厚度必须比结构玻璃更糊；
       左栏结构玻璃要透出背后的壁纸镜像，糊过头就看不见镜像的形状。
       所以这不是"调松阈值让它变绿"——分档方向、两侧窗口、比值区间三条同时钉住，
       把任何一档颠倒或挪出窗口都会红。

     ★ R81-R2（契约 §8 D7）：**插进第三档 rail = 22px**。
       右栏 #observerWindow 是 320px 宽的窄条，套 30px 会把背后壁纸糊成均匀一片；
       台面用 30px 是因为它 804px 宽、糊得开 —— 同一套半径不该跨尺寸复用。
       三档 20 / 22 / 30 单调，L2/L1 仍 = 1.50。

     【维度（R81-R2 重排，依据契约 §8 D7/D8；只增不减）】
       ① glass-top ∈ L1 窗口 [16, 24]（契约值 20）
       ② observerWindow ∈ **rail** 窗口 [20, 24]（契约值 22）
       ③ mainStage ∈ L2 窗口 [22, 34]（契约值 30）
       ④ 三档严格单调 L1 < rail < L2（原来只有 L2 > L1 两档关系）
       ⑤ L1 > 0（低档仍是玻璃，不是实心板）
       ⑥ L2 / L1 ∈ [1.1, 1.6]（30/20 = 1.50，落在窗口正中）
       ⑦ 明暗材质签名不同 —— 口径从「backdrop-filter 串」换成
          **fill 低点 alpha + bright + contrast**（六个子项，见 lg02TwinOk）
       ⑧ 位移类滤镜白名单：只允许出现在 #glass-top::before
       ⑨ 自证（LG-02b，两条注入）：#mainStage 注入 filter:blur(2px) 被 ⑧ 抓到；
          #mainStage 注入 blur(22px) 被 ④ 抓到（顺序失配）

     ★ 为什么删 ③ 与旧 ⑧（必须写清，否则下次没人知道维度是不是偷偷少了）：
       · 删「glass-ribbon === 0 且 observerWindow === 0（已实心）」：§8 D7 之后
         这两个壳**本来就该是玻璃**，留着这条等于要求"用关掉玻璃的方式过判据"。
         不是维度变少 —— 它的位置由 ② 的 rail 窗口和 ④ 的三档单调接走。
       · 删「明暗 L1 blur 差 ≥2px」：ST-05 已把 --glass-l1-blur 归到 TWIN_SAME
         （blur 是结构属性），两档必然同值 ⇒ 这条永远红，且它正是"为过判据去给
         暗档硬编 18px"的源头。判据不该反向指挥物理值。
       · 删「两处 fill 的 backgroundColor alpha 明暗不等」：§8 D7 之后
         glass-top / mainStage 的 backgroundColor 都是 transparent（fill 挪进
         background-image 末层），alpha 恒等 0 ⇒ 同样永远红。它要防的
         "暗档 fill 抄了明档值"由 ⑦ 的 fill 低点 alpha 直接接管（更强：
         原来只看 0/0，现在比的是真实色标）。 */
  const lg02In = (v, w) => typeof v === 'number' && v >= w[0] && v <= w[1];
  const l1Win = [16, 24], railWin = [20, 24], l2Win = [22, 34], ratioWin = [1.1, 1.6];
  const lg02TierOk = t =>
    lg02In(t['glass-top'], l1Win) &&
    lg02In(t['observerWindow'], railWin) &&
    lg02In(t['mainStage'], l2Win);
  const lg02Ratio = t => (t['glass-top'] > 0 ? t['mainStage'] / t['glass-top'] : NaN);
  const lg02SplitOk = t =>
    t['glass-top'] > 0 &&
    t['glass-top'] < t['observerWindow'] && t['observerWindow'] < t['mainStage'] &&
    lg02In(lg02Ratio(t), ratioWin);
  const lg02Fmt = (label, t) =>
    `${label} L1=${t['glass-top']}(∈[16,24]) rail=${t['observerWindow']}(∈[20,24]) `
    + `L2=${t['mainStage']}(∈[22,34]) `
    + `L2/L1=${Number.isFinite(lg02Ratio(t)) ? lg02Ratio(t).toFixed(2) : 'NA'} (∈[1.1,1.6])`;
  const lg02Disps = gL.disp;
  const lg02DispOk = lg02Disps.every(d => d.at === 'glass-top::before');
  /* ⑦ 明暗材质签名：**fill 低点 alpha + bright + contrast**。
     为什么不是 backdrop-filter 串：旧签名靠的是"暗档没有 saturate()"这一事实，
     而 §8 D7/D9 之后那只是 B03 的副作用，不是"材质随光变"的证据。
     换成三项真正随环境光走的量：bright / contrast 明暗必然不同，
     fill 的低点 alpha（全串里最小的那个色标）也必然不同 —— 三者缺一即判红。
     fill 已从 background-color 挪进 background-image 末层，所以只能从令牌串里取。 */
  const fillMinAlpha = (v) => {
    const alphas = [...String(v || '').matchAll(/,\s*(0?\.\d+|1)\s*\)/g)].map(m => +m[1]);
    return alphas.length ? Math.min(...alphas) : NaN;
  };
  const sigL = {
    a1: fillMinAlpha(Lx['glass-l1-fill']), a2: fillMinAlpha(Lx['glass-l2-fill']),
    b1: Lx['glass-l1-bright'], b2: Lx['glass-l2-bright'],
    c1: Lx['glass-l1-contrast'], c2: Lx['glass-l2-contrast']
  };
  const sigD = {
    a1: fillMinAlpha(Dx['glass-l1-fill']), a2: fillMinAlpha(Dx['glass-l2-fill']),
    b1: Dx['glass-l1-bright'], b2: Dx['glass-l2-bright'],
    c1: Dx['glass-l1-contrast'], c2: Dx['glass-l2-contrast']
  };
  const lg02SigL = [sigL.a1, sigL.b1, sigL.c1, sigL.a2, sigL.b2, sigL.c2].join('/');
  const lg02SigD = [sigD.a1, sigD.b1, sigD.c1, sigD.a2, sigD.b2, sigD.c2].join('/');
  const lg02TwinOk =
    sigL.a1 !== sigD.a1 && sigL.a2 !== sigD.a2 &&
    sigL.b1 !== sigD.b1 && sigL.b2 !== sigD.b2 &&
    sigL.c1 !== sigD.c1 && sigL.c2 !== sigD.c2;
  check('LG-02 blur 三档严格分档（L1 20 < rail 22 < L2 30 · L2/L1 ∈[1.1,1.6]）· 明暗材质签名不同（fill 低点 α + bright + contrast）· 位移类滤镜只允许 glass-top::before',
    lg02TierOk(tL) && lg02TierOk(tD) && lg02SplitOk(tL) && lg02SplitOk(tD) &&
    lg02SigL !== lg02SigD && lg02TwinOk && lg02DispOk,
    lg02Fmt('明', tL) + ' ｜ ' + lg02Fmt('暗', tD)
    + ` ｜ 明暗签名 明[${lg02SigL}] 暗[${lg02SigD}]${lg02SigL !== lg02SigD ? '' : ' 相同⇒判红'}`
    + ` ｜ 六项明暗：fill低点α ${sigL.a1}/${sigD.a1}、${sigL.a2}/${sigD.a2}；`
    + `bright ${sigL.b1}/${sigD.b1}、${sigL.b2}/${sigD.b2}；`
    + `contrast ${sigL.c1}/${sigD.c1}、${sigL.c2}/${sigD.c2}（需六项全不等）`
    + ` ｜ 位移类滤镜 ${lg02Disps.length} 处${lg02Disps.length ? ' ' + JSON.stringify(lg02Disps) : '（白名单内）'}`);
  /* LG-02b 区分力自证（两条注入，缺一不可）：
     α 给 #mainStage 注入 filter:blur(2px) ⇒ 位移滤镜白名单必须抓到它（⑧）
     β 给 #mainStage 注入 blur(22px) ⇒ 三档单调必须失配（④，22 !< 22）
     只做 α 的话，④ 那三条新维度是"从未被证明能翻红"的恒真断言。 */
  let lg02Inj = null;
  try {
    await page.evaluate(() => {
      const el = document.getElementById('mainStage');
      if (el) { el.dataset.w5prev = el.style.filter || ''; el.style.filter = 'blur(2px)'; }
    });
    lg02Inj = (await glassSnapshot(page)).disp;
  } finally {
    await page.evaluate(() => {
      const el = document.getElementById('mainStage');
      if (el) { el.style.filter = el.dataset.w5prev || ''; delete el.dataset.w5prev; }
    });
  }
  let lg02TierInj = null;
  try {
    await page.evaluate(() => {
      const el = document.getElementById('mainStage');
      if (el) {
        el.dataset.w5bdf = el.style.backdropFilter || '';
        el.style.backdropFilter = 'url(#liquid-refract-stage) blur(22px) saturate(1.7) contrast(0.9) brightness(1.12)';
      }
    });
    const gInj2 = await glassSnapshot(page);
    lg02TierInj = { tiers: gInj2.tiers, splitOk: lg02SplitOk(gInj2.tiers) };
  } finally {
    await page.evaluate(() => {
      const el = document.getElementById('mainStage');
      if (el) { el.style.backdropFilter = el.dataset.w5bdf || ''; delete el.dataset.w5bdf; }
    });
  }
  const lg02InjCaught = !!lg02Inj && lg02Inj.length >= 1 && !lg02Inj.every(d => d.at === 'glass-top::before');
  const lg02TierCaught = !!lg02TierInj && lg02TierInj.splitOk === false;
  check('LG-02b 判据区分力自证（注入 filter:blur(2px) 必须被位移白名单抓到 · 注入 blur(22px) 必须让三档单调失配）',
    lg02InjCaught && lg02TierCaught,
    (lg02Inj ? `α 注入后白名单外命中 ${JSON.stringify(lg02Inj.filter(d => d.at !== 'glass-top::before'))}`
             : 'α 注入失败')
    + `；β 注入后 tiers=${lg02TierInj ? JSON.stringify(lg02TierInj.tiers) : 'NA'}`
    + ` → 单调 ${lg02TierInj ? (lg02TierInj.splitOk ? '仍成立⇒判红' : '失配 ✓') : '无证据'}`
    + (lg02InjCaught && lg02TierCaught ? '' : ' ⇒ 判红'));
  const bed = await bedContrast(page);
  const bedMin = bed.out.reduce((a, b) => (b.ratio < a.ratio ? b : a), bed.out[0] || { sel: '-', ratio: 0 });
  check('LG-03 文字承载面合成对比度 >= 4.5（底 = 页面底色 × 当前日照强度，按最暗算）',
    bed.out.length >= 10 && bed.out.every(x => x.ratio >= 4.5),
    `日照系数 ${bed.exp}；最低 ${bedMin.ratio}:1 @ ${bedMin.sel}；抽样 ${bed.out.length} 类节点`);
  p12Light = { top: tL['glass-top'], bottom: tL['glass-ribbon'], stage: tL['mainStage'] };
  check('B04 浮层零 blur + 玻璃不嵌套', gL.overlays.length > 0 && gL.overlays.every(v => v === 'none') && gL.nested.length === 0,
    `overlays=${gL.overlays.length} 全 none；nested=${JSON.stringify(gL.nested)}`);

  const lightContrast = await realContrast(page);
  check('C03 明色真实正文节点对比度 >= 4.5（P1 有效背景合成）',
    lightContrast.length === 9 && lightContrast.every(x => x.ratio >= 4.5),
    `最低 ${lightContrast.length ? Math.min(...lightContrast.map(x => x.ratio)).toFixed(2) : 'NA'}:1，命中 ${lightContrast.length}/9 类节点`);

  /* ---- T4：像素级正文对比度（R78c 新增；不动上面任何一条） ----
     底取**实测像素**（唯一能抓到"背景被一层白雾洗掉"的口径），
     字取字芯单像素极值（保守：抗锯齿只会让比值偏小）。 */
  const t4boxes = await textBoxes(page, T4_BLOCKS);
  const t4img = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
  const t4rows = [];
  for (const b of t4boxes) {
    if (b.miss) { t4rows.push({ sel: b.sel, label: b.label, ratio: 0, miss: b.miss }); continue; }
    const c = pixelContrast(t4img, b);
    t4rows.push({
      sel: b.sel, label: b.label, text: b.text, fs: b.fs,
      ratio: c ? c.ratio : 0, bg: c ? c.bg : null, fg: c ? c.fg : null, n: c ? c.n : 0
    });
  }
  const t4hit = t4rows.filter(r => !r.miss);
  const t4min = t4hit.reduce((a, b) => (b.ratio < a.ratio ? b : a), { label: '-', ratio: 99 });
  const t4ok = t4hit.length >= 9 && t4hit.length === T4_BLOCKS.length && t4hit.every(r => r.ratio >= 4.5);
  check('T4 像素级正文对比度 >= 4.5（底色取实测像素中位数 · 字色取字芯极值 · 明色）', t4ok,
    `命中 ${t4hit.length}/${T4_BLOCKS.length} 块（需 ≥9 且不得缺块）；最低 ${t4min.ratio}:1 @ ${t4min.label}（${t4min.sel}）`
    + ` ｜ ` + t4hit.map(r => `${r.label} ${r.fs} ${r.ratio}:1`).join(' · '));

  /* 反例注入：把同一组选择器压成 rgba(60,74,68,.45)（合成后约 2.3:1），必须至少一块翻红。
     用带 id 的 <style> 注入，量完就 remove —— 保证后续判据不受污染。 */
  let t4inj = null;
  try {
    const css = T4_BLOCKS.map(b => b.sel).join(',') + '{color:rgba(60,74,68,.45)!important}';
    await page.evaluate((c) => {
      const old = document.getElementById('t4-inj');
      if (old) old.remove();
      const s = document.createElement('style');
      s.id = 't4-inj';
      s.textContent = c;
      document.head.appendChild(s);
    }, css);
    await page.waitForTimeout(160);
    const injImg = decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
    const injRows = [];
    for (const b of t4boxes) {
      if (b.miss) continue;
      const c = pixelContrast(injImg, b);
      if (c) injRows.push({ label: b.label, ratio: c.ratio });
    }
    t4inj = {
      red: injRows.filter(r => r.ratio < 4.5).length,
      total: injRows.length,
      min: injRows.length ? Math.min(...injRows.map(r => r.ratio)) : null
    };
  } catch (e) {
    t4inj = null;
  } finally {
    await page.evaluate(() => { const s = document.getElementById('t4-inj'); if (s) s.remove(); }).catch(() => {});
  }
  check('T4b 像素级对比度判据有区分力（反例注入必须翻红）',
    !!t4inj && t4inj.red >= 1 && t4inj.red === t4inj.total,
    t4inj
      ? `注入 rgba(60,74,68,.45) 后 ${t4inj.red}/${t4inj.total} 块 < 4.5:1（需全部翻红以证明判据非恒真），最低 ${t4inj.min}:1`
      : '注入失败 ⇒ 无区分力证据，判红');

  /* ==========================================================================
     T4-D：暗档像素级对比度（本轮新增 · 明档 T4 只覆盖一半，暗档此前无判据）
     --------------------------------------------------------------------------
     [为什么必须补] 现役 T4 只量明色 13 块。暗档那半边**没有任何判据在看**，
     后果已经实测到：本轮刚抬过墨色的四块（4.86/4.54/5.20/4.88）随时会静默回退；
     而 `--text-muted-on-glass` 的消费点（第二条消息的 time / .msg-meta / 元信息子节点）
     从来没有进入任何台账。

     [口径] 取样框 = 可见文本节点的 Range 包围盒；比值 = WCAG 2.1。
       床 = **注入 `color:transparent` 之后**同一框内像素的中位数（框里只剩底）；
       字 = **正常态**图里离床更远的那个极值像素。
       为什么床必须去字：框内含字时，字本身会把中位数往上拉。实测（本轮，暗档 12 个小框
       + 8 个大框）：**小框（面积 <900px²，如 54×13 的时间戳）去字比含字高 +0.03~+0.56、
       均值 +0.22 比值**；**大框反而更糟** —— `.msg` 那条含字 7.05、去字 7.99（**+0.94**），
       因为气泡是渐变底，含字时中位数会落在渐变偏亮的那一侧 —— 不是偏差小，是偏得看运气。
       ⇒ 结论：含字中位数在任何尺寸上都不可当床。4.68 会被量成 4.48，足以把合规判成不合规。
       方向不用 `luma(bed) > 128` 猜：暗档的床可能亮于 128 而墨色更亮，会猜反
       （实测 .msg-acts 条底 rgb(138,140,139)，旧法取到阴影边，量出 2.09 这种"尺子坏了"的数）。

     [维度] 13 块（镜像）+ `--text-muted-on-glass` 消费点（**全部实例**、按取样框去重后取最差）
     + 1 个 hover-only 控件（.msg-act，**单列**，见 T4-D4）。
     两个"不许"：① 不许 `querySelector` 只取首匹配 —— 实测 .msg-meta 首条 5.72、次条 4.68，
     取首匹配会系统性漏掉最差的那条；② hover-only 状态不许混进常态组。

     [上限] 次要文字比值 ≤ 7.0（推导见 T4-D3）。

     [测量边界 · 必须让后来人看见] 本段**冻结了动画**（`animation:none` / `transition:none`），
     所以量到的是**动画静止态**，不是**最差帧**。当前实现下两者恰好相同 ——
     18s 一个完整周期扫 24 帧，20 个取样点的 min/max 差全是 0.00（qa/r81-r2/dark-t4-frames.json），
     但这只是**当前实现的实测**，不是数学保证：以后任何新动画（扫光、呼吸、指针追光）
     落进这些取样框，都必须重跑帧扫描，不能拿这一刻的 0.00 当永久结论。
     另外本段**不覆盖**：悬停/聚焦之外的交互态、浏览器缩放与 DPR≠1、字体替换、
     用户壁纸更换（壁纸是外部输入，本门禁只测当前 assets/wallpaper.jpg）。
     ⇒ 它证明的是"静止态 + 当前壁纸 + 1x 下这批取样点达标"，**不是 WCAG 全场景已验证**。
     ========================================================================== */
  const t4d = { freeze: false, theme: 'light' };
  const t4dSetTheme = async (th) => {
    await page.evaluate(t => {
      if (window.__R72 && window.__R72.ThemeController && window.__R72.ThemeController.apply) window.__R72.ThemeController.apply(t);
      else if (t === 'light') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
    }, th);
    t4d.theme = th;
    await page.waitForTimeout(430);
  };
  const t4dFreeze = async (on) => {
    await page.evaluate(v => {
      const old = document.getElementById('t4d-freeze');
      if (old) old.remove();
      if (!v) return;
      const s = document.createElement('style');
      s.id = 't4d-freeze';
      s.textContent = '*{animation:none!important;transition:none!important}';
      document.head.appendChild(s);
    }, on);
    t4d.freeze = on;
    await page.waitForTimeout(90);
  };
  const t4dShot = async () => decodePng(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } }));
  const t4dInject = async (id, css) => {
    await page.evaluate(([i, c]) => {
      const old = document.getElementById(i);
      if (old) old.remove();
      if (!c) return;
      const s = document.createElement('style');
      s.id = i; s.textContent = c;
      document.head.appendChild(s);
    }, [id, css]);
    await page.waitForTimeout(170);
  };
  /* 床的取法（本轮修正）：**文字透明后取中位数**。
     为什么必须改：框内中位数在"字占比不低"的框上会把字算进底。实测 54×13 的小框，
     含字床比去字床高 +.02~.03（L），折算成比值偏低约 .2 —— 4.68 会被量成 4.48，
     足以把合规判成不合规（下表和 detail 里逐点打印两份数，偏差可复核）。
     大框（182×15 的附件芯片）偏差 <0.01，但既然要统一就统一改：
     对每个取样点先注入 `color:transparent` 拿一张"只有底"的图求床，
     再从**正常图**取字芯极值。两图之间只差文字着色，几何/滤镜/背景层一律不动。 */
  const T4D_TRANSPARENT = 'color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important';
  const boxKey = b => `${Math.round(b.x)}|${Math.round(b.y)}|${Math.round(b.w)}|${Math.round(b.h)}`;
  /* 同一段字形会被多个选择器命中（实测 time / .msg-meta / .msg-meta * 三者是同一个框），
     按**取样框**去重并合并别名：既避免同一块字重复计数，也避免父容器把子元素的字算成自己的。 */
  const t4dDedupe = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (r.miss) { map.set('miss:' + r.sel + ':' + r.idx, r); continue; }
      const k = boxKey(r);
      if (map.has(k)) map.get(k).alias.push(`${r.label}#${r.idx + 1}`);
      else map.set(k, { ...r, alias: [`${r.label}#${r.idx + 1}`] });
    }
    return [...map.values()];
  };
  /* 一对截图 → 逐点 {bed, ink, ratio}：textImg 有字（取字芯），bedImg 文字透明（取床） */
  const t4dPair = (points, textImg, bedImg) => points.map(p => {
    if (p.miss) return { ...p, ratio: 0 };
    const t = pixelContrastFar(textImg, p);
    const bm = pixelContrastFar(bedImg, p);
    if (!t || !bm) return { ...p, ratio: 0, miss: '像素不足' };
    const bed = bm.bg, bl = pxLuma(bed);
    const ink = Math.abs(pxLuma(t.lo) - bl) >= Math.abs(pxLuma(t.hi) - bl) ? t.lo : t.hi;
    const r = +ratio(ink, bed).toFixed(2);
    /* 含字口径（旧法）留作偏差档案 */
    return {
      ...p, bed, ink, ratio: r, bedL: +lum(bed).toFixed(4),
      containRatio: t.ratio, containBedL: +lum(t.bg).toFixed(4), bias: +(r - t.ratio).toFixed(2)
    };
  });
  /* .msg-act 的取样框（字框 + 元素框），床同样走"文字透明" */
  const t4dActBox = (sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    let chain = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain *= +getComputedStyle(n).opacity;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let pick = null, pw = -1;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.nodeValue || '').trim().length < 2) continue;
      const r0 = document.createRange(); r0.selectNodeContents(n);
      const w0 = r0.getBoundingClientRect().width;
      if (w0 > pw) { pw = w0; pick = n; }
    }
    if (!pick) return null;
    const rg = document.createRange(); rg.selectNodeContents(pick);
    const bb = rg.getBoundingClientRect();
    return {
      x: bb.x, y: bb.y, w: bb.width, h: bb.height, color: cs.color, chain: +chain.toFixed(3),
      text: (pick.nodeValue || '').trim()
    };
  }, sel);
  const t4dActMeasure = async () => {
    const b = await t4dActBox('.msg-act');
    if (!b) return null;
    const t1 = await t4dShot();
    await t4dInject('t4d-bed', '.msg-act{' + T4D_TRANSPARENT + '}');
    const t2 = await t4dShot();
    await t4dInject('t4d-bed', '');
    const m = t4dPair([b], t1, t2)[0];
    return { box: b, m };
  };

  try {
    await t4dSetTheme('dark');
    await t4dFreeze(true);
    /* 指针泊到中性点：指针追光（optics.js）会抬高取样区的床 */
    await page.mouse.move(2, 890);
    await page.waitForTimeout(240);

    /* 取样集合：13 块（镜像现役 T4，首匹配）+ 消费点（**全部实例**、按框去重） */
    const dB0 = await textBoxes(page, T4_BLOCKS);
    const mB0 = t4dDedupe(await textBoxesAll(page, T4D_MUTED));
    /* `.tok` 只作观察项采样（不判定）：它有可见实例，但不是这个令牌的消费者（见 T4D_MUTED 注释）。
       采样而不判，是为了"每一轮都能看见它"，而不是把它塞进断言冒充覆盖。 */
    const tokBoxes = await textBoxesAll(page, [{ sel: '.tok', label: '成本区Token数' }]);
    const allPoints = [
      ...dB0.map(b => ({ ...b, group: 'blocks' })),
      ...mB0.map(b => ({ ...b, group: 'muted' })),
      ...tokBoxes.map(b => ({ ...b, group: 'obs' }))
    ];
    const selUnion = [...new Set([...T4_BLOCKS.map(b => b.sel), ...T4D_MUTED.map(b => b.sel), '.tok'])]
      .join(',');
    const textShot = await t4dShot();
    await t4dInject('t4d-bed', selUnion + '{' + T4D_TRANSPARENT + '}');
    const bedShot = await t4dShot();
    await t4dInject('t4d-bed', '');
    const measured = t4dPair(allPoints, textShot, bedShot);
    const dRows = measured.filter(r => r.group === 'blocks');
    const mRows = measured.filter(r => r.group === 'muted');

    /* 偏差档案：含字 vs 去字，逐点两份数（回答"床口径改了多少"） */
    const biasRows = measured.filter(r => !r.miss);
    const biasMax = biasRows.reduce((a, b) => (Math.abs(b.bias) > Math.abs(a.bias) ? b : a), { bias: 0, label: '-' });
    const biasSmall = biasRows.filter(r => r.w * r.h < 900);

    /* ① 13 块镜像（暗档） */
    const dHit = dRows.filter(r => !r.miss);
    const dMin = dHit.reduce((a, b) => (b.ratio < a.ratio ? b : a), { label: '-', ratio: 99 });
    check('T4-D 暗档像素级正文对比度 >= 4.5（床=文字透明后中位数 · 字=字芯极值；13 块镜像）',
      dHit.length === T4_BLOCKS.length && dHit.every(r => r.ratio >= 4.5),
      `命中 ${dHit.length}/${T4_BLOCKS.length} 块（不得缺块）；最低 ${dMin.ratio}:1 @ ${dMin.label}；`
      + dHit.map(r => `${r.label} ${r.ratio}:1`).join(' · ')
      + ` ｜ 含字口径对照（旧法）：${dHit.map(r => `${r.label} ${r.containRatio}`).join('/')}`
      + `（最大偏差 ${Math.max(...dHit.map(r => Math.abs(r.bias))).toFixed(2)}）`
      + ` ｜ 床口径偏差档案（去字−含字）：小框(${biasSmall.length} 个) ${biasSmall.length ? Math.min(...biasSmall.map(r => r.bias)).toFixed(2) + '~' + Math.max(...biasSmall.map(r => r.bias)).toFixed(2) : 'n/a'}，`
      + `均值 ${(biasSmall.reduce((s, r) => s + r.bias, 0) / Math.max(1, biasSmall.length)).toFixed(2)}；`
      + `全样本最大 ${biasMax.bias} @ ${biasMax.label}`);

    /* ② 消费点：全部实例、去重后逐点 ≥4.5（= 取最差） */
    const mOk = mRows.filter(r => !r.miss);
    const mBad = mOk.filter(r => r.ratio < 4.5);
    const mTag = r => `${r.alias.join('+')} ${r.ratio}:1（床 L=${r.bedL}）`;
    check('T4-D2 暗档 --text-muted-on-glass 消费点 >= 4.5（全部实例去重取最差 · 床=去字中位数）',
      mOk.length >= 12 && mBad.length === 0,
      `去重后 ${mOk.length} 个取样框（12 = 附件芯片2 + 时间戳2 + 元信息子节点3 + 副标题1 + 导航分组3 + 眉标1；`
      + `time/.msg-meta/.msg-meta * 命中同一框已按框合并）；`
      + (mBad.length ? `**不达标 ${mBad.length} 个**：${mBad.map(mTag).join(' · ')}` : '全部达标')
      + ` ｜ 全表：${mOk.map(mTag).join(' · ')}`);

    /* ③ 上限：次要文字不得亮于主文字（关系腿是主判据，7.0 只是参考线）
       ── 为什么不再把 7.0 当硬阈值：那是"主文字当时实测 7.05"的**代理值**。
          本轮床口径改成去字之后，主文字 `.msg` 实测变成 **7.99** —— 代理值过期了
          （与 C03 的 17.50、OPT-17 的 15% 是同一类过期，不是"为过而放宽"）。
          正确的写法是**同一轮现测主文字**，让上限自己跟着主文字走。
       ── 上限 = 主文字 + 0.30 噪声带。为什么留 0.30：同一元素的重复测量、
          含字/去字两口径、帧间差，实测抖动 ≤.10~.20；0.30 = 1.5~3 倍噪声，
          避免把噪声判成"层级倒置"（本轮已有两次"红是探针造成的"教训）。
       ── 绝对锚仍然打印（WCAG AAA = 7.0），但只作为参考线：主文字一旦掉到 6.5，
          关系腿自动收紧到 6.5+.3，比 7.0 更严，不需要另设分支。 */
    const primaryRatio = (dHit.find(r => r.label === '消息正文') || {}).ratio;
    const capVal = typeof primaryRatio === 'number' ? +(primaryRatio + 0.3).toFixed(2) : T4D_CAP;
    const capBad = mOk.filter(r => r.ratio > capVal);
    check('T4-D3 暗档次要文字不得亮于主文字（≤ 主文字 +0.3 噪声带 · 防层级反转）',
      mOk.length >= 12 && typeof primaryRatio === 'number' && capBad.length === 0,
      `上限 = 主文字 .msg ${primaryRatio}:1 + .30 = ${capVal}（参考线 WCAG AAA 7.0，仅打印不作阈值）；`
      + (capBad.length ? `**越界 ${capBad.length} 个**：${capBad.map(r => `${r.alias.join('+')} ${r.ratio}:1（床 L=${r.bedL}）`).join(' · ')}`
        : '全部在上限内'));

    /* ③′ 风控（**warn · 不计入 PASS/FAIL**）：单令牌可行窗口还剩多少
       ── 为什么需要它：上限是"主文字 +.30"的关系腿，本轮落在 8.29；而全部
          `--text-muted-on-glass` 消费点的床跨 **2.42 倍**（最亮 .1215 / 最暗 .0503），
          单令牌能服务的床比渐近上限是 `cap/4.5 = 1.84 倍`。也就是说这个窗口
          只靠 WCAG 公式里的 `+.05` 常数项撑着，实测宽 **.060**（两端各 .030）。
          窗口塌之前 T4-D2/D3 **不会红** —— 不是越界，是余量没了。
       ── 判据：窗口宽度 < .02 时打 WARN。为什么是 .02：.02/4.5 ≈ .0044，
          与同一元素重复测量时床的抖动上限（实测 ≤.003~.005）同量级；
          再窄的窗口没有工程意义，不该被当成"可满足"。
       ── 它**不判红**：窗口收窄不是违规，只是"某个实例的床再动一点点就违规"。
       ── 反装饰自检：**注入量由窗口宽度反算**（R83 重标定，不再硬编码）。
          上一版写死「把上界绑定点的床 −.010」，拆令牌后窗口从 .0597 变 .1725，
          −.010 只能把宽度压到 .0896，永远够不到 .02 ⇒ 自检**静默失效**
          （它自己打印了"需重标定"，但一条印着自己失效的自检与静默失效后果相同）。
          现在解 `winOf(hiRow.bed + d).width = .010` 得 d（宽度对 d 单调 ⇒ 二分），
          目标带 `[.005, .015]`：既确实低于 .02，又不会负到离谱。窗口再变，自检自动跟随。
          每轮必须打印三件事：**实际注入量 / 注入后宽度 / 是否触发** —— 缺一不可核查。
       ── 阈值不写死实例名：按页面实际解析出的 `--text-muted-on-glass` 颜色归组，
          令牌换值时自动跟随（避免再次出现"7.05 代理值"那类过期）。 */
    const MUTED_MIN_WIN = 0.02;
    const mutedRgb = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.color = 'var(--text-muted-on-glass)';
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    });
    const winOf = (rows, cap) => {
      const loNeed = r => 4.5 * (r.bedL + 0.05) - 0.05;
      const hiAllow = r => cap * (r.bedL + 0.05) - 0.05;
      const loRow = rows.reduce((a, b) => (loNeed(b) > loNeed(a) ? b : a));
      const hiRow = rows.reduce((a, b) => (hiAllow(b) < hiAllow(a) ? b : a));
      return {
        lo: +loNeed(loRow).toFixed(4), hi: +hiAllow(hiRow).toFixed(4),
        width: +(hiAllow(hiRow) - loNeed(loRow)).toFixed(4), loRow, hiRow
      };
    };
    const winRows = mOk.filter(r => r.color === mutedRgb);
    const win = winOf(winRows, capVal);
    /* 上界要分「算术上界」与「有效上界」两个数：
       L 的值域只有 [0, 1]，算术上界 > 1 时那一侧在物理上**无约束力**，
       窗口的实质约束宽度只到 min(算术上界, 1)。只印算术值会让人误读成"还有 .10 余量"。
       触发条件是 **cap 变大**（cap 是"主文字 +.30"的关系腿，主文字一亮它就涨），
       不是"床变暗"——hi = cap×(bed+.05)−.05 对 bed 是**递增**的，床越暗上界越低。 */
    const winHiEff = Math.min(win.hi, 1);
    const winWidthEff = +(winHiEff - win.lo).toFixed(4);
    const winHiUnbound = win.hi > 1;
    const winDelta = +(win.width / capVal).toFixed(4);       /* 上界侧床再降这么多即破线 */
    /* ── 自检：注入量由窗口宽度反算（二分求解，不写死） ──
       解 d 使 winOf(hiRow.bed + d).width = .010；宽度对 d 单调递增 ⇒ 二分区间取 [−1, 0]
       （窗口当前宽 > 目标 ⇒ 根必在负侧）。托底：窗口本来就 ≤ .02 时规则已在触发，
       这一支不构造扰动，直接说明"无需自检"。 */
    const SELFTEST_BAND = [0.005, 0.015];
    const selftestTarget = (SELFTEST_BAND[0] + SELFTEST_BAND[1]) / 2;
    const widthAtD = (d) => winOf(
      winRows.map(r => (r === win.hiRow ? { ...r, bedL: +(r.bedL + d).toFixed(4) } : r)), capVal).width;
    let stDelta = null, winPert = { width: win.width }, stBandOk = true, stWhy = '';
    if (win.width <= MUTED_MIN_WIN) {
      stWhy = `窗口当前宽 ${win.width} ≤ ${MUTED_MIN_WIN}，规则**已在触发**，本行无需扰动`;
    } else {
      let a = -1, b = 0;
      for (let i = 0; i < 80; i++) {
        const m = (a + b) / 2;
        if (widthAtD(m) < selftestTarget) a = m; else b = m;
      }
      stDelta = +((a + b) / 2).toFixed(4);
      winPert = winOf(winRows.map(r => (r === win.hiRow ? { ...r, bedL: +(r.bedL + stDelta).toFixed(4) } : r)), capVal);
      stBandOk = winPert.width >= SELFTEST_BAND[0] && winPert.width <= SELFTEST_BAND[1];
      stWhy = `注入后宽 ${winPert.width} ${stBandOk ? '落在' : '**溢出**'}带 [${SELFTEST_BAND[0]}, ${SELFTEST_BAND[1]}]`
        + ` ｜ 是否触发 WARN = ${winPert.width < MUTED_MIN_WIN ? '是（规则非装饰）' : '否（自检仍失效，必须重标定）'}`;
    }
    result.t4dWindow = {
      cap: capVal, n: winRows.length, lo: win.lo, hi: win.hi, width: win.width,
      hiEffective: winHiEff, widthEffective: winWidthEff, hiUnconstrained: winHiUnbound,
      loLabel: win.loRow.alias.join('+'), loBed: win.loRow.bedL,
      hiLabel: win.hiRow.alias.join('+'), hiBed: win.hiRow.bedL,
      nextBreak: { side: '上界侧（该实例的床再降即破线）', label: win.hiRow.alias.join('+'), delta: winDelta },
      selfTest: { band: SELFTEST_BAND, target: selftestTarget, delta: stDelta,
        width: winPert.width, inBand: stBandOk, wouldWarn: winPert.width < MUTED_MIN_WIN },
      threshold: MUTED_MIN_WIN
    };
    const hiNote = winHiUnbound
      ? `**算术上界 ${win.hi} > 1 ⇒ 该侧无约束力**，有效上界取 1，有效宽 ${winWidthEff}`
      : `有效上界 = min(${win.hi}, 1) = ${winHiEff}，有效宽 ${winWidthEff}（与算术宽同值）`;
    if (win.width < MUTED_MIN_WIN) {
      const squeeze = `${win.hiRow.alias.join('+')}（床 L=${win.hiRow.bedL}）与 ${win.loRow.alias.join('+')}（床 L=${win.loRow.bedL}）挤压`;
      const act = win.width < 0
        ? `窗口**已闭合**，欠 ${(-win.width).toFixed(4)}：${win.hiRow.alias.join('+')} 的床需**抬高** ${(-win.width / capVal).toFixed(4)} 才回到窗口内`
        : `窗口只剩 ${win.width}：${win.hiRow.alias.join('+')} 的床再降 ${winDelta} 即破线`;
      warn('T4-D-WARN 暗档单令牌可行窗口收窄（不计 PASS/FAIL）',
        `窗口 [${win.lo}, ${win.hi}] 宽 ${win.width} < ${MUTED_MIN_WIN}（cap=${capVal}，${winRows.length} 个消费点）；主要被 ${squeeze}；${act}`);
    } else {
      console.log(`[WINDOW] 暗档单令牌窗口 [${win.lo}, ${win.hi}] 宽 ${win.width} ≥ ${MUTED_MIN_WIN}（不告警）`
        + ` ｜ 上界 ${win.hiRow.alias.join('+')}(床 ${win.hiRow.bedL}) · 下界 ${win.loRow.alias.join('+')}(床 ${win.loRow.bedL})`
        + ` ｜ 再降 ${winDelta} 即破线`);
    }
    console.log(`[WINDOW-BOUND] 算术上界 ${win.hi} / 有效上界 ${winHiEff}（L 值域 [0,1]）⇒ ${hiNote}`);
    console.log(`[WINDOW-SELFTEST] 注入量 ${stDelta === null ? 'n/a（无需扰动）' : stDelta}`
      + `（由窗宽反算，目标 .010）｜ ${stWhy}`);
    check('T4-DW 窗宽自检量反算（注入量由窗宽解出 · 注入后必落 [.005,.015] 且触发 WARN）',
      win.width <= MUTED_MIN_WIN || (stDelta !== null && stBandOk && winPert.width < MUTED_MIN_WIN),
      `窗口宽 ${win.width}（阈值 ${MUTED_MIN_WIN}）⇒ 注入量 ${stDelta === null ? 'n/a' : stDelta}`
      + ` ⇒ 注入后宽 ${winPert.width} ⇒ 落带=${stBandOk}、触发=${winPert.width < MUTED_MIN_WIN}`);

    /* ④ .msg-act：**hover-only，单列**（不混进常态组）
       ── 适用性判定：常态 `opacity:0` + `pointer-events:none` ⇒ 对所有人不可见，
          WCAG 1.4.3 不约束"不存在的文本"，这一态**不判**。
          操作条由 `.msg:hover` / `.msg:focus-within` 显形，显形后按钮是真实可见的 ⇒ 判两条真实路径：
            状态 B = 气泡 hover 显形、按钮自身未 hover（三个按钮都可见）
            状态 C = 按钮自身 hover（颜色与底都切到 hover 档）
          不能因为"要模拟 hover 麻烦"就排除。
       ── 床：与常态组同一套"文字透明后取中位数"（不再用内衬环特例）。 */
    const msgC = await t4dActBox('.msg');
    let actB = null, actF = null;
    const actCAll = [];
    /* 同一取样框的"文字透明"对照：指针必须**一直停在按钮上**再截图，
       否则 `.msg-acts` 的 opacity:0 会让你量到"气泡底 + 看不见的字"（第一次写探针就踩了）。 */
    const t4dMeasureAt = async (b) => {
      const t1 = await t4dShot();
      await t4dInject('t4d-bed', '.msg-act{' + T4D_TRANSPARENT + '}');
      const t2 = await t4dShot();
      await t4dInject('t4d-bed', '');
      return t4dPair([b], t1, t2)[0];
    };
    if (msgC) {
      await page.mouse.move(msgC.x + msgC.w / 2, msgC.y + msgC.h / 2);
      await page.waitForTimeout(330);
      actB = await t4dActMeasure();
      /* 全部实例：两条静态消息 × 3 按钮 = 6 个，**取最差**。
         只测首个会把第二条消息里更亮的床藏起来：实测首个 6.59–6.68、第二条消息里的
         "复制" 只有 5.15（与 time/.msg-meta 同一条教训：多实例不许取首个）。
         每次移入都要「气泡 → 按钮 → 1px 抖动」：`.msg-acts` 常态 pointer-events:none，
         指针直接从空白丢到按钮坐标上拿不到 :hover，且 none→auto 那一帧不补发 hover。 */
      const actBoxes = (await page.evaluate(() => [...document.querySelectorAll('.msg-act')].map((el, i) => {
        const r = el.getBoundingClientRect(), m = el.closest('.msg');
        const mr = m ? m.getBoundingClientRect() : null;
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let pick = null, pw = -1;
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!(n.nodeValue || '').trim()) continue;
          const rg0 = document.createRange(); rg0.selectNodeContents(n);
          const w0 = rg0.getBoundingClientRect().width;
          if (w0 > pw) { pw = w0; pick = n; }
        }
        if (!pick) return null;
        const rg = document.createRange(); rg.selectNodeContents(pick);
        const bb = rg.getBoundingClientRect();
        return {
          i, x: bb.x, y: bb.y, w: bb.width, h: bb.height,
          bx: r.x, by: r.y, bw: r.width, bh: r.height,
          msg: mr ? { x: mr.x, y: mr.y, w: mr.width, h: mr.height } : null,
          text: (pick.nodeValue || '').trim(), color: getComputedStyle(el).color
        };
      }))).filter(b => b && b.msg);
      for (const b of actBoxes) {
        await page.mouse.move(2, 890); await page.waitForTimeout(150);
        await page.mouse.move(b.msg.x + b.msg.w / 2, b.msg.y + b.msg.h / 2); await page.waitForTimeout(190);
        await page.mouse.move(b.bx + b.bw / 2, b.by + b.bh / 2); await page.waitForTimeout(60);
        await page.mouse.move(b.bx + b.bw / 2 + 1, b.by + b.bh / 2 + 1); await page.waitForTimeout(250);
        actCAll.push({ ...(await t4dMeasureAt(b)), idx: b.i, text: b.text });
      }
    }
    const actCWorst = actCAll.reduce((a, b) => (b.ratio < a.ratio ? b : a), { ratio: 99, bedL: 0, alias: ['-'], idx: 0, text: '-' });
    await page.mouse.move(2, 890);
    await page.waitForTimeout(200);
    /* 状态 F = 键盘 focus-visible。为什么它与 hover 是两条独立路径：
       `.msg-acts` 的显形靠 `.msg:hover` **或** `.msg:focus-within`；
       `.msg-act:hover` 与 `.msg-act:focus-visible` 在 CSS 里是两个选择器，
       任何一处被后加载规则覆盖，另一处不会跟着变（[state-rule-shadowed] 的反向版）。
       实测（本轮）：修复前 focus 路径 **4.36 < 4.5**，而门禁此前只量了 hover ——
       "只能靠鼠标才出来的操作条"那条老红线的延续：键盘用户走的是另一条取值路径。
       为了不重复"只测首个"的错，F 态测的是 C 态**最差的那个实例**。
       ⚠ `:focus-visible` 的匹配依赖"最后一次交互是键盘"：必须先 press('Tab')，
       再 programmatic focus()；否则 focus 成立但 :focus-visible 不成立，会量到常态色。 */
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    const fvMatch = await page.evaluate((idx) => {
      const els = [...document.querySelectorAll('.msg-act')];
      const el = els[idx] || els[0];
      if (!el) return null;
      el.focus();
      return { focusVisible: el.matches(':focus-visible'), active: document.activeElement === el, idx };
    }, actCWorst.idx || 0);
    await page.waitForTimeout(260);
    if (fvMatch && fvMatch.focusVisible) {
      const fm = await t4dMeasureAt(actCWorst);
      /* 墨色必须**在 focus 之后**读：actCWorst.color 是循环前快照（那时还没 hover/focus），
         直接拿来打印会写出"状态F 的墨色是次要色"这种与事实相反的明细（第一次就写错了）。 */
      const fColor = await page.evaluate((idx) => {
        const els = [...document.querySelectorAll('.msg-act')];
        return els[idx] ? getComputedStyle(els[idx]).color : null;
      }, actCWorst.idx || 0);
      actF = { box: { ...actCWorst, color: fColor }, m: fm };
    }
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.mouse.move(2, 890);
    await page.waitForTimeout(180);
    const actOk = !!(actB && actB.m) && actB.m.ratio >= 4.5
      && actCAll.length >= 6 && actCAll.every(r => r.ratio >= 4.5)
      && !!(actF && actF.m) && actF.m.ratio >= 4.5;
    check('T4-D4 暗档 .msg-act 悬停/键盘显形后 >= 4.5（6 实例取最差 · 含 focus-visible；opacity:0 态不判）',
      actOk,
      actB && actB.m && actCAll.length
        ? `状态B（气泡 hover 显形·按钮未 hover）${actB.m.ratio}:1（床 L=${actB.m.bedL}，墨色 ${actB.box.color}）；`
          + `状态C（按钮 hover·全部 ${actCAll.length} 个取最差）**${actCWorst.ratio}:1** @「${actCWorst.text}」#${actCWorst.idx + 1}（床 L=${actCWorst.bedL}）；`
          + `全表 ${actCAll.map(r => r.ratio).join('/')}；`
          + (actF && actF.m
            ? `状态F（键盘 focus-visible·最差实例）${actF.m.ratio}:1（床 L=${actF.m.bedL}，墨色 ${actF.box.color}）`
            : `状态F（键盘 focus-visible）**取不到**（:focus-visible 未匹配 ⇒ 键盘路径未验证，判红）`)
          + `；含字口径会给 ${actB.m.containRatio}/${actCWorst.containRatio}（该框 26×15 字占多数，旧法失效，故本行一律走去字口径）`
        : '取不到 .msg-act 的可见态（正样本缺失 ⇒ 判红）');
    if (actF && actF.m) {
      /* 键盘与鼠标两条路径的差值是"尺子稳定性"证据。注意两者**不是同一实例同一床**：
         C 取 6 个里的最差、F 取同一个实例的 focus 态（气泡没有 hover 衬底，床会略暗），
         所以 Δ 不是"方法差"，而是"状态差"。本轮 F 反而比 C 高 0.40（床 .1142 vs .1299）。 */
      console.log(`[FOCUS-HOVER] 状态F ${actF.m.ratio} vs 状态C(最差) ${actCWorst.ratio}（Δ=${+(actF.m.ratio - actCWorst.ratio).toFixed(2)}）`);
    }

    /* ⑤ 区分力负控：把三块的字压到明显不达标 ⇒ 必须全红；还原 ⇒ 必须全绿。
       负控移除的是**被判量本身**（文字色）。 */
    const ctrlBlocks = [
      { sel: '#mainStage .panel-title', label: '台面标题' },
      { sel: '#mainStage .panel-sub', label: '台面副标题' },
      { sel: '.stage-head .eyebrow', label: '台面眉标' }
    ];
    const ctrlBox0 = await textBoxes(page, ctrlBlocks);
    const ctrlSel = '#mainStage .panel-title,#mainStage .panel-sub,.stage-head .eyebrow';
    /* ★ R83 · D5 换尺：与 T4-D2 同口径（去字求床 + 正常图取字芯），不再用 pixelContrastFar 的含字读数。
       为什么必须换：含字口径对 11px 小字框**系统性低读 .18~.23**
         （眉标真值 4.68 被读成 4.45、副标题 5.28→5.10、元信息子节点 6.91→6.73），
         于是"还原必须 ≥4.5"永远差一口气 —— 那是尺子的错，不是颜色的错。
       现场：qa/r81-r2/verify-d5-repro.log（130/131，回绿 2/3）与 §22。
       A 方案（只把 backGreen 改成相对比对）单独不够：一把系统性偏移的尺子会让
       三条腿一起偏、差值抵消，D5 照样绿 —— 这正是本轮第三次被"尺子"坑。 */
    const ctrlBaseShot = await t4dShot();
    await t4dInject('t4d-ctrl-bed', ctrlSel + '{' + T4D_TRANSPARENT + '}');
    const ctrlBedShot = await t4dShot();
    await t4dInject('t4d-ctrl-bed', '');
    const ratiosAt = (img) => t4dPair(ctrlBox0, img, ctrlBedShot).map(r => (r.miss ? null : r.ratio));
    const baseRatios = ratiosAt(ctrlBaseShot);
    await t4dInject('t4d-neg', ctrlSel + '{color:rgba(70,80,75,.30)!important;-webkit-text-fill-color:rgba(70,80,75,.30)!important}');
    const negRatios = ratiosAt(await t4dShot());
    await t4dInject('t4d-neg', '');
    const backRatios = ratiosAt(await t4dShot());
    const negRed = negRatios.filter(r => r !== null && r < 4.5).length;
    /* 还原的语义是「回到基线」，不是「达到 4.5」：4.5 是 T4-D2 的合规线，
       D5 只负责证明「判据能区分 + 撤销可还原」。在这里再判一次绝对阈值，
       等于让同一件事被两把尺子判两遍，尺子一换就自相矛盾。 */
    const backGreen = backRatios.filter((r, i) =>
      r !== null && baseRatios[i] !== null && Math.abs(r - baseRatios[i]) <= 0.02).length;
    check('T4-D5 暗档判据有区分力（注入坏色必须全红 · 撤销后必须回到基线值 ±.02）',
      negRed === 3 && backGreen === 3,
      `注入 rgba(70,80,75,.30)：${ctrlBlocks.map((b, i) => `${b.label} ${baseRatios[i]}→${negRatios[i]}`).join(' · ')} `
      + `⇒ 翻红 ${negRed}/3；撤销后 ${backRatios.join('/')}`
      + `（基线 ${baseRatios.join('/')}，逐项 |Δ| ${backRatios.map((r, i) => (r === null || baseRatios[i] === null ? 'n/a' : Math.abs(r - baseRatios[i]).toFixed(2))).join('/')}）`
      + ` ⇒ 回基线 ${backGreen}/3；口径=去字床+字芯（与 T4-D2 同尺）`);
    /* D6 的对手量仍是 pixelContrastFar（含字），所以它的基线必须单独算一份：
       把去字基线和含字读数混用，等于在 D6 里偷偷换了尺子。D6 行为保持不变。 */
    const baseRatiosContain = ctrlBox0.map(b => (b.miss ? null : (pixelContrastFar(ctrlBaseShot, b) || {}).ratio));

    /* ⑥ 恒真对照：同一块文字，墨调亮比值必须上升、墨压到贴床必须掉到低位。 */
    const monoB = ctrlBox0[0];
    await t4dInject('t4d-mono', '#mainStage .panel-title{color:#FFFFFF!important}');
    const iBright = await t4dShot();
    const rBright = monoB.miss ? null : (pixelContrastFar(iBright, monoB) || {}).ratio;
    await t4dInject('t4d-mono', '#mainStage .panel-title{color:#1A1A18!important}');
    const iDark = await t4dShot();
    const rDark = monoB.miss ? null : (pixelContrastFar(iDark, monoB) || {}).ratio;
    await t4dInject('t4d-mono', '');
    check('T4-D6 测量单调性（墨更亮 ⇒ 比值上升；墨贴床 ⇒ 骤降，排除恒红/恒绿）',
      rBright !== null && rDark !== null && rBright > baseRatiosContain[0] + 0.3 && rDark < 2.5 && rDark < baseRatiosContain[0] - 2,
      `台面标题：基线（含字口径，与 rBright/rDark 同尺）${baseRatiosContain[0]} → 注入 #FFFFFF ${rBright}（须 > 基线+.3）→ 注入 #1A1A18 ${rDark}（须 <2.5 且比基线低 2 以上）`);

    /* ⑧ T4-D9 尺子标定（常驻）—— 本轮最重要的一条。
       本轮三次误判全部是**尺子**问题、不是颜色问题：
         · 4.38 —— 探针污染（指针移入前就截图，床还没稳定）
         · 4.54 —— 含字口径低读（眉标真值 4.68 被读成 4.54）
         · D5 的 .23 —— 同一把含字尺把「撤销回到基线」判成「不达标」
       没有这条，"去字口径"本身就是一个**没人验过的假设**。
       做法：建一个受控探针元素（position:fixed，不参与页面布局，无滤镜/无阴影/无渐变），
       四条腿一起判：
         a) 床尺：#808080 纯色 + 文字透明 ⇒ 框内中位数 L 必须 = L(#808080)=.2159（±.005）
         b) 墨尺：#1A1A18 底 + #FFFFFF 字 ⇒ 框内**最亮**像素 L 必须 ≥ .98（−.01 下沿）
         c) 床尺负控：#7A7A7A（L=.1946，与 .2159 差 .0213）⇒ 必须**超出** ±.005；
            若有人把容差放宽到 .05，这条立刻红 —— 容差不是虚设
         d) 空间负控：480px 中亮度渐变（#606060→#C0C0C0），**40px 取样框**整体右移 120px
            ⇒ 床 L 必须变化 > .005；证明取样框真的在取几何，而不是返回一个与位置无关的常数。
            （R83 两次修正，都是**负控设计错**、不是取样器错：
              · 初版「40px 渐变 + 右移 4px」：框和渐变同宽，只能滑出去不能滑过去，理论 Δ 仅 .0053
              · 二版「240px 渐变 + 240px 宽框右移 40px」实测 Δ=.0042 —— 线性渐变的**中位数对等宽窗口平移不敏感**：
                窗口右移换掉的那部分正好由滑进窗口的平底补上，中位数落在几乎同一绝对列
              · 现版把取样框缩到 40px、渐变 480px，框在渐变内部滑动，中位数随框心 1:1 移动 ⇒ Δ 实测 .0742）
            位移取 120px 而非 3px：3px 在 480px 坡道上只值 .0024 L，低于本判据阈值，做不成负控。
       为什么用探针元素而不是页面真实文字：11px 眉标的字芯受抗锯齿影响最高只到 **.8148**
       （实测 qa/r81-r2/ruler-probe.log），拿它验墨尺会把"字体渲染"记成"尺子坏了"。
       探针只标定**测量管线**（解码 → 中位数/极值 → WCAG），这正是要验的东西。 */
    const L_GRAY = +lum([128, 128, 128]).toFixed(4);
    const rulerProbe = async (o) => page.evaluate((o2) => {
      const old = document.getElementById('t4d-ruler');
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 't4d-ruler';
      el.textContent = 'HAMBURG';
      const fs = o2.fs || 32;
      Object.assign(el.style, {
        position: 'fixed', left: '8px', top: '8px', width: (o2.w || 360) + 'px',
        height: Math.round(o2.h || fs * 1.5) + 'px',
        fontSize: fs + 'px', lineHeight: Math.round(fs * 1.5) + 'px', fontWeight: '700',
        fontFamily: 'Arial, Helvetica, sans-serif', background: o2.bg, color: o2.fg,
        padding: '0', margin: '0', border: '0', zIndex: '99999', letterSpacing: '0', boxShadow: 'none'
      });
      document.body.appendChild(el);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, o);

    let rBox = await rulerProbe({ bg: '#808080', fg: 'transparent' });
    await page.waitForTimeout(130);
    const rBed = pixelContrastFar(await t4dShot(), rBox);
    const bedRulerL = rBed ? +lum(rBed.bg).toFixed(4) : null;

    rBox = await rulerProbe({ bg: '#7A7A7A', fg: 'transparent' });
    await page.waitForTimeout(130);
    const rBedNeg = pixelContrastFar(await t4dShot(), rBox);
    const bedNegL = rBedNeg ? +lum(rBedNeg.bg).toFixed(4) : null;

    rBox = await rulerProbe({ bg: '#1A1A18', fg: '#FFFFFF' });
    await page.waitForTimeout(130);
    const rInk = pixelContrastFar(await t4dShot(), rBox);
    const inkRulerL = rInk ? +lum(rInk.hi).toFixed(4) : null;

    rBox = await rulerProbe({ bg: 'linear-gradient(90deg,#606060 0%,#C0C0C0 100%)', fg: 'transparent', w: 480 });
    await page.waitForTimeout(130);
    const gradImg = await t4dShot();
    const gBox = { ...rBox, w: 40 };                       /* 取样框 40px，必须窄于渐变才能在里面滑动 */
    const gA = pixelContrastFar(gradImg, gBox);
    const gB = pixelContrastFar(gradImg, { ...gBox, x: gBox.x + 120 });
    const shiftDelta = (gA && gB) ? +Math.abs(lum(gB.bg) - lum(gA.bg)).toFixed(4) : null;
    await page.evaluate(() => { const el = document.getElementById('t4d-ruler'); if (el) el.remove(); });

    /* 三个容差只在这里定义一次：正控与负控**共用同一个常量**。
       这是 "放宽容差必须翻红" 的结构性保证 —— 谁把 BED_TOL 从 .005 放宽到 .05，
       负控 #7A7A7A（偏离 .0213）立刻不再满足 > BED_TOL，本条当场红。
       若两条各写一个字面量，放宽正控那条负控不会跟着红，就只是装饰。 */
    const BED_TOL = 0.005, INK_MIN = 0.99, SPACE_TOL = 0.005;
    const bedDev = bedRulerL === null ? 99 : +Math.abs(bedRulerL - L_GRAY).toFixed(4);
    const bedNegDev = bedNegL === null ? 0 : +Math.abs(bedNegL - L_GRAY).toFixed(4);
    check('T4-D9 去字床/字芯尺子标定（受控探针 · 床 #808080 · 墨 #FFF/#1A1A18 · 含床尺与空间两条负控）',
      bedDev <= BED_TOL && inkRulerL !== null && inkRulerL >= INK_MIN
      && bedNegDev > BED_TOL && shiftDelta !== null && shiftDelta > SPACE_TOL,
      `床尺 ${bedRulerL}（应=${L_GRAY}±${BED_TOL}，偏差 ${bedDev}）；墨尺 ${inkRulerL}（应≥${INK_MIN}）；`
      + `床尺负控 #7A7A7A ${bedNegL}（应偏离 >${BED_TOL}，实测 ${bedNegDev}）；`
      + `空间负控 480px 渐变（40px 框）右移 120px Δ=${shiftDelta}（应 >${SPACE_TOL}）`);

    /* ⑨ T4-D8 暗档次要文字组**上下双界 [4.5, 7.0]**（去字床 / 按取样框去重 / 多实例取最差）
       ── 测法与 T4-D2 完全同源：直接用上面已量好的 mOk（去字床中位数 + 正常图字芯），
          **不另写测量函数**，避免"同一条判据两把尺子"。
       ── 下界 4.5 = WCAG AA 正文；上界 7.0 = WCAG AAA。
       ⚠ 7.0 在**全局 muted 组**曾经是**空集**：床域 .0503~.1215（**2.42×**）时，
         上界由最暗床(.0503)定、下界由最亮床(.1215)定 ⇒ hi−lo = −.0696（空）。
         它现在**可达**，唯一原因是 `nav-group` 三实例（床 .0503/.0522）已拆到
         `--text-muted-on-deep-glass`，全局组退化为 on-glass 组，床域收窄到
         **.0639 ~ .1215（1.90×）**。
       ⚠ **交集的非空性是 `+.05` 常数项撑出来的，不是结构健康**：
         窗宽 = 7.0·bedMin − 4.5·bedMax + .125 = .0256（= .4473 − .5468 + .125）。
         当前墨 `#E0DFDA` 落在 **4.59 / 6.91**，两端各 **.09**。
       ⇒ **若将来有任何新消费者带着床比 > 1.9× 加入本组，这组会重新变空集。**
         新增消费点必须先量床、再决定归哪一组，**不许直接挂 `--text-muted-on-glass`**。
       ⚠ 口径精度（别把两件事混成一件）：上面 1.90× 是**单令牌窗**（`--text-muted-on-glass`）
         的床域，对应 D3 / D-WARN。**T4-D8 判的是两个令牌共 12 个框的并集**，床域仍是
         .0503~.1215（**2.42×**）—— 它能过，是因为每个令牌各自配了墨（on-glass #E0DFDA /
         deep-glass #D3D2CC），**不是因为床域收窄**。床域收窄只让"单令牌"这一侧重新可行。
       ── 与 T4-D3 的 8.29 是**两条独立腿**，不是重复判据：
          D3 = 关系腿（次要 ≤ 主文字+.30，随主文字浮动，防层级倒置）；
          D8 = 绝对腿（≤ AAA 7.0，钉死上限，不随主文字漂）。
          D3 更严时由 D3 拦，D8 更严时由 D8 拦；删掉任一条都会留一个盲区。
       ── 数学口径警示（**容易复发的错误类型**）：`cap/4.5 = 1.556×` 是**渐近式**，
          它忽略了 WCAG 公式里的 `+.05`。有限常数项下的真实条件是
          `bedMax ≤ (cap·bedMin + .05·(cap−4.5))/4.5`，比 1.556× 宽。
          本轮就有人（包括我）据渐近式断言"单令牌不可能/可能"，两种说法都得用有限式复核。 */
    const D8_LO = 4.5, D8_HI = 7.0, D8_THIN = 0.10;
    const d8BadLo = mOk.filter(r => r.ratio < D8_LO);
    const d8BadHi = mOk.filter(r => r.ratio > D8_HI);
    const d8Thin = mOk.filter(r => r.ratio >= D8_LO && r.ratio <= D8_HI
      && (r.ratio - D8_LO < D8_THIN || D8_HI - r.ratio < D8_THIN));
    const d8Min = mOk.reduce((a, b) => (b.ratio < a.ratio ? b : a), { ratio: 99 });
    const d8Max = mOk.reduce((a, b) => (b.ratio > a.ratio ? b : a), { ratio: -1 });
    check('T4-D8 暗档次要文字上下双界 [4.5, 7.0]（去字床 · 按框去重 · 多实例取最差）',
      mOk.length >= 12 && d8BadLo.length === 0 && d8BadHi.length === 0,
      `${mOk.length} 框 · min ${d8Min.ratio}:1（${(d8Min.alias || [d8Min.label]).join('+')}，床 L=${d8Min.bedL}）`
      + ` · max ${d8Max.ratio}:1（${(d8Max.alias || [d8Max.label]).join('+')}，床 L=${d8Max.bedL}）`
      + ` ⇒ 下界 +${(d8Min.ratio - D8_LO).toFixed(2)} / 上界 +${(D8_HI - d8Max.ratio).toFixed(2)}`
      + (d8BadLo.length || d8BadHi.length
        ? `；**越界**：${[...d8BadLo.map(r => `${(r.alias || [r.label]).join('+')} ${r.ratio} < ${D8_LO}`),
          ...d8BadHi.map(r => `${(r.alias || [r.label]).join('+')} ${r.ratio} > ${D8_HI}`)].join(' · ')}`
        : '')
      + `；薄冰带(<${D8_THIN}) ${d8Thin.length} 框`);
    /* T4-D8 的两条负控 + 还原（放最后：要注入/撤销样式，避免扰动 D4~D7 的 hover 态测量）。
       床图每次都重拍 —— 虽然改字色不改背板，但"负控复用主测的床图"会留下一个
       "床到底是什么时候取的"的口实，多拍两张比解释便宜。 */
    const d8Sel = [...new Set(T4D_MUTED.map(b => b.sel))].join(',');
    const d8Restore = async () => {
      await t4dInject('t4d-d8-text', ''); await t4dInject('t4d-d8-bed', '');
    };
    /* a) 白墨 #FFFFFF ⇒ 上界必须翻红 */
    await t4dInject('t4d-d8-text', d8Sel + '{color:#FFFFFF!important;-webkit-text-fill-color:#FFFFFF!important;text-shadow:none!important}');
    const d8aText = await t4dShot();
    await t4dInject('t4d-d8-bed', d8Sel + '{' + T4D_TRANSPARENT + '}');
    const d8aBed = await t4dShot();
    await d8Restore();
    const d8aRows = t4dPair(mOk, d8aText, d8aBed);
    const d8aOver = d8aRows.filter(r => r.ratio > D8_HI);
    check('T4-D8a 负控·上界（注入 #FFFFFF ⇒ 必须越 7.0 翻红）',
      d8aOver.length >= 1,
      `max ${Math.max(...d8aRows.map(r => r.ratio))}:1（须 > ${D8_HI}）· 越界 ${d8aOver.length}/${d8aRows.length} 框`
      + ` ｜ 越界最多：${d8aOver.slice().sort((a, b) => b.ratio - a.ratio).slice(0, 3).map(r => `${(r.alias || [r.label]).join('+')} ${r.ratio}`).join(' · ')}`);
    /* b) 坏色 rgba(70,80,75,.30) ⇒ 下界必须翻红 */
    await t4dInject('t4d-d8-text', d8Sel + '{color:rgba(70,80,75,.30)!important;-webkit-text-fill-color:rgba(70,80,75,.30)!important}');
    const d8bText = await t4dShot();
    await t4dInject('t4d-d8-bed', d8Sel + '{' + T4D_TRANSPARENT + '}');
    const d8bBed = await t4dShot();
    await d8Restore();
    const d8bRows = t4dPair(mOk, d8bText, d8bBed);
    const d8bUnder = d8bRows.filter(r => r.ratio < D8_LO);
    check('T4-D8b 负控·下界（注入 rgba(70,80,75,.30) ⇒ 必须跌破 4.5 翻红）',
      d8bUnder.length >= 1,
      `min ${Math.min(...d8bRows.map(r => r.ratio))}:1（须 < ${D8_LO}）· 越界 ${d8bUnder.length}/${d8bRows.length} 框`);
    /* c) 撤销 ⇒ 必须回到基线（±.02）；不回到基线说明负控改动了页面而不是只改了字色 */
    const d8cText = await t4dShot();
    await t4dInject('t4d-d8-bed', d8Sel + '{' + T4D_TRANSPARENT + '}');
    const d8cBed = await t4dShot();
    await t4dInject('t4d-d8-bed', '');
    const d8cRows = t4dPair(mOk, d8cText, d8cBed);
    const d8cBack = d8cRows.filter((r, i) => r.ratio !== null && mOk[i].ratio !== null
      && Math.abs(r.ratio - mOk[i].ratio) <= 0.02).length;
    check('T4-D8c 负控撤销必须回到基线（逐框 |Δ| ≤ .02）',
      d8cBack === mOk.length,
      `回基线 ${d8cBack}/${mOk.length}；逐项 |Δ| ${d8cRows.map((r, i) => Math.abs(r.ratio - mOk[i].ratio).toFixed(2)).join('/')}`);

    result.t4dBias = measured.filter(r => !r.miss).map(r => ({ label: r.alias ? r.alias.join('+') : r.label, box: [Math.round(r.w), Math.round(r.h)], ratio: r.ratio, containRatio: r.containRatio, bias: r.bias }));

    /* ⑦ 观察项（不判定）：`.tok` —— 全页唯一实例是成本区 `#tokenValue`，
       可见（67×13 @1026,843），但**不是** `--text-muted-on-glass` 的消费者
       （views.css:2000 的 `#mainStage .tok` 因宿主不在 #mainStage 内而空转）。
       它自己是一条独立缺陷（实测 2.81），归「成本区次要读数」票，不混进本组。 */
    const tokRow = measured.find(r => r.sel === '.tok');
    result.t4dTokObservation = tokRow && !tokRow.miss
      ? { ratio: tokRow.ratio, bedL: tokRow.bedL, note: '可见实例存在，但不是 muted-on-glass 消费者；规则空转，另票' }
      : { ratio: null, note: '未取到' };

    /* ⑦ 上限的区分力负控：把芯片墨色换回 #E2E1DC（= 修复前那一版），必须越过上限。
       为什么必须有这一条：R82 修复后芯片实测回到 5.46，上限自然绿了 —— 如果就此收工，
       这条上限就变成"永远为真"的装饰。这里主动把被判量推回旧值，证明它能红。
       床沿用 bedShot（床与墨色无关），只补一张"注入后"的图。 */
    const chipPts = mRows.filter(r => r.sel === '#mainStage .attach-chip' && !r.miss);
    await t4dInject('t4d-cap', '#mainStage .attach-chip{color:#E2E1DC!important}');
    const capShot = await t4dShot();
    await t4dInject('t4d-cap', '');
    const capRows = t4dPair(chipPts, capShot, bedShot);
    const capHit = capRows.filter(r => r.ratio > capVal);
    check('T4-D7 上限判据有区分力（把芯片墨色推回 #E2E1DC 必须越过上限）',
      chipPts.length > 0 && capRows.length === chipPts.length && capHit.length === chipPts.length,
      chipPts.length
        ? '芯片 ' + chipPts.length + ' 个实例：现值 ' + chipPts.map(r => r.ratio).join('/')
          + ' → 注入 #E2E1DC 后 ' + capRows.map(r => r.ratio).join('/')
          + '（须全部 > ' + capVal + '）'
        : '取不到芯片实例 ⇒ 无法证明上限非恒真，判红');

    /* ⑧ 明档兼容性：新方向法 + 去字床在明档 13 块上跑一遍，与现役口径对照（证据，不单独计 check） */
    await t4dSetTheme('light');
    await page.waitForTimeout(160);
    const lB = await textBoxes(page, T4_BLOCKS);
    const lText = await t4dShot();
    await t4dInject('t4d-bed', T4_BLOCKS.map(b => b.sel).join(',') + '{' + T4D_TRANSPARENT + '}');
    const lBed = await t4dShot();
    await t4dInject('t4d-bed', '');
    const lRows = t4dPair(lB.filter(b => !b.miss), lText, lBed);
    result.t4dLightParity = {
      blocks: lRows.length,
      ratios: lRows.map(r => r.ratio),
      containRatios: lRows.map(r => r.containRatio),
      maxBias: lRows.length ? Math.max(...lRows.map(r => Math.abs(r.bias))) : null
    };

    /* ════════════════════════════════════════════════════════════════════════
       ⑩ T4-D10 / T4-D11 —— 两条 tablist（.capability-tabs / .res-tabs）的
          常态对比度 + hover 态结构
       ════════════════════════════════════════════════════════════════════════
       【为什么 D10 用 computed 而不是像素】
         R82 给两条 tab 都垫了**不透明**承托底（`background: var(--color-raised)`），
         床从此是容器自身的 backgroundColor，不再是"玻璃×壁纸的合成面"。
         不透明床 ⇒ 床是一个确定的颜色字符串，computed 口径是**精确值**，
         不是近似；改用像素反而把抗锯齿/字芯方向选择引进来（本轮复核 3 已证
         1× 下字芯偏置≈0，但那是另一条结论，不能借来给口径背书）。
       【D10 前置断言 · 不能省】
         承托底的 backgroundColor alpha 必须 === 1。
         少这一条，将来谁把 `background: var(--color-raised)` 删回去，
         容器 alpha 变 0，下面 12 个读数**照样算得出来**（拿 alpha=0 当床、
         比值虚高），判据会静默变绿 —— 这正是本轮"量到不该量的东西"的同一类病。
       【D10 边界声明】
         · 只判**常态**（未悬停、未聚焦、非 disabled）的字色 vs 承托底。
           hover 见 T4-D11；选中态见 qa/r81-r2/probe-selected-states.mjs（另票口径）。
         · 阈值 5.0 而非 4.5：4.5 是 WCAG AA 正文法条下限，5.0 是留 ~11% 余量挡"贴线"。
           这是**工程余量**，不是把法条改严；越界时 detail 会打印实际值供裁量。
         · 不覆盖：浏览器缩放 / DPR≠1 / 字体替换（与 T4-D 段同一份边界）。
       【D11 为什么全是 computed】
         hover 态判的是**颜色来源**（是否仍取 accent、下划线是否仍透明），
         不是"看起来多亮"。computed 能直接回答"这条声明被哪条规则赢了"，
         像素只能回答"最终长什么样"，对"顺序/特异性"这类结构问题没有分辨力。
       ════════════════════════════════════════════════════════════════════════ */
    const prgb = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    const readTabs = async () => page.evaluate(() => {
      const pr = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }; };
      const out = [];
      /* 运行时实测有 **3** 个容器：.capability-tabs（panel-mcp）、.res-tabs（右侧观测窗）、
         以及 375 抽屉的克隆 `.res-tabs.res-tabs--mirror`（常驻 [hidden]，rect 0×0）。
         克隆不参与判据：它不可见、hover 会超时，且它与本体同规则 —— 计进来只会把
         "12 读数"变成"18 读数"并让负控分母失真。排除方式用 `:not(.res-tabs--mirror)`，
         不靠"跑的时候它恰好隐藏"这种时序事实。 */
      for (const cont of document.querySelectorAll('.capability-tabs, .res-tabs:not(.res-tabs--mirror)')) {
        const cc = getComputedStyle(cont);
        const btns = [...cont.querySelectorAll('button')];
        btns.forEach((b, i) => {
          const cs = getComputedStyle(b);
          out.push({
            cont: cont.className.split(/\s+/)[0], i,
            btn: (b.textContent || '').trim().slice(0, 6),
            selected: b.getAttribute('aria-selected') === 'true',
            bed: pr(cc.backgroundColor), bgImage: cc.backgroundImage,
            fg: pr(cs.color), bb: pr(cs.borderBottomColor), bw: cs.borderBottomWidth,
            visible: b.getBoundingClientRect().width > 1
          });
        });
      }
      return out;
    });
    /* 前景带 alpha 时按 over 合成到床（与浏览器合成一致），再做 WCAG */
    const flat = (fg, bed) => fg.a >= 1 ? fg.rgb : [0, 1, 2].map(i => Math.round(fg.rgb[i] * fg.a + bed.rgb[i] * (1 - fg.a)));

    const tabGroups = await page.evaluate(() => [...document.querySelectorAll('.capability-tabs, .res-tabs:not(.res-tabs--mirror)')].map(c => {
      const p = c.closest('.view-panel');
      return { sel: '.' + c.className.split(/\s+/)[0], view: p ? (p.id || '').replace('panel-', '') : '', n: c.querySelectorAll('button').length };
    }));

    /* ---- D10 ---- */
    const d10 = [];
    for (const th of ['light', 'dark']) {
      await t4dSetTheme(th);
      for (const g of tabGroups) {
        if (g.view) { await page.evaluate(v => document.querySelector(`.view-nav button[data-view="${v}"]`)?.click(), g.view); await page.waitForTimeout(320); }
        const rows = await readTabs();
        for (const r of rows.filter(x => x.cont === g.sel.replace('.', ''))) d10.push({ theme: th, ...r });
      }
    }
    const d10Bad = d10.filter(r => !r.bed || r.bed.a !== 1);
    const d10Ratios = d10.map(r => ({ theme: r.theme, cont: r.cont, btn: r.btn, selected: r.selected, bedA: r.bed ? r.bed.a : null, ratio: r.bed && r.fg ? +ratio(flat(r.fg, r.bed), r.bed.rgb).toFixed(2) : null }));
    const d10Min = d10Ratios.reduce((a, b) => (b.ratio !== null && (a.ratio === null || b.ratio < a.ratio) ? b : a), { ratio: null });
    /* 负控：把承托底注入成与字同色 ⇒ 12 个读数必须全部跌破 5.0
       ⚠ 必须**逐主题**跑：承托底与字色都是主题令牌，只跑当前主题只会拿到 6 个读数。
         这里要求 12/12 全部跌破 —— 若只有一半变红，说明"注入"只对一半元素生效。 */
    const d10Neg = [];
    for (const th of ['light', 'dark']) {
      await t4dSetTheme(th);
      await t4dInject('t4d-d10', '.capability-tabs,.res-tabs{background:var(--color-muted)!important}');
      const rr = await readTabs();
      await t4dInject('t4d-d10', '');
      for (const r of rr) d10Neg.push(r.bed && r.fg ? +ratio(flat(r.fg, r.bed), r.bed.rgb).toFixed(2) : null);
    }
    await t4dSetTheme('light');
    check('T4-D10 tab 文字常态对比度（前置断言：承托底 backgroundColor alpha === 1）',
      d10.length === 12 && d10Bad.length === 0,
      d10.length !== 12 ? `读数只有 ${d10.length} 个（应 12）`
        : d10Bad.length ? `承托底不透明断言失败：${d10Bad.map(r => `${r.cont}/${r.btn} alpha=${r.bed ? r.bed.a : 'null'}`).join(' · ')}`
          : `12 个承托底 alpha 全 = 1（.capability-tabs / .res-tabs × 3 按钮 × 明暗）`);
    check('T4-D10b tab 文字常态对比度 12 读数全 ≥ 5.0（WCAG AA 4.5 + 工程余量 .5）',
      d10Ratios.filter(r => r.ratio !== null && r.ratio >= 5.0).length === 12 && d10Ratios.length === 12,
      d10Ratios.map(r => `${r.theme === 'light' ? '明' : '暗'}${r.btn}${r.selected ? '*' : ''} ${r.ratio}`).join(' · ')
      + ` ｜ min ${d10Min.ratio}（${d10Min.theme} ${d10Min.btn}${d10Min.selected ? ' 选中' : ' 未选中'}）`);

    /* D10d（**必测，不能只信 computed**）
       ── 为什么要另测一遍像素：computed 口径假设"字芯一定能取到声明色"。
          这个假设在 **1× 的 CJK 小字**上是**假的**：受控探针（qa/r81-r2/probe-aa-cjk.mjs）
          实测 #333 压 #CCC，Latin `HAMBURG` 11~32px 全部取到声明色（偏置 0），
          而 CJK `工作区`/`导航` 在 11~13px **没有一个像素达到声明色**：
             11px 偏置 +.0392 L ⇒ 比值 7.87 → 5.35
             13px 偏置 +.0299 L ⇒ 比值 7.87 → 5.79
          15px 起偏置降到 +.005，22px 起归零。
          两条 tab 的字号正是 **12px CJK** —— 落在"整字无全覆盖"的区间里。
          所以 computed 的 5.05~5.67 是**上界**，1× 真实值要低一截。
       ── 判据：像素口径 12 读数 ≥ 4.5（WCAG AA 法条），与上面 5.0 的工程余量**不是同一条线**；
          两条同时成立才算"既合法条又留余量"。任一跌破 4.5 ⇒ 红。
       ── 与 T4-D 同尺：元素级截图 + 去字床 + `t4dPair`，不另写像素函数。 */
    const measureTabsPx = async (pg) => {
      const acc = [];
      const setThemeOn = async (t) => {
        await pg.evaluate(x => {
          if (window.__R72 && window.__R72.ThemeController && window.__R72.ThemeController.apply) window.__R72.ThemeController.apply(x);
          else if (x === 'light') document.documentElement.removeAttribute('data-theme');
          else document.documentElement.setAttribute('data-theme', x);
        }, t);
        await pg.waitForTimeout(430);
      };
      for (const th of ['light', 'dark']) {
        await setThemeOn(th);
        for (const g of tabGroups) {
          if (g.view) { await pg.evaluate(v => document.querySelector(`.view-nav button[data-view="${v}"]`)?.click(), g.view); await pg.waitForTimeout(320); }
          await pg.mouse.move(2, 890); await pg.waitForTimeout(80);
          for (let i = 0; i < g.n; i++) {
            const meta = await pg.evaluate(([s, idx]) => {
              document.querySelectorAll('[data-qa-idx]').forEach(e => e.removeAttribute('data-qa-idx'));
              const btns = document.querySelectorAll(s + ' button');
              const b = btns[idx]; if (!b) return null;
              b.setAttribute('data-qa-idx', '1');
              const r = b.getBoundingClientRect();
              return { w: r.width, h: r.height, btn: (b.textContent || '').trim().slice(0, 6), selected: b.getAttribute('aria-selected') === 'true' };
            }, [g.sel, i]);
            if (!meta) continue;
            const loc = pg.locator('[data-qa-idx="1"]').first();
            const A = decodePng(await loc.screenshot({ timeout: 4000 }));
            await pg.evaluate(() => {
              const st = document.createElement('style'); st.id = 'qa-d10px';
              st.textContent = '[data-qa-idx],[data-qa-idx] *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
              document.head.appendChild(st);
            });
            await pg.waitForTimeout(120);
            const B = decodePng(await loc.screenshot({ timeout: 4000 }));
            await pg.evaluate(() => { const st = document.getElementById('qa-d10px'); if (st) st.remove(); });
            await pg.waitForTimeout(60);
            const row = t4dPair([{ sel: g.sel, label: meta.btn, idx: i, x: 0, y: 0, w: A.w, h: A.h, miss: false }], A, B)[0];
            acc.push({ theme: th, cont: g.sel, btn: meta.btn, selected: meta.selected, ratio: row.ratio, bedL: row.bedL, imgW: A.w });
          }
        }
      }
      await pg.evaluate(() => document.querySelectorAll('[data-qa-idx]').forEach(e => e.removeAttribute('data-qa-idx')));
      return acc;
    };
    const d10px = await measureTabsPx(page);
    const d10pxMin = d10px.reduce((a, b) => (a.ratio === null || b.ratio < a.ratio ? b : a), { ratio: null });
    const d10Gap = d10px.map((r, i) => +(r.ratio - (d10Ratios[i] ? d10Ratios[i].ratio : 0)).toFixed(2));
    check('T4-D10d tab 文字 1× 像素口径 12 读数全 ≥ 4.5（computed 是上界，CJK 小字取不到声明色）',
      d10px.length === 12 && d10px.every(r => r.ratio >= 4.5),
      d10px.map(r => `${r.theme === 'light' ? '明' : '暗'}${r.btn}${r.selected ? '*' : ''} ${r.ratio}`).join(' · ')
      + ` ｜ min ${d10pxMin.ratio}（${d10pxMin.theme} ${d10pxMin.btn}${d10pxMin.selected ? ' 选中' : ''}）`
      + ` ｜ 与 computed 之差最大值 ${Math.max(...d10Gap.map(Math.abs)).toFixed(2)}`);

    /* D10e · 采样器标定（**不是第二条业务腿**）
       ── 裁决依据（team-lead R83）：2× 收敛到 computed，所以它不是"另一把尺子"，是同一条路径走得更长。
          把它设成门禁腿会造出"恒等假第二腿"：采样器没坏时必然等于 computed，坏了则两个一起错。
          所以它只回答一个问题：**1× 与 computed 的差，是渲染（覆盖率）还是采样器故障？**
       ── 判据：12 个读数在 2× 下与 computed 之差 ≤ .02。满足 ⇒ 采样器无故障，1× 的差归因渲染。
          不满足 ⇒ 报"采样器故障"，而不是"设计不合格"。
       ── 实现：CDP 把 DPR 抬到 2（Playwright 的 deviceScaleFactor 是上下文级参数，改了要重开上下文；
          CDP 的 setDeviceMetricsOverride 可以在同一页里改，代价小、不乱 DOM 状态）。 */
    let d10x2 = [], d10eErr = null, ctx2 = null, prof2 = null;
    try {
      /* `deviceScaleFactor` 是**上下文级**参数，CDP 的 setDeviceMetricsOverride 在本环境里
         不会改变 `locator.screenshot()` 的输出尺寸（实测截图宽 88→88，比值与 1× 完全相同）。
         ⇒ 只能另开一个 dsf=2 的上下文，重新加载页面、重新量。代价 ~5s，但结论可用。 */
      prof2 = mkdtempSync(join(tmpdir(), 'r72-dpr2-'));
      ctx2 = await chromium.launchPersistentContext(prof2, {
        executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2, args: ['--no-first-run', '--disable-extensions'], timeout: 30000
      });
      const page2 = await ctx2.newPage();
      await page2.goto(pathToFileURL(PAGE).href, { waitUntil: 'domcontentloaded' });
      await page2.waitForTimeout(1300);
      await page2.evaluate(() => { const st = document.createElement('style'); st.textContent = '*{animation:none!important;transition:none!important}'; document.head.appendChild(st); });
      d10x2 = await measureTabsPx(page2);
    } catch (e) { d10eErr = String(e && e.message); }
    finally {
      try { if (ctx2) await ctx2.close(); } catch { /* 已关 */ }
      try { if (prof2) rmSync(prof2, { recursive: true, force: true }); } catch { /* 已删 */ }
    }
    const d10eGap = d10x2.length === 12 ? d10x2.map((r, i) => +(r.ratio - (d10Ratios[i] ? d10Ratios[i].ratio : 0)).toFixed(2)) : [];
    check('T4-D10e 采样器标定断言（2× 读数 = computed ±.02 ⇒ 故障归因分离，不作业务腿）',
      d10x2.length === 12 && d10eGap.every(g => Math.abs(g) <= 0.02) && d10x2.every(r => r.imgW > d10px[0].imgW),
      d10eErr ? `DPR 切换失败：${d10eErr}`
        : d10x2.length !== 12 ? `2× 只量到 ${d10x2.length} 个读数`
          : `2× 比值 ${d10x2.map(r => r.ratio).join('/')} ｜ 与 computed 逐项 Δ ${d10eGap.join('/')}`
            + ` ｜ max|Δ| ${Math.max(...d10eGap.map(Math.abs)).toFixed(2)}（须 ≤.02）｜ 截图宽 ${d10px[0].imgW}→${d10x2[0].imgW}px`);

    /* D10f · 口径仲裁（team-lead 总规则：像素只在 computed 不可用时才有发言权）
       ── SOLID 床（α===1）⇒ computed 权威，像素只作咨询。
          两者差 > 1.0 判"采样器被污染"，不采信像素 —— **但 CJK ≤13px 是已知例外**：
          §28.2b 的受控探针证明它的差来自笔画覆盖率（11~13px 整字无全覆盖），不是污染。
          所以本条把"污染"与"已知覆盖率损失"分开计：
            · 污染 = |1× 像素 − computed| > 1.0 **且**（字号 ≥14px 或 不含 CJK）
            · 已知损失 = > 1.0 但 字号 ≤13px 且 含 CJK
          判据：污染数必须为 0；已知损失全部 ≤ 1.5（超过说明不是覆盖率能解释的量）。 */
    const d10Font = await page.evaluate(() => {
      const out = [];
      for (const cont of document.querySelectorAll('.capability-tabs, .res-tabs:not(.res-tabs--mirror)')) {
        for (const b of cont.querySelectorAll('button')) {
          const cs = getComputedStyle(b);
          out.push({ btn: (b.textContent || '').trim().slice(0, 6), fs: parseFloat(cs.fontSize), cjk: /[\u4e00-\u9fff]/.test(b.textContent || '') });
        }
      }
      return out;
    });
    const d10Fsm = new Map(d10Font.map(f => [f.btn, f]));
    const d10Class = d10px.map((r, i) => {
      const f = d10Fsm.get(r.btn) || { fs: 0, cjk: false };
      const gap = Math.abs(r.ratio - (d10Ratios[i] ? d10Ratios[i].ratio : 0));
      const kind = gap <= 1.0 ? 'ok' : (f.cjk && f.fs <= 13 ? 'cjk-small' : 'contaminated');
      return { btn: r.btn, theme: r.theme, fs: f.fs, cjk: f.cjk, gap: +gap.toFixed(2), kind };
    });
    const d10Contam = d10Class.filter(c => c.kind === 'contaminated');
    const d10CjkLoss = d10Class.filter(c => c.kind === 'cjk-small');
    check('T4-D10f 口径仲裁（SOLID 床 ⇒ computed 权威；差 >1.0 须区分"污染"与"CJK 覆盖率损失"）',
      d10Contam.length === 0 && d10CjkLoss.every(c => c.gap <= 1.5),
      `污染 ${d10Contam.length} 个${d10Contam.length ? '：' + d10Contam.map(c => `${c.btn} ${c.gap}`).join(' · ') : ''}`
      + ` ｜ CJK≤13px 已知损失 ${d10CjkLoss.length} 个，max ${Math.max(0, ...d10CjkLoss.map(c => c.gap)).toFixed(2)}`
      + ` ｜ 字号 ${[...new Set(d10Class.map(c => c.fs))].join('/')}px`);

    check('T4-D10c 负控·承托底注入成与字同色 ⇒ 12 读数必须全部跌破 5.0',
      d10Neg.length === 12 && d10Neg.every(v => v !== null && v < 5.0),
      `注入 background:--color-muted 后：${d10Neg.join(' / ')}（须全 < 5.0）`);

    /* ---- D11 ---- */
    const d11 = [];
    for (const th of ['light', 'dark']) {
      await t4dSetTheme(th);
      for (const g of tabGroups) {
        if (g.view) { await page.evaluate(v => document.querySelector(`.view-nav button[data-view="${v}"]`)?.click(), g.view); await page.waitForTimeout(320); }
        await page.mouse.move(2, 890); await page.waitForTimeout(80);
        const base = (await readTabs()).filter(x => x.cont === g.sel.replace('.', ''));
        for (let i = 0; i < base.length; i++) {
          await page.locator(`${g.sel} button`).nth(i).hover({ timeout: 4000 });
          await page.waitForTimeout(120);
          const hov = (await readTabs()).filter(x => x.cont === g.sel.replace('.', ''))[i];
          await page.mouse.move(2, 890); await page.waitForTimeout(80);
          d11.push({ theme: th, cont: base[i].cont, i, btn: base[i].btn, selected: base[i].selected, base: base[i], hover: hov });
        }
      }
    }
    const d11Unsel = d11.filter(x => !x.selected);
    const d11Sel = d11.filter(x => x.selected);
    const lineOpaque = d11Unsel.filter(x => !x.hover.bb || x.hover.bb.a !== 0);
    check('T4-D11a 未选中 tab 在 hover 下下划线恒透明（border-bottom-color alpha === 0）',
      d11Unsel.length === 8 && lineOpaque.length === 0,
      d11Unsel.length !== 8 ? `未选中样本 ${d11Unsel.length}（应 8）`
        : `8 个样本：${d11Unsel.map(x => `${x.theme === 'light' ? '明' : '暗'}${x.btn} alpha=${x.hover.bb ? x.hover.bb.a : 'null'}`).join(' · ')}`);
    const selKept = d11Sel.filter(x => x.hover.fg && x.base.fg
      && x.hover.fg.rgb.join() === x.base.fg.rgb.join());
    check('T4-D11b 选中 tab 在 hover 下字体色 = 常态字体色（accent 不被 hover 刷掉）',
      d11Sel.length === 4 && selKept.length === 4,
      d11Sel.map(x => `${x.theme === 'light' ? '明' : '暗'}${x.btn} 常态 rgb(${x.base.fg.rgb}) → hover rgb(${x.hover.fg.rgb})`).join(' · '));
    const selLine = d11Sel.filter(x => x.hover.bb && x.hover.fg && x.hover.bb.rgb.join() === x.hover.fg.rgb.join() && x.hover.bb.a === 1);
    check('T4-D11c 选中 tab 在 hover 下下划线仍为 accent（与自身字色同色且不透明）',
      selLine.length === 4,
      d11Sel.map(x => `${x.theme === 'light' ? '明' : '暗'}${x.btn} 下划线 rgb(${x.hover.bb && x.hover.bb.rgb}) a=${x.hover.bb && x.hover.bb.a} vs 字 rgb(${x.hover.fg && x.hover.fg.rgb})`).join(' · '));
    const dL = (x) => x.hover.fg && x.base.fg ? Math.abs(lum(flat(x.hover.fg, x.base.bed)) - lum(flat(x.base.fg, x.base.bed))) : null;
    const d11LightUn = d11Unsel.filter(x => x.theme === 'light');
    const d11DarkUn = d11Unsel.filter(x => x.theme === 'dark');
    check('T4-D11d 未选中 tab hover 字色 |ΔL| 明档 > .05（暗档同口径报数）',
      d11LightUn.length === 4 && d11LightUn.every(x => dL(x) !== null && dL(x) > 0.05),
      `明 ${d11LightUn.map(x => `${x.btn} ${dL(x).toFixed(4)}`).join(' / ')}`
      + ` ｜ 暗 ${d11DarkUn.map(x => `${x.btn} ${dL(x) === null ? 'n/a' : dL(x).toFixed(4)}`).join(' / ')}`);

    /* ---- D11 两条结构性负控 ---- */
    /* NC-1（顺序）：把 hover 规则**原样**追加到最后 —— 同特异性 (0,2,1)，只改文档顺序。
       若"hover 必须写在 [aria-selected] 之前"这条成立，选中 tab 悬停的字必须被刷成 --color-text。
       这条 check 的期望值是"必须变"，所以它验的是**判据本身有区分力**：
       如果哪天有人把 hover 挪到 selected 之后，正式判据 D11b 会红，而这条会绿 —— 两条互补。 */
    /* ⚠ 注入的规则**一律不带 !important** —— 带了就变成"无视特异性/顺序直接赢"，
       两条负控都会失去证明力（那只是把结论重复一遍，不是证伪）。 */
    await t4dInject('t4d-d11a', '.capability-tabs button:hover{color:var(--color-text)}.res-tabs button:hover{color:var(--color-text)}');
    const nc1 = [];
    for (const th of ['light', 'dark']) {
      await t4dSetTheme(th);
      for (const g of tabGroups) {
        if (g.view) { await page.evaluate(v => document.querySelector(`.view-nav button[data-view="${v}"]`)?.click(), g.view); await page.waitForTimeout(320); }
        const st = (await readTabs()).filter(x => x.cont === g.sel.replace('.', ''));
        const si = st.findIndex(x => x.selected); if (si < 0) continue;
        await page.locator(`${g.sel} button`).nth(si).hover({ timeout: 4000 });
        await page.waitForTimeout(110);
        const hv = (await readTabs()).filter(x => x.cont === g.sel.replace('.', ''))[si];
        await page.mouse.move(2, 890); await page.waitForTimeout(70);
        nc1.push({ theme: th, btn: st[si].btn, base: st[si].fg.rgb.join(), hover: hv.fg.rgb.join(), changed: st[si].fg.rgb.join() !== hv.fg.rgb.join() });
      }
    }
    await t4dInject('t4d-d11a', '');
    check('T4-D11-NC1 结构性负控·顺序（同特异性 hover 规则追加到末尾 ⇒ 选中字必须被刷掉）',
      nc1.length === 4 && nc1.every(x => x.changed),
      nc1.map(x => `${x.theme === 'light' ? '明' : '暗'}${x.btn} rgb(${x.base}) → rgb(${x.hover})`).join(' · ')
      + ` ⇒ 变色 ${nc1.filter(x => x.changed).length}/4（须 4/4，证明 D11b 不是恒真）`);
    /* NC-2（特异性）：把 base.css:272 那条 (0,3,1) 的 hover 上色**原样**注入到最后。
       (0,3,1) < 守卫的 (0,4,1) ⇒ 必须赢不了，未选中 hover 下划线仍透明。
       若有人把守卫降回 (0,3,1)（= 回到"靠加载顺序赢"），这条会红。 */
    await t4dInject('t4d-d11b', '.capability-tabs button:hover:not(:disabled):not([aria-disabled="true"]){border-bottom-color:var(--color-accent)}.res-tabs button:hover:not(:disabled):not([aria-disabled="true"]){border-bottom-color:var(--color-accent)}');
    const nc2 = [];
    for (const th of ['light', 'dark']) {
      await t4dSetTheme(th);
      for (const g of tabGroups) {
        if (g.view) { await page.evaluate(v => document.querySelector(`.view-nav button[data-view="${v}"]`)?.click(), g.view); await page.waitForTimeout(320); }
        const st = (await readTabs()).filter(x => x.cont === g.sel.replace('.', ''));
        const ui = st.findIndex(x => !x.selected); if (ui < 0) continue;
        await page.locator(`${g.sel} button`).nth(ui).hover({ timeout: 4000 });
        await page.waitForTimeout(110);
        const hv = (await readTabs()).filter(x => x.cont === g.sel.replace('.', ''))[ui];
        await page.mouse.move(2, 890); await page.waitForTimeout(70);
        nc2.push({ theme: th, btn: st[ui].btn, bb: hv.bb ? hv.bb.a : null });
      }
    }
    await t4dInject('t4d-d11b', '');
    check('T4-D11-NC2 结构性负控·特异性（(0,3,1) 的 accent 下划线注入到最后 ⇒ 仍须被 (0,4,1) 守卫压住）',
      nc2.length === 4 && nc2.every(x => x.bb === 0),
      nc2.map(x => `${x.theme === 'light' ? '明' : '暗'}${x.btn} alpha=${x.bb}`).join(' · ')
      + ` ⇒ 仍透明 ${nc2.filter(x => x.bb === 0).length}/4（须 4/4）`);
    result.t4dTabs = { groups: tabGroups, d10: d10Ratios, d10Neg, d11: d11.map(x => ({ theme: x.theme, cont: x.cont, btn: x.btn, selected: x.selected, baseColor: x.base.fg.rgb, hoverColor: x.hover.fg.rgb, baseLineA: x.base.bb && x.base.bb.a, hoverLineA: x.hover.bb && x.hover.bb.a, dL: dL(x) })), nc1, nc2 };
    if (t4d.theme !== 'light') await t4dSetTheme('light');
  } catch (e) {
    check('T4-D 暗档像素级对比度（执行异常）', false, String(e && e.stack ? e.stack : e));
  } finally {
    await t4dFreeze(false).catch(() => {});
    await t4dInject('t4d-bed', '').catch(() => {});
    await t4dInject('t4d-neg', '').catch(() => {});
    await t4dInject('t4d-mono', '').catch(() => {});
    if (t4d.theme !== 'light') await t4dSetTheme('light').catch(() => {});
  }

  /* ---- T4-D12 · 跨元素文字行框相交（R83 新增，检测 .knob 溢出压 #clearanceHelp） ---- */
  /* 独立段：不进 T4-D 的 try/finally，不污染 :2549-2555 的注入清理。
     #panel-settings 默认 hidden（index.html:511），不切到 settings 则文字行框全空、判据恒绿
     （HANDOVER §8-1「断言恒真」）；段尾还原 chat + light，随后 :2561 的 page.reload() 再兜底。 */
  {
    const D12_ANCHOR = 'T4-D12-ANCHOR .knob × #clearanceHelp 文字行框相交';
    const D12_FIX_ANCHOR = "var txt = $('.switch-label', sw);";
    /* 页面内扫描：文本节点 Range.getClientRects() 取逐行文字框（不用并集、不用元素框）。
       六层过滤：空白 / 隐藏 / 同元素 / 父子包含 / 至少一个行框溢出自身元素框 /
       相交必须 w>0 && h>0。按 y 排序 + 活动集扫描，不做 O(n²)。
       doInject=true 时先追加一个已知溢出的临时 span，finally 里 remove，量完即删。 */
    const d12Scan = (doInject) => page.evaluate((inject) => {
      let syn = null;
      if (inject) {
        const help = document.querySelector('#clearanceHelp');
        let r0 = null;
        if (help) {
          const w = document.createTreeWalker(help, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n && !r0; n = w.nextNode()) {
            if ((n.nodeValue || '').replace(/\s+/g, '').length < 1) continue;
            const r = document.createRange(); r.selectNodeContents(n);
            const rects = [...r.getClientRects()];
            if (rects.length) r0 = rects[0];
          }
        }
        if (r0) {
          syn = document.createElement('span');
          syn.id = 'd12-syn-overflow';
          syn.textContent = '溢出字';
          syn.style.cssText = 'position:absolute;left:' + (r0.left + 2) + 'px;top:' + (r0.top + 1)
            + 'px;width:20px;font-size:13px;line-height:1;white-space:nowrap;';
          document.body.appendChild(syn);
        }
      }
      try {
        const EPS = 0.5;   // 亚像素容差，只用于「是否算溢出」，不用于相交判定
        const lines = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement;
          if (!el || el.closest('script,style,template,noscript,svg')) continue;
          if ((n.nodeValue || '').replace(/\s+/g, '').length < 1) continue;
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden' || st.display === 'none') continue;
          if (typeof el.checkVisibility === 'function'
              && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
          const r = document.createRange(); r.selectNodeContents(n);
          const rects = [...r.getClientRects()];   // hidden 祖先 ⇒ 0 框，天然排除
          if (!rects.length) continue;
          const eb = el.getBoundingClientRect();
          for (const rr of rects) {
            if (rr.width < 1 || rr.height < 1) continue;
            const escape = rr.bottom > eb.bottom + EPS || rr.top < eb.top - EPS
                        || rr.right > eb.right + EPS || rr.left < eb.left - EPS;
            lines.push({ el, rect: rr, escape,
              tag: el.id ? '#' + el.id : '.' + String(el.className).trim().split(/\s+/)[0] });
          }
        }
        lines.sort((a, b) => a.rect.top - b.rect.top);
        const active = [], hits = [];
        for (const cur of lines) {
          for (let i = active.length - 1; i >= 0; i--)
            if (active[i].rect.bottom <= cur.rect.top) active.splice(i, 1);
          for (const prev of active) {
            if (prev.el === cur.el) continue;                                   // ③ 同元素多行
            if (prev.el.contains(cur.el) || cur.el.contains(prev.el)) continue;  // ④ 父子文字
            if (!(prev.escape || cur.escape)) continue;                          // ⑤ 至少一个行框溢出
            const w = Math.min(prev.rect.right, cur.rect.right) - Math.max(prev.rect.left, cur.rect.left);
            const h = Math.min(prev.rect.bottom, cur.rect.bottom) - Math.max(prev.rect.top, cur.rect.top);
            if (w > 0 && h > 0)                                                   // ⑥ 相交严格 w>0 && h>0
              hits.push({ a: prev.tag, b: cur.tag, w: +w.toFixed(1), h: +h.toFixed(1), area: +(w * h).toFixed(1) });
          }
          active.push(cur);
        }
        return { lineCount: lines.length, escapeCount: lines.filter(l => l.escape).length, hits };
      } finally {
        if (syn) syn.remove();
      }
    }, doInject);

    const clean = { lineCount: 0, escapeCount: 0, hits: [] };
    const injected = { hits: [] };
    const restored = { hits: [] };
    let d12Err = null;
    try {
      await page.evaluate(() => window.__R72.ViewRouter.switchTo('settings'));
      await page.waitForTimeout(320);
      for (const th of ['light', 'dark']) {
        await t4dSetTheme(th);
        const c = await d12Scan(false);
        clean.lineCount += c.lineCount;
        clean.escapeCount += c.escapeCount;
        clean.hits.push(...c.hits);
        injected.hits.push(...(await d12Scan(true)).hits);
        restored.hits.push(...(await d12Scan(false)).hits);
      }
    } catch (e) {
      d12Err = String(e && e.stack ? e.stack : e);
    } finally {
      await page.evaluate(() => window.__R72.ViewRouter.switchTo('chat')).catch(() => {});
      await t4dSetTheme('light').catch(() => {});
    }

    const d12Detail = clean.hits.length
      ? `命中 ${clean.hits.length} 对：`
        + clean.hits.map(h => `${h.a} × ${h.b} 文字行框相交 ${h.w}×${h.h}=${h.area}px²`).join(' · ')
        + `（${D12_ANCHOR} ⇒ 判红）`
      : `清洁态 0 命中（行框 ${clean.lineCount} 条，溢出候选 ${clean.escapeCount} 条）`
        + `｜注入 ${injected.hits.length} 命中｜移除后 ${restored.hits.length} 命中｜${D12_ANCHOR}`;
    check('T4-D12a 跨元素文字行框相交（清洁态 0 命中 / 注入已知溢出后必命中 / 移除归零）',
      !d12Err && clean.hits.length === 0 && injected.hits.length >= 1 && restored.hits.length === 0,
      (d12Err ? `执行异常：${d12Err}｜` : '') + d12Detail);
    check('T4-D12b 断言锚点在源码中可检索（assert anchor in src）',
      anchorOk('scripts/verify.mjs', D12_ANCHOR) && anchorOk('scripts/main.js', D12_FIX_ANCHOR),
      `verify.mjs 含 D12_ANCHOR=${anchorOk('scripts/verify.mjs', D12_ANCHOR)}；`
        + `main.js 含修复锚点=${anchorOk('scripts/main.js', D12_FIX_ANCHOR)}`);
  }

  /* ---- C01 / C02 / C06 / C07 / C08 ---- */
  /* C08 判据脚本自身修正（留痕，不放宽判据）：此前已有大量点击，浏览器
     「顺序焦点导航起点」停留在 last-focused，仅 blur() 后首次 Tab 不会回到
     文档开头。重载回初始态再用真实键盘 Tab，才是 skip-link 可达的正确取证。 */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => String(document.activeElement.className || document.activeElement.tagName));
  check('C08 skip-link 可键盘到达（真实键盘，页面初始态）', /skip-link/.test(firstFocus), `首个焦点 = ${firstFocus}`);
  await page.locator('#sendBtn').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const fv = await page.evaluate(() => {
    const el = document.activeElement, cs = getComputedStyle(el);
    return { id: el.id, match: el.matches(':focus-visible'), w: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor, offset: cs.outlineOffset };
  });
  check('C01 真实键盘 :focus-visible = 2px solid + 2px offset',
    fv.match && fv.style === 'solid' && parseFloat(fv.w) >= 2 && parseFloat(fv.offset) >= 2,
    JSON.stringify(fv));
  const small = await smallTargets(page);
  check('C02 所有可见交互目标 >= 44x44', small.length === 0,
    small.length ? JSON.stringify(small.slice(0, 8)) : '不达标清单为空');
  const landmarks = await page.evaluate(() => ({
    h: document.querySelectorAll('h1').length,
    set: ['header', 'main', 'section', 'footer', 'nav', 'aside'].map(t => `${t}:${document.querySelectorAll(t).length}`).join(' ')
  }));
  check('C08b 语义地标齐全', /header:1/.test(landmarks.set) && /main:1/.test(landmarks.set) && landmarks.h === 1, landmarks.set);
  const badStates = await page.evaluate(() => [...document.querySelectorAll('[data-state]')].filter(el => {
    const t = el.textContent || '';
    return !(/[●◐○⊘]/.test(t) && /[\u4e00-\u9fff]/.test(t));
  }).map(el => ({ cls: String(el.className).slice(0, 30), text: (el.textContent || '').trim().slice(0, 26) })));
  check('C06 状态 = 形状 + 中文文字 + 语义色（不只靠颜色）', badStates.length === 0,
    badStates.length ? JSON.stringify(badStates.slice(0, 6)) : '全部 [data-state] 元素三重编码齐备');
  check('C07 图表附 sr-only 等价数据表', (await page.locator('.chart-slab table.sr-only').count()) >= 1,
    `table.sr-only = ${await page.locator('.chart-slab table.sr-only').count()}`);
  await page.evaluate(() => window.__R72.StateMachine.apply(document.querySelector('#testConnBtn'), 'loading'));
  const aria = await page.evaluate(() => ({
    current: !!document.querySelector('.view-nav [aria-current="page"]'),
    live: !!document.querySelector('[aria-live="polite"]'),
    busy: !!document.querySelector('[aria-busy="true"]'),
    disabled: !!document.querySelector('[aria-disabled="true"], [disabled]')
  }));
  check('QA-A1-8 ARIA 状态标注齐备', aria.current && aria.live && aria.busy && aria.disabled, JSON.stringify(aria));

  /* ---- A08 / A09 / A10 / A11：只读拦截 + 工具链闭环 + 密级三重编码 ---- */
  await page.locator('#userInput').fill('删除所有会话');
  await page.locator('#composer').dispatchEvent('submit');
  await page.waitForTimeout(220);
  const errCount = await page.locator('[data-state="err"]').count();
  const bodyText = await page.locator('body').innerText();
  check('A08 只读密级拦截破坏性指令（错误态 + 中文拒绝）', errCount >= 1 && /已拒绝/.test(bodyText),
    `err 节点 ${errCount} 个；含「已拒绝」`);

  const tokenBefore = await page.locator('#tokenValue').textContent();
  const ratioBefore = await page.evaluate(() => getComputedStyle(document.querySelector('#costRibbon')).getPropertyValue('--ratio').trim());
  const litBefore = await page.locator('.ribbon-tick.is-lit').count();
  await page.locator('#userInput').fill('扫描 server/src 依赖图');
  await page.locator('#composer').dispatchEvent('submit');
  await page.waitForTimeout(1500);
  const okCount = await page.locator('.tool-step-node[data-state="ok"]').count();
  const tokenAfter = await page.locator('#tokenValue').textContent();
  const ratioAfter = await page.evaluate(() => getComputedStyle(document.querySelector('#costRibbon')).getPropertyValue('--ratio').trim());
  const litAfter = await page.locator('.ribbon-tick.is-lit').count();
  check('A09 工具调用 run → ok 状态流转（>= 3 条 ok）', okCount >= 3, `ok 节点 ${okCount} 个`);
  check('A10 Token 计量递增 + 成本光带 --ratio 推进', tokenBefore !== tokenAfter && parseFloat(ratioAfter) > parseFloat(ratioBefore),
    `token ${tokenBefore} → ${tokenAfter}；ratio ${ratioBefore} → ${ratioAfter}`);
  check('A10b 成本光带刻度随 run→ok 逐格点亮（记忆点功能闭环）', litAfter > litBefore,
    `亮起刻度 ${litBefore} → ${litAfter}`);
  const chainNodes = await page.locator('#chainTrack .chain-node').count();
  check('A10c 工具链轨道同步增长', chainNodes >= 6, `链节点 ${chainNodes} 个`);

  const clearBefore = await page.evaluate(() => {
    const b = document.querySelector('#clearanceBadge');
    return { text: b.textContent, color: getComputedStyle(b).color, mode: b.getAttribute('data-clearance') };
  });
  await page.locator('#clearanceDemoBtn').click();
  await page.waitForTimeout(90);
  const clearAfter = await page.evaluate(() => {
    const b = document.querySelector('#clearanceBadge');
    return { text: b.textContent, color: getComputedStyle(b).color, mode: b.getAttribute('data-clearance') };
  });
  const toolModeText = await page.locator('#toolMode').textContent();
  check('A11 密级三重编码同步（形状 + 文字 + 颜色同时变化）',
    clearBefore.text !== clearAfter.text && clearBefore.color !== clearAfter.color &&
    /[●◐○]/.test(clearAfter.text) && /完整|只读|仅对话/.test(clearAfter.text) && /完整/.test(toolModeText),
    `${clearBefore.mode}(${clearBefore.color}) → ${clearAfter.mode}(${clearAfter.color})；composer=${toolModeText.trim()}`);
  await page.evaluate(() => window.__R72.ClearanceCodec.sync('read'));

  /* ---- QA-A5 8 态 / QA-A6 G-4 G-5 / QA-A8 编排 ---- */
  /* R77-H25：这条判据改前是 `every(v => v.covered === 8)`，
     而 covered 在 main.js 里是**硬编码字面量 8** ⇒ 恒真，永远不会失败。
     现在的断言换成三条都能证伪的结构断言：
       ① 9 板块 × 8 态，每格归因必须落在已知集合内（出现拼写错/新枚举会红）；
       ② covered 必须等于"归因为 dom 的格数"（自洽性：报多报少都会红）；
       ③ 归因为 css 的格，其证据选择器必须在样式表里真的数到非空规则
          （这条由页面内的 ruleCount 完成，任何"记成 css 但其实没有规则"都会红）。 */
  const cov = await page.evaluate(() => window.__R72.coverStates());
  const covAudit = await page.evaluate(() => {
    const report = window.__R72.coverStates();
    const ALLOWED = ['dom', 'css', 'missing', 'unknown', 'implicit', 'not-verifiable'];
    const bad = [];
    let domTotal = 0, cssTotal = 0, missTotal = 0, unkTotal = 0, sum = 0;
    Object.keys(report).forEach(v => {
      const r = report[v];
      const domHere = Object.values(r.states).filter(s => s === 'dom').length;
      domTotal += domHere;
      cssTotal += Object.values(r.states).filter(s => s === 'css').length;
      missTotal += Object.values(r.states).filter(s => s === 'missing').length;
      unkTotal += Object.values(r.states).filter(s => s === 'unknown').length;
      sum += r.covered;
      Object.keys(r.states).forEach(s => {
        if (ALLOWED.indexOf(r.states[s]) < 0) bad.push(`${v}.${s}=${r.states[s]}`);
      });
      if (r.covered !== domHere) bad.push(`${v}: covered=${r.covered} 但 dom 格=${domHere}`);
      if (r.coveredOf !== 8) bad.push(`${v}: coveredOf=${r.coveredOf}`);
    });
    /* ③ 的反向验证：把某态的证据选择器换成绝不存在的串，ruleCount 必须归 0 */
    const probe = window.__R72.ruleCount ? window.__R72.ruleCount('__no_such_selector__') : null;
    const probeReal = window.__R72.ruleCount ? window.__R72.ruleCount('[data-ui-state="error"]') : null;
    return { keys: Object.keys(report).length, bad, domTotal, cssTotal, missTotal, unkTotal, sum };
  });
  check('QA-A5-1 9 板块 x 8 态归因合法且 covered 自洽',
    covAudit.keys === 9 && covAudit.bad.length === 0 && covAudit.sum === covAudit.domTotal,
    `dom=${covAudit.domTotal} css=${covAudit.cssTotal} missing=${covAudit.missTotal} unknown=${covAudit.unkTotal} / 72 · ${covAudit.bad.slice(0, 3).join(';') || '一致'}`);

  /* ③ 的反向验证改在 Node 侧做：file:// 下 document.styleSheets[i].cssRules
     会因跨源被拦（实测 ruleCount 返回 -1），所以"样式表里到底有没有这条规则"
     不能问浏览器，直接读 4 个 CSS 文本。探针纪律两条都要满足：
     虚构选择器必须命中 0（否则正则是恒真的），真实选择器必须命中 > 0（否则尺子是死的）。 */
  const CSS_ALL = ['tokens', 'base', 'components', 'views']
    .map(n => readFileSync(join(DESIGN, 'styles', n + '.css'), 'utf8')).join('\n');
  const cssHits = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (CSS_ALL.match(new RegExp(esc + '[^{}]*\\{', 'g')) || []).length;
  };
  const probeFake = cssHits('__no_such_selector__');
  const probeReal = cssHits('[data-ui-state="error"]');
  check('QA-A5-1b 规则探针能区分"有规则"与"没规则"（非恒真）',
    probeFake === 0 && probeReal > 0,
    `虚构选择器 ${probeFake} 条 / [data-ui-state=error] ${probeReal} 条`);

  const evidence = await page.evaluate(() => window.__R72.stateEvidence);
  const evHits = {};
  Object.keys(evidence).forEach(s => {
    if (!evidence[s] || !evidence[s].length) return;   /* default 无选择器证据，跳过 */
    evHits[s] = evidence[s].reduce((acc, sel) => acc + cssHits(sel), 0);
  });
  const evMissing = Object.keys(evHits).filter(s => evHits[s] === 0);
  check('QA-A5-1c 每个可查询态在样式表里都有非空规则',
    evMissing.length === 0,
    Object.keys(evHits).map(s => `${s}:${evHits[s]}`).join(' ')
    + (evMissing.length ? ' · 缺 ' + evMissing.join(',') : ''));
  const seg = page.locator('.view-nav [data-view="sessions"]');
  const hoverBase = await seg.evaluate(el => getComputedStyle(el).backgroundColor);
  await seg.hover();
  await page.waitForTimeout(220);
  const hoverAfter = await seg.evaluate(el => getComputedStyle(el).backgroundColor);
  check('QA-A5-2 悬停有真实计算样式变化', hoverBase !== hoverAfter, `${hoverBase} → ${hoverAfter}`);
  await page.mouse.move(700, 500);
  /* ---- QA-A6 --------------------------------------------------------------
     R80-R2 重写（契约 §7.1）：**判据方向反转**。
     改前要求「.atmosphere::before 有 radial-gradient + 圆角/阴影非统一」；
     R80 的裁决是「界面本体无色相，全部色相只来自光」，氛围渐变被**删除**，
     所以"渐变存在"从加分项变成减分项 —— 旧断言恒红不是回归，是判据过期。

     【维度（只增不减：改前 3 条 → 现在 6 条 + 1 条自证）】
       ① .atmosphere::before 的 background-image === 'none'（严格）
       ② .atmosphere::after 不得含任何 linear-gradient、且其所有色标必须近中性
          —— ⚠ 契约原文写的是 ::after 也 === 'none'，但 .atmosphere 同时带 .grain 类，
          ::after 的颗粒点来自 base.css 的 `.grain::after`（近中性 .055，是 R80 明确
          保留的材质）。把它判成 none 等于要求删掉颗粒，与 R80 的设计相反。
          所以这里取"无色相"口径而不是"没有图像"口径，并把它印在 detail 里。
       ③ 全站（含伪元素）含**彩色色相**的 linear-gradient 数量 = 0
       ④ 圆角取值 ⊆ {0px, 8px, 12px, 16px, 9999px, 50%}
          —— 按**四角**拆开取值：同心公式允许 `16 16 12 16` 这种破格组合，
             复合串只做报告、不参与白名单，否则会把设计允许的缺角判红。
       ⑤ 圆角集合 > 1（原有：禁止全站统一 r）
       ⑥ 阴影集合 > 1（原有：禁止全站统一投影）
       ⊕ 自证：往 body 塞一条纯红 linear-gradient，③ 必须抓到。
     判"彩色"用**色度**（max−min）/255，不用 HSL 饱和度：暖白 #FAF9F5 的 HSL
     饱和度 33%，但色度只有 5/255 —— 用饱和度会把背景色判成彩色，制造假红。 */
  const gInfo = await page.evaluate(() => {
    const cs = (el, p) => getComputedStyle(el, p || null);
    const atmo = document.querySelector('.atmosphere');
    if (!atmo) return { missing: '找不到 .atmosphere' };
    const atmoBefore = cs(atmo, '::before').backgroundImage;
    const atmoAfter = cs(atmo, '::after').backgroundImage;
    const parseC = s => { const m = String(s).match(/[\d.]+/g); if (!m || m.length < 3) return null; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
    const chroma = c => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
    const CORNERS = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
    const atoms = new Set(), comps = new Set();
    const vis = n => n.offsetParent !== null || cs(n).position === 'fixed';
    [...document.querySelectorAll('*')].filter(vis).forEach(n => {
      CORNERS.forEach(k => atoms.add(cs(n)[k]));
      comps.add(cs(n).borderRadius);
    });
    const names = el => el.id || String(el.className).split(' ')[0] || el.tagName;
    const scan = () => {
      const hits = [];
      [...document.querySelectorAll('*')].forEach(el => {
        [null, '::before', '::after'].forEach(p => {
          const bg = cs(el, p).backgroundImage;
          if (!bg || bg === 'none') return;
          (bg.match(/linear-gradient\([^)]*\)/g) || []).forEach(g => {
            (g.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) || []).forEach(cstr => {
              const c = parseC(cstr);
              if (!c || c[3] < 0.15) return;
              if (chroma(c) >= 0.08) hits.push({ at: names(el) + (p || ''), c: cstr, chroma: +chroma(c).toFixed(2) });
            });
          });
        });
      });
      return hits;
    };
    const dirty = scan();
    /* 新增（主理人裁决 5）：不只查 .atmosphere::before + ::after 这两条，
       而是**所有** .atmosphere 元素的**所有**伪元素统一禁含饱和度 >0.15 的颜色。
       为什么用 HSL 饱和度而不是色度：这里问的是"这个色标是不是有彩色倾向"，
       明度极低的深色（如颗粒 rgba(26,28,32)）色度只有 6/255 看着无害，但它是
       带蓝的冷灰；饱和度口径能同时管住"深色带彩"这个盲区。
       （③ 全站渐变仍用色度 —— 那里要放过暖白底，两个口径各管一段，互补不重复。） */
    const satOf = c => {
      const mx = Math.max(c[0], c[1], c[2]) / 255, mn = Math.min(c[0], c[1], c[2]) / 255;
      const l = (mx + mn) / 2;
      if (mx === mn) return 0;
      return l > .5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
    };
    const atmoPseudo = () => {
      const out = [];
      [...document.querySelectorAll('.atmosphere')].forEach((el, i) => {
        ['::before', '::after'].forEach(p => {
          const csA = cs(el, p);
          const bg = csA.backgroundImage;
          if (!bg || bg === 'none') return;
          (bg.match(/rgba?\([^)]*\)/gi) || []).forEach(cstr => {
            const c = parseC(cstr);
            if (!c || c[3] < .02) return;
            const s = satOf(c);
            if (s > 0.15) out.push({ at: `atmosphere[${i}]${p}`, c: cstr, sat: +s.toFixed(2) });
          });
        });
      });
      return out;
    };
    const atmoDirty = atmoPseudo();
    /* 自证：把一条高饱和红渐变塞进 .atmosphere::after，必须被扫到；
       「只禁 ::before 不看 ::after」的旧口径在这种注入下会漏判。 */
    const styleEl = document.createElement('style');
    styleEl.id = 'w5-atmo-inj';
    styleEl.textContent = '.atmosphere::after{background-image:linear-gradient(90deg,#F00 0%,#F00 100%)!important}';
    document.head.appendChild(styleEl);
    const atmoInj = atmoPseudo().length;
    /* 注入态下"只查 ::before"的旧口径命中数：它能证明"合入 ::after"不是重复维度 ——
       旧口径此刻仍是 0，新口径 ≥1。基线两边都是 0（W1 已把色相清零），
       所以增量只能靠注入态证明，不能靠基线计数。 */
    const beforeOnlyInj = [...document.querySelectorAll('.atmosphere')].flatMap(el => {
      const bg = cs(el, '::before').backgroundImage;
      if (!bg || bg === 'none') return [];
      return (bg.match(/rgba?\([^)]*\)/gi) || []).map(parseC).filter(c => c && c[3] >= .02 && satOf(c) > 0.15);
    }).length;
    styleEl.remove();
    const prev = document.body.style.backgroundImage;
    document.body.style.backgroundImage = 'linear-gradient(90deg, rgba(255,0,0,.9), rgba(255,0,0,.9))';
    const dirtyInj = scan().filter(h => h.at === 'BODY');
    document.body.style.backgroundImage = prev;
    const afterStops = atmoAfter === 'none' ? [] : (atmoAfter.match(/rgba?\([^)]*\)/gi) || []);
    /* 旧口径对照：只查 ::before 时会命中多少（用于证明"合入 ::after"这一步是净增维度） */
    const beforeOnlySat = [...document.querySelectorAll('.atmosphere')].flatMap(el => {
      const bg = cs(el, '::before').backgroundImage;
      if (!bg || bg === 'none') return [];
      return (bg.match(/rgba?\([^)]*\)/gi) || []).map(parseC).filter(c => c && c[3] >= .02 && satOf(c) > 0.15);
    }).length;
    return {
      beforeNone: atmoBefore === 'none', atmoBeforeLen: atmoBefore.length,
      afterNone: atmoAfter === 'none',
      afterLinear: (atmoAfter.match(/linear-gradient\(/g) || []).length,
      afterNeutral: afterStops.every(s => { const c = parseC(s); return !c || c[3] < 0.15 || chroma(c) < 0.08; }),
      afterStops: afterStops.length,
      beforeOnlySat,
      atmoDirty: atmoDirty.slice(0, 6), atmoDirtyN: atmoDirty.length, atmoInj,
      dirty: dirty.slice(0, 6), dirtyN: dirty.length, dirtyInjN: dirtyInj.length,
      atoms: [...atoms].sort(), comps: [...comps].sort(),
      radii: new Set([...document.querySelectorAll('.slab,.enamel,.glass,.tool-step-rail,.chart-slab,.set-group')].map(e => cs(e).borderRadius)).size,
      shadows: new Set([...document.querySelectorAll('.slab,.enamel,.glass,.observer-window')].map(e => cs(e).boxShadow)).size
    };
  });
  const RADIUS_ATOMS = ['0px', '8px', '12px', '16px', '9999px', '50%'];
  const badAtoms = (gInfo.atoms || []).filter(a => !RADIUS_ATOMS.includes(a));
  check('QA-A6 氛围渐变 = 0（.atmosphere 全伪元素禁含饱和 >0.15 的色 · ::before 无图）· 全站彩色 linear-gradient = 0 · 圆角取值 ⊆ {0/8/12/16/9999/50%} · 圆角/阴影仍非统一',
    !gInfo.missing && gInfo.beforeNone
    && (gInfo.afterNone || (gInfo.afterLinear === 0 && gInfo.afterNeutral))
    && gInfo.atmoDirtyN === 0 && gInfo.atmoInj >= 1
    && gInfo.dirtyN === 0 && badAtoms.length === 0
    && gInfo.radii > 1 && gInfo.shadows > 1,
    gInfo.missing ? gInfo.missing
      : `::before ${gInfo.beforeNone ? 'none' : '有图(' + gInfo.atmoBeforeLen + ' 字符)'}；`
      + `::after ${gInfo.afterNone ? 'none' : 'linear=' + gInfo.afterLinear + ' 近中性=' + gInfo.afterNeutral + ' 色标=' + gInfo.afterStops}；`
      + `全伪元素高饱和色标 ${gInfo.atmoDirtyN} 处${gInfo.atmoDirtyN ? ' ' + JSON.stringify(gInfo.atmoDirty) : ''}`
      + `（旧口径只看 ::before 会数出 ${gInfo.beforeOnlySat} 处 ⇒ 本判据净增维度）；注入红渐变后命中 ${gInfo.atmoInj} 处（需 ≥1）；`
      + `彩色 linear-gradient ${gInfo.dirtyN} 处${gInfo.dirtyN ? ' ' + JSON.stringify(gInfo.dirty) : ''}；`
      + `圆角原子 ${JSON.stringify(gInfo.atoms)}${badAtoms.length ? ' 越界 ' + JSON.stringify(badAtoms) : ''}；`
      + `复合串 ${JSON.stringify(gInfo.comps)}；圆角/阴影集合 ${gInfo.radii}/${gInfo.shadows}`);
  check('QA-A6b 判据区分力自证（body 注入纯红 linear-gradient 必须被彩色渐变扫描抓到）',
    gInfo.dirtyInjN >= 1,
    `注入后命中 ${gInfo.dirtyInjN} 处（需 ≥1）`);

  const motion = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.reveal:not([data-observe])')];
    const ms = s => String(s).split(',').map(t => { const v = t.trim(); return v.endsWith('ms') ? parseFloat(v) : (v.endsWith('s') ? parseFloat(v) * 1000 : parseFloat(v) || 0); });
    const delays = new Set(), durs = new Set(), props = new Set();
    els.forEach(el => {
      const cs = getComputedStyle(el);
      ms(cs.transitionDelay).forEach(x => delays.add(x));
      ms(cs.transitionDuration).forEach(x => durs.add(x));
      (cs.transitionProperty || '').split(',').forEach(p => props.add(p.trim()));
    });
    const allOne = els.every(el => getComputedStyle(el).opacity === '1');
    return { count: els.length, delays: [...delays].sort((a, b) => a - b), durs: [...durs].sort((a, b) => a - b), props: [...props], allOne };
  });
  const gapOk = JSON.stringify(motion.delays) === JSON.stringify([0, 90, 180, 270, 360]);
  check('QA-A8-1 delays 去重恰好 [0,90,180,270,360]ms、相邻恒 90ms（严格无容差）',
    gapOk, `delays=${JSON.stringify(motion.delays)}`);
  check('QA-A8-2 入场只动 transform / opacity',
    motion.count > 0 && motion.props.length > 0 && motion.props.every(p => ['opacity', 'transform', 'none', ''].includes(p)),
    `${motion.count} 个 reveal · transitionProperty=${JSON.stringify(motion.props)}`);
  check('QA-A8-3 时长非全 300ms 且 delay 多值', motion.durs.length >= 2 && motion.delays.length >= 2,
    `durs=${JSON.stringify(motion.durs)}`);
  check('QA-A8-4 入场完成后 .reveal 内容完全可见', motion.allOne, `${motion.count} 个 reveal 全部 opacity=1`);

  /* ---- D. 三档构成与截图（toast 相交取证放在三档之后，避免瞬时浮层污染截图） ---- */
  await page.waitForTimeout(3700);   // 等前面交互产生的 toast 自然消失，三档截图保持干净
  const fingerprints = {};
  for (const w of [375, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    /* R72-L：.stage 已不是滚动容器，滚动复位对象必须是 [data-scroll-root]，
       否则 DEFECT-2 会受上一板块遗留滚动位置污染（假通过 / 假失败）。 */
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const s = document.querySelector('[data-scroll-root]');
      if (s) s.scrollTop = 0;
      window.__R72.ScrollAffordance.sync();
    });
    const info = await page.evaluate(() => {
      const cs = s => getComputedStyle(document.querySelector(s));
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const obs = document.querySelector('#observerWindow').getBoundingClientRect();
      const rail = document.querySelector('.rail-left').getBoundingClientRect();
      const ruler = document.querySelector('#lightwellRuler').getBoundingClientRect();
      const scrollRoot = document.querySelector('[data-scroll-root]');
      const ow = Math.min(obs.right, stage.right) - Math.max(obs.left, stage.left);
      const oh = Math.min(obs.bottom, stage.bottom) - Math.max(obs.top, stage.top);
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        railW: +rail.width.toFixed(1), resW: +obs.width.toFixed(1),
        cWidth: +stage.width.toFixed(1), scrollH: scrollRoot.clientHeight,
        radius: cs('.stage').borderRadius,
        navDisplay: cs('.view-nav').display, navOverflow: cs('.view-nav').overflowX,
        navWrap: cs('.view-nav').flexWrap, navSnap: cs('.view-nav').scrollSnapType,
        dockH: cs('.cost-dock').height,
        rulerOrient: document.querySelector('#lightwellRuler').getAttribute('data-orientation'),
        rulerFlex: cs('#lightwellRuler').flexDirection, rulerDisplay: cs('#lightwellRuler').display,
        drawerBtn: cs('#viewDrawerBtn').display,
        obsPos: cs('#observerWindow').position,
        overlap: Math.max(0, ow) * Math.max(0, oh),
        rulerTop: ruler.top, rulerH: ruler.height, stageTop: stage.top,
        stageRight: stage.right, obsLeft: obs.left
      };
    });
    fingerprints[w] = info;
    check(`D01 ${w}px 无横向溢出`, info.overflow <= 1, `overflow=${info.overflow}px`);
    const hits = await overlayHits(page);
    check(`QA-A7-6 ${w}px 浮层零相交`, hits.length === 0, hits.length ? JSON.stringify(hits) : '相交对 = 0');
    const smallW = await smallTargets(page);
    check(`QA-A3-5 ${w}px 交互目标 >= 44px`, smallW.length === 0,
      smallW.length ? JSON.stringify(smallW.slice(0, 6)) : '不达标清单为空');
    const cW = await realContrast(page);
    check(`QA-A3-5 ${w}px 真实正文对比度 >= 4.5`,
      cW.length === 9 && cW.every(x => x.ratio >= 4.5),
      `最低 ${cW.length ? Math.min(...cW.map(x => x.ratio)).toFixed(2) : 'NA'}:1，命中 ${cW.length}/9`);

    /* DEFECT-2（实测缺陷）：三档首屏未滚动状态下，关键组件完整可见、
       不被滚动区边界裁切、也不越出视口。A7-6 零容忍判据不变。
       R72-L 加强：滚动复位对象改为 [data-scroll-root]，并追加
       「composer 底边也在首屏内」（composer 升为外壳级常驻件）。 */
    const firstScreen = await page.evaluate(() => {
      const stage = document.querySelector('#mainStage').getBoundingClientRect();
      const pick = sel => {
        const el = document.querySelector(sel);
        if (!el) return { sel: sel, missing: true };
        const c = getComputedStyle(el), r = el.getBoundingClientRect();
        return { sel: sel, display: c.display, top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
                 stageBottom: +stage.bottom.toFixed(1), vh: innerHeight };
      };
      const composer = document.querySelector('#composer').getBoundingClientRect();
      return { list: [pick('.tool-step-rail'), pick('.cost-ribbon'), pick('.observatory')],
               composer: { top: +composer.top.toFixed(1), bottom: +composer.bottom.toFixed(1), vh: innerHeight } };
    });
    const rail = firstScreen.list[0], ribbon = firstScreen.list[1], obs = firstScreen.list[2];
    const railOk = !rail.missing && rail.display !== 'none' &&
      rail.bottom <= rail.stageBottom + 1 && rail.bottom <= rail.vh + 1 && rail.top >= 0;
    const ribbonOk = !ribbon.missing && ribbon.bottom <= ribbon.vh + 1 && ribbon.top >= 0;
    const obsOk = obs.missing || obs.display === 'none' ||
      (obs.bottom <= obs.vh + 1 && obs.top >= 0);
    const composerOk = firstScreen.composer.top >= 0 && firstScreen.composer.bottom <= firstScreen.composer.vh + 1;
    check(`DEFECT-2 ${w}px 首屏关键组件完整可见（rail 不被裁切 / 光带与结果区在视口内 / composer 贴底在首屏）`,
      railOk && ribbonOk && obsOk && composerOk, JSON.stringify(firstScreen));

    if (w === 375) {
      const box = await page.locator('#viewDrawerBtn').boundingBox();
      check('D02 375 单个「板块」按钮 >= 44px', !!box && box.width >= 44 && box.height >= 44,
        box ? `${box.width}x${box.height}` : 'null');
      await page.locator('#viewDrawerBtn').click();
      await page.waitForTimeout(360);
      const dv = await page.locator('#viewDrawer').isVisible();
      const items = await page.locator('#viewDrawer .drawer-list button').count();
      const badItems = await page.evaluate(() => [...document.querySelectorAll('#viewDrawer .drawer-list button')]
        .filter(n => n.getBoundingClientRect().height < 44).length);
      check('D02 375 全屏实心抽屉 9 项且每项 >= 44px', dv && items === 9 && badItems === 0,
        `visible=${dv} items=${items} small=${badItems}`);
      await page.locator('#viewDrawerClose').click();
      await page.waitForTimeout(360);
      check('D02 375 成本光带 56px 紧凑单行且记忆点仍在',
        info.dockH === '56px' && (await page.locator('#costRibbon').isVisible()) && (await page.locator('#costValue').isVisible()),
        `dockH=${info.dockH}`);
      check('D02 375 光井刻度转置为顶部水平光条（不隐藏）',
        info.rulerOrient === 'horizontal' && info.rulerFlex === 'row' && info.rulerDisplay !== 'none',
        `orientation=${info.rulerOrient} flexDirection=${info.rulerFlex}`);
      const ovBdf = await page.evaluate(() => [...document.querySelectorAll('.overlay')].map(n => getComputedStyle(n).backdropFilter));
      check('D02 375 所有浮层 backdropFilter === none', ovBdf.every(v => v === 'none'),
        `${ovBdf.length} 个浮层全部 none`);
    }
    if (w === 768) {
      check('D03 768 顶栏横向 scroll-snap 分段条（不换行）',
        info.navOverflow === 'auto' && info.navWrap === 'nowrap' && /mandatory/.test(info.navSnap),
        `overflowX=${info.navOverflow} wrap=${info.navWrap} snap=${info.navSnap}`);
      check('D03 768 主舞台保留缺角（18px）与刻度（不隐藏）',
        /18px/.test(info.radius) && info.rulerDisplay !== 'none', `radius=${info.radius}`);
      check('D03 768 成本光带上下两行 104px', info.dockH === '104px', `dockH=${info.dockH}`);

      /* D03 第 4 条改写（⟳，强度不降）：旧判据读 #observerWindow 的 position，
         新壳里 R 栏在 768 进 #observerSheet，position 断言会恒真失效。
         新判据查「信息等价 + 一致性」三件套：
           ① R 栏不可见且 0 面积；② sheet 内 5 类读数 + 3 个操作按钮 + 3 个视图入口齐备；
           ③ 每条读数文本与 R 栏同名项逐字相等（ResView 镜像一致性）。 */
      const d03a = await page.evaluate(() => {
        const w = document.querySelector('#observerWindow');
        const r = w.getBoundingClientRect();
        return {
          display: getComputedStyle(w).display,
          area: +Math.max(0, r.width * r.height).toFixed(1),
          readings: [...w.querySelectorAll('.observer-row')].map(n => [
            String(n.children[0].textContent || '').trim(),
            String(n.children[1].textContent || '').trim()]),
          foot: [...w.querySelectorAll('.observer-foot button')].map(b => b.textContent.trim()),
          tabs: [...w.querySelectorAll('[data-res-tab]')].map(b => b.textContent.trim())
        };
      });
      await page.locator('#resToggle').click();
      await page.waitForTimeout(420);
      const d03b = await page.evaluate(() => {
        const sheet = document.querySelector('#observerSheet');
        const body = document.querySelector('#observerSheetBody');
        const r = sheet.getBoundingClientRect();
        return {
          open: !sheet.hidden && sheet.classList.contains('is-open'),
          bottom: +r.bottom.toFixed(1), vh: innerHeight,
          overlay: sheet.classList.contains('overlay'),
          readings: [...body.querySelectorAll('.observer-row')].map(n => [
            String(n.children[0].textContent || '').trim(),
            String(n.children[1].textContent || '').trim()]),
          foot: [...body.querySelectorAll('.observer-foot button')].map(b => b.textContent.trim()),
          tabs: [...body.querySelectorAll('[data-sheet-tab]')].map(b => b.textContent.trim())
        };
      });
      const same = d03a.readings.length === d03b.readings.length &&
        d03a.readings.every((row, i) => row[0] === d03b.readings[i][0] && row[1] === d03b.readings[i][1]);
      check('D03 768 观测窗收进 #observerSheet（R 栏 0 面积 · 5 类读数 + 3 操作钮 + 3 视图入口 · 文本逐字一致）',
        d03a.display === 'none' && d03a.area === 0 &&
        d03b.open && d03b.overlay && d03b.bottom <= d03b.vh + 1 &&
        d03b.readings.length === 5 && d03b.foot.length === 3 && d03b.tabs.length === 3 &&
        same,
        `R[${d03a.display} 面积=${d03a.area}] sheet[open=${d03b.open} bottom=${d03b.bottom}/${d03b.vh} 读数=${d03b.readings.length} 按钮=${d03b.foot.length} 视图=${d03b.tabs.length} 逐字一致=${same}]`);
      await page.locator('#observerSheetClose').click();
      await page.waitForTimeout(420);
    }
    if (w === 1440) {
      /* D04 改写（⟳，强度不降）：「左 8% / 右 22% 偏置」构图按新需求退役。
         新判据钉三栏比例关系 + 中栏主导性，比旧判据只钉两个百分比更强。 */
      const gapCR = +(info.obsLeft - info.stageRight).toFixed(1);
      void gapCR;   /* 保留取数口径备查；判定已改走 gaps（同一矩形，另加 L-C 与令牌） */
      check('D04 1440 三栏比例（L 260 / R 320 非对称，C ≥700 且 C 宽于两侧之和）',
        Math.abs(info.railW - 260) <= 4 && Math.abs(info.resW - 320) <= 4 &&
        Math.abs(info.railW - info.resW) >= 40 && info.cWidth >= 700 &&
        info.cWidth > info.railW + info.resW,
        `railW=${info.railW} resW=${info.resW} cWidth=${info.cWidth} 差=${Math.abs(info.railW - info.resW)}`);
      /* D04 改写（⟳，更严）：「观测窗压边界」退役（R 变栏后几何上不再重叠）。
         旧判据要求重叠 >0，新判据要求零重叠 + 定间隙 → 对「压边界」是收紧。
         R80-R2：SPEC §1 要求栏间距 16 → 12，所以数字换成 12，但**不是只换数字** ——
         新增「令牌与实测同源」这一维度：只改 tokens.css 里 --col-gap 而 views.css 仍用
         字面量 16，或只改 views.css 而不改令牌，都会被两条并列断言分别抓到。 */
      const gaps = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const rect = s => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null; };
        const rail = rect('.rail-left'), stage = rect('#mainStage'), obs = rect('#observerWindow');
        return {
          colGap: root.getPropertyValue('--col-gap').trim(),
          layoutGutter: root.getPropertyValue('--layout-gutter').trim(),
          railW: rail ? +rail.width.toFixed(1) : -1,
          gapLC: rail && stage && rail.width > 0 ? +(stage.left - rail.right).toFixed(1) : null,
          gapCR: stage && obs ? +(obs.left - stage.right).toFixed(1) : null
        };
      });
      const gapOk = v => v === null || Math.abs(v - 12) <= 0.5;
      check('D04 1440 结果区与中栏零重叠且水平定间隙 12px（--col-gap 令牌与实测同源）',
        info.overlap === 0 && gapOk(gaps.gapCR) && gapOk(gaps.gapLC)
        && gaps.colGap === '12px' && gaps.layoutGutter === '12px',
        `相交面积=${info.overlap.toFixed(1)}px² ｜ C-R 间隙=${gaps.gapCR}px · L-C 间隙=${gaps.gapLC}px（各需 12±0.5）`
        + ` ｜ --col-gap=${JSON.stringify(gaps.colGap)} --layout-gutter=${JSON.stringify(gaps.layoutGutter)}（各需 "12px"）`);
      check('D04 1440 光井刻度冲出中栏上边界',
        info.rulerTop < info.stageTop && info.rulerTop + info.rulerH >= info.stageTop - 2,
        `rulerTop=${info.rulerTop} stageTop=${info.stageTop} rulerH=${info.rulerH}`);
    }
    await page.screenshot({ path: join(QA, `03-${w}.png`), fullPage: false });
    result.screenshots.push(`03-${w}.png`);
    /* 三档 × 明暗对照取证：同一板块 / 同一滚动状态下只切主题，截图后立刻还原明色，
       不污染后续档位的任何测量。 */
    await page.evaluate(() => window.__R72.ThemeController.apply('dark'));
    await page.waitForTimeout(320);
    await page.screenshot({ path: join(QA, `05-dark-${w}.png`), fullPage: false });
    result.screenshots.push(`05-dark-${w}.png`);
    await page.evaluate(() => window.__R72.ThemeController.apply('light'));
    await page.waitForTimeout(320);
  }
  /* 指纹键按 LAYOUT-TUNING-SPEC.md §3.7：旧键 ml/mr 已随偏置构图退役，
     换成 railW/resW 并追加 scrollH（滚动视口高度）→ 九位，三档两两不同。 */
  const sig = w => ['railW', 'resW', 'radius', 'navDisplay', 'navOverflow', 'dockH', 'rulerOrient', 'drawerBtn', 'scrollH']
    .map(k => fingerprints[w][k]).join('|');
  check('QA-A3-4 三档构成指纹两两不同（非自动堆叠）',
    new Set([sig(375), sig(768), sig(1440)]).size === 3,
    `375=${sig(375)} | 768=${sig(768)} | 1440=${sig(1440)}`.slice(0, 240));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);

  /* ---- QA-A7-6 独立取证：触发一个真实 toast 后做浮层/关键内容相交检测 ----
     ★ 测量条件（R73-F 补）：本判据必须在一个**静止的基准滚动位置**上量。
     toast 是 `position:fixed; top:82` 的停靠带，而滚动区从 top:81 开始 ——
     两者在几何上就是重叠的，设计靠 `--toast-band:80px` 把内容起点推到 161，
     让首屏内容落在带子下方。**一旦页面滚动，任何内容都会穿过这条带子**，
     那时量到的是"滚动"，不是"遮挡"。
     R73-F 起提交会自动滚到新消息（交互刚需，否则用户看不到自己刚发的话），
     所以测量时必须：① 关掉跟随，② 用瞬时归零取消进行中的平滑滚动。
     **断言一条未改**（相交面积必须为 0）。 */
  await page.evaluate(() => {
    const R = window.__R72;
    R.ChatStream.autoFollow = false;
    R.submitInstruction('读取项目结构摘要');
    const s = document.querySelector('[data-scroll-root]');
    if (s) s.scrollTo({ top: 0, behavior: 'auto' });
  });
  const hits1440 = await overlayHits(page);
  await page.evaluate(() => { window.__R72.ChatStream.autoFollow = true; });
  check('QA-A7-6 真实 toast 浮层与关键内容零相交（1440）', hits1440.length === 0,
    hits1440.length ? JSON.stringify(hits1440) : '相交对 = 0（toast 位于右下留白，主内容在左侧实心台面）');
  await page.waitForTimeout(3700);   // 等 toast 自然消失，不污染后续超预算截图

  /* ==========================================================================
     LAY-01 .. LAY-12（R72-L 三栏工作台壳新增判据，规格 §5）
     每条三件套：正例断言 + 注入反例（改动即失效）+ 源文件锚点。
     ========================================================================== */

  /* ---- LAY-01 · N1：9 板块滚动视口极差 ≤1 且 ≥420 ---- */
  const lay01 = await page.evaluate(vs => {
    const s = document.querySelector('[data-scroll-root]');
    const read = () => {
      const hs = [];
      vs.forEach(v => { window.__R72.ViewRouter.switchTo(v); hs.push(s.clientHeight); });
      return hs;
    };
    const normal = read();
    s.style.height = 'auto'; s.style.flex = '0 0 auto';      // 注入：取消 flex 约束
    const injected = read();
    s.style.height = ''; s.style.flex = '';
    window.__R72.ViewRouter.switchTo('chat');
    window.__R72.ScrollAffordance.sync();
    return { normal, normalRange: Math.max(...normal) - Math.min(...normal),
      injectedRange: Math.max(...injected) - Math.min(...injected) };
  }, VIEWS);
  check('LAY-01 9 板块 [data-scroll-root] 视口极差 ≤1 且 ≥420（注入取消 flex 约束后极差必须放大）',
    lay01.normalRange <= 1 && Math.min(...lay01.normal) >= 420 && lay01.injectedRange > 20 &&
    anchorOk('styles/components.css', 'data-scroll-root'),
    `N1 视口=${JSON.stringify(lay01.normal)} 极差=${lay01.normalRange}；注入后极差=${lay01.injectedRange}`);

  /* ---- LAY-02 · N2/N3：外壳不滚，9 板块切换后 scrollY 恒 0 ---- */
  const lay02 = await page.evaluate(vs => {
    let maxY = 0, maxH = 0;
    vs.forEach(v => {
      window.__R72.ViewRouter.switchTo(v);
      maxY = Math.max(maxY, window.scrollY);
      maxH = Math.max(maxH, document.documentElement.scrollHeight - innerHeight);
    });
    const spike = document.createElement('div');     // 注入：页面级超高占位
    spike.style.height = '1200px';
    document.body.appendChild(spike);
    const injected = document.documentElement.scrollHeight - innerHeight;
    document.body.removeChild(spike);
    window.__R72.ViewRouter.switchTo('chat');
    return { maxY, maxH: +maxH.toFixed(1), injected: +injected.toFixed(1) };
  }, VIEWS);
  check('LAY-02 N2/N3 页面高差 ≤1 且 window.scrollY 恒 0（注入页面级占位后必须破防）',
    lay02.maxH <= 1 && lay02.maxY === 0 && lay02.injected > 1 &&
    anchorOk('styles/base.css', 'flow-root'),
    `N2 页面高差=${lay02.maxH} N3 scrollY=${lay02.maxY}；注入后高差=${lay02.injected}`);

  /* ---- LAY-03 · N4：composer 外壳级常驻 ---- */
  const lay03 = await page.evaluate(vs => {
    const K = document.querySelector('#composer');
    const C = document.querySelector('#mainStage');
    const rects = vs.map(v => {
      window.__R72.ViewRouter.switchTo(v);
      const r = K.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map(n => +n.toFixed(1)).join(',');
    });
    const c = C.getBoundingClientRect(), k = K.getBoundingClientRect();
    window.__R72.ViewRouter.switchTo('chat');
    const outside = K.closest('[data-view-panel]') === null;
    document.querySelector('#panel-chat').appendChild(K);           // 注入：塞回面板
    const injectedInside = K.closest('[data-view-panel]') !== null;
    C.appendChild(K);
    return {
      distinct: new Set(rects).size, outside, injectedInside,
      kTop: +k.top.toFixed(1), kBottom: +k.bottom.toFixed(1),
      cTop: +c.top.toFixed(1), cBottom: +c.bottom.toFixed(1), sample: rects[0]
    };
  }, VIEWS);
  const lay03Gap = +(lay03.cBottom - lay03.kBottom).toFixed(1);
  check('LAY-03 N4 composer 不在任何面板内 · 9 板块 rect 恒定 · 底边贴 C 栏 8–32px',
    lay03.outside && lay03.distinct === 1 &&
    lay03.kBottom <= lay03.cBottom + 0.5 && lay03Gap >= 8 && lay03Gap <= 32 &&
    lay03.kTop >= lay03.cTop + 40 && lay03.injectedInside &&
    anchorOk('styles/components.css', '.composer {') &&
    anchorOk('styles/components.css', 'flex: 0 0 auto'),
    `N4 composer=${lay03.sample} bottom=${lay03.kBottom} ≤ C.bottom=${lay03.cBottom}（贴底带 ${lay03Gap}px）rect 恒定=${lay03.distinct === 1} 面板内=${!lay03.outside} 注入后面板内=${lay03.injectedInside}`);

  /* ---- LAY-04 · N12：滚动容器唯一 ---- */
  const lay04 = await page.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-scroll-root]')];
    const single = roots.length === 1 && roots[0].closest('#mainStage') !== null &&
      !roots[0].classList.contains('overlay');
    const sheet = document.querySelector('#observerSheet');
    sheet.setAttribute('data-scroll-root', '');        // 注入：多一个滚动根
    const injected = document.querySelectorAll('[data-scroll-root]').length;
    sheet.removeAttribute('data-scroll-root');
    return { count: roots.length, single, injected, restored: document.querySelectorAll('[data-scroll-root]').length };
  });
  check('LAY-04 N12 文档中 [data-scroll-root] 恰好 1 个、在 #mainStage 内、不是浮层（注入必破）',
    lay04.single && lay04.injected === 2 && lay04.restored === 1 &&
    anchorOk('index.html', 'data-scroll-root'),
    `N12 数量=${lay04.count} 唯一且合规=${lay04.single}；注入后=${lay04.injected} 还原后=${lay04.restored}`);

  /* ---- LAY-05 · N18：底部渐隐三态 ---- */
  const lay05 = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = document.querySelector('[data-scroll-root]');
    const fade = document.querySelector('#stageScrollFade');
    const op = () => parseFloat(getComputedStyle(fade).opacity);
    window.__R72.ViewRouter.switchTo('settings');
    await wait(480);
    const overflows = S.scrollHeight - S.clientHeight > 1;
    const opScrollable = op();
    const padB = parseFloat(getComputedStyle(S).paddingBottom);
    const delta = +(fade.getBoundingClientRect().bottom - (S.getBoundingClientRect().bottom - padB)).toFixed(1);
    window.__R72.ViewRouter.switchTo('expert');
    await wait(480);
    const opShort = op();
    S.setAttribute('data-scrollable', 'true');          // 注入：必须双属性同时注入
    S.setAttribute('data-at-end', 'false');             // （只注入 scrollable 时 at-end 仍为 true，本就该隐藏）
    await wait(480);
    const opInjected = op();
    window.__R72.ScrollAffordance.sync();
    await wait(480);
    const opRestored = op();
    window.__R72.ViewRouter.switchTo('settings');
    await wait(480);
    S.scrollTop = S.scrollHeight;                       // 滚到底
    window.__R72.ScrollAffordance.sync();
    await wait(480);
    const opAtEnd = op();
    S.scrollTop = 0;
    window.__R72.ViewRouter.switchTo('chat');
    window.__R72.ScrollAffordance.sync();
    return { overflows, opScrollable, delta, opShort, opInjected, opRestored, opAtEnd };
  });
  check('LAY-05 N18 底部渐隐只做渐变：可滚可见 / 不可滚透明 / 滚到底透明（成对 + 注入必破）',
    lay05.overflows && lay05.opScrollable >= 0.9 && Math.abs(lay05.delta) <= 2 &&
    lay05.opShort <= 0.05 && lay05.opInjected >= 0.9 && lay05.opRestored <= 0.05 &&
    lay05.opAtEnd <= 0.05 &&
    anchorOk('styles/components.css', 'data-scrollable="true"') &&
    anchorOk('styles/components.css', 'linear-gradient'),
    `可滚 opacity=${lay05.opScrollable}（贴内容盒底 差=${lay05.delta}px）| 不可滚=${lay05.opShort} | 双属性注入=${lay05.opInjected} | 还原=${lay05.opRestored} | 到底=${lay05.opAtEnd}`);

  /* ---- LAY-06 · N13a：L 栏折叠增量 ≥200（实测 260） ---- */
  const lay06 = await page.evaluate(() => {
    const C = document.querySelector('#mainStage');
    const btn = document.querySelector('#railToggle');
    const before = C.clientWidth;
    const ariaBefore = btn.getAttribute('aria-expanded');
    btn.click();
    const after = C.clientWidth;
    const ariaAfter = btn.getAttribute('aria-expanded');
    btn.click();
    const back = C.clientWidth;
    const shell = document.querySelector('#appShell');
    shell.style.setProperty('--rail-w', '260px');        // 注入：列宽不塌
    btn.click();
    const injected = C.clientWidth;
    btn.click();
    shell.style.removeProperty('--rail-w');
    return { before, after, back, injected, ariaBefore, ariaAfter,
             btnW: +btn.getBoundingClientRect().width.toFixed(1), btnH: +btn.getBoundingClientRect().height.toFixed(1) };
  });
  check('LAY-06 N13 L 栏折叠增量 ≥200（实测 260）· 再点恢复 · aria-expanded 同步 · 折叠钮 ≥44×44',
    lay06.after - lay06.before >= 200 && Math.abs(lay06.back - lay06.before) <= 1 &&
    lay06.injected - lay06.before < 50 && lay06.ariaAfter === 'false' &&
    lay06.btnW >= 44 && lay06.btnH >= 44 &&
    anchorOk('index.html', 'id="railToggle"') &&
    anchorOk('styles/components.css', '--rail-w: 0px'),
    `N13 L 增量=${lay06.after - lay06.before}px（${lay06.before}→${lay06.after}→${lay06.back}）注入后增量=${lay06.injected - lay06.before} aria=${lay06.ariaBefore}→${lay06.ariaAfter} 钮=${lay06.btnW}×${lay06.btnH}`);

  /* ---- LAY-07 · N13b：R 栏折叠增量 ≥200（实测 320）+ ≤1023 走 #observerSheet ---- */
  const lay07a = await page.evaluate(() => {
    const C = document.querySelector('#mainStage');
    const btn = document.querySelector('#resToggle');
    const before = C.clientWidth;
    const ariaBefore = btn.getAttribute('aria-expanded');
    btn.click();
    const after = C.clientWidth;
    const ariaAfter = btn.getAttribute('aria-expanded');
    btn.click();
    const back = C.clientWidth;
    const shell = document.querySelector('#appShell');
    shell.style.setProperty('--res-w', '320px');
    btn.click();
    const injected = C.clientWidth;
    btn.click();
    shell.style.removeProperty('--res-w');
    return { before, after, back, injected, ariaBefore, ariaAfter,
             btnW: +btn.getBoundingClientRect().width.toFixed(1), btnH: +btn.getBoundingClientRect().height.toFixed(1) };
  });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(320);
  const lay07b = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('#resToggle').click();
    await wait(420);
    const sheet = document.querySelector('#observerSheet');
    const r = sheet.getBoundingClientRect();
    return { open: !sheet.hidden && sheet.classList.contains('is-open'),
             bottom: +r.bottom.toFixed(1), vh: innerHeight };
  });
  await page.evaluate(() => document.querySelector('#observerSheetClose').click());
  await page.waitForTimeout(420);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(320);
  check('LAY-07 N13 R 栏折叠增量 ≥200（实测 320）· 窄屏改开 #observerSheet（bottom ≤ innerHeight）',
    lay07a.after - lay07a.before >= 200 && Math.abs(lay07a.back - lay07a.before) <= 1 &&
    lay07a.injected - lay07a.before < 50 && lay07a.ariaAfter === 'false' &&
    lay07a.btnW >= 44 && lay07a.btnH >= 44 &&
    lay07b.open && lay07b.bottom <= lay07b.vh + 1 &&
    anchorOk('index.html', 'id="resToggle"') &&
    anchorOk('styles/components.css', '--res-w: 0px'),
    `N13 R 增量=${lay07a.after - lay07a.before}px（${lay07a.before}→${lay07a.after}→${lay07a.back}）注入后增量=${lay07a.injected - lay07a.before} aria=${lay07a.ariaBefore}→${lay07a.ariaAfter} 钮=${lay07a.btnW}×${lay07a.btnH}；768 sheet open=${lay07b.open} bottom=${lay07b.bottom}/${lay07b.vh}`);

  /* ---- LAY-08：板块切换滚动归零 ---- */
  const lay08 = await page.evaluate(vs => {
    const S = document.querySelector('[data-scroll-root]');
    window.__R72.ViewRouter.switchTo('settings');
    S.scrollTop = 200;
    const canScroll = S.scrollTop > 150;          // 自检：断言非空转
    const leftovers = [];
    vs.forEach(v => { window.__R72.ViewRouter.switchTo(v); leftovers.push(S.scrollTop); });
    window.__R72.ViewRouter.switchTo('chat');
    return { canScroll, max: Math.max(...leftovers), leftovers };
  }, VIEWS);
  check('LAY-08 板块切换后 [data-scroll-root].scrollTop 恒为 0（先自检容器可承载非零 scrollTop）',
    lay08.canScroll && lay08.max === 0 &&
    anchorOk('scripts/main.js', 'scrollTop = 0'),
    `可滚自检=${lay08.canScroll} 9 次切换后 scrollTop=${JSON.stringify(lay08.leftovers)}`);

  /* ---- LAY-09：R 栏三视图互斥 ---- */
  const lay09 = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('[data-res-panel]')];
    const visible = () => panels.filter(p => !p.hidden && p.getClientRects().length > 0).length;
    const first = visible();
    document.querySelector('[data-res-tab="diff"]').click();
    const selected = [...document.querySelectorAll('[data-res-tab]')]
      .filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.getAttribute('data-res-tab'));
    const diffVisible = !document.querySelector('[data-res-panel="diff"]').hidden;
    const afterSwitch = visible();
    document.querySelector('[data-res-panel="observer"]').hidden = false;   // 注入：两个面板同显
    const injected = visible();
    document.querySelector('[data-res-panel="observer"]').hidden = true;
    document.querySelector('[data-res-tab="observer"]').click();
    return { count: panels.length, first, selected, diffVisible, afterSwitch, injected };
  });
  check('LAY-09 R 栏 [data-res-panel] 恰好 3 个、任一时刻可见恰好 1 个、tab 单选（注入双显必破）',
    lay09.count === 3 && lay09.first === 1 && lay09.afterSwitch === 1 && lay09.injected === 2 &&
    lay09.diffVisible && lay09.selected.length === 1 && lay09.selected[0] === 'diff' &&
    anchorOk('index.html', 'data-res-panel'),
    `面板=${lay09.count} 初始可见=${lay09.first} 切换后可见=${lay09.afterSwitch} 注入双显=${lay09.injected} 选中=${JSON.stringify(lay09.selected)}`);

  /* ---- LAY-10：上下文条与 R 栏读数同源 ---- */
  const lay10 = await page.evaluate(() => {
    const model = String(document.querySelector('#observerModel').textContent || '').trim();
    const ctxModelEl = document.querySelector('#ctxModel');
    const ctxModel = String(ctxModelEl.textContent || '').trim();
    const label = String(document.querySelector('#clearanceLabel').textContent || '').trim();
    const ctxMode = String(document.querySelector('#ctxMode').textContent || '').trim();
    ctxModelEl.textContent = 'gpt-4';               // 注入：写死一个不一致值
    const injected = String(ctxModelEl.textContent || '').trim() !== model;
    ctxModelEl.textContent = ctxModel;
    return { model, ctxModel, label, ctxMode, injected };
  });
  check('LAY-10 #ctxModel / #ctxMode 与 R 栏读数 / 光带密级同源（写死即破）',
    lay10.model === lay10.ctxModel && lay10.label === lay10.ctxMode && lay10.injected &&
    lay10.model.length > 0 && lay10.label.length > 0 &&
    anchorOk('scripts/main.js', 'ctxModel'),
    `模型 ${lay10.ctxModel} === R 栏 ${lay10.model}；密级 ${lay10.ctxMode} === 光带 ${lay10.label}`);

  /* ---- LAY-11：.set-stack 改 flex 后 .save-bar sticky 生效 ---- */
  const lay11 = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const S = document.querySelector('[data-scroll-root]');
    const bar = document.querySelector('.save-bar');
    window.__R72.ViewRouter.switchTo('settings');
    await wait(200);
    const max = S.scrollHeight - S.clientHeight;
    const gaps = [], tops = [];
    for (const ratio of [0, 0.5, 1]) {           // 三位置：顶 / 中 / 底
      S.scrollTop = Math.round(max * ratio);
      await wait(160);
      gaps.push(+(S.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom).toFixed(1));
      tops.push(+bar.getBoundingClientRect().top.toFixed(1));
    }
    const spread = +(Math.max(...tops) - Math.min(...tops)).toFixed(1);
    S.scrollTop = 0;                              // 负控必须在顶部做：撤掉 sticky 后条会随内容滚到视口外
    await wait(160);
    const prev = bar.style.position;
    bar.style.position = 'static';
    await wait(160);
    const injectedGap = +(S.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom).toFixed(1);
    bar.style.position = prev;
    await wait(160);
    const restoredGap = +(S.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom).toFixed(1);
    S.scrollTop = 0;
    window.__R72.ViewRouter.switchTo('chat');
    return { gaps, tops, spread, injectedGap, restoredGap,
             display: getComputedStyle(document.querySelector('.set-stack')).display };
  });
  check('LAY-11 settings 顶/中/底三位置 .save-bar 恒由 sticky 贴滚动区底边（撤 sticky 即滚走）',
    lay11.gaps.every(g => g >= -1 && g <= 48) && lay11.spread <= 2 &&
    lay11.injectedGap < -100 && lay11.restoredGap >= -1 && lay11.restoredGap <= 48 &&
    lay11.display === 'flex' &&
    anchorOk('styles/views.css', '.set-stack { display: flex'),
    `三位置贴底间距=${JSON.stringify(lay11.gaps)} barTop=${JSON.stringify(lay11.tops)} 极差=${lay11.spread}；负控 static=${lay11.injectedGap} 还原=${lay11.restoredGap}；容器 display=${lay11.display}`);

  /* ---- LAY-12：toast 停靠带 ----
     ★ 与 QA-A7-6 同一个测量条件：静止基准位置量停靠带。
     toast 固定 `top:82`，滚动区从 `top:81` 开始，靠 `--toast-band:80px`
     把内容起点推到 161 才不压；任何滚动都会让内容穿过带子。
     故测量前关跟随 + 瞬时归零（取消进行中的平滑滚动），测完恢复。**断言未改。** */
  await page.evaluate(() => {
    const R = window.__R72;
    R.ChatStream.autoFollow = false;
    R.submitInstruction('读取项目结构摘要');
    const s = document.querySelector('[data-scroll-root]');
    if (s) s.scrollTo({ top: 0, behavior: 'auto' });
  });
  const lay12 = await page.evaluate(() => {
    const toast = document.querySelector('#toastHost .toast');
    if (!toast) { window.__R72.ChatStream.autoFollow = true; return { missing: true }; }
    const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const t = toast.getBoundingClientRect();
    const K = document.querySelector('#composer').getBoundingClientRect();
    const D = document.querySelector('#glass-ribbon').getBoundingClientRect();
    const keys = [...document.querySelectorAll('[data-key-content]')].map(n => n.getBoundingClientRect());
    const C = document.querySelector('#mainStage').getBoundingClientRect();
    const ctxH = parseFloat(getComputedStyle(document.querySelector('.stage-head')).height);
    const normal = { k: inter(t, K), d: inter(t, D), key: keys.reduce((s, r) => s + inter(t, r), 0),
      top: +t.top.toFixed(1), floor: +(C.top + ctxH).toFixed(1) };
    const host = document.querySelector('#toastHost');
    const prev = host.getAttribute('style') || '';
    host.style.left = 'calc(var(--rail-w) + 60px)';
    host.style.right = 'auto';
    host.style.top = 'auto';
    host.style.bottom = 'calc(var(--dock-h) + 40px)';
    const t2 = toast.getBoundingClientRect();
    const injected = { k: inter(t2, K), key: keys.reduce((s, r) => s + inter(t2, r), 0) };
    host.setAttribute('style', prev);
    window.__R72.ChatStream.autoFollow = true;
    return { normal, injected };
  });
  check('LAY-12 toast 与 composer / 光带 / [data-key-content] 零相交且不越过上下文条（挪位即破）',
    !lay12.missing && lay12.normal.k === 0 && lay12.normal.d === 0 && lay12.normal.key === 0 &&
    lay12.normal.top >= lay12.normal.floor - 0.5 &&
    (lay12.injected.k > 0 || lay12.injected.key > 0) &&
    anchorOk('styles/components.css', '--toast-band'),
    JSON.stringify(lay12));
  await page.waitForTimeout(3700);   // 等 toast 自然消失

  /* ---- LAY-13：上下文条副标题「不得既可见又被截断」（主理人实测缺陷） ----
     实测背景：eyebrow 重复品牌把标题块撑到 261px，1440 下 #stageSub 只剩 201px
     （文本需 239）、768 下只剩 141px（十八字只出七个）。修法是隐藏 .eyebrow-brand
     这个重复品牌节点，把宽度还给副标题。
     判据形态：允许「完整显示」或「有意隐藏」，**禁止中间态**（可见但被截断）；
     并配注入反例证明判据有区分力。 */
  const lay13 = [];
  for (const w of [1440, 768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(200);
    lay13.push(await page.evaluate(() => {
      const s = document.querySelector('#stageSub');
      if (!s) return { missing: true };
      const cs = getComputedStyle(s);
      const hidden = cs.display === 'none' || parseFloat(cs.opacity) === 0 || s.getClientRects().length === 0;
      return { hidden: hidden, clientW: s.clientWidth, scrollW: s.scrollWidth,
               truncated: !hidden && s.scrollWidth > s.clientWidth + 1 };
    }));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  /* 注入反例：强制 60px + nowrap，判据必须观测到 truncation，否则判据无区分力 */
  const l13inj = await page.evaluate(() => {
    const s = document.querySelector('#stageSub');
    const prev = s.getAttribute('style');
    s.style.cssText = 'white-space:nowrap;overflow:hidden;flex:0 0 auto;width:60px;max-width:60px;display:block;opacity:1';
    const r = { clientW: s.clientWidth, scrollW: s.scrollWidth, truncated: s.scrollWidth > s.clientWidth + 1 };
    if (prev === null) s.removeAttribute('style'); else s.setAttribute('style', prev);
    return r;
  });
  const l13NoTrunc = lay13.every(x => !x.missing && !x.truncated);
  check('LAY-13 三档上下文条副标题不得「既可见又被截断」（注入窄宽后必须观测到截断）',
    l13NoTrunc && l13inj.truncated === true &&
    anchorOk('styles/components.css', 'eyebrow-brand'),
    `1440=${lay13[0].hidden ? '隐藏' : lay13[0].clientW + '/' + lay13[0].scrollW}` +
    ` 768=${lay13[1].hidden ? '隐藏' : lay13[1].clientW + '/' + lay13[1].scrollW}` +
    ` 375=${lay13[2].hidden ? '隐藏' : lay13[2].clientW + '/' + lay13[2].scrollW}` +
    ` | 注入 60px 后 ${l13inj.clientW}/${l13inj.scrollW} 截断=${l13inj.truncated}`);


  /* ---- C04 / C05 / B06 / QA-A4-3 双重降级 ---- */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(90);
  const reduced = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.reveal')];
    return {
      durs: els.map(e => getComputedStyle(e).transitionDuration),
      allOne: els.every(e => getComputedStyle(e).opacity === '1'),
      bdf: getComputedStyle(document.querySelector('#glass-top')).backdropFilter,
      bg: getComputedStyle(document.querySelector('#glass-top')).backgroundColor
    };
  });
  const allZero = reduced.durs.every(d => String(d).split(',').every(t => parseFloat(t) <= 0.00002));
  check('C04 reduced-motion 过渡关闭（含 1e-05s 科学计数法）+ 内容完全可见',
    allZero && reduced.allOne, `durs 样本=${JSON.stringify(reduced.durs.slice(0, 3))} allOpacityOne=${reduced.allOne}`);
  check('B06 reduce 后玻璃实体化（blur none + alpha=1）',
    reduced.bdf === 'none' && alphaOf(reduced.bg) === 1, `bdf=${reduced.bdf} bg=${reduced.bg}`);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(80);
  await page.locator('#fxToggle').click();
  const fxState = await page.evaluate(() => ({
    cls: document.body.classList.contains('fx-off'),
    dur: getComputedStyle(document.querySelector('.reveal')).transitionDuration,
    bdf: getComputedStyle(document.querySelector('#glass-top')).backdropFilter,
    bg: getComputedStyle(document.querySelector('#glass-top')).backgroundColor
  }));
  check('C05 / QA-A4-2 body.fx-off 生效且玻璃实体化',
    fxState.cls && parseFloat(fxState.dur) <= 0.00002 && fxState.bdf === 'none' && alphaOf(fxState.bg) === 1,
    JSON.stringify(fxState));
  await page.locator('#fxToggle').click();

  const combos = [
    { r: 'reduce', fx: false, expect: true }, { r: 'reduce', fx: true, expect: true },
    { r: 'no-preference', fx: false, expect: true }, { r: 'no-preference', fx: true, expect: false }
  ];
  let matrixOk = true; const matrixDetail = [];
  for (const c of combos) {
    await page.emulateMedia({ reducedMotion: c.r });
    await page.evaluate(v => { window.__R72.FxController.enabled = v; window.__R72.FxController.sync(); }, c.fx);
    await page.waitForTimeout(50);
    const s = await page.evaluate(() => ({
      dur: getComputedStyle(document.querySelector('.reveal')).transitionDuration,
      bdf: getComputedStyle(document.querySelector('#glass-top')).backdropFilter
    }));
    const degraded = String(s.dur).split(',').every(t => parseFloat(t) <= 0.00002) && s.bdf === 'none';
    matrixDetail.push(`${c.r}/${c.fx ? 'fx-on' : 'fx-off'}=${degraded ? '降级' : '动效'}`);
    if (degraded !== c.expect) matrixOk = false;
  }
  check('QA-A4-3 双通道 2x2 矩阵（前 3 降级 / 第 4 保留）', matrixOk, matrixDetail.join(' '));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { window.__R72.FxController.enabled = true; window.__R72.FxController.sync(); });
  await page.waitForTimeout(80);

  /* ---- 记忆点：超预算整条转暖琥珀 + 文字 ---- */
  await page.locator('#overBudgetBtn').click();
  await page.waitForTimeout(420);
  const over = await page.evaluate(() => ({
    flag: document.querySelector('#glass-ribbon').getAttribute('data-over-budget'),
    noteOpacity: getComputedStyle(document.querySelector('#budgetNote')).opacity,
    noteText: document.querySelector('#budgetNote').textContent,
    level: document.querySelector('#costRibbon').getAttribute('data-level'),
    fill: getComputedStyle(document.querySelector('.ribbon-fill')).backgroundColor,
    sendDisabled: document.querySelector('#sendBtn').disabled
  }));
  check('MEM-01 超预算整条转暖琥珀 + 浮出文字 + 禁用生成',
    over.flag === 'true' && parseFloat(over.noteOpacity) > 0.9 && /预算已用尽/.test(over.noteText) &&
    over.level === 'warn' && over.sendDisabled,
    `flag=${over.flag} noteOpacity=${over.noteOpacity} level=${over.level} fill=${over.fill} sendDisabled=${over.sendDisabled}`);
  await page.screenshot({ path: join(QA, '04-over-budget-1440.png'), fullPage: false });
  result.screenshots.push('04-over-budget-1440.png');

  /* ---- DEFECT-1（实测缺陷）：空态断言文案与成本 / 消息不得同屏。
     正样本 = 重置后纯空态；反例 = 注入成本后若空态文案仍在则 FAIL。

     【判据修正 · 2026-11-12 主理人实测】原判据
       `!!e && !e.hidden && getComputedStyle(e).display !== 'none'`
     是**恒真判据**，零区分力：#emptyCopy 是 #emptyGuide 的**子元素**（index.html:72/74），
     `EmptyStateController.sync()` 切换的是**父元素** `#emptyGuide.hidden`；
     而祖先 display:none **不会改变子元素自身** `getComputedStyle().display`（仍是 block），
     故该式在「初始态 / 纯空态 / 注入成本后」三态恒为 true —— 旧脚本因此报 89/91，
     误把已修好的实现判红（实为**断言 Bug**，不是实现回归）。
     修正为 `checkVisibility({checkOpacity,checkVisibilityCSS})`：它沿祖先链计算
     真实可见性（含 display:none / visibility / opacity / content-visibility），
     并以 getClientRects().length 交叉校验；同时要求父容器自身可见。 */
  const readEmpty = () => page.evaluate(() => {
    const realVisible = (el) => {
      if (!el) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) !== false &&
               el.getClientRects().length > 0;
      }
      return !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    };
    const copy = document.querySelector('#emptyCopy');
    const guide = document.querySelector('#emptyGuide');
    const emptyVisible = realVisible(guide) && realVisible(copy);
    const cost = document.querySelector('#costValue').textContent.trim();
    const msgs = document.querySelectorAll('.msg:not([hidden])').length;
    const lit = document.querySelectorAll('.ribbon-tick.is-lit').length;
    return { emptyVisible: emptyVisible, guideHidden: guide ? guide.hasAttribute('hidden') : null,
             copyRects: copy ? copy.getClientRects().length : -1,
             cost: cost, msgs: msgs, lit: lit,
             conflict: emptyVisible && (msgs > 0 || lit > 0 || !/^¥0\.00/.test(cost)) };
  });
  const e0 = await readEmpty();
  check('DEFECT-1 初始反例态：有示例会话与成本时空态断言文案不可见',
    !e0.emptyVisible && !e0.conflict, JSON.stringify(e0));

  /* ---- DEFECT-1b（同族缺陷 · 文案级）：欢迎态「能力说明」在有会话数据时
     不得退化为「首次使用指令」。DEFECT-1 修的是状态断言与数据矛盾；本组守的是
     指令语气与数据矛盾（首屏已有 3 次调用，却写「输入一条指令开始一次调用」）。
     判据取**负向禁用短语**，并配注入反例证明有区分力（防恒真）。 */
  const readWelcome = () => page.evaluate(() => {
    const w = document.querySelector('#chatWelcome');
    const vis = !!w && (typeof w.checkVisibility === 'function'
      ? w.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : !(w.hidden || getComputedStyle(w).display === 'none'));
    const text = w ? (w.innerText || w.textContent || '').replace(/\s+/g, ' ') : '';
    const msgs = document.querySelectorAll('.msg:not([hidden])').length;
    const BAN = ['输入一条指令', '尚未产生费用', '从零开始', '还没有任何'];
    const hits = BAN.filter(function (p) { return text.indexOf(p) >= 0; });
    return { visible: vis, msgs: msgs, hits: hits,
             conflict: vis && msgs > 0 && hits.length > 0, text: text.slice(0, 64) };
  });
  const w0 = await readWelcome();
  check('DEFECT-1b 欢迎态能力说明无首用指令文案（有会话数据时不得退化）',
    w0.visible && w0.msgs > 0 && w0.hits.length === 0 && !w0.conflict, JSON.stringify(w0));
  /* 反例注入：把旧的首用指令文案写回 DOM → 判据必须翻转为冲突；随后还原。 */
  await page.evaluate(() => {
    const n = document.querySelector('#chatWelcome .mini-note');
    n.setAttribute('data-orig', n.textContent);
    n.textContent = '输入一条指令开始一次调用，观察刻度与 ¥ 读数同步变化。';
  });
  const wInj = await readWelcome();
  check('DEFECT-1b 反例注入：写回首用指令文案后判据必须翻转为冲突',
    wInj.conflict === true && wInj.hits.length > 0, JSON.stringify(wInj));
  await page.evaluate(() => {
    const n = document.querySelector('#chatWelcome .mini-note');
    if (n.hasAttribute('data-orig')) {
      n.textContent = n.getAttribute('data-orig');
      n.removeAttribute('data-orig');
    }
  });
  const wBack = await readWelcome();
  check('DEFECT-1b 注入还原：还原文案后判据必须回落为无冲突',
    wBack.conflict === false && wBack.hits.length === 0, JSON.stringify(wBack));
  await page.locator('#resetBudgetBtn').click();
  await page.waitForTimeout(420);
  const e1 = await readEmpty();
  check('DEFECT-1 正样本：重置后纯空态（文案可见 / 消息 0 / ¥0.00 / 刻度 0）',
    e1.emptyVisible && !e1.conflict && e1.msgs === 0 && e1.lit === 0 && /^¥0\.00/.test(e1.cost),
    JSON.stringify(e1));
  /* 判据区分力自检（防恒真）：同一判据必须在「初始态 false / 纯空态 true」间真实翻转。
     若两态同值，说明判据无区分力（旧脚本即此病），直接 FAIL。 */
  check('DEFECT-1 判据区分力：同一判据在初始态 false、纯空态 true（防恒真）',
    e0.emptyVisible === false && e1.emptyVisible === true,
    `初始=${e0.emptyVisible} 纯空态=${e1.emptyVisible}`);
  await page.locator('#userInput').fill('扫描 server/src 依赖图');
  await page.locator('#composer').dispatchEvent('submit');
  await page.waitForTimeout(1500);
  const e2 = await readEmpty();
  check('DEFECT-1 反例：注入成本后空态断言文案必须隐藏（仍在则 FAIL）',
    !e2.emptyVisible && !e2.conflict && e2.lit > 0, JSON.stringify(e2));
  /* 反例注入（三件套第 3 件 · 对应 QA N15）：成本 > 0 时强行解除 #emptyGuide 的
     hidden，判据必须翻转为「可见且冲突成立」——证明判据能抓到真实同屏矛盾；
     随后还原并确认回落到不可见，排除「注入后无法恢复」的假通过。 */
  await page.evaluate(() => { document.querySelector('#emptyGuide').hidden = false; });
  await page.waitForTimeout(120);
  const eInj = await readEmpty();
  check('DEFECT-1 反例注入：强行显示空态引导后判据必须翻转为可见且冲突成立',
    eInj.emptyVisible === true && eInj.conflict === true, JSON.stringify(eInj));
  await page.evaluate(() => { document.querySelector('#emptyGuide').hidden = true; });
  await page.waitForTimeout(120);
  const eBack = await readEmpty();
  check('DEFECT-1 注入还原：还原 hidden 后判据必须回落为不可见且无冲突',
    eBack.emptyVisible === false && eBack.conflict === false, JSON.stringify(eBack));

  /* ---- R86 · AGENT-V3-CLOSED-LOOP：V3 生成式展台 / MCP 下钻 / 记忆检索闭环 ----
     三步全部「动作 → 观察 → 还原」，测完把状态放回去，不污染后续判据。
     置在 F 段之前：任何因本模块引入的 console error 都会被 F03 抓住。 */
  const v3Result = await page.evaluate(() => {
    const v3 = window.LightwellAgentV3;
    if (!v3) return { missing: true };

    /* 1. 生成式展台磁贴切换（selectTile 读写 .plinth-enamel 与折线系列） */
    v3.GenerativeUIEngine.selectTile(1);
    const enamelText = (document.querySelector('#panel-generative .plinth-enamel')?.textContent || '').trim();
    const tileOk = enamelText.indexOf('循环引用摘要') >= 0;
    v3.GenerativeUIEngine.selectTile(0);
    const tileBack = (document.querySelector('#panel-generative .plinth-enamel')?.textContent || '').indexOf('依赖图') >= 0;

    /* 2. MCP 服务器架下钻：webdav（空能力）显示空态，再切回 filesystem 恢复表 */
    const slats = [...document.querySelectorAll('#panel-mcp .server-rack .server-slat')];
    if (slats[2]) slats[2].click();
    const emptyShown = !document.querySelector('#registryEmpty')?.hidden && !!document.querySelector('#registryWrap')?.hidden;
    if (slats[0]) slats[0].click();
    const tableRestored = !!document.querySelector('#registryEmpty')?.hidden && !document.querySelector('#registryWrap')?.hidden;

    /* 3. 记忆检索井：查「只读」只应命中 1 条，且关键词被包进 .hit-mark */
    const qInput = document.querySelector('#memoryQuery');
    if (qInput) { qInput.value = '只读'; v3.MemoryWellEngine.filter(); }
    const rows = [...document.querySelectorAll('#panel-memory .hit-stream .hit-row')];
    const visibleHits = rows.filter(r => !r.hidden).length;
    const marked = document.querySelectorAll('#panel-memory .hit-row .hit-mark').length;
    if (qInput) { qInput.value = ''; v3.MemoryWellEngine.filter(); }
    const restoredHits = [...document.querySelectorAll('#panel-memory .hit-stream .hit-row')].filter(r => !r.hidden).length;

    return {
      missing: false, tileOk, tileBack, emptyShown, tableRestored,
      visibleHits, marked, restoredHits
    };
  });
  check('AGENT-V3-CLOSED-LOOP 前沿 Agent 生成式展台 / MCP 下钻 / 记忆检索闭环生效且可还原',
    !v3Result.missing && v3Result.tileOk && v3Result.tileBack &&
    v3Result.emptyShown && v3Result.tableRestored &&
    v3Result.visibleHits === 1 && v3Result.marked >= 1 && v3Result.restoredHits === 4,
    JSON.stringify(v3Result));

  /* ---- F. 零外网 / 零运行时错误 ---- */
  const nonFile = result.requests.filter(u => !/^(file:|data:)/.test(u));
  check('F01 页面请求仅 file: / data:（零 http(s)）', nonFile.length === 0,
    `共 ${result.requests.length} 个请求，非 file/data ${nonFile.length} 个`);
  check('F03 / A12 零 pageerror、零 console error',
    result.pageErrors.length === 0 && result.consoleErrors.length === 0,
    `pageErrors=${JSON.stringify(result.pageErrors)} consoleErrors=${JSON.stringify(result.consoleErrors)}`);

  await ctx.close();
  ctx = null;
} catch (err) {
  check('HARNESS 验收脚本执行异常', false, String(err && err.stack ? err.stack : err));
} finally {
  if (ctx) { try { await ctx.close(); } catch (e) { /* 关闭失败不覆盖已有结论 */ } }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
}

/* ---- R86 · FILTER-DOC-SYNC：光学滤镜库注释声明的数量必须等于实际 <filter> 节点数 ----
   守「注释里的数」这一类静默漂移：R85 删掉 #liquid-gooey-nav 后，
   index.html 的注释仍写着"三个 <filter>"，而 152 条判据全绿也抓不到。
   本条只认两件事：defs 块内 <filter> 实数 == 2，且注释明写"两个 <filter>"。 */
{
  const defsBlock = (htmlText.match(/<!--[\s\S]*?光学滤镜库[\s\S]*?-->\s*<svg id="liquidOpticsDefs"[\s\S]*?<\/svg>/) || [''])[0];
  /* 先剥 HTML 注释再数：注释正文里自己会写「两个 <filter>」这类字样，
     不剥就会把它算成一个真实节点（首版实测 3 个，正是这个原因）。 */
  const defsNoComment = defsBlock.replace(/<!--[\s\S]*?-->/g, '');
  const actualFilterCount = (defsNoComment.match(/<filter\b/g) || []).length;
  const docSaysTwo = /两个\s*<filter>/.test(defsBlock);
  check('FILTER-DOC-SYNC 光学滤镜库注释声明数量与实际 <filter> 节点数一致',
    defsBlock.length > 0 && actualFilterCount === 2 && docSaysTwo,
    `defs 块${defsBlock.length ? '已匹配' : '未匹配'}；剥注释后实际 <filter> 节点=${actualFilterCount} 个；注释声明「两个 <filter>」=${docSaysTwo}`);
}

/* ---- R85 · CASCADE-01：跨文件同选择器重声明必须全部带意图注释 ----
   守 KNOWN_ISSUES.md §3「层叠覆盖链」的机器侧：调用只读扫描器
   qa/r83/scan-cascade-order.mjs，出现未注释的跨文件覆盖对即 exit 1。
   判据只认「exit 0 且 stdout 含 [CASCADE] 汇总行」——不改扫描器口径、不放宽标准。
   cwd 取 DESIGN（= liquid-glass 根），扫描器自身以 index.html 的 <link> 顺序为口径。 */
try {
  const casc = spawnSync(process.execPath, [join(DESIGN, 'qa', 'r83', 'scan-cascade-order.mjs')], {
    cwd: DESIGN, encoding: 'utf8', timeout: 120000
  });
  const cascStatus = casc && typeof casc.status === 'number' ? casc.status : -1;
  const cascOut = String((casc && casc.stdout) || '');
  const cascErr = String((casc && casc.stderr) || '');
  const cascLine = (cascOut.split(/\r?\n/).find(l => l.includes('[CASCADE]')) || '').trim();
  check('CASCADE-01 跨文件同选择器重声明全部带意图注释（scan-cascade-order.mjs exit 0）',
    cascStatus === 0 && cascLine.length > 0,
    cascLine
      ? cascLine + ' | exit=' + cascStatus
      : 'exit=' + cascStatus + ' | stderr=' + cascErr.slice(0, 300));
} catch (err) {
  check('CASCADE-01 跨文件同选择器重声明全部带意图注释（scan-cascade-order.mjs exit 0）',
    false, 'CASCADE-01 执行异常：' + String(err && err.message ? err.message : err).slice(0, 300));
}

result.summary = {
  total: result.checks.length,
  passed: result.checks.filter(c => c.ok).length,
  failed: result.checks.filter(c => !c.ok).map(c => c.name),
  warnings: result.warnList.length
};
writeFileSync(join(QA, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');
console.log('\n[VERIFY]', result.summary.passed, '/', result.summary.total, 'PASS',
  '| FAIL =', JSON.stringify(result.summary.failed),
  '| WARN =', result.summary.warnings);
process.exitCode = result.summary.failed.length ? 1 : 0;
