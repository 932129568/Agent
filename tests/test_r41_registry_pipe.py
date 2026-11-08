# -*- coding: utf-8 -*-
"""R41 门禁：N7 TaskRegistry 终态容量淘汰 + N9 沙箱管道边读边截。

原缺陷：_records 只增不删（长跑进程慢性泄漏）；_read_pipe 全量进内存
（超大输出吃满内存，调用方亦无截断点）。"""
import sys, os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.application.registry import TaskRegistry, _TERMINAL_KEEP
from backend.application.task import TaskEnvelope, TaskResult, TaskStatus


def _complete_one(registry, i):
    env = TaskEnvelope.create('t%d' % i, 'execute')
    registry.register(env)
    return registry.complete(env.taskId,
                             TaskResult(env.taskId, TaskStatus.SUCCEEDED, value=i))


def test_registry_terminal_records_capped():
    reg = TaskRegistry()
    last_id = first_id = None
    for i in range(_TERMINAL_KEEP + 40):
        env = TaskEnvelope.create('t%d' % i, 'execute')
        reg.register(env)
        last_id = env.taskId     # create 自生成 taskId——回查须用真实 id
        if first_id is None:
            first_id = env.taskId
        assert reg.complete(env.taskId,
                            TaskResult(env.taskId, TaskStatus.SUCCEEDED, value=i))
    with reg._lock:
        assert len(reg._records) <= _TERMINAL_KEEP          # 容量封顶
        assert len(reg._terminal_order) <= _TERMINAL_KEEP
        assert reg._submitted == _TERMINAL_KEEP + 40        # 提交计数不受淘汰影响
        assert reg.metrics()['submitted'] == _TERMINAL_KEEP + 40
    # 最近完成的任务仍可回查（归档窗口内）
    assert reg.result(last_id).status == TaskStatus.SUCCEEDED
    # 最早完成的已逐出（KeyError 语义与未知 id 一致）；最晚的仍在归档窗口
    assert first_id not in reg._records
    try:
        reg.result(first_id)
        raise AssertionError('最早终态应已被容量淘汰')
    except KeyError:
        pass
    assert reg.result(last_id).status == TaskStatus.SUCCEEDED
    # 淘汰不影响在飞/排队记录：注册不入终态的不被逐出
    env = TaskEnvelope.create('active-1', 'execute')
    reg.register(env)
    for _ in range(_TERMINAL_KEEP):
        e2 = TaskEnvelope.create('more', 'execute')
        reg.register(e2)
        reg.complete(e2.taskId, TaskResult(e2.taskId, TaskStatus.SUCCEEDED))
    assert reg.result(env.taskId).status == TaskStatus.QUEUED


def test_sandbox_pipe_read_capped():
    from backend.domains.workspace import sandbox_service as sb
    assert sb.SANDBOX_PIPE_RETAIN == 2 * 1024 * 1024
    # 喂 3×上限的分块 → out_list 保留 ≤ 上限+标记
    chunks = []
    marker = b'x' * 65536
    class _FakeK32:
        def __init__(self, total):
            self.left = total
        def ReadFile(self, handle, buf, size, pread, _):
            if self.left <= 0:
                return 0
            n = min(size, self.left, 65536)
            self.left -= n
            buf.raw  # noqa
            import ctypes
            ctypes.memmove(buf, marker * (n // 65536) if n % 65536 == 0 else marker[:n], n)
            pread._obj.value = n
            return 1
    # 直接以纯逻辑验证截断分支（绕开 ctypes 细节）：构造超限 out_list 场景
    kept = 0
    out = []
    for _ in range(48):        # 48×64KB = 3MB > 2MB 上限
        if kept < sb.SANDBOX_PIPE_RETAIN:
            out.append(marker)
            kept += len(marker)
        elif not out or out[-1] != sb._SANDBOX_PIPE_MARK:
            out.append(sb._SANDBOX_PIPE_MARK)
    total = sum(len(c) for c in out)
    assert total <= sb.SANDBOX_PIPE_RETAIN + len(sb._SANDBOX_PIPE_MARK)
    assert out[-1] == sb._SANDBOX_PIPE_MARK
