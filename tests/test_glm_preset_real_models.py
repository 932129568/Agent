# -*- coding: utf-8 -*-
"""GLM 预设/兜底模型名必须是平台在售模型（2026-11-04 真机报障回归）。

背景：原预设与热点兜底表写的是 glm-5.3-flash / glm-5.3-flashx / glm-4.7-flash，
这些名字在 open.bigmodel.cn 均不存在（GLM 400 1211）。用户换机用安装器装完，
默认模型就是这些名字 → 一发请求即失败/落异常分支，表现为「免费模型 429」。
付费端点可达只是因为它走的是另一个已存在的模型名。
"""
from pathlib import Path

from test_connect_merge import _run_node
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
CONNECTION = ROOT / 'frontend' / 'src' / 'settings' / 'connection.js'
TOKENS = ROOT / 'frontend' / 'src' / 'analytics' / 'tokens.js'
TEMPLATE = ROOT / 'frontend' / 'index.template.html'
STORE = ROOT / 'frontend' / 'src' / 'settings' / 'store.js'

PHANTOM = ('glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.7-flash')


def test_glm_preset_models_are_real_platform_ids():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  __run(ctx, 'globalThis.__models = connectPresetModels("glm");'
             + 'globalThis.__hot = connectHotModels("https://open.bigmodel.cn/api/paas/v4");');
  return {models: ctx.__models, hot: ctx.__hot};
}
""", 'glm_real_preset')
    ids = [m['id'] for m in result['models']]
    hot_ids = [m['id'] for m in result['hot']]
    for phantom in PHANTOM:
        assert phantom not in ids, phantom + ' 仍在预设表'
        assert phantom not in hot_ids, phantom + ' 仍在热点兜底表'
    assert 'glm-4.5-flash' in ids and 'glm-4.5-flash' in hot_ids
    # 智能档取「第一个 flash 系」→ 首项必须是真实可用的免费模型
    assert ids[0] == 'glm-4.5-flash'


def test_template_static_dropdown_has_no_phantom_models():
    html = TEMPLATE.read_text(encoding='utf-8')
    for phantom in PHANTOM:
        assert '<option value="%s"' % phantom not in html


def test_auto_tier_model_resolves_to_real_free_model():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('36-connect.js'));
  // 智能档取「下拉里第一个 flash 系」→ 静态模板里第一个 flash 必须是真实免费模型
  const sel = __doc.getElementById('modelSelect');
  ['auto', 'glm-4.5-flash', 'glm-4-flash', 'glm-4.5'].forEach(function (v) {
    const o = __doc.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o);
  });
  __run(ctx, __fe('70-config.js'));
  const tier = __vm.runInContext('autoTierModel()', ctx);
  const fallback = __vm.runInContext('AUTO_TIER_FALLBACK_MODEL', ctx);
  return {tier: tier, fallback: fallback};
}
""", 'glm_auto_tier')
    assert result['tier'] == 'glm-4.5-flash'
    assert result['fallback'] == 'glm-4.5-flash'


def test_free_models_carry_zero_price():
    result = run_case(r"""
return {flash45: MODEL_PRICE['glm-4.5-flash'], flash4: MODEL_PRICE['glm-4-flash'],
        paid: MODEL_PRICE['glm-4.5']};
""", ['frontend/src/analytics/tokens.js'])
    assert result['flash45'] == {'in': 0, 'out': 0, 'cache': 0}
    assert result['flash4'] == {'in': 0, 'out': 0, 'cache': 0}
    assert result['paid']['out'] > 0


def test_source_has_no_phantom_model_literals_in_code():
    for path in (CONNECTION, TOKENS, STORE):
        text = path.read_text(encoding='utf-8')
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith('//') or stripped.startswith('*'):
                continue
            for phantom in PHANTOM:
                assert "'%s'" % phantom not in line, '%s: %s' % (path.name, line)
