# -*- coding: utf-8 -*-
"""推理偏好服务（复核批新增）：思考强度 + 上下文窗口，model_prefs.json 独立文件。

config.json 零污染铁律：新配置一律独立文件（reader.json/browser_sessions.json
同口径）。文件形状（Claude 兼容未知键忽略；手工可改）：

    {"version": 1, "thinking": "auto", "ctx_k": 0}

- thinking：'auto'（智能档按任务复杂度自动调节——既有行为）| 'off'（禁思考）
  | 'low' | 'medium' | 'high'（手动锁定，随请求发 reasoning_effort）；
- ctx_k：上下文窗口上限，单位=千 token（0=默认 200K；支持 32/128/256/300/1024K），
  其他 0-2048 的合法输入收敛到最近低档；前端据此调自动压缩阈值与 token
  统计分母；非 GLM 端点 thinking 字段照旧剥离（既有行为）。

坏文件容错：解析失败/结构异常留 .bad 备份后回落默认（guard.json ⑰ 同口径）。
"""
import json
import os
import threading

from ... import paths
from ...fio import atomic_write_json
from ...logging_setup import get_logger

THINKING_VALUES = ('auto', 'off', 'low', 'medium', 'high')
CTX_K_VALUES = (0, 32, 128, 256, 300, 1024)
CTX_K_MAX = 2048                        # 千 token；0=默认口径，最大 2048K=2M tokens
DEFAULT_PREFS = {'thinking': 'auto', 'ctx_k': 0}


def _ctx_k_clamp(value):
    """任意合法范围内的窗口值收敛到前端支持的最近低档，避免前端无法回显。"""
    return max(v for v in CTX_K_VALUES if v <= value)


class ModelPrefsService:
    """model_prefs.json 唯一读写者（原子写 + 内存态 + 锁）。"""

    def __init__(self, path: str = None):
        self._log = get_logger()
        self._path = path or paths.MODEL_PREFS_FILE
        self._lock = threading.RLock()
        self._data = self._load()

    def _load(self):
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                out = dict(DEFAULT_PREFS)
                if data.get('thinking') in THINKING_VALUES:
                    out['thinking'] = data['thinking']
                try:
                    ck = int(data.get('ctx_k'))
                except (TypeError, ValueError):
                    ck = 0
                if 0 <= ck <= CTX_K_MAX:
                    out['ctx_k'] = _ctx_k_clamp(ck)
                return out
            self._log.warning('model_prefs.json 结构异常，按默认处理（已留 .bad 备份）')
            self._bad_backup()
        except FileNotFoundError:
            pass
        except Exception as e:
            self._log.warning('model_prefs.json 加载失败，按默认处理: %r', e)
            self._bad_backup()
        return dict(DEFAULT_PREFS)

    def _bad_backup(self):
        try:
            if os.path.exists(self._path):
                os.replace(self._path, self._path + '.bad')
        except OSError:
            pass

    def get(self) -> dict:
        with self._lock:
            return dict(dict(self._data), ok=True)

    def save(self, prefs) -> dict:
        """保存（dict 或 JSON 串）：白名单校验 + 原子落盘。返回 {ok,...}/{error}。"""
        if isinstance(prefs, str):
            try:
                prefs = json.loads(prefs or '{}')
            except Exception as e:
                return {'error': '偏好不是合法 JSON: %s' % e}
        if not isinstance(prefs, dict):
            return {'error': '偏好必须是 JSON 对象'}
        thinking = prefs.get('thinking', self._data.get('thinking', 'auto'))
        if thinking not in THINKING_VALUES:
            return {'error': 'thinking 仅支持 %s' % '/'.join(THINKING_VALUES)}
        try:
            ctx_k = int(prefs.get('ctx_k', self._data.get('ctx_k', 0)))
        except (TypeError, ValueError):
            return {'error': 'ctx_k 必须是整数（KiB）'}
        if not (0 <= ctx_k <= CTX_K_MAX):
            return {'error': 'ctx_k 超出范围（允许 0-%d；保存时收敛到 0/32/128/256/300/1024K）' % CTX_K_MAX}
        ctx_k = _ctx_k_clamp(ctx_k)
        with self._lock:
            old = dict(self._data)
            self._data = {'thinking': thinking, 'ctx_k': ctx_k}
            try:
                os.makedirs(os.path.dirname(self._path) or '.', exist_ok=True)
                atomic_write_json(self._path, dict(self._data, version=1), indent=2)
            except Exception as e:
                self._data = old                     # 落盘失败回滚内存态（W5 同口径）
                self._log.exception('model_prefs.json 保存失败')
                return {'error': '偏好保存失败: %s' % e}
        return {'ok': True, 'thinking': thinking, 'ctx_k': ctx_k}
