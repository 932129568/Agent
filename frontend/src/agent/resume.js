/* ================= Resume 恢复机制（Round 16，2026-11-05 主理人立项） =================
 * 主理人要求：「完整实现 resume 机制，并在全部功能场景中完整运用，确保中断后
 * 可接续且状态一致。」
 *
 * 盘点结论（本文件只管【主对话 Agent 任务】这一环）：
 * - 截断（length）→ 自动续跑 ≤5 次（run-controller 已有，continueLastGeneration）
 * - abort → W21 已固化部分正文 + fillMissingToolResults 配平 + runStatus=paused
 * - 群聊接力 → phase/turn/mentionQueue 持久化 + 「继续接力」（Round 13/15 已闭环）
 * - **网络断流（error 路径）→ 部分正文丢弃、tool_calls 不配平、runStatus=failed、
 *   无恢复入口** ← 本模块补齐的主缺口
 *
 * 组成：
 * 1. isResumableError(msg)：错误分类——网络/超时/5xx/429 可恢复（重试有意义）；
 *    401/余额/参数类确定性失败不可恢复（继续只会再失败，人话提示已足够）。
 * 2. shouldOfferResume(s)：会话是否值得显示恢复横幅——runStatus=paused 且消息流
 *    停在 assistant/tool（任务进行中被打断的特征）；空会话/自然完成不弹。
 * 3. resumeBannerMount(box, s, actions)：恢复横幅 DOM（继续任务 / 放弃）。
 * 4. persistResumeState(s, ok)：放弃时把状态收敛为 completed（normalize 白名单
 *   接受），继续时交给 continueLastGeneration（run-controller）。
 *
 * 状态一致性保证：继续 = runAgentLoop 重入。历史里 assistant.tool_calls 已被
 * fillMissingToolResults 配平（error 路径新增同样调用），模型看到的是合法
 * OpenAI 消息序列，从挂起点自然续写；不重发用户原文（防重复计费/重复执行）。
 */

/** 错误分类：可恢复（网络层/限流/服务端临时故障）返回 true。 */
function isResumableError(msg) {
  const m = String(msg || '');
  return /(Failed to fetch|NetworkError|network|timeout|timed? ?out|socket|ECONN|EPIPE|fetch failed|HTTP 5\d\d|HTTP 429|aborted|连接|超时|限流)/i.test(m)
    && !/HTTP 40[13]:/i.test(m);   // 401/403 确定性失败；400 已由 degrade 链处理
}

/** 会话是否应显示恢复横幅。纯函数（不碰 DOM）。 */
function shouldOfferResume(s) {
  if (!s || !s.messages || !s.messages.length) return false;
  if (s.runStatus !== 'paused') return false;   // failed=确定性失败/群聊恢复另有入口
  const last = s.messages[s.messages.length - 1];
  if (!last) return false;
  // 任务进行中被切断的特征：最后一条是 assistant（可能带已配平 tool_calls）
  // 或 tool 结果（下一轮模型调用没跑）。自然完成的会话最后一条也是 assistant，
  // 但 runStatus 会是 completed，不会走到这里。
  return last.role === 'assistant' || last.role === 'tool';
}

/** 恢复横幅。actions = { onContinue, onDismiss }；DOM 桩安全（全部 typeof 守卫）。 */
function resumeBannerMount(box, s, actions) {
  if (!box || !box.appendChild || !shouldOfferResume(s)) return null;
  const round = (s._resumeRound != null) ? s._resumeRound
    : (s.messages.filter(m => m.role === 'assistant').length);
  const el = document.createElement('div');
  el.id = 'resumeBanner';
  el.className = 'resume-banner';
  if (el.setAttribute) el.setAttribute('role', 'status');   // DOM 桩安全
  el.innerHTML =
    '<span class="rb-ico"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-bolt"/></svg></span>' +
    '<span class="rb-text"></span>' +
    '<span style="flex:1"></span>' +
    '<button type="button" class="rb-btn rb-continue">▸ 继续任务</button>' +
    '<button type="button" class="rb-btn rb-dismiss">放弃</button>';
  const textEl = el.querySelector('.rb-text');
  textEl.textContent =
    '上次任务在第 ' + round + ' 轮被中断，已输出内容与工具状态均已保留';
  el.__textEl = textEl;   // 桩的 querySelector 每次返回新元素——测试读侧通道
  const dismiss = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
    persistResumeState(s, false);
    if (actions && typeof actions.onDismiss === 'function') { try { actions.onDismiss(); } catch (e) {} }
  };
  // onclick 赋值（与 run-controller contBtn 同款）；具名函数同时挂元素本体
  // __continue/__dismiss（__ 前缀约定，同 bubble.__finish）——DOM 桩的
  // querySelector 每次返回新元素，程序化触发/测试走侧通道
  const onContinue = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
    if (actions && typeof actions.onContinue === 'function') { try { actions.onContinue(); } catch (e) {} }
  };
  el.querySelector('.rb-continue').onclick = onContinue;
  el.querySelector('.rb-dismiss').onclick = dismiss;
  el.__continue = onContinue;
  el.__dismiss = dismiss;
  // 计划上下文增强（异步，不阻塞横幅）：会话挂着 plan.task_id 且计划处于
  // approved/executing → 文案升级为计划视角（计划在哪个断点）。plan_get 本就是
  // 「断线重连用」接口（M3-B1）；步进级回滚由 checkpoint_rollback 承接。
  if (s.plan && s.plan.task_id && typeof callApi === 'function') {
    try {
      callApi('plan_get', [String(s.plan.task_id)], 15000).then(raw => {
        const p = raw ? JSON.parse(raw) : null;
        const plan = p && (p.plan || p);
        if (!plan || !plan.steps) return;   // 横幅若已移除，写 textContent 无害（节点即弃）
        if (plan.status !== 'approved' && plan.status !== 'executing') return;
        const done = plan.steps.filter(x => x.status === 'done').length;
        textEl.textContent = '计划「' + (plan.title || '任务') + '」执行至第 ' +
          Math.min(done + 1, plan.steps.length) + '/' + plan.steps.length +
          ' 步被中断，已完成步骤与检查点均保留';
        el.__textEl = textEl;
      }).catch(() => {});
    } catch (e) {}
  }
  // DOM 桩安全：真实容器 insertBefore；桩（无此方法）退化为 appendChild
  if (box.insertBefore) box.insertBefore(el, box.firstChild);
  else box.appendChild(el);
  return el;
}

/** 放弃 → 收敛为 completed（normalize 白名单内；不再弹横幅）。 */
function persistResumeState(s, resuming) {
  if (!s) return;
  if (!resuming) {
    s.runStatus = 'completed';
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
  }
}

/* ---------- R26：逐计划 resume 卡片（交接报告遗留 #2） ----------
 * 横幅只给会话级「继续」入口与计划上下文，没有逐计划的独立续跑卡片。
 * 这里按 plan_list 列出所有进行中的计划，每张卡片显示断点步数与检查点
 * 保留状态，并提供「从断点续跑」「放弃本计划」。
 *
 * 边界（重要）：步进级恢复仍由既有 checkpoint_rollback 链路承接——本卡片
 * 只提供入口，不自行回滚，避免与 planning/card.js 的两段式二次确认竞态。
 * 桥不可用 / 计划清单为空 → 回落 s.plan 单计划；仍无 → 不挂任何 DOM。
 * 计划标题属不可信文本，一律 textContent 装配（R20 高危 XSS 纪律）。
 */
function planResumeCardsMount(box, s, actions) {
  const fallback = (s && s.plan && s.plan.task_id)
    ? [{ task_id: String(s.plan.task_id), title: s.plan.title || '任务计划',
         status: s.plan.status || 'executing', steps: s.plan.steps || [] }]
    : [];
  const mount = (plans) => {
    const list = (plans || []).filter(p => p && p.task_id &&
      ['planning', 'approved', 'executing', 'running'].indexOf(String(p.status || '')) >= 0)
      .slice(0, 5);
    if (!box || !box.appendChild || !list.length) return 0;
    const wrap = document.createElement('div');
    wrap.id = 'planResumeCards';
    wrap.className = 'plan-resume-cards';
    if (wrap.setAttribute) wrap.setAttribute('role', 'group');
    list.forEach(p => {
      const steps = p.steps || [];
      const done = steps.filter(x => x && x.status === 'done').length;
      const at = Math.min(done + 1, steps.length || 1);
      const card = document.createElement('div');
      card.className = 'plan-resume-card';
      card.dataset.taskId = String(p.task_id);   // dataset 兼容 DOM 桩与真实 DOM
      card.innerHTML =
        '<span class="prc-ico"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-bolt"/></svg></span>' +
        '<div class="prc-body"><div class="prc-title"></div><div class="prc-meta"></div></div>' +
        '<button type="button" class="prc-continue">▸ 从断点续跑</button>' +
        '<button type="button" class="prc-dismiss">放弃</button>';
      const titleEl = card.querySelector('.prc-title');
      if (titleEl) titleEl.textContent = '计划「' + (p.title || '任务') + '」';
      const metaEl = card.querySelector('.prc-meta');
      if (metaEl) metaEl.textContent = '执行至第 ' + at + '/' + (steps.length || 1) +
        ' 步被中断 · 已完成步骤与检查点均保留';
      // 桩的 querySelector 每次返回新元素——测试读侧通道（同 el.__textEl）
      card.__titleEl = titleEl;
      card.__metaEl = metaEl;
      const cleanup = () => {
        if (card.parentNode) card.parentNode.removeChild(card);
        if (wrap.children && !wrap.children.length && wrap.parentNode) {
          wrap.parentNode.removeChild(wrap);
        }
      };
      const go = () => {
        cleanup();
        if (actions && typeof actions.onContinue === 'function') {
          try { actions.onContinue(p); } catch (e) {}
        }
      };
      const drop = () => {
        cleanup();
        try { if (typeof toast === 'function') toast('已放弃计划「' + (p.title || '任务') + '」的续跑', 'info'); } catch (e) {}
      };
      // DOM 桩的 querySelector 每次返回新元素——程序化触发/测试走侧通道
      const contBtn = card.querySelector('.prc-continue');
      const dropBtn = card.querySelector('.prc-dismiss');
      if (contBtn) contBtn.onclick = go;
      if (dropBtn) dropBtn.onclick = drop;
      card.__continue = go;
      card.__dismiss = drop;
      wrap.appendChild(card);
    });
    if (box.insertBefore) box.insertBefore(wrap, box.firstChild);
    else box.appendChild(wrap);
    return list.length;
  };
  if (typeof callApi !== 'function') return mount(fallback);
  try {
    const pending = callApi('plan_list', [20], 15000);
    if (!pending || typeof pending.then !== 'function') return mount(fallback);
    return pending.then(raw => {
      let d = {};
      try { d = JSON.parse(raw || '{}'); } catch (e) {}
      let plans = d.plans || d.data || (Array.isArray(d) ? d : []);
      if (!Array.isArray(plans)) plans = [];
      return mount(plans.length ? plans : fallback);
    }).catch(() => mount(fallback));
  } catch (e) { return mount(fallback); }
}
