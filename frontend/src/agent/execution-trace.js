/* ================= R101 T03 · 执行轨迹聚合（execution-trace） =================
 * 职责：把「一轮 run 里的工具调用」聚合成可读的步骤序列，供消息底部与右侧副屏共用。
 *
 * 单向依赖（架构文档硬要求）：**run-controller → 本模块**，本模块不得反指
 * run-controller / markdown。原因：SCC 棘轮 17/104 零余量，一旦反向引用就成环，
 * scc-ratchet 立刻红。因此这里只做纯数据 + 纯渲染，不订阅任何事件、不碰 run 状态机。
 *
 * 数据形状（步骤）：
 *   { i, round, name, ok, status, summary, ts }
 *   status: 'ok' | 'fail' | 'pending'
 * ok 与 status 同时保留：ok 是布尔判定（便于计数），status 是展示态（便于以后加 pending）。
 */

const EXEC_TRACE = {
  sid: '',
  steps: [],
  startedAt: 0,
};

/** 一轮 run 开始时重置（同一会话内多次 run 不复用旧轨迹）。 */
function traceReset(sid) {
  EXEC_TRACE.sid = String(sid == null ? '' : sid);
  EXEC_TRACE.steps.length = 0;
  EXEC_TRACE.startedAt = Date.now();
}

/** 从工具名里取一个可读短名：mcp__foo__bar -> foo.bar，其余原样。 */
function _traceShortName(name) {
  const n = String(name || '工具');
  if (n.indexOf('mcp__') === 0) {
    const parts = n.split('__').filter(Boolean);
    if (parts.length >= 3) return parts[1] + '.' + parts.slice(2).join('_');
  }
  return n;
}

/** 从工具结果里判定成功/失败。结果可能是字符串（含 ok:false 的 JSON）或对象。 */
function _traceVerdict(result) {
  if (result == null) return { ok: true, summary: '' };
  if (typeof result === 'string') {
    const s = result.trim();
    if (!s) return { ok: true, summary: '' };
    // 只认结构化失败标记；不去猜自然语言（那会把「执行失败」这类正文误判，
    // 也会把 ok:true 但内容里提到 error 的正常结果判红）。
    if (/^\s*\{/.test(s)) {
      try {
        const o = JSON.parse(s);
        if (o && (o.ok === false || o.error || o.blocked)) {
          return { ok: false, summary: String(o.error || o.info || o.blocked || '').slice(0, 80) };
        }
        if (o && o.ok === true) return { ok: true, summary: '' };
      } catch (e) { /* 非 JSON：按成功处理，摘要留空 */ }
    }
    return { ok: true, summary: '' };
  }
  if (typeof result === 'object') {
    if (result.ok === false || result.error || result.blocked) {
      return { ok: false, summary: String(result.error || result.info || result.blocked || '').slice(0, 80) };
    }
  }
  return { ok: true, summary: '' };
}

/**
 * 记录一轮工具结果。由 run-controller 的 onToolResults 调用。
 * @param {{toolCalls?:Array, results?:Array, round?:number}} payload
 */
function traceAddToolRound(payload) {
  const p = payload || {};
  const calls = Array.isArray(p.toolCalls) ? p.toolCalls : [];
  const results = Array.isArray(p.results) ? p.results : [];
  // 类别由调用方（run-controller）给出，本模块不反向依赖 tool-runtime
  // —— trace 要保持零依赖，否则会和 run-controller 形成环（SCC 零余量）。
  const cats = Array.isArray(p.categories) ? p.categories : [];
  const n = Math.max(calls.length, results.length);
  for (let k = 0; k < n; k++) {
    const call = calls[k] || {};
    const rawName = (call.function && call.function.name) || call.name || call.tool || '';
    const v = _traceVerdict(results[k]);
    EXEC_TRACE.steps.push({
      i: EXEC_TRACE.steps.length,
      round: Number(p.round || 0),
      name: _traceShortName(rawName),
      cat: String(cats[k] || 'other'),
      ok: v.ok,
      status: v.ok ? 'ok' : 'fail',
      summary: v.summary,
      ts: Date.now(),
    });
  }
}

/** 聚合快照（副屏与消息底栏都用它，保证两处数字同源）。 */
function traceSnapshot() {
  const steps = EXEC_TRACE.steps;
  const byName = {};
  let ok = 0;
  let fail = 0;
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    byName[s.name] = (byName[s.name] || 0) + 1;
    if (s.ok) ok++; else fail++;
  }
  return {
    sid: EXEC_TRACE.sid,
    total: steps.length,
    ok: ok,
    fail: fail,
    byName: byName,
    elapsedMs: EXEC_TRACE.startedAt ? (Date.now() - EXEC_TRACE.startedAt) : 0,
    steps: steps.slice(),
  };
}

/**
 * 渲染成紧凑列表（返回 HTML 字符串）。
 * 所有来自工具名/错误的文本一律走 textContent 之外的转义，避免注入。
 */
function traceRenderHtml(limit) {
  const snap = traceSnapshot();
  const max = Number(limit) > 0 ? Number(limit) : 8;
  if (!snap.total) {
    return '<div class="et-empty">本轮暂无工具调用</div>';
  }
  const rows = snap.steps.slice(-max).map(s => {
    const cls = s.ok ? 'ok' : 'fail';
    const mark = s.ok ? '✓' : '✗';
    return '<div class="et-row ' + cls + '">' +
      '<span class="et-mark">' + mark + '</span>' +
      '<span class="et-cat" data-cat="' + _traceEscAttr(s.cat || 'other') + '"></span>' +
      '<span class="et-name"></span>' +
      '<span class="et-sum"></span>' +
      '</div>';
  }).join('');
  const head = '<div class="et-head">' +
    '<span class="et-count">' + snap.total + ' 步</span>' +
    (snap.fail ? '<span class="et-bad">' + snap.fail + ' 失败</span>' : '<span class="et-allok">全部成功</span>') +
    '</div>';
  return head + '<div class="et-list">' + rows + '</div>' +
    (snap.total > max ? '<div class="et-more">另有 ' + (snap.total - max) + ' 步未显示</div>' : '');
}

/** 渲染进宿主元素（文本用 textContent 写入，HTML 只用骨架）。 */
function traceRenderInto(el, limit) {
  if (!el || typeof document === 'undefined') return;
  const snap = traceSnapshot();
  const max = Number(limit) > 0 ? Number(limit) : 8;
  el.innerHTML = traceRenderHtml(limit);
  const rows = el.querySelectorAll('.et-row');
  const shown = snap.steps.slice(-max);
  for (let k = 0; k < rows.length && k < shown.length; k++) {
    const s = shown[k];
    const nameEl = rows[k].querySelector('.et-name');
    const sumEl = rows[k].querySelector('.et-sum');
    const catEl = rows[k].querySelector('.et-cat');
    if (catEl) catEl.textContent = toolCategoryLabel(s.cat || 'other');
    if (nameEl) nameEl.textContent = s.name;
    if (sumEl) sumEl.textContent = s.summary || '';
  }
}

/** 类别属性值只需允许的短标识，避免把工具名当属性值注入。 */
function _traceEscAttr(v) {
  return String(v == null ? 'other' : v).replace(/[^a-z]/g, '') || 'other';
}
