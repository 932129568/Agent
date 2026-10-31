/* ================= 唯一 active run 所有权 =================
 * 直接管理 run-controller 的既有绑定；成员 actor 以后只能作为子状态。 */
const RunRegistry = Object.freeze({
  start(session) {
    if (__agentActiveRun && !__agentActiveRun.cancelled) this.cancel();
    const run = {
      id: ++__agentRunSeq,
      sessionId: session.id,
      session,
      cancelled: false,
      assistantMsg: null,
      abortController: null,
      nudgeTimer: null,
      localWaitTimer: null,
    };
    __agentActiveRun = run;
    return run;
  },
  current() {
    return __agentActiveRun;
  },
  isCurrent(run) {
    // Run ownership is independent of the visible session: a background run
    // remains current until cancelled/finished, even while the user switches.
    return !!run && __agentActiveRun === run && !run.cancelled;
  },
  cancel() {
    const run = __agentActiveRun;
    if (!run) return null;
    run.cancelled = true;
    if (run.abortController) {
      try { run.abortController.abort(); } catch (e) {}
    }
    if (run.nudgeTimer) {
      clearInterval(run.nudgeTimer);
      run.nudgeTimer = null;
    }
    if (run.localWaitTimer) {
      clearInterval(run.localWaitTimer);
      run.localWaitTimer = null;
    }
    return run;
  },
  finish(run) {
    if (!run || __agentActiveRun !== run) return false;
    __agentActiveRun = null;
    return true;
  },
});
