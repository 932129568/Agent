# -*- coding: utf-8 -*-
"""R28 独立契约差分工具自身的回归测试。

验收口径：
1. 基线存在，且当前契约面与基线零漂移；
2. 快照/自比对往返一致；
3. 工具能真实检出「符号丢失」与「源码行被改写」两类漂移（防假阳性门禁）。
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / 'tools' / 'contract_diff.py'
BASELINE = ROOT / 'deliverables' / 'dev-plan' / 'contract-baseline-r28.json'


def _run(*args):
    return subprocess.run([sys.executable, str(TOOL), *map(str, args)],
                          cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=120)


def test_baseline_exists_and_current_contract_has_zero_drift():
    assert BASELINE.is_file(), '缺少 R28 契约基线'
    p = _run('--compare', BASELINE)
    assert p.returncode == 0, p.stdout + p.stderr
    assert '零漂移 PASS' in p.stdout


def test_snapshot_roundtrip(tmp_path):
    snap = tmp_path / 'snap.json'
    a = _run('--snapshot', snap)
    assert a.returncode == 0, a.stderr
    data = json.loads(snap.read_text(encoding='utf-8'))
    assert data['module_count'] == 108
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
