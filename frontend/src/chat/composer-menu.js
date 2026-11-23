/* ================= v3.4 I22（后半）· 输入舱 @ 提及 与 / 命令菜单 =================
 * 目的：施工总册 I22「缺单聊 @ 与 / 命令菜单」。
 * 判据：全键盘零鼠标——输入 @ 或 / 即可弹出候选，↑↓ 选择、Enter 插入、Esc 收起。
 *
 * 三条约束：
 *  ① 菜单运行期创建，不往模板加 id/onclick；
 *  ② 数据源必须是真实可取的：@ = 当前会话列表（AppState.sessions）；/ = 内置命令表；
 *  ③ 不改变发送链路：插入的只是文本，发送仍走原路径。
 */

const CM_MAX_ITEMS = 8;

function _cmSessions() {
  try {
    const st = (typeof AppState !== 'undefined') ? AppState : null;
    const list = (st && Array.isArray(st.sessions)) ? st.sessions : [];
    const cur = st ? st.currentSessionId : '';
    return list.filter(s => s && s.id !== cur).slice(0, CM_MAX_ITEMS)
      .map(s => ({ kind: 'session', label: s.title || ('会话 ' + String(s.id).slice(0, 6)), value: '@' + (s.title || s.id) + ' ' }));
  } catch (e) { return []; }
}

function _cmCommands() {
  return [
    { kind: 'cmd', label: '/plan <任务>', value: '/plan ' },
    { kind: 'cmd', label: '/compact', value: '/compact' },
  ];
}

/** 由输入框当前内容与光标位置决定要不要弹菜单。 */
function composerMenuCandidates(text, caret) {
  const t = String(text == null ? '' : text);
  const pos = (typeof caret === 'number' && caret >= 0) ? caret : t.length;
  const head = t.slice(0, pos);
  // 行首 / ⇒ 命令
  if (/^\s*\/[\w-]*$/.test(head)) return { mode: 'cmd', items: _cmCommands() };
  // 词边界的 @ ⇒ 提及
  const m = /(^|[\s(（])@([^\s@]*)$/.exec(head);
  if (m) {
    const q = String(m[2] || '').toLowerCase();
    const items = _cmSessions().filter(it => !q || it.label.toLowerCase().indexOf(q) >= 0);
    return { mode: 'mention', items };
  }
  return { mode: '', items: [] };
}

function composerMenuMount() {
  if (typeof document === 'undefined') return null;
  const input = document.getElementById('userInput');
  if (!input || input.__cmBound) return null;
  input.__cmBound = true;

  let menu = null;
  let items = [];
  let idx = 0;
  let mode = '';

  const close = () => {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null; items = []; idx = 0; mode = '';
  };

  const render = () => {
    if (!items.length) {
      // 无候选时也要有反馈：给一行说明，而不是"打了 @ 什么也没发生"
      if (!menu) {
        menu = document.createElement('div');
        menu.className = 'cmx-menu';
        const host = input.closest('.input-inner') || input.parentNode;
        if (host && host.appendChild) host.appendChild(menu);
      }
      menu.innerHTML = '<div class="cmx-row cmx-empty"><span class="cmx-label"></span></div>';
      const lab = menu.querySelector('.cmx-label');
      if (lab) lab.textContent = mode === 'mention' ? '没有可提及的会话' : '没有匹配的命令';
      return;
    }
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'cmx-menu';
      menu.setAttribute('role', 'listbox');
      const host = input.closest('.input-inner') || input.parentNode;
      if (host && host.appendChild) host.appendChild(menu);
    }
    menu.innerHTML = items.map((it, i) =>
      '<div class="cmx-row' + (i === idx ? ' on' : '') + '" role="option" data-i="' + i + '">' +
      '<span class="cmx-kind">' + (it.kind === 'session' ? '@' : '/') + '</span>' +
      '<span class="cmx-label"></span></div>').join('');
    Array.prototype.forEach.call(menu.querySelectorAll('.cmx-row'), (row, i) => {
      const lab = row.querySelector('.cmx-label');
      if (lab) lab.textContent = items[i].label;
      row.onmouseenter = () => { idx = i; render(); };
      row.onclick = () => { pick(i); };
    });
  };

  const pick = (i) => {
    const it = items[i];
    if (!it) { close(); return; }
    const v = String(input.value || '');
    const pos = (typeof input.selectionStart === 'number') ? input.selectionStart : v.length;
    let start = pos;
    if (mode === 'cmd') {
      while (start > 0 && !/\s/.test(v[start - 1])) start--;
    } else {
      const at = v.lastIndexOf('@', pos - 1);
      start = at >= 0 ? at : pos;
    }
    const next = v.slice(0, start) + it.value + v.slice(pos);
    input.value = next;
    const caret = start + it.value.length;
    try { input.setSelectionRange(caret, caret); } catch (e) {}
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const refresh = () => {
    const res = composerMenuCandidates(input.value, input.selectionStart);
    mode = res.mode; items = res.items; idx = 0;
    render();
  };

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  // 流光边：用类而不是 :focus-within（实测该伪类在本仓的 .input-inner 上没命中）
  const hostEl = input.closest('.input-inner');
  if (hostEl) {
    input.addEventListener('focus', () => hostEl.classList.add('is-typing'));
    input.addEventListener('blur', () => hostEl.classList.remove('is-typing'));
  }
  input.addEventListener('blur', () => setTimeout(close, 120));
  return input;
}
