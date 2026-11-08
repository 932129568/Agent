# -*- coding: utf-8 -*-
"""Harbor v1.6 修复回归（HF-1）：system 消息归一化。

用户实测（本地模式 Ollama + qwen3.5-9b 发「你好」）：
    HTTP 500: Jinja Exception: System message must be at the beginning

根因链路（已确认）：
1. ``frontend/src/chat/send.js`` 首轮会话把【工作日志】以 ``role:'system'``
   **追加到历史末尾**（``s.messages.push(...)``）；
2. ``frontend/src/agent/run-controller.js`` 组请求时 ``[system(系统提示词), ...slimMsgs]``，
   slimMsgs 里带着那条末尾 system；
3. 发给 Ollama 的 messages 形如 ``[system, user, system]`` → Qwen 的 chat template
   （要求所有 system 在最前、通常只允许一条）直接 raise → HTTP 500。

修复：``normalizeSystemMessages(msgs)``（定义在 ``frontend/src/agent/context.js``）
把所有 system 按相对顺序用 ``'\\n\\n'`` 合并成一条置于数组最前；0/1 条 system 时
原样返回（零行为变化）。三处接线：60-agent-loop 主请求（根因点）、
45-request-debounce ``fetchGLMStream`` 最后一道闸（幂等，覆盖所有流式请求）、
97-compact 压缩请求（``typeof`` 守卫接线：正常构建生效，单模块沙箱自动跳过）。

本文件用现有 node vm 沙箱 harness（同 test_connect_merge.py / test_review_fixes.py
的 ``_run_node`` / ``__fe`` 口径）实测 JS 行为，并做静态接线校验。
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from helpers.frontend import (LEGACY_SCRIPT_PATHS, frontend_node_map,
                              read_frontend_source, script_paths)

from helpers.frontend import read_frontend_source
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
BUILT_HTML = os.path.join(PROJECT_ROOT, 'harbor.html')


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _src(rel):
    return io.open(os.path.join(PROJECT_ROOT, rel), encoding='utf-8').read()


# ============================================================ node vm 沙箱
# 30-history-shrink.js 是纯函数模块（顶层无 DOM 访问），只需最小沙箱。
_JS_PRELUDE = r"""
const __fs = require('fs');
const __vm = require('vm');
function __mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {},
    children: [], value: '', checked: false,
    classList: { _s: new Set(), add: function(c){ this._s.add(c); },
      remove: function(c){ this._s.delete(c); },
      contains: function(c){ return this._s.has(c); } },
    _html: '', _text: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    appendChild: function(c){ this.children.push(c); return c; },
    remove: function(){},
    querySelector: function(sel){ this._q = this._q || {};
      if (!this._q[sel]) this._q[sel] = __mkEl(sel); return this._q[sel]; },
    querySelectorAll: function(){ return []; },
    removeAttribute: function(){}, setAttribute: function(){}, hasAttribute: function(){ return false; },
  };
  return el;
}
const __byId = {};
const __doc = {
  body: __mkEl('body'),
  getElementById: function(id){ if (!__byId[id]) { const n = __mkEl('#' + id); n.id = id; __byId[id] = n; }
    return __byId[id]; },
  createElement: function(t){ return __mkEl(t); },
};
function __ctx(extra) {
  const sand = Object.assign({ document: __doc, console: console }, extra || {});
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
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_hf_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([NODE, path], capture_output=True, text=True,
                           timeout=120, encoding='utf-8', errors='replace')
        assert p.returncode == 0, 'node 失败:\n%s\n%s' % (p.stderr, p.stdout)
        out = p.stdout.strip()
        return json.loads(out) if out else None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# 装载待测模块并把 normalizeSystemMessages 提到 globalThis（const 声明不挂沙箱）
_JS_LOAD = r"""
function __load() {
  const ctx = __ctx({});
  __run(ctx, __fe('30-history-shrink.js'));
  __run(ctx, 'globalThis.__n = normalizeSystemMessages;');
  return ctx;
}
"""


# ============================================================ 1) 纯函数行为
_JS_NORMALIZE = _JS_LOAD + r"""
async function __main() {
  const ctx = __load();
  const n = ctx.__n;
  const out = {};

  // ① 多 system（首条系统提示词 + 末尾【工作日志】）→ 合并成一条置于最前
  const multi = [
    { role: 'system', content: '系统提示词 A' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
    { role: 'system', content: '【工作日志】\n上次做了 X' },
    { role: 'user', content: '继续' },
  ];
  const r1 = n(multi);
  out.multi = {
    roles: r1.map(m => m.role),
    first: r1[0].content,
    firstRole: r1[0].role,
    systemCount: r1.filter(m => m.role === 'system').length,
    // 其余消息相对顺序不变（user/assistant/user 依次）
    restRoles: r1.slice(1).map(m => m.role),
    restTexts: r1.slice(1).map(m => (typeof m.content === 'string' ? m.content : '[arr]')),
    len: r1.length,
    srcUntouched: multi.length === 5 && multi[0].content === '系统提示词 A'
      && multi[3].role === 'system',
  };

  // ② 单 system → 原样返回（引用相同，零行为变化）
  const one = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }];
  const r2 = n(one);
  out.one = { sameRef: r2 === one, len: r2.length, first: r2[0].content };

  // ③ 无 system → 原样返回（引用相同）
  const none = [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
  const r3 = n(none);
  out.none = { sameRef: r3 === none, len: r3.length };

  // ④ 空白 system 被跳过（不产生空 system）
  const blankMid = [
    { role: 'system', content: '   ' },
    { role: 'user', content: 'u' },
    { role: 'system', content: '\n\t ' },
    { role: 'system', content: '真内容 B' },
  ];
  const r4 = n(blankMid);
  out.blank = { first: r4[0].content, len: r4.length,
                hasEmpty: r4.some(m => m.role === 'system' && !String(m.content || '').trim()) };

  // ⑤ 全部 system 均为空白 → 整条丢弃（连空壳 system 都不留）
  const allBlank = [
    { role: 'system', content: '  ' },
    { role: 'user', content: 'u' },
    { role: 'system', content: '' },
  ];
  const r5 = n(allBlank);
  out.allBlank = { len: r5.length, systemCount: r5.filter(m => m.role === 'system').length,
                   roles: r5.map(m => m.role) };

  // ⑥ 幂等：归一化后再归一化结果等价
  const r6a = n(multi);
  const r6b = n(r6a);
  out.idempotent = JSON.stringify(r6a) === JSON.stringify(r6b);

  // ⑦ 三条 system 按原相对顺序拼接（顺序不打乱）
  const three = [
    { role: 'system', content: '1' },
    { role: 'system', content: '2' },
    { role: 'user', content: 'u' },
    { role: 'system', content: '3' },
  ];
  out.three = n(three)[0].content;

  // ⑧ 多模态（part 数组）system：只取文本部分拼接
  const arrSys = [
    { role: 'system', content: [{ type: 'text', text: 'P1' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'user', content: 'u' },
    { role: 'system', content: 'P2' },
  ];
  out.arrSys = n(arrSys)[0].content;

  // ⑨ 非数组 / 空数组：安全返回，不抛
  out.safe = {
    nullish: n(null) === null,
    undef: n(undefined) === undefined,
    emptyLen: n([]).length,
  };

  // ⑩ 合并保留首条 system 的附加字段（如 usage 元数据不丢）
  const withMeta = [
    { role: 'system', content: 'S1', usage: { prompt_tokens: 7 } },
    { role: 'user', content: 'u' },
    { role: 'system', content: 'S2' },
  ];
  const r10 = n(withMeta);
  out.meta = { usage: r10[0].usage, content: r10[0].content };

  return out;
}
"""


class TestNormalizeSystemMessages:
    """``normalizeSystemMessages`` 纯函数契约（HF-1 核心）。"""

    def test_multi_system_merged_to_front(self):
        """首条 system + 末尾【工作日志】→ 单条 system 置顶，其余无 system（500 的直接病因）。"""
        r = _run_node(_JS_NORMALIZE, 'multi')['multi']
        assert r['firstRole'] == 'system'
        assert r['systemCount'] == 1, '合并后只允许一条 system（Qwen 模板约束）'
        assert r['first'] == '系统提示词 A\n\n【工作日志】\n上次做了 X', r['first']
        assert r['restRoles'] == ['user', 'assistant', 'user'], '其余消息相对顺序必须保持'
        assert r['restTexts'] == ['你好', '你好呀', '继续']
        assert r['len'] == 4
        assert r['srcUntouched'] is True, '不得修改入参数组（发送副本语义）'

    def test_single_system_unchanged(self):
        """单 system → 引用相同的原数组（零行为变化）。"""
        r = _run_node(_JS_NORMALIZE, 'one')['one']
        assert r['sameRef'] is True and r['len'] == 2 and r['first'] == 'S'

    def test_no_system_unchanged(self):
        """无 system → 引用相同的原数组（零行为变化）。"""
        r = _run_node(_JS_NORMALIZE, 'none')['none']
        assert r['sameRef'] is True and r['len'] == 2

    def test_blank_system_skipped(self):
        """空白 system 跳过，合并结果不含空 system。"""
        r = _run_node(_JS_NORMALIZE, 'blank')['blank']
        assert r['first'] == '真内容 B'
        assert r['len'] == 2
        assert r['hasEmpty'] is False

    def test_all_blank_system_dropped(self):
        """全空白 system → 整条丢弃，不留空壳。"""
        r = _run_node(_JS_NORMALIZE, 'allBlank')['allBlank']
        assert r['systemCount'] == 0
        assert r['roles'] == ['user']
        assert r['len'] == 1

    def test_idempotent(self):
        """幂等：重复归一化结果不变（fetchGLMStream 二次过闸依赖）。"""
        assert _run_node(_JS_NORMALIZE, 'idempotent')['idempotent'] is True

    def test_three_system_relative_order(self):
        """三条 system 按原相对顺序拼接。"""
        assert _run_node(_JS_NORMALIZE, 'three')['three'] == '1\n\n2\n\n3'

    def test_multimodal_system_text_parts(self):
        """part 数组形式的 system 只取文本部分。"""
        assert _run_node(_JS_NORMALIZE, 'arrSys')['arrSys'] == 'P1\n\nP2'

    def test_non_array_safe(self):
        """非数组入参安全返回（防御降级路径）。"""
        r = _run_node(_JS_NORMALIZE, 'safe')['safe']
        assert r == {'nullish': True, 'undef': True, 'emptyLen': 0}

    def test_keeps_first_system_meta(self):
        """合并保留首条 system 的附加字段（usage 等元数据不丢）。"""
        r = _run_node(_JS_NORMALIZE, 'meta')['meta']
        assert r['usage'] == {'prompt_tokens': 7}
        assert r['content'] == 'S1\n\nS2'


# ============================================================ 2) 发送体形状（端到端仿真）
_JS_SEND_BODY = _JS_LOAD + r"""
async function __main() {
  const ctx = __load();
  const n = ctx.__n;

  // 复刻生产路径：首轮会话 s.messages 末尾追加【工作日志】system（100-send.js:25）
  // + 主请求组 reqMsgs（60-agent-loop.js:157 原写法）
  const sMessages = [
    { role: 'system', content: '【工作日志】\n上次改了 a.txt\n（来自 _glm_worklog.md，供延续上下文）' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀，有什么可以帮你？' },
    { role: 'user', content: '继续' },
  ];
  const sysContent = 'EFFICIENCY_PROMPT\n\n后端 build_system_prompt';
  const slimMsgs = sMessages.map(m => ({ role: m.role, content: m.content }));
  const reqMsgs = n([{ role: 'system', content: sysContent }, ...slimMsgs]);
  const body = JSON.stringify({ model: 'qwen3.5-9b', messages: reqMsgs, stream: true });

  // Qwen 模板的硬约束模拟：第一条必须是 system（如有），且之后不允许再出现 system
  const parsed = JSON.parse(body);
  const roles = parsed.messages.map(m => m.role);
  const sysIdxs = roles.reduce((acc, r, i) => (r === 'system' ? acc.concat(i) : acc), []);

  return {
    roles: roles,
    sysIdxs: sysIdxs,
    firstContent: parsed.messages[0].content,
    // 模拟 Ollama 的模板检查：system 只能出现在开头
    templateOk: sysIdxs.every(i => i === 0),
    bodyHasWorklog: parsed.messages[0].content.indexOf('【工作日志】') > 0,
  };
}
"""


class TestSendBodyShape:
    """发送体形状：真实历史（末尾 worklog system）经归一化后满足 Qwen 模板约束。"""

    def test_request_body_has_single_leading_system(self):
        r = _run_node(_JS_SEND_BODY, 'body')
        assert r['sysIdxs'] == [0], 'system 只允许出现在下标 0（否则 Ollama Jinja 500）：%r' % (r['roles'],)
        assert r['templateOk'] is True
        assert r['roles'] == ['system', 'user', 'assistant', 'user'], r['roles']
        assert r['firstContent'].startswith('EFFICIENCY_PROMPT')
        assert r['bodyHasWorklog'] is True, '工作日志内容不能丢，必须并入首条 system'


# ============================================================ 3) 接线（静态校验）
class TestNormalizeWiring:
    """所有构造 messages 的地方都必须过归一化（HF-1 普适性要求）。"""

    def test_helper_defined_in_history_shrink(self):
        code = _fe('30-history-shrink.js')
        assert 'function normalizeSystemMessages(msgs)' in code
        assert 'normalizeSystemMessages(' in code

    def test_agent_loop_uses_normalize(self):
        code = _fe('60-agent-loop.js')
        assert 'normalizeSystemMessages([{ role: \'system\', content: sysContent }, ...slimMsgs])' in code
        # 原始裸拼接不得残留（防回退）
        assert "const reqMsgs = [{ role: 'system', content: sysContent }, ...slimMsgs];" not in code

    def test_fetch_choke_point_uses_normalize(self):
        code = _fe('45-request-debounce.js')
        assert 'normalizeSystemMessages(body.messages)' in code

    def test_compact_request_never_sends_system(self):
        """压缩请求只发一条 user（无 system）；归一化以 typeof 守卫接线（未来加 system 也不漏 500）。

        typeof 守卫：正常构建（同 <script> 作用域）归一化生效；node vm 单模块沙箱
        （只加载 97-compact.js）下函数未定义 → typeof 不抛 ReferenceError，自动跳过，
        既有单模块沙箱用例（test_s21 / test_backup_and_restore）保持可用。
        """
        code = _fe('97-compact.js')
        assert "role: 'system'" not in code, '压缩请求不得直接构造 system（应由归一化吸收）'
        assert "messages: [{ role: 'user'" in code
        assert "if (typeof normalizeSystemMessages === 'function') {" in code, \
            '97-compact 必须以 typeof 守卫接线归一化（未来防呆，防被改成 [system, user] 后 500）'
        assert '_cmpBody.messages = normalizeSystemMessages(_cmpBody.messages);' in code

    def test_all_messages_builders_covered(self):
        """全库发送体构造点：有 system 的必须过归一化；无 system 的保持纯 user。"""
        covered = {
            '60-agent-loop.js': 'messages: reqMsgs',   # reqMsgs 由 normalizeSystemMessages 产出
            '45-request-debounce.js': 'normalizeSystemMessages(body.messages)',
            # v1.8.0 M3 计划生成：planMsgs 由 normalizeSystemMessages 产出（同 reqMsgs 模式）
            '100-send.js': 'const planMsgs = normalizeSystemMessages(',
            # builder 只组装，transport 在发送前统一 normalizeSystemMessages。
            'request-builder.js': 'messages: options.messages',
            # Round 14 群聊成员发言体：typeof 守卫归一化（单模块沙箱缺依赖自动跳过）
            'group.js': "messages: (typeof normalizeSystemMessages === 'function') ? normalizeSystemMessages(convo) : convo",
        }
        for name, needle in covered.items():
            assert needle in _fe(name), '%s 未按约定接线: 期待 %r' % (name, needle)
        # 其余模块（会话存储/会话创建等，字段名恰好叫 messages；97-compact 是纯 user 压缩请求）
        not_send_body = {'65-session-store.js', '85-session-mgmt.js', '97-compact.js'}
        new_to_legacy = {new: old for old, new in LEGACY_SCRIPT_PATHS.items()}
        # R29：controller.js 已拆出前置子模块，同族文件里的「会话创建」构造点
        # 语义不变（非发送体），用 family_paths 自动覆盖，避免手工补白名单。
        from helpers.frontend import family_paths
        controller_family = {
            p.rsplit('/', 1)[-1]
            for p in family_paths(PROJECT_ROOT, 'frontend/src/sessions/controller.js')
        }
        for name in script_paths(PROJECT_ROOT):
            short_name = name.rsplit('/', 1)[-1]
            legacy_name = new_to_legacy.get(name, short_name)
            if (legacy_name in covered or legacy_name in not_send_body
                    or short_name in controller_family):
                continue
            for lineno, line in enumerate(_fe(name).splitlines(), 1):
                assert 'messages:' not in line, (
                    '%s:%d 新增发送体构造点，必须过 normalizeSystemMessages：%s'
                    % (name, lineno, line.strip()))

    def test_built_html_contains_helper(self):
        if not os.path.isfile(BUILT_HTML):
            pytest.skip('先运行 node frontend/build.js')
        html = io.open(BUILT_HTML, encoding='utf-8').read()
        assert 'function normalizeSystemMessages(msgs)' in html
        assert html.count('normalizeSystemMessages(') >= 3, '构建产物里应含定义 + 2 处调用'


# ============================================================ 4) 旧版文件清理守卫
class TestLegacyArtifactsRemoved:
    """任务 B 守卫：旧名产物不得回流（用户明确要求「不需要旧东西」）。

    注意：``main_v1.0.0_legacy.py`` 是契约差分基线，**必须保留**。
    """

    def test_old_named_artifacts_absent(self):
        for rel in ('dist/GLM-Chat.exe', 'glm-chat.v1.0.0.html',
                    'glm-chat.html', 'glm-chat.ico'):
            assert not os.path.exists(os.path.join(PROJECT_ROOT, rel)), \
                '旧版产物残留: %s' % rel

    def test_legacy_baseline_kept(self):
        assert os.path.isfile(os.path.join(PROJECT_ROOT, 'main_v1.0.0_legacy.py'))

    def test_harbor_artifacts_present(self):
        for rel in ('harbor.html', 'Harbor.spec', 'harbor.ico', 'main.py'):
            assert os.path.isfile(os.path.join(PROJECT_ROOT, rel)), '缺少 %s' % rel


# ============================================================ 5) QA 补测（边界补强）
_JS_NORMALIZE_EXTRA = _JS_LOAD + r"""
async function __main() {
  const ctx = __load();
  const n = ctx.__n;

  // ① 单条 system 但在**末尾**：契约要求「0/1 条零行为变化」——不得重排、同一引用
  const oneTail = [{ role: 'user', content: 'u' }, { role: 'system', content: 'S' }];
  const r1 = n(oneTail);

  // ② 非数组（字符串/数字/对象）原样返回，不抛
  const r2 = { str: n('abc'), num: n(7), obj: n({ role: 'system' }) };

  // ③ 入参深比较未变（防原地改写调用方历史）
  const src = [
    { role: 'system', content: 'S1' },
    { role: 'user', content: 'U' },
    { role: 'system', content: 'S2' },
  ];
  const snapshot = JSON.stringify(src);
  n(src);

  // ④ 空数组：安全，长度为 0
  // ⑤ 全部消息都是空白 system（无其它消息）→ 丢弃后为空数组（记录行为，UI 不可达）
  const onlyBlank = n([{ role: 'system', content: '  ' }, { role: 'system', content: '' }]);

  // ⑥ 合并后【工作日志】原样保留在首条 system 内（是「吸收」不是「删除」）
  const worklog = n([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '你好' },
    { role: 'system', content: '【工作日志】\n上次改了 a.txt' },
  ]);

  return {
    oneTailSameRef: r1 === oneTail,
    oneTailRoles: r1.map(m => m.role),
    nonArray: { str: r2.str, num: r2.num },
    srcUntouched: JSON.stringify(src) === snapshot,
    emptyLen: n([]).length,
    onlyBlankLen: onlyBlank.length,
    worklogKept: worklog.length === 2 && worklog[0].content === 'SYS\n\n【工作日志】\n上次改了 a.txt',
  };
}
"""


class TestNormalizeSystemMessagesEdgeCases:
    """QA 独立补测：工程师用例未覆盖的边界（末尾单 system / 非数组标量 / 深比较 / 空数组）。"""

    def test_single_trailing_system_not_reordered(self):
        """单条 system 在末尾时不得重排，且返回同一引用（零行为变化契约）。"""
        r = _run_node(_JS_NORMALIZE_EXTRA, 'edge')
        assert r['oneTailSameRef'] is True, '单条 system 必须返回入参引用（不得重排/复制）'
        assert r['oneTailRoles'] == ['user', 'system'], \
            '单条 system 不得被搬到开头（契约：0/1 条零行为变化）'

    def test_scalar_non_array_passthrough(self):
        """字符串/数字等标量入参原样返回（防御降级路径）。"""
        r = _run_node(_JS_NORMALIZE_EXTRA, 'edge')['nonArray']
        assert r['str'] == 'abc' and r['num'] == 7

    def test_input_array_deep_unchanged(self):
        """归一化不得就地修改入参（发送副本/历史语义依赖）。"""
        assert _run_node(_JS_NORMALIZE_EXTRA, 'edge')['srcUntouched'] is True

    def test_empty_array_safe(self):
        """空数组返回空数组。"""
        assert _run_node(_JS_NORMALIZE_EXTRA, 'edge')['emptyLen'] == 0

    def test_only_blank_system_yields_empty(self):
        """全是空白 system 且无其它消息 → 结果为空数组（记录现状：UI 不可达的退化路径）。"""
        assert _run_node(_JS_NORMALIZE_EXTRA, 'edge')['onlyBlankLen'] == 0

    def test_worklog_absorbed_not_deleted(self):
        """【工作日志】被并入首条 system，内容完整保留（吸收 ≠ 删除）。"""
        assert _run_node(_JS_NORMALIZE_EXTRA, 'edge')['worklogKept'] is True


# ============================================================ 6) 源头未被删除（回归守卫）
class TestWorklogSourcePreserved:
    """根因点必须仍在（修复是「归一化吸收」，不是「删掉工作日志注入」）。"""

    def test_worklog_injection_still_present(self):
        code = _fe('100-send.js')
        assert "s.messages.push({ role: 'system', content:" in code, \
            '100-send.js 的【工作日志】注入不得被删（应由 normalizeSystemMessages 吸收）'
        assert '【工作日志】' in code
        assert 'worklogInjected' in code

    def test_built_html_helper_matches_source(self):
        """构建产物里的归一化函数体与源文件逐字一致（防 exe 内嵌旧版）。"""
        if not os.path.isfile(BUILT_HTML):
            pytest.skip('先运行 node frontend/build.js')
        src = _fe('30-history-shrink.js')
        start = src.index('function normalizeSystemMessages(msgs)')
        end = src.index('function applyShrinkMarkers', start)
        body = src[start:end].rstrip()
        html = io.open(BUILT_HTML, encoding='utf-8').read()
        assert body in html, '构建产物中的 normalizeSystemMessages 与源文件不一致'



class TestSystemPromptWsGate:
    """修复（2026-10-18）：工作区关闭时 build_system_prompt 不得注入路径/宣称文件能力。

    用户实测：快捷条显示「未启用工作区」，AI 仍答「当前工作区: ...\glm」并声称能操作
    文件夹（build_tools 已按 ws_enabled 裁剪，prompt 层却没跟上）。
    """

    def _api(self):
        from backend.api import Api
        return Api()

    def test_disabled_ws_prompt_has_no_path(self):
        api = self._api()
        api.set_ws_enabled('', False)
        out = api.build_system_prompt()
        assert '未启用工作区' in out
        assert '当前工作区: ' not in out, '关闭后不得再注入工作区路径'

    def test_disabled_prompt_no_file_claim(self):
        api = self._api()
        api.set_ws_enabled('', False)
        out = api.build_system_prompt()
        assert '不要主动列出/创建/修改文件或文件夹' in out

    def test_enabled_ws_prompt_keeps_path(self):
        api = self._api()
        api.set_ws_enabled('', True)
        out = api.build_system_prompt()
        assert '当前工作区: ' in out
        assert '未启用工作区' not in out

    def test_prompt_differs_between_states(self):
        api = self._api()
        api.set_ws_enabled('', True)
        on = api.build_system_prompt()
        api.set_ws_enabled('', False)
        off = api.build_system_prompt()
        assert on != off


class TestStopButtonImmediate:
    """修复（2026-10-18）：点暂停未立即生效——原 abort 只中止 fetch，
    工具执行阶段（同步 RPC）不受影响，工具批次与后续轮次照跑。

    修复 = userStopped 标志 + 主循环轮次检查 + 工具批检查 + 按钮即时反馈。
    """

    def test_source_has_user_stopped_flag(self):
        src = read_frontend_source(PROJECT_ROOT, 'frontend/src/agent/run-controller.js')
        assert 'let userStopped = false;' in src
        assert 'userStopped = true;' in src

    def test_loop_checkpoints(self):
        src = read_frontend_source(PROJECT_ROOT, 'frontend/src/agent/run-controller.js')
        checkpoint = 'if (userStopped || !agentRunCurrent(run))'
        assert checkpoint + " return { stop: true, finished: true, status: 'cancelled' };" in src, \
            'beforeRound 轮次检查点缺失'
        assert checkpoint + ' break;' in src, '工具批检查点缺失'

    def test_button_immediate_feedback(self):
        src = read_frontend_source(PROJECT_ROOT, 'frontend/src/agent/run-controller.js')
        # 点击即置位 + 立即按钮态 + toast（run.stopHandler 支持切回会话时复用）
        i = src.find('run.stopHandler = () => {')
        assert i > 0
        assert 'sendBtn.onclick = run.stopHandler;' in src
        seg = src[i:i + 500]
        assert 'userStopped = true;' in seg
        assert "setSendButtonVisual(sendBtn, 'pause')" in seg
        assert '正在停止' in seg

    def test_build_contains_flags(self):
        html = open('harbor.html', encoding='utf-8').read()
        assert 'let userStopped = false;' in html
        assert '⏸ 已停止' in html
