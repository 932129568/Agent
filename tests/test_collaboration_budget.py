# -*- coding: utf-8 -*-
"""W5E3 reservation release, conservative usage and settlement gates."""
from test_collaboration_flow import FLOW, MODULES
from test_model_executor_foundation import run_case


def test_unknown_usage_release_and_unique_settlement():
    result = run_case(FLOW + r'''
const budget = new CollaborationBudget(config(), endpoints());
const initial = budget.remainingMandatory;
const reservation = budget.reserve('cloud-reviewer', 100);
const afterReserve = budget.remainingMandatory;
const released = budget.release(reservation, 'cancelled');
const afterRelease = budget.remainingMandatory;
const unknownReservation = budget.reserve('local-worker', 250);
const first = budget.settle('unknown-message', 'local-worker', null, unknownReservation);
const duplicate = budget.settle('unknown-message', 'local-worker', null, unknownReservation);
budget.markSuccess('cloud-reviewer', 'review-ref');
return { initial, afterReserve, released, afterRelease, first, duplicate, snapshot: budget.snapshot() };
''', MODULES)
    assert result['initial'] == 20000 and result['afterReserve'] == 8000
    assert result['released'] is True and result['afterRelease'] == 20000
    assert result['first'] is True and result['duplicate'] is False
    assert result['snapshot']['byMessage']['unknown-message']['estimated'] is True
    assert result['snapshot']['byMessage']['unknown-message']['prompt_tokens'] == 250
    assert result['snapshot']['totalTokens'] == 250
    assert result['snapshot']['byRole']['cloud-reviewer']['unitSuccessCost'] == 0


def test_cancel_reviewer_releases_unused_reservation_and_late_review_is_ignored():
    result = run_case(FLOW + r'''
const fixture = flowController({ 'cloud-planner': [jsonSse(rawPlan())], 'local-worker': [jsonSse(workerResult('draft'))] });
let pending;
fixture.controller.transport = { stream: request => {
  fixture.calls.push({ role: request.role, endpointRole: request.endpointRef.role, body: request.body });
  if (request.role === 'cloud-planner') return Promise.resolve(sse(jsonSse(rawPlan())));
  if (request.role === 'local-worker') return Promise.resolve(sse(jsonSse(workerResult('draft'))));
  return new Promise(resolve => { pending = resolve; });
} };
const running = fixture.controller.start('cancel review', { sessionId: 's1' });
while (!pending) await new Promise(resolve => setTimeout(resolve, 0));
fixture.controller.cancel(RunRegistry.current().id);
pending(sse(jsonSse(review('pass'))));
const result = await running;
return { result, calls: fixture.calls.map(call => call.role), active: RunRegistry.current() };
''', MODULES)
    assert result['result']['status'] == 'cancelled' and result['result']['final'] is None
    assert result['result']['usage']['remainingMandatory'] == 16000
    assert result['calls'] == ['cloud-planner', 'local-worker', 'cloud-reviewer']
    assert len(result['result']['usage']['byMessage']) == 2
    assert result['active'] is None


def test_settlement_over_limit_blocks_next_reservation():
    result = run_case(FLOW + r'''
const budget = new CollaborationBudget(config({ cloud_token_budget: 10000, total_token_budget: 10000, max_review_rounds: 0 }), endpoints());
const reservation = budget.reserve('local-worker', 1);
let exceeded = false;
try { budget.settle('over-usage', 'local-worker', { prompt_tokens: 6000, completion_tokens: 5000, total_tokens: 11000 }, reservation); }
catch (error) { exceeded = error.message.startsWith('COLLABORATION_BUDGET_EXCEEDED'); }
let nextBlocked = false;
try { budget.reserve('cloud-reviewer', 1); } catch (error) { nextBlocked = true; }
return { exceeded, nextBlocked, snapshot: budget.snapshot() };
''', MODULES)
    assert result['exceeded'] is True and result['nextBlocked'] is True
    assert result['snapshot']['totalTokens'] == 11000
