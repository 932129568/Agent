/* ============================================================================
   R81 · 液态玻璃交互动效层 2.0（W4 独占文件，纯原生，无依赖）
   ----------------------------------------------------------------------------
   契约：r81/CONTRACT-R81.md §3.5（B 侧公开 API）+ 任务 B
   前身：R80 的 1.0（六个方法的行为契约原样保留，签名一个字没改）

   公开 API（八个，前六个是 R80 的，签名不许变）：
     attach / copy / retract / regenerate / pastePulse / sweep
     sendLaunch（新）/ switchPanel（新）

   R81 的两条新纪律，写在最前面：
   1. 动画一律「先留引用、重开前先 cancel」。R80 踩过：fill:'forwards' 的动画
      会一直挂在元素上，同一元素连点两次会互相劫持。
   2. reduced-motion 下 **transform 类动画数量必须为 0**（判据 G6 会数
      document.getAnimations()）。所有新增动效都有独立的降级分支，
      不是「把时长调短」，是真的不产生 transform 关键帧。
   ============================================================================ */
(function () {
  'use strict';

  if (window.LiquidFX) return; /* 重复 <script> 不重复定义 */

  /* ---------------------------------------------------------------- 常量 */

  var REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

  var DUR = {
    sweep: 380,      /* 棱镜浪：R80 是 380，保持不变（R80 自测第 4 项按 400ms 取残留，见报告） */
    bulge: 420,      /* 复制时宿主微鼓，比浪慢一拍收束 */
    charge: 60,      /* 撤回前的蓄力（反向预压） */
    collapse: 280,   /* 撤回塌陷 */
    droplet: 520,    /* 撤回激起的水滴 */
    rebound: 460,    /* 回退回弹（R81 从 420 提到 460） */
    wash: 460,       /* 回退的流光幕 */
    ring: 260,       /* 粘贴边框脉冲（保留，与折射波叠加） */
    wave: 440,       /* 粘贴的两道折射波 */
    press: 90,       /* 按压到最低点的时长 */
    release: 380,    /* 松手回弹 */
    ripple: 460,     /* 水波纹扩散 */
    launch: 360,     /* 发送液滴飞行 */
    panelOut: 180,   /* 旧板块退焦 */
    panelIn: 380,    /* 新板块对焦 */
    stagger: 55,     /* 子构件错峰间隔 */
    fade: 120        /* reduced-motion 下的唯一时长 */
  };

  /* 设计系统把「弹簧 / 粘稠」两条曲线收进了 tokens.css（--ease-liquid-spring
     `cubic-bezier(.34,1.56,.64,1)`、--ease-liquid-viscous `.22,1.28,.36,1`）。
     这里读令牌而不是硬编码，避免同一条曲线在两处各自漂移。
     读不到（令牌未定义 / 计算样式异常）时退回本地同形状的值。 */
  var easeCache = {};

  function cssEase(name, fallback) {
    if (easeCache[name]) return easeCache[name];
    var v = '';
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (_) { /* 计算样式不可用时直接走 fallback */ }
    if (!/^(cubic-bezier|linear)/.test(v)) v = fallback;
    easeCache[name] = v;
    return v;
  }

  var EASE = {
    sweep: 'cubic-bezier(.22,.61,.36,1)',
    collapse: 'cubic-bezier(.4,0,1,1)',     /* ease-in：要「缩走」不是「飘走」 */
    rebound: 'cubic-bezier(.34,1.4,.64,1)', /* 过冲，液态回弹（R81 规格写死的值） */
    settle: 'cubic-bezier(.2,.9,.3,1)',
    get spring() { return cssEase('--ease-liquid-spring', 'cubic-bezier(.34,1.28,.52,1)'); },
    get viscous() { return cssEase('--ease-liquid-viscous', 'cubic-bezier(.22,1.28,.36,1)'); }
  };

  var TEMP_ATTR = 'data-liquid-temp';

  /* ------------------------------------------------------ reduced-motion */

  var motionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCE_QUERY)
    : null;

  function prefersReduced() {
    return !!(motionQuery && motionQuery.matches);
  }

  function syncMotionFlag() {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(
      'data-liquid-motion', prefersReduced() ? 'reduce' : 'full'
    );
  }

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', syncMotionFlag);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(syncMotionFlag);
    }
  }
  syncMotionFlag();

  /* ------------------------------------------------------------ 工具函数 */

  function temp(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    node.setAttribute(TEMP_ATTR, '1');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function emit(el, name, detail) {
    var host = el && el.dispatchEvent ? el : document;
    try {
      host.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || null }));
    } catch (_) { /* 事件派发失败不应打断动画链 */ }
  }

  /* 动画注册表：元素 → { 通道: Animation }。
     同一元素上可能同时跑两条互不相干的动画（比如 composer 既有 box-shadow
     脉冲又有 translateY 下沉），所以按「通道」记账：
     同通道重开前先 cancel（R80 踩过 fill:forwards 互相劫持的坑），
     跨通道互不干扰。 */
  var running = new WeakMap();

  function channelOf(el) {
    var map = running.get(el);
    if (!map) { map = {}; running.set(el, map); }
    return map;
  }

  function hasAnim(el, key) {
    var map = running.get(el);
    return !!(map && map[key || 'transform']);
  }

  function play(el, frames, options, key) {
    if (!el || typeof el.animate !== 'function') return Promise.resolve();
    var k = key || 'transform';
    var map = channelOf(el);
    if (map[k]) { try { map[k].cancel(); } catch (_) {} }

    var anim;
    try {
      anim = el.animate(frames, options);
    } catch (_) {
      return Promise.resolve();
    }
    map[k] = anim;

    var settle = function () {
      try { anim.cancel(); } catch (_) {}
      if (map[k] === anim) delete map[k];
    };
    return anim.finished.then(settle, settle);
  }

  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, ms); })
    ]);
  }

  function rectOf(el) {
    return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  }

  /* --------------------------------------------------------------- 扫光 */

  /**
   * 棱镜浪（R81）：宽 64px、倾斜 115°（相对水平）的亮带，前锋青 → 核心白 → 尾迹琥珀。
   * R80 的 2px 细线只读作「一条光」，64px 的宽带才读作「一层液体流过去」。
   * @param {Element} el
   * @param {Object} [opts] { peak, width, duration, dispersion }
   */
  function sweep(el, opts) {
    if (!el || typeof el.animate !== 'function') return Promise.resolve();
    var o = opts || {};
    var peak = typeof o.peak === 'number' ? o.peak : 0.75;
    var width = typeof o.width === 'number' ? o.width : 64;
    var dur = typeof o.duration === 'number' ? o.duration : DUR.sweep;

    var rect = rectOf(el);
    if (!rect) return Promise.resolve();
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (!w || !h) return Promise.resolve(); /* 隐藏元素不浪费时间 */

    /* --- reduced-motion：整块叠一层高光，只淡入淡出，无位移 --- */
    if (prefersReduced()) {
      var veil = temp('span', 'liquid-veil');
      veil.style.cssText =
        'position:absolute;inset:0;pointer-events:none;border-radius:inherit;' +
        'background:rgba(255,255,255,' + (peak * 0.6).toFixed(2) + ');opacity:0;';
      el.appendChild(veil);
      return play(veil, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }],
        { duration: DUR.fade, easing: 'ease-out' }
      ).then(function () { veil.remove(); });
    }

    var clip = temp('span', 'liquid-sweep-clip');
    clip.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;' +
      'border-radius:inherit;z-index:2;';

    /* 115°：亮带自身是竖直的（90°），再绕 Z 轴斜 25°，合起来是相对水平 115°。
       高度给到 220% 并上移 60%，斜过来之后上下两端才能盖满整块气泡。 */
    var band = temp('span', 'liquid-sweep-band');
    band.style.cssText =
      'position:absolute;left:0;top:-60%;width:' + width + 'px;height:220%;' +
      'background:linear-gradient(90deg,' +
        'rgba(88,196,255,0) 0%,' +
        'rgba(88,196,255,.48) 18%,' +
        'rgba(255,255,255,.85) 50%,' +
        'rgba(255,158,74,.42) 82%,' +
        'rgba(255,158,74,0) 100%);' +
      /* 色散：两侧各 1px 单边色 —— 短波先偏（青蓝），长波后偏（琥珀） */
      'box-shadow:-1px 0 0 rgba(88,146,255,.35),1px 0 0 rgba(255,158,74,.30);' +
      'will-change:transform;';

    /* 顶部高光短暂提亮：单独一层，不动 .msg 自身的 box-shadow，
       否则会整段覆盖 W1 那套菲涅尔，动画结束还原就是一次闪跳。 */
    var lip = temp('span', 'liquid-lip');
    lip.style.cssText =
      'position:absolute;inset:0;pointer-events:none;border-radius:inherit;' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,' + peak + ');opacity:0;';

    clip.appendChild(band);
    el.appendChild(clip);
    el.appendChild(lip);

    var from = -1.2 * w;
    var to = 1.2 * w;
    var tilt = ' rotate(25deg)';

    var bandsweep = play(band, [
      { transform: 'translateX(' + from + 'px)' + tilt, opacity: 0, offset: 0 },
      { transform: 'translateX(' + (from + 0.27 * w) + 'px)' + tilt, opacity: peak, offset: 0.15 },
      { transform: 'translateX(' + to + 'px)' + tilt, opacity: 0, offset: 1 }
    ], { duration: dur, easing: EASE.sweep });

    var lipPulse = play(lip, [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.21 },
      { opacity: 0, offset: 1 }
    ], { duration: dur, easing: 'ease-out' });

    return Promise.all([bandsweep, lipPulse]).then(function () {
      clip.remove();
      lip.remove();
    });
  }

  /* --------------------------------------------------------------- 剪贴板 */

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    try {
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-2000px;left:-2000px;opacity:0;';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      return !!ok;
    } catch (_) {
      return false;
    } finally {
      area.remove();
    }
  }

  function writeClipboard(text) {
    if (!text) return Promise.resolve(false);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(
          function () { return true; },
          function () { return legacyCopy(text); }
        );
      }
    } catch (_) { /* 非安全上下文直接抛，落到兜底 */ }
    return Promise.resolve(legacyCopy(text));
  }

  /* --------------------------------------------------------------- 复制 */

  function copy(msgEl) {
    if (!msgEl) return Promise.resolve(false);
    var body = msgEl.querySelector ? msgEl.querySelector('.msg-body') : null;
    var text = ((body ? body.textContent : msgEl.textContent) || '').trim();

    sweep(msgEl, { peak: 0.75 });

    /* 宿主微鼓：浪过去的时候气泡自己「被推了一下」。
       只鼓 1.2%，再多就读作缩放动画而不是材质反应。 */
    if (!prefersReduced()) {
      play(msgEl, [
        { transform: 'scale(1)', offset: 0 },
        { transform: 'scale(1.012)', offset: 0.55 },
        { transform: 'scale(1)', offset: 1 }
      ], { duration: DUR.bulge, easing: EASE.sweep });
    }

    return withTimeout(writeClipboard(text), 400, false).then(function (ok) {
      emit(msgEl, 'harbor:copied', { ok: ok, length: text.length });
      return ok;
    });
  }

  /* --------------------------------------------------------------- 撤回 */

  var busy = new WeakSet(); /* 防止同一条消息被连点两次导致 remove 两次 */

  /* 水滴粒子：从原位置向上飘散。用 position:fixed 拿视图坐标，
     这样宿主元素移除后粒子还在（它们本来就是「离开气泡的液体」）。 */
  function sprayDroplets(rect, count) {
    if (!rect || !document.body) return Promise.resolve();
    var n = count || 4;
    var jobs = [];
    for (var i = 0; i < n; i++) {
      var size = 5 + Math.round(Math.random() * 5);
      var x = rect.left + rect.width * (0.18 + 0.64 * (i / Math.max(n - 1, 1)));
      var y = rect.top + rect.height * 0.55 + (Math.random() * 8 - 4);
      var drop = temp('span', 'liquid-droplet');
      drop.style.cssText =
        'position:fixed;left:' + (x - size / 2) + 'px;top:' + (y - size / 2) + 'px;' +
        'width:' + size + 'px;height:' + size + 'px;border-radius:50%;pointer-events:none;' +
        'z-index:9998;' +
        'background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.95),' +
        'rgba(214,236,255,.55) 58%,rgba(255,214,180,.30) 100%);' +
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.8),0 2px 6px rgba(0,0,0,.14);' +
        'will-change:transform,opacity;';
      document.body.appendChild(drop);
      var dx = (Math.random() * 26 - 13).toFixed(1);
      var dy = (-26 - Math.random() * 24).toFixed(1);
      jobs.push(play(drop, [
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 0.95, offset: 0 },
        { transform: 'translate3d(' + (dx / 2) + 'px,' + (dy / 2) + 'px,0) scale(.8)', opacity: 0.7, offset: 0.45 },
        { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(.25)', opacity: 0, offset: 1 }
      ], {
        duration: DUR.droplet,
        delay: i * 28,
        easing: 'cubic-bezier(.22,.61,.36,1)'
      }).then(function () { drop.remove(); }));
    }
    return Promise.all(jobs);
  }

  function retract(msgEl) {
    if (!msgEl || busy.has(msgEl)) return Promise.resolve();
    busy.add(msgEl);

    /* --- reduced：纯 opacity --- */
    if (prefersReduced()) {
      return play(msgEl, [{ opacity: 1 }, { opacity: 0 }],
        { duration: DUR.fade, easing: 'linear', fill: 'forwards' }
      ).then(function () {
        emit(msgEl, 'harbor:retracted');
        msgEl.remove();
      });
    }

    var rect = rectOf(msgEl);

    /* 1) 蓄力：反向预压 1.02，告诉眼睛「要往回抽了」 */
    return play(msgEl, [
      { transform: 'scale(1)' },
      { transform: 'scale(1.02)' }
    ], { duration: DUR.charge, easing: 'ease-out' }).then(function () {
      /* 2) 塌陷：横向收窄、纵向压扁、上浮、虚化。
         play() 结算时已经 cancel 掉蓄力那条，fill 不会压着 transform。 */
      sprayDroplets(rect, 4);

      return play(msgEl, [
        { transform: 'scale(1.02) translateY(0)', opacity: 1, filter: 'blur(0px)', offset: 0 },
        { transform: 'scaleX(.92) scaleY(.75) translateY(-12px)', opacity: 0, filter: 'blur(8px)', offset: 1 }
      ], { duration: DUR.collapse, easing: EASE.collapse });
    }).then(function () {
      emit(msgEl, 'harbor:retracted');
      msgEl.remove();
    });
  }

  /* --------------------------------------------------------------- 回退 */

  function regenerate(msgEl) {
    if (!msgEl) return Promise.resolve();

    sweep(msgEl, { peak: 0.45 }); /* 扫光比复制更淡 */

    if (prefersReduced()) {
      return play(msgEl, [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }],
        { duration: DUR.fade, easing: 'ease-out' }
      ).then(function () { emit(msgEl, 'harbor:regenerated'); });
    }

    /* 流光幕：从底向上涌的乳白 + 琥珀。做成独立一层而不是改背景，
       因为改 background 会影响 .msg 的材质令牌，恢复时又是一次闪跳。 */
    var wash = temp('span', 'liquid-wash');
    wash.style.cssText =
      'position:absolute;inset:0;pointer-events:none;border-radius:inherit;overflow:hidden;';
    var flow = temp('span', 'liquid-wash-flow');
    flow.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;height:100%;' +
      'background:linear-gradient(0deg,' +
        'rgba(255,252,246,.62) 0%,' +
        'rgba(255,206,160,.34) 42%,' +
        'rgba(255,255,255,0) 100%);' +
      'will-change:transform,opacity;';
    wash.appendChild(flow);
    msgEl.appendChild(wash);

    var washAnim = play(flow, [
      { transform: 'translateY(100%)', opacity: 0, offset: 0 },
      { transform: 'translateY(28%)', opacity: 0.9, offset: 0.45 },
      { transform: 'translateY(0)', opacity: 0, offset: 1 }
    ], { duration: DUR.wash, easing: EASE.viscous });

    /* 压扁 → 过冲 → 复位。460ms 是 R81 规格值（R80 是 420）。 */
    var hostAnim = play(msgEl, [
      { transform: 'scaleY(1) scaleX(1)', offset: 0 },
      { transform: 'scaleY(.86) scaleX(1.03)', offset: 0.3 },
      { transform: 'scaleY(1.04) scaleX(.98)', offset: 0.66 },
      { transform: 'scaleY(1) scaleX(1)', offset: 1 }
    ], { duration: DUR.rebound, easing: EASE.rebound });

    return Promise.all([hostAnim, washAnim]).then(function () {
      wash.remove();
      emit(msgEl, 'harbor:regenerated');
    });
  }

  /* --------------------------------------------------------------- 粘贴 */

  /* 光标位置：粘贴可能是右键菜单（pointerdown 已被记录）、也可能是 Ctrl+V。 */
  var lastPointer = null;

  function trackPointer(ev) {
    if (typeof ev.clientX === 'number') lastPointer = { x: ev.clientX, y: ev.clientY };
  }

  function dropPoint(composer, ev) {
    if (ev && typeof ev.clientX === 'number' && (ev.clientX || ev.clientY)) {
      return { x: ev.clientX, y: ev.clientY };
    }
    if (lastPointer) return lastPointer;
    var input = composer.querySelector('textarea, input');
    var r = rectOf(input || composer);
    return { x: r.left + 24, y: r.top + r.height / 2 };
  }

  function pastePulse(composerEl, ev) {
    var composer = composerEl || document.querySelector('.composer');
    if (!composer) return Promise.resolve();

    /* --- reduced：只做 opacity，无位移无波形 --- */
    if (prefersReduced()) {
      var ring0 = temp('span', 'liquid-paste-ring');
      ring0.style.cssText =
        'position:absolute;inset:0;pointer-events:none;border-radius:inherit;' +
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.40);opacity:.40;';
      composer.appendChild(ring0);
      return play(ring0, [{ opacity: 0.4 }, { opacity: 0 }],
        { duration: DUR.fade, easing: 'linear' }
      ).then(function () {
        ring0.remove();
        emit(composer, 'harbor:pasted');
      });
    }

    var jobs = [];

    /* 1) 边框高光：在计算样式上追加一圈 inset，不吞掉既有阴影 */
    var base = getComputedStyle(composer).boxShadow;
    var basePart = (base && base !== 'none') ? base + ', ' : '';
    var ringAt = function (a) { return basePart + 'inset 0 0 0 1px rgba(255,255,255,' + a + ')'; };
    jobs.push(play(composer, [
      { boxShadow: ringAt(0.12), offset: 0 },
      { boxShadow: ringAt(0.40), offset: 0.5 },
      { boxShadow: ringAt(0.12), offset: 1 }
    ], { duration: DUR.ring, easing: 'ease-out' }, 'shadow'));

    /* 2) 两道折射波：从输入舱顶部中心向左右扩散。
       宽度各 50%，scaleX 0→1；scaleX 是 transform，所以只在非降级分支里建。 */
    var waveHost = temp('span', 'liquid-wave-host');
    waveHost.style.cssText =
      'position:absolute;inset:0;pointer-events:none;border-radius:inherit;overflow:hidden;';
    composer.appendChild(waveHost);

    var mk = function (leftSide) {
      var wv = temp('span', 'liquid-wave');
      wv.style.cssText =
        'position:absolute;top:0;height:3px;width:50%;' +
        (leftSide ? 'left:0;transform-origin:right center;' : 'left:50%;transform-origin:left center;') +
        'background:linear-gradient(' + (leftSide ? '270deg' : '90deg') + ',' +
          'rgba(255,255,255,.92) 0%,' +
          'rgba(88,196,255,.45) 35%,' +
          'rgba(255,158,74,.30) 70%,' +
          'rgba(255,255,255,0) 100%);' +
        'will-change:transform,opacity;';
      waveHost.appendChild(wv);
      return play(wv, [
        { transform: 'scaleX(0)', opacity: 0.95, offset: 0 },
        { transform: 'scaleX(.55)', opacity: 0.75, offset: 0.5 },
        { transform: 'scaleX(1)', opacity: 0, offset: 1 }
      ], { duration: DUR.wave, easing: EASE.viscous }).then(function () { wv.remove(); });
    };
    jobs.push(mk(true), mk(false));

    /* 3) 舱体下沉回弹：内容「沉了一下」 */
    jobs.push(play(composer, [
      { transform: 'translateY(0) scaleY(1)', offset: 0 },
      { transform: 'translateY(2px) scaleY(.985)', offset: 0.42 },
      { transform: 'translateY(0) scaleY(1)', offset: 1 }
    ], { duration: DUR.release, easing: EASE.spring }, 'transform'));

    return Promise.all(jobs).then(function () {
      waveHost.remove();
      emit(composer, 'harbor:pasted');
    });
  }

  /* --------------------------------------------------------------- 发送 */

  /* 文本化作亮色液滴，从输入区弹射到 #chatTrack 底部，落地后长成用户气泡。 */
  function sendLaunch(composerEl) {
    var composer = composerEl || document.querySelector('.composer');
    if (!composer) return Promise.resolve();

    var track = document.getElementById('chatTrack');
    var input = composer.querySelector('textarea, input');
    var from = rectOf(input || composer);
    var to = rectOf(track);
    /* 起飞前先数一遍消息数：落地时只有「多出来的那一条」才配做生长动画。
       对已有的旧气泡做 scale，等于把历史消息也抖一下——那不是发送反馈。 */
    var beforeCount = track ? track.querySelectorAll('.msg').length : 0;

    if (prefersReduced()) {
      /* 降级：只在输入区做一次淡出，无飞行、无缩放 */
      var ghost = temp('span', 'liquid-launch-ghost');
      ghost.style.cssText =
        'position:fixed;left:' + from.left + 'px;top:' + from.top + 'px;' +
        'width:' + from.width + 'px;height:' + from.height + 'px;' +
        'border-radius:12px;pointer-events:none;z-index:9999;' +
        'background:rgba(255,255,255,.35);opacity:.5;';
      document.body.appendChild(ghost);
      return play(ghost, [{ opacity: 0.5 }, { opacity: 0 }],
        { duration: DUR.fade, easing: 'linear' }
      ).then(function () {
        ghost.remove();
        emit(composer, 'harbor:sent');
      });
    }

    var size = 20;
    /* 起点：文本区右下（文字长出来的位置），终点：消息流底部中心 */
    var sx = from.left + Math.min(from.width - size, from.width * 0.62);
    var sy = from.top + from.height * 0.42;
    var tx = to ? to.left + to.width / 2 : sx;
    var ty = to ? to.bottom - 24 : from.top - 80;

    var drop = temp('span', 'liquid-launch');
    drop.style.cssText =
      'position:fixed;left:' + (sx - size / 2) + 'px;top:' + (sy - size / 2) + 'px;' +
      'width:' + size + 'px;height:' + size + 'px;border-radius:50%;pointer-events:none;' +
      'z-index:9999;' +
      'background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.98),' +
      'rgba(198,232,255,.72) 48%,rgba(255,206,160,.42) 100%);' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.9),0 6px 18px rgba(90,140,200,.28);' +
      'will-change:transform,opacity;';
    document.body.appendChild(drop);

    var dx = (tx - sx).toFixed(1);
    var dy = (ty - sy).toFixed(1);

    return play(drop, [
      { transform: 'translate3d(0,0,0) scale(.55)', opacity: 0, offset: 0 },
      { transform: 'translate3d(' + (dx * 0.12) + 'px,' + (dy * 0.12) + 'px,0) scale(1.15)', opacity: 1, offset: 0.18 },
      /* 中段：拉成水滴（纵向拉长 + 横向收窄），这是「液体在飞」的关键帧 */
      { transform: 'translate3d(' + (dx * 0.55) + 'px,' + (dy * 0.58) + 'px,0) scaleY(1.35) scaleX(.78)', opacity: 1, offset: 0.56 },
      { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(.42) scaleY(.7)', opacity: 0, offset: 1 }
    ], { duration: DUR.launch, easing: EASE.spring }).then(function () {
      drop.remove();
      /* 落地生长：只有「这次发送真的新增了一条气泡」才做。
         没新增就跳过——液滴飞过去这件事本身已经完成了反馈。 */
      var msgs = track ? track.querySelectorAll('.msg') : [];
      var last = msgs.length && msgs.length > beforeCount ? msgs[msgs.length - 1] : null;
      if (last) {
        play(last, [
          { transform: 'scale(.94)', opacity: 0.4, offset: 0 },
          { transform: 'scale(1)', opacity: 1, offset: 1 }
        ], { duration: 300, easing: EASE.spring });
      }
      emit(composer, 'harbor:sent');
    });
  }

  /* --------------------------------------------------------------- 板块切换 */

  function switchPanel(nextPanel) {
    var next = nextPanel;
    if (!next || next.nodeType !== 1) return Promise.resolve();

    var current = document.querySelector('.view-panel:not([hidden])');
    var steps = [];

    /* --- 旧板块退焦 --- */
    if (current && current !== next) {
      if (prefersReduced()) {
        steps.push(play(current, [{ opacity: 1 }, { opacity: 0 }],
          { duration: DUR.fade, easing: 'linear', fill: 'forwards' }).then(function () {
            current.hidden = true;
          }));
      } else {
        steps.push(play(current, [
          { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)', offset: 0 },
          { opacity: 0, filter: 'blur(10px)', transform: 'scale(.975)', offset: 1 }
        ], { duration: DUR.panelOut, easing: 'ease-in', fill: 'forwards' }).then(function () {
          current.hidden = true;
        }));
      }
    }

    /* --- 新板块对焦 --- */
    next.hidden = false;

    if (prefersReduced()) {
      steps.push(play(next, [{ opacity: 0 }, { opacity: 1 }],
        { duration: DUR.fade, easing: 'linear' }));
    } else {
      steps.push(play(next, [
        { opacity: 0, filter: 'blur(12px)', transform: 'translateY(14px) scale(1.015)', offset: 0 },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0) scale(1)', offset: 1 }
      ], { duration: DUR.panelIn, easing: EASE.spring }));

      /* 子构件错峰：--s1..--s5 的错峰语义在这里落成 delay，最多 5 个，
         再多就不是「浮现」而是「排队」了。 */
      var kids = next.children;
      var max = Math.min(kids.length, 5);
      for (var i = 0; i < max; i++) {
        (function (kid, idx) {
          var varName = '--s' + (idx + 1);
          kid.style.setProperty(varName, (idx * DUR.stagger) + 'ms');
          steps.push(play(kid, [
            { opacity: 0, transform: 'translateY(10px)', offset: 0 },
            { opacity: 1, transform: 'translateY(0)', offset: 1 }
          ], {
            duration: 260,
            delay: idx * DUR.stagger,
            easing: EASE.settle
          }).then(function () { kid.style.removeProperty(varName); }));
        })(kids[i], i);
      }
    }

    return Promise.all(steps).then(function () {
      emit(next, 'harbor:panel', { id: next.id || '' });
    });
  }

  /* ------------------------------------------------------ 按压形变与波纹 */

  var PRESS_SEL = '.btn, .nav-seg, .msg-act, .chip';
  var pressed = new WeakMap();
  var pressedEl = null; /* 记住按下的是谁：松手可能发生在别的元素上 */

  function ripple(host, x, y) {
    var r = rectOf(host);
    if (!r) return;
    var size = Math.max(r.width, r.height) * 0.9;
    var ring = temp('span', 'liquid-ripple');
    /* 起点用宿主坐标：纯键盘触发时 clientX 为 0，落在左上角会很怪 */
    var cx = typeof x === 'number' && x ? x : r.left + r.width / 2;
    var cy = typeof y === 'number' && y ? y : r.top + r.height / 2;
    ring.style.cssText =
      'position:fixed;left:' + (cx - size / 2) + 'px;top:' + (cy - size / 2) + 'px;' +
      'width:' + size + 'px;height:' + size + 'px;border-radius:50%;pointer-events:none;' +
      'z-index:9997;' +
      'border:1px solid rgba(255,255,255,.55);' +
      /* 1px 色散边：内外两圈各偏一个色相，读作「光在水面上散开」 */
      'box-shadow:0 0 0 1px rgba(88,196,255,.28),inset 0 0 0 1px rgba(255,158,74,.22);' +
      'will-change:transform,opacity;';
    document.body.appendChild(ring);
    play(ring, [
      { transform: 'scale(.35)', opacity: .75, offset: 0 },
      { transform: 'scale(1.25)', opacity: .28, offset: 0.6 },
      { transform: 'scale(1.9)', opacity: 0, offset: 1 }
    ], { duration: DUR.ripple, easing: EASE.sweep }).then(function () { ring.remove(); });
  }

  function pressTarget(ev) {
    var t = ev.target;
    if (!t || !t.closest) return null;
    return t.closest(PRESS_SEL);
  }

  function onPressDown(ev) {
    trackPointer(ev);
    if (prefersReduced()) return;      /* 降级：不做形变、不做波纹（两者都是 transform） */
    var host = pressTarget(ev);
    if (!host) return;
    var prev = pressed.get(host);
    if (prev) { try { prev.cancel(); } catch (_) {} }
    var anim = host.animate([
      { transform: 'scale(1)' },
      { transform: 'scaleX(1.04) scaleY(.94)' }
    ], { duration: DUR.press, easing: 'ease-out', fill: 'forwards' });
    pressed.set(host, anim);
    pressedEl = host;
    ripple(host, ev.clientX, ev.clientY);
  }

  function onPressUp(ev) {
    if (prefersReduced()) return;
    /* 松手的目标可能已经换成别的元素（按下后拖动到按钮外再松开），
       所以优先释放「记录下来的那个」，否则它会永久停在 scaleX(1.04) 的按下态。 */
    var host = pressedEl && document.contains(pressedEl) ? pressedEl : pressTarget(ev);
    pressedEl = null;
    if (!host) return;
    var prev = pressed.get(host);
    /* 没有按下记录就不放释放动画：否则任何在按钮上的 pointerup（包括拖动经过）
       都会平白无故多一条 380ms 的 transform 动画。 */
    if (!prev) return;
    var from = prev ? 'scaleX(1.04) scaleY(.94)' : 'scale(1)';
    if (prev) { try { prev.cancel(); } catch (_) {} pressed.delete(host); }
    play(host, [
      { transform: from, offset: 0 },
      { transform: 'scaleX(.98) scaleY(1.02)', offset: 0.34 },
      { transform: 'scale(1,1)', offset: 1 }
    ], { duration: DUR.release, easing: EASE.spring });
  }

  /* --------------------------------------------------------------- 滚动剪切 */

  /* --scroll-v 由 optics.js 写（px/ms，带符号）；--scroll-abs 是它的绝对值，
     因为 CSS 的 calc() 不能对 var 取绝对值。这里在 JS 侧读同一个值，
     直接算出 translateY / scaleY，避免在 CSS 里做不可能做的运算。

     R86 · 可视区裁剪：长对话（40+ 气泡）时原来对 #chatTrack .msg 全量写
     transform，离屏节点也要算 getBoundingClientRect + 写内联样式，滚动掉帧。
     现在只处理「距视口 ±48px 内」的气泡，离屏节点不读不写。 */
  var shearRaf = 0;
  var cachedScrollRoot = null;

  function scrollRoot() {
    if (cachedScrollRoot && document.contains(cachedScrollRoot)) return cachedScrollRoot;
    cachedScrollRoot = document.querySelector('[data-scroll-root]');
    return cachedScrollRoot;
  }

  function isNearViewport(el, vh) {
    var r = el.getBoundingClientRect();
    return r.bottom >= -48 && r.top <= vh + 48;
  }

  function shearApply() {
    shearRaf = 0;
    var root = scrollRoot();
    var v = 0;
    if (root && root.style) v = parseFloat(root.style.getPropertyValue('--scroll-v')) || 0;
    var abs = Math.abs(v);
    var vh = window.innerHeight || 900;

    var live = !prefersReduced() && abs > 0.05;
    var msgs = document.querySelectorAll('#chatTrack .msg');

    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var wasSheared = m.getAttribute('data-liquid-shear') === '1';

      if (live && isNearViewport(m, vh)) {
        /* 正在跑自己的动画（复制/回退）就别插手，交给动画 */
        if (hasAnim(m, 'transform')) continue;
        var ty = (-v * 0.15).toFixed(2);
        var sy = (1 + abs * 0.0008).toFixed(4);
        m.style.transform = 'translate3d(0,' + ty + 'px,0) scaleY(' + sy + ')';
        m.setAttribute('data-liquid-shear', '1');
      } else if (wasSheared) {
        m.removeAttribute('data-liquid-shear');
        /* 停下就弹性归位：用过渡而不是瞬间删除，否则是一次硬跳。
           离屏节点不做归位动画（看不见，只浪费一帧）。 */
        if (!prefersReduced() && isNearViewport(m, vh)) {
          play(m, [
            { transform: m.style.transform || 'translate3d(0,0,0) scaleY(1)' },
            { transform: 'translate3d(0,0,0) scaleY(1)' }
          ], { duration: 260, easing: EASE.spring }).then(function () {});
        }
        m.style.removeProperty('transform');
      }
    }

    if (live && !shearRaf) shearRaf = requestAnimationFrame(shearApply);
  }

  function onScrollShear() {
    if (prefersReduced()) return;
    if (!shearRaf) shearRaf = requestAnimationFrame(shearApply);
  }

  /* ------------------------------------------------------------- 操作条补全 */

  var ACTS_HTML =
    '<div class="msg-acts" role="group" aria-label="消息操作">' +
    '<button type="button" class="msg-act" data-act="copy" aria-label="复制这条回复">复制</button>' +
    '<button type="button" class="msg-act" data-act="retract" aria-label="撤回这条回复">撤回</button>' +
    '<button type="button" class="msg-act" data-act="regenerate" aria-label="回到这条重新生成">回退</button>' +
    '</div>';

  function ensureActs(msgEl) {
    if (!msgEl || msgEl.nodeType !== 1 || !msgEl.classList.contains('msg')) return;
    if (msgEl.querySelector(':scope > .msg-acts')) return;
    var holder = document.createElement('div');
    holder.innerHTML = ACTS_HTML;
    msgEl.insertBefore(holder.firstChild, msgEl.firstChild);
  }

  function scanActs(scope) {
    var root = scope || document;
    if (!root.querySelectorAll) return;
    var list = root.querySelectorAll('.msg');
    for (var i = 0; i < list.length; i++) ensureActs(list[i]);
  }

  var observer = null;

  function observe() {
    if (observer || typeof MutationObserver !== 'function' || !document.body) return;
    var track = document.getElementById('chatTrack') || document.body;
    var queued = false;
    var flush = function () {
      queued = false;
      scanActs(track);
    };
    observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      if (typeof queueMicrotask === 'function') queueMicrotask(flush);
      else Promise.resolve().then(flush);
    });
    observer.observe(track, { childList: true, subtree: true });
  }

  /* --------------------------------------------------------------- 事件委托 */

  function onClick(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.msg-act') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var msg = btn.closest('.msg');
    if (!msg || !act) return;
    ev.preventDefault();
    if (act === 'copy') copy(msg);
    else if (act === 'retract') retract(msg);
    else if (act === 'regenerate') regenerate(msg);
  }

  function onPaste(ev) {
    var t = ev.target;
    var composer = t && t.closest ? t.closest('.composer') : null;
    if (!composer) return;
    pastePulse(composer, ev);
  }

  var bound = new WeakSet();

  function attach(root) {
    var host = root && root.addEventListener ? root : document;
    if (bound.has(host)) return window.LiquidFX;
    bound.add(host);

    host.addEventListener('click', onClick, true);
    host.addEventListener('paste', onPaste, true);
    if (host === document) {
      document.addEventListener('pointerdown', onPressDown, { capture: true, passive: true });
      document.addEventListener('pointerup', onPressUp, { capture: true, passive: true });
      document.addEventListener('pointercancel', onPressUp, { capture: true, passive: true });
      document.addEventListener('scroll', onScrollShear, { capture: true, passive: true });
      scanActs(document);
      observe();
    }
    return window.LiquidFX;
  }

  /* --------------------------------------------------------------- 导出 */

  window.LiquidFX = {
    attach: attach,
    retract: retract,
    regenerate: regenerate,
    copy: copy,
    pastePulse: pastePulse,
    sweep: sweep,
    /* R81 新增 */
    sendLaunch: sendLaunch,
    switchPanel: switchPanel
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { attach(document); }, { once: true });
  } else {
    attach(document);
  }
})();
