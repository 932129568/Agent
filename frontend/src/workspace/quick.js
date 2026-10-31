/* ================= v4 工作区快捷条（对话框旁直管文件夹） =================
 * 背景：文件夹设置原埋在「更多设置/工作区面板」，每对话要单独点开修改（用户痛点）。
 * 本模块把常用控件搬到输入区上方：当前文件夹一键可见、点开即切、本会话独立即改。
 *
 * 设计原则：单一事实源——快捷条是「遥控器」，全部委托既有处理函数
 * （80-utils.js 的 onWsSelect/onFolderEnabled/onIndToggle/browseWs/unbindSession），
 * 自身不复制工作区逻辑，行为与面板完全一致。
 *
 * 接口复用（无新增 js_api，全部既有）：
 *   get_ws_state(sid)          → {ws, bound, enabled, recent[]}
 *   get_effective_ws()         → {sid, ws, source, exists}
 *   list_recent_ws()           → [{path, name, ts}]
 *   set_ws_dir(path)           → 切全局目录
 *   set_session_ws(sid,path,enabled) → 切/绑本会话目录
 *   set_ws_enabled(sid,enabled)→ 工作区总开关
 *   get_session_ws(sid) / delete_session_ws(sid)
 *   pick_folder(sid)           → 系统目录选择器
 */
let _wsqOpen = false;

/** 输入区权限开关：只读写既有 #toolMode（config 单一事实源），不新增配置项。 */
function accessToggleSync() {
  const toggle = document.getElementById('accessToggle');
  const mode = document.getElementById('toolMode');
  if (!toggle || !mode) return;
  const full = mode.value === 'full';
  toggle.classList.toggle('on', full);
  toggle.setAttribute('aria-pressed', full ? 'true' : 'false');
  toggle.title = full
    ? '当前允许创建文件夹、写入文件和执行命令；点击收回为只读'
    : '当前为只读；点击允许创建文件夹、写入文件和执行命令';
}
function accessToggleToggle() {
  const mode = document.getElementById('toolMode');
  if (!mode) return;
  mode.value = mode.value === 'full' ? 'readonly' : 'full';
  try {
    if (typeof Event === 'function') mode.dispatchEvent(new Event('change', { bubbles: true }));
    else if (typeof mode.onchange === 'function') mode.onchange();
  } catch (e) {}
  accessToggleSync();
}
function accessToggleInit() {
  if (accessToggleInit._bound) return;
  accessToggleInit._bound = true;
  const toggle = document.getElementById('accessToggle');
  if (toggle && toggle.addEventListener) toggle.addEventListener('click', accessToggleToggle);
  accessToggleSync();
}

function wsQuickMenu() { return document.getElementById('wsqMenu'); }

/** 工作区面板分段：仅切换可视区域，不修改任何权限或工作区状态。 */
function wsSectionShow(section) {
  const name = section === 'guard' ? 'guard' : 'main';
  ['main', 'guard'].forEach(key => {
    const suffix = key === 'main' ? 'Main' : 'Guard';
    const panel = document.getElementById('wsSection' + suffix);
    const btn = document.getElementById('wsSection' + suffix + 'Btn');
    const active = key === name;
    if (panel) panel.hidden = !active;
    if (btn) {
      btn.classList.toggle('on', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  });
}

/** 权限 chip 是导航入口而非提权开关：跳转到真实下拉并交由用户修改。 */
function wsQuickOpenToolMode() {
  wsQuickClose();
  if (typeof switchPanel === 'function') switchPanel('workspace');
  wsSectionShow('main');
  setTimeout(() => {
    const mode = document.getElementById('toolMode');
    if (mode && mode.focus) mode.focus();
  }, 0);
}

function wsQuickToggle() {
  const menu = wsQuickMenu();
  if (!menu) return;
  if (_wsqOpen) { wsQuickClose(); return; }
  wsQuickRefresh();
  menu.classList.remove('hiding');
  void menu.offsetWidth;               // 重入场从头播放
  menu.classList.add('show');
  _wsqOpen = true;
}
async function wsQuickClose() {
  const menu = wsQuickMenu();
  _wsqOpen = false;
  if (!menu || !menu.classList.contains('show')) return;
  if (menu.classList.contains('hiding')) return;
  menu.classList.add('hiding');
  const done = () => {
    // 退场竞态守卫：动画期间若被重开（wsQuickToggle 移除 hiding + 加 show），
    // 不得把 show 一并剥掉（菜单会「开了却看不见」）
    if (!menu.classList.contains('hiding')) return;
    try { menu.classList.remove('show', 'hiding'); } catch (e) {}
  };
  if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
    MOTION.onAnimEnd(menu, 'animationend', MOTION.compOut()).then(done);
  } else { done(); }
}
/* 外部点击/ Esc 关闭（与自定义下拉一致的交互惯例） */
document.addEventListener('click', (e) => {
  if (!_wsqOpen) return;
  if (e.target && e.target.closest && e.target.closest('#wsQuick')) return;
  wsQuickClose();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _wsqOpen) wsQuickClose();
});

/** 刷新快捷条状态（boot / 任何工作区变化后调用）。 */
/* 修复 55（三轮）：刷新序号——并发/慢响应时旧结果不覆盖新状态（last-wins） */
let _wsqSeq = 0;
async function wsQuickRefresh() {
  const nameEl = document.getElementById('wsqName');
  if (!nameEl) return;
  const seq = ++_wsqSeq;
  let st = { ws: '', bound: false, enabled: true, recent: [] };
  try { st = Object.assign(st, JSON.parse(await callApi('get_ws_state', [currentSessionId])) || {}); } catch (e) {}
  if (seq !== _wsqSeq) return;   // 过期响应丢弃
  const on = !!st.enabled && !!st.ws;
  nameEl.textContent = on ? wsShort(st.ws, 3) : '未启用工作区';
  nameEl.title = on ? st.ws : '点此启用并选择工作区文件夹';
  /* 工具权限 chip（读设置里的 toolMode，单一事实源） */
  const chip = document.getElementById('wsqToolChip');
  const tm = document.getElementById('toolMode');
  if (chip && tm) {
    const modeText = tm.value === 'readonly' ? '只读' : tm.value === 'off' ? '纯聊天' : '完整';
    chip.textContent = modeText;
    chip.title = '工具权限：' + modeText + '。前往「工作区与权限」调整，下一回合生效';
  }
  /* 本会话独立勾选 */
  const indWrap = document.getElementById('wsqIndWrap');
  const ind = document.getElementById('wsqInd');
  if (indWrap) indWrap.style.display = st.enabled ? '' : 'none';
  if (ind) ind.checked = !!st.bound;
  /* 跟随全局 / 启用按钮 */
  const unbind = document.getElementById('wsqUnbind');
  const enable = document.getElementById('wsqEnable');
  if (unbind) unbind.style.display = st.bound ? '' : 'none';
  if (enable) enable.style.display = st.enabled ? 'none' : '';
  /* 生效信息行 */
  const effTag = document.getElementById('wsqEffTag');
  const effPath = document.getElementById('wsqEffPath');
  if (effTag && effPath) {
    try {
      const eff = JSON.parse(await callApi('get_effective_ws', []) || '{}');
      if (seq !== _wsqSeq) return;   // 修复（四轮）：第二个 await 后复检——期间切换工作区时旧响应不得覆写
      effTag.textContent = eff.source === 'session' ? '会话' : eff.source === 'global' ? '全局' : '未启用';
      effPath.textContent = eff.ws || '（未绑定）';
    } catch (e) {}
  }
  /* 文件夹列表：当前 + 最近 */
  const list = document.getElementById('wsqList');
  if (list) {
    list.innerHTML = '';
    const seen = new Set();
    const mk = (p, label, tag, isOn) => {
      const d = document.createElement('div');
      d.className = 'wsq-opt' + (isOn ? ' on' : '');
      d.innerHTML = '<span class="p"></span><span class="tag"></span>';
      d.children[0].textContent = label;
      d.children[1].textContent = tag || '';
      d.title = p;
      d.onclick = () => wsQuickPick(p);
      list.appendChild(d);
    };
    if (st.ws) { mk(st.ws, wsShort(st.ws, 3), '当前', true); seen.add(st.ws); }
    (st.recent || []).forEach(r => {
      if (r.path && !seen.has(r.path)) {
        mk(r.path, r.name || wsShort(r.path, 3), '最近'); seen.add(r.path);
      }
    });
    if (!list.children.length) {
      const empty = document.createElement('div');
      empty.className = 'wsq-opt';
      empty.style.cursor = 'default';
      empty.textContent = '暂无最近文件夹，点「浏览…」选择';
      list.appendChild(empty);
    }
  }
}

/** 选文件夹 → 委托 onWsSelect（面板同款逻辑：本会话独立/全局自动分流）。 */
async function wsQuickPick(p) {
  if (!p) return;
  const sel = document.getElementById('wsSel');
  if (sel) sel.value = p;               // 同步面板下拉（单一事实源）
  try { await onWsSelect(p); } finally { wsQuickRefresh(); }   // 委托异常也要刷新（防状态残留）
}
/** 本会话独立勾选 → 委托 onIndToggle。 */
async function wsQuickInd(on) {
  const wsInd = document.getElementById('wsInd');
  if (wsInd) wsInd.checked = on;        // 同步面板勾选
  try { await onIndToggle(on); } finally { wsQuickRefresh(); }
}
/** 启用工作区（未启用态显示）→ 委托 onFolderEnabled。 */
async function wsQuickEnable() {
  const wsEnabled = document.getElementById('wsEnabled');
  if (wsEnabled) wsEnabled.checked = true;
  try { await onFolderEnabled(true); } finally { wsQuickRefresh(); }
}
/** 浏览… → 委托 browseWs（面板同款系统选择器）。 */
async function wsQuickBrowse() {
  try { await browseWs(); } finally { wsQuickRefresh(); }
}
/** 跟随全局 → 委托 unbindSession。 */
async function wsQuickUnbind() {
  try { await unbindSession(); } finally { wsQuickRefresh(); }
}
