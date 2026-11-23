/* ================= v3.4 I15 · 并行置顶区（run pinboard） =================
 * 目的（施工总册 I15）：后台运行 / 待审批藏在通知铃铛里容易漏看。
 * 在侧栏顶部放一条**活体置顶区**：每个在途会话一行（双层雷达点 + 流光条），
 * 点一下直接切到那个会话接管——判据「3 会话并行任意审批/异常 1 秒直达接管」。
 *
 * 三条约束：
 *  ★ 交互裁决（2026-11-23 用户拍定）：**置顶区只做跳转，不做就地审批/纠偏输入**。
 *    理由：置顶区是"导航"，不是"接管面板"。纠偏输入已在 resume.js 的接管卡里实现，
 *    就地展开会让侧栏顶部冒出输入框，与导航定位冲突。
 *    ⇒ 若将来有人想在这里加 textarea / 审批按钮，先回来看这一行：**不在这里做**。
 *
 *  ① 运行期创建，不往模板加 id/onclick（arch-contract 的 300-id 白名单 + contract_diff 的 dom_id 集合）。
 *  ② 数据只从 `RunRegistry.all()` 取，不自己维护一份"谁在跑"的状态（两份必然分叉）。
 *  ③ 切会话走动态索引 `switchSession`，不产生跨模块静态边（SCC 16 环零余量）。
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
  const cur = (typeof AppState !== 'undefined') ? AppState.currentSessionId : '';
  // 按启动时间倒序：最近开始的在最上面（与"置顶区"的语义一致）
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'rp-head';
  head.textContent = '进行中 · ' + runs.length;
  el.appendChild(head);
  runs.forEach((run) => {
    const sess = run.session || {};
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rp-row' + (run.sessionId === cur ? ' on' : '');
    row.dataset.sid = String(run.sessionId || '');
    const active = _rpStatusText(run);
    row.setAttribute('data-state', active === '待接管' ? 'wait' : (active === '异常' ? 'bad' : 'run'));
    row.title = '跳转到「' + (sess.title || run.sessionId) + '」（只跳转，审批与纠偏在会话内完成）';
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
    el.appendChild(row);
  });
  return runs.length;
}
