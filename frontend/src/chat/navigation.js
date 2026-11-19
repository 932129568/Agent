/* ================= v1.8.0 · 长对话导航（73-chat-nav.js） =================
 * 用户实测（WorkBuddy 同款）：长对话往上翻不便——输入区上方浮动把手展开
 * 「最近消息」浮层：点击跳转（smooth scroll + 目标高亮）、当前视口消息
 * 高亮指示、每条右侧「继续」钮把内容回填输入框。
 * 数据源从 DOM 收集（.message），不动 sessions 结构；AI 回复截断摘要。
 * 滚动跟踪用 rAF 节流 scroll 事件；fx-off 下功能保留、仅去入场动画。
 */

const CN_MAX_ITEMS = 12;          // 浮层最多条数（再多失去快速导航意义）
const CN_SUMMARY_LEN = 42;        // 摘要截断长度

function cnEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}

/** 收集最近消息（倒序——最新在上，与 WorkBuddy 一致）。 */
function cnCollect() {
  const box = cnEl('chatContainer');
  if (!box) return [];
  const msgs = [...box.querySelectorAll('.message')];
  return msgs.slice(-CN_MAX_ITEMS).reverse().map((el, i) => {
    const isUser = el.classList.contains('user');
    const c = el.querySelector('.content');
    let text = (c && c.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > CN_SUMMARY_LEN) text = text.slice(0, CN_SUMMARY_LEN) + '…';
    return { el, isUser, text, id: 'cn-' + (msgs.length - i) };
  });
}

/** 打开/关闭浮层（把手锚定在输入区上方）。 */
function cnToggle() {
  const pop = cnEl('cnPop');
  if (!pop) return;
  if (pop.classList.contains('on')) { cnClose(); return; }
  cnRender();
  pop.classList.add('on');
}
function cnClose() {
  const pop = cnEl('cnPop');
  if (pop) pop.classList.remove('on');
}

function cnRender() {
  const pop = cnEl('cnPop');
  const list = cnEl('cnList');
  if (!pop || !list) return;
  const items = cnCollect();
  if (!items.length) {
    list.innerHTML = '<div class="cn-empty">还没有消息，发起第一句对话吧</div>';
    return;
  }
  list.innerHTML = items.map(it =>
    '<div class="cn-row" data-id="' + it.id + '" role="button" tabindex="0" title="跳转到该消息">' +
      '<span class="cn-who ' + (it.isUser ? 'user' : 'ai') + '">' + (it.isUser ? '我' : 'AI') + '</span>' +
      '<span class="cn-text">' + (typeof escapeHtml === 'function' ? escapeHtml(it.text) : it.text) + '</span>' +
      '<button type="button" class="cn-cont" title="把这条内容放回输入框">继续</button>' +
    '</div>').join('');
  list.querySelectorAll('.cn-row').forEach(row => {
    const go = () => {
      const it = items.find(x => x.id === row.getAttribute('data-id'));
      if (!it || !it.el) return;
      cnClose();
      it.el.scrollIntoView({ behavior: (typeof MOTION !== 'undefined' && MOTION.instant()) ? 'auto' : 'smooth', block: 'start' });
      // 目标高亮：一次性 outline flash（不依赖新增动画宿主）
      it.el.classList.remove('cn-flash');
      void it.el.offsetWidth;   // reflow 重触发
      it.el.classList.add('cn-flash');
      setTimeout(() => it.el && it.el.classList.remove('cn-flash'), 1600);
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.cn-cont')) return;   // 继续钮单独处理
      go();
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const cont = row.querySelector('.cn-cont');
    if (cont) cont.addEventListener('click', (e) => {
      e.stopPropagation();
      const it = items.find(x => x.id === row.getAttribute('data-id'));
      if (!it) return;
      const input = cnEl('userInput');
      if (input) {
        input.value = it.isUser ? (it.el.querySelector('.content') || {}).textContent || '' : '';
        input.focus();
        if (typeof updateCostEstimate === 'function') updateCostEstimate();
      }
      cnClose();
    });
  });
  cnMarkCurrent();
}

/** 当前视口消息高亮（scroll rAF 节流；视口顶部第一条）。 */
function cnMarkCurrent() {
  const box = cnEl('chatContainer');
  const list = cnEl('cnList');
  if (!box || !list) return;
  const rows = [...list.querySelectorAll('.cn-row')];
  if (!rows.length) return;
  const items = cnCollect();
  const top = box.getBoundingClientRect().top + 8;
  let cur = null;
  for (const it of items) {
    const r = it.el.getBoundingClientRect();
    if (r.bottom >= top) { cur = it; break; }
  }
  rows.forEach(row => {
    const on = cur && row.getAttribute('data-id') === cur.id;
    row.classList.toggle('cur', !!on);
  });
}

/** 初始化：注入把手+浮层 DOM + scroll 跟踪 + 离开底部时才显把手。 */
function chatNavInit() {
  if (typeof document === 'undefined') return false;
  if (cnEl('cnHandle')) return true;
  const inputArea = document.querySelector('.input-area');
  const box = cnEl('chatContainer');
  if (!inputArea || !box) return false;
  // 把手（输入区右上角小细把手）+ 浮层
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.id = 'cnHandle';
  handle.className = 'cn-handle';
  handle.title = '最近消息（快速跳转）';
  handle.innerHTML = '<span class="cn-grip"></span>';
  handle.addEventListener('click', cnToggle);
  inputArea.style.position = 'relative';
  inputArea.appendChild(handle);
  const pop = document.createElement('div');
  pop.id = 'cnPop';
  pop.className = 'cn-pop';
  pop.innerHTML = '<div class="cn-pop-head">最近消息</div><div class="cn-list" id="cnList"></div>';
  inputArea.appendChild(pop);
  // 空白处点击关闭
  document.addEventListener('click', (e) => {
    const popEl = cnEl('cnPop');
    if (!popEl || !popEl.classList.contains('on')) return;
    if (e.target.closest && (e.target.closest('#cnPop') || e.target.closest('#cnHandle'))) return;
    cnClose();
  });
  // scroll 跟踪（rAF 节流；浮层开着时实时更新高亮，关着时也跑——开销可忽略）
  let ticking = false;
  box.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; cnMarkCurrent(); });
  }, { passive: true });
  return true;
}
