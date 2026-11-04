# -*- coding: utf-8 -*-
"""群聊状态持久化（Round 15 优化）：跨重启保留 group.endpoints / mentionQueue，
localStorage 镜像剥明文 Key（W29 纪律不破）。"""
from test_connect_merge import _run_node


def _run(body, name):
    return _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '[]'; }});
  __run(ctx, __fe('65-session-store.js'));
""" + body + """
}
""", name)


def test_normalize_keeps_endpoints_and_mention_queue():
    result = _run(r"""
  const norm = __vm.runInContext('normalizeSessions', ctx);
  const out = norm([{
    id: 's1', title: '群', messages: [],
    group: {
      members: [{ id: 'm1', name: '主持人', host: true }, { id: 'm2', name: '前端', host: false }],
      turn: 'm2', phase: 'running', round: 3, autoRelay: false,
      endpoints: { deepseek: { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1',
                               api_key: 'sk-ds-xyz' } },
      mentionQueue: ['m3', 'm4'],
    },
  }]);
  const g = out[0].group;
  return {phase: g.phase, ep: g.endpoints && g.endpoints.deepseek,
          queue: g.mentionQueue};
""", 'grp_persist')
    assert result['phase'] == 'paused'          # running 落库一律降为 paused
    assert result['ep']['base_url'] == 'https://api.deepseek.com/v1'
    assert result['ep']['api_key'] == 'sk-ds-xyz'
    assert result['queue'] == ['m3', 'm4']


def test_normalize_drops_malformed_endpoints():
    result = _run(r"""
  const norm = __vm.runInContext('normalizeSessions', ctx);
  const out = norm([{
    id: 's1', title: '群', messages: [],
    group: {
      members: [{ id: 'm1', name: 'A', host: true }, { id: 'm2', name: 'B', host: false }],
      endpoints: { bad: { name: 'x' }, good: { base_url: 'https://x/v1', api_key: 'k' } },
      mentionQueue: ['ok', 42, '', null],
    },
  }]);
  const g = out[0].group;
  return {eps: Object.keys(g.endpoints || {}), queue: g.mentionQueue || []};
""", 'grp_persist_bad')
    assert result['eps'] == ['good']
    assert result['queue'] == ['ok']


def test_mirror_projection_strips_api_keys():
    result = _run(r"""
  const proj = __vm.runInContext('_sessionsMirrorProjection', ctx);
  const json = proj([{
    id: 's1', title: '群', createdAt: 1, updatedAt: 1, messages: [],
    group: {
      members: [{ id: 'm1', name: 'A', host: true }, { id: 'm2', name: 'B', host: false }],
      endpoints: { deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-SECRET' } },
    },
  }]);
  return {json: json, leak: json.indexOf('sk-SECRET') >= 0};
""", 'grp_mirror')
    assert result['leak'] is False, result
