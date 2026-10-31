# -*- mode: python ; coding: utf-8 -*-
# v1.9.0 M7.1 · macOS build spec（理论支持——macOS 真机执行；Windows 开发
# 机不可验证，真机验证项集中 M9）
#
# 与 Harbor.spec（Windows）的差别：
# - windowed .app BUNDLE（BUNDLE_EXE）+ Info.plist 三键（CFBundleName/
#   CFBundleShortVersionString/NSHighResolutionCapable）；
# - 版本注入断言（M7.9）：CFBundleShortVersionString 必须与 VERSION 文件
#   一致（tools/build_mac.sh 内嵌断言，防 v1.8.0 tag VERSION 滞后重演）；
# - entitlements 决策（M7.5）：App Sandbox **不开**——Harbor 需全盘文件/
#   网络全权（工作区任意目录 + 本地任意端点）；hardened runtime 开（签名
#   前提），决策记录见 deliverables/dev-plan/mac-unsigned-fallback.md。

import os

ROOT = os.path.abspath(SPECPATH)

with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as _f:
    APP_VERSION = _f.read().strip()

a = Analysis(
    ['main.py'],
    pathex=[ROOT],
    binaries=[],
    datas=[
        # prompts 随目录声明（与 Windows Harbor.spec 同源）
        (os.path.join(ROOT, 'backend', 'prompts'), 'backend/prompts'),
        (os.path.join(ROOT, 'harbor.html'), '.'),
        # libs 整目录包含既有4库及 ui-schema bundle/LICENSE/NOTICE；不收集 node_modules。
        (os.path.join(ROOT, 'libs'), 'libs'),
        # 复核修正：VERSION 随包（APP_VERSION 单一数据源查找链第一优先；
        # 原缺失时全靠回退常量兜底，bump 漏改即静默版本错报）
        (os.path.join(ROOT, 'VERSION'), '.'),
        (os.path.join(ROOT, 'build', 'Harbor.icns'), '.'),
    ],
    hiddenimports=[
        'pywebview.platforms.cocoa',
        'backend.domains.integrations.browser.session_mac',   # M4 理论实现（PyObjC 桥）
        'backend.domains.integrations.browser.platform.mac',  # M6 平台服务
        'backend.domains.integrations.browser.driver',
        'send2trash',
        'PIL.ImageGrab',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
)
# 复核修正：PyInstaller 6 已删除 a.zipped_data / a.zipfiles / cipher 参数
# （原 PyInstaller≤5 API，mac 构建直接 AttributeError；与 Windows
# Harbor.spec 的 6.x 口径对齐）
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Harbor',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,          # --windowed（M7.1）
    icon=os.path.join(ROOT, 'build', 'Harbor.icns'),
)

app = BUNDLE(
    exe,
    name='Harbor.app',
    icon=os.path.join(ROOT, 'build', 'Harbor.icns'),
    bundle_identifier='local.harbor.app',
    version=APP_VERSION,     # M7.9 版本注入（与 VERSION 文件一致）
    info_plist={
        'CFBundleName': 'Harbor',
        'CFBundleDisplayName': 'Harbor',
        'CFBundleShortVersionString': APP_VERSION,   # M7.9 断言键
        'NSHighResolutionCapable': True,             # Retina（M8.4 point 坐标系）
        'NSAppleEventsUsageDescription':
            'Harbor 需要自动化权限以打开系统浏览器与访达定位。',
        'NSDesktopFolderUsageDescription':
            'Harbor 工作区可能位于桌面目录（用户自选）。',
    },
)
