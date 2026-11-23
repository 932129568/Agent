/* ================= v3.4 I11 · 零双写分支树（非破坏式） =================
 * 目的（施工总册 I11）：把「销毁式 splice」升级为零双写分支树，支持二级嵌套分支切换。
 * 判据：支持二级嵌套分支切换，且保 R99 判据零爆仓（不破坏既有消息语义）。
 *
 * 为什么选"尾巴搬家"而不是把 messages 换成 DAG：
 * 全仓有太多地方直接读写 `s.messages`（rewind 快照、锚点压缩、步骤检查点、
 * renderChatHistory、上下文装配…）。把 messages 改成 DAG 等于同时动这十几处，
 * 风险远大于收益。这里采用：
 *   · `s.messages` **仍是当前活动路径**（既有代码一行不用改）；
 *   · 被切掉的尾巴存进 `s.branches[id].tail`（零双写：同一时刻只有一份在活动路径上）；
 *   · 分支用 `parent` 串成树 ⇒ 天然支持二级/多级嵌套。
 * 这样"销毁"变"搬家"：切走的分支随时能切回来，内容不丢。
 */

const BRANCH_MAX_DEPTH = 3;      // 判据只要求二级；留一级余量，超过就拒绝（防无限套娃）

function _brOf(s) {
  if (!s) return null;
  if (!s.branches || typeof s.branches !== 'object') s.branches = {};
  if (!Array.isArray(s.branchStack)) s.branchStack = [];   // 当前路径（栈顶是当前分支）
  return s.branches;
}

/** 造分支 id（稳定、可读、不依赖时间戳语义）。 */
function _brId(s, at) {
  const n = Object.keys(s.branches || {}).length + 1;
  return 'b' + n + '@' + at;
}

/**
 * 在 atIdx 处分叉：把 (atIdx, end] 的尾巴存成新分支，活动路径截到 atIdx（含）。
 * 返回 {ok, id, moved} 或 {ok:false, reason}。
 */
function branchFork(session, atIdx, name) {
  const br = _brOf(session);
  if (!br) return { ok: false, reason: 'no-session' };
  const idx = Number(atIdx);
  const msgs = session.messages;
  if (!Array.isArray(msgs)) return { ok: false, reason: 'no-messages' };
  if (!Number.isFinite(idx) || idx < 0 || idx >= msgs.length - 1) return { ok: false, reason: 'nothing-to-fork' };
  const depth = session.branchStack.length;
  if (depth + 1 > BRANCH_MAX_DEPTH) return { ok: false, reason: 'max-depth' };
  const id = _brId(session, idx);
  const tail = msgs.slice(idx + 1);
  br[id] = { id, parent: session.branchStack[session.branchStack.length - 1] || '', at: idx,
    // 记录分叉点当时的**活动数组长度**：切换时必须用它校验，否则 at 在长度不同的
    // 分支之间是不可比的（实测切到另一分支会拼出 [q1,a1,q2] 这种半截内容 = 静默污染）。
    forkLen: msgs.length,
    // 分叉点的**前缀快照**：只有它能在"目标分支与当前路径长度不同"时精确重建。
    // 代价是分支各自持有一份前缀副本（内存换正确性）——这点在文件头已注明。
    prefix: msgs.slice(0, idx + 1),
    name: String(name || '').slice(0, 40), tail };
  session.branchStack.push(id);
  msgs.splice(idx + 1);
  session.updatedAt = Date.now();
  return { ok: true, id, moved: tail.length };
}

/**
 * 切到某分支：先把**当前**活动路径的尾巴存回当前分支（保持零双写），再装载目标分支的尾巴。
 * 返回 {ok, from, to, restored}。
 */
function branchSwitch(session, branchId) {
  const br = _brOf(session);
  if (!br) return { ok: false, reason: 'no-session' };
  const target = br[branchId];
  if (!target) return { ok: false, reason: 'unknown-branch' };
  const curId = session.branchStack[session.branchStack.length - 1] || '';
  const msgs = session.messages;
  if (!Array.isArray(msgs)) return { ok: false, reason: 'no-messages' };
  // 切到**当前分支自己**必须是空操作：此时活动路径已被截断，
  // 若仍执行"存回尾巴"，就会用空数组覆盖掉原本存好的 tail（实测 4 条消息丢成 2 条）。
  if (branchId === curId) return { ok: true, from: curId, to: curId, restored: 0, noop: true };
  const cur = curId ? br[curId] : null;
  // 1) 当前路径的尾巴存回当前分支（仅在真正切换时）
  if (cur && cur.at >= 0 && cur.at < msgs.length) {
    cur.tail = msgs.slice(cur.at + 1);
  }
  // 2) 截到目标分支的分叉点，再装载它的尾巴
  // 用目标分支的 prefix + tail 精确重建活动路径。
  // 早先按 `at` 下标拼接的做法在跨长度分支时会拼出半截内容（实测 [q1,a1,q2]），
  // 属静默污染；改为快照重建后不再依赖"两边长度一致"这个脆弱前提。
  const prefix = Array.isArray(target.prefix) ? target.prefix.slice() : null;
  if (!prefix) return { ok: false, reason: 'no-prefix-snapshot' };
  const restored = Array.isArray(target.tail) ? target.tail.slice() : [];
  msgs.length = 0;
  for (const m of prefix) msgs.push(m);
  for (const m of restored) msgs.push(m);
  // 零双写：装载后清空该分支的 tail（它已经在活动路径里了）
  target.tail = [];
  // 3) 分支栈：切到目标；若目标是当前分支的祖先，则截断栈，否则压栈
  const pos = session.branchStack.indexOf(branchId);
  if (pos >= 0) session.branchStack.length = pos + 1;
  else session.branchStack.push(branchId);
  session.updatedAt = Date.now();
  return { ok: true, from: curId, to: branchId, restored: restored.length };
}

/** 列出分支（含深度，便于 UI 显示层级）。 */
function branchList(session) {
  const br = _brOf(session);
  if (!br) return [];
  const depthOf = (id) => {
    let d = 1; let p = br[id] && br[id].parent;
    let guard = 0;
    while (p && br[p] && guard++ < 10) { d += 1; p = br[p].parent; }
    return d;
  };
  return Object.keys(br).map(id => ({
    id, name: br[id].name, parent: br[id].parent, at: br[id].at,
    tail: Array.isArray(br[id].tail) ? br[id].tail.length : 0, depth: depthOf(id),
  }));
}

/**
 * 分支现状读数（诊断用）。
 * ⚠ 不用它判"零丢失"：每个分支各持一份 prefix 副本，跨分支的前缀是重叠的，
 * 所以 active + Σtails 会大于原始条数（实测 6 条历史切到二级后 total=7）。
 * 零丢失的判据是**往返精确性**：切走再切回，活动路径必须逐条等于切走前。
 */
function branchIntegrity(session) {
  const br = _brOf(session);
  if (!br) return { ok: false };
  const active = Array.isArray(session.messages) ? session.messages.length : 0;
  let tails = 0;
  Object.keys(br).forEach(id => { tails += Array.isArray(br[id].tail) ? br[id].tail.length : 0; });
  return { ok: true, active, tails, branches: Object.keys(br).length,
    note: 'prefix 副本跨分支重叠，total 不是丢失指标；零丢失看往返精确性' };
}
