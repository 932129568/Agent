# -*- coding: utf-8 -*-
"""两个用户实测已知缺陷的复现与契约测试（2026-10-18 审查配套）。

背景：用户报告两个 bug——
  Bug A：调用 cmd 命令时重复执行、反复打开 cmd 窗口；
  Bug B：文本过长时超出文本框显示范围，未做溢出处理。
本轮只读审查结论（deliverables/code-review/full-code-review-2026-10-18-round3.md）：
  A 的根因 = 前端 cmdDeduper 单槽 last 语义（非紧邻重复放行）+ 两层去重键为精确字符串
    （del x.txt / del ./x.txt / del "x.txt" 变体双双绕过）；窗口面已核实 CREATE_NO_WINDOW
    全覆盖，可见窗口来自 open_app 无护栏/更新 bat（设计使然）。
  B 的根因 = 输入框本身在 WebView2 下由 UA 兜底不溢出（浏览器实测），真正的溢出缺口在
    toast 栈无 max-height、工具卡片标签无 min-width:0 被裁切。

测试分三类：
  1. 通过项（PASS）：锁定当前正确的行为（窗口隐藏、单次执行、GBK 解码），防回归；
  2. xfail(strict=False) 项：复现已知缺陷——断言「应有的正确行为」，当前失败转 xfail；
     缺陷修复后这些测试自动 XPASS（strict=False 不报错），届时可摘除 xfail 标记转正；
  3. 前端 node vm 沙箱：从 60-agent-loop.js 抽取真实 cmdDeduper 源码执行，非复刻伪实现。
"""
import io
import json
import os
import re
import subprocess
import tempfile

import pytest

from helpers.frontend import read_frontend_source, read_frontend_styles

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
TEMPLATE = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')

# ============================================================ 后端：命令执行窗口与单次性
class TestCmdExecutionWindow:
    """Bug A 的窗口面：当前代码已全程 CREATE_NO_WINDOW——锁定防回归。"""

    def test_run_command_popen_hidden_and_single(self, monkeypatch):
        from backend.domains.workspace import cmd_service
        calls = []

        class FakeProc:
            returncode = 0
            stdout = b''
            stderr = b''

            def communicate(self, timeout=None):
                return (b'', b'')

        def fake_popen(args, **kw):
            calls.append((args, kw))
            return FakeProc()

        # 保持 subprocess.run 为 stdlib（走 Popen 主路径），只替换 Popen
        monkeypatch.setattr(subprocess, 'Popen', fake_popen)
        svc = cmd_service.CmdService.__new__(cmd_service.CmdService)
        svc._log = cmd_service.get_logger()
        svc.cmd_deduper = cmd_service.RunDeduper()

        class _Ws:
            def effective_root(self, sid):
                return PROJECT_ROOT

        svc.workspace = _Ws()

        class _Tc:
            def cache(self, text):
                return 'tc_stub'

        svc.toolcache = _Tc()
        r = json.loads(svc.run_command('s1', 'echo hi', 30))
        assert r.get('error') is None and 'exit_code' in r, r
        assert len(calls) == 1, 'run_command 一次调用必须只执行一次子进程（防重复执行契约）'
        args, kw = calls[0]
        assert kw.get('creationflags', 0) & getattr(subprocess, 'CREATE_NO_WINDOW', 0), \
            'cmd 执行必须带 CREATE_NO_WINDOW（防可见 cmd 窗口）'
        assert isinstance(args, str) and args.startswith('chcp 65001'), args

    def test_run_powershell_popen_hidden(self, monkeypatch):
        from backend.domains.workspace import cmd_service
        calls = []

        class FakeProc:
            returncode = 0
            stdout = b''
            stderr = b''

            def communicate(self, timeout=None):
                return (b'', b'')

        monkeypatch.setattr(subprocess, 'Popen',
                            lambda args, **kw: (calls.append((args, kw)), FakeProc())[1])
        svc = cmd_service.CmdService.__new__(cmd_service.CmdService)
        svc._log = cmd_service.get_logger()
        svc.cmd_deduper = cmd_service.RunDeduper()
        svc.workspace = type('W', (), {'effective_root': lambda self, sid: PROJECT_ROOT})()
        svc.toolcache = type('T', (), {'cache': lambda self, t: 'tc_stub'})()
        r = json.loads(svc.run_powershell('s1', 'echo hi', 30))
        assert r.get('error') is None and 'exit_code' in r, r
        assert len(calls) == 1
        args, kw = calls[0]
        assert kw.get('creationflags', 0) & getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        assert args[0] == 'powershell'


# ============================================================ 后端：去重键口径（Bug A 根因）
class TestRunDeduperKeyNormalization:
    """两层去重键为精确字符串，语义等值变体可绕过——复现已知缺陷。"""

    def test_variant_quotes_bypasses_dedup(self):
        from backend.domains.workspace.cmd_service import RunDeduper
        d = RunDeduper()
        assert d.check('del x.txt') is None
        # 期望：语义等值变体应被拦；当前键口径（折叠空白+小写）放行 → 缺陷复现
        assert d.check('del "x.txt"') is not None

    def test_variant_dot_prefix_bypasses_dedup(self):
        from backend.domains.workspace.cmd_service import RunDeduper
        d = RunDeduper()
        assert d.check('del x.txt') is None
        assert d.check('del ./x.txt') is not None   # 当前放行 → 缺陷复现

    def test_nonadjacent_duplicate_bypasses_dedup(self):
        """单槽 last 语义：中间夹一条别的命令，同一条命令再次放行（Bug A 直接根因）。"""
        from backend.domains.workspace.cmd_service import RunDeduper
        d = RunDeduper()
        assert d.check('echo 1') is None
        assert d.check('echo 2') is None
        assert d.check('echo 1') is not None        # 当前放行 → 缺陷复现


# ============================================================ 后端：进程名解码启发式
class TestDecodeConsole:
    """_decode_console 的「替换符最少」未实现（s.count('') 恒为 len+1）——中文名回归锁定。"""

    def test_gbk_chinese_process_name(self):
        from backend.domains.workspace.process_service import _decode_console
        raw = '中文工具.exe'.encode('gbk')
        assert _decode_console(raw) == '中文工具.exe'

    def test_utf8_process_name(self):
        from backend.domains.workspace.process_service import _decode_console
        raw = '中文工具.exe'.encode('utf-8')
        assert _decode_console(raw) == '中文工具.exe'


# ============================================================ 前端：cmdDeduper 行为（node vm 真实源码）
def _extract_cmd_deduper_src():
    src = read_frontend_source(PROJECT_ROOT, '60-agent-loop.js')
    m = re.search(r'const cmdDeduper = \(\(\) => \{.*?\}\)\(\);', src, re.S)
    assert m, 'cmdDeduper IIFE 未在 60-agent-loop.js 中找到（源码结构变更？）'
    return m.group(0)


def _run_node(script):
    if not os.path.exists(NODE):
        pytest.skip('node 不可用')
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_knownbug_')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(script)
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


class TestFrontendCmdDeduper:
    """从 60-agent-loop.js 抽取真实 cmdDeduper 源码在 vm 执行（非复刻伪实现）。"""

    def _deduper(self):
        body = _extract_cmd_deduper_src() + r"""
;(async () => {
  const out = {};
  out.e1 = cmdDeduper.check('echo 1');
  out.e2 = cmdDeduper.check('echo 2');
  out.e1_again = cmdDeduper.check('echo 1');      // 非紧邻重复：期望被拦（当前 null）
  out.w1 = cmdDeduper.check('del x.txt');
  out.w_q = cmdDeduper.check('del "x.txt"');      // 引号变体：期望被拦（当前 null）
  out.w_dot = cmdDeduper.check('del ./x.txt');    // ./ 变体：期望被拦（当前 null）
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
"""
        return _run_node(body)

    def test_nonadjacent_duplicate_blocked(self):
        out = self._deduper()
        assert out['e1_again'] is not None, '非紧邻的同一条命令应被去重拦截（Bug A 根因复现）'

    def test_quote_variant_blocked(self):
        out = self._deduper()
        assert out['w_q'] is not None, 'del "x.txt" 与 del x.txt 语义等值，应被拦截'

    def test_dot_prefix_variant_blocked(self):
        out = self._deduper()
        assert out['w_dot'] is not None, 'del ./x.txt 与 del x.txt 语义等值，应被拦截'

    def test_first_and_second_pass(self):
        """基线契约：前两条不同命令必须放行（修复不得误伤正常去重）。"""
        out = self._deduper()
        assert out['e1'] is None and out['e2'] is None and out['w1'] is None


# ============================================================ 前端：文本溢出 CSS 契约（Bug B）
def _css_rule(html, selector):
    """提取 template 中指定选择器的规则体（大括号内原文）。"""
    m = re.search(re.escape(selector) + r'\{([^}]*)\}', html)
    return m.group(1) if m else None


class TestTextOverflowCss:
    """Bug B：溢出处理缺口的 CSS 契约。期望声明存在、当前缺失 → xfail 复现。"""

    def _tpl(self):
        return read_frontend_styles(PROJECT_ROOT)

    def test_input_textarea_explicit_overflow(self):
        rule = _css_rule(self._tpl(), '.input-row textarea')
        assert rule is not None, '.input-row textarea 规则缺失'
        assert 'overflow-y' in rule or 'overflow:' in rule, \
            '输入框封顶 160px 但未显式声明 overflow（当前依赖 UA 默认值）'
        assert 'overflow-wrap' in rule or 'word-break' in rule, \
            '输入框未声明 overflow-wrap/word-break（超长无空格串依赖 UA 软换行）'

    def test_toast_box_max_height(self):
        rule = _css_rule(self._tpl(), '#toastBox')
        assert rule is not None and 'max-height' in rule, \
            '#toastBox 无 max-height：长明细 toast 会长出视口且不可达（Bug B 真实缺口）'

    def test_toast_detail_max_height(self):
        rule = _css_rule(self._tpl(), '.toast-detail')
        assert rule is not None and ('max-height' in rule or 'overflow' in rule), \
            '.toast-detail 无高度上限/滚动：长错误明细不可达'

    def test_tool_call_item_label_min_width(self):
        html = self._tpl()
        rule = _css_rule(html, '.tool-call-item')
        assert rule is not None
        # flex 子项需 min-width:0 才能收缩，否则长标签被 overflow:hidden 无声裁切
        assert 'min-width' in html[html.find('.tool-call-item'):html.find('.tool-call-item') + 600], \
            '工具卡片标签缺 min-width:0，长命令/长路径标签被裁切（Bug B 真实缺口，浏览器实测）'
