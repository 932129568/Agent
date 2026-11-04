# -*- coding: utf-8 -*-
"""模型服务商服务（v1.2 R6）：OpenAI 兼容端点连通性测试。

provider 抽象原则（PRD R6）：
- GLM 保持默认，自定义端点是 opt-in；
- 端点配置（Base URL / Key / 模型名 / 价格）存 config.json 新增键
  （save_config 合并逻辑已支持，契约差分只比对测试写入的键，不受影响）；
- token 统计与计费按服务商返回的 usage 字段适配（usage 结构 OpenAI 兼容端点一致，
  价格差异由前端价格表按模型名/自定义配置解析）；
- 测试连接走后端 urllib（避免 WebView 前端跨域限制）。
"""
import json

from ...logging_setup import get_logger
from ..integrations.mcp.mcp_transport_http import urlopen_no_redirect   # 修复 S15：禁自动重定向，防凭证跨域泄漏


def normalize_base_url(url):
    """归一化 Base URL：去首尾空白与斜杠；空返回 ''。不猜测 /v1（由用户/预设负责）。"""
    u = str(url or '').strip().rstrip('/')
    return u


def chat_completions_url(base_url):
    base = normalize_base_url(base_url)
    if not base:
        return ''
    if base.endswith('/chat/completions'):
        return base
    return base + '/chat/completions'


class ProviderService:
    def __init__(self):
        self._log = get_logger()

    def test_endpoint(self, base_url, api_key, model, timeout=15):
        """向 OpenAI 兼容端点发一次最小 chat 请求，返回连通性结果。

        返回 {ok: true, model, reply} 或 {ok: false, error, status}。
        """
        url = chat_completions_url(base_url)
        if not url:
            return json.dumps({'ok': False, 'error': '缺少 Base URL'}, ensure_ascii=False)
        if not str(api_key or '').strip():
            return json.dumps({'ok': False, 'error': '缺少 API Key'}, ensure_ascii=False)
        if not str(model or '').strip():
            return json.dumps({'ok': False, 'error': '缺少模型名'}, ensure_ascii=False)
        body = json.dumps({
            'model': str(model).strip(),
            'messages': [{'role': 'user', 'content': 'ping'}],
            'max_tokens': 5,
            'stream': False,
        }).encode('utf-8')
        # 修复 S15：http:// 明文端点显式警告（API Key 明文出网）
        insecure_warn = None
        if url.lower().startswith('http://'):
            insecure_warn = ('当前端点是 http:// 明文传输，API Key 会暴露给网络中间人，'
                             '强烈建议改用 https://')
            self._log.warning('provider 测试端点为 http 明文: %s', url)
        try:
            import urllib.request
            import urllib.error
            req = urllib.request.Request(url, data=body, method='POST', headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + str(api_key).strip(),
            })
            try:
                with urlopen_no_redirect(req, timeout=timeout) as resp:
                    # 修复 建议㉒（二轮）：读全量无上限 → 64KB 上限（病态端点回吐 GB 级会 OOM）
                    raw = resp.read(64 * 1024)
                    try:
                        data = json.loads(raw.decode('utf-8', 'replace'))
                    except Exception as je:
                        return json.dumps({'ok': False, 'status': resp.status,
                                           'error': '响应不是合法 JSON: %s' % je},
                                          ensure_ascii=False)
                    # 修复 建议㉔：HTTP 200 但结构异常不再静默吞错
                    if not isinstance(data, dict) or 'choices' not in data:
                        return json.dumps({'ok': False,
                                           'error': 'HTTP 200 但响应结构异常（非 OpenAI 兼容格式）: '
                                                    + json.dumps(data, ensure_ascii=False)[:120]},
                                          ensure_ascii=False)
                    reply = ''
                    try:
                        reply = data['choices'][0]['message'].get('content', '') or ''
                    except Exception:
                        pass
                    out = {'ok': True, 'url': url, 'model': model,
                           'reply': str(reply)[:80]}
                    if insecure_warn:
                        out['warning'] = insecure_warn
                    return json.dumps(out, ensure_ascii=False)
            except urllib.error.HTTPError as e:
                snippet = ''
                try:
                    snippet = e.read(64 * 1024).decode('utf-8', 'replace')[:300]   # 修复 N20（四轮）：错误体有界读
                except Exception:
                    pass
                hint = humanize_http_error(e.code, snippet)
                # 429/1113 等账号侧错误：人话与服务端原文并列（用户可分辨是限流还是余额）
                detail = ('%s；服务端返回：%s' % (hint, snippet[:160])) if (hint and snippet) else (hint or snippet)
                out = {'ok': False, 'error': 'HTTP %d: %s' % (e.code, detail),
                       'status': e.code}
                # 修复（2026-10-21 用户实测 P0）：1211/404-model 时顺带拉取该 Key
                # 的可用模型清单附在响应里——用户点一次「测试连接」就直接看到
                # 「这些模型可用」，不用再去猜模型名（GLM 的 4xx 无 CORS 头，前端
                # 发送路径看不到真因，这个后端通道是唯一信息入口）。
                if '1211' in snippet or ('model' in snippet.lower()
                                         and ('not' in snippet.lower() or '不存在' in snippet)):
                    try:
                        from .local_model_service import models as _list_models
                        lst = _list_models(_models_base(url), timeout=8.0, api_key=str(api_key or ''))
                        if lst.get('ok') and lst.get('models'):
                            ids = [m['id'] for m in lst['models'] if m.get('id')][:20]
                            if ids:
                                out['available_models'] = ids
                    except Exception:
                        pass          # 清单拉取失败不掩盖原始错误
                return json.dumps(out, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'ok': False, 'error': '连接失败: %s' % e}, ensure_ascii=False)


def _models_base(url):
    """从 chat/completions URL 派生 models 清单 URL（剥 /chat/completions 与
    既有 /models 后缀）——1211 救援附清单用。"""
    u = str(url or '').rstrip('/')
    if u.endswith('/chat/completions'):
        u = u[:-len('/chat/completions')]
    if u.endswith('/models'):
        u = u[:-len('/models')]
    return u + '/models'


def humanize_http_error(status, body=''):
    """常见 HTTP 错误码人话映射（与前端 humanizeApiError 保持一致口径）。"""
    if status == 401:
        return 'API Key 无效或未授权'
    if status == 403:
        return '无权访问该端点（Key 权限不足或 IP 限制）'
    # 修复（2026-10-21 用户实测 P0）：GLM 1211 = 模型不存在/已下线/Key 无权限。
    # 前端 fetch 对该 4xx 会因响应无 CORS 头被 EdgeWebView 吞成 Failed to fetch，
    # 测试连接走后端通道是本环境下用户唯一能看到真因的入口——人话直接给换模型出路。
    b = str(body or '').lower()
    if '1211' in b or ('model' in b and ('无权限' in b or '未授权' in b or '不可用' in b)):
        return ('模型不可用（GLM 1211）：该模型不存在、已下线，或当前 Key 无访问权限。'
                '请点「获取模型」拉取可用清单换模型（如 glm-4.5），或切换到本地模型预设')
    if status == 404:
        # 修复（2026-10-21 用户实测反馈）：同一 404 两种病因——Base URL 错 vs
        # 模型已下线（GLM 等端点对下线模型返回 404 model not found，请求体带
        # model）。按 body 特征分流，避免误导用户去查本来正确的 Base URL。
        b = str(body or '').lower()
        if 'model' in b and ('not' in b or 'exist' in b or '下线' in b or 'deprecat' in b):
            return ('模型不存在或已下线：请更换模型（可点「获取模型」刷新清单，'
                    '或手动输入其他模型名）')
        return '端点地址不存在（请检查 Base URL 是否需要 /v1 后缀）'
    if status == 429:
        # 1113 优先：智谱把「余额不足」也报成 429，先于通用限流文案分流
        if '1113' in str(body or ''):
            pass    # 落到下方 1113 专属分支（带换模型出路）
        else:
            return '请求过于频繁（限流）：稍后重试，或改用免费 flash 系模型（限流额度更高）'
    # 修复 建议㉒（二轮）：307/308 重定向人话（禁重定向下端点配置了跳转时用户看得懂）
    if status in (307, 308):
        return '端点返回 %d 重定向（已禁跟随以防凭证跨域泄漏）；请在 Base URL 中直接填写最终地址' % status
    # 1113 实测两种病因（2026-11-04 用户报障「glm-4.5 接不通」）：Coding Plan
    # Key 直连被拒、或按量账户余额不足。二者都给出路：换免费 flash 系（同一
    # 个 Key 下 glm-4.5-flash / glm-4-flash 可用），或去充值/Coding 专享 Key。
    b13 = str(body or '')
    if '1113' in b13:
        if 'coding' in b13.lower():
            return ('GLM Coding Plan Key 仅限官方工具调用，API 直连请换按量付费 Key；'
                    '或直接改用免费模型 glm-4.5-flash / glm-4-flash（本 Key 即可用）')
        return ('该模型需要账户余额（1113 余额不足）。同一 Key 下免费模型可直接用：'
                '请切换 glm-4.5-flash / glm-4-flash；确需付费模型请到开放平台充值')
    return ''
