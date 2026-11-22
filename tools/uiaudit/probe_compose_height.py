# -*- coding: utf-8 -*-
"""实测「释放 56px 聊天阅读高度」（替代方案里的未实测估值）。

## 这个数字为什么必须实测

架构文档 §2.3 / §6 写「压缩输入舱四层控件，释放 56px 聊天阅读高度」。
但 56 是**设计意图**，不是实测值。文档 §8 自己已把它列为「未实测的估计值」，
并要求「落地后必须实测回填，禁止让 56 继续以既成事实留在文档里」。
本脚本就是那个实测工具。

## 量什么（三个量，缺一不可）

1. **`#chatContainer` 可视高度**（阅读区）—— 这是「释放给谁」的受体。
2. **`#chatInputArea` 占用高度**（输入舱）—— 这是「从谁身上释放」的供体。
3. **两者之和是否恒定** —— 只有当「输入舱变矮、阅读区等量变高」时，
   「释放 N px」这个说法才成立。若两者之和也变大，说明收的不是同一块空间
   （可能整体变高了），那 56 这个数就没有意义。

## 为什么不能只量一次

`#chatInputArea` 默认带 `hidden` 属性（模板 `:635`），且四层控件里
`#attachPreview` / `#wsQuick` / `.access-strip` 都是**按状态显隐**的。
不把它们放进真实状态，量到的是一个不存在的布局。

所以本脚本用**两组对照**量差值（这也是「释放」的唯一严谨口径）：
  · **baseline**：`#attachPreview` / `#wsQuick` / `.access-strip` 全部隐藏
    （即文档所说的「四层控件压缩后」的目标态）
  · **current**：三者按当前产品默认态显示（即「压缩前」）

`释放量 = baseline 阅读区高度 - current 阅读区高度`
（baseline 里输入舱更矮 ⇒ 阅读区更高 ⇒ 差值为正即「释放了」）

⚠ 这是**受控对照**，不是「改前 / 改后」的 git 对比。真正的「改前」是 Phase B 的
CSS 改动，那时应把本脚本跑两遍（改前 / 改后）比较。本脚本现在量的是
「这三层控件合计占掉的、可释放的空间上限」，是一个**上界**，不是承诺值。
报告里必须标明这一点，不得把上界当既成事实。

## 环境与失败模式（fail-closed，不许编数字）

浏览器用 server/node_modules/playwright-core + 系统 Edge/Chrome，
与 tools/verify-react-render.mjs、frontend/app/tests/smoke-render.mjs 同一套做法。
任一步不满足 → 输出 `blocked-by-environment` 并说明缺什么，退出码 2。
**绝不**在测不到的时候输出一个数字。

用法：
    python tools/uiaudit/probe_compose_height.py
    python tools/uiaudit/probe_compose_height.py --json
    python tools/uiaudit/probe_compose_height.py --width 1440 --height 900

退出码：0 测量成功；2 blocked-by-environment。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
HTML = ROOT / 'harbor.html'
PLAYWRIGHT_DIR = ROOT / 'server' / 'node_modules' / 'playwright-core'

EDGE_CANDIDATES = (
    r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    r'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    r'C:/Program Files/Google/Chrome/Application/chrome.exe',
    r'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
)

# 在浏览器里跑的测量脚本。用 --skin=classic 之外的默认态（光井），因为
# 「释放阅读高度」是光井态的设计目标。
MEASURE_JS = r"""
() => {
  const q = (sel) => document.querySelector(sel);
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null);
  const chat = q('#chatContainer');
  const input = q('#chatInputArea');
  const attach = q('#attachPreview');
  const wsquick = q('#wsQuick');
  const access = q('.access-strip');
  const layerHeights = {
    attachPreview: h(attach),
    wsQuick: h(wsquick),
    accessStrip: h(access),
  };
  return {
    chatHeight: h(chat),
    inputHeight: h(input),
    sum: (h(chat) !== null && h(input) !== null)
      ? Math.round((h(chat) + h(input)) * 100) / 100 : null,
    layers: layerHeights,
    inputHidden: input ? input.hasAttribute('hidden') : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // 输入舱的可见子层清单（用于解释高度由什么构成）
    rows: Array.from(document.querySelectorAll(
      '#chatInputArea .input-row, #chatInputArea .access-strip, '
      + '#chatInputArea #attachPreview, #chatInputArea #wsQuick, '
      + '#chatInputArea .hub-chip')).map(el => ({
        cls: el.className || el.id,
        id: el.id || null,
        h: h(el),
        hidden: el.hasAttribute('hidden'),
        display: getComputedStyle(el).display,
      })),
  };
}
"""

# 把三层控件强制藏起来 = 文档所说的「压缩后」目标态
BASELINE_CSS = """
#attachPreview[data-probe="off"],
#wsQuick[data-probe="off"],
#chatInputArea .access-strip[data-probe="off"] { display: none !important; }
"""


class Blocked(Exception):
    """环境不满足 —— 必须报 blocked-by-environment，不许编数字。"""


def find_browser():
    for cand in EDGE_CANDIDATES:
        if Path(cand).is_file():
            return cand
    return None


def run_node_measure(browser, width, height, autostart_visible):
    """用 playwright-core 打开 harbor.html 并回传测量结果。

    返回 dict；失败抛 Blocked。

    为什么经 node 而不是纯 python：仓内既有探针（verify-react-render.mjs /
    smoke-render.mjs）用 createRequire + launchPersistentContext 绕中文路径，
    已实测可行。新引一个 Python playwright 依赖会多一个环境变量（版本、镜像、
    浏览器下载），反而更难在干净机器上跑。
    """
    if not PLAYWRIGHT_DIR.is_dir():
        raise Blocked('缺少 server/node_modules/playwright-core（先 npm i 于 server/）')
    if not HTML.is_file():
        raise Blocked('缺少构建产物 harbor.html（先 node frontend/build.js）')
    node = shutil.which('node')
    if not node:
        raise Blocked('PATH 上找不到 node')

    script = r"""
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , PW, HTML, W, H, VISIBLE] = process.argv;
const require2 = createRequire(pathToFileURL(join(PW, '__probe__.cjs')));
const { chromium } = require2(PW);

const EDGE = %(browser)s;
let ctx = null;
let profile = null;
for (let i = 1; i <= 3 && !ctx; i++) {
  profile = mkdtempSync(join(tmpdir(), 'uiaudit-compose-'));
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: EDGE, headless: true, timeout: 20000,
      args: ['--no-sandbox','--disable-gpu','--allow-file-access-from-files',
             '--no-first-run','--no-default-browser-check'],
    });
  } catch (e) {
    try { rmSync(profile,{recursive:true,force:true}); } catch(_) {}
    profile = null;
  }
}
if (!ctx) { console.log(JSON.stringify({error:'browser-launch-failed'})); process.exit(0); }

const page = ctx.pages()[0] || await ctx.newPage();
await page.setViewportSize({ width: Number(W), height: Number(H) });
const errors = [];
page.on('pageerror', e => { if (errors.length < 5) errors.push(String(e.message||e)); });

await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1200);

// 让输入舱进入「可见」状态：它默认带 hidden，不摘掉量到的是 0
await page.evaluate((visible) => {
  const input = document.getElementById('chatInputArea');
  if (input) input.removeAttribute('hidden');
}, VISIBLE === '1');

await page.waitForTimeout(400);

const measure = %(measure)s;
const current = await page.evaluate(measure);

// baseline：藏起三层可选控件
await page.addStyleTag({ content: %(baseline_css)s });
await page.evaluate(() => {
  ['attachPreview','wsQuick'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.setAttribute('data-probe','off'); el.style.display=''; }
  });
  const acc = document.querySelector('#chatInputArea .access-strip');
  if (acc) acc.setAttribute('data-probe','off');
});
await page.waitForTimeout(400);
const baseline = await page.evaluate(measure);

await ctx.close();
if (profile) { try { rmSync(profile,{recursive:true,force:true}); } catch(_) {} }
console.log(JSON.stringify({ current, baseline, errors }));
""" % {'browser': json.dumps(browser),
       'measure': MEASURE_JS,
       'baseline_css': json.dumps(BASELINE_CSS)}

    tmpdir_path = tempfile.mkdtemp(prefix='uiaudit-measure-')
    try:
        script_path = Path(tmpdir_path) / 'measure.mjs'
        script_path.write_text(script, encoding='utf-8')
        proc = subprocess.run(
            [node, str(script_path), str(PLAYWRIGHT_DIR), str(HTML),
             str(width), str(height), '1' if autostart_visible else '0'],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=180, cwd=str(ROOT))
        out = (proc.stdout or '').strip()
        if not out:
            raise Blocked('node 测量脚本无输出；stderr=%s'
                          % (proc.stderr or '(空)')[:400])
        # 取最后一行 JSON（前面可能有 node 的警告）
        last = [ln for ln in out.splitlines() if ln.strip().startswith('{')]
        if not last:
            raise Blocked('测量脚本输出无法解析为 JSON：%s' % out[:300])
        data = json.loads(last[-1])
        if data.get('error'):
            raise Blocked('浏览器启动失败：%s' % data['error'])
        return data
    except subprocess.TimeoutExpired:
        raise Blocked('node 测量脚本超时（180s）')
    finally:
        shutil.rmtree(tmpdir_path, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description='实测输入舱 / 阅读区高度，回填「释放 56px」')
    ap.add_argument('--width', type=int, default=1440)
    ap.add_argument('--height', type=int, default=900)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--estimate', type=float, default=56.0,
                    help='方案里的估计值（用于算差值），默认 56')
    args = ap.parse_args(argv)

    rig = 'probe_compose_height'

    browser = find_browser()
    if not browser:
        print('%s: blocked-by-environment | 未找到 Edge/Chrome。候选路径：%s'
              % (rig, ' ; '.join(EDGE_CANDIDATES)))
        print('%s: 需要的前置条件：① 系统安装 Edge 或 Chrome；'
              '② server/node_modules/playwright-core 已安装；③ harbor.html 已构建' % rig)
        if args.json:
            print(json.dumps({'state': 'blocked-by-environment',
                              'reason': 'no-browser-found',
                              'candidates': list(EDGE_CANDIDATES)}, ensure_ascii=False))
        return 2

    try:
        data = run_node_measure(browser, args.width, args.height, True)
    except Blocked as exc:
        print('%s: blocked-by-environment | %s' % (rig, exc))
        if args.json:
            print(json.dumps({'state': 'blocked-by-environment',
                              'reason': str(exc)}, ensure_ascii=False))
        return 2

    cur = data['current']
    base = data['baseline']

    # 自检：测不到高度就不是「测到 0」，而是测量失败 —— 必须 blocked，不许报 0
    for tag, snap in (('current', cur), ('baseline', base)):
        if not snap.get('chatHeight') or not snap.get('inputHeight'):
            print('%s: blocked-by-environment | %s 快照里 #chatContainer 或 '
                  '#chatInputArea 高度为空（元素不存在 / 未渲染），拒绝用 0 代替'
                  % (rig, tag))
            if args.json:
                print(json.dumps({'state': 'blocked-by-environment',
                                  'reason': 'element-not-measured',
                                  'snapshot': tag,
                                  'detail': snap}, ensure_ascii=False))
            return 2

    released = round(base['chatHeight'] - cur['chatHeight'], 2)
    input_shrink = round(cur['inputHeight'] - base['inputHeight'], 2)
    sum_current = cur['sum']
    sum_baseline = base['sum']
    sum_delta = (None if sum_current is None or sum_baseline is None
                 else round(sum_current - sum_baseline, 2))
    est_delta = round(released - args.estimate, 2)

    print('%s: browser = %s' % (rig, browser))
    print('%s: viewport = %dx%d' % (rig, args.width, args.height))
    print('%s: current  #chatContainer = %s px | #chatInputArea = %s px | sum = %s px'
          % (rig, cur['chatHeight'], cur['inputHeight'], sum_current))
    print('%s: baseline #chatContainer = %s px | #chatInputArea = %s px | sum = %s px'
          % (rig, base['chatHeight'], base['inputHeight'], sum_baseline))
    print('%s: layer heights current  = %s' % (rig, json.dumps(cur['layers'], ensure_ascii=False)))
    print('%s: layer heights baseline = %s' % (rig, json.dumps(base['layers'], ensure_ascii=False)))
    print('%s: 阅读区增量（baseline - current）= %+g px  ← 释放量'
          % (rig, released))
    print('%s: 输入舱缩减（current - baseline）= %+g px（应与释放量相等）' % (rig, input_shrink))
    # 自检：两个数必须相等且和不变，否则「释放」这个说法本身不成立
    consistent = (abs(released - input_shrink) < 0.5) and (sum_delta is not None
                                                           and abs(sum_delta) < 0.5)
    print('%s: 空间守恒自检 = %s（阅读区增量 %+g vs 输入舱缩减 %+g，两者之和变化 %s）'
          % (rig, 'PASS' if consistent else 'FAIL', released, input_shrink, sum_delta))
    print('%s: 两者之和变化 = %s px（应为 0 或接近 0；不为 0 说明收的不是同一块空间）'
          % (rig, sum_delta))
    print('%s: 方案估计值 = %s px | 实测 - 估计 = %s px'
          % (rig, args.estimate, est_delta))
    if data.get('errors'):
        print('%s: note: 页面有 %d 条 pageerror（不判失败，仅记录）：%s'
              % (rig, len(data['errors']), data['errors'][0][:120]))

    # 口径声明：这是「可释放空间上界」，不是 Phase B 的承诺值
    print('%s: 口径 = 受控对照（隐藏三层可选控件 vs 当前默认态），'
          '所得为**可释放空间上界**，非改前/改后 diff' % rig)
    print('%s: MEASURED (released=%+g px, estimate=%g px, delta=%+g px)'
          % (rig, released, args.estimate, est_delta))

    if args.json:
        print(json.dumps({
            'state': 'MEASURED',
            'released': released,
            'inputShrink': input_shrink,
            'sumDelta': sum_delta,
            'estimate': args.estimate,
            'estimateDelta': est_delta,
            'current': cur,
            'baseline': base,
            'viewport': {'w': args.width, 'h': args.height},
        }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())