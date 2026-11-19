# -*- coding: utf-8 -*-
"""R26 遗留 #3：群聊「测试端点」按钮在 callApi 桥未就绪时不再静默。

原实现直接 `await callApi('test_provider_endpoint', ...)`：桥未就绪时抛
ReferenceError，被 catch 吞成泛化「端点测试失败：callApi is not defined」，
用户看不出真因，且按钮外观无任何不可用提示。本轮落地：
  1) sync() 内按桥在线状态设置 disabled + 明确 title（下拉变化自动恢复）；
  2) 点击处理开头显式守卫 → 明确 warn toast，不再落到泛化失败分支。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GROUP_JS = ROOT / 'frontend' / 'src' / 'group' / 'group.js'


def test_bridge_guard_precedes_real_call():
    src = GROUP_JS.read_text(encoding='utf-8')
    guard = "if (typeof callApi !== 'function') {"
    assert guard in src, '点击处理缺少 callApi 桥守卫'
    call = "callApi('test_provider_endpoint'"
    assert call in src
    assert src.index(guard) < src.index(call), '桥守卫必须早于真实端点调用'
    assert '后端桥未就绪，无法测试端点' in src


def test_button_state_synced_in_sync_callback():
    src = GROUP_JS.read_text(encoding='utf-8')
    assert 'tb0.disabled = !bridgeReady' in src
    assert '后端桥未就绪，暂时无法测试端点' in src
    # 状态刷新必须位于 sync 内、且早于监听绑定 → 桥就绪后不会永久禁用
    sync_pos = src.index('const sync = () => {')
    assert sync_pos < src.index('tb0.disabled = !bridgeReady')
    assert src.index('tb0.disabled = !bridgeReady') < src.index("sel.addEventListener('change', sync)")
    assert "tb0.title = bridgeReady ? '用该端点+Key+模型发一次测试请求'" in src


def test_real_failure_toast_preserved():
    """真实端点失败提示不得被守卫吞掉（守卫只覆盖桥未就绪这一支）。"""
    src = GROUP_JS.read_text(encoding='utf-8')
    assert "toast('端点测试失败：'" in src
    assert '请等待应用加载完成后重试' in src
