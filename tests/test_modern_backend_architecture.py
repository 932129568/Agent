# -*- coding: utf-8 -*-
"""W2 domain migration, single-container and application-coordinator tests."""
import ast
import importlib
import json
from pathlib import Path
import threading
from unittest import mock

import pytest

from conftest import fresh_home  # noqa: F401,E402  (isolated persistent paths)
from backend.api import Api
from backend.application.operation import (
    OperationCoordinator, OperationDenied, OperationRequest)
from backend.application.session import SessionCoordinator
from backend.bootstrap.container import ServiceContainer
from tools.check_static_paths import find_legacy_references

ROOT = Path(__file__).resolve().parent.parent


class RuntimeStub:
    def __init__(self):
        self.sid = None

    def get_current_sid(self):
        return self.sid

    def set_current_sid(self, sid):
        self.sid = sid or None
        return self.sid


class GuardStub:
    def __init__(self, decision=(None, None)):
        self.decision = decision
        self.audit_calls = []
        self.enforce_calls = []

    def enforce_exec_ex(self, op, detail, token):
        self.enforce_calls.append((op, detail, token))
        return self.decision

    def audit(self, *args):
        self.audit_calls.append(args)
        return '{"ok":true}'


def test_browser_entry_executes_real_new_domain_through_operation(fresh_home):
    api = Api()
    driver = api._container.driver
    assert type(driver).__module__ == 'backend.domains.integrations.browser.driver'
    api._guard.enforce_exec_ex = mock.Mock(return_value=(None, None))
    driver.navigate = mock.Mock(return_value={'ok': True, 'session_id': 'brw-test'})
    result = json.loads(api.browser_navigate(
        'https://example.invalid', wait_selector='#main', timeout=12, mode='hidden', token='t'))
    assert result['ok'] is True and result['session_id'] == 'brw-test'
    driver.navigate.assert_called_once_with('https://example.invalid', '#main', 12, 'hidden')
    api._guard.enforce_exec_ex.assert_called_once_with(
        'browser_navigate', {'url': 'https://example.invalid'}, 't')


def test_browser_denial_has_zero_domain_executor_calls(fresh_home):
    api = Api()
    api._guard.enforce_exec_ex = mock.Mock(return_value=('需要确认', None))
    api._guard.audit = mock.Mock(return_value='{"ok":true}')
    api._driver.navigate = mock.Mock()
    result = json.loads(api.browser_navigate('https://example.invalid'))
    assert result['ok'] is False and result['error']['code'] == 'CONFIRM_REQUIRED'
    api._driver.navigate.assert_not_called()
    api._guard.audit.assert_called_once_with(
        'browser_navigate', {'url': 'https://example.invalid'}, 'block', '需要确认')


def test_session_switch_clears_two_trust_stores_and_rotates_trace():
    runtime = RuntimeStub()
    guard = mock.Mock()
    mcp = mock.Mock()
    coordinator = SessionCoordinator(runtime, guard, mcp)
    first_trace = coordinator.current_trace()
    assert coordinator.set_current_sid('session-a') == 'session-a'
    guard.clear_session_trust.assert_called_once_with()
    mcp.clear_session_trust.assert_called_once_with()
    assert coordinator.current_trace() != first_trace
    coordinator.set_current_sid('session-a')
    guard.clear_session_trust.assert_called_once_with()
    mcp.clear_session_trust.assert_called_once_with()
    before = coordinator.current_trace()
    rotated = coordinator.trace_new()
    assert rotated != before
    assert coordinator.current_trace() == rotated


def test_operation_token_one_flight_and_executor_error_releases_key():
    runtime = RuntimeStub()
    guard = GuardStub()
    coordinator = OperationCoordinator(runtime, guard)
    request = OperationRequest('run_command', {'cmd': 'x'}, token='once', sid='s')
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def blocking_executor():
        calls.append('execute')
        entered.set()
        assert release.wait(2)
        return 'done'

    thread = threading.Thread(
        target=lambda: coordinator.execute(request, blocking_executor, one_flight=True))
    thread.start()
    assert entered.wait(2)
    with pytest.raises(OperationDenied, match='正在执行'):
        coordinator.execute(request, lambda: calls.append('duplicate'), one_flight=True)
    assert calls == ['execute']
    release.set()
    thread.join(2)
    assert not thread.is_alive()

    def failing_executor():
        raise RuntimeError('executor-failure')

    with pytest.raises(RuntimeError, match='executor-failure'):
        coordinator.execute(request, failing_executor, one_flight=True)
    assert coordinator.execute(request, lambda: 'retry-ok', one_flight=True) == 'retry-ok'


def test_operation_guard_error_is_audited_without_execution():
    coordinator = OperationCoordinator(RuntimeStub(), GuardStub(('denied', None)))
    executor = mock.Mock()
    with pytest.raises(OperationDenied) as denied:
        coordinator.execute(OperationRequest('delete_path', {'path': 'x'}), executor)
    assert denied.value.reason == 'denied'
    executor.assert_not_called()
    assert coordinator._guard.audit_calls == [
        ('delete_path', {'path': 'x'}, 'block', 'backend-enforced')]


def test_single_container_inventory_and_alias_identity(fresh_home):
    api = Api()
    container = api._container
    assert isinstance(container, ServiceContainer)
    registry = container.registry()
    assert set(registry) == set(ServiceContainer.SERVICE_NAMES)
    assert container.plans._checkpoint is container.checkpoints
    assert container.mcp._guard is container.guard
    assert container.search._guard is container.guard
    for alias, name in ServiceContainer.API_ALIASES.items():
        assert getattr(api, alias) is registry[name]
    assert not (ROOT / 'backend' / 'bootstrap.py').exists()
    assert not list((ROOT / 'backend' / 'services').rglob('*.py'))


def test_old_service_import_is_rejected_and_backend_static_paths_clean():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module('backend.services.config_service')
    findings = find_legacy_references(ROOT)
    assert [row for row in findings if row['kind'] == 'backend-services'] == []


def test_relative_imports_resolve_and_domains_do_not_depend_upwards():
    violations = []
    for source in (ROOT / 'backend' / 'domains').rglob('*.py'):
        tree = ast.parse(source.read_text(encoding='utf-8'), filename=str(source))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.module and node.module.split('.')[0] in {'application', 'bootstrap', 'api'}:
                    violations.append((source, node.lineno, 'upward dependency'))
                if not node.level or not node.module:
                    continue
                package = list(source.parent.relative_to(ROOT).parts)
                up = node.level - 1
                base = package[:len(package) - up] + node.module.split('.')
                candidates = [ROOT.joinpath(*base).with_suffix('.py'),
                              ROOT.joinpath(*base, '__init__.py')]
                if not any(candidate.is_file() for candidate in candidates):
                    violations.append((source, node.lineno, '.'.join(base)))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith(('backend.application', 'backend.bootstrap', 'backend.api')):
                        violations.append((source, node.lineno, alias.name))
    assert violations == []
