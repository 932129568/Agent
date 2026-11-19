# -*- coding: utf-8 -*-
"""Harbor 安装器核心逻辑（v1.7.0 安装体验重构）。

设计依据（外部调研 2026-10-19，[外]）：
- 每用户安装到 %LOCALAPPDATA%\\Programs\\Harbor——无需 UAC、自动更新可原地替换
  （positioniseverything / strath.ac.uk / gitcode Zen 案例：Program Files 会阻碍自更新）；
- 每用户快捷方式放 %APPDATA%\\...\\Start Menu\\Programs（勿用 ProgramData 全用户位）；
- 注册表写 HKCU 卸载项（每用户，NoModify/NoRepair）；
- 标准向导步序：欢迎 → 目录选择 → 进度 → 完成（运行选项）。

本模块零第三方依赖（tkinter/winreg/ctypes/subprocess 全 stdlib），
GUI（installer_gui）与静默模式（main）共用；全部 IO 可无头单测。
"""
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

APP_NAME = 'Harbor'
UNINSTALLER_NAME = 'Uninstall.exe'

# ---------------- 版本与路径 ----------------

def app_version():
    """单一数据源：VERSION 文件（frozen 时在 _MEIPASS，开发时在仓库根）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = []
    if getattr(sys, 'frozen', False):
        candidates.append(os.path.join(sys._MEIPASS, 'VERSION'))
    candidates.append(os.path.join(here, '..', 'VERSION'))
    candidates.append(os.path.join(here, 'VERSION'))
    for p in candidates:
        try:
            with open(p, 'r', encoding='utf-8') as f:
                v = f.read().strip()
                if v:
                    return v
        except OSError:
            continue
    return '0.0.0'


def default_install_dir():
    """%LOCALAPPDATA%\\Programs\\Harbor（每用户标准位，无 UAC）。"""
    local = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~\\AppData\\Local')
    return os.path.join(local, 'Programs', APP_NAME)


def payload_path():
    """Harbor.exe 载荷：frozen 时内嵌于 payload/，开发时取 dist/。"""
    if getattr(sys, 'frozen', False):
        p = os.path.join(sys._MEIPASS, 'payload', 'Harbor.exe')
        if os.path.exists(p):
            return p
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(root, 'dist', 'Harbor.exe')


def embedded_payload_sha256():
    """构建期嵌入的载荷 sha256（payload.sha256 随 datas 进包，build_setup 写入）。

    开发/直调 install() 场景无此文件 → 返回 ''（调用方跳过强校验，兼容
    tests/test_installer 的自造载荷）。"""
    if not getattr(sys, 'frozen', False):
        return ''
    p = os.path.join(sys._MEIPASS, 'payload', 'payload.sha256')
    try:
        with open(p, 'r', encoding='utf-8') as f:
            v = str(f.read() or '').strip().lower()
        return v if len(v) == 64 else ''
    except OSError:
        return ''


def uninstaller_payload_path():
    """卸载程序载荷（与安装器同批构建，frozen 时内嵌于 uninstall/）。

    注意：spec 的 datas 元组目标只决定目录，文件名保持源文件名
    （dist/Harbor-Uninstall.exe）——故 frozen 路径必须用带前缀的名字。"""
    if getattr(sys, 'frozen', False):
        p = os.path.join(sys._MEIPASS, 'uninstall', 'Harbor-Uninstall.exe')
        if os.path.exists(p):
            return p
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(root, 'dist', 'Harbor-Uninstall.exe')


def start_menu_dir():
    appdata = os.environ.get('APPDATA') or os.path.expanduser('~\\AppData\\Roaming')
    return os.path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs')


def desktop_dir():
    return os.path.join(os.path.expanduser('~'), 'Desktop')


# ---------------- 环境探测 ----------------

def free_space_mb(path):
    try:
        free = ctypes.c_ulonglong(0)
        ctypes.windll.kernel32.GetDiskFreeSpaceExW(
            ctypes.c_wchar_p(path), None, None, ctypes.byref(free))
        return int(free.value // (1024 * 1024))
    except Exception:
        return -1


def _nearest_existing_dir(path):
    """向上找最近的存在祖先目录；都不存在返回 None。"""
    p = os.path.abspath(path)
    while True:
        if os.path.isdir(p):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent


def check_target(path):
    """目标目录体检。返回 (ok, warn, need_admin)。

    warn 非空 = 可安装但需提示（如选 Program Files 会影响自动更新）；
    need_admin=True 时 warn 说明原因（Zen 案例：系统级目录阻碍自更新 [外]）。

    注意：本函数只做体检，不创建目录——每次按键都 makedirs 会把
    「只是浏览/改主意」变成磁盘副作用；目录创建只发生在 install() 正式执行处。
    写探测改在「向上最近的已存在祖先目录」上进行，语义等价（安装时由
    install() 负责 makedirs）。
    """
    if not path or not str(path).strip():
        return False, '请选择安装目录。', False
    path = os.path.abspath(path)
    low = path.lower().replace('/', '\\')
    need_admin = (low.startswith(os.environ.get('SYSTEMROOT', 'C:\\WINDOWS').lower())
                  or '\\program files' in low or '\\windows' in low)
    warn = None
    if need_admin:
        warn = ('所选目录位于系统保护区（Program Files/Windows），写入需要管理员权限，'
                '且日后自动更新可能因权限不足而失败。建议使用默认的每用户目录。')
    if os.path.exists(path) and not os.path.isdir(path):
        return False, '目标路径已存在同名文件，不能作为安装目录。', need_admin
    probe_dir = _nearest_existing_dir(path)
    if probe_dir is None:
        return False, '目录不存在（且无法定位可写祖先）：%s' % path, need_admin
    try:
        probe = os.path.join(probe_dir, '.harbor-write-test')
        with open(probe, 'w') as f:
            f.write('ok')
        os.remove(probe)
    except OSError as e:
        return False, ('目录不可写入：%s' % e), need_admin
    return True, warn, need_admin


def is_app_running():
    """Harbor 是否在运行（tasklist 探测，无第三方依赖）。"""
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Harbor.exe', '/NH'],
                             capture_output=True, timeout=10,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return b'harbor.exe' in (out.stdout or b'').lower()
    except Exception:
        return False


# ---------------- 快捷方式 / 注册表 ----------------

def _ps_escape(s):
    return str(s).replace("'", "''")


def create_shortcut(lnk_path, target, work_dir=None, icon=None, description=APP_NAME):
    """创建 .lnk（WScript.Shell COM，经 PowerShell 调用——零依赖）。

    返回 True/False；PowerShell 缺失等非关键失败不炸安装（调用方记 warning）。
    """
    lnk_path = os.path.abspath(lnk_path)
    os.makedirs(os.path.dirname(lnk_path), exist_ok=True)
    ps = ("$s=(New-Object -COMObject WScript.Shell).CreateShortcut('%s');"
          "$s.TargetPath='%s';$s.WorkingDirectory='%s';$s.IconLocation='%s';"
          "$s.Description='%s';$s.Save()") % (
        _ps_escape(lnk_path), _ps_escape(os.path.abspath(target)),
        _ps_escape(work_dir or os.path.dirname(os.path.abspath(target))),
        _ps_escape(icon or os.path.abspath(target)), _ps_escape(description))
    try:
        r = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
             '-WindowStyle', 'Hidden', '-Command', ps],
            capture_output=True, timeout=20,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return r.returncode == 0 and os.path.exists(lnk_path)
    except Exception:
        return False


def remove_shortcut(lnk_path):
    try:
        if os.path.exists(lnk_path):
            os.remove(lnk_path)
            return True
    except OSError:
        pass
    return False


_UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\Harbor'


def register_uninstall(install_dir, version, uninstall_exe,
                       test_root=None, estimated_mb=0):
    """HKCU 卸载项（每用户，Add/Remove Programs 可见）。test_root 供单测隔离。"""
    import winreg
    key_path = test_root or _UNINSTALL_KEY
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
        winreg.SetValueEx(k, 'DisplayName', 0, winreg.REG_SZ, '%s %s' % (APP_NAME, version))
        winreg.SetValueEx(k, 'DisplayVersion', 0, winreg.REG_SZ, version)
        winreg.SetValueEx(k, 'Publisher', 0, winreg.REG_SZ, 'Harbor')
        winreg.SetValueEx(k, 'InstallLocation', 0, winreg.REG_SZ, install_dir)
        winreg.SetValueEx(k, 'UninstallString', 0, winreg.REG_SZ,
                          '"%s" /uninstall' % os.path.abspath(uninstall_exe))
        winreg.SetValueEx(k, 'DisplayIcon', 0, winreg.REG_SZ,
                          os.path.join(install_dir, 'Harbor.exe') + ',0')
        if estimated_mb:
            winreg.SetValueEx(k, 'EstimatedSize', 0, winreg.REG_DWORD, int(estimated_mb * 1024))
        winreg.SetValueEx(k, 'NoModify', 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(k, 'NoRepair', 0, winreg.REG_DWORD, 1)


def unregister_uninstall(test_root=None):
    import winreg
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, test_root or _UNINSTALL_KEY)
        return True
    except OSError:
        return False


def registry_install_location(test_root=None):
    """读 HKCU 卸载项的 InstallLocation；无项/读失败返回 None。

    卸载目标定位链的一环（--dir > Uninstall.exe 所在目录(+install.json) >
    注册表 > 默认目录）；test_root 供单测隔离。"""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            test_root or _UNINSTALL_KEY) as k:
            v, _ = winreg.QueryValueEx(k, 'InstallLocation')
            return (v or '').strip() or None
    except OSError:
        return None


# ---------------- 安装 / 卸载 ----------------

def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def install(target, progress_cb=None, desktop_shortcut=True, start_menu=True,
            uninstaller_src=None):
    """执行安装。返回 {'ok':bool, 'install_dir':…, 'warnings':[…]}。

    progress_cb(step, total, msg) 供 GUI 进度条/静默日志。
    """
    warnings = []
    target = os.path.abspath(target)
    total = 5

    def cb(i, msg):
        if progress_cb:
            progress_cb(i, total, msg)

    ok, warn, need_admin = check_target(target)
    if not ok:
        return {'ok': False, 'error': warn, 'install_dir': target, 'warnings': []}
    if warn:
        warnings.append(warn)

    payload = payload_path()
    if not os.path.exists(payload):
        return {'ok': False, 'error': '安装包损坏：找不到应用载荷 Harbor.exe',
                'install_dir': target, 'warnings': warnings}

    # 目录创建只保留在 install() 正式执行处（check_target 不再有 makedirs 副作用）
    try:
        os.makedirs(target, exist_ok=True)
    except OSError as e:
        return {'ok': False, 'error': '无法创建安装目录：%s' % e,
                'install_dir': target, 'warnings': warnings}

    dest = os.path.join(target, 'Harbor.exe')

    cb(1, '正在复制程序文件…')
    # 复核修正：copy2 原地覆盖无备份无回滚——升级/重装复制中途失败（磁盘满）
    # 会留下截断的 Harbor.exe 且旧版已毁。改「先写 .new → 校验尺寸/sha256 →
    # 原子 replace」，失败保留旧版（自更新 .bat 同款口径）。
    _dest_new = dest + '.new'
    try:
        shutil.copy2(payload, _dest_new)
        if os.path.getsize(_dest_new) != os.path.getsize(payload):
            try:
                os.remove(_dest_new)
            except OSError:
                pass
            return {'ok': False, 'error': '文件复制不完整，请重试',
                    'install_dir': target, 'warnings': warnings}
        # 载荷完整性强校验：构建期嵌入的 sha256（build_setup 写 payload.sha256
        # 随 datas 进包）与落地字节对拍——同尺寸损坏载荷不再照装；无嵌入值
        # （开发/直调场景）跳过，兼容 tests/test_installer 自造载荷
        _expect = embedded_payload_sha256()
        if _expect and _sha256(_dest_new) != _expect:
            try:
                os.remove(_dest_new)
            except OSError:
                pass
            return {'ok': False,
                    'error': '载荷完整性校验失败（sha256 与构建期记录不符）——'
                             '安装包可能损坏，请重新下载',
                    'install_dir': target, 'warnings': warnings}
        os.replace(_dest_new, dest)
    except OSError as e:
        try:
            if os.path.exists(_dest_new):
                os.remove(_dest_new)
        except OSError:
            pass
        return {'ok': False, 'error': '复制失败：%s（请关闭运行中的 Harbor 后重试）' % e,
                'install_dir': target, 'warnings': warnings}

    cb(2, '正在安装卸载程序…')
    uninst_src = uninstaller_src or uninstaller_payload_path()
    if os.path.exists(uninst_src):
        try:
            shutil.copy2(uninst_src, os.path.join(target, UNINSTALLER_NAME))
        except OSError as e:
            warnings.append('卸载程序复制失败：%s' % e)
    else:
        warnings.append('未找到卸载程序载荷（开发模式跳过）')

    cb(3, '正在创建快捷方式…')
    made = 0
    if start_menu:
        if create_shortcut(os.path.join(start_menu_dir(), 'Harbor.lnk'), dest):
            made += 1
        else:
            warnings.append('开始菜单快捷方式创建失败（不影响使用）')
    if desktop_shortcut:
        if create_shortcut(os.path.join(desktop_dir(), 'Harbor.lnk'), dest):
            made += 1
        else:
            warnings.append('桌面快捷方式创建失败（不影响使用）')

    cb(4, '正在注册系统信息…')
    try:
        register_uninstall(target, app_version(),
                           os.path.join(target, UNINSTALLER_NAME),
                           estimated_mb=os.path.getsize(dest) // (1024 * 1024))
    except OSError as e:
        warnings.append('系统注册失败：%s（将不出现在「应用与功能」列表）' % e)

    cb(5, '正在写入安装清单…')
    try:
        with open(os.path.join(target, 'install.json'), 'w', encoding='utf-8') as f:
            json.dump({'version': app_version(), 'install_dir': target,
                       'installed_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                       'sha256': _sha256(dest)}, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return {'ok': True, 'install_dir': target, 'warnings': warnings,
            'shortcuts': made, 'need_admin': need_admin}


def read_install_manifest(install_dir):
    """读 install.json；不存在/损坏/非对象/入参异常一律返回 None。

    非 dict（如 JSON 数组）必须归一为 None：调用方 _resolve_uninstall_dir
    直接 .get('install_dir')，原样返回 list 会 AttributeError 崩定位链
    （已实证：install.json 为 '[1,2,3]' 时卸载入口崩溃）。
    """
    try:
        with open(os.path.join(install_dir, 'install.json'), 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _rmtree_retry(path, retries=3):
    for i in range(retries):
        try:
            shutil.rmtree(path)
            return True
        except OSError:
            if is_app_running():
                time.sleep(1.0)   # 等用户关应用
                continue
            time.sleep(0.3)
    return not os.path.exists(path)


def _self_delete_needed(install_dir):
    """当前运行的 Uninstall.exe 是否正位于 install_dir（frozen 卸载器自删场景）。

    场景：用户经「应用与功能」或安装目录内双击 Uninstall.exe 卸载——
    exe 运行中时 install_dir 删不掉自身文件，需等进程退出后由外部进程补删。
    非 frozen（开发/测试直跑 Python）或 exe 不在安装目录内时返回 False。
    """
    if not getattr(sys, 'frozen', False):
        return False
    try:
        exe = os.path.abspath(sys.executable)
    except Exception:
        return False
    return (os.path.basename(exe).lower() == UNINSTALLER_NAME.lower()
            and os.path.dirname(exe) == os.path.abspath(install_dir))


def _short_path(path):
    """取 8.3 短路径（cmd 兜底免转义用）；失败/UNC/空返回 None。"""
    try:
        buf = ctypes.create_unicode_buffer(260)
        n = ctypes.windll.kernel32.GetShortPathNameW(str(path), buf, 260)
        return buf.value if 0 < n < 260 else None
    except Exception:
        return None


def _schedule_delayed_delete(install_dir):
    """spawn detached PowerShell：等自身 pid 退出（至多 30s）→ 500ms → 删安装目录。

    三个已实证坑（第六轮对抗复审）：
    1. 必须 -LiteralPath：非字面量模式下路径含 [ ] 时 Remove-Item 按通配符
       匹配——安装目录 C:\\app\\a[1] 会误删 C:\\app\\a1、反留真实目录
       （数据丢失级反选，已实证）。-LiteralPath 按字面精确删除。
    2. Wait-Process 必须带 -Timeout：卸载器进程异常不退出时无超时的
       Wait-Process 让 ps 无限滞留（已实证）；超时后进程仍存活则直接退出
       不删——避免边运行边删造成半删除状态（比乱删更坏）。
    3. PowerShell 被企业禁用时（Popen 抛异常）回落 cmd 短路径 rmdir：
       短路径无空格/特殊字符，免命令行转义；两者皆不可用返回 False，
       由调用方回落即时 rmtree。

    creationflags=CREATE_NO_WINDOW|DETACHED_PROCESS：无黑窗，且父进程
    退出后子进程仍存活完成补删（DETACHED_PROCESS 脱离父进程控制台/
    生命周期，已实证：父进程立即退出后子 ps 仍完成删除）。
    返回 True=已挂起延迟删除；False=调用方回落即时删除。
    """
    pid = os.getpid()
    ps = ("$p=Get-Process -Id %d -ErrorAction SilentlyContinue;"
          "if($p){Wait-Process -Id %d -Timeout 30 -ErrorAction SilentlyContinue;"
          "if(Get-Process -Id %d -ErrorAction SilentlyContinue){exit 0}};"
          'Start-Sleep -Milliseconds 500;'
          "Remove-Item -LiteralPath '%s' -Recurse -Force"
          % (pid, pid, pid, _ps_escape(install_dir)))
    try:
        subprocess.Popen(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                          '-WindowStyle', 'Hidden', '-Command', ps],
                         creationflags=(getattr(subprocess, 'CREATE_NO_WINDOW', 0)
                                        | getattr(subprocess, 'DETACHED_PROCESS', 0)))
        return True
    except Exception:
        pass
    sp = _short_path(install_dir)
    if sp and ' ' not in sp and not any(c in sp for c in '&|<>^"'):
        # cmd 兜底：ping 3 包 ≈2s 覆盖卸载器退出时间，再 rmdir 短路径
        try:
            subprocess.Popen([os.environ.get('COMSPEC', 'cmd'), '/d', '/s', '/c',
                              'ping -n 3 127.0.0.1 >nul & rmdir /s /q %s' % sp],
                             creationflags=(getattr(subprocess, 'CREATE_NO_WINDOW', 0)
                                            | getattr(subprocess, 'DETACHED_PROCESS', 0)))
            return True
        except Exception:
            pass
    return False


def uninstall(install_dir, purge_data=False, progress_cb=None):
    """卸载：删快捷方式 + 注册表项 + 安装目录。默认保留用户数据（~/.glm-chat）。"""
    warnings = []
    install_dir = os.path.abspath(install_dir)
    total = 4

    def cb(i, msg):
        if progress_cb:
            progress_cb(i, total, msg)

    if is_app_running():
        return {'ok': False,
                'error': 'Harbor 正在运行，请先退出后再卸载。',
                'install_dir': install_dir}

    cb(1, '正在移除快捷方式…')
    remove_shortcut(os.path.join(start_menu_dir(), 'Harbor.lnk'))
    remove_shortcut(os.path.join(desktop_dir(), 'Harbor.lnk'))

    cb(2, '正在删除程序文件…')
    files_ok = True
    if not os.path.isdir(install_dir):
        warnings.append('安装目录不存在（可能已被手动删除，或 --dir 指定有误）：%s'
                        % install_dir)
    elif _self_delete_needed(install_dir):
        # 卸载器自身在安装目录内：运行时删不掉自己，挂起退出后补删，
        # 跳过即时 rmtree（必然残留且误导 warnings）。
        if not _schedule_delayed_delete(install_dir):
            files_ok = _rmtree_retry(install_dir)
            if not files_ok:
                warnings.append('部分文件未能删除（可能被占用）：%s' % install_dir)
        else:
            warnings.append('卸载程序自身位于安装目录内，文件将在退出后完成删除。')
    else:
        files_ok = _rmtree_retry(install_dir)
        if not files_ok:
            warnings.append('部分文件未能删除（可能被占用）：%s' % install_dir)

    cb(3, '正在清理系统注册信息…')
    # 复核修正：文件删除成功后再反注册——原先先删注册表项再删文件，文件
    # 删除失败（占用/重试耗尽）时 ARP 入口已消失，残留目录无任何正规卸载
    # 途径。失败时保留注册项供用户从「应用与功能」重试（_resolve_uninstall_dir
    # 也可再定位安装目录）；延迟自删路径视为成功（删除已排程，标准卸载器行为）。
    if files_ok:
        if not unregister_uninstall():
            warnings.append('注册表卸载项清理失败（可手动删除）')
    else:
        warnings.append('文件未完全删除，已保留注册表卸载项以便重试。')

    cb(4, '正在处理用户数据…')
    if purge_data:
        data_dir = os.path.join(os.path.expanduser('~'), '.glm-chat')
        if os.path.isdir(data_dir):
            if not _rmtree_retry(data_dir):
                warnings.append('用户数据目录未能完全删除：%s' % data_dir)
    else:
        warnings.append('用户数据（配置/会话/密钥）保留在 ~/.glm-chat，未删除。')

    return {'ok': True, 'install_dir': install_dir, 'warnings': warnings}
