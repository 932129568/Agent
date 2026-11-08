# -*- coding: utf-8 -*-
"""R33：会话删除墓碑、上传合并、功能市场与「启用后才进加号菜单」回归。"""
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
CATALOG = ROOT / 'frontend' / 'src' / 'shell' / 'hub-catalog.js'
COMPOSER = ROOT / 'frontend' / 'src' / 'shell' / 'composer-hub.js'
MARKET = ROOT / 'frontend' / 'src' / 'shell' / 'hub-market.js'

VM_HARNESS = r'''
const vm = require('vm'), fs = require('fs');
const store = {};
const localStorage = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; },
  setItem(k,v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }
};
const els = {};
function mk(){ return {
  hidden:false, innerHTML:'', value:'', textContent:'', placeholder:'', dataset:{},
  classList:{add(){},remove(){},toggle(){}}, addEventListener(){}, setAttribute(){},
  querySelectorAll(){return []}, click(){}, focus(){}, dispatchEvent(){},
  scrollIntoView(){}, closest(){return null} }; }
const document = {
  getElementById(id){ return els[id] || (els[id] = mk()); },
  querySelectorAll(){ return []; }, addEventListener(){}, querySelector(){ return null; }
};
const ctx = {
  document, localStorage, console, window:{},
  AppState:{ currentSessionId:'S1', isStreaming:false }, currentSessionId:'S1',
  Event: function(t){ this.type = t; }, toast: function(){},
  Math, JSON, Number, String, Array, Object, Date, RegExp, Promise,
  setInterval: ()=>1, clearInterval: ()=>{},
};
vm.createContext(ctx);
vm.runInContext(%s + '\n' + %s + '\n' + %s + '\n' + %s +
  '\nglobalThis.__result = JSON.stringify(__out);\n', ctx, { timeout: 20000 });
process.stdout.write(ctx.__result);
'''


def _vm(body, tmp_path):
    src = VM_HARNESS % (json.dumps(CATALOG.read_text(encoding='utf-8')),
                        json.dumps(COMPOSER.read_text(encoding='utf-8')),
                        json.dumps(MARKET.read_text(encoding='utf-8')),
                        json.dumps(body))
    js = tmp_path / 'r33_vm.js'
    js.write_text(src, encoding='utf-8')
    p = subprocess.run([NODE, str(js)], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', timeout=90)
    assert p.returncode == 0, p.stderr[-2000:]
    return json.loads(p.stdout)


# ---------------------------------------------------------------- ① 会话墓碑
def test_deleted_session_tombstone_blocks_legacy_resurrection():
    migrate = (ROOT / 'server' / 'src' / 'services' / 'session-migrate.js').read_text(encoding='utf-8')
    provider = (ROOT / 'server' / 'src' / 'services' / 'provider.js').read_text(encoding='utf-8')
    sessions = (ROOT / 'server' / 'src' / 'services' / 'sessions.js').read_text(encoding='utf-8')
    assert "export const DELETED_IDS_FILE = 'deleted_session_ids.json'" in migrate
    assert 'export function rememberDeletedId' in migrate
    assert 'export function readDeletedIds' in migrate
    assert 'skipIds = []' in migrate and 'skip.has(String(item.id))' in migrate
    assert "skipIds: readDeletedIds()" in migrate, '启动导入未接墓碑'
    assert 'rememberDeletedId(sid)' in provider, '真删未写墓碑'
    assert 'deleted.has(String(entry.id))' in sessions, '全量回写未过滤墓碑'
    # 三处都要在删除主链路里
    assert provider.index('rememberDeletedId(sid)') < provider.index('prisma.session.delete')


# ---------------------------------------------------------------- ② 上传合并
def test_upload_is_single_entry_without_format_limit():
    tpl = (ROOT / 'frontend' / 'index.template.html').read_text(encoding='utf-8')
    composer = (ROOT / 'frontend' / 'src' / 'chat' / 'composer.js').read_text(encoding='utf-8')
    assert '<b>上传文件</b>' in tpl
    assert "label: '上传文件'" in composer
    assert re.search(r'const PLUS_ITEMS = \[[^]]*\]', composer, re.S).group(0).count('key:') == 1
    tag = re.search(r'<input[^>]*id="unifiedFileInput"[^>]*>', tpl, re.S).group(0)
    assert 'accept=' not in tag, '仍有格式限制'
    assert 'hubToggleMenu()' in composer, '旧 + 未统一到同一套菜单'
    # 旧分类菜单不再作为可见入口
    assert "label: '图片'" not in composer and "label: '压缩包 (zip)'" not in composer


def test_any_file_becomes_attachment(tmp_path):
    att = (ROOT / 'frontend' / 'src' / 'chat' / 'attachments.js').read_text(encoding='utf-8')
    send = (ROOT / 'frontend' / 'src' / 'chat' / 'send.js').read_text(encoding='utf-8')
    assert "return 'file';   // R33" in att
    assert "groups.file.forEach" in att and "type: 'file'" in att
    assert "otherFiles = currentAttachments.filter(a => a.type === 'file')" in send
    assert '[附件文件]' in send
    # 纯函数：任意后缀都能分派为可上传文件
    js = tmp_path / 'r33_kind.js'
    js.write_text(
        'const vm=require("vm");const ctx={console,Math,JSON,Number,String,Array,Object,Date,RegExp,'
        'TextDecoder,Uint8Array,ArrayBuffer,Promise,parseInt,parseFloat,'
        'document:{getElementById:()=>null},setInterval:()=>1,clearInterval:()=>{}};'
        'vm.createContext(ctx);vm.runInContext(' + json.dumps(att) + ',ctx,{timeout:10000});'
        'const out={};for(const n of ["a.md","a.ppt","a.pptx","a.pdf","a.docx","a.mp3","a.exe",'
        '"a.png","a.zip","a.ts"]) out[n]=ctx.hubFileKind({name:n,type:""});'
        'process.stdout.write(JSON.stringify(out));', encoding='utf-8')
    p = subprocess.run([NODE, str(js)], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', timeout=60)
    assert p.returncode == 0, p.stderr[-1200:]
    kinds = json.loads(p.stdout)
    assert kinds['a.md'] == 'text' and kinds['a.ts'] == 'text'
    assert kinds['a.png'] == 'image' and kinds['a.zip'] == 'zip'
    for n in ('a.ppt', 'a.pptx', 'a.pdf', 'a.docx', 'a.mp3', 'a.exe'):
        assert kinds[n] == 'file', '%s 未接纳' % n


# ---------------------------------------------------------------- ③ 功能市场入口与页面
def test_market_entry_and_page_dom():
    tpl = (ROOT / 'frontend' / 'index.template.html').read_text(encoding='utf-8')
    assert 'data-tip="功能市场"' in tpl and 'aria-label="功能市场"' in tpl
    assert 'id="expertCenterBtn"' in tpl and '<use href="#i-market"/>' in tpl
    assert '<symbol id="i-market"' in tpl
    assert '>E</span></button>' not in tpl, '字母 E 图标仍存在'
    for dom in ('hubMarket', 'hmTabs', 'hmSearch', 'hmMine', 'hmHot', 'hmCats',
                'hmSorts', 'hmSubtabs', 'hmGrid', 'hmFoot', 'hmClose'):
        assert 'id="%s"' % dom in tpl, '市场页缺少 ' + dom
    center = (ROOT / 'frontend' / 'src' / 'expert' / 'center.js').read_text(encoding='utf-8')
    assert "hubOpenMarket('expert')" in center
    m = json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    # R35 起模块数随功能扩容（新增 hub-connector.js），这里校验下限与关键模块在列，
    # 不再写死总数，避免每次新增模块都要改旧断言。
    assert len(m['scripts']) >= 114 and len(m['styles']) == 14
    by_path = {e['path'] for e in m['scripts']}
    assert 'frontend/src/shell/hub-connector.js' in by_path
    by = {e['path']: e for e in m['scripts']}
    for sym in ('hubOpenMarket', 'hubToggleEnabled', 'hubEnabledItems', 'hubRenderMarket'):
        assert sym in by['frontend/src/shell/hub-market.js']['provides']


# ---------------------------------------------------------------- ④ 启用后才显示（真实调用）
def test_enable_gates_plus_menu_and_directive(tmp_path):
    out = _vm(r'''
const __out = {};
__out.initialEnabled = hubEnabledItems('experts').length;
// 未启用时子面板给引导入口，且 hubPick 拒绝
HUB_STATE.sub = 'expert';
hubRenderSub();
__out.emptyHasMarketLink = document.getElementById('hubList').innerHTML.indexOf('去功能市场启用') >= 0;
__out.pickBlockedBeforeEnable = hubPick('experts', 'SeniorDeveloper') === false;
// 市场页可打开且渲染出全量条目
hubOpenMarket('expert');
__out.marketOpen = document.getElementById('hubMarket').hidden === false;
__out.marketHasCards = document.getElementById('hmGrid').innerHTML.indexOf('hm-enable') >= 0;
__out.hotCards = (document.getElementById('hmHot').innerHTML.match(/hm-hot-card/g) || []).length;
__out.cats = (document.getElementById('hmCats').innerHTML.match(/hm-cat/g) || []).length;
// 点启用 -> 只显示已启用项 -> 可以选中 -> 指令真实注入
__out.toggledOn = hubToggleEnabled('experts', 'SeniorDeveloper') === true;
__out.enabledItems = hubEnabledItems('experts').map(x => x.id);
HUB_STATE.sub = 'expert'; HUB_STATE.query = '';
hubRenderSub();
__out.subShowsEnabled = document.getElementById('hubList').innerHTML.indexOf('高级开发工程师') >= 0;
__out.subHidesOthers = document.getElementById('hubList').innerHTML.indexOf('UI设计师') < 0;
__out.pickAfterEnable = hubPick('experts', 'SeniorDeveloper') === true;
__out.directiveInjected = hubDirectiveFor().length > 500;
// 分类/搜索/排序/我的功能切换不抛异常
hubSetMarketCat('技术工程'); hubSetMarketSort('最热'); hubSetMarketQuery('开发');
hubToggleMine(); hubSetMarketTab('skill'); hubSetMarketSub('skills');
__out.marketOpsOk = true;
// 停用 -> 选择态与指令一并清除
__out.toggledOff = hubToggleEnabled('experts', 'SeniorDeveloper') === false;
__out.directiveCleared = hubDirectiveFor() === '';
__out.emptyAgain = hubEnabledItems('experts').length === 0;
''', tmp_path)
    assert out['initialEnabled'] == 0
    assert out['emptyHasMarketLink'] and out['pickBlockedBeforeEnable']
    assert out['marketOpen'] and out['marketHasCards']
    assert out['hotCards'] == 5 and out['cats'] >= 15
    assert out['toggledOn'] and out['enabledItems'] == ['SeniorDeveloper']
    assert out['subShowsEnabled'] and out['subHidesOthers']
    assert out['pickAfterEnable'] and out['directiveInjected']
    assert out['marketOpsOk']
    assert out['toggledOff'] and out['directiveCleared'] and out['emptyAgain']
