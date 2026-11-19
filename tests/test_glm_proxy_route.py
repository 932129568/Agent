# -*- coding: utf-8 -*-
"""P0：GLM 云端请求经 CORS 代理接线回归（node vm 单模块沙箱）。

resolveApiEndpoint：GLM 端点 + 代理可用 → 返回代理地址；自定义端点 → 直连；
localProxyHeaders：GLM → X-Harbor-Target 带云端 base；local → 本地 base。
"""
import json
import os
import subprocess
import sys
import tempfile

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
from helpers.frontend import frontend_node_map
NODE = r'C:/Users/陈/.workbuddy/binaries/node/versions/node-v27.0.0-alpha.0.0.0-win-x64/node.exe'

_PRELUDE = r"""
const __vm = require('vm');
const __fs = require('fs');
const __sand = { console: console, window: {} };
__sand.window = __sand;
const __ctx = __vm.createContext(__sand);
function __readBundle(rel){ return String(rel).split(',').map(function(r){ return __fs.readFileSync(%r + '/' + r, 'utf8'); }).join('\\n'); }
function __fe(name){ return __readBundle(((%r)[name] || name)); }
function __run(code){ __vm.runInContext(code, __ctx, { timeout: 20000 }); }
function __vmEval(fnSrc){ return __vm.runInContext('(function(){' + fnSrc + '})()', __ctx, { timeout: 20000 }); }
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)

_MAIN = r"""
(async () => {
  const res = await (async () => { %s })();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""


def _run(body, name):
    if not os.path.exists(NODE):
        import pytest
        pytest.skip('node 不可用')
    js = _PRELUDE + (_MAIN % body)
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_gpr_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([NODE, path], capture_output=True, timeout=60)
        if p.returncode != 0:
            raise AssertionError('node 失败: %s' % p.stderr.decode('utf-8', 'replace')[-1200:])
        out = p.stdout.decode('utf-8', 'replace').strip()
        return json.loads(out) if out else None
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


# 71-provider.js 依赖 API_URL/providerState/localState/isGlmEndpoint 同文件定义
_LOAD = ("__run(__fe('71-provider.js'));"
         "__run('window.__localProxyBase = \"http://127.0.0.1:50123\";');")

_CASES = {
    # GLM 云端：providerState.base_url=GLM、preset=glm → 走代理
    'glm_via_proxy': _LOAD + r"""
  __run('providerState = { enabled:true, name:"glm", base_url:"https://open.bigmodel.cn/api/paas/v4", model:"glm-5.3-flash" }; localState = { mode:false, base_url:"" };');
  return __vmEval(`
    return { endpoint: resolveApiEndpoint(), headers: localProxyHeaders(), glm: isGlmEndpoint() };
  `);
""",
    # 自定义端点（DeepSeek）：也走代理（2026-10-21 全云端策略）
    'custom_via_proxy': _LOAD + r"""
  __run('providerState = { enabled:true, name:"deepseek", base_url:"https://api.deepseek.com/v1", model:"deepseek-chat" }; localState = { mode:false, base_url:"" };');
  return __vmEval(`
    return { endpoint: resolveApiEndpoint(), headers: localProxyHeaders() };
  `);
""",
    # 本地模式：走代理 + X-Harbor-Target=本地 base
    'local_via_proxy': _LOAD + r"""
  __run('providerState = { enabled:false, name:"", base_url:"" }; localState = { mode:true, base_url:"http://127.0.0.1:1919/v1" };');
  return __vmEval(`
    return { endpoint: resolveApiEndpoint(), headers: localProxyHeaders() };
  `);
""",
    # 代理不可用（__localProxyBase 空）：GLM 回落直连（行为不劣化）
    'glm_fallback_direct': r"""
  __run(__fe('71-provider.js'));
  __run('providerState = { enabled:true, name:"glm", base_url:"https://open.bigmodel.cn/api/paas/v4" }; localState = { mode:false, base_url:"" };');
  return __vmEval(`
    return { endpoint: resolveApiEndpoint() };
  `);
""",
}


class TestGlmProxyRoute:
    def test_glm_via_proxy(self):
        r = _run(_CASES['glm_via_proxy'], 'glm')
        assert r['endpoint'] == 'http://127.0.0.1:50123/chat/completions'
        assert r['headers']['X-Harbor-Target'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert r['glm'] is True

    def test_custom_via_proxy(self):
        r = _run(_CASES['custom_via_proxy'], 'custom')
        assert r['endpoint'] == 'http://127.0.0.1:50123/chat/completions'
        assert r['headers']['X-Harbor-Target'] == 'https://api.deepseek.com/v1' 

    def test_local_via_proxy(self):
        r = _run(_CASES['local_via_proxy'], 'local')
        assert r['endpoint'] == 'http://127.0.0.1:50123/chat/completions'
        assert r['headers']['X-Harbor-Target'] == 'http://127.0.0.1:1919/v1'

    def test_glm_fallback_direct(self):
        r = _run(_CASES['glm_fallback_direct'], 'fallback')
        assert r['endpoint'] == 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
