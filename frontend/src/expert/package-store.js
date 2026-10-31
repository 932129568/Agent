/* W5B digest-pinned W5A package client; package text remains UNTRUSTED DATA. */
class ExpertPackageStore {
  constructor(options) {
    const source = options || {};
    this._call = source.call || (typeof callApi === 'function' ? callApi : null);
    if (!this._call) throw new Error('expert_package_api_unavailable');
    this._cache = new Map();
    this.reads = [];
  }
  async get(packageId, snapshotId = '') {
    const key = packageId + ':' + snapshotId;
    if (this._cache.has(key)) return this._cache.get(key);
    const payload = expertApiPayload(await this._call('expert_get', [packageId, snapshotId]));
    const snapshot = expertSnapshot(payload);
    this._cache.set(key, snapshot);
    this._cache.set(packageId + ':' + snapshot.snapshot_id, snapshot);
    return snapshot;
  }
  async read(snapshot, path) {
    expertResourcePath(path);
    const payload = expertApiPayload(await this._call('expert_read_resource', [snapshot.snapshot_id, path]));
    if (payload.path !== path || typeof payload.text !== 'string' || payload.truncated !== false ||
        typeof payload.sha256 !== 'string') {
      throw new Error('expert_resource_provenance_mismatch');
    }
    this.reads.push({ snapshotId: snapshot.snapshot_id, path, sha256: payload.sha256 });
    return Object.freeze({ path: payload.path, sha256: payload.sha256, text: payload.text,
      provenance: payload.provenance });
  }
  async loadActor(snapshot, agentId = '') {
    const id = agentId || snapshot.metadata.agentName || snapshot.team.leadAgent;
    const agent = snapshot.agents.find(item => item.id === id);
    if (!agent) throw new Error('expert_agent_not_found');
    const resource = await this.read(snapshot, agent.path);
    return { agent, text: resource.text, provenance: resource.provenance };
  }
  async loadSkill(snapshot, skillName, resourcePaths = []) {
    if (!skillName) return null;
    const skill = snapshot.skills.find(item => item.name === skillName);
    if (!skill) throw new Error('expert_skill_not_found');
    const resource = await this.read(snapshot, skill.path);
    const allowed = new Set((skill.resources || []).map(item => item.path));
    const resources = [];
    for (const path of resourcePaths) {
      if (!allowed.has(path)) throw new Error('expert_resource_not_declared');
      resources.push(await this.read(snapshot, path));
    }
    return { skill, text: resource.text, resources };
  }
}
