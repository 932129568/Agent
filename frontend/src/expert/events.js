/* W5B bounded, idempotent journal on the existing session.expert.events array. */
class ExpertEventJournal {
  constructor(session, options) {
    if (!session || typeof session !== 'object') throw new Error('expert_session_required');
    this.session = session;
    this._save = options && options.save || (typeof saveSessions === 'function' ? saveSessions : async () => {});
    this.pending = Promise.resolve();
    if (!session.expert || typeof session.expert !== 'object') session.expert = { events: [] };
    if (!Array.isArray(session.expert.events)) session.expert.events = [];
    this.events = session.expert.events;
    this.sequence = 0;
  }
  append(type, ownership, payload, eventId) {
    const runId = String(ownership.runId);
    const sessionId = String(ownership.sessionId);
    if (!runId || sessionId !== String(this.session.id)) throw new Error('expert_event_owner_mismatch');
    const seq = ++this.sequence;
    const event = {
      eventId: eventId || 'ev_' + runId + '_' + seq,
      type: String(type), runId, sessionId,
      generation: ownership.generation,
      ts: new Date().toISOString(), payload: payload || {},
    };
    if (ownership.phaseId) event.phaseId = String(ownership.phaseId);
    if (ownership.memberRunId) event.memberRunId = String(ownership.memberRunId);
    if (ownership.parentRunId) event.parentRunId = String(ownership.parentRunId);
    if (ownership.provenance) event.provenance = ownership.provenance;
    if (JSON.stringify(event.payload).length > 16384) throw new Error('expert_event_too_large');
    return this.appendOnce(event);
  }
  appendOnce(event) {
    if (!event || !event.eventId) throw new Error('expert_event_id_required');
    const existing = this.events.find(item => item.eventId === event.eventId);
    if (existing) return existing;
    if (event.type === 'run_terminal') {
      const terminal = this.events.find(item => item.type === 'run_terminal' && item.runId === event.runId);
      if (terminal) return terminal;
    }
    this.events.push(event);
    const sameRun = this.events.filter(item => item.runId === event.runId);
    if (sameRun.length > 1000 || this.events.length > 4000) {
      const keep = this.events.filter(item => item.type === 'run_terminal' || item.type === 'mailbox_delivered' ||
        item.runId === event.runId && sameRun.indexOf(item) >= sameRun.length - 100);
      if (keep.length > 4000 || keep.filter(item => item.runId === event.runId).length > 1000) {
        this.events.pop();
        throw new Error('expert_event_limit');
      }
      this.events.splice(0, this.events.length, ...keep);
    }
    this.pending = this.pending.then(() => this._save());
    return event;
  }
  async flush() { await this.pending; }
  project(runId) {
    const events = this.events.filter(event => event.runId === String(runId));
    const terminal = events.find(event => event.type === 'run_terminal');
    return { runId: String(runId), events, terminal: terminal || null };
  }
}
