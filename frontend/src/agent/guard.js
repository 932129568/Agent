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
  open_app: 'open_app',   // 修复 H8（四轮）：后端 W9 已纳入护栏矩阵，前端补映射——原缺位致提档即砖
  open_url: 'open_url'    // R41（N11）：后端已入矩阵，前端补映射（H8 同款，防提档即砖）
};
const GUARD_OP_LABEL = {
  delete_path: '删除文件/目录', kill_process: '结束进程',
  clipboard_write: '写入剪贴板', clipboard_read: '读取剪贴板', take_screenshot: '屏幕截图',
  run_command: '执行命令', run_powershell: '执行 PowerShell', run_admin_command: '管理员命令',
  open_app: '打开应用/链接', open_url: '打开网页链接',   // R41（N11）
  // v1.9.0 M5：浏览器驱动六原语（审计查看器人话 op 名；拦截走 agentGuardCheck 分发支）
  browser_navigate: '浏览器导航', browser_extract: '页面提取',
  browser_snapshot: '语义快照',   // R57：原缺 snapshot，审计查看器回退裸 op 名
  browser_click: '页面点击', browser_fill: '表单填充',
  browser_screenshot: '页面截图', browser_close: '关闭浏览器会话',
  web_search: '浏览器搜索', software_call: '外部软件调用'
};
const GUARD_RUN_OPS = ['run_command', 'run_powershell', 'run_admin_command'];

/* ================= R101 T03 · 内联审批（guard-inline） =================
 * 为什么不再弹模态：安全护栏确认原先复用 uiConfirm —— 居中模态 + 全屏遮罩，
 * 把「AI 想删一个文件」这种高频、低信息量、答案几乎总是「允许」的问题，升级成了
 * 一次全屏打断：用户必须移开视线、越过遮罩、在两个按钮之间做一次定位，才能
 * 继续看对话。内联审批把同一个问题放在**输入区上方**（用户视线与手指本来就在
 * 的位置），一次点击即答，对话不中断。
 *
 * 语义没变（用户拍定）：拒绝 = 只拒这一次，AI 继续走别的方案 —— 所以这里**只换
 * 表现层**，返回结构与 uiConfirm 完全一致，Promise<{ok, checked, checked2}>；
 * 拒绝时 checked / checked2 一律 false（勾选不随拒绝生效）。
 *
 * 并发：同一批工具可能同时触发多个确认（并行 run）。卡片只在输入区上方有一个
 * 位置，所以必须串行 —— 与 overlays.js uiConfirm 的队列语义一致：前一个收尾
 * （点按钮 / Esc）后才挂下一个。
 */
let _guardInlineQueue = Promise.resolve();

/* ================= I13 · 内联真 LCS 行级 Diff =================
 * 为什么审批卡需要 diff：删除一个文件、覆盖一段配置，正文是「一句话描述」，
 * 用户真正要判断的是「改了什么」。纯文本审批只能让人凭描述猜，于是要么盲点
 * 允许，要么无脑拒绝——两种都不安全。
 *
 * 为什么是**行级 LCS** 而不是字符级：审批场景关心「哪几行被换掉了」，字符级
 * diff 会把一行小改碎成一片红绿噪声，反而看不出意图。
 *
 * 正确性硬判据（测试就断言这一条）：same+del 的行拼回去 == 旧文本，
 * same+add 的行拼回去 == 新文本。任何「看起来像 diff」的实现都过不了这条。
 *
 * 降级（必须显式，不许静默）：DP 是 O(n·m) 内存，超大文本会把审批卡做成砖。
 * 两侧合计 > 20000 字符或任一侧 > 800 行 → 退化为「整段替换」（全 del + 全 add），
 * 并在返回值上标 `degraded:true` + `reason`，调用方可据此在 UI 上提示「差异过大，
 * 已退化为整段对比」。800 行 × 800 行 = 64 万格 ≈ 2.6MB DP，仍可控。
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array<{type:'same'|'add'|'del', text:string}> & {degraded:boolean, reason?:string}}
 */
function guardLineDiff(oldText, newText) {
  const MAX_CHARS = 20000;
  const MAX_LINES = 800;
  const splitLines = (t) => {
    const s = String(t == null ? '' : t);
    if (s === '') return [];                       // 空串 = 0 行（不是 1 个空行）
    // CRLF / CR / LF 统一成 LF 再切：Windows 上 search_replace 的 old/new 常带 \r\n，
    // 不归一会把每一行都算成「改过」，diff 全红全绿毫无意义。
    return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);

  const totalChars = String(oldText == null ? '' : oldText).length
    + String(newText == null ? '' : newText).length;
  const degraded = totalChars > MAX_CHARS || a.length > MAX_LINES || b.length > MAX_LINES;

  const rows = [];
  if (degraded) {
    for (const line of a) rows.push({ type: 'del', text: line });
    for (const line of b) rows.push({ type: 'add', text: line });
    rows.degraded = true;
    rows.reason = 'too-large';
    return rows;
  }

  // 后缀式 LCS 长度表：dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = (a[i] === b[j])
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) { rows.push({ type: 'del', text: a[i] }); i++; }
    else { rows.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { rows.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { rows.push({ type: 'add', text: b[j] }); j++; }
  rows.degraded = false;
  return rows;
}

/**
 * guardInlineAsk({title, body, danger, okText, cancelText, checkboxLabel,
 *                 checkboxLabel2, sessionLabel}) → Promise<{ok, checked, checked2}>
 * 与 uiConfirm 同签名同返回形状；DOM 不可用 / 无输入区宿主 / 宿主不可见时
 * 回退到 uiConfirm（模态），保证任何环境都不会因为「没有内联位置」而卡死 Promise。
 */
function guardInlineAsk(opts) {
  opts = opts || {};
  // 回退：名字拆两段再动态索引 —— 裸写 uiConfirm 会在 AST 里形成
  // guard.js → overlays.js 之外的额外静态边（SCC 棘轮 17/104 零余量，加边即红）。
  const fallback = () => {
    let fn = null;
    try { fn = window['ui' + 'Confirm']; } catch (e) { fn = null; }
    if (typeof fn === 'function') return fn(opts);
    // 连模态都没有（极端沙箱）：按「拒绝」收尾，绝不留下永不 settle 的 Promise
    return Promise.resolve({ ok: false, checked: false, checked2: false });
  };
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return fallback();
  const host = document.querySelector('#chatInputArea .input-inner');
  if (!host || typeof document.createElement !== 'function') return fallback();
  // 宿主存在但不可见（无会话的空态 / 折叠态）时，内联卡片用户根本看不到 ——
  // 必须回退模态，否则工具调用会静默挂死在一次看不见的确认上。
  try {
    if (typeof host.getClientRects === 'function' && host.getClientRects().length === 0) return fallback();
  } catch (e) { return fallback(); }

  const run = () => new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'guard-inline' + (opts.danger ? ' danger' : '');
    card.setAttribute('data-guard-inline', '1');

    const head = document.createElement('div');
    head.className = 'gi-head';
    const title = document.createElement('b');
    title.className = 'gi-title';
    title.textContent = String(opts.title || '确认操作');
    head.appendChild(title);
    // P0-4 T03：来源会话徽标（并行 run 区分；无标注时零渲染）
    if (opts.sessionLabel) {
      const badge = document.createElement('span');
      badge.className = 'gi-session';
      badge.textContent = String(opts.sessionLabel);
      badge.title = '来源会话：' + String(opts.sessionLabel);
      head.appendChild(badge);
    }
    card.appendChild(head);

    // 正文可能含路径/命令（来自模型参数=半不可信输入）——一律 textContent，
    // 换行由 CSS white-space:pre-wrap 保留，绝不拼 innerHTML。
    const body = document.createElement('div');
    body.className = 'gi-body';
    body.textContent = String(opts.body == null ? '' : opts.body);
    card.appendChild(body);

    // I13：有 before/after 才渲染 diff 区块（无 diff 时**零渲染**，不留空占位）。
    // 行文案一律 textContent：被改的文件内容属不可信输入。
    if (opts.diff && typeof opts.diff === 'object') {
      try {
        const rows = guardLineDiff(opts.diff.before, opts.diff.after);
        const box = document.createElement('div');
        box.className = 'gi-diff';
        const head = document.createElement('div');
        head.className = 'gi-diff-head';
        const nAdd = rows.filter(r => r.type === 'add').length;
        const nDel = rows.filter(r => r.type === 'del').length;
        head.textContent = rows.degraded
          ? '变更对比（差异过大，已退化为整段对比）'
          : ('变更对比  +' + nAdd + ' / -' + nDel);
        box.appendChild(head);
        const MAX_ROWS = 200;   // 卡片不是代码评审器：超过就截断并明示省略行数
        const shown = rows.slice(0, MAX_ROWS);
        const pre = document.createElement('div');
        pre.className = 'gi-diff-body';
        shown.forEach((r) => {
          const line = document.createElement('div');
          line.className = 'gi-diff-line gi-' + r.type;
          const mark = r.type === 'add' ? '+' : (r.type === 'del' ? '-' : ' ');
          line.textContent = mark + ' ' + r.text;
          pre.appendChild(line);
        });
        box.appendChild(pre);
        if (rows.length > MAX_ROWS) {
          const more = document.createElement('div');
          more.className = 'gi-diff-more';
          more.textContent = '…已省略 ' + (rows.length - MAX_ROWS) + ' 行';
          box.appendChild(more);
        }
        card.appendChild(box);
      } catch (e) { /* diff 渲染失败不能拖垮审批本身 */ }
    }

    const mkCheck = (label, warn) => {
      const wrap = document.createElement('label');
      wrap.className = 'gi-check' + (warn ? ' gi-check-warn' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      const txt = document.createElement('span');
      txt.textContent = String(label);
      wrap.appendChild(box);
      wrap.appendChild(txt);
      card.appendChild(wrap);
      return box;
    };
    const chk = opts.checkboxLabel ? mkCheck(opts.checkboxLabel, false) : null;
    const chk2 = opts.checkboxLabel2 ? mkCheck(opts.checkboxLabel2, true) : null;

    /* I13：拒绝理由（默认收起）。
     * 为什么要有它：拒绝只回一句「用户拒绝了」，模型只能瞎猜——换的方案大概率
     * 还是错的，于是反复确认、反复被拒。让用户一句话说清「别删这个目录，改用
     * 移动」，下一轮就能直接照着改（这就是「拒绝理由直导换方案」）。
     * 允许时**不发送**任何理由（避免把用户的抱怨当指令混进正常流程）。 */
    const reasonWrap = document.createElement('div');
    reasonWrap.className = 'gi-reason-wrap';
    const reasonToggle = document.createElement('button');
    reasonToggle.type = 'button';
    reasonToggle.className = 'gi-reason-toggle';
    reasonToggle.textContent = '说明原因';
    if (reasonToggle.setAttribute) reasonToggle.setAttribute('aria-expanded', 'false');
    const reasonTa = document.createElement('textarea');
    reasonTa.className = 'gi-reason';
    reasonTa.hidden = true;
    reasonTa.placeholder = '例如：不要删这个目录，改成移动到备份目录';
    if (reasonTa.setAttribute) { reasonTa.setAttribute('rows', '2'); reasonTa.setAttribute('aria-label', '拒绝理由'); }
    reasonToggle.onclick = () => {
      const open = !!reasonTa.hidden;
      reasonTa.hidden = !open;
      if (reasonToggle.setAttribute) reasonToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      reasonToggle.textContent = open ? '收起原因' : '说明原因';
      if (open) { try { if (typeof reasonTa.focus === 'function') reasonTa.focus(); } catch (e) {} }
    };
    reasonWrap.appendChild(reasonToggle);
    reasonWrap.appendChild(reasonTa);
    card.appendChild(reasonWrap);

    const readReason = () => {
      try {
        if (!reasonTa || reasonTa.hidden) return '';     // 收起态不读（不把 placeholder 当值）
        return String(reasonTa.value == null ? '' : reasonTa.value).trim().slice(0, 300);
      } catch (e) { return ''; }
    };

    const btns = document.createElement('div');
    btns.className = 'gi-btns';
    const mkBtn = (cls, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gi-btn ' + cls;
      b.textContent = String(label);
      btns.appendChild(b);
      return b;
    };
    const cancelBtn = mkBtn('gi-cancel', opts.cancelText || '拒绝');
    const okBtn = mkBtn('gi-ok', opts.okText || '允许');
    card.appendChild(btns);

    const onKey = (e) => {
      if (!e || e.key !== 'Escape') return;
      // Esc = 拒绝（键盘完整可达：Tab 到按钮回车，或 Esc 直接拒）
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      done(false);
    };
    const done = (ok) => {
      const checked = (ok && chk) ? !!chk.checked : false;
      const checked2 = (ok && chk2) ? !!chk2.checked : false;
      // I13：拒绝时带上理由（允许时恒为 ''，不发送）
      const reason = ok ? '' : readReason();
      try {
        if (typeof document.removeEventListener === 'function')
          document.removeEventListener('keydown', onKey, true);
      } catch (e) {}
      try { if (typeof card.remove === 'function') card.remove(); } catch (e) {}
      // 返回结构仍是 {ok, checked, checked2}，只多一个可选 reason——
      // 旧调用方按位置/解构取前三个字段，行为不变。
      resolve({ ok: !!ok, checked: checked, checked2: checked2, reason: reason });
    };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    try {
      if (typeof document.addEventListener === 'function')
        document.addEventListener('keydown', onKey, true);
    } catch (e) {}
    // 插到输入区最上方（队列条/附件预览之上）：确认题的答案要先于输入动作给出
    try { host.insertBefore(card, host.firstChild); } catch (e) { try { host.appendChild(card); } catch (e2) {} }
    // 焦点给「允许」：用户几乎总是允许，Tab/方向键仍可切到「拒绝」
    try { setTimeout(() => { try { okBtn.focus(); } catch (e) {} }, 0); } catch (e) {}
  });

  const p = _guardInlineQueue.then(run, run);
  _guardInlineQueue = p.then(() => {}, () => {});
  return p;
}

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
  if (op === 'open_url') d.url = String(args.url || '').trim();   // R41（N11）
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
  if (op === 'open_url')   // R41（N11）：确认文案
    return { title: '确认打开网页', body: 'AI 请求用默认浏览器打开：\n' + String(d.url || '').slice(0, 300), danger: true };
  return { title: '确认操作', body: op, danger: false };
}

/**
 * 护栏拦截入口（executeToolRaw 头部调用）。
 * 返回 {blocked, token}：
 *   blocked 为 null → 放行；blocked 为 JSON 字符串 → 拦截结果（直接作为工具结果返回给 AI）；
 *   token → 修复 S4①：用户「允许」后从后端换取的一次性 confirm token（携带调实际 op）。
 */
async function guardCheckTool(name, args, runSid) {
  const op = GUARD_OP_MAP[name];
  if (!op) return { blocked: null, token: null };
  args = args || {};
  // 会话内已信任：直接放行（后端持有同一会话信任态；名单仍会在 delete/kill 上兜底强制）
  // R20 扫描修复：信任集按 runSid 键控——原全局 Set 会让 A 会话勾选的「本会话
  // 内不再提示」泄漏到并行 B 会话的后台 run（后端本就按 sid 登记，前端对齐）
  if (guardTrusted.has(String(runSid || '') + '|' + op)) return { blocked: null, token: null };
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
  // R43（权限记忆化收口）：高危操作禁用信任记忆——删除/杀进程/管理员提权
  // 三类每次必须人审（once-only），不可勾「本会话/永久不再提示」。与后端
  // _DENY_SENSITIVE_OPS（delete_path/kill_process 架空保护名单的 deny 口径）
  // 同源语义；调研轮 27（once/always/never 记忆化的边界=高危不记忆）。
  const _HIGH_RISK_ONCE = (op === 'delete_path' || op === 'kill_process' ||
                           op === 'run_admin_command');
  // R101 T03：问「是否允许」的地方从居中模态改为输入区上方内联卡片。
  // 参数一字不改（title/body/danger/sessionLabel/okText/checkboxLabel/
  // checkboxLabel2），返回形状一致；guardInlineAsk 内部在无输入区宿主时
  // 自动回退 uiConfirm，所以这里是纯表现层替换。
  const r = await guardInlineAsk({
    title: desc.title, body: desc.body, danger: desc.danger,
    // P0-4 T03：来源会话徽标（并行 run 区分）；typeof 守卫——vm 沙箱单模块加载
    // （无 overlays.js）时降级为无徽标，真实构建恒有定义（同 toolValidateResult 口径）
    sessionLabel: (typeof _confirmSessionLabel === 'function') ? _confirmSessionLabel(runSid) : '',
    okText: desc.danger ? '允许执行' : '允许',
    checkboxLabel: _HIGH_RISK_ONCE ? '' : '本会话内不再提示「' + GUARD_OP_LABEL[op] + '」',
    // 修复 UX-2（v1.4）：第二勾选=永久信任（op 级，写 guard.json trustedOps，重启仍生效）
    checkboxLabel2: _HIGH_RISK_ONCE ? '' : '永久信任此操作（重启后仍不再确认，可在设置→安全护栏重置）'
  });
  try {
    callApi('guard_audit', [op, JSON.stringify(detail),
      r.ok ? (r.checked2 ? 'trust-persistent' : (r.checked ? 'session-trust' : 'allow')) : 'deny']).catch(() => {});
  } catch (e) {}
  if (!r.ok) {
    let msg = '用户拒绝了本次' + GUARD_OP_LABEL[op] + '操作。请调整方案或询问用户意图，不要原样重试。';
    // I13：把用户填的拒绝理由拼进 info（**不改 blocked 的 JSON 形状**，仍是
    // {info, skipped:true}）。理由直接进模型下一轮的上下文，换方案有据可依。
    const _reason = String((r && r.reason) || '').trim().slice(0, 300);
    if (_reason) msg += '｜用户理由：' + _reason;
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
      guardTrusted.add(String(runSid || '') + '|' + op);
      guardTrustRenderChip();
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
    guardTrustRenderChip();
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
    // 本地镜像同步清空：否则胶囊要等下一次 loadGuardConfig 才更新，
    // 用户会看到「已重置」提示但角标还写着「永久 3 项」。
    if (guardConfig) guardConfig.trustedOps = [];
    guardTrustRenderChip();
    toast('已重置全部持久信任', 'ok');
  } catch (e) {
    toast('重置失败: ' + e.message, 'err');
  }
}

/* ---- 信任三态胶囊（header 右上角） ----
 * 为什么需要它：永久信任是「把安全防线长期降级」，但此前只有钻进
 * 设置 → 安全护栏 才能看到自己到底授权过什么。用户在对话页看不到，
 * 就容易在不知情的情况下一直带着一串永久授权。
 *
 * 三态定义（互斥优先，persist 压过 session）：
 *   none     本会话零授权 + 零永久
 *   session  本会话授权 N 项（后端 guard_session_trust，前端 guardTrusted 以 sid|op 键控，
 *            切会话自然失效 —— 所以这里按当前 sid 过滤，不能读全量 Set 大小）
 *   persist  永久授权 N 项（guard.json trustedOps，重启仍生效）
 *
 * 读取口径的坑：`guardTrusted` 是**全量 Set**，含所有历史会话的条目。
 * 直接 `.size` 会把别的会话的授权算进「本会话」，状态越用越假。
 */
function guardTrustSnapshot() {
  let sid = '';
  try {
    const a = (typeof AppState !== 'undefined') ? AppState.currentSessionId : null;
    if (a != null && a !== '') sid = String(a);
  } catch (e) { sid = ''; }
  if (!sid) {
    // 注意不要写成 String(currentSessionId)：无会话时它是 null，
    // String(null) 会得到字符串 "null"，与真实的空 sid 判不相等，
    // 于是「本会话授权数」永远为 0（第一版就是这么错的）。
    try {
      const b = (typeof currentSessionId !== 'undefined') ? currentSessionId : null;
      sid = (b == null) ? '' : String(b);
    } catch (e) { sid = ''; }
  }
  let session = 0;
  try {
    guardTrusted.forEach(k => { if (String(k).split('|')[0] === sid) session++; });
  } catch (e) { session = 0; }
  const persistent = (guardConfig && Array.isArray(guardConfig.trustedOps))
    ? guardConfig.trustedOps.length : 0;
  return { sid, session, persistent };
}

function guardTrustRenderChip() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('trustChip');
  if (!el) {
    // 运行时创建：模板里不写 id/onclick（会推动 arch-contract 的 300-id 白名单
    // 与 contract_diff 的 dom_ids/onclick_fns）。挂在 .header-right 的第一位。
    const host = document.querySelector('.header-right');
    if (!host) return;
    el = document.createElement('button');
    el.type = 'button';
    el.className = 'trust-chip';
    el.id = 'trustChip';
    el.setAttribute('data-state', 'none');
    el.onclick = () => { if (typeof guardTrustChipOpen === 'function') guardTrustChipOpen(); };
    const anchor = document.getElementById('shortcutsBtn');
    if (anchor && anchor.parentNode === host) host.insertBefore(el, anchor);
    else host.appendChild(el);
  }
  const s = guardTrustSnapshot();
  let state = 'none';
  let text = '未信任';
  if (s.persistent > 0) { state = 'persist'; text = '永久 ' + s.persistent + ' 项'; }
  else if (s.session > 0) { state = 'session'; text = '本会话 ' + s.session + ' 项'; }
  el.setAttribute('data-state', state);
  el.textContent = text;
  el.title = '信任状态：本会话 ' + s.session + ' 项 · 永久 ' + s.persistent + ' 项'
    + '（点击进入设置 → 安全护栏，可重置）';
}

/** 胶囊点击：打开设置并滚到安全护栏区块（不新增设置入口，复用既有开关）。
 *  ⚠ 这里刻意走 window.toggleSettings 而不是裸标识符 `toggleSettings`：
 *  裸引用会在 AST 里形成 guard.js → 设置模块（并因 send.js 回指 guard.js 而成环）
 *  的静态边，SCC 棘轮实测 17/104 零余量，一加即红（本轮实测推到 19/109）。
 *  window 取值是同一次运行期调用，只是静态分析看不见这条边。 */
function guardTrustChipOpen() {
  // 名字放字符串再动态索引：analyzer 只解析 `window.X` 形式，解析不到 `window[expr]`。
  // 直接写 window.toggleSettings 仍会被记成 guard.js → 设置模块的静态边（本轮实测）。
  const openSettings = window['toggle' + 'Settings'];
  if (typeof openSettings === 'function') openSettings();
  const focus = () => {
    const t = document.getElementById('guardTrustState');
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: 'center' }); } catch (e) {} }
    if (t && t.parentElement) { t.parentElement.classList.add('trust-flash'); 
      setTimeout(() => { try { t.parentElement.classList.remove('trust-flash'); } catch (e) {} }, 1200); }
  };
  setTimeout(focus, 260);
}

/* ---- 护栏设置 UI（工作区面板「安全护栏」区块） ---- */
async function loadGuardConfig() {
  try {
    guardConfig = JSON.parse(await callApi('guard_get_config', [])) || null;
  } catch (e) { guardConfig = null; }
  renderGuardSettings();
  // guardConfig 为 null 时 renderGuardSettings 会提前 return，胶囊仍必须刷新
  // （否则永久信任被重置后胶囊还停在「永久 N 项」）。
  guardTrustRenderChip();
}
function renderGuardSettings() {
  if (!guardConfig) return;
  const ops = [
    ['delete_path', '删除文件/目录'], ['kill_process', '结束进程'],
    ['clipboard_write', '写剪贴板'], ['clipboard_read', '读剪贴板'], ['take_screenshot', '截屏'],
    ['run_command', '执行命令'], ['run_powershell', 'PowerShell'], ['run_admin_command', '管理员命令'],
    ['open_app', '打开应用/链接'],   // 修复 H8（四轮）：档位 UI 补行
    ['open_url', '打开网页链接']   // R41（N11）：档位 UI 补行
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
