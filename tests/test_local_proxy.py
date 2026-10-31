# -*- coding: utf-8 -*-
"""v1.6 HF-P0 本地 CORS 代理回归（修复 P0：Harbor 连不上不输出 CORS 头的本地服务器）。

真机背景：Harbor 页面 file:// 加载，EdgeWebView 对跨源 fetch 强制 CORS——
FreeToken Desktop（127.0.0.1:1919）等不输出 CORS 头的本地服务器直连必被拒
（fetch reject「Failed to fetch」）。方案：后端 ThreadingHTTPServer 代理
（127.0.0.1:0 随机端口）补齐 CORS 头 + 流式透传 + 回环目标硬约束。
"""
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from backend import paths

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestLocalCorsProxyUnit:
    """代理单测：目标白名单校验（回环+云端）/URL 拼接/单例/幂等。"""

    def test_loopback_check(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        assert _is_allowed_target('http://127.0.0.1:1919/v1') is True
        assert _is_allowed_target('http://localhost:8080/v1') is True
        assert _is_allowed_target('http://[::1]:8080/v1') is True
        # 非回环一律拒（含子串绕过形态）
        assert _is_allowed_target('http://evil.com/v1') is False
        assert _is_allowed_target('http://localhost.evil.com/v1') is False
        assert _is_allowed_target('ftp://127.0.0.1/x') is False
        assert _is_allowed_target('') is False

    def test_target_url(self):
        from backend.domains.providers.local_proxy import _target_url
        assert _target_url('http://127.0.0.1:1919/v1', '/chat/completions') == \
            'http://127.0.0.1:1919/v1/chat/completions'
        assert _target_url('http://127.0.0.1:1919/v1/', 'chat/completions') == \
            'http://127.0.0.1:1919/v1/chat/completions'

    def test_singleton_idempotent(self):
        from backend.domains.providers import local_proxy as lp
        p1 = lp.get_proxy()
        p2 = lp.get_proxy()
        assert p1 is p2
        port1 = p1.ensure_running()
        port2 = p1.ensure_running()
        assert port1 == port2 and port1 > 0
        info = p1.info()
        assert info['ok'] and info['port'] == port1
        assert info['base_url'] == 'http://127.0.0.1:%d' % port1


class _Upstream(BaseHTTPRequestHandler):
    """回环假上游：记录请求；/sse 分 3 chunk 延迟吐（验流式）；/echo 回 body。"""

    def log_message(self, *a):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        if self.path.endswith('/sse'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            for part in (b'data: {"a":1}\n\n', b'data: {"b":2}\n\n', b'data: [DONE]\n\n'):
                self.wfile.write(b'%x\r\n' % len(part) + part + b'\r\n')
                self.wfile.flush()
                time.sleep(0.05)
            self.wfile.write(b'0\r\n\r\n')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestLocalCorsProxyE2E:
    """端到端：真起回环上游 + 真代理，过 HTTP 打全套。"""

    @property
    def _upstream(self):
        if not hasattr(self, '_up'):
            self._up = ThreadingHTTPServer(('127.0.0.1', 0), _Upstream)
            threading.Thread(target=self._up.serve_forever, daemon=True).start()
        return self._up

    def _allow_upstream_port(self, up_port):
        """回环端口收敛（2026-10-21 安全修复）后的 E2E 适配：测试上游的随机
        临时端口不在已知本地模型端口集——经「用户配置端口」通道放行（写
        local_base_url + 刷新动态缓存），验证中继/流式本体行为；端口收敛
        口径本身由 _is_allowed_target 单测（KNOWN_LOCAL_PORTS）覆盖。"""
        from backend.domains.providers import local_proxy as lp
        cfg_path = os.path.join(paths.CONFIG_DIR, 'config.json')
        os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
        with open(cfg_path, 'w', encoding='utf-8') as f:
            json.dump({'local_base_url': 'http://127.0.0.1:%d/v1' % up_port}, f)
        lp._DYNAMIC_CACHE['ts'] = 0.0

    @staticmethod
    def _post(url, body, headers=None, timeout=30):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST')
        req.add_header('Content-Type', 'application/json')
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()

    def test_post_relay_with_cors(self):
        from backend.domains.providers.local_proxy import get_proxy
        up_port = self._upstream.server_address[1]
        self._allow_upstream_port(up_port)
        proxy = get_proxy()
        proxy.ensure_running()
        st, hd, body = self._post(
            'http://127.0.0.1:%d/v1/chat/completions' % proxy.port,
            {'model': 'x', 'messages': []},
            headers={'X-Harbor-Target': 'http://127.0.0.1:%d/v1' % up_port})
        assert st == 200
        assert hd.get('Access-Control-Allow-Origin') == '*'
        assert 'X-Harbor-Target' in hd.get('Access-Control-Allow-Headers', '')
        assert json.loads(body)['model'] == 'x'

    def test_options_preflight(self):
        from backend.domains.providers.local_proxy import get_proxy
        proxy = get_proxy()
        proxy.ensure_running()
        req = urllib.request.Request('http://127.0.0.1:%d/v1/chat/completions' % proxy.port,
                                     method='OPTIONS')
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                st, hd = resp.status, dict(resp.headers)
        except urllib.error.HTTPError as e:
            st, hd = e.code, dict(e.headers or {})
        assert st == 204
        assert hd.get('Access-Control-Allow-Origin') == '*'

    def test_non_loopback_target_403(self):
        from backend.domains.providers.local_proxy import get_proxy
        proxy = get_proxy()
        proxy.ensure_running()
        req = urllib.request.Request('http://127.0.0.1:%d/v1/chat/completions' % proxy.port,
                                     data=b'{}', method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('X-Harbor-Target', 'http://evil.com/v1')
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                st = resp.status
        except urllib.error.HTTPError as e:
            st = e.code
        assert st == 403

    def test_missing_target_400(self):
        from backend.domains.providers.local_proxy import get_proxy
        proxy = get_proxy()
        proxy.ensure_running()
        req = urllib.request.Request('http://127.0.0.1:%d/v1/chat/completions' % proxy.port,
                                     data=b'{}', method='POST')
        req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                st = resp.status
        except urllib.error.HTTPError as e:
            st = e.code
        assert st == 400

    def test_stream_relay(self):
        """流式：上游分 3 chunk 延迟吐 → 客户端逐 chunk 实时收到（非整体完成后）。"""
        from backend.domains.providers.local_proxy import get_proxy
        up_port = self._upstream.server_address[1]
        self._allow_upstream_port(up_port)
        proxy = get_proxy()
        proxy.ensure_running()
        req = urllib.request.Request('http://127.0.0.1:%d/v1/sse' % proxy.port,
                                     data=b'{}', method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('X-Harbor-Target', 'http://127.0.0.1:%d/v1' % up_port)
        t0 = time.monotonic()
        first_at = None
        chunks = []
        with urllib.request.urlopen(req, timeout=30) as resp:
            assert resp.headers.get('Transfer-Encoding') == 'chunked'
            while True:
                line = resp.readline()
                if not line:
                    break
                if first_at is None:
                    first_at = time.monotonic() - t0
                chunks.append(line)
        total = time.monotonic() - t0
        assert b'data: {"a":1}' in b''.join(chunks)
        assert b'[DONE]' in b''.join(chunks)
        # 首 chunk 远早于整体结束（流式透传未缓冲成整体）
        assert first_at is not None and first_at < total / 2, \
            '首 chunk %.2fs vs 总 %.2fs——疑似整体缓冲' % (first_at or -1, total)


class TestGetLocalProxyApi:
    """js_api 侧：_V12_EXTRA 隐身 + get_api_info 输出含新方法。"""

    def test_in_v12_extra(self):
        from backend.api import _V12_EXTRA
        assert 'get_local_proxy' in _V12_EXTRA

    def test_api_info_stealth(self):
        """契约铁律：_V12_EXTRA 方法隐身——get_api_info 输出**不含**
        get_local_proxy（与 sandbox_*/mcp_* 同款，逐字节差分由契约测试锁定）。"""
        from backend.api import Api
        info = Api().get_api_info()
        assert 'get_local_proxy' not in info

    def test_api_method_callable(self):
        """方法真实可调（桥在，只是 get_api_info 不列它）。返回为序列化 JSON。"""
        from backend.api import Api
        r = Api().get_local_proxy()
        if isinstance(r, str):
            r = json.loads(r)
        assert r['ok'] is True and r['port'] > 0
        assert r['base_url'] == 'http://127.0.0.1:%d' % r['port']


class TestCloudWhitelist:
    """2026-10-21 P0：GLM 云端经代理转发（绕开 EdgeWebView 系统代理栈）。"""

    def test_glm_allowed(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        assert _is_allowed_target('https://open.bigmodel.cn/api/paas/v4') is True
        assert _is_allowed_target('https://bigmodel.cn/api/paas/v4') is True

    def test_loopback_still_allowed(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        assert _is_allowed_target('http://127.0.0.1:1919/v1') is True
        assert _is_allowed_target('http://localhost:11434/v1') is True

    def test_other_cloud_rejected(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        # deepseek 已入静态白名单（全云端策略 2026-10-21）；用未收录域验证拒绝
        assert _is_allowed_target('https://api.unknown-llm.com/v1') is False
        assert _is_allowed_target('https://evil.com/v1') is False

    def test_subdomain_spoof_rejected(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        assert _is_allowed_target('https://open.bigmodel.cn.evil.com/v1') is False
        assert _is_allowed_target('https://localhost.evil.com/v1') is False

    def test_env_escape_hatch(self, monkeypatch):
        monkeypatch.setenv('HARBOR_PROXY_ALLOW_HOSTS', 'api.deepseek.com, foo.bar')
        from backend.domains.providers.local_proxy import _is_allowed_target
        assert _is_allowed_target('https://api.deepseek.com/v1') is True
        assert _is_allowed_target('https://foo.bar/v1') is True
        assert _is_allowed_target('https://evil.com/v1') is False


class TestDynamicAndMoreCloud:
    """2026-10-21：动态白名单（用户配置端点）+ 更多云端域名。"""

    def test_more_cloud_hosts(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        for u in ('https://api.deepseek.com/v1', 'https://api.moonshot.cn/v1',
                  'https://dashscope.aliyuncs.com/compatible-mode/v1',
                  'https://models.github.ai/inference', 'https://api.openai.com/v1'):
            assert _is_allowed_target(u) is True, u

    def test_dynamic_hosts_from_config(self, monkeypatch, tmp_path):
        import json as _json
        import backend.domains.providers.local_proxy as lp
        from backend import paths
        cfg_path = os.path.join(paths.CONFIG_DIR, 'config.json')
        old = None
        if os.path.exists(cfg_path):
            old = open(cfg_path, encoding='utf-8').read()
        os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
        try:
            with open(cfg_path, 'w', encoding='utf-8') as f:
                _json.dump({'base_url': 'https://my-llm.example.com/v1'}, f)
            lp._DYNAMIC_CACHE['ts'] = 0.0
            assert lp._is_allowed_target('https://my-llm.example.com/v1') is True
            assert lp._is_allowed_target('https://evil.com/v1') is False
        finally:
            lp._DYNAMIC_CACHE['ts'] = 0.0
            if old is not None:
                with open(cfg_path, 'w', encoding='utf-8') as f:
                    f.write(old)


class TestDynamicAndMoreCloud:
    """2026-10-21：动态白名单（用户配置端点）+ 更多云端域名。"""

    def test_more_cloud_hosts(self):
        from backend.domains.providers.local_proxy import _is_allowed_target
        for u in ('https://api.deepseek.com/v1', 'https://api.moonshot.cn/v1',
                  'https://dashscope.aliyuncs.com/compatible-mode/v1',
                  'https://models.github.ai/inference', 'https://api.openai.com/v1'):
            assert _is_allowed_target(u) is True, u

    def test_dynamic_hosts_from_config(self, monkeypatch, tmp_path):
        import json as _json
        import backend.domains.providers.local_proxy as lp
        from backend import paths
        cfg_path = os.path.join(paths.CONFIG_DIR, 'config.json')
        old = None
        if os.path.exists(cfg_path):
            old = open(cfg_path, encoding='utf-8').read()
        os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
        try:
            with open(cfg_path, 'w', encoding='utf-8') as f:
                _json.dump({'base_url': 'https://my-llm.example.com/v1'}, f)
            lp._DYNAMIC_CACHE['ts'] = 0.0
            assert lp._is_allowed_target('https://my-llm.example.com/v1') is True
            assert lp._is_allowed_target('https://evil.com/v1') is False
        finally:
            lp._DYNAMIC_CACHE['ts'] = 0.0
            if old is not None:
                with open(cfg_path, 'w', encoding='utf-8') as f:
                    f.write(old)
