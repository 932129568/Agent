/* ================= Token 统计 ================= */
const MODEL_PRICE = {
  // Round 12（2026-11-04）：改为平台在售模型名。原 glm-5.3-flash / glm-5.3-flashx
  // 在 bigmodel.cn 不存在，价格表永远查不到 → 费用显示全靠兜底价，失真。
  'glm-4.5': { in: 4, out: 16, cache: 1 },
  'glm-4.6': { in: 4, out: 16, cache: 1 },
  'glm-4.5-air': { in: 0.8, out: 2, cache: 0.16 },
  // 智谱官方免费/普惠模型：按 0 计价。
  'glm-4.5-flash': { in: 0, out: 0, cache: 0 },
  'glm-4-flash': { in: 0, out: 0, cache: 0 }
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
    const stdIn = prompt > c ? prompt - c : 0;  // 缓存数异常高于提示数时不产生负费用
    total += u.total_tokens || (prompt + comp);
    cached += c;
    costStdIn += stdIn * p.in / 1e6;
    costCache += c * p.cache / 1e6;
    costOut += comp * p.out / 1e6;
    cost = costStdIn + costCache + costOut;
  });
  // R30 健壮性：异常 usage（字符串/NaN/Infinity）会让累加和变成字符串拼接或 NaN。
  // 校验放在循环出口（6 次判定）而非逐字段（每条消息 4 次 × 数万条）——
  // 隔离基准实测：循环内校验使热路径慢 2~3×，出口兜底仅 +1ms 且同样防住污染。
  const fin = (v) => (Number.isFinite(v) && v > 0) ? v : 0;
  total = fin(total); cached = fin(cached);
  costStdIn = fin(costStdIn); costCache = fin(costCache); costOut = fin(costOut);
  cost = costStdIn + costCache + costOut;
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
  // R30 健壮性：与 calcUsage 同口径，异常 usage 不污染单调递增的累计花费
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0;
  const prompt = num(u.prompt_tokens);
  const comp = num(u.completion_tokens);
  const c = num(u.prompt_tokens_details?.cached_tokens);
  const stdIn = Math.max(0, prompt - c);
  s._spentCost = (s._spentCost || 0) + (stdIn * p.in / 1e6 + c * p.cache / 1e6 + comp * p.out / 1e6);
  s._spentTokens = (s._spentTokens || 0) + (num(u.total_tokens) || (prompt + comp));
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
  // R30 性能：原 `allMsgs = allMsgs.concat(s.messages)` 每轮都分配新数组并复制
  // 全部已有消息，N 个会话累计 O(n²) 次复制。改为 push 展开（O(n)），
  // 传给 calcUsage 的消息序列与顺序逐项一致 → 输出逐字节不变。
  const allMsgs = [];
  sessions.forEach(s => {
    const msgs = (s && s.messages) || [];
    for (let i = 0; i < msgs.length; i++) allMsgs.push(msgs[i]);
  });
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
// R30 性能 + UX：后台标签页隐藏时跳过 DOM 查询与全量 usage 遍历；恢复可见时
// 立即补刷一次，保证用户可见态的统计始终最新（不因跳过而陈旧）。
// 不新增顶层符号：可见性监听用匿名回调 + typeof 守卫，vm 沙箱缺 API 时安全跳过。
setInterval(() => {
  try {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (typeof isStreaming === 'undefined' || !isStreaming) updateLiveTokenStat();
  } catch (e) {}
}, 10000);
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    try {
      if (!document.hidden && (typeof isStreaming === 'undefined' || !isStreaming)) updateLiveTokenStat();
    } catch (e) {}
  });
}
async function openBilling() {
  try {
    // P0-4 修正：HTTP 桥（Electron）同样可用
    if ((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE) await callApi('open_billing', []);
  } catch (e) {}
}
