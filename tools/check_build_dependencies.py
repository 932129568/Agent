# -*- coding: utf-8 -*-
"""Fail before PyInstaller if Harbor's Windows frozen-build dependencies are incomplete."""
import importlib.metadata
import importlib.util
import json
import sys

REQUIRED_MODULES = (
    'webview',
    'webview.platforms.edgechromium',
    'webview.platforms.winforms',
    'pythonnet',
    'clr',
    'clr_loader',
    'cffi',
    '_cffi_backend',
    'send2trash',
    'PIL.ImageGrab',
    'bottle',
    'proxy_tools',
    'typing_extensions',
)
REQUIRED_DISTRIBUTIONS = {
    'pywebview': '5.4',
    'pythonnet': '3.2.1',
    'clr_loader': '0.3.1',
    'cffi': '2.1.1',
    'bottle': '0.13.4',
    'proxy_tools': '0.1.0',
    'typing_extensions': '4.16.0',
    'Pillow': '13.0.0',
    'send2trash': '2.1.0',
    'PyInstaller': '6.22.3',
    'pyinstaller-hooks-contrib': '2026.9',
}


def collect_issues(finder=importlib.util.find_spec, version_reader=importlib.metadata.version):
    """Return missing modules, distributions, and pinned-version mismatches."""
    missing_modules = []
    for name in REQUIRED_MODULES:
        try:
            found = finder(name)
        except (ImportError, ModuleNotFoundError, AttributeError, ValueError):
            found = None
        if found is None:
            missing_modules.append(name)
    missing_distributions = []
    mismatched_distributions = []
    for name, expected in REQUIRED_DISTRIBUTIONS.items():
        try:
            actual = version_reader(name)
        except importlib.metadata.PackageNotFoundError:
            missing_distributions.append(name)
            continue
        if actual != expected:
            mismatched_distributions.append({'name': name, 'expected': expected, 'actual': actual})
    return {
        'ok': not missing_modules and not missing_distributions and not mismatched_distributions,
        'missing_modules': missing_modules,
        'missing_distributions': missing_distributions,
        'mismatched_distributions': mismatched_distributions,
    }


def main():
    issues = collect_issues()
    print(json.dumps(issues, ensure_ascii=False, indent=2))
    if not issues['ok']:
        print('构建依赖不完整：请先按 requirements-win.txt 安装到隔离构建环境。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
