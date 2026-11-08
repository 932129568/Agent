# -*- coding: utf-8 -*-
"""v1.9.0 M2.2：provenance 包裹（UNTRUSTED DATA 标记）。

设计依据：deliverables/dev-plan/v19-m1m2-design.md §A3.4「provenance 包裹」。
安全语义：搜索/浏览器/软件三类外部输出进入主模型上下文前必须带来源标记——
防「无出处内容」被模型当作用户指令执行（毒网页/软件输出注入面），前端对
``untrusted=true`` 载荷三重编码渲染（琥珀斜纹边 + mono 来源 caption）。

纯函数铁律：零 IO、零网络——本模块只做字符串拼接与 dict 纯增键，可单测。
时间口径：``fetched_at`` 缺省取 ``_utc_now()``（§4.3：全库统一 ISO8601
UTC 'Z' 后缀，秒级精度——与 hybrid/search/_utc_now 同款）。
"""
import datetime
import re

# UNTRUSTED 包裹开/闭标记（开标记带来源三要素：URL/抓取时间/通道）
UNTRUSTED_OPEN_FMT = '[UNTRUSTED DATA — 来源: {url} · 抓取于 {ts} · 通道: {channel}]'
UNTRUSTED_CLOSE = '[END UNTRUSTED DATA]'

# R44（F2d 改进⑫精简版）：提示注入「预筛标注」（spotlighting 精简版——只标注
# 不阻断；认知沙箱/dual-LLM 属调研延伸）。模式库=中英常见指令覆盖指令句式，
# 命中不改变内容一字（红线：包裹只增标记），只在载荷增注入嫌疑键。
_INJECTION_PATTERNS = (
    ('ignore_previous', re.compile(
        r'ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)'
        r'|忽略(以上|之前|上面|先前)(的)?(所有)?(指令|提示|规则|设定)', re.I)),
    ('role_override', re.compile(
        r'you\s+are\s+now\s+(a|an)\b|act\s+as\s+(a|an)\s+(?!user)|从现在开始你(是|要扮演)'
        r'|你现在(是|扮演)', re.I)),
    ('system_prompt_probe', re.compile(
        r'(reveal|show|print|repeat|输出|打印|泄露|告诉我)\s*(your|the|你的|您)?\s*'
        r'(system\s+prompt|初始指令|系统提示)', re.I)),
    ('exfil_instruction', re.compile(
        r'(send|post|upload|exfiltrate|发送|上传|外传)\s*(this|the|这些)?\s*'
        r'(content|data|conversation|内容|数据|对话)\s*(to|到|给)', re.I)),
)


def scan_injection(text):
    """外部文本的提示注入嫌疑扫描（纯函数；标注型防御，不阻断）。

    Returns:
        list[str]: 命中的模式名（空列表=未见已知指令句式）。
    """
    t = str(text or '')
    if not t:
        return []
    return [name for name, pat in _INJECTION_PATTERNS if pat.search(t)]


def _utc_now():
    """ISO8601 UTC（§4.3：全库统一 'Z' 后缀；秒级精度）。"""
    return datetime.datetime.now(datetime.timezone.utc) \
        .replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def wrap_untrusted(text, source_url, channel='', fetched_at=''):
    """文本包裹（进主模型上下文）：OPEN + \\n + text + \\n + CLOSE。

    Args:
        text: 外部来源文本（网页正文/软件输出/RSS 摘要等）。
        source_url: 来源 URL（多结果场景可传 ''——调用方另附 engine 等）。
        channel: 通道标识（rss/html/urllib/window/software…）。
        fetched_at: 抓取时间（ISO8601；缺省 _utc_now()）。

    Returns:
        str: 包裹后文本（原文一字不改——包裹只增标记，禁改写内容）。
    """
    ts = str(fetched_at or '').strip() or _utc_now()
    open_tag = UNTRUSTED_OPEN_FMT.format(url=str(source_url or ''),
                                         ts=ts,
                                         channel=str(channel or ''))
    return '%s\n%s\n%s' % (open_tag, str(text if text is not None else ''),
                           UNTRUSTED_CLOSE)


def tag_payload(payload, source_url='', channel='', fetched_at='', source=None):
    """dict 载荷纯增键（原键不动）：``untrusted`` + ``source``。

    Args:
        payload: 待标记载荷（browser_search/browser_open/software_call 的
            成功 dict）。非 dict 原样返回（防御性，不抛）。
        source_url: 来源 URL（缺省 ''）。
        channel: 通道标识（缺省 ''）。
        fetched_at: 抓取时间（缺省 '' → 标记时取 _utc_now()）。
        source: 显式 source dict（原样采用）——搜索场景多结果无单一 URL，
            附 ``{'engine', 'query_sha256'[:16], 'fetched_at'}``（禁原文
            query 进载荷键——隐私口径与审计一致）；软件场景附
            ``{'software', 'action'}``。

    键冲突保护（v1.9.0 M2.2 接线实测）：既有载荷可能已占用 ``source`` 键且
    为字符串（browser_search 的 ``'live'|'cache'`` 来源语义，契约面）——
    此时 provenance 摘要改落 ``provenance`` 键（**禁覆盖契约键**）；
    ``source`` 键不存在或已是 dict 时才落 ``source``。前端渲染以
    ``untrusted`` 为主开关，两个键都认。

    Returns:
        dict: 同一 payload（纯增 ``untrusted=True`` 与来源摘要键；
            既有键与值零改动）。
    """
    if not isinstance(payload, dict):
        return payload
    payload['untrusted'] = True
    # R44：注入嫌疑预筛（spotlighting 精简版）——扫描载荷文本字段，命中时
    # 纯增 injection_suspect 键（不改内容一字；模型据此对外部内容降权）。
    try:
        blob = ' '.join(str(v) for k, v in payload.items()
                        if isinstance(v, str) and k not in ('url',))
        hits = scan_injection(blob)
        if hits:
            payload['injection_suspect'] = hits
    except Exception:
        pass    # 预筛失败不阻断 provenance 主语义
    prov = dict(source) if isinstance(source, dict) else {
        'url': str(source_url or ''),
        'channel': str(channel or ''),
        'fetched_at': str(fetched_at or '').strip() or _utc_now(),
    }
    existing = payload.get('source')
    if existing is None or isinstance(existing, dict):
        payload['source'] = prov
    else:
        payload['provenance'] = prov      # 禁覆盖契约 source 字符串键
    return payload
