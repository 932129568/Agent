/* W5E1 bounded Plan/Task/Result/Review/Final data schemas and reference invariants. */
const COLLABORATION_SCHEMA_VERSION = 1;
function collaborationSchemaError(code, field) {
  const error = new Error(code + (field ? ':' + field : '')); error.code = code; error.field = field || '';
  throw error;
}
function collaborationFields(value, allowed, required, field = 'object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', field);
  Object.keys(value).forEach(key => { if (!allowed.includes(key)) collaborationSchemaError('COLLABORATION_EXTRA_FIELD', field + '.' + key); });
  (required || []).forEach(key => { if (value[key] === undefined) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', field + '.' + key); });
}
function collaborationText(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', field);
}
function collaborationAttempt(value) {
  collaborationFields(value, ['current', 'max'], ['current', 'max'], 'attempt');
  if (!Number.isInteger(value.current) || !Number.isInteger(value.max) || value.current < 1 || value.current > value.max || value.max > 3) {
    collaborationSchemaError('COLLABORATION_ATTEMPT_INVALID', 'attempt');
  }
}
function collaborationOutputSchema(value) {
  collaborationFields(value, ['type', 'required', 'properties', 'maxLength'], ['type'], 'outputSchemaRef');
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(item => typeof item !== 'string'))) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'outputSchemaRef.required');
  if (value.maxLength !== undefined && (!Number.isInteger(value.maxLength) || value.maxLength < 1 || value.maxLength > 32768)) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'outputSchemaRef.maxLength');
  if (value.properties !== undefined) {
    if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'outputSchemaRef.properties');
    Object.values(value.properties).forEach(child => collaborationOutputSchema(child));
  }
}
function collaborationTask(task, planId) {
  const allowed = ['taskId', 'title', 'instruction', 'dependsOn', 'capability', 'sensitivity', 'inputRefs', 'outputSchemaRef', 'route', 'attempt', 'resultRef', 'review', 'revisionOf'];
  collaborationFields(task, allowed, ['taskId', 'title', 'instruction', 'dependsOn', 'capability', 'sensitivity', 'inputRefs', 'outputSchemaRef', 'route', 'attempt'], 'task');
  collaborationText(task.taskId, 64, 'taskId'); collaborationText(task.title, 256, 'title'); collaborationText(task.instruction, 4000, 'instruction');
  if (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.some(item => typeof item !== 'string')) collaborationSchemaError('COLLABORATION_REFERENCE_INVALID', 'dependsOn');
  collaborationFields(task.capability, ['kind', 'requiredTools', 'outputKind', 'complexity'], ['kind', 'requiredTools', 'outputKind'], 'capability');
  if (!['understand', 'validate', 'plan', 'compose'].includes(task.capability.kind) ||
      !Array.isArray(task.capability.requiredTools) || task.capability.requiredTools.some(item => typeof item !== 'string') ||
      !['text', 'markdown', 'json', 'file_patch', 'analysis'].includes(task.capability.outputKind)) collaborationSchemaError('COLLABORATION_CAPABILITY_INVALID', 'capability');
  if (!['normal', 'local_only'].includes(task.sensitivity)) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'sensitivity');
  if (!Array.isArray(task.inputRefs) || task.inputRefs.length > 16 || task.inputRefs.some(ref => typeof ref !== 'string' || ref.includes('res_'))) collaborationSchemaError('COLLABORATION_REFERENCE_INVALID', 'inputRefs');
  collaborationOutputSchema(task.outputSchemaRef);
  collaborationFields(task.route, ['preferred', 'reason', 'confidence'], ['preferred', 'reason'], 'route');
  if (!['local', 'cloud'].includes(task.route.preferred) || typeof task.route.reason !== 'string' ||
      (task.route.confidence !== undefined && (typeof task.route.confidence !== 'number' || task.route.confidence < 0 || task.route.confidence > 1))) collaborationSchemaError('COLLABORATION_ROUTE_INVALID', 'route');
  collaborationAttempt(task.attempt);
  if (task.resultRef !== undefined && !new RegExp('^res_' + planId + '_' + task.taskId + '_a' + task.attempt.current + '_[0-9a-f]{12}$').test(task.resultRef)) collaborationSchemaError('COLLABORATION_REFERENCE_INVALID', 'resultRef');
  if (task.revisionOf !== undefined && typeof task.revisionOf !== 'string') collaborationSchemaError('COLLABORATION_REFERENCE_INVALID', 'revisionOf');
}
function collaborationPlanDigest(plan) {
  const copy = JSON.parse(JSON.stringify(plan));
  delete copy.planDigest;
  (copy.tasks || []).forEach(task => {
    if (task.attempt) task.attempt.current = 1;
    delete task.resultRef; delete task.review; delete task.revisionOf;
  });
  return collaborationSha256(collaborationCanonical(copy));
}
function collaborationValidatePlan(plan) {
  const allowed = ['schemaVersion', 'planId', 'runId', 'parentRunId', 'goal', 'createdBy', 'dataScopeRef', 'acceptanceCriteria', 'tasks', 'budgetSnapshot', 'planDigest'];
  collaborationFields(plan, allowed, ['schemaVersion', 'planId', 'runId', 'goal', 'createdBy', 'dataScopeRef', 'acceptanceCriteria', 'tasks', 'budgetSnapshot', 'planDigest'], 'plan');
  if (plan.schemaVersion !== COLLABORATION_SCHEMA_VERSION) collaborationSchemaError('COLLABORATION_VERSION_INVALID', 'schemaVersion');
  collaborationText(plan.planId, 64, 'planId'); collaborationText(plan.runId, 96, 'runId'); collaborationText(plan.goal, 8000, 'goal');
  if (plan.createdBy !== 'cloud-planner' || typeof plan.dataScopeRef !== 'string' || !plan.dataScopeRef) collaborationSchemaError('COLLABORATION_ROLE_INVALID', 'createdBy');
  if (!Array.isArray(plan.acceptanceCriteria) || plan.acceptanceCriteria.length > 8 || plan.acceptanceCriteria.some(item => typeof item !== 'string')) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'acceptanceCriteria');
  if (!plan.budgetSnapshot || typeof plan.budgetSnapshot !== 'object' || !Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > 12) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'tasks');
  const ids = new Set();
  plan.tasks.forEach(task => { collaborationTask(task, plan.planId); if (ids.has(task.taskId)) collaborationSchemaError('COLLABORATION_DUPLICATE_TASK', 'taskId'); ids.add(task.taskId); });
  const byId = Object.fromEntries(plan.tasks.map(task => [task.taskId, task]));
  plan.tasks.forEach(task => task.dependsOn.forEach(id => { if (!byId[id]) collaborationSchemaError('COLLABORATION_DANGLING_REFERENCE', 'dependsOn'); }));
  const visiting = new Set(), visited = new Set(), depths = new Map();
  const depth = taskId => {
    if (visiting.has(taskId)) collaborationSchemaError('COLLABORATION_DAG_CYCLE', taskId);
    if (visited.has(taskId)) return depths.get(taskId);
    visiting.add(taskId);
    const task = byId[taskId];
    const value = task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(depth)) : 1;
    if (value > 4) collaborationSchemaError('COLLABORATION_DAG_DEPTH', taskId);
    visiting.delete(taskId); visited.add(taskId); depths.set(taskId, value); return value;
  };
  plan.tasks.forEach(task => depth(task.taskId));
  if (plan.planDigest !== collaborationPlanDigest(plan)) collaborationSchemaError('COLLABORATION_DIGEST_INVALID', 'planDigest');
  return true;
}
function collaborationResultRef(result) {
  const copy = Object.assign({}, result); delete copy.resultRef;
  return 'res_' + result.planId + '_' + result.taskId + '_a' + result.attempt + '_' + collaborationSha256(collaborationCanonical(copy)).slice(0, 12);
}
function collaborationValidateResult(result, plan) {
  const allowed = ['schemaVersion', 'runId', 'parentRunId', 'planId', 'taskId', 'attempt', 'actor', 'status', 'contentRef', 'evidenceRefs', 'usageRef', 'selfCheck', 'provenance', 'terminalReason', 'resultRef'];
  collaborationFields(result, allowed, ['schemaVersion', 'runId', 'planId', 'taskId', 'attempt', 'actor', 'status', 'contentRef', 'evidenceRefs', 'usageRef', 'selfCheck', 'provenance', 'resultRef'], 'result');
  if (result.schemaVersion !== 1) collaborationSchemaError('COLLABORATION_VERSION_INVALID', 'schemaVersion');
  if (result.runId !== plan.runId || result.planId !== plan.planId || (result.parentRunId !== undefined && result.parentRunId !== plan.runId && result.parentRunId !== plan.parentRunId)) collaborationSchemaError('COLLABORATION_CROSS_RUN_REFERENCE', 'runId');
  const task = plan.tasks.find(item => item.taskId === result.taskId);
  if (!task || result.attempt !== task.attempt.current || !['local-worker', 'local-reviser', 'cloud-reviser'].includes(result.actor) || !['completed', 'partial', 'failed'].includes(result.status)) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'result');
  collaborationText(result.contentRef, 32768, 'contentRef');
  if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length > 16 || result.evidenceRefs.some(ref => typeof ref !== 'string')) collaborationSchemaError('COLLABORATION_REFERENCE_INVALID', 'evidenceRefs');
  collaborationText(result.usageRef, 256, 'usageRef');
  collaborationFields(result.selfCheck, ['ok', 'issues', 'confidence'], ['ok', 'issues'], 'selfCheck');
  if (typeof result.selfCheck.ok !== 'boolean' || !Array.isArray(result.selfCheck.issues) || result.selfCheck.issues.length > 32 ||
      (result.selfCheck.confidence !== undefined && (typeof result.selfCheck.confidence !== 'number' || result.selfCheck.confidence < 0 || result.selfCheck.confidence > 1))) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'selfCheck');
  if (!result.provenance || typeof result.provenance !== 'object') collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'provenance');
  if (result.resultRef !== collaborationResultRef(result)) collaborationSchemaError('COLLABORATION_REFERENCE_INVALID', 'resultRef');
  return true;
}
function collaborationReviewDigest(result, rubric, reviewerEndpointDigest) {
  return collaborationSha256(collaborationCanonical(result) + '\n' + collaborationCanonical(rubric) + '\n' + reviewerEndpointDigest);
}
function collaborationValidateReview(review, context) {
  const allowed = ['schemaVersion', 'runId', 'parentRunId', 'taskId', 'attempt', 'verdict', 'issues', 'revisionInstruction', 'confidence', 'reviewer', 'reviewDigest', 'resultRef'];
  collaborationFields(review, allowed, ['schemaVersion', 'runId', 'taskId', 'attempt', 'verdict', 'issues', 'reviewer', 'reviewDigest', 'resultRef'], 'review');
  const result = context.result, plan = context.plan;
  if (review.schemaVersion !== 1 || review.runId !== result.runId || review.taskId !== result.taskId || review.attempt !== result.attempt || review.resultRef !== result.resultRef) collaborationSchemaError('COLLABORATION_CROSS_RUN_REFERENCE', 'review');
  if (!['pass', 'revise', 'fail'].includes(review.verdict) || review.reviewer !== 'cloud-reviewer' || !Array.isArray(review.issues) || review.issues.length > 32) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'review');
  review.issues.forEach(issue => {
    collaborationFields(issue, ['code', 'message', 'evidenceRefs', 'severity'], ['code', 'message', 'evidenceRefs', 'severity'], 'issue');
    if (!['blocker', 'critical', 'major', 'minor', 'info'].includes(issue.severity) || issue.evidenceRefs.length > 16) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'issue');
  });
  if (review.confidence !== undefined && (typeof review.confidence !== 'number' || review.confidence < 0 || review.confidence > 1)) collaborationSchemaError('COLLABORATION_SCHEMA_INVALID', 'confidence');
  if (review.reviewDigest !== collaborationReviewDigest(result, context.rubric || [], context.reviewerEndpointDigest)) collaborationSchemaError('COLLABORATION_DIGEST_INVALID', 'reviewDigest');
  return true;
}
function collaborationValidateFinal(final, context) {
  const allowed = ['schemaVersion', 'runId', 'parentRunId', 'planDigest', 'resultRefs', 'reviewDigests', 'finalRef', 'status'];
  collaborationFields(final, allowed, ['schemaVersion', 'runId', 'planDigest', 'resultRefs', 'reviewDigests', 'finalRef', 'status'], 'final');
  const plan = context.plan, results = context.results || [], reviews = context.reviews || [];
  if (final.schemaVersion !== 1 || final.runId !== plan.runId || final.planDigest !== plan.planDigest || final.status !== 'completed') collaborationSchemaError('COLLABORATION_FINAL_INVALID', 'final');
  const resultRefs = plan.tasks.map(task => {
    const result = results.filter(item => item.taskId === task.taskId && item.attempt === task.attempt.current)[0];
    const review = reviews.filter(item => item.taskId === task.taskId && item.attempt === task.attempt.current)[0];
    if (!result || !review || review.verdict !== 'pass' || review.resultRef !== result.resultRef) collaborationSchemaError('COLLABORATION_UNRESOLVED_TASK', task.taskId);
    collaborationValidateReview(review, { plan, result, rubric: context.rubric || [], reviewerEndpointDigest: context.reviewerEndpointDigest });
    return result.resultRef;
  });
  if (JSON.stringify(final.resultRefs) !== JSON.stringify(resultRefs)) collaborationSchemaError('COLLABORATION_FINAL_INVALID', 'resultRefs');
  const expectedReviewDigests = plan.tasks.map(task => {
    const review = reviews.find(item => item.taskId === task.taskId && item.attempt === task.attempt.current);
    return review.reviewDigest;
  });
  if (JSON.stringify(final.reviewDigests) !== JSON.stringify(expectedReviewDigests)) {
    collaborationSchemaError('COLLABORATION_FINAL_INVALID', 'reviewDigests');
  }
  const expected = 'final_' + plan.planId + '_' + collaborationSha256(collaborationCanonical({ planDigest: plan.planDigest, resultRefs, reviewDigests: final.reviewDigests })).slice(0, 12);
  if (final.finalRef !== expected) collaborationSchemaError('COLLABORATION_FINAL_INVALID', 'finalRef');
  return true;
}
function collaborationValidateAction(action) {
  if (!action || !['plan', 'task', 'result', 'review', 'final'].includes(action.type)) collaborationSchemaError('COLLABORATION_UNKNOWN_ACTION', 'type');
  return action.type;
}
