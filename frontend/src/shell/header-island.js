/* ================= v3.4 I21 · 顶栏「灵动岛」 =================
 * 目的（施工总册 I21）：顶栏不再只显示静态模型名，而是回归**会话面包屑**，
 * 并随 Agent 状态弹性伸缩，把「轮次 / 阶段 / 累计工具步数 / 估算 token」做成里程表。
 *
 * 三条约束（本仓既定纪律）：
 *  ① **不往模板加 id / onclick**：整块 DOM 运行期创建（模板加 id 会撞 arch-contract 的
 *     「B0 300 个 id 全覆盖」，加 onclick 会撞 contract_diff 的 onclick_fns 集合）。
 *  ② **不静态引用别的模块**：读会话/轨迹/阶段一律走 globalThis 动态索引
 *     （SCC 16 环 / 102 符号，零余量，加一条静态边就可能成环）。
 *  ③ 数值一律 `tabular-nums`，变化时加一次 `.roll` 类做「里程表滚动」——
 *     不是假动画：类只在数值真的变了时加，探针可断言。
 */

const HW_ISLAND_ID = 'hwIsland';

function _hwFn(name) {
  try { return (typeof globalThis !== 'undefined' && globalThis[name]) || null; } catch (e) { return null; }
}

/** 读当前会话（sessions 既可能在 AppState 也可能是全局变量）。 */
function _hwSession() {
  try {
    const st = (typeof AppState !== 'undefined') ? AppState : null;
    const list = st ? st.sessions : (typeof sessions !== 'undefined' ? sessions : null);
    const sid = st ? st.currentSessionId : (typeof currentSessionId !== 'undefined' ? currentSessionId : '');
    if (!Array.isArray(list)) return null;
    return list.find(s => s && s.id === sid) || null;
  } catch (e) { return null; }
}

/** 挂载（幂等）。宿主：`#headerStatusZone`；找不到就退回 `#headerTitle` 的父节点。 */
function headerIslandMount() {
  if (typeof document === 'undefined') return null;
  const exist = document.getElementById(HW_ISLAND_ID);
  if (exist && exist.isConnected) return exist;
  const host = document.querySelector('#headerStatusZone') ||
    (document.getElementById('headerTitle') || {}).parentElement || null;
  if (!host) return null;
  const el = document.createElement('div');
  el.id = HW_ISLAND_ID;
  el.className = 'hw-island';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<span class="hw-dot" aria-hidden="true"></span>' +
    '<span class="hw-title"></span>' +
    '<span class="hw-sep" aria-hidden="true">·</span>' +
    '<span class="hw-phase"></span>' +
    '<span class="hw-sep hw-sep-odo" aria-hidden="true">·</span>' +
    '<span class="hw-odo" title="本轮工具步数 / 估算 token"></span>';
  host.appendChild(el);
  headerIslandRefresh();
  return el;
}

/** 数值变化时滚一次（只在真变化时加类，220ms 后摘掉）。 */
function _hwRoll(el, text) {
  if (!el) return;
  const t = String(text == null ? '' : text);
  if (el.textContent === t) return false;
  el.textContent = t;
  el.classList.remove('roll');
  // 强制重排，保证连续两次变化都能重新触发动画
  void el.offsetWidth;
  el.classList.add('roll');
  setTimeout(() => { try { el.classList.remove('roll'); } catch (e) {} }, 240);
  return true;
}

/** 刷新一次（幂等；由 mount、run 事件与副屏共用）。 */
function headerIslandRefresh() {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(HW_ISLAND_ID);
  if (!el) return null;
  const s = _hwSession();
  const sid = s ? s.id : '';
  // 阶段：经动态索引取 planning/card.js 的探针（不产生静态边）
  let phase = 'idle';
  try {
    const pf = _hwFn('harnessPhaseNow');
    if (typeof pf === 'function') phase = pf();
  } catch (e) { phase = 'idle'; }
  // 轨迹步数：traceSnapshot(sid)
  let steps = 0;
  let fail = 0;
  try {
    const ts = _hwFn('traceSnapshot');
    if (typeof ts === 'function') {
      const snap = ts(sid);
      steps = snap && snap.total ? snap.total : 0;
      fail = snap && snap.fail ? snap.fail : 0;
    }
  } catch (e) { /* 取不到就是 0，不编造 */ }
  // 估算 token：与副屏同口径（字符数 / 1.8），取整到百位做里程表
  let chars = 0;
  const msgs = s && Array.isArray(s.messages) ? s.messages : [];
  for (let i = 0; i < msgs.length; i++) {
    const c = msgs[i] && msgs[i].content;
    if (typeof c === 'string') chars += c.length;
  }
  const tokens = Math.ceil(chars / 1.8);
  // busy 取「DOM 属性 或 流式状态」的并集：
  // 原实现只看 AppState.isStreaming，导致 headerIslandSetBusy(true) 刚设的形态
  // 被紧接的 refresh() 立刻覆盖回 idle（探针实测 expanded=false）。
  const busy = (el.getAttribute('data-busy') === '1') ||
    !!(typeof AppState !== 'undefined' && AppState.isStreaming);

  const titleEl = el.querySelector('.hw-title');
  const phaseEl = el.querySelector('.hw-phase');
  const odoEl = el.querySelector('.hw-odo');
  if (titleEl) titleEl.textContent = s ? (s.title || '未命名会话') : '无会话';
  if (phaseEl) phaseEl.textContent = busy ? '执行中' : (phase === 'plan' ? '待批准' : '就绪');
  if (odoEl) {
    // 零态隐 '0'：没有任何工具步数时不显示 "0 步"
    const parts = [];
    if (steps > 0) parts.push(steps + ' 步' + (fail ? '（失败 ' + fail + '）' : ''));
    if (tokens > 0) parts.push('约 ' + tokens.toLocaleString() + ' tokens');
    _hwRoll(odoEl, parts.length ? parts.join(' · ') : '');
  }
  el.setAttribute('data-busy', busy ? '1' : '0');
  el.setAttribute('data-fail', fail > 0 ? '1' : '0');
  // 零态：标题与里程表都空时整体收成小圆点（不占一条空白）
  el.setAttribute('data-empty', (!s && !steps && !tokens) ? '1' : '0');
  return { title: titleEl ? titleEl.textContent : '', phase: busy ? 'busy' : phase, steps: steps, tokens: tokens };
}

/** 由 run 生命周期调用：开始/结束切形态。 */
function headerIslandSetBusy(on) {
  const el = (typeof document !== 'undefined') ? document.getElementById(HW_ISLAND_ID) : null;
  if (!el) return;
  el.setAttribute('data-busy', on ? '1' : '0');
  headerIslandRefresh();
}
