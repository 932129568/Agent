/**
 * P0-3 T01 请求级会话上下文（AsyncLocalStorage）与 per-sid 状态容器。
 *
 * 路由（jsapi）：POST /jsapi/<method> 的 X-Harbor-Sid 头 → als.run(ctx, invoke)。
 * 无头请求 → {sid: runtime.currentSid（请求时读全局）, explicitSid: false}
 * ——与 legacy 逐字节一致（差分零翻转的基石）。
 *
 * 单点收口纪律（R1）：服务层只允许经 ctxSid()/ctxExplicit()/ctxRoot() 读取
 * 上下文——runtime.currentSid 直读仅在 runtime.js / session-context.js 合法
 * （parallel.mjs 静态断言落地防回归）。
 *
 * per-sid 容器（trust/grant/budget/dedup/cursor/sessionCwds）：
 * - 懒创建、Map<sid, container>；LRU 上限 200（在途请求的 sid 不驱逐）；
 * - session_purge 挂接清理（purgeSid）；
 * - 易失态不持久化（trust/grant/dedup/cursor 与 Python 同为进程级）；
 *   sessionCwds 经 runtime.json 持久化（独立文件、向后兼容缺省 {}）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { runtime, setCwd } from './runtime.js'

const als = new AsyncLocalStorage()

/** 请求上下文解析（jsapi 路由调用）：header 永远优先于全局 activeSid。 */
export function resolveContext(request) {
  const header = request?.headers?.['x-harbor-sid']
  const sid = typeof header === 'string' && header.trim() ? header.trim() : null
  if (sid) return { sid, explicitSid: true }
  return { sid: runtime.currentSid, explicitSid: false }
}

const sidActivity = new Map()   // 显式 sid -> 最近使用 epoch ms（LRU 依据）
const inflight = new Map()      // sid -> 在途请求数（护活跃不驱逐）
const containers = new Map()    // 容器名 -> Map（per-sid 状态，由各服务注册）
const SID_LRU_LIMIT = 200

/** 注册一个 per-sid 状态容器（purgeSid 统一清理入口）。 */
export function registerSidContainer(name, map) {
  containers.set(name, map)
  return map
}

function evictIfNeeded() {
  while (sidActivity.size > SID_LRU_LIMIT) {
    const oldest = [...sidActivity.keys()].find(sid => !(inflight.get(sid) > 0))
    if (oldest === undefined) break   // 全部在途 → 不驱逐（R3 护活跃）
    purgeSid(oldest)
  }
}

/** 在请求上下文内执行（每个 HTTP 请求的异步链独立持有 ctx）。 */
export function runWithContext(ctx, fn) {
  if (ctx.explicitSid && ctx.sid) {
    sidActivity.delete(ctx.sid)
    sidActivity.set(ctx.sid, Date.now())
    evictIfNeeded()
    inflight.set(ctx.sid, (inflight.get(ctx.sid) || 0) + 1)
    return als.run(ctx, async () => {
      try { return await fn() } finally {
        inflight.set(ctx.sid, (inflight.get(ctx.sid) || 1) - 1)
      }
    })
  }
  return als.run(ctx, fn)
}

/** 当前请求 sid（缺省=全局 activeSid——legacy 逐字节行为）。 */
export function ctxSid() {
  const store = als.getStore()
  return store ? store.sid : runtime.currentSid
}

/** 是否为显式 header 钉住的请求（set_workspace 写 per-sid cwd 的判定依据）。 */
export function ctxExplicit() {
  const store = als.getStore()
  return store ? store.explicitSid : false
}

/** per-sid cwd 覆盖容器（session-context 持有注册，runtime.json 持久化由
 * runtime.setSessionCwd 负责）。 */
export const sessionCwds = registerSidContainer('sessionCwds', new Map())

/** 当前请求的工作区根解析序（§3.3）：
 *   sessionWs[sid]（显式绑定，per-sid 全局表）→ sessionCwds.get(sid)（仅
 *   explicit 请求的 set_workspace 覆盖）→ 全局 runtime.cwd（现状回退）。 */
export function ctxRoot() {
  const sid = ctxSid()
  const bound = sid && runtime.sessionWs[sid]
  if (bound) return bound
  if (ctxExplicit() && sid && sessionCwds.has(sid)) return sessionCwds.get(sid)
  return runtime.cwd
}

/** 清理指定 sid 的全部容器项（session_purge 挂接 + LRU 驱逐复用）。 */
export function purgeSid(sid) {
  for (const map of containers.values()) map.delete(sid)
  if (sid !== null && sid !== undefined && runtime.sessionCwds[sid]) {
    delete runtime.sessionCwds[sid]
    setCwd(runtime.cwd)   // 持久化（sessionCwds 键并入 runtime.json）
  }
  sidActivity.delete(sid)
  inflight.delete(sid)
}

/** 全局 set_current_sid 的 legacy clear-on-switch：仅清旧全局 sid 的信任项
 * （P0-1 差分相关语义零翻转——其他容器不动）。 */
export function clearTrustForSid(sid) {
  const trust = containers.get('sessionTrust')
  if (trust) trust.delete(sid)
}

/* ---------------- P0-3 T02：per-root 写互斥（§5.2 共享资源并发安全） ---------------- */
const rootLocks = new Map()   // 归一化 root -> tailPromise

/** per-root 写互斥：同 root 写操作串行（不撕裂），跨 root 并行。
 * Python「写文件串行」硬规则从进程级精化为工作区级。
 * 单操作粒度非重入锁（R5：无嵌套获取——调用方不得在同 root 锁内再取锁；
 * 锁仅包文件写工具，不含长命令）。 */
export function withRootLock(root, fn) {
  const key = path.resolve(String(root || process.cwd()))
  const previous = rootLocks.get(key) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  rootLocks.set(key, tail)
  return run.finally(() => {
    if (rootLocks.get(key) === tail) rootLocks.delete(key)
  })
}
