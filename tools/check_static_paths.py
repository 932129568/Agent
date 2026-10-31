# -*- coding: utf-8 -*-
"""Inventory legacy source paths now; reject them with --strict after migration."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN_FILES = ('README.md', 'main.py', 'Harbor.spec', 'Harbor-mac.spec')
SCAN_DIRS = ('backend', 'frontend', 'tests', 'tools', 'installer')
EXCLUDED_DIRS = {'.git', '.pytest_cache', '__pycache__', 'build', 'dist',
                 'node_modules', 'outputs', 'wave-backups'}
LEGACY_JS = re.compile(r'frontend[\\/]+src[\\/]+\d{2,3}-[A-Za-z0-9_-]+\.js')
BACKEND_SERVICES = re.compile(r'\bbackend[./\\]+services(?:[./\\]|$)')


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
            if not candidate.is_file() or candidate.suffix not in {'.py', '.js', '.json', '.md', '.spec', '.html'}:
                continue
            if any(part in EXCLUDED_DIRS for part in candidate.relative_to(root).parts):
                continue
            if candidate.name == 'main_v1.0.0_legacy.py':
                continue
            yield candidate


def find_legacy_references(root):
    """Return legacy flat-JS and backend.services references with locations."""
    findings = []
    for candidate in iter_source_files(root):
        # Dedicated architecture guards intentionally construct old-path fixtures.
        relative = candidate.relative_to(root).as_posix()
        if relative in {'tests/test_modern_build.py',
                        'tests/test_modern_backend_architecture.py'}:
            continue
        try:
            lines = candidate.read_text(encoding='utf-8').splitlines()
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(lines, 1):
            if relative == 'tests/test_v19_browser.py' and (
                    'find_spec' in line or '不可导入' in line):
                continue
            for pattern, kind in ((LEGACY_JS, 'legacy-flat-js'),
                                  (BACKEND_SERVICES, 'backend-services')):
                if kind == 'backend-services' and candidate.suffix not in {'.py', '.md', '.spec'}:
                    continue
                for match in pattern.finditer(line):
                    findings.append({
                        'path': candidate.relative_to(root).as_posix(),
                        'line': number, 'kind': kind, 'value': match.group(0),
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
    ok = not template_errors and not backend_findings and not frontend_findings
    report = {'ok': ok, 'strict': args.strict, 'legacy_count': len(findings),
              'backend_legacy_count': len(backend_findings),
              'frontend_legacy_count': len(frontend_findings),
              'legacy': findings, 'template_errors': template_errors}
    if args.json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print('[static-paths] legacy references: %d (backend/frontend blocked)' % len(findings))
        for error in template_errors:
            print('[static-paths] ERROR: ' + error)
        blocked = backend_findings + frontend_findings
        for finding in blocked:
            print('[static-paths] ERROR: %(path)s:%(line)d %(kind)s %(value)s' % finding)
        print('[static-paths] ' + ('PASS' if ok else 'FAIL'))
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
