/* ================= 记忆管理面板（v1.8.0 W11，实现 v1.8.0 W11） =================
 * #memoryBlock + .mm-*（纯新增 DOM，UI 契约只增不改——check_contract 验）：
 * 设置面板「记忆」区块：记忆列表（get_memory）/ 添加（append_memory）/
 * 删除（memory_delete）/ 前端搜索过滤（纯客户端，零后端调用）。
 * 契约口径（W11 任务书 + 64-software-panel 同款模式）：
 * - 三态状态机 idle/pending/success/error + 请求序号 last-wins
 *   （memoryReqSeq；pending 期间新触发 → seq+1 覆盖，旧请求返回后
 *   seq!==memoryReqSeq 静默丢弃）；
 * - 存储：~/.glm-chat/memory.json（legacy 既有文件；config.json 零污染，
 *   后端 append 时自动打 ts 并截尾保留最近 200 条）；
 * - 后端：memory_delete(index)（_V12_EXTRA 隐身）删数组第 index 条，
 *   边界校验不静默夹逼（非整数/越界 → BAD_PARAMS + hint；审计
 *   op=memory_delete）；
 * - 删除前应用内确认（uiConfirm，v1.2 R3 模态；vm 沙箱无 uiConfirm 时
 *   回落原生 confirm——两层都有 typeof 守卫）；
 * - typeof 守卫（vm 沙箱可测）：模块顶层不直接引用 window/document/
 *   localStorage；callApi 统一经 mmCallApi 两步（入口守卫 → 竞速调用）。
 * 挂载：110-boot.js loadAll 内 try{ memoryPanelInit(); }catch。
 * 导航入口：设置面板本就是 v4「一项对一项」架构——本块作为 .set-block
 * 挂进 .set-grid 并带 data-group="数据」，33-set-nav 的 buildSetNav 每次
 * 打开设置自动收录「记忆」导航项（零新导航机制，不碰 33/41 两文件）。
 * 样式：纯内联 + 既有 CSS 变量/既有泛型类（set-block/set-title/set-hint/
 * provider-row/modal-btn）——零新 CSS 类定义、零新色值、零新动效令牌。
 */
const MM_LIST_TIMEOUT_MS = 15000;    // get_memory（本地文件读；与 S 域列表同款快失败口径）
const MM_WRITE_TIMEOUT_MS = 15000;   // append_memory / memory_delete
const MM_TEXT_MAX = 500;             // 单条记忆最大长度（与 textarea maxlength 对齐）
// 功能分级开关键（设置可单独关记忆；默认开——对齐 63/64 的 glm_feat_*_v18 模式）
const MM_FEATURE_KEY = 'glm_feat_memory_v18';

let memoryReqSeq = 0;          // last-wins 请求序号（每次触发递增，旧请求失效）
let memoryPanelState = 'idle'; // idle|pending|success|error（块上 data-state 镜像）
let mmLastItems = [];          // 最近一次列表载荷（搜索过滤/重渲染用）
let mmBusy = false;            // 写在途（添加/删除期间禁用提交按钮，防重复触发）
let mmLastError = null;
const mmGenerativeState = { show: false, projection: null, list: null, host: null, generate: null, raw: null, aiController: null };
function memoryGenerativeRender() {
  const state = mmGenerativeState;
  if (!state.host) return null;
  if (state.aiController && state.aiController.isBusy()) return state.projection;
  const spec = UiSpecFixtures.memory({
    items: mmLastItems,
    revision: Math.max(memoryReqSeq, state.projection && state.projection.current
      ? state.projection.current.revision : 0), error: mmLastError,
    sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'current-session',
  });
  const options = { dataRefHost: createUiDataRefHost({
    runId: spec.runId, sessionId: spec.sessionId, generation: spec.generation,
  }) };
  if (!state.projection) state.projection = UiProjection.mount(state.host, spec, options);
  else state.projection.commit(spec);
  return state.projection;
}
function memoryGenerativeShow() {
  const state = mmGenerativeState;
  if (state.aiController) state.aiController.cancel();
  state.show = true;
  memoryGenerativeRender();
  if (state.list) state.list.hidden = true;
  const error = mmEl('mmError'); if (error) error.hidden = true;
  if (state.host) state.host.hidden = false;
  if (state.generate) state.generate.hidden = true;
  if (state.raw) state.raw.hidden = false;
}
function memoryGenerativeHide() {
  const state = mmGenerativeState;
  if (state.aiController) state.aiController.cancel();
  state.show = false;
  if (state.list) state.list.hidden = false;
  const error = mmEl('mmError'); if (error) error.hidden = !mmLastError;
  if (state.host) state.host.hidden = true;
  if (state.generate) state.generate.hidden = false;
  if (state.raw) state.raw.hidden = true;
}
function memoryGenerativeEnsure(block) {
  if (!block || mmGenerativeState.host) return;
  const state = mmGenerativeState;
  state.list = mmEl('mmList');
  const controls = document.createElement('div'); controls.className = 'ui-view-controls';
  const generate = document.createElement('button');
  generate.type = 'button'; generate.className = 'modal-btn'; generate.textContent = '生成视图';
  generate.setAttribute('aria-label', '生成记忆视图');
  const raw = document.createElement('button');
  raw.type = 'button'; raw.className = 'modal-btn'; raw.textContent = '原始视图'; raw.hidden = true;
  const ai = document.createElement('button');
  ai.type = 'button'; ai.className = 'modal-btn'; ai.id = 'mmAiGenerateBtn';
  ai.textContent = 'AI生成'; ai.setAttribute('aria-label', '使用 AI 生成记忆视图');
  const aiCancel = document.createElement('button');
  aiCancel.type = 'button'; aiCancel.className = 'modal-btn'; aiCancel.id = 'mmAiCancelBtn';
  aiCancel.textContent = '取消生成'; aiCancel.hidden = true;
  const host = document.createElement('div'); host.className = 'memory-generative-host'; host.hidden = true;
  state.aiController = typeof createUiGenerationController === 'function' ? createUiGenerationController({
    kind: 'memory', host, button: ai, cancelButton: aiCancel,
    endpoint: () => ((typeof uiEndpointSnapshot === 'function') ? uiEndpointSnapshot() : undefined),
    fallback: () => UiSpecFixtures.memory({ items: mmLastItems, revision: memoryReqSeq,
      error: mmLastError,
      sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'current-session' }),
    actionHandlers: {
      refresh: () => memoryPanelRefresh(),
      copy: context => navigator.clipboard.writeText(context.text),
      export: () => exportSessionMd(typeof AppState !== 'undefined' ? AppState.currentSessionId : null),
    },
    actionPermission: (name, block) => {
      if (!block.bind) return !mmLastError;
      const spec = state.projection && state.projection.current;
      return createUiDataRefHost({ runId: spec && spec.runId,
        sessionId: spec && spec.sessionId, generation: spec && spec.generation,
      }).permission(block.bind) === true;
    },
    onResult: result => { if (result.projection) state.projection = result.projection; },
  }) : null;
  if (!state.aiController) { ai.hidden = true; aiCancel.hidden = true; }
  generate.onclick = memoryGenerativeShow; raw.onclick = memoryGenerativeHide;
  ai.onclick = () => { memoryGenerativeShow(); state.aiController.start(); };
  aiCancel.onclick = () => state.aiController.cancel();
  controls.appendChild(generate); controls.appendChild(raw);
  controls.appendChild(ai); controls.appendChild(aiCancel);
  block.appendChild(controls); block.appendChild(host);
  state.host = host; state.generate = generate; state.raw = raw;
}

/* ---------- typeof 守卫取值（vm 沙箱无 DOM 不炸） ---------- */
function mmEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function mmCallApi(name, args, timeoutMs) {
  // 入口守卫（与 64-software-panel swCallApi 同款口径，vm 下显式抛可断言）
  if (typeof callApi !== 'function') {
    throw new Error('pywebview bridge 未就绪: ' + name);
  }
  return callApi(name, args, timeoutMs);
}
function mmToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'info');
}
function mmFeatureEnabled() {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(MM_FEATURE_KEY);
    return v === null || v === '1';   // 缺省 = 开（默认开）
  } catch (e) { return true; }
}
function mmEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 条目归一（memory.json 元素可为任意 JSON 值） ---------- */
function mmEntryText(it) {
  if (it == null) return '';
  if (typeof it === 'string') return it;
  if (typeof it === 'object') {
    if (typeof it.text === 'string' && it.text) return it.text;
    try { return JSON.stringify(it); } catch (e) { return String(it); }
  }
  return String(it);
}
function mmEntryTs(it) {
  return (it && typeof it === 'object' && it.ts) ? String(it.ts) : '';
}

/* ---------- 面板骨架（纯新增 DOM；挂到设置面板 set-grid，softwareBlock 同款模式） ---------- */
function memoryPanelInit() {
  if (!mmFeatureEnabled()) return false;          // 功能分级开关：关则不挂载
  if (mmEl('memoryBlock')) { memoryPanelWire(); return true; }   // 幂等
  if (typeof document === 'undefined') return false;
  const grid = document.querySelector('.set-grid');
  if (!grid) return false;
  const block = document.createElement('div');
  block.id = 'memoryBlock';
  block.className = 'set-block';
  block.setAttribute('data-group', '数据与历史');   // 归「数据」组（33-set-nav 既有归组机制）
  block.setAttribute('data-state', 'idle');
  block.innerHTML =
    '<div class="set-title">记忆（v1.8.0）</div>' +
    '<div class="set-hint" style="margin:2px 0 8px;">' +
      'Harbor 记住你手动保存的偏好与事实（每条都由你确认，不会自动记忆）。' +
      '数据存于 <code>~/.glm-chat/memory.json</code>（独立文件，不碰 config.json），' +
      '最多保留最近 200 条。删除会话不会删除这些记忆；' +
      '扩展记忆库（memory.db）为独立增强层，可随时整体清除。' +
    '</div>' +
    '<div class="set-hint" id="mmDbStat" style="margin:0 0 6px;color:var(--text-2);">扩展记忆库：读取中…</div>' +
    '<div id="mmDbWrap" style="display:none;margin:0 0 10px;">' +
      '<div class="set-hint" style="margin:0 0 4px;">扩展库条目（结构化事实/画像）——钉选后每次对话恒带上：</div>' +
      '<div class="mm-list" id="mmDbList" style="display:flex;flex-direction:column;gap:6px;"></div>' +
    '</div>' +
    '<div class="provider-row" style="align-items:center;gap:8px;">' +
      '<input class="mm-input" id="mmSearch" placeholder="搜索记忆（本地过滤）" maxlength="100" ' +
        'style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);' +
        'background:var(--main-bg);color:var(--text);font-size:12.5px;outline:none;">' +
      '<span id="mmCount" style="font-size:12px;color:var(--text-2);white-space:nowrap;">读取中…</span>' +
    '</div>' +
    '<div class="provider-row" style="align-items:flex-start;gap:8px;">' +
      '<textarea class="mm-input" id="mmInput" rows="2" maxlength="' + MM_TEXT_MAX + '" ' +
        'placeholder="添加一条记忆，如：部署脚本在 D:\\deploy\\ship.ps1" ' +
        'style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);' +
        'background:var(--main-bg);color:var(--text);font-size:12.5px;outline:none;resize:vertical;"></textarea>' +
    '</div>' +
    '<div class="provider-row">' +
      '<button type="button" class="modal-btn primary" id="mmAddBtn">添加记忆</button>' +
      '<button type="button" class="modal-btn" id="mmRefreshBtn">↻ 刷新</button>' +
    '</div>' +
    '<div class="mm-list" id="mmList" style="display:flex;flex-direction:column;gap:6px;margin-top:10px;"></div>' +
    '<div class="mm-error" id="mmError" style="display:none;margin-top:8px;"></div>';
  grid.appendChild(block);
  memoryPanelWire();
  memoryDbStatRefresh();
  return true;
}
/* R38：扩展记忆库（memory.db v2）状态行——引擎不可用/未启用时如实降级说明，
 * 面板主功能（memory.json legacy 契约）不受影响。
 * R39：状态行下挂逐条管理区（memory_entries_list 视图：删除/钉选/来源·置信度/
 * 上次命中）。legacy 命名空间条目只读（删除/增删走上方基础列表——重建会复活，
 * 双写真相源在 memory.json），操作按钮禁用并给出指引。 */
function memoryDbStatRefresh() {
  const el = mmEl('mmDbStat');
  if (!el) return;
  const done = () => {
    if (typeof mmCallApi !== 'function') { el.textContent = '扩展记忆库：未启用'; return; }
    mmCallApi('memory_stats', [], 8000).then(raw => {
      let d = null;
      try { d = JSON.parse(raw || '{}'); } catch (e) {}
      if (!d || !d.enabled) {
        el.textContent = '扩展记忆库：未启用（记忆仍存 memory.json，功能不受影响）';
        const wrap = mmEl('mmDbWrap'); if (wrap) wrap.style.display = 'none';
        return;
      }
      el.innerHTML = '扩展记忆库：<b>已启用</b>（memory.db · ' +
        escapeHtml(String(d.journal || 'wal').toUpperCase()) + '）· 事实 ' +
        escapeHtml(String(d.facts || 0)) + ' · 画像 ' +
        escapeHtml(String(d.profiles || 0)) + ' · 审计事件 ' +
        escapeHtml(String(d.events || 0)) + ' · 完整性 ' + (d.integrity ? '✓' : '✗');
      memoryDbEntriesRefresh();
    }).catch(() => { el.textContent = '扩展记忆库：状态未知'; });
  };
  if (typeof setTimeout === 'function') setTimeout(done, 0); else done();
}

/* ---------- R39：扩展库逐条管理（视图/钉选/单条擦除） ---------- */
const mmDbSeq = { n: 0 };          // last-wins 序号（容器对象：vm 沙箱模块级 let 可测性同款）
let mmDbEntries = [];              // 最近一次 entries 载荷（渲染/定位用）
function mmDbBadge(it) {
  // 来源·置信度·命中：session/legacy/user/assistant → 人话；命中仅画像层有
  const srcMap = { session: '会话', legacy: '迁移', user: '用户', assistant: 'AI' };
  const conf = (it.kind === 'profile')
    ? ('置信 ' + (it.confidence >= 1.2 ? '★★' : '★'))
    : '';
  const hits = (it.kind === 'profile')
    ? ('命中 ' + (it.hits || 0) + ' 次' + (it.last_hit ? ' · ' + String(it.last_hit).replace('T', ' ').slice(0, 16) : ''))
    : (it.updated ? '记录 ' + String(it.updated).replace('T', ' ').slice(0, 16) : '');
  return [(srcMap[it.source] || it.source), conf, hits].filter(Boolean).join(' · ');
}
function memoryDbEntriesRefresh() {
  const wrap = mmEl('mmDbWrap');
  if (!wrap) return;
  const seq = ++mmDbSeq.n;
  if (typeof mmCallApi !== 'function') { wrap.style.display = 'none'; return; }
  mmCallApi('memory_entries_list', [], MM_LIST_TIMEOUT_MS).then(raw => {
    if (seq !== mmDbSeq.n) return;   // last-wins
    let d = {};
    try { d = JSON.parse(raw || '{}'); } catch (e) {}
    const entries = (d && Array.isArray(d.entries)) ? d.entries : [];
    mmDbEntries = entries;
    wrap.style.display = (d && d.enabled && entries.length) ? '' : 'none';
    memoryDbEntriesRender(entries);
  }).catch(() => { if (seq === mmDbSeq.n) wrap.style.display = 'none'; });
}
function memoryDbEntriesRender(entries) {
  const box = mmEl('mmDbList');
  if (!box) return;
  box.innerHTML = '';
  (Array.isArray(entries) ? entries : []).forEach(it => {
    const row = document.createElement('div');
    row.className = 'mm-row';
    row.setAttribute('style',
      'display:flex;align-items:flex-start;gap:8px;padding:7px 10px;' +
      'border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);' +
      'font-size:12px;');
    const meta = mmDbBadge(it);
    row.innerHTML =
      '<span style="flex:0 0 auto;font-size:11px;" title="钉选条目每次对话恒带上">' +
        (it.pinned ? '📌' : '') + '</span>' +
      '<span style="flex:1;min-width:0;">' +
        '<span class="mm-dbtext" style="display:block;color:var(--text);white-space:pre-wrap;word-break:break-all;"></span>' +
        '<span style="display:block;font-size:11px;color:var(--text-3);margin-top:2px;">' +
          mmEsc(meta) + (it.readonly ? ' · 迁移条目（在上方基础列表管理）' : '') +
        '</span>' +
      '</span>' +
      '<button type="button" class="modal-btn mm-db-pin" style="flex:0 0 auto;padding:3px 8px;font-size:11.5px;">' +
        (it.pinned ? '取消钉选' : '钉选') + '</button>' +
      '<button type="button" class="modal-btn mm-db-del" style="flex:0 0 auto;padding:3px 8px;font-size:11.5px;color:var(--err);">删除</button>';
    row.querySelector('.mm-dbtext').textContent = it.text || '';
    const pinBtn = row.querySelector('.mm-db-pin');
    const delBtn = row.querySelector('.mm-db-del');
    if (it.readonly) { pinBtn.disabled = true; delBtn.disabled = true; pinBtn.title = '迁移条目请在上方基础列表管理'; delBtn.title = pinBtn.title; }
    pinBtn.addEventListener('click', () => memoryDbEntryPin(it));
    delBtn.addEventListener('click', () => memoryDbEntryErase(it));
    box.appendChild(row);
  });
}
async function memoryDbEntryPin(it) {
  if (mmBusy || !it || it.readonly) return;
  try {
    const raw = await mmCallApi('memory_entry_pin',
      [it.kind, it.id, !it.pinned], MM_WRITE_TIMEOUT_MS);
    let d = {};
    try { d = JSON.parse(raw || '{}'); } catch (e) {}
    if (d && d.ok) { mmToast(it.pinned ? '已取消钉选' : '已钉选——每次对话恒带上', 'ok'); memoryDbStatRefresh(); }
    else mmToast((d && d.error && d.error.message) || '操作失败', 'err');
  } catch (e) { mmToast('桥接调用失败', 'err'); }
}
async function memoryDbEntryErase(it) {
  if (mmBusy || !it || it.readonly) return;
  const preview = String(it.text || '').slice(0, 40);
  const bodyHtml = '确定删除这条扩展记忆吗？<br>「' + mmEsc(preview) +
    (preview.length >= 40 ? '…' : '') + '」<br>事实条目为软删除（账本留审计痕迹）。';
  let confirmed = false;
  if (typeof uiConfirm === 'function') {
    const r = await uiConfirm({ title: '删除扩展记忆', bodyHtml: bodyHtml, danger: true,
      okText: '删除', cancelText: '取消' });
    confirmed = !!(r && r.ok);
  } else if (typeof confirm === 'function') {
    confirmed = confirm('确定删除这条扩展记忆吗？\n「' + preview + '」');
  }
  if (!confirmed) return;
  mmBusy = true;
  try {
    const raw = await mmCallApi('memory_entry_erase', [it.kind, it.id], MM_WRITE_TIMEOUT_MS);
    let d = {};
    try { d = JSON.parse(raw || '{}'); } catch (e) {}
    if (d && d.ok) { mmToast('已删除', 'ok'); memoryDbStatRefresh(); }
    else mmToast((d && d.error && d.error.message) || '删除失败', 'err');
  } catch (e) { mmToast('桥接调用失败', 'err'); }
  finally { mmBusy = false; }
}
function memoryPanelWire() {
  const add = mmEl('mmAddBtn');
  if (add) add.addEventListener('click', () => memoryPanelAdd());
  const refresh = mmEl('mmRefreshBtn');
  if (refresh) refresh.addEventListener('click', () => { memoryPanelRefresh(); memoryDbStatRefresh(); });
  const search = mmEl('mmSearch');
  if (search) search.addEventListener('input', () => memoryPanelRenderList(mmLastItems));
  memoryGenerativeEnsure(mmEl('memoryBlock'));
  memoryPanelRefresh();
}

/* ---------- 三态 + last-wins：列表刷新 ---------- */
async function memoryPanelRefresh() {
  const seq = ++memoryReqSeq;
  memoryPanelSetState('pending');
  try {
    const raw = await mmCallApi('get_memory', [], MM_LIST_TIMEOUT_MS);
    if (seq !== memoryReqSeq) return;               // last-wins：旧返回丢弃
    let items = [];
    try { items = JSON.parse(raw || '[]'); } catch (e) { items = []; }
    if (items && typeof items === 'object' && !Array.isArray(items) && items.ok === false) {
      // 信封错误（非数组载荷）：显示 error，勿静默渲染空列表（用户以为记忆被清空）
      mmLastItems = [];
      memoryPanelRenderList([]);
      memoryPanelRenderError(items.error || { code: 'INTERNAL', message: '读取失败' });
      memoryPanelSetState('error');
      return;
    }
    if (!Array.isArray(items)) items = [];
    mmLastItems = items;
    memoryPanelRenderList(items);
    memoryPanelRenderError(null);
    memoryPanelSetState('success');
  } catch (e) {
    if (seq !== memoryReqSeq) return;
    mmLastItems = [];
    memoryPanelRenderList([]);
    memoryPanelRenderError({ code: 'BRIDGE_TIMEOUT',
      message: (e && e.message) || String(e) });
    memoryPanelSetState('error');
  }
}

/* ---------- 渲染（搜索过滤为纯客户端：对 mmLastItems 文本匹配） ---------- */
function memoryPanelRenderList(items) {
  const box = mmEl('mmList');
  const count = mmEl('mmCount');
  const all = Array.isArray(items) ? items : [];
  // 配对全局下标（删除按全局 index 调 memory_delete；条目可重复，禁用 indexOf）
  const pairs = all.map((it, i) => ({ it: it, i: i }));
  let q = '';
  try { q = String(((mmEl('mmSearch') || {}).value) || '').trim().toLowerCase(); } catch (e) {}
  const shown = q
    ? pairs.filter(p => mmEntryText(p.it).toLowerCase().indexOf(q) >= 0)
    : pairs;
  if (count) {
    count.textContent = q
      ? ('匹配 ' + shown.length + ' / ' + all.length + ' 条')
      : ('共 ' + all.length + ' 条');
  }
  if (!box) return;
  box.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'mm-empty';
    empty.setAttribute('style',
      'padding:14px;text-align:center;font-size:12px;color:var(--text-3);' +
      'border:1px dashed var(--border);border-radius:var(--radius-sm);');
    empty.textContent = all.length ? '没有匹配的记忆。' : '暂无记忆——在上方添加第一条。';
    box.appendChild(empty);
    if (mmGenerativeState.show) memoryGenerativeRender();
    return;
  }
  shown.forEach(p => {
    const row = document.createElement('div');
    row.className = 'mm-row';
    row.setAttribute('data-index', String(p.i));
    row.setAttribute('style',
      'display:flex;align-items:flex-start;gap:8px;padding:8px 10px;' +
      'border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);' +
      'font-size:12px;animation:v4SetBlockIn var(--dur-comp) var(--ease-out-soft);');
    row.innerHTML =
      '<span class="mm-idx" style="flex:0 0 auto;color:var(--text-3);' +
        'font-family:var(--font-mono,ui-monospace,Consolas,monospace);font-size:11px;">#' +
        (p.i + 1) + '</span>' +
      '<span class="mm-text" style="flex:1;min-width:0;color:var(--text);' +
        'white-space:pre-wrap;word-break:break-all;"></span>' +
      '<span class="mm-ts" style="flex:0 0 auto;color:var(--text-3);font-size:11px;' +
        'white-space:nowrap;">' + mmEsc(mmEntryTs(p.it)) + '</span>' +
      '<button type="button" class="modal-btn mm-del" data-index="' + p.i + '" ' +
        'style="flex:0 0 auto;padding:3px 10px;font-size:11.5px;color:var(--err);">删除</button>';
    row.querySelector('.mm-text').textContent = mmEntryText(p.it);
    box.appendChild(row);
  });
  box.querySelectorAll('.mm-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      memoryPanelDelete(Number.isInteger(idx) ? idx : -1);
    });
  });
  if (mmGenerativeState.show) memoryGenerativeRender();
}
function memoryPanelSetState(state) {
  memoryPanelState = state;
  const block = mmEl('memoryBlock');
  if (block) block.setAttribute('data-state', state);
}
function memoryPanelRenderError(e) {
  mmLastError = e || null;
  const box = mmEl('mmError');
  if (!box) return;
  if (!e) {
    box.style.display = 'none'; box.innerHTML = '';
    if (mmGenerativeState.show) memoryGenerativeRender();
    return;
  }
  box.innerHTML =
    '<div style="font-size:12px;color:var(--err);word-break:break-all;">[' +
      mmEsc(e.code || 'ERROR') + '] ' + mmEsc(e.message || '操作失败') + '</div>' +
    (e.hint ? '<div style="font-size:11.5px;color:var(--text-2);margin-top:2px;">' +
      mmEsc(e.hint) + '</div>' : '');
  box.style.display = '';
  if (mmGenerativeState.show) memoryGenerativeRender();
}

/* ---------- 添加（append_memory；后端自动打 ts + 截尾 200） ---------- */
async function memoryPanelAdd() {
  if (mmBusy) return;
  const ta = mmEl('mmInput');
  const text = ta ? String(ta.value || '').trim() : '';
  if (!text) { mmToast('先写点什么再添加', 'warn'); return; }
  mmBusy = true;
  const btn = mmEl('mmAddBtn');
  if (btn) { btn.disabled = true; btn.textContent = '添加中…'; }
  const seq = ++memoryReqSeq;
  memoryPanelSetState('pending');
  try {
    const raw = await mmCallApi('append_memory',
      [JSON.stringify({ text: text })], MM_WRITE_TIMEOUT_MS);
    if (seq !== memoryReqSeq) return;
    let d = {};
    try { d = JSON.parse(raw || '{}'); } catch (e) { d = {}; }
    if (d && d.ok) {
      if (ta) ta.value = '';
      mmToast('已添加记忆', 'ok');
      await memoryPanelRefresh();
      memoryDbStatRefresh();   // R39：镜像进 db → 扩展区条目同步刷新
    } else {
      // 复核修正：err() 家族返回 {'error': '字符串'}——renderError 只读
      // e.message，字符串塞进去恒显「[INTERNAL] 操作失败」丢真因（兼容两态）
      const _err = d && d.error;
      memoryPanelRenderError(typeof _err === 'string'
        ? { code: 'INTERNAL', message: _err }
        : _err || { code: 'INTERNAL', message: '添加失败' });
      memoryPanelSetState('error');
    }
  } catch (e) {
    if (seq !== memoryReqSeq) return;
    memoryPanelRenderError({ code: 'BRIDGE_TIMEOUT',
      message: (e && e.message) || String(e) });
    memoryPanelSetState('error');
  } finally {
    mmBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '添加记忆'; }
  }
}

/* ---------- 删除（前端 confirm → memory_delete → 列表刷新） ---------- */
async function memoryPanelDelete(index) {
  if (mmBusy) return;
  if (!Number.isInteger(index) || index < 0 || index >= mmLastItems.length) {
    mmToast('该记忆已不在当前列表，请刷新后重试', 'warn');
    return;
  }
  const preview = mmEntryText(mmLastItems[index]).slice(0, 40);
  const tail = preview.length >= 40 ? '…' : '';
  // 原生 confirm 降级路径用 \n（原生对话框按换行渲染）；
  // uiConfirm 走 bodyHtml 通道（<br> 换行 + mmEsc 转义记忆文本，防注入）
  const body = '确定删除第 ' + (index + 1) + ' 条记忆吗？\n「' +
    preview + tail + '」\n删除后不可恢复。';
  const bodyHtml = '确定删除第 ' + (index + 1) + ' 条记忆吗？<br>「' +
    mmEsc(preview).replace(/\n/g, '<br>') + tail + '」<br>删除后不可恢复。';
  let confirmed = false;
  if (typeof uiConfirm === 'function') {
    // v1.2 R3：应用内模态确认（danger 态）
    const r = await uiConfirm({ title: '删除记忆', bodyHtml: bodyHtml, danger: true,
      okText: '删除', cancelText: '取消' });
    confirmed = !!(r && r.ok);
  } else if (typeof confirm === 'function') {
    confirmed = confirm(body);   // 降级：无 uiConfirm 的环境（vm 沙箱可桩）
  }
  if (!confirmed) return;
  // 陈旧校验：删前重取 get_memory，与展示中的列表逐条比对（长度 + 条目文本）——
  // 不一致说明列表已被别处改动（另一面板/会话/手动编辑），index 可能指向
  // 别的条目；禁删并引导刷新，绝不静默删错数据
  let fresh = null;
  try {
    const raw2 = await mmCallApi('get_memory', [], MM_LIST_TIMEOUT_MS);
    let f = [];
    try { f = JSON.parse(raw2 || '[]'); } catch (e) { f = []; }
    fresh = Array.isArray(f) ? f : [];
  } catch (e) {
    mmToast('读取记忆列表失败，请稍后重试', 'warn');
    return;   // 重取失败：保守放弃本次删除（不动数据）
  }
  const stale = fresh.length !== mmLastItems.length ||
    fresh.some((it, i) => mmEntryText(it) !== mmEntryText(mmLastItems[i]));
  if (stale) {
    mmLastItems = fresh;
    memoryPanelRenderList(fresh);
    mmToast('记忆列表已变化，请刷新后重试', 'warn');
    return;
  }
  mmBusy = true;
  const seq = ++memoryReqSeq;
  memoryPanelSetState('pending');
  try {
    const raw = await mmCallApi('memory_delete', [index], MM_WRITE_TIMEOUT_MS);
    if (seq !== memoryReqSeq) return;
    let d = {};
    try { d = JSON.parse(raw || '{}'); } catch (e) { d = {}; }
    if (d && d.ok) {
      mmToast('已删除（剩余 ' + (d.remaining || 0) + ' 条）', 'ok');
      await memoryPanelRefresh();
      memoryDbStatRefresh();   // R39：删除传播（指纹重建）→ 扩展区同步
    } else {
      const er = (d && d.error) || {};
      memoryPanelRenderError({ code: er.code || 'INTERNAL',
        message: er.message || '删除失败', hint: er.hint });
      memoryPanelSetState('error');
    }
  } catch (e) {
    if (seq !== memoryReqSeq) return;
    memoryPanelRenderError({ code: 'BRIDGE_TIMEOUT',
      message: (e && e.message) || String(e) });
    memoryPanelSetState('error');
  } finally {
    mmBusy = false;
  }
}
