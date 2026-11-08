# -*- coding: utf-8 -*-
"""R31 · 无上限并行会话 + 历史会话页重构 — 回归测试。

覆盖：
1. RunRegistry 多槽：跨会话 start 不取消他方；同会话重入取消旧的；finish/current 精确；
2. 流式标志按会话派生：A 结束不影响 B；isSessionStreaming 语义；
3. 群聊隔离：abort controller 按会话（暂停 A 群不中断 B 群）、busy/paused 为 Set；
4. 无并发闸门：不引入上限常量/信号量/队列，无开关/配置项；
5. 历史页：模板含统计/筛选/搜索；_renderSessionHub 真实渲染 + 筛选 + 搜索空态。
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')

FILES = {
    'rcb': 'frontend/src/agent/run-controller-base.js',
    'reg': 'frontend/src/agent/run-registry.js',
    'cbase': 'frontend/src/sessions/controller-base.js',
    'ctrl': 'frontend/src/sessions/controller.js',
    'group': 'frontend/src/group/group.js',
}


def _src(key):
    return (ROOT / FILES[key]).read_text(encoding='utf-8')


def _run_node(js, timeout=90):
    """写临时脚本执行（Windows 命令行长度上限约 32K，不能走 -e 传大源码）。"""
    fd, path = tempfile.mkstemp(suffix='.js', prefix='r31_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(js)
        p = subprocess.run([NODE, path], cwd=ROOT, capture_output=True,
                           text=True, encoding='utf-8', timeout=timeout)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


# ------------------------------------------------------------ 1/2. 并行 run

_REGISTRY_HARNESS = r"""
const vm = require('vm');
const RCB = %s, REG = %s;
const ctx = {
  AppState: { currentSessionId: 'a', isStreaming: false },
  currentSessionId: 'a',
  sessions: [], projects: [],
  document: { getElementById: () => null, addEventListener() {}, hasFocus: () => true },
  setInterval: () => 1, clearInterval: () => {},
  AbortController, console, Date, Math, JSON, Number, String, Array, Object,
  isStreaming: false,
};
vm.createContext(ctx);

// const 声明不会挂到 context 对象上，测试体必须同 context 执行
const BODY = `
const A = { id: 'a', title: 'A', messages: [] };
const B = { id: 'b', title: 'B', messages: [] };
const C = { id: 'c', title: 'C', messages: [] };
const out = {};

const ra = RunRegistry.start(A);
const rb = RunRegistry.start(B);
const rc = RunRegistry.start(C);
out.three_alive = !ra.cancelled && !rb.cancelled && !rc.cancelled;
out.map_size = __agentRuns.size;
out.current_a = RunRegistry.current('a') === ra;
out.current_b = RunRegistry.current('b') === rb;
out.current_visible_is_a = RunRegistry.current() === ra;
out.has_all = RunRegistry.has('a') && RunRegistry.has('b') && RunRegistry.has('c');

const ra2 = RunRegistry.start(A);
out.reentry_cancels_old = ra.cancelled === true;
out.reentry_keeps_b_c = !rb.cancelled && !rc.cancelled;
out.reentry_replaced = RunRegistry.current('a') === ra2;
out.map_size_after_reentry = __agentRuns.size;

RunRegistry.finish(rb);
out.finish_removes_b = !RunRegistry.has('b');
out.finish_keeps_a_c = RunRegistry.has('a') && RunRegistry.has('c');

AppState.currentSessionId = 'c';
out.stream_c = isSessionStreaming('c') === true;
out.stream_b = isSessionStreaming('b') === false;
out.stream_unknown = isSessionStreaming('zzz') === false;
out.refresh_c_true = refreshStreamingFlag() === true && AppState.isStreaming === true;
AppState.currentSessionId = 'd';
out.refresh_d_false = refreshStreamingFlag() === false && AppState.isStreaming === false;

RunRegistry.cancel('c');
out.cancel_precise = !RunRegistry.has('c') && RunRegistry.has('a');
out.cancel_does_not_touch_a = !ra2.cancelled;

// 6) 规模：一次启动 20 个会话（远超任何隐性上限），全部在途且互不取消
const many = [];
for (let i = 0; i < 20; i++) {
  many.push(RunRegistry.start({ id: 'm' + i, title: 'M' + i, messages: [] }));
}
out.scale_all_alive = many.every(function (r) { return !r.cancelled; });
out.scale_map_size = __agentRuns.size;          // 1 (a) + 20
out.scale_active_runs = getActiveRuns().length; // 含 a + 20
globalThis.__result = JSON.stringify(out);
`;
vm.runInContext(RCB + '\n' + REG + '\n' + BODY, ctx, { timeout: 10000 });
process.stdout.write(ctx.__result);
"""


def test_parallel_runs_unbounded_and_isolated():
    out = _run_node(_REGISTRY_HARNESS % (json.dumps(_src('rcb')), json.dumps(_src('reg'))))
    assert out['three_alive'], '跨会话 start 取消了其他会话的 run（并发上限仍存在）'
    assert out['map_size'] == 3
    assert out['current_a'] and out['current_b'], 'current(sid) 未按会话返回'
    assert out['current_visible_is_a'], 'current() 未按可见会话返回（串到最近启动的 run）'
    assert out['has_all']
    assert out['reentry_cancels_old'], '同会话重入未取消旧 run（双发保护失效）'
    assert out['reentry_keeps_b_c'], '同会话重入误伤其他会话'
    assert out['reentry_replaced'] and out['map_size_after_reentry'] == 3
    assert out['finish_removes_b'] and out['finish_keeps_a_c']
    # stream_* 三个字段均编码「期望成立」的判定结果
    assert out['stream_c'] and out['stream_b'] and out['stream_unknown']
    assert out['refresh_c_true']
    assert out['refresh_d_false'], '全局流式标志被其他会话的 run 污染'
    assert out['cancel_precise'] and out['cancel_does_not_touch_a']
    # 无上限：20 会话同时并行，全部存活
    assert out['scale_all_alive'], '存在隐性并发上限：批量 start 取消了部分 run'
    # Map 含 1 个在途 a + 1 个「已取消待 finally 注销」的 c + 20 个新 run
    assert out['scale_map_size'] == 22
    # 在途快照已过滤 cancelled → a + 20
    assert out['scale_active_runs'] == 21


# ------------------------------------------------------- 3. 群聊会话级隔离

_GROUP_HARNESS = r"""
const vm = require('vm');
const src = %s;
const i = src.indexOf('const groupAbort =');
const tail = src.slice(i);
const j = tail.indexOf('function groupAbortRelease');
const k = tail.indexOf('\n}\n', j);
const code = tail.slice(0, k + 3);
const ctx = { AbortController, console };
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 5000 });

const g1 = ctx.groupAbortController('g1');
const g2 = ctx.groupAbortController('g2');
const out = {};
out.distinct = g1 !== g2;
out.same_per_sid = ctx.groupAbortController('g1') === g1;
// 暂停 g1 只中断 g1
let g2aborted = false;
g2.signal.addEventListener('abort', () => { g2aborted = true; });
g1.abort();
out.g1_aborted = g1.signal.aborted === true;
out.g2_untouched = g2.signal.aborted === false && g2aborted === false;
// renew：g1 换新信号，旧的不影响 g2
const g1b = ctx.groupAbortRenew('g1');
out.renew_new = g1b !== g1 && g1b.signal.aborted === false;
// release：只删自己的
ctx.groupAbortRelease('g2');
out.release_keeps_g1 = ctx.groupAbortController('g1') === g1b;
out.release_removed_g2 = ctx.groupAbortController('g2') !== g2;
process.stdout.write(JSON.stringify(out));
"""


def test_group_abort_isolated_per_session():
    out = _run_node(_GROUP_HARNESS % json.dumps(_src('group')))
    assert out['distinct'], 'groupAbort 仍是模块级单例'
    assert out['same_per_sid']
    assert out['g1_aborted'] and out['g2_untouched'], '暂停一个群中断了另一个群'
    assert out['renew_new']
    assert out['release_keeps_g1'] and out['release_removed_g2']


def test_group_busy_flags_are_sets_not_single_value():
    src = _src('group')
    assert 'const GROUP_BUSY_SIDS = new Set()' in src
    assert 'const GROUP_PAUSED_SIDS = new Set()' in src
    # 旧单值赋值必须清零（注释除外）
    code = '\n'.join(l for l in src.splitlines() if not l.strip().startswith('*'))
    assert 'groupSpeak._busySid =' not in code
    assert 'groupSpeak._pausedSid =' not in code
    # 群聊 run 纳入统一注册表且标记 kind
    assert "RunRegistry.start(s)" in src and "_groupRun.kind = 'group'" in src
    # 单聊 UI 不被群聊接管
    sync = (ROOT / 'frontend/src/agent/run-controller.js').read_text(encoding='utf-8')
    assert "run.kind === 'group'" in sync


# ------------------------------------------------------- 4. 无限流/开关/配置

def test_no_concurrency_caps_or_switches():
    """不设数量上限、无队列/信号量、无开关按钮、无配置项。"""
    for key in ('rcb', 'reg', 'ctrl', 'group'):
        src = _src(key)
        for bad in ('MAX_CONCURRENT', 'maxParallel', 'maxSessions',
                    'concurrencyLimit', 'semaphore', 'pLimit',
                    'runQueue', 'pendingRuns'):
            assert bad not in src, '%s 出现并发闸门 %s' % (FILES[key], bad)
    tpl = (ROOT / 'frontend/index.template.html').read_text(encoding='utf-8')
    for bad in ('parallelToggle', 'maxParallel', '并发开关', '开启并行'):
        assert bad not in tpl, '出现并行开关/配置入口: ' + bad


# ------------------------------------------------------- 5. 历史会话页重构

def test_history_template_has_stats_filter_search():
    tpl = (ROOT / 'frontend/index.template.html').read_text(encoding='utf-8')
    assert 'id="panelSessions"' in tpl
    assert 'id="sessionList"' in tpl                       # 既有契约 id 保留
    assert 'id="sessionStatsBar"' in tpl
    assert 'id="sessionFilterSeg"' in tpl
    assert 'id="sessionSearchInput"' in tpl
    for mode in ('all', 'chat', 'group', 'running'):
        assert 'data-sfilter="%s"' % mode in tpl
    assert "onclick=\"setSessionFilter('group')\"" in tpl
    assert 'oninput="setSessionQuery(this.value)"' in tpl
    # 面板仍在 panel 容器内、保留 session-list 类
    assert 'class="session-list sh-list" id="sessionList"' in tpl


_HUB_HARNESS = r"""
const vm = require('vm');
const CBASE = %s, CTRL = %s;
const boxes = {};
function mkBox(id) {
  return { id, innerHTML: '', textContent: '',
    querySelectorAll: () => [], addEventListener: () => {},
    classList: { toggle() {}, add() {}, remove() {} } };
}
const ctx = {
  sessions: [
    { id: 's1', title: '群聊方案讨论', updatedAt: 3000, messages: [
        { role: 'user', content: '帮我拆解这个需求' },
        { role: 'assistant', content: '已拆成三步' } ],
      group: { members: [ { id: 'm1' }, { id: 'm2' }, { id: 'm3' } ], phase: 'running' } },
    { id: 's2', title: '单聊代码审查', updatedAt: 2000, messages: [
        { role: 'user', content: '看看这段 diff' } ], runStatus: 'completed' },
    { id: 's3', title: '空会话', updatedAt: 1000, messages: [] },
  ],
  currentSessionId: 's2',
  projects: [],
  RunRegistry: { has: (sid) => sid === 's1' },
  AppState: { currentSessionId: 's2' },
  escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])),
  document: {
    getElementById: (id) => (boxes[id] || (boxes[id] = mkBox(id))),
    addEventListener: () => {},
  },
  localStorage: { getItem: () => '[]', setItem: () => {} },
  console, Date, Math, JSON, Number, String, Array, Object, isFinite, parseInt,
};
vm.createContext(ctx);
vm.runInContext(CBASE + '\n' + CTRL, ctx, { timeout: 10000 });
const out = {};

ctx._renderSessionHub();
out.list_html = boxes.sessionList.innerHTML;
out.stats_html = boxes.sessionStatsBar.innerHTML;

ctx.setSessionFilter('group');
out.group_html = boxes.sessionList.innerHTML;
ctx.setSessionFilter('chat');
out.chat_html = boxes.sessionList.innerHTML;
ctx.setSessionFilter('running');
out.running_html = boxes.sessionList.innerHTML;
ctx.setSessionFilter('all');
ctx.setSessionQuery('没有这个词xyz');
out.empty_html = boxes.sessionList.innerHTML;
ctx.setSessionQuery('代码审查');
out.search_html = boxes.sessionList.innerHTML;
process.stdout.write(JSON.stringify(out));
"""


def test_history_hub_renders_rich_cards_and_filters():
    js = _HUB_HARNESS % (json.dumps(_src('cbase')), json.dumps(_src('ctrl')))
    out = _run_node(js)

    lst = out['list_html']
    assert lst.count('sh-card') >= 3, '未渲染富卡片'
    assert 'sh-badge-group' in lst and 'sh-badge-chat' in lst, '缺少群聊/单聊徽章'
    assert '群聊方案讨论' in lst and '单聊代码审查' in lst
    assert '条消息' in lst and '位成员' in lst
    assert 'sh-live' in lst and '进行中' in lst, '进行中标记缺失'
    assert 'session-acts' in lst and 'session-exp' in lst and 'session-del' in lst
    assert 'sh-card active' in lst, '当前会话未高亮'

    st = out['stats_html']
    assert 'sh-stat-total' in st and 'sh-stat-group' in st and 'sh-stat-running' in st
    assert '>3<' in st and '>1<' in st and '>2<' in st, '统计数据不正确'

    assert '群聊方案讨论' in out['group_html'] and '单聊代码审查' not in out['group_html']
    assert '单聊代码审查' in out['chat_html'] and '群聊方案讨论' not in out['chat_html']
    assert '群聊方案讨论' in out['running_html'] and '单聊代码审查' not in out['running_html']

    assert 'sh-empty' in out['empty_html'] and '没有匹配' in out['empty_html']
    assert '单聊代码审查' in out['search_html'] and '群聊方案讨论' not in out['search_html']


def test_build_passes_with_module_count_unchanged():
    """构建 lint（manifest provides 双向一致）与模块数不变。"""
    p = subprocess.run([NODE, 'frontend/build.js'], cwd=ROOT,
                       capture_output=True, text=True, encoding='utf-8', timeout=180)
    assert p.returncode == 0, p.stdout + p.stderr
    m = json.loads((ROOT / 'frontend/manifest.json').read_text(encoding='utf-8'))
    assert len(m['scripts']) == 113
    assert len(m['styles']) == 14
