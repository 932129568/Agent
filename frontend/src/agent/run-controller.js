/* ================= Agent 主循环 ================= */
function setSendButtonVisual(button, state) {
  if (!button) return;
  const icon = state === 'stop' ? 'stop' : (state === 'pause' ? 'pause' : 'send');
  const label = state === 'stop' ? '停止生成' : (state === 'pause' ? '正在停止' : '发送消息');
  button.innerHTML = '<svg class="ui-icon ui-icon-20" aria-hidden="true"><use href="#i-' + icon + '"></use></svg>';
  if (button.setAttribute) button.setAttribute('aria-label', label);
}

/* 实现 v1.6 T10③：流式速度文本（tokens/s）。
 * 有 usage（completion_tokens）→ 精确值；无 usage（本地/Ollama 常见）→ 按字符
 * 估算（/1.8，与生成中 token 预估同口径）并在数字旁标「估」。
 * 纯函数（无 DOM 依赖）——vm 单模块沙箱可直接抽取测试。 */
function streamSpeedText(totalChars, elapsedMs, completionTokens) {
  const secs = (Number(elapsedMs) || 0) / 1000;
  if (secs < 0.5) return '';
  if (completionTokens && completionTokens > 0) {
    return '⚡ ' + (completionTokens / secs).toFixed(1) + ' tok/s';
  }
  const est = Math.ceil((Number(totalChars) || 0) / 1.8);
  return '⚡ ' + (est / secs).toFixed(1) + ' tok/s（估）';
}

/* 修复 S3（三轮）：暂停/中止后把悬挂 tool_calls 配平——assistant.tool_calls 与 tool
 * 消息必须一一对应，否则会话被毒化、后续每轮 HTTP 400。暂停 break（工具批未跑完）
 * 与 AbortError 两条路径共用本函数（原只在 AbortError 分支内联处理）。
 * 修复 fe-H1（四轮）：原只检查「末条消息是否为带 tool_calls 的 assistant」——暂停的
 * 主场景（部分批次已执行、末条是 tool 结果）守卫不成立、配平 no-op，会话仍被毒化。
 * 改为回溯找最后一条 assistant 消息（无论其后有多少 tool 结果）再对 done 集配平。 */
function fillMissingToolResults(s, assistantMsg) {
  if (assistantMsg) {
    // 取消的旧 run 只能配平自己已落库的 assistant；即使同一会话已有新 run，
    // 也不能把旧 tool 结果追加到新 assistant 后面或误用新 run 的 tool_call_id。
    const assistantIndex = s.messages.indexOf(assistantMsg);
    if (assistantIndex < 0 || !assistantMsg.tool_calls || !assistantMsg.tool_calls.length) return;
    const done = new Set();
    let insertAt = assistantIndex + 1;
    while (insertAt < s.messages.length && s.messages[insertAt] &&
           s.messages[insertAt].role === 'tool') {
      done.add(s.messages[insertAt].tool_call_id);
      insertAt++;
    }
    assistantMsg.tool_calls.forEach(t => {
      if (!done.has(t.id)) {
        s.messages.splice(insertAt++, 0,
          { role: 'tool', tool_call_id: t.id, content: '（用户已停止，未执行）' });
      }
    });
    return;
  }
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (!m.tool_calls || !m.tool_calls.length) return;   // 最近一条 assistant 无工具调用 → 无悬挂
    const done = new Set(s.messages.filter(x => x && x.role === 'tool').map(x => x.tool_call_id));
    m.tool_calls.forEach(t => {
      if (!done.has(t.id)) s.messages.push({ role: 'tool', tool_call_id: t.id, content: '（用户已停止，未执行）' });
    });
    return;
  }
}

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
async function harborMaybeAwaitTakeover(result, toolDiv, label) {
  let d = null;
  try { d = JSON.parse(result); } catch (e) { return result; }
  if (!d || !d.suspended || !d.error || d.error.code !== 'CAPTCHA_REQUIRED') return result;
  // 挂起：接管 UI + 条目 warn（ux-flows 流程 2⑤：不塞错误、不换路）
  try { if (typeof searchPanelOpen === 'function') searchPanelOpen(); } catch (e) {}
  try { if (typeof searchPanelShowTakeover === 'function') searchPanelShowTakeover(d.error); } catch (e) {}
  if (toolDiv) {
    toolDiv.classList.remove('done', 'fail');
    toolDiv.classList.add('warn');
    toolDiv.innerHTML = '<span class="tc-dot"></span><span>' +
      escapeHtml(label + ' · 等待人工验证') + '</span>';
  }
  try { if (typeof toast === 'function') toast('搜索引擎要求人机验证：请在面板中手动完成后点击「继续」', 'warn'); } catch (e) {}
  if (harborTakeoverWaitResolve) {
    // last-wins：旧等待以「已被取代」终态解放
    harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
      message: '已被新的验证请求取代' } });
  }
  const terminal = await harborTakeoverAwaitTerminal(() => userStopped || !agentRunCurrent(run));
  return JSON.stringify(terminal || { ok: false,
    error: { code: 'CAPTCHA_ABORTED', message: '人工验证未完成' } });
}

/* v1.8.0 M3：计划收尾摘要 + 回滚入口。
 * 仅「正常跑完」（AI 回复不带工具调用 = 任务自然终结）才收尾；熔断（循环/stall/
 * 预算硬停）、用户暂停、length 截断续跑（setTimeout 已安排续跑）全部不收尾——
 * 那些路径已由 showPausePanel / 续跑窗口接管决策，此时标记「全部完成」会把
 * 未完成的计划谎报为完成（planFinish 会按真实终态落库，错误收尾也会让
 * 回滚入口语义失真）。
 * 修复（对抗复审）：原以 try 块级 finished 为条件——熔断/预算/截断路径均置
 * finished=true 后 break，收尾块全部误触发（反例：registerToolSig 命中 →
 * finished=true → 计划被标「✓ N 步全部完成」）。finished 语义是「循环以确定
 * 性原因终止（非 60 轮上限）」，与「正常跑完」不是一回事，故分离 naturalDone。
 * 抽为模块级函数：vm 沙箱可单测（原内联在 runAgentLoop 的 try 内不可抽取）。 */
function planFinishIfNatural(userStopped, naturalDone) {
  if (userStopped || !naturalDone) return;
  if (typeof planCurrent === 'undefined' || !planCurrent || planCurrent.status !== 'running') return;
  try {
    const steps = planCurrent.steps || [];
    const count = status => steps.filter(x => (x.status || 'pending') === status).length;
    const unresolved = steps.map((x, i) => ({ step: x, index: i, status: x.status || 'pending' }))
      .filter(x => x.status === 'pending' || x.status === 'doing' || x.status === 'blocked');
    const labels = { pending: '待处理', doing: '执行中', blocked: '受阻' };
    let summary = '模型已结束，未执行自动验收 · 已完成 ' + count('done') + '/' + steps.length +
      ' 步 · 待处理 ' + count('pending') + ' · 执行中 ' + count('doing') +
      ' · 受阻 ' + count('blocked') + ' · 跳过 ' + count('skipped');
    if (unresolved.length) {
      summary += '；未决：' + unresolved.map(x =>
        (x.index + 1) + '. [' + labels[x.status] + '] ' + (x.step.text || '未命名步骤')).join('；');
    }
    // 模型停止不代表步骤已执行或验收通过：保留 pending/doing/blocked 原状态；
    // 只有无 pending/doing/blocked 未决步骤才写 done，否则终态 blocked。
    if (typeof planFinish === 'function') {
      planFinish(summary, unresolved.length ? 'blocked' : 'done');
    }
  } catch (e) {}
}

/* 请求所有权：每次生成都有独立 run；切换/新建会话只撤销所有权，
 * 不强行杀死底层 RPC。旧 run 之后不得再写会话、全局状态或新 run 的 UI。 */
let __agentRunSeq = 0;
/* P0-3：并行 run 注册表与状态访问器（Map<sessionId, run>——run.id 为唯一写者，
 * 每 run 只写自己 session 的 runStatus 字段（R8 竞态防线）。 */
const __agentRuns = new Map();

/** 显式「并行运行」入口（Q5）：对指定会话启动 run 而不取消其他会话在途 run。 */
async function runAgentLoopParallel(s, apiKey) {
  return runAgentLoop(s, apiKey, { parallel: true });
}

/** 当前视窗 run 的 sessionId（单活跃兼容；无 run 返回 null——UI 调用不带 header）。 */
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

/** 全部在途 run 的快照（多任务面板数据源——前端本地运行时态，无新增 js_api）。 */
function getActiveRuns() {
  return [...__agentRuns.values()].filter(r => !r.cancelled).map(r => ({
    sessionId: r.sessionId, title: r.session.title || '', status: r.status,
    parallel: !!r.parallel, currentTool: r.currentTool || '', startedAt: r.startedAt,
  }));
}

/** P0-3（Q5）：显式「并行运行」入口（React 岛按钮调用）——对指定会话启动 run
 * 而不取消其他会话在途 run；找不到会话/密钥时静默不动作（不破坏现有 UI）。 */
async function harborStartParallelRun(sessionId) {
  try {
    const s = (typeof getSession === 'function' ? getSession(sessionId) : null)
      || (typeof sessions !== 'undefined' && Array.isArray(sessions)
        ? sessions.find(item => item.id === sessionId) : null);
    if (!s) return null;
    const key = typeof apiKey !== 'undefined' ? apiKey : '';
    return await runAgentLoopParallel(s, key);
  } catch (e) { return null; }
}

/** 多任务面板的停止按钮：仅取消指定会话的 run（不影响其他并行实例）。 */
function harborStopRun(sessionId) {
  const run = __agentRuns.get(sessionId);
  if (!run || run.cancelled) return;
  run.cancelled = true;
  try { if (run.abortController) run.abortController.abort(); } catch (e) {}
}

let __agentActiveRun = null;
function agentRunCurrent(run) {
  if (typeof RunRegistry !== 'undefined') return RunRegistry.isCurrent(run);
  // P0-3：按会话注册表判定活跃（并行 run 各自独立——不再全局唯一活跃指针）；
  // __agentActiveRun 回退兼容 legacy 手动单活跃使用（旧测试/旧调用路径不破坏）
  return !!run && !run.cancelled && (__agentRuns.get(run.sessionId) === run || __agentActiveRun === run);
}
/** Visible-run guard: background runs may write their own history/status,
 *  but must never touch the currently visible chat DOM or stream controls. */
function agentRunVisible(run) {
  const activeId = (typeof AppState !== 'undefined')
    ? AppState.currentSessionId : currentSessionId;
  return !!run && agentRunCurrent(run) && !run.background &&
    activeId === run.sessionId;
}
function runAddMessage(run, role, content, extra) {
  if (agentRunVisible(run)) return addMessage(role, content, extra);
  // Detached shadow bubble for a background run. It is never attached to
  // #chatContainer, so tool/stream DOM updates stay in the run's own sandbox.
  const message = document.createElement('div');
  message.className = 'message ' + role;
  const contentEl = document.createElement('div');
  contentEl.className = 'content' + (role === 'error' ? ' error' : '');
  contentEl.innerHTML = (role === 'assistant' && typeof content === 'string')
    ? renderMd(content) : escapeHtml(content || '');
  message.appendChild(contentEl);
  return contentEl;
}
function syncAgentRunUiForSession(targetSessionId) {
  const run = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : __agentActiveRun;
  const activeId = (targetSessionId !== undefined) ? targetSessionId
    : ((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId);
  const visible = !!run && !run.cancelled && activeId === run.sessionId;
  if (run && !run.cancelled) run.background = !visible;
  const bar = document.getElementById('streamBar');
  if (bar) bar.classList.toggle('on', visible);
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  if (visible && run) {
    setSendButtonVisual(btn, 'stop');
    btn.style.background = 'var(--err)';
    btn.onclick = run.stopHandler || sendMessage;
  } else {
    setSendButtonVisual(btn, 'send');
    btn.style.background = '';
    btn.onclick = sendMessage;
  }
}
function cancelActiveAgentLoop() {
  const run = (typeof RunRegistry !== 'undefined') ? RunRegistry.current() : __agentActiveRun;
  if (!run) {
    if (abortController) { try { abortController.abort(); } catch (e) {} }
    return;
  }
  const wasVisible = agentRunVisible(run);
  if (typeof RunRegistry !== 'undefined') RunRegistry.cancel();
  else {
    run.cancelled = true;
    if (run.abortController) { try { run.abortController.abort(); } catch (e) {} }
    if (run.nudgeTimer) { clearInterval(run.nudgeTimer); run.nudgeTimer = null; }
    if (run.localWaitTimer) { clearInterval(run.localWaitTimer); run.localWaitTimer = null; }
  }
  if (typeof setSessionRunStatus === 'function') setSessionRunStatus(run.session, 'paused');
  run.statusFinalized = true;
  if (__agentActiveRun === run && wasVisible) {
    if (typeof AppState !== 'undefined') AppState.isStreaming = false;
    else isStreaming = false;
    const bar = document.getElementById('streamBar');
    if (bar) bar.classList.remove('on');
    const btn = document.getElementById('sendBtn');
    if (btn) { setSendButtonVisual(btn, 'send'); btn.style.background = ''; btn.onclick = sendMessage; }
  }
}
async function runAgentLoop(s, apiKey, opts) {
  let parallel = !!(opts && opts.parallel);
  // 主理人追加裁定（2026-11-01）：跨会话发送默认并行——存在其他会话的在途 run
  // 时，本调用自动升级为并行 run（不再取消他方）；同会话重入仍走单活跃取消
  // 语义（S20 双发保护不变）。「并行」按钮保留为显式入口。
  if (__agentActiveRun && !__agentActiveRun.cancelled
      && __agentActiveRun.sessionId !== s.id) {
    parallel = true;
  }
  if (__agentActiveRun && !parallel) cancelActiveAgentLoop();
  const run = (typeof RunRegistry !== 'undefined') ? RunRegistry.start(s) : {
    id: ++__agentRunSeq, sessionId: s.id, session: s, cancelled: false,
    assistantMsg: null, abortController: null, nudgeTimer: null, localWaitTimer: null };
  run.parallel = parallel;
  if (typeof RunRegistry === 'undefined') __agentActiveRun = run;
  __agentRuns.set(s.id, run);
  const _visibleAtStart = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
  run.background = _visibleAtStart !== s.id;
  run.statusFinalized = false;
  run.naturalDone = false;
  if (typeof setSessionRunStatus === 'function') setSessionRunStatus(s, 'working');
  if (typeof AppState !== 'undefined') AppState.isStreaming = true;
  else isStreaming = true;   // S20：在任何 await 前同步置位
  // 修复（2026-10-18）：暂停标志。原 abortController.abort() 只中止 fetch 流，
  // 工具执行阶段（同步 RPC）不受影响 → 用户点暂停后工具批次/后续轮次照跑。
  // 现在：点暂停立即置位 + 两处循环检查点（主循环轮次 / 工具批）→ 当前批次跑完即停。
  let userStopped = false;
  let aiContent = null;   // 修复 ㉗：前置代码移入 try，catch 需要访问 → 提升声明
  let partialContent = '';   // 修复 W21（二轮）：流中部分正文的函数级镜像——abort 时固化入历史（UI 与持久化不分叉）
  let _localWaitTimer = null;   // 修复 B3（v1.5）：本地首字节等待态计时器（函数级声明，异常路径也要清理）
  let _nudgeTimer = null;       // 复核批：流式逼帧兜底计时器（见 finally 清理）
  try {   // 修复 ㉗：原前 27 行在 try 外，任一 throw 变 unhandled rejection 且 isStreaming 卡死
    try { await callApi('set_current_sid', [s.id]); } catch (e) {}
    try { await callApi('begin_task', []); } catch (e) {}   // 修复 W2（三轮）：任务开始重置后端命令去重器（前端 deduper 为 per-task，两层生命周期对齐；旧 exe 无此方法静默跳过）
    try { await maybeAutoCompact(s); } catch (e) { console.warn(e); }  // 修复 ㊸：传会话对象（原传合成 {messages}）；压缩失败不中断主流程
    abortController = new AbortController();
    run.abortController = abortController;
    resetCostDefense();   // v1.2 R4：每次任务重置循环/无进展计数
    const sendBtn = document.getElementById('sendBtn');
    run.stopHandler = () => {
      // 修复（2026-10-18）：点暂停立即置位 + 立即视觉反馈（原只 abort fetch，
      // 工具执行阶段点下去像没反应——用户实测「点暂停时没有马上暂停」）
      userStopped = true;
      if (typeof setSessionRunStatus === 'function') setSessionRunStatus(s, 'paused');
      run.statusFinalized = true;
      try { abortController.abort(); } catch (e) {}
      if (agentRunVisible(run)) setSendButtonVisual(sendBtn, 'pause');
      try { if (agentRunVisible(run) && typeof toast === 'function') toast('正在停止…（当前工具执行完即停）', 'warn'); } catch (e) {}
    };
    if (agentRunVisible(run)) {
      setSendButtonVisual(sendBtn, 'stop');
      sendBtn.style.background = 'var(--err)';   // 令牌化（原硬编码 #ff4d4f 违反令牌铁律；走 .send-btn 既有 transition 即得三态平滑形变）
      sendBtn.onclick = run.stopHandler;
      const bar0 = document.getElementById('streamBar');
      if (bar0) bar0.classList.add('on');
    }
    // 复核批：流式渲染逼帧兜底——WebView2 后台化残余时整窗不重绘，流式期间
    // 每 800ms 请后端对宿主窗口做一次原生 RedrawWindow（强制合成器 present）。
    // visibilityState 原样透传（后端首次记录 harbor.log 作诊断证据）。
    try {
      _nudgeTimer = setInterval(() => {
        if (agentRunVisible(run)) {
          callApi('ui_nudge', [document.visibilityState || 'visible']).catch(() => {});
        }
      }, 800);
      run.nudgeTimer = _nudgeTimer;
    } catch (e) {}
    if (agentRunVisible(run)) {
      const _sp0 = document.getElementById('streamSpeed');
      if (_sp0) _sp0.textContent = '';   // 实现 v1.6 T10③：每轮开始清空上轮速度
    }
    if (!agentRunCurrent(run)) return;
    aiContent = runAddMessage(run, 'assistant', '');
    aiContent.innerHTML = '<div class="md-body"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
    const mdBody = aiContent.querySelector('.md-body');
    const taskFacts = [];
    let memFlushed = 0;   // 修复 W27：记忆只追加增量（原每轮全量 append_memory，二次方膨胀挤占 prompt）
    // 工具精准路由：按问题域筛选，不全量下发
    const lastUser = [...s.messages].reverse().find(m => m.role === 'user');
    const routeText = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content
      : Array.isArray(lastUser.content) ? lastUser.content.map(p => p.text || '').join(' ') : '') : '';
    // 修复 TOK-4（v1.4）：路由输入增强——回溯「最近 2 轮已调用工具名」与
    // 「最近一条工具结果前 200 字符」，防多步任务漏路由（首条消息没提但后续要用的工具域）
    const recentToolNames = [];
    let rounds = 0;
    for (let i = s.messages.length - 1; i >= 0 && rounds < 2; i--) {
      const m = s.messages[i];
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        rounds++;
        m.tool_calls.forEach(tc => {
          const nm = tc.function ? tc.function.name : tc.name;
          if (nm && !recentToolNames.includes(nm)) recentToolNames.push(nm);
        });
      }
    }
    let recentToolResult = '';
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i];
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.trim()) { recentToolResult = m.content; break; }
    }
    const routedSet = routeTools(routeText, /附件/.test(routeText), recentToolNames, recentToolResult);
    const taskUsed = new Set();
    if (routedSet.size <= ROUTE_ALWAYS.length) {          // "继续/然后呢"类短指令：回溯会话近期用过的工具
      for (let i = s.messages.length - 1; i >= Math.max(0, s.messages.length - 40); i--)
        (s.messages[i].tool_calls || []).forEach(tc => taskUsed.add(tc.function ? tc.function.name : tc.name));
    }
    {   // 修复 ㉗：以下为原 try 块主体（保持缩进层级一致）
    const sysPrompt = document.getElementById('systemPrompt').value.trim();
    const enableSearch = document.getElementById('enableSearch').checked;
    // schema 唯一数据源：后端 build_tools（v1.0.0 前端硬编码 TOOLS 与后端双源且已漂移，
    // 缺 clipboard/process/memory 工具；后端失败时 v1.0.0 静默降级导致 AI 悄悄丢能力）。
    // 现在失败即显式报错，不再静默降级。
    const loadBackendTools = async (mode) => {
      const role = mode === 'readonly' ? 'ro' : (mode === 'off' ? 'chat' : 'full');
      // v1.8.0 C 域：Agent 工具族（browser_*/software_*）经 build_tools
      // include_agent 下发；R11 裁决——GLM 端点只出现前端追加的内置
      // web_search（两个搜索工具永不并存），非 GLM 才出现 browser_*。
      // 功能分级开关：关则对应工具族从工具面移除（L0-3 口径）。
      const featSearch = (typeof spFeatureEnabled === 'function') ? spFeatureEnabled() : true;
      const featSoftware = (typeof swFeatureEnabled === 'function') ? swFeatureEnabled() : true;
      const includeAgent = mode === 'full' && (featSearch || featSoftware);
      // v1.3 R4：full 档才带 MCP 工具（Q3 裁决：MCP 仅进 full 角色）
      const beTools = await callApi('build_tools',
        [role, mode === 'full', includeAgent, isGlmEndpoint()]);
      const parsed = beTools ? JSON.parse(beTools) : null;
      if (!Array.isArray(parsed)) throw new Error('build_tools 返回异常');
      let tools = parsed.slice();
      if (!featSearch) tools = tools.filter(t => !t.function || !/^browser_/.test(t.function.name));
      if (!featSoftware) tools = tools.filter(t => !t.function || !/^software_/.test(t.function.name));
      if (enableSearch && isGlmEndpoint()) tools.push({ type: 'web_search',   // v1.2 R6：web_search 为 GLM 专属能力
        web_search: { enable: true, search_engine: document.getElementById('searchEngine').value, search_result: false } });
      return tools;
    };
    const executeRunTool = async (name, args) => {
      if (!agentRunCurrent(run)) {
        return JSON.stringify({ info: '任务已停止或会话已切换，工具结果已丢弃', skipped: true });
      }
      // P0-3：HTTP 路径由 X-Harbor-Sid 头承载 sid（executeTool 透传 s.id），
      // 不再每 call 写全局 set_current_sid；pywebview 路径保持现状
      if (!(window.pywebview && window.pywebview.api) && harborHttpAvailable()) {
        // HTTP 桥：sid 由 executeTool 的 run 级参数注入（消竞态源）
      } else {
        try { await callApi('set_current_sid', [s.id]); } catch (e) {}
      }
      if (!agentRunCurrent(run)) {
        return JSON.stringify({ info: '任务已停止或会话已切换，工具结果已丢弃', skipped: true });
      }
      return executeTool(name, args, s.id);
    };
    let toolMode = document.getElementById('toolMode').value;
    let effectiveTools;
    try {
      effectiveTools = await loadBackendTools(toolMode);
    } catch (e) {
      runAddMessage(run, 'assistant', '⚠️ 无法从后端加载工具定义（build_tools 失败）：' + e.message +
        '\nAI 将不具备任何工具能力。请确认运行的是桌面端 Harbor 并重新打包后重试。');
      aiContent.closest('.message').remove();   // 修复 ㉙：提前 return 前清掉遗留的「正在输入」动画气泡
      return;
    }
    // 路由过滤：只下发当前任务域的工具，省 token
    if (toolMode === 'full' && routedSet.size) {
      const allowed = new Set([...routedSet, ...taskUsed]);
      // v1.3 R4：mcp__ 工具 bypass 路由裁剪（用户显式启用的外部工具不参与域路由）
      // v1.8.0 C 域：browser_*/software_* 同样 bypass（Agent 工具族由功能分级
      // 开关管控，不参与关键词域路由——「搜索/调软件」类意图关键词覆盖不全）
      effectiveTools = effectiveTools.filter(t => !t.function || allowed.has(t.function.name) || t.function.name.startsWith('mcp__') || /^(browser_|software_)/.test(t.function.name));
    }
    // 智能档：按任务复杂度自动选模型与推理力度（思考 token 按输出计价，轻任务应关思考）
    const _route = resolveModelEffort(routeText, routedSet.size > ROUTE_ALWAYS.length);
    // 修复（2026-10-17）：本地模式必须用 localState.model——此前本地分支落到
    // providerState.model || _route.model，回落到智能档的 GLM 模型名（glm-5.3-flash），
    // 打到 Ollama 即 404 model not found。
    const currentModel = localModeActive() ? (localState.model || _route.model)
      : (isGlmEndpoint() ? _route.model
        : (providerState.model || _route.model));          // v1.2 R6：自定义端点固定用配置的模型名
    if (agentRunVisible(run)) {
      if (_route.auto && isGlmEndpoint()) addSysTip(`智能档：${_route.tier} · ${_route.model} / 思考 ${_route.effort}`);
      else if (!isGlmEndpoint()) addSysTip(currentEndpointName() + ' / ' + currentModel);
    }

    let finished = false;
    let naturalDone = false;   // 仅「AI 回复无工具调用」正常终结置位（熔断/暂停/截断续跑/60轮上限均保持 false）——计划收尾的专用判据
    const readFileSet = new Set(s._readKeys || []);   // 会话级持久化已读记录
    const listDirsSet = new Set();
    const cmdDeduper = (() => {
      // 修复 W4（三轮）：WRITE 动词表与后端 RunDeduper.WRITE_VERBS 全量对齐
      // （原缺 erase/ri/ni/md/mv 系/cp/regedit/regsvr32/rm 系等 11 个动词，口径分叉）
      const WRITE_VERBS = new Set(['del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mkdir', 'md',
        'new-item', 'ni', 'move', 'move-item', 'copy', 'copy-item', 'cp',
        'reg', 'regedit', 'regsvr32', 'setx', 'format', 'taskkill',
        'stop-process', 'start-process', 'iex', 'invoke-expression', 'rm', 'rm-item']);
      let last = null; const recent = new Map(); const MAX = 64;
      // 修复 W3（三轮）：写命令判定改 token 级匹配（原子串 `includes` 把
      // `type third.txt`（含 rd）、`chcp 65001`（含 cp）、`findstr guard`（含 rd）误报为写命令）
      const isWrite = (norm) => {
        const tokens = norm.replace(/[|&;]/g, ' ').split(' ')
          .map(t => t.replace(/^["']+|["']+$/g, '').replace(/\^/g, ''))
          .filter(t => t.length > 0);
        if (tokens.some(t => WRITE_VERBS.has(t))) return true;
        // 未闭合引号外的重定向（与后端 _unquoted_redirect 同口径）
        let q = null;
        for (const ch of norm) {
          if (q) { if (ch === q) q = null; }
          else if (ch === '"' || ch === "'") q = ch;
          else if (ch === '>') return true;
        }
        return false;
      };
      // 修复 S2（三轮）：键归一——剥 chcp/rem 前缀 + token 级剥引号与 ./ .\ 前缀，
      // `del x.txt` / `del ./x.txt` / `del "x.txt"` 归一同键；与后端 dedup_key 逐字同口径
      const normKey = (cmd) => {
        let k = String(cmd || '').trim().replace(/\s+/g, ' ').toLowerCase();
        k = k.replace(/chcp\s+65001\s*>?\s*nul\s*&?\s*/g, '').trim();
        k = k.replace(/^(?:(?:rem|rem\.*|::)\s+)+/, '').trim();
        return k;
      };
      const dedupKey = (cmd) => normKey(cmd).split(' ').map(t => {
        t = t.replace(/^["']+|["']+$/g, '');
        while (t.startsWith('./') || t.startsWith('.\\')) t = t.slice(2);
        return t;
      }).join(' ');
      return {
        check(cmd) {
          const key = dedupKey(cmd);
          if (key === last) return '与上一条完全相同的命令已拒绝重复执行;如需观察最新状态,请换角度(加参数)或先说明目的。';
          // 修复 S1（三轮）：全窗比对——原 recent 只对写命令生效，非紧邻的读命令重复
          // 全部放行（Bug A 直接根因：echo 1 → echo 2 → echo 1 第三条被放行再执行）
          if (recent.has(key)) {
            if (isWrite(normKey(cmd))) return '该写操作本次会话已执行过,已拦截以防误操作;确需重跑请修改参数或说明原因。';
            return '该命令最近已执行过,已拒绝重复执行;如需观察最新状态,请换角度(加参数)或先说明目的。';
          }
          last = key; recent.set(key, true);
          if (recent.size > MAX) recent.delete(recent.keys().next().value);
          return null;
        },
        // 修复 W1（三轮）：执行失败/被护栏拒绝的命令回滚登记（合法重试不被误拦）；
        // 与后端 RunDeduper.unmark 同口径
        unmark(cmd) {
          const key = dedupKey(cmd);
          recent.delete(key);
          if (last === key) last = null;
        }
      };
    })();
    // 修复 建议㉛（三轮）：lastToolSig 死变量（只写不读）已删除声明与赋值
    const recentSigs = [];
    const taskEffort = _route.effort;
    const taskCapOut = 16384;  // 统一输出上限，不再区分纯聊天/工具模式
    const taskTemp = parseFloat(document.getElementById('temperature').value);
    const taskTopP = parseFloat(document.getElementById('topP').value);
    // 修复 B3（v1.5）：local 模式 max_tokens 默认 4096（模板默认 16384 时覆盖；
    // 用户显式设的值尊重）——本地小窗口模型输出 token 占比要克制
    const DEFAULT_MAX_TOKENS = 16384;
    let taskMaxTok = parseInt(document.getElementById('maxTokens').value) || 4096;
    if (typeof localState !== 'undefined' && localState.mode && taskMaxTok === DEFAULT_MAX_TOKENS) taskMaxTok = 4096;
    taskMaxTok = Math.min(taskMaxTok, taskCapOut);

    let finishReason = null;
    const beforeRound = async ({ round }) => {
      if (userStopped || !agentRunCurrent(run)) return { stop: true, finished: true, status: 'cancelled' };
      // 修复 建议㉔（二轮）：finishReason 每轮复位——原跨轮次残留，上轮 length
      // 会让下轮正常结束也误触发截断续跑
      finishReason = null;
      // 动态检测 toolMode 切换，立即生效
      const curMode = document.getElementById('toolMode').value;
      if (curMode !== toolMode) {
        toolMode = curMode;
        try {
          effectiveTools = await loadBackendTools(curMode);
        } catch (e) {
          runAddMessage(run, 'assistant', '⚠️ 切换权限档后无法从后端加载工具定义：' + e.message);
          return { stop: true, finished: false, status: 'error' };
        }
        if (toolMode === 'full' && routedSet.size) {
          const allowed = new Set([...routedSet, ...taskUsed]);
          // v1.3 R4：mcp__ 工具 bypass 路由裁剪（权限档热切换后同样放行）
          // v1.8.0 C 域：browser_*/software_* 同样 bypass（同首轮过滤口径）
          effectiveTools = effectiveTools.filter(t => !t.function || allowed.has(t.function.name) || t.function.name.startsWith('mcp__') || /^(browser_|software_)/.test(t.function.name));
        }
      }
      await compactHistory(s);
      freezeBeforeCurrentTask(s);
      const slimMsgs = shrinkHistoryForApi(buildMessagesForAPI(s.messages));
      applyShrinkMarkers(s.messages);   // 修复 UX-1（v1.4）：发送副本瘦身透明化——每轮重算并打弱化标记
      let sysContent = EFFICIENCY_PROMPT + (sysPrompt ? '\n\n' + sysPrompt : '');
      let effTools = effectiveTools;
      try {
        const beSys = await callApi('build_system_prompt', []);
        // W0 R19：执行铁律改读 prompts/efficiency.md（版本化）；失败回落前端
        // 内置常量（内容与 prompts 文件逐字节一致，回落零行为差异）
        let effText = EFFICIENCY_PROMPT;
        try {
          const effRaw = await callApi('prompt_get', ['efficiency']);
          const eff = JSON.parse(effRaw || '{}');
          if (eff && eff.ok && eff.text) effText = eff.text;
        } catch (e2) { /* 回落内置 */ }
        sysContent = effText + '\n\n' + (beSys ? JSON.parse(beSys) : '') + (sysPrompt ? '\n\n用户附加: ' + sysPrompt : '');
      } catch (e) { /* 系统提示词失败用前端默认 */ }
      // 实现 v1.6 T5④：本地模式段——「上下文有限」提示（本地模型窗口小，
      // 防长程任务里模型误判可无限重读/堆叠上下文）
      if (typeof localState !== 'undefined' && localState.mode) {
        sysContent += '\n\n【本地模式】上下文窗口有限：长任务分步进行，每步先小结再继续；' +
          '已读文件与工具结果保留在上下文内，禁止反复重读确认。';
      }
      // 修复 HF-1（v1.6）：system 归一化——历史里可能有末尾追加的【工作日志】system
      // （100-send.js），直接拼 [system, ...slimMsgs] 会得到 [system, user, system]，
      // Qwen/Ollama 的 Jinja 模板直接 raise「System message must be at the beginning」→ 500。
      // 归一化把所有 system 合并成一条置于最前；只有一条 system 时原样返回（零行为变化）。
      const reqMsgs = normalizeSystemMessages([{ role: 'system', content: sysContent }, ...slimMsgs]);
      if (pendingShots.length && shotState === 'idle') {
        const shotContent = [{ type: 'text', text: pendingShots.length > 1
          ? `[系统附图] 以下是 ${pendingShots.length} 张屏幕截图(按拍摄顺序),请据此操作。`
          : '[系统附图] 以下是当前屏幕截图,请据此判断界面状态并继续操作。' }];
        for (const sh of pendingShots) shotContent.push({ type: 'image_url', image_url: { url: sh } });
        reqMsgs.push({ role: 'user', content: shotContent });
        shotState = 'sending';
      }
      const _mp = (typeof getModelPrefs === 'function') ? getModelPrefs() : null;
      const _eff = (_mp && _mp.thinking && _mp.thinking !== 'auto') ? _mp.thinking : taskEffort;
      const _localNoTools = (typeof localState !== 'undefined' && localState.mode && localState.tool_capable === 'off');
      const reqBody = buildChatRequestBody({
        model: currentModel, messages: reqMsgs,
        temperature: taskTemp, topP: taskTopP, maxTokens: taskMaxTok,
        effort: _eff, glm: isGlmEndpoint(), tools: _localNoTools ? [] : effTools,
      });
      if (_localNoTools && effTools.length > 0 && agentRunVisible(run)) {
        addSysTip('本地模型已声明不支持工具调用，本轮以纯对话模式发送');
      }
      const now = Date.now();
      const cacheCold = lastReqAt && (now - lastReqAt) > 10 * 60 * 1000;
      lastReqAt = now;
      if (cacheCold && agentRunVisible(run)) {
        const le = document.getElementById('liveTokenStat');
        if (le) le.textContent = '△ 距上次请求超 10 分钟，缓存可能过期，本轮输入按全价计 | 正在请求…';
      }
      // v1.2 R4：预算硬停检查点（每轮发起新请求前；进行中的工具调用已跑完）
      const hardStop = checkBudgetHardStop(s);
      if (hardStop) {
        if (agentRunVisible(run)) {
          showPausePanel(aiContent, s, 'budget', hardStop);
          toast('会话预算已用尽，已暂停发起新请求', 'warn');
        }
        return { stop: true, finished: true, naturalDone: false, status: 'budget' };
      }
      return { body: reqBody, model: currentModel };
    };

      const _isLocal = (typeof localState !== 'undefined' && localState.mode);
      const FIRST_TOKEN_HINT_MS = 5000, IDLE_WATCHDOG_MS = 120000;
      let _firstChunk = true, _idleWarned = false;
      const _t0 = Date.now();
      let _lastChunkAt = _t0;
      if (_isLocal) {
        _localWaitTimer = setInterval(() => {
          const now = Date.now();
          if (_firstChunk) {
            if (agentRunVisible(run)) {
              const waited = Math.round((now - _t0) / 1000);
              const le = document.getElementById('liveTokenStat');
              if (le) le.textContent = `本地推理中（已等待 ${waited}s）…`;
            }
          } else if (!_idleWarned && now - _lastChunkAt > IDLE_WATCHDOG_MS) {
            _idleWarned = true;
            if (agentRunVisible(run)) addSysTip('本地推理流已停滞 2 分钟，可继续等待或点「■」停止后重试');
          }
        }, 1000);
        run.localWaitTimer = _localWaitTimer;
      }
      const _clearWaitTimer = () => { if (_localWaitTimer) { clearInterval(_localWaitTimer); _localWaitTimer = null; } };
      let _speedT0 = 0, _speedLastPaint = 0;
      let fullContent = '', fullReasoning = '', usage = null;
      const _paintStreamSpeed = (completionTokens) => {
        if (!agentRunVisible(run)) return;
        const el = document.getElementById('streamSpeed');
        if (!el || !_speedT0) return;
        const txt = streamSpeedText(fullContent.length + fullReasoning.length,
          Date.now() - _speedT0, completionTokens);
        if (txt) el.textContent = txt;
      };
      const reasonHtml = (rr) => {
        if (!rr) return '';
        const t = String(rr);
        const flat = t.replace(/\s+/g, ' ').trim();
        const preview = flat.length > 48 ? flat.slice(0, 48) + '…' : flat;
        return '<div class="think-line" data-role="think-toggle" title="点击展开/收起思考过程">' +
            '<span class="tl-ic">◐</span><span class="tl-label">深度思考</span>' +
            '<span class="tl-preview">' + escapeHtml(preview) + '</span>' +
            '<span class="tl-caret">▸</span>' +
          '</div>' +
          '<div class="think-body" data-role="think-body">' + escapeHtml(t) + '</div>';
      };
      if (mdBody && !mdBody.__thinkBound) {
        mdBody.__thinkBound = true;
        mdBody.addEventListener('click', (e) => {
          const line = e.target.closest && e.target.closest('[data-role="think-toggle"]');
          if (!line) return;
          line.classList.toggle('open');
          const body = line.nextElementSibling;
          if (body && body.dataset.role === 'think-body') body.classList.toggle('open');
        });
      }
      const streamObserver = {
        onChunk() {
          if (_firstChunk) {
            _firstChunk = false;
            _clearWaitTimer();
            _speedT0 = Date.now();
          }
          _lastChunkAt = Date.now();
        },
        onBatch() {
          if (_speedT0 && Date.now() - _speedLastPaint > 500) {
            _speedLastPaint = Date.now();
            _paintStreamSpeed(0);
          }
        },
        onDelta(delta, current) {
          if (!agentRunCurrent(run)) return;
          fullContent = current.content;
          fullReasoning = current.reasoning;
          if (delta.reasoning_content || delta.content) {
            scheduleRender(mdBody, () => reasonHtml(fullReasoning) + renderMd(fullContent));
            if (agentRunVisible(run)) {
              const le = document.getElementById('liveTokenStat');
              const est = Math.ceil((fullContent.length + fullReasoning.length) / 1.8);
              if (le) le.textContent = `生成中… 约 ${est.toLocaleString()} tokens`;
            }
          }
          if (delta.content) partialContent = fullContent;
        },
        onFinishReason(reason) { finishReason = reason; },
        onUsage(nextUsage) {
          if (!agentRunCurrent(run)) return;
          usage = nextUsage;
          const _cached = usage.prompt_tokens_details?.cached_tokens || 0;
          const _pr = usage.prompt_tokens || 0;
          if (_pr > 0 && typeof estTokensCalibrate === 'function'
              && typeof historyTokens === 'function') {
            try { estTokensCalibrate(_pr, historyTokens(s.messages)); } catch (e) {}
          }
          if (agentRunVisible(run)) {
            window.__hitRate = _pr ? Math.round(_cached / _pr * 100) : 0;
            if (typeof navRenderHeaderStatus === 'function') navRenderHeaderStatus();
            if (_pr > 4000 && window.__hitRate < 30) {
              const _le = document.getElementById('liveTokenStat');
              if (_le) _le.textContent = `△ 缓存命中率仅 ${window.__hitRate}%（本轮输入 ${_pr} tokens 多按全价计）| 建议：避免中途改系统设定/权限档，或 /compact 后重开话题`;
            }
          }
          if (shotState === 'sending') {
            shotState = 'idle'; pendingShots = [];
            try {
              s.messages.push({ role: 'user', content: '[已向 AI 发送当前屏幕截图]' });
              if (typeof runAddMessage === 'function') runAddMessage(run, 'user', '[已向 AI 发送当前屏幕截图]');
            } catch (e) {}
          }
        },
      };

      const onAssistant = async ({ assistant: assistantMsg, parsed, toolCalls }) => {
      fullContent = parsed.content;
      fullReasoning = parsed.reasoning;
      usage = parsed.usage;
      finishReason = parsed.finishReason;
      _clearWaitTimer();
      if (shotState === 'sending') {
        shotState = 'idle'; pendingShots = [];
        try {
          s.messages.push({ role: 'user', content: '[已向 AI 发送当前屏幕截图]' });
          if (typeof runAddMessage === 'function') runAddMessage(run, 'user', '[已向 AI 发送当前屏幕截图]');
        } catch (e) {}
      }
      if (_speedT0) _paintStreamSpeed(usage ? usage.completion_tokens : 0);
      run.assistantMsg = assistantMsg;   // 每轮更新；取消收尾只处理旧 run 最后落库的 assistant
      if (usage) accumulateUsage(s, assistantMsg.usage);   // 修复 S8（二轮）：单调累计到会话计数器（归档/compact 不归零）
      // v1.8.0 H 域：混合路由成本分账（#costSplit chip 数据源；本地/云端
      // token 分别累加——65-hybrid.js hybridOnUsage，架构 §4.2 usage 事件延长）
      try { if (typeof hybridOnUsage === 'function') hybridOnUsage(usage, currentModel); } catch (e) {}
      if (aiContent && aiContent.dataset) aiContent.dataset.midx = s.messages.length - 1;   // 修复 UX-1/UX-3（v1.4）：live 气泡 stamp 下标（dataset 防御：桩/降级不抛错）

      if (toolCalls.length === 0) {
        // 终帧复用同元素待渲染记录：同步绘制最新完整文本，随后旧 rAF/定时器不再重绘。
        scheduleRender(mdBody, () => fullContent ? renderMd(fullContent) : '');
        flushRender(mdBody);
        if (usage) {
          const u = usage;
          const cached = u.prompt_tokens_details?.cached_tokens || 0;
          const div = document.createElement('div');
          div.className = 'usage-info';
          // 修复 S9 同型（二轮）：usage 字段来自 API 响应（不可信输入），转义后再拼 innerHTML
          let html = `<span>输入 <b>${escapeHtml(String(u.prompt_tokens ?? ''))}</b></span><span>输出 <b>${escapeHtml(String(u.completion_tokens ?? ''))}</b></span><span>合计 <b>${escapeHtml(String(u.total_tokens ?? ''))}</b></span>`;
          if (cached > 0) html += `<span style="color:var(--ok)">缓存命中 <b>${cached.toLocaleString()}</b>（半价）</span>`;
          if (_route.auto && isGlmEndpoint()) html += `<span style="color:var(--text-2)">智能档·${_route.tier}（${_route.model} / 思考 ${_route.effort}）</span>`;
          // v1.2 R5：本会话实时花费随每轮返回 1 秒内更新（与 token 统计同口径）
          const _sessCost = calcUsage(s.messages);
          html += `<span>本会话约花费 <b>¥${_sessCost.cost.toFixed(4)}</b></span>`;
          div.innerHTML = html;
          aiContent.appendChild(div);
          const _prevTurn = window.__turnTokens || 0;
          if (agentRunVisible(run)) window.__turnTokens = (u.total_tokens || 0);
          if (_prevTurn > 0 && u.total_tokens > _prevTurn * 1.5) {
            const tip = document.createElement('div');
            tip.className = 'usage-info'; tip.style.color = 'var(--warn)';
            tip.textContent = `△ 本轮 tokens 比上轮高 ${Math.round((u.total_tokens / _prevTurn - 1) * 100)}%，可考虑 /compact 或新开会话`;
            aiContent.appendChild(tip);
          }
        }
        if (fullContent) {
          enhanceCodeBlocks(mdBody);
          // v4：操作条收进 .msg-actions——悬停对话框时下方弹出（opacity+translateY）
          const acts = document.createElement('div');
          acts.className = 'msg-actions';
          // v4 极简：小线性图标（复用 50-markdown 的 MSG_ICONS；文字按钮退役）
          const mki = (icon, title, fn) => {
            const b = document.createElement('button');
            b.className = 'msg-ic'; b.type = 'button'; b.title = title;
            b.innerHTML = (typeof MSG_ICONS !== 'undefined') ? MSG_ICONS[icon] : '';
            b.onclick = () => fn(b);
            acts.appendChild(b); return b;
          };
          const flash = (b, cls) => { b.classList.add(cls); setTimeout(() => b.classList.remove(cls), 1500); };
          mki('copy', '复制', (b) => navigator.clipboard.writeText(fullContent)
            .then(() => flash(b, 'done'))
            // 修复 ㉔（三轮）：原无 .catch——剪贴板不可用（非安全上下文/权限）时
            // unhandled rejection，按钮停在「复制」态无任何反馈
            .catch(() => flash(b, 'fail')));
          mki('regen', '重新生成', () => regenerate());
          mki('fav', '收藏到记忆', async (b) => {
            try {
              await callApi('append_memory', [JSON.stringify({ text: fullContent.slice(0, 500) })]);
              flash(b, 'done');
            } catch (e) { flash(b, 'fail'); }
          });
          // v4 修复：操作条移到气泡外（.message 下独立行）——原来 append 进
          // .content 使按钮显示在气泡内部底部（用户反馈「按钮在气泡里很怪」）
          const aiMsg = (aiContent.closest && aiContent.closest('.message')) || null;
          if (aiMsg) aiMsg.appendChild(acts); else aiContent.appendChild(acts);
        }
        if (finishReason === 'length') {
          // 修复 建议㉔（二轮）：length 且带 tool_calls 时参数可能被截断（正则猜参
          // 只发生在极端损坏流）——显式提示，不静默
          if (toolCalls.length > 0) {
            const warn = document.createElement('div');
            warn.className = 'usage-info'; warn.style.color = 'var(--warn)';
            warn.textContent = '△ 输出在工具调用参数中途被截断，参数可能不完整；建议调高 max_tokens 或让 AI 分步执行。';
            aiContent.appendChild(warn);
          }
          const n = document.createElement('div');
          n.className = 'usage-info'; n.style.color = 'var(--warn)';
          n.textContent = '▮ 输出被截断，自动继续生成中…';
          aiContent.appendChild(n);
          s.autoResume = (s.autoResume || 0) + 1;
          if (s.autoResume <= 5) {
            finished = true;
            // 修复 S18：原直接调 continueLastGeneration 是死调用——isStreaming 尚未复位，首行守卫即 return。
            // 改 setTimeout 延续跑：finally 复位 isStreaming 之后才触发，截断输出真正自动继续。
            // 修复（建议14 残余）：350ms 硬编码改 MOTION 令牌——续跑窗口 = 组件入场时长
            // ×2（finally 同步复位 isStreaming 后的一帧缓冲；fx-off 下 comp=1ms → 窗口
            // 2ms 立即续跑，与「关特效不拖节奏」一致）。typeof 守卫保 vm 沙箱可测。
            const _resumeWin = (typeof MOTION !== 'undefined' && MOTION.comp) ? MOTION.comp() * 2 : 400;
            setTimeout(() => {
              if (currentSessionId !== s.id) return;   // 修复 S7（二轮）：350ms 窗口内切了会话 → 不续跑（防跨会话串扰）
              if (isStreaming) {                        // 修复 W20（二轮）：窗口内用户发了新消息 → 不静默丢弃，补手动按钮
                const contBtn = document.createElement('button');
                contBtn.className = 'copy-btn'; contBtn.textContent = '▸▸ 继续输出';
                contBtn.onclick = () => continueLastGeneration(s, apiKey);
                const cActs = document.createElement('div'); cActs.className = 'msg-actions';
                cActs.appendChild(contBtn); aiContent.appendChild(cActs);
                return;
              }
              s.autoResume = 0;   // 修复 建议㉗（二轮）：续跑成功后清零（原只在不续跑的 else 分支清零，自动续跑路径终身累积，第 5 次后本会话再无自动续跑）
              continueLastGeneration(s, apiKey);
            }, _resumeWin);
            return { stop: true, finished: true, naturalDone: false, status: 'length' };
          } else {
            s.autoResume = 0;
            const contBtn = document.createElement('button');
            contBtn.className = 'copy-btn'; contBtn.textContent = '▸▸ 继续输出';
            contBtn.onclick = () => continueLastGeneration(s, apiKey);
            const cActs = document.createElement('div'); cActs.className = 'msg-actions';
            cActs.appendChild(contBtn); aiContent.appendChild(cActs);
          }
        }
        finished = true;
        // length 是截断而非自然完成（即使自动续跑额度已耗尽，也不能收尾计划）。
        naturalDone = finishReason !== 'length';
        return { stop: true, finished: true, naturalDone, status: finishReason === 'length' ? 'length' : 'completed' };
      }
      scheduleRender(mdBody, () => fullContent ? renderMd(fullContent) : '');
      flushRender(mdBody);

      return { stop: false };
      };

      const executeBatch = async (toolCalls) => {
      const toolUis = toolCalls.map(tc => {
        let args = {};
        try { args = JSON.parse(tc.argsStr || '{}'); }
        catch (e) {
          const raw = String(tc.argsStr || '');
          const grabStr = (key) => {
            const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
            if (!m) return undefined;
            try { return JSON.parse('"' + m[1] + '"'); }
            catch (e2) {
              return m[1]
                .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
                .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
                .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
          };
          const grabLit = (key) => {
            const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*(true|false|-?\\d+(?:\\.\\d+)?)'));
            if (!m) return undefined;
            return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]);
          };
          args = {};
          ['path','new_path','content','cmd','old','new','file_path','filename'].forEach(k => {
            const v = grabStr(k); if (v !== undefined) args[k] = v;
          });
          ['offset','limit'].forEach(k => {
            const v = grabLit(k); if (v !== undefined) args[k] = v;
          });
          const ra = grabLit('replace_all');
          if (ra !== undefined) args.replace_all = ra;
          if (!args.path) {
            const m2 = raw.match(/"path"\s*:\s*"([^"]+)/);
            if (m2) args.path = m2[1];
          }
        }
        ['path','new_path','file_path','filename'].forEach(k => {
          if (typeof args[k] === 'string') args[k] = args[k].replace(/^"+|"+$/g, '');
        });
        if (!args.path && (args.file_path || args.filename || args.file || args.target)) {
          args.path = args.path || args.file_path || args.filename || args.file || args.target;
        }
        const label = buildToolLabel(tc.name, args);
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call-item';
        toolDiv.innerHTML = '<span class="tool-spinner"></span><span>' + escapeHtml(label) + '</span>';
        aiContent.appendChild(toolDiv);
        return { tc, args, label, toolDiv };
      });
      if (agentRunVisible(run)) {
        const cc = document.getElementById('chatContainer');
        if (cc) cc.scrollTop = cc.scrollHeight;
      }

      const WRITE_SEQ_TOOLS = ['write_file','append_file','search_replace','move_path','copy_path','delete_path'];
      const toolResults = [];
      let batchPending = toolUis.slice();
      while (batchPending.length) {
        if (userStopped || !agentRunCurrent(run)) break;   // 暂停/切会话后不再执行剩余工具批次
        const seqIdx = batchPending.findIndex(t => WRITE_SEQ_TOOLS.includes(t.tc.name));
        const batch = seqIdx >= 0 ? batchPending.slice(0, seqIdx + 1) : batchPending;
        const batchResults = await Promise.all(batch.map(async ({ tc, args, label, toolDiv }) => {
        let result;
        if (tc.name === 'read_file' && args.path && args.force !== true) {
          const fileKey = String(args.path).toLowerCase() + '@' + (args.offset || 0);
          if (readFileSet.has(fileKey)) {
            result = JSON.stringify({ info: `文件 ${args.path} 自 ${args.offset || 0} 行起本次会话已读过；原文仍在上下文中，直接引用，禁止重读。`, path: args.path, skipped: true });
          } else {
            readFileSet.add(fileKey);
            result = await executeRunTool(tc.name, args);
            if (typeof harborRenderValidation === 'function') harborRenderValidation(result, toolDiv);
          }
        } else if (tc.name === 'read_file' && args.path) {
          // force=true 放行重读
          result = await executeRunTool(tc.name, args);
        } else if (tc.name === 'list_dir') {
          const dirKey = String(args.path || '.').toLowerCase();
          if (listDirsSet.has(dirKey)) {
            result = JSON.stringify({ info: `目录 ${args.path || '.'} 本次任务已列出，请直接引用上方结果，不要重复列目录。`, path: args.path, skipped: true });
          } else {
            listDirsSet.add(dirKey);
            result = await executeRunTool(tc.name, args);
            if (typeof harborRenderValidation === 'function') harborRenderValidation(result, toolDiv);
          }
        } else if (['run_command','run_powershell','run_admin_command','open_app'].includes(tc.name)) {
          // 修复 W9（三轮）：open_app 纳入前端去重（反复弹窗面的前端闸；后端 api.open_app 同步接入）
          // 修复 ②（三轮）：去重键与 25-tool-exec 的 pickCmd 统一判空口径——空串/空白
          // cmd 回退 command（原 `args.cmd || args.command || ''` 对空白串 truthy 穿透，
          // 键与 pickCmd 实际执行值分叉）；两者皆空 → 不登记去重键（空命令由执行层
          // 拒绝返回人话 error，不占去重窗口误拦后续合法命令）
          const _dedupCmd = (args.cmd != null) ? String(args.cmd) : '';
          const cmdKey = tc.name === 'open_app'
            ? 'open_app ' + String(args.path || args.file_path || args.filename || args.file || args.target || '')
            : (_dedupCmd.trim() ? _dedupCmd : String(args.command || ''));
          const dupTip = cmdKey.trim() ? cmdDeduper.check(cmdKey) : null;
          if (dupTip) {
            result = JSON.stringify({ info: dupTip, skipped: true });
          } else {
            result = await executeRunTool(tc.name, args);
            if (typeof harborRenderValidation === 'function') harborRenderValidation(result, toolDiv);
            // 修复 W1（三轮）：执行失败/被护栏拒绝（error/skipped）回滚登记，合法重试不被误拦
            try { const d0 = JSON.parse(result); if (d0 && (d0.error || d0.skipped)) cmdDeduper.unmark(cmdKey); } catch (e) {}
            try { const d = JSON.parse(result); if (d.output) { d.output = compressCliOutput(d.output); result = JSON.stringify(d); } } catch (e) {}
          }
        } else {
          result = await executeRunTool(tc.name, args);
          // v1.8.0 C 域：CAPTCHA_REQUIRED → 挂起本工具轮次，等 browser_takeover
          // 终态注入上下文（联调规范 §2.4：fail-fast + 前端挂起）
          result = await harborMaybeAwaitTakeover(result, toolDiv, label);
          if (['write_file','append_file','search_replace','run_command','run_powershell','move_path','delete_path'].includes(tc.name)) {
            try { if (JSON.parse(result).ok) taskFacts.push(tc.name + ': ' + String(args.path || args.cmd || args.src || '').slice(0, 60)); } catch (e) {}
          }
          if (['write_file','append_file','search_replace','move_path','copy_path','delete_path'].includes(tc.name)) {
            try {
              const r = JSON.parse(result);
              if (r.ok) {
                const desc = {
                  write_file: `写入文件 ${args.path}`,
                  append_file: `追加内容到 ${args.path}`,
                  search_replace: `修改 ${args.path}`,
                  move_path: `移动 ${args.path} → ${args.new_path || args.dst}`,
                  copy_path: `复制 ${args.path} → ${args.new_path || args.dst}`,
                  delete_path: `删除 ${args.path}`
                }[tc.name] || tc.name;
                callApi('append_worklog', [desc]).catch(() => {});
              }
            } catch (e) {}
            if (['write_file','append_file','search_replace','delete_path','move_path','copy_path'].includes(tc.name)) {
              try {
                const parsed = JSON.parse(result);
                if (parsed.ok) {
                  const pks = [args.path, args.src, args.dst].filter(Boolean).map(p => String(p).toLowerCase());
                  for (const k of [...readFileSet]) {
                    if (pks.some(pk => k.startsWith(pk + '@'))) readFileSet.delete(k);
                  }
                }
              } catch (e) {}
            }
          }
        }
        const sp = toolDiv.querySelector('.tool-spinner');
        if (sp) sp.style.display = 'none';
        let tail = '';
        if (result === null) tail = '✗ 工具无返回';
        else {
          try {
            const r = JSON.parse(result);
            if (r && typeof r === 'object') {
              // 修复（2026-10-21 用户实测）：结构化错误 error 是对象
              // （{code,message}——software_service/browser 等 err() 家族）时
              // String(obj) 渲染成 "[object Object]"，用户看不到真因。统一取
              // 人话字段（message 优先，回落 code/error 串）。
              const _errText = (e) => {
                if (!e) return '';
                if (typeof e === 'string') return e;
                if (typeof e === 'object') {
                  return String(e.message || e.code || e.error || JSON.stringify(e));
                }
                return String(e);
              };
              if (r.error) tail = '✗ ' + _errText(r.error).slice(0, 80);
              else if (r.skipped) tail = '⊘ ' + _errText(r.reason || r.info || '已拦截').slice(0, 60);
            }
          } catch (e) {}
        }
        toolDiv.innerHTML = '<span class="tc-dot"></span><span>' + escapeHtml(label + tail) + '</span>';
        toolDiv.classList.add(tail.startsWith('✗') ? 'fail' : 'done');
        /* v1.8.0 M3：计划运行时 todo 推进（每个工具完成 = 推进一个 pending 步骤） */
        if (typeof planStepStatus === 'function' && typeof planCurrent !== 'undefined' &&
            planCurrent && planCurrent.status === 'running') {
          const st = planCurrent.steps || [];
          const nextIdx = st.findIndex(x => x.status === 'pending');
          if (nextIdx >= 0) {
            planStepStatus(nextIdx, tail.startsWith('✗') ? 'blocked' : 'done');
            const after = st[nextIdx + 1];
            if (after && after.status === 'pending') planStepStatus(nextIdx + 1, 'doing');
          }
        }
        try {
          const parsed = JSON.parse(result);
          if (tc.name === 'take_screenshot' && parsed.thumbnail) {
            const img = document.createElement('img');
            img.src = parsed.thumbnail;
            img.style.cssText = 'max-width:100%;max-height:200px;margin-top:6px;border-radius:6px;border:1px solid var(--border);cursor:pointer';
            img.onclick = () => window.open(parsed.thumbnail);
            toolDiv.appendChild(img);
          }
        } catch (e) {}
        /* 状态样式改由 .tool-call-item.done / .fail 类承载（原内联 background 已移除） */
        let resultForHistory = result;
        try {
          const parsed = JSON.parse(result);
          if (Array.isArray(parsed.content)) {   // 修复 ㉛：MCP 数组型 content 先 join 归一，再进入字符串截断逻辑
            parsed.content = parsed.content.map(p =>
              (p && typeof p === 'object') ? (p.text != null ? String(p.text) : JSON.stringify(p)) : String(p)).join('\n');
            resultForHistory = JSON.stringify(parsed);
          }
          if (parsed.dataUrl) {
            parsed.dataUrl = '[截图已保存到 ' + (parsed.path || '') + '，图片不再重复进上下文]';
            resultForHistory = JSON.stringify(parsed);
          }
          if (parsed.thumbnail) {
            delete parsed.thumbnail;
            resultForHistory = JSON.stringify(parsed);
          } else if (parsed.content && parsed.content.length > 240000) {
            parsed.content = parsed.content.slice(0, 240000) + '\n…(超大文件截断，可传 offset 继续读)';
            resultForHistory = JSON.stringify(parsed);
          } else if (parsed.output && parsed.output.length > 20000) {
            parsed.output = parsed.output.slice(0, 20000) + '\n…(超大输出截断，需要时可重新执行)';
            resultForHistory = JSON.stringify(parsed);
          }
        } catch (e) {}
        return { id: tc.id, content: resultForHistory, name: tc.name };
      }));
        toolResults.push(...batchResults);
        batchPending = batchPending.slice(batch.length);
      }
      return toolResults;
      };

      const onToolResults = async ({ results, toolCalls, context }) => {
      if (!agentRunCurrent(run)) return { stop: true, finished: true };
      if (typeof registerUiToolResult === 'function') {
        results.forEach(result => registerUiToolResult(result, {
          runId: context && context.runId !== undefined ? context.runId : run.id,
          sessionId: context && context.sessionId ? context.sessionId : s.id,
          generation: context && context.generation !== undefined ? context.generation : run.id,
        }));
      }
      if (userStopped) fillMissingToolResults(s, run.assistantMsg);   // 修复 S3（三轮）：暂停 break 后未执行的 tool_calls 补占位 tool 消息（配平防 400）
      toolCalls.forEach(tc => taskUsed.add(tc.name));  // 回填已用工具，后续轮次保留
      s._readKeys = [...readFileSet];   // 跨任务持久化已读记录

      // 修复 L4（四轮）：暂停后不再做熔断检测与进度记账——原停止后仍 registerToolSig
      //（同签名此前已登记两次时，停止动作会误触发「循环熔断」暂停面板，与用户主动
      // 停止语义重叠）、仍 registerProgress。sig 登记本身保留（下一任务新 deduper）。
      if (!userStopped) {
        const sig = JSON.stringify(toolCalls.map(tc => [tc.name, tc.argsStr]));
        const n = recentSigs.length;
        const alternating = n >= 3 && sig === recentSigs[n-2] && recentSigs[n-1] === recentSigs[n-3];
        recentSigs.push(sig); if (recentSigs.length > 6) recentSigs.shift();
        // 修复 建议㉛（三轮）：lastToolSig 为死变量（只写不读），删除
        // v1.2 R4：循环熔断——同工具同参数 ×3（或交替模式）→ 暂停并询问，不再静默自动停止
        const loopHit = registerToolSig(sig);
        if (loopHit || alternating) {
          if (agentRunVisible(run)) {
            showPausePanel(aiContent, s, 'loop', loopHit || { count: '交替', sig });
            toast('检测到循环工具调用，已熔断暂停', 'err');
          }
          return { stop: true, finished: true, naturalDone: false, status: 'loop' };
        }
        // v1.2 R4：连续 15 步无进展熔断
        if (registerProgress(taskFacts.length, fullContent.length)) {
          if (agentRunVisible(run)) {
            showPausePanel(aiContent, s, 'stall', {});
            toast('连续多步无进展，已熔断暂停', 'warn');
          }
          return { stop: true, finished: true, naturalDone: false, status: 'stall' };
        }
      }
      const spent = sessionSpent(s).tokens;   // 修复 S8（二轮）：30 万提醒读单调计数器（压缩不归零）
      if (spent > 300000 && !s.__budgetWarned) {
        s.__budgetWarned = true;
        const div = document.createElement('div');
        div.className = 'usage-info'; div.style.color = 'var(--warn)';
        div.textContent = `⚠ 本任务累计已消耗 ${spent.toLocaleString()} tokens，已超 30 万提醒线。建议总结进度后新开会话（任务继续运行，不会强制停止）。`;
        aiContent.appendChild(div);
      }
      s.updatedAt = Date.now();
      if (!userStopped && taskFacts.length > memFlushed) {   // 修复 W27：只追加本轮新增的增量事实；L4（四轮）：暂停后不再发记忆 RPC
        try { await callApi('append_memory', [JSON.stringify({ text: taskFacts.slice(memFlushed, memFlushed + 20).join('；') })]); window.__memCache = await callApi('get_memory', []); } catch (e) {}
        // 修复 fe-[10]（四轮）：单轮新增 >20 条时原直接跳到末尾（20 条之后永久漏发）
        memFlushed = Math.min(memFlushed + 20, taskFacts.length);
      }
      renderSessionList();
      return { stop: false };
      };

      const execution = await ModelExecutor.execute({
      context: { messages: s.messages, runId: run.id, sessionId: s.id, generation: run.id },
      endpoint: {
        endpoint: resolveApiEndpoint(), apiKey,
        local: typeof localState !== 'undefined' && localState.mode,
        proxyHeaders: (typeof localProxyHeaders === 'function') ? localProxyHeaders() : {},
      },
      transport: ModelTransport,
      tools: createToolRuntime({ executeBatch }),
      observer: Object.assign({}, streamObserver, {
        beforeRound, onAssistant, onToolResults,
        isActive: () => agentRunCurrent(run),
        onDegrade: degraded => {
          if (degraded === 'tools' && agentRunVisible(run)) toast('当前模型不支持工具调用，已切换为纯对话模式', 'warn');
        },
      }),
      signal: abortController.signal,
      limits: { maxRounds: 60 },
      });
      partialContent = execution.partialContent || partialContent;
      if (execution.finished !== undefined) finished = execution.finished;
      if (execution.naturalDone !== undefined) naturalDone = execution.naturalDone;
      run.naturalDone = naturalDone;
      if (execution.error) throw execution.error;
    /* v1.8.0 M3：计划正常跑完 → 收尾摘要 + 回滚入口
     * 修复：原在 catch 内引用 try 块级 let finished——越域 ReferenceError，
     * 且错误路径也会误跑收尾。移到 try 内 for 循环结束之后（renderSessionList() 之后）。
     * 再修（对抗复审）：判据从 finished 改为 naturalDone——finished 在熔断/预算/
     * 截断续跑路径同样为 true（详见 planFinishIfNatural 注释）。 */
    if (agentRunCurrent(run)) {
    planFinishIfNatural(userStopped, naturalDone);
    if (userStopped && aiContent) {
      // 修复（2026-10-18）：工具执行阶段暂停（无 AbortError）的收尾提示
      const note = document.createElement('div');
      note.className = 'usage-info';
      note.textContent = '⏸ 已停止（当前工具执行完后未再继续）';
      aiContent.appendChild(note);
    } else if (!finished) {
      const note = document.createElement('div');
      note.className = 'usage-info';
      note.textContent = '▮ 已达单次任务工具调用轮次上限(60)，如需继续，请发送「继续」。';
      aiContent.appendChild(note);
    }
    if (!run.statusFinalized) {
      if (typeof setSessionRunStatus === 'function') {
        setSessionRunStatus(s, naturalDone ? 'completed' : 'paused');
      }
      run.statusFinalized = true;
    }
    saveSessions();
    }
    }   // 修复 ㉗：原 try 块主体结束
  } catch (err) {
    if (agentRunCurrent(run)) {
    // 修复 S6（二轮）：请求失败/abort 后截图不能永久失陷——复位 shotState 让下轮可重发
    if (shotState === 'sending') shotState = 'idle';
    // 修复 M5（四轮）：非 abort 失败路径也清过期截图——原仅 AbortError 清，失败后
    // pendingShots 残留会被附到下一个无关请求（[系统附图] 误导模型）
    if (pendingShots.length) pendingShots = [];
    if (_localWaitTimer) { clearInterval(_localWaitTimer); _localWaitTimer = null; }   // 修复 S15（三轮）：AbortError 路径也清本地等待定时器（原只清 else 分支，1s 定时器永久存活劫持状态行）
    if (err.name === 'AbortError') {
      // 修复 建议㉕（三轮）：abort/停止时清 pendingShots——原只复位 shotState，
      // 待发截图残留致下一轮重发 + 重复 note 消息
      if (pendingShots.length) pendingShots = [];
      // 修复 W21（二轮）：abort 时固化部分正文入历史（原流中气泡有字但 messages 无此消息，
      // 重开即丢）+ 清理「正在输入」动画残留
      if (partialContent) {
        const last = s.messages[s.messages.length - 1];
        if (!last || last.role !== 'assistant') s.messages.push({ role: 'assistant', content: partialContent });
      }
      if (aiContent) {
        const dots = aiContent.querySelector && aiContent.querySelector('.typing-dots');
        if (dots) dots.remove();
      }
      if (run.assistantMsg) fillMissingToolResults(s, run.assistantMsg);   // 只配平本 run 已落库的 assistant
      saveSessions();
    } else {
      if (_localWaitTimer) { clearInterval(_localWaitTimer); _localWaitTimer = null; }   // 修复 B3：异常路径清理等待态计时器
      const shown = humanizeApiError(err.message,
        typeof localState !== 'undefined' && localState.mode, err.headers || null);
      if (aiContent) {
        aiContent.className = 'content error';
        fillErrorBubble(aiContent, '请求失败: ' + shown);   // v4：前缀红字+正文中性（防注入装配）
      } else {
        runAddMessage(run, 'error', '请求失败: ' + shown);   // 修复 ㉗：循环未建气泡前出错不再砸在 null 上
      }
      if (agentRunVisible(run)) toast('请求失败', 'err', { detail: String(err.message || '').slice(0, 400) });
      // Round 16 resume：网络断流/5xx/429 等可恢复错误与 abort 同款处理——
      // 部分正文固化入历史 + tool_calls 配平 + runStatus=paused（恢复横幅据此出现）。
      // 确定性失败（401/余额/参数）维持 failed：继续只会再失败，人话已给。
      if (typeof isResumableError === 'function' && isResumableError(err.message)) {
        if (partialContent) {
          const last = s.messages[s.messages.length - 1];
          if (!last || last.role !== 'assistant') s.messages.push({ role: 'assistant', content: partialContent });
        }
        if (run.assistantMsg) fillMissingToolResults(s, run.assistantMsg);
      }
      saveSessions();
    }
    if (!run.statusFinalized) {
      const _resumable = typeof isResumableError === 'function' && isResumableError(err.message);
      if (typeof setSessionRunStatus === 'function') {
        setSessionRunStatus(s, (err.name === 'AbortError' || userStopped || _resumable) ? 'paused' : 'failed');
      }
      run.statusFinalized = true;
    }
    }
  } finally {
    if (_nudgeTimer) { clearInterval(_nudgeTimer); _nudgeTimer = null; }
    if (_localWaitTimer) { clearInterval(_localWaitTimer); _localWaitTimer = null; }
    // 被取消的旧 run 即使已失去全局所有权，也要在自己的 finally 持久化收尾；
    // 显式传旧 session + 旧 assistant，绝不配平新 run 或新会话的消息。
    if (run.cancelled) {
      if (run.assistantMsg) fillMissingToolResults(run.session, run.assistantMsg);
      saveSessions();
    }
    if (!run.statusFinalized && typeof setSessionRunStatus === 'function') {
      setSessionRunStatus(run.session, run.naturalDone ? 'completed' : 'paused');
      run.statusFinalized = true;
    }
    const wasVisible = agentRunVisible(run);
    const activeId = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
    const ownsVisibleSession = activeId === run.sessionId;
    // 旧 run 的 finally 只清理自己的计时器；只有仍持有全局所有权的 run
    // 才能复位全局流式状态与按钮，避免关掉新 run。
    const ownedFinish = (typeof RunRegistry !== 'undefined')
      ? RunRegistry.finish(run) : (__agentActiveRun === run);
    // P0-3：run 结束时从自身注册表摘除（不论是否视窗 run——并行实例互不影响）
    if (__agentRuns.get(run.sessionId) === run) __agentRuns.delete(run.sessionId);
    if (ownedFinish) {
      if (typeof RunRegistry === 'undefined') __agentActiveRun = null;
      if (typeof AppState !== 'undefined') AppState.isStreaming = false;
      else isStreaming = false;
      if (wasVisible) {
        const bar = document.getElementById('streamBar');
        if (bar) bar.classList.remove('on');
        const btn = document.getElementById('sendBtn');
        if (btn) { setSendButtonVisual(btn, 'send'); btn.style.background = ''; btn.onclick = sendMessage; }
      }
      // Background run completion: only rebuild visible chat if the user is
      // currently looking at this run's session; otherwise update status only.
      if (ownsVisibleSession) {
        try { renderChatHistory(run.session); } catch (e) {}
      } else {
        try { callApi('set_current_sid', [activeId]).catch(() => {}); } catch (e) {}
        try {
          const current = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
          if (current && current.projectWorkspace) {
            callApi('set_session_ws', [activeId, current.projectWorkspace, true]).catch(() => {});
          }
        } catch (e) {}
        try { if (typeof refreshWsCard === 'function') refreshWsCard(); } catch (e) {}
      }
    }
    // 生成式UI（2026-11-02 主理人裁定）：回答落定后自动转换为可交互内联视图。
    // P0-4 真机修正：必须在 ownedFinish 门**之外**——并行时代后台完成的 run 不持
    // 全局所有权，门内触发会被静默跳过（真机报障：生成视图未出现）。
    // Round 5 复审：Round 4 重构 finally 时该调用被包回门内（括号深度实证），
    // 并行后台完成再次静默跳过——移回门外并留本注防再犯。
    // 可见性/去重由 chatGenerativeAutoRender 自守；用户切回会话时由
    // switchSession 的补渲染入口兜底。
    if (!run.cancelled && typeof chatGenerativeAutoRender === 'function') {
      try { void chatGenerativeAutoRender(run.sessionId); } catch (e) {}
    }
  }
}
