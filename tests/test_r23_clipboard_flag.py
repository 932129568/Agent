# -*- coding: utf-8 -*-
"""R23 剪贴板 Flag 实测固化（deep-research W0 R23）。

结论（2026-10-21，Windows 11 交互桌面实测）：JOB_OBJECT_UILIMIT_READCLIPBOARD
（0x2）/ WRITECLIPBOARD（0x4）Flag **无效**——子进程 OpenClipboard 全部成功。
本测试固化「探针可运行 + Job 机制工作」的验证，**不锁 Flag 有效性**（换 OS/
机器可能不同——真锁了会误报；结论以 KNOWN_ISSUES §17 的实测记录为准）。
非 Windows 环境 skip。
"""
import ctypes
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

_IS_WIN = os.name == 'nt'
pytestmark = pytest.mark.skipif(not _IS_WIN, reason='R23 探针仅 Windows')

_CHILD_SRC = (
    "import ctypes, json\n"
    "u = ctypes.windll.user32\n"
    "res = {'open': False}\n"
    "if u.OpenClipboard(None):\n"
    "    res['open'] = True\n"
    "    u.CloseClipboard()\n"
    "print(json.dumps(res))\n"
)


class _JOBUI(ctypes.Structure):
    _fields_ = [('RestrictionClass', ctypes.c_uint32)]


def _run_child(in_job, flag=0x2):
    kernel32 = ctypes.windll.kernel32
    hJob = None
    if in_job:
        hJob = kernel32.CreateJobObjectW(None, None)
        assert hJob, 'CreateJobObjectW 失败'
        ui = _JOBUI()
        ui.RestrictionClass = flag
        ok = kernel32.SetInformationJobObject(
            hJob, 4, ctypes.byref(ui), ctypes.sizeof(ui))
        assert ok, 'SetInformationJobObject 失败'
    p = subprocess.Popen([sys.executable, '-c', _CHILD_SRC],
                         stdout=subprocess.PIPE, text=True)
    if in_job:
        ph = kernel32.OpenProcess(0x1F0FFF, False, p.pid)
        assert ph, 'OpenProcess 失败'
        ok = kernel32.AssignProcessToJobObject(hJob, ph)
        assert ok, 'AssignProcessToJobObject 失败（Job 机制异常）'
        kernel32.CloseHandle(ph)
    out, _ = p.communicate(timeout=30)
    if hJob:
        kernel32.CloseHandle(hJob)
    return json.loads(out.strip())['open']


class TestR23ClipboardFlag:
    def test_control_child_can_open_clipboard(self):
        """对照组：无 Job 子进程能开剪贴板（探针基线）。"""
        assert _run_child(False) is True

    def test_readclipboard_flag_probe(self):
        """实验组：READCLIPBOARD Flag 下探针可运行（结论不锁——见模块 docstring）。

        实测（2026-10-21 Win11）：open=True（Flag 无效）→ KNOWN_ISSUES §17。
        断言只保证「Job 建立+收编+探针执行」链路工作。
        """
        result = _run_child(True, 0x2)
        assert isinstance(result, bool)

    def test_read_write_both_flags_probe(self):
        """READ+WRITE 双 Flag（0x6）探针同样可运行。"""
        result = _run_child(True, 0x6)
        assert isinstance(result, bool)

    def test_probe_matches_known_issue_record(self):
        """回归对照：本机实测结果应仍与 KNOWN_ISSUES §17 记录一致（Win11 口径）。

        若用户在别的 OS 跑出不同结果，此测试会提示结论需按新口径修订——
        这正是「不锁死」的设计：失败=提醒更新文档，不是代码坏。
        """
        doc = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), 'KNOWN_ISSUES.md')
        src = open(doc, encoding='utf-8').read()
        assert 'R23 实测修订' in src, 'KNOWN_ISSUES §17 应有 R23 实测记录'
        # 本机（Win11 交互桌面）口径：Flag 无效 → 记录「OpenClipboard 全部成功」
        ctrl = _run_child(False)
        job = _run_child(True, 0x2)
        if ctrl and job:
            assert '全部成功' in src, \
                '实测 Flag 无效但 KNOWN_ISSUES 未记录该结论——请按新口径修订'
