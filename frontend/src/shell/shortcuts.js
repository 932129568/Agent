/* ================= v1.8.0 · 快捷键与命令帮助（72-shortcuts.js） =================
 * 入口：header 帮助钮（?）+ 键盘 ?（Shift+/，输入框聚焦时不触发）。
 * 内容：键盘快捷键 + 斜杠命令 + 流式控制，全部实接（非宣传文案）。
 * sc-* 纯新增类；浮层复用 v4 模态动效；Esc/点遮罩/× 三路关闭。
 */

const SC_SHORTCUTS = [
  { keys: ['Enter'], desc: '发送消息' },
  { keys: ['Shift', 'Enter'], desc: '输入框内换行' },
  { keys: ['Esc'], desc: '关闭浮层（设置 / 搜索面板 / 模态 / 图片查看）' },
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
  document.addEventListener('keydown', scEsc);
  // 修复（建议14 残余）：60ms 硬编码 focus 延时改 MOTION 令牌（staggerSm=60ms，
  // 值与原一致；fx-off 下 0ms）。typeof 守卫保 vm 沙箱可测。
  const _scFocusMs = (typeof MOTION !== 'undefined' && MOTION.staggerSm) ? MOTION.staggerSm() : 60;
  setTimeout(() => { const b = card.querySelector('.sc-ok'); if (b) b.focus(); }, _scFocusMs);
}
function scEsc(e) {
  // 不 stopPropagation：Esc 应继续冒泡给其他浮层（设置/搜索面板/图片查看）各自收尾
  if (e.key === 'Escape') scClose();
}
function scClose() {
  const mask = document.querySelector('.sc-mask');
  if (mask) mask.remove();
  document.removeEventListener('keydown', scEsc);
}

/** ? 键打开（输入框/文本区聚焦时不抢键；与 Ctrl+N 不冲突）。 */
let _scBound = false;   // 幂等守卫：防 boot 重入/重复调用叠监听器（? 连开两个浮层）
function shortcutsInit() {
  if (typeof document === 'undefined') return false;
  if (_scBound) return true;   // 已接线：直接返回（同 63-search-panel __spWired 先例）
  _scBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    scOpen();
  });
  return true;
}
