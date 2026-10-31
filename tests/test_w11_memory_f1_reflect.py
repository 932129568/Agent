# -*- coding: utf-8 -*-
"""W11 记忆结构化三类 + F1 自反思补做环（交接文档「后端应该做的」）。

W11（memory_service）：三类分类（fact/preference/rule）/ 规则句式提取 /
bigram 关键词检索（rule 加成 + 时间衰减）/ 系统提示注入段 / 去重与淘汰 /
build_system_prompt 注入 / memory_retrieve js_api。
F1（tool_validator.reflect_loop）：执行→校验→reformulate→重试 ≤2 补做环。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


class TestClassify:
    def test_rule_patterns(self):
        from backend.domains.settings.memory_service import classify
        assert classify('以后都先写测试') == 'rule'
        assert classify('每次都要跑 lint') == 'rule'
        assert classify('禁止直接提交到 main') == 'rule'
        assert classify('必须 UTF-8') == 'rule'

    def test_preference_patterns(self):
        from backend.domains.settings.memory_service import classify
        assert classify('我喜欢暗色主题') == 'preference'
        assert classify('偏好简短的回复') == 'preference'

    def test_fact_default(self):
        from backend.domains.settings.memory_service import classify
        assert classify('项目用 Vite 构建') == 'fact'
        assert classify('') == 'fact'


class TestRetrieve:
    def _items(self):
        return [
            {'text': '以后都先写测试再写实现', 'ts': '10-20 10:00', 'kind': 'rule'},
            {'text': '项目用 Vite 构建前端', 'ts': '10-19 10:00', 'kind': 'fact'},
            {'text': '部署在 D 盘 harbor 目录', 'ts': '10-18 10:00', 'kind': 'fact'},
            {'text': '完全无关的闲聊内容', 'ts': '10-17 10:00', 'kind': 'fact'},
        ]

    def test_relevant_first(self):
        from backend.domains.settings.memory_service import retrieve
        r = retrieve('写测试', self._items(), 3)
        assert r and '测试' in r[0]['text']

    def test_rule_boosted(self):
        from backend.domains.settings.memory_service import retrieve
        # query 同时沾边 rule 与 fact 时，rule 加成后置顶
        items = self._items() + [{'text': '测试覆盖率要求', 'ts': '10-21 09:00',
                                  'kind': 'fact'}]
        r = retrieve('测试', items, 3)
        assert r[0]['kind'] == 'rule'

    def test_no_overlap_empty(self):
        from backend.domains.settings.memory_service import retrieve
        assert retrieve('量子计算', self._items(), 3) == []

    def test_limit_respected(self):
        from backend.domains.settings.memory_service import retrieve
        assert len(retrieve('的', self._items(), 2)) <= 2


class TestInjectBlock:
    def test_empty_items_no_block(self):
        from backend.domains.settings.memory_service import inject_block
        assert inject_block([]) == ''

    def test_kind_labels_and_cap(self):
        from backend.domains.settings.memory_service import inject_block
        items = [{'text': '以后都先写测试', 'ts': '10-21 09:00', 'kind': 'rule'},
                 {'text': '我喜欢简洁', 'ts': '10-21 09:00', 'kind': 'preference'}]
        b = inject_block(items)
        assert '[规则]' in b and '[偏好]' in b and '当前指令为准' in b

    def test_char_cap(self):
        from backend.domains.settings.memory_service import inject_block
        items = [{'text': '长' * 500, 'ts': '10-21 09:00', 'kind': 'fact'}]
        b = inject_block(items, max_chars=100)
        assert len(b) <= 120          # 单条超限截断 + 总量封顶


class TestServiceCrud:
    def _svc(self):
        from backend.domains.settings.memory_service import MemoryService
        from backend import paths
        return MemoryService(paths.MEMORY_PATH)

    def test_append_classifies(self, fresh_home):
        s = self._svc()
        r = s.append({'text': '以后都先写测试'})
        assert r['ok'] and r['kind'] == 'rule'
        assert s.list()[-1]['kind'] == 'rule'

    def test_rule_dedupe(self, fresh_home):
        s = self._svc()
        s.append({'text': '以后都先写测试'})
        s.append({'text': ' 以后都先写测试 '})     # 同规则（空白差异）去重
        assert len([x for x in s.list() if '先写测试' in x['text']]) == 1

    def test_fact_no_dedupe(self, fresh_home):
        s = self._svc()
        s.append({'text': '同一个事实'})
        s.append({'text': '同一个事实'})
        assert len([x for x in s.list() if x['text'] == '同一个事实']) == 2

    def test_legacy_migration_lazy(self, fresh_home):
        from backend import paths
        os.makedirs(os.path.dirname(paths.MEMORY_PATH), exist_ok=True)
        with open(paths.MEMORY_PATH, 'w', encoding='utf-8') as f:
            json.dump([{'text': '旧数据无 kind', 'ts': '10-01 08:00'}], f)
        s = self._svc()
        items = s.list()
        assert items[0]['kind'] == 'fact'          # 懒迁移分类
        # 读不落盘（原文件不变）
        raw = json.load(open(paths.MEMORY_PATH, encoding='utf-8'))
        assert 'kind' not in raw[0]

    def test_delete(self, fresh_home):
        s = self._svc()
        s.append({'text': 'a'}); s.append({'text': 'b'})
        r = s.delete(0)
        assert r['ok'] and r['remaining'] == 1
        assert s.list()[0]['text'] == 'b'

    def test_delete_out_of_range(self, fresh_home):
        s = self._svc()
        assert 'error' in s.delete(5)

    def test_empty_text_accepted(self, fresh_home):
        """对齐 legacy：空 text 也入库（契约钉住的行为；分类回落 fact）。"""
        s = self._svc()
        r = s.append({'text': '   '})
        assert r['ok'] and r['kind'] == 'fact' 


class TestApiWiring:
    def test_append_bare_string(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().append_memory('以后都先写测试'))
        assert r['ok'] and r['kind'] == 'rule'

    def test_get_memory_structured(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory('以后都先写测试')
        items = json.loads(api.get_memory())
        assert items[-1]['kind'] == 'rule'

    def test_memory_retrieve_js_api(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory('以后都先写测试再写实现')
        r = json.loads(api.memory_retrieve('写测试'))
        assert r['ok'] and any('测试' in i['text'] for i in r['items'])

    def test_build_system_prompt_injects(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory('以后都先写测试再写实现')
        out = api.build_system_prompt('帮我写个功能')
        assert '【长期记忆】' in out and '先写测试' in out

    def test_build_system_prompt_no_memory_clean(self, fresh_home):
        """无记忆 → 不加注入段（与 legacy 同形态）。"""
        from backend.api import Api
        out = Api().build_system_prompt()
        assert '【长期记忆】' not in out

    def test_build_system_prompt_default_arg_compat(self, fresh_home):
        """legacy 零参调用不炸（向后兼容）。"""
        from backend.api import Api
        out = Api().build_system_prompt()
        assert ' Harbor 内置编程助手' in out

    def test_stealth(self):
        from backend.api import _V12_EXTRA
        assert 'memory_retrieve' in _V12_EXTRA


class TestReflectLoop:
    """F1 自反思补做环（deep-research W7：reflect + verdict + 补做 ≤2）。"""

    def test_success_first_try(self):
        from backend.domains.security.tool_validator import ToolValidator
        r = ToolValidator.reflect_loop(
            'browser_search', {'query': 'python'},
            lambda p: {'ok': True, 'query': 'python',
                       'results': [{'title': 'Python', 'url': 'https://py.org',
                                    'snippet': '官网'}]},
            context={'query': 'python'})
        assert r['ok'] and r['attempts'] == 1

    def test_retry_with_reformulate(self):
        from backend.domains.security.tool_validator import ToolValidator
        calls = []

        def exec_fn(p):
            calls.append(p.get('engine'))
            if p.get('engine') == 'duckduckgo':
                return {'ok': True, 'results': [{'title': 'x', 'url': 'u',
                                                 'snippet': 's'}], 'query': 'q'}
            return {'ok': True, 'results': [], 'query': 'q'}

        def on_attempt(n, params, verdict):
            return dict(params, engine='duckduckgo')

        r = ToolValidator.reflect_loop(
            'browser_search', {'query': 'q', 'engine': 'bing'}, exec_fn,
            context={'query': 'q'}, on_attempt=on_attempt)
        assert r['ok'] and r['attempts'] == 2
        assert calls == ['bing', 'duckduckgo']

    def test_hard_cap_two(self):
        from backend.domains.security.tool_validator import ToolValidator
        n = []

        def exec_fn(p):
            n.append(1)
            return {'ok': True, 'results': [], 'query': 'q'}

        r = ToolValidator.reflect_loop('browser_search', {'query': 'q'},
                                       exec_fn, context={'query': 'q'})
        assert not r['ok'] and len(n) == 2          # 硬上限 2（W7 ≤2）
        assert r['verdict'].get('retryable') is False or r['attempts'] == 2

    def test_exec_exception_short_circuit(self):
        from backend.domains.security.tool_validator import ToolValidator

        def boom(p):
            raise RuntimeError('网络炸了')

        r = ToolValidator.reflect_loop('browser_search', {'query': 'q'}, boom)
        assert not r['ok'] and r['verdict']['kind'] == 'exec_error'
        assert r['attempts'] == 1                    # 执行异常不重试（重试无益）

    def test_history_records_hints(self):
        from backend.domains.security.tool_validator import ToolValidator
        r = ToolValidator.reflect_loop(
            'browser_search', {'query': 'q'},
            lambda p: {'ok': True, 'results': [], 'query': 'q'},
            context={'query': 'q'})
        assert len(r['history']) == 2
        assert all('verdict' in h for h in r['history'])
