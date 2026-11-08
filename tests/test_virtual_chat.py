# -*- coding: utf-8 -*-
"""R26 遗留 #4：长会话虚拟列表 + 搜索跳转重设计。

验收口径：
1. 窗口算法：按高度前缀和求 [start,end)，边界不外溢，随滚动单调右移；
2. 启用条件：群聊（气泡按 .message 逐条对位）与短会话一律不虚拟化；
3. 接线：renderChatHistory 挂载虚拟列表；search.js 在节点未产出时按索引
   驱动虚拟窗口（不再依赖 data-midx 节点常驻），并保留原兜底；
4. manifest：新顶层符号已登记（lint 门禁）。
"""
import json
import shutil
from pathlib import Path

import pytest

from helpers.frontend import family_paths, read_frontend_source
ROOT = Path(__file__).resolve().parent.parent
CTRL = ROOT / 'frontend' / 'src' / 'sessions' / 'controller.js'
SEARCH = ROOT / 'frontend' / 'src' / 'sessions' / 'search.js'
MANIFEST = ROOT / 'frontend' / 'manifest.json'

NODE_FALLBACK = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'

_PRELUDE = r"""
const vm = require('vm'), fs = require('fs');
const SRC = %s;
const src = SRC.split(',').map(function(r){ return fs.readFileSync(r, 'utf8'); }).join('\n');
function mkEl() {
  return { style:{}, dataset:{}, className:'', children:[], offsetHeight:0,
    clientHeight:600, scrollTop:0,
    appendChild: function(n){ this.children.push(n); return n; },
    removeChild: function(n){ const i=this.children.indexOf(n); if(i>=0) this.children.splice(i,1); },
    remove: function(){}, querySelector: function(){ return null; },
    addEventListener: function(){}, removeEventListener: function(){} };
}
const ctx = vm.createContext({
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: { createElement: function(){ return mkEl(); },
              getElementById: function(){ return null; } },
  window: {}, toast: function(){}, escapeHtml: function(s){ return String(s); },
});
vm.runInContext(src, ctx, { timeout: 30000 });
/* 测试 body 与源码必须在同一 vm context 中执行，才能取到函数声明 */
ctx.mkEl = mkEl;
"""


def _vm(body):
    node = shutil.which('node') or NODE_FALLBACK
    if not Path(node).exists():
        pytest.skip('node 不可用')
    fam = family_paths(str(ROOT), 'frontend/src/sessions/controller.js')
    src_arg = ','.join(str(ROOT / q).replace('\\', '/') for q in fam)
    js = (_PRELUDE % json.dumps(src_arg)) + \
         '\nvm.runInContext(' + json.dumps(body) + ', ctx, { timeout: 30000 });'
    proc = subprocess_run(node, js)
    if proc.returncode != 0:
        raise AssertionError('node vm 失败: ' + proc.stderr[-1200:])
    out = proc.stdout.strip()
    return json.loads(out) if out else None


def subprocess_run(node, js):
    import subprocess
    import tempfile
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_virtual_')
    with __import__('os').fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        return subprocess.run([node, path], capture_output=True, text=True,
                              timeout=60, encoding='utf-8', errors='replace')
    finally:
        try:
            __import__('os').remove(path)
        except OSError:
            pass


def test_virtual_window_range_bounds_and_monotonic():
    result = _vm(r"""
const n = 100, h = 40, prefix = [0];
for (let i = 0; i < n; i++) prefix.push(prefix[i] + h);
const a = virtualChatWindowRange(prefix, 0, 600, 6);
const b = virtualChatWindowRange(prefix, 2000, 600, 6);
const c = virtualChatWindowRange(prefix, 4000, 600, 6);
const e = virtualChatWindowRange([0], 0, 600, 6);
console.log(JSON.stringify({a:a, b:b, c:c, e:e, n:n}));
""")
    for key in ('a', 'b', 'c'):
        win = result[key]
        assert 0 <= win['start'] < win['end'] <= result['n'], (key, win)
    assert result['a']['start'] == 0
    assert result['a']['start'] <= result['b']['start'] <= result['c']['start']
    assert result['a']['end'] <= result['b']['end'] <= result['c']['end']
    assert result['e'] == {'start': 0, 'end': 0}


def test_virtual_mount_excludes_group_and_short_sessions():
    result = _vm(r"""
function mkBox(count) {
  const b = mkEl();
  b.children = [];
  for (let i = 0; i < count; i++) {
    const r = mkEl(); r.offsetHeight = 40; r.dataset.midx = String(i);
    b.children.push(r);
  }
  return b;
}
const groupBox = mkBox(130);
const shortBox = mkBox(10);
const longBox = mkBox(130);
const rGroup = virtualChatMount(groupBox, {group:{members:[{name:'A'}]}});
const rShort = virtualChatMount(shortBox, {});
const rLong = virtualChatMount(longBox, {});
console.log(JSON.stringify({
  group: rGroup, short: rShort,
  active: virtualChatActive(longBox),
  jumped: virtualChatJumpToIndex(longBox, 60),
  scrollTop: longBox.scrollTop,
  mountedRows: longBox.children.filter(function(c){ return c.dataset.midx !== undefined; }).length,
  totalRows: 130,
}));
""")
    assert result['group'] is None, '群聊必须排除虚拟化（气泡逐条对位）'
    assert result['short'] is None, '短会话不应启用虚拟列表'
    assert result['active'] is True
    assert result['jumped'] is True
    assert result['scrollTop'] > 0
    # 虚拟窗口只挂载视口附近的行，远少于全量 130 行
    assert result['mountedRows'] < result['totalRows'], result


def test_controller_and_search_wiring():
    ctrl = read_frontend_source(str(ROOT), 'frontend/src/sessions/controller.js')
    search = SEARCH.read_text(encoding='utf-8')
    assert 'virtualChatMount(box, s)' in ctrl
    assert 'if (s && s.group) return null' in ctrl
    assert 'box.__upgradeInView = upgradeInView' in ctrl
    assert 'virtualChatJumpToIndex(vb, midx)' in search
    assert 'virtualTries < 3' in search
    assert "box.scrollTop = box.scrollHeight" in search   # 原兜底仍在


def test_manifest_declares_virtual_symbols():
    data = json.loads(MANIFEST.read_text(encoding='utf-8'))
    fam = set(family_paths(str(ROOT), 'frontend/src/sessions/controller.js'))
    provided = set()
    for e in data['scripts']:
        if e['path'] in fam:
            provided.update(e['provides'])
    for sym in ('virtualChatActive', 'virtualChatJumpToIndex',
                'virtualChatMount', 'virtualChatWindowRange'):
        assert sym in provided, sym
    search_entry = next(e for e in data['scripts']
                        if e['path'] == 'frontend/src/sessions/search.js')
    # search.js 在 controller.js 之前加载，虚拟符号不能列为前置 requires；
    # 运行时靠 typeof 守卫 + 拼接后函数声明提升（项目既有可选依赖模式）。
    assert 'virtualChatActive' not in search_entry['requires']
    assert "typeof virtualChatActive === 'function'" in SEARCH.read_text(encoding='utf-8')
