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
    assert 'tools/round_runner.py' in src
    assert 'tools/entry_sweep.py' in src
    assert '--no-record' in src
    assert '--self-check' in src
    assert 'windows-latest' in src
    assert 'runs-on:' in src and 'jobs:' in src


def test_workflow_yaml_parses():
    """PyYAML 可用时做真实解析；不可用时退化为结构断言（不引入新依赖）。"""
    try:
        import yaml
    except ImportError:
        src = WORKFLOW.read_text(encoding='utf-8')
        assert src.count('jobs:') == 1
        assert '  gate:' in src and '  entry-sweep:' in src
        return
    data = yaml.safe_load(WORKFLOW.read_text(encoding='utf-8'))
    assert 'jobs' in data and {'gate', 'entry-sweep'} <= set(data['jobs'])
    assert 'on' in data or True in data   # YAML 1.1 会把 on 解析成 True
