# -*- coding: utf-8 -*-
"""v1.6 T12 MCP resources UI tab 回归实证（前端部分）。

覆盖 29-mcp.js 详情弹层「资源」tab（方案 §5 T12 的 UI 部分）：
- tab 结构：详情页双 tab（工具与档位 / 资源），新 id 全唯一，UI 契约只增不改
- 列表渲染：mcp_list_resources → uri + name + mimeType；supported=false 人话降级
- 读取：text 类展开（截断保护）/ blob 类落盘提示 + 打开目录 / 失败 toast 人话
- 订阅：checkbox 变更即调 mcp_save_subscriptions 持久化 resourceSubs，失败回弹
- 顶部说明行：「已订阅 N 个资源将注入对话上下文」

铁律：只调批次 2 已就绪的三个 js_api（mcp_list_resources/mcp_read_resource/
mcp_save_subscriptions），不新增后端方法；新 id/类名纯增量。
"""
import io
import os
import re

import pytest

from helpers.frontend import read_frontend_source, read_frontend_template_with_styles

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
TPL = os.path.join(PROJECT_ROOT, 'frontend', 'index.template.html')

# 复用批次 1 的 vm harness（同 tests 目录，pytest prepend 导入模式可达）
from test_v16_batch1 import _run_node


def _fe(name):
    return read_frontend_source(PROJECT_ROOT, name)


def _tpl():
    return read_frontend_template_with_styles(PROJECT_ROOT)


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


# ============================================================ 源码/契约层
class TestT12ResourcesUiSource:
    """T12 UI：tab 结构、js_api 接线、契约纯增量（源码级锁定）。"""

    def test_detail_tabs_and_new_ids_unique(self):
        src = _fe('29-mcp.js')
        # 双 tab 与两个 pane（动态模态内 id，每次打开唯一）
        assert 'id="mcpTabTools"' in src and 'id="mcpTabRes"' in src
        assert 'id="mcpPaneTools"' in src and 'id="mcpPaneRes"' in src
        for nid in ('mcpTabTools', 'mcpTabRes', 'mcpPaneTools', 'mcpPaneRes'):
            assert src.count('id="%s"' % nid) == 1, '动态 id 不得重复: ' + nid
            # 新 id 不得与静态模板既有 id 撞车（UI 契约只增不改）
            assert ('id="%s"' % nid) not in _tpl(), '新 id 泄漏进静态模板: ' + nid
        assert '实现 v1.6 T12' in src, '缺少实现标记'

    def test_resources_tab_wires_three_js_apis(self):
        src = _fe('29-mcp.js')
        assert "callApi('mcp_list_resources', [server])" in src
        assert "callApi('mcp_read_resource', [server, r.uri], MCP_PANEL_TIMEOUT_MS)" in src
        assert "callApi('mcp_save_subscriptions'," in src
        # 资源订阅来源：详情 config.resourceSubs（后端 mcp_servers.json 可选键）
        assert 'd.config.resourceSubs' in src
        # 截断保护 + 顶部订阅说明行
        assert 'MCP_RES_PREVIEW_MAX' in src
        assert '已订阅 \' + mcpResSubs.length + \' 个资源将注入对话上下文' in src

    def test_template_css_pure_additions(self):
        tpl = _tpl()
        for cls in ('.mcp-tabs', '.mcp-tab.on', '.mcp-res-list', '.mcp-res-row',
                    '.mcp-res-out', '.mcp-res-text', '.mcp-res-blob', '.mcp-res-open'):
            assert cls in tpl, '模板缺少资源 tab 样式: ' + cls
        assert '实现 v1.6 T12' in tpl, '模板缺少实现标记'


# ============================================================ vm 真实源码
_LIST_RESOURCES = ("JSON.stringify({ok:true, supported:true, resources:["
                   "{uri:'file:///a.txt', name:'a.txt', mimeType:'text/plain'},"
                   "{uri:'file:///b.bin', name:'b.bin', mimeType:'application/octet-stream'}"
                   "]})")


class TestT12ResourcesTabRender:
    """资源 tab：列表渲染（uri+name+mimeType）/ supported=false 人话降级 / 订阅计数行。"""

    def test_list_render_with_presubscribed(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(m) {
      if (m === 'mcp_list_resources') return %s;
      return '{}';
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  return await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, ['file:///a.txt']);
    const countBox = pane.children[0];
    const list = pane.children[1];
    const row = list.children[0];
    const main = row.children[1];
    return {
      panes: pane.children.length,
      count: countBox.textContent,
      rows: list.children.length,
      cbType: row.children[0].type,
      cbChecked: row.children[0].checked,
      name: main.children[0].textContent,
      meta: main.children[1].textContent,
      btnText: row.children[2].textContent
    };
  })()`, ctx);
}
""" % _LIST_RESOURCES, 'reslist')
        assert res['panes'] == 2, res
        assert res['count'] == '已订阅 1 个资源将注入对话上下文', res
        assert res['rows'] == 2, res
        assert res['cbType'] == 'checkbox', res
        assert res['cbChecked'] is True, '已订阅资源勾选应预置'
        assert res['name'] == 'a.txt', res
        assert res['meta'] == 'file:///a.txt · text/plain', res
        assert res['btnText'] == '读取', res

    def test_unsupported_human_notice_not_red(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function() {
      return JSON.stringify({ok:true, supported:false, resources:[]});
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  return await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, []);
    return { panes: pane.children.length, text: pane.children[0].textContent,
             color: pane.children[0].style.color || '' };
  })()`, ctx);
}
""", 'resunsup')
        assert res['panes'] == 1, res
        assert '该服务器不支持 resources' in res['text'], res
        assert res['color'] == '', '-32601 降级是人话提示，不得按错误红展示'

    def test_list_error_state(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function() {
      return JSON.stringify({error:'MCP 服务器 res 未启用。'});
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  return await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, []);
    return { panes: pane.children.length, text: pane.children[0].textContent,
             color: pane.children[0].style.color || '' };
  })()`, ctx);
}
""", 'reserr')
        assert res['panes'] == 1, res
        assert '资源列表读取失败' in res['text'] and 'res' in res['text'], res
        assert res['color'] == 'var(--err)', res


class TestT12ResourcesRead:
    """读取：text 展开 + 截断保护 / blob 落盘提示 + 打开目录 / 失败 toast 人话。"""

    def _read(self, read_ret):
        return _run_node(r"""
async function __main() {
  const __calls = [];
  const ctx = __ctx({
    callApi: async function(m, a) {
      __calls.push([m, a]);
      if (m === 'mcp_list_resources') return %s;
      if (m === 'mcp_read_resource') return %s;
      return '{}';
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  const r = await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, []);
    const row = pane.children[1].children[0];
    const btn = row.children[2];
    const p1 = btn.onclick();
    const disabledDuring = btn.disabled;
    const p2 = btn.onclick();           // 同资源在途 → 防连点直接忽略
    await Promise.all([p1, p2]);
    const out = row.children[3];
    return { disabledDuring: disabledDuring, disabledAfter: btn.disabled,
             label: btn.textContent, outTag: out.className, outHtml: out.innerHTML,
             outKids: out.children.length,
             outText: out.children[0] ? out.children[0].textContent : '' };
  })()`, ctx);
  return { r: r, calls: __calls };
}
""" % (_LIST_RESOURCES, read_ret), 'resread')

    def test_read_text_expand_and_busy_guard(self):
        res = self._read("JSON.stringify({ok:true, text:" + "'资源正文内容'" + "})")
        r = res['r']
        reads = [c for c in res['calls'] if c[0] == 'mcp_read_resource']
        assert len(reads) == 1, '在途重复点击必须被防连点拦截: %r' % (res['calls'],)
        assert r['disabledDuring'] is True, '读取中按钮必须禁用'
        assert r['disabledAfter'] is False and r['label'] == '读取', '完成后按钮复位'
        assert 'mcp-res-out' in r['outTag'], r
        assert r['outText'] == '资源正文内容', r

    def test_read_text_truncated(self):
        res = self._read(
            "JSON.stringify({ok:true, text:'x'.repeat(20001)})")
        r = res['r']
        suffix = '\n…（内容过长已截断，完整内容可在对话中读取）'
        assert len(r['outText']) == 20000 + len(suffix), '超长 text 必须截断保护'
        assert r['outText'].startswith('x' * 100), r
        assert r['outText'].endswith(suffix), r

    def test_read_blob_saved_notice_and_open_dir(self):
        res = self._read(
            "JSON.stringify({ok:true, uri:'file:///b.bin', text:'', blob_cached:true,"
            "cache_id:'tc1_1', blob_bytes:5000,"
            "hint:'二进制资源已落盘（id=tc1_1），read_more 分段读取'})")
        r = res['r']
        assert '已保存至工具缓存' in r['outText'], r
        assert 'tc1_1' in r['outText'] and '5000' in r['outText'], r
        # out 子节点：落盘行 / hint / 打开目录按钮
        res2 = _run_node(r"""
async function __main() {
  const __calls = [];
  const ctx = __ctx({
    callApi: async function(m, a) {
      __calls.push([m, a]);
      if (m === 'mcp_list_resources') return %s;
      if (m === 'mcp_read_resource') return JSON.stringify({ok:true, blob_cached:true,
        cache_id:'tc1_1', blob_bytes:5000, hint:'落盘提示'});
      if (m === 'run_command') return JSON.stringify({ok:true, exit_code:0});
      return '{}';
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  const r = await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, []);
    const row = pane.children[1].children[0];
    await row.children[2].onclick();
    const out = row.children[3];
    const openBtn = out.children[2];
    const openText = openBtn.textContent;
    await openBtn.onclick();
    return { kids: out.children.length, hint: out.children[1].textContent, openText: openText };
  })()`, ctx);
  return { r: r, calls: __calls };
}
""" % _LIST_RESOURCES, 'resblob')
        r2 = res2['r']
        assert r2['kids'] == 3, r2
        assert r2['hint'] == '落盘提示', r2
        assert r2['openText'] == '打开目录', r2
        opens = [c for c in res2['calls'] if c[0] == 'run_command']
        assert opens, '「打开目录」必须触发打开动作'
        assert 'toolcache' in opens[0][1][0], opens

    def test_read_failure_toast_human(self):
        res = _run_node(r"""
async function __main() {
  const ctx = __ctx({
    callApi: async function(m) {
      if (m === 'mcp_list_resources') return %s;
      return JSON.stringify({error:'MCP 资源读取失败: boom'});
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  const r = await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, []);
    const row = pane.children[1].children[0];
    const btn = row.children[2];
    await btn.onclick();
    const out = row.children[3];
    return { disabled: btn.disabled, label: btn.textContent,
             outText: out.children[0].textContent, color: out.children[0].style.color || '' };
  })()`, ctx);
    return { r: r, toasts: __toasts.map(t => ({ msg: t.msg, kind: t.kind })) };
}
""" % _LIST_RESOURCES, 'resreadfail')
        r = res['r']
        assert r['disabled'] is False and r['label'] == '读取', '失败后按钮必须复位'
        assert r['color'] == 'var(--err)', r
        errs = [t for t in res['toasts'] if t['kind'] == 'err']
        assert errs and '资源读取失败' in errs[0]['msg'] and 'boom' in errs[0]['msg'], res


class TestT12ResourcesSubscribe:
    """订阅：checkbox 变更即调 mcp_save_subscriptions 持久化；失败回弹。"""

    def test_toggle_saved_and_count(self):
        res = _run_node(r"""
async function __main() {
  const __calls = [];
  const ctx = __ctx({
    callApi: async function(m, a) {
      __calls.push([m, a]);
      if (m === 'mcp_list_resources') return %s;
      if (m === 'mcp_save_subscriptions') return JSON.stringify({ok:true,
        subscribed: JSON.parse(a[1])});
      return '{}';
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  const r = await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, ['file:///a.txt']);
    const countBox = pane.children[0];
    const row = pane.children[1].children[0];
    const cb = row.children[0];
    cb.checked = false;               // 取消订阅
    await cb.onchange();
    const afterOff = { count: countBox.textContent, checked: cb.checked };
    cb.checked = true;                // 重新订阅
    await cb.onchange();
    const afterOn = { count: countBox.textContent, checked: cb.checked };
    return { afterOff: afterOff, afterOn: afterOn };
  })()`, ctx);
  return { r: r, calls: __calls, toasts: __toasts.map(t => t.msg) };
}
""" % _LIST_RESOURCES, 'ressub')
        saves = [c for c in res['calls'] if c[0] == 'mcp_save_subscriptions']
        assert len(saves) == 2, res['calls']
        assert saves[0][1] == ['res', '[]'], saves
        assert saves[1][1] == ['res', '["file:///a.txt"]'], saves
        assert res['r']['afterOff']['count'] == '已订阅 0 个资源将注入对话上下文', res['r']
        assert res['r']['afterOn']['count'] == '已订阅 1 个资源将注入对话上下文', res['r']
        assert res['r']['afterOn']['checked'] is True
        assert any('已取消订阅' in t for t in res['toasts']), res['toasts']
        assert any('已订阅 file:///a.txt' == t for t in res['toasts']), res['toasts']

    def test_save_failure_reverts_checkbox_and_count(self):
        res = _run_node(r"""
async function __main() {
  const __calls = [];
  const ctx = __ctx({
    callApi: async function(m, a) {
      __calls.push([m, a]);
      if (m === 'mcp_list_resources') return %s;
      if (m === 'mcp_save_subscriptions') return JSON.stringify({error:'保存失败: 磁盘满'});
      return '{}';
    }
  });
  __run(ctx, __fe('29-mcp.js'));
  const r = await __vm.runInContext(`(async () => {
    const pane = document.createElement('div');
    await mcpResOpen('res', pane, ['file:///a.txt']);
    const countBox = pane.children[0];
    const row = pane.children[1].children[0];
    const cb = row.children[0];
    cb.checked = false;               // 尝试取消 → 后端失败
    await cb.onchange();
    return { count: countBox.textContent, checked: cb.checked };
  })()`, ctx);
  return { r: r, toasts: __toasts.map(t => ({ msg: t.msg, kind: t.kind })) };
}
""" % _LIST_RESOURCES, 'ressubfail')
        r = res['r']
        assert r['count'] == '已订阅 1 个资源将注入对话上下文', '保存失败必须回滚计数'
        assert r['checked'] is True, '保存失败必须回弹 checkbox 视觉态'
        errs = [t for t in res['toasts'] if t['kind'] == 'err']
        assert errs and '订阅保存失败' in errs[0]['msg'], res['toasts']
