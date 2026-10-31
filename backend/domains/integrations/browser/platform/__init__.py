# -*- coding: utf-8 -*-
"""v1.9.0 M1.3/M1.4 · 平台服务子包（抽象工厂 + Windows 实现）。

- ``base``：PlatformServices ABC + Secrets/Sandbox/Screen/Trash/Paths/
  Process/Notify 七接口签名（M6 macOS 实现对映）；
- ``win``：Windows 七接口适配（DPAPI/JobObject/ImageGrab/send2trash/
  tasklist/toast；全部直委既有 service）。

工厂入口 ``get_platform_services(platform='')``：
- 'win' → WinPlatformServices（就绪）；
- 其余（含探测到的 'mac'/'headless'）→ BrowserError(UNSUPPORTED_PLATFORM)
  （mac 排期 M6；headless 不提供平台服务）。
"""
from ..session_base import BrowserError, BrowserErrorCode
from .base import (Notify, Paths, PlatformServices, Process, Sandbox, Screen,
                   Secrets, Trash)

__all__ = [
    'PlatformServices', 'Secrets', 'Sandbox', 'Screen', 'Trash', 'Paths',
    'Process', 'Notify', 'get_platform_services',
]


def get_platform_services(platform=''):
    """工厂：平台名 → PlatformServices 实例。

    Args:
        platform: 'win' | 'mac' | 'headless'；缺省 = browser.detect_platform()。

    Returns:
        PlatformServices: WinPlatformServices 实例。

    Raises:
        BrowserError: 非 win 平台 → UNSUPPORTED_PLATFORM（当前仅 win 就绪；
            mac 平台服务排期 M6）。
    """
    p = str(platform or '').strip().lower()
    if not p:
        from .. import detect_platform
        p = detect_platform()
    if p == 'win':
        from .win import WinPlatformServices
        return WinPlatformServices()
    if p == 'mac':
        # v1.9.0 M6：七接口理论实现（PyObjC 延迟 import；非 macOS 环境
        # available()=False + 操作结构化降级——真机验证集中 M9.4）
        from .mac import MacPlatformServices
        return MacPlatformServices()
    raise BrowserError(
        BrowserErrorCode.UNSUPPORTED_PLATFORM,
        '平台 %r 不提供系统服务工厂（win/mac 之外）' % p)
