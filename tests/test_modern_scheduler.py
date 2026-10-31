# -*- coding: utf-8 -*-
"""W3A inline-first scheduler admission, cancellation and API equivalence tests."""
import json
import threading
import time
from unittest import mock

import pytest

from backend.api import Api
from backend.application.registry import TaskRegistry
from backend.application.scheduler import DomainScheduler
from backend.application.task import (
    DeadlineExceeded, TaskCancelled, TaskEnvelope, TaskFailure, TaskStatus)
from backend.errors import ok
from conftest import fresh_home  # noqa: F401,E402


def envelope(operation='execute', keys=(), timeout_ms=2000, payload=0):
    return TaskEnvelope.create('test', operation, resourceKeys=keys,
                               timeout_ms=timeout_ms, payloadBytes=payload)


def test_inline_result_lazy_domain_and_zero_new_threads():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry)
    created = []

    def factory():
        created.append('factory')
        return lambda request: (request.domain, request.operation)

    scheduler.register_domain('test', factory)
    before = threading.active_count()
    first = scheduler.submit(envelope())
    assert first.result() == ('test', 'execute')
    assert scheduler.submit(envelope()).result() == ('test', 'execute')
    assert created == ['factory']
    assert threading.active_count() == before
    assert scheduler.metrics()['workers'] == 0
    assert scheduler.metrics()['tasks_per_s'] > 0
    assert scheduler.close()['status'] == 'OK'


def test_resource_keys_sorted_and_same_key_serial_in_explicit_worker_fixture():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=2)
    active = 0
    maximum = 0
    seen = []
    lock = threading.Lock()

    def work(request):
        nonlocal active, maximum
        assert request.resourceKeys == ('a', 'z')
        with lock:
            active += 1
            maximum = max(maximum, active)
            seen.append(request.resourceKeys)
        time.sleep(0.025)
        with lock:
            active -= 1
        return True

    futures = [scheduler.submit(envelope(keys=('z', 'a')), work) for _ in range(4)]
    assert [future.result() for future in futures] == [True] * 4
    assert maximum == 1 and len(seen) == 4
    assert scheduler.metrics()['workers'] == 2
    assert scheduler.close()['status'] == 'OK'


def test_queue_count_backpressure_returns_structured_busy():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=1, max_queue=1)
    entered = threading.Event()
    release = threading.Event()

    def blocking(_request):
        entered.set()
        assert release.wait(2)

    first = scheduler.submit(envelope(), blocking)
    assert entered.wait(1)
    scheduler.submit(envelope(), lambda _request: None)
    rejected = scheduler.submit(envelope(), lambda _request: None)
    with pytest.raises(TaskFailure) as failure:
        rejected.result()
    assert failure.value.error.code == 'SCHEDULER_BUSY'
    assert failure.value.error.retryable is True
    release.set()
    first.result()
    assert scheduler.close()['status'] == 'OK'


def test_queue_bytes_backpressure_happens_before_executor():
    registry = TaskRegistry()
    scheduler = DomainScheduler(
        registry, inline=False, worker_count=1, max_queue=4, max_queue_bytes=5)
    entered = threading.Event()
    release = threading.Event()
    unexpected = mock.Mock()

    def blocking(_request):
        entered.set()
        assert release.wait(2)

    scheduler.submit(envelope(payload=1), blocking)
    assert entered.wait(1)
    scheduler.submit(envelope(payload=4), lambda _request: None)
    rejected = scheduler.submit(envelope(payload=2), unexpected)
    with pytest.raises(TaskFailure) as failure:
        rejected.result()
    assert failure.value.error.code == 'QUEUE_BYTES_EXCEEDED'
    unexpected.assert_not_called()
    release.set()
    assert scheduler.close()['status'] == 'OK'


def test_queued_cancel_prevents_execution():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=1)
    entered = threading.Event()
    release = threading.Event()
    skipped = mock.Mock()

    def blocking(_request):
        entered.set()
        assert release.wait(2)

    scheduler.submit(envelope(), blocking)
    assert entered.wait(1)
    queued = scheduler.submit(envelope(), skipped)
    assert registry.cancel(queued.task_id) == 'queued'
    with pytest.raises(TaskCancelled) as cancelled:
        queued.result()
    assert cancelled.value.error.code == 'CANCELLED'
    release.set()
    assert scheduler.close()['status'] == 'OK'
    skipped.assert_not_called()


def test_running_cancel_is_cooperative_not_forced_stop():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=1)
    entered = threading.Event()

    def cooperative(request):
        entered.set()
        deadline = time.monotonic() + 2
        while not request.cancelToken.is_set() and time.monotonic() < deadline:
            time.sleep(0.005)
        assert request.cancelToken.is_set()
        return 'must-not-commit-as-success'

    future = scheduler.submit(envelope(), cooperative)
    assert entered.wait(1)
    assert registry.cancel(future.task_id) == 'cooperative'
    with pytest.raises(TaskCancelled):
        future.result()
    assert registry.result(future.task_id).status == TaskStatus.CANCELLED
    assert scheduler.close()['status'] == 'OK'


def test_deadline_does_not_commit_late_result_or_claim_stopped():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=1)
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def slow(_request):
        entered.set()
        assert release.wait(2)
        finished.set()
        return 'late-value'

    future = scheduler.submit(envelope(), slow)
    assert entered.wait(1)
    with pytest.raises(DeadlineExceeded) as deadline:
        future.result(timeout=0.02)
    assert deadline.value.error.code == 'DEADLINE_EXCEEDED'
    assert deadline.value.error.details['underlying_running'] is True
    release.set()
    assert finished.wait(1)
    result = registry.result(future.task_id)
    assert result.status == TaskStatus.TIMED_OUT and result.value is None
    assert scheduler.close()['status'] == 'OK'


def test_close_cancels_queued_drains_and_rejects_new_work():
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=False, worker_count=1)
    entered = threading.Event()
    release = threading.Event()

    def blocking(_request):
        entered.set()
        assert release.wait(2)

    scheduler.submit(envelope(), blocking)
    assert entered.wait(1)
    queued = scheduler.submit(envelope(), lambda _request: None)
    release.set()
    report = scheduler.close(drain_timeout=2)
    assert report['status'] == 'OK' and report['drained'] is True
    assert registry.result(queued.task_id).status == TaskStatus.CANCELLED
    rejected = scheduler.submit(envelope(), lambda _request: None)
    with pytest.raises(TaskFailure) as failure:
        rejected.result()
    assert failure.value.error.code == 'SCHEDULER_CLOSED'


def test_history_dir_get_inline_api_return_guard_and_thread_evidence(fresh_home):
    api = Api()
    direct = api._config.history_dir_get()
    api._config.history_dir_get = mock.Mock(wraps=api._config.history_dir_get)
    api._guard.enforce_exec_ex = mock.Mock()
    before = threading.active_count()
    actual = api.history_dir_get()
    after = threading.active_count()
    assert actual == ok(direct)
    assert json.loads(actual) == json.loads(ok(direct))
    assert after == before
    api._config.history_dir_get.assert_called_once_with()
    api._guard.enforce_exec_ex.assert_not_called()
    assert api._scheduler.inline is True
    assert api._scheduler.metrics()['workers'] == 0
    assert api._scheduler is api._container.scheduler
    assert api._registry is api._container.task_registry
