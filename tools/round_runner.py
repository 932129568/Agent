# -*- coding: utf-8 -*-
"""自动化检测轮次 runner（主理人立项：代码级反复检测，逐轮如实记录）。

用法：python tools/round_runner.py --rounds N [--full] [--no-record] [--node PATH]
  每轮执行：
    1) 前端构建（幂等，哈希一致则零输出变化）
    2) 全量 pytest 门禁（--full 时；否则核心子集）
    3) 静态哨兵：语法检查全部 src 模块（node --check 逐个）
  默认每轮写一行 JSON 记录到 deliverables/dev-plan/scan-rounds.jsonl：
    {round, ts, build_ok, tests_passed, tests_failed, failures[], syntax_errors,
     duration_s}
  --no-record（CI 用）不写该 append-only 记账文件，其余行为完全一致。

诚实纪律：轮次必须真实执行，失败如实记录；不生成未运行的轮次。

退出码：任一轮非 green / 构建失败 / 语法错误 → 1；全绿 → 0（供 CI 语义）。
Node 解析：--node > 环境变量 HARBOR_NODE > PATH 里的 node > 旧硬编码路径
（R26 起不再绑定本机绝对路径，干净 CI 可直接跑）。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORD = ROOT / 'deliverables' / 'dev-plan' / 'scan-rounds.jsonl'
LEGACY_NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'

CORE = [
    'tests/test_resume.py', 'tests/test_icon_system.py',
    'tests/test_perf_guards.py', 'tests/test_api_surface_consistency.py',
    'tests/test_group_mention.py', 'tests/test_group_endpoints.py',
    'tests/test_group_files.py', 'tests/test_group_persistence.py',
    'tests/test_group_unlimited_relay.py', 'tests/test_frontend_tree.py',
    'tests/test_modern_build.py', 'tests/test_glm_preset_real_models.py',
]


def resolve_node(explicit=None):
    """CI 友好：显式参数 > 环境变量 > PATH > 旧硬编码路径 > 裸命令名。"""
    for cand in (explicit, os.environ.get('HARBOR_NODE'),
                 shutil.which('node'), LEGACY_NODE):
        if cand and os.path.exists(cand):
            return cand
    return 'node'


def run(cmd, timeout):
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout,
                       errors='replace')
    return p, round(time.time() - t0, 1)


_SYNTAX_BATCH_JS = r"""
const fs = require('fs'), vm = require('vm');
const files = JSON.parse(fs.readFileSync(0, 'utf8') || '[]');
const bad = [];
for (const f of files) {
  try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); }
  catch (e) { bad.push(f); }
}
console.log(JSON.stringify(bad));
"""


def syntax_sweep(node):
    """前端模块语法哨兵（R27：104 次 node 进程启动 → 1 次批量 V8 编译）。

    vm.Script 与 `node --check` 同为「编译不执行」语义，判据等价；批量通道
    异常时自动回落逐文件 --check，门禁强度不降低。文件列表走 stdin，规避
    Windows 命令行长度限制。
    """
    src = ROOT / 'frontend' / 'src'
    files = [p.relative_to(ROOT).as_posix() for p in sorted(src.glob('**/*.js'))]
    try:
        p = subprocess.run([node, '-e', _SYNTAX_BATCH_JS], input=json.dumps(files),
                           cwd=ROOT, capture_output=True, text=True, timeout=120,
                           errors='replace')
        if p.returncode == 0:
            parsed = json.loads((p.stdout or '').strip() or '[]')
            if isinstance(parsed, list):
                return parsed
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    # 回落：逐文件 --check（保持原有判据，不因批量通道故障漏判）
    bad = []
    for f in files:
        q = subprocess.run([node, '--check', str(ROOT / f)], capture_output=True, text=True)
        if q.returncode != 0:
            bad.append(f)
    return bad


def one_round(idx, full, node):
    rec = {'round': idx, 'ts': time.strftime('%Y-%m-%d %H:%M:%S')}
    t0 = time.time()

    build, _ = run([node, 'frontend/build.js'], 120)
    rec['build_ok'] = build.returncode == 0
    if build.returncode != 0:
        rec['build_err'] = (build.stderr or build.stdout)[-300:]

    rec['syntax_errors'] = syntax_sweep(node)

    targets = ['tests/'] if full else CORE
    p, dur = run([sys.executable, '-m', 'pytest', *targets, '-q', '-p', 'no:cacheprovider'], 900)
    rec['tests_duration_s'] = dur
    out = (p.stdout or '')
    failed_names = []
    for line in out.splitlines():
        if line.startswith('FAILED '):
            failed_names.append(line[7:].split(' ')[0])
    rec['tests_passed'] = None
    rec['tests_failed'] = None
    rec['failures'] = failed_names
    for part in out.replace('\r', '\n').split('\n'):
        pt = part.strip()
        if ' passed' in pt or ' failed' in pt or 'error' in pt.lower():
            m = re.search(r'(\d+) passed', pt)
            f = re.search(r'(\d+) failed', pt)
            e = re.search(r'(\d+) error', pt)
            if m or f or e:
                rec['tests_passed'] = int(m.group(1)) if m else 0
                rec['tests_failed'] = (int(f.group(1)) if f else 0) + (int(e.group(1)) if e else 0)
                break

    rec['duration_s'] = round(time.time() - t0, 1)
    ok = rec['build_ok'] and not rec['syntax_errors'] and rec['tests_passed'] is not None
    rec['verdict'] = 'green' if ok and not failed_names else ('green-with-known-failures' if ok else 'red')
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rounds', type=int, default=5)
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--label', default='')
    ap.add_argument('--node', default='',
                    help='显式指定 node 可执行文件（默认按 HARBOR_NODE / PATH 解析）')
    ap.add_argument('--no-record', action='store_true',
                    help='不写 scan-rounds.jsonl（CI 用；默认仍逐轮记账）')
    args = ap.parse_args()

    node = resolve_node(args.node)
    print('node:', node)
    if not args.no_record:
        RECORD.parent.mkdir(parents=True, exist_ok=True)
    greens = 0
    failed_rounds = 0
    for i in range(1, args.rounds + 1):
        rec = one_round(i, args.full, node)
        if args.label:
            rec['label'] = args.label
        if not args.no_record:
            with open(RECORD, 'a', encoding='utf-8') as f:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        print('round %d: %s build=%s passed=%s failed=%s (%.0fs)' % (
            i, rec['verdict'], rec['build_ok'], rec['tests_passed'],
            rec['tests_failed'], rec['duration_s']))
        for name in rec['failures'][:8]:
            print('   FAILED', name)
        if rec['verdict'] == 'green':
            greens += 1
        if rec['verdict'] != 'green' or not rec['build_ok'] or rec['syntax_errors']:
            failed_rounds += 1
    print('greens: %d/%d' % (greens, args.rounds))
    return 1 if failed_rounds else 0


if __name__ == '__main__':
    sys.exit(main())
