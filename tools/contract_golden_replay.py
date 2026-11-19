# -*- coding: utf-8 -*-
"""C 路径 · golden 契约快照校验器（**重放改快照比对**）。

【删除前置改造，2026-11-11】
原实现用独立子进程 spawn Python backend：import conftest -> 加载 legacy.Api()
-> test_api_contract.run_suite() 重放 95 项调用序列，再与
contract-golden/api-suite.json 逐项比对。Python 契约层（backend/ +
main_v1.0.0_legacy.py + 耦合 pytest）退役后这条链不存在，无法再 spawn。

现改为「重放改快照比对」：不再 spawn Python backend、不再 import conftest /
test_api_contract / backend，而是校验冻结快照
(deliverables/dev-plan/frozen-python-surface.json) 与冻结产物
(deliverables/dev-plan/contract-golden/api-suite.json、golden-manifest.json)
的一致性。这是真实的交叉校验（哈希 / 序列数 / 冻结方法面 / r68 锚点），
**不是伪造通过**：任一不一致即 FAIL + exit 1。统一门禁入口仍以本脚本作为
golden-replay 门。

用法：
  python tools/contract_golden_replay.py            # 只读校验
  python tools/contract_golden_replay.py --export  # 已停用，仅提示并执行同一校验

被 tests/test_contract_golden.py 以 subprocess 调用，不参与 pytest 收集。
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FROZEN = ROOT / 'deliverables' / 'dev-plan' / 'frozen-python-surface.json'
GOLDEN = ROOT / 'deliverables' / 'dev-plan' / 'contract-golden' / 'api-suite.json'
MANIFEST = ROOT / 'frontend' / 'app' / 'docs' / 'golden-manifest.json'


def _check(cond, label, errors):
    if not cond:
        errors.append(label)
    return bool(cond)


def main():
    errors = []
    checks = 0

    if '--export' in sys.argv:
        print('[golden] --export 已停用：95 项调用序列快照已冻结；'
              'Python 契约层已退役，请使用冻结快照或备份副本，'
              '不得再从已删除的 legacy.Api 重新导出。仅执行冻结快照比对。')
    print('[golden] 重放改快照比对：Python 契约层（backend/ + legacy.Api）已退役，'
          '不再 spawn 独立 Python backend 子进程')

    # 1. 冻结快照可读且内部自洽
    try:
        frozen = json.loads(FROZEN.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        print('[golden] FAIL 冻结快照不可读: %s' % exc)
        return 1
    anchor = frozen.get('contract_baseline_r68') or {}
    defs = frozen.get('method_defs') or []
    pub = frozen.get('public_methods') or []
    hid = frozen.get('hidden_methods') or []
    checks += 1
    _check(bool(frozen.get('api_py_sha256')) and
           frozen['api_py_sha256'] == anchor.get('api_py_sha256'),
           'api_py_sha256 顶层与 r68 锚点不一致', errors)
    checks += 1
    _check(frozen.get('API_VERSION') == 'v1.0.0',
           'API_VERSION 冻结红线被改动', errors)
    checks += 1
    _check(len(pub) == 51 and len(hid) == 117 and len(defs) == 168 and
           set(defs) == set(pub) | set(hid),
           '冻结方法面 51/117/168 不自洽（R89 起 +inspect_tool_schema）', errors)
    checks += 1
    _check(len(frozen.get('domains') or []) == 9,
           '冻结 domains 数不为 9', errors)
    checks += 1
    _check(not (set(anchor.get('html', {}).get('callapi_targets') or []) - set(defs)),
           '冻结 HTML callapi_targets 超出 method_defs', errors)

    # 2. golden 冻结产物与冻结锚点、manifest 一致性
    if not GOLDEN.is_file():
        print('[golden] FAIL 快照产物不存在: %s' % GOLDEN)
        return 1
    raw = GOLDEN.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    checks += 1
    _check(digest == anchor.get('golden_sha256'),
           'api-suite.json 哈希与冻结锚点不一致', errors)
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    checks += 1
    _check(digest == manifest.get('sha256'),
           'api-suite.json 哈希与 golden-manifest 不一致', errors)
    data = json.loads(raw.decode('utf-8'))
    checks += 1
    _check(len(data) == manifest.get('sequenceCount'),
           '调用序列数与 golden-manifest.sequenceCount 不一致', errors)
    checks += 1
    _check('get_api_info' in data and len(data) >= 60,
           'golden 序列缺少 get_api_info 或数量过少', errors)

    if errors:
        print('[golden] FAIL %d 项校验不一致：' % len(errors))
        for e in errors:
            print('  - ' + e)
        return 1
    print('[golden] %d 项交叉校验通过（冻结快照 + 冻结产物 + manifest）' % checks)
    print('[golden] PASS %d 项调用序列与冻结快照一致（重放改快照比对，非运行时重放）'
          % len(data))
    return 0


if __name__ == '__main__':
    sys.exit(main())
