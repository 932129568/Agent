/* W5E1 read-only role/EndpointRef selection. No fetch, retry, model client or global switching. */
const COLLABORATION_ROLE_CHANNELS = Object.freeze({
  planner: 'cloud', 'cloud-planner': 'cloud', worker: 'local', 'local-worker': 'local',
  reviewer: 'cloud', 'cloud-reviewer': 'cloud', finalizer: 'cloud', 'cloud-finalizer': 'cloud',
  'cloud-reviser': 'cloud', 'local-reviser': 'local',
});
class CollaborationRouter {
  constructor(options) {
    const source = options || {};
    this.config = source.config ? normalizeCollaborationConfig(source.config) : null;
    this.endpoints = source.endpoints || null;
  }
  validate() {
    if (!this.config) return { enabled: false, legacy: true };
    if (this.config.enabled && !this.endpoints) throw new Error('ENDPOINT_SNAPSHOT_MISSING');
    return { enabled: this.config.enabled, legacy: false };
  }
  endpointFor(role) {
    this.validate();
    if (!this.config || !this.config.enabled) throw new Error('COLLABORATION_DISABLED');
    const channel = COLLABORATION_ROLE_CHANNELS[role];
    if (!channel) throw new Error('COLLABORATION_ROLE_INVALID:' + role);
    if (channel === 'cloud' && this.config.upload_scope === 'local_only') throw new Error('COLLABORATION_LOCAL_ONLY');
    const endpoint = this.endpoints[channel];
    if (!endpoint || endpoint.role !== channel) throw new Error('ENDPOINT_SNAPSHOT_MISSING:' + channel);
    return endpoint;
  }
  selectWorker(task) {
    const local = this.endpointFor('local-worker');
    const required = task && task.capability && task.capability.requiredTools || [];
    const instructionLength = task && task.instruction ? task.instruction.length : 0;
    const localCompatible = required.every(tool => local.toolCapability.includes(tool)) && instructionLength + 8192 <= local.ctxWindow;
    if (localCompatible) return { role: 'local-worker', endpoint: local };
    if (this.config.upload_scope === 'local_only' || this.config.fallback_policy === 'disabled') {
      throw new Error('COLLABORATION_LOCAL_CAPABILITY_BLOCKED');
    }
    return { role: 'cloud-reviser', endpoint: this.endpointFor('cloud-reviser') };
  }
}
