/* ============================================================================
   SunClock · 设备真实时间驱动的连续光照系统
   ----------------------------------------------------------------------------
   R76 建立了"日/夜/晨昏/晨"四个权重的连续曲线；
   R79（Daylight Instrument）把它扩成**24 小时双光源 + 折射光学**模型：

     ① 太阳：e = sin((h−6)/12·π)，6:00 地平线、12:00 天顶、18:00 落下。
     ② 月亮：e_m = sin((h−19)/12·π)，19:00 升起、01:00 中天、07:00 落下。
        **月亮是第二个光源，不是"把太阳调暗"** —— 它的方位、色温、亮度都是另一条
        余弦（H3 用"22:00 与太阳位的差 ≥12%"来验这件事）。
     ③ 光源交接：--light-x/y = 太阳位与月亮位按 w 混合，w 在傍晚 17.0→21.6、
        拂晓 3.4→7.6 两个**长窗口**里过渡。
        ★ 为什么窗口必须长：黎明时太阳在东（58%）而月亮在西（26%），真实世界里
          这是"两个方向都有光"，而 --light-x 只能是一个数。窗口短（≤2h）就意味着
          半小时里光位横甩 30%，上一版正是死在"日落后 20 分钟把光位拽到月光位"
          产生的尖峰上。4~4.6h 的窗口把 30% 摊到 250 分钟，每分钟 0.12%，
          与白天太阳自身的漂移（0.05~0.07%/min）同量级 ⇒ 量不出尖峰（H1 守）。
        ★ w 在 h=0 与 h=24 都等于 1（wDn(0)=1 + wUp(0)=0，wUp(24)=1 + wDn(24)=0）
          ⇒ 循环天然缝合（H2 守）。
     ④ 光色：太阳色相 46°（正午白金）→ 暖端（黄昏琥珀 31° / 黎明玫瑰金 25°），
        落到地平线以下后继续压暗成深金（不可见，只为了让曲线连续）；
        月亮色相 215°（冷银蓝），越接近中天越亮。
     ⑤ 色散双色：暖侧 48°→38°（金→琥珀），冷侧 206°→220°（青→靛）；
        入夜后两侧都转冷（银青 198° / 靛蓝 232°）。
        ★ 刻意避开 60°–190°：那一段是绿，H5 明文禁止（"零绿相"）。
     ⑥ 折射光斑（caustic）：玻璃把入射光折到**入射方向的反侧**，所以
        caustic-x = 100 − light-x；长短轴随太阳高度变化（低角度拉长、正午收成点）。
     ⑦ 光晕（halo）：环形半径低角度大、正午小，强度在晨昏达峰（dusk 钟形）。

   仍然成立的旧约束：
     · 所有输出都是 h 的 C¹ 函数，没有 if/else 换值（smoothstep + 三角 + 线性混合）；
     · --light-x/--light-y 与 --sun-x/--sun-y 同源（OPT-01 守这件事）；
     · ?hour=18.5 强制时刻（预览台/判据用），运行时用 __SunClock.setHour()；
     · __SunClock.compute(h) 是**纯函数**（不写 DOM、不归一化 h）：
       H1/H2/H4 用它扫 1441 个点验连续性与循环缝合，避免"读到 CSS 过渡中间态"。
     · 无 JS 时 CSS 侧全部有 var(--*, 默认) 兜底。
   ============================================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  /* 预览台可强制时刻：null = 跟随设备真实时间 */
  var forced = null;

  /* 毫秒精度：h 里带小数秒，这样两次采样之间的差值本身就是连续的，
     不会因为"整分钟才变"而产生 60s 一个台阶。 */
  function realHour() {
    var d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
      + d.getMilliseconds() / 3600000;
  }

  function queryHour() {
    try {
      var q = new URLSearchParams(location.search).get('hour');
      if (q === null) return null;
      var v = parseFloat(q);
      return isFinite(v) ? ((v % 24) + 24) % 24 : null;
    } catch (e) { return null; }
  }

  function smoothstep(edge0, edge1, x) {
    var t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mixRGB(a, b, t) {
    return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
  }
  /* HSL(色相 0..360 / 饱和 0..1 / 亮度 0..1) → [r, g, b] 0..255 */
  function hsl2rgb(hDeg, s, l) {
    var hh = ((hDeg % 360) + 360) % 360 / 60;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((hh % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (hh < 1) { r = c; g = x; }
    else if (hh < 2) { r = x; g = c; }
    else if (hh < 3) { g = c; b = x; }
    else if (hh < 4) { g = x; b = c; }
    else if (hh < 5) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbStr(c) { return c[0] + ', ' + c[1] + ', ' + c[2]; }

  /* --------------------------------------------------------------------------
     compute(h) —— 纯函数：时刻 → 全部光通道。**不归一化 h**（H2 要 h=24 与 h=0
     同值，归一化会把这条验收变成恒真）。任何 DOM 写入都在 apply() 里。
     -------------------------------------------------------------------------- */
  function compute(h) {
    /* ── 太阳 ─────────────────────────────────────────────────────────── */
    var e = Math.sin((h - 6) / 12 * Math.PI);
    var day = smoothstep(-0.06, 0.26, e);
    var night = smoothstep(0.04, -0.30, e);
    var tDusk = smoothstep(-0.52, 0.52, e);
    var dusk = 4 * tDusk * (1 - tDusk);            /* 钟形，峰值恰在地平线 */
    var warm = smoothstep(0.15, 0.95, dusk);
    var rising = Math.cos((h - 6) / 12 * Math.PI);
    var dawn = smoothstep(-0.20, 0.40, rising);
    var exposure = 0.54 + smoothstep(-0.10, 0.55, e) * 0.46;

    /* ── 月亮（第二个光源） ───────────────────────────────────────────── */
    var eM = Math.sin((h - 19) / 12 * Math.PI);
    /* 上升沿给到 0.75 的幅宽（≈3h）：H4 要求"相邻分钟跳变 ≤0.02"，
       若用窄窗口（-0.08..0.22 ≈ 51min），smoothstep 峰值斜率 1.5/51 = 0.029/min
       会直接越界。宽窗口峰值斜率 0.0083/min，仍有 2.4× 余量。 */
    var moonW = smoothstep(-0.30, 0.45, eM) * (1 - day);

    /* ── 光位：两条余弦，长窗口混合 ───────────────────────────────────── */
    var sunX = 42 + Math.cos((h - 6) / 12 * Math.PI) * 16;    /* 6:00 58 / 12:00 42 / 18:00 26 */
    var sunY = -10 - Math.sin((h - 6) / 12 * Math.PI) * 14;   /* −10 地平线 / −24 天顶 */
    var moonX = 42 + Math.cos((h - 19) / 12 * Math.PI) * 16;  /* 19:00 58 / 01:00 42 / 07:00 26 */
    var moonY = -10 - Math.sin((h - 19) / 12 * Math.PI) * 14;
    var wUp = smoothstep(17.0, 21.6, h);      /* 傍晚升（4.6h） */
    var wDn = smoothstep(7.6, 3.4, h);        /* 拂晓降（4.2h） */
    var w = wUp + wDn;                        /* 两窗口不重叠 ⇒ 和即"或" */
    var lightX = sunX * (1 - w) + moonX * w;
    var lightY = sunY * (1 - w) + moonY * w;

    /* ── 太阳色 / 月亮色 ──────────────────────────────────────────────── */
    var sunH = 46 - 15 * warm - 6 * warm * dawn;   /* 46 白金 / 31 琥珀 / 25 玫瑰金 */
    var sunS = 0.14 + 0.46 * warm;
    var sunL = 0.92 - 0.30 * warm;
    /* 太阳落到地平线以下：继续压暗加深。sunDown 是 e 的平滑函数 ⇒ 整条曲线 C¹。
       （夜间这段颜色不会被看见：w=1，有效光色已经是月亮色。） */
    var sunDown = smoothstep(0.0, -0.55, e);
    sunH = lerp(sunH, 20, sunDown);
    sunS = lerp(sunS, 0.62, sunDown);
    sunL = lerp(sunL, 0.30, sunDown);

    var moonHi = smoothstep(-0.20, 0.90, eM);      /* 越接近中天越亮 */
    var moonH = 215 - 6 * moonHi;
    var moonS = 0.16 - 0.04 * moonHi;
    var moonL = 0.80 + 0.10 * moonHi;

    var sunRGB = hsl2rgb(sunH, clamp01(sunS), clamp01(sunL));
    var moonRGB = hsl2rgb(moonH, clamp01(moonS), clamp01(moonL));

    /* ── 色散双色（避开 60–190° 的绿段，见文件头 ⑤） ─────────────────── */
    var dispAH = lerp(48 - 10 * warm, 198, w);
    var dispAS = lerp(0.62 - 0.10 * warm, 0.24, w);
    var dispAL = lerp(0.66 - 0.06 * warm, 0.74, w);
    var dispBH = lerp(206 + 14 * warm, 232, w);
    var dispBS = lerp(0.58 - 0.06 * warm, 0.42, w);
    var dispBL = lerp(0.70 + 0.04 * warm, 0.66, w);
    var dispARGb = hsl2rgb(dispAH, clamp01(dispAS), clamp01(dispAL));
    var dispBRGb = hsl2rgb(dispBH, clamp01(dispBS), clamp01(dispBL));

    /* ── 折射光斑（caustic） ──────────────────────────────────────────── */
    var lowT = smoothstep(0.90, 0.10, Math.abs(e));   /* 1 = 贴近地平线 */
    var srcW = day + moonW * (1 - day);                /* 有效光源强度 0..1 */
    var causticW = 24 + lowT * 38;                     /* %：低角度拉长 */
    var causticH = 20 - lowT * 8;                      /* %：低角度变扁 */
    var causticX = 100 - lightX;                       /* 折到入射的反侧 */
    var causticY = 46 + (lightY + 24) * 0.9;           /* 打进台面上段 */
    var causticA = (0.09 + 0.24 * lowT) * (0.35 + 0.65 * srcW);

    /* ── 光晕（halo） ─────────────────────────────────────────────────── */
    var haloR = 420 + lowT * 320;                      /* px：低角度大 */
    var haloA = 0.06 + 0.20 * dusk + 0.10 * moonW * (1 - day);

    /* ── 光色合成 ─────────────────────────────────────────────────────── */
    var haloRGB = mixRGB(sunRGB, moonRGB, w);
    var atmo1 = haloRGB;                                        /* 主光色 */
    var atmo2 = mixRGB(dispARGb, sunRGB, 0.45);                 /* 暖侧 */
    var atmo3 = mixRGB([216, 218, 220], moonRGB, 0.5 * w);      /* 中性底雾，夜里微冷 */
    var causticRGB = mixRGB(mixRGB(sunRGB, moonRGB, w), [255, 255, 255], 0.42);

    return {
      h: h, e: e, eM: eM, day: day, night: night, dusk: dusk, warm: warm, dawn: dawn,
      exposure: exposure, moonW: moonW, w: w,
      sunH: sunH, sunS: sunS, sunL: sunL,
      moonH: moonH, moonS: moonS, moonL: moonL,
      dispAH: dispAH, dispAS: dispAS, dispAL: dispAL,
      dispBH: dispBH, dispBS: dispBS, dispBL: dispBL,
      haloH: lerp(sunH, moonH, w), haloS: lerp(sunS, moonS, w), haloL: lerp(sunL, moonL, w),
      lightX: lightX, lightY: lightY, sunX: sunX, sunY: sunY, moonX: moonX, moonY: moonY,
      causticX: causticX, causticY: causticY, causticW: causticW, causticH: causticH, causticA: causticA,
      haloR: haloR, haloA: haloA,
      sunRGB: sunRGB, moonRGB: moonRGB, haloRGB: haloRGB,
      atmo1: atmo1, atmo2: atmo2, atmo3: atmo3,
      dispA: dispARGb, dispB: dispBRGb, causticRGB: causticRGB
    };
  }

  function currentHour() {
    if (forced !== null) return forced;
    var q = queryHour();
    if (q !== null) return q;
    return realHour();
  }

  function apply() {
    var c = compute(currentHour());
    var st = root.style;

    st.setProperty('--sun-day', c.day.toFixed(5));
    st.setProperty('--sun-night', c.night.toFixed(5));
    st.setProperty('--sun-dusk', c.dusk.toFixed(5));
    st.setProperty('--sun-warm', c.warm.toFixed(5));
    st.setProperty('--sun-dawn', c.dawn.toFixed(5));
    st.setProperty('--sun-x', c.lightX.toFixed(3) + '%');
    st.setProperty('--sun-y', c.lightY.toFixed(3) + '%');
    /* 同一坐标同时喂给 R73 既有的单一光源 —— 氛围层与台面光锥必须取同一个值，
       否则「光从哪来」会出现两个答案（OPT-01 守的就是这件事）。 */
    st.setProperty('--light-x', c.lightX.toFixed(3) + '%');
    st.setProperty('--light-y', c.lightY.toFixed(3) + '%');
    st.setProperty('--sun-angle', (-c.e * 58).toFixed(2) + 'deg');
    st.setProperty('--sun-exposure', c.exposure.toFixed(5));

    /* ── R79 新增通道 ─────────────────────────────────────────────────── */
    st.setProperty('--moon-w', c.moonW.toFixed(5));
    st.setProperty('--sun-h', c.sunH.toFixed(3));
    st.setProperty('--sun-s', (c.sunS * 100).toFixed(3));
    st.setProperty('--sun-l', (c.sunL * 100).toFixed(3));
    st.setProperty('--moon-h', c.moonH.toFixed(3));
    st.setProperty('--moon-s', (c.moonS * 100).toFixed(3));
    st.setProperty('--moon-l', (c.moonL * 100).toFixed(3));
    st.setProperty('--disp-a-h', c.dispAH.toFixed(3));
    st.setProperty('--disp-a-s', (c.dispAS * 100).toFixed(3));
    st.setProperty('--disp-a-l', (c.dispAL * 100).toFixed(3));
    st.setProperty('--disp-b-h', c.dispBH.toFixed(3));
    st.setProperty('--disp-b-s', (c.dispBS * 100).toFixed(3));
    st.setProperty('--disp-b-l', (c.dispBL * 100).toFixed(3));
    st.setProperty('--halo-tone-h', c.haloH.toFixed(3));
    st.setProperty('--halo-tone-s', (c.haloS * 100).toFixed(3));
    st.setProperty('--halo-tone-l', (c.haloL * 100).toFixed(3));

    st.setProperty('--caustic-x', c.causticX.toFixed(3) + '%');
    st.setProperty('--caustic-y', c.causticY.toFixed(3) + '%');
    st.setProperty('--caustic-w', c.causticW.toFixed(3) + '%');
    st.setProperty('--caustic-h', c.causticH.toFixed(3) + '%');
    st.setProperty('--caustic-a', c.causticA.toFixed(5));
    st.setProperty('--halo-r', Math.round(c.haloR) + 'px');
    st.setProperty('--halo-a', c.haloA.toFixed(5));

    /* RGB 三元组：CSS 侧用 rgba(var(--x-rgb), alpha) 组装，
       RGB 由光决定、alpha 由主题决定（明暗两档的夜间衰减不同）。 */
    st.setProperty('--sun-rgb', rgbStr(c.sunRGB));
    st.setProperty('--moon-rgb', rgbStr(c.moonRGB));
    st.setProperty('--halo-rgb', rgbStr(c.haloRGB));
    st.setProperty('--atmo-1-rgb', rgbStr(c.atmo1));
    st.setProperty('--atmo-2-rgb', rgbStr(c.atmo2));
    st.setProperty('--atmo-3-rgb', rgbStr(c.atmo3));
    st.setProperty('--disp-a-rgb', rgbStr(c.dispA));
    st.setProperty('--disp-b-rgb', rgbStr(c.dispB));
    st.setProperty('--caustic-rgb', rgbStr(c.causticRGB));
  }

  /* 首次写入必须是瞬时的：否则页面从 tokens.css 的静态默认值
     "慢慢过渡"到当前时刻，前 6 秒会看到一段假的日落。
     用 --sun-ease 统一控制（CSS 侧所有光照过渡都引用它）。 */
  root.style.setProperty('--sun-ease', '0s');
  apply();
  var booted = false;
  function unboot() {
    if (booted) return;
    booted = true;
    root.style.setProperty('--sun-ease', '6s');
  }
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(function () { window.requestAnimationFrame(unboot); });
  } else {
    window.setTimeout(unboot, 32);
  }

  /* 500ms 一次。单次变化量：h 变 1/7200 小时 ⇒ elevation 变 ~4e-4，
     叠到 alpha 上不足 1/255，8bit 量化后多数步长为 0 —— 也就是"看不出来在动，
     但一直在动"。CSS 侧 6s linear 把这 20+ 个进行中的过渡叠成一条连续斜坡。 */
  var STEP = 500;
  function tick() {
    apply();
    window.setTimeout(tick, STEP - (Date.now() % STEP) + 4);
  }
  window.setTimeout(tick, STEP - (Date.now() % STEP) + 4);

  /* 扫光时钟：32s 一轮（R75 是 18s —— 偏快，读作"扫描线"而不是"光在走"）。
     初相位按当天已过秒数取模 ⇒ 每次打开页面光都在不同位置，像真实的光在移动。
     为什么放在 JS 而不是 CSS @keyframes：OPT-02 的结构性决策是"零 CSS 无限动画"，
     所有常驻动效必须由同一套时钟持有，才能被 reduce / fx-off / 后台节流一致地停表。 */
  var SWEEP_MS = 32000;
  var sweepT0 = Date.now() - (Date.now() % SWEEP_MS);
  function easeInOut(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function sweep() {
    if (document.hidden) { sweepT0 = Date.now() - (Date.now() - sweepT0) % SWEEP_MS; return; }
    var p = ((Date.now() - sweepT0) % SWEEP_MS) / SWEEP_MS;
    var s = p < .62 ? 0 : easeInOut(Math.min(1, (p - .62) / .38));
    root.style.setProperty('--lg-sweep', s.toFixed(4));
  }
  if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sweep();
    window.setInterval(sweep, 80);
  } else {
    root.style.setProperty('--lg-sweep', '0');
  }

  /* 预览台切时段用：不 reload 页面，直接改写生效时刻并重算 */
  window.__SunClock = {
    hour: currentHour,
    /* 纯函数出口：H1（24h 连续性）/ H2（循环缝合）/ H4（月光单调）都吃它。
       不归一化 h ⇒ compute(24) 与 compute(0) 的比对不是恒真。 */
    compute: compute,
    isForced: function () { return forced !== null || queryHour() !== null; },
    setHour: function (h) {
      if (h === null || h === undefined) {
        forced = null;
      } else {
        var v = parseFloat(h);
        forced = isFinite(v) ? ((v % 24) + 24) % 24 : null;
      }
      /* 手动切时段要立刻到位，不能等 6s 斜坡 */
      root.style.setProperty('--sun-ease', '0s');
      apply();
      window.setTimeout(function () { root.style.setProperty('--sun-ease', '6s'); }, 30);
      return currentHour();
    },
    refresh: apply
  };
})();
