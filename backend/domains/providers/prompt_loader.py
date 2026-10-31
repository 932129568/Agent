# -*- coding: utf-8 -*-
"""prompt_loader：版本化提示词加载器（W0 R19 第一步）。

设计口径（deep-research W0）：
- `backend/prompts/*.md` + `manifest.json`（id → version + sha256）是提示词唯一
  数据源；`api.py:build_system_prompt` 与前端（经 prompt_get js_api）改读文件。
- **frozen 安全**：PyInstaller onefile 下 `__file__` 位于 `sys._MEIPASS`，datas
  声明 `('backend/prompts', 'backend/prompts')` 保持相对结构——本模块用
  `os.path.dirname(__file__)/../prompts` 定位，开发态与 frozen 态同口径。
- **manifest 校验**：sha256 不符 → 日志告警但仍返回内容（提示词漂移不阻塞
  主流程；manifest 是给「谁改了提示词」的可追溯锚，不是运行时门）。
- **缓存**：进程内 dict（提示词运行期不变；测试可 clear_cache 重置）。
"""
import hashlib
import json
import os
import re

_LOG = None


def _log():
    global _LOG
    if _LOG is None:
        from ...logging_setup import get_logger
        _LOG = get_logger()
    return _LOG


def prompts_dir():
    """提示词目录绝对路径（providers 上两级到 backend，frozen 同构）。"""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'prompts'))


_cache = {}
_MANIFEST = None


def _load_manifest():
    global _MANIFEST
    if _MANIFEST is not None:
        return _MANIFEST
    path = os.path.join(prompts_dir(), 'manifest.json')
    try:
        with open(path, encoding='utf-8') as f:
            _MANIFEST = json.load(f)
    except Exception as e:
        _log().warning('prompts manifest 读取失败: %r', e)
        _MANIFEST = {'prompts': {}}
    return _MANIFEST


def load(prompt_id):
    """读提示词 → (text, version)。

    Args:
        prompt_id: manifest 里的 id（如 'system-base'/'efficiency'）。

    Returns:
        (text, version)；文件缺失或 manifest 无此 id → ('', '')（调用方回落
        内置默认，不抛——提示词缺失不阻塞启动）。
    """
    if prompt_id in _cache:
        return _cache[prompt_id]
    manifest = _load_manifest().get('prompts', {})
    entry = manifest.get(prompt_id)
    if not entry:
        _log().warning('prompts manifest 无 id: %s', prompt_id)
        return ('', '')
    fname = entry.get('file') or (prompt_id + '.md')
    # 防路径穿越：manifest 的 file 必须是纯文件名（basename 自等且无 '..'）——
    # 非法值（含目录/../ 绝对路径）记 warning 并回落默认名，不让 manifest
    # 把读取范围扩到 prompts/ 之外
    fname = str(fname)
    if os.path.basename(fname) != fname or '..' in fname:
        _log().warning('prompts manifest file 字段非法（回落默认名）: '
                       'id=%s file=%r', prompt_id, fname)
        fname = prompt_id + '.md'
    path = os.path.join(prompts_dir(), fname)
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except Exception as e:
        _log().warning('提示词读取失败 %s: %r', fname, e)
        return ('', '')
    # sha256 校验（漂移可追溯，不阻塞）
    expect = str(entry.get('sha256') or '')
    actual = hashlib.sha256(text.encode('utf-8')).hexdigest()
    if expect and actual != expect:
        _log().warning('提示词 sha256 漂移: %s（manifest=%s 实际=%s）——'
                       '请更新 manifest 或还原文件', prompt_id, expect[:12], actual[:12])
    version = str(entry.get('version') or '1.0.0')
    _cache[prompt_id] = (text, version)
    return (text, version)


def render(prompt_id, **kwargs):
    """读提示词并做 {placeholder} 替换（缺键不替换、保持原样可诊断）。

    一次性替换（``re.sub`` 单遍扫描）：逐键 ``str.replace`` 是 O(键数×文本长)
    的多遍扫描，且替换值里含 ``{other}`` 时会连锁二次替换；单遍 + 缺键原样
    保留（``kwargs.get`` 取不到即返回匹配自身）。
    """
    text, version = load(prompt_id)
    if not text:
        return ('', version)
    text = re.sub(r'\{(\w+)\}',
                  lambda m: str(kwargs.get(m.group(1), m.group(0))), text)
    return (text, version)


def list_ids():
    """manifest 全部 id（前端 prompt_get 探活/自检用）。"""
    return sorted(_load_manifest().get('prompts', {}).keys())


def clear_cache():
    """清进程内缓存（测试用）。"""
    _cache.clear()
    global _MANIFEST
    _MANIFEST = None
