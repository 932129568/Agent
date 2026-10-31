# -*- coding: utf-8 -*-
"""Current-process-only performance counters with explicit unsupported states."""
import ctypes
from ctypes import wintypes
import platform
import threading
import time


def _uncovered(reason):
    return {'status': 'UNCOVERED', 'reason': str(reason)}


def _filetime_ms(filetime):
    return ((filetime.dwHighDateTime << 32) | filetime.dwLowDateTime) / 10000.0


def sample_process():
    """Sample only the calling process; never inspect or modify other processes."""
    if platform.system() != 'Windows':
        return _uncovered('Windows process counters are unavailable on this platform')
    try:
        class FILETIME(ctypes.Structure):
            _fields_ = [('dwLowDateTime', wintypes.DWORD),
                        ('dwHighDateTime', wintypes.DWORD)]

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD),
                        ('PageFaultCount', wintypes.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t),
                        ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t),
                        ('PeakPagefileUsage', ctypes.c_size_t)]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [('ReadOperationCount', ctypes.c_ulonglong),
                        ('WriteOperationCount', ctypes.c_ulonglong),
                        ('OtherOperationCount', ctypes.c_ulonglong),
                        ('ReadTransferCount', ctypes.c_ulonglong),
                        ('WriteTransferCount', ctypes.c_ulonglong),
                        ('OtherTransferCount', ctypes.c_ulonglong)]

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        process = kernel32.GetCurrentProcess()
        kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.c_void_p] * 4
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        kernel32.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        kernel32.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        creation, exit_time, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if not kernel32.GetProcessTimes(process, ctypes.byref(creation), ctypes.byref(exit_time),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            raise ctypes.WinError(ctypes.get_last_error())
        memory = PROCESS_MEMORY_COUNTERS()
        memory.cb = ctypes.sizeof(memory)
        if not psapi.GetProcessMemoryInfo(process, ctypes.byref(memory), memory.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        handles = wintypes.DWORD()
        if not kernel32.GetProcessHandleCount(process, ctypes.byref(handles)):
            raise ctypes.WinError(ctypes.get_last_error())
        counters = IO_COUNTERS()
        if not kernel32.GetProcessIoCounters(process, ctypes.byref(counters)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {
            'status': 'OK', 'scope': 'current-process',
            'user_ms': _filetime_ms(user), 'kernel_ms': _filetime_ms(kernel),
            'rss_bytes': int(memory.WorkingSetSize),
            'threads': threading.active_count(), 'handles': int(handles.value),
            'io_read_bytes': int(counters.ReadTransferCount),
            'io_write_bytes': int(counters.WriteTransferCount),
        }
    except (AttributeError, OSError, TypeError, ValueError) as error:
        return _uncovered('Windows process counters unsupported: %s' % error)


class ProcessSampler:
    """Lightweight before/after sampler for one measured code region."""

    def __init__(self):
        self._before = None
        self._started = None

    def before(self):
        self._started = time.perf_counter()
        self._before = sample_process()
        return self._before

    def after(self):
        if self._before is None or self._started is None:
            raise RuntimeError('before() must be called before after()')
        after = sample_process()
        wall_ms = (time.perf_counter() - self._started) * 1000.0
        if self._before.get('status') != 'OK' or after.get('status') != 'OK':
            return {'status': 'UNCOVERED', 'before': self._before, 'after': after,
                    'wall_ms': wall_ms}
        delta = {'wall_ms': wall_ms}
        for key in ('user_ms', 'kernel_ms', 'rss_bytes', 'threads', 'handles',
                    'io_read_bytes', 'io_write_bytes'):
            delta[key] = after[key] - self._before[key]
        return {'status': 'OK', 'scope': 'current-process',
                'before': self._before, 'after': after, 'delta': delta}
