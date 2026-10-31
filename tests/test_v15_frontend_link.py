# -*- coding: utf-8 -*-
"""v1.5 预留接口层 · 前端联调实证（vm 沙箱 + 打桩 bridge）。

对 deliverables/dev-plan/reserved-interfaces-v15-2026-10-17.md §2 的前端两个新模块
（34-local-model.js / 37-webdav.js）做真实调用路径验证：
- 请求参数拼接（local_probe 无参 / local_models(base_url) / test_provider_endpoint
  五参含 local 标志 / webdav_test(JSON) / webdav_export 无参）
- 响应处理（reachable/unreachable 分态渲染 / 模型 option 刷新 + 元数据缓存 /
  loading 态区分 / reserved 占位渲染 / 导出计划 missing 跳过）
- 异常兜底（JSON.parse 失败 / callApi reject / 空 Base URL 前置校验）
- UI 状态机（按钮禁用+文案 / finally 复位 / toast 汇总）

同时覆盖 v4 port-spec §3 的 10 个 JS 模块改造在位性断言（防回退）。
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from helpers.frontend import frontend_node_map, read_frontend_source, read_frontend_styles

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], value: '', checked: false, onclick: null,
    disabled: false, textContent: '', _html: '',
    focus: function(){},
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      toggle: function(c, f){ if (f === undefined) f = !this._s.has(c);
        if (f) this._s.add(c); else this._s.delete(c); return f; },
      contains: function(c){ return this._s.has(c); } },
    appendChild: function(c){ this.children.push(c); c._parent = this;
      if (c.id) __byId[c.id] = c; return c; },
    remove: function(){},
    querySelector: function(){ return __mkEl('q'); },
    querySelectorAll: function(){ return []; },
    addEventListener: function(){},
  };
  // 忠实桩：innerHTML 赋值解析 <span ...></span> 序列生成 children
  // （源码 row.innerHTML='<span>×3' 后访问 children[1]——真实 DOM 语义）
  Object.defineProperty(el, 'innerHTML', {
    set: function(v) { this._html = String(v); this.children.length = 0;
      const re = /<span[^>]*><\/span>/g; let m;
      while ((m = re.exec(this._html))) { const s = __mkEl('span'); this.children.push(s); } },
    get: function() { return this._html; },
  });
  return el;
}
const __byId = {};
const __toasts = [];
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
    CS: { syncAll: function(){ sand.__csSync = (sand.__csSync || 0) + 1; } },
  }, extra || {});
  sand.window = sand;
  return __vm.createContext(sand);
}
function __run(ctx, code) { __vm.runInContext(code, ctx, { timeout: 30000 }); }
const __SRC = %r;
const __MANIFEST = %r;
function __fe(name){
  const relative = __MANIFEST[name] || name;
  return __fs.readFileSync(__SRC + '/' + relative, 'utf8');
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
        pytest.skip('node 不可用')
    js = _JS_PRELUDE + body + _JS_MAIN
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_v15fe_%s_' % name)
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


# ============================================================ 34-local-model 联调
class TestLocalModelLink:
    """A2 探测 / A3 清单 / A5 测试连接 的真实调用路径。"""

    def test_probe_render_and_autofill(self):
        r = _run_node(r"""
async function __main() {
  const calls = [];
  const ctx = __ctx({
    callApi: async function(api, args, timeoutMs){
      calls.push({ api: api, args: args, timeoutMs: timeoutMs });
      if (api === 'local_probe') return JSON.stringify({ ok: true, elapsed_ms: 320,
        reachable: [{ base_url: 'http://localhost:11434/v1', kind: 'ollama',
          reachable: true, models: ['qwen3:8b', 'llama3'], latency_ms: 45 }],
        unreachable: [{ base_url: 'http://localhost:1234/v1', error: '连接被拒绝' }] });
      if (api === 'local_models') return JSON.stringify({ ok: true,
        models: [{ id: 'qwen3:8b', ctx_window: 32768, tool_capable: true, estimated: false },
                 { id: 'llama3', ctx_window: 8192, tool_capable: false, estimated: true }] });
      return '""';
    },
  });
  __run(ctx, __fe('34-local-model.js'));
  await ctx.localProbeNow();
  await new Promise(res => setTimeout(res, 20));   // 探测内 fire-and-forget 的清单补拉 flush
  const box = __doc.getElementById('localProbeResult');
  const btn = __doc.getElementById('localProbeBtn');
  const base = __doc.getElementById('localBaseUrl');
  const sel = __doc.getElementById('localModelSelect');
  const badge = __doc.getElementById('localMetaBadge');
  return {
    probeCall: calls[0],
    modelsCall: (calls[1] || {}).api,
    rows: box.children.length,
    rowText: box.children.map(c => (c.children[1] || {}).textContent || ''),
    btnRestored: btn.disabled === false && btn.textContent === '探测本机',
    baseFilled: base.value,
    modelOptions: sel.children.map(c => c.value),
    badge: badge.textContent,
    csSync: ctx.__csSync,
    toasts: __toasts.map(t => t.msg),
  };
}
""", 'local_probe')
        assert r['probeCall']['api'] == 'local_probe' and r['probeCall']['args'] == []   # 无参调用
        assert r['modelsCall'] == 'local_models'            # 命中预设自动补拉清单
        assert r['rows'] == 2                               # reachable + unreachable 两行
        assert 'localhost:11434' in r['rowText'][0] and 'localhost:1234' in r['rowText'][1]
        assert r['btnRestored'] is True                     # finally 复位
        assert r['baseFilled'] == 'http://localhost:11434/v1'   # 命中预设自动填充
        assert r['modelOptions'] == ['qwen3:8b', 'llama3']
        assert '32k' in r['badge'] and '工具可用' in r['badge']   # 元数据徽标（let 变量不挂沙箱，经 UI 验证）
        assert r['csSync'] == 1                             # 清单刷新后同步自定义下拉
        assert any('探测到 1 个' in t for t in r['toasts'])

    def test_test_connection_params_and_loading(self):
        r = _run_node(r"""
async function __main() {
  const calls = [];
  const ctx = __ctx({
    callApi: async function(api, args, timeoutMs){
      calls.push({ api: api, args: args, timeoutMs: timeoutMs });
      if (api === 'test_provider_endpoint') return JSON.stringify({
        ok: true, state: 'loading', message: '模型加载中（约 30s）' });
      return '""';
    },
  });
  __run(ctx, __fe('34-local-model.js'));
  __doc.getElementById('localBaseUrl').value = 'http://localhost:11434/v1';
  __doc.getElementById('localModelSelect').value = 'qwen3:8b';
  await ctx.localTestNow();
  const st = __doc.getElementById('localTestStatus');
  const btn = __doc.getElementById('localTestBtn');
  return {
    call: calls[0], status: st.textContent, color: st.style.color,
    btnRestored: btn.disabled === false && btn.textContent === '测试连接',
    toasts: __toasts.map(t => ({ msg: t.msg, kind: t.kind })),
  };
}
""", 'local_test')
        c = r['call']
        assert c['api'] == 'test_provider_endpoint'
        assert c['args'] == ['http://localhost:11434/v1', '', 'qwen3:8b', 30, True]  # local 标志第 5 参
        assert c['timeoutMs'] == 90000                      # 冷启动可见的桥接超时
        assert '加载中' in r['status'] and r['color'] == 'var(--warn)'   # loading 态区分
        assert r['btnRestored'] is True
        assert r['toasts'][0]['kind'] == 'ok'

    def test_empty_base_and_fail_fallback(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(){ throw new Error('bridge 断了'); },
  });
  __run(ctx, __fe('34-local-model.js'));
  __doc.getElementById('localBaseUrl').value = '';
  __doc.getElementById('localModelSelect').value = 'm';
  await ctx.localTestNow();                    // 空 base → 前置 warn，不发请求
  const afterEmpty = __toasts.map(t => t.msg);
  __doc.getElementById('localBaseUrl').value = 'http://x/v1';
  await ctx.localLoadModels('');              // 空 base → 前置 warn
  const afterLoad = __toasts.map(t => t.msg);
  // callApi reject → catch 兜底
  await ctx.localLoadModels('http://x/v1');
  const st = __doc.getElementById('localTestStatus');
  const btn = __doc.getElementById('localModelsBtn');
  return { afterEmpty: afterEmpty, afterLoad: afterLoad,
    btnRestored: btn.disabled === false && btn.textContent === '拉取模型清单' };
}
""", 'local_fail')
        assert any('请先填写 Base URL' in t for t in r['afterEmpty'])   # 前置校验
        assert any('请先填写 Base URL' in t for t in r['afterLoad'])
        assert r['btnRestored'] is True        # reject 后 finally 仍复位

    def test_probe_error_branch(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(){ return JSON.stringify({ ok: false, error: '探测器异常' }); },
  });
  __run(ctx, __fe('34-local-model.js'));
  await ctx.localProbeNow();
  const btn = __doc.getElementById('localProbeBtn');
  return { toasts: __toasts.map(t => ({ msg: t.msg, kind: t.kind })),
    btnRestored: btn.disabled === false };
}
""", 'local_probe_err')
        assert r['toasts'][0]['kind'] == 'err' and '探测器异常' in r['toasts'][0]['msg']
        assert r['btnRestored'] is True


# ============================================================ 37-webdav 联调
class TestWebdavLink:
    """reserved 占位渲染 / 校验失败分支 / 导出计划。"""

    def test_reserved_render_and_export_plan(self):
        r = _run_node(r"""
async function __main() {
  const calls = [];
  const ctx = __ctx({
    callApi: async function(api, args){
      calls.push({ api: api, args: args });
      // v1.6 执行器契约形状（旧 reserved 形状已退役：ok falsy → 失败分支+plan 预览）
      if (api === 'webdav_test') return JSON.stringify({ ok: true, dav_capability: '1, 2', detail: '连接成功（DAV 能力：1, 2）' });
      if (api === 'webdav_export') return JSON.stringify({ ok: true, uploaded: ['config.json', 'sessions.json'],
        manifest: { version: 1, items: [{ path: 'config.json', bytes: 2048, sha256: 'abcdef1234567890' },
               { path: 'sessions.json', missing: true }] } });
      return '""';
    },
  });
  __run(ctx, __fe('37-webdav.js'));
  __doc.getElementById('webdavUrl').value = 'https://dav.example.com';
  __doc.getElementById('webdavUser').value = 'u';
  __doc.getElementById('webdavPass').value = 'p';
  await ctx.webdavTestNow();
  const testStatusTxt = __doc.getElementById('webdavStatus').textContent;   // 值捕获（后续 exportNow 会覆盖同一元素）
  const testBtn = __doc.getElementById('webdavTestBtn');
  await ctx.webdavExportNow();
  const expSt = __doc.getElementById('webdavStatus');
  const expBtn = __doc.getElementById('webdavExportBtn');
  // 修复 W35（三轮）：boot 回填（webdav_get_config）与导出前自动保存（webdav_save_config）
  // 会插入调用序列——按「用户交互调用」过滤后再取契约位次
  const seq = calls.filter(c => c.api === 'webdav_test' || c.api === 'webdav_export');
  return {
    testCall: seq[0], exportCall: seq[1],
    testCfg: JSON.parse(seq[0].args[0]),
    testStatus: testStatusTxt, testBtnOk: testBtn.disabled === false && testBtn.textContent === '测试连接',
    exportStatus: expSt.textContent, exportBtnOk: expBtn.disabled === false && expBtn.textContent === '导出备份',
    toasts: __toasts.map(t => t.msg),
  };
}
""", 'webdav')
        assert r['testCall']['api'] == 'webdav_test'
        cfg = r['testCfg']
        assert cfg['url'] == 'https://dav.example.com' and cfg['remote_path'] == '/glm-chat-backup'
        assert cfg['conflict_policy'] == 'ask' and cfg['auto_sync'] is False
        assert '✓' in r['testStatus'] and '连接成功' in r['testStatus']   # 成功分支渲染
        assert r['testBtnOk'] and r['exportBtnOk']            # finally 复位（两个按钮）
        assert '已上传 2 个文件' in r['exportStatus']
        assert r['exportCall']['api'] == 'webdav_export' and r['exportCall']['args'] == []

    def test_validation_error_branch(self):
        r = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(api){
      if (api === 'webdav_test') return JSON.stringify({ error: 'URL 必须 https（localhost 除外）' });
      return '""';
    },
  });
  __run(ctx, __fe('37-webdav.js'));
  __doc.getElementById('webdavUrl').value = 'http://insecure.example.com';
  await ctx.webdavTestNow();
  const st = __doc.getElementById('webdavStatus');
  return { status: st.textContent, toasts: __toasts.map(t => ({ msg: t.msg, kind: t.kind })) };
}
""", 'webdav_err')
        assert 'https' in r['status']
        assert r['toasts'][0]['kind'] == 'err'


# ============================================================ v4 port-spec §3 在位性（防回退）
class TestV4PortInPlace:
    """port-spec.md §3 十模块改造 + §2 关键规则在位断言。"""

    def test_js_modules_ported(self):
        checks = {
            # v4 port-spec §3 落地标记（'in-'/'out-' + dir 为 port-spec 原式动态拼接）
            '16-panel-fx.js': ['_panelLeaving', "'out-' + dir", "'in-' + dir", 'MOTION.onAnimEnd'],
            '18-toast.js': ['__closing', "classList.add('out')", 'closing'],
            '10-custom-select.js': ['hiding'],
            '105-context-menu.js': ['hiding'],
            '15-theme.js': ['theming', 'startViewTransition'],
            '90-attachments.js': ['_attachCount', "'enter'"],
            '78-analytics.js': ['MOTION.count()', 'staggerSm'],
            '85-session-mgmt.js': ["classList.add('batch')", 'swapping'],
            '80-utils.js': ["classList.add('out')"],
        }
        for fn, keys in checks.items():
            src = _fe(fn)
            for k in keys:
                assert k in src, '%s 缺少 v4 改造标记: %s' % (fn, k)

    def test_template_v4_rules(self):
        tpl = read_frontend_styles(PROJECT_ROOT)
        for k in ['v4AuroraA', 'v4AuroraB', 'v4Stream', 'v4PanelInFwd', 'v4PanelOutBack',
                  'v4MsgIn', 'v4ToastIn', 'v4ModalIn', 'v4ModalOut', 'v4CtxIn',
                  'v4CsIn', 'v4CsOut', 'v4SetIn', 'v4SetOut', 'v4AttachIn',
                  'v4ToolBreathe', 'v4ToolSettle', 'v4TipIn',
                  '--dur-press', '--dur-micro', '--dur-comp', '--dur-panel',
                  '--dur-ambient', '--dur-sheen', '--ease-out-soft', '--ease-spring',
                  '--stagger-xs', '--shift-panel', 'prefers-reduced-transparency',
                  'au-3{display:none']:
            assert k in tpl, '模板缺少 v4 规则: %s' % k
        # 禁项
        assert 'transition:all' not in tpl
        assert '@keyframes panelIn' not in tpl and '@keyframes fadeInUp' not in tpl
        assert '@keyframes slideDown' not in tpl and '@keyframes indeterminate' not in tpl
        # v2 令牌值未动（抽检）
        assert '--primary:#4560e0' in tpl and '--bg:#f6f7f9' in tpl   # v1.8.0 对比度校准（#4f6ef7→#4560e0，2026-10-21）
        assert '--primary:#6b84ff' in tpl
