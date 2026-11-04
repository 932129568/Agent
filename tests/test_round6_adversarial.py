# -*- coding: utf-8 -*-
"""第六轮·前端核心修复对抗证伪 + 遗留项清剿 回归测试（2026-10-21）。

背景：对第五轮（077e8e1）前端核心修复构造时序反例验证 + 清剿报告标注遗留项。
本文件是「反例→修复→防回归」闭环的实证：

A. node 单脚本 harness（模块源码 + 顶层桩 + 测试体同一 script 作用域——
   let/const 模块状态与函数声明对测试体直接可见，桩必须声明在脚本顶层
   （模块级函数才能解析到），同 test_v18_software_hybrid 口径）：
   - planFinishIfNatural：熔断/暂停/截断续跑路径不收尾，仅正常跑完收尾（项1）
   - agentGuardCheck：guard_session_trust 登记失败不进前端 Set + 二次调用重新
     弹窗（不进入「前端信任→后端拒→CONFIRM_REQUIRED」死循环）（项2）
   - guardCheckTool：26-guard 同型修复（项2 孪生）
   - deleteSession：e=undefined 不 NPE / 流式拦当前会话 / 流式放行非当前会话
     并带 plan.task_id 走 session_purge（项3）
   - obTestKey：云端传 key+local=false+20s；本地系免 Key 放行+local=true+90s（项7）
   - ctxMenu Esc 关闭（项8 补齐的另一半）
   - guard-grant 定时器随 ggActive 启停（项11）
   - toast 溢出淘汰跳过 pinned / 全 pinned 不淘汰（项12）
   - connectSetButtonLoading：识别按钮按当前预设重刷，不还原陈旧 dataset.html（项16a）
   - localLoadModels：stale 请求 finally 不抢复位在途按钮（项16b）
   - memoryPanelInit 幂等（项6 行为侧证据）
   - msgRecall 守卫矩阵（项9 行为侧证据）
B. 静态核对（无头 DOM 验证不了项的替代证据；剥注释后判定）：
   - 项4：normalizeSessions plan.task_id 白名单 + deleteSession taskIds 传参形态
   - 项5：--glass-bg-2 等变量在 :root 与 body.dark 双侧定义
   - 项10：msg-time user 隐藏（后置同特异性胜出）/ shortcutsBtn 单定义 /
     fx-off 对 .set-window/.modal-card 的 animation:none
   - 项13：硬编码毫秒令牌化（MOTION 引用在位、旧字面量清场）
   - 项14：initFx 位于 loadAll 首个 await 之前
   - 项15：回退中性态 + bridgeLateReady + get_api_info 只在 bridgeDependentInit
   - 项2/6/7/8/11：关键修复点的源码在位证据
C. 后端闭环行为（不依赖前端自洽）：恶意 plan.task_id 经 session_purge
   skip+warning，purge 整体仍然 ok（项4 闭环证据；既有行为固化，非新功能）
"""
import io
import json
import os
import re
import subprocess
import tempfile

import pytest

from helpers.frontend import (frontend_node_map, read_frontend_source,
                              read_frontend_styles, read_frontend_template_with_styles,
                              resolve_script, script_paths)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
TPL = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _strip_comments(src):
    """剥块注释 + 行注释（仅用于源码在位性判定；被测文件无 URL 字面量误伤）。"""
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    src = re.sub(r'^\s*//.*$', '', src, flags=re.M)
    return src


# ---------------------------------------------------------------- 桩头（单脚本）
# 约定：所有桩名 __ 前缀；不重声明 node 全局（console 等）。
_HEAD = r"""
// ---- DOM 桩（保真：classList=Set / dataset / innerHTML / children / 事件登记）----
const __byId = {};
let __autoCreate = true;
function __setAutoCreate(v) { __autoCreate = !!v; }
const __qsa = {};
const __qsaAll = {};
const __docHandlers = {};
const __intervals = [];
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    _cls: new Set(), _html: '', _text: '', value: '', checked: false,
    disabled: false, dataset: {}, style: {}, children: [], _handlers: {},
    _parent: null, id: '', title: '', selectionStart: 0, selectionEnd: 0,
    classList: {
      add: function (c) { el._cls.add(c); },
      remove: function (c) { el._cls.delete(c); },
      toggle: function (c, f) { if (f === undefined) f = !el._cls.has(c);
        if (f) el._cls.add(c); else el._cls.delete(c); return f; },
      contains: function (c) { return el._cls.has(c); }
    },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set className(v) { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...el._cls].join(' '); },
    appendChild: function (c) { this.children.push(c); c._parent = this;
      if (c.id) __byId[c.id] = c; return c; },
    removeChild: function (c) { this.children = this.children.filter(x => x !== c);
      return c; },
    remove: function () { if (this._parent) this._parent.removeChild(this);
      this._detached = true; },
    contains: function () { return true; },
    querySelector: function (sel) { const c = __mkEl(sel); c._parent = this;
      this.children.push(c); return c; },
    querySelectorAll: function () { return []; },
    addEventListener: function (type, fn) {
      (this._handlers[type] = this._handlers[type] || []).push(fn); },
    dispatch: function (type, ev) {
      (this._handlers[type] || []).forEach(f => f(ev || {})); },
    focus: function () { this._focused = true; },
    click: function () { (this._handlers.click || []).forEach(f => f({})); },
    setAttribute: function () {}, getAttribute: function () { return null; },
    closest: function () { return null; },
    offsetWidth: 100
  };
  return el;
}
const __doc = {
  body: __mkEl('body'),
  // autoCreate 开关：默认 true（多数模块的 ggEl/mmEl 桩需要）；测「元素不存在」
  // 分支（如 memoryPanelInit 幂等判定）的用例先 __setAutoCreate(false)。
  getElementById: function (id) {
    if (__byId[id]) { if (__byId[id]._detached) return null; return __byId[id]; }
    if (!__autoCreate) return null;
    const n = __mkEl('#' + id); n.id = id; __byId[id] = n; return n; },
  createElement: function (t) { return __mkEl(t); },
  querySelector: function (sel) { return __qsa[sel] || null; },
  querySelectorAll: function (sel) { return __qsaAll[sel] || []; },
  addEventListener: function (type, fn) {
    (__docHandlers[type] = __docHandlers[type] || []).push(fn); },
  dispatch: function (type, ev) {
    (__docHandlers[type] || []).forEach(f => f(ev || {})); },
  execCommand: function () { return true; },
  hidden: false, hasFocus: function () { return true; }
};
const document = __doc;
const window = { DOMPurify: undefined, addEventListener: function () {},
  matchMedia: function () { return { matches: false }; },
  innerWidth: 800, innerHeight: 600 };
// 定时器桩：setTimeout 纯录制不执行（确定性）；setInterval 录句柄可 clear；
// __flush 用 process.nextTick 排空微任务（不依赖被桩掉的 setTimeout）。
const __timers = [];
function setTimeout(fn, ms) { __timers.push({ fn: fn, ms: ms }); return __timers.length; }
function clearTimeout() {}
function setInterval(fn, ms) { const h = { fn: fn, ms: ms, cleared: false };
  __intervals.push(h); return h; }
function clearInterval(h) { if (h) h.cleared = true; }
const __flush = () => new Promise(r => process.nextTick(r));
const MOTION = { instant: function () { return true; }, comp: function () { return 200; },
  compOut: function () { return 140; }, press: function () { return 90; },
  staggerSm: function () { return 60; }, panel: function () { return 240; },
  onAnimEnd: function () { return Promise.resolve(); },
  sleep: function (ms) { return Promise.resolve(); } };
const localStorage = { _m: new Map(),
  getItem: function (k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem: function (k, v) { this._m.set(k, String(v)); },
  removeItem: function (k) { this._m.delete(k); } };
"""

_MAIN = r"""
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""


def _run_js(name, modules, stubs, body, checks_min):
    """modules: 模块文件名（按序拼接）；stubs: 顶层桩 JS；body: __main 定义。"""
    if not os.path.exists(NODE):
        pytest.skip('node 不可用: %s' % NODE)
    js = _HEAD
    for fname in modules:
        js += '\n/* ===== %s ===== */\n' % fname + _fe(fname)
    js += '\n/* ===== stubs ===== */\n' + stubs + '\n' + body + _MAIN
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_r6_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
        out = json.loads(r.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    assert 'fatal' not in out, out
    failed = [c['name'] for c in out.get('checks', []) if not c['pass']]
    assert not failed, '前端断言失败: %s' % failed
    assert len(out['checks']) >= checks_min
    return out


# ============================================================ A1 项1：计划收尾
_PLAN_STUBS = r"""
// 计划态桩（67-plan-card 未加载：planCurrent 由测试体声明，spy 为顶层函数）
let planCurrent = null;
let __stepCalls = [];
function planStepStatus(i, st) { __stepCalls.push([i, st]); }
let __finishArg = null;
let __finishStatus = null;
function planFinish(t, finalStatus) { __finishArg = t; __finishStatus = finalStatus; }
const mkPlan = () => ({ task_id: 'tk1', status: 'running',
  steps: [{ status: 'pending' }, { status: 'doing' }, { status: 'done' }] });
"""


class TestPlanFinishIfNatural:
    """60-agent-loop.js planFinishIfNatural：仅正常跑完收尾（反例防回归）。

    反例（修复前）：熔断/stall/预算硬停/length 截断续跑均置 finished=true 后
    break，原收尾块条件 !userStopped && finished 全部命中 → 计划被谎报
    「✓ N 步全部完成」且 plan_update 'done' 落库。
    """

    def test_harness(self):
        out = _run_js('plan_finish', ['60-agent-loop.js'], _PLAN_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 反例主场景：熔断 break（naturalDone=false）→ 不收尾
  planCurrent = mkPlan(); __stepCalls = []; __finishArg = null; __finishStatus = null;
  planFinishIfNatural(false, false);
  ok('fuse_break_no_finish', __finishArg === null && __stepCalls.length === 0);

  // ② 正常跑完只汇总真实状态；pending/doing 不得被伪置 done，也不伪称验收通过
  planCurrent = mkPlan(); planCurrent.steps.push({ text: '被阻断步骤', status: 'blocked' });
  planCurrent.steps[0].text = '待处理步骤'; planCurrent.steps[1].text = '进行中步骤';
  __stepCalls = []; __finishArg = null;
  planFinishIfNatural(false, true);
  ok('natural_done_finish', __finishArg
     && __finishArg.indexOf('模型已结束，未执行自动验收') >= 0
     && __finishArg.indexOf('已完成 1/4 步') >= 0
     && __finishArg.indexOf('待处理步骤') >= 0
     && __finishArg.indexOf('被阻断步骤') >= 0
     && __stepCalls.length === 0
     && planCurrent.steps[0].status === 'pending'
     && planCurrent.steps[1].status === 'doing'
     && planCurrent.steps[3].status === 'blocked'
     && __finishStatus === 'blocked');

  // 全 done：才允许向下游传 done 终态
  planCurrent = mkPlan(); planCurrent.steps.forEach(x => { x.status = 'done'; });
  __stepCalls = []; __finishArg = null; __finishStatus = null;
  planFinishIfNatural(false, true);
  ok('all_done_finish_status', __finishStatus === 'done');

  // ③ 用户暂停（userStopped=true，即便 naturalDone）→ 不收尾
  planCurrent = mkPlan(); __stepCalls = []; __finishArg = null;
  planFinishIfNatural(true, true);
  ok('user_stopped_no_finish', __finishArg === null && __stepCalls.length === 0);

  // ④ 无计划 / 计划已终态 → 不收尾且不抛
  planCurrent = null; __finishArg = null;
  planFinishIfNatural(false, true);
  ok('no_plan_no_finish', __finishArg === null);
  planCurrent = mkPlan(); planCurrent.status = 'done'; __finishArg = null;
  planFinishIfNatural(false, true);
  ok('plan_done_no_finish', __finishArg === null);

  // ⑤ 60 轮上限路径（finished=false/naturalDone=false）同样不收尾
  planCurrent = mkPlan(); __finishArg = null;
  planFinishIfNatural(false, false);
  ok('round_cap_no_finish', __finishArg === null);
  return out;
}
""", 5)

    def test_source_natural_done_wiring(self):
        """结构侧：naturalDone 仅在「无工具调用」正常终结处置位。"""
        src = _fe('60-agent-loop.js')
        assert 'let naturalDone = false;' in src
        # 唯一置位点在正常终结块，并显式排除 length 截断路径
        i_nat = src.index("naturalDone = finishReason !== 'length';")
        i_fin = src.rindex('finished = true;', 0, i_nat)
        assert i_nat - i_fin < 200, 'naturalDone 置位点偏离正常终结路径'
        # ModelExecutor 终态结果投影 + run 状态镜像（初始 false / execution 投影），
        # 都不是额外自然完成判据；判据仍只在上方正常终结块。
        assert src.count('naturalDone =') == 5
        assert 'execution.naturalDone' in src
        assert 'planFinishIfNatural(userStopped, naturalDone);' in src


class TestPlanFinishTerminalStatus:
    """67-plan-card.js：摘要、徽标、toast 与落库终态必须一致。"""

    def test_blocked_and_default_done_stay_consistent(self):
        _run_js('plan_terminal_status', ['67-plan-card.js'], r"""
planCurrent = { task_id: 'tk-final', steps: [] };
planCardEl = document.body;
const __planUpdates = [];
const __planToasts = [];
function callApi(name, args) {
  if (name === 'plan_update') __planUpdates.push(args);
  return Promise.resolve('{}');
}
function scrollChat() {}
function toast(message, kind) { __planToasts.push({ message, kind }); }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  planFinish('仍有待处理步骤', 'blocked');
  const blockedBadge = document.getElementById('planBadge');
  ok('blocked_badge', blockedBadge.className === 'plan-badge blocked'
     && blockedBadge.textContent === '有未决事项');
  ok('blocked_plan_update', __planUpdates.length === 1
     && __planUpdates[0][0] === 'tk-final' && __planUpdates[0][1] === 'blocked');
  ok('blocked_toast', __planToasts.length === 1
     && __planToasts[0].kind === 'warn'
     && __planToasts[0].message.indexOf('有未决事项') >= 0);

  planFinish('全部完成');
  const doneBadge = document.getElementById('planBadge');
  ok('default_done_badge', doneBadge.className === 'plan-badge done'
     && doneBadge.textContent === '已完成');
  ok('default_done_plan_update', __planUpdates.length === 2
     && __planUpdates[1][1] === 'done');
  ok('default_done_toast', __planToasts.length === 2
     && __planToasts[1].kind === 'ok'
     && __planToasts[1].message.indexOf('任务完成') >= 0);
  return out;
}
""", 6)


# ============================================================ A2 项2：会话信任登记
_AGENT_GUARD_STUBS = r"""
const __calls = [];
let __trustThrows = false, __confirmCount = 0;
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'guard_session_trust' && __trustThrows) throw new Error('bridge gone');
  if (name === 'guard_check') return '{"action":"confirm","tier":"session"}';
  if (name === 'guard_confirm_token') return '{"ok":true,"token":"tk1"}';
  return '{}';
}
async function uiConfirm() { __confirmCount++;
  return { ok: true, checkbox: true }; }
function toast() {}
"""


class TestAgentTrustRegistration:
    """项2：guard_session_trust 登记失败 → 不进前端 Set（防 CONFIRM_REQUIRED 死循环）。"""

    def test_harness(self):
        out = _run_js('agent_trust', ['25-tool-exec.js'], _AGENT_GUARD_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 登记失败（桥异常）：前端 Set 不加 → 下次仍走确认（不死锁）
  __trustThrows = true; __confirmCount = 0;
  const r1 = await agentGuardCheck('web_search', { query: 'q1' });
  ok('reg_fail_not_trusted', agentTrusted.size === 0);
  ok('reg_fail_still_returns_token', r1 && r1.token === 'tk1' && r1.blocked === null);
  const r2 = await agentGuardCheck('web_search', { query: 'q1' });
  ok('reg_fail_reprompts', __confirmCount === 2
     && __calls.filter(c => c.name === 'guard_check').length === 2);

  // ② 登记成功：进 Set，二次调用前端短路（不再弹窗/不再 guard_check）
  __trustThrows = false; __confirmCount = 0; __calls.length = 0;
  await agentGuardCheck('web_search', { query: 'q2' });
  ok('reg_ok_trusted', agentTrusted.has('|web_search:q2'));   // R20：信任集按 runSid 键控（无 sid=空键）
  const before = __calls.length;
  const r3 = await agentGuardCheck('web_search', { query: 'q2' });
  ok('reg_ok_shortcircuit', __confirmCount === 1
     && __calls.length === before && r3.decision === 'session-trust' && r3.token === null);
  return out;
}
""", 5)


_GUARD_TOOL_STUBS = r"""
const __calls = [];
let __trustThrows = false, __confirmCount = 0;
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args });
  if (name === 'guard_session_trust' && __trustThrows) throw new Error('bridge gone');
  if (name === 'guard_check') return '{"action":"confirm"}';
  if (name === 'guard_confirm_token') return '{"token":"tk"}';
  if (name === 'guard_audit') return '{}';
  return '{}';
}
async function uiConfirm() { __confirmCount++;
  return { ok: true, checked: true }; }
function toast() {}
"""


class TestGuardToolTrustRegistration:
    """项2 孪生：26-guard.js guardCheckTool 同口径（登记失败不进 guardTrusted）。"""

    def test_harness(self):
        out = _run_js('guard_tool_trust', ['00-state.js', '26-guard.js'],
                      _GUARD_TOOL_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  // ① 登记失败：不进 guardTrusted，下次仍弹窗
  __trustThrows = true; __confirmCount = 0;
  const r1 = await guardCheckTool('clipboard_read', {});
  ok('tool_reg_fail_not_trusted', guardTrusted.size === 0 && r1.token === 'tk');
  await guardCheckTool('clipboard_read', {});
  ok('tool_reg_fail_reprompts', __confirmCount === 2);
  // ② 登记成功：进 Set 且短路
  __trustThrows = false; __confirmCount = 0;
  await guardCheckTool('clipboard_read', {});
  ok('tool_reg_ok_trusted', guardTrusted.has('|clipboard_read'));   // R20 键控
  const r2 = await guardCheckTool('clipboard_read', {});
  ok('tool_reg_ok_shortcircuit', __confirmCount === 1
     && r2.blocked === null && r2.token === null);
  return out;
}
""", 4)


# ============================================================ A3 项3：deleteSession 守卫
_DELETE_STUBS = r"""
const __calls = [];
const __toasts = [];
let __confirmResult = { ok: true };
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'session_purge')
    return '{"ok":true,"removed":{"sessions":1,"ws":0,"plans":1,"checkpoints":0}}';
  return '{}';
}
async function uiConfirm() { return __confirmResult; }
function toast(m) { __toasts.push(m); }
async function saveSessions() {}
function rememberDeletedSession() {}
function updateTokenStat() {}
function escapeHtml(s) { return String(s); }
function ensureHistoryFoot() {}
"""


class TestDeleteSessionGuards:
    """85-session-mgmt.js deleteSession：守卫矩阵 + 单一定义（无 monkey-patch 死代码）。"""

    def test_harness(self):
        out = _run_js('delete_session', ['00-state.js', '85-session-mgmt.js'],
                      _DELETE_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 流式中删「当前会话」→ 拦截（不弹确认、不动数据）
  sessions = [{ id: 's1', title: 'a', updatedAt: 1, messages: [] }];
  currentSessionId = 's1'; isStreaming = true;
  let threw = false;
  try { await deleteSession('s1', { stopPropagation: function () {} }); }
  catch (e) { threw = true; }
  ok('stream_current_blocked', !threw && __calls.length === 0
     && sessions.length === 1 && __toasts.some(t => t.indexOf('正在生成') >= 0));

  // ② 流式中删「非当前会话」→ 放行（守卫只护当前会话），带 plan.task_id 走 purge
  sessions = [{ id: 's1', title: 'a', updatedAt: 1, messages: [] },
              { id: 's2', title: 'b', updatedAt: 2, messages: [],
                plan: { task_id: 'tk_20261021_abc' } }];
  currentSessionId = 's1'; isStreaming = true; __calls.length = 0;
  await deleteSession('s2', { stopPropagation: function () {} });
  const purge = __calls.find(c => c.name === 'session_purge');
  ok('stream_noncurrent_allowed', purge
     && purge.args[0] === 's2' && purge.args[1] === '["tk_20261021_abc"]'
     && purge.timeoutMs === 30000 && sessions.length === 1
     && sessions[0].id === 's1');

  // ③ 程序调用（e=undefined）→ typeof 守卫不 NPE
  isStreaming = false; __calls.length = 0;
  sessions = [{ id: 's1', title: 'a', updatedAt: 1, messages: [] }];
  currentSessionId = 'other';
  threw = false;
  try { await deleteSession('s1'); } catch (e) { threw = true; }
  ok('programmatic_no_npe', !threw && __calls.some(c => c.name === 'session_purge'));

  // ④ 无 plan 会话 → taskIds '[]'
  sessions = [{ id: 's3', title: 'c', updatedAt: 1, messages: [] }];
  currentSessionId = 'other'; __calls.length = 0;
  await deleteSession('s3', null);
  const purge2 = __calls.find(c => c.name === 'session_purge');
  ok('no_plan_empty_taskids', purge2 && purge2.args[1] === '[]');

  // ⑤ 确认取消 → 不删
  sessions = [{ id: 's4', title: 'd', updatedAt: 1, messages: [] }];
  currentSessionId = 'other'; __confirmResult = { ok: false }; __calls.length = 0;
  await deleteSession('s4', { stopPropagation: function () {} });
  ok('cancel_keeps_session', sessions.length === 1
     && !__calls.some(c => c.name === 'session_purge'));
  __confirmResult = { ok: true };
  return out;
}
""", 5)

    def test_single_definition_no_monkeypatch(self):
        """项3 结构侧：文件内 deleteSession 单一定义，无 _origDeleteSession 别名残留。"""
        src = _strip_comments(_fe('85-session-mgmt.js'))
        assert src.count('async function deleteSession') == 1
        assert 'deleteSession = async function' not in src
        assert '_origDeleteSession' not in src
        assert 'e && typeof e.stopPropagation' in src


# ============================================================ A4 项7：obTestKey 口径
_OB_STUBS = r"""
const __calls = [];
let __base = '', __model = '', __key = '', __local = false, __inputKey = '';
let __gate = null;
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'test_provider_endpoint' && __gate) await __gate;
  return '{"ok":true}';
}
function queueSaveConfig() {}
function toast() {}
function connectBaseUrl() { return __base; }
function connectModelValue() { return __model; }
function connectApiKeyInput() { return __key; }
function connectIsLocalPreset() { return __local; }
obRoot = { querySelector: function (sel) {
  if (sel === '#obKey') return { value: __inputKey };
  return { textContent: '', className: '' };
} };
"""


class TestObTestKeyAlignment:
    """68-onboarding.js obTestKey：与 connectTestNow 逐字段对齐（key/local/timeout）。"""

    def test_harness(self):
        out = _run_js('ob_test_key', ['68-onboarding.js'], _OB_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 云端预设：key 透传 + local=false + 15s/20s
  __base = 'https://api.deepseek.com/v1'; __model = 'deepseek-flash';
  __key = 'sk-ds'; __local = false; __inputKey = 'sk-ds';
  __calls.length = 0;
  await obTestKey();
  const c1 = __calls.find(c => c.name === 'test_provider_endpoint');
  ok('cloud_passes_key', c1 && c1.args[0] === 'https://api.deepseek.com/v1'
     && c1.args[1] === 'sk-ds' && c1.args[2] === 'deepseek-flash'
     && c1.args[3] === 15 && c1.args[4] === false && c1.timeoutMs === 20000);

  // ② 本地系预设：免 Key 放行（空 key 不拦）+ key 传 '' + local=true + 30s/90s
  __base = 'http://localhost:11434/v1'; __model = 'gpt-oss-20b';
  __key = ''; __local = true; __inputKey = '';
  __calls.length = 0;
  await obTestKey();
  const c2 = __calls.find(c => c.name === 'test_provider_endpoint');
  ok('local_keyless_allowed', c2 && c2.args[1] === '' && c2.args[4] === true
     && c2.args[3] === 30 && c2.timeoutMs === 90000);

  // ③ 云端空 key → 前置拦截（不发调用）
  __local = false; __key = ''; __inputKey = '';
  __calls.length = 0;
  await obTestKey();
  ok('cloud_empty_key_blocked',
     !__calls.some(c => c.name === 'test_provider_endpoint'));

  // ④ 防连点：在途忽略第二次点击（不发起第二次调用）
  __local = false; __key = 'sk-x'; __inputKey = 'sk-x';
  let __release;
  __gate = new Promise(r => { __release = r; });
  const p1 = obTestKey();
  const after1 = __calls.length;
  const r2 = obTestKey();   // 在途 → 直接 return（同步路径，不发调用）
  const r2v = await r2;
  ok('debounce_second_ignored', r2v === undefined && __calls.length === after1);
  __release(); __gate = null;
  await p1;
  return out;
}
""", 4)


# ============================================================ A5 项8：ctxMenu Esc
class TestCtxMenuEsc:
    """105-context-menu.js：Esc 关闭右键菜单（浮层守卫的另一半）。"""

    def test_harness(self):
        out = _run_js('ctx_esc', ['105-context-menu.js'], '', r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const ev = () => ({ preventDefault: function () {},
    stopPropagation: function () {}, clientX: 20, clientY: 20,
    selectionStart: 0, selectionEnd: 0 });
  setupContextMenu();
  const input = __doc.getElementById('userInput');
  input.dispatch('contextmenu', ev());
  const menu = __byId['ctxMenu'];
  ok('menu_opened', menu && menu.classList.contains('show'));
  // Esc（document keydown）→ 关闭
  __doc.dispatch('keydown', { key: 'Escape' });
  ok('esc_closes_menu', !menu.classList.contains('show'));
  // 再开 → 点文档关闭仍在（click 路径不回归）
  input.dispatch('contextmenu', ev());
  ok('menu_reopen', menu.classList.contains('show'));
  __doc.dispatch('click', { target: { closest: function () { return null; } } });
  ok('click_closes_menu', !menu.classList.contains('show'));
  return out;
}
""", 4)


# ============================================================ A6 项11：grant 定时器
_GRANT_STUBS = r"""
const __resp = {
  guard_task_status: { ok: true, active: false },
  guard_task_grant: { ok: true, grant_id: 'g_1', remaining_s: 7200,
    expiring_soon: false },
  guard_task_revoke: { ok: true, revoked: true },
  guard_rule_list: { ok: true, rules: [] }
};
async function callApi(name) {
  const r = __resp[name];
  return r === undefined ? '{}' : JSON.stringify(r);
}
function toast() {}
"""


class TestGrantTimers:
    """66-guard-grant.js：ggActive=false 时定时器停止（原永不停止的空转）。"""

    def test_harness(self):
        out = _run_js('grant_timers', ['66-guard-grant.js'], _GRANT_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  __qsa['.header-right'] = __mkEl('headerRight');
  __qsa['.set-grid'] = __mkEl('setGrid');
  __doc.getElementById('ggTtl').value = '14400';

  // ① init + status(active=false) → 无定时器（原 init 无条件启，永久空转）
  ok('init_true', guardGrantInit() === true);
  await __flush(); await __flush();
  ok('idle_no_timers', ggCountdownTimer === null && ggCalibrateTimer === null
     && __intervals.length === 0);

  // ② 创建授权 → 启（1s 倒计时 + 30s 校准）
  const cb = __mkEl(''); cb.checked = true; cb.value = 'exec';
  __qsaAll['.gg-scope'] = [cb];
  await guardGrantCreate();
  ok('grant_starts_timers', ggCountdownTimer !== null && ggCalibrateTimer !== null
     && __intervals.length === 2
     && __intervals.some(h => h.ms === 1000 && !h.cleared)
     && __intervals.some(h => h.ms === 30000 && !h.cleared));

  // ③ 收回 → 停（句柄清 + 计时器标记 cleared）
  await guardGrantRevoke();
  ok('revoke_stops_timers', ggCountdownTimer === null && ggCalibrateTimer === null
     && __intervals.every(h => h.cleared));

  // ④ status 校准发现 active → 重启；再报 inactive → 停
  __resp.guard_task_status = { ok: true, active: true, remaining_s: 100,
    expiring_soon: false };
  await guardGrantRefreshStatus();
  ok('calibrate_restarts', ggCountdownTimer !== null);
  __resp.guard_task_status = { ok: true, active: false };
  await guardGrantRefreshStatus();
  ok('expire_stops', ggCountdownTimer === null && ggCalibrateTimer === null);
  guardGrantStopTimers();
  return out;
}
""", 4)


# ============================================================ A7 项12：toast pinned
class TestToastPinnedEviction:
    """18-toast.js：溢出淘汰跳过 pinned；全 pinned 不淘汰。"""

    def test_harness(self):
        out = _run_js('toast_pinned', ['18-toast.js'], '', r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  toast('warmup', 'err');   // _toastBox 懒创建：首条 toast 后才注册 #toastBox
  const box = __byId['toastBox'];

  // ① 队首 pinned：第 6 条溢出淘汰第一个非 pinned（pinned 存活）
  box.children.length = 0;
  const a = toast('长流程进度', 'info', { pinned: true });
  const b = toast('b', 'err'); const c = toast('c', 'err');
  const d = toast('d', 'err'); const e = toast('e', 'err');
  ok('five_kept', box.children.length === 5);
  const f = toast('f', 'err');   // 溢出
  ok('pinned_survives', box.children.indexOf(a) >= 0
     && box.children.indexOf(b) < 0 && box.children.length === 5);
  ok('victim_is_first_nonpinned', box.children[0] === a
     && box.children[1] === c);

  // ② 全 pinned：不淘汰（允许超过 5 条）
  box.children.length = 0;
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(toast('p' + i, 'info', { pinned: true }));
  ok('all_pinned_no_evict', box.children.length === 6
     && ps.every(p => box.children.indexOf(p) >= 0));

  // ③ close 句柄仍在（调用方可收尾 pinned）
  ok('close_handle', typeof a.close === 'function');
  return out;
}
""", 3)


# ============================================================ A8 项16a：识别按钮文案
class TestIdentifyButtonRefresh:
    """36-connect.js connectSetButtonLoading：识别按钮按当前预设重刷。"""

    def test_harness(self):
        out = _run_js('identify_btn', ['36-connect.js'], '', r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  // 识别按钮：glm 加载中切到 ollama（connectApplyPresetNow 已改 innerHTML），
  // dataset.html 快照仍是 glm 旧文案 → 还原必须按当前预设，不是陈旧快照
  const btn = __mkEl('button'); btn.id = 'cmIdentifyBtn';
  btn.innerHTML = '↻ 获取模型';
  connectSetButtonLoading(btn, true, '获取中');
  ok('loading_state', btn.disabled === true && btn.dataset.html === '↻ 获取模型'
     && btn.innerHTML.indexOf('获取中') >= 0);
  connectPreset = 'ollama';
  btn.innerHTML = '↻ 探测本机';   // 预设切换留下的新文案
  connectSetButtonLoading(btn, false);
  ok('refresh_by_current_preset', btn.innerHTML === '↻ 探测本机'
     && btn.disabled === false && btn.dataset.html === undefined);

  // 非识别按钮（文案静态）：dataset.html 还原仍正确
  const btn2 = __mkEl('button'); btn2.id = 'providerTestBtn';
  btn2.innerHTML = '测试连接';
  connectSetButtonLoading(btn2, true, '测试中');
  btn2.innerHTML = '<span class="tool-spinner"></span><span>测试中</span>';
  connectSetButtonLoading(btn2, false);
  ok('static_btn_restores_snapshot', btn2.innerHTML === '测试连接');
  return out;
}
""", 3)


# ============================================================ A9 项16b：stale 复位
_LOCAL_LOAD_STUBS = r"""
const __pending = {};
let __n = 0;
async function callApi(name, args) {
  const k = ++__n;
  return new Promise(res => { __pending[k] = res; });
}
function toast() {}
"""


class TestLocalLoadStaleRestore:
    """34-local-model.js localLoadModels：stale 请求 finally 不抢复位在途按钮。"""

    def test_harness(self):
        out = _run_js('stale_restore', ['34-local-model.js'],
                      _LOCAL_LOAD_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  // localEl('localModelsBtn','cmIdentifyBtn') 老 id 优先——测试取同一元素
  const btn = __doc.getElementById('localModelsBtn');
  __doc.getElementById('localModelSelect');   // 老 id 存在 → 老路径（不依赖 connectFillModels）

  // 并发两轮加载（旧 base A / 新 base B）
  const pA = localLoadModels('http://127.0.0.1:11434/v1');
  ok('A_loading', btn.disabled === true && btn.textContent === '拉取中…');
  const pB = localLoadModels('http://127.0.0.1:1234/v1');
  ok('B_loading', btn.disabled === true && btn.textContent === '拉取中…');

  // A 陈旧返回 → finally 不得复位（按钮所有权归 B）
  __pending[1]('{"ok":true,"models":[]}');
  await pA; await __flush(); await __flush();
  ok('stale_keeps_loading', btn.disabled === true && btn.textContent === '拉取中…');

  // B 新鲜返回 → finally 复位
  __pending[2]('{"ok":true,"models":[]}');
  await pB; await __flush(); await __flush();
  ok('fresh_restores', btn.disabled === false);
  return out;
}
""", 4)


# ============================================================ A10 项6：memoryPanelInit 幂等
_MEM_STUBS = r"""
async function callApi(name) {
  if (name === 'get_memory') return '[]';
  return '{}';
}
function toast() {}
"""


class TestMemoryPanelIdempotent:
    """69-memory-panel.js：重复挂载不注入第二个 #memoryBlock（项6 行为侧）。"""

    def test_harness(self):
        out = _run_js('mem_idem', ['69-memory-panel.js'], _MEM_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  // 关 auto-create：mmEl('memoryBlock') 必须真实不存在才走创建分支
  // （桩默认 auto-create 会让「不存在」永远为真，幂等分支被首轮误触发）
  __setAutoCreate(false);
  __qsa['.set-grid'] = __mkEl('setGrid');
  const grid = __qsa['.set-grid'];

  ok('first_mount', memoryPanelInit() === true);
  await __flush();
  const count1 = grid.children.filter(c => c.id === 'memoryBlock').length;
  ok('second_mount_idempotent', memoryPanelInit() === true);
  const count2 = grid.children.filter(c => c.id === 'memoryBlock').length;
  ok('single_block', count1 === 1 && count2 === 1);
  return out;
}
""", 3)


# ============================================================ A11 项9：msgRecall 守卫
_RECALL_STUBS = r"""
const __toasts = [];
let __s = null, __switchCalled = 0, __saveCalled = 0, __getCalled = 0;
function toast(m) { __toasts.push(m); }
function getCurrentSession() { __getCalled++; return __s; }
function saveSessions() { __saveCalled++; }
function switchSession() { __switchCalled++; }
"""


class TestMsgRecallGuards:
    """50-markdown.js msgRecall：isStreaming 守卫 + midx 边界矩阵。"""

    def test_harness(self):
        out = _run_js('msg_recall', ['00-state.js', '50-markdown.js'],
                      _RECALL_STUBS, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const input = __doc.getElementById('userInput');

  // ① 流式中 → toast + return（不碰会话）
  isStreaming = true; __s = { messages: [{ role: 'user', content: 'x' }] };
  __getCalled = 0; __saveCalled = 0;
  msgRecall({ dataset: { midx: '0' } }, 'x');
  ok('streaming_guard', __toasts.some(t => t.indexOf('正在生成') >= 0)
     && __getCalled === 0 && __saveCalled === 0);

  // ② midx 越界 → 无法撤回 toast
  isStreaming = false; __toasts.length = 0;
  __s = { messages: [{ role: 'user', content: 'x' }] };
  msgRecall({ dataset: { midx: '5' } }, 'x');
  ok('oob_midx', __toasts.some(t => t.indexOf('无法撤回') >= 0) && __saveCalled === 0);

  // ③ midx=NaN（无 stamp）→ 无法撤回
  __toasts.length = 0;
  msgRecall({ dataset: {} }, 'x');
  ok('nan_midx', __toasts.some(t => t.indexOf('无法撤回') >= 0));

  // ④ midx 指向非 user（system）→ 无法撤回
  __toasts.length = 0;
  __s = { messages: [{ role: 'system', content: 'log' },
                      { role: 'user', content: 'x' }] };
  msgRecall({ dataset: { midx: '0' } }, 'x');
  ok('non_user_midx', __toasts.some(t => t.indexOf('无法撤回') >= 0));

  // ⑤ 非末尾轮（该轮之后还有 user）→ 只撤最新轮 toast
  __toasts.length = 0; __saveCalled = 0;
  __s = { messages: [{ role: 'user', content: 'x' },
                      { role: 'assistant', content: 'y' },
                      { role: 'user', content: 'z' }] };
  msgRecall({ dataset: { midx: '0' } }, 'x');
  ok('non_tail_turn', __toasts.some(t => t.indexOf('只能撤回最新') >= 0)
     && __s.messages.length === 3 && __saveCalled === 0);

  // ⑥ 末尾轮 → splice + 保存 + 重渲染 + 内容回输入框
  __toasts.length = 0; __saveCalled = 0; __switchCalled = 0;
  __s = { messages: [{ role: 'user', content: 'hello' },
                      { role: 'assistant', content: 'hi' }] };
  currentSessionId = 's1';
  msgRecall({ dataset: { midx: '0' } }, 'hello');
  ok('tail_turn_recall', __s.messages.length === 0 && __saveCalled === 1
     && __switchCalled === 1 && input.value === 'hello'
     && __toasts.some(t => t.indexOf('已撤回') >= 0));
  return out;
}
""", 6)


# ============================================================ B 静态核对
class TestStaticRound5Verification:
    """第一/二部分中无头 DOM 无法行为化的项：静态核对（特异性/令牌/顺序）。"""

    # ---- 项4：plan.task_id 白名单放行 + taskIds 传参形态 ----
    def test_item4_plan_task_id_whitelist(self):
        store = _fe('65-session-store.js')
        assert 's.plan = { task_id: String(x.plan.task_id) }' in store
        mgmt = _fe('85-session-mgmt.js')
        assert 'JSON.stringify([s.plan.task_id])' in mgmt
        assert "callApi('session_purge', [id, taskIds], 30000)" in mgmt

    # ---- 项5：玻璃变量双主题定义 + 历史面板只用已定义变量 ----
    def test_item5_glass_vars_both_themes(self):
        tpl = read_frontend_styles(PROJECT_ROOT)
        root_block = tpl.split('body.dark{')[0]
        dark_block = tpl.split('body.dark{')[1].split('}')[0]
        for v in ('--glass-bg-2', '--glass-border', '--glass-blur', '--surface-2',
                  '--card-bg', '--text-3', '--main-veil', '--shadow-lg', '--edge-hi'):
            assert (v + ':') in root_block, v + ' 缺 :root 定义'
            assert (v + ':') in dark_block, v + ' 缺 body.dark 定义'
        # 历史面板样式在模板内（IIFE 已删，官方样式承载）
        assert '.history-dir-panel{' in tpl and '.hd-btn{' in tpl
        assert 'const _hdStyle' not in _fe('85-session-mgmt.js')
        assert '_hdStyle =' not in _strip_comments(_fe('85-session-mgmt.js'))

    # ---- 项10：msg-time / shortcutsBtn / fx-off ----
    def test_item10_msg_time_and_fxoff(self):
        tpl = read_frontend_template_with_styles(PROJECT_ROOT)
        # user 隐藏规则必须后置于 order:-1 规则（同特异性 .message.user .msg-time，源序定胜负）
        i_order = tpl.index('.message.user .msg-time{order:-1}')
        i_hide = tpl.index('.message.user .msg-time{display:none}')
        assert i_hide > i_order, 'user 隐藏规则未后置，order:-1 会生效'
        assert '.message.assistant .msg-time{position:absolute;top:12px;right:4px' in tpl
        # shortcutsBtn 单定义 + src 无 getElementById 引用断裂
        assert tpl.count('id="shortcutsBtn"') == 1
        for f in script_paths(PROJECT_ROOT):
            assert "getElementById('shortcutsBtn')" not in _fe(f), f
        # fx-off：set-window/modal-card 入场停；非 fx-off 动画定义仍在
        assert 'body.fx-off .set-window,body.fx-off .modal-card{animation:none}' in tpl
        assert 'animation:v4SetWinIn var(--dur-panel) var(--ease-spring)' in tpl
        assert 'animation:v4ModalIn var(--dur-comp) var(--ease-spring)' in tpl

    # ---- 项13：硬编码毫秒令牌化 ----
    def test_item13_motion_tokens(self):
        checks = [
            ('85-session-mgmt.js', ['setTimeout(() => mask.remove(), 800)',
                                    'setTimeout(() => mask.remove(), 600)'],
             '_hdLingerMs'),
            ('18-toast.js', ["setTimeout(() => m.querySelector('.modal-ok').focus(), 30)",
                             "setTimeout(() => { input.focus(); input.select && input.select(); }, 30)"],
             'MOTION.press'),
            ('72-shortcuts.js', ["setTimeout(() => { const b = card.querySelector('.sc-ok'); if (b) b.focus(); }, 60)"],
             'MOTION.staggerSm'),
            ('60-agent-loop.js', ['}, 350);'], 'MOTION.comp() * 2'),
        ]
        for fname, dead_literals, token in checks:
            src = _fe(fname)
            for lit in dead_literals:
                assert lit not in src, '%s 残留硬编码: %s' % (fname, lit)
            assert token in src, '%s 缺 MOTION 令牌: %s' % (fname, token)

    # ---- 项14：initFx 在 loadAll 首个 await 之前 ----
    def test_item14_initfx_before_first_await(self):
        src = _fe('110-boot.js')
        body = _strip_comments(src).split('async function loadAll()')[1]
        i_fx = body.index('initFx();')
        i_await = body.index('await')   # 剥注释后首个真实 await 语句
        assert i_fx < i_await, 'initFx 仍在首个 await 之后'

    # ---- 项15：回退中性态 + 晚到补偿 + get_api_info 唯一住处 ----
    def test_item15_boot_fallback_neutral(self):
        src = _strip_comments(_fe('110-boot.js'))
        assert "backendWarning = '◇ 等待后端就绪" in src
        assert 'function bridgeLateReady()' in src
        assert 'bridgeLateReady();' in src
        assert 'async function bridgeDependentInit()' in src
        assert src.count("callApi('get_api_info'") == 1
        # get_api_info 调用点在 bridgeDependentInit 内（不在 loadAll 主体）
        load_all = src.split('async function loadAll()')[1].split('async function bridgeDependentInit')[0]
        assert 'get_api_info' not in load_all

    # ---- 项8：Esc 浮层守卫选择器与实际一致 ----
    def test_item8_esc_overlay_selectors(self):
        src = _fe('10-custom-select.js')
        assert '#searchPanel.show' in src and '#wsqMenu.show' in src
        assert '#ctxMenu.show' in src and '.sc-mask' in src
        sp = _fe('63-search-panel.js')
        assert "panel.classList.add('show')" in sp
        wsq = _fe('38-ws-quick.js')
        assert "menu.classList.add('show')" in wsq
        ctxm = _fe('105-context-menu.js')
        assert "menu.classList.add('show')" in ctxm
        assert "e.key === 'Escape' && menu.classList.contains('show')" in ctxm

    # ---- 项11：定时器停止路径在位（剥注释后判定） ----
    def test_item11_grant_timer_paths(self):
        src = _strip_comments(_fe('66-guard-grant.js'))
        assert 'if (ggActive) guardGrantStartTimers(); else guardGrantStopTimers();' in src
        assert 'guardGrantStartTimers();' in src   # 创建授权路径（revoke 后重建）
        assert 'guardGrantStopTimers();' in src    # 收回路径
        init_body = src.split('function guardGrantInit()')[1].split('function guardGrantWire')[0]
        assert 'guardGrantStartTimers()' not in init_body

    # ---- 项2：agentTrusted 切会话清空 + 登记 await 化 ----
    def test_item2_agent_trust_cleared_on_switch(self):
        src = _fe('85-session-mgmt.js')
        assert src.count('agentTrusted.clear()') == 2   # newSession + switchSession
        te = _fe('25-tool-exec.js')
        assert "await callApi('guard_session_trust', [op], 20000);" in te
        assert re.search(r"agentTrusted\.add\(String\(runSid \|\| ''\) \+ '\|' \+ trustKey\);", te) or "agentTrusted.add(String(runSid || '') + '|' + trustKey);" in te   # R20 键控

    # ---- 项6：memoryPanelInit 挂载有 catch + 幂等 ----
    def test_item6_memory_panel_mount(self):
        boot = _fe('110-boot.js')
        assert "try { memoryPanelInit(); } catch (e) { console.warn('记忆面板初始化失败', e); }" in boot
        mp = _fe('69-memory-panel.js')
        assert "if (mmEl('memoryBlock')) { memoryPanelWire(); return true; }   // 幂等" in mp

    # ---- 项7：onboardingInit 位置（loadSessions + connectLoadFromConfig 之后） ----
    def test_item7_onboarding_after_config(self):
        src = _fe('110-boot.js')
        i_sessions = src.index('await loadSessions();')
        i_cfg = src.index('connectLoadFromConfig(cfg)')
        i_ob = src.index('onboardingInit();')
        assert i_sessions < i_ob and i_cfg < i_ob


# ============================================================ C 项4 后端闭环
class TestPurgeMaliciousTaskIdClosedLoop:
    """项4 闭环：WebDAV 恢复的恶意 plan.task_id → session_purge skip+warning，
    purge 整体仍 ok（前端不需要额外 strip；既有后端行为固化）。"""

    def test_malicious_tid_skipped_purge_ok(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.save_sessions('[{"id":"s1","title":"t","messages":[]}]')
        bad = json.dumps(['../../etc/passwd', 'a' * 100, 'C:\\windows', 'ok_tid'])
        r = json.loads(api.session_purge('s1', bad))
        assert r['ok'] is True
        assert r['removed']['sessions'] == 1
        # 合法 tid 仍被清理；恶意 tid 被跳过（不抛、不中断）
        from backend.domains.planning import plan_service as ps
        assert not os.path.exists(ps._task_path('ok_tid'))
        for bad_tid in ('../../etc/passwd', 'a' * 100, 'C:\\windows'):
            with pytest.raises(ValueError):
                ps._safe_tid(bad_tid)

    def test_normalize_sessions_roundtrip_keeps_plan(self):
        """保存/加载往返后 plan.task_id 存活（normalizeSessions 白名单）。"""
        r = subprocess.run([NODE, '-e', r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const sand = {};
require('vm').runInNewContext(src + '\n;globalThis.__out = normalizeSessions(' +
  'JSON.stringify([{id:"s1",title:"t",updatedAt:1,messages:[],plan:{task_id:"tk_1"}}]));',
  sand);
const s = sand.__out[0];
console.log(JSON.stringify({ plan: s.plan, ok: s.plan && s.plan.task_id === 'tk_1' }));
""", os.path.join(PROJECT_ROOT, resolve_script(PROJECT_ROOT, '65-session-store.js'))], capture_output=True, text=True, timeout=30)
        assert r.returncode == 0, r.stderr
        out = json.loads(r.stdout)
        assert out['ok'] is True and out['plan']['task_id'] == 'tk_1'
