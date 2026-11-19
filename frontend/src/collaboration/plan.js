/* W5E2 deterministic Plan/Result/Review/Final preparation and serial scheduling. */
function collaborationJson(text, code = 'COLLABORATION_SCHEMA_INVALID') {
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object'); return value; }
  catch (error) { collaborationSchemaError(code, 'json'); }
}
function collaborationPreparePlan(raw, options) {
  const plan = typeof raw === 'string' ? collaborationJson(raw) : raw;
  plan.runId = options.runId;
  plan.planId = plan.planId || 'plan_' + options.runId;
  plan.goal = options.goal;
  plan.createdBy = 'cloud-planner';
  plan.budgetSnapshot = plan.budgetSnapshot || options.budgetSnapshot || {};
  plan.planDigest = collaborationPlanDigest(plan);
  collaborationValidatePlan(plan);
  return plan;
}
function collaborationTaskOrder(plan) {
  const done = new Set(), ordered = [];
  while (ordered.length < plan.tasks.length) {
    const task = plan.tasks.find(item => !done.has(item.taskId) && item.dependsOn.every(id => done.has(id)));
    if (!task) collaborationSchemaError('COLLABORATION_DAG_CYCLE', 'tasks');
    ordered.push(task); done.add(task.taskId);
  }
  return ordered;
}
function collaborationPrepareResult(raw, context) {
  const source = typeof raw === 'string' ? collaborationJson(raw) : raw;
  const result = {
    schemaVersion: 1, runId: context.plan.runId, planId: context.plan.planId,
    taskId: context.task.taskId, attempt: context.task.attempt.current,
    actor: context.actor, status: context.executionStatus === 'completed' ? (source.status || 'completed') : 'partial',
    contentRef: String(source.contentRef || source.content || ''),
    evidenceRefs: Array.isArray(source.evidenceRefs) ? source.evidenceRefs : [],
    usageRef: context.messageId,
    selfCheck: source.selfCheck || { ok: false, issues: ['self_check_missing'] },
    provenance: source.provenance || { actor: context.actor, untrusted: true },
    resultRef: '',
  };
  if (source.terminalReason) result.terminalReason = String(source.terminalReason);
  result.resultRef = collaborationResultRef(result);
  collaborationValidateResult(result, context.plan);
  return result;
}
function collaborationPrepareReview(raw, context) {
  const source = typeof raw === 'string' ? collaborationJson(raw) : raw;
  const verdict = context.result.status !== 'completed' || !context.result.evidenceRefs.length ? 'fail' : source.verdict;
  const review = {
    schemaVersion: 1, runId: context.plan.runId, taskId: context.task.taskId,
    attempt: context.task.attempt.current, verdict,
    issues: Array.isArray(source.issues) ? source.issues : [],
    confidence: source.confidence,
    reviewer: 'cloud-reviewer', resultRef: context.result.resultRef,
    reviewDigest: '',
  };
  if (source.revisionInstruction) review.revisionInstruction = String(source.revisionInstruction).slice(0, 4000);
  review.reviewDigest = collaborationReviewDigest(context.result, context.rubric, context.reviewerEndpointDigest);
  collaborationValidateReview(review, { plan: context.plan, result: context.result,
    rubric: context.rubric, reviewerEndpointDigest: context.reviewerEndpointDigest });
  return review;
}
function collaborationPrepareFinal(context) {
  const resultRefs = context.plan.tasks.map(task => context.latest[task.taskId].result.resultRef);
  const reviewDigests = context.plan.tasks.map(task => context.latest[task.taskId].review.reviewDigest);
  const final = { schemaVersion: 1, runId: context.plan.runId, planDigest: context.plan.planDigest,
    resultRefs, reviewDigests, finalRef: '', status: 'completed' };
  final.finalRef = 'final_' + context.plan.planId + '_' + collaborationSha256(collaborationCanonical({
    planDigest: context.plan.planDigest, resultRefs, reviewDigests,
  })).slice(0, 12);
  collaborationValidateFinal(final, { plan: context.plan,
    results: context.plan.tasks.map(task => context.latest[task.taskId].result),
    reviews: context.plan.tasks.map(task => context.latest[task.taskId].review),
    rubric: context.rubric, reviewerEndpointDigest: context.reviewerEndpointDigest });
  return final;
}
function collaborationCheckpoint(context) {
  return { schemaVersion: 1, runId: context.runId, parentRunId: context.parentRunId || null,
    phase: context.phase, planDigest: context.plan && context.plan.planDigest,
    latest: context.latest || {}, finalRef: context.final && context.final.finalRef,
    usageRef: context.usageRef || [], terminalReason: context.terminalReason || null };
}
