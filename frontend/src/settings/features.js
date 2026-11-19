/* ================= R57 功能开关中心（settings/features.js） =================
 * 元缺口收口（R57 开关盘点 #9）：glm_feat_* 功能分级键此前**无 UI 写点**（只能
 * devtools 手改，关了就再也开不回来）。本块 = agent 功能开关的唯一 UI 面：
 * - localStorage 键直写（即时生效——工具面过滤/注入分支下一 run 生效）；
 * - 后端语义开关经既有 js_api 通道：混合路由 → hybrid_save_config({enabled})
 *   （R57 G5 后端 gate）+ 同步 glm_feat_hybrid_v18（面板挂载门，一闸两控）；
 *   记忆注入 → model_prefs_save({memory_inject})（R57 G3，_memory_inject 门）。
 * 红线：config.json 零污染（localStorage + 各自独立配置文件）。
 * 挂载：core/bootstrap.js loadAll 内 try{ featSwitchInit(); }catch。
 * vm 沙箱安全：document/localStorage/callApi 全 typeof 守卫（memory.js 同款）。 */
const FEAT_KEYS = {
  search:       { key: 'glm_feat_search_v18',        label: '浏览器搜索',   desc: 'browser_search 工具与搜索面板（GLM 端点的云端 web_search 走下方「联网搜索」）' },
  browser:      { key: 'glm_feat_browser_v18',       label: '浏览器驱动',   desc: 'browser_navigate/extract/snapshot/click/fill/screenshot/close 七原语' },
  software:     { key: 'glm_feat_software_v18',      label: '外部软件',     desc: 'software_call 与软件面板' },
  memory:       { key: 'glm_feat_memory_v18',        label: '记忆工具',     desc: 'memory_write/memory_search 工具族与记忆面板' },
  mcp:          { key: 'glm_feat_mcp_v18',           label: 'MCP 工具',     desc: 'full 档 MCP 服务器工具（超 25 个自动折叠为 mcp_search 检索）' },
  notes:        { key: 'glm_feat_notes_v18',         label: '会话笔记',     desc: '压缩纪要落盘 notes/<sid>.md，后续任务注入系统段' },
  groupSummary: { key: 'glm_feat_group_summary_v18', label: '群聊摘要回传', desc: '群聊上下文窗口外的更早发言以归档摘要行注入' },
  autoResume:   { key: 'glm_feat_autoresume_v18',    label: '自动续跑',     desc: '输出截断/网络中断后自动继续（每会话窗口内最多 2-5 次）' },
};

/* ---------- 只读原语（消费点经 typeof 守卫引用；vm 无 localStorage 返回默认开） ---------- */
function featFlagEnabled(key) {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(key);
    return v === null || v === '1';   // 缺省 = 开（与 spFeature/swFeature 同口径）
  } catch (e) { return true; }
}
function featBrowserEnabled()      { return featFlagEnabled(FEAT_KEYS.browser.key); }
function featMcpEnabled()          { return featFlagEnabled(FEAT_KEYS.mcp.key); }
function featNotesEnabled()        { return featFlagEnabled(FEAT_KEYS.notes.key); }
function featGroupSummaryEnabled() { return featFlagEnabled(FEAT_KEYS.groupSummary.key); }
function featAutoResumeEnabled()   { return featFlagEnabled(FEAT_KEYS.autoResume.key); }

/* ---------- 设置块（memory.js memoryPanelInit 同款骨架） ---------- */
function featEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}

function featSwitchInit() {
  if (featEl('featBlock')) { featSwitchWire(); return true; }   // 幂等
  if (typeof document === 'undefined') return false;
  const grid = document.querySelector('.set-grid');
  if (!grid) return false;
  const rows = [];
  for (const [slot, cfg] of Object.entries(FEAT_KEYS)) {
    const on = featFlagEnabled(cfg.key);
    rows.push('<label class="provider-row" style="align-items:flex-start;gap:8px;cursor:pointer;">' +
      '<input type="checkbox" id="feat_' + slot + '" ' + (on ? 'checked' : '') + ' style="margin-top:3px;">' +
      '<span style="flex:1;"><b style="font-size:12.5px;">' + cfg.label + '</b>' +
      '<span class="set-hint" style="display:block;margin:2px 0 0;color:var(--text-2);font-size:11.5px;">' +
      cfg.desc + '</span></span></label>');
  }
  const block = document.createElement('div');
  block.id = 'featBlock';
  block.className = 'set-block';
  block.setAttribute('data-group', '功能');
  block.innerHTML =
    '<div class="set-title">功能开关</div>' +
    '<div class="set-hint" style="margin:2px 0 8px;">关闭即时生效（下一轮对话开始生效）；开关状态存于浏览器本地，不写入 config.json。' +
    '混合路由与记忆注入的开关由后端配置承载（见下方两项）。</div>' +
    rows.join('') +
    '<label class="provider-row" style="align-items:flex-start;gap:8px;cursor:pointer;margin-top:8px;">' +
      '<input type="checkbox" id="feat_hybrid" style="margin-top:3px;">' +
      '<span style="flex:1;"><b style="font-size:12.5px;">混合路由（本地+云端分账）</b>' +
      '<span class="set-hint" style="display:block;margin:2px 0 0;color:var(--text-2);font-size:11.5px;">' +
      '关闭后全部请求走云端（写入 hybrid.json，对路由决策即时生效）</span></span></label>' +
    '<label class="provider-row" style="align-items:flex-start;gap:8px;cursor:pointer;">' +
      '<input type="checkbox" id="feat_meminject" style="margin-top:3px;">' +
      '<span style="flex:1;"><b style="font-size:12.5px;">记忆注入</b>' +
      '<span class="set-hint" style="display:block;margin:2px 0 0;color:var(--text-2);font-size:11.5px;">' +
      '把长期记忆注入系统提示（写入 model_prefs.json；记忆工具与面板不受此开关影响）</span></span></label>' +
    '<div class="mm-error" id="featError" style="display:none;margin-top:8px;"></div>';
  grid.appendChild(block);
  featSwitchWire();
  featHybridStateLoad();
  featMemInjectStateLoad();
  return true;
}

function featWireRow(slot, key) {
  const el = featEl('feat_' + slot);
  if (!el) return;
  el.addEventListener('change', () => {
    try { localStorage.setItem(key, el.checked ? '1' : '0'); } catch (e2) { /* 私有模式尽力 */ }
  });
}

function featSwitchWire() {
  for (const [slot, cfg] of Object.entries(FEAT_KEYS)) featWireRow(slot, cfg.key);
  const hy = featEl('feat_hybrid');
  if (hy) hy.addEventListener('change', () => {
    // 一闸两控：localStorage glm_feat_hybrid_v18（面板挂载门）+ hybrid.json.enabled（后端路由 gate）
    try { localStorage.setItem('glm_feat_hybrid_v18', hy.checked ? '1' : '0'); } catch (e2) {}
    featBackendSave('hybrid_save_config', { enabled: hy.checked }, hy);
  });
  const mi = featEl('feat_meminject');
  if (mi) mi.addEventListener('change', () => {
    featBackendSave('model_prefs_save', { memory_inject: mi.checked }, mi);
  });
}

async function featBackendSave(api, payload, checkboxEl) {
  try {
    const raw = await callApi(api, [JSON.stringify(payload)]);
    const d = JSON.parse(raw || '{}');
    if (d && d.error) throw new Error(d.error);
  } catch (e) {
    // 写后端失败：回拨 UI + 提示（不静默假装成功）
    if (checkboxEl) checkboxEl.checked = !checkboxEl.checked;
    const errEl = featEl('featError');
    if (errEl) { errEl.textContent = '保存失败：' + String(e && e.message ? e.message : e); errEl.style.display = 'block'; }
  }
}

async function featHybridStateLoad() {
  const el = featEl('feat_hybrid');
  if (!el) return;
  try {
    const d = JSON.parse(await callApi('hybrid_get_config', []) || '{}');
    const cfg = d && d.config ? d.config : d;
    el.checked = cfg && cfg.enabled === false ? false : true;   // 键缺失=开（缺省不变）
    if (cfg && cfg.enabled !== undefined && typeof localStorage !== 'undefined') {
      try { localStorage.setItem('glm_feat_hybrid_v18', el.checked ? '1' : '0'); } catch (e2) {}
    }
  } catch (e) { /* 旧后端/读取失败：保持 UI 现值 */ }
}

async function featMemInjectStateLoad() {
  const el = featEl('feat_meminject');
  if (!el) return;
  try {
    const d = JSON.parse(await callApi('model_prefs_get', []) || '{}');
    el.checked = d && d.memory_inject === false ? false : true;   // 键缺失=开（既有行为）
  } catch (e) { /* 保持 UI 现值 */ }
}
