# -*- coding: utf-8 -*-
"""混合路由服务（实现 v1.8.0 H1：hybrid_get_config / hybrid_save_config 两
js_api 的后端，及本地⇄云端协同的决策面）。

模块职责（架构文档 §2.1 后端模块表「混合路由 hybrid_router」）：
- 任务分类器（understand/validate/plan/compose）：**纯函数规则**（输入 =
  消息文本 + 上下文特征：长度/是否含代码块/是否工具结果/问号密度 → 类别 +
  置信度；可解释优先，不引 LLM——每条得分都带 reason）；
- 三策略（联调规范 §3.3 + §7 R3/R10 裁决口径）：
    auto    分类路由（understand/validate → 本地；plan/compose → 云端）
    saver   全本地优先，不可用降云端（saver 是用户显式选择的省钱模式，
            预期内降级**静默**——R3/R10 裁决）
    quality 全云端
- 硬预算：本地 understand 5s / validate 3s，超即降级云端（当前步骤）——
  ``check_budget`` 供调用方在途判定；
- 置信门 0.7：分类置信 < 门限 → 升级云端（escalate）；
- 降级链（§5.1②）：本地不可用 → 静默降级当前步骤；首次降级 toast 由前端
  （``degrade_notice`` 判据：auto 策略首次 + 双失败；saver 静默）；3 连败 →
  unavailable + 60s 周期探测（``report_local_result`` 状态机）；
- 成本分账：本地/云端 token 分别累加（本地计费 ¥0 但计入统计；节省 =
  Σ本地 tok × 云端单价）——``#costSplit`` chip 数据源（架构 §3.3 前端触点）；
- 配置：``~/.glm-chat/hybrid.json`` 独立文件（config.json 零污染铁律）；
  get 缺失/损坏 → 返回默认 + source=default（损坏文件备份 .corrupt-ts；
  首启零配置可用——不报错）；save 部分更新语义（缺省取当前值）。
"""
import copy
import datetime
import json
import os
import re
import threading
import time

from ... import paths
from ...fio import atomic_write_json
from ...logging_setup import get_logger

# ---------------- 契约常量（联调规范 §3.3） ----------------
HYBRID_FILE = os.path.join(paths.CONFIG_DIR, 'hybrid.json')
DEFAULT_CONFIG = {
    'strategy': 'auto',                    # auto|saver|quality
    'local_budget_understand_s': 5,        # 1-30
    'local_budget_validate_s': 3,          # 1-30
    'confidence_gate': 0.7,                # 0.5-0.95
    'cost_split_display': True,
}
COLLABORATION_DEFAULT = {
    'enabled': False, 'local_first': True,
    'cloud_token_budget': 30000, 'total_token_budget': 120000,
    'cloud_cost_budget': 2.0, 'max_review_rounds': 2, 'max_model_retries': 1,
    'deadline_s': 1800, 'fallback_policy': 'allow_bounded',
    'upload_scope': 'task_summary_only',
    'endpoint_cache': {'cloud': None, 'local': None},
}
COLLABORATION_ROLES = {'cloud', 'local'}
STRATEGIES = ('auto', 'saver', 'quality')
CATEGORIES = ('understand', 'validate', 'plan', 'compose')
BUDGET_FIELDS = {'understand': 'local_budget_understand_s',
                 'validate': 'local_budget_validate_s'}
# 云端单价（¥/1k tokens）：分账「节省」估算口径——与前端 65-hybrid.js 的
# HY_CLOUD_PRICE_PER_1K 逐字一致（内部浮点、展示两位小数）
CLOUD_PRICE_PER_1K = 0.002
DEGRADE_FAIL_STREAK = 3          # 3 连败 → unavailable（§5.1②）
DEGRADE_PROBE_INTERVAL_S = 60    # unavailable 期间的周期探测间隔
ROUTE_LOG_MAX_BYTES = 2 * 1024 * 1024   # 路由日志轮转阈值（超限改名 .1，只留一代）

# 分类关键词表（可解释规则：命中即得分，reason 记录命中词）
_CATEGORY_KEYWORDS = {
    'understand': ('是什么', '为什么', '怎么', '如何', '解释', '讲讲', '什么意思',
                   '请问', '吗', '呢', 'what', 'why', 'how', 'explain', 'mean'),
    'validate': ('校验', '检查', '验证', '审查', '核对', 'review', 'check',
                 'validate', '对不对', '是否正确', '有没有问题', '确认一下',
                 '测试一下', '跑一下看看'),
    'plan': ('计划', '规划', '步骤', '方案', '拆分', '分解', '安排', '流程',
             '然后', '接着', '最后', 'plan', 'steps', 'roadmap', 'todo'),
    'compose': ('写', '实现', '生成', '创建', '修改', '重构', '优化', '补全',
                '代码', '脚本', '函数', '报错', '修复', 'write', 'implement',
                'generate', 'create', 'refactor', 'fix', 'code'),
}
_QUESTION_CHARS = ('?', '？')


def _kw_hit(low, kw):
    """关键词命中判定：ASCII 词加 ``\\b`` 词边界（防 'how' 命中 'however' /
    'show' 之类裸子串误判），中文保持子串（无词边界概念）。"""
    k = str(kw)
    if k.isascii():
        return re.search(r'\b%s\b' % re.escape(k), low) is not None
    return k in low


def _utc_now():
    """ISO8601 UTC（§4.3：全库统一 'Z' 后缀；秒级精度）。"""
    return datetime.datetime.now(datetime.timezone.utc) \
        .replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def classify_task(text, context=None):
    """任务分类器（纯函数；架构 §2.1「可解释优先，不引 LLM」）。

    Args:
        text: 用户消息文本（或回合输入）。
        context: dict，可选特征 ``{has_code_block, has_tool_result}``
            （缺省从 text 推断代码块；工具结果由调用方传入）。

    Returns:
        dict: ``{category, confidence, scores, reasons}``——category ∈
        understand/validate/plan/compose；confidence ∈ (0, 0.95]，
        <0.7 即低于置信门（调用方升级云端）；reasons 为可解释命中记录。

    规则（打分制，top 分类 = 最高分；置信 = top/Σ，差距过小再折减——
    防「看起来很像」的模糊输入被高置信路由）：
    - 关键词命中：每类最多计 3 个命中词 × 1.0；
    - 问号密度 ≥0.15/百字 → understand +2.0；
    - 含代码块 → compose +2.0；
    - 上下文带工具结果 → validate +1.5（工具产出需要校验）；
    - 长度 >600 字 → compose +1.0；<30 字 → understand +0.5；
    - 无任何信号 → understand + 置信 0.3（低于门限 → 升级云端，安全侧）。
    """
    ctx = context or {}
    t = str(text or '')
    low = t.lower()
    scores = {c: 0.0 for c in CATEGORIES}
    reasons = []

    for cat, keywords in _CATEGORY_KEYWORDS.items():
        hits = [kw for kw in keywords if _kw_hit(low, kw)]
        if hits:
            gained = min(len(hits), 3) * 1.0
            scores[cat] += gained
            reasons.append('%s 关键词命中 %s' % (cat, '/'.join(hits[:3])))

    n = len(t)
    q_count = sum(t.count(c) for c in _QUESTION_CHARS)
    q_density = (q_count * 100.0 / n) if n > 0 else 0.0
    if n > 0 and q_density >= 15.0:
        scores['understand'] += 2.0
        reasons.append('问号密度 %.1f/百字 → understand' % q_density)

    has_code = bool(ctx.get('has_code_block')) or ('```' in t) or \
        bool(re.search(r'(?m)^\s{4,}\S', t))
    if has_code:
        scores['compose'] += 2.0
        reasons.append('含代码块 → compose')

    if ctx.get('has_tool_result'):
        scores['validate'] += 1.5
        reasons.append('上下文带工具结果 → validate')

    if n > 600:
        scores['compose'] += 1.0
        reasons.append('长文本（%d 字）→ compose' % n)
    elif 0 < n < 30:
        scores['understand'] += 0.5
        reasons.append('短输入（%d 字）→ understand' % n)

    total = sum(scores.values())
    if total <= 0:
        return {'category': 'understand', 'confidence': 0.3,
                'scores': scores,
                'reasons': ['无分类信号，保守走 understand（低置信→升级云端）']}
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    top_cat, top = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    confidence = top / total
    if top > 0 and (top - second) < 0.25 * top:
        # 与次高分差距过小：类别边界模糊，置信折减（可解释）
        confidence *= 0.7
        reasons.append('与次高分（%s）差距过小，置信折减' % ranked[1][0])
    confidence = round(min(max(confidence, 0.05), 0.95), 2)
    return {'category': top_cat, 'confidence': confidence,
            'scores': {k: round(v, 2) for k, v in scores.items()},
            'reasons': reasons}


def _is_int_like(v):
    """可安全转 int（排除 bool / NaN / inf / 非整数值）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        n = int(v)
    except (ValueError, OverflowError):
        return False
    return n == v


def _is_float_like(v):
    """可安全转 float（排除 bool；int/float 均可）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        float(v)
    except (ValueError, OverflowError):
        return False
    return True


def _collaboration_secret(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if re.search(r'(?:api[_-]?key|secret|password|authorization|bearer|token)', str(key), re.I):
                return True
            if _collaboration_secret(child):
                return True
    elif isinstance(value, list):
        return any(_collaboration_secret(item) for item in value)
    return False


def _endpoint_snapshot_valid(value):
    if not isinstance(value, dict):
        return False
    required = ('preset', 'baseUrlRef', 'model', 'prices', 'toolCapability', 'ctxWindow')
    if any(key not in value for key in required) or set(value) - set(required + ('validatedAt',)):
        return False
    if not all(isinstance(value[key], str) and value[key] for key in ('preset', 'baseUrlRef', 'model')):
        return False
    if not isinstance(value['ctxWindow'], int) or isinstance(value['ctxWindow'], bool) or value['ctxWindow'] < 8192:
        return False
    prices = value['prices']
    if not isinstance(prices, dict) or any(key not in prices for key in ('in', 'out', 'cache')):
        return False
    if any(isinstance(prices[key], bool) or not isinstance(prices[key], (int, float)) or prices[key] < 0
           for key in ('in', 'out', 'cache')):
        return False
    return isinstance(value['toolCapability'], list) and all(isinstance(item, str) for item in value['toolCapability'])


def normalize_collaboration(value, current=None):
    """Validate optional collaboration config without enabling any network path."""
    if not isinstance(value, dict):
        raise ValueError('collaboration 必须是对象')
    merged = copy.deepcopy(current or COLLABORATION_DEFAULT)
    for key, item in value.items():
        if key not in COLLABORATION_DEFAULT:
            continue
        if key == 'endpoint_cache':
            cache = copy.deepcopy(merged.get('endpoint_cache') or {'cloud': None, 'local': None})
            if not isinstance(item, dict) or set(item) - COLLABORATION_ROLES:
                raise ValueError('endpoint_cache 角色只允许 cloud/local')
            for role, snapshot in item.items():
                if snapshot is not None and not _endpoint_snapshot_valid(snapshot):
                    raise ValueError('endpoint_cache.%s 快照非法或 ctx/tool 不兼容' % role)
                if _collaboration_secret(snapshot):
                    raise ValueError('endpoint_cache 不得包含秘密')
                cache[role] = copy.deepcopy(snapshot)
            merged[key] = cache
        else:
            merged[key] = copy.deepcopy(item)
    if not isinstance(merged['enabled'], bool) or not isinstance(merged['local_first'], bool):
        raise ValueError('collaboration enabled/local_first 必须是 boolean')
    if not _is_int_like(merged['cloud_token_budget']) or not 6000 <= merged['cloud_token_budget'] <= 30000:
        raise ValueError('cloud_token_budget 越界')
    if not _is_int_like(merged['total_token_budget']) or not 10000 <= merged['total_token_budget'] <= 120000:
        raise ValueError('total_token_budget 越界')
    if merged['cloud_token_budget'] > merged['total_token_budget']:
        raise ValueError('cloud_token_budget 不能超过 total_token_budget')
    if not _is_float_like(merged['cloud_cost_budget']) or not 0.01 <= merged['cloud_cost_budget'] <= 1000:
        raise ValueError('cloud_cost_budget 越界')
    if not _is_int_like(merged['max_review_rounds']) or not 0 <= merged['max_review_rounds'] <= 2:
        raise ValueError('max_review_rounds 越界')
    if not _is_int_like(merged['max_model_retries']) or not 0 <= merged['max_model_retries'] <= 1:
        raise ValueError('max_model_retries 越界')
    if not _is_int_like(merged['deadline_s']) or not 60 <= merged['deadline_s'] <= 1800:
        raise ValueError('deadline_s 越界')
    if merged['fallback_policy'] not in ('allow_bounded', 'disabled'):
        raise ValueError('fallback_policy 非法')
    if merged['upload_scope'] not in ('task_summary_only', 'selected_results_only', 'local_only'):
        raise ValueError('upload_scope 非法')
    reserve_unit = min(4000, merged['cloud_token_budget'] * 0.2)
    if reserve_unit * (3 + merged['max_review_rounds']) > merged['cloud_token_budget'] * 0.8:
        raise ValueError('planner/reviewer/finalizer 预留超过 cloud budget 80%')
    if merged['enabled']:
        cache = merged.get('endpoint_cache') or {}
        if not _endpoint_snapshot_valid(cache.get('cloud')) or not _endpoint_snapshot_valid(cache.get('local')):
            raise ValueError('启用 collaboration 前必须提供 cloud/local 双端快照')
    return merged


class HybridRouter:
    """混合路由服务（进程内单例，由 Api 装配；测试可注入时钟与配置路径）。

    配置读写（H1/H2）+ 路由决策（分类/策略/预算/置信门）+ 降级链状态机 +
    成本分账累加。路由**执行**（本地/云端请求本身）在 Agent 主链路
    （60-agent-loop.js + local_model_service），本服务只做决策与记账。
    """

    def __init__(self, config_path=None, clock=None):
        """Args:
            config_path: hybrid.json 路径（缺省 ``~/.glm-chat/hybrid.json``）。
            clock: 单调时钟（测试注入假时钟；缺省 time.monotonic）。
        """
        self._log = get_logger()
        self._path = config_path or HYBRID_FILE
        self._clock = clock or time.monotonic
        self._lock = threading.RLock()
        self._cfg = dict(DEFAULT_CONFIG)
        # 降级链状态（进程内；§5.1②）
        self._fail_streak = 0
        self._unavailable_until = 0.0
        self._degrade_notified = False
        # 成本分账（进程内；#costSplit 数据源）
        self._split = {'local_tokens': 0, 'cloud_tokens': 0,
                       'local_cost': 0.0, 'cloud_cost': 0.0}

    # ================================================== 配置读写（H1/H2）
    def get_config(self):
        """实现 v1.8.0 H1：读配置（联调规范 §3.3「缺失返回默认而非报错」）。

        Returns:
            dict: ``{ok, config, source}``——source=file（正常读取）/
            default（缺失：顺带落盘默认，幂等；损坏：原文件备份
            ``.corrupt-<ts>`` + 落盘默认）。部分合法文件按默认值补齐缺键。
        """
        data = None
        source = 'default'      # 前置：合法 JSON 但非对象（list/str 等）时
        #                         也不会漏赋值（修 UnboundLocalError）
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except FileNotFoundError:
            pass
        except Exception as e:
            # 损坏：备份 + 落盘默认（不静默吞损坏——保留现场供用户排查）
            self._log.warning('混合路由配置损坏，按默认值重建: %r', e)
            try:
                os.replace(self._path, '%s.corrupt-%d' % (
                    self._path, int(time.time())))
            except OSError:
                pass
            source = 'default'
        cfg = dict(DEFAULT_CONFIG)
        if isinstance(data, dict):
            for k in DEFAULT_CONFIG:
                v = data.get(k)
                if self._field_valid(k, v):
                    cfg[k] = v
            if 'collaboration' in data:
                try:
                    cfg['collaboration'] = normalize_collaboration(data['collaboration'])
                except ValueError as error:
                    return {'error': str(error), 'field': 'collaboration'}
            source = 'file'
        with self._lock:
            self._cfg = cfg
        if source == 'default':
            self._persist()
        return {'ok': True, 'config': dict(cfg), 'source': source}

    def save_config(self, cfg):
        """实现 v1.8.0 H1：保存配置（部分更新语义，缺省取当前值）。

        Args:
            cfg: dict 或 JSON 字符串（字段见 §3.3 请求表）。

        Returns:
            dict: ``{ok, config}``（合并后全量）；字段级校验失败 →
            ``{error, field}``（BAD_PARAMS 由 api 层包装，hint 指明字段与
            合法域）。策略切换即时生效于下一回合（调用方按回合快照读）。
        """
        incoming = cfg
        if isinstance(incoming, (str, bytes)):
            try:
                incoming = json.loads(incoming)
            except Exception:
                return {'error': '配置必须是 JSON 对象或 JSON 字符串'}
        if not isinstance(incoming, dict):
            return {'error': '配置必须是 JSON 对象'}
        with self._lock:
            old_cfg = copy.deepcopy(self._cfg)
            merged = dict(self._cfg)
            for k, v in incoming.items():
                if k == 'collaboration':
                    if v is None:
                        continue
                    try:
                        merged[k] = normalize_collaboration(v, merged.get(k))
                    except ValueError as error:
                        return {'error': str(error), 'field': k}
                    continue
                if k not in DEFAULT_CONFIG:
                    continue          # 未知键忽略（前向兼容，不报错）
                if v is None:
                    continue          # 缺省取当前值（部分更新语义）
                if not self._field_valid(k, v):
                    return {'error': '字段 %s 的值 %r 不合法' % (k, v),
                            'field': k}
                merged[k] = v
            self._cfg = merged
            ok = self._persist()
            if not ok:
                self._cfg = old_cfg
        if not ok:
            return {'error': '写入 hybrid.json 失败'}
        return {'ok': True, 'config': dict(merged)}

    def _field_valid(self, key, value):
        """字段级校验（合法域见 §3.3 请求表；bool≠int 陷阱显式排除）。"""
        if key == 'strategy':
            return isinstance(value, str) and value in STRATEGIES
        if key in ('local_budget_understand_s', 'local_budget_validate_s'):
            return _is_int_like(value) and 1 <= int(value) <= 30
        if key == 'confidence_gate':
            return _is_float_like(value) and 0.5 <= float(value) <= 0.95
        if key == 'cost_split_display':
            return isinstance(value, bool)
        return False

    def _persist(self):
        """落盘 hybrid.json（原子写；失败只警告不阻断决策面）。"""
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with self._lock:
                snapshot = dict(self._cfg)
            atomic_write_json(self._path, snapshot, indent=2)
            return True
        except Exception as e:
            self._log.warning('混合路由配置落盘失败: %r', e)
            return False

    # ================================================== 路由决策
    def route(self, text='', context=None, local_available=True,
              category=None, confidence=None):
        """路由决策（三策略 + 置信门 + 硬预算 + 降级链）。

        Args:
            text: 回合输入文本（category 缺省时现场分类）。
            context: 分类上下文特征（``{has_code_block, has_tool_result}``）。
            local_available: 调用方探测的本地端点可用性（连接拒绝/超时 →
                False，快速失败不等满预算）。
            category/confidence: 调用方已完成的分类结果（缺省现场分类）。

        Returns:
            dict: ``{ok, channel, category, confidence, strategy, budget_s,
            degraded, escalated, reason}``——channel=local|cloud；
            budget_s 为本地硬预算（秒，云端 None）；degraded=本地不可用
            静默降级；escalated=置信门升级云端。
        """
        with self._lock:
            cfg = dict(self._cfg)
        if category is None:
            clf = classify_task(text, context)
            category = clf['category']
            confidence = clf['confidence']
        confidence = float(confidence if confidence is not None else 0.0)
        strategy = cfg['strategy']
        gate = float(cfg['confidence_gate'])
        local_usable = bool(local_available) and not self.local_unavailable()

        if strategy == 'quality':
            return self._decision('cloud', category, confidence, strategy,
                                  None, False, False,
                                  'quality 策略：全云端，不因本地可用性改道')
        if strategy == 'saver':
            # saver：全本地优先；不可用降云端（预期内，静默——R3/R10 裁决）
            if category in ('understand', 'validate') and local_usable:
                budget = int(cfg[BUDGET_FIELDS[category]])
                return self._decision('local', category, confidence, strategy,
                                      budget, False, False,
                                      'saver 策略：%s 类任务本地优先（硬预算 %ds）'
                                      % (category, budget))
            if category in ('understand', 'validate'):
                # 本地不可用回云 = 真降级（degraded=True，路由日志如实记录）
                return self._decision('cloud', category, confidence, strategy,
                                      None, True, False,
                                      'saver 策略：本地不可用，回退云端'
                                      '（省钱模式预期内，静默）')
            # 复核修正：plan/compose 类在 saver 下本就恒走云端（策略语义，
            # 不经本地分支）——原统一 degraded=True 污染「为何降级」追溯口径
            return self._decision('cloud', category, confidence, strategy,
                                  None, False, False,
                                  'saver 策略：%s 类任务恒走云端（省钱模式预期内）'
                                  % category)
        # auto：分类路由 + 置信门
        if confidence < gate:
            return self._decision('cloud', category, confidence, strategy,
                                  None, False, True,
                                  '分类置信 %.2f < 门限 %.2f，升级云端复核'
                                  % (confidence, gate))
        if category in ('understand', 'validate'):
            if local_usable:
                budget = int(cfg[BUDGET_FIELDS[category]])
                return self._decision('local', category, confidence, strategy,
                                      budget, False, False,
                                      '%s 类任务走本地（硬预算 %ds，超即降级）'
                                      % (category, budget))
            return self._decision('cloud', category, confidence, strategy,
                                  None, True, False,
                                  '本地不可用，静默降级云端（当前步骤）')
        return self._decision('cloud', category, confidence, strategy, None,
                              False, False,
                              '%s 类任务走云端（auto 分类路由）' % category)

    @staticmethod
    def _decision(channel, category, confidence, strategy, budget, degraded,
                  escalated, reason):
        """决策记录组装（单一出口，字段齐全）+ **路由日志**（§5.3 可观测）。

        W10/H2 路由日志（deep-research #126 + iteration-plan §5.3）：每个决策
        追加写 ``~/.glm-chat/logs/hybrid-route.jsonl``（ts/channel/category/
        confidence/strategy/degraded/escalated/reason）——「哪个阶段走了哪端、
        为何降级」可追溯；写失败不阻塞决策（try 包裹）。
        """
        d = {'ok': True, 'channel': channel, 'category': category,
            'confidence': round(confidence, 2), 'strategy': strategy,
            'budget_s': budget, 'degraded': degraded,
            'escalated': escalated, 'reason': reason}
        try:
            from ... import paths as _paths
            log_path = os.path.join(_paths.LOG_DIR, 'hybrid-route.jsonl')
            os.makedirs(_paths.LOG_DIR, exist_ok=True)
            # 轮转：超 2MB 改名 .1（只保留一代——路由日志只作近期追溯，
            # 无界增长会拖慢读取/吃满磁盘；改名失败不阻塞决策）
            try:
                if os.path.getsize(log_path) > ROUTE_LOG_MAX_BYTES:
                    os.replace(log_path, log_path + '.1')
            except OSError:
                pass
            rec = dict(d)
            rec['ts'] = datetime.datetime.now().isoformat(timespec='seconds')
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        except Exception:
            pass          # 路由日志失败不阻塞决策主流程
        return d

    # 本地阶段请求组包口径（§5.3 时延优化）：理解/校验小请求控量 + Ollama 常驻
    STAGE_MAX_TOKENS = {'understand': 256, 'validate': 256, 'reader': 512}

    @staticmethod
    def stage_request(category, messages, base_url='', model=''):
        """本地阶段请求组包（§5.3）：max_tokens 128-256 控量 + keep_alive 常驻。

        Ollama 语义 keep_alive='30m' 防冷启；其他本地端点（OpenAI 兼容）忽略
        未知字段无害。云端路径不适用（云端终稿不需要控量）。
        """
        body = {
            'model': str(model or ''),
            'messages': messages,
            'max_tokens': HybridRouter.STAGE_MAX_TOKENS.get(
                str(category or ''), 256),
            'stream': False,
        }
        if 'ollama' in str(base_url or '').lower() or ':11434' in str(base_url or ''):
            body['keep_alive'] = '30m'
        return body

    def check_budget(self, category, elapsed_s):
        """硬预算在途判定：本地 understand 5s / validate 3s 超即降级。

        Returns:
            dict: ``{exceeded, budget_s}``（超时 → 调用方降级云端当前步骤）。
        """
        with self._lock:
            cfg = dict(self._cfg)
        field = BUDGET_FIELDS.get(str(category or ''))
        if field is None:
            return {'exceeded': False, 'budget_s': None}
        budget = int(cfg[field])
        return {'exceeded': float(elapsed_s or 0) > budget, 'budget_s': budget}

    # ================================================== 降级链状态机（§5.1②）
    def report_local_result(self, ok):
        """本地步骤结果回报：驱动 3 连败 → unavailable + 60s 周期探测。

        Args:
            ok: 本地步骤是否成功（连接拒绝/超时/5xx → False）。

        Returns:
            dict: ``{fail_streak, unavailable, unavailable_for_s}``。
        """
        with self._lock:
            if ok:
                self._fail_streak = 0
                self._unavailable_until = 0.0
            else:
                self._fail_streak += 1
                if self._fail_streak >= DEGRADE_FAIL_STREAK:
                    self._unavailable_until = self._clock() + \
                        DEGRADE_PROBE_INTERVAL_S
            return {'fail_streak': self._fail_streak,
                    'unavailable': self.local_unavailable(),
                    'unavailable_for_s': max(
                        0, int(self._unavailable_until - self._clock()))}

    # ================================================== 读取器路由（v1.9 M2.1）
    def route_reader(self, local_available=True, budget_s=10):
        """dual-LLM-lite 读取器路由决策（design §A3.4；不加 hybrid.json 键）。

        语义与主循环 route 的关键差异：**读取器永不升云**——它是本地隐私前
        处理（升云双倍成本且违背 dual-LLM-lite；主模型本身已云端，raw 文本
        照样可用）。故 quality 策略仍 local 优先（用户选 quality 得
        raw+云端主模型，语义正确）；本地不可用/3 连败窗口 → channel='skip'
        （调用方降级 mode='raw'，禁阻断主管线）。

        复用 strategy/降级链/report_local_result 状态机——本地端点整体宕机时
        读取器与主循环两侧同时知息。

        Returns:
            dict: ``{ok, channel: 'local'|'skip', budget_s, degraded, reason}``。
        """
        with self._lock:
            cfg = dict(self._cfg)
        budget = int(budget_s or 10)
        if self.local_unavailable():
            return {'ok': True, 'channel': 'skip', 'budget_s': budget,
                    'degraded': True,
                    'reason': '本地端点 3 连败窗口内（读取器降级 raw）'}
        if not local_available:
            return {'ok': True, 'channel': 'skip', 'budget_s': budget,
                    'degraded': True,
                    'reason': '本地端点不可用（读取器降级 raw）'}
        return {'ok': True, 'channel': 'local', 'budget_s': budget,
                'degraded': False,
                'reason': '读取器本地优先（%s 策略；隐私前处理不升云）'
                          % cfg['strategy']}

    def local_unavailable(self):
        """本地是否处于 unavailable 窗口（3 连败后 60s 周期探测内）。"""
        return self._clock() < self._unavailable_until

    def degrade_notice(self, strategy, both_failed=False):
        """降级告知判据（R3/R10 裁决口径——「预期外才告知」）。

        - saver 策略下降级：**静默**（用户已显式选择省钱模式，回退云端是
          该模式预期内行为）；
        - auto 策略：本会话首次降级 → toast（隐私：谁在处理数据），重复
          降级静默（首次已建立认知）；
        - 双失败（降级后云端也失败）：违背用户当前意图 → 告知。
        返回 True = 前端应弹 toast。
        """
        if both_failed:
            return True
        if str(strategy) == 'saver':
            return False
        with self._lock:
            if self._degrade_notified:
                return False
            self._degrade_notified = True
            return True

    # ================================================== 成本分账（#costSplit）
    def record_usage(self, channel, tokens):
        """usage 记账：local/cloud token 分别累加（本地计费 ¥0 但计入统计）。

        Args:
            channel: ``local`` | ``cloud``。
            tokens: 本次输出 token 数（usage.completion_tokens）。

        Returns:
            dict: 累加后的分账快照（同 ``cost_split``）。
        """
        try:
            tok = int(tokens or 0)
        except (TypeError, ValueError):
            tok = 0
        if tok <= 0:
            return self.cost_split()
        with self._lock:
            if str(channel) == 'local':
                self._split['local_tokens'] += tok
                # 本地计费 ¥0：local_cost 恒 0（计入统计不计费——§4.3）
            else:
                self._split['cloud_tokens'] += tok
                self._split['cloud_cost'] += tok / 1000.0 * CLOUD_PRICE_PER_1K
            return self.cost_split()

    def cost_split(self):
        """分账快照：``{local_tokens, cloud_tokens, local_cost, cloud_cost,
        saved}``——saved = Σ(本地 tok × 云端单价)（内部浮点，展示两位小数）。"""
        with self._lock:
            snap = dict(self._split)
        snap['local_cost'] = round(snap['local_cost'], 4)
        snap['cloud_cost'] = round(snap['cloud_cost'], 4)
        snap['saved'] = round(
            snap['local_tokens'] / 1000.0 * CLOUD_PRICE_PER_1K, 4)
        return snap

    def reset_split(self):
        """分账归零（新会话/用户手动重置）。"""
        with self._lock:
            self._split = {'local_tokens': 0, 'cloud_tokens': 0,
                           'local_cost': 0.0, 'cloud_cost': 0.0}
        return self.cost_split()

    def status(self):
        """路由状态摘要（设置区/调试数据源；不落审计）。"""
        with self._lock:
            cfg = dict(self._cfg)
            return {'ok': True, 'strategy': cfg['strategy'],
                    'confidence_gate': cfg['confidence_gate'],
                    'budgets': {c: cfg[BUDGET_FIELDS[c]]
                                for c in BUDGET_FIELDS},
                    'local_unavailable': self.local_unavailable(),
                    'fail_streak': self._fail_streak,
                    'cost_split': self.cost_split(),
                    'price_per_1k': CLOUD_PRICE_PER_1K,
                    'ts': _utc_now()}
