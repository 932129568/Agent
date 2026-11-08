# -*- coding: utf-8 -*-
"""v1.6.0 批次 1（M1+M2 核心）回归实证。

覆盖迭代方案 §2/§3 的 T1/T3/T4/T5/T6/T7/T8（批次 1 范围）：
- T1 GitHub Models 预设接入（PRESETS 结构 / 顺序 / 兜底表 / Key 文案 / 免费层声明）
- T3 免费层 429 人话映射（RPM/RPD 两分支 + 无头兜底；node vm 跑真实源码）
- T4 DeepSeek preset 结构锁定（代码级校准，真机联调待目标机）
- T5 提示词体系五处（沙箱告知段 / EFFICIENCY 两条 / compact 序列 / 本地段 / MCP 未动）
- T6 沙箱设置面板 UI→api 通路（node vm 跑真实 39-sandbox.js）+ 模板纯新增区块
- T7 W21-W26 连接池族边界（竞态时序用桩构造：stale 重 List 无双弹/无状态错乱）
- T8 W27/W28/W30 边界项（墓碑误清 / 生成中开空会话 / 逐消息压缩防护）

铁律校验：js_api 契约零变更（sandbox_* 已在 _V12_EXTRA）；config.json 不污染
（sandbox.json 独立文件）；UI 契约只增不改（新 id/onclick/类全部唯一且增量）。
"""
import io
import json
import os
import socket
import subprocess
import tempfile
import threading
import time

import pytest

from conftest import NewApi, reset_home
from helpers.frontend import frontend_node_map, read_frontend_source

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
TPL = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')

from backend.domains.integrations.mcp import mcp_pool
from backend.domains.integrations.mcp.mcp_pool import HttpConnectionPool
from backend.domains.integrations.mcp.mcp_service import McpService
from backend.domains.integrations import webdav_service as wds
from backend.domains.security.guard_service import GuardService
from backend.domains.workspace.toolcache_service import ToolcacheService
from backend.domains.integrations.mcp.mcp_config_service import McpConfigService


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _tpl():
    return io.open(TPL, encoding='utf-8').read()


# ============================================================ T1 GitHub Models 预设
class TestT1GithubModelsPreset:
    """T1 验收：预设自动填充端点 + Key 占位符明示 PAT 与 scope + 免费层声明。"""

    def test_preset_entry_structure(self):
        src = _fe('36-connect.js')
        assert "'github-models':" in src, 'PRESETS 缺少 github-models 项'
        # 端点（外部核实 §9：旧 Azure 端点已弃用）
        assert 'https://models.github.ai/inference' in src
        assert 'models.inference.ai.azure.com' not in src, '不得残留旧 Azure 端点'
        # 免费层：价格表置零 + 徽标声明
        seg = src.split("'github-models':")[1].split('  },')[0]
        assert "prices: { in: 0, out: 0, cache: 0 }" in seg, '免费层价格表必须置零'
        assert 'free_tier: true' in seg
        assert 'models:read' in seg, 'Key 文案必须明示 models:read scope'
        # 模型 ID 为 provider/model 格式（外部核实：裸名校验失败）
        assert "id: 'openai/gpt-4o'" in seg
        assert "id: 'deepseek-ai/DeepSeek-R1'" in seg

    def test_preset_order_and_hot_table(self):
        src = _fe('36-connect.js')
        # 顺序表跨两行：合并含 CONNECT_PRESET_ORDER 的连续行再断言
        lines = src.splitlines()
        order_block = ''
        for i, l in enumerate(lines):
            if l.startswith('const CONNECT_PRESET_ORDER'):
                order_block = l + (lines[i + 1] if i + 1 < len(lines) else '')
                break
        assert "'github-models'" in order_block, '预设顺序表未登记 github-models'
        # 顺序合理性：云端第三方之后、本地系之前
        i_gh = order_block.index("'github-models'")
        i_qwen = order_block.index("'qwen'")
        i_ollama = order_block.index("'ollama'")
        assert i_qwen < i_gh < i_ollama
        assert "host: 'models.github.ai'" in src, '内置热门兜底表缺少 GitHub 目录'

    def test_template_option_and_free_tier_notice(self):
        tpl = _tpl()
        assert '<option value="github-models">' in tpl, '预设下拉缺少 GitHub Models 选项'
        assert 'id="cmKeyLabel"' in tpl and 'id="cmKeyHelp"' in tpl
        assert 'id="cmFreeTier"' in tpl
        assert '免费层仅限个人非商业使用，禁止生产使用' in tpl
        assert 'github.com/settings/tokens' in tpl, 'Key 获取指引链接缺失'

    def test_key_placeholder_and_notice_sync_logic(self):
        """connectApplyPresetNow 按预设切换 Key 文案/指引/免费层声明（源码级接线断言）。"""
        src = _fe('36-connect.js')
        assert 'meta.key_hint' in src, 'Key 占位符未消费预设 key_hint'
        assert "getElementById('cmKeyLabel')" in src
        assert "getElementById('cmKeyHelp')" in src
        assert "getElementById('cmFreeTier')" in src
        assert 'meta.free_tier' in src


# ============================================================ T4 DeepSeek 校准（代码级）
class TestT4DeepSeekPreset:
    """T4 降级说明：本环境无外网，代码级校准 preset 结构（真机联调待目标机）。"""

    def test_deepseek_preset_structure(self):
        src = _fe('36-connect.js')
        seg = src.split('  deepseek: {')[1].split('  },')[0]
        assert "base_url: 'https://api.deepseek.com/v1'" in seg
        # R20 校准（2026-10-21 api-docs.deepseek.com 实测）：现行模型名
        # deepseek-flash/deepseek-v4-pro（ctx 1M）；旧名 v4.1-* 已退役
        assert "id: 'deepseek-flash'" in seg
        assert "id: 'deepseek-v4-pro'" in seg
        assert 'prices: { in: 0.15, out: 0.6, cache: 0.003 }' in seg
        assert '1M 上下文' in seg


# ============================================================ T3 429 人话映射（vm 真实源码）
_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
const __toasts = [];
const __byId = {};
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
    value: '', checked: false, onclick: null, disabled: false, textContent: '', _html: '',
    focus: function(){},
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      toggle: function(c, f){ if (f === undefined) f = !this._s.has(c);
        if (f) this._s.add(c); else this._s.delete(c); return f; },
      contains: function(c){ return this._s.has(c); } },
    appendChild: function(c){ this.children.push(c); return c; },
    remove: function(){}, querySelector: function(){ return __mkEl('q'); },
    querySelectorAll: function(){ return []; }, addEventListener: function(){},
  };
  Object.defineProperty(el, 'innerHTML', {
    set: function(v) { this._html = String(v); this.children.length = 0; },
    get: function() { return this._html; },
  });
  return el;
}
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ const el = __byId[id];
    if (!el) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
  querySelector: function(){ return __mkEl('q'); },
  addEventListener: function(){},
};
function __ctx(extra) {
  const sand = Object.assign({
    document: __doc, console: console,
    setTimeout: function(fn, ms){ return setTimeout(fn, Math.min(Number(ms) || 0, 20)); },
    clearTimeout: clearTimeout,
    toast: function(msg, kind, opts){ __toasts.push({ msg: msg, kind: kind, opts: opts || {} }); },
    CS: { syncAll: function(){} },
    providerState: { enabled: true, model: 'openai/gpt-4o' },
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


def _run_node(body, name):
    if not os.path.exists(NODE):
        pytest.skip('node 不可用')
    js = _JS_PRELUDE + body + """
(async () => {
  const res = await __main();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_v16_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
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


class TestT3Humanize429:
    """T3 验收：mock 两种 429 响应头 → 人话区分 RPM/RPD；无头 → 通用文案兜底。"""

    def test_429_rpm_branch(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx();
  __run(ctx, __fe('76-cost-estimate.js'));
  return await __vm.runInContext(`(async () => ({
    text: humanizeApiError('HTTP 429: rate limit exceeded', false, {
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-limit-requests': '15',
      'retry-after': '37'
    })
  }))()`, ctx);
}
""", 'rpm')
        assert '请求频率超限' in res['text'], res
        assert '37' in res['text'], 'retry-after 应进入人话'

    def test_429_rpd_branch(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx();
  __run(ctx, __fe('76-cost-estimate.js'));
  return await __vm.runInContext(`(async () => ({
    text: humanizeApiError('HTTP 429: quota', false, {
      'x-ratelimit-remaining-requests-day': '0',
      'x-ratelimit-remaining-tokens-day': '0'
    })
  }))()`, ctx);
}
""", 'rpd')
        assert '每日配额耗尽' in res['text'], res
        assert '次日' in res['text']

    def test_429_no_headers_fallback(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx();
  __run(ctx, __fe('76-cost-estimate.js'));
  return await __vm.runInContext(`(async () => ({
    noHdr: humanizeApiError('HTTP 429: too many requests', false, null),
    weird: humanizeApiError('HTTP 429: too many requests', false,
      {'x-unrelated': '1', 'retry-after': 'oops'})
  }))()`, ctx);
}
""", 'fallback')
        # 无可用头信息 → 回落通用 429 文案（不得崩、不得空）
        assert '请求过于频繁或额度耗尽' in res['noHdr']
        assert '请求过于频繁或额度耗尽' in res['weird']

    def test_non_429_unaffected(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx();
  __run(ctx, __fe('76-cost-estimate.js'));
  return await __vm.runInContext(`(async () => ({
    e401: humanizeApiError('HTTP 401: unauthorized', false, {'x-ratelimit-remaining-requests': '0'}),
    local429: humanizeApiError('HTTP 429: busy', true, {'x-ratelimit-remaining-requests': '0'})
  }))()`, ctx);
}
""", 'non429')
        assert 'API Key 无效' in res['e401']
        assert '本地服务器限流' in res['local429'], 'local 模式 429 仍走本地口径'

    def test_agent_loop_passes_headers(self):
        """错误路径把响应头快照传给 humanizeApiError（第三参接线）。"""
        executor = _fe('frontend/src/agent/model-executor.js')
        controller = _fe('60-agent-loop.js')
        assert 'hdrMap' in executor
        assert 'httpError.headers = hdrMap' in executor
        assert 'err.headers || null' in controller


# ============================================================ T5 提示词体系
class TestT5PromptUpdates:
    """T5 验收：五处提示词源（④ 本地段 / ⑤ MCP 维持不动）。"""

    def test_sandbox_notice_in_system_prompt(self):
        reset_home()
        api = NewApi()
        # 默认沙箱启用（DEFAULT_CONFIG enabled=True，run_command=standard）→ 含告知段
        prompt = json.loads(api.build_system_prompt())
        assert '沙箱边界' in prompt, '沙箱启用时系统提示必须含边界告知段'
        assert '网络不隔离' in prompt and '勿把沙箱当绝对安全' in prompt
        # 关闭沙箱 → 不含（token 经济：不开不注入）
        r = json.loads(api.sandbox_save_config(json.dumps(
            {'enabled': False, 'command_profiles': {'run_command': 'off'}})))
        assert r.get('ok')
        prompt_off = json.loads(api.build_system_prompt())
        assert '沙箱边界' not in prompt_off

    def test_system_prompt_still_shorter_than_legacy(self):
        """INTENTIONAL_DELTAS 白名单内增量：仍须保持 v1.1.1 精简承诺（短于 legacy）。"""
        from conftest import legacy
        reset_home()
        a = legacy.Api()
        reset_home()
        b = NewApi()
        assert len(b.build_system_prompt()) < len(a.build_system_prompt())

    def test_efficiency_prompt_additions(self):
        # R25 对齐：Round 8 提示词瘦身（有记账裁定）删掉了 GitHub Models 端点
        # 硬编码段（现支持任意端点，限额数字对其余端点是噪音）——测试对齐现役
        # 契约：MCP 铁律保留、无端点硬编码、模板内零注释符。
        src = _fe('55-tool-route.js')
        assert '【MCP】工具结果只信最新一条' in src
        assert '【源】GitHub Models 免费层限额敏感' not in src
        seg = src.split('const EFFICIENCY_PROMPT = `')[1].split('`;')[0]
        assert '//' not in seg, '提示词模板内不得出现注释符'

    def test_compact_prompt_keeps_tool_sequence(self):
        src = _fe('97-compact.js')
        # R42 断言更新：分类压缩重构了保留清单——原「工具调用序列」字样并入
        # 「已做改动与关键实现细节」，并新增丢弃分类（已处理工具输出原文）
        assert '已做改动与关键实现细节' in src
        assert '必须丢弃' in src

    def test_local_mode_segment(self):
        src = _fe('60-agent-loop.js')
        assert '【本地模式】上下文窗口有限' in src
        assert "localState.mode" in src

    def test_mcp_instructions_not_injected(self):
        """⑤ MCP instructions 维持 v1.3 裁决（展示不注入）——核实未被动过。"""
        src = _fe('60-agent-loop.js')
        # instructions 只出现在 test_server 透出/面板展示路径，不得进 sysContent 组装
        assert 'instructions' not in src.split('let sysContent')[1].split('const reqMsgs')[0]


# ============================================================ T6 沙箱面板（vm 真实源码）
class TestT6SandboxPanel:
    """T6 验收：UI→api 通路（get/save/status）+ 非 Windows 明示不可用。"""

    def test_panel_load_render_save_roundtrip(self):
        res = _run_node(r"""
async function __main() {
  const __calls = [];
  let __saved = null;
  const ctx = __ctx({
    callApi: async function(method, args) {
      __calls.push({ method: method, args: args });
      if (method === 'sandbox_get_config') {
        return JSON.stringify({ enabled: false,
          command_profiles: { run_command: 'strict', run_powershell: 'off', run_admin_command: 'off' },
          limits: { standard: { memory_mb: 2048, max_processes: 32, cpu_seconds: 90, ui_restrict: 'none' },
                    strict: { memory_mb: 256, max_processes: 4, cpu_seconds: 30, ui_restrict: 'strict' } } });
      }
      if (method === 'sandbox_save_config') { __saved = JSON.parse(args[0]); return '{"ok":true}'; }
      if (method === 'sandbox_status') {
        return JSON.stringify({ available: true, platform: 'nt', enabled: true,
          command_profiles: { run_command: 'strict' },
          stats: { jobs_created: 3, runs_sandboxed: 7, runs_failed_closed: 1 } });
      }
      return '{}';
    }
  });
  __run(ctx, __fe('39-sandbox.js'));
  await __vm.runInContext('(async () => { await loadSandboxPanel(); })()', ctx);
  const render = await __vm.runInContext(`(async () => ({
    enabled: document.getElementById('sandboxEnabled').checked,
    runCommand: document.getElementById('sandboxProfilerun_command').value,
    stdMemory: document.getElementById('sandboxLimitstandardMemory').value,
    strictUi: document.getElementById('sandboxLimitstrictUi').value,
    statsText: document.getElementById('sandboxStats').textContent,
    statusText: document.getElementById('sandboxStatusText').textContent
  }))()`, ctx);
  await __vm.runInContext(`(async () => {
    document.getElementById('sandboxEnabled').checked = true;
    document.getElementById('sandboxProfilerun_powershell').value = 'strict';
    await saveSandboxSettings();
  })()`, ctx);
  return { render: render, calls: __calls, saved: __saved };
}
""", 'panel')
        assert res['render']['enabled'] is False, '开关应按后端配置回填'
        assert res['render']['runCommand'] == 'strict'
        assert str(res['render']['stdMemory']) == '2048'
        assert res['render']['strictUi'] == 'strict'
        assert '创建 Job 3' in res['render']['statsText']
        assert '沙箱执行 7' in res['render']['statsText']
        assert 'fail-closed 拒绝 1' in res['render']['statsText']
        assert 'run_command' in res['render']['statusText']
        methods = [c['method'] for c in res['calls']]
        assert methods[0] == 'sandbox_get_config'
        assert 'sandbox_save_config' in methods and 'sandbox_status' in methods
        assert res['saved']['enabled'] is True
        assert res['saved']['command_profiles']['run_powershell'] == 'strict'
        assert res['saved']['limits']['standard']['memory_mb'] == 2048, '读-改-写不得丢未编辑键'

    def test_panel_non_windows_explicit_unavailable(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(method) {
      if (method === 'sandbox_get_config') return JSON.stringify({ enabled: true });
      if (method === 'sandbox_status') {
        return JSON.stringify({ available: false, platform: 'posix', enabled: true,
          command_profiles: {},
          stats: { jobs_created: 0, runs_sandboxed: 0, runs_failed_closed: 0 } });
      }
      return '{}';
    }
  });
  __run(ctx, __fe('39-sandbox.js'));
  await __vm.runInContext('(async () => { await loadSandboxPanel(); })()', ctx);
  return await __vm.runInContext(`(async () => ({
    statusText: document.getElementById('sandboxStatusText').textContent,
    unavailShown: document.getElementById('sandboxUnavailable').style.display !== 'none'
  }))()`, ctx);
}
""", 'nonwin')
        assert '不支持 Job Object' in res['statusText']
        assert res['unavailShown'] is True, '非 Windows 必须明示不可用而非空白'

    def test_template_block_ids_unique(self):
        tpl = _tpl()
        ids = ['sandboxEnabled', 'sandboxStatusLight', 'sandboxStatusText', 'sandboxStats',
               'sandboxUnavailable', 'sandboxSaveBtn', 'sandboxResetBtn', 'sandboxRefreshBtn',
               'sandboxProfilerun_command', 'sandboxProfilerun_powershell', 'sandboxProfilerun_admin_command',
               'sandboxLimitstandardMemory', 'sandboxLimitstandardProcesses',
               'sandboxLimitstandardCpu', 'sandboxLimitstandardUi',
               'sandboxLimitstrictMemory', 'sandboxLimitstrictProcesses',
               'sandboxLimitstrictCpu', 'sandboxLimitstrictUi']
        for i in ids:
            assert ('id="%s"' % i) in tpl, '模板缺少沙箱控件 id: ' + i
        # 唯一性（不得与既有 id 撞车）
        import re
        all_ids = re.findall(r'id="([^"]+)"', tpl)
        dupes = {i for i in ids if all_ids.count(i) > 1}
        assert not dupes, 'id 重复: %s' % dupes

    def test_js_api_contract_zero_change(self):
        """铁律：sandbox_* 三个方法已在 _V12_EXTRA（v1.6 后端交付），不得新增 js_api。"""
        from backend import api as api_mod
        for m in ('sandbox_get_config', 'sandbox_save_config', 'sandbox_status'):
            assert m in api_mod._V12_EXTRA
        src = _fe('39-sandbox.js')
        assert 'sandbox_get_config' in src and 'sandbox_save_config' in src and 'sandbox_status' in src
        assert 'local_models' not in src, '沙箱面板不得引入其他桥方法'

    def test_boot_hook_present(self):
        src = _fe('110-boot.js')
        assert 'loadSandboxPanel' in src, '启动未挂接沙箱面板加载'


# ============================================================ T7 W21-W26 连接池族
class _FakeCfg:
    """最小配置桩（McpService 只用 get_server/list_servers）。"""

    def __init__(self, servers):
        self._servers = servers

    def get_server(self, name):
        return self._servers.get(name)

    def list_servers(self):
        return [{'name': n, 'transport': 'http' if c.get('url') else 'stdio',
                 'enabled': bool(c.get('enabled'))} for n, c in self._servers.items()]


class _FakeClient:
    def __init__(self, tools=None, alive=True):
        self._tools = tools or [{'name': 't', 'description': 'd', 'inputSchema': {}}]
        self.alive = alive
        self.server_info = {'name': 'fake', 'version': '1'}
        self.instructions = ''
        self.list_calls = 0
        self.closed = False

    def is_alive(self):
        return self.alive

    def list_tools(self):
        self.list_calls += 1
        return list(self._tools)

    def call_tool(self, name, arguments, timeout=None):
        return {'content': [{'type': 'text', 'text': 'ok'}]}

    def close(self):
        self.closed = True

    def clear_list_changed(self):
        pass


def _mk_service(servers):
    guard = GuardService()
    svc = McpService(_FakeCfg(servers), guard, ToolcacheService())
    return svc


class TestT7W21PoolWiring:
    """W21：池配置键接入生产调用方（limiter / stale 自动重 List）。"""

    def test_limiter_wired_for_http(self):
        svc = _mk_service({'s': {'url': 'https://x/mcp', 'enabled': True,
                                 'pool': {'max_concurrency': 2}}})
        lim = svc._limiter('s', {'url': 'https://x/mcp', 'pool': {'max_concurrency': 2}})
        assert lim is not None and lim.max_concurrent == 2
        # stdio 不装（天然串行）
        assert svc._limiter('s', {'command': 'node'}) is None

    def test_stale_auto_relist_no_double_refresh(self):
        """stale 300s 触发自动重 List：refreshing 去抖 → 无双弹、无状态错乱。"""
        svc = _mk_service({'s': {'url': 'https://x/mcp', 'enabled': True}})
        client = _FakeClient()
        svc._spawn_client = lambda name, cfg: (client, None)
        entry = svc._ensure_entry('s')
        # 构造 stale：last_list_at 设为 301s 前（stale_needs_relist TTL=300）
        entry['last_list_at'] = time.monotonic() - 301.0
        c, err = svc._get_or_spawn('s')
        assert err is None and c is client
        # 拉起路径已 _relist（1 次）；随后 call_tool 入口的 stale 检查应只触发
        # 一次后台刷新（refreshing 去抖），不得双弹
        n_after_spawn = client.list_calls
        entry['last_list_at'] = time.monotonic() - 301.0   # 再次构造 stale
        svc.call_tool('s', 't', {}, decision='allow')
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and client.list_calls == n_after_spawn:
            time.sleep(0.02)
        assert client.list_calls == n_after_spawn + 1, (
            'stale 自动重 List 应恰好一次（无双弹）：%d -> %d' % (n_after_spawn, client.list_calls))
        # 刷新完成后 status 回 ok、last_list_at 刷新（无状态错乱）
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and entry['status'] != 'ok':
            time.sleep(0.02)
        assert entry['status'] == 'ok'
        assert entry['last_list_at'] > time.monotonic() - 5


class TestT7W22W23PoolBoundaries:
    """W22 close 后 release 不复活；W23 半死连接探活丢弃。"""

    def test_close_then_release_no_resurrect(self):
        pool = HttpConnectionPool()
        conn = pool.acquire('http://127.0.0.1:1/')
        pool.close()
        assert pool.stats()['idle'] == 0
        pool.release(conn, healthy=True)     # in-flight 归还在 close 之后到达
        st = pool.stats()
        assert st['idle'] == 0, 'close 后 release 不得复活 idle 条目'
        assert st['closed'] >= 1

    def test_dead_connection_discarded(self):
        """服务端已关（sock 仍在、EOF 挂起）→ acquire 丢弃不算 reused。"""
        a, b = socket.socketpair()
        b.close()   # 对端关闭 → a 可读且 peek 为 EOF
        pool = HttpConnectionPool()
        fake = _FakeClient()
        fake.sock = a
        fake._pool_key = ('http', '127.0.0.1', 1)
        pool._idle[('http', '127.0.0.1', 1)] = [(fake, time.monotonic())]
        got = pool.acquire('http://127.0.0.1:1/')
        assert got is not fake, '半死连接必须被丢弃'
        assert pool.stats()['reused'] == 0
        assert pool.stats()['closed'] == 1
        a.close()

    def test_live_connection_reused(self):
        a, b = socket.socketpair()
        pool = HttpConnectionPool()
        fake = _FakeClient()
        fake.sock = a
        fake._pool_key = ('http', '127.0.0.1', 1)
        pool._idle[('http', '127.0.0.1', 1)] = [(fake, time.monotonic())]
        got = pool.acquire('http://127.0.0.1:1/')
        assert got is fake, '活连接应被复用'
        assert pool.stats()['reused'] == 1
        a.close(); b.close()


class TestT7W24W25ServiceRace:
    """W24 崩溃重拉登记 warm；W25 forget 与在途拉起竞态不泄漏孤儿。"""

    def test_crash_respawn_registers_warm(self):
        svc = _mk_service({'s': {'url': 'https://x/mcp', 'enabled': True}})
        dead = _FakeClient(alive=False)
        entry = svc._ensure_entry('s')
        entry['client'] = dead
        fresh = _FakeClient()
        svc._spawn_client = lambda name, cfg: (fresh, None)
        c, err = svc._get_or_spawn('s')
        assert err is None and c is fresh
        assert svc._warm.get('s') is fresh, '崩溃重拉后 warm 必须登记新 client（W24）'

    def test_forget_during_spawn_closes_orphan(self):
        """forget 与 _get_or_spawn 竞态：spawn 完成即发现代际变更 → 关闭 + 人话错误。"""
        svc = _mk_service({'s': {'url': 'https://x/mcp', 'enabled': True}})
        gate = threading.Event()
        released = threading.Event()
        forgotten = threading.Event()

        def _blocking_spawn(name, cfg):
            gate.wait(5)      # 模拟拉起耗时（握手/冷启），期间持 entry 锁
            return _FakeClient(), None

        svc._spawn_client = _blocking_spawn
        result = {}

        def _spawn_thread():
            c, err = svc._get_or_spawn('s')
            result['client'], result['err'] = c, err
            released.set()

        def _forget_thread():
            svc.forget('s')   # 在 entry 锁上排队；gen 已先行递增
            forgotten.set()

        t = threading.Thread(target=_spawn_thread, daemon=True)
        t.start()
        time.sleep(0.1)       # 确保 spawn 已进入阻塞态（持锁）
        ft = threading.Thread(target=_forget_thread, daemon=True)
        ft.start()
        time.sleep(0.1)       # forget 已递增代际并阻塞在 entry 锁
        gate.set()            # 放行拉起 → 完成即发现代际变更
        assert released.wait(5), '拉起线程应返回'
        assert forgotten.wait(5), 'forget 应返回'
        t.join(5)
        assert result['err'] and '删除或停用' in result['err'], result
        assert result['client'] is None
        # 孤儿不得留在 warm / _rt
        assert svc._warm.get('s') is None
        assert 's' not in svc._rt


class TestT7W26WebdavBoundaries:
    """W26：keep_both 不互覆；恢复计划 local_wins 口径统一。"""

    def test_resolve_conflict_labels_unchanged(self):
        """纯函数锁定（测试契约）：同步方向标签不动。"""
        assert wds.resolve_conflict('local_wins', {'path': 'x'})['action'] == 'upload'
        assert wds.resolve_conflict('keep_both', {'path': 'x'})['action'] == 'keep_both'

    def test_keep_both_timestamped_names_unique(self):
        """同秒多次恢复 → 另存文件名不互覆（毫秒 + 存在性探测）。"""
        import inspect
        src = inspect.getsource(wds.restore_backup)
        assert "%03d' % (int(time.time() * 1000)" in src, 'keep_both 需毫秒级戳'
        assert 'while os.path.exists(target)' in src, 'keep_both 需存在性探测'

    def test_restore_plan_local_wins_keep_local(self):
        """恢复计划中 local_wins 冲突标 keep_local（执行器从不上传，口径统一）。"""
        import inspect
        src = inspect.getsource(wds.restore_backup)
        assert "act = 'keep_local'" in src
        # 执行器对 keep_local 原样不动（无分支即不落盘不上传）
        assert "action == 'keep_local'" not in src.split('for item in plan_out')[1]


# ============================================================ T8 W27/W28/W30
class TestT8BoundaryItems:
    def test_w27_tombstone_survives_backend_read_failure(self):
        src = _fe('65-session-store.js')
        assert 'backendOk' in src
        assert 'if (backendOk) {' in src, '墓碑出棺必须只在后端读取成功后进行'

    def test_w28_continue_blocked_while_streaming(self):
        src = _fe('85-session-mgmt.js')
        assert '(typeof isSessionStreaming === \'function\' ? isSessionStreaming(' in src, '生成中必须中止开新会话（防静默丢上下文）'

    def test_w30_compact_history_per_message_guard(self):
        src = _fe('97-compact.js')
        seg = src.split('async function compactHistory')[1]
        assert '单条坏消息跳过' in seg, 'compactHistory 需逐消息 try/catch 防护'
