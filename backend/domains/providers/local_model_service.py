# -*- coding: utf-8 -*-
"""本地大模型服务（v1.5.0 预留接口层）：连接层 A + 适配层 B 的接口契约与占位实现。

架构决策（roadmap-local-llm-mcp-2026-10-17 §核心结论）：只连接、不内嵌推理——
内嵌 llama.cpp 与零依赖/onefile/Python 3.10 三条铁律全冲突；本地服务器
（Ollama / LM Studio / vLLM / llama.cpp server / LocalAI）均暴露 OpenAI 兼容端点，
复用 v1.2 R6 provider 抽象即可。本服务是「本地模式」的专属接口层：

- 连接层 A（A1-A5）：预设表 / 并行探测 / 模型清单 / 元数据表 / 本地计费与测试连接；
- 适配层 B（B1-B5）：上下文窗口自适应阈值 / 工具能力降级判定 / 慢推理状态分类 /
  Ollama 特情人话映射 / 本地模式 MCP 保守策略标记——以纯函数与判定接口形式预留，
  Agent 主链路侧的编排（B3 流式 watchdog、B5 确认文案注入）留在后续迭代接线。

契约红线（roadmap §7 横切工程纪律）：
- js_api 新方法（local_probe/local_models）全部登记 _V12_EXTRA，get_api_info 零漂移；
- config.json 新键 local_*（local_mode/local_base_url/local_model/local_ctx_window/
  local_tool_capable）运行期合法、测试期不触发——本服务只提供校验函数
  （validate_local_prefs），不直接读写 config.json；
- 探测/清单走 urlopen_no_redirect（复用 S15 安全口径：禁重定向；localhost 免 Key，
  http:// 明文仅限回环，远端 local 端点仍建议 https）。

占位约定：函数 docstring 标注 [预留] 者，其签名与返回 shape 为终态——后续迭代只填
内部实现，不改签名；当前实现为安全默认值或结构化 reserved 应答。
"""
import json
import time
import urllib.error
import urllib.parse   # 修复 ⑬（三轮）：显式导入——原仅 import urllib.request 隐式带入
# urllib.parse（靠 urllib.request 的内部依赖传递），_fetch_tags_meta 的
# urllib.parse.urlsplit 属于隐式依赖，模块裁剪/重构时即 NameError
import urllib.request

from ...logging_setup import get_logger
from ..integrations.mcp.mcp_transport_http import urlopen_no_redirect   # 修复 S15：禁自动重定向

# ================= 类型定义（参数结构与返回 shape，终态）=================

# 探测结果单项（A2）：{base_url, kind, reachable, models[], latency_ms, error?}
#   base_url   : str  归一化后的 OpenAI 兼容 Base URL（含 /v1 或服务器实际路径）
#   kind       : str  预设名（ollama/lmstudio/vllm/llamacpp/localai/custom）
#   reachable  : bool 端口是否存活
#   models     : list[str] 模型 id 清单（探测成功时尽力解析，失败为 []）
#   latency_ms : int  握手耗时（毫秒）
#   error      : str? 失败原因（reachable=False 时有人话）
#
# probe() 返回：{ok: True, reachable: [...], unreachable: [...], elapsed_ms: int}
#
# models() 返回：{ok: True, base_url, models: [{id, ctx_window, tool_capable, estimated}]}
#   ctx_window   : int  上下文窗口（tokens）；未知模型保守默认 8192 且 estimated=True
#   tool_capable : bool 是否可能支持工具调用（未知默认 False——保守侧）
#   estimated    : bool 该行元数据是否为估计值（用户可手动覆盖）
#
# test_local_endpoint() 返回：{ok, url, model, reply?, state?, error?}
#   state : 'loading'（Ollama 503 模型加载中）/ 'ready'（正常应答）
#
# classify_local_error() 返回：{kind, message, retryable, retry_after?}
#   kind: 'loading' | 'model_not_found' | 'context_length' | 'tools_unsupported' | 'generic'

# ================= A1 · 本地端点预设表（终态数据契约）=================

LOCAL_PRESETS = {
    'ollama': {
        'name': 'Ollama',
        'base_url': 'http://localhost:11434/v1',
        'port': 11434,
        'key_required': False,
        'note': 'Ollama 本地服务；模型名如 qwen2.5:7b，首次提问可能需 10-60s 加载',
    },
    'lmstudio': {
        'name': 'LM Studio',
        'base_url': 'http://localhost:1234/v1',
        'port': 1234,
        'key_required': False,
        'note': 'LM Studio 本地服务器；在软件内先加载模型再连接',
    },
    'vllm': {
        'name': 'vLLM',
        'base_url': 'http://localhost:8000/v1',
        'port': 8000,
        'key_required': False,
        'note': 'vLLM OpenAI 兼容服务；工具调用能力取决于所加载模型',
    },
    'llamacpp': {
        'name': 'llama.cpp server',
        'base_url': 'http://localhost:8080/v1',
        'port': 8080,
        'key_required': False,
        'note': 'llama.cpp server；上下文窗口由启动参数 -c 决定',
    },
    'localai': {
        'name': 'LocalAI',
        'base_url': 'http://localhost:8080/v1',
        'port': 8080,
        'key_required': False,
        'note': 'LocalAI（与 llama.cpp server 同默认端口，二选一）',
    },
    # 实现 FreeToken preset（2026-10-20 用户实需求）：FreeToken Desktop 本地模型
    # 管理器，API 代理 OpenAI 兼容（免 Key）；单模型语义——一次只暴露当前启动
    # 的引擎，切换模型需在 FreeToken Desktop 操作。真机取证：/v1/models +
    # /chat/completions 实测通。
    'freetoken': {
        'name': 'FreeToken Desktop',
        'base_url': 'http://127.0.0.1:1919/v1',
        'port': 1919,
        'key_required': False,
        'note': 'FreeToken Desktop；在软件内启动模型后连接（一次运行一个模型，切换请在 FreeToken 操作）',
    },
}

# A2：并行探测的默认端口表（Ollama/LMStudio/vLLM/llama.cpp；LocalAI 与 llama.cpp 同端口）
PROBE_PORTS = (11434, 1234, 8000, 8080, 1919)
PROBE_PORT_TIMEOUT = 2.0        # 单端口超时（秒）——总墙钟 ≤1s 目标的输入
PROBE_WALL_BUDGET = 1.0         # 总墙钟预算提示值（roadmap §3.3）

# ================= A3 · 本地模型元数据表（ctx 窗口 / 工具能力）=================

# 精确名 → 元数据；未知模型走前缀启发式 → 保守默认（三级来源，B1）
LOCAL_MODEL_META = {
    # qwen2.5 系 32k
    'qwen2.5:7b': {'ctx_window': 32768, 'tool_capable': True},
    'qwen2.5:14b': {'ctx_window': 32768, 'tool_capable': True},
    'qwen2.5:32b': {'ctx_window': 32768, 'tool_capable': True},
    # llama3.1 系 128k（8b 档常见 8k 量化变体）
    'llama3.1:8b': {'ctx_window': 8192, 'tool_capable': True},
    'llama3.1:70b': {'ctx_window': 131072, 'tool_capable': True},
    'llama3.1:405b': {'ctx_window': 131072, 'tool_capable': True},
    # mistral 7b 32k
    'mistral:7b': {'ctx_window': 32768, 'tool_capable': True},
    'mistral-nemo': {'ctx_window': 131072, 'tool_capable': True},
    # deepseek-r1 蒸馏系 64k
    'deepseek-r1:7b': {'ctx_window': 65536, 'tool_capable': False},
    'deepseek-r1:14b': {'ctx_window': 65536, 'tool_capable': False},
    'deepseek-r1:32b': {'ctx_window': 65536, 'tool_capable': False},
    # gemma2 8k
    'gemma2:9b': {'ctx_window': 8192, 'tool_capable': True},
    'gemma2:27b': {'ctx_window': 8192, 'tool_capable': True},
    # qwen2.5-coder 系 32k
    'qwen2.5-coder:7b': {'ctx_window': 32768, 'tool_capable': True},
    'qwen2.5-coder:14b': {'ctx_window': 32768, 'tool_capable': True},
    'phi3:mini': {'ctx_window': 4096, 'tool_capable': False},
    'phi3.5': {'ctx_window': 131072, 'tool_capable': True},
    'codellama:7b': {'ctx_window': 16384, 'tool_capable': False},
    'llama3:8b': {'ctx_window': 8192, 'tool_capable': True},
    # qwen3.5 系（2026-10-17 实测 qwen3.5-9b：Ollama /api/tags 声明 256k + tools）
    'qwen3.5-9b': {'ctx_window': 262144, 'tool_capable': True},
    'qwen3.5:9b': {'ctx_window': 262144, 'tool_capable': True},
}

# 前缀启发式（小写 contains 匹配，顺序即优先级——具体系必须在泛指系前）
_META_PREFIX_RULES = (
    ('qwen3.5', 262144, True),
    ('qwen35', 262144, True),
    ('qwen2.5-coder', 32768, True),
    ('qwen2.5', 32768, True),
    ('qwen3', 32768, True),
    ('llama3.1:8b', 8192, True),
    ('llama3.1', 131072, True),
    ('llama3', 8192, True),
    ('mistral-nemo', 131072, True),
    ('mistral', 32768, True),
    ('deepseek-r1', 65536, False),
    ('gemma2', 8192, True),
    ('phi3.5', 131072, True),
    ('phi3', 4096, False),
    ('codellama', 16384, False),
)

# 保守默认（roadmap A3：未知模型给保守默认 8k + 「可手动改」）
DEFAULT_LOCAL_META = {'ctx_window': 8192, 'tool_capable': False, 'estimated': True}

# ================= B1 · 上下文窗口自适应：压缩阈值 = 窗口 × 档位系数 =================

COMPACT_LEVEL_RATIO = {'aggressive': 0.4, 'std': 0.6, 'relaxed': 0.8}
DEFAULT_COMPACT_LEVEL = 'std'
# GLM 128k 现标准档 90k 的量级衔接参照（仅注释用，不参与计算）
GLM_STD_THRESHOLD_REF = 90000


def _local_hostname(url):
    """修复 S7（三轮）：取 URL hostname 小写（无端口）——供 localhost 豁免精确比较。
    子串匹配 'localhost' in base 可被 http://localhost.evil.com 绕过。"""
    try:
        s = str(url or '')
        u = urllib.parse.urlsplit(s if '://' in s else 'http://' + s)
        return (u.hostname or '').lower()
    except Exception:
        return ''


def normalize_base_url(url):
    """归一化 Base URL：去首尾空白与斜杠；空返回 ''。与 provider 服务同口径。"""
    return str(url or '').strip().rstrip('/')


def chat_completions_url(base_url):
    """拼 chat/completions 端点；已含则原样。"""
    base = normalize_base_url(base_url)
    if not base:
        return ''
    if base.endswith('/chat/completions'):
        return base
    return base + '/chat/completions'


def models_url(base_url):
    """拼模型清单端点：{base}/models（base 已含 /v1 时即 OpenAI 兼容清单）。"""
    base = normalize_base_url(base_url)
    if not base:
        return ''
    if base.endswith('/models'):
        return base
    return base + '/models'


def get_preset(name):
    """取预设（不存在返回 None）。"""
    return LOCAL_PRESETS.get(str(name or '').strip().lower())


def list_presets():
    """预设列表（前端下拉数据源；含 key_required 供 UI 提示）。"""
    return [dict({'key': k}, **v) for k, v in LOCAL_PRESETS.items()]


def model_meta(model, tags_meta=None):
    """A3/B1：模型元数据四级查找——精确表 → /api/tags 服务器声明 → 前缀启发式 → 保守默认。

    tags_meta：{模型名: {ctx_window, tool_capable}}（Ollama /api/tags 权威声明，
    见 _fetch_tags_meta）。服务器声明 estimated=False（非估计，用户可手设覆盖）。
    返回 {ctx_window, tool_capable, estimated}（estimated=True 表示估计值）。
    """
    m = str(model or '').strip().lower()
    if not m:
        return dict(DEFAULT_LOCAL_META)
    hit = LOCAL_MODEL_META.get(m)
    if hit:
        return {'ctx_window': hit['ctx_window'], 'tool_capable': hit['tool_capable'],
                'estimated': False}
    # 修复（2026-10-17 实测驱动）：/api/tags 服务器声明优先于前缀猜测——
    # 本地模型元数据的权威源在服务器侧（Ollama runner 报 context_length/capabilities）
    if tags_meta:
        for name, meta in tags_meta.items():
            n = str(name or '').strip().lower()
            if n and (m == n or m.startswith(n) or n in m):
                return {'ctx_window': meta['ctx_window'],
                        'tool_capable': meta['tool_capable'], 'estimated': False}
    for prefix, ctx, tool in _META_PREFIX_RULES:
        if m.startswith(prefix) or prefix in m:
            return {'ctx_window': ctx, 'tool_capable': tool, 'estimated': True}
    return dict(DEFAULT_LOCAL_META)


def _fetch_tags_meta(base_url, timeout=3):
    """修复（2026-10-17）：拉 Ollama /api/tags 权威元数据（ctx/tools 服务器声明）。

    仅 Ollama 系端点有该路径（11434 预设）；vLLM/LMStudio 等拉不到 → 静默 {}
    （调用方回落前缀启发式）。返回 {模型名: {ctx_window, tool_capable}}。
    """
    base = normalize_base_url(base_url)
    if not base:
        return {}
    u = urllib.parse.urlsplit(base if '://' in base else 'http://' + base)
    origin = '%s://%s' % (u.scheme or 'http', u.netloc)
    try:
        req = urllib.request.Request(origin + '/api/tags', method='GET',
                                     headers={'Accept': 'application/json'})
        with urlopen_no_redirect(req, timeout=timeout) as resp:
            raw = resp.read(256 * 1024)
        data = json.loads(raw.decode('utf-8', 'replace'))
    except Exception:
        return {}
    out = {}
    for m in (data.get('models') or []):
        if not isinstance(m, dict):
            continue
        name = m.get('name') or m.get('model')
        if not name:
            continue
        details = m.get('details') or {}
        caps = m.get('capabilities') or []
        ctx = details.get('context_length')
        try:
            ctx = int(ctx)
        except (TypeError, ValueError):
            ctx = 0
        if ctx <= 0:
            continue
        out[str(name)] = {'ctx_window': ctx,
                          'tool_capable': 'tools' in [str(c) for c in caps]}
    return out


def compact_threshold(ctx_window, level=DEFAULT_COMPACT_LEVEL):
    """B1：压缩触发阈值 = 模型窗口 × 档位系数（0.4/0.6/0.8）。

    ctx_window 非正数时回落 8192 保守值；level 非法时回落 std。
    GLM 128k × 0.6 = 76.8k，与现标准档 90k 量级衔接（roadmap B1）。
    """
    try:
        ctx = int(ctx_window)
    except (TypeError, ValueError):
        ctx = 0
    if ctx <= 0:
        ctx = DEFAULT_LOCAL_META['ctx_window']
    ratio = COMPACT_LEVEL_RATIO.get(str(level or DEFAULT_COMPACT_LEVEL),
                                    COMPACT_LEVEL_RATIO[DEFAULT_COMPACT_LEVEL])
    return int(ctx * ratio)


def classify_local_error(status, body=''):
    """B4：本地端点 HTTP 错误人话分类（humanize_http_error 的 local 分支）。

    覆盖 Ollama 特情与本地生态常见失败；返回 {kind, message, retryable, retry_after?}。
    """
    s = str(status)
    b = str(body or '').lower()
    if s == '503' or 'loading' in b or 'is loading' in b:
        return {'kind': 'loading', 'retryable': True, 'retry_after': [2, 4, 8],
                'message': '模型正在加载（Ollama 首次提问需 10-60s），已自动等待重试'}
    if s == '404':
        if 'model' in b or 'not found' in b:
            return {'kind': 'model_not_found', 'retryable': False,
                    'message': '模型不存在：请回到模型清单重新选择（模型名区分大小写）'}
        return {'kind': 'model_not_found', 'retryable': False,
                'message': '端点地址不存在（请检查 Base URL 是否需要 /v1 后缀）'}
    if s == '400':
        if 'context' in b and ('length' in b or 'too long' in b or 'exceed' in b
                               or 'maximum' in b):
            return {'kind': 'context_length', 'retryable': False,
                    'message': '请求超出模型上下文窗口：已按窗口比例提前压缩，'
                               '仍超窗请调小历史或换更大窗口模型'}
        if 'tool' in b or 'function' in b:
            return {'kind': 'tools_unsupported', 'retryable': True,
                    'message': '当前模型不支持工具调用，可去掉 tools 重发（纯对话模式）'}
        return {'kind': 'generic', 'retryable': False, 'message': '请求被拒绝（400）：' + b[:120]}
    if s == '401':
        return {'kind': 'generic', 'retryable': False,
                'message': '未授权（401）：本地服务器通常无需 Key，请清空 Key 重试'}
    return {'kind': 'generic', 'retryable': False, 'message': ''}


# ================= A2 · 并行探测（实现就绪；端口打桩在测试层覆盖）=================

def _probe_one(host, port, timeout):
    """单端口探测：GET http://{host}:{port}/models。返回探测结果单项。"""
    base = 'http://%s:%d/v1' % (host, port)
    kind = 'custom'
    for key, preset in LOCAL_PRESETS.items():
        if preset['port'] == port:
            kind = key
            break
    result = {'base_url': base, 'kind': kind, 'reachable': False,
              'models': [], 'latency_ms': 0}
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(models_url(base), method='GET',
                                     headers={'Accept': 'application/json'})
        with urlopen_no_redirect(req, timeout=timeout) as resp:
            raw = resp.read(256 * 1024)
        result['latency_ms'] = int((time.monotonic() - t0) * 1000)
        result['reachable'] = True
        result['models'] = _parse_model_list(raw)
    except Exception as e:
        result['latency_ms'] = int((time.monotonic() - t0) * 1000)
        result['error'] = _probe_error_text(e)
    return result


def _probe_error_text(exc):
    """探测失败原因人话（超时/拒绝/HTTP 错误/其他）。"""
    if isinstance(exc, urllib.error.HTTPError):
        return 'HTTP %s（端口有服务但非预期响应）' % exc.code
    text = str(exc)
    if 'timed out' in text or 'timeout' in text.lower():
        return '连接超时（端口无响应）'
    if 'Connection refused' in text or '10061' in text:
        return '端口未监听（服务未启动）'
    return text[:120] or '连接失败'


def _parse_model_list(raw):
    """解析三种模型清单形态：OpenAI {data:[{id}]} / {data:[str]} / Ollama {models:[{name}]}。"""
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
    except Exception:
        return []
    out = []
    if isinstance(data, dict):
        items = data.get('data')
        if items is None:
            items = data.get('models')
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict):
                    mid = it.get('id') or it.get('name')
                    if mid:
                        out.append(str(mid))
                elif isinstance(it, str):
                    out.append(it)
    return out


def probe(ports=None, host='127.0.0.1', timeout=PROBE_PORT_TIMEOUT):
    """A2：本地服务器并行探测（各 2s 超时，总墙钟 ≤1s 目标）。

    ports 为 None 时用 PROBE_PORTS。返回 {ok, reachable, unreachable, elapsed_ms}。
    线程池并发（stdlib ThreadPoolExecutor，零新依赖）；单端口失败不影响其余。
    """
    import concurrent.futures
    ports = list(ports) if ports else list(PROBE_PORTS)
    # 复核修正：js_api local_probe 对 ports 无上限/去重/类型过滤，超长数组
    # 经 max_workers=len(ports) 一次制造数万线程（探测风暴/内存耗尽）——
    # 服务层收敛：int 过滤 + 去重 + 封顶 16
    _seen, _clean = set(), []
    for _p in ports:
        try:
            _pi = int(_p)
        except (TypeError, ValueError):
            continue
        if 1 <= _pi <= 65535 and _pi not in _seen:
            _seen.add(_pi)
            _clean.append(_pi)
    ports = _clean[:16] or list(PROBE_PORTS)
    timeout = max(0.2, float(timeout or PROBE_PORT_TIMEOUT))
    t0 = time.monotonic()
    reachable, unreachable = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ports) or 1) as pool:
        futures = [pool.submit(_probe_one, host, p, timeout) for p in ports]
        for fut in futures:
            try:
                r = fut.result(timeout=timeout + 1.0)
            except Exception:
                continue
            (reachable if r.get('reachable') else unreachable).append(r)
    return {'ok': True, 'reachable': reachable, 'unreachable': unreachable,
            'elapsed_ms': int((time.monotonic() - t0) * 1000)}


def auth_header_value(api_key):
    """把用户 Key 归一化为可安全放进 HTTP 头的值（空 / 含控制字符 → ''）。

    合并后「连接与模型」单端点化：云端自定义端点（DeepSeek/Moonshot/通义…）的
    /models 清单需要鉴权，仍走后端 urlopen_no_redirect（禁重定向、Key 不出前端）。
    """
    key = str(api_key or '').strip()
    if not key:
        return ''
    if any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in key):
        return ''      # 头注入防护：控制字符一律忽略（等同未填 Key）
    return key


def models(base_url, timeout=5.0, api_key=''):
    """A3：补拉模型清单（探测过期时用）。返回 {ok, base_url, models[]}。

    models[] 每项 {id, ctx_window, tool_capable, estimated}——元数据内嵌，
    前端下拉直接可用（roadmap：新 js_api 只有 local_probe/local_models 两个）。

    api_key 可选（v4 连接合并）：非空时请求带 `Authorization: Bearer {key}`，
    供云端 OpenAI 兼容端点（DeepSeek/Moonshot/通义/vLLM 网关）拉清单；为空时
    与 v1.5 行为逐字节一致（本地服务器免 Key，单参调用向后兼容）。

    实现 v1.6 T2：GitHub Models 目录探测——host 为 models.github.ai 时走
    catalog 分支（GET {scheme}://{host}/catalog/models，响应结构
    {models:[{id,name,context_window,modalities}]} 与 OpenAI /models 不同），
    在同一 js_api 内分流（零新 js_api，前端无感知）；其余 host 行为不变。
    """
    if _is_github_catalog_host(base_url):
        return github_catalog_models(base_url, timeout=timeout, api_key=api_key)
    url = models_url(base_url)
    if not url:
        return {'ok': False, 'error': '缺少 Base URL'}
    headers = {'Accept': 'application/json'}
    token = auth_header_value(api_key)
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        req = urllib.request.Request(url, method='GET', headers=headers)
        with urlopen_no_redirect(req, timeout=timeout) as resp:
            raw = resp.read(256 * 1024)
    except Exception as e:
        return {'ok': False, 'error': '获取模型清单失败: %s' % _probe_error_text(e)}
    ids = _parse_model_list(raw)
    if not ids:
        return {'ok': False, 'error': '未能解析模型清单（响应不是已知的 OpenAI/Ollama 形态）'}
    # 修复（2026-10-17 实测驱动）：Ollama 系端点补拉 /api/tags 权威元数据
    # （ctx/tools 服务器声明优先于前缀猜测；拉不到静默回落）
    # 修复 N16（四轮）：/api/tags 是 Ollama 本地接口——原对所有端点（含云端）都追加
    # 一次无鉴权跨网请求（远端 404/超时静默吞但浪费请求+至多 3s 延迟）。
    # 仅回环主机（Ollama 场景）才拉。
    tags = _fetch_tags_meta(base_url) if _local_hostname(base_url) in (
        'localhost', '127.0.0.1', '::1') else None
    return {'ok': True, 'base_url': normalize_base_url(base_url),
            'models': [dict({'id': mid}, **model_meta(mid, tags)) for mid in ids]}


# ================= v1.6 T2 · GitHub Models 目录探测（catalog 分支）=================
# 外部核实（2026-10，方案 §9）：目录端点 https://models.github.ai/catalog/models
# （与推理端点 /inference 不同主机路径）；模型 ID 为 provider/model 格式（裸名
# 校验失败）；目录含 DeepSeek-R1；免费层限额约 15 RPM/150 RPD。

GITHUB_CATALOG_HOST = 'models.github.ai'


def _is_github_catalog_host(base_url):
    """base_url 的 host 为 GitHub Models 目录宿主 → 走 catalog 分支。"""
    try:
        host = (urllib.parse.urlsplit(str(base_url or '')).hostname or '').lower()
    except Exception:
        return False
    return host == GITHUB_CATALOG_HOST


def _github_catalog_url(base_url):
    """从推理 base_url 派生目录 URL：{scheme}://{host}/catalog/models。"""
    u = urllib.parse.urlsplit(str(base_url or ''))
    scheme = u.scheme or 'https'
    host = u.hostname or GITHUB_CATALOG_HOST
    return '%s://%s/catalog/models' % (scheme, host)


def _github_catalog_error(exc):
    """catalog 请求异常 → 人话（401/403 引导 PAT scope，429 限流，其余通用）。"""
    if isinstance(exc, urllib.error.HTTPError):
        code = exc.code
        if code == 401:
            return ('GitHub PAT 无效或未授权（401）：请检查 Token 是否正确、'
                    '是否勾选 models:read scope（github.com/settings/tokens）')
        if code == 403:
            return '无权访问 GitHub 模型目录（403）：PAT 可能缺少 models:read scope'
        if code == 429:
            return 'GitHub 目录请求被限流（429）：稍后重试，或先用预设推荐模型'
        return 'GitHub 目录请求失败（HTTP %s）' % code
    text = str(exc)
    if 'timed out' in text or 'timeout' in text.lower():
        return 'GitHub 目录连接超时'
    return 'GitHub 目录请求失败: %s' % (text[:120] or '连接失败')


def _parse_github_catalog(raw):
    """解析目录响应 → [{id, ctx_window, modalities}]；裸名（无 '/'）过滤。

    容错：context_window 接受 context_window/context_length/max_context 别名；
    modalities 接受 list 或字符串。返回 [] = 结构不符（调用方出人话错误）。
    """
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    items = data.get('models')
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        mid = it.get('id') or it.get('name')
        if not mid:
            continue
        mid = str(mid).strip()
        if '/' not in mid:
            continue          # 外部核实：裸名会校验失败，过滤
        ctx = 0
        for k in ('context_window', 'context_length', 'max_context'):
            try:
                ctx = int(it.get(k) or 0)
            except (TypeError, ValueError):
                ctx = 0
            if ctx > 0:
                break
        mods = it.get('modalities')
        if isinstance(mods, str):
            mods = [m.strip() for m in mods.split(',') if m.strip()]
        elif isinstance(mods, list):
            mods = [str(m).strip() for m in mods if str(m).strip()]
        else:
            mods = []
        out.append({'id': mid, 'ctx_window': ctx, 'modalities': mods})
    return out


def _parse_github_models_list(raw):
    """实现 v1.6 遗留 L2：OpenAI 标准清单格式（{object:'list', data:[{id,...}]}）
    解析 —— GitHub /inference/models 路径的兜底格式（外部源对目录接口的描述
    在部分网络环境下不可信：实测无认证时 /catalog/models 返回 4 字节 OK，
    疑似中间设备响应，故双路径互为备份，真实 PAT 场景多一条路）。"""
    try:
        data = json.loads(raw.decode('utf-8', 'replace'))
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    items = data.get('data') if isinstance(data.get('data'), list) else data.get('models')
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if isinstance(it, str):
            mid = it.strip()
        elif isinstance(it, dict):
            mid = str(it.get('id') or it.get('name') or '').strip()
        else:
            continue
        if not mid:
            continue
        out.append({'id': mid, 'ctx_window': 0, 'modalities': []})
    return out


def github_catalog_models(base_url, timeout=8.0, api_key=''):
    """v1.6 T2：拉取 GitHub Models 目录 → 与 models() 同形态输出。

    返回 {ok, base_url, models:[{id, ctx_window, tool_capable, estimated,
    modalities}]}；失败 {ok: False, error: 人话}（401 scope 引导/429 限流/
    结构异常/空目录）。探测失败不阻塞调用方其他功能（由前端降级手输）。

    实现 v1.6 遗留 L2：双路径——先试目录端点 /catalog/models（T2 原路径），
    失败（网络错误/结构不符）再试 OpenAI 标准清单 {inference_base}/models；
    两者皆败才返回降级信号（前端热门兜底 + 手输）。两路 Bearer 鉴权口径一致。
    """
    headers = {'Accept': 'application/json'}
    token = auth_header_value(api_key)
    if token:
        headers['Authorization'] = 'Bearer ' + token
    # 路径 1：目录端点（外部核实格式 {models:[{id,name,context_window,modalities}]}）
    cat_url = _github_catalog_url(base_url)
    if cat_url:
        try:
            req = urllib.request.Request(cat_url, method='GET', headers=headers)
            with urlopen_no_redirect(req, timeout=timeout) as resp:
                raw = resp.read(512 * 1024)
            entries = _parse_github_catalog(raw)
            if entries:
                return _github_catalog_ok(base_url, entries)
        except Exception:
            pass          # 落到路径 2（错误信息由路径 2 统一出）
    # 路径 2：OpenAI 标准清单 {inference_base}/models
    base = normalize_base_url(base_url) or str(base_url or '').rstrip('/')
    if base:
        list_url = base + '/models'
        try:
            req = urllib.request.Request(list_url, method='GET', headers=headers)
            with urlopen_no_redirect(req, timeout=timeout) as resp:
                raw = resp.read(512 * 1024)
            entries = _parse_github_models_list(raw)
            if entries:
                return _github_catalog_ok(base_url, entries)
            return {'ok': False,
                    'error': 'GitHub 模型清单为空或结构不符（%s），可手动输入模型名（provider/model 格式，如 openai/gpt-4o）' % list_url}
        except Exception as e:
            return {'ok': False, 'error': _github_catalog_error(e)}
    return {'ok': False, 'error': '缺少 Base URL'}


def _github_catalog_ok(base_url, entries):
    """实现 v1.6 遗留 L2：目录/清单解析成功 → 统一输出形态（与 models() 对齐）。

    修复 N14（四轮）：tool_capable 原硬编码 True——目录含 DeepSeek-R1 等不支持工具
    的模型，与本项目 LOCAL_MODEL_META 的「未知默认 False（保守侧）」口径冲突。
    改按 model_meta() 推导 tool_capable（内置表/前缀启发/保守默认）；
    ctx_window 仍以目录声明为权威（不被 meta 的估计值覆盖）。"""
    return {'ok': True, 'base_url': normalize_base_url(base_url),
            'models': [dict({'id': e['id'], 'ctx_window': e['ctx_window'],
                             'tool_capable': model_meta(e['id'])['tool_capable'],
                             'estimated': False,
                             'modalities': e.get('modalities') or []}) for e in entries]}


def test_local_endpoint(base_url, model, timeout=30):
    """A5：本地端点测试连接——免 Key 校验、超时默认 30s、识别冷启动 loading 态。

    与 provider 服务的云端测试同链路（复用 urlopen_no_redirect），但不要求 Key；
    503 loading 不判失败（返回 state='loading'）。
    """
    url = chat_completions_url(base_url)
    if not url:
        return {'ok': False, 'error': '缺少 Base URL'}
    if not str(model or '').strip():
        return {'ok': False, 'error': '缺少模型名'}
    body = json.dumps({
        'model': str(model).strip(),
        'messages': [{'role': 'user', 'content': 'ping'}],
        'max_tokens': 5,
        'stream': False,
    }).encode('utf-8')
    try:
        req = urllib.request.Request(url, data=body, method='POST', headers={
            'Content-Type': 'application/json',
        })
        try:
            with urlopen_no_redirect(req, timeout=timeout) as resp:
                raw = resp.read(64 * 1024)
                try:
                    data = json.loads(raw.decode('utf-8', 'replace'))
                except Exception:
                    return {'ok': False, 'error': '响应不是合法 JSON'}
                if not isinstance(data, dict) or 'choices' not in data:
                    return {'ok': False, 'error': 'HTTP 200 但响应结构异常（非 OpenAI 兼容格式）'}
                reply = ''
                try:
                    reply = data['choices'][0]['message'].get('content', '') or ''
                except Exception:
                    pass
                return {'ok': True, 'url': url, 'model': str(model).strip(),
                        'state': 'ready', 'reply': str(reply)[:80]}
        except urllib.error.HTTPError as e:
            snippet = ''
            try:
                snippet = e.read(64 * 1024).decode('utf-8', 'replace')[:300]   # 修复 N20（四轮）：错误体有界读
            except Exception:
                pass
            info = classify_local_error(e.code, snippet)
            if info['kind'] == 'loading':
                # A5：冷启动加载中——返回 loading 态而非失败（前端显示等待提示）
                return {'ok': True, 'url': url, 'model': str(model).strip(),
                        'state': 'loading', 'message': info['message']}
            return {'ok': False, 'error': 'HTTP %d: %s' % (e.code, info['message'] or snippet),
                    'status': e.code}
    except Exception as e:
        return {'ok': False, 'error': '连接失败: %s' % e}


# ================= A4 · 本地模式计费（零费用）与偏好校验 =================

LOCAL_PREFS_KEYS = ('local_mode', 'local_base_url', 'local_model',
                    'local_ctx_window', 'local_tool_capable')
VALID_TOOL_CAPABLE = ('auto', 'on', 'off')


def validate_local_prefs(cfg):
    """local_* 配置键校验（只验证不落盘；config.json 写入走既有 save_config 合并）。

    返回 (record, error)。record 仅含合法键；调用方负责合并进 config.json。
    键语义（roadmap §3.2）：
      local_mode        bool  本地模式开关（GLM ⇄ 本地切换即关/开 provider）
      local_base_url    str   OpenAI 兼容 Base URL（归一化后非空）
      local_model       str   模型名
      local_ctx_window  int   用户覆盖的上下文窗口（0=用元数据表自动值）
      local_tool_capable str  auto/on/off（auto=按元数据表推断）
    """
    if not isinstance(cfg, dict):
        return None, 'local 配置必须是 JSON 对象'
    record = {}
    if 'local_mode' in cfg:
        record['local_mode'] = bool(cfg.get('local_mode'))
    if cfg.get('local_base_url') is not None and str(cfg.get('local_base_url')).strip():
        base = normalize_base_url(cfg.get('local_base_url'))
        if not base.lower().startswith(('http://', 'https://')):
            return None, 'local_base_url 需要 http:// 或 https:// 开头'
        # 安全口径：远端 local 端点禁明文（仅回环主机名豁免）
        # 修复 S7（三轮）：原用整串子串 'localhost' in base，可被 http://localhost.evil.com/v1
        # 之类绕过（4/4 实证）→ 改 hostname 精确比较（子串匹配让 Key 明文出网）
        if base.lower().startswith('http://') and _local_hostname(base) not in ('localhost', '127.0.0.1', '::1'):
            return None, '非本地的 local 端点必须使用 https://（防 Key 明文出网）'
        record['local_base_url'] = base
    if cfg.get('local_model') is not None and str(cfg.get('local_model')).strip():
        record['local_model'] = str(cfg.get('local_model')).strip()
    if cfg.get('local_ctx_window') is not None and str(cfg.get('local_ctx_window')).strip() != '':
        try:
            cw = int(str(cfg.get('local_ctx_window')).strip())
        except (TypeError, ValueError):
            return None, 'local_ctx_window 必须是整数（tokens）'
        if cw < 0 or cw > 2000000:
            return None, 'local_ctx_window 超出范围（0-2000000，0=自动）'
        record['local_ctx_window'] = cw
    if cfg.get('local_tool_capable') is not None:
        tc = str(cfg.get('local_tool_capable') or '').strip().lower()
        if tc and tc not in VALID_TOOL_CAPABLE:
            return None, 'local_tool_capable 仅支持 auto/on/off'
        if tc:
            record['local_tool_capable'] = tc
    return record, None


def local_billing_label(local_mode):
    """A4：会话头部计费标签——local 模式切「本地 · 0 费用」。"""
    return '本地 · 0 费用' if local_mode else None


# ================= B2 · 工具能力降级判定（接口；重发编排在 Agent 主链路）=================

def should_retry_without_tools(status, body=''):
    """B2：带 tools 的 400 是否值得「去掉 tools 重发一次」。

    仅一次且仅限「工具不支持特征」错误（防病态端点诱导风暴——roadmap §4.2 边界）。
    """
    info = classify_local_error(status, body)
    return info['kind'] == 'tools_unsupported'


def tools_disabled_for(local_mode, tool_capable_pref, model):
    """B2：local 模式下是否应根本不下发 tools。

    local_tool_capable=off → 永不发；=on → 永远发；auto → 元数据表不可用则不发
    （保守侧：未知本地模型默认无工具能力，UI 同步显示「工具不可用（模型能力）」徽标）。
    """
    if not local_mode:
        return False
    pref = str(tool_capable_pref or 'auto').lower()
    if pref == 'off':
        return True
    if pref == 'on':
        return False
    return not model_meta(model).get('tool_capable', False)


# ================= B3 · 慢推理适配（阈值常量；流式编排在后续迭代接线）=================

FIRST_TOKEN_WAIT_HINT = 5.0      # 首 chunk 等待 >5s 显示「本地推理中（已等待 Ns）」
IDLE_WATCHDOG = 120.0            # 流中间 >120s 无字节 → 提示不断流（防病态服务器挂死）
LOCAL_DEFAULT_MAX_TOKENS = 4096  # 本地模式建议默认 max_tokens（现默认 16384）


def slow_reason_hint(elapsed_seconds):
    """B3：首字节等待提示文案（>5s 才显示，前端每秒刷新）。"""
    if elapsed_seconds < FIRST_TOKEN_WAIT_HINT:
        return ''
    return '本地推理中（已等待 %ds）' % int(elapsed_seconds)


# ================= B5 · 本地模式 MCP 保守策略（文案常量）=================

MCP_LOCAL_CAUTION = '本地模型生成的工具参数未经云端模型校验，请仔细核对'
MCP_LOCAL_TRUST_SCOPE = 'task'   # local 模式下会话信任降级为仅本任务有效


class LocalModelService:
    """本地模型服务门面（供 Api 装配；无状态，方法均为纯函数或一次性 IO）。"""

    def __init__(self):
        self._log = get_logger()

    # ---- A 层：连接 ----
    def probe(self, ports=None):
        return probe(ports=ports)

    def models(self, base_url, api_key=''):
        return models(base_url, api_key=api_key)

    def test_local_endpoint(self, base_url, model, timeout=30):
        return test_local_endpoint(base_url, model, timeout=timeout)

    # ---- B 层：适配（纯函数判定）----
    def model_meta(self, model):
        return model_meta(model)

    def compact_threshold(self, ctx_window, level=DEFAULT_COMPACT_LEVEL):
        return compact_threshold(ctx_window, level)

    def classify_local_error(self, status, body=''):
        return classify_local_error(status, body)

    def should_retry_without_tools(self, status, body=''):
        return should_retry_without_tools(status, body)

    def tools_disabled_for(self, local_mode, tool_capable_pref, model):
        return tools_disabled_for(local_mode, tool_capable_pref, model)


# ================= W2 readiness 8 项评分（deep-research W2）=================
# 本地模型「协同就绪度」：混合路由把 understand/validate 阶段交给本地前的
# 体检。8 项 = tag 固定 / 工具能力 / schema 输出 / 迭代上限 / 路径护栏 /
# 结构化错误 / 日志可见 / keep_alive 提示。低分项给降级建议（本地做不了
# 的阶段交云端）——不阻塞主流程，纯建议面。
READINESS_ITEMS = (
    'model_tagged', 'tool_capable', 'schema_json', 'iteration_headroom',
    'path_guard', 'structured_errors', 'logging_visible', 'keep_alive_hint',
)
# 单项 0-2 分（0=缺/1=弱/2=足）；≥12/16 建议全本地阶段，8-11 部分本地，
# <8 建议全云端（本地只做草稿）。阈值与建议文案集中此处便于调。
READINESS_FULL = 12
READINESS_PARTIAL = 8


def readiness(model_meta=None, cfg=None, probe_info=None):
    """本地模型协同就绪度评分（纯函数；网络事实经 model_meta/probe_info 注入）。

    Args:
        model_meta: models() 返回的模型元数据 {id, ctx_window, tool_capable,
            estimated}（探测不到传 None——按未知保守评分）。
        cfg: 本地配置 {local_model, local_ctx_window, local_max_iter} 等。
        probe_info: 探测附加事实 {reachable, keep_alive, error_kind}。

    Returns:
        dict: {ok, score, max, verdict, items:[{name, score, max, ok, detail}],
        suggestions:[...]}。verdict ∈ full|partial|cloud。
    """
    meta = model_meta or {}
    cfg = cfg or {}
    info = probe_info or {}
    items = []
    # 端点不可达：一切能力项均「无法验证」——path_guard/logging/keep_alive
    # 等默认 True 的项也要收 0（不可达时它们不是「配了」而是「不知道」）
    _unreachable = info.get('reachable') is False

    def _add(name, score, detail):
        items.append({'name': name, 'score': score, 'max': 2,
                      'ok': score == 2, 'detail': detail})

    # ① tag 固定：模型元数据已知（非 estimated 猜测）——ctx/tool 能力可信
    if meta.get('estimated') is False and meta.get('id'):
        _add('model_tagged', 2, '模型 %s 元数据已识别（ctx=%s）'
             % (meta.get('id'), meta.get('ctx_window')))
    elif meta.get('id'):
        _add('model_tagged', 1, '模型 %s 为保守估计值（ctx/工具能力按默认推）'
             % meta.get('id'))
    else:
        _add('model_tagged', 0, '未获取到模型元数据（探测失败或清单为空）')

    # ② 工具能力：tool_capable——本地模型能否可靠发起工具调用
    if meta.get('tool_capable') is True:
        _add('tool_capable', 2, '模型支持工具调用')
    elif meta.get('tool_capable') is False:
        _add('tool_capable', 0, '模型无工具调用能力（本地仅可做纯文本草稿）')
    else:
        _add('tool_capable', 1, '工具能力未知（按不可用保守处理）')

    # ③ schema 输出：能否约束 JSON 输出（grammar/json mode 提示可达）
    _add('schema_json', 2 if info.get('schema_json') else 1,
         '本地支持 JSON 约束输出（grammar/json mode）'
         if info.get('schema_json') else
         '未确认 JSON 约束能力（提示词约束可达标，幻觉参数风险略高）')

    # ④ 迭代上限：本地阶段硬预算内可完成的迭代深度（理解 5s/校验 3s）
    iters = cfg.get('local_max_iter')
    if isinstance(iters, int) and 1 <= iters <= 3:
        _add('iteration_headroom', 2, '迭代上限 %d（本地预算内可完成）' % iters)
    elif isinstance(iters, int) and iters > 3:
        _add('iteration_headroom', 1, '迭代上限 %d 偏大（本地 5s/3s 预算内可能超时降级）' % iters)
    else:
        _add('iteration_headroom', 1, '迭代上限未配置（按默认 1 次）')

    # ⑤ 路径护栏：本地阶段产出是否过工作区门禁（防幻觉路径越界）
    _add('path_guard', 0 if _unreachable else (2 if info.get('path_guard', True) else 0),
         '本地产出路径经工作区门禁归一' if info.get('path_guard', True)
         else '本地产出未过路径门禁（幻觉路径有越界风险）')

    # ⑥ 结构化错误：本地服务错误是否可分类（降级链依赖错误分类）
    if info.get('error_kind'):
        _add('structured_errors', 2, '错误已分类：%s' % info.get('error_kind'))
    elif info.get('reachable') is False:
        _add('structured_errors', 0, '端点不可达（连接层错误未分类）')
    else:
        _add('structured_errors', 1, '错误分类能力未确认')

    # ⑦ 日志可见：路由决策/降级原因是否落盘（可观测性）
    _add('logging_visible', 0 if _unreachable else (2 if info.get('logging_visible', True) else 0),
         '路由日志落盘（hybrid-route.jsonl）' if info.get('logging_visible', True)
         else '路由日志未启用（降级不可追溯）')

    # ⑧ keep_alive 提示：Ollama 常驻防冷启（时延优化项）
    if _unreachable:
        _add('keep_alive_hint', 0, '端点不可达，无法确认 keep_alive 配置')
    elif info.get('keep_alive'):
        _add('keep_alive_hint', 2, 'keep_alive 已配置（防冷启时延）')
    else:
        _add('keep_alive_hint', 1, '未配置 keep_alive（本地阶段可能偶发冷启时延）')

    score = sum(i['score'] for i in items)
    if score >= READINESS_FULL:
        verdict = 'full'
    elif score >= READINESS_PARTIAL:
        verdict = 'partial'
    else:
        verdict = 'cloud'
    suggestions = []
    if verdict != 'full':
        for it in items:
            if it['score'] < 2:
                suggestions.append('%s：%s' % (it['name'], it['detail']))
    return {'ok': True, 'score': score, 'max': 16, 'verdict': verdict,
            'items': items, 'suggestions': suggestions}
