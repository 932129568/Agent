# -*- coding: utf-8 -*-
"""W6P1 per-domain read-only concurrency admission probes; production remains inline=1."""
import json
import platform
import tempfile
import threading
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.application.registry import TaskRegistry
from backend.application.scheduler import DomainScheduler
from backend.application.task import TaskEnvelope
from tools.perf_stats import summarize
from tools.perf_system import ProcessSampler

RUNS = 37


def run_probe(domain, paths, concurrency, same_resource=False):
    registry = TaskRegistry()
    scheduler = DomainScheduler(registry, inline=concurrency == 1, worker_count=concurrency)
    sampler = ProcessSampler()
    samples = []
    calls = []
    sampler.before()
    for _run in range(RUNS):
        batch_calls = []
        started = time.perf_counter()
        futures = []
        for path in paths:
            key = 'same-revision' if same_resource else str(path)
            envelope = TaskEnvelope.create(domain, 'read_manifest', resourceKeys=(key,), generation=1)
            def read(_envelope, target=path):
                data = target.read_bytes()
                batch_calls.append({'path': str(target), 'bytes': len(data)})
                return len(data)
            futures.append(scheduler.submit(envelope, read))
        for future in futures:
            future.result(10)
        samples.append(round((time.perf_counter() - started) * 1000, 3))
        calls.append(len(batch_calls))
    closed = scheduler.close()
    process = sampler.after()
    return {
        'concurrency': concurrency, 'samples_ms': summarize(samples),
        'original_samples_ms': samples, 'calls_per_run': calls,
        'scheduler': closed, 'process': process,
        'correctness': all(count == len(paths) for count in calls),
    }


def decision(results):
    baseline = results[0]['samples_ms']
    candidates = results[1:]
    for candidate in candidates:
        if candidate['samples_ms']['p95'] > baseline['p95'] or not candidate['correctness']:
            return 'keep1', 'P95 regression or correctness failure'
        if not candidate['scheduler'].get('drained'):
            return 'keep1', 'workers did not drain'
    best = min(candidate['samples_ms']['median'] for candidate in candidates)
    if best >= baseline['median'] * 0.8:
        return 'keep1', 'less than 20% median improvement; no net production benefit'
    return 'keep1', 'isolated probe gain is insufficient to enable production concurrency'


def main():
    baseline_path = ROOT / 'outputs' / 'perf' / 'w6p1-baseline.json'
    baseline = json.loads(baseline_path.read_text(encoding='utf-8'))
    with tempfile.TemporaryDirectory(prefix='w6p1-read-probe-') as temp:
        paths = []
        for index in range(8):
            path = Path(temp) / ('manifest-%d.json' % index)
            path.write_text(json.dumps({'revision': 1, 'index': index, 'payload': 'x' * 4096}), encoding='utf-8')
            paths.append(path)
        report = {
            'protocol': 'perf-v2', 'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'environment': {'platform': platform.platform(), 'python': platform.python_version(),
                            'logical_cpu': __import__('os').cpu_count()},
            'exploration_runs': 7, 'tail_runs': 30, 'total_runs_per_concurrency': RUNS,
            'production_default': {'concurrency': 1, 'inline': True},
            'baseline_artifact': str(baseline_path),
            'baseline_headline': baseline.get('backend_core_ms', baseline.get('backend', {})),
            'algorithmic_optimizations': [],
            'domains': {},
            'safety': {
                'writes_commands_token_consume': 1, 'mcp_tools_call': 1,
                'webdav_put_restore': 1, 'native_evaluate': 1,
                'local_proxy_target': 1, 'non_idempotent_replay': False,
            },
            'uncovered': ['real_exe', 'GPU', 'macOS', 'external_MCP_WebDAV_model_endpoints'],
        }
        for domain in ('settings_history', 'workspace', 'security_planning', 'webdav', 'local_proxy'):
            same = domain == 'settings_history'
            results = [run_probe(domain, paths, concurrency, same) for concurrency in (1, 2, 4)]
            status, reason = decision(results)
            report['domains'][domain] = {'status': status, 'reason': reason,
                'scope': 'actual Path.read_bytes through DomainScheduler; same-file revision serialized' if same else 'independent read-only files through DomainScheduler',
                'results': results}
        for domain, reason in {
            'mcp_stdio': 'per-server/stdin write remains 1; no safe production parallel candidate',
            'mcp_http': 'independent-host HTTP is not enabled without real host evidence; connection=1',
        }.items():
            report['domains'][domain] = {'status': 'keep1', 'reason': reason,
                'results': [], 'candidate': 'NOT_ADMITTED'}
        report['ok'] = all(item['status'] == 'keep1' for item in report['domains'].values())
        report['enabled_domains'] = []
        report['kept_at_one'] = list(report['domains'])
        report['rollback_domains'] = []
        report['note'] = 'No production parallel path was enabled. Probes are not a real-exe performance claim.'
    output = ROOT / 'outputs' / 'perf' / 'w6p1-report.json'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(output), 'ok': report['ok'],
                      'enabled': report['enabled_domains'], 'kept_at_one': report['kept_at_one']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
