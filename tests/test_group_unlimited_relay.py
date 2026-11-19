# -*- coding: utf-8 -*-
"""群聊接力调度（Round 13 不限轮数 → R62 名册顺序确定性接力，2026-11-09 主理人裁定）。

演进：R13 取消 turnBudget=24（递归改迭代）；R62 真机实测「自由路由派错棒」
（前端抢 UI 设计的活）→ 路由改为**名册顺序**：主持人 → 名册依次传递 → 末位
交还群主。判定标准：
1. 接力严格按名册顺序走完整条链，不受成员输出里 @/交接给 的劫持；
2. 链走完 phase=paused、turn 复位主持人、系统消息「接力完成」；
3. 群主暂停（phase=paused）能在下一轮边界立即生效；
4. 同一会话不会并发开两条接力（busy 守卫）；
5. 源码里 turnBudget 痕迹清零。
"""
from pathlib import Path

from helpers.legacy_vm import _run_node

ROOT = Path(__file__).resolve().parent.parent
GROUP = ROOT / 'frontend' / 'src' / 'group' / 'group.js'
BUNDLE = ROOT / 'harbor.html'


def _boot(extra):
    return (r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  vmRun("sessions = [{id:'s1', messages:[], group:{members:[{id:'a',name:'主持人',host:true,model:''},{id:'b',name:'B',host:false,model:''},{id:'c',name:'C',host:false,model:''}], phase:'running', autoRelay:true, turn:'a', round:0}}];");
  vmRun("groupContextFor = function(){ return []; };");
  vmRun("groupPush = function(s, role, text, member, opts){ (globalThis.__pushed = globalThis.__pushed || []).push({role:role, text:String(text), member: member ? member.name : null}); };");
  vmRun("groupToolbarRefresh = function(){};");
  vmRun("groupBubbleMount = function(){ return null; };");
  vmRun("saveSessions = function(){};");
  vmRun("groupArchiveHandoff = async function(){};");
  __EXTRA__
  const s = vmRun("sessions[0]");
  await vmRun("groupSpeak(sessions[0], sessions[0].group.members[0])");
  const pushed = vmRun("globalThis.__pushed || []");
  return {
    round: s.group.round, phase: s.group.phase, turn: s.group.turn,
    spoke: pushed.filter(function(p){ return p.member; }).map(function(p){ return p.member; }),
    sys: pushed.filter(function(p){ return !p.member; }).map(function(p){ return p.text.slice(0, 40); }),
  };
}
""").replace('__EXTRA__', extra)


def test_relay_follows_roster_order_and_hands_back_to_owner():
    """R62：主持人 → B → C → 链尾交还群主；成员输出里的 @ 不劫持顺序。"""
    result = _run_node(_boot(
        "vmRun(\"groupCallModel = async function(s, member){ return member.name + ' 完成，@C 先走'; };\");"
    ), 'group_roster')
    assert result['spoke'] == ['主持人', 'B', 'C'], result
    assert result['phase'] == 'paused', result
    assert result['turn'] == 'a', result                # 下一轮从主持人起棒
    assert result['round'] == 3, result
    assert any('接力完成' in t for t in result['sys']), result


def test_relay_stops_immediately_when_host_pauses():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  vmRun("sessions = [{id:'s1', messages:[], group:{members:[{id:'a',name:'主持人',host:true,model:''},{id:'b',name:'B',host:false,model:''},{id:'c',name:'C',host:false,model:''}], phase:'running', autoRelay:true, turn:'a', round:0}}];");
  vmRun("groupContextFor = function(){ return []; };");
  vmRun("groupPush = function(s, role, text, member, opts){ (globalThis.__pushed = globalThis.__pushed || []).push({member: member ? member.name : null}); };");
  vmRun("groupToolbarRefresh = function(){};");
  vmRun("groupBubbleMount = function(){ return null; };");
  vmRun("saveSessions = function(){};");
  vmRun("groupArchiveHandoff = async function(){};");
  // 第 1 次调用（主持人发言）模拟群主点「暂停接力」→ 边界处必须停，B 不得发言
  vmRun("let __n = 0; groupCallModel = async function(s, member){ __n++;"
        + " if (__n === 1) { s.group.phase = 'paused'; }"
        + " return member.name + ' 完成'; };");
  const s = vmRun("sessions[0]");
  await vmRun("groupSpeak(sessions[0], sessions[0].group.members[0])");
  const spoke = vmRun("(globalThis.__pushed || []).filter(function(p){ return p.member; }).map(function(p){ return p.member; })");
  return {round: s.group.round, phase: s.group.phase, spoke: spoke};
}
""", 'group_pause')
    assert result['phase'] == 'paused'
    assert result['spoke'] == ['主持人'], result   # 暂停在边界立即生效，后续成员不再发言
    assert result['round'] == 1, result


def test_busy_guard_prevents_two_concurrent_relays():
    result = _run_node(r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  vmRun("sessions = [{id:'s1', messages:[], group:{members:[{id:'a',name:'A',host:false,model:'m'},{id:'b',name:'B',host:false,model:'m'}], phase:'running', autoRelay:true, turn:'a', round:0}}];");
  vmRun("groupContextFor = function(){ return []; };");
  vmRun("groupPush = function(){};");
  vmRun("groupToolbarRefresh = function(){};");
  vmRun("groupBubbleMount = function(){ return null; };");
  vmRun("saveSessions = function(){};");
  vmRun("groupArchiveHandoff = async function(){};");
  vmRun("let __n = 0; groupCallModel = async function(s, member){ __n++;"
        + " return member.name + ' 完成'; };");
  const s = vmRun("sessions[0]");
  // 同时两次发起（继续接力 + 插话都会走到这里）
  await Promise.all([
    vmRun("groupSpeak(sessions[0], sessions[0].group.members[0])"),
    vmRun("groupSpeak(sessions[0], sessions[0].group.members[1])")
  ]);
  return {round: s.group.round, calls: vmRun("__n"), busy: vmRun("GROUP_BUSY_SIDS.size")};
}
""", 'group_busy')
    # 只跑一条链：round 与调用次数应同步（若并发双链会被 busy 守卫挡掉）
    assert result['calls'] == result['round'], result
    # R31：busy 标记由 Set 承载，链结束后应为空
    assert result['busy'] == 0, result


def test_no_turn_budget_left_in_source_or_bundle():
    assert 'turnBudget' not in GROUP.read_text(encoding='utf-8')
    if BUNDLE.is_file():
        assert 'turnBudget' not in BUNDLE.read_text(encoding='utf-8', errors='replace')
