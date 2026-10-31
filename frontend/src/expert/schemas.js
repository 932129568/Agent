/* W5B plain, lazily constructed schemas; ordinary chat never instantiates them. */
const EXPERT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EXPERT_DIGEST_RE = /^[0-9a-f]{64}$/;
function expertFail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}
function expertClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function expertFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.keys(value).forEach(key => expertFreeze(value[key]));
  return value;
}
function expertResourcePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      value.split('/').includes('..') || /(?:^|\/)scripts(?:\/|$)/.test(value) ||
      /\.(?:py|js|sh|bat|cmd|exe)$/i.test(value)) {
    expertFail('EXPERT_RESOURCE_FORBIDDEN', '只允许声明的文本资源路径');
  }
  return value;
}
function expertSelection(input) {
  if (!input || typeof input !== 'object' || !EXPERT_ID_RE.test(String(input.packageId || ''))) {
    expertFail('EXPERT_SELECTION_INVALID', '专家选择必须包含合法 packageId');
  }
  const snapshotId = String(input.snapshotId || '');
  if (snapshotId && !EXPERT_DIGEST_RE.test(snapshotId)) expertFail('EXPERT_SNAPSHOT_INVALID', 'snapshotId 非法');
  const resources = input.resourcePaths === undefined ? [] : input.resourcePaths;
  if (!Array.isArray(resources) || resources.length > 16) expertFail('EXPERT_RESOURCES_INVALID', '资源选择超过上限');
  return {
    packageId: String(input.packageId), snapshotId,
    agentId: input.agentId ? String(input.agentId) : '',
    skillName: input.skillName ? String(input.skillName) : '',
    resourcePaths: resources.map(expertResourcePath),
  };
}
function expertDraft(input) {
  const source = typeof input === 'string' ? { text: input } : (input || {});
  const text = String(source.text !== undefined ? source.text : (source.content || ''));
  if (!text.trim() || text.length > 32768) expertFail('EXPERT_DRAFT_INVALID', 'draft 为空或超过32KiB');
  const app = typeof AppState !== 'undefined' ? AppState : {};
  return { text, sessionId: String(source.sessionId || app.currentSessionId || 'expert-session'),
    parentRunId: source.parentRunId || null, recovery: source.recovery || null };
}
function expertApiPayload(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw || '{}'); } catch (error) { expertFail('EXPERT_API_INVALID_JSON', '专家包接口返回非 JSON'); }
  }
  if (!value || value.ok !== true) {
    const error = value && value.error;
    expertFail(error && error.code || 'EXPERT_API_ERROR', error && error.message || '专家包接口失败');
  }
  return value;
}
function expertSnapshot(payload) {
  const snapshot = payload && payload.package;
  if (!snapshot || !EXPERT_ID_RE.test(String(snapshot.id || '')) ||
      !EXPERT_DIGEST_RE.test(String(snapshot.snapshot_id || '')) ||
      !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.skills) ||
      !Array.isArray(snapshot.resources)) {
    expertFail('EXPERT_SNAPSHOT_INVALID', '专家包快照结构不完整');
  }
  return expertFreeze(expertClone(snapshot));
}
function expertMessage(role, content, extra) {
  return Object.assign({ role, content: content == null ? '' : String(content) }, extra || {});
}
function expertToolArgs(call) {
  let args;
  try { args = JSON.parse(call.argsStr || '{}'); } catch (error) { expertFail('EXPERT_TOOL_ARGS_INVALID', '工具参数必须是 JSON 对象'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) expertFail('EXPERT_TOOL_ARGS_INVALID', '工具参数必须是对象');
  return args;
}
function expertTeamSchemas(role, teamCreated) {
  const schemas = [];
  if (role === 'lead' && !teamCreated) schemas.push({ type: 'function', function: {
    name: 'TeamCreate', description: 'Create the preselected expert team', parameters: {
      type: 'object', additionalProperties: false, required: ['team_name'],
      properties: { team_name: { type: 'string' }, description: { type: 'string' }, agent_type: { type: 'string' } },
    } } });
  if (role === 'lead' && teamCreated) schemas.push({ type: 'function', function: {
    name: 'Agent', description: 'Run one declared team member synchronously', parameters: {
      type: 'object', additionalProperties: false, required: ['name', 'prompt'],
      properties: { name: { type: 'string' }, prompt: { type: 'string' },
        subagent_type: { type: 'string' }, description: { type: 'string' } },
    } } });
  if (role === 'member') schemas.push({ type: 'function', function: {
    name: 'SendMessage', description: 'Deliver a result to the current lead', parameters: {
      type: 'object', additionalProperties: false, required: ['to', 'content'],
      properties: { to: { type: 'string' }, content: { type: 'string' }, summary: { type: 'string' } },
    } } });
  return schemas;
}
