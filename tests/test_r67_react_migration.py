# -*- coding: utf-8 -*-
"""R67 · 前端全量迁入 React 的门禁测试。

验收口径（与 tools/verify-react-render.mjs 静态/运行时两层互补）：
1. 模板有 React 根容器与降级宿主，且根容器先于降级宿主；
2. 模板 10 个顶层区域全部生成了独立 JSX 组件；
3. 生成的 300 个 id 覆盖 UI 契约 40 个 DOM id，且与降级宿主零漂移；
4. harbor.html 产物确实携带 React 层与内联事件桥；
5. 真实浏览器渲染验证通过（环境具备时；否则 skip 并说明）。
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / 'frontend' / 'index.template.html'
HTML = ROOT / 'harbor.html'
GEN = ROOT / 'frontend' / 'react' / 'src' / 'generated'
IDS_JSON = GEN / 'ids.json'
VERIFIER = ROOT / 'tools' / 'verify-react-render.mjs'
PLAYWRIGHT = ROOT / 'server' / 'node_modules' / 'playwright-core'

AREAS = ['IconDefs', 'AuroraBg', 'StreamBar', 'Rail', 'Sidebar',
         'SidebarBackdrop', 'MainShell', 'ProjectModal', 'ExpertCenter', 'HubMarket']

NODE_CANDIDATES = [
    r'C:\Users\陈\.workbuddy\binaries\node\versions\22.22.2-6\node.exe',
    r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe',
]
EDGE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
]


def _node():
    for p in NODE_CANDIDATES:
        if os.path.isfile(p):
            return p
    return shutil.which('node')


def _read(path):
    return io.open(str(path), 'r', encoding='utf-8').read()


def _fallback_markup():
    text = _read(TEMPLATE)
    opener = '<template id="harbor-legacy-fallback">'
    assert opener in text, '模板缺少 React 降级宿主'
    start = text.index(opener) + len(opener)
    end = text.index('</template>', start)
    return text[start:end]


def test_react_root_and_fallback_host_present_in_order():
    tpl = _read(TEMPLATE)
    root_at = tpl.index('id="harbor-react-root"')
    fallback_at = tpl.index('id="harbor-legacy-fallback"')
    assert root_at < fallback_at, 'React 根容器必须在降级宿主之前'
    assert 'display:contents' in tpl, '根容器必须 display:contents 以保持 body flex 布局'
    assert tpl.count('<template id="harbor-legacy-fallback">') == 1
    assert tpl.count('</template>') == 1
    # 契约文本仍在模板里（check_contract 读模板，不读运行时 DOM）
    assert 'id="chatContainer"' in tpl and 'id="sendBtn"' in tpl


def test_all_ten_areas_generated_as_jsx_components():
    for name in AREAS:
        path = GEN / (name + '.jsx')
        assert path.is_file(), '缺少区域组件: ' + name
        source = _read(path)
        assert 'export default function %s()' % name in source
        assert 'AUTO-GENERATED' in source, '生成物必须带机器生成标记，禁止手改'
    app = _read(GEN / 'App.jsx')
    for name in AREAS:
        assert "import %s from './%s.jsx'" % (name, name) in app
        assert '<%s />' % name in app


def test_generated_ids_cover_ui_contract():
    sys.path.insert(0, str(ROOT / 'deliverables' / 'design'))
    try:
        import check_contract as cc
    finally:
        sys.path.remove(str(ROOT / 'deliverables' / 'design'))
    data = json.loads(_read(IDS_JSON))
    ids = set(data['ids'])
    assert data['areas'] == AREAS
    assert data['idCount'] == 300
    missing = set(cc.DOM_IDS) - ids
    assert not missing, '契约 DOM id 未全部生成: %s' % sorted(missing)
    # ctxMenu 是运行时动态创建的右键菜单（check_contract.DYNAMIC_IDS），
    # 模板与 JSX 树里本就不存在，由 components/context-menu.js 首次右键时 appendChild。
    assert cc.DYNAMIC_IDS == ['ctxMenu']
    assert 'ctxMenu' not in ids


def test_generated_ids_match_fallback_without_drift():
    """JSX 组件树与降级宿主是同一份结构的两个投影，id 集合必须严格相等。"""
    data = json.loads(_read(IDS_JSON))
    fallback_ids = set(re.findall(r'\bid="([^"]+)"', _fallback_markup()))
    generated = set(data['ids'])
    assert generated == fallback_ids, (
        '两份源漂移: 仅 JSX=%s 仅 fallback=%s'
        % (sorted(generated - fallback_ids)[:10], sorted(fallback_ids - generated)[:10]))


def test_harbor_html_carries_react_layer():
    html = _read(HTML)
    assert 'id="harbor-react-root"' in html
    assert 'id="harbor-legacy-fallback"' in html
    assert 'data-h-events' in html, '内联事件桥未进入构建产物'
    iife = _read(ROOT / 'frontend' / 'react' / 'dist' / 'harbor-island.iife.js')
    assert 'harbor-react-root' in iife
    assert 'legacyEventCount' in iife
    assert 'legacy-fallback' in iife, '缺少挂载失败降级路径'


def test_runtime_react_render_in_real_browser():
    node = _node()
    if not node or not PLAYWRIGHT.is_dir() or not any(os.path.isfile(p) for p in EDGE_CANDIDATES):
        pytest.skip('缺少 node / playwright-core / Edge-Chrome，跳过真实浏览器验收')
    proc = subprocess.run([node, str(VERIFIER)], cwd=str(ROOT), capture_output=True,
                          text=True, encoding='utf-8', errors='replace', timeout=180)
    if proc.returncode == 2:
        pytest.skip('浏览器启动受环境限制（Edge 单实例/DevTools profile）：'
                    + (proc.stderr or '')[-300:])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert 'FAIL' not in proc.stdout, proc.stdout
    assert re.search(r'(\d+)/\1 通过', proc.stdout), '未找到全通过汇总'
