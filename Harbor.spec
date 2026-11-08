# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    # libs 整目录包含既有4库及 ui-schema bundle/LICENSE/NOTICE；node_modules 不入包。
    datas=[('harbor.html', '.'), ('libs', 'libs'), ('VERSION', '.'),
           # W0 R19：版本化提示词目录（prompt_loader 经 ../prompts 定位，frozen 同口径）
           ('backend/prompts', 'backend/prompts'),
           # 八个内置 WorkBuddy 专家包只读资产；运行时转换为临时Harbor包再严格导入。
           ('backend/experts_builtin', 'backend/experts_builtin')],
    # 修复 W2：懒加载依赖显式声明（原 frozen 包中 send2trash/PIL 静默缺失，
    # delete_path 回收站模式与 take_screenshot 在打包版失效）
    # 复核批补：pywebview winforms 后端的 .NET 桥（clr → pythonnet →
    # clr_loader → cffi/_cffi_backend）显式入图——2026-10-24 真机启动失败
    # 实证 _cffi_backend 缺失（ModuleNotFoundError → coreclr 初始化失败）
    # 2026-10-29 打包修复：隔离venv未安装pywebview时仍产出无webview坏包，
    # 真机报 No module named 'webview'。显式声明主模块与Windows后端；
    # pywebview自带__pyinstaller hook继续负责lib/WebView2 DLL与runtimes数据。
    hiddenimports=['send2trash', 'PIL.ImageGrab',
                   'webview', 'webview.platforms.edgechromium', 'webview.platforms.winforms',
                   'pythonnet', 'clr', 'clr_loader', 'cffi', '_cffi_backend',
                   # R38 记忆模块 v2（SQLite 四层库；agent_memory 纯标准库包）
                   'agent_memory', 'agent_memory.memory_store'],
    # 复核修正：pywin32 在 Py3.15 构建环境不可加载（pywin32-312 只带 313 DLL，
    # send2trash 的 COM 路径把 pythoncom 拉入图触发 hook-pythoncom 崩溃）——
    # 排除 pywin32 族，运行时 send2trash 自动回落 ctypes legacy 路径
    # （SHFileOperation，回收站功能不受影响）
    excludes=['pythoncom', 'pywintypes', 'win32api', 'win32com',
              'win32com.client', 'win32timezone', 'win32con',
              'win32gui', 'win32process', 'win32event'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    noarchive=False,
    optimize=0,
)
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
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['harbor.ico'],
)
