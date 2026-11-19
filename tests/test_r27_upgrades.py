# -*- coding: utf-8 -*-
"""R27 全库迭代升级：四类改进的行为/契约回归。

覆盖：
1. 代码结构 —— 三处 focus 硬编码延时改 MOTION 令牌（数值精确不变，fx-off 归零）；
2. 健壮性 —— 任务授权 TTL 的 NaN/越界兜底 + 人话提示（原 NaN 直传后端）；
3. UX —— 会话搜索跳转失败兜底补明确提示（原静默滚底）；
4. 性能 —— round_runner 语法哨兵 104 次进程 → 1 次批量（判据等价、可检出坏文件）。
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'frontend' / 'src'
TOOLS = ROOT / 'tools'

NODE_FALLBACK = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'


def _node():
    return shutil.which('node') or NODE_FALLBACK


def _vm(prelude_extra, body, files):
    """在单个 vm context 里加载若干源码文件并执行 body（避免 const 不挂全局）。"""
    node = _node()
    if not Path(node).exists():
        import pytest
        pytest.skip('node 不可用')
    load = '\n'.join(
        "vm.runInContext(fs.readFileSync(%s, 'utf8'), ctx, {timeout:30000});"
        % json.dumps(str(p).replace('\\', '/')) for p in files)
    prelude = r"""
const vm = require('vm'), fs = require('fs');
const ctx = vm.createContext({
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Number: Number, JSON: JSON, Promise: Promise,
  getComputedStyle: function(){ return { getPropertyValue: function(){ return ''; } }; },
  document: { body: {}, getElementById: function(){ return null; },
              querySelectorAll: function(){ return []; } },
  window: {}, toast: function(){}, callApi: function(){ return Promise.resolve('{}'); },
});
""" + prelude_extra + '\n' + load
    js = prelude + '\nvm.runInContext(' + json.dumps(body) + ', ctx, {timeout:30000});'
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_r27_')
    with __import__('os').fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([node, path], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=90)
    finally:
        try:
            __import__('os').remove(path)
        except OSError:
            pass
    if p.returncode != 0:
        raise AssertionError('node vm 失败: ' + (p.stderr or '')[-1500:])
    out = (p.stdout or '').strip()
    return json.loads(out) if out else None


# ---------- 1. 代码结构：focus 延时令牌化 ----------

def test_motion_focus_tokens_default_values():
    result = _vm('', r"""
globalThis.MOTION = MOTION;
console.log(JSON.stringify({ xs: MOTION.focusXs(), sm: MOTION.focusSm(),
  md: MOTION.focusMd(), hasLegacyStagger: typeof MOTION.staggerSm === 'function' }));
""", [SRC / 'core' / 'motion.js'])
    assert result == {'xs': 30, 'sm': 60, 'md': 80, 'hasLegacyStagger': True}, result


def test_focus_delays_no_longer_hardcoded():
    cases = [
        (SRC / 'sessions' / 'search.js', 'MOTION.focusXs()', 30),
        (SRC / 'search' / 'panel.js', 'MOTION.focusSm()', 60),
        (SRC / 'shell' / 'onboarding.js', 'MOTION.focusMd()', 80),
    ]
    for path, token, old_ms in cases:
        src = path.read_text(encoding='utf-8')
        assert token in src, (path.name, token)
        assert "setTimeout(() => input.focus(), %d)" % old_ms not in src, path.name
        assert 'typeof MOTION' in src, path.name


def test_css_tokens_defined_and_reduced_motion_override():
    tokens = (ROOT / 'frontend' / 'styles' / 'tokens.css').read_text(encoding='utf-8')
    legacy = (ROOT / 'frontend' / 'styles' / 'legacy.css').read_text(encoding='utf-8')
    for var, val in (('--dur-focus-xs', '30ms'), ('--dur-focus-sm', '60ms'),
                     ('--dur-focus-md', '80ms')):
        assert ('%s:%s' % (var, val)) in tokens, var
    # fx-off 块内必须把三个令牌都降为 0ms
    block = legacy.split('body.fx-off{', 1)[1].split('}', 1)[0]
    for var in ('--dur-focus-xs', '--dur-focus-sm', '--dur-focus-md'):
        assert ('%s:0ms' % var) in block, var


# ---------- 2. 健壮性：授权 TTL 兜底 ----------

def test_grant_ttl_validation_behaviour():
    """真实调用 guardGrantCreate：合法值放行 / 非法值人话提示且中止 / 元素缺失回落 7200。"""
    body = r"""
globalThis.__toasts = []; globalThis.__calls = [];
ggToast = function(m, k){ globalThis.__toasts.push({m:m, k:k}); };
ggCallApi = function(n, a, t){ globalThis.__calls.push({n:n, a:a});
  return new Promise(function(){}); };   // pending：停在 await，不触后续 DOM 分支
document.querySelectorAll = function(sel){
  if (sel === '.gg-scope') return [{ checked:true, value:'exec' }];
  return [];
};
async function __run(value) {
  document.getElementById = function(id){
    if (id === 'ggTtl') return value === '__MISSING__' ? null : { value: value };
    return null;
  };
  globalThis.__toasts.length = 0; globalThis.__calls.length = 0;
  guardGrantCreate();
  await new Promise(function(r){ setTimeout(r, 10); });
  return { toasts: globalThis.__toasts.slice(), calls: globalThis.__calls.slice() };
}
(async function(){
  const ok = await __run('7200');
  const empty = await __run('');
  const nan = await __run('abc');
  const tooSmall = await __run('5');
  const missing = await __run('__MISSING__');
  console.log(JSON.stringify({ok:ok, empty:empty, nan:nan,
                              tooSmall:tooSmall, missing:missing}));
})();
"""
    r = _vm('', body, [SRC / 'shell' / 'grants.js'])
    assert r['ok']['calls'] and r['ok']['calls'][0]['a'][1] == 7200, r['ok']
    assert not r['ok']['toasts'], r['ok']
    for key in ('empty', 'nan', 'tooSmall'):
        assert not r[key]['calls'], (key, r[key])
        assert r[key]['toasts'] and '授权时长无效' in r[key]['toasts'][0]['m'], (key, r[key])
    assert r['missing']['calls'] and r['missing']['calls'][0]['a'][1] == 7200, r['missing']
    assert not r['missing']['toasts'], r['missing']


# ---------- 3. UX：搜索跳转失败兜底提示 ----------

def test_search_jump_fallback_has_explicit_toast():
    src = (SRC / 'sessions' / 'search.js').read_text(encoding='utf-8')
    assert '未能定位到该消息' in src
    assert "if (box) box.scrollTop = box.scrollHeight;" in src   # 滚底行为不变
    assert '++tries > 20' in src                                  # 重试次数不变
    assert "typeof toast === 'function'" in src                   # 桩/桥缺失不炸


# ---------- 4. 性能：语法哨兵批量化 ----------

def test_syntax_sweep_batch_detects_bad_file_and_matches_legacy():
    sys.path.insert(0, str(TOOLS))
    try:
        import round_runner as rr
        old_root = rr.ROOT
        with tempfile.TemporaryDirectory() as td:
            base = Path(td) / 'frontend' / 'src'
            base.mkdir(parents=True)
            (base / 'good.js').write_text('function ok(){ return 1; }\n', encoding='utf-8')
            (base / 'bad.js').write_text('function broken( {\n', encoding='utf-8')
            rr.ROOT = Path(td)
            try:
                bad = rr.syntax_sweep(_node())
            finally:
                rr.ROOT = old_root
            assert bad == ['frontend/src/bad.js'], bad
            # 逐文件 --check 必须给出同一判据
            legacy = []
            for name in ('good.js', 'bad.js'):
                q = subprocess.run([_node(), '--check', str(base / name)],
                                   capture_output=True, text=True)
                if q.returncode != 0:
                    legacy.append('frontend/src/' + name)
            assert legacy == bad, (legacy, bad)
    finally:
        sys.path.remove(str(TOOLS))


def test_syntax_sweep_batch_on_real_tree_is_clean_and_fast():
    import time
    sys.path.insert(0, str(TOOLS))
    try:
        import round_runner as rr
        t0 = time.time()
        bad = rr.syntax_sweep(_node())
        elapsed = time.time() - t0
    finally:
        sys.path.remove(str(TOOLS))
    assert bad == [], bad
    # 旧实现本机实测 31.73s；批量通道应显著低于该值（留 5s 宽松阈值防 CI 抖动）
    assert elapsed < 5.0, '批量语法检查耗时 %.2fs（旧实现约 31.7s）' % elapsed
