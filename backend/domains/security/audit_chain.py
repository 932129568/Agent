# -*- coding: utf-8 -*-
"""audit_chain：审计条目哈希链（v1.9.0 M2.6 R37，design §A3.6）。

防篡改：每条审计条目链上前条 hash（canonical json 的 sha256）——改任一
历史条目即断链，verify 可检出。存储 ~/.glm-chat/audit_chain.json（独立
文件——sessions.json 是 legacy 逐字节差分面禁污染；前端消费经 get_audit_log
链块）。

算法：canonical = json.dumps(entry, sort_keys=True, ensure_ascii=False,
separators=(',',':'))；hash = sha256(prev_hash ‖ canonical)；genesis
prev_hash = 64 个 '0'。条目先 append 内存链再原子落盘 head（崩溃最多丢
head 更新——verify 从文件实况重建，见 get_audit_log 自愈）。

时间口径（B8.5）：审计 ts 保持既有本地 '%Y-%m-%d %H:%M:%S'（禁改——既有
日志解析依赖）；哈希 canonical 与 ts 格式解耦（链只保完整性不保时区）。
"""
import datetime
import hashlib
import json
import os
import threading

GENESIS_HASH = '0' * 64
CHAIN_FILE_VERSION = 1


def canonical_json(entry):
    """链用规范化序列化（键排序+紧凑分隔符——防键序漂移影响哈希）。"""
    return json.dumps(entry, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'))


def entry_hash(prev_hash, entry):
    """sha256(prev_hash ‖ canonical)——顺序敏感（防条目重排攻击）。"""
    return hashlib.sha256(
        (str(prev_hash or '') + canonical_json(entry)).encode('utf-8')
    ).hexdigest()


def now_local():
    """审计时间戳（既有口径：本地 '%Y-%m-%d %H:%M:%S'——禁改）。"""
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


class AuditChain:
    """审计哈希链（append/verify/head_info；自带锁，原子落盘）。"""

    def __init__(self, path=None, lock=None):
        from ... import paths as _paths
        self._path = path or _paths.AUDIT_CHAIN_FILE
        self._lock = lock or threading.RLock()
        self._head, self._len = self._load_head()

    # ---------------- 持久化 ----------------
    def _load_head(self):
        """读 chain head/len（损坏/缺失 → genesis 重启，不抛）。"""
        try:
            if os.path.exists(self._path):
                with open(self._path, encoding='utf-8') as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    head = str(d.get('head') or GENESIS_HASH)
                    n = int(d.get('len') or 0)
                    return head, max(0, n)
        except Exception:
            pass
        return GENESIS_HASH, 0

    def _save_head(self):
        from ...fio import atomic_write_json
        atomic_write_json(self._path, {'version': CHAIN_FILE_VERSION,
                                       'head': self._head, 'len': self._len,
                                       'updated_at': now_local()})

    # ---------------- 链操作 ----------------
    def append(self, entry):
        """挂一条条目（entry 不含 hash/prev_hash）→ 带链字段的 entry。

        持锁：prev_hash 取当前 head → 计算 hash → 更新 head/len → 原子落盘。
        返回 dict（entry 副本 + prev_hash/hash/ts）。
        """
        if not isinstance(entry, dict):
            raise TypeError('audit chain entry 必须是 dict')
        with self._lock:
            e = dict(entry)
            e.setdefault('ts', now_local())
            prev = self._head
            h = entry_hash(prev, e)
            e['prev_hash'] = prev
            e['hash'] = h
            self._head = h
            self._len += 1
            try:
                self._save_head()
            except Exception:
                # 落盘失败：回滚内存态（链不断——下次 append 重算同 hash）
                self._head = prev
                self._len -= 1
                raise
            return e

    def verify(self, entries):
        """校验条目序列（按时间正序；可只给窗口子集——从首条 prev_hash 起算）。

        逐条重算 prev_hash 衔接 + hash 相等；任一不符 → {ok: False, checked,
        broken_at: {index, ts, op}, reason}。无 hash 字段的旧条目跳过（不计
        checked，不判 broken——前向兼容）。全过 → {ok: True, checked, head, len}。

        复核修正（衔接校验）：原只重算每条自身 hash，从不校验相邻条目
        prev_hash 衔接——从日志删除/重排中间条目后 verify 仍 ok（删除不可
        检出）。现增相邻衔接断言：调用方两种窗口方向（read_audit 倒序窗口 /
        全量正序）按首对相邻 hashed 条目自适应判向，其后逐对校验——被删/
        重排/混入的条目必然在某对上衔接断裂。
        """
        hashed = [(i, e) for i, e in enumerate(entries or [])
                  if isinstance(e, dict) and 'hash' in e]
        checked = 0
        prev_i, prev_e = None, None
        # 方向自适应：正序（后者 prev_hash==前者 hash）或倒序窗口（前者
        # prev_hash==后者 hash）。单对即判向（哈希碰撞前提下面板窗口两向
        # 同时成立的概率可忽略），其后全程按该向校验。
        reverse = False
        if len(hashed) >= 2:
            (i0, e0), (i1, e1) = hashed[0], hashed[1]
            reverse = str(e0.get('prev_hash') or '') == str(e1.get('hash') or '')
        for i, e in hashed:
            body = {k: v for k, v in e.items()
                    if k not in ('hash', 'prev_hash')}
            if entry_hash(e.get('prev_hash'), body) != e.get('hash'):
                return {'ok': False, 'checked': checked,
                        'broken_at': {'index': i, 'ts': e.get('ts'),
                                      'op': e.get('op')},
                        'reason': '条目 %d 哈希不匹配（链断裂/被篡改）' % i}
            if prev_e is not None:
                newer, older = (prev_e, e) if reverse else (e, prev_e)
                ni = prev_i if reverse else i
                if str(newer.get('prev_hash') or '') != str(older.get('hash') or ''):
                    return {'ok': False, 'checked': checked,
                            'broken_at': {'index': ni, 'ts': newer.get('ts'),
                                          'op': newer.get('op')},
                            'reason': '条目 %d 与相邻条目 prev_hash 不衔接'
                                      '（存在删除/重排）' % ni}
            prev_i, prev_e = i, e
            checked += 1
        return {'ok': True, 'checked': checked,
                'head': self._head, 'len': self._len}

    def head_info(self):
        """{ok, head, len, updated_at}（前端只显示首 8 位+省略号——信息密度纪律）。"""
        updated = ''
        try:
            if os.path.exists(self._path):
                with open(self._path, encoding='utf-8') as f:
                    updated = str((json.load(f) or {}).get('updated_at') or '')
        except Exception:
            pass
        return {'ok': True, 'head': self._head, 'len': self._len,
                'updated_at': updated}
