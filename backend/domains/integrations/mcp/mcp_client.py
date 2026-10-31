# -*- coding: utf-8 -*-
"""MCP 协议客户端（v1.3 R1）：手写最小客户端，钉死协议版本 2025-06-18。

覆盖（PRD R1）：
- initialize / notifications/initialized 握手；版本协商只认 2025-06-18（不符抛 McpVersionError）。
- tools/list 游标分页（nextCursor 聚合）；tools/call；ping；notifications/cancelled 取消。
- 服务器发起的 sampling/elicitation/roots → 回复 -32601（v1.3 不支持，功能降级不崩溃）。
- notifications/tools/list_changed → 标记失效 + 回调（service 层后台刷新）。
- 全请求超时；HTTP 404 会话过期 → 清 session 重新握手一次（规范 lifecycle）。

可测性：构造参数注入 transport——协议单测传内存双向桩；HTTP 传 HttpTransport（有 post 方法）。
零第三方依赖；Python 3.10+ 兼容。
"""
import json
import threading
import time

from ....logging_setup import get_logger
from .mcp_pool import reconnect_backoff_delays

MCP_PROTOCOL_VERSION = '2025-06-18'
CLIENT_NAME = 'Harbor'
CLIENT_VERSION = '1.3.0'

# 超时常量（共享知识 5；tools/call 固定 60s = PRD 假设①）
CONNECT_TIMEOUT = 30      # 握手/冷启（npx 首次下载依赖）
LIST_TIMEOUT = 15         # tools/list
CALL_TIMEOUT = 60         # tools/call（固定阈值）
PING_TIMEOUT = 10         # ping

_METHOD_NOT_FOUND = {'code': -32601, 'message': 'Method not found'}
_UNSUPPORTED_SERVER_METHODS = ('sampling/createMessage', 'elicitation/create', 'roots/list')


class McpVersionError(Exception):
    """服务器响应的协议版本不受支持（客户端只钉 2025-06-18）。"""

    def __init__(self, server_version, supported=None):
        self.server_version = server_version
        self.supported = supported or []
        super().__init__('服务器协议版本 %r 不受支持（Harbor 支持 %s）'
                         % (server_version, MCP_PROTOCOL_VERSION))


class McpProtocolError(Exception):
    """JSON-RPC 层错误（含 code/message/data，如 -32602 工具不存在）。"""

    def __init__(self, code, message, data=None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__('MCP 协议错误 %s: %s' % (code, message))


class McpTimeoutError(Exception):
    """请求超时（已发送 notifications/cancelled）。"""

    def __init__(self, method, timeout):
        self.method = method
        self.timeout = timeout
        super().__init__('请求 %s 超时（%s 秒）' % (method, timeout))


class McpClient:
    """MCP 客户端：握手 / 列表分页 / 调用 / 取消 / -32601 拒绝。

    transport 注入：
    - stdio/内存桩：send(obj) + recv(timeout) + is_alive() + close()（有 dispatcher 线程）
    - HTTP：post(obj, timeout) + close()（无状态，每请求独立 POST）
    """

    def __init__(self, transport, logger=None):
        self._transport = transport
        self._log = logger or get_logger()
        self._http = hasattr(transport, 'post')     # 传输模式判别（duck-typing）
        self._id = 0
        self._id_lock = threading.Lock()
        self._pending = {}                          # str(id) -> {'event', 'resp'}
        self._pending_lock = threading.Lock()
        self._dispatcher = None
        self._initialized = False
        self._closed = False
        self._reconnecting = False               # 修复 S13：HTTP 404 重连防无限递归
        self._reconnect_owner_tid = None         # 修复 N15（四轮）：重连 owner 线程 id
        self._reconnect_attempts = 0             # 实现 v1.6 W21：404 重连退避计数（成功归零）
        self._reconnect_lock = threading.Lock()  # 修复 W17（二轮）：_reconnecting 并发无锁
        self.server_info = {}
        self.instructions = ''
        self._list_changed = False
        self._on_list_changed = None
        # stdio/内存桩：dispatcher 必须先于 initialize 请求启动（否则响应无人投递 → 死锁）
        if not self._http:
            self._start_dispatcher()
        else:
            # 修复 W15：HTTP SSE 流中的服务器通知/请求帧交由 _handle_frame 处理
            try:
                self._transport.on_frame = self._handle_frame
            except Exception:
                pass

    # ---- 公开属性 ----
    @property
    def tools_list_changed(self) -> bool:
        return self._list_changed

    def clear_list_changed(self):
        """修复 ⑨：tools/list_changed 标志在刷新完成后复位（原置位后永不复位）。"""
        self._list_changed = False

    def set_on_list_changed(self, callback):
        self._on_list_changed = callback

    def is_alive(self) -> bool:
        if self._closed:
            return False
        if self._http:
            # 修复 ⑩：HTTP 无状态无法真探测，但至少传输已关/近期连续失败时快速失败
            if getattr(self._transport, '_closed', False):
                return False
            return True
        try:
            return self._transport.is_alive()
        except Exception:
            return False

    # ---- 握手 ----
    def connect(self) -> dict:
        """initialize → 版本校验 → notifications/initialized。返回 {server_info, instructions}。"""
        result = self._request('initialize', {
            'protocolVersion': MCP_PROTOCOL_VERSION,
            'capabilities': {},
            'clientInfo': {'name': CLIENT_NAME, 'version': CLIENT_VERSION},
        }, timeout=CONNECT_TIMEOUT) or {}

        server_version = result.get('protocolVersion')
        if server_version != MCP_PROTOCOL_VERSION:
            self.close()
            raise McpVersionError(server_version, result.get('supported') or [])
        self.server_info = result.get('serverInfo') or {}
        self.instructions = result.get('instructions') or ''
        self._notify('notifications/initialized', {})
        self._initialized = True
        return {'server_info': self.server_info, 'instructions': self.instructions,
                'protocol_version': server_version}

    # ---- 工具面 ----
    def list_tools(self) -> list:
        """tools/list 跟随 nextCursor 直到为空，聚合 tools[]。"""
        tools = []
        cursor = None
        for _ in range(1000):                    # 游标翻页上限（防流氓服务器死循环）
            params = {}
            if cursor:
                params['cursor'] = cursor
            result = self._request('tools/list', params, timeout=LIST_TIMEOUT) or {}
            tools.extend(result.get('tools') or [])
            cursor = result.get('nextCursor')
            if not cursor:
                break
        return tools

    def call_tool(self, name: str, arguments: dict, timeout: float = None) -> dict:
        """tools/call；超时发 notifications/cancelled 并抛 McpTimeoutError。"""
        # 修复 ⑩（三轮）：原 `timeout or CALL_TIMEOUT` 会把显式 0 吞成默认——None 检查
        return self._request('tools/call',
                             {'name': name, 'arguments': arguments or {}},
                             timeout=timeout if timeout is not None else CALL_TIMEOUT) or {}

    # ============ v1.6 T12：MCP resources（text 优先；blob 落盘编排在 service 层）============
    RESOURCE_PAGE_LIMIT = 100      # resources/list 游标翻页上限（防流氓服务器死循环）

    def list_resources(self) -> list:
        """resources/list 跟随 nextCursor 直到为空，聚合 resources[]。

        每项形状（规范）：{uri, name?, title?, description?, mimeType?, size?,
        annotations?}——annotations 不可信原则沿用（readOnly 注解不当免检依据）。
        服务器不支持 resources（-32601）时由调用方按「无资源」处理。
        """
        resources = []
        cursor = None
        for _ in range(self.RESOURCE_PAGE_LIMIT):
            params = {}
            if cursor:
                params['cursor'] = cursor
            result = self._request('resources/list', params, timeout=LIST_TIMEOUT) or {}
            resources.extend(result.get('resources') or [])
            cursor = result.get('nextCursor')
            if not cursor:
                break
        return resources

    def read_resource(self, uri: str) -> dict:
        """resources/read：返回 {contents: [{uri, mimeType?, text?|blob?}]}。

        text 类（mimeType text/* 或 JSON）内容在 text 字段；blob 类为 base64
        （blob 字段）——截断落盘 toolcache 与 read_more 路径由 mcp_service 编排。
        """
        return self._request('resources/read', {'uri': str(uri or '')},
                            timeout=LIST_TIMEOUT) or {}

    def ping(self) -> dict:
        return self._request('ping', {}, timeout=PING_TIMEOUT if PING_TIMEOUT is not None else 15) or {}

    def cancel(self, request_id) -> None:
        """notifications/cancelled（规范取消语义，best-effort）。"""
        self._notify('notifications/cancelled',
                     {'requestId': request_id, 'reason': '请求超时或用户取消'})

    def close(self) -> None:
        self._closed = True
        self._fail_pending(McpProtocolError(-1, '客户端已关闭'))
        try:
            self._transport.close()
        except Exception as e:
            self._log.debug('transport 关闭异常: %r', e)

    # ---- 请求/通知 ----
    def _next_id(self) -> int:
        with self._id_lock:
            self._id += 1
            return self._id

    def _request(self, method: str, params: dict = None, timeout: float = None):
        if self._closed:
            raise McpProtocolError(-1, '客户端已关闭')
        # 修复 ⑧：`timeout or CONNECT_TIMEOUT` 会把合法的 0/极小值吞掉，改显式 None 判断
        timeout = timeout if timeout is not None else CONNECT_TIMEOUT
        rid = self._next_id()
        msg = {'jsonrpc': '2.0', 'id': rid, 'method': method}
        if params is not None:
            msg['params'] = params

        if self._http:
            return self._request_http(msg, method, timeout)
        return self._request_stateful(msg, method, timeout, rid)

    def _request_http(self, msg, method, timeout):
        try:
            resp = self._transport.post(msg, timeout)
        except Exception as e:
            # HTTP 404 且曾 initialize → 会话过期：清 session 重新握手一次再重试（规范口径）
            # 修复 S13：_reconnecting 防重试路径再 404 时无限递归（原约 330 层后 RecursionError）
            # 修复 W17（二轮）：_reconnecting 加锁 check-and-set——原无锁并发 404 双重握手，
            # 旁路请求在重连中途误失败；等待者等重连完成后重试
            if getattr(e, 'code', None) == 404 and self._initialized \
                    and (method == 'initialize' or method.endswith('/list')) \
                    and 'reset_session' in dir(self._transport):
                with self._reconnect_lock:
                    owner = not self._reconnecting
                    if owner:
                        self._reconnecting = True
                        self._reconnect_owner_tid = threading.get_ident()
                if owner:
                    try:
                        self._log.info('HTTP 会话过期（404），重新握手后重试')
                        # 实现 v1.6 W21：404 重连走退避序列（reconnect_backoff_delays
                        # 1s/2s/4s，连续失败递增、握手成功后归零）——防服务端周期性
                        # 回收会话时的重连风暴（原立即重连无退避）
                        delays = reconnect_backoff_delays()
                        idx = min(self._reconnect_attempts, len(delays) - 1)
                        self._reconnect_attempts += 1
                        if delays[idx] > 0:
                            time.sleep(delays[idx])
                        self._transport.reset_session()
                        self._reconnect()
                        self._reconnect_attempts = 0
                    except Exception as e2:
                        raise McpProtocolError(-1, 'HTTP 重连后重试失败: %s' % e2)
                    finally:
                        with self._reconnect_lock:
                            self._reconnecting = False
                            self._reconnect_owner_tid = None   # 修复 N15（四轮）
                else:
                    # 修复 N15（四轮）：owner 线程的重连请求再遇 404（重连中 initialize
                    # 也 404）时，原走等待分支等自己清标志——死等到 _dl（≥30s）才报错。
                    # owner 线程直接抛错，不等自己。
                    if threading.get_ident() == self._reconnect_owner_tid:
                        raise McpProtocolError(-1, 'HTTP 重连失败（initialize 也会话过期）: %s' % e)
                    _dl = time.monotonic() + max(timeout or 0, 30)
                    while time.monotonic() < _dl and self._reconnecting:
                        time.sleep(0.05)
                try:
                    resp = self._transport.post(msg, timeout)
                except Exception as e3:
                    raise McpProtocolError(-1, 'HTTP 重连后重试失败: %s' % e3)
            else:
                raise McpProtocolError(-1, 'HTTP 传输失败: %s' % e)
        return self._unwrap(resp, msg['id'])

    def _request_stateful(self, msg, method, timeout, rid):
        slot = {'event': threading.Event(), 'resp': None}
        with self._pending_lock:
            self._pending[str(rid)] = slot
        try:
            self._transport.send(msg)
        except Exception as e:
            with self._pending_lock:
                self._pending.pop(str(rid), None)
            raise McpProtocolError(-1, '发送失败（连接可能已断开）: %s' % e)
        if not slot['event'].wait(timeout):
            with self._pending_lock:
                self._pending.pop(str(rid), None)
            try:
                self.cancel(rid)
            except Exception:
                pass
            raise McpTimeoutError(method, timeout)
        with self._pending_lock:
            self._pending.pop(str(rid), None)
        return self._unwrap(slot['resp'], rid)

    def _unwrap(self, resp, rid):
        if not isinstance(resp, dict):
            raise McpProtocolError(-1, '无响应或响应不是对象')
        # 修复 S12：先查 error 再校验 id——规范允许错误帧带 null id；
        # 原顺序使断连注入的 id=None 错误帧被误判为“响应 id 不匹配”，掩盖真实错误
        err = resp.get('error')
        if err is not None:
            if isinstance(err, dict):
                raise McpProtocolError(err.get('code', -1), err.get('message', '未知错误'),
                                       err.get('data'))
            raise McpProtocolError(-1, str(err))
        # 修复 ⑨（三轮）：原 `if 'id' in resp and ...` 对**缺 id 的响应直接放行**——
        # 非法/伪造帧可注入伪造 result；error 帧已在上方特许 null id，此处响应帧必须带匹配 id
        if 'id' not in resp or str(resp.get('id')) != str(rid):
            raise McpProtocolError(-1, '响应 id 不匹配（期望 %s，实际 %r）' % (rid, resp.get('id')))
        return resp.get('result')

    def _notify(self, method: str, params: dict = None) -> None:
        if self._closed:
            return
        msg = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        if self._http:
            try:
                self._transport.post(msg, PING_TIMEOUT)
            except Exception as e:
                self._log.debug('HTTP 通知 %s 失败: %r', method, e)
            return
        try:
            self._transport.send(msg)
        except Exception as e:
            self._log.warning('通知 %s 发送失败: %r', method, e)

    def _reconnect(self):
        """HTTP 404 重连：重新 initialize + initialized（保留 serverInfo/instructions）。"""
        result = self._request('initialize', {
            'protocolVersion': MCP_PROTOCOL_VERSION,
            'capabilities': {},
            'clientInfo': {'name': CLIENT_NAME, 'version': CLIENT_VERSION},
        }, timeout=CONNECT_TIMEOUT) or {}
        if result.get('protocolVersion') != MCP_PROTOCOL_VERSION:
            raise McpVersionError(result.get('protocolVersion'), result.get('supported') or [])
        self.server_info = result.get('serverInfo') or self.server_info
        self.instructions = result.get('instructions') or self.instructions
        self._notify('notifications/initialized', {})

    # ---- dispatcher（stdio/内存桩）----
    def _start_dispatcher(self):
        self._dispatcher = threading.Thread(target=self._dispatch_loop, daemon=True,
                                            name='mcp-client-dispatch')
        self._dispatcher.start()

    def _dispatch_loop(self):
        while not self._closed:
            try:
                frame = self._transport.recv(0.5)
            except Exception:
                break
            if frame is None:
                if not self.is_alive():
                    break
                continue
            try:
                self._handle_frame(frame)
            except Exception as e:
                self._log.warning('帧处理异常: %r', e)
        # 连接断开：立即失败所有在途请求（不等到超时）
        self._fail_pending(McpProtocolError(-1, 'MCP 服务器连接已断开（进程退出或管道关闭）'))

    def _handle_frame(self, frame):
        if not isinstance(frame, dict):
            return
        mid = frame.get('id')
        if mid is not None and 'method' in frame:
            self._reply_method_not_found(mid, frame.get('method'))
            return
        if mid is not None:
            with self._pending_lock:
                slot = self._pending.get(str(mid))
            if slot is not None:
                slot['resp'] = frame
                slot['event'].set()
            return
        method = frame.get('method')
        if method == 'notifications/tools/list_changed':
            self._list_changed = True
            cb = self._on_list_changed
            if cb is not None:
                try:
                    cb()
                except Exception as e:
                    self._log.warning('list_changed 回调异常: %r', e)

    def _reply_method_not_found(self, mid, method):
        """服务器发起的不支持请求（sampling/elicitation/roots）→ 规范回复 -32601。"""
        if method in _UNSUPPORTED_SERVER_METHODS:
            self._log.info('服务器发起不受支持的请求 %s，按规范回复 -32601', method)
        try:
            self._transport.send({'jsonrpc': '2.0', 'id': mid, 'error': dict(_METHOD_NOT_FOUND)})
        except Exception as e:
            self._log.warning('回复 -32601 失败: %r', e)

    def _fail_pending(self, error):
        with self._pending_lock:
            slots = list(self._pending.values())
            self._pending.clear()
        for slot in slots:
            slot['resp'] = {'jsonrpc': '2.0', 'id': None, 'error': {
                'code': error.code, 'message': error.message}}
            slot['event'].set()
