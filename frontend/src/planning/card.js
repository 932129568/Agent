/* ================= v1.8.0 M3 域·Plan-Act 计划执行 UI（67-plan-card.js） =================
 * 计划卡 / todo 五态 / 偏差暂停条 / 批量澄清表单 / 检查点进度与回滚确认。
 * 设计：design/v18/ux-flows.md 流程 8/9/10 + motion-spec.md §1-10/11/13/14
 *   + prototype.html（plan-/clr-/ckpt-/dev- 九域类名与动效值同源）。
 * 数据：后端 plan_* / checkpoint_* / clarify_collect（_V12_EXTRA 隐身，联调规范 §3.5）。
 * 交互铁律（ux-flows）：
 *   - 计划即契约：Act 阶段以计划为基准；重大偏差 → 暂停条回问（不等执行完）
 *   - 澄清一次问完（≤5 问单表单），禁止执行中挤牙膏
 *   - 回滚二次确认用 inline（禁模态叠模态）；检查点超限降级有 warn
 *  typeof 守卫：模块顶层不直接引用 window/document（vm 沙箱可测）。
 */

let planCurrent = null;        // 当前计划 {task_id, title, steps[], status}
let planCardEl = null;         // 计划卡 DOM（消息流内）
let planRunning = false;       // 计划执行中（agent loop 回调推进 todo）
let planResolveApprove = null; // 批准 Promise 的 resolve（agent loop 等待用户批准）
let planUiRevision = 0;

/* ---------- 工具 ---------- */
function pcEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function pcEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pcCall(name, args, timeout) {
  if (typeof callApi !== 'function') return Promise.reject(new Error('pywebview bridge 未就绪'));
  return callApi(name, args, timeout || 30000);
}
function pcToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'info');
}
function pcScrollChat() {
  if (typeof scrollChat === 'function') scrollChat();
  else {
    const c = pcEl('chatContainer');
    if (c) c.scrollTop = c.scrollHeight;
  }
}
/* 动效时长单一事实源（00-motion MOTION；vm 沙箱/未加载时回落——
   纪律：JS 禁硬编码毫秒数，CSS 变量改令牌即全站生效） */
function pcCompOutMs() {
  return (typeof MOTION !== 'undefined' && MOTION.compOut) ? MOTION.compOut() : 140;
}
function planGenerativeRender(card) {
  if (!card || !card.__uiHost) return null;
  if (card.__uiAiController && card.__uiAiController.isBusy()) return card.__uiProjection;
  const spec = UiSpecFixtures.plan({
    plan: planCurrent,
    revision: Math.max(planUiRevision, card.__uiProjection && card.__uiProjection.current
      ? card.__uiProjection.current.revision : 0),
    sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'current-session',
  });
  const hostOptions = { dataRefHost: createUiDataRefHost({
    runId: spec.runId, sessionId: spec.sessionId, generation: spec.generation,
  }) };
  if (!card.__uiProjection) card.__uiProjection = UiProjection.mount(card.__uiHost, spec, hostOptions);
  else card.__uiProjection.commit(spec);
  return card.__uiProjection;
}
function planGenerativeShow(card) {
  if (!card) return null;
  if (card.__uiAiController) card.__uiAiController.cancel();
  const projection = planGenerativeRender(card);
  card.__uiOriginal.hidden = true;
  card.__uiHost.hidden = false;
  card.__uiRawBtn.hidden = false;
  card.__uiGenerateBtn.hidden = true;
  return projection;
}
function planGenerativeHide(card) {
  if (!card) return;
  if (card.__uiAiController) card.__uiAiController.cancel();
  card.__uiOriginal.hidden = false;
  card.__uiHost.hidden = true;
  card.__uiRawBtn.hidden = true;
  card.__uiGenerateBtn.hidden = false;
}
async function planGenerativeRefresh(card) {
  if (!card || !planCurrent || !planCurrent.task_id) return planGenerativeRender(card);
  if (card.__uiRefreshPromise) return card.__uiRefreshPromise;
  const taskId = planCurrent.task_id;
  card.__uiRefreshPromise = (async () => {
    const raw = await pcCall('plan_get', [taskId], 15000);
    const payload = JSON.parse(raw || '{}');
    const authoritative = payload.plan || payload;
    if (authoritative && authoritative.steps) planCurrent = authoritative;
    planUiRevision++;
    return planGenerativeRender(card);
  })();
  try { return await card.__uiRefreshPromise; }
  finally { card.__uiRefreshPromise = null; }
}

/* ---------- 计划卡渲染 ---------- */
function planCardRender(plan) {
  if (typeof document === 'undefined') return null;
  const host = pcEl('chatContainer') || document.body;
  if (planCardEl) planCardEl.remove();
  const card = document.createElement('div');
  card.className = 'plan-card';
  card.id = 'planCard';
  // v1.9 Intent Preview（2026-10-23 落地，token-upgrade-plan §2.1）：
  // ETA 前端估算（25s/步，mono 明示估算口径）；风险条取最高步骤风险；
  // 边界声明区（dashed）替代旧「涉及」单行；累计上下文行（步骤/需确认统计）
  const steps = plan.steps || [];
  const etaMin = Math.max(1, Math.round(steps.length * 25 / 60));
  const maxRisk = steps.some(x => x.risk === 'l2') ? 'l2'
    : (steps.some(x => x.risk === 'l1') ? 'l1' : 'l0');
  const needConfirm = steps.filter(x => x.risk && x.risk !== 'l0').length;
  const scope = (plan.files && plan.files.length)
    ? '<div class="plan-scope"><div class="sc-head">将修改</div>' +
      '<div class="sc-files">' + plan.files.map(pcEsc).join('\n') + '</div>' +
      '<div class="sc-files" style="margin-top:4px;color:var(--text-3)">不访问工作区以外的任何位置</div></div>'
    : '<div class="plan-scope"><div class="sc-head">不访问</div>' +
      '<div class="sc-files">本计划不涉及文件修改（仅读取/生成内容）</div></div>';
  const ctxPct = steps.length ? Math.round(100 / steps.length) : 100;
  card.innerHTML =
    '<span class="plan-riskbar ' + maxRisk + '"></span>' +
    '<div class="plan-head">' +
      '<span class="plan-badge pending" id="planBadge">待批准</span>' +
      '<span class="plan-title">' + pcEsc(plan.title || '任务计划') + '</span>' +
      '<span class="plan-eta">≈' + steps.length + ' 步 · ' + etaMin + ' 分钟</span>' +
    '</div>' + scope +
    '<div class="plan-ctx"><span>' + steps.length + ' 步 · ' + needConfirm + ' 需确认</span>' +
      '<span class="ctx-bar"><span class="ctx-fill" style="width:' + ctxPct + '%"></span></span></div>' +
    '<div class="plan-steps" id="planSteps">' +
    (plan.steps || []).map((s, i) =>
      '<div class="plan-step pending" data-i="' + i + '" style="animation-delay:' +
      (60 + i * 40) + 'ms">' +
      '<span class="st"></span><span class="txt">' + pcEsc(s.text) + '</span>' +
      (Array.isArray(s.tools) && s.tools.length
        ? '<span class="plan-tools">' +
          s.tools.slice(0, 4).map(pcEsc).join(' ') +
          (s.tools.length > 4 ? ' +' + (s.tools.length - 4) : '') + '</span>' : '') +
      (s.risk ? '<span class="risk ' + pcEsc(s.risk) + '">' +
        (s.risk === 'l2' ? '授权内' : '需确认') + '</span>' : '') +
      '</div>').join('') +
    '</div>' +
    '<div class="plan-acts" id="planActs">' +
      '<button class="pill-btn primary" id="planApproveBtn">批准执行</button>' +
      '<button class="pill-btn" id="planEditBtn" disabled title="当前版本不支持编辑计划；请拒绝后重新描述任务">编辑（不可用）</button>' +
      '<button class="pill-btn" id="planRejectBtn">拒绝</button>' +
    '</div>' +
    '<div class="plan-summary" id="planSummary"></div>' +
    '<div class="plan-ckpt" id="planCkpt" style="display:none"></div>';
  planUiRevision++;
  const original = document.createElement('div');
  original.className = 'plan-original-view';
  while (card.firstChild) original.appendChild(card.firstChild);
  card.appendChild(original);
  const controls = document.createElement('div');
  controls.className = 'ui-view-controls';
  const generate = document.createElement('button');
  generate.type = 'button'; generate.className = 'pill-btn';
  generate.id = 'planGenerateViewBtn'; generate.textContent = '生成视图';
  const raw = document.createElement('button');
  raw.type = 'button'; raw.className = 'pill-btn';
  raw.id = 'planRawViewBtn'; raw.textContent = '原始视图'; raw.hidden = true;
  const ai = document.createElement('button');
  ai.type = 'button'; ai.className = 'pill-btn'; ai.id = 'planAiGenerateBtn';
  ai.textContent = 'AI生成'; ai.setAttribute('aria-label', '使用 AI 生成计划视图');
  const aiCancel = document.createElement('button');
  aiCancel.type = 'button'; aiCancel.className = 'pill-btn'; aiCancel.id = 'planAiCancelBtn';
  aiCancel.textContent = '取消生成'; aiCancel.hidden = true;
  const generativeHost = document.createElement('div');
  generativeHost.className = 'plan-generative-host';
  generativeHost.hidden = true;
  controls.appendChild(generate); controls.appendChild(raw);
  controls.appendChild(ai); controls.appendChild(aiCancel);
  card.appendChild(controls); card.appendChild(generativeHost);
  card.__uiOriginal = original; card.__uiHost = generativeHost;
  card.__uiGenerateBtn = generate; card.__uiRawBtn = raw; card.__uiProjection = null;
  card.__uiAiController = typeof createUiGenerationController === 'function' ? createUiGenerationController({
    kind: 'plan', host: generativeHost, button: ai, cancelButton: aiCancel,
    // P0-4 修正：注入带真实密钥的端点快照（原内联快照密钥恒空 → AI生成 401 从未可用）
    endpoint: (typeof uiEndpointSnapshot === 'function') ? uiEndpointSnapshot() : undefined,
    fallback: () => UiSpecFixtures.plan({ plan: planCurrent, revision: planUiRevision,
      sessionId: typeof AppState !== 'undefined' ? AppState.currentSessionId : 'current-session' }),
    actionHandlers: {
      refresh: () => planGenerativeRefresh(card),
      copy: context => navigator.clipboard.writeText(context.text),
      export: () => exportSessionMd(typeof AppState !== 'undefined' ? AppState.currentSessionId : null),
    },
    actionPermission: (name, block) => {
      if (!block.bind) return !!planCurrent;
      const spec = card.__uiProjection && card.__uiProjection.current;
      return createUiDataRefHost({ runId: spec && spec.runId,
        sessionId: spec && spec.sessionId, generation: spec && spec.generation,
      }).permission(block.bind) === true;
    },
    onResult: result => { if (result.projection) card.__uiProjection = result.projection; },
  }) : null;
  if (!card.__uiAiController) { ai.hidden = true; aiCancel.hidden = true; }
  generate.onclick = () => planGenerativeShow(card);
  raw.onclick = () => planGenerativeHide(card);
  ai.onclick = () => { planGenerativeShow(card); card.__uiAiController.start(); };
  aiCancel.onclick = () => card.__uiAiController.cancel();
  host.appendChild(card);
  planCardEl = card;
  const ap = pcEl('planApproveBtn');
  if (ap) ap.onclick = () => planCardApprove();
  const rj = pcEl('planRejectBtn');
  if (rj) rj.onclick = () => planCardReject();
  pcScrollChat();
  return card;
}

/** 展示计划（ux-flows 流程 8 plan_review 态）。 */
async function planShow(plan) {
  // 在途保护：旧计划仍挂起 → AbortError 收尾（防 agent loop 双挂起互相踩）
  if (planResolveApprove) {
    const old = planResolveApprove;
    planResolveApprove = null;
    try { old.reject(new DOMException('计划已被新的计划取代', 'AbortError')); } catch (e) {}
  }
  planCurrent = plan;
  planCardRender(plan);
  // 等用户批准（agent loop 挂起）；拒绝 → 抛 AbortError 由调用方转为「已拒绝」
  return new Promise((resolve, reject) => {
    planResolveApprove = { resolve, reject };
  });
}

function planCardApprove() {
  const card = planCardEl;
  if (!card || !planResolveApprove) return;
  // 前置守卫：批准后 planModeRun 会以任务文本走原发送链，若此刻有生成任务
  // 在途，sendMessage 入口的 isStreaming 检查会把这次发送静默吞掉（任务永不
  // 执行）。根因在 100-send 的裸 sendMessage；此处先行拦截并给用户人话。
  if (typeof isStreaming !== 'undefined' && isStreaming) {
    pcToast('当前有生成任务进行中，请稍候再批准', 'warn');
    return;
  }
  const acts = pcEl('planActs');
  const badge = pcEl('planBadge');
  if (badge) { badge.className = 'plan-badge running'; badge.textContent = '执行中'; }
  // v1.9 M2.3：批准动效链——approved_at（后端 plan_update 落 ISO 时间）挂 ctx 行
  const ctx = planCardEl ? planCardEl.querySelector('.plan-ctx') : null;
  if (ctx && planCurrent && !planCurrent.approved_at) {
    planCurrent.approved_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const sp = document.createElement('span');
    sp.className = 'plan-approved-at';
    sp.textContent = '已批准 ' + planCurrent.approved_at.slice(11);
    ctx.appendChild(sp);
  }
  if (acts) {
    acts.classList.add('gone');
    const done = () => { acts.style.display = 'none'; };
    if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
      MOTION.onAnimEnd(acts, 'transitionend', MOTION.compOut()).then(done);
    } else done();
  }
  const r = planResolveApprove;
  planResolveApprove = null;
  if (planCurrent) planCurrent.status = 'running';
  if (typeof pcCall === 'function' && planCurrent) {
    pcCall('plan_update', [planCurrent.task_id, 'running'], 15000).catch(() => {});
  }
  // 检查点只由 100-send.js 的 planModeRun 在批准 Promise 返回后创建，
  // 以便携带真实有效工作区；此处不得重复创建或使用空工作区。
  r.resolve();
  planUiRevision++;
  if (card.__uiHost && !card.__uiHost.hidden) planGenerativeRender(card);
}

/* ---------- v1.9 检查点三态（M2.8；后端 checkpoint_* 三方法在位） ----------
 * 入口（摘要区「检查点已创建 · 可回滚」）→ 清单态（ckpt-list stagger）→
 * 确认（uiConfirm 二次确认，方案：调用方须已完成清单二次确认）→ 回滚 →
 * 校验态（ok/err 行；rollback 失败形状 {ok:false,restored,failed} 原样呈现） */
let ckptBusy = false;
function ckptRenderEntry(created) {
  const box = pcEl('planCkpt');
  if (!box) return;
  if (!created) {
    box.innerHTML = '<span style="font-size:var(--fs-caption);color:var(--text-3)">检查点不可用（非 git 目录或创建失败）· 本计划无回滚兜底</span>';
    box.style.display = '';
    return;
  }
  box.innerHTML =
    '<button type="button" class="plan-ckpt-link" id="ckptRollbackLink">↩ 回滚到计划开始前</button>' +
    '<span style="font-size:var(--fs-micro);color:var(--text-3)">检查点已创建 · 涉及文件共 ' +
      pcEsc(String((planCurrent && planCurrent.files || []).length)) + ' 个</span>';
  box.style.display = '';
  const link = pcEl('ckptRollbackLink');
  if (link) link.onclick = () => ckptOpenList();
}
async function ckptOpenList() {
  if (ckptBusy) return;
  ckptBusy = true;
  const box = pcEl('planCkpt');
  if (!box) { ckptBusy = false; return; }
  let list = [];
  try {
    const raw = await pcCall('checkpoint_list', [planCurrent && planCurrent.task_id || ''], 30000);
    const d = JSON.parse(raw || '{}');
    list = (d && d.files) || [];
  } catch (e) {
    box.innerHTML = '<div class="ckpt-verify err">清单读取失败：' + pcEsc(e.message || e) + '</div>';
    ckptBusy = false; return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="ckpt-verify ok">无已改动文件 · 计划开始前的状态与当前一致，无需回滚</div>';
    ckptBusy = false; return;
  }
  const rows = list.map(f =>
    '<div class="ckpt-row"><span class="f">' + pcEsc(f.path || '') + '</span>' +
    '<span class="m ' + pcEsc(f.kind || 'mod') + '">' +
    (f.kind === 'add' ? '新增' : f.kind === 'del' ? '删除' : '修改') + '</span></div>').join('');
  box.innerHTML =
    '<div class="ckpt-card"><div class="ckpt-title">回滚将恢复以下文件 <span class="ckpt-id">' +
      pcEsc(String(list.length)) + ' 个</span></div>' +
    '<div class="ckpt-list">' + rows + '</div>' +
    '<div class="ckpt-acts">' +
      '<button type="button" class="pill-btn primary" id="ckptConfirmBtn">确认回滚</button>' +
      '<button type="button" class="pill-btn" id="ckptCancelBtn">取消</button>' +
    '</div><div id="ckptVerify"></div></div>';
  pcScrollChat();
  const cancel = pcEl('ckptCancelBtn');
  if (cancel) cancel.onclick = () => ckptRenderEntry(true);
  const confirm = pcEl('ckptConfirmBtn');
  if (confirm) confirm.onclick = () => ckptDoRollback();
  ckptBusy = false;
}
async function ckptDoRollback() {
  const vbox = pcEl('ckptVerify');
  const confirm = pcEl('ckptConfirmBtn');
  if (confirm) { confirm.disabled = true; confirm.textContent = '回滚中…'; }
  const tid = planCurrent && planCurrent.task_id || '';
  try {
    // v1.9 M2.7 军规⑤ 后端闸门：先 confirmed=False 预检（后端返回
    // CONFIRM_REQUIRED+manifest=可回滚确认；绕过前端直调默认拒），
    // 通过后再 confirmed=True 执行——与清单态用户点击「确认回滚」两级确认
    const pre = JSON.parse((await pcCall(
      'checkpoint_rollback', [tid, '', false], 60000)) || '{}');
    if (pre && pre.ok === false && pre.error &&
        pre.error.code !== 'CONFIRM_REQUIRED') {
      if (vbox) vbox.innerHTML = '<div class="ckpt-verify err">回滚预检失败：' +
        pcEsc(pre.error.message || pre.error.code || '未知错误') + '</div>';
      return;
    }
    const raw = await pcCall('checkpoint_rollback', [tid, '', true], 60000);
    const d = JSON.parse(raw || '{}');
    if (vbox) {
      if (d && d.ok) {
        vbox.innerHTML = '<div class="ckpt-verify ok">已恢复至检查点（计划开始前）· 共 ' +
          pcEsc(String((d.restored || []).length)) + ' 个文件</div>';
      } else {
        // 失败形状原样呈现（后端透传 restored/failed，禁拍平——见 api.py 注释）
        const failed = (d && d.failed) || [];
        vbox.innerHTML = '<div class="ckpt-verify err">回滚未完全成功：' +
          pcEsc((d && d.error) || '部分文件恢复失败') +
          (failed.length ? ' · 失败 ' + pcEsc(String(failed.length)) + ' 个' : '') + '</div>';
      }
    }
  } catch (e) {
    if (vbox) vbox.innerHTML = '<div class="ckpt-verify err">回滚失败：' + pcEsc(e.message || e) + '</div>';
  } finally {
    if (confirm) { confirm.disabled = false; confirm.textContent = '确认回滚'; }
  }
}

function planCardReject() {
  const card = planCardEl;
  if (!card) return;
  card.style.transition = 'opacity var(--dur-comp-out) var(--ease-in-soft),transform var(--dur-comp-out) var(--ease-in-soft)';
  card.style.opacity = '0';
  card.style.transform = 'translateY(calc(-1 * var(--shift-comp)))';
  setTimeout(() => { card.remove(); if (planCardEl === card) planCardEl = null; }, pcCompOutMs());
  const r = planResolveApprove;
  planResolveApprove = null;
  if (r) r.reject(new DOMException('计划已被用户拒绝', 'AbortError'));
  pcToast('已拒绝计划 · 对话继续', 'info');
}

/** todo 步骤状态推进（agent loop 每个工具调用前后调用）。 */
function planStepStatus(index, status) {
  const card = planCardEl;
  if (!card || !planCurrent) return;
  const el = card.querySelector('.plan-step[data-i="' + index + '"]');
  if (!el) return;
  el.classList.remove('pending', 'doing', 'done', 'blocked', 'skipped');
  el.classList.add(status);
  if (planCurrent.steps && planCurrent.steps[index]) planCurrent.steps[index].status = status;
  if (planCurrent.task_id) {
    pcCall('plan_update', [planCurrent.task_id, '', index, status], 15000).catch(() => {});
  }
  planUiRevision++;
  if (card.__uiHost && !card.__uiHost.hidden) planGenerativeRender(card);
}

/** 终态摘要（ux-flows 流程 8 delivering → done/blocked）。 */
function planFinish(summaryText, finalStatus = 'done') {
  const card = planCardEl;
  if (!card || !planCurrent) return;
  const terminalStatus = finalStatus === 'blocked' ? 'blocked' : 'done';
  const blocked = terminalStatus === 'blocked';
  const badge = pcEl('planBadge');
  if (badge) {
    badge.className = 'plan-badge ' + terminalStatus;
    badge.textContent = blocked ? '有未决事项' : '已完成';
  }
  const sum = pcEl('planSummary');
  if (sum) {
    // 复核修正：弃内联 onclick（pcEsc 的 HTML 实体在内联事件 JS 字符串上下文
    // 会先解码回引号，可破串注入）——改 data 属性 + 闭包绑定
    sum.innerHTML = pcEsc(summaryText || '任务完成') +
      '<br><a class="plan-rollback" href="#">回滚到此任务前 →</a>';
    const _rb = sum.querySelector('.plan-rollback');
    if (_rb && planCurrent.task_id) {
      _rb.addEventListener('click', (ev) => {
        ev.preventDefault();
        ckptRollbackFlow(planCurrent.task_id);
      });
    }
    sum.classList.add('show');
  }
  card.style.opacity = '.82';
  if (planCurrent.task_id) {
    pcCall('plan_update', [planCurrent.task_id, terminalStatus], 15000).catch(() => {});
  }
  pcScrollChat();
  if (blocked) pcToast('任务结束 · 有未决事项', 'warn');
  else pcToast('任务完成 · 已生成交付摘要', 'ok');
  planUiRevision++;
  if (card.__uiHost && !card.__uiHost.hidden) planGenerativeRender(card);
}

/* ---------- 偏差暂停条（ux-flows 流程 8 偏差检测） ---------- */
let planResolveDev = null;
function planDeviationShow(desc) {
  // 复核修正：补 parentNode 判定——reject 动画窗口内 planCardEl 非 null
  // 但已 detach，原 insertBefore 对 null 父节点 TypeError 中断 agent loop
  if (typeof document === 'undefined' || !planCardEl || !planCardEl.parentNode) {
    return Promise.resolve('continue');
  }
  // 在途保护：旧偏差条仍挂起 → 以 'continue' 收尾（防 agent loop 双挂起）
  if (planResolveDev) {
    const old = planResolveDev;
    planResolveDev = null;
    try { old('continue'); } catch (e) {}
    const oldBar = pcEl('devBar');
    if (oldBar) oldBar.remove();
  }
  const bar = document.createElement('div');
  bar.className = 'dev-bar flash';
  bar.id = 'devBar';
  bar.innerHTML =
    '<span class="ic">⚠</span><span class="t">' + pcEsc(desc || '出现计划外操作') + '</span>' +
    '<span class="a">' +
    '<button class="pill-btn" data-act="continue">自适应继续</button>' +
    '<button class="pill-btn danger" data-act="stop">停止任务</button>' +
    '</span>';
  // 偏差条插在计划卡后（同一消息流容器）
  planCardEl.parentNode.insertBefore(bar, planCardEl.nextSibling);
  pcScrollChat();
  return new Promise(resolve => {
    planResolveDev = resolve;
    bar.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        const act = b.dataset.act;
        bar.style.transition = 'opacity var(--dur-panel-out) var(--ease-in-soft),transform var(--dur-panel-out) var(--ease-in-soft)';
        bar.style.opacity = '0';
        bar.style.transform = 'translateY(calc(-1 * var(--shift-panel)))';
        setTimeout(() => bar.remove(), pcCompOutMs());
        if (planResolveDev) { planResolveDev(act); planResolveDev = null; }
      };
    });
  });
}

/* ---------- 批量澄清表单（ux-flows 流程 9） ---------- */
let planResolveClarify = null;   // 挂起的澄清 resolve（在途保护用）
function clarifyShow(questions) {
  if (typeof document === 'undefined' || !planCardEl || !planCardEl.parentNode) {
    return Promise.resolve({});
  }
  // 复核修正：reject 动画窗口内 planCardEl 非 null 但已 detach——补 parentNode
  // 判定（原 insertBefore 对 null 父节点 TypeError 中断 agent loop 回调）
  // 在途保护：旧澄清表单仍挂起 → 以 {} 收尾并移除旧表单
  // （不移则两颗同 id 表单并存，getElementById 只会给旧表单接线）
  if (planResolveClarify) {
    const old = planResolveClarify;
    planResolveClarify = null;
    try { old({}); } catch (e) {}
    const oldForm = pcEl('clarifyCard');
    if (oldForm) oldForm.remove();
  }
  const qs = (questions || []).slice(0, 5);   // 协议上限 5 问
  const form = document.createElement('div');
  form.className = 'clr-form';
  form.id = 'clarifyCard';
  form.innerHTML =
    '<div style="font-size:12.5px;font-weight:600;margin-bottom:4px">需要澄清 ' + qs.length +
    ' 个问题（一次问完）</div>' +
    qs.map((q, i) =>
      '<div class="clr-q" style="animation-delay:' + i * 40 + 'ms">' +
      '<div class="q">' + (i + 1) + '. ' + pcEsc(q.q) +
      '<span class="def">默认：' + pcEsc((q.options || [])[q.default || 0] || '') + '</span></div>' +
      (q.options || []).map((o, j) =>
        '<button class="clr-opt' + (j === (q.default || 0) ? ' on' : '') +
        '" data-q="' + i + '" data-o="' + j + '" style="animation-delay:' + (60 + i * 40) + 'ms">' +
        pcEsc(o) + '</button>').join('') +
      '</div>').join('') +
    '<div class="clr-acts">' +
      '<button class="pill-btn primary" id="clrSubmit">按所选继续</button>' +
      '<button class="pill-btn" id="clrDefault">全按默认继续</button>' +
      '<span class="clr-limit">澄清轮次 1/2 · 上限 5 问</span>' +
    '</div>';
  planCardEl.parentNode.insertBefore(form, planCardEl.nextSibling);
  pcScrollChat();
  form.querySelectorAll('.clr-opt').forEach(b => {
    b.onclick = () => {
      form.querySelectorAll('.clr-opt[data-q="' + b.dataset.q + '"]').forEach(o => o.classList.remove('on'));
      b.classList.add('on');
    };
  });
  return new Promise(resolve => {
    planResolveClarify = resolve;
    const submit = (allDefault) => {
      const answers = {};
      if (allDefault) {
        // 全按默认：取各题 q.default（勿信 .on——用户可能改过选择）
        qs.forEach((q, i) => { answers[i] = (q.default || 0); });
      } else {
        form.querySelectorAll('.clr-opt.on').forEach(o => { answers[o.dataset.q] = o.dataset.o; });
      }
      form.querySelectorAll('.clr-q').forEach(q => q.style.opacity = '.55');
      form.style.transition = 'opacity var(--dur-comp-out) var(--ease-in-soft)';
      form.style.opacity = '0';
      setTimeout(() => form.remove(), pcCompOutMs());
      // 后端收集（缺项默认值）——失败也不阻断（本地同款兜底）
      pcCall('clarify_collect', [qs, answers], 15000)
        .then(raw => { try { resolve(JSON.parse(raw || '{}').resolved || []); } catch (e) { resolve([]); } })
        .catch(() => resolve([]));
    };
    const sb = pcEl('clrSubmit');
    if (sb) sb.onclick = () => submit(false);
    const df = pcEl('clrDefault');
    if (df) df.onclick = () => submit(true);
  });
}

/* ---------- 检查点与回滚（ux-flows 流程 10） ---------- */
function ckptShow(taskId, result) {
  if (typeof document === 'undefined' || !planCardEl) return;
  const modeTxt = result.mode === 'git' ? 'git HEAD 锚点' : (result.mode === 'snapshot' ? '文件快照' : '仅清单');
  const warn = (result.warnings && result.warnings.length)
    ? '<div class="ckpt-more">⚠ ' + pcEsc(result.warnings[0]) + '</div>' : '';
  const bar = document.createElement('div');
  bar.className = 'ckpt-prog done';
  bar.innerHTML =
    '<span class="ckpt-bar"><span class="ckpt-fill"></span></span>' +
    '<span class="ckpt-count">✓ 检查点就绪 · ' + pcEsc(modeTxt) +
    (result.snapshot_count ? ' · ' + result.snapshot_count + ' 个文件' : '') + '</span>';
  planCardEl.parentNode.insertBefore(bar, planCardEl.nextSibling);
  if (warn) {
    const w = document.createElement('div');
    w.innerHTML = warn;
    bar.parentNode.insertBefore(w.firstChild, bar.nextSibling);
  }
  pcScrollChat();
}

/** 回滚流程：清单 → inline 二次确认 → 执行 → 结果。 */
async function ckptRollbackFlow(taskId, host) {
  // host：浮层挂载容器（缺省=计划卡后；任务历史管理面板传自建容器）
  const anchor = (host && host.parentNode) ? host : planCardEl;
  let list = { files: [], mode: 'none' };
  try {
    const raw = await pcCall('checkpoint_list', [taskId], 15000);
    list = JSON.parse(raw || '{}');
  } catch (e) { /* 列表失败也允许尝试回滚 */ }
  if (!list.files || !list.files.length) {
    // git 锚点模式清单可能为空（reset 即恢复）——仍允许
    pcToast('检查点无文件清单（git 锚点模式将 reset 到任务前 HEAD）', 'info');
  }
  if (typeof document === 'undefined' || !anchor) return;
  const box = document.createElement('div');
  box.className = 'plan-card';
  box.style.marginTop = '10px';
  box.innerHTML =
    '<div class="plan-head"><span class="plan-badge pending">回滚确认</span>' +
    '<span class="plan-title">将恢复任务开始前的 ' + (list.files || []).length + ' 个文件（不可撤销）</span></div>' +
    '<div class="ckpt-list">' +
    (list.files || []).slice(0, 10).map(f =>
      '<div class="ckpt-row"><span class="f">' + pcEsc(f.path) + '</span><span class="s">待恢复</span></div>').join('') +
    ((list.files || []).length > 10 ? '<div class="ckpt-more">等 ' + (list.files || []).length + ' 个文件</div>' : '') +
    '</div>' +
    '<div class="plan-acts" id="rbActs">' +
      '<button class="pill-btn" id="rbCancel">取消</button>' +
      '<button class="pill-btn primary" id="rbConfirm">确认回滚</button>' +
    '</div>';
  anchor.parentNode.insertBefore(box, anchor.nextSibling);
  pcScrollChat();
  // 容器内查询（勿用全局 id——历史面板可能连续开多个回滚浮层）
  const cancel = box.querySelector('#rbCancel');
  if (cancel) cancel.onclick = () => box.remove();
  const confirm = box.querySelector('#rbConfirm');
  if (confirm) confirm.onclick = () => rbTwice(confirm, taskId, box);
}

function rbTwice(btn, taskId, box) {
  if (btn.dataset.armed) {
    if (btn._rbTimer) clearTimeout(btn._rbTimer);
    // 三连点防护：执行分支入口即卸武装 + 禁用——否则第三次点击会再进
    // armed 分支对同一任务重复发起 checkpoint_rollback（双回滚竞态）
    btn.dataset.armed = '';
    btn.disabled = true;
    btn.textContent = '恢复中…';
    const rows = box.querySelectorAll('.ckpt-row');
    // P0 复核修正：checkpoint_rollback 必须两段式（[tid,'',false] 预检 →
    // [tid,'',true] 执行，ckptDoRollback 同款）——原单参调用命中后端
    // confirm=False 默认拒（CONFIRM_REQUIRED），restored/failed 双空后
    // 仍 toast「回滚完成」= 假成功（实际什么都没回滚）
    pcCall('checkpoint_rollback', [taskId, '', false], 60000)
      .then(raw => {
        let pre = {};
        try { pre = JSON.parse(raw || '{}'); } catch (e) {}
        if (pre && pre.ok === false && pre.error &&
            pre.error.code !== 'CONFIRM_REQUIRED') {
          box.remove();
          pcToast('回滚预检失败：' + pcEsc(
            (pre.error && (pre.error.message || pre.error.code)) || '未知错误'), 'err');
          return null;
        }
        return pcCall('checkpoint_rollback', [taskId, '', true], 60000);
      })
      .then(raw => {
        if (!raw) return;
        let d = {};
        try { d = JSON.parse(raw || '{}'); } catch (e) {}
        const restored = d.restored || [];
        const failed = d.failed || [];
        rows.forEach((r, i) => setTimeout(() => {
          const p = r.querySelector('.f').textContent;
          // 精确匹配或后缀匹配（禁裸 indexOf 子串：'/a/b.txt' 会误中 '/x/a/b.txt.bak'）
          const okHit = restored.some(x => { const s = String(x); return s === p || s.endsWith(p); });
          const badHit = failed.some(x => { const s = String(x); return s === p || s.endsWith(p); });
          if (okHit) { r.classList.add('restored'); r.querySelector('.s').textContent = '已恢复'; }
          else if (badHit) { r.classList.add('failed'); r.querySelector('.s').textContent = '失败'; }
        }, i * 120));
        setTimeout(() => {
          box.remove();
          if (d.ok !== true) {
            pcToast('回滚未完全成功：' + pcEsc(
              (d.error && (d.error.message || d.error)) || '部分文件恢复失败'), 'err');
          } else if (failed.length) {
            pcToast('部分恢复成功（' + failed.length + ' 个失败，当前版已备份 .rollback-bak）', 'warn');
          } else {
            pcToast('回滚完成 · 已恢复到任务开始前状态', 'ok');
          }
        }, rows.length * 120 + 400);
      })
      .catch(e => {
        box.remove();
        pcToast('回滚请求失败：' + (e && e.message || e), 'err');
      });
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = '再次点击确认';
  btn.style.color = 'var(--err)';
  btn._rbTimer = setTimeout(() => {
    if (btn.dataset.armed) { btn.dataset.armed = ''; btn.textContent = '确认回滚'; btn.style.color = ''; }
  }, 3000);
}
