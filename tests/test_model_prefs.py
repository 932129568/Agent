# -*- coding: utf-8 -*-
"""复核批新增：推理偏好（思考强度/上下文窗口）验收测试。

锁定：
- model_prefs.json 独立文件（config.json 零污染铁律——get_config 无新键突变）；
- get 默认 / save 合法往返 / thinking 白名单拒绝 / ctx_k 越界拒绝；
- 坏文件 .bad 备份回落默认；js_api 隐身登记（_V12_EXTRA）+ get_api_info 零漂移
  由既有契约套件承载，此处只测服务层 + api 装配可达。
"""
import json
import os
from pathlib import Path

import pytest

from conftest import fresh_home  # noqa: F401  （autouse 隔离 HOME）


class TestModelPrefsService:
    def _svc(self, tmp_path):
        from backend.domains.settings.model_prefs_service import ModelPrefsService
        return ModelPrefsService(path=str(Path(tmp_path) / 'model_prefs.json'))

    def test_default_when_absent(self, tmp_path):
        s = self._svc(tmp_path)
        g = s.get()
        assert g['thinking'] == 'auto' and g['ctx_k'] == 0 and g['ok'] is True

    def test_save_roundtrip(self, tmp_path):
        s = self._svc(tmp_path)
        r = s.save({'thinking': 'high', 'ctx_k': 300})
        assert r['ok'] is True and r['thinking'] == 'high' and r['ctx_k'] == 300
        g = s.get()
        assert g['ok'] is True and g['thinking'] == 'high' and g['ctx_k'] == 300
        # 落盘文件形状（version 键 + 两字段；ok 是读视图键不落盘）
        d = json.loads(Path(str(tmp_path) + '/model_prefs.json').read_text(encoding='utf-8'))
        assert d['thinking'] == 'high' and d['ctx_k'] == 300 and 'ok' not in d

    def test_save_accepts_json_string(self, tmp_path):
        s = self._svc(tmp_path)
        r = s.save(json.dumps({'thinking': 'off', 'ctx_k': 32}))
        assert r['ok'] is True and s.get()['thinking'] == 'off'

    def test_thinking_whitelist(self, tmp_path):
        s = self._svc(tmp_path)
        for bad in ('max', 'always', 1, None):
            r = s.save({'thinking': bad, 'ctx_k': 0})
            assert r.get('error'), bad
        assert s.get()['thinking'] == 'auto'            # 拒绝后默认不变

    def test_ctx_k_bounds(self, tmp_path):
        s = self._svc(tmp_path)
        assert s.save({'thinking': 'auto', 'ctx_k': -1}).get('error')
        assert s.save({'thinking': 'auto', 'ctx_k': 2048})['ok'] is True    # 上限 2048K=2M tokens
        assert s.save({'thinking': 'auto', 'ctx_k': 2049}).get('error')
        assert s.save({'thinking': 'auto', 'ctx_k': 'abc'}).get('error')

    def test_ctx_k_clamps_to_frontend_supported_values(self, tmp_path):
        s = self._svc(tmp_path)
        for raw, want in ((1, 0), (32, 32), (100, 32), (128, 128),
                          (200, 128), (299, 256), (300, 300), (2048, 1024)):
            r = s.save({'thinking': 'auto', 'ctx_k': raw})
            assert r['ok'] is True and r['ctx_k'] == want, (raw, r)
        p = Path(tmp_path) / 'model_prefs.json'
        p.write_text(json.dumps({'thinking': 'auto', 'ctx_k': 200}), encoding='utf-8')
        assert self._svc(tmp_path).get()['ctx_k'] == 128

    def test_corrupt_file_bad_backup(self, tmp_path):
        p = Path(tmp_path) / 'model_prefs.json'
        p.write_text('{corrupt!!!', encoding='utf-8')
        s = self._svc(tmp_path)
        assert Path(str(p) + '.bad').exists()
        g = s.get()
        assert g['ok'] is True and g['thinking'] == 'auto' and g['ctx_k'] == 0

    def test_config_json_untouched(self):
        """config.json 零污染铁律：get_config 输出不含推理偏好键。"""
        from backend.domains.settings.config_service import ConfigService
        cfg = json.loads(ConfigService().get_config())
        assert 'model_prefs' not in cfg
        assert 'thinking' not in cfg and 'ctx_k' not in cfg


class TestModelPrefsApi:
    def test_registered_stealth_and_callable(self):
        """_V12_EXTRA 隐身登记（get_api_info 零漂移由契约套件承载）。"""
        from backend.api import _V12_EXTRA
        assert 'model_prefs_get' in _V12_EXTRA
        assert 'model_prefs_save' in _V12_EXTRA

    def test_api_roundtrip(self):
        from backend.api import Api
        api = Api()
        r = json.loads(api.model_prefs_save(json.dumps({'thinking': 'medium', 'ctx_k': 128})))
        assert r.get('ok') is True, r
        r2 = json.loads(api.model_prefs_get())
        assert r2.get('ok') is True
        assert r2['thinking'] == 'medium' and r2['ctx_k'] == 128
        # 审计落账（decision=save）
        raw = api._guard.read_audit(limit=5, offset=0)
        entries = json.loads(raw)['entries']
        assert any(e.get('op') == 'model_prefs' and e.get('decision') == 'save'
                   for e in entries)
