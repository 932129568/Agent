# -*- coding: utf-8 -*-
"""v4「连接与模型」三块合并（完全单端点）· 前后端联调实证。

覆盖设计书 deliverables/design/v4/connect-merge-design.md §8 验收标准与 §9 任务拆解：
1. 预设表完整性（11 项，v1.6 T1 起含 github-models）+ 条件显隐矩阵逐格断言（§5）；
2. 防抖 800ms 自动识别 + last-wins 竞态失效（§4.1 / §4.3）；
3. 识别失败兜底：人话 toast + 切手动输入态，「✎ 手动输入模型名…」始终在位（§4.3）；
4. 旧 config（只有 api_key / v1.5 本地模式）一次性 seed 迁移且幂等（§6.1 / D5）；
5. 后端 local_models 可选 api_key：带 / 不带 Authorization 头（§6.2）；
6. 构建产物含新模块、模板三块真的合并（无残留孤儿控件）。

JS 侧复用 tests/test_v15_frontend_link.py 的 node vm 沙箱 harness（`_run_node`/`__ctx`/`__fe`）。
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from conftest import NewApi, reset_home
from helpers.frontend import frontend_node_map, read_frontend_source, resolve_script

from backend.domains.providers import local_model_service as lms

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
TPL = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')
OUT = os.path.join(PROJECT_ROOT, 'harbor.html')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], value: '', checked: false, onclick: null,
    disabled: false, textContent: '', _html: '',
    focus: function(){},
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      toggle: function(c, f){ if (f === undefined) f = !this._s.has(c);
        if (f) this._s.add(c); else this._s.delete(c); return f; },
      contains: function(c){ return this._s.has(c); } },
    appendChild: function(c){ this.children.push(c); c._parent = this;
      if (c.id) __byId[c.id] = c; return c; },
    remove: function(){},
    querySelector: function(){ return __mkEl('q'); },
    querySelectorAll: function(){ return []; },
    addEventListener: function(){},
  };
  Object.defineProperty(el, 'innerHTML', {
    set: function(v) { this._html = String(v); this.children.length = 0;
      const re = /<span[^>]*><\/span>/g; let m;
      while ((m = re.exec(this._html))) { const s = __mkEl('span'); this.children.push(s); } },
    get: function() { return this._html; },
  });
  return el;
}
const __byId = {};
/* 合并后的真实 DOM 里不存在的老 id（v1.5 独立区块专属）→ 声明为「不存在」，
   用于验证 34-local-model.js 的双 id 解析会回落到合并块 id */
const __absent = new Set();
const __toasts = [];
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ if (__absent.has(id)) return null;
    const el = __byId[id];
    if (!el) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
  querySelector: function(){ return __mkEl('q'); },
  addEventListener: function(){},
};
function __ctx(extra) {
  const sand = Object.assign({
    document: __doc, console: console,
    setTimeout: function(fn, ms){ return setTimeout(fn, Math.min(Number(ms) || 0, 20)); },
    clearTimeout: clearTimeout,
    toast: function(msg, kind, opts){ __toasts.push({ msg: msg, kind: kind, opts: opts || {} }); },
    CS: { syncAll: function(){ sand.__csSync = (sand.__csSync || 0) + 1; } },
  }, extra || {});
  sand.window = sand;
  return __vm.createContext(sand);
}
function __run(ctx, code) { __vm.runInContext(code, ctx, { timeout: 30000 }); }
const __SRC = %r;
const __MANIFEST = %r;
function __fe(name){
  const relative = __MANIFEST[name] || name;
  return String(relative).split(',').map(function(r){ return __fs.readFileSync(__SRC + '/' + r, 'utf8'); }).join('\n');
}
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)

_JS_MAIN = r"""
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""


def _run_node(body, name):
    if not os.path.exists(NODE):
        pytest.skip('node 不可用')
    js = _JS_PRELUDE + body + _JS_MAIN
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_cm_%s_' % name)
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


# ============================================================ 1) 预设表 + 显隐矩阵

_JS_APPLY_ALL = r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  /* const 声明不挂沙箱 ⇒ 在 vm 内部求值后写到 globalThis */
  __run(ctx, 'globalThis.__presets = connectPresetIds().map(function(id){'
            + 'var m = PRESETS[id]; return { id: id, name: m.name, base_url: m.base_url,'
            + ' key_required: m.key_required, glm_capable: m.glm_capable, local: m.local,'
            + ' prices: m.prices, models: connectPresetModels(id) }; });');
  const presets = ctx.__presets;
  const matrix = [];
  for (let i = 0; i < presets.length; i++) {
    await ctx.connectApplyPreset(presets[i].id, {});
    matrix.push({
      id: presets[i].id,
      reasoning: __doc.getElementById('advReasoning').style.display !== 'none',
      reasoningOff: __doc.getElementById('advReasoningOff').style.display !== 'none',
      billing: __doc.getElementById('advBilling').style.display !== 'none',
      billingOff: __doc.getElementById('advBillingOff').style.display !== 'none',
      localAdv: __doc.getElementById('advLocal').style.display !== 'none',
      localOff: __doc.getElementById('advLocalOff').style.display !== 'none',
      keyRow: __doc.getElementById('cmKeyRow').style.display !== 'none',
      noKeyChip: __doc.getElementById('cmNoKey').style.display !== 'none',
      baseFilled: __doc.getElementById('providerBase').value,
      label: __doc.getElementById('cmIdentifyBtn').innerHTML,
      models: __doc.getElementById('modelSelect').children.map(function(c){ return c.value; }),
    });
  }
  return { presets: presets, matrix: matrix,
           order: ctx.connectPresetIds() };
}
"""

EXPECT = {
    # 预设 id            reasoning 计费三价 本地项 Key行 免Key条 按钮文案
    'glm':       (True,  False, False, True,  False, '↻ 获取模型'),
    'deepseek':  (False, True,  False, True,  False, '↻ 识别模型'),
    'moonshot':  (False, True,  False, True,  False, '↻ 识别模型'),
    'qwen':      (False, True,  False, True,  False, '↻ 识别模型'),
    # Nemotron 3 Ultra 550B：云端第三方语义（需 Key / 计费三价 / 无 GLM 推理力度）
    'nemotron':  (False, True,  False, True,  False, '↻ 识别模型'),
    # 实现 v1.6 T1：GitHub Models 免费层（云端第三方语义：无推理力度、有三价置零、需 Key）
    # 实现 v1.6 T2：目录探测型端点 → 按钮文案「探测目录」
    'github-models': (False, True, False, True, False, '↻ 探测目录'),
    'ollama':    (False, False, True,  False, True,  '↻ 探测本机'),
    'lmstudio':  (False, False, True,  False, True,  '↻ 探测本机'),
    'vllm':      (False, False, True,  False, True,  '↻ 探测本机'),
    'llamacpp':  (False, False, True,  False, True,  '↻ 探测本机'),
    'localai':   (False, False, True,  False, True,  '↻ 探测本机'),
    # 实现 FreeToken preset：FreeToken Desktop（本地管理器，local:true 免 Key 零费，
    # 单模型语义靠探测——按钮走本地系「探测本机」文案）
    'freetoken': (False, False, True,  False, True,  '↻ 探测本机'),
    'custom':    (False, True,  False, True,  False, '↻ 识别模型'),
}


class TestPresetTableAndVisibility:
    """§5 条件显隐矩阵逐格 + 11 预设完整性（D1/D3/D4；v1.6 T1 起 11 项）。"""

    def test_preset_table_ten_and_shape(self):
        r = _run_node(_JS_APPLY_ALL, 'presets')
        ids = [p['id'] for p in r['presets']]
        # 实现 v1.6 T1：v4 设计 10 项 → 新增 github-models（免费层）为 11 项
        # 实现 FreeToken preset：新增 freetoken（FreeToken Desktop 本地管理器）为 12 项
        # 实现 Nemotron preset：新增 nemotron（legui.xyz 云端端点）为 13 项
        assert len(ids) == 13, ids
        assert ids == ['glm', 'deepseek', 'moonshot', 'qwen', 'nemotron',
                       'github-models', 'ollama', 'lmstudio', 'vllm', 'llamacpp',
                       'localai', 'freetoken', 'custom']
        assert r['order'] == ids
        for p in r['presets']:
            assert p['name'], p['id']
            assert p['key_required'] is (not p['local']), p['id']     # 本地系免 Key
            assert p['glm_capable'] is (p['id'] == 'glm'), p['id']    # GLM 专属能力唯一
            if p['id'] != 'custom':
                assert p['base_url'].startswith('http'), p['id']
            assert isinstance(p['models'], list), p['id']
        by_id = {p['id']: p for p in r['presets']}
        # D4：GLM 走内置价格表（无三价）、云端有默认价、本地零费
        assert by_id['glm']['prices'] is None
        assert by_id['deepseek']['prices'] == {'in': 0.15, 'out': 0.6, 'cache': 0.003}  # R20 校准（2026-10-21 官网）
        for lid in ('ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai'):
            assert by_id[lid]['prices'] == {'in': 0, 'out': 0, 'cache': 0}, lid
            assert by_id[lid]['base_url'].startswith('http://localhost:'), lid
        assert by_id['custom']['base_url'] == ''
        # 实现 v1.6 T1：GitHub Models 免费层结构（端点/零价/Key 必需/provider-model 格式）
        gh = by_id['github-models']
        assert gh['base_url'] == 'https://models.github.ai/inference'
        assert gh['prices'] == {'in': 0, 'out': 0, 'cache': 0}
        assert gh['key_required'] is True and gh['local'] is False
        assert all('/' in m['id'] for m in gh['models']), 'GitHub 模型 ID 须 provider/model 格式'

    def test_visibility_matrix_cell_by_cell(self):
        r = _run_node(_JS_APPLY_ALL, 'matrix')
        assert len(r['matrix']) == 13   # v4 10 → github 11 → freetoken 12 → nemotron 13
        for row in r['matrix']:
            exp = EXPECT[row['id']]
            assert row['reasoning'] is exp[0], '推理力度显隐错: %s' % row['id']
            assert row['reasoningOff'] is (not exp[0]), '推理力度说明错: %s' % row['id']
            assert row['billing'] is exp[1], '计费三价显隐错: %s' % row['id']
            assert row['billingOff'] is (not exp[1]), '计费说明错: %s' % row['id']
            assert row['localAdv'] is exp[2], '本地项显隐错: %s' % row['id']
            assert row['localOff'] is (not exp[2]), '本地项说明错: %s' % row['id']
            assert row['keyRow'] is exp[3], 'Key 行显隐错: %s' % row['id']
            assert row['noKeyChip'] is exp[4], '免 Key 提示条显隐错: %s' % row['id']
            assert row['label'] == exp[5], '按钮文案错: %s → %s' % (row['id'], row['label'])

    def test_preset_switch_fills_base_and_models(self):
        r = _run_node(_JS_APPLY_ALL, 'switch')
        m = {row['id']: row for row in r['matrix']}
        assert m['glm']['baseFilled'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert m['deepseek']['baseFilled'] == 'https://api.deepseek.com/v1'
        assert m['ollama']['baseFilled'] == 'http://localhost:11434/v1'
        assert m['custom']['baseFilled'] == ''
        # GLM 首项必须是智能档（验收标准 3：GLM 体验不回退）
        assert m['glm']['models'][0] == 'auto'
        # 末项永远是「✎ 手动输入模型名…」兜底
        for row in r['matrix']:
            assert row['models'][-1] == '__manual__', row['id']
        assert 'smart' not in m['deepseek']['models']

    def test_custom_base_url_survives_preset_roundtrip(self):
        """QA 修正 2：预设切换不得清掉用户手填的 Base URL（custom 默认 '' → 数据丢失）。
        规则：切走时记忆「非默认值」，切回时优先用记忆值；预设默认值不污染记忆。"""
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  const val = function(){ return __doc.getElementById('providerBase').value; };
  await ctx.connectApplyPreset('custom', {});
  const emptyCustom = val();
  __doc.getElementById('providerBase').value = 'https://my-proxy.example.com/v1';
  await ctx.connectApplyPreset('glm', {});
  const glmBase = val();
  await ctx.connectApplyPreset('custom', {});
  const back = val();
  /* 再走一圈：GLM 官方默认地址不得被记忆成「手改值」 */
  await ctx.connectApplyPreset('deepseek', {});
  await ctx.connectApplyPreset('glm', {});
  const glmAgain = val();
  /* 云端预设内的代理地址同样保留 */
  await ctx.connectApplyPreset('deepseek', {});
  __doc.getElementById('providerBase').value = 'https://ds-proxy.example.com/v1';
  await ctx.connectApplyPreset('glm', {});
  await ctx.connectApplyPreset('deepseek', {});
  const dsBack = val();
  return { emptyCustom: emptyCustom, glmBase: glmBase, back: back,
           glmAgain: glmAgain, dsBack: dsBack };
}
""", 'base_memo')
        assert r['emptyCustom'] == ''                              # custom 默认空
        assert r['glmBase'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert r['back'] == 'https://my-proxy.example.com/v1'      # 手填 URL 恢复，不被清空
        assert r['glmAgain'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert r['dsBack'] == 'https://ds-proxy.example.com/v1'    # 非默认值也按预设记忆


# ============================================================ 1.5) 判据与运行态派生

_JS_DERIVE = r"""
async function __main() {
  /* 真实合并块：v1.5 独立区块的老 id 一律不存在（34 的 localEl 双 id 解析走回落分支） */
  ['localBaseUrl', 'localModelSelect', 'localProbeBtn', 'localModelsBtn',
   'localTestBtn', 'localTestStatus', 'localMetaBadge'].forEach(function(id){ __absent.add(id); });
  const calls = [];
  const ctx = __ctx({
    callApi: async function(api, args){
      calls.push({ api: api, args: args });
      if (api === 'local_probe') return JSON.stringify({ ok: true, elapsed_ms: 12,
        reachable: [{ base_url: 'http://localhost:11434/v1', kind: 'ollama', reachable: true,
                      models: ['qwen3:8b'], latency_ms: 3 }], unreachable: [] });
      if (api === 'local_models') return JSON.stringify({ ok: true, models: [
        { id: 'qwen3:8b', ctx_window: 32768, tool_capable: true, estimated: false }] });
      return '{}';
    },
  });
  __run(ctx, __fe('00-state.js'));
  __run(ctx, __fe('34-local-model.js'));
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, __fe('71-provider.js'));

  /* ① 智谱 GLM 预设：GLM 专属全开、端点回官方、Key 用唯一字段 */
  await ctx.connectApplyPreset('glm', {});
  __doc.getElementById('apiKey').value = 'sk-glm';
  ctx.connectSyncState();
  const glm = { glm: ctx.isGlmEndpoint(), local: ctx.localModeActive(),
                key: ctx.effectiveApiKey(), endpoint: ctx.resolveApiEndpoint(),
                name: ctx.currentEndpointName() };

  /* ② DeepSeek 预设：GLM 能力关、端点＝服务商、三价计费、Key 仍是唯一字段 */
  await ctx.connectApplyPreset('deepseek', {});
  __doc.getElementById('apiKey').value = 'sk-ds';
  ctx.connectSyncState();
  const ds = { glm: ctx.isGlmEndpoint(), local: ctx.localModeActive(),
               key: ctx.effectiveApiKey(), endpoint: ctx.resolveApiEndpoint(),
               price: ctx.providerPriceFor('deepseek-flash') };

  /* ③ Ollama 预设：免 Key / 零费 / localState 派生出 model（60-agent-loop 本地分支依赖） */
  await ctx.connectApplyPreset('ollama', {});
  __doc.getElementById('apiKey').value = 'sk-should-be-ignored';
  ctx.connectSyncState();
  const beforeProbe = { glm: ctx.isGlmEndpoint(), local: ctx.localModeActive(),
                        key: ctx.effectiveApiKey(), endpoint: ctx.resolveApiEndpoint(),
                        price: ctx.providerPriceFor('qwen3:8b') };

  /* ④ 探测本机：走 local_probe，命中后把清单灌进合并块的 modelSelect（带 ctx 徽标） */
  await ctx.connectIdentifyNow(true);
  await new Promise(function(r){ setTimeout(r, 30); });
  const sel = __doc.getElementById('modelSelect');
  const afterProbe = {
    probeCalled: calls.some(function(c){ return c.api === 'local_probe'; }),
    modelOptions: sel.children.map(function(c){ return c.value; }),
    badges: sel.children.map(function(c){ return c.dataset.badge || ''; }),
    badgeText: __doc.getElementById('cmCtxBadge').textContent,
    localModel: (function(){ var o = {}; __run(ctx, 'globalThis.__ls = { mode: localState.mode, base_url: localState.base_url, model: localState.model };'); return ctx.__ls; })(),
  };

  /* ⑤ 云端识别：local_models(base, key) 带 Key（本地探测不吃 Key） */
  await ctx.connectApplyPreset('moonshot', {});
  __doc.getElementById('apiKey').value = 'sk-moon';
  await ctx.connectIdentifyNow(true);
  const identifyCall = calls[calls.length - 1];
  return { glm: glm, ds: ds, beforeProbe: beforeProbe, afterProbe: afterProbe,
           identifyApi: identifyCall.api, identifyArgs: identifyCall.args,
           probeArgLen: (calls.filter(function(c){ return c.api === 'local_probe'; })[0] || { args: [] }).args.length };
}
"""


class TestEndpointDerivation:
    """T4：71-provider.js 判据改预设 + 34/36 运行态派生（60-agent-loop 本地分支不断链）。"""

    def test_glm_preset_regains_glm_capabilities(self):
        r = _run_node(_JS_DERIVE, 'derive_glm')
        glm = r['glm']
        assert glm['glm'] is True and glm['local'] is False
        assert glm['key'] == 'sk-glm'
        assert glm['endpoint'] == 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
        assert glm['name'] == 'GLM'

    def test_cloud_preset_turns_glm_capabilities_off(self):
        r = _run_node(_JS_DERIVE, 'derive_ds')
        ds = r['ds']
        assert ds['glm'] is False and ds['local'] is False
        assert ds['key'] == 'sk-ds'
        assert ds['endpoint'] == 'https://api.deepseek.com/v1/chat/completions'
        assert ds['price'] == {'in': 0.15, 'out': 0.6, 'cache': 0.003}   # 三价实价（R20 校准）

    def test_local_preset_is_keyless_and_zero_cost(self):
        r = _run_node(_JS_DERIVE, 'derive_local')
        lp = r['beforeProbe']
        assert lp['glm'] is False and lp['local'] is True
        assert lp['key'] == ''                                        # 本地免 Key
        assert lp['endpoint'] == 'http://localhost:11434/v1/chat/completions'
        assert lp['price'] == {'in': 0, 'out': 0, 'cache': 0}         # 本地 · 0 费用

    def test_probe_fills_merged_select_with_ctx_badge(self):
        r = _run_node(_JS_DERIVE, 'derive_probe')
        ap = r['afterProbe']
        assert ap['probeCalled'] is True
        assert 'qwen3:8b' in ap['modelOptions']
        assert ap['modelOptions'][-1] == '__manual__'                 # 手动态兜底始终在位
        assert '32k' in ap['badges'], ap['badges']                    # ctx 徽标（.local-badge）
        assert '32k' in ap['badgeText']
        assert ap['localModel']['mode'] is True
        assert ap['localModel']['model'] == 'qwen3:8b'                # 60-agent-loop 本地分支的模型来源

    def test_cloud_identify_sends_key_local_probe_does_not(self):
        r = _run_node(_JS_DERIVE, 'derive_identify')
        assert r['identifyApi'] == 'local_models'
        assert r['identifyArgs'][0] == 'https://api.moonshot.cn/v1'
        assert r['identifyArgs'][1] == 'sk-moon'                      # 云端清单带 Key
        assert r['probeArgLen'] == 0                                  # 本地探测无参

    def test_sync_apply_path_writes_preset_itself(self):
        """回归（2026-10-17）：connectApplyPresetNow 必须自行写入当前预设——
        配置回填走的就是这条同步路径，漏写会让判据仍停留在上一个预设。"""
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('00-state.js'));
  __run(ctx, __fe('34-local-model.js'));
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, __fe('71-provider.js'));
  ctx.connectApplyPresetNow('glm', {});
  ctx.connectSyncState();
  const before = { glm: ctx.isGlmEndpoint(), key: ctx.effectiveApiKey() };
  __doc.getElementById('apiKey').value = 'sk-x';
  ctx.connectApplyPresetNow('ollama', {});          // 同步路径（配置回填同款）
  ctx.connectSyncState();
  const after = { preset: __doc.getElementById('providerPreset').value,
                  glm: ctx.isGlmEndpoint(), local: ctx.localModeActive(),
                  key: ctx.effectiveApiKey(),
                  endpoint: ctx.resolveApiEndpoint() };
  return { before: before, after: after };
}
""", 'sync_apply')
        assert r['before']['glm'] is True
        assert r['after']['preset'] == 'ollama'
        assert r['after']['glm'] is False
        assert r['after']['local'] is True
        assert r['after']['key'] == ''                                # 本地系免 Key
        assert r['after']['endpoint'].startswith('http://localhost:11434')


# ============================================================ 2) 防抖 + last-wins
_JS_DEBOUNCE = r"""
async function __main() {
  const calls = [];
  const ctx = __ctx({
    callApi: async function(api, args){
      calls.push({ api: api, args: args });
      if (String(args[0] || '').indexOf('slow') !== -1) {
        await new Promise(function(r){ setTimeout(r, 15); });
        return JSON.stringify({ ok: true, models: [{ id: 'OLD-MODEL' }] });
      }
      return JSON.stringify({ ok: true, models: [{ id: 'NEW-MODEL' }] });
    },
  });
  __run(ctx, __fe('36-connect.js'));
  await ctx.connectApplyPreset('deepseek', {});
  __doc.getElementById('providerBase').value = 'https://api.deepseek.com/v1';
  __doc.getElementById('apiKey').value = 'sk-qa';
  /* 连续两次字段变化 → 800ms 防抖只发一次 */
  ctx.connectScheduleIdentify();
  ctx.connectScheduleIdentify();
  await new Promise(function(r){ setTimeout(r, 60); });
  const debouncedCalls = calls.length;
  const debouncedModel = __doc.getElementById('modelSelect').value;

  /* last-wins：慢请求先发、快请求后发 → 下拉只能出现后发结果 */
  __doc.getElementById('providerBase').value = 'https://api.slow.example.com/v1';
  const first = ctx.connectIdentifyNow(false);
  __doc.getElementById('providerBase').value = 'https://api.fast.example.com/v1';
  const second = ctx.connectIdentifyNow(false);
  await Promise.all([first, second]);
  const sel = __doc.getElementById('modelSelect');
  return {
    debouncedCalls: debouncedCalls,
    debouncedModel: debouncedModel,
    modelOptions: sel.children.map(function(c){ return c.value; }),
    callBases: calls.map(function(c){ return c.args[0]; }),
    keyedCall: calls[0].args.length,
  };
}
"""


class TestDebounceAndLastWins:
    """§4.1 防抖 800ms 自动识别 / §4.3 last-wins 竞态。"""

    def test_debounce_collapses_rapid_input(self):
        r = _run_node(_JS_DEBOUNCE, 'debounce')
        assert r['debouncedCalls'] == 1, r['callBases']       # 800ms 内多次输入只识别一次
        assert r['debouncedModel'] == 'NEW-MODEL'
        assert r['keyedCall'] == 2                            # local_models(base, key)：带 Key 请求

    def test_last_wins_discards_stale_response(self):
        r = _run_node(_JS_DEBOUNCE, 'lastwins')
        assert 'NEW-MODEL' in r['modelOptions']
        assert 'OLD-MODEL' not in r['modelOptions'], r['modelOptions']
        assert r['modelOptions'][-1] == '__manual__'


# ============================================================ 3) 识别失败兜底

_JS_FAIL = r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(){ return JSON.stringify({ ok: false, error: '端点不支持模型列表' }); },
  });
  __run(ctx, __fe('36-connect.js'));
  await ctx.connectApplyPreset('custom', {});
  __doc.getElementById('providerBase').value = 'https://nothing.example.com/v1';
  __doc.getElementById('apiKey').value = 'sk-qa';
  await ctx.connectIdentifyNow(true);
  const sel = __doc.getElementById('modelSelect');
  const pick = __doc.getElementById('cmPick');
  const afterFail = {
    manual: pick.classList.contains('manual'),
    options: sel.children.map(function(c){ return c.value; }),
    modelValue: ctx.connectModelValue(),
  };
  /* 手动态可切回下拉，且「✎ 手动输入模型名…」始终在位 */
  ctx.connectExitManual();
  const afterBack = {
    manual: pick.classList.contains('manual'),
    options: sel.children.map(function(c){ return c.value; }),
  };
  /* 完全无 Base URL 时点击识别：不抛错、不阻塞 */
  __doc.getElementById('providerBase').value = '';
  await ctx.connectIdentifyNow(true);
  return {
    afterFail: afterFail, afterBack: afterBack,
    toasts: __toasts.map(function(t){ return { msg: t.msg, kind: t.kind }; }),
  };
}
"""


class TestIdentifyFallback:
    """§4.3 识别失败永不阻塞：人话 toast + 手动态 + 手动项始终在位。"""

    def test_failure_switches_to_manual_and_keeps_option(self):
        r = _run_node(_JS_FAIL, 'fallback')
        assert r['afterFail']['manual'] is True                      # 失败即切手动输入态
        assert '__manual__' in r['afterFail']['options']             # 末项始终在位
        assert r['afterFail']['modelValue'] == ''                    # 不编造模型名
        assert r['afterBack']['manual'] is False                     # 可切回下拉
        assert r['afterBack']['options'][-1] == '__manual__'
        kinds = [t['kind'] for t in r['toasts']]
        assert 'err' in kinds
        assert any('手动输入' in t['msg'] for t in r['toasts'])

    def test_empty_base_url_does_not_throw(self):
        r = _run_node(_JS_FAIL, 'emptybase')
        # 空 Base URL：给出人话提示并进手动态，全程无异常（脚本能跑完即为不阻塞）
        assert any('Base URL' in t['msg'] for t in r['toasts'])
        assert r['afterFail']['manual'] is True


# ============================================================ 4) 旧 config seed 迁移

_JS_SEED = r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, 'globalThis.__collect = function(){ return connectCollectConfig(); };');
  const snap = function(){
    return {
      preset: __doc.getElementById('providerPreset').value,
      base: __doc.getElementById('providerBase').value,
      key: __doc.getElementById('apiKey').value,
      model: __doc.getElementById('modelSelect').value,
      collected: ctx.__collect(),
    };
  };
  /* ① v1.2 老配置：只有 api_key + model，没有任何 provider_* */
  ctx.connectLoadFromConfig({ api_key: 'sk-legacy', model: 'glm-5.3-flashx' });
  const legacy = snap();
  /* ② 幂等：把迁移结果当作已持久化的新配置再载入一次 */
  ctx.connectLoadFromConfig(JSON.parse(JSON.stringify(legacy.collected)));
  const again = snap();
  /* ③ 已是新配置（provider_* 齐全）：不 seed、不回退 GLM */
  ctx.connectLoadFromConfig({ provider_name: 'deepseek', provider_base_url: 'https://api.deepseek.com/v1',
    provider_key: 'sk-ds', provider_model: 'deepseek-flash', provider_prices: { in: 0.15, out: 0.6, cache: 0.003 } });
  const cloud = snap();
  /* ④ v1.5 本地模式老配置：迁移为本地系预设（旧运行期本地优先） */
  ctx.connectLoadFromConfig({ local_mode: true, local_base_url: 'http://localhost:11434/v1',
    local_model: 'qwen3:8b', local_ctx_window: 32768, local_tool_capable: 'off' });
  const local = snap();
  return { legacy: legacy, again: again, cloud: cloud, local: local,
           localCtx: __doc.getElementById('localCtxWindow').value,
           localTool: __doc.getElementById('localToolCapable').value };
}
"""


class TestLegacyConfigSeed:
    """§6.1 / D5：单一事实源 provider_* + 一次性 seed 迁移（幂等）。"""

    def test_api_key_only_config_seeds_glm_preset(self):
        r = _run_node(_JS_SEED, 'seed')
        legacy = r['legacy']
        assert legacy['preset'] == 'glm'
        assert legacy['base'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert legacy['key'] == 'sk-legacy'
        assert legacy['model'] == 'glm-5.3-flashx'
        col = legacy['collected']
        assert col['provider_name'] == 'glm'
        assert col['provider_base_url'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert col['provider_key'] == 'sk-legacy'
        assert col['provider_model'] == 'glm-5.3-flashx'
        assert set(col) == {'provider_name', 'provider_base_url', 'provider_key',
                            'provider_model', 'provider_prices'}

    def test_seed_is_idempotent(self):
        r = _run_node(_JS_SEED, 'seed_idem')
        assert r['again']['preset'] == r['legacy']['preset']
        assert r['again']['base'] == r['legacy']['base']
        assert r['again']['key'] == r['legacy']['key']
        assert r['again']['model'] == r['legacy']['model']
        assert r['again']['collected'] == r['legacy']['collected']

    def test_existing_provider_config_not_reseeded(self):
        r = _run_node(_JS_SEED, 'seed_cloud')
        cloud = r['cloud']
        assert cloud['preset'] == 'deepseek'
        assert cloud['base'] == 'https://api.deepseek.com/v1'
        assert cloud['key'] == 'sk-ds'
        assert cloud['model'] == 'deepseek-flash'
        assert cloud['collected']['provider_prices'] == {'in': 0.15, 'out': 0.6, 'cache': 0.003}

    def test_dual_config_migration_prefers_local_model(self):
        """双开老配置（provider_model=云端名 + local_model=本地名）迁到本地预设时，
        模型名必须以 local_model 为准——否则请求打到 localhost 却带云端模型名（404）。"""
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, 'globalThis.__collect = function(){ return connectCollectConfig(); };');
  ctx.connectLoadFromConfig({
    provider_name: 'deepseek', provider_base_url: 'https://api.deepseek.com/v1',
    provider_key: 'sk-ds', provider_model: 'deepseek-v4.1',
    provider_prices: { in: 2, out: 8, cache: 0.4 },
    local_mode: true, local_base_url: 'http://localhost:11434/v1',
    local_model: 'qwen3:8b', local_ctx_window: 32768, local_tool_capable: 'off'
  });
  return {
    preset: __doc.getElementById('providerPreset').value,
    base: __doc.getElementById('providerBase').value,
    selectModel: __doc.getElementById('modelSelect').value,
    collected: ctx.__collect()
  };
}
""", 'dual_model')
        assert r['preset'] == 'ollama'
        assert r['base'] == 'http://localhost:11434/v1'
        assert r['selectModel'] == 'qwen3:8b'
        assert r['collected']['provider_model'] == 'qwen3:8b'     # 落盘的也是本地模型名

    def test_legacy_local_config_migrates_to_local_preset(self):
        r = _run_node(_JS_SEED, 'seed_local')
        local = r['local']
        assert local['preset'] == 'ollama'
        assert local['base'] == 'http://localhost:11434/v1'
        assert local['model'] == 'qwen3:8b'
        assert local['collected']['provider_name'] == 'ollama'
        assert r['localCtx'] == 32768                 # local_* 专属项原样回填
        assert r['localTool'] == 'off'

    def test_migrated_local_config_never_persists_again(self):
        """QA 修正 1：迁移只落盘一次——collectLocalConfig 会持续写 local_mode/local_base_url，
        二次 boot 若仍命中迁移分支就会反复 queueSaveConfig（幂等但「只落盘一次」不成立）。"""
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, 'globalThis.__saves = 0;'
            + 'globalThis.queueSaveConfig = function(){ globalThis.__saves++; };'
            + 'globalThis.__collect = function(){ return connectCollectConfig(); };');
  /* ① v1.5 老配置（只有 local_*）→ 真迁移：落盘一次 */
  ctx.connectLoadFromConfig({ local_mode: true, local_base_url: 'http://localhost:11434/v1',
    local_model: 'qwen3:8b', local_ctx_window: 0, local_tool_capable: 'auto' });
  const firstBoot = ctx.__saves;
  /* ② 二次 boot：喂回 App 实际落盘的形状（provider_* 与 local_* 并存） */
  const persisted = Object.assign({}, ctx.__collect(), {
    local_mode: true, local_preset: 'ollama',
    local_base_url: 'http://localhost:11434/v1', local_model: 'gpt-oss-20b',
    local_ctx_window: 0, local_tool_capable: 'auto',
    api_key: '', model: 'gpt-oss-20b'
  });
  ctx.connectLoadFromConfig(persisted);
  const secondBoot = ctx.__saves - firstBoot;
  /* ③ 第三次依然零落盘 */
  ctx.connectLoadFromConfig(persisted);
  const thirdBoot = ctx.__saves - firstBoot - secondBoot;
  return { firstBoot: firstBoot, secondBoot: secondBoot, thirdBoot: thirdBoot,
           preset: __doc.getElementById('providerPreset').value,
           base: __doc.getElementById('providerBase').value };
}
""", 'seed_once')
        assert r['firstBoot'] == 1        # 首次真迁移：落盘一次
        assert r['secondBoot'] == 0       # 已迁移：严格零落盘
        assert r['thirdBoot'] == 0
        assert r['preset'] == 'ollama'
        assert r['base'] == 'http://localhost:11434/v1'


# ============================================================ 5) local_models api_key

class _FakeResp(object):
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode('utf-8')

    def read(self, n=None):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _stub_models_urlopen(monkeypatch, payload, seen):
    """打桩 urlopen_no_redirect：只记录 /models 请求（/api/tags 元数据补拉不计入）。"""
    def fake(req, timeout=None):
        url = getattr(req, 'full_url', '')
        if url.endswith('/models'):
            seen['url'] = url
            seen['headers'] = {k.lower(): v for k, v in req.header_items()}
        return _FakeResp(payload)
    monkeypatch.setattr(lms, 'urlopen_no_redirect', fake)


class TestLocalModelsApiKey:
    """§6.2 后端唯一增强：可选 api_key → Authorization: Bearer（本地免 Key 行为不变）。"""

    def test_with_key_sends_authorization_header(self, monkeypatch):
        seen = {}
        _stub_models_urlopen(monkeypatch, {'data': [{'id': 'deepseek-v4.1'}]}, seen)
        r = lms.models('https://api.deepseek.com/v1', api_key='sk-qa-123')
        assert r['ok'] is True and r['models'][0]['id'] == 'deepseek-v4.1'
        assert seen['url'].endswith('/models')
        assert seen['headers'].get('authorization') == 'Bearer sk-qa-123'

    def test_without_key_keeps_legacy_behavior(self, monkeypatch):
        seen = {}
        _stub_models_urlopen(monkeypatch, {'data': [{'id': 'qwen3:8b'}]}, seen)
        r = lms.models('http://localhost:11434/v1')          # 单参调用（v1.5 口径）
        assert r['ok'] is True
        assert 'authorization' not in seen['headers']
        r2 = lms.models('http://localhost:11434/v1', api_key='   ')   # 空白 Key 等同未填
        assert r2['ok'] is True
        assert 'authorization' not in seen['headers']

    def test_control_chars_in_key_are_ignored(self, monkeypatch):
        seen = {}
        _stub_models_urlopen(monkeypatch, {'data': [{'id': 'm'}]}, seen)
        lms.models('http://localhost:11434/v1', api_key='bad\r\nkey')
        assert 'authorization' not in seen['headers']        # 头注入防护
        assert lms.auth_header_value('bad\r\nkey') == ''
        assert lms.auth_header_value(' sk-ok ') == 'sk-ok'

    def test_service_and_js_api_pass_key_through(self, monkeypatch):
        reset_home()
        api = NewApi()
        calls = []

        class _Stub(object):
            def models(self, base_url, api_key=''):
                calls.append((base_url, api_key))
                return {'ok': True, 'models': []}

        api._local = _Stub()
        r = json.loads(api.local_models('https://api.moonshot.cn/v1', 'sk-moon'))
        assert r['ok'] is True
        assert calls == [('https://api.moonshot.cn/v1', 'sk-moon')]
        json.loads(api.local_models('http://localhost:11434/v1'))     # 向后兼容单参
        assert calls[-1] == ('http://localhost:11434/v1', '')

    def test_still_hidden_from_get_api_info(self):
        reset_home()
        api = NewApi()
        info = json.loads(api.get_api_info())
        assert 'local_models' not in info['methods']


# ============================================================ 6) 模板合并 + 构建产物

class TestTemplateMerge:
    def test_three_blocks_really_merged(self):
        tpl = io.open(TPL, encoding='utf-8').read()
        # 三块合一：新块在位
        assert 'id="cmBlock"' in tpl and '连接与模型' in tpl
        assert tpl.count('id="providerPreset"') == 1
        assert tpl.count('id="apiKey"') == 1
        assert tpl.count('id="modelSelect"') == 1
        assert tpl.count('id="reasoningEffort"') == 1
        # 旧三块的两个开关 / 分块控件彻底退场（无残留孤儿控件）
        for gone in ['id="providerEnabled"', 'id="localModeEnable"', 'id="providerModel"',
                     'id="providerKey"', 'id="localPreset"', 'id="localModelSelect"',
                     'id="localBaseUrl"', 'id="localProbeBtn"', 'id="localModelsBtn"',
                     '>模型服务商（OpenAI 兼容端点）</div>',
                     '>本地模型（v1.5 · Ollama / LM Studio 等）</div>']:
            assert gone not in tpl, '合并后残留: %s' % gone
        # 13 个预设全部在模板下拉里（+github-models / +freetoken / +nemotron）
        for pid in ('glm', 'deepseek', 'moonshot', 'qwen', 'nemotron', 'github-models',
                    'ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai', 'freetoken',
                    'custom'):
            assert '<option value="%s"' % pid in tpl, pid

    def test_built_artifact_contains_new_module(self):
        assert os.path.isfile(OUT), '先运行 node frontend/build.js'
        built = io.open(OUT, encoding='utf-8').read()
        module_path = resolve_script(PROJECT_ROOT, '36-connect.js')
        assert ('/* ===== %s ===== */' % module_path) in built
        assert 'PROVIDER_HOT_MODELS' in built
        assert 'CONNECT_DEBOUNCE_MS = 800' in built
        assert 'id="cmBlock"' in built
        assert 'id="providerEnabled"' not in built


# ============================================================ 7) 验收标准补充（QA 补齐 §8 缺口）
# 以下用例是 QA 独立复验时发现既有 24 例未覆盖、但设计书 §8/§5 明确要求的行为：
#   §8.3 GLM 内置价格表与三价字段隔离 / §8.5 reduced-motion 无动画依赖 /
#   §4.2 内置热门表（含 127.0.0.1 补充项、未命中不猜）/ 会话头端点名。

_JS_PRICE_ISOLATION = r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  /* 75-token-stat.js 里的内置价格表（不加载整文件避免 setInterval）*/
  __run(ctx, 'const MODEL_PRICE = {"glm-5.3-flashx":{in:2,out:7,cache:0.57},'
             + '"glm-5.3-flash":{in:0.8,out:2.8,cache:0.23}};');
  __run(ctx, __fe('00-state.js'));
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, __fe('71-provider.js'));
  /* GLM：即便三价输入被塞成 99，也必须走内置价格表 */
  await ctx.connectApplyPreset('glm', {});
  __doc.getElementById('apiKey').value = 'sk-glm';
  __doc.getElementById('providerPriceIn').value = '99';
  __doc.getElementById('providerPriceOut').value = '99';
  __doc.getElementById('providerPriceCache').value = '99';
  ctx.connectSyncState();
  const glmFlash = ctx.providerPriceFor('glm-5.3-flash');
  /* DeepSeek：走「高级 · 计费三价」 */
  await ctx.connectApplyPreset('deepseek', {});
  __doc.getElementById('apiKey').value = 'sk-ds';
  ctx.connectSyncState();
  const ds = ctx.providerPriceFor('deepseek-v4.1');
  /* 本地系：零费 */
  await ctx.connectApplyPreset('ollama', {});
  ctx.connectSyncState();
  const local = ctx.providerPriceFor('any-model');
  return { glmFlash: glmFlash, ds: ds, local: local };
}
"""


class TestPricingIsolationAndMotion:
    """§8.3 / §8.5 / §4.2：内置价格表隔离、reduced-motion、热门表、端点名。"""

    def test_glm_builtin_price_ignores_three_price_inputs(self):
        r = _run_node(_JS_PRICE_ISOLATION, 'price_iso')
        assert r['glmFlash'] == {'in': 0.8, 'out': 2.8, 'cache': 0.23}   # 内置表，不吃 99
        assert r['ds'] == {'in': 0.15, 'out': 0.6, 'cache': 0.003}      # 三价实价（R20 校准）
        assert r['local'] == {'in': 0, 'out': 0, 'cache': 0}            # 本地零费

    def test_reduced_motion_applies_without_animation(self):
        """§8.5：MOTION.instant() 为真时，animate 路径必须同步应用（无动画依赖）。"""
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; },
    MOTION: { instant: function(){ return true; }, compOut: function(){ return 0; },
              sleep: function(){ return Promise.resolve(); } } });
  __run(ctx, __fe('36-connect.js'));
  await ctx.connectApplyPreset('glm', { animate: true });
  const a = { preset: __doc.getElementById('providerPreset').value,
              base: __doc.getElementById('providerBase').value };
  await ctx.connectApplyPreset('ollama', { animate: true });
  const b = { preset: __doc.getElementById('providerPreset').value,
              base: __doc.getElementById('providerBase').value };
  return { a: a, b: b };
}
""", 'motion')
        assert r['a']['preset'] == 'glm'
        assert r['a']['base'] == 'https://open.bigmodel.cn/api/paas/v4'
        assert r['b']['preset'] == 'ollama'
        assert r['b']['base'] == 'http://localhost:11434/v1'

    def test_hot_models_fallback_and_endpoint_names(self):
        """§4.2：热门表按 host 匹配（127.0.0.1 补充项 / 未命中不猜）；端点名派生正确。"""
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('00-state.js'));
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, __fe('71-provider.js'));
  const idOf = function(list){ return list.map(function(m){ return m.id; }); };
  const out = {
    unknown: ctx.connectHotModels('https://nope.example.com/v1'),
    loopback: idOf(ctx.connectHotModels('http://127.0.0.1:11434/v1')),
    bigmodel: idOf(ctx.connectHotModels('https://open.bigmodel.cn/api/paas/v4')),
  };
  await ctx.connectApplyPreset('glm', {}); ctx.connectSyncState();
  out.nameGlm = ctx.currentEndpointName();
  await ctx.connectApplyPreset('deepseek', {}); __doc.getElementById('apiKey').value = 'sk'; ctx.connectSyncState();
  out.nameDs = ctx.currentEndpointName();
  await ctx.connectApplyPreset('ollama', {}); ctx.connectSyncState();
  out.nameLocal = ctx.currentEndpointName();
  return out;
}
""", 'hot_name')
        assert r['unknown'] == []                              # 未命中 → 不猜
        assert 'gpt-oss-20b' in r['loopback']                 # 127.0.0.1 补充项生效
        assert 'glm-4.6' in r['bigmodel']
        assert r['nameGlm'] == 'GLM'
        assert r['nameDs'] == 'DeepSeek'
        assert r['nameLocal'].startswith('本地 · ')
