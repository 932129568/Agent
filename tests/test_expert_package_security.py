# -*- coding: utf-8 -*-
"""W5A adversarial filesystem, TOCTOU, limits and no-execution tests."""
import json
import os
import stat
from pathlib import Path

import pytest

from backend.domains.expert import validator
from backend.domains.expert.service import ExpertPackageService
from test_expert_package_service import make_agent_package, make_service, write


def test_escape_and_secret_files_rejected_before_registry(tmp_path):
    source = make_agent_package(tmp_path / 'escape')
    metadata = json.loads((source / '.codebuddy-plugin/plugin.json').read_text(encoding='utf-8'))
    metadata['agents'] = ['../outside.md']
    write(source, '.codebuddy-plugin/plugin.json', json.dumps(metadata))
    service = make_service(tmp_path / 'escape-service')
    result = service.import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'PATH_ESCAPE'
    assert not (tmp_path / 'escape-service' / 'experts.json').exists()
    source = make_agent_package(tmp_path / 'secret')
    write(source, '.env', 'API_KEY=do-not-read')
    result = make_service(tmp_path / 'secret-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'SECRET_FILE_NOT_ALLOWED'


def test_symlink_and_hardlink_rejected(tmp_path):
    source = make_agent_package(tmp_path / 'link')
    target = source / 'agents/researcher.md'
    original = target.read_bytes()
    target.unlink()
    outside = tmp_path / 'outside.md'
    outside.write_bytes(original)
    try:
        target.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip('symlink privilege unavailable')
    result = make_service(tmp_path / 'link-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] in {'LINK_NOT_ALLOWED', 'PATH_ESCAPE'}
    source = make_agent_package(tmp_path / 'hardlink')
    try:
        os.link(source / 'agents/researcher.md', source / 'agents/other.md')
    except OSError:
        pytest.skip('hardlink unavailable')
    result = make_service(tmp_path / 'hardlink-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'HARDLINK_NOT_ALLOWED'


def test_casefold_collision_rejected_on_case_sensitive_fs(tmp_path):
    if os.name == 'nt':
        pytest.skip('case-sensitive duplicate fixture requires a case-sensitive filesystem')
    source = make_agent_package(tmp_path / 'casefold')
    write(source, 'skills/demo/references/Guide.md', 'one')
    write(source, 'skills/demo/references/guide.md', 'two')
    result = make_service(tmp_path / 'casefold-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'CASEFOLD_COLLISION'


def test_reparse_attribute_rejected_on_windows(tmp_path, monkeypatch):
    if not hasattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT'):
        pytest.skip('Windows reparse metadata unavailable on this platform')
    source = make_agent_package(tmp_path / 'reparse')
    original = validator.os.lstat

    def wrapped(path):
        info = original(path)
        if Path(path).name == 'researcher.md':
            class ReparseInfo:
                st_mode = info.st_mode
                st_nlink = info.st_nlink
                st_file_attributes = stat.FILE_ATTRIBUTE_REPARSE_POINT
                st_size = info.st_size
                st_dev = info.st_dev
                st_ino = info.st_ino
                st_mtime_ns = info.st_mtime_ns
            return ReparseInfo()
        return info

    monkeypatch.setattr(validator.os, 'lstat', wrapped)
    result = make_service(tmp_path / 'reparse-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'REPARSE_NOT_ALLOWED'


def test_snapshot_replacement_and_link_recheck_on_every_read(tmp_path):
    source = make_agent_package(tmp_path / 'source')
    service = make_service(tmp_path)
    imported = service.import_directory(str(source))
    resource = tmp_path / 'managed' / 'snapshots' / 'demo.expert' / imported['snapshot_id'] / 'skills/demo/references/guide.md'
    resource.write_text('tampered', encoding='utf-8')
    result = service.read_resource(imported['snapshot_id'], 'skills/demo/references/guide.md')
    assert result['ok'] is False and result['error']['code'] in {'RESOURCE_HASH_MISMATCH', 'SNAPSHOT_CONTENT_MISMATCH'}
    resource.unlink()
    outside = tmp_path / 'outside.md'
    outside.write_text('outside', encoding='utf-8')
    try:
        resource.symlink_to(outside)
    except (OSError, NotImplementedError):
        return
    result = service.read_resource(imported['snapshot_id'], 'skills/demo/references/guide.md')
    assert result['ok'] is False and result['error']['code'] in {'LINK_NOT_ALLOWED', 'PATH_ESCAPE'}


def test_size_file_count_and_metadata_limits_stop_early(tmp_path):
    source = make_agent_package(tmp_path / 'large-file')
    write(source, 'skills/demo/references/guide.md', b'x' * (1024 * 1024 + 1))
    result = make_service(tmp_path / 'large-file-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'FILE_TOO_LARGE'
    source = make_agent_package(tmp_path / 'large-meta')
    metadata = json.loads((source / '.codebuddy-plugin/plugin.json').read_text(encoding='utf-8'))
    metadata['description'] = 'x' * (64 * 1024 + 1)
    write(source, '.codebuddy-plugin/plugin.json', json.dumps(metadata))
    result = make_service(tmp_path / 'large-meta-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'METADATA_TOO_LARGE'
    source = make_agent_package(tmp_path / 'many-files')
    for index in range(513):
        write(source, f'junk-{index}.txt', 'x')
    result = make_service(tmp_path / 'many-files-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] == 'TOO_MANY_FILES'


def test_scripts_network_process_and_dynamic_import_spies_stay_zero(tmp_path, monkeypatch):
    calls = []

    def forbidden(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError('untrusted code executed')

    monkeypatch.setattr('subprocess.Popen', forbidden)
    monkeypatch.setattr('subprocess.run', forbidden)
    monkeypatch.setattr('socket.socket', forbidden)
    monkeypatch.setattr('importlib.import_module', forbidden)
    source = make_agent_package(tmp_path / 'source')
    service = make_service(tmp_path)
    imported = service.import_directory(str(source))
    assert imported['ok'] is True
    assert service.get('demo.expert')['ok'] is True
    assert service.read_resource(imported['snapshot_id'], 'skills/demo/scripts/do_not_run.py')['ok'] is False
    assert calls == []


def test_resource_whitelist_and_unclosed_frontmatter(tmp_path):
    source = make_agent_package(tmp_path / 'source')
    service = make_service(tmp_path)
    imported = service.import_directory(str(source))
    for path in ('../secret', '/etc/passwd', 'skills/demo/scripts/do_not_run.py', 'skills/demo/references/missing.md'):
        result = service.read_resource(imported['snapshot_id'], path)
        assert result['ok'] is False and 'text' not in result['error']
    source = make_agent_package(tmp_path / 'unclosed')
    write(source, 'agents/researcher.md', '---\nname: researcher\ndescription: |\n  unclosed')
    result = make_service(tmp_path / 'unclosed-service').import_directory(str(source))
    assert result['ok'] is False and result['error']['code'] in {'UNCLOSED_BLOCK', 'UNCLOSED_FRONTMATTER'}
