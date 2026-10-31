/* ================= 安全护栏（v1.2 R2）：确认矩阵前端拦截 + 设置 UI =================
 * 覆盖操作：delete_path / kill_process / clipboard_write / clipboard_read / take_screenshot
 *   + run_command / run_powershell / run_admin_command（修复 S4②：三个命令执行 op 纳入
 *   前端确认矩阵；默认 off 档 → 行为不变，用户提档加固时确认框才会出现）。
 * 三档：always（每次确认）/ list（保护名单）/ session（会话内首次确认）；off 不拦截。
 * 后端 guard_check 负责名单匹配与审计；本模块负责弹窗（复用 18-toast 的 uiConfirm）。
 *
 * 修复 S4①（confirm-token 前端接线）：确认框「允许」后先调后端 guard_confirm_token(op, detail)
 * 换取一次性 token（TTL 60s、绑定 op+detail 摘要），再携带 token 调实际 op——武装后的后端
 * 执行点（enforce_exec）只认 token/会话信任，前端确认不再是唯一防线。
 * 「本会话内不再提示」勾选 → guard_session_trust(op) 登记后端会话信任（切会话自动清空）。
 */

const GUARD_OP_MAP = {
  delete_path: 'delete_path',
  kill_process: 'kill_process',
  clipboard_write: 'clipboard_write',
  clipboard_read: 'clipboard_read',
  take_screenshot: 'take_screenshot',
  run_command: 'run_command',
  run_powershell: 'run_powershell',
  run_admin_command: 'run_admin_command',
  open_app: 'open_app'   // 修复 H8（四轮）：后端 W9 已纳入护栏矩阵，前端补映射——原缺位致提档即砖
};
const GUARD_OP_LABEL = {
  delete_path: '删除文件/目录', kill_process: '结束进程',
  clipboard_write: '写入剪贴板', clipboard_read: '读取剪贴板', take_screenshot: '屏幕截图',
  run_command: '执行命令', run_powershell: '执行 PowerShell', run_admin_command: '管理员命令',
  open_app: '打开应用/链接',
  // v1.9.0 M5：浏览器驱动六原语（审计查看器人话 op 名；拦截走 agentGuardCheck 分发支）
  browser_navigate: '浏览器导航', browser_extract: '页面提取',
  browser_click: '页面点击', browser_fill: '表单填充',
  browser_screenshot: '页面截图', browser_close: '关闭浏览器会话',
  web_search: '浏览器搜索', software_call: '外部软件调用'
};
const GUARD_RUN_OPS = ['run_command', 'run_powershell', 'run_admin_command'];

async function _guardDetailOf(op, args) {
  args = args || {};
  const d = {};
  // 修复 S4①：detail 必须与执行点传参同源（后端按 op+detail 摘要绑定 token）
  if (op === 'delete_path') d.path = args.path || args.file_path || args.filename || args.file || args.target || args.src || '';
  if (op === 'kill_process') { d.pid = args.pid != null ? args.pid : ''; d.name = args.name || ''; }
  if (op === 'clipboard_write') { d.len = (args.text || '').length; d.head = (args.text || '').slice(0, 40); }
  // 修复 M3（四轮）：cmd 取值与执行层 pickCmd 完全同口径——原对 cmd=''/'  ' 空白串
  // 不回退 command，确认框可显示空命令而实际执行 args.command（token 摘要也与实参脱钩）
  if (GUARD_RUN_OPS.includes(op)) {
    const _c = (args.cmd != null) ? String(args.cmd) : '';
    d.cmd = _c.trim() ? _c : String(args.command || '');
  }
  if (op === 'open_app') d.path = String(args.path || args.file_path || args.filename || args.target || '').trim();
  return d;
}

async function _guardDescribe(op, args) {
  args = args || {};
  const d = await _guardDetailOf(op, args);
  if (op === 'delete_path') {
    let sizeTxt = '';
    try {
      const r = JSON.parse(await callApi('get_file_info', [d.path]));
      if (r && r.size != null) sizeTxt = '（' + (r.size > 1048576 ? (r.size / 1048576).toFixed(1) + ' MB' : r.size + ' B') + '）';
    } catch (e) {}
    const recycle = args.recycle !== false;
    return { title: '确认删除', body: 'AI 请求删除：\n' + d.path + sizeTxt +
      '\n去向：' + (recycle ? '回收站（可恢复）' : '永久删除（不可恢复）'), danger: true };
  }
  if (op === 'kill_process')
    return { title: '确认结束进程', body: 'AI 请求结束进程：\n' + (d.name || 'pid=' + d.pid) +
      '\n未保存的数据将丢失。', danger: true };
  if (op === 'clipboard_write')
    return { title: '确认写入剪贴板', body: 'AI 请求写入剪贴板（' + d.len + ' 字符）：\n「' + d.head + '」\n将覆盖你当前的剪贴板内容。', danger: false };
  if (op === 'clipboard_read')
    return { title: '确认读取剪贴板', body: 'AI 请求读取你的剪贴板内容。\n剪贴板可能含敏感信息（密码/隐私文本）。', danger: false };
  if (op === 'take_screenshot')
    return { title: '确认屏幕截图', body: 'AI 请求截取当前屏幕。\n截图中可能包含你的其他窗口内容。', danger: false };
  if (op === 'run_command')
    return { title: '确认执行命令', body: 'AI 请求执行命令：\n' + String(d.cmd || '').slice(0, 400), danger: true };
  if (op === 'run_powershell')
    return { title: '确认执行 PowerShell', body: 'AI 请求执行 PowerShell：\n' + String(d.cmd || '').slice(0, 400), danger: true };
  if (op === 'run_admin_command')
    return { title: '确认管理员命令', body: 'AI 请求以管理员权限执行：\n' + String(d.cmd || '').slice(0, 400) +
      '\n该命令将以系统管理员权限运行，风险较高。', danger: true };
  if (op === 'open_app')   // 修复 H8（四轮）：确认文案（原走兜底「确认操作」）
    return { title: '确认打开', body: 'AI 请求打开：\n' + String(d.path || '').slice(0, 300) +
      '\n将使用系统默认程序打开（bat/cmd 脚本会弹出控制台窗口）。', danger: true };
  return { title: '确认操作', body: op, danger: false };
}

/**
 * 护栏拦截入口（executeToolRaw 头部调用）。
 * 返回 {blocked, token}：
 *   blocked 为 null → 放行；blocked 为 JSON 字符串 → 拦截结果（直接作为工具结果返回给 AI）；
 *   token → 修复 S4①：用户「允许」后从后端换取的一次性 confirm token（携带调实际 op）。
 */
async function guardCheckTool(name, args) {
  const op = GUARD_OP_MAP[name];
  if (!op) return { blocked: null, token: null };
  args = args || {};
  // 会话内已信任：直接放行（后端持有同一会话信任态；名单仍会在 delete/kill 上兜底强制）
  if (guardTrusted.has(op)) return { blocked: null, token: null };
  // 修复 ③（三轮）：off 档本地短路——boot 已加载 guardConfig（110-boot loadGuardConfig），
  // 该 op 档位为 off 且无保护名单语义时不再发 guard_check RPC（原每个受护栏命令一次往返，
  // guard 全 off 时纯属浪费）。delete_path/kill_process 的保护名单 block 在后端优先于
  // 档位（guard_service.check 名单先行），仍走 RPC 保底；guardConfig 未加载（null）时
  // 保守走 RPC 由后端定档，行为不回退。
  if (guardConfig && guardConfig.tiers && guardConfig.tiers[op] === 'off'
      && op !== 'delete_path' && op !== 'kill_process') {
    return { blocked: null, token: null };
  }
  const detail = await _guardDetailOf(op, args);
  let verdict = { action: 'confirm' };
  try {
    const raw = await callApi('guard_check', [op, JSON.stringify(detail)]);
    verdict = JSON.parse(raw) || {};
  } catch (e) {
    // 后端不可用（旧 exe）：退回默认档位（delete/kill/clipboard_write 确认，其余放行）
    if (op !== 'delete_path' && op !== 'kill_process' && op !== 'clipboard_write') return { blocked: null, token: null };
  }
  if (verdict.action === 'block') {
    const reason = verdict.reason || '该操作命中保护名单，已被拒绝。';
    toast(reason, 'warn');
    return { blocked: JSON.stringify({ info: reason, skipped: true }), token: null };
  }
  if (verdict.action !== 'confirm') return { blocked: null, token: null };    // allow → 放行
  const desc = await _guardDescribe(op, args);
  const r = await uiConfirm({
    title: desc.title, body: desc.body, danger: desc.danger,
    okText: desc.danger ? '允许执行' : '允许',
    checkboxLabel: '本会话内不再提示「' + GUARD_OP_LABEL[op] + '」',
    // 修复 UX-2（v1.4）：第二勾选=永久信任（op 级，写 guard.json trustedOps，重启仍生效）
    checkboxLabel2: '永久信任此操作（重启后仍不再确认，可在设置→安全护栏重置）'
  });
  try {
    callApi('guard_audit', [op, JSON.stringify(detail),
      r.ok ? (r.checked2 ? 'trust-persistent' : (r.checked ? 'session-trust' : 'allow')) : 'deny']).catch(() => {});
  } catch (e) {}
  if (!r.ok) {
    const msg = '用户拒绝了本次' + GUARD_OP_LABEL[op] + '操作。请调整方案或询问用户意图，不要原样重试。';
    toast('已拒绝 AI 的' + GUARD_OP_LABEL[op] + '请求', 'ok');
    return { blocked: JSON.stringify({ info: msg, skipped: true }), token: null };
  }
  // 修复 S4①：同意后换取一次性 confirm token（TTL 60s，绑定 op+detail 摘要），执行点携带
  let token = null;
  try {
    const t = JSON.parse(await callApi('guard_confirm_token', [op, JSON.stringify(detail)]));
    if (t && t.token) token = t.token;
  } catch (e) { /* 旧 exe 无此方法：token 留空，按 legacy 行为直调（新后端会强制拦截并返回人话错误） */ }
  if (r.checked) {
    // 修复（对抗复审，与 25-tool-exec agentTrusted 同口径）：原 fire-and-forget
    // 登记——失败时前端已信任、后端未登记，后续调用被前端短路（不弹窗、无
    // token）→ 后端 enforce_exec 武装态拒（CONFIRM_REQUIRED）→ AI 重试再被拒
    // 的死循环。改 await 登记，成功才进前端 Set。
    try {
      await callApi('guard_session_trust', [op], 20000);
      guardTrusted.add(op);
    } catch (e) { /* 登记失败：不进前端信任——下次仍走确认弹窗 */ }
  }
  // 修复 UX-2（v1.4）：永久信任落库（guard.json trustedOps，op 级）——读-改-写经
  // guard_save_config（既有 js_api，无新方法）；首次启用弹风险文案（PRD 验收）
  if (r.ok && r.checked2) await _trustPersistently(op);
  return { blocked: null, token };
}

/** 修复 UX-2（v1.4）：把 op 加入持久信任集（guard.json trustedOps）。失败不阻塞主流程。 */
async function _trustPersistently(op) {
  try {
    let cfg = {};
    try { cfg = JSON.parse(await callApi('guard_get_config', [])) || {}; } catch (e) { cfg = {}; }
    const list = Array.isArray(cfg.trustedOps) ? cfg.trustedOps.slice() : [];
    const firstTime = !list.includes(op);
    if (!list.includes(op)) list.push(op);
    cfg.trustedOps = list;
    const r = JSON.parse(await callApi('guard_save_config', [JSON.stringify(cfg)]));
    if (r && r.error) { toast('永久信任保存失败: ' + r.error, 'err'); return; }
    if (firstTime) {
      // 首次永久信任：明示风险（PRD：重启后该类操作仍不再确认）
      toast('已开启「' + GUARD_OP_LABEL[op] + '」永久信任：重启后该类操作仍不再确认。' +
            '如需恢复，设置 → 安全护栏 → 重置全部信任。', 'warn', { stay: true });
    } else {
      toast('已信任「' + GUARD_OP_LABEL[op] + '」', 'ok');
    }
  } catch (e) {
    toast('永久信任保存失败: ' + e.message, 'err');
  }
}

/** 修复 UX-2（v1.4）：重置全部持久信任（设置面板入口，二次确认）。 */
async function resetAllGuardTrust() {
  const r = await uiConfirm({
    title: '重置全部信任', body: '将清空所有「永久信任」的操作（本会话信任随重启自然失效）。\n之后每次危险操作都会重新确认。',
    danger: true, okText: '全部重置'
  });
  if (!r.ok) return;
  try {
    let cfg = {};
    try { cfg = JSON.parse(await callApi('guard_get_config', [])) || {}; } catch (e) { cfg = {}; }
    cfg.trustedOps = [];
    const rr = JSON.parse(await callApi('guard_save_config', [JSON.stringify(cfg)]));
    if (rr && rr.error) { toast('重置失败: ' + rr.error, 'err'); return; }
    toast('已重置全部持久信任', 'ok');
  } catch (e) {
    toast('重置失败: ' + e.message, 'err');
  }
}

/* ---- 护栏设置 UI（工作区面板「安全护栏」区块） ---- */
async function loadGuardConfig() {
  try {
    guardConfig = JSON.parse(await callApi('guard_get_config', [])) || null;
  } catch (e) { guardConfig = null; }
  renderGuardSettings();
}
function renderGuardSettings() {
  if (!guardConfig) return;
  const ops = [
    ['delete_path', '删除文件/目录'], ['kill_process', '结束进程'],
    ['clipboard_write', '写剪贴板'], ['clipboard_read', '读剪贴板'], ['take_screenshot', '截屏'],
    ['run_command', '执行命令'], ['run_powershell', 'PowerShell'], ['run_admin_command', '管理员命令'],
    ['open_app', '打开应用/链接']   // 修复 H8（四轮）：档位 UI 补行
  ];
  const tierName = { always: '每次确认', list: '仅保护名单', session: '会话内首次确认', off: '不拦截' };
  ops.forEach(([op, label]) => {
    const sel = document.getElementById('guard_' + op);
    if (sel) sel.value = (guardConfig.tiers || {})[op] || 'always';
  });
  const pp = document.getElementById('guardProtectPaths');
  if (pp) pp.value = (guardConfig.protect_paths || []).join('\n');
  const pc = document.getElementById('guardProtectProcs');
  if (pc) pc.value = (guardConfig.protect_processes || []).join('\n');
  // 修复 UX-2（v1.4）：持久信任状态展示（op 级；空态明示未开启）
  const ts = document.getElementById('guardTrustState');
  if (ts) {
    const list = (guardConfig.trustedOps || []).filter(op => GUARD_OP_LABEL[op]);
    ts.textContent = list.length
      ? '已永久信任：' + list.map(op => GUARD_OP_LABEL[op]).join('、')
      : '持久信任：未开启（确认框勾选「永久信任此操作」后生效）';
  }
}
async function saveGuardSettings() {
  if (!guardConfig) guardConfig = { tiers: {}, protect_paths: [], protect_processes: [] };
  guardConfig.tiers = guardConfig.tiers || {};
  Object.keys(GUARD_OP_LABEL).forEach(op => {
    const sel = document.getElementById('guard_' + op);
    if (sel) guardConfig.tiers[op] = sel.value;
  });
  const pp = document.getElementById('guardProtectPaths');
  guardConfig.protect_paths = (pp ? pp.value : '').split('\n').map(s => s.trim()).filter(Boolean);
  const pc = document.getElementById('guardProtectProcs');
  guardConfig.protect_processes = (pc ? pc.value : '').split('\n').map(s => s.trim()).filter(Boolean);
  try {
    const r = JSON.parse(await callApi('guard_save_config', [JSON.stringify(guardConfig)]));
    if (r && r.error) toast('护栏配置保存失败: ' + r.error, 'err');
    else toast('安全护栏配置已保存', 'ok');
  } catch (e) {
    toast('护栏配置保存失败: ' + e.message, 'err');
  }
}

/* ---- v1.9.0 M2.4/2.5（grant-budget）：审批预算超限 → 任务授权邀请 ----
 * 设计 §A3.5 前端契约：工具结果含 error.code=APPROVAL_BUDGET_EXCEEDED 时
 * 不弹逐项确认，弹「任务授权邀请」（一次性授予 suggest_scopes，复用
 * guard_task_grant）；授予后原操作以 grant 放行（不计预算）；拒绝则给
 * AI 人话（调整方案/请用户提额）。 */
async function maybeBudgetInvite(resJson) {
  let d = null;
  try { d = JSON.parse(resJson); } catch (e) { return resJson; }
  const err = d && d.error;
  if (!err || err.code !== 'APPROVAL_BUDGET_EXCEEDED') return resJson;
  const scopes = Array.isArray(err.suggest_scopes) ? err.suggest_scopes : [];
  const used = err.used != null ? err.used : '?';
  const limit = err.limit != null ? err.limit : '?';
  const r = await uiConfirm({
    title: '审批预算已达上限（' + used + '/' + limit + '）',
    body: (err.message || '本会话确认次数已达上限。') +
      '\n\n已升级为任务授权邀请：授予后同类操作在授权期内放行（不再逐项确认）。' +
      (scopes.length ? '\n授权范围：' + scopes.join('、') : '') +
      '\n也可稍后在 设置 → 安全与授权 调整预算上限（guard_approval_budget）。',
    danger: true,
    okText: scopes.length ? '授予任务授权' : '知道了'
  });
  if (r.ok && scopes.length) {
    try {
      const g = JSON.parse(await callApi('guard_task_grant', [scopes, 7200], 20000));
      if (g && !g.error) {
        toast('任务授权已授予（' + scopes.join('、') + '）——同类操作授权期内放行', 'ok');
        renderGrantBudgetBar();
        return JSON.stringify({ info: '用户已授予任务授权（' + scopes.join('、') +
          '）。请重试原操作——授权覆盖内将直接放行，不再逐项确认。', retry_hint: true });
      }
      toast('任务授权授予失败：' + ((g && g.error) || '未知错误'), 'err');
    } catch (e) { toast('任务授权授予失败: ' + (e.message || e), 'err'); }
  }
  return JSON.stringify({
    info: '审批预算已达上限（' + used + '/' + limit + '），用户未授予任务授权。' +
      '请调整方案减少需要确认的操作，或请用户在设置中调高预算上限。',
    skipped: true
  });
}

/* ---- v1.9.0 M2.5：预算指示条（授权条内嵌 mono「审批 3/5」+ dot 格） ----
 * grant-budget 原型移植（最小接线）：挂 #grantIndicator 首位；used≥limit 或
 * escalated → .over（err 色，title 提示任务授权）；limit>10 时不渲染 dot 格。 */
async function renderGrantBudgetBar() {
  if (typeof document === 'undefined') return;
  const ind = document.getElementById('grantIndicator');
  if (!ind) return;
  let bar = document.getElementById('grantBudgetBar');
  if (!bar) {
    bar = document.createElement('span');
    bar.id = 'grantBudgetBar';
    bar.className = 'grant-budget';
    ind.insertBefore(bar, ind.firstChild);
  }
  try {
    const b = JSON.parse(await callApi('guard_approval_budget', [], 20000));
    if (!b || b.error) { bar.style.display = 'none'; return; }
    const used = Math.max(0, parseInt(b.used || 0, 10));
    const limit = Math.max(1, parseInt(b.limit || 1, 10));
    const over = b.escalated === true || used >= limit;
    let html = '';
    if (limit <= 10) {
      for (let i = 0; i < limit; i++)
        html += '<i class="' + (i < used ? 'on' : '') + '"></i>';
    }
    bar.className = 'grant-budget' + (over ? ' over' : '');
    bar.innerHTML = html + '<b>' + used + '/' + limit + '</b>';
    bar.title = over
      ? '审批预算已达上限——后续确认将升级为任务授权邀请'
      : '会话审批预算 ' + used + '/' + limit + '（设置 → 安全与授权 可调）';
    bar.style.display = '';
  } catch (e) { bar.style.display = 'none'; }
}
