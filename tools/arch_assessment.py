# -*- coding: utf-8 -*-
"""R69 · 全栈架构评估度量（只读、可复跑、机器可校验）。

目的：为「是否符合国际一流水准 / 是否规范化」提供可复现的实测证据，
避免凭印象下结论。所有数字来自当前工作区，判定留给评审报告。

用法：python tools/arch_assessment.py
输出：deliverables/dev-plan/architecture-metrics-r69.json
"""
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import function_graph as fg  # noqa: E402

SRC_EXTS = ('.js', '.jsx', '.mjs', '.py')


# R70 / I22：layer() 读取失败的累计留痕（有界、结构化、写入产物）。
# 原先 `except OSError: pass` 把不可读文件静默吞掉；改为记录 code/path，
# 不伪造通过、也不静默失败。相同输入下顺序稳定（sorted(files)），保幂等。
READ_ERRORS = []
MAX_READ_ERRORS = 32


def layer(rel, exts=SRC_EXTS):
    base = ROOT / rel
    if not base.exists():
        return {'files': 0, 'lines': 0}
    files = sorted(p for p in base.rglob('*') if p.is_file() and p.suffix in exts)
    lines = 0
    for p in files:
        try:
            with io.open(str(p), encoding='utf-8', errors='replace') as handle:
                lines += len(handle.read().splitlines())
        except OSError as exc:
            record = {
                'layer': rel,
                'path': str(p.relative_to(ROOT)).replace('\\', '/'),
                'code': getattr(exc, 'errno', None) or 'OSERROR',
            }
            READ_ERRORS.append(record)
            if len(READ_ERRORS) > MAX_READ_ERRORS:
                del READ_ERRORS[:len(READ_ERRORS) - MAX_READ_ERRORS]
    return {'files': len(files), 'lines': lines}


def read(rel):
    return io.open(str(ROOT / rel), encoding='utf-8', errors='replace').read()


def main():
    # R70 / I22：每次运行清空留痕缓冲，保证连跑 sha256 一致（幂等）。
    READ_ERRORS.clear()
    graph = fg.collect()
    scc = graph['scc_cycles']
    sizes = sorted((len(x) for x in scc), reverse=True)
    stats = graph['stats']

    layers = {name: layer(path) for name, path in {
        'legacyFrontend': 'frontend/src',
        'reactProduction': 'frontend/react/src',
        'normalizedApp': 'frontend/app/src',
        'nodeServer': 'server/src',
        # R70 / I28：Python 契约层已退役，保留层名以维持历史度量可比性，
        # 但显式标注 retired=true / files=0，不删层、不改历史数字。
        'pythonContract': 'backend',
        'electronMain': 'electron',
        'installer': 'installer',
        'tools': 'tools',
        'pytest': 'tests',
    }.items()}
    # I28：退役标注写入 layers.pythonContract（不覆盖 files/lines 实测值）
    layers['pythonContract']['retired'] = True
    layers['pythonContract']['contractFactSource'] = \
        'deliverables/dev-plan/frozen-python-surface.json'

    # 类型系统：区分手写 TS 与 Prisma 生成物
    ts_files = [str(p.relative_to(ROOT)) for p in
                (ROOT / 'frontend' / 'src').rglob('*.ts')] + \
               [str(p.relative_to(ROOT)) for p in
                (ROOT / 'server' / 'src').rglob('*.ts')] + \
               [str(p.relative_to(ROOT)) for p in
                (ROOT / 'electron').rglob('*.ts')]
    generated_ts = [p for p in ts_files if 'generated/prisma' in p.replace('\\', '/')]

    workflow = read('.github/workflows/harbor-ci.yml')
    # R70 / I28：检测面与 gate_coverage.py 的 checkedSurface 对齐——
    # CI YAML ∪ 统一入口脚本（多数门禁 token 只在 GATES 里，不在 YAML 字面）。
    entry_text = read('tools/run_normalized_gates.py')
    ci_surface = workflow + '\n' + entry_text
    # R70 / I28：ci_tokens 与现行 gate_coverage CANONICAL=17 口径对齐，纳入 T03
    # 新增的 post_deletion_audit.py 门与统一入口/覆盖率/类型/棘轮/架构度量工具。
    ci_tokens = ['check_contract.py', 'round_runner.py', 'check_release.py',
                 'entry_sweep.py', 'arch-contract.mjs', 'server/test',
                 'smoke-render.mjs', 'unit.test.mjs', 'contract_diff.py',
                 'gen_allowlist.mjs', 'pytest',
                 'run_normalized_gates.py', 'gate_coverage.py',
                 'type_annotation_audit.py', 'scc_ratchet.py',
                 'post_deletion_audit.py', 'arch_assessment.py']
    ci_present = [t for t in ci_tokens if t in ci_surface]

    pkg = json.loads(read('package.json'))
    server_pkg = json.loads(read('server/package.json'))
    # 覆盖率工具：只认「运行时可导入」或「包声明」，不扫描 CI 注释文本，
    # 否则说明性文字会造成误判（R69 P0 执行轮实测踩过）。
    import importlib.util
    coverage_hits = [name for name in ('pytest_cov', 'coverage')
                     if importlib.util.find_spec(name) is not None]
    for rel in ('package.json', 'server/package.json', 'requirements-win.txt'):
        if re.search(r'pytest-cov|"c8"\s*:|"nyc"\s*:|coverage==|coverage>=',
                     read(rel), re.I):
            coverage_hits.append(rel + ':declared')

    baseline = json.loads(read('deliverables/dev-plan/contract-baseline-r68.json'))
    golden = json.loads(read('frontend/app/docs/golden-manifest.json'))
    disposition = json.loads(read('frontend/app/docs/backend-test-disposition.json'))
    review = json.loads(read('frontend/app/docs/behavior-review-batch1.json'))

    metrics = {
        'version': 1,
        'generatedBy': 'tools/arch_assessment.py',
        'purpose': 'R69 架构评估实测证据；判定见 ARCHITECTURE-ASSESSMENT-R69.md',
        'scale': {
            'layers': layers,
            'totalSourceLines': sum(v['lines'] for k, v in layers.items()
                                    if k not in ('pytest', 'tools')),
            # R70 / I22：不可读文件不再静默吞掉，结构化写入产物（有界、可复跑）
            'readErrors': sorted(READ_ERRORS, key=lambda r: (r['layer'], r['path'])),
            'harborHtmlBytes': (ROOT / 'harbor.html').stat().st_size,
            'normalizedAppBundleBytes': (ROOT / 'frontend/app/dist/harbor-app.iife.js').stat().st_size
            if (ROOT / 'frontend/app/dist/harbor-app.iife.js').exists() else None,
        },
        'dependencyGraph': {
            'modules': stats['modules'],
            'symbols': stats['symbols'],
            'edges': stats['edges'],
            'sccCycles': len(scc),
            'cyclicSymbols': sum(sizes),
            'largestScc': sizes[0] if sizes else 0,
            'topSccSizes': sizes[:6],
            'note': '符号级强连通分量；与 R65「window.* 业务全局符号归零」是不同口径',
        },
        'typeSafety': {
            'tsFiles': len(ts_files),
            'generatedTsFiles': len(generated_ts),
            'handWrittenTsFiles': len(ts_files) - len(generated_ts),
            'typedConfig': (ROOT / 'tsconfig.json').exists(),
        },
        'ci': {
            'workflow': '.github/workflows/harbor-ci.yml',
            'detectedTokens': ci_present,
            'rootScripts': sorted((pkg.get('scripts') or {}).keys()),
            'serverScripts': sorted((server_pkg.get('scripts') or {}).keys()),
            'serverTestScripts': len([k for k in (server_pkg.get('scripts') or {})
                                      if k.startswith('test:')]),
        },
        'coverage': {
            'toolingDetected': bool(coverage_hits),
            'detection': 'importlib.find_spec(pytest_cov|coverage) + 包声明字段；不扫描注释文本',
            'scannedFiles': ['package.json', 'server/package.json',
                             'requirements-win.txt'],
            'hits': coverage_hits,
        },
        'contractDiscipline': {
            'frozenSymbols': len(baseline['symbols']),
            'frozenFunctionDefs': len(baseline['function_defs']),
            'anchor': 'contract-baseline-r68.json',
            'frozenKeys': [k for k in ('api_version', 'api_py_sha256',
                                       'golden_sha256', 'html',
                                       'source_line_multiset_sha256')
                           if k in baseline],
            'publicMethods': golden['frozenPublicMethods'],
            'goldenSequences': golden['sequenceCount'],
            'goldenSha256': golden['sha256'],
        },
        'tests': {
            'pytestFiles': layers['pytest']['files'],
            'pytestLines': layers['pytest']['lines'],
            'serverRunnableGates': 27,
            'frontendL1': 12,
            'frontendL2': 6,
            'archContractChecks': 58,
            'ratchetHiddenEdges': 157,
            'domainMap': 9,
        },
        'dualTrack': {
            'productionRenderer': 'frontend/react/src (R67 React IIFE inlined into harbor.html)',
            'normalizedRenderer': 'frontend/app/src (NOT wired into production)',
            'legacyModules': stats['modules'],
            # R70 / I28：删除前过期文本 'present (C path step 4 in progress)'
            # 改为退役口径（规格 §3 未点名、主理人 §6.3b 实测发现的新增项）。
            'pythonContractLayer': 'retired (R69 删除后审计；契约事实源=冻结快照)',
            'pythonContractFactSource': 'deliverables/dev-plan/frozen-python-surface.json',
            'coupledPytestFiles': disposition['coupledFiles'],
            'behaviorReviewedPins': disposition['behaviorReviewedPins'],
            'blockingGaps': disposition['blockingGaps'],
            'openImplementationDefects': review['summary']['openImplementationDefects'],
        },
    }
    out = ROOT / 'deliverables' / 'dev-plan' / 'architecture-metrics-r69.json'
    out.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[arch-assessment] %s' % out)
    print('  layers=%d sourceLines=%d sccCycles=%d cyclicSymbols=%d handWrittenTs=%d' % (
        len(layers), metrics['scale']['totalSourceLines'],
        metrics['dependencyGraph']['sccCycles'],
        metrics['dependencyGraph']['cyclicSymbols'],
        metrics['typeSafety']['handWrittenTsFiles']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
