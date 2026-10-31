# -*- coding: utf-8 -*-
"""V1 结果校验框架（v1.8.0 迭代方案 §6 P1·高价值项）。

全工具面复用——每个工具有对应 validator，输出结构化 verdict + 置信度；
不通过给出 reformulate 建议（调用方 ≤2 次重试）。H 组「结果校验」职责的
工程载体，也让既有工具面（写文件/命令/搜索/软件调用）受益。

设计口径：
- **纯函数优先**：除文件存在性外全部零 IO（文件存在性/大小经 ``exists_fn`` /
  ``size_fn`` 检查器；缺省走真实 FS——生产单例（get_validator）用
  ``os.path.exists``/``os.path.getsize``，测试可注入桩）。
- **verdict 结构**：``{ok, kind, confidence, reason, retryable, suggestion}``
  ——confidence 0-1（相关度/完整度量化）；retryable 标记是否值得改写重试
  （换引擎/去限定词/简词）；suggestion 为人话改写建议（reformulate 提示）。
- **不拦截**：框架只判定与建议，「是否重试/如何重试」由调用方决定
  （search_service 走既有换引擎链；agent-loop 前端徽标提示）。
- **窄义严格**：空结果/字段残缺一律不通过；相关度不足（搜索）不通过但
  标记 retryable（提示去 site/filetype 限定或换引擎）。

内置 validator（6 类）：
- search   ：browser_search 结果（非空 + title/url 字段完整 + query 相关度）
- open     ：browser_open 正文（非空 + 最小长度 + 非导航壳）
- command  ：run_command/run_powershell/software_call(cli)（退出码语义 + stderr 模式）
- file     ：write_file 类（存在 + 大小 > 0，经注入 exists_fn/size_fn）
- software ：software_call(gui/uri)（window_verified / protocol 回显）
- generic  ：其余工具/MCP（结构非空 + 无 error 字段）
"""
import os
import re

# verdict kind 全集（前端徽标/审计对齐）
KIND_OK = 'ok'
KIND_EMPTY = 'empty'            # 结果为空
KIND_MALFORMED = 'malformed'    # 字段残缺/结构异常
KIND_IRRELEVANT = 'irrelevant'  # 与 query 不相关
KIND_THIN = 'thin'              # 有效但单薄（低于强阈值，仅提示不拦）
KIND_FAILED = 'failed'          # 执行层失败（非零退出/窗口未核验）
KIND_UNKNOWN = 'unknown'        # 无注册 validator 的工具（generic 兜底）

_STOPWORDS = frozenset(
    'the a an and or of to in on for with is are was were be been it its this that '
    'de la le les un une des du et'.split())


def _tokens(text):
    """中英混排轻量分词：英文按词 + 中文按 2-gram（无需 jieba，零依赖）。"""
    t = str(text or '').lower()
    words = [w for w in re.findall(r'[a-z0-9_\.\-\+]{2,}', t) if w not in _STOPWORDS]
    cjk = re.findall(r'[\u4e00-\u9fff]{2,}', t)
    bigrams = []
    for seg in cjk:
        for i in range(len(seg) - 1):
            bigrams.append(seg[i:i + 2])
        if len(seg) == 1:
            bigrams.append(seg)
    return set(words) | set(bigrams)


def _relevance(query, texts):
    """相关度 = query 词集合在 texts 词集合的覆盖率（0-1）。

    query 词集为空（纯符号/停用词）时返回 0.5 中性值（不误判不放过）。
    """
    q = _tokens(query)
    if not q:
        return 0.5
    corpus = set()
    for t in texts:
        corpus |= _tokens(t)
    if not corpus:
        return 0.0
    return len(q & corpus) / len(q)


def _verdict(ok, kind, confidence, reason, retryable=False, suggestion=''):
    return {'ok': bool(ok), 'kind': kind, 'confidence': round(float(confidence), 3),
            'reason': reason, 'retryable': bool(retryable), 'suggestion': suggestion}


class ToolValidator:
    """V1 校验框架门面（无状态；Api 装配可选注入，search_service 自持）。"""

    # 搜索相关度强阈值（>= 才 ok）；弱阈值以下标记 thin（提示不拦）
    SEARCH_STRONG = 0.34
    SEARCH_WEAK = 0.12
    # 正文最小有效长度（browser_open）
    OPEN_MIN_CHARS = 120
    # 命令退出码已知错误模式（stderr 子串 -> 人话 + 是否可重试）
    _CMD_PATTERNS = (
        ('not recognized', '命令不存在：请检查软件安装或拼写', True),
        ('不是内部或外部命令', '命令不存在：请检查软件安装或拼写', True),
        ('permission denied', '权限不足：请检查目录权限或以管理员运行', False),
        ('拒绝访问', '权限不足：请检查目录权限或以管理员运行', False),
        ('timed out', '命令执行超时', True),
        ('fatal', '工具报告致命错误（详见原始输出）', False),
    )

    def __init__(self, exists_fn=None, size_fn=None):
        """
        Args:
            exists_fn: 文件存在性检查器（path -> bool；测试可桩）。缺省
                ``os.path.exists``——生产单例（``get_validator``）走真实 FS。
            size_fn: 文件大小检查器（path -> int；测试可桩）。缺省
                ``os.path.getsize``（取不到时抛异常，由 validate_file 的
                「存在性核验异常」分支按成功放行——thin 0.4）。
        """
        self._exists_fn = exists_fn or os.path.exists
        self._size_fn = size_fn or os.path.getsize

    # ---------------- 入口 ----------------
    def validate(self, tool, result, context=None):
        """按工具名分发 validator；未注册走 generic。

        Args:
            tool: 工具名（browser_search/run_command/write_file/software_call/mcp__x...）。
            result: 工具结果 dict（或 str——按 generic 处理）。
            context: dict（query/params 等改写重试所需上下文）。
        """
        ctx = context if isinstance(context, dict) else {}
        name = str(tool or '').strip().lower()
        r = result if isinstance(result, dict) else {}
        if name == 'browser_open':
            return self.validate_open(r)
        if name in ('browser_search', 'web_search'):
            return self.validate_search(r, ctx.get('query', ''))
        if name in ('run_command', 'run_powershell', 'software_call', 'cmd'):
            # software_call 三形态由 validate_software 分流（gui/uri/cli）
            if name == 'software_call':
                return self.validate_software(r)
            return self.validate_command(r)
        if name in ('write_file', 'search_replace', 'make_dir', 'save_workspace_file'):
            return self.validate_file(r)
        return self.validate_generic(r)

    # ---------------- 6 类 validator ----------------
    def validate_search(self, result, query=''):
        """搜索：非空 + 字段完整 + 相关度。失败可改写重试。

        result 容错：dict（{results:[...]}）或裸 list（[{'title','url'}]）。
        """
        if isinstance(result, list):
            results = result
        else:
            results = (result or {}).get('results') or []
        if not results:
            return _verdict(False, KIND_EMPTY, 0.0, '搜索结果为空',
                            retryable=True,
                            suggestion='换引擎或放宽检索条件（去掉 site/filetype 限定）重试')
        valid = [x for x in results if isinstance(x, dict) and x.get('title') and x.get('url')]
        if not valid:
            return _verdict(False, KIND_MALFORMED, 0.1, '结果缺少标题或链接字段',
                            retryable=True, suggestion='结果结构异常，建议更换引擎重试')
        rel = _relevance(query, [str(x.get('title') or '') + ' ' + str(x.get('snippet') or '')
                                 for x in valid])
        if rel >= self.SEARCH_STRONG:
            return _verdict(True, KIND_OK, min(1.0, 0.5 + rel), '结果有效且与检索词相关')
        if rel >= self.SEARCH_WEAK:
            return _verdict(True, KIND_THIN, rel,
                            '结果有效但相关度偏低（%.0f%%），已保留' % (rel * 100),
                            suggestion='如不满意可精简检索词或加 site 限定重试')
        return _verdict(False, KIND_IRRELEVANT, rel,
                        '结果与检索词相关度不足（%.0f%%）' % (rel * 100),
                        retryable=True,
                        suggestion='精简检索词（去掉停用词）或换引擎重试')

    def validate_open(self, result):
        """深度打开：正文非空 + 最小长度 + 非纯导航壳。"""
        content = str((result or {}).get('content') or '')
        if (result or {}).get('ok') is False:
            return _verdict(False, KIND_FAILED, 0.0,
                            '打开失败：' + str((result or {}).get('error') or '未知错误'),
                            retryable=False)
        if not content.strip():
            return _verdict(False, KIND_EMPTY, 0.0, '未提取到正文内容',
                            retryable=True, suggestion='页面可能需 JS 渲染或已失效，换来源重试')
        if len(content) < self.OPEN_MIN_CHARS:
            return _verdict(False, KIND_THIN, len(content) / float(self.OPEN_MIN_CHARS),
                            '正文过短（%d 字符），可能是导航壳页面' % len(content),
                            retryable=True, suggestion='尝试其他结果链接')
        return _verdict(True, KIND_OK, min(1.0, len(content) / 4000.0),
                        '正文提取有效（%d 字符）' % len(content))

    def validate_command(self, result):
        """命令/CLI：退出码语义 + stderr 已知模式人话。

        exit_code 为 None（执行器未给出退出码——超时清剿/异常路径）≠ 成功：
        判 MALFORMED，不再静默当 0 放行（假阳性 ok 会骗过 Agent 的判断力）。
        """
        r = result or {}
        if r.get('ok') is False:
            return _verdict(False, KIND_FAILED, 0.0,
                            '调用失败：' + str(r.get('error') or '未知错误'), retryable=False)
        raw = r.get('exit_code', 0)
        if raw is None:
            return _verdict(False, KIND_MALFORMED, 0.0,
                            '命令结果缺少 exit_code（执行器未返回退出码）',
                            retryable=True, suggestion='重试或检查执行器回显')
        try:
            code = int(raw)
        except (TypeError, ValueError):
            code = 0
        if code == 0:
            out = str(r.get('stdout') or '')
            if not out.strip() and not str(r.get('stderr') or '').strip():
                return _verdict(True, KIND_THIN, 0.4, '命令成功但无输出')
            return _verdict(True, KIND_OK, 0.9, '命令成功（退出码 0）')
        stderr = str(r.get('stderr') or '').lower()
        for pat, msg, retry in self._CMD_PATTERNS:
            if pat in stderr:
                return _verdict(False, KIND_FAILED, 0.2, msg,
                                retryable=retry,
                                suggestion='按提示修正后重试' if retry else '需人工介入处理')
        return _verdict(False, KIND_FAILED, 0.2,
                        '命令返回非零退出码 %d（详见原始输出）' % code,
                        retryable=False, suggestion='检查命令参数与环境后重试')

    def validate_file(self, result):
        """写文件：存在 + 大小 > 0（存在性经注入检查器）。"""
        r = result or {}
        if r.get('ok') is False:
            return _verdict(False, KIND_FAILED, 0.0,
                            '写入失败：' + str(r.get('error') or '未知错误'), retryable=False)
        path = str(r.get('path') or '')
        if not path:
            return _verdict(True, KIND_OK, 0.7, '操作已执行（无路径回显，跳过存在性核验）')
        try:
            if not self._exists_fn(path):
                return _verdict(False, KIND_MALFORMED, 0.0, '目标文件不存在：' + path,
                                retryable=True, suggestion='重试写入或检查目录权限')
            size = int(self._size_fn(path) or 0)
        except Exception as e:
            return _verdict(True, KIND_THIN, 0.4, '存在性核验异常（%s），按成功放行' % e)
        if size <= 0:
            return _verdict(False, KIND_THIN, 0.3, '文件存在但大小为 0',
                            retryable=True, suggestion='重试写入')
        return _verdict(True, KIND_OK, min(1.0, 0.5 + size / 100000.0),
                        '文件写入有效（%d 字节）' % size)

    def validate_software(self, result):
        """软件调用：CLI 走退出码；GUI 核验窗口；URI 核验协议回显。"""
        r = result or {}
        kind = str(r.get('kind') or 'cli')
        if r.get('ok') is False:
            return _verdict(False, KIND_FAILED, 0.0,
                            '调用失败：' + str(r.get('error') or '未知错误'), retryable=False)
        if kind == 'gui':
            if r.get('window_verified'):
                return _verdict(True, KIND_OK, 0.9, '软件已启动且窗口已核验')
            return _verdict(False, KIND_FAILED, 0.2, '窗口未核验（GUI_UNCONFIRMED）',
                            retryable=True,
                            suggestion='检查 UAC 弹窗/杀软拦截后重试')
        if kind == 'uri':
            if r.get('protocol'):
                return _verdict(True, KIND_OK, 0.8, 'URI 协议已调起（%s）' % r['protocol'])
            return _verdict(False, KIND_MALFORMED, 0.3, 'URI 响应缺少协议回显')
        return self.validate_command(r)

    def validate_generic(self, result):
        """其余工具/MCP：结构非空 + 无 error 字段。"""
        r = result if isinstance(result, dict) else {}
        if not r:
            return _verdict(True, KIND_THIN, 0.4, '结果为空对象（工具可能无回显）')
        if r.get('ok') is False or r.get('error'):
            return _verdict(False, KIND_FAILED, 0.0,
                            '工具报告错误：' + str(r.get('error') or '未知'), retryable=False)
        if not any(k for k in r.keys() if k not in ('ok', 'truncated')):
            return _verdict(True, KIND_THIN, 0.4, '结果字段单薄')
        return _verdict(True, KIND_OK, 0.7, '结果结构有效')

    # ---------------- reformulate 辅助 ----------------
    @staticmethod
    def should_retry(verdict, attempts):
        """是否值得改写重试：verdict.retryable 且 attempts < 2（硬上限）。"""
        if not isinstance(verdict, dict):
            return False
        try:
            n = int(attempts)
        except (TypeError, ValueError):
            n = 0
        return bool(verdict.get('retryable')) and n < 2

    @staticmethod
    def reformulate_hint(tool, params, verdict):
        """reformulate 人话提示（调用方展示/日志；不改写参数本身——
        参数改写策略在各工具自己的重试链里，如 search_service 换引擎）。"""
        if not isinstance(verdict, dict):
            return ''
        s = str(verdict.get('suggestion') or '').strip()
        if not s:
            return ''
        return '%s：%s' % (tool or '工具', s)

    @classmethod
    def reflect_loop(cls, tool, params, exec_fn, context=None,
                     max_attempts=2, on_attempt=None):
        """F1 自反思补做循环（deep-research W7 reflect + 交接文档 F1 项）。

        管线：exec_fn(params) → validate → verdict.ok？返回 → 否则
        reformulate（on_attempt 回调改写 params；不提供则原参重试一次）→
        重试，硬上限 max_attempts（默认 2——W7「补做循环 ≤2」）。**不自动
        改参数**（参数改写策略归调用方 on_attempt——安全边界：后端不臆造
        用户意图）；超限返回最后一次 verdict（retryable=False 供上层止损）。

        Args:
            tool: 工具名（validate 分发用）。
            params: 初始参数（dict）。
            exec_fn: 执行函数 (params) -> result dict（注入式，可测）。
            context: validate 上下文（如 {'query': ...}）。
            max_attempts: 最大执行次数（含首次；≥1）。
            on_attempt: 可选回调 (attempt, params, verdict) -> 新 params
                （返回 None/相同 = 原参重试）。

        Returns:
            dict: {ok, result, verdict, attempts, history:[{attempt,
            verdict, hint}]}——ok=True 时 result/verdict 为成功态。
        """
        attempts = 0
        history = []
        cur = dict(params) if isinstance(params, dict) else {}
        limit = max(1, int(max_attempts or 1))
        v = cls()
        while attempts < limit:
            attempts += 1
            try:
                result = exec_fn(cur)
            except Exception as e:
                verdict = _verdict(False, 'exec_error', 0.0,
                                   '执行异常: %s' % str(e)[:120], False, '')
                history.append({'attempt': attempts, 'verdict': verdict,
                                'hint': cls.reformulate_hint(tool, cur, verdict)})
                return {'ok': False, 'result': None, 'verdict': verdict,
                        'attempts': attempts, 'history': history}
            verdict = v.validate(tool, result, context)
            history.append({'attempt': attempts, 'verdict': verdict,
                            'hint': cls.reformulate_hint(tool, cur, verdict)})
            if verdict.get('ok'):
                return {'ok': True, 'result': result, 'verdict': verdict,
                        'attempts': attempts, 'history': history}
            if attempts >= limit:
                break
            if on_attempt is not None:
                try:
                    nxt = on_attempt(attempts, cur, verdict)
                    if isinstance(nxt, dict) and nxt:
                        cur = nxt
                except Exception:
                    break          # 回调异常：停止补做，交上层
        last = history[-1]['verdict'] if history else _verdict(False, 'unknown', 0, '', False, '')
        return {'ok': False, 'result': None, 'verdict': last,
                'attempts': attempts, 'history': history}


# 进程级单例（search_service 及后续工具面复用；无状态可安全共享）
_VALIDATOR = None


def get_validator():
    """进程级单例（与 local_proxy.get_proxy 同款模式）。"""
    global _VALIDATOR
    if _VALIDATOR is None:
        _VALIDATOR = ToolValidator()
    return _VALIDATOR
