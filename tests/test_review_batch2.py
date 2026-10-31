# -*- coding: utf-8 -*-
"""2026-10-24 全库 bug 扫描·核心 api 域复核批回归（13 项实证修复）。

锁定：
- P0 kill_process 预算超限分支（16 处 enforce_exec_ex 挂点唯一漏判）；
- P1 审计哈希链衔接校验（删除/重排可检出）+ 挂链与落盘同临界区（文件序==链序）；
- P2 guard：browser_fill token 摘要双形态归一 / 保护名单双形匹配 / .bad 备份；
- P2 sandbox GetLastError / checkpoint 部分失败 ok 口径；
- P2 api：get_audit_log 单次读 / save_export_file 先校验后消费 / set_workspace 走 set_cwd。

铁律：全部 hermetic（fresh_home 隔离 + monkeypatch；不触网、不起真进程）。
"""
import json
import os
from pathlib import Path

import pytest

from conftest import fresh_home  # noqa: F401  （autouse 隔离 HOME）


# ============================================================ P0：kill_process 预算超限

class TestKillProcessBudgetGate:
    def _api(self):
        from backend.api import Api
        return Api()

    def test_budget_exceeded_blocks_kill(self):
        """escalated 态：enforce_exec_ex 返回 (None, payload)——原直落
        kill_process（预算机制对结束进程完全失效），现必须结构化拦截。"""
        api = self._api()
        api._guard.arm()
        api._guard._cfg['approval_budget'] = {'limit': 5, 'used': 10,
                                              'escalated': True}
        called = []

        def _boom(pid=None, name=None):
            called.append((pid, name))
            return {'ok': True}

        orig = api._process.kill_process
        orig_resolve = api._process.resolve_name_by_pid
        api._process.kill_process = _boom
        api._process.resolve_name_by_pid = lambda pid: (_ for _ in ()).throw(
            AssertionError('预算拒绝前不得反查进程'))
        try:
            r = json.loads(api.kill_process(pid=1234, name='notepad.exe', token=None))
            assert r.get('ok') is False, r
            assert r['error']['code'] == 'APPROVAL_BUDGET_EXCEEDED', r
            assert called == []                     # 未执行，也未做辅助进程查询
        finally:
            api._process.kill_process = orig
            api._process.resolve_name_by_pid = orig_resolve

    def test_normal_confirm_path_intact(self):
        """非 escalated 武装态：仍走 CONFIRM_REQUIRED（预算修正不短路授权链）。"""
        api = self._api()
        api._guard.arm()
        api._guard._cfg['approval_budget'] = {'limit': 5, 'used': 0,
                                              'escalated': False}
        r = json.loads(api.kill_process(pid=None, name='notepad.exe', token=None))
        assert r.get('error'), r                    # always 档无 token → 拒


class TestRuntimeWindowNudge:
    def test_ui_nudge_uses_runtime_window(self, monkeypatch):
        """窗口唯一所有者是 RuntimeState.win；不得读取不存在的 Api._win。"""
        import ctypes
        import types
        from backend.api import Api
        api = Api()
        api._runtime.win = types.SimpleNamespace(
            native=types.SimpleNamespace(Handle=4567))
        api._native_ui.register(api._runtime.win, 'main', lambda callback: callback())
        calls = []
        user32 = types.SimpleNamespace(
            RedrawWindow=lambda hwnd, a, b, flags: calls.append((hwnd.value, flags)) or 1)
        monkeypatch.setattr(ctypes, 'windll', types.SimpleNamespace(user32=user32))
        r = json.loads(api.ui_nudge('visible'))
        assert r['nudged'] is True and calls and calls[0][0] == 4567


# ============================================================ P1：审计哈希链

class TestAuditChainLinkage:
    def _chain(self, tmp_path):
        from backend.domains.security.audit_chain import AuditChain
        return AuditChain(path=str(Path(tmp_path) / 'chain.json'))

    def test_verify_ok_forward_and_reversed(self, tmp_path):
        ch = self._chain(tmp_path)
        entries = [ch.append({'op': 'op%d' % i, 'detail': {'i': i}})
                   for i in range(4)]
        assert ch.verify(entries)['ok'] is True          # 正序
        assert ch.verify(list(reversed(entries)))['ok'] is True   # 倒序窗口（read_audit 口径）

    def test_verify_detects_deletion(self, tmp_path):
        """删除中间条目：原实现仍 ok（删除不可检出），现衔接断裂必报。"""
        ch = self._chain(tmp_path)
        entries = [ch.append({'op': 'op%d' % i, 'detail': {'i': i}})
                   for i in range(4)]
        tampered = [entries[0], entries[2], entries[3]]  # 删掉 entries[1]
        r = ch.verify(tampered)
        assert r['ok'] is False and '衔接' in r['reason']

    def test_verify_detects_reorder(self, tmp_path):
        ch = self._chain(tmp_path)
        entries = [ch.append({'op': 'op%d' % i, 'detail': {'i': i}})
                   for i in range(4)]
        r = ch.verify([entries[0], entries[2], entries[1], entries[3]])
        assert r['ok'] is False and '衔接' in r['reason']

    def test_verify_detects_swap_attack(self, tmp_path):
        """偷换中间条目内容（重算自身 hash 但衔接对不上上游）。"""
        ch = self._chain(tmp_path)
        entries = [ch.append({'op': 'op%d' % i, 'detail': {'i': i}})
                   for i in range(3)]
        from backend.domains.security.audit_chain import entry_hash
        forged = dict(entries[1])
        forged['detail'] = {'i': 999}                    # 攻击者改内容并重算自身 hash
        body = {k: v for k, v in forged.items() if k not in ('hash', 'prev_hash')}
        forged['hash'] = entry_hash(forged['prev_hash'], body)
        r = ch.verify([entries[0], forged, entries[2]])
        assert r['ok'] is False                          # forged.prev_hash 指向 e0，但 e2.prev 指向真 e1

    def test_audit_file_order_matches_chain_order(self, tmp_path):
        """挂链与落盘同一临界区：并发审计下文件序==链序（衔接校验不误报）。"""
        import threading
        from backend.domains.security.guard_service import GuardService
        g = GuardService(audit_path=str(Path(tmp_path) / 'a.jsonl'))
        errs = []

        def worker(i):
            try:
                for k in range(10):
                    g.audit('op', {'i': i * 100 + k}, 'check')
            except Exception as e:                       # pragma: no cover
                errs.append(e)

        ts = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(10)
        assert not errs
        raw = g.read_audit(limit=1000, offset=0)
        entries = json.loads(raw)['entries']             # 倒序（最新在前）
        vr = g.audit_chain_verify(entries)
        assert vr['ok'] is True, vr                      # 文件序==链序（并发不误报）


# ============================================================ P2：guard 三处

class TestGuardReviewFixes:
    def test_fill_digest_dual_shape(self):
        """签发侧（text 原文）与执行侧（text_len）摘要必须一致——原执行侧
        恒 text_len:0，armed 态 token 永拒。"""
        from backend.domains.security.guard_service import GuardService
        issue = GuardService._canonical_detail(
            'browser_fill', {'selector': '#pw', 'text': 'abcde'})
        exec_ = GuardService._canonical_detail(
            'browser_fill', {'selector': '#pw', 'text_len': 5})
        assert issue == {'selector': '#pw', 'text_len': 5}
        assert issue == exec_

    def test_fill_token_issue_consume_roundtrip(self, tmp_path):
        """端到端：前端 detail 签发 token → api.browser_fill detail 消费成功。"""
        from backend.domains.security.guard_service import GuardService
        g = GuardService(guard_path=str(Path(tmp_path) / 'g.json'))
        g.arm()
        detail_issue = {'selector': '#pw', 'text': 'secret'}
        tok = g.issue_confirm_token('browser_fill', detail_issue)
        assert tok.get('token')                          # guard 层返回 {token,ttl}（api 层包 ok）
        detail_exec = {'selector': '#pw', 'text_len': 6}
        assert g.consume_token('browser_fill', detail_exec, tok['token']) is True

    def test_path_protected_matches_plain_form_under_redirection(self, tmp_path, monkeypatch):
        """OneDrive/junction 重定向：realpath 偏移后字面登记仍命中（双形匹配）。"""
        from backend.domains.security import guard_service as gs
        g = gs.GuardService(guard_path=str(Path(tmp_path) / 'g.json'))
        g._cfg['protect_paths'] = [gs._norm_pattern(r'C:\Users\x\Documents')]
        monkeypatch.setattr(gs.os.path, 'realpath',
                            lambda p: str(p).replace('Documents', 'OneDriveDocs')
                            if 'Documents' in str(p) else str(p))
        assert g._path_protected(r'C:\Users\x\Documents\note.md') == \
            gs._norm_pattern(r'C:\Users\x\Documents')
        assert g._path_protected(r'C:\Windows\system32\cmd.exe') is None

    def test_corrupt_guard_json_leaves_bad_backup(self, tmp_path):
        """guard.json 损坏：留 .bad 备份再回落默认（原无声清零且无迹可寻）。"""
        from backend.domains.security.guard_service import GuardService
        guard_json = Path(tmp_path) / 'g.json'
        guard_json.write_text('{corrupt!!!', encoding='utf-8')
        gs = GuardService(guard_path=str(guard_json))
        assert Path(str(guard_json) + '.bad').exists()
        cfg = json.loads(gs.get_config())
        assert isinstance(cfg, dict)


# ============================================================ P2：sandbox / checkpoint / api 三处

class TestMiscReviewFixes:
    def test_sandbox_uses_kernel32_get_last_error(self):
        """CreateProcessW 失败分支读 k32.GetLastError()（原 get_last_error
        在未开 use_last_error 的 windll 下恒 0；既有 H6 helper 注释里也提
        该词，故断言精确到赋值语句）。"""
        import inspect
        from backend.domains.workspace import sandbox_service as ss
        src = inspect.getsource(ss)
        assert 'code = ctypes.get_last_error()' not in src
        assert 'code = k32.GetLastError()' in src

    def test_checkpoint_partial_failure_not_ok(self, tmp_path):
        """快照恢复部分文件失败 → ok=False（与 git 路径口径一致）。"""
        from backend.domains.planning.checkpoint_service import CheckpointService
        svc = CheckpointService()
        ws = Path(tmp_path) / 'ws'
        ws.mkdir()
        snap = Path(tmp_path) / 'snap'
        snap.mkdir()
        (snap / 'a.txt').write_text('v1', encoding='utf-8')     # 只备份了 a
        (ws / 'a.txt').write_text('v2-current', encoding='utf-8')
        manifest = {'files': [
            {'path': 'a.txt', 'sha256': 'x', 'snapshot': True},
            {'path': 'b.txt', 'sha256': 'y', 'snapshot': True},  # 快照缺失 → 恢复失败
        ]}
        r = svc._rollback_snapshot(manifest, str(ws), str(snap))
        assert r['ok'] is False
        assert r['failed'] == ['b.txt'] and r['restored'] == ['a.txt']

    def test_get_audit_log_reads_file_once(self):
        """get_audit_log 只读一次审计文件（原连调两次 read_audit 全量扫描）。"""
        from backend.api import Api
        api = Api()
        calls = {'n': 0}
        orig = api._guard.read_audit

        def counting(*a, **kw):
            calls['n'] += 1
            return orig(*a, **kw)

        api._guard.read_audit = counting
        try:
            api.get_audit_log(limit=10)
        finally:
            api._guard.read_audit = orig
        assert calls['n'] == 1

    def test_save_export_file_oversize_keeps_registration(self):
        """超 8MB：先校验后消费——路径登记不被消费，重试无需重走对话框。"""
        from backend.api import Api
        api = Api()
        export_target = Path(os.environ.get('TEMP', str(Path.cwd()))) / 'harbor_exp.csv'
        api._export_paths.add(os.path.normcase(os.path.abspath(str(export_target))))
        r = json.loads(api.save_export_file(str(export_target), 'x' * (9 * 1024 * 1024)))
        assert r.get('error') and '8MB' in r['error']
        assert os.path.normcase(os.path.abspath(str(export_target))) in api._export_paths

    def test_set_workspace_routes_via_set_cwd(self, tmp_path):
        """set_workspace 走 set_cwd 统一入口（锁内 abspath+落盘）。"""
        from backend.api import Api
        api = Api()
        ws = Path(tmp_path) / 'ws'
        ws.mkdir()
        r = json.loads(api.set_workspace(str(ws)))
        assert r.get('ok') is True
        assert os.path.normcase(api._config.cwd) == \
            os.path.normcase(os.path.abspath(str(ws)))


class TestDedupeZeroHitDrop:
    """复核批修正回归：query 有核心词但全部结果零命中（反爬壳页噪声）→
    清空结果交由上层换引擎重试（原降级到尾部照常呈现垃圾）。"""

    def test_zero_hit_results_dropped(self):
        from backend.domains.integrations.browser.service import SearchService as SearchBrowser
        garbage = [
            {'title': '谷歌浏览器如何更改默认显示比例_百度知道',
             'url': 'https://zhidao.baidu.com/question/1', 'snippet': '点击设置'},
            {'title': '为什么Jeff Dean从Google离职引起这么大的轰动？ - 知乎',
             'url': 'https://www.zhihu.com/question/2', 'snippet': '怎么说呢'},
        ]
        out = SearchBrowser._dedupe_and_rank(garbage, '4399')
        assert out == []                              # 全零命中 → 清空

    def test_hit_results_kept_and_ranked(self):
        from backend.domains.integrations.browser.service import SearchService as SearchBrowser
        items = [
            {'title': 'Jeff Dean 动态', 'url': 'https://x/1', 'snippet': '与查询无关'},
            {'title': '4399手机游戏网', 'url': 'https://x/2', 'snippet': '4399 官方'},
            {'title': '4399 游戏盒子下载', 'url': 'https://x/3', 'snippet': '4399 游戏盒'},
        ]
        out = SearchBrowser._dedupe_and_rank(items, '4399')
        # 相关命中升前 + 零命中降尾（部分零命中保留——原设计口径）
        assert [r['url'] for r in out] == ['https://x/2', 'https://x/3', 'https://x/1']
        assert [r['position'] for r in out] == [1, 2, 3]

    def test_cjk_query_bigram_match(self):
        """CJK 查询按二元组匹配（你好 → 你好 命中；无关结果清空）。"""
        from backend.domains.integrations.browser.service import SearchService as SearchBrowser
        hit = [{'title': '你好，世界', 'url': 'https://x/1', 'snippet': ''}]
        miss = [{'title': '天气预报', 'url': 'https://x/2', 'snippet': ''}]
        assert len(SearchBrowser._dedupe_and_rank(hit, '你好')) == 1
        assert SearchBrowser._dedupe_and_rank(miss, '你好') == []


class TestBaiduStubCaptcha:
    """复核批修正回归：Baidu 无 Cookie 首访回无标记 meta-refresh 壳页
    （~4KB、零解析结果）→ 按验证页处理交人工接管（原走「未找到相关内容」）。"""

    def test_captcha_signal_wappass(self):
        from backend.domains.integrations.browser.service import _captcha_signal
        stub = ('<html><head><title></title></head><body>'
                '<script>location.replace("https://wappass.baidu.com/passport/'
                '?login&u=...")</script></body></html>')
        assert _captcha_signal(stub) is not None          # wappass 特征命中
        assert _captcha_signal('<html><title>正常页</title></html>') is None

    def test_captcha_signal_title_match(self):
        from backend.domains.integrations.browser.service import _captcha_signal
        assert _captcha_signal('<title>百度安全验证</title>') is not None

    def test_baidu_tiny_stub_browser_search(self, tmp_path, fresh_home, monkeypatch):
        """端到端：baidu 引擎【重试耗尽】后抓到 4KB 零结果壳页 →
        CAPTCHA_REQUIRED 交接管（重试链中不抢跑；原走「未找到相关内容」）。
        fresh_home 隔离（防读到真机缓存里的历史垃圾结果）；窗口通道无 GUI 自动
        回落 urllib，在传输缝打桩返回壳页（hermetic，不触真网）。"""
        from backend.api import Api
        from backend.domains.integrations.browser import service, session_base, session_win
        import io as _io
        stub_html = ('<html><head><title></title></head><body><div>x</div></body>'
                     '</html>' + '<!-- padding -->' * 10)

        def fake_fetch(req, timeout=None):
            return _io.BytesIO(stub_html.encode('utf-8'))   # urlopen 形状（.read()）

        # 仅此 hermetic 用例跳过真实 DNS 的公网判定，避免测试机 DNS/代理影响；
        # 不修改产品 SSRF 策略，也不放松其他用例或重定向安全测试。
        monkeypatch.setattr(service, '_is_public_host', lambda host: True)
        monkeypatch.setattr(session_base, '_is_public_host', lambda host: True)
        monkeypatch.setattr(session_win, '_is_public_host', lambda host: True)
        monkeypatch.setattr(session_win, 'urlopen_follow_redirect_safe', fake_fetch)
        api = Api()
        r = json.loads(api.browser_search({'query': '4399', 'engine': 'baidu'}))
        assert r.get('ok') is False, r
        assert r['error']['code'] == 'CAPTCHA_REQUIRED', r
        assert r['error'].get('takeover_id'), r


class TestFollowRedirectSafe:
    """复核批新增：urlopen_follow_redirect_safe——搜索 GET 取数的
    安全跟随重定向（同 host 原样 / 跨 host 剥凭证 / SSRF 跳转拦截 / 封顶）。"""

    def _svc(self, monkeypatch, hops):
        """hops: [(status, location)] 依次弹出；返回 (helper, calls)。"""
        from backend.domains.integrations.mcp import mcp_transport_http as mth
        calls = []
        idx = {'n': 0}

        def fake_open(req, timeout=None):
            calls.append({'url': req.get_full_url(),
                          'headers': dict(req.headers)})
            if idx['n'] < len(hops):
                status, loc = hops[idx['n']]
                idx['n'] += 1
                import urllib.error
                hdrs = {'Location': loc} if loc else {}
                raise urllib.error.HTTPError(req.get_full_url(), status,
                                             'redirect', hdrs, None)
            class _R:
                def read(self, n=-1):
                    return b'ok'
                def __enter__(self):
                    return self
                def __exit__(self, *a):
                    return False
            return _R()

        monkeypatch.setattr(mth, 'urlopen_no_redirect', fake_open)
        return mth.urlopen_follow_redirect_safe, calls

    def test_same_host_follow_keeps_headers(self, monkeypatch):
        h, calls = self._svc(monkeypatch, [(302, '/results')])
        import urllib.request
        req = urllib.request.Request(
            'https://bing.com/search?q=x',
            headers={'User-agent': 'UA', 'Authorization': 'Bearer t'})
        r = h(req, timeout=5)
        assert r.read() == b'ok'
        assert calls[-1]['url'] == 'https://bing.com/results'
        assert calls[-1]['headers'].get('Authorization') == 'Bearer t'   # 同 host 原样

    def test_cross_host_follow_strips_credentials(self, monkeypatch):
        h, calls = self._svc(monkeypatch, [(302, 'https://cn.bing.com/search?q=x')])
        import urllib.request
        req = urllib.request.Request(
            'https://bing.com/search?q=x',
            headers={'User-agent': 'UA', 'Authorization': 'Bearer t',
                     'Cookie': 'k=v'})
        h(req, timeout=5)
        assert calls[-1]['url'].startswith('https://cn.bing.com')
        final = calls[-1]['headers']
        assert 'Authorization' not in final and 'Cookie' not in final    # 凭证剥离
        assert final.get('User-agent') == 'UA'                            # 非凭证保留

    def test_redirect_to_private_blocked(self, monkeypatch):
        from backend.domains.integrations.browser import session_base as sb
        monkeypatch.setattr(sb, '_is_public_host',
                            lambda host: not str(host or '').startswith(('127.', '10.')))
        h, calls = self._svc(monkeypatch, [(302, 'http://10.0.0.9/admin')])
        import urllib.request
        req = urllib.request.Request('https://bing.com/search?q=x')
        import urllib.error
        with pytest.raises(urllib.error.HTTPError) as ei:
            h(req, timeout=5)
        assert ei.value.code == 403 and 'SSRF' in str(ei.value.reason)

    def test_redirect_cap(self, monkeypatch):
        hops = [(302, '/r%d' % i) for i in range(8)]
        h, calls = self._svc(monkeypatch, hops)
        import urllib.request
        import urllib.error
        req = urllib.request.Request('https://bing.com/search')
        with pytest.raises(urllib.error.HTTPError) as ei:
            h(req, timeout=5)
        assert ei.value.code == 310 and len(calls) == 6   # max_redirects=5 → 6 次请求

    def test_non_get_stays_no_redirect(self, monkeypatch):
        """非 GET 不适用（保持 no-redirect 语义——调用方限定取数通道）。"""
        from backend.domains.integrations.mcp import mcp_transport_http as mth
        seen = []
        monkeypatch.setattr(mth, 'urlopen_no_redirect',
                            lambda req, timeout=None: seen.append(req.get_full_url()) or 'ok')
        import urllib.request
        req = urllib.request.Request('https://x/api', data=b'{}', method='POST')
        assert mth.urlopen_follow_redirect_safe(req, timeout=5) == 'ok'
        assert seen == ['https://x/api']


class TestAgentGuardTokenDelivery:
    """复核批修正回归（真机实锤）：guard_confirm_token 后端返回 {token,ttl}
    （api 层 ok() 只序列化、无 ok 键）——agentGuardCheck 原 `t.ok && t.token`
    判定恒假 → token 永不生效 → armed 态全部确认流（AI+面板手动）死循环在
    CONFIRM_REQUIRED。vm 沙箱以真后端形状（无 ok 键）打桩锁定 token 必达。"""

    def test_agent_guard_token_delivered_without_ok_key(self):
        from test_round7_adversarial import _run_js
        stubs = r"""
// ---- 桩：bridge（真后端形状：guard_confirm_token 无 ok 键）+ uiConfirm ----
const __resp = {
  guard_check: JSON.stringify({ action: 'confirm', reason: '需要确认' }),
  guard_confirm_token: JSON.stringify({ token: 'tok123', ttl: 60 })
};
function callApi(name, args, timeoutMs) {
  if (!(name in __resp)) return Promise.reject(new Error('未打桩: ' + name));
  return Promise.resolve(__resp[name]);
}
function toast() {}
function uiConfirm() { return Promise.resolve({ ok: true, checkbox: false }); }
function updateCostEstimate() {}
"""
        body = r"""
async function __main() {
  const out = { checks: [] };
  const ok = (n, c) => out.checks.push({ name: n, pass: !!c });
  const g = await agentGuardCheck('web_search', { query: 'q' });
  ok('token_delivered_without_ok_key',
     g && g.blocked === null && g.token === 'tok123');
  const g2 = await agentGuardCheck('web_search', { query: 'q2' });
  ok('second_issue_fresh_token',
     g2 && g2.token === 'tok123');
  return out;
}
"""
        out = _run_js('agent_guard_token', ['25-tool-exec.js'], stubs, body, 2)
