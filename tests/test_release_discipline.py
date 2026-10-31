# -*- coding: utf-8 -*-
"""M1.10 版本纪律回归（master-plan：v1.8.0 tag 曾带 VERSION=1.7.0 出货的教训）。

锁定：VERSION 文件 / update_service 回退常量 / APP_VERSION 运行时值 / tag
比较语义 / API_VERSION 红线 / config.json 版本零污染。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestVersionFile:
    def test_version_file_semver(self):
        with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
            v = f.read().strip()
        parts = v.split('.')
        assert len(parts) == 3 and all(p.isdigit() for p in parts), v

    def test_version_is_19(self):
        """v19 开发线：VERSION 应为 1.9.0（M1.10 bump）。"""
        with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
            assert f.read().strip() == '1.9.0'


class TestFallbackConstant:
    def test_fallback_matches_file(self):
        """回退常量与 VERSION 文件同步（bump 时两边核对——建议㉕ 纪律）。"""
        import re
        with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
            v_file = f.read().strip()
        src = open(os.path.join(ROOT, 'backend', 'domains', 'integrations', 'update_service.py'),
                   encoding='utf-8').read()
        m = re.search(r"return '([0-9]+\.[0-9]+\.[0-9]+[^']*)'", src)
        assert m and m.group(1) == v_file

    def test_app_version_runtime(self):
        from backend.domains.integrations.update_service import APP_VERSION
        with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
            assert APP_VERSION == f.read().strip()

    def test_api_version_redline(self):
        """js_api 契约版本红线：v1.0.0 永不动。"""
        from backend.api import API_VERSION
        assert API_VERSION == 'v1.0.0'


class TestCheckReleaseTool:
    def test_vt_tuple(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import check_release as cr
        assert cr._vt('1.9.0') == (1, 9, 0)
        assert cr._vt('1.8') == (1, 8, 0)
        assert cr._vt('v1.10.2') == (1, 10, 2)
        assert cr._vt('1.9.0') > cr._vt('1.8.0')      # 开发推进方向
        assert cr._vt('1.8.0') < cr._vt('1.9.0')

    def test_dev_mode_passes(self):
        """开发模式（VERSION>tag）全过——exit 0。"""
        import subprocess
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'tools', 'check_release.py'),
             '--expect', '1.9.0'],
            capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stdout + r.stderr
        assert '发布纪律断言全过' in r.stdout

    def test_wrong_expect_fails(self):
        """expect 与文件不符 → exit 1（R1 抓脱钩）。"""
        import subprocess
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'tools', 'check_release.py'),
             '--expect', '9.9.9'],
            capture_output=True, text=True, timeout=120)
        assert r.returncode == 1
        assert 'R1' in r.stdout

    def test_tag_now_mode_strict(self):
        """--tag-now：VERSION≠最新 tag → 拒（防 tag 与文件脱钩出货）。"""
        import subprocess
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'tools', 'check_release.py'),
             '--expect', '1.9.0', '--tag-now'],
            capture_output=True, text=True, timeout=120)
        assert r.returncode == 1
        assert '--tag-now' in r.stdout

    def test_config_json_no_version_key(self):
        """R6：config.json 无版本键（版本单一数据源纪律）。"""
        from backend.domains.settings.config_service import ConfigService
        cfg = json.loads(ConfigService().get_config())
        assert 'version' not in cfg and 'app_version' not in cfg


class TestV19Placeholders:
    """M1.9：9 个 v19 新 js_api 占位（先登记后实现，防契约漂移）。"""

    NINE = ('browser_navigate', 'browser_extract', 'browser_click', 'browser_fill',
            'browser_screenshot', 'browser_close', 'get_platform_info',
            'guard_approval_budget', 'search_reader_stats')

    def test_all_registered_stealth(self):
        from backend.api import _V12_EXTRA
        for m in self.NINE:
            assert m in _V12_EXTRA, m

    def test_placeholders_not_in_contract(self, fresh_home):
        from backend.api import Api
        info = json.loads(Api().get_api_info())
        for m in self.NINE:
            assert m not in info['methods'], m

    def test_placeholder_shape(self, fresh_home):
        """M1.9 占位契约终态：九方法全部转正（browser×6 于 M3/M5、
        get_platform_info 于 M6.10、guard_approval_budget/search_reader_stats
        于 M2）——正向断言不再返回 NOT_IMPLEMENTED（占位期契约已履行完毕）。"""
        from backend.api import Api
        api = Api()
        r = json.loads(api.get_platform_info())
        assert r['ok'] is True
        assert 'error' not in r or r.get('error', {}).get('code') != 'NOT_IMPLEMENTED'
        # 六 browser 原语同样不得再返回 NOT_IMPLEMENTED（M3/M5 转正）
        for method, args in (('browser_extract', ()),
                             ('browser_click', ('#x',)),
                             ('browser_close', ())):
            rr = json.loads(getattr(api, method)(*args))
            if rr.get('ok') is False:
                assert (rr.get('error') or {}).get('code') != 'NOT_IMPLEMENTED', method

    def test_browser_six_promoted_m3(self, fresh_home):
        """M3/M5 转正：六浏览器原语不再返回 NOT_IMPLEMENTED（实现体转正，
        _V12_EXTRA 登记不动——占位契约「转正只改实现体」的正向断言）。"""
        from backend.api import Api
        api = Api()
        for method, args in (('browser_extract', ()),
                             ('browser_click', ('#x',)),
                             ('browser_fill', ('#x', 't')),
                             ('browser_screenshot', ()),
                             ('browser_close', ())):
            r = json.loads(getattr(api, method)(*args))
            assert r.get('ok') is not None
            if r.get('ok') is False:
                code = (r.get('error') or {}).get('code')
                assert code != 'NOT_IMPLEMENTED', method
        # navigate 走 SSRF/通道真实路径（不含 NOT_IMPLEMENTED）
        r = json.loads(api.browser_navigate('https://x.com', timeout=1))
        assert (r.get('error') or {}).get('code') != 'NOT_IMPLEMENTED' \
            if r.get('ok') is False else True

    def test_checkpoint_three_not_placeholdered(self, fresh_home):
        """checkpoint 三兄弟是 v1.8 已交付项——不得返回 NOT_IMPLEMENTED。"""
        from backend.api import Api
        api = Api()
        r = json.loads(api.checkpoint_list())
        assert 'error' not in r or r.get('error', {}).get('code') != 'NOT_IMPLEMENTED'
