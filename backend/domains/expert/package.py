# -*- coding: utf-8 -*-
"""Managed snapshot staging, digest verification and per-read TOCTOU checks."""
import os
import stat
import uuid

from ... import paths
from ...fio import atomic_write_json
from .jsonio import canonical_json, read_limited, sha256_bytes, strict_json_bytes
from .model import DIGEST_RE, ID_RE, failure
from .validator import safe_declared_path, scan_package, _secure_lstat

MANIFEST_NAME = '.harbor-snapshot.json'


def digest_records(records):
    import hashlib
    digest = hashlib.sha256()
    for relative in sorted(records):
        digest.update(relative.encode('utf-8'))
        digest.update(b'\0')
        digest.update(records[relative]['data'])
    return digest.hexdigest()


class SnapshotStore:
    def __init__(self, root=None):
        self.root = os.path.abspath(root or paths.EXPERTS_DIR)
        self.snapshots = os.path.join(self.root, 'snapshots')
        self.staging = os.path.join(self.root, 'staging')

    def _manifest_path(self, snapshot_dir):
        return os.path.join(snapshot_dir, MANIFEST_NAME)

    def load_manifest(self, snapshot_dir):
        path = self._manifest_path(snapshot_dir)
        _secure_lstat(path)
        data = read_limited(path, 64 * 1024, MANIFEST_NAME)
        manifest = strict_json_bytes(data, MANIFEST_NAME)
        if not isinstance(manifest, dict) or manifest.get('schema_version') != 1:
            failure('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest 非法', path=path)
        return manifest

    def _write_bytes(self, path, data):
        parent = os.path.dirname(path)
        os.makedirs(parent, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise

    def stage(self, manifest, records):
        """Copy validated in-memory records to a same-volume atomic snapshot."""
        digest = digest_records(records)
        snapshot_id = digest
        package_id = manifest['package_id']
        final = os.path.join(self.snapshots, package_id, snapshot_id)
        staging = os.path.join(self.staging, uuid.uuid4().hex)
        try:
            os.makedirs(staging, exist_ok=False)
            for relative in sorted(records):
                target = os.path.join(staging, *relative.split('/'))
                self._write_bytes(target, records[relative]['data'])
            staged_scan = scan_package(staging, manifest['limits'])
            if digest_records(staged_scan['records']) != digest:
                failure('DIGEST_MISMATCH', 'staging 重算 digest 不一致')
            stored = dict(manifest)
            stored['snapshot_id'] = snapshot_id
            stored['files'] = [
                {'path': relative, 'size': records[relative]['size'], 'sha256': records[relative]['sha256']}
                for relative in sorted(records)
            ]
            if len(canonical_json(stored).encode('utf-8')) > 64 * 1024:
                failure('INDEX_TOO_LARGE', 'snapshot 索引超过 64KiB')
            atomic_write_json(self._manifest_path(staging), stored, indent=2)
            if os.path.exists(final):
                self.verify_snapshot(final, stored)
                self._remove_tree(staging)
                return {'snapshot_id': snapshot_id, 'snapshot_dir': final, 'reused': True, 'manifest': stored}
            os.makedirs(os.path.dirname(final), exist_ok=True)
            try:
                os.replace(staging, final)
            except FileExistsError:
                self.verify_snapshot(final, stored)
                self._remove_tree(staging)
                return {'snapshot_id': snapshot_id, 'snapshot_dir': final, 'reused': True, 'manifest': stored}
            return {'snapshot_id': snapshot_id, 'snapshot_dir': final, 'reused': False, 'manifest': stored}
        except Exception:
            self._remove_tree(staging)
            raise

    def _remove_tree(self, path):
        if not os.path.isdir(path):
            return
        for directory, dirs, files in os.walk(path, topdown=False):
            for name in files:
                try:
                    os.remove(os.path.join(directory, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(directory, name))
                except OSError:
                    pass
        try:
            os.rmdir(path)
        except OSError:
            pass

    def verify_snapshot(self, snapshot_dir, manifest=None):
        manifest = manifest or self.load_manifest(snapshot_dir)
        scanned = scan_package(snapshot_dir)
        actual = dict(scanned['records'])
        actual.pop(MANIFEST_NAME, None)
        expected = {item['path']: item for item in manifest['files']}
        if set(actual) != set(expected):
            failure('SNAPSHOT_CONTENT_MISMATCH', 'snapshot 文件集合与 manifest 不一致')
        for relative, item in expected.items():
            if actual[relative]['sha256'] != item['sha256'] or actual[relative]['size'] != item['size']:
                failure('SNAPSHOT_CONTENT_MISMATCH', 'snapshot 文件 hash 与 manifest 不一致', path=relative)
        if digest_records(actual) != manifest['snapshot_id']:
            failure('DIGEST_MISMATCH', 'snapshot digest 与 manifest 不一致')
        return True

    def snapshot_path(self, package_id, snapshot_id):
        if not ID_RE.match(str(package_id)) or not DIGEST_RE.match(str(snapshot_id)):
            failure('INVALID_SNAPSHOT_ID', 'package/snapshot ID 非法')
        path = os.path.join(self.snapshots, package_id, snapshot_id)
        info = _secure_lstat(path)
        if not stat.S_ISDIR(info.st_mode):
            failure('SNAPSHOT_NOT_FOUND', 'snapshot 不存在')
        return path

    def find_snapshot(self, snapshot_id):
        if not DIGEST_RE.match(str(snapshot_id)):
            failure('INVALID_SNAPSHOT_ID', 'snapshot ID 非法')
        if not os.path.isdir(self.snapshots):
            failure('SNAPSHOT_NOT_FOUND', 'snapshot 不存在')
        for package_id in sorted(os.listdir(self.snapshots)):
            candidate = os.path.join(self.snapshots, package_id, snapshot_id)
            if not os.path.lexists(candidate):
                continue
            info = _secure_lstat(candidate)
            if stat.S_ISDIR(info.st_mode):
                manifest = self.load_manifest(candidate)
                if manifest.get('snapshot_id') == snapshot_id:
                    return candidate, manifest
        failure('SNAPSHOT_NOT_FOUND', 'snapshot 不存在')

    def read_resource(self, snapshot_dir, manifest, relative, limit):
        relative = safe_declared_path(relative, 'path', 'snapshot')
        if relative not in manifest.get('readable_paths', []):
            failure('RESOURCE_NOT_READABLE', '资源不在只读白名单', path=relative)
        expected = next((item for item in manifest['files'] if item['path'] == relative), None)
        if not expected:
            failure('RESOURCE_NOT_READABLE', '资源没有登记 hash', path=relative)
        root = os.path.normcase(os.path.realpath(snapshot_dir))
        raw_path = os.path.join(root, *relative.split('/'))
        current = raw_path
        while True:
            _secure_lstat(current)
            if os.path.normcase(current) == root:
                break
            current = os.path.dirname(current)
        path = os.path.normcase(os.path.realpath(raw_path))
        try:
            if os.path.commonpath((root, path)) != root:
                failure('PATH_ESCAPE', '资源路径逃逸 snapshot', path=relative)
        except ValueError:
            failure('PATH_ESCAPE', '资源路径逃逸 snapshot', path=relative)
        before_info = _secure_lstat(path)
        if not stat.S_ISREG(before_info.st_mode) or before_info.st_nlink > 1:
            failure('NOT_REGULAR_FILE', '资源必须是普通非硬链接文件', path=relative)
        if before_info.st_size > limit:
            failure('RESOURCE_TOO_LARGE', '资源超过读取上限', path=relative)
        before = (before_info.st_dev, before_info.st_ino, before_info.st_size, before_info.st_mtime_ns)
        data = read_limited(path, limit, relative)
        after_info = _secure_lstat(path)
        after = (after_info.st_dev, after_info.st_ino, after_info.st_size, after_info.st_mtime_ns)
        if before != after:
            failure('TOCTOU_CHANGED', '资源读取期间 identity 发生变化', path=relative)
        digest = sha256_bytes(data)
        if digest != expected['sha256']:
            failure('RESOURCE_HASH_MISMATCH', '资源 hash 与 snapshot manifest 不一致', path=relative)
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            failure('INVALID_UTF8', '资源必须是 UTF-8 文本', path=relative)
        return {'path': relative, 'sha256': digest, 'text': text, 'truncated': False}
