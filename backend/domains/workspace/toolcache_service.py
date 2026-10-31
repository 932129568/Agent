# -*- coding: utf-8 -*-
"""大工具输出落盘分页服务（legacy Api L144-164/L1049-1067 搬迁）。

修复：_TOOLCACHE_MEM 不再借用 _WS_LOCK（legacy 锁名误导，两个不相关关注点共用一把锁），
改用自身锁。
修复 S10：① 淘汰只 pop 内存映射、磁盘 .txt 永不删除 → 淘汰时同步删文件 +
启动时清理超期缓存文件；② `sorted(self._mem)[0]` 字符串序错乱（'tc10_x' < 'tc2_x'）
→ OrderedDict + popitem(last=False) 按插入序淘汰最旧。
"""
import collections
import json
import os
import time

from ... import paths
from ...errors import ok
from ...fio import atomic_write_text
from ...logging_setup import get_logger

_MAX_ENTRIES = 40
_STALE_SECONDS = 24 * 3600        # 启动清理：超过 24h 的缓存文件视为过期


class ToolcacheService:
    def __init__(self, do_cleanup=True):
        self._log = get_logger()
        self._mem = collections.OrderedDict()   # 修复 S10②：插入序淘汰
        self._seq = [0]
        import threading
        self._lock = threading.RLock()
        if do_cleanup:
            self._cleanup_stale()

    def _cleanup_stale(self):
        """修复 S10①：启动时清理超期/无主的缓存文件（原磁盘无限膨胀）。"""
        try:
            d = paths.TOOLCACHE_DIR
            if not os.path.isdir(d):
                return
            now = time.time()
            for fn in os.listdir(d):
                if not fn.endswith('.txt'):
                    continue
                fp = os.path.join(d, fn)
                try:
                    if now - os.path.getmtime(fp) > _STALE_SECONDS:
                        os.remove(fp)
                except Exception:
                    pass
        except Exception as e:
            self._log.debug('toolcache 启动清理失败: %r', e)

    def cache(self, content):
        """legacy _cache_output：返回 cache_id，失败返回 ''。"""
        try:
            os.makedirs(paths.TOOLCACHE_DIR, exist_ok=True)
            with self._lock:
                self._seq[0] += 1
                n = self._seq[0]
            cid = 'tc%d_%d' % (n, int(time.time()))
            fp = os.path.join(paths.TOOLCACHE_DIR, cid + '.txt')
            atomic_write_text(fp, str(content or ''))
            with self._lock:
                self._mem[cid] = fp
                while len(self._mem) > _MAX_ENTRIES:
                    _old_cid, old_fp = self._mem.popitem(last=False)
                    # 修复 S10①：淘汰同步删磁盘文件（原只 pop 内存映射）
                    try:
                        if os.path.exists(old_fp):
                            os.remove(old_fp)
                    except Exception:
                        pass
            return cid
        except Exception as e:
            self._log.warning('toolcache 落盘失败: %r', e)
            return ''

    def read_more(self, cache_id, offset=0, limit=400):
        try:
            with self._lock:
                fp = self._mem.get(str(cache_id or ''))
            if not fp or not os.path.exists(fp):
                return ok({'error': '缓存不存在或已清理，请重新执行原命令获取'})
            # 修复 建议⑯（二轮）：查映射与读文件两步间可能被淘汰删文件
            # （并发 read_more vs 淘汰）——FileNotFoundError 转友好错误而非裸异常串
            try:
                with open(fp, 'r', encoding='utf-8') as f:
                    lines = f.read().splitlines()
            except FileNotFoundError:
                return ok({'error': '缓存不存在或已清理，请重新执行原命令获取'})
            off = max(0, int(offset or 0))
            lim = max(20, min(int(limit or 400), 2000))
            part = lines[off:off + lim]
            if not part:
                return ok({'error': f'offset 超出范围，共 {len(lines)} 行'})
            body = '\n'.join(part)
            if off + lim < len(lines):
                body += ('\n…[第 %d-%d 行 / 共 %d 行；续读 read_more(cache_id="%s", offset=%d)]'
                         % (off + 1, off + len(part), len(lines), cache_id, off + len(part)))
            return ok({'ok': True, 'total_lines': len(lines), 'content': body})
        except Exception as e:
            return ok({'error': str(e)})
