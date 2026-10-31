# -*- coding: utf-8 -*-
"""Restricted frontmatter parser; intentionally not a general YAML implementation."""
import json
import re

from .model import failure

KEY_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$')
INT_RE = re.compile(r'^-?(?:0|[1-9][0-9]*)$')


def _error(code, message, path, line, field=None, column=1):
    failure(code, message, path=path, field=field, line=line, column=column)


def _strip_comment(value):
    single = double = False
    depth = 0
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == '\\' and double:
            escaped = True
            continue
        if char == '"' and not single:
            double = not double
        elif char == "'" and not double:
            single = not single
        elif not single and not double:
            if char in '[{':
                depth += 1
            elif char in ']}':
                depth = max(0, depth - 1)
            elif char == '#' and depth == 0 and (index == 0 or value[index - 1].isspace()):
                return value[:index].rstrip()
    return value.rstrip()


def _split_flow(value, path, line, field):
    parts, current = [], []
    single = double = escaped = False
    for char in value:
        if escaped:
            current.append(char)
            escaped = False
            continue
        if char == '\\' and double:
            current.append(char)
            escaped = True
            continue
        if char == '"' and not single:
            double = not double
        elif char == "'" and not double:
            single = not single
        elif char == ',' and not single and not double:
            parts.append(''.join(current))
            current = []
        else:
            current.append(char)
    if single or double:
        _error('UNCLOSED_QUOTE', 'flow-map 引号未闭合', path, line, field)
    parts.append(''.join(current))
    return parts


def _scalar(value, path, line, field):
    value = _strip_comment(value).strip()
    if not value:
        _error('EMPTY_VALUE', '字段值不能为空', path, line, field)
    if any(ord(char) < 32 for char in value):
        _error('CONTROL_CHARACTER', '字段含控制字符', path, line, field)
    if value in ('true', 'false'):
        return value == 'true'
    if INT_RE.match(value):
        return int(value)
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except Exception:
            _error('UNCLOSED_QUOTE', '双引号字符串非法', path, line, field)
        if not isinstance(parsed, str):
            _error('INVALID_SCALAR', '字段必须是字符串', path, line, field)
        return parsed
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            _error('UNCLOSED_QUOTE', '单引号字符串非法', path, line, field)
        inner = value[1:-1]
        index = 0
        output = []
        while index < len(inner):
            if inner[index] == "'":
                if index + 1 < len(inner) and inner[index + 1] == "'":
                    output.append("'")
                    index += 2
                    continue
                _error('UNCLOSED_QUOTE', '单引号必须成对或使用双单引号转义', path, line, field)
            output.append(inner[index])
            index += 1
        return ''.join(output)
    if value.startswith('['):
        try:
            parsed = json.loads(value, parse_constant=lambda item: (_ for _ in ()).throw(ValueError(item)))
        except Exception:
            _error('INVALID_ARRAY', 'inline array 必须是合法 JSON', path, line, field)
        if not isinstance(parsed, list) or any(not isinstance(item, (str, bool, int)) or item is None
                                             for item in parsed):
            _error('INVALID_ARRAY_ITEM', 'inline array 只允许 string/bool/int', path, line, field)
        return parsed
    if value.startswith('{'):
        if not value.endswith('}'):
            _error('UNCLOSED_MAP', 'flow-map 未闭合', path, line, field)
        result = {}
        inner = value[1:-1].strip()
        if not inner:
            return result
        for item in _split_flow(inner, path, line, field):
            if ':' not in item:
                _error('INVALID_MAP', 'flow-map 项缺少冒号', path, line, field)
            child, raw = item.split(':', 1)
            child = child.strip()
            if not KEY_RE.match(child):
                _error('INVALID_MAP_KEY', 'flow-map 子键非法', path, line, child)
            if child in result:
                _error('DUPLICATE_KEY', 'flow-map 子键重复', path, line, child)
            if raw.strip().startswith('{'):
                _error('NESTED_MAP', '只允许一层 map', path, line, child)
            result[child] = _scalar(raw, path, line, child)
        return result
    if any(token in value for token in ('[]', '{}')) or ': ' in value:
        _error('INVALID_BARE_STRING', 'bare-string 含非法字符', path, line, field)
    if value.startswith(('&', '*', '!')) or value in ('<<', '---'):
        _error('UNSUPPORTED_YAML', '不支持锚点、别名、tag 或多文档语法', path, line, field)
    return value


def parse_frontmatter(data, path):
    if isinstance(data, bytes):
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError as error:
            _error('INVALID_UTF8', '文档必须是 UTF-8', path, 1, column=error.start + 1)
    else:
        text = str(data)
    text = text.replace('\r\n', '\n')
    if '\r' in text:
        _error('INVALID_NEWLINE', '只允许 LF 或 CRLF 换行', path, 1)
    lines = text.split('\n')
    if not lines or lines[0] != '---':
        _error('FRONTMATTER_REQUIRED', '文档必须以 frontmatter 开始', path, 1)
    result = {}
    index = 1
    closed = False
    while index < len(lines):
        line = lines[index]
        number = index + 1
        if line == '---':
            closed = True
            index += 1
            break
        if '\t' in line:
            _error('INVALID_INDENT', 'frontmatter 禁止 tab', path, number)
        if not line.strip() or line.lstrip().startswith('#'):
            index += 1
            continue
        if line.startswith(' '):
            _error('INVALID_INDENT', '顶层字段不能缩进', path, number)
        if ':' not in line:
            _error('INVALID_ENTRY', '字段必须是 key: value', path, number)
        key, raw = line.split(':', 1)
        if not KEY_RE.match(key):
            _error('INVALID_KEY', '字段名非法', path, number, key)
        if key in result:
            _error('DUPLICATE_KEY', 'frontmatter 字段重复', path, number, key)
        raw = raw.lstrip()
        if raw in ('|', '|-'):
            block = []
            index += 1
            while index < len(lines) and lines[index] != '---':
                child = lines[index]
                if child and not child.startswith('  '):
                    _error('INVALID_BLOCK_INDENT', 'block-text 必须使用两个空格缩进', path, index + 1, key)
                block.append(child[2:] if child.startswith('  ') else '')
                index += 1
            if index >= len(lines):
                _error('UNCLOSED_BLOCK', 'block-text/frontmatter 未闭合', path, number, key)
            result[key] = '\n'.join(block) + ('\n' if raw == '|' else '')
            continue
        if raw == '':
            mapping = {}
            index += 1
            while index < len(lines) and lines[index] != '---':
                child = lines[index]
                if not child.strip():
                    index += 1
                    continue
                if child.startswith('    ') or (child.startswith(' ') and not child.startswith('  ')):
                    _error('INVALID_INDENT', '一层 map 必须使用两个空格缩进', path, index + 1, key)
                if not child.startswith('  '):
                    break
                entry = child[2:]
                if ':' not in entry:
                    _error('INVALID_MAP', '一层 map 项缺少冒号', path, index + 1, key)
                child_key, child_raw = entry.split(':', 1)
                if not KEY_RE.match(child_key):
                    _error('INVALID_MAP_KEY', '一层 map 子键非法', path, index + 1, child_key)
                if child_key in mapping:
                    _error('DUPLICATE_KEY', '一层 map 子键重复', path, index + 1, child_key)
                if child_raw.strip() == '':
                    _error('NESTED_MAP', '只允许一层 map', path, index + 1, child_key)
                mapping[child_key] = _scalar(child_raw, path, index + 1, child_key)
                index += 1
            result[key] = mapping
            continue
        result[key] = _scalar(raw, path, number, key)
        index += 1
    if not closed:
        _error('UNCLOSED_FRONTMATTER', 'frontmatter 未闭合', path, len(lines))
    return result, '\n'.join(lines[index:])
