# -*- coding: utf-8 -*-
"""W5C new-run recovery with no member/tool/usage replay."""
from test_expert_team import TEAM_HELPERS, TEAM_MODULES
from test_model_executor_foundation import run_case


def test_recovery_uses_fixed_snapshot_new_parent_and_does_not_replay_member_or_usage():
    result = run_case(TEAM_HELPERS + r'''
const fixture = makeTeamController([teamCreateSse, agentSse, sendSse, memberFinalSse, leadFinalSse]);
const original = await fixture.controller.start({ packageId: 'demo.expert' },
  { text: 'coordinate this', sessionId: 's1' });
const checkpoint = original.checkpoint;
checkpoint.unconsumedMailbox = fixture.session.expert.events.filter(event => event.type === 'mailbox_delivered');
checkpoint.unconsumedMailboxEventIds = checkpoint.unconsumedMailbox.map(event => event.eventId);
const beforeSpent = fixture.session.spent;
const recovery = new ExpertRecovery(fixture.controller);
let recoveryBodies = 0;
fixture.controller.transport = { async stream(request) { fixture.bodies.push(request.body); recoveryBodies++;
  return sse(leadFinalSse); } };
const recovered = await recovery.recover(checkpoint);
return { original, recovered, recoveryBodies, beforeSpent, afterSpent: fixture.session.spent,
  finalBody: fixture.bodies[fixture.bodies.length - 1], active: RunRegistry.current() };
''', TEAM_MODULES)
    assert result['original']['status'] == 'completed'
    assert result['recovered']['status'] == 'completed'
    assert result['recovered']['runId'] != result['original']['runId']
    assert result['recovered']['parentRunId'] == result['original']['runId']
    assert result['recoveryBodies'] == 1
    assert result['beforeSpent'] == 29 and result['afterSpent'] == 36
    assert len(result['recovered']['usage']['byMessage']) == 1
    assert 'member findings' in str(result['finalBody']['messages'])
    assert result['recovered']['snapshotId'] == result['original']['snapshotId']
    assert result['active'] is None
