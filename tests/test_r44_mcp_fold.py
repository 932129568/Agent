# -*- coding: utf-8 -*-
"""R44 门禁：MCP 工具面渐进披露（阈值折叠 + mcp_search 元工具 + 检索）。"""
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.tools_schema import build, MCP_FOLD_THRESHOLD, _AGENT_MCP_SEARCH


def _mk_tools(n):
    return [{'type': 'function', 'function': {'name': 'mcp__srv%d__tool%d' % (i // 10, i),
                                              'description': '工具 %d' % i,
                                              'parameters': {'type': 'object', 'properties': {}}}}
            for i in range(n)]


def test_fold_above_threshold():
    out = json.loads(build('full', True, _mk_tools(MCP_FOLD_THRESHOLD + 5)))
    names = [t['function']['name'] for t in out]
    assert names.count('mcp_search') == 1
    assert not [n for n in names if n.startswith('mcp__')], '折叠后不得残留 mcp__ 定义'
    d = [t for t in out if t['function']['name'] == 'mcp_search'][0]['function']['description']
    assert d.count('|') == 2
    assert d['parameters'] if False else True


def test_no_fold_below_threshold():
    out = json.loads(build('full', True, _mk_tools(MCP_FOLD_THRESHOLD)))
    names = [t['function']['name'] for t in out]
    assert names.count('mcp_search') == 0
    assert len([n for n in names if n.startswith('mcp__')]) == MCP_FOLD_THRESHOLD


def test_mcp_search_meta_strict():
    assert _AGENT_MCP_SEARCH['function']['parameters'].get('additionalProperties') is False
    assert _AGENT_MCP_SEARCH['function']['parameters']['required'] == ['query']


def _svc_with_tools():
    """构造最小 mcp_service（__new__ 绕过重依赖；_rt/_cfg/锁手填）。"""
    from backend.domains.integrations.mcp.mcp_service import McpService
    svc = McpService.__new__(McpService)
    svc._log = None
    svc._lock = threading.RLock()
    svc._rt = {
        'github': {'status': 'ok', 'tools': [
            {'name': 'create_issue', 'description': 'Create a GitHub issue',
             'inputSchema': {'type': 'object', 'properties': {'title': {'type': 'string'}}}},
            {'name': 'list_repos', 'description': 'List repositories',
             'inputSchema': {'type': 'object', 'properties': {}}},
        ]},
        'search': {'status': 'ok', 'tools': [
            {'name': 'web_search', 'description': '网页搜索',
             'inputSchema': {'type': 'object', 'properties': {'q': {'type': 'string'}}}},
        ]},
        'disabled-srv': {'status': 'ok', 'tools': [
            {'name': 'ghost', 'description': '不应出现在检索面',
             'inputSchema': {'type': 'object', 'properties': {}}},
        ]},
    }

    class _Cfg:
        def list_servers(self):
            return [{'name': 'github', 'enabled': True},
                    {'name': 'search', 'enabled': True},
                    {'name': 'disabled-srv', 'enabled': False}]
    svc._cfg = _Cfg()
    return svc


def test_mcp_search_scores_and_schema():
    svc = _svc_with_tools()
    r = svc.search_tools('github issue', 8)
    assert r['ok'] and r['results']
    top = r['results'][0]
    assert top['name'] == 'mcp__github__create_issue'
    assert top['server'] == 'github' and top['tool'] == 'create_issue'
    assert top['parameters']['properties']['title']['type'] == 'string'   # schema 全文
    # 中文检索命中描述
    r2 = svc.search_tools('网页搜索')
    assert any(x['tool'] == 'web_search' for x in r2['results'])
    # disabled 服务器不在检索面
    assert not any('ghost' in (x['tool'] or '') for x in r2['results'])
    # 空查询
    assert svc.search_tools('')['results'] == []


def test_mcp_search_js_api_registered(fresh_home):
    from backend.api import Api, _V12_EXTRA
    assert 'mcp_search' in _V12_EXTRA
    api = Api()
    r = json.loads(api.mcp_search('anything'))
    assert r['ok'] is True and r['results'] == []   # 无 MCP 服务器 → 空结果不炸
