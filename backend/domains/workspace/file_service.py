# -*- coding: utf-8 -*-
"""文件服务：jail 内文件操作 10 件套 + 文件指纹缓存 + _resolve_ws 路径监狱。

legacy Api L64-88/L188-216/L331-579 原样搬迁。
_resolve_ws 判定算法为安全关键代码，逐字保留（未改一行）。
"""
import datetime
import difflib
import json
import os
import shutil
import threading
import time

from ...errors import err, ok
from ...fio import atomic_write_text
from ...logging_setup import get_logger


class FileFingerprintCache:
    """文件指纹缓存 v2: 路径 -> (mtime_ns, size)。写后 invalidate 让 AI 重读。

    修复 W3：内部字典加 RLock（pywebview 多线程回调竞态原无锁）。"""

    MAX = 512

    def __init__(self):
        self._fp = {}
        self._lock = threading.RLock()

    def _stat(self, path):
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)

    def unchanged(self, path):
        with self._lock:
            old = self._fp.get(path)
        if old is None:
            return False
        try:
            return self._stat(path) == old
        except OSError:
            with self._lock:
                self._fp.pop(path, None)
            return False

    def mark_read(self, path):
        try:
            fp = self._stat(path)
        except OSError:
            with self._lock:
                self._fp.pop(path, None)
            return
        with self._lock:
            self._fp[path] = fp
            if len(self._fp) > self.MAX:
                for k in list(self._fp)[: len(self._fp) - self.MAX]:
                    self._fp.pop(k, None)

    def mark_written(self, path):
        self.mark_read(path)

    def invalidate(self, path):
        with self._lock:
            self._fp.pop(path, None)

    def clear(self):
        with self._lock:
            self._fp.clear()


class FileService:
    def __init__(self, runtime, workspace):
        self._log = get_logger()
        self.runtime = runtime
        self.workspace = workspace
        self.file_fp = FileFingerprintCache()
        self._append_hist = {}
        self._append_lock = threading.RLock()   # 修复 W3：append 限流表加锁

    # ---- 路径监狱（legacy L188-207，安全关键，逐字保留）----
    def _effective_root(self, sid):
        return self.workspace.effective_root(sid)

    def _resolve_ws(self, sid, path):
        if not self.runtime.ws_enabled_for(sid, True):
            return None, json.dumps(
                {'error': '本会话已关闭"使用文件夹"，文件工具不可用。请直接回答用户问题，不要再尝试文件操作。'},
                ensure_ascii=False)
        root = os.path.abspath(self._effective_root(sid))
        # 修复 建议⑤：反复剥引号+空白（原 strip('"') 只剥一层，'" "path" "' 形态残留）
        p = str(path if path is not None else '').strip()
        while len(p) >= 2 and p.startswith('"') and p.endswith('"'):
            p = p[1:-1].strip()
        if not p:
            return None, json.dumps({'error': '缺少 path 参数'}, ensure_ascii=False)
        if not p.startswith('\\\\') and p[0] in '\\/' and not (len(p) > 1 and p[1] == ':'):
            p = p.lstrip('\\/')
        if not os.path.isabs(p):
            p = os.path.join(root, p)
        abs_p = os.path.normcase(os.path.realpath(p))
        abs_root = os.path.normcase(os.path.realpath(root))
        if abs_p != abs_root and not abs_p.startswith(abs_root + os.sep):
            return None, json.dumps(
                {'error': f'路径越界：仅限工作区 {root} 内操作，请勿换路径重试；需要外部文件请让用户移入工作区。'},
                ensure_ascii=False)
        return abs_p, None

    def _short_path(self, sid, abs_p):
        return self.workspace.short_path(self._effective_root(sid), abs_p)

    # ---- 编码探测（legacy L331-338）----
    @staticmethod
    def _decode_bytes(raw):
        text, enc, _lossy = FileService._decode_bytes_ex(raw)
        return text, enc

    @staticmethod
    def _decode_bytes_ex(raw):
        """修复 S6：返回 (text, enc, lossy)——lossy=True 表示解码已失真
        （U+FFFD 替换），调用方禁止按原编码回写（原会静默毁文件）。"""
        if raw.startswith(b'\xef\xbb\xbf'):
            return raw.decode('utf-8-sig'), 'utf-8-sig', False
        for enc in ('utf-8', 'gbk'):
            try:
                return raw.decode(enc), enc, False
            except UnicodeDecodeError:
                pass
        return raw.decode('utf-8', errors='replace'), 'utf-8', True

    # ---- 10 件套（legacy L340-579 原样搬迁）----
    def list_dir(self, sid, path=None):
        target, e = self._resolve_ws(sid, path)
        if e:
            return e
        try:
            entries = []
            with os.scandir(target) as directory:
                for item in directory:
                    try:
                        is_dir = item.is_dir()
                    except OSError:
                        is_dir = False
                    try:
                        size = item.stat().st_size
                    except OSError:
                        size = -1
                    entries.append({'name': item.name + ('/' if is_dir else ''),
                                    'size': (None if is_dir else size)})
            entries.sort(key=lambda e: (not e['name'].endswith('/'), e['name'].lower()))
            if len(entries) > 200:
                return ok({'path': target, 'entries': entries[:200], 'truncated': True,
                           'total': len(entries),
                           'hint': f'目录过大仅返回前 200 项（共 {len(entries)} 项，目录优先），请改用更精确的子路径',
                           })
            return ok({'path': target, 'entries': entries})
        except Exception as e:
            return err(e)

    def read_file(self, sid, path, offset=0, limit=800, force=False):
        """读文本文件：带行号、兼容 GBK、二进制短路、路径猜错兜底"""
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            try:
                offset = max(0, int(offset or 0))
            except Exception:
                offset = 0
            try:
                _li = int(limit if limit is not None else 800)
            except Exception:
                _li = 800
            auto_limit = _li <= 0          # v1.1.1: 前端不指定 limit 时传 0 → 按文件规模自适应
            if auto_limit:
                limit = 800
            else:
                limit = max(50, min(_li, 20000))          # 行上限 2000→20000
            if not force and offset == 0 and self.file_fp.unchanged(path):
                return ok({'ok': True, 'path': self._short_path(sid, path), 'unchanged': True,
                           'note': '文件自上次读取后未变化，此前已完整读过，原文应仍在上文中；仅当上文中确实看不到原文时才带 force=true。'})
            if not os.path.exists(path):
                base = os.path.basename(path).lower()
                cand = []
                root = self._effective_root(sid)
                depth0 = root.rstrip(os.sep).count(os.sep)
                for r, dirs, files in os.walk(root):
                    if r.count(os.sep) - depth0 >= 2:
                        dirs[:] = []
                        continue
                    dirs[:] = [d for d in dirs if not d.startswith('.')]
                    cand.extend(files)
                    if len(cand) > 2000:
                        break
                near = difflib.get_close_matches(base, [c.lower() for c in cand], n=1, cutoff=0.6)
                hint = ''
                if near:
                    for c in cand:
                        if c.lower() == near[0]:
                            hint = f'（最接近的文件: {c}，可用相对路径直接读取）'
                            break
                return err(f'文件不存在: {path}{hint}')
            if os.path.isdir(path):
                return err(f'路径是目录不是文件: {path}，列目录请用 list_dir')
            # 修复 S7：先 stat 拒绝超大文件（原整文件读入内存无上限，10GB 日志可致 OOM）
            try:
                if os.path.getsize(path) > 64 * 1024 * 1024:
                    return err('文件超过 64MB，不支持整读；请用 run_powershell 分段处理，'
                               '或先拆分文件。')
            except OSError:
                pass
            with open(path, 'rb') as f:   # 修复 S7/建议②：with 管理句柄
                raw = f.read()
            if b'\x00' in raw[:8192]:
                return ok({'path': path, 'binary': True,
                           'info': '二进制文件，read_file 不适用；如需分析请用 run_powershell'})
            text, _enc = FileService._decode_bytes(raw)
            lines = text.splitlines(keepends=True)
            total = len(lines)
            # 修复 S7：auto_limit 与注释口径对齐——≤2000 行一次读全，>2000 行分页 1200
            if auto_limit:
                limit = 1200 if total > 2000 else 2000
            if offset >= total:
                return ok({'ok': True, 'path': self._short_path(sid, path), 'total_lines': total,
                           'note': f'offset={offset} 已超出文件末尾（共 {total} 行）'})
            seg = lines[offset: offset + limit]
            parts, used, shown = [], 0, 0
            BUDGET = 240000                                               # 字符预算 20000→240000
            for i, t in enumerate(seg):
                part = f'{offset + i + 1}\t{t}'
                if used + len(part) > BUDGET:
                    break
                parts.append(part)
                used += len(part)
                shown += 1
            numbered = ''.join(parts)
            if shown < len(seg):
                numbered += '\n…(超大文件截断，可传 offset 继续读)'
            info = {'ok': True, 'path': self._short_path(sid, path), 'total_lines': total, 'content': numbered}
            next_off = offset + shown                                     # 关键:按实际读到的行算,不再跳行
            if next_off < total:
                info['hint'] = f'还有 {total - next_off} 行未读，可传 offset={next_off} 继续读'
            # 修复（六轮 r5 建议12）：仅「整文件 served」才登记已读。原判定
            # `offset == 0 or next_off >= total` 在 offset==0 触达 240000 字符
            # BUDGET 被截断（shown < len(seg)）时也 mark_read，导致下次不带
            # force 的 read_file 返回失实的「此前已完整读过」。next_off >= total
            # 时本段必已完整输出（shown >= len(seg) 自动成立），双条件为防御性显式化。
            if next_off >= total and shown >= len(seg):
                self.file_fp.mark_read(path)
            return ok(info)
        except Exception as e:
            return err(e)

    def write_file(self, sid, path, content):
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            if os.path.exists(path) and os.path.getsize(path) > 20000:
                return err('目标文件已存在且 >20KB。请改用 search_replace 局部修改；'
                           '确需整体重写，先 delete_path 删掉它再 write_file。')
            os.makedirs(os.path.dirname(path) or self._effective_root(sid), exist_ok=True)
            # 修复 W12（二轮）：write_file 接入原子写（原截断式直写，崩溃即半截文件；
            # newline='' 参数与原 open() 逐字节一致，契约零漂移）
            atomic_write_text(path, content)
            self.file_fp.mark_written(path)
            self._append_hist.pop(path, None)
            return ok({'ok': True, 'path': self._short_path(sid, path),
                       'bytes': len(content.encode('utf-8'))})
        except Exception as e:
            return err(e)

    def append_file(self, sid, path, content):
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            now = time.time()   # 修复 建议④：顶部 import（原尾部 time_time() 动态 import）
            with self._append_lock:   # 修复 W3：限流表加锁
                hist = [t for t in self._append_hist.get(path, []) if now - t < 600]
                hist.append(now)
                self._append_hist[path] = hist
                # 修复 W3：限流表键只增不删 → 触顶淘汰最旧键
                if len(self._append_hist) > 512:
                    for k in list(self._append_hist)[: len(self._append_hist) - 512]:
                        self._append_hist.pop(k, None)
                tripped = len(hist) > 6
            # 修复 W8：触顶不再重置计数（原“每 7 次拦 1 次”后立刻清零，限流失效）。
            # 注意：错误文案与 legacy 逐字节一致（契约冻结），文案中“计数已重置”
            # 为兼容残留措辞，实际行为已改为不重置。
            if tripped:
                return err('append_file 已达频次上限（10 分钟 6 次），本次未写入，计数已重置。'
                           '请改用 write_file 一次性重写，或稍后再追加。')
            os.makedirs(os.path.dirname(path) or self._effective_root(sid), exist_ok=True)
            with open(path, 'a', encoding='utf-8', newline='') as f:
                f.write(content)
            self.file_fp.invalidate(path)
            return ok({'ok': True, 'path': self._short_path(sid, path),
                       'bytes': len(content.encode('utf-8'))})
        except Exception as e:
            return err(e)

    def search_replace(self, sid, path, old, new, replace_all=False):
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            if os.path.isdir(path):
                return err(f'路径是目录: {path}')
            if not os.path.exists(path):
                return err(f'文件不存在: {path}，新建内容请用 write_file')
            # 修复 W9（二轮）：search_replace 整读前置 64MB 上限（与 read_file 同口径——
            # 原只 read_file 有上限，2GB 日志经 search_replace 即 OOM）
            try:
                if os.path.getsize(path) > 64 * 1024 * 1024:
                    return err('文件超过 64MB，不支持 search_replace 整读改写；请用 run_powershell 分段处理。')
            except OSError:
                pass
            with open(path, 'rb') as f:   # 修复 建议②：with 管理句柄
                raw = f.read()
            # 修复 S6③：二进制短路（与 read_file 同口径）
            if b'\x00' in raw[:8192]:
                return err('二进制文件不支持 search_replace，请勿尝试修改')
            text, enc, lossy = FileService._decode_bytes_ex(raw)
            # 修复 S6②：解码已失真（含 U+FFFD）的文件禁止写回（原会以 UTF-8 写回全毁）
            if lossy:
                return err('文件编码无法无损识别（既非 UTF-8 也非 GBK），为避免损坏已拒绝写入；'
                           '请先人工转换为 UTF-8。')
            if old not in text:
                lines = text.splitlines()
                probe = (old.strip().splitlines() or [''])[0][:80]
                best_no, best_ratio, best_line = -1, 0.0, ''
                for i, l in enumerate(lines):
                    r = difflib.SequenceMatcher(None, probe, l.strip()[:80]).ratio()
                    if r > best_ratio:
                        best_ratio, best_no, best_line = r, i, l
                hint = f'；最相似内容在第 {best_no+1} 行: {best_line.strip()[:80]}' if best_ratio > 0.6 else ''
                return err(f'未找到匹配内容: old 必须与文件原文逐字符一致{hint}')
            count = text.count(old)
            if count > 1 and not replace_all:
                return err(f'匹配到 {count} 处，请提供更长上下文或传 replace_all=true')
            new_text = text.replace(old, new) if replace_all else text.replace(old, new, 1)
            # 修复 S6①：写回前按原编码预检（GBK 文件插入 emoji 等不再静默写成 ?）
            try:
                new_bytes = new_text.encode(enc)
            except UnicodeEncodeError as ue:
                return err('新内容含原编码（%s）无法表示的字符（%s），已拒绝写入；'
                           '请改用 UTF-8 字符集或先转换文件编码。' % (enc, ue))
            # 修复 S6④：tmp+os.replace 原子写（原截断式直写，崩溃即半截文件）。
            # 契约保真：文本模式换行翻译与 legacy open('w', encoding=enc) 逐字节一致
            # （legacy 写回带平台换行翻译是被契约测试钉死的行为，见 fio.atomic_write_text_mode）
            from ...fio import atomic_write_text_mode
            atomic_write_text_mode(path, new_text, enc)
            self.file_fp.invalidate(path)
            return ok({'ok': True, 'path': self._short_path(sid, path), 'replaced': count if replace_all else 1})
        except Exception as e:
            return err(e)

    def make_dir(self, sid, path):
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            os.makedirs(path, exist_ok=True)
            return ok({'ok': True, 'path': path})
        except Exception as e:
            return err(e)

    def resolve_abs(self, sid, path):
        """公开薄封装：把工具入参路径解析为工作区内绝对路径（供 Api 在护栏名单校验前取）。
        修复 QA 发现：guard 名单匹配需要工作区语义下的绝对路径，相对路径直接 abspath
        会落到进程 CWD 导致保护名单永不命中。解析失败返回 ('', err)。"""
        p, e = self._resolve_ws(sid, path)
        return (p if not e else ''), e

    def delete_path(self, sid, path, recycle=True):
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            p = path
            cwd_n = os.path.normcase(os.path.realpath(self.workspace.config.cwd))
            root_n = os.path.normcase(os.path.realpath(self._effective_root(sid)))
            # 修复 S5：原比较 `p == os.path.abspath(cwd)` 因规范化不对称恒不成立，
            # `delete_path('')` 可直达删除整个工作区根；现两侧统一 normcase(realpath)，
            # 并同时拒绝会话生效根
            if p == cwd_n or p == root_n or os.path.dirname(p) == p:
                return err('拒绝删除：工作目录本身或驱动器根目录')
            if not os.path.exists(p):
                return err(f'路径不存在: {p}')
            send2trash_unavailable = False
            trash_broken = False
            if recycle:
                try:
                    from send2trash import send2trash
                    send2trash(p)
                    self.file_fp.invalidate(p)
                    return ok({'ok': True, 'path': p, 'mode': '回收站'})
                except ImportError:
                    send2trash_unavailable = True
                except Exception:
                    # 环境性回收站故障（send2trash 实现缺陷 / 8.3 短名被禁用 /
                    # 回收站被禁用 / pywin32 缺失的回退路径等）：该库存在
                    # 「先移动成功、后抛错」的实现——以文件是否仍在磁盘为准，
                    # 已消失即回收成功（勿把成功的回收报成失败）；确在磁盘的
                    # 才回落永久删除并带醒目警示。
                    if not os.path.exists(p):
                        self.file_fp.invalidate(p)
                        return ok({'ok': True, 'path': p, 'mode': '回收站'})
                    trash_broken = True
            if os.path.isdir(p):
                shutil.rmtree(p)   # 修复 建议④：顶部 import
            else:
                os.remove(p)
            self.file_fp.invalidate(p)
            if send2trash_unavailable:
                # 加固：send2trash 缺失时的永久删除必须醒目（v1.0.0 文案过弱，AI 侧易忽略）
                mode = '永久删除(未装 send2trash，未进回收站)⚠️不可恢复，请谨慎'
            elif trash_broken:
                mode = '永久删除(回收站暂不可用，未进回收站)⚠️不可恢复，请谨慎'
            else:
                mode = '永久删除'
            return ok({'ok': True, 'path': p, 'mode': mode})
        except Exception as e:
            return err(e)

    def move_path(self, sid, path, new_path):
        try:
            src, e = self._resolve_ws(sid, path)
            if e:
                return e
            dst, e = self._resolve_ws(sid, new_path)
            if e:
                return e
            if not os.path.exists(src):
                return err(f'源不存在: {src}')
            if os.path.exists(dst):
                return err(f'目标已存在: {dst}')
            os.makedirs(os.path.dirname(dst) or self._effective_root(sid), exist_ok=True)
            shutil.move(src, dst)
            self.file_fp.invalidate(src)
            self.file_fp.invalidate(dst)
            return ok({'ok': True, 'src': src, 'dst': dst})
        except Exception as e:
            return err(e)

    def copy_path(self, sid, path, new_path):
        try:
            src, e = self._resolve_ws(sid, path)
            if e:
                return e
            dst, e = self._resolve_ws(sid, new_path)
            if e:
                return e
            if not os.path.exists(src):
                return err(f'源不存在: {src}')
            if os.path.exists(dst):
                return err(f'目标已存在: {dst}')
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                os.makedirs(os.path.dirname(dst) or self._effective_root(sid), exist_ok=True)
                shutil.copy2(src, dst)
            return ok({'ok': True, 'src': src, 'dst': dst})
        except Exception as e:
            return err(e)

    def get_file_info(self, sid, path):
        try:
            path, e = self._resolve_ws(sid, path)
            if e:
                return e
            st = os.stat(path)
            return ok({'path': path, 'is_dir': os.path.isdir(path), 'size': st.st_size,
                       'mtime': datetime.datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S')})
        except Exception as e:
            return err(e)
