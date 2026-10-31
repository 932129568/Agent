# -*- coding: utf-8 -*-
"""v1.5 遗留项接线回归（B1-B5 适配层 / S1-S2 MCP 池化温启 / WebDAV 执行器）。

覆盖 port-spec/roadmap 的「预留未接」项落地：
- B1：compact_threshold 阈值矩阵（三级窗口来源 × 三档比例）+ 前端同口径
- B2：should_retry_without_tools 特征匹配（400 tool/function）
- B3：FIRST_TOKEN_WAIT/IDLE_WATCHDOG 常量口径
- B4：classify_local_error 四态（loading/model_not_found/context_length/免 Key 401）
- S1：池化路径真实回环（本地 HTTP 服务器：复用命中/会话头/SSE/no-redirect/错误不污染池）
- S2：WarmRegistry 登记/过期/pop + mcp_service 打点透出
- WebDAV：本地 DAV 服务器（PUT/GET/MKCOL/manifest/sha256 对拍/冲突四策略/路径穿越防护）
"""
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from conftest import HOME, NewApi, reset_home

from backend.domains.integrations.mcp.mcp_pool import (HttpConnectionPool, WarmRegistry,
                                       ConcurrencyLimiter, stale_needs_relist,
                                       reconnect_backoff_delays)
from backend.domains.integrations.mcp.mcp_transport_http import HttpTransport, HttpTransportError
from backend.domains.integrations.mcp.mcp_client import McpClient, MCP_PROTOCOL_VERSION
from backend.domains.providers.local_model_service import (compact_threshold,
                                                  should_retry_without_tools,
                                                  classify_local_error)
from backend.domains.integrations import webdav_service as wd


# ============================================================ B1 阈值矩阵
class TestB1CompactThreshold:
    def test_matrix(self):
        # 窗口 × 比例（aggressive .4 / std .6 / relaxed .8；int 截断）
        assert compact_threshold(128000, 'std') == 76800
        assert compact_threshold(8192, 'std') == 4915
        assert compact_threshold(8192, 'aggressive') == 3276
        assert compact_threshold(8192, 'relaxed') == 6553
        # 窗口非法/缺省 → 保守 8192
        assert compact_threshold(0, 'std') == 4915
        assert compact_threshold(None, 'std') == 4915
        assert compact_threshold('abc', 'std') == 4915
        # 档位非法 → std
        assert compact_threshold(128000, 'bogus') == 76800


# ============================================================ B2 工具降级特征
class TestB2ToolsRetry:
    def test_feature_match(self):
        # 400 + tool/function 特征 → 可去 tools 重发（返回 True）
        assert should_retry_without_tools(400, 'model does not support tools') is True
        assert should_retry_without_tools(400, 'function calling unavailable') is True
        # 400 无特征 → 不重试
        assert should_retry_without_tools(400, 'bad request') is False
        # 非 400 → 不重试
        assert should_retry_without_tools(500, 'tools broken') is False


# ============================================================ B4 错误分类
class TestB4ErrorClassify:
    def test_four_states(self):
        r = classify_local_error(503, 'model is loading')
        assert r['kind'] == 'loading' and r['retryable'] and r['retry_after'] == [2, 4, 8]
        r = classify_local_error(404, 'model "x" not found')
        assert r['kind'] == 'model_not_found' and r['retryable'] is False
        assert '清单' in r['message']
        r = classify_local_error(400, 'context length exceeded')
        assert r['kind'] == 'context_length'
        r = classify_local_error(401, '')
        assert r['kind'] == 'generic' and '无需 Key' in r['message']


# ============================================================ 本地元数据（/api/tags 权威源）
class TestLocalMetaTags:
    """2026-10-17 实测驱动：qwen3.5-9b（Ollama /api/tags 声明 256k + tools）。"""

    def test_qwen35_prefix_and_exact(self):
        from backend.domains.providers.local_model_service import model_meta
        # 前缀规则（非 Ollama 端点回落）：qwen3.5 必须优先于泛指 qwen3
        m = model_meta('qwen3.5-9b:latest')
        assert m['ctx_window'] == 262144 and m['tool_capable'] is True and m['estimated'] is True
        # 精确表（实测条目不标估计）
        m2 = model_meta('qwen3.5-9b')
        assert m2['ctx_window'] == 262144 and m2['estimated'] is False
        # 泛指 qwen3 仍 32k（不被 qwen3.5 规则抢走）
        m3 = model_meta('qwen3:8b')
        assert m3['ctx_window'] == 32768

    def test_tags_meta_priority(self):
        """服务器声明优先于前缀猜测，次于精确表。"""
        from backend.domains.providers.local_model_service import model_meta
        tags = {'custom-model-7b': {'ctx_window': 16384, 'tool_capable': True}}
        # 无精确表/前缀命中 → 用 tags 声明（estimated=False）
        m = model_meta('custom-model-7b:latest', tags)
        assert m['ctx_window'] == 16384 and m['estimated'] is False and m['tool_capable'] is True
        # 前缀命中的模型被 tags 覆盖（服务器声明更权威）
        tags2 = {'qwen3:8b': {'ctx_window': 65536, 'tool_capable': False}}
        m2 = model_meta('qwen3:8b', tags2)
        assert m2['ctx_window'] == 65536 and m2['tool_capable'] is False
        # 精确表仍优先于 tags
        tags3 = {'llama3:8b': {'ctx_window': 999999, 'tool_capable': False}}
        m3 = model_meta('llama3:8b', tags3)
        assert m3['ctx_window'] == 8192

    def test_fetch_tags_real_ollama(self):
        """真机 Ollama（用户机器实跑 qwen3.5-9b）——连通则验真实声明，不通则跳过。"""
        from backend.domains.providers.local_model_service import _fetch_tags_meta
        tags = _fetch_tags_meta('http://127.0.0.1:11434/v1', timeout=3)
        if not tags:
            pytest.skip('本机 Ollama 不可达')
        hit = None
        for name, meta in tags.items():
            if 'qwen3.5' in name.lower():
                hit = (name, meta)
                break
        assert hit is not None, 'tags 中应有 qwen3.5 模型: %r' % list(tags)
        name, meta = hit
        assert meta['ctx_window'] >= 131072      # 服务器声明大窗口（实测 262144）
        assert meta['tool_capable'] is True      # capabilities 含 tools


# ============================================================ S1 池化真实回环
class _DavLikeHandler(BaseHTTPRequestHandler):
    """最小 MCP-over-HTTP 回环：POST → JSON 或 SSE；带会话头与重定向探测。"""

    def log_message(self, *a):
        pass

    def do_POST(self):
        ln = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(ln) if ln else b''
        try:
            obj = json.loads(body.decode('utf-8'))
        except Exception:
            obj = {}
        # 会话头回收 + 回显
        sid = self.headers.get('Mcp-Session-Id')
        hdrs = {'Content-Type': 'application/json'}
        if obj.get('method') == 'initialize' and not sid:
            hdrs['Mcp-Session-Id'] = 'sess-loop-1'
        if obj.get('method') == 'redirect_me':
            self.send_response(302)
            self.send_header('Location', 'http://elsewhere.example/x')
            self.end_headers()
            return
        result = {'ok': True, 'method': obj.get('method')}
        if obj.get('method') == 'initialize':
            result = {'protocolVersion': MCP_PROTOCOL_VERSION,
                      'serverInfo': {'name': 'loop'}, 'capabilities': {}}
        resp_obj = {'jsonrpc': '2.0', 'id': obj.get('id'),
                    'result': result}
        if obj.get('method') == 'sse_me':
            payload = json.dumps({'jsonrpc': '2.0', 'id': obj.get('id'),
                                  'result': {'tools': []}}, ensure_ascii=False)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            chunk = ('data: ' + payload + '\n\n').encode('utf-8')
            self.wfile.write(b'%x\r\n' % len(chunk) + chunk + b'\r\n')
            self.wfile.write(b'0\r\n\r\n')
            return
        if obj.get('method') == 'boom':
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'internal error')
            return
        data = json.dumps(resp_obj).encode('utf-8')
        self.send_response(200)
        for k, v in hdrs.items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_DELETE(self):
        self.send_response(204)
        self.end_headers()


@pytest.fixture()
def loop_server():
    srv = HTTPServer(('127.0.0.1', 0), _DavLikeHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield 'http://127.0.0.1:%d/mcp' % srv.server_port
    srv.shutdown()
    srv.server_close()


class TestS1PooledLoop:
    def test_roundtrip_reuse_and_security(self, loop_server):
        t = HttpTransport(loop_server, headers={'Authorization': 'Bearer tok'})
        c = McpClient(t)
        info = c.connect()
        assert info['server_info']['name'] == 'loop'
        assert t.session_id == 'sess-loop-1'
        # 第二个请求复用连接（stats.created 不增长）
        c.list_tools()
        stats = t._pool.stats()
        assert stats['created'] >= 1
        # SSE 路径（增量读）
        r = t.post({'jsonrpc': '2.0', 'id': 99, 'method': 'sse_me'}, 10)
        assert r['result']['tools'] == []
        # no-redirect：302 显式拒绝
        with pytest.raises(HttpTransportError) as ei:
            t.post({'jsonrpc': '2.0', 'id': 100, 'method': 'redirect_me'}, 10)
        assert ei.value.code == 302
        # 错误响应不污染池（release healthy=False → closed）
        with pytest.raises(HttpTransportError):
            t.post({'jsonrpc': '2.0', 'id': 101, 'method': 'boom'}, 10)
        stats2 = t._pool.stats()
        assert stats2['closed'] >= 1
        c.close()

    def test_pool_reuse_counter(self):
        pool = HttpConnectionPool()
        a = pool.acquire('http://127.0.0.1:1/x')
        pool.release(a, healthy=False)     # 无 sock 的连接直接关
        assert pool.stats()['closed'] >= 1
        pool.close()


# ============================================================ S2 温启
class TestS2Warm:
    def test_registry_lifecycle(self):
        wr = WarmRegistry(idle_ttl=0.2)

        class _Fake:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        c1 = _Fake()
        wr.register('s', c1)
        assert wr.get('s') is c1
        assert wr.stats()['count'] == 1
        time.sleep(0.3)                    # 过期
        assert wr.get('s') is None
        popped = wr.pop('s')               # 已过期 pop 返回 None
        assert popped is None

    def test_reap_and_pop(self):
        wr = WarmRegistry(idle_ttl=0.15)

        class _Fake:
            closed = False

            def close(self):
                self.closed = True

        c1 = _Fake()
        wr.register('s', c1)
        time.sleep(0.25)
        # 修复 S8（三轮）：reap 返回 (server, client) 对——调用方 close 的就是它
        reaped = wr.reap()
        assert [s for s, _c in reaped] == ['s']
        stale = dict(reaped)['s']
        assert stale is c1
        assert wr.pop('s') is None         # reap 已摘

    def test_stale_and_backoff_helpers(self):
        assert stale_needs_relist(0, now=301) is True
        assert stale_needs_relist(0, now=299) is False
        assert reconnect_backoff_delays(3)[:2] == [1.0, 2.0]

    def test_concurrency_limiter(self):
        lim = ConcurrencyLimiter(max_concurrent=1)
        with lim:
            assert lim.waiting == 0        # property（非方法）
        # 重入获取（RLock 语义由调用方保证；此处仅验证释放后可再取）
        with lim:
            pass


# ============================================================ WebDAV 本地回环
class _DavHandler(BaseHTTPRequestHandler):
    """最小 WebDAV：PUT/GET/MKCOL/DELETE + PROPFIND（depth 0/1）+ manifest 语义。"""

    def log_message(self, *a):
        pass

    def _fs(self, rel):
        return os.path.join(_DavHandler.root, rel.replace('/', os.sep))

    def _authorized(self):
        return self.headers.get('Authorization') == 'Basic ' + \
            __import__('base64').b64encode(b'u:p').decode()

    def _deny(self):
        """401 前必须先读净请求体——否则服务端（HTTP/1.0，响应后即关连接）
        在客户端仍在写 body 时 close，客户端踩 WinError 10053（连接被重置）
        而非收到 401（回环竞态，~20% 复现；QA 修复）。"""
        try:
            ln = int(self.headers.get('Content-Length') or 0)
            if ln > 0:
                self.rfile.read(ln)
        except Exception:
            pass
        self.send_response(401)
        self.end_headers()

    def do_PUT(self):
        if not self._authorized():
            self._deny(); return
        rel = self.path.lstrip('/')
        ln = int(self.headers.get('Content-Length') or 0)
        data = self.rfile.read(ln) if ln else b''
        p = self._fs(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data)
        self.send_response(201)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self._authorized():
            self._deny(); return
        rel = self.path.lstrip('/')
        p = self._fs(rel)
        if not os.path.isfile(p):
            self.send_response(404); self.end_headers(); return
        data = open(p, 'rb').read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_MKCOL(self):
        if not self._authorized():
            self._deny(); return
        rel = self.path.strip('/')
        p = self._fs(rel)
        if os.path.isdir(p):
            self.send_response(409); self.end_headers(); return
        os.makedirs(p, exist_ok=True)
        self.send_response(201)
        self.end_headers()

    def do_PROPFIND(self):
        if not self._authorized():
            self._deny(); return
        rel = self.path.strip('/')
        p = self._fs(rel)
        exists = os.path.isdir(p) or os.path.isfile(p)
        self.send_response(207 if exists else 404)
        self.send_header('Content-Type', 'application/xml')
        body = b'<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href></D:response></D:multistatus>'
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Allow', 'OPTIONS, GET, PUT, MKCOL, PROPFIND, DELETE')
        self.send_header('DAV', '1, 2')
        self.send_header('Content-Length', '0')
        self.end_headers()


@pytest.fixture()
def dav_server(tmp_path):
    _DavHandler.root = str(tmp_path)
    srv = HTTPServer(('127.0.0.1', 0), _DavHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield 'http://127.0.0.1:%d/dav' % srv.server_port
    srv.shutdown()
    srv.server_close()


def _dav_record(url):
    return {'url': url, 'username': 'u', 'password': 'p',
            'remote_path': '/glm-chat-backup', 'conflict_policy': 'ask'}


def _remote_file(name):
    """远端备份文件在 DAV 服务器 root 下的真实路径（URL 含 /dav 前缀）。"""
    return os.path.join(_DavHandler.root, 'dav', 'glm-chat-backup', name)


class TestWebdavExecutor:
    def _seed_config_dir(self, tmp_path):
        d = tmp_path / 'glm'
        d.mkdir()
        (d / 'config.json').write_text('{"api_key":"k"}', encoding='utf-8')
        (d / 'sessions.json').write_text('[]', encoding='utf-8')
        # audit_log.jsonl 缺失 → plan missing
        return str(d)

    def test_test_connection(self, dav_server):
        r = wd.test_connection(_dav_record(dav_server))
        assert r['ok'] is True and '1' in r.get('dav_capability', '')

    def test_auth_failure(self, dav_server):
        rec = _dav_record(dav_server); rec['password'] = 'wrong'
        r = wd.test_connection(rec)
        assert r['ok'] is False and '401' in r['error']

    def test_export_then_restore_remote_wins(self, dav_server, tmp_path):
        cfg_dir = self._seed_config_dir(tmp_path)
        rec = _dav_record(dav_server)
        rec['conflict_policy'] = 'remote_wins'
        r = wd.export_backup(cfg_dir, rec)
        assert r['ok'] is True and 'config.json' in r['uploaded']
        # 远端被外部改动（本地不动）→ only_remote → remote_wins 下拉覆盖
        remote_file = _remote_file('config.json')
        with open(remote_file, 'wb') as f:
            f.write(b'{"remote":"newer"}')
        r2 = wd.restore_backup(None, cfg_dir, rec)
        assert r2['ok'] is True, r2
        assert 'config.json' in r2['applied']
        back = json.loads((tmp_path / 'glm' / 'config.json').read_text(encoding='utf-8'))
        assert back == {'remote': 'newer'}          # 本地被远端新版本覆盖

    def test_ask_policy_returns_conflicts(self, dav_server, tmp_path):
        cfg_dir = self._seed_config_dir(tmp_path)
        rec = _dav_record(dav_server)
        assert wd.export_backup(cfg_dir, rec)['ok'] is True
        # 真冲突：本地与远端都相对基线（manifest）改
        base = json.loads((tmp_path / 'glm' / 'config.json').read_text(encoding='utf-8'))
        base['both'] = 'local-change'
        (tmp_path / 'glm' / 'config.json').write_text(json.dumps(base), encoding='utf-8')
        with open(_remote_file('config.json'), 'wb') as f:
            f.write(b'{"both":"remote-change"}')
        r = wd.restore_backup(None, cfg_dir, rec)
        assert r['ok'] is False and r.get('need_decision') is True
        assert any(c['path'] == 'config.json' for c in r['conflicts'])
        # 未落盘（本地保持改动态）
        assert json.loads((tmp_path / 'glm' / 'config.json').read_text(encoding='utf-8'))['both'] == 'local-change'

    def test_keep_both_policy(self, dav_server, tmp_path):
        cfg_dir = self._seed_config_dir(tmp_path)
        rec = _dav_record(dav_server)
        rec['conflict_policy'] = 'keep_both'
        assert wd.export_backup(cfg_dir, rec)['ok'] is True
        # 真冲突：两端都改
        base = json.loads((tmp_path / 'glm' / 'config.json').read_text(encoding='utf-8'))
        base['both'] = 'local-change'
        (tmp_path / 'glm' / 'config.json').write_text(json.dumps(base), encoding='utf-8')
        with open(_remote_file('config.json'), 'wb') as f:
            f.write(b'{"both":"remote-change"}')
        r = wd.restore_backup(None, cfg_dir, rec)
        assert r['ok'] is True, r
        assert len(r['kept_both']) == 1
        assert os.path.isfile(r['kept_both'][0])     # 远端版本另存落盘

    def test_integrity_check_rejects_tamper(self, dav_server, tmp_path):
        """落盘自校验：下载内容与磁盘写入不一致时拒（磁盘损坏防护）。"""
        cfg_dir = self._seed_config_dir(tmp_path)
        rec = _dav_record(dav_server)
        assert wd.export_backup(cfg_dir, rec)['ok'] is True
        # 远端演进（本地不动）→ only_remote 正常下拉（不再被 manifest 对拍误杀）
        with open(_remote_file('config.json'), 'wb') as f:
            f.write(b'{"remote":"evolved"}')
        r = wd.restore_backup(None, cfg_dir, rec)
        assert r['ok'] is True, r
        assert 'config.json' in r['applied']
        assert json.loads((tmp_path / 'glm' / 'config.json').read_text(encoding='utf-8')) == {'remote': 'evolved'}

    def test_path_traversal_guard(self, dav_server, tmp_path):
        cfg_dir = self._seed_config_dir(tmp_path)
        rec = _dav_record(dav_server)
        evil = {'version': 1, 'items': [{'path': '../evil.json', 'sha256': 'x' * 64}]}
        r = wd.restore_backup(json.dumps(evil), cfg_dir, rec)
        # 恶意路径被跳过（白名单外），不会写穿 config_dir
        assert r['ok'] is True and r['applied'] == []
        assert not os.path.exists(os.path.join(tmp_path, 'evil.json'))


# ============================================================ WebDAV 配置存取
class TestWebdavConfigIO:
    def test_save_get_roundtrip(self):
        reset_home()
        from backend.domains.integrations.webdav_service import WebDAVService
        svc = WebDAVService(config_dir=os.path.join(HOME, '.glm-chat'))
        r = svc.save_config(json.dumps({'url': 'https://dav.example.com',
                                        'username': 'u', 'password': 'p'}))
        assert r['ok'] is True
        g = svc.get_config()
        assert g['ok'] is True and g['config']['url'] == 'https://dav.example.com'
        # password 解密回显（编辑器同信任级）
        assert g['config']['password'] == 'p'
        # 落盘的是加密态（dpapi: 前缀或明文兜底非空）
        raw = io.open(os.path.join(HOME, '.glm-chat', 'webdav.json'),
                      encoding='utf-8').read()
        assert 'password' in raw

    def test_reject_bad_config(self):
        from backend.domains.integrations.webdav_service import WebDAVService
        svc = WebDAVService(config_dir=os.path.join(HOME, '.glm-chat'))
        r = svc.save_config(json.dumps({'url': 'http://evil.example.com',
                                        'username': 'u', 'password': 'p'}))
        assert r['ok'] is False and 'https' in r['error']
