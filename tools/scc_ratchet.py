# -*- coding: utf-8 -*-
"""R69 P0-②：SCC 单调下降棘轮。

B0–B9 每批迁移时，legacy 前端的符号级循环依赖只应减少、不应增加。
本门把 r69 实测值冻结为基线，任何回增即判失败。

用法：python tools/scc_ratchet.py
基线：deliverables/dev-plan/scc-baseline-r69.json
输出：deliverables/dev-plan/scc-trend-r69.json
"""
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import function_graph as fg  # noqa: E402

BASELINE = ROOT / 'deliverables' / 'dev-plan' / 'scc-baseline-r69.json'
TREND = ROOT / 'deliverables' / 'dev-plan' / 'scc-trend-r69.json'


def main():
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))['baseline']
    graph = fg.collect()
    scc = graph['scc_cycles']
    sizes = sorted((len(x) for x in scc), reverse=True)
    current = {
        'sccCycles': len(scc),
        'cyclicSymbols': sum(sizes),
        'largestScc': sizes[0] if sizes else 0,
        'topSccSizes': sizes[:6],
        'modules': graph['stats']['modules'],
        'symbols': graph['stats']['symbols'],
        'edges': graph['stats']['edges'],
    }
    regressions = [k for k in ('sccCycles', 'cyclicSymbols')
                   if current[k] > baseline[k]]
    doc = {
        'version': 1,
        'policy': 'SCC 单调下降：sccCycles / cyclicSymbols 只允许减少或持平',
        'baseline': baseline,
        'current': current,
        'delta': {k: current[k] - baseline[k]
                  for k in ('sccCycles', 'cyclicSymbols', 'largestScc')},
        'regressions': regressions,
        'status': 'FAIL' if regressions else 'PASS',
    }
    TREND.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[scc-ratchet] %s cycles=%d(%+d) cyclicSymbols=%d(%+d) largest=%d' % (
        doc['status'], current['sccCycles'], doc['delta']['sccCycles'],
        current['cyclicSymbols'], doc['delta']['cyclicSymbols'],
        current['largestScc']))
    if regressions:
        print('  回归项: %s' % ', '.join(regressions))
    return 1 if regressions else 0


if __name__ == '__main__':
    raise SystemExit(main())
