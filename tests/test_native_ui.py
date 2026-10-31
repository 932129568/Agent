# -*- coding: utf-8 -*-
"""W3B native dispatcher thread, quarantine and cleanup behavior tests."""
from concurrent.futures import ThreadPoolExecutor
import ctypes
import threading
import time
import types

import pytest

from backend.application.native_ui import (
    NativeUiDispatcher, NativeUiError, NativeUiTimeout)
from backend.domains.integrations.browser.driver import DriverWindow
from backend.domains.integrations.browser.session_win import SearchBrowser


class FakeWindow:
    def __init__(self):
        self.native = types.SimpleNamespace(Handle=4567)
        self.destroyed = False
        self.loaded = []
        self.evaluate_calls = []
        self.block = None
        self.finished = None
        self.error = None
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def evaluate_js(self, code):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        self.evaluate_calls.append(code)
        try:
            if self.block is not None:
                assert self.block.wait(2)
                if self.finished is not None:
                    self.finished.set()
            if self.error is not None:
                raise self.error
            return 'value:' + code
        finally:
            with self._lock:
                self.active -= 1

    def load_url(self, url):
        self.loaded.append(url)
        return url

    def destroy(self):
        self.destroyed = True


class FakeBeginInvoke:
    """Single UI-thread fake recording submit/execute/return thread identities."""

    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='fake-ui')
        self.calls = []
        self.submit_threads = []
        self.execution_threads = []

    def __call__(self, callback):
        self.calls.append(callback)
        self.submit_threads.append(threading.get_ident())
        self.executor.submit(callback)
        return None

    def close(self):
        self.executor.shutdown(wait=True)


def test_begin_invoke_create_evaluate_and_thread_evidence():
    dispatcher = NativeUiDispatcher()
    adapter = FakeBeginInvoke()
    caller = threading.get_ident()
    window = dispatcher.bootstrap_create('main', FakeWindow, adapter=adapter)
    assert dispatcher.evaluate(window, 'document.title') == 'value:document.title'
    evidence = dispatcher.thread_evidence(window)
    assert evidence['created_thread'] == caller
    assert evidence['execution_thread'] != caller
    assert evidence['return_thread'] == caller
    assert evidence['adapter_calls'] == 1
    assert adapter.submit_threads == [caller]
    adapter.close()


def test_same_window_calls_are_serialized_not_only_js_lock():
    dispatcher = NativeUiDispatcher()
    adapter = FakeBeginInvoke()
    window = dispatcher.bootstrap_create('main', FakeWindow, adapter=adapter)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda index: dispatcher.evaluate(window, 'call-%d' % index), range(4)))
    assert window.max_active == 1
    assert len(window.evaluate_calls) == 4
    assert dispatcher.thread_evidence(window)['adapter_calls'] == 4
    adapter.close()


def test_evaluate_exception_keeps_error_channel():
    dispatcher = NativeUiDispatcher.inline()
    window = FakeWindow()
    dispatcher.register(window, 'main', lambda callback: callback())
    window.error = ValueError('bad-js')
    with pytest.raises(NativeUiError) as error:
        dispatcher.evaluate(window, 'bad()')
    assert error.value.code == 'NATIVE_UI_ERROR'
    assert error.value.stage == 'evaluate'


def test_timeout_quarantine_rejects_new_calls_and_destroy_waits_final_return():
    dispatcher = NativeUiDispatcher()
    adapter = FakeBeginInvoke()
    window = FakeWindow()
    dispatcher.register(window, 'main', adapter=adapter)
    window.block = threading.Event()
    window.finished = threading.Event()
    with pytest.raises(NativeUiTimeout) as timeout:
        dispatcher.evaluate(window, 'hang()', timeout=0.02)
    assert timeout.value.zombie is True
    assert dispatcher.thread_evidence(window)['quarantined'] is True
    before = dispatcher.thread_evidence(window)['adapter_calls']
    with pytest.raises(NativeUiError) as rejected:
        dispatcher.evaluate(window, 'new-call()')
    assert rejected.value.code == 'NATIVE_UI_QUARANTINED'
    assert dispatcher.thread_evidence(window)['adapter_calls'] == before
    with pytest.raises(NativeUiTimeout):
        dispatcher.destroy(window, timeout=0.02)
    assert window.destroyed is False
    window.block.set()
    assert window.finished.wait(1)
    dispatcher.destroy(window)
    assert window.destroyed is True
    assert dispatcher.thread_evidence(window)['closed'] is True
    adapter.close()


def test_close_release_and_shutdown_bounded_drain():
    dispatcher = NativeUiDispatcher()
    adapter = FakeBeginInvoke()
    window = FakeWindow()
    dispatcher.register(window, 'main', adapter=adapter)
    window.block = threading.Event()
    window.finished = threading.Event()
    with pytest.raises(NativeUiTimeout):
        dispatcher.evaluate(window, 'hang()', timeout=0.01)
    report = dispatcher.shutdown(drain_timeout=0.02)
    assert report['status'] == 'TIMEOUT' and report['drained'] is False
    assert report['errors'][0]['zombie'] is True
    window.block.set()
    assert window.finished.wait(1)
    assert dispatcher.shutdown(drain_timeout=1)['status'] == 'OK'
    assert window.destroyed is True
    adapter.close()


def test_driver_and_search_use_dispatcher_without_per_eval_thread():
    dispatcher = NativeUiDispatcher()
    adapter = FakeBeginInvoke()
    window = FakeWindow()
    dispatcher.register(window, 'main', adapter=adapter)
    driver = DriverWindow(dispatcher=dispatcher)
    driver._win = window
    assert driver.eval_js('x') == 'value:x'
    assert threading.active_count() >= 1
    search = SearchBrowser(dispatcher=dispatcher, idle_recycle=False)
    search.set_window(window)
    assert search._read_dom(window) == 'value:document.documentElement.outerHTML'
    window.block = threading.Event()
    assert driver.eval_js('hang', timeout=0.01) is None
    assert driver._pumpable is False
    assert driver.eval_js('later') is None
    window.block.set()
    adapter.close()


def test_no_gui_unavailable_is_explicit_and_does_not_crash():
    dispatcher = NativeUiDispatcher()
    with pytest.raises(NativeUiError) as error:
        dispatcher.create('main', FakeWindow)
    assert error.value.code == 'NATIVE_UI_UNAVAILABLE'
    driver = DriverWindow(dispatcher=dispatcher)
    driver._win = FakeWindow()
    assert driver.eval_js('x') is None
    search = SearchBrowser(dispatcher=dispatcher, idle_recycle=False)
    search.set_window(FakeWindow())
    assert search._read_dom(search.window) is None


def test_redraw_uses_dispatcher_and_main_closing_has_no_direct_destroy():
    dispatcher = NativeUiDispatcher.inline()
    window = FakeWindow()
    dispatcher.register(window, 'main', lambda callback: callback())
    calls = []
    original = ctypes.windll
    ctypes.windll = types.SimpleNamespace(user32=types.SimpleNamespace(
        RedrawWindow=lambda hwnd, a, b, flags: calls.append((hwnd.value, flags)) or 1))
    try:
        assert dispatcher.redraw(window, 0x185) is True
    finally:
        ctypes.windll = original
    assert calls and calls[0][0] == 4567
    from pathlib import Path
    source = (Path(__file__).resolve().parent.parent / 'main.py').read_text(encoding='utf-8')
    assert 'api._native_ui.destroy(w)' in source
    assert 'w.destroy()' not in source
    assert 'bootstrap_create' in source and "'main', lambda: webview.create_window" in source
