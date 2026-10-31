# -*- coding: utf-8 -*-
"""Authorized-loopback-only CDP collection using stdlib HTTP and raw WebSocket."""
import base64
import hashlib
import http.client
import json
import os
import socket
import ssl  # noqa: F401  (HTTPS/WSS intentionally unsupported and rejected)
import struct
import time
import urllib.parse

_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
_LOOPBACK = {'127.0.0.1', 'localhost'}
_DEFAULT_MAX_FRAME = 1024 * 1024


class CdpError(Exception):
    """CDP transport, handshake or protocol failure."""


class CdpTimeout(CdpError):
    """Bounded socket operation exceeded its deadline."""


def validate_endpoint(url, websocket=None):
    """Validate an explicit endpoint; remote hosts and implicit schemes are rejected."""
    if not url:
        raise ValueError('an explicit authorized loopback CDP endpoint is required')
    parsed = urllib.parse.urlsplit(url)
    expected = {'ws', 'wss'} if websocket else {'http', 'https'}
    if parsed.scheme not in expected:
        raise ValueError('unsupported CDP endpoint scheme: %s' % parsed.scheme)
    if websocket and parsed.scheme != 'ws':
        raise ValueError('only raw ws:// loopback endpoints are supported')
    if not websocket and parsed.scheme != 'http':
        raise ValueError('only http:// loopback discovery endpoints are supported')
    if (parsed.hostname or '').lower() not in _LOOPBACK:
        raise ValueError('CDP endpoint must be explicitly authorized loopback')
    if parsed.username or parsed.password:
        raise ValueError('CDP endpoint credentials are not accepted')
    try:
        parsed.port
    except ValueError as error:
        raise ValueError('invalid CDP endpoint port') from error
    return parsed


def discover_websocket_url(endpoint, timeout=2.0):
    """Resolve an existing loopback HTTP discovery endpoint without redirects."""
    parsed = validate_endpoint(endpoint, websocket=False)
    path = parsed.path or '/json/version'
    if parsed.query:
        path += '?' + parsed.query
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
    try:
        connection.request('GET', path, headers={'Connection': 'close'})
        response = connection.getresponse()
        payload = response.read(_DEFAULT_MAX_FRAME + 1)
        if len(payload) > _DEFAULT_MAX_FRAME:
            raise CdpError('CDP discovery response exceeds limit')
        if response.status != 200:
            raise CdpError('CDP discovery returned HTTP %d' % response.status)
        document = json.loads(payload.decode('utf-8'))
        if isinstance(document, list):
            document = document[0] if document else {}
        websocket_url = document.get('webSocketDebuggerUrl')
        if not websocket_url:
            raise CdpError('CDP discovery has no webSocketDebuggerUrl')
        validate_endpoint(websocket_url, websocket=True)
        return websocket_url
    finally:
        connection.close()


def _read_exact(connection, length):
    chunks = []
    remaining = length
    while remaining:
        try:
            chunk = connection.recv(remaining)
        except socket.timeout as error:
            raise CdpTimeout('WebSocket read timed out') from error
        if not chunk:
            raise CdpError('WebSocket closed unexpectedly')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


def encode_frame(opcode, payload=b'', masked=False, fin=True):
    """Encode one WebSocket frame; clients always pass masked=True."""
    if isinstance(payload, str):
        payload = payload.encode('utf-8')
    first = (0x80 if fin else 0) | (opcode & 0x0f)
    mask_bit = 0x80 if masked else 0
    length = len(payload)
    if length < 126:
        header = struct.pack('!BB', first, mask_bit | length)
    elif length <= 0xffff:
        header = struct.pack('!BBH', first, mask_bit | 126, length)
    else:
        header = struct.pack('!BBQ', first, mask_bit | 127, length)
    if not masked:
        return header + payload
    mask = os.urandom(4)
    body = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return header + mask + body


class WebSocketConnection:
    """Small bounded RFC6455 client with masking and continuation support."""

    def __init__(self, connection, timeout=2.0, max_frame_bytes=_DEFAULT_MAX_FRAME):
        self.connection = connection
        self.timeout = timeout
        self.max_frame_bytes = max_frame_bytes
        self.connection.settimeout(timeout)

    @classmethod
    def connect(cls, url, timeout=2.0, max_frame_bytes=_DEFAULT_MAX_FRAME):
        parsed = validate_endpoint(url, websocket=True)
        connection = socket.create_connection(
            (parsed.hostname, parsed.port or 80), timeout=timeout)
        try:
            instance = cls(connection, timeout, max_frame_bytes)
            instance._handshake(parsed)
            return instance
        except Exception:
            connection.close()
            raise

    def _handshake(self, parsed):
        key = base64.b64encode(os.urandom(16)).decode('ascii')
        path = parsed.path or '/'
        if parsed.query:
            path += '?' + parsed.query
        request = (
            'GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n'
            'Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n'
            'Sec-WebSocket-Version: 13\r\n\r\n'
        ) % (path, parsed.hostname, parsed.port or 80, key)
        self.connection.sendall(request.encode('ascii'))
        response = bytearray()
        while b'\r\n\r\n' not in response:
            if len(response) > 16384:
                raise CdpError('WebSocket handshake headers exceed limit')
            response.extend(self.connection.recv(1024))
        header = bytes(response).split(b'\r\n\r\n', 1)[0].decode('iso-8859-1')
        lines = header.split('\r\n')
        if not lines or ' 101 ' not in lines[0]:
            raise CdpError('WebSocket handshake rejected: %s' % (lines[0] if lines else 'empty'))
        headers = {}
        for line in lines[1:]:
            if ':' in line:
                name, value = line.split(':', 1)
                headers[name.strip().lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode('ascii')).digest()).decode('ascii')
        if headers.get('sec-websocket-accept') != expected:
            raise CdpError('WebSocket handshake accept mismatch')

    def send_frame(self, opcode, payload=b''):
        self.connection.sendall(encode_frame(opcode, payload, masked=True))

    def recv_frame(self):
        first, second = _read_exact(self.connection, 2)
        fin = bool(first & 0x80)
        opcode = first & 0x0f
        masked = bool(second & 0x80)
        length = second & 0x7f
        if length == 126:
            length = struct.unpack('!H', _read_exact(self.connection, 2))[0]
        elif length == 127:
            length = struct.unpack('!Q', _read_exact(self.connection, 8))[0]
        if length > self.max_frame_bytes:
            raise CdpError('WebSocket frame exceeds configured limit')
        if opcode >= 0x8 and (not fin or length > 125):
            raise CdpError('invalid WebSocket control frame')
        mask = _read_exact(self.connection, 4) if masked else None
        payload = _read_exact(self.connection, length) if length else b''
        if mask:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        return fin, opcode, payload

    def recv_message(self):
        fragments = []
        message_opcode = None
        while True:
            fin, opcode, payload = self.recv_frame()
            if opcode == 0x8:
                raise CdpError('WebSocket peer closed connection')
            if opcode == 0x9:
                self.send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0:
                if message_opcode is None:
                    raise CdpError('unexpected WebSocket continuation')
            elif opcode in (0x1, 0x2):
                if message_opcode is not None:
                    raise CdpError('new WebSocket message during fragmented message')
                message_opcode = opcode
            else:
                raise CdpError('unsupported WebSocket opcode: %d' % opcode)
            fragments.append(payload)
            if sum(len(part) for part in fragments) > self.max_frame_bytes:
                raise CdpError('WebSocket message exceeds configured limit')
            if fin:
                return b''.join(fragments)

    def send_json(self, value):
        self.send_frame(0x1, json.dumps(value, ensure_ascii=False).encode('utf-8'))

    def recv_json(self):
        try:
            return json.loads(self.recv_message().decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CdpError('invalid JSON WebSocket message') from error

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback):
        self.close()


class CdpClient:
    """Synchronous CDP request/response client retaining asynchronous events."""

    def __init__(self, connection):
        self.connection = connection
        self._next_id = 0
        self.events = []

    def call(self, method, params=None):
        self._next_id += 1
        request_id = self._next_id
        self.connection.send_json({'id': request_id, 'method': method, 'params': params or {}})
        while True:
            message = self.connection.recv_json()
            if message.get('id') != request_id:
                self.events.append(message)
                continue
            if 'error' in message:
                raise CdpError('%s failed: %r' % (method, message['error']))
            return message.get('result', {})


_OBSERVER_SETUP = r'''(() => {
  globalThis.__harborPerf = {longtask: [], event: [], paint: [], error: ''};
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const row = {name: entry.name, startTime: entry.startTime, duration: entry.duration};
        if (entry.entryType === 'longtask') globalThis.__harborPerf.longtask.push(row);
        else if (entry.entryType === 'event') globalThis.__harborPerf.event.push(row);
        else if (entry.entryType === 'paint') globalThis.__harborPerf.paint.push(row);
      }
    });
    observer.observe({entryTypes: ['longtask', 'event', 'paint']});
    globalThis.__harborPerfObserver = observer;
    return true;
  } catch (error) { globalThis.__harborPerf.error = String(error); return false; }
})()'''


def collect_performance(endpoint, longtask_ms=0, timeout=2.0, max_frame_bytes=_DEFAULT_MAX_FRAME):
    """Collect metrics/observer entries from an existing endpoint, never launch one."""
    if not endpoint:
        return {'status': 'UNCOVERED', 'reason': 'No explicit authorized loopback CDP endpoint supplied'}
    websocket_url = endpoint if endpoint.startswith(('ws://', 'wss://')) else discover_websocket_url(
        endpoint, timeout=timeout)
    validate_endpoint(websocket_url, websocket=True)
    try:
        with WebSocketConnection.connect(websocket_url, timeout, max_frame_bytes) as connection:
            client = CdpClient(connection)
            client.call('Performance.enable')
            observer = client.call('Runtime.evaluate', {
                'expression': _OBSERVER_SETUP, 'returnByValue': True})
            if longtask_ms:
                time.sleep(longtask_ms / 1000.0)
            metrics = client.call('Performance.getMetrics')
            entries = client.call('Runtime.evaluate', {
                'expression': 'JSON.stringify(globalThis.__harborPerf || null)',
                'returnByValue': True})
            return {
                'status': 'OK', 'scope': 'existing-authorized-loopback-cdp',
                'metrics': metrics.get('metrics', []),
                'observer_setup': observer.get('result', {}),
                'observer': entries.get('result', {}),
                'events': client.events,
            }
    except (OSError, CdpError, ValueError, json.JSONDecodeError) as error:
        return {'status': 'UNCOVERED', 'reason': str(error), 'scope': 'existing-authorized-loopback-cdp'}
