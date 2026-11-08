# -*- coding: utf-8 -*-
"""Single owner for task state, cancellation and queue/wait/throughput metrics."""
from collections import deque
from dataclasses import dataclass, field
import threading
import time

# R41 修复（N7）：终态记录容量淘汰——_records 原只增不删，长跑进程慢性泄漏。
# 队列/在飞记录永不淘汰；终态按完成序 FIFO 逐出（result() 对已逐出 id 的
# KeyError 语义与未知 id 一致，256 深归档足够回查窗口）。
_TERMINAL_KEEP = 256
_TERMINAL_STATUSES = frozenset({'succeeded', 'failed', 'cancelled', 'timed_out', 'partial'})

from .task import (
    DeadlineExceeded, TaskCancelled, TaskEnvelope, TaskError, TaskFailure,
    TaskResult, TaskStatus)


@dataclass
class _Record:
    envelope: TaskEnvelope
    event: threading.Event = field(default_factory=threading.Event)
    result: TaskResult = None
    running: bool = False


class TaskFuture:
    """Small synchronous Future facade over TaskRegistry terminal results."""

    def __init__(self, registry, task_id):
        self._registry = registry
        self.task_id = task_id

    def result(self, timeout=None):
        result = self._registry._wait(self.task_id, timeout)
        if result.status == TaskStatus.SUCCEEDED:
            return result.value
        if result.status == TaskStatus.CANCELLED:
            raise TaskCancelled(result)
        if result.status == TaskStatus.TIMED_OUT:
            raise DeadlineExceeded(result)
        raise TaskFailure(result)


class TaskRegistry:
    """Store only scheduling records; business state and revisions stay outside."""

    def __init__(self):
        self._records = {}
        self._terminal_order = deque()   # 终态 id 完成序（容量淘汰依据）
        self._submitted = 0              # 真实提交总数（淘汰不影响计数口径）
        self._lock = threading.RLock()
        self._created = time.time()
        self._completed = 0

    def _mark_terminal_locked(self, task_id):
        """终态迁移登记 + 容量淘汰（调用方持锁）。"""
        if task_id not in self._terminal_order:
            self._terminal_order.append(task_id)
        while len(self._terminal_order) > _TERMINAL_KEEP:
            self._records.pop(self._terminal_order.popleft(), None)

    def register(self, envelope):
        with self._lock:
            if envelope.taskId in self._records:
                raise ValueError('duplicate taskId: %s' % envelope.taskId)
            result = TaskResult(envelope.taskId, TaskStatus.QUEUED,
                                metrics=envelope.metrics.copy())
            self._records[envelope.taskId] = _Record(envelope, result=result)
            self._submitted += 1
            return TaskFuture(self, envelope.taskId)

    def result(self, task_id):
        with self._lock:
            return self._records[task_id].result

    def _wait(self, task_id, timeout):
        with self._lock:
            record = self._records[task_id]
            envelope = record.envelope
        wait_for = envelope.remaining() if timeout is None else max(0.0, timeout)
        if not record.event.wait(wait_for):
            self.deadline(task_id)
        return self.result(task_id)

    def start(self, task_id):
        with self._lock:
            record = self._records[task_id]
            if record.result.status != TaskStatus.QUEUED:
                return False
            if record.envelope.remaining() <= 0:
                pass
            else:
                record.running = True
                record.envelope.startAt = time.time()
                record.result.status = TaskStatus.RUNNING
                record.result.metrics['queueMs'] = (
                    record.envelope.startAt - record.envelope.queueAt) * 1000.0
                return True
        if record.envelope.remaining() <= 0:
            self.deadline(task_id)
        return False

    def complete(self, task_id, result):
        """Commit a terminal result only if not already timed out/cancelled."""
        with self._lock:
            record = self._records[task_id]
            record.running = False
            record.envelope.endAt = time.time()
            if record.result.status in (TaskStatus.TIMED_OUT, TaskStatus.CANCELLED):
                record.event.set()
                return False
            record.result = result
            record.envelope.metrics.update(result.metrics)
            self._completed += 1
            self._mark_terminal_locked(task_id)
            record.event.set()
            return True

    def reject(self, task_id, code, message, retryable=False, details=None):
        with self._lock:
            record = self._records[task_id]
            if record.result.status not in (TaskStatus.QUEUED, TaskStatus.RUNNING):
                return False
            record.running = False
            record.envelope.endAt = time.time()
            record.result.status = TaskStatus.FAILED
            record.result.error = TaskError(code, message, retryable, details or {})
            record.event.set()
            self._completed += 1
            self._mark_terminal_locked(task_id)
            return True

    def cancel(self, task_id):
        with self._lock:
            record = self._records[task_id]
            if record.result.status == TaskStatus.QUEUED:
                record.result.status = TaskStatus.CANCELLED
                record.result.error = TaskError(
                    'CANCELLED', '任务在队列中取消', False,
                    {'domain': record.envelope.domain, 'stage': TaskStatus.QUEUED})
                record.envelope.endAt = time.time()
                record.event.set()
                self._completed += 1
                self._mark_terminal_locked(task_id)
                return 'queued'
            if record.result.status == TaskStatus.RUNNING:
                record.envelope.cancelToken.set()
                return 'cooperative'
            return 'terminal'

    def deadline(self, task_id):
        with self._lock:
            record = self._records[task_id]
            if record.result.status not in (TaskStatus.QUEUED, TaskStatus.RUNNING):
                return self.result(task_id)
            stage = record.result.status
            record.result.status = TaskStatus.TIMED_OUT
            record.result.error = TaskError(
                'DEADLINE_EXCEEDED', '任务超过调用方 deadline', False,
                {'domain': record.envelope.domain, 'stage': stage,
                 'underlying_running': record.running})
            record.envelope.endAt = time.time()
            record.event.set()
            self._completed += 1
            self._mark_terminal_locked(task_id)
            return record.result

    def is_running(self, task_id):
        with self._lock:
            return self._records[task_id].running

    def queued_ids(self):
        with self._lock:
            return [task_id for task_id, record in self._records.items()
                    if record.result.status == TaskStatus.QUEUED]

    def metrics(self):
        with self._lock:
            records = list(self._records.values())
            elapsed = max(time.time() - self._created, 1e-9)
            waits = sum(max(0.0, (record.envelope.startAt or record.envelope.queueAt)
                            - record.envelope.queueAt)
                        for record in records if record.envelope.startAt is not None)
            return {
                'submitted': self._submitted, 'completed': self._completed,
                'queued': sum(record.result.status == TaskStatus.QUEUED for record in records),
                'running': sum(record.running for record in records),
                'wait_ms_total': waits * 1000.0,
                'tasks_per_s': self._completed / elapsed,
            }
