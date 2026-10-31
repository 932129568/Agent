/* ================= Token 统计 ================= */
const MODEL_PRICE = {
  'glm-5.3-flashx': { in: 2, out: 7, cache: 0.57 },
  'glm-5.3-flash': { in: 0.8, out: 2.8, cache: 0.23 },
  // 智谱官方免费/普惠模型：按 0 计价，避免回落至 5.3-flashx 付费表。
  'glm-4.7-flash': { in: 0, out: 0, cache: 0 }
};
function calcUsage(messages) {
  let total = 0, cached = 0, cost = 0, costStdIn = 0, costCache = 0, costOut = 0;
  (messages || []).forEach(m => {
    if (!m.usage) return;
    const u = m.usage;
    const p = providerPriceFor(u.model);   // v1.2 R6：按模型/自定义端点价格表
    const prompt = u.prompt_tokens || 0;
    const comp = u.completion_tokens || 0;
    const c = u.prompt_tokens_details?.cached_tokens || 0;
    total += u.total_tokens || (prompt + comp);
    cached += c;
    costStdIn += (prompt - c) * p.in / 1e6;
    costCache += c * p.cache / 1e6;
    costOut += comp * p.out / 1e6;
    cost = costStdIn + costCache + costOut;
  });
  return { total, cached, cost, costStdIn, costCache, costOut };
}

/**
 * 修复 S8（二轮）：会话级单调花费计数器——usage 到达时累加，归档/compact 物理删消息不清零，
 * 预算硬停与 30 万提醒不再被压缩机制「洗白」（原 calcUsage 只对现存消息求和，
 * 花到预算线 → archive 删历史 → 显示归零 → 继续烧）。
 */
function accumulateUsage(s, u) {
  if (!s || !u) return;
  const p = providerPriceFor(u.model);
  const prompt = u.prompt_tokens || 0;
  const comp = u.completion_tokens || 0;
  const c = u.prompt_tokens_details?.cached_tokens || 0;
  s._spentCost = (s._spentCost || 0) + ((prompt - c) * p.in / 1e6 + c * p.cache / 1e6 + comp * p.out / 1e6);
  s._spentTokens = (s._spentTokens || 0) + (u.total_tokens || (prompt + comp));
}
/** 读会话累计花费（老会话无计数器时用现存消息 seed 一次，之后单调递增）。 */
function sessionSpent(s) {
  if (!s) return { cost: 0, tokens: 0 };
  if (s._spentCost === undefined) {
    const c = calcUsage(s.messages);
    s._spentCost = c.cost;
    s._spentTokens = c.total;
  }
  return { cost: s._spentCost, tokens: s._spentTokens };
}
/**
 * 修复 TOK-1（v1.4）：暴露上轮 cache 命中率，供 40-auto-compact 双条件压缩决策
 * （缓存优先：命中率高时前缀稳定，不触发 splice 式破坏压缩）。
 * 自定义端点无缓存计价时 __hitRate 恒 0 → 调用方退化为仅 token 阈值。
 */
function lastCacheHitRate() {
  return (typeof window.__hitRate === 'number') ? window.__hitRate : 0;
}
function updateTokenStat() {
  const el = document.getElementById('tokenStat');
  if (!el) return;
  if (backendWarning) { el.style.color = 'var(--err)'; el.textContent = backendWarning; return; }
  el.style.color = '';
  let allMsgs = [];
  sessions.forEach(s => { allMsgs = allMsgs.concat(s.messages); });
  const { total, cached, cost } = calcUsage(allMsgs);
  el.textContent = total > 0
    ? `全部会话: ${total.toLocaleString()} tokens | 缓存命中 ${cached.toLocaleString()}${cacheFoldText()} | 实际 ¥${cost.toFixed(4)}`
    : '';
}
/**
 * 修复 ㊴：缓存折扣从价格表实时计算（原硬编码“约 2.9 折”与实际价格脱钩）。
 * 取最近一次用量所属模型的价格：cache价/in价 × 10 → 折。无价格数据时返回空串。
 */
function cacheFoldText() {
  let model = null;
  outer: for (let i = sessions.length - 1; i >= 0; i--) {
    const msgs = (sessions[i] && sessions[i].messages) || [];
    for (let j = msgs.length - 1; j >= 0; j--) {
      if (msgs[j] && msgs[j].usage && msgs[j].usage.model) { model = msgs[j].usage.model; break outer; }
    }
  }
  if (!model) return '';
  const p = providerPriceFor(model);
  if (!p.in || p.in <= 0) return '';
  const fold = p.cache / p.in * 10;
  if (!(fold > 0) || fold >= 10) return '';
  return `（缓存价约 ${fold.toFixed(1)} 折）`;
}
function updateLiveTokenStat() {
  const el = document.getElementById('liveTokenStat');
  if (!el) return;
  const s = getCurrentSession();
  if (!s) { el.textContent = '当前对话: 0 tokens'; return; }
  const { total, cached, cost, costStdIn, costCache, costOut } = calcUsage(s.messages);
  if (total <= 0) { el.textContent = '当前对话: 0 tokens'; return; }
  // v1.5 A4：本地模式会话头部切「本地 · 0 费用」（价格表对本地短路，三价不显示）
  if (localState && localState.mode && localState.base_url) {
    const turnL = window.__turnTokens ? ` | 本轮 ${window.__turnTokens.toLocaleString()}` : '';
    el.style.color = '';
    el.textContent = `本地 · 0 费用 | ${total.toLocaleString()} tokens${turnL}`;
    return;
  }
  const budget = sessionBudget();
  const over = budget > 0 && cost > budget;
  el.style.color = over ? 'var(--err)' : '';
  const turn = window.__turnTokens ? ` | 本轮 ${window.__turnTokens.toLocaleString()}` : '';
  const warn = over
    ? ` ⛔ 已超单会话预算 ¥${budget.toFixed(2)}（已自动暂停，可在对话内提高预算或终止）`
    : (total > 80000 ? ' △ 建议新开会话' : '');
  // v1.2 R5：会话头部实时「约花费 ¥X」，三价细分（标准输入/缓存命中/输出）
  const breakdown = `（标准 ¥${costStdIn.toFixed(3)} · 缓存 ¥${costCache.toFixed(3)} · 输出 ¥${costOut.toFixed(3)}）`;
  el.textContent = `本会话约花费 ¥${cost.toFixed(4)}${breakdown} | ${total.toLocaleString()} tokens | 缓存命中 ${cached.toLocaleString()}（${window.__hitRate || 0}%）${turn}${warn}`;
}
// 修复 建议㉙+㊴（三轮）：回调包 try/catch（单点异常不再杀死 10s 轮询）+ 流式态不抢写状态行
setInterval(() => { try { if (typeof isStreaming === 'undefined' || !isStreaming) updateLiveTokenStat(); } catch (e) {} }, 10000);
async function openBilling() {
  try {
    if (window.pywebview && window.pywebview.api) await callApi('open_billing', []);
  } catch (e) {}
}
