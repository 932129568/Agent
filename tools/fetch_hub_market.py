# -*- coding: utf-8 -*-
"""R35 · 采集 WorkBuddy 在线市场全量清单，生成离线快照 tools/data/hub-market-snapshot.json。

与 R32 的区别：R32 只读本机插件缓存（17 连接器 / 292 技能），导致功能市场
「不全 + 大量英文描述」。本脚本改为读取 WorkBuddy 官方在线市场包：

  - https://download.codebuddy.ai/connector-agent-plugins/connector-plugins.zip
      官方公开连接器（26）
  - https://download.codebuddy.ai/connector-agent-plugins/connector-plugins-internal.zip
      市场全量连接器（617，含中文 display.name_zh / description_zh / examples_zh
      与 mcp.json 真实 MCP 配置）
  - ~/.workbuddy/storage/.../skill-market.json
      SkillHub 首屏中文热门技能（106）+ 16 个官方分类 + 使用量

产物是**离线自包含快照**：build_hub_catalog.py 只读它，不再依赖网络或用户目录，
保证任何机器上重建 hub-catalog.js 的结果一致。原始 zip 落在 outputs/hub-raw/（不入库）。

用法： python tools/fetch_hub_market.py [--offline]
  --offline 只用已下载的 outputs/hub-raw/*.zip，不发起网络请求。
"""
from __future__ import annotations

import argparse
import json
import re
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'outputs' / 'hub-raw'
OUT = ROOT / 'tools' / 'data' / 'hub-market-snapshot.json'
WB = Path.home() / '.workbuddy'

PACKAGES = [
    ('connector-plugins.zip', '官方公开',
     'https://download.codebuddy.ai/connector-agent-plugins/connector-plugins.zip'),
    ('connector-plugins-internal.zip', '市场全量',
     'https://download.codebuddy.ai/connector-agent-plugins/connector-plugins-internal.zip'),
]
STORAGE = WB / 'storage'


def _download(url: str, dest: Path, timeout: int = 180) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'Harbor-Market-Snapshot/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open('wb') as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)


def _display(plugin: dict) -> tuple[dict, dict]:
    wb = (plugin.get('extensions') or {}).get('ai.workbuddy') or {}
    return (wb.get('display') or {}), (wb.get('policy') or {})


def collect_connectors(offline: bool) -> list[dict]:
    merged: dict[str, dict] = {}
    for filename, label, url in PACKAGES:
        path = RAW / filename
        if not path.is_file():
            if offline:
                print('  ! 跳过（离线且无缓存）:', filename)
                continue
            print('  ↓ 下载', filename)
            _download(url, path)
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            manifest = json.loads(zf.read('.codebuddy-plugin/marketplace.json'))
            for row in manifest.get('plugins', []):
                cid = str(row.get('name') or '').strip()
                if not cid:
                    continue
                base = 'connectors/' + cid + '/'
                pj_path = base + '.codebuddy-plugin/plugin.json'
                plugin = json.loads(zf.read(pj_path)) if pj_path in names else {}
                disp, policy = _display(plugin)
                mcp = None
                mcp_path = base + 'mcp.json'
                if mcp_path in names:
                    try:
                        mcp = json.loads(zf.read(mcp_path)).get('mcpServers') or None
                    except (ValueError, UnicodeDecodeError):
                        mcp = None
                rec = {
                    'id': cid,
                    'nameZh': disp.get('name_zh') or disp.get('name') or '',
                    'nameEn': disp.get('name_en') or cid,
                    'descZh': disp.get('description_zh') or '',
                    'descEn': disp.get('description_en') or row.get('description') or '',
                    'examples': [str(x) for x in (disp.get('examples_zh') or [])[:3]],
                    'keywords': [str(x) for x in (plugin.get('keywords') or [])[:6]],
                    'visibleIn': [str(x) for x in (policy.get('visible_in') or [])],
                    'mcp': mcp,
                    'source': label,
                }
                old = merged.get(cid)
                # 同名条目：优先信息更全（中文名 / 中文描述 / MCP 配置）
                score = lambda r: (bool(re.search(r'[\u4e00-\u9fff]', r['nameZh'])),
                                   bool(re.search(r'[\u4e00-\u9fff]', r['descZh'])),
                                   bool(r['mcp']), len(r['examples']))
                if old is None or score(rec) > score(old):
                    merged[cid] = rec
    print('  连接器:', len(merged))
    return sorted(merged.values(), key=lambda r: r['id'])


def _find_skill_market() -> Path | None:
    if not STORAGE.is_dir():
        return None
    found = sorted(STORAGE.glob('user-*/scoped/*/skill-market.json'),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    return found[0] if found else None


def collect_skills() -> tuple[list[dict], list[dict]]:
    path = _find_skill_market()
    if not path:
        print('  ! 未找到 SkillHub 首屏缓存，技能增量为空')
        return [], []
    data = json.loads(path.read_text(encoding='utf-8'))
    screens = [v for k, v in data.items() if k.startswith('first-screen.v1:')
               and isinstance(v, dict) and 'primaryList' in v]
    if not screens:
        return [], []
    screen = max(screens, key=lambda v: v.get('savedAt') or 0)
    categories = [{'id': c.get('id'), 'name': (c.get('name') or {}).get('zh')
                   if isinstance(c.get('name'), dict) else c.get('name')}
                  for c in screen.get('primaryCategories', [])]
    seen: dict[str, dict] = {}
    for group, rank in (('featured', 1000), ('primaryList', 0)):
        for row in (screen.get(group) or {}).get('skills', []):
            sid = str(row.get('name') or row.get('skill_id') or '')
            if not sid:
                continue
            stat = row.get('use_stat') or {}
            rec = {
                'id': sid,
                'name': row.get('display_name_zh') or row.get('display_name_en') or sid,
                'alias': row.get('display_name_en') or '',
                'desc': row.get('description_zh') or row.get('description_en') or '',
                'examples': [str(x) for x in (row.get('examples_zh') or [])[:3]],
                'categories': [str(x) for x in (row.get('categories') or [])],
                'uses': int(stat.get('use_count') or 0),
                'installs': int(stat.get('install_count') or 0),
                'featured': bool(row.get('featured')),
                'icon': row.get('icon') or '',
                'source': 'SkillHub',
            }
            rec['hot'] = rank + (1 if rec['featured'] else 0)
            seen[sid] = rec
    print('  技能:', len(seen), '分类:', len(categories), '(来源', path.name + ')')
    return sorted(seen.values(), key=lambda r: -r['uses']), categories


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--offline', action='store_true')
    args = ap.parse_args()
    print('采集 WorkBuddy 在线市场 …')
    connectors = collect_connectors(args.offline)
    skills, categories = collect_skills()
    snapshot = {
        'version': 'r35-market',
        'connectors': connectors,
        'skills': skills,
        'skillCategories': categories,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')),
                   encoding='utf-8')
    print('写入:', OUT, '%.1f KB' % (OUT.stat().st_size / 1024))
    cjk = re.compile(r'[\u4e00-\u9fff]')
    print('中文描述覆盖: 连接器 %d/%d，技能 %d/%d' % (
        sum(1 for x in connectors if cjk.search(x['descZh'])), len(connectors),
        sum(1 for x in skills if cjk.search(x['desc'])), len(skills)))
    print('含 MCP 配置:', sum(1 for x in connectors if x['mcp']), '/', len(connectors))


if __name__ == '__main__':
    main()
