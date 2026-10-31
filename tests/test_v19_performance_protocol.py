# -*- coding: utf-8 -*-
"""Performance protocol and manifest-scoped WaveGuard regression tests."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools import perf_benchmark
from tools import wave_guard


class TestPerformanceProtocol:
    def test_core_samples_schema_and_isolated_io(self):
        report = perf_benchmark.core_backend_benchmark(3, 200)
        assert set(report['metrics']) == {'history_dir_get', 'list_dir'}
        for metric in report['metrics'].values():
            assert len(metric['samples']) == 3
            assert metric['median'] > 0
            assert metric['min'] <= metric['median'] <= metric['max']
        assert report['correctness']['history_open_counts']
        assert all(count >= 1 for count in report['correctness']['history_open_counts'])
        assert report['dataset']['history_config_dir'] == 'temporary'

    def test_frontend_samples_and_no_dom_disclosure(self):
        report = perf_benchmark.frontend_benchmark(3)
        assert report['scope'] == 'frontend-node-vm'
        assert len(report['metrics']['session_search_miss']['samples']) == 3
        assert len(report['metrics']['stream_schedule_coalesced']['samples']) == 3
        assert report['correctness']['stream_frames_last_run'] == \
            report['correctness']['expected_stream_frames']
        assert any('not WebView2' in row for row in report['limitations'])

    def test_no_exe_or_product_process_launch(self):
        source = (perf_benchmark.ROOT / 'tools' / 'perf_benchmark.py').read_text(encoding='utf-8')
        frontend = (perf_benchmark.ROOT / 'tools' / 'perf_frontend_benchmark.js').read_text(encoding='utf-8')
        assert 'Popen' not in source
        assert 'dist/Harbor.exe' not in source
        assert 'main.py' not in source
        assert 'child_process' not in frontend


class TestWaveGuard:
    def _git_stub(self, monkeypatch):
        monkeypatch.setattr(wave_guard, '_git', lambda _root, *args: 'HEAD' if args[0] == 'rev-parse' else '')

    def test_snapshot_complete_verify_and_rollback(self, tmp_path, monkeypatch):
        self._git_stub(monkeypatch)
        root = tmp_path / 'repo'
        backups = tmp_path / 'backups'
        source = root / 'src' / 'a.py'
        source.parent.mkdir(parents=True)
        source.write_text('before\n', encoding='utf-8')
        manifest = root / 'wave.txt'
        manifest.write_text('src/a.py\nsrc/new.py\n', encoding='utf-8')
        created = wave_guard.snapshot('W1', manifest, root=root, backup_root=backups)
        assert created['files']['src/a.py']['pre_sha256']
        assert created['files']['src/new.py']['existed'] is False
        source.write_text('after\n', encoding='utf-8')
        (root / 'src' / 'new.py').write_text('new\n', encoding='utf-8')
        wave_guard.complete('W1', tests='targeted: 3 passed', root=root, backup_root=backups)
        assert wave_guard.verify('W1', root=root, backup_root=backups)['ok']
        source.write_text('unexpected later edit\n', encoding='utf-8')
        checked = wave_guard.verify('W1', root=root, backup_root=backups)
        assert not checked['ok'] and checked['mismatches'] == ['src/a.py']
        with pytest.raises(RuntimeError, match='拒绝恢复'):
            wave_guard.rollback('W1', root=root, backup_root=backups)
        source.write_text('after\n', encoding='utf-8')
        result = wave_guard.rollback('W1', root=root, backup_root=backups)
        assert result['ok']
        assert source.read_text(encoding='utf-8') == 'before\n'
        assert not (root / 'src' / 'new.py').exists()
        untouched = root / 'unrelated.txt'
        untouched.write_text('preserve', encoding='utf-8')
        assert untouched.read_text(encoding='utf-8') == 'preserve'

    def test_complete_and_verify_record_migration_deletions(self, tmp_path, monkeypatch):
        self._git_stub(monkeypatch)
        root = tmp_path / 'repo'
        backups = tmp_path / 'backups'
        source = root / 'src' / 'old.py'
        source.parent.mkdir(parents=True)
        source.write_text('old\n', encoding='utf-8')
        manifest = root / 'wave.txt'
        manifest.write_text('src/old.py\nsrc/renamed.py\n', encoding='utf-8')
        wave_guard.snapshot('W-delete', manifest, root=root, backup_root=backups)
        source.unlink()
        with pytest.raises(FileNotFoundError, match='预期新文件缺失'):
            wave_guard.complete('W-delete', root=root, backup_root=backups)
        completed = wave_guard.complete(
            'W-delete', root=root, backup_root=backups,
            allow_missing=['src/renamed.py'])
        assert completed['files']['src/old.py']['post_sha256'] is None
        assert completed['files']['src/renamed.py']['post_sha256'] is None
        assert wave_guard.verify('W-delete', root=root, backup_root=backups)['ok']
        wave_guard.rollback('W-delete', root=root, backup_root=backups)
        assert source.read_text(encoding='utf-8') == 'old\n'

    def test_only_latest_completed_wave_can_rollback(self, tmp_path, monkeypatch):
        self._git_stub(monkeypatch)
        root = tmp_path / 'repo'
        backups = tmp_path / 'backups'
        root.mkdir()
        (root / 'a.txt').write_text('a', encoding='utf-8')
        manifest = root / 'wave.txt'
        manifest.write_text('a.txt\n', encoding='utf-8')
        for wave in ('W1', 'W2'):
            wave_guard.snapshot(wave, manifest, root=root, backup_root=backups)
            wave_guard.complete(wave, root=root, backup_root=backups)
        with pytest.raises(ValueError, match='最新'):
            wave_guard.rollback('W1', root=root, backup_root=backups)

    def test_manifest_rejects_artifacts_and_escape(self, tmp_path):
        root = tmp_path / 'repo'
        root.mkdir()
        manifest = root / 'wave.txt'
        for row in ('../outside.py', 'dist/Harbor.exe', 'pkg/tool.dll'):
            manifest.write_text(row + '\n', encoding='utf-8')
            with pytest.raises(ValueError):
                wave_guard.snapshot('W1', manifest, root=root, backup_root=tmp_path / 'backups')
