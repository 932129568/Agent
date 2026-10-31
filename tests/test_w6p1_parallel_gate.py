# -*- coding: utf-8 -*-
"""W6P1 production-inline=1, revision, close/release and non-idempotent gates."""
import json
import threading
import time
from pathlib import Path

import pytest

from backend.application.registry import TaskRegistry
from backend.application.scheduler import DomainScheduler
from backend.application.task import TaskEnvelope, TaskFailure
from backend.domains.integrations.mcp.mcp_client import McpClient, McpProtocolError
from backend.domains.integrations.mcp.mcp_transport_http import HttpTransportError
from backend.domains.integrations.webdav_service import WebDAVService

ROOT = Path(__file__).resolve().parent.parent


def test_baseline_and_read_probe_keep_production_at_one():
    baseline = json.loads((ROOT / 'outputs' / 'perf' / 'w6p1-baseline.json').read_text(encoding='utf-8'))
    report = json.loads((ROOT / 'outputs' / 'perf' / 'w6p1-report.json').read_text(encoding='utf-8'))
    assert baseline and report['ok'] is True
    assert report['production_default'] == {'concurrency': 1, 'inline': True}
    assert report['enabled_domains'] == []
    assert report['exploration_runs'] == 7 and report['tail_runs'] == 30
    for name, domain in report['domains'].items():
        assert domain['status'] == 'keep1', name
        for result in domain['results']:
            assert len(result['original_samples_ms']) == 37
            assert result['correctness'] is True
            assert result['scheduler']['drained'] is True
            assert result['process']['status'] in {'OK', 'UNCOVERED'}


def test_inline_default_and_same_resource_write_are_serial(tmp_path):
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry)
    active = [0, 0]
    target = tmp_path / 'writes.txt'
    def write(envelope):
        active[0] += 1
        active[1] = max(active[0], active[1])
        with target.open('a', encoding='utf-8') as handle:
            handle.write(envelope.operationId + '\n')
        active[0] -= 1
        return envelope.operationId
    futures = [scheduler.submit(TaskEnvelope.create('workspace', 'write', resourceKeys=('file',), operationId=str(index)), write)
               for index in range(8)]
    assert [future.result(1) for future in futures] == [str(index) for index in range(8)]
    assert scheduler.inline is True and scheduler.worker_count == 1 and active[1] == 1
    assert len(target.read_text(encoding='utf-8').splitlines()) == 8
    scheduler.close()


def test_stale_revision_never_executes_read():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry)
    calls = []
    envelope = TaskEnvelope.create('settings', 'read', resourceKeys=('config.json',),
                                   expectedRevision=2, submitRevision=1)
    future = scheduler.submit(envelope, lambda _env: calls.append(1))
    with pytest.raises(TaskFailure) as error:
        future.result(1)
    assert 'REVISION_STALE' in str(error.value)
    assert calls == []
    scheduler.close()


def test_close_release_cancels_queued_and_late_execution_does_not_continue():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=1)
    started = threading.Event()
    release = threading.Event()
    calls = []
    def blocking(envelope):
        calls.append(envelope.taskId)
        started.set()
        release.wait(1)
        return envelope.taskId
    first = scheduler.submit(TaskEnvelope.create('workspace', 'read', resourceKeys=('same',)), blocking)
    assert started.wait(1)
    second = scheduler.submit(TaskEnvelope.create('workspace', 'read', resourceKeys=('same',)), blocking)
    closing = threading.Thread(target=scheduler.close)
    closing.start()
    release.set()
    closing.join(2)
    assert not closing.is_alive()
    assert registry.result(second.task_id).status == 'cancelled'
    assert calls == [first.task_id]
    assert scheduler.submit(TaskEnvelope.create('workspace', 'read'), lambda _env: calls.append('late')).task_id
    assert 'late' not in calls


class _Http404:
    def __init__(self, method):
        self.method = method
        self.calls = []
    def post(self, obj, timeout):
        self.calls.append(obj['method'])
        if obj['method'] == self.method and len(self.calls) == 1:
            raise HttpTransportError('not found', 404)
        return {'jsonrpc': '2.0', 'id': obj['id'], 'result': {'tools': []}}
    def reset_session(self):
        pass
    def close(self):
        pass


def test_mcp_404_only_list_replays_once_call_never_replays(monkeypatch):
    monkeypatch.setattr('backend.domains.integrations.mcp.mcp_client.reconnect_backoff_delays', lambda: (0, 0, 0))
    call_transport = _Http404('tools/call')
    client = McpClient(call_transport)
    client._initialized = True
    reconnects = []
    monkeypatch.setattr(client, '_reconnect', lambda: reconnects.append(1))
    with pytest.raises(McpProtocolError):
        client._request('tools/call', {}, 1)
    assert call_transport.calls == ['tools/call'] and reconnects == []
    list_transport = _Http404('tools/list')
    listed = McpClient(list_transport)
    listed._initialized = True
    monkeypatch.setattr(listed, '_reconnect', lambda: None)
    assert listed._request('tools/list', {}, 1)['tools'] == []
    assert list_transport.calls == ['tools/list', 'tools/list']


def test_webdav_export_restore_have_no_non_idempotent_replay(tmp_path, monkeypatch):
    service = WebDAVService(config_dir=str(tmp_path))
    monkeypatch.setattr(service, '_record_for_io', lambda _cfg='{}': ({'url': 'https://example.invalid'}, None))
    calls = []
    monkeypatch.setattr('backend.domains.integrations.webdav_service.export_backup',
                        lambda *args: calls.append('export') or {'ok': True})
    monkeypatch.setattr('backend.domains.integrations.webdav_service.restore_backup',
                        lambda *args: calls.append('restore') or {'ok': True})
    assert service.export('{}')['ok'] is True
    assert service.restore('{}', '{}')['ok'] is True
    assert calls == ['export', 'restore']
