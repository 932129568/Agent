# -*- coding: utf-8 -*-
"""MCP 稳定性与速度专项 · 预留接口层（v1.5.1 S1-S5 挂载点）。

定位（roadmap-local-llm-mcp-2026-10-17 §5）：本文件是 S1-S5 五项优化的
**接口契约与可单测内核**，签名为终态；与 HttpTransport 的接线（S1 主体）
留在 v1.5.1 迭代——接线时必须把既有安全口径逐条移植到池化路径并加对应用例：

  - S15  no-redirect（禁自动重定向，防凭证跨域泄漏）
  - ⑫   协议头强制覆盖（用户 headers 不能覆盖 MCP-Protocol-Version 等）
  - ㉒   64KB 响应上限
  - S14/W16  SSE 增量读与严格 id 匹配
  - Mcp-Session-Id 回收与 404 重连

本层已实现（可单测、可先行启用）：
  - PoolConfig 解析校验（mcp_servers.json 新可选键，Claude 兼容忽略未知键）
  - ConcurrencyLimiter（超限排队不拒绝）
  - stale_needs_relist / reconnect_backoff_delays 纯函数
  - HttpConnectionPool 最小可用内核（per host:port 空闲连接复用、空闲回收、
    错误连接不污染池、统计）——**尚未接入 HttpTransport**，接入前其行为
    由本文件单测钉住。

修复 W21（v1.6）：ConcurrencyLimiter / stale_needs_relist /
reconnect_backoff_delays 三项原「配置键入库但无生产调用方」（max_concurrency
等零效果）——现由 mcp_service 按每服务器 effective_pool_config 接线：
HTTP 并行 tools/call 走 ConcurrencyLimiter；list_changed 后 300s 未刷新
由 stale_needs_relist 触发自动重 List；404 会话重连退避序列见
reconnect_backoff_delays（mcp_client 重连路径消费）。

契约红线：stdlib only（http.client / threading / time），零第三方依赖；
mcp_servers.json 新键全部可选带默认，老配置文件零影响。
"""
import http.client
import select
import socket
import threading
import time
import urllib.parse

# ================= 类型定义（mcp_servers.json 每服务器新可选键，终态）=================

# PoolConfig shape（每服务器可选，缺省即默认值）：
#   keep_alive      bool  HTTP 连接复用（默认 True；S1 主体接线后生效）
#   max_concurrency int   并行 tools/call 上限 1-8（默认 4；超限排队不拒绝）
#   warm_on_enable  bool  启用服务器即预热 spawn（默认 True；stdio 温启 S2）
#
# callTimeout（v1.4 F2 已落地，10-300s）不在本文件重复校验。

DEFAULT_POOL_CONFIG = {'keep_alive': True, 'max_concurrency': 4, 'warm_on_enable': True}
CONCURRENCY_MIN, CONCURRENCY_MAX = 1, 8
IDLE_CONN_TTL = 60.0            # 空闲连接回收（秒；S1 规格）
STALE_RELIST_TTL = 300.0        # list_changed 后 300s 未刷新 → 自动 relist（S3）
RECONNECT_BACKOFF = (1.0, 2.0, 4.0)   # 404 会话重连退避序列（S3；上限 3 次）


def parse_pool_config(cfg):
    """解析校验每服务器池配置。返回 (record, error)；record 仅含显式合法键。"""
    if cfg is None:
        return {}, None
    if not isinstance(cfg, dict):
        return None, '连接池配置必须是对象'
    record = {}
    if 'keep_alive' in cfg and cfg.get('keep_alive') is not None:
        record['keep_alive'] = bool(cfg.get('keep_alive'))
    if cfg.get('max_concurrency') is not None and str(cfg.get('max_concurrency')).strip() != '':
        try:
            mc = int(str(cfg.get('max_concurrency')).strip())
        except (TypeError, ValueError):
            return None, 'max_concurrency 必须是 1-8 的整数'
        if mc < CONCURRENCY_MIN or mc > CONCURRENCY_MAX:
            return None, 'max_concurrency 超出范围（1-8），当前值 %d' % mc
        record['max_concurrency'] = mc
    if 'warm_on_enable' in cfg and cfg.get('warm_on_enable') is not None:
        record['warm_on_enable'] = bool(cfg.get('warm_on_enable'))
    return record, None


def effective_pool_config(cfg):
    """合并默认值（读路径：未配置键回落 DEFAULT_POOL_CONFIG）。"""
    record, error = parse_pool_config(cfg)
    if error:
        record = {}
    merged = dict(DEFAULT_POOL_CONFIG)
    merged.update(record or {})
    return merged


# ================= S5 · 并发上限（超限排队而非拒绝）=================

class ConcurrencyLimiter:
    """HTTP 服务器并行 tools/call 并发上限（stdio 单进程天然串行，另行钉住）。

    超限排队不拒绝；队列深度可通过 waiting 观测（S5：队列深度提示）。
    """

    def __init__(self, max_concurrent=DEFAULT_POOL_CONFIG['max_concurrency']):
        self._sem = threading.BoundedSemaphore(max(1, int(max_concurrent)))
        self._max = max(1, int(max_concurrent))
        self._waiting = 0
        self._lock = threading.Lock()

    def __enter__(self):
        with self._lock:
            self._waiting += 1
        self._sem.acquire()
        with self._lock:
            self._waiting -= 1
        return self

    def __exit__(self, *exc):
        self._sem.release()
        return False

    @property
    def waiting(self):
        with self._lock:
            return self._waiting

    @property
    def max_concurrent(self):
        return self._max


# ================= S3 · stale 检测与重连退避（纯函数）=================

def stale_needs_relist(last_list_at, now=None, ttl=STALE_RELIST_TTL):
    """list_changed 后超过 ttl 未刷新 → 需要自动 relist（S3）。

    last_list_at 为 None（从未列出）时视为需要。时间戳单位：秒。
    时钟基必须与调用方一致：mcp_service 的 entry['last_list_at'] 用
    time.monotonic() 打点（与空闲计时同口径，不受系统时间回拨影响），
    因此调用点须显式传 now=time.monotonic()——否则默认 now=time.time()
    与 monotonic 相差 epoch 秒数，恒判 stale（每次调用多一次 tools/list
    往返 + status 被拍成 stale）。默认 time.time() 保持既有纯函数单测
    口径（test_v15_reserved/test_v15_wire 均以 time.time() 为基准）。
    """
    if last_list_at is None:
        return True
    now = time.time() if now is None else now
    return (now - float(last_list_at)) > float(ttl)


def reconnect_backoff_delays(n=len(RECONNECT_BACKOFF), base=RECONNECT_BACKOFF[0],
                             cap=RECONNECT_BACKOFF[-1]):
    """404 会话重连退避序列：1s/2s/4s，上限次数 3（S3；防抖防风暴）。"""
    out, delay = [], float(base)
    for _ in range(max(0, int(n))):
        out.append(round(min(delay, float(cap)), 3))
        delay *= 2
    return out


# ================= S1 · HTTP 连接池（最小可用内核；尚未接入 HttpTransport）=================

def _conn_alive(conn):
    """修复 W23（v1.6）：连接探活不能只查 `sock is None`——服务端已关的连接
    sock 仍在，复用后首个请求必抛（与 S6  SSE 未排干叠加放大伪失败）。

    select + MSG_PEEK 判 EOF：可读且 peek 返回 b'' → 对端已关；无挂起数据 →
    视为存活。鸭子类型：仅对真实 socket（有 recv/fileno）做 EOF 探测，测试桩/
    包装对象（sock 为任意非 None 对象）按旧口径视为活。任何异常按「不活」处理
    （保守丢弃，调用方会新建）。
    """
    sock = getattr(conn, 'sock', None)
    if sock is None:
        return False
    if not (hasattr(sock, 'recv') and hasattr(sock, 'fileno')):
        return True
    try:
        readable, _w, _e = select.select([sock], [], [], 0)
        if not readable:
            return True
        return bool(sock.recv(1, socket.MSG_PEEK))
    except Exception:
        return False


class HttpConnectionPool:
    """per host:port 的 HTTP(S) 连接池：空闲复用 + 空闲回收 + 错误不污染池。

    接口（终态）：
      acquire(url) -> http.client.HTTPConnection（空闲优先，否则新建）
      release(conn) -> None（健康连接回池；异常连接直接关闭）
      stats() -> {created, reused, idle, closed, per_host}
      close() -> None（关停全部空闲连接）

    安全口径提醒（接线时逐条移植并加用例）：池内连接仅复用「同 host:port +
    同 scheme」；Authorization/用户 headers 由请求级设置，不缓存进连接；
    no-redirect 由上层 Request 层保证，连接池不做重定向决策。
    """

    def __init__(self, keep_alive=DEFAULT_POOL_CONFIG['keep_alive'],
                 idle_ttl=IDLE_CONN_TTL, max_per_host=4):
        self._keep_alive = bool(keep_alive)
        self._idle_ttl = float(idle_ttl)
        self._max_per_host = max(1, int(max_per_host))
        self._idle = {}          # (scheme, host, port) -> [(conn, last_used_at)]
        self._lock = threading.Lock()
        self._closed = False     # 修复 W22（v1.6）：close 后 in-flight release 不得复活 idle 条目
        self._stats = {'created': 0, 'reused': 0, 'closed': 0}

    @staticmethod
    def _key(url):
        u = urllib.parse.urlsplit(url)
        scheme = (u.scheme or 'http').lower()
        port = u.port or (443 if scheme == 'https' else 80)
        return scheme, (u.hostname or ''), port

    def _new_conn(self, scheme, host, port):
        if scheme == 'https':
            return http.client.HTTPSConnection(host, port, timeout=30)
        return http.client.HTTPConnection(host, port, timeout=30)

    def _reap_locked(self, key, now):
        """回收过期空闲连接（调用方持锁）。"""
        fresh = []
        for conn, ts in self._idle.get(key, []):
            if now - ts > self._idle_ttl:
                try:
                    conn.close()
                except Exception:
                    pass
                self._stats['closed'] += 1
            else:
                fresh.append((conn, ts))
        self._idle[key] = fresh

    def acquire(self, url):
        """取一条连接：空闲优先（同 host:port），否则新建。

        取到的连接会打上 `_pool_key` 标（release 归位用；http.client 对象允许挂属性）。
        """
        key = self._key(url)
        now = time.monotonic()
        conn = None
        with self._lock:
            self._reap_locked(key, now)
            bucket = self._idle.get(key) or []
            while bucket:
                cand, _ts = bucket.pop(0)
                # 探活：修复 W23（v1.6）——半死连接（服务端已关、sock 仍在）必须
                # 识别并丢弃，否则复用后首个请求必抛（伪失败）。
                if not _conn_alive(cand):
                    try:
                        cand.close()
                    except Exception:
                        pass
                    self._stats['closed'] += 1
                    continue
                self._stats['reused'] += 1
                conn = cand
                break
        if conn is None:
            scheme, host, port = key
            conn = self._new_conn(scheme, host, port)
            with self._lock:
                self._stats['created'] += 1
        try:
            conn._pool_key = key          # 归位标（release 用）
        except Exception:
            pass
        return conn

    def release(self, conn, healthy=True):
        """归还连接：healthy 且 keep_alive 且连接仍活着（sock 非 None）才回池；
        否则关闭（错误连接/半死连接不污染池）。归位 key 取 acquire 时打标；
        无标的外来连接按 http 语义归位（测试直连场景），取不到 key 则关闭。

        修复 W22（v1.6）：pool.close 后 in-flight release 不得把条目放回 idle
        （原实现 _idle 已清空但 release 仍可 append → 复活条目永不被
        shutdown 回收 = 连接泄漏）。closed 后到达的归还一律关闭。"""
        if conn is None:
            return
        with self._lock:
            if self._closed:
                try:
                    conn.close()
                except Exception:
                    pass
                self._stats['closed'] += 1
                return
        alive = True
        try:
            alive = conn.sock is not None
        except Exception:
            alive = False
        if not self._keep_alive or not healthy or not alive:
            try:
                conn.close()
            except Exception:
                pass
            with self._lock:
                self._stats['closed'] += 1
            return
        key = getattr(conn, '_pool_key', None)
        if key is None:
            try:
                key = ('http', conn.host, conn.port)
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                with self._lock:
                    self._stats['closed'] += 1
                return
        now = time.monotonic()
        with self._lock:
            # 修复 N12（四轮）：第二个临界区内复查关闭态——原「首查（267）与 append（311）
            # 分属两个临界区」，两区之间 pool.close() 可完成，in-flight 归还复活 idle 条目
            # （socket 泄漏至 GC）。W22 只堵住了 close 之后的 release，TOCTOU 窗口仍在。
            if self._closed:
                try:
                    conn.close()
                except Exception:
                    pass
                self._stats['closed'] += 1
                return
            self._reap_locked(key, now)
            bucket = self._idle.setdefault(key, [])
            if len(bucket) >= self._max_per_host:
                try:
                    conn.close()
                except Exception:
                    pass
                self._stats['closed'] += 1
                return
            bucket.append((conn, now))

    def stats(self):
        with self._lock:
            idle = sum(len(v) for v in self._idle.values())
            return {'created': self._stats['created'], 'reused': self._stats['reused'],
                    'closed': self._stats['closed'], 'idle': idle,
                    'per_host': {('%s://%s:%s' % k): len(v) for k, v in self._idle.items() if v}}

    def close(self):
        with self._lock:
            self._closed = True     # 修复 W22（v1.6）：先置关闭态，堵住 in-flight release 复活
            for bucket in self._idle.values():
                for conn, _ts in bucket:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    self._stats['closed'] += 1
            self._idle = {}


# ================= S2 · stdio 温启（接口；spawn 编排在 mcp_transport_stdio）=================

WARM_ENTRY_IDLE_TTL = 600.0     # 温启条目空闲回收（与既有 IDLE_TIMEOUT 同口径）


class WarmRegistry:
    """[预留] 温启条目登记表：test_server 成功的 client 转 warm entry 保留。

    接口（终态）：register/unregister/get/stats；首调用延迟打点（spawn→ready）
    由 mcp_service 在接线时记录，形状 {server, warm: bool, spawn_ms}。
    """

    def __init__(self, idle_ttl=WARM_ENTRY_IDLE_TTL):
        self._entries = {}       # server -> {'client': ..., 'since': monotonic}
        self._lock = threading.Lock()
        self._idle_ttl = float(idle_ttl)

    def register(self, server, client):
        with self._lock:
            self._entries[server] = {'client': client, 'since': time.monotonic()}

    def touch(self, server):
        """修复 N2（四轮）：使用即续期——温启条目与 entry 共持同一 client，reap 只看
        since 打点（注册时一次性），持续使用中的服务器首个 TTL 后即被误杀（use-after-close
        回环实证）。_get_or_spawn 命中活 client 时调用本方法刷新 since。"""
        with self._lock:
            entry = self._entries.get(server)
            if entry is not None:
                entry['since'] = time.monotonic()

    def unregister(self, server):
        with self._lock:
            return self._entries.pop(server, None) is not None

    def pop(self, server):
        """修复 S2 接线：取出条目并返回 client（不关；调用方负责 close）。
        过期条目一并 pop 并返回 None（与 get 的过期语义一致）——注意此路径
        拿不到过期 client 本体，需要关闭过期 client 的场景用 pop_expired。"""
        with self._lock:
            entry = self._entries.pop(server, None)
            if entry is None:
                return None
            if time.monotonic() - entry['since'] > self._idle_ttl:
                return None          # 已过期：条目已摘，调用方无需再关
            return entry['client']

    def pop_expired(self, server):
        """修复 W2（本轮）：取出条目并返回 (client_or_None, expired_bool)。

        pop/get 对过期条目只摘表、不返回 client——调用方（shutdown 与
        _get_or_spawn 的 warm 路径）因此拿不到过期 client 去 close，
        stdio 子进程 / HTTP 连接直接泄漏（温启过期条目泄漏）。
        本方法把过期条目的 client 本体交还调用方处置：
          (client, True)   条目已过期（调用方应 close 后走冷启/关闭）
          (client, False)  条目新鲜（调用方可继续使用）
          (None, False)    无此条目
        """
        with self._lock:
            entry = self._entries.pop(server, None)
            if entry is None:
                return None, False
            expired = time.monotonic() - entry['since'] > self._idle_ttl
            return entry.get('client'), expired

    def get(self, server):
        with self._lock:
            entry = self._entries.get(server)
            if entry is None:
                return None
            if time.monotonic() - entry['since'] > self._idle_ttl:
                self._entries.pop(server, None)
                return None
            return entry['client']

    def reap(self):
        """回收超时空闲条目，返回 [(server, client)]——由调用方负责 close。

        修复 S8（三轮）：原 reap() 内 pop 摘除后返回 server 名，调用方再 pop() 恒为
        None → stale.close() 永不执行（「双保险防泄漏」实际反向，温启连接永不关闭）。
        现 reap 直接返回 (server, client) 对，调用方拿到的就是待关闭的 client。"""
        now = time.monotonic()
        reaped = []
        with self._lock:
            for server in list(self._entries):
                if now - self._entries[server]['since'] > self._idle_ttl:
                    entry = self._entries.pop(server, None)
                    if entry is not None:
                        reaped.append((server, entry.get('client')))
        return reaped

    def stats(self):
        with self._lock:
            return {'warm': sorted(self._entries.keys()),
                    'count': len(self._entries)}
