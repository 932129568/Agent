# -*- coding: utf-8 -*-
"""R101 · 契约锚点链（`contract_baseline_r<N>`）的 5 段负控测试。

为什么单独有这个文件
--------------------
`tools/contract_diff.py:168 _frozen_anchor()` 是**按正则倒序自动发现**最新锚点的：
  ① 只认 `^contract_baseline_r(\\d+)$`，按**数字**降序取第一个；
  ② 找不到任何 rN 键时兜底 `contract_baseline_r68`；
  ③ 连 r68 都没有才 `KeyError`（fail-closed，不允许「无锚点也算通过」）。

这三条里，①和③都是「写反了也照样绿」的类型：
  · 若按**字典序**排序，`r99` > `r100` ⇒ 会拿 r99 当锚点，而门禁与 pytest 各自
    可能是不同实现，同名判据会给出相反结论（架构文档 §0-⑪ 记的 D-05 事故就是这类）。
  · 若不 fail-closed，删掉所有锚点后门禁会静默通过 —— 那是"删掉判据"而不是"通过判据"。

所以本文件不测「当前零漂移」（那个在 `test_contract_diff.py` 里），
只测**锚点解析语义本身**，每条都是能真红的负控。

调用方式：`pytest tests/test_r101_anchor.py -q`（裸 pytest；`python -m pytest` 在本机
PATH 的解释器上没装 pytest，见 §0-⑬）。
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / 'tools' / 'contract_diff.py'
PLAN_DIR = ROOT / 'deliverables' / 'dev-plan'
FROZEN = PLAN_DIR / 'frozen-python-surface.json'


def _load_tool():
    """把 contract_diff.py 当模块导入（它是脚本，但函数是纯的、无副作用）。"""
    spec = importlib.util.spec_from_file_location('contract_diff_under_test', TOOL)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


cd = _load_tool()


def _anchor(ver, **over):
    """构造一个形状合法的锚点（html 三面 + 两个 sha）。"""
    a = {
        'api_py_sha256': 'a' * 64,
        'golden_sha256': 'g' * 64,
        'source_line_multiset_sha256': 's' * 64,
        'html': {'dom_ids': ['x'], 'onclick_fns': ['y'], 'callapi_targets': ['z']},
        'note': 'r%d' % ver,
    }
    a.update(over)
    return a


# ── ① fail-closed：一个锚点都没有时必须报错 ────────────────────────────────
def test_no_anchor_at_all_is_fail_closed():
    """空快照 / 只有无关键 ⇒ KeyError。删掉判据不等于通过判据。"""
    with pytest.raises(KeyError):
        cd._frozen_anchor({})
    with pytest.raises(KeyError):
        cd._frozen_anchor({'API_VERSION': 'x', 'api_py_sha256': 'a' * 64})


# ── ② 按数字取最大，不是按字典序 ──────────────────────────────────────────
def test_picks_numeric_max_not_lexicographic():
    """r99 与 r100 同时存在必须取 r100。
    字典序下 'contract_baseline_r99' > 'contract_baseline_r100'，
    这个用例就是钉死「不能按字符串排序」。"""
    frozen = {
        'contract_baseline_r99': _anchor(99, note='ninety-nine'),
        'contract_baseline_r100': _anchor(100, note='hundred'),
    }
    got = cd._frozen_anchor(frozen)
    assert got['note'] == 'hundred', '按字典序误选了 r99'


# ── ③ 缺口 / 兜底 ────────────────────────────────────────────────────────
def test_version_gap_still_takes_max():
    """r100 与 r102 之间缺 r101：取 r102（不要求链连续）。"""
    frozen = {
        'contract_baseline_r100': _anchor(100, note='hundred'),
        'contract_baseline_r102': _anchor(102, note='hundred-two'),
    }
    assert cd._frozen_anchor(frozen)['note'] == 'hundred-two'


def test_r68_is_the_only_fallback():
    """找不到 rN 键但有 r68 时兜底 r68——这是唯一允许的兜底，不是「随便找一个」。"""
    frozen = {'contract_baseline_r68': _anchor(68, note='fallback-68')}
    assert cd._frozen_anchor(frozen)['note'] == 'fallback-68'
    # 反过来：有 rN 时不得回落到 r68
    frozen['contract_baseline_r120'] = _anchor(120, note='real-120')
    assert cd._frozen_anchor(frozen)['note'] == 'real-120'


# ── ④ 前缀/形状不匹配的键不得被当成锚点 ──────────────────────────────────
def test_non_matching_keys_are_ignored():
    """`contract_baseline_x`（非数字）、`contract_baseline_r`（缺数字）、
    `x_contract_baseline_r999`（前缀污染）都不是锚点。

    注意：字典序下 'x_contract_baseline_r999' 会排在前面，所以这条同时守住
    「正则必须整串匹配、不能只做 substring 判断」。"""
    frozen = {
        'contract_baseline_x': _anchor(0, note='bad-x'),
        'contract_baseline_r': _anchor(0, note='bad-nodigit'),
        'x_contract_baseline_r999': _anchor(999, note='bad-prefix'),
        'contract_baseline_r100': _anchor(100, note='good'),
    }
    assert cd._frozen_anchor(frozen)['note'] == 'good'


def test_regex_is_anchored():
    """直接钉住正则本身：带前后缀、带小数、带空格一律不匹配。"""
    pat = cd._BASELINE_KEY_RE
    assert pat.match('contract_baseline_r101')
    for bad in ('xcontract_baseline_r101', 'contract_baseline_r101 ',
                'contract_baseline_r1.5', 'contract_baseline_r', 'CONTRACT_BASELINE_R101'):
        assert not pat.match(bad), bad


# ── ⑤ 真实锚点链的一致性（数据面，不是逻辑面）────────────────────────────
def test_real_anchor_chain_is_consistent_with_baseline_files():
    """真实快照里的最新锚点，必须与磁盘上编号最大的 baseline 文件同版本。

    这条守的是「锚点链与文件链脱节」：快照里追加了 r115、但基线文件还是 r114
    （或反之）时，`_frozen_anchor` 与 `_latest_baseline()` 会各取一个，判据分叉。
    """
    frozen = json.loads(FROZEN.read_text(encoding='utf-8'))
    anchor = cd._frozen_anchor(frozen)
    # 锚点自身版本
    anchor_ver = None
    for key, val in frozen.items():
        if isinstance(val, dict) and cd._BASELINE_KEY_RE.match(str(key)) and val is anchor:
            anchor_ver = int(cd._BASELINE_KEY_RE.match(str(key)).group(1))
    assert anchor_ver is not None, '取到的锚点不在任何 contract_baseline_rN 键上'

    # 磁盘上最新基线文件版本（与 tests/test_contract_diff.py 的 _latest_baseline 同口径）
    items = []
    for p in PLAN_DIR.glob('contract-baseline-r*.json'):
        m = re.search(r'-r(\d+)\.json$', p.name)
        if m:
            items.append((int(m.group(1)), p))
    assert items, '锚点链文件为空'
    file_ver = max(items, key=lambda x: x[0])[0]
    assert anchor_ver == file_ver, (
        '锚点版本 r%d 与最新基线文件 r%d 脱节' % (anchor_ver, file_ver))


def test_every_anchor_has_the_three_html_faces():
    """每个锚点都必须含 html 三面与两个 sha —— 缺字段时回滚校验取不到值，
    会在 `verify_frozen_anchor` 里抛 KeyError 而不是判漂移，容易被误读成"工具坏了"。"""
    frozen = json.loads(FROZEN.read_text(encoding='utf-8'))
    keys = [k for k, v in frozen.items()
            if isinstance(v, dict) and cd._BASELINE_KEY_RE.match(str(k))]
    assert len(keys) >= 2, '锚点链至少应保留两个版本（r68 长期兜底 + 最新）'
    for k in keys:
        a = frozen[k]
        for field in ('api_py_sha256', 'golden_sha256', 'source_line_multiset_sha256'):
            assert isinstance(a.get(field), str) and a[field], '%s 缺 %s' % (k, field)
        html = a.get('html')
        assert isinstance(html, dict), '%s 缺 html' % k
        for face in ('dom_ids', 'onclick_fns', 'callapi_targets'):
            assert isinstance(html.get(face), list) and html[face], \
                '%s 的 html 缺 %s 或为空' % (k, face)
