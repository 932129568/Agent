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
    if (recover) recover.hidden = !result.checkpoint;
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
  const result = collaborationUiState.result;
  if (!result || !result.checkpoint || !collaborationUiState.controller) return { status: 'recover_unavailable' };
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
}
function collaborationUiInit() {
  if (collaborationUiState.initialized || typeof document === 'undefined') return;
  const block = collaborationUiEl('collaborationBlock');
  if (!block) return;
  collaborationUiState.initialized = true;
  const hybrid = collaborationUiEl('hybridBlock');
  if (hybrid && block.parentNode !== hybrid) hybrid.appendChild(block);
  block.hidden = false;
  const on = (id, event, handler) => { const element = collaborationUiEl(id); if (element) element.addEventListener(event, handler); };
  on('collaborationSaveBtn', 'click', () => collaborationUiSave());
  on('collaborationPreviewBtn', 'click', collaborationUiPreview);
  on('collaborationRunBtn', 'click', collaborationRun);
  on('collaborationStopBtn', 'click', collaborationStop);
  on('collaborationRecoverBtn', 'click', collaborationRecover);
  on('collaborationEnabled', 'change', event => collaborationUiSave(Object.assign(collaborationUiPatch(), { enabled: event.target.checked })));
  collaborationUiRenderConfig(collaborationUiState.config);
}
