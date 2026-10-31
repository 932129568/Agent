# -*- coding: utf-8 -*-
"""截屏服务（legacy Api L1016-1040 搬迁；PIL 懒加载，无 PIL 环境可 import 本模块）。

修复 W7：多屏 4K 截图 base64 数 MB 经 js_api 桥返回会卡顿——最长边缩到 1920 再编码。
修复 W14：截图永久留存无清理——保留窗口最近 20 张 / 7 天，超限自动删除。
"""
import base64
import datetime
import io
import os
import time

from ... import paths
from ...errors import ok
from ...logging_setup import get_logger

_MAX_SIDE = 1920          # 修复 W7：回传图最长边
_KEEP_COUNT = 20          # 修复 W14：最多保留张数
_KEEP_DAYS = 7            # 修复 W14：最长保留天数


class ScreenshotService:
    def __init__(self):
        self._log = get_logger()

    def take_screenshot(self, left=None, top=None, width=None, height=None):
        """截屏；可传区域 left/top/width/height；存配置目录（不污染工作区）+ 返回 base64 给前端"""
        try:
            from PIL import ImageGrab
            ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]
            shots_dir = paths.SCREENSHOTS_DIR
            os.makedirs(shots_dir, exist_ok=True)
            path = os.path.join(shots_dir, f'screenshot_{ts}.png')
            try:
                if None not in (left, top, width, height):
                    img = ImageGrab.grab(bbox=(int(left), int(top),
                                               int(left) + int(width), int(top) + int(height)),
                                         all_screens=True)
                else:
                    img = ImageGrab.grab(all_screens=True)
            except TypeError:
                img = ImageGrab.grab()
            img.save(path)
            # 修复 W7：超过 1920 的大图先缩放再编码（js_api 桥传数 MB base64 会卡顿）
            try:
                w, h = img.size
                if max(w, h) > _MAX_SIDE:
                    scale = _MAX_SIDE / float(max(w, h))
                    img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
            except Exception as e:
                self._log.debug('截图缩放失败（按原图编码）: %r', e)
            buf = io.BytesIO()
            img.convert('RGB').save(buf, format='JPEG', quality=85)
            b64 = base64.b64encode(buf.getvalue()).decode()
            self._cleanup_old(shots_dir)
            return ok({'ok': True, 'path': path, 'size': img.size,
                       'dataUrl': 'data:image/jpeg;base64,' + b64})
        except Exception as e:
            return ok({'error': str(e) + '（需要 Pillow）'})

    def _cleanup_old(self, shots_dir):
        """修复 W14：保留最近 _KEEP_COUNT 张且不超过 _KEEP_DAYS 天，其余删除。"""
        try:
            files = []
            for fn in os.listdir(shots_dir):
                if not fn.startswith('screenshot_') or not fn.endswith('.png'):
                    continue
                fp = os.path.join(shots_dir, fn)
                try:
                    files.append((os.path.getmtime(fp), fp))
                except Exception:
                    pass
            files.sort(reverse=True)
            now = time.time()
            for i, (mt, fp) in enumerate(files):
                if i >= _KEEP_COUNT or now - mt > _KEEP_DAYS * 86400:
                    try:
                        os.remove(fp)
                    except Exception:
                        pass
        except Exception as e:
            self._log.debug('截图清理失败: %r', e)
