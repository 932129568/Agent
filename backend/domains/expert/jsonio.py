# -*- coding: utf-8 -*-
"""Bounded IO and strict JSON helpers for untrusted expert assets."""
import hashlib
import json
import os
import stat

from .model import failure


def read_limited(path, limit, field=None):
    """Read a regular file only through limit+1, never an unbounded blob."""
    with open(path, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            failure('NOT_REGULAR_FILE', '只允许普通文件', path=path, field=field)
        if info.st_size > limit:
            failure('FILE_TOO_LARGE', '文件超过大小上限', path=path, field=field)
        data = handle.read(limit + 1)
    if len(data) > limit:
        failure('FILE_TOO_LARGE', '文件超过大小上限', path=path, field=field)
    return data


def _pairs(pairs, path):
    result = {}
    for key, value in pairs:
        if key in result:
            failure('DUPLICATE_KEY', 'JSON 存在重复键', path=path, field=key)
        result[key] = value
    return result


def strict_json_bytes(data, path):
    try:
        text = data.decode('utf-8') if isinstance(data, bytes) else str(data)
    except UnicodeDecodeError as error:
        failure('INVALID_UTF8', 'JSON 必须是 UTF-8', path=path, line=1, column=error.start + 1)
    try:
        return json.loads(text, object_pairs_hook=lambda pairs: _pairs(pairs, path),
                          parse_constant=lambda value: failure('INVALID_NUMBER', '禁止 NaN/Infinity', path=path))
    except Exception as error:
        if getattr(error, 'code', None):
            raise
        if isinstance(error, json.JSONDecodeError):
            failure('INVALID_JSON', 'JSON 语法错误', path=path,
                    line=error.lineno, column=error.colno)
        failure('INVALID_JSON', 'JSON 解析失败', path=path)


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()
