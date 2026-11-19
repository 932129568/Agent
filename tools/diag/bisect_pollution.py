# -*- coding: utf-8 -*-
"""P1-3（T04）最小污染对自动二分 —— pytest 包装（诊断期专用）。

定位「同进程顺序执行」约束下的最小污染集 (P, V)：候选污染源集合 P 在同一
pytest 进程里先于受害者 V 执行，若 V 失败则 P 含污染源；对 P 做集合收缩
（每次尝试砍掉一半），直到不可再缩 → 最小污染集。

用法：
    python tools/diag/bisect_pollution.py --victim "tests/test_x.py::T::test_v" \
        --candidates tests/a.py tests/b.py \
        [--python <解释器>] [--basetemp-root outputs/pytest-tmp] [--log <jsonl>]

说明：
  - 每轮验证 = 一个全新 pytest 子进程（candidates... + victim 同进程按序执行），
    与全量连跑的污染形态一致；basetemp 每轮独立目录。
  - node-id 级收缩：当候选收縮到单文件后，可把该文件的用例 id 列表再作为
    --candidates 传入做用例级二分（--collect-only 自动枚举）。
  - 日志（JSONL）记录每轮「保留集 → victim 结果」，供归档复核。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(os.path.dirname(_HERE))


def run_python(python, node_ids, basetemp, junit_path):
    """跑一轮：node_ids 顺序执行；返回 (failed_ids, returncode)。"""
    cmd = [python, '-m', 'pytest', *node_ids, '-q',
           '-p', 'no:cacheprovider',
           '--basetemp', basetemp,
           '--junitxml', junit_path]
    result = subprocess.run(cmd, cwd=_PROJECT_ROOT, capture_output=True, text=True,
                            timeout=1800)
    failed = []
    try:
        import xml.etree.ElementTree as ET
        tree = ET.parse(junit_path)
        for tc in tree.iter('testcase'):
            for f in list(tc):
                if f.tag == 'failure':
                    failed.append('%s::%s' % (tc.get('classname'), tc.get('name')))
    except Exception:
        pass
    return failed, result.returncode


def normalize_id(node_id):
    """tests/test_x.py::T::t → tests.test_x::T::t（junit classname 形态）。"""
    path, _, rest = node_id.partition('::')
    path = path.replace('\\', '/').replace('/', '.')
    if path.endswith('.py'):
        path = path[:-3]
    return '%s::%s' % (path, rest) if rest else path


def verify(python, candidates, victim, round_no, basetemp_root, log_fh):
    """candidates + victim 同进程一轮；victim 失败 = True。"""
    basetemp = os.path.join(basetemp_root, 'bisect-r%d' % round_no)
    junit = os.path.join(basetemp_root, 'bisect-r%d-junit.xml' % round_no)
    node_ids = [*candidates, victim]
    failed, _code = run_python(python, node_ids, basetemp, junit)
    victim_failed = normalize_id(victim) in failed or victim in failed
    if log_fh:
        log_fh.write(json.dumps({
            'round': round_no, 'kept': list(candidates), 'victim': victim,
            'victim_failed': victim_failed, 'failed_count': len(failed),
        }, ensure_ascii=False) + '\n')
        log_fh.flush()
    return victim_failed


def shrink(python, candidates, victim, basetemp_root, log_fh):
    """集合收缩二分：从全量候选开始，反复尝试砍半，直到砍不动。"""
    current = list(candidates)
    round_no = 0
    # 前置确认：全量候选下 victim 必须失败，否则组合不成立
    if not verify(python, current, victim, round_no, basetemp_root, log_fh):
        return None
    round_no += 1
    improved = True
    while improved and len(current) > 1:
        improved = False
        half = len(current) // 2
        for part in (current[:half], current[half:]):
            if not part:
                continue
            if verify(python, part, victim, round_no, basetemp_root, log_fh):
                current = part
                round_no += 1
                improved = True
                break
    return current


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--victim', required=True, help='受害者 node id（tests/...::Class::test）')
    parser.add_argument('--candidates', nargs='+', required=True,
                        help='候选污染源（文件或 node id 列表；文件级先跑，可再喂用例级）')
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--basetemp-root', default=os.path.join(
        _PROJECT_ROOT, 'outputs', 'pytest-tmp', 'diag-bisect'))
    parser.add_argument('--log', default=None, help='二分日志 JSONL 输出路径')
    args = parser.parse_args()

    os.makedirs(args.basetemp_root, exist_ok=True)
    log_fh = open(args.log, 'w', encoding='utf-8') if args.log else None
    try:
        minimal = shrink(args.python, args.candidates, args.victim,
                         args.basetemp_root, log_fh)
        summary = {
            'victim': args.victim,
            'candidates': args.candidates,
            'minimal': minimal,
            'found': minimal is not None,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=1))
        if log_fh:
            log_fh.write(json.dumps(summary, ensure_ascii=False) + '\n')
    finally:
        if log_fh:
            log_fh.close()


if __name__ == '__main__':
    main()
