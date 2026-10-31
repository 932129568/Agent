# -*- coding: utf-8 -*-
"""Windows frozen-build dependency regression: pywebview must exist before packaging."""
import ast
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / 'Harbor.spec'
REQUIREMENTS = ROOT / 'requirements-win.txt'
CHECKER = ROOT / 'tools' / 'check_build_dependencies.py'
BUILD_SETUP = ROOT / 'installer' / 'build_setup.py'
ISOLATED_PYTHON = ROOT / 'outputs' / 'release-w9-candidate' / 'venv' / 'Scripts' / 'python.exe'


def load_checker():
    spec = importlib.util.spec_from_file_location('harbor_check_build_dependencies', CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_build_setup():
    spec = importlib.util.spec_from_file_location('harbor_build_setup', BUILD_SETUP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_requirements():
    pins = {}
    for line in REQUIREMENTS.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, version = line.split('==', 1)
        pins[name] = version
    return pins


def test_spec_explicitly_collects_pywebview_windows_backends():
    tree = ast.parse(SPEC.read_text(encoding='utf-8'))
    hidden = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'Analysis':
            for keyword in node.keywords:
                if keyword.arg == 'hiddenimports':
                    hidden = ast.literal_eval(keyword.value)
                    break
    assert hidden is not None
    for name in ('webview', 'webview.platforms.edgechromium', 'webview.platforms.winforms',
                 'pythonnet', 'clr', 'clr_loader', 'cffi', '_cffi_backend',
                 'send2trash', 'PIL.ImageGrab'):
        assert name in hidden, name


def test_requirements_pin_pywebview_and_frozen_runtime_dependencies():
    pins = read_requirements()
    assert pins['pywebview'] == '5.4'
    assert pins['pythonnet'] == '3.2.1'
    assert pins['PyInstaller'] == '6.22.3'
    assert pins['pyinstaller-hooks-contrib'] == '2026.9'
    assert pins['Pillow'] == '13.0.0'
    assert pins['send2trash'] == '2.1.0'
    for name in ('bottle', 'proxy_tools', 'typing_extensions'):
        assert name in pins
    assert not any(name.lower() in {'react', 'pytest', 'numpy'} for name in pins)


def test_dependency_checker_reports_missing_and_mismatched_webview():
    checker = load_checker()
    missing = checker.collect_issues(finder=lambda name: None if name == 'webview' else object(),
                                     version_reader=lambda name: checker.REQUIRED_DISTRIBUTIONS[name])
    assert missing['ok'] is False
    assert 'webview' in missing['missing_modules']

    def version_reader(name):
        return '0.0' if name == 'pywebview' else checker.REQUIRED_DISTRIBUTIONS[name]

    mismatched = checker.collect_issues(finder=lambda name: object(), version_reader=version_reader)
    assert mismatched['ok'] is False
    assert any(item['name'] == 'pywebview' and item['actual'] == '0.0'
               for item in mismatched['mismatched_distributions'])


def test_build_setup_runs_dependency_gate_before_pyinstaller(monkeypatch):
    module = load_build_setup()
    calls = []
    monkeypatch.setattr(module.subprocess, 'run',
                        lambda command, **kwargs: calls.append(command) or SimpleNamespace(returncode=0))
    module.check_build_dependencies()
    assert calls and calls[0][1] == module.CHECK_DEPS
    monkeypatch.setattr(module.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(returncode=1))
    with pytest.raises(SystemExit) as error:
        module.check_build_dependencies()
    assert error.value.code == 1


@pytest.mark.skipif(not ISOLATED_PYTHON.is_file(), reason='isolated Windows build venv is unavailable')
def test_isolated_build_environment_has_complete_pywebview_runtime():
    result = subprocess.run([str(ISOLATED_PYTHON), str(CHECKER)], cwd=ROOT,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report['ok'] is True
    assert report['missing_modules'] == []
    assert report['missing_distributions'] == []
    assert report['mismatched_distributions'] == []
