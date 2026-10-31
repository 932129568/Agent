# -*- coding: utf-8 -*-
"""MCP 总服务（v1.3 R3/R6）：运行时状态机 + 分层护栏 + 审计 + 生命周期。

职责（架构 §3.3 / PRD R3/R6）：
- 运行时状态机：_rt[name] = {client, tools, status, last_error, instructions,
  server_info, last_used, lock}；status ∈ untested/ok/error/stale。
- 按需拉起 + 崩溃自动重拉一次 + idle 600s 回收；notifications/tools/list_changed →
  标记 stale + 后台刷新（刷新在独立线程，避免占用 dispatcher 线程死锁）。
- 档位：derive_tier（注解推导，最宽 session，永不放宽 off）；resolve_tier
  （tierOverrides > 注解 > 兜底 always）；check_tool/call_tool 落审计 op=mcp_call。
- 后端二次 enforce 矩阵（防前端绕过）：off 放行 / session·always 需 decision∈{allow,
  session-trust} / 否则拒绝 + 审计 block；decision='deny'（用户拒绝）→ {info, skipped}。
- 结果渲染：文本拼接 / structuredContent 序列化 / isError / 超长 >20000 走 toolcache 截断落盘。
- 函数名净化：mcp__<server>__<tool>（[^A-Za-z0-9_-]→_、>64 截断 + hash6、tool_schemas 去重 _2）。

错误人话映射（共享知识 4）集中在 _spawn_fail_text/_version_text/_protocol_error_text。
"""
import hashlib
import json
import os
import re
import threading
import time

from ....logging_setup import get_logger
from .mcp_client import (
    MCP_PROTOCOL_VERSION, McpClient, McpProtocolError, McpTimeoutError, McpVersionError)
from .mcp_transport_http import HttpTransport
from .mcp_transport_stdio import StdioTransport
from .mcp_pool import (WarmRegistry, WARM_ENTRY_IDLE_TTL, ConcurrencyLimiter,
                       effective_pool_config, stale_needs_relist)

IDLE_TIMEOUT = 600            # stdio 空闲回收（秒，裁决③固定不暴露 UI）
CALL_TIMEOUT = 60             # tools/call 默认阈值（修复 F2 v1.4：可被每服务器 callTimeout 覆盖，10-300s）
CALL_TIMEOUT_MIN = 10         # 修复 F2（v1.4）：配置下限
CALL_TIMEOUT_MAX = 300        # 修复 F2（v1.4）：配置上限
CONNECT_TIMEOUT = 30          # 握手/冷启（npx 首次下载依赖）
LIST_TIMEOUT = 15             # tools/list
OUTPUT_CACHE_LIMIT = 20000    # 超长输出截断落盘阈值（字符）
IDLE_SWEEP_INTERVAL = 30      # 空闲回收扫描周期（秒）

# 批 3b（M2.10 R36）：定期重验间隔按健康度三态取档（秒）
REVERIFY_OK_S = 86400         # health=ok → 24h
REVERIFY_DEGRADED_S = 3600    # health=degraded（1-2 连败）→ 1h
REVERIFY_ERROR_S = 900        # health=error（≥3 连败）→ 15min

_STATUS_PUBLIC = {'ok': 'ok', 'error': 'error'}   # untested/stale → 'stale'


def _utc_now_iso() -> str:
    """批 3b：ISO8601 UTC 'Z' 后缀口径（B8 共享知识 5，与 hybrid/search 同款）。"""
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _parse_iso_utc(s: str) -> float:
    """解析 ISO8601 UTC 'Z' 串 → epoch 秒；格式不符抛 ValueError（调用方按首验处理）。"""
    import datetime as _dt
    dt = _dt.datetime.strptime(str(s), '%Y-%m-%dT%H:%M:%SZ').replace(
        tzinfo=_dt.timezone.utc)
    return dt.timestamp()


# 批 3b（M2.10 R36）：楼层规则扩 schema 全字段——投毒检测词表与命令特征
_DANGER_NAME_STEMS = ('delete', 'drop', 'purge', 'remove', 'destroy', 'erase',
                      'truncate', 'format', 'exec', 'eval', 'run', 'shell',
                      'cmd', 'kill', 'force')
_SHELL_META = (';', '|', '&', '`', '$', '(', ')', '<', '>', '\n', '&&', '||')
_CMD_FEATURES = ('sh -c', 'bash -c', 'cmd.exe', 'cmd /c', 'rm -rf', 'rm ',
                 'del ', 'powershell', 'invoke-expression', 'iex ')
_ABS_PATH_RE = re.compile(r'^(?:[A-Za-z]:[\\/]|[\\/])')   # /x、\x、C:\x、C:/x
_POISON_DEPTH_MAX = 3


def schema_poison_signals(input_schema) -> list:
    """批 3b（M2.10 R36）：inputSchema 四维投毒检测（纯函数，零 IO 可单测）。

    返回信号串列表（空=干净；去重保序）：
    - 'param-name:<参数名>'   参数名（含嵌套 properties，深度≤3）命中危险动词词干
    - 'enum-value:<参数名>'   enum 值含 shell 元字符（;|&`$()<>\n）或绝对路径
    - 'default-bool:<参数名>' default 布尔 True 且参数名含 force/overwrite/
                              recursive/delete（默认放行破坏性行为）
    - 'default-cmd:<参数名>'  default 字符串含命令特征（'sh -c'/'cmd.exe'/'rm '…）

    深度封顶 _POISON_DEPTH_MAX=3（防病态嵌套 DoS）；type 非标量（object/array）
    递归下行。服务器注解可伪造，参数面是供应链偷袭面——本函数命中即由
    derive_tier 升 always 档（每次确认），不阻断工具发射。"""
    signals, seen = [], set()

    def _add(sig):
        if sig not in seen:
            seen.add(sig)
            signals.append(sig)

    def _enum_poisonous(v) -> bool:
        if not isinstance(v, str):
            return False
        if any(ch in v for ch in _SHELL_META):
            return True
        return bool(_ABS_PATH_RE.match(v))

    def _visit(schema, depth):
        # depth=根 properties（参数深度 1）；封顶=参数深度 3（depth 0/1/2 可访问）
        if not isinstance(schema, dict) or depth >= _POISON_DEPTH_MAX:
            return
        props = schema.get('properties')
        if not isinstance(props, dict):
            return
        for pname, pspec in props.items():
            pname = str(pname)
            low = pname.lower()
            for stem in _DANGER_NAME_STEMS:
                if stem in low:
                    _add('param-name:%s' % pname)
                    break
            if not isinstance(pspec, dict):
                continue
            enum = pspec.get('enum')
            if isinstance(enum, list) and any(_enum_poisonous(v) for v in enum):
                _add('enum-value:%s' % pname)
            default = pspec.get('default')
            if default is True and any(s in low for s in
                                       ('force', 'overwrite', 'recursive', 'delete')):
                _add('default-bool:%s' % pname)
            elif isinstance(default, str) and default:
                dlow = default.lower()
                for feat in _CMD_FEATURES:
                    if feat in dlow:
                        _add('default-cmd:%s' % pname)
                        break
            # ④ type 非标量递归下行（object 自身 / array items 携带子 schema）
            if pspec.get('type') == 'object' or isinstance(pspec.get('properties'), dict):
                _visit(pspec, depth + 1)
            items = pspec.get('items')
            if isinstance(items, dict):
                _visit(items, depth + 1)

    _visit(input_schema, 0)
    return signals


def _entry_template():
    return {
        'client': None,
        'tools': [],
        'resources': [],       # 实现 v1.6 T12：resources/list 缓存（按需刷新）
        'status': 'untested',
        'last_error': '',
        'instructions': '',
        'server_info': {},
        'last_used': 0.0,
        'last_list_at': 0.0,      # 实现 v1.6 W21：stale 检测时间戳（300s 未刷新自动重 List）
        'lock': threading.RLock(),
    }


class McpService:
    """MCP 总服务：被 Api 门面持有；配置经 McpConfigService，审计复用 GuardService。"""

    def __init__(self, config, guard, toolcache, logger=None):
        self._log = logger or get_logger()
        self._cfg = config
        self._guard = guard
        self._toolcache = toolcache
        self._rt = {}
        self._lock = threading.RLock()
        # 修复 ㉒：净化函数名 → 原名反解映射（tool_schemas 重建时刷新）。
        # 修复 alias 碰撞（本轮）：tool_alias 以**完整净化函数名**为键存
        # (server, tool) 二元组——原按 split('__',2) 猜段存 (server 段,
        # tool 段)，server 名含 '__' 时猜出的段与其它条目互相覆盖，派发被
        # 路由到错服务器；前端 mcpParseName 的 (.+?)__(.+) 分段与本键
        # （'mcp__%s__%s' 重建）无损互换。server 段单独映射已不需要，移除。
        self._tool_alias = {}        # 完整净化函数名 -> (原始服务器名, 原始工具名)
        # W10 楼层规则统计（tool_schemas 上次调用的截断/跳过计数；未调用为零值）
        self._floor_stats = {'truncated_desc': 0, 'skipped_per_server': 0,
                             'skipped_total': 0, 'emitted': 0}
        # W10 TOFU：schema hash 快照 + 待重审集合（服务器工具悄悄变更→blocked）
        self._schema_hash = {}
        self._schema_review = set()
        # W10 健康度三态：连续失败计数（ok/degraded/error）——失败 1-2 次
        # degraded，≥3 error（面板徽标 + 建议重连）
        self._fail_count = {}
        # 修复 S4①/W26：MCP 会话信任态（键 server__tool；切会话清空）
        self._session_trust = set()
        # 修复 S2（v1.5.1）：stdio 温启登记表（启用/测试后保留 client；IDLE 到期转
        # warm 独家持有，warm 600s 到期才真正关闭）+ spawn 打点（server → ms）
        self._warm = WarmRegistry()
        self._spawn_ms = {}
        # 实现 v1.6 W21：每服务器 ConcurrencyLimiter（池配置键接入生产调用方——
        # 原 max_concurrency 等入库但无消费方，零效果）
        self._limiters = {}
        # 实现 v1.6 W25：删除/停用代际计数——forget() 递增，废掉在途 _get_or_spawn
        # 拉起的孤儿 client（原竞态：entry 已摘，spawn 出的 client 无人关闭）
        self._gen = {}
        self._reaper_stop = threading.Event()
        self._reaper = threading.Thread(target=self._idle_loop, daemon=True,
                                        name='mcp-idle-reaper')
        self._reaper.start()

    def clear_session_trust(self):
        """切会话清空 MCP 会话信任（Api.set_current_sid 检测 sid 变化时调用，W26）。"""
        with self._lock:
            self._session_trust.clear()

    # ============ 面板数据 ============
    def list_servers(self) -> list:
        """合并配置与运行时状态：[{name, transport, enabled, status, tool_count, last_error}]。"""
        out = []
        for s in self._cfg.list_servers():
            entry = self._rt.get(s['name']) or {}
            # 修复 ㉖：多字段快照在 entry 锁内读取（原无锁可撕开：status/tool_count 来自不同瞬间）
            with entry.get('lock', threading.RLock()):
                if not s['enabled']:
                    status, tool_count, last_error = 'disabled', 0, ''
                else:
                    status = _STATUS_PUBLIC.get(entry.get('status'), 'stale')
                    tool_count = len(entry.get('tools') or [])
                    last_error = entry.get('last_error') or ''
            out.append({'name': s['name'], 'transport': s['transport'],
                        'enabled': s['enabled'], 'status': status,
                        'tool_count': tool_count, 'last_error': last_error,
                        # 修复 F2（v1.4）：透出 callTimeout（前端桥接动态超时用；未配置=null→回落 60）
                        'callTimeout': s.get('callTimeout'),
                        # 修复 S2（v1.5.1）：温启状态与冷启耗时（面板「已预热/冷启 Nms」）
                        'warm': self._warm.get(s['name']) is not None,
                        'spawn_ms': self._spawn_ms.get(s['name']),
                        # W10 健康度三态 + TOFU 待重审（deep-research W10）：
                        # health = ok/degraded/error（连续失败 1-2→degraded，≥3→error）；
                        # schema_review = 工具 schema 静默变更，需人工重审后才放行
                        'health': self.server_health(s['name']),
                        'schema_review': s['name'] in self._schema_review})
        return out

    def server_health(self, name):
        """W10 健康度三态：ok（无连续失败）/ degraded（1-2 连败）/ error（≥3）。"""
        n = self._fail_count.get(name, 0)
        if n >= 3:
            return 'error'
        if n >= 1:
            return 'degraded'
        return 'ok'

    def report_result(self, name, ok):
        """W10：工具调用结果回报 → 连续失败计数（成功清零；失败累加）。"""
        with self._lock:
            if ok:
                self._fail_count.pop(name, None)
            else:
                self._fail_count[name] = self._fail_count.get(name, 0) + 1

    def schema_review_ack(self, name):
        """W10 TOFU：人工重审完成——接受新 schema 为快照（解除 blocked 态）。"""
        with self._lock:
            self._schema_review.discard(name)
            entry = self._rt.get(name) or {}
            canon = json.dumps(
                [{'name': t.get('name'), 'description': t.get('description'),
                  'inputSchema': t.get('inputSchema'),
                  'annotations': t.get('annotations')}
                 for t in entry.get('tools') or []],
                sort_keys=True, ensure_ascii=False)
            self._schema_hash[name] = hashlib.sha256(
                canon.encode('utf-8')).hexdigest()
        return {'ok': True, 'name': name}

    def _schema_review_pending(self, server):
        """W10 TOFU：server 是否处于「工具 schema 已变更、待人工重审」态。

        tool_schemas 检测到 schema hash 与快照不符时入列；check_tool/
        call_tool 判定链最前面据此阻断（原仅标记不阻断——供应链偷袭
        场景下「只标 blocked」等于不阻断）。人工在 mcp 面板确认
        （schema_review_ack）后解除。"""
        with self._lock:
            return server in self._schema_review

    def save_server(self, name: str, cfg: dict, activate: bool = False) -> dict:
        """配置保存便捷入口（Api 装配用；实际逻辑在 McpConfigService）。"""
        return self._cfg.save_server(name, cfg, activate)

    def test_server(self, name) -> dict:
        """连接 + tools/list + 档位推导；不落 enabled；供「测试连接」与启用流程。"""
        cfg = self._cfg.get_server(name)
        if not cfg:
            return {'error': '服务器不存在: %s' % name}
        entry = self._ensure_entry(name)
        with entry['lock']:
            self._close_client(entry, name)      # 旧客户端（如有）先关，防子进程泄漏
            # 修复 ⑯（三轮）：close 传 name——否则 warm 仍持死 client（get 命中后
            # 多一次 is_alive 往返才丢）
            client, error = self._spawn_client(name, cfg)
            if error:
                entry['status'] = 'error'
                entry['last_error'] = error
                return {'error': error}
            entry['client'] = client
        # 修复 ⑪（三轮）：list_tools（可达 45s）移出 entry 锁——原持锁阻塞
        # shutdown/call/test 其他服务器（单锁全局串行化）
        try:
            tools = client.list_tools()
        except Exception as e:
            with entry['lock']:
                self._close_client(entry, name)
                entry['status'] = 'error'
                entry['last_error'] = self._failure_text(e)
            return {'error': self._failure_text(e)}
        with entry['lock']:
            entry['tools'] = tools
            entry['status'] = 'ok'
            entry['last_error'] = ''
            entry['server_info'] = client.server_info
            entry['instructions'] = client.instructions
            entry['last_used'] = time.monotonic()   # 修复 ㊉：空闲计时用单调时钟
            entry['last_list_at'] = time.monotonic()   # 实现 v1.6 W21：测试成功即非 stale
            try:
                client.clear_list_changed()         # 修复 ⑨：list_changed 标志刷新后复位
            except Exception:
                pass
            snapshot = list(tools)
        # 修复 S2（v1.5.1）：测试成功即登记温启（entry 持有同一 client，
        # warm 仅作索引；_close_client 时同步摘除）
        self._warm.register(name, client)
        return {'ok': True, 'server_info': entry['server_info'],
                'protocol_version': MCP_PROTOCOL_VERSION,
                'instructions': entry['instructions'],
                'tools': [self._tool_view(name, t) for t in snapshot]}

    def get_server_detail(self, name) -> dict:
        """解密配置视图 + 运行时状态 + 工具现档位（编辑器回显用；裁决⑤）。"""
        cfg = self._cfg.get_server(name)
        if not cfg:
            return {'error': '服务器不存在: %s' % name}
        entry = self._rt.get(name) or {}
        with entry.get('lock', threading.RLock()):   # 修复 ㉖：快照读加锁
            status_raw = entry.get('status')
            last_error = entry.get('last_error') or ''
            tools_snap = list(entry.get('tools') or [])
            instructions = entry.get('instructions') or ''
            server_info = entry.get('server_info') or {}
        if not cfg.get('enabled'):
            status = 'disabled'
        else:
            status = _STATUS_PUBLIC.get(status_raw, 'stale')
        return {
            'ok': True, 'name': name,
            'transport': 'http' if cfg.get('url') else 'stdio',
            'status': status,
            'last_error': last_error,
            'config': cfg,
            'tierOverrides': cfg.get('tierOverrides') or {},
            'tools': [self._tool_view(name, t) for t in tools_snap],
            'instructions': instructions,
            'server_info': server_info,
            'decrypt_failed': cfg.get('decrypt_failed') or [],
        }

    # ============ 注入 ============
    # W10 楼层规则（2026-10-21）：工具面防稀释（架构文档 R4）——MCP 工具定义注入
    # build_tools 时的三道闸：① 单工具描述长度上限（超长描述按字符价计费还稀释
    # 主提示词注意力）；② 单 server 工具数上限（个别 server 一次吐 200+ 工具会
    # 挤爆上下文）；③ 总工具面上限（多 server 叠加爆炸）。截断在 description 尾部
    # 标「…[已截断]」保持可解释；顺序按 server 名 sorted（稳定，diff 可review）。
    MAX_TOOL_DESC_CHARS = 600
    MAX_TOOLS_PER_SERVER = 50
    MAX_TOTAL_TOOLS = 200

    def tool_schemas(self) -> list:
        """enabled 且 ok 的服务器 → OpenAI 函数定义（读缓存零 IO；stale/error 跳过）。

        W10 楼层规则见类常量三道闸；截断/跳过均计数，供 mcp_status 观测。
        """
        enabled = {s['name'] for s in self._cfg.list_servers() if s.get('enabled')}
        with self._lock:
            names = sorted(n for n, e in self._rt.items()
                           if e.get('status') == 'ok' and n in enabled)
        out, used = [], {}
        tool_alias = {}
        n_trunc_desc = n_skip_server = n_skip_total = 0
        for name in names:
            entry = self._rt.get(name) or {}
            tools = entry.get('tools') or []
            if len(tools) > self.MAX_TOOLS_PER_SERVER:
                n_skip_server += len(tools) - self.MAX_TOOLS_PER_SERVER
                tools = tools[:self.MAX_TOOLS_PER_SERVER]
            for tool in tools:
                if len(out) >= self.MAX_TOTAL_TOOLS:
                    n_skip_total += 1
                    break
                fname = self._unique_name(
                    self.function_name(name, tool.get('name', '')), used)
                # 修复 ㉒：登记净化函数名反解映射（_2 去重后缀/特殊字符在派发时可还原原名）
                # 修复 alias 碰撞（本轮）：以完整净化函数名为键存 (server, tool) 二元组
                # ——原 split('__', 2) 猜段时，server 名含 '__'（如 'a__b'）会使猜出的
                # server 段与其它条目互相覆盖（server_alias['a'] 被后写的服务器抢走），
                # 派发时 _resolve_names 把调用路由到错服务器。完整键 + 前端
                # mcpParseName 的 (.+?)__(.+) 分段无损互換，杜绝碰撞。
                tool_alias[fname] = (name, tool.get('name', ''))
                desc = '[MCP·%s] %s' % (
                    name, tool.get('description') or tool.get('name') or '')
                if len(desc) > self.MAX_TOOL_DESC_CHARS:
                    desc = desc[:self.MAX_TOOL_DESC_CHARS] + '…[已截断]'
                    n_trunc_desc += 1
                out.append({'type': 'function', 'function': {
                    'name': fname,
                    'description': desc,
                    'parameters': tool.get('inputSchema')
                                  or {'type': 'object', 'properties': {}},
                }})
            if n_skip_total:
                break
        if n_skip_total:
            # 总量闸触顶：break 时只记了首个，这里一次性精确记账
            # （全部候选工具数 - 已发射数）
            total_tools = sum(len((self._rt.get(n) or {}).get('tools') or [])
                              for n in names)
            n_skip_total = max(0, total_tools - len(out))
        with self._lock:
            self._tool_alias = tool_alias
            # W10 TOFU：schema hash 快照（server → sha256(tools 规范化 JSON)）。
            # 首次见 → 记录（trust on first use）；与快照不符 → schema_review
            # 状态（该 server 工具在 check_tool/call_tool 判定链最前面被阻断——
            # block/error + 审计，防「服务器悄悄换工具」的供应链偷袭；人工在
            # mcp 面板 schema_review_ack 后解除）。哈希只覆盖
            # name+description+inputSchema+annotations
            # （ tierOverrides 等用户配置不算服务器侧变更）。
            for name in names:
                entry = self._rt.get(name) or {}
                canon = json.dumps(
                    [{'name': t.get('name'), 'description': t.get('description'),
                      'inputSchema': t.get('inputSchema'),
                      'annotations': t.get('annotations')}
                     for t in entry.get('tools') or []],
                    sort_keys=True, ensure_ascii=False)
                h = hashlib.sha256(canon.encode('utf-8')).hexdigest()
                prev = self._schema_hash.get(name)
                if prev is None:
                    self._schema_hash[name] = h
                elif prev != h:
                    self._schema_review.add(name)
                    self._log.warning(
                        'MCP 服务器 %s 工具 schema 变更（TOFU 告警）：需人工重审', name)
                else:
                    self._schema_review.discard(name)
            self._floor_stats = {'truncated_desc': n_trunc_desc,
                                 'skipped_per_server': n_skip_server,
                                 'skipped_total': n_skip_total,
                                 'emitted': len(out)}
        return out

    # ============ 档位 ============
    # W10 楼层规则（deep-research #126）：危险动作工具名/描述特征 → always 档。
    # 注解不可信（服务器可撒谎），工具名与描述里的破坏性动词是第二判据——
    # 与 destructiveHint 并列，任一命中即 always（防「只读注解的删除工具」）。
    _DANGER_PATTERNS = ('delete_', 'drop_', 'purge_', 'wipe_', 'remove_',
                       'destroy_', 'erase_', 'truncate_', 'format_')

    @staticmethod
    def _is_danger_tool(tool_name: str = '', description: str = '') -> bool:
        """W10 楼层规则特征判断：工具名危险动词开头或描述含同类破坏性表述。

        独立于 derive_tier 的兜底语义——resolve_tier 用它区分
        「危险特征命中（floor-rule）」与「无注解兜底（default）」两种 always。
        """
        name = str(tool_name or '').lower()
        desc = str(description or '').lower()
        for pat in McpService._DANGER_PATTERNS:
            if name.startswith(pat) or (' ' + pat.rstrip('_')) in desc \
                    or pat.rstrip('_') + ' ' in desc:
                return True
        return False

    @staticmethod
    def derive_tier(annotations: dict, tool_name: str = '', description: str = '',
                    input_schema: dict = None) -> str:
        """注解 + 楼层规则推导默认档位（注解不可信：最宽 session，永不放宽 off）。

        W10 楼层规则：工具名以下划线危险动词开头（delete_/drop_/purge_/wipe_/
        remove_/destroy_/erase_/truncate_/format_）或描述含同类破坏性表述 →
        always 档（无论注解如何标注——服务器注解可伪造，名字撒谎成本高）。

        批 3b（M2.10 R36）：纯增 kwarg input_schema——提供且 schema_poison_signals
        非空 → always（参数面投毒=供应链偷袭面：readOnly 注解的工具参数里藏
        shell 元字符枚举/default 命令，照样每次确认）。既有三参调用零改。"""
        a = annotations or {}
        if input_schema is not None and schema_poison_signals(input_schema):
            return 'always'
        if a.get('destructiveHint') is True:
            return 'always'
        name = str(tool_name or '').lower()
        desc = str(description or '').lower()
        for pat in McpService._DANGER_PATTERNS:
            if name.startswith(pat) or (' ' + pat.rstrip('_')) in desc \
                    or pat.rstrip('_') + ' ' in desc:
                return 'always'
        if a.get('readOnlyHint') is True:
            return 'session'
        return 'always'      # 无注解 → 保守每次确认

    @staticmethod
    def function_name(server: str, tool: str) -> str:
        """mcp__<server>__<tool> 净化（§3.6）。"""
        s = re.sub(r'[^A-Za-z0-9_-]', '_', str(server or '')).strip('_') or 'server'
        t = re.sub(r'[^A-Za-z0-9_-]', '_', str(tool or '')).strip('_') or 'tool'
        name = 'mcp__%s__%s' % (s, t)
        if len(name) > 64:                      # GLM/OpenAI 函数名上限
            h = hashlib.sha256(name.encode('utf-8')).hexdigest()[:6]
            name = name[:57] + '_' + h
        return name

    @staticmethod
    def _unique_name(name: str, used: dict) -> str:
        """同会话净化后重名 → _2/_3 后缀（保证 LLM 看到的函数名唯一）。"""
        if name not in used:
            used[name] = 1
            return name
        while True:
            used[name] += 1
            cand = '%s_%d' % (name, used[name])
            if cand not in used:
                used[cand] = 1
                return cand

    def _resolve_names(self, server, tool):
        """修复 ㉒：前端从净化函数名（mcp__srv__tool[_2]）反解出原始 server/tool。

        修复 alias 碰撞（本轮）：以完整净化函数名为键查 tool_alias——
        前端 mcpParseName 的 (.+?)__(.+) 分段经 'mcp__%s__%s' 可无损重建
        原函数名；不再 split('__',2) 猜段（server 名含 '__' 时猜出的段会
        互相覆盖，派发到错服务器）。未命中（LLM  hallucination/表未建）→
        原样返回，由下游 cfg 不存在分支给人话错误。
        """
        fkey = 'mcp__%s__%s' % (str(server or ''), str(tool or ''))
        with self._lock:
            hit = self._tool_alias.get(fkey)
        if hit is not None:
            return hit[0], hit[1]
        return server, tool

    def resolve_tier(self, server: str, tool: str):
        """(tier, source)：tierOverrides > 注解+楼层规则推导 > 兜底 always。

        W10 楼层规则（deep-research #126）：无注解或注解不可信时，工具名/
        描述的危险动词特征仍可推导 always——delete_/drop_/purge_/wipe_ 等
        开头或描述含同类破坏性表述，一律 always（名字撒谎成本 > 注解）。
        """
        cfg = self._cfg.get_server(server) or {}
        override = (cfg.get('tierOverrides') or {}).get(tool)
        if override in ('always', 'session', 'off'):
            return override, 'override'
        entry = self._rt.get(server) or {}
        for t in entry.get('tools') or []:
            if t.get('name') == tool:
                # 批 3b（M2.10 R36）：schema 投毒优先于注解（注解不可信）——
                # 参数面四维检测命中 → always + tier_source='schema-poison'
                _schema = t.get('inputSchema')
                if _schema is not None and schema_poison_signals(_schema):
                    return 'always', 'schema-poison'
                annotations = t.get('annotations')
                if annotations:
                    return self.derive_tier(annotations), 'annotation'
                # 无注解：危险特征 → floor-rule；无特征兜底 always → default
                if self._is_danger_tool(t.get('name', ''), t.get('description', '')):
                    return 'always', 'floor-rule'
                break
        return 'always', 'default'

    def _tool_view(self, server: str, tool: dict) -> dict:
        tier, source = self.resolve_tier(server, tool.get('name', ''))
        return {'name': tool.get('name', ''),
                'description': tool.get('description') or '',
                'annotations': tool.get('annotations') or {},
                'tier': tier, 'tier_source': source}

    # ============ 护栏 ============
    def check_tool(self, server: str, tool: str, arguments: dict = None) -> dict:
        """定档判定（前端确认框依据）：off=allow / always|session=confirm / 不可用=block。"""
        server, tool = self._resolve_names(server, tool)   # 修复 ㉒：净化名反解
        # W10 TOFU（本轮：标记升级为真阻断）：工具 schema 静默变更待人工重审
        # 期间，该 server 全部工具在判定链最前面拦截（原只 tool_schemas 标记
        # schema_review + 面板提示，check/call 不拦——供应链偷袭场景等于不阻断）。
        if self._schema_review_pending(server):
            self._audit(server, tool, arguments, 'block')
            return {'action': 'block',
                    'reason': 'MCP 服务器 %s 工具 schema 已变更，需人工重审后才能继续调用'
                              '（mcp 面板确认）' % server}
        cfg = self._cfg.get_server(server)
        if not cfg:
            self._audit(server, tool, arguments, 'block')
            return {'action': 'block', 'reason': 'MCP 服务器 %s 不存在。' % server}
        if not cfg.get('enabled'):
            self._audit(server, tool, arguments, 'block')
            return {'action': 'block',
                    'reason': 'MCP 服务器 %s 未启用（可能已禁用或崩溃），请先在设置中测试连接。' % server}
        tier, source = self.resolve_tier(server, tool)
        self._audit(server, tool, arguments, 'check', tier=tier, source=source)
        if tier == 'off':
            return {'action': 'allow', 'tier': tier, 'tier_source': source}
        return {'action': 'confirm', 'tier': tier, 'tier_source': source,
                'reason': '该工具需要确认（档位 %s）。' % tier}

    def call_tool(self, server: str, tool: str, arguments: dict = None,
                  decision: str = 'deny', token: str = None) -> dict:
        """执行 MCP 工具（后端二次 enforce + 审计 + 按需拉起 + 结果渲染）。

        修复 S4①：护栏武装后（桌面 UI 会话），always 档还须一次性 confirm token，
        session 档须 token 或后端会话信任——前端注入伪造 decision='allow' 不再够用。"""
        arguments = arguments or {}
        server, tool = self._resolve_names(server, tool)   # 修复 ㉒：净化名反解
        # W10 TOFU（本轮：标记升级为真阻断）：工具 schema 静默变更待人工重审
        # 期间，该 server 全部工具在判定链最前面拦截（原只 tool_schemas 标记
        # schema_review + 面板提示，call 不拦——供应链偷袭场景等于不阻断）。
        if self._schema_review_pending(server):
            self._audit(server, tool, arguments, 'block')
            return {'error': 'MCP 服务器 %s 工具 schema 已变更，需人工重审后才能继续调用'
                            '（mcp 面板确认）' % server}
        cfg = self._cfg.get_server(server)
        if not cfg:
            self._audit(server, tool, arguments, 'block')
            return {'error': 'MCP 服务器 %s 不存在。' % server}
        if not cfg.get('enabled'):
            self._audit(server, tool, arguments, 'block')
            return {'error': 'MCP 服务器 %s 未启用（可能已禁用或崩溃），请先在设置中测试连接。' % server}
        tier, source = self.resolve_tier(server, tool)

        # 用户显式拒绝（任何档位）→ 审计 decision=deny + Agent 可见人话（§14: {info, skipped}）
        if decision == 'deny':
            self._audit(server, tool, arguments, 'decision', 'deny', tier, source)
            return {'info': '用户拒绝了本次 MCP 工具调用（%s · %s）。请调整方案或询问用户意图，'
                            '不要原样重试。' % (server, tool), 'skipped': True}
        # enforce 矩阵：off 放行；session/always 需 decision∈{allow, session-trust}
        if tier != 'off' and decision not in ('allow', 'session-trust'):
            self._audit(server, tool, arguments, 'block', decision or 'deny', tier, source)
            return {'error': '该工具需要确认（档位 %s）。请通过界面确认后重试，'
                             '不要绕过确认流程。' % tier}
        # 修复 S4①：武装后 token/会话信任后端强制（未武装环境保持原 decision 矩阵）
        if tier != 'off' and getattr(self._guard, 'armed', False):
            trust_key = '%s__%s' % (server, tool)
            # 修复 W4：token 绑定实参摘要（arguments）——防「确认 A 参数、
            # 执行 B 参数」；签发侧（前端确认框）须传同口径 detail
            token_ok = bool(token) and self._guard.consume_token(
                'mcp_call', {'server': server, 'tool': tool,
                             'arguments': arguments}, token)
            # 修复 W4（二轮）：信任判定不区分档位（与 guard 信任前移同型）——
            # 原只在 session 档查信任，always 档「本会话不再提示」登记后永不生效
            with self._lock:
                trusted = trust_key in self._session_trust
            if not token_ok and not trusted:
                self._audit(server, tool, arguments, 'block', 'token-missing', tier, source)
                return {'error': '该工具需要界面确认后携带一次性确认 token 执行（档位 %s），'
                                 '请通过界面确认流程，不要绕过。' % tier}
            if token_ok and decision == 'session-trust':
                with self._lock:
                    self._session_trust.add(trust_key)

        entry = self._ensure_entry(server)
        # 修复 ⑭（三轮）：call_tool 每调两次 get_server（deepcopy + DPAPI 解密热路径）
        # ——本处已持有解密视图 cfg，直接传给 _get_or_spawn 复用
        client, error = self._get_or_spawn(server, entry, cfg=cfg)
        if error:
            # 修复 建议⑱（二轮）：spawn 失败时退还已消耗的 token——
            # 用户在界面确认过，不应因服务器拉起失败被白扣一次确认
            if token and hasattr(self._guard, 'refund_token'):
                try:
                    self._guard.refund_token('mcp_call', {'server': server, 'tool': tool,
                                                          'arguments': arguments}, token)
                except Exception:
                    pass
            self._audit(server, tool, arguments, 'decision', decision, tier, source)
            return {'error': error}
        # 实现 v1.6 W21：stale 300s 自动重 List（S3 规格的生产调用方）——list_changed
        # 通知漏达/刷新失败后的兜底；refreshing 去抖防双弹，status stale→ok 由
        # _refresh_tools 收口（无状态错乱）。
        # 修复时钟基不匹配（本轮）：entry['last_list_at'] 是 time.monotonic()
        # 打点（_relist/_refresh_tools/test_server 同口径），而 stale_needs_relist
        # 默认 now 取 time.time()——两者相差 epoch 秒数，恒判 stale：每次调用都
        # 触发一次后台 tools/list 往返 + status 被拍成 stale。显式传单调时钟对齐。
        try:
            if stale_needs_relist(entry.get('last_list_at'), now=time.monotonic()):
                self._on_list_changed(server)
        except Exception:
            # 修复 N18（四轮）：删除合并残留死代码——原 `pass` 之后还有 `return {'error': error}`
            # （error 恒 None/''），一旦本段异常触发即以 null 错误放弃调用，与「吞异常继续」
            # 的注释意图相悖
            pass
        t0 = time.monotonic()
        # 修复 F2（v1.4）：每服务器 callTimeout 覆盖默认阈值（mcp_servers.json，10-300s）
        # 修复 ⑭（三轮）：cfg_ro 复用入口处已持有的解密视图 cfg——原此处再次
        # get_server（又一次 deepcopy + DPAPI 解密，热路径每调一次）
        cfg_ro = cfg or {}
        try:
            _ct = int(cfg_ro.get('callTimeout'))
        except (TypeError, ValueError):
            _ct = CALL_TIMEOUT
        eff_timeout = min(max(_ct, CALL_TIMEOUT_MIN), CALL_TIMEOUT_MAX)
        # 实现 v1.6 W21：HTTP 服务器并行 tools/call 走 ConcurrencyLimiter
        # （max_concurrency 生产接线；超限排队不拒绝；stdio 天然串行不装）
        limiter = self._limiter(server, cfg_ro)
        try:
            if limiter is not None:
                with limiter:
                    result = client.call_tool(tool, arguments, eff_timeout)
            else:
                result = client.call_tool(tool, arguments, eff_timeout)
        except McpTimeoutError:
            entry['last_error'] = 'timeout'
            self.report_result(server, False)
            self._audit(server, tool, arguments, 'decision', decision, tier, source)
            # 修复 ㉑：超时时长用实际生效值而非硬编码
            return {'error': 'MCP 工具调用超时（%d 秒），已发送取消。可重试或确认服务器是否卡死。'
                             % eff_timeout}
        except McpProtocolError as e:
            entry['last_error'] = e.message
            self.report_result(server, False)
            self._audit(server, tool, arguments, 'decision', decision, tier, source)
            return {'error': self._protocol_error_text(e)}
        except Exception as e:
            entry['last_error'] = str(e)
            self.report_result(server, False)
            self._audit(server, tool, arguments, 'decision', decision, tier, source)
            return {'error': 'MCP 工具调用失败: %s' % e}
        rendered = self._render_result(result)
        self.report_result(server, True)
        self._audit(server, tool, arguments, 'decision', decision, tier, source)
        return rendered

    # ============ v1.6 T12：MCP resources（list/read + 订阅；text 优先，blob 落盘）============
    def list_resources(self, name):
        """resources/list（按需拉起后调用；结果入 entry['resources']）。

        服务器不支持 resources（-32601 Method not found）→ 按「无资源」返回
        {ok, resources: [], supported: False}，不视为错误（规范：resources 是
        可选能力）。annotations 不可信原则沿用（readOnly 注解不当免检依据）。
        """
        name = str(name)
        cfg = self._cfg.get_server(name)
        if not cfg:
            return {'error': 'MCP 服务器 %s 不存在。' % name}
        if not cfg.get('enabled'):
            return {'error': 'MCP 服务器 %s 未启用。' % name}
        entry = self._ensure_entry(name)
        client, error = self._get_or_spawn(name, entry, cfg=cfg)
        if error:
            return {'error': error}
        try:
            resources = client.list_resources()
        except McpProtocolError as e:
            if getattr(e, 'code', None) == -32601:
                with entry['lock']:
                    entry['resources'] = []
                return {'ok': True, 'resources': [], 'supported': False}
            return {'error': self._protocol_error_text(e)}
        except Exception as e:
            return {'error': 'MCP 资源列表获取失败: %s' % e}
        with entry['lock']:
            entry['resources'] = resources
        return {'ok': True, 'resources': resources, 'supported': True}

    def read_resource(self, name, uri):
        """resources/read → 渲染：text 类直接给文；blob 类（base64）解码后截断
        落盘 toolcache（read_more 分段取）。资源注入等同工具结果 → 全程审计
        （op=mcp_resource，T12 安全口径）。"""
        name = str(name)
        uri = str(uri or '').strip()
        if not uri:
            return {'error': '缺少资源 uri'}
        cfg = self._cfg.get_server(name)
        if not cfg:
            self._audit(name, 'resources/read', {'uri': uri[:200]}, 'block', op='mcp_resource')
            return {'error': 'MCP 服务器 %s 不存在。' % name}
        if not cfg.get('enabled'):
            self._audit(name, 'resources/read', {'uri': uri[:200]}, 'block', op='mcp_resource')
            return {'error': 'MCP 服务器 %s 未启用。' % name}
        entry = self._ensure_entry(name)
        client, error = self._get_or_spawn(name, entry, cfg=cfg)
        if error:
            # 修复 N13（四轮）：基础设施失败不是用户拒绝——审计 action 用 error 而非 deny
            self._audit(name, 'resources/read', {'uri': uri[:200]}, 'error', op='mcp_resource')
            return {'error': error}
        try:
            result = client.read_resource(uri) or {}
        except Exception as e:
            # 修复 N13（四轮）：服务器失败同上，审计语义与用户决策（deny）区分
            self._audit(name, 'resources/read', {'uri': uri[:200]}, 'error', op='mcp_resource')
            return {'error': 'MCP 资源读取失败: %s' % e}
        contents = result.get('contents') or []
        texts, blobs = [], []
        for c in contents:
            if not isinstance(c, dict):
                continue
            if c.get('text'):
                texts.append(str(c.get('text')))
            elif c.get('blob'):
                blobs.append(str(c.get('blob')))
        self._audit(name, 'resources/read',
                    {'uri': uri[:200], 'texts': len(texts), 'blobs': len(blobs)},
                    'decision', 'allow', op='mcp_resource')
        # 修复 N13（四轮）：text 无长度上限——超大资源全量过 js_api 桥；超限走 toolcache
        # 截断（与 _render_result 输出上限同口径）
        _text = '\n\n'.join(texts)
        if len(_text) > OUTPUT_CACHE_LIMIT:
            cid = self._toolcache.cache(_text)
            _text = (_text[:OUTPUT_CACHE_LIMIT]
                     + ('\n…[资源共 %d 字已截断; id=%s, 用 read_more 分段获取]' % (len(_text), cid)
                        if cid else '\n…[资源共 %d 字已截断; 全文未保留]' % len(_text)))
        out = {'ok': True, 'uri': uri, 'text': _text}
        if blobs:
            import base64 as _b64
            try:
                raw = b''.join(_b64.b64decode(b) for b in blobs)
            except Exception:
                raw = '\n\n'.join(blobs).encode('utf-8', 'replace')
            cid = self._toolcache.cache(raw.decode('utf-8', 'replace'))
            out['blob_bytes'] = len(raw)
            if cid:
                out['blob_cached'] = True
                out['cache_id'] = cid
                out['hint'] = '二进制资源已落盘（id=%s），read_more 分段读取' % cid
            else:
                out['blob_cached'] = False
        return out

    def save_subscriptions(self, name, uris):
        """保存资源订阅（mcp_servers.json 新可选键 resourceSubs；Claude 兼容结构
        忽略未知键，老配置零影响）。uris 可为 JSON 数组字符串。"""
        name = str(name)
        cfg = self._cfg.get_server(name)
        if not cfg:
            return {'error': 'MCP 服务器 %s 不存在。' % name}
        if isinstance(uris, str):
            try:
                uris = json.loads(uris or '[]')
            except Exception:
                return {'error': 'uris 需要是 JSON 数组'}
        if not isinstance(uris, list):
            return {'error': 'uris 需要是数组'}
        clean = [str(u).strip()[:500] for u in uris
                 if isinstance(u, str) and u.strip()][:100]
        cfg = dict(cfg)
        cfg['resourceSubs'] = clean
        r = self._cfg.save_server(name, cfg)
        if r and r.get('error'):
            return {'error': r['error']}
        self._audit(name, 'resources/subscribe', {'count': len(clean)},
                    'decision', 'allow', op='mcp_resource')
        return {'ok': True, 'subscribed': clean}

    def subscriptions(self, name):
        """已订阅资源 uri 列表（注入上下文时由上层消费）。"""
        cfg = self._cfg.get_server(str(name)) or {}
        subs = cfg.get('resourceSubs')
        return list(subs) if isinstance(subs, list) else []

    # ============ 生命周期 ============
    def _limiter(self, name, cfg):
        """实现 v1.6 W21：每服务器 ConcurrencyLimiter（池配置键的生产调用方）。

        HTTP 传输（cfg.url 非空）按 effective_pool_config(cfg.pool).max_concurrency
        限并行（超限排队不拒绝）；stdio 单进程天然串行 → None 不装。
        max_concurrency 变更时重建（配置热更新场景）。"""
        if not cfg or not cfg.get('url'):
            return None
        pool_cfg = effective_pool_config(cfg.get('pool'))
        want = pool_cfg.get('max_concurrency') or 4
        with self._lock:
            lim = self._limiters.get(name)
            if lim is None or lim.max_concurrent != want:
                lim = ConcurrencyLimiter(max_concurrent=want)
                self._limiters[name] = lim
            return lim

    def _ensure_entry(self, name):
        with self._lock:
            entry = self._rt.get(name)
            if entry is None:
                entry = _entry_template()
                self._rt[name] = entry
            return entry

    def forget(self, name):
        """删除服务器时清运行时（关客户端）。"""
        name = str(name)
        with self._lock:
            entry = self._rt.pop(name, None)
            # 实现 v1.6 W25：代际递增——与 _get_or_spawn 的在途拉起竞态时，
            # 拉起完成后发现代际已变 → 立即关闭新 client（防孤儿泄漏）
            self._gen[name] = self._gen.get(name, 0) + 1
            self._limiters.pop(name, None)
        if entry is not None:
            with entry['lock']:
                self._close_client(entry, name)

    def shutdown(self) -> dict:
        """逆序关闭全部传输（main.py atexit 注册）。返回 {ok, closed}。"""
        self._reaper_stop.set()
        closed = 0
        with self._lock:
            entries = list(self._rt.values())
        for entry in entries:
            with entry['lock']:
                if entry.get('client') is not None:
                    try:
                        entry['client'].close()
                    except Exception:
                        pass
                    entry['client'] = None
                    closed += 1
        # 修复 S2（v1.5.1）：关闭全部温启条目（pop 出 client 逐个关，防子进程泄漏）
        # 修复 W2（本轮）：pop_expired 对过期条目同样返回 client 本体——原 pop 对
        # 过期条目返回 None，shutdown 时过期 client 无人关闭（温启条目泄漏）。
        for server in self._warm.stats()['warm']:
            client, _expired = self._warm.pop_expired(server)
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
                closed += 1
        return {'ok': True, 'closed': closed}

    # ============ 定期重验（批 3b，M2.10 R36） ============
    def _reverify_due(self, name, entry) -> bool:
        """到期判定：enabled 且非停用；间隔按 server_health(name) 取档
        （ok 24h / degraded 1h / error 15min）；lastReverifyAt 缺失或不可解析
        → 立即到期（首验口径）。reverifyEnabled=False 为用户显式窄关闭（禁全局）。"""
        cfg = self._cfg.get_server(name) or {}
        if not cfg.get('enabled'):
            return False
        if cfg.get('reverifyEnabled') is False:
            return False
        last = str(cfg.get('lastReverifyAt') or '')
        if not last:
            return True
        try:
            last_ts = _parse_iso_utc(last)
        except Exception:
            return True
        health = self.server_health(name)
        interval = {'ok': REVERIFY_OK_S, 'degraded': REVERIFY_DEGRADED_S,
                    'error': REVERIFY_ERROR_S}.get(health, REVERIFY_OK_S)
        return (time.time() - last_ts) >= interval

    def _reverify_one(self, name) -> bool:
        """轻量重验：持 entry 锁取既有 client（无则跳过——不新 spawn，防重验变
        冷启风暴）→ tools/list → schema hash 对拍（canon 口径同 schema_review_ack）
        → 变更 → _schema_review 入列（TOFU 阻断既有机制；entry['tools'] 同步更新
        为新清单，供 ack 以新 schema 为快照基准）→ 成功 → lastReverifyAt 落
        mcp_servers.json（纯增键原子写）。返回是否完成一次重验。"""
        entry = self._rt.get(name)
        if entry is None:
            return False
        with entry.get('lock', threading.RLock()):
            client = entry.get('client')
        if client is None:
            return False
        try:
            tools = client.list_tools()
        except Exception as e:
            self._log.debug('MCP 服务器 %s 定期重验失败: %r', name, e)
            return False
        canon = json.dumps(
            [{'name': t.get('name'), 'description': t.get('description'),
              'inputSchema': t.get('inputSchema'),
              'annotations': t.get('annotations')}
             for t in tools],
            sort_keys=True, ensure_ascii=False)
        h = hashlib.sha256(canon.encode('utf-8')).hexdigest()
        # hash 对拍 + _schema_review 更新 + entry['tools'] 交换必须在同一次
        # self._lock 持有内原子完成——否则 tool_schemas（持 self._lock 读
        # entry['tools']）可能读到旧清单算出旧 hash 与快照相等，把刚置的
        # 「schema 变更待重审」阻断标志 discard 掉（TOFU 竞态窗口）
        with self._lock:
            prev = self._schema_hash.get(name)
            if prev is None:
                self._schema_hash[name] = h          # TOFU 首见：记录即信任
            elif prev != h:
                self._schema_review.add(name)
                self._log.warning(
                    'MCP 服务器 %s 定期重验发现 schema 变更（TOFU）：需人工重审', name)
            else:
                self._schema_review.discard(name)    # 恢复原样：解除待重审
            entry['tools'] = tools
            entry['last_list_at'] = time.monotonic()
        self._cfg.set_reverify_at(name, _utc_now_iso())
        return True

    def _idle_loop(self):
        # 修复 ㉑：等待切片化（≤1s）保证 shutdown 及时响应，但扫描周期按 IDLE_SWEEP_INTERVAL
        # 计（原 min(30,1.0) 使每次唤醒都全量扫描，与常量意图不符）；
        # 修复 ㊉：空闲计时统一单调时钟（time.monotonic，不受系统时间回拨影响）。
        last_sweep = time.monotonic()
        while not self._reaper_stop.wait(1.0):
            now = time.monotonic()
            if now - last_sweep < IDLE_SWEEP_INTERVAL:
                continue
            last_sweep = now
            with self._lock:
                entries = list(self._rt.items())
            for srv_name, entry in entries:
                # 修复（本轮）：entry 可能为外部/测试注入的裸 dict（无 'lock' 键）——
                # 原直接 entry['lock'] 令 reaper 线程 KeyError 崩溃后永不回收
                # （idle 收割静默停摆，且线程异常仅以 warning 形式闪现）。
                # 与 list_servers/get_server_detail 同口径：缺锁回落新锁。
                with entry.get('lock', threading.RLock()):
                    client = entry.get('client')
                    if client is not None and now - (entry.get('last_used') or now) > IDLE_TIMEOUT:
                        # 修复 S2（v1.5.1）设计修正：到期直接关闭（原语义）——不停留
                        # warm 续期（那会把停用服务器的子进程多留 600s，泄漏面放大）；
                        # warm 只承担「启用预热 + 索引可见性」，回收兜底仍由 IDLE 负责。
                        try:
                            client.close()
                        except Exception:
                            pass
                        entry['client'] = None
                        # 修复（本轮）：回收后 status 复位为 stale——原仅清 client，
                        # status 残留 'ok'，tool_schemas 仍把该 server 当活服务器发射
                        # 函数定义（LLM 调用才在 _get_or_spawn 冷启，面板/注入视图
                        # 与真实状态不符）。stale → 面板显示需重连，语义诚实。
                        entry['status'] = 'stale'
                        self._warm.unregister(srv_name)
                        self._log.info('MCP 服务器空闲超 %ss，已回收子进程', IDLE_TIMEOUT)
            # 修复 S2：warm 过期条目清理（reap 返回 (server, client) 对，直接 close——原
            # 「reap 摘除 + 调用方 pop」双保险实际反向：pop 恒 None，永不关闭）
            # 修复 N2（四轮）双保险：touch 续期为主，此处再校验「该 client 是否仍被活跃
            # entry 引用」——若 entry 正在使用同一 client（last_used 新鲜），重新登记并跳过
            # 关闭，防 use-after-close（回环实证：持续使用超 600s 的服务器被误杀）。
            for server, stale in self._warm.reap():
                if stale is None:
                    continue
                _entry = self._rt.get(server)
                if (_entry is not None and _entry.get('client') is stale
                        and now - (_entry.get('last_used') or 0) <= IDLE_TIMEOUT):
                    self._warm.register(server, stale)   # 活跃中：续期，不关
                    continue
                try:
                    stale.close()
                except Exception:
                    pass
                self._log.info('温启条目 %s 超 %ss 未用，已关闭', server, WARM_ENTRY_IDLE_TTL)
            # 批 3b（M2.10 R36）：定期重验扫描——到期且 enabled 的服务器轻量重验
            # （_reverify_due 检查 enabled/reverifyEnabled/间隔取档；_reverify_one
            # 对无 client 的服务器跳过不 spawn——不新起线程、不占 dispatcher）
            try:
                for s in self._cfg.list_servers():
                    if not s.get('enabled'):
                        continue
                    _name = s['name']
                    if self._rt.get(_name) is not None \
                            and self._reverify_due(_name, self._rt[_name]):
                        self._reverify_one(_name)
            except Exception:
                self._log.debug('MCP 定期重验扫描异常', exc_info=True)

    # ============ 拉起/重拉 ============
    def _get_or_spawn(self, name, entry=None, cfg=None):
        """双检锁：活客户端直接用；进程已死 → 重拉一次；无客户端 → 按需拉起。

        修复 ⑭（三轮）：cfg 参数——调用方（call_tool）已持解密视图时可传入复用，
        省一次 get_server 的 deepcopy + DPAPI 解密（热路径）。
        实现 v1.6 W25：spawn 前后比对 forget() 代际——拉起期间服务器被删/停用，
        新 client 对调用方不可达即孤儿：立即关闭并返回人话错误。
        实现 v1.6 W24：崩溃重拉成功同样登记 warm（原只登记冷启路径）。
        """
        entry = entry or self._ensure_entry(name)
        cfg = cfg or self._cfg.get_server(name)
        if not cfg:
            return None, 'MCP 服务器 %s 不存在。' % name
        if not cfg.get('enabled'):
            return None, ('MCP 服务器 %s 未启用（可能已禁用或崩溃），'
                          '请先在设置中测试连接。' % name)
        gen = self._gen.get(name, 0)
        with entry['lock']:
            client = entry.get('client')
            if client is not None:
                if client.is_alive():
                    entry['last_used'] = time.monotonic()
                    self._warm.touch(name)   # 修复 N2（四轮）：使用即续期，防 warm.reap 误杀活跃 client
                    return client, None
                # 进程已死 → 自动重拉一次（R6 兜底）
                # 真实属性是 _transport（StdioTransport 有 returncode property；HTTP 无 → None → 显示 ?）
                rc = getattr(getattr(client, '_transport', None), 'returncode', None)
                self._close_client(entry, name)   # 修复 ⑯（三轮）：传 name 同步摘 warm
                client, error = self._spawn_client(name, cfg)
                if error:
                    entry['status'] = 'error'
                    entry['last_error'] = (
                        'MCP 服务器进程已崩溃（退出码 %s），已自动重拉一次；仍失败请检查服务器后重试。%s'
                        % (rc if rc is not None else '?', error))
                    return None, entry['last_error']
                if self._gen.get(name, 0) != gen:
                    # 实现 v1.6 W25：拉起期间被 forget —— 关闭新 client 防孤儿
                    try:
                        client.close()
                    except Exception:
                        pass
                    return None, ('MCP 服务器 %s 在重拉期间被删除或停用，本次调用已取消。'
                                  % name)
                entry['client'] = client
                entry['status'] = 'ok'
                entry['last_error'] = ''
                entry['last_used'] = time.monotonic()
                self._warm.register(name, client)   # 修复 W24（v1.6）：崩溃重拉也登记温启
                self._relist(entry, client)
                return client, None
            # 按需拉起
            # 修复 S2（v1.5.1）：温启优先——warm 表有活 client（启用/测试后保留的）
            # 直接上车，跳过 spawn（首调用零延迟）；死的/过期的丢弃再走冷启
            # 修复 W2（本轮）：warm 路径经 pop_expired 取出条目本体——原 get 命中
            # 过期分支只摘表、不返回 client，过期条目（含仍活着的 stdio 子进程/
            # HTTP 连接）无人关闭，直接泄漏；现在过期/已死的 client 都在本路径
            # 显式 close 后再走冷启。
            warm_client, warm_expired = self._warm.pop_expired(name)
            if warm_client is not None:
                try:
                    if not warm_expired and warm_client.is_alive():
                        if self._gen.get(name, 0) != gen:
                            # 实现 v1.6 W25：温启采用前发现代际已变（forget 竞态）
                            try:
                                warm_client.close()
                            except Exception:
                                pass
                            return None, ('MCP 服务器 %s 在调用前被删除或停用，本次调用已取消。'
                                          % name)
                        entry['client'] = warm_client
                        entry['status'] = 'ok'
                        entry['last_error'] = ''
                        entry['last_used'] = time.monotonic()
                        self._warm.register(name, warm_client)   # 重新登记=续期（N2 同口径）
                        self._relist(entry, warm_client)
                        return warm_client, None
                except Exception:
                    pass
                # 温启条目已死/已过期：关掉再冷启（close 防子进程/连接泄漏）
                try:
                    warm_client.close()
                except Exception:
                    pass
            client, error = self._spawn_client(name, cfg)
            if error:
                entry['status'] = 'error'
                entry['last_error'] = error
                return None, error
            if self._gen.get(name, 0) != gen:
                # 实现 v1.6 W25：冷启期间被 forget —— 关闭新 client 防孤儿
                try:
                    client.close()
                except Exception:
                    pass
                return None, ('MCP 服务器 %s 在拉起期间被删除或停用，本次调用已取消。'
                              % name)
            entry['client'] = client
            entry['status'] = 'ok'
            entry['last_error'] = ''
            entry['last_used'] = time.monotonic()
            self._warm.register(name, client)   # 修复 S2：冷启成功也登记温启
            self._relist(entry, client)
            return client, None

    def _relist(self, entry, client):
        """拉起后补一次 tools/list（重启后缓存为空时必须；异常不阻断调用）。"""
        try:
            entry['tools'] = client.list_tools()
            entry['server_info'] = client.server_info
            entry['instructions'] = client.instructions
            entry['last_list_at'] = time.monotonic()   # 实现 v1.6 W21：stale 检测基线
            try:
                client.clear_list_changed()     # 修复 ⑨：标志复位
            except Exception:
                pass
        except Exception as e:
            self._log.debug('拉起后 tools/list 失败: %r', e)

    @staticmethod
    def _sanitize_secret_mapping(mapping):
        """修复 W21：解密失败的值（仍以 dpapi: 开头的密文串）置 ''，绝不下发子进程/HTTP 头。"""
        out = {}
        for k, v in (mapping or {}).items():
            s = str(v if v is not None else '')
            out[str(k)] = '' if s.startswith('dpapi:') else s
        return out

    def _spawn_client(self, name, cfg):
        """创建传输 + 客户端并握手。返回 (client, None) 或 (None, 人话错误)。

        修复 S2（v1.5.1）：spawn 打点（t0→ready 毫秒数，状态面板「冷启耗时 Nms」）。"""
        _t_spawn = time.monotonic()
        if cfg.get('url'):
            transport = HttpTransport(cfg['url'], self._sanitize_secret_mapping(cfg.get('headers')),
                                      logger=self._log)
            target = cfg['url']
        else:
            transport = StdioTransport(logger=self._log)
            # 修复 W19：precheck 做 expandvars 而原 spawn 不做，含 %VAR% 命令预检过但启动失败；
            # 拉起前统一展开环境变量
            command = os.path.expandvars(str(cfg.get('command') or ''))
            args = [os.path.expandvars(str(a)) for a in (cfg.get('args') or [])]
            target = command
            if not transport.start(command, args,
                                   self._sanitize_secret_mapping(cfg.get('env'))):
                return None, self._spawn_fail_text(target)
        client = McpClient(transport, logger=self._log)
        client.set_on_list_changed(lambda n=name: self._on_list_changed(n))
        try:
            client.connect()
        except McpVersionError as e:
            client.close()
            return None, self._version_text(e)
        except McpTimeoutError:
            client.close()
            return None, self._spawn_fail_text(target, '握手超时')
        except McpProtocolError as e:
            client.close()
            return None, self._spawn_fail_text(target, e.message)
        except Exception as e:
            client.close()
            return None, self._spawn_fail_text(target, str(e))
        self._spawn_ms[name] = round((time.monotonic() - _t_spawn) * 1000)   # 修复 S2：冷启打点
        return client, None

    def _on_list_changed(self, name):
        """tools/list_changed：标记 stale + 后台刷新（刷新在独立线程，不占 dispatcher）。

        修复 W22：entry 级 refreshing 去抖——通知洪泛时合并为一次刷新，不再每条起一个线程。"""
        entry = self._rt.get(name)
        if entry is None:
            return
        with entry['lock']:
            if entry.get('refreshing'):
                return
            entry['refreshing'] = True
            entry['status'] = 'stale'
            entry['last_error'] = ''
        threading.Thread(target=self._refresh_tools, args=(name,),
                         daemon=True, name='mcp-refresh').start()

    def _refresh_tools(self, name):
        entry = self._rt.get(name)
        if entry is None:
            return
        client = entry.get('client')
        if client is None:
            with entry['lock']:
                entry['refreshing'] = False
            return                      # 已回收：下次按需拉起时自然刷新
        # 修复 建议⑲（二轮）：list_tools 网络 IO 移出 entry 锁——原持锁做 15s 阻塞，
        # 期间 shutdown/call_tool/idle 回收全部干等
        try:
            tools = client.list_tools()
            with entry['lock']:
                entry['tools'] = tools
                entry['status'] = 'ok'
                entry['last_error'] = ''
                entry['last_list_at'] = time.monotonic()   # 实现 v1.6 W21：刷新成功即非 stale
                try:
                    client.clear_list_changed()     # 修复 ⑨：标志复位
                except Exception:
                    pass
        except Exception as e:
            with entry['lock']:
                entry['status'] = 'error'
                entry['last_error'] = self._failure_text(e)
        finally:
            with entry['lock']:
                entry['refreshing'] = False

    def _close_client(self, entry, name=None):
        # 修复 S2（v1.5.1）：显式关闭（删除/停用/崩溃重拉）时同步摘 warm——
        # 否则 warm 仍持死 client，下次 get 命中后 is_alive 检查才丢（多一次往返）
        if name is not None:
            self._warm.unregister(name)
        client = entry.get('client')
        entry['client'] = None
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    # ============ 结果渲染 ============
    def _render_result(self, result) -> dict:
        """MCP tools/call result → {ok, output} / {error}（isError）；超长截断落盘。"""
        result = result or {}
        text = self._content_text(result)
        if result.get('isError'):
            return {'error': text or 'MCP 工具返回执行错误（isError）。'}
        if not text:
            sc = result.get('structuredContent')
            if sc is not None:
                try:
                    text = json.dumps(sc, ensure_ascii=False, indent=2)
                except Exception:
                    text = str(sc)
        if not text:
            text = '（MCP 工具无返回内容）'
        if len(text) > OUTPUT_CACHE_LIMIT:
            cid = self._toolcache.cache(text)
            if cid:
                text = (text[:OUTPUT_CACHE_LIMIT] +
                        '\n…(输出过长已截断，全文 %d 字符；续读 read_more(cache_id="%s", '
                        'offset=0, limit=2000))' % (len(text), cid))
            else:
                # 修复 W19（二轮）：落盘失败也不能让超长原文进上下文（撑爆 prompt）
                self._log.warning('toolcache 落盘失败，超长输出已硬截断')
                text = (text[:OUTPUT_CACHE_LIMIT] +
                        '\n…(输出过长已截断；缓存落盘失败，无法 read_more 续读)')
        return {'ok': True, 'output': text}

    @staticmethod
    def _content_text(result) -> str:
        parts = []
        for item in (result or {}).get('content') or []:
            if not isinstance(item, dict):
                continue
            t = item.get('type')
            if t == 'text':
                parts.append(str(item.get('text') or ''))
            elif t in ('image', 'audio'):
                parts.append('[MCP %s %s，v1.3 不在对话中展示]'
                             % ('图片' if t == 'image' else '音频', item.get('mimeType') or ''))
            elif t == 'resource':
                res = item.get('resource') or {}
                parts.append('[MCP 资源 %s]' % (res.get('uri') or res.get('name') or ''))
            else:
                parts.append(json.dumps(item, ensure_ascii=False)[:500])
        return '\n'.join(p for p in parts if p)

    # ============ 错误人话映射（共享知识 4）============
    @staticmethod
    def _spawn_fail_text(target, extra='') -> str:
        base = ('无法启动 MCP 服务器（命令：%s）。请确认该命令已安装且可在命令行运行。'
                % (target or '?'))
        return base + ('（%s）' % extra if extra else '')

    @staticmethod
    def _version_text(e: McpVersionError) -> str:
        text = ('该 MCP 服务器支持协议版本 %s，Harbor 支持 %s。请升级该服务器，'
                '或在设置中暂时禁用它。' % (e.server_version, MCP_PROTOCOL_VERSION))
        if e.supported:
            text += '（服务器支持版本：%s）' % ', '.join(str(v) for v in e.supported)
        return text

    @staticmethod
    def _protocol_error_text(e: McpProtocolError) -> str:
        if e.code == -32602:
            return '服务器未提供该工具（可能已升级/卸载）。可在设置中刷新工具列表后重试。'
        if e.code == -32601:
            # 修复 ㉑：此处是 tools/call 等【我方请求】收到的 -32601，原文案错配成服务器反向请求
            return '服务器不认识该请求方法（-32601），可能服务器版本过旧或该能力已被移除。'
        return 'MCP 协议错误（%s）：%s' % (e.code, e.message)

    @staticmethod
    def _failure_text(e) -> str:
        if isinstance(e, McpTimeoutError):
            return 'MCP 请求超时（%s 秒）。可重试或确认服务器是否卡死。' % e.timeout
        if isinstance(e, McpProtocolError):
            return McpService._protocol_error_text(e)
        return 'MCP 连接失败: %s' % e

    # ============ 审计 ============
    def _audit(self, server, tool, arguments, action, decision=None,
               tier='', source='', op='mcp_call'):
        """审计 op=mcp_call（v1.6 T12 起资源操作用 op=mcp_resource，可区分）；
        detail 键 {server, tool, args, tier, tier_source}
        （禁用 path/name/head 键——避免审计查看器误渲染）。"""
        detail = {
            'server': str(server or ''),
            'tool': str(tool or ''),
            'args': self._args_summary(arguments),
            'tier': tier or '',
            'tier_source': source or '',
        }
        try:
            self._guard.audit(op, detail, action, decision)
        except Exception as e:
            self._log.warning('%s 审计写入失败: %r', op, e)

    @staticmethod
    def _args_summary(arguments) -> str:
        try:
            s = json.dumps(arguments or {}, ensure_ascii=False)
        except Exception:
            s = str(arguments)
        return s[:200]
