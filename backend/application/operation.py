# -*- coding: utf-8 -*-
"""Authorize-before-execute coordination for guarded domain operations."""
from dataclasses import dataclass, field
import threading


@dataclass(frozen=True)
class OperationRequest:
    """One private guarded invocation context; never exposed through js_api."""
    op: str
    detail: dict = field(default_factory=dict)
    token: str = None
    sid: str = ''
    trace_id: str = ''


@dataclass(frozen=True)
class GuardDecision:
    """Normalized domain decision while preserving the original reason payloads."""
    allowed: bool
    reason: object = None
    budget: object = None


class OperationDenied(Exception):
    """Raise after auditing a denied operation; executor has not been called."""

    def __init__(self, reason=None, budget=None):
        super().__init__(str(reason or budget or 'operation denied'))
        self.reason = reason
        self.budget = budget


class OperationCoordinator:
    """Apply Guard exactly before an executor and de-duplicate in-flight tokens."""

    def __init__(self, runtime, guard):
        self._runtime = runtime
        self._guard = guard
        self._inflight = set()
        self._lock = threading.RLock()

    def authorize(self, request):
        reason, budget = self._guard.enforce_exec_ex(
            request.op, request.detail, request.token)
        return GuardDecision(not reason and not budget, reason, budget)

    def audit(self, request, action, decision):
        return self._guard.audit(request.op, request.detail, action, decision)

    def execute(self, request, executor, rejection_reason='backend-enforced',
                one_flight=False):
        """Run one executor, or audit and raise OperationDenied with zero calls.

        Optional internal one-flight semantics never default into the public Api.
        Executor exceptions propagate unchanged and release an opted-in key.
        """
        key = None
        if one_flight and request.token:
            key = (request.op, request.sid or self._runtime.get_current_sid(),
                   request.token)
            with self._lock:
                if key in self._inflight:
                    self.audit(request, 'block', 'operation-in-flight')
                    raise OperationDenied(reason='相同授权操作正在执行')
                self._inflight.add(key)
        try:
            decision = self.authorize(request)
            if not decision.allowed:
                audit_reason = 'budget-exceeded' if decision.budget else (
                    rejection_reason if rejection_reason is not None else decision.reason)
                self.audit(request, 'block', audit_reason)
                raise OperationDenied(decision.reason, decision.budget)
            return executor()
        finally:
            if key is not None:
                with self._lock:
                    self._inflight.discard(key)
