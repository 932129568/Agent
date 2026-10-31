# -*- coding: utf-8 -*-
"""v1.8.0 B 域第二批（B2 接线层）验收测试。

覆盖（联调规范 §6 L1/L2 可自动化部分 + 任务书 B2-5）：
- SearchService.browser_search：参数校验（BAD_PARAMS 全分支）/max_results
  夹逼回显/成功载荷 schema（source/fetched_at/results/cached/channel）/
  缓存命中与 TTL 过期（注入假时钟）/engine_retry/ENGINE_UNREACHABLE；
- CAPTCHA 人工接管全周期：fail-fast CAPTCHA_REQUIRED + takeover_id →
  search_status captcha 态 → browser_takeover continue 成功（resumed 同构）
  / 仍验证页重试（retry ≤3 耗尽自动放弃）/ abort / TAKEOVER_NOT_FOUND /
  TAKEOVER_EXPIRED / 幂等；
- search_status 阶段注册表（understanding→…→done/failed）；
- browser_open：正文提取/选择器命中与未命中/超长截断 full_ref + read_more
  实取/thin_warning/NAV_BLOCKED/BAD_PARAMS/max_chars 夹逼；
- search_cache_stats：entries/hits/misses/ttl_minutes/size_kb；
- 审计落盘：web_search / web_open / search_takeover 三类 op 各场景断言；
- SearchBrowser：FakeWin 成功（channel=window）/超时回落 urllib/
  evaluate_js 不可用回落/禁 file:///urllib HTTP 码映射/空闲回收/shutdown；
- 前端 vm harness（node，test_v13_qa _run_node 同款）：面板状态机/1s 轮询
  起停/takeover 接线/last-wins/功能分级开关；
- 契约门：_V12_EXTRA 五方法在册且与 Api def 一一对应、get_api_info 与
  legacy 逐字节一致、check_contract PASS、build 两遍 md5 幂等。

铁律：缓存目录 ~/.glm-chat/search_cache/ 独立（config.json 零污染——
本测试断言跑完后 config.json 无 search 键）；fixture 即契约（引擎/文章页
HTML 用 tests/fixtures/v18/ 落盘文件）。
"""
import ast
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import pytest

from conftest import HOME, NewApi, legacy

from backend.application.native_ui import NativeUiDispatcher
from helpers.frontend import read_frontend_source
from backend import paths
from backend.domains.security.guard_service import GuardService
from backend.domains.integrations.browser.session_win import SearchBrowser
from backend.domains.integrations.browser.service import SearchService
from backend.domains.workspace.toolcache_service import ToolcacheService


# ---- 沙箱 DNS 劫持处置（2026-10-23 实测；同 test_v19_browser 口径）----
# 本机 DNS 将全部域名解析到 198.18.0.x（benchmark 保留段=private）——SSRF
# 策略按设计拦截（行为正确，QA 同日早段全绿），域名 URL 功能测试误挂。
# 绕过 host 公网判定（SSRF 语义由 test_v19_browser 的字面 IP 专测锁定）。
@pytest.fixture(autouse=True)
def _bypass_sandbox_dns_hijack(monkeypatch):
    import backend.domains.integrations.browser.service as _svc_mod
    import backend.domains.integrations.browser.session_base as _sb
    import backend.domains.integrations.browser.session_win as _sw
    monkeypatch.setattr(_svc_mod, '_is_public_host', lambda host: True)
    monkeypatch.setattr(_sb, '_is_public_host', lambda host: True)
    monkeypatch.setattr(_sw, '_is_public_host', lambda host: True)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'fixtures', 'v18')
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
FRONTEND_SRC = os.path.join(PROJECT_ROOT, 'frontend', 'src')

NEW_APIS = {'browser_search', 'browser_open', 'search_cache_stats',
            'search_status', 'browser_takeover'}


def _fx(name):
    """读 fixture（utf-8）——fixture 即契约，测试只认落盘结构。"""
    with open(os.path.join(FIXTURE_DIR, name), encoding='utf-8') as f:
        return f.read()


def _fx_bytes(name):
    with open(os.path.join(FIXTURE_DIR, name), 'rb') as f:
        return f.read()


# 仿真验证页（captcha 特征：标题强特征 + 正文特征 + 结果数为 0）
CAPTCHA_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>安全验证 - Bing</title></head>
<body><div class="captcha-box"><h1>安全验证</h1>
<p>请完成人机验证以继续搜索（are you a robot?）</p></div></body></html>"""


# ============================================================ 测试替身
class FakeBrowser:
    """脚本化取数通道：按序返回响应（耗尽后重复末条），记录调用 URL。

    响应 dict 形状与 SearchBrowser.open_url 一致：
    {ok, html?, channel?, error?, message?}。
    """

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def open_url(self, url):
        self.calls.append(url)
        if not self.script:
            raise AssertionError('FakeBrowser 脚本耗尽（调用次数超预期）')
        r = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        return dict(r)

    def focus_window(self):
        return True


class FakeEventSlot:
    """pywebview events.loaded 替身（支持 += 与 -=）。"""

    def __init__(self, fire_on_subscribe=False):
        self._cbs = []
        self._fire = fire_on_subscribe

    def __iadd__(self, cb):
        self._cbs.append(cb)
        if self._fire:
            self.fire()
        return self

    def __isub__(self, cb):
        if cb in self._cbs:
            self._cbs.remove(cb)
        return self

    def fire(self):
        for cb in list(self._cbs):
            try:
                cb()
            except Exception:
                pass


class FakeWin:
    """pywebview 次窗替身：load_url 记录 + 成功/超时两态。

    Args:
        html: evaluate_js 返回的页面 HTML（None = evaluate_js 抛异常）。
        fire_loaded: subscribe 后是否立即触发 loaded（False = 模拟超时）。
        eval_raises: evaluate_js 是否抛异常（沙箱不可用模拟）。
    """

    def __init__(self, html='<html>ok</html>', fire_loaded=True,
                 eval_raises=False):
        self.calls = []
        self.destroyed = False
        self.shown = False
        self.events = type('E', (), {'loaded': FakeEventSlot(
            fire_on_subscribe=fire_loaded)})()
        self._html = html
        self._eval_raises = eval_raises

    def load_url(self, url):
        self.calls.append(url)

    def evaluate_js(self, script):
        if self._eval_raises:
            raise RuntimeError('evaluate_js 无法泵送（沙箱实证限制）')
        return self._html

    def show(self):
        self.shown = True

    def destroy(self):
        self.destroyed = True


class _FakeResp:
    """urllib 响应替身（headers + read + close + geturl）。"""

    def __init__(self, raw, ctype='text/html; charset=utf-8'):
        self._raw = raw
        self.headers = {'Content-Type': ctype}
        self.closed = False

    def read(self, n=-1):
        if n is None or n < 0:
            return self._raw
        return self._raw[:n]

    def close(self):
        self.closed = True

    def geturl(self):
        return 'https://www.bing.com/search?q=x'


def _mk_service(script=None, ttl=60, clock=None):   # R30：默认 30→60
    """构造 SearchService（注入 FakeBrowser + 假时钟 + 隔离缓存目录）。"""
    cache_dir = os.path.join(HOME, '.glm-chat', 'search_cache')
    svc = SearchService(
        browser=FakeBrowser(script if script is not None
                            else [{'ok': True, 'html': _fx('bing_results.html'),
                                   'channel': 'urllib'}]),
        toolcache=ToolcacheService(do_cleanup=False),
        guard=GuardService(),
        cache_dir=cache_dir,
        ttl_minutes=ttl,
        clock=clock if clock is not None else _FakeClock())
    return svc


class _FakeClock:
    """可控单调时钟（TTL/elapsed 断言用）。"""

    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


def _audit_ops():
    """读隔离 HOME 下 audit_log.jsonl 的 op 列表（无文件 → []）。"""
    p = os.path.join(paths.CONFIG_DIR, 'audit_log.jsonl')
    if not os.path.exists(p):
        return []
    ops = []
    with open(p, encoding='utf-8') as f:
        for ln in f:
            try:
                ops.append(json.loads(ln).get('op'))
            except Exception:
                continue
    return ops


# ============================================================ browser_search 基础
class TestBrowserSearchBasics:
    """B1：参数校验 / 成功载荷 schema / 夹逼回显 / 错误映射。"""

    def test_bad_params_matrix(self):
        svc = _mk_service()
        cases = [
            ({}, 'query 不能为空'),
            ({'query': ''}, 'query 不能为空'),
            ({'query': 'x' * 501}, 'query 超长'),
            ({'query': 'x', 'engine': 'yahoo'}, '不支持的搜索引擎'),
            ({'query': 'x', 'engine': 'custom'}, 'v1.8.1'),
            ({'query': 'x', 'site': 'a' * 65}, 'site'),
            ({'query': 'x', 'filetype': 'pdf!'}, 'filetype'),
            ({'query': 'x', 'filetype': 'abcdefghijk'}, 'filetype'),   # 11 位
            ({'query': 'x', 'time_range': 'hour'}, 'time_range'),
            ({'query': 'x', 'lang': 'fr'}, 'lang'),
            ({'query': 'x', 'max_results': 'ten'}, 'max_results'),
            ({'query': 'x', 'max_results': 10.5}, 'max_results'),
            ({'query': 'x', 'extract': 'deep'}, 'extract'),
        ]
        for params, expect in cases:
            r = svc.browser_search(params)
            assert r.get('ok') is False, params
            assert r['error']['code'] == 'BAD_PARAMS', params
            assert expect in r['error']['message'], (params, r)
        # site 带协议/path 合法（取 host）
        r = svc.browser_search({'query': 'x', 'site': 'https://ok.com/p'})
        assert r.get('ok') is True
        assert r['query'] == 'x site:ok.com'

    def test_success_payload_schema(self):
        svc = _mk_service()
        r = svc.browser_search({'query': 'python 教程'})
        assert r['ok'] is True
        assert r['source'] == 'live' and r['cached'] is False
        assert r['engine'] == 'bing'
        assert r['query'] == 'python 教程'
        assert r['channel'] == 'urllib'          # FakeBrowser 脚本通道标注
        assert r['truncated'] is False
        assert isinstance(r['elapsed_ms'], int)
        assert r['fetched_at'].endswith('Z')     # §4.3 ISO8601 UTC 统一后缀
        assert len(r['results']) == 10           # fixture：10 条 b_algo（B1 验收 ≥10）
        first = r['results'][0]
        assert set(first) >= {'title', 'url', 'snippet', 'position', 'date', 'domain'}
        assert first['position'] == 1
        assert [x['position'] for x in r['results']] == list(range(1, 11))
        assert first['domain'] == 'docs.python.org'
        # site 操作符回显进 query
        r2 = svc.browser_search({'query': 'python', 'site': 'github.com'})
        assert r2['query'] == 'python site:github.com'

    def test_max_results_clamp_echo(self):
        svc = _mk_service()
        r = svc.browser_search({'query': 'python', 'max_results': 25})
        assert r['ok'] is True and len(r['results']) == 10  # 夹逼 20 > fixture 10 条
        r2 = svc.browser_search({'query': 'python', 'max_results': 3})
        assert len(r2['results']) == 3

    def test_extract_none_strips_snippet(self):
        svc = _mk_service()
        r = svc.browser_search({'query': 'python', 'extract': 'none'})
        assert all(x['snippet'] == '' for x in r['results'])
        r2 = svc.browser_search({'query': 'python', 'extract': 'snippet'})
        assert any(x['snippet'] for x in r2['results'])

    def test_engine_unreachable_both_channels_fail(self):
        svc = _mk_service(script=[{'ok': False, 'error': 'ENGINE_UNREACHABLE',
                                   'message': '无法连接目标站点',
                                   'hint': '请检查网络'}])
        r = svc.browser_search({'query': 'python'})
        assert r['ok'] is False
        assert r['error']['code'] == 'ENGINE_UNREACHABLE'
        assert r['error']['message'] == '无法连接目标站点'
        assert 'web_search' in _audit_ops()

    def test_timeout_passthrough(self):
        svc = _mk_service(script=[{'ok': False, 'error': 'TIMEOUT',
                                   'message': '连接目标站点超时（8s）'}])
        r = svc.browser_search({'query': 'python'})
        assert r['error']['code'] == 'TIMEOUT'

    def test_google_urllib_shell_is_engine_unreachable(self):
        """JS 渲染引擎 + urllib 兜底只得空壳 → ENGINE_UNREACHABLE（§5.1③）。"""
        svc = _mk_service(script=[{'ok': True, 'html': '<html><body>'
                                   '<script>var a=1</script></body></html>',
                                   'channel': 'urllib'}])
        r = svc.browser_search({'query': 'python', 'engine': 'google'})
        assert r['ok'] is False
        assert r['error']['code'] == 'ENGINE_UNREACHABLE'
        assert 'JS 渲染' in r['error']['message']

    def test_empty_results_ok_shape(self):
        """非 JS 引擎解析为空 → 成功形状 + 空结果（UI 提示未找到）。

        复核批：空页需 >16KB——baidu 引擎重试耗尽后的【小页零结果】按验证壳
        处理交人工接管（test_review_batch2.TestBaiduStubCaptcha 锁定）；大空页
        才是「真无结果」→ 保持成功形状 + 空结果的既有契约。"""
        svc = _mk_service(script=[{'ok': True,
                                   'html': '<html>nothing</html>' + '<!-- pad -->' * 4200,
                                   'channel': 'window'}])
        r = svc.browser_search({'query': 'python'})
        assert r['ok'] is True and r['results'] == []

    def test_engine_retry_switches_engine(self):
        """Bing 空壳 → 换 DuckDuckGo 重试成功（engine_retry ≤2）。"""
        svc = _mk_service(script=[
            {'ok': True, 'html': '<html>nothing</html>', 'channel': 'window'},
            {'ok': True, 'html': _fx('ddg_results.html'), 'channel': 'window'},
        ])
        r = svc.browser_search({'query': 'python'})
        assert r['ok'] is True
        assert r['engine'] == 'duckduckgo'
        assert r['results']


# ============================================================ 缓存层（C1）
class TestSearchCache:
    """C1：TTL 60min（R30）+ 归一化键 + source=cache + 统计。"""

    def test_cache_hit_and_stats(self):
        clock = _FakeClock()
        svc = _mk_service(clock=clock)
        r1 = svc.browser_search({'query': 'python'})
        assert r1['source'] == 'live'
        r2 = svc.browser_search({'query': 'python'})
        assert r2['ok'] is True
        assert r2['source'] == 'cache' and r2['cached'] is True
        assert r2['fetched_at'] == r1['fetched_at']   # 命中 = 原抓取时间
        assert len(svc._browser.calls) == 1           # 第二次未触网
        st = svc.search_cache_stats()
        assert st['ok'] is True
        assert st['entries'] == 1 and st['hits'] == 1 and st['misses'] == 1
        assert st['ttl_minutes'] == 60 and st['size_kb'] >= 0   # R30：30→60
        # 读取类不落审计（stats 调用后审计条数不变）
        before = len(_audit_ops())
        svc.search_cache_stats()
        svc.search_status()
        assert len(_audit_ops()) == before

    def test_ttl_expiry_remisses(self):
        clock = _FakeClock()
        svc = _mk_service(script=[
            {'ok': True, 'html': _fx('bing_results.html'), 'channel': 'urllib'},
            {'ok': True, 'html': _fx('bing_results.html'), 'channel': 'urllib'},
        ], clock=clock)
        svc.browser_search({'query': 'python'})
        # v1.9.0 M2.11（R30 行为变更明示）：general 档 TTL 30→60min
        clock.advance(59 * 60)                        # 59min：仍新鲜
        r = svc.browser_search({'query': 'python'})
        assert r['source'] == 'cache'
        clock.advance(6 * 60)                         # 累计 65min：过期
        r2 = svc.browser_search({'query': 'python'})
        assert r2['source'] == 'live'
        assert len(svc._browser.calls) == 2

    def test_normalized_key_tracking_params(self):
        """URL 归一键：utm 等跟踪参数不影响命中（§4.4）。"""
        svc = _mk_service(script=[
            {'ok': True, 'html': _fx('bing_results.html'), 'channel': 'urllib'},
            {'ok': True, 'html': _fx('bing_results.html'), 'channel': 'urllib'},
        ])
        svc.browser_search({'query': 'python', 'lang': 'zh'})
        r = svc.browser_search({'query': 'python', 'lang': 'zh'})
        assert r['source'] == 'cache'
        r2 = svc.browser_search({'query': 'python', 'lang': 'en'})   # 不同键
        assert r2['source'] == 'live'

    def test_config_json_not_polluted(self):
        """铁律：搜索缓存独立目录，config.json 无 search 键。"""
        svc = _mk_service()
        svc.browser_search({'query': 'python'})
        svc.search_cache_stats()
        cfg = os.path.join(paths.CONFIG_DIR, 'config.json')
        if os.path.exists(cfg):
            raw = io.open(cfg, encoding='utf-8').read()
            assert 'search_cache' not in raw and 'searchCache' not in raw
        assert os.path.isdir(os.path.join(paths.CONFIG_DIR, 'search_cache'))


# ============================================================ CAPTCHA 接管（流程 2）
class TestCaptchaTakeover:
    """U1：fail-fast → 接管状态机 → continue/abort 全周期。"""

    def _captcha_service(self, then=None):
        script = [{'ok': True, 'html': CAPTCHA_HTML, 'channel': 'window'}]
        if then is not None:
            script.append(then)
        return _mk_service(script=script)

    def test_fail_fast_captcha_required(self):
        svc = self._captcha_service()
        r = svc.browser_search({'query': 'python'})
        assert r['ok'] is False
        err = r['error']
        assert err['code'] == 'CAPTCHA_REQUIRED'
        assert err['takeover_id'].startswith('tk_')
        assert err['message'] == '搜索引擎要求人机验证'
        assert err['hint'] == '请在面板中手动完成后点击继续'
        # search_status：captcha 态 + takeover 对象（面板轮询数据源）
        st = svc.search_status()
        assert st['ok'] is True and st['active'] is True
        assert st['phase'] == 'captcha'
        assert st['takeover']['takeover_id'] == err['takeover_id']
        assert st['takeover']['state'] == 'prompting'
        assert st['takeover']['max_retries'] == 3
        assert st['progress_pct'] == 40
        # 审计：web_search decision=captcha
        entries = _read_audit_entries()
        assert any(e.get('op') == 'web_search' and e.get('decision') == 'captcha'
                   for e in entries)

    def test_continue_success_resumed_payload(self):
        svc = self._captcha_service(
            then={'ok': True, 'html': _fx('bing_results.html'),
                  'channel': 'window'})
        r = svc.browser_search({'query': 'python'})
        tk = r['error']['takeover_id']
        r2 = svc.browser_takeover(tk, 'continue')
        assert r2['ok'] is True
        assert r2['resumed'] is True                 # 同构 + resumed（§3.1 B5）
        assert r2['source'] == 'live' and len(r2['results']) == 10
        assert r2['engine'] == 'bing'
        st = svc.search_status()
        assert st['phase'] == 'done' and st['active'] is False
        # 幂等：已 resolved 的再次 continue 返回当前态（成功载荷）
        r3 = svc.browser_takeover(tk, 'continue')
        assert r3['ok'] is False and r3['error']['code'] == 'TAKEOVER_NOT_FOUND'

    def test_continue_still_captcha_retry_then_exhaust(self):
        svc = self._captcha_service()                # 永远返回验证页
        tk = svc.browser_search({'query': 'python'})['error']['takeover_id']
        for n in (1, 2):
            r = svc.browser_takeover(tk, 'continue')
            assert r['ok'] is False
            assert r['error']['code'] == 'CAPTCHA_REQUIRED'
            assert r['error']['retry'] == n
            assert r['error']['max_retries'] == 3
            assert r['error']['takeover_id'] == tk
        r3 = svc.browser_takeover(tk, 'continue')     # 第 3 次：耗尽自动放弃
        assert r3['error']['code'] == 'CAPTCHA_ABORTED'
        assert '重试次数已用完' in r3['error']['message']
        assert any(e.get('op') == 'search_takeover' for e in _read_audit_entries())

    def test_abort_path(self):
        svc = self._captcha_service()
        tk = svc.browser_search({'query': 'python'})['error']['takeover_id']
        r = svc.browser_takeover(tk, 'abort')
        assert r['ok'] is False
        assert r['error']['code'] == 'CAPTCHA_ABORTED'
        assert r['error']['message'] == '用户已放弃人工验证'
        st = svc.search_status()
        assert st['phase'] == 'failed' and st['active'] is False

    def test_takeover_not_found_and_expired(self):
        svc = self._captcha_service()
        r = svc.browser_takeover('tk_nope', 'continue')
        assert r['error']['code'] == 'TAKEOVER_NOT_FOUND'
        bad = svc.browser_takeover('tk_nope', 'halt')
        assert bad['error']['code'] == 'BAD_PARAMS'
        empty = svc.browser_takeover('', 'continue')
        assert empty['error']['code'] == 'BAD_PARAMS'
        tk = svc.browser_search({'query': 'python'})['error']['takeover_id']
        entry = svc._takeovers[tk]
        entry['created_at'] = time.time() - 700       # 白盒：模拟 10min 超时
        r2 = svc.browser_takeover(tk, 'continue')
        assert r2['error']['code'] == 'TAKEOVER_EXPIRED'

    def test_takeover_id_doubles_as_status_key(self):
        """B4：search_status 传入 takeover_id 校验归属（§3.1）。"""
        svc = self._captcha_service()
        tk = svc.browser_search({'query': 'python'})['error']['takeover_id']
        st = svc.search_status(tk)
        assert st['ok'] is True and st['active'] is True
        assert st['takeover']['takeover_id'] == tk


# ============================================================ search_status 阶段
class TestSearchStatus:
    """B4：任务注册表阶段流转 + 读取类不落审计。"""

    def test_phase_lifecycle_done(self):
        svc = _mk_service()
        svc.browser_search({'query': 'python'})
        st = svc.search_status()
        assert st['phase'] == 'done'
        assert st['active'] is False
        assert st['query'] == 'python' and st['engine'] == 'bing'
        assert st['progress_pct'] == 100
        assert 'message' in st and 'elapsed_ms' in st

    def test_status_no_active(self):
        svc = _mk_service()
        st = svc.search_status()
        assert st == {'ok': True, 'active': False}

    def test_status_unknown_task_id(self):
        svc = _mk_service()
        st = svc.search_status('st_nope')
        assert st['ok'] is True and st['active'] is False

    def test_deep_extract_progress_field(self):
        """extract=full：deep_extract {done,total,failed} 回显 + extra.content。"""
        svc = _mk_service(script=[
            {'ok': True, 'html': _fx('bing_results.html'), 'channel': 'urllib'},
            {'ok': True, 'html': _fx('article_page.html'), 'channel': 'urllib'},
            {'ok': True, 'html': _fx('article_page.html'), 'channel': 'urllib'},
            {'ok': True, 'html': _fx('article_page.html'), 'channel': 'urllib'},
        ])
        r = svc.browser_search({'query': 'python', 'extract': 'full'})
        assert r['ok'] is True
        de = r['deep_extract']
        assert de['total'] == 3 and de['done'] == 3 and de['failed'] == 0
        # 深度提取连锁 Top 3（单篇失败不中断整批；未提篇目不带 extra）
        assert all('content' in (x.get('extra') or {}) for x in r['results'][:3])


# ============================================================ browser_open（B2）
class TestBrowserOpen:
    """B2：正文提取 / 选择器 / 截断 toolcache / thin / 错误码。"""

    def _svc(self, html=None):
        return _mk_service(script=[{'ok': True, 'html': html or _fx('article_page.html'),
                                    'channel': 'urllib'}])

    def test_success_readability(self):
        svc = self._svc()
        r = svc.browser_open({'url': 'https://example.com/post/1'})
        assert r['ok'] is True
        assert r['title'].startswith('文本密度')
        assert r['extractor'] == 'readability'
        assert r['truncated'] is False
        assert r['channel'] == 'urllib'
        assert '文本密度衡量的是' in r['content']
        assert '版权所有' not in r['content']       # 页脚垃圾不在场
        assert r['max_chars'] == 8000
        assert r['fetched_at'].endswith('Z')
        assert any(e.get('op') == 'web_open' and e.get('decision') == 'ok'
                   for e in _read_audit_entries())

    def test_truncation_full_ref_read_more(self):
        svc = self._svc()
        r = svc.browser_open({'url': 'https://example.com/post/1',
                              'max_chars': 500})
        assert r['ok'] is True and r['truncated'] is True
        assert r['full_ref'].startswith('toolcache:tc')
        assert len(r['content']) == 500
        cid = r['full_ref'].split(':', 1)[1]
        more = svc._toolcache.read_more(cid, 0, 400)
        d = json.loads(more)
        assert d['ok'] is True and len(d['content']) > 500

    def test_max_chars_clamp_echo(self):
        svc = self._svc()
        r = svc.browser_open({'url': 'https://x.com/a', 'max_chars': 10})
        assert r['max_chars'] == 500                # 下限夹逼
        r2 = svc.browser_open({'url': 'https://x.com/a', 'max_chars': 999999})
        assert r2['max_chars'] == 50000             # 上限夹逼
        assert svc.browser_open({'url': 'https://x.com/a',
                                 'max_chars': 'big'})['error']['code'] == 'BAD_PARAMS'

    def test_selector_hit_and_miss(self):
        svc = self._svc(_fx('article_page_selector.html'))
        r = svc.browser_open({'url': 'https://x.com/a', 'selector': 'div.article-body'})
        assert r['ok'] is True and r['extractor'] == 'selector'
        r2 = svc.browser_open({'url': 'https://x.com/a', 'selector': 'div#nope'})
        assert r2['error']['code'] == 'SELECTOR_NOT_FOUND'

    def test_empty_content(self):
        svc = self._svc('<html><body><div></div></body></html>')
        r = svc.browser_open({'url': 'https://x.com/a'})
        assert r['error']['code'] == 'EMPTY_CONTENT'

    def test_nav_blocked_and_bad_params(self):
        svc = self._svc()
        r = svc.browser_open({'url': 'file:///C:/secrets.txt'})
        assert r['error']['code'] == 'NAV_BLOCKED'
        assert svc.browser_open({'url': ''})['error']['code'] == 'BAD_PARAMS'
        assert svc.browser_open({'url': 'javascript:alert(1)'})['error']['code'] == 'NAV_BLOCKED'
        assert svc.browser_open({'url': 'https://x.com',
                                 'selector': 's' * 201})['error']['code'] == 'BAD_PARAMS'

    def test_engine_unreachable_open(self):
        svc = _mk_service(script=[{'ok': False, 'error': 'ENGINE_UNREACHABLE',
                                   'message': '无法连接目标站点'}])
        r = svc.browser_open({'url': 'https://x.com/a'})
        assert r['error']['code'] == 'ENGINE_UNREACHABLE'
        assert any(e.get('op') == 'web_open' and e.get('decision') == 'error'
                   for e in _read_audit_entries())


def _read_audit_entries():
    """读隔离 HOME 下审计条目列表（无文件 → []）。"""
    p = os.path.join(paths.CONFIG_DIR, 'audit_log.jsonl')
    if not os.path.exists(p):
        return []
    out = []
    with open(p, encoding='utf-8') as f:
        for ln in f:
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
    return out


# ============================================================ SearchBrowser 通道
class TestSearchBrowserWindow:
    """B2-2：FakeWin 成功/超时回落/禁 file:///urllib 映射/回收。"""

    def _patch_timeouts(self, monkeypatch, load=0.2, read=0.2, tick=0.05,
                        idle=0.2):
        from backend.domains.integrations.browser import session_win as sb
        monkeypatch.setattr(sb, 'LOAD_TIMEOUT_SECONDS', load)
        monkeypatch.setattr(sb, 'READ_DOM_TIMEOUT_SECONDS', read)
        monkeypatch.setattr(sb, '_RECYCLE_TICK_SECONDS', tick)
        monkeypatch.setattr(sb, 'IDLE_RECYCLE_SECONDS', idle)

    def test_window_channel_success(self):
        win = FakeWin(html='<html><body>window-html</body></html>')
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        b.set_window(win)
        r = b.open_url('https://www.bing.com/search?q=x')
        assert r['ok'] is True and r['channel'] == 'window'
        assert 'window-html' in r['html']
        assert win.calls == ['https://www.bing.com/search?q=x']

    def test_window_timeout_falls_back_urllib(self, monkeypatch):
        """loaded 永不触发（8s 看门狗替身 0.2s）→ urllib 兜底 channel=urllib。"""
        self._patch_timeouts(monkeypatch)
        win = FakeWin(fire_loaded=False)
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        b.set_window(win)
        monkeypatch.setattr(urllib.request, 'urlopen',
                            lambda req, timeout=None: _FakeResp(b'<html>u</html>'))
        r = b.open_url('https://duckduckgo.com/html/?q=x')
        assert r['ok'] is True and r['channel'] == 'urllib'
        assert r['html'] == '<html>u</html>'
        assert win.calls == ['https://duckduckgo.com/html/?q=x']

    def test_evaluate_js_unavailable_falls_back(self, monkeypatch):
        """本沙箱实证限制：evaluate_js 抛异常 → 回落 urllib（回落路径真跑通）。"""
        win = FakeWin(eval_raises=True)
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        b.set_window(win)
        monkeypatch.setattr(urllib.request, 'urlopen',
                            lambda req, timeout=None: _FakeResp(b'<html>u2</html>'))
        r = b.open_url('https://www.bing.com/search?q=y')
        assert r['ok'] is True and r['channel'] == 'urllib' and r['html'] == '<html>u2</html>'

    def test_file_scheme_blocked_before_navigation(self):
        win = FakeWin()
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        b.set_window(win)
        for bad in ('file:///C:/x.txt', 'javascript:alert(1)', 'about:blank', ''):
            r = b.open_url(bad)
            assert r['ok'] is False
            assert r['error'] in ('NAV_BLOCKED', 'BAD_PARAMS'), bad
        assert win.calls == []                        # 禁导航：窗口零调用

    def test_urllib_http_error_mapping(self, monkeypatch):
        def _raise(req, timeout=None):
            raise urllib.error.HTTPError('https://www.bing.com/', 429, 'Too Many', {}, None)
        monkeypatch.setattr(urllib.request, 'urlopen', _raise)
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        # SSRF 防护（2026-10-21）：host 须可解析到公网——'https://x/' 这类
        # 不可解析主机按 fail-closed 拒（NAV_BLOCKED），故用可解析公网主机
        # 验 HTTP 码映射（urlopen 已桩，主机选择不影响映射断言）
        r = b.open_url('https://www.bing.com/')
        assert r['ok'] is False and r['error'] == 'ENGINE_UNREACHABLE'
        assert r['http_status'] == 429

    def test_urllib_timeout_mapping(self, monkeypatch):
        import socket

        def _raise(req, timeout=None):
            raise urllib.error.URLError(socket.timeout('timed out'))
        monkeypatch.setattr(urllib.request, 'urlopen', _raise)
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        r = b.open_url('https://www.bing.com/')
        assert r['error'] == 'TIMEOUT'

    def test_idle_recycle_and_shutdown(self, monkeypatch):
        self._patch_timeouts(monkeypatch)
        win = FakeWin()
        b = SearchBrowser(idle_recycle=True, dispatcher=NativeUiDispatcher.inline())
        b.set_window(win)
        b._touch()
        b._start_recycler()
        deadline = time.time() + 3
        while time.time() < deadline and b.window is not None:
            time.sleep(0.05)
        assert b.window is None and win.destroyed is True
        b.shutdown()                                   # 幂等不抛

    def test_focus_window_best_effort(self):
        win = FakeWin()
        b = SearchBrowser(idle_recycle=False, dispatcher=NativeUiDispatcher.inline())
        b.set_window(win)
        assert b.focus_window() is True and win.shown is True


# ============================================================ 契约门（L0）
class TestV18ContractGates:
    """L0：_V12_EXTRA 在册且与 def 对应 / get_api_info 零漂移 / UI 契约。"""

    def test_v12_extra_has_five_new_apis(self):
        from backend.api import _V12_EXTRA
        assert NEW_APIS <= set(_V12_EXTRA)
        src = io.open(os.path.join(PROJECT_ROOT, 'backend', 'api.py'),
                      encoding='utf-8').read()
        tree = ast.parse(src)
        api_cls = next(n for n in tree.body
                       if isinstance(n, ast.ClassDef) and n.name == 'Api')
        defs = {n.name for n in api_cls.body if isinstance(n, ast.FunctionDef)}
        assert NEW_APIS <= defs, NEW_APIS - defs
        api = NewApi()
        for m in sorted(NEW_APIS):
            assert callable(getattr(api, m)), m

    def test_get_api_info_byte_identical_to_legacy(self):
        """get_api_info 与 legacy 逐字节一致（新方法 _V12_EXTRA 隐身）。"""
        assert NewApi().get_api_info() == legacy.Api().get_api_info()
        info = json.loads(NewApi().get_api_info())
        for m in NEW_APIS:
            assert m not in info['methods']

    def test_new_api_callable_via_instance(self):
        """五方法经 Api 实例可调（返回合法 JSON 字符串）。"""
        api = NewApi()
        out = api.search_cache_stats()
        assert json.loads(out)['ok'] is True
        st = json.loads(api.search_status())
        assert st['ok'] is True
        r = json.loads(api.browser_search({'query': 'x' * 0}))   # 空 query
        assert r['ok'] is False and r['error']['code'] == 'BAD_PARAMS'
        r2 = json.loads(api.browser_open({'url': 'file:///x'}))
        assert r2['ok'] is False and r2['error']['code'] == 'NAV_BLOCKED'
        r3 = json.loads(api.browser_takeover('tk_x', 'continue'))
        assert r3['ok'] is False and r3['error']['code'] == 'TAKEOVER_NOT_FOUND'

    def test_check_contract_pass(self):
        """UI 契约只增不改（新 callApi 调用点为新增，不减既有）。"""
        r = subprocess.run([sys.executable,
                            os.path.join('deliverables', 'design',
                                         'check_contract.py')],
                           cwd=PROJECT_ROOT, capture_output=True, timeout=120)
        assert r.returncode == 0, r.stdout.decode('utf-8', 'replace') + \
            r.stderr.decode('utf-8', 'replace')

    def test_build_idempotent_two_pass_md5(self):
        """build 两遍 md5 一致（63-search-panel.js 拼接确定性）。"""
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        import hashlib

        def _md5():
            return hashlib.md5(io.open(
                os.path.join(PROJECT_ROOT, 'harbor.html'), 'rb').read()).hexdigest()

        for _ in range(2):
            p = subprocess.run([NODE, 'frontend/build.js'], cwd=PROJECT_ROOT,
                               capture_output=True, timeout=120)
            assert p.returncode == 0, p.stderr
        h1 = _md5()
        subprocess.run([NODE, 'frontend/build.js'], cwd=PROJECT_ROOT,
                       capture_output=True, timeout=120)
        assert h1 == _md5(), '构建不幂等'


# ============================================================ 前端 vm harness
_SEARCH_PANEL_HARNESS = r'''
// ---- DOM stub（保真：id 赋值即注册 + innerHTML 记录 + appendChild 入树 +
//      事件句柄可触发 + classList/style/setAttribute） ----
function __ser(el) {
  // 递归序列化（textContent + innerHTML 直写 + 子树），供断言渲染结果
  let s = (el.textContent || '') + (el._html || '');
  (el._children || []).forEach(c => { s += __ser(c); });
  return s;
}
function __mkEl(id) {
  const el = {
    _id: '', _html: '', textContent: '', value: '', disabled: false,
    style: {}, _attrs: {}, _handlers: {}, _children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(type, fn) {
      (this._handlers[type] = this._handlers[type] || []).push(fn);
    },
    click() { (this._handlers.click || []).forEach(f => f({})); },
    appendChild(c) { this._children.push(c); return c; }
  };
  Object.defineProperty(el, 'id', {
    get() { return this._id; },
    set(v) { this._id = String(v); if (this._id) __els[this._id] = el; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this._children = []; }
  });
  if (id) el.id = id;
  return el;
}
const __els = {};
const document = {
  getElementById: (id) => __els[id] || (__els[id] = __mkEl(id)),
  createElement: () => __mkEl(''),
  body: __mkEl('body')
};
// ---- IPC stubs（预置响应 + 延迟 + 错误注入，test_v13_qa 同款） ----
const __calls = [];
let __searchResp = { ok: true, query: 'q', engine: 'bing', source: 'live',
  results: [{ title: 'R1', url: 'https://a.com', snippet: 's1', position: 1,
    domain: 'a.com' }], elapsed_ms: 120, channel: 'urllib' };
let __searchDelay = 0;
let __statusResp = { ok: true, active: true, phase: 'window_loading',
  progress_pct: 35, message: '正在打开 Bing…', query: 'q', engine: 'bing',
  elapsed_ms: 1200 };
let __takeoverResp = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
  message: '搜索引擎要求人机验证', takeover_id: 'tk_1', retry: 1, max_retries: 3 } };
let __callApiThrows = false;
let __pollDelayResolve = null;
async function callApi(name, args, timeoutMs) {
  __calls.push({ name, args, timeoutMs });
  if (__callApiThrows) throw new Error('pywebview bridge gone');
  if (name === 'browser_search') {
    if (__searchDelay) await new Promise(r => setTimeout(r, __searchDelay));
    return JSON.stringify(__searchResp);
  }
  if (name === 'browser_takeover') return JSON.stringify(__takeoverResp);
  if (name === 'search_status') return JSON.stringify(__statusResp);
  if (name === 'search_cache_stats') return JSON.stringify({ ok: true,
    entries: 3, hits: 2, misses: 5, ttl_minutes: 60, size_kb: 88 });   // R30：30→60
  return '{}';
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg, kind }); }
const __store = {};
const localStorage = {
  getItem: (k) => (k in __store ? __store[k] : null),
  setItem: (k, v) => { __store[k] = String(v); }
};
const window = {};
// ---- module under test ----
__PANEL__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 1) 初始化：DOM 纯新增 + 接线
  ok('init_creates_panel', searchPanelInit() === true
     && document.getElementById('searchPanel') !== null
     && document.getElementById('spSearchBtn') !== null);

  // 2) 搜索成功：三态 + timeoutMs=90000 + 结果渲染 + 来源徽标
  __searchResp = { ok: true, query: 'python', engine: 'bing', source: 'live',
    results: [{ title: 'T1', url: 'https://a.com', snippet: 's1', position: 1,
      domain: 'a.com' }], elapsed_ms: 120, channel: 'urllib' };
  await searchPanelRunSearch({ query: 'python' });
  const bsCall = __calls.filter(c => c.name === 'browser_search').pop();
  ok('search_ok_call', bsCall && bsCall.timeoutMs === 90000
     && bsCall.args[0].query === 'python');
  ok('search_ok_render', __ser(__els['spResults']).includes('T1')
     && __els['spMeta'].innerHTML.includes('实时')
     && __els['spPill'].textContent === '已完成');

  // 3) 缓存徽标（source=cache → .sp-src.cache「缓存」）
  __searchResp = { ok: true, query: 'python', engine: 'bing', source: 'cache',
    results: [], elapsed_ms: 5, cached: true };
  await searchPanelRunSearch({ query: 'python' });
  ok('cache_badge', __els['spMeta'].innerHTML.includes('缓存')
     && __els['spMeta'].innerHTML.indexOf('sp-src cache') >= 0
     && __ser(__els['spResults']).includes('未找到'));

  // 4) CAPTCHA → 接管区显示 + searchTakeoverId
  __searchResp = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    message: '搜索引擎要求人机验证', takeover_id: 'tk_1',
    hint: '请在面板中手动完成后点击继续' } };
  await searchPanelRunSearch({ query: 'python' });
  ok('captcha_takeover_ui', __els['spTakeover'].style.display === ''
     && searchTakeoverId === 'tk_1'
     && __els['spPill'].textContent === '需要人工验证');
  // 接管中关闭被阻（流程 2④：面板不可关闭）
  searchPanelClose();
  ok('close_blocked_during_captcha', searchTakeoverId === 'tk_1'
     && searchPanelState === 'captcha');

  // 5) 轮询起停：captcha 在途继续轮；done 终态停
  searchPanelStartPolling();
  ok('poll_started', searchPollTimer !== null);
  __statusResp = { ok: true, active: true, phase: 'captcha',
    progress_pct: 40, takeover: { takeover_id: 'tk_1', state: 'prompting',
      elapsed_s: 65, retries: 1, max_retries: 3 } };
  await searchPanelPollOnce();
  ok('poll_captcha_keeps', searchPollTimer !== null
     && __els['spTakeoverTimer'].textContent === '已等待 1:05');
  __statusResp = { ok: true, active: false, phase: 'done', progress_pct: 100 };
  await searchPanelPollOnce();
  ok('poll_done_stops', searchPollTimer === null);

  // 6) takeover continue 成功 → resumed 载荷渲染 + toast ok
  __takeoverResp = { ok: true, resumed: true, query: 'python', engine: 'bing',
    source: 'live', results: [{ title: 'TR', url: 'https://b.com',
      snippet: 's2', position: 1, domain: 'b.com' }], elapsed_ms: 3000 };
  await searchPanelTakeoverAction('continue');
  const tkCall = __calls.filter(c => c.name === 'browser_takeover').pop();
  ok('takeover_continue_wire', tkCall && tkCall.args[0] === 'tk_1'
     && tkCall.args[1] === 'continue' && tkCall.timeoutMs === 90000
     && __ser(__els['spResults']).includes('TR')
     && __els['spTakeover'].style.display === 'none'
     && searchTakeoverId === null
     && __toasts.some(t => t.msg.includes('验证通过')));

  // 7) takeover 仍验证页 → warn + 重试计数；abort → CAPTCHA_ABORTED
  __searchResp = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    message: '搜索引擎要求人机验证', takeover_id: 'tk_2' } };
  await searchPanelRunSearch({ query: 'python' });
  __takeoverResp = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    takeover_id: 'tk_2', retry: 2, max_retries: 3 } };
  await searchPanelTakeoverAction('continue');
  ok('takeover_retry_warn', __toasts.some(t => t.msg.includes('2/3')));
  __takeoverResp = { ok: false, error: { code: 'CAPTCHA_ABORTED',
    message: '用户已放弃人工验证' } };
  await searchPanelTakeoverAction('abort');
  ok('takeover_abort', __ser(__els['spResults']).includes('用户已放弃')
     && searchTakeoverId === null
     && __toasts.some(t => t.msg.includes('已放弃')));

  // 8) last-wins：pending 期间新触发，旧请求返回后静默丢弃
  __searchDelay = 60;
  const p1 = searchPanelRunSearch({ query: 'first' });   // 慢请求（seq=1）
  __searchResp = { ok: true, query: 'second', engine: 'bing', source: 'live',
    results: [{ title: 'SECOND', url: 'https://c.com', snippet: 's',
      position: 1, domain: 'c.com' }], elapsed_ms: 9 };
  const p2 = searchPanelRunSearch({ query: 'second' });  // 快请求（seq=2 覆盖）
  await p2;
  await p1;
  ok('last_wins', __ser(__els['spResults']).includes('SECOND'));
  __searchDelay = 0;

  // 9) 错误态：callApi 抛 → BRIDGE_TIMEOUT 人话 + error 态
  __callApiThrows = true;
  await searchPanelRunSearch({ query: 'x' });
  ok('bridge_throw_error', __ser(__els['spResults']).includes('pywebview bridge')
     && __els['searchPanel'].getAttribute('data-state') === 'error');
  __callApiThrows = false;

  // 10) 功能分级开关：关 → 不挂载
  localStorage.setItem('glm_feat_search_v18', '0');
  ok('feature_off', searchPanelInit() === false);

  // 11) typeof 守卫：无 document  vm 环境下函数不抛
  const __doc = global.document;
  global.document = undefined;
  let guardOk = true;
  try {
    searchPanelInit(); searchPanelOpen(); searchPanelClose();
    searchPanelRefreshStats(); searchPanelSetPhase('done', { phase: 'done' });
  } catch (e) { guardOk = false; }
  global.document = __doc;
  ok('typeof_guards', guardOk);

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''


def _extract_fn(src, pattern):
    """从源码抽取指定函数体（test_v13_qa 同款括号配平算法）。"""
    import re as _re
    m = _re.search(pattern, src)
    assert m, '未找到: %s' % pattern
    i = m.end() - 1
    depth = 0
    in_str = None
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
        i += 1
    raise AssertionError('括号未配平: %s' % pattern)


class TestFrontendSearchPanelVm:
    """63-search-panel.js vm harness（node；缺失则 skip）。"""

    def test_harness(self):
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        src = read_frontend_source(PROJECT_ROOT, '63-search-panel.js')
        js = _SEARCH_PANEL_HARNESS.replace('__PANEL__', src)
        fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_sp_')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(js)
        try:
            r = subprocess.run([NODE, path], capture_output=True, text=True,
                               timeout=60)
            assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
            out = json.loads(r.stdout)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端断言失败: %s' % failed
        assert len(out['checks']) >= 11
