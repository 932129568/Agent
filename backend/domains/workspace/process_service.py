# -*- coding: utf-8 -*-
"""进程服务：枚举与强杀（legacy Api L756-801 搬迁）。

重构变更（用户授权）：kill_process 增加关键进程保护名单，
禁止强杀系统关键进程与 Harbor 自身（v1.0.0 `taskkill /F /T` 无任何护栏）。
"""
import ctypes
import json
import os
import subprocess

from ...errors import ok
from ...logging_setup import get_logger

# 关键进程保护名单（小写比较）：强杀可致系统不稳定/会话丢失
PROTECTED_NAMES = {
    'system', 'system idle process', 'idle',
    'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
    'services.exe', 'lsass.exe', 'svchost.exe', 'explorer.exe',
    'dwm.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe',
}
# pid 保护：Idle(0)/System(4)/自身
PROTECTED_PIDS = {0, 4}

_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def _decode_console(raw):
    """控制台输出解码：Windows tasklist/taskkill 输出为 OEM 代码页。

    修复 W13：原实现先 UTF-8 再 GBK 启发式回退，中文进程名易被误判乱码，
    导致按名过滤/按名 kill 失效。改为 OEM 代码页优先（GetOEMCP），
    以替换符数量最少为准在非 UTF-8 场景中兜底。
    """
    if not raw:
        return ''
    candidates = []
    try:
        if hasattr(ctypes, 'windll'):
            candidates.append('cp%d' % ctypes.windll.kernel32.GetOEMCP())
    except Exception:
        pass
    candidates += ['utf-8', 'gbk']
    best, best_bad = None, None
    for enc in candidates:
        try:
            s = raw.decode(enc, 'replace')
        except LookupError:
            continue
        bad = s.count('\ufffd')   # 修复 H10（四轮）：原 s.count('') 恒为 len+1，「替换符最少」从未生效
        if best is None or bad < best_bad:
            best, best_bad = s, bad
        if bad == 0:
            break
    return best if best is not None else raw.decode('utf-8', 'replace')


class ProcessService:
    def __init__(self):
        self._log = get_logger()

    def list_processes(self, keyword=None):
        """列出进程(按内存降序, 可选关键字过滤)，供 kill_process 使用"""
        try:
            r = subprocess.run(['tasklist', '/fo', 'csv', '/nh'],
                               capture_output=True, timeout=20,
                               creationflags=_NO_WINDOW)
            raw = _decode_console(r.stdout)
            procs = []
            for line in raw.splitlines():
                parts = [x.strip('"') for x in line.split('","')]
                if len(parts) < 5:
                    continue
                name, pid, mem = parts[0], parts[1], parts[4]
                if keyword and keyword.lower() not in name.lower():
                    continue
                try:
                    memv = int(mem.replace(',', '').replace('K', '').strip())
                except Exception:
                    memv = 0
                procs.append((memv, name, pid))
            procs.sort(reverse=True)
            procs = procs[:120]
            lines = [f'{name}  pid={pid}  mem={memv // 1024}MB' for memv, name, pid in procs]
            return ok({'ok': True, 'count': len(lines), 'processes': lines,
                       'note': '按内存占用降序，最多 120 条；结束进程用 kill_process'})
        except Exception as e:
            return ok({'error': str(e)})

    def resolve_name_by_pid(self, pid):
        """tasklist 按 PID 反查进程名（修复 C1：按 pid 强杀也必须过进程名名单）。

        返回进程名字符串；查不到/失败返回 None（None 时调用方只做 pid 名单检查）。
        """
        try:
            pid_i = int(str(pid).strip())
        except (TypeError, ValueError):
            return None
        try:
            r = subprocess.run(['tasklist', '/fi', 'PID eq %d' % pid_i, '/fo', 'csv', '/nh'],
                               capture_output=True, timeout=15,
                               creationflags=_NO_WINDOW)
            raw = _decode_console(r.stdout)
            for line in raw.splitlines():
                parts = [x.strip('"') for x in line.split('","')]
                if len(parts) >= 2 and parts[1].strip() == str(pid_i):
                    return parts[0]
        except Exception as e:
            self._log.warning('pid=%s 反查进程名失败: %r', pid, e)
        return None

    @staticmethod
    def _protection_reason(pid=None, name=None):
        if pid is not None:
            try:
                pid_i = int(pid)
            except Exception:
                return None
            if pid_i in PROTECTED_PIDS or pid_i == os.getpid():
                return f'pid={pid_i} 是系统关键进程或 Harbor 自身，已拒绝强杀'
        if name:
            if str(name).strip().lower() in PROTECTED_NAMES:
                return f'进程 {name} 属于系统关键进程，已拒绝强杀'
        return None

    def kill_process(self, pid=None, name=None):
        try:
            if pid is not None:
                # 修复 C1：pid 非数字直接报错（原 int() 失败静默放行）
                try:
                    int(str(pid).strip())
                except (TypeError, ValueError):
                    return ok({'error': 'pid 必须是数字: %r' % pid})
                # 修复 S2（二轮）：pid 非空时反查结果权威——伪造 name 不再架空名单；
                # 反查与传入 name 不一致即拒绝（防「pid=<lsass>, name=notepad」绕过）
                resolved = self.resolve_name_by_pid(pid)
                if resolved:
                    if name and str(name).strip().lower() != resolved.strip().lower():
                        return ok({'error': 'pid=%s 实际进程名为 %s，与传入 name=%s 不一致，已拒绝'
                                            % (pid, resolved, name)})
                    name = resolved
            # 修复 S3（二轮）：taskkill /IM 原生支持通配符，name 含 */? 可批量强杀
            # （'*' 杀当前用户一切进程）——直接拒绝，提示先枚举确认确切进程名
            if name and ('*' in str(name) or '?' in str(name)):
                return ok({'error': '进程名不支持通配符（* / ?），'
                                    '请先用 list_processes 确认确切进程名后按名/按 pid 结束'})
            reason = self._protection_reason(pid, name)
            if reason:
                return ok({'error': reason + '（保护名单）'})
            if pid is not None:
                r = subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'],
                                   capture_output=True, timeout=20,
                                   creationflags=_NO_WINDOW)
            elif name:
                r = subprocess.run(['taskkill', '/IM', str(name), '/T', '/F'],
                                   capture_output=True, timeout=20,
                                   creationflags=_NO_WINDOW)
            else:
                return ok({'error': '需要 pid 或 name 参数'})
            # taskkill 输出保持 legacy 的 GBK 解码（契约逐字节比对；OEM=GBK 时两者一致）
            out = r.stdout.decode('gbk', 'replace').strip() or r.stderr.decode('gbk', 'replace').strip()
            return ok({'ok': r.returncode == 0, 'exit_code': r.returncode, 'output': out[:2000]})
        except Exception as e:
            return ok({'error': str(e)})
