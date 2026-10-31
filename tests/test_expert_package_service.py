# -*- coding: utf-8 -*-
"""W5A real directory/snapshot/registry behavior for expert packages."""
import hashlib
import json
from pathlib import Path

import pytest

from backend.domains.expert.service import ExpertPackageService


def write(root, relative, content):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding='utf-8')
    return path


def dump(value):
    return json.dumps(value, ensure_ascii=False)


def agent_metadata(package_id='demo.expert', kind='agent', agent='researcher'):
    data = {
        'name': package_id, 'version': '1.0.0', 'description': 'Demo expert',
        'agents': './agents/', 'skills': ['skills/demo'], 'expertType': kind,
        'agentName': agent,
    }
    if kind == 'team':
        data.update({
            'teamInfo': {'leadAgent': agent, 'memberAgents': ['researcher']},
            'displayName': {'en': 'Demo Team', 'zh': '演示团队'},
            'profession': {'en': 'Demo Team', 'zh': '演示团队'},
            'members': [
                {'id': agent, 'name': {'zh': '主理人'}, 'role': 'lead'},
                {'id': 'researcher', 'name': {'zh': '研究员'}, 'role': 'member'},
            ],
        })
    return data


def make_agent_package(root, metadata_path='.codebuddy-plugin/plugin.json', package_id='demo.expert'):
    write(root, metadata_path, dump(agent_metadata(package_id=package_id)))
    write(root, 'agents/researcher.md', '''---
name: researcher
description: Research specialist
displayName: {zh: 研究员, en: Researcher}
profession:
  zh: 研究员
  en: Researcher
maxTurns: 8
---
# Researcher

Use evidence and return a concise answer.
''')
    write(root, 'skills/demo/SKILL.md', '''---
name: demo
description: |-
  Demo skill.
  Trigger: demo
---
# Demo

- @references/guide.md
- @templates/report.md
''')
    write(root, 'skills/demo/references/guide.md', '# Evidence guide\nUse stable inputs.\n')
    write(root, 'skills/demo/templates/report.md', '# Report template\n')
    write(root, 'skills/demo/scripts/do_not_run.py', 'raise RuntimeError("must never execute")\n')
    return root


def make_team_package(root, metadata_path='.workbuddy-plugin/plugin.json'):
    write(root, metadata_path, dump(agent_metadata('team.expert', 'team', 'orchestrator')))
    write(root, 'settings.json', dump({'agent': 'orchestrator'}))
    write(root, 'agents/orchestrator.md', '''---
name: orchestrator
description: Team lead
---
# Lead
Coordinate researcher.
''')
    write(root, 'agents/researcher.md', '''---
name: researcher
description: Research member
---
# Member
Return findings through SendMessage.
''')
    write(root, 'skills/demo/SKILL.md', '''---
name: demo
description: Team skill
---
# Team skill
''')
    return root


def make_service(tmp_path):
    return ExpertPackageService(registry_path=str(tmp_path / 'experts.json'),
                                root=str(tmp_path / 'managed'))


def test_import_list_get_read_enable_preferences_delete_preserves_source(tmp_path):
    source = make_agent_package(tmp_path / 'source')
    before = {path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in source.rglob('*') if path.is_file()}
    service = make_service(tmp_path)
    imported = service.import_directory(str(source))
    assert imported['ok'] is True and imported['activated'] is False
    assert before == {path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in source.rglob('*') if path.is_file()}
    listed = service.list()
    assert listed['ok'] is True and len(listed['packages']) == 1
    assert 'text' not in listed['packages'][0] and listed['packages'][0]['enabled'] is False
    detail = service.get('demo.expert')
    assert detail['ok'] is True and detail['package']['snapshot_id'] == imported['snapshot_id']
    assert 'body' not in detail['package']['agents'][0]
    resource = service.read_resource(imported['snapshot_id'], 'skills/demo/references/guide.md')
    assert resource['ok'] is True and resource['truncated'] is False
    assert resource['provenance']['snapshotId'] == imported['snapshot_id']
    assert resource['sha256'] == hashlib.sha256((source / 'skills/demo/references/guide.md').read_bytes()).hexdigest()
    denied = service.read_resource(imported['snapshot_id'], 'skills/demo/scripts/do_not_run.py')
    assert denied['ok'] is False and 'text' not in denied['error']
    enabled = service.set_enabled('demo.expert', True)
    assert enabled['ok'] is True and enabled['active_snapshot'] == imported['snapshot_id']
    switched = service.set_enabled('demo.expert', True, imported['snapshot_id'])
    assert switched['active_snapshot'] == imported['snapshot_id']
    prefs = service.save_preferences({'limits': {'maxTurns': 20}})
    assert prefs['ok'] is True and prefs['limits']['maxTurns'] == 20
    rejected = service.save_preferences({'limits': {'maxTurns': 39}})
    assert rejected['ok'] is False and rejected['error']['code'] == 'PREFERENCES_NOT_STRICTER'
    assert service._data['preferences']['limits']['maxTurns'] == 20
    deleted = service.delete_package('demo.expert')
    assert deleted['ok'] is True and service.list()['packages'] == []
    assert service.read_resource(imported['snapshot_id'], 'skills/demo/references/guide.md')['ok'] is True


def test_three_metadata_paths_and_identical_warning(tmp_path):
    for index, relative in enumerate(('.codebuddy-plugin/plugin.json', '.workbuddy-plugin/plugin.json', 'plugin.json')):
        service = make_service(tmp_path / str(index))
        source = make_agent_package(tmp_path / str(index) / 'source', relative, f'demo{index}.expert')
        assert service.import_directory(str(source))['ok'] is True
    source = make_agent_package(tmp_path / 'same')
    write(source, 'plugin.json', (source / '.codebuddy-plugin/plugin.json').read_text(encoding='utf-8'))
    service = make_service(tmp_path / 'same-service')
    imported = service.import_directory(str(source))
    assert imported['ok'] is True and 'MULTIPLE_METADATA_IDENTICAL' in imported['warnings']


def test_metadata_conflict_and_duplicate_keys_are_precise(tmp_path):
    source = make_agent_package(tmp_path / 'conflict')
    write(source, 'plugin.json', dump(agent_metadata(package_id='other.expert')))
    service = make_service(tmp_path / 'conflict-service')
    result = service.import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'METADATA_CONFLICT'
    assert any(item['field'] == 'name' for item in result['error']['details'])
    source = make_agent_package(tmp_path / 'duplicate')
    write(source, '.codebuddy-plugin/plugin.json', '{"name":"demo.expert","name":"other.expert"}')
    result = make_service(tmp_path / 'duplicate-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'DUPLICATE_KEY'
    source = make_agent_package(tmp_path / 'duplicate-fm')
    write(source, 'agents/researcher.md', '---\nname: researcher\nname: other\n---\nbody')
    result = make_service(tmp_path / 'duplicate-fm-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'DUPLICATE_KEY'
    assert result['error']['line'] == 3


def test_frontmatter_supported_scalars_and_invalid_nested(tmp_path):
    source = make_agent_package(tmp_path / 'supported')
    write(source, 'agents/researcher.md', '''---
name: researcher
description: 'It''s safe'
displayName: {zh: 研究员, en: Researcher}
profession:
  zh: 研究员
  en: Researcher
maxTurns: 8
---
# Researcher
''')
    assert make_service(tmp_path / 'supported-service').import_directory(str(source))['ok'] is True
    source = make_agent_package(tmp_path / 'nested')
    write(source, 'agents/researcher.md', '---\nname: researcher\ndescription: ok\nprofession:\n    zh: bad\n---\nbody')
    result = make_service(tmp_path / 'nested-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] in {'INVALID_INDENT', 'INVALID_MAP'}


def test_team_references_and_settings_are_validated(tmp_path):
    source = make_team_package(tmp_path / 'team')
    service = make_service(tmp_path / 'team-service')
    imported = service.import_directory(str(source))
    assert imported['ok'] is True
    detail = service.get('team.expert')
    assert detail['package']['team']['leadAgent'] == 'orchestrator'
    source = make_team_package(tmp_path / 'bad-team')
    metadata = agent_metadata('team.expert', 'team', 'orchestrator')
    metadata['teamInfo']['memberAgents'] = ['missing']
    write(source, '.workbuddy-plugin/plugin.json', dump(metadata))
    result = make_service(tmp_path / 'bad-team-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'MEMBER_NOT_FOUND'


def test_registry_corruption_unknown_schema_and_write_rollback(tmp_path, monkeypatch):
    registry = tmp_path / 'experts.json'
    registry.write_text('{bad', encoding='utf-8')
    service = ExpertPackageService(registry_path=str(registry), root=str(tmp_path / 'managed'))
    assert service.list()['registry_warning'] == 'REGISTRY_CORRUPT_RECOVERED'
    assert list(tmp_path.glob('experts.json.bad-*'))
    registry.write_text('{"schema_version":99,"packages":{}}', encoding='utf-8')
    original = registry.read_bytes()
    service = ExpertPackageService(registry_path=str(registry), root=str(tmp_path / 'managed2'))
    assert service.list()['registry_warning'] == 'REGISTRY_SCHEMA_UNSUPPORTED'
    assert service.save_preferences({'limits': {'maxTurns': 20}})['error']['code'] == 'REGISTRY_SCHEMA_UNSUPPORTED'
    assert registry.read_bytes() == original
    service = make_service(tmp_path / 'rollback')
    source = make_agent_package(tmp_path / 'rollback-source')
    assert service.import_directory(str(source))['ok'] is True
    before = (tmp_path / 'rollback' / 'experts.json').read_bytes()
    monkeypatch.setattr('backend.domains.expert.service.atomic_write_json', lambda *args, **kwargs: (_ for _ in ()).throw(OSError('disk full')))
    result = service.save_preferences({'limits': {'maxTurns': 20}})
    assert result['error']['code'] == 'REGISTRY_WRITE_FAILED'
    assert (tmp_path / 'rollback' / 'experts.json').read_bytes() == before


def test_same_digest_idempotent_and_new_snapshot_inactive(tmp_path):
    source = make_agent_package(tmp_path / 'source')
    service = make_service(tmp_path)
    first = service.import_directory(str(source))
    second = service.import_directory(str(source))
    assert first['snapshot_id'] == second['snapshot_id']
    assert len(service._data['packages']['demo.expert']['snapshots']) == 1
    service.set_enabled('demo.expert', True)
    write(source, 'agents/researcher.md', (source / 'agents/researcher.md').read_text(encoding='utf-8') + '\nNew revision.\n')
    third = service.import_directory(str(source))
    assert third['snapshot_id'] != first['snapshot_id']
    record = service._data['packages']['demo.expert']
    assert record['active_snapshot'] == first['snapshot_id'] and third['activated'] is False
