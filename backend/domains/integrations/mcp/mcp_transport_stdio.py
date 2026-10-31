# -*- coding: utf-8 -*-
"""MCP stdio 传输（v1.3 R1）：子进程 + 换行分隔 JSON 帧 + 读线程 + stderr drain。

设计口径（架构 §3.3 / 生命周期规范）：
- subprocess.Popen + CREATE_NO_WINDOW（Windows 防控制台弹窗）；bytes 管道 + UTF-8。
- 读线程按行切帧入队列；stderr 独立 drain 线程防阻塞（子进程写满 stderr 会挂死）。
- 写锁串行化 stdin（并发 tools/call 安全）。
- 规范关闭序列：关 stdin → 等 3s → terminate → 等 2s → kill。

修复：
- W17：子进程环境默认白名单透传（原完整继承 os.environ，环境变量密钥泄漏给不可信服务器）。
- W18：单行超长（>8MB）断开 + 帧队列 maxsize（原通知洪泛/超长行无内存上限，远程 DoS）。
- S4（二轮）：防御性断开走完整断开设义（_closed=True + kill 子进程）——原只 break
  读线程，is_alive 仍 True 致永不重拉，流氓服务器一个超长帧瘫痪该服务器 10 分钟。
- ⑬：读线程启动失败时 terminate 子进程（原子进程泄漏）。
- ⑭：send 与 close 互斥（持写锁检查 _closed，原可写到已关闭管道）。
"""
import json
import os
import queue
import subprocess
import threading

from ....logging_setup import get_logger

_EOF = object()      # 读线程 EOF 哨兵（区别于 recv 超时返回的 None）

_MAX_LINE = 8 * 1024 * 1024     # 修复 W18：单帧上限 8MB（超限断开）
_QUEUE_MAX = 1024               # 修复 W18：帧队列上限（通知洪泛内存上限）

# 修复 W17：子进程环境白名单（MCP 服务器只需运行时基础变量；密钥类变量不透传）
_ENV_WHITELIST = (
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'OS',
    'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'PYTHONUTF8', 'PYTHONIOENCODING',
    'NODE_OPTIONS', 'NPM_CONFIG_PREFIX', 'UV_CACHE_DIR',
)


class StdioTransport:
    """stdio 传输：send(obj) 写一行 JSON；recv(timeout) 取一帧（None=超时/EOF）。"""

    def __init__(self, logger=None):
        self._log = logger or get_logger()
        self._proc = None
        self._queue = queue.Queue(maxsize=_QUEUE_MAX)
        self._write_lock = threading.Lock()
        self._reader = None
        self._drain = None
        self._closed = False
        self._eof = False   # 修复 ⑮（三轮）：读线程 EOF 置位（is_alive 据此判死，防僵尸空转）

    def start(self, command: str, args: list, env: dict) -> bool:
        """拉起子进程并启动读线程。失败返回 False（不抛）。"""
        try:
            # 修复 W17：白名单透传宿主环境 + 用户显式配置的 env（原完整继承泄漏密钥）
            full_env = {}
            for k in _ENV_WHITELIST:
                if k in os.environ:
                    full_env[k] = os.environ[k]
            for k, v in (env or {}).items():
                full_env[str(k)] = str(v)
            creationflags = 0
            if hasattr(subprocess, 'CREATE_NO_WINDOW'):
                creationflags = subprocess.CREATE_NO_WINDOW
            argv = [str(command)] + [str(a) for a in (args or [])]
            self._proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=creationflags, env=full_env)
            try:
                self._reader = threading.Thread(target=self._read_loop, daemon=True,
                                                name='mcp-stdio-read')
                self._reader.start()
                self._drain = threading.Thread(target=self._drain_stderr, daemon=True,
                                               name='mcp-stdio-stderr')
                self._drain.start()
            except Exception:
                # 修复 ⑬：线程启动失败时杀掉已拉起的子进程（原子进程泄漏）
                try:
                    self._proc.kill()
                    self._proc.wait(timeout=3)   # 修复 建议⑫（二轮）：wait 回收僵尸，防 PID 泄漏
                except Exception:
                    pass
                # 修复 建议⑫（二轮）：关管道句柄（否则父进程持有读端，孙进程不退出）
                for _p in (self._proc.stdin, self._proc.stdout, self._proc.stderr):
                    try:
                        if _p is not None:
                            _p.close()
                    except Exception:
                        pass
                raise
            return True
        except Exception as e:
            self._log.warning('stdio 传输启动失败（命令 %r）: %r', command, e)
            self._closed = True
            return False

    # ---- 读写 ----
    def send(self, obj: dict) -> None:
        """json.dumps + '\n'；写锁串行化。管道已断时抛异常（由 client 层处理）。

        修复 ⑭：持锁期间复查 _closed（close 不再与 send 竞态写半关管道）。"""
        with self._write_lock:
            if self._closed or self._proc is None or self._proc.stdin is None:
                raise BrokenPipeError('stdio 传输未启动或已关闭')
            data = (json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8')
            self._proc.stdin.write(data)
            self._proc.stdin.flush()

    def recv(self, timeout: float):
        """队列取一帧；None=超时或 EOF（调用方用 is_alive 区分）。"""
        try:
            item = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        if item is _EOF:
            return None
        return item

    def is_alive(self) -> bool:
        # 修复 S4（二轮）：_closed 也算死（防御性断开后必须让上层触发重拉）
        # 修复 ⑮（三轮）：_eof 也算死——原 EOF 后读线程结束但进程不退（僵尸）时
        # is_alive 恒真，recv 恒 None，调用方无限空转
        return not self._closed and not self._eof and self._proc is not None and self._proc.poll() is None

    def _defensive_abort(self, reason):
        """修复 S4（二轮）：防御性断开统一走完整断开设义——置 _closed + 杀子进程，
        原实现只 break 读线程（传输「半死」：is_alive 恒真、请求全部超时、永不重拉）。"""
        self._log.warning('stdio 防御性断开（%s），子进程已终止', reason)
        self._closed = True
        try:
            if self._proc is not None:
                self._proc.kill()
        except Exception:
            pass

    @property
    def returncode(self):
        return self._proc.poll() if self._proc is not None else None

    # ---- 内部线程 ----
    def _read_loop(self):
        try:
            assert self._proc is not None and self._proc.stdout is not None
            while True:
                # 修复 W18：readline(limit)——单行超 8MB 判定异常服务器，断开
                raw = self._proc.stdout.readline(_MAX_LINE)
                if not raw:
                    break                            # EOF
                if len(raw) >= _MAX_LINE and not raw.endswith(b'\n'):
                    self._log.warning('stdio 帧超过 %d 字节上限，断开连接', _MAX_LINE)
                    self._defensive_abort('单帧超 %d 字节' % _MAX_LINE)   # 修复 S4：不再留半死状态
                    break
                line = raw.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line.decode('utf-8', 'replace'))
                except Exception:
                    self._log.warning('stdio 帧解析失败，已丢弃: %r', line[:120])
                    continue
                try:
                    self._queue.put(frame, timeout=5)
                except queue.Full:
                    # 修复 W18：队列满（通知洪泛）断开而非无限积压
                    self._log.warning('stdio 帧队列已满（%d），断开连接', _QUEUE_MAX)
                    self._defensive_abort('帧队列满 %d' % _QUEUE_MAX)   # 修复 S4：不再留半死状态
                    break
        except Exception as e:
            self._log.debug('stdio 读线程结束: %r', e)
        finally:
            self._eof = True   # 修复 ⑮（三轮）：读线程结束即置 EOF（进程不退时 is_alive 判死）
            try:
                self._queue.put(_EOF, timeout=1)
            except Exception:
                pass

    def _drain_stderr(self):
        try:
            assert self._proc is not None and self._proc.stderr is not None
            for raw in self._proc.stderr:
                text = raw.decode('utf-8', 'replace').rstrip()
                if text:
                    self._log.debug('MCP 服务器 stderr: %s', text[:300])
        except Exception:
            pass

    # ---- 关闭 ----
    def close(self) -> None:
        """规范关闭序列：关 stdin → 等 3s → terminate → 等 2s → kill。"""
        if self._closed:
            return
        # 修复 ⑭：置 _closed 持写锁，与 send 互斥
        with self._write_lock:
            self._closed = True
        proc = self._proc
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            try:
                proc.wait(timeout=3)
            except Exception:
                pass
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except Exception:
                    pass
            if proc.poll() is None:
                proc.kill()
                try:
                    proc.wait(timeout=2)
                except Exception:
                    pass
        except Exception as e:
            self._log.warning('stdio 关闭异常: %r', e)
        finally:
            for pipe in (proc.stdout, proc.stderr):
                try:
                    if pipe is not None:
                        pipe.close()
                except Exception:
                    pass
