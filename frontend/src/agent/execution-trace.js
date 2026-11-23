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

/* I02（v3.4）：原实现是**单全局** {sid, steps, startedAt} —— 两个会话并行跑工具时，
 * 后一轮 traceReset 会把前一会话的步骤清空（互毁），而且 traceRenderInto 不带 sid，
 * 谁都可能把别人的轨迹渲染到自己的消息底部。
 * 现改为 Map<sid, state> 隔离；无 sid 调用回落「最后一次 reset 的会话」，保证旧调用点零改动。 */
const EXEC_TRACE = new Map();
let _traceLastSid = '';

function _traceState(sid, create) {
  let key = String(sid == null ? '' : sid);
  if (!key) key = _traceLastSid;
  let st = key ? EXEC_TRACE.get(key) : null;
  if (!st && create && key) {
    st = { sid: key, steps: [], startedAt: Date.now() };
    EXEC_TRACE.set(key, st);
  }
  return st || null;
}

/** 一轮 run 开始时重置该会话的轨迹（只影响这个 sid）。 */
function traceReset(sid) {
  const key = String(sid == null ? '' : sid);
  if (!key) return;
  _traceLastSid = key;
  EXEC_TRACE.set(key, { sid: key, steps: [], startedAt: Date.now() });
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
  const st = _traceState(p.sid, true);
  if (!st) return;   // 既没传 sid 也从没 reset 过：静默不记（不污染别的会话）
  const calls = Array.isArray(p.toolCalls) ? p.toolCalls : [];
  const results = Array.isArray(p.results) ? p.results : [];
  // 类别由调用方（run-controller）给出，本模块不反向依赖 tool-runtime
  // —— trace 要保持零依赖，否则会和 run-controller 形成环（SCC 零余量）。
  const cats = Array.isArray(p.categories) ? p.categories : [];
  const prevTs = st.steps.length ? st.steps[st.steps.length - 1].ts : st.startedAt;
  const n = Math.max(calls.length, results.length);
  for (let k = 0; k < n; k++) {
    const call = calls[k] || {};
    const rawName = (call.function && call.function.name) || call.name || call.tool || '';
    const v = _traceVerdict(results[k]);
    const now = Date.now();
    st.steps.push({
      i: st.steps.length,
      round: Number(p.round || 0),
      name: _traceShortName(rawName),
      cat: String(cats[k] || 'other'),
      ok: v.ok,
      status: v.ok ? 'ok' : 'fail',
      summary: v.summary,
      ts: now,
      // 单步耗时：与上一步（或本轮起点）的间隔。只用于展示，不参与任何判定。
      ms: Math.max(0, now - prevTs),
    });
  }
}

/** 聚合快照（副屏与消息底栏都用它，保证两处数字同源）。 */
function traceSnapshot(sid) {
  const st = _traceState(sid, false);
  const steps = st ? st.steps : [];
  const byName = {};
  let ok = 0;
  let fail = 0;
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    byName[s.name] = (byName[s.name] || 0) + 1;
    if (s.ok) ok++; else fail++;
  }
  return {
    sid: st ? st.sid : '',
    total: steps.length,
    ok: ok,
    fail: fail,
    byName: byName,
    elapsedMs: (st && st.startedAt) ? (Date.now() - st.startedAt) : 0,
    steps: steps.slice(),
  };
}

/**
 * 渲染成紧凑列表（返回 HTML 字符串）。
 * 所有来自工具名/错误的文本一律走 textContent 之外的转义，避免注入。
 */
function traceRenderHtml(limit, sid) {
  const snap = traceSnapshot(sid);
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
  // I26：SVG 能量脊柱——每步一段竖条，成功/失败上色，高度按步序递增。
  // 段数 === 步数（可断言），不是装饰性曲线。
  const segs = snap.steps.slice(-max).map((st, i) => {
    const h = 4 + Math.round((i + 1) * (16 / Math.max(1, Math.min(max, snap.steps.length))));
    const y = 20 - h;
    const cls = st.ok ? 'ok' : 'fail';
    return '<rect class="et-sp ' + cls + '" x="' + (i * 3) + '" y="' + y + '" width="2" height="' + h + '" rx="1"></rect>';
  }).join('');
  const spine = '<svg class="et-spine" width="' + Math.max(1, Math.min(max, snap.steps.length)) * 3 + '" height="20" ' +
    'viewBox="0 0 ' + Math.max(1, Math.min(max, snap.steps.length)) * 3 + ' 20" aria-hidden="true">' + segs + '</svg>';
  const head = spine + '<div class="et-head">' +
    '<span class="et-count">' + snap.total + ' 步</span>' +
    (snap.fail ? '<span class="et-bad">' + snap.fail + ' 失败</span>' : '<span class="et-allok">全部成功</span>') +
    '</div>';
  return head + '<div class="et-list">' + rows + '</div>' +
    (snap.total > max ? '<div class="et-more">另有 ' + (snap.total - max) + ' 步未显示</div>' : '');
}

/** 渲染进宿主元素（文本用 textContent 写入，HTML 只用骨架）。 */
function traceRenderInto(el, limit, sid) {
  if (!el || typeof document === 'undefined') return;
  const snap = traceSnapshot(sid);
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

/* I02 · 轨迹持久化：写进 session.meta.trace，重开/重启后可复原。
 * 只存摘要（最多 50 步、每条只留名字/类别/成败/摘要 80 字），不存正文——
 * 轨迹是"发生过什么"的索引，不是内容仓库，塞全文会让 sessions.json 膨胀。 */
function traceAttachTo(session, sid) {
  if (!session || typeof session !== 'object') return null;
  const snap = traceSnapshot(sid);
  if (!snap.total) return null;
  const trimmed = snap.steps.slice(-50).map(s => ({
    name: s.name, cat: s.cat, ok: s.ok, summary: String(s.summary || '').slice(0, 80), ms: s.ms,
  }));
  session.meta = session.meta || {};
  session.meta.trace = { sid: snap.sid, total: snap.total, ok: snap.ok, fail: snap.fail, steps: trimmed, at: Date.now() };
  return session.meta.trace;
}

/** 从 session.meta.trace 复原到内存 Map（幂等：已有该会话轨迹则不覆盖）。 */
function traceHydrateFrom(session) {
  if (!session || !session.meta || !session.meta.trace) return 0;
  const t = session.meta.trace;
  const key = String(t.sid || session.id || '');
  if (!key) return 0;
  // 只在「已有真实步骤」时跳过；traceReset 会留下空条目，那种情况必须允许复原覆盖，
  // 否则「重开会话复原轨迹」会被一次空 reset 永久挡住（用例已踩到）。
  const exist = EXEC_TRACE.get(key);
  if (exist && exist.steps && exist.steps.length) return 0;
  const steps = (Array.isArray(t.steps) ? t.steps : []).map((s, i) => ({
    i, round: 0, name: String(s.name || '工具'), cat: String(s.cat || 'other'),
    ok: !!s.ok, status: s.ok ? 'ok' : 'fail', summary: String(s.summary || ''),
    ts: Number(s.at) || 0, ms: Number(s.ms) || 0,
  }));
  EXEC_TRACE.set(key, { sid: key, steps, startedAt: Number(t.at) || Date.now() });
  _traceLastSid = key;
  return steps.length;
}
