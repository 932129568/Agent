# -*- coding: utf-8 -*-
"""R40（K10）门禁：begin_task 去重器 per-sid 化。

原缺陷：api.begin_task 无条件清全局 RunDeduper——与他会话在飞 run_command
交叠时其在飞登记被洗白（模型循环写命令的安全网失效）。Node 侧 P0-3 已是
per-sid（commands.js `${sid}:${cmd}` 前缀）；本组测试锁定 Python 侧同语义：
同会话新任务照常 reset（W2 保留），他会话登记不受影响（K10 修复）。"""
import json
import sys, os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402,F401


def _svc():
    from backend.domains.workspace import cmd_service

    class _Ws:
        def effective_root(self, sid):
            return '.'

    class _Tc:
        def cache(self, text):
            return 'tc_stub'

    return cmd_service.CmdService(_Ws(), _Tc())


def test_begin_task_only_clears_current_sid():
    svc = _svc()
    d_a = svc._deduper_for('sA')
    d_b = svc._deduper_for('sB')
    assert d_a.check('del a.txt') is None            # A 首次执行登记
    assert d_b.check('del b.txt') is None            # B 首次执行登记
    svc.dedup_reset('sB')                            # B 会话 begin_task
    # K10 核心：A 的在飞登记不被 B 的 begin_task 洗白（重复写命令仍被拒，
    # 文案可能是 _last 紧邻拒绝或 _recent 窗口拒绝，二选一都算拦截）
    assert d_a.check('del a.txt')
    # W2 保留：B 的新任务从零开始（同命令在 B 可重新执行）
    assert d_b.check('del b.txt') is None
    # 空 sid 回落 legacy 单实例（契约兼容）
    assert svc._deduper_for(None) is svc.cmd_deduper
    assert svc._deduper_for('') is svc.cmd_deduper


def test_run_command_scopes_dedup_by_sid():
    """run_command 的登记/回滚按入参 sid 命名空间（不依赖全局 current_sid）。"""
    svc = _svc()
    assert svc._dedup_reject('del x.txt', 'sA') is None    # A 登记并放行
    assert svc._dedup_reject('del x.txt', 'sA') is not None   # A 重复被拦
    assert svc._dedup_reject('del x.txt', 'sB') is None    # B 同命令首次放行（隔离）
    # 失败回滚也按 sid（unmark 不串台）
    assert svc._deduper_for('sA').check('del y.txt') is None
    svc._deduper_for('sA').unmark('del y.txt')
    assert svc._deduper_for('sA').check('del y.txt') is None
    assert svc._deduper_for('sB').check('del y.txt') is None


def test_api_begin_task_wiring(fresh_home):
    """Api 层接线：begin_task 只清 runtime 当前 sid 的去重窗口。"""
    from backend.api import Api
    api = Api()
    api.set_current_sid('sA')
    d_a = api._cmds._deduper_for('sA')
    d_b = api._cmds._deduper_for('sB')
    d_a.check('del x'); d_b.check('del y')
    assert json.loads(json.dumps(api.begin_task())) == 'ok' or api.begin_task() == 'ok'
    assert d_a.check('del x') is None            # 当前会话已清（W2）
    assert d_b.check('del y')                    # 他会话未被洗白（K10）
