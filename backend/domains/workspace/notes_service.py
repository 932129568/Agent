# -*- coding: utf-8 -*-
"""NotesService：会话结构化笔记（R42，F2d 改法②「文件系统即上下文」）。

压缩（compact）生成的工作纪要除注入上下文外，同步落盘为
~/.glm-chat/notes/<sid>.md——跨压缩/跨重启持久；恢复（继续任务/恢复横幅）
时由前端经 notes_get 读回注入系统段。config.json 零污染（独立 notes/ 目录）。
"""
import os
import re
import threading

from ... import paths
from ...errors import err, ok
from ...logging_setup import get_logger
from ...fio import atomic_write_text


class NotesService:
    """按 sid 一文件的追加式笔记（原子写 + 尾部截断上限）。"""

    MAX_CHARS = 64 * 1024          # 单会话笔记上限（约 3 万汉字；超出截尾保留）
    _SID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')

    def __init__(self, logger=None):
        self._log = logger or get_logger()
        self._lock = threading.Lock()

    def _path(self, sid):
        sid = str(sid or '').strip()
        if not self._SID_RE.match(sid):
            raise ValueError('sid 非法（仅限字母数字 _ -）')
        return os.path.join(paths.NOTES_DIR, sid + '.md')

    def append(self, sid, text):
        """追加一段纪要（带时间戳分隔；超限截尾保尾）。"""
        body = str(text or '').strip()
        if not body:
            return err('[BAD_PARAMS] 笔记内容为空')
        try:
            path = self._path(sid)
        except ValueError as e:
            return err('[BAD_PARAMS] %s' % e)
        import time
        stamp = time.strftime('%Y-%m-%d %H:%M:%S')
        with self._lock:
            try:
                os.makedirs(paths.NOTES_DIR, exist_ok=True)
                prev = ''
                if os.path.exists(path):
                    with open(path, encoding='utf-8') as f:
                        prev = f.read()
                merged = (prev + ('\n\n' if prev else '') +
                          '## ' + stamp + '\n' + body + '\n')
                if len(merged) > self.MAX_CHARS:
                    merged = merged[-self.MAX_CHARS:]
                    merged = merged[merged.index('\n') + 1:]   # 掐半行
                atomic_write_text(path, merged)
            except Exception as e:
                return err('[IO_ERROR] 笔记写入失败：%s' % e)
        return ok({'ok': True, 'path': path, 'chars': len(merged)})

    def get(self, sid):
        try:
            path = self._path(sid)
        except ValueError as e:
            return err('[BAD_PARAMS] %s' % e)
        try:
            with open(path, encoding='utf-8') as f:
                return ok({'ok': True, 'text': f.read()})
        except OSError:
            return ok({'ok': True, 'text': ''})

    def delete(self, sid):
        """会话清除（session_purge 钩子）时删笔记文件，不留孤儿。"""
        try:
            path = self._path(sid)
        except ValueError:
            return ok({'ok': True})
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            self._log.warning('notes 删除失败 sid=%s: %r', sid, e)
        return ok({'ok': True})
