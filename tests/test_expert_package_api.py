# -*- coding: utf-8 -*-
"""W5A API facade and public protocol non-regression checks."""
import json
import threading

from backend.api import API_VERSION, Api, _V12_EXTRA
from test_expert_package_service import make_agent_package, make_service


class StubContainer:
    def __init__(self, expert):
        self.expert = expert
        self._export_paths = set()
        self._export_paths_lock = threading.Lock()

    def api_aliases(self):
        return {'_expert': self.expert}


def test_expert_methods_are_only_v12_extra_and_public_info_unchanged(tmp_path):
    expected = {'expert_list', 'expert_get', 'expert_import_directory', 'expert_read_resource',
                'expert_save_preferences', 'expert_set_enabled', 'expert_delete_package'}
    assert expected <= _V12_EXTRA
    assert not {'expert_team_create', 'expert_member_spawn', 'TeamCreate', 'Agent', 'SendMessage'} & _V12_EXTRA
    api = Api(container=StubContainer(make_service(tmp_path)))
    info = json.loads(api.get_api_info())
    assert info['version'] == API_VERSION
    assert not expected & set(info['methods'])
    assert not any(name in info['methods'] for name in ('TeamCreate', 'Agent', 'SendMessage'))


def test_api_json_shapes_and_config_file_zero_drift(tmp_path):
    source = make_agent_package(tmp_path / 'source')
    service = make_service(tmp_path)
    api = Api(container=StubContainer(service))
    config = tmp_path / 'config.json'
    original = b'{"existing":true,"untouched":"secret-not-read"}'
    config.write_bytes(original)
    imported = json.loads(api.expert_import_directory(str(source)))
    assert imported['ok'] is True
    assert json.loads(api.expert_list())['packages'][0]['id'] == 'demo.expert'
    assert json.loads(api.expert_get('demo.expert'))['package']['id'] == 'demo.expert'
    resource = json.loads(api.expert_read_resource(imported['snapshot_id'], 'skills/demo/references/guide.md'))
    assert resource['ok'] is True and resource['truncated'] is False
    assert json.loads(api.expert_save_preferences('{"limits":{"maxTurns":20}}'))['limits']['maxTurns'] == 20
    assert json.loads(api.expert_set_enabled('demo.expert', True))['enabled'] is True
    assert json.loads(api.expert_delete_package('demo.expert'))['deleted'] is True
    assert config.read_bytes() == original
