# -*- coding: utf-8 -*-
"""C 路径 · 步骤 1：golden 契约快照的发布门校验。

设计要点（重要，勿改回「在 pytest 进程内重放」）：
  `run_suite()` 的部分输出依赖**进程内共享状态**（RuntimeState 的 ws_enabled 开关）。
  全量 pytest 中前序测试会改写它，已实证导致 `list_dir_root` 从「缺少 path 参数」
  漂移到「本会话已关闭使用文件夹」。因此：
    - 本模块只做**静态冻结校验**（文件 / sha256 / 序列数 / 结构）；
    - 行为重放由 `tools/contract_golden_replay.py` 在**独立子进程**执行，
      本模块通过 subprocess 调用它，保证重放环境无污染。

用法：
  python tools/contract_golden_replay.py --export   # 从冻结基准重新导出
  pytest tests/test_contract_golden.py -q           # 静态校验 + 独立进程重放

快照来源：legacy.Api() 在确定性 stubs 下的 95 项调用序列
（`test_api_contract.py::run_suite`），经 norm + test_home_* 归一化。
sha256 冻结在 `frontend/app/docs/golden-manifest.json`，由架构门禁复核。
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / 'deliverables' / 'dev-plan' / 'contract-golden' / 'api-suite.json'
MANIFEST = ROOT / 'frontend' / 'app' / 'docs' / 'golden-manifest.json'
REPLAY = ROOT / 'tools' / 'contract_golden_replay.py'


def test_golden_snapshot_is_frozen():
    """静态冻结：哈希、序列数、契约自省面必须与 manifest 完全一致。"""
    assert GOLDEN.is_file(), 'golden 未生成，请先运行 replay --export'
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    raw = GOLDEN.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest['sha256'], 'golden 哈希漂移'
    data = json.loads(raw.decode('utf-8'))
    assert len(data) == manifest['sequenceCount']
    assert 'get_api_info' in data
    assert len(data) >= 60, '快照调用序列过少: %d' % len(data)


def test_golden_replay_in_isolated_process():
    """行为重放：独立进程执行，避免全量套件的共享状态污染。"""
    assert REPLAY.is_file(), '缺少独立重放器'
    env = dict(__import__('os').environ)
    env.pop('HARBOR_EXPORT_GOLDEN', None)
    proc = subprocess.run([sys.executable, str(REPLAY)], cwd=str(ROOT), env=env,
                          capture_output=True, text=True, encoding='utf-8',
                          errors='replace', timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert '[golden] PASS' in proc.stdout, proc.stdout
