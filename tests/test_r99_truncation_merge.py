# -*- coding: utf-8 -*-
"""R99 回归：消息截断（回退/撤回/编辑重发/重新生成）后重开不得丢消息。

缺陷（R97 §7.1 / R98 §B，P0）：四处截断 ``s.messages`` 却不 bump ``s.updatedAt``，
双源合并（backend SQLite + localStorage 镜像）在 ``updatedAt`` 平局时取后端，
于是「截断生效与否」取决于哪一侧恰好持有长版本，表现为回退失效或完整版被覆盖。

本模块用**真实源码**（``frontend/src/sessions/store.js`` / ``components/markdown.js``
/ ``chat/send.js``）在 Node VM 里跑，不 stub 被测函数，只 stub 浏览器环境
（DOM / localStorage / pywebview 桥）。断言全部是行为断言：合并后会话里到底剩
几条消息、正文是否被配额投影的 2k 截断版覆盖。

改前预期：除防回归守卫外全红（能复现丢消息 / 回退失效）；改后预期：全绿。
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')

STORE = 'frontend/src/sessions/store.js'
MARKDOWN = 'frontend/src/components/markdown.js'
SEND = 'frontend/src/chat/send.js'

T0 = 1_700_000_000_000   # 共同基线时间戳（两侧平局就是它）


def _read(rel: str) -> str:
    with open(os.path.join(ROOT, *rel.split('/')), 'r', encoding='utf-8') as handle:
        return handle.read()


# DOM 假体：只提供被测路径真正触到的成员（markdown.js 顶层 window.DOMPurify 判定、
# document.addEventListener、createElement、getElementById）。没有 HTML 解析。
_DOM_PRELUDE = r"""
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', textContent: '', value: '', type: '', onclick: null,
    style: { cssText: '' }, children: [], dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    focus() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = String(v); if (v === '') this.children.length = 0; },
    get classList() { return { add() {}, remove() {}, contains() { return false; } }; },
  };
  return el;
}
const __doc = {
  __created: [],
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; },     // _rollbackUndoBanner 据此早退，无需横幅 DOM
  createElement(t) { const e = __mkEl(t); __doc.__created.push(e); return e; },
  querySelector() { return null; },
  body: __mkEl('body'),
};
"""


def run_case(body: str, backend_in, local_in, backend_writable: bool = True,
             modules=(STORE, MARKDOWN, SEND)):
    """在一个 VM 上下文里跑真实源码 + 用例 body，返回 JSON 结果。

    ``backend_in`` / ``local_in`` 是「页面重新加载时」后端与本地镜像各自持有的
    会话数组；``backend_writable=False`` 模拟后端落盘失败（只有镜像落盘）。
    """
    if not NODE:
        pytest.skip('Node.js is required for the truncation-merge regression tests')
    sources = {name: _read(name) for name in modules}
    script = r'''
const vm = require('vm');
const sources = __SOURCES__;
const body = __BODY__;
__DOM__
const __ls = Object.create(null);
const __ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  __mkEl: __mkEl,
  document: __doc,
  localStorage: {
    getItem(k) { return Object.prototype.hasOwnProperty.call(__ls, k) ? __ls[k] : null; },
    setItem(k, v) { __ls[k] = String(v); },
    removeItem(k) { delete __ls[k]; },
  },
  toast() {},
  AppState: { sessions: [], currentSessionId: null, isStreaming: false },
  renderChatHistory() {},
  runAgentLoop() {},
  isSessionStreaming() { return false; },
  effectiveApiKey() { return 'test-key'; },
  localModeActive() { return true; },
  _sendSessionBusy() { return false; },
  getActiveRuns() { return []; },
  __backendWritable: __BACKEND_WRITABLE__,
  __backend: __BACKEND_IN__,
  __ls: __ls,
};
__ctx.window = __ctx;
__ctx.window.HARBOR_API_BASE = 'http://harness.invalid';
__ctx.callApi = async (name, args) => {
  if (name === 'get_sessions') return JSON.stringify(__ctx.__backend);
  if (name === 'save_sessions') {
    if (__ctx.__backendWritable) __ctx.__backend = JSON.parse(args[0]);
    else throw new Error('backend unavailable (simulated write failure)');
    return '{}';
  }
  return '{}';
};
__ctx.localStorage.setItem('glm_sessions', JSON.stringify(__LOCAL_IN__));
vm.createContext(__ctx);
for (const source of Object.values(sources)) vm.runInContext(source, __ctx);
(async () => {
  const result = await vm.runInContext('(async () => {' + body + '})()', __ctx);
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
'''
    script = (script
              .replace('__DOM__', _DOM_PRELUDE)
              .replace('__SOURCES__', json.dumps(sources, ensure_ascii=False))
              .replace('__BODY__', json.dumps(body, ensure_ascii=False))
              .replace('__BACKEND_WRITABLE__', 'true' if backend_writable else 'false')
              .replace('__BACKEND_IN__', json.dumps(backend_in, ensure_ascii=False))
              .replace('__LOCAL_IN__', json.dumps(local_in, ensure_ascii=False)))
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_r99_truncation_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(script)
        result = subprocess.run([NODE, path], cwd=str(ROOT), capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=120)
        assert result.returncode == 0, (result.stdout or '') + (result.stderr or '')
        return json.loads(result.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _msgs(count: int, text: str = 'hello'):
    """构造一段 user/assistant 交替的消息历史。"""
    return [{'role': 'user' if i % 2 == 0 else 'assistant',
             'content': '%s #%d' % (text, i)} for i in range(count)]


def _session(messages, updated_at):
    return {'id': 's1', 'title': '群聊回归', 'createdAt': 1, 'updatedAt': updated_at,
            'messages': messages}


# --------------------------------------------------------------- 合并二级判据（Fix 2）
def test_tie_prefers_longer_message_list_so_complete_history_survives():
    """平局时若一侧消息更多，必须保完整那侧（原「平局恒取后端」会丢消息）。

    R97 §7.1 的「反向场景」：后端恰好持有截断版、本地镜像是完整版且时间戳相同。
    改前：平局恒取后端 → 只剩 2 条（丢 4 条）。改后：6 > 2 → 取本地完整版。
    """
    result = run_case(r'''
AppState.currentSessionId = 's1';
await loadSessions();
const s = (AppState.sessions || []).find(x => x.id === 's1');
return { count: s ? s.messages.length : -1 };
''', backend_in=[_session(_msgs(2), T0)], local_in=[_session(_msgs(6), T0)])
    assert result['count'] == 6, '平局丢消息：完整版（6 条）被截断版（2 条）覆盖'


def test_tie_with_equal_length_still_prefers_backend_projection_guard():
    """长度也相等时仍取后端——保住「本地镜像是 2k 正文投影」的原有防线。

    两侧都是 3 条（配额投影不改条数，只把正文截到 2k），必须取后端完整正文。
    防回归守卫：改前改后都必须绿。
    """
    long_text = 'A' * 3000
    backend_msgs = [{'role': 'user', 'content': long_text},
                    {'role': 'assistant', 'content': 'ok'},
                    {'role': 'user', 'content': 'tail'}]
    projected = [{'role': 'user', 'content': long_text[:2000] + '…(镜像截断)'},
                 {'role': 'assistant', 'content': 'ok'},
                 {'role': 'user', 'content': 'tail'}]
    result = run_case(r'''
AppState.currentSessionId = 's1';
await loadSessions();
const s = (AppState.sessions || []).find(x => x.id === 's1');
return { count: s.messages.length, len: String(s.messages[0].content).length };
''', backend_in=[_session(backend_msgs, T0)], local_in=[_session(projected, T0)])
    assert result['count'] == 3
    assert result['len'] == 3000, '本地镜像的 2k 截断正文压制了后端完整正文'


# --------------------------------------------------------------- 截断后重新加载（Fix 1）
def test_rollback_survives_reload_when_backend_write_failed():
    """回退 → 后端落盘失败 → 重新加载（走双源合并）：回退必须仍然生效。

    改前：截断不 bump updatedAt → 平局取后端的旧长版本 → 回退失效（又回到 6 条）。
    改后：local 严格更新 → local 胜 → 3 条（回退到下标 2 处）。
    """
    result = run_case(r'''
AppState.currentSessionId = 's1';
await loadSessions();                        // 先正常加载就位（后端此时可写）
window.__backendWritable = false;            // 之后后端落盘失败，只有本地镜像落盘
msgRollback({ dataset: { midx: '2' } }, 'hello #0');
await saveSessions();
AppState.sessions = [];                      // 模拟重开：内存清空，只剩双源
AppState.currentSessionId = null;
await loadSessions();
const s = (AppState.sessions || []).find(x => x.id === 's1');
return { count: s ? s.messages.length : -1 };
''', backend_in=[_session(_msgs(6), T0)], local_in=[_session(_msgs(6), T0)])
    assert result['count'] == 3, '回退未生效：重开后旧的长历史又回来了'


def test_rollback_keeps_truncated_state_after_clean_save_and_reload():
    """回退 → 双侧都落盘成功 → 重新加载：仍是截断后的 3 条（不得被平局规则复活）。"""
    result = run_case(r'''
AppState.currentSessionId = 's1';
await loadSessions();
msgRollback({ dataset: { midx: '2' } }, 'hello #0');
await saveSessions();
AppState.sessions = [];
AppState.currentSessionId = null;
await loadSessions();
const s = (AppState.sessions || []).find(x => x.id === 's1');
return { count: s ? s.messages.length : -1 };
''', backend_in=[_session(_msgs(6), T0)], local_in=[_session(_msgs(6), T0)])
    assert result['count'] == 3, '截断态被平局规则复活'


# --------------------------------------------------------------- 四处 bump（Fix 1 覆盖面）
_STRUCTURED = [
    ('regenerate', 'regenerate(-1);'),
    ('msgRecall', "msgRecall({ dataset: { midx: '4' } }, 'hello #4');"),
    ('msgEditResend',
     "const __el = __mkEl('div'); __el.dataset.midx = '2';"
     " __el.querySelector = () => __mkEl('div');"
     " msgEditResend(__el, 'hello #2');"
     " const __btn = document.__created.filter(e => e.tagName === 'BUTTON'"
     " && e.textContent === '保存并重发').pop();"
     " __btn.onclick();"),
    ('msgRollback', "msgRollback({ dataset: { midx: '2' } }, 'hello #0');"),
]


@pytest.mark.parametrize('name,action', _STRUCTURED, ids=[c[0] for c in _STRUCTURED])
def test_truncation_bumps_updated_at_so_it_outranks_stale_backend(name, action):
    """四个截断点都必须让 ``updatedAt`` 前进，否则截断在合并里排不到前面。

    行为断言：比较「截断动作前后」的 ``updatedAt`` 与消息条数——条数减少而
    ``updatedAt`` 不变即为缺陷（改前红）。
    """
    body = r'''
AppState.currentSessionId = 's1';
await loadSessions();
const s = (AppState.sessions || []).find(x => x.id === 's1');
const before = { updatedAt: s.updatedAt, count: s.messages.length };
ACTION
const after = { updatedAt: s.updatedAt, count: s.messages.length };
return { before: before, after: after };
'''.replace('ACTION', action)
    result = run_case(body, backend_in=[_session(_msgs(6), T0)],
                      local_in=[_session(_msgs(6), T0)])
    before, after = result['before'], result['after']
    assert after['count'] < before['count'], '%s 未截断消息（用例前提不成立）' % name
    assert after['updatedAt'] > before['updatedAt'], (
        '%s 截断了 %d→%d 条消息却没有推进 updatedAt（双源合并时会被旧的长版本压制）'
        % (name, before['count'], after['count']))
