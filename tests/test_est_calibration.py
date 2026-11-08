# -*- coding: utf-8 -*-
"""v1.8.0 W10：estTokens usage 回校校准回归（node vm 单模块沙箱）。

覆盖：EMA 收敛/单样本钳制/无效样本忽略/>=3 样本才持久化/损坏存储回落/
estTokensCalibrated 乘积/压缩阈值（historyTokens）不受校准影响。
模式：test_connect_merge 同款——用例 body 整体注入 vm 执行（函数与 const
状态均在 vm ctx 内），节点侧只做编排与断言。
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
const __store = {};
const __sand = {
  console: console,
  localStorage: {
    getItem: function(k){ return (k in __store) ? __store[k] : null; },
    setItem: function(k, v){ __store[k] = String(v); },
  },
};
__sand.window = __sand;
const __ctx = __vm.createContext(__sand);
function __readBundle(rel){ return String(rel).split(',').map(function(r){ return __fs.readFileSync(%r + '/' + r, 'utf8'); }).join('\\n'); }
function __fe(name){ return __readBundle(((%r)[name] || name)); }
function __run(code){ __vm.runInContext(code, __ctx, { timeout: 20000 }); }
function __vmEval(fnSrc){ return __vm.runInContext('(function(){' + fnSrc + '})()', __ctx, { timeout: 20000 }); }
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)

# body 整体进 vm：模块加载 + 用例逻辑 + return
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
    # body 是代码原文（非 JSON）——直接嵌入 %s；json.dumps 会加引号变字符串
    # 字面量导致代码不执行（rc=0 空输出）
    js = _PRELUDE + (_MAIN % body)
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_est_%s_' % name)
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


_LOAD = "__run(__fe('40-auto-compact.js'));"

_CASES = {
    'ema_converge': _LOAD + r"""
  return __vmEval(`
    const seq = [];
    for (let i = 0; i < 5; i++) seq.push(estTokensCalibrate(2000, 1000).ratio);
    return { seq: seq, n: _estCalib.n };
  `);
""",
    'clamp_single': _LOAD + r"""
  return __vmEval(`
    estTokensCalibrate(100, 10);
    const hi = _estCalib.ratio;
    estTokensCalibrate(1, 100);
    return { hi: hi, lo: _estCalib.ratio };
  `);
""",
    'invalid_samples': _LOAD + r"""
  return __vmEval(`
    const before = { ratio: _estCalib.ratio, n: _estCalib.n };
    estTokensCalibrate(0, 100); estTokensCalibrate(-5, 100);
    estTokensCalibrate(NaN, 100); estTokensCalibrate(100, 0); estTokensCalibrate(100, NaN);
    return { before: before, after: { ratio: _estCalib.ratio, n: _estCalib.n } };
  `);
""",
    'persist_gate': _LOAD + r"""
  return __vmEval(`
    estTokensCalibrate(1500, 1000);
    const after1 = localStorage.getItem('harbor_est_calib');
    estTokensCalibrate(1500, 1000);
    estTokensCalibrate(1500, 1000);
    const after3 = localStorage.getItem('harbor_est_calib');
    return { after1: after1, after3: after3 };
  `);
""",
    'corrupt_storage_fallback': _LOAD + "\n  return __vmEval(`\n    localStorage.setItem('harbor_est_calib', '{bad json');\n    return { ratio: _estCalib.ratio, n: _estCalib.n };\n  `);\n",
    'deviation_warn': _LOAD + "\n  return __vmEval(`\n    for (let i = 0; i < 3; i++) estTokensCalibrate(1300, 1000);\n    return { warned: _estCalib.warned, dev: _estCalib.last_deviation, n: _estCalib.n };\n  `);\n",
    'calibrated_product': _LOAD + r"""
  return __vmEval(`
    for (let i = 0; i < 4; i++) estTokensCalibrate(1800, 1000);
    const ratio = _estCalib.ratio;
    const raw = estTokens('hello world hello world');
    const cal = estTokensCalibrated('hello world hello world');
    const ht = historyTokens([{ role: 'user', content: 'hello world hello world' }]);
    return { ratio: ratio, raw: raw, cal: cal, ht: ht };
  `);
""",
    # 预置必须在 _LOAD 前（模块 IIFE 加载时拾取持久化值）
    'reload_persisted': "\n  __vmEval(`\n    localStorage.setItem('harbor_est_calib', JSON.stringify({ ratio: 1.5, n: 5 }));\n  `);\n" + _LOAD + r"""
  return __vmEval(`
    return { ratio: _estCalib.ratio, n: _estCalib.n };
  `);
""",
}

class TestEstCalibration:
    def test_ema_converge(self):
        r = _run(_CASES['ema_converge'], 'ema')
        assert 1.7 <= r['seq'][-1] <= 1.8
        assert r['n'] == 5

    def test_clamp_single(self):
        r = _run(_CASES['clamp_single'], 'clamp')
        assert r['hi'] == 1.8
        # 第二样本走 EMA 混合（1.8*0.7 + 0.6*0.3 = 1.44），不是替换为 0.6
        assert 0.6 <= r['lo'] < 1.8

    def test_invalid_samples_ignored(self):
        r = _run(_CASES['invalid_samples'], 'invalid')
        assert r['before'] == r['after'] == {'ratio': 1, 'n': 0}

    def test_persist_gate_3(self):
        r = _run(_CASES['persist_gate'], 'persist')
        assert r['after1'] is None
        saved = json.loads(r['after3'])
        assert saved['n'] == 3 and 0.6 <= saved['ratio'] <= 1.8

    def test_corrupt_storage_fallback(self):
        r = _run(_CASES['corrupt_storage_fallback'], 'corrupt')
        assert r == {'ratio': 1, 'n': 0}

    def test_calibrated_product(self):
        r = _run(_CASES['calibrated_product'], 'product')
        assert r['ratio'] > 1.5
        assert r['cal'] >= r['raw']
        assert r['ht'] == r['raw']          # 压缩口径不受校准影响

    def test_deviation_warn(self):
        r = _run(_CASES['deviation_warn'], 'devwarn')
        assert r['warned'] is True and r['dev'] > 1.2 and r['n'] == 3

    def test_reload_persisted(self):
        r = _run(_CASES['reload_persisted'], 'reload')
        assert r == {'ratio': 1.5, 'n': 5}
