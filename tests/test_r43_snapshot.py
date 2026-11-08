# -*- coding: utf-8 -*-
"""R43 门禁：browser_snapshot 语义快照原语。

覆盖：纯函数树结构（void 元素深度/隐藏剔除/名称优先级/状态位）、
schema strict + 三段式、路由 dispatch 接线、GuardOps 19 档登记。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PAGE = '''<html><head><title>T</title></head><body>
<h1>登录页</h1>
<form>
<label for="u">用户名</label><input id="u" type="text" placeholder="请输入用户名" required>
<input id="p" type="password" name="pwd">
<button type="submit" aria-label="登 录">登 录</button>
<a href="https://x.com/reset">忘记密码</a>
<select name="role"><option>管理员</option><option selected>访客</option></select>
<img src="logo.png" alt="站点徽标">
<div aria-hidden="true">隐藏层</div>
<input type="hidden" name="csrf" value="x">
</form></body></html>'''


def test_snapshot_tree_structure():
    from backend.domains.integrations.browser.snapshot import build_snapshot_result
    r = build_snapshot_result(PAGE)
    assert r['ok'] is True and r['elements'] >= 8
    tree = r['snapshot']
    # 兄弟层级正确（void 元素不漂移）：passwordbox 与 textbox 同缩进
    assert '\n      - passwordbox' in tree and '\n      - textbox' in tree
    # 名称优先级：placeholder 优先于 id；aria-label 优先于文本
    assert 'textbox「请输入用户名」' in tree
    assert 'button「登 录」' in tree
    # 状态位：required 入树；href/type 附加信息
    assert 'required' in tree and 'type=password' in tree and 'href=' in tree
    # 隐藏剔除
    assert '隐藏层' not in tree and 'csrf' not in tree
    # option 是 combobox 子级
    assert tree.index('- combobox') < tree.index('- option「管理员」')


def test_snapshot_empty_and_cap():
    from backend.domains.integrations.browser.snapshot import build_snapshot_result
    r = build_snapshot_result('')
    assert r['ok'] is False and r['error']['code'] == 'EXTRACT_EMPTY'
    big = ('<a href="#i">x</a>' * 2000)
    r2 = build_snapshot_result('<body>' + big + '</body>', max_chars=1500)
    assert r2['ok'] and r2['truncated'] is True and len(r2['snapshot']) <= 1500


def test_sessions_implement_snapshot():
    """三会话类都有 snapshot 原语；基类默认不支持。"""
    from backend.domains.integrations.browser.session_base import BrowserSession
    from backend.domains.integrations.browser.session_headless import HeadlessSession
    from backend.domains.integrations.browser.session_win import WinSession
    assert callable(WinSession.snapshot) and callable(HeadlessSession.snapshot)
    # 基类 snapshot=abstractmethod（与其它原语同型；未实现的平台类不可实例化）
    assert getattr(BrowserSession.snapshot, '__isabstractmethod__', False)


def test_snapshot_tool_and_guard_registered():
    from backend.tools_schema import AGENT_TOOLS
    by_name = {t['function']['name']: t for t in AGENT_TOOLS}
    assert 'browser_snapshot' in by_name
    d = by_name['browser_snapshot']['function']['description']
    assert d.count('|') == 2, d            # 三段式（M5.9）
    p = by_name['browser_snapshot']['function']['parameters']
    assert p.get('additionalProperties') is False   # M5.3 strict
    from backend.domains.security.guard_service import GUARD_OPS, DEFAULT_TIERS, OP_LABELS
    assert 'browser_snapshot' in GUARD_OPS
    assert DEFAULT_TIERS['browser_snapshot'] == 'session'
    assert OP_LABELS['browser_snapshot'] == '页面语义快照'
