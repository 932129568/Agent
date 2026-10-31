# -*- coding: utf-8 -*-
"""P1-3（T04）状态探针 —— pytest 诊断插件（诊断期专用，不进常规链路）。

用法（本目录加入 PYTHONPATH 后 -p 挂载；输出建议放 outputs/pytest-tmp/）：
    PYTHONPATH=tools/diag python -m pytest tests/ -q -p state_probe \\
        --state-probe-out=outputs/pytest-tmp/diag-final/state-leaks.json

每个用例 setup/teardown 各快照一次（teardown 快照在 fixture finalizer 之前取，
fresh_home 的 rmtree/重建不计入差异），维度（设计 §7.2 Phase 2）：
  - cwd          os.getcwd()（S4 cwd 漂移）
  - env          os.environ 相对 setup 的增/删/改（S3 真实路径/env 泄漏；
                 pytest 自身变量与 HOME 指针豁免）
  - threads      threading.enumerate() 相对首用例基线的新增线程（S2 后台迟写）
  - singletons   模块级单例值指纹（S1/S6）：sandbox _STATS、legacy._RT、
                 搜索任务注册表等（best-effort，模块未加载 → null）
  - home-tree / open-files   信息面：只随条目记录观察值，不判定泄漏

teardown ≠ setup 且差异未登记豁免 → 记入 --state-probe-out 的 JSON。
探针只观察不判定：任何自身异常都被吞掉并记 probe_error，绝不影响测试结果。
"""
import json
import os
import sys
import threading

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(os.path.dirname(_HERE))

# pytest/解释器运行时会变动的环境键（不计泄漏）
EXEMPT_ENV_KEYS = {
    'PYTEST_CURRENT_TEST', 'PYTEST_VERSION', 'COVERAGE_FILE', 'COVERAGE_PROCESS_START',
    'SYSTEMDRIVE',  # Windows 惰性填充，与用例无关
}

# 豁免线程清单（设计 §7.4 验收第 2 条：豁免必须附原因与复审日期）
# - MainThread / pydevd：解释器与调试器固有。
# - harbor-local-cors-proxy：本地 CORS 代理是进程级幂等单例（模块级 _PROXY，
#   ensure_running 幂等），全程恒为 1 线程、有界；conftest 的 S2 停机钩子
#   刻意不停它——停掉后单例不会自愈，后续用例的 get_local_proxy 会拿到死服务。
#   真正的根治（代理生命周期随容器关停）属业务源码改动，超出 T04 测试治理
#   红线（不改业务源码），故按「显式豁免 + 复审日期」登记。
#   复审日期：2026-11-30（P0-1b/后续业务轮处理）
EXEMPT_THREAD_NAMES = {
    'MainThread',
    'pydevd.CommandThread',
    'harbor-local-cors-proxy',
}
EXEMPT_THREAD_REVIEW_DATE = '2026-11-30'

# 模块级插件状态
_STATE = {
    'out_path': None,
    'baseline_threads': None,
    'setup_snapshot': None,
    'entries': [],
}


# ---------------------------------------------------------------- 单例指纹表
def _probe_sandbox_stats():
    try:
        from backend.domains.workspace import sandbox_service as m
        return dict(getattr(m, '_STATS', {}) or {})
    except Exception:
        return None


def _probe_legacy_rt():
    try:
        conftest = sys.modules.get('conftest')
        legacy = getattr(conftest, 'legacy', None) if conftest else None
        rt = getattr(legacy, '_RT', None)
        return sorted(rt.keys()) if isinstance(rt, dict) else None
    except Exception:
        return None


def _probe_search_tasks():
    try:
        import backend.domains.integrations.browser.service as m
        tasks = getattr(m, '_TASKS', None)
        if isinstance(tasks, dict):
            return sorted(str(k) for k in tasks.keys())
        return None
    except Exception:
        return None


def _probe_expert_registry():
    try:
        import backend.domains.expert.builtin_importer as m
        imported = getattr(m, '_IMPORTED', None)
        return sorted(imported) if isinstance(imported, (set, list, dict)) else None
    except Exception:
        return None


SINGLETON_PROBES = {
    'sandbox._STATS': _probe_sandbox_stats,
    'legacy._RT': _probe_legacy_rt,
    'search._TASKS': _probe_search_tasks,
    'expert.imported': _probe_expert_registry,
}


def _home_tree_fingerprint():
    home = os.environ.get('USERPROFILE') or os.environ.get('HOME') or ''
    if not home or not os.path.isdir(home):
        return None
    count = 0
    total = 0
    for base, _dirs, files in os.walk(home):
        count += len(files)
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return {'files': count, 'bytes': total}


def _open_files_count():
    try:
        import psutil
        return len(psutil.Process().open_files())
    except Exception:
        return None


def _take_snapshot():
    env = {k: v for k, v in os.environ.items() if k not in EXEMPT_ENV_KEYS}
    return {
        'cwd': os.getcwd(),
        'env': env,
        'threads': sorted(t.name for t in threading.enumerate()),
        'singletons': {name: probe() for name, probe in SINGLETON_PROBES.items()},
        'home_tree': _home_tree_fingerprint(),
        'open_files': _open_files_count(),
    }


def _diff_snapshots(before, after):
    """(leaks, info)：leaks 非空 = 未豁免的状态差异；info 为观察值。"""
    diff = {}
    if before.get('cwd') != after.get('cwd'):
        diff['cwd'] = {'before': before.get('cwd'), 'after': after.get('cwd')}
    env_before = before.get('env') or {}
    env_after = after.get('env') or {}
    env_diff = {}
    added = {k: v for k, v in env_after.items() if k not in env_before}
    removed = {k: env_before[k] for k in env_before if k not in env_after}
    changed = {k: [env_before[k], env_after[k]] for k in env_before
               if k in env_after and env_before[k] != env_after[k]}
    if added:
        env_diff['added'] = added
    if removed:
        env_diff['removed'] = removed
    if changed:
        env_diff['changed'] = changed
    if env_diff:
        diff['env'] = env_diff
    threads_before = set(before.get('threads') or [])
    threads_after = set(after.get('threads') or [])
    new_threads = threads_after - threads_before - EXEMPT_THREAD_NAMES
    if new_threads:
        diff['threads'] = {'new': sorted(new_threads)}
    singleton_diff = {}
    for name, value in (after.get('singletons') or {}).items():
        if value != (before.get('singletons') or {}).get(name):
            singleton_diff[name] = {'before': (before.get('singletons') or {}).get(name),
                                    'after': value}
    if singleton_diff:
        diff['singletons'] = singleton_diff
    info = {'home_tree_after': after.get('home_tree'),
            'open_files_after': after.get('open_files')}
    return diff, info


# ---------------------------------------------------------------- pytest 钩子
def pytest_addoption(parser):
    group = parser.getgroup('state-probe')
    group.addoption('--state-probe-out', action='store', default=None,
                    help='状态泄漏报告输出路径（JSON）；缺省 outputs/pytest-tmp/state-leaks.json')


def pytest_configure(config):
    default_out = os.path.join(
        os.environ.get('HARBOR_DIAG_OUT', os.path.join(_PROJECT_ROOT, 'outputs', 'pytest-tmp')),
        'state-leaks.json')
    _STATE['out_path'] = config.getoption('--state-probe-out') or default_out


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item):
    """pre-yield 快照 = fixture 装配之前（跨用例残留的接收态锚点；用例自身
    fixture 内的 env 设置/复位与 monkeypatch 往返不在差异面内）。"""
    try:
        _STATE['setup_snapshot'] = _take_snapshot()
        if _STATE['baseline_threads'] is None:
            # 首个用例的在场线程 = 本进程基线（conftest legacy import 等常驻者）
            _STATE['baseline_threads'] = set(_STATE['setup_snapshot']['threads'])
    except Exception as error:
        _STATE['entries'].append({'nodeid': item.nodeid, 'probe_error': str(error)})
    yield


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item):
    """post-yield 快照 = fixture finalizer（fresh_home 复位/state_reset/cwd 恢复）
    之后——只报告「 sanctioned 恢复机制处理不掉」的残留。conftest 的线程停机
    钩子（plain impl）与默认 finalizer 都在 yield 前完成。"""
    yield
    try:
        after = _take_snapshot()
        before = _STATE['setup_snapshot'] or {}
        if _STATE['baseline_threads']:
            before = dict(before)
            before['threads'] = sorted(set(before.get('threads') or [])
                                        - _STATE['baseline_threads'])
            after = dict(after)
            after['threads'] = sorted(set(after.get('threads') or [])
                                      - _STATE['baseline_threads'])
        diff, info = _diff_snapshots(before, after)
    except Exception as error:
        _STATE['entries'].append({'nodeid': item.nodeid, 'probe_error': str(error)})
        return
    entry = {'nodeid': item.nodeid, 'info': info}
    if diff:
        entry['leaks'] = diff
    _STATE['entries'].append(entry)


def pytest_sessionfinish(session, exitstatus):
    leaking = [e for e in _STATE['entries'] if e.get('leaks')]
    _STATE['baseline_threads'] = sorted(_STATE['baseline_threads'] or [])
    _STATE['summary'] = {
        'tests': len(_STATE['entries']),
        'leaking_tests': len(leaking),
        'probe_errors': len([e for e in _STATE['entries'] if e.get('probe_error')]),
        'baseline_threads': _STATE['baseline_threads'],
    }
    _STATE.pop('setup_snapshot', None)  # 瞬态现场不入报告
    out = _STATE['out_path']
    try:
        directory = os.path.dirname(os.path.abspath(out))
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(_STATE, f, ensure_ascii=False, indent=1)
        sys.stderr.write('[state_probe] leaks=%d/%d -> %s\n'
                         % (len(leaking), len(_STATE['entries']), out))
    except Exception as error:
        sys.stderr.write('[state_probe] 报告写入失败: %s\n' % error)
