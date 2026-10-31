# -*- coding: utf-8 -*-
"""v1.6 T2 GitHub Models 目录探测回归实证（补派任务）。

路线：**延展既有 local_models js_api**（方案 §2.2「零新 js_api 优先」）——
local_model_service.models() 内按 host 分流（models.github.ai → catalog 分支），
输出契约与 OpenAI /models 路径一致（{ok, models:[{id, ctx_window, ...}]}），
前端零感知；get_api_info 零漂移（无新 js_api）。

覆盖（无外网，全 mock）：
- catalog 响应解析（provider/model 格式过滤 / ctx 别名 / modalities）
- 401/403 scope 人话 / 429 限流人话 / 结构异常 / 空目录
- 非 GitHub host 行为零回归（旧 OpenAI 解析路径）
- js_api 层（api.local_models）端到端
- 前端 vm：目录模型进下拉（ctx 徽章 + modalities 文案）/ 按钮文案 /
  失败降级（热门表兜底 + toast，不阻塞面板）
"""
import io
import json
import os

import pytest

from conftest import NewApi, reset_home
from helpers.frontend import read_frontend_source

from backend.domains.providers import local_model_service as lms

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')

# 复用批次 1 的 vm harness
from test_v16_batch1 import _run_node

GH_BASE = 'https://models.github.ai/inference'


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


class _FakeResp:
    def __init__(self, data):
        self._d = data

    def read(self, cap=None):
        return self._d

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _patch_urlopen(monkeypatch, data=None, exc=None):
    """桩 urlopen_no_redirect：返回固定字节或抛固定异常。"""

    def _f(req, timeout=None):
        if exc is not None:
            raise exc
        return _FakeResp(data if data is not None else b'')

    monkeypatch.setattr(lms, 'urlopen_no_redirect', _f)


# ============================================================ 后端 catalog 分支
class TestGithubCatalogBackend:
    """catalog 解析 / 错误人话 / host 隔离。"""

    def test_catalog_parses_provider_model_format(self, monkeypatch):
        payload = json.dumps({'models': [
            {'id': 'openai/gpt-4o', 'name': 'GPT-4o', 'context_window': 128000,
             'modalities': ['text', 'image']},
            {'id': 'deepseek-ai/DeepSeek-R1', 'name': 'DeepSeek R1',
             'context_length': 65536, 'modalities': 'text'},
            {'id': 'bare-name-without-slash', 'name': '坏数据'},
            {'id': '', 'name': '空 id'},
            'not-a-dict',
        ]}).encode('utf-8')
        _patch_urlopen(monkeypatch, data=payload)
        r = lms.models(GH_BASE, api_key='ghp_test')
        assert r['ok'] is True, r
        ids = [m['id'] for m in r['models']]
        assert ids == ['openai/gpt-4o', 'deepseek-ai/DeepSeek-R1'], ids
        assert all('/' in i for i in ids), '裸名必须被过滤（外部核实：校验失败）'
        by_id = {m['id']: m for m in r['models']}
        assert by_id['openai/gpt-4o']['ctx_window'] == 128000
        assert by_id['deepseek-ai/DeepSeek-R1']['ctx_window'] == 65536, 'context_length 别名容错'
        assert by_id['openai/gpt-4o']['modalities'] == ['text', 'image']
        assert by_id['deepseek-ai/DeepSeek-R1']['modalities'] == ['text'], '字符串 modalities 容错'
        assert by_id['openai/gpt-4o']['estimated'] is False, '目录 ctx 为权威值非估算'

    def test_catalog_401_scope_hint(self, monkeypatch):
        import urllib.error
        exc = urllib.error.HTTPError(GH_BASE, 401, 'Unauthorized', {}, io.BytesIO(b''))
        _patch_urlopen(monkeypatch, exc=exc)
        r = lms.models(GH_BASE, api_key='bad-pat')
        assert r['ok'] is False
        assert '401' in r['error'] and 'models:read' in r['error'], r
        assert 'github.com/settings/tokens' in r['error']

    def test_catalog_403_and_429(self, monkeypatch):
        import urllib.error
        for code, needle in ((403, 'models:read'), (429, '限流')):
            exc = urllib.error.HTTPError(GH_BASE, code, 'x', {}, io.BytesIO(b''))
            _patch_urlopen(monkeypatch, exc=exc)
            r = lms.models(GH_BASE, api_key='ghp_test')
            assert r['ok'] is False and needle in r['error'], (code, r)

    def test_catalog_malformed_and_empty(self, monkeypatch):
        # 实现 v1.6 遗留 L2：双路径后语义升级——catalog 结构不符 → fallback
        # {inference_base}/models；双路径皆不符 → 「可手动输入」引导（原单路径
        # 「解析」文案已被更强的引导替代，意图不变：ok:False + 人话出路）
        _patch_urlopen(monkeypatch, data=b'<html>not json</html>')
        r = lms.models(GH_BASE, api_key='k')
        assert r['ok'] is False and '手动输入' in r['error'], r
        # 裸名在 fallback 路径被保留（L2 设计：清单路径宽松，有胜于无；
        # 严格 provider/model 过滤只作用于 catalog 主路径）——由
        # test_v16_leftover.py::test_bare_names_kept_in_fallback 锁定
        _patch_urlopen(monkeypatch, data=json.dumps({'models': [{'id': 'gpt-4o'}]}).encode())
        r2 = lms.models(GH_BASE, api_key='k')
        assert r2['ok'] is True and r2['models'][0]['id'] == 'gpt-4o', r2

    def test_catalog_url_derivation(self):
        assert lms._github_catalog_url(GH_BASE) == \
            'https://models.github.ai/catalog/models'
        assert lms._is_github_catalog_host(GH_BASE) is True
        assert lms._is_github_catalog_host('https://api.deepseek.com/v1') is False
        assert lms._is_github_catalog_host('http://localhost:11434/v1') is False
        # 大写/带端口 host 仍识别
        assert lms._is_github_catalog_host('https://Models.GitHub.AI/inference') is True

    def test_non_github_host_zero_regression(self, monkeypatch):
        """旧行为零回归：OpenAI 形态 {data:[{id}]} 仍走原解析路径。"""
        payload = json.dumps({'data': [{'id': 'deepseek-v4.1'}, {'id': 'gpt-4o'}]}).encode()
        _patch_urlopen(monkeypatch, data=payload)
        r = lms.models('https://api.deepseek.com/v1', api_key='sk-test')
        assert r['ok'] is True, r
        assert [m['id'] for m in r['models']] == ['deepseek-v4.1', 'gpt-4o']

    def test_js_api_local_models_github_end_to_end(self, monkeypatch):
        """api.local_models(base, key) 端到端：catalog 分支经 ok() 包装返回。"""
        payload = json.dumps({'models': [
            {'id': 'openai/gpt-4o-mini', 'context_window': 8192, 'modalities': ['text']}]}).encode()
        _patch_urlopen(monkeypatch, data=payload)
        reset_home()
        api = NewApi()
        raw = api.local_models(GH_BASE, 'ghp_test')
        r = json.loads(raw)
        assert r.get('ok') is True, r
        assert r['models'][0]['id'] == 'openai/gpt-4o-mini'
        assert r['models'][0]['ctx_window'] == 8192

    def test_no_new_js_api(self):
        """铁律：延展路线零新 js_api（get_api_info 方法集合不含 github_*）。"""
        from backend import api as api_mod
        assert not any(m.startswith('github_') for m in api_mod._V12_EXTRA)
        reset_home()
        api = NewApi()
        info = json.loads(api.get_api_info())
        assert not any(m.startswith('github_') for m in (info.get('methods') or []))


# ============================================================ 前端 vm 联调
class TestGithubCatalogFrontend:
    """前端：目录模型进下拉（ctx 徽章 + modalities 文案）/ 按钮文案 / 失败降级。"""

    def test_identify_fills_dropdown_with_catalog(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(method, args) {
      if (method === 'local_models') {
        return JSON.stringify({ ok: true, models: [
          { id: 'openai/gpt-4o', ctx_window: 128000, modalities: ['text', 'image'] },
          { id: 'deepseek-ai/DeepSeek-R1', ctx_window: 65536, modalities: ['text'] }] });
      }
      return '{}';
    }
  });
  __run(ctx, __fe('36-connect.js'));
  await __vm.runInContext(`(async () => {
    await connectApplyPreset('github-models', { animate: false, quiet: true });
    document.getElementById('providerBase').value = 'https://models.github.ai/inference';
    document.getElementById('apiKey').value = 'ghp_test';
    await connectIdentifyNow(false);
    await new Promise(r => setTimeout(r, 30));
  })()`, ctx);
  const sel = await __vm.runInContext(`(() => {
    const s = document.getElementById('modelSelect');
    return { values: s.children.map(c => c.value), texts: s.children.map(c => c.textContent),
             badges: s.children.map(c => c.dataset.badge || '') };
  })()`, ctx);
  const label = await __vm.runInContext(`connectIdentifyLabel('github-models')`, ctx);
  const base = await __vm.runInContext(`document.getElementById('providerBase').value`, ctx);
  return { sel: sel, label: label, base: base };
}
    """, 'ghcat')
        vals = res['sel']['values']
        assert 'openai/gpt-4o' in vals and 'deepseek-ai/DeepSeek-R1' in vals, res
        assert '__manual__' in vals, '末项手动态必须常在'
        # ctx 徽章（formatCtx 口径：128000 → 125k）
        i4o = vals.index('openai/gpt-4o')
        assert res['sel']['badges'][i4o], '目录模型应带 ctx 徽章: %s' % res['sel']['badges']
        # modalities 进选项文案
        assert 'text/image' in res['sel']['texts'][i4o], res['sel']['texts']
        assert res['label'] == '↻ 探测目录', res['label']
        assert res['base'] == 'https://models.github.ai/inference', '预设应自动填充端点'

    def test_identify_failure_degrades_gracefully(self):
        """失败 → 内置热门表兜底 + 面板不阻塞（v4 设计书 §4.2 优雅降级口径：
        host 命中热门表时给内置推荐而非空白；手动态常在，保存/发送不受影响）。
        错误详情透传路径（无热门命中时）由 test_connect_merge 既有用例锁定。"""
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(method, args) {
      if (method === 'local_models') {
        return JSON.stringify({ ok: false, error: 'GitHub PAT 无效或未授权（401）…' });
      }
      return '{}';
    }
  });
  __run(ctx, __fe('36-connect.js'));
  await __vm.runInContext(`(async () => {
    await connectApplyPreset('github-models', { animate: false, quiet: true });
    document.getElementById('providerBase').value = 'https://models.github.ai/inference';
    document.getElementById('apiKey').value = 'bad-pat';
    await connectIdentifyNow(false);
    await new Promise(r => setTimeout(r, 30));
  })()`, ctx);
  const sel = await __vm.runInContext(`(() => {
    const s = document.getElementById('modelSelect');
    return s.children.map(c => c.value);
  })()`, ctx);
  return { values: sel, toasts: __toasts.map(t => t.msg) };
}
    """, 'ghcatfail')
        # 热门表兜底（host models.github.ai 命中）→ 下拉有推荐模型可发
        assert 'openai/gpt-4o' in res['values'], res
        assert '__manual__' in res['values']
        assert any('已加载' in t for t in res['toasts']), '兜底应给出加载提示: %s' % res['toasts']
