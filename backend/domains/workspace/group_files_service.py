# -*- coding: utf-8 -*-
"""群文件服务（Round 14，2026-11-04 主理人立项）。

需求原文：「群聊多一个群文件功能，他们的交接文档统一放在群文件，并把名字
修改清晰明白，方便后续其他大模型不清楚的时候智能搜索调用，群文件的本地
保存地址可以自定义修改。」

设计要点：
- **交接文档即文件**：每次成员发言解析出的【交接文档】自动归档为一份 .md，
  文件名自带「时间-成员-主题」三段，便于人工翻找与关键词命中。
- **智能搜索**：每份文件头写入结构化元信息（成员/交接对象/主题/关键词），
  检索对「标题 + 元信息 + 正文」加权打分，返回命中片段供模型判断是否需要
  展开全文。零向量依赖——群文件规模是几十份量级，关键词打分足够且可解释。
- **目录可自定义**：配置独立存 `group_files.json`（config.json 零污染铁律），
  空值 = 默认 `~/.glm-chat/group_files`。切换目录不迁移历史文件（提示用户
  自行搬运），避免静默移动用户数据。
- **按群隔离**：每个群聊会话一个子目录，用会话 id 的稳定短哈希，避免同名群
  互相污染；子目录里再放 `_index.json` 供快速列表（缺失则实时重建）。
"""
import json
import os
import re
import time

from ... import paths
from ...errors import err, ok
from ...fio import atomic_write_json, atomic_write_text
from ...logging_setup import get_logger

CONFIG_FILE = os.path.join(paths.CONFIG_DIR, 'group_files.json')
DEFAULT_ROOT = os.path.join(paths.CONFIG_DIR, 'group_files')
INDEX_NAME = '_index.json'
MAX_LIST = 200


def _cfg_load():
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _safe_seg(text, limit=48):
    """文件名/目录名净化：去掉 Windows 非法字符与控制符，压缩空白。"""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', '-', str(text or ''))
    s = re.sub(r'\s+', ' ', s).strip(' .-')
    return s[:limit] or 'untitled'


def _group_dir(root, group_id):
    gid = str(group_id or 'default')
    digest = 0
    for ch in gid:
        digest = (digest * 131 + ord(ch)) % (10 ** 10)
    return os.path.join(root, 'g%s' % digest)


class GroupFilesService:
    """群聊交接文档仓库（落盘 + 索引 + 关键词检索）。"""

    def __init__(self):
        self._log = get_logger()

    # ---------------- 配置 ----------------
    def get_config(self):
        cfg = _cfg_load()
        custom = str(cfg.get('root') or '').strip()
        root = custom or DEFAULT_ROOT
        return ok({
            'root': root,
            'default_root': DEFAULT_ROOT,
            'custom': bool(custom),
            'exists': os.path.isdir(root),
        })

    def save_config(self, cfg_json):
        try:
            data = json.loads(cfg_json or '{}')
        except Exception as e:
            return err('[BAD_PARAMS] 配置不是合法 JSON: %s' % e)
        root = str((data or {}).get('root') or '').strip()
        if root:
            root = os.path.expanduser(os.path.expandvars(root))
            # R37 修复（N6）：root 安全校验（对齐 history_dir_set 的 W6/W9 口径）——
            # 原无 realpath/敏感目录校验，可把群文件根指到 C:\Windows 等并经
            # group_files_write 建目录写文件。
            root = os.path.realpath(os.path.abspath(root))
            sys_root = (os.environ.get('SYSTEMROOT') or 'C:\\Windows') \
                .replace('/', '\\').rstrip('\\') or 'C:\\Windows'
            drive = os.path.splitdrive(sys_root)[0].lower() or 'c:'
            low = root.lower().rstrip('\\/')
            for s in [drive + '\\' + n for n in (
                    'windows', 'program files', 'program files (x86)',
                    'programdata', '$recycle.bin', 'system volume information')] \
                    + [sys_root.lower()]:
                if low == s or low.startswith(s + '\\'):
                    return err('[BAD_PARAMS] 不能使用系统目录：%s' % root)
            try:
                os.makedirs(root, exist_ok=True)
            except Exception as e:
                return err('[BAD_PARAMS] 目录不可用：%s' % e)
            if not os.access(root, os.W_OK):
                return err('[BAD_PARAMS] 目录不可写：%s' % root)
        try:
            atomic_write_json(CONFIG_FILE, {'root': root}, indent=2)
        except Exception as e:
            return err('[IO_ERROR] 配置保存失败：%s' % e)
        return self.get_config()

    def _root(self):
        custom = str(_cfg_load().get('root') or '').strip()
        return custom or DEFAULT_ROOT

    # ---------------- 写入 ----------------
    def write(self, group_id, group_name, member, title, content, meta=None):
        """归档一份交接文档。返回落盘路径与可搜索的索引条目。"""
        body = str(content or '').strip()
        if not body:
            return err('[BAD_PARAMS] 交接文档内容为空')
        root = self._root()
        d = _group_dir(root, group_id)
        try:
            os.makedirs(d, exist_ok=True)
        except Exception as e:
            return err('[IO_ERROR] 群文件目录不可用：%s' % e)
        stamp = time.strftime('%Y%m%d-%H%M%S')
        seq = 1
        base = '%s_%s_%s' % (stamp, _safe_seg(member or '未知成员', 24), _safe_seg(title or '交接', 40))
        path = os.path.join(d, base + '.md')
        while os.path.exists(path):   # 同秒同名：追加序号，绝不覆盖
            seq += 1
            path = os.path.join(d, '%s-%d.md' % (base, seq))
        info = meta if isinstance(meta, dict) else {}
        header = [
            '<!-- harbor-group-file',
            'group: %s' % (group_name or group_id or ''),
            'member: %s' % (member or ''),
            'to: %s' % (info.get('to') or ''),
            'title: %s' % (title or ''),
            'keywords: %s' % (info.get('keywords') or ''),
            'round: %s' % (info.get('round') or ''),
            'created: %s' % time.strftime('%Y-%m-%d %H:%M:%S'),
            '-->',
            '',
        ]
        text = '\n'.join(header) + body + '\n'
        try:
            atomic_write_text(path, text)
        except Exception as e:
            return err('[IO_ERROR] 写入失败：%s' % e)
        entry = {
            'path': path,
            'name': os.path.basename(path),
            'group': group_name or group_id or '',
            'member': member or '',
            'to': info.get('to') or '',
            'title': title or '',
            'keywords': info.get('keywords') or '',
            'round': info.get('round') or '',
            'size': len(text.encode('utf-8')),
            'mtime': time.time(),
        }
        self._index_upsert(d, entry)
        return ok(entry)

    def _index_upsert(self, group_dir, entry):
        path = os.path.join(group_dir, INDEX_NAME)
        items = []
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                items = data
        except Exception:
            items = []
        items = [x for x in items if x.get('name') != entry.get('name')]
        items.append(entry)
        items.sort(key=lambda x: x.get('mtime') or 0)
        try:
            atomic_write_json(path, items[-MAX_LIST:])
        except Exception as e:
            self._log.warning('群文件索引写入失败: %r', e)

    # ---------------- 列举 ----------------
    def list(self, group_id, group_name=None, limit=MAX_LIST):
        root = self._root()
        d = _group_dir(root, group_id)
        if not os.path.isdir(d):
            return ok({'root': root, 'dir': d, 'files': []})
        items = []
        try:
            with open(os.path.join(d, INDEX_NAME), 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                items = [x for x in data if x.get('path') and os.path.isfile(x['path'])]
        except Exception:
            items = []
        if not items:   # 索引缺失/过期 → 实时扫盘重建
            for fn in os.listdir(d):
                if not fn.endswith('.md'):
                    continue
                fp = os.path.join(d, fn)
                try:
                    st = os.stat(fp)
                except Exception:
                    continue
                head = self._read_head(fp)
                items.append({
                    'path': fp, 'name': fn, 'group': group_name or '',
                    'member': head.get('member', ''), 'to': head.get('to', ''),
                    'title': head.get('title', ''), 'keywords': head.get('keywords', ''),
                    'round': head.get('round', ''), 'size': st.st_size, 'mtime': st.st_mtime,
                })
            items.sort(key=lambda x: x.get('mtime') or 0)
            try:
                atomic_write_json(os.path.join(d, INDEX_NAME), items[-MAX_LIST:])
            except Exception:
                pass
        files = items[-int(limit or MAX_LIST):]
        files.reverse()   # 最新在前
        return ok({'root': root, 'dir': d, 'files': files})

    @staticmethod
    def _read_head(path, limit=1200):
        meta = {}
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                head = f.read(limit)
        except Exception:
            return meta
        m = re.search(r'<!--\s*harbor-group-file([\s\S]*?)-->', head)
        if not m:
            return meta
        for line in m.group(1).splitlines():
            if ':' in line:
                k, v = line.split(':', 1)
                meta[k.strip()] = v.strip()
        return meta

    # ---------------- 删除 ----------------
    def delete(self, group_id, name):
        """删除一份群文件（必须位于该群的子目录内——防路径逃逸）。

        索引同步摘除；_index.json 刷新失败不阻断删除（下次 list 会重建）。
        """
        fname = os.path.basename(str(name or ''))
        if not fname.endswith('.md') or fname in ('.', '..'):
            return err('[BAD_PARAMS] 文件名不合法')
        d = _group_dir(self._root(), group_id)
        path = os.path.join(d, fname)
        # 双保险：realpath 必须仍在群子目录内
        try:
            if os.path.realpath(d) not in os.path.realpath(path):
                return err('[BAD_PARAMS] 路径越界')
        except Exception:
            pass
        if not os.path.isfile(path):
            return err('[NOT_FOUND] 文件不存在或已删除')
        try:
            os.remove(path)
        except Exception as e:
            return err('[IO_ERROR] 删除失败：%s' % e)
        # 索引摘除
        try:
            idx = os.path.join(d, INDEX_NAME)
            with open(idx, 'r', encoding='utf-8') as f:
                items = json.load(f)
            if isinstance(items, list):
                items = [x for x in items if x.get('name') != fname]
                atomic_write_json(idx, items[-MAX_LIST:])
        except Exception:
            pass
        return ok({'ok': True, 'name': fname})

    # ---------------- 打开目录 ----------------
    def open_dir(self, group_id=None):
        """在资源管理器中打开群文件目录（根目录或指定群的子目录）。

        只开本服务自管的目录（root/group_files 与其群子目录），不收任意路径——
        面窄到无需 guard 档确认。目录不存在时先建（用户点按钮就该看到文件夹）。
        """
        root = self._root()
        d = _group_dir(root, group_id) if group_id else root
        if not os.path.isdir(d):
            try:
                os.makedirs(d, exist_ok=True)
            except Exception as e:
                return err('[IO_ERROR] 目录创建失败：%s' % e)
        try:
            os.startfile(d)   # Windows 桌面应用专属；非 win 平台报错即返回
        except Exception as e:
            return err('[IO_ERROR] 无法打开目录：%s' % e)
        return ok({'ok': True, 'dir': d})

    # ---------------- 检索 ----------------
    def search(self, group_id, query, limit=8):
        """关键词检索：标题/成员/交接对象/关键词/正文加权打分。

        返回每条的命中片段（正文 ±120 字），让模型先看摘要再决定读全文——
        群文件是给人看的 .md，模型用 read_file 打开即可。
        """
        q = str(query or '').strip()
        if not q:
            return err('[BAD_PARAMS] 搜索关键词为空')
        listed = json.loads(self.list(group_id, limit=MAX_LIST) or '{}')
        if not isinstance(listed, dict) or listed.get('error'):
            return err('[IO_ERROR] 群文件列表读取失败：%s' % (listed or ''))
        files = listed.get('files') or []
        terms = [t for t in re.split(r'[\s,，。;；、]+', q.lower()) if t]
        hits = []
        for item in files:
            try:
                with open(item['path'], 'r', encoding='utf-8', errors='replace') as f:
                    text = f.read()
            except Exception:
                continue
            lowered = text.lower()
            name_l = (item.get('name') or '').lower()
            title_l = (item.get('title') or '').lower()
            kw_l = (item.get('keywords') or '').lower()
            member_l = (item.get('member') or '').lower()
            score = 0
            for t in terms:
                if t in title_l:
                    score += 6
                if t in kw_l:
                    score += 5
                if t in member_l:
                    score += 3
                if t in name_l:
                    score += 3
                score += min(6, lowered.count(t))
            if score <= 0:
                continue
            snippet = self._snippet(re.sub(r'<!--[\s\S]*?-->', '', text, count=1), terms)
            hits.append({
                'name': item.get('name'), 'path': item.get('path'),
                'title': item.get('title'), 'member': item.get('member'),
                'to': item.get('to'), 'keywords': item.get('keywords'),
                'mtime': item.get('mtime'), 'score': score, 'snippet': snippet,
            })
        hits.sort(key=lambda x: (-x['score'], -(x.get('mtime') or 0)))
        return ok({'query': q, 'count': len(hits), 'hits': hits[:int(limit or 8)]})

    @staticmethod
    def _snippet(text, terms, width=120):
        low = text.lower()
        pos = -1
        for t in terms:
            p = low.find(t)
            if p >= 0 and (pos < 0 or p < pos):
                pos = p
        if pos < 0:
            return text[:width * 2].replace('\n', ' ').strip()
        start = max(0, pos - width // 2)
        return ('…' if start > 0 else '') + text[start:start + width].replace('\n', ' ').strip() + '…'
