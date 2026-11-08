# -*- coding: utf-8 -*-
"""R35 · 功能市场三条用户实测反馈的回归测试。

1) 「怎么有的是英语的」→ 目录所有条目 desc 必须含中文；
2) 「技能和连接器不全」→ 全量快照入库、数量达标、分页能翻到末页；
3) 「这些连接器真的可以用吗」→ 启用真的注册 MCP 配置，可用性如实分级，
   仅目录项不谎报可用，会话里选中连接器会注入非空指令。
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node') or str(Path(
    'C:/Users/陈/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'))
CJK = re.compile(r'[\u4e00-\u9fff]')
CATALOG_JS = ROOT / 'frontend' / 'src' / 'shell' / 'hub-catalog.js'
SNAPSHOT = ROOT / 'tools' / 'data' / 'hub-market-snapshot.json'
FILES = [
    ROOT / 'frontend' / 'src' / 'shell' / 'hub-catalog.js',
    ROOT / 'frontend' / 'src' / 'shell' / 'hub-connector.js',
    ROOT / 'frontend' / 'src' / 'shell' / 'composer-hub.js',
    ROOT / 'frontend' / 'src' / 'shell' / 'hub-market.js',
]


def _catalog():
    src = CATALOG_JS.read_text(encoding='utf-8')
    m = re.search(r'const HUB_CATALOG = (\{.*\});\s*\n', src, re.S)
    assert m, 'hub-catalog.js 结构异常'
    return json.loads(m.group(1))


def test_snapshot_is_offline_and_complete():
    """全量快照必须入库、离线自包含，且远多于 R32 的本机缓存。"""
    assert SNAPSHOT.is_file(), '缺少 tools/data/hub-market-snapshot.json'
    d = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    assert len(d['connectors']) >= 600, '连接器未采集在线全量'
    assert len(d['skills']) >= 100, 'SkillHub 中文热门技能缺失'
    assert len(d['skillCategories']) >= 16
    assert sum(1 for x in d['connectors'] if x.get('mcp')) >= 500


def test_all_catalog_descriptions_are_chinese():
    """用户反馈①：市场里不该出现纯英文描述卡片。"""
    c = _catalog()
    pools = c['experts'] + c['teams'] + c['skills'] + c['connectors']
    bad = [x['id'] for x in pools if not CJK.search(str(x.get('desc') or ''))]
    assert not bad, '仍有英文描述: ' + ', '.join(bad[:12])
    zh_names = sum(1 for x in c['connectors'] if CJK.search(x['name']))
    assert zh_names == len(c['connectors']), ('仍有英文连接器名: %d/%d'
                                              % (zh_names, len(c['connectors'])))


def test_catalog_sizes_and_sections():
    """用户反馈②：技能与连接器数量、分区、使用量都要真实齐全。"""
    c = _catalog()
    assert len(c['skills']) >= 350
    assert len(c['skillCategories']) >= 16
    assert len(c['categories']) == 15
    assert any(x.get('uses', 0) > 100000 for x in c['skills']), '技能缺真实使用量'
    assert c['skills'][0].get('uses', 0) > 0


def test_only_probe_verified_direct_connectors_remain():
    """用户收口要求：不能直连的直接去掉 —— 目录里只剩实测可匿名的端点。

    504 个 HTTP 端点实测仅 59 个能匿名握手，其余 401/403（WorkBuddy 靠自家
    账号会话注入凭证，Harbor 没有该登录态）。目录不得保留这些占位卡片。
    """
    c = _catalog()
    probe = json.loads((ROOT / 'tools' / 'data' / 'hub-mcp-probe.json')
                       .read_text(encoding='utf-8'))
    ok_ids = set(probe['okIds'])
    assert len(c['connectors']) >= 40, '实测可直连连接器几乎被清空'
    for x in c['connectors']:
        assert x['link'] == 'ready', '仍残留非直连条目: %s (%s)' % (x['id'], x['link'])
        assert x['id'] in ok_ids, '未经实测握手成功却标为可直连: ' + x['id']
        assert x.get('mcp'), '可直连项必须有 MCP 配置'
        assert CJK.search(x['desc']) and CJK.search(x['directive'])
    # 未通过实测的知名端点不得出现在市场
    by_id = {x['id'] for x in c['connectors']}
    assert 'github' not in by_id and 'notion' not in by_id, '401 的端点不该留在市场'


def test_connector_prompt_is_not_empty():
    """hubCatalogPrompt 对连接器不再返回空串（R33 的占位行为）。"""
    c = _catalog()
    conn = next(x for x in c['connectors'] if x['link'] == 'ready')
    src = CATALOG_JS.read_text(encoding='utf-8')
    assert "if (!item || item.kind === 'connector') return ''" not in src
    p = ROOT / 'outputs' / 'r35_prompt_check.js'
    p.parent.mkdir(exist_ok=True)
    expr = 'hubCatalogPrompt(hubCatalogById("connectors", %s))' % json.dumps(conn['id'])
    p.write_text(
        'const vm=require("vm"); const ctx={}; vm.createContext(ctx);\n'
        + 'const SRC = ' + json.dumps(src) + ';\n'
        + 'const TAIL = ' + json.dumps('globalThis.__r = ' + expr + ';') + ';\n'
        + 'vm.runInContext(SRC + "\\n" + TAIL, ctx);\n'
        + 'process.stdout.write(ctx.__r);\n', encoding='utf-8')
    r = subprocess.run([NODE, str(p)], capture_output=True, text=True,
                       encoding='utf-8', timeout=60)
    assert r.returncode == 0, r.stderr[-1000:]
    assert '已启用' in r.stdout and 'mcp__' in r.stdout, r.stdout[:300]


# vm 沙箱：把四个模块按顺序拼成一段脚本，再跑一段 async 主体。
HARNESS = r'''
const vm = require('vm');
const store = {}, calls = [], toasts = [];
const localStorage = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; },
  setItem(k,v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }
};
const els = {};
function mk(){ return {
  hidden:false, innerHTML:'', value:'', textContent:'', placeholder:'', dataset:{},
  classList:{add(){},remove(){},toggle(){}}, addEventListener(){}, setAttribute(){},
  querySelectorAll(){return []}, click(){}, focus(){}, dispatchEvent(){},
  scrollIntoView(){}, scrollTo(){}, closest(){return null} }; }
const document = {
  getElementById(id){ return els[id] || (els[id] = mk()); },
  querySelectorAll(){ return []; }, addEventListener(){}, querySelector(){ return null; }
};
async function callApi(name, args){
  calls.push({name:name, args:args||[]});
  if (name === 'mcp_list_servers') return JSON.stringify({servers:[]});
  if (name === 'mcp_import_claude') return JSON.stringify({imported:['s'],skipped:[],total:1});
  if (name === 'mcp_save_server') return JSON.stringify({ok:true,tools:[{name:'t1'},{name:'t2'}]});
  return JSON.stringify({ok:true});
}
const ctx = { document, localStorage, console, window:{}, callApi,
  calls, toasts, store, els,
  AppState:{ currentSessionId:'S1' }, currentSessionId:'S1',
  Event: function(t){ this.type=t; }, toast: function(m,k){ toasts.push(m+'|'+k); },
  Math, JSON, Number, String, Array, Object, Date, RegExp, Promise,
  setInterval: ()=>1, clearInterval: ()=>{} };
vm.createContext(ctx);
const BUNDLE = %s;
const BODY = %s;
const EXPR = %s;
const CODE = BUNDLE + '\n' + '(async function(){' + BODY +
  '\nglobalThis.__result = JSON.stringify(' + EXPR + '); })().catch(e => {' +
  'globalThis.__result = JSON.stringify({__error:String(e&&e.stack||e)}); });';
vm.runInContext(CODE, ctx, { timeout: 20000 });
const wait = setInterval(()=>{ if (ctx.__result !== undefined){
  clearInterval(wait); process.stdout.write(ctx.__result); } }, 10);
'''

_N = [0]


def _run(tmp_path, body, result_expr='__out'):
    parts = [json.dumps(f.read_text(encoding='utf-8')) for f in FILES]
    bundle = " + '\\n' + ".join(parts)
    _N[0] += 1
    js = tmp_path / ('r35_vm_%d.js' % _N[0])
    js.write_text(HARNESS % (bundle, json.dumps(body), json.dumps(result_expr)),
                  encoding='utf-8')
    p = subprocess.run([NODE, str(js)], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', timeout=90)
    assert p.returncode == 0, (p.stderr or '')[-2500:]
    out = json.loads(p.stdout)
    assert '__error' not in out, out.get('__error')
    return out


def test_pagination_reaches_all_connectors(tmp_path):
    """分页功能可用（连接器收口后只剩 50 项，用技能池验证翻页到末页）。"""
    out = _run(tmp_path, r'''
const __out = {};
hubOpenMarket('skill');
const foot1 = document.getElementById('hmFoot').innerHTML;
const m = /1 \/ (\d+)/.exec(foot1);
__out.pages = m ? Number(m[1]) : 0;
__out.firstCards = (document.getElementById('hmGrid').innerHTML.match(/class="hm-card"/g)||[]).length;
__out.total = HUB_CATALOG.skills.length;
hubSetMarketPage(__out.pages);
__out.lastFoot = document.getElementById('hmFoot').innerHTML;
__out.lastCards = (document.getElementById('hmGrid').innerHTML.match(/class="hm-card"/g)||[]).length;
hubOpenMarket('connector');
__out.linkStat = document.getElementById('hmLinkStat').textContent;
__out.connCards = (document.getElementById('hmGrid').innerHTML.match(/class="hm-card"/g)||[]).length;
''')
    assert out['pages'] >= 8, out
    assert out['firstCards'] == 48
    assert out['lastCards'] > 0
    assert '已实测可直连' in out['linkStat']
    assert out['connCards'] > 0


def test_connector_cards_show_honest_status(tmp_path):
    """卡片统一显示「实测可直连」状态，并给测试连接入口。"""
    out = _run(tmp_path, r'''
const __out = {};
hubOpenMarket('connector');
const html = document.getElementById('hmGrid').innerHTML;
__out.hasLink = /hm-link-/.test(html);
__out.hasTest = /data-hm-test=/.test(html);
__out.hasCJK = /[\u4e00-\u9fff]/.test(html);
__out.noCatalog = html.indexOf('仅目录') < 0 && html.indexOf('需授权') < 0;
__out.allReady = (html.match(/可直连/g)||[]).length;
''')
    assert out['hasLink'] and out['hasTest'] and out['hasCJK']
    assert out['noCatalog'], '市场里不该残留非直连卡片'
    assert out['allReady'] > 0


def test_enable_connector_really_registers_mcp(tmp_path):
    """用户反馈③：点「启用」真的调用 mcp_import_claude / mcp_save_server。"""
    out = _run(tmp_path, r'''
const __out = {};
const target = HUB_CATALOG.connectors.find(x=>x.link==='ready' && x.mcp);
__out.id = target.id;
const on = hubToggleEnabled('connectors', target.id);
await hubConnectorInstall(target.id);
__out.enabled = on;
__out.calls = calls.map(c=>c.name);
__out.state = hubConnState(target.id);
__out.meta = hubConnCardMeta(target);
''')
    assert out['enabled'] is True
    assert 'mcp_import_claude' in out['calls']
    assert 'mcp_save_server' in out['calls']
    assert out['state']['ok'] is True
    assert out['state']['tools'] >= 1
    assert '已接入' in out['meta']['text']


def test_removed_connectors_cannot_be_enabled(tmp_path):
    """被移除的非直连端点：目录查不到，也不触发任何 MCP 注册。"""
    out = _run(tmp_path, r'''
const __out = {};
__out.github = hubCatalogById('connectors','github');
__out.result = await hubConnectorInstall('github');
__out.calls = calls.map(c=>c.name);
''')
    assert out['github'] is None
    assert out['result']['ok'] is False
    assert 'mcp_save_server' not in out['calls']


def test_session_pick_injects_connector_directive(tmp_path):
    """会话「+」里选中连接器 → 注入非空指令（不再是跳设置页占位）。"""
    out = _run(tmp_path, r'''
const __out = {};
const target = HUB_CATALOG.connectors.find(x=>x.link==='ready' && x.mcp);
hubEnabledSave({experts:[],teams:[],skills:[],connectors:[target.id]});
__out.picked = hubPick('connectors', target.id);
__out.directive = hubDirectiveFor('S1');
__out.chip = document.getElementById('hubChip').innerHTML;
''')
    assert out['picked'] is True
    assert '已启用' in out['directive'] and 'mcp__' in out['directive']
    assert '连接器' in out['chip']


def test_no_new_js_api_and_no_config_pollution():
    """工程铁律：不新增 js_api 方法、不写 config.json、新增状态用独立 key。"""
    api = (ROOT / 'backend' / 'api.py').read_text(encoding='utf-8')
    for name in ('mcp_import_claude', 'mcp_save_server', 'mcp_list_servers'):
        assert name in api, '不应新增后端方法，应复用既有隐身方法: ' + name
    conn = (ROOT / 'frontend' / 'src' / 'shell' / 'hub-connector.js').read_text(encoding='utf-8')
    assert "save_config" not in conn, '接入状态不得写 config.json'
    assert "HUB_CONN_KEY = 'harbor_hub_connector_state'" in conn
