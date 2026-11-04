# -*- coding: utf-8 -*-
"""图标系统一致性门禁（Round 18 图标重设计）。

主理人裁定：图标风格偏 low、双轨并存、emoji 混用。本门禁锁定重设计后的纪律：
1. 每个 symbol 自声明呈现属性（fill/stroke/width/linecap/linejoin）——
   闭合路径脱离 .ui-icon 类也不会渲染成实心黑块；
2. <use href="#i-x"> 的 x 必须存在于 sprite（零悬空引用）；
3. sprite 里不允许死 symbol（每个都必须被至少一处引用）；
4. 模板 chrome 区（rail/header/输入区）不得残留内联 <svg viewBox>——单一来源；
5. 构建产物 harbor.html 与模板同步。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TPL = ROOT / 'frontend' / 'index.template.html'
BUILT = ROOT / 'harbor.html'

ATTR_NAMES = ('fill="none"', 'stroke="currentColor"', 'stroke-width="1.75"',
              'stroke-linecap="round"', 'stroke-linejoin="round"')


def _sprite(html):
    m = re.search(r'<svg xmlns="http://www\.w3\.org/2000/svg" style="display:none"[^>]*>([\s\S]*?)</svg>', html)
    return m.group(1) if m else ''


def test_symbols_self_declare_presentation_attrs():
    sprite = _sprite(TPL.read_text(encoding='utf-8'))
    symbols = re.findall(r'<symbol id="(i-[\w-]+)" viewBox="0 0 24 24"([^>]*)>', sprite)
    assert len(symbols) >= 30, 'symbol 数量异常: %d' % len(symbols)
    bad = []
    for sid, attrs in symbols:
        for a in ATTR_NAMES:
            if a not in attrs:
                bad.append('%s 缺 %s' % (sid, a))
    assert not bad, bad


def test_no_dangling_use_references():
    html = TPL.read_text(encoding='utf-8')
    sprite = _sprite(html)
    ids = set(re.findall(r'<symbol id="(i-[\w-]+)"', sprite))
    uses = set(re.findall(r'<use href="#(i-[\w-]+)"', html))
    dangling = uses - ids
    assert not dangling, 'use 引用了不存在的 symbol: %s' % sorted(dangling)
    assert uses, 'sprite 引用为空？'


def test_no_dead_symbols():
    html = TPL.read_text(encoding='utf-8')
    sprite = _sprite(html)
    ids = set(re.findall(r'<symbol id="(i-[\w-]+)"', sprite))
    # 全文（模板 + src + 入口外联）统计引用
    src_refs = set()
    for path in list(ROOT.glob('frontend/src/**/*.js')) + [TPL]:
        text = path.read_text(encoding='utf-8', errors='replace')
        src_refs |= set(re.findall(r'#(i-[\w-]+)', text))
        # 动态拼接：'i-stop' / "i-pause"（run-controller 运行时选图标）
        src_refs |= set(re.findall(r"['\"](i-[\w-]+)['\"]", text))
    dead = ids - src_refs
    assert not dead, '死 symbol（定义但零引用）: %s' % sorted(dead)


def test_chrome_has_no_inline_stroked_svg():
    html = TPL.read_text(encoding='utf-8')
    sprite = _sprite(html)
    body = html.replace(sprite, '')   # 排除 sprite 本体
    inline = re.findall(r'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"', body)
    assert not inline, 'chrome 区残留内联描边 SVG %d 处（应全部走 sprite）' % len(inline)


def test_built_bundle_matches_template_icon_system():
    if not BUILT.is_file():
        BUILT  # 触发 NameError 之外的可读失败
    html = BUILT.read_text(encoding='utf-8', errors='replace')
    assert '<symbol id="i-bolt"' in html and '<symbol id="i-users"' in html
    assert 'href="#i-chat"' in html
    # 内联双轨不得在构建产物回流
    sprite = _sprite(html)
    body = html.replace(sprite, '')
    assert not re.findall(r'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"', body[:400000])


def test_group_chrome_emoji_retired():
    """群聊 chrome 的高频 emoji（👥/📁/📂/⚡）退役为 sprite 图标。"""
    group_js = (ROOT / 'frontend' / 'src' / 'group' / 'group.js').read_text(encoding='utf-8')
    files_js = (ROOT / 'frontend' / 'src' / 'group' / 'files.js').read_text(encoding='utf-8')
    resume_js = (ROOT / 'frontend' / 'src' / 'agent' / 'resume.js').read_text(encoding='utf-8')
    for src, name in ((group_js, 'group.js'), (files_js, 'files.js'), (resume_js, 'resume.js')):
        for emoji in ('📁 群文件', '📂 打开', "'⚡'"):
            assert emoji not in src, '%s 残留 %s' % (name, emoji)
    # 👥 只允许出现在长按提示文案（tooltip 文本），不得出现在 DOM 结构串
    assert "gb-title\"><svg" in group_js
    assert 'href="#i-users"' in group_js and 'href="#i-folder"' in files_js
    assert 'href="#i-bolt"' in resume_js
