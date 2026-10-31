# -*- coding: utf-8 -*-
"""第七轮·第五轮前端面板修复对抗性证伪 + 遗留项确认（2026-10-21）。

背景：第五轮（077e8e1）前端面板修复此前未做对抗性证伪（该批次代理被中断）。
本文件对任务书 A-F 六组 15 项 + G 组遗留项逐条构造反例/推演/vm 验证：

A. 63-search-panel.js
   1. finally seq 复检（早退路径 vs 正常路径终态一致）+「旧请求 finally 晚于
      新分支」反例构造与证伪 + CAPTCHA_REQUIRED 重试分支解禁（round5 死局）
   2. 接管取代竞态（pending 期轮询挂接 / 终态僵尸门控 / 成功路径清洗）
      + href 白名单行为矩阵（大写 scheme / 协议相对 / fragment / 危险协议）
   3. hideTakeover 状态复位（captcha 不卡死面板关闭）
   4. 遗留项：接管 TTL 600s 到期前 60s 一次性提示
B. 64-software-panel.js
   5. swTesting 与 swProbing 交互（独立 swTestSeq）+ 陈旧路径 finally 三清
      （timer/按钮/swTesting）+ swCallElapsed 复位 + swDetail 在途保护
C. 65-hybrid.js
   6. hyRdSeq 陈旧丢弃后按钮态 + NaN 校验单字段回弹（不清兄弟字段）
      + connectIsLocalPreset 不存在时降级
D. 67-plan-card.js
   7. planShow 在途 reject 的错误形状（无 unhandled rejection）
      + rbTwice RPC 失败恢复（不永禁）+ 三连点单次 RPC + allDefault/部分选择
E. 69-memory-panel.js
   8. 删除前重取比对的等长位移检出（中段淘汰/前部截尾）+ MM_FEATURE_KEY 关闭
      + 信封错误分支
F. 29-mcp / 37-webdav / 38-ws-quick / 90-attachments / 95-compress / 27-update / 16-panel-fx
   9-15. 逐项行为验证/静态推演
G. 遗留确认：mcpResBusyUri 与 KNOWN_ISSUES §八.21 文档一致 /
   34-local-model stale 复位 seq 判定 / 36-connect cmIdentifyBtn 文案分支

harness 口径同 test_round6_adversarial（node 单脚本：模块源码 + 顶层桩 + 测试体
同一 script 作用域；并发时序用「门控 promise」确定性放行，不依赖真实定时器）。
"""
import io
import json
import os
import re
import subprocess
import tempfile

import pytest

from helpers.frontend import read_frontend_source

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _strip_comments(src):
    """剥块注释 + 行注释（仅用于源码在位性判定）。"""
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    src = re.sub(r'^\s*//.*$', '', src, flags=re.M)
    return src


# ---------------------------------------------------------------- 桩头（单脚本）
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
      add: function () { for (let i = 0; i < arguments.length; i++) el._cls.add(arguments[i]); },
      remove: function () { for (let i = 0; i < arguments.length; i++) el._cls.delete(arguments[i]); },
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
const __timers = [];
function setTimeout(fn, ms) { __timers.push({ fn: fn, ms: ms }); return __timers.length; }
function clearTimeout() {}
function setInterval(fn, ms) { const h = { fn: fn, ms: ms, cleared: false };
  __intervals.push(h); return h; }
function clearInterval(h) { if (h) h.cleared = true; }
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

_FLUSH = r"""
const __flush = () => new Promise(r => process.nextTick(r));
const __flush5 = async () => { for (let i = 0; i < 6; i++) await new Promise(r => process.nextTick(r)); };
// 深文本序列化（textContent + innerHTML + 递归 children）——渲染断言用
function __ser(el) {
  let s = (el && el.textContent) || '';
  s += (el && el._html) || '';
  ((el && el.children) || []).forEach(c => { s += __ser(c); });
  return s;
}
"""

# 门控 IPC：browser_search/browser_takeover 等在途请求挂起，测试体 __release 放行
_GATE = r"""
const __calls = [];
const __resp = {};
const __waiters = new Map();
function __gate(name) { if (!__waiters.has(name)) __waiters.set(name, []); }
function __release(name) { const a = __waiters.get(name) || []; const r = a.shift(); if (r) r(); }
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (__waiters.has(name)) await new Promise(res => __waiters.get(name).push(res));
  const r = __resp[name];
  return r === undefined ? '{}' : JSON.stringify(r);
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg: msg, kind: kind }); }
const __notifies = [];
function harborTakeoverNotify(p) { __notifies.push(p); }
"""


def _run_js(name, modules, stubs, body, checks_min):
    """modules: 模块文件名（按序拼接）；stubs: 顶层桩 JS；body: __main 定义。"""
    if not os.path.exists(NODE):
        pytest.skip('node 不可用: %s' % NODE)
    js = _HEAD
    for fname in modules:
        js += '\n/* ===== %s ===== */\n' % fname + _fe(fname)
    js += '\n/* ===== stubs ===== */\n' + stubs + '\n' + body + _MAIN
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_r7_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True, timeout=90)
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


# ============================================================ A 组：63-search-panel
class TestSearchFinallySeq:
    """A1：finally seq 复检 + 旧 finally 晚于新分支反例 + 重试分支解禁。"""

    def test_harness(self):
        out = _run_js('search_finally', ['63-search-panel.js'],
                      _GATE + _FLUSH, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const el = (id) => document.getElementById(id);
  const CAPTCHA = (tk) => ({ ok: false, error: { code: 'CAPTCHA_REQUIRED',
    message: '需要验证', takeover_id: tk } });

  searchPanelInit();
  __gate('browser_search'); __gate('browser_takeover');

  // ① 正常路径终态一致：成功 → 按钮恢复 + indet 移除
  __resp['browser_search'] = { ok: true, query: 'q1', engine: 'bing', source: 'live',
    results: [{ title: 'R1', url: 'https://a.com', position: 1 }] };
  const p0 = searchPanelRunSearch({ query: 'q1' });
  __release('browser_search');
  await p0; await __flush5();
  ok('normal_final_state', el('spSearchBtn').disabled === false
     && !el('spProgressBar').classList.contains('indet')
     && searchPanelState === 'success');

  // ② 陈旧早退路径：慢旧请求被快新请求覆盖 → 旧 finally 不抢终态
  __resp['browser_search'] = { ok: true, query: 'slow', engine: 'bing', source: 'live',
    results: [{ title: 'SLOW', url: 'https://s.com', position: 1 }] };
  const p1 = searchPanelRunSearch({ query: 'slow' });        // 旧（seq 小）在途
  __resp['browser_search'] = { ok: true, query: 'fast', engine: 'bing', source: 'live',
    results: [{ title: 'FAST', url: 'https://f.com', position: 1 }] };
  const p2 = searchPanelRunSearch({ query: 'fast' });        // 新（seq 大）覆盖
  __release('browser_search');                                // 先放行旧的
  await __flush5();
  __release('browser_search');                                // 再放行新的
  await p1; await p2; await __flush5();
  ok('stale_early_return_consistent', el('spSearchBtn').disabled === false
     && !el('spProgressBar').classList.contains('indet')
     && searchPanelState === 'success'
     && __ser(el('spResults')).indexOf('FAST') >= 0
     && __ser(el('spResults')).indexOf('SLOW') < 0);

  // ③ 反例构造：takeoverAction 在途（seq=A）→ 新搜索取代（seq=B）→
  //    旧 finally 晚于新分支返回：不得解禁/破坏新分支的按钮态
  __resp['browser_search'] = CAPTCHA('tk_old');
  const pCap = searchPanelRunSearch({ query: 'cap' });
  __release('browser_search');
  await pCap; await __flush5();
  ok('takeover_shown', searchTakeoverId === 'tk_old' && searchPanelState === 'captcha'
     && el('spTakeover').style.display === '' && el('spTakeoverContinue').disabled === false);
  __resp['browser_takeover'] = CAPTCHA('tk_old');             // 旧动作：仍验证页
  const pA = searchPanelTakeoverAction('continue');           // 在途：按钮禁用
  ok('action_inflight_disabled', el('spTakeoverContinue').disabled === true
     && el('spTakeoverAbort').disabled === true);
  __resp['browser_search'] = { ok: true, query: 'new', engine: 'bing', source: 'live',
    results: [{ title: 'NEW', url: 'https://n.com', position: 1 }] };
  const pB = searchPanelRunSearch({ query: 'new' });          // 取代：notify + hide
  ok('supersede_releases_buttons', el('spTakeoverContinue').disabled === false
     && el('spTakeoverAbort').disabled === false
     && searchTakeoverId === null
     && __notifies.some(n => n && n.error && n.error.code === 'CAPTCHA_ABORTED'));
  __release('browser_takeover');                              // 旧 finally 此刻才跑
  await pA; await __flush5();
  ok('old_finally_no_unblock', el('spTakeoverContinue').disabled === false
     && el('spTakeoverAbort').disabled === false
     && searchPanelState === 'pending');
  __release('browser_search');
  await pB; await __flush5();
  ok('new_branch_renders', searchPanelState === 'success'
     && __ser(el('spResults')).indexOf('NEW') >= 0);

  // ④ 重试分支：后端回到 prompting 等用户再次 continue → 按钮必须解禁
  //    （round5 反例：保持禁用 → toast「请重试」与禁用按钮矛盾 → 死局）
  __resp['browser_search'] = CAPTCHA('tk_r');
  const pCap2 = searchPanelRunSearch({ query: 'cap2' });
  __release('browser_search');
  await pCap2; await __flush5();
  __resp['browser_takeover'] = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    takeover_id: 'tk_r', retry: 2, max_retries: 3 } };
  const pRetry = searchPanelTakeoverAction('continue');
  __release('browser_takeover');
  await pRetry; await __flush5();
  ok('retry_reenables_buttons', el('spTakeoverContinue').disabled === false
     && el('spTakeoverAbort').disabled === false
     && searchTakeoverId === 'tk_r' && searchPanelState === 'captcha'
     && el('spTakeover').style.display === ''
     && el('spTakeoverContinue').textContent.indexOf('2/3') >= 0
     && __toasts.some(t => t.msg.indexOf('2/3') >= 0));
  // 用户可再次点击继续（不再被禁用挡死）→ 成功收尾
  __resp['browser_takeover'] = { ok: true, resumed: true, query: 'cap2',
    engine: 'bing', source: 'live',
    results: [{ title: 'DONE', url: 'https://d.com', position: 1 }] };
  const pOk = searchPanelTakeoverAction('continue');
  __release('browser_takeover');
  await pOk; await __flush5();
  ok('retry_then_success', searchTakeoverId === null && searchPanelState === 'success'
     && el('spTakeover').style.display === 'none'
     && __ser(el('spResults')).indexOf('DONE') >= 0);
  return out;
}
""", 8)


class TestSearchTakeoverRaceAndHref:
    """A2/A3/A4：接管竞态 + href 白名单 + hideTakeover 复位 + TTL 到期提示。"""

    def test_harness(self):
        out = _run_js('search_race', ['63-search-panel.js'],
                      _GATE + _FLUSH, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const el = (id) => document.getElementById(id);
  searchPanelInit();
  __gate('browser_search');
  __resp['search_status'] = { ok: true, active: true, phase: 'captcha',
    progress_pct: 40, takeover: { takeover_id: 'tk_stale', state: 'prompting',
      elapsed_s: 30, retries: 0, max_retries: 3 } };

  // ① pending 期轮询检出 captcha → 允许挂接管（合法路径）
  __resp['browser_search'] = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    takeover_id: 'tk_stale' } };
  const p1 = searchPanelRunSearch({ query: 'x' });            // pending，挂在 bridge
  await searchPanelPollOnce();                                // 轮询镜像先挂 tk_stale
  ok('pending_poll_attach', searchTakeoverId === 'tk_stale'
     && searchPanelState === 'captcha');
  // 搜索成功 → 成功路径必须清洗接管区（防成功态滞留 captcha 框）
  __resp['browser_search'] = { ok: true, query: 'x', engine: 'bing', source: 'live',
    results: [{ title: 'OK', url: 'https://o.com', position: 1 }] };
  __release('browser_search');
  await p1; await __flush5();
  ok('success_clears_takeover', searchTakeoverId === null
     && el('spTakeover').style.display === 'none'
     && searchPanelState === 'success');

  // ② 终态后旧会话 captcha 快照不得复活（僵尸接管门控）
  await searchPanelPollOnce();
  ok('terminal_no_zombie', searchTakeoverId === null
     && searchPanelState === 'success'
     && el('spTakeover').style.display === 'none');

  // ③ idle 态开面板遇活跃旧 captcha 会话 → 不挂
  searchPanelSetState('idle');
  await searchPanelPollOnce();
  ok('idle_no_attach', searchTakeoverId === null && searchPanelState === 'idle');

  // ④ href 白名单行为矩阵
  __resp['browser_search'] = { ok: true, query: 'href', engine: 'bing', source: 'live',
    results: [
      { title: 'upper', url: 'HTTPS://X', position: 1 },
      { title: 'proto-rel', url: '//evil.com', position: 2 },
      { title: 'js', url: 'javascript:alert(1)', position: 3 },
      { title: 'frag', url: 'https://ok.com/x#frag', position: 4 },
      { title: 'tab', url: 'java\tscript:alert(1)', position: 5 },
      { title: 'file', url: 'file:///C:/Windows/win.ini', position: 6 } ] };
  const pHref = searchPanelRunSearch({ query: 'href' });
  __release('browser_search');
  await pHref; await __flush5();
  const anchor = (i) => el('spResults').children[i].children[0].children[1];
  ok('href_upper_allowed', anchor(0).href === 'HTTPS://X');       // /i → 放行（RFC 合法）
  ok('href_proto_relative_blocked', anchor(1).href === '#');      // 协议相对 → 拦
  ok('href_js_blocked', anchor(2).href === '#');
  ok('href_fragment_ok', anchor(3).href === 'https://ok.com/x#frag'
     && anchor(3).rel === 'noopener' && anchor(3).target === '_blank');
  ok('href_tab_js_blocked', anchor(4).href === '#');
  ok('href_file_blocked', anchor(5).href === '#');

  // ⑤ captcha 态 hideTakeover 后状态复位：Esc/× 不再被拦（面板关不掉死局）
  __resp['browser_search'] = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    takeover_id: 'tk_close' } };
  const pC3 = searchPanelRunSearch({ query: 'c3' });
  __release('browser_search');
  await pC3; await __flush5();
  searchPanelHideTakeover();
  ok('hide_resets_captcha_state', searchPanelState !== 'captcha'
     && searchTakeoverId === null && el('spTakeoverContinue').disabled === false);
  searchPanelShowTakeover({ takeover_id: 'tk_close2' });          // 再进 captcha
  searchPanelHideTakeover();                                      // 收起（收口 choke point）
  searchPanelOpen();                                              // 面板仍开着
  const t0 = __toasts.length;
  __doc.dispatch('keydown', { key: 'Escape' });
  ok('esc_not_blocked_after_hide', __toasts.length === t0);

  // ⑥ TTL 到期前 60s 一次性提示（每会话一次；新会话重置）
  __resp['browser_search'] = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    takeover_id: 'tk_ttl' } };
  const pTtl = searchPanelRunSearch({ query: 'ttl' });
  __release('browser_search');
  await pTtl; await __flush5();
  const warnCount = () => __toasts.filter(t => t.msg.indexOf('即将过期') >= 0).length;
  __resp['search_status'] = { ok: true, active: true, phase: 'captcha',
    takeover: { takeover_id: 'tk_ttl', state: 'prompting', elapsed_s: 500,
      retries: 0, max_retries: 3 } };
  await searchPanelPollOnce();
  ok('no_warn_before_lead', warnCount() === 0
     && el('spTakeoverTimer').textContent === '已等待 8:20');
  __resp['search_status'].takeover.elapsed_s = 545;
  await searchPanelPollOnce();
  ok('warn_at_lead', warnCount() === 1);
  __resp['search_status'].takeover.elapsed_s = 580;
  await searchPanelPollOnce();
  ok('warn_once_per_session', warnCount() === 1);
  __resp['browser_search'] = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    takeover_id: 'tk_ttl2' } };
  const pTtl2 = searchPanelRunSearch({ query: 'ttl2' });
  __release('browser_search');
  await pTtl2; await __flush5();
  __resp['search_status'] = { ok: true, active: true, phase: 'captcha',
    takeover: { takeover_id: 'tk_ttl2', state: 'prompting', elapsed_s: 545,
      retries: 0, max_retries: 3 } };
  await searchPanelPollOnce();
  ok('warn_reset_new_session', warnCount() === 2);
  return out;
}
""", 12)


# ============================================================ B 组：64-software-panel
class TestSoftwareTestFlowIsolation:
    """B5：swTesting 与面板其他在途流隔离 + 陈旧 finally 全覆盖 + elapsed 复位。"""

    def test_harness(self):
        out = _run_js('sw_test_flow', ['64-software-panel.js'],
                      _GATE + _FLUSH, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const el = (id) => document.getElementById(id);
  __qsa['.set-grid'] = __mkEl('div');
  __resp['software_list'] = { ok: true, software: [
    { name: 'git', kind: 'cli', status: 'probed', version: '2.43', source: 'preset',
      actions: [{ name: 'status', risk: 'read' }] } ] };
  ok('init', softwarePanelInit() === true);
  await __flush5();

  const openAndRun = () => {
    softwarePanelOpenTest('git', { name: 'git', kind: 'cli',
      actions: [{ name: 'status', risk: 'read' }] });
    return softwarePanelRunTest('git');
  };
  __resp['software_call'] = { ok: true, software: 'git', action: 'status',
    kind: 'cli', exit_code: 0, stdout: 'On branch main', duration_ms: 12,
    sandboxed: true, truncated: false };
  __gate('software_call');
  const pTest = openAndRun();
  ok('test_inflight', swTesting === true && el('swTestRun').disabled === true
     && __intervals.length === 1 && __intervals[0].cleared === false
     && el('swTestTimer').textContent === '已运行 0:00');

  // ① 探测与测试并发：探测完成不得将在途测试判陈旧（旧实现共用 seq → 输出被吞）
  __resp['software_probe'] = { ok: true, probed: [{ name: 'git', status: 'probed' }],
    elapsed_ms: 300 };
  await softwarePanelProbe();
  ok('probe_not_swallow_test', swTesting === true && el('swTestRun').disabled === true);
  __release('software_call');
  await pTest; await __flush5();
  ok('test_output_rendered', el('swTestOut').innerHTML.indexOf('On branch main') >= 0
     && el('swTestRun').disabled === false && swTesting === false
     && swCallTimer === null && swCallElapsed === 0
     && __intervals[__intervals.length - 1].cleared === true);

  // ② 探测失败在途不得覆写测试 UI（swDetail 在途保护）
  const pTest2 = openAndRun();
  __resp['software_probe'] = { ok: false, error: { code: 'X', message: 'probe boom' } };
  await softwarePanelProbe();
  ok('probe_error_no_clobber', el('swDetail').innerHTML.indexOf('sw-test') >= 0
     && __toasts.some(t => t.msg.indexOf('probe boom') >= 0));
  __release('software_call');
  await pTest2; await __flush5();
  ok('test2_output_after_probe_error', el('swTestOut').innerHTML.indexOf('On branch main') >= 0);

  // ③ 陈旧早退路径 finally 全覆盖（timer/按钮/swTesting/elapsed 四清 + 不渲染）
  __resp['software_call'] = { ok: true, software: 'git', action: 'status',
    kind: 'cli', exit_code: 0, stdout: 'STALE_MARKER', duration_ms: 9,
    sandboxed: true, truncated: false };
  const pTest3 = openAndRun();
  swTestSeq++;                                                  // 模拟更新的测试流抢占
  __release('software_call');
  await pTest3; await __flush5();
  ok('stale_finally_full_cleanup', swTesting === false
     && el('swTestRun').disabled === false && swCallTimer === null
     && swCallElapsed === 0
     && __intervals[__intervals.length - 1].cleared === true
     && el('swTestOut').innerHTML.indexOf('STALE_MARKER') < 0);

  // ④ 坏 JSON 早退：在途标志复位、不发调用
  const callsBefore = __calls.length;
  el('swTestArgs').value = '{not json';
  await softwarePanelRunTest('git');
  ok('bad_json_early_reset', swTesting === false && __calls.length === callsBefore
     && el('swTestOut').innerHTML.indexOf('BAD_PARAMS') >= 0);
  return out;
}
""", 8)


# ============================================================ C 组：65-hybrid
class TestHybridReadinessAndNan:
    """C6：hyRdSeq 陈旧按钮态 + NaN 单字段回弹 + connectIsLocalPreset 降级。"""

    def test_harness(self):
        out = _run_js('hybrid_rd', ['65-hybrid.js'],
                      _GATE + _FLUSH + r"""
let connectIsLocalPreset = null;   // 默认不存在（vm/部分加载降级）
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const el = (id) => document.getElementById(id);
  __qsa['.set-grid'] = __mkEl('div');
  __qsa['.header-right'] = __mkEl('div');
  __resp['hybrid_get_config'] = { ok: true, source: 'file',
    config: { strategy: 'auto', local_budget_understand_s: 5,
      local_budget_validate_s: 3, confidence_gate: 0.7, cost_split_display: true } };
  ok('init', hybridInit() === true);
  await __flush5();
  ok('config_loaded', hybridCfg && hybridCfg.confidence_gate === 0.7
     && el('hyConfGate').value === 0.7);

  // ① connectIsLocalPreset 不存在 → 降级放行（端点校验兜底）
  __gate('local_readiness');
  el('localBaseUrl').value = 'http://127.0.0.1:11434/v1';
  const r1 = hybridReadinessRun();
  ok('rd1_inflight', el('hyReadinessBtn').disabled === true
     && el('hyReadinessBtn').textContent === '检测中…');
  const r2 = hybridReadinessRun();
  __resp['local_readiness'] = { ok: true, verdict: 'cloud', score: 2, max: 8,
    items: [{ name: 'endpoint', ok: false, score: 0, max: 2, detail: 'd' }],
    suggestions: ['装个 Ollama'] };
  __release('local_readiness');                 // 旧（seq=1）先回
  await __flush5();
  ok('stale_rd_keeps_new_button', el('hyReadinessBtn').disabled === true
     && el('hyRdVerdict').textContent === '');
  __release('local_readiness');                 // 新（seq=2）回
  await r1; await r2; await __flush5();
  ok('new_rd_restores', el('hyReadinessBtn').disabled === false
     && el('hyReadinessBtn').textContent === '检测本地模型就绪度'
     && el('hyRdVerdict').textContent.indexOf('就绪度 2/8') >= 0
     && el('hyRdList').innerHTML.indexOf('endpoint') >= 0
     && el('hyRdList').innerHTML.indexOf('装个 Ollama') >= 0);

  // ② NaN 校验失败：只回弹犯规字段，不清用户正在其它字段的输入
  const savesBefore = __calls.filter(c => c.name === 'hybrid_save_config').length;
  el('hyBudgetUnderstand').value = '12';        // 用户正在输入（未 change）
  el('hyConfGate').value = 'abc';               // 犯规值
  el('hyConfGate').dispatch('change', {});
  await __flush5();
  ok('nan_field_revert_only', el('hyConfGate').value === 0.7
     && el('hyBudgetUnderstand').value === '12'
     && __calls.filter(c => c.name === 'hybrid_save_config').length === savesBefore
     && __toasts.some(t => t.msg.indexOf('0.5-0.95') >= 0));
  // 合法值仍正常保存
  __resp['hybrid_save_config'] = { ok: true, config: { strategy: 'auto',
    local_budget_understand_s: 5, local_budget_validate_s: 3,
    confidence_gate: 0.85, cost_split_display: true } };
  el('hyConfGate').value = '0.85';
  el('hyConfGate').dispatch('change', {});
  await __flush5();
  const saveCall = __calls.filter(c => c.name === 'hybrid_save_config').pop();
  ok('valid_saves', saveCall && saveCall.args[0].confidence_gate === 0.85);

  // ③ connectIsLocalPreset 存在且非本地 → 前置拦截（不发检测）
  connectIsLocalPreset = function () { return false; };
  const rdCallsBefore = __calls.filter(c => c.name === 'local_readiness').length;
  await hybridReadinessRun();
  ok('cloud_preset_blocked', __calls.filter(c => c.name === 'local_readiness').length === rdCallsBefore
     && __toasts.some(t => t.msg.indexOf('本地模型预设') >= 0));
  return out;
}
""", 7)


# ============================================================ D 组：67-plan-card
class TestPlanCardShapes:
    """D7：planShow 在途 reject 错误形状 + rbTwice RPC 失败恢复 + 澄清口径。"""

    def test_harness(self):
        out = _run_js('plan_card', ['67-plan-card.js'],
                      _FLUSH + r"""
const __calls = [];
const __planThrow = { rollback: false };
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'checkpoint_list') return JSON.stringify({
    files: [{ path: 'a.txt' }, { path: 'b.txt' }], mode: 'snapshot' });
  if (name === 'checkpoint_rollback') {
    if (__planThrow.rollback) throw new Error('rollback boom');
    return JSON.stringify({ ok: true, restored: ['a.txt'], failed: [] });
  }
  if (name === 'clarify_collect') return JSON.stringify({ resolved: ['r1'] });
  return '{}';
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg: msg, kind: kind }); }
const __unhandled = [];
process.on('unhandledRejection', (e) => { __unhandled.push(String(e)); });
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const mkHost = () => {
    const host = __mkEl('div');
    host.parentNode = { insertBefore: function (el) { el._parent = host;
      host.children.push(el); } };
    return host;
  };

  // ① planShow 在途取代：旧 Promise 以 AbortError 拒绝，消费方（planModeRun
  //    同款 try/catch）干净收尾；无 unhandled rejection
  const p1 = planShow({ task_id: 't1', title: 'A', steps: [{ text: 's1' }] });
  const consumed1 = p1.then(() => 'approved', (e) => 'rejected:' + e.name);
  const p2 = planShow({ task_id: 't2', title: 'B', steps: [{ text: 's2' }] });
  ok('old_show_abort_error', (await consumed1) === 'rejected:AbortError');
  planCardApprove();                                   // 新计划批准
  ok('new_show_resolves', (await p2) === undefined && planResolveApprove === null);

  // ② 用户拒绝 → AbortError → planModeRun catch 形状（100-send.js:216-218 同款）
  const p3 = planShow({ task_id: 't3', title: 'C', steps: [{ text: 's3' }] });
  const consumed3 = p3.then(() => 'approved', (e) => 'caught:' + e.name);
  planCardReject();
  ok('reject_abort_error', (await consumed3) === 'caught:AbortError');

  // ③ rbTwice：RPC 失败 → 浮层移除（按钮随之消失，不永禁）
  const host = mkHost();
  planCardEl = host;
  await ckptRollbackFlow('tk_rb', host);
  const box = host.children[host.children.length - 1];
  // querySelector 桩会把新建元素 push 进 children：[rbCancel, rbConfirm]
  const cf = box.children[1];
  ok('rb_box_created', !!box && !!cf && typeof cf.onclick === 'function');
  cf.onclick();                                        // 一次：武装
  ok('rb_armed', cf.dataset.armed === '1' && cf.textContent === '再次点击确认');
  __planThrow.rollback = true;                         // RPC 桥错（catch 路径）
  cf.onclick();                                        // 二次：执行
  await __flush5();
  ok('rb_rpc_fail_box_removed',
     __calls.filter(c => c.name === 'checkpoint_rollback').length === 1
     && box._detached === true
     && __toasts.some(t => t.msg.indexOf('rollback boom') >= 0));
  cf.onclick();                                        // 三次：不得再发起（双回滚竞态）
  await __flush5();
  ok('rb_triple_click_single_rpc',
     __calls.filter(c => c.name === 'checkpoint_rollback').length === 1);

  // ④ 成功路径：toast ok + 浮层移除（手动放行录制的 400ms 收尾定时器）
  __planThrow.rollback = false;
  await ckptRollbackFlow('tk_rb2', host);
  const box2 = host.children[host.children.length - 1];
  const cf2 = box2.children[1];
  cf2.onclick(); cf2.onclick();
  await __flush5();
  const lastTimer = __timers[__timers.length - 1];
  ok('rb_success_timer_scheduled', lastTimer && lastTimer.ms === 400);
  lastTimer.fn();
  ok('rb_ok', box2._detached === true
     && __toasts.some(t => t.msg.indexOf('回滚完成') >= 0));

  // ⑤ 批量澄清：全按默认取 q.default（勿信 .on）；部分选择取 .on
  const qs = [ { q: 'Q1', options: ['o1', 'o2'], default: 1 },
               { q: 'Q2', options: ['p1', 'p2'], default: 0 } ];
  const pClar = clarifyShow(qs);
  const form = host.children[host.children.length - 1];
  form.querySelectorAll = function (sel) {
    if (sel === '.clr-opt.on') return [{ dataset: { q: '0', o: '0' } }];  // 用户改过选择
    return [];
  };
  pcEl('clrDefault').onclick();                        // 全按默认（忽略 .on）
  await __flush5();
  const collectArgs = __calls.filter(c => c.name === 'clarify_collect').pop();
  ok('clarify_all_default_ignores_on', collectArgs
     && collectArgs.args[1]['0'] === 1
     && collectArgs.args[1]['1'] === 0);
  ok('clarify_all_default_resolved', (await pClar)[0] === 'r1');
  clarifyShow(qs);
  const form2 = host.children[host.children.length - 1];
  form2.querySelectorAll = function (sel) {
    if (sel === '.clr-opt.on') return [{ dataset: { q: '0', o: '0' } }];
    return [];
  };
  pcEl('clrSubmit').onclick();                         // 按所选继续
  await __flush5();
  const collect2 = __calls.filter(c => c.name === 'clarify_collect').pop();
  ok('clarify_partial_uses_on', collect2 && collect2.args[1]['0'] === '0');

  // ⑥ 偏差条：旧挂起以 'continue' 收尾（防 agent loop 双挂起）
  const pDev = planDeviationShow('出现计划外操作');
  ok('dev_bar_created', host.children[host.children.length - 1].id === 'devBar'
     && !!planResolveDev);
  planDeviationShow('again');
  ok('dev_supersede_continue', (await pDev) === 'continue');

  await __flush5();
  ok('no_unhandled_rejection', __unhandled.length === 0);
  return out;
}
""", 10)


# ============================================================ E 组：69-memory-panel
class TestMemoryStaleShift:
    """E8：等长位移检出 + 功能开关关闭 + 信封错误分支。"""

    def test_harness(self):
        out = _run_js('mem_shift', ['69-memory-panel.js'],
                      _FLUSH + r"""
const __calls = [];
let __memResp = [];
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'get_memory') return JSON.stringify(__memResp);
  if (name === 'memory_delete') return JSON.stringify({ ok: true, remaining: 3 });
  if (name === 'append_memory') return '{}';
  return '{}';
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg: msg, kind: kind }); }
async function uiConfirm() { return { ok: true }; }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const el = (id) => document.getElementById(id);
  __qsa['.set-grid'] = __mkEl('div');
  __memResp = [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }];  ok('init', memoryPanelInit() === true);
  await __flush5();
  ok('list_loaded', mmLastItems.length === 4 && el('mmCount').textContent === '共 4 条');

  // ① 等长但内容位移（中段淘汰 + 尾部追加）→ 逐条文本比对必须检出
  __memResp = [{ text: 'A' }, { text: 'C' }, { text: 'D' }, { text: 'E' }];
  const delBase = __calls.filter(c => c.name === 'memory_delete').length;
  await memoryPanelDelete(0);
  ok('mid_shift_detected', __calls.filter(c => c.name === 'memory_delete').length === delBase
     && __toasts.some(t => t.msg.indexOf('记忆列表已变化') >= 0)
     && mmLastItems.length === 4 && mmLastItems[1].text === 'C');

  // ② 前部淘汰位移（200 条截尾形态）→ 检出
  __memResp = [{ text: 'B' }, { text: 'C' }, { text: 'D' }, { text: 'E' }];
  await memoryPanelDelete(0);
  ok('front_shift_detected',
     __calls.filter(c => c.name === 'memory_delete').length === delBase
     && __toasts.filter(t => t.msg.indexOf('记忆列表已变化') >= 0).length === 2);

  // ③ 文本一致（仅 ts 变化）→ 不误报，删除放行
  __memResp = [{ text: 'B', ts: '9' }, { text: 'C' }, { text: 'D' }, { text: 'E' }];
  await memoryPanelDelete(0);
  ok('same_text_delete_ok',
     __calls.filter(c => c.name === 'memory_delete').length === delBase + 1
     && __toasts.some(t => t.msg.indexOf('已删除') >= 0));

  // ④ 信封错误分支（非数组载荷 ok:false → error 态，不静默渲染空列表）
  __memResp = { ok: false, error: { code: 'BAD', message: 'read boom', hint: 'hint1' } };
  await memoryPanelRefresh();
  ok('envelope_error', memoryPanelState === 'error'
     && el('mmError').innerHTML.indexOf('read boom') >= 0
     && el('mmError').innerHTML.indexOf('hint1') >= 0
     && el('mmCount').textContent === '共 0 条');

  // ⑤ 功能分级开关关闭 → 不挂载不刷新
  __calls.length = 0;
  localStorage.setItem('glm_feat_memory_v18', '0');
  ok('feature_off', memoryPanelInit() === false && __calls.length === 0);
  return out;
}
""", 7)


# ============================================================ F 组：七个小文件
class TestMcpBusyInterleave:
    """F9：mcpDeleteServer 独立 busy 后与开关 busy 的交错 + §八.21 现状一致。"""

    def test_harness(self):
        out = _run_js('mcp_busy', ['00-state.js', '29-mcp.js'],
                      _GATE + _FLUSH + r"""
let __servers = [{ name: 'a', status: 'ok', enabled: true, transport: 'stdio', tool_count: 2 }];
async function uiConfirm() { return { ok: true }; }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  __gate('mcp_get_server_detail'); __gate('mcp_delete_server');
  mcpServers = [{ name: 'a', status: 'ok', enabled: true, transport: 'stdio', tool_count: 2 }];
  renderMcpServerList();
  ok('rows_rendered', document.getElementById('mcpServerList').children.length === 1);

  // ① 开关在途不吞删除（独立 busy 集合）
  const pToggle = mcpToggleServer('a', false);               // 挂在 get_server_detail
  ok('toggle_inflight', mcpToggleServer._busy.has('a') === true);
  const pDel = mcpDeleteServer('a');                         // 独立 busy：不被吞
  await __flush5();
  ok('delete_not_swallowed', mcpDeleteServer._busy.has('a') === true
     && __calls.filter(c => c.name === 'mcp_delete_server').length === 1);
  __release('mcp_get_server_detail');
  await pToggle; await __flush5();
  ok('toggle_finishes', mcpToggleServer._busy.size === 0);
  __release('mcp_delete_server');
  await pDel; await __flush5();
  ok('delete_finishes', mcpDeleteServer._busy.size === 0
     && __toasts.some(t => t.msg.indexOf('已删除 a') >= 0)
     && __calls.filter(c => c.name === 'mcp_list_servers').length >= 2);

  // ② mcpResBusyUri 单槽 + 按钮禁用兜底（KNOWN_ISSUES §八.21 现状一致）
  mcpResBusyUri = '';
  const row = __mkEl('div');
  const btn = __mkEl('button');
  btn.textContent = '读取';
  __gate('mcp_read_resource');
  const pRead = mcpResRead('srv', { uri: 'res://1', name: 'R1' }, btn, row);
  ok('res_read_busy', mcpResBusyUri === 'res://1' && btn.disabled === true
     && btn.textContent === '读取中…');
  const btn2 = __mkEl('button');
  await mcpResRead('srv', { uri: 'res://1', name: 'R1' }, btn2, row);
  ok('res_same_uri_ignored', btn2.disabled === false && mcpResBusyUri === 'res://1');
  __release('mcp_read_resource');
  await pRead; await __flush5();
  ok('res_read_done', mcpResBusyUri === '' && btn.disabled === false
     && btn.textContent === '读取');
  return out;
}
""", 8)


class TestWebdavDirtyChain:
    """F10：加载失败也建快照 → 填新值判脏 → 导出前自动保存（三步推演）。"""

    def test_harness(self):
        out = _run_js('webdav_dirty', ['37-webdav.js'],
                      _FLUSH + r"""
const __calls = [];
const __resp = {};
let __getThrows = true;                 // 首次（顶层 load）即失败
let __saveResp = { ok: true };
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'webdav_get_config') {
    if (__getThrows) throw new Error('bridge old');
    return JSON.stringify({ url: 'https://dav.old.com', username: 'alice',
      remote_path: '/glm-chat-backup', conflict_policy: 'ask' });
  }
  if (name === 'webdav_save_config') return JSON.stringify(__saveResp);
  if (name === 'webdav_export') return JSON.stringify({ ok: true,
    uploaded: ['config.json'] });
  return '{}';
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg: msg, kind: kind }); }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const el = (id) => document.getElementById(id);
  await __flush5();                    // 排空顶层 loadWebdavConfigNow（失败路径）

  // ① 加载失败也建快照 → 空表单不判脏（基线在）
  ok('failed_load_snapshot', webdavFormDirty() === false);

  // ② 用户填新值 → 判脏（W35 链路复活）
  el('webdavUrl').value = 'https://dav.new.com';
  el('webdavUser').value = 'bob';
  el('webdavPass').value = 'secret';
  ok('dirty_after_fill', webdavFormDirty() === true);

  // ③ 导出前自动保存（旧配置不静默复用）+ 保存后快照刷新
  __calls.length = 0;
  await webdavExportNow();
  const order = __calls.map(c => c.name);
  ok('export_autosave_first', order.indexOf('webdav_save_config') >= 0
     && order.indexOf('webdav_save_config') < order.indexOf('webdav_export')
     && webdavFormDirty() === false);

  // ④ 保存失败 → 中止导出（不用旧配置）
  __saveResp = { ok: false, error: 'disk full' };
  el('webdavUrl').value = 'https://dav.third.com';
  __calls.length = 0;
  await webdavExportNow();
  const order2 = __calls.map(c => c.name);
  ok('export_abort_on_save_fail', order2.indexOf('webdav_save_config') >= 0
     && order2.indexOf('webdav_export') < 0);

  // ⑤ 成功加载 + 用户没改 → 不误判脏（密码不回填不造成假阳）
  __saveResp = { ok: true }; __getThrows = false;
  el('webdavUrl').value = 'https://dav.old.com';
  el('webdavUser').value = 'alice';
  el('webdavPass').value = '';
  el('webdavPath').value = '/glm-chat-backup';
  el('webdavConflict').value = 'ask';
  await loadWebdavConfigNow();
  ok('no_false_dirty', webdavFormDirty() === false);
  return out;
}
""", 5)


class TestWsQuickRaces:
    """F11：退场竞态三连击 + 委托 try/finally 后刷新必执行 + 轮询 seq 复检。"""

    def test_harness(self):
        out = _run_js('ws_quick', ['00-state.js', '38-ws-quick.js'],
                      _GATE + _FLUSH + r"""
let __wsSelectThrows = false;
async function onWsSelect(p) { if (__wsSelectThrows) throw new Error('ws boom'); }
async function onIndToggle(on) {}
async function onFolderEnabled(on) {}
async function browseWs() {}
async function unbindSession() {}
function wsShort(p, n) { return String(p || ''); }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const menu = document.getElementById('wsqMenu');
  const has = (c) => menu.classList.contains(c);
  MOTION.instant = function () { return false; };   // 走退场动画路径（竞态可观测）

  // ① 三连击（开-关-开 < compOut）：重开剥 hiding → 旧退场 done 不得剥 show
  wsQuickToggle();
  await __flush5();
  ok('open', has('show') && _wsqOpen === true);
  wsQuickClose();
  ok('closing', has('hiding') && _wsqOpen === false);
  wsQuickToggle();                       // 快速重开
  await __flush5();
  ok('reopen_strips_hiding', !has('hiding') && has('show') && _wsqOpen === true);
  await __flush5();                      // 旧退场 done 晚于重开执行
  ok('old_close_done_no_strip', has('show') && !has('hiding'));

  // ② 关关幂等 + 关未开菜单无副作用
  wsQuickClose();
  await __flush5();
  ok('closed', !has('show') && _wsqOpen === false);
  wsQuickClose();
  ok('double_close_safe', !has('hiding'));

  // ③ 委托抛错 → finally 仍刷新（状态残留防护）
  const before = __calls.filter(c => c.name === 'get_ws_state').length;
  __wsSelectThrows = true;
  let threw = false;
  try { await wsQuickPick('D:/ws'); } catch (e) { threw = true; }
  ok('delegate_throw_propagates', threw === true);
  ok('refresh_after_throw',
     __calls.filter(c => c.name === 'get_ws_state').length === before + 1);
  __wsSelectThrows = false;

  // ④ 轮询 seq 复检：第二个 await 后旧响应不覆写新状态
  __gate('get_effective_ws');
  const pR1 = wsQuickRefresh();
  await __flush5();
  const pR2 = wsQuickRefresh();
  __resp['get_effective_ws'] = { source: 'session', ws: 'D:/old' };
  __release('get_effective_ws');         // 放行旧的
  await pR1; await __flush5();
  ok('stale_eff_discarded',
     document.getElementById('wsqEffPath').textContent !== 'D:/old');
  __resp['get_effective_ws'] = { source: 'session', ws: 'D:/new' };
  __release('get_effective_ws');
  await pR2; await __flush5();
  ok('fresh_eff_applied',
     document.getElementById('wsqEffPath').textContent === 'D:/new');
  return out;
}
""", 8)


class TestAttachCountRace:
    """F12：退场 done 复核 hiding 后 n→0→n+1 快速序列 + _attachCount 名唯一。"""

    def test_harness(self):
        out = _run_js('attach_race', ['00-state.js', '90-attachments.js'],
                      _FLUSH + r"""
function escapeHtml(s) { return String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;'); }
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg: msg, kind: kind }); }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const box = document.getElementById('attachPreview');
  const has = (c) => box.classList.contains(c);
  MOTION.instant = function () { return false; };   // 走退场动画路径（竞态可观测）

  // ① 0→n：整条 show
  attachments.push({ type: 'text', name: 'a.txt', text: 'x' });
  renderPreview();
  ok('zero_to_n', has('show') && _attachCount === 1 && box.children.length === 1);

  // ② n→n+1：只给新增项加 .enter（历史项不重播）
  attachments.push({ type: 'text', name: 'b.txt', text: 'y' });
  renderPreview();
  ok('n_to_n1', _attachCount === 2 && box.children.length === 2
     && box.children[1].classList.contains('enter')
     && !box.children[0].classList.contains('enter'));

  // ③ n→0→n+1 快速序列：退场 done 晚于重填 → 不得剥 show/清空
  attachments.splice(0, attachments.length);
  renderPreview();
  ok('n_to_zero_hiding', has('hiding') && has('show') && _attachCount === 0);
  attachments.push({ type: 'text', name: 'c.txt', text: 'z' });
  renderPreview();
  ok('zero_to_n1_reentry', !has('hiding') && has('show') && _attachCount === 1
     && box.children.length === 1 && __ser(box).indexOf('c.txt') >= 0);
  await __flush5();                      // 旧退场 done 此刻执行
  ok('old_done_guard', has('show') && !has('hiding') && box.children.length === 1
     && __ser(box).indexOf('c.txt') >= 0);

  // ④ 退场完成 →0：show 移除 + 清空
  attachments.splice(0, attachments.length);
  renderPreview();
  await __flush5();
  ok('final_zero_clean', !has('show') && !has('hiding') && _attachCount === 0
     && box.children.length === 0);
  return out;
}
""", 6)

    def test_attach_count_var_name_unique(self):
        """_attachCount 变量名核对：全库唯一拼写（无 _attachCnt 等变体）。"""
        src = _fe('90-attachments.js')
        assert src.count('_attachCount') >= 6
        assert '_attachCnt' not in src and '_attachcount' not in src
        assert re.search(r'^let _attachCount = 0;', src, flags=re.M)


class TestCompressFallback:
    """F13：3s 兜底坏 dataUrl + onload 正常路径 clearTimeout + settled 守卫。"""

    def test_harness(self):
        out = _run_js('compress_fb', ['95-compress.js'],
                      _FLUSH + r"""
// 覆盖 HEAD 的录制式定时器：可控 + 可观测 cleared
const __timerLog = [];
function setTimeout(fn, ms) { __timerLog.push({ fn: fn, ms: ms, cleared: false });
  return __timerLog.length; }
function clearTimeout(h) { if (h && __timerLog[h - 1]) __timerLog[h - 1].cleared = true; }
class __FakeImage {
  constructor() { this.width = 100; this.height = 80; this._src = ''; __imgs.push(this); }
  set src(v) { this._src = v; }
  get src() { return this._src; }
}
const __imgs = [];
globalThis.Image = __FakeImage;
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const SMALL = 'data:image/png;base64,AAAA';      // < 300000 → 免压缩快路径

  // ① 坏 dataUrl：onload/onerror 都不触发 → 3s 兜底回落原图（附件链不卡死）
  const pBad = compressImage('data:image/png;base64,BROKEN');
  ok('fallback_timer_armed', __timerLog.length === 1 && __timerLog[0].ms === 3000
     && __imgs.length === 1);
  __timerLog[0].fn();
  ok('bad_dataurl_falls_back', (await pBad) === 'data:image/png;base64,BROKEN');

  // ② onload 正常路径（小图免压缩）：回落原 dataUrl + clearTimeout
  const pOk = compressImage(SMALL);
  __imgs[__imgs.length - 1].onload();
  ok('onload_fast_path', (await pOk) === SMALL
     && __timerLog[__timerLog.length - 1].cleared === true);

  // ③ onerror：回落原图 + 清定时器
  const pErr = compressImage('data:image/png;base64,ERR2');
  __imgs[__imgs.length - 1].onerror();
  ok('onerror_falls_back', (await pErr) === 'data:image/png;base64,ERR2'
     && __timerLog[__timerLog.length - 1].cleared === true);

  // ④ 兜底先赢 + onload 迟到：settled 守卫防二次 resolve
  const pLate = compressImage('data:image/png;base64,LATE');
  __timerLog[__timerLog.length - 1].fn();
  const late1 = await pLate;
  __imgs[__imgs.length - 1].onload();
  const late2 = await pLate;
  ok('settled_guard', late1 === 'data:image/png;base64,LATE' && late2 === late1);
  return out;
}
""", 5)


class TestUpdatePollBounded:
    """F14：轮询 try/catch 续试的总超时仍有效（不能无限续）。"""

    def test_harness(self):
        out = _run_js('update_poll', ['27-update.js'],
                      _FLUSH + r"""
// 立即执行式 setTimeout：轮询 sleep 不卡（1000 拍快速跑完）
function setTimeout(fn, ms) { fn(); return 1; }
function clearTimeout() {}
const __calls = [];
let __progressThrows = true;
async function callApi(name, args, timeoutMs) {
  __calls.push({ name: name, args: args, timeoutMs: timeoutMs });
  if (name === 'start_update_download') return JSON.stringify({ ok: true });
  if (name === 'get_update_progress') {
    if (__progressThrows) throw new Error('bridge blip');
    return JSON.stringify({ state: 'downloading', pct: 10 });
  }
  return '{}';
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg: msg, kind: kind }); }
async function uiConfirm() { return { ok: true }; }
""", r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  _updateInfo = { latest: '9.9.9', url: 'https://x/y.zip', sha256: 'abc', notes: 'n' };
  await startUpdateFlow();                 // get_update_progress 持续抛错 → 续试
  const progCalls = __calls.filter(c => c.name === 'get_update_progress').length;
  ok('poll_bounded_at_1000', progCalls === 1000);
  ok('timeout_error_toast', __toasts.some(t => t.msg.indexOf('下载超时') >= 0));
  ok('busy_released', startUpdateFlow._busy === false);
  return out;
}
""", 3)


class TestPanelFxNullGuard:
    """F15：newEl null 守卫后正常路径不受影响 + 缺失面板不抛。"""

    def test_harness(self):
        out = _run_js('panel_fx', ['16-panel-fx.js'], _FLUSH, r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 正常路径（动画态）：交叉淡化类名 + 退场收尸
  MOTION.panelOut = function () { return 200; };   // 补全 HEAD 桩缺失的令牌
  MOTION.instant = function () { return false; };
  switchPanel('sessions');
  const newEl = document.getElementById('panelSessions');
  const oldEl = document.getElementById('panelChat');
  ok('normal_path', newEl.classList.contains('on') && newEl.classList.contains('in-fwd')
     && oldEl.classList.contains('leaving') && oldEl.classList.contains('out-fwd'));
  await __flush5();
  ok('in_class_removed', !newEl.classList.contains('in-fwd'));
  ok('old_panel_retired', !oldEl.classList.contains('on'));

  // ② newEl 缺失（面板 id 不存在）：不抛 + 旧面板照常退场
  __setAutoCreate(false);
  let threw = false;
  try { switchPanel('analytics'); } catch (e) { threw = true; }
  ok('null_new_el_no_throw', threw === false && currentPanel === 'analytics');
  await __flush5();
  ok('old_panel_still_retires', !newEl.classList.contains('on'));

  // ③ 降级路径（instant）：同步切换，无 in-*/leaving 类
  __setAutoCreate(true);
  MOTION.instant = function () { return true; };
  switchPanel('workspace');
  const wsEl = document.getElementById('panelWorkspace');
  ok('instant_path', wsEl.classList.contains('on')
     && !wsEl.classList.contains('in-back') && !wsEl.classList.contains('in-fwd'));
  return out;
}
""", 6)


# ============================================================ G 组：遗留项确认
class TestLeftoverConfirmations:
    """G：round4 遗留三项与工作区现状/文档一致性（只读确认）。"""

    def test_mcp_res_busy_uri_documented_accepted(self):
        """§八.21：mcpResBusyUri 单槽语义——现状与文档一致（有按钮禁用兜底）。"""
        src = _fe('29-mcp.js')
        assert "let mcpResBusyUri = '';" in src
        assert 'if (mcpResBusyUri && mcpResBusyUri === r.uri) return;' in src
        assert 'btn.disabled = true;' in src                 # UI 主防线（文档所述兜底）
        assert "mcpResBusyUri = '';" in src                  # finally 清槽
        ki = io.open(os.path.join(PROJECT_ROOT, 'KNOWN_ISSUES.md'),
                     encoding='utf-8').read()
        assert 'mcpResBusyUri' in ki and '文档化接受' in ki

    def test_local_model_stale_restore_seq_guarded(self):
        """34-local-model：stale 复位已按 seq 判定（旧 finally 不抢在途按钮）。"""
        src = _fe('34-local-model.js')
        assert "if (seq === _localLoadSeq) localRestoreIdentifyBtn(btn, '拉取模型清单');" in src
        assert 'round4 遗留' in src                          # 修复注释在位
        # finally 内不存在无条件复位（反例形态）
        fin = src[src.index('async function localLoadModels'):]
        fin = fin[:fin.index('\n}\n')]
        assert fin.count('localRestoreIdentifyBtn') == 1
        assert 'if (seq === _localLoadSeq)' in fin

    def test_connect_identify_btn_label_branch(self):
        """36-connect：cmIdentifyBtn 按当前预设重刷文案（不还原陈旧 dataset）。"""
        src = _fe('36-connect.js')
        assert "if (btn.id === 'cmIdentifyBtn' && typeof connectIdentifyLabel === 'function') {" in src
        assert 'btn.innerHTML = connectIdentifyLabel(connectCurrentPreset());' in src
        assert 'function connectIdentifyLabel(id) {' in src


class TestRound7FixMarkers:
    """本轮修复的在位性固化（防回归剥离）。"""

    def test_search_panel_fix_markers(self):
        src = _strip_comments(_fe('63-search-panel.js'))
        # A4：TTL 到期预警
        assert 'const SP_TAKEOVER_TTL_S = 600;' in src
        assert 'const SP_TAKEOVER_WARN_LEAD_S = 60;' in src
        assert 'spTakeoverWarned' in src
        assert 's >= SP_TAKEOVER_TTL_S - SP_TAKEOVER_WARN_LEAD_S' in src
        # A2：pending 门控 + 成功路径清洗
        assert "if (searchPanelState === 'pending') {" in src
        assert 'searchPanelHideTakeover();' in src
        # A1/A3：hideTakeover 收口（解禁按钮 + captcha 状态复位）
        fin = src[src.index('function searchPanelHideTakeover'):]
        fin = fin[:fin.index('\n}\n')]
        assert "cont.disabled = false;" in fin
        assert "ab.disabled = false;" in fin
        assert "searchPanelSetState('idle')" in fin
        # A1：重试分支解禁（finally 无 retrying 特判）
        assert 'retrying' not in src
        assert 'if (seq === searchReqSeq) {' in src

    def test_software_panel_fix_markers(self):
        src = _strip_comments(_fe('64-software-panel.js'))
        assert 'let swTestSeq = 0;' in src
        assert src.count('seq !== swTestSeq') == 2
        assert 'const seq = ++swTestSeq;' in src
        # renderError 在途保护
        assert 'if (swTesting) {' in src
        # finally elapsed 复位
        fin = src[src.index('async function softwarePanelRunTest'):]
        fin = fin[:fin.index('\n}\n')]
        assert 'swCallElapsed = 0;' in fin

    def test_hybrid_fix_markers(self):
        src = _strip_comments(_fe('65-hybrid.js'))
        assert 'function hyRevertField(el, key) {' in src
        assert src.count('hyRevertField(el,') == 4      # 定义 + 3 个调用点
