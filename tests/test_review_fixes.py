# -*- coding: utf-8 -*-
"""审查修复回归验证（full-code-review-2026-10-15 全量 78 项）——QA 严过关。

定位方法：全库 grep「修复 C1 / S5 / W13 / 建议③」式来源编号标记。
本文件只新增测试，不改任何源码；既有 151 用例为契约红线，本文件必须全绿且不碰它们。

覆盖结构：
- 后端行为级：C1 / C2 / S1-S3 / S4 全 token 流 / S5 / S6 / S7 / S8 / S10 /
  S12-S17 / W6 / W8 / W10-W12 / W13 / W17 / 建议⑤⑥⑮⑯ / ㉒
- 后端源码级（无法自动化处）：S9 / S11 / W2 / W7 / W14 / W15 / W18-W23 / ①③㉓㉔㉕ 等
- 前端 node 实测（vm 沙箱 + DOM 桩）：S19-S26 / W28-W31 / ㉒㉚㉛
- 标记完整性：101 个审查编号逐一核对修复标记在盘（5 处并标/误标单独取证）
"""
import ctypes
import glob
import io
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from logging.handlers import RotatingFileHandler

import pytest

from conftest import HOME, NewApi, install_fake_windll, make_fake_subprocess_run, ws
from helpers.frontend import frontend_node_map, read_frontend_source

from backend import paths
from backend.fio import atomic_write_json, atomic_write_text, atomic_write_text_mode
from backend.logging_setup import setup_logging
from backend.domains.workspace.clipboard_service import ClipboardService, _apply_win32_signatures as _clip_sigs
from backend.domains.workspace.cmd_service import CmdService, _apply_win32_signatures as _cmd_sigs
from backend.domains.workspace.file_service import FileService
from backend.domains.security.guard_service import GuardService, GUARD_FILE
from backend.domains.integrations.mcp.mcp_client import McpClient, McpProtocolError
from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
from backend.domains.integrations.mcp.mcp_service import McpService
from backend.domains.integrations.mcp.mcp_transport_http import (
    HttpTransport, HttpTransportError, _NoRedirectHandler, urlopen_no_redirect)
from backend.domains.integrations.mcp.mcp_transport_stdio import StdioTransport
from backend.domains.workspace.process_service import ProcessService, _decode_console
from backend.domains.workspace.toolcache_service import ToolcacheService
from backend.domains.integrations.update_service import UpdateService

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')


# ============================================================ fixtures / helpers
@pytest.fixture
def api(monkeypatch):
    fake_run, calls = make_fake_subprocess_run()
    monkeypatch.setattr('subprocess.run', fake_run)
    monkeypatch.setattr(os, 'startfile', lambda p: None)
    install_fake_windll(monkeypatch)
    return NewApi()


def _src(rel):
    return io.open(os.path.join(PROJECT_ROOT, rel), encoding='utf-8').read()


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _arm(a):
    """生产等价武装路径：main.py 窗口就绪回调 Api._set_window → guard.arm()。"""
    a._set_window(None)
    assert a._guard.armed is True


def _issue(a, op, detail):
    r = json.loads(a.guard_confirm_token(op, json.dumps(detail, ensure_ascii=False)))
    assert r.get('token'), r
    return r['token']


# ============================================================ node 前端测试设施
_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], value: '', checked: false, onclick: null,
    focus: function(){},
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      toggle: function(c, f){ if (f === undefined) f = !this._s.has(c);
        if (f) this._s.add(c); else this._s.delete(c); return f; },
      contains: function(c){ return this._s.has(c); } },
    _html: '', _text: '',
    set innerHTML(v) { this._html = String(v); this._opens = (this._opens || 0) + 1;
      if (this.id === 'modalRoot') __MODAL_OPENS.push(1); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); if (this._text === '') this.children.length = 0; },
    get textContent() { return this._text; },
    appendChild: function(c){ this.children.push(c); c._parent = this;
      if (c.id) __byId[c.id] = c;   // 真实 DOM：挂进 body 后按 id 可检索
      return c; },
    remove: function(){ if (this._parent)
      this._parent.children = this._parent.children.filter(x => x !== this);
      this._detached = true;   // 修复测试桩语义：remove 后 getElementById 应返回 null（真实 DOM 行为）
    },
    querySelector: function(sel){ this._q = this._q || {};
      if (!this._q[sel]) this._q[sel] = __mkEl(sel); this._q[sel]._parent = this;
      return this._q[sel]; },
    querySelectorAll: function(){ return []; },
    contains: function(){ return true; },
  };
  return el;
}
const __byId = {};
const __MODAL_OPENS = [];   // modalRoot 开弹全局计数（跨重建累计，S22 队列验证用）
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ const el = __byId[id];
    if (el && el._detached) return null;   // 已 remove 的元素不再可检索（真实 DOM 语义）
    if (!el) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }   // 桩须带 id（modalRoot 计数依赖）
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
  // 桩保真（2026-10-18）：真实 document 恒有 addEventListener/removeEventListener；
  // 原桩缺失，导致「模块顶层挂 document.addEventListener」的合法代码在单模块沙箱里崩。
  addEventListener: function(){},
  removeEventListener: function(){},
};
function __ctx(extra) {
  const sand = Object.assign({
    document: __doc,
    setTimeout: function(fn, ms){ return setTimeout(fn, Math.min(Number(ms) || 0, 20)); },
    clearTimeout: clearTimeout, console: console,
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
        pytest.skip('node 不可用: %s' % NODE)
    js = _JS_PRELUDE + body + _JS_MAIN
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_fix_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True,
                           timeout=120, encoding='utf-8', errors='replace')
        assert r.returncode == 0, 'node 失败:\n%s\n%s' % (r.stderr, r.stdout)
        return json.loads(r.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# ============================================================ C1：pid 强杀绕过
class TestC1PidKillBypass:
    def test_pid_non_numeric_rejected(self, api):
        r = json.loads(api.kill_process(pid='abc'))
        assert 'error' in r and '必须是数字' in r['error']

    def test_pid_only_resolves_name_and_blocks(self, api, monkeypatch):
        """pid-only 调用经 resolve_name_by_pid 走名单：lsass.exe 必须被拒。"""
        monkeypatch.setattr(api._process, 'resolve_name_by_pid', lambda pid: 'lsass.exe')
        r = json.loads(api.kill_process(pid=700))
        assert 'error' in r and '保护名单' in r['error']

    def test_pid_only_blocked_no_taskkill(self, api, monkeypatch):
        fake_run, calls = make_fake_subprocess_run()
        monkeypatch.setattr('subprocess.run', fake_run)
        monkeypatch.setattr(api._process, 'resolve_name_by_pid', lambda pid: 'csrss.exe')
        r = json.loads(api.kill_process(pid=701))
        assert 'error' in r and '保护名单' in r['error']
        assert not any(str(c).find('taskkill') >= 0 for c in calls), \
            '命中名单后不得触发 taskkill: %s' % (calls,)

    def test_resolve_name_by_pid_parses_tasklist(self, monkeypatch):
        svc = ProcessService()
        def fake_run(args, **kw):
            assert args[0] == 'tasklist' and args[1] == '/fi' and args[3:] == ['/fo', 'csv', '/nh']
            csv = '"lsass.exe","700","Console","1","10,000 K"\r\n'
            return subprocess.CompletedProcess(args, 0, stdout=csv.encode('gbk'), stderr=b'')
        monkeypatch.setattr(subprocess, 'run', fake_run)
        assert svc.resolve_name_by_pid(700) == 'lsass.exe'
        assert svc.resolve_name_by_pid('not-a-pid') is None   # 非数字 → None

    def test_resolve_failure_conservative(self, api, monkeypatch):
        """反查失败（None）时保守回退：pid 名单 {0,4,自身} 仍生效。"""
        monkeypatch.setattr(api._process, 'resolve_name_by_pid', lambda pid: None)
        assert 'error' in json.loads(api.kill_process(pid=0))
        assert 'error' in json.loads(api.kill_process(pid=4))
        assert 'error' in json.loads(api.kill_process(pid=os.getpid()))
        r = json.loads(api.kill_process(pid=9999))            # 未知名 pid → 按契约放行
        assert r.get('ok') is True

    def test_guard_pid_not_matched_as_name(self):
        """建议⑦：pid 不再当进程名 fnmatch（用户名单含 * 时不误伤）。"""
        gs = GuardService(guard_path=os.path.join(tempfile.mkdtemp(), 'g.json'))
        gs.save_config(json.dumps({'protect_processes': ['*']}))
        assert gs.check('kill_process', {'pid': 700})['action'] != 'block'   # pid 不触发名单
        assert gs.check('kill_process', {'name': 'anything.exe'})['action'] == 'block'


# ============================================================ C2：ctypes restype
class TestC2CtypesSignatures:
    def _mk(self):
        # 四个 kernel32 API 必须用独立函数对象——共享一个函数会让 restype/argtypes
        # 属性互相覆盖（后写覆盖先写），与真实 ctypes 中四个独立函数指针的语义不符
        def mkf():
            def f(*a):
                return 1
            return f
        return types.SimpleNamespace(
            GlobalAlloc=mkf(), GlobalLock=mkf(), GlobalUnlock=mkf(), GlobalFree=mkf()), \
            types.SimpleNamespace(
                GetClipboardData=mkf(), SetClipboardData=mkf(),
                IsClipboardFormatAvailable=mkf(), OpenClipboard=mkf())

    def test_clipboard_signatures_declared(self):
        from ctypes import wintypes
        k32, u32 = self._mk()
        _clip_sigs(u32, k32)
        assert k32.GlobalLock.restype is ctypes.c_void_p
        assert k32.GlobalAlloc.restype == wintypes.HGLOBAL
        assert list(k32.GlobalLock.argtypes) == [wintypes.HGLOBAL]
        assert list(k32.GlobalAlloc.argtypes)[0] is wintypes.UINT
        assert u32.GetClipboardData.restype == wintypes.HANDLE
        assert u32.SetClipboardData.restype == wintypes.HANDLE
        assert u32.OpenClipboard.argtypes == [wintypes.HWND]

    def test_cmd_service_signatures_declared(self, monkeypatch):
        install_fake_windll(monkeypatch)
        _cmd_sigs()
        assert ctypes.windll.user32.MessageBoxW.restype is ctypes.c_int
        assert ctypes.windll.shell32.ShellExecuteW.restype is ctypes.c_void_p
        assert len(ctypes.windll.shell32.ShellExecuteW.argtypes) == 6

    def test_signature_failure_degrades_silently(self):
        k32 = types.SimpleNamespace(GlobalAlloc=5, GlobalLock=5, GlobalUnlock=5, GlobalFree=5)
        u32 = types.SimpleNamespace()
        _clip_sigs(u32, k32)     # 不可写属性 → 异常被吞，不抛（测试桩/降级环境）


# ============================================================ S1：落盘日志
class TestS1Logging:
    def test_rotating_handler_attached_and_no_duplicate(self, tmp_path):
        logger = logging.getLogger('harbor')
        before = [h for h in logger.handlers if isinstance(h, RotatingFileHandler)]
        try:
            setup_logging(str(tmp_path))
            added = [h for h in logger.handlers if isinstance(h, RotatingFileHandler)]
            assert len(added) == len(before) + 1
            logger.info('QA_S1_PROBE_MESSAGE')
            for h in added:
                h.flush()
            content = io.open(os.path.join(str(tmp_path), 'harbor.log'),
                              encoding='utf-8').read()
            assert 'QA_S1_PROBE_MESSAGE' in content
            setup_logging(str(tmp_path))                       # 重复调用不叠加
            assert len([h for h in logger.handlers
                        if isinstance(h, RotatingFileHandler)]) == len(added)
        finally:
            for h in [h for h in logger.handlers if isinstance(h, RotatingFileHandler)]:
                if h not in before:
                    logger.handlers.remove(h)
                    h.close()


# ============================================================ S2/S3：admin 命令
class TestS2S3AdminCommand:
    def _shell(self, monkeypatch, write_exit='7', write_out=True, garbage_exit=False):
        captured = {}

        class FakeShell:
            @staticmethod
            def ShellExecuteW(*a):
                captured['args'] = a
                bat_path = a[3].split('"')[1]
                # newline='' 保留原始换行（bat 应为 CRLF）；文本模式默认会把 \r\n 归一成 \n 导致断言失真
                with io.open(bat_path, 'r', encoding='mbcs', errors='replace', newline='') as f:
                    captured['bat'] = f.read()
                m = re.findall(r'"([^"]+)"', captured['bat'])
                if write_out and m:
                    with io.open(m[0], 'w', encoding='utf-8') as f:
                        f.write('admin-output')
                if write_exit and m:
                    with io.open(m[1], 'w', encoding='utf-8') as f:
                        f.write('NaN' if garbage_exit else write_exit)
                return 42
        monkeypatch.setattr(ctypes.windll, 'shell32', FakeShell)
        return captured

    def _freeze(self, monkeypatch):
        monkeypatch.setattr(time, 'time', lambda: 1700000000.0)
        monkeypatch.setattr('time.sleep', lambda s: None)

    def test_s2_bat_wrapper_real_errorlevel(self, api, monkeypatch):
        """S2：.bat 逐行解析期展开 %errorlevel% → 透传真实退出码。"""
        self._freeze(monkeypatch)
        cap = self._shell(monkeypatch)
        r = json.loads(api.run_admin_command('echo BATTED'))
        assert cap['args'][1] == 'runas' and cap['args'][2] == 'cmd'
        assert 'echo BATTED' in cap['bat']
        assert 'echo %errorlevel%' in cap['bat']           # bat 内两行结构
        assert cap['bat'].count('\r\n') >= 1
        assert r['exit_code'] == 7 and r['output'] == 'admin-output'

    def test_s3_completion_requires_parseable_exit(self, api, monkeypatch):
        """S3：exit 文件不可解析 → 完成判定不成立 → 退出码 None（不再恒 0）。"""
        self._freeze(monkeypatch)
        self._shell(monkeypatch, garbage_exit=True)
        r = json.loads(api.run_admin_command('echo GARBAGE'))
        assert r['exit_code'] is None

    def test_s3_timeout_cleans_tmp_files(self, api, monkeypatch):
        self._freeze(monkeypatch)
        cap = self._shell(monkeypatch, write_exit=False)
        r = json.loads(api.run_admin_command('echo NOTIMEOUT'))
        assert r['exit_code'] is None
        for p in re.findall(r'"([^"]+)"', cap['bat']):
            assert not os.path.exists(p), '临时文件泄漏: %s' % p

    def test_w4_legacy_admin_exit_code(self, monkeypatch):
        """疑似项（W4 修后验证）：legacy .bat 化后同样透传真实退出码。"""
        import conftest
        install_fake_windll(monkeypatch)
        self._freeze(monkeypatch)
        cap = self._shell(monkeypatch)

        class FakeShell2:
            @staticmethod
            def ShellExecuteW(*a):
                cap['args'] = a
                bat_path = a[3].split('"')[1]
                with io.open(bat_path, 'r', encoding='mbcs', errors='replace') as f:
                    cap['bat'] = f.read()
                m = re.findall(r'"([^"]+)"', cap['bat'])
                with io.open(m[0], 'w', encoding='utf-8') as f:
                    f.write('legacy-admin-out')
                with io.open(m[1], 'w', encoding='utf-8') as f:
                    f.write('9')
                return 42
        monkeypatch.setattr(ctypes.windll, 'shell32', FakeShell2)
        legacy_api = conftest.legacy.Api()
        r = json.loads(legacy_api.run_admin_command('echo W4LEGACY'))
        assert r['exit_code'] == 9 and r['output'] == 'legacy-admin-out'
        for p in re.findall(r'"([^"]+)"', cap['bat']):
            assert not os.path.exists(p)


# ============================================================ S4：confirm token 全流
class TestS4ConfirmTokenFlow:
    def test_unarmed_legacy_compat(self, api):
        """未武装（无窗口环境）不强制 token——legacy 兼容。"""
        api.write_file('u.txt', 'x')
        r = json.loads(api.delete_path('u.txt'))
        assert r.get('ok') is True

    def test_armed_delete_without_token_rejected(self, api):
        api.write_file('v.txt', 'x')
        _arm(api)
        r = json.loads(api.delete_path('v.txt'))
        assert 'error' in r and '一次性确认 token' in r['error']
        assert os.path.exists(os.path.join(ws(), 'v.txt'))

    def test_token_flow_success_then_replay_fails(self, api):
        api.write_file('v.txt', 'x')
        _arm(api)
        t = _issue(api, 'delete_path', {'path': 'v.txt'})
        assert re.fullmatch(r'[0-9a-f]{32}', t)                # secrets.token_hex(16)
        assert json.loads(api.guard_confirm_token('delete_path',
                                                  '{"path": "v.txt"}'))['ttl'] == 60
        r = json.loads(api.delete_path('v.txt', token=t))
        assert r.get('ok') is True and not os.path.exists(os.path.join(ws(), 'v.txt'))
        # 重放：同 token 二次使用必须失败
        api.write_file('v.txt', 'x')
        r2 = json.loads(api.delete_path('v.txt', token=t))
        assert 'error' in r2 and os.path.exists(os.path.join(ws(), 'v.txt'))

    def test_token_ttl_expiry(self, api):
        api.write_file('v.txt', 'x')
        _arm(api)
        t = _issue(api, 'delete_path', {'path': 'v.txt'})
        rec = api._guard._tokens[t]
        api._guard._tokens[t] = (rec[0], rec[1], time.time() - 1)   # 过期
        r = json.loads(api.delete_path('v.txt', token=t))
        assert 'error' in r

    def test_token_bound_to_detail_digest(self, api):
        api.write_file('a.txt', 'x')
        api.write_file('b.txt', 'x')
        _arm(api)
        t = _issue(api, 'delete_path', {'path': 'a.txt'})
        r = json.loads(api.delete_path('b.txt', token=t))     # 错 detail 摘要
        assert 'error' in r and os.path.exists(os.path.join(ws(), 'b.txt'))

    def test_session_trust_bypasses_token_then_cleared_on_sid_change(self, api):
        api.write_file('v.txt', 'x')
        _arm(api)
        assert json.loads(api.guard_session_trust('delete_path'))['ok'] is True
        assert json.loads(api.delete_path('v.txt'))['ok'] is True
        # W26：切会话清空信任态
        api.write_file('v.txt', 'x')
        api.set_current_sid('another-sid')
        r = json.loads(api.delete_path('v.txt'))
        assert 'error' in r

    def test_off_tier_allows_without_token(self, api):
        api.write_file('v.txt', 'x')
        _arm(api)
        assert 'error' not in json.loads(api.guard_save_config(
            '{"tiers": {"delete_path": "off"}}'))
        assert json.loads(api.delete_path('v.txt'))['ok'] is True

    def test_protected_path_blocks_even_with_token(self, api):
        api.write_file('v.txt', 'x')
        _arm(api)
        pat = os.path.join(ws(), 'v.txt').swapcase()
        api.guard_save_config(json.dumps({'protect_paths': [pat]}))   # W11：大小写归一
        t = _issue(api, 'delete_path', {'path': 'v.txt'})
        r = json.loads(api.delete_path('v.txt', token=t))
        assert 'error' in r and '保护名单' in r['error']

    def test_cross_op_token_reuse_rejected(self, api):
        """对抗性抽查①：A op 的 token 用于 B op 必须失败。"""
        _arm(api)
        t = _issue(api, 'delete_path', {'path': 'whatever.txt'})
        r1 = json.loads(api.set_clipboard('hello', token=t))
        assert r1.get('error') and 'token' in r1['error']
        r2 = json.loads(api.take_screenshot(token=t))
        assert r2.get('error') and 'token' in r2['error']
        r3 = json.loads(api.get_clipboard(token=t))
        assert r3.get('error') and 'token' in r3['error']

    def test_clipboard_screenshot_enforce_hooks_armed(self, api):
        """S4②：clipboard_read/write、take_screenshot 执行点挂 enforce（武装后无 token 即拒）。"""
        _arm(api)
        for r in (json.loads(api.get_clipboard()),
                  json.loads(api.set_clipboard('x')),
                  json.loads(api.take_screenshot())):
            assert r.get('error') and 'token' in r['error']
        # 换成合法 token 后放行（ClipboardService 假桩路径）
        t = _issue(api, 'clipboard_write', {'len': 1})
        assert 'error' not in json.loads(api.set_clipboard('x', token=t))

    def test_kill_process_token_pid_binding(self, api, monkeypatch):
        monkeypatch.setattr(api._process, 'resolve_name_by_pid', lambda pid: 'notepad.exe')
        _arm(api)
        t = _issue(api, 'kill_process', {'pid': 1234, 'name': ''})
        r = json.loads(api.kill_process(pid=1234, token=t))
        assert r.get('ok') is True
        # token 绑定 pid=1234 → 用于 1235 必须失败
        r2 = json.loads(api.kill_process(pid=1235, token=t))
        assert r2.get('error') and 'token' in r2['error']

    def test_mcp_call_token_digest(self):
        gs = GuardService(guard_path=os.path.join(tempfile.mkdtemp(), 'g.json'))
        t = gs.issue_confirm_token('mcp_call', {'server': 's', 'tool': 't'})['token']
        assert gs.consume_token('mcp_call', {'server': 's', 'tool': 't'}, t) is True   # 首次消耗成功
        assert gs.consume_token('mcp_call', {'server': 's', 'tool': 't'}, t) is False  # 重放即失效
        t2 = gs.issue_confirm_token('mcp_call', {'server': 's', 'tool': 't'})['token']
        assert gs.consume_token('mcp_call', {'server': 's', 'tool': 'other'}, t2) is False
        t3 = gs.issue_confirm_token('mcp_call', {'server': 's', 'tool': 't'})['token']
        assert gs.consume_token('mcp_call', {'server': 's', 'tool': 't'}, t3) is True

    def test_unknown_op_token_rejected(self, api):
        r = json.loads(api.guard_confirm_token('not_an_op', '{}'))
        assert 'error' in r


# ============================================================ S5：删工作区根
class TestS5DeleteRootProtection:
    def test_delete_empty_path_rejected(self, api):
        assert 'error' in json.loads(api.delete_path(''))

    def test_delete_ws_root_rejected(self, api):
        assert 'error' in json.loads(api.delete_path(ws()))

    def test_delete_dot_rejected(self, api):
        r = json.loads(api.delete_path('.'))
        assert 'error' in r and '拒绝删除' in r['error']

    def test_delete_mixed_case_root_rejected(self, api):
        head, tail = os.path.split(ws())
        mixed = os.path.join(head, tail.swapcase())
        r = json.loads(api.delete_path(mixed))
        assert 'error' in r and '拒绝删除' in r['error']
        assert os.path.isdir(ws())

    def test_delete_session_effective_root_rejected(self, api, tmp_path):
        other = str(tmp_path / 'other_ws')
        os.makedirs(other, exist_ok=True)
        r = json.loads(api.set_session_ws('sidA', other, True))
        assert 'error' not in r
        api.set_current_sid('sidA')
        assert 'error' in json.loads(api.delete_path(other))
        assert 'error' in json.loads(api.delete_path('.'))

    def test_send2trash_missing_no_root_delete(self, api, monkeypatch):
        """send2trash 缺失 → 子项永久删除且醒目警示，但根永不降级删除。"""
        monkeypatch.setitem(sys.modules, 'send2trash', None)
        api.make_dir('sub2')
        api.write_file('sub2/f.txt', 'x')
        r = json.loads(api.delete_path('sub2'))
        assert r.get('ok') is True
        assert '永久删除' in r['mode'] and '不可恢复' in r['mode']
        assert 'error' in json.loads(api.delete_path('.'))       # 根仍被拒
        assert os.path.isdir(ws()) and os.path.exists(os.path.join(ws(), 'a.txt'))


# ============================================================ S6：search_replace 编码护栏
class TestS6SearchReplaceEncoding:
    def test_gbk_emoji_rejected(self, api):
        r = json.loads(api.search_replace('gbk.txt', '中文', '中文😀'))
        assert 'error' in r and '无法表示' in r['error']

    def test_lossy_decode_rejected(self, api):
        p = os.path.join(ws(), 'lossy.txt')
        with open(p, 'wb') as f:
            f.write(b'\x80\x81\x82abc')                # 非 UTF-8 非 GBK → lossy
        r = json.loads(api.search_replace('lossy.txt', 'a', 'b'))
        assert 'error' in r and '无损识别' in r['error']

    def test_binary_short_circuit(self, api):
        r = json.loads(api.search_replace('bin.dat', 'a', 'b'))
        assert 'error' in r and '二进制' in r['error']

    def test_newline_semantics_legacy_byte_identical(self, api, tmp_path):
        """写回换行语义与 legacy 逐字节一致（含「累积换行污染」的契约复刻）。

        legacy 行为：bytes 解码不翻译 + open('w', enc) 写回翻译 \n→os.linesep
        → 二次编辑 \r\n→\r\r\n。新实现 fio.atomic_write_text_mode 同语义（INTENTIONAL_DELTA
        裁决证据：污染被逐字节复刻，契约差分零漂移）。
        """
        p = os.path.join(ws(), 'crlf.txt')
        with open(p, 'wb') as f:
            f.write(b'a\r\nb')
        ref = str(tmp_path / 'legacy_ref.txt')

        def legacy_equiv(raw, old, new):
            text = raw.decode('utf-8').replace(old, new)
            with open(ref, 'w', encoding='utf-8') as f:      # legacy 直写（文本模式翻译）
                f.write(text)
            with open(ref, 'rb') as f:
                return f.read()

        assert json.loads(api.search_replace('crlf.txt', 'b', 'c'))['ok'] is True
        with open(p, 'rb') as f:
            got1 = f.read()
        assert got1 == legacy_equiv(b'a\r\nb', 'b', 'c')      # Windows: b'a\r\r\nc'
        # 第二次编辑：污染累积复刻（26→28→30 型字节增长）
        assert json.loads(api.search_replace('crlf.txt', 'c', 'd'))['ok'] is True
        with open(p, 'rb') as f:
            got2 = f.read()
        assert got2 == legacy_equiv(got1, 'c', 'd')

    def test_atomic_write_text_mode_translates_newline(self, tmp_path):
        p = str(tmp_path / 'mode.txt')
        atomic_write_text_mode(p, 'a\nb', 'utf-8')
        with open(p, 'rb') as f:
            assert f.read() == b'a\r\nb'                      # newline=None 平台翻译
        assert not [x for x in os.listdir(str(tmp_path)) if 'glm_tmp' in x]


# ============================================================ S7：read_file 大小护栏
class TestS7ReadFileSizeGuard:
    def test_oversize_rejected_before_read(self, api, monkeypatch):
        monkeypatch.setattr(os.path, 'getsize', lambda p: 10 * 1024 ** 3)
        r = json.loads(api.read_file('big.txt'))
        assert 'error' in r and '64MB' in r['error']


# ============================================================ S8：原子写
class TestS8AtomicWrite:
    def test_roundtrip_no_tmp_residue(self, tmp_path):
        p = str(tmp_path / 'a.json')
        atomic_write_text(p, '{"x": 1}')
        assert io.open(p, encoding='utf-8').read() == '{"x": 1}'
        assert not [x for x in os.listdir(str(tmp_path)) if 'glm_tmp' in x]

    def test_failure_leaves_original_intact(self, monkeypatch, tmp_path):
        p = str(tmp_path / 'a.json')
        atomic_write_text(p, 'ORIG')

        def boom(src, dst):
            raise OSError('replace denied')
        monkeypatch.setattr(os, 'replace', boom)
        with pytest.raises(OSError):
            atomic_write_text(p, 'NEW')
        assert io.open(p, encoding='utf-8').read() == 'ORIG'
        assert not [x for x in os.listdir(str(tmp_path)) if 'glm_tmp' in x]

    def test_concurrent_writes_never_corrupt(self, tmp_path):
        p = str(tmp_path / 'c.json')
        payloads = ['{"w": %d, "pad": "%s"}' % (i, 'x' * 2000) for i in range(8)]

        def worker(s):
            for _ in range(15):
                atomic_write_text(p, s)

        ths = [threading.Thread(target=worker, args=(s,)) for s in payloads]
        [t.start() for t in ths]
        [t.join() for t in ths]
        data = json.loads(io.open(p, encoding='utf-8').read())   # 必为某一完整版本
        assert data['pad'] == 'x' * 2000 and 0 <= data['w'] < 8
        assert not [x for x in os.listdir(str(tmp_path)) if 'glm_tmp' in x]

    def test_save_sessions_rejects_invalid(self, api):
        assert 'error' in json.loads(api.save_sessions('{broken json'))
        assert 'error' in json.loads(api.save_sessions('{"a": 1}'))       # 非数组
        assert json.loads(api.save_sessions('[{"id": "s1"}]'))['ok'] is True
        assert json.loads(api.get_sessions()) == [{'id': 's1'}]

    def test_guard_config_atomic(self, api):
        api.guard_save_config('{"tiers": {"delete_path": "session"}}')
        cfg = json.loads(io.open(GUARD_FILE, encoding='utf-8').read())
        assert cfg['tiers']['delete_path'] == 'session'
        assert not [x for x in os.listdir(paths.CONFIG_DIR) if 'glm_tmp' in x]


# ============================================================ S10：toolcache 淘汰
class TestS10ToolcacheEviction:
    def test_fifo_eviction_with_disk_delete(self):
        svc = ToolcacheService(do_cleanup=False)
        fps = {}
        for i in range(1, 46):
            cid = svc.cache('content-%d' % i)
            fps[cid] = os.path.join(paths.TOOLCACHE_DIR, cid + '.txt')
            assert cid.startswith('tc%d_' % i)
        assert len(svc._mem) == 40
        assert list(svc._mem)[0].startswith('tc6_')            # 插入序：tc1-tc5 被淘汰
        for cid in list(fps)[:5]:
            r = json.loads(svc.read_more(cid))                  # 内存已 pop
            assert 'error' in r
            assert not os.path.exists(fps[cid]), '淘汰未同步删磁盘: %s' % fps[cid]
        # 字典序错乱回归：'tc10_x' < 'tc2_x'，原实现会先淘汰 tc10（较新）
        r10 = json.loads(svc.read_more([c for c in fps if c.startswith('tc10_')][0]))
        assert r10['ok'] is True and r10['content'] == 'content-10'
        assert os.path.exists(fps[[c for c in fps if c.startswith('tc45_')][0]])

    def test_startup_stale_cleanup(self):
        os.makedirs(paths.TOOLCACHE_DIR, exist_ok=True)
        stale = os.path.join(paths.TOOLCACHE_DIR, 'tc_stale.txt')
        fresh = os.path.join(paths.TOOLCACHE_DIR, 'tc_fresh.txt')
        for p in (stale, fresh):
            with open(p, 'w', encoding='utf-8') as f:
                f.write('x')
        old = time.time() - 25 * 3600
        os.utime(stale, (old, old))
        ToolcacheService(do_cleanup=True)
        assert not os.path.exists(stale) and os.path.exists(fresh)


# ============================================================ S12/S13：MCP client
class TestS12S13McpClient:
    def test_s12_error_frame_with_null_id_human_message(self):
        class T:
            def post(self, obj, timeout):
                return {'jsonrpc': '2.0', 'id': None,
                        'error': {'code': -32000, 'message': '服务器内部错误'}}
        c = McpClient(T())
        with pytest.raises(McpProtocolError) as ei:
            c.ping()
        assert '服务器内部错误' in str(ei.value)
        assert 'id' not in str(ei.value)                 # 不再误报「响应 id 不匹配」

    def test_s13_http_404_no_infinite_recursion(self):
        from backend.domains.integrations.mcp.mcp_transport_http import HttpTransportError

        class T404:
            def __init__(self):
                self.calls = 0

            def post(self, obj, timeout):
                self.calls += 1
                raise HttpTransportError('HTTP 404: session expired', code=404)

            def reset_session(self):
                pass

        t = T404()
        c = McpClient(t)
        c._initialized = True
        with pytest.raises(McpProtocolError) as ei:
            c.ping()
        assert '404' in str(ei.value) or '重连' in str(ei.value)
        assert t.calls <= 3                               # 无递归放大（原约 330 层）


# ============================================================ S14/S15/W16：HTTP 传输
class TestMcpHttpTransport:
    def test_s14_watchdog_aborts_keepalive_stream(self):
        t = HttpTransport('http://x')

        class KeepaliveResp:
            headers = {'Content-Type': 'text/event-stream'}

            def read1(self, n):
                return b': keepalive\r\n\r\n'             # 永远只有注释帧

            def close(self):
                pass

        with pytest.raises(HttpTransportError) as ei:
            t._read_sse(KeepaliveResp(), timeout=1, req_obj={'id': 1})
        assert 'watchdog' in str(ei.value) or '整体超时' in str(ei.value)

    def test_s14_first_response_frame_returns_early(self):
        t = HttpTransport('http://x')

        class OneFrameResp:
            headers = {'Content-Type': 'text/event-stream'}

            def __init__(self):
                self._chunks = [b'data: {"jsonrpc": "2.0", "id": 1, "result": {"ok": 1}}\n\n',
                                b': ka\n\n']

            def read1(self, n):
                return self._chunks.pop(0) if self._chunks else b''

            def close(self):
                pass

        r = t._read_sse(OneFrameResp(), timeout=5, req_obj={'id': 1})
        assert r == {'jsonrpc': '2.0', 'id': 1, 'result': {'ok': 1}}

    def test_w16_multiline_data_bom_and_notification_dispatch(self):
        t = HttpTransport('http://x')
        seen = []
        t.on_frame = seen.append
        raw = (b'\xef\xbb\xbfdata: {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}\n\n'
               b'data: {"a":\ndata: 1}\n\n')
        r = t._parse_sse(raw, req_obj={'id': 5})
        assert r == {'a': 1}                              # 多行 data 以 \n 拼接 + BOM 剥离
        assert len(seen) == 1 and 'list_changed' in seen[0]['method']   # W15 通知上交

    def test_s15_no_redirect_leaks_authorization(self):
        srv1 = srv2 = None
        try:
            class H1(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(302)
                    self.send_header('Location', self.server.target2 + '/steal')
                    self.send_header('Content-Length', '0')
                    self.end_headers()

                def log_message(self, *a):
                    pass

            class H2(BaseHTTPRequestHandler):
                seen = []

                def do_GET(self):
                    H2.seen.append(dict(self.headers))
                    self.send_response(200)
                    self.send_header('Content-Length', '2')
                    self.end_headers()
                    self.wfile.write(b'ok')

                def log_message(self, *a):
                    pass

            srv1 = HTTPServer(('127.0.0.1', 0), H1)
            srv2 = HTTPServer(('127.0.0.1', 0), H2)
            srv1.target2 = 'http://127.0.0.1:%d' % srv2.server_address[1]
            for s in (srv1, srv2):
                threading.Thread(target=s.serve_forever, daemon=True).start()
            req = __import__('urllib.request', fromlist=['x']).Request(
                'http://127.0.0.1:%d/x' % srv1.server_address[1],
                headers={'Authorization': 'Bearer qa-s15-secret'})
            with pytest.raises(Exception) as ei:
                urlopen_no_redirect(req, timeout=5)
            assert getattr(ei.value, 'code', None) == 302 or '302' in str(ei.value)
            assert H2.seen == [], '重定向目标收到请求：Authorization 跨域泄漏'
        finally:
            for s in (srv1, srv2):
                if s:
                    s.shutdown()
                    s.server_close()

    def test_s15_handler_disables_redirect(self):
        h = _NoRedirectHandler()
        assert h.redirect_request(None, None, 302, 'Found', None, 'http://evil/x') is None

    def test_s15_provider_service_uses_safe_urlopen(self):
        assert 'urlopen_no_redirect' in _src('backend/domains/providers/provider_service.py')


# ============================================================ S16 / S17
class TestS16S17:
    def test_s16_tieroverrides_preserved(self, tmp_path):
        cfg = McpConfigService(path=str(tmp_path / 'mcp.json'))
        base = {'command': 'echo', 'args': ['hi'], 'enabled': False,
                'tierOverrides': {'toolA': 'off'}}
        assert 'error' not in cfg.save_server('s', dict(base))
        r = cfg.save_server('s', {'command': 'echo', 'args': ['hi2'], 'enabled': False})
        assert 'error' not in r
        view = cfg.get_server('s')
        assert view['tierOverrides'] == {'toolA': 'off'}   # 未携带 → 保留既有
        r = cfg.save_server('s', {'command': 'echo', 'args': ['hi3'], 'enabled': False,
                                  'tierOverrides': {'toolB': 'always'}})
        assert cfg.get_server('s')['tierOverrides'] == {'toolB': 'always'}   # 显式 → 覆盖

    def test_s17_missing_sha256_rejected(self, api):
        r = json.loads(api.start_update_download('http://127.0.0.1:1/x', ''))
        assert 'error' in r and 'sha256' in r['error']
        r2 = json.loads(api.start_update_download('http://127.0.0.1:1/x', '   '))
        assert 'error' in r2


# ============================================================ ㉒：_2 后缀派发一致性
class TestMcpNameDispatch:
    def test_backend_alias_roundtrip(self, tmp_path):
        cfg = McpConfigService(path=str(tmp_path / 'mcp.json'))
        cfg.save_server('srv', {'command': 'echo', 'args': ['x'], 'enabled': True})
        gs = GuardService(guard_path=str(tmp_path / 'g.json'))
        tc = ToolcacheService(do_cleanup=False)
        mcp = McpService(cfg, gs, tc)
        try:
            entry = mcp._ensure_entry('srv')
            entry['status'] = 'ok'
            entry['tools'] = [{'name': 'dup', 'description': 'a'},
                              {'name': 'dup', 'description': 'b'}]
            schemas = mcp.tool_schemas()
            names = [s['function']['name'] for s in schemas]
            assert names == ['mcp__srv__dup', 'mcp__srv__dup_2']
            assert mcp._resolve_names('srv', 'dup_2') == ('srv', 'dup')
            assert mcp._resolve_names('srv', 'dup') == ('srv', 'dup')
        finally:
            mcp.shutdown()

    def test_frontend_parse_consistency(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({});
  __run(ctx, __fe('62-mcp-exec.js'));
  __run(ctx, `globalThis.__out = [
    mcpParseName('mcp__srv__dup_2'),
    mcpParseName('mcp__my-server__my_tool'),
    mcpParseName('plain_name'),
    mcpParseName(''),
  ];`);
  return ctx.__out;
}
""", 'mcp_parse')
        assert r[0] == {'server': 'srv', 'tool': 'dup_2'}
        assert r[1] == {'server': 'my-server', 'tool': 'my_tool'}
        assert r[2] is None and r[3] is None


# ============================================================ W6 / W8 / W10-W13 / W17
class TestWarningItems:
    def test_w6_setclipboard_failure_frees_gmem_and_reports(self, monkeypatch):
        buf = ctypes.create_unicode_buffer('x' * 128)
        ptr = ctypes.cast(buf, ctypes.c_void_p).value
        free_calls = []

        class K32:
            GlobalAlloc = staticmethod(lambda f, s: 777)
            GlobalLock = staticmethod(lambda h: ptr)
            GlobalUnlock = staticmethod(lambda h: 1)
            GlobalFree = staticmethod(lambda h: free_calls.append(h) or 0)

        class U32:
            IsClipboardFormatAvailable = staticmethod(lambda f: 1)
            OpenClipboard = staticmethod(lambda h: 1)
            GetClipboardData = staticmethod(lambda f: 4242)
            CloseClipboard = staticmethod(lambda: 1)
            EmptyClipboard = staticmethod(lambda: 1)
            SetClipboardData = staticmethod(lambda f, h: 0)      # 恒 NULL → 失败

        monkeypatch.setattr(ctypes, 'windll', types.SimpleNamespace(
            user32=U32, kernel32=K32, shell32=types.SimpleNamespace()))
        r = json.loads(ClipboardService().set_clipboard('hello'))
        assert 'error' in r and '写入失败' in r['error']          # 不再谎报「已写入」
        assert len(free_calls) >= 1                                # GMEM 已释放

    def test_w8_append_limit_does_not_reset(self, api):
        ok_count = 0
        for i in range(8):
            r = json.loads(api.append_file('applog.txt', 'L%d\n' % i))
            if r.get('ok'):
                ok_count += 1
            else:
                assert '频次上限' in r.get('error', '')
        assert ok_count == 6                                       # 10 分钟 6 次
        with open(os.path.join(ws(), 'applog.txt'), encoding='utf-8') as f:
            assert f.read() == ''.join('L%d\n' % i for i in range(6))   # 拦截的不写入

    def test_w10_listless_list_downgraded_to_confirm(self, api):
        api.guard_save_config('{"tiers": {"take_screenshot": "list"}}')
        r = json.loads(api.guard_check('take_screenshot'))
        assert r['action'] == 'confirm'

    def test_w11_pattern_normcase_and_empty_path(self):
        gs = GuardService(guard_path=os.path.join(tempfile.mkdtemp(), 'g.json'))
        target = os.path.join(ws(), 'a.txt')
        assert gs._path_protected('') is None                      # 空 path 不落 CWD 误伤
        gs.save_config(json.dumps({'protect_paths': [target.swapcase()]}))
        assert gs._path_protected(target) is not None              # 大小写/写法差异归一

    def test_w12_audit_rotation(self, monkeypatch, tmp_path):
        import backend.domains.security.guard_service as gmod
        monkeypatch.setattr(gmod, 'AUDIT_MAX_BYTES', 512)
        ap = str(tmp_path / 'audit_log.jsonl')
        gs = GuardService(guard_path=str(tmp_path / 'g.json'), audit_path=ap)
        for i in range(6):
            gs.audit('delete_path', {'path': 'p%d' % i, 'note': 'x' * 120})
        assert os.path.exists(ap.replace('.jsonl', '.1.jsonl'))    # 已轮转
        r = json.loads(gs.read_audit())
        assert r['ok'] is True and r['total'] >= 1

    def test_w13_oem_decode_roundtrip(self):
        assert _decode_console('中文进程名.exe'.encode('gbk')) == '中文进程名.exe'
        assert _decode_console('中文进程名.exe'.encode('utf-8')) == '中文进程名.exe'

    def test_w17_stdio_env_whitelist(self, monkeypatch):
        monkeypatch.setenv('GLM_QA_SECRET', 'leaky-key')
        t = StdioTransport()
        code = ('import os,json;print(json.dumps({"secret": os.environ.get("GLM_QA_SECRET"),'
                '"path": bool(os.environ.get("PATH"))}))')
        assert t.start(sys.executable, ['-c', code], {}) is True
        try:
            frame = t.recv(timeout=20)
        finally:
            t.close()
        assert frame is not None
        assert frame['secret'] is None and frame['path'] is True

    def test_w18_queue_bounded(self):
        assert StdioTransport()._queue.maxsize == 1024

    def test_w23_apply_dev_mode_and_exit_chain(self, api):
        r = json.loads(api.apply_update())
        assert 'error' in r and '开发模式' in r['error']
        src = _src('backend/domains/integrations/update_service.py')
        assert 'echo ok> "{sentinel}"' in src                     # sentinel 标记
        assert '_force_exit_for_update' in src and 'os._exit(0)' in src   # 主动退出
        assert 'copy /y "{old}.bak"' in src                       # 备份回滚


# ============================================================ 建议项行为级
class TestSuggestionItems:
    def test_5_strip_quotes_repeatedly(self, api):
        for p in ('"q5.txt"', ' "q5.txt" '):
            r = json.loads(api.write_file(p, 'x'))
            assert r.get('ok') is True, r
        assert os.path.exists(os.path.join(ws(), 'q5.txt'))

    def test_6_save_config_invalid_json_reports(self, api):
        r = json.loads(api.save_config('{invalid'))
        assert 'error' in r and '解析失败' in r['error']

    def test_w29_backend_roundtrip(self, api):
        """对抗性抽查④：localStorage 剔除密钥后，后端 config.json 仍是可读回的唯一真源。"""
        assert json.loads(api.save_config('{"api_key": "sk-qa-roundtrip", "model": "m"}'))['ok'] is True
        cfg = json.loads(api.get_config())
        assert cfg['api_key'] == 'sk-qa-roundtrip'

    def test_15_16_shlex_args_preserve_spaces(self, tmp_path):
        cfg = McpConfigService(path=str(tmp_path / 'mcp.json'))
        r = cfg.save_server('s', {'command': 'x', 'args': '-c "hello world" foo',
                                  'enabled': False})
        assert 'error' not in r
        view = cfg.get_server('s')
        assert view['args'] == ['-c', 'hello world', 'foo']       # 带空格参数不再被劈开

    def test_1_dead_state_removed(self):
        # ast 断言（不被 docstring 注释干扰）：RuntimeState 不再为 form/core/last_bounds 赋值
        import ast
        tree = ast.parse(_src('backend/runtime.py'))
        assigned = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) \
                    and node.value.id == 'self' and isinstance(node.ctx, ast.Store):
                assigned.add(node.attr)
        assert not ({'form', 'core', 'last_bounds'} & assigned), assigned

    def test_3_legacy_seq_lock_present(self):
        assert '_TOOL_SEQ_LOCK' in _src('main_v1.0.0_legacy.py')

    def test_w1_ok_serialization_fallback(self):
        from backend.errors import ok
        r = json.loads(ok({'blob': b'\x00\x01'}))                 # bytes 不可 JSON 化
        assert 'blob' in r


# ============================================================ 死代码验证（移交裁决②）
class TestDeadCodeAtomicWriteBytes:
    def test_no_callers(self):
        """file_service._atomic_write_bytes 在 search_replace 改用
        fio.atomic_write_text_mode 后已无调用方（除定义本身全库零引用）→ 可删。"""
        total = 0
        for rel in ['backend/domains/workspace/file_service.py']:
            total += _src(rel).count('_atomic_write_bytes')
        for dirpath, dirs, fns in os.walk(os.path.join(PROJECT_ROOT, 'backend')):
            dirs[:] = [d for d in dirs if d != '__pycache__']
            for fn in fns:
                if fn.endswith('.py') and os.path.join(dirpath, fn) != \
                        os.path.join(PROJECT_ROOT, 'backend/domains/workspace/file_service.py'):
                    total += io.open(os.path.join(dirpath, fn),
                                     encoding='utf-8').read().count('_atomic_write_bytes')
        for rel in ['main.py', 'main_v1.0.0_legacy.py']:
            total += _src(rel).count('_atomic_write_bytes')
        # 死代码已删除：全库（定义处亦清除）零引用
        assert total == 0, '_atomic_write_bytes 应已删除，仍有 %d 次引用' % total


# ============================================================ 源码级断言（S9/S11/W2/W7/W14/W18/W19/W21/W22/㉚㉛ 等）
class TestSourceLevelFixes:
    def test_s9_main_startup_guard(self):
        src = _src('main.py')
        assert '修复 S9' in src and 'except Exception' in src

    def test_s11_kill_tree(self):
        import inspect
        import backend.domains.workspace.cmd_service as cmd_mod
        assert 'taskkill' in inspect.getsource(cmd_mod._kill_tree)   # 模块级函数（非 CmdService 方法）
        assert '_kill_tree' in inspect.getsource(CmdService._exec)

    def test_w2_spec_hiddenimports(self):
        src = _src('Harbor.spec')
        assert 'send2trash' in src and 'PIL.ImageGrab' in src and 'hiddenimports' in src

    def test_w7_w14_screenshot_service(self):
        src = _src('backend/domains/workspace/screenshot_service.py')
        assert '_MAX_SIDE = 1920' in src                          # W7 缩放
        assert '_KEEP_COUNT = 20' in src and '_KEEP_DAYS = 7' in src   # W14 留存清理

    def test_w19_spawn_expandvars(self):
        import inspect
        assert 'expandvars' in inspect.getsource(McpService._spawn_client)

    def test_w21_w22_mcp_service(self):
        src = _src('backend/domains/integrations/mcp/mcp_service.py')
        assert '修复 W21' in src and 'dpapi:' in src              # 密文串不下发
        assert '修复 W22' in src and 'refreshing' in src          # 通知洪泛去抖

    def test_w18_stdio_limits(self):
        src = _src('backend/domains/integrations/mcp/mcp_transport_stdio.py')
        assert '_MAX_LINE = 8 * 1024 * 1024' in src and '_QUEUE_MAX = 1024' in src

    def test_w4_w5_legacy(self):
        src = _src('main_v1.0.0_legacy.py')
        assert '修复 W4' in src and '修复 W5' in src and '__main__' in src

    def test_s18_settimeout_continue(self):
        src = _fe('60-agent-loop.js')
        # S7/W20（二轮）后结构变化：setTimeout 回调内先校验会话与 isStreaming 再续跑
        assert 'setTimeout(() => {' in src and 'continueLastGeneration(s, apiKey)' in src
        assert 'currentSessionId !== s.id' in src                     # S7 跨会话不续跑
        assert '▸▸ 继续输出' in src                                   # W20 拦截时补手动按钮

    def test_w24_w25_w27_agent_loop(self):
        src = _fe('60-agent-loop.js')
        executor = _fe('frontend/src/agent/model-executor.js')
        assert '!response.ok && response.status === 400' in executor  # W24 恒假分支
        assert "content: '[已向 AI 发送当前屏幕截图]'" in src      # W25 字段
        assert 'memFlushed' in src                                # W27 增量记忆

    def test_30_31_tool_stream_compat(self):
        src = _fe('60-agent-loop.js')
        parser = _fe('frontend/src/agent/sse-parser.js')
        assert 'tc.index != null' in parser                       # ㉚ 缺 index 兼容
        assert 'Array.isArray(parsed.content)' in src             # ㉛ MCP 数组截断

    def test_41_build_syntax_check(self):
        src = _src('frontend/build.js')
        assert 'new Function(script)' in src and '</script>' in src


# ============================================================ 前端 node 实测
class TestFrontendNode:
    def test_s19_w28_markdown_fail_closed(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ requestAnimationFrame: function(fn){ (ctx2().raf = ctx2().raf || []).push(fn); } });
  function ctx2(){ return ctx; }
  // escapeHtml 需要专用 div 桩：textContent 存原文，innerHTML 取转义
  ctx.document.createElement = function(t){
    if (t === 'div') { const d = { _t: '',
      set textContent(v){ this._t = v; }, get innerHTML(){
        return String(this._t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); } };
      return d; }
    return __mkEl(t);
  };
  __run(ctx, __fe('50-markdown.js'));
  __run(ctx, `
    globalThis.__r1 = renderMd('<img onerror="alert(1)"> hi');
    window.marked = { parse: (t) => '<b>RAW' + t + '</b>' };
    globalThis.__r2 = renderMd('<script>x</script>');
    window.DOMPurify = { sanitize: () => { throw new Error('boom'); } };
    globalThis.__r3 = renderMd('<img src=x onerror=1>');
  `);
  // W28：scheduleRender 按 el 去重（WeakSet 只需对象身份，普通对象即可）
  __run(ctx, `
    const el1 = {}, el2 = {};
    scheduleRender(el1, () => 'X'); scheduleRender(el1, () => 'X'); scheduleRender(el2, () => 'Y');
    globalThis.__rafCount = (typeof raf !== 'undefined' && raf) ? raf.length : 0;
  `);
  const raf = ctx.raf || [];
  raf.forEach(fn => fn());
  return {
    r1: ctx.__r1, r2: ctx.__r2, r3: ctx.__r3,
    rafCount: raf.length,
    el1: ctxEl1(), el2: ctxEl2(),
  };
  function ctxEl1(){ return null; } function ctxEl2(){ return null; }
}
""", 's19_markdown')
        assert '&lt;img' in r['r1'] and '<img' not in r['r1']
        assert '&lt;script' in r['r2'] and 'RAW' not in r['r2']   # 有 marked 无 purify → 不用裸 marked
        assert '&lt;img' in r['r3']                                # 消毒抛异常 → 转义文本
        assert r['rafCount'] == 2                                  # 同 el 去重、异 el 不丢

    def test_s20_send_double_fire_single_loop(self):
        r = _run_node(r"""
async function __main() {
  const s1 = { id: 's1', title: 't', createdAt: 1, updatedAt: 1, worklogInjected: true,
    messages: [{role:'user',content:'a'},{role:'assistant',content:'b'},{role:'user',content:'c'}] };
  const captured = [];
  const ctx = __ctx({
    isStreaming: false, attachments: [], currentSessionId: 's1', sessions: [],
    effectiveApiKey: function(){ return 'k'; },
    ensureSession: function(){}, getCurrentSession: function(){ return s1; },
    sumSessionTokens: function(){ return 0; }, recallMemory: function(){ return null; },
    addMessage: function(){ return {}; }, addMsgActions: function(){},
    updateSessionTitle: function(){}, saveSessions: function(){},
    renderSessionList: function(){}, renderPreview: function(){}, toast: function(){},
    compactNow: async function(){},
    runAgentLoop: function(ss, k){ captured.push({ streaming: ctx.isStreaming }); },
  });
  ctx.document.getElementById = function(id){
    if (id === 'userInput') return { value: 'hello world', style: {} };
    if (id === 'settingsPanel') return { classList: { add: function(){} } };
    return { value: '', style: {} };
  };
  __run(ctx, __fe('100-send.js'));
  const p1 = ctx.sendMessage();
  const p2 = ctx.sendMessage();      // 快速双击：第一尚未完成
  await p1; await p2;
  return { captured: captured, streaming: ctx.isStreaming };
}
""", 's20_double_fire')
        assert len(r['captured']) == 1, '双发未被守卫拦截: %s' % r['captured']
        assert r['captured'][0]['streaming'] is True
        assert r['streaming'] is True, 'S20：首次发送后 isStreaming 应保持置位（桩 runAgentLoop 同步返回前的守卫窗口）'

    def test_s21_compact_clears_readkeys(self):
        r = _run_node(r"""
async function __main() {
  const msgs = [];
  for (let i = 0; i < 6; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(120) + ' msg' + i });
  const s = { id: 's1', title: 't', messages: msgs, _readKeys: ['ws/a.txt'], apiFrozen: null, updatedAt: 1 };
  const added = [];
  const ctx = __ctx({
    isStreaming: false,
    addMessage: function(role, msg){ added.push(msg); return {}; },
    isGlmEndpoint: function(){ return false; },
    providerState: { model: 'm' },
    resolveApiEndpoint: function(){ return 'http://127.0.0.1:9'; },
    fetch: async function(){ return { json: async () => ({
      choices: [{ message: { content: '纪要：完成了任务目标' } }], usage: {total_tokens: 1} }) }; },
    saveSessions: function(){}, callApi: async function(){ return '""'; },
    updateLiveTokenStat: function(){},
    summarizeToolResult: function(){ return '[summarized]'; },
    AbortSignal: { timeout: function(ms){ return { __stub: true }; } },   // vm 沙箱无 Node 全局，compactNow 的 fetch signal 需要
    window2: null,
  });
  __run(ctx, __fe('97-compact.js'));
  await ctx.compactNow(s, 'k', { force: true });
  return { readKeys: s._readKeys, first: s.messages[0].content.slice(0, 20),
           n: s.messages.length, added: added };
}
""", 's21_readkeys')
        assert r['readKeys'] == []
        assert '【历史纪要' in r['first']
        assert r['n'] <= 3
        assert any('已压缩' in m for m in r['added'])

    def test_s22_uiconfirm_queue_and_fallback(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({});
  __run(ctx, __fe('18-toast.js'));
  __run(ctx, `globalThis.__m = { uiConfirm, _closeModal, _modalRoot };`);
  const tick = () => new Promise(r2 => setTimeout(r2, 25));
  const m = ctx.__m;
  // 真实 DOM 语义：模态关闭后 getElementById 返回 null，开弹计数走全局 __MODAL_OPENS
  const curModal = () => ctx.document.getElementById('modalRoot');

  // ① 串行队列：两个并发确认依次弹窗，不互相覆盖
  const p1 = m.uiConfirm({ title: 'A' });
  const p2 = m.uiConfirm({ title: 'B' });
  await tick();
  const opensAfterFirst = __MODAL_OPENS.length;
  const r1a = (opensAfterFirst === 1);
  curModal().querySelector('.modal-ok').onclick();          // 允许第一个
  const v1 = await p1;
  await tick();
  const opensAfterSecond = __MODAL_OPENS.length;
  curModal().querySelector('.modal-cancel').onclick();      // 取消第二个
  const v2 = await p2;

  // ② 兜底 resolve：模态被外部关闭时挂起确认按「取消」收尾
  const p3 = m.uiConfirm({ title: 'C' });
  await tick();
  m._closeModal();
  const v3 = await p3;

  // ③ 模态复用重绘兜底 + 队列继续（不双发、不自我取消）
  const p4 = m.uiConfirm({ title: 'D' });
  await tick();
  m._modalRoot();                                       // 另一查看器重绘模态
  const v4 = await p4;
  await tick();                                         // 若队列误双发，这里会再弹一个
  const p5 = m.uiConfirm({ title: 'E' });
  await tick();
  curModal().querySelector('.modal-ok').onclick();
  const v5 = await p5;
  return { r1a, opensAfterFirst, opensAfterSecond, v1, v2, v3, v4, v5,
           finalOpens: __MODAL_OPENS.length };
}
""", 's22_confirm')
        assert r['r1a'] and r['opensAfterFirst'] == 1      # 第二个模态未提前覆盖第一个
        assert r['opensAfterSecond'] == 2                  # 第一个收尾后才弹第二个
        assert r['v1']['ok'] is True and r['v2']['ok'] is False
        assert r['v3']['ok'] is False                      # 外部关闭 → 兜底取消
        assert r['v4']['ok'] is False                      # 重绘复用 → 兜底取消
        assert r['v5']['ok'] is True                       # 队列照常继续，无重复弹窗卡死
        assert r['finalOpens'] == 5

    def test_s23_audit_viewer_opens(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(name, args){
      if (name === 'get_audit_log') return JSON.stringify({ ok: true, total: 3, entries: [
        { ts: 't1', op: 'delete_path', action: 'block', decision: 'backend-enforced', detail: { path: 'p1' } },
        { ts: 't2', op: 'clipboard_write', action: 'decision', decision: 'allow', detail: { len: 5, head: 'h' } },
        { ts: 't3', op: 'kill_process', action: 'decision', decision: 'deny', detail: { pid: '1', name: 'n' } },
      ] });
      return '[]';
    },
    GUARD_OP_LABEL: { delete_path: '删除文件/目录', clipboard_write: '写入剪贴板', kill_process: '结束进程' },
  });
  __run(ctx, __fe('18-toast.js'));
  __run(ctx, __fe('28-audit-viewer.js'));
  let err = null;
  try { await ctx.openAuditViewer(); } catch (e) { err = String(e); }
  const box = ctx.document.getElementById('auditList');
  const rowsAll = box.children.length;
  __run(ctx, `_auditFilter = 'rejected';`);
  await ctx.renderAuditList();
  const rowsRejected = box.children.length;
  return { err, rowsAll, rowsRejected };
}
""", 's23_audit')
        assert r['err'] is None                             # 原实现首开即 ReferenceError
        # 筛选标签原文是「拒绝与阻断」：block/backend-enforced + deny 都应命中 → 3 条中 2 条
        assert r['rowsAll'] == 3 and r['rowsRejected'] == 2  # 筛选可用（_auditFilter 已声明）

    def test_s24_w31_zip_bomb_and_whitelist(self):
        r = _run_node(r"""
async function __main() {
  const toasts = [];
  const rendered = [];
  let attachments = [];
  const ctx = __ctx({
    attachments: attachments,
    toast: function(msg, type){ toasts.push({ msg: String(msg), type: type }); },
    renderPreview: function(){ rendered.push(1); },
    escapeHtml: function(s){ return String(s).replace(/</g,'&lt;'); },
    TextDecoder: TextDecoder, TextEncoder: TextEncoder,   // vm 沙箱无 Node 全局（readAttachmentText 依赖）
  });
  Object.defineProperty(ctx, 'attachments', {
    get: function(){ return attachments; }, set: function(v){ attachments = v; } });

  function mkfile(name, originalSize, data){ return { name: name, originalSize: originalSize,
    data: data, ondata: null, start: function(){ this._started = true; } }; }
  function makeFakeFlate(entries, bytesPerPush) {
    class Unzip {
      constructor(cb){ this.cb = cb; this.started = false; }
      push(chunk, final) {
        if (!this.started) { this.started = true; for (const e of entries) this.cb(e); }
        for (const e of entries) {
          if (e._started && e.ondata) {
            const n = Math.min(bytesPerPush || e.data.length, e.data.length);
            e.ondata(null, e.data.subarray(0, n), final);
          }
        }
      }
    }
    return { Unzip: Unzip };
  }
  const enc = new TextEncoder();

  // ① zip bomb：每次喂入 1MB，回调每拍吐 10MB，累计超 200MB 必须中止
  ctx.flate = makeFakeFlate([mkfile('huge.txt', 1000, new Uint8Array(10 * 1024 * 1024).fill(65))],
                            10 * 1024 * 1024);
  const bombBuf = new Uint8Array(30 * 1024 * 1024);
  const bomb = { name: 'bomb.zip', size: bombBuf.length,
    arrayBuffer: async () => bombBuf.buffer };

  // ② W31 白名单：.env/.reg 不解压，仅 .txt（敏感内容不得进入发往云端的附件文本）
  const mixedFiles = [mkfile('a.env', 10, enc.encode('SECRET=1')),
                      mkfile('b.reg', 10, enc.encode('regdata')),
                      mkfile('c.txt', 10, enc.encode('hello-txt'))];
  const w31Buf = new Uint8Array(4096);
  const w31 = { name: 'mix.zip', size: w31Buf.length, arrayBuffer: async () => w31Buf.buffer };

  __run(ctx, __fe('90-attachments.js'));
  // 源文件声明了真实 renderPreview（函数声明覆盖注入桩）——重注入计数桩
  ctx.renderPreview = function(){ rendered.push(1); };

  const bombToasts = toasts.length;
  await ctx.handleFiles([bomb], 'zip');
  const bombResult = { toasts: toasts.slice(), attachments: attachments.length,
                       rendered: rendered.length };

  // UI 可恢复性（对抗性抽查③）：炸弹中止后继续处理正常文本附件
  const note = { name: 'note.txt', size: 5,
    arrayBuffer: async () => enc.encode('hello').buffer };
  await ctx.handleFiles([note], 'text');
  const recovery = { attachments: attachments.length,
                     name: attachments.length ? attachments[0].name : null,
                     text: attachments.length ? attachments[0].text : null };

  // W31 / 2MB 丢弃
  toasts.length = 0; attachments = [];
  ctx.flate = makeFakeFlate(mixedFiles, undefined);
  await ctx.handleFiles([w31], 'zip');
  const w31res = { toasts: toasts.slice(), attachments: attachments.map(a => ({
    name: a.name, text: String(a.text || '') })) };

  // 2MB 单文件丢弃
  toasts.length = 0; attachments = [];
  ctx.flate = makeFakeFlate([mkfile('big.txt', 100, new Uint8Array(3 * 1024 * 1024).fill(66))],
                            undefined);
  const bigBuf = new Uint8Array(64);
  const big = { name: 'big.zip', size: 64, arrayBuffer: async () => bigBuf.buffer };
  await ctx.handleFiles([big], 'zip');
  const bigRes = { toasts: toasts.slice(), attachments: attachments.length };

  return { bombResult, recovery, w31res, bigRes };
}
""", 's24_zip')
        b = r['bombResult']
        assert b['attachments'] == 0, 'zip bomb 中止后不应有附件: %s' % b
        assert any('200MB' in t['msg'] for t in b['toasts']), b['toasts']
        assert b['rendered'] >= 1                          # UI 状态已刷新
        rec = r['recovery']
        assert rec['attachments'] == 1 and rec['name'] == 'note.txt' and rec['text'] == 'hello'
        w = r['w31res']
        assert len(w['attachments']) == 1
        txt = w['attachments'][0]['text']
        assert '===== c.txt' in txt and 'hello-txt' in txt
        assert 'SECRET=1' not in txt and 'regdata' not in txt   # .env/.reg 未解压直发云端
        bg = r['bigRes']
        assert bg['attachments'] == 0 and any('没找到' in t['msg'] for t in bg['toasts'])

    def test_s25_frozen_form_multimodal(self):
        r = _run_node(r"""
async function __main() {
  const multi = { role: 'user', content: [
    { type: 'text', text: '描述这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(5000) } },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,' + 'B'.repeat(5000) } },
  ] };
  const sess = { messages: [multi, { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'next' }], apiFrozen: null };
  // buildMessagesForAPI 经 getCurrentSession() 取冻结表——冻结的必须是同一个会话对象
  const ctx = __ctx({ getCurrentSession: function(){ return sess; } });
  __run(ctx, __fe('35-frozen-compact.js'));
  const frozenStr = ctx.frozenForm(multi);
  const userPlain = ctx.frozenForm({ role: 'user', content: 'plain user text' });
  const toolLong = ctx.frozenForm({ role: 'tool', content: 'x'.repeat(3000) });
  ctx.freezeBeforeCurrentTask(sess);
  const built = ctx.buildMessagesForAPI(sess.messages);
  const serialized = JSON.stringify(built);
  return { frozenStr, userPlain, toolHasSummary: toolLong.indexOf('已固化摘要') >= 0,
           apiFrozenCount: Object.keys(sess.apiFrozen).length,
           noBase64: serialized.indexOf('AAAA') < 0 && serialized.indexOf('BBBB') < 0,
           hasPlaceholders: serialized.indexOf('[图片]') >= 0 && serialized.indexOf('[视频]') >= 0 };
}
""", 's25_frozen')
        assert '[图片]' in r['frozenStr'] and '[视频]' in r['frozenStr']
        assert '描述这张图' in r['frozenStr']                # 数组分支先于 user 判断
        assert r['userPlain'] is None                        # 普通用户文本仍全量保留
        assert r['toolHasSummary'] is True
        assert r['apiFrozenCount'] == 1                      # 仅旧任务多模态消息被冻结
        assert r['noBase64'] is True and r['hasPlaceholders'] is True

    def test_s26_w30_normalize_sessions(self):
        r = _run_node(r"""
async function __main() {
  const store = {};
  const backendSessions = JSON.stringify([
    { id: 'sB', title: 'backend-version', updatedAt: 2, createdAt: 1, messages: [] }]);
  store['glm_sessions'] = JSON.stringify([
    { id: 'sA', title: 'local-only', updatedAt: 5, createdAt: 1, messages: [{ role: 'user' }] },
    { id: 'sB', title: 'local-newer', updatedAt: 9, createdAt: 1, messages: [] }]);
  const ctx = __ctx({
    sessions: [], currentSessionId: null,
    localStorage: { getItem: function(k){ return k in store ? store[k] : null; },
                    setItem: function(k, v){ store[k] = String(v); } },
    callApi: async function(name, args){
      if (name === 'get_sessions') return backendSessions;
      throw new Error('backend write failed'); },
    toast: function(){},
  });
  ctx.window.pywebview = { api: {} };
  __run(ctx, __fe('65-session-store.js'));
  const n1 = ctx.normalizeSessions('{}');
  const n2 = ctx.normalizeSessions('null');
  const n3 = ctx.normalizeSessions('{broken');
  const n4 = ctx.normalizeSessions(null);
  const n5 = ctx.normalizeSessions([null, 5, 'x', { id: 'ok', title: 't', messages: 'notarray' }]);
  const good = ctx.normalizeSessions([{ id: 'g1', title: 't', createdAt: 1, updatedAt: 2,
    messages: [{ role: 'user' }], _readKeys: ['k'], apiFrozen: { a: 1 } }]);
  await ctx.loadSessions();     // W30 双源按 updatedAt 合并
  const merged = ctx.sessions.map(s2 => s2.id + ':' + s2.title).sort();
  return { n1: n1.length, n2: n2.length, n3: n3.length, n4: n4.length,
           n5: n5.length, n5msgs: n5[0] && n5[0].messages,
           good: good[0], merged: merged };
}
""", 's26_normalize')
        assert r['n1'] == 0 and r['n2'] == 0 and r['n3'] == 0 and r['n4'] == 0
        assert r['n5'] == 1 and r['n5msgs'] == []            # 坏条目过滤 + messages 兜底 []
        g = r['good']
        assert g['id'] == 'g1' and len(g['messages']) == 1 and g['_readKeys'] == ['k'] \
            and g['apiFrozen'] == {'a': 1}                   # 合法会话与附加字段不丢
        # W30：sB 取 updatedAt 较新的本地版（9 > 2），sA 保留
        assert r['merged'] == ['sA:local-only', 'sB:local-newer']

    def test_w29_saveconfig_excludes_keys_locally(self):
        r = _run_node(r"""
async function __main() {
  const store = {};
  const saved = [];
  const ctx = __ctx({
    collectConfig: function(){ return { api_key: 'sk-QA-SECRET', provider_key: 'pk-QA-SECRET',
                                        model: 'm' }; },
    localStorage: { getItem: function(k){ return null; },
                    setItem: function(k, v){ store[k] = String(v); } },
    callApi: async function(name, args){ saved.push([name, args]); return '{"ok":true}'; },
    toast: function(){},
  });
  ctx.window.pywebview = { api: {} };
  const src = __fe('70-config.js');
  const m = /async function saveConfig\(\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) return { fatal: 'saveConfig 提取失败' };
  __run(ctx, m[0]);
  await ctx.saveConfig();
  const local = store['glm_config'] || '';
  const backendArg = (saved[0] && saved[0][1] && saved[0][1][0]) || '';
  return { local: local, backendArg: backendArg,
           localClean: local.indexOf('sk-QA-SECRET') < 0 && local.indexOf('provider_key') < 0,
           backendKeeps: backendArg.indexOf('sk-QA-SECRET') >= 0 };
}
""", 'w29_saveconfig')
        assert r.get('fatal') is None, r
        assert r['localClean'] is True                        # localStorage 不含密钥
        assert r['backendKeeps'] is True                      # 后端 config.json 保留密钥
        assert '"model":"m"' in r['local']                    # 非密钥配置照常本地缓存

    def test_agent_run_owner_prevents_stale_finally(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ currentSessionId: 'a', isStreaming: false,
    sendMessage: function(){}, toast: function(){} });
  __run(ctx, __fe('60-agent-loop.js'));
  const first = __vm.runInContext(`(() => {
    const r = { id: 1, sessionId: 'a', cancelled: false,
      abortController: null, nudgeTimer: null, localWaitTimer: null };
    __agentActiveRun = r; isStreaming = true; return r;
  })()`, ctx);
  __vm.runInContext(`currentSessionId = 'b'; cancelActiveAgentLoop();`, ctx);
  const second = __vm.runInContext(`(() => {
    const r = { id: 2, sessionId: 'b', cancelled: false,
      abortController: null, nudgeTimer: null, localWaitTimer: null };
    __agentActiveRun = r; isStreaming = true; return r;
  })()`, ctx);
  ctx.__firstRun = first;
  ctx.__secondRun = second;
  return {
    cancelled: first.cancelled,
    oldCanResetNew: __vm.runInContext(`__agentActiveRun === __firstRun`, ctx),
    newOwned: __vm.runInContext(`agentRunCurrent(__secondRun)`, ctx),
    streaming: ctx.isStreaming
  };
}
""", 'agent_run_owner')
        assert r['cancelled'] is True
        assert r['oldCanResetNew'] is False
        assert r['newOwned'] is True and r['streaming'] is True

    def test_cancelled_run_balances_only_its_own_assistant(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({ currentSessionId: 'a', isStreaming: false,
    sendMessage: function(){}, saveSessions: function(){} });
  __run(ctx, __fe('60-agent-loop.js'));
  return __vm.runInContext(`(() => {
    const oldAssistant = { role: 'assistant', content: null,
      tool_calls: [{id: 'old-1'}, {id: 'old-2'}] };
    const newAssistant = { role: 'assistant', content: null,
      tool_calls: [{id: 'new-1'}] };
    const oldSession = { id: 'a', messages: [oldAssistant,
      {role: 'tool', tool_call_id: 'old-1', content: 'done'}, newAssistant] };
    const newSession = { id: 'b', messages: [newAssistant] };
    fillMissingToolResults(oldSession, oldAssistant);
    const beforeNewSession = JSON.stringify(newSession.messages);
    fillMissingToolResults(newSession, oldAssistant);
    const legacySession = { messages: [{role: 'assistant', content: null,
      tool_calls: [{id: 'legacy-1'}]}] };
    fillMissingToolResults(legacySession);
    return {
      oldRoles: oldSession.messages.map(m => m.role + ':' + (m.tool_call_id || '')),
      oldNewAssistantUntouched: oldSession.messages[3] === newAssistant,
      newSessionUntouched: JSON.stringify(newSession.messages) === beforeNewSession,
      legacyDefaultWorks: legacySession.messages.length === 2 &&
        legacySession.messages[1].tool_call_id === 'legacy-1'
    };
  })()`, ctx);
}
""", 'cancelled_run_tool_balance')
        assert r['oldRoles'] == ['assistant:', 'tool:old-1', 'tool:old-2', 'assistant:']
        assert r['oldNewAssistantUntouched'] is True
        assert r['newSessionUntouched'] is True
        assert r['legacyDefaultWorks'] is True

    def test_cancelled_finally_uses_run_session_and_assistant(self):
        src = _fe('60-agent-loop.js')
        assert 'sessionId: s.id, session: s, cancelled: false,' in src
        assert 'assistantMsg: null, abortController: null' in src
        assert 'run.assistantMsg = assistantMsg;' in src
        assert 'if (run.cancelled) {' in src
        assert 'fillMissingToolResults(run.session, run.assistantMsg);' in src
        finally_at = src.rindex('if (run.cancelled) {')
        save_at = src.index('saveSessions();', finally_at)
        assert save_at > finally_at

    def test_attachment_permission_and_write_gate(self):
        r = _run_node(r"""
async function __main() {
  const toasts = [], calls = [];
  const s1 = { id: 's1', title: 't', createdAt: 1, updatedAt: 1,
    worklogInjected: true, messages: [] };
  const toolMode = { value: 'off', style: {} };
  const input = { value: 'hello', style: {} };
  const ctx = __ctx({
    isStreaming: false, currentSessionId: 's1', sessions: [],
    effectiveApiKey: function(){ return 'k'; }, localModeActive: function(){ return false; },
    ensureSession: function(){}, getCurrentSession: function(){ return s1; },
    historyTokens: function(){ return 0; }, recallMemory: function(){ return null; },
    addMessage: function(){ return {}; }, addMsgActions: function(){},
    updateSessionTitle: function(){}, saveSessions: function(){},
    renderSessionList: function(){}, toast: function(m){ toasts.push(String(m)); },
    runAgentLoop: function(){},
    callApi: async function(name, args){ calls.push({ name, args }); return '{"ok":true}'; }
  });
  ctx.document.getElementById = function(id){
    if (id === 'toolMode') return toolMode;
    if (id === 'userInput') return input;
    if (id === 'settingsPanel') return { classList: { add: function(){} } };
    return { value: '', style: {} };
  };
  __run(ctx, __fe('00-state.js'));
  __run(ctx, __fe('90-attachments.js'));
  ctx.renderPreview = function(){};
  __run(ctx, __fe('100-send.js'));
  let reads = 0;
  const file = { name: 'a.txt', size: 5,
    arrayBuffer: async () => { reads++; return new TextEncoder().encode('hello').buffer; } };
  await ctx.handleFiles([file], 'text');
  const denied = { reads, count: __vm.runInContext('attachments.length', ctx), toasts: toasts.slice() };
  toolMode.value = 'readonly';
  const s1messagesBefore = s1.messages.length;
  __vm.runInContext(`attachments = [{ type: 'text', name: 'a.txt', text: 'hello' }]`, ctx);
  input.value = 'hello';
  await ctx.sendMessage();
  const readonlyCalls = calls.filter(c => c.name === 'save_workspace_file').length;
  const readonlyText = JSON.stringify(s1.messages[s1.messages.length - 1]);
  __vm.runInContext('isStreaming = false', ctx);
  toolMode.value = 'full';
  __vm.runInContext(`attachments = [{ type: 'text', name: 'a.txt', text: 'hello' }]`, ctx);
  input.value = 'hello again';
  await ctx.sendMessage();
  const fullCalls = calls.filter(c => c.name === 'save_workspace_file').length;
  return { denied, readonlyCalls, readonlyText, fullCalls,
    messagesAdded: s1.messages.length - s1messagesBefore };
}
""", 'attachment_permission_gate')
        assert r['denied']['reads'] == 0 and r['denied']['count'] == 0
        assert any('纯聊天' in t for t in r['denied']['toasts'])
        assert r['readonlyCalls'] == 0 and '未写入工作区' in r['readonlyText']
        assert r['fullCalls'] == 1 and r['messagesAdded'] == 2


# ============================================================ 标记完整性（78 项在盘核对）
_CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊸'
_ALL_IDS = (['C1', 'C2'] + ['S%d' % i for i in range(1, 27)]
            + ['W%d' % i for i in range(1, 32)] + list(_CIRC))
# ㊷（CSP 纵深防御）按裁决显式缓修，不要求标记；
# ⑮/⑱/⑲/⑳/㉓ 并入相邻编号标记（见 TestMergedMarkers）。
_SPECIAL = {'㊷', '⑮', '⑱', '⑲', '⑳', '㉓'}


_TEXTS_CACHE = None


def _scan_texts():
    global _TEXTS_CACHE
    if _TEXTS_CACHE is not None:
        return _TEXTS_CACHE
    texts = {}
    for dirpath, dirs, fns in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in
                   ('.git', 'build', 'dist', '.pytest_cache', '__pycache__',
                    'node_modules', '.workbuddy-ai', 'deliverables', 'libs', 'tests')]
        for fn in fns:
            if fn.endswith(('.py', '.js', '.spec', '.html')):
                p = os.path.join(dirpath, fn)
                try:
                    texts[p] = io.open(p, encoding='utf-8', errors='replace').read()
                except Exception:
                    pass
    _TEXTS_CACHE = texts
    return texts


@pytest.mark.parametrize('fid', [i for i in _ALL_IDS if i not in _SPECIAL],
                         ids=lambda i: 'marker_' + i)
def test_fix_marker_present(fid):
    texts = _scan_texts()
    pat = re.compile(u'修复\\s*(?:建议\\s*)?' + re.escape(fid))
    assert any(pat.search(t) for t in texts.values()), '修复标记缺失: %s' % fid


class TestMergedMarkers:
    """5 处并标/误标取证：修复已落地但标记编号与报告不一致（维护性问题，非缺陷）。"""

    def test_15_merged_into_16_shlex(self):
        assert 'shlex.split' in _src('backend/domains/integrations/mcp/mcp_config_service.py')

    def test_18_snapshot_lock_marked_as_26(self):
        # 报告⑱（无锁快照撕开）实际落在 ㉖ 标记下（mcp_service 多字段快照加锁）
        src = _src('backend/domains/integrations/mcp/mcp_service.py')
        assert '多字段快照' in src and "entry.get('lock'" in src

    def test_19_20_idle_clock_marked_as_35(self):
        # 报告⑲⑳（idle 扫描间隔/非单调时钟）实际落在 ㊉ 标记下
        src = _src('backend/domains/integrations/mcp/mcp_service.py')
        assert '修复 ㊉' in src and 'time.monotonic()' in src
        assert 'IDLE_SWEEP_INTERVAL' in src

    def test_23_merged_into_24_provider(self):
        assert '修复 建议㉔' in _src('backend/domains/providers/provider_service.py')
