# -*- coding: utf-8 -*-
"""R30 · 行为兼容升级的定向契约审计（不改 contract_diff.py 的 FROZEN 判据）。

背景：R28/R29 是「精确行搬移」式破坏性重构，源码行多重集与逐函数哈希恒定，
      可用 contract_diff.py 直接判零漂移。
      R30 是「行为兼容的增量升级」，必然改写函数体 —— 上述两个源码面按预期变化。
      故本工具把审计拆成两层：

  第一层（冻结，必须零漂移）：
    symbols 集合 / ui 五大契约 / api_version / api_py_sha256 /
    harbor.html 契约面 / module_count / style_count
  第二层（允许，作为升级证据逐项列明）：
    source_line_multiset_sha256 变化 → 记录 before/after
    function_defs 变化 → 变更集合必须恰为 ALLOWED_DEF_CHANGES 白名单，
                          白名单外任一函数哈希变化即判 FAIL

用法：
  python tools/upgrade_audit.py                 # 审计 r30 -> 当前工作树
  python tools/upgrade_audit.py --json out.json
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import contract_diff as cd  # noqa: E402

def _latest_baseline():
    """锚点链最新项：每轮升级后生成新锚点，审计默认对齐它（零漂移预期）。"""
    items = []
    for p in (ROOT / 'deliverables' / 'dev-plan').glob('contract-baseline-r*.json'):
        m = re.search(r'-r(\d+)\.json$', p.name)
        if m:
            items.append((int(m.group(1)), p))
    assert items, '锚点链为空'
    return max(items, key=lambda x: x[0])[1]


BASELINE = _latest_baseline()

# 对「最新锚点」审计时预期零漂移；仅当显式对比更早基线才需要白名单
# （用法：--baseline r30 --allow-defs calcUsage,accumulateUsage,...）
ALLOWED_DEF_CHANGES = set()

FROZEN_FACES = ('symbols', 'ui', 'api_version', 'api_py_sha256', 'html',
                'module_count', 'style_count')


def audit(base, cur):
    issues, notes = [], []

    # ---- 第一层：对外契约面零漂移 ----
    for key in FROZEN_FACES:
        if base.get(key) != cur.get(key):
            issues.append('对外契约面漂移: %s' % key)
            if isinstance(base.get(key), dict) and isinstance(cur.get(key), dict):
                for sub in sorted(set(base[key]) | set(cur[key])):
                    if base[key].get(sub) != cur[key].get(sub):
                        issues.append('  %s: %r -> %r' %
                                      (sub, base[key].get(sub), cur[key].get(sub)))
            else:
                issues.append('  %r -> %r' % (base.get(key), cur.get(key)))
        else:
            notes.append('%s: 零漂移' % key)

    # ---- 第二层：源码面变化作为升级证据 ----
    sl_b, sl_c = base['source_line_multiset_sha256'], cur['source_line_multiset_sha256']
    if sl_b == sl_c:
        notes.append('源码行多重集: 未变化（若预期有升级，请复核）')
    else:
        notes.append('源码行多重集: %s -> %s（升级预期）' % (sl_b[:12], sl_c[:12]))

    fd, fc = base['function_defs'], cur['function_defs']
    changed = sorted(k for k in set(fd) | set(fc) if fd.get(k) != fc.get(k))
    unexpected = [k for k in changed if k not in ALLOWED_DEF_CHANGES]
    missing = sorted(ALLOWED_DEF_CHANGES - set(changed)) if ALLOWED_DEF_CHANGES else []
    if unexpected:
        issues.append('白名单外函数定义体变化(%d): %s' %
                      (len(unexpected), ', '.join(unexpected)))
    if missing:
        issues.append('声明的升级点未发生预期变化(%d): %s' %
                      (len(missing), ', '.join(missing)))
    notes.append('函数定义体变化 %d 项（白名单 %d 项）: %s' %
                 (len(changed), len(ALLOWED_DEF_CHANGES), ', '.join(changed)))
    notes.append('白名单外变化: %d 项' % len(unexpected))
    notes.append('函数定义体总数: %d -> %d' % (len(fd), len(fc)))

    return issues, notes, changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--baseline', default=str(BASELINE))
    ap.add_argument('--allow-defs', default='',
                    help='对比更早基线时允许变化的函数名（逗号分隔）')
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    if not Path(args.baseline).is_file():
        print('ERROR: 基线不存在: %s' % args.baseline)
        return 2
    base = json.loads(Path(args.baseline).read_text(encoding='utf-8'))
    global ALLOWED_DEF_CHANGES
    if args.allow_defs:
        ALLOWED_DEF_CHANGES = {s.strip() for s in args.allow_defs.split(',') if s.strip()}
    cur = cd.collect()
    issues, notes, changed = audit(base, cur)

    print('# 行为兼容升级 · 定向契约审计')
    print()
    print('基线: %s' % Path(args.baseline).name)
    print()
    if not issues:
        print('结论: **AUDIT: PASS — 对外契约面零漂移，源码变更范围受控**')
    else:
        print('结论: **AUDIT: FAIL**')
    print()
    print('## 冻结面（对外契约）')
    for n in notes[:len(FROZEN_FACES)]:
        print('- ' + n)
    print()
    print('## 允许面（升级证据）')
    for n in notes[len(FROZEN_FACES):]:
        print('- ' + n)
    print()
    if issues:
        print('## 违规项')
        for i in issues:
            print('- ' + i)
    else:
        print('## 违规项')
        print('- 无')

    if args.json:
        Path(args.json).write_text(json.dumps({
            'pass': not issues, 'issues': issues, 'notes': notes,
            'changed_defs': changed,
            'allowed_defs': sorted(ALLOWED_DEF_CHANGES),
        }, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if not issues else 1


if __name__ == '__main__':
    sys.exit(main())
