# -*- coding: utf-8 -*-
"""W5E1 hard Plan/Task/Result/Review/Final schema and DAG/reference tests."""
import pytest

from test_model_executor_foundation import run_case

MODULES = ['frontend/src/collaboration/endpoint.js', 'frontend/src/collaboration/schemas.js']
HELPERS = r'''
function task(id, dependsOn = []) { return { taskId: id, title: id, instruction: 'do ' + id,
  dependsOn, capability: { kind: 'understand', requiredTools: ['read_file'], outputKind: 'text', complexity: 1 },
  sensitivity: 'normal', inputRefs: [], outputSchemaRef: { type: 'string', maxLength: 100 },
  route: { preferred: 'local', reason: 'local capable' }, attempt: { current: 1, max: 3 } }; }
function makePlan() { const plan = { schemaVersion: 1, planId: 'plan1', runId: 'run1', goal: 'goal',
  createdBy: 'cloud-planner', dataScopeRef: 'scope', acceptanceCriteria: ['ok'],
  tasks: [task('t1'), task('t2', ['t1'])], budgetSnapshot: {}, planDigest: '' };
  plan.planDigest = collaborationPlanDigest(plan); return plan; }
function makeResult(plan, taskId) { const result = { schemaVersion: 1, runId: plan.runId, planId: plan.planId,
  taskId, attempt: 1, actor: 'local-worker', status: 'completed', contentRef: 'content-' + taskId,
  evidenceRefs: ['evidence-1'], usageRef: 'message-' + taskId,
  selfCheck: { ok: true, issues: [], confidence: 0.9 }, provenance: { source: 'local' }, resultRef: '' };
  result.resultRef = collaborationResultRef(result); return result; }
function makeReview(result) { return { schemaVersion: 1, runId: result.runId, taskId: result.taskId,
  attempt: result.attempt, verdict: 'pass', issues: [], confidence: 0.9, reviewer: 'cloud-reviewer',
  resultRef: result.resultRef, reviewDigest: collaborationReviewDigest(result, [], 'cloud-digest') }; }
function makeFinal(plan, results, reviews) { const final = { schemaVersion: 1, runId: plan.runId,
  planDigest: plan.planDigest, resultRefs: results.map(result => result.resultRef),
  reviewDigests: reviews.map(review => review.reviewDigest), status: 'completed', finalRef: '' };
  final.finalRef = 'final_' + plan.planId + '_' + collaborationSha256(collaborationCanonical({
    planDigest: plan.planDigest, resultRefs: final.resultRefs, reviewDigests: final.reviewDigests,
  })).slice(0, 12); return final; }
function validBundle() { const plan = makePlan(); const results = plan.tasks.map(task => makeResult(plan, task.taskId));
  const reviews = results.map(makeReview); const final = makeFinal(plan, results, reviews);
  return { plan, results, reviews, final }; }
function rejects(fn) { try { fn(); return false; } catch (error) { return error.code || error.message; } }
'''


def test_valid_plan_result_review_final_objects_pass():
    result = run_case(HELPERS + r'''
const bundle = validBundle();
const planOk = collaborationValidatePlan(bundle.plan);
const resultOk = bundle.results.map(result => collaborationValidateResult(result, bundle.plan));
const reviewOk = bundle.reviews.map((review, index) => collaborationValidateReview(review, {
  plan: bundle.plan, result: bundle.results[index], rubric: [], reviewerEndpointDigest: 'cloud-digest' }));
const finalOk = collaborationValidateFinal(bundle.final, { plan: bundle.plan, results: bundle.results,
  reviews: bundle.reviews, rubric: [], reviewerEndpointDigest: 'cloud-digest' });
return { planOk, resultOk, reviewOk, finalOk, finalRef: bundle.final.finalRef };
''', MODULES)
    assert result['planOk'] is True and result['resultOk'] == [True, True]
    assert result['reviewOk'] == [True, True] and result['finalOk'] is True
    assert result['finalRef'].startswith('final_plan1_')


def test_plan_cycle_depth_extra_unknown_and_dangling_rejections():
    result = run_case(HELPERS + r'''
const cycle = makePlan(); cycle.tasks[0].dependsOn = ['t2'];
const depth = makePlan(); depth.tasks = [task('a'), task('b', ['a']), task('c', ['b']), task('d', ['c']), task('e', ['d'])];
const extra = makePlan(); extra.unknownAction = 'run_shell';
const version = makePlan(); version.schemaVersion = 2;
const role = makePlan(); role.createdBy = 'local-planner';
const dangling = makePlan(); dangling.tasks[1].dependsOn = ['missing'];
const many = makePlan(); many.tasks = Array.from({ length: 13 }, (_, index) => task('t' + index));
return { cycle: rejects(() => collaborationValidatePlan(cycle)), depth: rejects(() => collaborationValidatePlan(depth)),
  extra: rejects(() => collaborationValidatePlan(extra)), version: rejects(() => collaborationValidatePlan(version)),
  role: rejects(() => collaborationValidatePlan(role)), dangling: rejects(() => collaborationValidatePlan(dangling)),
  many: rejects(() => collaborationValidatePlan(many)) };
''', MODULES)
    assert result['cycle'] == 'COLLABORATION_DAG_CYCLE'
    assert result['depth'] == 'COLLABORATION_DAG_DEPTH'
    assert result['extra'] == 'COLLABORATION_EXTRA_FIELD'
    assert result['version'] == 'COLLABORATION_VERSION_INVALID'
    assert result['role'] == 'COLLABORATION_ROLE_INVALID'
    assert result['dangling'] == 'COLLABORATION_DANGLING_REFERENCE'
    assert result['many'] == 'COLLABORATION_SCHEMA_INVALID'


def test_result_review_final_cross_run_digest_and_unresolved_rejections():
    result = run_case(HELPERS + r'''
const bundle = validBundle();
const cross = { ...bundle.results[0], runId: 'other-run' };
const badResultRef = { ...bundle.results[0], resultRef: 'res_wrong' };
const badReview = { ...bundle.reviews[0], reviewDigest: '0'.repeat(64) };
const unresolved = { ...bundle.final };
bundle.reviews[0].verdict = 'revise';
const unknownAction = rejects(() => collaborationValidateAction({ type: 'execute_shell' }));
return { cross: rejects(() => collaborationValidateResult(cross, bundle.plan)),
  badResultRef: rejects(() => collaborationValidateResult(badResultRef, bundle.plan)),
  badReview: rejects(() => collaborationValidateReview(badReview, { plan: bundle.plan,
    result: bundle.results[0], rubric: [], reviewerEndpointDigest: 'cloud-digest' })),
  unresolved: rejects(() => collaborationValidateFinal(unresolved, { plan: bundle.plan,
    results: bundle.results, reviews: bundle.reviews, rubric: [], reviewerEndpointDigest: 'cloud-digest' })), unknownAction };
''', MODULES)
    assert result['cross'] == 'COLLABORATION_CROSS_RUN_REFERENCE'
    assert result['badResultRef'] == 'COLLABORATION_REFERENCE_INVALID'
    assert result['badReview'] == 'COLLABORATION_DIGEST_INVALID'
    assert result['unresolved'] == 'COLLABORATION_UNRESOLVED_TASK'
    assert result['unknownAction'] == 'COLLABORATION_UNKNOWN_ACTION'
