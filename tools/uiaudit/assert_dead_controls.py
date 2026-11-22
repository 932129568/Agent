# -*- coding: utf-8 -*-
"""死控件与调试残余静态断言（R101 UX · A6 / A7 / A8 / A9）。

设计基准：deliverables/dev-plan/R101-UX-架构设计.md §1.6（死控件盘点）
+ §4.3.2 的 A6–A9。负控见 assert_motion_negative.py 的 M6–M9。

## 四条断言

| ID | 判据 | 现状（基线实测） |
|---|---|---|
| A6 | 必须有「窗口隐藏时暂停循环动画」的机制（CSS `animation-play-state:paused` 或 JS `animationPlayState='paused'`） | **0 处 → 红** |
| A7 | 模板里不得有「永久 disabled 且无解释」的死控件 | **1 颗 → 红**（`index.template.html:617`） |
| A8 | JS 动态生成的 disabled 按钮必须有说明，且不得自陈不可用 | **2 颗 → 红** |
| A9 | 主界面不得有调试残余特征串 | 0 处 |

## 为什么 A7 和 A8 必须分开（方法论缺口，不是代码洁癖）

`grep -n disabled frontend/index.template.html` 只能看到模板里的 3 处，**永远看不到**
由 JS 拼字符串生成的按钮。实测：
  · `planning/card.js:144` 的 `planEditBtn` —— 模板里不存在，只在运行时出现；
  · `sessions/controller.js:310` 的「在下方输入框」—— 它是模板 `:617` 那颗的**运行时重建版**；
  · `shell/hub-market.js:357` 的翻页钮 —— `(s.page <= 1 ? ' disabled' : '')`，条件态，合理。
只扫模板会漏掉前两个，只扫 JS 会漏掉 `:617`（模板静态态）。所以两条路径都要。

## 区分「真死控件」与「按状态禁用」的判法（A7 的核心，最容易做错）

`index.template.html` 现有 3 处 `disabled`，只有 1 处是假按钮：
  · `:617` `<button ... disabled>在下方输入框</button>` —— **无 id**，无 JS 解禁逻辑 ⇒ 真死
  · `:994 #expertEnableBtn` / `:995 #expertSelectBtn` —— 有 id，且 `expert/center.js:148-149`
    会对它们赋 `.disabled = detail.enabled === false` / `.disabled = false` ⇒ 按状态禁用，**不报**

判法：**该 id 是否在 `frontend/src/**` 里被赋过 disabled（任何取值）**。
只要赋过，就说明它受状态驱动，不是永久死控件。
为什么「赋过 disabled 即算状态驱动」而不是「必须赋过 false」：`select.disabled = detail.enabled === false`
里 `false` 是条件表达式的右操作数，不是赋值终点 —— 只匹配 `.disabled = false` 会把 `:995`
误判成死控件，那是**假红**，会让工程师去改本来就对的代码。

## A8 的两个子判据（为什么「有 title」还不够）

`planning/card.js:144` 那颗 `planEditBtn` **有** title：
`title="当前版本不支持编辑计划；请拒绝后重新描述任务"`
—— title 存在，但它**自陈不可用**。红线 4 要清的是「存在但永远不会被用」的按钮，
title 写着「不支持编辑」恰恰是自证死控件的证据。所以：
  · A8-a：JS 生成的 disabled 按钮**无** title ⇒ 违例（用户不知道为什么不能点）
  · A8-b：JS 生成的 disabled 按钮 title **自陈不可用** ⇒ 违例（红线 4 的靶心）
两个子判据分开报，因为修法不同：a 是补说明，b 是删按钮或做真功能。

`hub-market.js:357` 的 `(s.page <= 1 ? ' disabled' : '')` 是**条件拼接**，不是永久禁用 ⇒ 豁免，
但豁免项在输出里显式计数（`条件态豁免`），不静默丢弃。

## A6 为什么基线是红的

实测全仓 0 处 `animation-play-state`、0 处 `animationPlayState`。而 CSS 里有
**26 条 `infinite` 循环动画**（aurora / typing-dots / tool-spinner / skeleton…）。
窗口最小化或被遮挡时这些循环仍在跑 —— 这是「静置 GPU ≤ 0.5%」红线守不住的主因之一
（实测静置全机 3D 占用 p95=19.06%，见报告）。
所以 A6 在 T01 基线**必须红**，这是真实缺陷，不是判据错。

用法：
    python tools/uiaudit/assert_dead_controls.py
    python tools/uiaudit/assert_dead_controls.py --root <副本> --json

退出码：0 全绿；1 有违例；2 环境缺失。

T01 只负责把这些缺陷变成可判定的红。修绿归 Phase B/T03。
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from _common import read_text_ascii_safe  # noqa: E402

TEMPLATE = 'frontend/index.template.html'

# A8-b：title 自陈不可用的关键词。刻意保守（只收明确表达「用不了」的说法），
# 避免把「暂停中」「加载中…」这类**临时**状态误判成死控件。
UNAVAILABLE_WORDS = ('不支持', '不可用', '暂不支持', '尚未支持', '未实现',
                     'not supported', 'unsupported', 'unavailable')

# A9：调试残余特征。全部是「出现即异常」的强特征，不做模糊匹配。
DEBUG_ID_RE = re.compile(r'\bid=["\']([A-Za-z][\w-]*[Dd]ebug[\w-]*'
                         r'|[A-Za-z][\w-]*[Dd]bg[\w-]*|dbgPanel|devPanel|debugPanel)["\']')
DEV_MARKERS = ('__DEV__', '__DEBUG__', 'console.log(')


class AuditError(Exception):
    """环境级错误 —— 判失败，不判通过。"""


def mask_js_comments(text):
    """只遮罩注释，**保留字符串字面量内容**。

    必须保留字符串：A8 要读 `<button ... title="...">` 里的文案，那段文案就在
    JS 字符串里。若把字符串也遮掉，A8 永远读不到 title → 全部误判成「无 title 说明」。
    （与 _common.mask_css 分工不同：那边为解析 CSS 结构要遮字符串，这边为读文案要保留。）
    """
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            j = n - 2 if j < 0 else j
            for k in range(i, min(j + 2, n)):
                if out[k] != '\n':
                    out[k] = ' '
            i = j + 2
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            j = n if j < 0 else j
            for k in range(i, j):
                if out[k] != '\n':
                    out[k] = ' '
            i = j
            continue
        if c in ('"', "'", '`'):
            q = c
            j = i + 1
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == q:
                    break
                j += 1
            i = j + 1
            continue
        i += 1
    return ''.join(out)


_BUTTON_RE = re.compile(r'<button\b([^<>]*)>([^<>]*)', re.S)


def iter_disabled_buttons(masked):
    """枚举 `disabled` 按钮：yield (line, attrs, text)。"""
    for m in _BUTTON_RE.finditer(masked):
        attrs = m.group(1)
        if not re.search(r'\bdisabled\b', attrs):
            continue
        line = masked.count('\n', 0, m.start()) + 1
        body = re.sub(r'\s+', ' ', m.group(2)).strip()
        yield line, attrs, body


def attr(attrs, name):
    m = re.search(r'\b%s\s*=\s*["\']([^"\']*)' % name, attrs)
    return m.group(1) if m else None


def is_conditional_disabled(attrs):
    """判断 `disabled` 是否由三元/短路拼接（条件态），而非硬写在标签上。

    实测形态（hub-market.js:357）：
        '<button type="button" data-hm-page="' + (s.page - 1) + '"' +
        (s.page <= 1 ? ' disabled' : '') + '>上一页</button>'
    """
    return bool(re.search(r'\?[^?\n]*[\'"]\s*disabled', attrs)) or \
        bool(re.search(r'[\'"]\s*disabled\s*[\'"]\s*:', attrs))


def resolve_state_driver(src_all, btn_id):
    """判断模板里 id=btn_id 的按钮，是否在 JS 里被「状态驱动地」赋过 disabled。

    返回一句人读说明（供豁免行引用），没找到则返回 None。

    为什么要做变量间接解析（这是本函数存在的唯一理由）：
    `expert/center.js:105-110` 的写法是
        const enable = document.getElementById('expertEnableBtn');
        if (enable) enable.disabled = true;
    赋值点写的是**变量名** `enable`，不是 id 字符串 `expertEnableBtn`。
    第一版判据只做「`.disabled =` 前后 60 字符内有 id 字符串」的窗口匹配 ⇒ 两者相距
    200+ 字符，永远匹配不到 ⇒ `:994` / `:995` 被误报成死控件（**假红**，共 2 条）。
    这与本文件 docstring 承诺的「不得误报状态型按钮」直接冲突。

    所以改成两步：
      ① 先找该 id 被绑定到了哪些变量名（形如 `const x = document.getElementById('id')`，
         也认 `$('id')` 与 `querySelector('#id')` 形态，本仓都存在）。
      ② 再找这些变量名（或裸 id 字符串）附近的 `.disabled =` 赋值。

    仍不收敛的边界（刻意不处理，宁可假红不可假绿）：
    若某处用 `Element.prototype` 或动态计算属性名（`el['disabled']`）绕开，
    本函数看不见 ⇒ 那颗按钮会被判死控件。届时看豁免日志即可定位，不会静默。
    """
    if not btn_id:
        return None
    names = {btn_id}
    esc = re.escape(btn_id)
    for m in re.finditer(r'(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'
                         r'(?:document\.getElementById\(\s*[\'"]%s[\'"]\s*\)'
                         r'|\$\(\s*[\'"]%s[\'"]\s*\)'
                         r'|document\.querySelector\(\s*[\'"]#%s[\'"]\s*\))' % (esc, esc, esc),
                         src_all):
        names.add(m.group(1))
    for m in re.finditer(r'\.disabled\s*=', src_all):
        window = src_all[max(0, m.start() - 80):m.end() + 80]
        for name in names:
            if re.search(r'\b%s\b' % re.escape(name), window):
                snippet = re.sub(r'\s+', ' ', src_all[max(0, m.start() - 40):m.end() + 40])
                return snippet.strip()
    return None


def _css_files(root):
    manifest_path = root / 'frontend' / 'manifest.json'
    if not manifest_path.is_file():
        raise AuditError('frontend/manifest.json 不存在：%s' % manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    styles = manifest.get('styles')
    if not isinstance(styles, list) or not styles:
        raise AuditError('manifest.styles 为空 —— 判据无从下手，判失败')
    files = [(rel, root / rel) for rel in styles]
    extra = root / 'frontend/react/src/island.css'
    if extra.is_file():
        files.append(('frontend/react/src/island.css', extra))
    for rel, path in files:
        if not path.is_file():
            raise AuditError('待扫 CSS 不存在：%s' % rel)
    return files


# ── A6 ────────────────────────────────────────────────────────────────────────
def check_a6_idle_pause(root):
    """A6：必须有静置暂停循环动画的机制。"""
    css_hits, js_hits, loop_count = [], [], 0
    for rel, path in _css_files(root):
        text, _nl = read_text_ascii_safe(path)
        for m in re.finditer(r'animation-play-state\s*:\s*([^;}]+)', text):
            if m.group(1).strip().lower().startswith('paused'):
                css_hits.append({'file': rel,
                                 'line': text.count('\n', 0, m.start()) + 1})
        loop_count += len(re.findall(r'animation\s*:[^;}]*\binfinite\b', text))

    src_dir = root / 'frontend/src'
    if not src_dir.is_dir():
        raise AuditError('frontend/src 不存在：%s' % src_dir)
    js_patterns = (
        re.compile(r'animationPlayState\s*=\s*[\'"]paused'),
        re.compile(r'getAnimations\s*\(\s*\)[^;]{0,80}\.pause\s*\('),
    )
    for path in sorted(src_dir.rglob('*.js')):
        text, _nl = read_text_ascii_safe(path)
        masked = mask_js_comments(text)
        for pat in js_patterns:
            for m in pat.finditer(masked):
                js_hits.append({'file': str(path.relative_to(root)).replace('\\', '/'),
                                'line': masked.count('\n', 0, m.start()) + 1})

    violations = []
    total = len(css_hits) + len(js_hits)
    if total == 0:
        violations.append({
            'id': 'A6', 'kind': 'no-pause-hook',
            'detail': '动画暂停钩子 0 处（CSS animation-play-state / JS animationPlayState 均无），'
                      '而 infinite 循环动画有 %d 条' % loop_count,
        })
    return violations, {'hooks': total, 'css': len(css_hits), 'js': len(js_hits),
                        'infinite_loops': loop_count}


# ── A7 ────────────────────────────────────────────────────────────────────────
def check_a7_template_dead(root):
    """A7：模板静态 disabled 按钮中，无解释且非状态驱动的 = 死控件。"""
    tpl = root / TEMPLATE
    if not tpl.is_file():
        raise AuditError('模板不存在：%s' % tpl)
    text, _nl = read_text_ascii_safe(tpl)
    masked = mask_js_comments(text)

    src_dir = root / 'frontend/src'
    if not src_dir.is_dir():
        raise AuditError('frontend/src 不存在：%s' % src_dir)
    src_blob = []
    for path in sorted(src_dir.rglob('*.js')):
        t, _ = read_text_ascii_safe(path)
        src_blob.append(mask_js_comments(t))
    src_all = '\n'.join(src_blob)

    violations, exempt = [], []
    for line, attrs, body in iter_disabled_buttons(masked):
        bid = attr(attrs, 'id')
        btitle = attr(attrs, 'title')
        assign = resolve_state_driver(src_all, bid) if bid else None
        if assign is not None:
            exempt.append({'id': bid, 'line': line,
                           'reason': '该 id 在 JS 中被赋过 disabled（状态驱动）：%s' % assign})
            continue
        if btitle:
            exempt.append({'id': bid, 'line': line,
                           'reason': '有 title 说明（%s）' % btitle[:30]})
            continue
        violations.append({'id': 'A7', 'kind': 'template-dead', 'text': body[:40],
                           'file': TEMPLATE, 'line': line,
                           'has_id': bid, 'has_title': bool(btitle)})
    return violations, {'candidates': len(violations) + len(exempt), 'exempt': exempt}


# ── A8 ────────────────────────────────────────────────────────────────────────
def check_a8_js_dead(root):
    """A8：JS 动态生成的 disabled 按钮，须有说明且不得自陈不可用。"""
    src_dir = root / 'frontend/src'
    if not src_dir.is_dir():
        raise AuditError('frontend/src 不存在：%s' % src_dir)

    violations, exempt = [], []
    for path in sorted(src_dir.rglob('*.js')):
        rel = str(path.relative_to(root)).replace('\\', '/')
        text, _nl = read_text_ascii_safe(path)
        masked = mask_js_comments(text)
        for line, attrs, body in iter_disabled_buttons(masked):
            bid = attr(attrs, 'id')
            btitle = attr(attrs, 'title')
            if is_conditional_disabled(attrs):
                exempt.append({'file': rel, 'line': line, 'id': bid,
                               'reason': '条件态 disabled（三元拼接），非永久禁用'})
                continue
            if not btitle:
                violations.append({'id': 'A8', 'kind': 'js-no-title', 'file': rel,
                                   'line': line, 'btn_id': bid, 'text': body[:40]})
                continue
            low = btitle.lower()
            if any(w in low for w in UNAVAILABLE_WORDS):
                violations.append({'id': 'A8', 'kind': 'js-unavailable', 'file': rel,
                                   'line': line, 'btn_id': bid, 'text': body[:40],
                                   'title': btitle[:60]})
    return violations, {'exempt': exempt}


# ── A9 ────────────────────────────────────────────────────────────────────────
def check_a9_debug_residue(root):
    """A9：主界面模板不得含调试残余。"""
    tpl = root / TEMPLATE
    if not tpl.is_file():
        raise AuditError('模板不存在：%s' % tpl)
    text, _nl = read_text_ascii_safe(tpl)
    violations = []
    for m in DEBUG_ID_RE.finditer(text):
        violations.append({'id': 'A9', 'kind': 'debug-id', 'name': m.group(1),
                           'file': TEMPLATE,
                           'line': text.count('\n', 0, m.start()) + 1})
    for marker in DEV_MARKERS:
        for m in re.finditer(re.escape(marker), text):
            violations.append({'id': 'A9', 'kind': 'marker', 'name': marker,
                               'file': TEMPLATE,
                               'line': text.count('\n', 0, m.start()) + 1})
    return violations, {}


# ── 渲染 ──────────────────────────────────────────────────────────────────────
def render_line(v):
    """稳定、可逐字匹配的输出行。格式变更 = 所有负控期望值变更，属契约变更。"""
    vid = v['id']
    if vid == 'A6':
        return '[A6] 缺失: 静置暂停钩子 @ 全仓（%s）' % v['detail']
    if vid == 'A7':
        return ('[A7] 假按钮: %s @ %s:%d（无 id、无 title、无 JS 解禁逻辑 => 永久禁用）'
                % (v['text'] or '(空文案)', v['file'], v['line']))
    if vid == 'A8':
        if v['kind'] == 'js-no-title':
            return ('[A8] 假按钮(JS 生成): 无 title 说明: %s @ %s:%d (id=%s)'
                    % (v['text'] or '(空文案)', v['file'], v['line'], v['btn_id']))
        return ('[A8] 假按钮(JS 生成): title 自陈不可用: %s @ %s:%d (id=%s, title=%s)'
                % (v['text'] or '(空文案)', v['file'], v['line'], v['btn_id'], v['title']))
    if vid == 'A9':
        return '[A9] 调试残余: %s @ %s:%d' % (v['name'], v['file'], v['line'])
    return '[%s] 未分类违例: %s' % (vid, json.dumps(v, ensure_ascii=False))


def main(argv=None):
    ap = argparse.ArgumentParser(description='死控件与调试残余断言 A6–A9')
    ap.add_argument('--root', default='', help='仓库根（默认按本文件位置推导）')
    ap.add_argument('--json', action='store_true', help='额外输出一行机读 JSON')
    args = ap.parse_args(argv)

    root = Path(args.root).resolve() if args.root else HERE.parent.parent
    try:
        a6, s6 = check_a6_idle_pause(root)
        a7, s7 = check_a7_template_dead(root)
        a8, s8 = check_a8_js_dead(root)
        a9, _s9 = check_a9_debug_residue(root)
    except (AuditError, OSError, ValueError) as exc:
        print('DEAD_CONTROLS: FAIL (environment) %s' % exc)
        return 2

    all_v = a6 + a7 + a8 + a9

    print('DEAD_CONTROLS: root = %s' % root)
    print('')

    for vid, group in (('A6', a6), ('A7', a7), ('A8', a8), ('A9', a9)):
        if not group:
            print('[%s] 0 条' % vid)
            continue
        for v in sorted(group, key=lambda x: (x.get('file', ''), x.get('line', 0))):
            print(render_line(v))
    print('')

    # 豁免项必须显式列出：静默豁免 = 永久豁免
    for tag, items in (('A7', s7.get('exempt', [])), ('A8', s8.get('exempt', []))):
        for it in items:
            print('[%s] 豁免: line=%s id=%s（%s）'
                  % (tag, it.get('line'), it.get('id'), it['reason']))
    print('')

    print('DEAD_CONTROLS: A6 hooks=%d (css=%d js=%d) infinite-loops=%d | '
          'A7 candidates=%d dead=%d exempt=%d | A8 dead=%d exempt=%d | A9=%d'
          % (s6['hooks'], s6['css'], s6['js'], s6['infinite_loops'],
             s7['candidates'], len(a7), len(s7.get('exempt', [])),
             len(a8), len(s8.get('exempt', [])), len(a9)))

    status = 'PASS' if not all_v else 'FAIL'
    print('DEAD_CONTROLS: %s (A6=%d A7=%d A8=%d A9=%d total=%d)'
          % (status, len(a6), len(a7), len(a8), len(a9), len(all_v)))

    if args.json:
        print(json.dumps({
            'status': status,
            'counts': {'A6': len(a6), 'A7': len(a7), 'A8': len(a8), 'A9': len(a9)},
            'lines': [render_line(v) for v in all_v],
        }, ensure_ascii=False, sort_keys=True))

    return 0 if not all_v else 1


if __name__ == '__main__':
    sys.exit(main())