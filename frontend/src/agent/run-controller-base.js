
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

/** 显式「并行运行」入口（Q5）：对指定会话启动 run 而不取消其他会话在途 run。 */
function getActiveRunSid() {
  return __agentActiveRun && !__agentActiveRun.cancelled ? __agentActiveRun.sessionId : null;
}

/** 全部在途 run 的快照（多任务面板数据源——前端本地运行时态，无新增 js_api）。 */
function getActiveRuns() {
  return [...__agentRuns.values()].filter(r => !r.cancelled).map(r => ({
    sessionId: r.sessionId, title: r.session.title || '', status: r.status,
    parallel: !!r.parallel, currentTool: r.currentTool || '', startedAt: r.startedAt,
  }));
}

/** P0-3（Q5）：显式「并行运行」入口（React 岛按钮调用）——对指定会话启动 run
 * 而不取消其他会话在途 run；找不到会话/密钥时静默不动作（不破坏现有 UI）。 */
function harborStopRun(sessionId) {
  const run = __agentRuns.get(sessionId);
  if (!run || run.cancelled) return;
  run.cancelled = true;
  try { if (run.abortController) run.abortController.abort(); } catch (e) {}
}

let __agentActiveRun = null;
