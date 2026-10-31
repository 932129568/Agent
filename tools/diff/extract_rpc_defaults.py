# -*- coding: utf-8 -*-
"""rpc RP2 缺参合成的必填补齐源：从 backend/api.py AST 机械提取每个方法的
可选参数表（有默认值的形参），输出 JS 常量表供 registry.js 嵌入。

纪律：不 import backend（零副作用），纯 ast 解析；单一事实源 = api.py 源码。
用法：python tools/diff/extract_rpc_defaults.py
"""
import ast
import json
import os
import sys

API = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   '..', 'backend', 'api.py')


def main():
    tree = ast.parse(open(API, encoding='utf-8').read())
    api_cls = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == 'Api':
            api_cls = node
            break
    if api_cls is None:
        print('未找到 Api 类', file=sys.stderr)
        return 1
    table = {}
    for item in api_cls.body:
        if not isinstance(item, ast.FunctionDef) or item.name.startswith('__'):
            continue
        optional = []
        defaults = item.args.defaults
        # args 与 defaults 右对齐（CPython 规则：尾部 n 个形参对应 defaults）
        params = [a.arg for a in item.args.args]
        if defaults:
            for name in params[-len(defaults):]:
                optional.append(name)
        if optional:
            table[item.name] = optional
    print('// 由 tools/diff/extract_rpc_defaults.py 从 backend/api.py AST 机械提取')
    print('//（有默认值的形参 = rpc kwargs 调用可缺省；再生成须重跑脚本勿手改）')
    print('const PY_OPTIONAL_PARAMS = ' + json.dumps(table, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
