# -*- coding: utf-8 -*-
"""v1.5 预留接口单测：本地模型（连接层 A + 适配层 B）/ WebDAV（v1.6）/ MCP 性能挂载点（v1.5.1）。

覆盖（roadmap §3.4/§4.4/§5.4 的测试口径在预留层的对应子集）：
- 探测打桩（活/死/超时三态）、models 三形态解析、preset 表完整性；
- local 无 Key 测试连接（免 Key / loading 态 / 失败态）；
- ctx 阈值矩阵（5 窗口 × 3 档位）、错误分类（503/404/400 ctx/400 tools）；
- WebDAV 配置校验（https 强制/禁内嵌凭证/策略枚举）、三方冲突分类、manifest 校验；
- 连接池（复用命中/错误不污染/统计）、并发上限排队、stale 检测、退避序列；
- 契约：新 js_api 对 get_api_info 隐身、config.json 零污染。
"""
import http.server
import json
import os
import threading
import time

import pytest

from conftest import HOME, NewApi, reset_home

from backend.domains.providers import local_model_service as lms
from backend.domains.integrations.mcp import mcp_pool
from backend.domains.integrations import webdav_service as wds
from backend.api import _V12_EXTRA

V15_JS_API = ('local_probe', 'local_models', 'webdav_get_config', 'webdav_save_config',
              'webdav_test', 'webdav_export', 'webdav_restore')


# ================= 本地模型 · 纯函数 =================

class TestLocalPresets:
    def test_preset_table_integrity(self):
        """A1：六预设齐全、URL 格式合法、端口与 url 一致、key_required=False。

        实现 FreeToken preset（2026-10-20）：新增 freetoken（FreeToken Desktop，
        端口 1919）。注意其 base_url 用 127.0.0.1（FreeToken 代理按设置页绑定
        回环地址），与其余预设的 localhost 口径不同——故 URL 断言按回环口径
        放宽为「http://<回环host>:<port>/v1」双写法，其余校验不变。
        """
        assert set(lms.LOCAL_PRESETS) == {'ollama', 'lmstudio', 'vllm', 'llamacpp',
                                          'localai', 'freetoken'}
        for key, p in lms.LOCAL_PRESETS.items():
            assert p['base_url'].startswith(
                ('http://localhost:%d/v1' % p['port'],
                 'http://127.0.0.1:%d/v1' % p['port'])), key
            assert p['key_required'] is False, key
            assert p['note'], key
        assert lms.PROBE_PORTS == (11434, 1234, 8000, 8080, 1919)

    def test_list_presets_shape(self):
        lst = lms.list_presets()
        assert len(lst) == 6 and all('key' in p and 'base_url' in p for p in lst)


class TestModelMeta:
    @pytest.mark.parametrize('model,ctx,tool', [
        ('qwen2.5:7b', 32768, True),
        ('llama3.1:8b', 8192, True),
        ('llama3.1:70b', 131072, True),
        ('mistral:7b', 32768, True),
        ('deepseek-r1:7b', 65536, False),
        ('gemma2:9b', 8192, True),
    ])
    def test_exact_table(self, model, ctx, tool):
        m = lms.model_meta(model)
        assert m['ctx_window'] == ctx and m['tool_capable'] is tool
        assert m['estimated'] is False

    def test_prefix_heuristic_and_default(self):
        assert lms.model_meta('qwen3.8-27b:latest')['ctx_window'] == 32768
        assert lms.model_meta('some-unknown-7b')['ctx_window'] == 8192
        assert lms.model_meta('some-unknown-7b')['tool_capable'] is False
        assert lms.model_meta('some-unknown-7b')['estimated'] is True
        assert lms.model_meta('')['ctx_window'] == 8192


class TestCompactThreshold:
    @pytest.mark.parametrize('ctx,level,expected', [
        (131072, 'aggressive', 52428),
        (131072, 'std', 78643),
        (131072, 'relaxed', 104857),
        (32768, 'std', 19660),
        (8192, 'std', 4915),
        (4096, 'aggressive', 1638),
        (0, 'std', 4915),               # 非法窗口回落保守 8192
        (131072, 'bogus', 78643),       # 非法档位回落 std
    ])
    def test_threshold_matrix(self, ctx, level, expected):
        assert lms.compact_threshold(ctx, level) == expected

    def test_glm_continuity(self):
        """B1：GLM 128k × 0.6 ≈ 现标准档 90k 量级（roadmap 衔接要求）。"""
        t = lms.compact_threshold(131072, 'std')
        assert 70000 <= t <= 90000


class TestClassifyLocalError:
    @pytest.mark.parametrize('status,body,kind,retryable', [
        (503, 'model is loading', 'loading', True),
        (200, 'model is loading warmup', 'loading', True),
        (404, 'model not found', 'model_not_found', False),
        (404, '', 'model_not_found', False),
        (400, 'context length exceeded', 'context_length', False),
        (400, 'maximum context length is 8192', 'context_length', False),
        (400, 'tools not supported by this model', 'tools_unsupported', True),
        (400, 'function calling unsupported', 'tools_unsupported', True),
        (401, '', 'generic', False),
        (500, '', 'generic', False),
    ])
    def test_classification(self, status, body, kind, retryable):
        info = lms.classify_local_error(status, body)
        assert info['kind'] == kind and info['retryable'] is retryable
        if kind == 'loading':
            assert info['retry_after'] == [2, 4, 8]     # B4 退避序列

    def test_should_retry_without_tools_boundary(self):
        """B2 边界：仅 tools 特征 400 值得去 tools 重发；其他 400 不重试。"""
        assert lms.should_retry_without_tools(400, 'tools not supported') is True
        assert lms.should_retry_without_tools(400, 'context length exceeded') is False
        assert lms.should_retry_without_tools(400, 'bad request') is False

    def test_tools_disabled_for(self):
        assert lms.tools_disabled_for(False, 'auto', 'x') is False      # 非 local 不干预
        assert lms.tools_disabled_for(True, 'off', 'qwen2.5:7b') is True
        assert lms.tools_disabled_for(True, 'on', 'unknown') is False
        assert lms.tools_disabled_for(True, 'auto', 'unknown') is True  # 未知模型保守
        assert lms.tools_disabled_for(True, 'auto', 'qwen2.5:7b') is False

    def test_slow_reason_hint(self):
        assert lms.slow_reason_hint(3) == ''
        assert lms.slow_reason_hint(6) == '本地推理中（已等待 6s）'
        assert lms.LOCAL_DEFAULT_MAX_TOKENS == 4096


class TestValidateLocalPrefs:
    def test_valid(self):
        rec, err = lms.validate_local_prefs({
            'local_mode': True, 'local_base_url': 'http://localhost:11434/v1/',
            'local_model': ' qwen2.5:7b ', 'local_ctx_window': '32768',
            'local_tool_capable': 'auto'})
        assert err is None
        assert rec['local_base_url'] == 'http://localhost:11434/v1'   # 归一化去斜杠
        assert rec['local_model'] == 'qwen2.5:7b'
        assert rec['local_ctx_window'] == 32768

    def test_invalid(self):
        assert lms.validate_local_prefs({'local_base_url': 'ftp://x'})[1]
        assert lms.validate_local_prefs({'local_base_url': 'http://evil.com/v1'})[1]  # 非本地禁明文
        assert lms.validate_local_prefs({'local_ctx_window': 'abc'})[1]
        assert lms.validate_local_prefs({'local_ctx_window': '9999999'})[1]
        assert lms.validate_local_prefs({'local_tool_capable': 'maybe'})[1]
        assert lms.validate_local_prefs('nope')[1]

    def test_billing_label(self):
        assert lms.local_billing_label(True) == '本地 · 0 费用'
        assert lms.local_billing_label(False) is None


# ================= 本地模型 · IO（打桩） =================

class _FakeResp:
    def __init__(self, payload=None, exc=None):
        self._payload = payload
        self._exc = exc

    def __enter__(self):
        if self._exc:
            raise self._exc
        return self

    def __exit__(self, *a):
        return False

    def read(self, n=None):
        return json.dumps(self._payload).encode('utf-8')


def _stub_urlopen(monkeypatch, router):
    """router(port) -> _FakeResp；按请求端口分派（活/死/超时三态）。"""
    def fake(req, timeout=None):
        port = int(req.full_url.rsplit(':', 1)[1].split('/')[0])
        return router(port)
    monkeypatch.setattr(lms, 'urlopen_no_redirect', fake)


class TestProbeAndModels:
    def test_probe_three_states(self, monkeypatch):
        def router(port):
            if port == 11434:
                return _FakeResp({'data': [{'id': 'qwen2.5:7b'}, {'id': 'mistral:7b'}]})
            if port == 8000:
                return _FakeResp(exc=TimeoutError('timed out'))
            return _FakeResp(exc=ConnectionRefusedError('10061'))
        _stub_urlopen(monkeypatch, router)
        r = lms.probe()
        assert r['ok'] is True
        hit = [x for x in r['reachable'] if x['kind'] == 'ollama']
        assert len(hit) == 1
        assert hit[0]['models'] == ['qwen2.5:7b', 'mistral:7b']
        assert hit[0]['base_url'] == 'http://127.0.0.1:11434/v1'
        # 实现 FreeToken preset：4 → 5 端口，不可达 3 → 4
        assert len(r['unreachable']) == 4
        errs = {x['base_url']: x['error'] for x in r['unreachable']}
        assert '超时' in errs['http://127.0.0.1:8000/v1']
        assert '未监听' in errs['http://127.0.0.1:1234/v1']
        assert '未监听' in errs['http://127.0.0.1:1919/v1']

    def test_probe_wall_clock_parallel(self, monkeypatch):
        """A2：五端口并行——用时间跨度重叠证明并行（负载容忍，不押死墙钟）。
        串行下 5×0.3s 的总跨度 ≈1.5s；并行下 ≈0.3s。"""
        spans = []
        def router(port):
            t0 = time.monotonic()
            time.sleep(0.3)
            spans.append((t0, time.monotonic()))
            return _FakeResp(exc=ConnectionRefusedError('refused'))
        _stub_urlopen(monkeypatch, router)
        r = lms.probe()
        assert r['ok'] is True and len(spans) == 5
        overlap = max(s for _, s in spans) - min(t for t, _ in spans)
        assert overlap < 1.2, '并行探测退化为串行: 跨度 %.2fs' % overlap

    @pytest.mark.parametrize('payload,expected,expect_ok', [
        ({'data': [{'id': 'a'}, {'id': 'b'}]}, ['a', 'b'], True),   # OpenAI 形态
        ({'data': ['a', 'b']}, ['a', 'b'], True),                   # 字符串数组形态
        ({'models': [{'name': 'qwen2.5:7b'}]}, ['qwen2.5:7b'], True),  # Ollama 形态
        ({'garbage': 1}, [], False),                                # 未知形态 → 结构化错误
    ])
    def test_models_parse_shapes(self, monkeypatch, payload, expected, expect_ok):
        _stub_urlopen(monkeypatch, lambda port: _FakeResp(payload))
        r = lms.models('http://127.0.0.1:11434/v1')
        assert r['ok'] is expect_ok
        if expect_ok:
            assert [m['id'] for m in r['models']] == expected
            assert 'ctx_window' in r['models'][0]      # 元数据内嵌（前端下拉直接可用）
        else:
            assert 'error' in r

    def test_models_dead_endpoint(self, monkeypatch):
        _stub_urlopen(monkeypatch, lambda port: _FakeResp(exc=ConnectionRefusedError('x')))
        r = lms.models('http://127.0.0.1:59999/v1')
        assert r['ok'] is False and 'error' in r

    def test_models_missing_base(self):
        assert lms.models('')['ok'] is False

    def test_test_local_endpoint_loading_state(self, monkeypatch):
        """A5：503 loading 不判失败——返回 state=loading（冷启动 10-60s 可见）。"""
        class _HTTPErr(Exception):
            code = 503
        def fake(req, timeout=None):
            raise _HTTPErr()
        monkeypatch.setattr(lms, 'urlopen_no_redirect', fake)
        # HTTPError 走 urllib.error 分支：直接构造真 HTTPError 更真实
        import urllib.error
        def fake2(req, timeout=None):
            raise urllib.error.HTTPError('url', 503, 'loading', {}, None)
        monkeypatch.setattr(lms, 'urlopen_no_redirect', fake2)
        r = lms.test_local_endpoint('http://127.0.0.1:11434/v1', 'qwen2.5:7b')
        assert r['ok'] is True and r['state'] == 'loading'
        assert '加载' in r['message']

    def test_test_local_endpoint_ready(self, monkeypatch):
        _stub_urlopen(monkeypatch, lambda port: _FakeResp(
            {'choices': [{'message': {'content': 'pong'}}]}))
        r = lms.test_local_endpoint('http://127.0.0.1:11434/v1', 'qwen2.5:7b')
        assert r['ok'] is True and r['state'] == 'ready' and r['reply'] == 'pong'

    def test_test_local_endpoint_404_guidance(self, monkeypatch):
        import io
        import urllib.error

        def fake(req, timeout=None):
            raise urllib.error.HTTPError('url', 404, 'nf', {}, io.BytesIO(b'model not found'))
        monkeypatch.setattr(lms, 'urlopen_no_redirect', fake)
        r = lms.test_local_endpoint('http://127.0.0.1:11434/v1', 'nope')
        assert r['ok'] is False and '模型不存在' in r['error']


# ================= WebDAV 预留接口 =================

class TestWebdavConfig:
    def test_valid(self):
        rec, err = wds.validate_config({'url': 'https://dav.example.com/', 'username': 'u',
                                        'password': 'p', 'conflict_policy': 'keep_both'})
        assert err is None
        assert rec['url'] == 'https://dav.example.com'
        assert rec['remote_path'] == '/glm-chat-backup'      # 默认远端目录
        assert rec['auto_sync'] is False

    @pytest.mark.parametrize('cfg', [
        {'url': '', 'username': 'u', 'password': 'p'},                       # 缺地址
        {'url': 'dav.example.com', 'username': 'u', 'password': 'p'},        # 缺协议
        {'url': 'http://dav.example.com', 'username': 'u', 'password': 'p'}, # 明文禁
        {'url': 'https://u:p@dav.example.com', 'username': 'u', 'password': 'p'},  # 内嵌凭证禁
        {'url': 'https://dav.example.com', 'username': '', 'password': 'p'},
        {'url': 'https://dav.example.com', 'username': 'u', 'password': ''},
        {'url': 'https://dav.example.com', 'username': 'u', 'password': 'p',
         'conflict_policy': 'coin_flip'},
    ])
    def test_invalid(self, cfg):
        assert wds.validate_config(cfg)[1] is not None

    def test_localhost_http_exception(self):
        rec, err = wds.validate_config({'url': 'http://localhost:5005', 'username': 'u',
                                        'password': 'p'})
        assert err is None


class TestWebdavConflicts:
    def test_classify_four_categories(self):
        local = {'same': 'a', 'l_only': 'b1', 'r_only': 'c0', 'both': 'd1', 'l_new': 'e'}
        remote = {'same': 'a', 'l_only': 'b0', 'r_only': 'c1', 'both': 'd2'}
        baseline = {'same': 'a', 'l_only': 'b0', 'r_only': 'c0', 'both': 'd0'}
        out = wds.classify_conflicts(local, remote, baseline)
        assert out['unchanged'] == ['same']                 # 三方一致
        assert out['only_local'] == ['l_new', 'l_only']     # 本地变了云端未动 → 安全上行
        assert out['only_remote'] == ['r_only']             # 云端变了本地未动 → 安全下行
        assert [c['path'] for c in out['conflicts']] == ['both']
        c = out['conflicts'][0]
        assert c['local_sha'] == 'd1' and c['remote_sha'] == 'd2' and c['baseline_sha'] == 'd0'

    def test_classify_deletion_semantics(self):
        """远端删除（本地=基线、远端缺失）→ only_remote（下行即删）。"""
        out = wds.classify_conflicts({'f': 'a'}, {}, {'f': 'a'})
        assert out['only_remote'] == ['f'] and out['only_local'] == []

    @pytest.mark.parametrize('policy,action', [
        ('local_wins', 'upload'), ('remote_wins', 'download'),
        ('keep_both', 'keep_both'), ('ask', 'ask')])
    def test_resolve_conflict(self, policy, action):
        r = wds.resolve_conflict(policy, {'path': 'x'})
        assert r['action'] == action

    def test_export_plan_and_reserved(self):
        r = wds.export_backup(HOME)
        assert r['reserved'] is True
        assert {i['path'] for i in r['plan']} == set(wds.BACKUP_SCOPE)
        assert r['manifest']['version'] == wds.BACKUP_MANIFEST_VERSION

    def test_restore_manifest_validation(self):
        bad = wds.restore_backup('not-json', HOME)
        assert bad['ok'] is False and 'manifest' in bad['error']
        bad2 = wds.restore_backup('{"items": [{"path": "x"}]}', HOME)
        assert bad2['ok'] is False
        # v1.6 执行器已落地：合法 manifest + 未配置 → 校验通过的结构化应答
        # （不再有 reserved 标记；配置后走真实下载链路）
        ok = wds.restore_backup(json.dumps(
            {'version': 1, 'items': [{'path': 'config.json', 'sha256': 'a' * 64}]}), HOME)
        assert ok['ok'] is False and '未配置' in ok['error']


# ================= MCP 性能挂载点（v1.5.1） =================

class TestPoolConfig:
    def test_defaults(self):
        merged = mcp_pool.effective_pool_config(None)
        assert merged == {'keep_alive': True, 'max_concurrency': 4, 'warm_on_enable': True}

    @pytest.mark.parametrize('cfg,expected', [
        ({'keep_alive': False}, {'keep_alive': False}),
        ({'max_concurrency': '8'}, {'max_concurrency': 8}),
        ({'warm_on_enable': True}, {'warm_on_enable': True}),
        ({'max_concurrency': 0}, None),
        ({'max_concurrency': 9}, None),
        ({'max_concurrency': 'x'}, None),
    ])
    def test_parse(self, cfg, expected):
        rec, err = mcp_pool.parse_pool_config(cfg)
        if expected is None:
            assert err is not None
        else:
            assert err is None and rec == expected

    def test_effective_merge(self):
        merged = mcp_pool.effective_pool_config({'max_concurrency': 2})
        assert merged['max_concurrency'] == 2 and merged['keep_alive'] is True


class TestConcurrencyLimiter:
    def test_queue_not_reject(self):
        """S5：超限排队而非拒绝；等待数可观测。"""
        lim = mcp_pool.ConcurrencyLimiter(2)
        with lim:
            assert lim.waiting == 0
            results = []

            def worker():
                with lim:
                    results.append(1)
                    time.sleep(0.3)          # 持锁 300ms，排队窗口可观测
            ts = [threading.Thread(target=worker) for _ in range(4)]
            for t in ts:
                t.start()
            # 轮询等待排队出现（负载容忍：线程调度延迟不误判）
            deadline = time.time() + 2
            while lim.waiting < 1 and time.time() < deadline:
                time.sleep(0.02)
            assert lim.waiting >= 1          # 有线程在排队（未被拒绝）
            for t in ts:
                t.join(timeout=5)
            assert len(results) == 4         # 全部最终通过（排队执行）


class TestStaleAndBackoff:
    def test_stale_detection(self):
        now = time.time()
        assert mcp_pool.stale_needs_relist(None) is True               # 从未列出
        assert mcp_pool.stale_needs_relist(now - 299) is False
        assert mcp_pool.stale_needs_relist(now - 301) is True
        assert mcp_pool.stale_needs_relist(now - 10, ttl=5) is True

    def test_backoff_sequence(self):
        assert mcp_pool.reconnect_backoff_delays() == [1.0, 2.0, 4.0]
        assert mcp_pool.reconnect_backoff_delays(n=2) == [1.0, 2.0]


class _FakeConn:
    """鸭子类型连接：sock/close/host/port（池单测用）。"""

    def __init__(self, alive=True):
        self.sock = object() if alive else None
        self.host, self.port = '127.0.0.1', 1234
        self.closed = False

    def close(self):
        self.closed = True


class TestHttpConnectionPool:
    def test_reuse_and_stats(self):
        """入池（活连接）→ 再次 acquire 复用命中。"""
        pool = mcp_pool.HttpConnectionPool()
        fake = _FakeConn()
        pool.release(fake)
        got = pool.acquire('http://127.0.0.1:1234/x')
        assert got is fake                                    # 同 host:port 复用
        s = pool.stats()
        assert s['reused'] == 1 and s['created'] == 0 and s['idle'] == 0
        pool.close()

    def test_acquire_creates_real_conn(self):
        """空池 acquire 新建真实 http.client 连接（http/https 分流）。"""
        pool = mcp_pool.HttpConnectionPool()
        c1 = pool.acquire('http://127.0.0.1:1234/x')
        assert isinstance(c1, http.client.HTTPConnection)
        c2 = pool.acquire('https://example.com/mcp')
        assert isinstance(c2, http.client.HTTPSConnection)
        s = pool.stats()
        assert s['created'] == 2
        pool.close()

    def test_unused_conn_discarded(self):
        """从未使用（sock=None）的连接不入池——保守丢弃，不返回可疑连接。"""
        pool = mcp_pool.HttpConnectionPool()
        c = pool.acquire('http://127.0.0.1:1234/x')           # 新建但未请求
        pool.release(c)                                        # sock=None → 关闭
        assert pool.stats()['idle'] == 0 and pool.stats()['closed'] == 1

    def test_dead_conn_not_reused(self):
        """半死连接（sock=None）以 healthy 归还也直接关闭，不污染池。"""
        pool = mcp_pool.HttpConnectionPool()
        pool.release(_FakeConn(alive=False), healthy=True)
        s = pool.stats()
        assert s['idle'] == 0 and s['closed'] == 1

    def test_unhealthy_not_pooled(self):
        pool = mcp_pool.HttpConnectionPool()
        c = _FakeConn()
        pool.release(c, healthy=False)
        assert c.closed is True and pool.stats()['idle'] == 0

    def test_per_host_cap(self):
        pool = mcp_pool.HttpConnectionPool(max_per_host=2)
        conns = [_FakeConn() for _ in range(3)]
        for c in conns:
            pool.release(c)
        assert pool.stats()['idle'] == 2
        assert conns[2].closed is True

    def test_idle_reap(self):
        pool = mcp_pool.HttpConnectionPool(idle_ttl=0.05)
        c = _FakeConn()
        pool.release(c)
        assert pool.stats()['idle'] == 1
        time.sleep(0.1)
        pool.acquire('http://127.0.0.1:1234/z')                # 触发回收
        assert pool.stats()['closed'] >= 1 and c.closed is True
        pool.close()

    def test_keep_alive_off(self):
        pool = mcp_pool.HttpConnectionPool(keep_alive=False)
        c = _FakeConn()
        pool.release(c)
        assert c.closed is True and pool.stats()['idle'] == 0

    def test_real_localhost_roundtrip(self):
        """真实 127.0.0.1 http.server（HTTP/1.1 keep-alive）：acquire→请求→release→复用。"""
        class _H(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'                      # keep-alive：连接可复用

            def do_GET(self):
                body = b'pool-ok'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        # Threading：多连接并发不互卡（单连接复用语义由池本身保证）
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _H)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            url = 'http://127.0.0.1:%d/mcp' % srv.server_address[1]
            pool = mcp_pool.HttpConnectionPool()
            c1 = pool.acquire(url)
            c1.request('GET', '/mcp')
            r1 = c1.getresponse()
            assert r1.status == 200 and r1.read() == b'pool-ok'
            pool.release(c1)
            c2 = pool.acquire(url)
            assert c2 is c1                                    # 真实连接复用命中
            c2.request('GET', '/mcp')
            assert c2.getresponse().read() == b'pool-ok'
            pool.release(c2)
            s = pool.stats()
            assert s['reused'] == 1 and s['created'] == 1
            pool.close()
        finally:
            srv.shutdown()
            srv.server_close()


class TestWarmRegistry:
    def test_register_get_reap(self):
        reg = mcp_pool.WarmRegistry(idle_ttl=0.05)
        reg.register('s1', object())
        assert reg.get('s1') is not None
        time.sleep(0.1)
        assert reg.get('s1') is None                       # 空闲过期自动回收
        assert reg.reap() == []
        c2 = object()
        reg.register('s2', c2)
        time.sleep(0.1)
        # 修复 S8（三轮）：reap 返回 (server, client) 对——调用方拿到的 client 才是要
        # close 的对象（原返回 server 名，调用方再 pop 恒 None，close 永不执行）
        reaped = reg.reap()
        assert [s for s, _c in reaped] == ['s2']
        assert dict(reaped)['s2'] is c2
        assert reg.stats() == {'warm': [], 'count': 0}


# ================= js_api 契约与 config 零污染 =================

class TestJsApiContract:
    def test_extra_registration(self):
        for m in V15_JS_API:
            assert m in _V12_EXTRA, m

    def test_get_api_info_excludes_new(self):
        reset_home()
        api = NewApi()
        info = json.loads(api.get_api_info())
        assert not set(V15_JS_API) & set(info['methods'])

    def test_api_surface_callable(self):
        reset_home()
        api = NewApi()
        assert json.loads(api.local_probe())['ok'] is True
        assert json.loads(api.local_models(''))['ok'] is False
        # v1.6 执行器已落地：未配置 WebDAV 时导出返回计划预览（ok False + plan），
        # 不再有 reserved 标记（配置后 export 走真实 MKCOL/PUT 链路）
        r = json.loads(api.webdav_export())
        assert r['ok'] is False and isinstance(r.get('plan'), list)

    def test_config_json_untouched(self):
        """local_*/webdav 预留调用不写 config.json（运行期合法、测试期不触发）。"""
        reset_home()
        api = NewApi()
        before = open(os.path.join(HOME, '.glm-chat', 'config.json'), 'rb').read() \
            if os.path.exists(os.path.join(HOME, '.glm-chat', 'config.json')) else None
        api.local_probe()
        api.webdav_save_config('{"url": "https://dav.example.com", "username": "u", "password": "p"}')
        api.webdav_export()
        after = open(os.path.join(HOME, '.glm-chat', 'config.json'), 'rb').read() \
            if os.path.exists(os.path.join(HOME, '.glm-chat', 'config.json')) else None
        assert before == after
