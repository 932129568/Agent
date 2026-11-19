# -*- coding: utf-8 -*-
"""Focused real-Edge geometry regression for assistant chat log centering."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'outputs' / 'chat-log-centering'


def load(name):
    return json.loads((OUT / name).read_text(encoding='utf-8'))


def test_red_green_red_evidence_is_preserved():
    before = load('layout-report.json')
    after = load('layout-report-after.json')
    reverted = load('layout-report-red-reverted.json')
    assert before['containerRed'] is False and before['red'] is True
    assert after['containerRed'] is False and after['red'] is False
    assert reverted['red'] is True
    assert reverted['justifyContent'] == 'normal'
    assert abs(reverted['centerDelta']) > 2


def test_computed_center_and_three_viewport_geometry():
    report = load('layout-report-after.json')
    assert len(report['measurements']) == 3
    for item in report['measurements']:
        assert item['justifyContent'] == 'center'
        assert abs(item['geometry']['centerDelta']) <= 2
        assert abs(item['geometry']['assistantContentDelta']) <= 2
        assert abs(item['geometry']['assistantLeftBlank'] - item['geometry']['assistantRightBlank']) <= 2
        assert abs(item['geometry']['inputCenterDelta']) <= 2
        assert item['documentOverflow'] is False


def test_extended_content_user_theme_and_other_pages():
    report = load('layout-report-after.json')
    assert report['extendedPass'] is True
    extended = report['extended']
    assert all(card['insideMain'] for card in extended['cards'])
    assert extended['code']['insideMain'] is True
    assert extended['code']['scrollWidth'] >= extended['code']['clientWidth']
    assert extended['assistantJustify'] == 'center'
    assert abs(extended['assistantDelta']) <= 2
    assert extended['userDirection'] == 'row-reverse'
    assert abs(extended['userRightGap']) <= 2
    assert extended['documentOverflow'] is False
    assert report['reducedMotion'] == {'assistant': 'none', 'log': 'none'}
    assert report['otherPage']['checked'] is True
    assert report['otherPage']['overflow'] is False
    assert report['otherPage']['mainOverflow'] is False


def test_empty_state_red_green_red_and_four_viewport_geometry():
    prefix = load('empty-prefix-report.json')
    after = load('empty-after-report.json')
    reverted = load('empty-red-reverted-report.json')
    assert prefix['red'] is True
    assert after['red'] is False
    assert reverted['red'] is True
    assert len(after['measurements']) == 4
    for item in after['measurements']:
        geometry = item['geometry']
        assert abs(geometry['emptyCenterDelta']) <= 2
        assert abs(geometry['emptyBlankDifference']) <= 2
        assert abs(geometry['iconCenterDelta']) <= 2
        assert abs(geometry['titleCenterDelta']) <= 2
        assert abs(geometry['descriptionCenterDelta']) <= 2
        assert abs(geometry['inputCenterDelta']) <= 2
        assert geometry['emptyInsideLog'] is True
        assert geometry['emptyOverlapsInput'] is False
        assert item['documentOverflow'] is False
    assert after['guideCheck']['insideEmpty'] is True
    assert after['guideCheck']['guideInsideMain'] is True
    assert after['guideCheck']['documentOverflow'] is False
    assert after['guideCheck']['guideWidth'] == 340
    assert after['messaging']['userDirection'] == 'row-reverse'
    assert abs(after['messaging']['assistantCenterDelta']) <= 2
    assert abs(after['messaging']['userRightGap']) <= 2
    assert after['messaging']['documentOverflow'] is False


def test_before_after_and_reverted_screenshots_exist():
    for name in ('before-375x812.png', 'before-768x1024.png', 'before-1280x720.png',
                 'after-375x812.png', 'after-768x1024.png', 'after-1280x720.png',
                 'after-extended-1280x720.png', 'after-dark-1280x720.png',
                 'red-reverted-1280x720.png', 'empty-prefix-375x812.png',
                 'empty-prefix-768x1024.png', 'empty-prefix-1280x720.png',
                 'empty-prefix-1092x616.png', 'empty-after-375x812.png',
                 'empty-after-768x1024.png', 'empty-after-1280x720.png',
                 'empty-after-1092x616.png', 'empty-red-reverted-1092x616.png'):
        assert (OUT / name).is_file(), name
