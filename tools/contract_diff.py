# -*- coding: utf-8 -*-
"""独立契约差分（R28 模块级重构专用）。

用途：大模块拆分属破坏性变更（manifest 顺序 / 冻结计数 / 文件归属都会变），
必须有一份**独立于测试硬编码**的证据，证明拆分前后「对外契约面零漂移」。

采集五类契约面：
  1. 顶层符号集合（prebuilt + scripts 的 provides 全集）—— 拆分前后必须完全一致；
  2. UI 五大契约集合（DOM id / onclick / callApi / CSS 类 / CSS 变量）—— 直接复用
     deliverables/design/check_contract.py 的常量，避免两处口径分叉；
  3. 后端 API 契约（backend/api.py 的 sha256 + API_VERSION）—— 必须不变；
  4. 构建产物契约面（harbor.html 中出现的 DOM id / onclick 函数 / callApi 目标集合）；
  5. **源码行多重集哈希**：所有 frontend/src/**/*.js 的非空行 strip 后排序拼接的
     sha256。拆分只把行从一个文件移到另一个文件，只要不增删/改写任何一行，该值
     恒定 —— 这是「代码零改写、仅重新编排归属」的强证据。

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
API_PY = ROOT / 'backend' / 'api.py'
CHECK_DIR = ROOT / 'deliverables' / 'design'


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


def collect():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    symbols = {}
    for entry in list(manifest.get('prebuilt', [])) + list(manifest['scripts']):
        for name in entry.get('provides', []):
            symbols[name] = entry['path']
    api_src = API_PY.read_text(encoding='utf-8')
    ver = re.search(r"API_VERSION\s*=\s*['\"]([^'\"]+)['\"]", api_src)
    return {
        'module_count': len(manifest['scripts']),
        'style_count': len(manifest['styles']),
        'symbols': dict(sorted(symbols.items())),
        'ui': _ui_contract(),
        'api_version': ver.group(1) if ver else None,
        'api_py_sha256': hashlib.sha256(API_PY.read_bytes()).hexdigest(),
        'html': _html_contract(),
        'source_line_multiset_sha256': _source_line_multiset(),
    }


FROZEN = ('ui', 'api_version', 'api_py_sha256', 'html', 'source_line_multiset_sha256')


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
        lines = ['# R28 模块级重构 · 独立契约差分', '',
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
