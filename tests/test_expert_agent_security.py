# -*- coding: utf-8 -*-
"""W5B ownership, scoped tools, budgets, lazy reads and legacy journal tests."""
from test_expert_agent import HELPERS, MODULES
from test_model_executor_foundation import run_case


def test_package_tool_intersection_rejects_unallowed_tool_before_host_execution():
    result = run_case(HELPERS + r'''
const fixture = makeController({ rounds: [sse(toolSse.replace(/read_file/g, 'write_file')), sse(finalSse)] });
const result = await fixture.controller.start({ packageId: 'demo.expert' },
  { text: 'try write', sessionId: 's1' });
return { result, toolCalls: fixture.toolCalls, events: fixture.session.expert.events };
''', MODULES)
    assert result['result']['status'] == 'error'
    assert result['result']['error']['code'] == 'EXPERT_TOOL_FORBIDDEN'
    assert result['toolCalls'] == []
    assert result['events'][-1]['type'] == 'run_terminal'


def test_cancel_late_frame_and_new_run_parent_ownership():
    result = run_case(HELPERS + r'''
const fixture = makeController();
const pending = [];
fixture.controller.transport = { stream: request => new Promise(resolve => pending.push(resolve)) };
const first = fixture.controller.start({ packageId: 'demo.expert' }, { text: 'first', sessionId: 's1' });
while (pending.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
const firstRunId = RunRegistry.current().id;
const cancelled = fixture.controller.cancel(firstRunId);
const second = fixture.controller.start({ packageId: 'demo.expert' }, { text: 'second', sessionId: 's1' });
while (pending.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
pending[0](sse(finalSse.replace('最终答案', '旧迟到内容')));
const firstResult = await first;
pending[1](sse(finalSse));
const secondResult = await second;
return { cancelled, firstRunId, firstResult, secondResult, active: RunRegistry.current() };
''', MODULES)
    assert result['cancelled'] is True
    assert result['firstResult']['status'] == 'cancelled'
    assert result['secondResult']['status'] == 'completed'
    assert result['secondResult']['content'] == '最终答案'
    assert result['secondResult']['parentRunId'] == str(result['firstRunId'])
    assert result['active'] is None


def test_turn_and_tool_budgets_stop_deterministically():
    result = run_case(HELPERS + r'''
const limited = makeController({ snapshot: snapshot({ limits: { maxTurns: 1, maxToolCalls: 120, runDeadlineSec: 1800 } }) });
const turnResult = await limited.controller.start({ packageId: 'demo.expert' }, { text: 'one turn', sessionId: 's1' });
const budget = makeController({ snapshot: snapshot({ limits: { maxTurns: 40, maxToolCalls: 0, runDeadlineSec: 1800 } }) });
const toolResult = await budget.controller.start({ packageId: 'demo.expert' }, { text: 'no tools', sessionId: 's1' });
return { turnResult, turnBodies: limited.bodies.length, toolResult,
  hostToolCalls: budget.toolCalls.length };
''', MODULES)
    assert result['turnResult']['status'] == 'limit' and result['turnBodies'] == 1
    assert result['toolResult']['status'] == 'budget' and result['hostToolCalls'] == 0


def test_regeneration_has_parent_without_reviving_old_run_and_usage_is_unique():
    result = run_case(HELPERS + r'''
const fixture = makeController();
const first = await fixture.controller.start({ packageId: 'demo.expert' }, { text: 'first', sessionId: 's1' });
let secondRound = 0;
fixture.controller.transport = { async stream(request) { fixture.bodies.push(request.body);
  return secondRound++ === 0 ? sse(toolSse) : sse(finalSse); } };
const second = await fixture.controller.start({ packageId: 'demo.expert' }, { text: 'second', sessionId: 's1' });
return { first, second, active: RunRegistry.current(), spent: fixture.session.spent };
''', MODULES)
    assert result['first']['status'] == 'completed' and result['second']['status'] == 'completed'
    assert result['second']['parentRunId'] == result['first']['runId']
    assert result['active'] is None and result['spent'] == 24
    assert len(result['second']['usage']['byMessage']) == 2


def test_legacy_expert_events_survive_normalize_and_append_once_is_idempotent():
    result = run_case(HELPERS + r'''
const raw = [{ id: 'legacy', messages: [], expert: { events: [
  { eventId: 'ev-old', type: 'run_terminal', runId: 'old', sessionId: 'legacy', payload: { status: 'completed' } },
] } }];
const session = normalizeSessions(raw)[0];
const journal = new ExpertEventJournal(session, { save: async () => {} });
const existing = journal.appendOnce(session.expert.events[0]);
journal.appendOnce(session.expert.events[0]);
return { events: session.expert.events, existing, sessionId: session.id };
''', MODULES + ['frontend/src/sessions/store.js'])
    assert result['sessionId'] == 'legacy' and len(result['events']) == 1
    assert result['existing']['eventId'] == 'ev-old'
