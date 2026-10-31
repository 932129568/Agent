# -*- coding: utf-8 -*-
"""v1.8.0 C 域·build_tools include_agent 接线 + 前端工具分发验收测试。

覆盖（联调规范 §6 L0 契约门 + 任务书 C1/C2）：
- build_tools 差分（L0-3）：默认路径（include_agent=False）与 legacy 逐字节
  一致；include_agent=True 增量恰为 browser_*/software_* 工具族
  （browser_search/browser_open/software_call 三条定义）；R11 端点过滤
  两形态（GLM 端点 browser_* 不进工具集、非 GLM 全量）；chat/ro 角色
  不受影响；工具 schema 形状（required 字段）照 §3.1/§3.2 请求表；
- 前端 vm harness（node，test_v13_qa 同款）：25-tool-exec.js executeToolRaw
  新分支分发（browser_search 90000 / browser_open 60000 / software_call
  660000 同款口径 + 参数透传）+ CAPTCHA_REQUIRED 挂起标记（§2.4
  fail-fast）+ 60-agent-loop 接管等待态（harborTakeoverAwaitTerminal /
  harborTakeoverNotify：恢复 / last-wins 取代 / 用户停止放弃）；
- 契约门（L0-1/L0-2/L0-5）：11 个新 js_api 全进 _V12_EXTRA 且与 Api def
  一一对应、get_api_info 与 legacy 逐字节一致、check_contract PASS、
  build 两遍 md5 幂等。

铁律：默认路径逐字节不变（契约差分锁定）；get_api_info 零漂移（11 个新
方法 _V12_EXTRA 隐身）。
"""
import ast
import io
import json
import os
import subprocess
import sys
import tempfile

import pytest

from conftest import NewApi, legacy
from helpers.frontend import read_frontend_source

from backend import tools_schema

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
FRONTEND_SRC = os.path.join(PROJECT_ROOT, 'frontend', 'src')

NEW_APIS = {'software_list', 'software_probe', 'software_call',
            'hybrid_get_config', 'hybrid_save_config',
            'guard_task_grant', 'guard_task_revoke', 'guard_task_status',
            'guard_rule_list', 'guard_rule_add', 'guard_rule_remove'}
# v1.9.0 M5.1：AGENT 工具族自 3 扩至 9（+浏览器驱动六原语）——改从
# AGENT_TOOLS 常量动态推导（design 总账「以 AGENT_TOOLS 常量为基准」，
# 断言随 schema 演进，不再硬编码清单）
AGENT_TOOL_NAMES = [t['function']['name'] for t in tools_schema.AGENT_TOOLS]


# ============================================================ C1·build_tools 差分
class TestBuildToolsIncludeAgent:
    """include_agent 增量 + R11 端点过滤 + 默认路径逐字节（L0-3）。"""

    def test_default_path_byte_identical_to_legacy(self):
        """默认路径（include_agent 缺省/False）与 legacy 逐字节一致。"""
        # legacy ws_enabled 是模块级 _RT 全局——循环改写后必须复原，
        # 防跨文件状态泄漏（test_api_contract 依赖默认启用态）
        orig = legacy._RT['ws_enabled'].get('')
        try:
            for role in ('chat', 'ro', 'full'):
                for ws_on in (True, False):
                    legacy_api = legacy.Api()
                    legacy_api._current_sid = None
                    legacy._RT['ws_enabled'][''] = ws_on
                    expected = legacy_api.build_tools(role)
                    got = tools_schema.build(role, ws_on)
                    assert got == expected, 'build_tools(%r, ws_on=%r) 漂移' % (
                        role, ws_on)
                    # 显式传 False（任意 is_glm_endpoint 组合）同样逐字节一致
                    assert tools_schema.build(role, ws_on, include_agent=False,
                                              is_glm_endpoint=True) == expected
                    assert tools_schema.build(role, ws_on, include_agent=False,
                                              is_glm_endpoint=False) == expected
        finally:
            # legacy 语义：键缺失 = 启用（.get(sid, True)）——还原成「键缺失」
            # 而非显式 None（None 是 falsy，会把工作区关掉）
            if orig is None:
                legacy._RT['ws_enabled'].pop('', None)
            else:
                legacy._RT['ws_enabled'][''] = orig

    def test_api_default_path_unchanged(self):
        """Api.build_tools 旧调用形态（两参）输出不变。"""
        api = NewApi()
        assert api.build_tools('full') == api.build_tools('full', False)
        assert api.build_tools('full') == api.build_tools('full', False, False)
        assert api.build_tools('chat') == api.build_tools('chat', False, True)

    def test_increment_exactly_agent_family(self):
        """include_agent=True 增量恰为 browser_*/software_* 三条（前缀不变）。"""
        base = json.loads(tools_schema.build('full', True))
        inc = json.loads(tools_schema.build('full', True, include_agent=True))
        base_names = [t['function']['name'] for t in base]
        inc_names = [t['function']['name'] for t in inc]
        assert inc_names[:len(base_names)] == base_names, '增量污染了基础工具面'
        assert inc_names[len(base_names):] == AGENT_TOOL_NAMES

    def test_r11_endpoint_filtering_two_forms(self):
        """R11：GLM 端点只留 software_call（browser_* 不进）；非 GLM 全量。"""
        base = json.loads(tools_schema.build('full', True))
        base_names = [t['function']['name'] for t in base]
        glm = json.loads(tools_schema.build('full', True, include_agent=True,
                                            is_glm_endpoint=True))
        assert [t['function']['name'] for t in glm] == \
            base_names + ['software_call'], 'GLM 端点不得出现 browser_*'
        non_glm = json.loads(tools_schema.build('full', True,
                                                include_agent=True,
                                                is_glm_endpoint=False))
        assert [t['function']['name'] for t in non_glm] == \
            base_names + AGENT_TOOL_NAMES

    def test_chat_and_ro_roles_unaffected(self):
        """chat 恒空；ro 角色不追加 Agent 工具族（与 MCP 同款 full-only）。"""
        assert json.loads(tools_schema.build('chat', True,
                                             include_agent=True)) == []
        ro = json.loads(tools_schema.build('ro', True, include_agent=True))
        assert all(not t['function']['name'].startswith(('browser_',
                                                         'software_'))
                   for t in ro)

    def test_agent_tool_schema_shape(self):
        """Agent 工具 schema 形状照 §3.1/§3.2 请求字段（required 正确）。"""
        tools = {t['function']['name']: t['function']
                 for t in json.loads(tools_schema.build('full', True,
                                                        include_agent=True))}
        bs = tools['browser_search']['parameters']
        assert bs['required'] == ['query']
        for f in ('engine', 'site', 'filetype', 'time_range', 'lang',
                  'max_results', 'extract'):
            assert f in bs['properties'], f
        bo = tools['browser_open']['parameters']
        assert bo['required'] == ['url']
        assert set(bo['properties']) >= {'url', 'selector', 'max_chars'}
        sc = tools['software_call']['parameters']
        assert sc['required'] == ['software', 'action']
        assert set(sc['properties']) >= {'software', 'action', 'args',
                                         'timeout', 'source'}

    def test_mcp_and_agent_compose(self):
        """MCP 与 Agent 工具族可叠加（MCP 在前，Agent 尾部追加）。"""
        mcp = [{'type': 'function', 'function': {'name': 'mcp__x',
                'parameters': {'type': 'object', 'properties': {}}}}]
        tools = json.loads(tools_schema.build('full', True, mcp_tools=mcp,
                                              include_agent=True))
        names = [t['function']['name'] for t in tools]
        assert names[-(1 + len(AGENT_TOOL_NAMES)):] == \
            ['mcp__x'] + AGENT_TOOL_NAMES

    def test_api_passes_endpoint_judgement(self):
        """Api.build_tools 透传 include_agent + is_glm_endpoint。"""
        api = NewApi()
        inc = json.loads(api.build_tools('full', False, True, False))
        assert [t['function']['name'] for t in inc][-len(AGENT_TOOL_NAMES):] == \
            AGENT_TOOL_NAMES
        glm = json.loads(api.build_tools('full', False, True, True))
        assert 'browser_search' not in [t['function']['name'] for t in glm]
        assert 'software_call' in [t['function']['name'] for t in glm]

    def test_rpc_private_whitelist_reaches_software_save(self, tmp_path,
                                                         monkeypatch):
        """S 域用户 CRUD 经 rpc 白名单通道（_software_save/_software_remove）——
        契约 js_api 方法面恰为 software×3；其余私有方法仍拒绝。"""
        from backend.api import Api, _RPC_PRIVATE_OK
        from backend.domains.integrations import software_service as sw_mod
        assert _RPC_PRIVATE_OK == {'_software_save', '_software_remove'}
        monkeypatch.setattr(sw_mod, 'SOFTWARE_FILE',
                            str(tmp_path / 'software.json'))
        api = Api()
        r = json.loads(api.rpc('_software_save', json.dumps({
            'name': 'mytool',
            'entry': {'kind': 'cli', 'exec': 'mytool', 'actions': [
                {'name': 'version', 'risk': 'read', 'argv': ['--version'],
                 'arg_schema': {'type': 'object', 'properties': {}}}]}})))
        assert r.get('ok') is True, r
        lst = json.loads(api.software_list('all'))
        assert any(s['name'] == 'mytool' and s['source'] == 'user'
                   for s in lst['software'])
        assert json.loads(api.rpc('_software_remove',
                                  json.dumps({'name': 'mytool'})))['removed'] is True
        # 白名单外私有方法仍拒绝（防护不放松）
        bad = json.loads(api.rpc('_config', '{}'))
        assert 'error' in bad
        info = json.loads(api.get_api_info())
        assert '_software_save' not in info['methods']


# ============================================================ C2·前端 vm harness
def _extract_fn(src, pattern):
    """从源码抽取指定函数体（test_v13_qa 同款括号配平算法）。"""
    import re as _re
    m = _re.search(pattern, src)
    assert m, '未找到: %s' % pattern
    i = m.end() - 1
    depth = 0
    in_str = None
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
        i += 1
    raise AssertionError('括号未配平: %s' % pattern)


_TOOL_EXEC_HARNESS = r'''
// ---- 环境桩（pywebview 桥 + callApi + 护栏入口） ----
const __calls = [];
const __resp = {};
const window = { pywebview: { api: {} } };
let currentSessionId = 's1';
async function callApi(name, args, timeoutMs) {
  __calls.push({ name, args, timeoutMs });
  if (name === 'set_current_sid') return '{"ok":true}';
  if (name in __resp) return JSON.stringify(__resp[name]);
  return '{}';
}
async function guardCheckTool(name, args) { return { blocked: null, token: null }; }
async function mcpGuardCheck(name, args) {
  return { blocked: null, decision: 'allow', token: null };
}
// v1.8.0 §3.3/§4.4：护栏预置走数据层（__resp）——模块内 agentGuardCheck
// 真身会覆盖同名 stub（函数声明后置赢），必须让 guard_check 返回 allow
__resp['guard_check'] = { action: 'allow' };
// ---- module under test ----
__PANEL__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });

  // 1) browser_search 分发：参数透传 + timeoutMs=90000
  __resp['browser_search'] = { ok: true, query: 'q', engine: 'bing',
    source: 'live', results: [], elapsed_ms: 10 };
  let r = JSON.parse(await executeToolRaw('browser_search',
    { query: 'python', engine: 'bing' }));
  const bsCall = __calls.filter(c => c.name === 'browser_search').pop();
  ok('browser_search_dispatch', r.ok === true
     && bsCall && bsCall.timeoutMs === 90000
     && bsCall.args[0].query === 'python' && bsCall.args[0].engine === 'bing'
     && bsCall.args.length === 2);   // [params, token] 护栏链透传

  // 2) browser_open 分发：timeoutMs=60000
  __resp['browser_open'] = { ok: true, url: 'https://x', title: 't',
    content: 'c', truncated: false, extractor: 'readability' };
  r = JSON.parse(await executeToolRaw('browser_open',
    { url: 'https://x', selector: 'body', max_chars: 8000 }));
  const boCall = __calls.filter(c => c.name === 'browser_open').pop();
  ok('browser_open_dispatch', r.ok === true && boCall
     && boCall.timeoutMs === 60000 && boCall.args[0].selector === 'body');

  // 3) software_call 分发：timeout 透传 → 660000 同款口径（60s+30s 缓冲）
  __resp['software_call'] = { ok: true, software: 'git', action: 'status',
    kind: 'cli', exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 5,
    sandboxed: true, truncated: false };
  r = JSON.parse(await executeToolRaw('software_call',
    { software: 'git', action: 'status', args: {}, timeout: 120 }));
  const swCall = __calls.filter(c => c.name === 'software_call').pop();
  ok('software_call_dispatch', r.ok === true && swCall
     && swCall.timeoutMs === 150000
     && swCall.args[0].software === 'git' && swCall.args[0].timeout === 120
     && swCall.args.length === 2);   // [params, token] 护栏链透传
  // 缺省 timeout=60 → 90000（后端夹逼 5-600，前端缓冲口径一致）
  await executeToolRaw('software_call', { software: 'git', action: 'status' });
  ok('software_call_default_timeout',
     __calls.filter(c => c.name === 'software_call').pop().timeoutMs === 90000);

  // 4) CAPTCHA_REQUIRED → 挂起标记（§2.4 fail-fast；suspended:true）
  __resp['browser_search'] = { ok: false, error: { code: 'CAPTCHA_REQUIRED',
    message: '搜索引擎要求人机验证', takeover_id: 'tk_1',
    hint: '请在面板中手动完成后点击继续' } };
  r = JSON.parse(await executeToolRaw('browser_search', { query: 'q' }));
  ok('captcha_suspend_marker', r.ok === false
     && r.suspended === true && r.error.code === 'CAPTCHA_REQUIRED'
     && r.error.takeover_id === 'tk_1');

  // 5) 其余错误码原样透传（不挂起）
  __resp['browser_search'] = { ok: false, error: { code: 'ENGINE_UNREACHABLE',
    message: '双通道失败' } };
  r = JSON.parse(await executeToolRaw('browser_search', { query: 'q' }));
  ok('other_errors_passthrough', r.suspended === undefined
     && r.error.code === 'ENGINE_UNREACHABLE');

  // 6) 未知工具仍走既有拒绝分支
  r = JSON.parse(await executeToolRaw('no_such_tool', {}));
  ok('unknown_tool_rejected', r.error.includes('未知工具'));

  // 7) 既有分支零回归：write_file / run_command 仍分发
  __resp['write_file'] = { ok: true, path: 'a.txt' };
  r = JSON.parse(await executeToolRaw('write_file',
    { path: 'a.txt', content: 'x' }));
  ok('legacy_branch_intact', r.ok === true
     && __calls.filter(c => c.name === 'write_file').pop().args[0] === 'a.txt');

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

_TAKEOVER_WAIT_HARNESS = r'''
// ---- 模块级状态（与 60-agent-loop 同 declarations） ----
let harborTakeoverWaitResolve = null;
let harborTakeoverStopPoll = null;
__NOTIFY__
__AWAIT__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 1) 恢复：终态通知 → 挂起的 promise 以成功载荷 resolve
  const p1 = harborTakeoverAwaitTerminal(() => false);
  harborTakeoverNotify({ ok: true, resumed: true, results: [] });
  const t1 = await p1;
  ok('takeover_resume', t1 && t1.ok === true && t1.resumed === true);

  // 2) 放弃终态同样注入（Agent 换引擎/告知用户）
  const p2 = harborTakeoverAwaitTerminal(() => false);
  harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
    message: '用户已放弃人工验证' } });
  const t2 = await p2;
  ok('takeover_abort', t2 && t2.error.code === 'CAPTCHA_ABORTED');

  // 3) last-wins：新挂起以「已被取代」终态解放旧等待（防悬挂泄漏）
  const p3 = harborTakeoverAwaitTerminal(() => false);
  harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
    message: '已被新的验证请求取代' } });
  const t3 = await p3;
  ok('takeover_last_wins', t3 && t3.error.message === '已被新的验证请求取代');

  // 4) 用户「停止」：shouldAbort 轮询 → 放弃终态（不等人类动作）
  let stopped = false;
  const p4 = harborTakeoverAwaitTerminal(() => stopped);
  setTimeout(() => { stopped = true; }, 50);
  const t4 = await p4;
  ok('takeover_stop_abort', t4 && t4.error.code === 'CAPTCHA_ABORTED'
     && t4.error.message.includes('停止'));

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''


class TestFrontendToolExecVm:
    """25-tool-exec.js executeToolRaw 新分支 vm harness（node；缺失则 skip）。"""

    def test_harness(self):
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        src = read_frontend_source(PROJECT_ROOT, '25-tool-exec.js')
        js = _TOOL_EXEC_HARNESS.replace('__PANEL__', src)
        fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_te_')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(js)
        try:
            r = subprocess.run([NODE, path], capture_output=True, text=True,
                               timeout=60)
            assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
            out = json.loads(r.stdout)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端断言失败: %s' % failed
        assert len(out['checks']) >= 7


class TestFrontendTakeoverWaitVm:
    """60-agent-loop 人工接管等待态 vm harness（挂起/恢复/last-wins/停止）。"""

    def test_harness(self):
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        src = read_frontend_source(PROJECT_ROOT, '60-agent-loop.js')
        notify = _extract_fn(src, r'function harborTakeoverNotify\s*\(')
        await_fn = _extract_fn(src, r'function harborTakeoverAwaitTerminal\s*\(')
        js = _TAKEOVER_WAIT_HARNESS.replace('__NOTIFY__', notify) \
            .replace('__AWAIT__', await_fn)
        fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_tw_')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(js)
        try:
            r = subprocess.run([NODE, path], capture_output=True, text=True,
                               timeout=60)
            assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
            out = json.loads(r.stdout)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端断言失败: %s' % failed
        assert len(out['checks']) >= 4


# ============================================================ 契约门（L0）
class TestV18WiringContractGates:
    """L0：_V12_EXTRA 在册 / get_api_info 零漂移 / UI 契约 / 构建幂等。"""

    def test_v12_extra_has_eleven_new_apis(self):
        from backend.api import _V12_EXTRA
        assert NEW_APIS <= set(_V12_EXTRA)
        src = io.open(os.path.join(PROJECT_ROOT, 'backend', 'api.py'),
                      encoding='utf-8').read()
        tree = ast.parse(src)
        api_cls = next(n for n in tree.body
                       if isinstance(n, ast.ClassDef) and n.name == 'Api')
        defs = {n.name for n in api_cls.body if isinstance(n, ast.FunctionDef)}
        assert NEW_APIS <= defs, NEW_APIS - defs
        api = NewApi()
        for m in sorted(NEW_APIS):
            assert callable(getattr(api, m)), m

    def test_get_api_info_byte_identical_to_legacy(self):
        """get_api_info 与 legacy 逐字节一致（11 个新方法 _V12_EXTRA 隐身）。"""
        assert NewApi().get_api_info() == legacy.Api().get_api_info()
        info = json.loads(NewApi().get_api_info())
        for m in NEW_APIS:
            assert m not in info['methods']

    def test_check_contract_pass(self):
        """UI 契约只增不改（新 callApi 调用点为新增，不减既有）。"""
        r = subprocess.run([sys.executable,
                            os.path.join('deliverables', 'design',
                                         'check_contract.py')],
                           cwd=PROJECT_ROOT, capture_output=True, timeout=120)
        assert r.returncode == 0, r.stdout.decode('utf-8', 'replace') + \
            r.stderr.decode('utf-8', 'replace')

    def test_build_idempotent_two_pass_md5(self):
        """build 两遍 md5 一致（64/65/66 三新模块拼接确定性）。"""
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        import hashlib

        def _md5():
            return hashlib.md5(io.open(
                os.path.join(PROJECT_ROOT, 'harbor.html'), 'rb').read()).hexdigest()

        for _ in range(2):
            p = subprocess.run([NODE, 'frontend/build.js'], cwd=PROJECT_ROOT,
                               capture_output=True, timeout=120)
            assert p.returncode == 0, p.stderr
        h1 = _md5()
        subprocess.run([NODE, 'frontend/build.js'], cwd=PROJECT_ROOT,
                       capture_output=True, timeout=120)
        assert h1 == _md5(), '构建不幂等'
