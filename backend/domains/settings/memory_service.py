# -*- coding: utf-8 -*-
"""memory_service：结构化记忆（v1.8.0 W11 + 交接文档「记忆结构化三类」）。

四件套（deep-research W11 规格）：
1. **结构化三类**：fact（事实）/ preference（偏好）/ rule（规则）——旧数据
   （无 kind 字段）读时懒迁移为 fact；写入时经 classify() 自动分类。
2. **规则提取**：「以后都/每次/永远/禁止/必须」句式 → rule；「我喜欢/偏好」
   → preference；其余 fact。句式优先于关键词（规则是用户显式约束）。
3. **关键词检索**：中文无分词依赖——字级 bigram 重叠打分（query × item
   2-gram Jaccard 式）+ rule 权重加成 + 时间衰减；纯函数可测。
4. **系统提示注入**：build_system_prompt 尾部注入「相关记忆」段（≤5 条，
   ≤800 字）——在 INTENTIONAL_DELTAS 白名单内（契约测试单独断言结构）。

存储：~/.glm-chat/memory.json（config_service 的 MEMORY_PATH，与 config.json
隔离铁律）。条目 {text, ts, ts_iso, kind, key?}；上限 200 条（写入前循环淘汰
最旧 fact 至达标或无 fact 可淘汰，rule/preference 不淘汰——用户显式约束优先
保留）。ts 为 'MM-DD HH:MM' 显示形态（js_api 契约差分归一口径不变）；
ts_iso 为 datetime.now().isoformat() 全量时间——淘汰比较与检索时间衰减走
datetime 比较（跨年无歧义；旧条目无 ts_iso 时回落 ts 按当前年推断）。
"""
import datetime
import json
import os
import re

KINDS = ('fact', 'preference', 'rule')

# 规则句式（用户显式约束——最高优先级分类）
_RULE_PATTERNS = (
    r'以后都', r'以后一律', r'每次都要', r'永远不要', r'任何时候都',
    r'禁止', r'必须', r'不允许', r'务必',
)
# 偏好句式
_PREF_PATTERNS = (
    r'我喜欢', r'我不喜欢', r'偏好', r'习惯用', r'倾向于', r'prefer',
)
# 中文停用字（bigram 打分时降权——防「的/了/是」虚高）
_STOP_CHARS = set('的了是我你他她它在有和就不都也很与及或对着被把让从往按依')
_MAX_ITEMS = 200
_INJECT_LIMIT = 5
_INJECT_MAX_CHARS = 800


def classify(text):
    """文本 → kind（rule > preference > fact 优先级）。"""
    t = str(text or '')
    for p in _RULE_PATTERNS:
        if p in t:
            return 'rule'
    for p in _PREF_PATTERNS:
        if p in t:
            return 'preference'
    return 'fact'


def _bigrams(s):
    """字级 bigram 集合（中文无分词；ASCII 词也按字符滑窗，短词降敏）。"""
    s = re.sub(r'\s+', '', str(s or '').lower())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def _tokens(s):
    """去停用字的 bigram（打分口径）。"""
    bg = _bigrams(s)
    return {g for g in bg if not (len(g) == 2 and g[0] in _STOP_CHARS and g[1] in _STOP_CHARS)}


def retrieve(query, items, limit=5):
    """关键词检索（纯函数）：bigram 重叠 + kind 加成 + 时间衰减。

    Args:
        query: 检索词（当前用户消息/任务上下文）。
        items: memory 条目数组（{text, ts, kind}）。
        limit: 返回条数。

    Returns:
        按相关度降序的条目列表（原对象引用，不拷贝）。
    """
    qt = _tokens(query)
    if not qt or not items:
        return []
    now = datetime.datetime.now()
    scored = []
    for idx, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        it_tokens = _tokens(it.get('text') or '')
        if not it_tokens:
            continue
        overlap = len(qt & it_tokens)
        if overlap == 0:
            continue
        # Jaccard 式归一（query 侧为主——query 短时不被长 item 稀释）
        score = overlap / max(1, len(qt))
        # kind 加成：rule 是显式约束，检索时优先（×1.3）
        if it.get('kind') == 'rule':
            score *= 1.3
        elif it.get('kind') == 'preference':
            score *= 1.1
        # 时间衰减：30 天半衰（新的记忆更可能仍有效）。
        # 修复跨年失真（本轮）：改走 datetime 比较（ts_iso 优先，回落 ts
        # 按当前年推断）；解析失败/无时间字段按最旧（datetime.min → 最大衰减）。
        try:
            ts = it.get('_ts_dt') or _item_dt(it)
            age_days = max(0.0, (now - ts).total_seconds() / 86400.0)
            score *= 0.5 ** (age_days / 30.0)
        except Exception:
            pass
        scored.append((score, -idx, it))     # -idx：同分新的（数组尾部）优先
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [it for _, _, it in scored[:int(limit)]]


def _parse_ts(ts):
    """时间字段 → datetime（ts_iso 的 ISO 全量形态优先；回落 'MM-DD HH:MM'
    按当前年推断）。解析失败返回 None（调用方按最旧处理）。

    修复跨年失真（本轮）：原只认 'MM-DD HH:MM' 且字符串比较——跨年时
    '01-01'（今年）字典序小于 '12-31'（去年），去年的条目反被判为更新；
    淘汰与衰减改走 datetime 比较，入库条目同时写 ts_iso 从根上消除歧义。
    遗留旧条目（无 ts_iso）按当前年推断时若显著超前于现在（1 月读到去年
    12 月的 'MM-DD'），回落一年——否则旧条目在淘汰侧永不被淘汰、衰减侧
    永远零衰减（跨年失真的最后一边界）。
    """
    s = str(ts or '').strip()
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s)      # ts_iso：ISO 全量（跨年无歧义）
    except Exception:
        pass
    try:
        m = re.match(r'(\d{2})-(\d{2}) (\d{2}):(\d{2})', s)
        if not m:
            return None
        now = datetime.datetime.now()
        dt = datetime.datetime(now.year, int(m.group(1)), int(m.group(2)),
                               int(m.group(3)), int(m.group(4)))
        if dt > now + datetime.timedelta(days=1):
            try:
                dt = dt.replace(year=now.year - 1)      # 去年残留：回退一年
            except ValueError:
                return None                             # 2-29 等罕见形态：按最旧
        return dt
    except Exception:
        return None


def _item_dt(item):
    """条目 → datetime（ts_iso 优先，回落 ts 推断；非 dict/解析失败按最旧）。

    淘汰比较与检索衰减共用——「解析失败按最旧」保证脏数据不因时间缺失
    而赖着不走（淘汰侧）或显得永新（衰减侧）。
    """
    if not isinstance(item, dict):
        return datetime.datetime.min
    dt = _parse_ts(item.get('ts_iso') or item.get('ts'))
    return dt if dt is not None else datetime.datetime.min


def inject_block(items, limit=_INJECT_LIMIT, max_chars=_INJECT_MAX_CHARS):
    """系统提示词注入段（相关记忆；空记忆 → '' 不加段）。

    格式：
        【长期记忆】用户此前的显式约束与偏好（相关条目，供参考，勿与用户
        当前指令冲突时以当前指令为准）：
        - [规则] 以后都先写测试再写实现
        - [偏好] 我喜欢简洁的回复
    """
    if not items:
        return ''
    lines = ['【长期记忆】用户此前的显式约束与偏好（相关条目；如与用户当前指令'
             '冲突，以当前指令为准）：']
    total = len(lines[0])
    used = 0
    for it in items[:int(limit)]:
        if not isinstance(it, dict):
            continue
        text = str(it.get('text') or '').strip()
        if not text:
            continue
        if len(text) > 200:
            text = text[:200] + '…'
        kind = it.get('kind') if it.get('kind') in KINDS else 'fact'
        _label = {'rule': '规则', 'preference': '偏好', 'fact': '事实'}
        line = '- [%s] %s' % (_label.get(kind, kind), text)
        if total + len(line) + 1 > max_chars:
            break
        lines.append(line)
        total += len(line) + 1
        used += 1
    if not used:
        return ''
    return '\n'.join(lines)


def normalize_item(entry):
    """入参归一：旧/脏条目 → {text, ts, ts_iso, kind}（kind 缺省自动分类）。

    修复跨年失真（本轮）：入库条目补 ts_iso（datetime.now().isoformat()
    全量时间）——淘汰比较与检索衰减走 datetime 比较从根上消除 'MM-DD'
    跨年歧义；ts 保留 'MM-DD HH:MM' 显示形态不变（js_api 契约差分归一
    口径）。旧条目无 ts_iso 时读时补（list 懒迁移不落盘；append 写入
    路径随 _save 落盘）。
    """
    e = dict(entry) if isinstance(entry, dict) else {'text': str(entry or '')}
    text = str(e.get('text') or '').strip()
    e['text'] = text
    now = datetime.datetime.now()
    if not e.get('ts'):
        e['ts'] = now.strftime('%m-%d %H:%M')
    if not e.get('ts_iso'):
        e['ts_iso'] = now.isoformat()
    kind = e.get('kind')
    if kind not in KINDS:
        e['kind'] = classify(text)      # 旧数据懒迁移 + 新写入自动分类
    return e


def dedupe_key(entry):
    """去重键：rule/preference 按规范化文本（同规则不重复存）；fact 不去重
    （同一事实的更新版本自然按时间衰减让位）。"""
    e = entry if isinstance(entry, dict) else {}
    if e.get('kind') in ('rule', 'preference'):
        return re.sub(r'\s+', '', str(e.get('text') or '')).lower()
    return None


class MemoryService:
    """结构化记忆服务（memory.json 独立文件；config.json 零污染）。

    append/list/delete 保持既有 js_api 语义（config_service 的同名方法
    转调此处）；新增 retrieve/inject_block 能力面。
    """

    def __init__(self, path, logger=None):
        self._path = path
        self._log = logger

    # ---- 读写 ----
    def _load(self):
        try:
            if os.path.exists(self._path):
                with open(self._path, encoding='utf-8') as f:
                    arr = json.load(f)
                if isinstance(arr, list):
                    return arr
        except Exception as e:
            if self._log:
                self._log.warning('memory.json 读取失败: %r', e)
        return []

    def _save(self, items):
        from ...fio import atomic_write_json
        # 修复 W2（本轮）：_save 不再无脑截断 items[-_MAX_ITEMS:]——那会在
        # 「全指令类超限」场景把最旧的 rule/preference 一起切掉（与「指令类
        # 不淘汰」的口径相悖）。上限改由 append 的 _evict_to_cap 循环负责：
        # 淘汰至 <= _MAX_ITEMS 或无 fact 可淘汰为止。
        atomic_write_json(self._path, items)

    @staticmethod
    def _evict_to_cap(items):
        """W2 口径：循环淘汰最旧 fact，直至 <= _MAX_ITEMS 或无 fact 可淘汰。

        rule/preference 永不淘汰（用户显式约束优先保留）；非 dict 的旧脏
        条目可淘汰且比较键回落 datetime.min（最旧优先淘汰——修复原对非
        dict 条目 (x or {}).get('ts') 的 AttributeError）。时间比较走
        _item_dt 的 datetime 口径（ts_iso 优先，跨年无失真）。按下标删
        单项（不用身份比较，防同值字符串被 intern 成同一对象误删多条）。
        返回淘汰后的列表（原地修改并返回同一对象）。
        """
        while len(items) > _MAX_ITEMS:
            idxs = [i for i, x in enumerate(items)
                    if not (isinstance(x, dict)
                            and x.get('kind') in ('rule', 'preference'))]
            if not idxs:
                break          # 全是指令类：允许超限（保指令不保事实）
            oldest = min(idxs, key=lambda i: _item_dt(items[i]))
            del items[oldest]
        return items

    def append(self, entry):
        """追加（自动分类 + rule/preference 去重 + 上限淘汰）。

        淘汰策略（W2 口径）：_save 前经 _evict_to_cap 循环淘汰最旧 fact，
        直至条目数 <= _MAX_ITEMS 或无 fact 可淘汰；rule/preference 不动
        （用户显式约束优先保留）——全是指令类时允许超限（极端场景保指令
        不保事实）。返回值 total 为淘汰后的实际条数。
        """
        e = normalize_item(entry)
        # 注：空 text 不拒绝（与 legacy append_memory 行为对齐——契约测试钉住
        # {'k':'v'} 这类无 text 条目也入库；分类对空串回落 fact）
        items = self._load()
        key = dedupe_key(e)
        if key:
            items = [x for x in items
                     if not (isinstance(x, dict)
                             and dedupe_key(x) == key)]
        items.append(e)
        items = self._evict_to_cap(items)
        self._save(items)
        return {'ok': True, 'kind': e['kind'], 'total': len(items)}

    def list(self):
        """全部条目（读取时懒迁移 kind——旧数据无 kind 自动分类，不落盘）。"""
        out = []
        for x in self._load():
            if isinstance(x, dict):
                y = normalize_item(x)
                y.setdefault('ts', x.get('ts') or y['ts'])
                out.append(y)
        return out

    def delete(self, index):
        """删第 index 条（0 起；越界/结构异常返回人话 error，不抛异常）。

        双轨（item 8）：config_service.delete_memory 转调本方法；边界/结构
        校验在此保持自足——外部直接调用同样得到清晰错误 shape：
          - 非整数下标（bool/None/float/非数字串）→ 「序号需要是整数」
          - 越界 → 「下标越界：N（当前共 M 条记忆）」
          - memory.json 损坏/非数组 → 「记忆文件结构异常…暂不能删除」
          - 落盘失败 → 「记忆保存失败…」（弹栈仅在内存，文件保持原样）
        成功 → {'ok': True, 'removed': 原条目, 'remaining': N}。
        """
        if isinstance(index, bool) or not isinstance(index, int):
            return {'error': '序号需要是整数（收到 %r）' % (index,)}
        items = None
        if os.path.exists(self._path):
            try:
                with open(self._path, encoding='utf-8') as f:
                    raw = json.load(f)
            except Exception as e:
                return {'error': '记忆文件结构异常（%s），暂不能删除' % e}
            if not isinstance(raw, list):
                return {'error': '记忆文件结构异常（不是数组），暂不能删除'}
            items = raw
        if items is None:
            items = []
        if index < 0 or index >= len(items):
            # R38（K3）：越界文案与 config_service.delete_memory 同口径统一
            #（js_api 主路径被 config 层截住，此为服务层直调的一致性收口）
            return {'error': '序号越界：当前共 %d 条记忆' % len(items)}
        removed = items.pop(index)
        try:
            self._save(items)
        except Exception as e:
            return {'error': '记忆保存失败：%s（数据未变动）' % e}
        return {'ok': True, 'removed': removed, 'remaining': len(items)}

    # ---- 检索 / 注入 ----
    def retrieve(self, query, limit=5):
        return retrieve(query, self.list(), limit)

    def inject_for(self, query, limit=_INJECT_LIMIT):
        """系统提示词注入段（按 query 相关度取 top N）。"""
        return inject_block(self.retrieve(query, limit), limit=limit)
