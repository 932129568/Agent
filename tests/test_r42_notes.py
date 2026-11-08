# -*- coding: utf-8 -*-
"""R42 门禁：NOTES 结构化笔记（文件系统即上下文）+ 记忆工具面接线。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402,F401


def test_notes_append_get_roundtrip(fresh_home):
    from backend.api import Api
    api = Api()
    sid = 'sess-abc_1'
    r = json.loads(api.notes_append(sid, '纪要一：部署脚本在 D 盘'))
    assert r['ok'] is True and r['chars'] > 0
    r2 = json.loads(api.notes_append(sid, '纪要二：迁移到 E 盘'))
    assert r2['ok'] is True
    g = json.loads(api.notes_get(sid))
    assert g['ok'] and '纪要一' in g['text'] and '纪要二' in g['text']
    assert g['text'].index('纪要一') < g['text'].index('纪要二')   # 追加序
    # 独立文件（config.json 零污染）：notes/<sid>.md
    from backend import paths
    assert os.path.isfile(os.path.join(paths.NOTES_DIR, sid + '.md'))


def test_notes_bounds_and_empty(fresh_home):
    from backend.api import Api
    api = Api()
    assert json.loads(api.notes_get('never-existed'))['text'] == ''
    # err() 家族形态：{'error': ...}（无 ok 键）——与 memory_delete 拒绝分支同款
    assert json.loads(api.notes_append('s1', '')).get('error')
    # sid 白名单（防路径穿越）
    assert json.loads(api.notes_append('../evil', 'x')).get('error')
    assert json.loads(api.notes_append('a/b', 'x')).get('error')


def test_notes_purge_cleans(fresh_home):
    from backend.api import Api
    api = Api()
    sid = 'sess-purge'
    api.notes_append(sid, '将随会话清除')
    from backend import paths
    assert os.path.isfile(os.path.join(paths.NOTES_DIR, sid + '.md'))
    api.session_purge(sid)
    assert not os.path.exists(os.path.join(paths.NOTES_DIR, sid + '.md'))


def test_memory_tools_wired_and_strict():
    """R42 工具面：AGENT_TOOLS 含记忆工具族；executor 分发落位。"""
    from backend.tools_schema import AGENT_TOOLS
    names = {t['function']['name'] for t in AGENT_TOOLS}
    assert {'memory_write', 'memory_search'} <= names
    # 三段式（恰 2 竖线）
    for t in AGENT_TOOLS:
        if t['function']['name'].startswith('memory_'):
            assert t['function']['description'].count('|') == 2, t['function']['name']
    rc = (os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'frontend', 'src', 'agent', 'tool-executor.js'))
    src = open(rc, encoding='utf-8').read()
    assert "callApi('memory_remember', [String(args.text || ''), 'assistant', true])" in src
    assert "callApi('memory_search'" in src
    # 路由 bypass（记忆工具不参与域裁剪）
    rcs = open(os.path.join(os.path.dirname(rc), 'run-controller.js'),
               encoding='utf-8').read()
    assert '/^(browser_|software_|memory_)/' in rcs
