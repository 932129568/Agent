# -*- coding: utf-8 -*-
"""R58 会话对话逻辑回归：编辑重发 / 任意位置回退（可撤销）/ 从指定消息重生成。

语义（ChatGPT·Claude.ai 通例的 Harbor 化，调研轮 R58）：
- 编辑重发：内联编辑 user 消息 → 截断其后全部 → 替换内容 → 重跑 Agent 循环
  （tool_calls 配平天然成立：截断点=user 边界）；
- 回退至此：保留 [0..midx]，其后进内存撤销缓冲（不随 sessions.json 持久化），
  横幅一键撤销；usage 单调累计不退还（横幅注明）；
- regenerate(midx)：历史 assistant 消息操作条带自身下标——从**本轮提问**起重跑
  （原点旧消息实际总从最后一条 user 重跑，语义误导）；
- 守卫：本会话流式中一律拦；midx 必须指向 user 消息（防悬挂 tool_calls 致 400）。
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


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _run_js(name, modules, stubs, body, checks_min):
    """普通脚本拼接（DOM 桩前置 + 模块源 + 函数桩 + 用例体 + 异步入口）。
    DOM 桩必须前置于模块：模块顶层即引用 window/document（const 声明后置会
    产生全脚本 TDZ——「Cannot access before initialization」教训）。函数桩
    声明可后置（函数声明整体提升）。"""
    if not os.path.exists(NODE):
        pytest.skip('node 不可用: %s' % NODE)
    js = _DOM_STUBS
    for fname in modules:
        js += '\n/* ===== %s ===== */\n' % fname + _fe(fname)
    js += '\n/* ===== stubs ===== */\n' + stubs + '\n' + body + r"""
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""
    fd, path = tempfile.mkstemp(suffix='.js', prefix='r58_conv_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr[-2000:], r.stdout[-500:])
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


_DOM_STUBS = r"""
/* ---- 最小 DOM 桩（元素工厂 + document/window 单例；__created 捕获全部 createElement） ---- */
const __created = [];
const __host = { style: {}, children: [], appendChild(c) { this.children.push(c); } };
const __docEls = {};
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    _html: '', value: '', type: '', className: '', textContent: '', onclick: null,
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); },
    querySelector() { return null; },
    addEventListener() {}, focus() {}, remove() {},
  };
  return el;
}
const window = { DOMPurify: null, innerHeight: 800 };
const document = {
  createElement(tag) { const el = mkEl(tag); __created.push(el); return el; },
  getElementById(id) { return id === 'chatContainer' ? __host : (__docEls[id] || null); },
  addEventListener() {}, removeEventListener() {},
};
"""

_STUBS = r"""
const __toasts = [];
let __s = null, __busy = false, __saveCalled = 0, __renderCalled = 0, __runCalled = 0;
function toast(m, k) { __toasts.push([String(m), String(k || '')]); }
function isSessionStreaming() { return __busy; }
function getCurrentSession() { return __s; }
function saveSessions() { __saveCalled++; }
function renderChatHistory(s) { __renderCalled++; }
function runAgentLoop(s, key) { __runCalled++; }
function effectiveApiKey() { return 'sk-test'; }
function localModeActive() { return false; }
function addMessage(role, text, extra) { return mkEl('div'); }
function switchSession() {}
function updateCostEstimate() {}
function _sendSessionBusy() { return false; }
"""


class TestEditResend:
    """编辑重发：截断其后 + 替换内容 + 重跑；数组内容保非文本段；守卫矩阵。"""

    def test_harness(self):
        body = r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 流式中拦截：不改历史、不重跑
  __busy = true; __runCalled = 0;
  __s = { id: 's1', messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '答' }] };
  const el0 = mkEl('div'); el0.dataset.midx = '0';
  msgEditResend(el0, '旧问题');
  ok('busy_guard', __runCalled === 0 && __s.messages.length === 2);

  // ② 正常路径：截断其后 + 替换 + 重跑 + edited 标记
  __busy = false; __runCalled = 0; __saveCalled = 0; __created.length = 0;
  __s = { id: 's1', messages: [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '答A' },
    { role: 'user', content: '追问' },
    { role: 'assistant', content: '答B' }] };
  const el = mkEl('div'); el.dataset.midx = '0';
  msgEditResend(el, '旧问题');
  const ta = __created.filter(c => c.tagName === 'TEXTAREA')[0];
  const btns = __created.filter(c => c.tagName === 'BUTTON');
  ok('editor_mounted', !!ta && btns.length === 2
     && btns[1].textContent === '保存并重发' && ta.value === '旧问题');
  ta.value = '新问题';
  btns[1].onclick();
  ok('truncate_and_replace', __s.messages.length === 1 && __s.messages[0].content === '新问题'
     && __s.messages[0].edited === true);
  ok('rerun_called', __runCalled === 1 && __saveCalled >= 1);

  // ③ 数组内容（含图）：文本段原地替换，图片段保留
  __created.length = 0; __runCalled = 0;
  __s = { id: 's1', messages: [{ role: 'user', content: [
      { type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:png' } }] }] };
  const el2 = mkEl('div'); el2.dataset.midx = '0';
  msgEditResend(el2, '看这张图');
  const t2 = __created.filter(c => c.tagName === 'TEXTAREA')[0];
  const b2 = __created.filter(c => c.tagName === 'BUTTON')[1];
  t2.value = '看这张图，重点看左侧';
  b2.onclick();
  const m2 = __s.messages[0];
  ok('array_content_text_swapped', Array.isArray(m2.content)
     && m2.content[0].text === '看这张图，重点看左侧'
     && m2.content[1].type === 'image_url' && __runCalled === 1);

  // ④ 空编辑拒绝
  __created.length = 0; __runCalled = 0;
  __s = { id: 's1', messages: [{ role: 'user', content: 'x' }] };
  const el3 = mkEl('div'); el3.dataset.midx = '0';
  msgEditResend(el3, 'x');
  const t3 = __created.filter(c => c.tagName === 'TEXTAREA')[0];
  const b3 = __created.filter(c => c.tagName === 'BUTTON')[1];
  const toastsBefore = __toasts.length;
  t3.value = '   ';
  b3.onclick();
  ok('empty_rejected', __s.messages[0].content === 'x' && __runCalled === 0
     && __toasts.length > toastsBefore);

  // ⑤ midx 非 user（assistant）→ 拒
  __s = { id: 's1', messages: [{ role: 'assistant', content: 'a' }] };
  const el4 = mkEl('div'); el4.dataset.midx = '0';
  msgEditResend(el4, 'a');
  ok('assistant_rejected', __s.messages.length === 1 && __runCalled === 0);
  return out;
}
"""
        _run_js('edit_resend', ['00-state.js', '50-markdown.js'], _STUBS, body, 7)


class TestRollback:
    """回退至此：截断进缓冲 + 撤销恢复 + 守卫。"""

    def test_harness(self):
        body = r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 中段回退：保留 [0..midx]，其后进缓冲；save+render；撤销恢复原序
  __busy = false; __saveCalled = 0; __renderCalled = 0;
  __s = { id: 's1', messages: [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'Q3' }] };
  const el1 = mkEl('div'); el1.dataset.midx = '2';
  msgRollback(el1, 'Q2');
  ok('cut_to_midx', __s.messages.length === 3
     && __s.messages[2].content === 'Q2'
     && __saveCalled >= 1 && __renderCalled >= 1);
  ok('undo_buffer_holds', Array.isArray(__rollbackBuf.msgs) && __rollbackBuf.msgs.length === 2
     && __rollbackBuf.msgs[0].content === 'A2');
  ok('banner_mounted', __host.children.length >= 1);
  // 撤销：横幅第二个子节点 = 按钮
  const banner = __host.children[__host.children.length - 1];
  const undoBtn = banner.children[1];
  undoBtn.onclick();
  ok('undo_restores', __s.messages.length === 5 && __s.messages[3].content === 'A2'
     && __rollbackBuf.msgs === null);

  // ② 最新位置回退 → 提示无需回退，历史不动
  __toasts.length = 0;
  __s = { id: 's1', messages: [{ role: 'user', content: 'Q1' }] };
  const el2 = mkEl('div'); el2.dataset.midx = '0';
  msgRollback(el2, 'Q1');
  ok('latest_noop', __toasts.some(t => t[0].indexOf('无需回退') >= 0) && __s.messages.length === 1);

  // ③ 非 user 边界（assistant midx）→ 拒（防悬挂 tool_calls 400）
  __s = { id: 's1', messages: [{ role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1', tool_calls: [{ id: 't1' }] }] };
  const el3 = mkEl('div'); el3.dataset.midx = '1';
  msgRollback(el3, 'A1');
  ok('assistant_boundary_rejected', __s.messages.length === 2
     && __toasts.some(t => t[0].indexOf('自己发送的提问') >= 0));

  // ④ 流式中拦截
  __busy = true; __toasts.length = 0;
  __s = { id: 's1', messages: [{ role: 'user', content: 'Q1' }, { role: 'user', content: 'Q2' }] };
  const el4 = mkEl('div'); el4.dataset.midx = '0';
  msgRollback(el4, 'Q1');
  ok('busy_guard', __s.messages.length === 2 && __toasts.some(t => t[0].indexOf('正在生成') >= 0));
  return out;
}
"""
        _run_js('rollback', ['00-state.js', '50-markdown.js'], _STUBS, body, 6)


class TestRegenerateFromMidx:
    """regenerate(midx)：从被点击 assistant 消息的本轮提问起重跑；缺省=最后 user。"""

    def test_harness(self):
        # send.js 整族加载依赖重——按 v13 惯例抽单函数体
        src = _fe('100-send.js')
        m = re.search(r'async function regenerate\(', src)
        assert m, 'regenerate 缺失'
        i = m.end() - 1
        depth = 0
        while True:
            ch = src[i]
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        regen_src = src[m.start():i + 1]
        body = r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });

  // ① 从中间 assistant（midx=1，属 Q1 轮）重生成：截到本轮提问本身（Q1 保留，A1 移除重答）
  __runCalled = 0;
  __s = { id: 's1', messages: [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' }] };
  await regenerate(1);
  ok('mid_regen_cuts_to_own_turn', __s.messages.length === 1
     && __s.messages[0].content === 'Q1' && __runCalled === 1);

  // ② 缺省（live 末条）：截到最后一条 user 消息之后（保留 Q2，A2 移除重答）
  __runCalled = 0;
  __s = { id: 's1', messages: [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' }] };
  await regenerate();
  ok('default_last_turn', __s.messages.length === 3 && __s.messages[2].content === 'Q2');

  // ③ midx 指向 user（误传）→ 退回缺省口径（最后一轮）
  __runCalled = 0;
  __s = { id: 's1', messages: [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' }] };
  await regenerate(0);
  ok('user_midx_falls_back_to_last', __s.messages.length === 3 && __s.messages[2].content === 'Q2');
  return out;
}
"""
        _run_js('regen_midx', ['00-state.js'], _STUBS + '\n' + regen_src, body, 3)

    def test_actions_pass_midx_and_history_badge(self):
        src = _fe('50-markdown.js')
        assert "parseInt(msgEl.dataset.midx, 10)" in src
        assert "regenerate(Number.isInteger(mi) ? mi : undefined)" in src, '历史 regen 未带 midx'
        assert 'msgEditResend' in src and 'msgRollback' in src, '操作条未接线'
        ctrl = _fe('85-session-mgmt.js')
        assert 'm.edited' in ctrl, '已编辑徽标未渲染'


class TestGenerativeUiVersions:
    """R58 B2：UiSpec 版本化（Artifacts 模式）——历史保留/上限/切换换序/dedup 签名升级。"""

    def test_version_store_and_switch(self):
        stubs = r"""
const UiGenerativeSettings = { enabled: true, set() {}, get() { return true; } };
const UiProjection = { mount() {} };
function generateUiSpec() { return Promise.resolve({}); }
/* sessions/currentSessionId/AppState 由 00-state.js 提供（避免重复声明） */
function uiEndpointSnapshot() { return null; }
function saveSessions() {}
function toast() {}
function exportSessionMd() {}
function createUiDataRefHost() { return null; }
"""
        body = r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const spec = (t, blocks) => ({ schemaVersion: 1, specId: t, blocks: blocks || [{ blockId: 'b1', component: 'TextBlock', props: { text: t } }] });

  const msg = {};
  chatAutoStoreVersion(msg, spec('v1'));
  ok('first_store_no_history', !Array.isArray(msg.uiVersions) || msg.uiVersions.length === 0
     && msg.uiSpec.specId === 'v1');

  chatAutoStoreVersion(msg, spec('v2'));
  ok('second_pushes_history', msg.uiVersions.length === 1 && msg.uiVersions[0].specId === 'v1'
     && msg.uiSpec.specId === 'v2');

  chatAutoStoreVersion(msg, spec('v2'));
  ok('same_spec_noop', msg.uiVersions.length === 1, '同 spec 重复存储不推版本');

  for (const t of ['v3', 'v4', 'v5', 'v6', 'v7']) chatAutoStoreVersion(msg, spec(t));
  // 时间线=[v3..v6(历史), v7(激活)]——上限 4 作用于历史，激活版恒在时间线末位
  ok('capped_at_max', msg.uiVersions.length === 4
     && JSON.stringify(msg.uiVersions.map(v => v.specId)) === JSON.stringify(['v3', 'v4', 'v5', 'v6'])
     && msg.uiSpec.specId === 'v7');

  ok('switch_to_active_noop', chatAutoSwitchVersion(msg, 4) === false);
  ok('switch_to_first_moves_to_active', chatAutoSwitchVersion(msg, 0) === true
     && msg.uiSpec.specId === 'v3'
     && msg.uiVersions[msg.uiVersions.length - 1].specId === 'v7');
  ok('timeline_preserves_order', JSON.stringify(msg.uiVersions.map(v => v.specId))
     === JSON.stringify(['v4', 'v5', 'v6', 'v7']));
  return out;
}
"""
        _run_js('gen_versions', ['00-state.js', 'chat-auto.js'], stubs, body, 7)

    def test_dedup_sig_and_wiring(self):
        src = _fe('chat-auto.js')
        assert "chatAutoLastAssistant(sessionId)" in src, 'dedup 签名未升级（调研冲突点 #2）'
        assert "__uiVersionSwitch" in src and "verLabel" in src, '版本箭头未接线'
        assert "chatAutoStoreVersion(" in src, '持久化点未走版本存储'
        man = json.load(io.open(os.path.join(PROJECT_ROOT, 'frontend/manifest.json'),
                                encoding='utf-8'))
        entry = [m for m in man['scripts'] if m['path'].endswith('generative/chat-auto.js')]
        assert entry and 'chatAutoSwitchVersion' in entry[0]['provides'], 'manifest 未登记'
