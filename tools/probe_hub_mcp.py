# -*- coding: utf-8 -*-
"""R35 · MCP 端点匿名可达性实测（一次性协议握手探针）。

背景：在线连接器包里的 mcp.json 多数只写一个 url，没写 headers/env —— 看起来
「无需密钥」，但 WorkBuddy 运行时会用自己的账号 / OAuth 会话注入凭证。
抽样实测 30 个端点有 24 个返回 401（含 GitHub / Notion），因此**不能**把
「配置里没写密钥」当成「可直连」。

本脚本对全部 HTTP 型端点做一次 MCP initialize 握手，把真正匿名可完成握手的
固化成白名单 tools/data/hub-mcp-probe.json。build_hub_catalog.py 只把白名单
里的标为 ready，其余一律 auth（需授权），杜绝虚假承诺。

只发一次标准 initialize 请求，不调用任何工具、不写入任何用户配置。
用法： python tools/probe_hub_mcp.py [--timeout 6] [--workers 16]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import ssl
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / 'tools' / 'data' / 'hub-market-snapshot.json'
OUT = ROOT / 'tools' / 'data' / 'hub-mcp-probe.json'

INIT = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
    'params': {
        'protocolVersion': '2024-11-05', 'capabilities': {},
        'clientInfo': {'name': 'harbor-connectivity-probe', 'version': '1.0'},
    },
}).encode('utf-8')


def _targets():
    d = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    out = []
    for row in d.get('connectors', []):
        for name, cfg in (row.get('mcp') or {}).items():
            if not isinstance(cfg, dict):
                continue
            url = cfg.get('url')
            if not url or str(cfg.get('type') or '').lower() == 'sse':
                continue
            out.append((row['id'], str(name), str(url)))
            break
    return out


def probe(item, timeout, ctx):
    cid, name, url = item
    req = urllib.request.Request(url, data=INIT, headers={
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read(2048).decode('utf-8', 'replace')
            # 200 也可能是业务层 unauthorized（如 {"error":{"code":-32001,...}}）
            ok = (resp.status == 200 and '"result"' in body
                  and 'unauthorized' not in body.lower()
                  and '"error"' not in body.lower().replace('"error":null', ''))
            return {'id': cid, 'server': name, 'url': url,
                    'status': resp.status, 'ok': bool(ok),
                    'detail': body[:160].replace('\n', ' ')}
    except Exception as e:
        return {'id': cid, 'server': name, 'url': url,
                'status': 0, 'ok': False,
                'detail': '%s: %s' % (type(e).__name__, str(e)[:110])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--timeout', type=float, default=6.0)
    ap.add_argument('--workers', type=int, default=16)
    args = ap.parse_args()
    targets = _targets()
    print('探测 HTTP 型 MCP 端点:', len(targets))
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    started = time.time()
    results = []
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(probe, t, args.timeout, ctx) for t in targets]
        for i, fut in enumerate(cf.as_completed(futures), 1):
            results.append(fut.result())
            if i % 100 == 0:
                print('  %d/%d …' % (i, len(targets)))
    ok = sorted(r['id'] for r in results if r['ok'])
    payload = {
        'version': 'r35-probe',
        'probedAt': int(time.time() * 1000),
        'total': len(results),
        'anonymousOk': len(ok),
        'okIds': ok,
        'results': results,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
                   encoding='utf-8')
    print('完成 %.1fs，匿名可握手 %d/%d，写入 %s' % (
        time.time() - started, len(ok), len(results), OUT))
    from collections import Counter
    print('状态分布:', Counter(r['status'] or r['detail'].split(':')[0] for r in results).most_common(8))
    print('可匿名直连样例:', ok[:12])


if __name__ == '__main__':
    main()
