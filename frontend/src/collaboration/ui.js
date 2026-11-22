/* W5E4 optional collaboration settings and real run controls inside #hybridBlock. */
const collaborationUiState = {
  initialized: false, config: null, endpoints: null, transport: null,
  controller: null, result: null, running: false,
};
function collaborationUiEl(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
function collaborationUiStatus(text, kind) {
  const status = collaborationUiEl('collaborationStatus');
  if (status) { status.textContent = text || ''; status.dataset.kind = kind || 'info'; }
}
function collaborationUiRenderEndpoints() {
  const root = collaborationUiEl('collaborationEndpointSummary');
  if (!root) return;
  const endpoints = collaborationUiState.endpoints;
  const cache = collaborationUiState.config && collaborationUiState.config.endpoint_cache || {};
  const cloud = endpoints && endpoints.cloud || cache.cloud;
  const local = endpoints && endpoints.local || cache.local;
  root.textContent = 'cloud-planner/reviewer/finalizer: ' + (cloud ? cloud.preset + ' · ' + cloud.model + ' · ctx=' + cloud.ctxWindow : '未验证') +
    '\nlocal-worker/reviser: ' + (local ? local.preset + ' · ' + local.model + ' · ctx=' + local.ctxWindow : '未验证') +
    '\n凭证只引用 CredentialRef，不显示秘密。';
}
function collaborationUiRenderConfig(config) {
  const value = config || normalizeCollaborationConfig({ enabled: false });
  collaborationUiState.config = value;
  const fields = {
    collaborationEnabled: value.enabled,
    collaborationCloudBudget: value.cloud_token_budget,
    collaborationTotalBudget: value.total_token_budget,
    collaborationCostBudget: value.cloud_cost_budget,
    collaborationDeadline: value.deadline_s,
    collaborationReviewRounds: value.max_review_rounds,
    collaborationUploadScope: value.upload_scope,
  };
  Object.entries(fields).forEach(([id, fieldValue]) => {
    const element = collaborationUiEl(id);
    if (!element) return;
    if (element.type === 'checkbox') element.checked = fieldValue;
    else element.value = fieldValue;
  });
  collaborationUiRenderEndpoints();
  collaborationUiStatus(value.enabled ? '协同已启用；仅点击运行时才会调用模型。' : '协同已关闭，保持原混合路由。');
}
function collaborationUiPatch() {
  return {
    enabled: !!collaborationUiEl('collaborationEnabled').checked,
    cloud_token_budget: Number(collaborationUiEl('collaborationCloudBudget').value),
    total_token_budget: Number(collaborationUiEl('collaborationTotalBudget').value),
    cloud_cost_budget: Number(collaborationUiEl('collaborationCostBudget').value),
    deadline_s: Number(collaborationUiEl('collaborationDeadline').value),
    max_review_rounds: Number(collaborationUiEl('collaborationReviewRounds').value),
    upload_scope: collaborationUiEl('collaborationUploadScope').value,
  };
}
async function collaborationUiSave(patch) {
  const before = collaborationUiState.config;
  try {
    const candidate = normalizeCollaborationConfig(patch || collaborationUiPatch(), before);
    const config = await collaborationHybridSave({ collaboration: candidate });
    collaborationUiRenderConfig(config.collaboration || candidate);
    collaborationUiStatus('协同配置已保存到 hybrid.json；未调用模型。');
    return { ok: true, config: collaborationUiState.config };
  } catch (error) {
    collaborationUiRenderConfig(before);
    collaborationUiStatus('配置未保存：' + error.message, 'error');
    return { ok: false, error: { code: error.code || error.message, message: error.message } };
  }
}
function collaborationUiPreview() {
  const input = collaborationUiEl('userInput');
  const goal = input && input.value || '';
  const root = collaborationUiEl('collaborationPreview');
  if (collaborationUiState.config.upload_scope === 'local_only') {
    if (root) root.textContent = 'local_only：不会上传任务、附件、工作区或本地结果。';
    return { status: 'blocked', reason: 'local_only' };
  }
  const preview = new CollaborationPrivacy(collaborationUiState.config).forPlanner(goal);
  if (root) root.textContent = '上传范围：' + preview.meta.scope + ' · 最小化摘要\n' + preview.text +
    '\n排除：' + preview.meta.excluded.join(' / ');
  return preview;
}
function collaborationUiEndpoints() {
  if (collaborationUiState.endpoints) return collaborationUiState.endpoints;
  const cache = collaborationUiState.config.endpoint_cache || {};
  if (!cache.cloud || !cache.local) throw new Error('ENDPOINT_SNAPSHOT_MISSING');
  collaborationUiState.endpoints = Object.freeze({
    cloud: collaborationEndpointSnapshot('cloud', cache.cloud),
    local: collaborationEndpointSnapshot('local', cache.local),
  });
  return collaborationUiState.endpoints;
}
async function collaborationRun() {
  if (collaborationUiState.running) return collaborationUiState.result;
  // R50-FE-4 修复：同会话普通聊天 run 在途时不静默取消（原 RunRegistry.start
  // 会 cancel+abort 在途 run）——先弹忙提示
  if (typeof isSessionStreaming === 'function' && isSessionStreaming()) {
    collaborationUiStatus('当前会话正在生成回复，请先停止或等待完成', 'warn');
    return { status: 'session_busy' };
  }
  const config = collaborationUiState.config;
  if (!config || !config.enabled || config.upload_scope === 'local_only') {
    collaborationUiStatus(config && config.upload_scope === 'local_only' ? 'local_only：保持普通本地单模型，云调用为0。' : '协同已关闭，保持原混合路由。');
    return { status: 'ordinary', skipped: true };
  }
  const input = collaborationUiEl('userInput');
  const goal = input && input.value.trim();
  if (!goal) { collaborationUiStatus('请输入协同任务。', 'error'); return { status: 'failed', error: { code: 'DRAFT_REQUIRED' } }; }
  try {
    const endpoints = collaborationUiEndpoints();
    collaborationUiState.controller = new CollaborationController({ config, endpoints,
      transport: collaborationUiState.transport,
      onEvent: event => collaborationUiStatus('phase：' + event.phase),
    });
    collaborationUiState.running = true;
    const stop = collaborationUiEl('collaborationStopBtn');
    if (stop) stop.hidden = false;
    collaborationUiStatus('协同运行中…');
    const result = await collaborationUiState.controller.start(goal, {
      sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'collaboration-session',
    });
    collaborationUiState.result = result;
    new CollaborationTimeline(collaborationUiEl('expertRunTimeline')).render(result);
    collaborationUiStatus('运行状态：' + result.status + (result.error ? ' · ' + result.error.code : ''),
      result.status === 'completed' ? 'info' : 'error');
    const recover = collaborationUiEl('collaborationRecoverBtn');
    // R50-FE-2 修复：plan 为 null（planner 失败）时 checkpoint 恒真值但恢复
    // 必 TypeError——恢复按钮仅在 plan 存在时显示
    if (recover) recover.hidden = !result.checkpoint || !result.plan;
    return result;
  } catch (error) {
    collaborationUiStatus('运行失败：' + error.message, 'error');
    return { status: 'failed', error: { code: error.code || error.message, message: error.message } };
  } finally {
    collaborationUiState.running = false;
    const stop = collaborationUiEl('collaborationStopBtn');
    if (stop) stop.hidden = true;
  }
}
function collaborationStop() {
  const current = RunRegistry.current();
  if (!current || !collaborationUiState.controller) return false;
  const stopped = collaborationUiState.controller.cancel(current.id);
  if (stopped) collaborationUiStatus('已请求停止；迟到结果不会推进。');
  return stopped;
}
async function collaborationRecover() {
  // R50-FE-4 修复：运行中守卫（普通聊天 run 在途时不抢占）+ try/catch
  if (collaborationUiState.running) return { status: 'already_running' };
  if (typeof isSessionStreaming === 'function' && isSessionStreaming()) {
    collaborationUiStatus('当前会话正在生成回复，请先停止或等待完成', 'warn');
    return { status: 'session_busy' };
  }
  const result = collaborationUiState.result;
  if (!result || !result.checkpoint || !result.plan || !collaborationUiState.controller) return { status: 'recover_unavailable' };
  try {
  const endpoints = collaborationUiEndpoints();
  const input = collaborationUiEl('userInput');
  const goal = input && input.value.trim() || result.plan && result.plan.goal || '';
  const checkpoint = collaborationRecoveryFromResult(result, { goal,
    sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'collaboration-session',
    endpointDigests: { cloud: endpoints.cloud.snapshotDigest, local: endpoints.local.snapshotDigest },
  });
  const recovered = await new CollaborationRecovery(collaborationUiState.controller).recover(checkpoint, {
    goal, endpoints, transport: collaborationUiState.transport,
    config: collaborationUiState.config,
    sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : checkpoint.sessionId,
  });
  collaborationUiState.result = recovered;
  new CollaborationTimeline(collaborationUiEl('expertRunTimeline')).render(recovered);
  collaborationUiStatus('恢复状态：' + recovered.status + ' · parentRunId=' + recovered.parentRunId,
    recovered.status === 'completed' ? 'info' : 'error');
  return recovered;
  } catch (error) {
    // R50-FE-2 修复：恢复流程 try/catch——原 TypeError 直接 unhandled rejection 零反馈
    collaborationUiStatus('恢复失败：' + (error && error.message || error), 'error');
    return { status: 'recover_failed', error: { code: 'RECOVER_ERROR', message: String(error && error.message || error) } };
  }
}
/* R101 T02 · 双模型协同独立浮层
 * 为什么要搬：这块配置此前被 collaborationUiInit() 追加进 #hybridBlock，
 * 而 #hybridBlock 在**设置窗内**（工作区 → 模型路由）⇒ 用户要改协同预算/上限
 * 必须先进设置再翻一层，入口与「运行协同」按钮的实际使用频率完全不匹配。
 *
 * 实现约束（都是踩过的坑）：
 *  ① 浮层在 JS 里建，不写进模板：模板里新增 id 会进 contract_diff 的 dom_ids，
 *     新增 onclick= 会进 onclick_fns —— 两者都算契约漂移，而这块 UI 不需要。
 *  ② 不用 hidden 属性控制显隐：.modal-mask 带 display:flex，类选择器优先级高于
 *     浏览器默认的 [hidden]{display:none}，hidden 会失效（浮层一直在屏上）。
 *     用 inline style.display 显式切换。
 *  ③ 块内所有 id 原样保留（collaborationEnabled / …Budget / …Status 等），
 *     ui.js 其余部分全靠 getElementById，不做任何重命名。
 */
function _collabEnsureHost() {
  let mask = document.getElementById('collabMask');
  if (mask) return mask.querySelector('.collab-host');
  mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'collabMask';
  mask.style.display = 'none';
  const card = document.createElement('div');
  card.className = 'modal-card collab-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.innerHTML =
    '<h3>双模型协同</h3>' +
    '<div class="sub">planner/reviewer/finalizer 走云端，worker/reviser 走本地；保存配置不会调用模型。</div>' +
    '<div class="collab-host"></div>' +
    '<div class="modal-acts"><button type="button" class="modal-btn" data-act="close">关闭</button></div>';
  mask.appendChild(card);
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) collabPanelClose(); });
  const btn = card.querySelector('[data-act="close"]');
  if (btn) btn.onclick = collabPanelClose;
  mask.addEventListener('keydown', e => { if (e.key === 'Escape') collabPanelClose(); });
  return card.querySelector('.collab-host');
}

function collabPanelOpen() {
  if (typeof document === 'undefined') return;
  _collabEnsureHost();
  // 不在这里调 collaborationUiInit：hybrid.js 的 hybridInit 已在启动时调过它，
  // 而这里再调会形成 collabPanelOpen ↔ collaborationUiInit 的符号级环
  // （SCC 棘轮 17/104 零余量，实测被推到 19/109）。init 自身幂等，无需兜底。
  const mask = document.getElementById('collabMask');
  if (mask) mask.style.display = 'flex';
}

function collabPanelClose() {
  const mask = document.getElementById('collabMask');
  if (mask) mask.style.display = 'none';
}

function collaborationUiInit() {
  if (collaborationUiState.initialized || typeof document === 'undefined') return;
  const block = collaborationUiEl('collaborationBlock');
  if (!block) return;
  collaborationUiState.initialized = true;
  // R101 T02：宿主从 #hybridBlock（设置窗内）改为独立浮层。
  const host = _collabEnsureHost();
  if (host && block.parentNode !== host) host.appendChild(block);
  block.hidden = false;
  // 设置里留一个入口，否则搬走后就没人找得到了（JS 建，不用 onclick 字面量）。
  const hybrid = collaborationUiEl('hybridBlock');
  if (hybrid && !hybrid.querySelector('[data-act="open-collab"]')) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'modal-btn';
    open.setAttribute('data-act', 'open-collab');
    open.textContent = '打开双模型协同面板';
    open.onclick = () => { if (typeof collabPanelOpen === 'function') collabPanelOpen(); };
    hybrid.appendChild(open);
  }
  const on = (id, event, handler) => { const element = collaborationUiEl(id); if (element) element.addEventListener(event, handler); };
  on('collaborationSaveBtn', 'click', () => collaborationUiSave());
  on('collaborationPreviewBtn', 'click', collaborationUiPreview);
  on('collaborationRunBtn', 'click', collaborationRun);
  on('collaborationStopBtn', 'click', collaborationStop);
  on('collaborationRecoverBtn', 'click', collaborationRecover);
  on('collaborationEnabled', 'change', event => collaborationUiSave(Object.assign(collaborationUiPatch(), { enabled: event.target.checked })));
  collaborationUiRenderConfig(collaborationUiState.config);
}
