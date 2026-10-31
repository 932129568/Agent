/* W5E2 minimum-upload previews and deterministic redaction; no raw secret in metadata. */
function collaborationRedact(text) {
  let value = String(text || ''), redactions = [];
  const apply = (pattern, replacement, kind) => {
    if (pattern.test(value)) { value = value.replace(pattern, replacement); redactions.push(kind); }
  };
  apply(/-----BEGIN [A-Z ]*?PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*?PRIVATE KEY-----/gi, '[SECRET]', 'private_key');
  apply(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [SECRET]', 'bearer');
  apply(/sk-[A-Za-z0-9_-]{8,}/g, '[SECRET]', 'token');
  apply(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[SECRET]', 'jwt');
  apply(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[SECRET]', 'secret_field');
  apply(/[A-Za-z]:\\[^\s]+/g, match => '[PATH_' + collaborationSha256(match).slice(0, 8) + ']', 'path');
  apply(/(?:\/home|\/tmp|\/var|\/Users)\/[^\s]+/g, match => '[PATH_' + collaborationSha256(match).slice(0, 8) + ']', 'path');
  apply(/https?:\/\/[^\s/]+@[^\s/]+\/[^\s]*/gi, '[URL_CREDENTIAL_REMOVED]', 'url_credential');
  apply(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1', 'url_query');
  return { text: value, redactions };
}
function collaborationPrivacyPreview(options) {
  const redacted = collaborationRedact(options.text);
  const text = redacted.text.slice(0, options.maxChars || 4000);
  return { text, meta: { actor: options.actor, taskId: options.taskId, resultRef: options.resultRef,
    digest: collaborationSha256(text), bytes: text.length, redactions: redacted.redactions,
    scope: options.scope, minimized: true,
    excluded: ['attachments', 'workspace', 'fullHistory', 'rawToolOutput', 'credentials'] } };
}
class CollaborationPrivacy {
  constructor(config) { this.config = config; }
  sourceDigest(text) { return collaborationSha256(String(text || '')); }
  forCloud(options) {
    if (this.config.upload_scope === 'local_only') throw new Error('COLLABORATION_LOCAL_ONLY');
    if (this.config.upload_scope === 'selected_results_only' && !options.selected) {
      return { text: '[RESULT_NOT_SELECTED]', meta: { actor: options.actor, taskId: options.taskId,
        resultRef: options.resultRef, scope: this.config.upload_scope, redactions: ['not_selected'] } };
    }
    return collaborationPrivacyPreview(Object.assign({}, options, {
      scope: this.config.upload_scope, maxChars: options.maxChars || 4000,
    }));
  }
  forPlanner(goal) {
    if (this.config.upload_scope === 'local_only') throw new Error('COLLABORATION_LOCAL_ONLY');
    return collaborationPrivacyPreview({ actor: 'cloud-planner', taskId: 'goal', resultRef: '',
      text: goal, scope: this.config.upload_scope, maxChars: 8000 });
  }
}
