# -*- coding: utf-8 -*-
"""Domain-side native UI port and explicit no-GUI default, without upward imports."""


class NativePortError(Exception):
    def __init__(self, code, message, stage='invoke', zombie=False):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.zombie = zombie


class UnavailableDispatcher:
    """Fail closed when no dispatcher was explicitly injected by bootstrap/tests."""

    def create(self, *_args, **_kwargs):
        raise NativePortError('NATIVE_UI_UNAVAILABLE', '未注入 native dispatcher', 'create')

    def invoke(self, *_args, **_kwargs):
        raise NativePortError('NATIVE_UI_UNAVAILABLE', '未注入 native dispatcher')

    def evaluate(self, *_args, **_kwargs):
        raise NativePortError('NATIVE_UI_UNAVAILABLE', '未注入 native dispatcher', 'evaluate')

    def destroy(self, *_args, **_kwargs):
        raise NativePortError('NATIVE_UI_UNAVAILABLE', '未注入 native dispatcher', 'destroy')

    def register(self, *_args, **_kwargs):
        return None
