# -*- coding: utf-8 -*-
"""Harbor 安装器入口（setup_main.py）。

文件名刻意避开 main.py——frozen 后 traceback 的 co_filename 是基名，
若叫 main.py 会与仓库根的应用 main.py 在 linecache 里撞车（调试事故源）。

用法：
  Harbor-Setup-x.y.z.exe            双击 → 图形化安装向导（pywebview）
  Harbor-Setup-x.y.z.exe /S          静默安装（默认目录或 --dir 指定）
  Harbor-Setup-x.y.z.exe --dir PATH  指定目录（配合 /S 或 GUI 预填）
  Harbor-Setup-x.y.z.exe --version   输出版本号
  Uninstall.exe                      卸载确认（原生 MessageBox 两问）
  Uninstall.exe /S [--purge]         静默卸载（默认保留用户数据）

GUI 技术栈：复用产品自身的 pywebview + 单文件 HTML（本机构建环境无 tkinter，
2026-10-19 实测决策）；WebView2 缺失时降级原生 MessageBox 指引 + 静默安装提示。
"""
import os
import sys

from installer_core import (app_version, default_install_dir, install,
                            read_install_manifest, registry_install_location,
                            uninstall)

SILENT = any(a in ('/S', '/s', '--silent', '-S') for a in sys.argv[1:])
UNINSTALL = any(a in ('/uninstall', '--uninstall', '-u') for a in sys.argv[1:])
PURGE = '--purge' in sys.argv[1:]
# 复核修正（P0）：卸载器与安装器同一入口——注册表 UninstallString/双击
# Uninstall.exe 均不带 /uninstall 参数时原会落入安装向导并报「安装包损坏
# （找不到载荷）」。按 exe 名自动识别卸载器形态（build_setup 构建产物名
# Uninstall.exe；setup exe 名为 Harbor-Setup-*，不撞）。
_EXE_BASE = os.path.basename(os.path.abspath(sys.executable or '')).lower()
if not UNINSTALL and getattr(sys, 'frozen', False) and \
        (_EXE_BASE.startswith('uninstall') or _EXE_BASE == 'uninstall.exe'):
    UNINSTALL = True


def _dir_arg(default=None):
    """解析 --dir/-/D= 指定目录。

    已实证坑（第六轮对抗复审）：
    - 大小写不敏感：NSIS 惯例 /D=path，用户会打成 /d=（原实现只认
      '/D=' 大写，小写静默回落默认目录——装错地方）。
    - 空格形式拒绝把 flag 当值：`--dir --silent` 原会把 '--silent'
      当成目录名（安装到名为 --silent 的目录）；以 '-'/'/' 开头的
      下一个参数一律视为缺值回落 default。
    - 相对路径不在本函数归一（下游 install()/uninstall() 均 abspath，
      语义一致）；`--dir=` 空值回落 default。
    """
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        low = a.lower()
        if low.startswith('--dir=') or low.startswith('/d='):
            v = a.split('=', 1)[1].strip().strip('"')
            return v or default
        if low in ('--dir', '/d') and i + 1 < len(argv):
            v = argv[i + 1].strip().strip('"')
            if v and not v.startswith(('-', '/')):
                return v
    return default


def _resolve_uninstall_dir():
    """卸载目标定位链（按优先级）：

    1. `--dir` / `/D=` 显式参数（空值已由 _dir_arg 回落，不会命中）；
    2. frozen 时 Uninstall.exe 所在目录（需含 Harbor.exe 校验防误判）——
       以 exe 所在目录为准确认：安装目录被移动过时 manifest 的 install_dir
       是安装时的旧位置（原实现 manifest 优先，已实证卸载打偏：删旧位置、
       真实目录残留、延迟自删挂错目录），且自删必须指向运行中 exe 的
       目录才删得掉自身；manifest 仅在 exe 目录缺 Harbor.exe 时兜底，
       且 install_dir 必须校验为非空字符串且目录仍存在；
    3. 注册表 HKCU Uninstall\\Harbor 的 InstallLocation；
    4. 默认每用户目录。

    取代原先两处硬编码 default_install_dir()——用户改过安装位置时
    卸载会打偏（删默认目录、留真实目录）。"""
    arg = _dir_arg(None)
    if arg:
        return arg
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        if os.path.exists(os.path.join(exe_dir, 'Harbor.exe')):
            return exe_dir
        manifest = read_install_manifest(exe_dir)
        if manifest:
            d = manifest.get('install_dir')
            if isinstance(d, str) and d.strip() and os.path.isdir(d):
                return d
    reg = registry_install_location()
    if reg:
        return reg
    return default_install_dir()


def _log(msg):
    try:
        with open(os.path.join(os.environ.get('TEMP', '.'), 'harbor-setup.log'), 'a',
                  encoding='utf-8') as f:
            f.write(msg + '\n')
    except OSError:
        pass


def run_silent_install():
    target = _dir_arg(default_install_dir())
    _log('[install] target=%s' % target)
    res = install(target, progress_cb=lambda i, t, m: _log('[install] %d/%d %s' % (i, t, m)))
    _log('[install] result=%s' % {k: v for k, v in res.items() if k != 'warnings'})
    return 0 if res.get('ok') else 2


def run_silent_uninstall():
    install_dir = _resolve_uninstall_dir()
    _log('[uninstall] dir=%s purge=%s' % (install_dir, PURGE))
    res = uninstall(install_dir, purge_data=PURGE,
                    progress_cb=lambda i, t, m: _log('[uninstall] %d/%d %s' % (i, t, m)))
    _log('[uninstall] result=%s' % res)
    return 0 if res.get('ok') else 3


# ---------------- 原生 MessageBox（cmd_service 同款显式签名，防 64 位截断） ----------------
def _msgbox(text, title, flags):
    import ctypes
    if not hasattr(ctypes, 'windll'):
        return 0
    try:
        from ctypes import wintypes
        u32 = ctypes.windll.user32
        u32.MessageBoxW.restype = ctypes.c_int
        u32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR,
                                    wintypes.LPCWSTR, wintypes.UINT]
        return u32.MessageBoxW(0, text, title, flags)
    except Exception:
        return 0


_MB_YESNO = 0x04
_MB_YES = 6
_MB_ICONWARN = 0x30
_MB_ICONINFO = 0x40
_MB_ICONERR = 0x10


def _uninstall_gui_native():
    """卸载确认：原生两问（是否卸载 / 是否连用户数据一起删）——安装器行业标准形态。"""
    r = _msgbox('卸载 Harbor %s？\n\n将删除程序文件、快捷方式与系统注册信息。\n'
                '用户数据（配置/会话/密钥）默认保留在 ~/.glm-chat。' % app_version(),
                'Harbor 卸载程序', _MB_YESNO | _MB_ICONWARN)
    if r != _MB_YES:
        return 0
    r2 = _msgbox('同时删除用户数据吗？\n\n选「是」将删除 ~/.glm-chat'
                 '（含 API Key 与会话记录，不可恢复）。\n选「否」仅卸载程序。',
                 'Harbor 卸载程序 · 用户数据', _MB_YESNO | _MB_ICONWARN)
    purge = (r2 == _MB_YES)
    res = uninstall(_resolve_uninstall_dir(), purge_data=purge)
    if res.get('ok'):
        _msgbox('卸载完成。' + ('用户数据已删除。' if purge else '用户数据保留在 ~/.glm-chat。'),
                'Harbor 卸载程序', _MB_ICONINFO)
        return 0
    _msgbox('卸载失败：%s' % res.get('error', '未知错误'), 'Harbor 卸载程序', _MB_ICONERR)
    return 3


def _gui_fallback():
    """pywebview/WebView2 不可用：原生指引 + 静默安装提示（不假装能装）。"""
    _msgbox('无法启动图形安装界面（WebView2 运行时缺失或损坏）。\n\n'
            'Harbor 需要 Edge WebView2 Runtime（Windows 11 自带；Windows 10 请先在微软官网'
            '安装「Edge WebView2 Runtime」）。\n\n'
            '安装完成后，也可以静默方式安装：\nHarbor-Setup.exe /S',
            'Harbor 安装程序', _MB_ICONWARN)
    return 4


def main():
    if '--version' in sys.argv[1:] or '/V' in sys.argv:
        # 复核修正：console=False 下 print 进 NullWriter——落日志文件保证可查
        _log('[version] %s' % app_version())
        print(app_version())
        return 0
    if UNINSTALL:
        if SILENT:
            return run_silent_uninstall()
        return _uninstall_gui_native()
    if SILENT:
        return run_silent_install()
    # GUI：延迟 import——静默/卸载路径不加载 pywebview
    try:
        from installer_gui import run_gui
    except ImportError as e:
        _log('[gui] import 失败: %r' % e)
        return _gui_fallback()
    try:
        run_gui()
    except Exception as e:
        _log('[gui] 启动失败: %r' % e)
        return _gui_fallback()
    return 0


if __name__ == '__main__':
    sys.exit(main())
