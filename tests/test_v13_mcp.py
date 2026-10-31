# -*- coding: utf-8 -*-
"""v1.3 MCP 专项测试（R1-R7）。

覆盖（按任务批次递进填充）：
- T1 配置层：mcp_servers.json CRUD / Claude 导入 / 预检测 / DPAPI 往返与失败兜底 / config.json 零接触
- T2 协议层：stdio 帧 + 握手 + 分页 + 调用 + 超时 + 取消 + 版本不匹配 + 服务器崩溃；HTTP 头与 SSE 解析
- T3 服务层：档位推导 / enforce 矩阵 / 审计落盘 / 崩溃重拉 / idle 回收
- T4 注入链：build_tools 契约回归（默认路径逐字节）/ get_api_info 隐身 / 命名净化
- T5 面板联调用例与全量回归断言

环境：conftest 已隔离 HOME；stdio 测试用 sys.executable 临时桩脚本；HTTP mock urllib；
DPAPI 用真实 crypt32 + 失败路径 monkeypatch。既有 tests/test_api_contract.py 严禁改动。
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error

import pytest

from conftest import HOME, NewApi

from backend import paths
from backend.domains.integrations.mcp import mcp_dpapi
from backend.domains.integrations.mcp.mcp_client import (
    CALL_TIMEOUT, CONNECT_TIMEOUT, LIST_TIMEOUT, MCP_PROTOCOL_VERSION,
    McpClient, McpProtocolError, McpTimeoutError, McpVersionError)
from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
from backend.domains.integrations.mcp.mcp_transport_http import HttpTransport, HttpTransportError
from backend.domains.integrations.mcp.mcp_transport_stdio import StdioTransport


# ---------------------------------------------------------------- T1 DPAPI
class TestDpapi:
    def test_roundtrip_real_crypt32(self):
        """Windows 真实 crypt32 往返：encrypt → decrypt 还原。"""
        if not mcp_dpapi.is_available():
            pytest.skip('当前环境无 DPAPI（非 Windows）')
        secret = 'sk-mcp-test-Value_123 中文'
        marker = mcp_dpapi.encrypt_value(secret)
        assert marker.startswith('dpapi:')
        assert secret not in marker
        assert mcp_dpapi.decrypt_value(marker) == secret

    def test_decrypt_non_marker_passthrough(self):
        assert mcp_dpapi.decrypt_value('plain-text') == 'plain-text'
        assert mcp_dpapi.decrypt_value('') == ''
        assert mcp_dpapi.decrypt_value(None) is None

    def test_mapping_roundtrip_and_failed_keys(self):
        if not mcp_dpapi.is_available():
            pytest.skip('当前环境无 DPAPI（非 Windows）')
        m = {'API_TOKEN': 'secret-1', 'OTHER': 'secret-2'}
        enc = mcp_dpapi.encrypt_mapping(m)
        assert all(isinstance(v, str) and v.startswith('dpapi:') for v in enc.values())
        dec, failed = mcp_dpapi.decrypt_mapping(enc)
        assert dec == m and failed == []
        # 落盘形态 {"__enc__": ...} 同样可解密
        dec2, failed2 = mcp_dpapi.decrypt_mapping(
            {k: {'__enc__': v} for k, v in enc.items()})
        assert dec2 == m and failed2 == []
        # 失败键：坏标记 → 内层串兜底 + 告警列表
        bad = {'K': {'__enc__': 'dpapi:not-valid-base64!!'}}
        dec3, failed3 = mcp_dpapi.decrypt_mapping(bad)
        assert failed3 == ['K']
        assert dec3['K'].startswith('dpapi:')      # 明文兜底不抛异常

    def test_unavailable_falls_back_plaintext(self, monkeypatch):
        """非 Windows / 加载失败 → 明文存储不抛异常。"""
        monkeypatch.setattr(mcp_dpapi, '_crypt32', lambda: None)
        assert mcp_dpapi.is_available() is False
        assert mcp_dpapi.encrypt_value('x') == 'x'
        assert mcp_dpapi.decrypt_value('dpapi:AAAA') == 'dpapi:AAAA'

    def test_exception_falls_back_plaintext(self, monkeypatch):
        """crypt32 调用异常 → 明文 + 日志，不抛。"""

        class _Boom:
            def CryptProtectData(self, *a, **k):
                raise OSError('boom')

            def CryptUnprotectData(self, *a, **k):
                raise OSError('boom')

        monkeypatch.setattr(mcp_dpapi, '_crypt32', lambda: _Boom())
        assert mcp_dpapi.encrypt_value('x') == 'x'
        assert mcp_dpapi.decrypt_value('dpapi:AAAA') == 'dpapi:AAAA'


# ---------------------------------------------------------------- T1 配置
def _fresh_cfg():
    return McpConfigService(path=os.path.join(HOME, '.glm-chat', 'mcp_servers.json'))


class TestMcpConfig:
    def test_save_stdio_structure_and_encryption(self):
        cfg = _fresh_cfg()
        r = cfg.save_server('fs-local', {
            'command': 'npx', 'args': ['-y', 'server-filesystem', 'C:\\Work'],
            'env': {'API_TOKEN': 'secret-token'}, 'enabled': False})
        assert r.get('ok'), r
        raw = open(paths.MCP_SERVERS_FILE, encoding='utf-8').read()
        data = json.loads(raw)
        rec = data['mcpServers']['fs-local']
        assert rec['command'] == 'npx' and rec['args'][0] == '-y'   # 明文
        assert rec['enabled'] is False
        if mcp_dpapi.is_available():
            assert 'secret-token' not in raw                       # 值加密落盘
            assert rec['env']['API_TOKEN']['__enc__'].startswith('dpapi:')
        else:
            assert rec['env']['API_TOKEN'] == 'secret-token'       # 明文容忍

    def test_list_servers_no_secrets(self):
        cfg = _fresh_cfg()
        cfg.save_server('a', {'command': 'cmd-a', 'env': {'K': 'v'}})
        cfg.save_server('b', {'url': 'https://mcp.example.com/mcp', 'headers': {'Authorization': 'Bearer x'}})
        lst = cfg.list_servers()
        assert [(s['name'], s['transport'], s['enabled']) for s in lst] == [
            ('a', 'stdio', False), ('b', 'http', False)]
        assert 'v' not in json.dumps(lst) and 'Bearer x' not in json.dumps(lst)

    def test_get_server_decrypted_view(self):
        cfg = _fresh_cfg()
        cfg.save_server('s', {'command': 'c', 'env': {'TOK': 'plain-secret'},
                              'headers': {'H': 'hval'}, 'url': None})
        cfg.save_server('h', {'url': 'https://x.example/mcp', 'headers': {'Authorization': 'Bearer z'}})
        view = cfg.get_server('s')
        assert view['command'] == 'c'
        assert view['env']['TOK'] == 'plain-secret' if not mcp_dpapi.is_available() else True
        if mcp_dpapi.is_available():
            assert view['env']['TOK'] == 'plain-secret'           # 解密回显
            hv = cfg.get_server('h')
            assert hv['headers']['Authorization'] == 'Bearer z'
        assert cfg.get_server('nope') is None

    def test_validation_errors(self):
        cfg = _fresh_cfg()
        assert cfg.save_server('x', {}).get('error')               # 无 command/url
        assert cfg.save_server('x', {'url': 'ftp://bad'}).get('error')
        assert cfg.save_server('x', {'command': 'c', 'tierOverrides': {'t': 'bogus'}}).get('error')
        assert cfg.save_server('', {'command': 'c'}).get('error')
        assert cfg.save_server('x', {'command': 'c', 'enabled': False}).get('ok')

    def test_activate_precheck_blocks_enable(self):
        cfg = _fresh_cfg()
        r = cfg.save_server('missing', {'command': 'no-such-cmd-xyz-123', 'enabled': True}, activate=True)
        assert r.get('error') and '未找到命令' in r['error'] and 'nodejs.org' in r['error']
        assert cfg.get_server('missing') is None                   # enabled 不落盘
        r2 = cfg.save_server('real', {'command': sys.executable, 'enabled': True}, activate=True)
        assert r2.get('ok')
        assert cfg.get_server('real')['enabled'] is True

    def test_set_tool_tier_and_delete(self):
        cfg = _fresh_cfg()
        cfg.save_server('s', {'command': 'c'})
        assert cfg.set_tool_tier('s', 'read_file', 'session').get('ok')
        assert cfg.get_server('s')['tierOverrides'] == {'read_file': 'session'}
        assert cfg.set_tool_tier('s', 't', 'bogus').get('error')
        assert cfg.set_tool_tier('nope', 't', 'off').get('error')
        assert cfg.delete_server('s').get('ok')
        assert cfg.delete_server('s').get('error')
        assert cfg.list_servers() == []

    def test_import_claude(self):
        cfg = _fresh_cfg()
        cfg.save_server('dup', {'command': 'c0'})
        payload = {'mcpServers': {
            'fs': {'command': 'npx', 'args': ['-y', 'server-filesystem', 'C:\\Work'], 'env': {'K': 'v'}},
            'remote': {'url': 'https://mcp.example.com/mcp', 'headers': {'Authorization': 'Bearer t'}},
            'legacy-sse': {'type': 'sse', 'url': 'https://old.example/sse'},
            'dup': {'command': 'npx', 'args': ['-y', 'other']},
        }}
        r = cfg.import_claude(json.dumps(payload))
        assert r.get('ok') and r['total'] == 4
        assert sorted(r['imported']) == ['fs', 'remote']
        reasons = {s['name']: s['reason'] for s in r['skipped']}
        assert 'SSE' in reasons['legacy-sse'] and '同名' in reasons['dup']
        names = [s['name'] for s in cfg.list_servers()]
        assert sorted(names) == ['dup', 'fs', 'remote']
        assert all(s['enabled'] is False for s in cfg.list_servers())
        assert cfg.import_claude('not json').get('error')
        assert cfg.import_claude('{"foo":1}').get('error')

    def test_precheck_command(self):
        assert McpConfigService.precheck_command(sys.executable) is None
        assert McpConfigService.precheck_command('no-such-cmd-xyz-999') is not None
        assert McpConfigService.precheck_command('') is not None
        # expandvars：%SYSTEMROOT%\System32\cmd.exe 应可解析
        expanded = os.path.expandvars(r'%SYSTEMROOT%\System32\cmd.exe')
        if os.path.isfile(expanded):
            assert McpConfigService.precheck_command(r'%SYSTEMROOT%\System32\cmd.exe') is None

    def test_config_json_untouched(self):
        """MCP 一切操作不写 config.json（契约红线）。"""
        cfg_path = paths.CONFIG_PATH
        before = open(cfg_path, 'rb').read() if os.path.exists(cfg_path) else None
        cfg = _fresh_cfg()
        cfg.save_server('s', {'command': sys.executable, 'env': {'K': 'v'}, 'enabled': True}, activate=True)
        cfg.set_tool_tier('s', 't', 'off')
        cfg.import_claude(json.dumps({'mcpServers': {'z': {'command': 'c'}}}))
        cfg.delete_server('z')
        after = open(cfg_path, 'rb').read() if os.path.exists(cfg_path) else None
        assert before == after

    def test_corrupt_file_falls_back(self):
        p = os.path.join(HOME, '.glm-chat', 'mcp_servers.json')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write('{broken json')
        cfg = McpConfigService(path=p)
        assert cfg.list_servers() == []
        assert cfg.save_server('s', {'command': 'c'}).get('ok')


# ---------------------------------------------------------------- T2 协议层
# stdio 桩脚本：sys.executable 拉起，按 mode 表现不同服务器行为；
# 收到的 method 追加写入 MCP_STUB_LOG（断言取消/ -32601 回复用）。
_STUB_SCRIPT = r'''
import json, os, sys, time

mode = sys.argv[1] if len(sys.argv) > 1 else 'ok'
LOG = os.environ.get('MCP_STUB_LOG')

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

req = recv()
if not req:
    sys.exit(0)
if req.get('method') != 'initialize':
    sys.exit(2)
if mode == 'oldver':
    send({'jsonrpc': '2.0', 'id': req['id'], 'result': {
        'protocolVersion': '2024-11-05', 'serverInfo': {'name': 'old', 'version': '1'},
        'supported': ['2024-11-05', '2025-03-26'], 'capabilities': {}}})
    sys.exit(0)
send({'jsonrpc': '2.0', 'id': req['id'], 'result': {
    'protocolVersion': '2025-06-18', 'serverInfo': {'name': 'stub-server', 'version': '0.1.0'},
    'instructions': 'stub instructions', 'capabilities': {'tools': {'listChanged': True}}}})
n = recv()
log('initialized')
if mode == 'sampling':
    send({'jsonrpc': '2.0', 'id': 9001, 'method': 'sampling/createMessage',
          'params': {'messages': []}})
    rep = recv()
    if rep and rep.get('error'):
        log('replied:' + str(rep['error'].get('code')))
    sys.exit(0)
if mode == 'crash':
    sys.exit(3)
while True:
    req = recv()
    if req is None:
        break
    mid = req.get('id')
    method = req.get('method')
    log(method or '?')
    if method == 'tools/list':
        cursor = (req.get('params') or {}).get('cursor')
        if mode == 'twopage' and not cursor:
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'tools': [{'name': 'tool_a', 'description': 'A',
                           'inputSchema': {'type': 'object', 'properties': {}},
                           'annotations': {'readOnlyHint': True}}],
                'nextCursor': 'p2'}})
        elif mode == 'twopage' and cursor == 'p2':
            send({'jsonrpc': '2.0', 'id': mid, 'result': {
                'tools': [{'name': 'tool_b', 'description': 'B',
                           'inputSchema': {'type': 'object', 'properties': {}},
                           'annotations': {'destructiveHint': True}}]}})
        else:
            send({'jsonrpc': '2.0', 'id': mid, 'result': {'tools': [
                {'name': 'echo', 'description': 'echo tool',
                 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}},
                                 'required': ['text']}}]}})
    elif method == 'tools/call':
        name = (req.get('params') or {}).get('name')
        if name not in ('echo', 'tool_a', 'tool_b'):
            send({'jsonrpc': '2.0', 'id': mid,
                  'error': {'code': -32602, 'message': 'Unknown tool: %s' % name}})
        elif mode == 'slowcall':
            time.sleep(30)
        elif mode == 'callerr':
            send({'jsonrpc': '2.0', 'id': mid,
                  'result': {'content': [{'type': 'text', 'text': 'boom'}], 'isError': True}})
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
def stub_script():
    fd, path = tempfile.mkstemp(suffix='.py', prefix='mcp_stub_')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(_STUB_SCRIPT)
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


def _stub_log():
    fd, path = tempfile.mkstemp(suffix='.log', prefix='mcp_stublog_')
    os.close(fd)
    return path


def _read_log(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return ''


def _spawn_stub(script, mode, env_extra=None):
    env = dict(os.environ)
    env['MCP_STUB_LOG'] = _stub_log()
    if env_extra:
        env.update(env_extra)
    t = StdioTransport()
    ok = t.start(sys.executable, [script, mode], {'MCP_STUB_LOG': env['MCP_STUB_LOG']})
    assert ok, '桩子进程拉起失败'
    return t, env['MCP_STUB_LOG']


class TestStdioProtocol:
    def test_handshake_and_call(self, stub_script):
        t, _ = _spawn_stub(stub_script, 'ok')
        try:
            c = McpClient(t)
            info = c.connect()
            assert info['protocol_version'] == MCP_PROTOCOL_VERSION
            assert info['server_info']['name'] == 'stub-server'
            assert info['instructions'] == 'stub instructions'
            tools = c.list_tools()
            assert [x['name'] for x in tools] == ['echo']
            r = c.call_tool('echo', {'text': 'hi'})
            assert r['content'][0]['text'] == 'echo:{"text": "hi"}'
            assert r['structuredContent'] == {'echo': {'text': 'hi'}}
            assert c.ping() == {}
        finally:
            c.close()

    def test_pagination(self, stub_script):
        t, _ = _spawn_stub(stub_script, 'twopage')
        try:
            c = McpClient(t)
            c.connect()
            tools = c.list_tools()
            assert [x['name'] for x in tools] == ['tool_a', 'tool_b']
        finally:
            c.close()

    def test_version_mismatch(self, stub_script):
        t, _ = _spawn_stub(stub_script, 'oldver')
        try:
            c = McpClient(t)
            with pytest.raises(McpVersionError) as ei:
                c.connect()
            assert ei.value.server_version == '2024-11-05'
            assert ei.value.supported == ['2024-11-05', '2025-03-26']
        finally:
            c.close()

    def test_server_initiated_sampling_rejected(self, stub_script):
        t, logp = _spawn_stub(stub_script, 'sampling')
        try:
            c = McpClient(t)
            c.connect()
            time.sleep(1.0)                      # 等桩脚本处理 -32601 回复并写日志
            assert 'replied:-32601' in _read_log(logp)
        finally:
            c.close()

    def test_call_timeout_sends_cancel(self, stub_script):
        t, logp = _spawn_stub(stub_script, 'slowcall')
        try:
            c = McpClient(t)
            c.connect()
            t0 = time.time()
            with pytest.raises(McpTimeoutError):
                c.call_tool('echo', {'text': 'x'}, timeout=1)
            assert time.time() - t0 < 5          # 1s 超时即返回，不等 30s
            assert 'tools/call' in _read_log(logp)   # 请求确已到达服务器
        finally:
            c.close()

    def test_server_crash_fails_pending(self, stub_script):
        t, _ = _spawn_stub(stub_script, 'crash')
        c = McpClient(t)
        c.connect()
        time.sleep(0.5)                          # 等桩进程退出（握手后 exit 3）
        with pytest.raises(McpProtocolError) as ei:
            c.list_tools()
        assert '断开' in str(ei.value) or '退出' in str(ei.value)
        c.close()

    def test_tool_error_and_notfound(self, stub_script):
        t, _ = _spawn_stub(stub_script, 'callerr')
        try:
            c = McpClient(t)
            c.connect()
            r = c.call_tool('echo', {})
            assert r['isError'] is True and r['content'][0]['text'] == 'boom'
        finally:
            c.close()
        t2, _ = _spawn_stub(stub_script, 'notool')
        try:
            c2 = McpClient(t2)
            c2.connect()
            with pytest.raises(McpProtocolError) as ei:
                c2.call_tool('missing', {})
            assert ei.value.code == -32602
        finally:
            c2.close()

    def test_transport_framing_and_close(self, stub_script):
        """传输层：换行帧 + 规范关闭序列（close 后进程必须退出）。"""
        t, _ = _spawn_stub(stub_script, 'ok')
        t.send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                'params': {'protocolVersion': MCP_PROTOCOL_VERSION,
                           'capabilities': {}, 'clientInfo': {'name': 't', 'version': '1'}}})
        r = t.recv(10)
        assert r['id'] == 1 and r['result']['protocolVersion'] == MCP_PROTOCOL_VERSION
        assert t.recv(0.3) is None                # 无多余帧
        assert t.is_alive()
        t.close()
        assert not t.is_alive()
        assert t.returncode is not None

    def test_transport_start_failure(self):
        t = StdioTransport()
        assert t.start('no-such-command-xyz-999', [], {}) is False
        assert t.is_alive() is False


class TestMemoryTransportProtocol:
    """内存双向桩：验证 dispatcher / -32601 / 通知，不依赖子进程。"""

    def _pair(self):
        import queue as _q
        to_server, to_client = _q.Queue(), _q.Queue()

        class _Mem:
            def send(self, obj):
                to_server.put(obj)

            def recv(self, timeout):
                try:
                    return to_client.get(timeout=timeout)
                except _q.Empty:
                    return None

            def is_alive(self):
                return True

            def close(self):
                to_client.put(None)

        return _Mem(), to_server, to_client

    def test_handshake_and_list_changed_flag(self):
        mem, to_server, to_client = self._pair()
        c = McpClient(mem)
        # 预置：initialize 响应 + initialized 后的 list_changed 通知
        to_client.put({'jsonrpc': '2.0', 'id': 1, 'result': {
            'protocolVersion': MCP_PROTOCOL_VERSION, 'serverInfo': {'name': 'mem'},
            'capabilities': {}}})
        info = c.connect()
        assert info['server_info']['name'] == 'mem'
        # 客户端先发 initialize 请求，再发 initialized 通知
        assert to_server.get(timeout=2)['method'] == 'initialize'
        n = to_server.get(timeout=2)
        assert n['method'] == 'notifications/initialized'
        # 服务器推 list_changed 通知
        to_client.put({'jsonrpc': '2.0', 'method': 'notifications/tools/list_changed'})
        time.sleep(0.4)
        assert c.tools_list_changed is True
        c.close()

    def test_unknown_method_rejected(self):
        mem, to_server, to_client = self._pair()
        c = McpClient(mem)
        to_client.put({'jsonrpc': '2.0', 'id': 1, 'result': {
            'protocolVersion': MCP_PROTOCOL_VERSION, 'serverInfo': {}, 'capabilities': {}}})
        c.connect()
        assert to_server.get(timeout=2)['method'] == 'initialize'
        to_server.get(timeout=2)                    # initialized 通知
        to_client.put({'jsonrpc': '2.0', 'id': 7, 'method': 'roots/list'})
        rep = to_server.get(timeout=2)
        assert rep['id'] == 7 and rep['error']['code'] == -32601
        c.close()

    def test_close_fails_pending(self):
        # 启动竞态加固：McpClient.__init__ 即起 dispatcher，首轮 recv 可能在
        # connect() 注册 pending 之前就消费掉预置响应 → initialize 等 30s 超时
        # （慢负载全套件下必现，单跑不现）。用「响应就绪闸门」消除：
        # dispatcher 首次 recv 前阻塞，直到主线程把响应 put 进队列。
        import queue as _q
        import threading as _th
        gate = _th.Event()
        to_server, to_client = _q.Queue(), _q.Queue()

        class _Mem:
            def send(self, obj):
                to_server.put(obj)

            def recv(self, timeout):
                gate.wait(timeout=timeout)   # 等主线程投递响应后再返回
                try:
                    return to_client.get(timeout=timeout)
                except _q.Empty:
                    return None

            def is_alive(self):
                return True

            def close(self):
                gate.set()

        c = McpClient(_Mem())
        to_client.put({'jsonrpc': '2.0', 'id': 1, 'result': {
            'protocolVersion': MCP_PROTOCOL_VERSION, 'serverInfo': {}, 'capabilities': {}}})
        gate.set()   # 放行 dispatcher（此时 connect 尚未调用，但 pending 会在
        # _request 内、send 之前注册；recv 返回时若 pending 未就绪会再等下一轮 0.5s）
        c.connect()
        to_server.get(timeout=2)
        # 时序加固（全量套件 128s 负载下，sleep-race 版会偶发把「pending 被 close 打断」
        # 误变成「initialize 超时」）：同步 close 后再发请求——close 已发生，
        # _request 对已关闭客户端立即抛 McpProtocolError，无任何时序窗口。
        c.close()
        with pytest.raises(McpProtocolError):
            c._request('tools/list', {}, timeout=2)

    def test_timeout_sends_cancelled_notification(self):
        """超时 → 发送 notifications/cancelled（requestId 关联）并抛 McpTimeoutError。"""
        mem, to_server, to_client = self._pair()
        c = McpClient(mem)
        to_client.put({'jsonrpc': '2.0', 'id': 1, 'result': {
            'protocolVersion': MCP_PROTOCOL_VERSION, 'serverInfo': {}, 'capabilities': {}}})
        c.connect()
        assert to_server.get(timeout=2)['method'] == 'initialize'
        to_server.get(timeout=2)                    # initialized 通知
        with pytest.raises(McpTimeoutError):
            c.call_tool('slow', {}, timeout=0.5)    # 不预置响应 → 超时
        req = to_server.get(timeout=2)
        assert req['method'] == 'tools/call' and req['id'] == 2
        cancel = to_server.get(timeout=2)
        assert cancel['method'] == 'notifications/cancelled'
        assert cancel['params']['requestId'] == 2
        c.close()


class _FakeHttpResponse:
    def __init__(self, body=b'{}', headers=None):
        self._body = body
        self.headers = headers or {}

    def read(self):
        return self._body

    def close(self):
        pass


class _ScriptedUrlopen:
    """按脚本顺序响应 urllib 请求（命中即消费）；记录 Request 供断言。"""

    def __init__(self, script):
        self.script = list(script)   # list of (predicate, response_or_exception)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        for i, (pred, resp) in enumerate(self.script):
            if pred(req):
                self.script.pop(i)
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError('未匹配的请求: %s %s' % (req.full_url, req.data))


def _is_method(m):
    def pred(req):
        try:
            body = json.loads(req.data.decode('utf-8'))
        except Exception:
            return False
        return body.get('method') == m
    return pred


class TestHttpProtocol:
    def test_headers_and_session_and_sse(self, monkeypatch):
        empty = _FakeHttpResponse(body=b'', headers={'Content-Type': 'application/json'})
        init_resp = _FakeHttpResponse(
            body=json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {
                'protocolVersion': MCP_PROTOCOL_VERSION,
                'serverInfo': {'name': 'http-srv'}, 'capabilities': {}}}).encode(),
            headers={'Mcp-Session-Id': 'sess-123', 'Content-Type': 'application/json'})
        list_resp = _FakeHttpResponse(
            body=b'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":'
                 b'[{"name":"t1","description":"d","inputSchema":{"type":"object"}}]}}\n\n',
            headers={'Content-Type': 'text/event-stream'})
        fake = _ScriptedUrlopen([(_is_method('initialize'), init_resp),
                                 (_is_method('notifications/initialized'), empty),
                                 (_is_method('tools/list'), list_resp)])
        monkeypatch.setattr(urllib.request, 'urlopen', fake)

        t = HttpTransport('https://mcp.example.com/mcp',
                          headers={'Authorization': 'Bearer tok'})
        c = McpClient(t)
        info = c.connect()
        assert info['server_info']['name'] == 'http-srv'
        assert t.session_id == 'sess-123'
        tools = c.list_tools()
        assert [x['name'] for x in tools] == ['t1']

        # 每个请求都带协议版本头 + 用户头 + 会话头
        for req in fake.requests:
            assert req.headers.get('Mcp-protocol-version') == MCP_PROTOCOL_VERSION \
                or req.headers.get('MCP-Protocol-Version') == MCP_PROTOCOL_VERSION
            assert req.headers.get('Authorization') == 'Bearer tok'
        assert fake.requests[1].headers.get('Mcp-session-id') == 'sess-123' \
            or fake.requests[1].headers.get('Mcp-Session-Id') == 'sess-123'
        c.close()

    def test_404_reconnects_once(self, monkeypatch):
        empty = _FakeHttpResponse(body=b'', headers={'Content-Type': 'application/json'})
        init_resp = _FakeHttpResponse(
            body=json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {
                'protocolVersion': MCP_PROTOCOL_VERSION, 'serverInfo': {}, 'capabilities': {}}}).encode(),
            headers={'Mcp-Session-Id': 'sess-1', 'Content-Type': 'application/json'})
        err404 = urllib.error.HTTPError('https://x/mcp', 404, 'Not Found', {}, io.BytesIO(b''))
        init2 = _FakeHttpResponse(
            body=json.dumps({'jsonrpc': '2.0', 'id': 3, 'result': {
                'protocolVersion': MCP_PROTOCOL_VERSION, 'serverInfo': {}, 'capabilities': {}}}).encode(),
            headers={'Mcp-Session-Id': 'sess-2', 'Content-Type': 'application/json'})
        list_resp = _FakeHttpResponse(
            body=json.dumps({'jsonrpc': '2.0', 'id': 2, 'result': {'tools': []}}).encode(),
            headers={'Content-Type': 'application/json'})
        fake = _ScriptedUrlopen([
            (_is_method('initialize'), init_resp),
            (_is_method('notifications/initialized'), empty),
            (_is_method('tools/list'), err404),
            (_is_method('initialize'), init2),          # 404 后重连握手
            (_is_method('notifications/initialized'), empty),
            (_is_method('tools/list'), list_resp),      # 重试成功
        ])
        monkeypatch.setattr(urllib.request, 'urlopen', fake)

        t = HttpTransport('https://mcp.example.com/mcp')
        c = McpClient(t)
        c.connect()
        tools = c.list_tools()                 # 404 → 重连 → 重试成功
        assert tools == []
        assert t.session_id == 'sess-2'
        methods = [json.loads(r.data.decode())['method'] for r in fake.requests]
        assert methods == ['initialize', 'notifications/initialized',
                           'tools/list', 'initialize', 'notifications/initialized', 'tools/list']
        c.close()

    def test_transport_error(self, monkeypatch):
        def _boom(req, timeout=None):
            raise urllib.error.URLError('refused')
        monkeypatch.setattr(urllib.request, 'urlopen', _boom)
        t = HttpTransport('https://mcp.example.com/mcp')
        with pytest.raises(HttpTransportError):
            t.post({'jsonrpc': '2.0', 'method': 'ping'}, 5)


# ---------------------------------------------------------------- T3 服务层与护栏
from backend.domains.integrations.mcp import mcp_service as mcp_service_mod
from backend.domains.security.guard_service import GuardService
from backend.domains.integrations.mcp.mcp_service import McpService
from backend.domains.workspace.toolcache_service import ToolcacheService


class _FakeClient:
    """协议层假客户端：注入 McpService._spawn_client 用。"""

    def __init__(self, tools=None, call_result=None, raise_exc=None, alive=True):
        self._tools = tools or []
        self._call_result = call_result if call_result is not None else {
            'content': [{'type': 'text', 'text': 'ok'}]}
        self._raise = raise_exc
        self.alive = alive
        self.server_info = {'name': 'fake-server', 'version': '1'}
        self.instructions = 'fake instructions'
        self.transport = None
        self.closed = False
        self.list_calls = 0

    def is_alive(self):
        return self.alive

    def list_tools(self):
        self.list_calls += 1
        return list(self._tools)

    def call_tool(self, name, arguments, timeout=None):
        if self._raise is not None:
            raise self._raise
        return self._call_result

    def close(self):
        self.closed = True

    def set_on_list_changed(self, cb):
        pass


def _mk_service(tmp_cfg_path=None):
    cfg = McpConfigService(path=tmp_cfg_path) if tmp_cfg_path else McpConfigService()
    guard = GuardService()
    return McpService(cfg, guard, ToolcacheService()), cfg, guard


def _audit_entries():
    p = os.path.join(paths.CONFIG_DIR, 'audit_log.jsonl')
    if not os.path.exists(p):
        return []
    with open(p, encoding='utf-8') as f:
        return [json.loads(ln) for ln in f.read().splitlines() if ln.strip()]


class TestTierAndNaming:
    def test_derive_tier(self):
        assert McpService.derive_tier({'destructiveHint': True}) == 'always'
        assert McpService.derive_tier({'destructiveHint': True, 'readOnlyHint': True}) == 'always'
        assert McpService.derive_tier({'readOnlyHint': True}) == 'session'
        assert McpService.derive_tier({'readOnlyHint': False}) == 'always'
        assert McpService.derive_tier({}) == 'always'
        assert McpService.derive_tier(None) == 'always'

    def test_function_name(self):
        assert McpService.function_name('srv', 'tool') == 'mcp__srv__tool'
        assert McpService.function_name('my srv!', 'a.b') == 'mcp__my_srv__a_b'
        assert McpService.function_name('', '') == 'mcp__server__tool'
        long_name = McpService.function_name('s' * 40, 't' * 40)
        assert len(long_name) == 64
        assert McpService._unique_name('mcp__a__b', {}) == 'mcp__a__b'
        used = {'mcp__a__b': 1}
        assert McpService._unique_name('mcp__a__b', used) == 'mcp__a__b_2'


class TestResolveTier:
    def test_priority(self):
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        # 工具未缓存 → 兜底 always/default
        assert svc.resolve_tier('s', 'x') == ('always', 'default')
        # 缓存无注解工具 → default
        entry = svc._ensure_entry('s')
        entry['tools'] = [{'name': 'plain'}]
        assert svc.resolve_tier('s', 'plain') == ('always', 'default')
        # 缓存只读注解 → annotation session
        entry['tools'].append({'name': 'ro', 'annotations': {'readOnlyHint': True}})
        assert svc.resolve_tier('s', 'ro') == ('session', 'annotation')
        # 注解 destructive → always
        entry['tools'].append({'name': 'bad', 'annotations': {'destructiveHint': True}})
        assert svc.resolve_tier('s', 'bad') == ('always', 'annotation')
        # 用户覆盖优先于一切
        cfg.set_tool_tier('s', 'ro', 'off')
        assert svc.resolve_tier('s', 'ro') == ('off', 'override')
        cfg.set_tool_tier('s', 'bad', 'session')
        assert svc.resolve_tier('s', 'bad') == ('session', 'override')
        svc.shutdown()


class TestEnforceMatrix:
    """§3.5 二次 enforce 矩阵全组合（防前端绕过）。"""

    def _setup(self, monkeypatch, tier_tools, fake):
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        for tool, ann in tier_tools:
            cfg.set_tool_tier('s', tool, ann) if ann in ('always', 'session', 'off') else None
        monkeypatch.setattr(McpService, '_spawn_client',
                            lambda self, name, c: (fake, None))
        return svc

    def test_matrix(self, monkeypatch):
        fake = _FakeClient(tools=[{'name': 't_off'}, {'name': 't_sess'},
                                  {'name': 't_always'}])
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        cfg.set_tool_tier('s', 't_off', 'off')
        cfg.set_tool_tier('s', 't_sess', 'session')
        cfg.set_tool_tier('s', 't_always', 'always')
        monkeypatch.setattr(McpService, '_spawn_client',
                            lambda self, name, c: (fake, None))
        # off：deny 拒绝；allow/missing 执行
        r = svc.call_tool('s', 't_off', {}, 'deny')
        assert r.get('skipped') and '用户拒绝' in r['info']
        assert svc.call_tool('s', 't_off', {}, 'allow').get('ok')
        assert svc.call_tool('s', 't_off', {}, '').get('ok')          # 缺失 → 执行（无需确认）
        # session/always：deny 拒绝；allow/session-trust 执行；缺失/未知 → 拒绝
        for tool in ('t_sess', 't_always'):
            assert svc.call_tool('s', tool, {}, 'deny').get('skipped')
            assert svc.call_tool('s', tool, {}, 'allow').get('ok')
            assert svc.call_tool('s', tool, {}, 'session-trust').get('ok')
            r = svc.call_tool('s', tool, {}, '')
            assert r.get('error') and '需要确认' in r['error']
            r2 = svc.call_tool('s', tool, {}, 'bogus')
            assert r2.get('error') and '需要确认' in r2['error']
        svc.shutdown()

    def test_check_actions(self):
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        cfg.set_tool_tier('s', 't_off', 'off')
        cfg.set_tool_tier('s', 't_sess', 'session')
        assert svc.check_tool('s', 't_off')['action'] == 'allow'
        assert svc.check_tool('s', 't_sess')['action'] == 'confirm'
        assert svc.check_tool('s', 'unknown')['action'] == 'confirm'   # 未缓存 → 保守
        cfg.save_server('off_srv', {'command': 'c'})                   # enabled=False
        r = svc.check_tool('off_srv', 't')
        assert r['action'] == 'block' and '未启用' in r['reason']
        r2 = svc.check_tool('nope', 't')
        assert r2['action'] == 'block' and '不存在' in r2['reason']
        # call_tool 对未启用/不存在同样拒绝
        assert svc.call_tool('off_srv', 't', {}, 'allow').get('error')
        assert svc.call_tool('nope', 't', {}, 'allow').get('error')
        svc.shutdown()


class TestAudit:
    def test_audit_fields_and_actions(self):
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        cfg.set_tool_tier('s', 'ro', 'session')
        svc.check_tool('s', 'ro', {'path': 'C:/x', 'name': 'secret'})
        svc.check_tool('nope', 't')
        entries = [e for e in _audit_entries() if e.get('op') == 'mcp_call']
        assert len(entries) >= 2
        last = entries[-1]
        assert last['action'] == 'block'
        chk = [e for e in entries if e['action'] == 'check'][-1]
        d = chk['detail']
        assert set(d.keys()) == {'server', 'tool', 'args', 'tier', 'tier_source'}
        assert d['server'] == 's' and d['tool'] == 'ro' and d['tier'] == 'session'
        assert 'C:/x' in d['args']
        for e in entries:                       # 禁用键不得出现
            for bad in ('path', 'name', 'head'):
                assert bad not in e['detail']
        svc.shutdown()

    def test_deny_audits_decision(self, monkeypatch):
        fake = _FakeClient()
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        monkeypatch.setattr(McpService, '_spawn_client',
                            lambda self, name, c: (fake, None))
        r = svc.call_tool('s', 't', {'a': 1}, 'deny')
        assert r.get('skipped')
        entries = [e for e in _audit_entries()
                   if e.get('op') == 'mcp_call' and e['action'] == 'decision']
        assert entries and entries[-1]['decision'] == 'deny'
        svc.shutdown()


class TestRenderResult:
    def test_text_structured_iserror_toolcache(self):
        svc, _, _ = _mk_service()
        # 纯文本
        r = svc._render_result({'content': [{'type': 'text', 'text': 'a'},
                                            {'type': 'text', 'text': 'b'}]})
        assert r == {'ok': True, 'output': 'a\nb'}
        # structuredContent 序列化（无文本内容时）
        r2 = svc._render_result({'content': [], 'structuredContent': {'k': [1, 2]}})
        assert '"k"' in r2['output'] and r2['ok']
        # isError → error
        r3 = svc._render_result({'content': [{'type': 'text', 'text': 'boom'}], 'isError': True})
        assert r3.get('error') == 'boom'
        # 超长 → 截断落盘 + read_more 提示
        big = 'x' * 25000
        r4 = svc._render_result({'content': [{'type': 'text', 'text': big}]})
        assert r4['ok'] and len(r4['output']) < 22000
        assert 'read_more' in r4['output']
        svc.shutdown()


class TestLifecycle:
    def test_crash_respawn_once(self, monkeypatch):
        good = _FakeClient(tools=[{'name': 't'}])
        bad = _FakeClient(alive=False)
        seq = [good, bad, bad]      # 第 2 次拉起仍“死”（is_alive False 但能连）

        def _spawn(self, name, cfg):
            return seq.pop(0), None

        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        monkeypatch.setattr(McpService, '_spawn_client', _spawn)
        r = svc.call_tool('s', 't', {}, 'allow')
        assert r.get('ok')                        # 首次拉起成功
        good.alive = False                        # 模拟进程崩溃
        r2 = svc.call_tool('s', 't', {}, 'allow')
        assert r2.get('ok')                       # 自动重拉一次成功
        seq[0].alive = False                      # 重拉后仍是死的
        r3 = svc.call_tool('s', 't', {}, 'allow')
        assert r3.get('ok')                       # 再次重拉
        # 让重拉失败（spawn 返回错误）
        monkeypatch.setattr(McpService, '_spawn_client',
                            lambda self, name, cfg: (None, '无法启动 MCP 服务器（命令：c）。'))
        entry = svc._ensure_entry('s')
        entry['client'].alive = False
        r4 = svc.call_tool('s', 't', {}, 'allow')
        assert r4.get('error') and '已自动重拉一次' in r4['error']
        svc.shutdown()

    def test_idle_recycle(self, monkeypatch):
        fake = _FakeClient()
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        monkeypatch.setattr(McpService, '_spawn_client',
                            lambda self, name, c: (fake, None))
        monkeypatch.setattr(mcp_service_mod, 'IDLE_TIMEOUT', 0.2)
        monkeypatch.setattr(mcp_service_mod, 'IDLE_SWEEP_INTERVAL', 0.1)
        assert svc.call_tool('s', 't', {}, 'allow').get('ok')
        assert not fake.closed
        # 轮询等待 reaper 回收（首次 sweep 有 ≤1s 启动窗口，不用固定 sleep 竞速）
        deadline = time.time() + 3
        while time.time() < deadline and not fake.closed:
            time.sleep(0.05)
        assert fake.closed
        svc.shutdown()

    def test_tool_schemas_filtering(self):
        svc, cfg, _ = _mk_service()
        # 无 enabled → []
        assert svc.tool_schemas() == []
        cfg.save_server('on', {'command': 'c', 'enabled': True})
        cfg.save_server('off', {'command': 'c'})
        e = svc._ensure_entry('on')
        e['status'] = 'ok'
        e['tools'] = [{'name': 'echo', 'description': 'd',
                       'inputSchema': {'type': 'object', 'properties': {}}},
                      {'name': 'echo', 'description': 'd2'}]   # 同名 → _2 去重
        schemas = svc.tool_schemas()
        assert [s['function']['name'] for s in schemas] == ['mcp__on__echo', 'mcp__on__echo_2']
        assert schemas[0]['function']['description'].startswith('[MCP·on] ')
        # error/stale 跳过
        e2 = svc._ensure_entry('off')
        e2['status'] = 'ok'
        e2['tools'] = [{'name': 'x'}]
        cfg.save_server('err', {'command': 'c', 'enabled': True})
        e3 = svc._ensure_entry('err')
        e3['status'] = 'error'
        e3['tools'] = [{'name': 'y'}]
        assert len(svc.tool_schemas()) == 2       # off（未启用）+ err（错误）均跳过
        svc.shutdown()

    def test_shutdown_and_forget(self):
        fake = _FakeClient()
        svc, cfg, _ = _mk_service()
        cfg.save_server('s', {'command': 'c', 'enabled': True})
        svc._ensure_entry('s')['client'] = fake
        r = svc.shutdown()
        assert r == {'ok': True, 'closed': 1} and fake.closed
        svc.forget('s')
        assert 's' not in svc._rt
        svc.shutdown()


# ---------------------------------------------------------------- T3/T4 Api 集成与契约
V13_METHODS = [
    'mcp_list_servers', 'mcp_save_server', 'mcp_delete_server', 'mcp_test_server',
    'mcp_get_server_detail', 'mcp_set_tool_tier', 'mcp_check_tool', 'mcp_call_tool',
    'mcp_import_claude', 'mcp_shutdown',
]


def _mk_api():
    api = NewApi()
    return api


class TestApiInfoHidesV13Methods:
    def test_hidden_but_callable(self):
        api = _mk_api()
        info = json.loads(api.get_api_info())
        for m in V13_METHODS:
            assert m not in info['methods'], '%s 应对 get_api_info 隐身' % m
            assert callable(getattr(api, m)), '%s 应可直接调用' % m
        api.mcp_shutdown()

    def test_get_api_info_matches_legacy(self):
        """get_api_info 输出与 legacy 逐字节一致（契约红线）。"""
        from conftest import legacy
        a = json.loads(legacy.Api().get_api_info())
        b = json.loads(_mk_api().get_api_info())
        assert a['methods'] == b['methods'] and a['version'] == b['version']

    def test_build_tools_default_path_unchanged(self):
        """无启用服务器：build_tools 默认路径与 include_mcp=False 逐字节一致。"""
        from backend import tools_schema
        api = _mk_api()
        default = api.build_tools('full')
        explicit_off = api.build_tools('full', include_mcp=False)
        legacy_direct = tools_schema.build('full', True)
        assert default == explicit_off == legacy_direct
        # 非 full 角色即使 include_mcp=True 也不注入
        assert api.build_tools('ro', include_mcp=True) == tools_schema.build('ro', True)
        assert api.build_tools('chat', include_mcp=True) == tools_schema.build('chat', True)
        api.mcp_shutdown()

    def test_config_json_not_polluted_by_api(self):
        cfg_path = paths.CONFIG_PATH
        before = open(cfg_path, 'rb').read() if os.path.exists(cfg_path) else None
        api = _mk_api()
        api.mcp_save_server('s', json.dumps({'command': sys.executable, 'enabled': True}))
        api.mcp_list_servers()
        api.mcp_check_tool('s', 't', '{}')
        api.mcp_call_tool('s', 't', '{}', 'deny')
        api.mcp_shutdown()
        after = open(cfg_path, 'rb').read() if os.path.exists(cfg_path) else None
        assert before == after


class TestApiMcpEndToEnd:
    """端到端：真实 stdio 桩子进程经 Api 门面全链路（保存→启用→列表→定档→调用→删除）。"""

    def test_full_flow(self, stub_script):
        api = _mk_api()
        try:
            # 启用（含预检测 + 测试连接）
            r = json.loads(api.mcp_save_server('stub', json.dumps({
                'command': sys.executable, 'args': [stub_script, 'ok'], 'enabled': True})))
            assert r.get('ok'), r
            assert [t['name'] for t in r['tools']] == ['echo']
            # 列表：状态 ok + 工具数 1
            lst = json.loads(api.mcp_list_servers())
            srv = lst['servers'][0]
            assert srv['name'] == 'stub' and srv['status'] == 'ok'
            assert srv['tool_count'] == 1 and srv['transport'] == 'stdio'
            # 详情：解密配置 + instructions + 工具档位
            det = json.loads(api.mcp_get_server_detail('stub'))
            assert det['ok'] and det['config']['command'] == sys.executable
            assert det['instructions'] == 'stub instructions'
            assert det['tools'][0]['tier'] == 'always'          # 无注解 → 保守
            # 定档：无注解 → confirm
            chk = json.loads(api.mcp_check_tool('stub', 'echo', '{"text":"hi"}'))
            assert chk['action'] == 'confirm' and chk['tier'] == 'always'
            # 默认 decision=deny → 拒绝（不执行，落审计 decision/deny）
            denied = json.loads(api.mcp_call_tool('stub', 'echo', '{"text":"hi"}'))
            assert denied.get('skipped') and '用户拒绝' in denied['info']
            # decision 缺失（''）+ always 档 → 后端 enforce 拒绝（防绕过）
            blocked = json.loads(api.mcp_call_tool('stub', 'echo', '{"text":"hi"}', ''))
            assert blocked.get('error') and '需要确认' in blocked['error']
            # decision=allow → 执行
            called = json.loads(api.mcp_call_tool('stub', 'echo', '{"text":"hi"}', 'allow'))
            assert called.get('ok') and 'echo:{"text": "hi"}' in called['output']
            # 档位覆盖 off → 直接放行（decision 缺失也执行）
            assert json.loads(api.mcp_set_tool_tier('stub', 'echo', 'off')).get('ok')
            chk2 = json.loads(api.mcp_check_tool('stub', 'echo', '{}'))
            assert chk2['action'] == 'allow' and chk2['tier_source'] == 'override'
            called2 = json.loads(api.mcp_call_tool('stub', 'echo', '{"text":"x"}', ''))
            assert called2.get('ok')
            # 审计流水
            audit = json.loads(api.get_audit_log(50, 0))
            ops = [e for e in audit['entries'] if e['op'] == 'mcp_call']
            actions = {e['action'] for e in ops}
            assert {'check', 'decision', 'block'} <= actions
            # build_tools 注入（full + include_mcp）
            tools = json.loads(api.build_tools('full', include_mcp=True))
            names = [t['function']['name'] for t in tools]
            assert 'mcp__stub__echo' in names
            # 关闭：运行中的 stdio 客户端被关停
            shut = json.loads(api.mcp_shutdown())
            assert shut.get('ok') and shut['closed'] >= 1
            # 删除 + 重复删除报错
            assert json.loads(api.mcp_delete_server('stub')).get('ok')
            assert json.loads(api.mcp_delete_server('stub')).get('error')
            # 删除后 build_tools 不再含该工具
            assert 'mcp__stub__echo' not in json.dumps(
                json.loads(api.build_tools('full', include_mcp=True)))
        finally:
            api.mcp_shutdown()

    def test_enable_failure_rolls_back(self, stub_script):
        api = _mk_api()
        try:
            # 命令不存在 → 预检测失败，enabled 不落盘
            r = json.loads(api.mcp_save_server('bad', json.dumps({
                'command': 'no-such-cmd-xyz-777', 'enabled': True})))
            assert r.get('error') and '未找到命令' in r['error']
            lst = json.loads(api.mcp_list_servers())
            assert lst['servers'] == []                    # 未落盘
            # 版本不匹配 → 测试连接失败，enabled 回弹
            r2 = json.loads(api.mcp_save_server('old', json.dumps({
                'command': sys.executable, 'args': [stub_script, 'oldver'], 'enabled': True})))
            assert r2.get('error') and '协议版本' in r2['error'] and '2024-11-05' in r2['error']
            lst2 = json.loads(api.mcp_list_servers())
            entry = [s for s in lst2['servers'] if s['name'] == 'old'][0]
            assert entry['enabled'] is False and entry['status'] == 'disabled'
            # 握手后崩溃 → 同样回弹
            r3 = json.loads(api.mcp_save_server('crash', json.dumps({
                'command': sys.executable, 'args': [stub_script, 'crash'], 'enabled': True})))
            assert r3.get('error')
            lst3 = json.loads(api.mcp_list_servers())
            entry3 = [s for s in lst3['servers'] if s['name'] == 'crash'][0]
            assert entry3['enabled'] is False
            # mcp_test_server 不存在 → error
            assert json.loads(api.mcp_test_server('nope')).get('error')
        finally:
            api.mcp_shutdown()

    def test_import_and_call_error_paths(self, stub_script):
        api = _mk_api()
        try:
            r = json.loads(api.mcp_import_claude(json.dumps({'mcpServers': {
                'remote': {'url': 'https://mcp.example.com/mcp', 'headers': {'A': 'B'}},
                'sse': {'type': 'sse', 'url': 'https://x/sse'}}})))
            assert r['imported'] == ['remote'] and r['skipped'][0]['name'] == 'sse'
            # HTTP 服务器启用：连不通 → 人话错误 + 回弹
            r2 = json.loads(api.mcp_save_server('remote', json.dumps({
                'url': 'https://mcp.example.com/mcp', 'headers': {'A': 'B'}, 'enabled': True})))
            assert r2.get('error')
            lst = json.loads(api.mcp_list_servers())
            e = [s for s in lst['servers'] if s['name'] == 'remote'][0]
            assert e['enabled'] is False and e['transport'] == 'http'
            # 未启用服务器调用 → 拒绝
            r3 = json.loads(api.mcp_call_tool('remote', 't', '{}', 'allow'))
            assert r3.get('error') and '未启用' in r3['error']
            # 工具不存在（-32602）人话映射
            api.mcp_save_server('stub', json.dumps({
                'command': sys.executable, 'args': [stub_script, 'ok'], 'enabled': True}))
            r4 = json.loads(api.mcp_call_tool('stub', 'missing_tool', '{}', 'allow'))
            assert r4.get('error') and '未提供该工具' in r4['error']
        finally:
            api.mcp_shutdown()

    def test_rpc_dispatch(self):
        """rpc 通用分发可调 MCP 方法（前端兜底路径）。"""
        api = _mk_api()
        try:
            out = json.loads(api.rpc('mcp_list_servers'))
            assert out.get('ok') and 'servers' in out
        finally:
            api.mcp_shutdown()
