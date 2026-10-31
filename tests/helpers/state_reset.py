# -*- coding: utf-8 -*-
"""P1-3（T04）跨用例单例复位集中表。

设计 §7.3 S1 治理：把「模块级单例跨用例残留」的复位动作集中到一张表里，
conftest 以追加的 autouse fixture 在每个用例前调用 reset_all()。
每项注明机理注释；未加载的模块静默跳过（best-effort，失败不阻断测试）。

现状（2026-10-30 治理轮）：
  - sandbox._STATS 复位原先内联在 conftest._reset_sandbox_stats（保留不动，
    本表同样复位以集中口径）；
  - guard/搜索/专家注册表经 Phase 0-2 诊断未见进程内残留泄漏（全量失败根因
    是外部 safe-delete guard 环境继承，见 conftest 尾部隔离块），故本表仅
    保留防御性复位位 + 已证实需要的项，避免过度复位掩盖真实回归信号。
"""
import sys


def _reset_sandbox_stats():
    """sandbox_service._STATS 模块级累计计数器（v1.6 实证先例）：
    真实执行（jobs_created +N）与失败注入（runs_failed_closed）在同一进程
    内互相污染，依赖「起步计数」的断言产生文件间顺序依赖。"""
    try:
        from backend.domains.workspace import sandbox_service as m
        with m._STATS_LOCK:
            for key in list(m._STATS.keys()):
                m._STATS[key] = 0
    except Exception:
        pass


def _reset_legacy_trace():
    """legacy._RT 运行态键漂移防御：真删/切会话类用例可能留下过期键，
    后续用例若按键存在性分支会误入。复位为初始键集（不存在则跳过）。"""
    try:
        conftest = sys.modules.get('conftest')
        legacy = getattr(conftest, 'legacy', None) if conftest else None
        rt = getattr(legacy, '_RT', None)
        if isinstance(rt, dict) and hasattr(legacy, '_RT_INITIAL_KEYS'):
            for key in list(rt.keys()):
                if key not in legacy._RT_INITIAL_KEYS:
                    rt.pop(key, None)
    except Exception:
        pass


RESET_TABLE = [
    ('sandbox._STATS', _reset_sandbox_stats),
    ('legacy._RT', _reset_legacy_trace),
]


def reset_all():
    """conftest autouse 调用入口：逐项复位，单项失败不影响其余。"""
    for _name, fn in RESET_TABLE:
        try:
            fn()
        except Exception:
            pass
