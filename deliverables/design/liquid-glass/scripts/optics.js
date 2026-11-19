/* ============================================================================
   R81 Phase 2 · 光学引擎（新建文件，W4 独占）
   ----------------------------------------------------------------------------
   契约：r81/CONTRACT-R81.md §3.5（B 侧全局对象与写入的 CSS 变量）
        + 任务 A（指针追光 / 壁纸主色 / 滚动速度 / 空闲停摆 / 降级）

   window.LiquidOptics = { attach, refresh, setEnabled, stats }

   它只写两种东西：
     1. 目标元素的行内自定义属性（--local-x / --local-y / --light-angle /
        --proximity / --scroll-v / --scroll-abs）
     2. :root 的行内自定义属性（--cursor-x / --cursor-y / --wp-dominant-rgb /
        --wp-accent-rgb / --wp-luma / --wp-vx / --wp-vy）

   三条纪律写在最前面：
   1. 单一 pointermove 监听 + rAF 合并。绝不逐元素挂监听——
      5 处玻璃 × N 个 .liquid-surface，逐元素挂就是 N 个回调。
   2. rAF 循环里只做数学。元素矩形 200ms 缓存一次，不做 offsetWidth / scrollTop
      这类强制同步布局的读。
   3. 2000ms 无事件 → cancelAnimationFrame。静止页面的 CPU 占用必须是 0。
   ============================================================================ */
(function () {
  'use strict';

  if (window.LiquidOptics) return; /* 重复 <script> 不重复定义 */

  /* ---------------------------------------------------------------- 常量 */

  var IDLE_MS = 2000;      /* 空闲停摆阈值（契约硬性要求） */
  var RECT_TTL = 200;      /* 元素矩形缓存寿命 ms */
  var FADE_PX = 80;        /* --proximity 出界后 80px 归零 */
  var SURFACE_SEL = '.liquid-surface';
  var SHEEN_SEL = '.msg--assistant, .composer, .set-group, .plinth-tile, .gen-inline-card';
  var REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

  /* ------------------------------------------------------ reduced-motion */

  var motionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCE_QUERY)
    : null;

  function prefersReduced() {
    return !!(motionQuery && motionQuery.matches);
  }

  /* --------------------------------------------------------------- 状态 */

  var enabled = true;
  var bound = new WeakSet();
  var rafId = 0;
  var idleTimer = 0;

  var pointer = { x: 0, y: 0, has: false, target: null };
  var surfaces = [];          /* [{ el, rect }] 缓存，200ms 过期 */
  var rectsAt = 0;

  var lastScroll = new Map(); /* el -> { t, top } */
  var scrollDecay = 0;        /* 速度衰减用的 rAF 计数 */
  var dirty = false;          /* 有新的指针位置待画 */

  var stats = { frames: 0, lastMs: 0 };
  var frameStart = 0;

  var rootEl = null;
  var wpHooked = false;
  var lastWp = null;
  var lastSheenHost = null;
  var refreshQueued = false;

  /* ------------------------------------------------------------ 工具函数 */

  function setVar(el, name, value) {
    if (!el || !el.style) return;
    el.style.setProperty(name, value);
  }

  /* --wp-url 的计算值是 url("../assets/wallpaper.jpg") 这种**相对样式表**的地址。
     直接丢给 img.src 会按「文档地址」解析（index.html 在 styles/ 的上一层），
     指到不存在的文件 —— 而且 onerror 一吞，表面上什么都正常，只是永远没有主色。
     所以先找出声明这条变量的样式表，用它的 href 当基准。 */
  var cssBaseCache = null;

  function findCssBase() {
    if (cssBaseCache !== null) return cssBaseCache;
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (!sheet.href) continue;           /* 内联 <style> 没有 href，跳过 */
      var rules;
      try { rules = sheet.cssRules; } catch (_) { continue; } /* 跨源读取会抛 */
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var st = rules[j] && rules[j].style;
        if (st && st.getPropertyValue && st.getPropertyValue('--wp-url')) {
          cssBaseCache = sheet.href;
          return cssBaseCache;
        }
      }
    }
    cssBaseCache = '';
    return cssBaseCache;
  }

  /* 相对地址的候选解析顺序。
     http 下 cssRules 可读 → 能精确拿到「声明它的那张样式表」；
     file:// 下读 cssRules 会抛 SecurityError（实测），退化成「把所有样式表的
     目录都试一遍，第一个能解码的就是它」。这只在原型预览里发生，
     Electron 里 --wp-url 是 data: URI（preload 写入），不经过这条路径。 */
  function candidateUrls(raw) {
    var out = [];
    var push = function (u) { if (u && out.indexOf(u) < 0) out.push(u); };
    if (!raw) return out;
    if (/^(data:|blob:|file:|about:)/i.test(raw) ||
        raw.charAt(0) === '/' || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      push(raw);
      return out;
    }
    var base = findCssBase();
    /* ★ 顺序即代价（R81-R2 实测）：每个候选在 onerror 时都会在控制台留下一条
       「Failed to load resource: net::ERR_FILE_NOT_FOUND」。file:// 下 CSSOM 不可读，
       原来先试 document.baseURI —— 而 --wp-url 是相对**样式表**写的（../assets/…），
       按文档基准解析会往上多跳一层（design/assets/…），必然 404 一次才开始试对的。
       于是每启动一次就刷两条错误，F03「零 console error」直接判红。
       把样式表基准排到最前：第一个候选就是对的，探测在第一次加载就收手，
       0 条错误。若样式表也读不到（跨源 iframe 等），仍按原顺序兜底。 */
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      if (!sheets[i].href) continue;
      try { push(new URL(raw, sheets[i].href).href); } catch (_) {}
    }
    if (base) { try { push(new URL(raw, base).href); } catch (_) {} }
    try { push(new URL(raw, document.baseURI).href); } catch (_) {}
    return out;
  }

  /* --wp-url 的计算值是 url("...") / url(...) / none，取引号内的裸地址 */
  function readWpUrl() {
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue('--wp-url');
      if (!raw) return '';
      var v = raw.trim();
      if (!v || v === 'none') return '';
      var m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(v);
      if (m) v = m[2];
      v = v.trim();
      if (!v || v === 'none' || v === 'about:blank') return '';
      return v;
    } catch (_) {
      return '';
    }
  }

  /* -------------------------------------------------------- A1 指针追光 */

  /* 元素矩形 200ms 刷新一次。滚动和窗口变化会单独失效缓存，
     所以 200ms 只是「兜底上限」，不是「唯一刷新时机」。 */
  function refreshSurfaces(force) {
    if (!force && surfaces.length && (performance.now() - rectsAt) < RECT_TTL) return;
    rectsAt = performance.now();
    var list = (rootEl || document).querySelectorAll(SURFACE_SEL);
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      /* 不可见元素直接不进缓存：display:none 的矩形全 0，
         留着只是白算一次数学。 */
      if (!el.getClientRects().length) continue;
      next.push({ el: el, rect: el.getBoundingClientRect() });
    }
    surfaces = next;
  }

  function invalidateSurfaces() {
    rectsAt = 0;
  }

  /* 到最近边的距离：元素内为 0，出界后为到矩形的最短距离 */
  function edgeDistance(r, x, y) {
    var dx = 0, dy = 0;
    if (x < r.left) dx = r.left - x;
    else if (x > r.right) dx = x - r.right;
    if (y < r.top) dy = r.top - y;
    else if (y > r.bottom) dy = y - r.bottom;
    if (!dx && !dy) return 0;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function paint() {
    frameStart = performance.now();

    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var px = pointer.x;
    var py = pointer.y;

    /* 先把所有「读」做完，再开始「写」。
       顺序反过来会踩强制同步布局：刚写 :root 变量就把样式标脏，
       紧接着 getBoundingClientRect 会立刻触发一次全量 style recalc
       （实测每 200ms 一次的缓存重建帧因此多花 4ms）。 */
    refreshSurfaces(false);

    /* 统一处理磁吸高光（原 MagneticSheen），零额外监听开销（仅 ≥1024 桌面端） */
    var sheenHost = null;
    var sheenMx = '', sheenMy = '';
    if (vw >= 1024 && pointer.target && pointer.target.closest) {
      sheenHost = pointer.target.closest(SHEEN_SEL);
      if (sheenHost) {
        var sr = sheenHost.getBoundingClientRect();
        if (sr.width > 0 && sr.height > 0) {
          sheenMx = (((px - sr.left) / sr.width) * 100).toFixed(1) + '%';
          sheenMy = (((py - sr.top) / sr.height) * 100).toFixed(1) + '%';
        } else {
          sheenHost = null;
        }
      }
    }

    /* 视口百分比：给 .atmosphere 的径向遮罩用 */
    var rootStyle = document.documentElement.style;
    rootStyle.setProperty('--cursor-x', (px / vw * 100).toFixed(2) + '%');
    rootStyle.setProperty('--cursor-y', (py / vh * 100).toFixed(2) + '%');

    if (lastSheenHost && lastSheenHost !== sheenHost) {
      lastSheenHost.style.removeProperty('--mx');
      lastSheenHost.style.removeProperty('--my');
    }
    if (sheenHost) {
      setVar(sheenHost, '--mx', sheenMx);
      setVar(sheenHost, '--my', sheenMy);
    }
    lastSheenHost = sheenHost;

    for (var i = 0; i < surfaces.length; i++) {
      var item = surfaces[i];
      var r = item.rect;
      var el = item.el;

      /* 视口外一屏以外的元素不写变量：写了也看不见，只是白耗 */
      if (r.bottom < -FADE_PX || r.top > vh + FADE_PX ||
          r.right < -FADE_PX || r.left > vw + FADE_PX) continue;

      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;

      var d = edgeDistance(r, px, py);
      var prox = d <= 0 ? 1 : (1 - d / FADE_PX);
      if (prox < 0) prox = 0;
      if (prox > 1) prox = 1;

      /* base.css 的 ::after 约定：**没有 --local-x 就是没有光斑**
         （fallback 落点是 -200px -200px，元素外）。
         所以指针一离开元素就必须把这两个属性移除，而不是让它停在最后位置——
         停在最后位置在视觉上就是「玻璃上粘了一块不动的白斑」。
         用 inline style 自身的值判断是否已清除，避免额外维护状态位
         （元素缓存重建后状态位会失真）。 */
      if (d <= 0) {
        setVar(el, '--local-x', (px - r.left).toFixed(1) + 'px');
        setVar(el, '--local-y', (py - r.top).toFixed(1) + 'px');
      } else if (el.style.getPropertyValue('--local-x')) {
        el.style.removeProperty('--local-x');
        el.style.removeProperty('--local-y');
      }

      var ang = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
      setVar(el, '--light-angle', ang.toFixed(1) + 'deg');
      setVar(el, '--proximity', prox.toFixed(3));
    }

    /* 滚动速度衰减：scroll 事件只在滚动时来，松手后 --scroll-v 必须自己回 0，
       否则气泡会永久停在剪切位置。每帧衰减 0.82，约 12 帧（200ms）归零。 */
    if (scrollDecay > 0) {
      scrollDecay -= 1;
      var decayed = scrollDecay === 0;
      for (var s = 0; s < scrollRoots.length; s++) {
        var se = scrollRoots[s];
        if (decayed) {
          setVar(se, '--scroll-v', '0');
          setVar(se, '--scroll-abs', '0');
        } else {
          var prev = parseFloat(se.style.getPropertyValue('--scroll-v')) || 0;
          var nv = prev * 0.82;
          setVar(se, '--scroll-v', nv.toFixed(2));
          setVar(se, '--scroll-abs', Math.abs(nv).toFixed(2));
        }
      }
    }

    stats.frames += 1;
    stats.lastMs = performance.now() - frameStart;
  }

  function loop() {
    rafId = 0;
    if (!enabled || prefersReduced()) return;
    dirty = false;
    paint();
    /* 只有「还有新指针位置」或「速度还在衰减」才继续排帧。
       指针停住就不再排帧——停在原地的画面不需要再算一遍。 */
    if (dirty || scrollDecay > 0) schedule();
  }

  function schedule() {
    if (rafId || !enabled || prefersReduced()) return;
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  /* --------------------------------------------------------- A4 空闲停摆 */

  function bump() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      idleTimer = 0;
      pointer.has = false;   /* 标记空闲：下一帧画完就自己停 */
      stop();
    }, IDLE_MS);
  }

  /* -------------------------------------------------------- A3 滚动速度 */

  var scrollRoots = [];

  function collectScrollRoots() {
    scrollRoots = [];
    var list = (rootEl || document).querySelectorAll('[data-scroll-root]');
    for (var i = 0; i < list.length; i++) scrollRoots.push(list[i]);
  }

  function onScroll(ev) {
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    /* scroll 不冒泡，但用捕获阶段接的话 target 就是真正滚动的元素；
       嵌套滚动容器里可能不是 [data-scroll-root] 本身，往上找一层。 */
    if (!el.hasAttribute || !el.hasAttribute('data-scroll-root')) {
      el = el.closest ? el.closest('[data-scroll-root]') : null;
      if (!el) return;
    }

    var now = performance.now();
    var top = el.scrollTop;
    var prev = lastScroll.get(el);
    lastScroll.set(el, { t: now, top: top });

    if (!prev) return;
    var dt = now - prev.t;
    if (dt <= 0) return;

    var v = (top - prev.top) / dt;          /* px/ms，带符号 */
    if (!isFinite(v)) return;
    /* 单帧速度封顶 ±8px/ms：惯性滚动时浏览器会一次性甩出很大的 delta，
       不封顶会让气泡瞬间错位成两截。 */
    if (v > 8) v = 8;
    if (v < -8) v = -8;

    setVar(el, '--scroll-v', v.toFixed(2));
    setVar(el, '--scroll-abs', Math.abs(v).toFixed(2));
    scrollDecay = 24;                        /* 撑住衰减循环 */
    bump();
    schedule();
  }

  /* ------------------------------------------------ A3 窗口移动速度（Electron） */

  function hookWallpaper() {
    if (wpHooked || !window.HARBOR_WP || typeof window.HARBOR_WP.onUpdate !== 'function') return;
    wpHooked = true;
    var t0 = 0, x0 = 0, y0 = 0;
    window.HARBOR_WP.onUpdate(function (p) {
      if (!p) return;
      /* 增量包 partial:true 只有 x/y/visible，没有 url。
         判断就绪用 visible，绝不用 p.url 是否为空（增量包里它恒为 undefined）。 */
      if (typeof p.x !== 'number' || typeof p.y !== 'number') return;
      var t = performance.now();
      if (t0) {
        var dt = t - t0;
        if (dt > 0) {
          var vx = (p.x - x0) / dt;
          var vy = (p.y - y0) / dt;
          if (vx > 6) vx = 6; if (vx < -6) vx = -6;
          if (vy > 6) vy = 6; if (vy < -6) vy = -6;
          setVar(document.documentElement, '--wp-vx', vx.toFixed(3));
          setVar(document.documentElement, '--wp-vy', vy.toFixed(3));
        }
      }
      t0 = t; x0 = p.x; y0 = p.y;
      lastWp = p;
      /* 壁纸换图（整包包带 url 且 visible 翻转）时重算主色 */
      if (p.partial === false) queueDominant();
    });
  }

  /* ------------------------------------------------------ A2 壁纸主色提取 */

  var dominantBusy = false;

  function queueDominant() {
    if (refreshQueued) return;
    refreshQueued = true;
    /* 让出一帧再算：主色提取要 new Image + 解码，同步做会阻塞首屏 */
    setTimeout(function () {
      refreshQueued = false;
      extractDominant();
    }, 0);
  }

  function rgbToHsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
  }

  function extractDominant() {
    if (dominantBusy) return;
    var raw = readWpUrl();
    if (!raw) return;                 /* 无图：静默返回，让 tokens.css 的默认值生效 */
    var urls = candidateUrls(raw);
    if (!urls.length) return;
    dominantBusy = true;

    var done = function () { dominantBusy = false; };

    /* 逐个候选试：错误的相对基准只会 onerror，代价是一次本地文件探测。
       全部失败就静默收手——不写任何变量，tokens.css 的默认值继续生效。 */
    var attempt = function (idx) {
      if (idx >= urls.length) { done(); return; }

      var img = new Image();
      /* data: URI 同源，canvas 不污染；file:// 的图片会污染 canvas
         → getImageData 抛 SecurityError，此时换候选也没用，直接收手。
         不写 crossOrigin：data URI 加了反而多一次无谓的 CORS 检查。 */
      img.onerror = function () { attempt(idx + 1); };
      img.onload = function () {
        var px;
        try {
          var c = document.createElement('canvas');
          c.width = 16; c.height = 16;
          var ctx = c.getContext('2d', { willReadFrequently: true });
          if (!ctx) { done(); return; }
          ctx.drawImage(img, 0, 0, 16, 16);
          px = ctx.getImageData(0, 0, 16, 16).data;
        } catch (_) {
          done();
          return;                     /* CORS / 污染：静默，不写任何变量 */
        }

        var n = px.length / 4;
        if (!n) { done(); return; }

        var sumR = 0, sumG = 0, sumB = 0, kept = 0;
        var lumaSum = 0;
        var best = null;              /* 饱和度最高的像素 */
        var bestS = -1;

        for (var i = 0; i < n; i++) {
          var o = i * 4;
          var a = px[o + 3];
          if (a < 8) continue;        /* 全透明像素不参与 */
          var r = px[o], g = px[o + 1], b = px[o + 2];
          var hsv = rgbToHsv(r, g, b);
          lumaSum += hsv.v;

          /* 剔除近白 / 近黑 / 低饱和：剩下的是「真正有颜色的中间调」 */
          var keep = hsv.v <= 0.92 && hsv.v >= 0.08 && hsv.s >= 0.12;
          if (keep) {
            sumR += r; sumG += g; sumB += b; kept += 1;
            if (hsv.s > bestS) { bestS = hsv.s; best = { r: r, g: g, b: b, s: hsv.s }; }
          }
        }

        var root = document.documentElement.style;

        if (kept > 0) {
          root.setProperty('--wp-dominant-rgb',
            Math.round(sumR / kept) + ', ' + Math.round(sumG / kept) + ', ' + Math.round(sumB / kept));
        }
        /* accent 取「饱和度最高的一簇」：单像素会被噪点带偏，
           这里取与最饱和像素色相接近的那批再平均。 */
        if (best) {
          var ar = 0, ag = 0, ab = 0, an = 0;
          var bestH = rgbToHsv(best.r, best.g, best.b).h;
          for (var j = 0; j < n; j++) {
            var p2 = j * 4;
            if (px[p2 + 3] < 8) continue;
            var h2 = rgbToHsv(px[p2], px[p2 + 1], px[p2 + 2]);
            if (h2.s < 0.12) continue;
            var dh = Math.abs(h2.h - bestH);
            if (dh > 180) dh = 360 - dh;
            if (dh <= 24) { ar += px[p2]; ag += px[p2 + 1]; ab += px[p2 + 2]; an += 1; }
          }
          if (an > 0) {
            root.setProperty('--wp-accent-rgb',
              Math.round(ar / an) + ', ' + Math.round(ag / an) + ', ' + Math.round(ab / an));
          }
        }

        root.setProperty('--wp-luma', (lumaSum / n).toFixed(2));
        done();
      };

      img.src = urls[idx];
    };

    attempt(0);
  }

  /* --------------------------------------------------------------- attach */

  function onPointerMove(ev) {
    if (!enabled || prefersReduced()) return;
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
    pointer.target = ev.target;
    pointer.has = true;
    dirty = true;
    bump();
    schedule();
  }

  function onResize() {
    invalidateSurfaces();
    if (!enabled || prefersReduced()) return;
    dirty = true;
    bump();
    schedule();
  }

  function applyReduced() {
    if (prefersReduced()) {
      stop();
      if (lastSheenHost) {
        lastSheenHost.style.removeProperty('--mx');
        lastSheenHost.style.removeProperty('--my');
        lastSheenHost = null;
      }
      /* 降级时把已经写过的追光变量归零：不留半截状态给 CSS 的 ::after 用 */
      for (var i = 0; i < surfaces.length; i++) {
        var el = surfaces[i].el;
        el.style.removeProperty('--proximity');
        el.style.removeProperty('--light-angle');
      }
      surfaces = [];
    } else if (enabled) {
      invalidateSurfaces();
      bump();
    }
  }

  function attach(root) {
    var host = root && root.addEventListener ? root : document;
    if (bound.has(host)) return window.LiquidOptics;
    bound.add(host);
    rootEl = host === document ? null : host;

    host.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    /* scroll 不冒泡，必须捕获阶段；挂在 document 上就能覆盖所有滚动容器 */
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize, { passive: true });

    if (motionQuery) {
      var onMotionChange = function () { syncMotionFlag(); applyReduced(); };
      if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', onMotionChange);
      else if (typeof motionQuery.addListener === 'function') motionQuery.addListener(onMotionChange);
    }
    syncMotionFlag();

    collectScrollRoots();
    hookWallpaper();
    queueDominant();
    invalidateSurfaces();
    bump();
    schedule();
    return window.LiquidOptics;
  }

  function syncMotionFlag() {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(
      'data-liquid-optics', prefersReduced() ? 'reduce' : 'full'
    );
  }

  /* ---------------------------------------------------------------- 导出 */

  window.LiquidOptics = {
    attach: attach,
    refresh: function () { queueDominant(); invalidateSurfaces(); collectScrollRoots(); },
    setEnabled: function (on) {
      enabled = !!on;
      if (!enabled) { stop(); if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; } }
      else if (!prefersReduced()) { bump(); schedule(); }
      return enabled;
    },
    stats: stats
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { attach(document); }, { once: true });
  } else {
    attach(document);
  }
})();
