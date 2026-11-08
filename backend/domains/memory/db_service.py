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
import json
import os
import threading

from ... import paths

# legacy 条目在本库的命名空间前缀（profile key / fact attribute）
LEGACY_ATTR = 'legacy_note'
LEGACY_KEY_PREFIX = 'legacy:'

# legacy 同步指纹：mtime_ns + 长度即可敏感捕获增删改（内容逐条 diff 不必要）


def _text_attr(prefix, text):
    """按文本派生稳定唯一 attribute（R39-D1 修复）。

    facts.put 同 attribute latest-wins（R15 唯一性 partial index）：R38 把所有
    legacy note / 默认 note 记忆都写进同一 attribute → 多条互相 supersede 只剩
    最后一条（实证复现）。改为 attribute 携带规范化文本指纹 → 多条并存，
    且同文本重放幂等（facts.put 值相同 → noop）。"""
    import hashlib
    return prefix + ':' + hashlib.sha1(
        ''.join(str(text).split()).lower().encode('utf-8')).hexdigest()[:12]


def _utc_now():
    """ISO 时刻（agent_memory.utc_now_iso 同款口径，避免私有依赖漂移）。"""
    from agent_memory.memory_store import utc_now_iso
    return utc_now_iso()


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
                # R39：Harbor 侧伴生表（钉选状态；agent_memory 参考实现零改动）
                with mm.conn:
                    mm.conn.execute(
                        "CREATE TABLE IF NOT EXISTS ui_meta ("
                        "kind TEXT NOT NULL, eid TEXT NOT NULL,"
                        "pinned INTEGER NOT NULL DEFAULT 0,"
                        "PRIMARY KEY (kind, eid))")
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
            # R39-D1：attribute 带文本指纹（legacy_note:<sha12>），前缀匹配
            # 兼容清理 R38 时代的裸 legacy_note 折叠残留（整库自愈重建）
            mm.conn.execute(
                "DELETE FROM fact_records WHERE attribute LIKE ?",
                (LEGACY_ATTR + '%',))
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
                # R39-D1：逐条唯一 attribute（同文本幂等 noop），多条不再互相 supersede
                mm.facts.put('legacy', 'local',
                             _text_attr(LEGACY_ATTR, text), text)

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
        # R39-D1：未指定 attribute 时按文本派生唯一键——mm.remember 缺省 'note'
        # 会把用户的多条事实记忆互相 supersede（同 R38 legacy 折叠同型缺陷）
        if not attribute:
            attribute = _text_attr('note', text)
        with self._lock:
            return mm.remember(session_id, user_id, text, source=source,
                               explicit=explicit, attribute=attribute)

    def context(self, user_id, session_id, mode='full', query='',
                token_budget=None):
        mm = self.ensure_synced()
        if mm is None:
            return None
        try:
            ctx = mm.build_context(user_id, session_id, mode=mode,
                                   query=query, token_budget=token_budget)
            # R40-4：钉选条目在 full/profile_only 派生视图同样置前
            # （R39 仅 extras_block 生效，且 fact 键域错位——见 _pinned_keys）
            if ctx:
                fact_attrs, profile_keys = self._pinned_keys(mm)
                if fact_attrs or profile_keys:
                    for k, want, ns in (('current_facts', fact_attrs, 'fact'),
                                        ('profile', profile_keys, 'profile')):
                        items = ctx.get(k)
                        if isinstance(items, dict) and want:
                            ctx[k] = dict(sorted(
                                items.items(),
                                key=lambda kv: 0 if str(kv[0]) in want else 1))
            return ctx
        except Exception as e:
            if self._log:
                self._log.warning('build_context 失败: %r', e)
            return None

    # ---- R42：记忆工具面检索（模型主动读；频率强化 + 久未用衰减） ----
    def search(self, user_id, query, limit=8):
        """长期记忆检索（memory_search 工具执行后端）。

        合并两源：memory.db（profile+current facts）与 legacy memory.json。
        打分 = bigram 相关度 × 频率强化(命中→最高 1.5x) × 时间衰减
        （7 天内 1.5x / 30 天以上 0.3x——2026 共识重排序口径，调研轮 26）。
        profile 命中刷新衰减时钟（R16 语义：命中即 touch）。
        引擎不可用 → 仅 legacy 结果；全失败 → {'ok': False, 'results': []}。"""
        q = str(query or '').strip()
        if not q:
            return {'ok': True, 'results': [], 'query': ''}
        import time as _time
        now = _time.time()
        scored = []

        def _score(text, sim, hits=0, last_hit=''):
            base = float(sim)
            if base <= 0.0:
                return None
            freq = 1.0 + 0.5 * min(1.0, float(hits or 0) / 10.0)
            rec = 1.0
            if last_hit:
                try:
                    from agent_memory.memory_store import utc_now_iso
                    lh = _time.mktime(_time.strptime(
                        str(last_hit)[:19], '%Y-%m-%dT%H:%M:%S'))
                    age_days = (now - lh) / 86400.0
                    rec = 1.5 if age_days <= 7 else (0.3 if age_days > 30 else 1.0)
                except Exception:
                    rec = 1.0
            return base * freq * rec

        mm = self.ensure_synced()
        if mm is not None:
            with self._lock:
                from agent_memory.memory_store import _sim
                touched = []
                for r in mm.conn.execute(
                        "SELECT key, value, source, weight, access_count,"
                        " last_accessed FROM profile_kv WHERE user_id=?",
                        (user_id,)):
                    try:
                        val = str(json.loads(r['value']))
                    except Exception:
                        val = str(r['value'])
                    sc = _score(val, _sim(val, q), r['access_count'],
                                r['last_accessed'])
                    if sc is None:
                        continue
                    scored.append({'kind': 'profile', 'id': r['key'],
                                   'text': val, 'source': r['source'],
                                   'confidence': round(float(r['weight']), 2),
                                   'score': round(sc, 4)})
                    touched.append(r['key'])
                for r in mm.conn.execute(
                        "SELECT fact_id, attribute, value, tx_time"
                        " FROM fact_records WHERE entity_id=? AND is_current=1",
                        (user_id,)):
                    try:
                        val = str(json.loads(r['value']))
                    except Exception:
                        val = str(r['value'])
                    sc = _score(val, _sim(val, q), 0, r['tx_time'])
                    if sc is None:
                        continue
                    scored.append({'kind': 'fact', 'id': r['fact_id'],
                                   'text': val, 'attribute': r['attribute'],
                                   'score': round(sc, 4)})
                if touched:
                    mm.profiles.touch(user_id, touched)
        # legacy memory.json 合并（用户既有记忆必须在检索面）
        try:
            with open(paths.MEMORY_PATH, encoding='utf-8') as f:
                arr = json.load(f)
            if isinstance(arr, list):
                from agent_memory.memory_store import _sim as _sim2
                for i, entry in enumerate(arr):
                    text = str((entry or {}).get('text') or '') if isinstance(entry, dict) else str(entry or '')
                    if not text.strip():
                        continue
                    sc = _score(text, _sim2(text, q))
                    if sc is None:
                        continue
                    scored.append({'kind': 'legacy', 'index': i, 'text': text,
                                   'source': 'user',
                                   'confidence': 1.0, 'score': round(sc, 4)})
        except Exception:
            pass
        scored.sort(key=lambda x: -x['score'])
        return {'ok': True, 'query': q, 'results': scored[:max(1, int(limit or 8))]}

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
                    " WHERE is_current=1 AND attribute NOT LIKE ?",
                    (LEGACY_ATTR + '%',)).fetchone()
                row2 = mm.conn.execute(
                    "SELECT COUNT(*) c FROM profile_kv WHERE key NOT LIKE ?",
                    (LEGACY_KEY_PREFIX + '%',)).fetchone()
            if not (row['c'] or row2['c']):
                return ''
            ctx = mm.build_context(user_id, session_id, mode='profile_only',
                                   query=query)
            facts = ctx.get('current_facts') or {}
            profile = {k: v for k, v in (ctx.get('profile') or {}).items()
                       if not str(k).startswith(LEGACY_KEY_PREFIX)}
            facts = {k: v for k, v in facts.items()
                     if not str(k).startswith(LEGACY_ATTR)}
            # R39/R40-D2：钉选条目恒置前（用户显式「这条必须每次带上」的语义）。
            # R40 修复（R39-D2 键域错位）：fact 钉选按 fact_id 存（list_entries），
            # 注入排序比对的是 attribute——原比对恒不命中，钉选对事实条目完全
            # 无效（实证：pin 后顺序不变）。_pinned_keys 先解析 id→attribute。
            fact_attrs, profile_keys = self._pinned_keys(mm)
            pinned = set()
            pinned |= {('fact', a) for a in fact_attrs}
            pinned |= {('profile', k) for k in profile_keys}
            def _pin_first(items, keyfn):
                return (sorted(items, key=lambda kv: 0 if keyfn(kv[0]) in pinned else 1)
                        if pinned else list(items))
            lines = ['【长期记忆·扩展】（结构化事实，双时间戳校准；与当前指令冲突时以当前指令为准）']
            for attr, val in _pin_first(list(facts.items()),
                                        lambda k: ('fact', str(k)))[:4]:
                text = str(val)
                if len(text) > 120:
                    text = text[:120] + '…'
                lines.append('- [事实:%s] %s' % (attr, text))
            for k, v in _pin_first(list(profile.items()),
                                   lambda k: ('profile', str(k)))[:2]:
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

    # ---- R39：面板逐条管理（列表 / 钉选 / 单条擦除） ----
    def _pinned_ids(self, mm):
        try:
            rows = mm.conn.execute(
                "SELECT kind, eid FROM ui_meta WHERE pinned=1").fetchall()
            return {(r['kind'], r['eid']) for r in rows}
        except Exception:
            return set()

    def _pinned_keys(self, mm):
        """钉选条目的注入域键（R40-D2）：profile 按 key，fact 解析 fact_id→
        attribute（is_current=1；钉选条目被软关闭后自然退出排序）。"""
        try:
            rows = mm.conn.execute(
                "SELECT kind, eid FROM ui_meta WHERE pinned=1").fetchall()
            attrs, keys = set(), set()
            for r in rows:
                if r['kind'] == 'profile':
                    keys.add(str(r['eid']))
                elif r['kind'] == 'fact':
                    row = mm.conn.execute(
                        "SELECT attribute FROM fact_records"
                        " WHERE fact_id=? AND is_current=1",
                        (r['eid'],)).fetchone()
                    if row:
                        attrs.add(str(row['attribute']))
            return attrs, keys
        except Exception:
            return set(), set()

    def list_entries(self, user_id):
        """面板逐条视图：profile_kv + 当前事实合并（钉选/来源/置信度/命中）。"""
        mm = self.ensure_synced()
        if mm is None:
            return None

        def _text(v):
            # profile_kv.value / fact_records.value 均为 JSON 串——解码为人话
            try:
                return str(json.loads(v))
            except Exception:
                return str(v)

        with self._lock:
            pinned = self._pinned_ids(mm)
            out = []
            for r in mm.conn.execute(
                    "SELECT key, value, weight, source, access_count,"
                    " last_accessed, updated_at FROM profile_kv"
                    " WHERE user_id=? ORDER BY updated_at DESC", (user_id,)):
                key = r['key']
                out.append({
                    'kind': 'profile', 'id': key,
                    'text': _text(r['value']),
                    'source': str(r['source'] or 'user'),
                    'confidence': round(float(r['weight'] or 1.0), 2),
                    'hits': int(r['access_count'] or 0),
                    'last_hit': str(r['last_accessed'] or ''),
                    'updated': str(r['updated_at'] or ''),
                    'pinned': ('profile', key) in pinned,
                    'readonly': str(key).startswith(LEGACY_KEY_PREFIX),
                })
            for r in mm.conn.execute(
                    "SELECT fact_id, attribute, value, valid_from, tx_time"
                    " FROM fact_records WHERE entity_id=? AND is_current=1"
                    " ORDER BY tx_time DESC", (user_id,)):
                fid = r['fact_id']
                out.append({
                    'kind': 'fact', 'id': fid,
                    'text': _text(r['value']),
                    'source': 'legacy' if str(r['attribute']).startswith(LEGACY_ATTR) else 'session',
                    'confidence': 1.0,
                    'hits': 0,
                    'last_hit': '',
                    'updated': str(r['tx_time'] or ''),
                    'pinned': ('fact', fid) in pinned,
                    'readonly': str(r['attribute']).startswith(LEGACY_ATTR),
                })
            return out

    def pin(self, user_id, kind, eid, pinned=True):
        """钉选/取消（ui_meta 伴生表 + 审计事件走 events.append 保哈希链）。"""
        mm = self.ensure_synced()
        if mm is None:
            return {'ok': False, 'reason': 'engine_unavailable'}
        with self._lock:
            with mm.conn as c:
                if pinned:
                    c.execute("INSERT INTO ui_meta(kind, eid, pinned)"
                              " VALUES (?,?,1) ON CONFLICT(kind, eid)"
                              " DO UPDATE SET pinned=1", (kind, eid))
                else:
                    c.execute("DELETE FROM ui_meta WHERE kind=? AND eid=?",
                              (kind, eid))
                # 审计（eid 已是指纹/键名，非原文——R24 掩码口径不破）
                mm.events.append('ui', 'memory_pin',
                                 {'kind': str(kind), 'eid': str(eid)[:80],
                                  'pinned': bool(pinned)}, tx=c)
            return {'ok': True, 'kind': kind, 'pinned': bool(pinned)}

    def erase_entry(self, user_id, kind, eid):
        """面板单条擦除（legacy 命名空间条目只读——重建会复活，legacy 面板管）。"""
        mm = self.ensure_synced()
        if mm is None:
            return {'ok': False, 'reason': 'engine_unavailable'}
        with self._lock:
            with mm.conn as c:
                if kind == 'profile':
                    cur = c.execute("SELECT key FROM profile_kv"
                                    " WHERE user_id=? AND key=?",
                                    (user_id, eid)).fetchone()
                    if cur is None:
                        return {'ok': False, 'reason': 'not_found'}
                    c.execute("DELETE FROM profile_kv WHERE user_id=? AND key=?",
                              (user_id, eid))
                elif kind == 'fact':
                    cur = c.execute("SELECT fact_id FROM fact_records"
                                    " WHERE fact_id=? AND is_current=1",
                                    (eid,)).fetchone()
                    if cur is None:
                        return {'ok': False, 'reason': 'not_found'}
                    # 双时间轴软关闭（is_current=0 + valid_to=now；历史行保留可审计）
                    c.execute("UPDATE fact_records SET is_current=0,"
                              " valid_to=? WHERE fact_id=?",
                              (_utc_now(), eid))
                else:
                    return {'ok': False, 'reason': 'bad_kind'}
                mm.events.append('ui', 'memory_erase_entry',
                                 {'kind': str(kind), 'eid': str(eid)[:80]}, tx=c)
            return {'ok': True, 'kind': kind}

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
