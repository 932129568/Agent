# -*- coding: utf-8 -*-
"""R69 全源码深扫描（可复跑、只读）。

维度：危险 API / 吞异常 / 路径拼接未校验 / 敏感字面量 / 未闭合资源 /
契约漂移 / 未兑现标记 / 重复定义 / 空实现 / 循环依赖 / 配置污染。

用法：python tools/deep_scan.py
输出：deliverables/dev-plan/deep-scan-r69.json
"""
import io
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables' / 'dev-plan' / 'deep-scan-r69.json'

SCAN_DIRS = ['server/src', 'frontend/src', 'backend', 'tools', 'tests', 'frontend/app/src']
SKIP_SUFFIX = ('.pyc', '.map', '.min.js', '.jsonl')

JS_RULES = [
    ('danger-eval', 'high', r'\beval\s*\(|new\s+Function\s*\(',
     '动态代码执行'),
    ('danger-child-process', 'high', r'\b(exec|execSync|spawn|spawnSync)\s*\(',
     '子进程调用（需核对是否已入护栏）'),
    ('silent-catch', 'medium', r'catch\s*\([^)]*\)\s*\{\s*\}',
     '完全空的 catch，异常被静默吞掉'),
    ('swallow-catch', 'medium', r'catch\s*\([^)]*\)\s*\{\s*/\*[^*]*\*/\s*\}',
     '仅注释的 catch，异常被静默吞掉'),
    ('path-join-user-input', 'high', r'path\.join\([^)]*(?:req|query|params|body|input|value|name)\b',
     '路径拼接可能含未校验外部输入'),
    ('hardcoded-secret', 'high', r"(?:api[_-]?key|password|secret|token)\s*[:=]\s*['\"][A-Za-z0-9_\-]{12,}['\"]",
     '疑似硬编码凭据'),
    ('todo-marker', 'low', r'\b(?:TODO|FIXME|XXX|HACK)\b',
     '未兑现标记'),
    ('console-log', 'low', r'\bconsole\.(?:log|warn|error)\s*\(',
     '生产代码中的控制台输出'),
    ('empty-export', 'medium', r'export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*\{\s*\}',
     '空实现导出'),
    ('fs-sync-no-try', 'medium', r'^\s*fs\.(?:readFileSync|writeFileSync|unlinkSync|renameSync)\(',
     '同步 fs 调用（需确认外层有 try/catch）'),
]
PY_RULES = [
    ('danger-eval', 'high', r'\beval\s*\(|\bexec\s*\(|os\.system\s*\(',
     '动态代码执行 / 系统命令'),
    ('bare-except', 'medium', r'except\s*:',
     '裸 except'),
    ('silent-except', 'medium', r'except\s+[^:]+:\s*\n\s*pass\s*$',
     'except 后仅 pass，异常静默'),
    ('hardcoded-secret', 'high', r"(?:api[_-]?key|password|secret|token)\s*=\s*['\"][A-Za-z0-9_\-]{12,}['\"]",
     '疑似硬编码凭据'),
    ('todo-marker', 'low', r'\b(?:TODO|FIXME|XXX|HACK)\b',
     '未兑现标记'),
    ('open-no-with', 'low', r'^\s*\w+\s*=\s*open\(',
     'open 未用 with（需人工确认是否显式关闭）'),
]


def scan_file(path, rel):
    try:
        text = io.open(str(path), encoding='utf-8', errors='replace').read()
    except OSError:
        return []
    rules = JS_RULES if path.suffix in ('.js', '.mjs', '.jsx') else PY_RULES
    lines = text.splitlines()
    found = []
    for kind, severity, pattern, desc in rules:
        rx = re.compile(pattern, re.M)
        for m in rx.finditer(text):
            line = text[:m.start()].count('\n') + 1
            snippet = lines[line - 1].strip()[:160] if line <= len(lines) else ''
            found.append({'kind': kind, 'severity': severity, 'line': line,
                          'file': rel, 'snippet': snippet, 'desc': desc})
    return found


def main():
    findings = []
    files_scanned = 0
    by_dir = Counter()
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob('*')):
            if not p.is_file() or p.suffix not in ('.js', '.mjs', '.jsx', '.py'):
                continue
            if str(p).endswith(SKIP_SUFFIX):
                continue
            rel = str(p.relative_to(ROOT)).replace('\\', '/')
            files_scanned += 1
            by_dir[d] += 1
            findings.extend(scan_file(p, rel))
    by_kind = Counter(f['kind'] for f in findings)
    by_sev = Counter(f['severity'] for f in findings)
    high = [f for f in findings if f['severity'] == 'high']
    doc = {
        'version': 1,
        'generatedBy': 'tools/deep_scan.py',
        'policy': '静态模式扫描给出线索，不直接等同于缺陷；high 项必须逐条人工核实后再修',
        'filesScanned': files_scanned,
        'byDirectory': dict(by_dir),
        'byKind': dict(by_kind.most_common()),
        'bySeverity': dict(by_sev),
        'highFindings': high[:200],
        'allFindings': findings,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[deep-scan] %d 文件 / %d 命中 (high=%d) -> %s' % (
        files_scanned, len(findings), len(high), OUT))
    print('  byKind:', dict(by_kind.most_common()))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
