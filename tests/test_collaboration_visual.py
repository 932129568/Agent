# -*- coding: utf-8 -*-
"""W5E4 real headless Edge collaboration UI evidence."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'outputs' / 'collaboration-w5e4'


def test_collaboration_edge_visual_and_interaction_evidence():
    report = json.loads((OUT / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True, report
    assert report['ordinary']['apiDelta'] == 0 and report['ordinary']['controller'] is False
    assert report['review']['status'] == 'completed'
    assert report['review']['roles'] == ['cloud-planner', 'local-worker', 'cloud-reviewer',
        'local-reviser', 'cloud-reviewer', 'local-worker', 'cloud-reviewer', 'cloud-finalizer']
    assert 'finalRef=' in report['review']['timeline'] and 'reviewDigest=' in report['review']['timeline']
    assert report['recovery']['parentRunId'] == report['recovery']['firstRunId']
    assert report['recovery']['runId'] != report['recovery']['firstRunId']
    assert report['recovery']['roles'] == ['cloud-finalizer'] and report['recovery']['usage'] == 10
    assert report['keyboard']['trapped'] and report['keyboard']['closed'] and report['keyboard']['focusReturned']
    assert report['reducedMotion'] is True and report['runtimeErrors'] == []
    for item in report['scenarios']:
        assert item['small'] == [] and item['overflow'] == [] and item['errors'] == []
    for filename in ('off-1280x720.png', 'error-375x812.png', 'review-1280x720.png',
                     'review-375x812.png', 'budget-800x600.png', 'local-only-768x1024.png',
                     'stopped-768x1024.png', 'recovery-1280x720.png', 'dark-1280x720.png'):
        assert (OUT / filename).is_file(), filename
