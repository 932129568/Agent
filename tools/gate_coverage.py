# -*- coding: utf-8 -*-
"""R69 P0-④/⑤：门禁覆盖率基线（**不是代码覆盖率**）。

度量「canonical 门禁清单」是否被 CI 真实调用。检查面分两层：

  1. 文本层（辅助统计）：CI YAML 的**非注释 run: 命令块** + 统一入口脚本文本；
  2. 结构层（硬判据，I03）：从统一入口的 GATES 字面量解析 argv，逐项校验
     门文件 is_file() 与 required 显式布尔，消除「读自身文本即恒真」的自指涉假绿。

R70 / I02：CI_ONLY 检查面由「CI YAML 全文包含」收紧为「非注释 run: 命令
块」——正则抽取单行 `run:` 与 `run: |` 多行块，剥离 `#` 注释行；注释里出现
门禁 token 不再造成假覆盖。CANONICAL 16 项 token 一字未改。
R70 / I03：新增 GATES 解析式校验；文本包含降为辅助统计，status 由两层共同
决定。把 YAML 全部 run: 行替换成占位符 → covered < 16；把 GATES 某门路径
改成不存在文件 → 结构层 FAIL（两者均可用 evaluate() 注入复现，见台账）。

代码覆盖率（pytest-cov / c8）在本环境**不可用且无外网**，按 QA 口径
如实登记为 blocked，绝不以本指标冒充代码覆盖率。

用法：python tools/gate_coverage.py
输出：deliverables/dev-plan/gate-coverage-r69.json
"""
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables' / 'dev-plan' / 'gate-coverage-r69.json'
CI_YAML = ROOT / '.github' / 'workflows' / 'harbor-ci.yml'
ENTRY_PY = ROOT / 'tools' / 'run_normalized_gates.py'

# id -> 在 CI YAML 的 run: 命令块或统一入口脚本中必须出现的标识
# R70 / I13：第 13 门接入后 CANONICAL 16→17（新增 post-deletion-audit）。
CANONICAL = {
    'ui-contract': 'deliverables/design/check_contract.py',
    'pytest-full': 'round_runner.py',
    'release-discipline': 'check_release.py',
    'entry-sweep-selfcheck': 'entry_sweep.py',
    'normalized-gate-entry': 'run_normalized_gates.py',
    'post-deletion-audit': 'post_deletion_audit.py',
    'arch-contract': 'arch-contract.mjs',
    'frontend-l1': 'unit.test.mjs',
    'frontend-l2': 'smoke-render.mjs',
    'golden-replay': 'contract_golden_replay.py',
    'contract-diff': 'contract_diff.py',
    'allowlist-ratchet': 'gen_allowlist.mjs',
    'scc-ratchet': 'scc_ratchet.py',
    'type-annotation': 'type_annotation_audit.py',
    'arch-assessment': 'arch_assessment.py',
    'server-gates': 'server/test',
    'gate-coverage': 'gate_coverage.py',
}

# 必须直接出现在 CI YAML 的非注释 run: 命令块中的门禁（不能只靠统一入口脚本文本）
CI_ONLY = {
    'ui-contract', 'pytest-full', 'release-discipline',
    'entry-sweep-selfcheck', 'normalized-gate-entry',
}

# I02：run: 行匹配（兼容 `- run:` 与缩进块）；块标记表示该行后是多行命令体
_RUN_LINE = re.compile(r'^(\s*)(?:-\s+)?run:\s*(.*)$')
_BLOCK_MARKERS = frozenset(('|', '|-', '|+', '>', '>-', '>+'))
# I03：argv 中可校验的门文件/基线文件字面量（PY / NODE 变量被占位化后不匹配）
_PATH_LIKE = re.compile(r'^[A-Za-z0-9_./-]+\.(?:py|mjs|js|json)$')


def extract_ci_run_blocks(ci_text):
    """I02：抽取 CI YAML 中真正会执行的 `run:` 命令文本。

    支持单行 `run: <cmd>` 与 `run: |` / `run: >` 多行块；多行块按缩进收集
    命令体，缩进回退即结束。整行 `#` 注释一律剥离（含块内注释行），因此
    YAML 注释里出现 canonical token 不再造成假覆盖。单行命令保留原文，
    不粗暴切 `#`（避免误伤 `${VAR#x}` 一类 shell 展开）。

    :param ci_text: harbor-ci.yml 全文
    :return: 所有非注释 run: 命令拼接后的文本
    """
    lines = ci_text.splitlines()
    blocks = []
    n = len(lines)
    i = 0
    while i < n:
        m = _RUN_LINE.match(lines[i])
        if not m:
            i += 1
            continue
        indent = len(m.group(1))
        rest = m.group(2).strip()
        if not rest or rest.startswith('#'):
            # 整行注释或空命令：无可执行内容
            i += 1
            continue
        if rest in _BLOCK_MARKERS:
            i += 1
            body = []
            while i < n:
                nxt = lines[i]
                if not nxt.strip():
                    i += 1
                    continue
                cur_indent = len(nxt) - len(nxt.lstrip(' \t'))
                if cur_indent <= indent:
                    break
                stripped = nxt.strip()
                if not stripped.startswith('#'):
                    body.append(stripped)
                i += 1
            if body:
                blocks.append('\n'.join(body))
        else:
            blocks.append(rest)
            i += 1
    return '\n'.join(blocks)


def parse_gates(entry_text):
    """I03：从 run_normalized_gates.py 语法树解析 GATES 的 (id, argv, required)。

    只取模块级 `GATES = [...]` 的字面量；argv 里的 PY / NODE 变量以 '<NAME>'
    占位（不是文件路径），字符串常量保留原值。required 必须是显式布尔常量。

    :param entry_text: 统一入口脚本全文
    :return: [{'id', 'argv', 'required', 'lineno'}, ...]
    """
    tree = ast.parse(entry_text)
    gates = []
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(isinstance(t, ast.Name) and t.id == 'GATES' for t in targets):
            continue
        value = node.value
        if not isinstance(value, (ast.List, ast.Tuple)):
            continue
        for elt in value.elts:
            if not isinstance(elt, (ast.Tuple, ast.List)) or len(elt.elts) < 3:
                continue
            gid_node, argv_node, required_node = elt.elts[0], elt.elts[1], elt.elts[2]
            gid = gid_node.value if isinstance(gid_node, ast.Constant) else None
            argv = []
            if isinstance(argv_node, (ast.List, ast.Tuple)):
                for arg in argv_node.elts:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        argv.append(arg.value)
                    elif isinstance(arg, ast.Name):
                        argv.append('<%s>' % arg.id)
            required = (required_node.value
                        if isinstance(required_node, ast.Constant) else None)
            gates.append({'id': gid, 'argv': argv, 'required': required,
                          'lineno': getattr(elt, 'lineno', 0)})
    return gates


def validate_gate_structure(gates):
    """I03：解析式校验——逐项检查门文件 is_file() 且 required 为显式布尔。

    文本包含只能证明「字符串出现过」，不能证明门真能跑；本层直接对解析出的
    argv 路径做 (ROOT / path).is_file()，并校验 required 是布尔常量，杜绝
    「gate_coverage.py 读自身脚本文本里的 gate_coverage.py 即恒真」的自指涉。

    :param gates: parse_gates() 的结果
    :return: (errors, checked_paths)
    """
    errors = []
    checked_paths = []
    for gate in gates:
        gid = gate['id'] or '(匿名门)'
        if not isinstance(gate['required'], bool):
            errors.append({'gate': gid, 'line': gate['lineno'],
                           'kind': 'required-not-bool',
                           'detail': 'required 未解析为显式布尔常量'})
        for arg in gate['argv']:
            if not _PATH_LIKE.match(arg):
                continue
            checked_paths.append(arg)
            if not (ROOT / arg).is_file():
                errors.append({'gate': gid, 'line': gate['lineno'],
                               'kind': 'gate-file-missing',
                               'detail': '门文件不存在: %s' % arg})
    return errors, checked_paths


def evaluate(ci_text, entry_text):
    """纯函数：给定两份脚本文本，产出覆盖率报告 dict（便于反例注入复现）。

    :param ci_text: harbor-ci.yml 全文
    :param entry_text: run_normalized_gates.py 全文
    :return: 与落盘产物同结构的 dict
    """
    ci_runs = extract_ci_run_blocks(ci_text)
    surface = ci_runs + '\n' + entry_text
    covered = sorted(k for k, token in CANONICAL.items()
                     if token in (ci_runs if k in CI_ONLY else surface))
    missing = sorted(set(CANONICAL) - set(covered))
    pct = round(100.0 * len(covered) / len(CANONICAL), 1)

    try:
        gates = parse_gates(entry_text)
        structural_errors, checked_paths = validate_gate_structure(gates)
    except SyntaxError as exc:
        gates = []
        checked_paths = []
        structural_errors = [{'kind': 'gates-parse-error',
                              'detail': 'GATES 语法解析失败: %s' % exc}]

    ok = not missing and not structural_errors
    return {
        'version': 1,
        'metric': 'gate-coverage (门禁覆盖率) —— 非代码覆盖率',
        'policy': 'canonical 清单须在 CI YAML 非注释 run: 命令块或统一入口中出现；'
                  '并由 GATES 解析式文件存在性校验兜底，缺一/失一即失败',
        'checkedSurface': ['.github/workflows/harbor-ci.yml',
                           'tools/run_normalized_gates.py'],
        'total': len(CANONICAL),
        'covered': len(covered),
        'percentage': pct,
        'coveredGates': covered,
        'missingGates': missing,
        'ciRunCommands': len(ci_runs.splitlines()),
        'structuralCheck': {
            'parsedGates': len(gates),
            'requiredTrue': sum(1 for g in gates if g['required'] is True),
            'checkedPaths': checked_paths,
            'errors': structural_errors,
            'status': 'FAIL' if structural_errors else 'PASS',
        },
        'codeCoverage': {
            'status': 'blocked-by-environment',
            'reason': 'pytest-cov / coverage / c8 / nyc 均未安装，环境无外网不可安装',
            'detectedTools': [],
            'note': '按 QA 口径如实登记，不以 gate-coverage 冒充代码覆盖率',
            'unblockCommand': 'pip install pytest-cov coverage  （需有外网环境）',
        },
        'status': 'PASS' if ok else 'FAIL',
    }


def main():
    ci_text = CI_YAML.read_text(encoding='utf-8', errors='replace')
    entry_text = ENTRY_PY.read_text(encoding='utf-8', errors='replace')
    doc = evaluate(ci_text, entry_text)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[gate-coverage] %s %d/%d (%.1f%%) missing=%s structuralErrors=%d' % (
        doc['status'], doc['covered'], doc['total'], doc['percentage'],
        doc['missingGates'], len(doc['structuralCheck']['errors'])))
    print('  代码覆盖率: blocked-by-environment（如实登记，未伪造）')
    return 1 if doc['status'] == 'FAIL' else 0


if __name__ == '__main__':
    raise SystemExit(main())
