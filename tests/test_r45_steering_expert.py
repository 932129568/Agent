# -*- coding: utf-8 -*-
"""R45 门禁：排队式 steering + 专家包三层化（正文预算 + 资源索引）。"""
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
const __ctx = __vm.createContext({ console });
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
    fd, path = tempfile.mkstemp(suffix='.js', prefix='r45_%s_' % name)
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


def test_expert_body_budget_truncates():
    fn = (r"""
  const short = expertPromptBudget('短正文');
  const long = '第一章 决策背景。\\n\\n' + '细节内容。'.repeat(6000) + '\\n\\n第九章 结论。';
  const cut = expertPromptBudget(long);
  return { shortKept: short === '短正文',
           cutLen: cut.length,
           cutHead: cut.indexOf('第一章') >= 0,
           cutMark: cut.indexOf('超出注入预算') >= 0,
           cutTail: cut.indexOf('第九章') >= 0 };
""")
    out = _run(__run_ctx(fn), 'budget')
    assert out['shortKept'], '预算内正文一字不动'
    assert out['cutHead'] and out['cutMark'], '超预算裁剪保留头部+截断声明'
    assert out['cutLen'] <= 16000 + 200, '裁剪后不超预算'
    assert not out['cutTail'], '尾部内容不保留'


def __run_ctx(fn):
    # schemas.js 前置（context.js 引用 expertMessage——跨模块符号）
    return ("__run(__fe('frontend/src/expert/schemas.js'));\n" +
            "__run(__fe('frontend/src/expert/context.js'));\n" +
            "  return __vmEval(`" + fn + "`);")


def test_expert_resource_index_in_context():
    """资源索引常驻（三层化的目录层）；provenance 结构不变。"""
    fn = (r"""
  const snapshot = { id: 'pkg', snapshot_id: 'snap1', metadata: {}, skills: [
    { name: 'deploy', description: '部署流程', path: 'skills/deploy',
      resources: [{ path: 'skills/deploy/references/runbook.md',
                    kind: 'references', size: 4096 }] }] };
  const actor = { agent: { path: 'agents/lead.md', sha256: 'aa' }, text: '短正文' };
  const draft = { text: '任务' };
  const ctx = ActorContext.create({ run: { id: 'r1', sessionId: 's1' },
    snapshot, actor, draft, hostTools: [], hostAllowed: () => true });
  const sys = ctx.messages.filter(m => m.role === 'system')
    .map(m => m.content).join(String.fromCharCode(10));
  return {
    indexRow: sys.indexOf('[skill] deploy · 部署流程') >= 0,
    resRow: sys.indexOf('skills/deploy/references/runbook.md') >= 0,
    bodyIn: sys.indexOf('短正文') >= 0,
    untrusted: ctx.messages.some(m => m.untrusted === true),
  };
""")
    out = _run(__run_ctx(fn), 'index')
    assert out['indexRow'] and out['resRow'], '资源索引必须常驻'
    assert out['bodyIn'], '预算内正文全量'
    assert out['untrusted'], 'UNTRUSTED 标记不变'


def test_steering_queue_wired():
    """sendMessage 排队分支源码契约（queued 标志 + 群聊/专家排除 + 不启动第二 run）。"""
    root = PROJECT_ROOT
    src = open(os.path.join(root, 'frontend', 'src', 'chat', 'send.js'),
               encoding='utf-8').read()
    assert 'sendMessage._queued = true' in src
    assert 'sendMessage._queued = false' in src
    assert '_isGroup' in src and '_expertPending' in src, '群聊/专家须排除'
    assert '已排队：当前工具步骤结束后' in src
    # 主路径 run 启动必须条件化
    assert 'if (sendMessage._queued) {' in src and 'return;\n  }\n  runAgentLoop(s, apiKey);' in src
