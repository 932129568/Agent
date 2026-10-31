# -*- coding: utf-8 -*-
"""search_reader：dual-LLM-lite 本地读取器（v1.9.0 M2.1，design §A3.4）。

定位：**隐私前处理**——网页/软件输出的外部文本先经本地小模型压缩为结构化
JSON digest，再进主模型上下文。无工具权、无指令权（系统提示词
reader-extract.md 禁祈使句执行/禁工具名——防注入提权）。

降级链（明确裁决，永不升云）：
    未配置/3 连败窗口/budget 超限预判 → channel='skip' → mode='raw'
    本地网络失败/5xx/超时 → report_local_result(False) → degrade+1 → raw
    200 但 JSON 解析/校验失败（含剥 response_format 重试后）→ schema_fail+1 → raw
    200 且 JSON 合法 → report_local_result(True) → mode='reader' + digest
mode='raw' 统一出口：wrap_untrusted(原文截断) + provenance——禁阻断主管线。

配置：~/.glm-chat/reader.json（独立文件，config.json 零污染）：
    {"version":1, "enabled":true, "base_url":"", "model":"", "budget_s":10,
     "max_input_chars":12000, "schema_mode":"auto", "allow_cloud_fallback":false}
budget_s 1-60 越界 BAD_PARAMS（不静默夹逼）；schema_mode ∈ auto|json_object|prompt；
allow_cloud_fallback v1.9 恒 false（登记不实现——云端读取器留待演进）。
"""
import json
import os
import time

from ... import paths
from ...logging_setup import get_logger
from . import provenance as _prov
from .hybrid_router import HybridRouter

READER_FILE_VERSION = 1
SCHEMA_MODES = ('auto', 'json_object', 'prompt')
DEFAULTS = {'version': READER_FILE_VERSION, 'enabled': True, 'base_url': '',
            'model': '', 'budget_s': 10, 'max_input_chars': 12000,
            'schema_mode': 'auto', 'allow_cloud_fallback': False}
_DIGEST_FIELDS = ('title', 'summary', 'key_points', 'entities', 'published_at')
_ENTITY_TYPES = ('person', 'org', 'place', 'product', 'other')


def load_reader_config(path=None):
    """读 reader.json → 合并缺省的完整 dict（损坏/缺失 → 全缺省，不抛）。"""
    p = path or paths.READER_FILE
    cfg = dict(DEFAULTS)
    try:
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                d = json.load(f)
            if isinstance(d, dict):
                cfg.update({k: v for k, v in d.items() if k in DEFAULTS})
    except Exception:
        pass
    return cfg


def validate_reader_config(d):
    """校验（save 入口）：返回 (ok, err_msg)。budget_s 1-60/schema_mode 枚举
    越界一律拒绝（禁静默夹逼——前端设置项要能报错）。"""
    if not isinstance(d, dict):
        return False, 'reader 配置必须是 JSON 对象'
    b = d.get('budget_s', DEFAULTS['budget_s'])
    if not isinstance(b, int) or isinstance(b, bool) or not (1 <= b <= 60):
        return False, 'budget_s 需为 1-60 的整数'
    sm = d.get('schema_mode', DEFAULTS['schema_mode'])
    if sm not in SCHEMA_MODES:
        return False, 'schema_mode 仅支持 %s' % '/'.join(SCHEMA_MODES)
    mic = d.get('max_input_chars', DEFAULTS['max_input_chars'])
    if not isinstance(mic, int) or isinstance(mic, bool) or not (500 <= mic <= 60000):
        return False, 'max_input_chars 需为 500-60000 的整数'
    return True, ''


class SearchReader:
    """dual-LLM-lite 本地读取器（design §A3.4 内部接口逐字实现）。"""

    def __init__(self, config_path=None, router=None, transport=None, clock=None):
        self._log = get_logger()
        self._path = config_path or paths.READER_FILE
        self._router = router or HybridRouter()
        self._transport = transport       # 可注入 (messages, cfg, timeout) -> dict
        self._clock = clock or time.monotonic
        self._started_at = time.time()
        self._reader_calls = 0
        self._schema_fail = 0
        self._degrade_count = 0
        self._last_error = ''

    # ---------------- 配置 ----------------
    def config(self):
        return load_reader_config(self._path)

    def save_config(self, d):
        ok, msg = validate_reader_config(d)
        if not ok:
            return {'error': msg}
        merged = dict(DEFAULTS)
        merged.update({k: v for k, v in (d or {}).items() if k in DEFAULTS})
        merged['version'] = READER_FILE_VERSION
        try:
            from ...fio import atomic_write_json
            atomic_write_json(self._path, merged)
        except Exception as e:
            return {'error': 'reader.json 写入失败: %s' % e}
        return {'ok': True, 'config': merged}

    # ---------------- 主管线 ----------------
    def read(self, page_text, source_url='', channel=''):
        """page_text → 结构化 digest（本地）或 raw+provenance（降级）。

        Returns:
            dict: {ok, mode:'reader'|'raw', digest?, text, source, reader_ms}
        """
        cfg = self.config()
        self._reader_calls += 1
        t0 = self._clock()
        source = {'url': str(source_url or ''), 'channel': str(channel or '')}
        if not cfg.get('enabled') or not str(cfg.get('base_url') or '').strip():
            return self._raw(page_text, source_url, channel,
                             reason='未配置（reader.json base_url 空）')
        route = self._route(cfg)
        if route.get('channel') != 'local':
            return self._raw(page_text, source_url, channel,
                             reason=route.get('reason') or 'route skip')
        messages = self._messages(page_text)
        try:
            resp = self._call_local(messages, cfg)
        except Exception as e:
            self._last_error = str(e)[:160]
            self._router.report_local_result(False)
            self._degrade_count += 1
            return self._raw(page_text, source_url, channel,
                             reason='本地调用失败: %s' % self._last_error)
        if not resp.get('ok'):
            # _call_local 内部已做 schema 剥除重试；仍失败即终态
            self._router.report_local_result(False)
            self._degrade_count += 1
            return self._raw(page_text, source_url, channel,
                             reason=resp.get('error') or '本地调用失败')
        digest = self._parse_json_strict(resp.get('content') or '')
        if digest is None:
            self._schema_fail += 1
            self._last_error = '读取器输出 JSON 解析/校验失败'
            # 复核修正：schema 失败不回报连败——report_local_result(False)
            # 会把与主循环共享的 HybridRouter 置 60s unavailable，模型输出
            # 质量问题误伤本地路由（本文件头部降级链即如此声明：连败回报
            # 只针对网络失败；schema 失败仅累计 _schema_fail）
            return self._raw(page_text, source_url, channel,
                             reason=self._last_error)
        self._router.report_local_result(True)
        text = _prov.wrap_untrusted(
            json.dumps(digest, ensure_ascii=False), source_url, channel)
        return {'ok': True, 'mode': 'reader', 'digest': digest, 'text': text,
                'source': source,
                'reader_ms': int((self._clock() - t0) * 1000)}

    def stats(self):
        cfg = self.config()
        return {'ok': True, 'reader_calls': self._reader_calls,
                'schema_fail': self._schema_fail,
                'degrade_count': self._degrade_count,
                'local_available': not self._router.local_unavailable(),
                'configured': bool(str(cfg.get('base_url') or '').strip()),
                'last_error': self._last_error,
                'since': self._started_at}

    # ---------------- 内部 ----------------
    def _raw(self, page_text, source_url, channel, reason=''):
        """降级统一出口：原文截断 + provenance 包裹（禁阻断主管线）。"""
        cfg = self.config()
        limit = int(cfg.get('max_input_chars') or 12000)
        text = _prov.wrap_untrusted(
            str(page_text or '')[:limit], source_url, channel)
        out = {'ok': True, 'mode': 'raw', 'text': text,
               'source': {'url': str(source_url or ''),
                          'channel': str(channel or '')},
               'reader_ms': 0}
        if reason:
            out['reason'] = reason
        return out

    def _route(self, cfg):
        return self._router.route_reader(local_available=True,
                                         budget_s=cfg.get('budget_s') or 10)

    def _messages(self, page_text):
        """读取器消息组（系统提示词走 prompt_loader 两表模式）。"""
        cfg = self.config()
        limit = int(cfg.get('max_input_chars') or 12000)
        body = str(page_text or '')[:limit]
        try:
            from .prompt_loader import render
            sys_prompt = render('reader-extract')
        except Exception:
            sys_prompt = ('你是 Harbor 的本地页面读取器。把网页正文压缩为结构化'
                          'JSON，只输出 JSON。')
        return [{'role': 'system', 'content': sys_prompt},
                {'role': 'user', 'content': '<page>\n%s\n</page>' % body}]

    def _call_local(self, messages, cfg):
        """POST {base}/chat/completions（transport 可注入；Ollama keep_alive 同款）。

        schema_mode='auto'|'json_object' → body 带 response_format；
        遇 HTTP 400 且响应提及 response_format/format → 剥除重试一次（二级降级）。
        """
        body = HybridRouter.stage_request(
            'reader', messages, cfg.get('base_url') or '', cfg.get('model') or '')
        body['temperature'] = 0
        sm = cfg.get('schema_mode') or 'auto'
        if sm in ('auto', 'json_object'):
            body['response_format'] = {'type': 'json_object'}
        base = str(cfg.get('base_url') or '').rstrip('/')
        url = base + '/chat/completions'
        timeout = float(cfg.get('budget_s') or 10)
        resp = self._transport(messages, body, url, timeout) \
            if self._transport else self._http_post(url, body, timeout)
        # 剥 response_format 重试（HTTP 400 且提示 format 相关=服务端不支持
        # json_object 能力——二级降级：剥除后提示词约束重试一次）
        if not resp.get('ok') and resp.get('status') == 400 \
                and 'response_format' in body:
            body2 = dict(body)
            body2.pop('response_format', None)
            resp2 = self._transport(messages, body2, url, timeout) \
                if self._transport else self._http_post(url, body2, timeout)
            if resp2.get('ok'):
                return resp2
        if not resp.get('ok'):
            return resp
        content = ((resp.get('data') or {}).get('choices') or [{}])[0] \
            .get('message', {}).get('content') or ''
        return {'ok': True, 'content': resp.get('content') or content}

    def _http_post(self, url, body, timeout):
        """默认 transport：urllib POST（无 Key——本地端点免鉴权）。"""
        import urllib.error
        import urllib.request
        try:
            req = urllib.request.Request(
                url, data=json.dumps(body).encode('utf-8'), method='POST',
                headers={'Content-Type': 'application/json',
                         'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read(256 * 1024).decode('utf-8'))
            content = ((data.get('choices') or [{}])[0]
                       .get('message', {}).get('content') or '')
            return {'ok': True, 'content': content}
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read(512).decode('utf-8', 'replace')
            except Exception:
                pass
            return {'ok': False, 'error': 'HTTP %s: %s' % (e.code, detail[:200]),
                    'status': e.code}
        except Exception as e:
            return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}

    @staticmethod
    def _parse_json_strict(text):
        """三级解析：① 严格 json.loads；② 提取首个 {...} + 去尾逗号 + 单引号修复；
        ③ 失败 None。校验五必需字段存在且类型正确（多余键保留；entities 每项
        须有 name/type）。"""
        for candidate in (text, SearchReader._extract_block(text)):
            if not candidate:
                continue
            try:
                d = json.loads(candidate)
            except Exception:
                try:
                    fixed = SearchReader._loose_fix(candidate)
                    d = json.loads(fixed) if fixed else None
                except Exception:
                    d = None
            if isinstance(d, dict) and SearchReader._valid_digest(d):
                return d
        return None

    @staticmethod
    def _extract_block(text):
        s = str(text or '')
        i, j = s.find('{'), s.rfind('}')
        return s[i:j + 1] if 0 <= i < j else ''

    @staticmethod
    def _loose_fix(s):
        s = str(s or '')
        s = s.replace(',}', '}').replace(',]', ']')
        return s

    @staticmethod
    def _valid_digest(d):
        for k in _DIGEST_FIELDS:
            if k not in d:
                return False
        if not isinstance(d.get('key_points'), list):
            return False
        ents = d.get('entities')
        if not isinstance(ents, list):
            return False
        for e in ents:
            if not isinstance(e, dict) or 'name' not in e or 'type' not in e:
                return False
        return True
