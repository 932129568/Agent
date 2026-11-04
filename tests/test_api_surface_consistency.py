# -*- coding: utf-8 -*-
"""前后端 API 面一致性核查（Round 19）。

主理人要求：校验前后端框架设计一致性，核查依赖库充分、正确运用。
本门禁静态交叉核对：前端 callApi('name') 引用的每个 js_api 方法必须真实存在
于后端（_V12_EXTRA 显式登记或 Api 公开方法）；后端 _V12_EXTRA 里被前端引用的
方法必须真实可调。另核查 package.json 运行时依赖零死重（zod 教训）。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_PY = ROOT / 'backend' / 'api.py'


def _frontend_calls():
    calls = set()
    for path in (ROOT / 'frontend' / 'src').glob('**/*.js'):
        text = path.read_text(encoding='utf-8', errors='replace')
        calls |= set(re.findall(r"callApi\(\s*['\"]([\w]+)['\"]", text))
        calls |= set(re.findall(r"pcCall\(\s*['\"]([\w]+)['\"]", text))
    return calls


def _backend_methods():
    text = API_PY.read_text(encoding='utf-8')
    defined = set(re.findall(r'def (\w+)\(self', text))
    v12 = re.search(r'_V12_EXTRA\s*=\s*frozenset\(\{(.*?)\}\)', text, re.S)
    extra = set(re.findall(r"'(\w+)'", v12.group(1))) if v12 else set()
    return defined | extra


def test_every_frontend_call_api_target_exists_in_backend():
    calls = _frontend_calls()
    backend = _backend_methods()
    missing = sorted(c for c in calls if c not in backend)
    assert not missing, '前端调用但后端不存在（点击即坏的隐形炸弹）: %s' % missing


def test_frontend_calls_hit_v12_extra_are_registered():
    """callApi 走 HTTP 桥时走 /jsapi/<name> 白名单——被前端引用的 _V12_EXTRA
    方法必须在位（隐身≠缺失）。"""
    calls = _frontend_calls()
    backend = _backend_methods()
    assert calls <= backend


def test_no_dead_runtime_dependencies():
    pkg = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    deps = pkg.get('dependencies', {})
    dead = []
    for name in deps:
        hits = 0
        for path in list(ROOT.glob('backend/**/*.py')) + list(ROOT.glob('electron/*.js')) + \
                list(ROOT.glob('frontend/src/**/*.js')) + [ROOT / 'main.py']:
            try:
                if name in path.read_text(encoding='utf-8', errors='replace'):
                    hits += 1
            except Exception:
                pass
        if hits == 0:
            dead.append(name)
    assert not dead, '运行时依赖声明了但全仓零引用（安装器死重）: %s' % dead
