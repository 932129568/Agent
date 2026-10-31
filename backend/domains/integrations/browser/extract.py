# -*- coding: utf-8 -*-
"""v1.8.0 B 域·正文提取（实现 v1.8.0 B2：readability 风格主体提取 + 选择器覆盖）。

v1.9.0 T02 迁移说明：本模块自 ``backend/domains/search_extract.py`` **原样迁入**
browser/ 包（设计文档 §A2.6）——extract_main_content/DEFAULT_MAX_CHARS 不改名，
代码逐字不变（仅 import 行与文档中模块名引用同步更新）。

模块职责（架构文档 §2.1 后端模块表「正文提取 extract」）：把文章页
HTML 转为主正文文本，供 ``browser_open``（B2）与 ``browser_search`` 的
``extract=full`` 深度提取连锁使用。

算法（readability 风格简化版，纯函数零 IO）：
1. 去噪声标签：``script`` / ``style`` / ``noscript`` / ``iframe`` /
   ``template`` / ``svg`` 整棵移除；
2. 主区块选择：对 ``div`` / ``article`` / ``section`` / ``main`` / ``p``
   候选块按「文本密度」打分——密度 = 归一化文本长度 / (后代元素数 + 1)，
   取最高分块。``p`` 仅在其无块级候选祖先时参与竞选（防止正文被单段
   碎片化——否则每个自然段密度恒高于其容器）；
3. 段落拼接：主区块内所有 ``<p>`` 文本按文档序以换行拼接；无 ``<p>``
   则取整块归一化文本；
4. 选择器覆盖：``selector`` 非空时优先 CSS 选择器路径——命中 →
   ``extractor='selector'``；未命中 → ``extractor='selector_miss'`` +
   空 content（由调用方按契约转 ``SELECTOR_NOT_FOUND`` / ``EMPTY_CONTENT``，
   本函数只给信号不判错）；
5. 截断：超过 ``max_chars`` 截断并置 ``truncated=True`` +
   ``full_chars=原始长度``（toolcache ``full_ref`` 由 service 层补——
   契约 §4.3，本函数不管落盘）。

纯函数铁律：零 IO、零网络——不读写文件、不 import urllib / requests；
HTML 树工具从 ``adapters`` 导入（同为纯函数，extract → adapters
单向依赖，无循环导入）。输入 ``html`` 为 bytes 时按 utf-8
（errors=replace）解码。CSS 选择器语法同 ``adapters.select_first``
（tag/#id/.class 复合 + 后代/子组合器）。
"""
from .adapters import (
    build_tree, element_text, iter_elements, select_first,
)

# 去噪声标签（整棵移除）
_STRIP_TAGS = ('script', 'style', 'noscript', 'iframe', 'template', 'svg')
# 密度候选块级标签
_CANDIDATE_TAGS = ('div', 'article', 'section', 'main')
# p 的「块级候选祖先」判定用（同 _CANDIDATE_TAGS；单独命名表意）
_BLOCK_ANCESTOR_TAGS = _CANDIDATE_TAGS

# browser_open 契约默认 max_chars=8000（§3.1；500-50000 夹逼在 service 层）
DEFAULT_MAX_CHARS = 8000


def extract_main_content(html, selector=None, max_chars=DEFAULT_MAX_CHARS):
    """实现 v1.8.0 B2：提取文章页主正文（纯函数，零 IO）。

    Args:
        html: 页面 HTML（str 或 bytes；bytes 按 utf-8 replace 解码）。
        selector: 可选 CSS 选择器；非空时优先按选择器取首个匹配元素的
            正文（显式覆盖，密度法兜底）。
        max_chars: 正文字数上限（>0 生效；≤0 或无法解析视为不截断）。

    Returns:
        dict: ``{content, truncated, extractor, full_chars}``——
        - ``content``: 主正文（段落以换行拼接；选择器未命中时为空串）；
        - ``truncated``: 是否因超 ``max_chars`` 被截断；
        - ``extractor``: ``'readability'``（密度选块）/ ``'selector'``
          （选择器命中）/ ``'selector_miss'``（选择器未命中）；
        - ``full_chars``: 截断前的完整正文长度（无论是否截断均返回——
          供调用方判 ``thin_warning``（正文 <200 字，契约 §3.1）与
          toolcache 决策）。

    Notes:
        截断标记处不追加 ``...[truncated]`` 尾注——契约 §4.3 规定该尾注
        由序列化层（service）在落 toolcache 时补，本函数只负责截断与
        度量，保持纯函数边界。

    RecursionError 防护：_strip_noise/_pick_main_block/_block_text 内部的
    树遍历均为递归实现，病态深树（万层嵌套）会触发递归上限——此处按
    「无正文」返回（调用方转 EMPTY_CONTENT），不把 RecursionError 抛进
    browser_open 管线（与 adapters.parse_results 同口径）。
    """
    try:
        root = build_tree(html)
        _strip_noise(root)
        sel = str(selector or '').strip()
        if sel:
            target = select_first(root, sel)
            if target is None:
                # 选择器未命中：只给信号，SELECTOR_NOT_FOUND 由调用方转
                return {'content': '', 'truncated': False,
                        'extractor': 'selector_miss', 'full_chars': 0}
            content = _block_text(target)
            extractor = 'selector'
        else:
            block = _pick_main_block(root)
            content = _block_text(block) if block is not None else ''
            extractor = 'readability'
        full_chars = len(content)
        limit = _safe_int(max_chars, DEFAULT_MAX_CHARS)
        if limit > 0 and full_chars > limit:
            content = content[:limit]
            truncated = True
        else:
            truncated = False
        return {'content': content, 'truncated': truncated,
                'extractor': extractor, 'full_chars': full_chars}
    except RecursionError:
        return {'content': '', 'truncated': False,
                'extractor': 'readability', 'full_chars': 0}


def _strip_noise(root):
    """移除噪声标签子树（script/style/noscript/iframe/template/svg）。"""
    def walk(el):
        kept = []
        for child in el.children:
            if child.tag in _STRIP_TAGS:
                continue
            walk(child)
            kept.append(child)
        el.children = kept

    walk(root)


def _pick_main_block(root):
    """密度法选主区块：候选 div/article/section/main/p（p 需无块级候选祖先）。

    密度 = 归一化文本长度 / (后代元素数 + 1)；同分取文本更长者，再同取
    文档序在前者（确定性）。无候选（如纯文本页）返回 None——调用方回落
    空正文（EMPTY_CONTENT 由 service 层判）。
    """
    best = None
    best_score = -1.0
    best_len = -1
    for el in iter_elements(root):
        if el.tag == 'p':
            if _has_block_ancestor(el):
                continue
        elif el.tag not in _CANDIDATE_TAGS:
            continue
        text = element_text(el)
        if not text:
            continue
        text_len = len(text)
        tag_count = sum(1 for _ in iter_elements(el))
        score = text_len / (tag_count + 1)
        if score > best_score or (score == best_score and text_len > best_len):
            best, best_score, best_len = el, score, text_len
    return best


def _has_block_ancestor(el):
    """元素是否有块级候选祖先（div/article/section/main）。"""
    node = el.parent
    while node is not None and node.tag != '#root':
        if node.tag in _BLOCK_ANCESTOR_TAGS:
            return True
        node = node.parent
    return False


def _block_text(el):
    """主区块正文：所有后代 ``<p>`` 文本按文档序拼接；无 ``<p>`` 取整块文本。"""
    paras = []
    for node in iter_elements(el):
        if node.tag == 'p':
            text = element_text(node)
            if text:
                paras.append(text)
    if paras:
        return '\n'.join(paras)
    return element_text(el)


def _safe_int(value, default):
    """int 转换兜底（None/非法值 → default）。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
