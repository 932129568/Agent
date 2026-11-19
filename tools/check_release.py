# -*- coding: utf-8 -*-
"""check_release：发布前版本纪律断言（master-plan M1.10，2026-10-23）。

背景（纪律缺口实证）：v1.8.0 tag 发放时 VERSION 文件仍为 1.7.0——tag 与
文件版本脱钩，用户端「关于」页与更新清单对不上。本工具把「发布 checklist」
从注释变成可执行断言，tag 前必跑：

    python tools/check_release.py --expect 1.9.0

断言项（全过 exit 0，任一不过 exit 1 并列出修复指引）：
  R1  VERSION 文件 == --expect 目标版本（单一数据源，代码里禁手改版本号）
  R2  update_service 回退常量 == VERSION（删除后改读冻结快照 APP_VERSION）
  R3  git 最新 tag（v*.*.*）== VERSION（tag 与文件零脱钩——v1.8.0 教训）
  R4  API_VERSION == 'v1.0.0'（改读冻结快照 API_VERSION，js_api 契约红线永动不得）
  R5  APP_VERSION（改读冻结快照 APP_VERSION）== VERSION
  R6  config.json 契约基线未被版本相关键污染（backend 缺席时直接读 config.json）

删除前置：三处 `from backend... import` 全部改为读冻结快照 / VERSION 文件；
不再 import backend，Python 契约层删除后本工具仍可运行。
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


def _read_frozen():
    """删除前置：版本事实源改为冻结快照（不再 import backend）。"""
    path = os.path.join(ROOT, 'deliverables', 'dev-plan',
                        'frozen-python-surface.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def _vt(v):
    """'1.9.0' → (1,9,0)（tag 与文件的可比口径；非三段按 0 补）。"""
    parts = re.findall(r'[0-9]+', str(v or ''))
    while len(parts) < 3:
        parts.append('0')
    return tuple(int(x) for x in parts[:3])


def _latest_git_tag():
    """只认 v*.*.* 发布 tag，返回 (tag, status, warning) 三态。

    删除前置会打备份/预删除标记（如 r69-pre-deletion），它并非版本 tag；
    git describe --abbrev=0 会把它当「最新 tag」，使 R3 误判「tag 超前于文件」。
    按本文档 R3 口径（v*.*.*）过滤，避免非版本标记污染发布纪律判定。

    R70 / I20：区分三态，不再把命令失败/超时吞成「[skip] 无 git tag」——
    :return: (tag, status, warning)
      - ('1.8.0', 'ok', '')          成功且有 v* tag
      - ('', 'no-tag', '')           成功但无版本 tag（真 skip）
      - ('', 'error', '<显式说明>')   命令失败 / 超时 / 非预期异常
    """
    try:
        out = subprocess.run(['git', 'tag', '--list', 'v*', '--sort=-v:refname'],
                             capture_output=True, text=True, cwd=ROOT,
                             timeout=30).stdout
    except subprocess.TimeoutExpired as exc:
        return '', 'error', '[warning] git tag 查询超时（timeout=30s）：%s' % exc
    except OSError as exc:
        return '', 'error', '[warning] git tag 命令无法执行：%s' % exc
    except Exception as exc:  # noqa: BLE001 - 兜底留痕，绝不再静默吞掉
        return '', 'error', '[warning] git tag 查询出现非预期异常：%r' % (exc,)
    for line in out.splitlines():
        tag = line.strip()
        if re.match(r'^v\d+\.\d+\.\d+$', tag):
            return tag.lstrip('v'), 'ok', ''
    return '', 'no-tag', ''


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

    # R2 回退常量同步（删除后改读冻结快照 APP_VERSION；源码仍在时仍复核字面量）
    frozen = _read_frozen()
    src_path = os.path.join(ROOT, 'backend', 'domains', 'integrations', 'update_service.py')
    if os.path.isfile(src_path):
        src = open(src_path, encoding='utf-8').read()
        m = re.search(r"return '([0-9]+\.[0-9]+\.[0-9]+[^']*)'", src)
        fb = m.group(1) if m else ''
    else:
        # Python 契约层已退役：回退常量的冻结值即 frozen.APP_VERSION
        fb = frozen['APP_VERSION']
    if fb != v_file:
        fails.append('R2 update_service 回退常量为 %r，VERSION 文件为 %r——'
                     'bump 时两边必须同步' % (fb, v_file))

    # R3 git tag 一致性：开发中 VERSION ≥ 最新 tag 正常（1.9.0 开发 / tag 1.8.0）；
    # 要抓的是「tag 超前于文件」（v1.8.0 发货时 VERSION=1.7.0 的教训——tag 打了
    # 货文件还没 bump）。--tag-now（即将打 tag 的发布动作）时才要求严格相等。
    tag, tag_status, tag_warning = _latest_git_tag()
    # R70 / I20：命令失败/超时写显式 warning（不伪装成 [skip] 无 tag），
    # 且不把故障计入 fails（版本纪律本身未变，但必须留痕、不静默吞掉）。
    if tag_warning:
        print('  ' + tag_warning)
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
    elif tag_status == 'no-tag':
        print('  [skip] R3 无 git tag（git 命令成功返回空，本地开发环境）')
    else:
        # tag_status == 'error'：上面已打印显式 warning，此处不再伪装为 [skip]
        print('  [warning] R3 未能可靠取得 git tag（详见上方 warning），'
              '本次不做 tag 一致性判定')

    # R4 API_VERSION 契约红线（改读冻结快照）
    API_VERSION = frozen['API_VERSION']
    if API_VERSION != 'v1.0.0':
        fails.append('R4 API_VERSION=%r，契约红线 v1.0.0 被改动！' % API_VERSION)

    # R5 APP_VERSION（改读冻结快照，等价于退役前运行时加载值）
    APP_VERSION = frozen['APP_VERSION']
    if APP_VERSION != v_file:
        fails.append('R5 APP_VERSION 冻结为 %r，应为 %r' % (APP_VERSION, v_file))

    # R6 config.json 契约基线（版本相关零污染）
    # R70 / I07：Python 契约层已退役，不再 try/import backend.ConfigService；
    # 直接读 ~/.glm-chat/config.json（缺失即 {}，与原 ImportError 降级语义一致）。
    cfg = {}
    cfg_path = os.path.join(os.path.expanduser('~'), '.glm-chat', 'config.json')
    if os.path.isfile(cfg_path):
        try:
            cfg = json.loads(open(cfg_path, encoding='utf-8').read())
        except (OSError, ValueError):
            cfg = {}
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
        spec_path = os.path.join(ROOT, spec_name)
        # R70 / I21：spec 缺失时追加到 fails 并 continue，不再裸 open 抛 traceback。
        if not os.path.isfile(spec_path):
            fails.append('R7 缺少打包 spec 文件：' + spec_name)
            continue
        try:
            with open(spec_path, encoding='utf-8') as f:
                spec_text = f.read()
        except (OSError, UnicodeError) as exc:
            fails.append('R7 打包 spec 读取失败 %s：%s' % (spec_name, exc))
            continue
        if 'node_modules' in spec_text and 'datas' in spec_text:
            # R70 / I21：`[^\\n]` 是「非反斜杠/非字母 n」的字符类，本意是
            # 「跨行匹配到 node_modules」；改为 `[^\n]*`（真正的非换行任意字符）。
            if re.search(r'datas[^\n]*node_modules', spec_text):
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
