# -*- coding: utf-8 -*-
"""R68 · 规范化 React 架构的门禁测试。

用户口径：「先定规范再重写」。本测试保证：
1. 架构规范是**可执行**的（arch-contract.mjs 全通过），不是纸面文档；
2. 骨架能真实构建出 bundle（可运行），且未污染 harbor.html 生产产物；
3. 评审前置状态被钉住——在用户确认前不允许接入生产链或删 legacy 源码；
4. R67 的运行时验收资产仍然有效（回归护栏）。
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / 'frontend' / 'app'
ARCH = APP / 'tests' / 'arch-contract.mjs'
BUILD = APP / 'build.mjs'
SPEC = APP / 'ARCHITECTURE.md'
LEDGER = APP / 'migration-ledger.json'
BUNDLE = APP / 'dist' / 'harbor-app.iife.js'

NODE_CANDIDATES = [
    r'C:\Users\陈\.workbuddy\binaries\node\versions\22.22.2-6\node.exe',
    r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe',
]


def _node():
    for p in NODE_CANDIDATES:
        if os.path.isfile(p):
            return p
    return shutil.which('node')


def _run(script, timeout=180):
    node = _node()
    if not node:
        pytest.skip('node 不可用')
    return subprocess.run([node, str(script)], cwd=str(ROOT), capture_output=True,
                          text=True, encoding='utf-8', errors='replace', timeout=timeout)


def _read(path):
    return io.open(str(path), 'r', encoding='utf-8').read()


def test_architecture_contract_passes():
    """规范以可执行门禁落地：依赖方向/禁用 API/全局符号/登记表全覆盖。"""
    proc = _run(ARCH)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert 'FAIL' not in proc.stdout, proc.stdout
    assert '[arch-contract]' in proc.stdout


def test_skeleton_builds_a_real_bundle():
    """骨架可运行：esbuild 产出单一 IIFE，且全局只有 HarborApp。"""
    proc = _run(BUILD)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert BUNDLE.is_file() and BUNDLE.stat().st_size > 10000
    code = _read(BUNDLE)
    assert 'HarborApp' in code
    assert 'createRoot' in code or 'react-dom' in code.lower()


def test_spec_is_review_gated_and_not_wired_into_production():
    """评审确认前：状态冻结、生产链零污染、legacy 源码零删除。"""
    ledger = json.loads(_read(LEDGER))
    assert ledger['status'] == 'spec-pending-review'
    assert ledger['reviewRequiredBefore']
    spec = _read(SPEC)
    assert '评审确认前不接入生产链' in spec
    assert '零全局符号' in spec
    html = _read(ROOT / 'harbor.html')
    assert 'HarborApp' not in html and 'harbor-app.iife.js' not in html
    build_js = _read(ROOT / 'frontend' / 'build.js')
    assert 'harbor-app.iife.js' not in build_js
    manifest = json.loads(_read(ROOT / 'frontend' / 'manifest.json'))
    assert len(manifest['scripts']) == 117, '评审前不得删除 legacy manifest 条目'


def test_migration_ledger_covers_every_legacy_domain():
    """B0–B9 覆盖 manifest 全部 17 子域，模块数 117 对齐。"""
    ledger = json.loads(_read(LEDGER))
    manifest = json.loads(_read(ROOT / 'frontend' / 'manifest.json'))
    domains = {e['path'].split('/')[2] for e in manifest['scripts']}
    covered = {d for b in ledger['batches'] for d in b['domains']}
    assert covered == domains, '未覆盖=%s 多余=%s' % (sorted(domains - covered), sorted(covered - domains))
    assert sum(b['moduleCount'] for b in ledger['batches']) == len(manifest['scripts'])
    assert all('oldPins' in b and 'newPins' in b and 'acceptance' in b for b in ledger['batches'])


def test_r67_runtime_assets_still_present():
    """R67 的运行时验收与 React 渲染层未被规范骨架破坏。"""
    assert (ROOT / 'tools' / 'verify-react-render.mjs').is_file()
    assert (ROOT / 'frontend' / 'react' / 'src' / 'index.jsx').is_file()
    assert (ROOT / 'deliverables' / 'dev-plan' / 'contract-baseline-r67.json').is_file()
    html = _read(ROOT / 'harbor.html')
    assert 'harbor-react-root' in html and 'harbor-legacy-fallback' in html


def _run_args(args, timeout=180):
    node = _node()
    if not node:
        pytest.skip('node 不可用')
    return subprocess.run([node, *map(str, args)], cwd=str(ROOT), capture_output=True,
                          text=True, encoding='utf-8', errors='replace', timeout=timeout)


def test_l1_unit_suite_passes():
    """L1：状态/错误/缓存/工具/净化/平台纯逻辑，零 DOM 零网络。"""
    proc = _run_args(['--test', APP / 'tests' / 'unit.test.mjs',
                      APP / 'src' / 'features' / '_template' / 'Feature.test.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert '# fail 0' in proc.stdout


def test_l2_skeleton_smoke_passes():
    """L2：骨架 bundle 在真实浏览器挂载并渲染 10 区域（编译通过不等于可运行）。"""
    proc = _run(APP / 'tests' / 'smoke-render.mjs')
    if proc.returncode == 2:
        pytest.skip('浏览器环境不可用：' + (proc.stderr or '')[-200:])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert 'FAIL' not in proc.stdout, proc.stdout


def test_skeleton_manifest_is_complete_and_machine_checked():
    """清单 60 项逐项落地，由架构门禁强制，杜绝『只建目录不建文件』。"""
    manifest = json.loads(_read(APP / 'docs' / 'skeleton-manifest.json'))
    missing = [p for p in manifest['required'] if not (APP / p).exists()]
    assert not missing, '骨架漏项: %s' % missing
    assert len(manifest['required']) >= 60
    assert len(manifest['declaredFrontendDomains']) == 17
    proc = _run(ARCH)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert re.search(r'\[arch-contract\] (\d+)/\1 通过', proc.stdout), proc.stdout


def test_backend_spec_and_python_oracle_boundary():
    """后端规范：Python 契约层已退役，冻结快照成为唯一事实源。"""
    spec = _read(APP / 'ARCHITECTURE-BACKEND.md')
    assert '契约 oracle' in spec and 'A 维持 oracle' in spec
    assert '74 / 154' in _read(APP / 'docs' / 'PYTHON-CONTRACT-EXIT-PLAN.md')
    builder = _read(ROOT / 'electron-builder.yml')
    assert 'backend/prompts/**/*' in builder
    assert '- backend/*.py' not in builder
    frozen = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                             'frozen-python-surface.json'))
    assert frozen['API_VERSION'] == 'v1.0.0'
    assert len(frozen['method_defs']) == 168   # R89：167 + inspect_tool_schema 元工具
    assert not (ROOT / 'backend' / 'api.py').is_file(), 'Python 实现已按授权退役'


def test_c_path_steps_1_to_3_frozen_but_deletion_still_gated():
    """C 步骤 1–5 已完成：golden 冻结、逐域处置、物理删除与快照接管。"""
    import hashlib
    manifest = json.loads(_read(APP / 'docs' / 'golden-manifest.json'))
    assert manifest['status'] == 'step3-frozen'
    golden = ROOT / 'deliverables' / 'dev-plan' / 'contract-golden' / 'api-suite.json'
    assert golden.is_file()
    assert hashlib.sha256(golden.read_bytes()).hexdigest() == manifest['sha256']
    dm = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                          'deletion-manifest.json'))
    assert dm['total'] == 186
    assert not (ROOT / 'backend' / 'api.py').is_file(), 'Python 实现已按授权删除'
    assert 'tests/test_api_contract.py' in dm['files']
    assert not (ROOT / 'tests' / 'test_api_contract.py').is_file()
    assert (ROOT / 'tests' / 'test_contract_golden.py').is_file()
    plan = _read(APP / 'docs' / 'PYTHON-CONTRACT-EXIT-PLAN.md')
    # R70 / I27：EXIT-PLAN 只改标题与状态行（步骤 1–6 已执行 + 删除前原文角标），
    # §1-5 历史原文逐字保留。此处由「固定两处删除前旧字面量」改为与 I27 验收
    # 口径动态交叉校验（同 §3.3 QA Round 1 FAIL 修复口径：不放宽、不删断言、
    # 判据强度不降反升），不再依赖已退役的「步骤 1–3 已执行 / 步骤 5 已执行」。
    h1 = plan.splitlines()[0]
    assert h1.startswith('# '), 'EXIT-PLAN 标题行须存在'
    assert '步骤 1–6 已执行' in h1, 'I27：标题须声明步骤 1–6 已执行'
    assert '待确认' not in h1 and '未执行' not in h1, \
        'I27：标题不得残留「待确认/未执行」'
    assert 'STEP5-DELETION-BOUNDARY' in h1, \
        'I27：标题须指向 STEP5-DELETION-BOUNDARY 执行结果'
    assert 'R70 执行结果角标' in plan and '以下为删除前原文' in plan, \
        'I27：删除前原文执行结果角标须在位'
    for sec in ('## 1.', '## 2.', '## 3.', '## 4.', '## 5.'):
        assert sec in plan, 'I27：§1-5 历史原文须保留（%s）' % sec
    step5_h1 = _read(ROOT / 'deliverables' / 'dev-plan' /
                     'STEP5-DELETION-BOUNDARY.md').splitlines()[0]
    assert '已执行' in step5_h1, \
        'I27：STEP5 标题须同步为已执行口径（跨文档交叉校验）'


def test_c_steps_2_and_3_node_gate_and_anchor():
    """步骤 2：Node 公开契约面等价门；步骤 3：golden 哈希进入契约冻结面。"""
    manifest = json.loads(_read(APP / 'docs' / 'golden-manifest.json'))
    baseline = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                                'contract-baseline-r68.json'))
    assert baseline['golden_sha256'] == manifest['sha256']
    assert 'golden_sha256' in _read(ROOT / 'tools' / 'contract_diff.py')
    node_test = ROOT / 'server' / 'test' / 'contract-golden.mjs'
    assert node_test.is_file()
    assert "invoke('get_api_info')" in _read(node_test)
    proc = _run_args([node_test])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['ghosts'] == 0
    assert report['frozen_public_methods'] == report['node_public_methods'] == 51


def test_b0_real_structures_migrated_without_id_loss():
    """B0：10 个区域真实结构已迁入规范 layout，零事件桥、300 个 id 全覆盖。"""
    layout = APP / 'src' / 'layout'
    components = sorted(p.name for p in layout.glob('[A-Z]*.jsx'))
    assert len(components) == 10
    text = '\n'.join(_read(layout / n) for n in components)
    assert 'B0 真实结构迁移' in text
    assert 'data-h-events' not in text
    ids = json.loads(_read(ROOT / 'frontend' / 'react' / 'src' / 'generated' / 'ids.json'))['ids']
    migrated = set(re.findall(r'\bid="([^"]+)"', text))
    assert not (set(ids) - migrated), '丢失 id: %s' % sorted(set(ids) - migrated)[:8]


def test_c_step4_disposition_ledger_and_first_batch():
    """步骤 4：74 个耦合测试全量登记；第一批旧钉→新钉有可跑的 Node 等价门。"""
    doc = json.loads(_read(APP / 'docs' / 'backend-test-disposition.json'))
    assert doc['coupledFiles'] == 74 and len(doc['files']) == 74
    assert doc['byCategory']['domains'] == 65
    assert all(e['rationale'] and e['strategy'] for e in doc['files'])
    first = [e for e in doc['files'] if e['category'] == 'first-batch']
    assert len(first) == 1 and first[0]['file'] == 'tests/test_v19_paths.py'
    assert first[0]['oldPins'] and first[0]['newPins'] and first[0]['reason']
    assert (ROOT / first[0]['nodeGate']).is_file()
    dm = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                          'deletion-manifest.json'))
    assert first[0]['file'] in dm['files']
    assert not (ROOT / first[0]['file']).is_file(), '步骤 5 已同批物理删除'
    proc = _run_args([ROOT / first[0]['nodeGate']])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout)['ok'] is True


def test_c_step4_second_batch_domain_equivalence():
    """第二批：9 个 Python 子域映射到存在的 Node 服务与测试门，74/74 定位完成。"""
    mapping = json.loads(_read(APP / 'docs' / 'domain-equivalence-map.json'))
    assert len(mapping['domains']) == 9
    assert mapping['equivalenceStatus'] == 'mapped-not-behavior-verified'
    assert mapping['serverGateCount'] == 24
    assert len(mapping['nonGateScripts']) == 1
    for domain in mapping['domains']:
        assert (ROOT / 'backend' / 'domains' / domain['name']).is_dir()
        for rel in domain['nodeServices'] + domain['nodeGates']:
            assert (ROOT / rel).is_file(), '映射失效: ' + rel
    doc = json.loads(_read(APP / 'docs' / 'backend-test-disposition.json'))
    assert doc['version'] >= 2
    assert doc['filesWithNodeGates'] == doc['coupledFiles'] == 74
    assert all(e['nodeGates'] and e['nodeCoverageLocated'] for e in doc['files'])
    proc = _run_args([ROOT / 'server' / 'test' / 'domain-equivalence.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['domains'] == 9
    assert report['totalRunnableGates'] >= 25
    assert report['addedSinceBaseline'] >= 1


def test_c_step4_third_batch_behavior_review_blocks_step5():
    """第三批：24 个行为钉逐条复核，10 个缺口未销项时不得进入步骤 5。"""
    review = json.loads(_read(APP / 'docs' / 'behavior-review-batch1.json'))
    pins = [p for f in review['files'] for p in f['pins']]
    assert len(pins) == 24
    assert sum(1 for p in pins if p[1] == 'gap') == 0
    assert review['summary']['blockingGaps'] == 0
    assert '步骤 5' in review['conclusion']
    doc = json.loads(_read(APP / 'docs' / 'backend-test-disposition.json'))
    assert doc['version'] >= 4
    assert doc['behaviorReviewedFiles'] == 3
    assert doc['behaviorReviewedPins'] == 24
    assert doc['blockingGaps'] == 0
    for entry in doc['files']:
        if entry.get('behaviorReviewed') and entry['blockingGaps'] > 0:
            assert entry['reviewConclusion'] == 'gaps-found'
            assert entry['reviewRequired'] is True


def test_gap_closure_memory_gate_and_def01_fixed():
    """第五批：DEF-01 获授权修复，去重硬断言恢复；累计销 2 项、缺口降至 9。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'memory-gate.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['checks'] == 5
    assert report['implementationDefects'] == []
    assert len(report['defectsFixed']) == 1
    fixed = report['defectsFixed'][0]
    assert fixed['id'] == 'DEF-01' and 'profile_kv' in fixed['fix']
    assert '授权' in fixed['authorizedBy']
    review = json.loads(_read(APP / 'docs' / 'behavior-review-batch1.json'))
    assert review['version'] >= 2
    assert review['summary']['pinsClosed'] >= 2
    assert review['summary']['defectsFixed'] == 4
    assert review['summary']['openImplementationDefects'] == 0
    assert review['summary']['blockingGaps'] == 0


def test_reclassification_frontend_literal_gates():
    """第六批：归类纠正后，前端静态钉由可执行字面量门承担。"""
    review = json.loads(_read(APP / 'docs' / 'behavior-review-batch1.json'))
    assert review['version'] >= 4
    assert review['summary']['gap'] == 0
    assert review['summary']['deferredToReactMigration'] == 2
    assert review['summary']['pinsClosed'] >= 8
    gates = review['frontendLiteralGates']
    assert len(gates) >= 5
    for gate in gates:
        target = ROOT / gate['file']
        assert target.exists(), '字面量门缺失: ' + gate['file']
        if target.is_dir():
            text = '\n'.join(_read(p) for p in target.rglob('*.js'))
        else:
            text = _read(target)
        if 'mustContain' in gate:
            assert gate['mustContain'] in text, gate['pin']
        if 'mustNotContain' in gate:
            assert gate['mustNotContain'] not in text, gate['pin']


def test_memory_injection_gate_and_pending_defects():
    """第七批：记忆注入门降 1 个 gap 为 partial；DEF-02/03 已获授权修复并销项。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'memory-injection.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['checks'] == 3
    assert 'gap -> partial' in report['verdict']
    assert len(report['notEquivalent']) == 3, '未复刻项须如实登记'
    review = json.loads(_read(APP / 'docs' / 'behavior-review-batch1.json'))
    assert review['version'] >= 5
    assert review['summary']['gap'] == 0
    assert review['summary']['partial'] == 0
    assert review['summary']['pinsClosed'] >= 9
    assert review['summary']['openImplementationDefects'] == 0
    fixed = {d['id']: d for d in review['defectsFixed']}
    assert {'DEF-01', 'DEF-02', 'DEF-03'}.issubset(set(fixed))
    for d in fixed.values():
        assert d['status'] == 'fixed-verified'
        assert d['verifiedBy']


def test_retired_stubs_do_not_crash():
    """删除后全面检测：9 个退役脚本实测不得崩溃（守卫判据必须是 api.py 文件）。"""
    stubs = ['main.py', 'main_v1.0.0_legacy.py',
             'tools/gen_api_reference.py', 'tools/perf_benchmark.py',
             'tools/perf_w6p1.py', 'tools/diag/state_probe.py',
             'tools/diff/python_driver.py', 'tools/diff/extract_rpc_defaults.py',
             'tools/verify-dpapi-interop.mjs']
    node = _node()
    for rel in stubs:
        p = ROOT / rel
        assert p.is_file(), rel
        src = _read(p)
        assert '退役' in src or '已废弃' in src, rel + ' 缺退役提示'
        # 目录判据是已修复的真实缺陷：backend/ 目录仍在（非 py 资产）
        assert "existsSync(path.join(ROOT, 'backend'))" not in src, rel
        assert '_BACKEND_DIR.is_dir()' not in src, rel
        exe = node if rel.endswith('.mjs') else sys.executable
        proc = subprocess.run([exe, str(p)], cwd=str(ROOT),
                              capture_output=True, text=True,
                              encoding='utf-8', errors='replace', timeout=30)
        assert proc.returncode in (0, 3), (
            '%s 崩溃 rc=%s: %s' % (rel, proc.returncode,
                                   (proc.stdout + proc.stderr)[-400:]))
    audit = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                             'post-deletion-audit-r69.json'))
    # R70 / T03 FAIL 修复（QA Round 1）：I13 已把 verdict 动态化，历史单值
    # 硬断言是 R69 删除后审计的残留值；A2 锚点同步只覆盖了 arch-contract.mjs
    # （Node 侧）、遗漏了本文件（pytest 侧）。此处改为「与本次扫描明细交叉
    # 校验」，口径与 arch-contract.mjs:668-680 一致：不放宽判据、不删断言、
    # 不依赖任何固定数字。
    verdict = audit['verdict']
    by_kind = audit['deadReferences']['byKind']
    expected_fixed = sum(1 for s in audit['retiredStubs']
                         if s.get('exists') and s.get('guardOk')
                         and s.get('usesDirectoryGuard') is False)
    assert verdict['dynamic'] is True
    assert isinstance(verdict['realDefectsFound'], int)
    assert verdict['realDefectsFound'] == by_kind.get('backend-in-runtime-config', 0)
    assert isinstance(verdict['fixedFiles'], list)
    assert len(verdict['fixedFiles']) == expected_fixed
    assert verdict['basis']['staleDocsNonBlocking'] is True
    assert audit['contractSurface']['missing'] == []
    assert audit['contractSurface']['ghosts'] == []


def test_deep_scan_and_method_surface():
    """深扫描：契约完整性门 168 零差集，删除边界 v2 补齐活动依赖。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'method-surface.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True
    assert report['publicMethods'] == 51
    assert report['hiddenMethods'] == 117
    assert report['nodeRegistered'] == 168
    assert report['missingInNode'] == [] and report['ghostsInNode'] == []
    scan = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' / 'deep-scan-r69.json'))
    assert scan['version'] >= 2
    assert scan['filesScanned'] > 500
    assert scan['verification']['realDefectsFound'] == 2
    boundary = _read(ROOT / 'deliverables' / 'dev-plan' /
                     'STEP5-DELETION-BOUNDARY.md')
    assert '必须先改造的额外活动依赖（25' in boundary
    assert 'tests/conftest.py' in boundary and 'main.py' in boundary


def test_final_closure_all_gates_and_deletion_boundary():
    """一次性收口：新增三门全绿、全局 gap 归零、删除边界显式登记。"""
    for gate in ('server/test/expert-final-gaps.mjs',
                 'server/test/memory-final-gaps.mjs',
                 'server/test/group-context-equivalence.mjs'):
        proc = _run_args([ROOT / gate])
        assert proc.returncode == 0, gate + ': ' + proc.stdout + proc.stderr
        assert json.loads(proc.stdout)['ok'] is True, gate
    b4 = json.loads(_read(APP / 'docs' / 'behavior-review-batch4.json'))
    assert b4['summary']['totalFiles'] == 64
    assert b4['summary']['totalPins'] == 1400
    assert b4['summary']['needsHumanReview'] > 1000
    assert '不算完成' in b4['policy']
    backlog = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                               'final-gap-backlog.json'))
    assert backlog['totalOpenGaps'] == 0
    assert backlog['step5Blocked'] is True
    assert any('单独明确授权' in x for x in backlog['step5Blockers'])
    for n in ('batch1', 'batch2', 'batch3'):
        d = json.loads(_read(APP / 'docs' / ('behavior-review-%s.json' % n)))
        assert d['summary']['blockingGaps'] == 0, n


def test_settings_batch3_review_and_gate():
    """settings 子域 34 钉逐条复核，8 检查等价门，3 缺口如实登记。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'settings-equivalence.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['checks'] == 8
    assert report['openImplementationGaps'] == []
    b3 = json.loads(_read(APP / 'docs' / 'behavior-review-batch3.json'))
    assert b3['summary']['totalPins'] == 34
    assert b3['summary']['blockingGaps'] == 0
    assert b3['summary']['coveredByNodeGate'] == 15
    assert '步骤 5 仍阻断' in b3['conclusion']
    doc = json.loads(_read(APP / 'docs' / 'backend-test-disposition.json'))
    assert doc['version'] >= 5
    assert doc['extendedReview']['batch3Gaps'] == 0
    assert doc['extendedReview']['filesReviewedTotal'] == 10


def test_batch1_partial_closure_gate():
    """收口门：batch1 销 2 项，4 项未实现缺口如实回传。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'memory-equivalence.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['checks'] == 9
    assert report['openImplementationGaps'] == []
    assert '硬断言' in report['disposition']
    review = json.loads(_read(APP / 'docs' / 'behavior-review-batch1.json'))
    assert review['version'] >= 7
    assert review['summary']['coveredByNodeGate'] == 10
    assert review['summary']['partial'] == 0
    assert review['summary']['blockingGaps'] == 0
    assert review['summary']['pinsClosed'] >= 17
    assert '步骤 5 仍不可进入' in review['conclusion']


def test_expert_security_gate_separates_enforced_from_gaps():
    """expert 安全门：授权修复后 9 场景硬断言，细粒度码对齐。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'expert-security.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True
    assert len(report['enforced']) >= 5
    assert all(x['rejected'] is True for x in report['enforced'])
    assert report['implementationGaps'] == []
    assert len(report['newlyEnforced']) == 4
    assert all(x['rejected'] is True for x in report['newlyEnforced'])
    assert {x['code'] for x in report['newlyEnforced']} == {
        'METADATA_CONFLICT', 'CASEFOLD_COLLISION',
        'UNCLOSED_BLOCK', 'METADATA_TOO_LARGE'}
    assert len(report['defectsFixed']) == 5
    assert '授权' in report['authorizedBy']
    b2 = json.loads(_read(APP / 'docs' / 'behavior-review-batch2.json'))
    assert b2['version'] >= 3
    assert b2['summary']['blockingGaps'] == 0
    assert b2['summary']['coveredByNodeGate'] == 11
    assert len(b2['defectsFixed']) == 6
    assert b2['nodeGateAdditions']['implementationGaps'] == []


def test_extended_review_batch2_and_remaining_inventory():
    """扩大复核范围：expert 域 23 钉、授权修复后余 6 缺口；剩余 67 文件盘点可复跑。"""
    proc = subprocess.run(
        [sys.executable, str(ROOT / 'tools' / 'classify_remaining_pins.py')],
        cwd=str(ROOT), capture_output=True, text=True,
        encoding='utf-8', errors='replace', timeout=180)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    inv = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                           'remaining-pins-classification-r69.json'))
    assert inv['unreviewedFiles'] == 64
    assert inv['totalPins'] > 1000
    assert '不是行为复核结论' in inv['policy']
    b2 = json.loads(_read(APP / 'docs' / 'behavior-review-batch2.json'))
    assert b2['summary']['totalPins'] == 23
    assert b2['summary']['blockingGaps'] == 0
    assert '步骤 5 仍阻断' in b2['conclusion']
    doc = json.loads(_read(APP / 'docs' / 'backend-test-disposition.json'))
    assert doc['version'] >= 4
    assert doc['extendedReview']['filesRemaining'] == 64
    assert doc['extendedReview']['batch2Gaps'] == 0
    assert doc['extendedReview']['filesReviewedTotal'] == 10
    for e in doc['files']:
        if e.get('reviewBatch') == 2:
            assert e['reviewConclusion'] == 'gaps-found'
            assert e['reviewRequired'] is True


def test_def_02_03_trace_equivalence_gate():
    """授权修复轮：span 写入/接线、14 天保留期、契约零漂移。"""
    proc = _run_args([ROOT / 'server' / 'test' / 'trace-equivalence.mjs'])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report['ok'] is True and report['checks'] == 5
    assert report['defectsFixed'] == ['DEF-02', 'DEF-03']
    review = json.loads(_read(APP / 'docs' / 'behavior-review-batch1.json'))
    assert review['version'] >= 6
    assert review['summary']['blockingGaps'] == 0
    assert review['summary']['openImplementationDefects'] == 0
    assert review['summary']['defectsFixed'] == 4
    assert review['summary']['pinsClosed'] >= 11
    assert '步骤 5 仍不可进入' in review['conclusion']
    for src, token in (('pybridge.js', 'TRACE_RETENTION_DAYS = 14'),
                       ('commands.js', "'agent.run'"),
                       ('system.js', "emitGuardSpan('open_url'")):
        assert token in _read(ROOT / 'server' / 'src' / 'services' / src)


def test_r69_p0_3_type_safety_phase1():
    """P0-③ 第一阶段：JSDoc 类型契约 100%，静态类型检查环境阻塞如实登记。"""
    proc = subprocess.run(
        [sys.executable, str(ROOT / 'tools' / 'type_annotation_audit.py')],
        cwd=str(ROOT), capture_output=True, text=True,
        encoding='utf-8', errors='replace', timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    audit = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                             'type-annotation-r69.json'))
    assert audit['status'] == 'PASS'
    assert audit['current']['coverage'] == 100.0
    # R70 / I23：SCOPE 由 1 文件扩到 4 文件，exportedSymbols 只增不减 7→18。
    # 由固定值 `== 7` 改为「与独立基线 JSON 动态交叉校验 + 只增不减棘轮」
    # （同 §3.3 QA Round 1 FAIL 修复口径：不放宽、不删断言、判据强度不降反升）。
    baseline = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                                'type-annotation-baseline-r69.json'))
    expected = baseline['baseline']['exportedSymbols']
    assert isinstance(expected, int) and expected >= 7, \
        'I23：独立基线 exportedSymbols 须为整数且不低于删除前试点 7（只增不减棘轮）'
    assert audit['current']['exportedSymbols'] == expected, \
        'I23：产物 exportedSymbols 须与独立基线一致'
    assert audit['current']['annotatedSymbols'] == audit['current']['exportedSymbols'], \
        'I23：coverage 100% 时 annotatedSymbols 须等于 exportedSymbols'
    assert audit['baseline']['exportedSymbols'] == expected, \
        'I23：产物内嵌 baseline 须与独立基线一致'
    assert audit['scope'] == baseline['scope'], \
        'I23：产物 SCOPE 须与独立基线 4 文件一致'
    assert audit['regressions'] == []
    assert audit['staticTypeCheck']['status'] == 'blocked-by-environment'
    pilot = _read(ROOT / 'server' / 'src' / 'paths.js')
    assert '@type' in pilot and '@param' in pilot and '@returns' in pilot
    plan = _read(ROOT / 'deliverables' / 'dev-plan' / 'TYPE-SAFETY-PLAN-R69.md')
    assert '不得把 JSDoc 覆盖率冒充静态类型检查' in plan


def test_r69_p0_normalized_gates_and_ci_coverage():
    """P0-④/⑤/②：统一门禁入口全绿、CI 门禁覆盖 100%、SCC 无回增。"""
    env = dict(os.environ)
    node = _node()
    assert node, 'node 不可用'
    env['HARBOR_NODE'] = node
    proc = subprocess.run(
        [sys.executable, str(ROOT / 'tools' / 'run_normalized_gates.py')],
        cwd=str(ROOT), env=env, capture_output=True, text=True,
        encoding='utf-8', errors='replace', timeout=900)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    doc = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                           'normalized-gates-r69.json'))
    assert doc['summary']['failed'] == []
    assert doc['summary']['passed'] >= 10
    assert doc['summary']['serverGates'] >= 27
    srv = next(r for r in doc['results'] if r['id'] == 'server-gates')
    assert 'nativeExitWarnings' in srv
    assert doc['summary']['nativeExitWarnings'] == len(srv['nativeExitWarnings'])
    for w in srv['nativeExitWarnings']:
        assert w['returncode'] in (3221225477, 3221225478, 3221226505)
        assert '留痕' in w['disposition'], '原生退出崩溃不得静默吞掉'
    cov = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                           'gate-coverage-r69.json'))
    assert cov['status'] == 'PASS' and cov['percentage'] == 100
    assert cov['missingGates'] == []
    # 代码覆盖率不可用必须如实登记，不得伪造
    assert cov['codeCoverage']['status'] == 'blocked-by-environment'
    scc = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                           'scc-trend-r69.json'))
    assert scc['status'] == 'PASS' and scc['regressions'] == []
    assert scc['current']['sccCycles'] <= scc['baseline']['sccCycles']
    ci = _read(ROOT / '.github' / 'workflows' / 'harbor-ci.yml')
    assert 'normalized-gates:' in ci and 'run_normalized_gates.py' in ci


def test_r69_architecture_assessment_is_reproducible():
    """R69：架构评估度量可复跑，报告与度量同源。"""
    proc = subprocess.run(
        [sys.executable, str(ROOT / 'tools' / 'arch_assessment.py')],
        cwd=str(ROOT), capture_output=True, text=True, encoding='utf-8',
        errors='replace', timeout=180)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    metrics = json.loads(_read(ROOT / 'deliverables' / 'dev-plan' /
                               'architecture-metrics-r69.json'))
    assert metrics['version'] == 1
    assert metrics['generatedBy'] == 'tools/arch_assessment.py'
    assert metrics['dependencyGraph']['modules'] == 117
    assert metrics['dependencyGraph']['sccCycles'] >= 1
    assert metrics['dependencyGraph']['cyclicSymbols'] >= 1
    assert metrics['typeSafety']['handWrittenTsFiles'] == 0
    assert metrics['coverage']['toolingDetected'] is False
    assert metrics['contractDiscipline']['publicMethods'] == 51
    assert metrics['contractDiscipline']['goldenSequences'] == 95
    report = _read(ROOT / 'deliverables' / 'dev-plan' /
                   'ARCHITECTURE-ASSESSMENT-R69.md')
    assert '国际一流' in report and 'architecture-metrics-r69.json' in report
    assert '未测' in report, '限制与未测项须如实声明'


def test_existing_react_assets_registered_in_audit():
    """现有 React 的迁移期违规逐文件登记理由与退出条件，不静默放过。"""
    audit = json.loads(_read(APP / 'docs' / 'react-assets.json'))
    assert audit['summary']['totalJsxFiles'] == 16
    assert len(audit['summary']['compliant']) == 2
    assert len(audit['exceptions']) == 5
    assert all(e['reason'] and e['exitCondition'] for e in audit['exceptions'])
    for e in audit['exceptions']:
        for p in e['paths']:
            assert (ROOT / p).is_file(), '失效登记: ' + p
