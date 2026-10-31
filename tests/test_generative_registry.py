# -*- coding: utf-8 -*-
"""G1 real Zod bundle, component registry and native UiProjection tests."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from helpers.frontend import read_frontend_source
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
MODULES = ['libs/ui-schema.bundle.js', 'frontend/src/generative/schemas.js',
           'frontend/src/generative/registry.js', 'frontend/src/generative/projection.js']


def run_ui_case(body, modules=None):
    return run_case(body, modules or MODULES)


DOM = r'''
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.childNodes = this.children;
    this.attributes = {}; this.dataset = {}; this.className = ''; this.textContent = '';
    this.ownerDocument = null; this.parentNode = null; }
  appendChild(child) { child.parentNode = this; child.ownerDocument = this.ownerDocument;
    this.children.push(child); return child; }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; });
    this.children = []; this.childNodes = this.children;
    children.forEach(child => this.appendChild(child)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  querySelector(selector) { return walk(this).find(el => selector[0] === '.' &&
    String(el.className).split(/\s+/).includes(selector.slice(1))) || null; }
}
const document = { activeElement: null,
  createElement(tag, className, text) { const el = new El(tag); el.ownerDocument = document;
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text); return el; },
  createElementNS(ns, tag, className, text) { const el = new El(tag); el.ownerDocument = document;
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text); return el; } };
function walk(root) { return [root, ...root.children.flatMap(walk)]; }
function textOf(root) { return root.textContent + root.children.map(textOf).join(''); }
function host() { const el = document.createElement('main'); el.ownerDocument = document; return el; }
function simple(text, revision = 1) {
  return { schemaVersion: 1, specId: 'spec-1', revision, runId: 'run-1', sessionId: 'session-1',
    generation: 1, layout: 'single-column', title: '测试视图', blocks: [
      { blockId: 'text-1', component: 'TextBlock', props: { text }, actions: [] },
    ] };
}
function validBlocks() {
  return [
    { blockId: 'table', component: 'Table', props: { columns: ['名称', '值'],
      rows: [['A', 1], ['B', 2]], pageSize: 5, caption: '测试表' } },
    { blockId: 'card', component: 'Card', props: { title: '卡片',
      fields: [{ label: '状态', value: '正常' }] } },
    { blockId: 'kv', component: 'KeyValue', props: { items: [{ label: '项目', value: 'G1' }] } },
    { blockId: 'timeline', component: 'Timeline', props: { title: '步骤',
      items: [{ title: '第一步', status: 'done' }, { title: '第二步', status: 'doing' }] } },
    { blockId: 'bars', component: 'BarChart', props: { title: '数量',
      items: [{ label: 'A', value: 2 }, { label: 'B', value: 4 }] } },
    { blockId: 'text', component: 'TextBlock', props: { text: '纯文本' } },
    { blockId: 'empty', component: 'EmptyState', props: { title: '空状态' } },
    { blockId: 'skeleton', component: 'Skeleton', props: { lines: 2, label: '加载中' } },
  ];
}
function fullSpec(layout, revision = 1) {
  return { schemaVersion: 1, specId: 'full-' + layout, revision, runId: 'run-1',
    sessionId: 'session-1', generation: 1, layout, title: '完整视图', blocks: validBlocks() };
}
'''


def test_five_layouts_and_eight_components_render_real_dom():
    result = run_ui_case(DOM + r'''
const names = UiComponentRegistry.names();
const layouts = [];
let tableCount = 0, rectCount = 0, roles = [];
for (const layout of UI_LAYOUTS) {
  const target = host();
  const projection = UiProjection.mount(target, fullSpec(layout));
  layouts.push({ layout, ok: projection.lastResult.ok,
    className: projection.root.getAttribute('data-layout'),
    text: textOf(projection.root).slice(0, 80) });
  tableCount += walk(projection.root).filter(el => el.getAttribute('role') === 'table').length;
  rectCount += walk(projection.root).filter(el => el.tagName === 'RECT').length;
  roles.push(...walk(projection.root).map(el => el.getAttribute('role')).filter(Boolean));
}
return { names, layouts, tableCount, rectCount, roles };
''', MODULES)
    assert result['names'] == ['Table', 'Card', 'KeyValue', 'Timeline', 'BarChart',
                               'TextBlock', 'EmptyState', 'Skeleton']
    assert [item['layout'] for item in result['layouts']] == [
        'single-column', 'two-column', 'card-grid', 'table-focus', 'timeline']
    assert all(item['ok'] and item['className'] == item['layout'] for item in result['layouts'])
    assert result['tableCount'] == 5 and result['rectCount'] == 10
    assert 'list' in result['roles'] and 'img' in result['roles'] and 'status' in result['roles']


def test_schema_rejects_versions_duplicates_nan_limits_depth_and_actions():
    result = run_ui_case(DOM + r'''
const badVersion = simple('x'); badVersion.schemaVersion = 2;
const duplicate = simple('x'); duplicate.blocks.push({ blockId: 'text-1', component: 'TextBlock', props: { text: 'y' } });
const nan = simple('x'); nan.blocks[0].props.value = NaN;
const text = simple('x'.repeat(10001));
const depth = simple('x');
let current = depth.blocks[0];
for (let i = 0; i < 4; i++) {
  current.children = [{ blockId: 'child-' + i, component: 'TextBlock', props: { text: 'x' } }];
  current = current.children[0];
}
const actions = simple('x'); actions.blocks[0].actions = [{ name: 'danger' }];
const overflow = simple('x'); overflow.blocks = Array.from({ length: 7 }, (_, i) => ({
  blockId: 'large-' + i, component: 'TextBlock', props: { text: 'x'.repeat(10000) } }));
const tooMany = simple('x'); tooMany.blocks = Array.from({ length: 13 }, (_, i) => ({
  blockId: 'block-' + i, component: 'TextBlock', props: { text: 'x' } }));
return { badVersion: validateUiSpec(badVersion), duplicate: validateUiSpec(duplicate),
  nan: validateUiSpec(nan), text: validateUiSpec(text), depth: validateUiSpec(depth),
  actions: validateUiSpec(actions), overflow: validateUiSpec(overflow), tooMany: validateUiSpec(tooMany) };
''', MODULES)
    assert result['badVersion']['error']['code'] == 'invalid_schema'
    assert result['duplicate']['error']['code'] == 'duplicate_block_id'
    assert result['nan']['error']['code'] == 'non_finite_number'
    assert result['text']['error']['code'] == 'text_overflow'
    assert result['depth']['error']['code'] == 'depth_overflow'
    assert result['actions']['error']['code'] == 'invalid_schema'
    assert result['overflow']['error']['code'] == 'spec_overflow'
    assert result['tooMany']['ok'] is False


def test_bad_props_unknown_component_and_registration_metadata_fail_closed():
    result = run_ui_case(DOM + r'''
const context = { createElement: document.createElement.bind(document),
  createElementNS: document.createElementNS.bind(document), metrics: {} };
const bad = renderUiComponent({ component: 'Table', props: { columns: [] } }, context);
const unknown = renderUiComponent({ component: 'NotRegistered', props: {} }, context);
let registrationError = '';
try { registerUiComponent('Table', { renderer() {} }); } catch (error) { registrationError = error.message; }
const metadata = UiComponentRegistry.names().map(name => {
  const descriptor = UiComponentRegistry.get(name);
  return { name, role: descriptor.role, keyboard: descriptor.keyboard.focusable,
    responsive: descriptor.responsive.rule };
});
return { badRole: bad.element.getAttribute('role'), badFallback: bad.fallback,
  unknownRole: unknown.element.getAttribute('role'), unknownFallback: unknown.fallback,
  unknownText: textOf(unknown.element), metrics: context.metrics,
  registrationError, metadata };
''', MODULES)
    assert result['badRole'] == 'status' and result['badFallback'] == 'invalid_props'
    assert result['unknownRole'] == 'status' and result['unknownFallback'] == 'unknown_component'
    assert 'NotRegistered' in result['unknownText']
    assert result['metrics'] == {'invalid_props': 1, 'unknown_component': 1}
    assert result['registrationError'] == 'component_metadata_incomplete'
    assert len(result['metadata']) == 8
    assert all(item['role'] and item['responsive'] for item in result['metadata'])


def test_projection_revision_xss_and_zero_action_execution():
    result = run_ui_case(DOM + r'''
let actionCalls = 0;
const target = host();
const projection = UiProjection.mount(target, simple('<img src=x onerror=alert(1)>', 2));
const initial = { imgCount: walk(projection.root).filter(el => el.tagName === 'IMG').length,
  text: textOf(projection.root), eventAttributes: walk(projection.root).flatMap(el =>
    Object.keys(el.attributes).filter(name => name.startsWith('on'))) };
const committed = projection.commit(simple('new content', 3));
const staleRevision = projection.commit(simple('old content', 2));
const wrongRun = simple('wrong run', 4); wrongRun.runId = 'other';
const staleContext = projection.commit(wrongRun);
const same = projection.commit(simple('same revision', 3));
const withAction = simple('must not execute', 4);
withAction.blocks[0].actions = [{ name: 'execute', args: { value: 1 } }];
const actionResult = projection.commit(withAction);
return { initial, committed, staleRevision, staleContext, same, actionResult,
  actionCalls, currentRevision: projection.current.revision,
  currentText: textOf(projection.root), metrics: projection.metrics };
''', MODULES)
    assert result['initial']['imgCount'] == 0 and result['initial']['eventAttributes'] == []
    assert '<img src=x' in result['initial']['text']
    assert result['committed']['ok'] is True
    assert result['staleRevision']['error'] == 'stale_revision'
    assert result['staleContext']['error'] == 'stale_context'
    assert result['same']['ok'] is True
    assert result['actionResult']['ok'] is False
    assert result['actionCalls'] == 0 and result['currentRevision'] == 3
    assert 'same revision' in result['currentText']
    assert result['metrics']['ignored_late_spec'] == 2


def test_aria_keyboard_table_chart_timeline_and_skeleton():
    result = run_ui_case(DOM + r'''
const projection = UiProjection.mount(host(), fullSpec('table-focus'));
const nodes = walk(projection.root);
return {
  tableWrap: nodes.find(el => String(el.className).includes('ui-table-wrap')).attributes,
  tableRole: nodes.find(el => el.tagName === 'TABLE').getAttribute('role'),
  chartRole: nodes.find(el => String(el.className).includes('ui-barchart')).getAttribute('role'),
  chartLabel: nodes.find(el => String(el.className).includes('ui-barchart')).getAttribute('aria-label'),
  timelineTitles: nodes.filter(el => String(el.className).includes('ui-timeline-title')).map(el => el.textContent),
  busy: nodes.find(el => String(el.className).includes('ui-skeleton')).getAttribute('aria-busy'),
  live: nodes.filter(el => el.getAttribute('aria-live') === 'polite').length,
};
''', MODULES)
    assert result['tableWrap']['tabindex'] == '0'
    assert result['tableWrap']['role'] == 'region'
    assert result['tableRole'] == 'table'
    assert result['chartRole'] == 'img' and 'A 2' in result['chartLabel']
    assert result['timelineTitles'] == ['第一步', '第二步']
    assert result['busy'] == 'true' and result['live'] == 1


def test_static_security_dependency_and_packaging_guards():
    sources = '\n'.join(read_frontend_source(str(ROOT), name)
                       for name in MODULES[1:])
    for forbidden in ('innerHTML', 'eval(', 'new Function', 'document.write',
                      'foreignObject', 'javascript:', 'onerror=', 'onclick='):
        assert forbidden not in sources
    assert 'http://' not in sources.replace('http://www.w3.org/2000/svg', '')
    assert 'https://' not in sources
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
    assert package['private'] is True
    assert package['dependencies'] == {'zod': '4.6.7'}
    assert package['devDependencies'] == {'esbuild': '0.28.2'}
    assert lock['packages']['node_modules/zod']['version'] == '4.6.7'
    assert lock['packages']['node_modules/esbuild']['version'] == '0.28.2'
    assert lock['packages']['node_modules/esbuild']['dev'] is True
    assert 'node_modules/' in (ROOT / '.gitignore').read_text(encoding='utf-8')
    template = (ROOT / 'frontend' / 'index.template.html').read_text(encoding='utf-8')
    assert '<script src="libs/ui-schema.bundle.js"></script>' in template
    for spec in ('Harbor.spec', 'Harbor-mac.spec'):
        content = (ROOT / spec).read_text(encoding='utf-8')
        assert "'libs'" in content and 'node_modules/' not in content
    release = (ROOT / 'tools' / 'check_release.py').read_text(encoding='utf-8')
    assert 'libs/ui-schema.bundle.js' in release and 'libs/ui-schema.NOTICE.txt' in release
    assert 'MIT' in (ROOT / 'libs' / 'ui-schema.LICENSE.txt').read_text(encoding='utf-8')
    assert 'esbuild' in (ROOT / 'libs' / 'ui-schema.NOTICE.txt').read_text(encoding='utf-8')


def test_bundle_bytes_sha_gzip_and_offline_builds_are_reproducible():
    assert NODE, 'Node.js is required for bundle tests'
    command = [NODE, 'tools/build_ui_schema_bundle.js']
    first = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert first.returncode == 0, first.stderr
    bundle = (ROOT / 'libs' / 'ui-schema.bundle.js').read_bytes()
    digest1 = hashlib.sha256(bundle).hexdigest()
    gzip_result = subprocess.run([
        NODE, '-e',
        "const z=require('zlib'),fs=require('fs');const b=fs.readFileSync('libs/ui-schema.bundle.js');"
        "process.stdout.write(String(z.gzipSync(b,{level:9,mtime:0}).length));",
    ], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert gzip_result.returncode == 0
    gzip1 = int(gzip_result.stdout)
    assert gzip.decompress(gzip.compress(bundle, compresslevel=9, mtime=0)) == bundle
    second = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert second.returncode == 0, second.stderr
    assert (ROOT / 'libs' / 'ui-schema.bundle.js').read_bytes() == bundle
    report = json.loads((ROOT / 'outputs' / 'generative-g1' / 'bundle-report.json').read_text(encoding='utf-8'))
    assert report['bytes'] == len(bundle)
    assert report['sha256'] == digest1
    assert report['gzipBytes'] == gzip1
    assert report['environment']['zod'] == '4.6.7'
    assert report['environment']['esbuild'] == '0.28.2'
    node_modules = ROOT / 'node_modules'
    offline = ROOT / 'node_modules.offline-test'
    if offline.exists():
        shutil.rmtree(offline)
    node_modules.rename(offline)
    try:
        one = subprocess.run([NODE, 'frontend/build.js'], cwd=ROOT,
                             capture_output=True, text=True, timeout=120)
        assert one.returncode == 0, one.stderr
        first_html = (ROOT / 'harbor.html').read_bytes()
        two = subprocess.run([NODE, 'frontend/build.js'], cwd=ROOT,
                             capture_output=True, text=True, timeout=120)
        assert two.returncode == 0, two.stderr
        assert (ROOT / 'harbor.html').read_bytes() == first_html
    finally:
        offline.rename(node_modules)


def test_edge_dynamic_projection_evidence():
    report = json.loads((ROOT / 'outputs' / 'generative-g1' / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True
    assert report['realExe'] == 'UNCOVERED'
    assert report['unknownComponent'] >= 1
    assert report['validBlocks'] == 8
    assert report['actionsExecuted'] == 0
    for capture in report['captures']:
        assert capture['overflow'] == []
        assert capture['documentWidth'] <= capture['viewport'][0] + 2
        assert (ROOT / 'outputs' / 'generative-g1' / (capture['name'] + '.png')).stat().st_size > 1000
