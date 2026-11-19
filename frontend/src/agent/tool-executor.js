/* ================= R56 并发执行面（多 run / 多模型同时调用同一工具）=================
 * 单 JS 上下文内全局的两组互斥原语（所有并行 run 共享）：
 *
 * 1) withPySidSlot —— pywebview 链 sid 原子对队列。pywebview 后端以「当前会话」
 *    全局态路由工作区/护栏信任：set_current_sid 与实际调用之间被其他 run 的
 *    set_current_sid 插队 → 工具读写落错会话工作区（R37 只修了 HTTP 链的
 *    header 路由，pywebview 链遗留此竞态）。本队列把 pywebview 链的**整段**
 *    工具执行（set_current_sid + 护栏 + token + op）原子化——token 签发/消费
 *    与 sid 全局态在同一原子段内，签发 sid=消费 sid 必然成立。代价：pywebview
 *    链并行 run 的工具执行串行化（含确认弹窗等待）；Electron 生产链（HTTP，
 *    sid 走 x-harbor-sid 头、无全局态）完全不受影响。
 *
 * 2) withPathLocks —— 写类工具按目标路径跨 run 互斥（键=小写规范化路径；
 *    多键按字典序全序加锁防死锁；持锁覆盖整个后端往返，完成后释放）。
 *    后端已有互斥（Python FileService._path_lock per-path / Node withRootLock
 *    per-root），前端锁提供跨 run 写序确定性并覆盖任何后端链的锁缺口
 *    （R56 调研方向 B-3；键域与后端 normcase 口径对齐）。
 */
var __pySidTail = Promise.resolve();
function withPySidSlot(fn) {
  const run = __pySidTail.then(fn, fn);
  __pySidTail = run.catch(() => {});
  return run;
}
var __pathLocks = new Map();   // 规范化路径 -> 尾 Promise（当前持有者释放后 settle）
function _pathLockAcquire(key) {
  const prev = __pathLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(res => { release = res; });
  const tail = prev.then(() => gate, () => gate);
  tail.catch(() => {});
  __pathLocks.set(key, tail);
  return { held: prev.then(() => true), release: release, key: key };
}
function withPathLocks(keys, fn) {
  const uniq = [...new Set((keys || []).filter(Boolean)
    .map(k => String(k).toLowerCase()))].sort();
  const held = [];
  const step = () => {
    if (held.length >= uniq.length) return null;
    const h = _pathLockAcquire(uniq[held.length]);
    held.push(h);
    return h.held.then(step);
  };
  return Promise.resolve(step()).then(fn).finally(() => {
    for (let i = held.length - 1; i >= 0; i--) held[i].release();
  });
}

async function executeToolRaw(name, args, runSid, realCallApi = callApi) {
  // P0-4 修正：pywebview 缺席时走 HTTP 桥（HARBOR_API_BASE）——原版在此早退
  // 「请在 Harbor.exe 桌面端中使用此功能」，使下方 __useHttp HTTP 分支成为
  // 死代码，Electron 桌面端全部工具调用失败（T06 真机用户报障根因）。
  const __isPy = !!(window.pywebview && window.pywebview.api);
  const __useHttp = !__isPy && (typeof harborHttpAvailable === 'function'
    ? harborHttpAvailable() : !!window.HARBOR_API_BASE);
  if (!__isPy && !__useHttp) {
    return JSON.stringify({error: '请在 Harbor.exe 桌面端中使用此功能'});
  }
  // R56：pywebview 链整段原子化（sid 原子对——见顶部并发执行面说明）；
  // HTTP 链 sid 由 x-harbor-sid 头承载（无全局态），原样并行。
  const _dispatch = () => executeToolRawDispatch(name, args, runSid, realCallApi);
  if (!__isPy) return _dispatch();
  return withPySidSlot(_dispatch);
}
async function executeToolRawDispatch(name, args, runSid, realCallApi) {
  // 可达性已由 executeToolRaw 门面判定（非 pywebview 且无 HTTP 桥早退）；
  // 此处仅取 pywebview 标志（全局 sid 切换分支用）。
  const __isPy = !!(window.pywebview && window.pywebview.api);
  // P0-3：run 级 sid 影子（realCallApi 由门面在调用方作用域捕获后透传——
  // 函数体自包含、无 TDZ、不依赖任何模块级辅助符号；全部
  // `await callApi('…')` 源码模式原样保留）
  // V4-H C3：第 4 参 confirmed → bridge 第 5 参 → x-harbor-confirmed 头。
  // 默认 undefined（不发头），只有护栏拿到一次性 token 的分支才置 true（不伪造确认）。
  const callApi = (n, a, ms, confirmed) => realCallApi(n, a, ms, runSid, confirmed === true);
  if (__isPy) {
    // pywebview 路径：全局 sid 切换；HTTP 桥（Electron）按 runSid 走
    // x-harbor-sid 请求头路由（P0-3），不触碰全局 activeSid
    // R37 修复（P0 串话）：路由目标是 **run 所属会话**——原取全局 currentSessionId，
    // 并行后台 run 每次工具调用都把后端会话切到「可见会话」，工具读写落进
    // 别人会话的工作区（跨会话写盘）。
    try { await callApi('set_current_sid', [runSid]); } catch (e) {}
  }
  args = args || {};   // 修复 ㊱：args 缺省兜底（原 pickPath 对 undefined 取属性虽不炸，但统一归一更稳）
  // v1.2 R2：破坏性操作护栏（delete/kill/剪贴板/截屏/命令执行 → 确认矩阵/保护名单）
  let guardToken = null;
  try {
    const g = await guardCheckTool(name, args, runSid);
    if (g && g.blocked) return g.blocked;
    guardToken = (g && g.token) || null;   // 修复 S4①：确认通过换取的一次性 token
  } catch (e) { /* 护栏自身异常不阻断工具执行（fail-open 由后端名单兜底） */ }
  // V4-H C3：legacy 护栏换取到一次性 token = 人工确认已发生 → 高危调用带
  // x-harbor-confirmed；未确认（token 为空）时不带，语义与默认路径一致。
  const guardConfirmed = guardToken ? true : undefined;
  // v1.3 R4：MCP 工具护栏挂点（mcp__ 前缀 → 定档确认；异常 fail-closed）
  let mcpDecision = 'deny';
  let mcpToken = null;
  if (name.startsWith('mcp__')) {
    try {
      const g = await mcpGuardCheck(name, args, runSid);
      if (g.blocked) return g.blocked;
      mcpDecision = g.decision;
      mcpToken = (g && g.token) || null;   // 修复 S4①：MCP 确认 token
    } catch (e) {
      return JSON.stringify({ error: 'MCP 护栏检查失败: ' + (e.message || e) });
    }
  }
  // 修复 ㊱：pickPath 缺省 ''（原 undefined 会以位置参数形式把 undefined 传给后端）
  const pickPath = (a) => a.path || a.file_path || a.filename || a.file || a.target || a.src || '';
  // 修复 ㊱：命令取值与护栏 detail 同口径（args.cmd 优先，缺失时回退 args.command）
  // 修复 ②（三轮）：原 `a.cmd != null ? String(a.cmd) : ...` 对空串 falsy 穿透
  // （cmd='' 时取到空命令，后端/护栏拿到空串）——空值也回退 command
  const pickCmd = (a) => {
    const c = (a.cmd != null) ? String(a.cmd) : '';
    return c.trim() ? c : String(a.command || '');
  };
  // 修复 ㊱：timeout 显式判断（原 `args.timeout || 60` 吞 0 值）
  // 修复 ⑧（三轮）：兼容数字字符串（模型常传 "120"）——原 typeof number 检查被吞成默认 60
  const pickTimeout = (a) => {
    const t = a.timeout;
    if (typeof t === 'number' && t > 0) return t;
    if (typeof t === 'string' && /^\d+(\.\d+)?$/.test(t.trim()) && parseFloat(t) > 0) return parseFloat(t);
    return 60;
  };
  // 修复 S4①：token 作为最后一个位置参数追加（仅非空时——旧 exe 没有该形参，多传会 TypeError）
  const withToken = (arr, token) => token ? arr.concat([token]) : arr;
  // 修复 ②（三轮）：空命令不送执行——cmd/command 皆空或纯空白时返回人话 error
  // （原会把空串发去后端跑 `chcp 65001 >nul & ` 空转，且空串占去重键窗口）
  const rejectEmptyCmd = () => JSON.stringify({
    error: '命令为空：请在 cmd（或 command）字段提供要执行的具体命令。空命令已被拒绝，不会执行。'
  });
  try {
    // R56：写类工具按目标路径跨 run 互斥（withPathLocks——多键字典序防死锁；
    // 持锁覆盖整个后端往返）。读工具不排队。
    if (name === 'write_file')        return await withPathLocks([pickPath(args)],
                                        () => callApi('write_file', [pickPath(args), args.content]));
    if (name === 'append_file')       return await withPathLocks([pickPath(args)],
                                        () => callApi('append_file', [pickPath(args), args.content]));
    if (name === 'search_replace')    return await withPathLocks([pickPath(args)],
                                        () => callApi('search_replace', [pickPath(args), args.old, args.new, args.replace_all === true]));
    if (name === 'read_file')         return await callApi('read_file', [pickPath(args), args.offset || 0, args.limit || 0, args.force === true]);
    if (name === 'list_dir')          return await callApi('list_dir', [pickPath(args) || null]);
    if (name === 'make_dir')          return await withPathLocks([pickPath(args)],
                                        () => callApi('make_dir', [pickPath(args)]));
    if (name === 'delete_path')       return await withPathLocks([pickPath(args)],
                                        () => callApi('delete_path', withToken([pickPath(args), args.recycle !== false], guardToken), undefined, guardConfirmed));
    if (name === 'move_path')         return await withPathLocks([pickPath(args), args.new_path || args.dst],
                                        () => callApi('move_path', [pickPath(args), args.new_path || args.dst]));
    if (name === 'copy_path')         return await withPathLocks([pickPath(args), args.new_path || args.dst],
                                        () => callApi('copy_path', [pickPath(args), args.new_path || args.dst]));
    if (name === 'get_file_info')     return await callApi('get_file_info', [pickPath(args)]);
    if (name === 'run_command') {
      const _c = pickCmd(args);
      if (!_c.trim()) return rejectEmptyCmd();   // 修复 ②（三轮）：空命令不送执行
      return await callApi('run_command', withToken([_c, pickTimeout(args)], guardToken), 660000, guardConfirmed);
    }
    if (name === 'run_powershell') {
      const _c = pickCmd(args);
      if (!_c.trim()) return rejectEmptyCmd();   // 修复 ②（三轮）：空命令不送执行
      return await callApi('run_powershell', withToken([_c, pickTimeout(args)], guardToken), 660000, guardConfirmed);
    }
    if (name === 'run_admin_command') {
      /* 修复 S5/W8（三轮）：① timeout 参数接线（原只传 cmd，后端 timeout 是死参数）；
       * ② 前端 150s 超时与后端人审口径对齐——人审是 MessageBox 无限期阻塞，前端超时后
       *    模型若重试会排队等第二个确认框（二次提权执行）。超时返回不可重试语义。
       * 修复 H1（四轮）：后端签名为 (cmd, token, timeout)——原 withToken([cmd, timeout], token)
       * 把 timeout 放在 token 位、token 落在 timeout 位，提档后管理员命令必被拦、
       * timeout 接线失效。改为显式三参 [cmd, token, timeout] 对齐后端形参序。 */
      try {
        const _c = pickCmd(args);
        if (!_c.trim()) return rejectEmptyCmd();   // 修复 ②（三轮）：空命令不送执行
        return await callApi('run_admin_command', [_c, guardToken, pickTimeout(args)], 150000, guardConfirmed);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/timeout|超时|Timeout/i.test(msg)) {
          return JSON.stringify({ error: '管理员命令的人审确认未在 150 秒内完成，命令未执行。请勿原样重试——重复调用会再次弹出确认框；请等待用户确认或改用普通命令。', non_retryable: true });
        }
        throw e;
      }
    }
    if (name === 'read_more')         return await callApi('read_more', [args.cache_id, args.offset || 0, args.limit || 2000]);
    // 修复 H8（四轮）：open_app 后端已纳入护栏矩阵（W9），前端补 token 透传——
    // 原不携带 token，guard.json 提档后 enforce_exec 必拒且无 UI 确认路径（提档即砖）。
    if (name === 'open_app')          return await callApi('open_app', withToken([pickPath(args)], guardToken));
    // R48-2 修复：open_url 已入护栏矩阵（R41 N11）——分发补 token 透传
    // （open_app H8 同款；原不携带 token，提档后确认完仍被 enforce_exec 拒绝的死循环）
    if (name === 'open_url')          return await callApi('open_url', withToken([args.url], guardToken));
    // R42：记忆工具族——write 走 memory_remember（source='assistant' 走门控，
    // 敏感字段拒写）；search 走 memory_search（两源检索+频率/衰减重排序）
    if (name === 'memory_write')      return await callApi('memory_remember', [String(args.text || ''), 'assistant', true]);
    // R44：MCP 渐进披露——检索元工具（折叠模式下发现工具，返回含 schema 条目，
    // 模型随后直接按 name 调 mcp__xxx 走既有 mcpExecTool 动态执行）
    if (name === 'mcp_search')        return await callApi('mcp_search', [String(args.query || ''), Math.min(20, Math.max(1, parseInt(args.limit, 10) || 8))]);
    // V4-H（C1）：渐进式工具面的元工具——按名取回未激活工具的完整 JSON Schema。
    // 灰度关闭时工具面不含它，模型不会调用；分支常驻不影响默认行为（只读、无副作用）。
    if (name === 'inspect_tool_schema') {
      const _t = String((args && (args.tool_name || args.name)) || '').trim();
      return await callApi('inspect_tool_schema', [_t]);
    }
    if (name === 'memory_search')     return await callApi('memory_search', [String(args.query || ''), Math.min(20, Math.max(1, parseInt(args.limit, 10) || 8))]);
    if (name === 'clipboard_read')    return await callApi('get_clipboard', withToken([], guardToken));
    if (name === 'clipboard_write')   return await callApi('set_clipboard', withToken([args.text || ''], guardToken));
    if (name === 'list_processes')    return await callApi('list_processes', [args.keyword || null]);
    if (name === 'kill_process')      return await callApi('kill_process', withToken([args.pid || null, args.name || null], guardToken), undefined, guardConfirmed);
    if (name === 'take_screenshot') {
      // 修复 H9（四轮）：区域参数 0 值不吞——`args.left || null` 把合法坐标 0 变 null，
      // 后端判定区域参数缺失走整屏，区域截图静默丢失（后端 R6 修复被前端抵消）。
      const _pickCoord = (v) => (v != null ? v : null);
      const res = await callApi('take_screenshot', withToken([_pickCoord(args.left), _pickCoord(args.top), _pickCoord(args.width), _pickCoord(args.height)], guardToken));
      try {
        const data = JSON.parse(res);
        if (data.dataUrl) {
          const comp = await compressScreenshot(data.dataUrl);
          const dup = await shotDedup(comp);
          if (dup) return JSON.stringify({ok: true, path: data.path, info: dup});
          if (typeof pendingShots === 'undefined') { /* 部分沙箱未载 state.js */ }
          else pendingShots.push({ sid: String(runSid || ''), comp });   // R20：按会话标记，防并行/切换串图
          return JSON.stringify({ok: true, path: data.path, note: '截图已压缩，下一步将自动作为图片提供给你分析屏幕内容。', thumbnail: comp});
        }
        return JSON.stringify({error: data.error || '截图失败'});
      } catch (e) { return JSON.stringify({error: '截图返回解析失败'}); }
    }
    // R57 修复（A2 键名断链）：schema 参数是 content，后端 api.append_memory /
    // Node memory.js 只读 entry.text——原整包 stringify 导致两条链内容全丢
    // （落库空条目、检索永不命中）。归一为 {text} 再上送。
    if (name === 'append_memory') {
      const _mtext = (typeof args === 'string') ? args
        : String((args && (args.content || args.text)) || '');
      return await callApi('append_memory', [JSON.stringify({ text: _mtext })]);
    }
    // v1.8.0 B/S 域：Agent 工具族分发（C 域接线；参数透传，timeoutMs 口径见联调规范 §2.1）
    // §3.3/§4.4 护栏链（2026-10-21）：browser_search/software_call 前置
    // agentGuardCheck（guard_check → 确认弹窗 → 一次性 token 回传后端
    // enforce_exec；session 档会话信任缓存，dangerous 每次确认）
    if (name === 'browser_search') {
      // P0-4 T03 §4.4：AI 发起的确认弹窗带来源会话徽标 + guard 链按 run 级 sid
      // 路由（origin 缺省走 'ai'；与 guardCheckTool/mcpGuardCheck 传参同口径）
      const g = await agentGuardCheck('web_search',
        { query: String((args && args.query) || '').slice(0, 120) }, undefined, runSid);
      if (g.blocked) return g.blocked;
      // §2.4：CAPTCHA_REQUIRED → 挂起标记（fail-fast + 前端挂起，browser_takeover
      // 终态才由 60-agent-loop 注入上下文——Agent 循环永不挂死在人类动作上）
      return browserToolWrapCaptcha(
        await callApi('browser_search', [args, g.token], 90000));
    }
    if (name === 'browser_open') {
      return await callApi('browser_open', [args], 60000);
    }
    // v1.9.0 M5：浏览器驱动六原语分发（guard 矩阵：click/fill=always，其余
    // session；护栏链同 browser_search 走 agentGuardCheck；预算超限
    // APPROVAL_BUDGET_EXCEEDED → maybeBudgetInvite 任务授权邀请，不弹逐项确认）
    if (name === 'browser_navigate') {
      const g = await agentGuardCheck('browser_navigate',
        { url: String((args && args.url) || '').slice(0, 200) }, undefined, runSid);
      if (g.blocked) return g.blocked;
      return maybeBudgetInvite(await callApi('browser_navigate',
        [(args && args.url) || '', (args && args.wait_selector) || '',
         pickTimeout(args), (args && args.mode) === 'visible' ? 'visible' : 'hidden',
         g.token], 120000));
    }
    if (name === 'browser_extract') {
      const g = await agentGuardCheck('browser_extract',
        { selector: String((args && args.selector) || '').slice(0, 80) }, undefined, runSid);
      if (g.blocked) return g.blocked;
      return maybeBudgetInvite(await callApi('browser_extract',
        [(args && args.selector) || '', (args && args.mode) || 'markdown', g.token], 90000));
    }
    if (name === 'browser_snapshot') {   // R43：语义快照（role/name/state 修剪树）
      const g = await agentGuardCheck('browser_snapshot',
        { selector: String((args && args.selector) || '').slice(0, 80) }, undefined, runSid);
      if (g.blocked) return g.blocked;
      return maybeBudgetInvite(await callApi('browser_snapshot',
        [(args && args.selector) || '', Math.min(20000, Math.max(500, parseInt((args && args.max_chars), 10) || 4000)), g.token], 90000));
    }
    if (name === 'browser_click') {
      const g = await agentGuardCheck('browser_click',
        { target: String((args && args.target) || '').slice(0, 120) }, undefined, runSid);
      if (g.blocked) return g.blocked;
      // V4-H C3：click/fill 属破坏性档——确认弹窗通过（拿到一次性 token）时带
      // x-harbor-confirmed，避免前置护栏对同一动作二次拦截（确认死循环）。
      return maybeBudgetInvite(await callApi('browser_click',
        [(args && args.target) || '', g.token], 90000, g.token ? true : undefined));
    }
    if (name === 'browser_fill') {
      const g = await agentGuardCheck('browser_fill',
        { selector: String((args && args.selector) || '').slice(0, 80) }, undefined, runSid);
      if (g.blocked) return g.blocked;
      return maybeBudgetInvite(await callApi('browser_fill',
        [(args && args.selector) || '', (args && args.text) || '', g.token], 90000, g.token ? true : undefined));
    }
    if (name === 'browser_screenshot') {
      const g = await agentGuardCheck('browser_screenshot', {}, undefined, runSid);
      if (g.blocked) return g.blocked;
      return maybeBudgetInvite(await callApi('browser_screenshot',
        [args && args.full_page === true, g.token], 90000));
    }
    if (name === 'browser_close') {
      // 会话管理类（session 档）：确认后执行；缺省关全部（session_id 可选）
      const g = await agentGuardCheck('browser_close', {}, undefined, runSid);
      if (g.blocked) return g.blocked;
      return maybeBudgetInvite(await callApi('browser_close',
        [(args && args.session_id) || '', g.token], 60000));
    }
    if (name === 'software_call') {
      const g = await agentGuardCheck('software_call', {
        software: String((args && args.software) || '').slice(0, 60),
        action: String((args && args.action) || '').slice(0, 40),
        args: args && args.args,
        force_always: args && args.__dangerous === true,
      }, undefined, runSid);
      if (g.blocked) return g.blocked;
      // 后端执行上限 600s + 30s 缓冲（与 run_command 660000 同款口径）
      const _swT = pickTimeout(args);
      return await callApi('software_call', [args, g.token],
        Math.min(660000, _swT * 1000 + 30000));
    }
    // v1.3 R4：MCP 工具分发（后端二次 enforce + 审计 + 结果渲染）
    if (name.startsWith('mcp__')) {
      try {
        return await mcpExecTool(name, args, mcpDecision, mcpToken);
      } catch (e) {
        return JSON.stringify({ error: 'MCP 工具调用失败: ' + (e.message || e) });
      }
    }
    return JSON.stringify({error: '未知工具: ' + name});
  } catch (e) { return JSON.stringify({error: (e && e.message) ? e.message : String(e)}); }   // 修复 ㊱：catch 输出 err.message（非 Error 抛出兜底 String）
}
async function executeTool(name, args, runSid) {
  const t0 = performance.now();
  const result = await executeToolRaw(name, args, runSid);
  const ms = performance.now() - t0;
  try {
    const d = JSON.parse(result);
    if (d && typeof d === 'object' && !d.__ms) {
      d.__ms = Math.round(ms);
      // V1 前端孪生（v1.8.0 §6）：出口附 _validation verdict（只提示不拦截；
      // 60-agent-loop 渲染「⚠ 校验存疑」徽标）。挂起态（suspended）不附——
      // 接管流由 browserToolWrapCaptcha/harborTakeoverNotify 专责。
      if (d.suspended !== true && typeof toolValidateResult === 'function') {
        d._validation = toolValidateResult(name, d);
      }
      return JSON.stringify(d);
    }
  } catch (e) { /* 非 JSON 返回：保持原样，图表侧按无耗时处理 */ }
  return result;
}
/* v1.8.0 C 域：browser_search 的 CAPTCHA_REQUIRED 挂起标记（联调规范 §2.4）。
 * fail-fast 响应 → 结果串附 suspended:true；60-agent-loop 识别后挂起本工具
 * 轮次（不往上下文塞错误、不换路），browser_takeover 终态才注入上下文。
 * 非验证页响应原样返回（含成功载荷与其余错误码）。 */
function browserToolWrapCaptcha(raw) {
  try {
    const d = JSON.parse(raw || '{}');
    if (d && d.ok === false && d.error && d.error.code === 'CAPTCHA_REQUIRED') {
      d.suspended = true;
      return JSON.stringify(d);
    }
  } catch (e) { /* 非 JSON：原样返回 */ }
  return raw;
}

/* ================= V1 结果校验框架·前端孪生（v1.8.0 迭代方案 §6 P1）=================
 * 与后端 backend/services/tool_validator.py 同口径的轻量 verdict：工具结果出口
 * （executeTool）统一附 _validation 字段，60-agent-loop 在工具条目渲染「⚠ 校验
 * 存疑」徽标 + suggestion 文案。**只提示不拦截**——重试决策在 Agent/用户。
 * 覆盖四类高频工具：search / open / command / generic（file/software 由后端
 * validator 承载，前端孪生保底 generic 结构校验）。
 */
var V1_STOPWORDS = { 'the':1,'a':1,'an':1,'and':1,'or':1,'of':1,'to':1,'in':1,'on':1,'for':1,'with':1 };
function _v1Tokens(text) {
  const t = String(text || '').toLowerCase();
  const words = (t.match(/[a-z0-9_\.\-\+]{2,}/g) || []).filter(w => !V1_STOPWORDS[w]);
  const bigrams = [];
  const cjk = t.match(/[\u4e00-\u9fff]{2,}/g) || [];
  cjk.forEach(seg => { for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2)); });
  return words.concat(bigrams);
}
function _v1Relevance(query, texts) {
  const q = _v1Tokens(query);
  if (!q.length) return 0.5;
  const corpus = new Set();
  (texts || []).forEach(t => _v1Tokens(t).forEach(x => corpus.add(x)));
  if (!corpus.size) return 0;
  const hit = q.filter(x => corpus.has(x)).length;
  return hit / q.length;
}
function _v1Verdict(ok, kind, confidence, reason, retryable, suggestion) {
  return { ok: !!ok, kind: kind, confidence: Math.round(confidence * 1000) / 1000,
           reason: reason, retryable: !!retryable, suggestion: suggestion || '' };
}
function toolValidateResult(name, result) {
  try {
    const tool = String(name || '').toLowerCase();
    const d = (typeof result === 'string') ? JSON.parse(result || '{}') : (result || {});
    // R57：web_search 分支已删——web_search 是 GLM 端点 provider 级工具（云端
    // 执行，run-controller 注入），永不经过 executeTool 分发（原分支不可达）。
    if (tool === 'browser_search') {
      const rs = d.results || [];
      if (!rs.length) return _v1Verdict(false, 'empty', 0, '搜索结果为空', true, '换引擎或放宽检索条件重试');
      const valid = rs.filter(x => x && x.title && x.url);
      if (!valid.length) return _v1Verdict(false, 'malformed', 0.1, '结果缺少标题或链接', true, '更换引擎重试');
      const rel = _v1Relevance(d.query || '', valid.map(x => String(x.title || '') + ' ' + String(x.snippet || '')));
      if (rel >= 0.34) return _v1Verdict(true, 'ok', Math.min(1, 0.5 + rel), '结果有效且相关');
      if (rel >= 0.12) return _v1Verdict(true, 'thin', rel, '相关度偏低（' + Math.round(rel * 100) + '%）', true, '可精简检索词重试');
      return _v1Verdict(false, 'irrelevant', rel, '相关度不足（' + Math.round(rel * 100) + '%）', true, '精简检索词或换引擎重试');
    }
    if (tool === 'browser_open') {
      const c = String(d.content || '');
      if (d.ok === false) return _v1Verdict(false, 'failed', 0, '打开失败：' + (d.error || '未知'), false, '');
      if (!c.trim()) return _v1Verdict(false, 'empty', 0, '未提取到正文', true, '换来源重试');
      if (c.length < 120) return _v1Verdict(false, 'thin', c.length / 120, '正文过短（导航壳？）', true, '尝试其他结果链接');
      return _v1Verdict(true, 'ok', Math.min(1, c.length / 4000), '正文有效（' + c.length + ' 字符）', false, '');
    }
    if (d.ok === false || d.error) {
      // 修复（2026-10-21）：error 为对象（{code,message}）时取人话字段，
      // 防 String(obj) 渲染成 [object Object]
      const _e = d.error;
      const _em = (typeof _e === 'string') ? _e
        : (_e && typeof _e === 'object') ? String(_e.message || _e.code || JSON.stringify(_e))
        : String(_e || '未知');
      return _v1Verdict(false, 'failed', 0, '工具报告错误：' + _em.slice(0, 80), false, '');
    }
    if (!Object.keys(d).length) return _v1Verdict(true, 'thin', 0.4, '结果为空对象', false, '');
    return _v1Verdict(true, 'ok', 0.7, '结果结构有效', false, '');
  } catch (e) {
    return _v1Verdict(true, 'thin', 0.3, '校验解析异常，按放行处理', false, '');
  }
}

/* V1 渲染：verdict 存疑时在工具条目附「⚠ 校验存疑」徽标（只提示不拦截）。
 * toolDiv 为 60-agent-loop 的 .tool-call-item；ok/thin-ok 不打扰（静默）。 */
function harborRenderValidation(result, toolDiv) {
  try {
    const d = (typeof result === 'string') ? JSON.parse(result || '{}') : (result || {});
    const v = d._validation;
    if (!v || v.ok || !toolDiv) return;
    const cls = v.kind === 'thin' ? 'warn' : 'fail';
    toolDiv.classList.remove('done', 'fail', 'warn');
    toolDiv.classList.add(cls);
    const badge = document.createElement('span');
    badge.className = 'tool-validation-badge';
    badge.title = v.reason + (v.suggestion ? '；建议：' + v.suggestion : '');
    badge.textContent = '⚠ ' + v.reason + (v.suggestion ? '（' + v.suggestion + '）' : '');
    toolDiv.appendChild(badge);
  } catch (e) { /* 渲染失败不影响主流程 */ }
}

/* ================= v1.8.0 §3.3/§4.4 Agent 工具护栏链（2026-10-21）=================
 * browser_ / software 的 guard 前置检查（复刻 62-mcp-exec.js 的 mcpGuardCheck
 * 模式）：guard_check → 弹窗（uiConfirm）→ guard_confirm_token 换一次性 token
 * → 随工具调用回传后端 enforce_exec 校验。
 * 口径：
 * - guard_check 对未注册 op 返回 allow（旧后端零影响）；block → skipped 结果；
 * - confirm → 弹窗（检索词/软件动作全文 + 档位说明）；拒绝 → skipped + 人话
 *   （Agent 可见，不得原样重试）；
 * - session 档「本会话不再提示」存 agentTrusted（op+目标键）；
 * - software_call 的 dangerous 动作：**不进信任缓存**（§4.4 每次确认），由后端
 *   force_always 兜底（token 必须有效一次性）。
 */
const agentTrusted = new Set();
/* 复核批修正：origin 参数——'ai'（Agent 发起，默认）|'user'（设置面板手动
 * 按钮）。手动入口与 AI 走同一护栏链（armed 态 session 档必须换 token），
 * 但确认框措辞不再是「AI 请求」——用户是确认主体。 */
async function agentGuardCheck(op, detail, origin, runSid, realCallApi = callApi) {
  origin = origin || 'ai';
  detail = detail || {};
  // P0-3：护栏检查同样按 run 级 sid 路由（默认参数捕获真实全局——自包含）
  const callApi = (n, a, ms) => realCallApi(n, a, ms, runSid);
  // v1.9.0 M5：浏览器驱动六原语的 target 取值（URL/目标元素/选择器）；
  // 信任键按 op 粒度（session 档语义=同类操作会话内首次确认，非按 URL 逐条）
  const _isBrowserOp = op.indexOf('browser_') === 0;
  const target = String(detail.query || detail.software || detail.url ||
    detail.target || detail.selector || '');
  const trustKey = op + ':' + (_isBrowserOp ? '' : target);
  const dangerous = detail.force_always === true;
  if (!dangerous && agentTrusted.has(String(runSid || '') + '|' + trustKey)) {   // R20：按 sid 键控
    return { blocked: null, decision: 'session-trust', token: null };
  }
  let verdict = { action: 'confirm' };
  try {
    const raw = await callApi('guard_check', [op, JSON.stringify(detail)], 20000);
    verdict = JSON.parse(raw) || {};
  } catch (e) {
    // 后端 guard_check 不可用（旧 exe）：不放行——外部软件执行面 fail-closed；
    // 搜索面 fail-open（信息获取无执行面，旧行为不劣化）。
    if (op === 'software_call') {
      return { blocked: JSON.stringify({ error: '护栏检查不可用（后端可能为旧版，请重新打包）：' + (e.message || e) }), decision: 'deny', token: null };
    }
    return { blocked: null, decision: 'allow', token: null };
  }
  if (verdict.action === 'block') {
    const reason = verdict.reason || ('操作 ' + op + ' 被护栏拦截。');
    toast(reason, 'warn');
    return { blocked: JSON.stringify({ info: reason, skipped: true }), decision: 'deny', token: null };
  }
  if (verdict.action === 'allow') return { blocked: null, decision: 'allow', token: null };

  // action=confirm：弹窗（目标全文 + 档位 + 风险说明）
  const tierName = { always: '每次确认', session: '会话内首次确认', off: '不确认' };
  const _ask = (origin === 'ai') ? 'AI 请求' : '';   // 手动入口：用户即确认主体
  let body;
  if (op === 'web_search') {
    body = _ask + '执行浏览器搜索：\n检索词：' + target +
      '\n档位：' + (tierName[verdict.tier] || verdict.tier || '?') +
      '\n\n将通过内置浏览器窗口访问搜索引擎并提取结果（外联走应用进程，审计可见）。';
  } else if (_isBrowserOp) {
    // v1.9.0 M5：浏览器驱动六原语确认文案（click/fill=always 每次确认）
    const _bLabel = { browser_navigate: '导航到页面', browser_extract: '提取页面内容',
      browser_snapshot: '获取语义快照',   // R57：原缺 snapshot，确认框回退裸 op 名
      browser_click: '点击页面元素', browser_fill: '填充表单字段',
      browser_screenshot: '截取页面', browser_close: '关闭浏览器会话' };
    body = _ask + '浏览器操作：' + (_bLabel[op] || op) +
      (target ? '\n目标：' + target : '') +
      '\n档位：' + (tierName[verdict.tier] || verdict.tier || '?') +
      ((op === 'browser_click' || op === 'browser_fill')
        ? '\n\n页面交互会作用于真实网站（点击/提交/输入），请确认目标无误。' : '');
  } else {
    body = _ask + '调用外部软件：\n软件：' + String(detail.software || '') +
      '\n动作：' + String(detail.action || '') +
      (dangerous ? '\n风险：高危动作（dangerous）——每次都需要确认' : '') +
      '\n参数：\n' + JSON.stringify(detail.args || {}, null, 2).slice(0, 2000) +
      '\n\n外部软件可在本机执行操作，请确认你信任此调用。';
  }
  const r = await uiConfirm({
    title: op === 'web_search' ? '确认执行浏览器搜索'
      : (_isBrowserOp ? '确认浏览器操作' : '确认调用外部软件'),
    body, danger: dangerous || verdict.tier === 'always',
    // P0-4 T03：来源会话徽标（并行 run 区分）；typeof 守卫——vm 沙箱单模块加载
    // （无 overlays.js）时降级为无徽标，真实构建恒有定义（同 toolValidateResult 口径）
    sessionLabel: (typeof _confirmSessionLabel === 'function') ? _confirmSessionLabel(runSid) : '',
    okText: '允许执行',
    checkboxLabel: dangerous ? null : '本会话内不再提示同类操作'
  });
  if (!r.ok) {
    const msg = (op === 'web_search'
      ? '用户拒绝了本次浏览器搜索。请调整检索方案或询问用户意图，不要原样重试。'
      : _isBrowserOp
      ? '用户拒绝了本次浏览器操作（' + op + '）。请调整方案或询问用户意图，不要原样重试。'
      : '用户拒绝了本次外部软件调用（' + String(detail.software || '') + ' · ' + String(detail.action || '') + '）。请调整方案或询问用户意图，不要原样重试。');
    toast('已拒绝 AI 的本次调用', 'ok');
    return { blocked: JSON.stringify({ info: msg, skipped: true }), decision: 'deny', token: null };
  }
  if (r.checkbox && !dangerous) {
    // 修复（对抗复审）：原 fire-and-forget 登记（callApi(...).catch(()=>{})）——
    // 桥异常/旧后端无此方法时后端没登记成功，前端 Set 却已加：后续调用被前端
    // 短路（agentTrusted.has → 不弹窗、token=null）→ 后端 enforce_exec 武装态
    // 拒（「需用户在界面确认…未携带有效 token」）→ AI 见到错误原样重试 → 再被
    // 拒，形成无 UI 确认路径的死循环（用户唯一解法是重启应用）。
    // 改为 await 登记，成功才进前端 Set；失败保持「每次确认」——降级为多弹一次
    // 窗，绝不在前端假装信任。
    try {
      await callApi('guard_session_trust', [op], 20000);
      agentTrusted.add(String(runSid || '') + '|' + trustKey);
    } catch (e) { /* 登记失败：不进前端信任——下次仍走确认弹窗，由用户重新勾选重试 */ }
  }
  // 换一次性 confirm token（op 级；detail 摘要与后端 enforce 同口径）
  let token = null;
  try {
    const t = JSON.parse(await callApi('guard_confirm_token', [op, JSON.stringify(detail)], 20000));
    // 复核修正（真机实锤）：api 层 ok() 只序列化不加 ok 键——后端返回
    // {token,ttl}，原 `t.ok && t.token` 判定恒假 → token 永不生效，armed 态
    // 全部确认流（AI+面板手动）死循环在 CONFIRM_REQUIRED。vm 测试桩返回带
    // ok 键故测试全绿（环境差异盲区）。只认 token 字段即可。
    if (t && t.token) token = t.token;
  } catch (e) { /* 无 token：后端武装态会拒，未武装态放行（legacy 兼容） */ }
  return { blocked: null, decision: 'allow', token: token };
}
