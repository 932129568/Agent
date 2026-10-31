/* ================= 数据分析面板（v3 · 纯手写 SVG，零新依赖） =================
 * 数据 100% 来自运行时 sessions[]（65-session-store 加载），前端聚合，零硬编码数字。
 * 口径与 60-agent-loop 一致：工具结果 JSON 有 error=失败、skipped=拦截，否则成功。
 * 耗时：25-tool-exec.js 前端插桩写入 __ms；历史会话无 __ms → 显示"暂无耗时数据"，不造假。
 * R3：绝不触碰 #tokenStat（updateTokenStat 直接写它的 textContent）。
 */
let __trendMetric = 'total';

function __fmtNum(n) {
  n = Math.round(n || 0);
  return n.toLocaleString();
}
function __fmtCost(n) { return '¥' + (n || 0).toFixed(4); }

/* ---- 聚合：逐会话 usage（复用 75-token-stat 的 calcUsage 与 MODEL_PRICE）---- */
function aggregateSessions() {
  const rows = [];
  (sessions || []).slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).forEach(s => {
    const u = calcUsage(s.messages || []);
    if (u.total > 0) rows.push({ id: s.id, title: s.title || '新对话', updatedAt: s.updatedAt, total: u.total, cached: u.cached, cost: u.cost });
  });
  return rows;
}
/* ---- 聚合：工具调用统计（次数 / 成功率 / 耗时）---- */
function aggregateTools() {
  const map = new Map();   // name -> {count, ok, fail, skip, msList}
  (sessions || []).forEach(s => (s.messages || []).forEach(m => {
    if (m.role !== 'tool') return;
    let name = m.__tool || '未知工具';
    // 配对：找同会话 assistant 消息里同 id 的 tool_calls 名称做兜底
    let verdict = 'ok';
    try {
      const r = JSON.parse(m.content);
      if (r && typeof r === 'object') {
        if (r.error) verdict = 'fail';
        else if (r.skipped) verdict = 'skip';
      }
    } catch (e) { /* content 非 JSON：按成功计，与工具卡片判定一致 */ }
    if (!map.has(name)) map.set(name, { count: 0, ok: 0, fail: 0, skip: 0, msList: [] });
    const st = map.get(name);
    st.count++;
    st[verdict]++;
    if (typeof m.__ms === 'number' && isFinite(m.__ms) && m.__ms >= 0) st.msList.push(m.__ms);
  }));
  const list = [...map.entries()].map(([name, st]) => ({
    name, count: st.count, fail: st.fail, skip: st.skip,
    rate: st.count ? (st.ok / st.count * 100) : 0,
    avgMs: st.msList.length ? st.msList.reduce((a, b) => a + b, 0) / st.msList.length : null,
    maxMs: st.msList.length ? Math.max.apply(null, st.msList) : null
  }));
  list.sort((a, b) => b.count - a.count);
  return list;
}

/** 单次面板渲染共享同一数据快照，避免四个组件重复扫描 sessions。 */
function buildAnalyticsSnapshot() {
  return { sessionRows: aggregateSessions(), toolRows: aggregateTools() };
}

/* ---- SVG 基础工具 ---- */
function __svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function __clear(id) { const el = document.getElementById(id); if (el) el.innerHTML = ''; return el; }
/* E4 · 数字滚动 count-up（特效关 / reduced-motion 时瞬时到终值）
 * v4：时长走 MOTION.count()（CSS 令牌单一事实源，JS 硬编码时长已清场），
 * 缓动与 --ease-out-soft:cubic-bezier(.25,.8,.35,1) 精确对齐 */
function countUpText(el, target, fmt) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fxOff = document.body.classList.contains('fx-off');
  if (!el) return;
  if (fxOff || reduce) { el.textContent = fmt(target); return; }
  const dur = typeof MOTION !== 'undefined' ? MOTION.count() : 600;
  const ease = (typeof MOTION !== 'undefined' && MOTION.easeOutSoft) || (p => 1 - Math.pow(1 - p, 3));
  const start = performance.now(), from = 0;
  function step(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = ease(p);
    el.textContent = fmt(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ---- 汇总卡片 ---- */
function renderStatCards(rows) {
  const box = document.getElementById('statCards');
  if (!box) return;
  rows = rows || aggregateSessions();
  let total = 0, cached = 0, cost = 0;
  rows.forEach(r => { total += r.total; cached += r.cached; cost += r.cost; });
  box.innerHTML =
    '<div class="stat-card g-card"><div class="stat-label">全部会话 Tokens</div><div class="stat-value" id="statTotal">—</div></div>' +
    '<div class="stat-card g-card"><div class="stat-label">实际成本</div><div class="stat-value" id="statCost">—</div></div>' +
    '<div class="stat-card g-card"><div class="stat-label">缓存命中 Tokens</div><div class="stat-value" id="statCached">—</div></div>' +
    '<div class="stat-card g-card"><div class="stat-label">会话数</div><div class="stat-value" id="statCount">—</div></div>';
  countUpText(document.getElementById('statTotal'), total, __fmtNum);
  countUpText(document.getElementById('statCost'), cost, __fmtCost);
  countUpText(document.getElementById('statCached'), cached, __fmtNum);
  countUpText(document.getElementById('statCount'), rows.length, n => String(Math.round(n)));
}

/* ---- 图 1 · 成本 / Token 趋势（折线 + 面积）---- */
function setTrendMetric(m) { __trendMetric = m; renderTrendChart(); }
function renderTrendChart(rows) {
  const wrap = __clear('chartTrend');
  if (!wrap) return;
  wrap.classList.remove('drawn');
  document.querySelectorAll('#trendMetricSeg .seg-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.metric === __trendMetric));
  rows = rows || aggregateSessions();
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="chart-empty"><div class="chart-empty-icon">✦</div><b>还没有可分析的数据</b><span>发起一次对话后，这里会出现 token 与成本趋势</span></div>';
    return;
  }
  const W = Math.max(wrap.clientWidth || 640, 320), H = 240;
  const PL = 56, PR = 14, PT = 14, PB = 26;
  const vals = rows.map(r => __trendMetric === 'cost' ? r.cost : (__trendMetric === 'cached' ? r.cached : r.total));
  const fmt = __trendMetric === 'cost' ? (v => '¥' + v.toFixed(2)) : (v => __fmtNum(v));
  const max = Math.max.apply(null, vals) || 1;
  const iw = W - PL - PR, ih = H - PT - PB;
  const svg = __svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%', preserveAspectRatio: 'none' });
  const defs = __svgEl('defs', {});
  const grad = __svgEl('linearGradient', { id: 'trendAreaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(__svgEl('stop', { offset: '0%', 'stop-color': 'var(--chart-area-from)' }));
  grad.appendChild(__svgEl('stop', { offset: '100%', 'stop-color': 'var(--chart-area-to)' }));
  defs.appendChild(grad); svg.appendChild(defs);
  // 网格线（只画 4 条水平线，不画满）
  for (let i = 0; i <= 3; i++) {
    const y = PT + ih * i / 3;
    svg.appendChild(__svgEl('line', { x1: PL, y1: y, x2: W - PR, y2: y, class: 'chart-grid-line' }));
    const t = __svgEl('text', { x: PL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'chart-ax' });
    t.textContent = fmt(max * (1 - i / 3));
    svg.appendChild(t);
  }
  const pts = vals.map((v, i) => [PL + (rows.length === 1 ? iw / 2 : iw * i / (rows.length - 1)), PT + ih * (1 - v / max)]);
  // 面积
  const area = __svgEl('path', { class: 'chart-area', fill: 'url(#trendAreaGrad)',
    d: 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'L' + (PL + iw) + ',' + (PT + ih) + 'L' + PL + ',' + (PT + ih) + 'Z' });
  svg.appendChild(area);
  // 折线（stroke-dasharray 描画入场，E6）
  const line = __svgEl('path', { class: 'chart-line', stroke: 'var(--chart-1)', pathLength: 1,
    d: 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') });
  svg.appendChild(line);
  // 数据点
  pts.forEach((p, i) => {
    svg.appendChild(__svgEl('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 3, fill: 'var(--chart-1)', class: 'chart-dot' }));
  });
  // X 轴标（最多 6 个：首 + 均分）
  const stepX = Math.max(1, Math.ceil(rows.length / 6));
  rows.forEach((r, i) => {
    if (i % stepX !== 0 && i !== rows.length - 1) return;
    const t = __svgEl('text', { x: pts[i][0].toFixed(1), y: H - 8, 'text-anchor': 'middle', class: 'chart-ax' });
    const d = new Date(r.updatedAt || Date.now());
    t.textContent = (d.getMonth() + 1) + '/' + d.getDate();
    svg.appendChild(t);
  });
  // v4 深化（2026-10-21）：悬停数值提示——自定义竖参考线+大圆点+玻璃浮层
  // （替代原生 <title>：悬停延迟高、不可样式化、暗色下系统配色不可控）
  const hLine = __svgEl('line', { class: 'chart-hover-line', x1: 0, y1: PT, x2: 0, y2: PT + ih });
  const hDot = __svgEl('circle', { class: 'chart-hover-dot', r: 4.5, cx: 0, cy: 0 });
  svg.appendChild(hLine); svg.appendChild(hDot);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  wrap.appendChild(tip);
  const _hideHover = () => { hLine.style.opacity = '0'; hDot.style.opacity = '0'; tip.style.opacity = '0'; };
  _hideHover();
  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const sx = (ev.clientX - rect.left) * (W / rect.width);   // → viewBox 坐标
    let bi = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p[0] - sx); if (d < bd) { bd = d; bi = i; } });
    const p = pts[bi];
    hLine.setAttribute('x1', p[0]); hLine.setAttribute('x2', p[0]);
    hDot.setAttribute('cx', p[0]); hDot.setAttribute('cy', p[1]);
    hLine.style.opacity = '1'; hDot.style.opacity = '1';
    const d = new Date(rows[bi].updatedAt || Date.now());
    tip.innerHTML = '<b>' + fmt(vals[bi]) + '</b><span>' + (d.getMonth() + 1) + '/' + d.getDate() +
      ' · ' + (typeof escapeHtml === 'function' ? escapeHtml(String(rows[bi].title).slice(0, 18)) : String(rows[bi].title).slice(0, 18)) + '</span>';
    tip.style.opacity = '1';
    tip.style.left = Math.max(8, Math.min(92, p[0] / W * 100)) + '%';
    tip.style.top = Math.max(4, p[1] / H * 100) + '%';
  });
  svg.addEventListener('mouseleave', _hideHover);
  wrap.appendChild(svg);
  wrap.style.maxWidth = '100%';
  // E6 描画动画：触发 reflow 后进入终态
  // v4：E6 描画动画——与面板 L2 入场错峰 --stagger-sm（60ms）后触发挥画终态
  setTimeout(() => wrap.classList.add('drawn'), typeof MOTION !== 'undefined' ? MOTION.staggerSm() : 60);
}

/* ---- 图 2 左 · 工具调用次数条形图（横向条）---- */
function renderToolBars(list) {
  const wrap = __clear('toolBars');
  if (!wrap) return;
  wrap.classList.remove('drawn');
  list = list || aggregateTools();
  if (list.length === 0) {
    wrap.innerHTML = '<div class="chart-empty"><div class="chart-empty-icon">✦</div><b>还没有工具调用记录</b><span>让 AI 执行一次文件 / 命令操作后这里会出现统计</span></div>';
    return;
  }
  const top = list.slice(0, 8);
  const max = top[0].count || 1;
  const W = Math.max(wrap.clientWidth || 420, 280);
  const rowH = 30, labelW = 128, valW = 56;
  const H = top.length * rowH + 6;
  const svg = __svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, preserveAspectRatio: 'none' });
  top.forEach((t, i) => {
    const y = i * rowH + 5;
    const lb = __svgEl('text', { x: 0, y: y + 12, class: 'bar-label' });
    lb.textContent = t.name.length > 16 ? t.name.slice(0, 15) + '…' : t.name;
    svg.appendChild(lb);
    const barW = Math.max(2, (W - labelW - valW) * t.count / max);
    const bar = __svgEl('rect', { x: labelW, y: y, width: barW.toFixed(1), height: 18,
      rx: 4, fill: 'var(--chart-3)', class: 'chart-bar', style: 'transition-delay:calc(var(--stagger-sm) * ' + i + ')' });
    const title = __svgEl('title', {});
    title.textContent = t.name + ' · 调用 ' + t.count + ' 次';
    bar.appendChild(title);
    svg.appendChild(bar);
    const v = __svgEl('text', { x: W - valW + 6, y: y + 12, class: 'bar-val' });
    v.textContent = String(t.count);
    svg.appendChild(v);
  });
  wrap.appendChild(svg);
  // v4：E6 描画动画——与面板 L2 入场错峰 --stagger-sm（60ms）后触发挥画终态
  setTimeout(() => wrap.classList.add('drawn'), typeof MOTION !== 'undefined' ? MOTION.staggerSm() : 60);
}

/* ---- 图 2 右 · 成功率环形 + 平均耗时条 ---- */
function renderToolRingAndMs(list) {
  const ringBox = __clear('toolRing');
  const msBox = __clear('toolMs');
  if (!ringBox || !msBox) return;
  list = list || aggregateTools();
  if (list.length === 0) {
    ringBox.innerHTML = '<div class="chart-empty" style="min-height:120px"><div class="chart-empty-icon">✦</div><b>暂无成功率数据</b></div>';
    msBox.innerHTML = '<div class="chart-empty" style="min-height:110px"><div class="chart-empty-icon">✦</div><b>暂无耗时数据</b><span>新产生的工具调用会自动计时</span></div>';
    return;
  }
  // 环形（成功率 = ok / 总数，口径与工具卡片三态一致）
  let count = 0, ok = 0, fail = 0, skip = 0;
  list.forEach(t => { count += t.count; ok += t.count - t.fail - t.skip; fail += t.fail; skip += t.skip; });
  const rate = count ? ok / count * 100 : 0;
  const R = 54, CIRC = 2 * Math.PI * R;
  ringBox.innerHTML =
    '<svg viewBox="0 0 140 140" width="140" height="140">' +
    '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="var(--chart-grid)" stroke-width="12"/>' +
    '<circle class="ring-val" cx="70" cy="70" r="' + R + '" fill="none" stroke="var(--chart-2)" stroke-width="12" stroke-linecap="round" ' +
    'stroke-dasharray="' + CIRC.toFixed(1) + '" stroke-dashoffset="' + CIRC.toFixed(1) + '" transform="rotate(-90 70 70)"/>' +
    '<text class="ring-num" x="70" y="76" text-anchor="middle">0%</text>' +
    '<text class="ring-cap" x="70" y="94" text-anchor="middle">成功率</text></svg>' +
    '<div class="ring-legend">' +
    '<span><i style="background:var(--chart-2)"></i>成功 ' + ok.toLocaleString() + '</span>' +
    '<span><i style="background:var(--chart-4)"></i>失败 ' + fail.toLocaleString() + '</span>' +
    '<span><i style="background:var(--chart-grid)"></i>拦截 ' + skip.toLocaleString() + '</span>' +
    '<span style="color:var(--text-3)">共 ' + count.toLocaleString() + ' 次调用</span></div>';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rv = ringBox.querySelector('.ring-val');
    if (rv) rv.style.strokeDashoffset = String(CIRC * (1 - rate / 100));
    const rn = ringBox.querySelector('.ring-num');
    if (rn) countUpText(rn, rate, v => Math.round(v) + '%');
  }));
  // 耗时条（仅统计带 __ms 的新数据；历史会话显示"暂无耗时数据"）
  const withMs = list.filter(t => t.avgMs !== null);
  if (withMs.length === 0) {
    msBox.innerHTML = '<div class="chart-empty" style="min-height:110px"><div class="chart-empty-icon">✦</div><b>暂无耗时数据</b><span>耗时统计仅覆盖本次版本之后新产生的工具调用</span></div>';
    return;
  }
  msBox.classList.remove('drawn');
  msBox.innerHTML = '';
  const maxMs = Math.max.apply(null, withMs.map(t => t.avgMs));
  const W = Math.max(msBox.clientWidth || 420, 280);
  const rowH = 30, labelW = 128, valW = 86;
  const H = withMs.slice(0, 8).length * rowH + 6;
  const svg = __svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, preserveAspectRatio: 'none' });
  withMs.slice(0, 8).forEach((t, i) => {
    const y = i * rowH + 5;
    const lb = __svgEl('text', { x: 0, y: y + 12, class: 'bar-label' });
    lb.textContent = t.name.length > 16 ? t.name.slice(0, 15) + '…' : t.name;
    svg.appendChild(lb);
    const barW = Math.max(2, (W - labelW - valW) * t.avgMs / maxMs);
    const bar = __svgEl('rect', { x: labelW, y: y, width: barW.toFixed(1), height: 18,
      rx: 4, fill: 'var(--chart-1)', class: 'chart-bar', style: 'transition-delay:calc(var(--stagger-sm) * ' + i + ')' });
    const title = __svgEl('title', {});
    title.textContent = t.name + ' · 平均 ' + Math.round(t.avgMs) + ' ms / 最大 ' + Math.round(t.maxMs) + ' ms';
    bar.appendChild(title);
    svg.appendChild(bar);
    const v = __svgEl('text', { x: W - valW + 6, y: y + 12, class: 'bar-val' });
    v.textContent = Math.round(t.avgMs) + ' ms';
    svg.appendChild(v);
  });
  msBox.appendChild(svg);
  // v4：与面板 L2 入场错峰 --stagger-sm（60ms）后触发挥画终态
  setTimeout(() => msBox.classList.add('drawn'), typeof MOTION !== 'undefined' ? MOTION.staggerSm() : 60);
}

function renderAnalytics() {
  const snapshot = buildAnalyticsSnapshot();
  renderStatCards(snapshot.sessionRows);
  renderTrendChart(snapshot.sessionRows);
  renderToolBars(snapshot.toolRows);
  renderToolRingAndMs(snapshot.toolRows);
}
