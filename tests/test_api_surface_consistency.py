# -*- coding: utf-8 -*-
"""前后端 API 面一致性核查（Round 19）。

主理人要求：校验前后端框架设计一致性，核查依赖库充分、正确运用。
本门禁静态交叉核对：前端 callApi('name') 引用的每个 js_api 方法必须真实存在
于冻结快照的方法面；Py 契约层退役后方法面唯一事实源为 frozen-python-surface.json。
另核查 server/package.json 运行时依赖零死重（zod 教训）。

R70 / I29：根 package.json 的 dependencies={} 使旧 `for name in deps` 恒真，
改为校验 server/package.json 的 12 个依赖在 server/src/**/*.js 可检索并逐个
输出命中文件；未命中者只登记豁免理由、不删任何依赖；移除 backend/**/*.py glob。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 删除前置：Python 契约层已退役，方法面改读冻结快照（唯一事实源）
FROZEN = ROOT / 'deliverables' / 'dev-plan' / 'frozen-python-surface.json'

# R70 / I29：server/package.json 的 12 个依赖实测基线（QA 实测，规格写 11 已勘误）。
# 显式基线使「把某依赖名改错」不再恒真——差集即判红。
EXPECTED_SERVER_DEPS = frozenset({
    '@libsql/client', '@libsql/kysely-libsql', '@modelcontextprotocol/sdk',
    '@prisma/adapter-libsql', '@prisma/client', 'better-auth', 'fastify',
    'iconv-lite', 'kysely', 'pino', 'playwright-core', 'zod',
})
# 静态文本零命中的依赖须在此显式登记豁免理由（不删依赖）。
# @prisma/client 由 prisma generate 生成物动态引用，server/src 无字面 import。
ALLOWED_EXEMPTIONS = {
    '@prisma/client': '由 prisma generate 生成物动态引用，server/src 无静态字面 import',
}


def _frontend_calls():
    calls = set()
    for path in (ROOT / 'frontend' / 'src').glob('**/*.js'):
        text = path.read_text(encoding='utf-8', errors='replace')
        calls |= set(re.findall(r"callApi\(\s*['\"]([\w]+)['\"]", text))
        calls |= set(re.findall(r"pcCall\(\s*['\"]([\w]+)['\"]", text))
    return calls


def _backend_methods():
    frozen = json.loads(FROZEN.read_text(encoding='utf-8'))
    return (set(frozen['method_defs']) | set(frozen['hidden_methods']) |
            set(frozen['public_methods']))


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
    """R70 / I29：server/package.json 的每个依赖须在 server/src/**/*.js 可检索。

    逐个输出「命中文件」证据；未命中者按「只登记豁免理由、不删依赖」处理
    （依赖可能经由动态 import / 原生绑定 / 生成物间接使用，静态检索不到不等于死重）。
    铁律：不删除任何既有依赖。
    """
    pkg = json.loads((ROOT / 'server' / 'package.json').read_text(encoding='utf-8'))
    deps = sorted((pkg.get('dependencies') or {}).keys())
    assert deps, 'server/package.json 的 dependencies 不应为空'
    sources = list((ROOT / 'server' / 'src').glob('**/*.js'))
    assert sources, 'server/src/**/*.js 扫描面不应为空'
    # 关键判据：依赖集合必须与实测基线一致（改错名 / 删依赖都会让差集非空）
    assert set(deps) == set(EXPECTED_SERVER_DEPS), (
        'server 依赖集合漂移：多出 %s / 缺失 %s（须同步本测试基线，不得删依赖）'
        % (sorted(set(deps) - set(EXPECTED_SERVER_DEPS)),
           sorted(set(EXPECTED_SERVER_DEPS) - set(deps))))
    evidence = {}
    exemptions = {}
    unregistered_dead = []
    for name in deps:
        hits = [str(p.relative_to(ROOT)).replace('\\', '/')
                for p in sources
                if name in p.read_text(encoding='utf-8', errors='replace')]
        if hits:
            evidence[name] = sorted(hits)
        elif name in ALLOWED_EXEMPTIONS:
            exemptions[name] = ALLOWED_EXEMPTIONS[name]
        else:
            # 未命中且无豁免理由 = 真死重（不删依赖，但显式判红）
            unregistered_dead.append(name)
    # 逐个输出命中文件证据（pytest -s 可见），便于 QA 复核
    for name in deps:
        if name in evidence:
            print('[dep-hit] %s -> %s' % (name, ', '.join(evidence[name])))
        else:
            print('[dep-exempt] %s -> %s' % (name, exemptions.get(name, '<未登记>')))
    assert not unregistered_dead, (
        '运行时依赖声明了但 server/src 零引用且无豁免理由: %s' % unregistered_dead)
    assert len(evidence) + len(exemptions) == len(deps)
