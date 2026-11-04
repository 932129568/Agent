# -*- coding: utf-8 -*-
"""性能回归门禁（Round 19 实测优化）。

实测：400 条消息 renderChatHistory 1548ms → 404ms（-74%）。
根因 = addMessage 每条写 scrollTop=scrollHeight（400 次强制回流）。
本门禁锁定两处修复不回退（DOM 回流无法在 vm 断言，源码契约锁定 + CDP 实测
脚本 tools/perf_cdp.py 旁路复核）。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_addmessage_skips_scroll_during_batch_rebuild():
    src = (ROOT / 'frontend' / 'src' / 'components' / 'markdown.js').read_text(encoding='utf-8')
    assert "if (!container.classList.contains('batch')) container.scrollTop = container.scrollHeight;" in src


def test_render_chat_history_scrolls_once_at_tail():
    src = (ROOT / 'frontend' / 'src' / 'sessions' / 'controller.js').read_text(encoding='utf-8')
    assert 'box.scrollTop = box.scrollHeight;' in src


def test_theme_viewtransition_rejections_contained():
    src = (ROOT / 'frontend' / 'src' / 'shell' / 'theme.js').read_text(encoding='utf-8')
    assert 'vt.ready' in src and 'vt.finished' in src and 'vt.updateCallbackDone' in src
