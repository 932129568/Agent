# -*- coding: utf-8 -*-
"""QA 独立对抗性回归（v1.3 MCP）——Edward（QA Engineer）。

与 tests/test_v13_mcp.py（工程师自测）相互独立：不复用其桩脚本与辅助函数，
从 PRD Given/When/Then 与契约红线出发重新取证。只加测试，不改源码。

覆盖：
- A 契约红线：build_tools 默认路径与 legacy Api 实例逐字节比对（ro/chat/full × ws on/off）；
  get_api_info 原始串逐字节；_V12_EXTRA 与实际 def 一一对应（ast 静态核对）；
  真实 config.json 无 mcp 键 + 跑测前后比对。
- B PRD 补证：R1 版本不匹配人话含 supported 列表（service 层）；R4 双工具注入+回传/
  structuredContent 序列化/超长截断 read_more 实取；R5 详情档位与 instructions；
  R6 atexit 注册 + 真实子进程退出无残留 + SIGKILL 兜底 + 缺 npx 人话。
- C 对抗深挖：>64KB 单帧 / stdout 混入非 JSON 行 / stderr 洪泛 / 半关闭 /
  配置截断与加密标记篡改降级 / DPAPI 解密失败 monkeypatch / tierOverrides 压注解 /
  import 边界（空串/非对象条目/重复导入）/ 命名净化（中文/跨服务器重名去重/超长）。
- D 前端 node 实测：62-mcp-exec fail-closed / 拒绝路径 / 会话信任；
  25-tool-exec 挂点 fail-closed 与分发；80-utils 标签；60-agent-loop include_mcp 传参；
  36-cost-defense 熔断 ×3；100-send toggleSettings 回归。
- E 冒烟六步测试层自动化（导入→启用→确认→拒绝→审计→熔断）。
"""
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

import pytest

from conftest import HOME, NewApi, legacy
from helpers.frontend import read_frontend_source

from backend import paths
from backend.domains.integrations.mcp import mcp_dpapi
from backend.domains.integrations.mcp.mcp_client import McpClient, McpTimeoutError
from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
from backend.domains.integrations.mcp.mcp_service import McpService
from backend.domains.integrations.mcp.mcp_transport_stdio import StdioTransport

NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_SRC = os.path.join(PROJECT_ROOT, 'frontend', 'src')

# ================================================================ A 契约红线

class TestContractRedLines:
    """契约四红线独立取证（不信任工程师自测结论）。"""

    def test_build_tools_byte_identical_to_legacy_instance(self):
        """与 legacy Api【实例】逐字节比对（非与 tools_schema 自比）。"""
        # 测试隔离修复（QA-3 裁定：A 测试隔离缺陷，非源码漂移）：
        # legacy 的 ws_enabled 是模块级内存 _RT（main_v1.0.0_legacy.py L139），
        # conftest 的 fresh_home 只清文件系统、不清内存。test_api_contract.py
        # ::test_build_tools_byte_identical（L238）循环末轮残留 _RT['ws_enabled']['']=False，
        # 导致全量套件顺序下 la 侧 ws_on=False、na 侧默认 True，逐字节比对假失败。
        # 此处显式弹出 legacy 模块级残留，对齐两侧默认态（NewApi 每用例新建 RuntimeState，
        # 文件已被 fresh_home 清除，天然为默认 True）。比对强度不变。
        legacy._RT['ws_enabled'].pop('', None)
        la = legacy.Api()
        na = NewApi()
        for role in ('full', 'ro', 'chat'):
            assert na.build_tools(role) == la.build_tools(role), \
                'build_tools(%r) 默认路径与 legacy 漂移' % role
            assert na.build_tools(role, include_mcp=False) == la.build_tools(role)
        # ws_on=False 两侧同样一致（先切 sid 再关 ws，两侧状态对齐）
        la.set_current_sid('qa'); na.set_current_sid('qa')
        la.set_ws_enabled('qa', False); na.set_ws_enabled('qa', False)
        for role in ('full', 'ro'):
            assert na.build_tools(role) == la.build_tools(role), \
                'build_tools(%r, ws_on=False) 与 legacy 漂移' % role
        la.set_ws_enabled('qa', True); na.set_ws_enabled('qa', True)
        assert na.build_tools('full') == la.build_tools('full')

    def test_include_mcp_never_injects_for_nonfull(self):
        """Q3 裁决：仅 full 注入；ro/chat 即使 include_mcp=True 也不注入。"""
        api = NewApi()
        try:
            # 造一个 enabled+ok 的运行时服务器（不经网络）
            api._mcp_cfg.save_server('s', {'command': 'c', 'enabled': True})
            entry = api._mcp._ensure_entry('s')
            entry['status'] = 'ok'
            entry['tools'] = [{'name': 'echo', 'inputSchema': {'type': 'object'}}]
            assert 'mcp__s__echo' in api.build_tools('full', include_mcp=True)
            for role in ('ro', 'chat'):
                out = api.build_tools(role, include_mcp=True)
                assert 'mcp__' not in out, '%s 角色不得注入 MCP 工具' % role
            # 无启用服务器时 include_mcp=True 与默认路径一致
            api._mcp_cfg.save_server('s', {'command': 'c', 'enabled': False})
            assert api.build_tools('full', include_mcp=True) == api.build_tools('full')
        finally:
            api.mcp_shutdown()

    def test_get_api_info_raw_string_identical(self):
        """get_api_info 原始返回串（非解析后）与 legacy 逐字节一致。"""
        la = legacy.Api().get_api_info()
        na = NewApi().get_api_info()
        assert na == la
        info = json.loads(na)
        for m in ('mcp_list_servers', 'mcp_save_server', 'mcp_delete_server',
                  'mcp_test_server', 'mcp_get_server_detail', 'mcp_set_tool_tier',
                  'mcp_check_tool', 'mcp_call_tool', 'mcp_import_claude', 'mcp_shutdown'):
            assert m not in info['methods']

    def test_v12_extra_matches_actual_defs(self):
        """_V12_EXTRA 中 mcp_* 与 api.py 类 Api 实际 def 一一对应。

        实现 v1.6 T12：v1.3 的 10 个 + resources 三方法 = 13 个；新增必须同步登记
        _V12_EXTRA（get_api_info 零漂移）。"""
        from backend.api import _V12_EXTRA
        src = open(os.path.join(PROJECT_ROOT, 'backend', 'api.py'),
                   encoding='utf-8').read()
        tree = ast.parse(src)
        api_cls = next(n for n in tree.body
                       if isinstance(n, ast.ClassDef) and n.name == 'Api')
        actual = {n.name for n in api_cls.body
                  if isinstance(n, ast.FunctionDef) and n.name.startswith('mcp_')}
        declared = {n for n in _V12_EXTRA if n.startswith('mcp_')}
        assert actual == declared, '漏登记: %s；幽灵名: %s' % (
            sorted(actual - declared), sorted(declared - actual))
        assert len(declared) == 14   # R44：+mcp_search（渐进披露元工具，_V12_EXTRA）
        # v1.6 T12：三个 resources 方法在册
        assert {'mcp_list_resources', 'mcp_read_resource',
                'mcp_save_subscriptions'} <= declared
        # v1.2 的 10 个隐身方法仍在集合内（无回归移除）
        v12 = {'guard_get_config', 'guard_save_config', 'guard_check', 'guard_audit',
               'get_audit_log', 'check_update', 'start_update_download',
               'get_update_progress', 'apply_update', 'test_provider_endpoint'}
        assert v12 <= set(_V12_EXTRA)
        # 实例上真实可调用
        api = NewApi()
        try:
            for m in sorted(declared):
                assert callable(getattr(api, m)), m
        finally:
            api.mcp_shutdown()

    def test_real_config_json_has_no_mcp_key(self):
        """真实（隔离 HOME 下）config.json 无任何 mcp 键/段。"""
        p = paths.CONFIG_PATH
        if os.path.exists(p):
            raw = open(p, 'rb').read()
            assert b'mcpServers' not in raw and b'mcp_servers' not in raw, \
                'config.json 疑似被 MCP 配置污染: %r' % raw[:200]
            data = json.loads(raw.decode('utf-8'))
            assert not any('mcp' in k.lower() for k in data)

    def test_config_json_bytes_unchanged_across_mcp_operations(self):
        """导入/保存/启用/定档/调用/测试/关闭全流程后 config.json 逐字节不变。"""
        p = paths.CONFIG_PATH
        before = open(p, 'rb').read() if os.path.exists(p) else None
        api = NewApi()
        try:
            api.mcp_import_claude(json.dumps({'mcpServers': {
                'a': {'command': 'c', 'env': {'K': 'v'}},
                'b': {'url': 'https://x.example/mcp', 'headers': {'H': '1'}}}}))
            api.mcp_save_server('a', json.dumps({'command': 'c', 'enabled': True}))
            api.mcp_list_servers()
            api.mcp_get_server_detail('a')
            api.mcp_check_tool('a', 't', '{"x":1}')
            api.mcp_call_tool('a', 't', '{}', 'deny')
            api.mcp_set_tool_tier('a', 't', 'off')
            api.mcp_test_server('a')
            api.build_tools('full', include_mcp=True)
            api.mcp_shutdown()
            api.mcp_delete_server('a')
            api.mcp_delete_server('b')
        finally:
            api.mcp_shutdown()
        after = open(p, 'rb').read() if os.path.exists(p) else None
        assert before == after


# ================================================================ 独立 stdio 桩
# 与工程师桩脚本无关的新桩：按 mode 表现不同服务器行为。
_QA_STUB = r'''
import json, os, signal, sys, time

mode = sys.argv[1] if len(sys.argv) > 1 else 'ok'
LOG = os.environ.get('QA_STUB_LOG')

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def log(entry):
    if LOG:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(entry + '\n')

def recv():
    line = sys.stdin.readline()
    if not line:
        return None
    try:
        return json.loads(line)
    except Exception:
        return None

def noise():
    # stdout 混入非 JSON 行 + 空行（客户端必须丢弃并继续工作）
    sys.stdout.write('this is not json line\n')
    sys.stdout.write('\n')
    sys.stdout.flush()

req = recv()
if not req or req.get('method') != 'initialize':
    sys.exit(2)
if mode == 'oldver':
    send({'jsonrpc': '2.0', 'id': req['id'], 'result': {
        'protocolVersion': '2024-11-05', 'serverInfo': {'name': 'old'},
        'supported': ['2024-11-05', '2025-03-26'], 'capabilities': {}}})
    sys.exit(0)
send({'jsonrpc': '2.0', 'id': req['id'], 'result': {
    'protocolVersion': '2025-06-18', 'serverInfo': {'name': 'qa-stub', 'version': '9'},
    'instructions': 'qa instructions', 'capabilities': {}}})
n = recv()
log('initialized')
if mode == 'noise':
    noise()
if mode == 'stderrflood':
    sys.stderr.write('E' * 300000)
    sys.stderr.flush()
if mode == 'halfclose':
    # 握手后关闭 stdout（半关闭）：进程还活着但不再说话
    try:
        sys.stdout.close()
    except Exception:
        pass
    time.sleep(30)
    sys.exit(0)
if mode == 'stubborn':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)   # 忽略 TERM，只能被 KILL
    log('stubborn-armed')
    while True:                                     # 且不理会 stdin EOF
        time.sleep(0.5)
while True:
    req = recv()
    if req is None:
        break
    mid = req.get('id')
    method = req.get('method')
    log(method or '?')
    if method == 'tools/list':
        if mode == 'twopage' and not (req.get('params') or {}).get('cursor'):
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'tools': [{'name': 'alpha', 'description': 'A',
                           'inputSchema': {'type': 'object', 'properties': {}},
                           'annotations': {'readOnlyHint': True}}],
                'nextCursor': 'p2'}})
        elif mode == 'twopage':
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'tools': [{'name': 'beta', 'description': 'B',
                           'inputSchema': {'type': 'object', 'properties': {}},
                           'annotations': {'destructiveHint': True}}]}})
        else:
            send({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': [
                {'name': 'echo', 'description': 'echo tool',
                 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]}})
    elif method == 'tools/call':
        name = (req.get('params') or {}).get('name')
        if name == 'struct':
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'content': [], 'structuredContent': {'rows': [1, 2, 3], 'ok': True}}})
        elif name == 'bigout':
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'content': [{'type': 'text', 'text': 'B' * 120000}]}})
        elif name == 'halfclose':
            sys.stdout.close()
            time.sleep(30)
        else:
            args = (req.get('params') or {}).get('arguments') or {}
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'content': [{'type': 'text', 'text': 'echo:' + json.dumps(args, ensure_ascii=False)}],
                'structuredContent': {'echo': args}}})
    elif method == 'ping':
        send({'jsonrpc': '2.0', 'id': mid, 'result': {}})
    else:
        send({'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': 'Method not found'}})
'''


@pytest.fixture
def qa_stub():
    fd, path = tempfile.mkstemp(suffix='.py', prefix='qa_mcp_stub_')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(_QA_STUB)
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


def _qa_log():
    fd, path = tempfile.mkstemp(suffix='.log', prefix='qa_stublog_')
    os.close(fd)
    return path


def _spawn_qa(script, mode):
    logp = _qa_log()
    t = StdioTransport()
    ok = t.start(sys.executable, [script, mode], {'QA_STUB_LOG': logp})
    assert ok
    return t, logp


# ================================================================ B PRD 补证

class TestPrdR1VersionMismatchText:
    """R1：旧版协议握手失败且错误文案含服务器支持版本列表（service 层人话出口）。"""

    def test_service_error_contains_supported_list(self, qa_stub):
        cfg = McpConfigService()
        cfg.save_server('old', {'command': sys.executable, 'args': [qa_stub, 'oldver']})
        svc = McpService(cfg, _mk_guard(), _mk_toolcache())
        try:
            r = svc.test_server('old')
            assert r.get('error')
            assert '2024-11-05' in r['error'] and '2025-06-18' in r['error']
            assert '2025-03-26' in r['error'], '错误文案须含服务器支持版本列表'
            assert '升级' in r['error'] or '禁用' in r['error']
        finally:
            svc.shutdown()

    def test_call_timeout_human_text(self, monkeypatch):
        """R1：调用超时 → 发送取消并返回人话错误（service 层出口）。"""
        from backend.domains.integrations.mcp.mcp_client import McpTimeoutError
        cfg = McpConfigService()
        svc = McpService(cfg, _mk_guard(), _mk_toolcache())
        try:
            cfg.save_server('s', {'command': 'c', 'enabled': True})
            cancelled = []

            class _C:
                def is_alive(self):
                    return True

                def list_tools(self):
                    return [{'name': 't'}]

                def call_tool(self, n, a, timeout=None):
                    raise McpTimeoutError('tools/call', 60)

                def cancel(self, rid):
                    cancelled.append(rid)

                def close(self):
                    pass

                def set_on_list_changed(self, cb):
                    pass
            monkeypatch.setattr(McpService, '_spawn_client',
                                lambda self, name, c: (_C(), None))
            r = svc.call_tool('s', 't', {}, 'allow')
            assert r.get('error') and '超时' in r['error'] and '取消' in r['error']
        finally:
            svc.shutdown()


class TestPrdR4InjectionAndRender:
    """R4：双工具注入与回传 / structuredContent 序列化 / 超长截断 read_more。"""

    def test_two_tools_server_end_to_end(self, qa_stub):
        api = NewApi()
        try:
            r = json.loads(api.mcp_save_server('two', json.dumps({
                'command': sys.executable, 'args': [qa_stub, 'twopage'], 'enabled': True})))
            assert r.get('ok'), r
            tools = json.loads(api.build_tools('full', include_mcp=True))
            names = [t['function']['name'] for t in tools]
            assert 'mcp__two__alpha' in names and 'mcp__two__beta' in names
            assert len([n for n in names if n.startswith('mcp__')]) == 2
            # 注解推导：alpha readOnly → session；beta destructive → always
            det = json.loads(api.mcp_get_server_detail('two'))
            tiers = {t['name']: (t['tier'], t['tier_source']) for t in det['tools']}
            assert tiers['alpha'] == ('session', 'annotation')
            assert tiers['beta'] == ('always', 'annotation')
            # 调用成功回传（alpha session 档需 allow/session-trust）
            ra = json.loads(api.mcp_call_tool('two', 'alpha', '{"q":1}', 'allow'))
            assert ra.get('ok') and 'echo:{"q": 1}' in ra['output']
            # decision 缺失 + session 档 → 后端 enforce 拒绝（防绕过）
            rb = json.loads(api.mcp_call_tool('two', 'alpha', '{}', ''))
            assert rb.get('error') and '需要确认' in rb['error']
        finally:
            api.mcp_shutdown()

    def test_structured_content_serialized(self, qa_stub):
        api = NewApi()
        try:
            assert json.loads(api.mcp_save_server('s', json.dumps({
                'command': sys.executable, 'args': [qa_stub, 'ok'],
                'enabled': True}))).get('ok')
            r = json.loads(api.mcp_call_tool('s', 'struct', '{}', 'allow'))
            assert r.get('ok')
            assert '"rows"' in r['output'] and '"ok": true' in r['output']
        finally:
            api.mcp_shutdown()

    def test_oversized_output_truncate_and_read_more(self, qa_stub):
        api = NewApi()
        try:
            assert json.loads(api.mcp_save_server('s', json.dumps({
                'command': sys.executable, 'args': [qa_stub, 'ok'],
                'enabled': True}))).get('ok')
            r = json.loads(api.mcp_call_tool('s', 'bigout', '{}', 'allow'))
            assert r.get('ok') and len(r['output']) < 22000
            m = re.search(r'read_more\(cache_id="([^"]+)"', r['output'])
            assert m, '截断提示须含 cache_id'
            full = json.loads(api.read_more(m.group(1), 0, 200000))
            assert full.get('ok') and len(full.get('text') or full.get('content') or '') == 120000 \
                or 'B' * 120000 in json.dumps(full)
        finally:
            api.mcp_shutdown()


class TestPrdR5PanelDetail:
    """R5：启用后详情可见工具数与每工具档位 + instructions 展示不注入。"""

    def test_detail_tiers_and_instructions(self, qa_stub):
        api = NewApi()
        try:
            assert json.loads(api.mcp_save_server('s', json.dumps({
                'command': sys.executable, 'args': [qa_stub, 'twopage'],
                'enabled': True}))).get('ok')
            det = json.loads(api.mcp_get_server_detail('s'))
            assert det['ok'] and det['status'] == 'ok'
            assert len(det['tools']) == 2
            assert det['instructions'] == 'qa instructions'
            # 改档位保存后下次调用按新档位（R5 Then 3）
            assert json.loads(api.mcp_set_tool_tier('s', 'beta', 'off')).get('ok')
            det2 = json.loads(api.mcp_get_server_detail('s'))
            t2 = {t['name']: t['tier'] for t in det2['tools']}
            assert t2['beta'] == 'off'
            chk = json.loads(api.mcp_check_tool('s', 'beta', '{}'))
            assert chk['action'] == 'allow' and chk['tier_source'] == 'override'
            # instructions 不进入系统提示（Q4）：build_system_prompt 无 MCP 字样
            assert 'mcp' not in api.build_system_prompt().lower()
        finally:
            api.mcp_shutdown()


class TestPrdR6Lifecycle:
    """R6：退出子进程全终止 / 崩溃重拉 / 缺 npx 提示。"""

    def test_atexit_registered_in_main(self):
        src = open(os.path.join(PROJECT_ROOT, 'main.py'), encoding='utf-8').read()
        assert 'atexit.register(api._shutdown)' in src
        container_src = open(os.path.join(
            PROJECT_ROOT, 'backend', 'bootstrap', 'container.py'), encoding='utf-8').read()
        assert "'mcp', self.mcp.shutdown" in container_src

    def test_container_shutdown_reverse_order_and_idempotent(self, monkeypatch):
        from backend.application.native_ui import NativeUiDispatcher
        from backend.application.registry import TaskRegistry
        from backend.application.scheduler import DomainScheduler
        from backend.bootstrap.container import ServiceContainer
        container = ServiceContainer()
        container.scheduler = DomainScheduler(TaskRegistry())
        container.native_ui = NativeUiDispatcher.inline()
        events = []
        for name in ('search', 'driver', 'mcp'):
            setattr(container, name, type('Closer', (), {
                'shutdown': lambda self, name=name: events.append(name)})())
        monkeypatch.setattr('backend.bootstrap.container.shutdown_proxy',
                            lambda: events.append('local_proxy'))
        assert container.shutdown()['ok'] is True
        assert events == ['search', 'local_proxy', 'driver', 'mcp']
        assert container.shutdown()['ok'] is True
        assert events == ['search', 'local_proxy', 'driver', 'mcp']

    def test_shutdown_kills_real_subprocess_no_residue(self, qa_stub):
        api = NewApi()
        api.mcp_save_server('s', json.dumps({
            'command': sys.executable, 'args': [qa_stub, 'ok'], 'enabled': True}))
        entry = api._mcp._ensure_entry('s')
        client = entry['client']
        assert client is not None and client.is_alive()
        proc = client._transport._proc
        r = json.loads(api.mcp_shutdown())
        assert r.get('ok') and r['closed'] >= 1
        deadline = time.time() + 6
        while time.time() < deadline and proc.poll() is None:
            time.sleep(0.1)
        assert proc.poll() is not None, '退出后 stdio 子进程必须终止，无残留'

    def test_crash_message_contains_exit_code(self, qa_stub, monkeypatch):
        """R6/共享知识4：崩溃人话须含真实退出码 N。"""
        api = NewApi()
        try:
            api.mcp_save_server('s', json.dumps({
                'command': sys.executable, 'args': [qa_stub, 'ok'], 'enabled': True}))
            proc = api._mcp._ensure_entry('s')['client']._transport._proc
            proc.kill()
            proc.wait()
            monkeypatch.setattr(
                McpService, '_spawn_client', lambda self, name, c: (None, '无法启动 MCP 服务器'))
            r = json.loads(api.mcp_call_tool('s', 'echo', '{}', 'allow'))
            assert r.get('error') and '已自动重拉一次' in r['error']
            assert re.search(r'退出码 \d+', r['error']), \
                '崩溃人话须含真实退出码（当前实现输出 ?）'
        finally:
            api.mcp_shutdown()

    def test_close_sigkill_fallback_for_stubborn_process(self, qa_stub):
        """僵尸进程忽略 SIGTERM → 关闭序列升级 SIGKILL（规范序列兜底）。"""
        t, logp = _spawn_qa(qa_stub, 'stubborn')
        c = McpClient(t)
        c.connect()
        proc = t._proc
        t0 = time.time()
        t.close()
        assert proc.poll() is not None, 'SIGKILL 兜底后进程必须退出'
        assert time.time() - t0 < 12, '关闭序列总耗时应受 3s+2s+kill 约束'
        c.close()

    def test_missing_npx_hint(self):
        api = NewApi()
        try:
            r = json.loads(api.mcp_save_server('np', json.dumps({
                'command': 'npx-definitely-not-installed-xyz', 'enabled': True})))
            assert r.get('error')
            assert 'nodejs.org' in r['error'] and '未找到命令' in r['error']
            # 未落盘（开关回弹）
            assert json.loads(api.mcp_list_servers())['servers'] == []
        finally:
            api.mcp_shutdown()


# ================================================================ C 对抗深挖

class TestAdversarialStdio:
    def test_large_single_frame_over_64kb(self, qa_stub):
        """>64KB 单帧（读线程按行累积，不得截断/丢帧）。"""
        t, _ = _spawn_qa(qa_stub, 'ok')
        try:
            c = McpClient(t)
            c.connect()
            r = c.call_tool('bigout', {})
            assert len(r['content'][0]['text']) == 120000
            c.close()
        finally:
            t.close()

    def test_stdout_noise_lines_discarded(self, qa_stub):
        """stdout 混入非 JSON 行 + 空行：丢弃后协议照常工作。"""
        t, _ = _spawn_qa(qa_stub, 'noise')
        try:
            c = McpClient(t)
            info = c.connect()
            assert info['server_info']['name'] == 'qa-stub'
            tools = c.list_tools()
            assert [x['name'] for x in tools] == ['echo']
            r = c.call_tool('echo', {'text': 'after-noise'})
            assert 'after-noise' in r['content'][0]['text']
            c.close()
        finally:
            t.close()

    def test_stderr_flood_no_deadlock(self, qa_stub):
        """stderr 写满 300KB（drain 线程防阻塞）：握手与调用不挂死。"""
        t, _ = _spawn_qa(qa_stub, 'stderrflood')
        try:
            c = McpClient(t)
            t0 = time.time()
            info = c.connect()
            assert info['server_info']['name'] == 'qa-stub'
            assert c.list_tools()[0]['name'] == 'echo'
            assert time.time() - t0 < 10
            c.close()
        finally:
            t.close()

    def test_half_close_fails_pending_not_hang(self, qa_stub):
        """半关闭（服务器关 stdout 保活）：在途请求快速失败，不死等。"""
        t, _ = _spawn_qa(qa_stub, 'halfclose')
        try:
            c = McpClient(t)
            c.connect()
            t0 = time.time()
            with pytest.raises(McpTimeoutError):
                c._request('tools/list', {}, timeout=1.5)
            assert time.time() - t0 < 5
            c.close()
        finally:
            t.close()


class TestAdversarialConfig:
    def _write_raw(self, obj_or_text):
        p = paths.MCP_SERVERS_FILE
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            if isinstance(obj_or_text, str):
                f.write(obj_or_text)
            else:
                json.dump(obj_or_text, f, ensure_ascii=False)
        return p

    def test_truncated_json_degrades_and_recovers(self):
        p = self._write_raw('{"mcpServers": {"s": {"command": "c"')   # 截断 JSON
        cfg = McpConfigService(path=p)
        assert cfg.list_servers() == []                    # 降级为空配置
        assert cfg.save_server('s', {'command': 'c'}).get('ok')   # 保存即恢复
        assert [s['name'] for s in cfg.list_servers()] == ['s']

    def test_tampered_encryption_marker_degrades(self):
        """加密标记被手改篡改 → 解密失败明文兜底 + decrypt_failed 告警，不抛异常。"""
        self._write_raw({'mcpServers': {'s': {
            'command': 'c', 'enabled': True,
            'env': {'TOKEN': {'__enc__': 'dpapi:!!!not-base64!!!'}},
            'headers': {'H': {'__enc__': 'dpapi:AAAA'}}}}})
        cfg = McpConfigService(path=paths.MCP_SERVERS_FILE)
        view = cfg.get_server('s')
        assert view is not None
        assert sorted(view['decrypt_failed']) == ['H', 'TOKEN']
        assert view['env']['TOKEN'].startswith('dpapi:')   # 内层串兜底
        assert view['command'] == 'c'                       # 明文字段不受影响
        # 列表/保存不受损坏文件影响
        assert [s['name'] for s in cfg.list_servers()] == ['s']
        assert cfg.save_server('s', {'command': 'c2'}).get('ok')

    def test_dpapi_decrypt_failure_monkeypatch(self, monkeypatch):
        """模拟换机器：crypt32 不可用 → 解密走兜底路径不抛。"""
        cfg = McpConfigService()
        cfg.save_server('s', {'command': 'c', 'env': {'K': 'v'}})
        raw = open(paths.MCP_SERVERS_FILE, encoding='utf-8').read()
        if mcp_dpapi.is_available():
            assert 'dpapi:' in raw            # Windows 上保存即加密落盘
        # 卸载 DPAPI 后读取（解密不可用 → 标记原样 + 告警）
        monkeypatch.setattr(mcp_dpapi, '_crypt32', lambda: None)
        view = cfg.get_server('s')
        assert view is not None
        if 'dpapi:' in raw:
            assert 'dpapi:' in json.dumps(view.get('env') or {})
            assert view['decrypt_failed'] == ['K']


class TestAdversarialTierAndImport:
    def test_override_beats_annotation(self):
        cfg = McpConfigService()
        guard = _mk_guard()
        svc = McpService(cfg, guard, _mk_toolcache())
        try:
            cfg.save_server('s', {'command': 'c', 'enabled': True})
            e = svc._ensure_entry('s')
            e['tools'] = [{'name': 'ro', 'annotations': {'readOnlyHint': True}},
                          {'name': 'bad', 'annotations': {'destructiveHint': True}}]
            # 注解推导值
            assert svc.resolve_tier('s', 'ro') == ('session', 'annotation')
            assert svc.resolve_tier('s', 'bad') == ('always', 'annotation')
            # 用户覆盖压注解（含 destructive 也被压到 off）
            cfg.set_tool_tier('s', 'bad', 'off')
            cfg.set_tool_tier('s', 'ro', 'always')
            assert svc.resolve_tier('s', 'bad') == ('off', 'override')
            assert svc.resolve_tier('s', 'ro') == ('always', 'override')
        finally:
            svc.shutdown()

    def test_import_edge_cases(self):
        cfg = McpConfigService()
        assert cfg.import_claude('').get('error')                 # 空文件
        assert cfg.import_claude('{bad').get('error')             # 非法 JSON
        assert cfg.import_claude('{"mcpServers": []}').get('error')  # 段类型错
        assert cfg.import_claude('{"other": 1}').get('error')     # 缺段
        # 条目非对象 → skipped；合法条目入库 enabled=false
        r = cfg.import_claude(json.dumps({'mcpServers': {
            'good': {'command': 'c'}, 'bad-entry': 5,
            'sse': {'type': 'sse', 'url': 'https://x/sse'}}}))
        assert r['ok'] and r['imported'] == ['good'] and r['total'] == 3
        assert {s['name'] for s in r['skipped']} == {'bad-entry', 'sse'}
        # 重复导入 → 全部同名冲突跳过
        r2 = cfg.import_claude(json.dumps({'mcpServers': {'good': {'command': 'c'}}}))
        assert r2['imported'] == [] and r2['skipped'][0]['name'] == 'good'
        assert all(s['enabled'] is False for s in cfg.list_servers())

    def test_name_sanitization_adversarial(self):
        cfg = McpConfigService()
        svc = McpService(cfg, _mk_guard(), _mk_toolcache())
        try:
            # 中文/点号/空格 → 合法字符集；全非法 → 占位
            assert McpService.function_name('服务器', '工具') == 'mcp__server__tool'
            assert McpService.function_name('a.b c', 'x.y z') == 'mcp__a_b_c__x_y_z'
            assert McpService.function_name('!!!', '###') == 'mcp__server__tool'
            # 超长截断 + hash 唯一性
            n1 = McpService.function_name('s' * 40, 't' * 40)
            n2 = McpService.function_name('s' * 40, 't' * 39 + 'u')
            assert len(n1) == 64 and len(n2) == 64 and n1 != n2
            # 跨服务器净化后重名 → tool_schemas 去重 _2
            cfg.save_server('a.b', {'command': 'c', 'enabled': True})
            cfg.save_server('a_b', {'command': 'c', 'enabled': True})
            for sname in ('a.b', 'a_b'):
                e = svc._ensure_entry(sname)
                e['status'] = 'ok'
                e['tools'] = [{'name': 'c', 'inputSchema': {'type': 'object'}}]
            names = [x['function']['name'] for x in svc.tool_schemas()]
            assert len(names) == len(set(names)) == 2
            assert 'mcp__a_b__c' in names and 'mcp__a_b__c_2' in names
        finally:
            svc.shutdown()

    def test_tier_off_executes_with_missing_decision(self, monkeypatch):
        """tier=off 时 decision 缺失（''）也放行（用户显式关闭确认）。"""
        cfg = McpConfigService()
        svc = McpService(cfg, _mk_guard(), _mk_toolcache())
        try:
            cfg.save_server('s', {'command': 'c', 'enabled': True})
            cfg.set_tool_tier('s', 't', 'off')
            calls = []

            class _C:
                def is_alive(self):
                    return True

                def list_tools(self):
                    return [{'name': 't'}]

                def call_tool(self, n, a, timeout=None):
                    calls.append(n)
                    return {'content': [{'type': 'text', 'text': 'ran'}]}

                def close(self):
                    pass

                def set_on_list_changed(self, cb):
                    pass
            monkeypatch.setattr(McpService, '_spawn_client',
                                lambda self, name, c: (_C(), None))
            r = svc.call_tool('s', 't', {}, '')          # decision 缺失
            assert r.get('ok') and calls == ['t']
        finally:
            svc.shutdown()


class TestAdversarialEnforceBypass:
    """绕过前端直接调后端（mcp_call_tool 无 decision）：always/session 必须拒绝。"""

    def test_backend_enforce_all_paths(self, monkeypatch):
        cfg = McpConfigService()
        svc = McpService(cfg, _mk_guard(), _mk_toolcache())
        try:
            cfg.save_server('s', {'command': 'c', 'enabled': True})
            cfg.set_tool_tier('s', 't_off', 'off')
            cfg.set_tool_tier('s', 't_sess', 'session')
            cfg.set_tool_tier('s', 't_always', 'always')
            calls = []

            class _C:
                def is_alive(self):
                    return True

                def list_tools(self):
                    return []

                def call_tool(self, n, a, timeout=None):
                    calls.append(n)
                    return {'content': [{'type': 'text', 'text': 'ran'}]}

                def close(self):
                    pass

                def set_on_list_changed(self, cb):
                    pass
            monkeypatch.setattr(McpService, '_spawn_client',
                                lambda self, name, c: (_C(), None))
            # 绕过前端：decision 缺失 / 未知值
            for tool in ('t_sess', 't_always'):
                for bad in ('', None, 'bypass', 'ALLOW'):
                    r = svc.call_tool('s', tool, {}, bad)
                    assert r.get('error') and '需要确认' in r['error'], (tool, bad)
            assert calls == []                            # 一次都没执行
            # 合法 decision 才放行
            assert svc.call_tool('s', 't_always', {}, 'allow').get('ok')
            assert svc.call_tool('s', 't_sess', {}, 'session-trust').get('ok')
            assert len(calls) == 2
            # off 档缺失也放行
            assert svc.call_tool('s', 't_off', {}, '').get('ok')
            assert len(calls) == 3
        finally:
            svc.shutdown()


# ================================================================ 前端 node 实测

def _mk_guard():
    from backend.domains.security.guard_service import GuardService
    return GuardService()


def _mk_toolcache():
    from backend.domains.workspace.toolcache_service import ToolcacheService
    return ToolcacheService()


def _extract_fn(src, pattern):
    """从 JS 源码正则抽取单个函数/箭头定义（括号配平）。"""
    m = re.search(pattern, src)
    assert m, '未找到: %s' % pattern
    i = m.end() - 1
    depth = 0
    in_str = None
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
        i += 1
    raise AssertionError('括号未配平: %s' % pattern)


def _read(p):
    return read_frontend_source(PROJECT_ROOT, p)


def _run_node(js, name):
    """跑一段拼装 JS，返回其 stdout JSON（skip 条件：node 缺失）。"""
    if not os.path.exists(NODE):
        pytest.skip('node 不可用: %s' % NODE)
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_fe_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
        return json.loads(r.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


class TestFrontendMcpExec:
    """62-mcp-exec.js + 25-tool-exec.js 挂点实测（fail-closed 语义）。"""

    HARNESS = r'''
// ---- stubs ----
const __calls = [];
let __uiConfirmResult = { ok: true, checked: false };
let __checkVerdict = { action: 'confirm', tier: 'always', tier_source: 'default' };
let __callApiThrows = false;
let __toasts = [];
async function callApi(name, args, timeoutMs) {
  __calls.push({ name, args, timeoutMs });
  if (__callApiThrows) throw new Error('pywebview bridge gone');
  if (name === 'mcp_check_tool') return JSON.stringify(__checkVerdict);
  if (name === 'mcp_call_tool') return JSON.stringify({ ok: true, output: 'backend-ran' });
  if (name === 'set_current_sid') return '{"ok":true}';
  return '{}';
}
function toast(msg, kind) { __toasts.push([msg, kind]); }
async function uiConfirm(opts) { return __uiConfirmResult; }
const mcpTrusted = new Set();
const currentSessionId = 'qa-sid';
async function guardCheckTool() { return null; }
const window = { pywebview: { api: {} } };
const performance = { now: () => Date.now() };
const pendingShots = [];
function smartCmd(s, n) { return String(s == null ? '' : s).slice(0, n || 40); }
// ---- modules under test ----
__MCP_EXEC__
__TOOL_EXEC__
__BUILD_LABEL__
const __origGuard = mcpGuardCheck;
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });

  // 1) mcpParseName
  ok('parse_basic', mcpParseName('mcp__srv__tool').server === 'srv'
     && mcpParseName('mcp__srv__tool').tool === 'tool');
  ok('parse_none', mcpParseName('read_file') === null && mcpParseName('') === null);
  ok('parse_nonstr', mcpParseName(null) === null);

  // 2) fail-closed：后端不可用（callApi 抛）→ blocked，不放行
  __callApiThrows = true;
  let g = await mcpGuardCheck('mcp__srv__tool', { a: 1 });
  ok('failclosed_bridge_gone', g.blocked && g.decision === 'deny'
     && JSON.parse(g.blocked).error.includes('护栏不可用'));
  __callApiThrows = false;

  // 3) block verdict → blocked {info, skipped}
  __checkVerdict = { action: 'block', reason: '服务器未启用' };
  g = await mcpGuardCheck('mcp__srv__tool', {});
  ok('block_verdict', g.blocked && JSON.parse(g.blocked).skipped === true
     && g.decision === 'deny' && __toasts.length === 1);

  // 4) allow verdict（tier=off）→ decision allow，无确认框
  __checkVerdict = { action: 'allow', tier: 'off', tier_source: 'override' };
  g = await mcpGuardCheck('mcp__srv__tool', {});
  ok('allow_verdict', g.blocked === null && g.decision === 'allow');

  // 5) confirm + 用户拒绝 → blocked skipped + 落审计 deny
  __checkVerdict = { action: 'confirm', tier: 'always', tier_source: 'default' };
  __uiConfirmResult = { ok: false, checked: false };
  __calls.length = 0;
  g = await mcpGuardCheck('mcp__srv__tool', { x: 1 });
  const denyCall = __calls.find(c => c.name === 'mcp_call_tool');
  ok('user_deny', g.blocked && JSON.parse(g.blocked).skipped === true
     && JSON.parse(g.blocked).info.includes('用户拒绝')
     && denyCall && denyCall.args[3] === 'deny');

  // 6) confirm + 同意（勾选信任）→ session-trust + 信任态
  __uiConfirmResult = { ok: true, checked: true };
  g = await mcpGuardCheck('mcp__srv__tool', {});
  ok('session_trust', g.blocked === null && g.decision === 'session-trust'
     && mcpTrusted.has('|srv__tool'));   // R20 键控
  // 信任态命中 → 不再问后端
  __calls.length = 0;
  g = await mcpGuardCheck('mcp__srv__tool', {});
  ok('trusted_hit', g.decision === 'session-trust' && __calls.length === 0);

  // 7) mcpExecTool：decision 透传 + timeoutMs=90000 + 异常不抛
  __calls.length = 0;
  let res = await mcpExecTool('mcp__srv__tool', { a: 1 }, 'allow');
  const call = __calls[0];
  ok('exec_dispatch', call.name === 'mcp_call_tool' && call.timeoutMs === 90000
     && call.args[0] === 'srv' && call.args[1] === 'tool' && call.args[3] === 'allow'
     && JSON.parse(res).ok === true);
  res = await mcpExecTool('mcp__srv__tool', {}, undefined);
  ok('exec_default_deny', __calls[__calls.length - 1].args[3] === 'deny');
  __callApiThrows = true;
  res = await mcpExecTool('mcp__srv__tool', {}, 'allow');
  ok('exec_error_no_throw', JSON.parse(res).error.includes('MCP 工具调用失败'));
  __callApiThrows = false;
  ok('exec_bad_name', JSON.parse(await mcpExecTool('nope', {}, 'allow')).error);

  // 8) 25-tool-exec 挂点：mcpGuardCheck 自身抛异常 → fail-closed 错误串
  mcpGuardCheck = async () => { throw new Error('guard exploded'); };
  res = await executeToolRaw('mcp__srv__tool', { a: 1 });
  ok('tool_exec_guard_throw_failclosed',
     JSON.parse(res).error.includes('MCP 护栏检查失败'));
  // 9) 恢复正常：完整分发链 set_current_sid → mcp_check_tool → mcp_call_tool
  mcpGuardCheck = __origGuard;
  mcpTrusted.clear();               // 清掉第 6 项的信任态，走完整定档链
  __checkVerdict = { action: 'allow', tier: 'off', tier_source: 'override' };
  __calls.length = 0;
  res = await executeToolRaw('mcp__srv__tool', { a: 1 });
  const disp = __calls.map(c => c.name);
  ok('tool_exec_full_dispatch',
     disp.includes('set_current_sid') && disp.includes('mcp_check_tool')
     && disp.includes('mcp_call_tool') && JSON.parse(res).ok === true
     && JSON.parse(res).output === 'backend-ran');

  // 10) 无 pywebview → 桌面端错误（既有行为不回归）
  window.pywebview = null;
  res = await executeToolRaw('read_file', { path: 'x' });
  ok('no_pywebview', JSON.parse(res).error.includes('桌面端'));
  window.pywebview = { api: {} };

  // 11) buildToolLabel MCP 分支
  ok('label', buildToolLabel('mcp__srv__tool', {}) === '🔌 MCP srv · tool'
     && buildToolLabel('read_file', { path: 'x' }).startsWith('📖'));

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

    def test_harness(self):
        js = self.HARNESS.replace('__MCP_EXEC__', _read('62-mcp-exec.js')) \
                         .replace('__TOOL_EXEC__', _extract_fn(
                             _read('25-tool-exec.js'), r'async function executeToolRaw')) \
                         .replace('__BUILD_LABEL__', _extract_fn(
                             _read('80-utils.js'), r'function buildToolLabel'))
        out = _run_node(js, 'mcp_exec')
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端断言失败: %s' % failed
        assert len(out['checks']) >= 17


class TestFrontendAgentLoopAndToggle:
    """60-agent-loop include_mcp 传参 / 36-cost-defense 熔断 / 100-send 回归。"""

    HARNESS = r'''
// ---- stubs ----
const __calls = [];
async function callApi(name, args) {
  __calls.push({ name, args });
  if (name === 'build_tools') {
    return JSON.stringify([{ type: 'function', function: { name: 'read_file' } },
                           { type: 'function', function: { name: 'mcp__s__t' } }]);
  }
  return '{}';
}
const enableSearch = false;
function isGlmEndpoint() { return false; }
let document = { getElementById: (id) => ({ value: 'full', checked: false }) };
// ---- modules under test ----
__LOAD_BACKEND_TOOLS__
__COST_DEFENSE__
__TOGGLE_SETTINGS__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });

  // 1) full 档 → include_mcp=true
  let tools = await loadBackendTools('full');
  ok('full_include_mcp', __calls[0].name === 'build_tools'
     && __calls[0].args[0] === 'full' && __calls[0].args[1] === true
     && tools.length === 2);
  // 2) readonly / off 档 → include_mcp=false
  await loadBackendTools('readonly');
  ok('ro_no_mcp', __calls[1].args[0] === 'ro' && __calls[1].args[1] === false);
  await loadBackendTools('off');
  ok('chat_no_mcp', __calls[2].args[0] === 'chat' && __calls[2].args[1] === false);
  // 3) 非数组返回 → 抛错（前端显式报错不静默降级）
  let threw = false;
  callApi = async () => '"not-array"';
  try { await loadBackendTools('full'); } catch (e) { threw = true; }
  ok('non_array_throws', threw);

  // 4) R4 熔断：同工具同参数（含 mcp__ 全名）第 3 次触发
  resetCostDefense();
  const sig = JSON.stringify([['mcp__srv__tool', '{"a":1}']]);
  ok('loop_1', registerToolSig(sig) === null);
  ok('loop_2', registerToolSig(sig) === null);
  const r3 = registerToolSig(sig);
  ok('loop_3', r3 && r3.loop === true && r3.count === 3);
  // 不同参数不误触
  resetCostDefense();
  registerToolSig(JSON.stringify([['mcp__srv__tool', '{"a":1}']]));
  registerToolSig(JSON.stringify([['mcp__srv__tool', '{"a":2}']]));
  ok('loop_diff_args', registerToolSig(JSON.stringify([['mcp__srv__tool', '{"a":1}']])) === null);

  // 5) 100-send toggleSettings 回归：打开设置刷新 MCP 列表，不破坏既有流程
  let loadCalls = 0;
  // 桩保真（2026-10-18）：toggleSettings 已是「开/关」双分支——关闭走 .hiding + MOTION 退场，
  // 首句就要 classList.contains；原桩只给了空 toggle，真实 DOM 的 classList 恒有
  // contains/add/remove。这里补成 Set 支撑的忠实实现（不改被测语义，只补桩能力）。
  const __cls = new Set();
  const panel = { classList: {
    contains: (c) => __cls.has(c),
    add: (...cs) => { cs.forEach(c => __cls.add(c)); },
    remove: (...cs) => { cs.forEach(c => __cls.delete(c)); },
    toggle: (c) => { if (__cls.has(c)) { __cls.delete(c); return false; } __cls.add(c); return true; },
  } };
  const __origDoc = document;
  document = { getElementById: (id) => id === 'settingsPanel' ? panel : __origDoc.getElementById(id) };
  loadMcpServers = async () => { loadCalls++; };
  toggleSettings();
  ok('toggle_refreshes_mcp', loadCalls === 1);
  // loadMcpServers 缺失（旧模块组合）→ 不得抛出
  loadMcpServers = undefined;
  let toggleThrew = false;
  try { toggleSettings(); } catch (e) { toggleThrew = true; }
  ok('toggle_survives_missing_loader', !toggleThrew);

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

    def test_harness(self):
        js = self.HARNESS \
            .replace('__LOAD_BACKEND_TOOLS__', _extract_fn(
                _read('60-agent-loop.js'), r'const loadBackendTools = async \(mode\) =>')) \
            .replace('__COST_DEFENSE__',
                     'let _cd = null;\n'
                     + _extract_fn(_read('36-cost-defense.js'), r'function resetCostDefense') + '\n'
                     + _extract_fn(_read('36-cost-defense.js'), r'function registerToolSig')) \
            .replace('__TOGGLE_SETTINGS__', _extract_fn(
                _read('100-send.js'), r'function toggleSettings'))
        out = _run_node(js, 'agent_loop')
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端断言失败: %s' % failed
        assert len(out['checks']) >= 8


class TestFrontendPanel:
    """29-mcp.js 面板：状态灯映射 / 启用失败红灯+toast 人话 / 版本不匹配双 toast。"""

    HARNESS = r'''
// ---- DOM stub ----
function __el() {
  return { innerHTML: '', className: '', textContent: '', value: '', checked: false,
           style: {}, appendChild() {}, classList: { toggle() {}, add() {}, remove() {} } };
}
const document = {
  getElementById: () => __el(),
  createElement: () => __el(),
};
// ---- IPC stubs ----
const __toasts = [];
const __apiCalls = [];
let __saveResp = {};
let __testResp = {};
let __detailResp = { config: { command: 'c' } };
async function callApi(name, args, timeoutMs) {
  __apiCalls.push({ name, args, timeoutMs });
  if (name === 'mcp_get_server_detail') return JSON.stringify(__detailResp);
  if (name === 'mcp_save_server') return JSON.stringify(__saveResp);
  if (name === 'mcp_test_server') return JSON.stringify(__testResp);
  if (name === 'mcp_list_servers') return JSON.stringify({ servers: [] });
  return '{}';
}
function toast(msg, kind, opts) { __toasts.push({ msg, kind }); }
let mcpServers = [];
// 29-mcp.js 模块级常量（真实构建中与本函数同脚本作用域）
const MCP_PANEL_TIMEOUT_MS = 90000;
const MCP_TIERS = ['always', 'session', 'off'];
const MCP_TIER_NAMES = { always: '每次确认', session: '会话内首次确认', off: '不确认' };
const MCP_STATUS_NAMES = {
  ok: '已连接', error: '错误', stale: '待刷新', disabled: '未启用', untested: '未测试'
};
let mcpServersRevision = 0;
const mcpGenerativeState = { show: false, projection: null, box: null, host: null, generate: null, raw: null };
// ---- module under test ----
__PANEL__
// 屏蔽真实列表渲染依赖（只测状态灯与 toast 语义）
const __realLoad = loadMcpServers;
loadMcpServers = async () => { __loads++; };
let __loads = 0;
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });

  // 1) 状态灯映射（R5：ok→绿灯 / error→红灯 / stale→黄 / 其余→灰）
  ok('dot_ok', mcpStatusDotCls('ok') === 'ok');
  ok('dot_err', mcpStatusDotCls('error') === 'err');
  ok('dot_stale', mcpStatusDotCls('stale') === 'stale');
  ok('dot_off', mcpStatusDotCls('disabled') === 'off' && mcpStatusDotCls('untested') === 'off');

  // 2) 启用失败 → toast err 明示原因（红灯数据源 status=error 由后端列表给出）
  __saveResp = { error: '无法启动 MCP 服务器（命令：npx）。请确认该命令已安装且可在命令行运行。' };
  await mcpToggleServer('bad', true);
  const t2 = __toasts[__toasts.length - 1];
  ok('enable_fail_toast', t2.kind === 'err' && t2.msg.includes('启用失败')
     && t2.msg.includes('无法启动 MCP 服务器'));
  // 共享知识 5：mcp_save_server 传 timeoutMs=90000
  const saveCall = __apiCalls.find(c => c.name === 'mcp_save_server');
  ok('panel_timeout_90s', saveCall && saveCall.timeoutMs === 90000);

  // 3) 启用成功 → 工具数 toast
  __toasts.length = 0;
  __saveResp = { ok: true, tools: [{ name: 'a' }, { name: 'b' }] };
  await mcpToggleServer('good', true);
  const t3 = __toasts[__toasts.length - 1];
  ok('enable_ok_toast', t3.kind === 'ok' && t3.msg.includes('2 个工具'));

  // 4) 版本不匹配 → 连接失败 toast + supported 列表 toast（R1 面板呈现）
  __toasts.length = 0;
  __testResp = { error: '该 MCP 服务器支持协议版本 2024-11-05，Harbor 支持 2025-06-18。',
                 supported: ['2024-11-05', '2025-03-26'] };
  await mcpTestServer('old');
  const kinds = __toasts.map(t => t.kind);
  ok('test_fail_toasts', kinds.includes('err') && kinds.includes('warn')
     && __toasts.some(t => t.msg.includes('2025-03-26')));

  // 5) 面板加载失败 → toast err + 列表置空（不静默）
  __toasts.length = 0;
  loadMcpServers = __realLoad;      // 还原真实加载器测其失败路径
  const realCallApi = callApi;
  callApi = async () => { throw new Error('bridge gone'); };
  await loadMcpServers();
  ok('load_fail_toast', __toasts.length === 1 && __toasts[0].kind === 'err'
     && mcpServers.length === 0);
  callApi = realCallApi;
  loadMcpServers = async () => { __loads++; };

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

    def test_harness(self):
        js = self.HARNESS.replace(
            '__PANEL__',
            _extract_fn(_read('29-mcp.js'), r'function mcpStatusDotCls') + '\n'
            + _extract_fn(_read('29-mcp.js'), r'async function mcpToggleServer') + '\n'
            + _extract_fn(_read('29-mcp.js'), r'async function mcpTestServer') + '\n'
            + _extract_fn(_read('29-mcp.js'), r'async function loadMcpServers') + '\n'
            + _extract_fn(_read('29-mcp.js'), r'function mcpGenerativeEnsure') + '\n'
            + _extract_fn(_read('29-mcp.js'), r'function renderMcpServerList'))
        out = _run_node(js, 'panel')
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端面板断言失败: %s' % failed
        assert len(out['checks']) >= 8


class TestFrontendBuildArtifact:
    """构建产物须含新模块挂点（29-mcp / 62-mcp-exec / include_mcp 传参）。

    v1.8.0 C 域：build_tools 调用点追加 include_agent + is_glm_endpoint 两参
    （R11 端点过滤 + Agent 工具族分级开关；默认 include_agent=false 路径与
    legacy 逐字节一致，契约差分由 test_v18_tools_wiring 锁定）。
    """

    def test_html_contains_mcp_modules(self):
        html = open(os.path.join(PROJECT_ROOT, 'harbor.html'),
                    encoding='utf-8').read()
        assert 'mcpGuardCheck' in html and 'mcpExecTool' in html
        assert 'mcpParseName' in html and 'loadMcpServers' in html
        assert "callApi('build_tools'," in html and 'includeAgent' in html \
            and 'isGlmEndpoint()' in html
        assert 'mcpTrusted' in html
        # 既有模块挂点仍在（无意外丢失）
        assert 'registerToolSig' in html and 'guardCheckTool' in html


# ================================================================ E 冒烟六步

class TestSmokeSixSteps:
    """冒烟六步测试层自动化：导入→启用→确认→拒绝→审计（熔断见前端实测）。"""

    def test_six_steps_automated(self, qa_stub):
        api = NewApi()
        try:
            # ① 导入 Claude 配置（3 服务器：2 stdio 桩 + 1 SSE 跳过）
            imp = json.loads(api.mcp_import_claude(json.dumps({'mcpServers': {
                'fs': {'command': sys.executable, 'args': [qa_stub, 'ok']},
                'two': {'command': sys.executable, 'args': [qa_stub, 'twopage']},
                'old-sse': {'type': 'sse', 'url': 'https://x/sse'}}})))
            assert imp['ok'] and imp['imported'] == ['fs', 'two'] and imp['total'] == 3
            lst = json.loads(api.mcp_list_servers())['servers']
            assert all(s['enabled'] is False for s in lst)      # 默认关

            # ② 启用（预检测 + 握手 + tools/list + 档位推导）
            en = json.loads(api.mcp_save_server('fs', json.dumps({
                'command': sys.executable, 'args': [qa_stub, 'ok'], 'enabled': True})))
            assert en.get('ok') and [t['name'] for t in en['tools']] == ['echo']
            srv = [s for s in json.loads(api.mcp_list_servers())['servers']
                   if s['name'] == 'fs'][0]
            assert srv['status'] == 'ok' and srv['tool_count'] == 1

            # ③ 确认（无注解 → always → confirm）
            chk = json.loads(api.mcp_check_tool('fs', 'echo', '{"text":"hi"}'))
            assert chk['action'] == 'confirm' and chk['tier'] == 'always'

            # ④ 拒绝（decision=deny → 不执行 + Agent 可见人话）
            denied = json.loads(api.mcp_call_tool('fs', 'echo', '{"text":"hi"}', 'deny'))
            assert denied.get('skipped') and '用户拒绝' in denied['info']

            # ⑤ 审计可查（check/decision 流水，禁用键不出现）
            audit = json.loads(api.get_audit_log(100, 0))
            ops = [e for e in audit['entries'] if e['op'] == 'mcp_call']
            assert {'check', 'decision'} <= {e['action'] for e in ops}
            deny_entries = [e for e in ops if e.get('decision') == 'deny']
            assert deny_entries and deny_entries[-1]['detail']['server'] == 'fs'

            # ⑥ 熔断：前端 registerToolSig 实测见 TestFrontendAgentLoopAndToggle；
            #    后端侧验证审计在 ×3 循环调用下逐次落盘（防绕过 + 可追溯）
            for _ in range(3):
                api.mcp_call_tool('fs', 'echo', '{"text":"loop"}', 'deny')
            audit2 = json.loads(api.get_audit_log(100, 0))
            loop_denies = [e for e in audit2['entries']
                           if e['op'] == 'mcp_call' and e.get('decision') == 'deny']
            assert len(loop_denies) >= 4
        finally:
            api.mcp_shutdown()
