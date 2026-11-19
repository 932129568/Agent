# -*- coding: utf-8 -*-
"""W5C synchronous TeamCreate→Agent→mailbox→lead回流 tests."""
from test_expert_agent import HELPERS, MODULES
from test_model_executor_foundation import run_case

TEAM_HELPERS = HELPERS + r'''
function teamSnapshot() {
  return snapshot({ kind: 'team',
    metadata: { agentName: 'orchestrator', settings: { tools: ['read_file'] } },
    agents: [
      { id: 'orchestrator', path: 'agents/orchestrator.md', sha256: 'lead-sha', description: 'lead' },
      { id: 'researcher', path: 'agents/researcher.md', sha256: 'member-sha', description: 'member' },
    ],
    team: { leadAgent: 'orchestrator', memberAgents: ['researcher'], members: [] },
  });
}
function toolRound(name, args, id) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id,
    function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n' +
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n' +
    'data: [DONE]\n';
}
function finalRound(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n' +
    'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n' +
    'data: [DONE]\n';
}
const teamCreateSse = toolRound('TeamCreate', { team_name: 'demo' }, 'team1');
const agentSse = toolRound('Agent', { name: 'researcher', prompt: 'investigate', subagent_type: 'researcher' }, 'agent1');
const sendSse = toolRound('SendMessage', { to: 'lead', content: 'member findings', summary: 'findings' }, 'send1');
const memberFinalSse = finalRound('member final');
const leadFinalSse = finalRound('lead final');
function makeTeamController(rounds) { return makeController({ snapshot: teamSnapshot(), rounds: rounds.map(sse) }); }
'''
TEAM_MODULES = MODULES + [
    'frontend/src/expert/recovery.js', 'frontend/src/expert/mailbox.js',
    'frontend/src/expert/orchestrator.js', 'frontend/src/analytics/expert.js',
]


def test_team_serial_real_reentry_mailbox_usage_and_checkpoint():
    result = run_case(TEAM_HELPERS + r'''
const fixture = makeTeamController([teamCreateSse, agentSse, sendSse, memberFinalSse, leadFinalSse]);
const result = await fixture.controller.start({ packageId: 'demo.expert' },
  { text: 'coordinate this', sessionId: 's1' });
return { result, bodies: fixture.bodies, events: fixture.session.expert.events,
  usage: selectExpertUsage(result), active: RunRegistry.current() };
''', TEAM_MODULES)
    assert result['result']['status'] == 'completed' and result['result']['content'] == 'lead final'
    assert len(result['bodies']) == 5
    assert 'TeamCreate' in [item['function']['name'] for item in result['bodies'][0]['tools']]
    assert 'Agent' in [item['function']['name'] for item in result['bodies'][1]['tools']]
    assert 'SendMessage' in [item['function']['name'] for item in result['bodies'][2]['tools']]
    assert 'Agent' in [item['function']['name'] for item in result['bodies'][4]['tools']]
    assert 'member findings' in str(result['bodies'][4]['messages'])
    types = [event['type'] for event in result['events']]
    for expected in ('team_created', 'waiting_member', 'mailbox_delivered', 'member_terminal',
                     'waiting_lead', 'mailbox_consumed', 'agent_result', 'run_terminal'):
        assert expected in types, (expected, types)
    delivered = next(event for event in result['events'] if event['type'] == 'mailbox_delivered')
    consumed = next(event for event in result['events'] if event['type'] == 'mailbox_consumed')
    assert delivered['memberRunId'].endswith(':m1') and consumed['payload']['eventId'] == delivered['eventId']
    assert result['result']['checkpoint']['completedMembers'][0]['resultEventIds'] == [delivered['eventId']]
    assert result['result']['checkpoint']['unconsumedMailboxEventIds'] == []
    assert result['usage']['byActor']['researcher']['total_tokens'] == 12
    assert result['usage']['byActor']['orchestrator']['total_tokens'] == 17
    assert result['usage']['total']['total_tokens'] == 29
    assert result['active'] is None


def test_member_cannot_spawn_or_team_create_and_lead_cannot_skip_team_create():
    result = run_case(TEAM_HELPERS + r'''
const fixture = makeTeamController([teamCreateSse, agentSse,
  toolRound('TeamCreate', { team_name: 'nested' }, 'nested1')]);
const result = await fixture.controller.start({ packageId: 'demo.expert' },
  { text: 'nested member', sessionId: 's1' });
const missing = makeTeamController([toolRound('TeamCreate', {}, 'bad-team')]);
const missingResult = await missing.controller.start({ packageId: 'demo.expert' },
  { text: 'missing name', sessionId: 's1' });
return { result, missingResult, calls: fixture.bodies.length };
''', TEAM_MODULES)
    assert result['result']['status'] == 'error'
    assert result['result']['error']['code'] == 'EXPERT_MEMBER_TOOL_FORBIDDEN'
    assert result['missingResult']['status'] == 'error'
    assert result['missingResult']['error']['code'] == 'TEAM_NAME_REQUIRED'
    assert result['calls'] == 3


def test_single_agent_has_no_team_schemas_and_member_writes_remain_serial():
    result = run_case(TEAM_HELPERS + r'''
const single = makeController();
const singleResult = await single.controller.start({ packageId: 'demo.expert' }, { text: 'single', sessionId: 's1' });
const team = teamSnapshot(); team.metadata.settings.tools = ['read_file', 'write_file'];
const twoWrites = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [
  { index: 0, id: 'w1', function: { name: 'write_file', arguments: '{}' } },
  { index: 1, id: 'w2', function: { name: 'write_file', arguments: '{}' } },
] } }] }) + '\n' +
  'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n' +
  'data: [DONE]\n';
const fixture = makeController({ snapshot: team,
  rounds: [sse(teamCreateSse), sse(agentSse), sse(twoWrites), sse(memberFinalSse), sse(leadFinalSse)] });
const teamResult = await fixture.controller.start({ packageId: 'demo.expert' }, { text: 'serial', sessionId: 's1' });
return { singleResult, singleBodies: single.bodies, teamResult, hostCalls: fixture.toolCalls };
''', TEAM_MODULES)
    assert result['singleResult']['status'] == 'completed'
    assert all(item['function']['name'] not in {'TeamCreate', 'Agent', 'SendMessage'}
               for body in result['singleBodies'] for item in body.get('tools', []))
    assert result['teamResult']['status'] == 'completed'
    assert [call['name'] for call in result['hostCalls']] == ['write_file', 'write_file']
