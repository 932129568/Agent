# -*- coding: utf-8 -*-
"""MemoryDbService：SQLite 四层记忆库门面（R38，渐进增强层）。

设计红线（R36 开发文档 §8）：
- **legacy 契约零漂移**：get_memory/append_memory/memory_delete/memory_retrieve
  四个 legacy js_api 继续走 memory.json（MemoryService），本服务不接管它们；
- **渐进增强**：memory.db 为新能力层（双时间戳事实/派生视图/写入门控/审计/统计），
  agent_memory 不可导入（如打包缺件）时本服务整体降级为不可用（enabled=False），
  一切调用方回落 legacy，聊天主链路零风险；
- **迁移与镜像**：首启把 memory.json 条目导入 db（`legacy:` 前缀命名空间，
  绕过写入门控——legacy 数据是用户显式写入）；legacy 文件变化（mtime+长度指纹）
  时重建 `legacy:` 命名空间，legacy 面板的删除/新增如实传播；用户新写入
  （remember()/memory_remember）不落 `legacy:` 命名空间，不受重建影响；
- **config.json 零污染**：库文件=MEMORY_DB_PATH（paths.py 独立常量）。
"""
import os
import threading

from ... import paths

# legacy 条目在本库的命名空间前缀（profile key / fact attribute）
LEGACY_ATTR = 'legacy_note'
LEGACY_KEY_PREFIX = 'legacy:'

# legacy 同步指纹：mtime_ns + 长度即可敏感捕获增删改（内容逐条 diff 不必要）


class MemoryDbService:
    """包装 agent_memory.memory_store.MemoryManager（单实例、WAL、线程安全门）。

    enabled=False = agent_memory 不可用（打包缺件/导入异常），一切方法安全返回
    空结果——调用方无需判断存在性。
    """

    def __init__(self, logger=None):
        self._log = logger
        self._lock = threading.RLock()
        self._mm = None
        self._legacy_fp_seen = None
        self.enabled = False
        self._init_error = ''

    # ---- 生命周期 ----
    def _engine(self):
        """懒加载单例。返回 MemoryManager 或 None（不可用）。"""
        if self._mm is not None:
            return self._mm
        with self._lock:
            if self._mm is not None:
                return self._mm
            try:
                from agent_memory.memory_store import MemoryManager
                mm = MemoryManager(paths.MEMORY_DB_PATH, window_turns=12)
                self._mm = mm
                self.enabled = True
                self._sync_legacy(force=True)
            except Exception as e:              # 打包缺件/磁盘不可写 → 整体降级
                self._init_error = str(e)
                if self._log:
                    self._log.warning('memory.db 引擎不可用（降级 legacy）: %r', e)
                self._mm = None
                self.enabled = False
            return self._mm

    # ---- legacy 同步（迁移 + 增删传播） ----
    def _legacy_fp(self):
        try:
            st = os.stat(paths.MEMORY_PATH)
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def _sync_legacy(self, force=False):
        """memory.json → db 的 `legacy:` 命名空间重建（指纹变化才动库）。"""
        mm = self._mm
        if mm is None:
            return
        fp = self._legacy_fp()
        if not force and fp == self._legacy_fp_seen:
            return
        self._legacy_fp_seen = fp
        with mm.conn:                           # 重建在单事务内（旧命名空间整删再导）
            mm.conn.execute(
                "DELETE FROM profile_kv WHERE key LIKE ?", (LEGACY_KEY_PREFIX + '%',))
            mm.conn.execute(
                "DELETE FROM fact_records WHERE attribute=?", (LEGACY_ATTR,))
        try:
            import json
            with open(paths.MEMORY_PATH, encoding='utf-8') as f:
                arr = json.load(f)
            if not isinstance(arr, list):
                arr = []
        except Exception:
            arr = []
        for entry in arr:
            if not isinstance(entry, dict):
                continue
            text = str(entry.get('text') or '').strip()
            if not text:
                continue
            kind = entry.get('kind')
            if kind in ('rule', 'preference'):
                # 稳定去重键：规范化文本哈希（同文本只留一条，legacy dedupe 对齐）
                import hashlib
                key = LEGACY_KEY_PREFIX + hashlib.sha1(
                    ''.join(text.split()).lower().encode('utf-8')).hexdigest()[:16]
                mm.profiles.set('legacy', 'local', key, text,
                                weight=1.2 if kind == 'rule' else 1.0,
                                source='user')
            else:
                mm.facts.put('legacy', 'local', LEGACY_ATTR, text)

    def ensure_synced(self):
        """对外入口：引擎可用即（必要时）同步 legacy。返回引擎或 None。"""
        mm = self._engine()
        if mm is not None:
            with self._lock:
                self._sync_legacy()
        return mm

    # ---- 能力面（全部安全降级） ----
    def remember(self, session_id, user_id, text, source='user',
                 explicit=True, attribute=None):
        mm = self._engine()
        if mm is None:
            return {'ok': False, 'reason': 'engine_unavailable'}
        with self._lock:
            return mm.remember(session_id, user_id, text, source=source,
                               explicit=explicit, attribute=attribute)

    def context(self, user_id, session_id, mode='full', query='',
                token_budget=None):
        mm = self.ensure_synced()
        if mm is None:
            return None
        try:
            return mm.build_context(user_id, session_id, mode=mode,
                                    query=query, token_budget=token_budget)
        except Exception as e:
            if self._log:
                self._log.warning('build_context 失败: %r', e)
            return None

    def extras_block(self, user_id, session_id, query='', max_chars=600):
        """系统提示注入的「扩展段」：仅当 db 存在**非 legacy**记忆时返回非空。

        legacy 注入段（memory.json）保持逐字节契约；本段只承载 v2 独有内容
        （结构化事实/会话摘要），故对既有用户输出零变化（test_w11 兼容）。
        """
        mm = self.ensure_synced()
        if mm is None:
            return ''
        try:
            with mm.conn:
                row = mm.conn.execute(
                    "SELECT COUNT(*) c FROM fact_records"
                    " WHERE is_current=1 AND attribute<>?",
                    (LEGACY_ATTR,)).fetchone()
                row2 = mm.conn.execute(
                    "SELECT COUNT(*) c FROM profile_kv WHERE key NOT LIKE ?",
                    (LEGACY_KEY_PREFIX + '%',)).fetchone()
            if not (row['c'] or row2['c']):
                return ''
            ctx = mm.build_context(user_id, session_id, mode='profile_only',
                                   query=query)
            facts = ctx.get('current_facts') or {}
            facts = {k: v for k, v in facts.items() if k != LEGACY_ATTR}
            profile = {k: v for k, v in (ctx.get('profile') or {}).items()
                       if not str(k).startswith(LEGACY_KEY_PREFIX)}
            lines = ['【长期记忆·扩展】（结构化事实，双时间戳校准；与当前指令冲突时以当前指令为准）']
            for attr, val in list(facts.items())[:4]:
                text = str(val)
                if len(text) > 120:
                    text = text[:120] + '…'
                lines.append('- [事实:%s] %s' % (attr, text))
            for k, v in list(profile.items())[:2]:
                text = str(v)
                if len(text) > 80:
                    text = text[:80] + '…'
                lines.append('- [画像] %s' % text)
            out = '\n'.join(lines)
            return out[:max_chars] if len(out) > max_chars else out
        except Exception as e:
            if self._log:
                self._log.warning('extras_block 失败: %r', e)
            return ''

    def stats(self):
        mm = self.ensure_synced()
        if mm is None:
            return {'enabled': False, 'error': self._init_error}
        try:
            with mm.conn:
                facts = mm.conn.execute(
                    "SELECT COUNT(*) c FROM fact_records WHERE is_current=1"
                ).fetchone()['c']
                profiles = mm.conn.execute(
                    "SELECT COUNT(*) c FROM profile_kv").fetchone()['c']
                events = mm.conn.execute(
                    "SELECT COUNT(*) c FROM raw_events").fetchone()['c']
            return {'enabled': True, 'facts': facts, 'profiles': profiles,
                    'events': events, 'stats': dict(mm.stats),
                    'journal': mm.journal_mode,
                    'integrity': mm.verify_integrity()}
        except Exception as e:
            return {'enabled': False, 'error': str(e)}

    def erase(self, user_id, attribute=None, value='', hard=False,
              reason='用户请求删除'):
        mm = self.ensure_synced()
        if mm is None:
            return {'ok': False, 'reason': 'engine_unavailable'}
        with self._lock:
            if hard:
                counts = mm.hard_erase_user(user_id, reason=reason)
                return {'ok': True, 'hard': True, 'counts': counts}
            if attribute == '*':
                mm.compliance_purge(user_id, '*', reason)
                return {'ok': True, 'hard': False, 'scope': 'all'}
            mm.compliance_purge(user_id, attribute or 'note', reason, value=value)
            return {'ok': True, 'hard': False, 'scope': attribute or 'note'}

    def close(self):
        with self._lock:
            if self._mm is not None:
                try:
                    self._mm.close()
                except Exception:
                    pass
                self._mm = None
                self.enabled = False
