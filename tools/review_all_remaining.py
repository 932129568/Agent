# -*- coding: utf-8 -*-
"""C 路径 · 剩余耦合测试的全量复核收口（可复跑、只读）。

对 behavior-review-batch1/2/3 未覆盖的 64 文件逐钉生成 verdict。
**诚实边界**：这是基于断言对象的规则化复核 + 每类抽样人工核验，
不是 1400 钉的逐条人工深读；`needs-human-review` 桶必须后续人工处理，
不得据此宣称「行为已验证」。

用法：python tools/review_all_remaining.py
输出：frontend/app/docs/behavior-review-batch4.json
      deliverables/dev-plan/final-gap-backlog.json

删除前置：64 文件 / 1400 钉是历史复核事实。物理删除 74 个 pytest 后重新扫描
会让数字失真，故优先重放已生成的冻结产物，保持输出与删除前一致。
"""
import io
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / 'frontend' / 'app' / 'docs'
OUT = APP / 'behavior-review-batch4.json'
BACKLOG = ROOT / 'deliverables' / 'dev-plan' / 'final-gap-backlog.json'

REVIEWED_FILES = set()
for rel in ('behavior-review-batch1.json', 'behavior-review-batch2.json',
            'behavior-review-batch3.json'):
    doc = json.loads((APP / rel).read_text(encoding='utf-8'))
    REVIEWED_FILES.update(f['file'] for f in doc['files'])

# 断言对象 → verdict。顺序即优先级（先判静态/契约，再判服务行为）。
RULES = [
    ('frontend-vm', r'__vm\.|runInContext|_run_group',
     'deferred-to-react-migration', '前端 VM 行为钉，需 B4+ 组件测试'),
    ('frontend-static', r"os\.path\.join\(ROOT,\s*'frontend'|frontend[\\/]src|Harbor\.spec|tools[\\/]build_|check_contract",
     'frontend-contract', '前端源码/打包静态钉，由字面量门与 check_contract.py 承担'),
    ('golden-contract', r'get_api_info|_V12_EXTRA|API_VERSION|api\.py.*methods|contract_diff',
     'covered-by-contract-golden', 'js_api 公开面/隐身/锚点由 golden 与契约差分门承担'),
    ('tools-script', r'tools[\\/]check_release|tools[\\/]round_runner|tools[\\/]entry_sweep|subprocess\.run',
     'python-implementation-detail', 'Python 工具脚本自身行为，删实现后随源码退役'),
    ('python-service', r'\bsvc\.|Service\(|from backend\.domains|importer\.|_service\.',
     'needs-human-review', 'Python 域服务内部行为，需逐条对照 Node 等价门'),
    ('jsapi-shape', r'\bApi\(\)|\bapi\.[a-z_]+\(|callApi\(',
     'needs-human-review', 'js_api 形状断言，需逐条对照 Node 实现'),
    ('shape-assert', r'assert ',
     'needs-human-review', '通用形状断言，需读上下文判定'),
]
VERDICT_MEANING = {
    'covered-by-contract-golden': '由 golden 冻结快照 / Node 公开契约面门承担',
    'frontend-contract': '前端静态契约钉，由 arch-contract 与 check_contract.py 承担',
    'python-implementation-detail': 'Python 工具脚本/发布线内部，删实现后随源码退役',
    'deferred-to-react-migration': '前端 VM 行为钉，待 B4 群聊域 React 组件测试',
    'needs-human-review': '规则无法判定，必须人工逐条深读，不算已复核完成',
}
# 抽样人工核验记录（实测读断言原文后给出）
SAMPLE_VERIFICATION = [
    {'file': 'tests/test_group_files.py', 'pin': 'test_handoff_parse_keeps_full_text',
     'observed': 'JS VM 调 groupContextFor / 群文件解析', 'verdict': 'deferred-to-react-migration'},
    {'file': 'tests/test_collaboration_config.py', 'pin': 'test_collaboration_off_preserves_single_model_executor_baseline',
     'observed': '读 frontend/src 源码断言执行器基线', 'verdict': 'frontend-contract'},
    {'file': 'tests/test_agent_guard_chain.py', 'pin': 'test_new_ops_in_matrix',
     'observed': 'from backend.domains... + svc. 护栏矩阵', 'verdict': 'needs-human-review'},
    {'file': 'tests/test_expert_package_security.py', 'pin': 'test_snapshot_replacement_and_link_recheck_on_every_read',
     'observed': '已在 batch2 逐条复核', 'verdict': 'batch2-covered'},
]


def classify(body):
    for kind, pattern, verdict, reason in RULES:
        if re.search(pattern, body):
            return kind, verdict, reason
    return 'unclassified', 'needs-human-review', '正则未命中，必须人工读断言原文'


def main():
    # 历史复核事实已冻结：优先重放已生成的产物（删除 74 个耦合 pytest 后
    # 不再重新扫描 tests/，batch4 与 final-gap-backlog 数字与删除前完全一致）。
    if OUT.is_file() and BACKLOG.is_file():
        frozen_doc = json.loads(OUT.read_text(encoding='utf-8'))
        frozen_backlog = json.loads(BACKLOG.read_text(encoding='utf-8'))
        OUT.write_text(json.dumps(frozen_doc, ensure_ascii=False, indent=2),
                       encoding='utf-8')
        BACKLOG.write_text(json.dumps(frozen_backlog, ensure_ascii=False, indent=2),
                           encoding='utf-8')
        print('[review-all] 重放冻结产物：%d 文件 / %d 钉 -> %s'
              % (frozen_doc['summary']['totalFiles'],
                 frozen_doc['summary']['totalPins'], OUT))
        print('  backlog 总开放缺口:', frozen_backlog['totalOpenGaps'])
        return 0
    files = []
    by_verdict = Counter()
    by_kind = Counter()
    total_pins = 0
    for p in sorted((ROOT / 'tests').glob('test_*.py')):
        rel = 'tests/' + p.name
        if rel in REVIEWED_FILES:
            continue
        src = p.read_text(encoding='utf-8', errors='replace')
        if not re.search(r'(?:from|import)\s+backend', src):
            continue
        pins = []
        for part in re.split(r'(?=^\s*def test_)', src, flags=re.M)[1:]:
            m = re.match(r'\s*def (test_\w+)', part)
            if not m:
                continue
            kind, verdict, reason = classify(part)
            pins.append([m.group(1), verdict, reason])
            by_verdict[verdict] += 1
            by_kind[kind] += 1
        total_pins += len(pins)
        files.append({'file': rel, 'pins': len(pins),
                      'dominantVerdict': Counter(x[1] for x in pins).most_common(1)[0][0]
                      if pins else 'none', 'pinsDetail': pins})
    doc = {
        'version': 1, 'batch': 'behavior-review-batch4',
        'scope': '剩余 %d 个耦合 pytest 文件 / %d 个行为钉' % (len(files), total_pins),
        'policy': '规则化复核 + 每类抽样人工核验；needs-human-review 不算完成，'
                  '不得据此销 reviewRequired 或进入步骤 5',
        'verdicts': VERDICT_MEANING,
        'sampleVerification': SAMPLE_VERIFICATION,
        'byAssertionTarget': dict(by_kind.most_common()),
        'summary': {'totalFiles': len(files), 'totalPins': total_pins,
                    'byVerdict': dict(by_verdict.most_common()),
                    'needsHumanReview': by_verdict['needs-human-review']},
        'files': files,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')

    # 汇总全局未决缺口（三份已复核证据 + 本批 needs-human-review）
    backlog = {'version': 1, 'generatedBy': 'tools/review_all_remaining.py',
               'batches': []}
    for rel in ('behavior-review-batch1.json', 'behavior-review-batch2.json',
                'behavior-review-batch3.json'):
        d = json.loads((APP / rel).read_text(encoding='utf-8'))
        gaps = [(f['file'], p[0], p[2]) for f in d['files'] for p in f['pins']
                if p[1] == 'gap']
        partials = [(f['file'], p[0]) for f in d['files'] for p in f['pins']
                    if p[1] == 'partial']
        backlog['batches'].append({
            'batch': rel, 'version': d['version'],
            'blockingGaps': d['summary'].get('blockingGaps', 0),
            'gaps': gaps, 'partials': partials,
            'openImplementationGaps': d.get('openImplementationGaps', []),
        })
    backlog['batch4'] = {'files': len(files), 'pins': total_pins,
                         'needsHumanReview': by_verdict['needs-human-review']}
    backlog['totalOpenGaps'] = sum(b['blockingGaps'] for b in backlog['batches'])
    backlog['step5Blocked'] = True
    backlog['step5Blockers'] = [
        'batch4 中 %d 个钉需人工逐条深读' % by_verdict['needs-human-review'],
        '三份已复核证据中仍有 %d 个 gap' % backlog['totalOpenGaps'],
        '物理删除 Python 实现与耦合 pytest 需用户单独明确授权',
    ]
    BACKLOG.write_text(json.dumps(backlog, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[review-all] %d 文件 / %d 钉 -> %s' % (len(files), total_pins, OUT))
    print('  byVerdict:', dict(by_verdict.most_common()))
    print('  backlog 总开放缺口:', backlog['totalOpenGaps'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
