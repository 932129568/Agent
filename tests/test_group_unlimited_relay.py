# -*- coding: utf-8 -*-
"""群聊接力不限轮数（Round 13，2026-11-04 主理人裁定）。

原实现：turnBudget=24 到顶自动暂停，且接力用递归 `await groupSpeak(s, next)`
——不限轮数后递归会持续加深调用栈。判定标准：
1. 跑 60+ 轮不出现任何「上限」暂停，round 持续增长；
2. 群主暂停（phase=paused 或暂停标志）能在下一轮边界立即生效；
3. 同一会话不会并发开两条接力（busy 守卫）；
4. 源码里 turnBudget 痕迹清零。
"""
from pathlib import Path

from test_connect_merge import _run_node

ROOT = Path(__file__).resolve().parent.parent
GROUP = ROOT / 'frontend' / 'src' / 'group' / 'group.js'
BUNDLE = ROOT / 'harbor.html'


def _env(rounds_cap):
    return (r"""
async function __main() {
  const ctx = __ctx({callApi: async function(){ return '{}'; }, AbortController: AbortController});
  __run(ctx, __fe('group.js'));
  const vmRun = function(code){ return __vm.runInContext(code, ctx); };
  // 成员 A/B 互相 @，形成永不终止的接力链（模拟最坏情况）
  vmRun("sessions = [{id:'s1', messages:[], group:{members:[{id:'a',name:'A',host:false,model:'m'},{id:'b',name:'B',host:false,model:'m'}], phase:'running', autoRelay:true, turn:'a', round:0}}];");
  vmRun("groupContextFor = function(){ return []; };");
  vmRun("groupPush = function(s, role, text, member, opts){ (globalThis.__pushed = globalThis.__pushed || []).push({role:role, text:String(text), member: member ? member.name : null}); };");
  vmRun("groupToolbarRefresh = function(){};");
  vmRun("groupBubbleMount = function(){ return null; };");
  vmRun("saveSessions = function(){};");
  vmRun("let __n = 0; groupCallModel = async function(s, member){ __n++;"
        + " if (__n > __CAP__) { s.group.phase = 'paused'; return ''; }"
        + " return member.name === 'A' ? '交给 B，@B 继续' : '交给 A，@A 继续'; };");
  vmRun("AppState = { currentSessionId: 's1' };");
  const s = vmRun("sessions[0]");
  const t0 = Date.now();
  await vmRun("groupSpeak(sessions[0], sessions[0].group.members[0])");
  const pushed = vmRun("globalThis.__pushed || []");
  return {
    round: s.group.round,
    phase: s.group.phase,
    ms: Date.now() - t0,
    capHits: pushed.filter(function(p){ return /上限/.test(p.text); }).length,
    turns: pushed.filter(function(p){ return p.member; }).length,
    tail: pushed.slice(-2).map(function(p){ return p.text.slice(0, 40); })
  };
}
""").replace('__CAP__', str(rounds_cap))


def test_relay_runs_past_24_rounds_without_pausing():
    result = _run_node(_env(60), 'group_unlimited')
    assert result['round'] >= 60, result
    assert result['turns'] >= 60, result
    assert result['capHits'] == 0, result


def test_relay_stops_immediately_when_host_pauses():
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
  // 第 5 轮模拟群主点「暂停接力」
  vmRun("let __n = 0; groupCallModel = async function(s, member){ __n++;"
        + " if (__n === 5) { s.group.phase = 'paused'; }"
        + " return member.name === 'A' ? '@B 继续' : '@A 继续'; };");
  const s = vmRun("sessions[0]");
  await vmRun("groupSpeak(sessions[0], sessions[0].group.members[0])");
  return {round: s.group.round, phase: s.group.phase};
}
""", 'group_pause')
    assert result['phase'] == 'paused'
    assert 4 <= result['round'] <= 7, result


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
  vmRun("let __n = 0; groupCallModel = async function(s, member){ __n++;"
        + " if (__n > 6) { s.group.phase = 'paused'; return ''; }"
        + " return member.name === 'A' ? '@B 继续' : '@A 继续'; };");
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
    assert result['calls'] == result['round'] + 1 or result['calls'] <= result['round'] + 1, result
    # R31：busy 标记由 Set 承载，链结束后应为空
    assert result['busy'] == 0, result


def test_no_turn_budget_left_in_source_or_bundle():
    assert 'turnBudget' not in GROUP.read_text(encoding='utf-8')
    if BUNDLE.is_file():
        assert 'turnBudget' not in BUNDLE.read_text(encoding='utf-8', errors='replace')
