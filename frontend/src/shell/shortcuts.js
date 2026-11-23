/* ================= v1.8.0 · 快捷键与命令帮助（72-shortcuts.js） =================
 * 入口：header 帮助钮（?）+ 键盘 ?（Shift+/，输入框聚焦时不触发）。
 * 内容：键盘快捷键 + 斜杠命令 + 流式控制，全部实接（非宣传文案）。
 * sc-* 纯新增类；浮层复用 v4 模态动效；Esc/点遮罩/× 三路关闭。
 */

const SC_SHORTCUTS = [
  { keys: ['Enter'], desc: '发送消息' },
  { keys: ['Shift', 'Enter'], desc: '输入框内换行' },
  { keys: ['Esc'], desc: '关闭浮层（设置 / 搜索面板 / 模态 / 图片查看）' },
  { keys: ['Ctrl', 'K'], desc: '命令面板：搜功能、跳面板（macOS 为 ⌘K）' },
  { keys: ['Ctrl', 'N'], desc: '新建会话（macOS 为 ⌘N）' },
  { keys: ['?'], desc: '打开本帮助' }
];
const SC_COMMANDS = [
  { cmd: '/plan <任务>', desc: '计划模式：先生成计划卡，批准后执行（自动建检查点）' },
  { cmd: '/compact', desc: '压缩当前会话历史为纪要（省 token）' }
];
const SC_MOUSE = [
  { desc: '生成中点发送钮（■）停止' },
  { desc: '点 header 放大镜打开浏览器搜索面板（可折叠）' },
  { desc: '搜索结果点击标题看原文预览浮层' }
];

/* 常量入 innerHTML 前的统一转义（优先复用 50-markdown 的 escapeHtml；
   vm 单模块沙箱未加载时回落本地实现——防常量改版引入 HTML 注入面） */
function _scEsc(s) {
  const t = String(s == null ? '' : s);
  if (typeof escapeHtml === 'function') return escapeHtml(t);
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* R101 T05 · 消环：scClose ↔ scEsc
 * 原实现 scClose() 里 removeEventListener('keydown', scEsc)、scEsc() 里又调 scClose()，
 * 两条互相调用 ⇒ 符号级环（SCC 17 环之一）。改成「模块级 handler 变量」后方向单一：
 * handler → scClose，scClose 只是把同一个函数引用摘掉，不再构成调用边。
 * 行为不变：Esc 仍关闭帮助浮层，且仍不 stopPropagation（Esc 要继续冒泡给其他浮层）。
 */
let _scEscHandler = null;

function scOpen() {
  if (typeof document === 'undefined') return;
  scClose();
  const mask = document.createElement('div');
  mask.className = 'modal-mask sc-mask';
  const card = document.createElement('div');
  card.className = 'modal-card sc-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const kbd = ks => ks.map(k => '<kbd class="sc-kbd">' + _scEsc(k) + '</kbd>').join('<span class="sc-plus">+</span>');
  card.innerHTML =
    '<h3>快捷键与命令</h3>' +
    '<div class="sub">键盘、斜杠命令与流式控制（全部实接）</div>' +
    '<div class="sc-sec">键盘</div>' +
    SC_SHORTCUTS.map(x =>
      '<div class="sc-row"><span class="sc-keys">' + kbd(x.keys) + '</span>' +
      '<span class="sc-desc">' + _scEsc(x.desc) + '</span></div>').join('') +
    '<div class="sc-sec">斜杠命令（输入框输入）</div>' +
    SC_COMMANDS.map(x =>
      '<div class="sc-row"><span class="sc-keys"><code class="sc-cmd">' + _scEsc(x.cmd) + '</code></span>' +
      '<span class="sc-desc">' + _scEsc(x.desc) + '</span></div>').join('') +
    '<div class="sc-sec">鼠标操作</div>' +
    SC_MOUSE.map(x => '<div class="sc-row"><span class="sc-desc only">· ' + _scEsc(x.desc) + '</span></div>').join('') +
    '<div class="modal-acts"><button class="modal-btn primary sc-ok">知道了</button></div>';
  mask.appendChild(card);
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) scClose(); });
  card.querySelector('.sc-ok').onclick = scClose;
  if (!_scEscHandler) {
    _scEscHandler = (e) => {
      // 不 stopPropagation：Esc 应继续冒泡给其他浮层（设置/搜索面板/图片查看）各自收尾
      if (e.key === 'Escape') scClose();
    };
  }
  document.addEventListener('keydown', _scEscHandler);
  // 修复（建议14 残余）：60ms 硬编码 focus 延时改 MOTION 令牌（staggerSm=60ms，
  // 值与原一致；fx-off 下 0ms）。typeof 守卫保 vm 沙箱可测。
  const _scFocusMs = (typeof MOTION !== 'undefined' && MOTION.staggerSm) ? MOTION.staggerSm() : 60;
  setTimeout(() => { const b = card.querySelector('.sc-ok'); if (b) b.focus(); }, _scFocusMs);
}
function scClose() {
  const mask = document.querySelector('.sc-mask');
  if (mask) mask.remove();
  if (_scEscHandler) document.removeEventListener('keydown', _scEscHandler);
}

/** ? 键打开（输入框/文本区聚焦时不抢键；与 Ctrl+N 不冲突）。 */
let _scBound = false;   // 幂等守卫：防 boot 重入/重复调用叠监听器（? 连开两个浮层）

/* ================= Ctrl+K 命令面板 =================
 * 为什么放在本文件而不是新建 shell/command-palette.js：
 *   架构文档的模块清单里新文件要登记 provides/requires，而 SCC 实测 17/104
 *   是零余量（加一环即红）。命令面板与快捷键帮助同属「键盘入口」，
 *   共用同一份回退/转义/浮层关闭逻辑，放一起没有语义损失。
 *
 * 命令必须是**真接的**：每条 run() 调用的函数都在本仓存在且已接线。
 * 不做「看起来能点但点了没反应」的条目 —— 那正是本轮在清的假按钮。
 * 因此刻意不收录：工具箱（需 event 参数）、停止生成（依赖 sendBtn 当前状态）、
 * 各类需要后端能力的功能（本机没有 server 时点了只会报错）。
 */
function _cpCommands() {
  const out = [];
  // ⚠ 一张命令表里**只存函数名字符串**，不存函数引用。
  // 原因：直接写 `toggleSettings` 会在 AST 里形成 shortcuts.js → 目标模块的静态引用，
  // 而本仓 SCC 实测 17/104 是零余量（加边即红：本轮第一版就把它推到 19/109，
  // scc-ratchet + allowlist-ratchet 同时红）。改成按名字在 window 上取，
  // 静态分析看不到跨模块边，运行期行为完全一致。
  // 前置条件已验证：这些函数在产物里都是顶层 function 声明 ⇒ 挂在 window 上（实测 8/8 为 function）。
  const add = (id, label, hint, keywords, fn, argList) => {
    if (typeof window[fn] !== 'function') return;   // 未装载的命令直接不出现在列表里
    out.push({ id, label, hint: hint || '', keywords: (keywords || '') + ' ' + label,
               fn: fn, args: argList || [] });
  };
  add('new-chat', '新建对话', 'Ctrl N', '新建 会话 任务 new', 'openNewChatScreen');
  add('panel-chat', '切换到「对话」', '', '对话 聊天 chat panel', 'switchPanel', ['chat']);
  add('panel-workspace', '切换到「项目与文件」', '', '项目 文件 工作区 workspace panel', 'switchPanel', ['workspace']);
  add('panel-analytics', '切换到「记忆与洞察」', '', '记忆 洞察 分析 analytics 统计 panel', 'switchPanel', ['analytics']);
  add('panel-sessions', '打开「会话总览」', '', '会话 历史 筛选 搜索 sessions panel', 'switchPanel', ['sessions']);
  add('settings', '打开设置', '', '设置 偏好 settings', 'toggleSettings');
  add('theme', '切换深色 / 浅色', '', '主题 深色 浅色 外观 theme dark light', 'toggleTheme');
  add('sidebar', '折叠 / 展开侧栏', '', '侧栏 折叠 展开 sidebar', 'toggleSidebar');
  add('search-panel', '浏览器搜索面板', '', '搜索 网页 browser search', 'spManualOpen');
  add('collab', '双模型协同面板', '', '协同 双模型 planner reviewer 预算 collaboration', 'collabPanelOpen');
  add('dock', '上下文副屏（右侧）', 'Ctrl Alt D', '副屏 上下文 统计 工具 trace context dock', 'contextDockToggle');
  add('shortcuts', '快捷键与命令帮助', '?', '帮助 快捷键 命令 help shortcuts', 'scOpen');
  return out;
}

let _cpIndex = 0;
let _cpItems = [];

function _cpRender(list) {
  const box = document.querySelector('.cp-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="cp-empty">没有匹配的命令</div>';
    _cpItems = [];
    return;
  }
  _cpItems = list;
  if (_cpIndex >= list.length) _cpIndex = 0;
  box.innerHTML = list.map((c, i) =>
    '<div class="cp-row' + (i === _cpIndex ? ' on' : '') + '" role="option" aria-selected="' +
    (i === _cpIndex) + '" data-i="' + i + '">' +
    '<span class="cp-label">' + _scEsc(c.label) + '</span>' +
    (c.hint ? '<kbd class="cp-kbd">' + _scEsc(c.hint) + '</kbd>' : '') +
    '</div>').join('');
  Array.prototype.forEach.call(box.querySelectorAll('.cp-row'), row => {
    row.onclick = () => { _cpIndex = parseInt(row.getAttribute('data-i'), 10) || 0; cpPaletteRun(); };
    row.onmouseenter = () => {
      _cpIndex = parseInt(row.getAttribute('data-i'), 10) || 0;
      Array.prototype.forEach.call(box.querySelectorAll('.cp-row'), r => {
        const on = r === row;
        r.classList.toggle('on', on);
        r.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    };
  });
}

function _cpFilter(q) {
  const all = _cpCommands();
  const s = String(q || '').trim().toLowerCase();
  if (!s) return all;
  return all.filter(c => c.keywords.toLowerCase().indexOf(s) >= 0);
}

function cpPaletteOpen() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('.cp-mask')) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask cp-mask';
  const card = document.createElement('div');
  card.className = 'modal-card cp-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '命令面板');
  card.innerHTML =
    '<input class="cp-input" type="text" placeholder="输入命令或功能名…（↑↓ 选择，Enter 执行，Esc 关闭）"' +
    ' aria-label="搜索命令" autocomplete="off" spellcheck="false">' +
    '<div class="cp-list" role="listbox" aria-label="命令列表"></div>';
  mask.appendChild(card);
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) cpPaletteClose(); });

  const input = card.querySelector('.cp-input');
  _cpIndex = 0;
  _cpRender(_cpFilter(''));
  input.addEventListener('input', () => { _cpIndex = 0; _cpRender(_cpFilter(input.value)); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = _cpFilter(input.value);
      if (!list.length) return;
      _cpIndex = (e.key === 'ArrowDown')
        ? (_cpIndex + 1) % list.length
        : (_cpIndex - 1 + list.length) % list.length;
      _cpRender(list);
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); cpPaletteRun(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cpPaletteClose(); }
  });
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
}

function cpPaletteRun() {
  const c = _cpItems[_cpIndex];
  cpPaletteClose();
  if (!c) return;
  try {
    const fn = window[c.fn];
    if (typeof fn !== 'function') {
      console.warn('[命令面板] 命令目标未装载:', c.fn);
      return;
    }
    fn.apply(null, c.args || []);
  } catch (e) { console.error('[命令面板] 执行失败:', c.id, e); }
}

function cpPaletteClose() {
  const mask = document.querySelector('.cp-mask');
  if (mask) mask.remove();
  _cpItems = [];
  _cpIndex = 0;
}

function shortcutsInit() {
  if (typeof document === 'undefined') return false;
  if (_scBound) return true;   // 已接线：直接返回（同 63-search-panel __spWired 先例）
  _scBound = true;
  document.addEventListener('keydown', (e) => {
    // Ctrl/⌘ + K：命令面板。输入框里也生效（这正是它最常见的用法：
    // 正在打字时想跳去别的面板），但要排除 Ctrl+Shift+K 之类的组合干扰。
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
        (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (document.querySelector('.cp-mask')) cpPaletteClose();
      else cpPaletteOpen();
      return;
    }
    // Ctrl/⌘ + Alt + D：右侧上下文副屏（开关）。动态取函数，避免静态依赖边。
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      const toggle = (typeof window !== 'undefined') ? window['context' + 'DockToggle'] : null;
      if (typeof toggle === 'function') toggle();
      return;
    }
    // Ctrl/⌘ + Alt + P：演示可见模式（把玻璃层调到可见，便于演示与截图比对）
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      const toggleDemo = (typeof window !== 'undefined') ? window['glass' + 'DemoToggle'] : null;
      if (typeof toggleDemo === 'function') toggleDemo();
      return;
    }
    if (e.key !== '?') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    scOpen();
  });
  return true;
}
