# -*- coding: utf-8 -*-
"""v1.9.0 M3.3 · win32 窗口捕获（PrintWindow PW_RENDERFULLCONTENT）。

供 DriverWindow.capture_b64 调用（screenshot 原语的通道层实现）：
- PrintWindow + PW_RENDERFULLCONTENT(=2)：WebView2 DirectComposition 渲染
  窗口的正确捕获方式（BitBlt 对 GPU 合成窗口得黑屏）；
- 失败降级 PIL.ImageGrab.grab(bbox=窗口矩形)（窗口被遮挡时截到遮挡物——
  降级口径，肉眼审计可用性优先）；
- 返回 PNG base64 串；全失败 → ''（调用方按结构化降级处理，B8.9）。

纯 Windows ctypes + 可选 PIL（Harbor.spec 已声明 hiddenimports）；
非 Windows / 依赖缺失 → ''（禁异常穿透）。
"""
import base64
import io


def capture_window_b64(hwnd, client_only=True):
    """捕获窗口（或客户区）→ PNG base64 串；失败 ''。

    Args:
        hwnd: 目标窗口句柄（int）。
        client_only: True=客户区（GetClientRect+PW_CLIENTONLY）——screenshot
            原语的 point 坐标系口径；False=整窗含标题栏。
    """
    try:
        return _capture(hwnd, client_only)
    except Exception:
        return ''


def _capture(hwnd, client_only):
    import ctypes
    import ctypes.wintypes as wt

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    if client_only:
        rect = wt.RECT()
        if not user32.GetClientRect(wt.HWND(hwnd), ctypes.byref(rect)):
            return ''
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        # 客户区坐标转屏幕（CreateCompatibleBitmap 用屏幕 DC 尺寸语义）
        pt = wt.POINT(0, 0)
        user32.ClientToScreen(wt.HWND(hwnd), ctypes.byref(pt))
        left, top = pt.x, pt.y
    else:
        rect = wt.RECT()
        if not user32.GetWindowRect(wt.HWND(hwnd), ctypes.byref(rect)):
            return ''
        left, top = rect.left, rect.top
        w = rect.right - rect.left
        h = rect.bottom - rect.top
    if w <= 0 or h <= 0 or w > 8192 or h > 8192:
        return ''

    hdc_window = user32.GetWindowDC(wt.HWND(hwnd))
    if not hdc_window:
        return ''
    hdc_mem = gdi32.CreateCompatibleDC(hdc_window)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_window, w, h)
    old_obj = 0
    try:
        # 保存旧选中对象：DeleteObject 禁止删除仍选入 DC 的位图（静默失败——
        # 每次 1024×768×32bpp ≈3MB 泄漏，AI 驱动循环下 GDI 句柄/内存快速耗尽）
        old_obj = gdi32.SelectObject(hdc_mem, hbmp)
        # PW_CLIENTONLY(1) | PW_RENDERFULLCONTENT(2)——后者 Win 8.1+ 对
        # DirectComposition/Chromium 窗口必需（否则黑屏）
        flags = 3 if client_only else 2
        ok = user32.PrintWindow(wt.HWND(hwnd), hdc_mem, flags)
        if ok:
            # MSDN：GetDIBits 要求位图**未选入** DC——先还原再取像素
            #（选中态调用属未定义行为，可能整帧读失败）
            if old_obj:
                gdi32.SelectObject(hdc_mem, old_obj)
                old_obj = 0
            b64 = _bitmap_to_png_b64(hbmp, w, h)
            if b64:
                return b64
            # PrintWindow 成功但 DIB→PNG 失败（GetDIBits 行数不符/PIL 异常）
            # → 走 ImageGrab 屏幕矩形降级（原实现直接返回 '' 不降级）
            return _grab_fallback(left, top, w, h)
        return _grab_fallback(left, top, w, h)
    finally:
        if old_obj:
            gdi32.SelectObject(hdc_mem, old_obj)   # 先还原再删（Win32 规则）
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(wt.HWND(hwnd), hdc_window)


def _bitmap_to_png_b64(hbmp, w, h):
    """HBITMAP → PNG b64：逐行 GetDIBits 取 BGRA → PIL 编码。"""
    import ctypes
    import ctypes.wintypes as wt
    from PIL import Image

    gdi32 = ctypes.windll.gdi32
    hdc = gdi32.GetDC(None)
    try:
        # 头两问：biSizeImage=0 探测行距
        class _BMI(ctypes.Structure):
            _fields_ = [('biSize', wt.DWORD), ('biWidth', wt.LONG),
                        ('biHeight', wt.LONG), ('biPlanes', wt.WORD),
                        ('biBitCount', wt.WORD), ('biCompression', wt.DWORD),
                        ('biSizeImage', wt.DWORD), ('biXPelsPerMeter', wt.LONG),
                        ('biYPelsPerMeter', wt.LONG), ('biClrUsed', wt.DWORD),
                        ('biClrImportant', wt.DWORD)]

        bmi = _BMI()
        bmi.biSize = ctypes.sizeof(_BMI)
        bmi.biWidth = w
        bmi.biHeight = -h          # top-down（首行=窗口顶部）
        bmi.biPlanes = 1
        bmi.biBitCount = 32
        bmi.biCompression = 0      # BI_RGB
        buf = ctypes.create_string_buffer(w * h * 4)
        got = gdi32.GetDIBits(hdc, hbmp, 0, h, buf, ctypes.byref(bmi), 0)
        if got != h:
            return ''
        img = Image.frombuffer('RGBA', (w, h), buf.raw, 'raw', 'BGRA', 0, 1)
        out = io.BytesIO()
        img.save(out, format='PNG')
        return base64.b64encode(out.getvalue()).decode('ascii')
    finally:
        gdi32.ReleaseDC(None, hdc)


def _grab_fallback(left, top, w, h):
    """降级：PIL.ImageGrab 屏幕矩形（窗口被遮挡时截到遮挡物——降级口径）。"""
    from PIL import ImageGrab
    img = ImageGrab.grab(bbox=(left, top, left + w, top + h))
    out = io.BytesIO()
    img.save(out, format='PNG')
    return base64.b64encode(out.getvalue()).decode('ascii')
