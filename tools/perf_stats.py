# -*- coding: utf-8 -*-
"""Dependency-free, lossless performance sample summaries."""
import math
import statistics


def nearest_rank(samples, percentile):
    """Return x[ceil(p*N)-1] without interpolation or outlier removal."""
    values = sorted(samples)
    if not values:
        raise ValueError('percentile requires at least one sample')
    if not 0 < percentile <= 1:
        raise ValueError('percentile must be in (0, 1]')
    return values[max(0, math.ceil(percentile * len(values)) - 1)]


def summarize(samples, elapsed_seconds=None, unit='ms'):
    """Retain raw samples and add median, nearest-rank tails and throughput."""
    values = list(samples)
    if not values:
        raise ValueError('summary requires at least one sample')
    elapsed = sum(values) / 1000.0 if elapsed_seconds is None and unit == 'ms' else elapsed_seconds
    throughput = None
    if elapsed is not None:
        if elapsed <= 0:
            raise ValueError('elapsed_seconds must be positive')
        throughput = len(values) / elapsed
    return {
        'unit': unit,
        'samples': values,
        'count': len(values),
        'median': statistics.median(values),
        'p95': nearest_rank(values, 0.95),
        'p99': nearest_rank(values, 0.99),
        'min': min(values),
        'max': max(values),
        'tasks_per_s': throughput,
    }


def group_metadata(cold, algorithm, concurrency=1, label='', **extra):
    """Describe cold/warm, algorithm and parallel groups without merging them."""
    if concurrency < 1:
        raise ValueError('concurrency must be at least 1')
    metadata = {
        'temperature': 'cold' if cold else 'warm',
        'algorithm': str(algorithm),
        'parallel': {'enabled': concurrency > 1, 'concurrency': concurrency},
        'label': str(label),
    }
    metadata.update(extra)
    return metadata
