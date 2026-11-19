# -*- coding: utf-8 -*-
"""生成 api-reference.md（deliverables/）：从 Api 类实扫——get_api_info 契约面
+ _V12_EXTRA 隐身面分组，签名/docstring 首段抽取。零手抄（手抄必漂移）。
用法：python tools/gen_api_reference.py（CI/发布前跑，输出即文档）。

⚠ 副作用警告：main() 里实例化 Api() 不是纯内省——Api.__init__ 会创建
~/.glm-chat 数据目录并启动本地代理线程。本工具仅限开发机运行，勿在生产/
用户机或 CI 通用 runner 上跑（会落配置文件、起常驻线程）。
"""
import inspect
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# ---- 删除前置：Python 契约层退役降级 ----
# 本工具非门禁：backend/ 删除后入口输出明确提示并 exit 0，不静默失败。
_BACKEND_API = os.path.join(ROOT, 'backend', 'api.py')
_BACKEND_IMPORTS_OK = os.path.isfile(_BACKEND_API)
_RETIRED_MSG = ('[退役] Python 契约层已退役，请使用冻结快照或备份副本；'
                '本工具依赖 backend/ 源码与运行时，无法继续运行。')
if not _BACKEND_IMPORTS_OK and __name__ == '__main__':
    print(_RETIRED_MSG)
    sys.exit(0)
if _BACKEND_IMPORTS_OK:
    from backend.api import Api, _V12_EXTRA  # noqa: E402

GROUPS = [
    ('契约面 · get_api_info 列名（v1.0.0 起逐字节锁定）', 'legacy'),
    ('隐身面 · _V12_EXTRA（v1.2.5 起新增方法，自省不列、前端可直接调）', 'extra'),
]

_SKIP = {'get_api_info', '_set_window', 'clear_caches'}


def _sig(fn):
    try:
        return str(inspect.signature(fn))
    except (TypeError, ValueError):
        return '(?)'


def _doc(fn):
    d = inspect.getdoc(fn) or ''
    lines = [l.strip() for l in d.splitlines() if l.strip()]
    return lines[0] if lines else ''


def main():
    if not _BACKEND_IMPORTS_OK:
        print(_RETIRED_MSG)
        return 0
    print('警告：本工具会创建 ~/.glm-chat 并启动本地代理线程，仅限开发机运行', flush=True)
    api = Api()
    contract_methods = set(json.loads(api.get_api_info())['methods'])
    out = []
    out.append('# Harbor js_api 接口参考')
    out.append('')
    out.append('> 本文档由 `tools/gen_api_reference.py` 从 `backend/api.py` 实扫生成'
               '（签名 + docstring 首段），发布前刷新——**勿手抄**（手抄必漂移）。')
    out.append('>')
    out.append('> - **契约面**：`get_api_info` 列出的方法（与 v1.0.0 legacy 逐字节'
               '一致，`tests/test_api_contract.py` 门禁）')
    out.append('> - **隐身面**：`_V12_EXTRA` 登记的新方法（自省不列出，防契约漂移；'
               '前端经 pywebview 桥直接调用）')
    out.append('')
    out.append('**方法总数**：契约面 %d + 隐身面 %d = %d'
               % (len(contract_methods), len(_V12_EXTRA),
                  len(contract_methods) + len(_V12_EXTRA)))
    out.append('')
    for title, kind in GROUPS:
        out.append('## %s' % title)
        out.append('')
        out.append('| 方法 | 签名 | 说明 |')
        out.append('|---|---|---|')
        names = sorted(contract_methods) if kind == 'legacy' else sorted(_V12_EXTRA)
        for n in names:
            if n in _SKIP:
                continue
            fn = getattr(api, n, None)
            if fn is None:
                out.append('| `%s` | — | （legacy 快照方法，本仓无实现体） |' % n)
                continue
            out.append('| `%s` | `%s` | %s |'
                       % (n, _sig(fn).replace('|', '\\|'),
                          _doc(fn).replace('|', '\\|')
                          or '（v1.0.0 legacy 契约方法）'))
        out.append('')
    path = os.path.join(ROOT, 'deliverables', 'api-reference.md')
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    print('written:', path, '| lines:', len(out))


if __name__ == '__main__':
    sys.exit(main())
