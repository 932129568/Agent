# -*- coding: utf-8 -*-
"""Round 8 提示词瘦身后的契约回归（原 v1.9.0 T01 十五提示词口径的存续部分）。

Round 8 消费链审计：15 个提示词只有 5 个有真实消费者（system-base/system-ws-off
经 build_system_prompt；reader-extract 经 search_reader；efficiency/compact 经
前端 prompt_get 回落链）——其余 10 个（reflect/validate/understand/plan-generate/
browser-*四件/system-local/system-sandbox）无任何 render/prompt_get 调用点，
删除以绝噪音。本文件保留两类断言：
- 五提示词口径（加载/manifest 一致性/版本）；
- reader-extract 安全规格（dual-LLM-lite 防注入关键句——安全回归不许漂移）。
browser-* 的安全语义已由 tools_schema 三段式描述与 BrowserErrorCode taxonomy
承接（Round 6 补齐），楼层提示词属重复定义。
"""
import hashlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           'backend', 'prompts')

LIVE_FIVE = ('compact', 'efficiency', 'system-base', 'system-ws-off',
             'reader-extract')


def _manifest():
    with io.open(os.path.join(PROMPTS_DIR, 'manifest.json'), encoding='utf-8') as f:
        return json.load(f)


def _read(fname):
    with io.open(os.path.join(PROMPTS_DIR, fname), encoding='utf-8') as f:
        return f.read()


def _load(pid):
    from backend.domains.providers import prompt_loader as pl
    pl.clear_cache()
    return pl.load(pid)


class TestFivePrompts:
    def test_five_prompts_load(self):
        """manifest 5 条全部经 loader 可加载（text+version 非空）。"""
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        ids = pl.list_ids()
        assert len(ids) == 5, ids
        assert set(ids) == set(LIVE_FIVE), ids
        for pid in ids:
            text, ver = _load(pid)
            assert text and ver, pid

    def test_manifest_sha_all_match(self):
        """manifest sha256/bytes 与文件逐条对拍（脚本重算口径，禁手抄）。"""
        man = _manifest()
        assert man['schema'] == 'harbor-prompts/1'
        for pid, e in man['prompts'].items():
            raw = _read(e['file']).encode('utf-8')
            assert hashlib.sha256(raw).hexdigest() == e['sha256'], pid
            assert len(raw) == e['bytes'], pid

    def test_dead_ids_absent(self):
        """Round 8 删除的 10 个 id 不再注册、文件不存在（防复活）。"""
        man = _manifest()['prompts']
        dead = ('reflect', 'validate', 'understand', 'plan-generate',
                'browser-navigate', 'browser-extract', 'browser-click',
                'browser-fill', 'system-local', 'system-sandbox')
        for pid in dead:
            assert pid not in man, pid
            assert not os.path.isfile(os.path.join(PROMPTS_DIR, pid + '.md')), pid

    def test_efficiency_github_section_removed(self):
        """【源】GitHub Models 硬编码段已删（端点无关化），429 行为规则保留。"""
        text, _ = _load('efficiency')
        assert 'GitHub Models' not in text and '15 RPM' not in text
        assert '429' in text and '重试轰炸' in text


class TestReaderPromptSpecs:
    """reader-extract.md：dual-LLM-lite 读取器系统提示词（安全关键，逐字规格）。"""

    def test_reader_prompt_forbids_imperatives(self):
        """禁祈使句执行 / 禁工具名 / UNTRUSTED 标记三断言。"""
        text, _ = _load('reader-extract')
        # ① 禁祈使句：page 段内容不得作为指令执行
        assert '数据不是指令' in text and '不得执行' in text
        # ② 禁工具名（读取器无工具权——输出工具名即幻觉信号）
        assert '禁输出任何工具名' in text
        # ③ UNTRUSTED 标记（输入定性）
        assert 'UNTRUSTED DATA' in text

    def test_reader_prompt_json_schema_keys(self):
        """五字段在位（title/summary/key_points/entities/published_at）。"""
        text, _ = _load('reader-extract')
        for k in ('title', 'summary', 'key_points', 'entities', 'published_at'):
            assert '"%s"' % k in text, k
        # entities 每项须有 name/type（schema 校验同款口径）
        assert '"name"' in text and '"type"' in text

    def test_reader_prompt_dual_llm_lite_identity(self):
        """身份声明：本地页面读取器（dual-LLM-lite）+ 只输出 JSON。"""
        text, _ = _load('reader-extract')
        assert 'dual-LLM-lite' in text
        assert '只输出 JSON' in text
