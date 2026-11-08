# -*- coding: utf-8 -*-
"""R34：功能市场切到「技能 / 连接器」分区不能为空（用户实测回归）。

根因：分类标签写死 15 个专家分类，切 tab 时旧分区（如「技术工程」）仍生效，
而技能/连接器的 section 完全不同，被筛成 0 项。
"""
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
FILES = [
    ROOT / 'frontend' / 'src' / 'shell' / 'hub-catalog.js',
    ROOT / 'frontend' / 'src' / 'shell' / 'composer-hub.js',
    ROOT / 'frontend' / 'src' / 'shell' / 'hub-market.js',
]

HARNESS = r'''
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
const ctx = { document, localStorage, console, window:{},
  AppState:{ currentSessionId:'S1' }, currentSessionId:'S1',
  Event: function(t){ this.type=t; }, toast: function(){},
  Math, JSON, Number, String, Array, Object, Date, RegExp, Promise,
  setInterval: ()=>1, clearInterval: ()=>{} };
vm.createContext(ctx);
vm.runInContext(%s + '\n' + %s + '\n' + %s + '\n' + %s +
  '\nglobalThis.__result = JSON.stringify(__out);\n', ctx, { timeout: 20000 });
process.stdout.write(ctx.__result);
'''


def _vm(body, tmp_path):
    src = HARNESS % (json.dumps(FILES[0].read_text(encoding='utf-8')),
                     json.dumps(FILES[1].read_text(encoding='utf-8')),
                     json.dumps(FILES[2].read_text(encoding='utf-8')),
                     json.dumps(body))
    js = tmp_path / 'r34_vm.js'
    js.write_text(src, encoding='utf-8')
    p = subprocess.run([NODE, str(js)], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', timeout=90)
    assert p.returncode == 0, p.stderr[-2000:]
    return json.loads(p.stdout)


def test_switching_tabs_resets_filters_and_shows_items(tmp_path):
    out = _vm(r'''
const __out = {};
const grid = () => document.getElementById('hmGrid').innerHTML;
const cats = () => document.getElementById('hmCats').innerHTML;
const foot = () => document.getElementById('hmFoot').innerHTML;

// 用户实测场景：专家页先选中「技术工程」
hubOpenMarket('expert');
hubSetMarketCat('技术工程');
__out.expertCat = HUB_MARKET_STATE.cat;
__out.expertHasCards = grid().indexOf('hm-enable') >= 0;
__out.expertCats = (cats().match(/hm-cat/g) || []).length;

// 切「技能」：分区必须重置、网格不能空、标签换成技能自己的分区
hubSetMarketTab('skill');
__out.skillCat = HUB_MARKET_STATE.cat;
__out.skillQuery = HUB_MARKET_STATE.q;
__out.skillCards = (grid().match(/hm-enable/g) || []).length;
__out.skillTotal = foot().indexOf('共 292 项') >= 0;
__out.skillCatsHaveMarket = cats().indexOf('开发者插件市场') >= 0 &&
                            cats().indexOf('官方内置') >= 0;
__out.skillCatsNoExpertCat = cats().indexOf('技术工程') < 0;
__out.skillSections = hubMarketSections();

// 技能分区可点且有内容
hubSetMarketCat('官方内置');
__out.skillFilteredCards = (grid().match(/hm-enable/g) || []).length;

// 切「连接器」：17 项、分区为「官方连接器」
hubSetMarketTab('connector');
__out.connectorCat = HUB_MARKET_STATE.cat;
__out.connectorCards = (grid().match(/hm-enable/g) || []).length;
__out.connectorTotal = foot().indexOf('共 17 项') >= 0;
__out.connectorCats = cats().indexOf('官方连接器') >= 0;

// 切回专家：15 个官方分类回来
hubSetMarketTab('expert');
__out.backExpertCards = (grid().match(/hm-enable/g) || []).length;
__out.backExpertCats = cats().indexOf('技术工程') >= 0;

// 防御：残留的非法分区自动回落「全部」，不再空页
HUB_MARKET_STATE.cat = '技术工程';
hubSetMarketTab('skill');
__out.defensiveReset = HUB_MARKET_STATE.cat;
__out.defensiveNonEmpty = grid().indexOf('hm-enable') >= 0;
''', tmp_path)
    assert out['expertCat'] == '技术工程' and out['expertHasCards']
    assert out['expertCats'] >= 15
    assert out['skillCat'] == '全部' and out['skillQuery'] == ''
    assert out['skillCards'] > 0 and out['skillTotal'], '技能页仍为空'
    assert out['skillCatsHaveMarket'] and out['skillCatsNoExpertCat']
    assert '官方内置' in out['skillSections'] and '开发者插件市场' in out['skillSections']
    assert out['skillFilteredCards'] > 0
    assert out['connectorCat'] == '全部'
    assert out['connectorCards'] > 0 and out['connectorTotal'], '连接器页仍为空'
    assert out['connectorCats']
    assert out['backExpertCards'] > 0 and out['backExpertCats']
    assert out['defensiveReset'] == '全部' and out['defensiveNonEmpty']


def test_manifest_registers_new_symbol():
    import json as _json
    m = _json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    entry = next(e for e in m['scripts']
                 if e['path'] == 'frontend/src/shell/hub-market.js')
    assert 'hubMarketSections' in entry['provides']
    assert len(m['scripts']) == 114 and len(m['styles']) == 14
