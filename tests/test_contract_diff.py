# -*- coding: utf-8 -*-
"""R28 独立契约差分工具自身的回归测试。

验收口径：
1. 基线存在，且当前契约面与基线零漂移；
2. 快照/自比对往返一致；
3. 工具能真实检出「符号丢失」与「源码行被改写」两类漂移（防假阳性门禁）。

R30：契约锚点是**随每轮重构/升级推进的链**（r28→r29→r30→r31…），
按用户既定约定「基线更新并入库，作为下一次差分的锚点」，此处改为自动发现
最新锚点，避免每轮手工改常量导致门禁失效。判据（零漂移）与所有断言逻辑未改。
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / 'tools' / 'contract_diff.py'
PLAN_DIR = ROOT / 'deliverables' / 'dev-plan'


def _latest_baseline():
    """锚点链最新项：contract-baseline-r<N>.json 按 N 数字升序取最大。"""
    items = []
    for p in PLAN_DIR.glob('contract-baseline-r*.json'):
        m = re.search(r'-r(\d+)\.json$', p.name)
        if m:
            items.append((int(m.group(1)), p))
    assert items, '锚点链为空'
    return max(items, key=lambda x: x[0])[1]


BASELINE = _latest_baseline()


def _run(*args):
    return subprocess.run([sys.executable, str(TOOL), *map(str, args)],
                          cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=120)


def test_baseline_exists_and_current_contract_has_zero_drift():
    """当前契约面与最新锚点零漂移；锚点链单调且最新项被采用。"""
    assert BASELINE.is_file(), '缺少契约基线'
    nums = sorted(int(re.search(r'-r(\d+)\.json$', p.name).group(1))
                  for p in PLAN_DIR.glob('contract-baseline-r*.json'))
    assert len(nums) >= 4 and nums == sorted(set(nums)), nums  # r28/r29/r30/r31 无重复
    assert BASELINE.name == 'contract-baseline-r%d.json' % max(nums)
    p = _run('--compare', BASELINE)
    assert p.returncode == 0, p.stdout + p.stderr
    assert '零漂移 PASS' in p.stdout


def test_snapshot_roundtrip(tmp_path):
    snap = tmp_path / 'snap.json'
    a = _run('--snapshot', snap)
    assert a.returncode == 0, a.stderr
    data = json.loads(snap.read_text(encoding='utf-8'))
    manifest = json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    assert data['module_count'] == len(manifest['scripts'])
    assert len(data['symbols']) >= 1000
    b = _run('--compare', snap)
    assert b.returncode == 0, b.stdout


def test_diff_detects_lost_symbol(tmp_path):
    data = json.loads(BASELINE.read_text(encoding='utf-8'))
    del data['symbols']['PRESETS']
    fake = tmp_path / 'fake.json'
    fake.write_text(json.dumps(data), encoding='utf-8')
    p = _run('--compare', fake)
    assert p.returncode == 1, p.stdout
    assert 'PRESETS' in p.stdout


def test_diff_detects_source_line_rewrite(tmp_path):
    data = json.loads(BASELINE.read_text(encoding='utf-8'))
    data['source_line_multiset_sha256'] = 'deadbeef' * 8
    fake = tmp_path / 'fake.json'
    fake.write_text(json.dumps(data), encoding='utf-8')
    p = _run('--compare', fake)
    assert p.returncode == 1, p.stdout
    assert 'source_line_multiset_sha256' in p.stdout


def test_diff_detects_ui_contract_drift(tmp_path):
    data = json.loads(BASELINE.read_text(encoding='utf-8'))
    data['ui']['dom_ids'] = [x for x in data['ui']['dom_ids'] if x != 'chatContainer']
    fake = tmp_path / 'fake.json'
    fake.write_text(json.dumps(data), encoding='utf-8')
    p = _run('--compare', fake)
    assert p.returncode == 1, p.stdout
    assert 'chatContainer' in p.stdout


def test_diff_detects_single_function_rewrite(tmp_path):
    """R29 第 6 类：篡改任一函数的定义体哈希必须被逐符号点名。"""
    data = json.loads(BASELINE.read_text(encoding='utf-8'))
    assert len(data['function_defs']) >= 1000
    name = 'connectApplyPresetNow'
    assert name in data['function_defs']
    data['function_defs'][name] = 'deadbeef' * 8
    fake = tmp_path / 'fake.json'
    fake.write_text(json.dumps(data), encoding='utf-8')
    p = _run('--compare', fake)
    assert p.returncode == 1, p.stdout
    assert name in p.stdout and 'function_defs' in p.stdout


def test_function_graph_queries_high_coupling_symbols():
    """依赖图可机读：两个点名高耦合函数都在图中且有依赖/被调用边。"""
    import subprocess
    import sys
    graph = ROOT / 'deliverables' / 'dev-plan' / 'r29-function-graph.json'
    assert graph.is_file()
    p = subprocess.run([sys.executable, str(ROOT / 'tools' / 'function_graph.py'),
                        '--graph', str(graph), '--query', 'connectApplyPresetNow',
                        '--direction', 'both', '--depth', '1'],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    assert '"connectApplyPresetNow"' in p.stdout and '"deps"' in p.stdout


def _fg(*args):
    return subprocess.run([__import__('sys').executable,
                           str(ROOT / 'tools' / 'function_graph.py'), *map(str, args)],
                          cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=90)


def test_function_graph_unknown_symbol_fails_with_hints():
    """R29 UX：未知符号非零退出 + 近似候选，不再静默 exit 0。"""
    graph = ROOT / 'deliverables' / 'dev-plan' / 'r29-function-graph.json'
    p = _fg('--graph', graph, '--query', 'connectApplyPresetNoww')
    assert p.returncode == 1, p.stdout
    assert 'ERROR' in p.stdout and '候选' in p.stdout


def test_function_graph_missing_graph_file_fails_cleanly(tmp_path):
    """R29 健壮性：图文件不存在给可读错误 + exit 2，不抛堆栈。"""
    p = _fg('--graph', tmp_path / 'nope.json', '--cycles')
    assert p.returncode == 2, p.stdout + p.stderr
    assert 'ERROR' in p.stdout and 'Traceback' not in (p.stdout + p.stderr)


def test_function_graph_build_performance_under_baseline():
    """R29 性能：缓存后构建显著低于优化前基线（三次均值 1.62s）。"""
    import time
    import sys
    sys.path.insert(0, str(ROOT / 'tools'))
    import function_graph as fg
    t = time.perf_counter()
    g = fg.collect()
    elapsed = time.perf_counter() - t
    assert g['stats']['symbols'] >= 1100
    assert elapsed < 1.2, '构建耗时 %.2fs（优化前基线 1.62s）' % elapsed


def test_family_paths_auto_derived_from_manifest():
    """R29 结构：MODULE_FAMILIES 改为自动推导，族顺序严格等于构建顺序。"""
    import sys
    sys.path.insert(0, str(ROOT / 'tests'))
    from helpers.frontend import family_paths
    fam = family_paths(str(ROOT), 'frontend/src/settings/connection.js')
    assert fam == [
        'frontend/src/settings/connection-presets.js',
        'frontend/src/settings/connection-base.js',
        'frontend/src/settings/connection.js',
    ], fam
