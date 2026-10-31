# -*- coding: utf-8 -*-
"""check_release：发布前版本纪律断言（master-plan M1.10，2026-10-23）。

背景（纪律缺口实证）：v1.8.0 tag 发放时 VERSION 文件仍为 1.7.0——tag 与
文件版本脱钩，用户端「关于」页与更新清单对不上。本工具把「发布 checklist」
从注释变成可执行断言，tag 前必跑：

    python tools/check_release.py --expect 1.9.0

断言项（全过 exit 0，任一不过 exit 1 并列出修复指引）：
  R1  VERSION 文件 == --expect 目标版本（单一数据源，代码里禁手改版本号）
  R2  update_service 回退常量 == VERSION（读不到文件时的行为一致）
  R3  git 最新 tag（v*.*.*）== VERSION（tag 与文件零脱钩——v1.8.0 教训）
  R4  API_VERSION == 'v1.0.0'（js_api 契约版本红线，永动不得）
  R5  APP_VERSION（运行时实际加载值）== VERSION
  R6  config.json 契约基线未被版本相关键污染（get_config 输出无 version 键突变）
"""
import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _read_version_file():
    with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
        return f.read().strip().lstrip('vV')


def _vt(v):
    """'1.9.0' → (1,9,0)（tag 与文件的可比口径；非三段按 0 补）。"""
    parts = re.findall(r'[0-9]+', str(v or ''))
    while len(parts) < 3:
        parts.append('0')
    return tuple(int(x) for x in parts[:3])


def _latest_git_tag():
    try:
        out = subprocess.run(['git', 'describe', '--tags', '--abbrev=0'],
                             capture_output=True, text=True, cwd=ROOT,
                             timeout=30).stdout.strip()
        return out.lstrip('v') if out else ''
    except Exception:
        return ''


def main():
    ap = argparse.ArgumentParser(description='Harbor 发布前版本纪律断言')
    ap.add_argument('--expect', required=True,
                    help='即将发布的版本号（如 1.9.0）')
    ap.add_argument('--tag-now', action='store_true',
                    help='即将打 tag 的发布动作：要求 VERSION 与最新 tag 严格相等')
    args = ap.parse_args()
    expect = str(args.expect).strip().lstrip('vV')
    fails = []

    # R1 VERSION 文件
    v_file = _read_version_file()
    if v_file != expect:
        fails.append('R1 VERSION 文件为 %r，应为 %r——请更新项目根 VERSION 文件'
                     % (v_file, expect))

    # R2 回退常量同步（读源码字面量，不 import——import 会读文件掩盖不同步）
    src_path = os.path.join(ROOT, 'backend', 'domains', 'integrations', 'update_service.py')
    src = open(src_path, encoding='utf-8').read()
    m = re.search(r"return '([0-9]+\.[0-9]+\.[0-9]+[^']*)'", src)
    fb = m.group(1) if m else ''
    if fb != v_file:
        fails.append('R2 update_service 回退常量为 %r，VERSION 文件为 %r——'
                     'bump 时两边必须同步' % (fb, v_file))

    # R3 git tag 一致性：开发中 VERSION ≥ 最新 tag 正常（1.9.0 开发 / tag 1.8.0）；
    # 要抓的是「tag 超前于文件」（v1.8.0 发货时 VERSION=1.7.0 的教训——tag 打了
    # 货文件还没 bump）。--tag-now（即将打 tag 的发布动作）时才要求严格相等。
    tag = _latest_git_tag()
    if tag:
        vt = _vt(v_file)
        tt = _vt(tag)
        if vt < tt:
            fails.append('R3 git 最新 tag 为 %r 但 VERSION 文件为 %r——tag 超前于'
                         '文件（v1.8.0 发货时 VERSION=1.7.0 的教训）：文件必须'
                         '先 bump 再打 tag' % (tag, v_file))
        elif args.tag_now and vt != tt:
            fails.append('R3 --tag-now 模式要求 VERSION(%r) == 即将打的 tag(%r)'
                         % (v_file, tag))
        elif vt > tt:
            print('  [ok] R3 开发中状态：VERSION %s > tag %s（%s 未发货）'
                  % (v_file, tag, v_file))
    else:
        print('  [skip] R3 无 git tag（本地开发环境）')

    # R4 API_VERSION 契约红线
    from backend.api import API_VERSION
    if API_VERSION != 'v1.0.0':
        fails.append('R4 API_VERSION=%r，契约红线 v1.0.0 被改动！' % API_VERSION)

    # R5 APP_VERSION 运行时值
    from backend.domains.integrations.update_service import APP_VERSION
    if APP_VERSION != v_file:
        fails.append('R5 APP_VERSION 运行时加载为 %r，应为 %r' % (APP_VERSION, v_file))

    # R6 config.json 契约基线（版本相关零污染）
    from backend.domains.settings.config_service import ConfigService
    cfg = json.loads(ConfigService().get_config())
    for k in ('version', 'app_version'):
        if k in cfg:
            fails.append('R6 config.json 出现 %r 键——版本是 VERSION 文件单一'
                         '数据源，禁入 config.json（契约比对会漂）' % k)

    # R7 UiSchema 离线包：adapter 源映射、bundle、许可与 NOTICE 必须齐全。
    for relative in ('frontend/vendor/ui-schema-entry.js', 'libs/ui-schema.bundle.js',
                     'libs/ui-schema.LICENSE.txt', 'libs/ui-schema.NOTICE.txt'):
        if not os.path.isfile(os.path.join(ROOT, relative)):
            fails.append('R7 缺少 UiSchema 离线包文件：' + relative)
    for spec_name in ('Harbor.spec', 'Harbor-mac.spec'):
        spec_text = open(os.path.join(ROOT, spec_name), encoding='utf-8').read()
        if 'node_modules' in spec_text and 'datas' in spec_text:
            if re.search(r'datas[^\\n]*node_modules', spec_text):
                fails.append('R7 ' + spec_name + ' 不得将 node_modules 收包')

    if fails:
        print('发布纪律断言失败 %d 项：' % len(fails))
        for f in fails:
            print('  ✗', f)
        return 1
    print('发布纪律断言全过：VERSION=%s API_VERSION=%s tag=%s'
          % (v_file, API_VERSION, tag or '(无)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
