/* ================= 群文件（Round 14，2026-11-04 主理人立项） =================
 * 需求：「群聊多一个群文件功能，他们的交接文档统一放在群文件，并把名字修改
 * 清晰明白，方便后续其他大模型不清楚的时候智能搜索调用，群文件的本地保存
 * 地址可以自定义修改。」
 *
 * 数据流：后端 group_files_*（目录存 ~/.glm-chat/group_files.json 独立配置）：
 * - write   归档一份交接文档（文件名 = 时间_成员_主题.md，可读可检索）
 * - list    群文件列表（最新在前）
 * - search  关键词检索 → 命中片段，模型据此决定是否 read_file 全文
 * 前端职责：
 * - 解析成员正文里的【交接文档】小节（含完整正文，不截断）
 * - 归档成功后把「群文件索引」注入成员上下文（见 groupFilesContextLines）
 * - 提供群文件面板（列表/搜索/打开目录/自定义目录） */

/** 取当前群聊会话（面板/归档共用）。 */
function _gfSession() {
  const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  return groupSessionOf(sid);
}

/** 从成员正文里抽出【交接文档】小节（原样保留，含多行/列表项）。 */
function groupHandoffOf(text) {
  const m = /【交接文档】\s*\n?([\s\S]*)$/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

/** 交接文档字段解析（键值 → 对象）；未命中的自由文本折进 summary。 */
function groupHandoffFields(handoff) {
  const out = { to: '', summary: '', requirements: '', risks: '', raw: String(handoff || '') };
  String(handoff || '').split('\n').forEach(line => {
    const l = line.trim();
    if (!l) return;
    const kv = /^[-*•]?\s*([^:：]{1,16})[:：]\s*([\s\S]*)$/.exec(l);
    if (!kv) return;
    const k = kv[1].trim();
    const v = kv[2].trim();
    // 判定顺序：先「交接对象」（必须是短标签），再产出/要求/风险。
    // 「对下一棒的要求」含「下一棒」二字，不能命中 to——按「以…给/交接」收窄。
    if (/^(交接给|交给|接收人|接收方|to)$/i.test(k) || /交接给/.test(k) && k.length <= 6) out.to = v;
    else if (/本次产出|产出|摘要|主题/.test(k)) out.summary = v;
    else if (/要求|清单|验收/.test(k)) out.requirements = v;
    else if (/风险|注意/.test(k)) out.risks = v;
  });
  return out;
}

/** 交接文档标题：优先「本次产出」首句，其次首个非空行，最后兜底。 */
function groupHandoffTitle(handoff, fallback) {
  const f = groupHandoffFields(handoff);
  const base = f.summary || String(handoff || '').split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
  const clean = base.replace(/^[-*•]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback || '交接文档';
  return clean.length > 40 ? clean.slice(0, 40) : clean;
}

/** 归档一份交接文档到群文件（无交接小节则整条正文归档，保证不丢信息）。 */
async function groupArchiveHandoff(s, member, text, roundNo) {
  if (typeof callApi !== 'function') return null;
  const handoff = groupHandoffOf(text);
  const body = handoff || String(text || '').trim();
  if (!body) return null;
  const fields = groupHandoffFields(handoff);
  const title = groupHandoffTitle(handoff, (member && member.name) + '的第 ' + (roundNo || 0) + ' 轮产出');
  // 关键词：标题分词 + 交接对象 + 成员名，供后续模型检索命中
  // 关键词 = 显式字段词 + 交接正文高频词（「完整说明/要求」里的术语最常被后续
  // 检索命中——只靠标题召回太窄）
  const bodyText = String(handoff || '') || String(text || '');
  const freq = {};
  bodyText.split(/[^一-龥A-Za-z0-9]+/).forEach(w => {
    const t = w.trim();
    if (t.length >= 2 && t.length <= 12) freq[t] = (freq[t] || 0) + 1;
  });
  const hot = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 10);
  const kw = Array.from(new Set(
    (title + ' ' + (fields.requirements || '') + ' ' + (fields.to || '') + ' ' +
     ((member && member.name) || '') + ' ' + hot.join(' '))
      .split(/[\s,，。;；、/]+/).map(x => x.trim()).filter(x => x.length >= 2)
  )).slice(0, 16).join(' ');
  const meta = JSON.stringify({ to: fields.to || '', round: roundNo || 0, keywords: kw });
  try {
    const raw = await callApi('group_files_write', [
      s.id, s.title || '群聊', (member && member.name) || '成员', title, body, meta,
    ], 30000);
    const r = raw ? JSON.parse(raw) : null;
    if (r && r.path) {
      s.groupFiles = (s.groupFiles || []);
      s.groupFiles.push({ name: r.name, path: r.path, title: r.title, member: r.member, to: r.to, round: r.round, size: r.size, mtime: r.mtime });
      if (s.groupFiles.length > 60) s.groupFiles = s.groupFiles.slice(-60);
      // 工具栏「📁 群文件 N」即时刷新（原先要等下一次 render 才 +1）
      try { if (typeof groupToolbarRefresh === 'function') groupToolbarRefresh(s.id); } catch (e) {}
      return r;
    }
  } catch (e) { /* 归档失败不阻断接力：正文仍在会话流里 */ }
  return null;
}

/** 群文件索引（注入成员上下文，让模型知道有哪些文档可查、怎么查）。 */
function groupFilesContextLines(s) {
  const files = (s && s.groupFiles) || [];
  if (!files.length) return '';
  const root = (s.groupFileRoot || '');
  const lines = files.slice(-12).reverse().map(f =>
    '- [' + (f.title || f.name) + '](' + (f.name || '') + ')｜' + (f.member || '') +
    (f.to ? ' → ' + f.to : ''));
  return '\n群文件（交接文档仓库' + (root ? '，本地目录 ' + root : '') + '）：\n' + lines.join('\n') +
    '\n需要细节时用 read_file 打开对应 .md 全文；不确定哪份相关时先在群文件面板搜索关键词。\n';
}

/** 无 DOM 同步：把目录与文件清单挂到会话对象（上下文注入用）。
 * 打开会话时调用一次，成员发言时就能看到「有哪些交接文档可查」。 */
async function groupFilesSync(s) {
  if (!s || typeof callApi !== 'function') return;
  try {
    const cfgRaw = await callApi('group_files_config_get', [], 15000);
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    if (cfg && cfg.root) s.groupFileRoot = cfg.root;
    const raw = await callApi('group_files_list', [s.id, s.title || '群聊'], 20000);
    const r = raw ? JSON.parse(raw) : null;
    const files = (r && r.files) || [];
    s.groupFiles = files.map(f => ({
      name: f.name, path: f.path, title: f.title, member: f.member, to: f.to, round: f.round, size: f.size, mtime: f.mtime,
    }));
  } catch (e) { /* 后端旧版/不可用：群文件功能静默缺席，接力照常 */ }
}

/* ---------- 群文件面板 ---------- */

function groupFilesOpen() {
  const s = _gfSession();
  if (!s) return;
  let mask = document.getElementById('gfMask');
  if (mask) mask.remove();
  mask = document.createElement('div');
  mask.id = 'gfMask';
  mask.className = 'gw-mask';
  mask.innerHTML =
    '<div class="gf-panel" role="dialog" aria-label="群文件">' +
      '<div class="gf-head">' +
        '<div class="gf-title">📁 群文件</div>' +
        '<button type="button" class="gf-x" id="gfClose" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="gf-desc">成员每次发言的【交接文档】都会自动归档到这里，文件名带「时间_成员_主题」，可按关键词检索。</div>' +
      '<div class="gf-dirrow">' +
        '<input class="gf-input" id="gfDir" spellcheck="false" placeholder="群文件目录（留空=默认 ~/.glm-chat/group_files）">' +
        '<button type="button" class="gf-btn" id="gfBrowse">浏览…</button>' +
        '<button type="button" class="gf-btn" id="gfOpenDir" title="在资源管理器中打开群文件夹">📂 打开</button>' +
        '<button type="button" class="gf-btn primary" id="gfSaveDir">保存目录</button>' +
      '</div>' +
      '<div class="gf-searchrow">' +
        '<input class="gf-input" id="gfQuery" placeholder="搜索交接文档…（如 配色 / 验收 / 登录页）" spellcheck="false">' +
        '<button type="button" class="gf-btn" id="gfSearch">搜索</button>' +
      '</div>' +
      '<div class="gf-list" id="gfList">加载中…</div>' +
      '<div class="gf-msg" id="gfMsg"></div>' +
    '</div>';
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.querySelector('#gfClose').addEventListener('click', close);
  mask.querySelector('#gfSearch').addEventListener('click', () => groupFilesSearch(s));
  mask.querySelector('#gfQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') groupFilesSearch(s); });
  mask.querySelector('#gfBrowse').addEventListener('click', async () => {
    try {
      const raw = await callApi('pick_folder', [(typeof AppState !== 'undefined' ? AppState.currentSessionId : '')], 60000);
      const r = raw ? JSON.parse(raw) : null;
      const dir = r && (r.path || r.dir || r.folder);
      if (dir) mask.querySelector('#gfDir').value = dir;
    } catch (e) { groupFilesMsg('选择目录失败：' + (e && e.message ? e.message : e)); }
  });
  mask.querySelector('#gfOpenDir').addEventListener('click', async () => {
    try {
      const raw = await callApi('group_files_open_dir', [s.id], 20000);
      const r = raw ? JSON.parse(raw) : null;
      if (r && r.ok) groupFilesMsg('已打开：' + r.dir, 'ok');
      else groupFilesMsg((r && r.error) || '打开失败');
    } catch (e) { groupFilesMsg('打开失败：' + (e && e.message ? e.message : e)); }
  });
  mask.querySelector('#gfSaveDir').addEventListener('click', async () => {
    const root = mask.querySelector('#gfDir').value.trim();
    try {
      const raw = await callApi('group_files_config_set', [JSON.stringify({ root })], 20000);
      const r = raw ? JSON.parse(raw) : null;
      if (r && r.root) {
        s.groupFileRoot = r.root;
        try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
        groupFilesMsg('群文件目录已设为：' + r.root, 'ok');
        groupFilesLoad(s);
      } else {
        groupFilesMsg((r && r.error) || '目录设置失败');
      }
    } catch (e) { groupFilesMsg('目录设置失败：' + (e && e.message ? e.message : e)); }
  });
  groupFilesLoad(s);
}

let _gfSearchTerms = [];   // 最近一次搜索的分词（命中高亮用）

/** 命中高亮：纯 DOM 构建（textContent 注入，杜绝片段内 HTML 逃逸）。 */
function groupFilesHighlight(snippet, terms) {
  const host = document.createElement('span');
  const text = String(snippet || '');
  const safe = (terms || []).filter(t => t && t.length >= 1).slice(0, 8)
    .map(t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!safe.length) { host.textContent = text; return host; }
  const re = new RegExp('(' + safe.join('|') + ')', 'gi');
  const reTest = new RegExp('^(' + safe.join('|') + ')$', 'i');
  String(text).split(re).forEach(part => {
    if (part && reTest.test(part)) {
      const m = document.createElement('mark');
      m.className = 'gf-hit';
      m.textContent = part;
      host.appendChild(m);
    } else if (part) {
      host.appendChild(document.createTextNode(part));
    }
  });
  return host;
}

function groupFilesMsg(text, kind) {
  const el = document.getElementById('gfMsg');
  if (!el) return;
  el.textContent = String(text || '');
  el.className = 'gf-msg' + (kind ? ' ' + kind : '');
}

async function groupFilesLoad(s) {
  const list = document.getElementById('gfList');
  if (!list) return;
  _gfSearchTerms = [];
  try {
    const cfgRaw = await callApi('group_files_config_get', [], 15000);
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    if (cfg && cfg.root) {
      s.groupFileRoot = cfg.root;
      const inp = document.getElementById('gfDir');
      if (inp) inp.value = cfg.custom ? cfg.root : '';
    }
    const raw = await callApi('group_files_list', [s.id, s.title || '群聊'], 20000);
    const r = raw ? JSON.parse(raw) : null;
    const files = (r && r.files) || [];
    s.groupFiles = files.map(f => ({ name: f.name, path: f.path, title: f.title, member: f.member, to: f.to, round: f.round, size: f.size, mtime: f.mtime }));
    groupFilesRender(files);
  } catch (e) {
    list.textContent = '读取群文件失败：' + (e && e.message ? e.message : e);
  }
}

function groupFilesRender(files, hits) {
  const list = document.getElementById('gfList');
  if (!list) return;
  if (!files || !files.length) {
    list.innerHTML = '<div class="gf-empty">还没有群文件。成员第一次发言并输出【交接文档】后会自动归档。</div>';
    return;
  }
  const rows = hits
    ? files.map(h => ({
      name: h.name, title: h.title, member: h.member, to: h.to, round: h.round,
      time: h.mtime ? new Date(h.mtime * 1000).toLocaleString() : '', snippet: h.snippet,
      size: h.size || 0,
    }))
    : files.map(f => ({
      name: f.name, title: f.title || f.name, member: f.member, to: f.to, round: f.round,
      time: f.mtime ? new Date(f.mtime * 1000).toLocaleString() : '', snippet: '',
      size: f.size || 0,
    }));
  list.innerHTML = '';
  rows.forEach(row => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'gf-item';
    el.innerHTML =
      '<div class="gf-item-top"><span class="gf-item-title"></span>' +
        (row.to ? '<span class="gf-item-to"></span>' : '') +
        '<span class="gf-item-del" title="删除这份群文件">✕</span></div>' +
      '<div class="gf-item-meta"></div>' +
      (row.snippet ? '<div class="gf-item-snippet"></div>' : '');
    const snippetEl = el.querySelector('.gf-item-snippet');
    if (snippetEl) snippetEl.appendChild(groupFilesHighlight(row.snippet, _gfSearchTerms));
    el.querySelector('.gf-item-title').textContent = row.title || row.name;
    if (row.to) el.querySelector('.gf-item-to').textContent = '→ ' + row.to;
    el.querySelector('.gf-item-meta').textContent =
      [row.member, row.round ? '第' + row.round + '轮' : '',
       row.size ? Math.max(1, Math.round(row.size / 1024)) + 'KB' : '',
       row.time, row.name].filter(Boolean).join(' · ');
    el.addEventListener('click', () => groupFilesRead(row.name));
    el.querySelector('.gf-item-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      groupFilesDelete(s || _gfSession(), row.name);
    });
    list.appendChild(el);
  });
}

/** 删除一份群文件（面板即时摘除；失败提示不吞）。 */
async function groupFilesDelete(s, name) {
  if (!s || !name) return;
  // uiConfirm（R3 应用内确认框）优先；vm 沙箱/旧环境降级 window.confirm
  let ok = true;
  if (typeof uiConfirm === 'function') {
    ok = await uiConfirm({ title: '删除群文件', message: '删除「' + name + '」？此操作不可恢复。',
                           confirmText: '删除', danger: true });
  } else if (typeof window !== 'undefined' && window.confirm) {
    ok = window.confirm('删除群文件「' + name + '」？此操作不可恢复。');
  }
  if (!ok) return;
  try {
    const raw = await callApi('group_files_delete', [s.id, name], 20000);
    const r = raw ? JSON.parse(raw) : null;
    if (r && r.ok) {
      s.groupFiles = (s.groupFiles || []).filter(f => f.name !== name);
      groupFilesLoad(s);
      groupFilesMsg('已删除：' + name, 'ok');
    } else groupFilesMsg((r && r.error) || '删除失败');
  } catch (e) { groupFilesMsg('删除失败：' + (e && e.message ? e.message : e)); }
}

async function groupFilesSearch(s) {
  const q = (document.getElementById('gfQuery') || {}).value || '';
  if (!String(q).trim()) { groupFilesLoad(s); return; }
  try {
    const raw = await callApi('group_files_search', [s.id, q.trim(), 20], 20000);
    const r = raw ? JSON.parse(raw) : null;
    if (r && r.hits) {
      _gfSearchTerms = String(q.trim()).toLowerCase().split(/[\s,，。;；、]+/).filter(x => x.length >= 1);
      groupFilesRender(r.hits);
      groupFilesMsg(r.count ? ('找到 ' + r.count + ' 份相关文档') : '没有匹配的交接文档');
    } else groupFilesMsg((r && r.error) || '搜索失败');
  } catch (e) { groupFilesMsg('搜索失败：' + (e && e.message ? e.message : e)); }
}

/** 打开某份群文件全文（复用详情页形态）。 */
async function groupFilesRead(name) {
  const s = _gfSession();
  const f = ((s && s.groupFiles) || []).find(x => x.name === name);
  if (!f || !f.path) return;
  groupFilesMsg('正在打开 ' + f.name + '…');
  try {
    const raw = await callApi('read_file', [f.path], 20000);
    let text = '';
    try {
      const r = JSON.parse(raw);
      text = (r && (r.content || r.text)) || '';
    } catch (e) { text = String(raw || ''); }
    groupFilesMsg('');
    groupDetailOpen(text || '（读取失败）', { id: 'gf', name: (f.member || '') + ' · 群文件', host: false }, null);
  } catch (e) { groupFilesMsg('读取失败：' + (e && e.message ? e.message : e)); }
}
