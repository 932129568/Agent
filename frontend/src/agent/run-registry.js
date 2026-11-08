/* ================= 多 run 并行所有权（R31） =================
 * R31 起：全局默认「不限数量的会话并行」——群聊与单聊、单聊与单聊、多个群聊
 * 之间均不设数量/类型组合上限，无开关、无配置项、不依赖用户操作。
 *
 * 存储：Map<sessionId, run>（同一会话至多一个在途 run，防同会话重入导致消息
 * 交错/计费翻倍；跨会话互不取消、互不影响）。
 * 存储解析：生产环境用 run-controller-base.js 的 `__agentRuns`；单模块 harness
 * 未装载 base 时回落到本模块自有的 Map —— 保证「按会话并行」在任何装载顺序下成立。
 *
 * 设计约束（不可回退）：
 *   1. start() **不得**取消其他会话的 run —— 这是 R31 之前并发上限=1 的根因；
 *   2. current() 按「当前可见会话」返回，且该会话无 run 时返回 null（不回落他方）；
 *   3. cancel() 只作用于目标 run（默认当前可见会话），不波及他方；
 *   4. 不引入队列/信号量/上限常量。
 */
function _runStore() {
  if (typeof __agentRuns !== 'undefined' && __agentRuns &&
      typeof __agentRuns.get === 'function' && typeof __agentRuns.set === 'function') {
    return __agentRuns;
  }
  if (!globalThis.__harborRunStore) globalThis.__harborRunStore = new Map();
  return globalThis.__harborRunStore;
}

function _getLastRun() { return globalThis.__harborLastRun || null; }
function _setLastRun(run) { globalThis.__harborLastRun = run; }

function _nextRunId() {
  if (typeof __agentRunSeq !== 'undefined') return ++__agentRunSeq;
  globalThis.__harborRunSeq = (globalThis.__harborRunSeq || 0) + 1;
  return globalThis.__harborRunSeq;
}

function _getActiveRun() {
  if (typeof __agentActiveRun !== 'undefined') return __agentActiveRun;
  return globalThis.__harborActiveRun || null;
}

function _setActiveRun(run) {
  if (typeof __agentActiveRun !== 'undefined') { __agentActiveRun = run; return; }
  globalThis.__harborActiveRun = run;
}

const RunRegistry = Object.freeze({
  /** 启动一个 run。同会话已有在途 run → 取消旧的（S20 双发保护）；跨会话一律保留。 */
  start(session) {
    const store = _runStore();
    const prev = store.get(session.id);
    if (prev && !prev.cancelled) {
      prev.cancelled = true;
      if (prev.abortController) { try { prev.abortController.abort(); } catch (e) {} }
      if (prev.nudgeTimer) { clearInterval(prev.nudgeTimer); prev.nudgeTimer = null; }
      if (prev.localWaitTimer) { clearInterval(prev.localWaitTimer); prev.localWaitTimer = null; }
    }
    const run = {
      id: _nextRunId(),
      sessionId: session.id,
      session,
      cancelled: false,
      assistantMsg: null,
      abortController: null,
      nudgeTimer: null,
      localWaitTimer: null,
    };
    store.set(session.id, run);
    _setActiveRun(run);   // 最近启动（legacy 兼容）
    _setLastRun(run);     // 含已取消——供 parentRunId/世代追溯
    return run;
  },

  /** 取 run：不传参 = 当前可见会话的 run（该会话无 run 则 null，不回落他方）；传 sid = 指定会话。 */
  current(sessionId) {
    const store = _runStore();
    const sid = (sessionId !== undefined)
      ? sessionId
      : ((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId);
    if (sid) {
      const own = store.get(sid);
      return (own && !own.cancelled) ? own : null;
    }
    const active = _getActiveRun();
    return (active && !active.cancelled) ? active : null;
  },

  /** 最近一次启动的 run（可能是已取消/已完成）——世代追溯与 parentRunId 用。 */
  last() { return _getLastRun(); },

  /** 指定会话是否有在途 run。 */
  has(sessionId) {
    const r = _runStore().get(sessionId);
    return !!r && !r.cancelled;
  },

  /** 全部在途 run（多任务面板 / 历史页「进行中」计数数据源）。 */
  all() {
    return [..._runStore().values()].filter(r => !r.cancelled);
  },

  isCurrent(run) {
    // 归属判定与可见会话无关：run 在被取消/完成前始终属于其会话
    return !!run && !run.cancelled && _runStore().get(run.sessionId) === run;
  },

  /** 取消：默认当前可见会话的 run；传 run/sid 则精确取消。 */
  cancel(target) {
    let run = null;
    if (target && typeof target === 'object') run = target;
    else if (typeof target === 'string') run = _runStore().get(target) || null;
    else run = this.current();
    if (!run || run.cancelled) return null;
    run.cancelled = true;
    if (run.abortController) { try { run.abortController.abort(); } catch (e) {} }
    if (run.nudgeTimer) { clearInterval(run.nudgeTimer); run.nudgeTimer = null; }
    if (run.localWaitTimer) { clearInterval(run.localWaitTimer); run.localWaitTimer = null; }
    return run;
  },

  /** 结束并注销。返回「是否仍持有该会话的所有权」——
   *  只有仍持有者才能复位 UI/流式态；被新 run 取代的旧 run 返回 false。 */
  finish(run) {
    if (!run) return false;
    const store = _runStore();
    const owned = store.get(run.sessionId) === run;
    if (owned) store.delete(run.sessionId);
    if (_getActiveRun() === run) _setActiveRun(null);
    return owned;
  },
});
