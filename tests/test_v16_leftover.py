# -*- coding: utf-8 -*-
"""v1.6 遗留项回归测试（实现 v1.6 遗留 L1/L2）

L1 错误人话校准：fixture 用主理人 2026-10-19 **真机探测取证**的原始错误体：
  DeepSeek 401: {"error":{"message":"Authentication Fails, Your api key:
                ****e000 is invalid (request_id: 37dfc259-...)","type":"authentication_error"}}
  GLM 401:      {"error":{"code":"1000","message":"身份验证失败。"}}
L2 catalog 双路径：catalog 结构不符/网络失败 → fallback OpenAI 标准清单
  {object:'list', data:[{id}]}；双败才降级。
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from helpers.frontend import frontend_node_map, read_frontend_source

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')

DS_401_BODY = ('HTTP 401: {"error": {"message": "Authentication Fails, Your api key: '
               '****e000 is invalid (request_id: 37dfc259-2d35-4936-a395-9e429fd58377)", '
               '"type": "authentication_error", "param": null, '
               '"code": "invalid_request_error"}}')
GLM_401_BODY = 'HTTP 401: {"error": {"code": "1000", "message": "身份验证失败。"}}'

_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
const __sand = { console: console, setTimeout: function(fn){ return 0; },
  clearTimeout: function(){}, JSON: JSON, parseInt: parseInt };
__sand.window = __sand;
function __ctx() { return __vm.createContext(__sand); }
function __run(ctx, code) { __vm.runInContext(code, ctx, { timeout: 30000 }); }
const __SRC = %r;
const __MANIFEST = %r;
function __fe(name){
  const relative = __MANIFEST[name] || name;
  return __fs.readFileSync(__SRC + '/' + relative, 'utf8');
}
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)


def _run_node(body, name):
    if not os.path.exists(NODE):
        pytest.skip('node 不可用')
    js = _JS_PRELUDE + body + """
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_leftover_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([NODE, path], capture_output=True, timeout=60)
        if p.returncode != 0:
            raise AssertionError('node 脚本失败: %s' % (p.stderr.decode('utf-8', 'replace')[-1500:],))
        out = p.stdout.decode('utf-8', 'replace').strip()
        return json.loads(out) if out else None
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


class TestL1AuthHumanize:
    """humanizeAuthError 真错误体校准（前端 76-cost-estimate.js，vm 跑真实源码）。"""

    @staticmethod
    def _humanize(msg, is_local):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx();
  __run(ctx, __fe('76-cost-estimate.js'));
  return ctx.humanizeApiError(%s, %s, null);
}
""" % (json.dumps(msg), 'true' if is_local else 'false'), 'humanize')
        return res

    def test_deepseek_401_with_request_id(self):
        out = self._humanize(DS_401_BODY, False)
        assert 'DeepSeek' in out and '无效' in out, out
        assert 'request_id: 37dfc259-2d35-4936-a395-9e429fd58377' in out, out

    def test_glm_401_chinese_code1000(self):
        out = self._humanize(GLM_401_BODY, False)
        assert 'GLM' in out and '1000' in out, out

    def test_plain_401_still_generic(self):
        out = self._humanize('HTTP 401: Unauthorized', False)
        assert 'API Key 无效或未授权' in out, out

    def test_local_mode_401_unaffected(self):
        out = self._humanize(DS_401_BODY, True)
        assert '本地' in out, out   # local 模式优先本地表（免 Key 提示）

    def test_403_404_untouched(self):
        assert '无权访问' in self._humanize('HTTP 403: forbidden', False)
        assert '端点地址不存在' in self._humanize('HTTP 404: not found', False)

    def test_source_has_l1_marker(self):
        src = read_frontend_source(PROJECT_ROOT, '76-cost-estimate.js')
        assert '实现 v1.6 遗留 L1' in src and 'humanizeAuthError' in src


class TestL2CatalogFallback:
    """github_catalog_models 双路径（local_model_service.py，mock urlopen）。"""

    @staticmethod
    def _svc():
        from backend.domains.providers import local_model_service as svc
        return svc

    def test_catalog_primary_ok(self, monkeypatch):
        svc = self._svc()
        payload = json.dumps({'models': [
            {'id': 'openai/gpt-4o', 'name': 'GPT-4o', 'context_window': 128000,
             'modalities': ['text', 'image']}]}).encode()

        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=None): return payload

        monkeypatch.setattr(svc, 'urlopen_no_redirect', lambda req, timeout=None: FakeResp())
        out = svc.github_catalog_models('https://models.github.ai/inference', api_key='k')
        assert out['ok'] and out['models'][0]['id'] == 'openai/gpt-4o'
        assert out['models'][0]['ctx_window'] == 128000
        assert out['models'][0]['modalities'] == ['text', 'image']

    def test_fallback_to_models_list(self, monkeypatch):
        """catalog 结构不符（中间设备 4 字节 OK）→ fallback /models OpenAI 清单。"""
        svc = self._svc()
        calls = {'n': 0}

        class OkResp:   # 假 catalog：4 字节 OK（真机取证形态）
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=None): return b'OK'

        class ListResp:  # OpenAI 标准清单
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=None):
                return json.dumps({'object': 'list', 'data': [
                    {'id': 'openai/gpt-4o-mini', 'object': 'model'},
                    {'id': 'deepseek-ai/DeepSeek-R1'}]}).encode()

        def fake_open(req, timeout=None):
            calls['n'] += 1
            return OkResp() if calls['n'] == 1 else ListResp()

        monkeypatch.setattr(svc, 'urlopen_no_redirect', fake_open)
        out = svc.github_catalog_models('https://models.github.ai/inference', api_key='k')
        assert out['ok'], out
        ids = [m['id'] for m in out['models']]
        assert ids == ['openai/gpt-4o-mini', 'deepseek-ai/DeepSeek-R1'], ids
        assert calls['n'] == 2   # 确实走了两条路径

    def test_both_fail_401_message(self, monkeypatch):
        import urllib.error
        svc = self._svc()

        def fake_open(req, timeout=None):
            # fp 须为文件对象：bytes 会让 addinfourl(_TemporaryFileCloser) 在 GC 时
            # close() 炸 AttributeError（PytestUnraisableExceptionWarning 实证来源）
            raise urllib.error.HTTPError(req.full_url, 401, 'Unauthorized', {}, io.BytesIO(b'{}'))

        monkeypatch.setattr(svc, 'urlopen_no_redirect', fake_open)
        out = svc.github_catalog_models('https://models.github.ai/inference', api_key='bad')
        assert not out['ok'] and 'models:read' in out['error'], out

    def test_both_fail_empty_structure(self, monkeypatch):
        svc = self._svc()

        class EmptyResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=None): return json.dumps({'models': []}).encode()

        monkeypatch.setattr(svc, 'urlopen_no_redirect', lambda req, timeout=None: EmptyResp())
        out = svc.github_catalog_models('https://models.github.ai/inference')
        assert not out['ok'] and '手动输入' in out['error'], out

    def test_bare_names_kept_in_fallback(self, monkeypatch):
        """fallback 路径保留裸名（catalog 严格过滤 '/'，清单路径宽松，有胜于无）。"""
        svc = self._svc()

        class OkResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=None): return b'OK'

        class ListResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=None):
                return json.dumps({'data': [{'id': 'gpt-4o'}]}).encode()

        calls = {'n': 0}

        def fake_open(req, timeout=None):
            calls['n'] += 1
            return OkResp() if calls['n'] == 1 else ListResp()

        monkeypatch.setattr(svc, 'urlopen_no_redirect', fake_open)
        out = svc.github_catalog_models('https://models.github.ai/inference')
        assert out['ok'] and out['models'][0]['id'] == 'gpt-4o', out
