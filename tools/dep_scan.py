# -*- coding: utf-8 -*-
"""R59 依赖图扫描器（一次性工具，不入门禁）：
1) 前端：manifest 声明边 + 隐藏调用边（调用了他模块 provides 但未声明 requires，
   或反向引用更早模块——后者绕过 build 的 requires⊆provided 规则，是潜在运行时环）
2) Python：backend/ server 之外模块 import 图（AST）→ 强连通分量（环）
3) Node：server/src ESM import 图 → 环
输出汇总报告（stdout）。"""
import ast
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------- 前端 ----------------
def scan_frontend():
    man = json.load(io.open(os.path.join(ROOT, 'frontend/manifest.json'), encoding='utf-8'))
    entries = man['scripts']
    paths = [e['path'] for e in entries]
    idx = {p: i for i, p in enumerate(paths)}
    provides = {}   # symbol -> module path
    for e in entries:
        for sym in e['provides']:
            provides.setdefault(sym, []).append(e['path'])
    id_re = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*')
    hidden_forward, backward, pairs = [], {}, {}
    for e in entries:
        p = e['path']
        src = io.open(os.path.join(ROOT, p), encoding='utf-8').read()
        # 粗去注释/字符串（够用的近似）
        src = re.sub(r'/\*[\s\S]*?\*/', '', src)
        src = re.sub(r'//[^\n]*', '', src)
        src = re.sub(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`", ' ', src)
        used = set(id_re.findall(src))
        declared = set(e['requires'])
        targets = {}
        for sym in used:
            for mp in provides.get(sym, []):
                if mp == p:
                    continue
                targets.setdefault(mp, set()).add(sym)
        for mp, syms in targets.items():
            if mp in idx and idx[mp] > idx[p] and not (syms <= declared):
                undecl = sorted(syms - declared)
                hidden_forward.append((p, mp, undecl[:6]))
            elif mp in idx and idx[mp] < idx[p]:
                backward.setdefault(p, []).append((mp, sorted(syms)[:4]))
    # 真环检测：前向边 a->b（声明或隐藏，idx a < idx b）+ 反向边 b->a → 环
    fwd = {}
    for (a, b, _s) in hidden_forward:
        fwd.setdefault(a, set()).add(b)
    cycles = set()
    for a, lst in backward.items():
        for (b, _s) in lst:
            # b(早) <-反向- a(晚)；若 a 有前向边到 b → 环 a<->b；反之亦然
            if a in fwd and b in fwd[a]:
                cycles.add((b, a))
            if b in fwd and a in fwd[b]:
                cycles.add((a, b))
    print('== 前端隐藏前向边（调用未声明 requires，top 25）==')
    for a, b, syms in hidden_forward[:25]:
        print('  %s -> %s  未声明: %s' % (a.split('/')[-1], b.split('/')[-1], ','.join(syms)))
    print('前端隐藏前向边总数:', len(hidden_forward))
    print('== 前端反向引用（引用更早模块符号，top 25）==')
    for a, lst in list(backward.items())[:25]:
        for (b, syms) in lst:
            print('  %s -> %s  符号: %s' % (a.split('/')[-1], b.split('/')[-1], ','.join(syms)))
    print('前端反向引用边总数:', sum(len(v) for v in backward.values()))
    print('== 前端交叉环（前向×反向闭合）==')
    for (a, b) in sorted(cycles):
        print('  %s <-> %s' % (a.split('/')[-1], b.split('/')[-1]))
    print('前端交叉环数:', len(cycles))

# ---------------- Python ----------------
def _py_mod_of(node, pkg_root):
    if isinstance(node, ast.Import):
        for a in node.names:
            yield a.name
    elif isinstance(node, ast.ImportFrom) and node.module:
        yield node.module

def scan_python():
    edges = {}
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, 'backend')):
        dirnames[:] = [d for d in dirnames if d not in ('__pycache__',)]
        for fn in filenames:
            if not fn.endswith('.py'):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, os.path.join(ROOT, 'backend')).replace('\\', '/')
            mod = rel[:-3]
            try:
                tree = ast.parse(io.open(full, encoding='utf-8').read())
            except Exception:
                continue
            for node in ast.walk(tree):
                for name in _py_mod_of(node, ROOT):
                    # backend 内相对导入归一
                    if node.col_offset == 0 or True:
                        pass
                    m = name
                    if m.startswith('backend.'):
                        m = m[len('backend.'):]
                    # 相对导入：level>0 → 依据当前包路径解析（近似：取前缀）
                    if isinstance(node, ast.ImportFrom) and node.level:
                        base = mod.rsplit('/', 1)[0] if '/' in mod else mod
                        for _ in range(node.level - 1):
                            base = base.rsplit('/', 1)[0] if '/' in base else base
                        m = (base + '.' + (node.module or '')).strip('.')
                    if m and m != mod:
                        edges.setdefault(mod, set()).add(m)
    mods = set(edges) | {t for ts in edges.values() for t in ts}

    def _exists(m):
        base = os.path.join(ROOT, 'backend', m.replace('.', '/'))
        return os.path.exists(base + '.py') or os.path.exists(os.path.join(base, '__init__.py'))

    mods = {m for m in mods if _exists(m)}
    # Tarjan SCC
    graph = {m: {t for t in edges.get(m, ()) if t in mods} for m in mods}
    index, low, onstk, stk, sccs, counter = {}, {}, set(), [], [], [0]
    def strong(v):
        index[v] = low[v] = counter[0]; counter[0] += 1
        stk.append(v); onstk.add(v)
        for w in graph.get(v, ()):
            if w not in index:
                strong(w); low[v] = min(low[v], low[w])
            elif w in onstk:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stk.pop(); onstk.discard(w); comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                sccs.append(sorted(comp))
    for v in sorted(graph):
        if v not in index:
            strong(v)
    print('== Python 模块环（SCC>1）==')
    for comp in sccs:
        print('  环:', ' <-> '.join(comp))
    print('Python 环数:', len(sccs), '/ 模块数:', len(mods))
    # 入度 top（hub）
    indeg = {}
    for m, ts in graph.items():
        for t in ts:
            indeg[t] = indeg.get(t, 0) + 1
    print('== Python 被依赖 top 10 ==')
    for m, d in sorted(indeg.items(), key=lambda kv: -kv[1])[:10]:
        print('  %s ← %d' % (m, d))

# ---------------- Node ----------------
def scan_node():
    src_dir = os.path.join(ROOT, 'server', 'src')
    edges = {}
    mods = []
    for dirpath, dirnames, filenames in os.walk(src_dir):
        dirnames[:] = [d for d in dirnames if d != 'node_modules']
        for fn in filenames:
            if fn.endswith('.js'):
                rel = os.path.relpath(os.path.join(dirpath, fn), src_dir).replace('\\', '/')
                mods.append(rel)
    modset = set(mods)
    for rel in mods:
        full = os.path.join(src_dir, rel)
        src = io.open(full, encoding='utf-8').read()
        for m in re.finditer(r"from\s+'(\.\.?/[^']+)'", src):
            t = os.path.normpath(os.path.join(os.path.dirname(rel), m.group(1))).replace('\\', '/')
            if t in modset and t != rel:
                edges.setdefault(rel, set()).add(t)
    graph = {m: edges.get(m, set()) for m in mods}
    index, low, onstk, stk, sccs, counter = {}, {}, set(), [], [], [0]
    def strong(v):
        index[v] = low[v] = counter[0]; counter[0] += 1
        stk.append(v); onstk.add(v)
        for w in graph.get(v, ()):
            if w not in index:
                strong(w); low[v] = min(low[v], low[w])
            elif w in onstk:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stk.pop(); onstk.discard(w); comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                sccs.append(sorted(comp))
    for v in sorted(graph):
        if v not in index:
            strong(v)
    print('== Node 服务环（SCC>1）==')
    for comp in sccs:
        print('  环:', ' <-> '.join(comp))
    print('Node 环数:', len(sccs), '/ 模块数:', len(mods))

if __name__ == '__main__':
    scan_frontend()
    print()
    scan_python()
    print()
    scan_node()
