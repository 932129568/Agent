# -*- coding: utf-8 -*-
"""R59：依赖图可复用原语（被 tools/dep_scan.py 与 tests/test_r59_deps.py 共用）。

- python_sccs(root)：backend/ AST import 图 → (环列表, 模块数)
- node_sccs(root)：server/src ESM import 图 → (环列表, 模块数)
- frontend_forward(root)：前端前向隐藏边（调用更晚模块 provided 符号且未声明
  requires）——与 tools/gen_allowlist.mjs 同算法（JS 侧为门禁权威实现）
"""
import ast
import io
import json
import os
import re


def _tarjan(graph):
    index, low, onstk, stk, sccs = {}, {}, set(), [], []
    counter = [0]

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stk.append(v)
        onstk.add(v)
        for w in graph.get(v, ()):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in onstk:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stk.pop()
                onstk.discard(w)
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                sccs.append(sorted(comp))

    for v in sorted(graph):
        if v not in index:
            strong(v)
    return sccs


# ---------------- Python ----------------
def _py_imports(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                yield ('abs', a.name, 0)
        elif isinstance(node, ast.ImportFrom):
            yield ('rel', node.module or '', node.level)


def python_sccs(root):
    base = os.path.join(root, 'backend')
    edges, mods_present = {}, set()
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d != '__pycache__']
        for fn in filenames:
            if not fn.endswith('.py'):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, base).replace('\\', '/')
            mod = rel[:-3]
            mods_present.add(mod)
            try:
                tree = ast.parse(io.open(full, encoding='utf-8').read())
            except Exception:
                continue
            for kind, name, level in _py_imports(tree):
                m = name
                if kind == 'abs':
                    if m.startswith('backend.'):
                        m = m[len('backend.'):]
                else:
                    parent = mod.rsplit('/', 1)[0] if '/' in mod else mod
                    for _ in range(max(0, level - 1)):
                        parent = parent.rsplit('/', 1)[0] if '/' in parent else parent
                    m = (parent + '.' + name).strip('.')
                if m and m != mod:
                    edges.setdefault(mod, set()).add(m)

    def _exists(m):
        p = os.path.join(base, m.replace('.', '/'))
        return os.path.exists(p + '.py') or os.path.exists(os.path.join(p, '__init__.py'))

    mods = {m for m in (set(edges) | {t for ts in edges.values() for t in ts}) if _exists(m)}
    graph = {m: {t for t in edges.get(m, ()) if t in mods} for m in mods}
    return _tarjan(graph), len(mods)


# ---------------- Node ----------------
def node_sccs(root):
    src_dir = os.path.join(root, 'server', 'src')
    mods = []
    for dirpath, dirnames, filenames in os.walk(src_dir):
        dirnames[:] = [d for d in dirnames if d != 'node_modules']
        for fn in filenames:
            if fn.endswith('.js'):
                mods.append(os.path.relpath(os.path.join(dirpath, fn), src_dir).replace('\\', '/'))
    modset = set(mods)
    graph = {}
    for rel in mods:
        src = io.open(os.path.join(src_dir, rel), encoding='utf-8').read()
        targets = set()
        for m in re.finditer(r"from\s+'(\.\.?/[^']+)'", src):
            t = os.path.normpath(os.path.join(os.path.dirname(rel), m.group(1))).replace('\\', '/')
            if t in modset and t != rel:
                targets.add(t)
        graph[rel] = targets
    return _tarjan(graph), len(mods)


# ---------------- 前端 ----------------
_STRIP = [
    re.compile(r'/\*[\s\S]*?\*/'),
    re.compile(r'//[^\n]*'),
    re.compile(r"'(?:\\.|[^'\\])*'"),
    re.compile(r'"(?:\\.|[^"\\])*"'),
    re.compile(r'`(?:\\.|[^`\\])*`'),
    re.compile(r'uiSeamCall\s*\('),
]


def frontend_forward(root):
    """前向隐藏边（python 侧近似实现；门禁权威实现是 tools/gen_allowlist.mjs）。"""
    man = json.load(io.open(os.path.join(root, 'frontend/manifest.json'), encoding='utf-8'))
    scripts = man['scripts']
    order = {e['path']: i for i, e in enumerate(scripts)}
    provides = {}
    for e in scripts:
        for sym in e['provides']:
            provides.setdefault(sym, []).append(e['path'])
    out = {}
    for e in scripts:
        src = io.open(os.path.join(root, e['path']), encoding='utf-8').read()
        for pat in _STRIP:
            src = pat.sub(' ', src)
        declared = set(e['requires'])
        for mm in re.finditer(r'[A-Za-z_$][A-Za-z0-9_$]*', src):
            sym = mm.group(0)
            for t in provides.get(sym, []):
                if t == e['path'] or order.get(t, -1) <= order.get(e['path']):
                    continue
                if sym in declared:
                    continue
                out[e['path'] + '::' + sym] = t
    return out
