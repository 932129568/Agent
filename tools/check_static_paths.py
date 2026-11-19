# -*- coding: utf-8 -*-
"""Inventory legacy source paths now; reject them with --strict after migration.

R70 / I16：`--strict` 不再是死参数。语义明确为——
  非 strict：legacy-flat-js / backend-services findings 只登记，不进 ok（rc=0）；
  strict  ：把这些 findings 一并纳入 ok，非空即 rc=1。
R70 / I17：扫描面扩为 8 目录；删除 2 条指向已删测试的死豁免；新增「已删除
契约层路径」正则（backend/api.py、backend/domains/*.py），只对运行时配置类
文件报错，避免把源码注释/正则字面误判为运行时依赖。
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN_FILES = ('README.md', 'main.py', 'Harbor.spec', 'Harbor-mac.spec')
# R70 / I17：原 5 目录 + electron / server / .github = 8 目录
SCAN_DIRS = ('backend', 'frontend', 'tests', 'tools', 'installer',
             'electron', 'server', '.github')
EXCLUDED_DIRS = {'.git', '.pytest_cache', '__pycache__', 'build', 'dist',
                 'node_modules', 'outputs', 'wave-backups'}
LEGACY_JS = re.compile(r'frontend[\\/]+src[\\/]+\d{2,3}-[A-Za-z0-9_-]+\.js')
BACKEND_SERVICES = re.compile(r'\bbackend[./\\]+services(?:[./\\]|$)')
# R70 / I17：已删除契约层路径（Py 实现已随 R69 退役），仅运行时配置类文件计入。
# domains 下允许多层包路径（backend/domains/settings/config_service.py 亦命中）。
DELETED_CONTRACT_PATH = re.compile(
    r'\bbackend[\\/]+api\.py|'
    r'\bbackend[\\/]+domains[\\/]+[A-Za-z0-9_\\/]+\.py')
# 运行时配置类：这些文件里残留 backend 路径才是真问题，源码注释/正则字面不算。
RUNTIME_CONFIG_FILES = {
    'Harbor.spec', 'Harbor-mac.spec', 'electron-builder.yml', 'package.json',
    'requirements-win.txt', 'requirements-mac.txt', 'requirements-ci.txt',
    '.github/workflows/harbor-ci.yml',
}


def iter_source_files(root):
    """Yield current product/test/tool text files, excluding frozen evidence."""
    root = Path(root)
    for name in SCAN_FILES:
        candidate = root / name
        if candidate.is_file():
            yield candidate
    for directory in SCAN_DIRS:
        base = root / directory
        if not base.is_dir():
            continue
        for candidate in base.rglob('*'):
            if not candidate.is_file() or candidate.suffix not in {
                    '.py', '.js', '.json', '.md', '.spec', '.html', '.yml', '.yaml'}:
                continue
            if any(part in EXCLUDED_DIRS for part in candidate.relative_to(root).parts):
                continue
            if candidate.name == 'main_v1.0.0_legacy.py':
                continue
            yield candidate


def find_legacy_references(root):
    """Return legacy flat-JS / backend.services / deleted-contract-path findings.

    I17：`DELETED_CONTRACT_PATH` 命中只在 RUNTIME_CONFIG_FILES 里计入，避免把
    扫描脚本自身或源码注释里的 `backend/api.py` 字面误判为运行时配置残留。
    """
    findings = []
    for candidate in iter_source_files(root):
        relative = candidate.relative_to(root).as_posix()
        # I17：原 2 条死豁免（tests/test_modern_build.py、
        # tests/test_modern_backend_architecture.py）随 74 个 pytest 删除，已移除。
        try:
            lines = candidate.read_text(encoding='utf-8').splitlines()
        except UnicodeDecodeError:
            continue
        is_runtime_config = relative in RUNTIME_CONFIG_FILES
        for number, line in enumerate(lines, 1):
            # 保留历史行级豁免（规格 I17 只点名删除 2 条已删测试的整文件豁免，
            # 本条按最小改动原则保留；文件已删时不触发，不影响判据）。
            if relative == 'tests/test_v19_browser.py' and (
                    'find_spec' in line or '不可导入' in line):
                continue
            for pattern, kind in ((LEGACY_JS, 'legacy-flat-js'),
                                  (BACKEND_SERVICES, 'backend-services'),
                                  (DELETED_CONTRACT_PATH, 'deleted-contract-path')):
                if kind == 'backend-services' and candidate.suffix not in {'.py', '.md', '.spec'}:
                    continue
                # I17：已删契约层路径只对运行时配置类报错
                if kind == 'deleted-contract-path' and not is_runtime_config:
                    continue
                for match in pattern.finditer(line):
                    findings.append({
                        'path': relative,
                        'line': number, 'kind': kind, 'value': match.group(0),
                        'runtimeConfig': is_runtime_config,
                    })
    return findings


def check_template_paths(root, template=None):
    """Validate local script/link resources without rejecting ordinary web links."""
    root = Path(root)
    template_path = Path(template) if template else root / 'frontend' / 'index.template.html'
    text = template_path.read_text(encoding='utf-8')
    errors = []
    pattern = re.compile(r'<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["\']([^"\']+)["\'][^>]*>', re.I)
    for match in pattern.finditer(text):
        reference = match.group(1)
        if re.match(r'^(?:https?:)?//', reference, re.I):
            errors.append('non-local build resource: ' + reference)
            continue
        local = reference.split('?', 1)[0].split('#', 1)[0]
        target = (root / local).resolve()
        if root.resolve() not in target.parents or not target.is_file():
            errors.append('missing or escaping local resource: ' + reference)
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(ROOT))
    parser.add_argument('--strict', action='store_true',
                        help='Fail on legacy paths (enable after W2/W3 migration).')
    parser.add_argument('--json', action='store_true', dest='json_output')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    findings = find_legacy_references(root)
    template_errors = check_template_paths(root)
    backend_findings = [row for row in findings if row['kind'] == 'backend-services']
    frontend_findings = [row for row in findings if row['kind'] == 'legacy-flat-js']
    contract_findings = [row for row in findings if row['kind'] == 'deleted-contract-path']
    legacy_findings = backend_findings + frontend_findings
    # R70 / I16：--strict 参与 ok 判定（原先是死参数，两种模式都恒纳入 findings）。
    # 非 strict：legacy findings 只登记不阻塞；strict：legacy findings 纳入 ok。
    # 运行时配置类的 deleted-contract-path 属真问题，两种模式都阻塞。
    ok = not template_errors and not contract_findings
    if args.strict:
        ok = ok and not legacy_findings
    report = {'ok': ok, 'strict': args.strict, 'legacy_count': len(findings),
              'backend_legacy_count': len(backend_findings),
              'frontend_legacy_count': len(frontend_findings),
              'deleted_contract_path_count': len(contract_findings),
              'scan_dirs': list(SCAN_DIRS),
              'legacy': findings, 'template_errors': template_errors}
    if args.json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print('[static-paths] legacy references: %d (backend/frontend blocked)' % len(findings))
        for error in template_errors:
            print('[static-paths] ERROR: ' + error)
        blocked = contract_findings + (legacy_findings if args.strict else [])
        for finding in blocked:
            print('[static-paths] ERROR: %(path)s:%(line)d %(kind)s %(value)s' % finding)
        print('[static-paths] ' + ('PASS' if ok else 'FAIL'))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
