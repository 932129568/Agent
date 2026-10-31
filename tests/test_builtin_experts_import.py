# -*- coding: utf-8 -*-
"""Builtin WorkBuddy expert conversion and strict import regressions."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

from backend import paths
from backend.bootstrap import container as container_module
from backend.domains.expert.builtin_importer import WorkBuddyBuiltinImporter
from backend.domains.expert.service import ExpertPackageService
from test_expert_center import CENTER_HELPERS, CENTER_MODULES
from test_model_executor_foundation import run_case

ROOT = Path(__file__).resolve().parent.parent
BUILTIN_DIR = ROOT / 'backend' / 'experts_builtin'
EXPECTED_IDS = {
    'design-engine', 'fullstack-dev-engineer', 'product-management',
    'product-strategy-team', 'qa-testing', 'senior-developer',
    'software-company', 'valorant-perler-expert',
}


def make_service(tmp_path):
    return ExpertPackageService(registry_path=str(tmp_path / 'experts.json'),
                                root=str(tmp_path / 'managed'))


def test_all_eight_builtin_packages_import_idempotently_and_read_text(tmp_path):
    config = tmp_path / 'config.json'
    original = b'{"existing":true,"secret-not-read":"unchanged"}'
    config.write_bytes(original)
    service = make_service(tmp_path)
    importer = WorkBuddyBuiltinImporter(service, str(BUILTIN_DIR))
    first = importer.import_all()
    assert first['ok'] is True and first['imported'] == 8
    listed = service.list()['packages']
    assert {item['id'] for item in listed} == EXPECTED_IDS
    assert all(item['source'] == {'kind': 'builtin', 'name': item['id']} for item in listed)
    assert all(item['enabled'] is False for item in listed)

    for item in listed:
        detail = service.get(item['id'])['package']
        agent = detail['agents'][0]
        agent_text = service.read_resource(detail['snapshot_id'], agent['path'])
        assert agent_text['ok'] is True and agent_text['text'].strip()
        if detail['skills']:
            skill = detail['skills'][0]
            skill_text = service.read_resource(detail['snapshot_id'], skill['path'])
            assert skill_text['ok'] is True and skill_text['text'].strip()

    second = importer.import_all()
    assert second['ok'] is True and second['imported'] == 8
    for package_id in EXPECTED_IDS:
        assert len(service._data['packages'][package_id]['snapshots']) == 1
    assert config.read_bytes() == original


def test_builtin_enable_disable_and_delete_restart_recovery(tmp_path):
    service = make_service(tmp_path)
    importer = WorkBuddyBuiltinImporter(service, str(BUILTIN_DIR))
    assert importer.import_all()['ok'] is True
    enabled = service.set_enabled('qa-testing', True)
    assert enabled['ok'] is True and enabled['enabled'] is True
    disabled = service.set_enabled('qa-testing', False)
    assert disabled['ok'] is True and disabled['enabled'] is False

    deleted = service.delete_package('design-engine')
    assert deleted['ok'] is True
    assert 'design-engine' not in {item['id'] for item in service.list()['packages']}
    restarted = make_service(tmp_path)
    recovered = WorkBuddyBuiltinImporter(restarted, str(BUILTIN_DIR)).import_all()
    assert recovered['ok'] is True and recovered['imported'] == 8
    restored = next(item for item in restarted.list()['packages'] if item['id'] == 'design-engine')
    assert restored['source']['kind'] == 'builtin' and restored['enabled'] is False


def test_builtin_conversion_rules_and_asset_filtering(tmp_path):
    service = make_service(tmp_path)
    importer = WorkBuddyBuiltinImporter(service, str(BUILTIN_DIR))
    assert importer.import_all()['ok'] is True

    fullstack = service.get('fullstack-dev-engineer')['package']
    qa = service.get('qa-testing')['package']
    valorant = service.get('valorant-perler-expert')['package']
    assert 'plugin' not in fullstack['metadata'] and 'plugin' not in qa['metadata']
    assert 'plugin' not in valorant['metadata']

    for package_id in ('design-engine', 'product-strategy-team', 'software-company'):
        team = service.get(package_id)['package']['team']
        assert team['settingsPath'] == '.codebuddy-plugin/settings.json'
    strategy = service.get('product-strategy-team')['package']['metadata']
    assert strategy['displayName'] == strategy['profession']

    senior = service.get('senior-developer')['package']
    browser_skill = next(skill for skill in senior['skills'] if skill['name'] == 'browser-use')
    browser_text = service.read_resource(senior['snapshot_id'], browser_skill['path'])['text']
    assert browser_text.startswith('---\nname: "browser-use"\n')
    assert 'allowed-tools' not in browser_text.split('---', 2)[1]
    assert 'or extract information from web pages.' in browser_text
    assert '# Browser Automation with browser-use CLI' in browser_text

    assert {skill['name'] for skill in valorant['skills']} == {
        'valorant-perler', 'valorant-knowledge', 'perler-repair'}

    converted_design = importer.convert_package(BUILTIN_DIR / 'design-engine',
                                                tmp_path / 'design-converted')
    converted_valorant = importer.convert_package(BUILTIN_DIR / 'valorant-perler-expert',
                                                  tmp_path / 'valorant-converted')
    for converted in (converted_design, converted_valorant):
        files = [item for item in Path(converted).rglob('*') if item.is_file()]
        assert all(item.stat().st_size <= 1024 * 1024 for item in files)
        assert all('avatars' not in item.parts for item in files)
        assert all('showcase' not in item.parts for item in files)

    qa_package = service.get('qa-testing')['package']
    assert qa_package['scripts']
    script = qa_package['scripts'][0]['path']
    denied = service.read_resource(qa_package['snapshot_id'], script)
    assert denied['ok'] is False and 'text' not in denied


def test_builtin_import_has_zero_process_network_and_user_import_stays_strict(tmp_path, monkeypatch):
    def fail_call(*args, **kwargs):
        raise AssertionError('builtin import must not spawn a process or open a socket')

    monkeypatch.setattr(subprocess, 'Popen', fail_call)
    monkeypatch.setattr(subprocess, 'run', fail_call)
    monkeypatch.setattr(os, 'system', fail_call)
    monkeypatch.setattr(socket, 'socket', fail_call)
    service = make_service(tmp_path)
    result = WorkBuddyBuiltinImporter(service, str(BUILTIN_DIR)).import_all()
    assert result['ok'] is True and result['imported'] == 8

    source = tmp_path / 'user-package'
    (source / '.codebuddy-plugin').mkdir(parents=True)
    (source / '.codebuddy-plugin' / 'plugin.json').write_text(
        json.dumps({'name': 'invalid.expert', 'version': '1.0.0', 'plugin': 'invalid'}), encoding='utf-8')
    strict = service.import_directory(str(source))
    assert strict['ok'] is False
    assert strict['error']['code'] == 'METADATA_FIELD_UNKNOWN'


def test_frozen_builtin_path_and_spec_datas(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr(sys, '_MEIPASS', str(tmp_path), raising=False)
    expected = Path(tmp_path) / 'backend' / 'experts_builtin'
    assert Path(paths.builtin_experts_dir()) == expected

    spec = (ROOT / 'Harbor.spec').read_text(encoding='utf-8')
    assert "('backend/experts_builtin', 'backend/experts_builtin')" in spec
    container_source = (ROOT / 'backend' / 'bootstrap' / 'container.py').read_text(encoding='utf-8')
    assert 'WorkBuddyBuiltinImporter(self.expert).import_all()' in container_source


def test_expert_center_shows_builtin_source_and_ordinary_chat_has_no_expert_calls():
    result = run_case(CENTER_HELPERS + r'''
resetCenter();
callApi = async (name, args) => {
  if (name === 'expert_list') return {ok: true, packages: [
    {id:'builtin.expert', name:'builtin.expert', kind:'agent', version:'1.0.0', enabled:false,
     source:{kind:'builtin', name:'builtin.expert'}}]};
  if (name === 'expert_get') return {ok: true, package: {
    id:'builtin.expert', snapshot_id:'b'.repeat(64), kind:'agent', version:'1.0.0',
    metadata:{name:'builtin.expert', description:'Builtin package'},
    agents:[], team:{}, skills:[], resources:[], scripts:[], limits:{}, validation:{}}};
  throw new Error('unexpected API ' + name);
};
const ordinary = await runExpertSelection();
await openExpertCenter();
await expertSelectPackage('builtin.expert');
return {ordinary, ordinaryCalls:ordinary === undefined ? [] : [],
  listText:textOf(document.getElementById('expertPackageList')),
  detailText:textOf(document.getElementById('expertPackageDetail'))};
''', CENTER_MODULES)
    assert result['ordinary']['status'] == 'ordinary'
    assert '内置' in result['listText']
    assert '内置' in result['detailText']
