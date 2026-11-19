# -*- coding: utf-8 -*-
"""Legacy Node VM harness, extracted verbatim from two deleted test modules.

The Python contract layer (backend/) was retired and, with it, the test modules
``test_connect_merge.py`` and ``test_v16_batch1.py`` were removed. Those modules
happened to host a pure-JS VM harness (no ``backend`` / no ``conftest.NewApi``
dependency) that 13 surviving test files import. This module restores that
harness so those tests keep their coverage.

Read-only backup sources:
  C:/Users/陈/Desktop/GLM-Chat-backup-20261111-1414/tests/test_connect_merge.py
  C:/Users/陈/Desktop/GLM-Chat-backup-20261111-1414/tests/test_v16_batch1.py

The two harnesses are NOT identical (different ``__mkEl.appendChild`` /
``innerHTML`` / ``__absent`` / ``__ctx`` defaults), so both are preserved
separately: ``_run_node`` (connect_merge, 12 importers) and ``v16_run_node``
(v1.6 batch1, 1 importer).
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from helpers.frontend import frontend_node_map, read_frontend_source, resolve_script

# This file lives in tests/helpers/ (one level deeper than the original
# tests/test_connect_merge.py), so PROJECT_ROOT needs one extra dirname to keep
# pointing at the repository root. All harness strings below are verbatim.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
TPL = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')
OUT = os.path.join(PROJECT_ROOT, 'harbor.html')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


# ============================================================ test_connect_merge.py harness
_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], value: '', checked: false, onclick: null,
    disabled: false, textContent: '', _html: '',
    focus: function(){},
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      toggle: function(c, f){ if (f === undefined) f = !this._s.has(c);
        if (f) this._s.add(c); else this._s.delete(c); return f; },
      contains: function(c){ return this._s.has(c); } },
    appendChild: function(c){ this.children.push(c); c._parent = this;
      if (c.id) __byId[c.id] = c; return c; },
    remove: function(){},
    querySelector: function(){ return __mkEl('q'); },
    querySelectorAll: function(){ return []; },
    addEventListener: function(){},
  };
  Object.defineProperty(el, 'innerHTML', {
    set: function(v) { this._html = String(v); this.children.length = 0;
      const re = /<span[^>]*><\/span>/g; let m;
      while ((m = re.exec(this._html))) { const s = __mkEl('span'); this.children.push(s); } },
    get: function() { return this._html; },
  });
  return el;
}
const __byId = {};
/* 合并后的真实 DOM 里不存在的老 id（v1.5 独立区块专属）→ 声明为「不存在」，
   用于验证 34-local-model.js 的双 id 解析会回落到合并块 id */
const __absent = new Set();
const __toasts = [];
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ if (__absent.has(id)) return null;
    const el = __byId[id];
    if (!el) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
  querySelector: function(){ return __mkEl('q'); },
  addEventListener: function(){},
};
function __ctx(extra) {
  const sand = Object.assign({
    document: __doc, console: console,
    setTimeout: function(fn, ms){ return setTimeout(fn, Math.min(Number(ms) || 0, 20)); },
    clearTimeout: clearTimeout,
    toast: function(msg, kind, opts){ __toasts.push({ msg: msg, kind: kind, opts: opts || {} }); },
    CS: { syncAll: function(){ sand.__csSync = (sand.__csSync || 0) + 1; } },
  }, extra || {});
  sand.window = sand;
  return __vm.createContext(sand);
}
function __run(ctx, code) { __vm.runInContext(code, ctx, { timeout: 30000 }); }
const __SRC = %r;
const __MANIFEST = %r;
function __fe(name){
  const relative = __MANIFEST[name] || name;
  return String(relative).split(',').map(function(r){ return __fs.readFileSync(__SRC + '/' + r, 'utf8'); }).join('\n');
}
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)

_JS_MAIN = r"""
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""


def _run_node(body, name):
    if not os.path.exists(NODE):
        pytest.skip('node 不可用')
    js = _JS_PRELUDE + body + _JS_MAIN
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_cm_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([NODE, path], capture_output=True, timeout=60)
        if p.returncode != 0:
            raise AssertionError('node 脚本失败: %s' % (p.stderr.decode('utf-8', 'replace')[-1500:],))
        out = p.stdout.decode('utf-8', 'replace').strip()
        return json.loads(out) if out else None
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


# ============================================================ test_v16_batch1.py harness
_JS_PRELUDE_V16 = r"""
const __fs = require('fs');
const __vm = require('vm');
const __toasts = [];
const __byId = {};
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    value: '', checked: false, onclick: null, disabled: false, textContent: '', _html: '',
    focus: function(){},
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      toggle: function(c, f){ if (f === undefined) f = !this._s.has(c);
        if (f) this._s.add(c); else this._s.delete(c); return f; },
      contains: function(c){ return this._s.has(c); } },
    appendChild: function(c){ this.children.push(c); return c; },
    remove: function(){}, querySelector: function(){ return __mkEl('q'); },
    querySelectorAll: function(){ return []; }, addEventListener: function(){},
  };
  Object.defineProperty(el, 'innerHTML', {
    set: function(v) { this._html = String(v); this.children.length = 0; },
    get: function() { return this._html; },
  });
  return el;
}
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ const el = __byId[id];
    if (!el) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
  querySelector: function(){ return __mkEl('q'); },
  addEventListener: function(){},
};
function __ctx(extra) {
  const sand = Object.assign({
    document: __doc, console: console,
    setTimeout: function(fn, ms){ return setTimeout(fn, Math.min(Number(ms) || 0, 20)); },
    clearTimeout: clearTimeout,
    toast: function(msg, kind, opts){ __toasts.push({ msg: msg, kind: kind, opts: opts || {} }); },
    CS: { syncAll: function(){} },
    providerState: { enabled: true, model: 'openai/gpt-4o' },
  }, extra || {});
  sand.window = sand;
  return __vm.createContext(sand);
}
function __run(ctx, code) { __vm.runInContext(code, ctx, { timeout: 30000 }); }
const __SRC = %r;
const __MANIFEST = %r;
function __fe(name){
  const relative = __MANIFEST[name] || name;
  return String(relative).split(',').map(function(r){ return __fs.readFileSync(__SRC + '/' + r, 'utf8'); }).join('\n');
}
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)


def v16_run_node(body, name):
    if not os.path.exists(NODE):
        pytest.skip('node 不可用')
    js = _JS_PRELUDE_V16 + body + """
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_v16_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([NODE, path], capture_output=True, timeout=60)
        if p.returncode != 0:
            raise AssertionError('node 脚本失败: %s' % (p.stderr.decode('utf-8', 'replace')[-1500:],))
        out = p.stdout.decode('utf-8', 'replace').strip()
        return json.loads(out) if out else None
    finally:
        try:
            os.remove(path)
        except Exception:
            pass
