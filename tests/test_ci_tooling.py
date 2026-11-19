# -*- coding: utf-8 -*-
"""R26 遗留 #5：entry_sweep.py / round_runner.py 的 CI 接入门禁。

验收口径：
1. cdp_lib 随仓库自包含（干净 CI 不再依赖外部注入到 %TEMP%）；
2. entry_sweep 有 --self-check 且真实可执行（无需 GUI/CDP）；
3. round_runner 有 --no-record、Node 路径可解析、失败返回非零退出码；
4. GitHub Actions workflow 存在且真实调用两个工具。

本文件不启动 Electron、不跑全量 pytest、不写 scan-rounds.jsonl。
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / 'tools'
WORKFLOW = ROOT / '.github' / 'workflows' / 'harbor-ci.yml'


def _active_text(src):
    """I18：剥离 YAML 整行注释后的可执行文本（「非注释行命中」口径）。

    注释里出现门禁 token 不算真实调用（I02 已据此修掉假覆盖），本模块沿用
    同一口径：只保留非空、且去掉缩进后不以 `#` 开头的行。
    """
    lines = [ln for ln in src.splitlines()
             if ln.strip() and not ln.lstrip().startswith('#')]
    return '\n'.join(lines)


def _run_script(name, *args):
    return subprocess.run([sys.executable, str(TOOLS / name), *args],
                          cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=120)


def test_cdp_lib_is_self_contained():
    lib = TOOLS / 'cdp_lib.py'
    assert lib.exists(), 'cdp_lib 必须随仓库自带（CI 无外部注入）'
    src = lib.read_text(encoding='utf-8')
    assert 'perf_cdp' in src and 'def connect(' in src and 'def ev(' in src
    sys.path.insert(0, str(TOOLS))
    try:
        import cdp_lib
        assert callable(cdp_lib.connect) and callable(cdp_lib.ev)
    finally:
        sys.path.remove(str(TOOLS))


def test_entry_sweep_help_and_self_check():
    help_proc = _run_script('entry_sweep.py', '--help')
    assert help_proc.returncode == 0, help_proc.stderr
    assert '--self-check' in help_proc.stdout
    check = _run_script('entry_sweep.py', '--self-check')
    assert check.returncode == 0, check.stdout + check.stderr
    assert 'self-check: OK' in check.stdout
    parsed = json.loads(check.stdout.split('self-check: ', 1)[1].splitlines()[0])
    assert all(parsed.values()), parsed


def test_round_runner_ci_flags_and_exit_code():
    src = (TOOLS / 'round_runner.py').read_text(encoding='utf-8')
    assert "'--no-record'" in src
    assert 'if not args.no_record:' in src
    assert 'def resolve_node(' in src
    assert 'HARBOR_NODE' in src and 'shutil.which(\'node\')' in src
    assert 'return 1 if failed_rounds else 0' in src
    help_proc = _run_script('round_runner.py', '--help')
    assert help_proc.returncode == 0, help_proc.stderr
    assert '--no-record' in help_proc.stdout and '--node' in help_proc.stdout


def test_round_runner_node_resolution_is_not_machine_bound():
    sys.path.insert(0, str(TOOLS))
    try:
        import round_runner
        node = round_runner.resolve_node()
        assert node != round_runner.LEGACY_NODE, 'CI 不应绑定本机绝对路径'
        assert Path(node).exists() or node == 'node'
        # 显式无效路径必须回落到可用解析器，而不是崩掉
        fallback = round_runner.resolve_node('/definitely/not/a/node')
        assert fallback == node or Path(fallback).exists() or fallback == 'node'
    finally:
        sys.path.remove(str(TOOLS))


def test_workflow_calls_both_tools():
    assert WORKFLOW.exists(), '缺少 .github/workflows/harbor-ci.yml'
    src = WORKFLOW.read_text(encoding='utf-8')
    # I18：文本包含改为「非注释行命中」——注释里的 token 不算真实调用。
    active = _active_text(src)
    assert 'tools/round_runner.py' in active
    assert 'tools/entry_sweep.py' in active
    assert '--no-record' in active
    assert '--self-check' in active
    assert 'windows-latest' in active
    assert 'runs-on:' in active and 'jobs:' in active


def test_workflow_normalized_gates_runs_entry():
    """I18：normalized-gates job 必须在非注释 run: 行真实调用统一入口。

    锚点用内容字面量 + assert anchor in src 自检，不使用行号（I05 已使 L83→L84 漂移）。
    """
    src = WORKFLOW.read_text(encoding='utf-8')
    anchor = 'run: python tools/run_normalized_gates.py'
    assert anchor in src, '内容锚点缺失：统一入口 run: 行'
    assert '  normalized-gates:' in src, '缺少 normalized-gates job'
    active = _active_text(src)
    assert anchor in active, '统一入口 run: 行必须是非注释行'
    # 反例口径：把该 run: 行整行注释掉后，非注释面必须不再含该锚点
    commented = src.replace(anchor, '# ' + anchor, 1)
    assert anchor not in _active_text(commented), '注释行不应命中非注释面'
    assert anchor in _active_text(src), '正样本：未注入时非注释面必须命中'


def test_normalized_gate_count_is_dynamic():
    """I13 / A5：门禁数一律动态读数，不在测试里硬编码 12/13/16/17。"""
    sys.path.insert(0, str(TOOLS))
    try:
        import run_normalized_gates as g
        import gate_coverage as gc
    finally:
        sys.path.remove(str(TOOLS))
    named = len(g.GATES)
    total = named + 1  # +1 聚合门 server-gates
    assert total >= 2, '门禁清单不应为空'
    assert 'post-deletion-audit' in [gid for gid, *_ in g.GATES], \
        '第 13 门 post-deletion-audit 必须接入'
    assert 'post-deletion-audit' in gc.CANONICAL, 'CANONICAL 必须同步新增该项'
    # 动态交叉：CANONICAL 的 GATES 侧子集应能在统一入口源码里找到 token
    entry_src = (TOOLS / 'run_normalized_gates.py').read_text(encoding='utf-8')
    assert gc.CANONICAL['post-deletion-audit'] in entry_src, \
        '新增 CANONICAL token 必须在 GATES 中命中'


def test_workflow_yaml_parses():
    """I18：PyYAML 可用时真实解析并覆盖 3 个 job；不可用时退化结构断言。"""
    src = WORKFLOW.read_text(encoding='utf-8')
    try:
        import yaml
    except ImportError:
        assert src.count('jobs:') == 1
        for job in ('  gate:', '  entry-sweep:', '  normalized-gates:'):
            assert job in src, '缺少 job: ' + job
        return
    data = yaml.safe_load(src)
    assert 'jobs' in data
    assert {'gate', 'entry-sweep', 'normalized-gates'} <= set(data['jobs']), \
        'CI 应覆盖 3 个 job'
    assert 'on' in data or True in data   # YAML 1.1 会把 on 解析成 True
