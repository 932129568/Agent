# -*- coding: utf-8 -*-
"""W4B quiet controls, global pages, overlays and responsive evidence."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_SCENARIOS = {
    'plan-light-1280x720', 'mcp-dark-1280x720', 'memory-light-1280x720',
    'settings-dark-768x1024', 'plan-light-375x812', 'mcp-light-375x812',
    'memory-light-768x1024', 'settings-light-375x812',
}


def test_w4b_manifest_features_and_shared_quiet_rules():
    manifest = json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    assert len(manifest['styles']) == 14
    assert 'frontend/styles/features/generative.css' in manifest['styles']
    assert 'frontend/styles/features/expert.css' in manifest['styles']
    assert 'frontend/styles/features/collaboration.css' in manifest['styles']
    for name in ('plan', 'mcp', 'memory', 'overlays'):
        assert f'frontend/styles/features/{name}.css' in manifest['styles']
    assert manifest['styles'][-1] == 'frontend/styles/responsive.css'
    components = (ROOT / 'frontend' / 'styles' / 'components.css').read_text(encoding='utf-8')
    for selector in ('.icon-btn', '.ghost-btn', '.pill-btn:not(.primary)', '.code-copy',
                     '.toast-close', '.attach-item .remove', '.session-exp', '.session-del',
                     '.mm-del', '.mcp-tab', '.plan-ckpt-link'):
        assert selector in components
    assert 'border:1px solid transparent;background:transparent;box-shadow:none;transform:none' in components
    assert 'border-color:var(--border);background:var(--hover);transform:none' in components
    assert '.input-row .tool-btn{border-color:transparent;background:transparent}' in components
    assert '#continueNewBtn{min-height:44px' in components
    active = '\n'.join((ROOT / 'frontend' / 'styles' / name).read_text(encoding='utf-8')
                       for name in ('tokens.css', 'base.css', 'components.css', 'shell.css',
                                    'features/chat.css', 'features/plan.css', 'features/mcp.css',
                                    'features/memory.css', 'features/overlays.css', 'responsive.css'))
    for legacy_accent in ('#0F766E', '#5FC9B8', '15,118,110', '95,201,184'):
        assert legacy_accent not in active


def test_w4b_focus_keyboard_and_aria_wiring():
    overlays = (ROOT / 'frontend' / 'src' / 'components' / 'overlays.js').read_text(encoding='utf-8')
    send = (ROOT / 'frontend' / 'src' / 'chat' / 'send.js').read_text(encoding='utf-8')
    assert 'function _bindOverlayKeyboard' in overlays
    assert 'function _unbindOverlayKeyboard' in overlays
    assert '_bindOverlayKeyboard(m, _closeModal)' in overlays
    assert '_bindOverlayKeyboard(panel' in send
    assert 'aria-label="关闭通知"' in overlays
    attachments = (ROOT / 'frontend' / 'src' / 'chat' / 'attachments.js').read_text(encoding='utf-8')
    sessions = (ROOT / 'frontend' / 'src' / 'sessions' / 'controller.js').read_text(encoding='utf-8')
    assert 'aria-label="移除附件"' in attachments
    assert 'aria-label="删除会话"' in sessions


def test_w4b_quiet_buttons_real_state_and_rect_evidence():
    report = json.loads((ROOT / 'outputs' / 'ui-w4b' / 'quiet-buttons' / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True
    assert len(report['results']) == 13
    for result in report['results']:
        assert result['defaultTransparent'] is True
        assert result['hoverVisible'] is True
        assert result['focusVisible'] is True
        assert result['sizeSame'] is True
    for name in ('default-1280x720.png', 'hover-1280x720.png', 'focus-1280x720.png'):
        assert (ROOT / 'outputs' / 'ui-w4b' / 'quiet-buttons' / name).stat().st_size > 1000


def test_w4b_global_pages_mobile_keyboard_contrast_and_long_text_evidence():
    report = json.loads((ROOT / 'outputs' / 'ui-w4b' / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True
    assert report['realExe'] == 'UNCOVERED'
    assert {item['name'] for item in report['scenarios']} == EXPECTED_SCENARIOS
    for item in report['scenarios']:
        metrics = item['metrics']
        assert metrics['overflow'] == []
        assert metrics['touch'] == []
        assert metrics['documentWidth'] <= metrics['viewport'][0] + 2
        assert metrics['closeReachable'] is True
        assert metrics['planActionReachable'] is True
        assert all(entry['value'] >= 4.5 for entry in item['contrast'])
        assert all(text['scrollWidth'] <= text['clientWidth'] + 2 for text in metrics['longText'])
        assert (ROOT / 'outputs' / 'ui-w4b' / (item['name'] + '.png')).stat().st_size > 1000
    assert len(report['lowHeight']) == 2
    assert all(item['metrics']['overflow'] == [] and item['metrics']['touch'] == []
               for item in report['lowHeight'])
    assert report['focus']['mcpTrap'] == 'mcpTabTools'
    assert report['focus']['mcpReturn'] == {'closed': True, 'active': 'shortcutsBtn'}
    assert report['focus']['settingsTrap'] is True
    assert report['focus']['settingsReturn'] == {'open': False, 'active': 'shortcutsBtn'}
    assert set(report['reducedMotion'].values()) == {'none'}
    assert report['fxOff'] == 'none'
    assert report['errors'] == []
