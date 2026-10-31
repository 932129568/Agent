# -*- coding: utf-8 -*-
"""W5A expert registry and seven package-only service operations."""
import copy
import datetime
import os
import threading

from ... import paths
from ...fio import atomic_write_json
from .jsonio import read_limited, strict_json_bytes
from .model import DEFAULT_LIMITS, LIMIT_RANGES, ExpertError, error_response, failure
from .package import SnapshotStore
from .validator import scan_package, validate_package


def _utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def _empty_registry():
    return {'schema_version': 1, 'packages': {},
            'preferences': {'limits': dict(DEFAULT_LIMITS)}}


class ExpertPackageService:
    def __init__(self, registry_path=None, root=None):
        self._path = os.path.abspath(registry_path or paths.EXPERTS_FILE)
        self._lock = threading.RLock()
        self._store = SnapshotStore(root)
        self._warning = None
        self._read_only = False
        self._data = self._load_registry()

    def _load_registry(self):
        try:
            data = strict_json_bytes(read_limited(self._path, 4 * 1024 * 1024, 'experts.json'),
                                     'experts.json')
            if not isinstance(data, dict) or data.get('schema_version') != 1:
                self._warning = 'REGISTRY_SCHEMA_UNSUPPORTED'
                self._read_only = True
                return _empty_registry()
            if not isinstance(data.get('packages'), dict):
                raise ValueError('packages_not_object')
            data.setdefault('preferences', {'limits': dict(DEFAULT_LIMITS)})
            data['preferences'].setdefault('limits', dict(DEFAULT_LIMITS))
            return data
        except FileNotFoundError:
            return _empty_registry()
        except Exception:
            self._warning = 'REGISTRY_CORRUPT_RECOVERED'
            self._backup_bad()
            return _empty_registry()

    def _backup_bad(self):
        if not os.path.exists(self._path):
            return
        suffix = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
        try:
            os.replace(self._path, self._path + '.bad-' + suffix)
        except OSError:
            pass

    def _commit(self, candidate):
        if self._read_only:
            return {'ok': False, 'error': {'code': 'REGISTRY_SCHEMA_UNSUPPORTED',
                                          'message': 'registry schema 不受支持，未覆盖原文件'}}
        try:
            atomic_write_json(self._path, candidate, indent=2)
            self._data = candidate
            return None
        except Exception:
            return {'ok': False, 'error': {'code': 'REGISTRY_WRITE_FAILED',
                                          'message': 'registry 保存失败，原值未改变'}}

    def list(self, query=''):
        try:
            query = str(query or '').casefold()
            with self._lock:
                packages = []
                for package_id, record in sorted(self._data['packages'].items()):
                    snapshots = record.get('snapshots', [])
                    if not snapshots:
                        continue
                    active = next((item for item in snapshots
                                   if item['digest'] == record.get('active_snapshot')), snapshots[-1])
                    if query and query not in package_id.casefold() and query not in str(active.get('name', '')).casefold():
                        continue
                    packages.append({
                        'id': package_id, 'kind': active.get('kind', 'agent'),
                        'name': active.get('name', package_id), 'version': active['version'],
                        'enabled': bool(record.get('enabled')), 'valid': active.get('valid', True),
                        'active_snapshot': record.get('active_snapshot', ''),
                        'source': copy.deepcopy(active.get('source', {})),
                        'warnings': list(active.get('warnings', [])),
                    })
                result = {'ok': True, 'packages': packages}
                if self._warning:
                    result['registry_warning'] = self._warning
                return result
        except Exception as error:
            return error_response(error)

    def _snapshot_record(self, package_id, snapshot_id=''):
        with self._lock:
            record = self._data['packages'].get(package_id)
            if not record or not record.get('snapshots'):
                failure('PACKAGE_NOT_FOUND', '专家包不存在')
            snapshots = record['snapshots']
            if snapshot_id:
                selected = next((item for item in snapshots if item['digest'] == snapshot_id), None)
                if not selected:
                    failure('SNAPSHOT_NOT_FOUND', '指定 snapshot 未注册')
            else:
                selected = next((item for item in snapshots
                                 if item['digest'] == record.get('active_snapshot')), snapshots[-1])
            return copy.deepcopy(selected)

    def get(self, package_id, snapshot_id=''):
        try:
            selected = self._snapshot_record(package_id, snapshot_id)
            directory = self._store.snapshot_path(package_id, selected['digest'])
            self._store.verify_snapshot(directory)
            manifest = self._store.load_manifest(directory)
            return {'ok': True, 'package': {
                'id': package_id, 'snapshot_id': selected['digest'],
                'kind': manifest['kind'], 'version': manifest['version'],
                'metadata': manifest['metadata'], 'agents': manifest['agents'],
                'team': manifest['team'], 'skills': manifest['skills'],
                'resources': manifest['resources'], 'scripts': manifest.get('scripts', []),
                'limits': manifest['limits'], 'validation': manifest['validation'],
            }}
        except Exception as error:
            return error_response(error)

    def import_directory(self, path, source_kind='directory'):
        try:
            if source_kind not in ('directory', 'builtin'):
                failure('INVALID_IMPORT_SOURCE', '导入来源只允许 directory/builtin')
            scanned = scan_package(path)
            manifest = validate_package(scanned)
            staged = self._store.stage(manifest, scanned['records'])
            snapshot_id = staged['snapshot_id']
            with self._lock:
                candidate = copy.deepcopy(self._data)
                record = candidate['packages'].setdefault(manifest['package_id'], {
                    'enabled': False, 'active_snapshot': '', 'snapshots': [],
                })
                if not any(item['digest'] == snapshot_id for item in record['snapshots']):
                    record['snapshots'].append({
                        'digest': snapshot_id, 'version': manifest['version'],
                        'kind': manifest['kind'], 'name': manifest['package_id'],
                        'registered_at': _utc_now(),
                        'source': {'kind': source_kind,
                                   'name': manifest['package_id'] if source_kind == 'builtin'
                                   else os.path.basename(scanned['root'])},
                        'warnings': manifest['validation']['warnings'], 'valid': True,
                    })
                error = self._commit(candidate)
                if error:
                    return error
            return {'ok': True, 'package_id': manifest['package_id'], 'snapshot_id': snapshot_id,
                    'version': manifest['version'], 'activated': False,
                    'warnings': manifest['validation']['warnings']}
        except Exception as error:
            return error_response(error)

    def read_resource(self, snapshot_id, path):
        try:
            directory, manifest = self._store.find_snapshot(snapshot_id)
            self._store.verify_snapshot(directory, manifest)
            result = self._store.read_resource(directory, manifest, path,
                                               manifest['limits']['maxResourceBytes'])
            result['provenance'] = {
                'packageId': manifest['package_id'], 'snapshotId': snapshot_id,
                'path': result['path'], 'sha256': result['sha256'],
                'source': {'kind': 'managed_snapshot'},
            }
            result['ok'] = True
            return result
        except Exception as error:
            return error_response(error)

    def save_preferences(self, prefs_json):
        try:
            if isinstance(prefs_json, str):
                prefs = strict_json_bytes(prefs_json.encode('utf-8'), 'preferences')
            else:
                prefs = prefs_json
            if not isinstance(prefs, dict):
                failure('INVALID_PREFERENCES', '偏好必须是 JSON 对象')
            incoming = prefs.get('limits', prefs)
            if not isinstance(incoming, dict):
                failure('INVALID_PREFERENCES', 'limits 必须是对象')
            with self._lock:
                current = self._data['preferences']['limits']
                updated = dict(current)
                for key, value in incoming.items():
                    if key not in LIMIT_RANGES:
                        failure('INVALID_PREFERENCES', '未知 limits 字段', field=key)
                    minimum, maximum = LIMIT_RANGES[key]
                    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
                        failure('INVALID_PREFERENCES', 'limits 超出允许范围', field=key,
                                details={'min': minimum, 'max': maximum})
                    if value > current.get(key, maximum):
                        failure('PREFERENCES_NOT_STRICTER', '偏好只能更严格，不能放大限额', field=key)
                    updated[key] = value
                candidate = copy.deepcopy(self._data)
                candidate['preferences']['limits'] = updated
                error = self._commit(candidate)
                if error:
                    return error
                return {'ok': True, 'limits': copy.deepcopy(updated)}
        except Exception as error:
            return error_response(error)

    def set_enabled(self, package_id, enabled, snapshot_id=''):
        try:
            if not isinstance(enabled, bool):
                failure('INVALID_ENABLED', 'enabled 必须是 boolean')
            with self._lock:
                record = self._data['packages'].get(package_id)
                if not record or not record.get('snapshots'):
                    failure('PACKAGE_NOT_FOUND', '专家包不存在')
                snapshots = record['snapshots']
                active = record.get('active_snapshot', '')
                if snapshot_id and not any(item['digest'] == snapshot_id for item in snapshots):
                    failure('SNAPSHOT_NOT_FOUND', '指定 snapshot 未注册')
                candidate = copy.deepcopy(self._data)
                target = candidate['packages'][package_id]
                if enabled:
                    target['enabled'] = True
                    target['active_snapshot'] = snapshot_id or active or snapshots[-1]['digest']
                else:
                    target['enabled'] = False
                error = self._commit(candidate)
                if error:
                    return error
                return {'ok': True, 'package_id': package_id, 'enabled': enabled,
                        'active_snapshot': target.get('active_snapshot', active)}
        except Exception as error:
            return error_response(error)

    def delete_package(self, package_id):
        try:
            with self._lock:
                if package_id not in self._data['packages']:
                    failure('PACKAGE_NOT_FOUND', '专家包不存在')
                candidate = copy.deepcopy(self._data)
                del candidate['packages'][package_id]
                error = self._commit(candidate)
                if error:
                    return error
                return {'ok': True, 'package_id': package_id, 'deleted': True}
        except Exception as error:
            return error_response(error)
