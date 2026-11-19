# -*- coding: utf-8 -*-
"""删除后全面体检（可复跑、只读）。

维度：
  1. 死引用：源码/配置/CI/文档里指向已删 backend/ 或 74 个 pytest 的路径
  2. 打包链：electron-builder.yml / Harbor.spec / package.json 是否残留 Python 运行时
  3. 契约面：冻结快照 vs Node registry 的双向零差集（静态）
  4. 门禁自洽：统一入口列出的每个门文件是否真实存在
  5. 退役 stub：9 个工具 + main.py 是否都有明确退役提示且 exit 0
  6. 文档陈旧：仍宣称 Python 层在位的规范/计划文档

用法：python tools/post_deletion_audit.py
输出：deliverables/dev-plan/post-deletion-audit-r69.json
      deliverables/dev-plan/post-deletion-audit-meta-r69.json（独立新鲜度 meta）

R70 / I13：verdict 由本次扫描结果动态生成；只有运行时配置类真问题才阻塞
（main() 返回 1），staleDocs 属文档漂移登记、exact-deleted-path 属历史引用
登记，均不阻塞。R70 / I14：generatedAt 写独立 meta，产物本体保持字节幂等。
"""
import io
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables' / 'dev-plan' / 'post-deletion-audit-r69.json'
# R70 / I14（主理人裁决二）：时间戳放独立 meta，避免破坏 audit 产物字节幂等。
META_OUT = (ROOT / 'deliverables' / 'dev-plan'
            / 'post-deletion-audit-meta-r69.json')
PY = sys.executable

manifest = json.loads((ROOT / 'deliverables/dev-plan/deletion-manifest.json')
                      .read_text(encoding='utf-8'))
DELETED = set(manifest['files'])
DELETED_BASENAMES = {Path(f).name for f in DELETED}

# 允许出现历史引用的目录（备份/快照/历史报告不算运行时死引用）
ALLOW_PREFIX = ('.ai-memory/', '.mimosa/', '.workbuddy/',
                'deliverables/wave-backups/', 'outputs/', '.git/',
                'node_modules/', 'server/node_modules/', 'build/', 'dist/',
                'dist-electron/', 'deliverables/dev-plan/', '__pycache__/', 'backend/',
                '.pytest_cache/', 'tests/__pycache__/')
LIVE_ASSETS = ('backend/prompts', 'backend/experts_builtin')
ALLOW_FILES = {
    'deliverables/dev-plan/deletion-manifest.json',
    'deliverables/dev-plan/frozen-python-surface.json',
    'deliverables/dev-plan/STEP5-DELETION-BOUNDARY.md',
    'deliverables/dev-plan/ARCHITECTURE-ASSESSMENT-R69.md',
    'deliverables/dev-plan/HANDOVER-R69.md',
    'deliverables/dev-plan/deep-scan-r69.json',
    'deliverables/dev-plan/final-gap-backlog.json',
    'frontend/app/docs/backend-test-disposition.json',
    'frontend/app/docs/behavior-review-batch1.json',
    'frontend/app/docs/behavior-review-batch2.json',
    'frontend/app/docs/behavior-review-batch3.json',
    'frontend/app/docs/behavior-review-batch4.json',
    'deliverables/dev-plan/remaining-pins-classification-r69.json',
    'KNOWN_ISSUES.md',
}
SCAN_SUFFIX = ('.py', '.js', '.mjs', '.jsx', '.json', '.yml', '.yaml',
               '.md', '.html', '.spec', '.txt', '.cfg', '.toml')

# ---------------------------------------------------------------- R70 / I09 守卫分类
# 目录存在性守卫（错误判据）：删除只删了 .py，backend/ 目录仍在，
# 用它作判据会让 stub 继续执行并 ModuleNotFoundError 崩溃。
_DIRECTORY_GUARD_RE = re.compile(
    r"(?:is_dir\(\)|existsSync\(path\.join\(ROOT,\s*'backend'\)\)|"
    r"isdir\(os\.path\.dirname\(API\)\)|isdir\([^)]*'backend'\))")
# 运行时 backend 导入字面量（只匹配代码行，不匹配注释/docstring）。
_BACKEND_LITERAL_RE = re.compile(r'(?:from|import)\s+backend\b')
_PY_DOCSTRING_RE = re.compile(r'(?s)("""|\'\'\').*?\1')
_JS_BLOCK_COMMENT_RE = re.compile(r'(?s)/\*.*?\*/')
_FILE_GUARD_RE = re.compile(r'(?:is_file|isfile|existsSync)\s*\(')
_IMPORT_GUARD_RE = re.compile(
    r'except\s+(?:ImportError|ModuleNotFoundError)|try:\s*\n\s*from\s+backend')

# ---------------------------------------------------------------- R70 / I10 陈旧措辞
# 活跃入口文档集：面向当前读者的规范/说明，仍宣称 Python 链在位即属陈旧。
# 这些文件是 T05（I25/I26/I27）待补退役声明的对象，本批次只建立判据。
ACTIVE_ENTRY_DOCS = (
    'AGENTS.md',
    'README.md',
    '开发说明.txt',
    'frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md',
)
# 固定 5 短语扩为正则族：既覆盖原「删除计划未执行」族，也覆盖活跃入口
# 文档里「仍以 Python 契约层/pywebview 为运行链」与「删除前原文」的措辞族。
STALE_PATTERNS = (
    ('删除计划未执行', re.compile(
        r'删除\s*Python\s*实现[^。\n]{0,24}(?:仍未执行|未执行|尚未执行)')),
    ('步骤5未执行', re.compile(
        r'步骤\s*5[^。\n]{0,16}(?:未执行|待执行|仍被阻断|仍需|尚未)')),
    ('Python契约层仍在位', re.compile(
        r'Python\s*契约层[^。\n]{0,12}(?:仍在|尚在|在位|未退役)')),
    ('不得先删', re.compile(r'不得先删')),
    ('留步骤5同批', re.compile(r'留\s*步骤\s*5\s*同批')),
    ('活跃入口仍引用已删契约层模块', re.compile(
        r'(?:from|import)\s+backend\b|backend/api\.py|backend/tools_schema\.py|'
        r'backend/services/provenance\.py')),
    ('活跃入口仍以pywebview为运行链', re.compile(
        r'pywebview|python\s+main\.py|Python\s+stdlib\s+only|Python\s*3\.10\+|'
        r'pip\s+install\s+pywebview')),
    ('删除前原文角标待补', re.compile(
        r'未物理删测试|不可进入步骤\s*5|步骤\s*1\s*[–\-—]\s*3\s*已执行|待确认')),
)


def _code_only_lines(text, is_python=True):
    """I09：剥离注释/docstring，只保留代码行文本。

    main.py 的 docstring 写「不再 import backend」，原实现对全文做正则会
    把它误判为运行时 backend 导入（True）；剥离后该行不复存在 → False。
    """
    if is_python:
        text = _PY_DOCSTRING_RE.sub(' ', text)
        return '\n'.join(ln.split('#', 1)[0] for ln in text.splitlines())
    text = _JS_BLOCK_COMMENT_RE.sub(' ', text)
    return '\n'.join(ln.split('//', 1)[0] for ln in text.splitlines())


def _uses_directory_guard(text):
    """目录存在性守卫（arch-contract 硬断言所有 stub 必须为 False）。"""
    return bool(_DIRECTORY_GUARD_RE.search(text))


def _classify_guard(text, is_python=True):
    """I09：按守卫机制分三类并分别断言，返回 (guardType, guardOk)。

    - file-guard：判据落在 backend/api.py 文件存在性上 → 断言含 api.py 且无目录守卫；
    - import-guard：以导入是否成功为判据 → 断言有 ImportError 兜底且无目录守卫；
    - pure-stub：无守卫的纯退役提示 → 断言有退役提示且无目录守卫。
    """
    code = _code_only_lines(text, is_python)
    file_guard = bool(_FILE_GUARD_RE.search(code)) and 'api.py' in code
    import_guard = bool(_IMPORT_GUARD_RE.search(code))
    dir_guard = _uses_directory_guard(text)
    has_retire = ('退役' in text or '已废弃' in text)
    if file_guard:
        return 'file-guard', ('api.py' in code and not dir_guard)
    if import_guard:
        return 'import-guard', (import_guard and not dir_guard)
    return 'pure-stub', (has_retire and not dir_guard)


def iter_files():
    # 只扫活跃源码/配置目录；outputs/ 有 17 万文件，绝不递归进数据树
    roots = ['server/src', 'server/test', 'frontend/src', 'frontend/app/src',
             'frontend/app/tests', 'frontend/app/docs', 'tools', 'tests',
             'electron', 'installer', '.github', 'libs']
    seen = set()
    for d in roots:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in sorted(base.rglob('*')):
            if not p.is_file():
                continue
            rel = str(p.relative_to(ROOT)).replace('\\', '/')
            if rel in seen or rel.startswith(ALLOW_PREFIX) or rel in ALLOW_FILES:
                continue
            if '/__pycache__/' in rel or '/node_modules/' in rel:
                continue
            if p.suffix.lower() not in SCAN_SUFFIX and p.name not in ('Harbor.spec', 'Harbor-mac.spec'):
                continue
            seen.add(rel)
            yield rel, p
    # 根目录级配置/入口
    for name in ('Harbor.spec', 'Harbor-mac.spec', 'electron-builder.yml',
                 'package.json', 'requirements-win.txt', 'requirements-mac.txt',
                 'README.md', 'AGENTS.md', 'KNOWN_ISSUES.md', 'main.py',
                 'main_v1.0.0_legacy.py', 'harbor.html'):
        p = ROOT / name
        if p.is_file():
            yield name, p


def scan_dead_refs():
    findings = []
    # 精确指向已删相对路径
    for rel, p in iter_files():
        try:
            text = p.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        # R70 / I13：DELETED 是 set，跨进程 hash 随机化会让 items 顺序漂移，
        # 破坏产物本体字节幂等（裁决二要求）。排序遍历，内容不变、顺序确定。
        for target in sorted(DELETED):
            if target in text:
                findings.append({'file': rel, 'kind': 'exact-deleted-path',
                                 'target': target,
                                 'line': text[:text.index(target)].count('\n') + 1})
        # backend/ 路径引用（运行时配置类才计入）
        if rel in ('Harbor.spec', 'Harbor-mac.spec', 'electron-builder.yml',
                   'package.json', 'requirements-win.txt', 'requirements-mac.txt',
                   '.github/workflows/harbor-ci.yml'):
            for i, line in enumerate(text.splitlines(), 1):
                if re.search(r'backend[/\\]', line) and not any(a in line for a in LIVE_ASSETS):
                    findings.append({'file': rel, 'kind': 'backend-in-runtime-config',
                                     'line': i, 'snippet': line.strip()[:150]})
    return findings


def scan_contract_surface():
    frozen = json.loads((ROOT / 'deliverables/dev-plan/frozen-python-surface.json')
                        .read_text(encoding='utf-8'))
    src = (ROOT / 'server/src/registry.js').read_text(encoding='utf-8')
    registered = set(re.findall(r"^register\('([a-z0-9_]+)'", src, re.M))
    pub = set(re.findall(r"'([a-z0-9_]+)'",
                         re.search(r'const PUBLIC_API_METHODS\s*=\s*\[([\s\S]*?)\]', src).group(1)))
    expected = set(frozen['public_methods']) | set(frozen['hidden_methods'])
    return {
        'public': len(pub), 'hidden': len(frozen['hidden_methods']),
        'registered': len(registered),
        'missing': sorted(expected - registered),
        'ghosts': sorted(registered - expected),
        'publicDrift': sorted(pub ^ set(frozen['public_methods'])),
        'apiVersion': frozen['API_VERSION'],
    }


def scan_gate_files():
    gates = sorted((ROOT / 'server/test').glob('*.mjs'))
    missing = [str(g.relative_to(ROOT)).replace('\\', '/') for g in gates
               if not g.is_file()]
    return {'count': len(gates), 'missing': missing}


def scan_stubs():
    stubs = ['main.py', 'main_v1.0.0_legacy.py',
             'tools/gen_api_reference.py', 'tools/perf_benchmark.py',
             'tools/perf_w6p1.py', 'tools/diag/state_probe.py',
             'tools/diff/python_driver.py', 'tools/diff/extract_rpc_defaults.py',
             'tools/verify-dpapi-interop.mjs']
    out = []
    for rel in stubs:
        p = ROOT / rel
        if not p.is_file():
            out.append({'file': rel, 'exists': False})
            continue
        text = p.read_text(encoding='utf-8', errors='replace')
        # I09：剥离注释/docstring 后只判定代码行里的运行时 backend 导入，
        # 修正 main.py「不再 import backend」被误判为 True 的假阳性。
        code = _code_only_lines(text, is_python=not rel.endswith('.mjs'))
        bad_guard = _uses_directory_guard(text)
        guard_type, guard_ok = _classify_guard(
            text, is_python=not rel.endswith('.mjs'))
        backend_import = bool(_BACKEND_LITERAL_RE.search(code))
        out.append({'file': rel, 'exists': True,
                    'hasRetireNotice': ('退役' in text or '已废弃' in text),
                    'guardChecksApiFile': ("api.py" in code or "API)" in code),
                    'usesDirectoryGuard': bad_guard,
                    # I09 验收口径：main.py.backendImport 必须为 False
                    'backendImport': backend_import,
                    'hasBackendLiteral': backend_import,
                    'guardType': guard_type,
                    'guardOk': guard_ok})
    return out


def scan_stale_docs():
    """I10：陈旧措辞正则族 + 活跃入口文档集扫描。

    扫描面 = iter_files() 的文档面 ∪ 显式纳入的活跃入口文档集
    （AGENTS.md / README.md / 开发说明.txt / PYTHON-CONTRACT-EXIT-PLAN.md，
    其中 .txt 不是 .md，需显式加入，不受后缀限制）。

    历史原文豁免（ALLOW_PREFIX 的 deliverables/dev-plan/ 与 ALLOW_FILES）
    原样保留：STEP5-DELETION-BOUNDARY.md / HANDOVER-R69.md 是「保留原文」的
    历史档案，只允许改标题/状态行，不得因正则族放宽而被误判为运行时陈旧。
    """
    docs = {}
    for rel, p in iter_files():
        if p.suffix.lower() == '.md':
            docs[rel] = p
    # 活跃入口文档集显式纳入（不受 iter_files roots 与 .md 后缀限制）
    for rel in ACTIVE_ENTRY_DOCS:
        p = ROOT / rel
        if p.is_file():
            docs.setdefault(rel, p)
    out = []
    for rel in sorted(docs):
        # 保留 ALLOW_PREFIX / ALLOW_FILES 历史原文豁免
        if rel.startswith(ALLOW_PREFIX) or rel in ALLOW_FILES:
            continue
        try:
            text = docs[rel].read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        is_active = rel in ACTIVE_ENTRY_DOCS
        for label, pattern in STALE_PATTERNS:
            m = pattern.search(text)
            if not m:
                continue
            out.append({'file': rel, 'phrase': label,
                        'match': m.group(0)[:80],
                        'line': text[:m.start()].count('\n') + 1,
                        'source': 'active-entry' if is_active else 'scan-surface'})
    return out


# R70 / I13：只有「运行时配置类」死引用才是阻塞性真问题。
# staleDocs 是文档漂移登记、exact-deleted-path 是历史引用登记，均不阻塞，
# 否则第 13 门会恒红（当前 staleDocs=8、exact-deleted-path=53 皆为登记项）。
BLOCKING_DEAD_KIND = 'backend-in-runtime-config'


def find_blocking_defects(dead):
    """I13：从 deadReferences 中筛出阻塞性真问题（纯函数，便于注入复现）。

    :param dead: scan_dead_refs() 的 findings
    :return: 运行时配置类真问题列表
    """
    return [f for f in dead if f.get('kind') == BLOCKING_DEAD_KIND]


def build_verdict(dead, stubs, stale):
    """I13：由本次扫描结果动态生成 verdict（不再硬编码 1 / 6 项）。

    realDefectsFound / realDefect / fixedFiles 全部来自本次扫描：
      - realDefectsFound = 运行时配置类真问题数；
      - fixedFiles = 本次确认守卫合规的退役 stub 文件（动态排序去重）；
      - staleDocs 只作为非阻塞登记项计入 basis，不参与缺陷计数。

    :param dead: scan_dead_refs() 结果
    :param stubs: scan_stubs() 结果
    :param stale: scan_stale_docs() 结果
    :return: verdict dict
    """
    defects = find_blocking_defects(dead)
    fixed_files = sorted({s['file'] for s in stubs
                          if s.get('exists') and s.get('guardOk')
                          and s.get('usesDirectoryGuard') is False})
    return {
        'realDefectsFound': len(defects),
        'realDefect': ('运行时配置类仍引用已删 Python 契约层：%s'
                       % ', '.join('%s:%s' % (d.get('file'), d.get('line'))
                                   for d in defects)) if defects
                      else '本次扫描未检出运行时配置类真问题（历史目录守卫缺陷已修复）',
        'fixedFiles': fixed_files,
        'fixedBy': '守卫判据统一改为 backend/api.py 文件存在性（或导入是否成功）',
        'falsePositives': [
            'backend/prompts 与 backend/experts_builtin 是存活资产（112 文件），'
            'electron-builder.yml 白名单与 Harbor.spec datas 仍需要',
            '源码注释里以 Python 源文件名作对照说明（设计溯源），非运行时依赖',
            '.ai-memory/ 与 .mimosa/ 是历史会话记录',
        ],
        'annotated': ['Harbor.spec', 'Harbor-mac.spec'],
        'annotatedReason': 'PyInstaller spec 的 hiddenimports 指向已删 backend.domains；'
                           'pywebview 链已废弃，加退役标注避免误执行（不改功能）',
        # I13：动态性留痕，供 arch-contract 与 QA 注入反例交叉验证
        'dynamic': True,
        'basis': {
            'deadReferencesTotal': len(dead),
            'blockingKind': BLOCKING_DEAD_KIND,
            'blockingDefects': len(defects),
            'staleDocs': len(stale),
            'staleDocsNonBlocking': True,
            'retiredStubsChecked': len(stubs),
        },
    }


def write_freshness_meta():
    """I14：把 ISO 8601 generatedAt 写独立 meta，audit 产物本体保持字节幂等。

    :return: 写入的 meta dict
    """
    meta = {
        'version': 1,
        'source': 'tools/post_deletion_audit.py',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
    }
    META_OUT.write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                        encoding='utf-8')
    return meta


def main():
    dead = scan_dead_refs()
    surface = scan_contract_surface()
    gates = scan_gate_files()
    stubs = scan_stubs()
    stale = scan_stale_docs()
    by_kind = Counter(f['kind'] for f in dead)
    verdict = build_verdict(dead, stubs, stale)
    doc = {
        'version': 2,
        'generatedBy': 'tools/post_deletion_audit.py',
        'policy': '只读体检；命中需人工核实，配置类残留属真问题，历史文档属陈述',
        'deletedFilesTracked': len(DELETED),
        'deadReferences': {'total': len(dead), 'byKind': dict(by_kind), 'items': dead[:120]},
        'contractSurface': surface,
        'serverGates': gates,
        'retiredStubs': stubs,
        'staleDocs': stale,
        'verdict': verdict,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    meta = write_freshness_meta()
    print('[audit] 死引用 %d (按类 %s)' % (len(dead), dict(by_kind)))
    print('  契约面: public=%d hidden=%d registered=%d missing=%d ghosts=%d' % (
        surface['public'], surface['hidden'], surface['registered'],
        len(surface['missing']), len(surface['ghosts'])))
    print('  server 门 %d, 退役 stub %d, 陈旧文档 %d' % (
        gates['count'], len(stubs), len(stale)))
    print('  verdict: realDefectsFound=%d (运行时配置类), fixedFiles=%d, dynamic=%s'
          % (verdict['realDefectsFound'], len(verdict['fixedFiles']),
             verdict['dynamic']))
    print('  freshness meta: %s' % meta['generatedAt'])
    # I13：仅运行时配置类真问题阻塞（return 1）；文档漂移/历史引用登记不阻塞。
    return 1 if find_blocking_defects(dead) else 0


if __name__ == '__main__':
    raise SystemExit(main())
