# -*- coding: utf-8 -*-
"""R20 源码扫描修复回归（子代理广撒网 → 主会话逐条实证 → 全部落地）。"""
import re
from pathlib import Path

from test_connect_merge import _run_node

from helpers.frontend import read_frontend_source
ROOT = Path(__file__).resolve().parent.parent
GROUP = ROOT / 'frontend' / 'src' / 'group' / 'group.js'


def _run(body, name):
    return _run_node((r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
""" + body + """
}
"""), name)


def test_setbrief_uses_text_node_not_html_interpolation():
    src = GROUP.read_text(encoding='utf-8')
    assert "briefEl.innerHTML = '<span class=\"gwb-dots\"><i></i><i></i><i></i></span> ';" in src
    assert 'briefEl.appendChild(document.createTextNode(' in src
    assert "String(t || '').slice(0, 60); };" not in src


def test_handoff_card_key_rendered_via_textcontent():
    src = GROUP.read_text(encoding='utf-8')
    assert "'<span class=\"gh-k\">' + r.k" not in src
    assert 'ks[i].textContent = r.k' in src


def test_member_name_html_escaped_in_bubble_and_detail():
    src = GROUP.read_text(encoding='utf-8')
    assert src.count("replace(/</g, '&lt;')") >= 4   # 气泡名/chip/详情页/qHint
    assert "'<div class=\"gwb-head\"><span class=\"gwb-name\" title=\"长按编辑该成员\">' + name + '</span>'" in src


def test_group_speak_acc_is_local_not_module_state():
    src = GROUP.read_text(encoding='utf-8')
    assert 'let acc = 0;' in src and 'acc += String(delta' in src
    assert 'groupSpeak._acc' not in src


def test_ui_confirm_contract_keys():
    src = (ROOT / 'frontend' / 'src' / 'group' / 'files.js').read_text(encoding='utf-8')
    assert "body: '删除「'" in src and 'okText:' in src
    assert re.search(r"uiConfirm\(\{[^}]*confirmText", src) is None
    assert re.search(r"uiConfirm\(\{[^}]*message:", src) is None


def test_save_signature_covers_group_state():
    src = (ROOT / 'frontend' / 'src' / 'sessions' / 'store.js').read_text(encoding='utf-8')
    assert 's.group ? JSON.stringify(s.group)' in src


def test_trust_sets_keyed_by_run_sid():
    guard = (ROOT / 'frontend' / 'src' / 'agent' / 'guard.js').read_text(encoding='utf-8')
    mcp = (ROOT / 'frontend' / 'src' / 'integrations' / 'mcp-exec.js').read_text(encoding='utf-8')
    ex = (ROOT / 'frontend' / 'src' / 'agent' / 'tool-executor.js').read_text(encoding='utf-8')
    assert 'guardTrusted.has(String(runSid' in guard
    assert 'guardTrusted.add(String(runSid' in guard
    assert 'mcpTrusted.has(String(runSid' in mcp
    assert 'agentTrusted.has(String(runSid' in ex


def test_pending_shots_tagged_by_session():
    ex = (ROOT / 'frontend' / 'src' / 'agent' / 'tool-executor.js').read_text(encoding='utf-8')
    rc = read_frontend_source(str(ROOT), 'frontend/src/agent/run-controller.js')
    ctl = read_frontend_source(str(ROOT), 'frontend/src/sessions/controller.js')
    assert 'pendingShots.push({ sid:' in ex
    assert 'x.sid === String(s.id)' in rc                     # 消费按会话过滤
    assert '!(run.__sentShots || []).includes(x.comp)' in rc  # 发送后精确出队
    assert 'x.sid === String(__prevSid)' in ctl               # 切会话只清被离开会话
    assert rc.count('getActiveRuns() {') == 1                 # 重复定义已清


def test_max_tokens_nan_fallback():
    src = (ROOT / 'frontend' / 'src' / 'settings' / 'store.js').read_text(encoding='utf-8')
    assert "parseInt(document.getElementById('maxTokens').value, 10) || 4096" in src
