# -*- coding: utf-8 -*-
"""Bounded admission and execution with production-safe inline=1 default."""
from contextlib import ExitStack
import itertools
import queue
import threading
import time

from .task import TaskResult, TaskStatus


class DomainScheduler:
    """Schedule per-domain executors without owning task history or business data."""

    def __init__(self, registry, inline=True, worker_count=1,
                 max_queue=32, max_queue_bytes=4 * 1024 * 1024):
        if inline and worker_count != 1:
            raise ValueError('inline production mode is fixed at one caller thread')
        if worker_count < 1 or max_queue < 1 or max_queue_bytes < 1:
            raise ValueError('invalid scheduler limits')
        self.registry = registry
        self.inline = inline
        self.worker_count = worker_count
        self.max_queue = max_queue
        self.max_queue_bytes = max_queue_bytes
        self._queue = queue.Queue()
        self._pending_bytes = 0
        self._counter = itertools.count()
        self._factories = {}
        self._instances = {}
        self._resource_locks = {}
        self._workers = []
        self._closing = False
        self._lock = threading.RLock()

    def register_domain(self, domain, factory):
        """Register a lazy executor factory; no domain instance is built here."""
        with self._lock:
            self._factories[domain] = factory

    def _domain_executor(self, domain):
        with self._lock:
            if domain in self._instances:
                return self._instances[domain]
            factory = self._factories.get(domain)
        if factory is None:
            raise ValueError('unregistered domain executor: %s' % domain)
        instance = factory()
        with self._lock:
            return self._instances.setdefault(domain, instance)

    def _ensure_workers(self):
        if self.inline:
            return
        with self._lock:
            if self._workers:
                return
            for index in range(self.worker_count):
                worker = threading.Thread(
                    target=self._worker_loop, name='harbor-domain-%d' % index, daemon=True)
                self._workers.append(worker)
                worker.start()

    def submit(self, envelope, executor=None):
        """Return a TaskFuture; inline mode finishes on the caller thread."""
        future = self.registry.register(envelope)
        with self._lock:
            if self._closing:
                self.registry.reject(envelope.taskId, 'SCHEDULER_CLOSED',
                                     '调度器已停止准入')
                return future
            if not self.inline:
                if self._queue.qsize() >= self.max_queue:
                    self.registry.reject(
                        envelope.taskId, 'SCHEDULER_BUSY', '领域队列已满', True,
                        {'domain': envelope.domain, 'queueMs': 0})
                    return future
                if self._pending_bytes + envelope.payloadBytes > self.max_queue_bytes:
                    self.registry.reject(
                        envelope.taskId, 'QUEUE_BYTES_EXCEEDED', '领域队列字节上限已满', False,
                        {'domain': envelope.domain, 'payloadBytes': envelope.payloadBytes})
                    return future
                self._pending_bytes += envelope.payloadBytes
                self._queue.put((next(self._counter), envelope, executor))
        if self.inline:
            self._execute(envelope, executor)
        else:
            self._ensure_workers()
        return future

    def _worker_loop(self):
        while True:
            item = self._queue.get()
            if item is None:
                return
            _sequence, envelope, executor = item
            with self._lock:
                self._pending_bytes -= envelope.payloadBytes
            self._execute(envelope, executor)

    def _execute(self, envelope, executor):
        if not self.registry.start(envelope.taskId):
            return
        started = time.perf_counter()
        try:
            callable_executor = executor or self._domain_executor(envelope.domain)
            with ExitStack() as stack:
                for key in envelope.resourceKeys:
                    with self._lock:
                        lock = self._resource_locks.setdefault(key, threading.RLock())
                    stack.enter_context(lock)
                if (envelope.expectedRevision is not None and envelope.submitRevision is not None and
                        envelope.expectedRevision != envelope.submitRevision):
                    raise ValueError('REVISION_STALE')
                if callable(executor):
                    value = executor(envelope)
                elif callable(callable_executor) and not hasattr(callable_executor, envelope.operation):
                    value = callable_executor(envelope)
                else:
                    value = getattr(callable_executor, envelope.operation)()
            status = TaskStatus.CANCELLED if envelope.cancelToken.is_set() else TaskStatus.SUCCEEDED
            result = TaskResult(envelope.taskId, status, value=value,
                                metrics={'runMs': (time.perf_counter() - started) * 1000.0})
            if status == TaskStatus.CANCELLED:
                from .task import TaskError
                result.value = None
                result.error = TaskError('CANCELLED', '任务经协作令牌取消', False,
                                         {'domain': envelope.domain, 'stage': TaskStatus.RUNNING})
            self.registry.complete(envelope.taskId, result)
        except Exception as error:
            from .task import TaskError
            cancelled = envelope.cancelToken.is_set()
            result = TaskResult(
                envelope.taskId, TaskStatus.CANCELLED if cancelled else TaskStatus.FAILED,
                error=TaskError('CANCELLED' if cancelled else 'EXECUTION_FAILED',
                                '任务经协作令牌取消' if cancelled else str(error), False,
                                {'domain': envelope.domain, 'stage': TaskStatus.RUNNING,
                                 'exception': type(error).__name__}),
                metrics={'runMs': (time.perf_counter() - started) * 1000.0})
            self.registry.complete(envelope.taskId, result)

    def metrics(self):
        with self._lock:
            snapshot = {'inline': self.inline, 'workers': len(self._workers),
                        'queue_bytes': self._pending_bytes,
                        'closing': self._closing}
        snapshot.update(self.registry.metrics())
        return snapshot

    def close(self, drain_timeout=5.0):
        """Stop admission, cancel queued work and bounded-drain active workers."""
        with self._lock:
            if self._closing and not self._workers:
                return {'status': 'OK', 'drained': True, 'workers': 0}
            self._closing = True
            queued = list(self._queue.queue)
            workers = list(self._workers)
        for _sequence, envelope, _executor in queued:
            self.registry.cancel(envelope.taskId)
        if not self.inline:
            for _worker in workers:
                self._queue.put(None)
        deadline = time.monotonic() + drain_timeout
        for worker in workers:
            worker.join(max(0.0, deadline - time.monotonic()))
        alive = [worker.name for worker in workers if worker.is_alive()]
        metrics = self.metrics()
        metrics.update({'status': 'OK' if not alive else 'TIMEOUT',
                        'drained': not alive, 'workers': len(workers),
                        'underlying_running': alive})
        return metrics
