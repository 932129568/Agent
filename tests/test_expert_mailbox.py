# -*- coding: utf-8 -*-
"""W5C mailbox idempotence, ordering and parent cancellation tests."""
from test_expert_team import TEAM_HELPERS, TEAM_MODULES
from test_model_executor_foundation import run_case


def test_mailbox_deliver_consume_is_persistent_and_idempotent():
    result = run_case(TEAM_HELPERS + r'''
const session = { id: 's1', expert: { events: [] } };
const journal = new ExpertEventJournal(session, { save: async () => {} });
const mailbox = new ExpertMailbox(journal);
const ownership = { runId: 1, sessionId: 's1', generation: 1, phaseId: '1:p1', memberRunId: '1:m1' };
const first = mailbox.deliver({ from: 'researcher', content: 'evidence', summary: 's', ownership, eventId: 'ev-fixed' });
mailbox.deliver({ from: 'researcher', content: 'different duplicate', ownership, eventId: 'ev-fixed' });
const consumed = mailbox.consume(['ev-fixed', 'ev-fixed'], ownership);
const consumedAgain = mailbox.consume(['ev-fixed'], ownership);
return { events: session.expert.events, first, consumed, consumedAgain,
  pending: mailbox.unconsumed(1).length };
''', TEAM_MODULES)
    assert len([event for event in result['events'] if event['type'] == 'mailbox_delivered']) == 1
    assert len(result['consumed']) == 1 and result['consumedAgain'] == []
    assert result['pending'] == 0
    delivered = next(event for event in result['events'] if event['type'] == 'mailbox_delivered')
    assert delivered['phaseId'] == '1:p1' and delivered['memberRunId'] == '1:m1'


def test_parent_cancel_stops_member_and_late_result_cannot_commit_agent_result():
    result = run_case(TEAM_HELPERS + r'''
const fixture = makeTeamController([]);
let pending; let calls = 0;
fixture.controller.transport = { async stream(request) {
  fixture.bodies.push(request.body); calls++;
  if (calls === 1) return sse(teamCreateSse);
  if (calls === 2) return sse(agentSse);
  return new Promise(resolve => { pending = resolve; });
} };
const pendingRun = fixture.controller.start({ packageId: 'demo.expert' },
  { text: 'cancel member', sessionId: 's1' });
while (!pending) await new Promise(resolve => setTimeout(resolve, 0));
const runId = RunRegistry.current().id;
fixture.controller.cancel(runId);
pending(sse(memberFinalSse.replace('member final', 'late member result')));
const result = await pendingRun;
return { result, types: fixture.session.expert.events.map(event => event.type),
  active: RunRegistry.current() };
''', TEAM_MODULES)
    assert result['result']['status'] == 'cancelled'
    assert 'agent_result' not in result['types'] and 'mailbox_consumed' not in result['types']
    assert result['result']['content'] == ''
    assert result['active'] is None
