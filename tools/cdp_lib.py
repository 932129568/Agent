# -*- coding: utf-8 -*-
"""CDP 最小桥（R26 CI 自包含）：为 tools/entry_sweep.py 提供 connect / ev。

历史版本由外部注入到 %TEMP% 或 tests/（不入库），干净 CI 环境里 import 会失败。
本文件复用仓库内 tools/perf_cdp.py 的纯标准库 loopback WebSocket 客户端，
零第三方依赖，接口与注入版一致：

    st = connect(9344, timeout=120)
    n = ev(st, 'document.querySelectorAll("button").length', wait=5)

约束（与 perf_cdp 同源）：只接受 127.0.0.1 / localhost 的 ws:// 端点，
不启动任何进程、不接受远端地址。连接失败抛 CdpError / OSError，调用方据此判定。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from perf_cdp import (  # noqa: E402
    CdpClient, CdpError, WebSocketConnection,
    discover_websocket_url, validate_endpoint,
)


class CdpSession:
    """持有 CDP WebSocket 连接，供 entry_sweep 全程复用。"""

    def __init__(self, port, timeout=120):
        self.port = int(port)
        self.timeout = float(timeout or 120)
        self.connection = None
        self.client = None

    def open(self):
        endpoint = 'http://127.0.0.1:%d/json/version' % self.port
        ws_url = discover_websocket_url(endpoint, timeout=min(self.timeout, 5.0))
        validate_endpoint(ws_url, websocket=True)
        self.connection = WebSocketConnection.connect(ws_url, self.timeout)
        self.client = CdpClient(self.connection)
        return self

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
        self.connection = None
        self.client = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def connect(port, timeout=120):
    """连接运行中的 Harbor CDP 端点。失败由调用方捕获（退出码 2）。"""
    return CdpSession(port, timeout).open()


def ev(session, expression, wait=5):
    """页面内求值并回传值（returnByValue）。wait 保留兼容签名，不额外 sleep。"""
    if session is None or session.client is None:
        raise CdpError('CDP session is not open')
    result = session.client.call('Runtime.evaluate', {
        'expression': expression,
        'returnByValue': True,
        'awaitPromise': True,
    })
    if not isinstance(result, dict):
        return None
    if result.get('exceptionDetails'):
        raise CdpError('Runtime.evaluate exception: %r' % result['exceptionDetails'])
    remote = result.get('result', {})
    return remote.get('value') if isinstance(remote, dict) else None
