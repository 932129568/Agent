# -*- coding: utf-8 -*-
"""群聊 @ 选择器 + 多目标 @（Round 15，2026-11-04 主理人报障）。

报障原文：「随着聊天轮次的变多，我想要 @ 他们就变难了，得加一个打出 @ 会
弹出来选择的这个，然后一次性 @ 多人的时候，会只有最后一个 @ 的人收到，
其他人不会回复。」

验收口径：
1. 打 `@` 弹出候选（成员 + 群主），随输入过滤；Enter 采纳后补空格；
2. 非群聊会话完全不弹（零行为差异）；
3. 一次 @ 多人 → 被 @ 的每个人都真的发言一次（不是只取最后一个）。
"""
from pathlib import Path

from test_connect_merge import _run_node

ROOT = Path(__file__).resolve().parent.parent
GROUP = ROOT / 'frontend' / 'src' / 'group' / 'group.js'
MENTION = ROOT / 'frontend' / 'src' / 'group' / 'mention.js'


def _boot(body, name):
    return _run_node((r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  __run(ctx, __fe('mention.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  const s = { id: 's1', title: '群', messages: [], group: {
    members: [{ id: 'm1', name: '主持人', host: true, model: '' },
              { id: 'm2', name: 'UI设计', host: false, model: '' },
              { id: 'm3', name: '前端', host: false, model: '' },
              { id: 'm4', name: '测试', host: false, model: '' }],
    phase: 'paused', turn: 'm1', round: 0, autoRelay: false } };
  vmRun("sessions = [" + JSON.stringify({
    id: 's1', title: '群', messages: [],
    group: { members: [{id:'m1',name:'主持人',host:true,model:''},
                       {id:'m2',name:'UI设计',host:false,model:''},
                       {id:'m3',name:'前端',host:false,model:''},
                       {id:'m4',name:'测试',host:false,model:''}],
             phase:'paused', turn:'m1', round:0, autoRelay: false },
  }) + "]; AppState = { currentSessionId: 's1' };");
""" + body + """
}
"""), name)


def test_mention_query_detects_at_token():
    result = _boot(r"""
  const ta = __doc.getElementById('userInput');
  const q = vmRun('groupMentionQuery');
  ta.value = '@'; ta.selectionStart = 1; ta.selectionEnd = 1;
  const a = q(ta);
  ta.value = '请 @UI'; ta.selectionStart = 5; ta.selectionEnd = 5;
  const b = q(ta);
  ta.value = 'a@b.com'; ta.selectionStart = 7; ta.selectionEnd = 7;
  const c = q(ta);
  ta.value = 'no at here'; ta.selectionStart = 11; ta.selectionEnd = 11;
  const d = q(ta);
  return {a: a, b: b, c: c, d: d};
""", 'mention_query')
    assert result['a'] == {'start': 0, 'query': ''}
    assert result['b'] == {'start': 2, 'query': 'UI'}
    assert result['c'] is None            # 邮箱不弹
    assert result['d'] is None


def test_mention_members_list_has_owner_and_members():
    result = _boot(r"""
  const list = vmRun('groupMentionMembers')();
  return {names: list.map(function(m){ return m.name; }),
          owner: list.filter(function(m){ return m.owner; }).map(function(m){ return m.name; })};
""", 'mention_members')
    assert result['names'] == ['主持人', 'UI设计', '前端', '测试', '群主']
    assert result['owner'] == ['群主']


def test_mention_accept_replaces_token_with_name_and_space():
    result = _boot(r"""
  const ta = __doc.getElementById('userInput');
  ta.value = '你好 @前 请开工'; ta.selectionStart = 5; ta.selectionEnd = 5;
  vmRun('groupMentionRefresh')(ta);
  const open = !!__doc.getElementById('mentionPicker');
  const hits = vmRun('_mention').items.map(function(m){ return m.name; });
  vmRun('groupMentionAccept')(ta, vmRun('_mention').items[0]);
  return {open: open, hits: hits, value: ta.value, caret: ta.selectionStart};
""", 'mention_accept')
    assert result['open'] is True
    assert result['hits'] == ['前端']
    assert result['value'] == '你好 @前端  请开工'
    assert result['caret'] == 5


def test_mention_targets_returns_all_mentioned_in_order():
    result = _boot(r"""
  const GROUP = { members: [{name:'主持人',host:true},{name:'UI设计'},{name:'前端'},{name:'测试'}] };
  const f = vmRun('groupMentionTargets');
  const one = f('@前端 先做登录页', {group: GROUP}).map(function(m){ return m.name; });
  const many = f('@测试 先看 @UI设计 的稿，再让 @前端 实现；@测试 复核', {group: GROUP})
    .map(function(m){ return m.name; });
  const ownerOnly = f('@群主 请确认配色', {group: GROUP}).map(function(m){ return m.name; });
  return {one: one, many: many, ownerOnly: ownerOnly};
""", 'mention_targets')
    assert result['one'] == ['前端']
    assert result['many'] == ['测试', 'UI设计', '前端']    # 去重保序
    assert result['ownerOnly'] == []


def test_multi_mention_speaks_in_typed_order():
    """主理人 Round 15b 报障：先 @ 的反而后说话。

    真实链路：groupHandleOutgoing 种下 _mentionQueue → groupSpeak 每轮先吃
    队列再走自由路由。成员自己的输出不含 @（不产生自由路由），发言顺序就
    必须严格等于群主打字顺序。autoRelay 关闭也照走（显式点名优先于开关）。
    """
    result = _boot(r"""
  const vmRun2 = function(code){ return __vm.runInContext(code, ctx); };
  vmRun2("groupPush = function(s, role, text, member){"
       + " if (member) (globalThis.__spoke = globalThis.__spoke || []).push(member.name); };");
  vmRun2("groupToolbarRefresh = function(){};");
  vmRun2("saveSessions = function(){};");
  vmRun2("groupBubbleMount = function(){ return null; };");
  vmRun2("groupArchiveHandoff = async function(){};");
  // 成员输出不带任何 @/交接 → 唯一的调度来源就是显式 @ 队列
  vmRun2("groupCallModel = async function(s, m){ return m.name + ' 收到，完成。'; };");
  vmRun2("sessions[0].group.autoRelay = false;");
  await vmRun2('groupHandleOutgoing')('@前端 先做，然后 @测试 验收，最后 @UI设计 出稿');
  return {spoke: vmRun2('globalThis.__spoke || []'),
          queueLeft: vmRun2('sessions[0].group.mentionQueue || []').length};
""", 'multi_mention_order')
    assert result['spoke'] == ['前端', '测试', 'UI设计'], result
    assert result['queueLeft'] == 0, result


def test_multi_mention_overrides_member_self_routing():
    """成员自己 @ 了别人也不能插队：队列没吃完前自由路由不生效。"""
    result = _boot(r"""
  const vmRun2 = function(code){ return __vm.runInContext(code, ctx); };
  vmRun2("groupPush = function(s, role, text, member){"
       + " if (member) (globalThis.__spoke = globalThis.__spoke || []).push(member.name); };");
  vmRun2("groupToolbarRefresh = function(){};");
  vmRun2("saveSessions = function(){};");
  vmRun2("groupBubbleMount = function(){ return null; };");
  vmRun2("groupArchiveHandoff = async function(){};");
  // 每位成员都想抢着 @ 主持人——但队列优先，插不进来
  vmRun2("groupCallModel = async function(s, m){ return '我先说，@主持人 听我的'; };");
  vmRun2("sessions[0].group.autoRelay = true;");
  await vmRun2('groupHandleOutgoing')('@UI设计 出稿，@前端 实现');
  return {spoke: vmRun2('globalThis.__spoke || []'),
          phase: vmRun2('sessions[0].group.phase')};
""", 'multi_mention_override')
    # 队列顺序不受成员自我路由影响；队列耗尽后自由路由恢复（前端 @主持人 →
    # 主持人收尾后无指向暂停）
    assert result['spoke'] == ['UI设计', '前端', '主持人'], result
    assert result['phase'] == 'paused', result


def test_single_mention_falls_back_to_free_relay():
    """只 @ 一人（或没 @）：队列即空，自由路由照旧（不回归 Round 13 行为）。"""
    result = _boot(r"""
  const vmRun2 = function(code){ return __vm.runInContext(code, ctx); };
  vmRun2("groupPush = function(s, role, text, member){"
       + " if (member) (globalThis.__spoke = globalThis.__spoke || []).push(member.name); };");
  vmRun2("groupToolbarRefresh = function(){};");
  vmRun2("saveSessions = function(){};");
  vmRun2("groupBubbleMount = function(){ return null; };");
  vmRun2("groupArchiveHandoff = async function(){};");
  vmRun2("sessions[0].group.autoRelay = true;");
  // A 说完 @B；B 说完不再指名 → 回主持人（host）→ 无指向暂停
  let n = 0;
  vmRun2("groupCallModel = async function(s, m){"
       + " if (m.name === '前端') return '交棒 @测试';"
       + " if (m.name === '测试') return '我做完了，请主持人检视';"
       + " return '检视通过'; };");
  await vmRun2('groupHandleOutgoing')('@前端 开始做登录页');
  return {spoke: vmRun2('globalThis.__spoke || []'),
          phase: vmRun2('sessions[0].group.phase')};
""", 'single_mention_relay')
    assert result['spoke'] == ['前端', '测试', '主持人'], result
    assert result['phase'] == 'paused', result


def test_source_has_picker_wiring():
    assert 'groupMentionBind' in MENTION.read_text(encoding='utf-8')
    assert 'groupMentionTargets(trimmed, s)' in GROUP.read_text(encoding='utf-8')
