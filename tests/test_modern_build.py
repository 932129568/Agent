# -*- coding: utf-8 -*-
"""W1 manifest build, lexical guards and static-path regression tests."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parent.parent
BUILD_JS = ROOT / 'frontend' / 'build.js'
STATIC_TOOL = ROOT / 'tools' / 'check_static_paths.py'
NODE = shutil.which('node')
sys.path.insert(0, str(ROOT / 'tests'))
from helpers.frontend import frontend_node_map, read_frontend_source  # noqa: E402
from tools.check_static_paths import (  # noqa: E402
    check_template_paths, find_legacy_references)


def make_project(tmp_path, scripts=None, styles=None, template=None):
    """Create an isolated minimal project with all required local resources."""
    root = tmp_path / 'repo'
    (root / 'frontend' / 'src').mkdir(parents=True)
    (root / 'frontend' / 'styles').mkdir(parents=True)
    (root / 'libs').mkdir()
    for name in ('marked.min.js', 'purify.min.js', 'flate.js', 'highlight.min.js'):
        (root / 'libs' / name).write_text('// local\n', encoding='utf-8')
    (root / 'VERSION').write_text('1.9.0\n', encoding='utf-8')
    if scripts is None:
        scripts = [{'path': 'frontend/src/core/a.js',
                    'provides': ['base'], 'requires': []}]
    if styles is None:
        styles = ['frontend/styles/base.css']
    for entry in scripts:
        target = root / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_text('const %s = 1;\n' % entry['provides'][0], encoding='utf-8')
    for relative in styles:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(':root{--bg:#fff;}\n', encoding='utf-8')
    if template is None:
        template = ('<!doctype html><script src="libs/marked.min.js"></script>'
                    '<style>\n/*__APP_STYLES__*/\n</style>'
                    '<script>const APP_VERSION="__APP_VERSION__";\n/*__APP_SCRIPT__*/\n</script>')
    (root / 'frontend' / 'index.template.html').write_text(template, encoding='utf-8')
    manifest = {'schemaVersion': 1, 'template': 'frontend/index.template.html',
                'output': 'harbor.html', 'scripts': scripts, 'styles': styles}
    (root / 'frontend' / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return root


def run_build(root):
    """Run the real builder against an isolated root and capture its diagnostics."""
    assert NODE, 'Node.js is required for frontend build tests'
    script = "const b=require(process.argv[1]);b.build({root:process.argv[2]});"
    return subprocess.run([NODE, '-e', script, str(BUILD_JS), str(root)],
                          capture_output=True, text=True, encoding='utf-8', errors='replace')


def test_current_manifest_build_is_byte_deterministic():
    first = subprocess.run([NODE, 'frontend/build.js'], cwd=ROOT,
                           capture_output=True, text=True, timeout=120)
    digest1 = hashlib.sha256((ROOT / 'harbor.html').read_bytes()).hexdigest()
    second = subprocess.run([NODE, 'frontend/build.js'], cwd=ROOT,
                            capture_output=True, text=True, timeout=120)
    digest2 = hashlib.sha256((ROOT / 'harbor.html').read_bytes()).hexdigest()
    assert first.returncode == 0 and second.returncode == 0
    assert digest1 == digest2
    manifest = json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    assert len(manifest["scripts"]) == 104
    assert manifest['styles'] == [
        'frontend/styles/tokens.css', 'frontend/styles/base.css',
        'frontend/styles/legacy.css', 'frontend/styles/components.css',
        'frontend/styles/shell.css', 'frontend/styles/features/chat.css',
        'frontend/styles/features/plan.css', 'frontend/styles/features/mcp.css',
        'frontend/styles/features/memory.css', 'frontend/styles/features/overlays.css',
        'frontend/styles/features/generative.css',         'frontend/styles/features/expert.css', 'frontend/styles/features/collaboration.css',
        'frontend/styles/responsive.css',
    ]


@pytest.mark.parametrize('relative', ['frontend/src/orphan.js', 'frontend/styles/orphan.css'])
def test_disk_files_omitted_from_manifest_fail(tmp_path, relative):
    root = make_project(tmp_path)
    (root / relative).write_text('const orphan = 1;\n' if relative.endswith('.js') else '.orphan{}\n',
                                 encoding='utf-8')
    result = run_build(root)
    assert result.returncode != 0
    assert '未列入 manifest' in result.stderr


def test_duplicate_manifest_path_fails(tmp_path):
    entry = {'path': 'frontend/src/a.js', 'provides': ['base'], 'requires': []}
    root = make_project(tmp_path, scripts=[entry, dict(entry)])
    result = run_build(root)
    assert result.returncode != 0 and '重复' in result.stderr


def test_ghost_manifest_path_fails(tmp_path):
    root = make_project(tmp_path)
    (root / 'frontend' / 'src' / 'core' / 'a.js').unlink()
    result = run_build(root)
    assert result.returncode != 0 and '幽灵路径' in result.stderr


def test_requires_must_be_provided_by_an_earlier_module(tmp_path):
    scripts = [
        {'path': 'frontend/src/b.js', 'provides': ['second'], 'requires': ['base']},
        {'path': 'frontend/src/a.js', 'provides': ['base'], 'requires': []},
    ]
    root = make_project(tmp_path, scripts=scripts)
    result = run_build(root)
    assert result.returncode != 0 and '顺序依赖未满足: base' in result.stderr


@pytest.mark.parametrize('declaration', ['function duplicate() {}', 'let duplicate = 1;'])
def test_duplicate_top_level_symbol_across_modules_fails(tmp_path, declaration):
    scripts = [
        {'path': 'frontend/src/a.js', 'provides': ['duplicate'], 'requires': []},
        {'path': 'frontend/src/b.js', 'provides': ['duplicate'], 'requires': []},
    ]
    root = make_project(tmp_path, scripts=scripts)
    for entry in scripts:
        (root / entry['path']).write_text(declaration + '\n', encoding='utf-8')
    result = run_build(root)
    assert result.returncode != 0 and '顶层全局符号重复: duplicate' in result.stderr


def test_lexer_ignores_comments_strings_templates_regex_and_nested_blocks(tmp_path):
    source = r'''// function commentFake() {}
/* const blockFake = 1; */
const text = "function stringFake() {}";
const template = `const templateFake = 1; ${function() { return 1; }}`;
const pattern = /function regexFake() {}/;
const replacement = "$&";
function outer() { const nestedFake = 1; }
const real = 1;
'''
    entry = {'path': 'frontend/src/a.js',
             'provides': ['text', 'template', 'pattern', 'replacement', 'outer', 'real'],
             'requires': []}
    root = make_project(tmp_path, scripts=[entry])
    (root / 'frontend' / 'src' / 'a.js').write_text(source, encoding='utf-8')
    result = run_build(root)
    assert result.returncode == 0, result.stderr
    html = (root / 'harbor.html').read_text(encoding='utf-8')
    assert 'const replacement = "$&";' in html
    for pseudo in ('commentFake', 'blockFake', 'stringFake', 'templateFake', 'regexFake', 'nestedFake'):
        assert pseudo in html  # source retained, but not treated as a declaration


def test_provides_metadata_cannot_omit_or_invent_symbols(tmp_path):
    entry = {'path': 'frontend/src/a.js', 'provides': ['ghost'], 'requires': []}
    root = make_project(tmp_path, scripts=[entry])
    (root / 'frontend' / 'src' / 'a.js').write_text('const actual = 1;\n', encoding='utf-8')
    result = run_build(root)
    assert result.returncode != 0
    assert '未声明=[actual]' in result.stderr and '幽灵=[ghost]' in result.stderr


@pytest.mark.parametrize('placeholder', ['/*__APP_SCRIPT__*/', '/*__APP_STYLES__*/', '__APP_VERSION__'])
def test_each_template_placeholder_is_required_exactly_once(tmp_path, placeholder):
    template = ('<script src="libs/marked.min.js"></script><style>'
                '/*__APP_STYLES__*/</style>'
                '<script>const APP_VERSION="__APP_VERSION__";/*__APP_SCRIPT__*/</script>')
    root = make_project(tmp_path, template=template.replace(placeholder, placeholder + ' ' + placeholder))
    result = run_build(root)
    assert result.returncode != 0 and placeholder + ' 应恰好出现 1 次' in result.stderr


def test_static_path_backend_is_blocked_and_strict_also_blocks_frontend(tmp_path):
    root = make_project(tmp_path)
    (root / 'tests').mkdir(parents=True)
    (root / 'tests' / 'test_example.py').write_text(
        'OLD = "frontend/src/60-agent-loop.js"\nimport backend.services.config_service\n',
        encoding='utf-8')
    findings = find_legacy_references(root)
    assert {row['kind'] for row in findings} == {'legacy-flat-js', 'backend-services'}
    allowed = subprocess.run([sys.executable, str(STATIC_TOOL), '--root', str(root), '--json'],
                             capture_output=True, text=True, encoding='utf-8', errors='replace')
    allowed_report = json.loads(allowed.stdout)
    assert allowed.returncode != 0 and allowed_report['legacy_count'] == 2
    assert allowed_report['backend_legacy_count'] == 1
    result = subprocess.run([sys.executable, str(STATIC_TOOL), '--root', str(root),
                             '--strict', '--json'], capture_output=True, text=True,
                            encoding='utf-8', errors='replace')
    assert result.returncode != 0
    assert json.loads(result.stdout)['legacy_count'] == 2


def test_frontend_legacy_paths_are_blocked_by_default_after_w3(tmp_path):
    root = make_project(tmp_path)
    (root / 'tests').mkdir(parents=True)
    (root / 'tests' / 'test_example.py').write_text(
        'OLD = "frontend/src/60-agent-loop.js"\n', encoding='utf-8')
    allowed = subprocess.run([sys.executable, str(STATIC_TOOL), '--root', str(root), '--json'],
                             capture_output=True, text=True, encoding='utf-8', errors='replace')
    assert allowed.returncode != 0 and json.loads(allowed.stdout)['frontend_legacy_count'] == 1
    strict = subprocess.run([sys.executable, str(STATIC_TOOL), '--root', str(root),
                             '--strict', '--json'], capture_output=True, text=True,
                            encoding='utf-8', errors='replace')
    assert strict.returncode != 0


def test_template_static_paths_accept_local_and_reject_missing_or_remote(tmp_path):
    root = make_project(tmp_path)
    assert check_template_paths(root) == []
    template = root / 'frontend' / 'index.template.html'
    template.write_text('<script src="libs/missing.js"></script>', encoding='utf-8')
    assert 'missing' in check_template_paths(root)[0]
    template.write_text('<script src="https://example.invalid/app.js"></script>', encoding='utf-8')
    assert 'non-local' in check_template_paths(root)[0]


def test_shared_frontend_helper_uses_manifest_paths(tmp_path):
    entry = {'path': 'frontend/src/agent/run.js', 'provides': ['run'], 'requires': []}
    root = make_project(tmp_path, scripts=[entry])
    assert read_frontend_source(str(root), 'run.js') == 'const run = 1;\n'
    assert frontend_node_map(str(root))['run.js'] == 'frontend/src/agent/run.js'
