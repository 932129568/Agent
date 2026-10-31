# -*- coding: utf-8 -*-
"""W7-W8 conditional gates: no runtime without all evidence."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_worker_and_team_parallel_conditions_are_not_met():
    report = json.loads((ROOT / 'outputs' / 'perf' / 'w7-w8-gate.json').read_text(encoding='utf-8'))
    assert report['decisions'] == {'worker': 'NOT_STARTED', 'team_parallel': 'DISABLED'}
    assert all(condition['met'] is False for condition in report['worker_conditions'])
    assert all(condition['met'] is False for condition in report['team_parallel_conditions'])
    assert report['actions']['production_changes'] == []
    assert 'frozen exe/spawn' in report['uncovered']
    assert 'real CDP LongTask for an eligible pure CPU job' in report['uncovered']


def test_no_worker_runtime_was_created_and_team_serial_source_remains():
    assert not (ROOT / 'backend' / 'workers').exists()
    assert not (ROOT / 'frontend' / 'src' / 'workers').exists()
    source = (ROOT / 'frontend' / 'src' / 'expert' / 'orchestrator.js').read_text(encoding='utf-8')
    assert source.startswith('/* W5C synchronous serial Team orchestration')
    assert 'await this._executeModel(lead' in source
    assert 'team_parallel=true' not in source
