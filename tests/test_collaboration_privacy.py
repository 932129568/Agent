# -*- coding: utf-8 -*-
"""W5E3 minimum upload, local_only/fallback and redaction tests."""
from test_collaboration_flow import FLOW, MODULES
from test_model_executor_foundation import run_case


def test_redaction_and_preview_scope_do_not_leak_secret_file_content():
    result = run_case(FLOW + r'''
const secretText = 'Bearer abc.def.ghi\napi_key=secret\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nC:\\work\\secret.txt\nsk-abcdefghijk\n eyJaaa.bbb.ccc';
const preview = collaborationPrivacyPreview({ actor: 'cloud-reviewer', taskId: 't1', resultRef: 'r1',
  text: secretText, scope: 'task_summary_only' });
const privacy = new CollaborationPrivacy(config({ upload_scope: 'selected_results_only' }));
const notSelected = privacy.forCloud({ actor: 'cloud-reviewer', taskId: 't1', resultRef: 'r1', text: 'raw local body' });
return { preview, notSelected };
''', MODULES)
    for secret in ('abc.def.ghi', 'PRIVATE KEY', 'secret.txt', 'sk-abcdefghijk', 'eyJaaa.bbb.ccc'):
        assert secret not in result['preview']['text']
    assert result['preview']['meta']['minimized'] is True
    assert 'workspace' in result['preview']['meta']['excluded']
    assert result['preview']['meta']['scope'] == 'task_summary_only'
    assert result['notSelected']['text'] == '[RESULT_NOT_SELECTED]'
    assert 'raw local body' not in str(result['notSelected'])


def test_local_only_and_fallback_disabled_have_no_cloud_worker_or_fallback():
    result = run_case(FLOW + r'''
const local = new CollaborationController({ config: config({ upload_scope: 'local_only' }), endpoints: endpoints(),
  transport: { stream() { throw new Error('network forbidden'); } } });
const localOnly = await local.start('local only');
const fixture = flowController({ 'cloud-planner': [jsonSse(rawPlan())], 'local-worker': [] }, {
  config: config({ fallback_policy: 'disabled' }) });
fixture.controller.transport = { stream: request => {
  fixture.calls.push({ role: request.role, endpointRole: request.endpointRef.role, body: request.body });
  if (request.role === 'cloud-planner') return Promise.resolve(sse(jsonSse(rawPlan())));
  throw new Error('local unavailable');
} };
const failed = await fixture.controller.start('fallback disabled', { sessionId: 's1' });
return { localOnly, failed, calls: fixture.calls.map(call => call.role), provider: providerState.model };
''', MODULES)
    assert result['localOnly']['status'] == 'ordinary'
    assert result['failed']['status'] == 'failed' and result['failed']['final'] is None
    assert result['calls'] == ['cloud-planner', 'local-worker']
    assert result['provider'] == 'fake-model'


def test_selected_results_only_sends_marker_not_local_body():
    result = run_case(FLOW + r'''
const responses = successfulResponses();
const fixture = flowController(responses, { config: config({ upload_scope: 'selected_results_only' }) });
const original = CollaborationPrivacy.prototype.forCloud;
CollaborationPrivacy.prototype.forCloud = function(options) { return original.call(this, Object.assign({}, options, { selected: false })); };
const result = await fixture.controller.start('selected results', { sessionId: 's1' });
return { result, reviewerBody: fixture.calls[2].body.messages[1].content };
''', MODULES)
    assert result['result']['status'] == 'completed'
    assert result['reviewerBody'] == '[RESULT_NOT_SELECTED]'
