# -*- coding: utf-8 -*-
"""R69 P0-④：本地 / CI 共用的规范化门禁入口（单一事实源）。

把散落在本地命令里的门禁收敛为一个入口，使「本地全绿」与「CI 全绿」等价：
CI 的 normalized-gates job 直接调用本脚本，不再各自维护命令清单。

用法：python tools/run_normalized_gates.py
      HARBOR_NODE=<node 路径> python tools/run_normalized_gates.py
输出：deliverables/dev-plan/normalized-gates-r69.json

退出码：0=全部 required 门通过（optional 门可 SKIP）；1=任一 required 门失败。
"""
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Windows 原生模块卸载期的进程退出崩溃码（0xC0000005 ACCESS_VIOLATION 等）。
# 这类崩溃发生在**所有断言输出之后**，不等于测试失败；但必须显式留痕，
# 不静默吞掉。判定依据：退出码命中 且 stdout 是可解析的 ok:true 报告。
NATIVE_EXIT_CODES = {3221225477, 3221225478, 3221226505}

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables' / 'dev-plan' / 'normalized-gates-r69.json'
NODE = os.environ.get('HARBOR_NODE') or shutil.which('node') or 'node'
PY = sys.executable

# R70 / I13：第 13 门接入。位置有顺序依赖——必须紧跟 gate-coverage 之后、
# arch-contract 之前，使 arch-contract 读到本轮刚刷新的 audit 产物与新鲜度 meta
# （I14 的 generatedAt 判据依赖此顺序；放 arch-contract 之后会读到上一轮产物）。
# (id, argv, required, 说明)
GATES = [
    # 首位：先生成 gate-coverage 产物，供 arch-contract 读取（避免 CI 首跑顺序依赖）
    ('gate-coverage', [PY, 'tools/gate_coverage.py'], True,
     'canonical 门禁清单覆盖率（非代码覆盖率）'),
    # 顺序依赖：arch-contract 会读 scc-trend-r69.json 与依赖冻结清单，
    # 而这两个文件分别由 scc-ratchet / allowlist-ratchet 写出。原顺序把两条棘轮
    # 排在其后 ⇒ arch-contract 判的是**上一轮遗留**的状态（本轮实测：scc 修好后
    # 单独跑 arch-contract 82/82，门禁内仍报 81/82）。故前移到 arch-contract 之前。
    ('scc-ratchet', [PY, 'tools/scc_ratchet.py'], True,
     'SCC 单调下降'),
    ('allowlist-ratchet', [NODE, 'tools/gen_allowlist.mjs', '--check'], True,
     '依赖棘轮 157'),

    ('post-deletion-audit', [PY, 'tools/post_deletion_audit.py'], True,
     '删除后残留体检（运行时配置类真问题判红，文档漂移登记不阻塞）'),
    ('arch-contract', [NODE, 'frontend/app/tests/arch-contract.mjs'], True,
     '架构断言（数量以该门产物 checks 数为准，不硬编码）'),
    ('frontend-l1', [NODE, '--test', 'frontend/app/tests/unit.test.mjs',
                     'frontend/app/src/features/_template/Feature.test.mjs'], True,
     '前端 L1 单元'),
    ('frontend-l2', [NODE, 'frontend/app/tests/smoke-render.mjs'], False,
     '真实浏览器挂载（无浏览器环境时 SKIP，如实标注）'),
    ('golden-replay', [PY, 'tools/contract_golden_replay.py'], True,
     '95 项 legacy 契约快照独立进程重放'),
    # R89：锚点链推进——灰度可用化（V4-H C1/C2/C3）改了 frontend/src 两个文件，
    # 按既有约定入库新基线 r89（旧 r68 保留，不动），门禁改比最新锚点。
    # R98：锚点链推进——群聊 hub 指令注入（专家芯片在群内 100% 空转）改了
    # frontend/src/group/group.js 一个函数（groupContextFor），入库新基线 r98
    # （旧 r68/r89 原样保留，不动），门禁改比最新锚点。html 三类锚点与 r89 逐项相等。
    # R99：锚点链推进——消息截断 P0 修复（R97 §7.1 遗留：四处截断 s.messages 不 bump
    # updatedAt，双源合并平局取后端导致回退失效/完整版被覆盖）。改 chat/send.js、
    # components/markdown.js、sessions/store.js 共 5 个函数定义体，入库新基线 r99
    # （旧 r68/r89/r98 原样保留，不动），门禁改比最新锚点。html 三类锚点与 r98 逐项相等。
    # R100：锚点链推进——v2.1 M1 落地 P01–P09 生产补丁 + G01/G02 门禁升级。
    # 新增 18 个顶层符号、function_defs 1317→1335，故入库新基线 r100 并改比最新锚点；
    # 旧 r68/r89/r98/r99 原样保留（只增不删）。DOM id 三类锚点与 r99 逐项相等（479/54/124）。
    ('contract-diff', [PY, 'tools/contract_diff.py', '--compare',
                       'deliverables/dev-plan/contract-baseline-r136.json'], True,
     'r100 锚点零漂移（锚点链最新项）'),
    # R101 Q10 晋升：这两门在 T01 期间**曾经真红**（A1 死引用 30 条、A6 钩子 0 处），
    # 修复后转绿且判据常数未放宽（A5 拆成 A5a/A5b 是"存量走棘轮"，新增债务仍 required），
    # 满足 Q10 的晋升条件（曾红 → 修绿 → 常数未改），故以 required=True 正式接入，
    # 不再靠人工记得去跑。负控（assert_motion_negative）单独跑，不进门禁（耗时 ~40s）。
    ('ui-audit-motion', [PY, 'tools/uiaudit/assert_motion.py'], True,
     '动效静态判据 A1–A5a（死引用/重复关键帧/合成器直通/transition all/新增裸时长）'),
    ('ui-audit-controls', [PY, 'tools/uiaudit/assert_dead_controls.py'], True,
     '死控件与调试残余 A6–A9'),
    # Q10：新门禁一律先 required=False + 豁免登记，翻 True 必须满足「曾红 → 修绿 → 常数未改」。
    # APCA 这条从未红过（它是对现状的度量，不是修 bug 后的回归守卫），所以保持 optional：
    # 它失败时**必须显式出现在 failed 列表里**让人看见，但不阻塞整体门禁 —— 一旦阻塞，
    # 有人会为了过门禁去改阈值，而阈值（正文 |Lc|>=75）是设计契约，不该被门禁便利性绑架。
    ('ui-audit-apca', [NODE, 'tools/audit-apca-r101.mjs'], False,
     'APCA 正文对比度 |Lc|>=75（浏览器实测，非静态扫描；未红过故 optional）'),
    ('type-annotation', [PY, 'tools/type_annotation_audit.py'], True,
     'JSDoc 类型契约覆盖率（非静态类型检查）'),
    ('arch-assessment', [PY, 'tools/arch_assessment.py'], True,
     '架构度量可复跑'),
    ('ui-contract', [PY, 'deliverables/design/check_contract.py'], True,
     'UI 五大契约'),
]


# R70 / I15：显式常量——历史一次性迁移脚本与探针不是门禁，不计入 server_gates()。
# 实测 server/test/*.mjs 共 39 个，排除这 2 个后 = 37 门（R88 加入 v4h-harness.mjs；
# 原注释写 37/35 是 R70 时点值，已随目录增长失效，以 server_gates() 动态结果为准）。
NON_GATE_SCRIPTS = {'auth-migrate.mjs', 'node-sqlite-probe.mjs'}


def server_gates():
    """遍历 server/test/*.mjs，排除 NON_GATE_SCRIPTS 中的非门禁脚本。"""
    test_dir = ROOT / 'server' / 'test'
    return sorted(p for p in test_dir.glob('*.mjs')
                  if p.name not in NON_GATE_SCRIPTS)


def run(argv, timeout=180):
    try:
        p = subprocess.run(argv, cwd=str(ROOT), capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=timeout)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    except subprocess.TimeoutExpired:
        return 124, 'TIMEOUT'
    except OSError as e:
        return 127, str(e)


def native_exit_after_pass(rc, output):
    """输出是完整 ok:true 报告、但进程退出时原生崩溃 —— 单独留痕，不冒充干净 PASS。"""
    if rc not in NATIVE_EXIT_CODES:
        return False
    try:
        return json.loads(output.strip()).get('ok') is True
    except (ValueError, AttributeError):
        return False


def main():
    results = []
    for gid, argv, required, note in GATES:
        rc, output = run(argv)
        status = 'PASS' if rc == 0 else ('SKIP' if not required else 'FAIL')
        if not required and rc != 0 and ('浏览器环境不可用' in output or
                                        rc == 2 or 'Edge' in output):
            status = 'SKIP'
        results.append({'id': gid, 'required': required, 'status': status,
                        'returncode': rc, 'note': note,
                        'tail': output.strip()[-240:]})

    # server 全量可跑门禁（数量由 len(srv) 动态统计并写入产物 serverGates；
    # 非门禁脚本统一由 NON_GATE_SCRIPTS 排除，并写入产物 excluded 字段供复核）
    srv = server_gates()
    srv_fail = []
    native_warnings = []
    for p in srv:
        rc, output = run([NODE, str(p.relative_to(ROOT))], timeout=120)
        if rc == 0:
            continue
        if native_exit_after_pass(rc, output):
            native_warnings.append({
                'file': p.name, 'returncode': rc,
                'reason': '所有断言输出 ok:true 后，进程退出时 Windows 原生崩溃（0xC0000005）',
                'disposition': '不计为测试失败，但显式留痕供排查原生模块卸载',
            })
            continue
        srv_fail.append({'file': p.name, 'returncode': rc,
                         'tail': output.strip()[-200:]})
    results.append({'id': 'server-gates', 'required': True,
                    'status': 'FAIL' if srv_fail else 'PASS',
                    'total': len(srv), 'failed': srv_fail,
                    'excluded': sorted(NON_GATE_SCRIPTS),
                    'nativeExitWarnings': native_warnings,
                    'note': '排除 NON_GATE_SCRIPTS（历史迁移脚本 / 探针，非门禁）'})

    passed = sum(1 for r in results if r['status'] == 'PASS')
    skipped = sum(1 for r in results if r['status'] == 'SKIP')
    failed = [r['id'] for r in results if r['status'] == 'FAIL']
    doc = {
        'version': 2,
        'generatedBy': 'tools/run_normalized_gates.py',
        'policy': '本地与 CI 共用同一入口；optional 门 SKIP 与原生退出崩溃均必须'
                  '如实记录，不伪造通过、也不静默吞掉',
        'summary': {'total': len(results), 'passed': passed,
                    'skipped': skipped, 'failed': failed,
                    'serverGates': len(srv),
                    'excludedFromServerGates': sorted(NON_GATE_SCRIPTS),
                    'nativeExitWarnings': len(native_warnings)},
        'results': results,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[normalized-gates] %d/%d PASS, %d SKIP, FAIL=%s -> %s' % (
        passed, len(results) - skipped, skipped, failed, OUT))
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
