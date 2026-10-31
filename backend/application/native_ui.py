# -*- coding: utf-8 -*-
"""Window-affine native UI dispatch with truthful timeout/quarantine semantics."""
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
import threading
import time


class NativeUiError(Exception):
    def __init__(self, code, message, stage='invoke', zombie=False, retryable=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.stage = stage
        self.zombie = zombie
        self.retryable = retryable


class NativeUiTimeout(NativeUiError):
    def __init__(self, stage, timeout):
        super().__init__('NATIVE_UI_TIMEOUT',
                         '原生 UI 调用超过 %.3fs；底层可能仍在执行' % timeout,
                         stage=stage, zombie=True)


@dataclass
class _WindowEntry:
    window: object
    key: str
    adapter: object
    bootstrap: bool
    created_thread: int
    lock: object = field(default_factory=threading.RLock)
    active: object = field(default_factory=threading.Event)
    quarantined: bool = False
    closed: bool = False
    last_execution_thread: int = None
    last_return_thread: int = None
    adapter_calls: int = 0
    history: list = field(default_factory=list)


class NativeUiDispatcher:
    """Serialize each window through its registered UI adapter, never its workers."""

    def __init__(self):
        self._windows = {}
        self._default_adapter = None
        self._owner_thread = threading.get_ident()
        self._closing = False
        self._lock = threading.RLock()

    @classmethod
    def inline(cls):
        """Explicit fake adapter for tests only; production must register BeginInvoke."""
        dispatcher = cls()
        dispatcher._default_adapter = lambda callback: callback()
        return dispatcher

    @staticmethod
    def begin_invoke_adapter(window):
        """Build a lazy WinForms BeginInvoke adapter for one pywebview window."""
        state = {'ui_thread': None}

        def dispatch(callback):
            if state['ui_thread'] == threading.get_ident():
                return callback()
            form = getattr(window, 'native', None)
            if form is None or not hasattr(form, 'BeginInvoke'):
                raise NativeUiError('NATIVE_UI_UNAVAILABLE', '窗口 UI adapter 尚未就绪')
            from System import Action

            def ui_callback():
                state['ui_thread'] = threading.get_ident()
                callback()

            form.BeginInvoke(Action(ui_callback))
        return dispatch

    def register(self, window, key=None, adapter=None, bootstrap=False):
        if window is None:
            raise NativeUiError('NATIVE_UI_UNAVAILABLE', '不能注册空窗口')
        key = str(key or 'window:%d' % id(window))
        adapter = adapter or self._default_adapter or self.begin_invoke_adapter(window)
        with self._lock:
            entry = _WindowEntry(window, key, adapter, bootstrap, threading.get_ident())
            self._windows[id(window)] = entry
            if adapter is not None and (bootstrap or self._default_adapter is None):
                self._default_adapter = adapter
            return entry

    def bootstrap_create(self, key, factory, adapter=None):
        """Create on the existing startup thread; never start a GUI worker."""
        if threading.get_ident() != self._owner_thread:
            raise NativeUiError('NATIVE_UI_THREAD_VIOLATION', 'bootstrap 必须在线程 owner 上执行')
        window = factory()
        self.register(window, key, adapter, bootstrap=True)
        return window

    def create(self, key, factory, adapter=None, timeout=60.0):
        """Create through the registered UI adapter and register the resulting window."""
        adapter = adapter or self._default_adapter
        if adapter is None:
            raise NativeUiError('NATIVE_UI_UNAVAILABLE', '没有可用窗口创建 adapter', stage='create')
        window = self._dispatch_adapter(adapter, factory, timeout, 'create')
        self.register(window, key, adapter)
        return window

    def _entry(self, window):
        entry = self._windows.get(id(window))
        if entry is None:
            raise NativeUiError('NATIVE_UI_UNAVAILABLE', '窗口未注册 dispatcher')
        return entry

    @staticmethod
    def _dispatch_adapter(adapter, function, timeout, stage):
        future = Future()

        def callback():
            try:
                future.set_result(function())
            except Exception as error:
                future.set_exception(error)

        adapter(callback)
        try:
            return future.result(timeout=timeout)
        except FutureTimeout as error:
            raise NativeUiTimeout(stage, timeout) from error

    def invoke(self, window, function, timeout=6.0, stage='invoke', allow_quarantined=False):
        entry = self._entry(window)
        with entry.lock:
            if self._closing and stage != 'destroy':
                raise NativeUiError('SCHEDULER_CLOSED', 'native dispatcher 已关闭', stage)
            if entry.closed:
                raise NativeUiError('NATIVE_UI_CLOSED', '窗口已关闭', stage)
            if entry.quarantined and not allow_quarantined:
                raise NativeUiError('NATIVE_UI_QUARANTINED', '窗口已隔离，拒绝新调用', stage,
                                    zombie=True)
            entry.adapter_calls += 1
            entry.active.set()
            future = Future()

            def callback():
                entry.last_execution_thread = threading.get_ident()
                try:
                    future.set_result(function())
                except Exception as error:
                    future.set_exception(error)
                finally:
                    entry.active.clear()

            try:
                try:
                    entry.adapter(callback)
                except Exception:
                    entry.active.clear()
                    raise
                result = future.result(timeout=timeout)
                entry.last_return_thread = threading.get_ident()
                entry.history.append((stage, entry.created_thread,
                                      entry.last_execution_thread, entry.last_return_thread))
                return result
            except FutureTimeout as error:
                self.quarantine(window)
                raise NativeUiTimeout(stage, timeout) from error
            except NativeUiError:
                raise
            except Exception as error:
                raise NativeUiError('NATIVE_UI_ERROR', str(error), stage) from error

    def evaluate(self, window, code, timeout=6.0):
        return self.invoke(window, lambda: window.evaluate_js(code), timeout, 'evaluate')

    def quarantine(self, window):
        entry = self._entry(window)
        with entry.lock:
            entry.quarantined = True
            entry.history.append(('quarantine', entry.created_thread,
                                  threading.get_ident(), None))

    def destroy(self, window, timeout=5.0):
        """Wait for the final UI call before ordered cleanup; never kill a zombie."""
        entry = self._entry(window)
        deadline = time.monotonic() + timeout
        while entry.active.is_set():
            if time.monotonic() >= deadline:
                raise NativeUiTimeout('destroy', timeout)
            time.sleep(min(0.005, max(0.0, deadline - time.monotonic())))
        result = self.invoke(window, window.destroy, timeout, 'destroy', allow_quarantined=True)
        with entry.lock:
            entry.closed = True
        return result

    def redraw(self, window, flags, timeout=2.0):
        def redraw_ui():
            import ctypes
            native = getattr(window, 'native', None)
            hwnd = getattr(native, 'Handle', None) if native is not None else None
            if not hwnd:
                raise NativeUiError('NATIVE_UI_UNAVAILABLE', 'window-not-ready', 'redraw')
            ctypes.windll.user32.RedrawWindow(
                ctypes.c_void_p(int(hwnd)), None, None, flags)
            return True
        return self.invoke(window, redraw_ui, timeout, 'redraw')

    def thread_evidence(self, window):
        entry = self._entry(window)
        return {
            'created_thread': entry.created_thread,
            'execution_thread': entry.last_execution_thread,
            'return_thread': entry.last_return_thread,
            'adapter_calls': entry.adapter_calls,
            'quarantined': entry.quarantined,
            'closed': entry.closed,
            'history': list(entry.history),
        }

    def shutdown(self, drain_timeout=5.0):
        """Stop admission and clean each registered window within a bounded budget."""
        self._closing = True
        deadline = time.monotonic() + drain_timeout
        errors = []
        with self._lock:
            entries = list(self._windows.values())
        for entry in entries:
            if entry.closed:
                continue
            try:
                self.destroy(entry.window, max(0.001, deadline - time.monotonic()))
            except NativeUiError as error:
                errors.append({'windowId': entry.key, 'code': error.code,
                               'zombie': error.zombie})
        return {'status': 'OK' if not errors else 'TIMEOUT',
                'drained': not errors, 'errors': errors}
