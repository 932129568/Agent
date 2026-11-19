# -*- coding: utf-8 -*-
"""Hash-guarded, manifest-scoped Wave snapshots and rollback (stdlib only).

Only explicit source files under the project root are managed. Build artifacts and
unknown working-tree changes are never read as recovery sources or restored.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
BACKUP_ROOT = ROOT / 'deliverables' / 'wave-backups'
FORBIDDEN_PARTS = {'dist', 'build', 'node_modules', '.git'}


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _git(root, *args):
    result = subprocess.run(
        ['git', '-C', str(root), *args], check=True,
        capture_output=True, text=True, encoding='utf-8', errors='replace')
    return result.stdout.strip()


def _manifest(root, manifest):
    manifest_path = Path(manifest)
    if not manifest_path.is_absolute():
        manifest_path = root / manifest_path
    rows = []
    for raw in manifest_path.read_text(encoding='utf-8').splitlines():
        value = raw.strip()
        if not value or value.startswith('#'):
            continue
        relative = Path(value.replace('\\', '/'))
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('manifest 仅接受项目内相对路径: %s' % value)
        if any(part.lower() in FORBIDDEN_PARTS for part in relative.parts):
            raise ValueError('禁止管理构建/依赖产物: %s' % value)
        if relative.suffix.lower() in {'.exe', '.dll', '.msi', '.zip'}:
            raise ValueError('禁止管理二进制发布产物: %s' % value)
        normalized = relative.as_posix()
        if normalized not in rows:
            rows.append(normalized)
    if not rows:
        raise ValueError('manifest 为空')
    return rows


def _paths(root, rows):
    return {row: (root / Path(row)).resolve() for row in rows}


def _assert_within_root(root, paths):
    resolved_root = root.resolve()
    for row, path in paths.items():
        if path != resolved_root and resolved_root not in path.parents:
            raise ValueError('路径逃逸项目根目录: %s' % row)


def _metadata_dir(backup_root, wave):
    if not wave or not wave.replace('-', '').replace('_', '').isalnum():
        raise ValueError('wave 仅允许字母、数字、下划线和连字符')
    return backup_root / wave


def snapshot(wave, files, root=ROOT, backup_root=BACKUP_ROOT):
    """Copy manifest preimages and record hashes; existing Waves are immutable."""
    root = Path(root).resolve()
    backup_root = Path(backup_root).resolve()
    rows = _manifest(root, files)
    paths = _paths(root, rows)
    _assert_within_root(root, paths)
    target = _metadata_dir(backup_root, wave)
    if target.exists():
        raise FileExistsError('Wave 已存在，拒绝覆盖: %s' % wave)
    files_dir = target / 'files'
    files_dir.mkdir(parents=True)
    try:
        records = {}
        for row, source in paths.items():
            existed = source.exists()
            if existed and not source.is_file():
                raise ValueError('仅支持普通文件: %s' % row)
            destination = files_dir / Path(row)
            record = {'existed': existed, 'pre_sha256': None, 'post_sha256': None}
            if existed:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                record['pre_sha256'] = _sha256(source)
            records[row] = record
        metadata = {
            'schema_version': 1, 'wave': wave, 'status': 'snapshotted',
            'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'head': _git(root, 'rev-parse', 'HEAD'),
            'git_status': _git(root, 'status', '--short'),
            'files': records, 'evidence': {},
        }
        (target / 'manifest.json').write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        return metadata
    except Exception:
        # 仅清理本调用新建且尚未登记的 Wave，失败后可安全重试。
        shutil.rmtree(target, ignore_errors=True)
        raise


def _load(root, backup_root, wave):
    target = _metadata_dir(Path(backup_root), wave)
    metadata = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
    paths = _paths(Path(root), list(metadata['files']))
    _assert_within_root(Path(root), paths)
    return target, metadata, paths


def verify(wave, files=None, root=ROOT, backup_root=BACKUP_ROOT):
    """Verify a completed Wave still exactly matches its approved post-hashes."""
    _target, metadata, paths = _load(root, backup_root, wave)
    if metadata['status'] != 'completed':
        raise ValueError('Wave 尚未记录 post-hash，不能验证/回滚')
    mismatches = []
    for row, path in paths.items():
        expected = metadata['files'][row]['post_sha256']
        actual = _sha256(path) if path.is_file() else None
        if actual != expected:
            mismatches.append(row)
    return {'ok': not mismatches, 'wave': wave, 'mismatches': mismatches}


def complete(wave, tests='', performance='', root=ROOT, backup_root=BACKUP_ROOT,
             allow_missing=()):
    """Approve current contents, including explicitly recorded migration deletions."""
    target, metadata, paths = _load(root, backup_root, wave)
    if metadata['status'] != 'snapshotted':
        raise ValueError('仅 snapshotted Wave 可记录 post-hash')
    allowed_missing = set(allow_missing)
    for row, path in paths.items():
        if path.is_file():
            metadata['files'][row]['post_sha256'] = _sha256(path)
        elif metadata['files'][row]['existed'] or row in allowed_missing:
            metadata['files'][row]['post_sha256'] = None
        else:
            raise FileNotFoundError('完成 Wave 时预期新文件缺失: %s' % row)
    metadata['status'] = 'completed'
    metadata['completed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    metadata['evidence'] = {'tests': tests, 'performance': performance}
    (target / 'manifest.json').write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    return metadata


def rollback(wave, root=ROOT, backup_root=BACKUP_ROOT):
    """Restore only the latest completed Wave and only when post-hashes match."""
    root = Path(root).resolve()
    backup_root = Path(backup_root).resolve()
    completed = []
    if backup_root.exists():
        for child in backup_root.iterdir():
            manifest = child / 'manifest.json'
            if manifest.is_file():
                data = json.loads(manifest.read_text(encoding='utf-8'))
                if data.get('status') == 'completed':
                    completed.append((data.get('completed_at', ''), data['wave']))
    if not completed or max(completed)[1] != wave:
        raise ValueError('只允许按相反顺序回滚最新已完成 Wave')
    checked = verify(wave, root=root, backup_root=backup_root)
    if not checked['ok']:
        raise RuntimeError('后续修改导致拒绝恢复: %s' % ', '.join(checked['mismatches']))
    target, metadata, paths = _load(root, backup_root, wave)
    restored = []
    for row, path in paths.items():
        record = metadata['files'][row]
        if record['existed']:
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(target / 'files' / Path(row), path)
        elif path.exists():
            path.unlink()
        restored.append(row)
    metadata['status'] = 'rolled_back'
    metadata['rolled_back_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (target / 'manifest.json').write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'ok': True, 'wave': wave, 'restored': restored}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='command', required=True)
    for name in ('snapshot', 'complete'):
        command = subparsers.add_parser(name)
        command.add_argument('wave')
        command.add_argument('--files', required=True, help='UTF-8 manifest, one relative path per line')
        if name == 'complete':
            command.add_argument('--tests', default='')
            command.add_argument('--performance', default='')
            command.add_argument('--allow-missing', action='append', default=[],
                                 help='expected-new path intentionally removed during migration')
    for name in ('verify', 'rollback'):
        command = subparsers.add_parser(name)
        command.add_argument('wave')
        command.add_argument('--files', required=False, help='accepted for CLI symmetry; stored manifest is authoritative')
    args = parser.parse_args()
    if args.command == 'snapshot':
        result = snapshot(args.wave, args.files)
    elif args.command == 'complete':
        result = complete(args.wave, tests=args.tests, performance=args.performance,
                          allow_missing=args.allow_missing)
    elif args.command == 'verify':
        result = verify(args.wave, args.files)
    else:
        result = rollback(args.wave)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
