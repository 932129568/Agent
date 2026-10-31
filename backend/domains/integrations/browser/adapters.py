# -*- coding: utf-8 -*-
"""v1.8.0 B 域·搜索引擎适配器（实现 v1.8.0 B1：URL 模板 + 纯函数结果提取）。

v1.9.0 T02 迁移说明：本模块自 ``backend/domains/search_adapters.py`` **原样迁入**
browser/ 包（设计文档 §A2.6）——纯函数零 IO 铁律延续，代码逐字不变（仅文档中
模块名引用同步更新）。

模块职责（架构文档 §2.1 后端模块表「引擎适配器 adapters」）：
- ``build_query_url(engine, params)``：四引擎（Bing / DuckDuckGo / Baidu / Google）
  检索 URL 构造——把 ``query`` / ``site`` / ``filetype`` / ``time_range`` / ``lang`` /
  ``max_results`` 注入为各引擎识别的查询参数（参数值一律 URL 编码）；
- ``parse_results(engine, html)``：引擎结果页 HTML → 结构化结果列表，每项
  ``{title, url, snippet, position, date, domain}``（契约 §3.1 / §4.3：position
  从 1 连续、date 可 None、domain 小写无端口）；
- 未知 engine 走 generic 兜底提取器（锚点启发，不抛错）。

纯函数铁律：零 IO、零网络——本模块不 import urllib / requests、不读写文件，
domain 提取为纯字符串切片。HTML 解析仅用 stdlib ``html.parser``（项目零依赖
铁律，禁用 BeautifulSoup / lxml）。

默认引擎 Bing（§7 裁决矩阵 R1 默认分支 A）：``DEFAULT_ENGINE = 'bing'``，
``ENGINES`` 注册序亦以 Bing 居首（换引擎重试顺序同此，见 ux-flows 流程 1
engine_retry）。

HTML 树工具（``build_tree`` / ``iter_elements`` / ``element_text`` /
``select_first`` / ``norm_text``）为公开纯函数，供 ``extract`` 模块
复用——两模块均无 IO 依赖（架构 §2.1），共享工具不构成外部依赖，亦无循环
导入（extract → adapters 单向）。
"""
import re
from html.parser import HTMLParser

# ================= 引擎注册表 =================

# 合法引擎（契约 §3.1 browser_search.engine；'custom' 模板注册属 v1.8.1，
# build_query_url 收到 'custom' 按非法值抛 ValueError，由调用方转 BAD_PARAMS）
ENGINES = ('bing', 'duckduckgo', 'baidu', 'google')
DEFAULT_ENGINE = 'bing'      # §7 R1 裁决默认分支 A（产品负责人已采纳 Bing）

# time_range → 引擎时间过滤参数值（day/week/month/year）
_TIME_FILTERS = {
    'bing': {'day': 'ex1:"ez1"', 'week': 'ex1:"ez2"',
             'month': 'ex1:"ez3"', 'year': 'ex1:"ez4"'},
    'duckduckgo': {'day': 'd', 'week': 'w', 'month': 'm', 'year': 'y'},
    'google': {'day': 'd', 'week': 'w', 'month': 'm', 'year': 'y'},
    # baidu：/s 无纯 URL 时间过滤参数（需要起止时间戳），退化为按时间排序
    # rtt=1（见 build_query_url 内分支）。
}

# 各引擎时间过滤参数名（google 的值需包一层 qdr: 前缀）
_TIME_PARAM_NAMES = {'bing': 'filters', 'duckduckgo': 'df', 'google': 'tbs'}

# lang → 引擎市场/语言参数（键值对）。百度无对应参数（中文站，编码固定 utf-8）
_LANG_PARAMS = {
    'bing': {'zh': ('mkt', 'zh-CN'), 'en': ('mkt', 'en-US')},
    'duckduckgo': {'zh': ('kl', 'cn-zh'), 'en': ('kl', 'us-en')},
    'google': {'zh': ('hl', 'zh-CN'), 'en': ('hl', 'en')},
}

# 单页条数参数名与上限（DuckDuckGo HTML 端点不支持，忽略）
_MAX_RESULTS_PARAM = {
    'bing': ('count', 50),        # Bing count 上限 50
    'baidu': ('rn', 50),          # Baidu rn 常见 10/20/50
    'google': ('num', 100),       # Google num 上限 100（HTML 端点可靠区间 ≤20）
}

_ENGINE_BASE_URLS = {
    'bing': 'https://www.bing.com/search',
    'duckduckgo': 'https://duckduckgo.com/html/',
    'baidu': 'https://www.baidu.com/s',
    'google': 'https://www.google.com/search',
}


# ================= 查询 URL 构造 =================

def build_query_url(engine, params=None, fmt='html'):
    """实现 v1.8.0 B1：构造搜索引擎检索 URL（纯函数，零 IO）。

    参数注入规则（契约 §3.1 browser_search 请求字段表）：
    - ``query``（必填）：检索词；``site`` / ``filetype`` 以操作符形式拼入
      检索式（``site:github.com`` / ``filetype:pdf``），四引擎通用；
    - ``time_range``（day/week/month/year）：映射为引擎时间过滤参数——
      Bing ``filters=ex1:"ezN"`` / DuckDuckGo ``df=d|w|m|y`` /
      Google ``tbs=qdr:d|w|m|y``；百度无纯 URL 时间过滤，退化为按时间排序
      ``rtt=1``（服务层需向用户明示此退化，见回报说明）；
    - ``lang``（zh/en）：映射为引擎市场/语言参数（Bing ``mkt`` / DDG ``kl`` /
      Google ``hl``）；百度无对应参数；
    - ``max_results``：映射为引擎单页条数（Bing ``count`` / Baidu ``rn`` /
      Google ``num``，超上限夹逼）；DuckDuckGo HTML 端点不支持，忽略。
    所有参数值经 URL 编码（口径与 urllib.parse.urlencode 一致，见
    ``_urlencode_pairs``；本模块不 import urllib——纯函数铁律）。

    Args:
        engine: 引擎名，须在 ``ENGINES`` 内（大小写不敏感）。
        params: dict，可含 ``query`` / ``site`` / ``filetype`` / ``time_range``
            / ``lang`` / ``max_results``；缺省键按「不注入」处理。
        fmt: v1.9.0 M2.9 新增（kwarg 纯增，既有两参调用逐字节不变）：
            ``'html'``（缺省）= 既有 HTML 检索 URL；``'rss'`` = Bing RSS
            通道（URL 追 ``&format=rss``，4KB 量级 XML 主路径）——**仅
            bing 支持**，其余引擎抛 ValueError（调用方回落 html，不静默）。

    Returns:
        str: 完整检索 URL（含查询串，参数顺序确定，便于测试逐字节断言）。

    Raises:
        ValueError: ``engine`` 非法（含 ``'custom'``——模板注册属 v1.8.1），
            或 ``query`` 为空。两者均由调用方转换为 ``BAD_PARAMS``
            （契约 §3.1：不静默回默认，防参数幻觉被吞）。
            ``site`` / ``filetype`` / ``time_range`` / ``lang`` /
            ``max_results`` 的非法值由调用方按契约前置校验，本函数对
            缺省/无法解析的值采取忽略策略（防御性，不重复当判官）。
            ``fmt='rss'`` 且 engine 非 bing（RSS 通道引擎专属）。
    """
    eng = str(engine or '').strip().lower()
    if eng not in ENGINES:
        raise ValueError('不支持的搜索引擎: %r（合法值: %s）'
                         % (engine, '/'.join(ENGINES)))
    if str(fmt or 'html').lower() == 'rss' and eng != 'bing':
        raise ValueError('RSS 通道仅 bing 支持（%r 请用 html）' % engine)
    p = dict(params or {})
    query = str(p.get('query') or '').strip()
    if not query:
        raise ValueError('query 不能为空（browser_search 契约：1-500 字符）')

    # site/filetype 以操作符拼入检索式（site 归一：剥协议取 host，契约 §3.1）
    terms = [query]
    site = _domain_of(p.get('site'))
    if site:
        terms.append('site:%s' % site)
    filetype = str(p.get('filetype') or '').strip().lower()
    if filetype:
        terms.append('filetype:%s' % filetype)
    q = ' '.join(terms)

    time_range = str(p.get('time_range') or '').strip().lower()
    lang = str(p.get('lang') or '').strip().lower()
    try:
        max_results = int(p.get('max_results') or 0)
    except (TypeError, ValueError):
        max_results = 0

    base = _ENGINE_BASE_URLS[eng]
    args = [('q' if eng != 'baidu' else 'wd', q)]
    tf = _TIME_FILTERS.get(eng, {}).get(time_range)
    if tf:
        if eng == 'google':
            tf = 'qdr:%s' % tf
        args.append((_TIME_PARAM_NAMES[eng], tf))
    if eng == 'baidu' and time_range:
        args.append(('rtt', '1'))      # 百度时间过滤退化：按时间排序
    lp = _LANG_PARAMS.get(eng, {}).get(lang)
    if lp:
        args.append(lp)
    if eng == 'baidu':
        args.append(('ie', 'utf-8'))   # 百度输入编码固定（语言参数缺的对冲）
    mr = _MAX_RESULTS_PARAM.get(eng)
    if mr and max_results > 0:
        name, cap = mr
        value = min(max_results, cap)
        if eng == 'baidu':
            # Baidu rn 仅接受 10/20/50 三档（其他值被忽略）——向上吸附
            value = 10 if value <= 10 else (20 if value <= 20 else 50)
        args.append((name, str(value)))
    url = base + '?' + _urlencode_pairs(args)
    if str(fmt or 'html').lower() == 'rss':
        url += '&format=rss'      # M2.9：Bing RSS 通道（调用方已校验 engine=bing）
    return url


# ================= v1.9.0 M2.9：Bing RSS 解析（主通道 4KB 量级）=================
# 与 parse_results 同输出 shape（契约 §4.3）：{title,url,snippet,position,date,domain}。
# stdlib ElementTree（零依赖铁律）；容忍命名空间前缀与 dc:date；无 item/解析
# 失败 → []（调用方回落 HTML 兜底，不抛——RSS 是优化不是新故障面）。
def parse_rss(xml):
    """RSS 2.0 XML → 结果列表（与 parse_results 同 shape）。

    Args:
        xml: RSS XML 文本（bytes/str）。

    Returns:
        list: [{title, url, snippet, position, date, domain}]；空文档/解析
        失败/无 item → []（调用方回落 HTML）。
    """
    import xml.etree.ElementTree as ET
    try:
        if isinstance(xml, bytes):
            root = ET.fromstring(xml)
        else:
            root = ET.fromstring(str(xml or ''))
    except ET.ParseError:
        return []
    items = root.findall('.//item')
    out = []
    for i, it in enumerate(items, 1):
        def _text(tag):
            el = it.find(tag)
            return (el.text or '').strip() if el is not None else ''
        url = _text('link')
        if not url:
            continue                      # 无链接条目跳过（主模型引用不了）
        title = _text('title')
        desc = _text('description')
        # description 可能是 HTML 片段——剥标签取纯文本（轻量，不引 extract）
        snippet = re.sub(r'<[^>]+>', '', desc).strip()
        date_raw = _text('pubDate') or _text('{http://purl.org/dc/elements/1.1/}date')
        out.append({'title': title, 'url': url, 'snippet': snippet,
                    'position': i, 'date': _flexible_date(date_raw),
                    'domain': _domain_of(url)})
    return out


def _flexible_date(s):
    """日期归一 → 'YYYY-MM-DD'：RFC822（RSS pubDate）优先，ISO8601（dc:date）
    兜底；均失败 → None（调用方按无日期渲染，不抛）。"""
    if not s:
        return None
    import email.utils
    try:
        dt = email.utils.parsedate_to_datetime(str(s))
        return dt.strftime('%Y-%m-%d')
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        import datetime
        return datetime.date.fromisoformat(str(s).strip()[:10]).strftime('%Y-%m-%d')
    except (TypeError, ValueError):
        return None


# URL 编码安全字符（与 urllib.parse.quote 的 always_safe 口径一致）
_URL_UNSAFE = re.compile(r'[^A-Za-z0-9_.~-]')


def _quote_plus(value):
    """quote_plus 口径编码：空格 → '+'，其余非安全字符 → UTF-8 百分号编码。

    先百分号编码（空格变为 %20）再把 %20 换成 '+'——顺序不可颠倒（先替换
    会把字面 '+' 也编码成 %2B，与 urllib.parse.urlencode 输出不一致）。
    """
    text = _URL_UNSAFE.sub(
        lambda m: ''.join('%%%02X' % b for b in m.group(0).encode('utf-8')),
        str(value))
    return text.replace('%20', '+')


def _urlencode_pairs(pairs):
    """最小查询串编码（避免 import urllib——纯函数铁律，行为与 urlencode 一致）。

    测试侧用 urllib.parse.urlencode 做逐字节交叉校验（fixture 即契约）。
    """
    return '&'.join('%s=%s' % (_quote_plus(k), _quote_plus(v))
                    for k, v in pairs)


def _domain_of(url):
    """从 URL/裸域名提取 domain：小写、无协议、无路径、无 userinfo、无端口。

    纯字符串操作（不 import urllib.parse）。site 归一与结果 domain 共用。
    """
    s = str(url or '').strip().lower()
    if not s:
        return ''
    if '://' in s:
        s = s.split('://', 1)[1]
    s = s.split('/', 1)[0]
    if '@' in s:
        s = s.rsplit('@', 1)[1]
    if ':' in s:
        s = s.split(':', 1)[0]
    return s


# ================= 结果页解析（HTML → 结构化列表） =================

def parse_results(engine, html):
    """实现 v1.8.0 B1：引擎结果页 HTML → 结构化结果列表（纯函数）。

    每引擎一个提取器（Bing/DuckDuckGo/Baidu/Google），按各引擎结果页的
    仿真结构（见 tests/fixtures/v18/ 各 fixture 头部注释）提取标题、链接、
    摘要与日期；未知 engine 走 ``_parse_generic`` 锚点启发兜底。

    Args:
        engine: 引擎名（未知值走 generic 兜底，不抛错）。
        html: 结果页 HTML（str 或 bytes，bytes 按 utf-8 replace 解码）。

    Returns:
        list[dict]: 每项 ``{title, url, snippet, position, date, domain}``——
        ``position`` 从 1 连续；``date`` 为 None 表示源页无日期（契约 §4.3
        布尔/空值纪律：date 是唯一允许 null 的字段）；``domain`` 小写无端口。
        空 HTML / 无结果页 / 结构不识别一律返回 ``[]``（不抛错——提取失败
        由调用方走 engine_retry 换引擎，ux-flows 流程 1）。
    """
    eng = str(engine or '').strip().lower()
    try:
        root = build_tree(html)
        if eng == 'bing':
            raw = _parse_bing(root)
        elif eng == 'duckduckgo':
            raw = _parse_ddg(root)
        elif eng == 'baidu':
            raw = _parse_baidu(root)
        elif eng == 'google':
            raw = _parse_google(root)
        else:
            raw = _parse_generic(root)
        return [_finalize(i, item) for i, item in enumerate(raw, 1)]
    except RecursionError:
        # 病态深树（万层嵌套标签）触发递归上限：按「解析为空」返回，
        # 调用方走 engine_retry 换引擎（ux-flows 流程 1）——不把
        # RecursionError 抛进搜索管线
        return []


def _finalize(position, item):
    """(title, url, snippet, date) 四元组 → 契约结果项（补 position/domain）。"""
    title, url, snippet, date = item
    url = str(url or '').strip()
    date_text = str(date).strip() if date else ''
    return {
        'title': str(title or '').strip(),
        'url': url,
        'snippet': str(snippet or '').strip(),
        'position': position,
        'date': date_text or None,
        'domain': _domain_of(url),
    }


def _parse_bing(root):
    """Bing 提取：li.b_algo 容器 → h2 a 标题链接 / cite 展示 URL（缺失回退
    href）/ b_caption p 摘要 / 可选 b_date 日期。"""
    out = []
    for li in _find_by_class(root, 'b_algo'):
        h2 = _find_first(li, tag='h2')
        a = _find_first(h2, tag='a') if h2 is not None else None
        if a is None:
            continue
        title = element_text(a)
        href = (a.attrs.get('href') or '').strip()
        cite = _find_first(li, tag='cite')
        url = element_text(cite) if cite is not None else href
        date_el = _find_first(li, cls='b_date')
        caption = _find_first(li, cls='b_caption')
        if caption is not None:
            p = _find_first(caption, tag='p')
            skip = (date_el,) if date_el is not None else ()
            snippet = element_text(p) if p is not None \
                else element_text(caption, skip=skip)
        else:
            snippet = ''
        date = element_text(date_el) if date_el is not None else None
        if not title or not url:
            continue
        out.append((title, url, snippet, date))
    return out


def _parse_ddg(root):
    """DuckDuckGo（HTML 端点）提取：.result.results_links 容器 →
    result-body 内 h2 a.result__a 标题链接 / a.result__snippet 摘要 /
    可选 result_date 日期（仿真扩展：DDG 实际无日期，fixture 以 span 覆盖
    date 两形态契约）。"""
    out = []
    for res in _find_by_class(root, 'result'):
        if 'results_links' not in _class_list(res):
            continue
        body = _find_first(res, cls='result-body') or res
        a = _find_first(body, cls='result__a')
        snip_el = _find_first(body, cls='result__snippet')
        date_el = _find_first(body, cls='result_date')
        if a is None:
            continue
        title = element_text(a)
        url = (a.attrs.get('href') or '').strip()
        snippet = element_text(snip_el) if snip_el is not None else ''
        date = element_text(date_el) if date_el is not None else None
        if not title or not url:
            continue
        out.append((title, url, snippet, date))
    return out


def _parse_baidu(root):
    """百度提取：div.c-container 容器 → h3.t a 标题链接 /
    span.c-showurl 展示 URL（缺失回退 link href）/ div.c-abstract 摘要 /
    可选 c-date 日期。"""
    out = []
    for c in _find_by_class(root, 'c-container'):
        h3 = _find_first(c, tag='h3')
        a = _find_first(h3, tag='a') if h3 is not None else None
        if a is None:
            continue
        title = element_text(a)
        href = (a.attrs.get('href') or '').strip()
        showurl = _find_first(c, cls='c-showurl')
        url = element_text(showurl) if showurl is not None else href
        abs_el = _find_first(c, cls='c-abstract')
        date_el = _find_first(c, cls='c-date')
        snippet = element_text(abs_el) if abs_el is not None else ''
        date = element_text(date_el) if date_el is not None else None
        if not title or not url:
            continue
        out.append((title, url, snippet, date))
    return out


def _parse_google(root):
    """Google 提取：div.g 容器 → yuRUbf a h3 标题 / a href 链接 /
    VwiC3b 摘要（剔除 g-date 文本）/ 可选 g-date 日期。"""
    out = []
    for g in _find_by_class(root, 'g'):
        ru = _find_first(g, cls='yuRUbf')
        a = _find_first(ru, tag='a') if ru is not None else None
        if a is None:
            continue
        h3 = _find_first(a, tag='h3')
        title = element_text(h3) if h3 is not None else element_text(a)
        url = (a.attrs.get('href') or '').strip()
        vwi = _find_first(g, cls='VwiC3b')
        date_el = _find_first(g, cls='g-date')
        snippet = element_text(vwi, skip=(date_el,)) if vwi is not None else ''
        date = element_text(date_el) if date_el is not None else None
        if not title or not url:
            continue
        out.append((title, url, snippet, date))
    return out


# generic 兜底：跳过的导航类容器（其中的锚点不是搜索结果）
_GENERIC_SKIP_TAGS = ('nav', 'footer', 'aside')
# generic 兜底：摘要取的最近块级祖先
_GENERIC_BLOCK_TAGS = ('div', 'li', 'article', 'section', 'td', 'main')
_GENERIC_SNIPPET_MAX = 300


def _parse_generic(root):
    """generic 兜底提取（未知 engine）：锚点启发。

    规则：所有 http(s) 锚点取标题与 URL（跳过 nav/footer/aside 内的链接、
    跳过空标题），摘要取最近块级祖先的文本（剔除块内所有锚点文本）并按
    ``_GENERIC_SNIPPET_MAX`` 截断；按 URL 去重（保首条）。
    """
    out = []
    seen = set()
    for a in iter_elements(root):
        if a.tag != 'a':
            continue
        href = (a.attrs.get('href') or '').strip()
        if not href.lower().startswith(('http://', 'https://')):
            continue
        if _in_skip_tag(a):
            continue
        title = element_text(a)
        if not title or href in seen:
            continue
        seen.add(href)
        block = _nearest_block(a)
        snippet = ''
        if block is not None:
            anchors = tuple(e for e in iter_elements(block) if e.tag == 'a')
            snippet = element_text(block, skip=anchors)
        out.append((title, href, snippet[:_GENERIC_SNIPPET_MAX], None))
    return out


def _in_skip_tag(el):
    """元素是否位于导航类容器（nav/footer/aside）内。"""
    node = el.parent
    while node is not None and node.tag != '#root':
        if node.tag in _GENERIC_SKIP_TAGS:
            return True
        node = node.parent
    return False


def _nearest_block(el):
    """向上找最近的块级祖先（generic 摘要容器）。"""
    node = el.parent
    while node is not None and node.tag != '#root':
        if node.tag in _GENERIC_BLOCK_TAGS:
            return node
        node = node.parent
    return None


# ================= 共享 HTML 树工具（extract 复用） =================

# void 元素（自动闭合，无子节点）
_VOID_TAGS = frozenset((
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
    'meta', 'param', 'source', 'track', 'wbr',
))


class _Element:
    """极简 DOM 节点（stdlib html.parser 构建，零第三方依赖）。

    Attributes:
        tag: 小写标签名；``'#text'`` 表示文本节点（内容在 ``text``），
            ``'#root'`` 表示文档根。
        attrs: 属性 dict（html.parser 已做属性值实体反转义）。
        children: 子节点 list（元素与文本节点混合，保文档序）。
        parent: 父节点（根为 None）。
        text: 仅文本节点使用——原始文本片段。
    """

    __slots__ = ('tag', 'attrs', 'children', 'parent', 'text')

    def __init__(self, tag, attrs=None, text=''):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.children = []
        self.parent = None
        self.text = text


class _TreeBuilder(HTMLParser):
    """html.parser → _Element 树。

    - void 元素自动闭合；``<br>`` / ``<br/>`` 插入换行文本节点（保证段落
      内换行在文本抽取中不丢失）；
    - 容忍错配闭合标签（向上弹栈至匹配标签处），未闭合标签保持展开——
      对结构良好的结果页/文章页足够（fixture 即契约，联调期以真页面冒烟
      暴露的边界再迭代）。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Element('#root')
        self._stack = [self.root]

    def _append_element(self, tag, attrs, self_closing):
        el = _Element(tag, attrs)
        el.parent = self._stack[-1]
        self._stack[-1].children.append(el)
        if not self_closing:
            self._stack.append(el)

    def _append_text(self, text):
        if not text:
            return
        node = _Element('#text', text=text)
        node.parent = self._stack[-1]
        self._stack[-1].children.append(node)

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == 'br':
            self._append_text('\n')
            return
        self._append_element(tag, attrs, self_closing=tag in _VOID_TAGS)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if tag == 'br':
            self._append_text('\n')
            return
        self._append_element(tag, attrs, self_closing=True)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self._stack) - 1, 0, -1):
            if self._stack[i].tag == tag:
                del self._stack[i:]
                return

    def handle_data(self, data):
        self._append_text(data)


def build_tree(html):
    """实现 v1.8.0 B1：HTML 字符串 → 极简 DOM 树（纯函数）。

    文本节点 ``tag == '#text'``；元素节点 ``tag`` 为小写标签名；属性值已
    由 html.parser 实体反转义。bytes 输入按 utf-8（errors=replace）解码。
    """
    text = _decode(html)
    builder = _TreeBuilder()
    try:
        builder.feed(text)
        builder.close()
    except Exception:
        # html.parser 对病态输入理论上不抛（容错设计）；此处兜底保证
        # 「解析永不炸」的纯函数契约——返回已构建的部分树。
        pass
    return builder.root


def _decode(html):
    """bytes → utf-8 replace 解码；str 原样；None → ''。"""
    if isinstance(html, (bytes, bytearray)):
        return bytes(html).decode('utf-8', 'replace')
    return str(html or '')


def iter_elements(el):
    """实现 v1.8.0 B1：文档序迭代元素节点（不含文本节点与自身）。"""
    for child in el.children:
        if child.tag != '#text':
            yield child
            yield from iter_elements(child)


def norm_text(text):
    """实现 v1.8.0 B1：空白归一（任意空白串 → 单空格）并去首尾空白。"""
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def element_text(el, skip=()):
    """实现 v1.8.0 B1：取元素归一化文本（文档序拼接，skip 内元素子树排除）。

    Args:
        el: 元素节点（None 安全返回 ''）。
        skip: 需排除子树的元素可迭代对象（如日期 span——摘要文本不带日期）。

    Returns:
        str: 归一化文本（连续空白折叠为单空格）。
    """
    if el is None:
        return ''
    skip_ids = set(id(e) for e in skip if e is not None)
    parts = []

    def walk(node):
        if node.tag == '#text':
            parts.append(node.text)
            return
        if id(node) in skip_ids:
            return
        for child in node.children:
            walk(child)

    walk(el)
    return norm_text(''.join(parts))


def _class_list(el):
    """元素 class 属性分词（html.parser 属性值已反转义）。"""
    return (el.attrs.get('class') or '').split()


def _find_by_class(el, cls):
    """后代中所有含指定 class 的元素（文档序）。"""
    return [e for e in iter_elements(el) if cls in _class_list(e)]


def _find_first(el, tag=None, cls=None):
    """后代中首个匹配 tag/class 的元素（文档序；两者可同时给）。"""
    if el is None:
        return None
    for e in iter_elements(el):
        if tag is not None and e.tag != tag:
            continue
        if cls is not None and cls not in _class_list(e):
            continue
        return e
    return None


# CSS 选择器：单个复合选择器（tag?#id?.class*）
_SELECTOR_COMPOUND = re.compile(r'^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$')
_SELECTOR_IDENT = re.compile(r'([#.])([\w-]+)')


def _parse_compound(token):
    """解析复合选择器 → {'tag', 'id', 'classes'}；非法返回 None。"""
    if not token:
        return None
    m = _SELECTOR_COMPOUND.match(token)
    if not m:
        return None
    el_id = None
    classes = []
    for mm in _SELECTOR_IDENT.finditer(m.group(2) or ''):
        if mm.group(1) == '#':
            el_id = mm.group(2)
        else:
            classes.append(mm.group(2))
    return {'tag': (m.group(1) or '').lower() or None,
            'id': el_id, 'classes': classes}


def _parse_selector(selector):
    """选择器 → [(combinator, compound)] 序列；combinator ∈ {' ', '>'}。

    非法语法返回 None。不支持逗号分组/伪类/属性选择器（本批次契约不需要）。
    """
    tokens = str(selector or '').split()
    if not tokens:
        return None
    seq = []
    combinator = ' '
    for tok in tokens:
        if tok == '>':
            combinator = '>'
            continue
        comp = _parse_compound(tok)
        if comp is None:
            return None
        seq.append((combinator, comp))
        combinator = ' '
    return seq or None


def _match_compound(el, comp):
    """元素是否匹配单个复合选择器。"""
    if el.tag in ('#text', '#root'):
        return False
    if comp['tag'] and el.tag != comp['tag']:
        return False
    if comp['id'] is not None and (el.attrs.get('id') or '') != comp['id']:
        return False
    cls = _class_list(el)
    return all(c in cls for c in comp['classes'])


def _match_sequence(el, seq):
    """从最右复合起向左匹配（后代 ' ' 可跨任意层，子 '>' 限直接父）。"""
    combinator, comp = seq[-1]
    if not _match_compound(el, comp):
        return False
    node = el.parent
    idx = len(seq) - 2
    while node is not None and node.tag != '#root' and idx >= 0:
        combinator, comp = seq[idx]
        if combinator == '>':
            if not _match_compound(node, comp):
                return False
            idx -= 1
        elif _match_compound(node, comp):
            idx -= 1
        node = node.parent
    return idx < 0


def select_first(root, selector):
    """实现 v1.8.0 B1：CSS 选择器首个匹配元素（文档序；无匹配返回 None）。

    支持：``tag`` / ``#id`` / ``.class`` 及复合（``div#main.cls``）、
    后代（空格）与子（``>``）组合器。非法语法/无匹配均返回 None（由调用方
    决定错误语义，如 extract 的 selector_miss）。
    """
    seq = _parse_selector(selector)
    if seq is None:
        return None
    for el in iter_elements(root):
        if _match_sequence(el, seq):
            return el
    return None
