# -*- coding: utf-8 -*-
"""函数级依赖图（R29）。

Harbor 前端是「按 manifest 顺序拼接成一个 <script>」的架构，跨文件调用靠
全局符号，因此模块级重构必须先有**函数级**依赖图，才能判断哪些函数组可以
单向切分（新模块插在原模块之前，不产生反向依赖）。

采集口径：
  - 顶层声明：行首 `function` / `async function` / `class` / `const|let|var`；
  - 定义块：从声明行到下一个顶层声明行之前；
  - 依赖边：定义块代码（剥除注释与字符串字面量）里出现的其它顶层符号名；
  - SCC：Tarjan 强连通分量，size>1 即「高耦合簇」，不可单向切分。

用法：
  python tools/function_graph.py --build deliverables/dev-plan/r29-function-graph.json
  python tools/function_graph.py --graph <json> --query connectApplyPresetNow --direction both --depth 2
  python tools/function_graph.py --graph <json> --cycles
  python tools/function_graph.py --graph <json> --module frontend/src/settings/connection.js

图谱仅作加速器：动刀前仍需 grep 实码复核（技能 L0）。
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'frontend' / 'src'
MANIFEST = ROOT / 'frontend' / 'manifest.json'

DECL = re.compile(
    r'^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)'
    r'|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)')
IDENT = re.compile(r'\b([A-Za-z_$][\w$]*)\b')
STR_LIT = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`", re.S)
COMMENT_LINE = re.compile(r'^\s*(?://|/\*|\*|\*/)')


def manifest_paths():
    m = json.loads(MANIFEST.read_text(encoding='utf-8'))
    return [e['path'] for e in m['scripts']]


def normalize_def(lines):
    """定义体归一化：去纯注释行/空行，逐行 rstrip。注释归属变化不影响哈希。"""
    out = []
    for line in lines:
        s = line.strip()
        if not s or COMMENT_LINE.match(line):
            continue
        out.append(line.rstrip())
    return '\n'.join(out)


def collect(root=None):
    """返回 {defs, order, modules, edges, scc, stats}。"""
    base = root or ROOT
    paths = manifest_paths()
    # R29 健壮性：manifest 里的模块缺失时给可读错误，而非 FileNotFoundError 堆栈
    cache = {}
    for rel in paths:
        p = base / rel
        if not p.is_file():
            raise FileNotFoundError('manifest 模块缺失: %s' % rel)
        cache[rel] = p.read_text(encoding='utf-8').splitlines()
    defs = {}
    order = []
    for rel in paths:
        lines = cache[rel]
        starts = []
        for i, line in enumerate(lines):
            m = DECL.match(line)
            if m:
                name = m.group(1) or m.group(2)
                kind = 'function' if m.group(1) else ('class' if line.lstrip().startswith('class ') else 'var')
                starts.append((i, name, kind))
        for j, (start, name, kind) in enumerate(starts):
            end = starts[j + 1][0] if j + 1 < len(starts) else len(lines)
            block = lines[start:end]
            defs[name] = {
                'file': rel, 'kind': kind, 'line': start + 1,
                'def_hash': hashlib.sha256(normalize_def(block).encode('utf-8')).hexdigest(),
                'lines': end - start,
            }
            order.append(name)

    universe = set(defs)
    # 依赖边：剥除注释/字符串后与顶层符号集合求交
    for name, meta in defs.items():
        lines = cache[meta['file']][meta['line'] - 1:]
        # 截到下一个顶层声明
        block = []
        for k, line in enumerate(lines):
            if k and DECL.match(line):
                break
            block.append(line)
        code = '\n'.join(l for l in block if not COMMENT_LINE.match(l))
        code = STR_LIT.sub(' ', code)
        deps = set(IDENT.findall(code)) & universe
        deps.discard(name)
        meta['deps'] = sorted(deps)

    edges = [{'from': a, 'to': b} for a, m in defs.items() for b in m['deps']]
    rev = {n: [] for n in defs}
    for e in edges:
        rev[e['to']].append(e['from'])
    for n, meta in defs.items():
        meta['rev'] = sorted(set(rev[n]))

    modules = {}
    for rel in paths:
        syms = [n for n, m in defs.items() if m['file'] == rel]
        external = sorted({d for n in syms for d in defs[n]['deps'] if defs[d]['file'] != rel})
        modules[rel] = {'symbols': syms, 'count': len(syms), 'external_deps': external}

    scc = tarjan_scc({n: m['deps'] for n, m in defs.items()})
    cycles = [sorted(c) for c in scc if len(c) > 1]
    return {
        'defs': defs, 'order': order, 'modules': modules,
        'edges': edges, 'scc_cycles': cycles,
        'stats': {
            'modules': len(paths), 'symbols': len(defs),
            'edges': len(edges), 'cycles': len(cycles),
            'cyclic_symbols': sum(len(c) for c in cycles),
        },
    }


def tarjan_scc(graph):
    """Tarjan 强连通分量（迭代式，避免 1155 节点递归深度问题）。"""
    index = {}
    low = {}
    on_stack = {}
    stack = []
    result = []
    counter = [0]
    for root in graph:
        if root in index:
            continue
        work = [(root, 0)]
        while work:
            node, pi = work[-1]
            if pi == 0:
                index[node] = low[node] = counter[0]
                counter[0] += 1
                stack.append(node)
                on_stack[node] = True
            neighbors = graph.get(node, [])
            if pi < len(neighbors):
                nxt = neighbors[pi]
                work[-1] = (node, pi + 1)
                if nxt not in index:
                    work.append((nxt, 0))
                elif on_stack.get(nxt):
                    low[node] = min(low[node], index[nxt])
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack[w] = False
                    comp.append(w)
                    if w == node:
                        break
                result.append(comp)
    return result


def query(graph, name, direction='both', depth=2):
    defs = graph['defs']
    if name not in defs:
        return {'error': 'symbol not found: %s' % name}
    out, seen = {}, {name}
    frontier = [name]
    for d in range(1, depth + 1):
        nxt = []
        for cur in frontier:
            targets = []
            if direction in ('both', 'out'):
                targets += defs[cur]['deps']
            if direction in ('both', 'in'):
                targets += defs[cur]['rev']
            for t in targets:
                if t in seen:
                    continue
                seen.add(t)
                out.setdefault(d, []).append({'symbol': t, 'file': defs[t]['file'],
                                              'via': cur})
                nxt.append(t)
        frontier = nxt
    return {'symbol': name, 'file': defs[name]['file'], 'kind': defs[name]['kind'],
            'deps': defs[name]['deps'], 'rev': defs[name]['rev'], 'hops': out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--build', default='', help='写出依赖图 JSON')
    ap.add_argument('--graph', default='', help='读取已有依赖图 JSON')
    ap.add_argument('--query', default='')
    ap.add_argument('--direction', default='both', choices=['in', 'out', 'both'])
    ap.add_argument('--depth', type=int, default=2)
    ap.add_argument('--cycles', action='store_true')
    ap.add_argument('--module', default='')
    args = ap.parse_args()

    graph = None
    if args.graph:
        gp = Path(args.graph)
        if not gp.is_file():
            print('ERROR: 依赖图文件不存在: %s' % gp)
            return 2
        try:
            graph = json.loads(gp.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as exc:
            print('ERROR: 依赖图无法解析: %s' % exc)
            return 2
    if args.build or (not graph and (args.query or args.cycles or args.module)):
        try:
            graph = collect()
        except (OSError, ValueError) as exc:
            print('ERROR: 构建依赖图失败: %s' % exc)
            return 2
    if args.build:
        out = Path(args.build)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(graph, ensure_ascii=False, indent=1), encoding='utf-8')
        print('graph written: %s' % out)
    if graph is None:
        ap.print_help()
        return 0
    s = graph['stats']
    print('stats: modules=%d symbols=%d edges=%d cycles=%d cyclic_symbols=%d' %
          (s['modules'], s['symbols'], s['edges'], s['cycles'], s['cyclic_symbols']))
    if args.query:
        q = query(graph, args.query, args.direction, args.depth)
        if 'error' in q:
            # R29 UX：未知的符号给近似候选，且以非零退出码明确失败（原返回 exit 0）
            import difflib
            hints = difflib.get_close_matches(args.query, graph['defs'].keys(),
                                              n=5, cutoff=0.35)
            print('ERROR: %s' % q['error'])
            if hints:
                print('相近符号候选: %s' % ', '.join(hints))
            return 1
        print(json.dumps(q, ensure_ascii=False, indent=1))
    if args.cycles:
        print('SCC cycles (size>1): %d' % len(graph['scc_cycles']))
        for c in graph['scc_cycles'][:30]:
            print('  [%d] %s' % (len(c), ', '.join(c[:12]) + (' …' if len(c) > 12 else '')))
    if args.module:
        m = graph['modules'].get(args.module)
        print(json.dumps(m, ensure_ascii=False, indent=1) if m else 'module not found')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
