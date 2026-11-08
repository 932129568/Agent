# -*- coding: utf-8 -*-
"""R43 harness 级评测集（F2d 改进⑨最小可行）。

selection evals：任务描述 → 断言 routeTools 域选择正确（工具面改动的回归门，
tools_schema/提示词改动必跑）；compact 机器侧回归：compactHistory 分类执行
（决策保留/工具输出截断/read_file 豁免）。模式：test_est_calibration 同款
node vm 单模块沙箱。"""
import json
import os
import subprocess
import sys
import tempfile

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from helpers.frontend import frontend_node_map  # noqa: E402

NODE = r'C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'

_PRELUDE = r"""
const __vm = require('vm');
const __fs = require('fs');
const __store = {};
const __sand = {
  console: console,
  localStorage: { getItem: function(k){ return (k in __store) ? __store[k] : null; },
                  setItem: function(k, v){ __store[k] = String(v); } },
  document: undefined,
};
__sand.window = __sand;
const __ctx = __vm.createContext(__sand);
function __readBundle(rel){ return String(rel).split(',').map(function(r){ return __fs.readFileSync(%r + '/' + r, 'utf8'); }).join('\n'); }
function __fe(name){ return __readBundle(((%r)[name] || name)); }
function __run(code){ __vm.runInContext(code, __ctx, { timeout: 20000 }); }
function __vmEval(fnSrc){ return __vm.runInContext('(function(){' + fnSrc + '})()', __ctx, { timeout: 20000 }); }
""" % (PROJECT_ROOT.replace(os.sep, '/'), frontend_node_map(PROJECT_ROOT),)

_MAIN = r"""
(async () => {
  const res = await (async () => { %s })();
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""


def _run(body, name):
    if not os.path.exists(NODE):
        import pytest
        pytest.skip('node 不可用')
    js = _PRELUDE + (_MAIN % body)
    fd, path = tempfile.mkstemp(suffix='.js', prefix='eval_%s_' % name)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        p = subprocess.run([NODE, path], capture_output=True, timeout=60)
        if p.returncode != 0:
            raise AssertionError('node 失败: %s' % p.stderr.decode('utf-8', 'replace')[-1200:])
        out = p.stdout.decode('utf-8', 'replace').strip()
        return json.loads(out) if out else None
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


# ---------------- selection evals（routeTools 域选择） ----------------
_SELECTION_CASES = [
    # (任务描述, 必须入选的工具, 禁止误判说明)
    ('帮我读取 config.json 看看配置', ['read_file'], '读文件任务'),
    ('把配置里的超时改成 30 秒并保存', ['search_replace', 'write_file'], '改文件任务'),
    ('运行项目测试并告诉我结果', ['run_command'], '命令执行任务'),
    ('截个屏看看当前画面', ['take_screenshot'], '截图任务'),
    ('记住我喜欢用深色主题', ['append_memory'], '记忆写入任务'),
    ('打开 example.com 网页查一下', ['open_url'], '开网页任务'),
    ('系统卡死了，结束那个占用cpu的进程', ['kill_process'], '进程任务'),
    ('', ['read_more'], '空指令兜底（ROUTE_ALWAYS）'),
]


def test_selection_evals_route_domains():
    # 调用点必须在 vm 内（__vmEval）——routeTools 挂 vm ctx global，Node main 不可见
    fn = ("const cases = " + json.dumps(_SELECTION_CASES, ensure_ascii=False) + ";\n"
          " return cases.map(function (c) {\n"
          "  const on = routeTools(c[0], false, [], '');\n"
          "  const missing = c[1].filter(function (n) { return !on.has(n); });\n"
          "  return { task: c[0], missing: missing, domain: c[2] };\n });")
    body = "__run(__fe('frontend/src/agent/router.js'));\n  return __vmEval(`" + fn + "`);"
    out = _run(body, 'selection')
    misses = [x for x in out if x['missing']]
    assert not misses, ('路由选择回归逃逸：', misses)


def test_selection_evals_recent_tools_recalled():
    """TOK-4：短指令「继续」+ 最近调用域 → 域召回（防漏路由）。"""
    body = ("__run(__fe('frontend/src/agent/router.js'));\n"
            "  return __vmEval(`const on = routeTools('继续', false, ['run_command'], '');\n"
            "    return { shell: on.has('run_command') };`);")
    out = _run(body, 'recall')
    assert out['shell'] is True, '最近调用域未被召回（TOK-4 回归）'


# ---------------- compact 机器侧回归（分类执行） ----------------
# 全部断言逻辑跑在 vm 内（__vmEval）——compactHistory/常量挂 vm ctx，
# saveSessions 等外部依赖经 globalThis 显式挂载（compactHistory 的变量解析
# 用定义时作用域=vm global，调用方作用域不可见）。
_COMPACT_BODY = r"""
__run(__fe('frontend/src/agent/compact-command.js'));
return __vmEval(`
let __saved = 0;
globalThis.saveSessions = function(){ __saved++; };
const s = { id: 'eval-sess', messages: [
  { role: 'user', content: '任务：把部署脚本迁移到新目录。决策：统一用 PowerShell。' + '背景补充。'.repeat(400) },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function',
      function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'copy /y ' + 'x'.repeat(400) }) } }] },
  { role: 'tool', __tool: 'run_command', content: ('输出行。').repeat(200) },
  { role: 'tool', __tool: 'read_file', content: ('关键源码行。').repeat(120) },
  { role: 'assistant', content: '结论：迁移完成。' + '废话。'.repeat(600) },
  { role: 'user', content: '好的，继续下一步。' },   // compactHistory 只处理末条 user 之前
] };
compactHistory(s);
const m = s.messages;
return {
  saved: __saved,
  toolTruncated: !!m[2]._compacted && m[2].content.indexOf('已压缩') >= 0,   // summarizeToolResult 摘要文案含「已压缩」
  readFileKept: !m[3]._compacted && m[3].content.indexOf('关键源码行') >= 0,
  userMarked: !!m[0]._compacted,
  decisionKept: m[0].content.indexOf('统一用 PowerShell') >= 0,
  conclusionKept: m[4].content.indexOf('迁移完成') >= 0,
};
`);
"""


def test_compact_machine_side_classification():
    out = _run(_COMPACT_BODY, 'compact')
    assert out['saved'] >= 1, '有变更必须落盘'
    assert out['toolTruncated'], '超长工具结果应截断（分类：已处理输出可弃）'
    assert out['readFileKept'], 'read_file 豁免（文件原文契约）'
    assert out['userMarked'] and out['decisionKept'], '长用户消息截头 1500 且决策句必须保留在前缀'
    assert out['conclusionKept'], '结论句保留'
