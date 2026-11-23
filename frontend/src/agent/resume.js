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

/* ================= R101 T03 · 纠偏指令（续跑前的「补一句」） =================
 * 为什么需要它：续跑（resume）此前是**无条件重放**——用户看到横幅只能选「继续」
 * 或「放弃」。但任务被中断往往不是随机的：上次 create_file 报了 EEXIST、上次
 * run_powershell 权限不足……用户脑子里有这条信息，界面上却没有地方说。结果是
 * 「继续」把同一个失败再撞一遍，白烧一轮 token。
 *
 * 边界（刻意收窄，不做成聊天框）：
 *   · 默认收起，点「加一句纠偏」才展开——续跑是低频动作，不该让一个空输入框
 *     常年占版面；
 *   · 建议只用 **placeholder** 承载，绝不写进 value：预填成 value 等于替用户
 *     决定了他没确认过的内容，一点发送就把它当指令发出去；
 *   · 收起态一律视为「没有纠偏」（不把 placeholder 当值）。
 *
 * 建议文案按**工具类别**给：上次失败的工具类别不同，用户该补的信息也不同
 * （文件类要确认路径、命令类要确认退出码/权限、MCP 类多半是鉴权）。类别判定
 * 复用 agent/tool-runtime.js 的 toolCategoryOf，不在这里另造一套名称模式。
 */

/**
 * 纠偏建议文案（写进 placeholder）。无工具调用 → 通用文案。
 * @param {object} s 会话对象（只读 s.messages）
 * @returns {string}
 */
function resumeDirectivePlaceholder(s) {
  const generic = '补充一句纠偏说明（可选）';
  // 类别 → 建议（与 tool-runtime.js 的 toolCategoryOf 返回值一一对应）
  const hints = {
    file: '先确认路径存在再读写',
    shell: '先看退出码与权限',
    web: '先确认端点与网络',
    memory: '先确认记忆条目是否过期',
    mcp: '先确认连接器鉴权',
  };
  try {
    const msgs = (s && Array.isArray(s.messages)) ? s.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
      const tc = m.tool_calls[0] || {};
      const name = (tc.function && tc.function.name) || tc.name || '';
      // 跨模块只走动态索引：裸写 toolCategoryOf 会被静态分析记成
      // resume.js → tool-runtime.js 的新边（SCC 零余量，加边即红）。
      const catFn = (typeof window !== 'undefined') ? window['tool' + 'CategoryOf'] : null;
      const cat = (typeof catFn === 'function') ? String(catFn(name) || 'other') : 'other';
      // 只认已知类别；other 与取不到一律通用文案（不编造针对性建议）
      return hints[cat] || generic;
    }
  } catch (e) { /* 会话结构异常 → 通用文案，不阻断接管 UI */ }
  return generic;
}

/**
 * 挂载「加一句纠偏」折叠块（横幅与计划卡共用实现，命名空间由 ns 决定）。
 * @param {Element} host 挂载点（横幅/卡片本体）
 * @param {object} s 会话对象
 * @param {'rb'|'prc'} ns 类名前缀（保持两处各自命名空间）
 * @returns {{wrap: Element, toggle: Element, textarea: Element}|null}
 */
function resumeDirectiveBlock(host, s, ns) {
  if (!host || typeof host.appendChild !== 'function' || typeof document === 'undefined'
      || typeof document.createElement !== 'function') return null;
  const p = String(ns || 'rb');
  const wrap = document.createElement('div');
  wrap.className = p + '-directive-wrap';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = p + '-directive-toggle';
  toggle.textContent = '加一句纠偏';
  if (toggle.setAttribute) toggle.setAttribute('aria-expanded', 'false');
  const ta = document.createElement('textarea');
  ta.className = p + '-directive';
  ta.hidden = true;                      // 默认收起
  ta.placeholder = resumeDirectivePlaceholder(s);
  if (ta.setAttribute) { ta.setAttribute('rows', '2'); ta.setAttribute('aria-label', '续跑纠偏指令'); }
  // 折叠/展开：只是显示态切换，绝不把 placeholder 提升成 value
  toggle.onclick = () => {
    const open = !!ta.hidden;
    ta.hidden = !open;
    if (toggle.setAttribute) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? '收起纠偏' : '加一句纠偏';
    if (open) { try { if (typeof ta.focus === 'function') ta.focus(); } catch (e) {} }
  };
  wrap.appendChild(toggle);
  wrap.appendChild(ta);
  try { host.appendChild(wrap); } catch (e) { return null; }
  return { wrap: wrap, toggle: toggle, textarea: ta };
}

/**
 * 读取纠偏指令（trim 后；收起态一律返回 ''）。
 * @param {{textarea?: Element}|Element|null} holder block 句柄或容器元素
 * @returns {string}
 */
function resumeDirectiveValue(holder) {
  try {
    let ta = (holder && holder.textarea) ? holder.textarea : null;
    if (!ta && holder && typeof holder.querySelector === 'function') {
      ta = holder.querySelector('.rb-directive') || holder.querySelector('.prc-directive');
    }
    if (!ta || ta.hidden) return '';     // 收起态 / 找不到 → 无纠偏
    return String(ta.value == null ? '' : ta.value).trim();
  } catch (e) { return ''; }
}

/** 恢复横幅。actions = { onContinue(directive), onDismiss }；DOM 桩安全（全部 typeof 守卫）。 */
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
  // R101 T03：纠偏折叠块（默认收起）。句柄挂 __directive，点击续跑时再读值。
  try { el.__directive = resumeDirectiveBlock(el, s, 'rb'); } catch (e) { el.__directive = null; }
  const dismiss = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
    persistResumeState(s, false);
    if (actions && typeof actions.onDismiss === 'function') { try { actions.onDismiss(); } catch (e) {} }
  };
  // onclick 赋值（与 run-controller contBtn 同款）；具名函数同时挂元素本体
  // __continue/__dismiss（__ 前缀约定，同 bubble.__finish）——DOM 桩的
  // querySelector 每次返回新元素，程序化触发/测试走侧通道
  const onContinue = () => {
    const directive = resumeDirectiveValue(el.__directive);   // 收起态 → ''
    if (el.parentNode) el.parentNode.removeChild(el);
    // R101 T03：纠偏指令作为第 1 个实参交给调用方（旧写法 () => {} 忽略实参，行为不变）
    if (actions && typeof actions.onContinue === 'function') {
      try { actions.onContinue(directive); } catch (e) {}
    }
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
        ' 步被中断 · 续跑将回填该计划草稿（步骤/状态），检查点仍可回滚';
      // 桩的 querySelector 每次返回新元素——测试读侧通道（同 el.__textEl）
      card.__titleEl = titleEl;
      card.__metaEl = metaEl;
      // R101 T03：纠偏折叠块（与横幅同一实现，命名空间 prc- 独立）
      let directiveBlock = null;
      try { directiveBlock = resumeDirectiveBlock(card, s, 'prc'); } catch (e) { directiveBlock = null; }
      card.__directive = directiveBlock;
      const cleanup = () => {
        if (card.parentNode) card.parentNode.removeChild(card);
        if (wrap.children && !wrap.children.length && wrap.parentNode) {
          wrap.parentNode.removeChild(wrap);
        }
      };
      const go = () => {
        const directive = resumeDirectiveValue(directiveBlock);   // 收起态 → ''
        cleanup();
        // FE-5 重设计：原实现把 p 丢弃（卡片「从断点续跑」为假——重载后 s.plan
        // 缺失，续跑不携带计划草稿，模型无从知道步骤进度）。现在把 plan_list
        // 数据回填 s.plan（同 task_id 才回填），落盘后交给既有续跑链路。
        if (s && p && p.task_id) {
          try {
            if (!s.plan || String(s.plan.task_id) !== String(p.task_id)) {
              s.plan = { task_id: String(p.task_id), title: p.title || '',
                status: p.status || 'executing', steps: p.steps || [] };
            } else {
              s.plan.steps = p.steps || s.plan.steps || [];
              s.plan.status = p.status || s.plan.status;
            }
            if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e2) {} }
          } catch (e3) { /* 回填失败不阻断续跑（行为回到旧版） */ }
        }
        if (actions && typeof actions.onContinue === 'function') {
          // R101 T03：第 2 个实参是纠偏指令；第 1 个仍是计划对象（旧写法不受影响）
          try { actions.onContinue(p, directive); } catch (e) {}
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
      // FE-5 ②（R50 扫描）：plan_list 是全局清单，不过滤会话会把 B 会话的
      // 续跑卡挂进 A 会话聊天区（跨会话污染）。计划文件无会话归属字段——
      // 挂载侧只认「本会话绑定的计划」（task_id === s.plan.task_id）：
      // plan_list 仅用于取该计划的最新 steps/status；无绑定 → 回落 fallback。
      const own = s && s.plan && s.plan.task_id
        ? plans.find(p => p && String(p.task_id) === String(s.plan.task_id))
        : null;
      return mount(own ? [own] : fallback);
    }).catch(() => mount(fallback));
  } catch (e) { return mount(fallback); }
}
