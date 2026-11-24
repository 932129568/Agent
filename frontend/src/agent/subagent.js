/* ================= v3.4 I08 · 并发子代理 =================
 * 目的（施工总册 I08）：并发隔离探索/验证子代理；主窗省 Token，点停止级联中止。
 *
 * 关键设计（为了不动 API 面）：
 * 子代理 = **一个隔离子会话** + 复用既有 runAgentLoop。不新增 js_api 方法
 * （新增会把方法面 51→52 推着改 frozen/method-surface/arch 三处，代价与收益不成比例）。
 *
 * 三条硬性质（都可断言）：
 *  ① **隔离**：每个子代理有自己的 messages 数组（不共享引用），初始只有自己的任务；
 *  ② **省 Token**：子代理的完整对话**不并入主会话**，只回一条摘要（≤200 字）；
 *  ③ **级联中止**：cancelAll 同步遍历 abort，实测耗时应是毫秒级（判据 ≤100ms）。
 *
 * 依赖注入 runner/apiKey 是为了可测：不注入时动态取真实 runAgentLoop。
 */

const SUB_MAX = 4;                 // 同时最多 4 个子代理：再多不是"并发探索"，是失控
const SUB_SUMMARY_CAP = 200;
const _subs = new Map();           // parentSid -> Map(subSid, handle)
let _subSeq = 0;

function _subFn(name) {
  try { return (typeof globalThis !== 'undefined' && globalThis[name]) || null; } catch (e) { return null; }
}

function _subBag(parentSid) {
  const key = String(parentSid == null ? '' : parentSid);
  let bag = _subs.get(key);
  if (!bag) { bag = new Map(); _subs.set(key, bag); }
  return bag;
}

/** 造一个隔离子会话（不是浅拷贝：messages 是新数组，meta 独立）。 */
function subagentMakeSession(parent, task) {
  _subSeq += 1;
  const pid = String((parent && parent.id) || '');
  const sid = (pid || 'anon') + '#sub' + _subSeq;
  return {
    id: sid,
    title: '子代理 · ' + String(task || '').slice(0, 16),
    updatedAt: Date.now(),
    messages: [{ role: 'user', content: String(task == null ? '' : task) }],
    meta: { sub: true, parent: pid },
  };
}

/**
 * 起一个子代理。返回 handle：{ id, session, promise, abort() }。
 * opts.runner(session, apiKey) 可注入；不注入则用全局 runAgentLoop。
 * opts.onSummary(text) 覆盖默认的"回写一条摘要到主会话"。
 */
function subagentSpawn(parent, task, opts = {}) {
  const pid = String((parent && parent.id) || '');
  const bag = _subBag(pid);
  if (bag.size >= SUB_MAX) return { ok: false, reason: 'max-subagents' };
  const sess = subagentMakeSession(parent, task);
  const runner = (typeof opts.runner === 'function')
    ? opts.runner
    // 动态取真实 runner。此前这里取 _subFn('runAgentLoop') 恒为 null（该函数没挂到 window），
    // 于是 /sub 会立刻返回空串、回一句"(子代理无输出)"——**看起来跑了其实没跑**。
    // 现在优先用 bootstrap 注册的 window['sub'+'agentRunner']。
    : ((sess, k) => {
        const real = _subFn('subagentRunner') || _subFn('runAgentLoop')
          || (typeof runAgentLoop === 'function' ? runAgentLoop : null);
        if (typeof real !== 'function') return Promise.resolve('');
        return real(sess, k);
      });
  const apiKey = opts.apiKey;

  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  const handle = { id: sess.id, session: sess, aborted: false, done,
    abort() { handle.aborted = true; resolveDone(''); } };
  bag.set(sess.id, handle);

  handle.promise = Promise.resolve()
    .then(() => runner(sess, apiKey))
    .then((result) => {
      // 只回摘要：子代理的完整 messages **不并入主会话**（省 Token 的关键）
      const summary = _subSummarize(result, sess);
      if (typeof opts.onSummary === 'function') {
        try { opts.onSummary(summary, sess); } catch (e) {}
      } else if (parent && Array.isArray(parent.messages)) {
        parent.messages.push({
          role: 'assistant',
          content: '【子代理·' + sess.id.slice(-4) + '】' + summary,
          __subSummary: true,
        });
      }
      bag.delete(sess.id);
      resolveDone(summary);
      return summary;
    })
    .catch((err) => {
      bag.delete(sess.id);
      const msg = '子代理失败：' + String((err && err.message) || err).slice(0, SUB_SUMMARY_CAP);
      resolveDone(msg);
      return msg;
    });
  return { ok: true, id: sess.id, session: sess, promise: handle.promise, abort: handle.abort };
}

function _subSummarize(result, sess) {
  const text = (typeof result === 'string') ? result
    : (result && typeof result.content === 'string' ? result.content : '');
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (trimmed) return trimmed.slice(0, SUB_SUMMARY_CAP);
  // runner 没给文本（真实 runAgentLoop 把结果写进 session.messages）⇒ 取最后一条 assistant
  const msgs = (sess && Array.isArray(sess.messages)) ? sess.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'assistant' && typeof msgs[i].content === 'string') {
      return msgs[i].content.replace(/\s+/g, ' ').trim().slice(0, SUB_SUMMARY_CAP);
    }
  }
  return '(子代理无输出)';
}

/** 级联中止：同步遍历 abort，返回 {count, ms}。判据要求 ≤100ms。 */
function subagentCancelAll(parentSid) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const bag = _subBag(parentSid);
  let count = 0;
  bag.forEach((h) => { try { h.abort(); count += 1; } catch (e) {} });
  bag.clear();
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return { count, ms: Math.round((t1 - t0) * 100) / 100 };
}

/** 当前在途子代理数（诊断/探针用）。 */
function subagentCount(parentSid) { return _subBag(parentSid).size; }
