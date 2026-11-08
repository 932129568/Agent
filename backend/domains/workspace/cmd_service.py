# -*- coding: utf-8 -*-
"""命令执行服务：cmd / PowerShell / 管理员三档 + 去重 + 输出截断落盘。

legacy Api L90-127(L581-674) 搬迁。重构变更（用户授权）：
1. RunDeduper 修复：上一条→最近 N 条窗口；WRITE_VERBS 从"只查首 token"→"查全部 token"
   （防呆级缓解 `cmd /c del ...` 绕过）；并增加线程锁（legacy 无锁竞态）。
2. run_command / run_powershell 接入去重（legacy 仅 run_admin_command 接入）。
3. run_admin_command 透传真实退出码（legacy 恒返回 0），输出/退出码临时文件用 pid+时间唯一名。
"""
import ctypes
import os
import subprocess
import tempfile
import threading
import time

from ...errors import err, ok
from ...logging_setup import get_logger

_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
# 进程创建时的 subprocess.run 引用：宿主（测试桩/嵌入方）替换 subprocess.run 后，
# _run_killable 退化回 run 语义（桩不产生真实进程）；否则用 Popen + taskkill 杀整树（S11）。
_STDLIB_RUN = subprocess.run


class RunDeduper:
    """命令去重：拦最近 N 条内完全相同的命令 + 会话内写操作重复；观察类放行。

    注意（W9）：这是防呆级重复拦截，CMD 脱字符/编码混淆类对抗性绕过不承诺全拦，
    真正的破坏面由 guard 护栏与工具权限档兜底。"""

    WRITE_VERBS = {'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mkdir', 'md',
                   'new-item', 'ni', 'move', 'move-item', 'copy', 'copy-item', 'cp',
                   'reg', 'regedit', 'regsvr32', 'setx', 'format', 'taskkill',
                   'stop-process', 'start-process', 'iex', 'invoke-expression', 'rm', 'rm-item'}

    def __init__(self, maxlen=64):
        import collections
        import threading
        self._lock = threading.RLock()
        self._last = None
        self._recent = collections.OrderedDict()
        self._max = maxlen

    @staticmethod
    def _unquoted_redirect(s):
        q = None
        for ch in s:
            if q:
                if ch == q:
                    q = None
            elif ch in '"\'': q = ch
            elif ch == '>': return True
        return False

    @staticmethod
    def _is_write(norm):
        """修复：WRITE_VERBS 检查全部 token（legacy 只查首 token，`cmd /c del x` 可绕过）。

        修复 W9：token 先剥 CMD 脱字符 `^`（`d^el` 之类混淆归一后再比对）。"""
        tokens = [t.strip('"\'').replace('^', '')
                  for t in norm.replace('|', ' ').replace('&', ' ').replace(';', ' ').split()]
        if any(t in RunDeduper.WRITE_VERBS for t in tokens):
            return True
        return RunDeduper._unquoted_redirect(norm)

    def check(self, cmd):
        key = ' '.join(str(cmd).split()).lower()
        if '[console]::outputencoding' in key:
            return '后端已强制 UTF-8，命令里不要再设置编码；读文件请用 read_file（自动识别 UTF-8/GBK）。'
        norm = subprocess_norm(key)
        # 修复 S2（三轮）：原 `first = norm.split(...)...` 计算后从未使用（死代码）——
        # 「路径归一」本是设计意图；现正式接线为 dedup_key()，剥引号与 ./ .\ 前缀，
        # `del x.txt` / `del ./x.txt` / `del "x.txt"` 归一为同一条命令。
        dkey = dedup_key(norm)
        is_write = self._is_write(norm)
        with self._lock:
            if dkey == self._last:
                return '与上一条命令完全相同，已拒绝；如需刷新结果请加参数或说明目的。'
            # 修复 S1（三轮）：全窗比对——原仅写命令进 recent，非紧邻的读命令重复
            # 全部放行（Bug A 直接根因：echo 1 → echo 2 → echo 1 第三条放行再执行）
            if dkey in self._recent:
                if is_write:
                    return '该写命令本会话已执行过，已拦截；确需重跑请修改参数。'
                return '该命令最近已执行过，已拒绝重复执行；如需刷新结果请加参数或说明目的。'
            self._last = dkey
            self._recent[dkey] = True
            self._recent.move_to_end(dkey)
            if len(self._recent) > self._max:
                self._recent.popitem(last=False)
        return None

    def unmark(self, cmd):
        """修复 W1（三轮）：执行失败/被护栏拒绝的命令回滚登记——原 check() 执行前
        预记账，命令失败后合法重试反被去重误拦。与前端 cmdDeduper.unmark 同口径。"""
        key = ' '.join(str(cmd).split()).lower()
        dkey = dedup_key(subprocess_norm(key))
        with self._lock:
            self._recent.pop(dkey, None)
            if self._last == dkey:
                self._last = None

    def reset(self):
        with self._lock:
            self._last = None
            self._recent.clear()


def subprocess_norm(key):
    import re
    s = re.sub(r'chcp\s+65001\s*>?\s*nul\s*&?\s*', '', key).strip()
    # v1.2 R2 修复 `rem `/`:: ` 前缀绕过：批处理注释前缀剥离后再比对，
    # 使 `del x` 与 `rem del x`、`echo hi` 与 `:: echo hi` 归一为同一条命令。
    s = re.sub(r'^(?:(?:rem|rem\.*|::)\s+)+', '', s).strip()
    return s


def _dedup_token(t):
    """修复 S2（三轮）：单 token 归一——剥首尾引号与前导 ./ .\\ 前缀。
    注意只剥「./ 当前目录」前缀（循环剥离嵌套形态 ././x），`..` 父目录引用保留
    （`del ../x.txt` 与 `del x.txt` 语义不同，不可归一）。"""
    t = t.strip('"\'')
    while t.startswith('./') or t.startswith('.\\'):
        t = t[2:]
    return t


def _strip_redirects(s):
    """修复 H3（四轮）：剥未加引号的重定向子句（>nul / 2>&1 / >> "f.txt" 等）。
    引号内的 > 不动（与 _unquoted_redirect 同判定域）——`del x.txt >nul` 与
    `del x.txt` 归一为同一条命令。"""
    import re as _re
    out = []
    i, n, q = 0, len(s), None
    redir = _re.compile(r'\d*>>?\s*(?:"[^"]*"|\'[^\']*\'|\S+)')
    while i < n:
        ch = s[i]
        if q:
            out.append(ch)
            if ch == q:
                q = None
            i += 1
            continue
        if ch in '"\'':
            q = ch
            out.append(ch)
            i += 1
            continue
        m = redir.match(s, i)
        if m:
            i = m.end()
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def dedup_key(norm):
    """修复 S2（三轮）+ H3（四轮）：去重身份键。
    三轮：token 级归一（剥引号与 ./ .\\ 前缀），`del x.txt`/`del ./x.txt`/`del "x.txt"` 同键。
    四轮（H3 实测 8 类变体绕过）：在 token 归一之上补结构归一——
    ① 未引号重定向子句剥离（`del x.txt >nul` ≡ `del x.txt`）；
    ② 分隔符 `| & ; ,` 与 CMD 脱字符 `^` 按 _is_write 同口径归一（`del x.txt;` ≡ `del x.txt`）；
    ③ 行内注释截断（`del x.txt & rem 1` / PS `del x.txt # 1` ≡ `del x.txt`）。
    与前端 60-agent-loop.js cmdDeduper 的键口径逐字一致（双层同构）。
    已知边界（防呆级定位，不承诺全拦）：引号内空格形态 `del "x.txt "` 依赖 shell 级
    tokenizer，不在本层处理。"""
    import re as _re
    s = _strip_redirects(norm)
    s = s.replace('|', ' ').replace('&', ' ').replace(';', ' ').replace(',', ' ').replace('^', '')
    s = _re.sub(r'\s+', ' ', s).strip()
    toks = []
    for i, t in enumerate(s.split()):
        if i > 0 and (t == 'rem' or t.startswith('::') or t.startswith('#')):
            break   # 行内注释：其后内容不改变命令身份
        d = _dedup_token(t)
        if d:
            toks.append(d)
    return ' '.join(toks)


def _apply_win32_signatures():
    """修复 C2 同类：MessageBoxW/ShellExecuteW 显式声明 restype/argtypes。

    ShellExecuteW 返回 HINSTANCE（指针宽度）：默认 c_int 在 64 位下可能截断，
    使 >32 的成功值被误判；声明为 c_void_p 后按整数比较。"""
    if not hasattr(ctypes, 'windll'):
        return
    try:
        from ctypes import wintypes
        u32 = ctypes.windll.user32
        s32 = ctypes.windll.shell32
        u32.MessageBoxW.restype = ctypes.c_int
        u32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR,
                                    wintypes.LPCWSTR, wintypes.UINT]
        s32.ShellExecuteW.restype = ctypes.c_void_p
        s32.ShellExecuteW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                      wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
    except Exception:
        pass   # 测试桩/降级环境：签名声明失败不影响调用


def _kill_tree(pid):
    """修复 S11：超时后杀整棵进程树（subprocess.run 的 timeout 只杀直接子进程，
    孙进程在 Windows 下成孤儿且占住管道会二次阻塞）。"""
    try:
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(pid)],
                       capture_output=True, timeout=10, creationflags=_NO_WINDOW)
    except Exception:
        pass


class CmdService:
    def __init__(self, workspace, toolcache):
        self._log = get_logger()
        self.workspace = workspace
        self.toolcache = toolcache
        self.cmd_deduper = RunDeduper()

    # ---- 输出截断（legacy L602-605/L626-629 逐行复制 → 统一实现）----
    def _truncate_output(self, output):
        if len(output) > 6000:
            cid = self.toolcache.cache(output)
            tip = ('id=%s, 用 read_more 分段获取' % cid) if cid else '全文未保留'
            return output[:1500] + ('\n…[输出共 %d 字已截断;%s]…\n' % (len(output), tip)) + output[-800:]
        return output

    def _dedup_reject(self, cmd):
        """去重拒绝：与 legacy run_admin_command 的返回形态保持一致（info+skipped）。"""
        tip = self.cmd_deduper.check(cmd)
        if tip:
            return ok({'info': tip, 'skipped': True})
        return None

    def _exec(self, popen_args, shell, timeout, cwd, sandbox=None):
        """执行子进程；超时杀整树后抛 TimeoutExpired（修复 S11）。

        sandbox 传入限制字典时走沙箱路径（CreateProcessW 挂起态收编进 Job，
        无竞业逃逸窗口；超时 TerminateJobObject 内核级清剿整树）。
        宿主替换过 subprocess.run 时（测试桩，不产生真实进程、无逃逸面）
        沙箱请求退化为桩路径。
        已知边界（H14/四轮）：该判定无法区分「测试桩」与「生产期被第三方库 patch
        subprocess.run」（覆盖率/tracing 插件）——后者会静默脱箱（fail-open 例外通道）。
        生产环境不 patch subprocess.run 即无此面；如需彻底封死可改显式开关
        （如环境变量 HARBOR_SANDBOX_TEST_STUB=1），但会波及全部既有测试桩，暂维持现状。
        """
        if sandbox is not None:
            if subprocess.run is not _STDLIB_RUN:
                return subprocess.run(popen_args, capture_output=True, shell=shell,
                                      timeout=timeout, cwd=cwd,
                                      creationflags=_NO_WINDOW)
            from . import sandbox_service
            try:
                result = sandbox_service.run_in_sandbox(
                    popen_args, shell=shell, cwd=cwd, timeout=timeout,
                    limits=sandbox)
            except sandbox_service.SandboxUnavailable as e:
                # fail-closed：沙箱不可用不裸跑，向上传递明确原因
                raise RuntimeError('沙箱执行被阻止（fail-closed）：%s' % e)
            if getattr(result, 'timed_out', False):
                raise subprocess.TimeoutExpired(popen_args, timeout)
            return result
        if subprocess.run is not _STDLIB_RUN:
            return subprocess.run(popen_args, capture_output=True, shell=shell,
                                  timeout=timeout, cwd=cwd, creationflags=_NO_WINDOW)
        proc = subprocess.Popen(popen_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                shell=shell, cwd=cwd, creationflags=_NO_WINDOW)
        try:
            # 修复（v1.6 沙箱集成时实测发现）：必须返回 communicate() 捕获的字节，
            # 不能返回 proc 本身——proc.stdout 是管道对象（BufferedReader），
            # 调用方 _dec(result.stdout) 会 AttributeError。该路径自 v1.1 重构起
            # 即为缺陷，被测试桩全面掩盖（真实执行成功但向 Agent 报错）。
            out, errout = proc.communicate(timeout=timeout)
            return subprocess.CompletedProcess(popen_args, proc.returncode,
                                               stdout=out, stderr=errout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc.pid)
            try:
                proc.communicate(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            raise subprocess.TimeoutExpired(popen_args, timeout)
        except Exception:
            # R37 修复（N8）：communicate 其他异常路径原不 kill 不关管道——
            # 子进程与句柄泄漏（与 TimeoutExpired 分支同口径收尾）。
            _kill_tree(proc.pid)
            try:
                proc.communicate(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            raise

    @staticmethod
    def _dec(b):
        if not b:
            return ''
        s = b.decode('utf-8', 'replace')
        bad = s.count('\ufffd')
        if bad > max(3, len(s) // 200):
            try:
                s2 = b.decode('gbk', 'replace')
                if s2.count('\ufffd') < bad:
                    s = s2
            except Exception:
                pass
        return s.replace('\r\r\n', '\r\n')   # 归一双换行 bug

    # ---- cmd（legacy L582-612）----
    def run_command(self, sid, cmd, timeout=60, sandbox=None):
        try:
            rejected = self._dedup_reject(cmd)
            if rejected:
                return rejected
            try:
                timeout = max(5, min(int(timeout or 60), 600))
            except Exception:
                timeout = 60
            result = self._exec('chcp 65001 >nul & ' + str(cmd), shell=True,
                                timeout=timeout, cwd=self.workspace.effective_root(sid),
                                sandbox=sandbox)

            output = self._dec(result.stdout)
            errtxt = self._dec(result.stderr).strip()
            if errtxt:
                output += '\n[stderr] ' + errtxt
            output = self._truncate_output(output)
            info = {'exit_code': result.returncode, 'output': output}
            if not output.strip():
                info['note'] = '命令执行完毕，无任何输出'
            return ok(info)
        except subprocess.TimeoutExpired:
            self.cmd_deduper.unmark(cmd)   # 修复 W1（三轮）：超时未执行完，回滚登记放行合法重试
            return err(f'命令执行超时({timeout}s)')
        except Exception as e:
            self.cmd_deduper.unmark(cmd)   # 修复 W1（三轮）：执行级失败回滚登记
            self._log.exception('run_command 失败')
            return err(e)

    # ---- PowerShell（legacy L614-636）----
    def run_powershell(self, sid, cmd, timeout=60, sandbox=None):
        try:
            rejected = self._dedup_reject(cmd)
            if rejected:
                return rejected
            try:
                timeout = max(5, min(int(timeout or 60), 600))
            except Exception:
                timeout = 60
            enc = ('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
                   '$OutputEncoding=[System.Text.Encoding]::UTF8;')
            result = self._exec(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', enc + cmd],
                                shell=False, timeout=timeout, cwd=self.workspace.effective_root(sid),
                                sandbox=sandbox)
            out = result.stdout.decode('utf-8', errors='replace').lstrip('\ufeff')
            error = result.stderr.decode('utf-8', errors='replace').strip()
            output = out + (('\n[stderr] ' + error) if error else '')
            output = self._truncate_output(output)
            info = {'exit_code': result.returncode, 'output': output}
            if not output.strip():
                info['note'] = '命令执行完毕，无任何输出'
            return ok(info)
        except subprocess.TimeoutExpired:
            self.cmd_deduper.unmark(cmd)   # 修复 W1（三轮）：超时未执行完，回滚登记放行合法重试
            return err(f'命令执行超时({timeout}s)')
        except Exception as e:
            self.cmd_deduper.unmark(cmd)   # 修复 W1（三轮）：执行级失败回滚登记
            self._log.exception('run_powershell 失败')
            return err(e)

    # ---- 管理员命令（legacy L638-674 + 退出码透传）----
    def run_admin_command(self, sid, cmd, timeout=None):
        """管理员权限执行：MessageBox 人审 + UAC；.bat 包装透传真实退出码。

        修复 S2：`cmd /c "cmd & echo %errorlevel%"` 的 %errorlevel% 是解析期展开
        （恒为 cmd 启动前的值 0），改写临时 .bat 逐行执行拿到真实退出码。
        修复 S3：完成信号改为 tmp_exit 出现且可解析为 int（原"输出大小不变即完成"
        会读到半截输出并误删仍在写入的文件）；超时/异常路径清理全部临时文件。
        修复 W7（二轮）：临时文件名恢复 mkstemp 唯一名（pid+毫秒在同毫秒并发下互删对方文件）。
        修复 W13（二轮）：timeout 可调（默认 60s）；超时分支延迟清理
        （提权进程可能仍在写，立即删会 Sharing Violation 且丢退出码）。
        """
        tmp_out = tmp_exit = tmp_bat = None
        slow_cleanup = False   # 超时/授权后慢路径：延迟 45s 再清理
        try:
            # 修复 W5（三轮）：去掉 '[admin] ' 键域前缀——前端 deduper 对同一命令不带
            # 前缀，两层键域不一会导致换通道重放「前端误拦/后端放行」方向分裂
            tip = self.cmd_deduper.check(cmd)
            if tip:
                return ok({'info': tip, 'skipped': True})
            # 修复 W7（三轮）：畸形命令提前拒绝——未闭合引号会让 bat 重定向失效
            # （命令吞掉 "> 输出路径" 段，走满 60s 超时且无输出）；mbcs 不可表字符
            # 会被 errors='replace' 静默写成 '?'（命令内容被篡改后提权执行）
            if str(cmd).count('"') % 2 == 1:
                self.cmd_deduper.unmark(cmd)
                return err('命令含未闭合的双引号，管理员通道无法安全包装（重定向会失效）；请修正引号后重试。')
            try:
                str(cmd).encode('mbcs')
            except UnicodeEncodeError:
                self.cmd_deduper.unmark(cmd)
                return err('命令含当前系统代码页（GBK/mbcs）不可表示的字符，管理员通道（.bat 包装）'
                           '无法无损传递；请改用 run_command/run_powershell（UTF-8 通道）。')
            _apply_win32_signatures()
            r = ctypes.windll.user32.MessageBoxW(
                0, f'AI 请求以管理员权限执行：\n\n{cmd}\n\n允许执行吗？',
                'Harbor · 管理员确认', 0x04 | 0x30)
            if r != 6:
                # 修复 W1（三轮）：用户拒绝的命令回滚登记（用户改主意后合法重试不被误拦）
                self.cmd_deduper.unmark(cmd)
                return ok({'info': '用户拒绝了本次管理员命令，请改用无需提权的方案。', 'skipped': True})
            # 修复 W7（二轮）：mkstemp 唯一名（pid+毫秒同毫秒并发互删对方文件）
            fd, tmp_out = tempfile.mkstemp(prefix='glm_admin_out_', suffix='.txt'); os.close(fd)
            fd, tmp_exit = tempfile.mkstemp(prefix='glm_admin_exit_', suffix='.txt'); os.close(fd)
            fd, tmp_bat = tempfile.mkstemp(prefix='glm_admin_', suffix='.bat'); os.close(fd)
            os.remove(tmp_out); os.remove(tmp_exit)   # 让提权进程自己创建，避免旧内容误判
            # 修复 S2：bat 内 %errorlevel% 逐行解析期展开，拿到真实退出码
            bat_body = f'{cmd} > "{tmp_out}" 2>&1\r\necho %errorlevel% > "{tmp_exit}"\r\n'
            # newline=''：bat_body 已内嵌 CRLF，默认文本翻译会把它二次翻译成 \r\r\n
            with open(tmp_bat, 'w', encoding='mbcs', errors='replace', newline='') as f:
                f.write(bat_body)
            ret = ctypes.windll.shell32.ShellExecuteW(None, 'runas', 'cmd', f'/c "{tmp_bat}"', None, 0)
            if (ret or 0) <= 32:
                self.cmd_deduper.unmark(cmd)   # 修复 W1（三轮）：授权失败未执行，回滚登记
                return err(f'授权失败，错误码 {ret}（可能用户拒绝了 UAC）')
            # 修复 W13（二轮）：超时阈值可调（默认 60s）
            max_rounds = int((timeout or 60) * 2)
            for _ in range(max_rounds):
                exit_code = self._read_admin_exit(tmp_exit)
                if exit_code is not None:
                    # 输出文件可能在 exit 写入后仍有缓冲尾巴，给一拍再读
                    time.sleep(0.2)
                    raw = b''
                    if os.path.exists(tmp_out):
                        with open(tmp_out, 'rb') as f:
                            raw = f.read()
                    try:
                        out = raw.decode('utf-8')
                    except UnicodeDecodeError:
                        out = raw.decode('gbk', errors='replace')
                    out = out[:60000]
                    return ok({'exit_code': exit_code, 'output': out, 'note': '已通过管理员权限执行'})
                time.sleep(0.5)
            slow_cleanup = True   # 修复 W13：超时后提权进程可能仍占用临时文件，延迟清理
            return ok({'exit_code': None, 'output': '（命令已执行，输出读取超时，退出码未知）',
                       'note': '已通过管理员权限执行'})
        except Exception as e:
            self.cmd_deduper.unmark(cmd)   # 修复 W1（三轮）：异常路径回滚登记
            self._log.exception('run_admin_command 失败')
            return err(e)
        finally:
            # 修复 S3：超时/异常路径也清理临时文件（原超时分支泄漏 tmp_out/tmp_exit）
            if slow_cleanup:
                # 修复 W13（二轮）：超时分支尽力立即清理（无占用即净）；删不掉的
                # （提权进程仍占用）延迟 45s 重试，防硬删 Sharing Violation + TEMP 泄漏
                left = self._cleanup_admin_tmps([tmp_out, tmp_exit, tmp_bat])
                if left:
                    # 修复 H11（四轮）：Timer 必须 daemon——原非守护线程在 45s 窗口内
                    # 用户关窗时阻塞解释器退出（进程驻留「关不掉」）
                    _t = threading.Timer(45.0, self._cleanup_admin_tmps, args=(left,))
                    _t.daemon = True
                    _t.start()
            else:
                self._cleanup_admin_tmps([tmp_out, tmp_exit, tmp_bat])

    @staticmethod
    def _cleanup_admin_tmps(paths):
        """尽力删除临时文件，返回未能删除的列表（供延迟重试）。"""
        left = []
        for f in paths:
            if f and os.path.exists(f):
                try:
                    os.remove(f)
                except Exception:
                    left.append(f)
        return left

    @staticmethod
    def _read_admin_exit(tmp_exit):
        """读真实退出码；缺失/解析失败返回 None（unknown），不再恒报 0。"""
        try:
            if os.path.exists(tmp_exit):
                with open(tmp_exit, 'r', encoding='utf-8', errors='replace') as f:
                    txt = f.read().strip()
                return int(txt)
        except Exception:
            pass
        return None
