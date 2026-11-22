# -*- coding: utf-8 -*-
"""uiaudit 共用 CSS / 模板静态解析工具。

为什么要有这个模块：T01 的 4 个判据脚本里，有 3 个都需要「把 CSS 剥成可安全正则的文本」
「从 @keyframes 块里取声明」「按逗号切 animation 简写」这三件事。各写一份正则必然
口径分叉 —— 同一个 keyframes 名在一处判成定义、在另一处判成未定义，两条断言互相矛盾
时就没人知道哪条对。所以解析只在这里做一次。

三条硬纪律（每条都来自实测踩坑，改动前请先读）：

1. **剥注释必须保行号。** 直接把 `/*...*/` 删掉会让后面的行号全部前移，报错指到错误的
   行上，工程师照着改会改错地方。本模块用「同长度空格 + 保留换行」的方式遮罩，
   保证 `mask_span` 后的文本与原文**逐字符等长**，行号与列号全部可复用。

2. **必须同时遮罩字符串字面量。** CSS 里 `content:"/*"` 这种内容会让朴素的正则
   把注释起始符当真。仓内实测 `content:"…"` 用法存在（legacy.css 有 20+ 处），
   虽然当前没有 `/*` 字面量，但判据不能依赖「恰好还没人这么写」。

3. **动画名大小写敏感，已实测。** 用 playwright-core + Edge 实测：
   `@keyframes UPPER{from{transform:scale(3)}}` 配 `animation:upper 100s`，
   `getComputedStyle().animationName` 返回 `"upper"`、`getAnimations().length === 0`、
   `transform` 为 `none` —— 即引用未命中，动画根本没跑。所以本模块的名字比较
   **一律区分大小写**，不做 `.lower()` 归一。这一条直接决定负控 N-ε 的期望值。

公开接口（全部纯函数，无副作用、不写盘）：
    mask_css(text)                     -> 等长遮罩文本（注释与字符串内容变空格）
    iter_keyframes(masked, label)      -> [(name, start_line, body_masked, body_start)]
    iter_decls(masked)                 -> [(prop_lower, raw_prop, value, offset)]
    split_top_level(value, sep=',')    -> 按顶层分隔符切（不吃括号内的逗号）
    parse_animation_names(value)       -> 从 animation / animation-name 值里取关键帧名列表
    read_text_ascii_safe(path)         -> 读文件并统一换行，返回 (text, newline_style)

用法：
    from _common import mask_css, iter_keyframes, iter_decls
"""

import re

__all__ = [
    'ANIM_KEYWORDS',
    'COMPOSITOR_ALLOWED',
    'LAYOUT_PROPS',
    'iter_decls',
    'iter_keyframes',
    'mask_css',
    'parse_animation_names',
    'read_text_ascii_safe',
    'split_top_level',
    'strip_var_spans',
]

# ── animation / animation-name 简写里不是「关键帧名」的保留字 ───────────────────
# 注意这是**全量枚举**，不是抽样。漏一个保留字就会把它误报成死引用（假红），
# 多一个就会把真死引用当保留字放过（假绿）。两个方向都实测过（见 README §判据）。
ANIM_KEYWORDS = frozenset([
    # 时长 / 延迟 / 迭代 / 方向 / 填充 / 播放态
    'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
    'forwards', 'backwards', 'both', 'running', 'paused',
    # 时序函数关键字
    'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
    'step-start', 'step-end', 'jump-start', 'jump-end', 'jump-none', 'jump-both',
    # 全局值
    'initial', 'inherit', 'unset', 'revert', 'revert-layer',
    # 简写里的「无动画」
    'none',
    # 迭代次数的关键字（animation-iteration-count: infinite 已含，这里补 count 语义）
    'auto',
])

# ── @keyframes 内允许的属性（合成器直通 / 仅绘制，不触发布局与重排）─────────────
# 白名单而不是黑名单的理由：新属性每天都在出现，黑名单必然漏；白名单漏了会报假红
# （工程师看得见、改得动），黑名单漏了会假绿（性能红线悄悄失守）。宁可假红。
COMPOSITOR_ALLOWED = frozenset([
    'transform', 'opacity', 'filter', 'backdrop-filter',
    '-webkit-backdrop-filter', '-webkit-transform', '-ms-transform',
    'clip-path', '-webkit-clip-path',
    'background-position', 'background-position-x', 'background-position-y',
    'background-size', 'background-color', 'background',
    'box-shadow', 'text-shadow',
    'border-radius', 'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'border-top-color', 'border-right-color', 'border-bottom-color',
    'border-left-color', 'border-color', 'outline-color', 'color',
    'visibility', 'z-index', 'mix-blend-mode',
    'offset-distance', 'offset-path', 'offset-rotate', 'offset-anchor',
    'stroke-dashoffset', 'stroke-dasharray', 'stroke', 'fill', 'fill-opacity',
    'stroke-opacity', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
    'lighting-color', 'paint-order',
    'transform-origin', 'transform-box', 'transform-style',
    'perspective', 'perspective-origin', 'backface-visibility',
    'animation-timing-function', 'animation-composition',
])

# ── 触发布局 / 重排的属性（红线的真正靶心）────────────────────────────────────
# 这些属性出现在 @keyframes 里，每帧都要重新 layout，合成器直通被打破。
# 注意：放进这个集合的属性**同时也**不在白名单里，两条判据（白名单 + 布局黑名单）
# 会同时报，这是刻意的 —— 消息里要能直接说清「你踩的是布局属性」而不只是
# 「不在白名单里」，否则工程师要去猜为什么 transform 可以而 left 不行。
LAYOUT_PROPS = frozenset([
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'top', 'left', 'right', 'bottom',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-width', 'border-top-width', 'border-right-width',
    'border-bottom-width', 'border-left-width',
    'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing',
    'word-spacing', 'text-align', 'vertical-align', 'white-space',
    'display', 'position', 'float', 'clear',
    'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'flex-direction', 'flex-wrap',
    'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
    'gap', 'row-gap', 'column-gap',
    'justify-content', 'align-items', 'align-content', 'align-self',
    'overflow', 'overflow-x', 'overflow-y',
    'inset', 'inset-block', 'inset-inline',
])

_DURATION_RE = re.compile(r'^[-+]?(?:\d+\.?\d*|\.\d+)(?:ms|s)$', re.I)
_FUNC_PREFIXES = ('var(', 'calc(', 'steps(', 'cubic-bezier(', 'linear(',
                  'min(', 'max(', 'clamp(', 'env(', '-webkit-calc(',
                  'translate(', 'translate3d(', 'translateX(', 'translateY(',
                  'scale(', 'scaleX(', 'scaleY(', 'rotate(', 'matrix(',
                  'skew(', 'perspective(', 'url(', 'color-mix(', 'url(')


def read_text_ascii_safe(path):
    """读文本文件，把 CRLF/CR 统一成 LF。

    返回 (text, newline_style)，newline_style ∈ {'lf', 'crlf', 'mixed'}。

    为什么要做这件事：本仓 `core.autocrlf=true` 且无 `.gitattributes`，实测同一
    文件在 HEAD blob（LF）与工作区（CRLF）下行数相同但字节数不同。
    判据如果对 `\\r` 敏感，同一份代码在不同 checkout 状态下会给出不同结论 ——
    那是环境问题伪装成代码问题。统一成 LF 后，判据只看语义。
    """
    raw = path.read_bytes() if hasattr(path, 'read_bytes') else open(path, 'rb').read()
    crlf = raw.count(b'\r\n')
    lf_total = raw.count(b'\n')
    bare_lf = lf_total - crlf
    if crlf and bare_lf:
        style = 'mixed'
    elif crlf:
        style = 'crlf'
    else:
        style = 'lf'
    return raw.decode('utf-8', errors='replace').replace('\r\n', '\n').replace('\r', '\n'), style


def mask_css(text):
    """把 CSS 注释与字符串字面量的**内容**替换成空格，长度与原文完全一致。

    · 注释：`/* ... */` 整段（含定界符）变空格，但**保留其中的换行符**。
    · 字符串：`"..."` / `'...'` 的内容变空格，引号本身保留（便于后续识别属性值边界）。
    · 转义：`\\"` 等被正确跳过，不会把转义引号当成字符串结束。

    返回的字符串与入参**逐字符等长且行数相同** ⇒ 任何 offset/line 计算可直接复用。
    """
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '/' and i + 1 < n and text[i + 1] == '*':
            end = text.find('*/', i + 2)
            if end < 0:
                end = n - 2  # 未闭合注释：遮罩到末尾（判据另有未闭合检查）
            for k in range(i, min(end + 2, n)):
                if out[k] != '\n':
                    out[k] = ' '
            i = end + 2
            continue
        if ch in ('"', "'"):
            quote = ch
            j = i + 1
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == quote:
                    break
                j += 1
            for k in range(i + 1, min(j, n)):
                if out[k] != '\n':
                    out[k] = ' '
            i = j + 1
            continue
        i += 1
    return ''.join(out)


def _find_block_end(masked, open_idx):
    """从 open_idx 处的 `{` 起按花括号配平，返回配对 `}` 的下标；配不平返回 -1。"""
    depth = 0
    for i in range(open_idx, len(masked)):
        c = masked[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i
    return -1


def iter_keyframes(masked, label=''):
    """枚举所有 `@keyframes <name>{...}`（含 `@-webkit-keyframes`）。

    yield (name, start_line, body, body_offset)

    · name 原样返回，**不 lower()** —— 已实测 CSS 动画名大小写敏感。
    · body 取自 masked 文本（注释已遮罩），但长度与原文一致，可直接回原文取字符。
    · start_line 为 1-based，指向 `@keyframes` 那一行。
    """
    for m in re.finditer(r'@(?:-[A-Za-z]+-)?keyframes\s+([A-Za-z_][\w-]*)\s*\{', masked):
        open_idx = m.end() - 1
        close_idx = _find_block_end(masked, open_idx)
        if close_idx < 0:
            continue
        start_line = masked.count('\n', 0, m.start()) + 1
        yield (m.group(1), start_line, masked[open_idx + 1:close_idx], open_idx + 1)


def iter_decls(masked, start=0, end=None):
    """枚举 `prop: value` 形式的声明（跳过选择器与 at-rule 头）。

    yield (prop_lower, raw_prop, raw_value, offset)

    只认「不在 `{}` 内的冒号」：选择器里的伪类 `a:hover` 的冒号前面通常紧跟
    选择器名，且后面不会到 `;` 或 `}` 就结束 —— 但 `@media (x:y)` 里的冒号确实
    会误命中。所以额外要求 prop 只由 `[A-Za-z-]` 组成，且不以 `@` 开头。
    """
    if end is None:
        end = len(masked)
    seg = masked[start:end]
    for m in re.finditer(r'(?<![\w-])([A-Za-z][A-Za-z-]*)\s*:\s*([^;{}]*)', seg):
        yield (m.group(1).lower(), m.group(1), m.group(2).strip(), start + m.start())


def split_top_level(value, sep=','):
    """按顶层分隔符切分（括号内的分隔符不切）。

    `animation: a 1s, b 2s` → ['a 1s', ' b 2s']
    `transform: translate(1px, 2px)` → 括号内的逗号不会切开。
    """
    parts = []
    depth = 0
    cur = []
    for ch in value:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        if ch == sep and depth == 0:
            parts.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append(''.join(cur))
    return parts


def strip_var_spans(value):
    """把 `var(...)` 整段（**含括号内的回退值**）替换成等长空格。

    为什么必须剥：`transition: opacity var(--dur-fast, .12s)` 里的 `.12s` 是
    **回退值**，令牌已经用了，回退只是兜底。把它当成「裸魔数违例」是假阳性。
    实测 `frontend/react/src/island.css:139` 一行就有 3 个这样的回退值
    （opacity / color / background），会被报 3 次。

    为什么必须**等长**替换：调用方可能用返回值算 offset。等长替换让所有下标与
    原值一一对应，不必担心拼接后错位。

    嵌套与函数安全：按括号配平逐层剥离，故 `var(--a, var(--b, 1s))` 与
    `var(--x, cubic-bezier(.2,1,.3,1))` 都能正确吃掉；`cubic-bezier` 内的逗号
    不会干扰（我们只在遇到 `var(` 时才进入消费循环）。
    """
    out = list(value)
    i = 0
    n = len(value)
    while i < n:
        if value.startswith('var(', i):
            j = i + 4
            depth = 1
            while j < n and depth > 0:
                if value[j] == '(':
                    depth += 1
                elif value[j] == ')':
                    depth -= 1
                j += 1
            for k in range(i, j):
                out[k] = ' '
            i = j
            continue
        i += 1
    return ''.join(out)


def parse_animation_names(value):
    """从 `animation` / `animation-name` 的**值**里取出关键帧名列表。

    返回 [(name, token)]，name 为候选关键帧名（原样，区分大小写）。

    难点在于 `animation` 是简写，一个值里混着 名称/时长/延时/时序/迭代/方向/填充/播放态，
    而 `animation-name` 里**只有**名称（逗号分隔）。故：
      · 括号之外的每个 token 依次检查；
      · 时长（`1s` / `180ms`）、数字（迭代次数）、保留字、函数调用（`var(...)` 等）跳过；
      · 其余第一个「看起来像标识符」的 token 视为名称。

    为什么每个逗号分段只取**一个**名称：CSS 语法规定 animation 简写里
    `animation-name` 只能出现一次（第二个标识符会覆盖第一个）。实测仓内
    134 条引用中没有任何一条违反这个前提，取第一个即正确。
    """
    names = []
    # 去掉 !important（它可能紧贴最后一个 token）
    cleaned = re.sub(r'!\s*important', '', value or '', flags=re.I)
    for segment in split_top_level(cleaned):
        for token in re.split(r'\s+', segment.strip()):
            t = token.strip()
            if not t:
                continue
            if _DURATION_RE.match(t):
                continue
            if re.fullmatch(r'[-+]?\d+(?:\.\d+)?', t):
                continue  # 迭代次数
            if t.lower() in ANIM_KEYWORDS:
                continue
            if t.lower().startswith(_FUNC_PREFIXES):
                continue
            # 到这里基本可判定是标识符候选（CSS ident 允许字母/数字/下划线/连字符）
            if re.fullmatch(r'[-A-Za-z_][\w-]*', t):
                names.append(t)
                break
    return names