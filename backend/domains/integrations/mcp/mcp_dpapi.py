# -*- coding: utf-8 -*-
"""DPAPI 字段级加密原语（v1.3 MCP R2，PRD Q1 裁决捆绑）。

设计口径（架构文档 §3.1 / 共享知识 11）：
- 只加密 env 值与 header 值（MCP 配置密钥密度高）；command/args/url/键名/服务器名保持明文。
- 加密值写成单键标记对象 {"__enc__": "dpapi:<base64>"}；Claude 兼容结构可读、可手改、导入不受影响。
- 非 Windows / ctypes 不可用 / 调用异常 → 明文存储 + 日志（不锁死用户）。
- 解密失败（换机器 / 换 Windows 用户）→ 记日志 + 返回内层串（明文兜底），由面板告警重新填写。

stdlib only（ctypes + base64），Python 3.10+ 兼容；onefile 打包零新增依赖。
"""
import base64
import ctypes
from ctypes import wintypes

from ....logging_setup import get_logger

# 加密标记前缀（架构 §3.3：ENC_PREFIX = 'dpapi:'）
ENC_PREFIX = 'dpapi:'

# CryptProtectData 标志：禁止弹窗（无 UI 环境下必须）
_CRYPTPROTECT_UI_FORBIDDEN = 0x1


class _DataBlob(ctypes.Structure):
    """Windows CRYPT_INTEGER_BLOB / DATA_BLOB（crypt32 用）。"""
    _fields_ = [('cbData', wintypes.DWORD),
                ('pbData', ctypes.POINTER(ctypes.c_char))]


def _crypt32():
    """返回 crypt32 库句柄；非 Windows 或加载失败返回 None。"""
    if not hasattr(ctypes, 'windll'):
        return None
    try:
        return ctypes.windll.crypt32
    except Exception:
        return None


_k32_cache = None
_k32_tried = False


def _kernel32():
    """修复 ⑰：kernel32 句柄缓存（原每次 LocalFree 都二次加载 kernel32）。"""
    global _k32_cache, _k32_tried
    if _k32_tried:
        return _k32_cache
    _k32_tried = True
    if not hasattr(ctypes, 'windll'):
        return None
    try:
        _k32_cache = ctypes.windll.kernel32
    except Exception:
        _k32_cache = None
    return _k32_cache


def is_available() -> bool:
    """当前环境是否可用 DPAPI（Windows 且 crypt32 可加载）。"""
    return _crypt32() is not None


def _localfree(ptr):
    """LocalFree 统一出口（修复 ⑰：复用缓存的 kernel32 句柄）。"""
    k32 = _kernel32()
    if k32 is None:
        return
    try:
        k32.LocalFree.argtypes = [ctypes.c_void_p]
        k32.LocalFree.restype = wintypes.HANDLE
        k32.LocalFree(ctypes.cast(ptr, ctypes.c_void_p))
    except Exception:
        pass


def encrypt_value(plain: str) -> str:
    """加密单个值 → ENC_PREFIX + base64；不可用/异常 → 原样返回并记日志。"""
    if plain is None:
        return plain
    plain = str(plain)
    if plain == '':
        return plain
    crypt = _crypt32()
    if crypt is None:
        return plain          # 非 Windows：明文存储（导入/保存不报错）
    try:
        raw = plain.encode('utf-8')
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DataBlob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()
        crypt.CryptProtectData.argtypes = [
            ctypes.POINTER(_DataBlob), wintypes.LPWSTR, ctypes.POINTER(_DataBlob),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob)]
        crypt.CryptProtectData.restype = wintypes.BOOL
        if not crypt.CryptProtectData(ctypes.byref(blob_in), None, None, None, None,
                                      _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)):
            raise ctypes.WinError()
        cipher = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        _localfree(blob_out.pbData)
        return ENC_PREFIX + base64.b64encode(cipher).decode('ascii')
    except Exception as e:
        get_logger().warning('DPAPI 加密失败，按明文存储: %r', e)
        return plain


def decrypt_value(marker: str) -> str:
    """解密单个值：非标记 → 原样返回；标记 → 解密；失败 → 记日志 + 返回内层串（明文兜底）。"""
    if not isinstance(marker, str) or not marker.startswith(ENC_PREFIX):
        return marker
    crypt = _crypt32()
    if crypt is None:
        return marker
    try:
        raw = base64.b64decode(marker[len(ENC_PREFIX):])
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DataBlob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()
        crypt.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DataBlob), ctypes.POINTER(wintypes.LPWSTR),
            ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.c_void_p,
            wintypes.DWORD, ctypes.POINTER(_DataBlob)]
        crypt.CryptUnprotectData.restype = wintypes.BOOL
        if not crypt.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None,
                                        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out)):
            raise ctypes.WinError()
        data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        _localfree(blob_out.pbData)
        return data.decode('utf-8')
    except Exception as e:
        get_logger().warning('DPAPI 解密失败，按明文兜底: %r', e)
        return marker


def encrypt_mapping(m: dict) -> dict:
    """{k: encrypt_value(v)}：只加密值，键名保持明文。"""
    out = {}
    for k, v in (m or {}).items():
        out[str(k)] = encrypt_value(v if v is not None else '')
    return out


def decrypt_mapping(m: dict) -> tuple:
    """解密整个映射 → (解密后 dict, 失败键告警列表)。

    兼容两种存储形态：{"__enc__": "dpapi:..."}（落盘结构）与 "dpapi:..."（encrypt_mapping 输出）。
    失败键告警供面板提示「密钥解密失败，请重新填写」（共享知识 11）。
    """
    out, failed = {}, []
    for k, v in (m or {}).items():
        key = str(k)
        marker = None
        if isinstance(v, dict) and isinstance(v.get('__enc__'), str):
            marker = v['__enc__']
        elif isinstance(v, str) and v.startswith(ENC_PREFIX):
            marker = v
        if marker is not None:
            plain = decrypt_value(marker)
            if plain.startswith(ENC_PREFIX):
                failed.append(key)   # 解密失败：内层串原样兜底
            out[key] = plain
        else:
            out[key] = v if v is None else str(v)
    return out, failed
