# -*- coding: utf-8 -*-
"""R32：WorkBuddy 市场全量内置目录 + 加号菜单 + 统一附件入口的行为回归。

验收重点（用户明确要求「不只是检索到，点了我真的可以用」）：
1. 目录覆盖市场全量：专家/专家团/技能/连接器/分类/热门；
2. 每一项都有可注入的真实角色/工作流指令（不是一句描述）；
3. 选中 -> hubDirectiveFor() 返回指令 -> 系统提示注入链路存在且按会话隔离；
4. 统一文件入口覆盖更多格式并正确分派；
5. 旧 DOM/契约兼容面保留，UI 契约只增不改。
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
CATALOG = ROOT / 'frontend' / 'src' / 'shell' / 'hub-catalog.js'
COMPOSER = ROOT / 'frontend' / 'src' / 'shell' / 'composer-hub.js'
STUB = r'''
const vm = require('vm'), fs = require('fs');
const CAT = %s, CMP = %s, BODY = %s;
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
  document, console, window:{}, AppState:{ currentSessionId:'S1', isStreaming:false },
  currentSessionId:'S1', Event: function(t){ this.type = t; },
  toast: function(){}, Math, JSON, Number, String, Array, Object, Date, RegExp,
  setInterval: ()=>1, clearInterval: ()=>{}, TextDecoder, TextEncoder,
  Uint8Array, ArrayBuffer, Promise, parseInt, parseFloat,
};
vm.createContext(ctx);
// 数据/交互/测试体必须同一 context：const HUB_CATALOG 不会挂到 ctx 对象上
vm.runInContext(CAT + '\n' + CMP + '\n' + BODY +
  '\nglobalThis.__result = JSON.stringify(__out);\n', ctx, { timeout: 20000 });
process.stdout.write(ctx.__result);
'''


def _vm(body, tmp_path):
    """把数据模块 + 交互模块 + 测试体放进同一 vm context 执行。"""
    src = STUB % (json.dumps(CATALOG.read_text(encoding='utf-8')),
                  json.dumps(COMPOSER.read_text(encoding='utf-8')),
                  json.dumps(body))
    # 数据模块 1.6MB，不能走 node -e（Windows 命令行长度限制），改用临时文件
    js = tmp_path / 'r32_vm.js'
    js.write_text(src, encoding='utf-8')
    proc = subprocess.run([NODE, str(js)], cwd=ROOT, capture_output=True,
                          text=True, encoding='utf-8', timeout=90)
    assert proc.returncode == 0, proc.stderr[-2000:]
    return json.loads(proc.stdout)


def test_catalog_covers_full_market(tmp_path):
    out = _vm(r'''
const __out = {
  experts: HUB_CATALOG.experts.length,
  teams: HUB_CATALOG.teams.length,
  skills: HUB_CATALOG.skills.length,
  connectors: HUB_CATALOG.connectors.length,
  categories: HUB_CATALOG.categories.length,
  hot: HUB_CATALOG.hotIds.length,
  withDirective: 0, emptyDirective: [],
  senior: hubCatalogById('experts', 'SeniorDeveloper'),
  softwareTeam: hubCatalogById('teams', 'SoftwareCompany'),
  hotFirst: hubCatalogSearch(['experts','teams'], '', 5).map(x => x.name),
  searchSkill: hubCatalogSearch('skills', 'PDF', 5).map(x => x.name),
};
const all = [].concat(HUB_CATALOG.experts, HUB_CATALOG.teams, HUB_CATALOG.skills);
all.forEach(x => {
  if (x.directive && x.directive.length > 120) __out.withDirective++;
  else __out.emptyDirective.push(x.id);
});
''', tmp_path)
    assert out['experts'] >= 390 and out['teams'] >= 50
    assert out['skills'] >= 250 and out['connectors'] >= 15
    assert out['categories'] == 15 and out['hot'] == 60
    # 740 项全部有可注入指令（真实人格/SKILL 原文或结构化角色设定）
    assert out['withDirective'] == out['experts'] + out['teams'] + out['skills']
    assert out['emptyDirective'] == []
    assert '高级开发工程师' in out['hotFirst']
    assert out['softwareTeam']['name'] == '软件开发团队'
    assert out['senior']['directive'].find('Senior Developer') >= 0


def test_pick_really_injects_directive_and_is_session_scoped(tmp_path):
    """点选专家 -> 真实指令注入；切会话不串台；清除后不再注入。"""
    out = _vm(r'''
const __out = {};
hubPick('experts', 'SeniorDeveloper');
const d1 = hubDirectiveFor('S1');
__out.enabled = d1.length > 500 && d1.indexOf('高级开发工程师') >= 0;
__out.hasRealPersona = d1.indexOf('CRITICAL IDENTITY') >= 0 || d1.indexOf('Developer Agent Personality') >= 0;
__out.chipVisible = document.getElementById('hubChip').hidden === false;
__out.chipName = document.getElementById('hubChip').innerHTML.indexOf('高级开发工程师') >= 0;
__out.inputPrefilled = document.getElementById('userInput').value.length > 5;
__out.otherSessionEmpty = hubDirectiveFor('S2') === '';
AppState.currentSessionId = 'S2';
__out.afterSwitchEmpty = hubDirectiveFor() === '';
AppState.currentSessionId = 'S1';
hubClearPick();
__out.afterClearEmpty = hubDirectiveFor() === '';
// 技能同样可注入
hubPick('skills', 'workbuddy-pdf');
const d2 = hubDirectiveFor();
__out.skillEnabled = d2.length > 150 && d2.indexOf('技能') >= 0;
__out.connectorNoDirective = hubCatalogPrompt(hubCatalogById('connectors','github')) === '';  // R35: github 401 已移除
''', tmp_path)
    assert out['enabled'] and out['hasRealPersona'], '选中专家未注入真实人格指令'
    assert out['chipVisible'] and out['chipName'], '启用状态 chip 未显示'
    assert out['inputPrefilled'], '未自动带入角色开场提问'
    assert out['otherSessionEmpty'] and out['afterSwitchEmpty'], '选择态跨会话串台'
    assert out['afterClearEmpty'], '清除后仍在注入'
    assert out['skillEnabled'], '技能点击后未生效'
    assert out['connectorNoDirective'], '非直连端点已从目录移除，不应注入指令'


def test_system_prompt_injection_is_wired():
    rc = (ROOT / 'frontend' / 'src' / 'agent' / 'run-controller.js').read_text(encoding='utf-8')
    assert 'hubDirectiveFor()' in rc
    assert 'const sysPrompt = _hubDirective' in rc
    assert "_baseSys + '\\n\\n' + _hubDirective" in rc
    boot = (ROOT / 'frontend' / 'src' / 'core' / 'bootstrap.js').read_text(encoding='utf-8')
    assert 'hubDispatchFiles' in boot and 'hubInitComposer()' in boot
    ctrl = (ROOT / 'frontend' / 'src' / 'sessions' / 'controller.js').read_text(encoding='utf-8')
    assert 'hubRenderChip()' in ctrl


def test_unified_file_entry_and_more_formats(tmp_path):
    tpl = (ROOT / 'frontend' / 'index.template.html').read_text(encoding='utf-8')
    m = re.search(r'<input[^>]*id="unifiedFileInput"[^>]*>', tpl, re.S)
    assert m, '缺少统一文件入口'
    # R33：不设 accept 限制 —— 所有格式都能上传（含 .md / .ppt / PDF / 音频…）
    tag = m.group(0)
    assert 'accept=' not in tag, '统一入口不应再限制格式'
    assert 'multiple' in tag
    # 附件模块单独装载，避免依赖 handleFiles 等其它符号（hubFileKind 是纯函数）
    att = (ROOT / 'frontend' / 'src' / 'chat' / 'attachments.js').read_text(encoding='utf-8')
    # 上面用 vm 测的是 composer 模块（无 hubFileKind），改在这里单独验证
    js = tmp_path / 'r32_kinds.js'
    js.write_text(
        'const fs=require("fs"),vm=require("vm");\n'
        'const ctx={console,Math,JSON,Number,String,Array,Object,Date,RegExp,'
        'TextDecoder,Uint8Array,ArrayBuffer,Promise,parseInt,parseFloat,'
        'document:{getElementById:()=>null},setInterval:()=>1,clearInterval:()=>{}};\n'
        'vm.createContext(ctx);\n'
        'vm.runInContext(' + json.dumps(att) + ',ctx,{timeout:10000});\n'
        'const cases=' + json.dumps({
            'a.HEIC': {'name': 'a.HEIC', 'type': ''},
            'a.mkv': {'name': 'a.mkv', 'type': ''},
            'a.tar.gz': {'name': 'a.tar.gz', 'type': ''},
            'a.zip': {'name': 'a.zip', 'type': ''},
            'a.ipynb': {'name': 'a.ipynb', 'type': ''},
            'a.graphql': {'name': 'a.graphql', 'type': ''},
            'a.pdf': {'name': 'a.pdf', 'type': 'application/pdf'},
            'a.docx': {'name': 'a.docx', 'type': ''},
            'a.mp3': {'name': 'a.mp3', 'type': 'audio/mpeg'},
            'a.rar': {'name': 'a.rar', 'type': ''},
            'a.png': {'name': 'a.png', 'type': 'image/png'},
        }) + ';\n'
        'const out={}; for(const k in cases) out[k]=ctx.hubFileKind(cases[k]);\n'
        'process.stdout.write(JSON.stringify(out));\n', encoding='utf-8')
    proc = subprocess.run([NODE, str(js)], cwd=ROOT, capture_output=True,
                          text=True, encoding='utf-8', timeout=60)
    assert proc.returncode == 0, proc.stderr[-1500:]
    kinds = json.loads(proc.stdout)
    assert kinds['a.HEIC'] == 'image' and kinds['a.png'] == 'image'
    assert kinds['a.mkv'] == 'video'
    assert kinds['a.tar.gz'] == 'gztar' and kinds['a.zip'] == 'zip'
    assert kinds['a.ipynb'] == 'text' and kinds['a.graphql'] == 'text'
    assert kinds['a.pdf'] == 'file' and kinds['a.docx'] == 'file'
    assert kinds['a.mp3'] == 'file' and kinds['a.rar'] == 'file'


def test_legacy_dom_and_ui_contract_preserved():
    tpl = (ROOT / 'frontend' / 'index.template.html').read_text(encoding='utf-8')
    for dom in ('imgInput', 'vidInput', 'fileInput', 'zipInput',
                'expertPickerBtn', 'userInput', 'sendBtn'):
        assert 'id="%s"' % dom in tpl, '冻结 DOM 丢失: ' + dom
    for fn in ('openNewChatScreen()', 'sendMessage()', 'continueInNewSession()'):
        assert fn in tpl
    for new in ('composerPlusBtn', 'hubMenu', 'hubSubpanel', 'hubList', 'hubMore',
                'hubChip', 'hubAll', 'unifiedFileInput'):
        assert 'id="%s"' % new in tpl, '新界面缺失: ' + new
    for sub in ('data-hub-sub="expert"', 'data-hub-sub="skill"',
                'data-hub-sub="connector"', 'data-hub-sub="mode"'):
        assert sub in tpl
    # 旧的 4 个分类按钮收敛为隐藏的兼容面
    assert 'class="legacy-attach" hidden' in tpl


def test_manifest_registers_new_modules_and_product_contains_them():
    m = json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))
    assert len(m['scripts']) >= 115 and len(m['styles']) == 14
    bypath = {e['path']: e for e in m['scripts']}
    assert 'hubDirectiveFor' in bypath['frontend/src/shell/composer-hub.js']['provides']
    assert 'HUB_CATALOG' in bypath['frontend/src/shell/hub-catalog.js']['provides']
    for sym in ('hubFileKind', 'hubDispatchFiles'):
        assert sym in bypath['frontend/src/chat/attachments.js']['provides']
    html = (ROOT / 'harbor.html').read_text(encoding='utf-8')
    assert 'HUB_CATALOG' in html and 'composerPlusBtn' in html
    assert 'SeniorDeveloper' in html and '软件开发团队' in html
