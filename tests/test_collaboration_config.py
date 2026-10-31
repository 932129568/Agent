# -*- coding: utf-8 -*-
"""W5E1 hybrid.json compatibility, EndpointRef and read-only config behavior."""
import json

from backend.domains.providers.hybrid_router import DEFAULT_CONFIG, HybridRouter
from test_model_executor_foundation import run_case

MODULES = ['frontend/src/collaboration/endpoint.js', 'frontend/src/collaboration/config.js',
           'frontend/src/collaboration/router.js']
NODE_HELPERS = r'''
let networkCalls = 0;
fetch = async () => { networkCalls++; throw new Error('network forbidden'); };
function endpoint(preset, model = 'model') { return { preset, baseUrlRef: 'cache.' + preset, model,
  prices: { in: 1, out: 2, cache: 0.5 }, toolCapability: ['read_file'], ctxWindow: 32768 }; }
function both() { return { cloud: endpoint('cloud-cache'), local: endpoint('local-cache') }; }
'''


def snapshots():
    return {
        role: {
            'preset': role + '-preset', 'baseUrlRef': 'cache.' + role, 'model': role + '-model',
            'prices': {'in': 1, 'out': 2, 'cache': 0.5},
            'toolCapability': ['read_file'], 'ctxWindow': 32768,
        } for role in ('cloud', 'local')
    }


def test_legacy_default_and_strategy_are_unchanged(tmp_path):
    router = HybridRouter(config_path=str(tmp_path / 'hybrid.json'))
    loaded = router.get_config()
    assert loaded['config'] == DEFAULT_CONFIG
    assert 'collaboration' not in loaded['config']
    saved = router.save_config({'strategy': 'saver'})
    assert saved['ok'] is True and saved['config']['strategy'] == 'saver'
    assert 'collaboration' not in saved['config']
    decision = router.route('写一个实现方案', category='compose', confidence=0.9)
    assert decision['channel'] == 'cloud'


def test_collaboration_partial_update_and_atomic_failure_rollback(tmp_path, monkeypatch):
    path = tmp_path / 'hybrid.json'
    router = HybridRouter(config_path=str(path))
    router.get_config()
    saved = router.save_config({'collaboration': {'enabled': False, 'cloud_token_budget': 26000}})
    assert saved['ok'] is True and saved['config']['collaboration']['enabled'] is False
    assert saved['config']['collaboration']['cloud_token_budget'] == 26000
    before = path.read_bytes()
    old = router._cfg.copy()
    rejected = router.save_config({'collaboration': {'cloud_token_budget': 1}})
    assert rejected['field'] == 'collaboration' and path.read_bytes() == before
    monkeypatch.setattr('backend.domains.providers.hybrid_router.atomic_write_json',
                        lambda *args, **kwargs: (_ for _ in ()).throw(OSError('disk full')))
    failed = router.save_config({'collaboration': {'cloud_cost_budget': 1.5}})
    assert failed['error'] == '写入 hybrid.json 失败'
    assert router._cfg == old and path.read_bytes() == before


def test_enabled_requires_dual_snapshots_and_rejects_secret_or_incompatible(tmp_path):
    router = HybridRouter(config_path=str(tmp_path / 'hybrid.json'))
    router.get_config()
    missing = router.save_config({'collaboration': {'enabled': True}})
    assert missing['field'] == 'collaboration'
    cache = snapshots()
    accepted = router.save_config({'collaboration': {'enabled': True, 'endpoint_cache': cache}})
    assert accepted['ok'] is True and accepted['config']['collaboration']['enabled'] is True
    assert 'apiKey' not in json.dumps(accepted)
    bad = snapshots(); bad['cloud']['apiKey'] = 'sk-do-not-store'
    assert router.save_config({'collaboration': {'endpoint_cache': bad}})['field'] == 'collaboration'
    bad = snapshots(); bad['local']['ctxWindow'] = 1024
    assert router.save_config({'collaboration': {'endpoint_cache': bad}})['field'] == 'collaboration'
    assert router.save_config({'collaboration': {'endpoint_cache': {'other': None}}})['field'] == 'collaboration'


def test_invalid_collaboration_read_fails_closed_without_overwrite(tmp_path):
    path = tmp_path / 'hybrid.json'
    path.write_text(json.dumps({'strategy': 'auto', 'collaboration': {'enabled': True}}), encoding='utf-8')
    before = path.read_bytes()
    router = HybridRouter(config_path=str(path))
    result = router.get_config()
    assert result['field'] == 'collaboration' and path.read_bytes() == before
    path.write_text(json.dumps({'strategy': 'quality'}), encoding='utf-8')
    assert router.get_config()['config']['strategy'] == 'quality'


def test_endpoint_directions_digest_stability_and_no_network():
    result = run_case(NODE_HELPERS + r'''
const cloudActive = createCollaborationEndpoints({ active: 'cloud', currentCloud: endpoint('cloud-current'), cache: { local: endpoint('local-cache') } });
const cloudAgain = createCollaborationEndpoints({ active: 'cloud', currentCloud: endpoint('cloud-current'), cache: { local: endpoint('local-cache') } });
const localActive = createCollaborationEndpoints({ active: 'local', currentLocal: endpoint('local-current'), cache: { cloud: endpoint('cloud-cache') } });
const config = normalizeCollaborationConfig({ enabled: true, endpoint_cache: both() });
const router = new CollaborationRouter({ config, endpoints: cloudActive });
const worker = router.selectWorker({ instruction: 'read', capability: { requiredTools: ['read_file'] } });
let unknownRole = false; try { router.endpointFor('unknown-role'); } catch (error) { unknownRole = true; }
return { cloudActive, cloudAgain, localActive, worker, unknownRole, networkCalls };
''', MODULES)
    assert result['cloudActive']['cloud']['model'] == 'model'
    assert result['cloudActive']['local']['preset'] == 'local-cache'
    assert result['localActive']['local']['preset'] == 'local-current'
    assert result['localActive']['cloud']['preset'] == 'cloud-cache'
    assert result['cloudActive']['cloud']['snapshotDigest'] == result['cloudAgain']['cloud']['snapshotDigest']
    assert result['cloudActive']['cloud']['credentialRef']['kind'] == 'provider-key'
    assert result['cloudActive']['local']['credentialRef']['kind'] == 'local-no-key'
    assert result['worker']['role'] == 'local-worker'
    assert result['unknownRole'] is True and result['networkCalls'] == 0
    assert 'apiKey' not in json.dumps(result)


def test_disabled_legacy_router_and_local_only_no_network():
    result = run_case(NODE_HELPERS + r'''
const legacy = collaborationConfigFromHybrid({ strategy: 'auto' });
const off = new CollaborationRouter({ config: normalizeCollaborationConfig({ enabled: false }) });
let disabled = false; try { off.endpointFor('planner'); } catch (error) { disabled = error.message === 'COLLABORATION_DISABLED'; }
const localOnly = new CollaborationRouter({ config: normalizeCollaborationConfig({ enabled: true,
  upload_scope: 'local_only', endpoint_cache: both() }), endpoints: createCollaborationEndpoints({ active: 'cloud', currentCloud: endpoint('cloud'), cache: { local: endpoint('local') } }) });
let blocked = false; try { localOnly.endpointFor('cloud-reviewer'); } catch (error) { blocked = true; }
return { legacy, disabled, blocked, networkCalls };
''', MODULES)
    assert result['legacy'] is None and result['disabled'] is True and result['blocked'] is True
    assert result['networkCalls'] == 0


def test_collaboration_off_preserves_single_model_executor_baseline():
    result = run_case(NODE_HELPERS + r'''
const messages = [{ role: 'user', content: 'ordinary question' }];
const body = buildChatRequestBody({ model: 'model', messages, temperature: 0, topP: 1,
  maxTokens: 128, effort: 'off', glm: false, tools: [] });
const before = JSON.stringify(body);
const off = new CollaborationRouter({ config: normalizeCollaborationConfig({ enabled: false }) });
let calls = 0, sentBody = '';
const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n');
const execution = await ModelExecutor.execute({ context: { messages }, endpoint: { model: 'model' },
  transport: { async stream(request) { calls++; sentBody = JSON.stringify(request.body); return { ok: true, status: 200, body: { getReader() { let sent = false;
    return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }; } } }; } },
  tools: { executeBatch: async () => [] }, observer: { beforeRound: () => ({ body }) }, limits: { maxRounds: 1 } });
return { before, sentBody, calls, status: execution.status,
  usage: execution.usage, offEnabled: off.validate().enabled, networkCalls };
''', MODULES + ['frontend/src/agent/request-builder.js', 'frontend/src/agent/sse-parser.js',
                'frontend/src/agent/model-executor.js'])
    assert result['before'] == result['sentBody'] and result['calls'] == 1
    assert result['status'] == 'completed' and result['usage']['total_tokens'] == 2
    assert result['offEnabled'] is False and result['networkCalls'] == 0
