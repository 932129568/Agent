/* W5E1 optional collaboration config; legacy hybrid remains the single-model path. */
const COLLABORATION_DEFAULTS = Object.freeze({
  enabled: false, local_first: true, cloud_token_budget: 30000, total_token_budget: 120000,
  cloud_cost_budget: 2.0, max_review_rounds: 2, max_model_retries: 1, deadline_s: 1800,
  fallback_policy: 'allow_bounded', upload_scope: 'task_summary_only',
  endpoint_cache: Object.freeze({ cloud: null, local: null }),
});
function collaborationConfigError(field) { const error = new Error('COLLABORATION_CONFIG_INVALID:' + field); error.code = 'COLLABORATION_CONFIG_INVALID'; error.field = field; throw error; }
function collaborationEndpointCacheValid(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const required = ['preset', 'baseUrlRef', 'model', 'prices', 'toolCapability', 'ctxWindow'];
  if (required.some(key => snapshot[key] === undefined) || !Number.isInteger(snapshot.ctxWindow) || snapshot.ctxWindow < 8192 ||
      !Array.isArray(snapshot.toolCapability) || !snapshot.model || !snapshot.baseUrlRef) return false;
  try { collaborationAssertNoSecret(snapshot); } catch (error) { return false; }
  return snapshot.prices && ['in', 'out', 'cache'].every(key => typeof snapshot.prices[key] === 'number' && snapshot.prices[key] >= 0);
}
function normalizeCollaborationConfig(value, current) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) collaborationConfigError('object');
  const merged = Object.assign({}, COLLABORATION_DEFAULTS, current || {}, value);
  merged.endpoint_cache = Object.assign({ cloud: null, local: null },
    current && current.endpoint_cache || {}, value.endpoint_cache || {});
  if (typeof merged.enabled !== 'boolean' || typeof merged.local_first !== 'boolean') collaborationConfigError('enabled');
  if (!Number.isInteger(merged.cloud_token_budget) || merged.cloud_token_budget < 6000 || merged.cloud_token_budget > 30000) collaborationConfigError('cloud_token_budget');
  if (!Number.isInteger(merged.total_token_budget) || merged.total_token_budget < 10000 || merged.total_token_budget > 120000) collaborationConfigError('total_token_budget');
  if (merged.cloud_token_budget > merged.total_token_budget) collaborationConfigError('total_token_budget');
  if (typeof merged.cloud_cost_budget !== 'number' || merged.cloud_cost_budget < 0.01 || merged.cloud_cost_budget > 1000) collaborationConfigError('cloud_cost_budget');
  if (!Number.isInteger(merged.max_review_rounds) || merged.max_review_rounds < 0 || merged.max_review_rounds > 2) collaborationConfigError('max_review_rounds');
  if (!Number.isInteger(merged.max_model_retries) || merged.max_model_retries < 0 || merged.max_model_retries > 1) collaborationConfigError('max_model_retries');
  if (!Number.isInteger(merged.deadline_s) || merged.deadline_s < 60 || merged.deadline_s > 1800) collaborationConfigError('deadline_s');
  if (!['allow_bounded', 'disabled'].includes(merged.fallback_policy)) collaborationConfigError('fallback_policy');
  if (!['task_summary_only', 'selected_results_only', 'local_only'].includes(merged.upload_scope)) collaborationConfigError('upload_scope');
  if (Object.keys(merged.endpoint_cache).some(role => !['cloud', 'local'].includes(role))) collaborationConfigError('endpoint_cache.role');
  for (const role of ['cloud', 'local']) {
    const snapshot = merged.endpoint_cache[role];
    if (snapshot !== null && snapshot !== undefined && !collaborationEndpointCacheValid(snapshot)) collaborationConfigError('endpoint_cache.' + role);
  }
  const reserve = Math.min(4000, merged.cloud_token_budget * 0.2);
  if (reserve * (3 + merged.max_review_rounds) > merged.cloud_token_budget * 0.8) collaborationConfigError('budget_reserve');
  if (merged.enabled && (!collaborationEndpointCacheValid(merged.endpoint_cache.cloud) ||
      !collaborationEndpointCacheValid(merged.endpoint_cache.local))) collaborationConfigError('endpoint_cache.required');
  collaborationAssertNoSecret(merged);
  return merged;
}
function collaborationConfigFromHybrid(hybrid) {
  if (!hybrid || hybrid.collaboration === undefined || hybrid.collaboration === null) return null;
  return normalizeCollaborationConfig(hybrid.collaboration);
}
function collaborationConfigDigest(config) { return collaborationSha256(collaborationCanonical(config)); }
