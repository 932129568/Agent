# -*- coding: utf-8 -*-
"""全入口运行时健康扫描（Round 17）。

对运行中的 Harbor（--remote-debugging-port=<port>）枚举全部可点击入口并逐个
真实点击，捕获每个入口触发的未捕获 JS 异常。静态审计（onclick 函数是否有定义）
是另一回事——本脚本验证的是「点击即报错」的运行时健康。

用法：
  python tools/entry_sweep.py --port 9344 [--json out.json]
  python tools/entry_sweep.py --self-check          # CI：不连 CDP，只校验工具链

退出码：0=全绿 / 1=有 BAD 入口 / 2=CDP 连接失败（CI 据此降级为 self-check）。
CDP 桥：优先用历史注入版（%TEMP% > tests/），干净环境回落到仓库内
tools/cdp_lib.py（R26 新增，复用 perf_cdp 的纯标准库实现，零第三方依赖）。

安全护栏（跳过清单）：删除/解绑/重置/恢复类入口不自动点击——
  session-del、groupMemberDel、gf-item-del、wsQuickUnbind、unbindSession、
  resetAllGuardTrust、webdavRestoreNow、sandboxResetDefaults、mcp_delete、
  software delete、hdDefault（恢复默认目录）。
文件选择器（imgInput.click() 等内联）也跳过——会阻塞在系统对话框。
每击一次后发 Esc 关闭可能弹出的面板/模态，防状态串扰。
"""
import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
# 优先级：历史注入版（%TEMP% > tests/）保持最高；仓库内自包含 tools/cdp_lib.py
# 作为干净 CI 环境的回落。insert(0) 后写的最优先，故顺序与优先级相反。
sys.path.insert(0, _HERE)
sys.path.insert(0, 'tests')
sys.path.insert(0, os.environ.get('TEMP', ''))
from cdp_lib import connect, ev  # noqa: E402

SKIP_PATTERNS = (
    'session-del', 'groupMemberDel', 'gf-item-del', 'wsQuickUnbind',
    'unbindSession', 'resetAllGuardTrust', 'webdavRestoreNow',
    'sandboxResetDefaults', 'mcpDelete', 'mcp_delete', 'swRemove',
    'deleteSession', 'session_purge', 'memoryDel', 'gmDel',
    "getElementById('imgInput')", "getElementById('vidInput')",
    "getElementById('fileInput')", "getElementById('zipInput')",
    'hdDefault', 'checkpoint_rollback', 'rollback',
)

COLLECT = r"""
(function(){
  if (window.__sweepInstalled) return 'already';
  window.__sweepInstalled = true;
  window.__sweepErrors = [];
  window.addEventListener('error', function(e){
    window.__sweepErrors.push(String(e.message || e) + ' @ ' + String(e.filename||'') + ':' + (e.lineno||0));
  });
  window.addEventListener('unhandledrejection', function(e){
    window.__sweepErrors.push('unhandledrejection: ' + String(e.reason || e));
  });
  return 'ok';
})()
"""

ENUM = r"""
(function(){
  const out = [];
  const seen = new Set();
  const nodes = document.querySelectorAll('button, [onclick], [role="button"], .icon-btn');
  nodes.forEach(function(el){
    const onclick = el.getAttribute && el.getAttribute('onclick') || '';
    const label = String((el.textContent || el.getAttribute('aria-label') || el.title || el.id || '')
      .trim()).slice(0, 30);
    const key = onclick + '|' + label + '|' + el.className;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: label, onclick: onclick.slice(0, 120), cls: String(el.className).slice(0, 40), key: key });
  });
  return out;
})()
"""


def self_check():
    """不连 CDP：校验工具链自身完整（CI 降级 / 发版前快速门禁）。"""
    checks = {
        'cdp_lib_loaded': callable(connect) and callable(ev),
        'skip_patterns': len(SKIP_PATTERNS) >= 15,
        'collect_script': 'addEventListener' in COLLECT and '__sweepErrors' in COLLECT,
        'enum_script': 'querySelectorAll' in ENUM,
        'skip_rollback': 'checkpoint_rollback' in SKIP_PATTERNS,
    }
    ok = all(checks.values())
    print('self-check:', json.dumps(checks, ensure_ascii=False))
    print('self-check:', 'OK' if ok else 'FAILED')
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=9344)
    ap.add_argument('--json', default='')
    ap.add_argument('--self-check', action='store_true',
                    help='不连 CDP，只校验工具自身可加载与脚本/护栏完整（CI 降级用）')
    args = ap.parse_args()
    if args.self_check:
        return self_check()

    # 连不上 CDP 与「入口有 BAD」是两回事——退出码 2 供 CI 判定降级
    try:
        st = connect(args.port, timeout=120)
    except Exception as e:
        print('CDP connect failed: %s' % e)
        return 2
    print('error-collector:', ev(st, COLLECT, wait=5))
    entries = ev(st, ENUM, wait=10) or []
    print('entries:', len(entries))

    results = []
    for idx, ent in enumerate(entries):
        marker = ent['onclick'] + ' ' + ent['cls'] + ' ' + ent['label']
        if any(p in marker for p in SKIP_PATTERNS):
            results.append({**ent, 'status': 'skipped'})
            continue
        before = ev(st, 'window.__sweepErrors.length', wait=3)
        # R37 修复（S4-2）：按 ENUM 快照的**稳定 key** 寻址点击——原按快照下标
        # 去点实时重查的 DOM 数组，页面动态变化即错位点击（护栏 skip 清单可被
        # 错位绕过、错误归属错乱）。
        click_js = (
            '(function(){ const els = document.querySelectorAll('
            "'button, [onclick], [role=\"button\"], .icon-btn');"
            ' const seen = new Set(); const arr = [];'
            ' els.forEach(function(el){ const oc = el.getAttribute && el.getAttribute("onclick") || "";'
            ' const label = String((el.textContent||"").trim()).slice(0,30);'
            ' const key = oc + "|" + label + "|" + el.className;'
            ' if (!seen.has(key)) { seen.add(key); arr.push(el); } });'
            ' const el = arr.find(function(e){ return e.getAttribute && (e.getAttribute("onclick") || "") + "|"'
            ' + String((e.textContent||"").trim()).slice(0,30) + "|" + e.className === %s; });'
            ' if (!el) return "gone";'
            ' try { el.click(); return "clicked"; } catch(e) { return "throw:" + e.message; } })()'
        ) % json.dumps(ent.get('key') or (ent['onclick'] + ' ' + ent['cls']))
        clicked = ev(st, click_js, wait=8)
        time.sleep(0.12)
        after = ev(st, 'window.__sweepErrors.length', wait=3)
        errs = []
        # R37 修复（S4-3）：错误采集通道失灵（before/after 非整数，CDP 抖动/跳转
        # 销毁上下文）不得判假 OK——降级为 'uncertain' 计入 BAD 侧，宁可误报
        # 不可漏报。
        readable = isinstance(after, int) and isinstance(before, int)
        if readable and after > before:
            errs = ev(st, 'JSON.stringify(window.__sweepErrors.slice(%d))' % before, wait=5)
            if isinstance(errs, str):
                try:
                    errs = json.loads(errs)
                except Exception:
                    pass
        if not readable:
            status = 'uncertain:' + str(clicked)
        elif clicked == 'clicked' and not errs:
            status = 'ok'
        elif isinstance(clicked, str) and clicked.startswith('throw'):
            status = 'throw:' + str(clicked)
        elif errs:
            status = 'errors:' + json.dumps(errs, ensure_ascii=False)
        else:
            status = str(clicked)
        results.append({**ent, 'status': status})
        # Esc 收尾：关掉本击可能打开的面板
        ev(st, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
               "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));", wait=3)

    ok = sum(1 for r in results if r['status'] == 'ok')
    skipped = sum(1 for r in results if r['status'] == 'skipped')
    bad = [r for r in results if r['status'] not in ('ok', 'skipped')]
    print('OK=%d skipped=%d BAD=%d' % (ok, skipped, len(bad)))
    for r in bad:
        print('  [%s] %s :: %s' % (r['status'][:60], r['label'], r['onclick'][:60]))
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print('written:', args.json)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
