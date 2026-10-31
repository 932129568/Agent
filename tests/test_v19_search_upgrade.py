# -*- coding: utf-8 -*-
"""v1.9.0 M2.9/M2.11 搜索升级回归（design §A3.8/§A3.10）。

覆盖：Bing RSS 双通道（build_query_url fmt= kwarg 纯增/parse_rss 同 shape/
坏 XML 回落/双通道一致性 fixture）、缓存分级 TTL（classify_query_ttl 可解释
分类/条目级读写/CACHE 30→60 行为变更）、软件输出四连洗（sanitize_text
ANSI/bidi/零宽/C0 顺序固定保 \t \n 中文无损）。
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'v18')


def _fx(name):
    return io.open(os.path.join(FX, name), encoding='utf-8').read()


class TestRssUrlBuild:
    def test_bing_rss_fmt(self):
        from backend.domains.integrations.browser.adapters import build_query_url
        u = build_query_url('bing', {'query': 'Harbor 本地模型'}, fmt='rss')
        assert u.endswith('&format=rss')

    def test_non_bing_rss_rejected(self):
        from backend.domains.integrations.browser.adapters import build_query_url
        for eng in ('duckduckgo', 'baidu', 'google'):
            try:
                build_query_url(eng, {'query': 'x'}, fmt='rss')
                raise AssertionError('%s 未拒' % eng)
            except ValueError:
                pass

    def test_two_arg_call_unchanged(self):
        """既有两参调用逐字节不变（kwarg 纯增铁律）。"""
        from backend.domains.integrations.browser.adapters import build_query_url
        u = build_query_url('bing', {'query': 'x'})
        assert 'format' not in u

    def test_fmt_case_insensitive(self):
        from backend.domains.integrations.browser.adapters import build_query_url
        assert build_query_url('bing', {'query': 'x'}, fmt='RSS').endswith('format=rss')


class TestParseRss:
    def test_shape_matches_parse_results(self):
        from backend.domains.integrations.browser.adapters import parse_rss
        rs = parse_rss(_fx('bing_rss.xml'))
        assert len(rs) == 4
        first = rs[0]
        assert set(first) == {'title', 'url', 'snippet', 'position', 'date', 'domain'}
        assert first['position'] == 1
        assert first['domain'] == 'harbor.example.com'

    def test_date_from_pubdate(self):
        from backend.domains.integrations.browser.adapters import parse_rss
        rs = parse_rss(_fx('bing_rss.xml'))
        assert rs[0]['date'] == '2026-10-20'

    def test_dc_date_namespace(self):
        from backend.domains.integrations.browser.adapters import parse_rss
        rs = parse_rss(_fx('bing_rss.xml'))
        assert rs[2]['date'] == '2026-10-15'      # dc:date 命名空间容忍

    def test_bad_xml_returns_empty(self):
        from backend.domains.integrations.browser.adapters import parse_rss
        assert parse_rss('<rss><channel>未闭合') == []
        assert parse_rss('') == []
        assert parse_rss('<rss/>') == []

    def test_html_description_stripped(self):
        from backend.domains.integrations.browser.adapters import parse_rss
        rs = parse_rss('<rss><channel><item><title>t</title>'
                       '<link>https://x.com/a</link>'
                       '<description>&lt;p&gt;标签&lt;/p&gt;正文</description>'
                       '</item></channel></rss>')
        assert rs[0]['snippet'] == '标签正文'


class TestDualChannelConsistency:
    """fixture 即契约：RSS/HTML 两通道 {title,url,domain} 集合一致。"""

    def test_consistency(self):
        from backend.domains.integrations.browser.adapters import parse_rss, parse_results
        rss = {(r['title'], r['url'], r['domain'])
               for r in parse_rss(_fx('bing_rss.xml'))}
        html = {(r['title'], r['url'], r['domain'])
                for r in parse_results('bing', _fx('bing_dual.html'))}
        assert rss == html, 'RSS/HTML 双通道漂移: %s' % (rss ^ html)


class TestTtlClassify:
    def test_time_range_news(self):
        from backend.domains.integrations.browser.service import classify_query_ttl
        assert classify_query_ttl('任意词', 'day')[0] == 'news'
        assert classify_query_ttl('任意词', 'week') == ('news', 5)

    def test_news_words(self):
        from backend.domains.integrations.browser.service import classify_query_ttl
        assert classify_query_ttl('今天的新闻')[0] == 'news'
        assert classify_query_ttl('AI 快讯')[0] == 'news'
        assert classify_query_ttl('weather today')[0] == 'news'

    def test_encyclopedia_words(self):
        from backend.domains.integrations.browser.service import classify_query_ttl
        assert classify_query_ttl('量子计算是什么')[0] == 'encyclopedia'
        assert classify_query_ttl('Python 定义')[0] == 'encyclopedia'
        assert classify_query_ttl('git 与 svn 区别')[0] == 'encyclopedia'

    def test_general_default(self):
        from backend.domains.integrations.browser.service import classify_query_ttl
        assert classify_query_ttl('python 教程') == ('general', 60)
        assert classify_query_ttl('') == ('general', 60)

    def test_ttl_classes_values(self):
        from backend.domains.integrations.browser.service import TTL_CLASSES
        assert TTL_CLASSES == {'news': 5, 'general': 60, 'encyclopedia': 1440}


class TestCacheTtlBehavior:
    def _svc(self, tmpdir):
        from backend.domains.integrations.browser.service import SearchService
        return SearchService(cache_dir=os.path.join(tmpdir, 'cache'))

    def test_entry_level_ttl(self, tmp_path):
        """条目带 ttl_minutes 时按条目判定（5min 条目 10min 后过期）。"""
        svc = self._svc(str(tmp_path))
        clock = {'t': 1000.0}
        svc._clock = lambda: clock['t']
        entry = {'query': 'q', 'results': [], 'fetched_ts': clock['t'],
                 'ttl_class': 'news', 'ttl_minutes': 5}
        svc._cache_put('k1', entry, ttl_class='news', ttl_minutes=5)
        assert svc._cache_get('k1') is not None
        clock['t'] += 10 * 60            # 10 分钟后
        assert svc._cache_get('k1') is None      # news 5min 已过期

    def test_general_60_default(self, tmp_path):
        """无 ttl 字段的旧条目回落 general 60（非 30——R30 行为变更）。"""
        svc = self._svc(str(tmp_path))
        clock = {'t': 1000.0}
        svc._clock = lambda: clock['t']
        svc._cache_put('k2', {'query': 'q', 'results': [],
                              'fetched_ts': clock['t']})
        clock['t'] += 45 * 60            # 45 分钟
        assert svc._cache_get('k2') is not None   # 60min 内仍命中
        clock['t'] += 20 * 60            # 累计 65 分钟
        assert svc._cache_get('k2') is None

    def test_default_ttl_constant_60(self):
        from backend.domains.integrations.browser.service import CACHE_TTL_MINUTES
        assert CACHE_TTL_MINUTES == 60


class TestSanitize:
    def test_ansi_stripped(self):
        from backend.domains.integrations.software_service import sanitize_text
        assert sanitize_text('\x1b[31m红色\x1b[0m') == '红色'
        assert sanitize_text('\x1b]0;title\x07正文') == '正文'

    def test_bidi_stripped(self):
        from backend.domains.integrations.software_service import sanitize_text
        assert sanitize_text('a\u200eb\u202ec\u2066d') == 'abcd'

    def test_zero_width_stripped(self):
        from backend.domains.integrations.software_service import sanitize_text
        assert sanitize_text('a\u200bb\u2060c\ufeff') == 'abc'

    def test_c0_stripped_keep_tab_nl(self):
        from backend.domains.integrations.software_service import sanitize_text
        assert sanitize_text('a\x00b\x07c\x7f') == 'abc'
        assert sanitize_text('列1\t列2\n行2') == '列1\t列2\n行2'

    def test_chinese_intact(self):
        from backend.domains.integrations.software_service import sanitize_text
        s = '中文内容零损耗：标点，符号！'
        assert sanitize_text(s) == s

    def test_combined_order(self):
        from backend.domains.integrations.software_service import sanitize_text
        raw = '\x1b[1m\u200e标题\u202a\x00'
        assert sanitize_text(raw) == '标题'


class TestCacheStatsIndex:
    """统计分类索引只复用未变条目；目录实时变化仍完整可见。"""

    def _svc(self, tmp_path):
        import json
        from backend.domains.integrations.browser.service import SearchService
        cache = tmp_path / 'cache'
        svc = SearchService(cache_dir=str(cache))
        svc._cache_put('a', {'query': 'q', 'results': [], 'fetched_ts': 1},
                       ttl_class='news', ttl_minutes=5)
        return svc, cache, json

    def test_unchanged_entries_skip_json_reads(self, tmp_path, monkeypatch):
        svc, _cache, json = self._svc(tmp_path)
        first = svc.search_cache_stats()
        calls = []
        real_load = json.load
        monkeypatch.setattr(json, 'load', lambda f: calls.append(f.name) or real_load(f))
        second = svc.search_cache_stats()
        assert second == first
        assert calls == []

    def test_external_create_modify_delete(self, tmp_path, monkeypatch):
        svc, cache, json = self._svc(tmp_path)
        assert svc.search_cache_stats()['ttl_classes']['news'] == 1
        new_file = cache / 'b.json'
        new_file.write_text(json.dumps(
            {'results': [], 'ttl_class': 'encyclopedia'}), encoding='utf-8')
        assert svc.search_cache_stats()['ttl_classes']['encyclopedia'] == 1
        stat = new_file.stat()
        new_file.write_text(json.dumps(
            {'results': [], 'ttl_class': 'general', 'padding': 'changed'}), encoding='utf-8')
        os.utime(new_file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        changed = svc.search_cache_stats()
        assert changed['ttl_classes'] == {'news': 1, 'general': 1, 'encyclopedia': 0}
        new_file.unlink()
        removed = svc.search_cache_stats()
        assert removed['entries'] == 1
        assert removed['ttl_classes'] == {'news': 1, 'general': 0, 'encyclopedia': 0}

    def test_directory_switch_does_not_reuse_stale_entries(self, tmp_path):
        svc, _cache, json = self._svc(tmp_path)
        other = tmp_path / 'other'
        other.mkdir()
        (other / 'only.json').write_text(json.dumps(
            {'results': [], 'ttl_class': 'encyclopedia'}), encoding='utf-8')
        svc._cache_dir = str(other)
        stats = svc.search_cache_stats()
        assert stats['entries'] == 1
        assert stats['ttl_classes'] == {'news': 0, 'general': 0, 'encyclopedia': 1}
        assert len(svc._stats_files) == 1
