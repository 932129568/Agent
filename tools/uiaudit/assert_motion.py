# -*- coding: utf-8 -*-
"""动效静态断言（R101 UX · A1 / A2 / A3 / A4 / A5）。

设计基准：deliverables/dev-plan/R101-UX-架构设计.md §4.3.2 的 A1–A5，
负控由 assert_motion_negative.py 逐条注入验证（M1–M5）。

为什么这些判据必须是「静态扫描」而不是跑浏览器：
  1. 死引用（引用了一个不存在的 @keyframes）在浏览器里的表现是**静默无害** ——
     `getComputedStyle().animationName` 照样返回那个名字，`getAnimations()` 返回空。
     没有任何运行时错误，没有控制台警告。实测确认（见 README「已实测清单」）。
     只有静态扫描能把「写了但没生效」变成可判定的红。
  2. 重复 keyframes 名在浏览器里是**后者覆盖前者**，同样完全静默。
     而它往往是复制粘贴出错、两处视觉意图不一致的征兆。
  3. `@keyframes` 内的布局属性违法是性能问题，浏览器不报错，只掉帧。

所以本脚本的红不是「代码不能跑」，是「代码能跑但动效没生效 / 性能红线被破」。

## 五条断言（每条都可失败，且都有对应负控证伪）

| ID | 判据 | 为什么这样判 |
|---|---|---|
| A1 | `animation` / `animation-name` 引用的每个名字，必须有同名 `@keyframes` 定义 | 死引用静默失效，浏览器不报错 |
| A2 | 同一 `@keyframes` 名不得定义 >1 次 | 后者覆盖前者，且通常意味着两处意图冲突 |
| A3 | `@keyframes` 块内属性必须 ⊆ 合成器直通白名单；布局属性单独点名 | 布局属性每帧重排，直接破「合成器直通」纪律 |
| A4 | 不得出现 `transition:all` / `transition-property:all` | `all` 把未预期属性一起过渡，触发意外重排 |
| A5 | 动画时长必须用 `var(--dur-*)` 令牌，不得裸写 `137ms` | 令牌是单一事实源；裸数字让 fx-off 降级与全局改时长全部失效 |

A5 的两个白名单（都是实测出来的，不是拍的）：
  · `infinite` 循环动画：设计上本就是长循环，架构文档 §6.2 明确写了「L4 需 1.8–3.2s
    循环令牌（无）」——即令牌体系当前**还没有**循环档，此时硬要求令牌等于要求
    工程师先造令牌。故豁免，但豁免项必须出现在输出里（不静默）。
  · `.01ms` 降级开关：这是 fx-off / reduced-motion 的**停用**写法，字面量本身就是
    语义（越短越好），不需要令牌。

## 判据不许只有 rc

本脚本的退出码只有 0/1，但**必须在输出里给出可机读的行集合**：
  `[A1] 死引用: <name> @ <file>:<line> (via <prop>)`
  `[A2] 重复定义: <name> x<N> @ <file>:<line>,<line>`
  `[A3] 违例: <kfname> 含 <prop> @ <file>:<line>`
  `[A4] 违例: transition all @ <file>:<line>`
  `[A5] 违例: 裸时长 <token> @ <file>:<line>`
最后一行固定为 `MOTION_STATIC: <PASS|FAIL> (A1..A5 计数摘要)`。
assert_motion_negative.py 就是匹配这些**行**而不只是 rc —— 因为「脚本崩了 / 扫到 0 个文件 /
正则漏改」三种情况都会给出 rc=0 但行集合为空，那是假绿。

## 扫描范围（口径必须写死，否则两个脚本会各扫一套）

`frontend/manifest.json` 的 `styles` 数组（当前 14 个文件，Q8 裁决不许变）
+ `frontend/react/src/island.css`（不进 manifest，但经 React IIFE 内联进产物）。

不扫 `deliverables/design/liquid-glass/styles/*.css` —— 那是设计稿素材，
不是运行时样式，把它算进来会让判据盯着不该盯的东西。

用法：
    python tools/uiaudit/assert_motion.py            # 人类可读输出
    python tools/uiaudit/assert_motion.py --json     # 额外输出一行机读 JSON
    python tools/uiaudit/assert_motion.py --root DIR # 指定仓库根（负控在临时副本上用）

退出码：0 全绿；1 有违例；2 环境缺失（manifest 读不到 / 0 个 CSS 被扫）。
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from _common import (  # noqa: E402
    COMPOSITOR_ALLOWED,
    LAYOUT_PROPS,
    iter_decls,
    iter_keyframes,
    mask_css,
    parse_animation_names,
    read_text_ascii_safe,
    strip_var_spans,
)

# ── 扫描范围 ───────────────────────────────────────────────────────────────────
# manifest.styles 之外的补充清单。island.css 经 React IIFE 内联、运行时真的生效，
# 必须一起扫；否则「v4LineIn 补了定义但 island.css 里又写了个死引用」会被漏掉。
EXTRA_CSS = ('frontend/react/src/island.css',)

# A5 的豁免：`.01ms` 是降级停用写法，语义即「尽可能短」
KILL_DURATION_RE = re.compile(r'^\.?0*(?:\.0*1)?ms$|^\.01ms$', re.I)
_DURATION_TOKEN_RE = re.compile(r'(?:^|[\s,])[\d.]+m?s(?![\w-])', re.I)


class AuditError(Exception):
    """环境级错误（manifest 缺失 / 扫不到文件）—— 判失败，不判通过。"""


def collect_css_paths(root):
    """按 manifest.styles + EXTRA_CSS 得到待扫文件列表。

    不静默兜底：manifest 缺失直接抛 AuditError。若改成「manifest 缺失就扫
    frontend/**/*.css」，一旦 manifest 路径改了，判据会悄悄换一个扫描面，
    而输出里看不出这件事。
    """
    manifest_path = root / 'frontend' / 'manifest.json'
    if not manifest_path.is_file():
        raise AuditError('frontend/manifest.json 不存在：%s' % manifest_path)
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except ValueError as exc:
        raise AuditError('frontend/manifest.json 解析失败：%s' % exc)
    styles = manifest.get('styles')
    if not isinstance(styles, list) or not styles:
        raise AuditError('manifest.styles 为空或不是数组 —— 判据无从下手，判失败')
    rels = list(styles) + [p for p in EXTRA_CSS if p not in styles]
    out = []
    for rel in rels:
        path = root / rel
        if not path.is_file():
            raise AuditError('待扫 CSS 不存在：%s（manifest 声明了但文件不在）' % rel)
        out.append((rel.replace('\\', '/'), path))
    return out


def load_css(root):
    """读入所有待扫 CSS，返回 [(label, text, masked, newline_style)]。"""
    loaded = []
    for label, path in collect_css_paths(root):
        text, nl = read_text_ascii_safe(path)
        loaded.append((label, text, mask_css(text), nl))
    if not loaded:
        raise AuditError('扫到 0 个 CSS 文件 —— 判失败（不许「没东西可扫」算通过）')
    return loaded


# ── 各条断言 ───────────────────────────────────────────────────────────────────
def check_a1_dead_refs(loaded):
    """A1：每个被引用的关键帧名都必须有同名定义（**区分大小写**）。"""
    defs = {}
    for label, _text, masked, _nl in loaded:
        for name, line, _body, _off in iter_keyframes(masked, label):
            defs.setdefault(name, []).append((label, line))

    violations = []
    ref_count = 0
    for label, _text, masked, _nl in loaded:
        for prop_l, _raw_prop, value, offset in iter_decls(masked):
            if prop_l not in ('animation', 'animation-name'):
                continue
            line = masked.count('\n', 0, offset) + 1
            # 先剥 var(...)：`animation: var(--kf, v4Something) 1s` 里的回退名不是
            # 真的「写了这个动画」，剥掉后 parse_animation_names 才只看真名称。
            for name in parse_animation_names(strip_var_spans(value)):
                ref_count += 1
                if name not in defs:
                    violations.append({
                        'id': 'A1', 'kind': 'dead-ref', 'name': name,
                        'file': label, 'line': line, 'via': prop_l,
                    })
    return violations, {'refs': ref_count, 'defs_unique': len(defs)}


def check_a2_duplicate_keyframes(loaded):
    """A2：同一关键帧名不得定义 >1 次。"""
    defs = {}
    for label, _text, masked, _nl in loaded:
        for name, line, _body, _off in iter_keyframes(masked, label):
            defs.setdefault(name, []).append((label, line))
    violations = []
    for name in sorted(defs):
        places = defs[name]
        if len(places) > 1:
            violations.append({
                'id': 'A2', 'kind': 'dup-kf', 'name': name, 'count': len(places),
                'places': ['%s:%d' % (f, l) for f, l in places],
            })
    return violations, {'defs_total': sum(len(v) for v in defs.values()),
                        'defs_unique': len(defs)}


def check_a3_keyframe_props(loaded):
    """A3：@keyframes 内属性必须 ⊆ 合成器直通白名单。

    分类报告（不是一条大杂烩）：
      · 命中 LAYOUT_PROPS → kind='layout-prop'，消息明确说「触发布局」
      · 白名单外但也不是布局属性 → kind='non-compositor'，说「不在合成器白名单」
    分开的理由：布局属性是性能红线的真正靶心，工程师见到 layout 就知道该怎么改
    （换成 transform）；见到 non-compositor 还得自己判断。
    """
    violations = []
    prop_histogram = {}
    kf_count = 0
    for label, _text, masked, _nl in loaded:
        for name, kf_line, body, body_off in iter_keyframes(masked, label):
            kf_count += 1
            for prop_l, raw_prop, _val, off in iter_decls(body):
                # 跳过 at-rule（@ 开头已被 iter_decls 排除）与函数内部的伪属性
                prop_histogram[prop_l] = prop_histogram.get(prop_l, 0) + 1
                if prop_l in LAYOUT_PROPS:
                    violations.append({
                        'id': 'A3', 'kind': 'layout-prop', 'kf': name, 'prop': raw_prop,
                        'file': label,
                        'line': masked.count('\n', 0, body_off + off) + 1,
                    })
                elif prop_l not in COMPOSITOR_ALLOWED:
                    violations.append({
                        'id': 'A3', 'kind': 'non-compositor', 'kf': name, 'prop': raw_prop,
                        'file': label,
                        'line': masked.count('\n', 0, body_off + off) + 1,
                    })
    return violations, {'keyframes': kf_count, 'props': prop_histogram}


def check_a4_transition_all(loaded):
    """A4：不得 transition:all（含 transition-property:all）。"""
    violations = []
    decl_count = 0
    for label, _text, masked, _nl in loaded:
        for prop_l, raw_prop, value, offset in iter_decls(masked):
            if prop_l not in ('transition', 'transition-property'):
                continue
            decl_count += 1
            # 逐段判：`transition: opacity .2s, all .3s` 只有第二段违法
            for seg in value.split(','):
                tokens = seg.replace('!important', '').replace('! important', '').split()
                if any(t.lower() == 'all' for t in tokens):
                    violations.append({
                        'id': 'A4', 'kind': 'transition-all',
                        'file': label, 'line': masked.count('\n', 0, offset) + 1,
                        'value': seg.strip()[:80],
                    })
                    break
    return violations, {'transition_decls': decl_count}


def check_a5_bare_durations(loaded):
    """A5：动画/过渡时长必须取令牌，不得裸写毫秒/秒魔数。

    豁免两类（豁免项在 summary 里显式计数，不静默丢弃）：
      · 值里含 `infinite` → 循环动画，令牌体系当前无循环档（架构 §6.2 已登记缺口）
      · `.01ms` → fx-off / reduced-motion 的停用写法，字面量即语义

    **必须先剥 `var(...)` 再找时长**：`var(--dur-fast, .12s)` 里的 `.12s` 是回退值，
    令牌已经用了，把回退值当裸魔数是假阳性。实测 island.css:139 一行有 3 个回退值，
    不剥会一次报 3 条假违例（好险没把它当「3 处真问题」报给产品）。
    """
    violations = []
    stats = {'exempt_loop': 0, 'exempt_kill': 0, 'checked': 0, 'var_fallback_skipped': 0}
    for label, _text, masked, _nl in loaded:
        for prop_l, raw_prop, value, offset in iter_decls(masked):
            if prop_l not in ('animation', 'transition',
                              'animation-duration', 'transition-duration'):
                continue
            stats['checked'] += 1
            low = value.lower()
            # 剥掉 var(...) 后再找时长令牌：结果串等长，offset 仍可用
            stripped = strip_var_spans(value)
            tokens = [m.group(0).strip() for m in _DURATION_TOKEN_RE.finditer(stripped)]
            if not tokens:
                if value != stripped:
                    stats['var_fallback_skipped'] += 1
                continue
            if 'infinite' in low:
                stats['exempt_loop'] += len(tokens)
                continue
            if all(KILL_DURATION_RE.match(t.replace('.01ms', '.01ms')) for t in tokens):
                stats['exempt_kill'] += len(tokens)
                continue
            for tok in tokens:
                if tok.replace(' ', '').lower() == '.01ms':
                    stats['exempt_kill'] += 1
                    continue
                violations.append({
                    'id': 'A5', 'kind': 'bare-duration', 'token': tok,
                    'file': label, 'line': masked.count('\n', 0, offset) + 1,
                    'value': value.strip()[:80],
                })
    return violations, stats


# ── 输出 ───────────────────────────────────────────────────────────────────────
def render_line(v):
    """把一条违例渲染成**稳定、可逐字匹配**的一行。

    稳定性要求：负控要拿这一行去比对期望子串，所以格式一旦定下就不许随意改
    顺序/分隔符/大小写。改动格式 = 改动所有负控的期望值，属于契约变更。
    """
    vid = v['id']
    if vid == 'A1':
        return '[A1] 死引用: %s @ %s:%d (via %s)' % (v['name'], v['file'], v['line'], v['via'])
    if vid == 'A2':
        return ('[A2] 重复定义: %s x%d @ %s'
                % (v['name'], v['count'], ','.join(v['places'])))
    if vid == 'A3':
        if v['kind'] == 'layout-prop':
            return ('[A3] 违例: %s 含 %s（触发布局/重排，应改用 transform/opacity） @ %s:%d'
                    % (v['kf'], v['prop'], v['file'], v['line']))
        return ('[A3] 违例: %s 含 %s（不在合成器直通白名单） @ %s:%d'
                % (v['kf'], v['prop'], v['file'], v['line']))
    if vid == 'A4':
        return '[A4] 违例: transition all @ %s:%d (%s)' % (v['file'], v['line'], v['value'])
    if vid == 'A5':
        return '[A5] 违例: 裸时长 %s @ %s:%d (%s)' % (v['token'], v['file'], v['line'], v['value'])
    return '[%s] 未分类违例: %s' % (vid, json.dumps(v, ensure_ascii=False))


def main(argv=None):
    ap = argparse.ArgumentParser(description='动效静态断言 A1–A5')
    ap.add_argument('--root', default='', help='仓库根（默认按本文件位置推导）')
    ap.add_argument('--json', action='store_true', help='额外输出一行机读 JSON')
    args = ap.parse_args(argv)

    root = Path(args.root).resolve() if args.root else HERE.parent.parent
    try:
        loaded = load_css(root)
    except AuditError as exc:
        print('MOTION_STATIC: FAIL (environment) %s' % exc)
        return 2

    a1, s1 = check_a1_dead_refs(loaded)
    a2, s2 = check_a2_duplicate_keyframes(loaded)
    a3, s3 = check_a3_keyframe_props(loaded)
    a4, s4 = check_a4_transition_all(loaded)
    a5, s5 = check_a5_bare_durations(loaded)

    all_v = a1 + a2 + a3 + a4 + a5

    print('MOTION_STATIC: scanned %d css files' % len(loaded))
    for label, _t, _m, nl in loaded:
        if nl != 'lf':
            print('MOTION_STATIC: note: %s newline=%s（判据已统一为 LF 后比对）' % (label, nl))
    print('')

    # 按 ID 分组打印，组内按 file:line 排序 —— 顺序稳定才能逐字比对
    for vid, group in (('A1', a1), ('A2', a2), ('A3', a3), ('A4', a4), ('A5', a5)):
        if not group:
            print('[%s] 0 条' % vid)
            continue
        group = sorted(group, key=lambda v: (v.get('file', ''),
                                             v.get('line', 0),
                                             v.get('name', v.get('kf', '')),
                                             v.get('prop', '')))
        for v in group:
            print(render_line(v))
    print('')

    print('MOTION_STATIC: A1 refs=%d defs=%d dead=%d | A2 defs=%d unique=%d dup-groups=%d '
          '| A3 kf=%d layout=%d noncomp=%d | A4 transition-decls=%d all=%d '
          '| A5 checked=%d bare=%d exempt-loop=%d exempt-kill=%d var-fallback-skipped=%d'
          % (s1['refs'], s1['defs_unique'], len(a1),
             s2['defs_total'], s2['defs_unique'], len(a2),
             s3['keyframes'], len([v for v in a3 if v['kind'] == 'layout-prop']),
             len([v for v in a3 if v['kind'] == 'non-compositor']),
             s4['transition_decls'], len(a4),
             s5['checked'], len(a5), s5['exempt_loop'], s5['exempt_kill'],
             s5['var_fallback_skipped']))

    status = 'PASS' if not all_v else 'FAIL'
    print('MOTION_STATIC: %s (A1=%d A2=%d A3=%d A4=%d A5=%d total=%d)'
          % (status, len(a1), len(a2), len(a3), len(a4), len(a5), len(all_v)))

    if args.json:
        print(json.dumps({
            'status': status,
            'counts': {'A1': len(a1), 'A2': len(a2), 'A3': len(a3),
                       'A4': len(a4), 'A5': len(a5)},
            'deadRefs': sorted({v['name'] for v in a1}),
            'dupKeyframes': sorted({v['name'] for v in a2}),
            'lines': [render_line(v) for v in all_v],
        }, ensure_ascii=False, sort_keys=True))

    return 0 if not all_v else 1


if __name__ == '__main__':
    sys.exit(main())