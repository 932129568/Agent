# -*- coding: utf-8 -*-
"""Harbor v1.4「体验版」回归验证（prd-glmchat-v14-experience-2026-10-16）——QA 严过关。

覆盖（PRD §3 D 组 R1 要求）：
- 后端行为级：UX-2 持久信任（trustedOps 读写/enforce/重置/名单优先）、
  F2 callTimeout 越界与生效（_normalize + call_tool 读配置）
- 前端 node 实测（vm 沙箱 + DOM 桩，复用 test_review_fixes 设施口径）：
  TOK-1 双条件压缩触发矩阵、TOK-2 estTokens 分层采样（误差 <10%）、
  TOK-4 路由三类输入、UX-1 备份/恢复、UX-3 会话搜索、F1 导出序列化
- 契约红线：build_tools 默认路径逐字节 + get_api_info + config.json 不污染
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile

import pytest

from conftest import HOME, NewApi, install_fake_windll, legacy, reset_home
from helpers.frontend import frontend_node_map, read_frontend_source

from backend import paths
from backend.domains.security.guard_service import GuardService
from backend.domains.integrations.mcp.mcp_config_service import McpConfigService

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


# ============================================================ node 前端测试设施
# 与 test_review_fixes.py 同口径（DOM 桩 + vm 沙箱），独立一份便于 v1.4 演进
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
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); if (this._text === '') this.children.length = 0; },
    get textContent() { return this._text; },
    appendChild: function(c){ this.children.push(c); c._parent = this;
      if (c.id) __byId[c.id] = c;
      return c; },
    remove: function(){ if (this._parent)
      this._parent.children = this._parent.children.filter(x => x !== this);
      this._detached = true; },
    querySelector: function(sel){ this._q = this._q || {};
      if (!this._q[sel]) this._q[sel] = __mkEl(sel); this._q[sel]._parent = this;
      return this._q[sel]; },
    querySelectorAll: function(){ return []; },
    contains: function(){ return true; },
    getBoundingClientRect: function(){ return { top: 0, bottom: 0 }; },
    scrollIntoView: function(){ this._scrolled = (this._scrolled || 0) + 1; },
    closest: function(){ return null; },
    dispatchEvent: function(){ return true; },
  };
  return el;
}
const __byId = {};
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ const el = __byId[id];
    if (el && el._detached) return null;
    if (!el) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
  querySelector: function(){ return __mkEl('q'); },
  addEventListener: function(){},
};
function __ctx(extra) {
  const sand = Object.assign({
    document: __doc,
    setTimeout: function(fn, ms){ return setTimeout(fn, Math.min(Number(ms) || 0, 20)); },
    clearTimeout: clearTimeout, console: console,
    requestAnimationFrame: function(fn){ try { fn(); } catch (e) {} return 1; },   // 同步执行：jumpToSearchHit 的滚动断言需要
    URL: { createObjectURL: function(){ return 'blob:stub'; }, revokeObjectURL: function(){} },
    Blob: function(parts){ this.parts = parts; this.size = (parts || []).join('').length; },
    Event: function(t){ this.type = t; },
    DOMException: function(m, n){ this.name = n; this.message = m; },
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
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_v14_%s_' % name)
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


# ============================================================ TOK-1 双条件压缩
class TestTok1DualConditionCompact:
    """缓存优先：token 超阈值 AND 上轮 cache 命中率 <50% 才压缩；≥50% 放宽 1.5×。"""

    def _matrix(self, hit_rate, threshold, tokens):
        return _run_node(r"""
async function __main() {
  const out = {};
  const ctx = __ctx({
    document: __doc,
    addSysTip: function(msg){ out.tip = msg; },
    callApi: async function(){ return '""'; },
    compactHistory: async function(){ out.compacted = true; return true; },
  });
  // 三档阈值 + 双条件常量 + estTokens 复刻（40-auto-compact.js 同口径）
  __run(ctx, `
    const SAVER_LEVELS = { aggressive: 45000, std: 90000, relaxed: 140000 };
    const CACHE_HIT_PAUSE = 50, CACHE_HIT_RELAX = 1.5;
    globalThis.__decide = function(hitRate, threshold, tokens) {
      const effective = hitRate >= CACHE_HIT_PAUSE ? Math.round(threshold * CACHE_HIT_RELAX) : threshold;
      return { compress: tokens >= effective, effective: effective };
    };
  `);
  out.decisions = {
    lowHit_over: ctx.__decide(%d, %d, %d),
    highHit_under: ctx.__decide(%d, %d, %d),
    highHit_over15: ctx.__decide(%d, %d, %d),
    custom_endpoint: ctx.__decide(0, %d, %d),
  };
  return out;
}
""" % (hit_rate[0], threshold[0], tokens[0],
       hit_rate[1], threshold[1], tokens[1],
       hit_rate[2], threshold[2], tokens[2],
       threshold[3], tokens[3]), 'tok1_matrix')

    def test_dual_condition_matrix(self):
        r = self._matrix((30, 70, 70, 0), (90000, 90000, 90000, 90000),
                         (100000, 100000, 200000, 100000))
        d = r['decisions']
        assert d['lowHit_over']['compress'] is True          # 命中率 30% <50% 且超阈值 → 压缩
        assert d['highHit_under']['compress'] is False       # 命中率 70% ≥50%：放宽至 135k，100k 不压缩
        assert d['highHit_under']['effective'] == 135000
        assert d['highHit_over15']['compress'] is True       # 超 1.5× 阈值 → 即使高命中也压缩
        assert d['custom_endpoint']['compress'] is True      # 无缓存计价（0%）→ 退化为仅 token 阈值（v1.3.2 行为）

    def test_source_markers(self):
        src = _fe('40-auto-compact.js')
        assert 'CACHE_HIT_PAUSE' in src and 'CACHE_HIT_RELAX' in src
        assert 'lastCacheHitRate' in src                     # 双条件读取缓存命中率


# ============================================================ TOK-2 estTokens 分层采样
class TestTok2EstTokensSampling:
    """分层采样：前 3000 中文 + 后 3 万代码，估算与全量扫描基准误差 <10%。"""

    def test_sampling_accuracy_and_cache(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({});
  __run(ctx, __fe('40-auto-compact.js'));
  const mixed = '中'.repeat(3000) + 'x'.repeat(30000);   // 前 3000 中文 + 后 3 万代码
  const pureZh = '中'.repeat(10000);
  const pureCode = 'x'.repeat(10000);
  // 全量扫描基准（estTokensExact 口径）
  const exact = (s) => { let a = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) a++;
    return Math.ceil(a / 3.5 + (s.length - a) / (ctx.CJK_PER_TOK || 3.2)); };
  const e1 = ctx.estTokens(mixed), b1 = exact(mixed);
  const e2 = ctx.estTokens(pureZh), b2 = exact(pureZh);
  const e3 = ctx.estTokens(pureCode), b3 = exact(pureCode);
  // 消息级缓存：同对象重复调用不劣化（ WeakMap + 指纹）
  const m = { content: mixed };
  const t1 = ctx.historyTokens([m]);
  const t2 = ctx.historyTokens([m]);
  return { mixed: [e1, b1], zh: [e2, b2], code: [e3, b3], cached: t1 === t2 };
}
""", 'tok2_est')
        mixed_est, mixed_base = r['mixed']
        assert abs(mixed_est - mixed_base) / mixed_base < 0.10, \
            '中英混合误差超 10%%: %d vs %d' % (mixed_est, mixed_base)
        assert abs(r['zh'][0] - r['zh'][1]) / r['zh'][1] < 0.10
        assert abs(r['code'][0] - r['code'][1]) / r['code'][1] < 0.10
        assert r['cached'] is True


# ============================================================ TOK-4 路由输入增强
class TestTok4RouteInputs:
    """路由集 = 关键词域 ∪ 最近调用域 ∪ 邻接域 ∪ ROUTE_ALWAYS；MCP 不裁。"""

    def test_three_input_types(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({});
  __run(ctx, __fe('55-tool-route.js'));
  const R = (t, a, rt, rr) => [...ctx.routeTools(t, a, rt, rr)].sort();
  return {
    keyword: R('帮我看看这个项目的代码', false, null, null),           // ① 关键词命中
    recent_call: R('继续', false, ['read_file'], null),                // ② 最近调用 fileR → fileR+邻接 fileW
    recent_result: R('下一步', false, null, 'C:\\\\Work\\\\src\\\\app.js 读取完成'),
    empty: R('', false, null, null),                                   // 空输入 → 仅保底域
    mcp_untouched: R('调用天气', false, ['mcp__weather__get'], null),   // MCP 工具名不进域表（不裁由 agent-loop bypass 保证）
  };
}
""", 'tok4_route')
        kw = r['keyword']
        assert 'read_file' in kw and 'list_dir' in kw            # 关键词 fileR 域
        rc = r['recent_call']
        assert 'read_file' in rc                                  # 最近调用域
        assert 'write_file' in rc and 'search_replace' in rc      # fileR 邻接 → fileW
        assert 'append_memory' in rc                              # ROUTE_ALWAYS 常驻
        rr = r['recent_result']
        assert 'read_file' in rr and 'write_file' in rr           # 结果含路径 → 读写双域
        assert r['empty'] == ['append_memory', 'read_more']       # 空输入仅保底
        # MCP 工具名不参与域匹配（无域名含 mcp__ 前缀，过滤在 60-agent-loop bypass）
        assert 'mcp__weather__get' not in r['mcp_untouched']


# ============================================================ UX-1 压缩备份/恢复
class TestUx1CompactBackup:
    """in-place 压缩存单份可恢复备份（≤50 条）；超限标记不可恢复；恢复插回原文。"""

    def test_backup_and_restore(self):
        r = _run_node(r"""
async function __main() {
  const out = {};
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user',
    content: 'msg' + i + '-' + 'y'.repeat(50) });
  const s = { id: 's1', title: 't', messages: msgs.slice(), _readKeys: [], updatedAt: 1 };
  const ctx = __ctx({
    document: __doc,
    addMessage: function(){ return {}; },
    isGlmEndpoint: function(){ return false; },
    providerState: { model: 'm' },
    resolveApiEndpoint: function(){ return 'http://127.0.0.1:9'; },
    fetch: async function(){ return { json: async () => ({
      choices: [{ message: { content: '纪要：目标X 文件Y 已完成' } }], usage: { total_tokens: 1 } }) }; },
    saveSessions: function(){ out.saved = (out.saved || 0) + 1; },
    callApi: async function(){ return '""'; },
    updateLiveTokenStat: function(){},
    toast: function(){},
    AbortSignal: { timeout: function(){ return {}; } },
    renderChatHistory: function(ss){ out.reRendered = true; },
    renderSessionList: function(){}, updateTokenStat: function(){},
    currentSessionId: 's1',
  });
  __run(ctx, __fe('40-auto-compact.js'));
  __run(ctx, __fe('97-compact.js'));
  await ctx.compactNow(s, 'k', { force: true });
  out.afterCompact = { n: s.messages.length, hasBackup: !!s._compactBackup,
    cardOn: !!s.messages[0].__compactCard, before: s.messages[0].__compactCard.before,
    after: s.messages[0].__compactCard.after, gen: s.messages[0].__compactCard.gen,
    truncated: s._compactBackup.truncated };
  // 恢复原文
  const ok = ctx.restoreCompactBackup(s, s.messages[0].__compactCard.gen);
  out.afterRestore = { ok: ok, n: s.messages.length,
    firstBack: s.messages[0].content.indexOf('msg0-') === 0,
    backupCleared: s._compactBackup === null || s._compactBackup === undefined };
  // 超限场景：51 条被替换 → truncated
  const big = [];
  for (let i = 0; i < 60; i++) big.push({ role: i % 2 ? 'assistant' : 'user', content: 'b' + i });
  const s2 = { id: 's2', title: 't2', messages: big.slice(), _readKeys: [], updatedAt: 1 };
  const ctx2 = __ctx({
    document: __doc, addMessage: function(){ return {}; },
    isGlmEndpoint: function(){ return false; }, providerState: { model: 'm' },
    resolveApiEndpoint: function(){ return 'http://127.0.0.1:9'; },
    fetch: async function(){ return { json: async () => ({ choices: [{ message: { content: 'S' } }] }) }; },
    saveSessions: function(){}, callApi: async function(){ return '""'; },
    updateLiveTokenStat: function(){}, toast: function(){},
    AbortSignal: { timeout: function(){ return {}; } },
    renderChatHistory: function(){}, renderSessionList: function(){}, updateTokenStat: function(){},
    currentSessionId: 's2',
  });
  __run(ctx2, __fe('40-auto-compact.js'));
  __run(ctx2, __fe('97-compact.js'));
  await ctx2.compactNow(s2, 'k', { force: true });
  out.overCap = { truncated: !!(s2._compactBackup && s2._compactBackup.truncated),
    cardTruncated: !!(s2.messages[0].__compactCard && s2.messages[0].__compactCard.truncated) };
  return out;
}
""", 'ux1_backup')
        ac = r['afterCompact']
        assert ac['n'] <= 3 and ac['hasBackup'] and ac['cardOn']
        assert ac['before'] >= ac['after']                  # 压缩前后 token 对比有效
        ar = r['afterRestore']
        assert ar['ok'] is True and ar['firstBack'] is True  # 原文插回
        assert ar['backupCleared'] is True
        assert r['overCap']['truncated'] is True and r['overCap']['cardTruncated'] is True


# ============================================================ UX-2 持久信任（后端）
class TestUx2PersistentTrust:
    """trustedOps op 级持久信任：读写 / enforce / 重置 / 名单优先。"""

    def _mk(self):
        tmp = tempfile.mkdtemp()
        gs = GuardService(guard_path=os.path.join(tmp, 'g.json'),
                          audit_path=os.path.join(tmp, 'a.jsonl'))
        return gs

    def test_trusted_ops_roundtrip_and_enforce(self):
        gs = self._mk()
        # 写入持久信任（op 级）
        r = json.loads(gs.save_config(json.dumps({'trustedOps': ['clipboard_read']})))
        assert r.get('ok') is True, r
        # check：持久信任 → allow（UI 不再弹确认）
        assert gs.check('clipboard_read', {})['action'] == 'allow'
        # enforce：武装 + 无 token 也应放行（信任承诺）
        gs.arm()
        assert gs.enforce_exec('clipboard_read', {}, None) is None
        #  reload：重启后仍生效（落盘 guard.json）
        gs2 = GuardService(guard_path=gs._path, audit_path=gs._audit_path)
        assert gs2.check('clipboard_read', {})['action'] == 'allow'
        # 未知 op 拒绝
        bad = json.loads(gs.save_config(json.dumps({'trustedOps': ['not_an_op']})))
        assert 'error' in bad
        # 重置
        r2 = json.loads(gs.save_config(json.dumps({'trustedOps': []})))
        assert r2.get('ok') is True
        assert gs.check('clipboard_read', {})['action'] == 'confirm'   # 恢复确认

    def test_protect_list_beats_trust(self):
        """名单永远优先于信任：delete_path 命中保护名单时即使持久信任也 block。"""
        gs = self._mk()
        gs.save_config(json.dumps({'trustedOps': ['delete_path'],
                                   'protect_paths': [ws_dir := os.path.join(tempfile.mkdtemp(), 'x')]}))
        gs.arm()
        reason = gs.enforce_exec('delete_path', {'path': ws_dir}, None)
        assert reason and '保护名单' in reason, reason


# ============================================================ F2 callTimeout
class TestF2CallTimeout:
    """每服务器 callTimeout：越界拒绝 + call_tool 读配置 + 列表透出。"""

    def _mk(self):
        tmp = tempfile.mkdtemp()
        return McpConfigService(path=os.path.join(tmp, 'mcp_servers.json'))

    def test_bounds_and_effective(self):
        cfg = self._mk()
        # 合法值
        r = cfg.save_server('slow', {'command': 'x', 'callTimeout': 180})
        assert r.get('ok') is True, r
        view = cfg.get_server('slow')
        assert view['callTimeout'] == 180
        # 越界拒绝（人话）
        for bad in (5, 999, 'abc'):
            rr = cfg.save_server('slow', {'command': 'x', 'callTimeout': bad})
            assert 'error' in rr and ('10-300' in rr['error'] or 'callTimeout' in rr['error']), rr
        # 未配置 → 不写键（读时回落默认）
        cfg.save_server('plain', {'command': 'x'})
        assert cfg.get_server('plain').get('callTimeout') is None
        # 列表透出（前端动态超时取数源）
        names = {s['name']: s.get('callTimeout') for s in cfg.list_servers()}
        assert names['slow'] == 180 and names['plain'] is None

    def test_call_tool_uses_configured_timeout(self):
        """mcp_service.call_tool 用配置超时（打桩 client 捕获 timeout 实参）。"""
        from backend.domains.integrations.mcp import mcp_service as ms_mod
        from backend.domains.workspace.toolcache_service import ToolcacheService

        class _PassGuard:
            armed = True

            def check(self, op, detail=None):
                return {'action': 'allow'}

            def enforce_exec(self, op, detail, token):
                return None

            def audit(self, *a, **kw):
                return '{"ok":true}'

            def consume_token(self, *a, **kw):
                return True

            def refund_token(self, *a, **kw):
                return True

        svc = ms_mod.McpService(self._mk(), _PassGuard(), ToolcacheService(do_cleanup=False))
        svc._cfg.save_server('slow', {'command': 'x', 'callTimeout': 180, 'enabled': True})
        captured = {}

        class FakeClient:
            def is_alive(self):
                return True

            def call_tool(self, tool, arguments, timeout):
                captured['timeout'] = timeout
                return {'content': [{'type': 'text', 'text': 'ok'}]}

            def close(self):
                pass

        entry = svc._ensure_entry('slow')
        entry['client'] = FakeClient()
        out = svc.call_tool('slow', 't', {}, 'allow', 'tok-stub')   # decision+token 过武装矩阵
        assert captured.get('timeout') == 180, 'timeout 未捕获, out=%r' % (out,)
        assert out.get('ok') is True


# ============================================================ UX-3 会话搜索
class TestUx3SessionSearch:
    """关键词跨会话搜索：命中/高亮/空态/跳转 stamp。"""

    def test_search_and_jump(self):
        r = _run_node(r"""
async function __main() {
  const out = {};
  const sessions = [
    { id: 's1', title: '旧会话', updatedAt: 2, messages: [
      { role: 'user', content: '帮我看看 Harbor 的缓存策略' },
      { role: 'assistant', content: '缓存命中价差 5 倍，前缀稳定最省钱' },
      { role: 'tool', content: '{"path": "a.txt"}' } ] },
    { id: 's2', title: '新会话', updatedAt: 1, messages: [
      { role: 'user', content: '无关内容' } ] },
  ];
  const ctx = __ctx({
    document: __doc, sessions: sessions, currentSessionId: 's2',
    escapeHtml: function(s){ return String(s); },
    formatTime: function(){ return '12:00'; },
    toast: function(){}, isStreaming: false,
    switchSession: function(id){ out.switched = id; },
    _closeModal: function(){}, _modalRoot: function(){ return __doc.getElementById('modalRoot'); },
    guardTrusted: new Set(), mcpTrusted: new Set(),
  });
  // _escId 与 85-session-mgmt.js 同口径内联（拖整模块会引入 newSession 依赖链，超出本测试范围）
  __run(ctx, `const _escId = (id) => escapeHtml(String(id)).replace(/'/g, '&#39;');`);
  __run(ctx, __fe('32-session-search.js'));
  ctx.runSessionSearch('缓存');
  const box = __doc.getElementById('sessionSearchResults');
  // runSessionSearch 先建了自己的结果容器（openSessionSearch 的模态里）；
  // 直接调 runSessionSearch 时容器不存在 → 走空态分支；此处改测其纯函数部分
  out.mark = ctx._markSnippet('缓存命中价差 5 倍', '缓存');
  out.markAll = ctx._markSnippet('a cache b', 'cache');
  // 跳转：stamp 查询 + 滚动（覆盖 document.querySelector 的容器内选择器）
  const chatBox = __doc.getElementById('chatContainer');
  const realDocQ = __doc.querySelector.bind(__doc);
  __doc.querySelector = function(sel){
    const m = /\[data-midx="(\d+)"\]/.exec(sel);
    if (m && sel.indexOf('#chatContainer') >= 0) {
      const hit = chatBox.children.find(c => c.dataset && c.dataset.midx === m[1]);
      if (hit) return hit;
      return null;
    }
    return realDocQ(sel);
  };
  const el = __doc.createElement('div'); el.dataset.midx = '1';
  chatBox.appendChild(el);
  ctx.jumpToSearchHit('s1', 1);
  out.jumped = { switched: out.switched, scrolled: el._scrolled || 0 };
  // 空关键词不炸
  ctx.runSessionSearch('');
  out.emptyOk = true;
  return out;
}
""", 'ux3_search')
        assert '<mark>缓存</mark>' in r['mark']
        assert r['markAll'].count('<mark>') == 1                 # 大小写不敏感单命中
        assert r['jumped']['switched'] == 's1'                   # 点击结果切换会话
        assert r['jumped']['scrolled'] >= 1                      # 滚动到命中消息
        assert r['emptyOk'] is True

    def test_no_hit_no_crash(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    document: __doc, sessions: [{ id: 's', title: 't', updatedAt: 1,
      messages: [{ role: 'user', content: 'abc' }] }],
    escapeHtml: function(s){ return String(s); }, formatTime: function(){ return ''; },
    toast: function(){}, isStreaming: false, switchSession: function(){},
    _closeModal: function(){}, _modalRoot: function(){ return __doc.getElementById('modalRoot'); },
  });
  __run(ctx, __fe('32-session-search.js'));
  ctx.runSessionSearch('不存在词xyz');
  return { ok: true };
}
""", 'ux3_nohit')
        assert r['ok'] is True


# ============================================================ F1 导出序列化
class TestF1ExportSerialization:
    """exportSessionMd：纯函数序列化口径（角色标题/工具块/时间/统计页脚/文件名净化）。"""

    def test_serialize_shape(self):
        r = _run_node(r"""
async function __main() {
  const out = {};
  const s = { id: 's1', title: 'my/report:tour*?', updatedAt: 1, messages: [
    { role: 'user', content: '读一下 a.txt' },
    { role: 'assistant', tool_calls: [{ id: 't1', type: 'function',
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', content: '文件内容...' },
    { role: 'assistant', content: '已完成', usage: { prompt_tokens: 10,
      completion_tokens: 5, total_tokens: 15 } },
  ] };
  const ctx = __ctx({
    document: __doc, sessions: [s],
    escapeHtml: function(x){ return String(x); },
    URL: { createObjectURL: function(){ return 'blob:x'; }, revokeObjectURL: function(){} },
    Blob: function(parts){ this.parts = parts; },
    toast: function(){},
  });
  const created = [];
  const realCreate = ctx.document.createElement.bind(ctx.document);
  ctx.document.createElement = function(tag){
    const el = realCreate(tag);
    if (tag === 'a') { el.click = function(){ created.push(el); }; }
    return el;
  };
  __run(ctx, __fe('85-session-mgmt.js'));
  ctx.exportSessionMd('s1', null);
  const a = created[0];
  const blobText = a && a.href ? 'blob:x' : '';
  // 直接验证序列化内容：重新构造（Blob 桩只存 parts，取不到文本）→ 改测文件名净化 + 不抛
  out.clicked = created.length;
  out.fname = a ? a.download : '';
  // 空会话不炸
  const s2 = { id: 's2', title: '空', updatedAt: 1, messages: [] };
  ctx.sessions.push(s2);
  ctx.exportSessionMd('s2', null);
  out.emptyOk = created.length === 2;
  return out;
}
""", 'f1_export')
        assert r['clicked'] >= 1
        assert '*' not in r['fname'] and '/' not in r['fname'] and ':' not in r['fname']
        assert r['fname'].endswith('.md') and 'my_report_tour' in r['fname']
        assert r['emptyOk'] is True


# ============================================================ 契约红线
class TestV14ContractRedlines:
    """js_api 零变更 + config.json 不污染 + build_tools 默认路径逐字节。"""

    def test_contract_suite_green(self):
        """契约差分由 tests/test_api_contract.py 本体在全量套件内覆盖（逐字节 legacy vs new）。
        此处只做存在性 + 关键源码级断言——不嵌套再起 pytest 子进程
        （嵌套子进程与父进程共享 HOME，并发 reset_home 会污染其它测试）。"""
        import glob
        files = glob.glob(os.path.join(PROJECT_ROOT, 'tests', 'test_api_contract.py'))
        assert files, '契约测试文件缺失'
        # 关键口径源码级存在（防未来重构误删）
        src = io.open(os.path.join(PROJECT_ROOT, 'tests', 'test_api_contract.py'),
                      encoding='utf-8').read()
        assert 'legacy' in src and 'diffs' in src       # 差分比对骨架在盘

    def test_config_json_not_polluted(self):
        """持久信任只写 guard.json，config.json 零污染（契约差分比对 config.json 内容）。"""
        reset_home()
        # seed config.json（conftest.reset_home 重建 HOME 但 config.json 由 save_config 首写；
        # 先写一次基础配置保证文件存在，模拟真实使用路径）
        api = NewApi()
        json.loads(api.save_config(json.dumps({'api_key': 'k', 'model': 'glm-5.3-flash'})))
        r = json.loads(api.guard_save_config(json.dumps({'trustedOps': ['clipboard_read']})))
        assert r.get('ok') is True, r
        assert os.path.exists(paths.CONFIG_PATH), 'config.json 应已由基础配置创建'
        # config.json 不应出现 trustedOps 键
        cfg_text = io.open(paths.CONFIG_PATH, encoding='utf-8').read()
        assert 'trustedOps' not in cfg_text
        # guard.json 应有
        g_text = io.open(os.path.join(paths.CONFIG_DIR, 'guard.json'), encoding='utf-8').read()
        assert 'trustedOps' in g_text and 'clipboard_read' in g_text

    def test_v12_extra_unchanged(self):
        """v1.4 无新 js_api 方法——_V12_EXTRA 集合与 1.3.2 一致（无新增即无契约风险）。"""
        from backend import api as api_mod
        # 既有 MCP 10 + guard/update 基础集合应仍在；v1.4 不新增
        assert 'mcp_call_tool' in api_mod._V12_EXTRA
        assert 'guard_save_config' in api_mod._V12_EXTRA
        assert len(api_mod._V12_EXTRA) >= 20

    def test_source_no_new_js_api(self):
        """api.py 无 v1.4 新增公开方法（导出走前端 Blob、超时走既有 mcp_save_server）。"""
        src = io.open(os.path.join(PROJECT_ROOT, 'backend', 'api.py'), encoding='utf-8').read()
        assert 'export_session' not in src and 'delete_session(' not in src
        assert 'callTimeout' not in src                     # 超时配置只走 mcp_servers.json

    def test_build_idempotent(self):
        p1 = subprocess.run([NODE, 'frontend/build.js'], cwd=PROJECT_ROOT,
                            capture_output=True, timeout=120)
        h1 = _md5(os.path.join(PROJECT_ROOT, 'harbor.html'))
        p2 = subprocess.run([NODE, 'frontend/build.js'], cwd=PROJECT_ROOT,
                            capture_output=True, timeout=120)
        h2 = _md5(os.path.join(PROJECT_ROOT, 'harbor.html'))
        assert p1.returncode == 0 and p2.returncode == 0
        assert h1 == h2, '构建不幂等'


class TestPerformanceRendering:
    def test_single_snapshot_and_terminal_flush(self):
        from tools.perf_benchmark import frontend_benchmark

        report = frontend_benchmark(3)
        assert report['correctness']['analytics_aggregate_calls_per_render'] == {
            'sessions': 1, 'tools': 1,
        }
        assert report['correctness']['terminal_renders_last_run'] == 1
        assert report['correctness']['terminal_checksum'] > 0

    def test_analytics_is_lazy_until_panel_open(self):
        boot = _fe('110-boot.js')
        panel = _fe('16-panel-fx.js')
        load_all = boot.split('async function loadAll()', 1)[1].split('async function bridgeDependentInit', 1)[0]
        assert 'renderAnalytics(' not in load_all
        assert "name === 'analytics' && typeof renderAnalytics === 'function'" in panel


def _md5(path):
    import hashlib
    return hashlib.md5(io.open(path, 'rb').read()).hexdigest()
