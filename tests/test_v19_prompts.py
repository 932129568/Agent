# -*- coding: utf-8 -*-
"""v1.9.0 T01 提示词契约回归：15 提示词加载 + manifest 一致性 + 新提示词语义规格。

锁定（deliverables/dev-plan/v19-m1m2-design.md §B-T01 测试点）：
- test_fifteen_prompts_load：manifest 15 条全部可加载（loader 口径）；
- test_manifest_sha_all_match：manifest sha256 与文件逐条对拍；
- test_existing_ten_unchanged：既有 10 文件 sha256 与旧 manifest 逐字一致（零漂移）；
- test_browser_navigate_prompt_spec：url/wait_selector 输出键与禁非 http(s) 协议句在位；
- test_browser_click_prompt_forbids_hidden：禁不可见/遮挡元素句在位；
- test_reader_prompt_forbids_imperatives：禁祈使句/禁工具名/UNTRUSTED 标记三断言；
- test_reader_prompt_json_schema_keys：title/summary/key_points/entities/published_at 五字段在位。
"""
import hashlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           'backend', 'prompts')

# 旧 manifest（v1.8.0，10 条）逐字快照——迁移零漂移锚（改文件即漂移，必须同步新旧两份）
OLD_TEN_SHA256 = {
    'compact': 'fb11f7500bf4e7d31e19d25bbeecaf83fbb20a29dafe4d2c0368dd7b3b7526f2',
    'efficiency': '88a709ffafb5715f1c967868a3b75d21f5d3e08f1d06c82acd283af5c4a5005d',
    'plan-generate': 'c8fb8264964b25d07d70c6da553c17b30247bc8ac6c811be5516b960d50d175b',
    'reflect': 'e1076bee92ded3b8c279ed2e6fd4fe0093ca088a6bebb18661b523ebe24df10c',
    'system-base': '4541885196c0d691e48212ef6ee0e0f4e96238ff59b8f157ad4b2720df1c6616',
    'system-local': '7afd9a282de2b795685af6a65214491f2f516c3f0bbb8eab692ac053df3d3544',
    'system-sandbox': '2a9a8174c1dc7a6e973ccf8e9257bc81504c5adf648bbd2fc6fb5fd0853ae40e',
    'system-ws-off': '79ff1443f9511f75d3efe2a0587858fa8600dd1ac0d47b21c7b41f77000221ad',
    'understand': '5319f2316a2e9e485b0ca19b224015259d4913878fdd0c1aa84caa93dfacdab9',
    'validate': 'f2ece458b10c8472cd7ae04ee54a4485b97af4d2022ffbd2f64351c0d8c02c7f',
}

NEW_FIVE = ('browser-navigate', 'browser-extract', 'browser-click',
            'browser-fill', 'reader-extract')


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


class TestFifteenPrompts:
    def test_fifteen_prompts_load(self):
        """manifest 15 条全部经 loader 可加载（text+version 非空）。"""
        from backend.domains.providers import prompt_loader as pl
        pl.clear_cache()
        ids = pl.list_ids()
        assert len(ids) == 15, ids
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
            assert e['version'] == '1.0.0', pid

    def test_existing_ten_unchanged(self):
        """既有 10 文件 sha256 与旧 manifest 逐字一致（T01 零漂移硬门）。"""
        man = _manifest()['prompts']
        for pid, old_sha in OLD_TEN_SHA256.items():
            assert pid in man, pid
            assert man[pid]['sha256'] == old_sha, pid

    def test_new_five_registered(self):
        """5 个新 id 在 manifest 且 file 字段指向真实文件。"""
        man = _manifest()['prompts']
        for pid in NEW_FIVE:
            assert pid in man, pid
            assert man[pid]['file'] == pid + '.md', pid
            assert os.path.isfile(os.path.join(PROMPTS_DIR, man[pid]['file'])), pid


class TestBrowserPromptSpecs:
    """M1.8 四个浏览器提示词的内容规格（安全关键句在位）。"""

    def test_browser_navigate_prompt_spec(self):
        """url/wait_selector 输出键 + 禁非 http(s) 协议句在位。"""
        text, ver = _load('browser-navigate')
        assert ver == '1.0.0'
        assert '"url"' in text and 'wait_selector' in text
        assert 'http/https' in text or 'http(s)' in text
        # 禁协议句：file:// / javascript: / about: 明确拒绝
        assert 'file://' in text and 'javascript:' in text and 'about:' in text

    def test_browser_extract_prompt_spec(self):
        """提取参数提示词：selector/mode/max_chars 三键与取值域在位。"""
        text, _ = _load('browser-extract')
        assert '"selector"' in text and '"mode"' in text and 'max_chars' in text
        assert 'markdown' in text and 'links' in text

    def test_browser_click_prompt_forbids_hidden(self):
        """禁不可见/遮挡元素句在位（防点击隐藏元素的安全语义）。"""
        text, _ = _load('browser-click')
        assert '可见' in text and '遮挡' in text
        assert 'display:none' in text or 'visibility:hidden' in text

    def test_browser_fill_prompt_spec(self):
        """表单填充提示词：masked 恒真语义 + 禁指令性内容在位。"""
        text, _ = _load('browser-fill')
        assert 'masked' in text and 'selector' in text
        assert '指令' in text


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
