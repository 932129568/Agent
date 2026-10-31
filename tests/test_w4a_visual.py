# -*- coding: utf-8 -*-
"""W4A manifest cascade, token and real Edge fixture evidence guards."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_w4a_manifest_cascade_and_component_usage():
    manifest = json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['styles'][:6] == [
        'frontend/styles/tokens.css', 'frontend/styles/base.css',
        'frontend/styles/legacy.css', 'frontend/styles/components.css',
        'frontend/styles/shell.css', 'frontend/styles/features/chat.css',
    ]
    template = (ROOT / 'frontend' / 'index.template.html').read_text(encoding='utf-8')
    assert 'data-ui="composer-workbench"' in template
    assert 'aria-label="消息输入"' in template
    assert 'aria-label="发送消息"' in template
    for relative in manifest['styles']:
        assert (ROOT / relative).is_file()


def test_w4a_tokens_and_accessibility_fallbacks():
    tokens = (ROOT / 'frontend' / 'styles' / 'tokens.css').read_text(encoding='utf-8')
    shell = (ROOT / 'frontend' / 'styles' / 'shell.css').read_text(encoding='utf-8')
    base = (ROOT / 'frontend' / 'styles' / 'base.css').read_text(encoding='utf-8')
    chat = (ROOT / 'frontend' / 'styles' / 'features' / 'chat.css').read_text(encoding='utf-8')
    for value in ('Aptos', '"Aptos Display"', '"Microsoft YaHei UI"',
                  '"Cascadia Code"', 'Consolas', '#F5F5F7', '#FFFFFF', '#1D1D1F',
                  '#6E6E73', '#2563EB', '--space-7:48px', '--radius-lg:20px'):
        assert value in tokens
    assert '--content-w:880px' in tokens
    assert 'border-radius:var(--radius-lg)' in shell
    assert 'max-width:var(--content-w)' in shell
    assert 'max-width:min(92%,40rem)' in chat
    assert 'prefers-reduced-motion:reduce' in base
    assert 'body.fx-off *' in base
    assert 'w4aNavIn 240ms' in shell
    assert 'w4aMainIn 240ms' in shell
    assert 'w4aInputIn 240ms' in shell
    assert '--fs-body:14px' in tokens
    assert 'radial-gradient' not in base
    active = '\n'.join((ROOT / 'frontend' / 'styles' / name).read_text(encoding='utf-8')
                       for name in ('tokens.css', 'base.css', 'components.css', 'shell.css', 'features/chat.css'))
    for legacy_accent in ('#0F766E', '#5FC9B8', '15,118,110', '95,201,184'):
        assert legacy_accent not in active


def test_w4a_edge_screenshots_layout_contrast_focus_and_motion():
    report = json.loads((ROOT / 'outputs' / 'ui-w4a' / 'layout-report.json').read_text(encoding='utf-8'))
    assert report['ok'] is True
    assert report['realExe'] == 'UNCOVERED'
    assert report['visualRevision'] == 'cobalt-neutral-final'
    assert report['supersedes'] == 'legacy-teal-screenshots'
    names = {capture['name'] for capture in report['captures']}
    assert names == {'chat-light-1280x720', 'chat-dark-1280x720', 'chat-light-375x812'}
    for capture in report['captures']:
        metrics = capture['metrics']
        assert metrics['overflow'] == []
        assert metrics['touch'] == []
        assert metrics['documentWidth'] <= metrics['viewport'][0] + 2
        assert metrics['composer']['radius'] == '20px'
        assert metrics['unnamed'] == []
        assert metrics['iconCount'] >= 8
        expected_accent = '#60A5FA' if 'dark' in capture['name'] else '#2563EB'
        assert metrics['accent'] == expected_accent
        for item in capture['contrast']:
            ratio = item['ratio'] if item.get('value') is None else item['value']
            assert ratio >= 4.5
        image = ROOT / 'outputs' / 'ui-w4a' / (capture['name'] + '.png')
        assert image.stat().st_size > 1000
        assert hashlib.sha256(image.read_bytes()).hexdigest() == capture['sha256']
        assert metrics['rail']['width'] <= metrics['viewport'][0]
        assert metrics['header']['scrollWidth'] <= metrics['header']['clientWidth'] + 2 or \
            metrics['header']['textOverflow'] == 'ellipsis'
    assert report['focus']['active'] == 'userInput'
    assert report['reducedMotion'] == {
        'rail': 'none', 'main': 'none', 'input': 'none', 'scroll': 'auto',
    }
    assert report['fxOff']['main'] == 'none'
    assert report['states']['defaultBackground'] != report['states']['hoverBackground']
    assert float(report['states']['disabledOpacity']) < 1
    assert float(report['states']['loadingOpacity']) < 1
    assert (ROOT / 'outputs' / 'ui-w4a' / 'composer-focus-1280x720.png').stat().st_size > 1000
