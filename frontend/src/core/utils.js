/* ================= 工具函数 ================= */
function buildToolLabel(name, args) {
  args = args || {};
  const p = args.path || '?';
  if (name.startsWith('mcp__')) {      // v1.3 R4：MCP 外部工具可辨识标签
    const mp = mcpParseName(name);
    return mp ? '🔌 MCP ' + mp.server + ' · ' + mp.tool : '🔌 MCP ' + name;
  }
  switch (name) {
    case 'write_file':       return `📝 写入: ${smartCmd(p, 40)}`;
    case 'read_file':        return `📖 读取: ${smartCmd(p, 40)} (${args.offset || 0}-${(args.offset || 0) + (args.limit || 2000)}行)`;
    case 'list_dir':         return `📂 列目录: ${smartCmd(args.path || '.', 40)}`;
    case 'run_command':      return `⚡ $ ${smartCmd(args.cmd || '', 60)}`;
    case 'run_powershell':   return `⚡ PS> ${smartCmd(args.cmd || '', 60)}`;
    case 'run_admin_command':return `🛡 $ ${smartCmd(args.cmd || '', 60)}`;
    case 'open_app':         return `🚀 打开: ${p}`;
    case 'open_url':         return `🌐 网页: ${args.url || '?'}`;
    case 'take_screenshot':  return args.width ? `📷 区域截图 ${args.width}×${args.height}` : '📷 截屏';
    case 'make_dir':         return `📁 创建: ${smartCmd(p, 40)}`;
    case 'delete_path':      return `🗑 删除: ${smartCmd(p, 40)}`;
    case 'move_path':        return `➜ 移动: ${smartCmd(p, 30)} → ${smartCmd(args.new_path || '?', 30)}`;
    case 'copy_path':        return `⧉ 复制: ${smartCmd(p, 30)} → ${smartCmd(args.new_path || '?', 30)}`;
    case 'append_file':      return `➕ 追加: ${smartCmd(p, 40)}`;
    case 'search_replace':   return `✎ 替换: ${smartCmd(p, 40)}`;
    case 'read_more':        return `📖 续读: ${smartCmd(args.cache_id || '?', 40)}`;
    case 'get_file_info':    return `ℹ 信息: ${smartCmd(p, 40)}`;
    case 'clipboard_read':   return `📋 读剪贴板`;
    case 'clipboard_write':  return `📋 写剪贴板: ${(args.text || '').slice(0, 30)}`;
    case 'list_processes':   return `📊 列进程${args.keyword ? ' (' + args.keyword + ')' : ''}`;
    case 'kill_process':     return args.pid ? `💀 结束 pid=${args.pid}` : `💀 结束 ${args.name || '?'}`;
    default:                 return '🔧 ' + name;
  }
}
function smartCmd(cmd, max = 72) {
  cmd = (cmd || '').replace(/\s+/g, ' ').trim();
  // 修复 建议㉛（二轮）：超长/无闭合引号输入下原正则回溯 O(n²) 卡死 UI——
  // 超过 4000 字符直接走截断，不进引号正则
  if (cmd.length > 4000) return cmd.slice(0, max - 1) + '…';
  if (cmd.length <= max) return cmd;
  // 修复 ㊱（三轮）：原引号压缩正则 `["']([^"']*[\\/])?([^"'/\\]+)["']` 在长串/多引号
  // 未闭合输入上存在回溯 O(n²)——改单遍扫描（遇引号段取末级路径压缩，无正则回溯）；
  // 4000 字符上限 + 单遍 = 最坏 O(n)，UI 不再可能被拖卡
  let out = '';
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === '"' || ch === "'") {
      const close = cmd.indexOf(ch, i + 1);
      if (close < 0) { out += cmd.slice(i); break; }   // 无闭合引号：原样输出剩余
      const inner = cmd.slice(i + 1, close);
      const seg = /([^\\/]+)$/.exec(inner);
      const name = seg ? seg[1] : inner;
      const short = ch + '…\\' + name + ch;
      out += short.length < (close - i + 1) ? short : cmd.slice(i, close + 1);
      i = close + 1;
    } else { out += ch; i++; }
  }
  cmd = out;
  if (cmd.length <= max) return cmd;
  const tail = Math.floor(max * 0.4);
  return cmd.slice(0, max - tail - 1) + '…' + cmd.slice(-tail);
}
/* 修复 ㊾（三轮）：ctx 徽标文本统一入口——原 34-local-model 与 36-connect 各写一套
 * （一套直接拼小数 19.53k、一套 Math.round 20k），同窗口两处显示不一致。现一处取整；
 * 调用方均为运行时调用，typeof 守卫保 node vm 单模块沙箱（只加载单文件）可测。 */
function formatCtx(w) {
  const n = parseInt(w, 10) || 0;
  if (n <= 0) return '';
  return n >= 1024 ? Math.round(n / 1024) + 'k' : String(n);
}
function wsShort(p, n) {
  if (!p) return '未选择';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= n) return p;
  return parts[0] + '\\…\\' + parts.slice(-n).join('\\');
}
function addSysTip(msg) {
  const d = document.createElement('div');
  d.className = 'sys-tip'; d.textContent = msg;
  document.body.appendChild(d);
  // v4：退场改 class 驱动（.sys-tip.out 的 140ms in-soft 过渡见模板 CSS），
  // transitionend + setTimeout 双兜底后 remove；原内联样式过渡已删除
  const dismiss = () => {
    if (d.__closing) return;
    d.__closing = true;
    d.classList.add('out');
    const fin = () => { try { d.remove(); } catch (e) {} };
    if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
      MOTION.onAnimEnd(d, 'transitionend', MOTION.compOut()).then(fin);
    } else { fin(); }
  };
  // 修复 ㉖（三轮）：2200ms 硬编码违反 MOTION 令牌纪律——展示时长 = 2×comp
  // （令牌缺失时兜底 2200，fx-off/reduced-motion 下 MOTION.instant() 已同步退场）
  const _tipMs = (typeof MOTION !== 'undefined' && MOTION.comp) ? MOTION.comp() * 2 : 2200;
  setTimeout(dismiss, _tipMs);
}
async function refreshEffectiveWs() {
  try {
    const r = await callApi('get_effective_ws', []);
    if (!r) return;
    const d = JSON.parse(r);
    const tag = document.getElementById('effTag');
    tag.textContent = d.source === 'session' ? '会话' : '全局';
    tag.className = 'eff-tag' + (d.source === 'session' ? ' eff-tag-s' : '');
    document.getElementById('effPath').textContent = d.ws || '（未绑定）';
    document.getElementById('effPath').title = d.ws || '';
  } catch (e) {}
}
async function refreshWsCard() {
  const sel = document.getElementById('wsSel');
  if (!sel) return;
  let st = { ws: '', bound: false, enabled: true, recent: [] };
  try { st = Object.assign(st, JSON.parse(await callApi('get_ws_state', [currentSessionId])) || {}); } catch (e) {}
  const wsEnabled = document.getElementById('wsEnabled');
  const wsBody = document.getElementById('wsBody');
  const wsInd = document.getElementById('wsInd');
  const wsEffTag = document.getElementById('wsEffTag');
  const wsEffPath = document.getElementById('wsEffPath');
  const wsUnbindBtn = document.getElementById('wsUnbindBtn');
  if (wsEnabled) wsEnabled.checked = !!st.enabled;
  if (wsBody) wsBody.style.display = st.enabled ? '' : 'none';
  if (wsInd) wsInd.checked = !!st.bound;
  const seen = new Set();
  sel.innerHTML = '';
  const mk = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  if (st.ws) { mk(st.ws, '● ' + wsShort(st.ws, 2)); seen.add(st.ws); }
  (st.recent || []).forEach(r => { if (r.path && !seen.has(r.path)) { mk(r.path, '′ ' + (r.name || wsShort(r.path, 2))); seen.add(r.path); } });
  mk('__browse__', '＋ 浏览其他文件夹…');
  sel.value = (st.ws && seen.has(st.ws)) ? st.ws : (sel.options[0] ? sel.options[0].value : '__browse__');
  CS.sync(sel);
  if (wsEffTag) {
    if (!st.enabled) { wsEffTag.textContent = '[未启用]'; wsEffTag.style.color = 'var(--text-2)'; }
    else if (st.bound) { wsEffTag.textContent = '[会话]'; wsEffTag.style.color = 'var(--ok)'; }
    else { wsEffTag.textContent = '[全局]'; wsEffTag.style.color = 'var(--text-2)'; }
  }
  if (wsEffPath) wsEffPath.textContent = st.ws ? wsShort(st.ws, 3) : '';
  if (wsUnbindBtn) wsUnbindBtn.style.display = st.bound ? '' : 'none';
  refreshEffectiveWs();
  // v4：同步刷新输入区上方的工作区快捷条（同一数据源，遥控器视图）
  try { if (typeof wsQuickRefresh === 'function') wsQuickRefresh(); } catch (e) {}
}
async function onFolderEnabled(on) {
  // 复核修正：callApi 全程 try/catch——原桥拒绝时 unhandled rejection 且
  // refreshWsCard 不执行，复选框与后端失同步
  try {
    await callApi('set_current_sid', [currentSessionId]);
    await callApi('set_ws_enabled', [currentSessionId, on]);
    addSysTip(on ? '文件能力已开启' : '文件能力已关闭');
  } catch (e) {
    addSysTip('操作失败: ' + (e && e.message || e));
  } finally {
    refreshWsCard();                 // 按后端真实状态回填
  }
}
async function onIndToggle(on) {
  ensureSession();                 // 没会话就先建一个,sid 永不为空
  saveSessions(); renderSessionList();
  try {
    await callApi('set_current_sid', [currentSessionId]);
    if (on) {
      const v = document.getElementById('wsSel').value;
      if (v && v !== '__browse__') {
        const r = JSON.parse(await callApi('set_session_ws', [currentSessionId, v, true]) || '{}');
        addSysTip(r.ok ? '已绑定到当前会话: ' + (r.ws || v) : '绑定失败: ' + (r.error || '未知'));
      } else addSysTip('请先选择一个文件夹');
    } else {
      const r = JSON.parse(await callApi('set_session_ws', [currentSessionId, '', false]) || '{}');
      addSysTip(r.ok ? '已解除绑定，本会话跟随全局' : '解绑失败: ' + (r.error || '未知'));
    }
  } catch (e) {
    addSysTip('操作失败: ' + (e && e.message || e));
  } finally {
    refreshWsCard();                 // 由它按后端真实状态回填勾选
  }
}
async function onWsSelect(p) {
  if (p === '__browse__') { await browseWs(); return; }
  if (!p) return;
  const ind = document.getElementById('wsInd').checked;
  try {
    if (ind) {
      ensureSession();                 // 没会话就先建一个,sid 永不为空
      saveSessions(); renderSessionList();
      await callApi('set_current_sid', [currentSessionId]);
      const r = JSON.parse(await callApi('set_session_ws', [currentSessionId, p, true]) || '{}');
      addSysTip(r.ok ? '本会话目录已切换（全局未动）' : '切换失败: ' + (r.error || '未知'));
    } else {
      await callApi('set_ws_dir', [p]);
      addSysTip('全局目录已切换');
    }
  } catch (e) {
    addSysTip('操作失败: ' + (e && e.message || e));
  } finally {
    refreshWsCard();
  }
}
async function browseWs() {
  try {
    const r = JSON.parse(await callApi('pick_folder', [currentSessionId]) || '{}');
    if (!r.ok) { if (r.err && r.err !== 'cancelled') addSysTip('选择失败: ' + r.err); return; }
    const p = r.path;
    const ind = document.getElementById('wsInd').checked;
    await callApi('set_current_sid', [currentSessionId]);
    if (ind) {
      const r2 = JSON.parse(await callApi('set_session_ws', [currentSessionId, p, true]) || '{}');
      if (r2 && r2.ok) addSysTip('本会话已绑定: ' + wsShort(p, 3) + '（全局未动）');
      else addSysTip('绑定失败: ' + ((r2 && r2.error) || '未知错误'));
    } else {
      await callApi('set_ws_dir', [p]);
      addSysTip('全局目录已切换: ' + wsShort(p, 3));
    }
    refreshWsCard();
  } catch (e) { addSysTip('选择文件夹失败: ' + e); }
}
async function unbindSession() {
  // 复核修正：全程 try/catch + finally 回填（原桥拒绝即 unhandled rejection）
  try {
    await callApi('set_current_sid', [currentSessionId]);
    await callApi('set_session_ws', [currentSessionId, '', false]);
    addSysTip('已解除绑定，本会话跟随全局');
  } catch (e) {
    addSysTip('解绑失败: ' + (e && e.message || e));
  } finally {
    refreshWsCard();
  }
}
