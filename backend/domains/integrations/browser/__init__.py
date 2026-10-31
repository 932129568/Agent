# -*- coding: utf-8 -*-
"""v1.9.0 M1.1 · 浏览器平台抽象包（browser/）。

包结构（设计文档 v19-m1m2-design.md §A2.1 / §A3.2）：
- ``session_base``：BrowserSession 六原语 ABC + 状态机 + 错误 taxonomy +
  公共 helper（_is_public_host/_decode_html 自 search_browser 原样上移）；
- ``session_win``：SearchBrowser（自 search_browser.py 原样迁）+ WinSession
  适配类（M1.5；六原语 → SearchBrowser 通道）；
- ``session_headless``：HeadlessSession urllib 无头后端骨架（M1.11）；
- ``service`` / ``adapters`` / ``extract``：搜索栈自 search_service /
  search_adapters / search_extract **原样迁**（T02；仅 import 行更新，
  行为零变——既有测试只改 import 行即全绿）；
- ``platform``：平台服务抽象（base：七接口 ABC）+ Windows 适配（win）+
  工厂（get_platform_services）。

工厂入口：
- ``detect_platform()``：sys.platform → 'win' | 'mac' | 'headless'；
- ``create_session(platform='', **kw)``：'win'→WinSession；'headless'→
  HeadlessSession；'mac'→ BrowserError(UNSUPPORTED_PLATFORM)（M4 前）；
  未知 → BrowserError(BAD_PARAMS)。

抽象工厂 + 鸭子类型兼容（设计文档 §A1.2）：browser/service.py 只依赖通道的
open_url(url)，SearchBrowser 与 WinSession 均可注入——迁移期零行为变化。
"""
import sys

from .session_base import (BrowserError, BrowserErrorCode, BrowserSession,
                           SessionState)

__all__ = [
    'BrowserError', 'BrowserErrorCode', 'BrowserSession', 'SessionState',
    'detect_platform', 'create_session',
]


def detect_platform():
    """sys.platform → 'win' | 'mac' | 'headless'（win32→win；darwin→mac；其余→headless）。"""
    if sys.platform.startswith('win'):
        return 'win'
    if sys.platform == 'darwin':
        return 'mac'
    return 'headless'


def create_session(platform='', **kw):
    """工厂：平台名 → BrowserSession 实例。

    Args:
        platform: 'win' | 'mac' | 'headless'；缺省 = detect_platform()。
        **kw: 透传对应会话构造参数（如 WinSession(channel=...)）。

    Returns:
        BrowserSession: WinSession / HeadlessSession 实例。

    Raises:
        BrowserError: 'mac' → UNSUPPORTED_PLATFORM（macOS 后端计划于 M4
            交付 WKWebView）；未知平台 → BAD_PARAMS。
    """
    p = str(platform or '').strip().lower() or detect_platform()
    if p == 'win':
        from .session_win import WinSession
        return WinSession(**kw)
    if p == 'headless':
        from .session_headless import HeadlessSession
        return HeadlessSession(**kw)
    if p == 'mac':
        # v1.9.0 M4（理论实现）：PyObjC 运行时就绪 → MacSession（WKWebView
        # 六原语）；否则 UNSUPPORTED_PLATFORM 结构化降级（真机验证集中 M9.5）
        from .session_mac import mac_backend_available
        if mac_backend_available():
            from .session_mac import MacSession
            return MacSession(**kw)
        raise BrowserError(
            BrowserErrorCode.UNSUPPORTED_PLATFORM,
            'macOS 浏览器后端需要 PyObjC 运行时（pip install "pywebview[cocoa]"）'
            '——未安装或非 macOS 环境不可用（真机链路验证排期 M9.5）')
    raise BrowserError(
        BrowserErrorCode.BAD_PARAMS,
        '未知平台: %r（合法值: win/mac/headless）' % platform)
