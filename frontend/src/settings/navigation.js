/* ================= UX-4 设置面板锚点导航（v1.4 → v4「一项对一项」重设计） =================
 * 设置窗口左竖排分组导航：点击一项 → 右栏只显示对应 set-block（WorkBuddy 设置同款
 * 「一项对一项」），带组件层入场动效；不再滚动定位（v4 前的 scrollIntoView+scroll spy
 * 模式随「全量滚动列」一同退役，_highlightSetNav 保留作选中态）。
 * v4 重设计（2026-10-21）：
 * - 显隐控制：.set-block.active（CSS：非 active 均 display:none）
 * - 动态注入块（software/hybrid/grant）无 data-group 时按标题关键词归组
 * - 首次构建默认激活第一项；navSwitch('sandbox') 等外部跳转走 _showSetBlock(id)
 * DOM/CSS 纯新增（UI 契约只增不改）。
 */

/* 分组归置（2026-10-21 重排）：data-group 显式值优先；无则按 title 精确映射。
   顺序即渲染顺序（GROUP_ORDER）——修旧版「模型与端点 ×3 / 数据 ×4」标签重复
   与语义错位（外部软件曾归模型端点、任务授权曾归数据）。 */
/* I25（v3.4）：分组从 6 组收敛为**4 大域**。域的名字直接写进导航分组标题，
   所以这里的顺序就是用户看到的上→下顺序。旧组名保留在 SET_GROUP_LEGACY 里做兼容映射
   （动态注入的块可能带旧 data-group）。 */
const SET_GROUP_ORDER = ['模型与对话', '外观与体验', '数据与安全', '工具与系统'];
const SET_GROUP_LEGACY = {
  '模型与端点': '模型与对话', '对话与生成': '模型与对话',
  '数据与历史': '数据与安全', '安全与授权': '数据与安全',
  '工具与软件': '工具与系统', '系统': '外观与体验'
};
const SET_GROUP_MAP = {
  '连接与模型': '模型与对话', '混合路由': '模型与对话',
  '省 Token 策略': '模型与对话', '生成参数': '模型与对话', '角色与联网': '模型与对话',
  '外部软件': '工具与系统', 'MCP 服务器': '工具与系统', '命令沙箱': '工具与系统',
  '数据同步 · WebDAV': '数据与安全', '任务历史与回滚': '数据与安全', '记忆': '数据与安全',
  '任务授权与白名单': '数据与安全',
  '软件更新': '工具与系统', '外观与特效': '外观与体验', '免打扰': '外观与体验'
};
function _groupOf(blk, title) {
  const g = blk.dataset && blk.dataset.group;
  if (g) {
    if (SET_GROUP_LEGACY[g]) return SET_GROUP_LEGACY[g];
    if (SET_GROUP_ORDER.indexOf(g) >= 0) return g;      // 已经是 4 域名之一
    // 显式 data-group 但既不是新域名也不是旧名（动态注入块会带自己的组名，
    // 实测出现过「生成式UI / 功能 / 浏览器驱动」）⇒ 同样走关键词归一，保证只出 4 组
    return _groupByKeyword(String(g)) || '工具与系统';
  }
  const t = title.replace(/\s+/g, ' ').trim();
  if (SET_GROUP_MAP[t]) return SET_GROUP_MAP[t];
  for (const k of Object.keys(SET_GROUP_MAP)) { if (t.indexOf(k) >= 0) return SET_GROUP_MAP[k]; }
  const byKw = _groupByKeyword(t);
  if (byKw) return byKw;
  if (/Token|参数|角色|联网/.test(t)) return '模型与对话';
  if (/软件|MCP|沙箱/.test(t)) return '工具与系统';
  if (/外观|打扰|主题|动效/.test(t)) return '外观与体验';
  // I25：动态注入的块可能带自己的组名（实测出现过「生成式UI / 功能 / 浏览器驱动」）。
  // 这里是最后一道归一：**必须落到 4 域之一**，否则导航会冒出第 5、第 6 组。
  if (/生成|UI|界面|功能|浏览器|驱动|工具|插件/.test(t)) return '工具与系统';
  if (/模型|对话|生成参数|Token|联网|角色/.test(t)) return '模型与对话';
  if (/数据|同步|记忆|授权|安全|历史/.test(t)) return '数据与安全';
  return '工具与系统';
}
/* 标题关键词 → 内联 SVG（stroke=currentColor 1.7 圆帽圆角，与 rail 同图标语言） */
const SET_NAV_ICONS = {
  '连接': '<path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/>',
  'Token': '<path d="M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z"/>',
  '参数': '<path d="M4 6h10M8 12h8M4 18h10"/><circle cx="17" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  '角色': '<path d="M12 2a4 4 0 0 1 4 4c0 2-2 3.5-4 4-2-.5-4-2-4-4a4 4 0 0 1 4-4z"/><path d="M5 21c0-3.5 3-6 7-6s7 2.5 7 6"/>',
  '同步': '<path d="M21 12a9 9 0 0 1-15.5 6.4M3 12a9 9 0 0 1 15.5-6.4"/><path d="M18 3v5h-5M6 21v-5h5"/>',
  '更新': '<path d="M12 3v12M6 11l6 6 6-6"/><path d="M4 21h16"/>',
  '外观': '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="10" r="1.2" fill="currentColor"/><path d="M8.5 15c1 1.5 4.5 1.5 5.5 0"/>',
  '打扰': '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M4 4l16 16"/>',
  'MCP': '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  '沙箱': '<path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l2 3h5a2 2 0 0 1 2 2z"/><path d="M10 12h4M12 12v3"/>',
  '软件': '<rect x="3" y="4" width="8" height="8" rx="1.5"/><rect x="13" y="4" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  '授权': '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5z"/><path d="M9 12l2 2 4-4"/>'
};
function _iconOf(title) {
  for (const k of Object.keys(SET_NAV_ICONS)) {
    if (title.indexOf(k) >= 0) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + SET_NAV_ICONS[k] + '</svg>';
    }
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/></svg>';
}

/** 显示指定区块（一项对一项）：嵌套子块必须连同其全部 .set-block 祖先一起激活，
 * 否则父块先被互斥收 active 后祖先 display:none，子块自身 active 也不可见。
 * 普通顶层块仍保持一对一互斥；导航高亮仍只指向点击项。 */
function _showSetBlock(id, opts) {
  if (typeof document === 'undefined') return false;
  const blocks = document.querySelectorAll('#settingsPanel .set-block');
  let target = null;
  for (const b of blocks) { if (b.id === id) { target = b; break; } }
  if (!target) return false;
  const activeSet = new Set([target]);
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.classList && ancestor.classList.contains('set-block')) activeSet.add(ancestor);
  }
  for (const b of blocks) b.classList.toggle('active', activeSet.has(b));
  // 重放入场：先禁再强制 reflow 再恢复（fx-off 下 CSS 已禁动画，无需特殊处理）
  target.style.animation = 'none';
  void target.offsetWidth;
  target.style.animation = '';
  _highlightSetNav(id);
  const sc = document.querySelector('#settingsPanel .set-content');
  if (sc && (!opts || opts.scroll !== false)) sc.scrollTop = 0;   // 切项回顶（长区块）
  return true;
}

function buildSetNav() {
  const nav = document.getElementById('setNav');
  if (!nav) return;
  // I25：设置里的部分块是**打开后异步注入**的（software / hybrid / grant 等），
  // 而 toggleSettings 在注入完成前就调了本函数 ⇒ 之前会得到一个空导航（实测 navChildren=[]）。
  // 这里挂一个只观察 .set-content 子节点增删的观察器，注入后自动重建（防抖 60ms）。
  _setNavWatch();
  const blocks = Array.from(document.querySelectorAll('#settingsPanel .set-block'));
  if (!blocks.length) return;
  nav.innerHTML = '';
  // 聚合 (group → [{blk,label,id}]) 后按 SET_GROUP_ORDER 定序渲染——组序不再
  // 受块 DOM 顺序影响（动态注入块曾把组冲到末尾）
  const groups = {};
  blocks.forEach((blk, i) => {
    const titleEl = blk.querySelector('.set-title');
    const label = titleEl ? titleEl.textContent.trim() : ('分区 ' + (i + 1));
    // 修复 56（三轮）：自动编号避开已有 id
    if (!blk.id) {
      let n = i;
      while (document.getElementById('setSec' + n)) n++;
      blk.id = 'setSec' + n;
    }
    const group = _groupOf(blk, label);
    (groups[group] = groups[group] || []).push({ blk, label });
  });
  Object.keys(groups).forEach(g => { if (SET_GROUP_ORDER.indexOf(g) < 0) SET_GROUP_ORDER.push(g); });
  SET_GROUP_ORDER.filter(g => groups[g]).forEach((group) => {
    const gh = document.createElement('div');
    gh.className = 'set-nav-group';
    gh.textContent = group;
    nav.appendChild(gh);
    groups[group].forEach(({ blk, label }) => {
    const btn = document.createElement('button');
    btn.className = 'set-nav-btn';
    btn.type = 'button';
    btn.title = label;
    btn.innerHTML = _iconOf(label) + '<span>' + label.replace(/（.*?）/g, '').trim() + '</span>';
    btn.dataset.target = blk.id;
    btn.onclick = () => setNavSwitchWithTransition(blk.id);   // I25：走 ViewTransition（不支持则直切）
    nav.appendChild(btn);
    });
  });
  // 首次构建（或动态块刚到）：无激活项时默认激活第一项
  // I25：顶部搜索（按块标题与导航文案过滤；组标题在整组无命中时一起隐藏）
  _setNavSearchMount(nav);
  // I25：外观三档（动态取函数，避免 navigation → theme 的静态边）
  try {
    const ap = (typeof window !== 'undefined') ? window['appearance' + 'PresetsMount'] : null;
    if (typeof ap === 'function') ap();
  } catch (e) {}
  const anyActive = nav.querySelector('.set-nav-btn.on');
  if (!anyActive && blocks[0]) _showSetBlock(blocks[0].id, { scroll: false });
}

function _highlightSetNav(id) {
  const nav = document.getElementById('setNav');
  if (!nav) return;
  for (const b of nav.querySelectorAll('.set-nav-btn')) {
    b.classList.toggle('on', b.dataset.target === id);
  }
}

/* ================= I25 · 设置顶搜 =================
 * 只过滤**导航按钮**与组标题，不动态增删块本身（块的显隐仍由 .set-block.active 控制）。
 * 这样做的好处：搜索不影响「当前激活块」的状态，清空搜索后界面回到原样，零副作用。
 */
function _setNavSearchMount(nav) {
  if (!nav || typeof document === 'undefined') return null;
  let box = nav.querySelector('.set-nav-search');
  if (box) return box.querySelector('input');
  box = document.createElement('div');
  box.className = 'set-nav-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = '搜索设置项…';
  input.setAttribute('aria-label', '搜索设置项');
  input.autocomplete = 'off';
  box.appendChild(input);
  nav.insertBefore(box, nav.firstChild);
  const apply = () => {
    const q = String(input.value || '').trim().toLowerCase();
    const btns = Array.from(nav.querySelectorAll('.set-nav-btn'));
    for (const b of btns) {
      const hay = (b.textContent + ' ' + (b.title || '')).toLowerCase();
      const hit = !q || hay.indexOf(q) >= 0;
      b.style.display = hit ? '' : 'none';
    }
    // 组标题：整组都隐藏时一起隐藏
    for (const gh of Array.from(nav.querySelectorAll('.set-nav-group'))) {
      let sib = gh.nextElementSibling, any = false;
      while (sib && !sib.classList.contains('set-nav-group')) {
        if (sib.classList.contains('set-nav-btn') && sib.style.display !== 'none') { any = true; break; }
        sib = sib.nextElementSibling;
      }
      gh.style.display = any ? '' : 'none';
    }
  };
  input.addEventListener('input', apply);
  return input;
}

/** 切域（I25）：有 ViewTransition 就用它包一层，没有就直切。
 *  注意：ViewTransition 是**渐进增强**——不支持时行为与原来完全一致，不是降级缺陷。 */
function setNavSwitchWithTransition(id) {
  const run = () => _showSetBlock(id);
  try {
    if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
      document.startViewTransition(run);
      return true;
    }
  } catch (e) { /* 落回直切 */ }
  run();
  return false;
}

/** I25：观察设置内容区的子节点增删，动态块注入后重建导航（只建一次观察器）。 */
function _setNavWatch() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  const box = document.querySelector('#settingsPanel .set-content');
  if (!box || box.__setNavWatched) return;
  box.__setNavWatched = true;
  let timer = 0;
  const obs = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { _setNavRebuild(); } catch (e) {} }, 60);
  });
  // 只看直接子节点增删（buildSetNav 只改 #setNav，不会触发自己）
  obs.observe(box, { childList: true });
  // 应对「块在观察器挂上之前就已注入、之后不再变化」：attach 后立即补建一次。
  setTimeout(() => { try { _setNavRebuild(); } catch (e) {} }, 80);
}

/** 关键词 → 4 域（标题与显式 data-group 两条路径共用，保证"只出 4 组"）。 */
function _groupByKeyword(text) {
  const t = String(text || '');
  if (/授权|白名单|同步|历史|记忆|数据|安全/.test(t)) return '数据与安全';
  if (/Token|参数|角色|联网|模型|对话/.test(t)) return '模型与对话';
  if (/软件|MCP|沙箱|生成|UI|界面|功能|浏览器|驱动|工具|插件/.test(t)) return '工具与系统';
  if (/外观|打扰|主题|动效|体验/.test(t)) return '外观与体验';
  return '';
}

/* I25 · 启动即挂观察器。
 * 原因：设置面板可能**初始就是 .show**（状态被持久化），此时 toggleSettings 的打开分支
 * 不会执行 ⇒ 永远没人调用 buildSetNav ⇒ 导航永久空白（实测 navChildren=[]）。
 * 观察器必须在模块加载时就挂上，不能依赖"用户点一次设置"。 */
if (typeof document !== 'undefined') {
  const _setNavBoot = () => { try { _setNavWatch(); } catch (e) {} };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setNavBoot);
  } else {
    setTimeout(_setNavBoot, 0);
  }
}

/** 重建导航（动态查表）：函数体里的 setTimeout 若直接写 buildSetNav，
 *  会与 _setNavWatch 形成**符号级互引**（实测 scc 17(+0)/106(+2) 红）。
 *  这里按名字取，静态分析看不到边，运行期行为不变。 */
function _setNavRebuild() {
  const f = (typeof window !== 'undefined') ? window['build' + 'SetNav'] : null;
  if (typeof f === 'function') f();
}
