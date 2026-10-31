# -*- coding: utf-8 -*-
"""W2P zero-dependency statistics, process and loopback CDP protocol tests."""
import base64
import hashlib
import json
import socket
import struct
import threading

import pytest

from tools import perf_benchmark
from tools import perf_cdp
from tools import perf_stats
from tools import perf_system


def test_nearest_rank_percentile_boundaries_and_raw_samples():
    samples = [40, 10, 30, 20]
    summary = perf_stats.summarize(samples, elapsed_seconds=0.2)
    assert summary['median'] == 25
    assert summary['p95'] == 40 and summary['p99'] == 40
    assert summary['samples'] == samples and summary['min'] == 10 and summary['max'] == 40
    assert summary['tasks_per_s'] == 20
    assert perf_stats.nearest_rank(list(range(1, 101)), 0.95) == 95
    assert perf_stats.nearest_rank(list(range(1, 101)), 0.99) == 99
    assert perf_stats.nearest_rank([7], 0.99) == 7


def test_percentile_empty_and_invalid_inputs_fail():
    with pytest.raises(ValueError, match='at least one'):
        perf_stats.nearest_rank([], 0.95)
    with pytest.raises(ValueError, match='percentile'):
        perf_stats.nearest_rank([1], 0)
    with pytest.raises(ValueError, match='at least one'):
        perf_stats.summarize([])


def test_group_metadata_keeps_algorithm_and_parallel_dimensions():
    group = perf_stats.group_metadata(False, 'new-serial', concurrency=1, label='A')
    assert group['temperature'] == 'warm' and group['algorithm'] == 'new-serial'
    assert group['parallel'] == {'enabled': False, 'concurrency': 1}


def test_current_process_before_after_counters():
    sampler = perf_system.ProcessSampler()
    before = sampler.before()
    report = sampler.after()
    assert before['status'] == report['status']
    if before['status'] == 'UNCOVERED':
        assert before['reason']
    else:
        assert before['scope'] == 'current-process'
        assert before['rss_bytes'] > 0 and before['threads'] >= 1
        assert before['handles'] > 0
        assert report['delta']['wall_ms'] >= 0
        assert set(report['before']) >= {'user_ms', 'kernel_ms', 'io_read_bytes', 'io_write_bytes'}


def test_non_windows_process_counters_are_uncovered(monkeypatch):
    monkeypatch.setattr(perf_system.platform, 'system', lambda: 'Linux')
    report = perf_system.sample_process()
    assert report['status'] == 'UNCOVERED' and report['reason']
    assert 'rss_bytes' not in report


def test_loopback_validation_rejects_remote_and_missing_endpoint_is_uncovered():
    for endpoint in ('http://example.com/json/version', 'ws://192.168.1.2:9222/devtools/page/1',
                     'https://127.0.0.1:9222/json/version'):
        with pytest.raises(ValueError):
            perf_cdp.validate_endpoint(endpoint, websocket=endpoint.startswith('ws'))
    report = perf_cdp.collect_performance(None)
    assert report['status'] == 'UNCOVERED' and 'endpoint' in report['reason']


def _read_exact(connection, length):
    chunks = b''
    while len(chunks) < length:
        block = connection.recv(length - len(chunks))
        assert block
        chunks += block
    return chunks


def _read_client_frame(connection):
    first, second = _read_exact(connection, 2)
    assert second & 0x80, 'client-to-server frames must be masked'
    length = second & 0x7f
    if length == 126:
        length = struct.unpack('!H', _read_exact(connection, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', _read_exact(connection, 8))[0]
    mask = _read_exact(connection, 4)
    payload = _read_exact(connection, length)
    decoded = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return first & 0x0f, decoded


class FakeWebSocketServer:
    """Authorized loopback fake; no browser, executable or external connection."""

    def __init__(self, handshake='valid', fragmented=False, scripted_results=None):
        self.handshake = handshake
        self.fragmented = fragmented
        self.scripted_results = scripted_results
        self.requests = []
        self.socket = socket.socket()
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(('127.0.0.1', 0))
        self.socket.listen(1)
        self.port = self.socket.getsockname()[1]
        self.url = 'ws://127.0.0.1:%d/devtools/page/fake' % self.port
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            connection, _address = self.socket.accept()
            with connection:
                request = b''
                while b'\r\n\r\n' not in request:
                    request += connection.recv(1024)
                if self.handshake == 'bad':
                    connection.sendall(b'HTTP/1.1 401 Unauthorized\r\n\r\n')
                    return
                key = next(line.split(b':', 1)[1].strip() for line in request.split(b'\r\n')
                           if line.lower().startswith(b'sec-websocket-key:'))
                accept = base64.b64encode(hashlib.sha1(key + perf_cdp._GUID.encode()).digest())
                connection.sendall(b'HTTP/1.1 101 Switching Protocols\r\n'
                                   b'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                                   b'Sec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
                results = self.scripted_results or [{'ok': True}]
                for result in results:
                    _opcode, payload = _read_client_frame(connection)
                    request_json = json.loads(payload)
                    self.requests.append(request_json)
                    response = json.dumps({'id': request_json['id'], 'result': result}).encode()
                    if self.fragmented:
                        split = len(response) // 2
                        connection.sendall(perf_cdp.encode_frame(0x1, response[:split], fin=False))
                        connection.sendall(perf_cdp.encode_frame(0x0, response[split:], fin=True))
                    else:
                        connection.sendall(perf_cdp.encode_frame(0x1, response))
        except (OSError, AssertionError, StopIteration):
            pass
        finally:
            self.socket.close()

    def join(self):
        self.thread.join(3)
        assert not self.thread.is_alive()


def test_fake_server_handshake_masking_and_fragmented_response():
    server = FakeWebSocketServer(fragmented=True)
    with perf_cdp.WebSocketConnection.connect(server.url) as connection:
        client = perf_cdp.CdpClient(connection)
        assert client.call('Runtime.enable') == {'ok': True}
    server.join()
    assert server.requests[0]['method'] == 'Runtime.enable'


def test_fake_server_bad_handshake_is_rejected():
    server = FakeWebSocketServer(handshake='bad')
    with pytest.raises(perf_cdp.CdpError, match='handshake rejected'):
        perf_cdp.WebSocketConnection.connect(server.url)
    server.join()


def test_oversized_frame_is_rejected_before_payload_read():
    left, right = socket.socketpair()
    try:
        right.sendall(perf_cdp.encode_frame(0x1, b'x' * 64))
        with pytest.raises(perf_cdp.CdpError, match='exceeds configured limit'):
            perf_cdp.WebSocketConnection(left, max_frame_bytes=32).recv_frame()
    finally:
        left.close()
        right.close()


def test_collect_performance_protocol_against_fake_server():
    scripted = [
        {},
        {'result': {'type': 'boolean', 'value': True}},
        {'metrics': [{'name': 'LayoutCount', 'value': 2}]},
        {'result': {'type': 'string', 'value': '{"longtask":[],"event":[],"paint":[]}'}},
    ]
    server = FakeWebSocketServer(scripted_results=scripted)
    report = perf_cdp.collect_performance(server.url, longtask_ms=0)
    server.join()
    assert report['status'] == 'OK'
    assert report['metrics'] == [{'name': 'LayoutCount', 'value': 2}]
    methods = [request['method'] for request in server.requests]
    assert methods == ['Performance.enable', 'Runtime.evaluate',
                       'Performance.getMetrics', 'Runtime.evaluate']


def test_node_event_loop_process_and_correctness_fields():
    report = perf_benchmark.frontend_benchmark(3)
    assert report['event_loop_delay']['samples']
    assert report['event_loop_delay']['p95'] is not None
    assert report['event_loop_histogram']['p99'] is not None
    assert report['process']['delta']['wall_ms'] >= 0
    assert report['process']['after']['rss_bytes'] > 0
    assert report['correctness']['stream_frames_last_run'] == \
        report['correctness']['expected_stream_frames']
    for metric in report['metrics'].values():
        assert metric['p95'] is not None and metric['p99'] is not None
        assert metric['tasks_per_s'] > 0


def test_python_report_process_and_nearest_rank_schema():
    report = perf_benchmark.backend_benchmark(3, 8, False)
    core = perf_benchmark.core_backend_benchmark(3, 20)
    metric = report['metrics']['search_cache_stats']
    assert len(metric['samples']) == 3 and metric['p95'] is not None
    assert metric['p99'] is not None and metric['tasks_per_s'] > 0
    assert report['process']['status'] in {'OK', 'UNCOVERED'}
    assert report['process']['before']['status'] == report['process']['status']
    assert core['correctness']['list_return_cap'] == 200
    if core['process']['status'] == 'OK':
        assert core['process']['delta']['wall_ms'] >= 0
    else:
        assert core['process']['before']['status'] == 'UNCOVERED'


def test_tools_have_no_product_process_browser_or_remote_launch():
    sources = [(perf_benchmark.ROOT / 'tools' / name).read_text(encoding='utf-8')
               for name in ('perf_system.py', 'perf_cdp.py', 'perf_stats.py')]
    combined = '\n'.join(sources)
    for forbidden in ('Popen', 'subprocess.', 'startfile', 'create_window',
                      'dist/Harbor.exe', 'child_process', 'webview.start'):
        assert forbidden not in combined
    frontend = (perf_benchmark.ROOT / 'tools' / 'perf_frontend_benchmark.js').read_text(encoding='utf-8')
    assert 'child_process' not in frontend
    assert 'monitorEventLoopDelay' in frontend
