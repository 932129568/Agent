# -*- coding: utf-8 -*-
"""W5D real headless Edge visual and interaction evidence."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'outputs' / 'expert-w5d'


def test_expert_center_edge_visual_and_interaction_evidence():
    report = json.loads((OUT / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True, report
    assert report['ordinary']['apiDelta'] == 0
    assert report['ordinary']['controllerCreated'] is False
    assert report['keyboard']['trapped'] is True
    assert report['keyboard']['closedByEscape'] is True
    assert report['keyboard']['focusReturned'] is True
    assert report['reducedMotion'] is True
    assert report['recovery']['usageDelta'] == 7
    assert report['recovery']['parentRunId'] == report['recovery']['oldRunId']
    assert report['stopped']['status'] == 'cancelled'
    assert report['scriptReads'] == 0 and report['runtimeErrors'] == []
    assert {'expertStopBtn', 'expertCenterBtn'} <= set(report['realClicks'])
    assert len(report['captures']) >= 10
    filenames = {
        'empty': 'empty-1280x720.png', 'packages': 'packages-1280x720.png',
        'error': 'error-375x812.png', 'disabled': 'disabled-768x1024.png',
        'long': 'long-375x812.png', 'selection': 'selection-1280x720.png',
        'team-timeline': 'team-timeline-1280x720.png',
        'team-timeline-mobile': 'team-timeline-375x812.png',
        'recovery': 'recovery-800x600.png', 'dark': 'team-dark-1280x720.png',
        'stopped': 'stopped-768x1024.png',
    }
    for name in report['captures']:
        assert (OUT / filenames[name]).is_file(), name
    for item in report['scenarios']:
        assert item['small'] == [] and item['overflow'] == [] and item['errors'] == []
