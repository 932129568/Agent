
/* ================= v1.8.0 C 域：人工接管等待态（联调规范 §2.4） =================
 * executeToolRaw 检出 CAPTCHA_REQUIRED → fail-fast 返回带 suspended:true 的
 * 结果串；本模块识别后：工具条目转 warn「等待人工验证」+ 弹出 63-search-panel
 * 接管 UI（既有函数），挂起本工具轮次（不往上下文塞错误、不换路），直到
 * browser_takeover 终态（成功载荷 / CAPTCHA_ABORTED）由 63-search-panel 经
 * harborTakeoverNotify 唤起，才把终态作为该工具轮次的结果注入上下文——
 * Agent 循环永不挂死在人类动作上。
 * last-wins：新挂起到来时旧等待以「已被取代」终态解放（防悬挂泄漏）；
 * 用户「停止」：轮询 shouldAbort 以放弃终态解放（不等人类动作）。 */
let harborTakeoverWaitResolve = null;
let harborTakeoverStopPoll = null;
function harborTakeoverNotify(payload) {
  if (harborTakeoverStopPoll && typeof clearInterval !== 'undefined') {
    clearInterval(harborTakeoverStopPoll);
  }
  harborTakeoverStopPoll = null;
  if (harborTakeoverWaitResolve) {
    const resolve = harborTakeoverWaitResolve;
    harborTakeoverWaitResolve = null;
    try { resolve(payload); } catch (e) {}
  }
}
function harborTakeoverAwaitTerminal(shouldAbort) {
  return new Promise((resolve) => {
    harborTakeoverWaitResolve = resolve;
    if (typeof shouldAbort !== 'function') return;
    if (typeof setInterval === 'undefined') return;
    harborTakeoverStopPoll = setInterval(() => {
      let abort = false;
      try { abort = !!shouldAbort(); } catch (e) { abort = false; }
      if (abort) {
        harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
          message: '用户已停止，人工验证取消' } });
      }
    }, 500);
  });
}
let __agentRunSeq = 0;
/* P0-3：并行 run 注册表与状态访问器（Map<sessionId, run>——run.id 为唯一写者，
 * 每 run 只写自己 session 的 runStatus 字段（R8 竞态防线）。 */
const __agentRuns = new Map();

/** 当前兼容视窗 run 的 sessionId（无 run 返回 null——UI 调用不带 header）。 */
function getActiveRunSid() {
  return __agentActiveRun && !__agentActiveRun.cancelled ? __agentActiveRun.sessionId : null;
}

/** 全部在途 run 的快照（多任务面板数据源——前端本地运行时态，无新增 js_api）。 */
function getActiveRuns() {
  return [...__agentRuns.values()].filter(r => !r.cancelled).map(r => ({
    sessionId: r.sessionId, title: r.session.title || '', status: r.status,
    kind: r.kind || 'chat',
    parallel: !!r.parallel, currentTool: r.currentTool || '', startedAt: r.startedAt,
  }));
}

/** R31：指定会话是否有在途 run（不传参 = 当前可见会话）。
 *  并行会话互不干扰的判定入口——替代对全局 isStreaming 的跨会话误用：
 *  A 会话生成中不应阻断 B 会话的发送/搜索/压缩/切面板。 */
function isSessionStreaming(sessionId) {
  const sid = (sessionId !== undefined && sessionId !== null)
    ? sessionId
    : ((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId);
  if (!sid) return false;
  const run = __agentRuns.get(sid);
  return !!run && !run.cancelled;
}

/** R31：按「当前可见会话是否仍有在途 run」重算全局流式标志。
 *  多会话并行时唯一的正确写入口——后台会话结束不得清掉可见会话的流式态，
 *  反之亦然。返回重算后的布尔值。 */
function refreshStreamingFlag() {
  const on = isSessionStreaming();
  if (typeof AppState !== 'undefined') AppState.isStreaming = on;
  else isStreaming = on;
  return on;
}

/** 多任务面板「停止」按钮：仅取消指定会话的 run，不影响其他会话在途 run。 */
function harborStopRun(sessionId) {
  const run = __agentRuns.get(sessionId);
  if (!run || run.cancelled) return;
  run.cancelled = true;
  try { if (run.abortController) run.abortController.abort(); } catch (e) {}
  // R31：群聊 run 走群自己的暂停通道（否则停不掉接力循环）
  if (run.kind === 'group' && typeof groupToggleRelay === 'function') {
    try { groupToggleRelay(sessionId); } catch (e) {}
  }
}

let __agentActiveRun = null;

/* ================= R59：UI 缝（事件环的最小依赖化） =================
 * Agent 循环的渲染/续跑调用构成固有事环（run↔controller↔send）——依赖图层面
 * 拆环：晚加载模块把 owned 函数注册进本缝，早加载模块经 uiSeamCall 单向调用。
 * 方向：所有模块 → 本叶模块（星型单向）；globalThis[name] 兜底保 vm 桩兼容。 */
const UISeam = Object.create(null);
function registerUISeam(patch) {
  if (patch && typeof patch === 'object') Object.assign(UISeam, patch);
  return true;
}
function uiSeamCall(name) {
  const f = UISeam[name]
    || (typeof globalThis !== 'undefined' && globalThis[name])
    || null;
  if (typeof f !== 'function') return undefined;
  return f.apply(null, Array.prototype.slice.call(arguments, 1));
}
