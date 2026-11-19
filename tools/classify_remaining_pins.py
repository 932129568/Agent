# -*- coding: utf-8 -*-
"""C 步骤 4：剩余耦合测试的「断言对象」盘点（可复跑、只读）。

上一轮教训：按 import 路径归类会把前端静态钉误判为后端缺口。
本脚本按**测试函数体内的断言对象**给线索，明确标注为「机器线索，
非行为复核结论」；结论由逐条人工复核（behavior-review-batch*.json）给出。

用法：python tools/classify_remaining_pins.py
输出：deliverables/dev-plan/remaining-pins-classification-r69.json

删除前置：unreviewedFiles=64 / totalPins=1400 是历史复核事实。物理删除 74 个
pytest 后重新扫描会让数字失真，故优先重放已生成的冻结产物，保持输出不变。
"""
import io
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables' / 'dev-plan' / 'remaining-pins-classification-r69.json'

PATTERNS = [
    ('frontend-vm', r'__vm\.|runInContext|_run_group'),
    ('frontend-static', r"os\.path\.join\(ROOT,\s*'frontend'|frontend[\\/]src|Harbor\.spec|tools[\\/]build_"),
    ('jsapi-contract', r'\bApi\(\)|\bapi\.[a-z_]+\(|callApi\('),
    ('python-service', r'\bsvc\.|Service\(|from backend\.domains|importer\.'),
    ('shape-assert', r'json\.loads|assert .*\[[\'"]|assert .*=='),
]


def classify(body):
    for name, pattern in PATTERNS:
        if re.search(pattern, body):
            return name
    return 'unclassified'


def main():
    # 历史复核事实已冻结：优先重放已生成的产物（删除 74 个耦合 pytest 后
    # 不再重新扫描 tests/，unreviewedFiles / totalPins 与删除前完全一致）。
    if OUT.is_file():
        frozen_doc = json.loads(OUT.read_text(encoding='utf-8'))
        OUT.write_text(json.dumps(frozen_doc, ensure_ascii=False, indent=2),
                       encoding='utf-8')
        print('[classify] 重放冻结产物：%d 文件 / %d 钉 -> %s'
              % (frozen_doc['unreviewedFiles'], frozen_doc['totalPins'], OUT))
        print('  ', frozen_doc.get('byAssertionTarget'))
        return 0
    # 已复核集合取自两份逐条复核证据，不读台账（避免与台账生成脚本循环依赖）
    reviewed = set()
    for rel in ('frontend/app/docs/behavior-review-batch1.json',
                'frontend/app/docs/behavior-review-batch2.json',
                'frontend/app/docs/behavior-review-batch3.json'):
        doc = json.loads((ROOT / rel).read_text(encoding='utf-8'))
        reviewed.update(f['file'] for f in doc['files'])
    remaining = []
    for p in sorted((ROOT / 'tests').glob('test_*.py')):
        rel = 'tests/' + p.name
        if rel in reviewed:
            continue
        src = p.read_text(encoding='utf-8', errors='replace')
        if not re.search(r'(?:from|import)\s+backend', src):
            continue
        mods = sorted(set(re.findall(r'(?:from|import)\s+backend\.?([A-Za-z0-9_.]*)', src)))
        domains = sorted({m.split('.')[1] for m in mods
                          if m.startswith('domains.') and len(m.split('.')) > 1})
        remaining.append({'file': rel, 'domains': domains, 'lineCount': len(src.splitlines())})
    files = []
    by_class = Counter()
    total_pins = 0
    for e in remaining:
        src = io.open(str(ROOT / e['file']), encoding='utf-8', errors='replace').read()
        pins = []
        for part in re.split(r'(?=^\s*def test_)', src, flags=re.M)[1:]:
            m = re.match(r'\s*def (test_\w+)', part)
            if not m:
                continue
            kind = classify(part)
            pins.append({'name': m.group(1), 'assertionTarget': kind})
            by_class[kind] += 1
        total_pins += len(pins)
        dominant = Counter(p['assertionTarget'] for p in pins).most_common(1)
        files.append({
            'file': e['file'],
            'domains': e['domains'],
            'pins': len(pins),
            'dominantTarget': dominant[0][0] if dominant else 'none',
            'assertionTargets': dict(Counter(p['assertionTarget'] for p in pins)),
        })
    doc = {
        'version': 1,
        'generatedBy': 'tools/classify_remaining_pins.py',
        'policy': '按断言对象给出机器线索；不是行为复核结论，不得据此销项',
        'unreviewedFiles': len(remaining),
        'totalPins': total_pins,
        'byAssertionTarget': dict(by_class.most_common()),
        'categoryMeanings': {
            'frontend-vm': '前端 JS VM 行为钉，需 B4+ 组件测试',
            'frontend-static': '前端源码/打包 spec 静态钉，由字面量门承担',
            'jsapi-contract': 'js_api 契约形状钉，由 golden / contract-golden 承担',
            'python-service': 'Python 域服务内部行为，需 Node 等价门或随实现退役',
            'shape-assert': '通用形状断言，需逐条读上下文判定',
            'unclassified': '正则未命中，必须人工读断言原文',
        },
        'files': files,
        'caveat': '近半钉落在 shape-assert / unclassified，证实自动分类不足以替代逐条复核',
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[classify] %d 文件 / %d 钉 -> %s' % (
        len(remaining), total_pins, OUT))
    print('  ', dict(by_class.most_common()))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
