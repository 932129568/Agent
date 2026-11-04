# -*- coding: utf-8 -*-
"""v1.2「信任版」功能测试：R2 护栏 / R1 自动更新 / R6 provider / get_api_info 契约隐身。

全部打桩：urllib.urlopen / subprocess / ctypes 均不真实出网或执行系统调用。
"""
import hashlib
import io
import json
import os
import subprocess
import sys

import pytest

from conftest import HOME, NewApi, install_fake_windll, make_fake_subprocess_run, reset_home, ws

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------- 工具
class FakeHttpResponse:
    def __init__(self, body=b'', headers=None):
        self._body = body
        self.headers = headers or {}

    def read(self, *a):
        if a:  # chunked read
            b = self._body
            self._body = b''
            return b
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeHttpError(Exception):
    def __init__(self, code, body=b''):
        super().__init__('HTTP %d' % code)
        self.code = code
        self._body = body

    def read(self):
        return self._body


@pytest.fixture
def fresh_guard(tmp_path):
    from backend.domains.security.guard_service import GuardService
    return GuardService(guard_path=str(tmp_path / 'guard.json'),
                        audit_path=str(tmp_path / 'audit.jsonl'))


# ---------------------------------------------------------------- R2 护栏
class TestGuardService:
    def test_default_config_tiers(self, fresh_guard):
        cfg = json.loads(fresh_guard.get_config())
        assert cfg['tiers']['delete_path'] == 'always'
        assert cfg['tiers']['kill_process'] == 'always'
        assert cfg['tiers']['clipboard_read'] == 'session'
        assert cfg['protect_paths'] == []

    def test_check_returns_confirm_for_delete(self, fresh_guard):
        r = fresh_guard.check('delete_path', {'path': 'C:\\tmp\\a.txt'})
        assert r['action'] == 'confirm'

    def test_protect_path_blocks_delete(self, fresh_guard):
        fresh_guard.save_config(json.dumps({'protect_paths': ['C:\\Users\\*\\Documents\\**']}))
        r = fresh_guard.check('delete_path', {'path': 'C:\\Users\\me\\Documents\\secret.txt'})
        assert r['action'] == 'block'
        assert '保护名单' in r['reason']

    def test_protect_path_wildcard_subdir(self, fresh_guard):
        fresh_guard.save_config(json.dumps({'protect_paths': [os.path.join(ws(), 'sub', '**')]}))
        r = fresh_guard.check('delete_path', {'path': os.path.join(ws(), 'sub', 'deep', 'x.txt')})
        assert r['action'] == 'block'
        r2 = fresh_guard.check('delete_path', {'path': os.path.join(ws(), 'a.txt')})
        assert r2['action'] == 'confirm'   # 未命中名单 → 仍按档位（always=确认）

    def test_protect_process_blocks_kill(self, fresh_guard):
        fresh_guard.save_config(json.dumps({'protect_processes': ['notepad.exe']}))
        r = fresh_guard.check('kill_process', {'name': 'notepad.exe'})
        assert r['action'] == 'block'

    def test_builtin_protected_process_always_blocked(self, fresh_guard):
        r = fresh_guard.check('kill_process', {'name': 'lsass.exe'})
        assert r['action'] == 'block'

    def test_tier_list_allows_unmatched(self, fresh_guard):
        fresh_guard.save_config(json.dumps({
            'tiers': {'delete_path': 'list'},
            'protect_paths': ['C:\\protected\\**'],
        }))
        assert fresh_guard.check('delete_path', {'path': 'C:\\else\\x.txt'})['action'] == 'allow'
        assert fresh_guard.check('delete_path', {'path': 'C:\\protected\\x.txt'})['action'] == 'block'

    def test_tier_off_never_confirms(self, fresh_guard):
        fresh_guard.save_config(json.dumps({'tiers': {'take_screenshot': 'off'}}))
        assert fresh_guard.check('take_screenshot', {})['action'] == 'allow'

    def test_save_config_rejects_bad_tier(self, fresh_guard):
        fresh_guard.save_config(json.dumps({'tiers': {'delete_path': 'malicious'}}))
        assert json.loads(fresh_guard.get_config())['tiers']['delete_path'] == 'always'

    def test_audit_log_appended(self, fresh_guard):
        fresh_guard.audit('delete_path', {'path': 'x'}, 'decision', 'deny')
        lines = open(fresh_guard._audit_path, encoding='utf-8').read().strip().split('\n')
        entry = json.loads(lines[-1])
        assert entry['op'] == 'delete_path' and entry['decision'] == 'deny'

    def test_api_enforce_block_on_delete(self, tmp_path, monkeypatch):
        """Api.delete_path 命中保护名单时后端直接拒绝（前端被绕过也拦得住）。"""
        from backend.api import Api
        api = Api()
        api._guard._path = str(tmp_path / 'guard.json')
        api._guard._audit_path = str(tmp_path / 'audit.jsonl')
        api._guard._cfg['protect_paths'] = [os.path.join(ws(), 'sub', '**')]
        r = json.loads(api.delete_path(os.path.join(ws(), 'sub', 'b.txt')))
        assert 'error' in r and '保护名单' in r['error']
        # 未配置名单的路径不受影响（进回收站流程；send2trash 缺失时永久删除，契约归一文案）
        r2 = json.loads(api.delete_path(os.path.join(ws(), 'a.txt')))
        assert 'error' not in r2 or '保护名单' not in r2.get('error', '')

    def test_api_kill_user_protected_name(self, tmp_path, monkeypatch):
        fake_run, _ = make_fake_subprocess_run()
        monkeypatch.setattr('subprocess.run', fake_run)
        api = NewApi()
        api._guard._path = str(tmp_path / 'guard.json')
        api._guard._audit_path = str(tmp_path / 'audit.jsonl')
        api._guard._cfg['protect_processes'] = ['chrome.exe']
        r = json.loads(api.kill_process(name='chrome.exe'))
        assert '保护名单' in r.get('error', '')

    def test_guard_check_via_api(self, tmp_path):
        api = NewApi()
        api._guard._path = str(tmp_path / 'guard.json')
        api._guard._audit_path = str(tmp_path / 'audit.jsonl')
        api._guard._cfg = api._guard._load()
        r = json.loads(api.guard_check('delete_path', json.dumps({'path': 'x.txt'})))
        assert r['action'] == 'confirm'
        r2 = json.loads(api.guard_check('unknown_op', '{}'))
        assert r2['action'] == 'allow'


# ---------------------------------------------------------------- RunDeduper rem 绕过修复
class TestRunDeduperRemPrefix:
    def _mk(self):
        from backend.domains.workspace.cmd_service import RunDeduper
        return RunDeduper()

    def test_rem_prefix_variant_rejected(self):
        d = self._mk()
        assert d.check('echo hello') is None
        tip = d.check('rem echo hello')
        assert tip and ('相同' in tip or '已拦截' in tip)

    def test_colon_prefix_variant_rejected(self):
        d = self._mk()
        assert d.check('echo hello') is None
        tip = d.check(':: echo hello')
        assert tip and ('相同' in tip or '已拦截' in tip)

    def test_rem_prefix_write_variant_rejected(self):
        d = self._mk()
        assert d.check('del foo.txt') is None
        tip = d.check('rem del foo.txt')
        assert tip is not None

    def test_legit_distinct_commands_pass(self):
        d = self._mk()
        assert d.check('echo hello') is None
        assert d.check('echo world') is None
        assert d.check('dir') is None

    def test_remote_like_commands_not_stripped(self):
        d = self._mk()
        assert d.check('remote-tool status') is None
        assert d.check('remove-item x.txt') is None   # 写动词仍在，不被误剥


# ---------------------------------------------------------------- R1 自动更新
class TestUpdateService:
    def _mk(self):
        from backend.domains.integrations.update_service import UpdateService
        return UpdateService()

    def _patch_urlopen(self, monkeypatch, body, headers=None, error=None):
        import urllib.request
        if error:
            def boom(req, timeout=None):
                raise error
            monkeypatch.setattr(urllib.request, 'urlopen', boom)
        else:
            monkeypatch.setattr(urllib.request, 'urlopen',
                                lambda req, timeout=None: FakeHttpResponse(body, headers or {}))

    def test_newer_version_available(self, monkeypatch):
        from backend.domains.integrations.update_service import APP_VERSION
        manifest = json.dumps({'version': '9.9.9', 'url': 'https://x/glm.exe',
                               'sha256': 'abc', 'notes': '修复若干问题'}).encode()
        self._patch_urlopen(monkeypatch, manifest)
        r = json.loads(self._mk().check('https://x/manifest.json'))
        assert r['update_available'] is True
        assert r['latest'] == '9.9.9' and r['current'] == APP_VERSION

    def test_same_version_not_available(self, monkeypatch):
        from backend.domains.integrations.update_service import APP_VERSION
        self._patch_urlopen(monkeypatch, json.dumps({'version': APP_VERSION}).encode())
        r = json.loads(self._mk().check('https://x/manifest.json'))
        assert r['update_available'] is False

    def test_network_error_returns_error(self, monkeypatch):
        self._patch_urlopen(monkeypatch, b'', error=OSError('connection refused'))
        r = json.loads(self._mk().check('https://x/manifest.json'))
        assert 'error' in r

    def test_bad_manifest_returns_error(self, monkeypatch):
        self._patch_urlopen(monkeypatch, b'{"nope": 1}')
        r = json.loads(self._mk().check('https://x/manifest.json'))
        assert 'error' in r

    def test_download_done_with_sha256(self, monkeypatch, tmp_path):
        payload = b'FAKE-EXE-BYTES'
        sha = hashlib.sha256(payload).hexdigest()
        self._patch_urlopen(monkeypatch, payload, {'Content-Length': str(len(payload))})
        svc = self._mk()
        import backend.domains.integrations.update_service as us_mod
        monkeypatch.setattr(us_mod, 'UPDATE_DIR', str(tmp_path))
        assert json.loads(svc.start_download('https://x/glm.exe', sha, '9.9.9')).get('ok')
        svc._thread.join(timeout=10)
        st = json.loads(svc.get_progress())
        assert st['state'] == 'done' and st['pct'] == 100
        assert os.path.exists(st['path'])
        assert open(st['path'], 'rb').read() == payload

    def test_download_sha_mismatch_keeps_old_version(self, monkeypatch, tmp_path):
        payload = b'TAMPERED'
        self._patch_urlopen(monkeypatch, payload, {'Content-Length': str(len(payload))})
        svc = self._mk()
        import backend.domains.integrations.update_service as us_mod
        monkeypatch.setattr(us_mod, 'UPDATE_DIR', str(tmp_path))
        svc.start_download('https://x/glm.exe', 'deadbeef' * 8, '9.9.9')
        svc._thread.join(timeout=10)
        st = json.loads(svc.get_progress())
        assert st['state'] == 'error'
        assert 'SHA256' in st['error']
        assert not any(f.endswith('.exe') for f in os.listdir(tmp_path))   # 失败产物已清理

    def test_apply_rejected_in_dev_mode(self):
        svc = self._mk()
        svc._state['state'] = 'done'
        svc._state['path'] = __file__
        r = json.loads(svc.apply())
        assert 'error' in r and '打包版' in r['error']


# ---------------------------------------------------------------- R6 provider
class TestProviderService:
    def _mk(self):
        from backend.domains.providers.provider_service import ProviderService
        return ProviderService()

    def test_url_normalization(self):
        from backend.domains.providers.provider_service import chat_completions_url
        assert chat_completions_url('https://api.x.com/v1/') == 'https://api.x.com/v1/chat/completions'
        assert chat_completions_url('https://api.x.com/v1/chat/completions') == 'https://api.x.com/v1/chat/completions'
        assert chat_completions_url('') == ''

    def test_test_endpoint_success(self, monkeypatch):
        import urllib.request
        body = json.dumps({'choices': [{'message': {'content': 'pong'}}]}).encode()
        monkeypatch.setattr(urllib.request, 'urlopen', lambda req, timeout=None: FakeHttpResponse(body))
        r = json.loads(self._mk().test_endpoint('https://api.x.com/v1', 'sk-x', 'm1'))
        assert r['ok'] is True and r['reply'] == 'pong'

    def test_test_endpoint_401_humanized(self, monkeypatch):
        import urllib.request
        import urllib.error
        def boom(req, timeout=None):
            raise urllib.error.HTTPError('url', 401, 'Unauthorized', {}, io.BytesIO(b'{}'))
        monkeypatch.setattr(urllib.request, 'urlopen', boom)
        r = json.loads(self._mk().test_endpoint('https://api.x.com/v1', 'sk-x', 'm1'))
        assert r['ok'] is False and 'Key 无效' in r['error']

    def test_test_endpoint_1113_mapped(self, monkeypatch):
        """Round 14（2026-11-04）：1113 人话重写——实测智谱按量欠费也报 1113，
        且给出路（换免费 flash 系）。Coding Plan 分支保留（body 含 coding 特征）。"""
        import urllib.request
        import urllib.error
        body = json.dumps({'error': {'code': 1113}}).encode()
        def boom(req, timeout=None):
            raise urllib.error.HTTPError('url', 400, 'Bad Request', {}, io.BytesIO(body))
        monkeypatch.setattr(urllib.request, 'urlopen', boom)
        r = json.loads(self._mk().test_endpoint('https://api.x.com/v1', 'sk-x', 'm1'))
        assert r['ok'] is False and '1113' in r['error'] and 'glm-4.5-flash' in r['error']

        body_cp = json.dumps({'error': {'code': '1113', 'message': 'Coding Plan not allowed'}}).encode()
        def boom_cp(req, timeout=None):
            raise urllib.error.HTTPError('url', 400, 'Bad Request', {}, io.BytesIO(body_cp))
        monkeypatch.setattr(urllib.request, 'urlopen', boom_cp)
        r2 = json.loads(self._mk().test_endpoint('https://api.x.com/v1', 'sk-x', 'm1'))
        assert r2['ok'] is False and 'Coding Plan' in r2['error']

    def test_test_endpoint_missing_fields(self):
        svc = self._mk()
        assert json.loads(svc.test_endpoint('', 'k', 'm'))['error'] == '缺少 Base URL'
        assert json.loads(svc.test_endpoint('https://x', '', 'm'))['error'] == '缺少 API Key'
        assert json.loads(svc.test_endpoint('https://x', 'k', ''))['error'] == '缺少模型名'


# ---------------------------------------------------------------- 契约隐身
class TestApiInfoHidesV12Methods:
    def test_v12_methods_hidden_but_callable(self):
        api = NewApi()
        info = json.loads(api.get_api_info())
        for m in ('guard_check', 'guard_save_config', 'guard_get_config', 'guard_audit',
                  'check_update', 'start_update_download', 'get_update_progress',
                  'apply_update', 'test_provider_endpoint', 'get_audit_log'):
            assert m not in info['methods'], '新方法必须对 get_api_info 隐身: ' + m
            assert callable(getattr(api, m)), '新方法必须真实存在且可调用: ' + m


# ---------------------------------------------------------------- 审计日志查看器（PRD Q6）
class TestAuditLogViewer:
    def test_read_empty(self, fresh_guard):
        r = json.loads(fresh_guard.read_audit())
        assert r['ok'] is True and r['total'] == 0 and r['entries'] == []

    def test_read_newest_first(self, fresh_guard):
        fresh_guard.audit('delete_path', {'path': 'a.txt'}, 'decision', 'deny')
        fresh_guard.audit('take_screenshot', {}, 'check', 'confirm')
        fresh_guard.audit('kill_process', {'name': 'x.exe'}, 'decision', 'allow')
        r = json.loads(fresh_guard.read_audit())
        assert r['total'] == 3
        assert r['entries'][0]['op'] == 'kill_process'          # 倒序：最新在前
        assert r['entries'][0]['decision'] == 'allow'
        assert r['entries'][-1]['decision'] == 'deny'

    def test_read_limit_offset(self, fresh_guard):
        for i in range(5):
            fresh_guard.audit('take_screenshot', {'i': i}, 'check')
        r = json.loads(fresh_guard.read_audit(2, 1))
        assert r['total'] == 5 and len(r['entries']) == 2
        assert r['entries'][0]['detail']['i'] == '3'            # 倒序 [4,3,2,1,0] 跳过 1 条

    def test_api_get_audit_log(self, tmp_path):
        api = NewApi()
        api._guard._path = str(tmp_path / 'guard.json')
        api._guard._audit_path = str(tmp_path / 'audit.jsonl')
        api._guard._cfg = api._guard._load()
        r = json.loads(api.get_audit_log(100, 0))
        assert r['ok'] is True and r['total'] == 0
        api.guard_audit('delete_path', json.dumps({'path': 'x'}), 'deny')
        r2 = json.loads(api.get_audit_log(100, 0))
        assert r2['total'] == 1 and r2['entries'][0]['decision'] == 'deny'
