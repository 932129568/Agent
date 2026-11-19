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


def test_stream_render_block_freeze_wired():
    """R39（F3a/D24）：块级冻结流式渲染——onDelta 全文重解析 O(n²) 根治。

    Node 冒烟实测（1 万字/120 delta）：全文重解析 32ms → 块级冻结 3ms（10.7x，
    真机含 DOMPurify 收益更大）；增量前提破坏（重生成/截断）自动全量重建自愈。"""
    md = (ROOT / 'frontend' / 'src' / 'components' / 'markdown.js').read_text(encoding='utf-8')
    rc = (ROOT / 'frontend' / 'src' / 'agent' / 'run-controller.js').read_text(encoding='utf-8')
    # markdown.js 提供流式原语：冻结累计（doneRaw/doneHtml）+ lexer 增量 + 轮次复位
    assert 'function renderMdStream(' in md and 'function resetMdStream(' in md
    assert 'marked.lexer' in md and 'st.doneRaw' in md and 'st.doneHtml' in md
    # onDelta 热路径走块级冻结；轮次边界（beforeRound）复位冻结前缀
    assert 'renderMdStream(mdBody, fullContent)' in rc
    assert 'resetMdStream(mdBody)' in rc
    # 轮末/流末终帧保留 renderMd 全文权威渲染（跨块语义终帧纠正，≥2 处）
    assert rc.count('renderMd(fullContent)') >= 2
