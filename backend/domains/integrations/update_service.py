# -*- coding: utf-8 -*-
"""自动更新服务（v1.2 R1 最小版）。

流程（PRD §7.3）：
  启动后台 check_update(manifest_url) → 有新版本前端轻提示
  → start_update_download(url, sha256) 后台线程下载 + SHA256 校验
  → get_update_progress() 轮询状态
  → apply_update() 写 .bat 辅助脚本（等待旧进程退出 → 备份旧 exe → 替换 → 拉起新版）

设计要点：
- 应用版本号 APP_VERSION 与 js_api 契约版本号分离（API_VERSION='v1.0.0' 动不得，
  get_api_info 输出与 legacy 逐字节比对）。
- 校验失败/下载中断：旧版本不受任何影响（下载产物落独立 temp 目录，失败即删）。
- 仅 frozen（PyInstaller onefile）支持自替换；开发模式返回明确错误。
- 依赖仅标准库（urllib/hashlib/threading），不引入新依赖。
"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time

from ...logging_setup import get_logger
from .mcp.mcp_transport_http import urlopen_no_redirect   # 修复 W18：禁跟随重定向（防跨域引导/凭证泄漏）

# 更新清单地址：优先从 config.json 的 update_manifest_url 读取（前端可配）。
# ⚠ 此为占位默认源（github.com/harbor/harbor 并非真实仓库），分发前必须：
#   ① 把下面换成你的真实 Releases 地址，或在设置面板配置 update_manifest_url；
#   ② 确认 VERSION 文件已同步为即将发布的版本号（单一数据源，勿在代码里手改版本号）。
DEFAULT_MANIFEST_URL = 'https://github.com/harbor/harbor/releases/latest/download/update-manifest.json'
UPDATE_DIR = os.path.join(tempfile.gettempdir(), 'harbor-update')


def _load_app_version():
    """APP_VERSION 单一数据源：优先读项目根 VERSION 文件。

    查找顺序：frozen 时随 datas 进 sys._MEIPASS；开发时在项目根（backend/domains 上三级）。
    读不到时回退内置常量（保证旧打包产物行为不变）。
    """
    candidates = []
    if getattr(sys, 'frozen', False):
        candidates.append(os.path.join(sys._MEIPASS, 'VERSION'))
    here = os.path.dirname(os.path.abspath(__file__))          # backend/domains
    candidates.append(os.path.join(os.path.dirname(os.path.dirname(here)), 'VERSION'))
    for p in candidates:
        try:
            with open(p, 'r', encoding='utf-8') as f:
                v = f.read().strip().lstrip('vV')
                if v:
                    return v
        except Exception:
            continue
    # 修复 建议㉕：回退常量与 VERSION 文件保持同步（发布 checklist：bump 时两边核对）
    return '1.9.0'


APP_VERSION = _load_app_version()


def _version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).strip().lstrip('vV').split('.'))
    except Exception:
        return (0,)


class UpdateService:
    def __init__(self):
        self._log = get_logger()
        self._lock = threading.RLock()
        self._state = {'state': 'idle', 'pct': 0, 'error': None,
                       'path': None, 'version': None, 'url': None, 'sha256': None}
        self._thread = None

    # ---- 检查更新 ----
    def check(self, manifest_url=None):
        """拉取 manifest JSON：{version, url, sha256, notes}。比对 APP_VERSION。

        无新版本 → {'update_available': False}；网络失败 → {'error': ...}（前端静默处理）。
        修复 W18（本轮）：manifest_url 仅允许 https，且走 urlopen_no_redirect
        （禁自动重定向）——http 明文清单可被中间人篡改版本号/下载地址；
        重定向可把请求引到任意主机。原裸 urlopen 两风险都不防。
        """
        url = str(manifest_url or DEFAULT_MANIFEST_URL).strip()
        if not url.lower().startswith('https://'):
            return json.dumps({'error': '更新清单地址必须使用 https（已拒绝 %s）'
                               % (url.split('://')[0] if '://' in url else url)},
                              ensure_ascii=False)
        try:
            import urllib.request
            req = urllib.request.Request(url, headers={'User-Agent': 'Harbor/' + APP_VERSION})
            with urlopen_no_redirect(req, timeout=10) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            if not isinstance(data, dict) or 'version' not in data:
                return json.dumps({'error': '更新清单格式无效'}, ensure_ascii=False)
            latest = str(data['version'])
            if _version_tuple(latest) > _version_tuple(APP_VERSION):
                return json.dumps({
                    'update_available': True,
                    'current': APP_VERSION, 'latest': latest,
                    'url': data.get('url', ''), 'sha256': str(data.get('sha256', '')),
                    'notes': str(data.get('notes', '')),
                    'size': data.get('size'),
                }, ensure_ascii=False)
            return json.dumps({'update_available': False, 'current': APP_VERSION}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'error': '更新检查失败: %s' % e}, ensure_ascii=False)

    # ---- 下载（后台线程）----
    def start_download(self, url, sha256, version=None):
        try:
            url = str(url or '').strip()
            if not url:
                return json.dumps({'error': '缺少下载地址'}, ensure_ascii=False)
            # 修复 S1：version 来自 manifest（网络）/js_api 入参，是 sha256 时代唯一未消毒的
            # 元数据通道——路径遍历（..\..）写出 UPDATE_DIR、引号/CRLF/% 注入 .bat 插值。
            # 入口白名单校验，一劳永逸。
            v = str(version or 'new')
            if not re.fullmatch(r'[A-Za-z0-9._-]{1,32}', v):
                return json.dumps({'error': '版本号含非法字符，已拒绝下载（仅允许字母数字 . _ -）'},
                                  ensure_ascii=False)
            # 修复 S17：manifest 缺 sha256 直接拒绝下载（原跳过校验仍可 apply，可装任意 exe）
            if not str(sha256 or '').strip():
                return json.dumps({'error': '更新清单缺少 sha256 校验值，已拒绝下载（完整性无法校验）'},
                                  ensure_ascii=False)
            # 修复 W18：下载 URL 仅允许 https（原任意 scheme，http 下哈希前内容明文出网）
            if not url.lower().startswith('https://'):
                return json.dumps({'error': '下载地址必须使用 https（已拒绝 %s）' % url.split('://')[0]},
                                  ensure_ascii=False)
            with self._lock:
                if self._state.get('state') == 'downloading':
                    return json.dumps({'error': '已有下载进行中'}, ensure_ascii=False)
                self._state = {'state': 'downloading', 'pct': 0, 'error': None,
                               'path': None, 'version': version, 'url': url,
                               'sha256': str(sha256 or '')}
            self._thread = threading.Thread(target=self._download_worker,
                                            args=(url, str(sha256 or ''), version), daemon=True)
            self._thread.start()
            return json.dumps({'ok': True}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'error': str(e)}, ensure_ascii=False)

    def _download_worker(self, url, sha256, version):
        tmp_path = None
        try:
            import urllib.request
            os.makedirs(UPDATE_DIR, exist_ok=True)
            tmp_path = os.path.join(UPDATE_DIR, 'harbor-%s.exe.tmp' % (version or 'new'))
            req = urllib.request.Request(url, headers={'User-Agent': 'Harbor/' + APP_VERSION})
            # 修复 W18：500MB 硬上限 + 整体 deadline（原无上限无死线，慢速流可写满磁盘）
            _MAX_BYTES = 500 * 1024 * 1024
            deadline = time.time() + 30 * 60
            with urlopen_no_redirect(req, timeout=30) as resp:
                total = int(resp.headers.get('Content-Length') or 0)
                if total > _MAX_BYTES:
                    raise ValueError('更新包声明大小 %dMB 超上限 500MB，已拒绝' % (total // 1048576))
                h = hashlib.sha256()
                done = 0
                with open(tmp_path, 'wb') as f:
                    while True:
                        if time.time() > deadline:
                            raise ValueError('下载超过 30 分钟未完成（疑似慢速流攻击），已中止')
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        done += len(chunk)
                        if done > _MAX_BYTES:
                            raise ValueError('更新包实际大小超 500MB 上限，已中止')
                        f.write(chunk)
                        h.update(chunk)
                        pct = int(done * 100 / total) if total else 0
                        with self._lock:
                            self._state['pct'] = pct
            digest = h.hexdigest()
            if sha256 and digest.lower() != sha256.lower():
                raise ValueError('SHA256 校验失败（期望 %s，实际 %s）' % (sha256[:12], digest[:12]))
            final_path = os.path.join(UPDATE_DIR, 'harbor-%s.exe' % (version or 'new'))
            os.replace(tmp_path, final_path)
            with self._lock:
                self._state.update({'state': 'done', 'pct': 100, 'path': final_path})
            self._log.info('更新包下载完成: %s (sha256=%s)', final_path, digest[:12])
        except Exception as e:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            with self._lock:
                self._state.update({'state': 'error', 'error': str(e)})
            self._log.warning('更新下载失败: %r', e)

    def get_progress(self):
        with self._lock:
            return json.dumps(dict(self._state), ensure_ascii=False)

    # ---- 应用更新（onefile 自替换）----
    def apply(self):
        try:
            if not getattr(sys, 'frozen', False):
                return json.dumps({'error': '开发模式不支持自更新，请使用打包版'}, ensure_ascii=False)
            with self._lock:
                st = dict(self._state)
            if st.get('state') != 'done' or not st.get('path'):
                return json.dumps({'error': '尚无已完成校验的更新包'}, ensure_ascii=False)
            new_exe = st['path']
            old_exe = sys.executable
            if not os.path.exists(new_exe):
                return json.dumps({'error': '更新包不存在，请重新下载'}, ensure_ascii=False)
            sentinel = os.path.join(UPDATE_DIR, 'apply_ok.%d.sentinel' % os.getpid())
            # 修复 S1：.bat 插值前断言路径安全——引号/CRLF/% 任一存在即拒绝（批处理注入通道）
            for _p in (new_exe, old_exe, sentinel):
                if any(c in _p for c in ('"', '\r', '\n', '%')):
                    return json.dumps({'error': '更新路径含批处理敏感字符，已拒绝应用'},
                                      ensure_ascii=False)
            # 修复 W23：apply 前复核哈希（下载完成到 apply 之间的 TOCTOU 篡改窗口）
            expect_sha = str(st.get('sha256') or '').strip()
            if expect_sha:
                h = hashlib.sha256()
                with open(new_exe, 'rb') as f:
                    for chunk in iter(lambda: f.read(64 * 1024), b''):
                        h.update(chunk)
                if h.hexdigest().lower() != expect_sha.lower():
                    return json.dumps({'error': '更新包复核哈希不匹配（可能被篡改），已拒绝安装'},
                                      ensure_ascii=False)
            bat = os.path.join(UPDATE_DIR, 'apply_update.bat')
            pid = os.getpid()
            # 辅助脚本：等旧进程退出（最多 30s）→ 备份旧 exe → 替换 → 写 sentinel → 拉起新版 → 自删
            # 修复 W23：写 sentinel 标记成功（原 30s 强替失败静默）；失败后由下次启动清理/告警
            script = (
                '@echo off\r\n'
                'set /a tries=0\r\n'
                ':waitloop\r\n'
                # 修复 建议⑬（二轮）：find 子串匹配会让 1234 命中 12345 空转 30s——
                # findstr /c: 逗号定界字面匹配 CSV 的 pid 字段（精确）
                'tasklist /fi "pid eq {pid}" /fo csv /nh | findstr /c:",\\"{pid}\\"," >nul 2>&1\r\n'
                'if errorlevel 1 goto replace\r\n'
                'set /a tries+=1\r\n'
                'if %tries% geq 30 goto replace\r\n'
                'timeout /t 1 /nobreak >nul\r\n'
                'goto waitloop\r\n'
                ':replace\r\n'
                'copy /y "{old}" "{old}.bak" >nul 2>&1\r\n'
                'copy /y "{new}" "{old}" >nul 2>&1\r\n'
                'if errorlevel 1 (\r\n'
                '  copy /y "{old}.bak" "{old}" >nul 2>&1\r\n'
                '  exit /b 1\r\n'
                ')\r\n'
                'echo ok> "{sentinel}"\r\n'
                'start "" "{old}"\r\n'
                'del "%~f0" >nul 2>&1\r\n'
            ).format(pid=pid, old=old_exe, new=new_exe, sentinel=sentinel)
            # 编码必须用 mbcs（Windows ANSI/GBK）：cmd.exe 按 ANSI 代码页解析批处理，
            # 此前 ascii+errors='replace' 会把中文路径（如 C:\Users\陈\...）替换成 '?'，
            # 导致 copy 找不到文件、自更新在非 ASCII 路径下必然失败。
            with open(bat, 'w', encoding='mbcs', errors='replace') as f:
                f.write(script)
            # detached 启动辅助脚本
            import subprocess
            subprocess.Popen(['cmd', '/c', 'start', '', '/min', bat],
                             creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS,
                             close_fds=True)
            self._log.info('自更新脚本已启动，等待应用退出后替换（旧版备份为 %s.bak）', old_exe)
            # 修复 W23：apply 后主动退出（原进程不退，bat 等 30s 后强替必失败）。
            # 延迟 1.5s 让 js_api 返回值先回前端，再自杀让 bat 接管替换。
            threading.Timer(1.5, _force_exit_for_update).start()
            return json.dumps({'ok': True, 'note': '应用即将退出并完成更新'}, ensure_ascii=False)
        except Exception as e:
            self._log.exception('apply_update 失败')
            return json.dumps({'error': str(e)}, ensure_ascii=False)


_BEFORE_EXIT_HOOK = None


def set_before_exit_hook(fn):
    """修复 W6（二轮）：apply 自杀用 os._exit 绕过 atexit，MCP 子进程会成孤儿——
    注册前置钩子（main.py 装配时挂 mcp_shutdown），退出前先收子进程。"""
    global _BEFORE_EXIT_HOOK
    _BEFORE_EXIT_HOOK = fn


def _force_exit_for_update():
    """W23 配套：自更新生效后强制退出本进程（bat 等待的就是这个退出）。"""
    try:
        if _BEFORE_EXIT_HOOK:
            _BEFORE_EXIT_HOOK()   # 修复 W6（二轮）：os._exit 前先关 MCP 子进程
    except Exception:
        pass
    try:
        os._exit(0)
    except Exception:
        pass


def cleanup_old_backup(logger=None):
    """修复 建议㉖：启动时清理上次自更新残留的 .bak 与 sentinel（原 .bak 永久残留）。

    修复 建议⑤（二轮）：sentinel 是「上次更新成功」的唯一凭证——原写了没人读、
    失败静默；现在读到即记日志（用户/支持者可从 harbor.log 确认更新成败）。
    修复 建议⑥（二轮）：清理历史版本 exe（原永不清理，UPDATE_DIR 无限膨胀）——
    保留当前版本包（harbor-<APP_VERSION>.exe）外，额外保留 mtime 最新的一个
    harbor-*.exe：那是「已下载未应用」的更新包（用户下载后没点应用/应用失败
    待重试），删掉要重新下一遍（最大 500MB）。
    返回被清理的文件数；仅在 frozen 模式下有意义。"""
    cleaned = 0
    try:
        if getattr(sys, 'frozen', False):
            bak = sys.executable + '.bak'
            if os.path.exists(bak):
                os.remove(bak)
                cleaned += 1
        if os.path.isdir(UPDATE_DIR):
            for fn in os.listdir(UPDATE_DIR):
                if fn.endswith('.sentinel'):
                    # 修复 建议⑤（二轮）：sentinel 存在 = 上次自更新替换成功
                    if logger:
                        logger.info('检测到自更新成功标记（%s），上次更新已正常应用', fn)
                if fn.endswith('.sentinel') or fn.endswith('.tmp'):
                    try:
                        os.remove(os.path.join(UPDATE_DIR, fn))
                        cleaned += 1
                    except Exception:
                        pass
        # 修复 建议⑥（二轮）：清理历史版本 exe（原永不清理，UPDATE_DIR 无限膨胀）
        try:
            keep = {'harbor-%s.exe' % APP_VERSION}
            exes = [fn for fn in os.listdir(UPDATE_DIR)
                    if fn.startswith('harbor-') and fn.endswith('.exe')]
            newest = None
            for fn in exes:
                try:
                    mt = os.path.getmtime(os.path.join(UPDATE_DIR, fn))
                except OSError:
                    continue
                if newest is None or mt > newest[0]:
                    newest = (mt, fn)
            if newest is not None:
                keep.add(newest[1])       # 已下载未应用的更新包：保留
            for fn in exes:
                if fn not in keep:
                    os.remove(os.path.join(UPDATE_DIR, fn))
                    cleaned += 1
        except Exception:
            pass
    except Exception as e:
        if logger:
            logger.debug('更新残留清理失败: %r', e)
    return cleaned
