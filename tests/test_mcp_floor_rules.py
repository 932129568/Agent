# -*- coding: utf-8 -*-
"""W10 MCP 楼层规则回归：tool_schemas 三道闸（描述长度/单 server 数/总数）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


def _mk_service():
    from backend.domains.integrations.mcp.mcp_service import McpService
    from backend.domains.security.guard_service import GuardService
    from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
    from backend.domains.workspace.toolcache_service import ToolcacheService
    cfg = McpConfigService()
    guard = GuardService()
    return McpService(cfg, guard, ToolcacheService(do_cleanup=False))


def _seed_rt(svc, servers):
    """注册 enabled 服务器 + 塞运行时表（_rt）模拟 ok + 工具清单。"""
    for name in servers:
        svc._cfg.save_server(name, {'enabled': True, 'command': 'x'})
    with svc._lock:
        for name, tools in servers.items():
            svc._rt[name] = {'status': 'ok', 'tools': tools}


class TestFloorRules:
    def test_desc_truncation(self, fresh_home):
        svc = _mk_service()
        long_desc = 'x' * 900
        _seed_rt(svc, {'srv': [{'name': 't1', 'description': long_desc}]})
        with svc._lock:
            svc._rt['srv']['status'] = 'ok'
        out = svc.tool_schemas()
        assert len(out) == 1
        d = out[0]['function']['description']
        assert d.endswith('…[已截断]')
        assert len(d) <= svc.MAX_TOOL_DESC_CHARS + len('…[已截断]')
        assert svc._floor_stats['truncated_desc'] == 1

    def test_per_server_cap(self, fresh_home):
        svc = _mk_service()
        tools = [{'name': 't%d' % i, 'description': 'd'} for i in range(80)]
        _seed_rt(svc, {'srv': tools})
        out = svc.tool_schemas()
        assert len(out) == svc.MAX_TOOLS_PER_SERVER == 50
        assert svc._floor_stats['skipped_per_server'] == 30

    def test_total_cap(self, fresh_home):
        svc = _mk_service()
        # 5 个 server × 50 工具 = 250 → 总量闸 200 截断
        _seed_rt(svc, {('srv%d' % i): [
            {'name': 't%d' % j, 'description': 'd'} for j in range(50)]
            for i in range(5)})
        out = svc.tool_schemas()
        assert len(out) == svc.MAX_TOTAL_TOOLS == 200
        assert svc._floor_stats['skipped_total'] == 50

    def test_sorted_stable_order(self, fresh_home):
        svc = _mk_service()
        _seed_rt(svc, {'bbb': [{'name': 't', 'description': 'd'}],
                       'aaa': [{'name': 't', 'description': 'd'}],
                       'ccc': [{'name': 't', 'description': 'd'}]})
        out = svc.tool_schemas()
        names = [o['function']['name'] for o in out]
        assert names == ['mcp__aaa__t', 'mcp__bbb__t', 'mcp__ccc__t']

    def test_normal_passthrough(self, fresh_home):
        svc = _mk_service()
        _seed_rt(svc, {'srv': [
            {'name': 'get', 'description': '获取数据',
             'inputSchema': {'type': 'object', 'properties': {'q': {'type': 'string'}}}}]})
        out = svc.tool_schemas()
        assert out[0]['function']['description'] == '[MCP·srv] 获取数据'
        assert out[0]['function']['parameters']['properties']['q'] == {'type': 'string'}
        assert svc._floor_stats == {'truncated_desc': 0, 'skipped_per_server': 0,
                                    'skipped_total': 0, 'emitted': 1}

    def test_stats_zero_before_call(self, fresh_home):
        svc = _mk_service()
        assert svc._floor_stats['emitted'] == 0

    def test_build_tools_integration(self, fresh_home):
        """build_tools(include_mcp=True) 经 tool_schemas 拿定义——楼层闸生效。"""
        from backend.api import Api
        api = Api()
        svc = api._mcp
        _seed_rt(svc, {'srv': [{'name': 't%d' % i, 'description': 'd' * 800}
                               for i in range(60)]})
        # list_servers 需 enabled——直接绕过：tool_schemas 读 _cfg.list_servers
        # 该用例只验 tool_schemas 层（api 层 enabled 过滤由契约测试覆盖）
        out = svc.tool_schemas()
        assert len(out) == 50
        assert svc._floor_stats['truncated_desc'] == 50


class TestDangerFloorRule:
    """W10 楼层规则真意（deep-research #126）：危险工具名/描述 → always 档。"""

    def test_delete_prefix_always(self):
        from backend.domains.integrations.mcp.mcp_service import McpService
        assert McpService.derive_tier({}, 'delete_file', '删除文件') == 'always'
        assert McpService.derive_tier({}, 'drop_table', '') == 'always'
        assert McpService.derive_tier({}, 'purge_cache', '') == 'always'
        assert McpService.derive_tier({}, 'wipe_disk', '') == 'always'

    def test_readonly_annotation_still_session(self):
        from backend.domains.integrations.mcp.mcp_service import McpService
        assert McpService.derive_tier({'readOnlyHint': True}, 'get_status', '查询') == 'session'

    def test_danger_desc_even_if_name_innocent(self):
        from backend.domains.integrations.mcp.mcp_service import McpService
        # 名字无害但描述含破坏性表述 → 楼层规则捕获
        assert McpService.derive_tier({}, 'run_action', '此操作会 delete 所有记录') == 'always'

    def test_no_annotation_default_always(self):
        from backend.domains.integrations.mcp.mcp_service import McpService
        assert McpService.derive_tier({}, 'do_stuff', '做点事') == 'always'

    def test_resolve_tier_floor_source(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import McpService
        from backend.domains.security.guard_service import GuardService
        from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
        from backend.domains.workspace.toolcache_service import ToolcacheService
        svc = McpService(McpConfigService(), GuardService(),
                         ToolcacheService(do_cleanup=False))
        svc._cfg.save_server('srv', {'enabled': True, 'command': 'x'})
        with svc._lock:
            svc._rt['srv'] = {'status': 'ok', 'tools': [
                {'name': 'delete_all', 'description': '清空数据'},
                {'name': 'get_data', 'description': '读取数据'}]}
        tier, source = svc.resolve_tier('srv', 'delete_all')
        assert tier == 'always' and source == 'floor-rule'
        tier2, source2 = svc.resolve_tier('srv', 'get_data')
        assert tier2 == 'always' and source2 == 'default'


class TestTofuAndHealth:
    """W10 TOFU schema hash + 健康度三态（deep-research W10）。"""

    def _mk(self):
        from backend.domains.integrations.mcp.mcp_service import McpService
        from backend.domains.security.guard_service import GuardService
        from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
        from backend.domains.workspace.toolcache_service import ToolcacheService
        svc = McpService(McpConfigService(), GuardService(),
                         ToolcacheService(do_cleanup=False))
        svc._cfg.save_server('srv', {'enabled': True, 'command': 'x'})
        return svc

    def _seed(self, svc, tools):
        with svc._lock:
            svc._rt['srv'] = {'status': 'ok', 'tools': tools}

    def test_first_use_records_hash(self):
        svc = self._mk()
        self._seed(svc, [{'name': 't1', 'description': 'd',
                          'inputSchema': {'type': 'object'}}])
        svc.tool_schemas()
        assert 'srv' in svc._schema_hash
        assert svc.server_health('srv') == 'ok'

    def test_schema_change_flags_review(self):
        svc = self._mk()
        self._seed(svc, [{'name': 't1', 'description': 'd'}])
        svc.tool_schemas()
        # 服务器悄悄换工具（同名不同 schema）
        self._seed(svc, [{'name': 't1', 'description': '恶意改写'},
                         {'name': 't2', 'description': '新工具'}])
        svc.tool_schemas()
        assert 'srv' in svc._schema_review
        # 列表视图暴露待重审
        row = [s for s in svc.list_servers() if s['name'] == 'srv'][0]
        assert row['schema_review'] is True

    def test_review_ack_clears(self):
        svc = self._mk()
        self._seed(svc, [{'name': 't1', 'description': 'a'}])
        svc.tool_schemas()
        self._seed(svc, [{'name': 't1', 'description': 'b'}])
        svc.tool_schemas()
        assert svc.schema_review_ack('srv')['ok']
        assert 'srv' not in svc._schema_review

    def test_health_three_states(self):
        svc = self._mk()
        assert svc.server_health('srv') == 'ok'
        svc.report_result('srv', False)
        assert svc.server_health('srv') == 'degraded'
        svc.report_result('srv', False)
        svc.report_result('srv', False)
        assert svc.server_health('srv') == 'error'
        svc.report_result('srv', True)
        assert svc.server_health('srv') == 'ok'

    def test_health_in_list_servers(self):
        svc = self._mk()
        svc.report_result('srv', False)
        row = [s for s in svc.list_servers() if s['name'] == 'srv'][0]
        assert row['health'] == 'degraded'
