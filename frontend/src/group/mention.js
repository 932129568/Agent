/* ================= 群聊 @ 选择器（Round 15，2026-11-04 主理人立项） =================
 * 报障原文：「随着聊天轮次的变多，我想要@他们就变难了，得加一个打出@会弹出来
 * 选择的这个」。
 *
 * 行为：
 * - 群聊会话里在输入框打 `@`（或 `@已输入的前缀`）→ 光标下方浮出候选列表；
 *   随输入过滤；↑↓ 选择、Enter/Tab 采纳、Esc 关闭；采纳后补一个空格。
 * - 列表含全部成员 + 群主（@群主 = 把问题交回人类），成员按名册顺序。
 * - 非群聊会话完全不介入（零行为差异）。
 *
 * 实现要点：
 * - keydown 走 **capture** 阶段注册：bootstrap.js 的 Enter→sendMessage 在冒泡
 *   阶段，选择器打开时必须先吃掉 Enter，否则一按回车就把半截 @ 发出去。
 * - 点击列表项用 mousedown（而非 click）：blur 会先关面板，click 永远到不了。 */

const _mention = { el: null, items: [], idx: 0, start: -1, bound: false };

function groupMentionMembers() {
  const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  const s = (typeof groupSessionOf === 'function') ? groupSessionOf(sid) : null;
  if (!s || !s.group) return null;
  const list = (s.group.members || []).map(m => ({
    id: m.id, name: m.name, host: !!m.host,
    model: (function () {   // '端点::模型' 展示成 端点名·模型
      const v = String(m.model || '');
      const i = v.indexOf('::');
      return i < 0 ? v : v.slice(i + 2) + ' @' + v.slice(0, i);
    })(),
  }));
  list.unshift({ id: '__all__', name: '所有人', host: false, all: true });
  list.push({ id: '__owner__', name: '群主', host: false, owner: true });
  return list;
}

/** 光标前是否是 `@前缀`：返回 {start, query} 或 null。 */
function groupMentionQuery(ta) {
  const pos = (ta.selectionStart == null) ? String(ta.value || '').length : ta.selectionStart;
  if (pos !== (ta.selectionEnd == null ? pos : ta.selectionEnd)) return null;   // 有选区不弹
  const before = String(ta.value || '').slice(0, pos);
  const m = /(^|[\s，,。；;：:（(「【])@([^\s@]{0,12})$/.exec(before);
  if (!m) return null;          // 邮箱/URL 里的 @ 不弹（前面必须是空白或标点）
  const query = m[2];
  if (query.indexOf('.') >= 0) return null;   // a@b.com 的尾巴
  return { start: pos - m[0].length + m[1].length, query: query };
}

function groupMentionHide() {
  if (_mention.el && _mention.el.parentNode) _mention.el.parentNode.removeChild(_mention.el);
  _mention.el = null;
  _mention.items = [];
  _mention.idx = 0;
  _mention.start = -1;
}

function groupMentionShow(ta, hits) {
  if (!hits.length) { groupMentionHide(); return; }
  if (!_mention.el) {
    const box = document.createElement('div');
    box.id = 'mentionPicker';
    box.className = 'mention-picker';
    if (box.setAttribute) box.setAttribute('role', 'listbox');
    document.body.appendChild(box);
    _mention.el = box;
  }
  const box = _mention.el;
  const hueOf = (typeof groupHueOf === 'function') ? groupHueOf : function () { return 210; };
  box.innerHTML = hits.map((m, i) =>
    '<div class="mp-item' + (i === 0 ? ' on' : '') + '" data-i="' + i + '" role="option">' +
      '<span class="mp-ava' + (m.owner ? ' owner' : '') + '" style="' +
        (m.owner ? '' : '--mh:' + hueOf(m)) + '">' +
        (m.host ? '★' : (m.owner ? '群' : (m.all ? '∀' : String(m.name || '?').slice(0, 1)))) + '</span>' +
      '<span class="mp-main"><span class="mp-name"></span>' +
        (hits[i].model ? '<span class="mp-model"></span>' : '') + '</span>' +
      (m.host ? '<span class="mp-tag">主持人</span>' :
        (m.owner ? '<span class="mp-tag">交回人类</span>' :
         (m.all ? '<span class="mp-tag">全员点名</span>' : ''))) +
    '</div>').join('');
  box.querySelectorAll('.mp-name').forEach((el, i) => { el.textContent = hits[i].name; });
  box.querySelectorAll('.mp-model').forEach((el, i) => { el.textContent = hits[i].model; });
  box.querySelectorAll('.mp-item').forEach(el => {
    const pick = (ev) => { ev.preventDefault(); groupMentionAccept(ta, hits[Number(el.getAttribute('data-i'))]); };
    el.addEventListener('mousedown', pick);
  });
  _mention.items = hits;
  _mention.idx = 0;
  // 定位：输入框上方（贴近光标所在行，避免遮住正在输入的内容）
  const r = (ta.getBoundingClientRect && ta.getBoundingClientRect()) ||
    { left: 0, top: 0, bottom: 0, width: 320 };
  if (box.style) {
  box.style.left = Math.round(r.left) + 'px';
  box.style.minWidth = Math.round(Math.min(r.width, 320)) + 'px';
  const below = r.bottom + 6;
  const est = 44 + hits.length * 40;
  box.style.top = (below + est > window.innerHeight ? Math.max(8, r.top - est - 6) : below) + 'px';
  }
}

function groupMentionMove(delta) {
  if (!_mention.el || !_mention.items.length) return;
  const n = _mention.items.length;
  _mention.idx = ((_mention.idx + delta) % n + n) % n;
  _mention.el.querySelectorAll('.mp-item').forEach((el, i) => {
    el.classList.toggle('on', i === _mention.idx);
  });
}

function groupMentionAccept(ta, item) {
  if (!item || _mention.start < 0) { groupMentionHide(); return; }
  const value = String(ta.value || '');
  const pos = (ta.selectionStart == null) ? value.length : ta.selectionStart;
  const next = value.slice(0, _mention.start) + '@' + item.name + ' ' + value.slice(pos);
  ta.value = next;
  const caret = _mention.start + item.name.length + 2;
  try { ta.setSelectionRange(caret, caret); } catch (e) {}
  groupMentionHide();
  try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
  if (ta.focus) ta.focus();
}

function groupMentionRefresh(ta) {
  const q = groupMentionQuery(ta);
  if (!q) { groupMentionHide(); return; }
  const all = groupMentionMembers();
  if (!all) { groupMentionHide(); return; }     // 非群聊会话：不介入
  const needle = q.query.trim();
  const lower = needle.toLowerCase();
  const hits = all
    .filter(m => !lower || m.name.toLowerCase().indexOf(lower) >= 0)
    .sort((a, b) => {   // 前缀命中优先于中间命中（输入「U」时 UI设计 在前）
      const pa = a.name.toLowerCase().indexOf(lower) === 0 ? 0 : 1;
      const pb = b.name.toLowerCase().indexOf(lower) === 0 ? 0 : 1;
      return pa - pb;
    });
  if (!hits.length) { groupMentionHide(); return; }
  _mention.start = q.start;
  groupMentionShow(ta, hits);
}

/** 幂等绑定（群聊会话渲染时调用一次；非群聊会话零副作用）。 */
function groupMentionBind() {
  if (_mention.bound) return;
  const ta = document.getElementById('userInput');
  if (!ta) return;
  _mention.bound = true;
  ta.addEventListener('input', () => groupMentionRefresh(ta));
  ta.addEventListener('click', () => groupMentionRefresh(ta));
  ta.addEventListener('blur', () => setTimeout(groupMentionHide, 120));
  // capture：必须先于 bootstrap.js 的 Enter→sendMessage（冒泡阶段）
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!_mention.el || !_mention.items.length) {
      if (e.key === '@') setTimeout(() => groupMentionRefresh(ta), 0);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); groupMentionMove(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); groupMentionMove(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      groupMentionAccept(ta, _mention.items[_mention.idx]);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); groupMentionHide(); }
  }, true);
}

/** 从一段群主输入里取出全部被 @ 的成员（去重、保持出现顺序）。 */
const GROUP_ALL_RE = /^(所有人|全体|全员|大家|everyone|all)$/i;

function groupMentionTargets(text, s) {
  const g = (s && s.group) || {};
  const members = (g.members || []).map((m, i) => Object.assign({ id: 'gm' + i }, m));
  const out = [];
  // 注意：不能把 ？;: 之类收进排除集却漏掉全角逗号——否则「@测试 先看…，再让
  // @UI设计」里第一段会吞掉后续文字。这里按「@ + 非空白符号串」取，再用成员名
  // 前缀匹配，名字里本就不含空白。
  // 用「@ + 最长可匹配成员名前缀」而不是切词：名字后直接跟中文标点也能认出来
  const names = members.filter(m => m.name).sort((a, b) => b.name.length - a.name.length);
  const re = /@([^\s@]{1,24})/g;
  let mm;
  let allFlag = false;
  while ((mm = re.exec(String(text || '')))) {
    const rest = mm[1];
    if (GROUP_ALL_RE.test(rest)) { allFlag = true; continue; }   // @所有人 → 全员
    const hit = names.find(m => rest.indexOf(m.name) === 0);
    if (hit && !out.some(x => x.id === hit.id)) out.push(hit);
  }
  if (allFlag) return members.slice();   // 全员按名册顺序，显式点名让位
  return out;
}
