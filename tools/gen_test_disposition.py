# -*- coding: utf-8 -*-
"""C 路径 · 步骤 4：生成 backend 耦合测试的处置台账（可复跑、机器可校验）。

盘点 tests/test_*.py 中所有 import backend 的文件，按耦合域初分，
为每类给出处置策略与理由模板。这是「逐域处置 75/153」的第一步事实源：
台账不是结论，逐条复核随各批进行；物理删除测试统一留到步骤 5
（与删 Python 实现同一次提交，R65 教训）。

用法：python tools/gen_test_disposition.py
输出：frontend/app/docs/backend-test-disposition.json

删除前置：本台账是**历史复核事实**（74 个耦合文件 / 分类 / 逐批复核结论）。
物理删除 74 个 pytest 后重新扫描 tests/ 会让这些数字失真，故优先重放已生成的
冻结产物，保持输出与删除前一致；仅当产物缺失时才回退到原始扫描逻辑。
"""
import io
import json
import os
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / 'tests'
OUT = ROOT / 'frontend' / 'app' / 'docs' / 'backend-test-disposition.json'

IMPORT_RE = re.compile(r'(?:from|import)\s+backend\.?([A-Za-z0-9_.]*)')

# 第二批：按 backend.domains 子域把每个耦合文件定位到具体 Node 服务与测试门。
MAP_PATH = ROOT / 'frontend' / 'app' / 'docs' / 'domain-equivalence-map.json'
EQUIV_MAP = json.loads(MAP_PATH.read_text(encoding='utf-8'))
DOMAIN_GATES = {d['name']: d['nodeGates'] for d in EQUIV_MAP['domains']}
DEFAULT_GATES = EQUIV_MAP['defaultGates']

# 第三批：逐条行为复核记录（定位到门 ≠ 行为等价）。
REVIEW_PATH = ROOT / 'frontend' / 'app' / 'docs' / 'behavior-review-batch1.json'
BEHAVIOR_REVIEW = json.loads(REVIEW_PATH.read_text(encoding='utf-8'))
REVIEWED = {f['file']: f for f in BEHAVIOR_REVIEW['files']}

# 第四批：expert 子域逐条复核（扩大范围后新暴露 12 个缺口）。
REVIEW2_PATH = ROOT / 'frontend' / 'app' / 'docs' / 'behavior-review-batch2.json'
BEHAVIOR_REVIEW2 = json.loads(REVIEW2_PATH.read_text(encoding='utf-8'))
REVIEWED2 = {f['file']: f for f in BEHAVIOR_REVIEW2['files']}

# 第五批：settings 子域 3 文件 / 34 钉逐条复核（扩大范围后新暴露 3 个缺口）。
REVIEW3_PATH = ROOT / 'frontend' / 'app' / 'docs' / 'behavior-review-batch3.json'
BEHAVIOR_REVIEW3 = json.loads(REVIEW3_PATH.read_text(encoding='utf-8'))
REVIEWED3 = {f['file']: f for f in BEHAVIOR_REVIEW3['files']}

STRATEGY = {
    'domains': ('needs-node-equivalent',
                '依赖 backend.domains 纯逻辑（guard/memory/workspace/...）；先在 Node 侧补等价单测，再随实现删除'),
    'application': ('needs-node-equivalent',
                    '依赖 backend.application 编排层；先补 Node 等价用例，再随实现删除'),
    'tools_schema': ('replaced-by-node-schema',
                     '工具 schema 钉；Node 侧 contract-signatures / contract-golden 已覆盖签名与公开面'),
    'contract': ('replaced-by-golden',
                 '契约/发布纪律类；golden 冻结快照 + Node 公开契约面等价门承担，逐条复核后退役'),
    'other': ('needs-review',
              'bootstrap / errors / fio / logging_setup 等杂项；需逐文件判定归属'),

    # 第一批已人工复核并落地等价门的条目
    'first-batch': ('replaced-by-node-gate',
                    'test_v19_paths.py 的核心纪律钉（CONFIG_DIR / config.json 零污染 / 独立配置族）'
                    '已由 server/test/config-discipline.mjs 在 Node 侧等价覆盖；'
                    'Harbor.spec datas 断言属 pywebview 历史链，随步骤 5 删实现一并退役。'
                    '物理删除本测试留到步骤 5，与删实现同批提交。'),
}

FIRST_BATCH = {
    'test_v19_paths.py': {
        'category': 'first-batch',
        'nodeGate': 'server/test/config-discipline.mjs',
        'oldPins': [
            'test_new_path_constants（6 个独立配置常量落 CONFIG_DIR）',
            'test_constants_not_polluting_config_path（config.json 路径零改动、常量互异）',
            'test_ensure_dirs_creates_platform_dir（ensure_dirs 幂等建目录）',
            'test_spec_datas_has_prompts（Harbor.spec 声明 prompts / hiddenimports）',
        ],
        'newPins': [
            'server/test/config-discipline.mjs::CONFIG_PATH 指向 config.json 且 CONFIG_DIR 隔离',
            'server/test/config-discipline.mjs::运行态一律独立文件（不写 config.json）',
            'server/test/config-discipline.mjs::独立配置族文件名互异且不与 config.json 重合',
            'server/test/config-discipline.mjs::Node 侧 CONFIG_DIR 可用 HARBOR_CONFIG_DIR 隔离（等价 ensure_dirs 前置）',
        ],
        'reason': '前三项为跨语言通用的配置纪律，Node 侧可等价钉住；'
                  '第四项钉的是 pywebview 打包 spec，删除 Python 实现后该文件本身退役，'
                  '不再需要独立断言。',
    },
}


def classify(mods):
    top = {m.split('.')[0] for m in mods if m}
    if 'domains' in top:
        return 'domains'
    if 'application' in top:
        return 'application'
    if 'tools_schema' in top:
        return 'tools_schema'
    if top <= {'', 'api'}:
        return 'contract'
    return 'other'


def main():
    # 历史复核事实已冻结：优先重放已生成的产物（删除 74 个耦合 pytest 后
    # 不再重新扫描 tests/，输出数字与删除前完全一致）。
    if OUT.is_file():
        frozen_doc = json.loads(OUT.read_text(encoding='utf-8'))
        OUT.write_text(json.dumps(frozen_doc, ensure_ascii=False, indent=2),
                       encoding='utf-8')
        print('[disposition] 重放冻结产物：%d 个耦合文件，分类 %s -> %s'
              % (frozen_doc['coupledFiles'], frozen_doc['byCategory'], OUT))
        return 0
    entries = []
    for filename in sorted(p.name for p in TESTS.glob('test_*.py')):
        src = io.open(str(TESTS / filename), encoding='utf-8', errors='replace').read()
        mods = sorted(set(IMPORT_RE.findall(src)))
        if not mods:
            continue
        category = classify(mods)
        strategy, rationale = STRATEGY[category]
        entry = {
            'file': 'tests/' + filename,
            'modules': mods,
            'category': category,
            'strategy': strategy,
            'rationale': rationale,
            'reviewRequired': category not in ('first-batch',),
            'lineCount': len(src.splitlines()),
        }
        subs = sorted({m.split('.')[1] for m in mods
                       if m.startswith('domains.') and len(m.split('.')) > 1})
        located = sorted({g for s in subs for g in DOMAIN_GATES.get(s, [])})
        if not located:
            located = list(DEFAULT_GATES)
        if filename in FIRST_BATCH:
            located = sorted(set(located + [FIRST_BATCH[filename]['nodeGate']]))
        entry['domains'] = subs
        entry['nodeGates'] = located
        entry['nodeCoverageLocated'] = all((ROOT / g).is_file() for g in located)
        if filename in FIRST_BATCH:
            entry.update(FIRST_BATCH[filename])
            entry['reviewRequired'] = False
            entry['status'] = 'equivalent-gate-landed'
        if entry['file'] in REVIEWED:
            reviewed = REVIEWED[entry['file']]
            verdicts = [pin[1] for pin in reviewed['pins']]
            entry['behaviorReviewed'] = True
            entry['reviewedPins'] = len(verdicts)
            entry['verdictSummary'] = dict(Counter(verdicts))
            entry['blockingGaps'] = verdicts.count('gap')
            pending = verdicts.count('partial') + verdicts.count('deferred-to-react-migration')
            # gap 归零不等于等价：仍有 partial / deferred 未复核时不得宣称 equivalent
            entry['reviewConclusion'] = 'gaps-found' if (entry['blockingGaps'] or pending) else 'equivalent'
            entry['pendingVerdicts'] = pending
            if 'frontendGates' in reviewed:
                entry['frontendGates'] = reviewed['frontendGates']
        if entry['file'] in REVIEWED2:
            reviewed2 = REVIEWED2[entry['file']]
            verdicts2 = [pin[1] for pin in reviewed2['pins']]
            entry['reviewBatch'] = 2
            entry['batch2Pins'] = len(verdicts2)
            entry['batch2VerdictSummary'] = dict(Counter(verdicts2))
            entry['batch2Gaps'] = verdicts2.count('gap')
            entry['reviewConclusion'] = 'gaps-found'
        if entry['file'] in REVIEWED3:
            reviewed3 = REVIEWED3[entry['file']]
            verdicts3 = [pin[1] for pin in reviewed3['pins']]
            entry['reviewBatch'] = 3
            entry['batch3Pins'] = len(verdicts3)
            entry['batch3VerdictSummary'] = dict(Counter(verdicts3))
            entry['batch3Gaps'] = verdicts3.count('gap')
            entry['reviewConclusion'] = 'gaps-found' if verdicts3.count('gap') else 'equivalent'
        entries.append(entry)

    by_category = Counter(e['category'] for e in entries)
    doc = {
        'version': 5,
        'policy': 'C 路径步骤 4：逐域处置 import backend 的 pytest 文件。'
                  '机器初分 + 域等价门定位 + 逐批行为复核；'
                  '「定位到门」不等于「行为已验证」，有 blockingGaps 或 pending 的条目不得销 reviewRequired；'
                  'blockingGaps 只统计已复核范围，扩大范围可能重新暴露缺口；'
                  '物理删除测试统一在步骤 5 与删 Python 实现同一次提交。',
        'behaviorReview2': 'frontend/app/docs/behavior-review-batch2.json',
        'behaviorReview3': 'frontend/app/docs/behavior-review-batch3.json',
        'assertionClassification': 'deliverables/dev-plan/remaining-pins-classification-r69.json',
        'extendedReview': {
            'batch2Files': len(REVIEWED2),
            'batch2Pins': sum(len(f['pins']) for f in BEHAVIOR_REVIEW2['files']),
            'batch2Gaps': BEHAVIOR_REVIEW2['summary']['blockingGaps'],
            'batch2Partial': BEHAVIOR_REVIEW2['summary']['partial'],
            'batch3Files': len(REVIEWED3),
            'batch3Pins': sum(len(f['pins']) for f in BEHAVIOR_REVIEW3['files']),
            'batch3Gaps': BEHAVIOR_REVIEW3['summary']['blockingGaps'],
            'filesReviewedTotal': len(REVIEWED) + len(REVIEWED2) + len(REVIEWED3),
            'filesRemaining': len(entries) - len(REVIEWED) - len(REVIEWED2) - len(REVIEWED3),
        },
        'totalTestFiles': len(list(TESTS.glob('test_*.py'))),
        'coupledFiles': len(entries),
        'byCategory': dict(sorted(by_category.items())),
        'firstBatch': sorted(FIRST_BATCH),
        'domainEquivalenceMap': 'frontend/app/docs/domain-equivalence-map.json',
        'behaviorReview': 'frontend/app/docs/behavior-review-batch1.json',
        'behaviorReviewedFiles': sum(1 for e in entries if e.get('behaviorReviewed')),
        'behaviorReviewedPins': sum(e.get('reviewedPins', 0) for e in entries),
        'blockingGaps': sum(e.get('blockingGaps', 0) for e in entries),
        'filesWithNodeGates': sum(1 for e in entries if e['nodeCoverageLocated']),
        'preExistingRunnableGates': EQUIV_MAP['serverGateCount'],
        'strategies': {k: v[0] for k, v in STRATEGY.items()},
        'notExecuted': [
            '未删除任何 pytest 文件（留步骤 5 同批）',
            '未删除任何 Python 实现',
            '未修改 tests/conftest.py',
        ],
        'files': entries,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[disposition] %d 个耦合文件，分类 %s -> %s'
          % (len(entries), dict(by_category), OUT))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
