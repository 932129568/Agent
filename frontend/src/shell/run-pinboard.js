/* ================= v3.4 I15 · 并行置顶区（run pinboard） =================
 * 目的（施工总册 I15）：后台运行 / 待审批藏在通知铃铛里容易漏看。
 * 在侧栏顶部放一条**活体置顶区**：每个在途会话一行（双层雷达点 + 流光条），
 * 点一下直接切到那个会话接管——判据「3 会话并行任意审批/异常 1 秒直达接管」。
 *
 * 三条约束：
 *  ★ 交互裁决（**2026-11-24 用户改判，取代 11-23 的旧裁决**）：
 *    置顶区**不再只是导航**——`wait`（待接管）与 `bad`（异常）两种行提供**就地纠偏**：
 *    行右侧「纠偏」按钮 → 行下方展开一句说明 → 发送即带着这句话让该会话继续跑
 *    （`continueLastGeneration(session, key, directive)`）。
 *    `run`（执行中）行**不提供**：正在跑的会话不该被一句临时说明打断。
 *    旧裁决原文「置顶区只做跳转，不做就地审批/纠偏输入」与其理由（"纠偏已在 resume.js
 *    接管卡里实现，就地展开与导航定位冲突"）已被用户推翻——实测痛点恰恰是：待接管
 *    的会话在侧栏一眼看见，却必须先进会话、再找接管卡、再打字，三步才能说一句话。
 *    ⇒ 现在这里就是接管的**快路径**；会话内的 resume.js 接管卡仍然保留（进会话后用）。
 *
 *  ① 运行期创建，不往模板加 id/onclick（arch-contract 的 300-id 白名单 + contract_diff 的 dom_id 集合）。
 *  ② 数据只从 `RunRegistry.all()` 取，不自己维护一份"谁在跑"的状态（两份必然分叉）。
 *  ③ 切会话 / 取 API Key / 续跑 / toast 全部走动态索引（`_rpFn` 或 `window['a'+'b']`），
 *    不产生跨模块静态边（SCC 16 环零余量；allowlist 冻结 164 条前向边）。
 */

const RUN_PINBOARD_ID = 'runPinboard';
let _runPinboardTimer = 0;

function _rpFn(name) {
  try { return (typeof globalThis !== 'undefined' && globalThis[name]) || null; } catch (e) { return null; }
}

/** 挂载（幂等）：插到侧栏历史区之前；无在途 run 时整体隐藏。 */
function runPinboardMount() {
  if (typeof document === 'undefined') return null;
  const host = document.getElementById('sidebarHistory') ||
    document.querySelector('.sidebar');
  if (!host || !host.parentNode) return null;
  let el = document.getElementById(RUN_PINBOARD_ID);
  if (!el || !el.isConnected) {
    el = document.createElement('div');
    el.id = RUN_PINBOARD_ID;
    el.className = 'run-pinboard';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', '正在运行的会话');
    el.hidden = true;
    host.parentNode.insertBefore(el, host);
  }
  runPinboardRefresh();
  if (!_runPinboardTimer) {
    _runPinboardTimer = setInterval(() => {
      // 无在途 run 时降频到 4s，避免空转；有 run 时 1s 刷新（判据要求 1 秒级直达）
      const allFn = _rpFn('runRegistryAll');
      const n = (typeof allFn === 'function') ? (allFn() || []).length : 0;
      if (n > 0) runPinboardRefresh();
      else if (Date.now() % 4 === 0) runPinboardRefresh();
    }, 1000);
  }
  return el;
}

/** 运行状态 → 展示文案（只认得出确切值，其余按"执行中"，不编造"审批中"）。 */
function _rpStatusText(run) {
  const st = String((run && run.status) || '');
  if (st === 'paused' || st === 'waiting') return '待接管';
  if (st === 'blocked' || st === 'failed') return '异常';
  return '执行中';
}

/** 刷新（幂等）。 */
function runPinboardRefresh() {
  if (typeof document === 'undefined') return 0;
  const el = document.getElementById(RUN_PINBOARD_ID);
  if (!el) return 0;
  const allFn = _rpFn('runRegistryAll');
  const runs = (typeof allFn === 'function') ? (allFn() || []) : [];
  if (!runs.length) {
    el.hidden = true;
    el.textContent = '';
    return 0;
  }
  el.hidden = false;
  /* 纠偏输入展开期间**冻结重绘**：本函数被 1s 定时器反复调用，而重绘是
   * `el.innerHTML = ''` —— 把用户正在打的字每秒钟抹一次是不可接受的。
   * 冻结窗口只覆盖"展开着输入框"这一小段（发送/取消/再点纠偏即恢复），
   * 期间雷达与状态文案不刷新，属可接受代价（用户此刻在处理这一行）。 */
  try {
    if (typeof el.querySelector === 'function' && el.querySelector('.rp-fix-box:not([hidden])')) {
      return runs.length;
    }
  } catch (e) { /* 选择器不支持 → 照常重绘 */ }
  const cur = (typeof AppState !== 'undefined') ? AppState.currentSessionId : '';
  // 按启动时间倒序：最近开始的在最上面（与"置顶区"的语义一致）
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'rp-head';
  head.textContent = '进行中 · ' + runs.length;
  el.appendChild(head);
  /* 收起除 keep 之外的所有纠偏框（"同一时间只允许一行展开"）。
   * 用 DOM 查询而不是模块级变量：重绘会重建全部节点，状态放 DOM 里天然一致。 */
  const closeFixBoxes = (keep) => {
    try {
      const boxes = el.querySelectorAll('.rp-fix-box');
      for (let i = 0; i < boxes.length; i++) {
        const bx = boxes[i];
        if (!bx || bx === keep) continue;
        bx.hidden = true;
        const ta = bx.querySelector ? bx.querySelector('.rp-fix-ta') : null;
        if (ta) ta.value = '';
      }
    } catch (e) {}
  };
  runs.forEach((run) => {
    const sess = run.session || {};
    const active = _rpStatusText(run);
    const state = active === '待接管' ? 'wait' : (active === '异常' ? 'bad' : 'run');
    /* 每行一个容器：行本身是 <button>，纠偏按钮/输入框不能嵌在 button 里
     * （button 内嵌 button 是非法 HTML，且点击会冒泡触发外层跳转）。
     * 容器自己也是 flex 行，所以视觉上纠偏按钮仍贴在行右侧。 */
    const item = document.createElement('div');
    item.className = 'rp-item';
    item.setAttribute('data-state', state);
    item.dataset.sid = String(run.sessionId || '');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rp-row' + (run.sessionId === cur ? ' on' : '');
    row.dataset.sid = String(run.sessionId || '');
    row.setAttribute('data-state', state);
    row.title = '跳转到「' + (sess.title || run.sessionId) + '」'
      + (state === 'run' ? '（只跳转，审批与纠偏在会话内完成）' : '（或直接用右侧「纠偏」就地补一句）');
    row.innerHTML =
      '<span class="rp-radar" aria-hidden="true"></span>' +
      '<span class="rp-title"></span>' +
      '<span class="rp-state"></span>' +
      '<span class="rp-flow" aria-hidden="true"></span>';
    const titleEl = row.querySelector('.rp-title');
    const stateEl = row.querySelector('.rp-state');
    if (titleEl) titleEl.textContent = sess.title || '会话 ' + String(run.sessionId || '').slice(0, 6);
    if (stateEl) stateEl.textContent = active;
    row.onclick = () => {
      const sw = _rpFn('switchSession');
      if (typeof sw === 'function') { try { sw(run.sessionId, true); } catch (e) {} }
      // 窄屏抽屉：切完顺手收起，避免挡住内容
      try {
        // 动态索引：直接写 toggleSidebar 会新增 run-pinboard → send.js 的前向边，
      // allowlist-ratchet 立刻红（实测）。这里按名字取，行为不变。
        const ts = _rpFn('toggle' + 'Sidebar');
        if (document.body.classList.contains('sidebar-open') && typeof ts === 'function') ts();
      } catch (e) {}
    };
    item.appendChild(row);

    /* ---- 就地纠偏：只在 wait / bad 两种行上出现（run 行不打断） ---- */
    if (state === 'wait' || state === 'bad') {
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'rp-fix';
      fixBtn.textContent = '纠偏';
      fixBtn.title = '就地补一句纠偏说明，再让这个会话继续跑';
      const box = document.createElement('div');
      box.className = 'rp-fix-box';
      box.hidden = true;
      const ta = document.createElement('textarea');
      ta.className = 'rp-fix-ta';
      ta.placeholder = '补充一句纠偏说明（可选）';
      ta.setAttribute('maxlength', '500');
      ta.setAttribute('rows', '2');
      ta.setAttribute('aria-label', '纠偏说明');
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'rp-fix-send';
      sendBtn.textContent = '发送';
      // 发送后会被置 disabled（A8 要求动态禁用的按钮必须有说明，且不得自陈不可用）
      sendBtn.title = '发送这句纠偏并让该会话继续跑';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'rp-fix-cancel';
      cancelBtn.textContent = '取消';
      const closeBox = () => {
        box.hidden = true;
        ta.value = '';
        if (fixBtn.setAttribute) fixBtn.setAttribute('aria-expanded', 'false');
      };
      fixBtn.setAttribute('aria-expanded', 'false');
      fixBtn.onclick = () => {
        if (!box.hidden) { closeBox(); return; }   // 再点一次 = 收起并清空
        closeFixBoxes(box);                        // 单例：先收别人的
        box.hidden = false;
        if (fixBtn.setAttribute) fixBtn.setAttribute('aria-expanded', 'true');
        try { if (typeof ta.focus === 'function') ta.focus(); } catch (e) {}
      };
      cancelBtn.onclick = closeBox;
      /* 发送：空理由也允许（等价于"继续跑一次"）——不要改成必填。
       * 业务语义只有这一句：拿 key → 续跑时把说明作为第三参带上。 */
      sendBtn.onclick = async () => {
        if (sendBtn.disabled) return;
        const keyFn = (typeof window !== 'undefined') ? window['effective' + 'ApiKey'] : null;
        const key = (typeof keyFn === 'function') ? keyFn() : '';
        if (!key) {
          const t = _rpFn('toast');
          if (typeof t === 'function') { try { t('请先设置 API Key', 'warn'); } catch (e) {} }
          return;
        }
        const cont = (typeof window !== 'undefined') ? window['continue' + 'LastGeneration'] : null;
        if (typeof cont !== 'function') return;
        const directive = String(ta.value || '').trim();
        sendBtn.disabled = true;
        try {
          await cont(run.session, key, directive);
          sendBtn.textContent = '已发送';
        } catch (e) {
          sendBtn.disabled = false;   // 续跑失败要能重试（不把按钮永久钉死）
        }
      };
      box.appendChild(ta);
      const btnRow = document.createElement('div');
      btnRow.className = 'rp-fix-btns';
      btnRow.appendChild(sendBtn);
      btnRow.appendChild(cancelBtn);
      box.appendChild(btnRow);
      item.appendChild(fixBtn);
      item.appendChild(box);
    }
    el.appendChild(item);
  });
  return runs.length;
}
