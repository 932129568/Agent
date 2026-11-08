# -*- coding: utf-8 -*-
"""R30 · 全库迭代升级与 UI 重构 — 回归测试。

覆盖：
1. UI 重构：焦点令牌单一事实源 / 无障碍媒体查询 / 旧范式残留 = 0 / 令牌闭环；
2. 行为兼容：升级前(git HEAD) 与升级后 calcUsage/accumulateUsage/updateTokenStat
   在正常数据下逐字段一致；
3. 健壮性：异常 usage（字符串 / NaN / 负数 / cached>prompt）不再污染累加和；
4. 性能 + UX：O(n²) concat 改 push 展开；document.hidden 早退 + visibilitychange 补刷；
5. 升级审计：对外契约面零漂移 + 函数哈希变更集合恰为白名单。
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
NODE = shutil.which('node') or r'C:\Users\陈\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
TOKENS = 'frontend/src/analytics/tokens.js'
STYLES = ROOT / 'frontend' / 'styles'


def _old_tokens_src():
    """升级前源码（R29 提交 65989be 的工作树版本）。

    R33：原先直接 `git show HEAD:...` 取旧版，但 R30 提交进 HEAD 后基线被
    自身覆盖（旧/新变成同一份，污染与性能两条断言失去意义）。改为读取
    固化的 fixture，基线不再随提交漂移。
    """
    fixture = ROOT / 'tests' / 'fixtures' / 'tokens_pre_r30.js'
    assert fixture.is_file(), '缺少 R30 升级前基线 fixture'
    return fixture.read_text(encoding='utf-8')


def _css_all():
    return '\n'.join(p.read_text(encoding='utf-8')
                     for p in sorted(STYLES.rglob('*.css')))


# ---------------------------------------------------------------- 1. UI 重构

def test_ui_focus_ring_single_source_of_truth():
    css = _css_all()
    # 4 个新增语义令牌均有定义与引用
    for var in ('--focus-ring-w', '--focus-ring-offset',
                '--disabled-opacity', '--scrollbar-size'):
        assert (var + ':') in css, var + ' 未定义'
        assert ('var(' + var + ')') in css, var + ' 未被引用'
    # 焦点环统一：18 处引用单一 --focus-ring，旧 4 色混用清零
    assert css.count('solid var(--focus-ring)') >= 18
    assert 'outline:2px solid var(--accent' not in css
    assert 'outline:2px solid var(--ui-accent' not in css
    # 深色独立提亮 + 系统级无障碍偏好（纯新增）
    assert '--focus-ring:#93C5FD;' in css
    assert '@media (prefers-contrast:more)' in css
    assert '@media (forced-colors:active)' in css
    assert 'Highlight' in css and 'GrayText' in css
    # 三处重复的「全局 disabled 规则」收敛为令牌；组件级规则（.expert-btn 等）不在本轮范围
    assert css.count('button:disabled,input:disabled,textarea:disabled,select:disabled{opacity:var(--disabled-opacity)') == 3
    # 旧范式残留精确口径：仅 cn-flash 两处非焦点高亮允许保留 --primary
    assert css.count('outline:2px solid var(--primary') == 2


def test_ui_contract_still_passes():
    p = subprocess.run([PY, 'deliverables/design/check_contract.py'],
                       cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
    assert p.returncode == 0, p.stdout + p.stderr
    assert 'PASS' in p.stdout


# ------------------------------------------------- 2/3/4. vm 真实调用对比

_VM_HARNESS = r"""
const vm = require('vm');
const OLD = %s, NEW = %s;

function makeEnv(hidden) {
  const els = {};
  const mkEl = () => ({ style: {}, textContent: '', dataset: {},
    classList: { add(){}, remove(){}, toggle(){} } });
  const listeners = {};
  const intervals = [];
  const calls = { live: 0 };
  const document = {
    hidden: !!hidden,
    getElementById(id) { return els[id] || (els[id] = mkEl()); },
    addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    hasFocus() { return true; },
  };
  const ctx = {
    document, console,
    window: { __hitRate: 0, __turnTokens: 0 },
    sessions: [], backendWarning: '', isStreaming: false, localState: null,
    providerPriceFor: () => ({ in: 4, out: 16, cache: 1 }),
    cacheFoldText: () => '',
    getCurrentSession: () => ctx.sessions[0] || null,
    sessionBudget: () => 0,
    setInterval: (cb) => { intervals.push(cb); return intervals.length; },
    clearInterval: () => {},
    callApi: async () => '',
    Number, Math, JSON, String, Array, Object, Date, isNaN, parseInt, parseFloat,
  };
  vm.createContext(ctx);
  return { ctx, els, listeners, intervals, calls };
}

function load(env, src) {
  vm.runInContext(src, env.ctx, { timeout: 10000 });
  return env.ctx;
}

const NORMAL = [
  { usage: { model: 'glm-4.6', prompt_tokens: 1000, completion_tokens: 200,
             total_tokens: 1200, prompt_tokens_details: { cached_tokens: 300 } } },
  { usage: { model: 'glm-4.5-air', prompt_tokens: 500, completion_tokens: 100,
             total_tokens: 600, prompt_tokens_details: { cached_tokens: 0 } } },
  { usage: {} }, {},
  { usage: { model: 'glm-4.5-flash', prompt_tokens: 42, completion_tokens: 7,
             total_tokens: 49, prompt_tokens_details: { cached_tokens: 10 } } },
];
const BAD = [
  { usage: { model: 'glm-4.6', prompt_tokens: '1000', completion_tokens: '200',
             total_tokens: '1200', prompt_tokens_details: { cached_tokens: '300' } } },
  { usage: { model: 'glm-4.6', prompt_tokens: 100, completion_tokens: 20,
             total_tokens: 120, prompt_tokens_details: { cached_tokens: 500 } } },
  { usage: { model: 'glm-4.6', prompt_tokens: NaN, completion_tokens: -5,
             total_tokens: undefined, prompt_tokens_details: { cached_tokens: Infinity } } },
];

const out = {};

// --- 2. 正常数据：calcUsage / accumulateUsage / updateTokenStat 逐字段一致 ---
{
  const a = load(makeEnv(false), OLD), b = load(makeEnv(false), NEW);
  out.calc_old = a.calcUsage(NORMAL);
  out.calc_new = b.calcUsage(NORMAL);
  const sa = {}, sb = {};
  a.accumulateUsage(sa, NORMAL[0].usage);
  b.accumulateUsage(sb, NORMAL[0].usage);
  out.acc_old = sa; out.acc_new = sb;
  const ea = makeEnv(false), eb = makeEnv(false);
  load(ea, OLD); load(eb, NEW);
  ea.ctx.sessions = [ { messages: NORMAL }, { messages: NORMAL } ];
  eb.ctx.sessions = [ { messages: NORMAL }, { messages: NORMAL } ];
  ea.ctx.updateTokenStat(); eb.ctx.updateTokenStat();
  out.stat_old = ea.els.tokenStat.textContent;
  out.stat_new = eb.els.tokenStat.textContent;
}

// --- 3. 异常数据：旧版污染 / 新版不污染 ---
{
  const a = load(makeEnv(false), OLD), b = load(makeEnv(false), NEW);
  out.bad_old = a.calcUsage(BAD);
  out.bad_new = b.calcUsage(BAD);
  const sa = {}, sb = {};
  a.accumulateUsage(sa, BAD[0].usage);
  b.accumulateUsage(sb, BAD[0].usage);
  out.bad_acc_old = sa._spentCost;
  out.bad_acc_new = sb._spentCost;
}

// --- 4a. O(n^2) 优化：大样本耗时 + 输出一致 ---
{
  const sessions = [];
  for (let s = 0; s < 60; s++) {
    const msgs = [];
    for (let i = 0; i < 80; i++) msgs.push({ usage: {
      model: 'glm-4.6', prompt_tokens: 100 + i, completion_tokens: 20,
      total_tokens: 120 + i, prompt_tokens_details: { cached_tokens: 10 } } });
    sessions.push({ messages: msgs });
  }
  const ea = makeEnv(false), eb = makeEnv(false);
  load(ea, OLD); load(eb, NEW);
  ea.ctx.sessions = sessions; eb.ctx.sessions = sessions;
  // 预热 JIT 后取 5 轮中位数（消除单次抖动，与本机隔离基准同口径）
  const bench = (ctx) => {
    for (let i = 0; i < 3; i++) ctx.updateTokenStat();
    const ts = [];
    for (let r = 0; r < 5; r++) {
      const t = process.hrtime.bigint();
      for (let i = 0; i < 12; i++) ctx.updateTokenStat();
      ts.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    ts.sort((x, y) => x - y);
    return ts[2];
  };
  out.ms_old = bench(ea.ctx);
  out.ms_new = bench(eb.ctx);
  out.big_stat_same = ea.els.tokenStat.textContent === eb.els.tokenStat.textContent;
}

// --- 4b. hidden 早退 + visibilitychange 补刷 ---
{
  const e = makeEnv(true);
  load(e, NEW);
  e.ctx.updateLiveTokenStat = () => { e.calls.live++; };
  e.intervals[0]();                       // 10s 拍，页面隐藏 → 应跳过
  out.hidden_skips = (e.calls.live === 0);
  e.ctx.document.hidden = false;
  (e.listeners['visibilitychange'] || [])[0]();  // 恢复可见 → 立即补刷
  out.visible_refresh = (e.calls.live === 1);
  e.intervals[0]();                       // 可见态正常拍 → 再 +1
  out.visible_tick = (e.calls.live === 2);
}
process.stdout.write(JSON.stringify(out));
"""


def _run_vm():
    src = ROOT / TOKENS
    js = _VM_HARNESS % (json.dumps(_old_tokens_src()),
                        json.dumps(src.read_text(encoding='utf-8')))
    p = subprocess.run([NODE, '-e', js], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', timeout=120)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


@pytest.fixture(scope='module')
def vm_out():
    return _run_vm()


def test_normal_data_output_byte_identical(vm_out):
    """正常数据：升级前后逐字段一致（行为兼容硬判据）。"""
    assert vm_out['calc_old'] == vm_out['calc_new'], (vm_out['calc_old'], vm_out['calc_new'])
    assert vm_out['acc_old'] == vm_out['acc_new']
    assert vm_out['stat_old'] == vm_out['stat_new']


def test_abnormal_usage_no_longer_pollutes(vm_out):
    """异常 usage：新版不再产生字符串拼接 / NaN / 负费用。"""
    old, new = vm_out['bad_old'], vm_out['bad_new']
    # 旧版确证被污染（不是空跑的假测试）
    assert (isinstance(old.get('total'), str) or
            not isinstance(old.get('cost'), (int, float)) or
            old.get('cost') != old.get('cost') or old.get('cost') < 0), old
    # 新版全部字段有限数值且非负
    for k in ('total', 'cached', 'cost', 'costStdIn', 'costCache', 'costOut'):
        assert isinstance(new[k], (int, float)) and new[k] == new[k] and new[k] >= 0, (k, new[k])
    assert isinstance(vm_out['bad_acc_new'], (int, float)) and vm_out['bad_acc_new'] >= 0
    assert vm_out['bad_acc_new'] == vm_out['bad_acc_new']  # 非 NaN


def test_perf_and_visible_refresh(vm_out):
    """性能基线（预热+中位数，判据 ≥10% 提升）+ 输出一致；隐藏早退与可见补刷闭环。"""
    assert vm_out['big_stat_same'], '大样本输出不一致'
    assert vm_out['ms_new'] <= vm_out['ms_old'] * 0.9, (
        '优化后需至少 10%% 提升: old=%.1fms new=%.1fms' %
        (vm_out['ms_old'], vm_out['ms_new']))
    assert vm_out['hidden_skips'], '页面隐藏时未跳过轮询'
    assert vm_out['visible_refresh'], '恢复可见时未补刷'
    assert vm_out['visible_tick'], '可见态正常轮询失效'


# ------------------------------------------------------------ 5. 升级审计

def test_upgrade_audit_passes():
    p = subprocess.run([PY, 'tools/upgrade_audit.py'], cwd=ROOT,
                       capture_output=True, text=True, encoding='utf-8', timeout=180)
    assert p.returncode == 0, p.stdout + p.stderr
    assert 'AUDIT: PASS' in p.stdout
    assert '对外契约面零漂移' in p.stdout
