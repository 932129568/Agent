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
const SET_GROUP_ORDER = ['模型与端点', '对话与生成', '工具与软件', '数据与历史', '安全与授权', '系统'];
const SET_GROUP_MAP = {
  '连接与模型': '模型与端点', '混合路由': '模型与端点',
  '省 Token 策略': '对话与生成', '生成参数': '对话与生成', '角色与联网': '对话与生成',
  '外部软件': '工具与软件', 'MCP 服务器': '工具与软件', '命令沙箱': '工具与软件',
  '数据同步 · WebDAV': '数据与历史', '任务历史与回滚': '数据与历史', '记忆': '数据与历史',
  '任务授权与白名单': '安全与授权',
  '软件更新': '系统', '外观与特效': '系统', '免打扰': '系统'
};
function _groupOf(blk, title) {
  const g = blk.dataset && blk.dataset.group;
  if (g) return g;
  const t = title.replace(/\s+/g, ' ').trim();
  if (SET_GROUP_MAP[t]) return SET_GROUP_MAP[t];
  for (const k of Object.keys(SET_GROUP_MAP)) { if (t.indexOf(k) >= 0) return SET_GROUP_MAP[k]; }
  if (/授权|白名单/.test(t)) return '安全与授权';
  if (/Token|参数|角色|联网/.test(t)) return '对话与生成';
  if (/软件|MCP|沙箱/.test(t)) return '工具与软件';
  if (/同步|历史|记忆|数据/.test(t)) return '数据与历史';
  return '系统';
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
    btn.onclick = () => _showSetBlock(blk.id);
    nav.appendChild(btn);
    });
  });
  // 首次构建（或动态块刚到）：无激活项时默认激活第一项
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
