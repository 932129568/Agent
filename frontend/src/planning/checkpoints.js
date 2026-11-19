/* ================= v1.8.0 · 任务历史与回滚管理（71-checkpoint-mgr.js） =================
 * 缺口：plan_list/checkpoint_list 有接口但无 UI 入口——检查点回滚此前只能通过
 * 当次计划卡的摘要链接进入，历史任务（或直接发送未走 /plan 的任务）无持久回滚入口。
 * 本模块在设置区注入「任务历史与回滚」块：计划列表（状态/标题/时间）+ 每项
 * 「回滚到此任务前」入口（复用 67-plan-card 的 ckptRollbackFlow，host 参数挂载）。
 * 纯新增 DOM（tm-* 类）；typeof 守卫保 vm 沙箱可测。
 */

function tmEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function tmEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function tmCall(name, args, timeout) {
  if (typeof callApi !== 'function') return Promise.reject(new Error('pywebview bridge 未就绪'));
  return callApi(name, args, timeout || 20000);
}

const TM_STATUS_BADGE = {
  planning: ['pending', '待批准'],
  approved: ['running', '已批准'],
  running: ['running', '执行中'],
  done: ['done', '已完成'],
  blocked: ['pending', '受阻']
};

/** 注入设置区块（幂等；110-boot 挂载，同 64/65/66 模式）。 */
function checkpointMgrInit() {
  if (typeof document === 'undefined') return false;
  if (tmEl('taskHistoryBlock')) { checkpointMgrRefresh(); return true; }
  const grid = document.querySelector('.set-grid');
  if (!grid) return false;
  const block = document.createElement('div');
  block.id = 'taskHistoryBlock';
  block.className = 'set-block';
  block.setAttribute('data-group', '数据与历史');
  block.dataset.group = '数据与历史';
  block.innerHTML =
    '<div class="set-title">任务历史与回滚</div>' +
    '<div class="set-hint" style="margin:2px 0 8px;">' +
      '每个 /plan 任务开始前都会自动创建检查点（git HEAD 锚点或文件快照）。' +
      '可随时回滚到任务开始前的状态；回滚采用 inline 二次确认，当前版本会先备份为 ' +
      '<code>.rollback-bak</code>。' +
    '</div>' +
    '<div class="provider-row" style="align-items:center;gap:8px;">' +
      '<button type="button" class="modal-btn" id="tmRefreshBtn">↻ 刷新</button>' +
      '<span id="tmCount" style="font-size:11.5px;color:var(--text-3);font-family:var(--font-mono);"></span>' +
    '</div>' +
    '<div class="tm-list" id="tmList"></div>';
  grid.appendChild(block);
  const btn = tmEl('tmRefreshBtn');
  if (btn) btn.addEventListener('click', () => checkpointMgrRefresh());
  checkpointMgrRefresh();
  return true;
}

async function checkpointMgrRefresh() {
  const box = tmEl('tmList');
  const cnt = tmEl('tmCount');
  if (!box) return;
  box.innerHTML = '<div class="tm-empty"><span class="load-dot"></span>读取中…</div>';
  let plans = [];
  try {
    const raw = await tmCall('plan_list', [20], 15000);
    const d = JSON.parse(raw || '{}');
    plans = (d && d.ok && Array.isArray(d.plans)) ? d.plans : [];
  } catch (e) {
    box.innerHTML = '<div class="tm-empty">读取失败：' + tmEsc(e && e.message || e) + '</div>';
    return;
  }
  if (cnt) cnt.textContent = '共 ' + plans.length + ' 个任务';
  if (!plans.length) {
    box.innerHTML = '<div class="tm-empty">暂无任务记录。用 <code>/plan 任务描述</code> 让 Agent 先出计划再执行，即会自动创建检查点。</div>';
    return;
  }
  box.innerHTML = '';
  plans.forEach(p => {
    const row = document.createElement('div');
    row.className = 'tm-row';
    const badge = TM_STATUS_BADGE[p.status] || ['pending', p.status || '未知'];
    row.innerHTML =
      '<span class="plan-badge ' + badge[0] + '">' + tmEsc(badge[1]) + '</span>' +
      '<span class="tm-title" title="' + tmEsc(p.title || '') + '">' + tmEsc(p.title || p.task_id) + '</span>' +
      '<span class="tm-time">' + tmEsc(String(p.created_at || '').replace('T', ' ').slice(0, 16)) + '</span>' +
      '<button type="button" class="modal-btn tm-rb" data-tid="' + tmEsc(p.task_id) + '">回滚</button>';
    box.appendChild(row);
  });
  box.querySelectorAll('.tm-rb').forEach(btn => {
    btn.addEventListener('click', () => {
      const tid = btn.getAttribute('data-tid');
      if (typeof ckptRollbackFlow === 'function') ckptRollbackFlow(tid, btn);
      else if (typeof toast === 'function') toast('回滚组件未加载', 'err');
    });
  });
}
