/* ================= v1.6 T11 左侧主导航 + T13 通知中心 =================
 * 布局重构·直切（用户裁决②）：新导航为单一入口；原「设置」大按钮与
 * 33-set-nav 锚点 DOM 保留不删（契约红线），老入口行为不变（打开同一
 * 设置浮层）——肌肉记忆不断流。
 *
 * 五个分区（复用既有面板/浮层 DOM，不新建面板容器）：
 *   chat     对话面板（switchPanel 既有路由）
 *   settings 设置浮层（settingsPanel，toggleSettings 既有开关）
 *   audit    审计查看器（28-audit-viewer 既有 openAuditViewer）
 *   search   会话搜索（32-session-search 既有 openSessionSearch）
 *   sandbox  设置浮层 + 滚动定位沙箱区块（39-sandbox 既有控件）
 * 通知中心（T13）：DND 抑制的 toast 入列；红点数 + 弹层列表；聚焦清零。
 */

const NAV_ZONES = ['chat', 'settings', 'audit', 'search', 'sandbox'];
let navZone = 'chat';

/** HTML 转义（50-markdown 的 escapeHtml 在同脚本作用域；typeof 守卫保 vm 沙箱可测）。 */
function _navEsc(s) {
  const t = String(s == null ? '' : s);
  if (typeof escapeHtml === 'function') return escapeHtml(t);
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** 分区切换（导航唯一入口；onclick 直接绑 navSwitch('<zone>')）。 */
function navSwitch(zone) {
  if (NAV_ZONES.indexOf(zone) === -1) zone = 'chat';
  navZone = zone;
  navHighlight(zone);
  navHideNotify();
  if (zone === 'chat') {
    if (typeof switchPanel === 'function') switchPanel('chat');
    navUpdateEmptyGuide();   // 回对话面板时刷新空态引导（配 Key 后自动隐藏）
    return;
  }
  // 设置/审计/沙箱均以对话面板为承载（浮层/滚动），搜索是独立浮层
  if (typeof switchPanel === 'function') switchPanel('chat');
  if (zone === 'settings' || zone === 'sandbox') {
    const sp = document.getElementById('settingsPanel');
    if (sp && !sp.classList.contains('show') && typeof toggleSettings === 'function') toggleSettings();
    if (zone === 'sandbox') {
      // v4「一项对一项」：切到沙箱分区 = 激活沙箱区块（scrollIntoView 对
      // display:none 的隐藏块无效，必须走 _showSetBlock 显隐切换）
      setTimeout(() => {
        if (typeof _showSetBlock === 'function') _showSetBlock('sandboxBlock');
      }, 80);
    }
  } else if (zone === 'audit') {
    if (typeof openAuditViewer === 'function') openAuditViewer();
  } else if (zone === 'search') {
    if (typeof openSessionSearch === 'function') openSessionSearch();
  }
}

/** 导航高亮（只动新导航按钮，不动既有 rail-btn）。 */
function navHighlight(zone) {
  NAV_ZONES.forEach(z => {
    const btn = document.getElementById('navBtn' + z[0].toUpperCase() + z.slice(1));
    if (btn && btn.classList) btn.classList.toggle('on', z === zone);
  });
}

/** 首次启动引导（一次性 toast；localStorage 标记，不污染 config.json）。 */
function navFirstRunGuide() {
  let seen = false;
  try { seen = localStorage.getItem('glm_nav_guide_v18') === '1'; } catch (e) { /* 无存储环境直接展示 */ }
  if (seen) return;
  try { localStorage.setItem('glm_nav_guide_v18', '1'); } catch (e) {}
  if (typeof toast === 'function') {
    // Round 8 UI 重构后口径：单 rail + 工具箱二级菜单
    toast('左侧栏：对话 / 历史 / 工作区 / 专家；分析 · 审计 · 搜索 · 沙箱已收进「工具箱」🧰', 'ok', { stay: true });
  }
}

/** 空态三步引导：未配 Key 且当前会话为空 → 显示（选来源→填 Key→发问）。 */
function navUpdateEmptyGuide() {
  const guide = document.getElementById('emptyGuide');
  if (!guide || !guide.style) return;
  let hasKey = false;
  try { hasKey = !!(document.getElementById('apiKey') || {}).value; } catch (e) {}
  let empty = true;
  try {
    const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
    empty = !s || !s.messages || s.messages.length === 0;
  } catch (e) { empty = true; }
  guide.style.display = (!hasKey && empty) ? 'flex' : 'none';
}

function navGuidePickSource() {
  navSwitch('settings');
  setTimeout(() => {
    if (typeof _showSetBlock === 'function') _showSetBlock('cmBlock');
  }, 100);
}

function navGuideFillKey() {
  navSwitch('settings');
  setTimeout(() => {
    // v4「一项对一项」：先确保连接与模型块处于激活态（focus 对 display:none 元素无效）
    if (typeof _showSetBlock === 'function') _showSetBlock('cmBlock');
    const el = document.getElementById('providerPreset');
    if (el && el.focus) { try { el.focus(); } catch (e) {} }
  }, 100);
}

/** 会话头部状态区：当前模型由 headerTitle 展示，这里仅保留缓存与沙箱。 */
async function navRenderHeaderStatus() {
  const zone = document.getElementById('headerStatusZone');
  if (!zone) return;
  const hit = (typeof window.__hitRate === 'number') ? window.__hitRate : 0;
  let sbTxt = '沙箱未知', sbCls = 'warn';
  try {
    const st = JSON.parse(await callApi('sandbox_status', []) || '{}');
    if (st && st.available === false) { sbTxt = '沙箱不可用'; sbCls = 'off'; }
    else if (st && st.enabled) { sbTxt = '沙箱开'; sbCls = 'ok'; }
    else if (st) { sbTxt = '沙箱关'; sbCls = 'warn'; }
  } catch (e) { /* 后端不可用时保持未知态 */ }
  zone.innerHTML =
    '<span class="hs-chip" title="上轮缓存命中率">缓存 ' + hit + '%</span>' +
    '<span class="hs-chip" title="命令沙箱状态"><span class="hs-dot ' + sbCls + '"></span>' + sbTxt + '</span>';
}

/* ---- T13 通知中心 ---- */

/** 渲染通知中心（徽标 + 列表；数据 _notifyItems 由 18-toast 的 notifyPush 维护）。 */
function navRenderNotify() {
  const badges = [document.getElementById('navNotifyBadge'), document.getElementById('railNotifyBadge')];
  const list = document.getElementById('notifyList');
  const cnt = document.getElementById('notifyCount');
  const n = (typeof _notifyItems !== 'undefined') ? _notifyItems.length : 0;
  badges.forEach(badge => {
    if (badge) { badge.style.display = n ? '' : 'none'; badge.textContent = String(n); }
  });
  if (cnt) cnt.textContent = n ? (n + ' 条') : '';
  if (list) {
    if (!n) { list.innerHTML = '<div class="notify-empty">暂无通知</div>'; return; }
    list.innerHTML = _notifyItems.map(it =>
      '<div class="notify-item"><span class="nt-time">' + navNotifyTime(it.at) + '</span>' +
      _navEsc(it.msg || '') + '</div>').join('');
  }
}

function navNotifyTime(ts) {
  const d = new Date(ts || Date.now());
  const h = ('0' + d.getHours()).slice(-2), m = ('0' + d.getMinutes()).slice(-2);
  return h + ':' + m;
}

function navToggleNotify() {
  const pop = document.getElementById('notifyPop');
  const btn = document.getElementById('railNotifyBtn');
  if (!pop || !pop.style) return;
  const open = pop.style.display === 'none' || !pop.style.display;
  pop.style.display = open ? '' : 'none';
  if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    navClearNotifyBadge();
    const clear = document.getElementById('notifyClearBtn');
    if (clear && clear.focus) clear.focus();
  } else if (btn && btn.focus) btn.focus();
}

function navHideNotify() {
  const pop = document.getElementById('notifyPop');
  const btn = document.getElementById('railNotifyBtn');
  if (pop && pop.style) pop.style.display = 'none';
  if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('aria-expanded', 'false');
}

/* ---- Round 8 UI 重构：工具箱二级弹出菜单（分析/审计/会话搜索/沙箱收纳） ---- */

function toolsToggle(ev) {
  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  const pop = document.getElementById('toolsPop');
  const btn = document.getElementById('toolsBoxBtn');
  if (!pop || !pop.style) return;
  const open = pop.style.display === 'none' || !pop.style.display;
  navHideNotify();
  pop.style.display = open ? '' : 'none';
  if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const first = pop.querySelector('.mn-btn');
    if (first && first.focus) first.focus();
  } else if (btn && btn.focus) btn.focus();
}

function toolsHide() {
  const pop = document.getElementById('toolsPop');
  const btn = document.getElementById('toolsBoxBtn');
  if (pop && pop.style) pop.style.display = 'none';
  if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('aria-expanded', 'false');
}

/** 聚焦时红点清零（条目保留在列表里可回看；旧导航与 rail 同步）。 */
function navClearNotifyBadge() {
  ['navNotifyBadge', 'railNotifyBadge'].forEach(id => {
    const badge = document.getElementById(id);
    if (badge && badge.style) badge.style.display = 'none';
  });
}

function navClearNotify() {
  if (typeof _notifyItems !== 'undefined') _notifyItems = [];
  navRenderNotify();
}

/** 启动挂接（110-boot 调用）：引导 + 空态 + 头部状态区 + 通知中心。 */
function navInit() {
  navFirstRunGuide();
  navUpdateEmptyGuide();
  navRenderHeaderStatus();
  navRenderNotify();
  window.addEventListener('focus', () => navClearNotifyBadge());
  document.addEventListener('visibilitychange', () => {
    try { if (!document.hidden) navClearNotifyBadge(); } catch (e) {}
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    const pop = document.getElementById('notifyPop');
    if (pop && pop.style.display !== 'none') {
      navHideNotify();
      const btn = document.getElementById('railNotifyBtn');
      if (btn && btn.focus) btn.focus();
      return;
    }
    // Round 8：工具箱弹出层同语义收起
    const tp = document.getElementById('toolsPop');
    if (tp && tp.style.display !== 'none') {
      toolsHide();
      const tb = document.getElementById('toolsBoxBtn');
      if (tb && tb.focus) tb.focus();
    }
  });
  document.addEventListener('click', ev => {
    const pop = document.getElementById('notifyPop');
    if (pop && pop.style.display !== 'none') {
      if (!(ev.target && ev.target.closest && ev.target.closest('#notifyPop,#railNotifyBtn'))) navHideNotify();
    }
    const tp = document.getElementById('toolsPop');
    if (tp && tp.style.display !== 'none') {
      if (!(ev.target && ev.target.closest && ev.target.closest('#toolsPop,#toolsBoxBtn'))) toolsHide();
    }
  });
}
