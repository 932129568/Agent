# -*- coding: utf-8 -*-
"""W11 记忆 UI 后端回归：memory_delete（js_api 隐身）+ delete_memory 数据层。

覆盖：合法删除/越界/非整数拒绝（bool/None/float/str）/空文件/审计落盘。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


def _read_memory():
    from backend import paths
    p = paths.MEMORY_PATH
    if not os.path.exists(p):
        return []
    with io.open(p, encoding='utf-8') as f:
        return json.load(f)


class TestMemoryDelete:
    def test_delete_valid_index(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory(json.dumps({'text': '第一条'}))
        api.append_memory(json.dumps({'text': '第二条'}))
        api.append_memory(json.dumps({'text': '第三条'}))
        r = json.loads(api.memory_delete(1))
        assert r['ok'] is True and r['remaining'] == 2
        items = _read_memory()
        assert [x['text'] for x in items] == ['第一条', '第三条']

    def test_delete_out_of_range(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory(json.dumps({'text': 'only'}))
        r = json.loads(api.memory_delete(5))
        assert r['ok'] is False
        assert r['error']['code'] == 'BAD_PARAMS'
        assert len(_read_memory()) == 1          # 未动数据

    def test_delete_negative_index(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory(json.dumps({'text': 'x'}))
        r = json.loads(api.memory_delete(-1))
        assert r['ok'] is False and r['error']['code'] == 'BAD_PARAMS'

    def test_delete_rejects_non_int(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.append_memory(json.dumps({'text': 'x'}))
        for bad in ('abc', 1.5, None, True):
            r = json.loads(api.memory_delete(bad))
            assert r['ok'] is False, bad
            assert r['error']['code'] == 'BAD_PARAMS', bad
        assert len(_read_memory()) == 1

    def test_delete_empty_file(self, fresh_home):
        from backend.api import Api
        api = Api()
        r = json.loads(api.memory_delete(0))
        assert r['ok'] is False and r['error']['code'] == 'BAD_PARAMS'

    def test_delete_audit_written(self, fresh_home):
        from backend.api import Api
        from backend.domains.security.guard_service import AUDIT_LOG
        api = Api()
        api.append_memory(json.dumps({'text': 'y'}))
        json.loads(api.memory_delete(0))
        log = AUDIT_LOG
        assert os.path.exists(log)
        lines = io.open(log, encoding='utf-8').read().strip().splitlines()
        rec = [json.loads(x) for x in lines if 'memory_delete' in x]
        assert rec and rec[-1]['op'] == 'memory_delete'
        assert rec[-1]['decision'] == 'deleted'

    def test_delete_block_audit(self, fresh_home):
        from backend.api import Api
        from backend.domains.security.guard_service import AUDIT_LOG
        api = Api()
        json.loads(api.memory_delete(0))          # 空 → 拒绝
        lines = io.open(AUDIT_LOG, encoding='utf-8').read().strip().splitlines()
        rec = [json.loads(x) for x in lines if 'memory_delete' in x]
        assert rec and rec[-1]['action'] == 'block'
        assert rec[-1]['decision'] == 'BAD_PARAMS'

    def test_in_v12_extra(self):
        from backend.api import _V12_EXTRA
        assert 'memory_delete' in _V12_EXTRA

    def test_api_info_stealth(self, fresh_home):
        from backend.api import Api
        info = Api().get_api_info()
        assert 'memory_delete' not in info
