/**
 * LIGHTWELL R90 · 渐进增强工作台壳层（classic script，必须 IIFE + 无模块语法）
 *
 * 三条死约束：① 经 manifest.prebuilt 内联进主 <script> 并被 new Function() 语法校验
 * （frontend/build.js:306-316），出现模块语法即构建失败；② 节点全部运行时创建 ——
 * contract_diff.py 从 harbor.html 文本提取 dom_ids 精确集合，静态写进模板会多出 id；
 * ③ 经典态零介入（无 data-skin 立即 return，不碰 DOM）。
 * 职责：检查器 + 9 原型视图 / 光学壁纸与时钟（随 body.fx-off 停帧）/ callApi 遥测光带。
 * 时机：prebuilt 段早于 scripts ⇒ 挂 DOMContentLoaded + 对 callApi 有限重试。
 * 设计依据：deliverables/design/R90-全面替换落地记录.md
 */
(function lightwellShell() {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var HTML = document.documentElement;
  if (HTML.getAttribute('data-skin') !== 'lightwell') return; // 经典态零介入

  /** 九大原型视图；id 与设计稿 data-view-panel 口径对齐，供 ?prototype= 深链；group 仅作 title 提示。 */
  var PROTOTYPE_VIEWS = [
    { id: 'plinth-chart', label: '展台图表', group: '结构与拓扑' },
    { id: 'stair-gate', label: '阶梯闸门', group: '门控与表单' },
    { id: 'rack-tabs', label: '机架页签', group: '检索与时序' },
    { id: 'retrieval-well', label: '检索井', group: '检索与时序' },
    { id: 'lane-timeline', label: '泳道时线', group: '检索与时序' },
    { id: 'topology-ring', label: '拓扑环', group: '结构与拓扑' },
    { id: 'drawer-cabinet', label: '抽屉柜', group: '门控与表单' },
    { id: 'form-stack', label: '表单栈', group: '门控与表单' },
    { id: 'flow-track', label: '流程轨', group: '结构与拓扑' }
  ];

  var state = {
    activePrototype: 'flow-track',
    observerOpen: true,
    callCount: 0,
    estTokens: 0,
    lastMethod: 'idle',
    lastStatus: 'READY',
    recentCalls: [],
    clockTimer: null,
    hooked: false,
    /* 只有「自动收起」的那次才在回宽时自动展开；用户手动开合不被 resize 覆盖。 */
    narrowAuto: false
  };

  /* 必须与 responsive.css 第 10 段 @media (max-width:1080px) 同值：CSS 撤 360px 占位，脚本收浮层。 */
  var NARROW_MAX_WIDTH = 1080;

  function escapeHtml(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ───── 光学基底 ───── */

  /** 壁纸层：给 4 个玻璃宿主提供"可被模糊"的真实内容。纯 CSS 渐变，零位图、零请求。 */
  function mountWallpaper() {
    if (document.getElementById('lw-ambient-wallpaper')) return;
    var w = document.createElement('div');
    w.id = 'lw-ambient-wallpaper';
    w.setAttribute('aria-hidden', 'true');
    document.body.appendChild(w);
  }

  /** SVG 折射滤镜容器。**R92-3 实测达标 ⇒ 默认挂载**（只增不删，定义永远留着）。
   *  判据先写死再测（写在 qa/r92/optics-probe.mjs 文件头，测完一个数都没改）：
   *    avg ≥ 50fps 且 p95 帧时长 ≤ 25ms 且 长帧(>50ms)=0，三选全中才开。
   *  最终产物 headful 主测（msedge 165Hz；headless 合成路径与 Electron 不同，只作参考）：
   *    1440×900  基线 165fps / p95 6.2ms / 长帧 0    折射 165 / 6.2 / 0   ← 三选全中
   *    800×900   基线 164.6  / p95 6.2ms / 长帧 0    折射 165 / 6.2 / 0   ← 三选全中
   *  空对照（qa/r92/optics-null-control.mjs，A 与 A' 同一个态、三轮交错、两视口共 18 格）：
   *    A=[165,164.4,165] A'=[165,165,165] B=[165,165,165]（1440）｜A=[165,165,165]
   *    A'=[165,165,164.2] B=[165,165,165]（800）⇒ 静态页上折射与基线落在同一噪声带里。
   *  **800 视口的代价机器相关、且随条件变**：静态页我 0.8fps（165→164.2）、QA 另一台机 5.6fps
   *  （165→159.45）；动态底噪（每帧重绘）本轮复跑 6.7fps（165→158.3）。三测都远优于阈值
   *  （avg≥50 / p95≤25 / 长帧 0），"开"的结论不受影响；但引用时必须写区间
   *  「0.8–6.7fps（机器与条件相关）」，不能只写一次的好看数字。
   *  仪器自检（blur 40px + 同滤镜）：掉到 157.2 / p95 9.2ms ⇒ 本仪器对 ~5% 的合成代价
   *    有分辨力，所以上面"没掉"是真的没掉，不是测不出。
   *  一次异常会话（未计入判定）：折射态 800×900 读到 143.9fps，但同一行的
   *    max=45.5ms 与"长帧 1（>50ms）"自相矛盾，采样本身不可信；同会话的仪器自检也失明。
   *  像素自证（qa/r92/optics-pixel-probe.mjs）：同态连拍 sha 相同、跨态 sha 不同
   *    ⇒ url(#lw-liquid-refract) 不是被忽略的死引用，视觉上真的生效。
   *  逃生门：?liquid=0 退回 R92-2 的四宿主纯 blur/saturate（不写 localStorage）。 */
  function mountSvgDefs() {
    if (document.getElementById('lw-svg-defs')) return;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('id', 'lw-svg-defs');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';

    var defs = document.createElementNS(NS, 'defs');
    var filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', 'lw-liquid-refract');
    filter.setAttribute('x', '-5%');
    filter.setAttribute('y', '-5%');
    filter.setAttribute('width', '110%');
    filter.setAttribute('height', '110%');

    var turb = document.createElementNS(NS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise');
    turb.setAttribute('baseFrequency', '0.012 0.018');
    turb.setAttribute('numOctaves', '2');
    turb.setAttribute('seed', '7');
    turb.setAttribute('result', 'noise');

    var disp = document.createElementNS(NS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic');
    disp.setAttribute('in2', 'noise');
    disp.setAttribute('scale', '3.5');
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');

    filter.appendChild(turb);
    filter.appendChild(disp);
    defs.appendChild(filter);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  /* ───── 主舞台与观察窗 ───── */

  /** .panels 即第 2 个玻璃宿主。不能取 .main：DOM 为 .main > header.header + div.panels，
   *  header 已是第 1 宿主，拿 .main 会把 header 套进 backdrop-filter ⇒ 违反四宿主不嵌套。 */
  function mountMainStage() {
    var panels = document.querySelector('.panels');
    if (panels && !panels.id) panels.id = 'mainStage';
    return panels;
  }

  function buildObserver() {
    var obs = document.createElement('aside');
    obs.id = 'observerWindow';
    obs.setAttribute('aria-label', 'Lightwell 结果与原型检查器');

    var head = document.createElement('div');
    head.className = 'lw-obs-head';
    var title = document.createElement('span');
    title.className = 'lw-obs-title';
    title.textContent = 'LIGHTWELL 观察窗';
    var clock = document.createElement('span');
    clock.id = 'lw-optics-clock';
    clock.className = 'lw-rib-pill';
    clock.textContent = 'OPTICS: --:--:--';
    head.appendChild(title);
    head.appendChild(clock);

    var bar = document.createElement('div');
    bar.className = 'lw-proto-bar';
    for (var i = 0; i < PROTOTYPE_VIEWS.length; i += 1) {
      var p = PROTOTYPE_VIEWS[i];
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lw-proto-chip';
      chip.setAttribute('data-proto-id', p.id);
      chip.setAttribute('title', p.group);
      chip.textContent = p.label;
      bar.appendChild(chip);
    }

    var body = document.createElement('div');
    body.className = 'lw-obs-body';

    obs.appendChild(head);
    obs.appendChild(bar);
    obs.appendChild(body);

    bar.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== bar && !(t.classList && t.classList.contains('lw-proto-chip'))) {
        t = t.parentNode;
      }
      if (!t || t === bar) return;
      var next = t.getAttribute('data-proto-id');
      if (!next) return;
      state.activePrototype = next;
      updateObserverAndRibbon();
    });

    document.body.appendChild(obs);
    return obs;
  }

  /* ───── 成本光带 ───── */

  function buildRibbon() {
    var rib = document.createElement('footer');
    rib.id = 'glass-ribbon';
    rib.setAttribute('aria-label', 'Lightwell 成本与状态光带');

    var g1 = document.createElement('div');
    g1.className = 'lw-rib-group';
    var skinPill = document.createElement('span');
    skinPill.className = 'lw-rib-pill';
    skinPill.textContent = 'SKIN: LIGHTWELL';
    var stats = document.createElement('span');
    stats.id = 'lw-rib-stats';
    stats.className = 'lw-rib-pill';
    stats.textContent = 'CALLS: 0 | EST_TOKENS: 0 | LAST: idle (READY)';
    g1.appendChild(skinPill);
    g1.appendChild(stats);

    var g2 = document.createElement('div');
    g2.className = 'lw-rib-group';

    var btnObs = document.createElement('button');
    btnObs.type = 'button';
    btnObs.className = 'lw-rib-btn';
    btnObs.textContent = '检查器';
    btnObs.addEventListener('click', function () {
      state.observerOpen = !state.observerOpen;
      // 手动开合即接管：此后回宽屏不再由脚本自动展开
      state.narrowAuto = false;
      updateObserverAndRibbon();
    });

    var btnDark = document.createElement('button');
    btnDark.type = 'button';
    btnDark.className = 'lw-rib-btn';
    btnDark.textContent = '明/暗切换';
    btnDark.addEventListener('click', function () {
      document.body.classList.toggle('dark');
      updateObserverAndRibbon();
    });

    var btnExit = document.createElement('button');
    btnExit.type = 'button';
    btnExit.className = 'lw-rib-btn';
    btnExit.textContent = '切到经典皮肤（本次会话）';
    btnExit.addEventListener('click', function () {
      // 只做会话内切换，绝不写 localStorage：Electron 里既无地址栏也无 devtools，
      // 一旦落盘用户就被永久锁在经典态且无法自行恢复；重启即回光井。
      HTML.removeAttribute('data-skin');
      // R95：折射开关一并清掉。否则经典态下 html 上仍留 data-lw-liquid="1"，
      // 与 ?skin=classic 启动（该属性为 null）不对称 —— 惰性无视觉影响，但会让
      // "退出皮肤"与"从未进过皮肤"两种状态在 DOM 上留下不同指纹，后续判据难写。
      HTML.removeAttribute('data-lw-liquid');
      document.body.classList.remove('lw-observer-open');
    });

    g2.appendChild(btnObs);
    g2.appendChild(btnDark);
    g2.appendChild(btnExit);

    rib.appendChild(g1);
    rib.appendChild(g2);
    document.body.appendChild(rib);
    return rib;
  }

  /* ───── 原型视图内容 ───── */

  /* ───── 事实三类（R92）：live 真读数 / const 契约常量 / empty 无数据源 ─────
   * 渲染路径不允许出现「没有来源标记的事实」：每个 .lw-proto-fact /
   * .lw-proto-empty 都带 data-fact-src，探针（qa/r92/views-probe.mjs）逐条校验。
   * 三类语义：
   *   live  —— 值来自运行时（遥测 / 真实聚合 / DOM 实测 / callApi 返回）；
   *   const —— 编译期契约常量，**必须**同时渲染「契约常量」标，不得伪装成实时读数；
   *   empty —— 拿不到数据源，显式空态并写明原因，禁止用写死值顶替。 */

  function factLive(key, label, valueHtml, hint) {
    return '<div class="lw-proto-fact" data-fact-src="live" data-fact-key="' + escapeHtml(key)
      + '"><span class="lw-fact-k">' + escapeHtml(label) + '</span>'
      + '<span class="lw-fact-v">' + valueHtml + '</span>'
      + (hint ? '<span class="lw-fact-hint">' + escapeHtml(hint) + '</span>' : '')
      + '</div>';
  }

  function factConst(key, label, valueHtml) {
    return '<div class="lw-proto-fact" data-fact-src="const" data-fact-key="' + escapeHtml(key)
      + '"><span class="lw-fact-k">' + escapeHtml(label) + '</span>'
      + '<span class="lw-fact-v">' + valueHtml + '</span>'
      + '<span class="lw-fact-tag">契约常量</span></div>';
  }

  function factEmpty(key, reason) {
    return '<div class="lw-proto-empty" data-fact-src="empty" data-fact-key="' + escapeHtml(key)
      + '">暂无数据源 · ' + escapeHtml(reason) + '</div>';
  }

  function traceRows() {
    if (!state.recentCalls.length) return factEmpty('trace', '本会话尚无 callApi 轨迹');
    var rows = '';
    var list = state.recentCalls.slice(-6).reverse();
    for (var i = 0; i < list.length; i += 1) {
      var it = list[i];
      rows += '<div class="lw-proto-row" data-fact-src="live">'
        + '<span class="lw-proto-method">' + escapeHtml(it.method) + '</span>'
        + '<span class="lw-proto-meta">' + escapeHtml(it.durationMs) + 'ms · ' + escapeHtml(it.status) + '</span>'
        + '</div>';
    }
    return rows;
  }

  function card(title, innerHtml) {
    return '<div class="lw-proto-card"><div class="lw-proto-card-title">' + escapeHtml(title)
      + '</div>' + innerHtml + '</div>';
  }

  /* ───── 只读取数：TTL + 防重入（禁止自激循环） ─────
   * 取数自身经 callApi → 被遥测代理计数 → updateObserverAndRibbon → 又渲染 →
   * 若渲染再取数即成环。三道闸门：
   *   ① 只在渲染「当前视图」时按需取，不在 mount 时预取九个视图；
   *   ② 同一方法 TTL 内不重发（失败也缓存，避免失败风暴）；
   *   ③ 进行中的方法复用同一 entry，不并发重发。 */
  var API_TTL_MS = 15000;
  var apiCache = {};

  function clockMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  /** 取一份只读 API 数据；返回缓存项（可能 pending / 失败），从不抛错。 */
  function requestApi(method, args) {
    var now = clockMs();
    var hit = apiCache[method];
    if (hit && (hit.pending || (now - hit.at) < API_TTL_MS)) return hit;

    var entry = { at: now, data: hit ? hit.data : null, error: null, pending: false };
    apiCache[method] = entry;
    // 惰性解析：每次调用时再取 window.callApi，不缓存函数引用（壳层可能早于 hook）。
    var bridge = (typeof window.callApi === 'function') ? window.callApi : null;
    if (!bridge) { entry.error = 'bridge-unavailable'; return entry; }

    entry.pending = true;
    try {
      Promise.resolve(bridge(method, args || [], 4000)).then(function (raw) {
        entry.pending = false;
        entry.at = clockMs();
        var parsed = null;
        try { parsed = JSON.parse(String(raw)); } catch (e) { entry.error = 'bad-json'; }
        if (parsed && typeof parsed === 'object' && parsed.error) {
          entry.error = String(parsed.error).slice(0, 90);
        } else if (parsed) {
          entry.data = parsed;
          entry.error = null;
        } else if (!entry.error) {
          entry.error = 'empty-response';
        }
        repaintActiveView();
      }, function (err) {
        entry.pending = false;
        entry.at = clockMs();
        entry.error = (err && err.message ? String(err.message) : 'unavailable').slice(0, 90);
        repaintActiveView();
      });
    } catch (e) {
      entry.pending = false;
      entry.error = 'unavailable';
    }
    return entry;
  }

  /** 把一份取数结果渲染成事实行；不可用/结构不符 → 空态（附真实失败原因）。 */
  function apiFacts(entry, keyPrefix, subject, build) {
    if (!entry) return factEmpty(keyPrefix + '.none', subject + '：尚未发起读取');
    if (entry.pending && !entry.data) return factLive(keyPrefix + '.pending', subject, '读取中…');
    if (entry.error && !entry.data) return factEmpty(keyPrefix + '.err', subject + '：' + entry.error);
    if (!entry.data) return factEmpty(keyPrefix + '.none', subject + '：无响应');
    try {
      return build(entry.data);
    } catch (e) {
      return factEmpty(keyPrefix + '.shape', subject + '：响应结构不匹配');
    }
  }

  /** 会话用量真聚合（与分析面板同一份数据）：惰性解析，未加载则返回 null。 */
  function analyticsSnapshot() {
    if (typeof buildAnalyticsSnapshot !== 'function') return null;
    try { return buildAnalyticsSnapshot() || null; } catch (e) { return null; }
  }

  /** DOM 真值：读取某节点当前渲染文本（空则空串）。 */
  function domText(selector) {
    var el = document.querySelector(selector);
    if (!el) return '';
    return String(el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 本会话遥测里某方法被调用的次数（真轨迹计数，不是常量）。 */
  function countCalls(name) {
    var n = 0;
    for (var i = 0; i < state.recentCalls.length; i += 1) {
      if (state.recentCalls[i].method === name) n += 1;
    }
    return n;
  }

  /** 侧栏 token 统计真值（应用自己写进 #tokenStat 的文本）。
   *  超长只做**呈现截断**并在 hint 里写明原文字数 —— 截断不改数据、不编数值。 */
  function tokenStatFact() {
    var raw = domText('#tokenStat');
    if (!raw) return factEmpty('tokenStat', '#tokenStat 未渲染');
    var shown = raw.length > 56 ? raw.slice(0, 56) + '…' : raw;
    return factLive('tokenStat', '侧栏 token 计数', '<code>' + escapeHtml(shown) + '</code>',
      raw.length > 56 ? '原文 ' + raw.length + ' 字，此处仅截断显示' : '');
  }

  /** 四宿主实测：存在性 + 矩形 + 计算后的 backdrop-filter（不做任何假设）。 */
  var HOST_SELECTORS = ['header.header', '#mainStage', '#observerWindow', '#glass-ribbon'];

  function hostMetrics() {
    var out = [];
    for (var i = 0; i < HOST_SELECTORS.length; i += 1) {
      var sel = HOST_SELECTORS[i];
      var el = document.querySelector(sel);
      var row = { host: sel, present: false, w: 0, h: 0, blur: '' };
      if (el) {
        var rect = el.getBoundingClientRect();
        var css = window.getComputedStyle(el);
        row.present = true;
        row.w = Math.round(rect.width);
        row.h = Math.round(rect.height);
        row.blur = String(css.backdropFilter || css.webkitBackdropFilter || 'none');
      }
      out.push(row);
    }
    return out;
  }

  function blurHostCount(metrics) {
    var n = 0;
    for (var i = 0; i < metrics.length; i += 1) {
      if (metrics[i].present && metrics[i].blur && metrics[i].blur !== 'none') n += 1;
    }
    return n;
  }

  /** 会话用量四个真读数；无会话数据时给空态而不是 0。 */
  function sessionFacts(snapshot) {
    var rows = (snapshot && snapshot.sessionRows) || [];
    if (!rows.length) return factEmpty('session.rows', '尚无会话用量（aggregateSessions 返回空）');
    var total = 0, cached = 0, cost = 0;
    for (var i = 0; i < rows.length; i += 1) {
      total += Number(rows[i].total) || 0;
      cached += Number(rows[i].cached) || 0;
      cost += Number(rows[i].cost) || 0;
    }
    var toolCount = ((snapshot && snapshot.toolRows) || []).length;
    return factLive('session.count', '会话数（用量聚合）', '<strong>' + rows.length + '</strong> 个')
      + factLive('session.total', '全部会话 Tokens', '<strong>' + total.toLocaleString() + '</strong>')
      + factLive('session.cached', '缓存命中 Tokens', '<strong>' + cached.toLocaleString() + '</strong>')
      + factLive('session.cost', '累计成本', '<strong>¥' + cost.toFixed(4) + '</strong>')
      + factLive('session.tools', '工具种类（工具聚合）', '<strong>' + toolCount + '</strong> 种');
  }

  function renderPrototypeContent(protoId) {
    var trace = traceRows();
    switch (protoId) {
      case 'plinth-chart': {
        var snapshot = analyticsSnapshot();
        return card('推理与工具面负载展台',
          factLive('callCount', '累计 JSAPI 调度', '<strong>' + state.callCount + '</strong> 次')
          + factLive('estTokens', '估算上下文负载', '<strong>' + state.estTokens + '</strong> Tokens', 'JSON 长度 / 3.6 粗估')
          + factLive('lastStatus', '最近状态', '<strong>' + escapeHtml(state.lastStatus) + '</strong>')
          + tokenStatFact()
          + (snapshot ? sessionFacts(snapshot)
            : factEmpty('session.rows', 'buildAnalyticsSnapshot 未就绪（会话模块未加载）')))
          + card('最近调用', trace);
      }
      case 'stair-gate': {
        var info = requestApi('get_api_info', []);
        var guard = requestApi('guard_get_config', []);
        return card('确定性门控 · 实测读数',
          apiFacts(info, 'api', 'get_api_info 不可用', function (d) {
            var methods = (d && d.methods && d.methods.length) ? d.methods.length : 0;
            return factLive('api.methods', '公开方法面（实测）', '<strong>' + methods + '</strong> 项')
              + factLive('api.version', '后端契约版本', '<strong>' + escapeHtml(String(d.version || '—')) + '</strong>')
              + factLive('api.exe', '后端实现', '<code>' + escapeHtml(String(d.exe || '—')) + '</code>');
          })
          + apiFacts(guard, 'guard', 'guard_get_config 不可用', function (d) {
            var budget = (d && d.approval_budget) || {};
            var rules = (d && d.allow_rules && d.allow_rules.length) ? d.allow_rules.length : 0;
            var trusted = (d && d.trustedOps && d.trustedOps.length) ? d.trustedOps.length : 0;
            return factLive('guard.used', '审批预算已用', '<strong>' + (Number(budget.used) || 0) + '</strong>')
              + factLive('guard.escalated', '升级确认次数', '<strong>' + (Number(budget.escalated) || 0) + '</strong>')
              + factLive('guard.rules', '护栏放行规则', '<strong>' + rules + '</strong> 条')
              + factLive('guard.trusted', '已信任操作', '<strong>' + trusted + '</strong> 项');
          }));
      }
      case 'retrieval-well': {
        var memHits = countCalls('memory_search');
        var schemaHits = countCalls('inspect_tool_schema');
        return card('记忆与渐进工具检索井',
          factLive('retrieval.memory', 'memory_search 命中', '<strong>' + memHits + '</strong> 次', '本会话 callApi 轨迹计数')
          + factLive('retrieval.schema', 'inspect_tool_schema 命中', '<strong>' + schemaHits + '</strong> 次')
          + ((memHits + schemaHits) ? '' : factEmpty('retrieval.empty', '本会话轨迹中检索类调用 0 命中'))
          + trace);
      }
      case 'lane-timeline': {
        if (!state.recentCalls.length) {
          return card('实时调用时间泳道', factEmpty('lane.empty', '本会话尚无 callApi 轨迹'));
        }
        var sum = 0, slowest = 0;
        for (var li = 0; li < state.recentCalls.length; li += 1) {
          var ms = Number(state.recentCalls[li].durationMs) || 0;
          sum += ms;
          if (ms > slowest) slowest = ms;
        }
        return card('实时调用时间泳道',
          factLive('lane.count', '轨迹样本', '<strong>' + state.recentCalls.length + '</strong> 次')
          + factLive('lane.avg', '平均耗时', '<strong>' + Math.round(sum / state.recentCalls.length) + '</strong> ms')
          + factLive('lane.max', '最慢一次', '<strong>' + slowest + '</strong> ms')
          + trace);
      }
      case 'topology-ring': {
        var metrics = hostMetrics();
        var rows = '';
        for (var hi = 0; hi < metrics.length; hi += 1) {
          var m = metrics[hi];
          rows += factConst('host.' + hi, '宿主 ' + (hi + 1) + ' 选择器', '<code>' + escapeHtml(m.host) + '</code>');
          rows += m.present
            ? factLive('host.' + hi + '.rect', m.host + ' 实测尺寸',
              '<strong>' + m.w + '×' + m.h + '</strong> px', m.blur)
            : factEmpty('host.' + hi + '.absent', m.host + ' 节点未挂载');
        }
        return card('四宿主光学拓扑 · 实测', rows
          + factLive('blurHosts', '实测模糊宿主数', '<strong>' + blurHostCount(metrics) + '</strong> 个'));
      }
      case 'drawer-cabinet': {
        var ws = requestApi('get_effective_ws', []);
        var sandbox = requestApi('sandbox_status', []);
        return card('工作区与沙盒 · 实测状态',
          apiFacts(ws, 'ws', 'get_effective_ws 不可用', function (d) {
            if (!d.ws) return factEmpty('ws.none', '后端未返回有效工作区路径');
            return factLive('ws.path', '有效工作区', '<code>' + escapeHtml(String(d.ws)) + '</code>')
              + factLive('ws.source', '来源', escapeHtml(String(d.source || '—')))
              + factLive('ws.exists', '目录存在', d.exists ? '是' : '否');
          })
          + apiFacts(sandbox, 'sandbox', 'sandbox_status 不可用', function (d) {
            var stats = (d && d.stats) || {};
            return factLive('sandbox.available', '沙盒能力', d.available ? '可用' : '不可用')
              + factLive('sandbox.platform', '平台', escapeHtml(String(d.platform || '—')))
              + factLive('sandbox.enabled', '配置启用', d.enabled ? '是' : '否')
              + factLive('sandbox.jobs', '受沙盒运行次数', '<strong>' + (Number(stats.runs_sandboxed) || 0) + '</strong>');
          }));
      }
      case 'form-stack': {
        var guardCfg = requestApi('guard_get_config', []);
        return card('业务参数与护栏 · 实测配置',
          factLive('form.lastMethod', '最近调用方法', '<code>' + escapeHtml(state.lastMethod) + '</code>')
          + factLive('form.estTokens', '最近负载估算', '<strong>' + state.estTokens + '</strong> Tokens')
          + apiFacts(guardCfg, 'guardCfg', 'guard_get_config 不可用', function (d) {
            var budget = (d && d.approval_budget) || {};
            var rules = (d && d.allow_rules) ? d.allow_rules : [];
            var hits = 0;
            for (var ri = 0; ri < rules.length; ri += 1) hits += Number(rules[ri].hits) || 0;
            return factLive('guardCfg.used', '审批预算已用', '<strong>' + (Number(budget.used) || 0) + '</strong>')
              + factLive('guardCfg.rules', '放行规则命中合计', '<strong>' + hits + '</strong> 次');
          }));
      }
      case 'rack-tabs': {
        var mcpEntry = requestApi('mcp_list_servers', []);
        return card('多上下文分层机架 · 实测清单',
          apiFacts(mcpEntry, 'mcp', 'mcp_list_servers 不可用', function (d) {
            var list = (d && d.servers) ? d.servers : [];
            if (!list.length) return factEmpty('mcp.servers', 'MCP 未注册任何服务（后端返回空清单）');
            var html = factLive('mcp.count', '已注册 MCP 服务', '<strong>' + list.length + '</strong> 个');
            for (var mi = 0; mi < list.length && mi < 6; mi += 1) {
              var srv = list[mi];
              html += factLive('mcp.' + mi, String(srv.name),
                escapeHtml(String(srv.transport || '—')) + ' · ' + escapeHtml(String(srv.status || '—'))
                + ' · 工具 ' + (Number(srv.tool_count) || 0));
            }
            return html;
          }));
      }
      case 'flow-track':
      default:
        return card('端到端执行流程轨',
          factLive('flow.status', '最近状态', '<strong>' + escapeHtml(state.lastStatus) + '</strong>')
          + factLive('flow.method', '最近方法', '<code>' + escapeHtml(state.lastMethod) + '</code>')
          + factLive('flow.calls', '累计调度', '<strong>' + state.callCount + '</strong> 次'))
          + card('最近 callApi 实时轨迹', trace);
    }
  }

  /* ───── 刷新 ───── */

  /** 只重绘观察窗内容区。取数回调走这里而不是 updateObserverAndRibbon：
   *  后者会顺带重算光带与 chip 状态，属于无关副作用；更重要的是这条路径
   *  不得再触发取数（TTL 命中保证不重发）。 */
  function repaintActiveView() {
    var obs = document.getElementById('observerWindow');
    if (!obs) return;
    var bodyEl = obs.querySelector('.lw-obs-body');
    if (bodyEl) bodyEl.innerHTML = renderPrototypeContent(state.activePrototype);
  }

  function updateObserverAndRibbon() {
    var obs = document.getElementById('observerWindow');
    if (!obs) return;

    obs.setAttribute('data-prototype', state.activePrototype);
    if (state.observerOpen) obs.classList.remove('lw-collapsed');
    else obs.classList.add('lw-collapsed');
    document.body.classList.toggle('lw-observer-open', state.observerOpen);

    var chips = obs.querySelectorAll('.lw-proto-chip');
    for (var i = 0; i < chips.length; i += 1) {
      var on = chips[i].getAttribute('data-proto-id') === state.activePrototype;
      chips[i].classList.toggle('active', on);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    var bodyEl = obs.querySelector('.lw-obs-body');
    if (bodyEl) bodyEl.innerHTML = renderPrototypeContent(state.activePrototype);

    var stats = document.getElementById('lw-rib-stats');
    if (stats) {
      stats.textContent = 'CALLS: ' + state.callCount
        + ' | EST_TOKENS: ' + state.estTokens
        + ' | LAST: ' + state.lastMethod + ' (' + state.lastStatus + ')';
    }
  }

  /* ───── 明暗档同步 ───── */

  /** 把 body.dark 镜像成 html 的 data-lw-dark。暗档令牌只能挂 body.dark（应用自身暗色变量
   *  同层，皮肤需更具体才能压过），而页面底色在 html ⇒ 读不到 body 的 --bg，暗档整页明底。
   *  属性是唯一不依赖 :has 的解法。 */
  function syncDarkFlag() {
    if (document.body.classList.contains('dark')) HTML.setAttribute('data-lw-dark', '1');
    else HTML.removeAttribute('data-lw-dark');
  }

  /* ───── 液态折射（R92-3：先测后决 ⇒ 三选全中，默认开；?liquid=0 可关） ───── */

  /** 读 URL 上的 liquid 参数：**默认开**，只有显式 ?liquid=0 才关。
   *  默认值由测量结论决定，不是拍脑袋：qa/r92/optics-probe.mjs 的 pre-registered
   *  判据（avg ≥ 50fps 且 p95 ≤ 25ms 且长帧(>50ms)=0，三选全中才开）在最终产物上
   *  两个视口都稳定满足。**代价是机器相关的**：800 视口我实测 0.8fps（165→164.2）、
   *  QA 另一台机实测 5.6fps（165→159.45），两测都远优于阈值，引用时写区间不要写单点。
   *  为什么留 ?liquid=0 逃生门：本轮只覆盖本机 msedge 165Hz + 集显/独显的一种组合，
   *  低端核显与驱动差异不在覆盖范围内；留一个不改代码就能退回 R92-2 视觉的口子。
   *  **绝不写 localStorage**：Electron 里没有地址栏也没有 devtools，一旦落盘
   *  用户就被锁在一个自己关不掉的视觉档里，无法自行恢复。 */
  function wantsLiquid() {
    try {
      var search = String((window.location && window.location.search) || '');
      return !/(?:^\?|&)liquid=0(?:&|$)/.test(search);
    } catch (e) {
      return true;   // 读不到 URL 时按默认值（开）处理，与文档一致
    }
  }

  /** 把开关镜像到 html 的 data-lw-liquid（样式只认这个属性，不认 URL）。 */
  function syncLiquidFlag() {
    if (wantsLiquid()) HTML.setAttribute('data-lw-liquid', '1');
    else HTML.removeAttribute('data-lw-liquid');
  }

  /** 暗档镜像单独绑观察器：不寄生在时钟的观察器里，避免时钟取不到节点提前 return
   *  时镜像静默失效（暗档整页明底且无报错）。 */
  function bindDarkWatch() {
    syncDarkFlag();
    if (typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(syncDarkFlag);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ───── 视口宽度收口 ───── */

  /** 跨 1080px 阈值切观察窗开合。必须由脚本做：「要不要占位」改的是 body.lw-observer-open
   *  （影响主台 margin），纯 CSS 只能藏节点、无法撤销 body 状态。只在跨阈值时动作，
   *  同宽度 resize 不重复执行，用户手动开合也不被下一次 resize 抢回去。 */
  var lastNarrow = null;

  function syncViewportWidth() {
    var narrow = (window.innerWidth || 0) < NARROW_MAX_WIDTH;
    if (lastNarrow === narrow) return;
    lastNarrow = narrow;

    if (narrow) {
      if (state.observerOpen) {
        state.observerOpen = false;
        state.narrowAuto = true;
        updateObserverAndRibbon();
      }
      return;
    }
    // 回到宽屏：只恢复「因窄屏被自动收起」的那一次
    if (state.narrowAuto) {
      state.narrowAuto = false;
      if (!state.observerOpen) {
        state.observerOpen = true;
        updateObserverAndRibbon();
      }
    }
  }

  function bindViewportWatch() {
    syncViewportWidth();
    if (typeof window.addEventListener !== 'function') return;
    var pending = null;
    window.addEventListener('resize', function () {
      if (pending) return;
      pending = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
        pending = null;
        syncViewportWidth();
      });
    }, { passive: true });
  }

  /* ───── 光学时钟 ───── */

  function startOpticsClock() {
    var el = document.getElementById('lw-optics-clock');
    if (!el) return;

    function tick() {
      // fx-off 时连 1s 定时器都不必跑：直接停掉，符合"特效关闭即无动效开销"。
      if (document.body.classList.contains('fx-off')) {
        el.textContent = 'OPTICS: STATIC (FX-OFF)';
        if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
        return;
      }
      var now = new Date();
      var hh = String(now.getHours()).padStart(2, '0');
      var mm = String(now.getMinutes()).padStart(2, '0');
      var ss = String(now.getSeconds()).padStart(2, '0');
      el.textContent = 'LIGHTWELL · ' + hh + ':' + mm + ':' + ss;
    }

    tick();
    if (!state.clockTimer) state.clockTimer = setInterval(tick, 1000);

    // fx-off 是 body 上的 class，动态开关时重新评估，不必等下一次 tick 才能纠正显示。
    // 暗档镜像不在这里收敛，见 bindDarkWatch（各自独立失效）。
    if (typeof MutationObserver === 'function') {
      var mo = new MutationObserver(function () {
        var off = document.body.classList.contains('fx-off');
        if (off && state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; tick(); }
        else if (!off && !state.clockTimer) { state.clockTimer = setInterval(tick, 1000); tick(); }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* ───── callApi 遥测 ───── */

  /** 包裹全局 callApi。可行性：bridge.js 的 async function callApi 在主 <script> 顶层
   *  （顺序拼接无 IIFE），顶层函数声明即 window 属性 ⇒ 可替换，模块内调用同一绑定。
   *  时机：prebuilt 段先于 scripts，此刻未定义 ⇒ 有限重试（20 × 100ms），不是放弃。
   *  口径：EST_TOKENS = JSON 长度 / 3.6 的粗估，仅体感反馈，非计费口径。 */
  function hookCallApiTelemetry(attempt) {
    if (state.hooked) return;
    var n = attempt || 0;
    if (typeof window.callApi !== 'function') {
      if (n < 20) setTimeout(function () { hookCallApiTelemetry(n + 1); }, 100);
      return;
    }
    var orig = window.callApi;
    var wrapped = function lwCallApiProxy(method, args) {
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      state.callCount += 1;
      state.lastMethod = String(method || 'unknown');
      try {
        state.estTokens += Math.ceil(JSON.stringify(args || []).length / 3.6);
      } catch (e) { /* 循环引用等，忽略估算 */ }
      updateObserverAndRibbon();

      var ret;
      try {
        ret = orig.apply(this, arguments);
      } catch (err) {
        state.lastStatus = 'ERR';
        pushCall(state.lastMethod, t0, 'ERR');
        throw err;
      }
      // 同步抛错已在上面兜住；这里处理 Promise 与普通返回值两种形态。
      if (ret && typeof ret.then === 'function') {
        return ret.then(function (v) {
          state.lastStatus = 'OK';
          pushCall(state.lastMethod, t0, 'OK');
          return v;
        }, function (e) {
          state.lastStatus = 'ERR';
          pushCall(state.lastMethod, t0, 'ERR');
          throw e;
        });
      }
      state.lastStatus = 'OK';
      pushCall(state.lastMethod, t0, 'OK');
      return ret;
    };
    wrapped.__lwWrapped = true;
    window.callApi = wrapped;
    state.hooked = true;
  }

  function pushCall(method, t0, status) {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    state.recentCalls.push({
      method: method,
      durationMs: Math.round(now - t0),
      status: status
    });
    if (state.recentCalls.length > 30) state.recentCalls.shift();
    updateObserverAndRibbon();
  }

  /* ───── 启动 ───── */

  function mount() {
    try {
      mountWallpaper();
      mountSvgDefs();
      mountMainStage();

      var deep = HTML.getAttribute('data-lw-prototype');
      if (deep) {
        for (var i = 0; i < PROTOTYPE_VIEWS.length; i += 1) {
          if (PROTOTYPE_VIEWS[i].id === deep) { state.activePrototype = deep; break; }
        }
      }

      buildObserver();
      buildRibbon();
      startOpticsClock();
      hookCallApiTelemetry(0);
      syncLiquidFlag();
      updateObserverAndRibbon();
      bindDarkWatch();
      bindViewportWatch();
    } catch (err) {
      // 壳层失败不得影响主界面：只记录，不抛出。
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[LIGHTWELL] 工作台壳层挂载失败，主界面继续运行：', err);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  // 供 QA 探针读取（只读快照，不含写操作）
  window.__LIGHTWELL_SHELL__ = {
    views: PROTOTYPE_VIEWS.map(function (p) { return p.id; }),
    snapshot: function () {
      var pendingMethods = [];
      var knownMethods = [];
      for (var key in apiCache) {
        if (!Object.prototype.hasOwnProperty.call(apiCache, key)) continue;
        knownMethods.push(key);
        if (apiCache[key].pending) pendingMethods.push(key);
      }
      return {
        activePrototype: state.activePrototype,
        observerOpen: state.observerOpen,
        callCount: state.callCount,
        estTokens: state.estTokens,
        lastMethod: state.lastMethod,
        lastStatus: state.lastStatus,
        recentCalls: state.recentCalls.slice(),
        hooked: state.hooked,
        narrowAuto: state.narrowAuto,
        viewportWidth: window.innerWidth || 0,
        narrowThreshold: NARROW_MAX_WIDTH,
        apiTtlMs: API_TTL_MS,
        apiKnownMethods: knownMethods,
        apiPendingMethods: pendingMethods
      };
    }
  };
})();
