# -*- coding: utf-8 -*-
"""G4 real Edge visual, interaction and performance evidence."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRA_IMAGES = ('state-before-1280x720.png', 'state-after-1280x720.png',
                'action-denied-1280x720.png', 'action-allowed-1280x720.png')


def test_g4_visual_state_actions_settings_and_old_entries():
    report = json.loads((ROOT / 'outputs' / 'generative-g4' / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True
    assert report['realModel'] == 'UNCOVERED' and report['realExe'] == 'UNCOVERED'
    assert len(report['captures']) == 11
    for capture in report['captures']:
        metrics = capture['metrics']
        assert metrics['overflow'] == [] and metrics['touch'] == []
        assert metrics['documentWidth'] <= metrics['viewport'][0] + 2
        assert float(metrics['focus']['outline'].replace('px', '')) > 0
        assert metrics['aria']['live'] > 0 and metrics['aria']['roles'] > 0
        assert (ROOT / 'outputs' / 'generative-g4' / (capture['name'] + '.png')).stat().st_size > 1000
    for name in EXTRA_IMAGES:
        assert (ROOT / 'outputs' / 'generative-g4' / name).stat().st_size > 1000
    assert report['settings']['block'] is True
    assert report['settings']['strict'] is False and report['settings']['actions'] is False
    before, after = report['state']['before'], report['state']['after']
    assert before['selected'] == 'true' and before['expanded'] == 'true' and before['focus'] is True
    assert after['selected'] == 'true' and after['expanded'] == 'true' and after['focus'] is True
    assert report['state']['sameEntity'] is True and report['state']['oldRevisionSafe'] is True
    assert report['actions']['denied']['buttons'] == 0
    assert report['actions']['denied']['result']['code'] == 'actions_disabled'
    assert report['actions']['allowed']['button'] is True
    assert '授权复制文本' in report['actions']['allowed']['clipboard']
    assert report['actions']['allowed']['toast']['kind'] == 'ok'
    assert report['actions']['forbidden']['code'] == 'forbidden'
    assert report['oldEntries']['passed'] is True
    assert report['reducedMotion'] == 'none' and report['fxOff'] == 'none'
    assert report['errors'] == []


def test_g4_performance_original_samples_percentiles_and_cleanup():
    report = json.loads((ROOT / 'outputs' / 'generative-g4' / 'performance.json').read_text(encoding='utf-8'))
    samples = report['samples']
    assert len(samples) == 30
    assert all(sample['firstSkeletonMs'] >= 0 and sample['firstRealBlockMs'] > 0 for sample in samples)
    assert all(sample['cleanup'] is True for sample in samples)
    assert report['firstSkeletonP95'] >= report['firstSkeletonP50'] >= 0
    assert report['firstRealBlockP95'] >= report['firstRealBlockP50'] > 0
    assert report['resourceCleanup'] == {'completed': 30, 'total': 30, 'activeGenerationAfter': False}
    assert isinstance(report['longTaskSupported'], bool)
    assert isinstance(report['longTasks'], list)
    assert report['realModel'] == 'UNCOVERED' and report['realExe'] == 'UNCOVERED'


def test_g4_settings_are_independent_and_not_config_pollution():
    source = (ROOT / 'frontend' / 'src' / 'generative' / 'settings.js').read_text(encoding='utf-8')
    assert 'harbor.uiGenerative.strictSchema' in source
    assert 'harbor.uiGenerative.actionsEnabled' in source
    assert 'ConfigService' not in source and 'queueSaveConfig' not in source and 'saveConfig' not in source
    assert 'strictSchema: uiGenerativeSettingRead' in source
    assert 'actionsEnabled: uiGenerativeSettingRead' in source
