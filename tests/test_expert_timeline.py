# -*- coding: utf-8 -*-
"""W5D actor/mailbox projection dedupe and legacy event compatibility."""
from test_expert_team import TEAM_HELPERS, TEAM_MODULES
from test_generative_registry import DOM
from test_model_executor_foundation import run_case

TIMELINE_MODULES = TEAM_MODULES + ['frontend/src/expert/timeline.js']


def test_projection_groups_lead_member_mailbox_usage_and_dedupes_events():
    result = run_case(TEAM_HELPERS + r'''
const base = { runId: '1', sessionId: 's1', generation: 1, phaseId: '1:p1', ts: '2026-01-01T00:00:00Z' };
const events = [
  { ...base, eventId: 'a1', type: 'assistant', memberRunId: 'lead', payload: { messageId: 'm-lead', actorId: 'orchestrator', content: 'lead text', usage: { total_tokens: 5 } } },
  { ...base, eventId: 'a2', type: 'assistant', memberRunId: '1:m1', payload: { messageId: 'm-member', actorId: 'researcher', content: 'member text', usage: { total_tokens: 7 } } },
  { ...base, eventId: 'w1', type: 'waiting_member', memberRunId: '1:m1', payload: {} },
  { ...base, eventId: 'mail1', type: 'mailbox_delivered', memberRunId: '1:m1', payload: { from: 'researcher', content: 'member findings', summary: 's' } },
  { ...base, eventId: 'consume1', type: 'mailbox_consumed', memberRunId: 'lead', payload: { eventId: 'mail1' } },
  { ...base, eventId: 'terminal', type: 'run_terminal', memberRunId: 'lead', payload: { status: 'completed' } },
];
const projection = expertTimelineProjection(events.concat([events[0], events[3]]), '1');
return { projection, eventCount: projection.events.length };
''', TIMELINE_MODULES)
    assert result['eventCount'] == 6
    assert {actor['role'] for actor in result['projection']['actors']} == {'lead', 'member'}
    assert result['projection']['mailboxes'][0]['consumed'] is True
    assert result['projection']['usage']['byActor']['researcher']['total_tokens'] == 7
    assert result['projection']['usage']['byActor']['orchestrator']['total_tokens'] == 5
    assert result['projection']['terminal']['payload']['status'] == 'completed'


def test_timeline_render_proves_member_to_lead_and_filters_run():
    result = run_case(DOM + TEAM_HELPERS + r'''
globalThis.document = document;
const root = host();
const session = { id: 's1', expert: { events: [
  { eventId: 'old', type: 'run_terminal', runId: 'old', sessionId: 's1', payload: { status: 'completed' } },
  { eventId: 'mail', type: 'mailbox_delivered', runId: 'new', sessionId: 's1', memberRunId: 'new:m1',
    payload: { from: 'researcher', content: 'member findings', summary: 's' } },
  { eventId: 'consume', type: 'mailbox_consumed', runId: 'new', sessionId: 's1', memberRunId: 'lead', payload: { eventId: 'mail' } },
] } };
const projection = new ExpertTimeline(root).render(session, 'new');
return { projection, text: textOf(root), hidden: root.hidden };
''', TIMELINE_MODULES)
    assert result['projection']['runId'] == 'new'
    assert result['projection']['mailboxes'][0]['consumed'] is True
    assert 'member findings' in result['text'] and '已消费' in result['text']
    assert result['hidden'] is False
