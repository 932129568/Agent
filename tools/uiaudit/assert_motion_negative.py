# -*- coding: utf-8 -*-
"""T01 判据的注入式负控（M1–M9）—— 证明 5 条动效断言 + 2 条假按钮断言真能咬。

## 为什么必须有这个脚本

一条判据在**当前代码上红**，不代表它**在守**。三种常见假绿/假红：
  · 判据崩了（异常被吞、扫到 0 个文件）→ rc=0，看起来「没问题」；
  · 判据正则漏改（产品改个写法就匹配不到）→ rc=0，看起来「没问题」；
  · 判据红在别处（语法错、路径错）→ rc=1，看起来「在守」，其实没验到主逻辑。

所以本脚本的验收标准不是「红了」，而是**「红得对」**：每条的**实际输出行**必须与
**期望子串逐字相等**。只判 rc 的负控自己就会变成新的假通过源。

## 九条变异（M1–M9，全部单点、机械可复现）

| ID | 目标判据 | 变异 | 期望输出子串 |
|---|---|---|---|
| M1 | A1 死引用 | 追加 `.zz-probe{animation:v4NoSuchKey 1s}` | `[A1] 死引用: v4NoSuchKey` |
| M2 | A2 重复定义 | 再追加一份 `@keyframes v4MaskIn` | `[A2] 重复定义: v4MaskIn x3` |
| M3 | A3 布局属性 | 追加 `@keyframes zzBad{from{left:0}to{left:10px}}` | `[A3] 违例: zzBad 含 left` |
| M4 | A4 transition all | 追加 `.zz-probe{transition:all .2s}` | `[A4] 违例: transition all` |
| M5 | A5 裸时长 | 追加 `.zz-probe{animation:v4MaskIn 137ms}` | `[A5] 违例: 裸时长 137ms` |
| M6 | A6 静置暂停钩子 | 从副本删掉 motion.js 的暂停登记行 | `[A6] 缺失: 静置暂停钩子` |
| M7 | A7 模板假按钮 | 模板追加 `<button disabled>假按钮</button>` | `[A7] 假按钮: 1` |
| M8 | A8 JS 动态假按钮 | card.js 追加无 title 的 disabled 按钮 | `[A8] 假按钮(JS 生成): 无 title 说明` |
| M9 | A9 调试残余 | 模板追加 `<div id="dbgPanel">DEV</div>` | `[A9] 调试残余: dbgPanel` |

## 隔离纪律（这条是硬约束，不为省事让步）

**绝不在真实工作树上做变异。** 每次都：
  1. 把 `frontend/manifest.json` + `frontend/styles/**` + `frontend/react/src/island.css`
     + `frontend/index.template.html` + `frontend/src/**` 复制到临时目录；
  2. 在副本上注入变异；
  3. 用 `--root <副本>` / `path` 参数指向副本跑判据；
  4. `finally` 里删掉副本（异常路径也删）。

为什么这么严：本仓 `core.autocrlf=true` 且无 `.gitattributes`，一次 rebuild 就会让
`harbor.html` 从 LF 态变 CRLF 态（+30,061 B）。在真实树上做变异 + 忘记还原 =
直接污染共享工作树，其他成员的 `contract_diff` 会莫名其妙红。

## 反向负控（不是九条之一，但同样必须存在）

最后一段「干净样本必须 PASS」：构造一份**引用与定义都存在且唯一、只用合成器属性、
时长全走令牌**的最小 CSS，跑 `assert_motion.py` 必须 **rc=0 / PASS**。
没有这一条，前面九条「都能红」可能只是「脚本对任何输入都红」——那同样没有分辨力。

用法：
    python tools/uiaudit/assert_motion_negative.py
    python tools/uiaudit/assert_motion_negative.py --keep   # 保留临时目录供排查

退出码：0 全部 as-expected；1 有任一条不符合预期；2 环境缺失。
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PY = sys.executable

# 副本必须带齐的东西：少了任何一个，判据会以 environment 失败退出，
# 那时「RED」是环境红、不是判据红 —— 负控就成了测环境。
COPY_DIRS = [
    'frontend/styles',
    'frontend/react/src',
    'frontend/src',
]
COPY_FILES = [
    'frontend/manifest.json',
    'frontend/index.template.html',
]


# ── 副本管理 ───────────────────────────────────────────────────────────────────
def make_copy(dst):
    """把判据需要的最小文件集复制到 dst（保持相对路径）。"""
    for rel in COPY_DIRS:
        src = ROOT / rel
        if not src.is_dir():
            raise RuntimeError('副本源目录不存在: %s' % src)
        shutil.copytree(src, dst / rel)
    for rel in COPY_FILES:
        src = ROOT / rel
        if not src.is_file():
            raise RuntimeError('副本源文件不存在: %s' % src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    # island.css 在 frontend/react/src 下，已被 COPY_DIRS 覆盖；这里做存在性断言，
    # 因为它一旦不在，A1–A5 的扫描面就少一块，负控就测不到那一块。
    if not (dst / 'frontend/react/src/island.css').is_file():
        raise RuntimeError('副本缺少 frontend/react/src/island.css（扫描面不完整）')


def append_text(path, text):
    """以 LF 追加文本（不受 autocrlf 影响，副本内部一致即可）。"""
    with open(path, 'a', encoding='utf-8', newline='\n') as fh:
        fh.write(text)


def run_script(script, root_arg, extra=()):
    """跑一个判据脚本，返回 (rc, stdout+stderr)。"""
    cmd = [PY, str(HERE / script)] + list(root_arg) + list(extra)
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8',
                          errors='replace', cwd=str(ROOT))
    return proc.returncode, (proc.stdout or '') + (proc.stderr or '')


# ── 九条变异 ───────────────────────────────────────────────────────────────────
def probe_css_path(copy_root):
    """变异一律追加到 legacy.css 末尾。

    为什么选它：它是 manifest 里体量最大的一份（2993 行）、且历史上就是
    v4LineIn / v4MaskIn 两个真实缺陷的所在地，语义上最贴近「动效集中区」。
    追加到末尾而不是插进中间，是为了让 `@keyframes` 与引用之间不产生
    交叉作用（M2 除外，它就是要制造重复）。
    """
    return copy_root / 'frontend/styles/legacy.css'


def m1_dead_reference(ctx):
    append_text(probe_css_path(ctx['root']),
                '\n/* M1: 引用一个不存在的关键帧 */\n'
                '.zz-probe-m1{animation:v4NoSuchKey 1s}\n')


def m2_duplicate_keyframes(ctx):
    """再追加**一份** v4MaskIn 定义，制造重复。

    注意：这里只追加一份，不关心基线原本有几份 —— 期望值由
    expect_m2_duplicate() 按「基线份数 + 1」动态算出。
    历史教训：本负控最初把期望写死成 `x3`（当时基线恰好 2 份）。批 1 删掉
    legacy.css:987 那份副本后基线变成 1 份，变异后实际报 `x2`，
    负控自己 FAIL —— 但**变异逻辑完全正确，错的是期望被写死在会变的事实上**。
    写死绝对份数的负控，每次基线份数变化都会假红，最终会被当成噪音关掉。
    """
    append_text(probe_css_path(ctx['root']),
                '\n/* M2: 再定义一次已有的 v4MaskIn（份数由基线决定，期望动态计算） */\n'
                '@keyframes v4MaskIn{from{opacity:0}to{opacity:1}}\n')


def expect_m2_duplicate(pristine_out):
    """从**未变异基线**输出里读出 v4MaskIn 现有份数，期望变异后为 N+1。

    基线上若无 `[A2] 重复定义: v4MaskIn xN` 行（即原本无重复），
    则变异注入一份后应报 `x2`（两份相同定义）。
    """
    base = 1
    for line in pristine_out.splitlines():
        if line.startswith('[A2]') and 'v4MaskIn' in line:
            m = re.search(r'x(\d+)', line)
            if m:
                base = int(m.group(1))
            break
    return '[A2] 重复定义: v4MaskIn x%d' % (base + 1)


def m3_layout_prop(ctx):
    append_text(probe_css_path(ctx['root']),
                '\n/* M3: keyframes 内动 left（触发布局） */\n'
                '@keyframes zzBad{from{left:0}to{left:10px}}\n'
                '.zz-probe-m3{animation:zzBad 1s}\n')


def m4_transition_all(ctx):
    append_text(probe_css_path(ctx['root']),
                '\n/* M4: transition all（会过渡未预期属性） */\n'
                '.zz-probe-m4{transition:all .2s}\n')


def m5_bare_duration(ctx):
    append_text(probe_css_path(ctx['root']),
                '\n/* M5: 裸写 137ms（应走 var(--dur-*)） */\n'
                '.zz-probe-m5{animation:v4MaskIn 137ms}\n')


def m6_pause_hook(ctx):
    """A6 的**有效**变异：往副本里注入两条 infinite 循环动画。

    ⚠ 这条负控的第一版设计是错的，必须记下来（负控自己也会假绿）：
    第一版把 motion.js 的 `prefersReduced:` 那行删掉，期望输出 `[A6] 缺失: 静置暂停钩子`。
    实测：**未变异的基线仓库上，该子串就已经存在**（A6 基线本来就红，0 钩子）。
    ⇒ 这条负控「HIT」不代表任何东西 —— 它在零变异时也会 HIT，是**恒真式**。
    （等价于「把 out 里必然存在的一行当证据」。）

    A6 是「存在性断言」（要求有钩子），基线无钩子 ⇒ 基线红。
    对存在性断言，有区分力的负控只能落在**计数维度**上。A6 输出里的计数是
    `infinite 循环动画有 N 条`，而注入新循环会把 N 推高 ⇒ 用它做期望子串。

    基线实测 N=26（注入 2 条后应为 28）。期望子串带 `26 条`，故：
      · 在未变异的仓库上跑 → 输出是「26 条」→ MISS（正确，不恒真）
      · 注入 2 条后跑     → 输出是「28 条」→ HIT
    """
    path = ctx['root'] / 'frontend/styles/legacy.css'
    append_text(path,
                '\n/* M6: 再挂 2 条 infinite 循环动画（A6 的必要性计数必须从 26 涨到 28） */\n'
                '.zz-probe-m6a{animation:v4MaskIn 2s linear infinite}\n'
                '.zz-probe-m6b{animation:v4SetWinIn 2s linear infinite}\n')


def m7_template_dead_button(ctx):
    """A7 的变异：模板追加一颗无 id / 无 title 的永久 disabled 按钮。

    按钮文本用 `zzM7Probe` 而非「假按钮」，理由：A7 的输出格式是
    `[A7] 假按钮: <控件文本> @ <file>:<line>`。若注入文本就叫「假按钮」，实际行会是
    `[A7] 假按钮: 假按钮 @ ...` —— 期望子串里「假按钮」出现两次，读日志的人极易
    误以为第一个是计数。改用 ASCII 探针名后，期望子串 `[A7] 假按钮: zzM7Probe @`
    只能被这一颗注入的按钮满足，且与基线里 `:617` 那颗（文本「在下方输入框」）互不混淆。
    """
    tpl = ctx['root'] / 'frontend/index.template.html'
    text = tpl.read_text(encoding='utf-8')
    marker = '</body>'
    if marker not in text:
        raise RuntimeError('M7 锚点失配：模板里找不到 </body>')
    text = text.replace(marker, '<button disabled>zzM7Probe</button>\n' + marker, 1)
    tpl.write_text(text, encoding='utf-8', newline='\n')


def m8_js_dead_button(ctx):
    """A8 的变异：往 card.js 追加一颗**无 title** 的 JS 动态 disabled 按钮。

    必须用「JS 字符串拼接」的形态，否则测不到「模板扫不到、JS 扫得到」这条路径。
    """
    path = ctx['root'] / 'frontend/src/planning/card.js'
    append_text(path,
                "\n/* M8: JS 动态生成一颗无 title 说明的 disabled 按钮 */\n"
                "const __m8Probe = '<button class=\"pill-btn\" disabled>无说明</button>';\n")


def m9_debug_residue(ctx):
    tpl = ctx['root'] / 'frontend/index.template.html'
    text = tpl.read_text(encoding='utf-8')
    marker = '</body>'
    if marker not in text:
        raise RuntimeError('M9 锚点失配：模板里找不到 </body>')
    text = text.replace(marker, '<div id="dbgPanel">DEV</div>\n' + marker, 1)
    tpl.write_text(text, encoding='utf-8', newline='\n')


NEGATIVES = [
    ('M1', 'assert_motion.py', m1_dead_reference,
     '[A1] 死引用: v4NoSuchKey', 'A1 无死动画引用'),
    # expect 为 callable 时：传入未变异基线输出，返回期望子串（见 expect_m2_duplicate）。
    # 这样期望不会因基线份数变化而假红。
    ('M2', 'assert_motion.py', m2_duplicate_keyframes,
     expect_m2_duplicate, 'A2 无重复关键帧名'),
    ('M3', 'assert_motion.py', m3_layout_prop,
     '[A3] 违例: zzBad 含 left', 'A3 合成器直通属性'),
    ('M4', 'assert_motion.py', m4_transition_all,
     '[A4] 违例: transition all', 'A4 无 transition:all'),
    ('M5', 'assert_motion.py', m5_bare_duration,
     '[A5] 违例: 裸时长 137ms', 'A5 时长取令牌'),
    ('M6', 'assert_dead_controls.py', m6_pause_hook,
     'infinite 循环动画有 28 条', 'A6 隐藏窗口时循环动画可停（计数维度）'),
    ('M7', 'assert_dead_controls.py', m7_template_dead_button,
     '[A7] 假按钮: zzM7Probe @', 'A7 模板无死控件'),
    ('M8', 'assert_dead_controls.py', m8_js_dead_button,
     '[A8] 假按钮(JS 生成): 无 title 说明: 无说明 @', 'A8 JS 生成按钮有说明'),
    ('M9', 'assert_dead_controls.py', m9_debug_residue,
     '[A9] 调试残余: dbgPanel', 'A9 无调试残余'),
]

# A6/A7/A8/A9 走 assert_dead_controls.py，它接受 --root 与 --json
ROOT_ARG = {'assert_motion.py': ['--root'], 'assert_dead_controls.py': ['--root']}


def root_args(script, copy_root):
    flag = ROOT_ARG[script][0]
    return [flag, str(copy_root)]


# ── 反向负控：干净样本必须 PASS ────────────────────────────────────────────────
CLEAN_MANIFEST = {
    'scripts': [],
    'styles': ['frontend/styles/clean.css'],
}
CLEAN_CSS = """/* 反向负控样本：引用与定义都存在且唯一，只用合成器直通属性，时长全走令牌。
   目的：证明 assert_motion.py 不是「对任何输入都红」。若本样本也 FAIL，
   说明判据把合法动效判成了违例（假红），那时前面九条「都能红」毫无意义。 */
:root{--dur-probe:180ms;--ease-probe:ease-out}
.zz-clean-a{opacity:0;transform:translateY(6px);animation:zzCleanIn var(--dur-probe) var(--ease-probe) both}
.zz-clean-b{transition:opacity var(--dur-probe) var(--ease-probe)}
.zz-clean-c{transition:transform var(--dur-probe) var(--ease-probe),opacity var(--dur-probe)}
@keyframes zzCleanIn{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:none}
}
"""


def run_clean_control(keep=False):
    """构造干净 CSS 副本，assert_motion.py 必须 rc=0 且输出含 PASS。"""
    tmp = Path(tempfile.mkdtemp(prefix='uiaudit-clean-'))
    try:
        (tmp / 'frontend/styles').mkdir(parents=True)
        (tmp / 'frontend/manifest.json').write_text(
            json.dumps(CLEAN_MANIFEST, ensure_ascii=False, indent=2), encoding='utf-8')
        (tmp / 'frontend/styles/clean.css').write_text(CLEAN_CSS, encoding='utf-8',
                                                       newline='\n')
        # EXTRA_CSS = frontend/react/src/island.css 是硬编码的；干净样本里必须也提供一个
        # 空文件，否则 collect_css_paths 会以 environment 失败 —— 那是路径问题不是判据问题。
        (tmp / 'frontend/react/src').mkdir(parents=True)
        (tmp / 'frontend/react/src/island.css').write_text(
            '/* clean control: intentionally empty */\n', encoding='utf-8', newline='\n')
        rc, out = run_script('assert_motion.py', ['--root', str(tmp)])
        ok = (rc == 0) and ('MOTION_STATIC: PASS' in out)
        return ok, rc, out
    finally:
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description='T01 判据注入式负控 M1–M9')
    ap.add_argument('--keep', action='store_true', help='保留临时目录（排查用）')
    ap.add_argument('--only', default='', help='只跑指定 ID（逗号分隔），默认全跑')
    args = ap.parse_args(argv)

    wanted = [s.strip() for s in args.only.split(',') if s.strip()]
    if wanted:
        todo = [n for n in NEGATIVES if n[0] in wanted]
        missing = [w for w in wanted if w not in {n[0] for n in NEGATIVES}]
        if missing:
            print('NEGATIVE: environment 未知负控 ID: %s' % ','.join(missing))
            return 2
    else:
        todo = list(NEGATIVES)

    # 前置：判据脚本都在
    for script in ('assert_motion.py', 'assert_dead_controls.py'):
        if not (HERE / script).is_file():
            print('NEGATIVE: environment 缺少判据脚本 %s' % script)
            return 2

    print('NEGATIVE: 仓库根 = %s' % ROOT)
    print('NEGATIVE: python = %s' % PY)
    print('')

    rows = []
    failures = 0
    # 动态期望需要「未变异基线输出」才能算出来（见 expect_m2_duplicate）。
    # 只对 callable 型的 expect 跑这一次基线，静态期望不浪费一次子进程。
    pristine_cache = {}

    def resolve_expect(expect):
        if not callable(expect):
            return expect
        script = None
        for nid_, script_, _m, e_, _l in todo:
            if e_ is expect:
                script = script_
                break
        if script not in pristine_cache:
            _rc, out = run_script(script, ['--root', str(ROOT)])
            pristine_cache[script] = out
        return expect(pristine_cache[script])

    for nid, script, mutate, expect_spec, live_name in todo:
        expect = resolve_expect(expect_spec)
        tmp = Path(tempfile.mkdtemp(prefix='uiaudit-neg-%s-' % nid.lower()))
        try:
            make_copy(tmp)
            try:
                mutate({'root': tmp})
            except RuntimeError as exc:
                rows.append((nid, live_name, expect, '(锚点失配)', 'FAIL', str(exc)))
                failures += 1
                continue
            rc, out = run_script(script, root_args(script, tmp))
            hit = expect in out
            # 二次确认：不能红在 environment 上
            env_bad = 'environment' in out and 'FAIL (environment)' in out
            verdict = 'PASS' if (hit and not env_bad) else 'FAIL'
            if verdict == 'FAIL':
                failures += 1
            detail = ''
            if env_bad:
                detail = '脚本以 environment 失败退出 —— 这是环境红，不是判据红'
            elif not hit:
                # 把 actual 里最像的一条拉出来，方便直接看「红在别处」
                lines = [ln for ln in out.splitlines() if ln.startswith('[')]
                detail = '『%s』未出现在输出中；实际违例行数=%d，首行=%s' % (
                    expect, len(lines), (lines[0] if lines else '(无违例行)'))
            rows.append((nid, live_name, expect, 'found' if hit else 'missing',
                         verdict, detail))
            print('NEG %s [%s] 判据=%s' % (nid, verdict, script))
            print('        期望: %s' % expect)
            print('        实际: rc=%d  %s' % (rc, 'HIT' if hit else 'MISS'))
            if detail:
                print('        说明: %s' % detail)
        finally:
            if not args.keep:
                shutil.rmtree(tmp, ignore_errors=True)
            else:
                print('        临时目录保留: %s' % tmp)

    # 反向负控
    print('')
    print('NEG M0 [反向负控] 干净样本（引用/定义唯一 + 只用合成器属性 + 时长全走令牌）')
    clean_ok, clean_rc, clean_out = run_clean_control(args.keep)
    print('        期望: MOTION_STATIC: PASS 且 rc=0（证明判据不是「任何输入都红」）')
    print('        实际: rc=%d  %s' % (clean_rc,
                                    'HIT' if clean_ok else 'MISS'))
    if not clean_ok:
        failures += 1
        tail = [ln for ln in clean_out.splitlines() if ln.startswith('[')][:5]
        print('        说明: 干净样本被判红 —— 判据存在假红（合法动效被判违例）')
        for ln in tail:
            print('              %s' % ln)
    rows.append(('M0', '反向负控（干净样本必须 PASS）',
                 'MOTION_STATIC: PASS', 'found' if clean_ok else 'missing',
                 'PASS' if clean_ok else 'FAIL', ''))

    # ── 恒真式自检：每条期望子串在**未变异**的基线上必须 MISS ──────────────────
    # 这一条是本脚本最重要的守卫，而且它的存在本身是被实测逼出来的：
    # A6 是「存在性断言」，基线本来就红（0 钩子），所以「删掉钩子 → 期望
    # `[A6] 缺失: 静置暂停钩子`」这种负控在**零变异时也会 HIT**，它是恒真式。
    # 只跑「变异后是否 HIT」永远发现不了这类问题 —— 必须额外跑一遍基线。
    print('')
    print('NEG 恒真式自检：每条期望子串在未变异基线上必须 MISS（否则该负控没有区分力）')
    tautological = []
    for nid, _script, _mutate, expect_spec, live_name in todo:
        expect = resolve_expect(expect_spec)
        rc, out = run_script(_script, ['--root', str(ROOT)])
        hit_on_pristine = expect in out
        if hit_on_pristine:
            tautological.append(nid)
            print('  %-4s TAUTOLOGY ✗  期望子串在未变异基线上已存在：%s' % (nid, expect))
            print('        => 该负控零变异即可「通过」，没有区分力，必须换判据维度')
        else:
            print('  %-4s clean ✓    基线上 MISS（说明只有变异才能让它 HIT）' % nid)
    if tautological:
        failures += len(tautological)

    print('')
    print('NEGATIVE: %d/%d as-expected' % (len(rows) - failures, len(rows)))
    for nid, live_name, expect, actual, verdict, detail in rows:
        print('  %-4s %-5s 期望=%-5s %s' % (nid, verdict, expect, live_name))
        if detail:
            print('        %s' % detail)
    status = 'PASS' if failures == 0 else 'FAIL'
    print('MOTION_NEGATIVE: %s (%d/%d)' % (status, len(rows) - failures, len(rows)))
    return 0 if failures == 0 else 1


if __name__ == '__main__':
    sys.exit(main())