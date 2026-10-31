/* W5C checkpoint projection and new-run recovery (no old ownership resurrection). */
function expertRecoveryCheckpoint(options) {
  const source = options || {};
  return {
    schemaVersion: 1, runId: String(source.runId), parentRunId: source.parentRunId || null,
    sessionId: String(source.sessionId), selection: source.selection || null,
    draft: source.draft || '', snapshotRef: {
      packageId: source.snapshot.id, snapshotId: source.snapshot.snapshot_id,
      version: source.snapshot.version,
    },
    teamId: source.teamId || null, phase: { id: String(source.phaseId), status: source.phaseStatus || 'terminal' },
    completedMembers: source.completedMembers || [],
    unconsumedMailboxEventIds: (source.unconsumedMailbox || []).map(event => event.eventId),
    unconsumedMailbox: source.unconsumedMailbox || [],
    cumulative: { modelTurns: source.modelTurns || 0, toolCalls: source.toolCalls || 0,
      usageRef: source.usageRef || [] },
    terminal: source.terminal || null, createdAt: new Date().toISOString(),
  };
}
class ExpertRecovery {
  constructor(controller) { this.controller = controller; }
  capture(options) { return expertRecoveryCheckpoint(options); }
  async recover(checkpoint) {
    if (!checkpoint || !checkpoint.selection || !checkpoint.snapshotRef) {
      return { status: 'recover_unavailable' };
    }
    const selection = Object.assign({}, checkpoint.selection, {
      packageId: checkpoint.snapshotRef.packageId, snapshotId: checkpoint.snapshotRef.snapshotId,
    });
    return this.controller.start(selection, {
      text: checkpoint.draft || 'Continue from the previous expert run',
      sessionId: checkpoint.sessionId, parentRunId: checkpoint.runId, recovery: checkpoint,
    });
  }
}
