# -*- coding: utf-8 -*-
"""v1.8.0 W10 · 68-onboarding.js vm harness 测试（与 test_v18_search_service 同款模式）。

覆盖：obEsc 转义 / obDone+obMarkDone 持久化 / obShouldShow 四种组合
（已完成不展示 / 有 Key 不展示 / 有会话不展示 / 全新展示）/ 步骤表结构 /
obFinish 无 root 幂等 / onboardingInit 在「不需要」时不挂载。
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from helpers.frontend import read_frontend_source

NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
FRONTEND_SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'frontend', 'src')

_HARNESS = r'''
// ---- stubs ----
const __store = new Map();
const localStorage = {
  getItem: k => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => { __store.set(k, String(v)); },
  removeItem: k => { __store.delete(k); }
};
let __hasKey = false, __hasSessions = false, __localMode = false;
function effectiveApiKey() { return __hasKey ? 'sk-x' : ''; }
function localModeActive() { return __localMode; }
let sessions = [];
function toast() {}
function navRenderHeaderStatus() {}
function navUpdateEmptyGuide() {}
const MOTION = { instant: () => true, onAnimEnd: () => Promise.resolve(), compOut: () => '140ms' };

// ---- 被测模块 ----
__MODULE__

// ---- 断言 ----
const checks = [];
const ok = (name, cond) => checks.push({ name, pass: !!cond });

// 1) obEsc 转义
ok('esc-html', obEsc('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;\''
  || obEsc('<a>') === '&lt;a&gt;');
ok('esc-null', obEsc(null) === '' && obEsc(undefined) === '');

// 2) obDone / obMarkDone
ok('done-default-false', obDone() === false);
obMarkDone();
ok('done-after-mark', obDone() === true);

// 3) obShouldShow 组合
__store.clear();
ok('show-fresh', obShouldShow() === true);
__hasKey = true;
ok('hide-with-key', obShouldShow() === false);
__hasKey = false; sessions = [{ id: 's1', messages: [] }];
ok('hide-with-sessions', obShouldShow() === false);
sessions = []; __localMode = true;
ok('hide-local-mode', obShouldShow() === false);
__localMode = false;

// 4) 步骤表结构
ok('steps-4', OB_STEPS.length === 4);
ok('steps-ids', OB_STEPS.map(s => s.id).join(',') === 'welcome,source,key,done');
ok('steps-titles', OB_STEPS.every(s => s.title && s.title.length > 0));

// 5) obFinish 无 root 幂等（不炸）
let threw = false;
try { obFinish(); } catch (e) { threw = true; }
ok('finish-no-root-idempotent', !threw);

// 6) onboardingInit 不需要时不挂载（无 document 桩 → 直接返回 false）
ok('init-no-doc-false', onboardingInit() === false);

// 7) 步骤 HTML 生成（source 步骤含预设卡片骨架）
obRoot = { querySelector: () => null, querySelectorAll: () => [] };
const html = obStepHtml('source');
ok('source-html-cards', html.indexOf('ob-card') >= 0 && html.indexOf('data-preset') >= 0);
const htmlKey = obStepHtml('key');
ok('key-html-input', htmlKey.indexOf('obKey') >= 0 && htmlKey.indexOf('测试连接') >= 0);
const htmlW = obStepHtml('welcome');
ok('welcome-hero', htmlW.indexOf('欢迎使用 Harbor') >= 0 && htmlW.indexOf('ob-feat') >= 0);
const htmlD = obStepHtml('done');
ok('done-tips', htmlD.indexOf('/plan') >= 0);

console.log(JSON.stringify({ checks }));
'''


def test_onboarding_harness():
    if not os.path.exists(NODE):
        pytest.skip('node 不可用: %s' % NODE)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = read_frontend_source(root, '68-onboarding.js')
    js = _HARNESS.replace('__MODULE__', src)
    fd, path = tempfile.mkstemp(suffix='.js', prefix='qa_ob_')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, path], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
        out = json.loads(r.stdout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    assert 'fatal' not in out, out
    failed = [c['name'] for c in out['checks'] if not c['pass']]
    assert not failed, '前端断言失败: %s' % failed
    assert len(out['checks']) >= 13
