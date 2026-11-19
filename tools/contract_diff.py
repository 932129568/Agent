# -*- coding: utf-8 -*-
"""独立契约差分（R28 模块级重构专用）。

用途：大模块拆分属破坏性变更（manifest 顺序 / 冻结计数 / 文件归属都会变），
必须有一份**独立于测试硬编码**的证据，证明拆分前后「对外契约面零漂移」。

采集五类契约面：
  1. 顶层符号集合（prebuilt + scripts 的 provides 全集）—— 拆分前后必须完全一致；
  2. UI 五大契约集合（DOM id / onclick / callApi / CSS 类 / CSS 变量）—— 直接复用
     deliverables/design/check_contract.py 的常量，避免两处口径分叉；
  3. 后端 API 契约（冻结快照的 api_py_sha256 + API_VERSION）—— 必须不变。
     Python 契约层退役后不再读 backend/api.py 源码：删除后门禁的唯一事实源是
     deliverables/dev-plan/frozen-python-surface.json，其锚点（按
     ^contract_baseline_r(\d+)$ 正则倒序自动发现的最新基线，r68 兜底）同时冻结了
     golden/html/源码行多重集锚点，用于与基线、与实时前端契约面做三方交叉校验
     （语义仍是「零漂移」，不是恒真）。
  4. 构建产物契约面（harbor.html 中出现的 DOM id / onclick 函数 / callApi 目标集合）；
  5. **源码行多重集哈希**：所有 frontend/src/**/*.js 的非空行 strip 后排序拼接的
     sha256。拆分只把行从一个文件移到另一个文件，只要不增删/改写任何一行，该值
     恒定 —— 这是「代码零改写、仅重新编排归属」的强证据。
  6. **逐函数定义体哈希**（R29 新增）：由 tools/function_graph.py 按顶层声明切段，
     对每个符号的定义体（剥除纯注释行/空行后）取 sha256。相比第 5 类的「全体行
     多重集」，本类能定位到**具体哪个函数**被改写，实现逐函数契约差分。

允许变化的项（记录但不判失败）：module_count、symbols 的 file 归属、styles 列表。

用法：
  python tools/contract_diff.py --snapshot <baseline.json>
  python tools/contract_diff.py --compare <baseline.json> [--report <diff.md>]

退出码：零漂移 0；任一契约面漂移 1。
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'frontend' / 'manifest.json'
SRC = ROOT / 'frontend' / 'src'
HTML = ROOT / 'harbor.html'
# 删除前置：backend/api.py 不再作为事实源；改读冻结快照（唯一事实源）。
FROZEN_SURFACE = ROOT / 'deliverables' / 'dev-plan' / 'frozen-python-surface.json'
# R68 · C 路径步骤 3：legacy 行为已冻结为 golden 快照，其哈希进入冻结面，
# 使删除 Python 实现后仍有一份独立、可校验的防漂移证据。
GOLDEN = ROOT / 'deliverables' / 'dev-plan' / 'contract-golden' / 'api-suite.json'
CHECK_DIR = ROOT / 'deliverables' / 'design'


def _load_frozen():
    """读冻结快照；缺失即判漂移（门禁不得在快照缺失时静默通过）。"""
    return json.loads(FROZEN_SURFACE.read_text(encoding='utf-8'))


def _ui_contract():
    sys.path.insert(0, str(CHECK_DIR))
    try:
        import check_contract as cc
    finally:
        sys.path.remove(str(CHECK_DIR))
    return {
        'dom_ids': sorted(set(cc.DOM_IDS) | set(cc.DYNAMIC_IDS)),
        'onclick_fns': sorted(cc.ONCLICK_FNS),
        'api_methods': sorted(cc.API_METHODS),
        'css_classes': sorted(cc.CSS_CLASSES),
        'css_vars': sorted(cc.REQUIRED_VARS),
    }


def _source_line_multiset():
    lines = []
    for p in sorted(SRC.rglob('*.js')):
        for line in p.read_text(encoding='utf-8').splitlines():
            s = line.strip()
            if s:
                lines.append(s)
    joined = '\n'.join(sorted(lines))
    return hashlib.sha256(joined.encode('utf-8')).hexdigest()


def _html_contract():
    html = HTML.read_text(encoding='utf-8')
    return {
        'dom_ids': sorted(set(re.findall(r'\bid=["\']([A-Za-z][A-Za-z0-9_-]*)["\']', html))),
        'onclick_fns': sorted(set(re.findall(r'\bonclick=["\']([A-Za-z_$][\w$]*)\s*\(', html))),
        'callapi_targets': sorted(set(re.findall(r"\bcallApi\(\s*['\"]([a-z_][a-z0-9_]*)['\"]", html))),
    }


def _function_def_hashes():
    """逐函数定义体哈希（第 6 类契约面），复用 function_graph 的切段口径。"""
    tools = str(ROOT / 'tools')
    sys.path.insert(0, tools)
    try:
        import function_graph as fg
        return {name: meta['def_hash']
                for name, meta in fg.collect()['defs'].items()}
    finally:
        sys.path.remove(tools)


def collect():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    symbols = {}
    for entry in list(manifest.get('prebuilt', [])) + list(manifest['scripts']):
        for name in entry.get('provides', []):
            symbols[name] = entry['path']
    frozen = _load_frozen()
    return {
        'module_count': len(manifest['scripts']),
        'style_count': len(manifest['styles']),
        'symbols': dict(sorted(symbols.items())),
        'ui': _ui_contract(),
        # Python 契约层已退役：契约版本与源码哈希改读冻结快照，
        # 不再读 backend/api.py 源码、不 import backend。
        'api_version': frozen['API_VERSION'],
        'api_py_sha256': frozen['api_py_sha256'],
        'golden_sha256': hashlib.sha256(GOLDEN.read_bytes()).hexdigest()
        if GOLDEN.is_file() else None,
        'html': _html_contract(),
        'source_line_multiset_sha256': _source_line_multiset(),
        'function_defs': dict(sorted(_function_def_hashes().items())),
    }


FROZEN = ('ui', 'api_version', 'api_py_sha256', 'golden_sha256', 'html',
          'source_line_multiset_sha256', 'function_defs')


def compare(base, cur):
    issues, notes = [], []
    old_syms, new_syms = set(base['symbols']), set(cur['symbols'])
    lost, added = sorted(old_syms - new_syms), sorted(new_syms - old_syms)
    if lost:
        issues.append('顶层符号丢失(%d): %s' % (len(lost), ', '.join(lost)))
    if added:
        issues.append('顶层符号新增(%d): %s' % (len(added), ', '.join(added)))
    moved = [(k, base['symbols'][k], cur['symbols'][k]) for k in sorted(old_syms & new_syms)
             if base['symbols'][k] != cur['symbols'][k]]
    if moved:
        notes.append('符号归属迁移 %d 项（允许）' % len(moved))
    for key in FROZEN:
        if base.get(key) != cur.get(key):
            issues.append('契约面漂移: %s' % key)
            if isinstance(base.get(key), dict) and isinstance(cur.get(key), dict):
                for sub in sorted(set(base[key]) | set(cur[key])):
                    if base[key].get(sub) != cur[key].get(sub):
                        b, c = base[key].get(sub), cur[key].get(sub)
                        if isinstance(b, list) and isinstance(c, list):
                            issues.append('  %s: 丢失=%s 新增=%s' %
                                          (sub, sorted(set(b) - set(c)), sorted(set(c) - set(b))))
                        else:
                            issues.append('  %s: %r -> %r' % (sub, b, c))
            else:
                issues.append('  %r -> %r' % (base.get(key), cur.get(key)))
    notes.append('模块数 %d -> %d（允许）' % (base['module_count'], cur['module_count']))
    notes.append('样式数 %d -> %d（应不变）' % (base['style_count'], cur['style_count']))
    if base['style_count'] != cur['style_count']:
        issues.append('样式数变化')
    return issues, notes, moved


_BASELINE_KEY_RE = re.compile(r'^contract_baseline_r(\d+)$')


def _frozen_anchor(frozen):
    """冻结锚点链：按版本号倒序**自动发现**最新基线（D-05 修复）。

    旧实现把 ANCHOR_CHAIN 硬编码成 ('contract_baseline_r89', 'contract_baseline_r68')，
    与 tests/test_contract_diff.py 的自动发现口径不一致：测试按正则找最新基线，
    门禁却只认写死的两个键 —— 一旦快照推进到 r90，测试通过而门禁仍拿 r89 当锚点，
    两边判的不是同一件事。现统一为「正则发现 + 最高版本优先 + r68 兜底」。

    fail-closed 语义未变：找到的锚点仍要与基线、实时契约面严格三方相等；
    找不到任何 anchor 键即 KeyError（不允许「无锚点也算通过」）。
    """
    candidates = []
    for key, val in frozen.items():
        if isinstance(val, dict):
            m = _BASELINE_KEY_RE.match(str(key))
            if m:
                candidates.append((int(m.group(1)), key, val))
    candidates.sort(key=lambda item: item[0], reverse=True)
    for _ver, _key, anchor in candidates:
        return anchor
    fallback = frozen.get('contract_baseline_r68')
    if isinstance(fallback, dict):
        return fallback
    raise KeyError('contract_baseline_r68')


def verify_frozen_anchor(base, cur):
    """删除后「零漂移」语义：冻结锚点 / 基线 / 实时契约面三方交叉校验。

    冻结快照的 contract_baseline_r68 保存了退役时的 api_py_sha256、golden_sha256、
    html、source_line_multiset_sha256 锚点。基线或实时前端契约面任一与锚点不符，
    都判漂移——不是恒真、也不因 backend/ 删除而放宽判定。

    R89：锚点链按正则倒序自动发现（contract_baseline_r89 → … → r68 兜底，D-05）。
    灰度可用化本轮改了 frontend/src/core/bridge.js 与 frontend/src/agent/tool-executor.js
    （C3 头注入 + inspect_tool_schema 分发），源码行多重集必然变化，故按既有约定
    「基线更新并入库，作为下一次差分的锚点」在快照里追加 contract_baseline_r89；
    r68 锚点原样保留。判据本身一条未放宽：仍是 base == anchor == cur 的严格相等。
    """
    frozen = _load_frozen()
    anchor = _frozen_anchor(frozen)
    issues = []
    for name, anchor_val in (
            ('api_py_sha256', frozen['api_py_sha256']),
            ('golden_sha256', anchor['golden_sha256']),
            ('source_line_multiset_sha256', anchor['source_line_multiset_sha256'])):
        bv, cv = base.get(name), cur.get(name)
        if bv != anchor_val or cv != anchor_val:
            issues.append('冻结锚点漂移: %s（锚点=%r 基线=%r 当前=%r）'
                          % (name, anchor_val, bv, cv))
    if base.get('api_version') != frozen['API_VERSION'] or \
            cur.get('api_version') != frozen['API_VERSION']:
        issues.append('冻结锚点漂移: api_version（锚点=%r 基线=%r 当前=%r）'
                      % (frozen['API_VERSION'], base.get('api_version'),
                         cur.get('api_version')))
    if base.get('html') != anchor['html'] or cur.get('html') != anchor['html']:
        issues.append('冻结锚点漂移: html（dom_ids/onclick_fns/callapi_targets）')
    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snapshot', default='', help='写出当前契约基线 JSON')
    ap.add_argument('--compare', default='', help='与基线对比')
    ap.add_argument('--report', default='', help='对比报告输出路径（可选）')
    args = ap.parse_args()
    cur = collect()
    if args.snapshot:
        out = Path(args.snapshot)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(cur, ensure_ascii=False, indent=2), encoding='utf-8')
        print('基线已写入: %s' % out)
        print('  模块=%d 顶层符号=%d 源码行多重集=%s' %
              (cur['module_count'], len(cur['symbols']), cur['source_line_multiset_sha256'][:16]))
        return 0
    if args.compare:
        base = json.loads(Path(args.compare).read_text(encoding='utf-8'))
        issues, notes, moved = compare(base, cur)
        try:
            issues = verify_frozen_anchor(base, cur) + issues
        except (OSError, ValueError, KeyError) as exc:
            issues.append('冻结快照不可用（判定不放宽）: %s' % exc)
        lines = ['# Harbor 模块级重构 · 独立契约差分', '',
                 '结论: **%s**' % ('零漂移 PASS' if not issues else '漂移 FAIL'), '']
        lines += ['## 说明项'] + ['- ' + n for n in notes] + ['']
        if moved:
            lines += ['## 符号归属迁移（%d 项，允许）' % len(moved), '',
                      '| 符号 | 拆分前 | 拆分后 |', '|---|---|---|']
            lines += ['| `%s` | `%s` | `%s` |' % r for r in moved]
            lines.append('')
        lines += ['## 漂移项']
        lines += ['- ' + i for i in issues] if issues else ['- 无']
        text = '\n'.join(lines) + '\n'
        print(text)
        if args.report:
            Path(args.report).write_text(text, encoding='utf-8')
            print('报告已写入: %s' % args.report)
        return 1 if issues else 0
    ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
