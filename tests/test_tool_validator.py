# -*- coding: utf-8 -*-
"""V1 结果校验框架回归（v1.8.0 迭代方案 §6 P1：tool_validator 全工具面）。

覆盖：6 类 validator + 相关度分词（中英）+ reformulate/should_retry 辅助 +
search_service 接线（verdict 驱动换引擎链不回归）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.domains.security.tool_validator import ToolValidator, get_validator, _relevance  # noqa: E402


class TestSearchValidator:
    def setup_method(self):
        self.v = ToolValidator()

    def test_empty_results(self):
        d = self.v.validate_search({'results': []}, 'python')
        assert d['ok'] is False and d['kind'] == 'empty' and d['retryable'] is True

    def test_malformed_missing_fields(self):
        d = self.v.validate_search({'results': [{'title': '', 'url': ''}]}, 'python')
        assert d['ok'] is False and d['kind'] == 'malformed'

    def test_relevant_ok(self):
        rs = {'results': [
            {'title': 'Python 3 官方教程', 'url': 'https://docs.python.org/3',
             'snippet': 'Python 官方教程中文版，从数据类型到面向对象'},
            {'title': 'Python 入门指南', 'url': 'https://www.python.org/about',
             'snippet': 'Python 编程基础与进阶路线'}]}
        d = self.v.validate_search(rs, 'python 教程')
        assert d['ok'] is True and d['kind'] in ('ok', 'thin')
        assert d['confidence'] > 0.3

    def test_irrelevant_blocked(self):
        rs = {'results': [
            {'title': '红烧肉的做法', 'url': 'https://example.com/1',
             'snippet': '五花肉焯水后红烧'},
            {'title': '家常菜谱大全', 'url': 'https://example.com/2',
             'snippet': '各种家常菜品烹饪方法'}]}
        d = self.v.validate_search(rs, 'python 教程')
        assert d['ok'] is False and d['kind'] == 'irrelevant' and d['retryable'] is True

    def test_empty_query_neutral(self):
        rs = {'results': [{'title': 'x', 'url': 'u'}]}
        d = self.v.validate_search(rs, '???')
        assert d['ok'] is True  # 空词集 → 中性 0.5 → thin/ok 放行不误判


class TestRelevanceTokenize:
    def test_chinese_bigram(self):
        assert _relevance('Python 教程', ['Python 官方教程中文版']) > 0.5

    def test_pure_symbol_query(self):
        assert _relevance('***', ['anything']) == 0.5

    def test_no_overlap(self):
        assert _relevance('python', ['红烧肉的做法']) == 0.0


class TestOpenValidator:
    def setup_method(self):
        self.v = ToolValidator()

    def test_ok(self):
        d = self.v.validate_open({'content': '正' * 500})
        assert d['ok'] is True

    def test_empty(self):
        d = self.v.validate_open({'content': ''})
        assert d['ok'] is False and d['kind'] == 'empty'

    def test_thin_nav_shell(self):
        d = self.v.validate_open({'content': '首页 | 登录 | 注册'})
        assert d['ok'] is False and d['kind'] == 'thin'

    def test_api_failure(self):
        d = self.v.validate_open({'ok': False, 'error': 'TIMEOUT'})
        assert d['ok'] is False and d['kind'] == 'failed'


class TestCommandValidator:
    def setup_method(self):
        self.v = ToolValidator()

    def test_zero_exit(self):
        d = self.v.validate_command({'exit_code': 0, 'stdout': 'ok'})
        assert d['ok'] is True and d['kind'] == 'ok'

    def test_zero_no_output_thin(self):
        d = self.v.validate_command({'exit_code': 0, 'stdout': '', 'stderr': ''})
        assert d['ok'] is True and d['kind'] == 'thin'

    def test_not_recognized_retryable(self):
        d = self.v.validate_command({'exit_code': 1, 'stderr': "'foo' is not recognized"})
        assert d['ok'] is False and d['retryable'] is True
        assert '命令不存在' in d['reason']

    def test_permission_not_retryable(self):
        d = self.v.validate_command({'exit_code': 1, 'stderr': 'Permission denied'})
        assert d['ok'] is False and d['retryable'] is False

    def test_chinese_not_found(self):
        d = self.v.validate_command({'exit_code': 1, 'stderr': '不是内部或外部命令'})
        assert d['ok'] is False and '命令不存在' in d['reason']

    def test_unknown_nonzero(self):
        d = self.v.validate_command({'exit_code': 3, 'stderr': 'weird'})
        assert d['ok'] is False and d['kind'] == 'failed' and d['retryable'] is False


class TestFileValidator:
    def test_exists_with_size(self):
        v = ToolValidator(exists_fn=lambda p: True, size_fn=lambda p: 2048)
        d = v.validate_file({'path': 'C:/x/a.py'})
        assert d['ok'] is True

    def test_missing_file(self):
        v = ToolValidator(exists_fn=lambda p: False)
        d = v.validate_file({'path': 'C:/x/a.py'})
        assert d['ok'] is False and d['kind'] == 'malformed' and d['retryable'] is True

    def test_zero_size(self):
        v = ToolValidator(exists_fn=lambda p: True, size_fn=lambda p: 0)
        d = v.validate_file({'path': 'C:/x/a.py'})
        assert d['ok'] is False and d['kind'] == 'thin'

    def test_checker_exception_passthrough(self):
        def boom(p):
            raise OSError('fs down')
        v = ToolValidator(exists_fn=boom)
        d = v.validate_file({'path': 'C:/x'})
        assert d['ok'] is True and d['kind'] == 'thin'

    def test_no_path_skip(self):
        v = ToolValidator()
        d = v.validate_file({'ok': True})
        assert d['ok'] is True


class TestSoftwareValidator:
    def setup_method(self):
        self.v = ToolValidator()

    def test_gui_verified(self):
        d = self.v.validate_software({'kind': 'gui', 'window_verified': True})
        assert d['ok'] is True

    def test_gui_unconfirmed(self):
        d = self.v.validate_software({'kind': 'gui', 'window_verified': False})
        assert d['ok'] is False and d['retryable'] is True

    def test_uri_protocol(self):
        d = self.v.validate_software({'kind': 'uri', 'protocol': 'ms-calc'})
        assert d['ok'] is True

    def test_uri_missing_protocol(self):
        d = self.v.validate_software({'kind': 'uri'})
        assert d['ok'] is False and d['kind'] == 'malformed'

    def test_cli_delegates_command(self):
        d = self.v.validate_software({'kind': 'cli', 'exit_code': 0, 'stdout': 'ok'})
        assert d['ok'] is True


class TestGenericAndDispatch:
    def setup_method(self):
        self.v = ToolValidator()

    def test_generic_ok(self):
        d = self.v.validate('mcp__srv__tool', {'content': [1, 2]})
        assert d['ok'] is True

    def test_generic_error(self):
        d = self.v.validate('mcp__srv__tool', {'ok': False, 'error': 'boom'})
        assert d['ok'] is False and d['kind'] == 'failed'

    def test_dispatch_write_file(self):
        v = ToolValidator(exists_fn=lambda p: True, size_fn=lambda p: 100)
        d = v.validate('write_file', {'path': 'C:/x'})
        assert d['ok'] is True

    def test_dispatch_browser_search(self):
        d = self.v.validate('browser_search', {'results': [{'title': 'a', 'url': 'b'}]},
                            {'query': 'a'})
        assert d['ok'] is True


class TestRetryHelpers:
    def setup_method(self):
        self.v = ToolValidator()

    def test_should_retry_within_limit(self):
        assert self.v.should_retry({'retryable': True}, 0) is True
        assert self.v.should_retry({'retryable': True}, 1) is True
        assert self.v.should_retry({'retryable': True}, 2) is False
        assert self.v.should_retry({'retryable': False}, 0) is False

    def test_reformulate_hint(self):
        h = self.v.reformulate_hint('browser_search', {}, {'suggestion': '换引擎'})
        assert 'browser_search：换引擎' == h

    def test_reformulate_hint_empty(self):
        assert self.v.reformulate_hint('x', {}, {}) == ''

    def test_singleton(self):
        assert get_validator() is get_validator()
