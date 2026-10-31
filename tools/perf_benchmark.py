# -*- coding: utf-8 -*-
"""Reproducible Harbor search-I/O and frontend scheduling micro-benchmark.

Writes all samples plus environment and dataset metadata to outputs/perf/<label>.json.
No application files, config, persistent caches, executables, or external services are used.
"""
import argparse
import cProfile
import io
import json
import os
import platform
import pstats
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import paths  # noqa: E402
from backend.logging_setup import get_logger  # noqa: E402
from backend.domains.integrations.browser.service import SearchService  # noqa: E402
from backend.domains.settings.config_service import ConfigService  # noqa: E402
from backend.domains.workspace.file_service import FileService  # noqa: E402
from tools.perf_cdp import collect_performance  # noqa: E402
from tools.perf_stats import summarize  # noqa: E402
from tools.perf_system import ProcessSampler  # noqa: E402


def git_revision():
    """Read the source revision without modifying the worktree."""
    result = subprocess.run(
        ['git', '-C', str(ROOT), 'rev-parse', 'HEAD'],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


def backend_benchmark(run_count, cache_files, profile_enabled):
    """Measure live cache-directory statistics against isolated synthetic entries."""
    process = ProcessSampler()
    process.before()
    samples = []
    with tempfile.TemporaryDirectory(prefix='harbor-perf-cache-') as temp_dir:
        cache_dir = Path(temp_dir) / 'search_cache'
        cache_dir.mkdir()
        for index in range(cache_files):
            entry = {
                'query': 'harbor benchmark', 'results': [],
                'fetched_ts': time.monotonic(),
                'ttl_class': ('news', 'general', 'encyclopedia')[index % 3],
                'ttl_minutes': (5, 60, 1440)[index % 3],
                'payload': 'x' * 512,
            }
            (cache_dir / ('%040x.json' % index)).write_text(
                json.dumps(entry, ensure_ascii=False), encoding='utf-8')
        class GuardStub:
            def audit(self, *_args):
                return None

        service = SearchService(cache_dir=str(cache_dir), guard=GuardStub())
        profiler = cProfile.Profile() if profile_enabled else None
        for run in range(run_count):
            started = time.perf_counter()
            if profiler:
                profiler.enable()
            result = service.search_cache_stats()
            if profiler:
                profiler.disable()
            samples.append(round((time.perf_counter() - started) * 1000, 3))
            assert result['entries'] == cache_files
            assert sum(result['ttl_classes'].values()) == cache_files
        profile_text = None
        if profiler:
            output = io.StringIO()
            pstats.Stats(profiler, stream=output).sort_stats('cumulative').print_stats(20)
            profile_text = output.getvalue()
    return {
        'scope': 'python-search-cache-stats',
        'dataset': {'cache_entries': cache_files, 'bytes_payload_per_entry': 512},
        'cold_warm': 'First sample includes first directory enumeration; later samples are warm OS-cache runs.',
        'correctness': {'entries_each_run': cache_files},
        'metrics': {'search_cache_stats': summarize(samples)},
        'process': process.after(),
        'profile_top20_cumulative': profile_text,
    }


def core_backend_benchmark(run_count, directory_files):
    """Measure history single-call I/O and live directory enumeration in isolation."""
    process = ProcessSampler()
    process.before()
    history_samples = []
    history_open_counts = []
    list_samples = []
    with tempfile.TemporaryDirectory(prefix='harbor-perf-core-') as temp_dir:
        base = Path(temp_dir)
        history_file = base / 'history.json'
        history_file.write_text(json.dumps({'dir': str(base)}), encoding='utf-8')
        original_paths = (paths.HISTORY_FILE, paths.SESSIONS_PATH, paths.CONFIG_DIR)
        paths.HISTORY_FILE = str(history_file)
        paths.SESSIONS_PATH = str(base / 'sessions.json')
        paths.CONFIG_DIR = str(base)
        try:
            config = ConfigService.__new__(ConfigService)
            config._lock = threading.RLock()
            config._log = get_logger()
            real_open = open

            def counting_open(file, *args, **kwargs):
                if os.path.abspath(str(file)) == os.path.abspath(str(history_file)):
                    history_open_counts[-1] += 1
                return real_open(file, *args, **kwargs)

            config.history_dir_get()  # warmup excluded
            for _run in range(run_count):
                history_open_counts.append(0)
                started = time.perf_counter()
                with mock.patch('builtins.open', new=counting_open):
                    result = config.history_dir_get()
                history_samples.append(round((time.perf_counter() - started) * 1000, 3))
                assert result['sessions_file'] == str(base / 'sessions.json')
        finally:
            paths.HISTORY_FILE, paths.SESSIONS_PATH, paths.CONFIG_DIR = original_paths

        class RuntimeStub:
            def ws_enabled_for(self, _sid, _default):
                return True

        class WorkspaceStub:
            def __init__(self, root):
                self.root = root

            def effective_root(self, _sid):
                return self.root

        files_dir = base / 'files'
        files_dir.mkdir()
        for index in range(directory_files):
            (files_dir / ('file-%05d.txt' % index)).write_bytes(b'')
        service = FileService.__new__(FileService)
        service.runtime = RuntimeStub()
        service.workspace = WorkspaceStub(str(files_dir))
        service._log = get_logger()
        json.loads(service.list_dir('bench', '.'))  # warmup excluded
        for _run in range(run_count):
            started = time.perf_counter()
            result = json.loads(service.list_dir('bench', '.'))
            list_samples.append(round((time.perf_counter() - started) * 1000, 3))
            assert result.get('total', len(result['entries'])) == directory_files
            assert len(result['entries']) == min(directory_files, 200)
            assert bool(result.get('truncated')) is (directory_files > 200)
    return {
        'scope': 'python-config-and-file-service',
        'dataset': {'directory_files': directory_files, 'history_config_dir': 'temporary'},
        'cold_warm': 'One warmup per path excluded; all following samples retained.',
        'correctness': {
            'history_open_counts': history_open_counts,
            'list_total_each_run': directory_files,
            'list_return_cap': 200,
        },
        'metrics': {
            'history_dir_get': summarize(history_samples),
            'list_dir': summarize(list_samples),
        },
        'process': process.after(),
    }


def frontend_benchmark(run_count):
    """Run the real frontend functions in the dependency-free Node VM harness."""
    env = os.environ.copy()
    env['HARBOR_PERF_RUNS'] = str(run_count)
    result = subprocess.run(
        ['node', str(ROOT / 'tools' / 'perf_frontend_benchmark.js')],
        cwd=ROOT, env=env, check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label', default='baseline', help='Output filename without .json')
    parser.add_argument('--runs', type=int, default=7, help='Samples per metric (minimum 3)')
    parser.add_argument('--cache-files', type=int, default=512)
    parser.add_argument('--directory-files', type=int, default=5000)
    parser.add_argument('--profile', action='store_true', help='Include cProfile for backend I/O')
    args = parser.parse_args()
    if args.runs < 3:
        parser.error('--runs must be at least 3')
    if args.cache_files < 1 or args.directory_files < 1:
        parser.error('--cache-files and --directory-files must be positive')
    if not args.label.replace('-', '').replace('_', '').isalnum():
        parser.error('--label may contain only letters, digits, underscore, and hyphen')

    process = ProcessSampler()
    process.before()
    report = {
        'schema': 1,
        'label': args.label,
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'source_revision': git_revision(),
        'command': ' '.join([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]),
        'environment': {
            'python': sys.version,
            'platform': platform.platform(),
            'processor': platform.processor(),
            'logical_cores': os.cpu_count(),
        },
        'protocol': {
            'runs': args.runs,
            'aggregation': 'median + nearest-rank P95/P99; all samples and outliers retained',
            'clock': 'time.perf_counter / Node performance.now',
            'background_load': 'not controlled; run baseline and comparison back-to-back on the same machine',
            'sample_policy': '7 exploratory samples; >=30 tail-latency samples reserved for P1',
            'groups': {'algorithm': 'current-serial', 'parallel': {'enabled': False, 'concurrency': 1},
                       'temperature': 'cold/warm identified per section'},
        },
        'backend': backend_benchmark(args.runs, args.cache_files, args.profile),
        'backend_core': core_backend_benchmark(args.runs, args.directory_files),
        'frontend': frontend_benchmark(args.runs),
        'limitations': [
            'Seven exploratory samples only; no P95/P99 release-tail claim is made.',
            'No parallel scheduler, Worker, Team parallelism or performance improvement is asserted.',
            'CDP is UNCOVERED unless HARBOR_CDP_ENDPOINT names an existing authorized loopback endpoint.',
        ],
    }
    report['process'] = process.after()
    report['cdp'] = collect_performance(os.environ.get('HARBOR_CDP_ENDPOINT'))
    output = ROOT / 'outputs' / 'perf' / (args.label + '.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({
        'output': str(output),
        'backend_ms': report['backend']['metrics']['search_cache_stats'],
        'backend_core_ms': report['backend_core']['metrics'],
        'history_open_counts': report['backend_core']['correctness']['history_open_counts'],
        'frontend_ms': report['frontend']['metrics'],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
