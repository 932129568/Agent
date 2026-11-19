# -*- coding: utf-8 -*-
"""R47/R52 性能门禁：hub-catalog 懒加载 + 产物字节上限 + 启动打点。"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_hub_catalog_lazy_parse_form():
    src = open(os.path.join(ROOT, 'frontend', 'src', 'shell', 'hub-catalog.js'),
               encoding='utf-8').read()
    assert 'const HUB_CATALOG_JSON = ' in src
    assert 'let _HUB_CATALOG = null;' in src
    assert 'JSON.parse(HUB_CATALOG_JSON)' in src
    assert 'function hubCatalog()' in src


def test_harbor_html_size_cap():
    size = os.path.getsize(os.path.join(ROOT, 'harbor.html'))
    assert size < 4_100_000, size


def test_startup_perf_marks_present():
    src = open(os.path.join(ROOT, 'electron', 'main.js'), encoding='utf-8').read()
    for mark in ('server-listening', 'db-ready', 'window-loaded'):
        assert '[perf] ' + mark in src, mark


def test_node_compile_cache_seam():
    src = open(os.path.join(ROOT, 'electron', 'main.js'), encoding='utf-8').read()
    assert 'NODE_COMPILE_CACHE' in src
