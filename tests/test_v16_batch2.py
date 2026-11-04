# -*- coding: utf-8 -*-
"""v1.6.0 批次 2（M3+M4）回归实证。

覆盖迭代方案 §4/§5 的 T10/T11/T12/T13 + 批次 1 遗留 W33：
- T10 本地模型运行优化（503 退避在位锁定 / 首 token 等待态在位锁定 /
  tokens/s 速度文本纯函数 + 无 usage 估算标「估」/ ctx 徽标路径）
- T11 布局重构·直切（新导航分区切换 vm 实测 / 高亮 / 空态引导 / 一次性引导）
- T12 MCP resources（list 分页 / read text / blob 落盘 toolcache /
  -32601 降级 / 订阅持久化 / 审计可见 / js_api 隐身）
- T13 DND 免打扰（失焦抑制 ok·info / warn·err 不抑 / 通知入列 / 聚焦清零 / force 旁路）
- W33 多服务器探测错配（last-wins 序号 + base 切走丢弃）

铁律：新 js_api 全部进 _V12_EXTRA（get_api_info 零漂移）；UI 契约只增不改；
订阅存 mcp_servers.json 可选键（Claude 兼容）；DND 存 localStorage（不污染 config.json）。
"""
import io
import json
import os
import re
import subprocess
import tempfile

import pytest

from conftest import NewApi, reset_home
from helpers.frontend import read_frontend_source

from backend.domains.integrations.mcp import mcp_pool
from backend.domains.integrations.mcp.mcp_service import McpService
from backend.domains.security.guard_service import GuardService
from backend.domains.workspace.toolcache_service import ToolcacheService
from backend.domains.integrations.mcp.mcp_config_service import McpConfigService
from backend.domains.integrations.mcp.mcp_client import McpProtocolError

# 复用批次 1 的 vm harness 与 MCP 桩（同 tests 目录，pytest prepend 导入模式可达）
from test_v16_batch1 import _FakeClient, _FakeCfg, _mk_service, _run_node

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
TPL = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _tpl():
    return io.open(TPL, encoding='utf-8').read()


def _extract_fn(src, name):
    """从模块源码正则抽取单个函数声明（test_v15_known_bugs 同款模式）。"""
    m = re.search(r'function %s\([^)]*\)\s*\{' % re.escape(name), src)
    assert m, '未找到函数 %s' % name
    i = m.end() - 1
    depth = 0
    in_str = None
    while i < len(src):
        c = src[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in ('"', "'", '`'):
            in_str = c
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
        i += 1
    raise AssertionError('函数 %s 括号不配对' % name)


# ============================================================ T10 本地模型优化
class TestT10LocalRuntime:
    """T10：① 503 退避 ② 首 token 等待态（均为 v1.5 已交付在位行为，锁定防回退）；
    ③ tokens/s 速度显示（新增）；④ /api/tags 元数据徽标路径确认。"""

    def test_503_loading_backoff_in_place(self):
        # R22 对齐：本地模型冷加载退避延长为 6 档共 119s（7B-32B 冷启动 30-90s
        # 很常见，原 3 档 14s 常常不够）；云端端点保持 3 档不变。
        src = _fe('45-request-debounce.js')
        assert 'LOADING_BACKOFF = isLocal ? [2000, 4000, 8000, 15000, 30000, 60000] : [2000, 4000, 8000]' in src
        assert 'LOADING_BACKOFF[attempt]' in src

    def test_first_token_wait_state_in_place(self):
        """② 首字节 >5s 未到 → 「本地推理中（已等待 Ns）」每秒刷新（v1.5 B3 在位，锁定）。"""
        src = _fe('60-agent-loop.js')
        assert '本地推理中（已等待' in src
        assert 'FIRST_TOKEN_HINT_MS = 5000' in src
        assert '_clearWaitTimer' in src, '首字节到达/流结束必须清理等待态计时器'

    def test_stream_speed_text_pure_function(self):
        """③ tokens/s：usage 精确值无标；无 usage 按字符估算标「估」；<0.5s 不显示。"""
        src = _fe('60-agent-loop.js')
        fn = _extract_fn(src, 'streamSpeedText')
        res = _run_node("""
async function __main() {
  const ctx = __ctx();
  __run(ctx, %r);
  return await __vm.runInContext(`(() => ({
    exact: streamSpeedText(1000, 2000, 40),
    est: streamSpeedText(1800, 2000, 0),
    tooFast: streamSpeedText(100, 300, 0),
    zero: streamSpeedText(0, 5000, 0)
  }))()`, ctx);
}
""" % fn, 'speed')
        assert res['exact'] == '⚡ 20.0 tok/s', res
        assert res['est'] == '⚡ 500.0 tok/s（估）', res   # ceil(1800/1.8)=1000 tok / 2s
        assert res['tooFast'] == '', res
        assert res['zero'].endswith('（估）'), res

    def test_stream_speed_wired_in_loop(self):
        """③ 速度显示接入读循环（节流刷新 + usage 收口 + 每轮清空）。"""
        src = _fe('60-agent-loop.js')
        assert '_paintStreamSpeed' in src
        assert "getElementById('streamSpeed')" in src
        assert '_speedT0 = Date.now()' in src, '首字节即启动测速'
        assert 'usage ? usage.completion_tokens : 0' in src, '流末用 usage 精确值收口'
        assert "id=\"streamSpeed\"" in _tpl(), '模板 hint 行缺少 streamSpeed 载体'

    def test_ctx_badge_path(self):
        """④ /api/tags 元数据 UI 徽标路径（KNOWN_ISSUES #2 销项标注：路径通）。"""
        src = _fe('34-local-model.js')
        assert 'applyLocalMetaBadge' in src
        assert 'localMetaCache' in src, '元数据缓存（后端 /api/tags 三级来源落地处）'
        assert "cmCtxBadge" in src, '合并块徽标 id 在位'

    def test_local_test_loading_state(self):
        """A5：本地测试连接 503 loading 态文案在位（与后端 classify_local_error 同口径）。"""
        src = _fe('34-local-model.js')
        assert "r.state === 'loading'" in src
        assert '模型加载中' in src


# ============================================================ W33 探测错配
class TestW33ProbeMismatch:
    """W33：多服务器同时探测——旧 base 清单/缓存不得覆盖新 base（last-wins + base 校验）。"""

    def test_last_wins_discards_stale_result(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(method, args) {
      if (method === 'local_models') {
        const base = args[0];
        // 第一个 base 慢返回，第二个快返回 → 乱序回包
        if (base.indexOf('11434') !== -1) await new Promise(r => setTimeout(r, 120));
        return JSON.stringify({ ok: true, models: [
          { id: base.indexOf('11434') !== -1 ? 'ollama-model' : 'lm-model', ctx_window: 8192, tool_capable: true }] });
      }
      return '{}';
    }
  });
  __run(ctx, __fe('34-local-model.js'));
  await __vm.runInContext(`(async () => {
    const p1 = localLoadModels('http://localhost:11434/v1');   // 旧 base（慢）
    const p2 = localLoadModels('http://localhost:1234/v1');    // 新 base（快）
    await Promise.all([p1, p2]);
    await new Promise(r => setTimeout(r, 200));
  })()`, ctx);
  const cacheKeys = await __vm.runInContext(`Object.keys(localMetaCache)`, ctx);
  return { cacheKeys: cacheKeys, toasts: __toasts.map(t => t.msg) };
}
""", 'w33')
        # 新 base 的清单/缓存为权威；旧 base 的慢回包被序号丢弃（不错配）
        assert res['cacheKeys'] == ['lm-model'], res
        assert 'ollama-model' not in res['cacheKeys'], '陈旧回包不得写入缓存'

    def test_base_switched_midflight_discards(self):
        """加载途中用户切走 Base URL → 该次结果整体丢弃（保按钮 finally 复位）。"""
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(method, args) {
      await new Promise(r => setTimeout(r, 80));
      return JSON.stringify({ ok: true, models: [{ id: 'stale-model', ctx_window: 4096 }] });
    }
  });
  __run(ctx, __fe('34-local-model.js'));
  await __vm.runInContext(`(async () => {
    // 双 id 同域（localEl 老 id 优先）：两个世代元素都置值，模拟真实合并块语义
    document.getElementById('providerBase').value = 'http://localhost:11434/v1';
    document.getElementById('localBaseUrl').value = 'http://localhost:11434/v1';
    const p = localLoadModels('http://localhost:11434/v1');
    await new Promise(r => setTimeout(r, 20));
    document.getElementById('providerBase').value = 'http://localhost:9999/v1';   // 用户切走
    document.getElementById('localBaseUrl').value = 'http://localhost:9999/v1';
    await p;
    await new Promise(r => setTimeout(r, 120));
  })()`, ctx);
  const cacheKeys = await __vm.runInContext(`Object.keys(localMetaCache)`, ctx);
  return { cacheKeys: cacheKeys };
}
""", 'w33b')
        assert res['cacheKeys'] == [], res

    def test_seq_guard_in_source(self):
        src = _fe('34-local-model.js')
        assert '_localLoadSeq' in src
        assert 'seq !== _localLoadSeq' in src
        assert 'curBase !== base' in src


# ============================================================ T11 布局重构
class TestT11NavLayout:
    """T11：新左侧导航五分区切换（复用既有面板/浮层 DOM）+ 高亮 + 空态引导。"""

    def test_template_nav_added(self):
        # R25 对齐：Round 8 IA 重构（有记账裁定）把 mainNav/navBtnX 五分区改为
        # rail（对话/历史/工作区/专家）+ toolsPop 工具箱（分析/审计/搜索/沙箱）
        # + notifyPop 通知中心。测试锁定现役导航契约。
        tpl = _tpl()
        for k in ('data-panel="chat"', 'data-panel="sessions"', 'data-panel="workspace"',
                  'id="toolsBoxBtn"', 'id="toolsPop"', 'id="railNotifyBtn"',
                  'id="notifyPop"', 'id="notifyList"'):
            assert k in tpl, '缺少现役导航元素: ' + k
        assert 'id="emptyGuide"' in tpl and 'id="headerStatusZone"' in tpl
        # 老入口 DOM 不删（直切口径：契约红线）
        assert 'id="settingsPanel"' in tpl and 'id="setNav"' in tpl

    def test_nav_switch_routing(self):
        """五分区分别路由到既有面板/浮层函数（不新建面板容器）。"""
        res = _run_node(r"""
const __calls = [];
async function __main() {
  const ctx = __ctx({
    switchPanel: function(name){ __calls.push('switchPanel:' + name); },
    toggleSettings: function(){ __calls.push('toggleSettings'); },
    openAuditViewer: function(){ __calls.push('openAuditViewer'); },
    openSessionSearch: function(){ __calls.push('openSessionSearch'); },
    callApi: async function(){ return '{"available":false}'; }
  });
  __run(ctx, __fe('41-nav.js'));
  await __vm.runInContext(`(async () => {
    navSwitch('chat');
    navSwitch('settings');
    navSwitch('audit');
    navSwitch('search');
    navSwitch('sandbox');
    navSwitch('bogus');   // 未知区回落 chat
    await new Promise(r => setTimeout(r, 150));   // 等 sandbox 滚动定位定时器
  })()`, ctx);
  return { calls: __calls };
}
""", 'navroute')
        c = res['calls']
        assert 'switchPanel:chat' in c
        assert 'toggleSettings' in c, '设置区必须打开设置浮层（老入口同目标）'
        assert 'openAuditViewer' in c, '审计区路由到既有审计查看器'
        assert 'openSessionSearch' in c, '搜索区路由到既有会话搜索'
        assert c.count('switchPanel:chat') >= 4, '设置/审计/搜索/沙箱均以对话面板为承载'

    def test_nav_highlight_and_zones(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({ switchPanel: function(){}, callApi: async function(){ return '{}'; } });
  __run(ctx, __fe('41-nav.js'));
  await __vm.runInContext(`(() => { navSwitch('audit'); })()`, ctx);
  const on = await __vm.runInContext(`['chat','settings','audit','search','sandbox'].filter(z =>
    document.getElementById('navBtn' + z[0].toUpperCase() + z.slice(1)).classList.contains('on'))`, ctx);
  const zone = await __vm.runInContext(`navZone`, ctx);
  return { on: on, zone: zone };
}
""", 'navhl')
        assert res['on'] == ['audit'], res
        assert res['zone'] == 'audit'

    def test_empty_guide_visibility(self):
        """未配 Key 且会话为空 → 三步引导显示；配 Key 后隐藏。"""
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(){ return '{}'; },
    getCurrentSession: function(){ return { messages: [] }; }
  });
  __run(ctx, __fe('41-nav.js'));
  return await __vm.runInContext(`(() => {
    document.getElementById('apiKey').value = '';
    navUpdateEmptyGuide();
    const noKey = document.getElementById('emptyGuide').style.display;
    document.getElementById('apiKey').value = 'sk-xxx';
    navUpdateEmptyGuide();
    const hasKey = document.getElementById('emptyGuide').style.display;
    return { noKey: noKey, hasKey: hasKey };
  })()`, ctx);
}
""", 'navguide')
        assert res['noKey'] == 'flex', res
        assert res['hasKey'] == 'none', res

    def test_first_run_guide_once(self):
        res = _run_node(r"""
async function __main() {
  const store = {};
  const ctx = __ctx({
    toast: function(m, k){ __toasts.push(m); },
    localStorage: {
      getItem: function(k){ return store[k] === undefined ? null : store[k]; },
      setItem: function(k, v){ store[k] = String(v); }
    }
  });
  __run(ctx, __fe('41-nav.js'));
  await __vm.runInContext(`(() => {
    navFirstRunGuide();
    navFirstRunGuide();
  })()`, ctx);
  return { count: __toasts.length };
}
""", 'navfirst')
        assert res['count'] == 1, '首次启动应有一次引导 toast，二次不重复'


# ============================================================ T13 DND 免打扰
class TestT13Dnd:
    """T13：失焦抑制 ok/info；warn/err 不抑；入通知中心；聚焦清零；force 旁路。"""

    def test_dnd_suppresses_noncritical_when_blurred(self):
        res = _run_node(r"""
async function __main() {
  // 增强预置 __doc：补失焦状态 + body.contains（元素桩复用 __mkEl，toast 全路径可跑）
  __doc.hidden = true;
  __doc.hasFocus = function(){ return false; };
  __doc.body.contains = function(){ return false; };
  const ctx = __ctx({ localStorage: { getItem: function(){ return '1'; }, setItem: function(){} } });
  __run(ctx, __fe('18-toast.js'));
  return await __vm.runInContext(`(() => {
    const r1 = toast('保存成功', 'ok');
    const r2 = toast('一般信息', 'info');
    const r3 = toast('危险警告', 'warn');
    const r4 = toast('出错了', 'err');
    const r5 = toast('强制弹', 'ok', { force: true });
    return { r1: r1 === null, r2: r2 === null, r3: r3 !== null, r4: r4 !== null,
             r5: r5 !== null, notify: _notifyItems.length };
  })()`, ctx);
}
""", 'dnd')
        assert res['r1'] is True and res['r2'] is True, '失焦时 ok/info 必须被抑制'
        assert res['r3'] is True and res['r4'] is True, 'warn/err 永不抑制'
        assert res['r5'] is True, 'force 旁路必须放行'
        assert res['notify'] == 2, '两条被抑制提示应入通知中心'

    def test_dnd_off_passes_through(self):
        res = _run_node(r"""
async function __main() {
  __doc.hidden = true;
  __doc.hasFocus = function(){ return false; };
  __doc.body.contains = function(){ return false; };
  const ctx = __ctx({ localStorage: { getItem: function(){ return null; }, setItem: function(){} } });
  __run(ctx, __fe('18-toast.js'));
  return await __vm.runInContext(`(() => ({ r: toast('保存成功', 'ok') !== null }))()`, ctx);
}
""", 'dndoff')
        assert res['r'] is True, '开关关闭时即使失焦也放行'

    def test_dnd_focused_passes_through(self):
        res = _run_node(r"""
async function __main() {
  __doc.hidden = false;
  __doc.hasFocus = function(){ return true; };
  __doc.body.contains = function(){ return false; };
  const ctx = __ctx({ localStorage: { getItem: function(){ return '1'; }, setItem: function(){} } });
  __run(ctx, __fe('18-toast.js'));
  return await __vm.runInContext(`(() => ({ r: toast('保存成功', 'ok') !== null }))()`, ctx);
}
""", 'dndfocus')
        assert res['r'] is True, '窗口聚焦时即使开着 DND 也放行'

    def test_notify_center_render_and_clear(self):
        res = _run_node(r"""
async function __main() {
  __doc.hidden = true;
  __doc.hasFocus = function(){ return false; };
  __doc.body.contains = function(){ return false; };
  const ctx = __ctx({ localStorage: { getItem: function(){ return '1'; }, setItem: function(){} } });
  __run(ctx, __fe('18-toast.js'));
  __run(ctx, __fe('41-nav.js'));
  return await __vm.runInContext(`(() => {
    toast('提示一', 'ok');
    toast('提示二', 'info');
    const badge = document.getElementById('navNotifyBadge');
    const badgeShown = badge.style.display;
    const badgeText = badge.textContent;
    navClearNotifyBadge();
    const badgeHidden = document.getElementById('navNotifyBadge').style.display;
    navClearNotify();
    const listHtml = document.getElementById('notifyList').innerHTML;
    return { badgeShown: badgeShown, badgeText: badgeText, badgeHidden: badgeHidden, listHtml: listHtml };
  })()`, ctx);
}
""", 'notify')
        assert res['badgeShown'] == '', '有通知时红点应显示'
        assert res['badgeText'] == '2'
        assert res['badgeHidden'] == 'none', '聚焦后红点清零'
        assert '暂无通知' in res['listHtml'], '清空后列表为空态'

    def test_dnd_setting_in_template(self):
        tpl = _tpl()
        assert 'id="dndBlock"' in tpl and 'id="dndEnabled"' in tpl
        assert 'saveDndSetting()' in tpl
        src = _fe('18-toast.js')
        assert 'dndSuppressActive' in src and 'notifyPush' in src
        assert "localStorage.setItem('glm_dnd'" in src, 'DND 存 localStorage（不污染 config.json）'
        boot = _fe('110-boot.js')
        assert 'loadDndSetting' in boot and 'navInit' in boot


# ============================================================ T12 MCP resources
class _ResourceClient:
    """resources 能力桩客户端（延展 test_v13_mcp 的 _FakeClient 模式）。"""

    def __init__(self, resources=None, read_result=None, read_exc=None,
                 list_exc=None):
        self._resources = resources if resources is not None else [
            {'uri': 'file:///a.txt', 'name': 'a.txt', 'mimeType': 'text/plain'},
            {'uri': 'file:///b.bin', 'name': 'b.bin', 'mimeType': 'application/octet-stream'},
        ]
        self._read_result = read_result or {}
        self._read_exc = read_exc
        self._list_exc = list_exc
        self.alive = True
        self.server_info = {'name': 'res-server', 'version': '1'}
        self.instructions = ''
        self.list_calls = 0
        self.read_calls = []

    def is_alive(self):
        return self.alive

    def list_tools(self):
        return []

    def list_resources(self):
        self.list_calls += 1
        if self._list_exc is not None:
            raise self._list_exc
        return list(self._resources)

    def read_resource(self, uri):
        self.read_calls.append(uri)
        if self._read_exc is not None:
            raise self._read_exc
        return self._read_result

    def call_tool(self, name, arguments, timeout=None):
        return {'content': [{'type': 'text', 'text': 'ok'}]}

    def close(self):
        self.closed = True

    def clear_list_changed(self):
        pass


def _mk_res_service(client, tmp_path):
    cfg_path = str(tmp_path / 'mcp_servers.json')
    cfg = McpConfigService(path=cfg_path)
    cfg.save_server('res', {'command': 'node', 'args': ['s.js'], 'enabled': True})
    guard = GuardService()
    svc = McpService(cfg, guard, ToolcacheService())
    svc._spawn_client = lambda name, c: (client, None)
    return svc, cfg, guard


class TestT12McpResourcesClient:
    """T12 client 层：resources/list 游标分页 + resources/read 参数形状。"""

    def test_client_list_resources_pagination(self):
        from backend.domains.integrations.mcp.mcp_client import McpClient
        c = McpClient.__new__(McpClient)   # 绕过 __init__（无传输）
        pages = [{'resources': [{'uri': 'u1'}], 'nextCursor': 'c1'},
                 {'resources': [{'uri': 'u2'}], 'nextCursor': None}]
        calls = []

        def _req(method, params, timeout=None):
            calls.append((method, dict(params or {})))
            return pages[len(calls) - 1]

        c._request = _req
        got = c.list_resources()
        assert [r['uri'] for r in got] == ['u1', 'u2']
        assert calls[0][0] == 'resources/list' and calls[0][1] == {}
        assert calls[1][1] == {'cursor': 'c1'}, '第二页必须带 nextCursor'

    def test_client_read_resource_shape(self):
        from backend.domains.integrations.mcp.mcp_client import McpClient
        c = McpClient.__new__(McpClient)
        seen = {}

        def _req(method, params, timeout=None):
            seen['method'] = method
            seen['params'] = dict(params or {})
            return {'contents': [{'uri': 'u', 'text': 'x'}]}

        c._request = _req
        r = c.read_resource('file:///x')
        assert seen['method'] == 'resources/read'
        assert seen['params'] == {'uri': 'file:///x'}
        assert r['contents'][0]['text'] == 'x'


class TestT12McpResources:
    """T12：resources list/read/subscribe + 审计 + 契约。"""

    def test_list_resources_service_cache(self, tmp_path):
        client = _ResourceClient()
        svc, _cfg, _guard = _mk_res_service(client, tmp_path)
        r = svc.list_resources('res')
        assert r['ok'] is True and r['supported'] is True
        assert len(r['resources']) == 2
        entry = svc._rt['res']
        assert len(entry['resources']) == 2, 'service 层应缓存资源清单'

    def test_list_resources_unsupported_degrades(self, tmp_path):
        client = _ResourceClient(list_exc=McpProtocolError(-32601, 'Method not found'))
        svc, _cfg, _guard = _mk_res_service(client, tmp_path)
        r = svc.list_resources('res')
        assert r.get('ok') is True, '服务器不支持 resources 不算错误'
        assert r['supported'] is False and r['resources'] == []

    def test_read_resource_text(self, tmp_path):
        client = _ResourceClient(read_result={
            'contents': [{'uri': 'file:///a.txt', 'mimeType': 'text/plain',
                          'text': '资源正文内容'}]})
        svc, _cfg, _guard = _mk_res_service(client, tmp_path)
        r = svc.read_resource('res', 'file:///a.txt')
        assert r['ok'] is True and r['text'] == '资源正文内容'
        assert client.read_calls == ['file:///a.txt']
        # 审计可见（op=mcp_resource）
        entries = _audit_entries()
        hits = [e for e in entries if e.get('op') == 'mcp_resource'
                and e.get('detail', {}).get('tool') == 'resources/read']
        assert hits, 'resources/read 必须落审计'

    def test_read_resource_blob_cached(self, tmp_path):
        import base64 as b64
        blob = b64.b64encode(b'x' * 5000).decode('ascii')
        client = _ResourceClient(read_result={
            'contents': [{'uri': 'file:///b.bin', 'mimeType': 'application/octet-stream',
                          'blob': blob}]})
        svc, _cfg, _guard = _mk_res_service(client, tmp_path)
        r = svc.read_resource('res', 'file:///b.bin')
        assert r['ok'] is True
        assert r['blob_cached'] is True and r['blob_bytes'] == 5000
        assert r.get('cache_id'), 'blob 必须落盘 toolcache 并给 read_more 路径'

    def test_subscriptions_persist_and_survive_resave(self, tmp_path):
        client = _ResourceClient()
        svc, cfg, _guard = _mk_res_service(client, tmp_path)
        r = svc.save_subscriptions('res', ['file:///a.txt', 'file:///b.bin'])
        assert r['ok'] is True and len(r['subscribed']) == 2
        # 重存服务器（不携带 resourceSubs）→ 订阅保留（S16 同款保留语义）
        cfg.save_server('res', {'command': 'node', 'args': ['s.js'], 'enabled': True})
        svc2 = McpService(cfg, GuardService(), ToolcacheService())
        assert svc2.subscriptions('res') == ['file:///a.txt', 'file:///b.bin']
        # 显式清空 → 生效
        svc2.save_subscriptions('res', [])
        assert svc2.subscriptions('res') == []

    def test_subscriptions_reject_bad_input(self, tmp_path):
        client = _ResourceClient()
        svc, _cfg, _guard = _mk_res_service(client, tmp_path)
        assert svc.save_subscriptions('res', 'not-json').get('error')
        assert svc.save_subscriptions('res', {'a': 1}).get('error')
        assert svc.save_subscriptions('nope', []).get('error')

    def test_js_api_hidden_in_contract(self):
        """铁律：三个新 js_api 必须进 _V12_EXTRA（get_api_info 零漂移）。"""
        from backend import api as api_mod
        for m in ('mcp_list_resources', 'mcp_read_resource', 'mcp_save_subscriptions'):
            assert m in api_mod._V12_EXTRA, m + ' 未登记 _V12_EXTRA'
        reset_home()
        api = NewApi()
        info = json.loads(api.get_api_info())
        methods = set(info.get('methods') or [])
        for m in ('mcp_list_resources', 'mcp_read_resource', 'mcp_save_subscriptions'):
            assert m not in methods, m + ' 泄漏进 get_api_info（契约漂移）'

    def test_api_facade_shapes(self, tmp_path):
        """Api 门面三方法返回 shape（ok/err 包装）。"""
        client = _ResourceClient(read_result={
            'contents': [{'uri': 'u', 'text': 'hello'}]})
        cfg_path = str(tmp_path / 'mcp_servers.json')
        cfg = McpConfigService(path=cfg_path)
        cfg.save_server('res', {'command': 'node', 'args': ['s.js'], 'enabled': True})
        api = NewApi()
        api._mcp_cfg = cfg
        api._mcp = McpService(cfg, api._guard, api._toolcache)
        api._mcp._spawn_client = lambda name, c: (client, None)
        lst = json.loads(api.mcp_list_resources('res'))
        assert lst.get('ok') and len(lst['resources']) == 2
        rd = json.loads(api.mcp_read_resource('res', 'u'))
        assert rd.get('ok') and rd['text'] == 'hello'
        bad = json.loads(api.mcp_read_resource('res', ''))
        assert bad.get('error')
        sub = json.loads(api.mcp_save_subscriptions('res', '["u"]'))
        assert sub.get('ok')


def _audit_entries():
    from backend import paths
    p = os.path.join(paths.CONFIG_DIR, 'audit_log.jsonl')
    if not os.path.exists(p):
        return []
    with open(p, encoding='utf-8') as f:
        return [json.loads(ln) for ln in f.read().splitlines() if ln.strip()]


# ============================================================ T9 复核观察项（QA 提出）
class TestT9StatsGapFix:
    """QA 观察项：create_job 失败（限制参数不被系统支持等）也是真实 fail-closed
    拒绝路径——原 runs_failed_closed 不递增（T6 面板统计缺口）。修复后：
    异常照常上抛（阻断语义不变）+ 统计 +1。"""

    def test_create_job_failure_counts_failed_closed(self, monkeypatch):
        from backend.domains.workspace import sandbox_service as sb
        # _STATS 为模块级跨测试累积 → 用增量断言（不用绝对值）
        before_failed = sb._STATS['runs_failed_closed']
        before_jobs = sb._STATS['jobs_created']

        def _boom(limits, logger=None):
            raise sb.SandboxUnavailable('限制参数不被支持（桩）')

        monkeypatch.setattr(sb, 'create_job', _boom)
        with pytest.raises(sb.SandboxUnavailable):
            sb.run_in_sandbox('echo hi', shell=True, limits={'memory_mb': 1})
        assert sb._STATS['runs_failed_closed'] == before_failed + 1
        assert sb._STATS['jobs_created'] == before_jobs, '创建失败的 Job 不计入 jobs_created'
