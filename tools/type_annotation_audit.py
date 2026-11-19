# -*- coding: utf-8 -*-
"""R69 P0-③ 第一阶段：JSDoc 类型契约覆盖率审计（只增不减棘轮）。

**诚实边界**：本门度量的是「导出符号是否有 JSDoc 类型注解」，
**不是静态类型检查**。当前环境无 typescript/tsc 且无外网，无法运行
`tsc --noEmit` 或 `checkJs`；有网后本基线可直接作为启用 checkJs 的起点。

R70 / I24：用 DOC_RE 做「紧邻 JSDoc 块」精确匹配（块结束行与符号声明行之间
只隔空行），并加「标签值非空 + {type} 括号配对」最小格式校验，删死代码。
R70 / I23：试点扩到 4 个模块（paths/config/logger/runtime），基线同步抬升。

用法：python tools/type_annotation_audit.py
基线：deliverables/dev-plan/type-annotation-baseline-r69.json
输出：deliverables/dev-plan/type-annotation-r69.json
"""
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / 'deliverables' / 'dev-plan' / 'type-annotation-baseline-r69.json'
OUT = ROOT / 'deliverables' / 'dev-plan' / 'type-annotation-r69.json'

# 试点范围：逐个模块扩展，不一次铺开到全部 42 个 Node 文件
# R70 / I23：I24 修好算法并对 paths.js 验证 7/7 后，扩到 4 个模块。
SCOPE = ['server/src/paths.js', 'server/src/config.js',
         'server/src/logger.js', 'server/src/runtime.js']

FUNC_RE = re.compile(r'^export\s+(?:async\s+)?function\s+(\w+)\s*\(', re.M)
CONST_RE = re.compile(r'^export\s+const\s+(\w+)\s*=', re.M)
# R70 / I24：DOC_RE 原先定义后从未使用；现在用它精确提取 JSDoc 块。
DOC_RE = re.compile(r'/\*\*([\s\S]*?)\*/')
# 标签值非空：@tag 后必须有内容（不能只有标签名或只到行尾）
TAG_VALUE_RE = re.compile(r'@(type|param|returns|throws)\s+(\S[^\n]*)$', re.M)
# {type} 括号配对：同一标签行内花括号必须成对
BRACE_RE = re.compile(r'\{[^{}]*\}')


def _doc_is_well_formed(body):
    """I24：JSDoc 块的最小格式校验——标签值非空 + {type} 括号配对。

    :param body: DOC_RE 捕获的块正文（不含 /** 与 */）
    :return: (ok, reason)；ok=False 时 reason 说明不合格原因
    """
    tags = list(TAG_VALUE_RE.finditer(body))
    if not tags:
        return False, '无可识别且带值的标签'
    for tag in tags:
        value = tag.group(2).strip()
        if not value:
            return False, '@%s 标签值非空校验失败' % tag.group(1)
        # 只校验含花括号的 @type / @param / @returns 行：出现 { 必须配对 }
        line = tag.group(0)
        if '{' in line or '}' in line:
            opens, closes = line.count('{'), line.count('}')
            if opens != closes or not BRACE_RE.search(line):
                return False, '@%s 的 {type} 括号未配对' % tag.group(1)
    return True, ''


def _required_tags(doc, kind):
    """I24：按符号种类校验必需标签齐备且带值。

    function 需 @param 与 @returns；const 需 @type。
    :param doc: JSDoc 块正文
    :param kind: 'function' / 'const'
    :return: (ok, reason)
    """
    tags = {t.group(1): t.group(2).strip() for t in TAG_VALUE_RE.finditer(doc)}
    needed = ('@param', '@returns') if kind == 'function' else ('@type',)
    # 用标签名判定（TAG_VALUE_RE 的 group(1) 不带 @）
    present = {t.group(1) for t in TAG_VALUE_RE.finditer(doc)}
    required = {'param', 'returns'} if kind == 'function' else {'type'}
    missing = sorted(required - present)
    if missing:
        return False, '缺标签: ' + ','.join(missing)
    if not all(tags.get(t) for t in required):
        return False, '标签值为空'
    return True, ''


def _adjacent_doc(text, decl_offset):
    """I24：返回「紧邻」符号声明行的 JSDoc 块正文，不紧邻则返回 None。

    用 DOC_RE 扫描全部块，取 end 位置 <= 声明位置、且 end 与声明之间
    只隔空白（空行/空格/tab）的最后一个块；中间有任何普通注释或代码
    （interleaved）都会使紧邻性失效。
    """
    best = None
    for m in DOC_RE.finditer(text):
        if m.end() > decl_offset:
            break
        gap = text[m.end():decl_offset]
        if gap.strip() != '':
            continue          # 块与声明之间有非空内容 → 不紧邻
        if best is None or m.end() > best.end():
            best = m
    return best.group(1) if best is not None else None


def audit(rel):
    """审计单个模块的导出符号 JSDoc 注解。

    :param rel: 相对 ROOT 的模块路径
    :return: [{'name','kind','annotated','line','reason'}, ...]
    """
    text = (ROOT / rel).read_text(encoding='utf-8')
    symbols = []
    for regex, kind in ((FUNC_RE, 'function'), (CONST_RE, 'const')):
        for m in regex.finditer(text):
            line_no = text[:m.start()].count('\n')
            doc = _adjacent_doc(text, m.start())
            if doc is None:
                ok, reason = False, '无紧邻 JSDoc 块（或块与声明之间夹有其它内容）'
            else:
                well, reason = _doc_is_well_formed(doc)
                if not well:
                    ok = False
                else:
                    ok, reason = _required_tags(doc, kind)
            symbols.append({'name': m.group(1), 'kind': kind,
                            'annotated': ok, 'line': line_no + 1,
                            'reason': reason})
    symbols.sort(key=lambda s: s['line'])
    return symbols


def main():
    baseline = json.loads(BASELINE.read_text(encoding='utf-8'))['baseline']
    per_file = {}
    all_symbols = []
    for rel in SCOPE:
        symbols = audit(rel)
        per_file[rel] = {
            'symbols': len(symbols),
            'annotated': sum(1 for s in symbols if s['annotated']),
            'missing': [s['name'] for s in symbols if not s['annotated']],
            'details': symbols,
        }
        all_symbols.extend(symbols)
    total = len(all_symbols)
    annotated = sum(1 for s in all_symbols if s['annotated'])
    coverage = round(100.0 * annotated / total, 1) if total else 0.0
    regressions = []
    if coverage < baseline['coverage']:
        regressions.append('coverage')
    if total < baseline['exportedSymbols']:
        regressions.append('exportedSymbols')
    doc = {
        'version': 2,
        'metric': 'JSDoc 类型契约覆盖率（非静态类型检查）',
        'staticTypeCheck': {
            'status': 'blocked-by-environment',
            'reason': 'typescript / tsc 未安装且无外网；@types/node 已在位',
            'unblockCommand': 'npm i -D typescript  （需有外网环境）',
            'nextPhase': '安装后新增 jsconfig.json 开启 allowJs + checkJs，'
                         '以本试点为首个 noEmit 检查目标',
        },
        'algorithm': 'I24: DOC_RE 紧邻块 + 标签值非空 + {type} 括号配对',
        'scope': SCOPE,
        'baseline': baseline,
        'current': {
            'exportedSymbols': total,
            'annotatedSymbols': annotated,
            'coverage': coverage,
        },
        'perFile': per_file,
        'regressions': regressions,
        'status': 'FAIL' if regressions else 'PASS',
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[type-annotation] %s %d/%d (%.1f%%) missing=%s' % (
        doc['status'], annotated, total, coverage,
        [s for f in per_file.values() for s in f['missing']]))
    print('  静态类型检查: blocked-by-environment（如实登记，未冒充）')
    return 1 if regressions else 0


if __name__ == '__main__':
    raise SystemExit(main())
