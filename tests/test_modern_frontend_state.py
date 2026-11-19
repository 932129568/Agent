# -*- coding: utf-8 -*-
"""W3C2 real-source AppState, SessionStore and RunRegistry VM tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import pytest

from helpers.frontend import read_frontend_source

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
CORE = 'frontend/src/core/state.js'
APP = 'frontend/src/core/app-state.js'
STORE = 'frontend/src/sessions/store.js'
STORE_API = 'frontend/src/sessions/store-api.js'
RUN = 'frontend/src/agent/run-controller.js'
REGISTRY = 'frontend/src/agent/run-registry.js'


def run_case(body, modules):
    """Execute real source in one VM context and return a JSON result."""
    if not NODE:
        pytest.skip('Node.js is required for frontend state tests')
    sources = {name: read_frontend_source(str(ROOT), name) for name in modules}
    script = r'''
const vm = require('vm');
const sources = SOURCES;
const body = BODY;
const store = {};
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
  },
  callApi: async () => '{}', toast() {},
  document: { getElementById() { return null; } },
  __store: store,
};
ctx.window = ctx;
vm.createContext(ctx);
for (const source of Object.values(sources)) vm.runInContext(source, ctx);
(async () => {
  const result = await vm.runInContext('(async () => {' + body + '})()', ctx);
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
'''.replace('SOURCES', json.dumps(sources, ensure_ascii=False)).replace(
        'BODY', json.dumps(body, ensure_ascii=False))
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_modern_state_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(script)
        result = subprocess.run([NODE, path], cwd=ROOT,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def test_app_state_is_bidirectional_facade_not_second_tree():
    result = run_case(r'''
const initial = [{ id: 's1', messages: [] }];
AppState.sessions = initial;
AppState.currentSessionId = 's1';
AppState.isStreaming = true;
AppState.attachments = [{ name: 'a.txt' }];
AppState.providerState = { enabled: true };
AppState.mcpServers = [{ id: 'm1' }];
sessions.push({ id: 's2', messages: [] });
currentSessionId = 's2';
attachments = [];
return {
  sameSessions: AppState.sessions === initial,
  length: AppState.sessions.length,
  current: AppState.currentSessionId,
  streaming: isStreaming,
  attachmentsSame: AppState.attachments.length === 0,
  provider: providerState.enabled,
  mcp: mcpServers.length,
};
''', [CORE, APP])
    assert result == {
        'sameSessions': True, 'length': 2, 'current': 's2',
        'streaming': True, 'attachmentsSame': True,
        'provider': True, 'mcp': 1,
    }


def test_session_store_expert_normalization_save_and_legacy_shape():
    result = run_case(r'''
const normalized = SessionStore.normalize([
  { id: 'expert', title: 'new', updatedAt: 3, messages: [
    { role: 'assistant', content: 'a', expert: { actor: 'cloud' }, events: [{ id: 1 }] },
  ], expert: { mode: 'dual', runId: 'r1' }, plan: { task_id: 't1' } },
  { id: 'legacy', title: 'old', updatedAt: 2, messages: 'bad' },
]);
const savedCalls = [];
window.pywebview = { api: {} };
callApi = async (name, args) => { savedCalls.push({ name, args }); return '{"ok":true}'; };
AppState.sessions = normalized;
await SessionStore.save();
const stored = JSON.parse(__store.glm_sessions);
return {
  expert: normalized[0].expert,
  messageExpert: normalized[0].messages[0].expert,
  events: normalized[0].messages[0].events.length,
  absent: Object.prototype.hasOwnProperty.call(normalized[1], 'expert'),
  legacyMessages: normalized[1].messages,
  storedExpert: stored[0].expert,
  plan: stored[0].plan.task_id,
  savedCalls: savedCalls.map(call => call.name),
};
''', [CORE, APP, STORE, STORE_API])
    assert result['expert'] == {'mode': 'dual', 'runId': 'r1'}
    assert result['messageExpert'] == {'actor': 'cloud'}
    assert result['events'] == 1 and result['absent'] is False
    assert result['legacyMessages'] == []
    assert result['storedExpert'] == result['expert']
    assert result['plan'] == 't1'
    assert result['savedCalls'] == ['save_sessions']


def test_session_store_merge_tombstone_and_sixty_limit():
    result = run_case(r'''
__store.glm_sessions = JSON.stringify([
  { id: 'same', title: 'newer-local', updatedAt: 9, messages: [] },
  { id: 'deleted', title: 'deleted', updatedAt: 8, messages: [] },
]);
__store.glm_deleted_ids = JSON.stringify(['deleted']);
callApi = async name => {
  if (name === 'get_sessions') return JSON.stringify([
    { id: 'same', title: 'older-backend', updatedAt: 2, messages: [] },
    { id: 'deleted', title: 'deleted-backend', updatedAt: 3, messages: [] },
  ]);
  return '{"ok":true}';
};
await SessionStore.load();
const loaded = AppState.sessions;
AppState.sessions = Array.from({ length: 61 }, (_, index) => ({
  id: 's' + index, title: 's' + index, updatedAt: index + 1, messages: [],
}));
await SessionStore.save();
return {
  merged: loaded.map(item => item.id + ':' + item.title),
  capped: AppState.sessions.length,
  newest: AppState.sessions[0].id,
};
''', [CORE, APP, STORE, STORE_API])
    assert result == {'merged': ['same:newer-local'], 'capped': 60, 'newest': 's60'}


def test_run_registry_start_cancel_finish_and_generation():
    result = run_case(r'''
AppState.currentSessionId = 'a';
let aborted = 0;
const first = RunRegistry.start({ id: 'a' });
first.abortController = { abort() { aborted++; } };
const currentBefore = RunRegistry.current() === first;
const currentCheck = RunRegistry.isCurrent(first);
const cancelled = RunRegistry.cancel() === first;
const cancelledFlag = first.cancelled;
const finished = RunRegistry.finish(first);
const second = RunRegistry.start({ id: 'a' });
return { currentBefore, currentCheck, cancelled, cancelledFlag, aborted,
         finished, currentEmpty: RunRegistry.current() === second,
         generation: second.id > first.id };
''', [CORE, APP, RUN, REGISTRY])
    assert result == {
        'currentBefore': True, 'currentCheck': True, 'cancelled': True,
        'cancelledFlag': True, 'aborted': 1, 'finished': True,
        'currentEmpty': True, 'generation': True,
    }


def test_stale_run_and_session_switch_cannot_finish_new_owner():
    result = run_case(r'''
AppState.currentSessionId = 'a';
const first = RunRegistry.start({ id: 'a' });
// R31：跨会话启动不取消他方（不限数量并行）
AppState.currentSessionId = 'b';
const other = RunRegistry.start({ id: 'b' });
const crossAlive = !first.cancelled && RunRegistry.has('a');
const staleAfterSwitch = RunRegistry.isCurrent(first);
// R31：同会话重入才取代旧 run —— 旧 run 不得 finish 新 owner
AppState.currentSessionId = 'a';
const second = RunRegistry.start({ id: 'a' });
const staleFinish = RunRegistry.finish(first);
return { crossAlive, staleAfterSwitch, staleFinish,
         firstCancelled: first.cancelled,
         newCurrent: RunRegistry.current() === second,
         agentCurrent: agentRunCurrent(second),
         newFinished: RunRegistry.finish(second),
         empty: RunRegistry.current() === null,
         otherAlive: RunRegistry.has('b') && !other.cancelled };
''', [CORE, APP, RUN, REGISTRY])
    assert result == {
        'crossAlive': True, 'staleAfterSwitch': True, 'staleFinish': False,
        'firstCancelled': True, 'newCurrent': True,
        'agentCurrent': True, 'newFinished': True, 'empty': True,
        'otherAlive': True,
    }


def test_legacy_active_run_usage_matches_registry_semantics():
    result = run_case(r'''
currentSessionId = 'a';
const legacyRun = { id: 1, sessionId: 'a', cancelled: false,
  abortController: null, nudgeTimer: null, localWaitTimer: null };
__agentActiveRun = legacyRun;
return agentRunCurrent(legacyRun);
''', [CORE, APP, RUN])
    assert result is True
    result = run_case(r'''
AppState.currentSessionId = 'a';
const run = RunRegistry.start({ id: 'a' });
return agentRunCurrent(run) && RunRegistry.isCurrent(run);
''', [CORE, APP, RUN, REGISTRY])
    assert result is True
