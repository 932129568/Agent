# -*- coding: utf-8 -*-
"""本地 CORS 代理（修复 P0：Harbor 连不上不输出 CORS 头的本地模型服务器）。

背景（2026-10-20 用户实证）：Harbor 页面由 pywebview 以 ``file://`` 加载，前端对
本地模型端点的 fetch 是**浏览器直连**（45-request-debounce.js / 97-compact.js 的
``fetch(resolveApiEndpoint())``）。EdgeWebView（Chromium）对跨源 fetch 强制 CORS：
响应无 ``Access-Control-Allow-Origin`` 头即拒绝读取 → fetch reject「Failed to
fetch」。GLM/DeepSeek 能用只因返回 ``ACAO: *``；FreeToken Desktop（127.0.0.1:1919）、
裸 llama.cpp server、vLLM 默认配置等对任何 origin 都不输出 CORS 头——这是 v1.5
本地模型支持的通用洞（Ollama 之外全部连不上）。pywebview 侧无解：
edgechromium.py 硬编码 AdditionalBrowserArguments 覆盖环境变量，CreationProperties
在 Browser.__init__ 内已消费，patch 太晚。

方案：后端本地 CORS 代理——Harbor 完全掌控，一类问题全解：

- ``ThreadingHTTPServer`` 监听 **127.0.0.1:0（随机端口，避免冲突）**，daemon 线程；
- 前端 local 模式 fetch 改打代理基址（``http://127.0.0.1:<port>``），请求头
  ``X-Harbor-Target`` 携带真实本地 base_url（如 ``http://127.0.0.1:1919/v1``）；
- 代理用 urllib 转发（复用 urlopen_no_redirect 安全口径：禁自动重定向），响应
  **流式逐 chunk 回写**（8KB 读 8KB 写 + flush，SSE 实时性不破），并补齐 CORS
  头——``file://`` → 127.0.0.1 的跨源响应由代理补头后即可被 Chromium 读取；
- ``do_OPTIONS`` 预检直接 204 + CORS 头（含 X-Harbor-Target，否则浏览器自己
  就会拦掉实际请求的自定义头）。

安全硬约束：``X-Harbor-Target`` 的 host 必须是回环（localhost / 127.0.0.1 / ::1，
hostname 精确比较——``http://localhost.evil.com`` 之类子串绕过无效）且端口落在
已知本地模型端口集/用户配置端口，或云端白名单域名——否则 403。防代理被滥用为
开放中继（开放中继可让任意网页经本机打内网/外网或本机任意本地服务）。

契约红线：

- 零新依赖（纯 stdlib）；不碰 config.json；
- js_api 新方法 ``get_local_proxy`` 登记 ``backend.api._V12_EXTRA``，
  get_api_info 契约差分零漂移（与 sandbox_* / mcp_* 先例一致）；
- 进程级单例 ``get_proxy()``，``ensure_running()`` 幂等（Api 装配时启动）。
"""
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ...logging_setup import get_logger
from ..integrations.mcp.mcp_transport_http import urlopen_no_redirect   # 修复 S15 口径复用：禁自动重定向

# 前端请求头：携带真实本地 base_url（如 http://127.0.0.1:1919/v1）
TARGET_HEADER = 'X-Harbor-Target'
# 回环白名单（与 local_model_service._local_hostname 同口径；hostname 精确比较，
# 防 http://localhost.evil.com 之类绕过）
LOOPBACK_HOSTS = ('localhost', '127.0.0.1', '::1')
# 已知本地模型服务端口（Ollama 11434 / LM Studio 1234 / llama.cpp 8080 /
# vLLM 8000 / FreeToken Desktop 1919）——回环放行收敛到此集 + 用户配置端口：
# 全端口放行等于把本代理变成「本机任意服务开放中继」（任意网页经本机打
# Redis/MySQL/内网 Web 等未认证本地服务），收敛到模型端口集堵死该面
KNOWN_LOCAL_PORTS = frozenset({11434, 1234, 8000, 8080, 1919})
# 云端目标白名单（2026-10-21 P0 修复）：主流云端大模型 API 域名。前端 fetch
# 直连云端端点时会被 EdgeWebView 的系统代理栈拦截（用户机器挂 Clash/系统代理
# → Failed to fetch，而浏览器与后端直连均正常，两侧行为分裂且浏览器 fetch
# 无法禁代理）。解法国：云端请求也经本代理转发（后端 opener 已禁系统代理
# 直连，前端只 fetch 127.0.0.1 必然绕开任何系统代理），同时代理补 CORS
# 头让 4xx 真因不再被吞。
# 覆盖 GLM/DeepSeek/Moonshot/Qwen/GitHub Models/OpenAI/Anthropic；用户自定义
# 端点（provider base_url 配置）经 _dynamic_hosts 动态放行；确需其他的可设
# HARBOR_PROXY_ALLOW_HOSTS=host1,host2 追加。
CLOUD_HOSTS = ('open.bigmodel.cn', 'bigmodel.cn',
               'api.deepseek.com', 'api.moonshot.cn',
               'dashscope.aliyuncs.com', 'models.github.ai',
               'api.openai.com', 'api.anthropic.com')
_DYNAMIC_CACHE = {'ts': 0.0, 'hosts': (), 'ports': ()}
_DYNAMIC_TTL = 10.0     # config.json 动态白名单缓存秒数（改配置后 10s 内生效）


def _dynamic_hosts():
    """用户配置的端点 host（provider base_url / local_base_url）——用户自己
    配的端点即用户意图，动态放行。读 config.json（小文件，10s 缓存）。

    同一趟读取顺带收集「回环端点的端口」进 ``_DYNAMIC_CACHE['ports']``
    （经 ``_dynamic_ports`` 暴露）——用户自配的本地模型端口同样放行。
    """
    now = time.monotonic()
    if now - _DYNAMIC_CACHE['ts'] < _DYNAMIC_TTL:
        return _DYNAMIC_CACHE['hosts']
    hosts = set()
    ports = set()
    try:
        import json as _json
        from ... import paths as _paths
        cfg_path = os.path.join(_paths.CONFIG_DIR, 'config.json')
        if os.path.exists(cfg_path):
            with open(cfg_path, encoding='utf-8') as f:
                cfg = _json.load(f)
            for key in ('base_url', 'local_base_url'):
                u = urllib.parse.urlsplit(str(cfg.get(key) or '').strip())
                if u.hostname:
                    hosts.add(u.hostname.lower())
                    if u.hostname.lower() in LOOPBACK_HOSTS and u.port:
                        ports.add(int(u.port))
    except Exception:
        pass          # 读不到不阻塞（白名单静态部分仍生效）
    _DYNAMIC_CACHE['ts'] = now
    _DYNAMIC_CACHE['hosts'] = tuple(hosts)
    _DYNAMIC_CACHE['ports'] = tuple(ports)
    return _DYNAMIC_CACHE['hosts']


def _dynamic_ports():
    """用户配置的回环端口（base_url/local_base_url 落在回环 host 上的端口）。"""
    now = time.monotonic()
    if now - _DYNAMIC_CACHE['ts'] >= _DYNAMIC_TTL:
        _dynamic_hosts()          # 缓存过期：同一趟读取顺带刷新 ports
    return _DYNAMIC_CACHE.get('ports') or ()
CHUNK_SIZE = 8192             # 流式转发块大小（SSE 实时性：读一块写一块即 flush）
FORWARD_TIMEOUT = 300         # 单次 socket 超时（秒）——本地慢推理首 token 可能很久
MAX_BODY = 32 * 1024 * 1024   # 请求体上限（32MB；chat 请求体通常 <1MB，防恶意大包）


def _extra_cloud_hosts():
    """HARBOR_PROXY_ALLOW_HOSTS env 追加白名单（逗号分隔；逃生门）。"""
    raw = os.environ.get('HARBOR_PROXY_ALLOW_HOSTS', '')
    return tuple(h.strip().lower() for h in raw.split(',') if h.strip())


def _is_allowed_target(target):
    """X-Harbor-Target 目标是否放行：回环（本地模型，端口收敛）+ 云端白名单。

    hostname 精确比较（不用子串——防 http://localhost.evil.com /
    open.bigmodel.cn.evil.com 之类绕过）；scheme 仅 http/https；
    解析失败按拒绝处理（fail-closed）。

    回环侧收敛到「已知本地模型端口集 + 用户配置端口」：回环 ≠ 本地模型，
    全放行等于把代理开成本机任意服务的中继（任意网页可经本机探内网/
    打未认证本地服务）。
    """
    try:
        u = urllib.parse.urlsplit(str(target or '').strip())
        host = (u.hostname or '').lower()
        port = u.port
    except Exception:
        return False
    if u.scheme and u.scheme not in ('http', 'https'):
        return False
    if host in LOOPBACK_HOSTS:
        if port is None:
            return False       # 未显式给端口（80/443）不在模型端口集，拒
        return port in KNOWN_LOCAL_PORTS or port in _dynamic_ports()
    return host in CLOUD_HOSTS + _extra_cloud_hosts() + _dynamic_hosts()


def _target_url(target, path):
    """代理收到的 path 拼到目标 base_url 后 → 上游完整 URL。

    如 target='http://127.0.0.1:1919/v1'、path='/chat/completions'
    → 'http://127.0.0.1:1919/v1/chat/completions'。
    """
    base = str(target or '').strip().rstrip('/')
    p = str(path or '/')
    if not p.startswith('/'):
        p = '/' + p
    return base + p


def _read_chunk(source, size):
    """流式读一块：优先 read1（有数据即返回，不等填满——SSE 实时性关键），
    回落 read（某些响应对象无 read1）。"""
    read1 = getattr(source, 'read1', None)
    if read1 is not None:
        try:
            return read1(size)
        except Exception:
            return b''
    try:
        return source.read(size)
    except Exception:
        return b''


class _ProxyHandler(BaseHTTPRequestHandler):
    """代理请求处理器：OPTIONS 预检 + POST 转发（chat/completions）。

    所有响应（含框架 4xx/5xx）都经 send_response 覆写补 CORS 头——
    浏览器侧才拿得到代理/上游的错误详情（否则又是一次「Failed to fetch」）。
    """

    protocol_version = 'HTTP/1.1'   # keep-alive + 手工 chunked 帧（流式必需）
    server_version = 'HarborLocalCorsProxy/1.0'

    # ---------------- 框架覆写：全响应补 CORS ----------------
    def send_response(self, code, message=None):
        super().send_response(code, message)
        # X-Harbor-Target 必须进 ACAH：它是自定义头，预检不放行浏览器会拦实际请求
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',
                         'Content-Type, Authorization, ' + TARGET_HEADER)

    def log_message(self, fmt, *args):
        # 基类默认写 stderr；代理每请求两条日志太吵——降为 debug 级
        try:
            get_logger().debug('[local-proxy] ' + (fmt % args))
        except Exception:
            pass

    # ---------------- OPTIONS 预检 ----------------
    def do_OPTIONS(self):
        """CORS 预检：204 + CORS 头（send_response 覆写已补）。无体。"""
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ---------------- POST 转发 ----------------
    def do_POST(self):
        try:
            length = self._read_body_length()
            if length is None:
                return                      # 已按 400/413 应答且连接作废
            body = self.rfile.read(length) if length > 0 else b''
        except Exception:
            self.close_connection = True    # 连接已错位，避免 keep-alive 串请求
            return

        target = (self.headers.get(TARGET_HEADER) or '').strip()
        if not target:
            self._json(400, {'error': '缺少 %s 请求头（目标本地 base_url）' % TARGET_HEADER})
            return
        if not _is_allowed_target(target):
            # 安全硬约束：仅放行回环 + 云端白名单目标——防代理被滥用为开放中继
            self._json(403, {'error': '%s 必须是本机回环地址或白名单云端端点'
                                    % TARGET_HEADER})
            return

        url = _target_url(target, self.path)
        fwd = {}
        for h in ('Content-Type', 'Authorization', 'Accept'):
            v = self.headers.get(h)
            if v:
                fwd[h] = v
        # Accept-Encoding 不透传：避免上游压缩响应后流式转发复杂度（本地服务器极少压 SSE）
        req = urllib.request.Request(url, data=body, method='POST', headers=fwd)
        try:
            resp = urlopen_no_redirect(req, timeout=FORWARD_TIMEOUT)
        except urllib.error.HTTPError as e:
            # 上游 HTTP 错误（如 Ollama 503「model is loading」）：原状透传状态码
            # + 错误体——前端 45-request-debounce 的 503 指数退避依赖真实状态码
            try:
                err_body = e.read(MAX_BODY)
            except Exception:
                err_body = b''
            self._relay(e.code, e.headers, err_body)
            return
        except Exception as e:
            # 连接拒绝/超时等：502 + JSON 人话（经 CORS 头可达前端）
            self._json(502, {'error': '本地端点转发失败: %s' % e})
            return
        try:
            self._relay(resp.status, resp.headers, resp)
        finally:
            try:
                resp.close()
            except Exception:
                pass

    # ---------------- 内部工具 ----------------
    def _read_body_length(self):
        """解析 Content-Length（非法/超限 → 应答并返回 None 表示连接作废）。"""
        raw = self.headers.get('Content-Length')
        if raw is None or str(raw).strip() == '':
            return 0
        try:
            length = int(str(raw).strip())
        except (TypeError, ValueError):
            self._json(400, {'error': 'Content-Length 非法'})
            self.close_connection = True
            return None
        if length < 0 or length > MAX_BODY:
            self._json(413, {'error': '请求体过大（上限 %d 字节）' % MAX_BODY})
            self.close_connection = True
            return None
        return length

    def _json(self, status, obj):
        """JSON 应答（错误路径；带 CORS 头）。"""
        import json as _json
        data = _json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            self.close_connection = True

    def _relay(self, status, upstream_headers, body_source):
        """透传上游响应（状态码 / Content-Type / 体）并补 CORS 头。

        body_source 为 bytes（错误体，一次写完）或可读流对象（逐 chunk 转写）：
        - 上游有 Content-Length → 透传长度，按块转写；
        - 无 Content-Length（SSE 流式）→ 手工 chunked 帧（HTTP/1.1 keep-alive 保住，
          浏览器 fetch/EventSource 逐帧实时可达）。
        """
        ctype = ''
        clen = None
        try:
            ctype = upstream_headers.get('Content-Type') or ''
            raw_clen = upstream_headers.get('Content-Length')
            if raw_clen is not None:
                clen = int(str(raw_clen).strip())
        except Exception:
            ctype, clen = '', None

        self.send_response(status)
        if ctype:
            self.send_header('Content-Type', ctype)

        if isinstance(body_source, (bytes, bytearray)):
            data = bytes(body_source)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self._write(data)
            return

        if clen is not None:
            self.send_header('Content-Length', str(clen))
            self.end_headers()
            remaining = clen
            while remaining > 0:
                chunk = _read_chunk(body_source, min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                if not self._write(chunk):
                    break          # 客户端断开（用户点停止）：停止排空，
                    # 不再读上游——防连锁把上游/代理线程全挂住
                remaining -= len(chunk)
            return

        # 流式分支：手工 chunked 帧
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        while True:
            chunk = _read_chunk(body_source, CHUNK_SIZE)
            if not chunk:
                break
            if not self._write(b'%x\r\n' % len(chunk) + chunk + b'\r\n'):
                return              # 客户端断开：终止帧也不必写
        self._write(b'0\r\n\r\n')

    def _write(self, data):
        """写一块并立即 flush（SSE 实时性：块到即发，不等整体结束）。
        客户端中途断开（用户点停止）→ 静默标记连接作废，不刷栈。

        Returns:
            bool：False = 写入失败（客户端已断开，连接作废）——调用方
            （_relay 循环）据此中断排空，防连锁死等。
        """
        try:
            self.wfile.write(data)
            self.wfile.flush()
            return True
        except Exception:
            self.close_connection = True
            return False


class LocalCorsProxy:
    """本地 CORS 代理（进程级单例，经 ``get_proxy()`` 获取）。

    监听 127.0.0.1:0（随机端口）；daemon 线程 serve_forever；
    ``ensure_running()`` 幂等（已启动直接返回同端口）。
    """

    def __init__(self):
        self._log = get_logger()
        self._lock = threading.Lock()
        self._server = None
        self._thread = None

    def ensure_running(self):
        """确保代理在跑；返回监听端口（已启动则幂等返回同端口）。"""
        with self._lock:
            if self._server is not None:
                return self.port
            server = ThreadingHTTPServer(('127.0.0.1', 0), _ProxyHandler)
            server.daemon_threads = True
            thread = threading.Thread(target=server.serve_forever,
                                      name='harbor-local-cors-proxy', daemon=True)
            thread.start()
            self._server, self._thread = server, thread
            self._log.info('本地 CORS 代理已启动: %s', self.base_url)
            return self.port

    @property
    def port(self):
        """监听端口（未启动为 0）。"""
        return int(self._server.server_address[1]) if self._server is not None else 0

    @property
    def base_url(self):
        """代理基址（未启动为 ''）。"""
        return ('http://127.0.0.1:%d' % self.port) if self._server is not None else ''

    def info(self):
        """js_api 数据源：``{ok, port, base_url}``（未启动则先启动）。"""
        port = self.ensure_running()
        return {'ok': True, 'port': port, 'base_url': self.base_url}

    def shutdown(self):
        """关停代理（main.py atexit + 测试用）。幂等。"""
        with self._lock:
            server, self._server, self._thread = self._server, None, None
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass


# ---------------- 进程级单例 ----------------
_PROXY = None
_PROXY_LOCK = threading.Lock()


def get_proxy():
    """进程级单例（所有 Api 实例 / 测试共用同一个代理）。"""
    global _PROXY
    with _PROXY_LOCK:
        if _PROXY is None:
            _PROXY = LocalCorsProxy()
        return _PROXY


def shutdown_proxy():
    """关停单例代理（main.py atexit + 测试隔离用）。幂等。"""
    global _PROXY
    with _PROXY_LOCK:
        proxy, _PROXY = _PROXY, None
    if proxy is not None:
        proxy.shutdown()
