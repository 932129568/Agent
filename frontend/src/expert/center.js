/* W5D auxiliary expert center and one-shot selection; no package API until opened/run. */
let expertNextSelection = null;
let expertSelectionSessionId = '';
const expertCenterState = {
  open: false, loading: false, error: '', packages: [], detail: null,
  controller: null, runPromise: null, runResult: null, lastFocus: null,
};
let expertSelectionLabelText = '';
function expertKindLabel(kind) { return kind === 'team' ? '专家团' : '单专家'; }
function expertDisplayName(meta) {
  const value = meta && meta.displayName;
  if (value && typeof value === 'object') return value.zh || value.en || '';
  return typeof value === 'string' ? value : '';
}
function expertDescriptionText(meta) {
  const m = meta || {};
  const display = m.displayDescription;
  if (display && typeof display === 'object' && display.zh) return display.zh;
  if (typeof m.description === 'string' && /[\u3400-\u9fff]/.test(m.description)) return m.description;
  if (display && typeof display === 'object' && display.en) return display.en;
  return typeof m.description === 'string' ? m.description : '无描述';
}
function expertChipLabel(detail) {
  return expertSelectionLabelText || expertDisplayName(detail && detail.metadata) ||
    (detail && detail.metadata && detail.metadata.name) || (detail && detail.id) || '专家';
}
function expertRenderSelectionChip() {
  const chip = document.getElementById('expertSelectionChip');
  if (!chip) return;
  if (!expertNextSelection) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  chip.textContent = expertChipLabel(expertCenterState.detail) + ' · 发送时自动加载';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'expert-chip-clear';
  clear.setAttribute('aria-label', '清除已选专家');
  clear.title = '清除已选专家';
  clear.textContent = '×';
  clear.addEventListener('click', clearExpertSelection);
  chip.appendChild(clear);
  chip.hidden = false;
}
function expertSession() {
  if (typeof getCurrentSession === 'function') {
    const current = getCurrentSession();
    if (current) return current;
  }
  const app = typeof AppState !== 'undefined' ? AppState : {};
  return (app.sessions || []).find(session => session.id === app.currentSessionId) || null;
}
function expertCurrentSessionId() {
  return String(typeof AppState !== 'undefined' ? AppState.currentSessionId || '' : '');
}
function expertCenterStatus(text, kind) {
  const status = document.getElementById('expertCenterStatus');
  if (status) { status.textContent = text || ''; status.dataset.kind = kind || 'info'; }
}
function expertCenterRenderList() {
  const list = document.getElementById('expertPackageList');
  if (!list) return;
  list.replaceChildren();
  if (expertCenterState.loading) { const item = document.createElement('p'); item.textContent = '正在加载专家包…'; list.appendChild(item); return; }
  if (expertCenterState.error) { const item = document.createElement('p'); item.className = 'expert-error'; item.textContent = expertCenterState.error; list.appendChild(item); return; }
  if (!expertCenterState.packages.length) { const item = document.createElement('p'); item.className = 'expert-empty'; item.textContent = '暂无专家包。只支持导入已存在的目录。'; list.appendChild(item); return; }
  expertCenterState.packages.forEach(pkg => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'expert-package-row' + (pkg.enabled ? '' : ' is-disabled');
    button.dataset.packageId = pkg.id;
    button.setAttribute('aria-label', '查看专家包 ' + pkg.name);
    const name = document.createElement('span'); name.className = 'expert-package-name'; name.textContent = pkg.name;
    const sourceLabel = pkg.source && pkg.source.kind === 'builtin' ? ' · 内置' : '';
    const meta = document.createElement('span'); meta.className = 'expert-package-meta';
    meta.textContent = expertKindLabel(pkg.kind) + ' · ' + pkg.version +
      (pkg.enabled ? ' · 已启用' : ' · 已停用') + sourceLabel;
    button.appendChild(name); button.appendChild(meta);
    button.addEventListener('click', () => expertSelectPackage(pkg.id));
    list.appendChild(button);
  });
}
async function loadExpertPackages(query = '') {
  expertCenterState.loading = true; expertCenterState.error = ''; expertCenterRenderList();
  try {
    const payload = expertApiPayload(await callApi('expert_list', [query]));
    expertCenterState.packages = payload.packages || [];
  } catch (error) {
    expertCenterState.packages = [];
    expertCenterState.error = error.message || '专家包加载失败';
  } finally {
    expertCenterState.loading = false; expertCenterRenderList();
  }
}
function expertCenterRenderDetail() {
  const detail = expertCenterState.detail;
  const root = document.getElementById('expertPackageDetail');
  if (!root) return;
  root.replaceChildren();
  const select = document.getElementById('expertSelectBtn');
  const enable = document.getElementById('expertEnableBtn');
  if (!detail) {
    const empty = document.createElement('p'); empty.className = 'expert-empty'; empty.textContent = '选择左侧专家包查看详情。'; root.appendChild(empty);
    if (select) select.disabled = true;
    if (enable) enable.disabled = true;
    return;
  }
  const title = document.createElement('h3');
  title.textContent = expertDisplayName(detail.metadata) || detail.metadata.name || detail.id;
  root.appendChild(title);
  const description = document.createElement('p'); description.className = 'expert-description';
  description.textContent = expertDescriptionText(detail.metadata); root.appendChild(description);
  const meta = document.createElement('p'); meta.className = 'expert-package-meta';
  const detailSourceLabel = detail.source && detail.source.kind === 'builtin' ? ' · 内置' : '';
  meta.textContent = expertKindLabel(detail.kind) + ' · ' + detail.version +
    (detail.enabled === false ? ' · 已停用' : ' · 已启用') + detailSourceLabel;
  root.appendChild(meta);
  const guide = document.createElement('div'); guide.className = 'expert-usage-guide';
  const guideTitle = document.createElement('strong'); guideTitle.textContent = '使用说明'; guide.appendChild(guideTitle);
  [
    '仅支持从本机已存在的目录导入，不支持 zip 或自动下载。',
    '专家包内容是不可信数据，不会获得高于 Harbor 的系统权限。',
    '包内 scripts 只作为资料展示，不会执行。',
    '选择专家后，在下一次发送消息时自动加载；不会改变普通聊天默认路径。',
    '专家团按包内 SOP 派生成员，主理人负责分工与汇总。',
  ].forEach(text => { const row = document.createElement('div'); row.textContent = text; guide.appendChild(row); });
  root.appendChild(guide);
  const agents = document.createElement('div'); agents.className = 'expert-detail-block';
  const agentTitle = document.createElement('strong'); agentTitle.textContent = '角色'; agents.appendChild(agentTitle);
  (detail.agents || []).forEach(agent => { const row = document.createElement('div'); row.textContent = agent.id + ' · ' + agent.description; agents.appendChild(row); });
  root.appendChild(agents);
  const limits = document.createElement('div'); limits.className = 'expert-detail-block';
  const limitTitle = document.createElement('strong'); limitTitle.textContent = '限制'; limits.appendChild(limitTitle);
  Object.entries(detail.limits || {}).forEach(([key, value]) => { const row = document.createElement('span'); row.className = 'expert-limit'; row.textContent = key + '=' + value; limits.appendChild(row); });
  root.appendChild(limits);
  const resources = document.createElement('div'); resources.className = 'expert-detail-block';
  const resourceTitle = document.createElement('strong'); resourceTitle.textContent = '技能与资料'; resources.appendChild(resourceTitle);
  (detail.skills || []).forEach(skill => {
    const row = document.createElement('div'); row.textContent = skill.name + ' · ' + skill.description; resources.appendChild(row);
    (skill.scripts || []).forEach(script => { const item = document.createElement('small'); item.textContent = script.path + ' · 仅元数据，不会执行'; resources.appendChild(item); });
  });
  root.appendChild(resources);
  if (select) select.disabled = detail.enabled === false;
  if (enable) { enable.disabled = false; enable.textContent = detail.enabled === false ? '启用' : '停用'; }
}
async function expertSelectPackage(packageId) {
  try {
    const payload = expertApiPayload(await callApi('expert_get', [packageId, '']));
    const listed = expertCenterState.packages.find(pkg => pkg.id === packageId);
    expertCenterState.detail = Object.assign({}, payload.package, {
      enabled: listed ? listed.enabled : true,
      source: listed ? listed.source : undefined,
    });
    expertCenterRenderDetail();
  } catch (error) { expertCenterStatus(error.message || '详情加载失败', 'error'); }
}
async function openExpertCenter() {
  const overlay = document.getElementById('expertCenter');
  if (!overlay) return;
  expertCenterState.lastFocus = document.activeElement;
  expertCenterState.open = true; overlay.hidden = false; overlay.setAttribute('aria-hidden', 'false');
  expertCenterStatus('仅目录导入；包文本是不可信数据，scripts 不会执行。');
  await loadExpertPackages(document.getElementById('expertSearch') ? document.getElementById('expertSearch').value : '');
  const first = overlay.querySelector('button:not([disabled]),input');
  if (first) first.focus();
}
function closeExpertCenter() {
  const overlay = document.getElementById('expertCenter');
  if (!overlay) return;
  overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); expertCenterState.open = false;
  const target = expertCenterState.lastFocus;
  if (target && target.focus) target.focus();
}
function openExpertPicker() { return openExpertCenter(); }
function toggleExpertCenter() { return expertCenterState.open ? closeExpertCenter() : openExpertCenter(); }
function clearExpertSelection() {
  expertNextSelection = null; expertSelectionSessionId = ''; expertSelectionLabelText = '';
  const chip = document.getElementById('expertSelectionChip');
  if (chip) { chip.hidden = true; chip.replaceChildren(); }
}
function expertSelectForNextRun() {
  const detail = expertCenterState.detail;
  if (!detail || detail.enabled === false) return false;
  expertNextSelection = { packageId: detail.id, snapshotId: detail.snapshot_id,
    agentId: detail.metadata.agentName || '', skillName: '', resourcePaths: [] };
  expertSelectionSessionId = expertCurrentSessionId();
  expertSelectionLabelText = expertDisplayName(detail.metadata) || detail.metadata.name || detail.id;
  expertRenderSelectionChip();
  closeExpertCenter();
  return true;
}
async function expertToggleEnabled() {
  const detail = expertCenterState.detail;
  if (!detail) return;
  try {
    expertApiPayload(await callApi('expert_set_enabled', [detail.id, detail.enabled === false, detail.snapshot_id]));
    detail.enabled = !detail.enabled;
    const listed = expertCenterState.packages.find(pkg => pkg.id === detail.id);
    if (listed) listed.enabled = detail.enabled;
    expertCenterRenderDetail(); expertCenterRenderList();
  } catch (error) { expertCenterStatus(error.message || '启停失败', 'error'); }
}
async function expertImportDirectory() {
  const input = document.getElementById('expertImportPath');
  const path = input && input.value.trim();
  if (!path) { expertCenterStatus('请输入已存在的目录路径；不支持 zip/自动下载。', 'error'); return; }
  try {
    const result = expertApiPayload(await callApi('expert_import_directory', [path]));
    expertCenterStatus('已导入 ' + result.package_id + '，尚未启用。');
    await loadExpertPackages();
  } catch (error) { expertCenterStatus(error.message || '目录导入失败', 'error'); }
}
function expertTimelineRefresh(runId) {
  const timeline = new ExpertTimeline(document.getElementById('expertRunTimeline'));
  return timeline.render(expertSession(), runId);
}
async function runExpertSelection() {
  if (expertCenterState.runPromise) return expertCenterState.runPromise;
  if (!expertNextSelection) return { status: 'ordinary' };
  if (expertSelectionSessionId !== expertCurrentSessionId()) { clearExpertSelection(); return { status: 'error', error: { code: 'EXPERT_SESSION_CHANGED' } }; }
  const input = document.getElementById('userInput');
  const text = input && input.value.trim();
  if (!text) { expertCenterStatus('请输入本次 run 的任务内容。', 'error'); return { status: 'error', error: { code: 'DRAFT_REQUIRED' } }; }
  if (!expertCenterState.controller) {
    expertCenterState.controller = new ExpertRunController({ onEvent: event => {
      if (event.type === 'waiting_member' || event.type === 'waiting_lead') expertTimelineRefresh(event.runId);
    } });
  }
  const selection = expertNextSelection;
  expertCenterStatus('专家 run 运行中…');
  const stop = document.getElementById('expertStopBtn'); if (stop) stop.hidden = false;
  const recover = document.getElementById('expertRecoverBtn'); if (recover) recover.hidden = true;
  expertCenterState.runPromise = (async () => {
    try {
      const result = await expertCenterState.controller.start(selection, { text, sessionId: expertSelectionSessionId });
      expertCenterState.runResult = result;
      // Keep the one-shot selection on any runtime failure; only a completed
      // run consumes it, so the user can retry without reselecting the expert.
      if (result.accepted !== false && result.status === 'completed') clearExpertSelection();
      expertTimelineRefresh(result.runId);
      expertCenterStatus(result.status === 'error' ? '运行失败：' + (result.error && result.error.message || '') : '运行状态：' + result.status,
        result.status === 'error' ? 'error' : 'info');
      if (stop) stop.hidden = true;
      if (recover) recover.hidden = !result.checkpoint;
      return result;
    } catch (error) {
      expertCenterStatus('运行失败：' + error.message, 'error');
      if (stop) stop.hidden = true;
      return { status: 'error', error: { code: error.code || 'EXPERT_RUN_ERROR', message: error.message } };
    } finally { expertCenterState.runPromise = null; }
  })();
  return expertCenterState.runPromise;
}
function stopExpertRun() {
  const current = RunRegistry.current();
  if (!current) return false;
  if (expertCenterState.controller) return expertCenterState.controller.cancel(current.id);
  return RunRegistry.cancel() !== null;
}
async function recoverExpertRun() {
  // R41 修复（S4-15）：补 try/catch + 状态复位——原恢复流程任一环抛错
  // （checkpoint 读档/recover 内部）直接 unhandled rejection，runPromise 挂死
  const checkpoint = expertCenterState.runResult && expertCenterState.runResult.checkpoint;
  if (!checkpoint || !expertCenterState.controller) return { status: 'recover_unavailable' };
  try {
    expertCenterStatus('正在以新 run 恢复，旧工具不会重放…');
    const result = await new ExpertRecovery(expertCenterState.controller).recover(checkpoint);
    expertCenterState.runResult = result;
    expertTimelineRefresh(result.runId);
    expertCenterStatus('恢复状态：' + result.status + ' · parentRunId=' + result.parentRunId);
    return result;
  } catch (e) {
    expertCenterState.runPromise = null;
    expertCenterStatus('恢复失败：' + ((e && e.message) || e));
    return { status: 'recover_failed', error: String((e && e.message) || e) };
  }
}
function expertCenterKeydown(event) {
  if (!expertCenterState.open) return;
  if (event.key === 'Escape') { event.preventDefault(); closeExpertCenter(); return; }
  if (event.key !== 'Tab') return;
  const overlay = document.getElementById('expertCenter');
  const items = [...overlay.querySelectorAll('button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(item => !item.hidden);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function expertCenterInit() {
  if (expertCenterState.initialized || typeof document === 'undefined') return;
  expertCenterState.initialized = true;
  const on = (id, event, handler) => { const element = document.getElementById(id); if (element) element.addEventListener(event, handler); };
  on('expertPickerBtn', 'click', openExpertPicker);
  // R33：rail 入口改为「功能市场」；旧目录导入面板仍可由 expertPickerBtn 打开（兼容面）
  on('expertCenterBtn', 'click', () => {
    if (typeof hubOpenMarket === 'function') hubOpenMarket('expert');
    else openExpertCenter();
  });
  on('expertCloseBtn', 'click', closeExpertCenter);
  on('expertCenter', 'keydown', expertCenterKeydown);
  on('expertSelectBtn', 'click', expertSelectForNextRun);
  on('expertEnableBtn', 'click', expertToggleEnabled);
  on('expertImportBtn', 'click', expertImportDirectory);
  on('expertRunSelectedBtn', 'click', runExpertSelection);
  on('expertStopBtn', 'click', stopExpertRun);
  on('expertRecoverBtn', 'click', recoverExpertRun);
  on('expertSearch', 'change', event => loadExpertPackages(event.target.value));
  on('sessionList', 'click', () => setTimeout(() => {
    if (expertNextSelection && expertSelectionSessionId !== expertCurrentSessionId()) clearExpertSelection();
  }, 0));
  const newSession = document.querySelector('#panelSessions .pill-btn');
  if (newSession) newSession.addEventListener('click', clearExpertSelection);
  on('sendBtn', 'click', event => {
    if (!expertNextSelection) return;
    event.preventDefault(); event.stopImmediatePropagation();
    runExpertSelection();
  }, true);
}
if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', expertCenterInit, { once: true });
  else expertCenterInit();
}
