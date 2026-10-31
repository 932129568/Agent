/* W5E3 read-only projection over the existing session.expert.events array. */
function projectExpertSessionEvents(session, runId) {
  const events = session && session.expert && Array.isArray(session.expert.events) ? session.expert.events : [];
  const seen = new Set();
  const selected = events.filter(event => {
    if (!event || seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return !runId || String(event.runId) === String(runId);
  });
  const checkpoints = selected.filter(event => event.type === 'collaboration_checkpoint');
  return { runId: runId || null, events: selected,
    latestCheckpoint: checkpoints.length ? checkpoints[checkpoints.length - 1].payload : null,
    terminal: selected.find(event => event.type === 'run_terminal') || null };
}
class ExpertProjection {
  constructor(session) { this.session = session; }
  project(runId) { return projectExpertSessionEvents(this.session, runId); }
}
