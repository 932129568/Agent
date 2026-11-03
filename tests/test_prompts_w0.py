# -*- coding: utf-8 -*-
"""W0 prompts/ 版本化提示词回归：loader + manifest + 一致性 + js_api 隐身。"""
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402
from helpers.frontend import read_frontend_source  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           'backend', 'prompts')
SRC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'frontend', 'src')


class TestLoader:
    def test_all_five_load(self):
        # Round 8 提示词瘦身：15 → 5——消费链审计证明 10 个提示词无任何 render/
        # prompt_get 消费者（reflect/validate/understand/plan-generate/browser-*四件
        # /system-local/system-sandbox），删除以绝噪音；保留=有真实消费链的 5 个。
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        ids = pl.list_ids()
        assert len(ids) == 5, ids
        assert set(ids) == {'system-base', 'system-ws-off', 'reader-extract',
                            'efficiency', 'compact'}
        for pid in ids:
            text, ver = pl.load(pid)
            assert text and ver, pid

    def test_render_placeholder(self):
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        text, _ = pl.render('system-base', ws_root='D://proj')
        assert 'D://proj' in text and '{ws_root}' not in text

    def test_unknown_id_empty(self):
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        assert pl.load('nope') == ('', '')

    def test_manifest_sha_all_match(self):
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        man = json.load(io.open(os.path.join(PROMPTS_DIR, 'manifest.json'),
                                encoding='utf-8'))
        import hashlib
        for pid, e in man['prompts'].items():
            text = io.open(os.path.join(PROMPTS_DIR, e['file']), encoding='utf-8').read()
            assert hashlib.sha256(text.encode()).hexdigest() == e['sha256'], pid

    def test_prompts_dir_frozen_safe(self):
        """loader 定位不依赖 cwd（frozen 下 __file__ 在 _MEIPASS）。"""
        from backend.domains.providers import prompt_loader as pl
        d = pl.prompts_dir()
        assert os.path.isabs(d) and d.endswith('prompts')


class TestConsistency:
    """迁移不改变行为：prompts 文件 == 前端源码值（逐字节）。

    口径（2026-10-21 修订）：前端已改读 prompt_get，源码里保留的**回落内置值**
    （EFFICIENCY_PROMPT 常量 / 97-compact 的 _cmpPrompt 回落串）必须与 prompts
    文件渲染值一致——回落路径零行为差异。反引号经 chr(96) 拼接防转义问题。
    """
    BT = chr(96)   # 反引号（heredoc/编辑器安全）

    def test_efficiency_matches_frontend(self):
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        src = read_frontend_source(PROJECT_ROOT, '55-tool-route.js')
        m = re.search(r'const EFFICIENCY_PROMPT = ' + self.BT + r'([^' + self.BT + r']*)' + self.BT + ';', src, re.S)
        assert m, 'EFFICIENCY_PROMPT 常量未找到（前端回落路径被删？）'
        assert pl.load('efficiency')[0] == m.group(1)

    def test_compact_matches_frontend_fallback(self):
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        src = read_frontend_source(PROJECT_ROOT, '97-compact.js')
        # 前端回落内置串（_cmpPrompt 初值）与 prompts 渲染值一致
        m = re.search(r"_cmpPrompt = '(把以下[^']*)'", src)
        assert m, '_cmpPrompt 回落串未找到'
        expect = m.group(1).replace(chr(92) + 'n', chr(10))
        assert pl.load('compact')[0] == expect

    def test_build_system_prompt_unchanged(self, fresh_home):
        """build_system_prompt 读 prompts 后输出与迁移前硬编码同形态。

        注：ws_enabled_for(sid, True) 第二参是「缺省值=True」——fresh_home 新
        sid 无记忆时走 on 分支；ws-off 模板形态直接验 render（build_system_prompt
        的 ws-off 分支即 render('system-ws-off') + tail，单元口径相同）。
        """
        from backend.api import Api
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        off_text, _ = pl.render('system-ws-off')
        assert off_text.startswith('你是 Harbor 内置编程助手。当前**未启用工作区**')
        assert 'read_more 分段取。' in off_text
        api = Api()
        on = json.loads(api.build_system_prompt())
        assert on.startswith('你是 Harbor 内置编程助手。当前工作区: ')
        assert 'read_more 分段取。' in on


class TestJsApi:
    def test_prompt_get_ok(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().prompt_get('efficiency'))
        assert r['ok'] is True and r['version'] == '1.1.0'   # Round 8 瘦身 bump
        assert '省 token' in r['text']

    def test_prompt_get_unknown(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().prompt_get('nope'))
        assert 'ok' not in r and 'error' in r   # err() 形态：{error} 无 ok 键

    def test_in_v12_extra(self):
        from backend.api import _V12_EXTRA
        assert 'prompt_get' in _V12_EXTRA

    def test_get_api_info_stealth(self, fresh_home):
        from backend.api import Api
        assert 'prompt_get' not in Api().get_api_info()
