# -*- coding: utf-8 -*-
"""Private scheduling values; these types never enter public js_api payloads."""
from dataclasses import dataclass, field
import threading
import time
import uuid


class TaskStatus:
    QUEUED = 'queued'
    RUNNING = 'running'
    SUCCEEDED = 'succeeded'
    FAILED = 'failed'
    CANCELLED = 'cancelled'
    TIMED_OUT = 'timed_out'
    PARTIAL = 'partial'


class CancellationToken:
    """Cooperative cancellation only; setting it never claims executor termination."""

    def __init__(self):
        self._event = threading.Event()

    def set(self):
        self._event.set()

    def is_set(self):
        return self._event.is_set()


@dataclass(frozen=True)
class TaskError:
    code: str
    message: str
    retryable: bool = False
    details: dict = field(default_factory=dict)


@dataclass
class TaskEnvelope:
    taskId: str
    domain: str
    operation: str
    resourceKeys: tuple
    sessionId: str
    runId: str
    generation: int
    deadlineAtMonotonic: float
    cancelToken: CancellationToken
    payloadBytes: int
    expectedRevision: object
    createdAt: float
    queueAt: float
    startAt: float = None
    endAt: float = None
    metrics: dict = field(default_factory=dict)
    operationId: str = ''
    dependsOn: tuple = ()
    submitRevision: object = None
    attempt: int = 0
    idempotencyKey: str = ''
    dedupeKey: str = ''

    @classmethod
    def create(cls, domain, operation, resourceKeys=(), sessionId='', runId='',
               generation=0, timeout_ms=10000, payloadBytes=0,
               expectedRevision=None, operationId='', dependsOn=(), **kwargs):
        if not domain or not operation:
            raise ValueError('domain and operation are required')
        if timeout_ms <= 0:
            raise ValueError('timeout_ms must be positive')
        if payloadBytes < 0:
            raise ValueError('payloadBytes cannot be negative')
        now = time.time()
        return cls(
            taskId='task_' + uuid.uuid4().hex,
            domain=str(domain), operation=str(operation),
            resourceKeys=tuple(sorted(set(str(key) for key in resourceKeys))),
            sessionId=str(sessionId or ''), runId=str(runId or ''),
            generation=int(generation),
            deadlineAtMonotonic=time.monotonic() + timeout_ms / 1000.0,
            cancelToken=CancellationToken(), payloadBytes=int(payloadBytes),
            expectedRevision=expectedRevision, createdAt=now, queueAt=now,
            operationId=str(operationId or ''), dependsOn=tuple(dependsOn), **kwargs)

    def remaining(self):
        return max(0.0, self.deadlineAtMonotonic - time.monotonic())


@dataclass
class TaskResult:
    taskId: str
    status: str
    value: object = None
    error: TaskError = None
    metrics: dict = field(default_factory=dict)


class TaskFailure(Exception):
    """Base boundary exception carrying a private TaskResult."""

    def __init__(self, result):
        self.result = result
        self.error = result.error
        super().__init__(result.error.message if result.error else result.status)


class TaskCancelled(TaskFailure):
    """The task reached a cancelled terminal state."""


class DeadlineExceeded(TaskFailure):
    """The caller deadline expired; underlying execution may still be running."""
