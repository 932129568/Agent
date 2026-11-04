# -*- coding: utf-8 -*-
"""群文件 + 完整交接文档（Round 14，2026-11-04 主理人立项）。

需求原文：「群聊多一个群文件功能，他们的交接文档统一放在群文件，并把名字
修改清晰明白，方便后续其他大模型不清楚的时候智能搜索调用，群文件的本地
保存地址可以自定义修改。」以及「交接文档要写清楚包括所有说明的内容，不能
简单缩写」。

验收口径：
1. 后端：写出即落盘、文件名可读、列表按时间、关键词可检索、目录可自定义；
2. 前端：交接文档解析不截断、归档元信息带主题与关键词、上下文注入群文件索引；
3. 提示词：明确禁止缩写/省略。
"""
import json
import os
import tempfile

import pytest

from conftest import reset_home
from helpers.frontend import read_frontend_source
from test_connect_merge import _run_node

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GROUP_JS = os.path.join(PROJECT_ROOT, 'frontend', 'src', 'group', 'group.js')
FILES_JS = os.path.join(PROJECT_ROOT, 'frontend', 'src', 'group', 'files.js')


@pytest.fixture()
def api():
    from backend.api import Api
    reset_home()
    return Api()


def _j(raw):
    return json.loads(raw)


def test_write_creates_readable_named_file(api):
    r = _j(api.group_files_write(
        'sess-1', '测试群', '主持人', '登录页分工与验收标准',
        '完整说明正文……\n【交接文档】\n- 交接给: UI设计\n- 本次产出: 分工方案',
        json.dumps({'to': 'UI设计', 'keywords': '登录页 分工 验收', 'round': 2})))
    assert r['path'] and os.path.isfile(r['path'])
    name = r['name']
    # 名字必须能看懂：时间 + 成员 + 主题
    assert name.endswith('.md')
    assert '主持人' in name and '登录页分工与验收标准' in name
    assert name[:8].isdigit()          # YYYYMMDD
    with open(r['path'], encoding='utf-8') as f:
        body = f.read()
    assert 'member: 主持人' in body and 'to: UI设计' in body
    assert '完整说明正文' in body


def test_list_and_search_rank_by_title_and_body(api):
    _j(api.group_files_write('s', '群', '主持人', '登录页分工与验收标准',
                             '验收要点：三步走。', json.dumps({'keywords': '验收 登录页'})))
    _j(api.group_files_write('s', '群', 'UI设计', '配色与栅格',
                             '深蓝紫青，八列栅格。', json.dumps({'keywords': '配色 栅格'})))
    listed = _j(api.group_files_list('s', '群'))
    assert len(listed['files']) == 2
    assert listed['files'][0]['title'] == '配色与栅格'      # 最新在前
    hit = _j(api.group_files_search('s', '验收'))
    assert hit['count'] == 1
    assert hit['hits'][0]['title'] == '登录页分工与验收标准'
    assert '验收' in hit['hits'][0]['snippet']
    # snippet 不应包含元信息头
    assert 'harbor-group-file' not in hit['hits'][0]['snippet']
    assert _j(api.group_files_search('s', '不存在的词'))['count'] == 0


def test_custom_root_switch_takes_effect(api):
    custom = os.path.join(str(reset_home() or tempfile.gettempdir()), 'my-group-files')
    cfg = _j(api.group_files_config_set(json.dumps({'root': custom})))
    assert cfg['root'] == custom and cfg['custom'] is True
    r = _j(api.group_files_write('s', '群', '前端', '首页实现', '代码已落盘'))
    assert r['path'].startswith(custom)
    assert os.path.isdir(custom)
    # 恢复默认
    back = _j(api.group_files_config_set(json.dumps({'root': ''})))
    assert back['custom'] is False
    assert 'group_files' in back['root']


def test_handoff_parse_keeps_full_text():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  __run(ctx, __fe('files.js'));
  const text = '正文开场。\n【交接文档】\n- 交接给: 前端\n- 本次产出: 登录页实现清单\n'
    + '- 完整说明: ' + '这是一段很长的完整说明，'.repeat(40) + '\n'
    + '- 对下一棒的要求: 1) 实现表单 2) 校验 3) 响应式\n- 风险与注意: 无\n';
  const h = __vm.runInContext('groupHandoffOf', ctx)(text);
  const f = __vm.runInContext('groupHandoffFields', ctx)(h);
  const t = __vm.runInContext('groupHandoffTitle', ctx)(h, 'x');
  return {len: h.length, to: f.to, title: t,
          req: f.requirements, risky: f.risks,
          hasFull: h.indexOf('这是一段很长的完整说明') >= 0};
}
""", 'gf_parse')
    assert result['len'] > 500, result        # 40 段说明原样保留，未截断
    assert result['to'] == '前端'
    assert result['title'] == '登录页实现清单'
    assert '实现表单' in result['req']
    assert result['risky'] == '无'
    assert result['hasFull'] is True


def test_context_injects_group_file_index_without_abbreviation_rule():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  __run(ctx, __fe('files.js'));
  const s = { id: 's1', title: '群', messages: [], groupFiles: [
    { name: '20261104-101010_主持人_分工.md', title: '分工方案', member: '主持人', to: 'UI设计' }
  ], groupFileRoot: 'D:/gf' };
  s.group = { members: [{ id: 'a', name: '主持人', host: true, model: '', role: '' },
                        { id: 'b', name: 'UI设计', host: false, model: '', role: '' }],
              phase: 'running', turn: 'a', round: 1 };
  const msgs = __vm.runInContext('groupContextFor', ctx)(s, s.group.members[1]);
  const sys = msgs[0].content;
  return {hasIndex: sys.indexOf('分工方案') >= 0, hasRoot: sys.indexOf('D:/gf') >= 0,
          noAbbrev: sys.indexOf('不许用') >= 0 || sys.indexOf('不要为了省字') >= 0,
          ownerLine: sys.indexOf('群主（人类') >= 0};
}
""", 'gf_ctx')
    assert result['hasIndex'] is True
    assert result['hasRoot'] is True
    assert result['noAbbrev'] is True
    assert result['ownerLine'] is True


def test_archive_writes_meta_with_title_and_keywords():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(name, args){
    globalThis.__calls = globalThis.__calls || [];
    globalThis.__calls.push({name: name, args: args});
    if (name === 'group_files_write') {
      return JSON.stringify({path: 'D:/gf/a.md', name: '20261104_x_分工.md', title: '分工方案',
                             member: '主持人', to: 'UI设计', mtime: 1});
    }
    return '{}';
  }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  __run(ctx, __fe('files.js'));
  const s = { id: 's9', title: '测试群', messages: [], group: { members: [], round: 1 } };
  await __vm.runInContext('groupArchiveHandoff', ctx)(s, { id: 'a', name: '主持人' },
    '正文。\n【交接文档】\n- 交接给: UI设计\n- 本次产出: 分工方案\n- 完整说明: 逐条写全', 3);
  const call = (globalThis.__calls || []).find(c => c.name === 'group_files_write');
  const meta = JSON.parse(call.args[5]);
  return {called: !!call, groupId: call.args[0], member: call.args[2], title: call.args[3],
          to: meta.to, round: meta.round, kw: meta.keywords, stored: s.groupFiles.length};
}
""", 'gf_archive')
    assert result['called'] is True
    assert result['groupId'] == 's9' and result['member'] == '主持人'
    assert result['title'] == '分工方案'
    assert result['to'] == 'UI设计' and result['round'] == 3
    assert '分工' in result['kw']
    assert result['stored'] == 1
