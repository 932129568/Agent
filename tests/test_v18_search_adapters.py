# -*- coding: utf-8 -*-
"""v1.8.0 B 域第一批（B1/B2 纯函数层）验收测试。

覆盖（迭代方案 L1-5「fixture 跑适配器纯函数」+ 架构 §4.3 单测层）：
- browser.adapters.build_query_url：四引擎 URL 模板、site/filetype/time_range/
  lang/max_results 注入、中文编码、非法 engine/query 抛错（→ BAD_PARAMS）；
- browser.adapters.parse_results：四引擎 fixture 解析（条数/首条字段/position
  连续/domain 提取/date 两形态/cite 与 showurl 回退）、generic 兜底、
  空 HTML/垃圾 HTML → []；
- browser.extract.extract_main_content：密度提取（正文在场、垃圾不在场）、
  选择器命中/未命中、max_chars 截断 + truncated + full_chars、bytes 输入。

铁律：全部用 tests/fixtures/v18/ 真实 fixture 文件读盘（fixture 即契约，
不用 mock HTML 字符串）；被测模块零 IO 零网络，本测试不依赖网络与窗口。
"""
import os
import urllib.parse

import pytest

from backend.domains.integrations.browser import adapters as sa
from backend.domains.integrations.browser import extract as se

FIXTURE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'v18')

RESULT_KEYS = {'title', 'url', 'snippet', 'position', 'date', 'domain'}


def _fx(name):
    """读 fixture 文件（utf-8）——fixture 即契约，测试只认落盘结构。"""
    with open(os.path.join(FIXTURE_DIR, name), encoding='utf-8') as f:
        return f.read()


def _fx_bytes(name):
    with open(os.path.join(FIXTURE_DIR, name), 'rb') as f:
        return f.read()


# ============================================================ build_query_url
class TestBuildQueryUrl:
    """B1：四引擎 URL 模板与参数注入（契约 §3.1 请求字段表）。"""

    def test_engine_registry(self):
        assert sa.ENGINES == ('bing', 'duckduckgo', 'baidu', 'google')
        assert sa.DEFAULT_ENGINE == 'bing'      # §7 R1 裁决默认分支 A

    def test_bing_basic_and_stdlib_crosscheck(self):
        url = sa.build_query_url('bing', {'query': 'python 教程'})
        assert url.startswith('https://www.bing.com/search?')
        query = urllib.parse.urlsplit(url).query
        # 与 stdlib urlencode 逐字节交叉校验（本模块手写编码器的对拍锚点）
        assert query == urllib.parse.urlencode([('q', 'python 教程')])
        assert urllib.parse.parse_qs(query)['q'] == ['python 教程']

    def test_bing_full_param_combo(self):
        url = sa.build_query_url('bing', {
            'query': 'python', 'site': 'github.com', 'filetype': 'pdf',
            'time_range': 'week', 'lang': 'zh', 'max_results': 20})
        query = urllib.parse.urlsplit(url).query
        expected = urllib.parse.urlencode([
            ('q', 'python site:github.com filetype:pdf'),
            ('filters', 'ex1:"ez2"'), ('mkt', 'zh-CN'), ('count', '20')])
        assert query == expected
        parsed = urllib.parse.parse_qs(query)
        assert parsed['filters'] == ['ex1:"ez2"']
        assert parsed['mkt'] == ['zh-CN']

    def test_bing_time_range_day_and_en(self):
        url = sa.build_query_url('bing', {
            'query': 'x', 'time_range': 'day', 'lang': 'en'})
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert parsed['filters'] == ['ex1:"ez1"']
        assert parsed['mkt'] == ['en-US']

    def test_chinese_query_percent_encoded(self):
        url = sa.build_query_url('bing', {'query': '中文 搜索'})
        assert '%E4%B8%AD%E6%96%87' in url
        assert '中' not in urllib.parse.urlsplit(url).query

    def test_site_normalization_strips_scheme_and_path(self):
        url = sa.build_query_url('bing', {
            'query': 'x', 'site': 'https://GitHub.com/explore/repo'})
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert parsed['q'] == ['x site:github.com']

    def test_duckduckgo_params(self):
        url = sa.build_query_url('duckduckgo', {
            'query': 'python', 'site': 'realpython.com', 'time_range': 'month',
            'lang': 'zh', 'max_results': 10})
        assert url.startswith('https://duckduckgo.com/html/?')
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert parsed['q'] == ['python site:realpython.com']
        assert parsed['df'] == ['m']
        assert parsed['kl'] == ['cn-zh']
        assert 'count' not in parsed       # DDG HTML 端点不支持单页条数

    def test_baidu_params(self):
        url = sa.build_query_url('baidu', {
            'query': 'python', 'time_range': 'week', 'max_results': 25})
        assert url.startswith('https://www.baidu.com/s?')
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert parsed['wd'] == ['python']
        assert parsed['ie'] == ['utf-8']
        assert parsed['rtt'] == ['1']      # 百度时间过滤退化：按时间排序
        assert parsed['rn'] == ['50']      # 25 夹逼到 50

    def test_google_params(self):
        url = sa.build_query_url('google', {
            'query': 'python', 'time_range': 'year', 'lang': 'zh',
            'max_results': 15})
        assert url.startswith('https://www.google.com/search?')
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert parsed['q'] == ['python']
        assert parsed['tbs'] == ['qdr:y']
        assert parsed['hl'] == ['zh-CN']
        assert parsed['num'] == ['15']

    def test_invalid_engine_raises(self):
        with pytest.raises(ValueError):
            sa.build_query_url('yahoo', {'query': 'x'})
        with pytest.raises(ValueError):
            sa.build_query_url('custom', {'query': 'x'})   # 模板 v1.8.1 预留

    def test_empty_query_raises(self):
        with pytest.raises(ValueError):
            sa.build_query_url('bing', {'query': '   '})
        with pytest.raises(ValueError):
            sa.build_query_url('bing', {})


# ============================================================ parse_results
class TestParseBing:
    """B1：Bing fixture 解析（契约 §3.1 结果字段 + §4.3 空值纪律）。"""

    def test_count_and_positions(self):
        results = sa.parse_results('bing', _fx('bing_results.html'))
        assert len(results) == 10          # B1 验收：fixture >=10 条
        assert [r['position'] for r in results] == list(range(1, 11))

    def test_result_shape_keys(self):
        results = sa.parse_results('bing', _fx('bing_results.html'))
        assert set(results[0].keys()) == RESULT_KEYS

    def test_first_result_fields(self):
        results = sa.parse_results('bing', _fx('bing_results.html'))
        r = results[0]
        assert r['title'] == 'Python 3 官方教程（简体中文）'
        assert r['url'] == 'https://docs.python.org/zh-cn/3/tutorial/'
        assert '官方教程中文版' in r['snippet']
        assert r['domain'] == 'docs.python.org'
        assert r['date'] is None

    def test_date_two_forms(self):
        results = sa.parse_results('bing', _fx('bing_results.html'))
        dates = [r['date'] for r in results]
        assert dates[2] == '2026-10-01'      # 有形态（第 3 条 b_date）
        assert dates.count(None) == 9        # 无形态（其余 9 条，fixture 共 10 条）

    def test_url_falls_back_to_href_without_cite(self):
        results = sa.parse_results('bing', _fx('bing_results.html'))
        # 第 5 条无 cite → url 回退 h2 a href
        assert results[4]['url'] == 'https://github.com/python/cpython'
        assert results[4]['domain'] == 'github.com'

    def test_domain_strips_port_and_lowercases(self):
        results = sa.parse_results('bing', _fx('bing_results.html'))
        assert results[5]['domain'] == 'community.example.org'
        assert ':' not in results[5]['domain']

    def test_bytes_input_equivalent(self):
        text = _fx('bing_results.html')
        assert sa.parse_results('bing', text.encode('utf-8')) == \
            sa.parse_results('bing', text)


class TestParseDuckDuckGo:
    """B1：DuckDuckGo fixture 解析。"""

    def test_count_and_first_result(self):
        results = sa.parse_results('duckduckgo', _fx('ddg_results.html'))
        assert len(results) == 5
        r = results[0]
        assert r['title'] == 'DuckDuckGo — 隐私保护的搜索引擎'
        assert r['url'] == 'https://duckduckgo.com/'
        assert '不追踪用户搜索历史' in r['snippet']
        assert r['domain'] == 'duckduckgo.com'
        assert r['position'] == 1

    def test_date_two_forms(self):
        results = sa.parse_results('duckduckgo', _fx('ddg_results.html'))
        assert results[1]['date'] == '2026-09-28'
        assert [r['date'] for r in results].count(None) == 4

    def test_positions_continuous(self):
        results = sa.parse_results('duckduckgo', _fx('ddg_results.html'))
        assert [r['position'] for r in results] == [1, 2, 3, 4, 5]


class TestParseBaidu:
    """B1：百度 fixture 解析（c-showurl 展示 URL 优先于 link href）。"""

    def test_count_and_first_result(self):
        results = sa.parse_results('baidu', _fx('baidu_results.html'))
        assert len(results) == 5
        r = results[0]
        assert r['title'] == 'Python 基础教程 - 编程学习网'
        assert r['url'] == 'https://code.example.com/python-basic'
        assert r['domain'] == 'code.example.com'
        assert '在线练习' in r['snippet']
        assert r['date'] is None

    def test_showurl_preferred_over_redirect_href(self):
        results = sa.parse_results('baidu', _fx('baidu_results.html'))
        assert all(not r['url'].startswith('http://www.baidu.com/link')
                   for r in results)

    def test_date_two_forms(self):
        results = sa.parse_results('baidu', _fx('baidu_results.html'))
        assert results[1]['date'] == '2026-10-02'
        assert [r['date'] for r in results].count(None) == 4


class TestParseGoogle:
    """B1：Google fixture 解析（VwiC3b 摘要须剔除 g-date 文本）。"""

    def test_count_and_first_result(self):
        results = sa.parse_results('google', _fx('google_results.html'))
        assert len(results) == 5
        r = results[0]
        assert r['title'] == 'Welcome to Python.org'
        assert r['url'] == 'https://www.python.org/about/'
        assert r['domain'] == 'www.python.org'   # 小写无端口（www 不剥）
        assert 'integrate systems' in r['snippet']

    def test_snippet_excludes_date_span(self):
        results = sa.parse_results('google', _fx('google_results.html'))
        r = results[1]
        assert r['date'] == '2026-09-30'
        assert r['snippet'].startswith('Python is a high-level')
        assert '2026-09-30' not in r['snippet']

    def test_date_two_forms(self):
        results = sa.parse_results('google', _fx('google_results.html'))
        assert [r['date'] for r in results].count(None) == 4


class TestParseGeneric:
    """B1：generic 兜底（未知 engine 用锚点启发，不抛错）。"""

    def test_generic_on_bing_fixture(self):
        results = sa.parse_results('yahoo', _fx('bing_results.html'))
        assert len(results) == 10
        r = results[0]
        assert r['title'] == 'Python 3 官方教程（简体中文）'
        assert r['url'] == 'https://docs.python.org/zh-cn/3/tutorial/index.html'
        assert r['snippet']          # 块级祖先文本（cite + 摘要）非空
        assert '官方教程中文版' in r['snippet']
        assert r['domain'] == 'docs.python.org'

    def test_generic_positions_continuous(self):
        results = sa.parse_results('unknown-engine', _fx('ddg_results.html'))
        assert [r['position'] for r in results] == list(range(1, 6))

    def test_generic_skips_nav_footer_anchors(self):
        html = _fx('article_page.html')
        results = sa.parse_results('', html)
        # 导航/侧栏/页脚锚点被跳过；正文 div 内无锚点 → 0 条
        assert results == []


class TestParseEdgeCases:
    """B1：空 HTML / 垃圾 HTML / 无结果页 → []（不抛错）。"""

    def test_empty_html(self):
        assert sa.parse_results('bing', '') == []

    def test_none_html(self):
        assert sa.parse_results('bing', None) == []

    def test_garbage_html(self):
        assert sa.parse_results('bing', 'not html at all <<< >>> \x00') == []

    def test_no_results_page(self):
        html = ('<html><body><div id="b_results"><p class="b_no">'
                '未找到相关结果，请尝试其他关键词。</p></div></body></html>')
        assert sa.parse_results('bing', html) == []
        assert sa.parse_results('baidu', html) == []
        assert sa.parse_results('google', html) == []


# ============================================================ extract_main_content
class TestExtractDensity:
    """B2：readability 密度路径（正文在场、导航/侧栏/页脚垃圾不在场）。"""

    def test_density_extraction(self):
        r = se.extract_main_content(_fx('article_page.html'))
        assert r['extractor'] == 'readability'
        assert r['truncated'] is False
        assert r['full_chars'] >= 800        # fixture 契约：主正文 ≥800 字
        assert len(r['content']) == r['full_chars']
        assert '文本密度衡量的是单位标签所承载的文本量' in r['content']
        assert '选择器覆盖策略作为补充' in r['content']

    def test_junk_not_in_content(self):
        content = se.extract_main_content(_fx('article_page.html'))['content']
        for junk in ('热门推荐', '广告合作', '版权所有', '友情链接', '首页'):
            assert junk not in content

    def test_paragraphs_joined_with_newline(self):
        content = se.extract_main_content(_fx('article_page.html'))['content']
        assert content.count('\n') == 6       # 7 段 → 6 个换行分隔

    def test_density_path_on_selector_fixture_matches(self):
        # 同一篇文章嵌在 #main-content 内，密度路径应提取到同一正文
        a = se.extract_main_content(_fx('article_page.html'))
        b = se.extract_main_content(_fx('article_page_selector.html'))
        assert a['content'] == b['content']


class TestExtractSelector:
    """B2：选择器覆盖路径（命中 / 未命中信号）。"""

    def test_selector_hit(self):
        r = se.extract_main_content(
            _fx('article_page_selector.html'), selector='#main-content')
        assert r['extractor'] == 'selector'
        assert r['truncated'] is False
        assert '文本密度衡量的是单位标签所承载的文本量' in r['content']
        assert '热门推荐' not in r['content']
        assert '版权所有' not in r['content']

    def test_selector_compound_and_descendant(self):
        html = _fx('article_page_selector.html')
        by_id = se.extract_main_content(html, selector='#main-content')
        by_compound = se.extract_main_content(html, selector='div#main-content')
        by_class = se.extract_main_content(html, selector='.article-body')
        assert by_id['content'] == by_compound['content'] == by_class['content']

    def test_selector_miss_signal(self):
        r = se.extract_main_content(
            _fx('article_page_selector.html'), selector='#no-such-id')
        assert r == {'content': '', 'truncated': False,
                     'extractor': 'selector_miss', 'full_chars': 0}

    def test_invalid_selector_syntax_miss(self):
        r = se.extract_main_content(_fx('article_page.html'), selector='!!!')
        assert r['extractor'] == 'selector_miss'


class TestExtractTruncation:
    """B2：max_chars 截断 + truncated + full_chars（toolcache 决策输入）。"""

    def test_truncation(self):
        full = se.extract_main_content(_fx('article_page.html'),
                                       max_chars=100000)
        r = se.extract_main_content(_fx('article_page.html'), max_chars=200)
        assert r['truncated'] is True
        assert len(r['content']) == 200
        assert r['full_chars'] == full['full_chars'] >= 800
        assert full['truncated'] is False

    def test_boundary_not_truncated(self):
        full = se.extract_main_content(_fx('article_page.html'),
                                       max_chars=100000)
        r = se.extract_main_content(_fx('article_page.html'),
                                    max_chars=full['full_chars'])
        assert r['truncated'] is False
        assert r['content'] == full['content']

    def test_selector_miss_ignores_max_chars(self):
        r = se.extract_main_content(_fx('article_page.html'),
                                    selector='#nope', max_chars=10)
        assert r['content'] == '' and r['full_chars'] == 0

    def test_bytes_input(self):
        raw = _fx_bytes('article_page.html')
        assert se.extract_main_content(raw) == \
            se.extract_main_content(raw.decode('utf-8'))

    def test_empty_html_empty_content(self):
        r = se.extract_main_content('')
        assert r['content'] == ''
        assert r['full_chars'] == 0
        assert r['truncated'] is False
