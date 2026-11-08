# -*- coding: utf-8 -*-
"""browser_snapshot 语义快照（R43，F2d 改进④）——纯函数，零三方依赖。

2026 共识（调研轮 15）：浏览器 agent 观察以 a11y/语义树为主（较截图快 2-4x、
token 更省、元素标识稳定），截图保留做视觉验证。Harbor 双链（pywebview 次窗 /
Playwright）都能拿到 DOM——本模块把 HTML 解析为 role/name/state 修剪树文本
（stdlib html.parser，零依赖、纯函数可测）。

取舍（裁决）：
- 只收**可交互/可导航**元素（button/a/input/select/textarea/label/heading/img/
  [role]），树形缩进呈现——聊天 agent 的快照用于「下一步操作定位」，非全页复刻；
- name 优先级：显式文本 > aria-label > placeholder > alt > value > title；
- state 只带行为相关位：disabled/required/checked/selected/expanded/href/type；
- 截断：深度 ≤10 层、条目 ≤400、字符 ≤max_chars（尾部标 truncated）。
"""
import re
from html.parser import HTMLParser

_INTERACTIVE = {'a', 'button', 'input', 'select', 'textarea', 'label', 'option',
                'summary', 'details'}
_HEADING = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
_STATE_ATTRS = ('disabled', 'required', 'checked', 'selected', 'readonly',
                'expanded', 'multiple')

_TYPE_ROLES = {'button': 'button', 'submit': 'button', 'reset': 'button',
               'checkbox': 'checkbox', 'radio': 'radio',
               'text': 'textbox', 'search': 'searchbox',
               'email': 'textbox', 'password': 'passwordbox'}


def _role_of(tag, attrs):
    role = (attrs.get('role') or '').strip()
    if role:
        return role
    if tag in _INTERACTIVE:
        if tag == 'a':
            return 'link'
        if tag in ('input', 'select', 'textarea'):
            t = (attrs.get('type') or tag).lower()
            return _TYPE_ROLES.get(t, 'textbox' if tag != 'select' else 'combobox')
        if tag == 'label':
            return 'label'
        if tag == 'option':
            return 'option'
        if tag == 'summary':
            return 'summary'
        return tag
    if tag in _HEADING:
        return 'heading'
    if tag == 'img':
        return 'image'
    return None


def _name_of(tag, attrs, own_text):
    for key in ('aria-label', 'placeholder', 'alt', 'title'):
        v = (attrs.get(key) or '').strip()
        if v:
            return v
    if own_text.strip():
        return re.sub(r'\s+', ' ', own_text.strip())[:80]
    if tag in ('input',):
        return (attrs.get('name') or attrs.get('id') or '')
    return (attrs.get('name') or attrs.get('id') or '')


class _TreeBuilder(HTMLParser):
    """收集语义节点（扁平列表 + 真实 DOM 深度，呈现时缩进）。

    R43 复核修正：void 元素（input/img 等）不压栈（原实现深度随未闭合标签
    单调漂移——冒烟实证 passwordbox 变成 textbox 的子节点）；文本归属「栈上
    最近的语义节点」（近似 a11y accessible name）。"""

    _VOID = {'input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'wbr',
             'col', 'embed', 'area', 'base', 'track', 'param'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nodes = []          # {depth, role, attrs, text}
        self._stack = []         # [{tag, node_idx, text}] node_idx=None=非语义层

    def handle_starttag(self, tag, attrs_list):
        # boolean 属性（required/checked 等，HTMLParser 给 None）归一 'true'
        attrs = {k: ('true' if v is None else (v or '')) for k, v in attrs_list}
        role = _role_of(tag, attrs)
        node_idx = None
        hidden = (attrs.get('aria-hidden') or '').lower() == 'true'
        if role is not None and not hidden and \
                (attrs.get('type') or '').lower() != 'hidden':
            self.nodes.append({'depth': len(self._stack), 'role': role,
                               'attrs': attrs, 'text': []})
            node_idx = len(self.nodes) - 1
        if tag not in self._VOID:
            self._stack.append({'tag': tag, 'node_idx': node_idx, 'text': []})

    def handle_data(self, data):
        if not self._stack:
            return
        for frame in reversed(self._stack):
            if frame['node_idx'] is not None:
                self.nodes[frame['node_idx']]['text'].append(data)
                return

    def handle_endtag(self, tag):
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i]['tag'] == tag:
                del self._stack[i:]     # 中间未闭合帧一并弹（畸形 HTML 容错）
                return


def build_snapshot_result(html, selector='', max_chars=4000, title=''):
    """HTML → 语义树文本。返回 {ok, snapshot, elements, truncated, selector}。"""
    src = str(html or '')
    if not src.strip():
        return {'ok': False,
                'error': {'code': 'EXTRACT_EMPTY',
                          'message': '页面内容为空——先 browser_navigate 再 snapshot'}}
    builder = _TreeBuilder()
    try:
        builder.feed(src)
    except Exception:
        pass    # 容错解析（畸形 HTML 尽力出树）
    lines = []
    truncated = False
    count = 0
    for n in builder.nodes[:400]:
        if n['depth'] > 10:
            truncated = True
            continue
        name = _name_of('', n['attrs'], ''.join(n['text']))
        states = [a for a in _STATE_ATTRS
                  if (n['attrs'].get(a) or '').lower()
                  not in ('', 'false', 'no')]
        href = (n['attrs'].get('href') or '').strip()
        typ = (n['attrs'].get('type') or '').strip()
        extra = []
        if typ and n['role'] in ('textbox', 'searchbox', 'passwordbox',
                                 'checkbox', 'radio', 'button'):
            extra.append('type=' + typ)
        if href and n['role'] == 'link':
            extra.append('href=' + href[:80])
        if states:
            extra.extend(sorted(states))
        label = (n['role'] + ('「' + name[:60] + '」' if name else '')
                 + ((' [' + ', '.join(extra[:3]) + ']') if extra else ''))
        lines.append('  ' * n['depth'] + '- ' + label)
        count += 1
    if len(builder.nodes) > 400:
        truncated = True
    snapshot = '\n'.join(lines)
    if len(snapshot) > max_chars:
        snapshot = snapshot[:max_chars]
        truncated = True
    return {'ok': True, 'snapshot': snapshot, 'elements': count,
            'truncated': truncated, 'selector': str(selector or '')[:80]}
