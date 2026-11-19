# -*- coding: utf-8 -*-
"""抓取 WorkBuddy 专家市场全量「真实人格提示词」到本地缓存，供内置目录生成脚本使用。

只读公开 CDN（expert_center.json 里每条专家的 promptFile），不上传任何数据。
缓存目录 outputs/hub-catalog-cache/experts/ 属运行产物（被 gitignore），
离线时 build_hub_catalog.py 会跳过缺失项并回落为结构化角色指令。

用法： python tools/fetch_hub_personas.py
"""
import concurrent.futures
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WB = Path.home() / '.workbuddy'
CACHE = ROOT / 'outputs' / 'hub-catalog-cache' / 'experts'
BASE = 'https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace'
MANIFEST = WB / 'app' / 'cache' / 'experts' / 'manifest.json'


def fetch(entry):
    eid = str(entry.get('id') or '')
    target = CACHE / (eid + '.md')
    if target.is_file() and target.stat().st_size > 200:
        return eid, 'cached', target.stat().st_size
    pf = str(entry.get('promptFile') or '')
    if not pf:
        return eid, 'no-prompt-file', 0
    url = BASE + (pf if pf.startswith('/') else '/' + pf)
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = resp.read()
            if len(data) < 200:
                return eid, 'too-small', len(data)
            target.write_bytes(data)
            return eid, 'ok', len(data)
        except Exception as exc:             # 超时/404 重试一次后记录失败
            if attempt == 1:
                return eid, 'fail:' + str(exc)[:50], 0
    return eid, 'fail', 0


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    experts = json.loads(MANIFEST.read_text(encoding='utf-8'))['experts']
    started = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for row in pool.map(fetch, experts):
            results.append(row)
    ok = [r for r in results if r[1] in ('ok', 'cached')]
    bad = [r for r in results if r[1] not in ('ok', 'cached')]
    (CACHE / '_status.json').write_text(
        json.dumps({'fetchedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
                    'total': len(results), 'ok': len(ok),
                    'failed': [{'id': r[0], 'reason': r[1]} for r in bad]},
                   ensure_ascii=False, indent=2), encoding='utf-8')
    total_kb = sum(r[2] for r in ok) / 1024
    print('专家人格原文：%d/%d 命中，合计 %.1f KB，耗时 %.1fs'
          % (len(ok), len(results), total_kb, time.time() - started))
    if bad:
        print('失败样本:', bad[:8])
    print('缓存目录:', CACHE)


if __name__ == '__main__':
    main()
