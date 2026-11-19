# -*- coding: utf-8 -*-
"""R40 桌面壳 harbor:// 协议门禁（F2d 改法①：解锁 V8 code cache）。

file:// 页在 Chromium 永远无 V8 code cache（crbug 40288216）——privileged
standard+secure+codeCache scheme 是单文件架构下不动 HTML 的最大启动收益。
Electron 侧源码契约锁定（协议处理器不可脱离 electron 运行时单测，逻辑面
以源码契约 + 真机 CDP 冒烟覆盖）。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_harbor_protocol_privileges_registered():
    src = (ROOT / 'electron' / 'main.js').read_text(encoding='utf-8')
    assert 'protocol.registerSchemesAsPrivileged' in src
    assert 'codeCache: true' in src
    assert 'standard: true' in src and 'secure: true' in src
    assert 'supportFetchAPI: true' in src
    # 必须先于 app ready（模块顶层）——registerSchemesAsPrivileged 晚调用即抛
    assert src.index('registerSchemesAsPrivileged') < src.index('async function boot()')


def test_harbor_protocol_whitelist_strict():
    """协议面即攻击面：白名单闭集 + 回退开关 + fail-closed 处理器。"""
    src = (ROOT / 'electron' / 'main.js').read_text(encoding='utf-8')
    assert 'HARBOR_LEGACY_FILE_PROTOCOL' in src          # 排障回退开关
    assert "'harbor.html'" in src
    for lib in ('libs/marked.min.js', 'libs/purify.min.js', 'libs/flate.js',
                'libs/highlight.min.js', 'libs/ui-schema.bundle.js'):
        assert lib in src, lib
    assert "new Response('not found', { status: 404 })" in src
    # hostname 校验（防 harbor://evil/ 形态）+ 异常 500
    assert "u.hostname !== 'app'" in src
    assert 'protocol.handle 失败' in src


def test_harbor_protocol_cors_and_nav_guard():
    src = (ROOT / 'electron' / 'main.js').read_text(encoding='utf-8')
    # CORS 放行新 origin（server 侧精确匹配逗号分隔集合）
    assert "'null,harbor://app'" in src
    # will-navigate 守卫随加载方式二选一（S2-14 语义保持）
    assert 'PAGE_ORIGIN_OK' in src
    # MIME 按扩展名（js 文件不得发 text/html）
    assert "'text/javascript; charset=utf-8'" in src
