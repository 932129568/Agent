/* ================= MCP 服务器设置面板（v1.3 R5，插在 28 后 30 前） =================
 * 设置页「MCP 服务器」区块：列表（状态灯/传输/工具数/开关/编辑/删除/测试连接）、
 * 添加编辑表单（stdio: command+args+env；HTTP: url+headers）、逐工具档位覆盖、
 * 导入 Claude 配置模态、instructions 展示（仅展示，不注入系统提示）。
 * 实现 v1.6 T12：服务器详情页「资源」tab（与工具 tab 并列）——resources/list
 * 列表渲染、text/blob 读取展开、资源订阅（resourceSubs）勾选即存。
 * 静态 DOM 仅 4 个 id（mcpServerList/mcpAddBtn/mcpImportBtn/mcpRefreshBtn）+ mcp-* class，
 * 其余全部动态模态创建（复用 18-toast 的 _modalRoot）；错误走 toast。
 * 调 mcp_test_server/mcp_call_tool 一律传 timeoutMs=90000（后端 60s + 拉起 + 余量）。
 */

const MCP_PANEL_TIMEOUT_MS = 90000;
const MCP_TIERS = ['always', 'session', 'off'];
const MCP_TIER_NAMES = { always: '每次确认', session: '会话内首次确认', off: '不确认' };
const MCP_STATUS_NAMES = {
  ok: '已连接', error: '错误', stale: '待刷新', disabled: '未启用', untested: '未测试'
};
// 实现 v1.6 T12：text 类资源预览截断保护（超过该长度只展示头部并提示，防巨文撑爆弹层）
const MCP_RES_PREVIEW_MAX = 20000;
let mcpServersRevision = 0;
const mcpGenerativeState = { show: false, projection: null, box: null, host: null, generate: null, raw: null, aiController: null };

function mcpGenerativeRender() {
  const state = mcpGenerativeState;
  if (!state.host) return null;
  if (state.aiController && state.aiController.isBusy()) return state.projection;
  const spec = UiSpecFixtures.mcp({
    servers: typeof AppState !== 'undefined' ? AppState.mcpServers : mcpServers,
    revision: Math.max(mcpServersRevision, state.projection && state.projection.current
      ? state.projection.current.revision : 0),
    error: typeof AppState !== 'undefined' ? AppState.mcpLoadFailed : mcpLoadFailed,
    sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'current-session',
  });
  const options = { dataRefHost: createUiDataRefHost({
    runId: spec.runId, sessionId: spec.sessionId, generation: spec.generation,
  }) };
  if (!state.projection) state.projection = UiProjection.mount(state.host, spec, options);
  else state.projection.commit(spec);
  return state.projection;
}
function mcpGenerativeShow() {
  const state = mcpGenerativeState;
  if (state.aiController) state.aiController.cancel();
  state.show = true;
  mcpGenerativeRender();
  if (state.box) state.box.hidden = true;
  if (state.host) state.host.hidden = false;
  if (state.generate) state.generate.hidden = true;
  if (state.raw) state.raw.hidden = false;
}
function mcpGenerativeHide() {
  const state = mcpGenerativeState;
  if (state.aiController) state.aiController.cancel();
  state.show = false;
  if (state.box) state.box.hidden = false;
  if (state.host) state.host.hidden = true;
  if (state.generate) state.generate.hidden = false;
  if (state.raw) state.raw.hidden = true;
}
function mcpGenerativeEnsure(box) {
  const state = mcpGenerativeState;
  state.box = box;
  if (state.host && state.host.parentNode) return;
  // DOM 重建或旧测试桩未挂载父节点时，原列表行为优先；不强行插入生成控件。
  state.host = null; state.generate = null; state.raw = null; state.projection = null;
  if (!box || !box.parentNode) return;
  const wrap = document.createElement('div');
  wrap.className = 'ui-view-controls';
  const generate = document.createElement('button');
  generate.type = 'button'; generate.className = 'pill-btn'; generate.textContent = '生成视图';
  generate.setAttribute('aria-label', '生成 MCP 视图');
  const raw = document.createElement('button');
  raw.type = 'button'; raw.className = 'pill-btn'; raw.textContent = '原始视图'; raw.hidden = true;
  const ai = document.createElement('button');
  ai.type = 'button'; ai.className = 'pill-btn'; ai.id = 'mcpAiGenerateBtn';
  ai.textContent = 'AI生成'; ai.setAttribute('aria-label', '使用 AI 生成 MCP 视图');
  const aiCancel = document.createElement('button');
  aiCancel.type = 'button'; aiCancel.className = 'pill-btn'; aiCancel.id = 'mcpAiCancelBtn';
  aiCancel.textContent = '取消生成'; aiCancel.hidden = true;
  const host = document.createElement('div'); host.className = 'mcp-generative-host'; host.hidden = true;
  state.aiController = typeof createUiGenerationController === 'function' ? createUiGenerationController({
    kind: 'mcp', host, button: ai, cancelButton: aiCancel,
    fallback: () => UiSpecFixtures.mcp({
      servers: typeof AppState !== 'undefined' ? AppState.mcpServers : mcpServers,
      revision: Math.max(mcpServersRevision, state.projection && state.projection.current
      ? state.projection.current.revision : 0),
      error: typeof AppState !== 'undefined' ? AppState.mcpLoadFailed : mcpLoadFailed,
      sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'current-session',
    }),
    actionHandlers: {
      refresh: () => loadMcpServers(),
      copy: context => navigator.clipboard.writeText(context.text),
      export: () => exportSessionMd(typeof AppState !== 'undefined' ? AppState.currentSessionId : null),
    },
    actionPermission: (name, block) => {
      if (!block.bind) return !(typeof AppState !== 'undefined' ? AppState.mcpLoadFailed : mcpLoadFailed);
      const spec = state.projection && state.projection.current;
      return createUiDataRefHost({ runId: spec && spec.runId,
        sessionId: spec && spec.sessionId, generation: spec && spec.generation,
      }).permission(block.bind) === true;
    },
    onResult: result => { if (result.projection) state.projection = result.projection; },
  }) : null;
  if (!state.aiController) { ai.hidden = true; aiCancel.hidden = true; }
  generate.onclick = mcpGenerativeShow; raw.onclick = mcpGenerativeHide;
  ai.onclick = () => { mcpGenerativeShow(); state.aiController.start(); };
  aiCancel.onclick = () => state.aiController.cancel();
  wrap.appendChild(generate); wrap.appendChild(raw);
  wrap.appendChild(ai); wrap.appendChild(aiCancel);
  box.parentNode.insertBefore(wrap, box);
  box.parentNode.insertBefore(host, box);
  state.host = host; state.generate = generate; state.raw = raw;
}

/** 加载服务器列表（面板打开/刷新时调用；纯本地读取零网络）。 */
async function loadMcpServers() {
  const box = document.getElementById('mcpServerList');
  if (!box) return;
  // 修复 ㊿（三轮）：失败标记供渲染层区分「加载失败」与「真的没有服务器」
  mcpLoadFailed = false;
  try {
    const raw = await callApi('mcp_list_servers', []);
    const d = JSON.parse(raw) || {};
    mcpServers = d.servers || [];
  } catch (e) {
    mcpServers = [];
    mcpLoadFailed = true;
    toast('MCP 服务器列表加载失败：' + (e.message || e) + '（后端可能为旧版，请重新打包）', 'err');
  }
  mcpServersRevision++;
  renderMcpServerList();
}

function mcpStatusDotCls(status) {
  return status === 'ok' ? 'ok' : status === 'error' ? 'err'
    : status === 'stale' ? 'stale' : 'off';
}

function renderMcpServerList() {
  const box = document.getElementById('mcpServerList');
  if (!box) return;
  mcpGenerativeEnsure(box);
  box.innerHTML = '';
  // 修复 ㊿（三轮）：加载失败（mcpServers=[] 且失败标记）时显示错误态——
  // 原一律渲染「还没有服务器」空态，用户误以为真没配置
  if (mcpLoadFailed) {
    const err = document.createElement('div');
    err.className = 'mcp-empty';
    err.style.color = 'var(--err)';
    err.textContent = 'MCP 服务器列表加载失败（后端可能为旧版，请重新打包）。配置未丢失，恢复后自动显示。';
    box.appendChild(err);
    if (mcpGenerativeState.show) mcpGenerativeRender();
    return;
  }
  if (!mcpServers.length) {
    const empty = document.createElement('div');
    empty.className = 'mcp-empty';
    empty.textContent = '还没有 MCP 服务器。点「添加服务器」手动配置，或「导入 Claude 配置」一键迁移。';
    box.appendChild(empty);
    if (mcpGenerativeState.show) mcpGenerativeRender();
    return;
  }
  mcpServers.forEach(s => box.appendChild(mcpServerRow(s)));
  if (mcpGenerativeState.show) mcpGenerativeRender();
}

function mcpServerRow(s) {
  const row = document.createElement('div');
  row.className = 'mcp-row';
  const dot = document.createElement('span');
  dot.className = 'mcp-dot ' + mcpStatusDotCls(s.status);
  dot.title = MCP_STATUS_NAMES[s.status] || s.status;
  const main = document.createElement('div');
  main.className = 'mcp-main';
  const name = document.createElement('div');
  name.className = 'mcp-name';
  name.textContent = s.name;
  const meta = document.createElement('div');
  meta.className = 'mcp-meta';
  const transport = s.transport === 'http' ? 'HTTP' : 'stdio';
  meta.textContent = transport + ' · ' + s.tool_count + ' 个工具 · ' +
    (MCP_STATUS_NAMES[s.status] || s.status) + (s.last_error ? '（' + s.last_error + '）' : '');
  main.appendChild(name); main.appendChild(meta);
  const actions = document.createElement('div');
  actions.className = 'mcp-actions';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = !!s.enabled;
  toggle.title = '启用/停用';
  toggle.onchange = () => {
    // 修复 建议㉙（二轮）：在途忽略点击时同步 revert checkbox 视觉状态
    // （原只 return，checkbox 停在用户点出的新态，与后端实际状态失步）
    if (mcpToggleServer._busy && mcpToggleServer._busy.has(s.name)) {
      toggle.checked = !!s.enabled;
      return;
    }
    mcpToggleServer(s.name, toggle.checked);
  };
  const detailBtn = document.createElement('button');
  detailBtn.className = 'modal-btn';
  detailBtn.textContent = '详情';
  detailBtn.onclick = () => mcpOpenDetail(s.name);
  const editBtn = document.createElement('button');
  editBtn.className = 'modal-btn';
  editBtn.textContent = '编辑';
  editBtn.onclick = () => mcpOpenEditor(s.name);
  const delBtn = document.createElement('button');
  delBtn.className = 'modal-btn';
  delBtn.textContent = '删除';
  delBtn.onclick = () => mcpDeleteServer(s.name);
  actions.appendChild(toggle); actions.appendChild(detailBtn);
  actions.appendChild(editBtn); actions.appendChild(delBtn);
  row.appendChild(dot); row.appendChild(main); actions && row.appendChild(actions);
  return row;
}

/** 开关：先取解密详情再整单保存（enabled 翻转；失败回弹 + toast 人话）。修复 ㉜：在途保护防连点并发写。 */
async function mcpToggleServer(name, on) {
  mcpToggleServer._busy = mcpToggleServer._busy || new Set();
  if (mcpToggleServer._busy.has(name)) return;   // 修复 ㉜：同服务器开关在途时忽略后续点击，完成后由 loadMcpServers 重渲染回弹
  mcpToggleServer._busy.add(name);
  try {
  let detail = null;
  try {
    detail = JSON.parse(await callApi('mcp_get_server_detail', [name])) || {};
  } catch (e) {
    toast('读取服务器配置失败：' + (e.message || e), 'err');
    loadMcpServers();
    return;
  }
  if (detail.error) { toast(detail.error, 'err'); loadMcpServers(); return; }
  const cfg = detail.config || {};
  cfg.enabled = on;
  if (on && cfg.url === undefined && cfg.command === undefined) {
    toast('配置缺少 command/url，无法启用', 'err'); loadMcpServers(); return;
  }
  try {
    const r = JSON.parse(await callApi('mcp_save_server', [name, JSON.stringify(cfg)], MCP_PANEL_TIMEOUT_MS)) || {};
    if (r.error) {
      toast('启用失败：' + r.error, 'err', { detail: r.error });
    } else if (on) {
      toast('已启用 ' + name + '（' + ((r.tools || []).length) + ' 个工具）', 'ok');
    } else {
      toast('已停用 ' + name, 'ok');
    }
  } catch (e) {
    toast('启用失败：' + (e.message || e), 'err');
  }
  loadMcpServers();
  } finally {
    mcpToggleServer._busy.delete(name);
  }
}

async function mcpDeleteServer(name) {
  // 修复 ⑱（三轮）：busy 守卫——原无保护，双击删除按钮会弹两个确认框
  // （第一个删除后第二个对已删名再确认，误导用户）
  // 修复（四轮）：独立 _busy——原与 mcpToggleServer 共用 Set，开关在途会
  // 把删除也静默吞掉（用户点了没反应）；删除改用私有 busy 互不干扰
  mcpDeleteServer._busy = mcpDeleteServer._busy || new Set();
  if (mcpDeleteServer._busy.has(name)) {
    toast('该服务器操作正在进行中，请稍候…', 'info'); return;
  }
  mcpDeleteServer._busy.add(name);
  try {
  const r = await uiConfirm({
    title: '删除 MCP 服务器', body: '确认删除「' + name + '」？\n其配置（含档位覆盖）将一并移除，此操作不可恢复。',
    danger: true, okText: '删除'
  });
  if (!r.ok) return;
  try {
    const out = JSON.parse(await callApi('mcp_delete_server', [name])) || {};
    toast(out.error ? ('删除失败：' + out.error) : ('已删除 ' + name), out.error ? 'err' : 'ok');
  } catch (e) {
    toast('删除失败：' + (e.message || e), 'err');
  }
  loadMcpServers();
  } finally {
    mcpDeleteServer._busy.delete(name);
  }
}

async function mcpTestServer(name) {
  mcpTestServer._busy = mcpTestServer._busy || new Set();
  if (mcpTestServer._busy.has(name)) return;   // 修复 ㉜：测试在途时忽略重复点击（原连点会叠出多条请求与 toast）
  mcpTestServer._busy.add(name);
  try {
  toast('正在测试连接 ' + name + ' …', 'info', { stay: true });
  try {
    const r = JSON.parse(await callApi('mcp_test_server', [name], MCP_PANEL_TIMEOUT_MS)) || {};
    if (r.error) {
      toast('连接失败：' + r.error, 'err', { detail: r.error });
      if (r.supported && r.supported.length) {
        toast('服务器支持版本：' + r.supported.join('、'), 'warn');
      }
    } else {
      toast('连接成功：' + name + '（' + (r.tools || []).length + ' 个工具）', 'ok');
    }
  } catch (e) {
    toast('连接失败：' + (e.message || e), 'err');
  }
  loadMcpServers();
  } finally {
    mcpTestServer._busy.delete(name);
  }
}

/* ---- 详情模态：工具档位覆盖 + instructions 展示 ---- */
async function mcpOpenDetail(name) {
  let d = null;
  try {
    d = JSON.parse(await callApi('mcp_get_server_detail', [name])) || {};
  } catch (e) {
    toast('读取详情失败：' + (e.message || e), 'err');
    return;
  }
  if (d.error) { toast(d.error, 'err'); return; }
  const m = _modalRoot();
  m.innerHTML =
    '<div class="modal-mask"></div>' +
    '<div class="modal-card" role="dialog" aria-modal="true">' +
    '  <div class="modal-title"></div>' +
    '  <div class="modal-body">' +
    // 实现 v1.6 T12：详情页双 tab（工具 / 资源）；新 id 全唯一，UI 契约只增不改
    '    <div class="mcp-tabs" role="tablist">' +
    '      <button type="button" class="mcp-tab on" id="mcpTabTools" role="tab">工具与档位</button>' +
    '      <button type="button" class="mcp-tab" id="mcpTabRes" role="tab">资源</button>' +
    '    </div>' +
    '    <div id="mcpPaneTools" role="tabpanel"></div>' +
    '    <div id="mcpPaneRes" role="tabpanel" style="display:none"></div>' +
    '  </div>' +
    '  <div class="modal-btns">' +
    '    <button class="modal-btn modal-test">测试连接</button>' +
    '    <button class="modal-btn modal-ok primary">关闭</button>' +
    '  </div></div>';
  m.querySelector('.modal-title').textContent = 'MCP 服务器 · ' + name;
  const toolsPane = m.querySelector('#mcpPaneTools');
  const resPane = m.querySelector('#mcpPaneRes');
  // tab 切换：工具页（原内容）↔ 资源页（打开时拉 resources/list）
  const mcpShowTab = (which) => {
    const tabTools = m.querySelector('#mcpTabTools');
    const tabRes = m.querySelector('#mcpTabRes');
    tabTools.classList.toggle('on', which === 'tools');
    tabRes.classList.toggle('on', which === 'res');
    toolsPane.style.display = which === 'tools' ? '' : 'none';
    resPane.style.display = which === 'res' ? '' : 'none';
  };
  m.querySelector('#mcpTabTools').onclick = () => mcpShowTab('tools');
  let mcpResLoaded = false;   // 每次打开详情只拉一次资源列表（切 tab 不重复请求）
  m.querySelector('#mcpTabRes').onclick = () => {
    mcpShowTab('res');
    if (mcpResLoaded) return;
    mcpResLoaded = true;
    const subs = (d.config && d.config.resourceSubs) || [];
    mcpResOpen(name, resPane, subs);
  };
  const info = document.createElement('div');
  info.className = 'set-hint';
  info.textContent = '状态：' + (MCP_STATUS_NAMES[d.status] || d.status) +
    ' · 传输：' + (d.transport === 'http' ? 'HTTP' : 'stdio') +
    (d.server_info && d.server_info.name ? ' · 服务器：' + d.server_info.name : '') +
    (d.last_error ? ' · ' + d.last_error : '');
  toolsPane.appendChild(info);
  if (d.decrypt_failed && d.decrypt_failed.length) {
    const warn = document.createElement('div');
    warn.className = 'set-hint';
    warn.style.color = 'var(--warn)';
    warn.textContent = '以下密钥解密失败（可能更换了机器或 Windows 用户），请重新填写：' +
      d.decrypt_failed.join('、');
    toolsPane.appendChild(warn);
  }
  if (d.instructions) {
    const ins = document.createElement('div');
    ins.className = 'mcp-instructions';
    const t = document.createElement('div');
    t.style.fontWeight = '600';
    t.style.margin = '8px 0 4px';
    t.textContent = '服务器 instructions';
    const c = document.createElement('div');
    c.className = 'set-hint';
    c.textContent = d.instructions;
    const note = document.createElement('div');
    note.className = 'set-hint';
    note.textContent = '（仅展示，不会注入系统提示）';
    ins.appendChild(t); ins.appendChild(c); ins.appendChild(note);
    toolsPane.appendChild(ins);
  }
  const toolsTitle = document.createElement('div');
  toolsTitle.style.fontWeight = '600';
  toolsTitle.style.margin = '10px 0 4px';
  toolsTitle.textContent = '工具与档位（' + (d.tools || []).length + '）';
  toolsPane.appendChild(toolsTitle);
  const list = document.createElement('div');
  list.className = 'mcp-tool-list';
  (d.tools || []).forEach(t => {
    const row = document.createElement('div');
    row.className = 'mcp-tool-row';
    const left = document.createElement('div');
    left.className = 'mcp-main';
    const nm = document.createElement('div');
    nm.className = 'mcp-tool-name';
    nm.textContent = t.name;
    const ds = document.createElement('div');
    ds.className = 'mcp-tool-desc';
    ds.textContent = (t.description || '').slice(0, 120) +
      (t.tier_source === 'override' ? ' · 用户覆盖' : t.tier_source === 'annotation' ? ' · 注解推导' : ' · 保守默认');
    left.appendChild(nm); left.appendChild(ds);
    const sel = document.createElement('select');
    MCP_TIERS.forEach(tier => {
      const o = document.createElement('option');
      o.value = tier;
      o.textContent = MCP_TIER_NAMES[tier];
      if (tier === t.tier) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => mcpSetToolTier(name, t.name, sel.value);
    row.appendChild(left); row.appendChild(sel);
    list.appendChild(row);
  });
  if (!(d.tools || []).length) {
    const empty = document.createElement('div');
    empty.className = 'set-hint';
    empty.textContent = '尚未缓存工具列表——点「测试连接」拉取。';
    list.appendChild(empty);
  }
  toolsPane.appendChild(list);
  const done = () => _closeModal();
  m.querySelector('.modal-ok').onclick = done;
  m.querySelector('.modal-mask').onclick = done;
  m.querySelector('.modal-test').onclick = () => { _closeModal(); mcpTestServer(name); };
}

async function mcpSetToolTier(server, tool, tier) {
  try {
    const r = JSON.parse(await callApi('mcp_set_tool_tier', [server, tool, tier])) || {};
    if (r.error) toast('档位保存失败：' + r.error, 'err');
    else toast(server + ' · ' + tool + ' 档位已设为「' + MCP_TIER_NAMES[tier] + '」', 'ok');
  } catch (e) {
    toast('档位保存失败：' + (e.message || e), 'err');
  }
}

/* ---- 资源 tab（实现 v1.6 T12）----
 * 打开时调 mcp_list_resources 渲染（uri + name + mimeType）；
 * 每条资源可「读取」（text 类展开 + 截断保护；blob 类给落盘提示与打开目录）；
 * 订阅 checkbox 变更即调 mcp_save_subscriptions 持久化 resourceSubs。
 */
let mcpResSubs = [];      // 当前 tab 的订阅 uri 列表（checkbox 唯一真相源）
let mcpResBusyUri = '';   // 正在读取的 uri（读取中禁用按钮，防连点并发）

/** 小工具：建元素（tag/类名/文本一次性到位）。 */
function mcpResEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 顶部说明行：「已订阅 N 个资源将注入对话上下文」。 */
function mcpResRenderSubCount(box) {
  box.textContent = '已订阅 ' + mcpResSubs.length + ' 个资源将注入对话上下文';
}

/** 在 row 的 children 里找已存在的输出容器（桩/真实 DOM 通用，不依赖 querySelector）。 */
function mcpResFindOut(row) {
  for (let i = 0; i < row.children.length; i++) {
    const c = row.children[i];
    if (c && c.className && String(c.className).indexOf('mcp-res-out') >= 0) return c;
  }
  return null;
}

/** 打开/刷新资源 tab：拉列表 → 渲染；supported=false 给人话提示（非错误红）。 */
async function mcpResOpen(server, pane, subs) {
  pane.innerHTML = '';
  mcpResSubs = Array.isArray(subs) ? subs.filter(u => typeof u === 'string' && u.trim()) : [];
  const loading = mcpResEl('div', 'set-hint', '正在读取资源列表 …');
  pane.appendChild(loading);
  let d = null;
  try {
    d = JSON.parse(await callApi('mcp_list_resources', [server])) || {};
  } catch (e) {
    pane.innerHTML = '';
    const err = mcpResEl('div', 'set-hint', '资源列表读取失败：' + (e.message || e) +
      '（后端可能为旧版，请重新打包）');
    err.style.color = 'var(--err)';
    pane.appendChild(err);
    return;
  }
  if (d.error) {
    pane.innerHTML = '';
    const err = mcpResEl('div', 'set-hint', '资源列表读取失败：' + d.error);
    err.style.color = 'var(--err)';
    pane.appendChild(err);
    return;
  }
  pane.innerHTML = '';
  if (d.supported === false) {
    // -32601 降级：服务器不提供 resources 是合法形态，人话提示而非错误态
    pane.appendChild(mcpResEl('div', 'set-hint',
      '该服务器不支持 resources（没有可订阅的资源），不影响工具使用。'));
    return;
  }
  const countBox = mcpResEl('div', 'set-hint');
  countBox.style.margin = '8px 0 0';
  mcpResRenderSubCount(countBox);
  pane.appendChild(countBox);
  const resources = (d.resources || []).filter(r => r && typeof r.uri === 'string');
  if (!resources.length) {
    pane.appendChild(mcpResEl('div', 'set-hint', '该服务器未提供资源。'));
    return;
  }
  const box = mcpResEl('div', 'mcp-res-list');
  resources.forEach(r => box.appendChild(mcpResRow(server, r, countBox)));
  pane.appendChild(box);
}

/** 单资源行：订阅勾选 + uri/name/mimeType + 读取按钮。 */
function mcpResRow(server, r, countBox) {
  const row = mcpResEl('div', 'mcp-res-row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = mcpResSubs.indexOf(r.uri) >= 0;
  cb.title = '订阅后该资源将注入对话上下文';
  cb.onchange = () => mcpResToggleSub(server, r.uri, cb.checked, cb, countBox);
  const main = mcpResEl('div', 'mcp-main');
  const nm = mcpResEl('div', 'mcp-tool-name', r.name || r.uri);
  const meta = mcpResEl('div', 'mcp-tool-desc', r.uri + (r.mimeType ? ' · ' + r.mimeType : ''));
  main.appendChild(nm);
  main.appendChild(meta);
  const btn = mcpResEl('button', 'modal-btn', '读取');
  btn.onclick = () => mcpResRead(server, r, btn, row);
  row.appendChild(cb);
  row.appendChild(main);
  row.appendChild(btn);
  return row;
}

/** 读取资源：text 类直接展开（截断保护）；blob 类显示落盘提示 + 打开目录。 */
async function mcpResRead(server, r, btn, row) {
  if (mcpResBusyUri && mcpResBusyUri === r.uri) return;   // 防连点：同资源在途忽略
  mcpResBusyUri = r.uri;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '读取中…';
  try {
    const raw = await callApi('mcp_read_resource', [server, r.uri], MCP_PANEL_TIMEOUT_MS);
    const d = JSON.parse(raw) || {};
    if (d.error) throw new Error(d.error);
    const out = mcpResFindOut(row) || mcpResEl('div', 'mcp-res-out');
    out.innerHTML = '';
    if (d.blob_cached || d.cache_id) {
      // blob 类：后端已 base64 解码并落盘 toolcache（对话内可 read_more 分段取）
      out.appendChild(mcpResEl('div', 'mcp-res-blob',
        '已保存至工具缓存（id ' + (d.cache_id || '?') + '，' + (d.blob_bytes || 0) + ' 字节）'));
      out.appendChild(mcpResEl('div', 'set-hint',
        d.hint || '完整内容可在对话中通过 read_more 分段读取。'));
      const openBtn = mcpResEl('button', 'modal-btn mcp-res-open', '打开目录');
      openBtn.onclick = () => mcpResOpenToolcache();
      out.appendChild(openBtn);
    } else {
      const text = String(d.text == null ? '' : d.text);
      out.appendChild(mcpResEl('div', 'mcp-res-text',
        text.length > MCP_RES_PREVIEW_MAX
          ? text.slice(0, MCP_RES_PREVIEW_MAX) + '\n…（内容过长已截断，完整内容可在对话中读取）'
          : (text || '（空内容）')));
    }
    row.appendChild(out);
  } catch (e) {
    toast('资源读取失败：' + (e.message || e), 'err');
    const out = mcpResFindOut(row) || mcpResEl('div', 'mcp-res-out');
    out.innerHTML = '';
    const err = mcpResEl('div', 'set-hint', '读取失败：' + (e.message || e));
    err.style.color = 'var(--err)';
    out.appendChild(err);
    row.appendChild(out);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    mcpResBusyUri = '';
  }
}

/** 打开工具缓存目录（%USERPROFILE%\.glm-chat\toolcache；run_command shell 展开环境变量）。 */
async function mcpResOpenToolcache() {
  try {
    const r = JSON.parse(await callApi('run_command',
      ['explorer "%USERPROFILE%\\.glm-chat\\toolcache"'])) || {};
    if (r.error) { toast('打开目录失败：' + r.error, 'err'); return; }
    if (r.skipped) { toast('刚刚已打开过目录：' + (r.info || ''), 'warn'); return; }
    toast('已打开工具缓存目录', 'ok');
  } catch (e) {
    toast('打开目录失败：' + (e.message || e), 'err');
  }
}

/** 订阅勾选变更：先改本地真相源 + 计数行，再持久化；失败回弹 checkbox 与计数。 */
async function mcpResToggleSub(server, uri, on, cb, countBox) {
  const i = mcpResSubs.indexOf(uri);
  if (on && i < 0) mcpResSubs.push(uri);
  if (!on && i >= 0) mcpResSubs.splice(i, 1);
  mcpResRenderSubCount(countBox);
  try {
    const r = JSON.parse(await callApi('mcp_save_subscriptions',
      [server, JSON.stringify(mcpResSubs)])) || {};
    if (r.error) throw new Error(r.error);
    toast(on ? ('已订阅 ' + uri) : ('已取消订阅 ' + uri), 'ok');
  } catch (e) {
    // 回滚：后端没存上，前端视觉与落盘保持一致
    const j = mcpResSubs.indexOf(uri);
    if (on && j >= 0) mcpResSubs.splice(j, 1);
    if (!on && j < 0) mcpResSubs.push(uri);
    if (cb) cb.checked = !on;
    mcpResRenderSubCount(countBox);
    toast('订阅保存失败：' + (e.message || e), 'err');
  }
}

/* ---- 添加/编辑模态 ---- */
async function mcpOpenEditor(name) {
  let existing = null;
  if (name) {
    try {
      const d = JSON.parse(await callApi('mcp_get_server_detail', [name])) || {};
      if (d.error) { toast(d.error, 'err'); return; }
      existing = d.config || {};
    } catch (e) {
      toast('读取配置失败：' + (e.message || e), 'err');
      return;
    }
  }
  const cfg = existing || {};
  const isHttp = !!cfg.url;
  const m = _modalRoot();
  m.innerHTML =
    '<div class="modal-mask"></div>' +
    '<div class="modal-card" role="dialog" aria-modal="true">' +
    '  <div class="modal-title"></div>' +
    '  <div class="modal-body">' +
    '    <label>服务器名称（用作工具名前缀 mcp__名称__工具）</label>' +
    '    <input class="modal-input" id="mcpEdName">' +
    '    <label style="margin-top:10px;">传输类型</label>' +
    '    <select id="mcpEdTransport">' +
    '      <option value="stdio">stdio（本地命令，如 npx/uvx）</option>' +
    '      <option value="http">Streamable HTTP（远程 URL）</option>' +
    '    </select>' +
    '    <div id="mcpEdStdio">' +
    '      <label style="margin-top:10px;">启动命令（command）</label>' +
    '      <input class="modal-input" id="mcpEdCommand" placeholder="npx">' +
    '      <label style="margin-top:10px;">参数（每行一个）</label>' +
    '      <textarea class="mcp-kv" id="mcpEdArgs" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;C:\\Work"></textarea>' +
    '      <label style="margin-top:10px;">环境变量（每行 KEY=VALUE；落盘经 DPAPI 加密）</label>' +
    '      <textarea class="mcp-kv" id="mcpEdEnv" rows="3" placeholder="API_TOKEN=xxx"></textarea>' +
    '    </div>' +
    '    <div id="mcpEdHttp" style="display:none">' +
    '      <label style="margin-top:10px;">服务器 URL</label>' +
    '      <input class="modal-input" id="mcpEdUrl" placeholder="https://mcp.example.com/mcp">' +
    '      <label style="margin-top:10px;">请求头（每行 KEY=VALUE；落盘经 DPAPI 加密）</label>' +
    '      <textarea class="mcp-kv" id="mcpEdHeaders" rows="3" placeholder="Authorization=Bearer xxx"></textarea>' +
    '    </div>' +
    '    <label class="check-row" style="margin-top:10px;">' +
    '      <input type="checkbox" id="mcpEdEnabled"> 保存后启用（将测试连接，失败则保持停用）' +
    '    </label>' +
    '    <label style="margin-top:10px;">工具调用超时（秒，10-300，默认 60）</label>' +
    '    <input class="modal-input" id="mcpEdCallTimeout" type="number" min="10" max="300" step="1" placeholder="60">' +
    '    <div class="set-hint" style="margin-top:4px;">慢服务器（大仓库检索/长命令）可调大；越界保存时会被拒绝并提示范围。</div>' +
    '    <div class="set-hint" style="margin-top:8px;">' +
    '      Claude Desktop 兼容结构；密钥只加密 env/header 的值，命令与参数保持明文可手改。<br>' +
    '      缺运行时时会提示缺什么、去哪装（Node.js https://nodejs.org / uv https://astral.sh/uv）。' +
    '    </div>' +
    '  </div>' +
    '  <div class="modal-btns">' +
    '    <button class="modal-btn modal-cancel">取消</button>' +
    '    <button class="modal-btn modal-ok primary">保存</button>' +
    '  </div></div>';
  m.querySelector('.modal-title').textContent = name ? ('编辑 MCP 服务器 · ' + name) : '添加 MCP 服务器';
  const nameInput = m.querySelector('#mcpEdName');
  nameInput.value = name || '';
  if (name) nameInput.disabled = true;               // 改名 = 删除后重新添加（避免键漂移）
  const transportSel = m.querySelector('#mcpEdTransport');
  const stdioBox = m.querySelector('#mcpEdStdio');
  const httpBox = m.querySelector('#mcpEdHttp');
  const syncTransport = () => {
    stdioBox.style.display = transportSel.value === 'http' ? 'none' : '';
    httpBox.style.display = transportSel.value === 'http' ? '' : 'none';
    // 修复 建议㉚（二轮）：切传输类型时清掉隐藏一侧的输入——否则用户先填 stdio
    // 再切 HTTP，视觉上 HTTP 表单空但误以为 stdio 内容仍会保存（保存只取当前侧，
    // 清掉可避免「我以为保存了其实没有」的错觉）
    if (transportSel.value === 'http') {
      m.querySelector('#mcpEdCommand').value = '';
      m.querySelector('#mcpEdArgs').value = '';
      m.querySelector('#mcpEdEnv').value = '';
    } else {
      m.querySelector('#mcpEdUrl').value = '';
      m.querySelector('#mcpEdHeaders').value = '';
    }
  };
  transportSel.value = isHttp ? 'http' : 'stdio';
  syncTransport();
  transportSel.onchange = syncTransport;
  m.querySelector('#mcpEdCommand').value = cfg.command || '';
  m.querySelector('#mcpEdArgs').value = (cfg.args || []).join('\n');
  m.querySelector('#mcpEdEnv').value = mcpMappingToText(cfg.env || {});
  m.querySelector('#mcpEdUrl').value = cfg.url || '';
  m.querySelector('#mcpEdHeaders').value = mcpMappingToText(cfg.headers || {});
  m.querySelector('#mcpEdEnabled').checked = !!cfg.enabled;
  m.querySelector('#mcpEdCallTimeout').value = cfg.callTimeout != null ? cfg.callTimeout : '';
  m.querySelector('.modal-cancel').onclick = _closeModal;
  m.querySelector('.modal-mask').onclick = _closeModal;
  m.querySelector('.modal-ok').onclick = async () => {
    const nm = nameInput.value.trim();
    if (!nm) { toast('服务器名称不能为空', 'warn'); return; }
    const payload = { enabled: m.querySelector('#mcpEdEnabled').checked };
    // 修复 F2（v1.4）：callTimeout 可选字段——留空则不写入（后端回落默认 60）；
    // 越界由后端 _normalize 人话拒绝（验收：5/999 被拒）
    const _ctRaw = m.querySelector('#mcpEdCallTimeout').value.trim();
    if (_ctRaw) {
      const _ct = parseInt(_ctRaw, 10);
      if (isNaN(_ct) || _ct < 10 || _ct > 300) {
        toast('工具调用超时必须是 10-300 的整数（秒）', 'warn');
        return;
      }
      payload.callTimeout = _ct;
    }
    if (transportSel.value === 'http') {
      payload.url = m.querySelector('#mcpEdUrl').value.trim();
      payload.headers = mcpTextToMapping(m.querySelector('#mcpEdHeaders').value);
      if (!payload.url) { toast('请填写服务器 URL', 'warn'); return; }
    } else {
      payload.command = m.querySelector('#mcpEdCommand').value.trim();
      payload.args = m.querySelector('#mcpEdArgs').value.split('\n').map(s => s.trim()).filter(Boolean);
      payload.env = mcpTextToMapping(m.querySelector('#mcpEdEnv').value);
      if (!payload.command) { toast('请填写启动命令', 'warn'); return; }
    }
    try {
      const r = JSON.parse(await callApi('mcp_save_server', [nm, JSON.stringify(payload)], MCP_PANEL_TIMEOUT_MS)) || {};
      if (r.error) {
        toast('保存失败：' + r.error, 'err', { detail: r.error });
        return;                                       // 不关模态，便于修正
      }
      _closeModal();
      toast(payload.enabled
        ? ('已保存并启用 ' + nm + '（' + ((r.tools || []).length) + ' 个工具）')
        : ('已保存 ' + nm + '（默认停用，可随时打开开关启用）'), 'ok');
      loadMcpServers();
    } catch (e) {
      toast('保存失败：' + (e.message || e), 'err');
    }
  };
}

/* ---- 导入 Claude 配置模态 ---- */
function mcpOpenImport() {
  const m = _modalRoot();
  m.innerHTML =
    '<div class="modal-mask"></div>' +
    '<div class="modal-card" role="dialog" aria-modal="true">' +
    '  <div class="modal-title">导入 Claude 配置</div>' +
    '  <div class="modal-body">' +
    '    <div class="set-hint">粘贴 claude_desktop_config.json 全文（含 mcpServers 段）。' +
    '    默认路径：<code>%APPDATA%\\Claude\\claude_desktop_config.json</code>。<br>' +
    '    同名服务器跳过；SSE 类型条目不受支持（v1.3 仅 stdio / Streamable HTTP）；导入后默认停用。</div>' +
    '    <textarea class="mcp-kv" id="mcpImportText" rows="10" placeholder=\'{"mcpServers": {...}}\'></textarea>' +
    '    <div class="set-hint" id="mcpImportResult" style="margin-top:8px;"></div>' +
    '  </div>' +
    '  <div class="modal-btns">' +
    '    <button class="modal-btn modal-cancel">关闭</button>' +
    '    <button class="modal-btn modal-ok primary">导入</button>' +
    '  </div></div>';
  m.querySelector('.modal-cancel').onclick = _closeModal;
  m.querySelector('.modal-mask').onclick = _closeModal;
  m.querySelector('.modal-ok').onclick = async () => {
    const text = m.querySelector('#mcpImportText').value;
    const out = m.querySelector('#mcpImportResult');
    try {
      const r = JSON.parse(await callApi('mcp_import_claude', [text])) || {};
      if (r.error) {
        out.style.color = 'var(--err)';
        out.textContent = '导入失败：' + r.error;
        return;
      }
      out.style.color = '';
      // 修复 ㊿（三轮）：r.total 无兜底（后端缺字段时原样拼出「导入 undefined 条」）
      out.textContent = '导入 ' + (r.total || 0) + ' 条：成功 ' + (r.imported || []).length +
        ' 个' + ((r.skipped || []).length
          ? '；跳过 ' + r.skipped.map(s => s.name + '（' + s.reason + '）').join('；')
          : '');
      toast('Claude 配置导入完成', 'ok');
      loadMcpServers();
    } catch (e) {
      out.style.color = 'var(--err)';
      out.textContent = '导入失败：' + (e.message || e);
    }
  };
}

/* ---- env/headers 文本 ↔ 对象 ---- */
function mcpTextToMapping(text) {
  const out = {};
  String(text || '').split('\n').forEach(line => {
    const ln = line.trim();
    if (!ln || ln.startsWith('#')) return;
    const i = ln.indexOf('=');
    if (i <= 0) return;
    out[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
  });
  return out;
}
function mcpMappingToText(map) {
  return Object.keys(map || {}).map(k => k + '=' + (map[k] == null ? '' : map[k])).join('\n');
}
