# -*- coding: utf-8 -*-
"""剪贴板服务：Win32 ctypes 读写（legacy Api L676-754 搬迁）。

修复 C2：ctypes 默认 restype=c_int 会截断 64 位指针（GlobalLock/GlobalAlloc），
显式声明 restype/argtypes；修复 W6：SetClipboardData 失败时释放 GMEM 并重试，
全败返回明确错误（不再谎报"已写入"）。
注意（W14）：剪贴板可能含有用户密码等敏感内容，读取结果仅回传给当前会话使用。
"""
import ctypes

from ...errors import ok


def _apply_win32_signatures(u32, k32):
    """显式声明 Win32 函数签名（修复 C2：64 位下 GlobalLock 指针被 int 截断）。"""
    try:
        from ctypes import wintypes
        k32.GlobalAlloc.restype = wintypes.HGLOBAL
        k32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        k32.GlobalLock.restype = ctypes.c_void_p
        k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
        k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        k32.GlobalFree.argtypes = [wintypes.HGLOBAL]
        # 修复 W11（二轮）：读路径按 GlobalSize 取上界（原 c_wchar_p 无界读，
        # 病态程序放进非 NUL 终止数据可越界读崩溃）。
        # getattr 守卫：测试桩/降级环境无 GlobalSize 时不得中断后续声明。
        _gs = getattr(k32, 'GlobalSize', None)
        if _gs is not None:
            _gs.restype = ctypes.c_size_t
            _gs.argtypes = [wintypes.HGLOBAL]
        u32.GetClipboardData.restype = wintypes.HANDLE
        u32.GetClipboardData.argtypes = [wintypes.UINT]
        u32.SetClipboardData.restype = wintypes.HANDLE
        u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
        u32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
        u32.OpenClipboard.argtypes = [wintypes.HWND]
    except Exception:
        pass   # 测试桩/非 Windows 降级：签名声明失败不影响调用


class ClipboardService:
    def _clipboard_read(self):
        """内部读取, 返回 (str, None) 或 (None, 'busy')"""
        u32 = ctypes.windll.user32
        k32 = ctypes.windll.kernel32
        _apply_win32_signatures(u32, k32)
        if not u32.IsClipboardFormatAvailable(13):
            return '', None
        if not u32.OpenClipboard(0):
            return None, 'busy'
        try:
            h = u32.GetClipboardData(13)
            if not h:
                return '', None
            p = k32.GlobalLock(h)
            if not p:
                return None, 'busy'
            try:
                # 修复 W11（二轮）：定长读——GlobalSize 取 buffer 上界，再到首个 NUL 截止
                _gsize = getattr(k32, 'GlobalSize', None)
                if callable(_gsize):
                    _sz = int(_gsize(h) or 0)
                    if _sz > 0:
                        return (ctypes.wstring_at(p, _sz // 2).split('\x00')[0] or ''), None
                return (ctypes.c_wchar_p(p).value or ''), None   # 桩/降级路径
            finally:
                k32.GlobalUnlock(h)
        finally:
            u32.CloseClipboard()

    def get_clipboard(self):
        """读取系统剪贴板文本(占用时自动重试, 不再让调用方稍后再试)"""
        import time as _t
        try:
            for attempt in range(8):
                text, busy = self._clipboard_read()
                if text is not None:
                    # 修复 ④（三轮）：截断后 len 用原文长度与 text[:30000] 不符——
                    # len 改为截断后实际返回长度（模型据此判断是否还有未读内容）
                    t = text[:30000]
                    return ok({'ok': True, 'text': t, 'len': len(t)})
                _t.sleep(0.06)
            return ok({'error': '剪贴板被持续占用, 请稍后再试'})
        except Exception as e:
            return ok({'error': str(e)})

    def set_clipboard(self, text):
        """写入系统剪贴板文本(写入后回读校验, 不一致自动重写, 保证 set→get 一致)"""
        import time as _t
        try:
            u32 = ctypes.windll.user32
            k32 = ctypes.windll.kernel32
            _apply_win32_signatures(u32, k32)
            data = str(text if text is not None else '')
            # 修复 W10（二轮）：按 UTF-16LE 实际字节数分配与填充（原 create_unicode_buffer
            # 按 Python 码点数分配，astral 字符一符两码元 → 缓冲不足静默截断/越界读）
            raw_utf16 = data.encode('utf-16-le') + b'\x00\x00'
            size = len(raw_utf16)
            head = data[:64]
            wrote_once = False
            for attempt in range(6):
                h = k32.GlobalAlloc(0x0002, size)
                if not h:
                    return ok({'error': '内存分配失败'})
                p = k32.GlobalLock(h)
                if not p:
                    k32.GlobalFree(h)
                    return ok({'error': '内存锁定失败'})
                try:
                    ctypes.memmove(p, raw_utf16, size)
                finally:
                    k32.GlobalUnlock(h)
                if not u32.OpenClipboard(0):
                    k32.GlobalFree(h)
                    _t.sleep(0.06)
                    continue
                ok_set = False
                try:
                    u32.EmptyClipboard()
                    # 修复 W6：SetClipboardData 返回 NULL 时所有权未移交，必须自行 GlobalFree
                    ok_set = bool(u32.SetClipboardData(13, h))
                except Exception:
                    ok_set = False
                if not ok_set:
                    try:
                        u32.CloseClipboard()
                    except Exception:
                        pass
                    k32.GlobalFree(h)
                    _t.sleep(0.06)
                    continue
                wrote_once = True
                u32.CloseClipboard()
                # ---- 回读校验: 等待剪贴板系统完成更新 ----
                for _ in range(6):
                    _t.sleep(0.03)
                    got, _busy = self._clipboard_read()
                    if got is not None and len(got) == len(data) and got[:64] == head:
                        return ok({'ok': True, 'len': len(data),
                                   'verified': True})
            if not wrote_once:
                # 修复 W6：六次全部未写入时返回明确错误（原一律返回"已写入"误导）
                return ok({'error': '剪贴板写入失败（持续被占用或被系统拒绝），请稍后再试'})
            return ok({'ok': True, 'len': len(data), 'verified': False,
                       'note': '已写入但回读校验未通过, 可能被其他程序立即覆盖'})
        except Exception as e:
            return ok({'error': str(e)})
