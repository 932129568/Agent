/* W5E3 checkpoint persistence, freshness gates and new-run reference migration. */
function collaborationRecoveryFromResult(result, options) {
  const source = options || {};
  const plan = result.plan;
  const checkpoint = {
    schemaVersion: 1, runId: String(result.runId), parentRunId: result.parentRunId || null,
    sessionId: source.sessionId || 'collaboration-session', goal: source.goal || plan.goal,
    goalDigest: collaborationSha256(String(source.goal || plan.goal || '')),
    snapshotRef: { planDigest: plan.planDigest, endpointDigests: source.endpointDigests || {} },
    plan, planDigest: plan.planDigest, phase: result.checkpoint && result.checkpoint.phase || 'terminal',
    latest: result.latest || {}, finalRef: result.final && result.final.finalRef || null,
    usage: result.usage || {}, reviewRounds: source.reviewRounds || {},
    pendingTasks: plan.tasks.filter(task => !result.latest[task.taskId] ||
      !result.latest[task.taskId].review || result.latest[task.taskId].review.verdict !== 'pass')
      .map(task => ({ taskId: task.taskId, attempt: task.attempt.current })),
    toolEffects: source.toolEffects || [],
    terminalReason: result.error && result.error.code || null,
    allowedTools: source.allowedTools || [], createdAt: new Date().toISOString(),
  };
  return checkpoint;
}
function collaborationRebaseLatest(checkpoint, newPlan, reviewerEndpointDigest) {
  const latest = {};
  Object.entries(checkpoint.latest || {}).forEach(([taskId, entry]) => {
    const result = Object.assign({}, entry.result, { runId: newPlan.runId, planId: newPlan.planId, resultRef: '' });
    result.resultRef = collaborationResultRef(result);
    collaborationValidateResult(result, newPlan);
    const next = { result };
    if (entry.review) {
      const review = Object.assign({}, entry.review, { runId: newPlan.runId,
        resultRef: result.resultRef, reviewDigest: '' });
      review.reviewDigest = collaborationReviewDigest(result, newPlan.acceptanceCriteria, reviewerEndpointDigest);
      collaborationValidateReview(review, { plan: newPlan, result,
        rubric: newPlan.acceptanceCriteria, reviewerEndpointDigest });
      next.review = review;
    }
    latest[taskId] = next;
  });
  return latest;
}
class CollaborationRecovery {
  constructor(controller) { this.controller = controller; }
  capture(result, options) { return collaborationRecoveryFromResult(result, options); }
  persist(session, checkpoint) {
    const journal = new ExpertEventJournal(session);
    journal.appendOnce({ eventId: 'collab_checkpoint_' + checkpoint.runId,
      type: 'collaboration_checkpoint', runId: String(checkpoint.runId), sessionId: String(session.id),
      generation: 1, ts: new Date().toISOString(), payload: checkpoint });
    return journal.flush().then(() => checkpoint);
  }
  validate(checkpoint, options) {
    if (!checkpoint || checkpoint.schemaVersion !== 1 || !checkpoint.plan) return 'CHECKPOINT_INVALID';
    if (checkpoint.goalDigest !== collaborationSha256(String(options.goal || ''))) return 'DATA_SOURCE_CHANGED';
    const endpoints = options.endpoints || this.controller.endpoints;
    const expected = checkpoint.snapshotRef.endpointDigests || {};
    if (!endpoints || endpoints.cloud.snapshotDigest !== expected.cloud || endpoints.local.snapshotDigest !== expected.local) return 'ENDPOINT_CHANGED';
    if (checkpoint.planDigest !== collaborationPlanDigest(checkpoint.plan)) return 'PLAN_DIGEST_CHANGED';
    collaborationValidatePlan(checkpoint.plan);
    const currentAllowed = options.allowedTools || checkpoint.allowedTools || [];
    if ((checkpoint.allowedTools || []).some(tool => !currentAllowed.includes(tool))) return 'PERMISSION_CHANGED';
    for (const entry of Object.values(checkpoint.latest || {})) {
      collaborationValidateResult(entry.result, checkpoint.plan);
      if (entry.review) collaborationValidateReview(entry.review, { plan: checkpoint.plan,
        result: entry.result, rubric: checkpoint.plan.acceptanceCriteria,
        reviewerEndpointDigest: expected.cloud });
    }
    return null;
  }
  async recover(checkpoint, options) {
    const source = options || {};
    const targetSession = String(source.sessionId || '');
    const activeSession = typeof AppState !== 'undefined' ? String(AppState.currentSessionId || '') : '';
    if (!checkpoint || String(checkpoint.sessionId || '') !== targetSession || targetSession !== activeSession) {
      return { status: 'blocked', content: '', error: { code: 'RECOVERY_SESSION_MISMATCH',
        message: 'RECOVERY_SESSION_MISMATCH' }, checkpoint: null };
    }
    let invalid;
    try { invalid = this.validate(checkpoint, source); }
    catch (error) { invalid = error.code || error.message || 'CHECKPOINT_INVALID'; }
    if (invalid) return { status: 'blocked', content: '', error: { code: invalid, message: invalid }, checkpoint: null };
    return this.controller.start(source.goal || checkpoint.goal, {
      sessionId: source.sessionId || checkpoint.sessionId, parentRunId: checkpoint.runId,
      recovery: checkpoint, transport: source.transport, endpoints: source.endpoints,
      config: source.config, hostAllowed: source.hostAllowed,
    });
  }
}
